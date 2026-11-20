// Move the emulator wall clock so long-delay local notifications fire now, and put it back.
// Behavioural reference: scripts/time-travel.ps1.
//
// Unity Mobile Notifications schedules RTC_WAKEUP alarms; without exact scheduling Android (API 31+) may
// deliver them up to 1 hour after FireTime, so callers jump past FireTime + 1h (+ margin).
// Forward: `settings put global auto_time 0`, then set the time. Reset: set host time, then `auto_time 1`.
// A device left with auto_time 0 has a moved clock: resetClockIfShifted (start/release) restores it.
//
// This process remembers every clock it moved and has not put back yet, with the AVD, lease file and owner of that
// time travel (resetClock and resetClockIfShifted forget it, and so does a release of that AVD's lease). When the
// process is told to stop (MCP stdin closed, SIGINT, SIGTERM, Ctrl+C in the CLI), resetMovedClocks puts them back
// before it exits, so a smoke cut off mid-run (its finally never runs) does not leave the shared AVD ahead. It
// first checks that the serial still runs that AVD, that no other owner holds a valid lease on it and that
// auto_time is still 0; otherwise it skips that serial (CLOCK_RESET_SKIPPED), since the clock is someone else's now
// or was put back elsewhere.

import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Adb } from "./adb.ts";
import { EmuError } from "./errors.ts";
import { isLeaseValid, readLease, sameOwner, type LeaseReadTiming } from "./lease.ts";
import type { LeaseRecord, Report } from "./types.ts";

/** Waits, overridable by tests (not exposed in the CLI or MCP). */
export interface ClockTiming {
  /** Pause between setting the time and reading it back (default 1000 ms, like PS). */
  settleMs?: number;
  /** Poll interval while adbd restarts as root (default 1000 ms). */
  rootPollMs?: number;
  /** How long to wait for the device to answer after `adb root` (default 20000 ms). */
  rootWaitMs?: number;
}

/** Whose time travel it is: the shutdown reset checks the AVD and the lease against it. */
export interface ClockTarget {
  avd: string;
  leaseFile: string;
  owner: string;
}

export interface ClockOptions {
  timing?: ClockTiming;
  /** Host clock in epoch ms (tests). */
  now?: () => number;
  /**
   * The AVD, lease file and owner of this time travel. Without it the shutdown reset cannot check the device and
   * the lease, and skips the serial (CLOCK_RESET_SKIPPED reason=unknown-target).
   */
  target?: ClockTarget;
  /** Lease read retries of the shutdown check (tests). */
  leaseRead?: LeaseReadTiming;
}

const SET_TIME_FAILED = /Exception|denied|Unknown/;

interface MovedClock {
  adb: Adb;
  o: ClockOptions;
  target: ClockTarget | null;
}

// Clocks this process moved forward and has not reset yet, by serial.
const movedClocks = new Map<string, MovedClock>();
// Time travels still running (shutdown waits for them before it resets).
const pendingTravels = new Set<Promise<unknown>>();
let clockShutdown = false;

function clockKey(adb: Adb): string {
  return adb.serial ?? "(default device)";
}

/** Serials whose clock this process moved forward and has not put back yet. */
export function movedClockSerials(): string[] {
  return [...movedClocks.keys()];
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/**
 * This process gave the AVD's lease back (release): forget the clocks moved under it (release already put a moved
 * clock back; a later shutdown must not touch the AVD for the next holder). Returns the serials forgotten.
 */
export function forgetMovedClocks(o: { avd: string; leaseFile?: string }): string[] {
  const gone: string[] = [];
  for (const [serial, m] of [...movedClocks]) {
    if (!m.target || m.target.avd !== o.avd) continue;
    if (o.leaseFile !== undefined && !samePath(m.target.leaseFile, o.leaseFile)) continue;
    movedClocks.delete(serial);
    gone.push(serial);
  }
  return gone;
}

/** Why the shutdown must not reset this serial now, or null when it may. */
async function shutdownSkipReason(serial: string, m: MovedClock): Promise<{ reason: string; detail: string } | null> {
  if (!m.target) {
    return { reason: "unknown-target", detail: "the AVD and lease of this time travel are unknown, so the device is not checked" };
  }
  const dev = m.adb.serial;
  if (!dev) return { reason: "unknown-serial", detail: "the time travel did not name a device serial" };
  const running = await m.adb.avdName(dev);
  if (running !== m.target.avd) {
    return {
      reason: running ? "other-avd" : "avd-unknown",
      detail: running
        ? `${serial} now runs AVD '${running}', not '${m.target.avd}' whose clock was moved`
        : `${serial} does not answer with its AVD name (the emulator may be gone)`,
    };
  }
  let lease: LeaseRecord | null;
  try {
    lease = await readLease(m.target.leaseFile, m.o.leaseRead);
  } catch (err) {
    return { reason: "lease-unreadable", detail: (err as Error).message };
  }
  if (lease && isLeaseValid(lease) && !sameOwner(lease.owner, m.target.owner)) {
    return {
      reason: "leased-by-other",
      detail: `AVD '${m.target.avd}' is leased by ${lease.owner} (since ${lease.acquiredAt}) now; that session owns the clock`,
    };
  }
  const autoTime = (await m.adb.shell("settings", "get", "global", "auto_time")).trim();
  if (autoTime !== "0") {
    return { reason: "auto-time-on", detail: `auto_time is ${autoTime || "(empty)"}: the clock was already put back elsewhere` };
  }
  return null;
}

/** Tests: forget the moved clocks and leave shutdown mode. */
export function resetClockRegistry(): void {
  movedClocks.clear();
  pendingTravels.clear();
  clockShutdown = false;
}

/**
 * The process is stopping: refuse new time travel, wait (bounded) for one still running, then put back every clock
 * this process moved. Returns the serials it reset; a failure is reported (the next start/release resets it too).
 */
export async function resetMovedClocks(report: Report, o: { timeoutMs?: number } = {}): Promise<string[]> {
  clockShutdown = true;
  const deadline = Date.now() + (o.timeoutMs ?? 20_000);
  const remaining = (): number => Math.max(0, deadline - Date.now());
  const timeout = <T>(p: Promise<T>): Promise<T | "timeout"> => {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      p,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remaining());
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  };
  if (pendingTravels.size) await timeout(Promise.allSettled([...pendingTravels]));
  const done: string[] = [];
  for (const [serial, m] of [...movedClocks]) {
    try {
      const r = await timeout(
        (async (): Promise<"skipped" | "reset"> => {
          const skip = await shutdownSkipReason(serial, m);
          if (skip) {
            movedClocks.delete(serial);
            report(`CLOCK_RESET_SKIPPED serial=${serial} reason=${skip.reason}: ${skip.detail}`);
            return "skipped";
          }
          report(`CLOCK_RESET ${serial}: this process moved the device clock and is stopping; putting it back`);
          await resetClock(m.adb, report, m.o);
          return "reset";
        })(),
      );
      if (r === "skipped") continue;
      if (r === "timeout") {
        report(`CLOCK_RESET_FAILED ${serial}: no answer in time (the next emu-lab start or release resets it; or run emu-lab clock reset)`);
        continue;
      }
      done.push(serial);
    } catch (err) {
      report(`CLOCK_RESET_FAILED ${serial}: ${(err as Error).message} (the next emu-lab start or release resets it; or run emu-lab clock reset)`);
    }
  }
  return done;
}

function refuseWhenStopping(): void {
  if (clockShutdown) {
    throw new EmuError("CLOCK_FAILED", "Not moving the device clock: this process is stopping (its moved clocks are being put back).");
  }
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** yyyy-MM-dd HH:mm:ss in the host's local time zone (the PS report format). */
export function formatLocalClock(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** MMddHHmmyyyy.ss in UTC: the argument of toybox `date -u`. */
export function formatToyboxDate(ms: number): string {
  const d = new Date(ms);
  return (
    `${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}` +
    `${d.getUTCFullYear()}.${pad(d.getUTCSeconds())}`
  );
}

async function deviceEpochMs(adb: Adb, what: string): Promise<number> {
  const ms = await adb.epochMs();
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new EmuError("CLOCK_FAILED", `Cannot read the device clock ${what} (${adb.serial ?? "default device"}).`);
  }
  return ms;
}

/**
 * Sets the device wall clock. `cmd alarm set-time` first; when the shell user may not do that, restart adbd as
 * root and use toybox `date -u` (google_apis images allow adb root), advancing the target by the time waited.
 */
async function setDeviceTimeMs(adb: Adb, ms: number, o: ClockOptions): Promise<void> {
  const now = o.now ?? Date.now;
  const started = now();
  const out = await adb.shell("cmd", "alarm", "set-time", String(Math.round(ms)));
  if (!SET_TIME_FAILED.test(out)) return;

  // adbd restarts as root, so wait until the device answers again (a fixed 2 s was not always enough).
  await adb.run(["root"]);
  const pollMs = o.timing?.rootPollMs ?? 1000;
  const deadline = now() + (o.timing?.rootWaitMs ?? 20000);
  let alive = false;
  do {
    await delay(pollMs);
    try {
      alive = (await adb.shell("echo", "ok")).trim() === "ok";
    } catch (err) {
      if (err instanceof EmuError && err.code === "NO_ADB") throw err;
      alive = false;
    }
  } while (!alive && now() < deadline);
  if (!alive) throw new EmuError("CLOCK_FAILED", `Device ${adb.serial ?? "(default)"} did not come back after adb root.`);

  // Keep the target moving with real time while we waited.
  await adb.shell("date", "-u", formatToyboxDate(ms + (now() - started)));
}

async function settleAndReport(adb: Adb, beforeMs: number, report: Report, o: ClockOptions): Promise<{ afterMs: number; deltaMin: number }> {
  await delay(o.timing?.settleMs ?? 1000);
  const afterMs = await deviceEpochMs(adb, "after setting it");
  const deltaMin = Math.round((afterMs - beforeMs) / 6000) / 10;
  report(`TIME_TRAVEL before=${formatLocalClock(beforeMs)} after=${formatLocalClock(afterMs)} delta_min=${deltaMin.toFixed(1)}`);
  return { afterMs, deltaMin };
}

/**
 * Turns automatic time off and moves the device clock `minutes` forward. The caller must call resetClock
 * afterwards, also after a failed check (the AVD otherwise keeps the moved clock; the next start/release
 * resets it too). Throws CLOCK_FAILED when the clock could not be set or did not move.
 */
export async function timeTravel(
  adb: Adb,
  minutes: number,
  report: Report,
  o: ClockOptions = {},
): Promise<{ beforeMs: number; afterMs: number; deltaMin: number }> {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new EmuError("BAD_OPTION", `Time travel needs minutes > 0 (got ${minutes}). To go back use the clock reset.`);
  }
  refuseWhenStopping();
  const run = (async () => {
    const beforeMs = await deviceEpochMs(adb, "before time travel");
    refuseWhenStopping();
    // From here on the clock may be moved: remember it (and whose it is) for the reset on shutdown.
    movedClocks.set(clockKey(adb), { adb, o, target: o.target ?? null });
    await adb.shell("settings", "put", "global", "auto_time", "0");
    const targetMs = beforeMs + Math.round(minutes * 60_000);
    refuseWhenStopping();
    await setDeviceTimeMs(adb, targetMs, o);
    const { afterMs, deltaMin } = await settleAndReport(adb, beforeMs, report, o);
    // Allow for the seconds resolution of `date` and slow adb round trips, but not for a clock that stayed put.
    if (afterMs < targetMs - 60_000) {
      throw new EmuError(
        "CLOCK_FAILED",
        `The device clock did not move forward ${minutes} min (delta_min=${deltaMin.toFixed(1)}). Reset it with emu-lab clock reset.`,
      );
    }
    return { beforeMs, afterMs, deltaMin };
  })();
  pendingTravels.add(run);
  try {
    return await run;
  } finally {
    pendingTravels.delete(run);
  }
}

/**
 * Sets the device clock to host time and turns automatic time back on (safe to run again). The serial leaves the
 * shutdown registry: this process put it back.
 */
export async function resetClock(adb: Adb, report: Report, o: ClockOptions = {}): Promise<{ beforeMs: number; afterMs: number }> {
  const now = o.now ?? Date.now;
  const beforeMs = await deviceEpochMs(adb, "before the reset");
  await setDeviceTimeMs(adb, now(), o);
  await adb.shell("settings", "put", "global", "auto_time", "1");
  movedClocks.delete(clockKey(adb));
  const { afterMs } = await settleAndReport(adb, beforeMs, report, o);
  return { beforeMs, afterMs };
}

/**
 * A run killed during time travel leaves the clock ahead with auto_time 0. When auto_time is "0", reports
 * TIME_RESET and restores the clock; returns whether it did.
 */
export async function resetClockIfShifted(adb: Adb, report: Report, o: ClockOptions = {}): Promise<boolean> {
  const autoTime = (await adb.shell("settings", "get", "global", "auto_time")).trim();
  if (autoTime !== "0") return false;
  report("TIME_RESET auto_time was 0 (an earlier time travel did not finish): restoring the device clock");
  await resetClock(adb, report, o);
  return true;
}
