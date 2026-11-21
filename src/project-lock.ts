// Who holds a Unity project: Temp/UnityLockfile, and the Unity processes (Editor, batchmode build, asset import
// workers) whose command line names the project with -projectPath. Mirrors Test-ProjectLocked and
// Get-UnityProcessesForProject in scripts/common.ps1, for every host OS. Also stops a process tree (a build that
// timed out or whose caller went away), sparing an adb server that tree forked (Stop-ProcessTree).
//
// - Windows: Unity keeps the lockfile open; opening it with no sharing (UV_FS_O_EXLOCK) fails while anyone holds it.
//   Processes come from Win32_Process (command line included).
// - macOS / Linux: the lockfile stays behind after a crash, so it counts only while a process holds it open (lsof on
//   macOS, /proc/<pid>/fd on Linux) or a running Unity names the project. Processes come from ps / /proc.

import { constants, closeSync, existsSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { runProcess, sleep } from "./proc.ts";

export interface UnityProcess {
  pid: number;
  ppid: number;
  /** Started with -batchmode (a build, or an Editor's import worker). */
  batchmode: boolean;
  /** An Editor's asset import worker (-name AssetImportWorker*): batchmode, but not a build. */
  worker: boolean;
  commandLine: string;
}

/** What a check needs from the host; tests inject their own. */
export interface LockProbe {
  /** Unity (Editor or batchmode) holds the project. */
  isLocked(projectPath: string): Promise<boolean>;
  /** Running Unity processes that name this project. */
  processes(projectPath: string): Promise<UnityProcess[]>;
}

const PS_TIMEOUT_MS = 30_000;
/**
 * libuv's UV_FS_O_EXLOCK (uv/win.h): open with no sharing. Node does not export it, but passes the flag through to
 * libuv on Windows (checked: a second open of the file then fails with EBUSY).
 */
export const UV_FS_O_EXLOCK = 0x10000000;

type PathApi = typeof path.win32;

function pathApi(platform: NodeJS.Platform): PathApi {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Comparison form of a path: absolute, no trailing separator, lower case where the file system ignores case. */
export function comparablePath(p: string, platform: NodeJS.Platform = process.platform): string {
  const api = pathApi(platform);
  let n = api.resolve(platform === "win32" ? p.replace(/\//g, "\\") : p);
  if (n.length > api.parse(n).root.length) n = n.replace(/[\\/]+$/, "");
  return platform === "linux" ? n : n.toLowerCase();
}

/** The project path and its real path (macOS /var -> /private/var), in comparison form. */
function wantedForms(projectPath: string, platform: NodeJS.Platform): Set<string> {
  const forms = new Set([comparablePath(projectPath, platform)]);
  try {
    forms.add(comparablePath(realpathSync.native(projectPath), platform));
  } catch {
    // missing: the plain form only
  }
  return forms;
}

/** -projectPath value of a one-string command line (Windows; Hub writes -projectpath, import workers quote every token). */
export function projectPathFromCommandLine(cl: string): string | null {
  const m = /(?:^|\s)"?-projectPath"?(?:\s+|=)(?:"([^"]*)"|(\S+))/i.exec(cl);
  if (!m) return null;
  return (m[1] ?? m[2] ?? "") || null;
}

/** -projectPath value of an argument vector (Linux /proc/<pid>/cmdline). */
export function projectPathFromArgv(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (/^-projectpath$/i.test(argv[i])) return argv[i + 1] ?? null;
    const eq = /^-projectpath=(.*)$/i.exec(argv[i]);
    if (eq) return eq[1] || null;
  }
  return null;
}

/**
 * Does this command line name the project? Windows: the -projectPath value (quoted or not). A one-string command line
 * from ps (macOS) has lost its quoting, so there the path is the text after -projectPath up to the end or the next
 * option (" -"), which keeps a path with spaces whole.
 */
export function commandLineNamesProject(cl: string, projectPath: string, platform: NodeJS.Platform = process.platform): boolean {
  const want = wantedForms(projectPath, platform);
  if (platform === "win32") {
    const val = projectPathFromCommandLine(cl);
    return val !== null && want.has(comparablePath(val, platform));
  }
  // ps joins the arguments with spaces: the path runs up to the end or to the next option (" -").
  const re = /(?:^|\s)"?-projectpath"?(?:\s+|=)/gi;
  for (let m = re.exec(cl); m; m = re.exec(cl)) {
    let rest = cl.slice(m.index + m[0].length);
    if (rest.startsWith('"')) rest = rest.slice(1).replace(/"(?=\s|$)/, "");
    const r = platform === "linux" ? rest : rest.toLowerCase();
    for (const w of want) {
      for (const cand of [w, `${w}/`]) {
        if (r === cand || r.startsWith(`${cand} -`)) return true;
      }
    }
  }
  return false;
}

export function classifyCommandLine(cl: string): { batchmode: boolean; worker: boolean } {
  return {
    batchmode: /(?:^|\s)"?-batchmode"?(?:\s|$)/i.test(cl),
    worker: /(?:^|\s)"?-name"?\s+"?AssetImportWorker/i.test(cl),
  };
}

/** Parse `pid|ppid|base64(UTF-8 command line)` lines (the Windows query). */
export function parseWindowsUnityLines(text: string): { pid: number; ppid: number; commandLine: string }[] {
  const list: { pid: number; ppid: number; commandLine: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split("|");
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    list.push({ pid, ppid: Number.isInteger(ppid) ? ppid : 0, commandLine: Buffer.from(parts[2], "base64").toString("utf8") });
  }
  return list;
}

/** Parse `ps -axww -o pid=,ppid=,command=` lines, keeping the macOS Unity editor binary only. */
export function parsePsUnityLines(text: string): { pid: number; ppid: number; commandLine: string }[] {
  const list: { pid: number; ppid: number; commandLine: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const cl = m[3];
    // The editor binary: macOS Unity.app/Contents/MacOS/Unity, Linux .../Editor/Unity (not "Unity Hub").
    if (!/\/Unity\.app\/Contents\/MacOS\/Unity(?:\s|$)/.test(cl) && !/(?:^|\/)Unity$/.test((cl.split(" -")[0] ?? "").trim())) continue;
    list.push({ pid: Number(m[1]), ppid: Number(m[2]), commandLine: cl });
  }
  return list;
}

// No double quotes inside: the script is one argument, and Windows quoting of it stays trivial.
const WINDOWS_UNITY_QUERY =
  "Get-CimInstance Win32_Process -Filter 'Name=''Unity.exe''' -ErrorAction SilentlyContinue | ForEach-Object { " +
  "[string]$_.ProcessId + '|' + [string]$_.ParentProcessId + '|' + " +
  "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine)) }";

async function powershell(command: string): Promise<string | null> {
  try {
    const r = await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { timeoutMs: PS_TIMEOUT_MS });
    return r.code === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

interface LinuxProc {
  pid: number;
  ppid: number;
  argv: string[];
  exeName: string;
}

function linuxProcesses(): LinuxProc[] {
  const out: LinuxProc[] = [];
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return out;
  }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const argv = readFileSync(`/proc/${n}/cmdline`, "utf8").split("\0");
      if (argv.length && argv[argv.length - 1] === "") argv.pop();
      if (!argv.length) continue;
      let exeName = path.posix.basename(argv[0]);
      try {
        exeName = path.posix.basename(readlinkSync(`/proc/${n}/exe`).replace(/ \(deleted\)$/, ""));
      } catch {
        // another user's process: argv[0] only
      }
      const stat = readFileSync(`/proc/${n}/stat`, "utf8");
      const ppid = Number(/\)\s+\S+\s+(\d+)/.exec(stat)?.[1] ?? 0);
      out.push({ pid: Number(n), ppid, argv, exeName });
    } catch {
      // gone meanwhile
    }
  }
  return out;
}

function linuxHoldsFile(pid: number, file: string): boolean {
  let fds: string[];
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return false;
  }
  for (const fd of fds) {
    try {
      if (readlinkSync(`/proc/${pid}/fd/${fd}`) === file) return true;
    } catch {
      // closed meanwhile
    }
  }
  return false;
}

/** Every running Unity editor process on this host (any project). */
export async function listUnityProcesses(platform: NodeJS.Platform = process.platform): Promise<{ pid: number; ppid: number; commandLine: string; argv?: string[] }[]> {
  if (platform === "win32") {
    const text = await powershell(WINDOWS_UNITY_QUERY);
    return text ? parseWindowsUnityLines(text) : [];
  }
  if (platform === "linux" && existsSync("/proc/self/cmdline")) {
    return linuxProcesses()
      .filter((p) => p.exeName === "Unity")
      .map((p) => ({ pid: p.pid, ppid: p.ppid, commandLine: p.argv.join(" "), argv: p.argv }));
  }
  try {
    const r = await runProcess("ps", ["-axww", "-o", "pid=,ppid=,command="], { timeoutMs: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C", LANG: "C" } });
    return parsePsUnityLines(r.stdout);
  } catch {
    return [];
  }
}

/** Running Unity processes whose command line names this project. */
export async function unityProcessesForProject(projectPath: string, platform: NodeJS.Platform = process.platform): Promise<UnityProcess[]> {
  const want = wantedForms(projectPath, platform);
  const all = await listUnityProcesses(platform);
  const out: UnityProcess[] = [];
  for (const p of all) {
    const names = p.argv
      ? (() => {
          const v = projectPathFromArgv(p.argv);
          return v !== null && want.has(comparablePath(v, platform));
        })()
      : commandLineNamesProject(p.commandLine, projectPath, platform);
    if (!names) continue;
    out.push({ pid: p.pid, ppid: p.ppid, commandLine: p.commandLine, ...classifyCommandLine(p.commandLine) });
  }
  return out;
}

/** Temp/UnityLockfile of a project. */
export function lockfilePath(projectPath: string): string {
  return path.join(path.resolve(projectPath), "Temp", "UnityLockfile");
}

/** PIDs that hold a file open (lsof; macOS ships it). Empty when none or when lsof cannot run. */
async function lsofHolders(file: string): Promise<number[]> {
  try {
    const r = await runProcess("lsof", ["-t", "--", file], { timeoutMs: PS_TIMEOUT_MS });
    return r.stdout
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** True when a Unity (Editor or batchmode) holds the project. */
export async function isProjectLocked(projectPath: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const lock = lockfilePath(projectPath);
  if (platform === "win32") {
    let fd: number;
    try {
      // No sharing at all: fails while anyone (Unity) has the file open.
      fd = openSync(lock, constants.O_RDWR | UV_FS_O_EXLOCK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return !(code === "ENOENT" || code === "ENOTDIR");
    }
    closeSync(fd);
    return false;
  }
  if (!existsSync(lock)) return false;
  if (platform === "linux" && existsSync("/proc/self/fd")) {
    let real = lock;
    try {
      real = realpathSync.native(lock);
    } catch {
      // keep the plain path
    }
    for (const p of linuxProcesses()) {
      if (p.exeName === "Unity" && linuxHoldsFile(p.pid, real)) return true;
    }
  } else if ((await lsofHolders(lock)).length) {
    return true;
  }
  // A Unity that names the project but has not opened the lockfile yet (starting) also counts.
  return (await unityProcessesForProject(projectPath, platform)).length > 0;
}

export const realLockProbe: LockProbe = {
  isLocked: (p) => isProjectLocked(p),
  processes: (p) => unityProcessesForProject(p),
};

/** Batchmode Unity processes that are not an Editor's import workers: a build is running. */
export function buildHolders(holders: UnityProcess[]): UnityProcess[] {
  return holders.filter((h) => h.batchmode && !h.worker);
}

/** Editor PIDs among the holders (an Editor opened without -projectPath shows up as the parent of its import workers). */
export function editorPids(holders: UnityProcess[]): number[] {
  const editors = holders.filter((h) => !h.batchmode).map((h) => h.pid);
  if (editors.length || buildHolders(holders).length) return editors;
  return [...new Set(holders.filter((h) => h.worker && h.ppid).map((h) => h.ppid))];
}

/** "Unity Editor pid 1, batchmode Unity pid 2" (import workers left out when their Editor or build is listed). */
export function describeHolders(holders: UnityProcess[]): string {
  if (!holders.length) {
    return "Temp/UnityLockfile is held, but no running Unity names this project in -projectPath: ask the person which Editor or tool has it open";
  }
  const main = holders.filter((h) => !h.worker);
  const list = main.length ? main : holders;
  return list.map((h) => (h.worker ? `asset import worker pid ${h.pid}` : h.batchmode ? `batchmode Unity pid ${h.pid}` : `Unity Editor pid ${h.pid}`)).join(", ");
}

// ---------------------------------------------------------------------------------------------------
// Stopping a process tree

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface WinProc {
  pid: number;
  ppid: number;
  created: number | null;
  commandLine: string;
}

const WINDOWS_ALL_QUERY =
  "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $c = ''; " +
  "if ($_.CreationDate) { $c = $_.CreationDate.ToUniversalTime().ToString('o') }; " +
  "[string]$_.ProcessId + '|' + [string]$_.ParentProcessId + '|' + $c + '|' + " +
  "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine)) }";

export function parseWindowsProcTable(text: string): WinProc[] {
  const list: WinProc[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split("|");
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const t = parts[2] ? Date.parse(parts[2].replace(/(\.\d{3})\d+/, "$1")) : NaN;
    list.push({ pid, ppid: Number(parts[1]) || 0, created: Number.isNaN(t) ? null : t, commandLine: Buffer.from(parts[3], "base64").toString("utf8") });
  }
  return list;
}

/**
 * Descendants of root to stop, children before parents. Windows reuses PIDs and an orphan keeps its dead parent's PID,
 * so only children created at or after their parent are followed; an adb server the tree forked is left alone.
 */
export function treeToStop(table: WinProc[], root: number, rootCreated: number | null): number[] {
  const out: number[] = [];
  const visit = (pid: number, created: number | null, depth: number) => {
    if (depth > 64 || created === null) return;
    for (const c of table) {
      if (c.ppid !== pid || c.pid === pid || c.created === null || c.created < created) continue;
      if (/fork-server/.test(c.commandLine)) continue;
      visit(c.pid, c.created, depth + 1);
      out.push(c.pid);
    }
  };
  visit(root, rootCreated, 0);
  return out;
}

function killQuiet(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {
    // gone
  }
}

/**
 * Stop a process and its children. Windows: the tree from Win32_Process (see treeToStop), else taskkill /T.
 * macOS / Linux: the process group of a child started detached (its pid is the group id), SIGTERM then SIGKILL.
 */
export async function stopProcessTree(pid: number, o: { rootStarted?: Date; platform?: NodeJS.Platform; graceMs?: number } = {}): Promise<void> {
  const platform = o.platform ?? process.platform;
  if (platform === "win32") {
    const text = await powershell(WINDOWS_ALL_QUERY);
    if (text === null) {
      await runProcess("taskkill", ["/PID", String(pid), "/T", "/F"], { timeoutMs: PS_TIMEOUT_MS }).catch(() => undefined);
      return;
    }
    const table = parseWindowsProcTable(text);
    const root = table.find((p) => p.pid === pid);
    const created = root?.created ?? o.rootStarted?.getTime() ?? null;
    for (const c of treeToStop(table, pid, created)) killQuiet(c);
    killQuiet(pid);
    return;
  }
  const signalGroup = (sig: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      killQuiet(pid, sig);
      return false;
    }
  };
  signalGroup("SIGTERM");
  const deadline = Date.now() + (o.graceMs ?? 5_000);
  while (isAlive(pid) && Date.now() < deadline) await sleep(200);
  signalGroup("SIGKILL");
}
