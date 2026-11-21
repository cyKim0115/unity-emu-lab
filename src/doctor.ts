// Pre-flight check of this host for the lab, on Windows, macOS and Linux. Changes nothing; one line per check, the
// same statuses and exit codes as scripts/doctor.ps1:
//   [OK] ready   [TODO] an agent can do it after the person agrees   [HUMAN] only the person can do it
//   [WARN] works, read the note   [FAIL] blocks a target   [INFO] for reference
// Exit code: 0 ready, 2 only TODO left, 1 HUMAN or FAIL left.
//
// Host checks per OS: emulator acceleration (emulator -accel-check when the SDK is there; else KVM /dev/kvm on Linux,
// Hypervisor.framework on macOS, WHPX/AEHD prerequisites on Windows), the -gpu mode `start` would use, Unity editors
// and their modules (Windows, macOS and Linux layouts), the person's project (version, modules, lock, git, guard
// snapshot, Android ABI, Windows backend), the Android SDK and AVD (system image ABI against the host CPU), disk space
// and a browser for WebGL.

import { existsSync, readdirSync, readFileSync, statfsSync, statSync, writeFileSync, rmSync, accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { resolveLocations, type Locations } from "./config.ts";
import { resolveEmulatorGpu } from "./emulator.ts";
import { EmuError } from "./errors.ts";
import { guardState } from "./guard.ts";
import { isLeaseValid, leasePath, readLease } from "./lease.ts";
import { runProcess } from "./proc.ts";
import { editorPids, buildHolders, realLockProbe, type LockProbe } from "./project-lock.ts";
import type { Report } from "./types.ts";
import {
  androidMissing,
  androidTargetArchitectures,
  findPathPattern,
  findUnityInstalls,
  hasAndroidPlayer,
  hasWebGL,
  jdkMajor,
  playbackEnginesDir,
  readExternalAndroidTools,
  readProjectVersion,
  scriptingBackend,
  windowsMissing,
  type ExternalAndroidTools,
  type UnityInstall,
} from "./unity.ts";
import { findBrowser, type BrowserLocation } from "./webgl/browser.ts";

export type DoctorStatus = "OK" | "TODO" | "HUMAN" | "WARN" | "FAIL" | "INFO";
export type DoctorTarget = "Android" | "WebGL" | "Windows" | "Both";

export interface DoctorLine {
  status: DoctorStatus;
  key: string;
  message: string;
}

export interface DoctorResult {
  verdict: "READY" | "TODO" | "BLOCKED";
  exit_code: 0 | 1 | 2;
  human_fail: number;
  todo: number;
  target: DoctorTarget;
  lines: DoctorLine[];
}

/** What the checks read from the host; tests replace any of them. */
export interface DoctorProbes {
  platform: NodeJS.Platform;
  /** CPU architecture of the host (Windows on ARM reports arm64 even to an emulated x64 Node). */
  arch: string;
  totalMemBytes: number;
  osText: string;
  home: string;
  /** Output of `emulator -accel-check`, or null when it cannot run. */
  accelCheck: (emulatorExe: string, env: NodeJS.ProcessEnv) => Promise<string | null>;
  /** Linux /dev/kvm. */
  kvm: () => { exists: boolean; access: boolean };
  /** macOS `sysctl -n kern.hv_support` ("1" = Hypervisor.framework usable), or null. */
  macHvSupport: () => Promise<string | null>;
  /** Windows: hypervisor running, CPU virtualization on in firmware; null when unknown. */
  winVirtualization: () => Promise<{ hypervisorPresent: boolean; firmwareEnabled: boolean | null } | null>;
  /** Linux: a GPU render node (/dev/dri/renderD*). */
  hasRenderNode: () => boolean;
  installs: () => UnityInstall[];
  externalTools: () => Promise<ExternalAndroidTools>;
  lock: LockProbe;
  browser: () => BrowserLocation | null;
  /** Free bytes on the volume that holds path (or its nearest existing parent); null when unknown. */
  freeBytes: (p: string) => number | null;
  /** Windows: Visual Studio with the C++ tools (vswhere), or null. */
  vsCpp: () => Promise<string | null>;
  /** Windows: the packaged (MSIX) app this shell runs in, when AppData writes are redirected; else null. */
  packagedHost: () => string | null;
  /** git status --porcelain count for the project, or a reason it is not a git work tree. */
  gitState: (projectPath: string) => Promise<{ inGit: true; changed: number; snapshot: boolean } | { inGit: false; why: "no-git-on-path" | "dubious" | "not-git"; gitAt?: string }>;
}

const GB = 1024 ** 3;

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

function existingAncestor(p: string): string | null {
  let d = path.resolve(p);
  for (;;) {
    if (existsSync(d)) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** Parse `emulator -accel-check`: "accel:\n0\n<message>\naccel" (0 = usable). null when the output has another shape. */
export function parseAccelCheck(text: string): { ok: boolean; message: string } | null {
  const m = /accel:\s*\r?\n\s*(-?\d+)\s*\r?\n([\s\S]*?)\r?\n\s*accel\b/.exec(text);
  if (m) return { ok: m[1] === "0", message: m[2].trim().replace(/\s*\r?\n\s*/g, " ") };
  const t = text.trim();
  if (!t) return null;
  // Older or other builds print only the message.
  if (/is installed and usable|Hypervisor\.Framework OS X Version/i.test(t)) return { ok: true, message: t.replace(/\s+/g, " ") };
  return { ok: false, message: t.replace(/\s+/g, " ") };
}

/** Which Android system-image ABI runs accelerated on this CPU. */
export function hostAbi(arch: string): "x86_64" | "arm64-v8a" | null {
  if (arch === "x64") return "x86_64";
  if (arch === "arm64") return "arm64-v8a";
  return null;
}

function inside(inner: string, outer: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string) => {
    let n = path.resolve(p);
    if (n.length > path.parse(n).root.length) n = n.replace(/[\\/]+$/, "");
    return platform === "linux" ? n : n.toLowerCase();
  };
  const i = norm(inner);
  const o = norm(outer);
  return i === o || i.startsWith(o.endsWith(path.sep) ? o : o + path.sep);
}

// ---------------------------------------------------------------------------------------------------
// Real probes

async function realAccelCheck(emulatorExe: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const r = await runProcess(emulatorExe, ["-accel-check"], { timeoutMs: 60_000, env });
    return `${r.stdout}\n${r.stderr}`;
  } catch {
    return null;
  }
}

async function realMacHv(): Promise<string | null> {
  try {
    const r = await runProcess("sysctl", ["-n", "kern.hv_support"], { timeoutMs: 15_000 });
    return r.code === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

async function realWinVirt(): Promise<{ hypervisorPresent: boolean; firmwareEnabled: boolean | null } | null> {
  const cmd =
    "$cs = Get-CimInstance Win32_ComputerSystem; $cpu = @(Get-CimInstance Win32_Processor)[0]; " +
    "[string]$cs.HypervisorPresent + '|' + [string]$cpu.VirtualizationFirmwareEnabled";
  try {
    const r = await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { timeoutMs: 30_000 });
    const [h, f] = r.stdout.trim().split("|");
    if (h === undefined) return null;
    return { hypervisorPresent: /^true$/i.test(h), firmwareEnabled: f === undefined || f === "" ? null : /^true$/i.test(f) };
  } catch {
    return null;
  }
}

async function realVsCpp(env: NodeJS.ProcessEnv): Promise<string | null> {
  const pf86 = env["ProgramFiles(x86)"] ?? env["PROGRAMFILES(X86)"];
  if (!pf86) return null;
  const vswhere = path.join(pf86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!isFile(vswhere)) return null;
  try {
    const r = await runProcess(vswhere, ["-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], {
      timeoutMs: 30_000,
    });
    return r.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

function realPackagedHost(env: NodeJS.ProcessEnv): string | null {
  // An MSIX app's shell has no package identity of its own, so test the redirection itself.
  const local = env.LOCALAPPDATA;
  if (!local) return null;
  const probe = `emu-lab-probe-${randomBytes(8).toString("hex")}.txt`;
  const file = path.join(local, probe);
  try {
    writeFileSync(file, "probe");
    for (const n of readdirSync(path.join(local, "Packages"))) {
      if (existsSync(path.join(local, "Packages", n, "LocalCache", "Local", probe))) return n;
    }
  } catch {
    return null;
  } finally {
    rmSync(file, { force: true });
  }
  return null;
}

function realFreeBytes(p: string): number | null {
  const at = existingAncestor(p);
  if (!at) return null;
  try {
    const s = statfsSync(at);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

async function realGitState(projectPath: string, env: NodeJS.ProcessEnv): ReturnType<DoctorProbes["gitState"]> {
  try {
    const st = await guardState({ projectPath, env });
    if (!st.inGit) {
      // guardState says not-git for every refusal: tell them apart for the advice.
      const probe = await runProcess("git", ["-C", projectPath, "rev-parse", "--is-inside-work-tree"], { timeoutMs: 60_000 }).catch((e: NodeJS.ErrnoException) => e);
      if (probe instanceof Error) {
        let d = path.resolve(projectPath);
        for (;;) {
          if (existsSync(path.join(d, ".git"))) return { inGit: false, why: "no-git-on-path", gitAt: d };
          const up = path.dirname(d);
          if (up === d) break;
          d = up;
        }
        return { inGit: false, why: "not-git" };
      }
      if (/dubious ownership|is owned by someone else/.test(`${probe.stdout}${probe.stderr}`)) return { inGit: false, why: "dubious" };
      return { inGit: false, why: "not-git" };
    }
    const r = await runProcess("git", ["-C", projectPath, "status", "--porcelain", "--", "."], { timeoutMs: 120_000 });
    const changed = r.stdout.split(/\r?\n/).filter(Boolean).length;
    return { inGit: true, changed, snapshot: Boolean(st.snapshot) };
  } catch {
    return { inGit: false, why: "not-git" };
  }
}

function realProbes(env: NodeJS.ProcessEnv): DoctorProbes {
  const platform = process.platform;
  // A Windows-on-ARM host runs an x64 Node under emulation: PROCESSOR_ARCHITEW6432 / PROCESSOR_ARCHITECTURE say ARM64.
  const winArm = platform === "win32" && (env.PROCESSOR_ARCHITEW6432 === "ARM64" || env.PROCESSOR_ARCHITECTURE === "ARM64");
  const arch = winArm ? "arm64" : platform === "darwin" && os.cpus()[0]?.model.startsWith("Apple") ? "arm64" : process.arch;
  return {
    platform,
    arch,
    totalMemBytes: os.totalmem(),
    osText: `${os.type()} ${os.release()} (${arch})`,
    home: os.homedir(),
    accelCheck: realAccelCheck,
    kvm: () => {
      const exists = existsSync("/dev/kvm");
      let access = false;
      if (exists) {
        try {
          accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
          access = true;
        } catch {
          access = false;
        }
      }
      return { exists, access };
    },
    macHvSupport: realMacHv,
    winVirtualization: realWinVirt,
    hasRenderNode: () => {
      try {
        return readdirSync("/dev/dri").some((n) => n.startsWith("renderD"));
      } catch {
        return false;
      }
    },
    installs: () => findUnityInstalls({ env, includeShadowed: true }),
    externalTools: () => readExternalAndroidTools({ env }),
    lock: realLockProbe,
    browser: () => findBrowser({ env }),
    freeBytes: realFreeBytes,
    vsCpp: () => realVsCpp(env),
    packagedHost: () => (platform === "win32" ? realPackagedHost(env) : null),
    gitState: (p) => realGitState(p, env),
  };
}

// ---------------------------------------------------------------------------------------------------

export interface DoctorOptions {
  projectPath?: string;
  /** Default "Both" (Android and WebGL), like doctor.ps1. */
  target?: DoctorTarget;
  env?: NodeJS.ProcessEnv;
  report: Report;
  probes?: Partial<DoctorProbes>;
}

/** Run every check and return the lines, the verdict and the exit code (0 ready, 2 TODO only, 1 HUMAN or FAIL). */
export async function runDoctor(o: DoctorOptions): Promise<DoctorResult> {
  const env = o.env ?? process.env;
  const target = o.target ?? "Both";
  if (!["Android", "WebGL", "Windows", "Both"].includes(target)) throw new EmuError("BAD_OPTION", `target must be Android, WebGL, Windows or Both (got ${target}).`);
  const pr: DoctorProbes = { ...realProbes(env), ...(o.probes ?? {}) };
  const loc = resolveLocations({ env, platform: pr.platform, home: pr.home });
  const lines: DoctorLine[] = [];
  const add = (status: DoctorStatus, key: string, message: string) => {
    lines.push({ status, key, message });
    o.report(`[${status}] ${key}: ${message}`);
  };
  const wantAndroid = target === "Android" || target === "Both";
  const wantWebGL = target === "WebGL" || target === "Both";
  const wantWindows = target === "Windows";
  const targetText = target === "Both" ? "Android and WebGL" : target;
  const onlyOneHint = target === "Both" ? " If you use only one platform, rerun with --target android, webgl or windows." : "";
  const win = pr.platform === "win32";

  // --- host
  add("INFO", "os", `${pr.osText}, Node.js ${process.versions.node}`);
  const ramGb = Math.round(pr.totalMemBytes / GB);
  add(ramGb >= 16 ? "OK" : "WARN", "ram", `${ramGb} GB (16 GB or more recommended for the emulator plus Unity)`);
  const pkg = pr.packagedHost();
  if (pkg) {
    add(
      "WARN",
      "packaged-host",
      `this shell runs inside the packaged app '${pkg}': files it writes under %LOCALAPPDATA% / %APPDATA% go to that app's private folder and do not ` +
        "exist for other terminals. Keep the SDK and AVD outside AppData and do the final check in a normal terminal.",
    );
  }
  if (loc.configError) add("FAIL", "config", `${loc.configError}. Fix the JSON or delete the file to use the defaults.`);

  // --- Android host and emulator acceleration
  const abi = hostAbi(pr.arch);
  let androidHost = wantAndroid;
  if (wantAndroid) {
    if (win && pr.arch === "arm64") {
      add("FAIL", "android-host", "Windows on ARM (ARM64): the Android emulator does not run accelerated here, so the Android target is not supported on this PC. --target webgl still works; test Android on a real device.");
      androidHost = false;
    } else if (pr.platform === "linux" && pr.arch === "arm64") {
      add("WARN", "android-host", "Linux on ARM64: the Android emulator has no supported build for this host; expect it to fail. --target webgl works; test Android on a real device or an x86_64 / Apple silicon host.");
    } else if (!abi) {
      add("FAIL", "android-host", `CPU architecture ${pr.arch}: the Android emulator runs on x86_64 and ARM64 hosts only.`);
      androidHost = false;
    } else if (pr.platform === "darwin" && abi === "arm64-v8a") {
      add("INFO", "android-host", "Apple silicon: the AVD needs an arm64-v8a system image (x86_64 images do not run accelerated here). The app needs arm64-v8a code too (IL2CPP + ARM64).");
    }
  }
  if (androidHost) {
    let accelLine: DoctorLine | null = null;
    if (isFile(loc.emulator)) {
      const out = await pr.accelCheck(loc.emulator, env);
      const parsed = out === null ? null : parseAccelCheck(out);
      if (parsed?.ok) add("OK", "emulator-accel", parsed.message);
      else if (parsed) accelLine = { status: "HUMAN", key: "emulator-accel", message: `no usable hypervisor: ${parsed.message}. ${await accelAdvice(pr)}` };
    }
    if (!lines.some((l) => l.key === "emulator-accel") && !accelLine) {
      // No emulator yet (or it said nothing): look at the host itself.
      accelLine = await hostAccel(pr);
    }
    if (accelLine) add(accelLine.status, accelLine.key, accelLine.message);
    const gpu = resolveEmulatorGpu("auto", { platform: pr.platform, env, hasRenderNode: pr.hasRenderNode });
    add(
      "INFO",
      "emulator-gpu",
      `emu-lab start launches the emulator with -gpu ${gpu.gpu} (${gpu.why})${gpu.gpu === "swiftshader_indirect" ? "; software rendering is slower but boots without a GPU or display" : ""}. Change it with --gpu or EMU_GPU.`,
    );
  }

  // --- Unity editors and modules
  const all = pr.installs();
  const installs = all.filter((i) => !i.shadowed);
  const external = wantAndroid ? await pr.externalTools() : { jdk: null, sdk: null, ndk: null };
  const extNoted = new Set<string>();
  const externalNote = (i: UnityInstall) => {
    const bundled = androidMissing(i.root, { platform: pr.platform, bundledOnly: true });
    const withExt = androidMissing(i.root, { platform: pr.platform, external });
    const covered = bundled.filter((m) => !withExt.includes(m));
    if (!covered.length || extNoted.has(i.version) || !hasAndroidPlayer(i.root, pr.platform)) return;
    extNoted.add(i.version);
    const where: string[] = [];
    if (covered.includes("OpenJDK")) where.push(`JDK ${external.jdk}`);
    if (covered.some((c) => c.startsWith("SDK"))) where.push(`Android SDK ${external.sdk}`);
    if (covered.includes("NDK")) where.push(`NDK ${external.ndk}`);
    add(
      "WARN",
      "external-tools",
      `Unity ${i.version} lacks the bundled ${covered.join(", ")}, but Unity > Preferences > External Tools points at ${where.join("; ")}: accepted, builds use those. Build errors about them are tool-version problems, not missing Hub modules.`,
    );
  };
  const moduleGaps = (i: UnityInstall, windowsBackend: "Mono" | "IL2CPP" = "Mono"): string[] => {
    const gaps: string[] = [];
    if (wantAndroid) {
      const miss = hasAndroidPlayer(i.root, pr.platform) ? androidMissing(i.root, { platform: pr.platform, external }) : ["the module itself"];
      if (miss.length) gaps.push(`Android Build Support (missing ${miss.join(", ")})`);
      externalNote(i);
    }
    if (wantWebGL && !hasWebGL(i.root, pr.platform)) gaps.push("WebGL Build Support");
    if (wantWindows) gaps.push(...windowsMissing(i.root, { platform: pr.platform, backend: windowsBackend }));
    return gaps;
  };
  if (!installs.length) {
    add("HUMAN", "unity", "no Unity editor found. Install one with Unity Hub (or set UNITY_EDITOR_ROOT to the folder that holds the version folders).");
  } else {
    for (const i of all) {
      if (i.shadowed) {
        add("INFO", `unity ${i.version}`, `second copy at ${i.root} (${i.source}) is not used: ${i.usedRoot} comes first (UNITY_EDITOR_ROOT, Hub install location, default location, Hub Locate)`);
        continue;
      }
      const missB = androidMissing(i.root, { platform: pr.platform, bundledOnly: true });
      const miss = androidMissing(i.root, { platform: pr.platform, external });
      const android = !hasAndroidPlayer(i.root, pr.platform)
        ? "no"
        : miss.length
          ? `partial (missing ${miss.join(", ")})`
          : missB.length
            ? `yes via External Tools (bundled ${missB.join(", ")} not installed)`
            : "yes";
      const jdkDir = findPathPattern(path.join(playbackEnginesDir(i.root, pr.platform), "AndroidPlayer"), "OpenJDK", pr.platform)[0];
      const jdk = jdkDir ? jdkMajor(jdkDir) : 0;
      const winParts: string[] = [];
      if (!windowsMissing(i.root, { platform: pr.platform }).length) winParts.push("Mono");
      if (!windowsMissing(i.root, { platform: pr.platform, backend: "IL2CPP" }).some((m) => /IL2CPP/.test(m))) winParts.push("IL2CPP");
      add("INFO", `unity ${i.version}`, `Android=${android}${jdk ? ` (JDK ${jdk})` : ""} WebGL=${hasWebGL(i.root, pr.platform)} Windows=${winParts.join("+") || "no"} (${i.root})`);
    }
    if (wantAndroid && !installs.some((i) => hasAndroidPlayer(i.root, pr.platform) && androidMissing(i.root, { platform: pr.platform, external }).length === 0)) {
      add("HUMAN", "unity-android", 'no editor has complete "Android Build Support" (OpenJDK and Android SDK & NDK Tools). In Unity Hub > Installs > (version) > Add modules, check Android Build Support with both sub-modules.');
    }
  }

  // --- the person's project
  if (o.projectPath) {
    try {
      const project = path.resolve(o.projectPath);
      if (!isDir(project)) throw new EmuError("NO_PROJECT", `No project folder at ${project}`);
      if (inside(loc.labHome, project, pr.platform)) {
        add("FAIL", "lab-location", `the lab home (${loc.labHome}, EMU_LAB_HOME) is inside the project folder (${project}): build output and guard state would show up as the person's changes. Point EMU_LAB_HOME outside the project.`);
      } else if (inside(project, loc.labHome, pr.platform)) {
        add("FAIL", "lab-location", `the project (${project}) is inside the lab home (${loc.labHome}). Use the project where it normally lives.`);
      }
      const pv = readProjectVersion(project);
      if (!pv) throw new EmuError("NO_PROJECT", `Not a Unity project (no ProjectSettings/ProjectVersion.txt with m_EditorVersion): ${project}`);
      const u = installs.find((i) => i.version === pv.version);
      if (!u) {
        const hub = pv.revision ? ` (Unity Hub > Installs > Install Editor > Archive, or unityhub://${pv.version}/${pv.revision})` : "";
        throw new EmuError("NO_UNITY", `Unity ${pv.version} is not installed (project ${project})${hub}. Install it with Unity Hub, or set UNITY_EDITOR_ROOT.`);
      }
      const backend = scriptingBackend(project, "Standalone") ?? "Mono";
      add("OK", "project-unity", `${project} needs Unity ${u.version}: installed`);
      const gaps = moduleGaps(u, backend);
      if (gaps.length) add("HUMAN", "project-modules", `Unity ${u.version} lacks ${gaps.join("; ")}. Add it in Unity Hub > Installs > ${u.version} > Add modules.${onlyOneHint}`);

      if (await pr.lock.isLocked(project)) {
        const holders = await pr.lock.processes(project);
        const editors = editorPids(holders);
        const builds = buildHolders(holders);
        if (editors.length) add("WARN", "project-open", `the project is open in a Unity Editor (pid ${editors.join(", ")}): batchmode builds are blocked. Close it, or build from that Editor and test the output directly.`);
        else if (builds.length) add("WARN", "project-open", `a batchmode Unity (pid ${builds.map((b) => b.pid).join(", ")}) holds the project: a build is still running, or an interrupted run left it behind. Wait for it; if no build should be running, ask the person before stopping it.`);
        else add("WARN", "project-open", "Temp/UnityLockfile is held, but no Unity that this shell can see names the project (an elevated Unity or another user's?): batchmode builds are blocked until it closes.");
      }

      const g = await pr.gitState(project);
      if (g.inGit) {
        if (g.changed) add("WARN", "project-vcs", `git: ${g.changed} uncommitted path(s) before any build. Never revert them yourself: take the guard snapshot (emu-lab guard snapshot) before the first build, which reverts only what the build changed, with consent (AGENTS.md rule 5).`);
        else add("OK", "project-vcs", "git: clean working tree");
        add("INFO", "project-guard", g.snapshot ? "a guard snapshot is open for this project: keep it for every rebuild and run the guard report after the last build" : "no guard snapshot yet: take one before the first build (emu-lab guard snapshot / emu_guard_snapshot)");
      } else if (g.why === "no-git-on-path") {
        add("HUMAN", "project-vcs", `the project is in a git repo (${path.join(g.gitAt ?? project, ".git")}), but git is not on PATH. Ask the person to install git or add their git client's git to PATH, then rerun. Do not treat the project as non-git.`);
      } else if (g.why === "dubious") {
        add("WARN", "project-vcs", "git refused the project (dubious ownership): this shell runs as another user, usually an agent sandbox. Rerun outside the sandbox (AGENTS.md rule 11); do not treat the project as non-git.");
      } else if (existsSync(path.join(project, ".plastic"))) {
        add("WARN", "project-vcs", "Unity Version Control (Plastic SCM) workspace: no git baseline. Ask before building; with consent copy ProjectSettings and Packages to a backup folder first.");
      } else {
        add("WARN", "project-vcs", "not a git work tree (Perforce or none): no baseline. Ask before building; with consent copy ProjectSettings and Packages to a backup folder first.");
      }
      add("INFO", "project-platform", `a batchmode build for ${targetText.replace(" and ", "/")} switches the project's active platform (stored in Library, not in git). The Editor then reopens on it; switching back may reimport.`);

      if (wantWindows) {
        add("INFO", "project-windows", `Windows scripting backend: ${backend}.`);
        if (backend === "IL2CPP" && !win) {
          add("FAIL", "project-windows", "the project builds Windows with IL2CPP, which only builds on a Windows host (Visual Studio C++). Build it on Windows, or switch the backend to Mono for the test build with the person's consent.");
        } else if (backend === "IL2CPP") {
          const vc = await pr.vsCpp();
          if (vc) add("OK", "windows-il2cpp-cpp", `Visual Studio C++ tools: ${vc}`);
          else add("HUMAN", "windows-il2cpp-cpp", 'the project builds Windows with IL2CPP, which needs Visual Studio 2019 or newer (or its Build Tools) with "Desktop development with C++". Ask the person to install it with the Visual Studio Installer.');
        }
      }
      if (wantAndroid) {
        const ab = scriptingBackend(project, "Android");
        const arch = androidTargetArchitectures(project);
        const mono = ab === "Mono";
        const noArm64 = arch !== null && (arch & 2) === 0;
        if (mono || noArm64) {
          add("TODO", "project-abi", `Player Settings build ${mono ? "Mono (ARMv7 only)" : "without ARM64"}: the emulator runs only arm64-v8a/x86_64 code. With consent, build IL2CPP + ARM64 for the test (emu-lab build --emu-arm64 with the template's method) and say the tested binary differs from the release build.`);
        }
      }
    } catch (err) {
      add("FAIL", "project-unity", (err as Error).message);
    }
  }

  // --- Windows player
  if (wantWindows) {
    if (win) {
      add("INFO", "windows-desktop", "the Windows smoke test (scripts/smoke-windows.ps1, PowerShell) opens the player window on this desktop. Sound: only a muted test build (EmuProjectBuild.BuildWindows) runs unless the person allows sound.");
    } else {
      add("INFO", "windows-desktop", "this host can build the Windows player (with Windows Build Support (Mono)), but the Windows smoke test runs only on a Windows desktop (scripts/smoke-windows.ps1). Copy the build there to test it.");
    }
  }

  // --- Android SDK, emulator, AVD
  let sdkMissing = false;
  if (androidHost) {
    add("INFO", "android-paths", `SDK root ${loc.sdkRoot} (from ${loc.sdkRootSource}); AVD home ${loc.avdHome} (from ${loc.avdHomeSource}). Order: ANDROID_SDK_ROOT / ANDROID_AVD_HOME, then ${loc.configPath}, then the default${win ? " (ANDROID_HOME is ignored on Windows)" : ", ANDROID_HOME"}.`);
    add("INFO", "adb", `${loc.adb} (from ${loc.adbSource})`);
    try {
      const lease = await readLease(leasePath(loc, loc.avd));
      if (lease) {
        const st = isLeaseValid(lease) ? `leased by ${lease.owner} until ${lease.expiresAt}` : `lease of ${lease.owner} ran out at ${lease.expiresAt}; the next start takes it over`;
        add("INFO", "emulator-lease", `AVD ${loc.avd} ${st} (${leasePath(loc, loc.avd)})`);
      }
    } catch (err) {
      add("WARN", "emulator-lease", (err as Error).message);
    }
    const wantAbi = abi ?? "x86_64";
    const images = findPathPattern(loc.sdkRoot, `system-images/*/*/${wantAbi}/system.img`, pr.platform);
    const avdIni = path.join(loc.avdHome, `${loc.avd}.ini`);
    const avdConfig = path.join(loc.avdHome, `${loc.avd}.avd`, "config.ini");
    const exe = win ? ".exe" : "";
    const parts: [string, boolean][] = [
      ["platform-tools", isFile(path.join(loc.sdkRoot, "platform-tools", `adb${exe}`))],
      ["emulator", isFile(loc.emulator)],
      [`a system image for ${wantAbi}`, images.length > 0],
      [`AVD ${loc.avd}`, isFile(avdIni) && isFile(avdConfig)],
    ];
    const missing = parts.filter(([, ok]) => !ok).map(([n]) => n);
    sdkMissing = missing.some((m) => !m.startsWith("AVD "));
    if (missing.length) {
      const sdkmanager = [
        ...findPathPattern(loc.sdkRoot, `cmdline-tools/*/bin/sdkmanager${win ? ".bat" : ""}`, pr.platform),
        ...installs.flatMap((i) => findPathPattern(path.join(playbackEnginesDir(i.root, pr.platform), "AndroidPlayer"), `SDK/cmdline-tools/*/bin/sdkmanager${win ? ".bat" : ""}`, pr.platform)),
      ][0];
      const image = `system-images;android-35;google_apis;${wantAbi}`;
      const how = win
        ? `In a clone of the lab repository: scripts\\setup-android-sdk.ps1 -AcceptLicenses (downloads about 1.5 GB). Or with sdkmanager: platform-tools emulator "${image}", then avdmanager create avd -n ${loc.avd} -k "${image}".`
        : `With sdkmanager${sdkmanager ? ` (${sdkmanager})` : ""}: sdkmanager --sdk_root=${loc.sdkRoot} platform-tools emulator "${image}", then avdmanager create avd -n ${loc.avd} -k "${image}" (ANDROID_AVD_HOME=${loc.avdHome}); or Android Studio's SDK and Device Manager.`;
      add(
        sdkmanager || win ? "TODO" : "HUMAN",
        "android-sdk",
        `missing under ${loc.sdkRoot} / ${loc.avdHome}: ${missing.join(", ")}. Only after the person agrees to the Android SDK license (about 1.5 GB download, 4.5 GB on disk plus up to 10 GB for the AVD): ${how}${sdkmanager || win ? "" : " No sdkmanager found: the person installs Android Studio or the command-line tools first."}`,
      );
    } else {
      add("OK", "android-sdk", `${loc.sdkRoot} (platform-tools, emulator, ${wantAbi} image), AVD ${loc.avd} in ${loc.avdHome}`);
    }
    if (isFile(avdConfig)) {
      const cfg = readFileSync(avdConfig, "utf8");
      const avdAbi = /^abi\.type\s*=\s*(\S+)/m.exec(cfg)?.[1];
      if (avdAbi && abi && avdAbi !== abi) {
        add("WARN", "avd-abi", `AVD ${loc.avd} uses a ${avdAbi} system image, but this ${pr.arch} host runs only ${abi} images accelerated. Ask the person before recreating the AVD with a ${abi} image.`);
      }
    }
    if (/[^\x20-\x7E]/.test(loc.sdkRoot + loc.avdHome)) {
      add("WARN", "android-path-chars", `the SDK root or AVD home has non-ASCII characters (${loc.sdkRoot}, ${loc.avdHome}); some Android tools fail on such paths. If the emulator fails, ask the person for an ASCII folder.`);
    }
    if (win) {
      for (const [name, p] of [["SDK", loc.sdkRoot], ["AVD home", loc.avdHome]] as const) {
        if ((env.LOCALAPPDATA && inside(p, env.LOCALAPPDATA, pr.platform)) || (env.APPDATA && inside(p, env.APPDATA, pr.platform))) {
          add("WARN", "android-sdk-path", `the ${name} is under AppData (${p}); inside a packaged AI app that location is redirected. Prefer %USERPROFILE%\\Android\\Sdk and %USERPROFILE%\\.android\\avd.`);
        }
      }
    }
  }

  // --- disk space, per volume
  const needs: { p: string; gb: number; what: string }[] = [];
  if (androidHost) {
    if (sdkMissing) needs.push({ p: loc.sdkRoot, gb: 5, what: "Android SDK" });
    needs.push(isFile(path.join(loc.avdHome, `${loc.avd}.avd`, "config.ini")) ? { p: loc.avdHome, gb: 2, what: "AVD growth" } : { p: loc.avdHome, gb: 10, what: `AVD ${loc.avd}` });
  }
  needs.push({ p: loc.labHome, gb: 4, what: "builds, test results, browser profiles" });
  if (o.projectPath) needs.push({ p: o.projectPath, gb: 3, what: "project Library/Temp during builds" });
  const byVolume = new Map<string, { free: number | null; gb: number; what: string[]; at: string }>();
  for (const n of needs) {
    const at = existingAncestor(n.p);
    let dev = "?";
    try {
      dev = at ? String(statSync(at).dev) : "?";
    } catch {
      dev = "?";
    }
    const cur = byVolume.get(dev) ?? { free: at ? pr.freeBytes(at) : null, gb: 0, what: [], at: at ?? n.p };
    cur.gb += n.gb;
    cur.what.push(n.what);
    byVolume.set(dev, cur);
  }
  for (const v of byVolume.values()) {
    if (v.free === null) add("WARN", "disk", `cannot measure free space at ${v.at}; about ${v.gb} GB is needed there: ${v.what.join(", ")}`);
    else {
      const free = Math.round(v.free / GB);
      add(free >= v.gb ? "OK" : "FAIL", "disk", `${free} GB free on the volume of ${v.at} (about ${v.gb} GB still needed: ${v.what.join(", ")})`);
    }
  }

  // --- browser for WebGL
  if (wantWebGL) {
    const b = pr.browser();
    if (b) add("OK", "browser", `${b.path} (${b.source})`);
    else add("FAIL", "browser", "Chrome, Edge or Chromium is needed for WebGL tests (or set EMU_BROWSER to one).");
  }

  const blocking = lines.filter((l) => l.status === "HUMAN" || l.status === "FAIL").length;
  const todo = lines.filter((l) => l.status === "TODO").length;
  const verdict = blocking ? "BLOCKED" : todo ? "TODO" : "READY";
  o.report("");
  o.report(`DOCTOR ${verdict} human/fail=${blocking} todo=${todo}`);
  return { verdict, exit_code: blocking ? 1 : todo ? 2 : 0, human_fail: blocking, todo, target, lines };
}

async function accelAdvice(pr: DoctorProbes): Promise<string> {
  if (pr.platform === "linux") {
    const k = pr.kvm();
    if (!k.exists) return "KVM is missing: turn on Intel VT-x / AMD-V in BIOS/UEFI and load kvm_intel or kvm_amd (in a VM, nested virtualization must be on)";
    if (!k.access) return "this user cannot open /dev/kvm: add it to the kvm group (sudo usermod -aG kvm $USER) and log in again";
    return "/dev/kvm is there and usable; another hypervisor (VirtualBox) may hold the CPU's virtualization: close it";
  }
  if (pr.platform === "darwin") return "Hypervisor.framework is not usable: close other virtual machines; an Intel Mac needs VT-x on (Apple silicon always has it)";
  const v = await pr.winVirtualization();
  if (v?.hypervisorPresent) return 'a hypervisor (Hyper-V) already runs, so only the Windows feature "Windows Hypervisor Platform" is missing: enable it (admin) and reboot';
  if (v?.firmwareEnabled === false) return 'CPU virtualization is off in firmware: enable Intel VT-x / AMD-V (SVM) in BIOS/UEFI, then the Windows feature "Windows Hypervisor Platform" (admin), and reboot';
  return v?.firmwareEnabled ? 'CPU virtualization is already on: enable the Windows feature "Windows Hypervisor Platform" (admin) and reboot' : 'enable the Windows feature "Windows Hypervisor Platform" (admin) and reboot';
}

/** Acceleration from the host itself, before the emulator is installed. */
async function hostAccel(pr: DoctorProbes): Promise<DoctorLine> {
  const key = "emulator-accel";
  if (pr.platform === "linux") {
    const k = pr.kvm();
    if (k.exists && k.access) return { status: "INFO", key, message: "KVM: /dev/kvm is there and this user can open it; emulator -accel-check runs once the SDK is installed." };
    return { status: "HUMAN", key, message: `${await accelAdvice(pr)}.` };
  }
  if (pr.platform === "darwin") {
    const hv = await pr.macHvSupport();
    if (hv === "1") return { status: "INFO", key, message: "Hypervisor.framework is supported (kern.hv_support=1); emulator -accel-check runs once the SDK is installed." };
    if (hv === "0") return { status: "HUMAN", key, message: `kern.hv_support=0: ${await accelAdvice(pr)}.` };
    return { status: "INFO", key, message: "could not read kern.hv_support; emulator -accel-check runs once the SDK is installed." };
  }
  const v = await pr.winVirtualization();
  if (v && (v.hypervisorPresent || v.firmwareEnabled)) {
    return { status: "INFO", key, message: `CPU virtualization is on (hypervisor present: ${v.hypervisorPresent}); emulator -accel-check runs once the SDK is installed.` };
  }
  if (v) return { status: "HUMAN", key, message: 'CPU virtualization looks off: enable Intel VT-x / AMD-V in BIOS/UEFI and the Windows feature "Windows Hypervisor Platform" (admin, reboot).' };
  return { status: "INFO", key, message: "could not read the virtualization state; emulator -accel-check runs once the SDK is installed." };
}
