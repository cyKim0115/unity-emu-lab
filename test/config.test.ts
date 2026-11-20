import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { androidEnv, cleanPathValue, resolveLocations } from "../src/config.ts";
import { getOwner, hostName } from "../src/owner.ts";

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "emu-lab-config-"));
}

test("win32 defaults: lab home, SDK, AVD home, adb and emulator with .exe", () => {
  const loc = resolveLocations({ env: {}, platform: "win32", home: "C:\\Profile\\me" });
  assert.equal(loc.labHome, "C:\\Profile\\me\\.emu-lab");
  assert.equal(loc.leaseDir, "C:\\Profile\\me\\.emu-lab\\leases");
  assert.equal(loc.runsDir, "C:\\Profile\\me\\.emu-lab\\runs");
  assert.equal(loc.emulatorLogDir, "C:\\Profile\\me\\.emu-lab\\emulator");
  assert.equal(loc.configPath, "C:\\Profile\\me\\.emu-lab\\config.json");
  assert.equal(loc.configError, null);
  assert.equal(loc.avd, "unity-test");
  assert.equal(loc.sdkRoot, "C:\\Profile\\me\\Android\\Sdk");
  assert.equal(loc.sdkRootSource, "default");
  assert.equal(loc.avdHome, "C:\\Profile\\me\\.android\\avd");
  assert.equal(loc.avdHomeSource, "default");
  assert.equal(loc.adb, "C:\\Profile\\me\\Android\\Sdk\\platform-tools\\adb.exe");
  assert.equal(loc.adbSource, "SDK root (default)");
  assert.equal(loc.emulator, "C:\\Profile\\me\\Android\\Sdk\\emulator\\emulator.exe");
});

test("linux and darwin defaults", () => {
  const linux = resolveLocations({ env: {}, platform: "linux", home: "/home/me" });
  assert.equal(linux.labHome, "/home/me/.emu-lab");
  assert.equal(linux.sdkRoot, "/home/me/Android/Sdk");
  assert.equal(linux.adb, "/home/me/Android/Sdk/platform-tools/adb");
  assert.equal(linux.emulator, "/home/me/Android/Sdk/emulator/emulator");
  assert.equal(linux.avdHome, "/home/me/.android/avd");
  const mac = resolveLocations({ env: {}, platform: "darwin", home: "/Users/me" });
  assert.equal(mac.sdkRoot, "/Users/me/Library/Android/sdk");
  assert.equal(mac.adb, "/Users/me/Library/Android/sdk/platform-tools/adb");
});

test("win32 ignores ANDROID_HOME; linux uses it after config.json", () => {
  const win = resolveLocations({ env: { ANDROID_HOME: "C:\\Studio\\Sdk" }, platform: "win32", home: "C:\\Profile\\me" });
  assert.equal(win.sdkRoot, "C:\\Profile\\me\\Android\\Sdk");
  assert.equal(win.sdkRootSource, "default");
  const linux = resolveLocations({ env: { ANDROID_HOME: "/opt/android" }, platform: "linux", home: "/home/me" });
  assert.equal(linux.sdkRoot, "/opt/android");
  assert.equal(linux.sdkRootSource, "env ANDROID_HOME");
  assert.equal(linux.adbSource, "SDK root (env ANDROID_HOME)");
});

test("SDK root order: ANDROID_SDK_ROOT, then config.json, then ANDROID_HOME (linux)", () => {
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ sdkRoot: "/cfg/sdk", avdHome: "/cfg/avd", adb: "/cfg/adb" }));
    const env = { EMU_LAB_HOME: dir, ANDROID_HOME: "/opt/android" };
    const fromConfig = resolveLocations({ env, platform: process.platform, home: "/home/me" });
    assert.equal(fromConfig.sdkRootSource, "config.json");
    assert.equal(fromConfig.avdHomeSource, "config.json");
    assert.equal(fromConfig.adbSource, "config.json adb");
    assert.equal(fromConfig.adb, "/cfg/adb");

    const fromEnv = resolveLocations({
      env: { ...env, ANDROID_SDK_ROOT: "/env/sdk", ANDROID_AVD_HOME: "/env/avd", EMU_ADB: "/env/adb" },
      platform: "linux",
      home: "/home/me",
    });
    assert.equal(fromEnv.sdkRoot, "/env/sdk");
    assert.equal(fromEnv.sdkRootSource, "env ANDROID_SDK_ROOT");
    assert.equal(fromEnv.avdHome, "/env/avd");
    assert.equal(fromEnv.avdHomeSource, "env ANDROID_AVD_HOME");
    assert.equal(fromEnv.adb, "/env/adb");
    assert.equal(fromEnv.adbSource, "env EMU_ADB");
    assert.equal(fromEnv.emulator, "/env/sdk/emulator/emulator");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("values are cleaned: quotes, spaces, trailing separators (a bare root stays)", () => {
  const win = resolveLocations({
    env: { EMU_LAB_HOME: ' "C:\\Lab Home\\" ', ANDROID_SDK_ROOT: '"C:\\Sdk\\\\"', ANDROID_AVD_HOME: "C:\\", EMU_AVD: " my-avd " },
    platform: "win32",
    home: "C:\\Profile\\me",
  });
  assert.equal(win.labHome, "C:\\Lab Home");
  assert.equal(win.leaseDir, "C:\\Lab Home\\leases");
  assert.equal(win.sdkRoot, "C:\\Sdk");
  assert.equal(win.avdHome, "C:\\");
  assert.equal(win.avd, "my-avd");
  assert.equal(win.adb, "C:\\Sdk\\platform-tools\\adb.exe");

  const linux = resolveLocations({ env: { ANDROID_SDK_ROOT: "/opt/sdk//", ANDROID_AVD_HOME: "/" }, platform: "linux", home: "/home/me" });
  assert.equal(linux.sdkRoot, "/opt/sdk");
  assert.equal(linux.avdHome, "/");

  assert.equal(cleanPathValue('""', "win32"), null);
  assert.equal(cleanPathValue("   ", "linux"), null);
  assert.equal(cleanPathValue(undefined, "linux"), null);
  assert.equal(cleanPathValue("C:/Sdk/", "win32"), "C:/Sdk");
  assert.equal(cleanPathValue("C:\\\\", "win32"), "C:\\");
  // An empty variable falls through to the next source.
  const empty = resolveLocations({ env: { ANDROID_SDK_ROOT: '""', EMU_ADB: " " }, platform: "linux", home: "/home/me" });
  assert.equal(empty.sdkRootSource, "default");
  assert.equal(empty.adbSource, "SDK root (default)");
});

test("config.json: invalid JSON is reported and ignored; BOM and non-string values handled", () => {
  const dir = tempDir();
  try {
    const cfg = path.join(dir, "config.json");
    writeFileSync(cfg, "{ not json");
    const bad = resolveLocations({ env: { EMU_LAB_HOME: dir }, platform: "linux", home: "/home/me" });
    assert.match(bad.configError ?? "", /config\.json is not valid JSON \(/);
    assert.equal(bad.sdkRootSource, "default");

    writeFileSync(cfg, "[1,2]");
    const arr = resolveLocations({ env: { EMU_LAB_HOME: dir }, platform: "linux", home: "/home/me" });
    assert.match(arr.configError ?? "", /is not valid JSON/);

    writeFileSync(cfg, "\uFEFF" + JSON.stringify({ sdkRoot: '"/bom/sdk/"', avdHome: 42 }));
    const bom = resolveLocations({ env: { EMU_LAB_HOME: dir }, platform: "linux", home: "/home/me" });
    assert.equal(bom.configError, null);
    assert.equal(bom.sdkRoot, "/bom/sdk");
    assert.equal(bom.sdkRootSource, "config.json");
    assert.equal(bom.avdHomeSource, "default");

    // A missing file is not an error; a directory in its place is.
    rmSync(cfg);
    assert.equal(resolveLocations({ env: { EMU_LAB_HOME: dir }, platform: "linux", home: "/h" }).configError, null);
    mkdirSync(cfg);
    assert.match(resolveLocations({ env: { EMU_LAB_HOME: dir }, platform: "linux", home: "/h" }).configError ?? "", /cannot be read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env is read per call, not cached at module load", () => {
  const a = resolveLocations({ env: { EMU_AVD: "a" }, platform: "linux", home: "/h" });
  const b = resolveLocations({ env: { EMU_AVD: "b" }, platform: "linux", home: "/h" });
  assert.equal(a.avd, "a");
  assert.equal(b.avd, "b");
});

test("androidEnv sets the three Android variables and keeps the rest", () => {
  const loc = resolveLocations({ env: { ANDROID_SDK_ROOT: "/s", ANDROID_AVD_HOME: "/a" }, platform: "linux", home: "/h" });
  const env = androidEnv(loc, { PATH: "/bin", android_home: "/old", ANDROID_SDK_ROOT: "/old2" });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.ANDROID_SDK_ROOT, "/s");
  assert.equal(env.ANDROID_HOME, "/s");
  assert.equal(env.ANDROID_AVD_HOME, "/a");
  assert.equal(env.android_home, undefined);
});

test("owner: EMU_OWNER first (trimmed, non-empty)", () => {
  assert.equal(getOwner({ EMU_OWNER: "  me  ", CLAUDE_CODE_SESSION_ID: "abcdefghijk" }, "win32"), "me");
  assert.equal(getOwner({ EMU_OWNER: "   ", CLAUDE_CODE_SESSION_ID: "abcdefghijk" }, "win32"), "claude:abcdefgh");
});

test("owner: claude first 8, codex last 8", () => {
  assert.equal(getOwner({ CLAUDE_CODE_SESSION_ID: "12345678-aaaa-bbbb", CODEX_THREAD_ID: "x" }, "linux"), "claude:12345678");
  assert.equal(getOwner({ CLAUDE_CODE_SESSION_ID: "abc" }, "linux"), "claude:abc");
  assert.equal(getOwner({ CODEX_THREAD_ID: "0199-aaaa-bbbb-ccccdddd" }, "linux"), "codex:ccccdddd");
  assert.equal(getOwner({ CODEX_THREAD_ID: "short" }, "linux"), "codex:short");
});

test("owner: Windows USERNAME@COMPUTERNAME like PS, other OS user@hostname", () => {
  assert.equal(getOwner({ USERNAME: "kim", COMPUTERNAME: "DESK-1" }, "win32"), "kim@DESK-1");
  assert.equal(getOwner({}, "win32"), "@");
  assert.equal(getOwner({}, "linux"), `${os.userInfo().username}@${os.hostname()}`);
});

test("hostName: Windows COMPUTERNAME (fallback hostname), else hostname", () => {
  assert.equal(hostName({ COMPUTERNAME: "DESK-1" }, "win32"), "DESK-1");
  assert.equal(hostName({}, "win32"), os.hostname());
  assert.equal(hostName({ COMPUTERNAME: "DESK-1" }, "linux"), os.hostname());
});
