// The `emu-lab` command line. Report lines go to stdout as they happen; errors go to stderr as "<CODE>: message".
// Exit codes: 0 ok / pass, 1 failed or refused, 2 usage error. The lease check is "warn" (like the PowerShell
// scripts) unless --strict. --json prints the result object as JSON on the last stdout line.

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { resolveLocations } from "./config.ts";
import { getStatus, releaseEmulator, renew, startEmulator, type StatusResult } from "./emulator.ts";
import { formatError } from "./jobs.ts";
import { checkNotification } from "./notification.ts";
import { runStamp } from "./rundir.ts";
import { captureScreenshot, clockForward, clockReset, makeShutdown, serve, type AdbFactory } from "./server.ts";
import { runSmoke } from "./smoke.ts";
import type { Report } from "./types.ts";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.ts";

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  /**
   * Catch Ctrl+C / SIGTERM / SIGBREAK while a device command runs: put back a device clock this run moved, then exit
   * 130 (the default io does; tests leave it off).
   */
  handleSignals?: boolean;
  /** Tests: the fake adb for smoke, notification, clock and screenshot (not a command-line option). */
  adbFactory?: AdbFactory;
}

const defaultIo = (): CliIo => ({
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  handleSignals: true,
});

/** Signals that end a CLI device command; the handler resets moved clocks first. Returns the uninstaller. */
function installSignalHandlers(err: (line: string) => void): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", ...(process.platform === "win32" ? (["SIGBREAK"] as NodeJS.Signals[]) : [])];
  const shutdown = makeShutdown({ exit: (code) => process.exit(code), log: err, code: 130 });
  const handler = (sig: NodeJS.Signals): void => {
    void shutdown(sig);
  };
  for (const s of signals) process.on(s, handler);
  return () => {
    for (const s of signals) process.off(s, handler);
  };
}

export const USAGE = `${PACKAGE_NAME} ${PACKAGE_VERSION}: self-test Unity Android builds on a local emulator, shared by several sessions through a lease.

Usage: emu-lab <command> [options]

Commands:
  status                     Lease, running emulators, boot state, paths and adb version (changes nothing)
  start                      Lease the AVD and boot it (or reuse it)
      --hours <h>            lease length (default 4)      --headless     no emulator window
      --cold-boot            ignore the quick-boot snapshot --audio       keep device audio (default off)
      --boot-timeout <s>     time to boot (default 300)
  renew [--hours <h>]        Extend this session's lease
  release                    Reset the device, stop the emulator if this lease started it, delete the lease
      --uninstall            uninstall the apps installed under the lease
      --package <id>         uninstall this package instead (repeatable, needs --uninstall)
      --keep-running         leave the emulator running
      --any-owner            (the person only) release another session's lease
      --stale                (the person only) drop a lease that ran out; the device is not touched
  smoke <apk>                Install the APK and self-test it (ready marker, crash/exit, tap, notification)
      --package <id> --ready-marker <text> --ready-timeout <s> --tap-x <0..1> --tap-y <0..1>
      --tap-marker <text> --no-tap --no-tap-check --notif-delay <s> --notif-scheduled-regex <re>
      --opened-marker <text> --no-opened-marker --notif-timeout <s> --time-travel <minutes>
      --ask-permission --out <dir> --strict
  notification               Wait for a notification in the shade (and tap it)
      --package <id> --title <text> [--timeout <s>] [--since-ms <ms>] [--tap] [--opened-marker <text>]
      [--out <dir>] [--strict]
  clock forward <minutes>    Move the device clock ahead (always run clock reset afterwards) [--strict]
  clock reset                Put the device clock back to host time
  screenshot [file]          Save a PNG of the screen (default <lab home>/runs/<stamp>-screenshot-<pid>.png)
  serve                      Run the MCP server on stdio (also: no command with stdin not a terminal)
  help                       This text
  version                    Print the version (-v, --version)

Global options:
  --avd <name>               AVD (default unity-test or EMU_AVD)
  --owner <name>             lease owner (default EMU_OWNER, the Claude/Codex session, or user@host)
  --json                     print the result object as JSON on the last line

Exit codes: 0 ok/pass, 1 failed or refused (BUSY, NO_LEASE, ...), 2 usage error.
Without a lease the device commands warn (LEASE_NONE) and go on; --strict refuses instead.`;

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  json: { type: "boolean" },
  avd: { type: "string" },
  owner: { type: "string" },
  hours: { type: "string" },
  headless: { type: "boolean" },
  "cold-boot": { type: "boolean" },
  audio: { type: "boolean" },
  "boot-timeout": { type: "string" },
  uninstall: { type: "boolean" },
  package: { type: "string", multiple: true },
  "keep-running": { type: "boolean" },
  "any-owner": { type: "boolean" },
  stale: { type: "boolean" },
  "ready-marker": { type: "string" },
  "ready-timeout": { type: "string" },
  "tap-x": { type: "string" },
  "tap-y": { type: "string" },
  "tap-marker": { type: "string" },
  "no-tap": { type: "boolean" },
  "no-tap-check": { type: "boolean" },
  "notif-delay": { type: "string" },
  "notif-scheduled-regex": { type: "string" },
  "opened-marker": { type: "string" },
  "no-opened-marker": { type: "boolean" },
  "notif-timeout": { type: "string" },
  "time-travel": { type: "string" },
  "ask-permission": { type: "boolean" },
  out: { type: "string" },
  strict: { type: "boolean" },
  title: { type: "string" },
  timeout: { type: "string" },
  "since-ms": { type: "string" },
  tap: { type: "boolean" },
} as const;

type OptionName = keyof typeof OPTIONS;

const GLOBAL: OptionName[] = ["help", "version", "json", "avd", "owner"];

/** Options each command accepts (besides the global ones). */
const COMMAND_OPTIONS: Record<string, OptionName[]> = {
  status: [],
  start: ["hours", "headless", "cold-boot", "audio", "boot-timeout"],
  renew: ["hours"],
  release: ["uninstall", "package", "keep-running", "any-owner", "stale"],
  smoke: [
    "package",
    "ready-marker",
    "ready-timeout",
    "tap-x",
    "tap-y",
    "tap-marker",
    "no-tap",
    "no-tap-check",
    "notif-delay",
    "notif-scheduled-regex",
    "opened-marker",
    "no-opened-marker",
    "notif-timeout",
    "time-travel",
    "ask-permission",
    "out",
    "strict",
  ],
  notification: ["package", "title", "timeout", "since-ms", "tap", "opened-marker", "out", "strict"],
  clock: ["strict"],
  screenshot: [],
  serve: [],
  help: [],
  version: [],
};

/** Positional arguments each command takes: [min, max]. */
const POSITIONALS: Record<string, [number, number]> = {
  status: [0, 0],
  start: [0, 0],
  renew: [0, 0],
  release: [0, 0],
  smoke: [1, 1],
  notification: [0, 0],
  clock: [1, 2],
  screenshot: [0, 1],
  serve: [0, 0],
  help: [0, 0],
  version: [0, 0],
};

class UsageError extends Error {
  readonly code = "USAGE";
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

type Values = { [K in OptionName]?: (typeof OPTIONS)[K] extends { multiple: true } ? string[] : (typeof OPTIONS)[K]["type"] extends "string" ? string : boolean };

function num(values: Values, name: OptionName, o: { int?: boolean } = {}): number | undefined {
  const raw = values[name];
  if (raw === undefined) return undefined;
  const s = String(raw).trim();
  const n = Number(s);
  if (!s || !Number.isFinite(n) || (o.int && !Number.isInteger(n))) {
    throw new UsageError(`--${name} needs ${o.int ? "a whole number" : "a number"} (got '${raw}').`);
  }
  return n;
}

function single(values: Values, name: "package"): string | undefined {
  const list = values[name];
  if (!list || !list.length) return undefined;
  if (list.length > 1) throw new UsageError(`--${name} can be given once for this command.`);
  return list[0];
}

function printStatus(s: StatusResult, out: (line: string) => void): void {
  out(`AVD           ${s.avd}`);
  out(`owner         ${s.owner} (this session)`);
  if (!s.lease) {
    out("lease         none (free: take it with emu-lab start)");
  } else {
    const state = s.lease.valid ? (s.lease.mine ? "valid, yours" : "valid, another session: BUSY") : "ran out";
    out(`lease         ${s.lease.owner} (host ${s.lease.host}) since ${s.lease.acquiredAt} until ${s.lease.expiresAt} [${state}]`);
    if (s.lease.installed.length) out(`installed     ${s.lease.installed.join(", ")}`);
    if (s.lease.startedEmulator) out(`started       this lease started the emulator (pid ${s.lease.emulatorPid ?? "?"})`);
  }
  out(`lease file    ${s.leaseFile}`);
  out(`adb           ${s.paths.adb} (${s.paths.adbSource})`);
  if (s.adbVersion) {
    out(`adb version   ${s.adbVersion}`);
    out(`emulators     ${s.emulators.length ? s.emulators.map((e) => `${e.serial}=${e.avd ?? "?"}`).join(", ") : "none"}`);
    out(`serial        ${s.serial ?? "not running"}`);
    if (s.serial) out(`boot          ${s.bootCompleted ? "completed" : "not completed"}`);
  } else {
    out(
      `NO_ADB adb not found or not answering at ${s.paths.adb} (from ${s.paths.adbSource}). Install the Android SDK platform-tools ` +
        `there, or point EMU_ADB (or "adb" in ${s.paths.configPath}) at an adb executable. Emulator state unknown.`,
    );
  }
  out(`sdk root      ${s.paths.sdkRoot} (${s.paths.sdkRootSource})`);
  out(`avd home      ${s.paths.avdHome} (${s.paths.avdHomeSource})`);
  out(`emulator      ${s.paths.emulator}`);
  out(`lab home      ${s.paths.labHome}`);
  if (s.paths.configError) out(`CONFIG_ERROR  ${s.paths.configError} (ignored)`);
}

/**
 * Run one command. Returns the exit code, or null for `serve` (the process keeps running on stdin).
 */
export async function runCli(argv: string[], io: CliIo = defaultIo()): Promise<number | null> {
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }) as unknown as {
      values: Values;
      positionals: string[];
    };
  } catch (err) {
    io.err(`USAGE: ${(err as Error).message}`);
    io.err("Run emu-lab help for the commands and options.");
    return 2;
  }
  const { values, positionals } = parsed;

  if (values.version) {
    io.out(PACKAGE_VERSION);
    return 0;
  }
  const command = positionals[0] ?? "help";
  const args = positionals.slice(1);
  if (values.help || command === "help" || command === "--help") {
    io.out(USAGE);
    return 0;
  }
  if (command === "version") {
    io.out(PACKAGE_VERSION);
    return 0;
  }

  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) {
    io.err(`USAGE: unknown command '${command}'. Run emu-lab help for the commands.`);
    return 2;
  }
  for (const name of Object.keys(values) as OptionName[]) {
    if (values[name] === undefined || GLOBAL.includes(name) || allowed.includes(name)) continue;
    io.err(`USAGE: --${name} is not an option of '${command}'. Run emu-lab help.`);
    return 2;
  }
  const [minPos, maxPos] = POSITIONALS[command];
  if (args.length < minPos || args.length > maxPos) {
    const what = command === "smoke" ? "smoke <apk>" : command === "clock" ? "clock forward <minutes> | clock reset" : command;
    io.err(`USAGE: ${what}: wrong number of arguments (${args.join(" ") || "none"}). Run emu-lab help.`);
    return 2;
  }

  if (command === "serve") {
    await serve({ env: io.env });
    return null;
  }

  const env = io.env;
  const report: Report = (line) => {
    for (const l of String(line).split(/\r?\n/)) io.out(l);
  };
  const avd = values.avd;
  const owner = values.owner;
  const leaseMode = values.strict ? "strict" : "warn";
  let result: unknown;
  let code = 0;
  const removeSignalHandlers = io.handleSignals ? installSignalHandlers(io.err) : () => {};

  try {
    switch (command) {
      case "status": {
        const s = await getStatus({ avd, owner, env });
        if (!values.json) printStatus(s, io.out);
        result = s;
        break;
      }
      case "start":
        result = await startEmulator({
          avd,
          owner,
          hours: num(values, "hours"),
          headless: values.headless,
          coldBoot: values["cold-boot"],
          audio: values.audio,
          bootTimeoutSec: num(values, "boot-timeout"),
          env,
          report,
        });
        break;
      case "renew": {
        const lease = await renew({ avd, owner, hours: num(values, "hours"), env });
        report(`LEASE renewed avd=${lease.avd} owner=${lease.owner} until=${lease.expiresAt}`);
        result = lease;
        break;
      }
      case "release":
        result = await releaseEmulator({
          avd,
          owner,
          uninstall: values.uninstall,
          packages: values.package,
          keepRunning: values["keep-running"],
          anyOwner: values["any-owner"],
          stale: values.stale,
          env,
          report,
        });
        break;
      case "smoke": {
        const summary = await runSmoke({
          apk: args[0],
          package: single(values, "package"),
          readyMarker: values["ready-marker"],
          readyTimeoutSec: num(values, "ready-timeout"),
          tapX: num(values, "tap-x"),
          tapY: num(values, "tap-y"),
          tapMarker: values["tap-marker"],
          noTap: values["no-tap"],
          noTapCheck: values["no-tap-check"],
          notifDelay: num(values, "notif-delay", { int: true }),
          notifScheduledRegex: values["notif-scheduled-regex"],
          openedMarker: values["opened-marker"],
          noOpenedMarker: values["no-opened-marker"],
          notifTimeoutSec: num(values, "notif-timeout"),
          timeTravelMinutes: num(values, "time-travel"),
          askPermission: values["ask-permission"],
          outDir: values.out,
          avd,
          owner,
          env,
          leaseMode,
          report,
          deps: io.adbFactory ? { adbFactory: io.adbFactory } : undefined,
        });
        result = summary;
        if (!summary.pass) code = 1;
        break;
      }
      case "notification": {
        const pkg = single(values, "package");
        if (!pkg) throw new UsageError("notification needs --package <id>.");
        if (!values.title) throw new UsageError("notification needs --title <text>.");
        const r = await checkNotification({
          package: pkg,
          title: values.title,
          timeoutSec: num(values, "timeout"),
          sinceMs: num(values, "since-ms"),
          tap: values.tap,
          openedMarker: values["opened-marker"],
          runDir: values.out,
          avd,
          owner,
          env,
          leaseMode,
          report,
          deps: io.adbFactory ? { adbFactory: io.adbFactory } : undefined,
        });
        result = r;
        if (!r.pass) code = 1;
        break;
      }
      case "clock": {
        const action = args[0];
        if (action === "forward") {
          if (args.length !== 2) throw new UsageError("clock forward <minutes>: give the minutes.");
          const minutes = Number(args[1]);
          if (!Number.isFinite(minutes) || minutes <= 0) throw new UsageError(`clock forward needs minutes > 0 (got '${args[1]}').`);
          result = await clockForward({ avd, owner, env, report, minutes, leaseMode, adbFactory: io.adbFactory });
        } else if (action === "reset") {
          if (args.length !== 1) throw new UsageError("clock reset takes no more arguments.");
          if (values.strict) throw new UsageError("--strict is an option of clock forward (reset works without a lease).");
          result = await clockReset({ avd, owner, env, report, adbFactory: io.adbFactory });
        } else {
          throw new UsageError(`clock forward <minutes> | clock reset (got '${action}').`);
        }
        break;
      }
      case "screenshot": {
        const shot = await captureScreenshot({ avd, owner, env, report, adbFactory: io.adbFactory });
        const file = args[0]
          ? path.resolve(args[0])
          : path.join(resolveLocations({ env }).runsDir, `${runStamp()}-screenshot-${process.pid}.png`);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, shot.png);
        const size = shot.width !== null ? `${shot.width}x${shot.height}` : "unknown";
        report(`SCREENSHOT file=${file} serial=${shot.serial} size=${size} bytes=${shot.png.length}`);
        result = { file, avd: shot.avd, serial: shot.serial, width: shot.width, height: shot.height, bytes: shot.png.length };
        break;
      }
      default:
        io.err(`USAGE: unknown command '${command}'.`);
        return 2;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`USAGE: ${err.message}`);
      return 2;
    }
    io.err(formatError(err));
    // Conflicting or invalid options found by the library are usage errors too.
    return (err as { code?: unknown }).code === "BAD_OPTION" ? 2 : 1;
  } finally {
    removeSignalHandlers();
  }

  if (values.json) io.out(JSON.stringify(result));
  return code;
}
