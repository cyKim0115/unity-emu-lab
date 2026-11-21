// Unity editors on this host: where Unity Hub puts them on Windows, macOS and Linux, which version a project needs,
// and which build modules an editor has. Mirrors Get-UnityInstalls / Get-UnityEditorForProject /
// Get-UnityAndroidMissing / Get-UnityWindowsMissing in scripts/common.ps1, for every host OS.
//
// Layout of one editor (the "root" is the version folder Unity Hub creates):
//   Windows  <root>\Editor\Unity.exe                         modules in <root>\Editor\Data\PlaybackEngines\
//   macOS    <root>/Unity.app/Contents/MacOS/Unity            modules in <root>/PlaybackEngines/
//   Linux    <root>/Editor/Unity                              modules in <root>/Editor/Data/PlaybackEngines/
// Search order (the first copy of a version wins, like the PowerShell scripts): UNITY_EDITOR_ROOT, Unity Hub's
// install location (Preferences > Installs, secondaryInstallPath.json), the default location, then editors added to
// Unity Hub with "Locate" (editors-v2.json).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanPathValue } from "./config.ts";
import { EmuError } from "./errors.ts";
import { runProcess } from "./proc.ts";

export type BuildTarget = "Android" | "WebGL" | "Windows";
export const BUILD_TARGETS: readonly BuildTarget[] = ["Android", "WebGL", "Windows"];

export interface UnityInstall {
  version: string;
  /** The version folder (holds Editor/ on Windows and Linux, Unity.app on macOS). */
  root: string;
  exe: string;
  /** "UNITY_EDITOR_ROOT", "Unity Hub install location", "default location" or "Unity Hub Locate" */
  source: string;
  /** A second copy of a version that an earlier place in the search order already has (only with includeShadowed). */
  shadowed: boolean;
  /** The root that is used for this version (its own root unless shadowed). */
  usedRoot: string;
}

export interface HostOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

type PathApi = typeof path.win32;

function pathApi(platform: NodeJS.Platform): PathApi {
  return platform === "win32" ? path.win32 : path.posix;
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

/** The editor executable inside a version folder. */
export function unityExeIn(root: string, platform: NodeJS.Platform = process.platform): string {
  const p = pathApi(platform);
  if (platform === "win32") return p.join(root, "Editor", "Unity.exe");
  if (platform === "darwin") return p.join(root, "Unity.app", "Contents", "MacOS", "Unity");
  return p.join(root, "Editor", "Unity");
}

/** The folder that holds the build modules (AndroidPlayer, WebGLSupport, WindowsStandaloneSupport). */
export function playbackEnginesDir(root: string, platform: NodeJS.Platform = process.platform): string {
  const p = pathApi(platform);
  if (platform === "darwin") return p.join(root, "PlaybackEngines");
  return p.join(root, "Editor", "Data", "PlaybackEngines");
}

/** Unity Hub's settings folder (secondaryInstallPath.json, editors-v2.json). */
export function hubConfigDir(o: HostOptions = {}): string | null {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const home = o.home ?? os.homedir();
  const p = pathApi(platform);
  if (platform === "win32") {
    const appData = cleanPathValue(env.APPDATA, platform);
    return appData ? p.join(appData, "UnityHub") : null;
  }
  if (platform === "darwin") return p.join(home, "Library", "Application Support", "UnityHub");
  const xdg = cleanPathValue(env.XDG_CONFIG_HOME, platform);
  return p.join(xdg ?? p.join(home, ".config"), "UnityHub");
}

/** Where Unity Hub installs editors unless the person changed it. */
export function defaultEditorDir(o: HostOptions = {}): string | null {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const home = o.home ?? os.homedir();
  const p = pathApi(platform);
  if (platform === "win32") {
    const pf = cleanPathValue(env.ProgramFiles ?? env.PROGRAMFILES, platform);
    return pf ? p.join(pf, "Unity", "Hub", "Editor") : null;
  }
  if (platform === "darwin") return "/Applications/Unity/Hub/Editor";
  return p.join(home, "Unity", "Hub", "Editor");
}

const VERSION_IN_NAME = /(\d+\.\d+\.\d+[abfpx]\d+)/;

/**
 * Sort key of a Unity version ("6000.6.0f1", also a folder name like "Unity 6000.6.0f1"): [major, minor, patch, stage].
 * Release stage then number: 6000.6.0b3 < 6000.6.0f1 < 6000.6.0f2 < 6000.6.0p1. [0, 0, 0, 0] when there is none.
 */
export function unityVersionKey(version: string): [number, number, number, number] {
  const m = /(\d+)\.(\d+)(?:\.(\d+)(?:([abfpx])(\d+))?)?/.exec(version);
  if (!m) return [0, 0, 0, 0];
  const rev = m[4] ? "abfpx".indexOf(m[4]) * 10000 + Number(m[5]) : 0;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0), rev];
}

export function compareUnityVersions(a: string, b: string): number {
  const ka = unityVersionKey(a);
  const kb = unityVersionKey(b);
  for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return 0;
}

/** 6000 for "6000.6.0f1", 2022 for "2022.3.62f1"; 0 when the name has no version. */
export function unityMajor(version: string): number {
  return unityVersionKey(version)[0];
}

function readJsonFile(file: string): unknown {
  try {
    let text = readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Version of an editor folder: from its name, else (macOS) from Unity.app's Info.plist, else the folder name. */
function versionOf(root: string, platform: NodeJS.Platform): string {
  const name = pathApi(platform).basename(root);
  const m = VERSION_IN_NAME.exec(name);
  if (m) return m[1];
  if (platform === "darwin") {
    try {
      const plist = readFileSync(path.posix.join(root, "Unity.app", "Contents", "Info.plist"), "utf8");
      const v = /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
      const mv = v ? VERSION_IN_NAME.exec(v[1]) : null;
      if (mv) return mv[1];
    } catch {
      // no Info.plist
    }
  }
  return name;
}

/**
 * The version folder of an editor Unity Hub knows by its executable (editors-v2.json "location"): Windows
 * <root>\Editor\Unity.exe, Linux <root>/Editor/Unity, macOS <root>/Unity.app or <root>/Unity.app/Contents/MacOS/Unity.
 */
export function rootFromLocation(location: string, platform: NodeJS.Platform = process.platform): string | null {
  const p = pathApi(platform);
  const loc = cleanPathValue(location, platform);
  if (!loc) return null;
  if (platform === "darwin") {
    const app = /^(.*)\/Unity\.app(?:\/Contents\/MacOS\/Unity)?$/i.exec(loc);
    return app ? app[1] || "/" : null;
  }
  const exeName = platform === "win32" ? "unity.exe" : "unity";
  if (p.basename(loc).toLowerCase() !== exeName) return null;
  const editorDir = p.dirname(loc);
  if (p.basename(editorDir).toLowerCase() !== "editor") return null;
  return p.dirname(editorDir);
}

function normKey(p: string, platform: NodeJS.Platform): string {
  const api = pathApi(platform);
  let n = api.resolve(p);
  if (n.length > api.parse(n).root.length) n = n.replace(/[\\/]+$/, "");
  // Windows and (by default) macOS file systems ignore case.
  return platform === "linux" ? n : n.toLowerCase();
}

/**
 * Installed editors in search order. One version installed twice: the first copy wins and the later one is left out,
 * unless includeShadowed (then it is listed with shadowed = true).
 */
export function findUnityInstalls(o: HostOptions & { includeShadowed?: boolean } = {}): UnityInstall[] {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const p = pathApi(platform);
  const roots: { dir: string; source: string }[] = [];
  const envRoot = cleanPathValue(env.UNITY_EDITOR_ROOT, platform);
  if (envRoot) roots.push({ dir: envRoot, source: "UNITY_EDITOR_ROOT" });
  const hub = hubConfigDir(o);
  if (hub) {
    const second = readJsonFile(p.join(hub, "secondaryInstallPath.json"));
    const dir = cleanPathValue(second, platform);
    if (dir) roots.push({ dir, source: "Unity Hub install location" });
  }
  const def = defaultEditorDir(o);
  if (def) roots.push({ dir: def, source: "default location" });

  const found: { version: string; root: string; source: string }[] = [];
  for (const r of roots) {
    if (!isDir(r.dir)) continue;
    const dirs: string[] = [];
    // UNITY_EDITOR_ROOT may also name one version folder itself.
    if (isFile(unityExeIn(r.dir, platform))) dirs.push(r.dir);
    let names: string[] = [];
    try {
      names = readdirSync(r.dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      const d = p.join(r.dir, name);
      if (isDir(d)) dirs.push(d);
    }
    for (const d of dirs) {
      if (isFile(unityExeIn(d, platform))) found.push({ version: versionOf(d, platform), root: d, source: r.source });
    }
  }
  if (hub) {
    const located = readJsonFile(p.join(hub, "editors-v2.json")) as { data?: unknown } | undefined;
    const data = Array.isArray(located?.data) ? located.data : [];
    for (const item of data) {
      const e = item as { version?: unknown; location?: unknown };
      const loc = Array.isArray(e.location) ? e.location[0] : e.location;
      if (typeof e.version !== "string" || typeof loc !== "string") continue;
      const root = rootFromLocation(loc, platform);
      if (root && isFile(unityExeIn(root, platform))) found.push({ version: e.version, root, source: "Unity Hub Locate" });
    }
  }
  // Keep the discovery order (it is the priority); never sort, or same-version copies would be picked by path order.
  const seen = new Set<string>();
  const firstOf = new Map<string, string>();
  const out: UnityInstall[] = [];
  for (const f of found) {
    const key = normKey(f.root, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    const shadowed = firstOf.has(f.version);
    if (!shadowed) firstOf.set(f.version, f.root);
    else if (!o.includeShadowed) continue;
    out.push({ version: f.version, root: f.root, exe: unityExeIn(f.root, platform), source: f.source, shadowed, usedRoot: firstOf.get(f.version) ?? f.root });
  }
  return out;
}

export interface ProjectVersion {
  version: string;
  /** Changeset from m_EditorVersionWithRevision ("6000.6.0f1 (abc123)"), or "". */
  revision: string;
}

/** The editor version a Unity project was saved with (ProjectSettings/ProjectVersion.txt); null when it is not a project. */
export function readProjectVersion(projectPath: string): ProjectVersion | null {
  let text: string;
  try {
    text = readFileSync(path.join(projectPath, "ProjectSettings", "ProjectVersion.txt"), "utf8");
  } catch {
    return null;
  }
  const v = /^m_EditorVersion:\s*(\S+)/m.exec(text);
  if (!v) return null;
  const rev = /m_EditorVersionWithRevision:\s*\S+\s*\((\w+)\)/.exec(text);
  return { version: v[1], revision: rev ? rev[1] : "" };
}

/** The installed editor for a project. Throws NO_PROJECT (not a Unity project) or NO_UNITY (its version is not installed). */
export function unityForProject(projectPath: string, o: HostOptions = {}): UnityInstall & { projectVersion: ProjectVersion } {
  const pv = readProjectVersion(projectPath);
  if (!pv) throw new EmuError("NO_PROJECT", `Not a Unity project (no ProjectSettings/ProjectVersion.txt with m_EditorVersion): ${projectPath}`);
  const install = findUnityInstalls(o).find((i) => i.version === pv.version);
  if (!install) {
    const hubLink = pv.revision ? ` (Unity Hub > Installs > Install Editor > Archive, or unityhub://${pv.version}/${pv.revision})` : "";
    throw new EmuError(
      "NO_UNITY",
      `Unity ${pv.version} is not installed (project ${projectPath})${hubLink}. Install it with Unity Hub, or set UNITY_EDITOR_ROOT ` +
        "to the folder that holds the version folders.",
    );
  }
  return { ...install, projectVersion: pv };
}

// ---------------------------------------------------------------------------------------------------
// Build modules

/** Existing paths matching base + relative segments, where a segment may hold * or ? (base is literal). */
export function findPathPattern(base: string, relative: string, platform: NodeJS.Platform = process.platform): string[] {
  const p = pathApi(platform);
  let cur = [base];
  const segs = relative.split(/[\\/]/).filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    const next: string[] = [];
    for (const d of cur) {
      if (!isDir(d)) continue;
      if (/[*?]/.test(seg)) {
        const re = new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, platform === "linux" ? "" : "i");
        let names: string[] = [];
        try {
          names = readdirSync(d);
        } catch {
          names = [];
        }
        for (const n of names) {
          const full = p.join(d, n);
          if (re.test(n) && (last || isDir(full))) next.push(full);
        }
      } else {
        // Literal segments match regardless of case too: Unity's module folders differ in case between installs
        // (WindowsStandaloneSupport vs windowsstandalonesupport), which matters on a case-sensitive Linux file system.
        let full = p.join(d, seg);
        if (!isDir(full) && !(last && isFile(full))) {
          let names: string[] = [];
          try {
            names = readdirSync(d);
          } catch {
            names = [];
          }
          const hit = names.find((n) => n.toLowerCase() === seg.toLowerCase());
          if (hit) full = p.join(d, hit);
        }
        if (isDir(full) || (last && isFile(full))) next.push(full);
      }
    }
    cur = next;
    if (!cur.length) return [];
  }
  return cur;
}

/** Folders Unity > Preferences > External Tools points at instead of the bundled ones (null: bundled / not set). */
export interface ExternalAndroidTools {
  jdk: string | null;
  sdk: string | null;
  ndk: string | null;
}

export const NO_EXTERNAL_TOOLS: ExternalAndroidTools = { jdk: null, sdk: null, ndk: null };

export type AndroidPart = "OpenJDK" | "SDK cmdline-tools" | "SDK build-tools" | "NDK";

/**
 * Parts of Unity Hub "Android Build Support" the lab needs that this editor lacks (empty = complete). A part that
 * External Tools points at an existing folder counts as present (the build uses that one), unless bundledOnly.
 */
export function androidMissing(
  root: string,
  o: { platform?: NodeJS.Platform; bundledOnly?: boolean; external?: ExternalAndroidTools } = {},
): AndroidPart[] {
  const platform = o.platform ?? process.platform;
  const ap = findPathPattern(playbackEnginesDir(root, platform), "AndroidPlayer", platform)[0] ?? pathApi(platform).join(playbackEnginesDir(root, platform), "AndroidPlayer");
  const win = platform === "win32";
  const need: [AndroidPart, string][] = [
    ["OpenJDK", win ? "OpenJDK/bin/java.exe" : "OpenJDK/bin/java"],
    ["SDK cmdline-tools", win ? "SDK/cmdline-tools/*/bin/sdkmanager.bat" : "SDK/cmdline-tools/*/bin/sdkmanager"],
    ["SDK build-tools", win ? "SDK/build-tools/*/aapt2.exe" : "SDK/build-tools/*/aapt2"],
    ["NDK", "NDK/source.properties"],
  ];
  const miss = need.filter(([, rel]) => findPathPattern(ap, rel, platform).length === 0).map(([name]) => name);
  if (o.bundledOnly || !miss.length || !isDir(ap) || !o.external) return miss;
  const ext = o.external;
  const cover: Record<AndroidPart, string | null> = { OpenJDK: ext.jdk, "SDK cmdline-tools": ext.sdk, "SDK build-tools": ext.sdk, NDK: ext.ndk };
  return miss.filter((m) => !cover[m]);
}

export function hasAndroidPlayer(root: string, platform: NodeJS.Platform = process.platform): boolean {
  return findPathPattern(playbackEnginesDir(root, platform), "AndroidPlayer", platform).some(isDir);
}

export function hasWebGL(root: string, platform: NodeJS.Platform = process.platform): boolean {
  return findPathPattern(playbackEnginesDir(root, platform), "WebGLSupport", platform).some(isDir);
}

/**
 * Unity Hub modules a 64-bit Windows player build needs that this editor lacks (empty = complete). The Windows editor
 * comes with the Mono player; on macOS and Linux "Windows Build Support (Mono)" is a module of its own. IL2CPP is a
 * separate module, and building it needs a Windows host with Visual Studio C++ (IL2CPP does not cross-compile).
 */
export function windowsMissing(root: string, o: { platform?: NodeJS.Platform; backend?: "Mono" | "IL2CPP" } = {}): string[] {
  const platform = o.platform ?? process.platform;
  const v = pathApi(platform).join(playbackEnginesDir(root, platform), "WindowsStandaloneSupport", "Variations");
  const miss: string[] = [];
  if (!findPathPattern(v, "win64_*_mono", platform).length) miss.push("Windows Build Support (Mono)");
  if (o.backend === "IL2CPP" && !findPathPattern(v, "win64_*_il2cpp", platform).length) miss.push("Windows Build Support (IL2CPP)");
  return miss;
}

/** Major version of a JDK folder from its `release` file (JAVA_VERSION); 0 when unknown. */
export function jdkMajor(javaHome: string): number {
  let text: string;
  try {
    text = readFileSync(path.join(javaHome, "release"), "utf8");
  } catch {
    return 0;
  }
  const m = /^JAVA_VERSION="?([0-9][0-9._]*)/m.exec(text);
  if (!m) return 0;
  const parts = m[1].split(/[._]/);
  if (parts[0] === "1" && parts.length > 1) return Number(parts[1]); // 1.8.0_x -> 8
  return Number(parts[0]) || 0;
}

/** ProjectSettings.asset scripting backend for one platform group ("Android", "Standalone"): "IL2CPP" or "Mono". */
export function scriptingBackend(projectPath: string, group: "Android" | "Standalone"): "IL2CPP" | "Mono" | null {
  let text: string;
  try {
    text = readFileSync(path.join(projectPath, "ProjectSettings", "ProjectSettings.asset"), "utf8");
  } catch {
    return null;
  }
  const m = new RegExp(`scriptingBackend:\\s*\\r?\\n(?:\\s+\\w+:\\s*\\d+\\r?\\n)*?\\s+${group}:\\s*(\\d+)`).exec(text);
  // A project that never changed it has no entry for the group: Mono.
  return m && m[1] === "1" ? "IL2CPP" : "Mono";
}

/** AndroidTargetArchitectures bit mask (1 = ARMv7, 2 = ARM64, 4 = x86, 8 = x86_64) or null when absent. */
export function androidTargetArchitectures(projectPath: string): number | null {
  try {
    const text = readFileSync(path.join(projectPath, "ProjectSettings", "ProjectSettings.asset"), "utf8");
    const m = /AndroidTargetArchitectures:\s*(\d+)/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// Unity > Preferences > External Tools (EditorPrefs, shared by every editor version)

/** EditorPrefs names (without the _h<hash> suffix) -> value, from whatever store the host uses. */
export type PrefValues = Map<string, string | number>;

const PREF_NAME = /^(JdkUseEmbedded|SdkUseEmbedded|NdkUseEmbedded|JdkPath|AndroidSdkRoot|AndroidNdkRoot[A-Za-z0-9]*)(?:_h\d+)?$/;

/**
 * External Tools from EditorPrefs values. A part counts as external when "Installed with Unity" is off
 * (JdkUseEmbedded / SdkUseEmbedded / NdkUseEmbedded = 0; missing means on) and its path is an existing folder.
 */
export function externalToolsFromPrefs(values: PrefValues, platform: NodeJS.Platform = process.platform): ExternalAndroidTools {
  const useEmbedded = (n: string): boolean => {
    const v = values.get(n);
    if (v === undefined) return true;
    const num = Number(v);
    return Number.isNaN(num) ? true : num !== 0;
  };
  const dirOf = (v: unknown): string | null => {
    const d = cleanPathValue(v, platform);
    return d && isDir(d) ? d : null;
  };
  const r: ExternalAndroidTools = { jdk: null, sdk: null, ndk: null };
  if (!useEmbedded("JdkUseEmbedded")) r.jdk = dirOf(values.get("JdkPath"));
  if (!useEmbedded("SdkUseEmbedded")) r.sdk = dirOf(values.get("AndroidSdkRoot"));
  if (!useEmbedded("NdkUseEmbedded")) {
    // The NDK path is stored per required NDK release (AndroidNdkRootR23B, AndroidNdkRootR27C, ...): the newest that exists.
    const names = [...values.keys()].filter((k) => k.startsWith("AndroidNdkRoot")).sort().reverse();
    for (const n of names) {
      const d = dirOf(values.get(n));
      if (d) {
        r.ndk = d;
        break;
      }
    }
  }
  return r;
}

function addPref(values: PrefValues, rawName: string, value: string | number): void {
  const m = PREF_NAME.exec(rawName);
  if (m) values.set(m[1], value);
}

/** `reg query "HKCU\Software\Unity Technologies\Unity Editor 5.x"` output: strings are REG_BINARY UTF-8 ending in NUL. */
export function parseRegQuery(text: string): PrefValues {
  const values: PrefValues = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+(REG_BINARY|REG_DWORD|REG_SZ|REG_QWORD)\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, name, type, raw] = m;
    if (type === "REG_BINARY") {
      const hex = raw.trim();
      if (!/^[0-9A-Fa-f]*$/.test(hex)) continue;
      addPref(values, name, Buffer.from(hex, "hex").toString("utf8").replace(/\0+$/, ""));
    } else if (type === "REG_DWORD" || type === "REG_QWORD") {
      addPref(values, name, Number(raw.trim()));
    } else {
      addPref(values, name, raw.trim());
    }
  }
  return values;
}

/** macOS EditorPrefs plist converted to XML (plutil -convert xml1). Data values are UTF-8 strings ending in NUL. */
export function parsePlistXml(text: string): PrefValues {
  const values: PrefValues = new Map();
  const re = /<key>([^<]+)<\/key>\s*(?:<(string|integer|real|data)>([\s\S]*?)<\/\2>|<(true|false)\s*\/>)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const name = m[1];
    if (m[4]) addPref(values, name, m[4] === "true" ? 1 : 0);
    else if (m[2] === "integer" || m[2] === "real") addPref(values, name, Number(m[3]));
    else if (m[2] === "data") addPref(values, name, Buffer.from(m[3].replace(/\s+/g, ""), "base64").toString("utf8").replace(/\0+$/, ""));
    else addPref(values, name, decodeXml(m[3]));
  }
  return values;
}

/** Linux EditorPrefs (~/.local/share/unity3d/prefs): <pref name="..." type="string|int">value</pref>, strings base64. */
export function parseLinuxPrefs(text: string): PrefValues {
  const values: PrefValues = new Map();
  const re = /<pref\s+name="([^"]+)"\s+type="(\w+)"\s*>([\s\S]*?)<\/pref>/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const [, name, type, raw] = m;
    if (type === "int" || type === "float") {
      addPref(values, name, Number(raw.trim()));
      continue;
    }
    const v = decodeXml(raw.trim());
    // Unity writes strings base64-encoded here; take the decoded text when it is clean UTF-8.
    let decoded = v;
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(v) && v.length % 4 === 0) {
      const d = Buffer.from(v, "base64").toString("utf8").replace(/\0+$/, "");
      if (d && !d.includes("�") && /^[\x20-\x7E -￿]+$/.test(d)) decoded = d;
    }
    addPref(values, name, decoded);
  }
  return values;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Read External Tools for Android on this host (best effort: NO_EXTERNAL_TOOLS when the store cannot be read). */
export async function readExternalAndroidTools(o: HostOptions = {}): Promise<ExternalAndroidTools> {
  const platform = o.platform ?? process.platform;
  const home = o.home ?? os.homedir();
  try {
    if (platform === "win32") {
      const r = await runProcess("reg", ["query", "HKCU\\Software\\Unity Technologies\\Unity Editor 5.x"], { timeoutMs: 15_000 });
      return r.code === 0 ? externalToolsFromPrefs(parseRegQuery(r.stdout), platform) : NO_EXTERNAL_TOOLS;
    }
    if (platform === "darwin") {
      const file = path.posix.join(home, "Library", "Preferences", "com.unity3d.UnityEditor5.x.plist");
      if (!existsSync(file)) return NO_EXTERNAL_TOOLS;
      const r = await runProcess("plutil", ["-convert", "xml1", "-o", "-", file], { timeoutMs: 15_000 });
      return r.code === 0 ? externalToolsFromPrefs(parsePlistXml(r.stdout), platform) : NO_EXTERNAL_TOOLS;
    }
    const file = path.posix.join(home, ".local", "share", "unity3d", "prefs");
    return externalToolsFromPrefs(parseLinuxPrefs(readFileSync(file, "utf8")), platform);
  } catch {
    return NO_EXTERNAL_TOOLS;
  }
}
