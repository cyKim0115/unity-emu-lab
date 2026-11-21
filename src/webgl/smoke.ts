// Self-test a Unity WebGL build in a real browser, driven over the Chrome DevTools Protocol: serve the build on
// localhost -> open it in Chrome/Edge/Chromium (throwaway profile, muted) -> wait until it is ready -> click a point
// on the canvas -> collect console errors, screenshots and a summary. Works on Windows, macOS and Linux.
// Behavioural reference: scripts/smoke-webgl.ps1 (summary.json has the same keys, plus a few new ones below).
//
// Results go to a run directory (<labHome>/runs/<stamp>-webgl-<pid>, or outDir): console.txt, server.log,
// browser.log, 01-ready.png, 02-after-tap.png, 03-final.png and summary.json. Option errors, a missing index.html and
// a missing browser throw before the run directory exists; everything after that ends up in summary.error and the
// function resolves with pass false.
//
// Fatal (the run fails): a renderer crash, an uncaught page exception, a JavaScript dialog (Unity's loader reports
// fatal errors with alert()), the Unity error banner, a 4xx/5xx for a /Build/ file, wasm/loader/WebGL-context
// errors, the page's own error UI (failExpression). Other console errors are counted but do not fail the run unless
// failOnConsoleError. ignoreErrors (a regex) drops matching errors and exceptions first (third-party scripts).
// New over the PowerShell script: tapInput touch, failOnConsoleError, ignoreErrors, the canvas_blank check
// (failOnBlank), gpu (SwiftShader for hosts without a GPU), browserArgs, and the browser/WebGL/isolation facts.

import { appendFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveLocations } from "../config.ts";
import { EmuError } from "../errors.ts";
import { sleep } from "../proc.ts";
import { newRunDir } from "../rundir.ts";
import type { Report } from "../types.ts";
import { browserArgs, findBrowser, launchBrowser, resolveGpu, type GpuMode, type LaunchedBrowser } from "./browser.ts";
import { CdpClient, clickAt, evaluate, findPageTarget, type CdpMessage } from "./cdp.ts";
import { decodePng, dominantColorRatio } from "./png.ts";
import { startStaticServer, type StaticServer } from "./serve.ts";

export type ReadyMode = "marker" | "loaded" | "expression";

export const WEBGL_DEFAULTS = {
  readyMode: "marker" as ReadyMode,
  readyMarker: "SMOKE_APP_READY",
  readyTimeoutSec: 180,
  tapX: 0.5,
  tapY: 0.5,
  tapMarker: "SMOKE_TAP count=1",
  tapTimeoutSec: 5,
  tapRetrySec: 0,
  afterTapTimeoutSec: 120,
  settleSec: 2,
  width: 1280,
  height: 900,
  /** canvas_blank when this share of the canvas or more is one colour. */
  blankRatio: 0.995,
} as const;

/** Console/log errors that mean the content did not run (case-insensitive, like PowerShell -match). */
export const FATAL_REGEX = new RegExp(
  [
    "abort\\(",
    "RuntimeError",
    "Unable to parse",
    "Failed to download",
    "out of memory",
    "An error occurred running the Unity content",
    "Uncaught",
    "failed to asynchronously prepare wasm",
    "both async and sync fetching",
    "status of [45]\\d\\d[^\\n]*/Build/",
    "WebGL context",
    "WebGL is not supported",
    "^DIALOG ",
    "^BANNER ",
    "^PAGE_ERROR ",
  ].join("|"),
  "i",
);

/** A C# exception as Unity's WebGL player logs it ("NullReferenceException: ..."). */
const MANAGED_EXCEPTION = /\b[A-Z]\w*Exception\b[:\s]/;

export interface WebglSmokeOptions {
  /** The WebGL build folder (holds index.html). */
  buildDir: string;
  readyMode?: ReadyMode | "Marker" | "Loaded" | "Expression";
  readyMarker?: string;
  readyExpression?: string;
  readyTimeoutSec?: number;
  /** Fraction of the canvas. */
  tapX?: number;
  tapY?: number;
  tapMarker?: string;
  /** Instead of tapMarker: JavaScript that is truthy once the tap took effect. */
  tapExpression?: string;
  tapTimeoutSec?: number;
  /** > 0 with tapExpression: tap again every N s until accepted (within tapTimeoutSec). */
  tapRetrySec?: number;
  /** Awaited after an accepted tap (no more taps). */
  afterTapExpression?: string;
  afterTapTimeoutSec?: number;
  /** Final wait (errors still collected) before 03-final.png and the summary. */
  settleSec?: number;
  /** JavaScript returning a non-empty string when the page shows its own error UI. */
  failExpression?: string;
  /** JavaScript whose value is recorded as page_info. */
  infoExpression?: string;
  noTap?: boolean;
  noTapCheck?: boolean;
  /** "mouse" (default) or "touch" (touch emulation on, Input.dispatchTouchEvent). */
  tapInput?: "mouse" | "touch";
  /** Viewport in CSS px. */
  width?: number;
  height?: number;
  headless?: boolean;
  /** Browser executable; default EMU_BROWSER, CHROME_PATH, then the usual install locations. */
  browser?: string;
  /** More browser command-line switches (e.g. --no-sandbox). */
  browserArgs?: string[];
  /** "auto" (default): SwiftShader for a headless run on a Linux host without a display, else the host GPU. */
  gpu?: GpuMode;
  /** Serve without COOP/COEP (templates that load cross-origin files without CORP/CORS). */
  noIsolation?: boolean;
  /** Keep <run>/browser-profile (HTTP and Unity caches, tens of MB). */
  keepProfile?: boolean;
  /** Every console error fails the run (not only the fatal ones). */
  failOnConsoleError?: boolean;
  /** Regex (JavaScript syntax, case-insensitive): console errors and exceptions that match are ignored. */
  ignoreErrors?: string;
  /** Fail when the canvas in the final screenshot is a single flat colour. */
  failOnBlank?: boolean;
  outDir?: string;
  env?: NodeJS.ProcessEnv;
  report: Report;
}

export interface WebglSummary {
  pass: boolean;
  run_dir: string;
  [k: string]: unknown;
}

function bad(message: string): EmuError {
  return new EmuError("BAD_OPTION", message);
}

function normalizeReadyMode(m: WebglSmokeOptions["readyMode"]): ReadyMode {
  const v = String(m ?? WEBGL_DEFAULTS.readyMode).toLowerCase();
  if (v === "marker" || v === "loaded" || v === "expression") return v;
  throw bad(`readyMode must be marker, loaded or expression (got '${m}').`);
}

function checkFraction(name: string, v: number | undefined): void {
  if (v !== undefined && !(Number.isFinite(v) && v >= 0 && v <= 1)) throw bad(`${name} must be between 0 and 1 (got ${v}).`);
}

function checkSeconds(name: string, v: number | undefined, min = 0): void {
  if (v !== undefined && !(Number.isFinite(v) && v >= min)) throw bad(`${name} must be a number >= ${min} (got ${v}).`);
}

function hhmmss(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Text of one console API call, like smoke-webgl.ps1: value, else description, else type of each argument. */
export function consoleArgsText(args: { value?: unknown; description?: string; type?: string }[] | undefined): string {
  return (args ?? [])
    .map((a) => ("value" in a ? String(a.value) : a.description !== undefined ? a.description : String(a.type)))
    .join(" ");
}

/** The probe for readyMode loaded (Unity Default template), see Wait-Loaded in smoke-webgl.ps1. */
const LOADED_PROBE =
  "(() => { const b = document.querySelector('#unity-loading-bar'); if (!b) return 'nobar'; if (b.getClientRects().length !== 0) return 'loading'; " +
  "const f = performance.getEntriesByType('resource').some(e => /\\.(wasm|data)(\\.(br|gz|unityweb))?([?#]|$)/i.test(e.name)); return f ? 'loaded' : 'idle'; })()";

const CANVAS_RECT =
  "(() => { const c = document.querySelector('#unity-canvas') || document.querySelector('canvas'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()";

const WEBGL_PROBE =
  "(() => { try { const c = document.createElement('canvas'); const gl = c.getContext('webgl2') || c.getContext('webgl'); if (!gl) return 'none'; " +
  "const e = gl.getExtension('WEBGL_debug_renderer_info'); const r = e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); " +
  "const v = (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) ? 'webgl2' : 'webgl1'; " +
  "const l = gl.getExtension('WEBGL_lose_context'); if (l) l.loseContext(); return v + ' ' + r; } catch (e) { return 'error: ' + e.message; } })()";

/**
 * Run the WebGL smoke test. Throws EmuError (BAD_OPTION, NO_BUILD, NO_BROWSER) before the run directory exists;
 * after that every failure is in the summary (pass false).
 */
export async function runWebglSmoke(o: WebglSmokeOptions): Promise<WebglSummary> {
  const env = o.env ?? process.env;
  const report = o.report;
  const readyMode = normalizeReadyMode(o.readyMode);
  const readyMarker = o.readyMarker ?? WEBGL_DEFAULTS.readyMarker;
  const readyTimeoutSec = o.readyTimeoutSec ?? WEBGL_DEFAULTS.readyTimeoutSec;
  const tapX = o.tapX ?? WEBGL_DEFAULTS.tapX;
  const tapY = o.tapY ?? WEBGL_DEFAULTS.tapY;
  const tapMarker = o.tapMarker ?? WEBGL_DEFAULTS.tapMarker;
  const tapTimeoutSec = o.tapTimeoutSec ?? WEBGL_DEFAULTS.tapTimeoutSec;
  const tapRetrySec = o.tapRetrySec ?? WEBGL_DEFAULTS.tapRetrySec;
  const afterTapTimeoutSec = o.afterTapTimeoutSec ?? WEBGL_DEFAULTS.afterTapTimeoutSec;
  const settleSec = o.settleSec ?? WEBGL_DEFAULTS.settleSec;
  const width = o.width ?? WEBGL_DEFAULTS.width;
  const height = o.height ?? WEBGL_DEFAULTS.height;
  const tapInput = o.tapInput ?? "mouse";
  const headless = !!o.headless;

  // --- options (BAD_OPTION before anything starts)
  if (!o.buildDir || !o.buildDir.trim()) throw bad("buildDir is required (the WebGL build folder with index.html).");
  if (readyMode === "expression" && !o.readyExpression) throw bad("readyMode expression needs readyExpression.");
  checkFraction("tapX", o.tapX);
  checkFraction("tapY", o.tapY);
  checkSeconds("readyTimeoutSec", o.readyTimeoutSec, 1);
  checkSeconds("tapTimeoutSec", o.tapTimeoutSec, 1);
  checkSeconds("tapRetrySec", o.tapRetrySec);
  checkSeconds("afterTapTimeoutSec", o.afterTapTimeoutSec, 1);
  checkSeconds("settleSec", o.settleSec);
  if (tapRetrySec > 0 && !o.tapExpression) throw bad("tapRetrySec needs tapExpression (how to tell the tap was accepted).");
  if (o.afterTapExpression && o.noTap) throw bad("afterTapExpression is awaited after the tap; it has no effect with noTap.");
  for (const [name, v] of [["width", width], ["height", height]] as const) {
    if (!Number.isInteger(v) || v < 100 || v > 8192) throw bad(`${name} must be a whole number of CSS px from 100 to 8192 (got ${v}).`);
  }
  if (tapInput !== "mouse" && tapInput !== "touch") throw bad(`tapInput must be mouse or touch (got '${tapInput}').`);
  const gpuMode = o.gpu ?? "auto";
  if (!["auto", "host", "swiftshader"].includes(gpuMode)) throw bad(`gpu must be auto, host or swiftshader (got '${gpuMode}').`);
  let ignore: RegExp | null = null;
  if (o.ignoreErrors) {
    try {
      ignore = new RegExp(o.ignoreErrors, "i");
    } catch (err) {
      throw bad(`ignoreErrors is not a valid regex: ${(err as Error).message}`);
    }
  }

  const buildDir = path.resolve(o.buildDir.trim());
  if (!existsSync(path.join(buildDir, "index.html"))) throw new EmuError("NO_BUILD", `No index.html in ${buildDir}.`);

  let browser: { path: string; source: string } | null;
  if (o.browser) {
    const p = path.resolve(o.browser);
    browser = existsSync(p) && statSync(p).isFile() ? { path: p, source: "option" } : null;
    if (!browser) throw new EmuError("NO_BROWSER", `Browser not found: ${p}.`);
  } else {
    browser = findBrowser({ env });
    if (!browser) {
      throw new EmuError(
        "NO_BROWSER",
        "Chrome, Edge or Chromium not found. Install one, or pass its executable (browser option, or EMU_BROWSER / CHROME_PATH).",
      );
    }
  }
  const gpu = resolveGpu(gpuMode, { headless, platform: process.platform, env });

  // --- run
  const loc = resolveLocations({ env });
  const run = await newRunDir(loc, "webgl", o.outDir);
  const consolePath = path.join(run, "console.txt");
  const serverLog = path.join(run, "server.log");
  writeFileSync(consolePath, "");
  writeFileSync(serverLog, "");
  const checks: Record<string, unknown> = { build_dir: buildDir, browser: path.basename(browser.path) };
  let consoleText = "";
  const errors: string[] = [];
  let exceptions = 0;
  let ignored = 0;
  let targetCrashed = false;
  let pageFailSeen = false;

  const writeConsole = (line: string): void => {
    consoleText += `${line}\n`;
    try {
      appendFileSync(consolePath, `${line}${os.EOL}`, "utf8");
    } catch {
      // the summary still has the counts
    }
  };
  const addError = (text: string): boolean => {
    if (ignore && ignore.test(text)) {
      ignored++;
      return false;
    }
    errors.push(text);
    return true;
  };
  const fatalErrors = (): string[] => (o.failOnConsoleError ? errors : errors.filter((e) => FATAL_REGEX.test(e)));

  let server: StaticServer | null = null;
  let launched: LaunchedBrowser | null = null;
  let cdp: CdpClient | null = null;
  const profileDir = path.join(run, "browser-profile");

  const onEvent = (m: CdpMessage): void => {
    const p = m.params ?? {};
    const t = hhmmss();
    switch (m.method) {
      case "Runtime.consoleAPICalled": {
        const text = consoleArgsText(p.args);
        writeConsole(`${t} [${p.type}] ${text}`);
        if (p.type === "error" || p.type === "assert") addError(text);
        break;
      }
      case "Runtime.exceptionThrown": {
        const d = p.exceptionDetails ?? {};
        const text = String(d.exception?.description ?? d.text ?? "exception");
        writeConsole(`${t} [exception] ${text}`);
        if (addError(`EXCEPTION ${text}`)) exceptions++;
        break;
      }
      case "Log.entryAdded": {
        const e = p.entry ?? {};
        if (e.level === "error" && !/favicon\.ico/i.test(String(e.url ?? ""))) {
          writeConsole(`${t} [log-error] ${e.text} ${e.url ?? ""}`);
          addError(`${e.text} ${e.url ?? ""}`);
        }
        break;
      }
      case "Inspector.targetCrashed":
        targetCrashed = true;
        writeConsole(`${t} [crash] renderer crashed`);
        break;
      case "Page.javascriptDialogOpening":
        writeConsole(`${t} [dialog-${p.type}] ${p.message}`);
        addError(`DIALOG ${p.type}: ${p.message}`);
        break;
    }
  };

  const evalSafe = async (expr: string): Promise<unknown> => {
    if (!cdp) return undefined;
    return evaluate(cdp, expr);
  };
  const testExpr = async (expr: string): Promise<boolean> => {
    try {
      return !!(await evalSafe(`(() => { try { return !!(${expr}); } catch (e) { return false; } })()`));
    } catch {
      return false;
    }
  };
  const testPageFail = async (): Promise<void> => {
    if (!o.failExpression || pageFailSeen) return;
    let text = "";
    try {
      text = String(
        (await evalSafe(`(() => { try { const v = (${o.failExpression}); return v ? String(v) : ''; } catch (e) { return ''; } })()`)) ?? "",
      );
    } catch {
      text = "";
    }
    if (text) {
      pageFailSeen = true;
      addError(`PAGE_ERROR ${text}`);
      writeConsole(`${hhmmss()} [page-error] ${text}`);
    }
  };
  /** True once the run cannot pass any more. A lost DevTools connection throws (the browser is gone). */
  const shouldStop = async (): Promise<boolean> => {
    if (cdp?.closed) throw new Error(cdp.closed);
    await testPageFail();
    return targetCrashed || exceptions > 0 || fatalErrors().length > 0;
  };
  const waitUntil = async (test: () => Promise<boolean> | boolean, timeoutSec: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (await test()) return true;
      if (await shouldStop()) return false;
      await sleep(500);
    }
    return test();
  };
  const waitConsole = (marker: string, timeoutSec: number) => waitUntil(() => consoleText.includes(marker), timeoutSec);
  const waitExpression = (expr: string, timeoutSec: number) => waitUntil(() => testExpr(expr), timeoutSec);
  const waitLoaded = async (timeoutSec: number): Promise<boolean> => {
    const start = Date.now();
    const deadline = start + timeoutSec * 1000;
    let sawBar = false;
    while (Date.now() < deadline) {
      if (await shouldStop()) return false;
      let state: string;
      try {
        state = String(await evalSafe(LOADED_PROBE));
      } catch {
        state = "loading";
      }
      if (state !== "nobar") sawBar = true;
      if (state === "loaded") {
        // Watch a few more seconds for start-up errors.
        await sleep(3_000);
        return !(await shouldStop());
      }
      const elapsed = (Date.now() - start) / 1000;
      if (state === "idle" && elapsed > 15) {
        throw new Error("Unity loader never fetched the build (.wasm/.data): the template may wait for a click. Use readyMode marker.");
      }
      if (state === "nobar" && !sawBar && elapsed > 10) {
        throw new Error("No #unity-loading-bar in this template; use readyMode marker with readyMarker.");
      }
      await sleep(500);
    }
    return false;
  };
  let lastShot: Buffer | null = null;
  const saveShot = async (name: string): Promise<void> => {
    // A screenshot failure must not hide the real result.
    try {
      if (!cdp) return;
      const r = await cdp.send("Page.captureScreenshot", { format: "png" });
      lastShot = Buffer.from(String(r.data ?? ""), "base64");
      await writeFile(path.join(run, name), lastShot);
    } catch (err) {
      checks[`screenshot_${name}`] = (err as Error).message;
    }
  };

  const sw = Date.now();
  const secs = () => Math.round((Date.now() - sw) / 100) / 10;
  try {
    // Local server for the build
    server = await startStaticServer({
      root: buildDir,
      isolation: !o.noIsolation,
      log: (line) => {
        try {
          appendFileSync(serverLog, `${line}${os.EOL}`, "utf8");
        } catch {
          // ignore
        }
      },
    });
    checks.server = true;
    const url = `${server.url}index.html`;
    report(`WEBGL serving ${buildDir} at ${server.url} isolation=${!o.noIsolation}`);

    // Browser with its own throwaway profile (never the user's), muted, DevTools on a port it picks
    const args = browserArgs({
      profileDir,
      width,
      height,
      headless,
      gpu,
      isRoot: typeof process.getuid === "function" && process.getuid() === 0,
      extraArgs: o.browserArgs,
    });
    launched = await launchBrowser(browser.path, args, { profileDir, logFile: path.join(run, "browser.log") });
    checks.gpu = gpu;
    report(`WEBGL browser ${browser.path} (${browser.source})${headless ? " headless" : ""} gpu=${gpu}`);
    cdp = await CdpClient.connect(await findPageTarget(launched.httpBase));
    cdp.onEvent(onEvent);

    try {
      const v = await cdp.send("Browser.getVersion");
      checks.browser_version = v.product;
    } catch {
      // not essential
    }
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Inspector.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    if (tapInput === "touch") await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    // What WebGL this browser gives a page (about:blank, before the build loads).
    try {
      checks.webgl = String(await evaluate(cdp, WEBGL_PROBE, 10_000));
    } catch (err) {
      checks.webgl = `error: ${(err as Error).message}`;
    }

    const nav = await cdp.send("Page.navigate", { url });
    // The browser reports a failed load here (unsafe port, refused connection), not on the console.
    if (nav.errorText) throw new Error(`Could not open ${url}: ${nav.errorText}`);

    checks.ready_mode = readyMode === "marker" ? "Marker" : readyMode === "loaded" ? "Loaded" : "Expression";
    const ready =
      readyMode === "loaded"
        ? await waitLoaded(readyTimeoutSec)
        : readyMode === "expression"
          ? await waitExpression(o.readyExpression!, readyTimeoutSec)
          : await waitConsole(readyMarker, readyTimeoutSec);
    checks.ready = ready;
    checks.ready_sec = secs();
    await saveShot("01-ready.png");
    try {
      checks.cross_origin_isolated = !!(await evalSafe("self.crossOriginIsolated"));
    } catch {
      // not essential
    }
    if (!ready) {
      throw new Error(
        readyMode === "loaded"
          ? "Unity content did not finish loading."
          : readyMode === "expression"
            ? `Ready expression never became true: ${o.readyExpression}`
            : `Ready marker '${readyMarker}' not seen in the console.`,
      );
    }
    report(`WEBGL ready after ${checks.ready_sec} s (${checks.ready_mode})`);

    if (!o.noTap) {
      const rect = (await evalSafe(CANVAS_RECT)) as { x: number; y: number; w: number; h: number } | null;
      if (!rect) throw new Error("No canvas element found.");
      const x = Math.round((rect.x + rect.w * tapX) * 10) / 10;
      const y = Math.round((rect.y + rect.h * tapY) * 10) / 10;
      checks.tap_point = `${x},${y} in canvas ${Math.trunc(rect.w)}x${Math.trunc(rect.h)}`;
      checks.tap_input = tapInput;
      await sleep(1_000);
      if (o.tapExpression && tapRetrySec > 0 && !o.noTapCheck) {
        // Tap, give it tapRetrySec to take effect, tap again; stop once accepted or after tapTimeoutSec.
        const tapDeadline = Date.now() + tapTimeoutSec * 1000;
        let attempt = 0;
        let ok = false;
        do {
          attempt++;
          await clickAt(cdp, x, y, tapInput);
          const left = Math.max(1, Math.min(tapRetrySec, (tapDeadline - Date.now()) / 1000));
          ok = await waitExpression(o.tapExpression, left);
        } while (!ok && Date.now() < tapDeadline && !(await shouldStop()));
        checks.tap = ok;
        checks.tap_attempts = attempt;
      } else {
        for (let attempt = 1; attempt <= 3; attempt++) {
          await clickAt(cdp, x, y, tapInput);
          if (o.noTapCheck) break;
          checks.tap = o.tapExpression ? await waitExpression(o.tapExpression, tapTimeoutSec) : await waitConsole(tapMarker, tapTimeoutSec);
          checks.tap_attempts = attempt;
          if (checks.tap || (await shouldStop())) break;
        }
      }
      checks.tap_sec = secs();
      if (o.afterTapExpression && (checks.tap || o.noTapCheck)) {
        checks.after_tap = await waitExpression(o.afterTapExpression, afterTapTimeoutSec);
        checks.after_tap_sec = secs();
      }
      await sleep(500);
      await saveShot("02-after-tap.png");
    }

    // Settle, then read the Unity template's error banner (shown for load/runtime errors).
    await sleep(settleSec * 1000);
    await saveShot("03-final.png");
    await testPageFail();
    const banner = String((await evalSafe("(() => { const w = document.querySelector('#unity-warning'); return w ? w.innerText.trim() : ''; })()")) ?? "");
    if (banner) {
      checks.unity_banner = banner;
      addError(`BANNER ${banner}`);
    }
    if (o.infoExpression) {
      try {
        checks.page_info = String(
          await evalSafe(
            `(() => { try { const v = (${o.infoExpression}); return typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { return 'error: ' + e.message; } })()`,
          ),
        );
      } catch (err) {
        checks.page_info = (err as Error).message;
      }
    }
    // Is the canvas one flat colour in the final screenshot (nothing drawn, a black screen)?
    try {
      const rect = (await evalSafe(CANVAS_RECT)) as { x: number; y: number; w: number; h: number } | null;
      const img = lastShot ? decodePng(lastShot) : null;
      const ratio = img && rect ? dominantColorRatio(img, { x: rect.x, y: rect.y, width: rect.w, height: rect.h }) : null;
      if (ratio !== null) {
        checks.canvas_dominant_ratio = Math.round(ratio * 1000) / 1000;
        checks.canvas_blank = ratio >= WEBGL_DEFAULTS.blankRatio;
      }
    } catch {
      // not essential
    }
  } catch (err) {
    checks.error = (err as Error).message;
  } finally {
    if (cdp && !cdp.closed) {
      try {
        await cdp.send("Browser.close", undefined, 5_000);
      } catch {
        // killed below
      }
    }
    cdp?.close();
    if (launched) {
      if (!(await launched.waitExit(5_000))) launched.kill();
      await launched.waitExit(5_000);
    }
    if (server) await server.close();
    // The throwaway profile holds the build's HTTP and Unity caches (tens of MB per run); results do not need it.
    if (launched && !o.keepProfile) {
      await rm(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }).catch(() => {});
      if (existsSync(profileDir)) checks.profile_left = profileDir;
    }
  }

  const fatal = fatalErrors();
  checks.console_errors = errors.length;
  checks.fatal_errors = fatal.length;
  checks.exceptions = exceptions;
  checks.managed_exceptions = errors.filter((e) => MANAGED_EXCEPTION.test(e)).length;
  checks.ignored_errors = ignored;
  checks.crash = targetCrashed;
  if (fatal.length) checks.first_fatal = fatal[0].slice(0, 300);
  const blankFail = !!o.failOnBlank && checks.canvas_blank === true;
  const pass =
    checks.ready === true &&
    (!!o.noTap || !!o.noTapCheck || checks.tap === true) &&
    (!!o.noTap || !o.afterTapExpression || checks.after_tap === true) &&
    fatal.length === 0 &&
    !targetCrashed &&
    exceptions === 0 &&
    !checks.error &&
    !blankFail;
  checks.pass = pass;
  checks.run_dir = run;
  await writeFile(path.join(run, "summary.json"), JSON.stringify(checks, null, 2), "utf8");
  for (const [k, v] of Object.entries(checks)) report(`  ${k.padEnd(18)} ${v}`);
  report(`WEBGL_SMOKE ${pass ? "PASS" : "FAIL"} dir=${run}`);
  return checks as WebglSummary;
}
