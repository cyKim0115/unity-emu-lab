// Build a Unity player in batchmode: Android APK, WebGL folder or Windows exe, on a Windows, macOS or Linux host.
// Behavioural reference: scripts/build-unity.ps1.
//
// - The project's own build method (-executeMethod, gets -buildOut <out> and for Android -apkOut <out>) or a Unity 6
//   build profile (-activeBuildProfile + -build). The method must write to <out> and exit non-zero on failure.
// - Refused while the project is open in an Editor (PROJECT_OPEN) or another batchmode Unity builds it (BUILD_RUNNING):
//   Unity locks the project folder.
// - BUILD_OK only when this build wrote the output: an APK/exe/WebGL folder an earlier build left at <out> does not
//   count, and a log that reports a failed build fails even when Unity exits 0.
// - EMU_BUILD_WARN / EMU_BUILD_NOTE lines of the build log (templates/EmuProjectBuild.cs) are reported again.
// - A watchdog stops the hidden Unity when the process that started it is killed (tool timeout, closed terminal);
//   a shutdown of the MCP server or the CLI stops it too. A stopped build cannot restore the settings its method
//   changed: run the guard Report afterwards.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLocations } from "./config.ts";
import { EmuError } from "./errors.ts";
import {
  buildHolders,
  comparablePath,
  describeHolders,
  editorPids,
  realLockProbe,
  stopProcessTree,
  type LockProbe,
} from "./project-lock.ts";
import type { Report } from "./types.ts";
import { unityForProject, type BuildTarget, type HostOptions } from "./unity.ts";

export type WebglCompression = "brotli" | "gzip" | "disabled";

export interface BuildDeps {
  /** Start Unity (tests: a fake Unity). Gets the editor executable and the arguments. */
  spawnUnity?: (exe: string, args: string[]) => ChildProcess;
  /** Which installed editor builds the project (tests skip the real search). */
  findUnity?: (projectPath: string) => { version: string; exe: string };
  lock?: LockProbe;
  /** Start the watchdog next to Unity (default true; tests turn it off). */
  watchdog?: boolean;
  /** Poll interval while Unity runs (default 1 s). */
  pollMs?: number;
}

export interface BuildOptions {
  projectPath: string;
  target: BuildTarget;
  /** Static editor method, e.g. EmuProjectBuild.BuildApk. */
  method?: string;
  /** Unity 6 build profile asset, e.g. "Assets/Settings/Build Profiles/Web.asset". */
  buildProfile?: string;
  /** Android: the .apk file; WebGL: the folder; Windows: the .exe file. Default: <labHome>/builds/<folder>-<hash8>/... */
  out?: string;
  /** Passed to the method as -release. */
  release?: boolean;
  /** WebGL only: passed to the method as -webglCompression <x>. */
  webglCompression?: WebglCompression;
  /** Android + method only: passed as -emuArm64 (EmuProjectBuild: IL2CPP + ARM64 for this build only). */
  emuArm64?: boolean;
  /** More method arguments (absolute paths: Unity resolves relative ones against the project). */
  extraArgs?: string[];
  /** Unity is stopped after this long (default 40). */
  timeoutMinutes?: number;
  env?: NodeJS.ProcessEnv;
  report: Report;
  deps?: BuildDeps;
}

export interface BuildResult {
  ok: true;
  target: BuildTarget;
  project: string;
  unity_version: string;
  unity_exe: string;
  method: string | null;
  build_profile: string | null;
  out: string;
  log: string;
  seconds: number;
  bytes: number;
  files: number;
  /** An incremental build with nothing to rewrite (the method named <out> as its output). */
  unchanged: boolean;
  /** EMU_BUILD_WARN lines of the build log (report them). */
  warnings: string[];
  /** EMU_BUILD_NOTE lines of the build log. */
  notes: string[];
}

export const DEFAULT_TIMEOUT_MINUTES = 40;
/** Unity's -buildTarget names. */
const BUILD_TARGET_ARG: Record<BuildTarget, string> = { Android: "android", WebGL: "webgl", Windows: "win64" };

function hostApi(): typeof path.win32 {
  return process.platform === "win32" ? path.win32 : path.posix;
}

/** Full path, no trailing separator (a bare root stays). */
function fullPath(p: string): string {
  const api = hostApi();
  let n = api.resolve(p);
  if (n.length > api.parse(n).root.length) n = n.replace(/[\\/]+$/, "");
  return n;
}

function samePath(a: string, b: string): boolean {
  return comparablePath(a) === comparablePath(b);
}

function isInside(inner: string, outer: string): boolean {
  const i = comparablePath(inner);
  const o = comparablePath(outer);
  const sep = process.platform === "win32" ? "\\" : "/";
  return i === o || i.startsWith(o.endsWith(sep) ? o : o + sep);
}

/**
 * Build output when none is given: <labHome>/builds/<folder>-<hash8>/Android/app.apk, .../WebGL or .../Windows/app.exe,
 * outside the person's project and its git work tree. <folder> = the project folder name with characters outside
 * [A-Za-z0-9._-] replaced by "_"; <hash8> = the first 8 hex digits of SHA-256 over the lowercased full path (UTF-8),
 * the same as Get-DefaultBuildOut in scripts/common.ps1 (which puts it under the repository's artifacts/builds).
 */
export function defaultBuildOut(labHome: string, projectPath: string, target: BuildTarget): string {
  const full = fullPath(projectPath);
  const leaf = path.basename(full).replace(/[^A-Za-z0-9._-]/g, "_") || "project";
  const hash8 = createHash("sha256").update(full.toLowerCase(), "utf8").digest("hex").slice(0, 8);
  const tail = target === "Android" ? ["Android", "app.apk"] : target === "WebGL" ? ["WebGL"] : ["Windows", "app.exe"];
  return path.join(labHome, "builds", `${leaf}-${hash8}`, ...tail);
}

/** A Windows player <dir>/<name>.exe loads its content from <dir>/<name>_Data. */
export function windowsDataDir(exe: string): string {
  return path.join(path.dirname(exe), `${path.basename(exe, path.extname(exe))}_Data`);
}

/** Where the build log goes: <out>.build.log for WebGL, else <out> with .build.log in place of its extension. */
export function buildLogPath(out: string, target: BuildTarget): string {
  if (target === "WebGL") return `${out}.build.log`;
  return path.join(path.dirname(out), `${path.basename(out, path.extname(out))}.build.log`);
}

interface Stamp {
  /** Newest modification time (ms). */
  time: number;
  bytes: number;
  count: number;
}

function walkFiles(dir: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out);
    else if (e.isFile()) out.push(full);
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What is at the output now (null: nothing). Android: the .apk file; Windows: the .exe plus its _Data folder; WebGL:
 * every file of a folder with an index.html (an incremental build rewrites only changed files, but the .data file was
 * rewritten by every build seen).
 */
export function outputStamp(target: BuildTarget, out: string): Stamp | null {
  let files: string[];
  if (target === "Android") {
    if (!isFile(out)) return null;
    files = [out];
  } else if (target === "Windows") {
    if (!isFile(out)) return null;
    files = [out];
    walkFiles(windowsDataDir(out), files);
  } else {
    if (!isFile(path.join(out, "index.html"))) return null;
    files = [];
    walkFiles(out, files);
  }
  let time = 0;
  let bytes = 0;
  for (const f of files) {
    try {
      const s = statSync(f);
      if (s.mtimeMs > time) time = s.mtimeMs;
      bytes += s.size;
    } catch {
      // removed meanwhile
    }
  }
  return { time, bytes, count: files.length };
}

/** Lines of a build log that matter for the result: markers, the build summary and compile errors. */
export function logHits(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => /EMU_BUILD_[A-Z]+|Build Finished, Result: \w+|error CS\d+/i.test(l));
}

/** The first few log lines that say why a build failed (" Reason: a | b"), or "". */
export function buildErrorSummary(text: string): string {
  const lines = text.split(/\r?\n/);
  const picked: string[] = [];
  const add = (s: string) => {
    if (!picked.includes(s)) picked.push(s);
  };
  for (let i = 0; i < lines.length && picked.length < 4; i++) {
    const s = lines[i].trim();
    if (
      /^(UnityException|BuildFailedException|System\.\w+Exception|Error building Player|.*error CS\d+|C\/C\+\+: CMake Error|\* What went wrong|.*No valid Unity (Editor )?license|Aborting batchmode due to failure)/i.test(s)
    ) {
      add(s);
      // These put the actual message on the next line.
      if (/^(UnityException|C\/C\+\+: CMake Error|\* What went wrong|Aborting batchmode due to failure)/i.test(s) && i + 1 < lines.length && lines[i + 1].trim()) {
        add(lines[i + 1].trim());
      }
    }
  }
  if (!picked.length) return "";
  return ` Reason: ${picked.map((s) => (s.length > 300 ? s.slice(0, 300) : s)).join(" | ")}`;
}

function formatLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------------------------------
// Running builds of this process: one per project, and a shutdown stops them.

const running = new Set<string>();
const live = new Map<number, { child: ChildProcess; started: Date }>();

/** Stop every Unity build this process started and that still runs (shutdown path). Returns how many. */
export async function stopLiveBuilds(): Promise<number> {
  const list = [...live.entries()];
  live.clear();
  await Promise.all(list.map(([pid, b]) => stopProcessTree(pid, { rootStarted: b.started })));
  return list.length;
}

/** The watchdog script next to this module (src/watchdog.ts in a clone, dist/watchdog.js in the package). */
function watchdogScript(): string {
  const self = fileURLToPath(import.meta.url);
  return path.join(path.dirname(self), `watchdog${path.extname(self)}`);
}

function startWatchdog(childPid: number, started: Date): ChildProcess | null {
  try {
    const w = spawn(process.execPath, [watchdogScript(), String(process.pid), String(childPid), started.toISOString()], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    w.on("error", () => {});
    w.unref();
    return w.pid === undefined ? null : w;
  } catch {
    return null;
  }
}

function defaultSpawnUnity(exe: string, args: string[]): ChildProcess {
  // macOS / Linux: its own process group, so a stop reaches the Gradle, IL2CPP and import worker children too.
  return spawn(exe, args, { stdio: "ignore", windowsHide: true, detached: process.platform !== "win32" });
}

function validate(o: BuildOptions): void {
  if (!o.method && !o.buildProfile) throw new EmuError("BAD_OPTION", "Pass a build method (--method) or a build profile (--build-profile).");
  if (o.method && o.buildProfile) throw new EmuError("BAD_OPTION", "Pass either a build method or a build profile, not both.");
  if (o.method && !/^[A-Za-z_][\w.]*\.[A-Za-z_]\w*$/.test(o.method)) {
    throw new EmuError("BAD_OPTION", `The build method must be Class.Method or Namespace.Class.Method (got '${o.method}').`);
  }
  if (o.emuArm64 && (o.target !== "Android" || !o.method)) {
    throw new EmuError("BAD_OPTION", "emuArm64 needs target Android and a build method: it is passed to the method as -emuArm64 (EmuProjectBuild reads it).");
  }
  if (o.webglCompression && o.target !== "WebGL") throw new EmuError("BAD_OPTION", "webglCompression is only for target WebGL.");
  const t = o.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
  if (!Number.isFinite(t) || t <= 0) throw new EmuError("BAD_OPTION", `timeoutMinutes must be more than 0 (got ${t}).`);
}

/** Refuse while Unity holds the project: an Editor has it open (PROJECT_OPEN) or a batchmode build runs (BUILD_RUNNING). */
export async function assertProjectFree(projectPath: string, lock: LockProbe): Promise<void> {
  if (!(await lock.isLocked(projectPath))) return;
  const holders = await lock.processes(projectPath);
  const batch = buildHolders(holders);
  if (batch.length) {
    throw new EmuError(
      "BUILD_RUNNING",
      `A batchmode Unity is still building this project (pid ${batch.map((b) => b.pid).join(", ")}): a leftover build from an earlier run ` +
        "that was cut off (tool timeout, closed terminal), or another run that is still going. No Editor needs closing. Wait for it to exit, " +
        "or, after the person agrees, stop that pid. A stopped build does not restore the settings its method changed, so run the guard " +
        `Report afterwards (emu-lab guard report). Project: ${projectPath}`,
    );
  }
  const ids = editorPids(holders);
  if (!ids.length && !holders.length) {
    throw new EmuError(
      "PROJECT_OPEN",
      `Temp/UnityLockfile of ${projectPath} is held, but no running Unity that this shell can see names the project (an elevated Unity, ` +
        "or another user's?): batchmode builds are blocked until it closes. Ask the person to close it.",
    );
  }
  const who = ids.length ? `a Unity Editor (pid ${ids.join(", ")})` : describeHolders(holders);
  throw new EmuError(
    "PROJECT_OPEN",
    `Project is open in ${who}: ${projectPath}. Ask the person to close it, or to build from that Editor and test the output directly ` +
      "(emu-lab smoke <apk> / emu-lab webgl <folder>).",
  );
}

/** Build the project in batchmode and check that this build wrote the output. Throws EmuError on every failure. */
export async function buildUnity(o: BuildOptions): Promise<BuildResult> {
  validate(o);
  const report = o.report;
  const env = o.env ?? process.env;
  const deps = o.deps ?? {};
  const lock = deps.lock ?? realLockProbe;
  const target = o.target;

  if (!o.projectPath || !isDir(o.projectPath)) throw new EmuError("NO_PROJECT", `No project folder at ${o.projectPath}`);
  const projectPath = fullPath(o.projectPath);
  const unity = deps.findUnity ? deps.findUnity(projectPath) : unityForProject(projectPath, { env } as HostOptions);
  const loc = resolveLocations({ env });
  const out = fullPath(o.out?.trim() ? o.out.trim() : defaultBuildOut(loc.labHome, projectPath, target));
  if (target === "Android") {
    if (path.extname(out).toLowerCase() !== ".apk") {
      throw new EmuError("BAD_OPTION", `The output must be an .apk file for Android (got ${out}): the smoke test installs one universal APK, not an .aab or a folder.`);
    }
    if (isDir(out)) {
      throw new EmuError(
        "BAD_OPTION",
        `The output is a folder: ${out} (an exported Gradle project from an earlier 'Export Project' build?). Pass another output, or ask the person before removing it.`,
      );
    }
  } else if (target === "Windows") {
    if (path.extname(out).toLowerCase() !== ".exe") {
      throw new EmuError("BAD_OPTION", `The output must be an .exe file for Windows (got ${out}): Unity writes the player exe there and <name>_Data next to it.`);
    }
    if (isDir(out)) throw new EmuError("BAD_OPTION", `The output is a folder: ${out}. Pass the .exe path, e.g. <folder>/app.exe.`);
  }

  const key = comparablePath(projectPath);
  if (running.has(key)) {
    throw new EmuError("BUILD_RUNNING", `This process is already building ${projectPath}. Wait for that build (emu_job) before starting another.`);
  }
  running.add(key);
  try {
    await assertProjectFree(projectPath, lock);

    const parent = target === "WebGL" ? out : path.dirname(out);
    mkdirSync(parent, { recursive: true });
    const log = buildLogPath(out, target);
    const args = ["-batchmode", "-quit", "-nographics", "-projectPath", projectPath, "-buildTarget", BUILD_TARGET_ARG[target], "-logFile", log];
    if (o.method) {
      args.push("-executeMethod", o.method, "-buildOut", out);
      if (target === "Android") args.push("-apkOut", out);
    } else {
      args.push("-activeBuildProfile", o.buildProfile as string, "-build", out);
    }
    if (o.release) args.push("-release");
    if (o.webglCompression) args.push("-webglCompression", o.webglCompression);
    if (o.emuArm64) args.push("-emuArm64");
    args.push(...(o.extraArgs ?? []));

    // An output inside the lab's own builds folder is cleared first, so whatever is there afterwards was written by
    // this build (a no-change incremental WebGL build otherwise rewrites nothing). Windows: the exe and its _Data only.
    if (isInside(out, path.join(loc.labHome, "builds"))) {
      const clear = target === "Windows" ? [out, windowsDataDir(out)] : [out];
      for (const c of clear) {
        if (existsSync(c)) {
          rmSync(c, { recursive: true, force: true });
          report(`Cleared the previous lab output at ${c}`);
        }
      }
    }
    const before = outputStamp(target, out);

    report(`Unity ${unity.version} [${target}] -> ${out}`);
    const timeoutMinutes = o.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
    const startMs = Date.now();
    const started = new Date(startMs);
    let child: ChildProcess;
    try {
      child = (deps.spawnUnity ?? defaultSpawnUnity)(unity.exe, args);
    } catch (err) {
      throw new EmuError("BUILD_FAILED", `Cannot start Unity ${unity.exe}: ${(err as Error).message}`);
    }
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const pid = child.pid;
    let watchdog: ChildProcess | null = null;
    if (pid !== undefined) {
      live.set(pid, { child, started });
      if (deps.watchdog !== false) {
        watchdog = startWatchdog(pid, started);
        if (!watchdog) report(`WARN no watchdog for Unity pid ${pid}; if this run is cut off, stop that pid by hand.`);
      }
    }
    let result: { code: number | null; signal: NodeJS.Signals | null; error?: Error } | null = null;
    try {
      const limitMs = timeoutMinutes * 60_000;
      let timer: NodeJS.Timeout | undefined;
      result = await Promise.race([
        exit,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), limitMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (result === null) {
        throw new EmuError(
          "BUILD_TIMEOUT",
          `Unity build timed out after ${timeoutMinutes} min and was stopped (a first IL2CPP build of a big project can need a longer timeout). ` +
            `Its method could not restore the settings it changed: run the guard Report now (emu-lab guard report "${projectPath}"). Log: ${log}`,
        );
      }
    } finally {
      if (result === null && pid !== undefined) {
        report(`Stopping Unity pid ${pid} and its child processes`);
        await stopProcessTree(pid, { rootStarted: started });
      }
      if (pid !== undefined) live.delete(pid);
      if (watchdog?.pid !== undefined) {
        try {
          process.kill(watchdog.pid);
        } catch {
          // gone
        }
      }
    }
    const seconds = Math.round((Date.now() - startMs) / 1000);
    if (result.error) throw new EmuError("BUILD_FAILED", `Cannot start Unity ${unity.exe}: ${result.error.message}`);

    const logText = isFile(log) ? readFileSync(log, "utf8") : "";
    const hits = logHits(logText);
    const marker = /EMU_BUILD_(WARN|NOTE)/i;
    const warnings: string[] = [];
    const notes: string[] = [];
    for (const h of hits) {
      const t = h.trim();
      if (/EMU_BUILD_WARN/i.test(t) && !warnings.includes(t)) warnings.push(t);
      else if (/EMU_BUILD_NOTE/i.test(t) && !notes.includes(t)) notes.push(t);
    }
    const seen = new Set<string>();
    for (const h of hits) {
      const t = h.trim();
      if (!marker.test(t) || seen.has(t)) continue;
      seen.add(t);
      report(t);
    }
    for (const h of hits.filter((l) => !marker.test(l)).slice(-5)) report(h);

    if (result.code !== 0) {
      const how = result.code === null ? `signal ${result.signal ?? "?"}` : `exit ${result.code}`;
      throw new EmuError("BUILD_FAILED", `Unity build failed (${how}).${buildErrorSummary(logText)} Log: ${log}`);
    }

    // Exit code 0 is not enough: a project's own method may log a failed BuildReport and return normally.
    const lastFinished = [...hits].reverse().find((l) => /Build Finished, Result: \w+/i.test(l));
    const lastResult = [...hits].reverse().find((l) => /EMU_BUILD_RESULT \w+/i.test(l));
    let failLine: string | undefined;
    if (lastFinished && !/Result: Success/i.test(lastFinished)) failLine = lastFinished;
    else if (lastResult && !/EMU_BUILD_RESULT Succeeded/i.test(lastResult)) failLine = lastResult;
    if (failLine) {
      throw new EmuError(
        "BUILD_FAILED",
        `Unity exited 0 but the log reports a failed build (${failLine.trim()}): the build method returned without EditorApplication.Exit(1). Errors are in ${log}`,
      );
    }

    // Written by this build: newer than its start, or different from before (Unity copies the APK with the Gradle
    // output's timestamp), or nothing there before.
    const after = outputStamp(target, out);
    let fresh =
      after !== null &&
      (before === null || after.time >= startMs || after.time !== before.time || after.bytes !== before.bytes || after.count !== before.count);
    let unchanged = false;
    const named = lastResult ? /EMU_BUILD_RESULT Succeeded .*\bout=(.+)$/i.exec(lastResult.trim()) : null;
    if (!fresh && after && named && samePath(named[1].trim(), out)) {
      // EmuBuild / EmuProjectBuild name the path they built to: a no-change incremental build of that same path is fine.
      fresh = true;
      unchanged = true;
    }
    if (!fresh || !after) throw noOutputError(target, out, after, startMs, log, Boolean(lastFinished), parent);

    if (target === "Windows" && !isDir(windowsDataDir(out))) {
      throw new EmuError("BUILD_NO_OUTPUT", `Unity wrote ${out} but no ${path.basename(windowsDataDir(out))} folder next to it, so the player cannot start. Errors are in ${log}`);
    }
    const note = unchanged ? ", unchanged: incremental build with nothing to rewrite" : "";
    report(`BUILD_OK ${out} (${(Math.round((after.bytes / 1048576) * 10) / 10).toFixed(1)} MB, ${seconds}s${note})`);
    return {
      ok: true,
      target,
      project: projectPath,
      unity_version: unity.version,
      unity_exe: unity.exe,
      method: o.method ?? null,
      build_profile: o.buildProfile ?? null,
      out,
      log,
      seconds,
      bytes: after.bytes,
      files: after.count,
      unchanged,
      warnings,
      notes,
    };
  } finally {
    running.delete(key);
  }
}

function noOutputError(target: BuildTarget, out: string, after: Stamp | null, startMs: number, log: string, logSaysSuccess: boolean, parent: string): EmuError {
  if (target === "Android" && isDir(out)) {
    return new EmuError(
      "BUILD_NO_OUTPUT",
      `Unity exited 0 but wrote a folder at ${out}, not an APK: 'Export Project' (EditorUserBuildSettings.exportAsGoogleAndroidProject) is on. ` +
        "EmuProjectBuild turns it off for its build; with the project's own method or a build profile, ask the person to turn it off for this build. " +
        `Log: ${log}`,
    );
  }
  const old = after ? formatLocal(after.time) : "";
  let what: string;
  if (target === "WebGL") {
    what = after ? `nothing in ${out} was written by this build (newest file from ${old}, before it started): an earlier build left it` : `there is no index.html in ${out}`;
  } else if (target === "Windows") {
    what = after
      ? `the exe at ${out} and its ${path.basename(windowsDataDir(out))} folder are from ${old}, before this build started: an earlier build left them`
      : `nothing was written at ${out}`;
  } else {
    what = after ? `the APK at ${out} is from ${old}, before this build started: an earlier build left it` : `nothing was written at ${out}`;
  }
  let why = logSaysSuccess
    ? "The log says the build succeeded, so the method most likely writes to its own path (ignoring -buildOut/-apkOut)."
    : "The build may have failed without EditorApplication.Exit(1), or the method writes its own path (ignoring -buildOut/-apkOut).";
  const newer = (re: RegExp) => {
    let names: string[] = [];
    try {
      names = readdirSync(parent);
    } catch {
      return [];
    }
    return names.filter((n) => {
      const full = path.join(parent, n);
      if (!re.test(n) || samePath(full, out)) return false;
      try {
        const s = statSync(full);
        return s.isFile() && s.mtimeMs >= startMs;
      } catch {
        return false;
      }
    });
  };
  if (target === "Windows") {
    const others = newer(/\.exe$/i).filter((n) => !/^UnityCrashHandler/i.test(n));
    if (others.length) why = `Unity wrote ${others.join(", ")} in ${parent} instead: the method picks its own exe name. Pass that path as the output.`;
  }
  if (target === "Android") {
    const others = newer(/\.(apk|aab)$/i);
    if (others.length) {
      why =
        `Unity wrote ${others.join(", ")} in ${parent} instead: 'Split APKs by target architecture' (one APK per ABI) or 'Build App Bundle' (.aab) ` +
        "is on, or the method picks its own file name. The test needs one universal .apk at the output; EmuProjectBuild turns both off for its build.";
    }
  }
  const where = `Find where the method really writes in ${log} and pass that path as the output, or pass the method's own output argument through the extra arguments with the same absolute path.`;
  return new EmuError("BUILD_NO_OUTPUT", `Unity exited 0 but ${what}. ${why} ${where}`);
}
