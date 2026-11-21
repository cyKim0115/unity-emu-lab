// Find and launch a Chromium-based browser (Chrome, Edge, Chromium) for the WebGL smoke test, on Windows, macOS and
// Linux. Behavioural reference: Find-Browser in scripts/cdp.ps1 and the browser start in scripts/smoke-webgl.ps1.
// The browser always gets its own throwaway profile (never the person's), audio muted, and DevTools on a port it
// picks itself (--remote-debugging-port=0, read back from <profile>/DevToolsActivePort).

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, closeSync, openSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sleep } from "../proc.ts";

export interface BrowserLocation {
  path: string;
  /** "env EMU_BROWSER", "env CHROME_PATH", "option", "default location" or "PATH". */
  source: string;
}

export type GpuMode = "auto" | "host" | "swiftshader";

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Default install locations, in the order they are tried. Linux names are looked up on PATH. */
export function browserCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): { paths: string[]; pathNames: string[] } {
  if (platform === "win32") {
    const pf = env.ProgramFiles || "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local");
    const j = path.win32.join;
    return {
      paths: [
        j(pf, "Google", "Chrome", "Application", "chrome.exe"),
        j(pf86, "Google", "Chrome", "Application", "chrome.exe"),
        j(local, "Google", "Chrome", "Application", "chrome.exe"),
        j(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
        j(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
        j(local, "Microsoft", "Edge", "Application", "msedge.exe"),
        j(local, "Chromium", "Application", "chrome.exe"),
      ],
      pathNames: [],
    };
  }
  if (platform === "darwin") {
    const apps = ["/Applications", path.posix.join(home, "Applications")];
    const bundles: [string, string][] = [
      ["Google Chrome.app", "Google Chrome"],
      ["Microsoft Edge.app", "Microsoft Edge"],
      ["Chromium.app", "Chromium"],
    ];
    const paths: string[] = [];
    for (const [app, exe] of bundles) for (const dir of apps) paths.push(path.posix.join(dir, app, "Contents", "MacOS", exe));
    return { paths, pathNames: ["google-chrome", "chromium"] };
  }
  return {
    paths: [],
    pathNames: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"],
  };
}

/**
 * The browser to use: EMU_BROWSER, CHROME_PATH, then the default locations, then PATH. null when none is found.
 * `exists` is injectable for tests.
 */
export function findBrowser(
  o: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string; exists?: (p: string) => boolean } = {},
): BrowserLocation | null {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const home = o.home ?? os.homedir();
  const exists = o.exists ?? isFile;
  for (const key of ["EMU_BROWSER", "CHROME_PATH"]) {
    const v = (env[key] ?? "").trim().replace(/^"(.*)"$/, "$1");
    if (v && exists(v)) return { path: v, source: `env ${key}` };
  }
  const c = browserCandidates(platform, env, home);
  for (const p of c.paths) if (exists(p)) return { path: p, source: "default location" };
  const p = platform === "win32" ? path.win32 : path.posix;
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  for (const name of c.pathNames) {
    for (const dir of dirs) {
      const full = p.join(dir, name);
      if (exists(full)) return { path: full, source: "PATH" };
    }
  }
  return null;
}

/** GPU flags actually used: "auto" picks SwiftShader for a headless run on a Linux host without a display. */
export function resolveGpu(mode: GpuMode, o: { headless: boolean; platform: NodeJS.Platform; env: NodeJS.ProcessEnv }): "host" | "swiftshader" {
  if (mode === "host" || mode === "swiftshader") return mode;
  const noDisplay = !o.env.DISPLAY && !o.env.WAYLAND_DISPLAY;
  return o.headless && o.platform === "linux" && noDisplay ? "swiftshader" : "host";
}

export interface BrowserArgsOptions {
  profileDir: string;
  width: number;
  height: number;
  headless: boolean;
  gpu: "host" | "swiftshader";
  /** A root user cannot use Chrome's sandbox (containers): add --no-sandbox. */
  isRoot?: boolean;
  extraArgs?: string[];
}

/** Command line of the browser (the URL is about:blank; the page is opened over DevTools). */
export function browserArgs(o: BrowserArgsOptions): string[] {
  const args = [
    `--user-data-dir=${o.profileDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-sync",
    "--disable-extensions",
    `--window-size=${o.width},${o.height}`,
  ];
  if (o.headless) args.unshift("--headless=new");
  // Chrome no longer falls back to SwiftShader for WebGL on its own: without a GPU the page gets no WebGL context.
  if (o.gpu === "swiftshader") args.push("--use-angle=swiftshader", "--enable-unsafe-swiftshader");
  if (o.isRoot) args.push("--no-sandbox");
  args.push(...(o.extraArgs ?? []), "about:blank");
  return args;
}

export interface LaunchedBrowser {
  pid: number;
  /** ws://127.0.0.1:<port>/devtools/browser/<id> */
  browserWsUrl: string;
  /** http://127.0.0.1:<port> */
  httpBase: string;
  exited(): boolean;
  /** Wait up to ms for the process to exit; true when it did. */
  waitExit(ms: number): Promise<boolean>;
  kill(): void;
}

// Browsers started by this process and not stopped yet: a shutdown (MCP server or CLI signal) kills them.
const live = new Set<ChildProcess>();

/** Kill every browser this process started and has not stopped (shutdown path). Returns how many. */
export function killLiveBrowsers(): number {
  let n = 0;
  for (const child of live) {
    try {
      child.kill("SIGKILL");
      n++;
    } catch {
      // gone
    }
  }
  live.clear();
  return n;
}

/** Start the browser and wait until it reports its DevTools port. Throws when it exits or never reports one. */
export async function launchBrowser(exe: string, args: string[], o: { profileDir: string; logFile: string; timeoutMs?: number }): Promise<LaunchedBrowser> {
  const fd = openSync(o.logFile, "w");
  let child: ChildProcess;
  try {
    // Not hidden: a hidden (SW_HIDE) first window can stop a headful browser from painting.
    child = spawn(exe, args, { stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
  let exitCode: number | null = null;
  let gone = false;
  const exitWaiters: (() => void)[] = [];
  child.once("error", () => {
    gone = true;
    for (const w of exitWaiters.splice(0)) w();
  });
  child.once("exit", (code) => {
    gone = true;
    exitCode = code;
    live.delete(child);
    for (const w of exitWaiters.splice(0)) w();
  });
  if (child.pid === undefined) throw new Error(`Cannot start the browser ${exe}`);
  live.add(child);
  const handle: LaunchedBrowser = {
    pid: child.pid,
    browserWsUrl: "",
    httpBase: "",
    exited: () => gone,
    waitExit: (ms) =>
      gone
        ? Promise.resolve(true)
        : new Promise<boolean>((resolve) => {
            const t = setTimeout(() => resolve(gone), ms);
            exitWaiters.push(() => {
              clearTimeout(t);
              resolve(true);
            });
          }),
    kill: () => {
      live.delete(child);
      if (!gone) {
        try {
          child.kill("SIGKILL");
        } catch {
          // gone
        }
      }
    },
  };
  const portFile = path.join(o.profileDir, "DevToolsActivePort");
  const deadline = Date.now() + (o.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (gone) throw new Error(`The browser exited at start (exit code ${exitCode ?? "?"}); see ${o.logFile}`);
    if (existsSync(portFile)) {
      const lines = (await readFile(portFile, "utf8").catch(() => "")).split(/\r?\n/);
      const port = Number(lines[0]);
      if (Number.isInteger(port) && port > 0 && lines[1]) {
        handle.httpBase = `http://127.0.0.1:${port}`;
        handle.browserWsUrl = `ws://127.0.0.1:${port}${lines[1].trim()}`;
        return handle;
      }
    }
    await sleep(100);
  }
  handle.kill();
  throw new Error(`The browser did not open DevTools within ${Math.round((o.timeoutMs ?? 30_000) / 1000)} s; see ${o.logFile}`);
}
