// Paths and environment: where the lab keeps its files (lease, runs, emulator logs) and where the Android SDK,
// the AVD home and adb are. Mirrors Resolve-AndroidLocations / Get-CleanEnvPath in scripts/common.ps1, with the
// lab's config.json (<labHome>/config.json) in place of the repository's local.settings.json (same keys).

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Locations {
  /** EMU_LAB_HOME (quotes/trailing separators trimmed) else <home>/.emu-lab */
  labHome: string;
  /** <labHome>/leases */
  leaseDir: string;
  /** <labHome>/runs */
  runsDir: string;
  /** <labHome>/emulator */
  emulatorLogDir: string;
  /** <labHome>/config.json (keys sdkRoot, avdHome, adb: the same keys as the PS local.settings.json) */
  configPath: string;
  /** config.json exists but is not valid JSON (then it is ignored) */
  configError: string | null;
  /** EMU_AVD else "unity-test" */
  avd: string;
  sdkRoot: string;
  /** "env ANDROID_SDK_ROOT", "config.json", "env ANDROID_HOME" or "default" */
  sdkRootSource: string;
  avdHome: string;
  /** "env ANDROID_AVD_HOME", "config.json" or "default" */
  avdHomeSource: string;
  adb: string;
  /** "env EMU_ADB", "config.json adb" or "SDK root (<sdkRootSource>)" */
  adbSource: string;
  /** <sdkRoot>/emulator/emulator(.exe) */
  emulator: string;
}

export const DEFAULT_AVD = "unity-test";

type PathApi = typeof path.win32;

function pathApi(platform: NodeJS.Platform): PathApi {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * A folder from an environment variable or a settings file, cleaned like PS Get-CleanEnvPath: trimmed, no
 * surrounding double quotes (setx "C:\Sdk\" leaves one), no trailing separator except on a bare root (C:\ or /).
 * Returns null for an empty value.
 */
export function cleanPathValue(value: unknown, platform: NodeJS.Platform = process.platform): string | null {
  if (typeof value !== "string") return null;
  let v = value.trim();
  v = v.replace(/^"+/, "").replace(/"+$/, "").trim();
  if (!v) return null;
  const p = pathApi(platform);
  const root = p.parse(v).root;
  if (v.length <= root.length) return v;
  const trimmed = platform === "win32" ? v.replace(/[\\/]+$/, "") : v.replace(/\/+$/, "");
  // "C:\\\\" trims to "C:"; keep the root itself in that case.
  if (trimmed.length < root.length) return root;
  return trimmed;
}

interface ConfigFile {
  sdkRoot?: unknown;
  avdHome?: unknown;
  adb?: unknown;
}

function readConfig(configPath: string): { config: ConfigFile | null; error: string | null } {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { config: null, error: null };
    return { config: null, error: `${configPath} cannot be read (${(err as Error).message})` };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) return { config: null, error: null };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { config: null, error: `${configPath} is not valid JSON (expected an object with sdkRoot, avdHome, adb)` };
    }
    return { config: parsed as ConfigFile, error: null };
  } catch (err) {
    return { config: null, error: `${configPath} is not valid JSON (${(err as Error).message})` };
  }
}

function defaultSdkRoot(p: PathApi, platform: NodeJS.Platform, home: string): string {
  if (platform === "win32") return p.join(home, "Android", "Sdk");
  if (platform === "darwin") return p.join(home, "Library", "Android", "sdk");
  return p.join(home, "Android", "Sdk");
}

export function resolveLocations(opts?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string }): Locations {
  const env = opts?.env ?? process.env;
  const platform = opts?.platform ?? process.platform;
  const home = opts?.home ?? os.homedir();
  const p = pathApi(platform);
  const exe = platform === "win32" ? ".exe" : "";

  const labHome = cleanPathValue(env.EMU_LAB_HOME, platform) ?? p.join(home, ".emu-lab");
  const configPath = p.join(labHome, "config.json");
  const { config, error: configError } = readConfig(configPath);

  const avd = (env.EMU_AVD ?? "").trim() || DEFAULT_AVD;

  // SDK root: ANDROID_SDK_ROOT -> config sdkRoot -> (not on Windows) ANDROID_HOME -> default.
  // Windows ignores ANDROID_HOME on purpose: Android Studio often points it at %LOCALAPPDATA%\Android\Sdk, and the
  // lab must not change that SDK's emulator (README).
  let sdkRoot: string | null = cleanPathValue(env.ANDROID_SDK_ROOT, platform);
  let sdkRootSource = "env ANDROID_SDK_ROOT";
  if (!sdkRoot) {
    sdkRoot = cleanPathValue(config?.sdkRoot, platform);
    sdkRootSource = "config.json";
  }
  if (!sdkRoot && platform !== "win32") {
    sdkRoot = cleanPathValue(env.ANDROID_HOME, platform);
    sdkRootSource = "env ANDROID_HOME";
  }
  if (!sdkRoot) {
    sdkRoot = defaultSdkRoot(p, platform, home);
    sdkRootSource = "default";
  }

  // AVD home: ANDROID_AVD_HOME -> config avdHome -> <home>/.android/avd.
  let avdHome: string | null = cleanPathValue(env.ANDROID_AVD_HOME, platform);
  let avdHomeSource = "env ANDROID_AVD_HOME";
  if (!avdHome) {
    avdHome = cleanPathValue(config?.avdHome, platform);
    avdHomeSource = "config.json";
  }
  if (!avdHome) {
    avdHome = p.join(home, ".android", "avd");
    avdHomeSource = "default";
  }

  // adb: EMU_ADB -> config adb -> the SDK's platform-tools adb.
  let adb: string | null = cleanPathValue(env.EMU_ADB, platform);
  let adbSource = "env EMU_ADB";
  if (!adb) {
    adb = cleanPathValue(config?.adb, platform);
    adbSource = "config.json adb";
  }
  if (!adb) {
    adb = p.join(sdkRoot, "platform-tools", `adb${exe}`);
    adbSource = `SDK root (${sdkRootSource})`;
  }

  return {
    labHome,
    leaseDir: p.join(labHome, "leases"),
    runsDir: p.join(labHome, "runs"),
    emulatorLogDir: p.join(labHome, "emulator"),
    configPath,
    configError,
    avd,
    sdkRoot,
    sdkRootSource,
    avdHome,
    avdHomeSource,
    adb,
    adbSource,
    emulator: p.join(sdkRoot, "emulator", `emulator${exe}`),
  };
}

/** Environment for spawned emulator/adb: copies env and sets ANDROID_SDK_ROOT, ANDROID_HOME (= sdkRoot), ANDROID_AVD_HOME. */
export function androidEnv(loc: Locations, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  // Drop case variants of the keys we set (Windows environment names are case-insensitive; a plain copy is not).
  const replaced = new Set(["ANDROID_SDK_ROOT", "ANDROID_HOME", "ANDROID_AVD_HOME"]);
  for (const [k, v] of Object.entries(env)) {
    if (replaced.has(k.toUpperCase())) continue;
    out[k] = v;
  }
  out.ANDROID_SDK_ROOT = loc.sdkRoot;
  out.ANDROID_HOME = loc.sdkRoot;
  out.ANDROID_AVD_HOME = loc.avdHome;
  return out;
}
