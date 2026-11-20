// clock.ts against the fake adb (no real device).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  forgetMovedClocks,
  formatLocalClock,
  formatToyboxDate,
  movedClockSerials,
  resetMovedClocks,
  resetClock,
  resetClockIfShifted,
  resetClockRegistry,
  timeTravel,
  type ClockTarget,
} from "../src/clock.ts";
import { makeShutdown } from "../src/server.ts";
import { isEmuError } from "../src/errors.ts";
import { formatLocalIso, writeLease } from "../src/lease.ts";
import { makeFakeAdb, tempLabHome, type FakeRule } from "./helpers/fake.ts";

const SERIAL = "emulator-5554";
const BEFORE = 1_763_600_000_000; // 2025-11-20T00:53:20Z
const FAST = { timing: { settleMs: 0, rootPollMs: 10, rootWaitMs: 5000 } };

function collect(): { report: (l: string) => void; out: string[] } {
  const out: string[] = [];
  return { report: (l: string) => out.push(l), out };
}

/** Device clock answers: `before` first, then `after` for every later read. */
function clockRules(before: number, after: number, extra: FakeRule[] = []): FakeRule[] {
  return [
    ...extra,
    { match: "^shell date \\+%s%3N$", stdout: `${before}\n`, times: 1 },
    { match: "^shell date \\+%s%3N$", stdout: `${after}\n` },
  ];
}

const AVD = "unity-test";
const ME = "test:me";

/** Whose time travel it is, with a lease file in a fresh temp home (no lease written yet). */
function targetOf(owner = ME): ClockTarget {
  return { avd: AVD, leaseFile: join(tempLabHome(), "leases", `${AVD}.json`), owner };
}

/** What the shutdown check reads: the AVD on the serial and auto_time (put them before the clock rules). */
function shutdownChecks(o: { avd?: string; autoTime?: string } = {}): FakeRule[] {
  return [
    { match: "^emu avd name$", stdout: `${o.avd ?? AVD}\r\nOK\r\n` },
    { match: "^shell settings get global auto_time$", stdout: `${o.autoTime ?? "0"}\n` },
  ];
}

async function putLease(file: string, owner: string, o: { validMs?: number; acquiredAt?: Date } = {}): Promise<void> {
  const now = Date.now();
  await writeLease(
    file,
    {
      avd: AVD,
      owner,
      host: "pc",
      acquiredAt: formatLocalIso(o.acquiredAt ?? new Date(now - 60_000)),
      expiresAt: formatLocalIso(new Date(now + (o.validMs ?? 3_600_000))),
      startedEmulator: false,
      emulatorPid: null,
      emulatorStartedAt: null,
      installed: [],
    },
    { create: true },
  );
}

const SHUTDOWN_FAST = { ...FAST, leaseRead: { attempts: 1, intervalMs: 0 } };

/** MMddHHmmyyyy.ss (UTC) back to epoch ms. */
function parseToybox(s: string): number {
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{4})\.(\d{2})$/.exec(s);
  assert.ok(m, `bad date argument ${s}`);
  return Date.UTC(Number(m[5]), Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[6]));
}

describe("clock", { concurrency: 4 }, () => {
  test("formatToyboxDate is UTC MMddHHmmyyyy.ss", () => {
    assert.equal(formatToyboxDate(Date.UTC(2026, 10, 20, 1, 2, 3)), "112001022026.03");
    assert.equal(parseToybox(formatToyboxDate(BEFORE)), Math.floor(BEFORE / 1000) * 1000);
    assert.match(formatLocalClock(BEFORE), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("forward: auto_time 0, then cmd alarm set-time before+minutes", async () => {
    const target = BEFORE + 90 * 60_000;
    const fake = makeFakeAdb(clockRules(BEFORE, target), { serial: SERIAL });
    const { report, out } = collect();
    const r = await timeTravel(fake.adb, 90, report, FAST);
    assert.equal(r.beforeMs, BEFORE);
    assert.equal(r.afterMs, target);
    assert.equal(r.deltaMin, 90);
    const cmds = fake.commands();
    const autoOff = cmds.indexOf("shell settings put global auto_time 0");
    const setTime = cmds.indexOf(`shell cmd alarm set-time ${target}`);
    assert.ok(autoOff >= 0, "auto_time 0");
    assert.ok(setTime > autoOff, "set-time after auto_time 0");
    assert.equal(cmds.includes("root"), false);
    for (const args of fake.calls()) assert.deepEqual(args.slice(0, 2), ["-s", SERIAL]);
    assert.deepEqual(out, [`TIME_TRAVEL before=${formatLocalClock(BEFORE)} after=${formatLocalClock(target)} delta_min=90.0`]);
  });

  test("forward falls back to adb root + date -u when set-time prints an Exception", async () => {
    const target = BEFORE + 60 * 60_000;
    const fake = makeFakeAdb(
      clockRules(BEFORE, target + 1000, [
        { match: "^shell cmd alarm set-time ", stdout: "Exception occurred while executing 'set-time':\njava.lang.SecurityException: Permission Denial\n" },
        { match: "^root$", stdout: "restarting adbd as root\n" },
        { match: "^shell echo ok$", stdout: "", times: 2 },
        { match: "^shell echo ok$", stdout: "ok\n" },
      ]),
      { serial: SERIAL },
    );
    const { report } = collect();
    const r = await timeTravel(fake.adb, 60, report, FAST);
    assert.equal(r.afterMs, target + 1000);
    const cmds = fake.commands();
    const root = cmds.indexOf("root");
    const dateCmd = cmds.find((c) => c.startsWith("shell date -u "));
    assert.ok(root > cmds.findIndex((c) => c.startsWith("shell cmd alarm set-time")));
    assert.equal(cmds.filter((c) => c === "shell echo ok").length, 3);
    assert.ok(dateCmd, "date -u issued");
    assert.ok(cmds.indexOf(dateCmd) > root);
    const set = parseToybox(dateCmd.slice("shell date -u ".length));
    // The target advanced by the time spent waiting for adbd (seconds resolution).
    assert.ok(set >= target - 1000 && set <= target + 10_000, `date -u ${set} vs target ${target}`);
  });

  test("CLOCK_FAILED when adbd does not come back after adb root", async () => {
    const fake = makeFakeAdb(
      clockRules(BEFORE, BEFORE, [
        { match: "^shell cmd alarm set-time ", stdout: "Unknown command: set-time\n" },
        { match: "^shell echo ok$", stdout: "error: device offline\n" },
      ]),
      { serial: SERIAL },
    );
    await assert.rejects(timeTravel(fake.adb, 30, () => {}, { timing: { settleMs: 0, rootPollMs: 10, rootWaitMs: 300 } }), (e: unknown) => isEmuError(e, "CLOCK_FAILED"));
    assert.equal(fake.commands().some((c) => c.startsWith("shell date -u")), false);
  });

  test("CLOCK_FAILED when the clock did not move", async () => {
    const fake = makeFakeAdb(clockRules(BEFORE, BEFORE + 1000), { serial: SERIAL });
    await assert.rejects(timeTravel(fake.adb, 120, () => {}, FAST), (e: unknown) => isEmuError(e, "CLOCK_FAILED"));
  });

  test("minutes <= 0 is BAD_OPTION without any adb call", async () => {
    const fake = makeFakeAdb([], { serial: SERIAL });
    await assert.rejects(timeTravel(fake.adb, 0, () => {}, FAST), (e: unknown) => isEmuError(e, "BAD_OPTION"));
    await assert.rejects(timeTravel(fake.adb, -5, () => {}, FAST), (e: unknown) => isEmuError(e, "BAD_OPTION"));
    assert.deepEqual(fake.calls(), []);
  });

  test("reset: host time first, then auto_time 1", async () => {
    const host = BEFORE - 3 * 3_600_000;
    const fake = makeFakeAdb(clockRules(BEFORE, host), { serial: SERIAL });
    const { report, out } = collect();
    const r = await resetClock(fake.adb, report, { ...FAST, now: () => host });
    assert.equal(r.beforeMs, BEFORE);
    assert.equal(r.afterMs, host);
    const cmds = fake.commands();
    const setTime = cmds.indexOf(`shell cmd alarm set-time ${host}`);
    const autoOn = cmds.indexOf("shell settings put global auto_time 1");
    assert.ok(setTime >= 0 && autoOn > setTime);
    assert.equal(cmds.includes("shell settings put global auto_time 0"), false);
    assert.equal(out.length, 1);
    assert.match(out[0], /^TIME_TRAVEL before=.* after=.* delta_min=-180\.0$/);
  });

  test("resetClockIfShifted does nothing while auto_time is 1", async () => {
    const fake = makeFakeAdb([{ match: "^shell settings get global auto_time$", stdout: "1\r\n" }], { serial: SERIAL });
    const { report, out } = collect();
    assert.equal(await resetClockIfShifted(fake.adb, report, FAST), false);
    assert.deepEqual(fake.commands(), ["shell settings get global auto_time"]);
    assert.deepEqual(out, []);
  });

  test("resetClockIfShifted restores the clock when auto_time is 0", async () => {
    const fake = makeFakeAdb(
      clockRules(BEFORE, BEFORE - 3_600_000, [{ match: "^shell settings get global auto_time$", stdout: "0\n" }]),
      { serial: SERIAL },
    );
    const { report, out } = collect();
    assert.equal(await resetClockIfShifted(fake.adb, report, { ...FAST, now: () => BEFORE - 3_600_000 }), true);
    assert.match(out[0], /^TIME_RESET /);
    assert.match(out[1], /^TIME_TRAVEL /);
    const cmds = fake.commands();
    assert.ok(cmds.includes(`shell cmd alarm set-time ${BEFORE - 3_600_000}`));
    assert.ok(cmds.includes("shell settings put global auto_time 1"));
  });
});

// Shutdown: these tests change the process-wide clock registry, so they run one after another (after the suite above).
describe("shutdown puts back the clocks this process moved", () => {
  test("timeTravel remembers the serial, resetClock forgets it", async () => {
    resetClockRegistry();
    const target = BEFORE + 30 * 60_000;
    const fake = makeFakeAdb(clockRules(BEFORE, target), { serial: SERIAL });
    await timeTravel(fake.adb, 30, () => {}, FAST);
    assert.deepEqual(movedClockSerials(), [SERIAL]);
    await resetClock(fake.adb, () => {}, FAST);
    assert.deepEqual(movedClockSerials(), []);
  });

  test("a failed time travel after auto_time 0 is remembered too", async () => {
    resetClockRegistry();
    const fake = makeFakeAdb(clockRules(BEFORE, BEFORE), { serial: SERIAL }); // the clock never moves
    await assert.rejects(timeTravel(fake.adb, 30, () => {}, FAST), (e: unknown) => isEmuError(e, "CLOCK_FAILED"));
    assert.deepEqual(movedClockSerials(), [SERIAL]);
    resetClockRegistry();
  });

  test("makeShutdown (MCP stdin closed, SIGTERM, Ctrl+C): resets the moved clock, then exits; later time travel is refused", async () => {
    resetClockRegistry();
    const target = BEFORE + 70 * 60_000;
    const fake = makeFakeAdb(clockRules(BEFORE, target, shutdownChecks()), { serial: SERIAL });
    const t = targetOf();
    await putLease(t.leaseFile, ME); // our own valid lease: the reset goes ahead
    await timeTravel(fake.adb, 70, () => {}, { ...SHUTDOWN_FAST, target: t }); // a smoke job moved the clock and is still waiting
    const log: string[] = [];
    const exits: number[] = [];
    let closed = false;
    const shutdown = makeShutdown({
      close: async () => {
        closed = true;
      },
      exit: (code) => exits.push(code),
      log: (l) => log.push(l),
    });
    const from = fake.commands().length;
    await shutdown("stdin ended");
    await shutdown("stdin closed"); // a second call does nothing more
    assert.equal(closed, true);
    assert.deepEqual(exits, [0]);
    const after = fake.commands().slice(from);
    const setTime = after.findIndex((c) => c.startsWith("shell cmd alarm set-time"));
    const autoOn = after.indexOf("shell settings put global auto_time 1");
    assert.ok(setTime >= 0 && autoOn > setTime, after.join("\n"));
    assert.deepEqual(movedClockSerials(), []);
    assert.ok(log.some((l) => l.includes("shutting down (stdin ended)")));
    assert.ok(log.some((l) => l.includes(`CLOCK_RESET ${SERIAL}`)));
    await assert.rejects(timeTravel(fake.adb, 10, () => {}, FAST), (e: unknown) => isEmuError(e, "CLOCK_FAILED") && /stopping/.test((e as Error).message));
    resetClockRegistry();
  });

  test("a time travel still running when the shutdown starts is waited for, then reset", async () => {
    resetClockRegistry();
    const target = BEFORE + 90 * 60_000;
    // set-time of the forward answers slowly: the shutdown starts in the middle of it.
    const fake = makeFakeAdb(
      clockRules(BEFORE, target, [{ match: "^shell cmd alarm set-time", delayMs: 400, times: 1 }, ...shutdownChecks()]),
      { serial: SERIAL },
    );
    const travel = timeTravel(fake.adb, 90, () => {}, { ...SHUTDOWN_FAST, target: targetOf() }); // no lease file: fine
    while (!fake.commands().some((c) => c.startsWith("shell cmd alarm set-time"))) await new Promise((r) => setTimeout(r, 10));
    const exits: number[] = [];
    await makeShutdown({ exit: (code) => exits.push(code), log: () => {}, code: 130 })("SIGINT");
    await travel;
    assert.deepEqual(exits, [130]);
    const cmds = fake.commands();
    // The reset's set-time comes after the forward's, and auto_time 1 is the last setting.
    assert.equal(cmds.filter((c) => c.startsWith("shell cmd alarm set-time")).length, 2);
    assert.equal(cmds.filter((c) => c.startsWith("shell settings put")).at(-1), "shell settings put global auto_time 1");
    assert.deepEqual(movedClockSerials(), []);
    resetClockRegistry();
  });

  /** A forward that succeeded, then a shutdown reset with these device answers; returns what it did. */
  async function shutdownAfterForward(o: { checks: FakeRule[]; t?: ClockTarget | null; before?: (t: ClockTarget) => Promise<void> }) {
    resetClockRegistry();
    const forwarded = BEFORE + 60 * 60_000;
    const fake = makeFakeAdb(clockRules(BEFORE, forwarded, o.checks), { serial: SERIAL });
    const t = o.t === undefined ? targetOf() : o.t;
    await timeTravel(fake.adb, 60, () => {}, t ? { ...SHUTDOWN_FAST, target: t } : SHUTDOWN_FAST);
    assert.deepEqual(movedClockSerials(), [SERIAL]);
    if (t && o.before) await o.before(t);
    const from = fake.commands().length;
    const { report, out } = collect();
    const done = await resetMovedClocks(report, { timeoutMs: 5000 });
    const after = fake.commands().slice(from);
    const left = movedClockSerials();
    resetClockRegistry();
    return { done, after, out, left };
  }

  const changed = (cmds: string[]) => cmds.filter((c) => /^shell (cmd alarm set-time|settings put|date -u)|^root$/.test(c));

  test("shutdown skips a serial that now runs another AVD (CLOCK_RESET_SKIPPED reason=other-avd)", async () => {
    const r = await shutdownAfterForward({ checks: shutdownChecks({ avd: "personal" }) });
    assert.deepEqual(r.done, []);
    assert.deepEqual(changed(r.after), [], r.after.join("\n"));
    assert.ok(r.out.some((l) => l.startsWith(`CLOCK_RESET_SKIPPED serial=${SERIAL} reason=other-avd`)), r.out.join("\n"));
    assert.ok(!r.out.some((l) => l.startsWith("CLOCK_RESET ")));
    assert.deepEqual(r.left, []);
  });

  test("shutdown skips when another owner took the AVD over (our lease ran out): reason=leased-by-other", async () => {
    const r = await shutdownAfterForward({
      checks: shutdownChecks(),
      // Ours ran out, B took it over (B's start reset the clock and B may be time-travelling now).
      before: (t) => putLease(t.leaseFile, "codex:other1"),
    });
    assert.deepEqual(r.done, []);
    assert.deepEqual(changed(r.after), [], r.after.join("\n"));
    assert.ok(r.out.some((l) => l.startsWith(`CLOCK_RESET_SKIPPED serial=${SERIAL} reason=leased-by-other`) && l.includes("codex:other1")), r.out.join("\n"));
    assert.deepEqual(r.left, []);
  });

  test("shutdown skips when auto_time is already 1 (the clock was put back elsewhere): reason=auto-time-on", async () => {
    const r = await shutdownAfterForward({ checks: shutdownChecks({ autoTime: "1" }) });
    assert.deepEqual(r.done, []);
    assert.deepEqual(changed(r.after), [], r.after.join("\n"));
    assert.ok(r.out.some((l) => l.startsWith(`CLOCK_RESET_SKIPPED serial=${SERIAL} reason=auto-time-on`)), r.out.join("\n"));
    assert.deepEqual(r.left, []);
  });

  test("shutdown without a target (AVD and lease unknown) does not touch the device: reason=unknown-target", async () => {
    const r = await shutdownAfterForward({ checks: shutdownChecks(), t: null });
    assert.deepEqual(r.done, []);
    assert.deepEqual(r.after, [], r.after.join("\n"));
    assert.ok(r.out.some((l) => l.startsWith(`CLOCK_RESET_SKIPPED serial=${SERIAL} reason=unknown-target`)), r.out.join("\n"));
  });

  test("shutdown resets under our own lease (owner ignoring case) and under an expired lease of another owner", async () => {
    for (const before of [
      (t: ClockTarget) => putLease(t.leaseFile, ME.toUpperCase()),
      (t: ClockTarget) => putLease(t.leaseFile, "codex:other1", { validMs: -60_000 }),
    ]) {
      const r = await shutdownAfterForward({ checks: shutdownChecks(), before });
      assert.deepEqual(r.done, [SERIAL], r.out.join("\n"));
      const setTime = r.after.findIndex((c) => c.startsWith("shell cmd alarm set-time"));
      const autoOn = r.after.indexOf("shell settings put global auto_time 1");
      assert.ok(setTime >= 0 && autoOn > setTime, r.after.join("\n"));
      // The checks ran before anything changed.
      assert.ok(r.after.indexOf("emu avd name") < setTime && r.after.indexOf("shell settings get global auto_time") < setTime);
      assert.ok(r.out.some((l) => l.startsWith(`CLOCK_RESET ${SERIAL}`)));
      assert.deepEqual(r.left, []);
    }
  });

  test("forgetMovedClocks (release of that AVD's lease) and resetClockIfShifted forget the serial", async () => {
    resetClockRegistry();
    const fake = makeFakeAdb(clockRules(BEFORE, BEFORE + 60 * 60_000, shutdownChecks()), { serial: SERIAL });
    const t = targetOf();
    await timeTravel(fake.adb, 60, () => {}, { ...FAST, target: t });
    assert.deepEqual(forgetMovedClocks({ avd: "another-avd" }), []);
    assert.deepEqual(forgetMovedClocks({ avd: AVD, leaseFile: join(tempLabHome(), "leases", `${AVD}.json`) }), []);
    assert.deepEqual(movedClockSerials(), [SERIAL]);
    assert.deepEqual(forgetMovedClocks({ avd: AVD, leaseFile: t.leaseFile }), [SERIAL]);
    assert.deepEqual(movedClockSerials(), []);

    fake.setRules(clockRules(BEFORE, BEFORE + 60 * 60_000, shutdownChecks()));
    await timeTravel(fake.adb, 60, () => {}, { ...FAST, target: t });
    assert.deepEqual(movedClockSerials(), [SERIAL]);
    assert.equal(await resetClockIfShifted(fake.adb, () => {}, FAST), true); // auto_time answers 0
    assert.deepEqual(movedClockSerials(), []);
    resetClockRegistry();
  });

  test("nothing moved: shutdown exits without touching any device", async () => {
    resetClockRegistry();
    const exits: number[] = [];
    await makeShutdown({ exit: (code) => exits.push(code), log: () => {} })("SIGTERM");
    assert.deepEqual(exits, [0]);
    resetClockRegistry();
  });
});
