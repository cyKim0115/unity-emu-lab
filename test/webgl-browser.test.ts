// Finding the browser on each OS and its command line (src/webgl/browser.ts). No browser is started here.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { browserArgs, disallowedBrowserArg, findBrowser, resolveGpu } from "../src/webgl/browser.ts";

function existsIn(...files: string[]): (p: string) => boolean {
  const set = new Set(files);
  return (p) => set.has(p);
}

describe("findBrowser", () => {
  test("Windows: Chrome first, then Edge, from ProgramFiles / LOCALAPPDATA", () => {
    const env = { ProgramFiles: "C:\\PF", "ProgramFiles(x86)": "C:\\PF86", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
    const edge = "C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe";
    const chrome = "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
    assert.deepEqual(findBrowser({ env, platform: "win32", home: "C:\\Users\\me", exists: existsIn(edge) }), { path: edge, source: "default location" });
    assert.equal(findBrowser({ env, platform: "win32", home: "C:\\Users\\me", exists: existsIn(edge, chrome) })?.path, chrome);
    assert.equal(findBrowser({ env, platform: "win32", home: "C:\\Users\\me", exists: () => false }), null);
  });

  test("EMU_BROWSER, then CHROME_PATH (quotes trimmed), win over the default locations", () => {
    const def = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const mine = "/opt/my chrome/chrome";
    const env = { EMU_BROWSER: `"${mine}"`, CHROME_PATH: "/opt/other" };
    assert.deepEqual(findBrowser({ env, platform: "darwin", home: "/Users/me", exists: existsIn(def, mine, "/opt/other") }), { path: mine, source: "env EMU_BROWSER" });
    assert.deepEqual(findBrowser({ env: { CHROME_PATH: "/opt/other" }, platform: "darwin", home: "/Users/me", exists: existsIn(def, "/opt/other") }), {
      path: "/opt/other",
      source: "env CHROME_PATH",
    });
    // A variable naming a missing file is skipped.
    assert.equal(findBrowser({ env: { EMU_BROWSER: "/missing" }, platform: "darwin", home: "/Users/me", exists: existsIn(def) })?.path, def);
  });

  test("macOS: /Applications and ~/Applications bundles, Edge and Chromium too", () => {
    const edge = "/Users/me/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    assert.equal(findBrowser({ env: {}, platform: "darwin", home: "/Users/me", exists: existsIn(edge) })?.path, edge);
    const chromium = "/Applications/Chromium.app/Contents/MacOS/Chromium";
    assert.equal(findBrowser({ env: {}, platform: "darwin", home: "/Users/me", exists: existsIn(chromium) })?.path, chromium);
  });

  test("Linux: the usual names on PATH, in order", () => {
    const env = { PATH: "/usr/local/bin:/usr/bin:/snap/bin" };
    assert.deepEqual(findBrowser({ env, platform: "linux", home: "/home/me", exists: existsIn("/snap/bin/chromium", "/usr/bin/microsoft-edge") }), {
      path: "/snap/bin/chromium",
      source: "PATH",
    });
    assert.equal(findBrowser({ env, platform: "linux", home: "/home/me", exists: existsIn("/usr/bin/google-chrome-stable", "/snap/bin/chromium") })?.path, "/usr/bin/google-chrome-stable");
    assert.equal(findBrowser({ env, platform: "linux", home: "/home/me", exists: () => false }), null);
  });
});

describe("resolveGpu", () => {
  test("auto: SwiftShader only for a headless Linux run without a display", () => {
    assert.equal(resolveGpu("auto", { headless: true, platform: "linux", env: {} }), "swiftshader");
    assert.equal(resolveGpu("auto", { headless: true, platform: "linux", env: { DISPLAY: ":0" } }), "host");
    assert.equal(resolveGpu("auto", { headless: true, platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } }), "host");
    assert.equal(resolveGpu("auto", { headless: false, platform: "linux", env: {} }), "host");
    assert.equal(resolveGpu("auto", { headless: true, platform: "win32", env: {} }), "host");
    assert.equal(resolveGpu("auto", { headless: true, platform: "darwin", env: {} }), "host");
  });
  test("explicit modes are kept", () => {
    assert.equal(resolveGpu("swiftshader", { headless: false, platform: "win32", env: {} }), "swiftshader");
    assert.equal(resolveGpu("host", { headless: true, platform: "linux", env: {} }), "host");
  });
});

describe("disallowedBrowserArg", () => {
  test("the listed switches pass", () => {
    const ok = [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--ignore-gpu-blocklist",
      "--enable-unsafe-swiftshader",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--lang=ko-KR",
      "--force-device-scale-factor=1.5",
      "--enable-features=Vulkan,WebGPU",
      "--disable-features=UseSkiaRenderer",
    ];
    assert.equal(disallowedBrowserArg(ok), null);
    assert.equal(disallowedBrowserArg(undefined), null);
  });
  test("switches that run a program, change the profile, DevTools port or audio, or anything unknown are refused", () => {
    for (const bad of [
      "--renderer-cmd-prefix=calc.exe",
      "--gpu-launcher=cmd /c calc",
      "--utility-cmd-prefix=sh -c id",
      "--browser-subprocess-path=/tmp/x",
      "--user-data-dir=C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data",
      "--remote-debugging-port=9222",
      "--remote-debugging-address=0.0.0.0",
      "--load-extension=/tmp/ext",
      "--disable-web-security",
      "--autoplay-policy=no-user-gesture-required",
      "--lang=en;calc",
      "--use-gl=angle --gpu-launcher=x",
      "http://example.com",
    ]) {
      assert.equal(disallowedBrowserArg(["--no-sandbox", bad]), bad, bad);
    }
  });
});

describe("browserArgs", () => {
  test("throwaway profile, DevTools port 0, muted, window size, about:blank last", () => {
    const args = browserArgs({ profileDir: "C:\\run dir\\browser-profile", width: 1280, height: 900, headless: false, gpu: "host" });
    assert.equal(args[0], "--user-data-dir=C:\\run dir\\browser-profile", "no quotes: spawn quotes the argument");
    for (const a of ["--remote-debugging-port=0", "--mute-audio", "--no-first-run", "--window-size=1280,900"]) assert.ok(args.includes(a), a);
    assert.ok(!args.some((a) => a.startsWith("--headless")));
    assert.ok(!args.includes("--no-sandbox"));
    assert.equal(args[args.length - 1], "about:blank");
  });
  test("headless first, SwiftShader flags, --no-sandbox for root, extra switches before the URL", () => {
    const args = browserArgs({ profileDir: "/tmp/p", width: 800, height: 600, headless: true, gpu: "swiftshader", isRoot: true, extraArgs: ["--lang=en"] });
    assert.equal(args[0], "--headless=new");
    assert.ok(args.includes("--use-angle=swiftshader"));
    assert.ok(args.includes("--enable-unsafe-swiftshader"));
    assert.ok(args.includes("--no-sandbox"));
    assert.deepEqual(args.slice(-2), ["--lang=en", "about:blank"]);
  });
});
