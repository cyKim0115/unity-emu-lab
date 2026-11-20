// notification.ts (standalone checks against the fake adb) and rundir.ts.

import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { resolveLocations } from "../src/config.ts";
import { EmuError } from "../src/errors.ts";
import { checkNotification, type NotificationOptions, type NotificationTiming } from "../src/notification.ts";
import { sleep } from "../src/proc.ts";
import { newRunDir, runStamp } from "../src/rundir.ts";
import { connect } from "../src/context.ts";
import { enterLease, formatLocalIso, leasePath, writeLease } from "../src/lease.ts";
import { silent } from "../src/types.ts";
import {
  callsOffSerial,
  FIXTURES_DIR,
  makeFakeAdb,
  otherDeviceRules,
  tempLabHome,
  TWO_DEVICES,
  type FakeAdb,
  type FakeRule,
} from "./helpers/fake.ts";

const PKG = "com.example.emusmoke";
const TITLE = "EMU-SMOKE-032148"; // record id=45, mUpdateTimeMs=1793762543424
const BEFORE_45 = 1793762540000;
const AFTER_45 = 1793762544000;
const NOTIF_TAP = "shell input tap 352 655.5"; // centre of the title node in shade.xml
const OPENED = "SMOKE_OPENED_FROM_NOTIFICATION";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1), Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])]);
const fx = (name: string) => join(FIXTURES_DIR, name);
const HOME_ACTIVITIES =
  "  * Task{1a2b3c4 #1 type=home}\n    topResumedActivity=ActivityRecord{77 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t1}\n";
const FAST: Partial<NotificationTiming> = { pollMs: 50, homeSettleMs: 10, shadeSettleMs: 10, openedWaitMs: 2_000, openedPollMs: 50, afterOpenMs: 10 };

const line = (msg: string) => `11-20 10:00:00.000 I/Unity   ( 3824): ${msg}\n`;

function baseRules(stream: string): FakeRule[] {
  return [
    { match: "^devices$", stdout: "List of devices attached\nemulator-5554\tdevice\n\n" },
    { match: "^emu avd name", stdout: "unity-test\r\nOK\r\n" },
    { match: "^shell date \\+%s%3N", stdout: `${AFTER_45}\n` },
    { match: "^logcat -v time -T 1", stream },
    { match: "^shell dumpsys activity activities", stdout: HOME_ACTIVITIES },
    { match: "^exec-out screencap -p", stdoutBase64: PNG.toString("base64") },
    { match: "^shell uiautomator dump", stdout: "UI hierchary dumped to: /sdcard/__ui.xml\n" },
    { match: "^shell cat /sdcard/__ui.xml", stdoutFile: fx("shade.xml") },
    { match: "^shell dumpsys notification --noredact", stdoutFile: fx("notification_dump.txt") },
  ];
}

function commandsSoFar(f: FakeAdb): string[] {
  if (!existsSync(f.logPath)) return [];
  const text = readFileSync(f.logPath, "utf8");
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => (JSON.parse(l) as { cmd: string }).cmd);
}

/** Appends to the device log when the fake adb sees a command (the app logging after the notification tap). */
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

function bench(rules: FakeRule[] = []) {
  const home = tempLabHome();
  const stream = join(home, "device-log.txt");
  writeFileSync(stream, "");
  const lines: string[] = [];
  const report = (l: string) => lines.push(l);
  const f = makeFakeAdb([...rules, ...baseRules(stream)], { report });
  const env: NodeJS.ProcessEnv = { ...process.env, EMU_LAB_HOME: home, EMU_OWNER: "test:notif", EMU_AVD: "" };
  const opts = (extra: Partial<NotificationOptions> = {}): NotificationOptions => ({
    package: PKG,
    title: TITLE,
    timeoutSec: 5,
    env,
    report,
    deps: { adbFactory: () => f.adb, timing: FAST, waitSec: 0 },
    ...extra,
  });
  return { f, home, stream, lines, env, opts };
}

describe("checkNotification", () => {
  it("ignores records older than sinceMs (the same title posted before)", async () => {
    const b = bench();
    const r = await checkNotification(b.opts({ sinceMs: AFTER_45, timeoutSec: 0.3 }));
    assert.equal(r.posted, false);
    assert.equal(r.posted_after_sec, null);
    assert.equal(r.in_shade, false);
    assert.equal(r.pass, false);
    assert.equal(r.since_ms, AFTER_45);
    assert.ok(!b.f.commands().some((c) => c.includes("statusbar")));
    assert.ok(b.lines.includes("NOTIF_POSTED false after=s"));
    assert.ok(b.lines.includes(`NOTIFICATION_CHECK FAIL dir=${r.run_dir}`));
    assert.equal(basename(r.run_dir).split("-")[2], "notification");
    const saved = JSON.parse(readFileSync(join(r.run_dir, "notification-check.json"), "utf8"));
    assert.equal(saved.posted, false);
    assert.equal(saved.package, PKG);
  });

  it("finds a record at/after sinceMs and checks the shade without tapping", async () => {
    const b = bench();
    const r = await checkNotification(b.opts({ sinceMs: BEFORE_45 }));
    assert.equal(r.posted, true);
    assert.equal(r.posted_at_ms, 1793762543424);
    assert.equal(r.in_shade, true);
    assert.equal(r.tapped, false);
    assert.equal(r.opened_check, undefined);
    assert.equal(r.pass, true);
    const record = readFileSync(join(r.run_dir, "notification_dump.txt"), "utf8");
    assert.ok(record.startsWith("NotificationRecord(0x0c7a9be5: pkg=com.example.emusmoke "));
    assert.ok(!record.includes("com.android.shell") && !record.includes("id=46"));
    assert.ok(existsSync(join(r.run_dir, "shade.xml")));
    assert.ok(existsSync(join(r.run_dir, "04-shade.png")));
    assert.ok(b.f.commands().includes("shell cmd statusbar collapse"));
  });

  it("with a second emulator attached, every device command goes to the AVD's serial", async () => {
    const b = bench([...otherDeviceRules(), { match: "^devices$", stdout: TWO_DEVICES }]);
    const stop = simulateApp(b.f, b.stream, (cmd) => (cmd === NOTIF_TAP ? line(OPENED) : undefined));
    let r;
    try {
      r = await checkNotification(b.opts({ sinceMs: BEFORE_45, tap: true, openedMarker: OPENED }));
    } finally {
      await stop();
    }
    assert.equal(r.pass, true, JSON.stringify(r, null, 2));
    assert.deepEqual(callsOffSerial(b.f.calls(), "emulator-5554"), []);
    assert.ok(b.f.commands().includes(NOTIF_TAP));
  });

  it("an existing session (ctx, as smoke passes it): the lease is checked again, BUSY before the shade", async () => {
    const b = bench();
    const file = leasePath(resolveLocations({ env: b.env }), "unity-test");
    await enterLease({ path: file, avd: "unity-test", owner: "test:notif", hours: 1, host: "pc", report: silent });
    const ctx = await connect({ env: b.env, report: silent, leaseMode: "strict", waitSec: 0, adbFactory: () => b.f.adb });
    // Another session takes the AVD after our connect (ours ran out and was taken over).
    const now = Date.now();
    await writeLease(
      file,
      {
        avd: "unity-test", owner: "codex:other1", host: "pc", acquiredAt: formatLocalIso(new Date(now)), expiresAt: formatLocalIso(new Date(now + 3_600_000)),
        startedEmulator: false, emulatorPid: null, emulatorStartedAt: null, installed: [],
      },
      { create: false },
    );
    const from = b.f.commands().length;
    await assert.rejects(
      checkNotification(b.opts({ ctx, tap: true, leaseMode: "strict" })),
      (e: unknown) => e instanceof EmuError && e.code === "BUSY" && e.message.includes("codex:other1"),
    );
    assert.deepEqual(b.f.commands().slice(from), []);
  });

  it("defaults sinceMs to the device clock", async () => {
    const b = bench();
    const r = await checkNotification(b.opts({ title: "[이벤트] 한글 알림 B" }));
    assert.equal(r.since_ms, AFTER_45);
    assert.equal(r.posted, true); // mCreationTimeMs=1793762550000 only
    assert.equal(r.posted_at_ms, 1793762550000);
    assert.equal(r.in_shade, true);
  });

  it("posted but not in the shade: FAIL and the shade is collapsed", async () => {
    const b = bench([{ match: "^shell cat /sdcard/__ui.xml", stdoutFile: fx("permission-dialog.xml") }]);
    const r = await checkNotification(b.opts({ sinceMs: BEFORE_45, tap: true }));
    assert.equal(r.posted, true);
    assert.equal(r.in_shade, false);
    assert.equal(r.tapped, false);
    assert.equal(r.pass, false);
    assert.ok(b.f.commands().includes("shell cmd statusbar collapse"));
    assert.ok(!b.f.commands().some((c) => c.startsWith("shell input tap")));
    assert.ok(b.lines.includes("NOTIF_IN_SHADE false"));
    assert.ok(b.lines.includes(`NOTIFICATION_CHECK FAIL dir=${r.run_dir}`));
  });

  it("tap with the app already in front: HOME first, then the tap; opened = resumed activity", async () => {
    const resumed = readFileSync(fx("dumpsys-activities.txt"), "utf8");
    const b = bench([
      { match: "^shell dumpsys activity activities", stdout: resumed, times: 1 }, // before the tap: in front
      { match: "^shell dumpsys activity activities", stdout: HOME_ACTIVITIES, times: 1 }, // first poll after the tap
      { match: "^shell dumpsys activity activities", stdout: resumed }, // then opened
    ]);
    const out = join(b.home, "check-dir");
    const r = await checkNotification(b.opts({ sinceMs: BEFORE_45, tap: true, runDir: out }));
    assert.equal(r.run_dir, out);
    assert.equal(r.backgrounded_before_tap, true);
    assert.equal(r.in_shade, true);
    assert.equal(r.tapped, true);
    assert.equal(r.opened_check, "resumed activity");
    assert.equal(r.opened_app, true);
    assert.equal(r.log_file, undefined);
    assert.equal(r.pass, true);
    const cmds = b.f.commands();
    const home = cmds.indexOf("shell input keyevent KEYCODE_HOME");
    const expand = cmds.indexOf("shell cmd statusbar expand-notifications");
    const tap = cmds.indexOf(NOTIF_TAP);
    assert.ok(home >= 0 && home < expand && expand < tap, cmds.join("\n"));
    assert.ok(!cmds.some((c) => c.startsWith("logcat")), "no logcat capture without an opened marker");
    assert.ok(existsSync(join(out, "05-opened-from-notification.png")));
    assert.ok(b.lines.includes("NOTIF_OPENED_APP true"));
  });

  it("standalone tap + opened marker: own capture with -T 1; opened via the marker logged after the tap", async () => {
    const b = bench();
    const stop = simulateApp(b.f, b.stream, (cmd) => (cmd === NOTIF_TAP ? line(`${OPENED} id=45 title=${TITLE}`) : undefined));
    let r;
    try {
      r = await checkNotification(b.opts({ sinceMs: BEFORE_45, tap: true, openedMarker: OPENED }));
    } finally {
      await stop();
    }
    assert.equal(r.opened_check, "marker");
    assert.equal(r.backgrounded_before_tap, false);
    assert.equal(r.opened_app, true);
    assert.equal(r.pass, true);
    assert.equal(r.log_file, join(r.run_dir, "notification-logcat.txt"));
    assert.match(readFileSync(r.log_file!, "utf8"), /SMOKE_OPENED_FROM_NOTIFICATION/);
    assert.ok(b.f.commands().includes("logcat -v time -T 1"));
  });

  it("an opened marker logged before the tap does not count", async () => {
    const b = bench();
    writeFileSync(b.stream, line(`${OPENED} id=44 title=EMU-SMOKE-031500`));
    const r = await checkNotification(
      b.opts({ sinceMs: BEFORE_45, tap: true, openedMarker: OPENED, deps: { adbFactory: () => b.f.adb, timing: { ...FAST, pollMs: 300, openedWaitMs: 500 }, waitSec: 0 } }),
    );
    assert.equal(r.tapped, true);
    assert.equal(r.opened_app, false);
    assert.equal(r.pass, false);
    assert.match(readFileSync(r.log_file!, "utf8"), /id=44/);
  });

  it("validates its options before touching the device", async () => {
    const b = bench();
    await assert.rejects(checkNotification(b.opts({ title: "" })), (e: unknown) => e instanceof EmuError && e.code === "BAD_OPTION");
    await assert.rejects(checkNotification(b.opts({ package: " " })), (e: unknown) => e instanceof EmuError && e.code === "BAD_OPTION");
    await assert.rejects(checkNotification(b.opts({ timeoutSec: 0 })), (e: unknown) => e instanceof EmuError && e.code === "BAD_OPTION");
    assert.deepEqual(b.f.commands(), []);
  });
});

describe("newRunDir", () => {
  it("names runs <stamp>-<kind>-<pid>, then -2, -3 in the same second", async () => {
    const home = tempLabHome();
    const loc = resolveLocations({ env: { EMU_LAB_HOME: home } });
    const a = await newRunDir(loc, "smoke");
    const b = await newRunDir(loc, "smoke");
    const c = await newRunDir(loc, "smoke");
    const re = new RegExp(`^\\d{8}-\\d{6}-smoke-${process.pid}(-\\d+)?$`);
    for (const d of [a, b, c]) {
      assert.ok(existsSync(d));
      assert.equal(join(d, ".."), loc.runsDir);
      assert.match(basename(d), re);
    }
    assert.equal(new Set([a, b, c]).size, 3);
    if (basename(a).slice(0, 15) === basename(b).slice(0, 15)) assert.equal(b, `${a}-2`);
  });

  it("uses outDir as is and creates it", async () => {
    const home = tempLabHome();
    const loc = resolveLocations({ env: { EMU_LAB_HOME: home } });
    const out = join(home, "a", "b");
    assert.equal(await newRunDir(loc, "smoke", out), out);
    assert.ok(existsSync(out));
    assert.equal(await newRunDir(loc, "smoke", out), out); // an existing one is reused
  });

  it("runStamp is local yyyyMMdd-HHmmss", () => {
    assert.equal(runStamp(new Date(2026, 10, 20, 9, 5, 7)), "20261120-090507");
  });
});

describe("checkNotification: the lease is checked again right before the shade and the tap", () => {
  async function session(b: ReturnType<typeof bench>) {
    const file = leasePath(resolveLocations({ env: b.env }), "unity-test");
    await enterLease({ path: file, avd: "unity-test", owner: "test:notif", hours: 1, host: "pc", report: silent });
    const ctx = await connect({ env: b.env, report: silent, leaseMode: "strict", waitSec: 0, adbFactory: () => b.f.adb });
    return { file, ctx };
  }

  /** Another session takes the AVD over (ours ran out) the moment the fake adb sees `trigger`. */
  function takeoverOn(b: ReturnType<typeof bench>, file: string, trigger: string): () => Promise<void> {
    let done = false;
    return simulateApp(b.f, b.stream, (cmd) => {
      if (done || cmd !== trigger) return undefined;
      done = true;
      const now = Date.now();
      writeFileSync(
        file,
        JSON.stringify({
          avd: "unity-test", owner: "codex:other1", host: "pc", acquiredAt: formatLocalIso(new Date(now)), expiresAt: formatLocalIso(new Date(now + 3_600_000)),
          startedEmulator: false, emulatorPid: null, emulatorStartedAt: null, installed: [],
        }),
      );
      return undefined;
    });
  }

  it("a takeover during the dumpsys wait: BUSY before the shade is expanded or anything is tapped", async () => {
    // The first dumpsys answers slowly with nothing; the takeover happens meanwhile; the second finds the record.
    const b = bench([{ match: "^shell dumpsys notification --noredact", stdout: "", delayMs: 300, times: 1 }]);
    const { file, ctx } = await session(b);
    const stop = takeoverOn(b, file, "shell dumpsys notification --noredact");
    try {
      await assert.rejects(
        checkNotification(b.opts({ ctx, sinceMs: BEFORE_45, tap: true, leaseMode: "strict" })),
        (e: unknown) => e instanceof EmuError && e.code === "BUSY" && e.message.includes("codex:other1"),
      );
    } finally {
      await stop();
    }
    const cmds = b.f.commands();
    assert.equal(cmds.filter((c) => c === "shell dumpsys notification --noredact").length, 2, cmds.join("\n"));
    assert.ok(!cmds.includes("shell cmd statusbar expand-notifications"), cmds.join("\n"));
    assert.ok(!cmds.some((c) => c.startsWith("shell input")), cmds.join("\n"));
  });

  it("warn mode without a lease: a takeover while the shade settles stops the collapse (no tap)", async () => {
    const b = bench([{ match: "^shell uiautomator dump", stdout: "UI hierchary dumped to: /sdcard/__ui.xml\n", delayMs: 300, times: 1 }]);
    const file = leasePath(resolveLocations({ env: b.env }), "unity-test");
    mkdirSync(dirname(file), { recursive: true }); // no lease yet: only the folder
    const stop = takeoverOn(b, file, "shell uiautomator dump /sdcard/__ui.xml");
    try {
      await assert.rejects(
        checkNotification(b.opts({ sinceMs: BEFORE_45, leaseMode: "warn" })),
        (e: unknown) => e instanceof EmuError && e.code === "BUSY" && e.message.includes("codex:other1"),
      );
    } finally {
      await stop();
    }
    const cmds = b.f.commands();
    assert.ok(cmds.includes("shell cmd statusbar expand-notifications"), cmds.join("\n"));
    assert.ok(!cmds.includes("shell cmd statusbar collapse"), cmds.join("\n"));
  });

  it("warn mode without a lease: a takeover when the title is not in the shade stops the collapse (tap)", async () => {
    const b = bench([
      { match: "^shell uiautomator dump", stdout: "UI hierchary dumped to: /sdcard/__ui.xml\n", delayMs: 300, times: 1 },
      { match: "^shell cat /sdcard/__ui.xml", stdoutFile: fx("permission-dialog.xml") },
    ]);
    const file = leasePath(resolveLocations({ env: b.env }), "unity-test");
    mkdirSync(dirname(file), { recursive: true }); // no lease yet: only the folder
    const stop = takeoverOn(b, file, "shell uiautomator dump /sdcard/__ui.xml");
    try {
      await assert.rejects(
        checkNotification(b.opts({ sinceMs: BEFORE_45, tap: true, leaseMode: "warn" })),
        (e: unknown) => e instanceof EmuError && e.code === "BUSY",
      );
    } finally {
      await stop();
    }
    const cmds = b.f.commands();
    assert.ok(!cmds.includes("shell cmd statusbar collapse"), cmds.join("\n"));
    assert.ok(!cmds.some((c) => c.startsWith("shell input tap")), cmds.join("\n"));
  });

  it("a takeover after the shade opened: BUSY before the notification is tapped", async () => {
    const b = bench([{ match: "^shell uiautomator dump", stdout: "UI hierchary dumped to: /sdcard/__ui.xml\n", delayMs: 300, times: 1 }]);
    const { file, ctx } = await session(b);
    const stop = takeoverOn(b, file, "shell uiautomator dump /sdcard/__ui.xml");
    try {
      await assert.rejects(
        checkNotification(b.opts({ ctx, sinceMs: BEFORE_45, tap: true, leaseMode: "strict" })),
        (e: unknown) => e instanceof EmuError && e.code === "BUSY",
      );
    } finally {
      await stop();
    }
    const cmds = b.f.commands();
    assert.ok(cmds.includes("shell cmd statusbar expand-notifications"), cmds.join("\n"));
    assert.ok(!cmds.some((c) => c.startsWith("shell input tap")), cmds.join("\n"));
  });
});
