// Install an APK on the running emulator and self-test it from outside the app:
// launch -> ready marker -> tap -> background -> local notification in the shade -> tap back in.
// Behavioural reference: scripts/smoke-test.ps1 (summary.json has the same keys).
//
// Results go to a run directory (<labHome>/runs/<stamp>-smoke-<pid>, or outDir): logcat.txt, unity.txt,
// PNG screenshots, system-dialogs.txt, the notification files and summary.json. Option, lease and connection
// errors throw before the run directory exists; everything after that ends up in summary.error and the function
// resolves with pass false.
//
// Markers and notifScheduledRegex are looked for in the logcat captured since launch. The defaults are the bundled
// sample's lines: SMOKE_APP_READY, SMOKE_TAP count=1, SMOKE_NOTIF_SCHEDULED id=<n> title=<title without spaces>,
// SMOKE_OPENED_FROM_NOTIFICATION. If the app process ends by itself while we wait (no crash or ANR logged), the run
// fails with app_exited=true.
//
// notifScheduledRegex is JavaScript regex syntax, read so that values written for the PowerShell scripts (.NET
// regex) pick the same title: a leading (?i) / (?m) / (?s) becomes a flag, and "group 1" is numbered as in .NET
// (unnamed groups first, then named ones). Other .NET-only syntax is refused with BAD_OPTION.
//
// The lease is checked again right before the clock moves and before the notification steps (like the PowerShell
// child scripts time-travel.ps1 and check-notification.ps1): another session that took the AVD meanwhile stops the
// run with BUSY there.

import { writeFile } from "node:fs/promises";
import { EOL } from "node:os";
import path from "node:path";
import type { Adb, LogcatCapture } from "./adb.ts";
import { readApkInfo } from "./apk.ts";
import { resetClock, timeTravel, type ClockTiming } from "./clock.ts";
import type { Locations } from "./config.ts";
import { connect } from "./context.ts";
import { EmuError, isEmuError } from "./errors.ts";
import { addInstalled, assertLeaseUsable } from "./lease.ts";
import { checkNotification, saveScreenshotSafe, type NotificationTiming } from "./notification.ts";
import { crashRegex, parseLaunch, unityLines } from "./parse.ts";
import { sleep } from "./proc.ts";
import { newRunDir } from "./rundir.ts";
import type { Report } from "./types.ts";

export const SMOKE_DEFAULTS = {
  readyMarker: "SMOKE_APP_READY",
  readyTimeoutSec: 120,
  tapX: 0.5,
  tapY: 0.5,
  tapMarker: "SMOKE_TAP count=1",
  notifDelay: 20,
  notifScheduledRegex: "SMOKE_NOTIF_SCHEDULED id=\\d+ title=(\\S+)",
  openedMarker: "SMOKE_OPENED_FROM_NOTIFICATION",
  notifTimeoutSec: 240,
} as const;

/** Waits of the run; tests shrink them (internal, not exposed in the CLI or MCP). */
export interface SmokeTiming {
  /** Log poll interval while waiting for a marker (PS: 1 s). */
  logPollMs: number;
  /** System dialog check interval during the ready wait (PS: 5 s). */
  dialogCheckMs: number;
  /** App process check interval while waiting (PS: 3 s). */
  appCheckMs: number;
  /** Gap between the two empty pidof answers that mean "gone" (PS: 2 s). */
  pidofGapMs: number;
  /** After the process is gone, time for a crash report to reach the log (PS: 1 s). */
  exitSettleMs: number;
  /** Before the first tap: the first frames can drop input (PS: 2 s). */
  tapSettleMs: number;
  /** Wait for the tap marker after each tap (PS: 5 s). */
  tapWaitSec: number;
  /** Wait for the scheduled-notification log line (PS: 30 s). */
  schedWaitSec: number;
  /** After KEYCODE_HOME before the home screenshot (PS: 1 s). */
  homeSettleMs: number;
  notification?: Partial<NotificationTiming>;
  clock?: ClockTiming;
}

export const DEFAULT_SMOKE_TIMING: SmokeTiming = {
  logPollMs: 1_000,
  dialogCheckMs: 5_000,
  appCheckMs: 3_000,
  pidofGapMs: 2_000,
  exitSettleMs: 1_000,
  tapSettleMs: 2_000,
  tapWaitSec: 5,
  schedWaitSec: 30,
  homeSettleMs: 1_000,
};

export interface SmokeDeps {
  adbFactory?: (loc: Locations, env: NodeJS.ProcessEnv) => Adb;
  timing?: Partial<SmokeTiming>;
  /** Wait for the AVD to appear in adb devices (default 60 s, like the PS script). */
  waitSec?: number;
  /** Tests: replace the notification check (e.g. one that throws). */
  checkNotification?: typeof checkNotification;
}

export interface SmokeOptions {
  apk: string;
  /** Defaults to the APK's own package; a mismatch is an error. */
  package?: string;
  readyMarker?: string;
  readyTimeoutSec?: number;
  /** Fraction of the current (rotated) screen. */
  tapX?: number;
  tapY?: number;
  /** Plain text the app logs when the tap lands. */
  tapMarker?: string;
  /** Skip the tap step. */
  noTap?: boolean;
  /** Tap, but do not wait for tapMarker. */
  noTapCheck?: boolean;
  /** Passed to the app as "--es notif_delay"; 0 skips the notification check. */
  notifDelay?: number;
  /**
   * Regex over the logcat text; capture group 1 = the notification title (a plain substring for the check). JavaScript
   * syntax, a leading (?i)/(?m)/(?s) allowed, groups numbered as in .NET (unnamed first).
   */
  notifScheduledRegex?: string;
  /** Plain text the app logs when opened from the notification. */
  openedMarker?: string;
  /** The app logs nothing then: "opened" = its activity is resumed after the tap. */
  noOpenedMarker?: boolean;
  notifTimeoutSec?: number;
  /** > 0: jump the device clock forward after scheduling (long-delay notifications); always reset afterwards. */
  timeTravelMinutes?: number;
  /** Revoke POST_NOTIFICATIONS so the system permission dialog shows again. */
  askPermission?: boolean;
  outDir?: string;
  avd?: string;
  owner?: string;
  env?: NodeJS.ProcessEnv;
  leaseMode?: "strict" | "warn";
  report: Report;
  deps?: SmokeDeps;
}

export interface SmokeSummary {
  pass: boolean;
  run_dir: string;
  [k: string]: unknown;
}

const POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bad(message: string): EmuError {
  return new EmuError("BAD_OPTION", message);
}

/** Number of capture groups of a regex (named ones included). */
function groupCount(re: RegExp): number {
  return (new RegExp(`${re.source}|`, re.flags.replace("g", "").replace("y", "")).exec("") ?? [""]).length - 1;
}

/** The capture groups of a JavaScript regex source in order: true = named. */
function captureGroups(source: string): boolean[] {
  const groups: boolean[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c !== "(") continue;
    if (source[i + 1] !== "?") {
      groups.push(false);
    } else if (source[i + 2] === "<" && source[i + 3] !== "=" && source[i + 3] !== "!") {
      groups.push(true);
    }
  }
  return groups;
}

const INLINE_FLAGS: Record<string, string> = { i: "i", m: "m", s: "s" };

/**
 * notif_scheduled_regex: a leading .NET inline option group (?i) / (?m) / (?s) (or a mix such as (?im)) becomes
 * the JavaScript flag; the title is .NET group 1 (the first unnamed group, or the first named one when all are
 * named), returned as its JavaScript match index.
 */
export function compileScheduledRegex(source: string): { re: RegExp; titleGroup: number } {
  const name = "notif_scheduled_regex (--notif-scheduled-regex)";
  let body = source;
  let flags = "";
  const lead = /^\(\?([A-Za-z-]+)\)/.exec(body);
  if (lead) {
    for (const ch of lead[1]) {
      const flag = INLINE_FLAGS[ch];
      if (!flag) {
        throw bad(
          `${name} starts with the .NET inline option (?${lead[1]}); only (?i), (?m) and (?s) (or a mix such as (?im)) are supported. ` +
            "The regex is JavaScript syntax otherwise.",
        );
      }
      if (!flags.includes(flag)) flags += flag;
    }
    body = body.slice(lead[0].length);
  }
  let re: RegExp;
  try {
    re = new RegExp(body, flags);
  } catch (err) {
    const dotNet = /\(\?[imnsx-]+[):]|\(\?'|\(\?P</.test(body)
      ? " It uses .NET-only syntax ((?i) not at the start, (?i:...), (?'name'...), (?P<name>...)): write it as a JavaScript regex."
      : "";
    throw bad(`${name} is not a valid regex: ${(err as Error).message}.${dotNet}`);
  }
  if (groupCount(re) < 1) {
    throw bad(`${name} needs capture group 1 = the notification title, e.g. "Scheduled notification: (.+)".`);
  }
  const groups = captureGroups(body);
  const firstUnnamed = groups.indexOf(false);
  const titleGroup = firstUnnamed >= 0 ? firstUnnamed + 1 : 1;
  return { re, titleGroup };
}

interface Validated {
  apk: string;
  readyMarker: string;
  readyTimeoutSec: number;
  tapX: number;
  tapY: number;
  tapMarker: string;
  noTap: boolean;
  noTapCheck: boolean;
  notifDelay: number;
  schedRe: RegExp;
  /** JavaScript match index of the title (.NET group 1). */
  schedTitleGroup: number;
  openedMarker: string | undefined;
  notifTimeoutSec: number;
  timeTravelMinutes: number;
  askPermission: boolean;
}

/** Checks the options before touching the device (throws BAD_OPTION). */
export function validateSmokeOptions(o: SmokeOptions): Validated {
  if (typeof o.apk !== "string" || !o.apk.trim()) throw bad("apk is required (path to the .apk file).");
  const positive = (v: number | undefined, def: number, name: string): number => {
    if (v === undefined) return def;
    if (!(typeof v === "number" && Number.isFinite(v) && v > 0)) throw bad(`${name} must be a number of seconds > 0 (got ${v}).`);
    return v;
  };
  const fraction = (v: number | undefined, def: number, name: string): number => {
    if (v === undefined) return def;
    if (!(typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1)) {
      throw bad(`${name} is a fraction of the screen between 0 and 1 (got ${v}).`);
    }
    return v;
  };
  const text = (v: string | undefined, def: string, name: string): string => {
    if (v === undefined) return def;
    if (typeof v !== "string" || !v) throw bad(`${name} must not be empty.`);
    return v;
  };

  const notifDelay = o.notifDelay ?? SMOKE_DEFAULTS.notifDelay;
  if (!(Number.isInteger(notifDelay) && notifDelay >= 0)) {
    throw bad(`notif_delay (--notif-delay) must be a whole number of seconds >= 0 (got ${o.notifDelay}).`);
  }
  const timeTravelMinutes = o.timeTravelMinutes ?? 0;
  if (!(typeof timeTravelMinutes === "number" && Number.isFinite(timeTravelMinutes) && timeTravelMinutes >= 0)) {
    throw bad(`time_travel_minutes (--time-travel) must be a number of minutes >= 0 (got ${o.timeTravelMinutes}).`);
  }

  const sched = compileScheduledRegex(o.notifScheduledRegex ?? SMOKE_DEFAULTS.notifScheduledRegex);
  if (timeTravelMinutes > 0 && notifDelay <= 0) {
    throw bad(
      "time_travel_minutes (--time-travel) needs the automatic notification check (notif_delay > 0 and a log line that matches " +
        "notif_scheduled_regex). With notif_delay 0: schedule in the game, emu-lab clock forward <minutes>, emu-lab notification, " +
        "then always emu-lab clock reset.",
    );
  }

  const noOpenedMarker = o.noOpenedMarker === true;
  const openedMarker = noOpenedMarker ? undefined : o.openedMarker === undefined ? SMOKE_DEFAULTS.openedMarker : o.openedMarker || undefined;
  return {
    apk: path.resolve(o.apk.trim()),
    readyMarker: text(o.readyMarker, SMOKE_DEFAULTS.readyMarker, "ready_marker (--ready-marker)"),
    readyTimeoutSec: positive(o.readyTimeoutSec, SMOKE_DEFAULTS.readyTimeoutSec, "ready_timeout_sec (--ready-timeout)"),
    tapX: fraction(o.tapX, SMOKE_DEFAULTS.tapX, "tap_x (--tap-x)"),
    tapY: fraction(o.tapY, SMOKE_DEFAULTS.tapY, "tap_y (--tap-y)"),
    tapMarker: text(o.tapMarker, SMOKE_DEFAULTS.tapMarker, "tap_marker (--tap-marker)"),
    noTap: o.noTap === true,
    noTapCheck: o.noTapCheck === true,
    notifDelay,
    schedRe: sched.re,
    schedTitleGroup: sched.titleGroup,
    openedMarker,
    notifTimeoutSec: positive(o.notifTimeoutSec, SMOKE_DEFAULTS.notifTimeoutSec, "notif_timeout_sec (--notif-timeout)"),
    timeTravelMinutes,
    askPermission: o.askPermission === true,
  };
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => String(x)).join(" | ");
  return String(v);
}

interface WaitResult {
  ok: boolean;
  crash: boolean;
  exited?: boolean;
  match?: RegExpExecArray;
}

export async function runSmoke(o: SmokeOptions): Promise<SmokeSummary> {
  const v = validateSmokeOptions(o);
  const report = o.report;
  const timing: SmokeTiming = { ...DEFAULT_SMOKE_TIMING, ...(o.deps?.timing ?? {}) };
  const notificationCheck = o.deps?.checkNotification ?? checkNotification;

  const leaseMode = o.leaseMode ?? "warn";
  // Another session's lease stops the run here, before anything is installed.
  const ctx = await connect({
    avd: o.avd,
    owner: o.owner,
    env: o.env,
    report,
    leaseMode,
    waitSec: o.deps?.waitSec ?? 60,
    adbFactory: o.deps?.adbFactory,
  });
  const adb = ctx.adb;
  // Before the clock moves and the shade is used: another session may have taken the AVD during the waits (BUSY).
  const recheckLease = (): Promise<unknown> =>
    assertLeaseUsable({ path: ctx.leaseFile, avd: ctx.avd, owner: ctx.owner, mode: leaseMode, report });

  const apkInfo = await readApkInfo(v.apk); // BAD_OPTION when missing or not a zip
  let pkg = (o.package ?? "").trim();
  if (!pkg) pkg = apkInfo.package ?? "";
  if (!pkg) throw new EmuError("PACKAGE_UNKNOWN", `Could not read the package name of ${v.apk}; pass package (--package).`);
  if (apkInfo.package && apkInfo.package !== pkg) {
    throw new EmuError("PACKAGE_MISMATCH", `--package ${pkg} does not match the APK (${apkInfo.package}).`);
  }

  const run = await newRunDir(ctx.loc, "smoke", o.outDir);
  const logPath = path.join(run, "logcat.txt");
  const dialogLog = path.join(run, "system-dialogs.txt");
  const checks: Record<string, unknown> = { package: pkg };
  // Only crashes of this package count (other system processes may log fatal lines too).
  const crashRe = crashRegex(pkg);

  let logcat: LogcatCapture | null = null;
  let dialogsTapped = 0;
  let timeTravelled = false;
  const readLog = (): string => (logcat ? logcat.text() : "");

  const appExited = async (): Promise<boolean> => {
    // True only when "pidof" prints nothing twice in a row. adb errors print text, so they count as "running".
    for (let i = 0; i < 2; i++) {
      if (i) await sleep(timing.pidofGapMs);
      if ((await adb.shell("pidof", pkg)).trim()) return false;
    }
    // pidof matches the exact process name only. An app with android:process (e.g. "com.x:game") still runs under
    // another name, so also look for any "<package>" / "<package>:..." process and a resumed activity of the package.
    const names = (await adb.shell("ps", "-A", "-o", "NAME")).split(/\r?\n/).map((l) => l.trim());
    if (names.some((n) => n === pkg || n.startsWith(`${pkg}:`))) return false;
    if (await adb.isPackageResumed(pkg)) return false;
    return true;
  };

  const stopOnAppExit = async (during: string): Promise<never> => {
    // The process is gone. A crash report may still be on its way into the log.
    await sleep(timing.exitSettleMs);
    if (crashRe.test(readLog())) {
      checks.crash = true;
      throw new Error(`The app crashed during ${during} (see logcat.txt and unity.txt in ${run}).`);
    }
    checks.app_exited = true;
    const lines = readLog()
      .split("\n")
      .filter((l) => l.includes(pkg) && /ActivityManager|ActivityTaskManager|Zygote|libprocessgroup/.test(l))
      .slice(-5)
      .map((l) => l.trim());
    if (lines.length) checks.app_exit_log = lines;
    throw new Error(
      `The app process (${pkg}) ended by itself during ${during}, with no crash or ANR in the log. ` +
        `See logcat.txt in ${run} (the app's last lines, and ActivityManager/Zygote lines about ${pkg}). ` +
        "Likely causes: an anti-cheat, integrity or tamper check that quits on an emulator, a rootable (adb root) image " +
        "or a debug-signed build; or a start-up error or check (login, patch server, network) that calls Application.Quit. " +
        "Such a build cannot be tested here as is: ask the person for a test build with that check off; do not patch or bypass it.",
    );
  };

  const waitLog = async (re: RegExp, timeoutSec: number, w: { dialogs?: boolean; app?: boolean }): Promise<WaitResult> => {
    const deadline = Date.now() + timeoutSec * 1000;
    let nextDialogCheck = Date.now() + timing.dialogCheckMs;
    let nextAppCheck = Date.now() + timing.appCheckMs;
    const look = (): WaitResult | null => {
      const text = readLog();
      if (crashRe.test(text)) return { ok: false, crash: true };
      const m = re.exec(text);
      return m ? { ok: true, crash: false, match: m } : null;
    };
    while (Date.now() < deadline) {
      const hit = look();
      if (hit) return hit;
      if (w.app && Date.now() > nextAppCheck) {
        if (await appExited()) return { ok: false, crash: false, exited: true };
        nextAppCheck = Date.now() + timing.appCheckMs;
      }
      if (w.dialogs && Date.now() > nextDialogCheck) {
        if (await adb.resolveSystemDialog(pkg, dialogLog)) dialogsTapped++;
        nextDialogCheck = Date.now() + timing.dialogCheckMs;
      }
      await sleep(Math.min(timing.logPollMs, Math.max(0, deadline - Date.now())));
    }
    // One last look: the line may have arrived during the final pause.
    return look() ?? { ok: false, crash: false };
  };

  try {
    // Unity Mono builds are ARMv7-only; the API 35 x86_64 AVD runs only x86_64 / arm64-v8a code.
    const apkAbis = apkInfo.abis;
    const devAbis = (await adb.getprop("ro.product.cpu.abilist")).split(",").map((s) => s.trim()).filter(Boolean);
    checks.apk_abis = apkAbis.join(",");
    checks.device_abis = devAbis.join(",");
    // An empty device list means adb could not read it: then let the install itself decide.
    if (apkAbis.length > 0 && devAbis.length > 0 && !apkAbis.some((a) => devAbis.includes(a))) {
      checks.install = false;
      throw new EmuError(
        "ABI_MISMATCH",
        `APK native ABIs (${checks.apk_abis}) cannot run on this emulator (${checks.device_abis}). Build an IL2CPP + ARM64 test APK ` +
          "(templates/EmuProjectBuild.cs with -emuArm64, see AGENTS.md); do not recreate the AVD.",
      );
    }

    // Install (a large APK can take minutes)
    const install = (await adb.run(["install", "-r", v.apk], { timeoutMs: 600_000 })).replace(/\s+/g, " ").trim();
    checks.install = /Success/.test(install);
    if (!checks.install) throw new EmuError("ADB_FAILED", `Install failed: ${install}`);
    // emu-lab release --uninstall removes what was installed under the lease.
    await addInstalled(ctx.leaseFile, ctx.owner, pkg);
    if (v.askPermission) {
      // install -r keeps earlier grants; reset them so the runtime dialog appears again.
      await adb.shell("pm", "revoke", pkg, POST_NOTIFICATIONS);
      await adb.shell("pm", "clear-permission-flags", pkg, POST_NOTIFICATIONS, "user-set", "user-fixed");
    } else {
      await adb.shell("pm", "grant", pkg, POST_NOTIFICATIONS);
    }

    // Launch with logcat capture
    await adb.run(["logcat", "-c"]);
    logcat = adb.startLogcat(logPath);
    const activity = await adb.launcherActivity(pkg);
    await adb.shell("am", "force-stop", pkg);
    const sinceMs = await adb.epochMs();
    const launch = parseLaunch(await adb.shell("am", "start", "-W", "-n", activity, "--es", "notif_delay", String(v.notifDelay)));
    if (launch.totalTimeMs !== null) checks.launch_ms = launch.totalTimeMs;
    checks.launch = launch.ok;
    // Watch the process only after a launch that adb reported as started (else "gone" would just mean "never ran").
    const watchApp = launch.ok;
    if (watchApp) checks.app_exited = false;

    const ready = await waitLog(new RegExp(escapeRegex(v.readyMarker)), v.readyTimeoutSec, { dialogs: true, app: watchApp });
    checks.ready = ready.ok;
    checks.system_dialogs_tapped = dialogsTapped;
    checks.crash = ready.crash;
    await saveScreenshotSafe(adb, path.join(run, "01-ready.png"), report);
    if (ready.exited) await stopOnAppExit(`the wait for the ready marker '${v.readyMarker}'`);
    if (!ready.ok) throw new Error(`Ready marker '${v.readyMarker}' not seen (crash=${ready.crash}).`);

    // Input: tap a point given as a fraction of the current logical screen (after rotation)
    if (!v.noTap) {
      const disp = await adb.displaySize();
      if (disp && disp.w > 0 && disp.h > 0) {
        const x = Math.round(disp.w * v.tapX);
        const y = Math.round(disp.h * v.tapY);
        checks.tap_point = `${x},${y} of ${disp.w}x${disp.h}`;
        // The first frames after start-up can drop input, so settle briefly and retry.
        await sleep(timing.tapSettleMs);
        const tapRe = new RegExp(escapeRegex(v.tapMarker));
        for (let attempt = 1; attempt <= 3; attempt++) {
          await adb.shell("input", "tap", String(x), String(y));
          if (v.noTapCheck) break;
          const tapWait = await waitLog(tapRe, timing.tapWaitSec, { app: watchApp });
          checks.tap = tapWait.ok;
          checks.tap_attempts = attempt;
          if (tapWait.exited) await stopOnAppExit(`the wait for the tap marker '${v.tapMarker}'`);
          if (tapWait.ok) break;
        }
        await saveScreenshotSafe(adb, path.join(run, "02-after-tap.png"), report);
      }
    }
    // A tap (or a start-up check) can also end the app a few seconds in; noTapCheck alone would not notice.
    if (watchApp && (await appExited())) await stopOnAppExit("the tap step");

    // Local notification, checked from outside the app
    if (v.notifDelay > 0) {
      const sched = await waitLog(v.schedRe, timing.schedWaitSec, { app: watchApp });
      if (sched.exited) await stopOnAppExit("the wait for the scheduled-notification log (notif_scheduled_regex)");
      checks.notif_scheduled = sched.ok;
      if (sched.ok && sched.match) {
        const title = (sched.match[v.schedTitleGroup] ?? "").trim();
        if (!title) {
          throw new Error(`notif_scheduled_regex matched '${sched.match[0].trim()}' but its group 1 (the title) is empty.`);
        }
        await recheckLease();
        await adb.shell("input", "keyevent", "KEYCODE_HOME");
        await sleep(timing.homeSettleMs);
        await saveScreenshotSafe(adb, path.join(run, "03-home.png"), report);
        if (v.timeTravelMinutes > 0) {
          await recheckLease();
          // Mark the clock for reset first: time travel can fail after it has already moved the clock.
          timeTravelled = true;
          await timeTravel(adb, v.timeTravelMinutes, report, {
            timing: timing.clock,
            target: { avd: ctx.avd, leaseFile: ctx.leaseFile, owner: ctx.owner },
          });
          checks.time_travel_min = v.timeTravelMinutes;
        }
        checks.notif_opened_check = v.openedMarker ? "marker" : "resumed activity";
        const n = await notificationCheck({
          package: pkg,
          title,
          timeoutSec: v.notifTimeoutSec,
          sinceMs,
          tap: true,
          openedMarker: v.openedMarker,
          logCapture: v.openedMarker && logcat ? logcat : undefined,
          runDir: run,
          report,
          ctx,
          leaseMode,
          deps: { timing: timing.notification },
        });
        checks.notif_title = title;
        checks.notif_posted = n.posted;
        checks.notif_posted_after_sec = n.posted_after_sec;
        checks.notif_in_shade = n.in_shade;
        checks.notif_opened_app = n.opened_app;
      }
    }
    checks.crash = crashRe.test(readLog());
  } catch (err) {
    checks.error = (err as Error).message ?? String(err);
    if (isEmuError(err)) checks.error_code = err.code;
  } finally {
    if (timeTravelled) {
      try {
        await resetClock(adb, report, { timing: timing.clock });
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        checks.clock_reset_error = msg;
        report(`CLOCK_RESET_FAILED ${msg} (the next emu-lab start or release resets it too; or run emu-lab clock reset)`);
      }
    }
    if (logcat) await logcat.stop();
    const lines = unityLines(readLog());
    try {
      await writeFile(path.join(run, "unity.txt"), lines.length ? lines.join(EOL) + EOL : "", "utf8");
    } catch (err) {
      report(`WRITE_FAILED unity.txt: ${(err as Error).message}`);
    }
  }

  const failed = ["install", "launch", "ready", "tap", "notif_scheduled", "notif_posted", "notif_in_shade", "notif_opened_app"].filter(
    (k) => k in checks && !checks[k],
  );
  const pass = failed.length === 0 && !checks.crash && !checks.error && !checks.app_exited;
  checks.pass = pass;
  checks.run_dir = run;
  await writeFile(path.join(run, "summary.json"), JSON.stringify(checks, null, 2) + "\n", "utf8");
  for (const [k, val] of Object.entries(checks)) report(`  ${k.padEnd(24)} ${formatValue(val)}`);
  report(`SMOKE ${pass ? "PASS" : "FAIL"} dir=${run}`);
  return checks as SmokeSummary;
}
