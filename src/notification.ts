// Verify from OUTSIDE the app that a notification really reached the Android system UI.
// Behavioural reference: scripts/check-notification.ps1.
//   1) NotificationManager has it      (dumpsys notification --noredact), posted at/after sinceMs
//   2) SystemUI renders it in the shade (cmd statusbar expand-notifications + uiautomator dump)
//   3) optional: tapping it opens the app (tap; openedMarker in the log, else the resumed activity)
//
// The title is a plain substring (no wildcards); non-ASCII titles work. Only notifications posted at/after sinceMs
// (device epoch ms, default: when the check starts) count, so an older notification with the same title cannot
// pass. openedMarker is looked for in what the log capture gains after the tap: smoke passes its own capture;
// standalone, the check captures logcat itself from the newest line (-T 1) into <run>/notification-logcat.txt.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Adb, LogcatCapture } from "./adb.ts";
import type { Locations } from "./config.ts";
import { connect, type EmuContext } from "./context.ts";
import { EmuError } from "./errors.ts";
import { assertLeaseUsable } from "./lease.ts";
import { centre, findNotificationRecord, findUiNodeByText } from "./parse.ts";
import { sleep } from "./proc.ts";
import { newRunDir } from "./rundir.ts";
import type { Report } from "./types.ts";

/** Waits of the check; tests shrink them (internal, not exposed in the CLI or MCP). */
export interface NotificationTiming {
  /** Pause between dumpsys notification polls (PS: 3 s). */
  pollMs: number;
  /** After KEYCODE_HOME when the app was in front before the tap (PS: 1 s). */
  homeSettleMs: number;
  /** After expanding the shade, before the UI dump (PS: 2 s). */
  shadeSettleMs: number;
  /** How long to wait for the app to open after the tap (PS: 30 s). */
  openedWaitMs: number;
  /** Poll interval while waiting for the app to open (PS: 2 s). */
  openedPollMs: number;
  /** Pause before the screenshot of the opened app (PS: 1 s). */
  afterOpenMs: number;
}

export const DEFAULT_NOTIFICATION_TIMING: NotificationTiming = {
  pollMs: 3_000,
  homeSettleMs: 1_000,
  shadeSettleMs: 2_000,
  openedWaitMs: 30_000,
  openedPollMs: 2_000,
  afterOpenMs: 1_000,
};

export interface NotificationDeps {
  adbFactory?: (loc: Locations, env: NodeJS.ProcessEnv) => Adb;
  timing?: Partial<NotificationTiming>;
  /** Wait for the AVD to appear in adb devices (default 30 s, like the PS script). */
  waitSec?: number;
}

export interface NotificationOptions {
  package: string;
  /** Plain substring of the notification title. */
  title: string;
  timeoutSec?: number;
  /** Device epoch ms; only notifications posted at/after it count (default: device time when the check starts). */
  sinceMs?: number;
  tap?: boolean;
  openedMarker?: string;
  /** A capture that is still being written (smoke passes its own). */
  logCapture?: LogcatCapture;
  runDir?: string;
  avd?: string;
  owner?: string;
  env?: NodeJS.ProcessEnv;
  leaseMode?: "strict" | "warn";
  report: Report;
  deps?: NotificationDeps;
  /** An existing session (smoke): no second connect; the lease is checked again (leaseMode). */
  ctx?: EmuContext;
}

export interface NotificationResult {
  pass: boolean;
  package: string;
  title: string;
  since_ms: number;
  posted: boolean;
  posted_after_sec: number | null;
  posted_at_ms: number | null;
  in_shade: boolean;
  backgrounded_before_tap: boolean;
  tapped: boolean;
  opened_app: boolean;
  opened_check?: string;
  run_dir: string;
  log_file?: string;
}

/** Screenshot that never fails the check (PS Save-Screenshot does not throw either); a failure is reported. */
export async function saveScreenshotSafe(adb: Adb, file: string, report: Report): Promise<boolean> {
  try {
    await adb.saveScreenshot(file);
    return true;
  } catch (err) {
    if (err instanceof EmuError && err.code === "NO_ADB") throw err;
    report(`SCREENSHOT_FAILED ${path.basename(file)}: ${(err as Error).message}`);
    return false;
  }
}

function validate(o: NotificationOptions): void {
  if (typeof o.package !== "string" || !o.package.trim()) throw new EmuError("BAD_OPTION", "package is required (the app's package name).");
  if (typeof o.title !== "string" || !o.title) throw new EmuError("BAD_OPTION", "title is required (a plain substring of the notification title).");
  if (o.timeoutSec !== undefined && !(Number.isFinite(o.timeoutSec) && o.timeoutSec > 0)) {
    throw new EmuError("BAD_OPTION", `timeout must be a number of seconds > 0 (got ${o.timeoutSec}).`);
  }
  if (o.sinceMs !== undefined && !Number.isFinite(o.sinceMs)) {
    throw new EmuError("BAD_OPTION", `since_ms must be device epoch milliseconds (got ${o.sinceMs}).`);
  }
}

export async function checkNotification(o: NotificationOptions): Promise<NotificationResult> {
  validate(o);
  const pkg = o.package.trim();
  const title = o.title;
  const timing: NotificationTiming = { ...DEFAULT_NOTIFICATION_TIMING, ...(o.deps?.timing ?? {}) };
  const timeoutMs = (o.timeoutSec ?? 240) * 1000;
  const tap = o.tap === true;
  const openedMarker = o.openedMarker ? o.openedMarker : undefined;
  const report = o.report;

  const leaseMode = o.leaseMode ?? "warn";
  let ctx: EmuContext;
  if (o.ctx) {
    ctx = o.ctx;
    // A session already connected (smoke): check the lease again now (another session may have taken the AVD
    // meanwhile; BUSY), like check-notification.ps1 does when smoke-test.ps1 runs it, and again before the shade and
    // the tap below.
    await assertLeaseUsable({ path: ctx.leaseFile, avd: ctx.avd, owner: ctx.owner, mode: leaseMode, report });
  } else {
    ctx = await connect({
      avd: o.avd,
      owner: o.owner,
      env: o.env,
      report,
      leaseMode,
      waitSec: o.deps?.waitSec ?? 30,
      adbFactory: o.deps?.adbFactory,
    });
  }
  const adb = ctx.adb;
  // The dumpsys wait can take minutes: check the lease again right before each device-changing step (the Home key,
  // the shade, the tap, the collapse), so another session that took the AVD meanwhile stops it (BUSY).
  const recheckLease = (): Promise<unknown> =>
    assertLeaseUsable({ path: ctx.leaseFile, avd: ctx.avd, owner: ctx.owner, mode: leaseMode, report });

  const runDir = o.runDir !== undefined && o.runDir.trim() ? await newRunDir(ctx.loc, "notification", o.runDir) : await newRunDir(ctx.loc, "notification");
  const sinceMs = o.sinceMs !== undefined && o.sinceMs > 0 ? Math.round(o.sinceMs) : await adb.epochMs();

  const result: Omit<NotificationResult, "pass" | "run_dir"> & { pass?: boolean; run_dir?: string } = {
    package: pkg,
    title,
    since_ms: sinceMs,
    posted: false,
    posted_after_sec: null,
    posted_at_ms: null,
    in_shade: false,
    backgrounded_before_tap: false,
    tapped: false,
    opened_app: false,
  };
  if (tap) result.opened_check = openedMarker ? "marker" : "resumed activity";
  const started = Date.now();

  let capture = o.logCapture;
  let ownCapture: LogcatCapture | null = null;
  try {
    if (tap && openedMarker && !capture) {
      // Standalone: capture logcat now so the marker logged after the tap can be seen. "-T 1" starts at the newest
      // line, so an old marker still in the device buffer does not count, and the buffer is not cleared.
      const logFile = path.join(runDir, "notification-logcat.txt");
      result.log_file = logFile;
      ownCapture = adb.startLogcat(logFile, ["-T", "1"]);
      capture = ownCapture;
    }

    // 1) NotificationManager record, newer than the baseline
    for (;;) {
      const dump = await adb.shell("dumpsys", "notification", "--noredact");
      const hit = findNotificationRecord(dump, pkg, title, sinceMs);
      if (hit) {
        await writeFile(path.join(runDir, "notification_dump.txt"), hit.record, "utf8");
        result.posted = true;
        result.posted_after_sec = Math.round((Date.now() - started) / 1000);
        result.posted_at_ms = hit.timeMs;
        break;
      }
      const left = timeoutMs - (Date.now() - started);
      if (left <= 0) break;
      await sleep(Math.min(timing.pollMs, left));
    }
    report(`NOTIF_POSTED ${result.posted} after=${result.posted_after_sec ?? ""}s`);

    if (result.posted) {
      // Without a log marker, "the app came to the front" only means something if it was not there already.
      if (tap && (await adb.isPackageResumed(pkg))) {
        await recheckLease();
        await adb.shell("input", "keyevent", "KEYCODE_HOME");
        await sleep(timing.homeSettleMs);
        result.backgrounded_before_tap = true;
      }

      // 2) Rendered in the notification shade
      await recheckLease();
      await adb.shell("cmd", "statusbar", "expand-notifications");
      await sleep(timing.shadeSettleMs);
      const xml = await adb.uiDump();
      await saveScreenshotSafe(adb, path.join(runDir, "04-shade.png"), report);
      let node = null;
      if (xml) {
        await writeFile(path.join(runDir, "shade.xml"), xml, "utf8");
        node = findUiNodeByText(xml, title);
      }
      result.in_shade = node !== null;
      report(`NOTIF_IN_SHADE ${result.in_shade}`);

      // 3) Tap through to the app
      if (tap && node) {
        const { x, y } = centre(node.bounds);
        const before = capture ? capture.length() : 0;
        await recheckLease();
        await adb.shell("input", "tap", String(x), String(y));
        result.tapped = true;
        const deadline = Date.now() + timing.openedWaitMs;
        while (Date.now() < deadline) {
          await sleep(timing.openedPollMs);
          if (openedMarker && capture) {
            const log = capture.text();
            if (log.length > before && log.slice(before).includes(openedMarker)) {
              result.opened_app = true;
              break;
            }
          } else if (await adb.isPackageResumed(pkg)) {
            result.opened_app = true;
            break;
          }
        }
        await sleep(timing.afterOpenMs);
        await saveScreenshotSafe(adb, path.join(runDir, "05-opened-from-notification.png"), report);
        report(`NOTIF_OPENED_APP ${result.opened_app}`);
      } else {
        // The settle, the dump and the screenshot took a while: another session may hold the AVD now (BUSY).
        await recheckLease();
        await adb.shell("cmd", "statusbar", "collapse");
      }
    }
  } finally {
    if (ownCapture) await ownCapture.stop();
  }

  const pass = result.posted && result.in_shade && (!tap || result.opened_app);
  result.pass = pass;
  result.run_dir = runDir;
  await writeFile(path.join(runDir, "notification-check.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
  report(`NOTIFICATION_CHECK ${pass ? "PASS" : "FAIL"} dir=${runDir}`);
  return result as NotificationResult;
}
