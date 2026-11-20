import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  centre,
  crashRegex,
  decodeXmlEntities,
  findDialogButton,
  findNotificationRecord,
  findUiNodeByText,
  parseDevices,
  parseDisplaySize,
  parseLaunch,
  parseUiNodes,
  unityLines,
} from "../src/parse.ts";
import { readFixture } from "./helpers/fake.ts";

const PKG = "com.example.emusmoke";
const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

describe("parseDevices", () => {
  it("skips the header and daemon notices and keeps every state", () => {
    assert.deepEqual(parseDevices(readFixture("devices.txt")), [
      { serial: "emulator-5554", state: "device" },
      { serial: "emulator-5556", state: "offline" },
      { serial: "R5CT1234ABC", state: "unauthorized" },
    ]);
  });
  it("handles CRLF and an empty list", () => {
    assert.deepEqual(parseDevices(crlf(readFixture("devices.txt")))[0], { serial: "emulator-5554", state: "device" });
    assert.deepEqual(parseDevices("List of devices attached\r\n\r\n"), []);
  });
});

describe("parseDisplaySize", () => {
  it("reads cur=WxH", () => {
    assert.deepEqual(parseDisplaySize(readFixture("dumpsys-window-displays.txt")), { w: 1080, h: 2400 });
  });
  it("returns null without cur=", () => {
    assert.equal(parseDisplaySize("init=1080x2400 base=1080x2400"), null);
    assert.equal(parseDisplaySize("recur=10x10"), null);
  });
});

describe("parseLaunch", () => {
  it("reads status and TotalTime", () => {
    assert.deepEqual(parseLaunch(readFixture("am-start.txt")), { ok: true, totalTimeMs: 4910 });
  });
  it("reports failure", () => {
    assert.deepEqual(parseLaunch("Error: Activity class {x/y} does not exist."), { ok: false, totalTimeMs: null });
  });
});

describe("decodeXmlEntities", () => {
  it("decodes named and numeric entities once", () => {
    assert.equal(decodeXmlEntities("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#39;f&#39; &#x2605;"), "a & b <c> \"d\" 'e' 'f' \u2605");
    assert.equal(decodeXmlEntities("&amp;lt;"), "&lt;");
    assert.equal(decodeXmlEntities("&nbsp; &#xZZ;"), "&nbsp; &#xZZ;");
  });
});

describe("parseUiNodes / findUiNodeByText", () => {
  const shade = readFixture("shade.xml");
  it("lists nodes with text, package and bounds", () => {
    const nodes = parseUiNodes(shade);
    assert.equal(nodes.length, 8);
    assert.deepEqual(nodes[2], { text: "EMU-SMOKE-032148", pkg: "com.android.systemui", bounds: [179, 630, 525, 681] });
  });
  it("finds a node by part of its text, Korean included", () => {
    assert.deepEqual(findUiNodeByText(shade, "032148")?.bounds, [179, 630, 525, 681]);
    assert.equal(findUiNodeByText(shade, "한글 알림 B")?.text, "[이벤트] 한글 알림 B");
    assert.equal(findUiNodeByText(shade, "no such title"), null);
    assert.equal(findUiNodeByText(shade, ""), null);
  });
  it("matches entity-decoded titles", () => {
    const n = findUiNodeByText(shade, 'Sale & Event "50%" <today>');
    assert.ok(n);
    assert.equal(n.text, "Sale & Event \"50%\" <today> 'now' \u2605");
    assert.deepEqual(centre(n.bounds), { x: 339, y: 1071 });
  });
});

describe("centre", () => {
  it("keeps halves like the PowerShell scripts", () => {
    assert.deepEqual(centre([84, 1290, 996, 1405]), { x: 540, y: 1347.5 });
  });
});

describe("findDialogButton", () => {
  const xml = readFixture("permission-dialog.xml");
  it("ignores the app's own buttons and picks the system one", () => {
    assert.deepEqual(findDialogButton(xml, ["Got it", "Allow", "OK"], PKG), {
      label: "Allow",
      pkg: "com.google.android.permissioncontroller",
      x: 540,
      y: 1347.5,
    });
  });
  it("gives the same note as the recorded system-dialogs.txt", () => {
    const b = findDialogButton(xml, ["Got it", "Allow", "OK"], PKG);
    assert.ok(b);
    const recorded = readFixture("system-dialogs.txt").trim().replace(/^\d{2}:\d{2}:\d{2} /, "");
    assert.equal(`tapped '${b.label}' in ${b.pkg} at ${b.x},${b.y}`, recorded);
  });
  it("returns null when only the app shows the labels", () => {
    assert.equal(findDialogButton(xml, ["OK", "Allow"], "com.google.android.permissioncontroller")?.pkg, PKG);
    assert.equal(findDialogButton(xml, ["Got it", "OK"], PKG), null);
    assert.equal(findDialogButton(readFixture("shade.xml"), ["Got it", "Allow", "OK"], PKG), null);
  });
  it("tries labels in order", () => {
    assert.equal(findDialogButton(xml, ["OK", "Allow"], "other.pkg")?.label, "OK");
  });
});

describe("findNotificationRecord", () => {
  const dump = readFixture("notification_dump.txt");
  it("finds the app's record newer than sinceMs, not another package with the same title", () => {
    const r = findNotificationRecord(dump, PKG, "EMU-SMOKE-032148", 1793762500000);
    assert.ok(r);
    assert.equal(r.timeMs, 1793762543424);
    assert.ok(r.record.startsWith("NotificationRecord(0x0c7a9be5: pkg=com.example.emusmoke "));
    assert.ok(!r.record.includes("0x0f9e8d7c"), "the record ends where the next one starts");
  });
  it("skips a record older than sinceMs", () => {
    assert.equal(findNotificationRecord(dump, PKG, "EMU-SMOKE-031500", 1793762000000), null);
    assert.equal(findNotificationRecord(dump, PKG, "EMU-SMOKE-031500", 1793761900000)?.timeMs, 1793761900000);
    assert.equal(findNotificationRecord(dump, PKG, "EMU-SMOKE-032148", 1793762543425), null);
  });
  it("falls back to mCreationTimeMs and handles Korean titles and CRLF", () => {
    const r = findNotificationRecord(crlf(dump), PKG, "[이벤트] 한글 알림 B", 0);
    assert.equal(r?.timeMs, 1793762550000);
  });
  it("does not take a package that only starts with the name", () => {
    assert.equal(findNotificationRecord(dump, "com.example.emusmoke2", "EMU-SMOKE-032148", 0)?.timeMs, 1793762543500);
    assert.equal(findNotificationRecord(dump, "com.example", "EMU-SMOKE-032148", 0), null);
  });
  it("accepts a record without a time", () => {
    const r = findNotificationRecord("NotificationRecord(0x1: pkg=a.b user=0)\n  android.title=String (T)\n", "a.b", "T", 999);
    assert.deepEqual(r, { record: "NotificationRecord(0x1: pkg=a.b user=0)\n  android.title=String (T)\n", timeMs: null });
  });
});

describe("crashRegex", () => {
  const re = crashRegex(PKG);
  it("detects a Java crash, also with CRLF", () => {
    assert.ok(re.test(readFixture("logcat-crash.txt")));
    assert.ok(re.test(crlf(readFixture("logcat-crash.txt"))));
  });
  it("detects a native crash and the tombstone line", () => {
    const lines = readFixture("logcat-native-crash.txt").split("\n");
    assert.ok(re.test(lines[0]));
    assert.ok(re.test(lines[1]));
  });
  it("detects an ANR", () => {
    assert.ok(re.test(readFixture("logcat-anr.txt")));
  });
  it("ignores other processes and a normal run", () => {
    assert.equal(re.test(readFixture("logcat-crash-other.txt")), false);
    assert.equal(re.test(readFixture("logcat.txt")), false);
    assert.equal(re.test(readFixture("logcat.txt")), false, "not global: repeated tests agree");
  });
  it("escapes the package name", () => {
    assert.equal(crashRegex("com.example.emusmoke").test("ANR in comXexampleXemusmoke"), false);
  });
});

describe("unityLines", () => {
  it("keeps Unity, AndroidRuntime, DEBUG and libc lines", () => {
    const lines = unityLines(crlf(readFixture("logcat.txt")));
    assert.ok(lines.length > 10);
    assert.ok(lines.every((l) => /\/(Unity|AndroidRuntime|DEBUG|libc)\s*\(/.test(l)));
    assert.ok(lines.some((l) => l.includes("SMOKE_APP_READY")));
    assert.ok(lines.some((l) => l.includes("AndroidRuntime( 3931): Using default boot image")));
    assert.ok(!lines.some((l) => l.includes("GameActivity( 3824)")));
    assert.ok(!lines.some((l) => l.endsWith("\r")));
    assert.equal(unityLines(readFixture("logcat-native-crash.txt")).length, 2);
  });
});
