// Test helpers: a fake adb (test/helpers/fake-adb.mjs) bound to an Adb instance, and a temp EMU_LAB_HOME.
// Nothing here touches a real device, emulator or the real ~/.emu-lab.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Adb, type AdbTiming } from "../../src/adb.ts";
import { silent, type Report } from "../../src/types.ts";

export const FAKE_ADB_PATH = fileURLToPath(new URL("./fake-adb.mjs", import.meta.url));
export const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));

export interface FakeRule {
  /** Regex tested against the args joined by spaces (a leading "-s <serial>" removed). */
  match: string;
  stdout?: string;
  stdoutFile?: string;
  stdoutBase64?: string;
  stderr?: string;
  exitCode?: number;
  /** How many calls this rule answers (missing = unlimited). */
  times?: number;
  /** Wait before answering. */
  delayMs?: number;
  /** Tail this file until killed (logcat). */
  stream?: string;
  /** Answer only calls made with "-s <serial>" (to tell two devices apart). */
  serial?: string;
}

/** A second emulator in the bench (another AVD): it must never get a device command. */
export const OTHER_SERIAL = "emulator-5556";

/** Rules that make adb list a second emulator, OTHER_SERIAL running the AVD "personal" (put them first). */
export function otherDeviceRules(): FakeRule[] {
  return [{ match: "^emu avd name", serial: OTHER_SERIAL, stdout: "personal\r\nOK\r\n" }];
}

/** The device list with both emulators. */
export const TWO_DEVICES = `List of devices attached\nemulator-5554\tdevice\n${OTHER_SERIAL}\tdevice\n\n`;

/**
 * Calls not made on `serial`: everything except the device list / version, and the AVD-name queries of other
 * emulators that finding the serial needs. Empty when every device command went to `serial`.
 */
export function callsOffSerial(calls: string[][], serial: string): string[] {
  const bare = /^(devices|version|start-server|kill-server)$/;
  const lookup = /^(emu avd name|shell getprop ro\.boot\.qemu\.avd_name)$/;
  return calls
    .filter((args) => {
      const onSerial = args[0] === "-s" && args[1] === serial;
      const cmd = (args[0] === "-s" ? args.slice(2) : args).join(" ");
      if (onSerial) return false;
      if (args[0] !== "-s") return !bare.test(cmd);
      return !lookup.test(cmd);
    })
    .map((args) => args.join(" "));
}

export interface FakeAdb {
  adb: Adb;
  statePath: string;
  logPath: string;
  dir: string;
  /** Environment that makes the fake adb find its state (for Adb instances built elsewhere). */
  env: NodeJS.ProcessEnv;
  /** Full argument lists of every call so far (including "-s <serial>"). */
  calls(): string[][];
  /** Every call as one string without the leading "-s <serial>". */
  commands(): string[];
  /** Replace the rules (use counts restart). */
  setRules(rules: FakeRule[]): void;
  cleanup(): void;
}

const tempDirs: string[] = [];
let exitHookInstalled = false;

function trackTemp(dir: string): string {
  tempDirs.push(dir);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const d of tempDirs) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          // a child may still hold a file on Windows
        }
      }
    });
  }
  return dir;
}

/** A fresh temp directory to use as EMU_LAB_HOME (removed when the test process exits). */
export function tempLabHome(): string {
  return trackTemp(mkdtempSync(join(tmpdir(), "emu-lab-home-")));
}

/** Fast polling for tests. */
export const FAST_TIMING: Partial<AdbTiming> = { findSerialPollMs: 20, uiDumpRetryMs: 10, serverPollMs: 10, serverWaitMs: 200 };

export function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

export function makeFakeAdb(
  rules: FakeRule[] = [],
  o: { serial?: string; report?: Report; timing?: Partial<AdbTiming>; timeoutMs?: number } = {},
): FakeAdb {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), "emu-lab-fake-adb-")));
  const statePath = join(dir, "state.json");
  const logPath = join(dir, "calls.jsonl");

  const writeState = (r: FakeRule[]) => {
    for (const f of readdirSync(dir)) {
      if (f.startsWith("state.json.used.")) rmSync(join(dir, f), { force: true });
    }
    writeFileSync(statePath, JSON.stringify({ log: logPath, rules: r }, null, 2));
  };
  writeState(rules);

  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_ADB_STATE: statePath };
  const adb = new Adb({
    exe: process.execPath,
    prefixArgs: [FAKE_ADB_PATH],
    serial: o.serial,
    env,
    report: o.report ?? silent,
    skipServerCheck: true,
    timeoutMs: o.timeoutMs ?? 20_000,
    timing: { ...FAST_TIMING, ...(o.timing ?? {}) },
  });

  const entries = (): { args: string[]; cmd: string }[] => {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { args: string[]; cmd: string });
  };

  return {
    adb,
    statePath,
    logPath,
    dir,
    env,
    calls: () => entries().map((e) => e.args),
    commands: () => entries().map((e) => e.cmd),
    setRules: (r) => writeState(r),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
