// adb client wrapper. Reference: scripts/common.ps1 (Invoke-Adb, Start-AdbServer, Get-UiDump,
// Resolve-SystemDialog, Get-EmulatorAvdName, Get-RunningEmulators, Get-EmulatorSerial, Get-LauncherActivity,
// Save-Screenshot).
//
// - Output is decoded as UTF-8 (Korean notification titles) and adb error text is returned, not thrown,
//   like Invoke-Adb. Only a missing adb executable throws (NO_ADB).
// - The adb server is started detached with stdio ignored: a server forked by a normal adb call would
//   inherit our pipes (an MCP stdio server's stdout would then never close).

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { EOL } from "node:os";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { EmuError } from "./errors.ts";
import { findDialogButton, parseDevices, parseDisplaySize } from "./parse.ts";
import { runProcess, runProcessBuffer, sleep, type RunResult } from "./proc.ts";
import { silent, type Report } from "./types.ts";

/** Polling intervals; tests shrink them (internal, not exposed in CLI/MCP). */
export interface AdbTiming {
  /** findSerial poll interval (PS: 2 s). */
  findSerialPollMs: number;
  /** Pause between uiDump attempts (PS: 1 s). */
  uiDumpRetryMs: number;
  /** adb server port poll interval after start-server. */
  serverPollMs: number;
  /** How long to wait for the adb server port after start-server. */
  serverWaitMs: number;
}

export const DEFAULT_ADB_TIMING: AdbTiming = {
  findSerialPollMs: 2_000,
  uiDumpRetryMs: 1_000,
  serverPollMs: 300,
  serverWaitMs: 10_000,
};

export interface AdbOptions {
  exe: string;
  /** Arguments put before everything else (the fake adb script path in tests). */
  prefixArgs?: string[];
  serial?: string;
  env?: NodeJS.ProcessEnv;
  report?: Report;
  /** Skip the adb server check (fake adb). */
  skipServerCheck?: boolean;
  /** adb server port to probe (default 5037; tests only). */
  serverPort?: number;
  /** Default timeout of one adb call (default 120 s). */
  timeoutMs?: number;
  timing?: Partial<AdbTiming>;
}

export interface LogcatCapture {
  readonly file: string;
  text(): string;
  length(): number;
  stop(): Promise<void>;
}

/** System UI on top of the app (first-run immersive hint, permission prompt, ...), tried in this order. */
export const SYSTEM_DIALOG_BUTTONS = ["Got it", "Allow", "OK"];

const ADB_PORT = 5037;
const DEFAULT_TIMEOUT_MS = 120_000;
const MOBILE_MCP_SERVER = "com.mobilenext.mobilecli.DeviceServer";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The IEND chunk every complete PNG ends with (length 0, type, CRC). */
const PNG_IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function isPng(b: Buffer): boolean {
  return b.length > PNG_SIGNATURE.length && b.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

/** A whole PNG: the signature at the start and the IEND chunk at the end (a cut-off transfer has no IEND). */
export function isCompletePng(b: Buffer): boolean {
  return isPng(b) && b.length >= PNG_SIGNATURE.length + PNG_IEND.length && b.subarray(b.length - PNG_IEND.length).equals(PNG_IEND);
}

function joinOutput(stdout: string, stderr: string): string {
  if (!stderr) return stdout;
  if (!stdout) return stderr;
  return stdout.endsWith("\n") ? stdout + stderr : `${stdout}\n${stderr}`;
}

function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function hhmmss(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** True when 127.0.0.1:<port> accepts a TCP connection within timeoutMs. */
export function tcpPortOpen(port: number, timeoutMs: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export class Adb {
  readonly exe: string;
  readonly serial: string | undefined;
  private readonly opts: AdbOptions;
  private readonly prefix: string[];
  private readonly timing: AdbTiming;
  private readonly report: Report;

  constructor(o: AdbOptions) {
    this.opts = { ...o };
    this.exe = o.exe;
    this.serial = o.serial;
    this.prefix = [...(o.prefixArgs ?? [])];
    this.timing = { ...DEFAULT_ADB_TIMING, ...(o.timing ?? {}) };
    this.report = o.report ?? silent;
  }

  /** The same adb bound to another device. */
  withSerial(serial: string): Adb {
    return new Adb({ ...this.opts, serial });
  }

  // --- low level

  private noAdb(err: unknown): never {
    const e = err as NodeJS.ErrnoException;
    throw new EmuError("NO_ADB", `adb not found or not runnable: ${this.exe} (${e?.code ?? e?.message ?? String(err)})`);
  }

  /** Run adb with the given full argument list (no serial added). */
  private async exec(args: string[], timeoutMs?: number): Promise<RunResult> {
    try {
      const r = await runProcess(this.exe, [...this.prefix, ...args], {
        timeoutMs: timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        env: this.opts.env,
      });
      if (r.timedOut) this.report(`ADB_TIMEOUT adb ${args.join(" ")} (killed after ${Math.round((timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} s)`);
      return r;
    } catch (err) {
      this.noAdb(err);
    }
  }

  private serialArgs(serial = this.serial): string[] {
    return serial ? ["-s", serial] : [];
  }

  /** Start the adb server detached when it is not listening. Never inherits our stdio. */
  async ensureServer(): Promise<void> {
    if (this.opts.skipServerCheck) return;
    const port = this.opts.serverPort ?? ADB_PORT;
    if (await tcpPortOpen(port, 300)) return;
    await new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.exe, [...this.prefix, "start-server"], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: this.opts.env ?? process.env,
        });
      } catch (err) {
        reject(err);
        return;
      }
      child.once("error", (err) => reject(err));
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    }).catch((err) => this.noAdb(err));
    const deadline = Date.now() + this.timing.serverWaitMs;
    while (Date.now() < deadline) {
      if (await tcpPortOpen(port, 300)) return;
      await sleep(this.timing.serverPollMs);
    }
    // Not fatal: the next adb call reports what is wrong as text.
    this.report(`ADB_SERVER not listening on ${port} after start-server`);
  }

  /** `adb -s <serial> <args>`: stdout + stderr as UTF-8 text. adb errors are text, never throws (except NO_ADB). */
  async run(args: string[], o: { timeoutMs?: number } = {}): Promise<string> {
    await this.ensureServer();
    const r = await this.exec([...this.serialArgs(), ...args], o.timeoutMs);
    return joinOutput(r.stdout, r.stderr);
  }

  /** stdout only (stderr dropped), for answers that must not be mixed with adb's error text. */
  private async runStdout(args: string[], o: { timeoutMs?: number; serial?: string } = {}): Promise<string> {
    await this.ensureServer();
    const r = await this.exec([...this.serialArgs(o.serial ?? this.serial), ...args], o.timeoutMs);
    return r.stdout;
  }

  /** `adb -s <serial> <args>` stdout as raw bytes, with the exit code and whether the time limit killed it. */
  async runBuffer(args: string[], o: { timeoutMs?: number } = {}): Promise<{ stdout: Buffer; code: number | null; timedOut: boolean }> {
    await this.ensureServer();
    try {
      const r = await runProcessBuffer(this.exe, [...this.prefix, ...this.serialArgs(), ...args], {
        timeoutMs: o.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        env: this.opts.env,
      });
      return { stdout: r.stdout, code: r.code, timedOut: r.timedOut };
    } catch (err) {
      this.noAdb(err);
    }
  }

  shell(...args: string[]): Promise<string> {
    return this.run(["shell", ...args]);
  }

  async getprop(name: string): Promise<string> {
    return (await this.runStdout(["shell", "getprop", name])).trim();
  }

  // --- devices

  async devices(): Promise<{ serial: string; state: string }[]> {
    await this.ensureServer();
    const r = await this.exec(["devices"]);
    return parseDevices(r.stdout);
  }

  /** The AVD name of an emulator serial: `emu avd name`, else ro.boot.qemu.avd_name, else null. */
  async avdName(serial: string): Promise<string | null> {
    const lines = nonEmptyLines(await this.runStdout(["emu", "avd", "name"], { serial, timeoutMs: 15_000 }));
    const name = lines.find((l) => l !== "OK" && !/^KO/.test(l));
    if (name) return name;
    const prop = (await this.runStdout(["shell", "getprop", "ro.boot.qemu.avd_name"], { serial, timeoutMs: 15_000 })).trim();
    return prop || null;
  }

  /** Every emulator adb sees as "device", with its AVD name. */
  async runningEmulators(): Promise<{ serial: string; avd: string | null }[]> {
    const list: { serial: string; avd: string | null }[] = [];
    for (const d of await this.devices()) {
      if (!/^emulator-\d+$/.test(d.serial) || d.state !== "device") continue;
      list.push({ serial: d.serial, avd: await this.avdName(d.serial) });
    }
    return list;
  }

  /** The serial of this AVD only (never another emulator), polling until waitSec. */
  async findSerial(avd: string, waitSec = 0): Promise<string | null> {
    const deadline = Date.now() + Math.max(0, waitSec) * 1000;
    for (;;) {
      const hit = (await this.runningEmulators()).find((e) => e.avd === avd);
      if (hit) return hit.serial;
      if (waitSec <= 0 || Date.now() >= deadline) return null;
      await sleep(Math.min(this.timing.findSerialPollMs, Math.max(0, deadline - Date.now())));
    }
  }

  async version(): Promise<string> {
    await this.ensureServer();
    const r = await this.exec(["version"], 15_000);
    const lines = nonEmptyLines(joinOutput(r.stdout, r.stderr));
    if (!lines.length) return "";
    const path = lines.find((l) => /^Installed as /i.test(l));
    return path ? `${lines[0]}; ${path}` : lines[0];
  }

  // --- device queries

  /** Device clock in epoch ms (`date +%s%3N`). */
  async epochMs(): Promise<number> {
    const out = (await this.runStdout(["shell", "date", "+%s%3N"])).trim();
    if (!/^\d+$/.test(out)) throw new EmuError("ADB_FAILED", `Cannot read the device clock (date +%s%3N printed '${out}')`);
    return Number(out);
  }

  /**
   * PNG bytes of the screen (exec-out keeps the bytes intact). An attempt counts only when adb exited 0 in time and
   * the bytes are a whole PNG (signature and IEND): a transfer cut off by a timeout or a dropped device is retried
   * once, then ADB_FAILED.
   */
  async screencap(): Promise<Buffer> {
    let why = "";
    for (let i = 0; i < 2; i++) {
      const r = await this.runBuffer(["exec-out", "screencap", "-p"], { timeoutMs: 30_000 });
      const b = r.stdout;
      if (!r.timedOut && r.code === 0 && isCompletePng(b)) return b;
      if (r.timedOut) why = `timed out after 30 s with ${b.length} bytes`;
      else if (r.code !== 0) why = `adb exited ${r.code ?? "?"} after ${b.length} bytes`;
      else if (isPng(b)) why = `a cut-off PNG of ${b.length} bytes (no IEND)`;
      else why = `${b.length} bytes, not a PNG`;
      if (!isPng(b)) {
        const preview = b.subarray(0, 200).toString("utf8").replace(/\s+/g, " ").trim();
        if (preview) why += `: ${preview}`;
      }
    }
    throw new EmuError("ADB_FAILED", `screencap did not return a whole PNG (${why})`);
  }

  async saveScreenshot(path: string): Promise<void> {
    const png = await this.screencap();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, png);
  }

  /**
   * uiautomator dump, trusting only a fresh, successful dump: the old file is deleted first (a failed dump
   * leaves the previous one in place). A mobile-mcp DeviceServer holding UiAutomation is stopped.
   */
  async uiDump(attempts = 3): Promise<string | null> {
    let last = "";
    const n = Math.max(1, attempts);
    for (let i = 0; i < n; i++) {
      await this.shell("rm", "-f", "/sdcard/__ui.xml");
      last = (await this.shell("uiautomator", "dump", "/sdcard/__ui.xml")).replace(/\s+/g, " ").trim();
      if (/dumped to/.test(last)) {
        const xml = await this.runStdout(["shell", "cat", "/sdcard/__ui.xml"]);
        if (xml.includes("<hierarchy")) return xml;
      }
      // Only one UiAutomation client can exist; mobile-mcp leaves an on-device helper that makes
      // uiautomator die with 137.
      const holder = nonEmptyLines(await this.runStdout(["shell", "pgrep", "-f", MOBILE_MCP_SERVER])).join(" ");
      if (/\d/.test(holder)) {
        await this.shell("pkill", "-f", MOBILE_MCP_SERVER);
        this.report(`UI_DUMP stopped mobile-mcp DeviceServer (pid ${holder}) that held UiAutomation`);
      }
      if (i < n - 1) await sleep(this.timing.uiDumpRetryMs);
    }
    this.report(`UI_DUMP_FAILED ${last}`);
    return null;
  }

  /** Tap a system dialog button (not one of the app's own); returns the label or null. */
  async resolveSystemDialog(appPackage: string, logPath?: string): Promise<string | null> {
    const xml = await this.uiDump();
    if (!xml) return null;
    const hit = findDialogButton(xml, SYSTEM_DIALOG_BUTTONS, appPackage);
    if (!hit) return null;
    await this.shell("input", "tap", String(hit.x), String(hit.y));
    const note = `${hhmmss(new Date())} tapped '${hit.label}' in ${hit.pkg} at ${hit.x},${hit.y}`;
    if (logPath) {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, note + EOL, "utf8");
    }
    this.report(`SYSTEM_DIALOG ${note}`);
    return hit.label;
  }

  async launcherActivity(pkg: string): Promise<string> {
    const out = await this.shell("cmd", "package", "resolve-activity", "--brief", "-c", "android.intent.category.LAUNCHER", pkg);
    const act = out
      .split(/\r?\n/)
      .filter((l) => l.includes("/"))
      .pop();
    if (!act) throw new EmuError("ADB_FAILED", `Launcher activity not found for ${pkg}`);
    return act.trim();
  }

  async displaySize(): Promise<{ w: number; h: number } | null> {
    return parseDisplaySize(await this.shell("dumpsys", "window", "displays"));
  }

  async isPackageResumed(pkg: string): Promise<boolean> {
    const out = await this.shell("dumpsys", "activity", "activities");
    return out.split(/\r?\n/).some((l) => /topResumedActivity|mResumedActivity/.test(l) && l.includes(`${pkg}/`));
  }

  // --- logcat

  /**
   * Stream `adb -s <serial> logcat -v time [extra]` into a file (appended) and into memory. stdout is a
   * pipe, so the adb client also ends by itself when our process dies (no orphan writing files).
   */
  startLogcat(file: string, extraArgs: string[] = []): LogcatCapture {
    mkdirSync(dirname(file), { recursive: true });
    let fd: number | null = openSync(file, "a");
    const args = [...this.prefix, ...this.serialArgs(), "logcat", "-v", "time", ...extraArgs];
    let child: ChildProcess;
    try {
      child = spawn(this.exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: this.opts.env ?? process.env });
    } catch (err) {
      closeSync(fd);
      this.noAdb(err);
    }
    if (child.pid === undefined) {
      // Spawn failed synchronously (missing exe); the error event follows on the next tick.
      child.once("error", () => {});
      closeSync(fd);
      fd = null;
      throw new EmuError("NO_ADB", `adb not found or not runnable: ${this.exe}`);
    }

    const parts: string[] = [];
    let len = 0;
    const decoders = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };
    const append = (chunk: Buffer, which: "out" | "err") => {
      if (fd !== null) {
        try {
          writeSync(fd, chunk);
        } catch {
          // disk full / closed: keep the in-memory copy
        }
      }
      const s = decoders[which].write(chunk);
      if (s) {
        parts.push(s);
        len += s.length;
      }
    };
    child.stdout?.on("data", (b: Buffer) => append(b, "out"));
    child.stderr?.on("data", (b: Buffer) => append(b, "err"));
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.once("error", () => {});

    let exited = false;
    const exitPromise = new Promise<void>((resolve) => {
      child.once("exit", () => {
        exited = true;
        resolve();
      });
      child.once("error", () => {
        exited = true;
        resolve();
      });
    });
    const pipesClosed = Promise.all(
      [child.stdout, child.stderr].map(
        (s) =>
          new Promise<void>((resolve) => {
            if (!s || s.destroyed) return resolve();
            s.once("close", () => resolve());
          }),
      ),
    );
    const closeFile = () => {
      for (const which of ["out", "err"] as const) {
        const rest = decoders[which].end();
        if (rest) {
          parts.push(rest);
          len += rest.length;
        }
      }
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // already closed
        }
        fd = null;
      }
    };
    // When adb ends by itself (device gone), close the file once the pipes are drained.
    void exitPromise.then(async () => {
      await Promise.race([pipesClosed, sleep(500)]);
      closeFile();
    });

    let stopping: Promise<void> | null = null;
    return {
      file,
      text(): string {
        if (parts.length > 1) {
          const joined = parts.join("");
          parts.length = 0;
          parts.push(joined);
        }
        return parts[0] ?? "";
      },
      length(): number {
        return len;
      },
      stop(): Promise<void> {
        if (stopping) return stopping;
        stopping = (async () => {
          if (!exited) {
            try {
              child.kill();
            } catch {
              // already gone
            }
            await Promise.race([exitPromise, sleep(3_000)]);
          }
          await Promise.race([pipesClosed, sleep(500)]);
          child.stdout?.destroy();
          child.stderr?.destroy();
          closeFile();
        })();
        return stopping;
      },
    };
  }
}
