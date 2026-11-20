// Child processes: run-to-completion with a hard timeout, detached launches that outlive us (the emulator),
// and process lookups (pid -> name + start time) for the emulator identity check.
//
// Reference: scripts/common.ps1 (Invoke-Adb, Start-Detached). Two traps the PowerShell scripts hit and that
// this module avoids by construction:
// - An adb client that forks the adb server hands our pipes to the server, so the pipes stay open after the
//   client exits. runProcess therefore resolves on the child's `exit` event and gives the pipes at most
//   500 ms to drain, never waiting for `close` alone.
// - A long-lived child must not inherit our stdout (an MCP stdio server's pipe would stay open). Detached
//   launches write to files instead.

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readlinkSync } from "node:fs";
import { basename } from "node:path";
import type { Readable } from "node:stream";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcInfo {
  pid: number;
  name: string;
  startTime: Date;
}

/** Default hard limit for runProcess / runProcessBuffer. */
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
/** How long the pipes may stay open after the child exited (a forked adb server can hold them forever). */
const PIPE_DRAIN_MS = 500;
/** Grace after a timeout kill before giving up on the `exit` event. */
const KILL_GRACE_MS = 3_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

interface RawResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
}

function streamEnded(s: Readable | null): Promise<void> {
  if (!s || s.readableEnded || s.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    s.once("end", () => resolve());
    s.once("close", () => resolve());
    s.once("error", () => resolve());
  });
}

function runRaw(
  exe: string,
  args: string[],
  o: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<RawResult> {
  const timeoutMs = o.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  return new Promise<RawResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(exe, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: o.env ?? process.env,
        cwd: o.cwd,
      });
    } catch (err) {
      reject(err);
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (b: Buffer) => out.push(b));
    child.stderr?.on("data", (b: Buffer) => err.push(b));
    // Keep a listener so a late stream error never becomes an uncaught exception.
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});

    let settled = false;
    let timedOut = false;
    let spawned = false;
    let killTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const finish = async (code: number | null) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      // Wait for the pipes, but never longer than PIPE_DRAIN_MS: a forked adb server may hold them open.
      let drainTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all([streamEnded(child.stdout), streamEnded(child.stderr)]),
        new Promise<void>((r) => {
          drainTimer = setTimeout(r, PIPE_DRAIN_MS);
        }),
      ]);
      if (drainTimer) clearTimeout(drainTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), timedOut });
    };

    child.once("spawn", () => {
      spawned = true;
    });
    child.once("error", (e: NodeJS.ErrnoException) => {
      if (settled) return;
      if (!spawned) {
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        reject(e);
        return;
      }
      // Spawned but failed later (e.g. kill failed): report what we have.
      void finish(null);
    });
    child.once("exit", (code) => {
      void finish(code);
    });

    killTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // already gone
      }
      // If the exit event never comes (should not happen), resolve anyway: nothing waits forever.
      graceTimer = setTimeout(() => void finish(null), KILL_GRACE_MS);
    }, timeoutMs);
  });
}

/**
 * Run a program to completion and return its UTF-8 output. Resolves on the child's exit (plus at most
 * 500 ms for the pipes), never throws for a non-zero exit; throws only when the program cannot be spawned
 * (the caller maps ENOENT). On timeout the child is killed and `timedOut` is true.
 */
export async function runProcess(
  exe: string,
  args: string[],
  o: { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<RunResult> {
  const r = await runRaw(exe, args, o);
  return { code: r.code, stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"), timedOut: r.timedOut };
}

/** Like runProcess, but stdout stays raw bytes (screencap PNG). */
export async function runProcessBuffer(
  exe: string,
  args: string[],
  o: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number | null; stdout: Buffer; stderr: string; timedOut: boolean }> {
  const r = await runRaw(exe, args, o);
  return { code: r.code, stdout: r.stdout, stderr: r.stderr.toString("utf8"), timedOut: r.timedOut };
}

/**
 * Start a program that must outlive us (the emulator). Its stdout/stderr go to files, never to our pipes;
 * the child is detached and unref'd. Throws when the program cannot be started at all.
 */
export function spawnDetached(
  exe: string,
  args: string[],
  o: { outFile: string; errFile: string; env?: NodeJS.ProcessEnv },
): { pid: number; exited: () => boolean; exitCode: () => number | null } {
  const outFd = openSync(o.outFile, "w");
  let errFd: number;
  try {
    errFd = o.errFile === o.outFile ? outFd : openSync(o.errFile, "w");
  } catch (e) {
    closeSync(outFd);
    throw e;
  }
  let exited = false;
  let exitCode: number | null = null;
  let child: ChildProcess;
  try {
    child = spawn(exe, args, {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", outFd, errFd],
      env: o.env ?? process.env,
    });
  } finally {
    // The child has its own copies now; ours would only keep the files open.
    closeSync(outFd);
    if (errFd !== outFd) closeSync(errFd);
  }
  child.once("error", () => {
    exited = true;
  });
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
  });
  if (child.pid === undefined) {
    const missing = !existsSync(exe) && /[\\/]/.test(exe);
    const e = new Error(`Cannot start ${exe}${missing ? " (file not found)" : ""}`) as NodeJS.ErrnoException;
    e.code = missing ? "ENOENT" : "ESPAWN";
    throw e;
  }
  child.unref();
  return { pid: child.pid, exited: () => exited, exitCode: () => exitCode };
}

// --- process lookup

const PS_TIMEOUT_MS = 30_000;

/** Parse a .NET round-trip ("o") date, which may carry 7 fraction digits. */
function parseIsoLoose(s: string): Date | null {
  const t = s.trim().replace(/(\.\d{3})\d+/, "$1");
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** Parse ps lstart ("Thu Nov 20 10:43:00 2026", local time). */
export function parseLstart(s: string): Date | null {
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const month = MONTHS[m[1]];
  if (month === undefined) return null;
  return new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

/** Parse `Id|ProcessName|StartTime.ToString('o')` lines from the Windows query. */
export function parseWindowsProcessLines(text: string): ProcInfo[] {
  const list: ProcInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split("|");
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const startTime = parseIsoLoose(parts.slice(2).join("|"));
    if (!Number.isInteger(pid) || !startTime) continue;
    list.push({ pid, name: parts[1], startTime });
  }
  return list;
}

/** Parse `ps -o pid=,lstart=,comm=` lines (lstart is always 24 characters). */
export function parsePsLines(text: string): ProcInfo[] {
  const list: ProcInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line);
    if (!m) continue;
    const startTime = parseLstart(m[2]);
    if (!startTime) continue;
    list.push({ pid: Number(m[1]), name: basename(m[3].trim()), startTime });
  }
  return list;
}

/** Executable name from a Linux /proc/<pid>/exe link target ("/usr/bin/node", "/x/qemu-system-x86_64 (deleted)"). */
export function exeNameFromLink(target: string): string | null {
  const t = target.replace(/ \(deleted\)$/, "").trim();
  return t ? basename(t) : null;
}

/** Basename of /proc/<pid>/exe, or null when it cannot be read (another user's process, gone, not Linux). */
function linuxExeName(pid: number): string | null {
  try {
    return exeNameFromLink(readlinkSync(`/proc/${pid}/exe`));
  } catch {
    return null;
  }
}

// No double quotes inside: the script is passed as one argument and Windows quoting stays trivial.
function windowsQuery(pid?: number): string {
  const select = pid === undefined ? "Get-Process" : `Get-Process -Id ${pid}`;
  return (
    `${select} -ErrorAction SilentlyContinue | ForEach-Object { try { ` +
    `[string]$_.Id + '|' + $_.ProcessName + '|' + $_.StartTime.ToString('o') } catch { } }`
  );
}

async function queryProcesses(pid?: number): Promise<ProcInfo[]> {
  try {
    if (process.platform === "win32") {
      const r = await runProcess(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", windowsQuery(pid)],
        { timeoutMs: PS_TIMEOUT_MS },
      );
      return parseWindowsProcessLines(r.stdout);
    }
    const args = pid === undefined ? ["-A", "-o", "pid=,lstart=,comm="] : ["-p", String(pid), "-o", "pid=,lstart=,comm="];
    const r = await runProcess("ps", args, { timeoutMs: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C", LANG: "C" } });
    const list = parsePsLines(r.stdout);
    if (process.platform === "linux") {
      // Linux comm is the main thread's name, cut to 15 characters ("qemu-system-x86", and Node 24 names its
      // main thread "MainThread"). The executable path gives the real name when we may read it.
      for (const p of list) p.name = linuxExeName(p.pid) ?? p.name;
    }
    return list;
  } catch {
    // The tool is missing (ENOENT) or cannot run: no information.
    return [];
  }
}

/** Name and start time of one process, or null when it does not exist (or cannot be inspected). */
export async function getProcessInfo(pid: number): Promise<ProcInfo | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const list = await queryProcesses(pid);
  return list.find((p) => p.pid === pid) ?? null;
}

/** Processes whose name matches, newest first. */
export async function findProcesses(name: RegExp): Promise<ProcInfo[]> {
  const list = await queryProcesses();
  return list
    .filter((p) => {
      name.lastIndex = 0;
      return name.test(p.name);
    })
    .sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
}
