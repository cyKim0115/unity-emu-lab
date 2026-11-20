// Take, boot, renew and give back the test AVD. Behavioural reference: scripts/start-emulator.ps1 and
// scripts/release-emulator.ps1.
//
// - The lease comes first: while another session holds the AVD nothing else runs (no adb server start, no boot,
//   no settings). BUSY is thrown by enterLease before any adb call.
// - Only the target AVD is ever touched. Another AVD's emulator (a personal Android Studio AVD) makes start refuse
//   (OTHER_EMULATOR) and is never changed.
// - release stops an emulator only when this lease launched it and the recorded pid + process name + start time
//   still match; never by pid, only with `adb -s <serial> emu kill`.
// - status changes nothing (no lease write, no device-changing adb call).

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Adb } from "./adb.ts";
import { forgetMovedClocks, resetClockIfShifted, type ClockTiming } from "./clock.ts";
import { androidEnv, resolveLocations, type Locations } from "./config.ts";
import { EmuError, isEmuError } from "./errors.ts";
import {
  assertSameLease,
  enterLease,
  formatLocalIso,
  giveBackHold,
  holdLease,
  isLeaseValid,
  leasePath,
  parseLeaseDate,
  readLease,
  removeLeaseIfSame,
  renewLease,
  sameOwner,
  updateLease,
} from "./lease.ts";
import { getOwner, hostName } from "./owner.ts";
import {
  findProcesses as realFindProcesses,
  getProcessInfo as realGetProcessInfo,
  sleep,
  spawnDetached as realSpawnDetached,
  type ProcInfo,
} from "./proc.ts";
import type { LeaseRecord, Report } from "./types.ts";

/** Waits and polls; tests shorten them (internal, not exposed in the CLI or MCP). */
export interface EmulatorTiming {
  /** How long to wait for a running qemu process to re-attach to the adb server (PS: 30 s). */
  reattachWaitMs: number;
  /** How long to wait for emulator/qemu processes left by a previous `emu kill` (PS: 60 s). */
  lingerWaitMs: number;
  lingerPollMs: number;
  /** Pause after the launch before checking that the launcher is still alive (PS: 5 s). */
  launchCheckMs: number;
  /** Poll interval while waiting for the serial and sys.boot_completed (PS: 2 s). */
  bootPollMs: number;
  /** How long release looks for the AVD in adb devices (PS: 10 s). */
  releaseFindWaitMs: number;
  /** How long release waits for the stopped emulator process to exit (PS: 90 s). */
  stopWaitMs: number;
  stopPollMs: number;
  /** Passed to the clock reset (resetClockIfShifted). */
  clock?: ClockTiming;
}

/** While release runs, the lease it gives back is kept valid at least this long, so no session takes it over midway. */
export const RELEASE_HOLD_MS = 15 * 60_000;

export const DEFAULT_EMULATOR_TIMING: EmulatorTiming = {
  reattachWaitMs: 30_000,
  lingerWaitMs: 60_000,
  lingerPollMs: 2_000,
  launchCheckMs: 5_000,
  bootPollMs: 2_000,
  releaseFindWaitMs: 10_000,
  stopWaitMs: 90_000,
  stopPollMs: 2_000,
};

/** Injection points for tests (a fake adb, no real processes). */
export interface EmulatorDeps {
  adbFactory?: (loc: Locations, env: NodeJS.ProcessEnv) => Adb;
  spawnDetached?: typeof realSpawnDetached;
  findProcesses?: (name: RegExp) => Promise<ProcInfo[]>;
  getProcessInfo?: (pid: number) => Promise<ProcInfo | null>;
  timing?: Partial<EmulatorTiming>;
}

export interface StartOptions {
  avd?: string;
  owner?: string;
  /** Lease length in hours (default 4). */
  hours?: number;
  headless?: boolean;
  coldBoot?: boolean;
  /** Device audio stays off unless this is true. */
  audio?: boolean;
  /** Time for the emulator to show up and finish booting (default 300 s). */
  bootTimeoutSec?: number;
  env?: NodeJS.ProcessEnv;
  report: Report;
  deps?: EmulatorDeps;
}

export interface StartResult {
  action: "new" | "renewed" | "takeover";
  avd: string;
  owner: string;
  serial: string;
  /** true when this call launched the emulator (false: it was already running). */
  launched: boolean;
  expiresAt: string;
  leaseFile: string;
  android: string;
  abilist: string;
  nativeBridge: string;
}

export interface ReleaseOptions {
  avd?: string;
  owner?: string;
  /** Uninstall the apps installed under this lease (or `packages`). */
  uninstall?: boolean;
  /** Uninstall these instead of the recorded ones (needs uninstall). */
  packages?: string[];
  /** Leave the emulator up even if this lease started it. */
  keepRunning?: boolean;
  /** The person only: release someone else's lease (same steps). */
  anyOwner?: boolean;
  /** The person only: drop a lease that ran out; the device is not touched. */
  stale?: boolean;
  env?: NodeJS.ProcessEnv;
  report: Report;
  deps?: EmulatorDeps;
}

export interface ReleaseResult {
  released: boolean;
  avd: string;
  /** Owner written in the lease (null: there was none). */
  leaseOwner: string | null;
  /** Who released it. */
  by: string;
  uninstalled: string[];
  /** Apps recorded under the lease that stay installed (with their data). */
  kept: string[];
  stopped: "stopped" | "pending" | "kept" | "not-running" | "not-ours" | "none";
  /** Device state reset on the way out: property names and "clock". */
  resets: string[];
}

export interface StatusResult {
  avd: string;
  owner: string;
  lease: (LeaseRecord & { valid: boolean; mine: boolean }) | null;
  leaseFile: string;
  emulators: { serial: string; avd: string | null }[];
  serial: string | null;
  bootCompleted: boolean | null;
  paths: Locations;
  adbVersion: string | null;
}

const DEFAULT_HOURS = 4;
const DEFAULT_BOOT_TIMEOUT_SEC = 300;
const QEMU_RE = /^qemu-system/i;
const EMULATOR_PROC_RE = /^(qemu-system|emulator)/i;
const SAME_START_MS = 2_000;

interface Resolved {
  env: NodeJS.ProcessEnv;
  loc: Locations;
  avd: string;
  owner: string;
  leaseFile: string;
}

function resolve(o: { avd?: string; owner?: string; env?: NodeJS.ProcessEnv }): Resolved {
  const env = o.env ?? process.env;
  const loc = resolveLocations({ env });
  const avd = (o.avd ?? "").trim() || loc.avd;
  const owner = (o.owner ?? "").trim() || getOwner(env);
  return { env, loc, avd, owner, leaseFile: leasePath(loc, avd) };
}

function timingOf(deps?: EmulatorDeps): EmulatorTiming {
  return { ...DEFAULT_EMULATOR_TIMING, ...(deps?.timing ?? {}) };
}

/** The adb client (no serial bound): the injected one, else the resolved executable, which must exist. */
function makeAdb(r: Resolved, report: Report, deps?: EmulatorDeps): Adb {
  if (deps?.adbFactory) return deps.adbFactory(r.loc, r.env);
  if (!existsSync(r.loc.adb)) {
    throw new EmuError(
      "NO_ADB",
      `adb not found at ${r.loc.adb} (from ${r.loc.adbSource}). Install the Android SDK platform-tools there, or point EMU_ADB ` +
        `(or "adb" in ${r.loc.configPath}) at an adb executable (emu-lab status shows the paths).`,
    );
  }
  return new Adb({ exe: r.loc.adb, env: androidEnv(r.loc, r.env), report });
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function assertNoOtherEmulator(adb: Adb, avd: string): Promise<void> {
  const others = (await adb.runningEmulators()).filter((e) => e.avd !== avd);
  if (!others.length) return;
  const list = others.map((e) => `${e.serial}=${e.avd ?? "?"}`).join(", ");
  throw new EmuError(
    "OTHER_EMULATOR",
    `Other emulator(s) running: ${list}. emu-lab only touches AVD '${avd}' and will not change them. ` +
      "Close them (Android Studio > Device Manager > Stop) and run again.",
  );
}

/**
 * Take (or renew) the lease, boot the AVD (or reuse it when it runs) and make it predictable for automation.
 * Another owner's valid lease throws BUSY before anything else runs.
 */
export async function startEmulator(o: StartOptions): Promise<StartResult> {
  const report = o.report;
  const hours = o.hours ?? DEFAULT_HOURS;
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new EmuError("BAD_OPTION", `hours must be more than 0 (got ${hours}).`);
  }
  const bootTimeoutSec = o.bootTimeoutSec ?? DEFAULT_BOOT_TIMEOUT_SEC;
  if (!Number.isFinite(bootTimeoutSec) || bootTimeoutSec <= 0) {
    throw new EmuError("BAD_OPTION", `boot timeout must be more than 0 seconds (got ${bootTimeoutSec}).`);
  }
  const r = resolve(o);
  const { loc, avd, owner, leaseFile } = r;
  const timing = timingOf(o.deps);
  const spawn = o.deps?.spawnDetached ?? realSpawnDetached;
  const findProcs = o.deps?.findProcesses ?? realFindProcesses;
  const procInfo = o.deps?.getProcessInfo ?? realGetProcessInfo;

  // Lease first: while another session holds the device, change nothing.
  const take = await enterLease({ path: leaseFile, avd, owner, hours, host: hostName(r.env), report });
  report(`LEASE ${take.action} avd=${avd} owner=${owner} until=${take.lease.expiresAt} file=${leaseFile}`);
  let launched = false;

  try {
    const adb = makeAdb(r, report, o.deps);
    await adb.ensureServer();

    // Only AVD `avd` is ever touched; another emulator is left alone and stops this call.
    await assertNoOtherEmulator(adb, avd);

    // An emulator process already up may need a moment to re-attach to a freshly started adb server: wait for it
    // instead of launching a second instance of the same AVD.
    let serial = await adb.findSerial(avd, 0);
    if (!serial && (await findProcs(QEMU_RE)).length > 0) {
      serial = await adb.findSerial(avd, timing.reattachWaitMs / 1000);
      if (!serial) await assertNoOtherEmulator(adb, avd);
    }

    let launcher: ReturnType<typeof realSpawnDetached> | null = null;
    if (serial) {
      const how = take.lease.startedEmulator ? "started under this lease" : "it stays running after emu-lab release";
      report(`Emulator already running: ${serial} (${how})`);
    } else {
      if (!existsSync(loc.emulator)) {
        throw new EmuError(
          "NO_EMULATOR_EXE",
          `No emulator at ${loc.emulator} (SDK root from ${loc.sdkRootSource}). Install the Android SDK emulator package, ` +
            `or point ANDROID_SDK_ROOT (or "sdkRoot" in ${loc.configPath}) at the SDK.`,
        );
      }
      const avdIni = path.join(loc.avdHome, `${avd}.ini`);
      if (!existsSync(avdIni)) {
        throw new EmuError(
          "NO_AVD",
          `AVD '${avd}' not found: no ${avdIni} (AVD home from ${loc.avdHomeSource}). Create the AVD, or point ANDROID_AVD_HOME ` +
            `(or "avdHome" in ${loc.configPath}) at the folder that holds it.`,
        );
      }
      const args = ["-avd", avd, "-no-boot-anim", "-gpu", "host"];
      if (!o.audio) args.push("-no-audio");
      if (o.headless) args.push("-no-window");
      if (o.coldBoot) args.push("-no-snapshot-load");

      // A previous emulator can linger ~20 s after `emu kill` while it saves state; it still holds the AVD lock and
      // its log files, and a new instance started meanwhile dies at once.
      const lingerDeadline = Date.now() + timing.lingerWaitMs;
      while ((await findProcs(EMULATOR_PROC_RE)).length > 0 && Date.now() < lingerDeadline) {
        await sleep(Math.min(timing.lingerPollMs, Math.max(0, lingerDeadline - Date.now())));
      }

      await mkdir(loc.emulatorLogDir, { recursive: true });
      const base = path.join(loc.emulatorLogDir, stamp(new Date()));
      const outLog = `${base}.out.log`;
      const errLog = `${base}.err.log`;
      try {
        launcher = spawn(loc.emulator, args, { outFile: outLog, errFile: errLog, env: androidEnv(loc, r.env) });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          throw new EmuError("NO_EMULATOR_EXE", `Cannot start the emulator ${loc.emulator}: ${(err as Error).message}`);
        }
        throw new EmuError("EMULATOR_EXITED", `Cannot start the emulator ${loc.emulator}: ${(err as Error).message}`);
      }
      launched = true;
      // release stops only an emulator this lease started.
      await updateLease(leaseFile, owner, { startedEmulator: true, emulatorPid: null, emulatorStartedAt: null });
      report(`Starting ${avd} (${args.join(" ")}) log=${base}.*.log`);
      await sleep(timing.launchCheckMs);
      if (launcher.exited()) {
        throw new EmuError("EMULATOR_EXITED", `Emulator exited right away (exit ${launcher.exitCode() ?? "?"}). See ${errLog}`);
      }
    }

    const deadline = Date.now() + bootTimeoutSec * 1000;
    while (!serial) {
      serial = await adb.findSerial(avd, 0);
      if (serial) break;
      if (Date.now() > deadline) {
        throw new EmuError("BOOT_TIMEOUT", `Emulator for AVD '${avd}' did not show up in adb devices within ${bootTimeoutSec} s.`);
      }
      await sleep(timing.bootPollMs);
    }

    if (launched && launcher) {
      // The process release may stop later: the newest qemu, checked again by pid + start time then.
      const q = (await findProcs(QEMU_RE))[0];
      if (q) {
        await updateLease(leaseFile, owner, { emulatorPid: q.pid, emulatorStartedAt: formatLocalIso(q.startTime) });
      } else {
        const info = await procInfo(launcher.pid);
        if (info) await updateLease(leaseFile, owner, { emulatorPid: info.pid, emulatorStartedAt: formatLocalIso(info.startTime) });
      }
    }

    const dev = adb.withSerial(serial);
    while ((await dev.getprop("sys.boot_completed")) !== "1") {
      if (Date.now() > deadline) {
        throw new EmuError("BOOT_TIMEOUT", `Emulator ${serial} did not finish booting within ${bootTimeoutSec} s.`);
      }
      await sleep(timing.bootPollMs);
    }

    // Make the device predictable for automation.
    await dev.shell("settings", "put", "global", "window_animation_scale", "0");
    await dev.shell("settings", "put", "global", "transition_animation_scale", "0");
    await dev.shell("settings", "put", "global", "animator_duration_scale", "0");
    await dev.shell("settings", "put", "system", "screen_off_timeout", "1800000");
    await dev.shell("svc", "power", "stayon", "true");
    // Skip the first-run "Viewing full screen" hint: it steals focus and Unity waits for focus before its first frame.
    await dev.shell("settings", "put", "secure", "immersive_mode_confirmations", "confirmed");
    await dev.shell("input", "keyevent", "KEYCODE_WAKEUP");
    await dev.shell("wm", "dismiss-keyguard");
    // A run killed during time travel can leave the clock ahead with auto_time off.
    await resetClockIfShifted(dev, report, { timing: timing.clock });

    const abilist = await dev.getprop("ro.product.cpu.abilist");
    const nativeBridge = await dev.getprop("ro.dalvik.vm.native.bridge");
    const android = await dev.getprop("ro.build.version.release");
    report(`EMULATOR_READY serial=${serial} android=${android} abilist=${abilist} native_bridge=${nativeBridge} owner=${owner}`);
    report("next    when done: emu-lab release (--uninstall also removes the apps installed under this lease)");

    return {
      action: take.action,
      avd,
      owner,
      serial,
      launched,
      expiresAt: take.lease.expiresAt,
      leaseFile,
      android,
      abilist,
      nativeBridge,
    };
  } catch (err) {
    // A lease this call took is given back when the start fails, unless this call launched an emulator: then the
    // lease stays so that release can stop it.
    if (take.action !== "renewed" && !launched) {
      try {
        // Only the lease this call took: another session may have taken it over meanwhile.
        await removeLeaseIfSame(leaseFile, take.lease, { avd });
        report("LEASE given back (start failed)");
      } catch (removeErr) {
        if (isEmuError(removeErr, "LEASE_CHANGED")) {
          report(`LEASE not given back: ${removeErr.message}`);
        } else {
          report(`LEASE could not be given back (${(removeErr as Error).message}); run emu-lab release`);
        }
      }
    } else if (launched) {
      report("LEASE kept: this call launched the emulator; run emu-lab release to stop it");
    }
    throw err;
  }
}

/** Extend our own lease (valid or expired) by `hours` (default 4) from now. */
export async function renew(o: { avd?: string; owner?: string; hours?: number; env?: NodeJS.ProcessEnv }): Promise<LeaseRecord> {
  const r = resolve(o);
  return renewLease({ path: r.leaseFile, avd: r.avd, owner: r.owner, hours: o.hours ?? DEFAULT_HOURS });
}

function normalizePackages(list: string[] | undefined): string[] {
  const out: string[] = [];
  for (const item of list ?? []) {
    for (const part of String(item).split(",")) {
      const p = part.trim();
      if (p && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

/**
 * Give the AVD back: reset what test runs leave on the device, optionally uninstall, stop the emulator only when
 * this lease started it, delete the lease. No lease is not an error (released false).
 */
export async function releaseEmulator(o: ReleaseOptions): Promise<ReleaseResult> {
  const report = o.report;
  if (o.stale && o.anyOwner) throw new EmuError("BAD_OPTION", "Pass --stale or --any-owner, not both.");
  if (o.stale && (o.uninstall || o.keepRunning)) {
    throw new EmuError(
      "BAD_OPTION",
      "--stale only drops the lease file and does not touch the device; drop --uninstall / --keep-running.",
    );
  }
  const packages = normalizePackages(o.packages);
  if (packages.length && !o.uninstall) {
    throw new EmuError("BAD_OPTION", "--package names what --uninstall removes; add --uninstall.");
  }

  const r = resolve(o);
  const { avd, owner, leaseFile } = r;
  const timing = timingOf(o.deps);
  const procInfo = o.deps?.getProcessInfo ?? realGetProcessInfo;
  const result: ReleaseResult = {
    released: false,
    avd,
    leaseOwner: null,
    by: owner,
    uninstalled: [],
    kept: [],
    stopped: "none",
    resets: [],
  };

  const lease = await readLease(leaseFile);
  if (!lease) {
    report(`LEASE_NONE AVD '${avd}' has no lease (${leaseFile}): nothing to release.`);
    return result;
  }
  result.leaseOwner = lease.owner;

  if (o.stale) {
    if (isLeaseValid(lease)) {
      throw new EmuError(
        "NOT_STALE",
        `NOT_STALE the lease of ${lease.owner} is valid until ${lease.expiresAt}. --stale drops only a lease that ran out.`,
      );
    }
    // Only that lease, and only while it is still run out (not renewed or taken over meanwhile).
    await removeLeaseIfSame(leaseFile, lease, { expired: true, avd });
    report(`RELEASED stale lease of ${lease.owner} (ran out at ${lease.expiresAt}); the device was not touched`);
    result.released = true;
    return result;
  }
  if (!sameOwner(lease.owner, owner) && !o.anyOwner) {
    throw new EmuError(
      "NOT_OWNER",
      `NOT_OWNER AVD '${avd}' is leased by ${lease.owner}, not by ${owner}. Leave it: another session may still be testing. ` +
        "Only the person releases it (emu-lab release --any-owner).",
    );
  }

  // adb first (no device change): when it is missing or the server does not start, the lease is left as it was.
  const adb = makeAdb(r, report, o.deps);
  await adb.ensureServer();
  const serial = await adb.findSerial(avd, timing.releaseFindWaitMs / 1000);

  // Keep this lease valid while release runs (a lease that ran out could otherwise be taken over midway, and this
  // release would then reset, stop and delete for the new holder). LEASE_CHANGED when it was replaced meanwhile.
  // From here on the record the hold returns is the one acted on (it is the current file content).
  const hold = await holdLease(leaseFile, lease, RELEASE_HOLD_MS, { avd });
  const held = hold.lease;
  try {
    await releaseDevice({ o, adb, serial, held, avd, leaseFile, packages, timing, procInfo, report, result });
    // Delete only the lease this release read (LEASE_CHANGED when another session holds the file now).
    await removeLeaseIfSame(leaseFile, held, { avd });
  } catch (err) {
    // Do not leave a lease that had run out extended by the hold: put back the expiry the hold replaced (not the one
    // read before the hold: the owner may have renewed in between), only when the hold wrote and while unchanged.
    try {
      if (await giveBackHold(leaseFile, hold)) {
        report(`LEASE hold given back (release failed): expiresAt ${hold.replacedExpiresAt} again`);
      }
    } catch (backErr) {
      report(`LEASE hold could not be given back (${(backErr as Error).message})`);
    }
    throw err;
  }
  // This process gave the AVD back: a later shutdown must not reset the clock for the next holder.
  forgetMovedClocks({ avd, leaseFile });
  const by = !sameOwner(held.owner, owner) ? ` by ${owner} (--any-owner)` : "";
  report(`RELEASED avd=${avd} owner=${held.owner}${by}`);
  result.released = true;
  return result;
}

/** The device part of release: reset, uninstall, stop (only the instance this lease started). */
async function releaseDevice(c: {
  o: ReleaseOptions;
  adb: Adb;
  serial: string | null;
  held: LeaseRecord;
  avd: string;
  leaseFile: string;
  packages: string[];
  timing: EmulatorTiming;
  procInfo: (pid: number) => Promise<ProcInfo | null>;
  report: Report;
  result: ReleaseResult;
}): Promise<void> {
  const { o, adb, serial, held, avd, leaseFile, packages, timing, procInfo, report, result } = c;
  const recorded = [...held.installed];

  if (serial) {
    const dev = adb.withSerial(serial);
    // Firebase Analytics debug mode stays on until it is turned off (quick-boot snapshots keep it too).
    const fb = await dev.getprop("debug.firebase.analytics.app");
    if (fb && fb !== ".none.") {
      await dev.shell("setprop", "debug.firebase.analytics.app", ".none.");
      report(`RESET debug.firebase.analytics.app ${fb} -> .none.`);
      result.resets.push("debug.firebase.analytics.app");
    }
    for (const tag of ["log.tag.FA", "log.tag.FA-SVC"]) {
      const v = await dev.getprop(tag);
      if (v) {
        // One argument: the device shell then reads '' as an empty value.
        await dev.shell(`setprop ${tag} ''`);
        report(`RESET ${tag} ${v} -> (empty)`);
        result.resets.push(tag);
      }
    }
    if (await resetClockIfShifted(dev, report, { timing: timing.clock })) result.resets.push("clock");

    if (o.uninstall) {
      const targets = packages.length ? packages : recorded;
      if (!targets.length) report("UNINSTALL nothing: no app was installed under this lease (name one with --package <id>)");
      for (const p of targets) {
        const out = (await dev.run(["uninstall", p])).replace(/\s+/g, " ").trim();
        report(`UNINSTALL ${p} ${out}`);
        if (/\bSuccess\b/.test(out)) result.uninstalled.push(p);
      }
    } else if (recorded.length) {
      report(
        `KEPT apps ${recorded.join(", ")} with their data: the next run on this device is not a first run (--uninstall removes them)`,
      );
    }
    result.kept = recorded.filter((p) => !result.uninstalled.includes(p));

    if (held.startedEmulator && !o.keepRunning) {
      // Stop only the instance this lease started: same pid, name and start time as start recorded.
      const pid = held.emulatorPid;
      const info = pid ? await procInfo(pid) : null;
      let same = false;
      if (info && EMULATOR_PROC_RE.test(info.name)) {
        same = true;
        if (held.emulatorStartedAt) {
          const started = parseLeaseDate(held.emulatorStartedAt);
          same = started !== null && Math.abs(info.startTime.getTime() - started.getTime()) < SAME_START_MS;
        }
      }
      if (same && info) {
        // Still the lease that started it (not taken over meanwhile).
        await assertSameLease(leaseFile, held, avd);
        await dev.run(["emu", "kill"]);
        // It saves the quick-boot snapshot before it exits (about 20 s).
        const deadline = Date.now() + timing.stopWaitMs;
        let alive = true;
        for (;;) {
          const now = await procInfo(info.pid);
          alive = now !== null && now.startTime.getTime() === info.startTime.getTime();
          if (!alive || Date.now() >= deadline) break;
          await sleep(Math.min(timing.stopPollMs, Math.max(0, deadline - Date.now())));
        }
        if (alive) {
          report(`STOP_PENDING emulator ${serial} is still saving its state after ${Math.round(timing.stopWaitMs / 1000)} s; it exits by itself`);
          result.stopped = "pending";
        } else {
          report(`STOPPED emulator ${serial} (this lease started it)`);
          result.stopped = "stopped";
        }
      } else {
        report(`KEPT_RUNNING emulator ${serial} is not the instance this lease started (pid ${pid ?? "none"}); leaving it`);
        result.stopped = "not-ours";
      }
    } else {
      const why = o.keepRunning ? "--keep-running" : "it was already running when the lease was taken";
      report(`KEPT_RUNNING emulator ${serial} (${why})`);
      result.stopped = "kept";
    }
  } else {
    report(`EMULATOR_NOT_RUNNING AVD '${avd}': nothing to reset on the device`);
    result.kept = recorded;
    result.stopped = "not-running";
  }
}

/** Lease, running emulators, boot state, paths and adb version. Changes nothing. */
export async function getStatus(o: {
  avd?: string;
  owner?: string;
  env?: NodeJS.ProcessEnv;
  deps?: EmulatorDeps;
}): Promise<StatusResult> {
  const r = resolve(o);
  const { loc, avd, owner, leaseFile } = r;
  const raw = await readLease(leaseFile);
  const lease = raw ? { ...raw, valid: isLeaseValid(raw), mine: sameOwner(raw.owner, owner) } : null;

  let emulators: { serial: string; avd: string | null }[] = [];
  let serial: string | null = null;
  let bootCompleted: boolean | null = null;
  let adbVersion: string | null = null;
  let adb: Adb | null = null;
  try {
    adb = makeAdb(r, () => {}, o.deps);
  } catch (err) {
    if (!(err instanceof EmuError && err.code === "NO_ADB")) throw err;
  }
  if (adb) {
    try {
      await adb.ensureServer();
      adbVersion = (await adb.version()) || null;
      emulators = await adb.runningEmulators();
      serial = emulators.find((e) => e.avd === avd)?.serial ?? null;
      if (serial) bootCompleted = (await adb.withSerial(serial).getprop("sys.boot_completed")) === "1";
    } catch (err) {
      if (!(err instanceof EmuError && err.code === "NO_ADB")) throw err;
    }
  }

  return { avd, owner, lease, leaseFile, emulators, serial, bootCompleted, paths: loc, adbVersion };
}
