// Protect the person's Unity project around a build (AGENTS.md rule 5). Behavioural reference, rule for rule:
// scripts/project-guard.ps1. The state files have the same names and keys, so one state folder works with both, but the
// default folders differ (here <labHome>/guard/..., the script's <clone>/artifacts/guard/...): to continue a cycle the
// other side started, pass its folder as stateDir. Without it the other side's snapshot is not seen, and the report
// and revert refuse ("No snapshot"), which is safe.
//
//   snapshot  ONCE, BEFORE the first build: record what is already changed. prebuild.patch backs up the tracked
//             changes only; untracked files are listed and hashed, never moved or reverted, and not backed up. Keep the
//             snapshot across rebuilds (marker, emuArm64, second target). A second snapshot refuses while paths changed
//             since the first one (possibly unreported build changes) unless replace.
//   report    after the LAST build: paths the build changed or created since the snapshot (with a content hash each),
//             and files that were already changed before the build and changed again meanwhile (never reverted).
//   revert    ONLY after the person agreed to the report list: back up, revert the reported changed files (only when
//             the backup patch covers exactly them and reverse-applies) and move the reported created files into the
//             backup folder (never deleted). keep skips paths the person edited themselves. Anything new or changed since
//             the report, or a commit since the snapshot, stops the revert before anything changes. On success the
//             snapshot and report are archived, so the next build starts with a new snapshot.
// report and revert refuse while the project is open in Unity: the Editor keeps the build's settings in memory and
// writes them back on save or quit. snapshot works with the Editor open, but not while a batchmode Unity builds.
// git runs with -z, literal pathspecs and UTF-8, so spaces, [brackets] and non-ASCII names are safe, and a project
// that is a subfolder of a larger repository only looks at its own folder. snapshot and report change nothing in
// the project.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, copyFileSync, constants } from "node:fs";
import path from "node:path";
import { resolveLocations } from "./config.ts";
import { EmuError } from "./errors.ts";
import { runProcess } from "./proc.ts";
import { buildHolders, describeHolders, realLockProbe, type LockProbe } from "./project-lock.ts";
import { runStamp } from "./rundir.ts";
import type { Report } from "./types.ts";

export interface GuardDeps {
  lock?: LockProbe;
  /** git executable (default "git" from PATH). */
  git?: string;
  /** Rename a file (tests: a cross-device failure). */
  rename?: (from: string, to: string) => void;
  /** Called before every git command of the guard (tests: make one fail). */
  gitHook?: (args: string[]) => void | Promise<void>;
}

export interface GuardOptions {
  projectPath: string;
  /** Default: <labHome>/guard/<project folder>-<hash of repository root + prefix>. */
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  report: Report;
  deps?: GuardDeps;
}

export interface StatusEntry {
  /** Repository-root relative, forward slashes (as git prints it). */
  Path: string;
  /** git status --porcelain XY ("??" = untracked). */
  XY: string;
}

export interface SnapshotEntry extends StatusEntry {
  /** SHA-256 of the file as "AB-CD-..." (the .NET BitConverter form the PowerShell script writes), or "missing". */
  Hash: string;
}

export interface SnapshotFile {
  project: string;
  top: string;
  prefix: string;
  head: string;
  stash: string;
  entries: SnapshotEntry[];
}

export interface ReportFile {
  head: string;
  changed: string[];
  created: string[];
  staged_not_reverted: string[];
  preexisting_changed_meanwhile: string[];
  hashes: { path: string; hash: string }[];
}

export interface SnapshotResult {
  state_dir: string;
  changed_before_build: number;
  tracked: number;
  untracked: number;
  entries: { path: string; xy: string }[];
  /** prebuild.patch (tracked changes only), or null when nothing tracked was changed. */
  backup: string | null;
  archived: string[];
}

export interface ReportResult {
  state_dir: string;
  head_moved: boolean;
  changed: string[];
  created: string[];
  staged_not_reverted: string[];
  preexisting_changed_meanwhile: string[];
  next: string;
}

export interface RevertResult {
  state_dir: string;
  reverted: string[];
  moved: { path: string; to: string }[];
  kept: string[];
  removed_empty_folders: string[];
  staged_left: number;
  preexisting_left: number;
  backup: string;
  archived: string[];
}

const GIT_TIMEOUT_MS = 10 * 60_000;
/** Paths per git call when reverting (short command lines). */
const REVERT_BATCH = 40;

/** Path keys: Windows and macOS file systems (and the PowerShell script's hashtables) ignore case. */
function keyOf(p: string): string {
  return process.platform === "linux" ? p : p.toLowerCase();
}

function sameText(a: string, b: string): boolean {
  return keyOf(a) === keyOf(b);
}

class PathMap<T> {
  private readonly m = new Map<string, T>();
  set(p: string, v: T): void {
    this.m.set(keyOf(p), v);
  }
  get(p: string): T | undefined {
    return this.m.get(keyOf(p));
  }
  has(p: string): boolean {
    return this.m.has(keyOf(p));
  }
  values(): T[] {
    return [...this.m.values()];
  }
}

function toArray<T>(v: T | T[] | null | undefined): T[] {
  if (v === null || v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).filter((x) => x !== null && x !== undefined);
}

function readJson<T>(file: string): T {
  let text = readFileSync(file, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text) as T;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function formatLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The .NET word class (letters, marks, digits, connector punctuation), as in the script's  -replace '[^\w.-]', '_'. */
function safeLeaf(name: string): string {
  return name.replace(/[^\p{L}\p{Mn}\p{Nd}\p{Pc}.-]/gu, "_");
}

/** Native form of the repository root (git prints forward slashes; Windows paths use backslashes). */
function nativeTop(top: string): string {
  return process.platform === "win32" ? top.replace(/\//g, "\\") : top;
}

/** Repository-root relative path -> absolute path. */
function absOf(top: string, rel: string): string {
  return path.join(top, ...rel.split("/"));
}

/** SHA-256 of a file as the script writes it ("AB-CD-..."), or "missing" when it is not a file. Streams large files. */
export async function fileHashText(top: string, rel: string): Promise<string> {
  const full = absOf(top, rel);
  try {
    if (!statSync(full).isFile()) return "missing";
  } catch {
    return "missing";
  }
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(full);
    s.on("data", (b) => hash.update(b));
    s.on("end", () => resolve());
    s.on("error", reject);
  });
  return (hash.digest("hex").toUpperCase().match(/../g) ?? []).join("-");
}

/** Parse `git status --porcelain=v1 -z` output. Renames and copies keep the new path (the next field is the old one). */
export function parseStatusZ(raw: string): StatusEntry[] {
  const parts = raw.split("\0").filter((p) => p !== "");
  const list: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    list.push({ Path: e.slice(3), XY: xy });
    if ("RC".includes(xy[0]) || "RC".includes(xy[1])) i++;
  }
  return list;
}

/** Paths of `git apply --numstat -z` output (added<TAB>deleted<TAB>path NUL). */
export function parseNumstatZ(raw: string): string[] {
  const out = new Set<string>();
  for (const rec of raw.split("\0")) {
    if (!rec) continue;
    const f = rec.split("\t");
    const p = f.slice(2).join("\t");
    if (f.length >= 3 && p) out.add(p);
  }
  return [...out];
}

// ---------------------------------------------------------------------------------------------------
// git

interface Git {
  run(args: string[]): Promise<string>;
}

/** How long stdout may stay open after git exited before its output counts as incomplete. */
const GIT_OUTPUT_GRACE_MS = 30_000;

/**
 * Run git and return ALL of its stdout. Unlike runProcess (which gives the pipes 500 ms after the exit, for adb), this
 * waits for stdout to end: a status or numstat cut short would hide paths, so it throws instead of returning a part.
 */
function runGitFull(exe: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let code: number | null | undefined;
    let outEnded = false;
    let done = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (e?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(limit);
      if (grace) clearTimeout(grace);
      if (e) {
        try {
          child.kill();
        } catch {
          // gone
        }
        reject(e);
        return;
      }
      resolve({ code: code ?? null, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    };
    const check = () => {
      if (code !== undefined && outEnded) finish();
    };
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.stdout.on("end", () => {
      outEnded = true;
      check();
    });
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.once("error", (e) => finish(e));
    child.once("exit", (c) => {
      code = c;
      check();
      if (!done) grace = setTimeout(() => finish(new Error(`git ${args.join(" ")}: its output did not end after it exited`)), GIT_OUTPUT_GRACE_MS);
    });
    const limit = setTimeout(() => finish(new Error(`git ${args.join(" ")} timed out`)), GIT_TIMEOUT_MS);
  });
}

function makeGit(exe: string, hook?: (args: string[]) => void | Promise<void>): Git {
  return {
    async run(args: string[]): Promise<string> {
      if (hook) await hook(args);
      const r = await runGitFull(exe, ["-c", "core.quotePath=false", "--literal-pathspecs", ...args]);
      if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim()}`);
      return r.stdout;
    },
  };
}

interface Repo {
  git: Git;
  project: string;
  /** Repository root, native separators. */
  top: string;
  /** Project folder relative to the root with a trailing "/", or "" when the project is the root. */
  prefix: string;
  head: string;
  stateDir: string;
  snapFile: string;
  reportFile: string;
}

function findGitDirAbove(start: string): string | null {
  let d = start;
  for (;;) {
    if (existsSync(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** The default state folder: <labHome>/guard/<project folder>-<first 8 hex of SHA-256("<top>|<prefix>" lowercased)>. */
export function defaultStateDir(labHome: string, projectPath: string, top: string, prefix: string): string {
  const key = createHash("sha256").update(`${top}|${prefix}`.toLowerCase(), "utf8").digest("hex").slice(0, 8);
  return path.join(labHome, "guard", `${safeLeaf(path.basename(projectPath))}-${key}`);
}

async function openRepo(o: GuardOptions): Promise<Repo> {
  if (!o.projectPath || !existsSync(o.projectPath)) throw new EmuError("NO_PROJECT", `No project folder at ${o.projectPath}`);
  let project = path.resolve(o.projectPath);
  if (project.length > path.parse(project).root.length) project = project.replace(/[\\/]+$/, "");
  const exe = o.deps?.git ?? "git";
  const git = makeGit(exe, o.deps?.gitHook);
  let probe;
  try {
    probe = await runProcess(exe, ["-C", project, "rev-parse", "--show-toplevel"], { timeoutMs: GIT_TIMEOUT_MS });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // GUI clients (SourceTree, Fork, GitHub Desktop) bundle their own git and often leave it off PATH.
    const at = findGitDirAbove(project);
    if (at) {
      throw new EmuError(
        "NO_GIT",
        `git not found on PATH, but the project is inside a git repo (${path.join(at, ".git")}). Ask the person to install git or add their git ` +
          "client's git to PATH, open a new terminal, then rerun. Nothing changed.",
      );
    }
    throw new EmuError(
      "NO_GIT",
      `git not found on PATH (and no .git folder above ${project}). If the project is not under git, ask the person first and copy ProjectSettings ` +
        "and Packages to a backup folder (AGENTS.md rule 5). Nothing changed.",
    );
  }
  const said = `${probe.stdout} ${probe.stderr}`;
  if (/dubious ownership|is owned by someone else/.test(said)) {
    throw new EmuError("NOT_GIT", "git refused the project (dubious ownership): run outside the agent sandbox (AGENTS.md rule 11). Nothing changed.");
  }
  if (probe.code !== 0) {
    throw new EmuError(
      "NOT_GIT",
      `not a git work tree: ${project}. Without git, ask the person first and copy ProjectSettings and Packages to a backup folder (AGENTS.md rule 5).`,
    );
  }
  const top = nativeTop((await git.run(["-C", project, "rev-parse", "--show-toplevel"])).trim());
  const prefix = (await git.run(["-C", project, "rev-parse", "--show-prefix"])).trim();
  let head: string;
  try {
    head = (await git.run(["-C", top, "rev-parse", "--verify", "HEAD"])).trim();
  } catch {
    throw new EmuError(
      "GUARD_REFUSED",
      `The repository at ${top} has no commit yet, so changes cannot be compared. Ask the person to make a first commit, or to copy the project ` +
        "folder as a backup, before the build.",
    );
  }
  const stateDir = o.stateDir?.trim()
    ? path.resolve(o.stateDir.trim())
    : defaultStateDir(resolveLocations({ env: o.env ?? process.env }).labHome, project, top, prefix);
  mkdirSync(stateDir, { recursive: true });
  return { git, project, top, prefix, head, stateDir, snapFile: path.join(stateDir, "snapshot.json"), reportFile: path.join(stateDir, "report.json") };
}

/** -z output is complete only when it is empty or ends with NUL. */
export function assertCompleteZ(raw: string, what: string): void {
  if (raw !== "" && !raw.endsWith("\0")) throw new Error(`${what}: the output ends in the middle of a record (cut short?); nothing was changed`);
}

async function gitStatus(r: Repo): Promise<StatusEntry[]> {
  const raw = await r.git.run(["-C", r.top, "status", "--porcelain=v1", "-z", "-uall", "--", r.prefix || "."]);
  assertCompleteZ(raw, "git status");
  return parseStatusZ(raw);
}

/** snapshot.json -> snapshot-<stamp>.json (-2, -3 ... when taken). Returns the new path, or null when absent. */
function moveToArchive(dir: string, name: string, stamp: string): string | null {
  const src = path.join(dir, name);
  if (!existsSync(src)) return null;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let dst = path.join(dir, `${base}-${stamp}${ext}`);
  for (let n = 2; existsSync(dst); n++) dst = path.join(dir, `${base}-${stamp}-${n}${ext}`);
  renameSync(src, dst);
  return dst;
}

function archiveState(dir: string, stamp: string): string[] {
  return ["snapshot.json", "report.json", "prebuild.patch"].map((n) => moveToArchive(dir, n, stamp)).filter((x): x is string => x !== null);
}

function sameProject(snap: { top?: unknown; prefix?: unknown } | null, r: Repo): boolean {
  return !!snap && typeof snap.top === "string" && sameText(snap.top, r.top) && sameText(String(snap.prefix ?? ""), r.prefix);
}

// ---------------------------------------------------------------------------------------------------
// Snapshot

export async function guardSnapshot(o: GuardOptions & { replace?: boolean }): Promise<SnapshotResult> {
  const r = await openRepo(o);
  const report = o.report;
  const lock = o.deps?.lock ?? realLockProbe;
  const stamp = runStamp();

  if (await lock.isLocked(r.project)) {
    const holders = await lock.processes(r.project);
    if (buildHolders(holders).length) {
      throw new EmuError(
        "BUILD_RUNNING",
        `A batchmode Unity is running on this project (${describeHolders(holders)}): a snapshot taken during a build would count its changes as the ` +
          "person's own work. Wait for it to end. Nothing changed.",
      );
    }
    report(
      `NOTE: the project is open (${describeHolders(holders)}). Fine only if the person builds in this Editor. For a batchmode build, ask them to ` +
        "close the Editor first and take the snapshot after it is closed: what the Editor writes when it quits would otherwise count as build " +
        "changes. The Editor must be closed before report and revert.",
    );
  }
  const status = await gitStatus(r);
  const entries: SnapshotEntry[] = [];
  for (const s of status) entries.push({ Path: s.Path, XY: s.XY, Hash: await fileHashText(r.top, s.Path) });
  let stashRef = "";
  try {
    stashRef = (await r.git.run(["-C", r.top, "rev-parse", "-q", "--verify", "refs/stash"])).trim();
  } catch {
    stashRef = "";
  }

  if (existsSync(r.snapFile)) {
    const when = formatLocal(statSync(r.snapFile).mtime);
    let old: SnapshotFile | null = null;
    try {
      old = readJson<SnapshotFile>(r.snapFile);
    } catch {
      old = null;
    }
    if (!old || !sameProject(old, r)) {
      const whose = old ? `a snapshot of another project (${old.project}, ${when})` : `an unreadable snapshot.json (${when})`;
      if (!o.replace) {
        throw new EmuError("GUARD_REFUSED", `${r.stateDir} already holds ${whose}. Pass the right state folder, or replace to archive it and start over. Nothing changed.`);
      }
    } else {
      const oldEntries = toArray(old.entries);
      const oldHash = new PathMap<string>();
      for (const e of oldEntries) oldHash.set(e.Path, e.Hash);
      const since: { e: StatusEntry; gone: boolean }[] = entries.filter((e) => !oldHash.has(e.Path) || oldHash.get(e.Path) !== e.Hash).map((e) => ({ e, gone: false }));
      // Paths that disappeared pass only when a commit or a stash explains it: a build can also delete or reset files.
      const nowPaths = new PathMap<true>();
      for (const e of entries) nowPaths.set(e.Path, true);
      const gone = oldEntries.filter((e) => !nowPaths.has(e.Path));
      const explained = old.head !== r.head || String(old.stash ?? "") !== stashRef;
      if (!explained) for (const g of gone) since.push({ e: g, gone: true });
      if (since.length && !o.replace) {
        for (const s of since) {
          if (s.gone) report(`  gone since the last snapshot: ${s.e.XY} ${s.e.Path} (no commit or stash explains it: removed or reset by a build?)`);
          else report(`  changed since the last snapshot: ${s.e.XY} ${s.e.Path}`);
        }
        const rep = existsSync(r.reportFile) ? " A report was taken from it but no revert followed." : "";
        throw new EmuError(
          "GUARD_REFUSED",
          `A snapshot from ${when} (HEAD ${old.head}) already exists and ${since.length} path(s) changed since it, possibly an earlier build's changes ` +
            `that were never reverted.${rep} Keep the first snapshot across rebuilds and run the report after the last build. Pass replace only when ` +
            "the person says these are their own changes. Nothing changed.",
        );
      }
    }
  }

  const tracked = entries.filter((e) => e.XY !== "??");
  const untracked = entries.filter((e) => e.XY === "??");
  const patch = path.join(r.stateDir, "prebuild.patch");
  // Written before the old state is archived, so a failed diff leaves the old snapshot in place.
  const patchNew = `${patch}.new`;
  if (existsSync(patchNew)) unlinkSync(patchNew);
  if (tracked.length) await r.git.run(["-C", r.top, "diff", "--binary", "HEAD", `--output=${patchNew}`, "--", r.prefix || "."]);
  // Archive (never delete) the previous cycle's files, so a stale prebuild.patch or report cannot be mistaken for this one.
  const archived = archiveState(r.stateDir, stamp);
  if (existsSync(patchNew)) renameSync(patchNew, patch);
  const snap: SnapshotFile = { project: r.project, top: r.top, prefix: r.prefix, head: r.head, stash: stashRef, entries };
  writeJson(r.snapFile, snap);

  report(`GUARD_SNAPSHOT changed_before_build=${entries.length} tracked=${tracked.length} untracked=${untracked.length} state=${r.stateDir}`);
  for (const a of archived) report(`  archived previous ${a}`);
  for (const e of entries) report(`  ${e.XY} ${e.Path}`);
  if (tracked.length) report(`  backup=${patch} holds the tracked changes only (git diff HEAD).`);
  if (untracked.length) {
    report(
      `  The ${untracked.length} untracked file(s) (??) are NOT backed up: they are only listed and hashed. The guard never moves or reverts them, ` +
        "but cannot restore them if the build overwrites them.",
    );
  }
  if (entries.length) report("Ask the person: commit/stash these first, or build as is. If they commit/stash, take the snapshot again.");
  report("Keep this snapshot for every rebuild (marker, emuArm64, second target) and run the report after the last build.");
  return {
    state_dir: r.stateDir,
    changed_before_build: entries.length,
    tracked: tracked.length,
    untracked: untracked.length,
    entries: entries.map((e) => ({ path: e.Path, xy: e.XY })),
    backup: tracked.length ? patch : null,
    archived,
  };
}

// ---------------------------------------------------------------------------------------------------
// Report and Revert: shared start

interface Compared {
  r: Repo;
  snap: SnapshotFile;
  headMoved: boolean;
  newTracked: StatusEntry[];
  newStaged: StatusEntry[];
  newUntracked: StatusEntry[];
  touched: SnapshotEntry[];
}

async function compare(o: GuardOptions, mode: "report" | "revert"): Promise<Compared> {
  const r = await openRepo(o);
  const lock = o.deps?.lock ?? realLockProbe;
  if (!existsSync(r.snapFile)) {
    let names: string[] = [];
    try {
      names = readdirSync(r.stateDir).filter((n) => /^snapshot-.*\.json$/.test(n)).sort().reverse();
    } catch {
      names = [];
    }
    const hint = names.length
      ? ` The last one was archived (${names[0]}) after a revert: that cycle is finished; take a new snapshot before the next build.`
      : "";
    throw new EmuError(
      "GUARD_REFUSED",
      `No snapshot in ${r.stateDir}.${hint} A snapshot must be taken BEFORE the build; taking one now would count the build's changes as the person's own work.`,
    );
  }
  const snap = readJson<SnapshotFile>(r.snapFile);
  if (!sameProject(snap, r)) {
    throw new EmuError("GUARD_REFUSED", `The snapshot in ${r.stateDir} belongs to another project (${snap.project}). Pass the right state folder or take a new snapshot before the next build.`);
  }
  const nothing = mode === "revert" ? "Nothing reverted." : "No report written.";
  if (await lock.isLocked(r.project)) {
    const holders = await lock.processes(r.project);
    if (buildHolders(holders).length) {
      throw new EmuError("BUILD_RUNNING", `A batchmode Unity is still running on this project (${describeHolders(holders)}). Wait for the build to end, then run the ${mode} again. ${nothing}`);
    }
    throw new EmuError(
      "PROJECT_OPEN",
      `The project is open in Unity (${describeHolders(holders)}). Ask the person to close the Unity Editor before the ${mode}: the Editor keeps the ` +
        "build's settings (PlayerSettings and other ProjectSettings) in memory and writes them back on its next save or on quit, which silently " +
        `undoes a revert. ${nothing}`,
    );
  }
  const before = new PathMap<SnapshotEntry>();
  for (const e of toArray(snap.entries)) before.set(e.Path, e);
  const now = await gitStatus(r);
  const fresh = now.filter((e) => !before.has(e.Path));
  const touched: SnapshotEntry[] = [];
  for (const e of before.values()) if ((await fileHashText(r.top, e.Path)) !== e.Hash) touched.push(e);
  return {
    r,
    snap,
    headMoved: snap.head !== r.head,
    newTracked: fresh.filter((e) => e.XY !== "??" && e.XY[0] === " "),
    newStaged: fresh.filter((e) => e.XY !== "??" && e.XY[0] !== " "),
    newUntracked: fresh.filter((e) => e.XY === "??"),
    touched,
  };
}

export async function guardReport(o: GuardOptions): Promise<ReportResult> {
  const c = await compare(o, "report");
  const { r, report } = { r: c.r, report: o.report };
  const hashes: { path: string; hash: string }[] = [];
  for (const e of [...c.newTracked, ...c.newUntracked]) hashes.push({ path: e.Path, hash: await fileHashText(r.top, e.Path) });
  const file: ReportFile = {
    head: r.head,
    changed: c.newTracked.map((e) => e.Path),
    created: c.newUntracked.map((e) => e.Path),
    staged_not_reverted: c.newStaged.map((e) => e.Path),
    preexisting_changed_meanwhile: c.touched.map((e) => e.Path),
    // Content at report time: the revert refuses when a reported path changed after the person saw the list.
    hashes,
  };
  writeJson(r.reportFile, file);
  if (c.headMoved) report(`WARN: HEAD moved since the snapshot (${c.snap.head} -> ${r.head}); commits made meanwhile are not build changes. The revert will refuse.`);
  report(`GUARD_REPORT changed=${c.newTracked.length} created=${c.newUntracked.length} staged=${c.newStaged.length} preexisting_touched=${c.touched.length}`);
  for (const e of c.newTracked) report(`  changed  ${e.Path}`);
  for (const e of c.newUntracked) report(`  created  ${e.Path}`);
  for (const e of c.newStaged) report(`  staged   ${e.Path} (not reverted)`);
  for (const e of c.touched) report(`  touched  ${e.Path} (was already changed before the build; never reverted)`);
  const next =
    "Show this list to the person. Ask which of these files they edited themselves during the build (pass them as keep) and whether to revert the rest (revert).";
  report(next);
  return {
    state_dir: r.stateDir,
    head_moved: c.headMoved,
    changed: file.changed,
    created: file.created,
    staged_not_reverted: file.staged_not_reverted,
    preexisting_changed_meanwhile: file.preexisting_changed_meanwhile,
    next,
  };
}

/** Move one file; across volumes copy, check the size, then delete the source (a rename cannot cross them). */
function moveFile(src: string, dst: string, rename: (a: string, b: string) => void): void {
  try {
    rename(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    copyFileSync(src, dst, constants.COPYFILE_EXCL);
    if (statSync(dst).size !== statSync(src).size) throw new Error(`copy of ${src} to ${dst} is incomplete; the source was left in place`);
    unlinkSync(src);
  }
}

function isEmptyDir(d: string): boolean {
  try {
    return readdirSync(d).length === 0;
  } catch {
    return false;
  }
}

export async function guardRevert(o: GuardOptions & { keep?: string | string[] }): Promise<RevertResult> {
  const c = await compare(o, "revert");
  const r = c.r;
  const report = o.report;
  if (c.headMoved) {
    throw new EmuError("GUARD_REFUSED", `HEAD moved since the snapshot (${c.snap.head} -> ${r.head}): commits were made meanwhile, so the build's changes cannot be told apart. Nothing reverted.`);
  }
  if (!existsSync(r.reportFile)) throw new EmuError("GUARD_REFUSED", "Run the report first and show its list to the person before reverting. Nothing reverted.");
  const rep = readJson<Partial<ReportFile>>(r.reportFile);
  if (rep.hashes === null || rep.hashes === undefined) {
    throw new EmuError("GUARD_REFUSED", "The report was written by an older project-guard without content hashes. Run the report again and show the list to the person. Nothing reverted.");
  }
  // What the person approved is matched by exact text: a path that differs only in case from a reported one (possible
  // on a case-sensitive volume) counts as unreported, so it is never reverted or moved without being shown first.
  const keepSet = new Set((Array.isArray(o.keep) ? o.keep : (o.keep ?? "").split("|")).map((k) => k.trim().replace(/\\/g, "/")).filter(Boolean));
  const approvedChanged = new Set(toArray(rep.changed));
  const approvedCreated = new Set(toArray(rep.created));
  const neverReverted = new Set([...toArray(rep.staged_not_reverted), ...toArray(rep.preexisting_changed_meanwhile)]);
  const keepNames = [...keepSet];
  const unknownKeep = keepNames.filter((k) => !approvedChanged.has(k) && !approvedCreated.has(k) && !neverReverted.has(k));
  if (unknownKeep.length) {
    throw new EmuError("GUARD_REFUSED", `keep names paths that are not in the report: ${unknownKeep.join(", ")}. Copy them exactly as the report printed them. Nothing reverted.`);
  }
  const unreported = [...c.newTracked, ...c.newUntracked].filter((e) => !approvedChanged.has(e.Path) && !approvedCreated.has(e.Path));
  if (unreported.length) {
    for (const e of unreported) report(`  new since report: ${e.XY} ${e.Path}`);
    throw new EmuError("GUARD_REFUSED", "Files changed after the report. Run the report again and show the new list to the person. Nothing reverted.");
  }
  // Kept paths are left alone, so later edits to them do not matter.
  const changedSince: string[] = [];
  for (const h of toArray(rep.hashes)) {
    if (!h || keepSet.has(h.path)) continue;
    if ((await fileHashText(r.top, h.path)) !== h.hash) changedSince.push(h.path);
  }
  if (changedSince.length) {
    for (const p of changedSince) report(`  changed since report: ${p}`);
    throw new EmuError(
      "GUARD_REFUSED",
      `${changedSince.length} reported path(s) changed after the report. Run the report again and show the new list to the person. Nothing reverted.`,
    );
  }
  const toRevert = c.newTracked.filter((e) => approvedChanged.has(e.Path) && !keepSet.has(e.Path)).map((e) => e.Path);
  const toMove = c.newUntracked.filter((e) => approvedCreated.has(e.Path) && !keepSet.has(e.Path)).map((e) => e.Path);
  // Every file to move must be a file (or link) before anything changes: a folder entry (a nested repository) stops here.
  for (const p of toMove) {
    let ok = false;
    try {
      const s = lstatSync(absOf(r.top, p));
      ok = s.isFile() || s.isSymbolicLink();
    } catch {
      ok = false;
    }
    if (!ok) throw new EmuError("GUARD_REFUSED", `${p} is not a file that can be moved (a folder or gone). Ask the person what it is. Nothing reverted.`);
  }

  const stamp = runStamp();
  let backup = path.join(r.stateDir, `revert-${stamp}`);
  for (let n = 2; existsSync(backup); n++) backup = path.join(r.stateDir, `revert-${stamp}-${n}`);
  mkdirSync(backup, { recursive: true });
  const reverted: string[] = [];
  for (let i = 0, batch = 1; i < toRevert.length; i += REVERT_BATCH, batch++) {
    const chunk = toRevert.slice(i, i + REVERT_BATCH);
    const patch = path.join(backup, `build-changes-${batch}.patch`);
    await r.git.run(["-C", r.top, "diff", "--binary", "--no-renames", `--output=${patch}`, "--", ...chunk]);
    // The patch must cover exactly these paths and reverse-apply cleanly before anything is checked out.
    const numstat = await r.git.run(["-C", r.top, "apply", "--numstat", "-z", patch]);
    assertCompleteZ(numstat, "git apply --numstat");
    const inPatch = parseNumstatZ(numstat);
    const want = new Set(chunk);
    const got = new Set(inPatch);
    if (want.size !== got.size || [...want].some((k) => !got.has(k))) {
      throw new EmuError(
        "GUARD_REFUSED",
        `Backup patch does not match the paths to revert (${patch}). Stopped; ${reverted.length ? `${reverted.length} path(s) of earlier batches are already reverted` : "nothing was reverted"}.`,
      );
    }
    await r.git.run(["-C", r.top, "apply", "--check", "-R", patch]);
    await r.git.run(["-C", r.top, "checkout", "--", ...chunk]);
    for (const p of chunk) {
      report(`  reverted ${p}`);
      reverted.push(p);
    }
  }
  const rename = o.deps?.rename ?? renameSync;
  const moved: { path: string; to: string }[] = [];
  for (const p of toMove) {
    const src = absOf(r.top, p);
    const dst = path.join(backup, "created", ...p.split("/"));
    mkdirSync(path.dirname(dst), { recursive: true });
    moveFile(src, dst, rename);
    report(`  moved    ${p} -> ${dst}`);
    moved.push({ path: p, to: dst });
  }
  // Folders the moved files leave empty (e.g. Assets/EmuLab/Editor from the template) would make Unity create a folder
  // .meta again on the next import. Remove them bottom-up, only while empty, never the project folder or above it, and
  // never a folder whose <folder>.meta is still there (a folder the project already had keeps its tracked .meta).
  const projDir = absOf(r.top, r.prefix.replace(/\/+$/, "")).replace(/[\\/]+$/, "");
  const sep = path.sep;
  const removed: string[] = [];
  const dirs = [...new Set(toMove.map((p) => path.dirname(absOf(r.top, p))))].sort((a, b) => b.length - a.length);
  for (const d of dirs) {
    let cur = d;
    try {
      while (
        cur.length > projDir.length &&
        keyOf(cur).startsWith(keyOf(projDir + sep)) &&
        existsSync(cur) &&
        statSync(cur).isDirectory() &&
        !existsSync(`${cur}.meta`) &&
        isEmptyDir(cur)
      ) {
        rmdirSync(cur);
        const rel = cur.slice(projDir.length + 1);
        report(`  removed empty folder ${rel}`);
        removed.push(rel);
        cur = path.dirname(cur);
      }
    } catch (err) {
      // The revert itself is done; an empty folder left behind is only reported.
      report(`  WARN could not remove the empty folder ${cur}: ${(err as Error).message}`);
    }
  }
  for (const k of keepNames) {
    if (neverReverted.has(k)) report(`  kept     ${k} (staged or touched: never reverted anyway)`);
    else report(`  kept     ${k} (person edited it)`);
  }
  report(
    `GUARD_REVERT reverted=${reverted.length} moved=${moved.length} kept=${keepNames.length} staged_left=${c.newStaged.length} ` +
      `preexisting_left=${c.touched.length} backup=${backup}`,
  );
  // This cycle is done: archive its state so the next build starts with a fresh snapshot.
  const archived = archiveState(r.stateDir, stamp);
  for (const a of archived) report(`  archived ${a}`);
  report("Snapshot and report archived: take a new snapshot before the next build.");
  return {
    state_dir: r.stateDir,
    reverted,
    moved,
    kept: keepNames,
    removed_empty_folders: removed,
    staged_left: c.newStaged.length,
    preexisting_left: c.touched.length,
    backup,
    archived,
  };
}

/**
 * Whether the project has a guard snapshot in the default state folder: { inGit: false } outside a git work tree (or
 * without git), else the state folder and whether snapshot.json is there. Changes nothing (the state folder may be
 * created). Used by build and template to warn or refuse before they change the project.
 */
export async function guardState(o: { projectPath: string; stateDir?: string; env?: NodeJS.ProcessEnv; deps?: GuardDeps }): Promise<{ inGit: boolean; stateDir?: string; snapshot?: boolean }> {
  try {
    const r = await openRepo({ ...o, report: () => {} });
    return { inGit: true, stateDir: r.stateDir, snapshot: existsSync(r.snapFile) };
  } catch (err) {
    if (err instanceof EmuError && (err.code === "NO_GIT" || err.code === "NOT_GIT")) return { inGit: false };
    if (err instanceof EmuError && err.code === "GUARD_REFUSED") return { inGit: true, snapshot: false };
    throw err;
  }
}
