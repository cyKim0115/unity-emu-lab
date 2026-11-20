// smoke.ts: the full run against the fake adb. The "device log" is a file the fake adb streams for
// `logcat -v time`; a small simulator appends the app's lines when it sees the matching adb calls
// (launch, tap, notification tap), like the sample app logging markers over time.

import assert from "node:assert/strict";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { crc32 } from "node:zlib";
import { resolveLocations } from "../src/config.ts";
import { EmuError } from "../src/errors.ts";
import { enterLease, formatLocalIso, leasePath, readLease, resetLeaseWarning } from "../src/lease.ts";
import { sleep } from "../src/proc.ts";
import { compileScheduledRegex, runSmoke, validateSmokeOptions, type SmokeOptions, type SmokeTiming } from "../src/smoke.ts";
import { silent } from "../src/types.ts";
import {
  callsOffSerial,
  FIXTURES_DIR,
  makeFakeAdb,
  otherDeviceRules,
  readFixture,
  tempLabHome,
  TWO_DEVICES,
  type FakeAdb,
  type FakeRule,
} from "./helpers/fake.ts";

const PKG = "com.example.emusmoke";
const OWNER = "test:smoke";
const ACTIVITY = `${PKG}/com.unity3d.player.UnityPlayerGameActivity`;
const T0 = 1793762540000; // before the fixture's EMU-SMOKE-032148 record (mUpdateTimeMs=1793762543424)
const TITLE = "EMU-SMOKE-032148";
const NOTIF_TAP = "shell input tap 352 655.5"; // centre of the title node in shade.xml
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1), Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])]);
const fx = (name: string) => join(FIXTURES_DIR, name);
const HOME_ACTIVITIES =
  "ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)\n" +
  "  * Task{1a2b3c4 #1 type=home}\n" +
  "    topResumedActivity=ActivityRecord{77 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t1}\n";

const FAST: Partial<SmokeTiming> = {
  logPollMs: 20,
  dialogCheckMs: 60_000,
  appCheckMs: 300,
  pidofGapMs: 10,
  exitSettleMs: 50,
  tapSettleMs: 10,
  tapWaitSec: 3,
  schedWaitSec: 3,
  homeSettleMs: 10,
  notification: { pollMs: 50, homeSettleMs: 10, shadeSettleMs: 10, openedWaitMs: 3_000, openedPollMs: 50, afterOpenMs: 10 },
  clock: { settleMs: 10, rootPollMs: 10, rootWaitMs: 200 },
};

// ---------------------------------------------------------------------------------------------------
// A minimal APK: stored zip with a UTF-8 AXML manifest and optional lib/<abi>/*.so entries.

function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(e.data.length, 20);
    cdh.writeUInt32LE(e.data.length, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, name);
    parts.push(local, name, e.data);
    offset += local.length + name.length + e.data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

function chunk(type: number, header: Buffer, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(8 + header.length, 2);
  head.writeUInt32LE(8 + header.length + body.length, 4);
  return Buffer.concat([head, header, body]);
}

/** <manifest package="pkg"/> as Android binary XML. */
function axmlManifest(pkg: string): Buffer {
  const strings = ["manifest", "package", pkg];
  const datas = strings.map((s) => Buffer.concat([Buffer.from([s.length, Buffer.byteLength(s)]), Buffer.from(s, "utf8"), Buffer.from([0])]));
  const offsets = Buffer.alloc(strings.length * 4);
  let off = 0;
  datas.forEach((d, i) => {
    offsets.writeUInt32LE(off, i * 4);
    off += d.length;
  });
  let data = Buffer.concat(datas);
  if (data.length % 4) data = Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]);
  const poolHeader = Buffer.alloc(20);
  poolHeader.writeUInt32LE(strings.length, 0);
  poolHeader.writeUInt32LE(0x100, 8); // UTF-8
  poolHeader.writeUInt32LE(28 + offsets.length, 12);
  const pool = chunk(0x0001, poolHeader, Buffer.concat([offsets, data]));

  const nodeHeader = Buffer.alloc(8);
  nodeHeader.writeUInt32LE(0xffffffff, 4);
  const ext = Buffer.alloc(20);
  ext.writeUInt32LE(0xffffffff, 0);
  ext.writeUInt32LE(0, 4); // "manifest"
  ext.writeUInt16LE(20, 8);
  ext.writeUInt16LE(20, 10);
  ext.writeUInt16LE(1, 12);
  const attr = Buffer.alloc(20);
  attr.writeUInt32LE(0xffffffff, 0);
  attr.writeUInt32LE(1, 4); // "package"
  attr.writeUInt32LE(2, 8); // raw value
  attr.writeUInt16LE(8, 12);
  attr.writeUInt8(0x03, 15);
  attr.writeUInt32LE(2, 16);
  const start = chunk(0x0102, nodeHeader, Buffer.concat([ext, attr]));
  return chunk(0x0003, Buffer.alloc(0), Buffer.concat([pool, start]));
}

function writeApk(dir: string, o: { pkg?: string; abis?: string[] } = {}): string {
  const file = join(dir, "app.apk");
  const entries = [{ name: "AndroidManifest.xml", data: axmlManifest(o.pkg ?? PKG) }];
  for (const abi of o.abis ?? ["arm64-v8a"]) entries.push({ name: `lib/${abi}/libmain.so`, data: Buffer.alloc(64, 0x7f) });
  writeFileSync(file, zip(entries));
  return file;
}

// ---------------------------------------------------------------------------------------------------
// Fake device + app simulator

const line = (msg: string, tag = "Unity", pid = 3824) => `11-20 10:00:00.000 I/${tag.padEnd(8)}(${String(pid).padStart(5)}): ${msg}\n`;

/** Commands logged by the fake adb so far (only complete lines: a call may be appending right now). */
function commandsSoFar(f: FakeAdb): string[] {
  if (!existsSync(f.logPath)) return [];
  const text = readFileSync(f.logPath, "utf8");
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => (JSON.parse(l) as { cmd: string }).cmd);
}

function simulateApp(f: FakeAdb, stream: string, on: (cmd: string) => string | undefined): () => Promise<void> {
  let stopped = false;
  let seen = 0;
  const loop = (async () => {
    while (!stopped) {
      const cmds = commandsSoFar(f);
      for (; seen < cmds.length; seen++) {
        const out = on(cmds[seen]);
        if (out) appendFileSync(stream, out);
      }
      await sleep(20);
    }
  })();
  return async () => {
    stopped = true;
    await loop;
  };
}

/** The sample app: ready on launch, tap marker + scheduled notification on the centre tap, opened marker on the notification tap. */
function sampleApp(cmd: string): string | undefined {
  if (cmd.startsWith("shell am start -W")) return line("SMOKE_APP_READY");
  if (cmd === "shell input tap 540 1200") return line("SMOKE_TAP count=1") + line(`SMOKE_NOTIF_SCHEDULED id=45 title=${TITLE}`);
  if (cmd === NOTIF_TAP) return line(`SMOKE_OPENED_FROM_NOTIFICATION id=45 title=${TITLE}`);
  return undefined;
}

function baseRules(stream: string): FakeRule[] {
  return [
    { match: "^devices$", stdout: "List of devices attached\nemulator-5554\tdevice\n\n" },
    { match: "^emu avd name", stdout: "unity-test\r\nOK\r\n" },
    { match: "^shell getprop ro.product.cpu.abilist", stdout: "x86_64,arm64-v8a\n" },
    { match: "^install -r ", stdout: "Performing Streamed Install\nSuccess\n" },
    { match: "^logcat -v time", stream },
    { match: "^shell cmd package resolve-activity", stdout: `priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\n${ACTIVITY}\n` },
    { match: "^shell date \\+%s%3N", stdout: `${T0}\n` },
    { match: "^shell am start -W", stdoutFile: fx("am-start.txt") },
    { match: "^shell pidof ", stdout: "3824\n" },
    { match: "^shell dumpsys window displays", stdoutFile: fx("dumpsys-window-displays.txt") },
    { match: "^shell dumpsys activity activities", stdout: HOME_ACTIVITIES },
    { match: "^exec-out screencap -p", stdoutBase64: PNG.toString("base64") },
    { match: "^shell uiautomator dump", stdout: "UI hierchary dumped to: /sdcard/__ui.xml\n" },
    { match: "^shell cat /sdcard/__ui.xml", stdoutFile: fx("shade.xml") },
    { match: "^shell dumpsys notification --noredact", stdoutFile: fx("notification_dump.txt") },
    { match: "^shell settings get global auto_time", stdout: "1\n" },
  ];
}

interface Bench {
  f: FakeAdb;
  home: string;
  apk: string;
  stream: string;
  lines: string[];
  env: NodeJS.ProcessEnv;
  opts(extra?: Partial<SmokeOptions>): SmokeOptions;
}

async function bench(o: { rules?: FakeRule[]; lease?: "mine" | "other" | "none"; apk?: { pkg?: string; abis?: string[] } } = {}): Promise<Bench> {
  const home = tempLabHome();
  const stream = join(home, "device-log.txt");
  writeFileSync(stream, "");
  const lines: string[] = [];
  const report = (l: string) => lines.push(l);
  const f = makeFakeAdb([...(o.rules ?? []), ...baseRules(stream)], { report });
  const env: NodeJS.ProcessEnv = { ...process.env, EMU_LAB_HOME: home, EMU_OWNER: OWNER, EMU_AVD: "" };
  const loc = resolveLocations({ env });
  const lease = o.lease ?? "mine";
  if (lease !== "none") {
    await enterLease({ path: leasePath(loc, "unity-test"), avd: "unity-test", owner: lease === "mine" ? OWNER : "codex:other1", hours: 1, host: "pc", report: silent });
  }
  const apk = writeApk(home, o.apk);
  return {
    f,
    home,
    apk,
    stream,
    lines,
    env,
    opts: (extra = {}) => ({
      apk,
      env,
      report,
      deps: { adbFactory: () => f.adb, timing: FAST, waitSec: 0 },
      ...extra,
    }),
  };
}

function runDirs(home: string): string[] {
  const runs = join(home, "runs");
  return existsSync(runs) ? readdirSync(runs) : [];
}

// ---------------------------------------------------------------------------------------------------

/** Another owner's valid lease, written as another session would (the run already passed its first lease check). */
function writeOtherLease(home: string): void {
  const now = new Date();
  const lease = {
    avd: "unity-test",
    owner: "codex:other1",
    host: "pc",
    acquiredAt: formatLocalIso(now),
    expiresAt: formatLocalIso(new Date(now.getTime() + 3_600_000)),
    startedEmulator: false,
    emulatorPid: null,
    emulatorStartedAt: null,
    installed: [],
  };
  writeFileSync(leasePath(resolveLocations({ env: { ...process.env, EMU_LAB_HOME: home } }), "unity-test"), JSON.stringify(lease, null, 2));
}

describe("runSmoke", () => {
  it("full PASS: install, ready, tap, notification in the shade, opened via the marker", async () => {
    // A second emulator (another AVD) is attached too: every device command must go to emulator-5554.
    const b = await bench({ rules: [...otherDeviceRules(), { match: "^devices$", stdout: TWO_DEVICES }] });
    const stop = simulateApp(b.f, b.stream, sampleApp);
    let s;
    try {
      s = await runSmoke(b.opts());
    } finally {
      await stop();
    }
    assert.equal(s.pass, true, JSON.stringify(s, null, 2));
    assert.equal(s.package, PKG);
    assert.equal(s.apk_abis, "arm64-v8a");
    assert.equal(s.device_abis, "x86_64,arm64-v8a");
    assert.equal(s.install, true);
    assert.equal(s.launch, true);
    assert.equal(s.launch_ms, 4910);
    assert.equal(s.app_exited, false);
    assert.equal(s.ready, true);
    assert.equal(s.system_dialogs_tapped, 0);
    assert.equal(s.tap_point, "540,1200 of 1080x2400");
    assert.equal(s.tap, true);
    assert.equal(s.tap_attempts, 1);
    assert.equal(s.notif_scheduled, true);
    assert.equal(s.notif_opened_check, "marker");
    assert.equal(s.notif_title, TITLE);
    assert.equal(s.notif_posted, true);
    assert.equal(typeof s.notif_posted_after_sec, "number");
    assert.equal(s.notif_in_shade, true);
    assert.equal(s.notif_opened_app, true);
    assert.equal(s.crash, false);
    assert.equal(s.error, undefined);

    const run = s.run_dir;
    assert.ok(run.startsWith(join(b.home, "runs")));
    for (const file of ["summary.json", "logcat.txt", "unity.txt", "01-ready.png", "02-after-tap.png", "03-home.png", "04-shade.png",
      "05-opened-from-notification.png", "notification-check.json", "notification_dump.txt", "shade.xml"]) {
      assert.ok(existsSync(join(run, file)), `${file} missing`);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(run, "summary.json"), "utf8")), s);
    assert.match(readFileSync(join(run, "unity.txt"), "utf8"), /SMOKE_APP_READY/);
    assert.match(readFileSync(join(run, "logcat.txt"), "utf8"), /SMOKE_OPENED_FROM_NOTIFICATION/);
    const n = JSON.parse(readFileSync(join(run, "notification-check.json"), "utf8"));
    assert.equal(n.posted_at_ms, 1793762543424);
    assert.equal(n.since_ms, T0);

    assert.deepEqual(callsOffSerial(b.f.calls(), "emulator-5554"), []);
    assert.ok(b.f.calls().some((c) => c[0] === "-s" && c[1] === "emulator-5556" && c[2] === "emu"), "the other emulator was looked at");

    const cmds = b.f.commands();
    const idx = (c: string) => cmds.findIndex((x) => x.startsWith(c));
    assert.ok(idx("install -r ") >= 0);
    assert.ok(idx("shell pm grant com.example.emusmoke android.permission.POST_NOTIFICATIONS") > idx("install -r "));
    assert.ok(idx("logcat -c") > idx("shell pm grant"));
    assert.ok(idx("logcat -v time") > idx("logcat -c"));
    assert.ok(cmds.includes(`shell am start -W -n ${ACTIVITY} --es notif_delay 20`));
    assert.ok(idx("shell am force-stop") < idx("shell am start"));
    assert.ok(idx("shell input keyevent KEYCODE_HOME") < idx("shell cmd statusbar expand-notifications"));
    assert.ok(cmds.includes(NOTIF_TAP));
    assert.ok(!cmds.some((c) => c.includes("auto_time 0")), "no time travel asked");

    const lease = await readLease(leasePath(resolveLocations({ env: b.env }), "unity-test"));
    assert.deepEqual(lease?.installed, [PKG]);
    assert.ok(b.lines.includes(`SMOKE PASS dir=${run}`));
    assert.ok(b.lines.some((l) => /^ {2}ready {19} true$/.test(l)), b.lines.join("\n"));
    assert.ok(b.lines.some((l) => /^NOTIF_POSTED true after=\d+s$/.test(l)));
    assert.ok(b.lines.includes("NOTIF_IN_SHADE true"));
    assert.ok(b.lines.includes("NOTIF_OPENED_APP true"));
  });

  it("ready marker timeout: ready false and FAIL", async () => {
    const b = await bench();
    const s = await runSmoke(b.opts({ readyTimeoutSec: 0.6 }));
    assert.equal(s.ready, false);
    assert.equal(s.crash, false);
    assert.equal(s.pass, false);
    assert.equal(s.error, "Ready marker 'SMOKE_APP_READY' not seen (crash=false).");
    assert.ok(existsSync(join(s.run_dir, "01-ready.png")));
    assert.ok(!b.f.commands().some((c) => c.startsWith("shell input tap")));
    assert.ok(b.lines.includes(`SMOKE FAIL dir=${s.run_dir}`));
  });

  it("a crash line of the package: crash true and FAIL", async () => {
    const b = await bench();
    const stop = simulateApp(b.f, b.stream, (cmd) => (cmd.startsWith("shell am start -W") ? readFixture("logcat-crash.txt") : undefined));
    let s;
    try {
      s = await runSmoke(b.opts({ readyTimeoutSec: 5 }));
    } finally {
      await stop();
    }
    assert.equal(s.crash, true);
    assert.equal(s.ready, false);
    assert.equal(s.pass, false);
    assert.equal(s.error, "Ready marker 'SMOKE_APP_READY' not seen (crash=true).");
    assert.match(readFileSync(join(s.run_dir, "unity.txt"), "utf8"), /FATAL EXCEPTION/);
  });

  it("app self-exit: pidof empty twice, no process, not resumed -> app_exited with the guidance", async () => {
    const died = `11-20 10:00:01.000 I/ActivityManager(  512): Process ${PKG} (pid 3824) has died: fg  TOP\n`;
    const b = await bench({
      rules: [
        { match: "^shell pidof ", stdout: "" },
        { match: "^shell ps -A -o NAME", stdout: `NAME\nsystem_server\n${PKG}2\ncom.android.systemui\n` },
      ],
    });
    const stop = simulateApp(b.f, b.stream, (cmd) => (cmd.startsWith("shell am start -W") ? died : undefined));
    let s;
    try {
      s = await runSmoke(b.opts({ readyTimeoutSec: 20 }));
    } finally {
      await stop();
    }
    assert.equal(s.app_exited, true);
    assert.equal(s.ready, false);
    assert.equal(s.crash, false);
    assert.equal(s.pass, false);
    const err = String(s.error);
    assert.ok(err.startsWith(`The app process (${PKG}) ended by itself during the wait for the ready marker 'SMOKE_APP_READY'`), err);
    assert.ok(err.includes("ask the person for a test build with that check off; do not patch or bypass it."));
    assert.deepEqual(s.app_exit_log, [died.trim()]);
    const cmds = b.f.commands();
    assert.ok(cmds.filter((c) => c.startsWith("shell pidof")).length >= 2);
    assert.ok(cmds.includes("shell ps -A -o NAME"));
  });

  it("a process named <package>:<name> still counts as running", async () => {
    const b = await bench({
      rules: [
        { match: "^shell pidof ", stdout: "" },
        { match: "^shell ps -A -o NAME", stdout: `NAME\n${PKG}:game\n` },
      ],
    });
    const s = await runSmoke(b.opts({ readyTimeoutSec: 1, deps: { adbFactory: () => b.f.adb, timing: { ...FAST, appCheckMs: 100 }, waitSec: 0 } }));
    assert.equal(s.app_exited, false);
    assert.equal(s.ready, false);
    assert.ok(b.f.commands().includes("shell ps -A -o NAME"));
  });

  it("ABI_MISMATCH before install: no install call", async () => {
    const b = await bench({ apk: { abis: ["armeabi-v7a"] } });
    const s = await runSmoke(b.opts());
    assert.equal(s.install, false);
    assert.equal(s.apk_abis, "armeabi-v7a");
    assert.equal(s.error_code, "ABI_MISMATCH");
    assert.match(String(s.error), /^APK native ABIs \(armeabi-v7a\) cannot run on this emulator \(x86_64,arm64-v8a\)\. Build an IL2CPP \+ ARM64 test APK/);
    assert.equal(s.pass, false);
    const cmds = b.f.commands();
    assert.ok(!cmds.some((c) => c.startsWith("install")));
    assert.ok(!cmds.some((c) => c.startsWith("logcat")));
  });

  it("PACKAGE_MISMATCH throws before the run dir and the install", async () => {
    const b = await bench();
    await assert.rejects(
      runSmoke(b.opts({ package: "com.other.app" })),
      (e: unknown) => e instanceof EmuError && e.code === "PACKAGE_MISMATCH" && e.message.includes("com.other.app") && e.message.includes(PKG),
    );
    assert.ok(!b.f.commands().some((c) => c.startsWith("install")));
    assert.deepEqual(runDirs(b.home), []);
  });

  it("option validation throws before any adb call", async () => {
    const b = await bench();
    const bad = async (extra: Partial<SmokeOptions>, re: RegExp) =>
      assert.rejects(runSmoke(b.opts(extra)), (e: unknown) => e instanceof EmuError && e.code === "BAD_OPTION" && re.test(e.message));
    await bad({ notifScheduledRegex: "SMOKE_NOTIF_SCHEDULED id=\\d+" }, /needs capture group 1/);
    await bad({ notifScheduledRegex: "title=(" }, /not a valid regex/);
    await bad({ timeTravelMinutes: 90, notifDelay: 0 }, /needs the automatic notification check/);
    await bad({ notifDelay: -1 }, /notif_delay/);
    await bad({ tapX: 1.5 }, /tap_x/);
    await bad({ readyTimeoutSec: 0 }, /ready_timeout_sec/);
    await bad({ apk: "  " }, /apk is required/);
    assert.deepEqual(b.f.commands(), []);
    assert.deepEqual(runDirs(b.home), []);
    // A named group is group 1 as well.
    assert.equal(validateSmokeOptions({ apk: "x.apk", report: silent, notifScheduledRegex: "title=(?<t>\\S+)" }).notifDelay, 20);
    // .NET-only syntax is refused with a message that says so.
    await bad({ notifScheduledRegex: "(?x)title = (\\S+)" }, /\.NET inline option \(\?x\)/);
    await bad({ notifScheduledRegex: "id=\\d+ (?i)title=(\\S+)" }, /\.NET-only syntax/);
    await bad({ notifScheduledRegex: "title=(?'t'\\S+)" }, /\.NET-only syntax/);
    assert.deepEqual(b.f.commands(), []);
  });

  it("notif_scheduled_regex: group 1 and inline options as in .NET (the PowerShell scripts)", () => {
    const g = (s: string) => compileScheduledRegex(s);
    // .NET numbers unnamed groups first: group 1 is the title, not the named id.
    const mixed = g("Scheduled id=(?<id>\\d+) title=(.+)");
    assert.equal(mixed.titleGroup, 2);
    assert.equal(mixed.re.exec("Scheduled id=42 title=Hello")?.[mixed.titleGroup], "Hello");
    assert.equal(g("SMOKE_NOTIF_SCHEDULED id=\\d+ title=(\\S+)").titleGroup, 1);
    // Only named groups: the first one.
    assert.equal(g("(?<a>\\w+) (?<b>\\w+)").titleGroup, 1);
    // Escaped parentheses, classes, non-capturing groups and lookarounds are not groups.
    const skip = g("\\((?:x)[(](?=a)(?<!z)(?<t>a)(b)");
    assert.equal(skip.titleGroup, 2);
    assert.equal(skip.re.exec("(x(ab")?.[skip.titleGroup], "b");
    // A leading (?i) / (?ims) becomes the flags.
    const ci = g("(?i)scheduled: (.+)");
    assert.equal(ci.re.flags, "i");
    assert.equal(ci.re.exec("SCHEDULED: Hi")?.[ci.titleGroup], "Hi");
    assert.equal(g("(?ims)a(.)").re.flags, "ims");
    assert.throws(() => g("(?n)a(b)"), (e: unknown) => e instanceof EmuError && e.code === "BAD_OPTION");
    assert.throws(() => g("no group here"), (e: unknown) => e instanceof EmuError && /needs capture group 1/.test(e.message));
  });

  it("a named id group before the title: the title (.NET group 1) is checked, like smoke-test.ps1", async () => {
    const b = await bench();
    const stop = simulateApp(b.f, b.stream, sampleApp);
    let s;
    try {
      s = await runSmoke(b.opts({ notifScheduledRegex: "SMOKE_NOTIF_SCHEDULED id=(?<id>\\d+) title=(\\S+)" }));
    } finally {
      await stop();
    }
    assert.equal(s.notif_title, TITLE);
    assert.equal(s.pass, true, JSON.stringify(s, null, 2));
  });

  it("another session takes the AVD during the run: BUSY before HOME, the clock and the shade", async () => {
    const b = await bench();
    // The other session's emu_start lands while the app schedules its notification (after the tap).
    const stop = simulateApp(b.f, b.stream, (cmd) => {
      if (cmd === "shell input tap 540 1200") writeOtherLease(b.home);
      return sampleApp(cmd);
    });
    let s;
    try {
      s = await runSmoke(b.opts({ timeTravelMinutes: 90, leaseMode: "strict" }));
    } finally {
      await stop();
    }
    assert.equal(s.error_code, "BUSY", JSON.stringify(s, null, 2));
    assert.match(String(s.error), /codex:other1/);
    assert.equal(s.pass, false);
    const cmds = b.f.commands();
    for (const c of ["shell input keyevent KEYCODE_HOME", "shell settings put global auto_time 0", NOTIF_TAP]) {
      assert.ok(!cmds.includes(c), `${c} ran under another owner's lease`);
    }
    assert.ok(!cmds.some((c) => c.startsWith("shell cmd alarm set-time") || c.startsWith("shell uiautomator") || c.startsWith("shell cmd statusbar")));
    assert.equal(s.time_travel_min, undefined);
  });

  it("warn mode without a lease: another session's new lease still stops the run with BUSY", async () => {
    const b = await bench({ lease: "none" });
    resetLeaseWarning();
    const stop = simulateApp(b.f, b.stream, (cmd) => {
      if (cmd === "shell input tap 540 1200") writeOtherLease(b.home);
      return sampleApp(cmd);
    });
    let s;
    try {
      s = await runSmoke(b.opts({ timeTravelMinutes: 90 }));
    } finally {
      await stop();
    }
    assert.equal(s.error_code, "BUSY", JSON.stringify(s, null, 2));
    assert.ok(!b.f.commands().includes("shell settings put global auto_time 0"));
  });

  it("BUSY: another owner's lease stops the run before install", async () => {
    const b = await bench({ lease: "other" });
    await assert.rejects(runSmoke(b.opts()), (e: unknown) => e instanceof EmuError && e.code === "BUSY" && e.message.includes("codex:other1"));
    assert.ok(!b.f.commands().some((c) => c.startsWith("install") || c.startsWith("shell pm") || c.startsWith("logcat")));
    assert.deepEqual(runDirs(b.home), []);
  });

  it("strict lease mode without a lease throws NO_LEASE; warn mode reports LEASE_NONE and runs", async () => {
    const b = await bench({ lease: "none" });
    resetLeaseWarning();
    await assert.rejects(runSmoke(b.opts({ leaseMode: "strict" })), (e: unknown) => e instanceof EmuError && e.code === "NO_LEASE");
    const s = await runSmoke(b.opts({ readyTimeoutSec: 0.3, noTap: true, notifDelay: 0 }));
    assert.equal(s.install, true);
    assert.ok(b.lines.some((l) => l.startsWith("LEASE_NONE AVD 'unity-test' is not leased")));
  });

  it("taps a system dialog during the ready wait", async () => {
    const b = await bench({ rules: [{ match: "^shell cat /sdcard/__ui.xml", stdoutFile: fx("permission-dialog.xml"), times: 1 }] });
    const stop = simulateApp(b.f, b.stream, (cmd) => (cmd === "shell input tap 540 1347.5" ? line("SMOKE_APP_READY") : undefined));
    let s;
    try {
      s = await runSmoke(
        b.opts({ noTap: true, notifDelay: 0, readyTimeoutSec: 10, outDir: join(b.home, "my-run"), deps: { adbFactory: () => b.f.adb, timing: { ...FAST, dialogCheckMs: 100 }, waitSec: 0 } }),
      );
    } finally {
      await stop();
    }
    assert.equal(s.pass, true, JSON.stringify(s, null, 2));
    assert.equal(s.run_dir, join(b.home, "my-run"));
    assert.equal(s.system_dialogs_tapped, 1);
    assert.equal(s.tap, undefined);
    assert.equal(s.notif_scheduled, undefined);
    assert.match(readFileSync(join(s.run_dir, "system-dialogs.txt"), "utf8"), /tapped 'Allow' in com\.google\.android\.permissioncontroller at 540,1347\.5/);
    assert.ok(b.lines.some((l) => l.startsWith("SYSTEM_DIALOG ")));
  });

  it("ask_permission revokes and clears the permission flags instead of granting", async () => {
    const b = await bench();
    await runSmoke(b.opts({ askPermission: true, readyTimeoutSec: 0.3 }));
    const cmds = b.f.commands();
    assert.ok(cmds.includes(`shell pm revoke ${PKG} android.permission.POST_NOTIFICATIONS`));
    assert.ok(cmds.includes(`shell pm clear-permission-flags ${PKG} android.permission.POST_NOTIFICATIONS user-set user-fixed`));
    assert.ok(!cmds.some((c) => c.startsWith("shell pm grant")));
  });

  it("time travel: the clock is reset in finally even when the notification check throws", async () => {
    const moved = T0 + 90 * 60_000 + 2_000;
    const b = await bench({
      rules: [
        { match: "^shell date \\+%s%3N", stdout: `${T0}\n`, times: 2 }, // sinceMs, before time travel
        { match: "^shell date \\+%s%3N", stdout: `${moved}\n`, times: 2 }, // after time travel, before the reset
      ],
    });
    const stop = simulateApp(b.f, b.stream, sampleApp);
    let s;
    try {
      s = await runSmoke(
        b.opts({
          timeTravelMinutes: 90,
          deps: {
            adbFactory: () => b.f.adb,
            timing: FAST,
            waitSec: 0,
            checkNotification: async () => {
              throw new EmuError("ADB_FAILED", "boom in the notification check");
            },
          },
        }),
      );
    } finally {
      await stop();
    }
    assert.equal(s.time_travel_min, 90);
    assert.equal(s.error, "boom in the notification check");
    assert.equal(s.error_code, "ADB_FAILED");
    assert.equal(s.clock_reset_error, undefined);
    assert.equal(s.pass, false);
    const cmds = b.f.commands();
    const off = cmds.indexOf("shell settings put global auto_time 0");
    const on = cmds.indexOf("shell settings put global auto_time 1");
    assert.ok(off >= 0 && on > off, cmds.join("\n"));
    assert.equal(cmds.filter((c) => c.startsWith("shell cmd alarm set-time")).length, 2);
    assert.ok(b.lines.some((l) => l.startsWith("TIME_TRAVEL ")));
  });

  it("time travel fails after auto_time 0 (adbd does not come back): CLOCK_FAILED and the clock is still reset", async () => {
    const b = await bench({
      rules: [
        // The shell user may not set the time: adb root, then the device never answers "ok".
        { match: "^shell cmd alarm set-time", stdout: "Exception: java.lang.SecurityException: denied\n", times: 1 },
      ],
    });
    const stop = simulateApp(b.f, b.stream, sampleApp);
    let s;
    try {
      s = await runSmoke(b.opts({ timeTravelMinutes: 90 }));
    } finally {
      await stop();
    }
    assert.equal(s.error_code, "CLOCK_FAILED", JSON.stringify(s, null, 2));
    assert.match(String(s.error), /did not come back after adb root/);
    assert.equal(s.pass, false);
    assert.equal(s.clock_reset_error, undefined);
    const cmds = b.f.commands();
    const off = cmds.indexOf("shell settings put global auto_time 0");
    const on = cmds.lastIndexOf("shell settings put global auto_time 1");
    assert.ok(off >= 0 && on > off, cmds.join("\n"));
    assert.ok(cmds.includes("root"));
    // The failed forward and the reset each set the time once.
    assert.equal(cmds.filter((c) => c.startsWith("shell cmd alarm set-time")).length, 2);
    assert.ok(!cmds.includes(NOTIF_TAP));
  });

  it("time travel where the clock does not move: CLOCK_FAILED and the clock is still reset", async () => {
    const b = await bench(); // the device clock always reads T0
    const stop = simulateApp(b.f, b.stream, sampleApp);
    let s;
    try {
      s = await runSmoke(b.opts({ timeTravelMinutes: 90 }));
    } finally {
      await stop();
    }
    assert.equal(s.error_code, "CLOCK_FAILED", JSON.stringify(s, null, 2));
    assert.match(String(s.error), /did not move forward 90 min/);
    const cmds = b.f.commands();
    const off = cmds.indexOf("shell settings put global auto_time 0");
    const on = cmds.lastIndexOf("shell settings put global auto_time 1");
    assert.ok(off >= 0 && on > off, cmds.join("\n"));
    assert.equal(cmds.filter((c) => c.startsWith("shell cmd alarm set-time")).length, 2);
  });

  it("time travel: a failed reset is recorded as clock_reset_error and CLOCK_RESET_FAILED", async () => {
    const moved = T0 + 30 * 60_000 + 2_000;
    const b = await bench({
      rules: [
        { match: "^shell date \\+%s%3N", stdout: `${T0}\n`, times: 2 },
        { match: "^shell date \\+%s%3N", stdout: `${moved}\n`, times: 1 },
        { match: "^shell date \\+%s%3N", stdout: "date: bad\n" },
      ],
    });
    const stop = simulateApp(b.f, b.stream, sampleApp);
    let s;
    try {
      s = await runSmoke(b.opts({ timeTravelMinutes: 30 }));
    } finally {
      await stop();
    }
    assert.match(String(s.clock_reset_error), /Cannot read the device clock/);
    assert.ok(b.lines.some((l) => l.startsWith("CLOCK_RESET_FAILED ")));
    // The check itself passed; like smoke-test.ps1, a failed reset is reported but does not change pass.
    assert.equal(s.notif_opened_app, true);
    assert.equal(s.pass, true);
  });
});
