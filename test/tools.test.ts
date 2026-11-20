// Every MCP tool, called through a real MCP client over the SDK's in-memory transport. EMU_LAB_HOME is a temp
// directory and adb is the fake adb (test/helpers/fake-adb.mjs): nothing here touches a real device, emulator,
// process list or the real ~/.emu-lab.

import { after, afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveLocations } from "../src/config.ts";
import { JobRegistry } from "../src/jobs.ts";
import { formatLocalIso, leasePath, readLease, writeLease } from "../src/lease.ts";
import { createServer, pngSize } from "../src/server.ts";
import type { LeaseRecord } from "../src/types.ts";
import { isEmuError } from "../src/errors.ts";
import { callsOffSerial, makeFakeAdb, otherDeviceRules, tempLabHome, TWO_DEVICES, type FakeRule } from "./helpers/fake.ts";

const AVD = "unity-test";
const ME = "test:me";
const OTHER = "test:other";
const SERIAL = "emulator-5554";
const HOUR = 3_600_000;

const home = tempLabHome();
const env: NodeJS.ProcessEnv = { ...process.env, EMU_LAB_HOME: home, EMU_OWNER: ME };
delete env.EMU_AVD;
const loc = resolveLocations({ env });
assert.equal(loc.labHome, home, "tests must run against a temp lab home");
const LEASE = leasePath(loc, AVD);

/** A 4x2 PNG header and the IEND chunk: enough for the signature, IHDR size and whole-PNG checks. */
function tinyPng(): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(4, 8);
  ihdr.writeUInt32BE(2, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(6, 17);
  return Buffer.concat([sig, ihdr, Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])]);
}

function deviceRules(o: { devicesDelayMs?: number } = {}): FakeRule[] {
  return [
    { match: "^devices$", stdout: `List of devices attached\r\n${SERIAL}\tdevice\r\n\r\n`, delayMs: o.devicesDelayMs },
    { match: "^emu avd name$", stdout: `${AVD}\r\nOK\r\n` },
    { match: "^shell getprop sys\\.boot_completed$", stdout: "1\n" },
    { match: "^shell getprop ro\\.product\\.cpu\\.abilist$", stdout: "x86_64,arm64-v8a\n" },
    { match: "^shell getprop ro\\.dalvik\\.vm\\.native\\.bridge$", stdout: "libndk_translation.so\n" },
    { match: "^shell getprop ro\\.build\\.version\\.release$", stdout: "14\n" },
    { match: "^shell settings get global auto_time$", stdout: "1\n" },
    { match: "^shell date \\+%s%3N$", stdout: `${Date.now()}\n` },
    { match: "^exec-out screencap -p$", stdoutBase64: tinyPng().toString("base64") },
    { match: "^version$", stdout: "Android Debug Bridge version 1.0.41\nInstalled as C:\\sdk\\platform-tools\\adb.exe\n" },
  ];
}

const fake = makeFakeAdb(deviceRules());
const jobs = new JobRegistry();
const server = createServer({
  env,
  adbFactory: () => fake.adb,
  deps: {
    jobs,
    connectWaitSec: 0,
    emulator: {
      findProcesses: async () => [],
      getProcessInfo: async () => null,
      spawnDetached: () => {
        throw new Error("tests never launch an emulator");
      },
      timing: { reattachWaitMs: 50, lingerWaitMs: 50, launchCheckMs: 10, bootPollMs: 20, releaseFindWaitMs: 50, stopWaitMs: 50, stopPollMs: 10, clock: { settleMs: 0, rootPollMs: 10, rootWaitMs: 100 } },
    },
    smoke: { waitSec: 0, timing: { logPollMs: 20 } },
    notification: { waitSec: 0, timing: { pollMs: 20 } },
    clock: { timing: { settleMs: 0, rootPollMs: 10, rootWaitMs: 100 } },
  },
});
const client = new Client({ name: "tools-test", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

after(async () => {
  await client.close();
  await server.close();
});

afterEach(() => {
  rmSync(LEASE, { force: true });
  fake.setRules(deviceRules());
});

interface CallResult {
  text: string;
  isError: boolean;
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as CallResult["content"];
  return { text: content.map((c) => c.text ?? "").join("\n"), isError: res.isError === true, content };
}

/** The JSON object at the start of a tool result (before the report section). */
function json(text: string): Record<string, any> {
  const cut = text.indexOf("\n\nreport");
  return JSON.parse(cut >= 0 ? text.slice(0, cut) : text) as Record<string, any>;
}

async function seedLease(owner: string, expiresInMs: number, extra: Partial<LeaseRecord> = {}): Promise<LeaseRecord> {
  const now = Date.now();
  const lease: LeaseRecord = {
    avd: AVD,
    owner,
    host: "TESTHOST",
    acquiredAt: formatLocalIso(new Date(now - 60_000)),
    expiresAt: formatLocalIso(new Date(now + expiresInMs)),
    startedEmulator: false,
    emulatorPid: null,
    emulatorStartedAt: null,
    installed: [],
    ...extra,
  };
  await writeLease(LEASE, lease, { create: false });
  return lease;
}

/** Commands the fake adb ran since `from` (an index into fake.commands()). */
function commandsSince(from: number): string[] {
  return fake.commands().slice(from);
}

/**
 * The only commands a refused or read-only tool may send: anything else (install, logcat -c, uiautomator dump,
 * rm, push, settings put, ...) counts as a device change.
 */
const READ_ONLY_CMD = /^(devices|version|emu avd name|shell getprop \S+|shell settings get global \S+|shell date \+%s%3N|exec-out screencap -p)$/;

/** Commands of `cmds` that are not known to be read-only. */
function deviceChanges(cmds: string[]): string[] {
  return cmds.filter((c) => !READ_ONLY_CMD.test(c));
}

type Hints = { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };

/** What each handler does, as MCP hints (spec table). A new tool needs a row here. */
const HINTS: Record<string, Hints> = {
  emu_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  emu_start: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  emu_renew: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  emu_release: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  emu_smoke: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  emu_check_notification: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  emu_clock: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  emu_screenshot: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  emu_job: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

describe("tool list", () => {
  test("all 9 tools, each with all four hints matching the spec", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(HINTS).sort());
    for (const t of tools) {
      const a = t.annotations ?? {};
      const hints = {
        readOnlyHint: a.readOnlyHint,
        destructiveHint: a.destructiveHint,
        idempotentHint: a.idempotentHint,
        openWorldHint: a.openWorldHint,
      };
      assert.deepEqual(hints, HINTS[t.name], t.name);
      assert.ok(t.description && t.description.length > 40, `${t.name} has a description`);
    }
  });

  test("descriptions of the lease and job tools tell the agent what to do on BUSY and with job ids", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? ""]));
    for (const name of ["emu_start", "emu_smoke", "emu_check_notification", "emu_clock", "emu_status"]) {
      assert.match(byName.get(name)!, /BUSY/, name);
    }
    for (const name of ["emu_start", "emu_smoke", "emu_check_notification", "emu_release"]) {
      assert.match(byName.get(name)!, /job_id/, name);
      assert.match(byName.get(name)!, /emu_job/, name);
    }
    assert.match(byName.get("emu_job")!, /JOB_UNKNOWN/);
  });

  test("emu_release has no any-owner or stale input", async () => {
    const { tools } = await client.listTools();
    const release = tools.find((t) => t.name === "emu_release")!;
    const props = Object.keys((release.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    assert.deepEqual(props.sort(), ["avd", "keep_running", "packages", "uninstall"]);
    assert.ok(!props.some((p) => /any|stale|owner/.test(p)));
  });

  test("server instructions mention emu_start, BUSY, emu_release, emu_job and mobile-mcp", () => {
    const instructions = client.getInstructions() ?? "";
    for (const word of ["emu_start", "BUSY", "emu_release", "emu_job", "mobile-mcp", "notif_delay 0", "audio"]) {
      assert.ok(instructions.includes(word), word);
    }
  });
});

describe("emu_status", () => {
  test("lease, emulators, serial, boot state, paths and adb version; no lease", async () => {
    const res = await call("emu_status");
    assert.equal(res.isError, false, res.text);
    const s = json(res.text);
    assert.equal(s.avd, AVD);
    assert.equal(s.owner, ME);
    assert.equal(s.lease, null);
    assert.equal(s.leaseFile, LEASE);
    assert.deepEqual(s.emulators, [{ serial: SERIAL, avd: AVD }]);
    assert.equal(s.serial, SERIAL);
    assert.equal(s.bootCompleted, true);
    assert.equal(s.paths.labHome, home);
    assert.match(s.adbVersion, /Android Debug Bridge/);
  });

  test("another owner's valid lease shows as valid and not mine; nothing is written", async () => {
    await seedLease(OTHER, HOUR);
    const from = fake.commands().length;
    const s = json((await call("emu_status")).text);
    assert.equal(s.lease.owner, OTHER);
    assert.equal(s.lease.valid, true);
    assert.equal(s.lease.mine, false);
    assert.deepEqual(deviceChanges(commandsSince(from)), []);
    assert.equal((await readLease(LEASE))!.owner, OTHER);
  });
});

describe("lease refusals", () => {
  test("emu_start: BUSY under another owner's valid lease, before any adb call, lease untouched", async () => {
    const seeded = await seedLease(OTHER, HOUR);
    const from = fake.commands().length;
    const res = await call("emu_start");
    assert.equal(res.isError, true);
    assert.match(res.text, /^BUSY: AVD 'unity-test' is leased by test:other/);
    assert.ok(!res.text.startsWith("BUSY: BUSY"), "token not doubled");
    assert.deepEqual(commandsSince(from), []);
    assert.deepEqual(await readLease(LEASE), seeded);
  });

  test("emu_smoke: BUSY under another owner's valid lease; nothing installed", async () => {
    await seedLease(OTHER, HOUR);
    const from = fake.commands().length;
    const res = await call("emu_smoke", { apk: "C:/does-not-exist/app.apk" });
    assert.equal(res.isError, true);
    assert.match(res.text, /^BUSY: /);
    assert.deepEqual(deviceChanges(commandsSince(from)), []);
  });

  test("NO_LEASE without a lease: emu_smoke, emu_check_notification, emu_clock forward", async () => {
    const from = fake.commands().length;
    const smoke = await call("emu_smoke", { apk: "C:/does-not-exist/app.apk" });
    assert.equal(smoke.isError, true);
    assert.match(smoke.text, /^NO_LEASE: AVD 'unity-test' is not leased by test:me/);

    const notif = await call("emu_check_notification", { package: "com.example.emusmoke", title: "Hello" });
    assert.equal(notif.isError, true);
    assert.match(notif.text, /^NO_LEASE: /);

    const clock = await call("emu_clock", { action: "forward", minutes: 90 });
    assert.equal(clock.isError, true);
    assert.match(clock.text, /^NO_LEASE: /);

    assert.deepEqual(deviceChanges(commandsSince(from)), []);
    assert.equal(existsSync(LEASE), false);
  });

  test("NO_LEASE also when only another owner's expired lease exists (emu_clock forward)", async () => {
    await seedLease(OTHER, -HOUR);
    const res = await call("emu_clock", { action: "forward", minutes: 90 });
    assert.equal(res.isError, true);
    assert.match(res.text, /^NO_LEASE: .*ran out/);
  });

  test("emu_clock forward without minutes is BAD_OPTION before touching the device", async () => {
    await seedLease(ME, HOUR);
    const from = fake.commands().length;
    const res = await call("emu_clock", { action: "forward" });
    assert.equal(res.isError, true);
    assert.match(res.text, /^BAD_OPTION: /);
    assert.deepEqual(commandsSince(from), []);
  });
});

describe("emu_clock reset", () => {
  test("refused only under another owner's valid lease", async () => {
    await seedLease(OTHER, HOUR);
    const from = fake.commands().length;
    const busy = await call("emu_clock", { action: "reset" });
    assert.equal(busy.isError, true);
    assert.match(busy.text, /^BUSY: /);
    assert.deepEqual(commandsSince(from), []);

    /** This call set the host time and then turned automatic time back on. */
    const resetIn = (cmds: string[]): boolean => {
      const setTime = cmds.findIndex((c) => /^shell cmd alarm set-time \d+$/.test(c));
      const autoOn = cmds.indexOf("shell settings put global auto_time 1");
      return setTime >= 0 && autoOn > setTime;
    };

    await seedLease(OTHER, -HOUR);
    let start = fake.commands().length;
    const expired = await call("emu_clock", { action: "reset" });
    assert.equal(expired.isError, false, expired.text);
    assert.equal(json(expired.text).action, "reset");
    assert.match(expired.text, /TIME_TRAVEL before=/);
    assert.ok(resetIn(commandsSince(start)), "expired: reset on the device");

    rmSync(LEASE, { force: true });
    start = fake.commands().length;
    const none = await call("emu_clock", { action: "reset" });
    assert.equal(none.isError, false, none.text);
    assert.ok(resetIn(commandsSince(start)), "no lease: reset on the device");

    await seedLease(ME, HOUR);
    start = fake.commands().length;
    const own = await call("emu_clock", { action: "reset" });
    assert.equal(own.isError, false, own.text);
    assert.equal(json(own.text).serial, SERIAL);
    assert.ok(resetIn(commandsSince(start)), "own lease: reset on the device");
  });

  test("emu_clock is held as a device-changing job: release and smoke are refused (JOB_RUNNING) while it runs", async () => {
    await seedLease(ME, HOUR);
    const now = Date.now();
    fake.setRules([
      { match: "^shell cmd alarm set-time", delayMs: 1200, times: 1 }, // the forward is slow (adb root fallback)
      { match: "^shell date \\+%s%3N$", stdout: `${now}\n`, times: 1 },
      { match: "^shell date \\+%s%3N$", stdout: `${now + 91 * 60_000}\n` },
      ...deviceRules(),
    ]);
    const start = fake.commands().length;
    const forward = call("emu_clock", { action: "forward", minutes: 90 });
    while (!commandsSince(start).some((c) => c.startsWith("shell cmd alarm set-time"))) await new Promise((r) => setTimeout(r, 20));

    const release = await call("emu_release");
    assert.equal(release.isError, true);
    assert.match(release.text, /^JOB_RUNNING: job clock-forward-\d+-\w+ \(clock-forward\) is still changing AVD 'unity-test'/);
    const smoke = await call("emu_smoke", { apk: "C:/does-not-exist/app.apk" });
    assert.match(smoke.text, /^JOB_RUNNING: /);
    const reset = await call("emu_clock", { action: "reset" });
    assert.match(reset.text, /^JOB_RUNNING: /);

    const done = await forward;
    assert.equal(done.isError, false, done.text);
    assert.equal(json(done.text).action, "forward");
    // The lease is still there (release was refused) and the clock is put back afterwards.
    assert.equal((await readLease(LEASE))!.owner, ME);
    const back = await call("emu_clock", { action: "reset" });
    assert.equal(back.isError, false, back.text);
  });

  test("with a second emulator attached, emu_clock and emu_screenshot only talk to the AVD's serial", async () => {
    await seedLease(ME, HOUR);
    const now = Date.now();
    fake.setRules([
      ...otherDeviceRules(),
      { match: "^devices$", stdout: TWO_DEVICES },
      { match: "^shell date \\+%s%3N$", stdout: `${now}\n`, times: 1 },
      { match: "^shell date \\+%s%3N$", stdout: `${now + 91 * 60_000}\n` },
      ...deviceRules(),
    ]);
    const from = fake.calls().length;
    assert.equal((await call("emu_clock", { action: "forward", minutes: 90 })).isError, false);
    assert.equal((await call("emu_clock", { action: "reset" })).isError, false);
    assert.equal((await call("emu_screenshot")).isError, false);
    const calls = fake.calls().slice(from);
    assert.deepEqual(callsOffSerial(calls, SERIAL), []);
    assert.ok(calls.some((c) => c[1] === "emulator-5556"), "the other emulator was listed and looked at");
  });
});

describe("emu_release and emu_renew", () => {
  test("emu_release refuses another owner's lease (NOT_OWNER), also with an any_owner argument", async () => {
    await seedLease(OTHER, HOUR);
    const res = await call("emu_release");
    assert.equal(res.isError, true);
    assert.match(res.text, /^NOT_OWNER AVD 'unity-test' is leased by test:other/);
    assert.ok(!res.text.startsWith("NOT_OWNER: NOT_OWNER"));
    assert.equal((await readLease(LEASE))!.owner, OTHER);

    const sneaky = await call("emu_release", { any_owner: true, stale: true });
    assert.equal(sneaky.isError, true);
    assert.match(sneaky.text, /NOT_OWNER/);
    assert.equal((await readLease(LEASE))!.owner, OTHER);
  });

  test("emu_release without a lease: released false, not an error", async () => {
    const res = await call("emu_release");
    assert.equal(res.isError, false, res.text);
    assert.equal(json(res.text).released, false);
    assert.match(res.text, /LEASE_NONE/);
  });

  test("emu_release of our own lease deletes it and keeps the emulator running", async () => {
    await seedLease(ME, HOUR, { installed: ["com.example.emusmoke"] });
    const res = await call("emu_release");
    assert.equal(res.isError, false, res.text);
    const r = json(res.text);
    assert.equal(r.released, true);
    assert.equal(r.stopped, "kept");
    assert.deepEqual(r.kept, ["com.example.emusmoke"]);
    assert.equal(existsSync(LEASE), false);
  });

  test("emu_renew: NO_LEASE without a lease, NOT_OWNER for another owner, extends our own", async () => {
    const none = await call("emu_renew");
    assert.equal(none.isError, true);
    assert.match(none.text, /^NO_LEASE: /);

    await seedLease(OTHER, HOUR);
    const other = await call("emu_renew");
    assert.equal(other.isError, true);
    assert.match(other.text, /^NOT_OWNER/);

    const mine = await seedLease(ME, 60_000);
    const res = await call("emu_renew", { hours: 2 });
    assert.equal(res.isError, false, res.text);
    const lease = json(res.text);
    assert.equal(lease.owner, ME);
    assert.ok(Date.parse(lease.expiresAt) > Date.parse(mine.expiresAt) + HOUR);
    assert.match(res.text, /LEASE renewed avd=unity-test owner=test:me/);
  });
});

describe("emu_screenshot", () => {
  test("returns a PNG image and a text line with serial and size, without a lease", async () => {
    const res = await call("emu_screenshot");
    assert.equal(res.isError, false, res.text);
    const image = res.content.find((c) => c.type === "image")!;
    assert.equal(image.mimeType, "image/png");
    assert.deepEqual(pngSize(Buffer.from(image.data!, "base64")), { width: 4, height: 2 });
    assert.match(res.text, new RegExp(`SCREENSHOT avd=unity-test serial=${SERIAL} size=4x2 bytes=\\d+`));
  });
});

describe("jobs", () => {
  test("emu_job with an unknown id: JOB_UNKNOWN", async () => {
    const res = await call("emu_job", { job_id: "smoke-999-zzz", wait_sec: 0 });
    assert.equal(res.isError, true);
    assert.match(res.text, /^JOB_UNKNOWN: no job 'smoke-999-zzz'/);
  });

  test("a job that outlives wait_sec returns a job_id; emu_job later returns its result", async () => {
    const res = await call("emu_start", { wait_sec: 0 });
    assert.equal(res.isError, false, res.text);
    const running = json(res.text);
    assert.equal(running.status, "running");
    assert.match(running.job_id, /^start-\d+-[0-9a-z]+$/);
    assert.match(running.next, /emu_job/);

    const listed = json((await call("emu_job")).text);
    assert.ok(listed.jobs.some((j: { id: string }) => j.id === running.job_id));

    const done = await call("emu_job", { job_id: running.job_id, wait_sec: 60 });
    assert.equal(done.isError, false, done.text);
    const result = json(done.text);
    assert.equal(result.action, "new");
    assert.equal(result.serial, SERIAL);
    assert.equal(result.owner, ME);
    assert.equal(result.launched, false);
    assert.match(done.text, /EMULATOR_READY serial=emulator-5554/);
    assert.equal((await readLease(LEASE))!.owner, ME);

    // A finished job can be read again.
    const again = await call("emu_job", { job_id: running.job_id, wait_sec: 0 });
    assert.equal(json(again.text).serial, SERIAL);
  });

  test("a second device-changing job on the same AVD is refused while the first runs", async () => {
    fake.setRules(deviceRules({ devicesDelayMs: 1500 }));
    const first = json((await call("emu_start", { wait_sec: 0 })).text);
    assert.equal(first.status, "running");

    const smoke = await call("emu_smoke", { apk: "C:/does-not-exist/app.apk" });
    assert.equal(smoke.isError, true);
    assert.match(smoke.text, new RegExp(`^JOB_RUNNING: job ${first.job_id} \\(start\\) is still changing AVD 'unity-test'`));

    const second = await call("emu_start", { wait_sec: 0 });
    assert.equal(second.isError, true);
    assert.match(second.text, /JOB_RUNNING/);
    const clock = await call("emu_clock", { action: "reset" });
    assert.equal(clock.isError, true);
    assert.match(clock.text, /JOB_RUNNING/);
    const release = await call("emu_release");
    assert.equal(release.isError, true);
    assert.match(release.text, /JOB_RUNNING/);

    // Read-only tools still answer.
    const status = await call("emu_status");
    assert.equal(status.isError, false);

    const done = await call("emu_job", { job_id: first.job_id, wait_sec: 60 });
    assert.equal(done.isError, false, done.text);
    assert.equal(json(done.text).serial, SERIAL);

    // Free again once the job finished.
    fake.setRules(deviceRules());
    const after = await call("emu_release");
    assert.equal(after.isError, false, after.text);
    assert.equal(json(after.text).released, true);
  });

  test("JOB_RUNNING is an EmuError with that code", async () => {
    const reg = new JobRegistry();
    let release!: () => void;
    const id = reg.startJob("demo", () => new Promise<void>((r) => (release = r)), { avd: AVD });
    assert.throws(
      () => reg.assertFree(AVD),
      (e: unknown) => isEmuError(e, "JOB_RUNNING") && e.message.startsWith(`JOB_RUNNING: job ${id} (demo) is still changing AVD 'unity-test'`),
    );
    await assert.rejects(reg.runExclusive("other", AVD, async () => 1), (e: unknown) => isEmuError(e, "JOB_RUNNING"));
    release();
    await reg.waitJob(id, 5);
    assert.equal(await reg.runExclusive("other", AVD, async () => 7), 7);
    await assert.rejects(
      reg.runExclusive("other", AVD, async () => {
        throw new Error("inner");
      }),
      /inner/,
    );
  });

  test("JobRegistry keeps the last 400 lines and records errors with their code", async () => {
    const reg = new JobRegistry();
    const id = reg.startJob("demo", async (report) => {
      for (let i = 0; i < 450; i++) report(`line ${i}`);
      return { ok: true };
    });
    const v = await reg.waitJob(id, 5, { tail: 1000 });
    assert.equal(v.status, "done");
    assert.equal(v.lines.length, 400);
    assert.equal(v.lines[0], "line 50");
    assert.deepEqual(v.result, { ok: true });

    const bad = reg.startJob("demo", async () => {
      const { EmuError } = await import("../src/errors.ts");
      throw new EmuError("ADB_FAILED", "boom");
    });
    const f = await reg.waitJob(bad, 5);
    assert.equal(f.status, "failed");
    assert.equal(f.error, "ADB_FAILED: boom");
    assert.equal(f.error_code, "ADB_FAILED");
  });
});
