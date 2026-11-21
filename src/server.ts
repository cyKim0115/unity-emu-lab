// MCP server: the emulator lab as tools over stdio. Every tool works on one AVD (default unity-test, or EMU_AVD)
// under the shared lease file, so several AI sessions on one PC do not step on each other's device.
//
// - Long tools (emu_start, emu_smoke, emu_check_notification, emu_release, emu_webgl_smoke) run as jobs in this
//   process: the call waits up to wait_sec and otherwise returns a job_id for emu_job. One device-changing job per AVD
//   at a time (emu_webgl_smoke uses no device and is not limited).
// - Report lines are kept per call / per job and returned in the tool result; nothing is written to stdout except
//   the MCP transport (serve() also points console.log at stderr as a safety net).
// - Device-changing tools need our own lease (strict); emu_status and emu_screenshot change nothing.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import type { Adb } from "./adb.ts";
import { movedClockSerials, resetClock, resetMovedClocks, timeTravel, type ClockOptions } from "./clock.ts";
import { resolveLocations, type Locations } from "./config.ts";
import { connect } from "./context.ts";
import { getStatus, releaseEmulator, renew, startEmulator, type EmulatorDeps } from "./emulator.ts";
import { EmuError } from "./errors.ts";
import { JOB_MAX_WAIT_SEC, JOB_TAIL_LINES, JobRegistry, formatError, type JobView } from "./jobs.ts";
import { busyMessage, isLeaseValid, leasePath, readLease, sameOwner } from "./lease.ts";
import { checkNotification, type NotificationDeps } from "./notification.ts";
import { getOwner } from "./owner.ts";
import { runSmoke, type SmokeDeps } from "./smoke.ts";
import type { Report } from "./types.ts";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.ts";
import { killLiveBrowsers } from "./webgl/browser.ts";
import { runWebglSmoke } from "./webgl/smoke.ts";

export type AdbFactory = (loc: Locations, env: NodeJS.ProcessEnv) => Adb;

/** Test injection points (not exposed over MCP). */
export interface ServerDeps {
  emulator?: Omit<EmulatorDeps, "adbFactory">;
  smoke?: Omit<SmokeDeps, "adbFactory">;
  notification?: Omit<NotificationDeps, "adbFactory">;
  clock?: ClockOptions;
  /** emu_clock / emu_screenshot: how long to wait for the AVD in adb devices (default 30 s). */
  connectWaitSec?: number;
  /** Share or inspect the job registry. */
  jobs?: JobRegistry;
}

export interface ServerOptions {
  /** Environment for every call (default process.env, read at call time). */
  env?: NodeJS.ProcessEnv;
  /** Tests inject the fake adb. */
  adbFactory?: AdbFactory;
  deps?: ServerDeps;
}

const DEFAULT_WAIT_SEC = 50;
/** emu_release has no wait_sec input; it waits this long before handing back a job id. */
const RELEASE_WAIT_SEC = 50;

const INSTRUCTIONS = `Self-test Unity Android builds on a local Android emulator (one AVD, default "unity-test"), shared safely by several AI sessions on this PC through a lease file.
- Take the device first with emu_start (boots or reuses the AVD and leases it to this session). Every device-changing tool needs that lease.
- BUSY means another session is using the emulator: do not install, tap or change anything; wait and try again later, or ask the person. Never release someone else's lease (only the person can, with the CLI emu-lab release --any-owner).
- Always call emu_release when you are done (uninstall=true also removes the apps installed under the lease). emu_renew extends the lease (default 4 h) for long sessions.
- emu_smoke installs an APK and checks it from outside the app: ready marker in logcat, crash or self-exit, ABI, system dialogs, tap, local notification in the shade and tapping back in. Its defaults are the bundled sample app's log lines (SMOKE_APP_READY, SMOKE_TAP count=1, SMOKE_NOTIF_SCHEDULED id=<n> title=<t>, SMOKE_OPENED_FROM_NOTIFICATION): for another app set ready_marker (a line your app logs when ready), no_tap or tap_marker, and notif_delay 0 unless it schedules a notification the same way.
- emu_start, emu_smoke, emu_check_notification and emu_release run as jobs: if the call returns a job_id, call emu_job with that id (repeat while status is running). Never start the same tool again while its job runs; one device-changing job per AVD runs at a time.
- emu_clock forward moves the device clock for long-delay notifications; always call emu_clock reset afterwards (if this server stops first, it puts the clock back itself).
- Do not drive the device with mobile-mcp (or anything else using UiAutomation) while emu_smoke or emu_check_notification runs: they need UiAutomation for the notification shade and system dialogs.
- Device audio stays off. emu_status and emu_screenshot change nothing and work without a lease.
- emu_webgl_smoke tests a Unity WebGL build folder in a local headless or windowed Chrome/Edge/Chromium (throwaway profile, audio muted). It needs no emulator and no lease, and also runs as a job (emu_job). For a build that is not the bundled sample set ready_mode (loaded for Unity's Default template) or ready_marker, and no_tap or tap_marker.`;

// ---------------------------------------------------------------------------------------------------
// Device operations shared with the CLI

function resolveAvd(avd: string | undefined, env: NodeJS.ProcessEnv): string {
  return (avd ?? "").trim() || resolveLocations({ env }).avd;
}

export interface ClockForwardResult {
  action: "forward";
  avd: string;
  serial: string;
  minutes: number;
  before_ms: number;
  after_ms: number;
  delta_min: number;
  next: string;
}

export interface ClockResetResult {
  action: "reset";
  avd: string;
  serial: string;
  before_ms: number;
  after_ms: number;
}

interface DeviceCallOptions {
  avd?: string;
  owner?: string;
  env?: NodeJS.ProcessEnv;
  report: Report;
  adbFactory?: AdbFactory;
  clock?: ClockOptions;
  waitSec?: number;
}

/** Move the device clock `minutes` forward (needs our lease: strict over MCP, warn or strict in the CLI). */
export async function clockForward(o: DeviceCallOptions & { minutes: number | undefined; leaseMode: "strict" | "warn" }): Promise<ClockForwardResult> {
  const minutes = o.minutes;
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) {
    throw new EmuError("BAD_OPTION", `clock forward needs minutes > 0 (got ${minutes ?? "none"}). To go back use the clock reset.`);
  }
  const ctx = await connect({
    avd: o.avd,
    owner: o.owner,
    env: o.env,
    report: o.report,
    leaseMode: o.leaseMode,
    waitSec: o.waitSec,
    adbFactory: o.adbFactory,
  });
  // Whose time travel it is: a shutdown reset checks the AVD and the lease before it puts the clock back.
  const r = await timeTravel(ctx.adb, minutes, o.report, {
    ...(o.clock ?? {}),
    target: { avd: ctx.avd, leaseFile: ctx.leaseFile, owner: ctx.owner },
  });
  return {
    action: "forward",
    avd: ctx.avd,
    serial: ctx.serial,
    minutes,
    before_ms: r.beforeMs,
    after_ms: r.afterMs,
    delta_min: r.deltaMin,
    next: "Always reset the clock afterwards (emu_clock action reset / emu-lab clock reset), also after a failed check.",
  };
}

/**
 * Put the device clock back to host time with automatic time on. Allowed without a lease (a crashed run may have
 * left the clock moved); refused only while another owner holds a valid lease.
 */
export async function clockReset(o: DeviceCallOptions): Promise<ClockResetResult> {
  const env = o.env ?? process.env;
  const loc = resolveLocations({ env });
  const avd = (o.avd ?? "").trim() || loc.avd;
  const owner = (o.owner ?? "").trim() || getOwner(env);
  const lease = await readLease(leasePath(loc, avd));
  if (lease && isLeaseValid(lease) && !sameOwner(lease.owner, owner)) throw new EmuError("BUSY", busyMessage(lease, avd));
  const ctx = await connect({ avd, owner, env, report: o.report, leaseMode: "none", waitSec: o.waitSec, adbFactory: o.adbFactory });
  const r = await resetClock(ctx.adb, o.report, o.clock);
  return { action: "reset", avd: ctx.avd, serial: ctx.serial, before_ms: r.beforeMs, after_ms: r.afterMs };
}

/** Width and height from a PNG's IHDR chunk, or null. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47 || png.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** A PNG of the AVD's screen. Changes nothing and needs no lease. */
export async function captureScreenshot(o: DeviceCallOptions): Promise<{ avd: string; serial: string; png: Buffer; width: number | null; height: number | null }> {
  const ctx = await connect({
    avd: o.avd,
    owner: o.owner,
    env: o.env,
    report: o.report,
    leaseMode: "none",
    waitSec: o.waitSec,
    adbFactory: o.adbFactory,
  });
  const png = await ctx.adb.screencap();
  const size = pngSize(png);
  return { avd: ctx.avd, serial: ctx.serial, png, width: size?.width ?? null, height: size?.height ?? null };
}

// ---------------------------------------------------------------------------------------------------
// Tool results

function collector(): { report: Report; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    report: (line: string) => {
      for (const l of String(line).split(/\r?\n/)) lines.push(l);
    },
  };
}

function withLines(text: string, lines: string[], header = "report"): string {
  const tail = lines.slice(-JOB_TAIL_LINES);
  if (!tail.length) return text;
  return `${text}\n\n${header} (last ${tail.length} lines):\n${tail.join("\n")}`;
}

function ok(result: unknown, lines: string[]): CallToolResult {
  return { content: [{ type: "text", text: withLines(JSON.stringify(result, null, 2), lines) }] };
}

function fail(err: unknown, lines: string[]): CallToolResult {
  return { content: [{ type: "text", text: withLines(formatError(err), lines) }], isError: true };
}

async function guard(fn: (report: Report) => Promise<unknown>): Promise<CallToolResult> {
  const c = collector();
  try {
    return ok(await fn(c.report), c.lines);
  } catch (err) {
    return fail(err, c.lines);
  }
}

function jobResult(v: JobView): CallToolResult {
  const header = `report of job ${v.id}, ${v.status} after ${v.elapsed_sec} s`;
  if (v.status === "done") {
    return { content: [{ type: "text", text: withLines(JSON.stringify(v.result, null, 2), v.lines, header) }] };
  }
  if (v.status === "failed") {
    return { content: [{ type: "text", text: withLines(v.error ?? "failed", v.lines, header) }], isError: true };
  }
  const running = {
    job_id: v.id,
    kind: v.kind,
    avd: v.avd,
    status: v.status,
    elapsed_sec: v.elapsed_sec,
    next: `Still running. Call emu_job with job_id "${v.id}" (wait_sec up to ${JOB_MAX_WAIT_SEC}) to wait for the result; do not start the same tool again.`,
  };
  return { content: [{ type: "text", text: withLines(JSON.stringify(running, null, 2), v.lines, header) }] };
}

// ---------------------------------------------------------------------------------------------------
// Schemas shared by several tools

const avdSchema = z
  .string()
  .min(1)
  .optional()
  .describe('AVD name (default "unity-test", or the EMU_AVD environment variable of the server).');

const waitSecSchema = z
  .number()
  .int()
  .min(0)
  .max(JOB_MAX_WAIT_SEC)
  .optional()
  .describe("How long this call waits for the job (default 50, max 600). If the job is still running, the call returns a job_id for emu_job.");

const hoursSchema = z.number().positive().max(168).optional().describe("Lease length in hours from now (default 4).");

export function createServer(o: ServerOptions = {}): McpServer {
  const env = (): NodeJS.ProcessEnv => o.env ?? process.env;
  const deps = o.deps ?? {};
  const jobs = deps.jobs ?? new JobRegistry();
  const adbFactory = o.adbFactory;
  const emulatorDeps = (): EmulatorDeps => ({ ...(deps.emulator ?? {}), adbFactory });

  const server = new McpServer({ name: PACKAGE_NAME, version: PACKAGE_VERSION }, { instructions: INSTRUCTIONS });

  /** Start a device-changing job on `avd` and wait for it (or return its id). */
  async function runJob(kind: string, avdInput: string | undefined, waitSec: number, fn: (report: Report, avd: string) => Promise<unknown>): Promise<CallToolResult> {
    let id: string;
    let avd: string;
    try {
      avd = resolveAvd(avdInput, env());
      id = jobs.startJob(kind, (report) => fn(report, avd), { avd });
    } catch (err) {
      return fail(err, []);
    }
    return jobResult(await jobs.waitJob(id, waitSec));
  }

  // Every tool spells out all four MCP hints as literals; test/tools.test.ts pins the values. Descriptions stay
  // single string literals (static scanners do not read ones joined with `+`).

  server.registerTool(
    "emu_status",
    {
      title: "Emulator status",
      description:
        "Show the lease of the AVD (owner, until, valid, mine), the running emulators, the AVD's serial and boot state, the adb version and the resolved paths (SDK root, AVD home, adb, lab home). Changes nothing and needs no lease. If the lease belongs to another owner and is valid, the emulator is BUSY: wait or ask the person, do not use it.",
      inputSchema: { avd: avdSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ avd }) => guard(() => getStatus({ avd, env: env(), deps: emulatorDeps() })),
  );

  server.registerTool(
    "emu_start",
    {
      title: "Take and boot the emulator",
      description:
        "Lease the AVD to this session and boot it (or reuse it when it already runs), then make it predictable for automation (animations off, screen stays on, keyguard dismissed, clock reset). Call this before any other device-changing tool. On BUSY another session holds the emulator: do not retry in a loop and never release its lease; wait, or ask the person. Runs as a job: if the result is a job_id, call emu_job with it. Calling it again under your own lease only renews the lease. Always call emu_release when done.",
      inputSchema: {
        avd: avdSchema,
        hours: hoursSchema,
        headless: z.boolean().optional().describe("Start the emulator without a window (default false)."),
        cold_boot: z.boolean().optional().describe("Ignore the quick-boot snapshot (slower, a clean boot; default false)."),
        boot_timeout_sec: z.number().int().positive().max(1800).optional().describe("Time for the emulator to appear and finish booting (default 300)."),
        wait_sec: waitSecSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ avd, hours, headless, cold_boot, boot_timeout_sec, wait_sec }) =>
      runJob("start", avd, wait_sec ?? DEFAULT_WAIT_SEC, (report, a) =>
        startEmulator({
          avd: a,
          hours,
          headless,
          coldBoot: cold_boot,
          bootTimeoutSec: boot_timeout_sec,
          env: env(),
          report,
          deps: emulatorDeps(),
        }),
      ),
  );

  server.registerTool(
    "emu_renew",
    {
      title: "Renew the lease",
      description:
        "Extend this session's lease of the AVD (default 4 hours from now), also after it ran out. Refused with NO_LEASE when there is no lease (take it with emu_start) and NOT_OWNER when the lease is another session's (then the emulator is busy: wait or ask the person). Does not touch the device.",
      inputSchema: { avd: avdSchema, hours: hoursSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ avd, hours }) =>
      guard(async (report) => {
        const lease = await renew({ avd, hours, env: env() });
        report(`LEASE renewed avd=${lease.avd} owner=${lease.owner} until=${lease.expiresAt}`);
        return lease;
      }),
  );

  server.registerTool(
    "emu_release",
    {
      title: "Give the emulator back",
      description:
        "Give back this session's lease when you are done: resets what test runs leave on the device (Firebase debug properties, a moved clock), uninstalls the apps installed under the lease when uninstall is true (or the listed packages), stops the emulator only if this lease started it (unless keep_running), then deletes the lease. Refused with NOT_OWNER for another session's lease: never try to release it, the person does that. No lease is not an error (released false). LEASE_CHANGED means another session took the lease over meanwhile: leave the emulator alone. Runs as a job: if the result is a job_id, call emu_job with it.",
      inputSchema: {
        avd: avdSchema,
        uninstall: z.boolean().optional().describe("Uninstall the apps installed under this lease (default false: they stay with their data)."),
        packages: z.array(z.string().min(1)).optional().describe("Uninstall these package names instead of the recorded ones (needs uninstall true)."),
        keep_running: z.boolean().optional().describe("Leave the emulator running even if this lease started it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ avd, uninstall, packages, keep_running }) =>
      runJob("release", avd, RELEASE_WAIT_SEC, (report, a) =>
        releaseEmulator({ avd: a, uninstall, packages, keepRunning: keep_running, env: env(), report, deps: emulatorDeps() }),
      ),
  );

  server.registerTool(
    "emu_smoke",
    {
      title: "Smoke-test an APK",
      description:
        "Install an APK on the leased emulator and self-test it from outside the app: ABI check, install, launch, wait for the ready marker in logcat (crash, ANR or self-exit fail the run), tap, background, local notification in the shade, tap it and check the app opens. Results (summary.json, logcat, screenshots) go to run_dir; check pass in the result. Needs this session's lease (emu_start first): NO_LEASE means take it, BUSY means another session uses the emulator (wait or ask the person). Defaults are the bundled sample app's log lines; for another app set ready_marker, no_tap or tap_marker, and notif_delay 0. Runs as a job: if the result is a job_id, call emu_job with it and do not start another smoke meanwhile. Do not use mobile-mcp while it runs.",
      inputSchema: {
        apk: z.string().min(1).describe("Path to the .apk file on this PC."),
        package: z.string().min(1).optional().describe("Package name (default: read from the APK; a mismatch is an error)."),
        ready_marker: z.string().min(1).optional().describe('Text the app logs when it is ready (default "SMOKE_APP_READY").'),
        ready_timeout_sec: z.number().positive().optional().describe("How long to wait for the ready marker (default 120)."),
        tap_x: z.number().min(0).max(1).optional().describe("Tap position as a fraction of the screen width (default 0.5)."),
        tap_y: z.number().min(0).max(1).optional().describe("Tap position as a fraction of the screen height (default 0.5)."),
        tap_marker: z.string().min(1).optional().describe('Text the app logs when the tap lands (default "SMOKE_TAP count=1").'),
        no_tap: z.boolean().optional().describe("Skip the tap step."),
        no_tap_check: z.boolean().optional().describe("Tap, but do not wait for tap_marker."),
        notif_delay: z.number().int().min(0).optional().describe("Seconds passed to the app as --es notif_delay (default 20); 0 skips the notification check."),
        notif_scheduled_regex: z
          .string()
          .min(1)
          .optional()
          .describe('Regex over logcat whose capture group 1 is the notification title (default "SMOKE_NOTIF_SCHEDULED id=\\d+ title=(\\S+)"). JavaScript regex syntax; a leading (?i), (?m) or (?s) is allowed, and groups are numbered as in .NET (unnamed groups first), so PowerShell -NotifScheduledRegex values pick the same title.'),
        opened_marker: z.string().min(1).optional().describe('Text the app logs when opened from the notification (default "SMOKE_OPENED_FROM_NOTIFICATION").'),
        no_opened_marker: z.boolean().optional().describe("The app logs nothing when opened: opened means its activity is resumed after the tap."),
        notif_timeout_sec: z.number().positive().optional().describe("How long to wait for the notification (default 240)."),
        time_travel_minutes: z
          .number()
          .min(0)
          .optional()
          .describe("Jump the device clock this many minutes forward after scheduling (long-delay notifications); always reset afterwards."),
        ask_permission: z.boolean().optional().describe("Revoke POST_NOTIFICATIONS first so the system permission dialog shows again."),
        avd: avdSchema,
        wait_sec: waitSecSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (a) =>
      runJob("smoke", a.avd, a.wait_sec ?? DEFAULT_WAIT_SEC, (report, avd) =>
        runSmoke({
          apk: a.apk,
          package: a.package,
          readyMarker: a.ready_marker,
          readyTimeoutSec: a.ready_timeout_sec,
          tapX: a.tap_x,
          tapY: a.tap_y,
          tapMarker: a.tap_marker,
          noTap: a.no_tap,
          noTapCheck: a.no_tap_check,
          notifDelay: a.notif_delay,
          notifScheduledRegex: a.notif_scheduled_regex,
          openedMarker: a.opened_marker,
          noOpenedMarker: a.no_opened_marker,
          notifTimeoutSec: a.notif_timeout_sec,
          timeTravelMinutes: a.time_travel_minutes,
          askPermission: a.ask_permission,
          avd,
          env: env(),
          leaseMode: "strict",
          report,
          deps: { ...(deps.smoke ?? {}), adbFactory },
        }),
      ),
  );

  server.registerTool(
    "emu_check_notification",
    {
      title: "Check a notification",
      description:
        "Wait until a notification of the package whose title contains title is posted (dumpsys) and visible in the shade, optionally tap it and check the app opens (tap, opened_marker). Use it after the app scheduled a notification yourself (for example with emu_smoke notif_delay 0 and emu_clock forward). Needs this session's lease: NO_LEASE means emu_start first, BUSY means another session uses the emulator (wait or ask the person). Runs as a job: if the result is a job_id, call emu_job with it. Do not use mobile-mcp while it runs.",
      inputSchema: {
        package: z.string().min(1).describe("Package name of the app that posts the notification."),
        title: z.string().min(1).describe("Plain substring of the notification title."),
        timeout_sec: z.number().positive().optional().describe("How long to wait for the notification (default 240)."),
        since_ms: z.number().optional().describe("Device epoch ms; only notifications posted at or after it count (default: device time when the check starts)."),
        tap: z.boolean().optional().describe("Tap the notification in the shade and check the app opens."),
        opened_marker: z.string().min(1).optional().describe("Text the app logs when opened from the notification (with tap)."),
        avd: avdSchema,
        wait_sec: waitSecSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (a) =>
      runJob("notification", a.avd, a.wait_sec ?? DEFAULT_WAIT_SEC, (report, avd) =>
        checkNotification({
          package: a.package,
          title: a.title,
          timeoutSec: a.timeout_sec,
          sinceMs: a.since_ms,
          tap: a.tap,
          openedMarker: a.opened_marker,
          avd,
          env: env(),
          leaseMode: "strict",
          report,
          deps: { ...(deps.notification ?? {}), adbFactory },
        }),
      ),
  );

  server.registerTool(
    "emu_clock",
    {
      title: "Move or reset the device clock",
      description:
        'action "forward" turns automatic time off and moves the device clock minutes ahead, so long-delay local notifications fire now (needs this session\'s lease: NO_LEASE means emu_start first). action "reset" puts the clock back to host time with automatic time on; it works without a lease and is refused only while another session holds the emulator (BUSY: wait or ask the person). After a forward always call reset, also when the check failed.',
      inputSchema: {
        action: z.enum(["forward", "reset"]).describe('"forward" (needs minutes) or "reset".'),
        minutes: z.number().positive().optional().describe("forward: minutes to move ahead (for Unity notifications: past fire time + 1 h)."),
        avd: avdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ action, minutes, avd }) =>
      guard(async (report) => {
        const e = env();
        const a = resolveAvd(avd, e);
        const common = { avd: a, env: e, report, adbFactory, clock: deps.clock, waitSec: deps.connectWaitSec };
        // Held as a device-changing job on the AVD for the whole call (JOB_RUNNING both ways), but answered inline.
        return jobs.runExclusive<ClockForwardResult | ClockResetResult>(`clock-${action}`, a, () =>
          action === "forward" ? clockForward({ ...common, minutes, leaseMode: "strict" }) : clockReset(common),
        );
      }),
  );

  server.registerTool(
    "emu_screenshot",
    {
      title: "Screenshot",
      description:
        "Return a PNG screenshot of the AVD's screen (and its serial and size). Changes nothing and needs no lease; it works while another session holds the emulator, but then only look, do not act on it.",
      inputSchema: { avd: avdSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ avd }) => {
      const c = collector();
      try {
        const shot = await captureScreenshot({ avd, env: env(), report: c.report, adbFactory, waitSec: deps.connectWaitSec });
        const size = shot.width !== null ? `${shot.width}x${shot.height}` : "unknown";
        return {
          content: [
            { type: "image", data: shot.png.toString("base64"), mimeType: "image/png" },
            { type: "text", text: withLines(`SCREENSHOT avd=${shot.avd} serial=${shot.serial} size=${size} bytes=${shot.png.length}`, c.lines) },
          ],
        };
      } catch (err) {
        return fail(err, c.lines);
      }
    },
  );

  server.registerTool(
    "emu_webgl_smoke",
    {
      title: "Smoke-test a WebGL build",
      description:
        "Serve a Unity WebGL build folder on localhost and open it in Chrome, Edge or Chromium (its own throwaway profile, audio muted) over DevTools: wait until it is ready (ready_mode marker = a console line, loaded = Unity Default template's loading bar is done, expression = JavaScript), click or touch the canvas, then collect console errors, exceptions, dialogs, the Unity error banner, a renderer crash and screenshots. Results (summary.json, console.txt, PNGs) go to run_dir; check pass in the result. Needs no emulator and no lease. Defaults are the bundled sample's console lines (SMOKE_APP_READY, SMOKE_TAP count=1); for another build set ready_mode or ready_marker, and no_tap or tap_marker. Runs as a job: if the result is a job_id, call emu_job with it and do not start the same test again meanwhile.",
      inputSchema: {
        build_dir: z.string().min(1).describe("The WebGL build folder on this PC (holds index.html)."),
        ready_mode: z.enum(["marker", "loaded", "expression"]).optional().describe('How to tell the build is ready (default "marker").'),
        ready_marker: z.string().min(1).optional().describe('ready_mode marker: text the build logs to the console when ready (default "SMOKE_APP_READY").'),
        ready_expression: z.string().min(1).optional().describe("ready_mode expression: JavaScript that is truthy once the page is ready (use single quotes inside)."),
        ready_timeout_sec: z.number().positive().optional().describe("How long to wait until ready (default 180)."),
        tap_x: z.number().min(0).max(1).optional().describe("Tap position as a fraction of the canvas width (default 0.5)."),
        tap_y: z.number().min(0).max(1).optional().describe("Tap position as a fraction of the canvas height (default 0.5)."),
        tap_marker: z.string().min(1).optional().describe('Console text the build logs when the tap lands (default "SMOKE_TAP count=1").'),
        tap_expression: z.string().min(1).optional().describe("Instead of tap_marker: JavaScript that is truthy once the tap took effect."),
        tap_timeout_sec: z.number().positive().optional().describe("How long to wait for the tap to take effect (default 5)."),
        tap_retry_sec: z.number().min(0).optional().describe("With tap_expression: tap again every N s until it is truthy, within tap_timeout_sec (a title screen that ignores input during its intro)."),
        after_tap_expression: z.string().min(1).optional().describe("JavaScript awaited once after the tap was accepted (no more taps)."),
        after_tap_timeout_sec: z.number().positive().optional().describe("How long to wait for after_tap_expression (default 120)."),
        settle_sec: z.number().min(0).optional().describe("Final wait before the last screenshot and the summary (default 2)."),
        fail_expression: z.string().min(1).optional().describe("JavaScript returning a non-empty string when the page shows its own error UI (fails the run)."),
        info_expression: z.string().min(1).optional().describe("JavaScript whose value is recorded as page_info."),
        no_tap: z.boolean().optional().describe("Skip the tap step."),
        no_tap_check: z.boolean().optional().describe("Tap, but do not wait for tap_marker or tap_expression."),
        tap_input: z.enum(["mouse", "touch"]).optional().describe('"mouse" (default) or "touch" (touch emulation on).'),
        width: z.number().int().min(100).max(8192).optional().describe("Viewport width in CSS px (default 1280)."),
        height: z.number().int().min(100).max(8192).optional().describe("Viewport height in CSS px (default 900)."),
        headless: z.boolean().optional().describe("Run the browser without a window (default false)."),
        browser: z.string().min(1).optional().describe("Browser executable (default EMU_BROWSER, CHROME_PATH, then the usual Chrome, Edge and Chromium locations)."),
        browser_args: z.array(z.string().min(1)).optional().describe('More browser switches, e.g. ["--no-sandbox"].'),
        gpu: z.enum(["auto", "host", "swiftshader"]).optional().describe('"auto" (default): SwiftShader (software WebGL) for a headless run on a Linux host without a display, else the host GPU.'),
        no_isolation: z.boolean().optional().describe("Serve without COOP/COEP (a single-threaded build whose template loads cross-origin files without CORP/CORS, or to match a host such as GitHub Pages)."),
        keep_profile: z.boolean().optional().describe("Keep the throwaway browser profile in run_dir (tens of MB) for debugging."),
        fail_on_console_error: z.boolean().optional().describe("Every console error fails the run, not only the fatal ones (default false)."),
        ignore_errors: z.string().min(1).optional().describe("Regex (JavaScript, case-insensitive): console errors and exceptions that match are ignored, e.g. a third-party analytics script."),
        fail_on_blank: z.boolean().optional().describe("Fail when the canvas in the final screenshot is a single flat colour (nothing drawn). canvas_blank is recorded either way."),
        wait_sec: waitSecSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (a) => {
      let id: string;
      try {
        id = jobs.startJob("webgl", (report) =>
          runWebglSmoke({
            buildDir: a.build_dir,
            readyMode: a.ready_mode,
            readyMarker: a.ready_marker,
            readyExpression: a.ready_expression,
            readyTimeoutSec: a.ready_timeout_sec,
            tapX: a.tap_x,
            tapY: a.tap_y,
            tapMarker: a.tap_marker,
            tapExpression: a.tap_expression,
            tapTimeoutSec: a.tap_timeout_sec,
            tapRetrySec: a.tap_retry_sec,
            afterTapExpression: a.after_tap_expression,
            afterTapTimeoutSec: a.after_tap_timeout_sec,
            settleSec: a.settle_sec,
            failExpression: a.fail_expression,
            infoExpression: a.info_expression,
            noTap: a.no_tap,
            noTapCheck: a.no_tap_check,
            tapInput: a.tap_input,
            width: a.width,
            height: a.height,
            headless: a.headless,
            browser: a.browser,
            browserArgs: a.browser_args,
            gpu: a.gpu,
            noIsolation: a.no_isolation,
            keepProfile: a.keep_profile,
            failOnConsoleError: a.fail_on_console_error,
            ignoreErrors: a.ignore_errors,
            failOnBlank: a.fail_on_blank,
            env: env(),
            report,
          }),
        );
      } catch (err) {
        return fail(err, []);
      }
      return jobResult(await jobs.waitJob(id, a.wait_sec ?? DEFAULT_WAIT_SEC));
    },
  );

  server.registerTool(
    "emu_job",
    {
      title: "Wait for a job",
      description:
        "Wait for a job started by emu_start, emu_smoke, emu_check_notification, emu_release or emu_webgl_smoke (job_id from their result) and return its result once it finished, or its status and latest report lines while it still runs (then call emu_job again). Without job_id it lists this server's jobs. JOB_UNKNOWN means the id is not known to this server (jobs do not survive a server restart): list the jobs or check emu_status.",
      inputSchema: {
        job_id: z.string().min(1).optional().describe("The job_id to wait for; omit to list the jobs."),
        wait_sec: z.number().int().min(0).max(JOB_MAX_WAIT_SEC).optional().describe("How long to wait for the job to finish (default 50, max 600)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ job_id, wait_sec }) => {
      if (!job_id) return ok({ jobs: jobs.list() }, []);
      try {
        return jobResult(await jobs.waitJob(job_id, wait_sec ?? DEFAULT_WAIT_SEC));
      } catch (err) {
        return fail(err, []);
      }
    },
  );

  return server;
}

/** How long a stopping process spends putting back moved device clocks. */
export const SHUTDOWN_CLOCK_RESET_MS = 20_000;
/** Hard limit for the whole shutdown (then exit anyway). */
export const SHUTDOWN_MAX_MS = 25_000;

/**
 * The shutdown of a process that may have moved a device clock (MCP server, CLI device command): close, put back
 * every clock this process moved and has not reset (bounded), then exit. Running jobs are not waited for: their
 * own finally blocks would never run once the process exits, so the clock reset is done here instead. A second call
 * does nothing.
 */
export function makeShutdown(o: {
  close?: () => Promise<void>;
  exit: (code: number) => void;
  log: (line: string) => void;
  code?: number;
  clockResetMs?: number;
  maxMs?: number;
}): (why: string) => Promise<void> {
  let started: Promise<void> | null = null;
  return (why: string) => {
    if (started) return started;
    const code = o.code ?? 0;
    o.log(`${PACKAGE_NAME}: shutting down (${why}).`);
    // Never hang: exit after the hard limit even if adb does not answer.
    setTimeout(() => o.exit(code), o.maxMs ?? SHUTDOWN_MAX_MS).unref();
    started = (async () => {
      try {
        await o.close?.();
      } catch (err) {
        o.log(`${PACKAGE_NAME}: close failed: ${(err as Error).message}`);
      }
      // A WebGL smoke's browser would outlive us (its finally block never runs once the process exits).
      const browsers = killLiveBrowsers();
      if (browsers) o.log(`${PACKAGE_NAME}: stopped ${browsers} browser(s) of a running WebGL smoke test.`);
      if (movedClockSerials().length) {
        await resetMovedClocks((line) => o.log(`${PACKAGE_NAME}: ${line}`), { timeoutMs: o.clockResetMs ?? SHUTDOWN_CLOCK_RESET_MS });
      }
    })().finally(() => o.exit(code));
    return started;
  };
}

/** Run the MCP server on stdio until stdin closes. Nothing but the transport writes to stdout. */
export async function serve(o: ServerOptions = {}): Promise<void> {
  // A stray console.log would corrupt the JSON-RPC stream: send it to stderr.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  const server = createServer(o);
  const shutdown = makeShutdown({ close: () => server.close(), exit: (code) => process.exit(code), log: (line) => console.error(line) });
  process.stdin.on("end", () => void shutdown("stdin ended"));
  process.stdin.on("close", () => void shutdown("stdin closed"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  if (process.platform === "win32") process.on("SIGBREAK", () => void shutdown("SIGBREAK"));
  await server.connect(new StdioServerTransport());
  console.error(`${PACKAGE_NAME} ${PACKAGE_VERSION}: MCP server ready on stdio.`);
}
