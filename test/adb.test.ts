import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Adb, SYSTEM_DIALOG_BUTTONS, tcpPortOpen } from "../src/adb.ts";
import { EmuError } from "../src/errors.ts";
import { sleep } from "../src/proc.ts";
import { FIXTURES_DIR, makeFakeAdb, readFixture, tempLabHome } from "./helpers/fake.ts";

const PKG = "com.example.emusmoke";
const SERIAL = "emulator-5554";
const fx = (name: string) => join(FIXTURES_DIR, name);
const PNG_IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0x0d, 0x0a, 0xff]), PNG_IEND]);

function collect(): { lines: string[]; report: (l: string) => void } {
  const lines: string[] = [];
  return { lines, report: (l) => lines.push(l) };
}

describe("Adb basics", () => {
  it("prepends -s serial, joins stdout and stderr and never throws for adb errors", async () => {
    const f = makeFakeAdb([{ match: "^install", stdout: "Performing Streamed Install", stderr: "adb: failed to install x.apk", exitCode: 1 }], { serial: SERIAL });
    const out = await f.adb.run(["install", "-r", "x.apk"]);
    assert.equal(out, "Performing Streamed Install\nadb: failed to install x.apk");
    assert.deepEqual(f.calls(), [["-s", SERIAL, "install", "-r", "x.apk"]]);
    assert.deepEqual(f.commands(), ["install -r x.apk"]);
  });

  it("decodes UTF-8 (Korean notification title)", async () => {
    const f = makeFakeAdb([{ match: "^shell dumpsys notification", stdoutFile: fx("notification_dump.txt") }], { serial: SERIAL });
    const out = await f.adb.shell("dumpsys", "notification", "--noredact");
    assert.ok(out.includes("android.title=String ([이벤트] 한글 알림 B)"));
    assert.equal(out, readFixture("notification_dump.txt"));
  });

  it("withSerial keeps the options and changes the serial", async () => {
    const f = makeFakeAdb([{ match: "^shell echo", stdout: "ok\n" }]);
    assert.equal(f.adb.serial, undefined);
    const bound = f.adb.withSerial("emulator-5556");
    assert.equal(bound.serial, "emulator-5556");
    assert.equal(bound.exe, process.execPath);
    assert.equal(await bound.shell("echo", "ok"), "ok\n");
    await f.adb.shell("echo", "ok");
    assert.deepEqual(f.calls(), [
      ["-s", "emulator-5556", "shell", "echo", "ok"],
      ["shell", "echo", "ok"],
    ]);
  });

  it("maps a missing adb to NO_ADB", async () => {
    const dir = tempLabHome();
    const adb = new Adb({ exe: join(dir, "adb-missing.exe"), skipServerCheck: true });
    await assert.rejects(adb.run(["devices"]), (e: unknown) => e instanceof EmuError && e.code === "NO_ADB" && e.message.includes("adb-missing.exe"));
    assert.throws(() => adb.startLogcat(join(dir, "l.txt")), (e: unknown) => e instanceof EmuError && e.code === "NO_ADB");
  });

  it("uses the rule times and setRules", async () => {
    const f = makeFakeAdb([
      { match: "^shell getprop sys.boot_completed", stdout: "0\n", times: 1 },
      { match: "^shell getprop sys.boot_completed", stdout: "1\n" },
    ], { serial: SERIAL });
    assert.equal(await f.adb.getprop("sys.boot_completed"), "0");
    assert.equal(await f.adb.getprop("sys.boot_completed"), "1");
    f.setRules([{ match: "^shell getprop sys.boot_completed", stdout: "  7 \r\n" }]);
    assert.equal(await f.adb.getprop("sys.boot_completed"), "7");
  });

  it("version gives the first line and the path line", async () => {
    const f = makeFakeAdb([{ match: "^version$", stdout: "Android Debug Bridge version 1.0.41\nVersion 35.0.2-12147458\nInstalled as /sdk/platform-tools/adb\n" }]);
    assert.equal(await f.adb.version(), "Android Debug Bridge version 1.0.41; Installed as /sdk/platform-tools/adb");
  });
});

describe("ensureServer", () => {
  async function freePort(): Promise<number> {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    return port;
  }

  it("starts the server detached with stdio ignored, so a caller's pipes close at once", async () => {
    const dir = tempLabHome();
    const port = await freePort();
    // A stand-in adb whose "start-server" listens on the port for a while (like the real server).
    const serverScript = join(dir, "server-adb.mjs");
    writeFileSync(
      serverScript,
      [
        "import { createServer } from 'node:net';",
        "import { appendFileSync } from 'node:fs';",
        "if (process.argv.includes('start-server')) {",
        "  appendFileSync(process.env.SERVER_LOG, process.pid + '\\n');",
        "  const s = createServer((c) => c.end()).listen(Number(process.env.SERVER_PORT), '127.0.0.1');",
        "  setTimeout(() => s.close(), 15000).unref();",
        "}",
      ].join("\n"),
    );
    const serverLog = join(dir, "server.log");
    const env = { ...process.env, SERVER_PORT: String(port), SERVER_LOG: serverLog };
    // The caller is a child process with piped stdio; if the server inherited them, "close" would wait 15 s.
    const caller = join(dir, "caller.mts");
    const adbUrl = new URL("../src/adb.ts", import.meta.url).href;
    writeFileSync(
      caller,
      [
        `import { Adb } from ${JSON.stringify(adbUrl)};`,
        `const adb = new Adb({ exe: process.execPath, prefixArgs: [${JSON.stringify(serverScript)}], serverPort: ${port}, timing: { serverPollMs: 20, serverWaitMs: 10000 } });`,
        "await adb.ensureServer();",
        "await adb.ensureServer();",
        "console.log('ready');",
      ].join("\n"),
    );
    const t0 = Date.now();
    const result = await new Promise<{ code: number | null; out: string; ms: number }>((resolve) => {
      const c = spawn(process.execPath, [caller], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      c.stdout.on("data", (b: Buffer) => (out += b.toString()));
      c.stderr.on("data", (b: Buffer) => (out += b.toString()));
      c.on("close", (code) => resolve({ code, out, ms: Date.now() - t0 }));
    });
    const pids = readFileSync(serverLog, "utf8").trim().split(/\s+/).map(Number);
    try {
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, /ready/);
      assert.ok(result.ms < 8000, `caller pipes closed after ${result.ms} ms`);
      assert.equal(pids.length, 1, "start-server once; the second call sees the port open");
      assert.equal(await tcpPortOpen(port, 1000), true, "the server outlives the caller");
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid);
        } catch {
          // already gone
        }
      }
    }
  });

  it("reports when the server never listens, and NO_ADB for a missing exe", async () => {
    const dir = tempLabHome();
    const port = await freePort();
    const c = collect();
    const adb = new Adb({ exe: process.execPath, prefixArgs: [join(FIXTURES_DIR, "..", "helpers", "fake-adb.mjs")], serverPort: port, report: c.report, timing: { serverPollMs: 10, serverWaitMs: 300 }, env: { ...process.env, FAKE_ADB_STATE: join(dir, "none.json") } });
    await adb.ensureServer();
    assert.deepEqual(c.lines, [`ADB_SERVER not listening on ${port} after start-server`]);
    const missing = new Adb({ exe: join(dir, "adb-missing.exe"), serverPort: port });
    await assert.rejects(missing.ensureServer(), (e: unknown) => e instanceof EmuError && e.code === "NO_ADB");
  });
});

describe("devices and emulators", () => {
  const rules = [
    { match: "^devices$", stdoutFile: fx("devices.txt") },
  ];

  it("devices parses the list without -s", async () => {
    const f = makeFakeAdb(rules, { serial: SERIAL });
    assert.equal((await f.adb.devices()).length, 3);
    assert.deepEqual(f.calls()[0], ["devices"]);
  });

  it("avdName uses emu avd name, then getprop, else null", async () => {
    const f = makeFakeAdb([
      { match: "^emu avd name", stdout: "unity-test\r\nOK\r\n", times: 1 },
      { match: "^emu avd name", stdout: "OK\n", times: 1 },
      { match: "^shell getprop ro.boot.qemu.avd_name", stdout: "Pixel_8\n", times: 1 },
      { match: "^emu avd name", stderr: "error: no emulator detected\n", exitCode: 1, times: 1 },
      { match: "^emu avd name", stdout: "KO: unknown command\n" },
    ]);
    assert.equal(await f.adb.avdName(SERIAL), "unity-test");
    assert.equal(await f.adb.avdName(SERIAL), "Pixel_8");
    assert.equal(await f.adb.avdName(SERIAL), null, "stderr text is not an AVD name");
    assert.equal(await f.adb.avdName(SERIAL), null);
    assert.deepEqual(f.calls()[0], ["-s", SERIAL, "emu", "avd", "name"]);
    assert.deepEqual(f.calls()[2], ["-s", SERIAL, "shell", "getprop", "ro.boot.qemu.avd_name"]);
  });

  it("runningEmulators lists only emulator-N in state device", async () => {
    const f = makeFakeAdb([...rules, { match: "^emu avd name", stdout: "unity-test\nOK\n" }]);
    assert.deepEqual(await f.adb.runningEmulators(), [{ serial: SERIAL, avd: "unity-test" }]);
  });

  it("findSerial picks only the target AVD and polls until it appears", async () => {
    const f = makeFakeAdb([]);
    // The fake strips "-s serial" before matching, so the AVD names are answered in call order.
    f.setRules([
      { match: "^devices$", stdout: "List of devices attached\n", times: 2 },
      { match: "^devices$", stdout: "List of devices attached\nemulator-5556\tdevice\nemulator-5558\tdevice\n" },
      { match: "^emu avd name", stdout: "Personal_AVD\nOK\n", times: 1 },
      { match: "^emu avd name", stdout: "unity-test\nOK\n" },
    ]);
    assert.equal(await f.adb.findSerial("unity-test", 5), "emulator-5558");
    assert.equal(f.commands().filter((c) => c === "devices").length, 3);
  });

  it("findSerial without wait returns null at once", async () => {
    const f = makeFakeAdb([{ match: "^devices$", stdout: "List of devices attached\n" }]);
    const t0 = Date.now();
    assert.equal(await f.adb.findSerial("unity-test"), null);
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(f.commands().length, 1);
  });
});

describe("device queries", () => {
  it("epochMs, getprop", async () => {
    const f = makeFakeAdb([
      { match: "^shell date \\+%s%3N", stdout: "1793762543424\r\n", times: 1 },
      { match: "^shell date", stdout: "date: bad format\n" },
      { match: "^shell getprop ro.build.version.release", stdout: "16\n" },
    ], { serial: SERIAL });
    assert.equal(await f.adb.epochMs(), 1793762543424);
    await assert.rejects(f.adb.epochMs(), (e: unknown) => e instanceof EmuError && e.code === "ADB_FAILED");
    assert.equal(await f.adb.getprop("ro.build.version.release"), "16");
  });

  it("launcherActivity takes the last line with a slash", async () => {
    const f = makeFakeAdb([
      { match: `resolve-activity --brief -c android.intent.category.LAUNCHER ${PKG}$`, stdout: `priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\n${PKG}/com.unity3d.player.UnityPlayerGameActivity\n` },
      { match: "resolve-activity", stdout: "No activity found\n" },
    ], { serial: SERIAL });
    assert.equal(await f.adb.launcherActivity(PKG), `${PKG}/com.unity3d.player.UnityPlayerGameActivity`);
    await assert.rejects(f.adb.launcherActivity("com.example.none"), (e: unknown) => e instanceof EmuError && e.code === "ADB_FAILED" && e.message === "Launcher activity not found for com.example.none");
  });

  it("displaySize and isPackageResumed", async () => {
    const f = makeFakeAdb([
      { match: "^shell dumpsys window displays", stdoutFile: fx("dumpsys-window-displays.txt") },
      { match: "^shell dumpsys activity activities", stdoutFile: fx("dumpsys-activities.txt") },
    ], { serial: SERIAL });
    assert.deepEqual(await f.adb.displaySize(), { w: 1080, h: 2400 });
    assert.equal(await f.adb.isPackageResumed(PKG), true);
    assert.equal(await f.adb.isPackageResumed("com.google.android.apps.nexuslauncher"), false, "paused activity does not count");
    assert.equal(await f.adb.isPackageResumed("com.example"), false);
  });
});

describe("screencap", () => {
  it("returns PNG bytes intact through exec-out", async () => {
    const f = makeFakeAdb([{ match: "^exec-out screencap -p$", stdoutBase64: PNG.toString("base64") }], { serial: SERIAL });
    const b = await f.adb.screencap();
    assert.ok(b.equals(PNG));
    const dir = tempLabHome();
    const path = join(dir, "shots", "01.png");
    await f.adb.saveScreenshot(path);
    assert.ok(readFileSync(path).equals(PNG));
  });

  it("retries once, then fails with ADB_FAILED", async () => {
    const f = makeFakeAdb([
      { match: "^exec-out screencap", stdout: "error: closed", times: 1 },
      { match: "^exec-out screencap", stdoutBase64: PNG.toString("base64") },
    ], { serial: SERIAL });
    assert.ok((await f.adb.screencap()).equals(PNG));
    f.setRules([{ match: "^exec-out screencap", stdout: "error: device offline" }]);
    await assert.rejects(f.adb.screencap(), (e: unknown) => e instanceof EmuError && e.code === "ADB_FAILED" && e.message.includes("device offline"));
    assert.equal(f.commands().filter((c) => c.startsWith("exec-out")).length, 4);
  });

  it("a cut-off PNG (no IEND) or a failed adb exit is not accepted: retried once, then ADB_FAILED", async () => {
    const cut = PNG.subarray(0, 12);
    const f = makeFakeAdb([
      { match: "^exec-out screencap", stdoutBase64: cut.toString("base64"), times: 1 },
      { match: "^exec-out screencap", stdoutBase64: PNG.toString("base64") },
    ], { serial: SERIAL });
    assert.ok((await f.adb.screencap()).equals(PNG), "the retry returns the whole PNG");

    f.setRules([{ match: "^exec-out screencap", stdoutBase64: cut.toString("base64") }]);
    await assert.rejects(f.adb.screencap(), (e: unknown) => e instanceof EmuError && e.code === "ADB_FAILED" && /cut-off PNG of 12 bytes/.test(e.message));

    // The device dropped after the whole image went out: adb exits 1, the bytes are not trusted.
    f.setRules([{ match: "^exec-out screencap", stdoutBase64: PNG.toString("base64"), exitCode: 1 }]);
    await assert.rejects(f.adb.screencap(), (e: unknown) => e instanceof EmuError && e.code === "ADB_FAILED" && /adb exited 1/.test(e.message));
  });
});

describe("uiDump", () => {
  it("deletes the old file first and returns a fresh dump", async () => {
    const f = makeFakeAdb([
      { match: "^shell uiautomator dump", stdout: "UI hierchary dumped to: /sdcard/__ui.xml\n" },
      { match: "^shell cat /sdcard/__ui.xml", stdoutFile: fx("shade.xml") },
    ], { serial: SERIAL });
    const xml = await f.adb.uiDump();
    assert.equal(xml, readFixture("shade.xml"));
    assert.deepEqual(f.commands(), ["shell rm -f /sdcard/__ui.xml", "shell uiautomator dump /sdcard/__ui.xml", "shell cat /sdcard/__ui.xml"]);
  });

  it("stops the mobile-mcp DeviceServer and retries", async () => {
    const c = collect();
    const f = makeFakeAdb([
      { match: "^shell uiautomator dump", stdout: "Killed\n", exitCode: 137, times: 1 },
      { match: "^shell uiautomator dump", stdout: "UI hierchary dumped to: /sdcard/__ui.xml\n" },
      { match: "^shell pgrep -f com.mobilenext.mobilecli.DeviceServer", stdout: "4242\n", times: 1 },
      { match: "^shell cat /sdcard/__ui.xml", stdoutFile: fx("shade.xml") },
    ], { serial: SERIAL, report: c.report });
    assert.ok((await f.adb.uiDump())?.includes("<hierarchy"));
    assert.deepEqual(c.lines, ["UI_DUMP stopped mobile-mcp DeviceServer (pid 4242) that held UiAutomation"]);
    assert.deepEqual(f.commands(), [
      "shell rm -f /sdcard/__ui.xml",
      "shell uiautomator dump /sdcard/__ui.xml",
      "shell pgrep -f com.mobilenext.mobilecli.DeviceServer",
      "shell pkill -f com.mobilenext.mobilecli.DeviceServer",
      "shell rm -f /sdcard/__ui.xml",
      "shell uiautomator dump /sdcard/__ui.xml",
      "shell cat /sdcard/__ui.xml",
    ]);
  });

  it("does not trust a stale file when the dump fails and reports UI_DUMP_FAILED", async () => {
    const c = collect();
    const f = makeFakeAdb([
      { match: "^shell uiautomator dump", stdout: "ERROR: could not get idle state.\n" },
      { match: "^shell cat /sdcard/__ui.xml", stdoutFile: fx("shade.xml") },
    ], { serial: SERIAL, report: c.report });
    assert.equal(await f.adb.uiDump(2), null);
    assert.deepEqual(c.lines, ["UI_DUMP_FAILED ERROR: could not get idle state."]);
    assert.equal(f.commands().filter((x) => x.startsWith("shell cat")).length, 0);
    assert.equal(f.commands().filter((x) => x === "shell rm -f /sdcard/__ui.xml").length, 2);
  });

  it("rejects a dump that is not a hierarchy", async () => {
    const f = makeFakeAdb([
      { match: "^shell uiautomator dump", stdout: "UI hierchary dumped to: /sdcard/__ui.xml\n" },
      { match: "^shell cat", stdout: "cat: /sdcard/__ui.xml: No such file or directory\n" },
    ], { serial: SERIAL });
    assert.equal(await f.adb.uiDump(1), null);
  });
});

describe("resolveSystemDialog", () => {
  it("taps the system button (not the app's own), logs and reports it", async () => {
    const c = collect();
    const f = makeFakeAdb([
      { match: "^shell uiautomator dump", stdout: "UI hierchary dumped to: /sdcard/__ui.xml\n" },
      { match: "^shell cat /sdcard/__ui.xml", stdoutFile: fx("permission-dialog.xml") },
    ], { serial: SERIAL, report: c.report });
    const log = join(tempLabHome(), "run", "system-dialogs.txt");
    assert.equal(await f.adb.resolveSystemDialog(PKG, log), "Allow");
    assert.deepEqual(f.calls().at(-1), ["-s", SERIAL, "shell", "input", "tap", "540", "1347.5"]);
    const note = readFileSync(log, "utf8");
    assert.match(note, /^\d{2}:\d{2}:\d{2} tapped 'Allow' in com\.google\.android\.permissioncontroller at 540,1347\.5\r?\n$/);
    assert.equal(note.trim().slice(9), readFixture("system-dialogs.txt").trim().slice(9));
    assert.deepEqual(c.lines, [`SYSTEM_DIALOG ${note.trim()}`]);
  });

  it("leaves the app's own dialogs alone", async () => {
    const f = makeFakeAdb([
      { match: "^shell uiautomator dump", stdout: "UI hierchary dumped to: /sdcard/__ui.xml\n" },
      { match: "^shell cat /sdcard/__ui.xml", stdoutFile: fx("permission-dialog.xml") },
    ], { serial: SERIAL });
    // Seen from the permission controller, the other package's "Allow" is the one to tap.
    assert.equal(await f.adb.resolveSystemDialog("com.google.android.permissioncontroller"), "Allow");
    assert.deepEqual(f.calls().at(-1)?.slice(2), ["shell", "input", "tap", "500", "2050"]);
    f.setRules([
      { match: "^shell uiautomator dump", stdout: "UI hierchary dumped to: /sdcard/__ui.xml\n" },
      { match: "^shell cat /sdcard/__ui.xml", stdoutFile: fx("shade.xml") },
    ]);
    const before = f.commands().length;
    assert.equal(await f.adb.resolveSystemDialog(PKG), null);
    assert.ok(!f.commands().slice(before).some((c) => c.startsWith("shell input")));
    assert.deepEqual(SYSTEM_DIALOG_BUTTONS, ["Got it", "Allow", "OK"]);
  });
});

describe("startLogcat", () => {
  it("streams a growing source into the file and memory, and stop() ends the child", async () => {
    const dir = tempLabHome();
    const source = join(dir, "device-log.txt");
    writeFileSync(source, "11-04 03:21:40.768 I/Unity   ( 3824): SMOKE_APP_STARTED\n");
    const f = makeFakeAdb([{ match: "^logcat -v time", stream: source }], { serial: SERIAL });
    const file = join(dir, "run", "logcat.txt");
    const cap = f.adb.startLogcat(file, ["-T", "1"]);
    assert.equal(cap.file, file);

    const waitFor = async (text: string) => {
      const deadline = Date.now() + 10_000;
      while (!cap.text().includes(text) && Date.now() < deadline) await sleep(30);
      assert.ok(cap.text().includes(text), `saw ${text}`);
    };
    await waitFor("SMOKE_APP_STARTED");
    appendFileSync(source, "11-04 03:21:48.439 I/Unity   ( 3824): SMOKE_APP_READY 한글\n");
    await waitFor("SMOKE_APP_READY 한글");
    assert.equal(cap.length(), cap.text().length);

    await cap.stop();
    await cap.stop(); // idempotent
    const saved = readFileSync(file, "utf8");
    assert.ok(saved.includes("SMOKE_APP_STARTED") && saved.includes("SMOKE_APP_READY 한글"));
    assert.deepEqual(f.calls()[0], ["-s", SERIAL, "logcat", "-v", "time", "-T", "1"]);

    // The child is gone: nothing more arrives after stop().
    appendFileSync(source, "AFTER_STOP\n");
    await sleep(300);
    assert.ok(!cap.text().includes("AFTER_STOP"));
    assert.ok(!readFileSync(file, "utf8").includes("AFTER_STOP"));
  });

  it("appends to an existing file and survives adb ending by itself", async () => {
    const dir = tempLabHome();
    const file = join(dir, "logcat.txt");
    writeFileSync(file, "previous\n");
    const f = makeFakeAdb([{ match: "^logcat", stdout: "- waiting for device -\nerror: device offline\n", exitCode: 1 }], { serial: SERIAL });
    const cap = f.adb.startLogcat(file);
    const deadline = Date.now() + 10_000;
    while (!cap.text().includes("device offline") && Date.now() < deadline) await sleep(30);
    await cap.stop();
    assert.equal(readFileSync(file, "utf8"), "previous\n- waiting for device -\nerror: device offline\n");
  });
});
