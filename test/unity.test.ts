// Unity editors on the host (src/unity.ts), the project lock and Unity process matching (src/project-lock.ts),
// the build template (src/template.ts) and the build watchdog (src/watchdog.ts). Fake editor folders in temp
// directories; no real Unity is started.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEmuError } from "../src/errors.ts";
import {
  buildHolders,
  classifyCommandLine,
  commandLineNamesProject,
  describeHolders,
  editorPids,
  isAlive,
  isProjectLocked,
  lockfilePath,
  parsePsUnityLines,
  parseWindowsProcTable,
  parseWindowsUnityLines,
  projectPathFromArgv,
  projectPathFromCommandLine,
  treeToStop,
  UV_FS_O_EXLOCK,
  type UnityProcess,
} from "../src/project-lock.ts";
import { sleep } from "../src/proc.ts";
import { installTemplate, TEMPLATE_FILES } from "../src/template.ts";
import {
  androidMissing,
  androidTargetArchitectures,
  compareUnityVersions,
  externalToolsFromPrefs,
  findPathPattern,
  findUnityInstalls,
  hasWebGL,
  jdkMajor,
  parseLinuxPrefs,
  parsePlistXml,
  parseRegQuery,
  playbackEnginesDir,
  readProjectVersion,
  rootFromLocation,
  scriptingBackend,
  unityExeIn,
  unityForProject,
  unityMajor,
  unityVersionKey,
  windowsMissing,
} from "../src/unity.ts";
import { tempLabHome } from "./helpers/fake.ts";

const P = process.platform;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** A fake editor at <dir>/<version>: just the executable file and the given module files (relative to PlaybackEngines). */
function fakeEditor(dir: string, version: string, modules: string[] = []): string {
  const root = path.join(dir, version);
  const exe = unityExeIn(root);
  mkdirSync(path.dirname(exe), { recursive: true });
  writeFileSync(exe, "");
  for (const m of modules) {
    const f = path.join(playbackEnginesDir(root), m);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, "");
  }
  return root;
}

/** A host environment whose Unity Hub settings and default folder live under a temp home. */
function hostEnv(): { env: NodeJS.ProcessEnv; home: string; hub: string } {
  const home = tempLabHome();
  const env: NodeJS.ProcessEnv = { APPDATA: path.join(home, "AppData", "Roaming"), ProgramFiles: path.join(home, "PF"), XDG_CONFIG_HOME: path.join(home, ".config") };
  const hub = P === "win32" ? path.join(env.APPDATA!, "UnityHub") : P === "darwin" ? path.join(home, "Library", "Application Support", "UnityHub") : path.join(home, ".config", "UnityHub");
  mkdirSync(hub, { recursive: true });
  return { env, home, hub };
}

describe("Unity versions", () => {
  test("version key orders stage and patch like Get-UnityVersionKey", () => {
    assert.deepEqual(unityVersionKey("6000.6.0f1"), [6000, 6, 0, 20001]);
    assert.deepEqual(unityVersionKey("Unity 2022.3.62f2"), [2022, 3, 62, 20002]);
    assert.deepEqual(unityVersionKey("none"), [0, 0, 0, 0]);
    const sorted = ["6000.6.0p1", "6000.6.0f2", "6000.6.0b3", "6000.6.0f1", "2022.3.1f1"].sort(compareUnityVersions);
    assert.deepEqual(sorted, ["2022.3.1f1", "6000.6.0b3", "6000.6.0f1", "6000.6.0f2", "6000.6.0p1"]);
    assert.equal(unityMajor("6000.6.0f1"), 6000);
  });

  test("editor layout per OS", () => {
    assert.equal(unityExeIn("C:\\U\\6000.6.0f1", "win32"), "C:\\U\\6000.6.0f1\\Editor\\Unity.exe");
    assert.equal(unityExeIn("/Applications/Unity/Hub/Editor/6000.6.0f1", "darwin"), "/Applications/Unity/Hub/Editor/6000.6.0f1/Unity.app/Contents/MacOS/Unity");
    assert.equal(unityExeIn("/home/u/Unity/Hub/Editor/6000.6.0f1", "linux"), "/home/u/Unity/Hub/Editor/6000.6.0f1/Editor/Unity");
    assert.equal(playbackEnginesDir("/A/6000.6.0f1", "darwin"), "/A/6000.6.0f1/PlaybackEngines");
    assert.equal(playbackEnginesDir("/A/6000.6.0f1", "linux"), "/A/6000.6.0f1/Editor/Data/PlaybackEngines");
  });

  test("Hub Locate entries: the version folder from the executable", () => {
    assert.equal(rootFromLocation("C:\\Unity\\6000.1.0f1\\Editor\\Unity.exe", "win32"), "C:\\Unity\\6000.1.0f1");
    assert.equal(rootFromLocation("/Applications/Unity 6/Unity.app", "darwin"), "/Applications/Unity 6");
    assert.equal(rootFromLocation("/Applications/U/Unity.app/Contents/MacOS/Unity", "darwin"), "/Applications/U");
    assert.equal(rootFromLocation("/opt/unity/6000.1.0f1/Editor/Unity", "linux"), "/opt/unity/6000.1.0f1");
    assert.equal(rootFromLocation("/opt/unity/Unity", "linux"), null);
  });
});

describe("findUnityInstalls on this host", () => {
  test("UNITY_EDITOR_ROOT, Hub install location, default location, Hub Locate; first copy of a version wins", () => {
    const { env, home, hub } = hostEnv();
    const envRoot = path.join(home, "envroot");
    const second = path.join(home, "D", "Unity Editors");
    const def = P === "win32" ? path.join(env.ProgramFiles!, "Unity", "Hub", "Editor") : P === "darwin" ? null : path.join(home, "Unity", "Hub", "Editor");
    fakeEditor(envRoot, "6000.1.0f1");
    fakeEditor(second, "6000.1.0f1"); // shadowed by UNITY_EDITOR_ROOT
    fakeEditor(second, "2022.3.62f2");
    if (def) fakeEditor(def, "6000.6.0f1");
    const located = fakeEditor(path.join(home, "Custom"), "located-copy");
    mkdirSync(path.join(home, "Custom", "not-an-editor"));
    writeFileSync(path.join(hub, "secondaryInstallPath.json"), JSON.stringify(second));
    writeFileSync(path.join(hub, "editors-v2.json"), JSON.stringify({ schema_version: "v2", data: [{ version: "2021.3.9f1", location: [unityExeIn(located)] }] }));
    env.UNITY_EDITOR_ROOT = `"${envRoot}${path.sep}"`;

    const list = findUnityInstalls({ env, home });
    const byVersion = new Map(list.map((i) => [i.version, i]));
    assert.equal(byVersion.get("6000.1.0f1")?.source, "UNITY_EDITOR_ROOT");
    assert.equal(byVersion.get("2022.3.62f2")?.source, "Unity Hub install location");
    if (def) assert.equal(byVersion.get("6000.6.0f1")?.source, "default location");
    assert.equal(byVersion.get("2021.3.9f1")?.source, "Unity Hub Locate");
    assert.equal(byVersion.get("2021.3.9f1")?.root, located);
    assert.ok(!list.some((i) => i.shadowed));
    const all = findUnityInstalls({ env, home, includeShadowed: true });
    const shadow = all.find((i) => i.shadowed);
    assert.equal(shadow?.version, "6000.1.0f1");
    assert.equal(shadow?.source, "Unity Hub install location");
    assert.equal(shadow?.usedRoot, path.join(envRoot, "6000.1.0f1"));
  });

  test("UNITY_EDITOR_ROOT may name one version folder itself", () => {
    const { env, home } = hostEnv();
    const root = fakeEditor(path.join(home, "x"), "6000.3.6f1");
    env.UNITY_EDITOR_ROOT = root;
    const found = findUnityInstalls({ env, home }).filter((i) => i.source === "UNITY_EDITOR_ROOT");
    assert.deepEqual(found.map((i) => [i.version, i.root]), [["6000.3.6f1", root]]);
  });

  test("unityForProject: the project's version, NO_UNITY with the Hub link, NO_PROJECT", () => {
    const { env, home } = hostEnv();
    env.UNITY_EDITOR_ROOT = path.join(home, "eds");
    fakeEditor(env.UNITY_EDITOR_ROOT, "6000.6.0f1");
    const proj = path.join(home, "proj");
    mkdirSync(path.join(proj, "ProjectSettings"), { recursive: true });
    writeFileSync(path.join(proj, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.6.0f1\r\nm_EditorVersionWithRevision: 6000.6.0f1 (deadbeef)\r\n");
    const u = unityForProject(proj, { env, home });
    assert.equal(u.version, "6000.6.0f1");
    assert.equal(u.exe, unityExeIn(path.join(env.UNITY_EDITOR_ROOT, "6000.6.0f1")));
    assert.deepEqual(readProjectVersion(proj), { version: "6000.6.0f1", revision: "deadbeef" });
    writeFileSync(path.join(proj, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.9.9f9\nm_EditorVersionWithRevision: 6000.9.9f9 (cafe)\n");
    assert.throws(() => unityForProject(proj, { env, home }), (e: unknown) => isEmuError(e, "NO_UNITY") && /unityhub:\/\/6000\.9\.9f9\/cafe/.test((e as Error).message));
    assert.throws(() => unityForProject(home, { env, home }), (e: unknown) => isEmuError(e, "NO_PROJECT"));
  });
});

describe("build modules", () => {
  const exe = P === "win32" ? ".exe" : "";
  const bat = P === "win32" ? ".bat" : "";

  test("Android: the four parts; External Tools cover missing ones unless bundledOnly", () => {
    const dir = tempLabHome();
    const full = fakeEditor(dir, "6000.6.0f1", [
      `AndroidPlayer/OpenJDK/bin/java${exe}`,
      `AndroidPlayer/SDK/cmdline-tools/16.0/bin/sdkmanager${bat}`,
      `AndroidPlayer/SDK/build-tools/36.0.0/aapt2${exe}`,
      "AndroidPlayer/NDK/source.properties",
      "WebGLSupport/x",
      "WindowsStandaloneSupport/Variations/win64_player_development_mono/x",
    ]);
    assert.deepEqual(androidMissing(full), []);
    assert.ok(hasWebGL(full));
    assert.deepEqual(windowsMissing(full), []);
    assert.deepEqual(windowsMissing(full, { backend: "IL2CPP" }), ["Windows Build Support (IL2CPP)"]);
    const part = fakeEditor(dir, "2022.3.1f1", ["AndroidPlayer/NDK/source.properties"]);
    assert.deepEqual(androidMissing(part), ["OpenJDK", "SDK cmdline-tools", "SDK build-tools"]);
    const ext = { jdk: dir, sdk: dir, ndk: null };
    assert.deepEqual(androidMissing(part, { external: ext }), []);
    assert.deepEqual(androidMissing(part, { external: ext, bundledOnly: true }), ["OpenJDK", "SDK cmdline-tools", "SDK build-tools"]);
    assert.equal(hasWebGL(part), false);
    assert.deepEqual(windowsMissing(part), ["Windows Build Support (Mono)"]);
    assert.equal(findPathPattern(path.join(playbackEnginesDir(full), "AndroidPlayer"), `SDK/build-tools/*/aapt2${exe}`).length, 1);
    // Module folders in another case (seen on Windows installs: windowsstandalonesupport) still count.
    const lower = fakeEditor(dir, "6000.5.4f1", ["windowsstandalonesupport/Variations/win64_player_nondevelopment_mono/x", "webglsupport/x"]);
    assert.deepEqual(windowsMissing(lower), []);
    assert.ok(hasWebGL(lower));
  });

  test("jdkMajor reads the release file", () => {
    const d = tempLabHome();
    writeFileSync(path.join(d, "release"), 'IMPLEMENTOR="x"\nJAVA_VERSION="17.0.10"\n');
    assert.equal(jdkMajor(d), 17);
    writeFileSync(path.join(d, "release"), 'JAVA_VERSION="1.8.0_392"\n');
    assert.equal(jdkMajor(d), 8);
    assert.equal(jdkMajor(path.join(d, "none")), 0);
  });

  test("ProjectSettings: scripting backend per group, Android architectures", () => {
    const d = tempLabHome();
    mkdirSync(path.join(d, "ProjectSettings"));
    writeFileSync(
      path.join(d, "ProjectSettings", "ProjectSettings.asset"),
      "  scriptingBackend:\n    Android: 1\n    Standalone: 0\n  AndroidTargetArchitectures: 3\n",
    );
    assert.equal(scriptingBackend(d, "Android"), "IL2CPP");
    assert.equal(scriptingBackend(d, "Standalone"), "Mono");
    assert.equal(androidTargetArchitectures(d), 3);
    writeFileSync(path.join(d, "ProjectSettings", "ProjectSettings.asset"), "  scriptingBackend: {}\n");
    assert.equal(scriptingBackend(d, "Android"), "Mono");
    assert.equal(androidTargetArchitectures(d), null);
  });

  test("External Tools from EditorPrefs: registry, plist, Linux prefs", () => {
    const d = tempLabHome();
    const hex = Buffer.concat([Buffer.from(d, "utf8"), Buffer.from([0])]).toString("hex").toUpperCase();
    const reg = [
      "HKEY_CURRENT_USER\\Software\\Unity Technologies\\Unity Editor 5.x",
      "    JdkUseEmbedded_h2412516587    REG_DWORD    0x0",
      `    JdkPath_h1234    REG_BINARY    ${hex}`,
      "    SdkUseEmbedded_h99    REG_DWORD    0x1",
      `    AndroidSdkRoot_h5    REG_BINARY    ${hex}`,
      "    NdkUseEmbedded_h7    REG_DWORD    0x0",
      `    AndroidNdkRootR23B_h8    REG_BINARY    ${Buffer.from("/missing\0").toString("hex")}`,
      `    AndroidNdkRootR27C_h9    REG_BINARY    ${hex}`,
      "",
    ].join("\r\n");
    const values = parseRegQuery(reg);
    assert.equal(values.get("JdkPath"), d);
    assert.equal(values.get("JdkUseEmbedded"), 0);
    assert.deepEqual(externalToolsFromPrefs(values), { jdk: d, sdk: null, ndk: d });

    const plist = `<plist><dict><key>JdkUseEmbedded_h1</key><integer>0</integer><key>JdkPath_h2</key><string>${d}</string>` +
      `<key>SdkUseEmbedded_h3</key><false/><key>AndroidSdkRoot_h4</key><data>${b64(d + "\0")}</data></dict></plist>`;
    const pv = parsePlistXml(plist);
    assert.equal(pv.get("AndroidSdkRoot"), d);
    assert.equal(externalToolsFromPrefs(pv).sdk, d);
    assert.equal(externalToolsFromPrefs(pv).jdk, d);

    const prefs = `<unity_prefs version_major="1" version_minor="1">\n\t<pref name="JdkUseEmbedded" type="int">0</pref>\n\t<pref name="JdkPath" type="string">${b64(d)}</pref>\n</unity_prefs>`;
    assert.equal(externalToolsFromPrefs(parseLinuxPrefs(prefs)).jdk, d);
    // "Installed with Unity" missing = on: nothing external.
    assert.deepEqual(externalToolsFromPrefs(new Map([["JdkPath", d]])), { jdk: null, sdk: null, ndk: null });
  });
});

describe("Unity processes and the project lock", () => {
  test("-projectPath from Hub and import-worker command lines", () => {
    assert.equal(projectPathFromCommandLine('"C:\\Program Files\\Unity\\Editor\\Unity.exe" -projectpath C:\\Work\\Game -useHub -hubIPC'), "C:\\Work\\Game");
    assert.equal(projectPathFromCommandLine('"Unity.exe" "-batchMode" "-name" "AssetImportWorker0" "-projectPath" "C:/Work/My Game" "-logFile" "x"'), "C:/Work/My Game");
    assert.equal(projectPathFromCommandLine("Unity -projectPath=/p/q -batchmode"), "/p/q");
    assert.equal(projectPathFromCommandLine("Unity -batchmode"), null);
    assert.equal(projectPathFromArgv(["/opt/Unity/Editor/Unity", "-batchmode", "-projectPath", "/home/u/My Game"]), "/home/u/My Game");
    assert.equal(projectPathFromArgv(["Unity", "-projectpath=/x"]), "/x");
    assert.deepEqual(classifyCommandLine('"Unity.exe" "-batchMode" "-name" "AssetImportWorker1"'), { batchmode: true, worker: true });
    assert.deepEqual(classifyCommandLine("Unity -batchmode -quit -projectPath x"), { batchmode: true, worker: false });
    assert.deepEqual(classifyCommandLine("Unity -projectpath x -useHub"), { batchmode: false, worker: false });
  });

  test("command line names the project: Windows case-insensitive with either slash; macOS path with spaces from ps", () => {
    assert.ok(commandLineNamesProject('"U.exe" "-projectPath" "C:/Work/My Game/"', "c:\\work\\my game", "win32"));
    assert.ok(!commandLineNamesProject('"U.exe" -projectPath "C:\\Work\\My Game2"', "C:\\Work\\My Game", "win32"));
    const mac = "/Applications/Unity/Hub/Editor/6000.6.0f1/Unity.app/Contents/MacOS/Unity -projectpath /Users/me/My Game -useHub -hubIPC";
    assert.ok(commandLineNamesProject(mac, "/Users/me/My Game", "darwin"));
    assert.ok(commandLineNamesProject(mac, "/users/ME/my game", "darwin"), "macOS ignores case by default");
    assert.ok(!commandLineNamesProject(mac, "/Users/me/My", "darwin"));
    assert.ok(commandLineNamesProject("/x/Unity.app/Contents/MacOS/Unity -projectPath /Users/me/My Game", "/Users/me/My Game", "darwin"));
    assert.ok(!commandLineNamesProject("/opt/Editor/Unity -projectPath /home/u/game", "/home/u/Game", "linux"), "Linux keeps case");
  });

  test("parsers of the process queries", () => {
    const win = parseWindowsUnityLines(`101|7|${b64('"C:\\U\\Unity.exe" -projectpath C:\\G')}\r\n\r\nbad line\r\n`);
    assert.deepEqual(win, [{ pid: 101, ppid: 7, commandLine: '"C:\\U\\Unity.exe" -projectpath C:\\G' }]);
    const ps = parsePsUnityLines(
      [
        "  501     1 /Applications/Unity/Hub/Editor/6000.6.0f1/Unity.app/Contents/MacOS/Unity -projectpath /Users/me/Game -useHub",
        "  502   501 /Applications/Unity/Hub/Editor/6000.6.0f1/Unity.app/Contents/MacOS/Unity -batchMode -name AssetImportWorker0 -projectPath /Users/me/Game",
        "  503     1 /usr/bin/vim notes about Unity",
        "  504     1 /Applications/Unity Hub.app/Contents/MacOS/Unity Hub",
      ].join("\n"),
    );
    assert.deepEqual(ps.map((p) => p.pid), [501, 502]);
  });

  test("holders: builds vs import workers, the Editor behind workers, descriptions", () => {
    const editor: UnityProcess = { pid: 1, ppid: 0, batchmode: false, worker: false, commandLine: "" };
    const worker: UnityProcess = { pid: 2, ppid: 1, batchmode: true, worker: true, commandLine: "" };
    const build: UnityProcess = { pid: 3, ppid: 0, batchmode: true, worker: false, commandLine: "" };
    assert.deepEqual(buildHolders([editor, worker, build]).map((h) => h.pid), [3]);
    assert.deepEqual(editorPids([worker]), [1]);
    assert.deepEqual(editorPids([editor, worker]), [1]);
    assert.equal(describeHolders([editor, worker]), "Unity Editor pid 1");
    assert.equal(describeHolders([worker]), "asset import worker pid 2");
    assert.equal(describeHolders([build]), "batchmode Unity pid 3");
    assert.match(describeHolders([]), /no running Unity names this project/);
  });

  test("process tree to stop: children created after their parent, never an adb fork-server", () => {
    const t = Date.parse("2026-11-21T10:00:00Z");
    const table = parseWindowsProcTable(
      [
        `10|1|${new Date(t).toISOString()}|${b64("Unity.exe -batchmode")}`,
        `11|10|${new Date(t + 1000).toISOString()}|${b64("java gradle")}`,
        `12|11|${new Date(t + 2000).toISOString()}|${b64("aapt2")}`,
        `13|10|${new Date(t + 3000).toISOString()}|${b64("adb -L tcp:5037 fork-server server --reply-fd 600")}`,
        `14|10|${new Date(t - 5000).toISOString()}|${b64("orphan of an older pid 10")}`,
      ].join("\n"),
    );
    assert.deepEqual(treeToStop(table, 10, t), [12, 11]);
    assert.deepEqual(treeToStop(table, 10, null), []);
  });

  test("lockfile: missing = free; a lockfile nobody holds is free (stale after a crash)", async () => {
    const proj = tempLabHome();
    assert.equal(await isProjectLocked(proj), false);
    mkdirSync(path.join(proj, "Temp"));
    writeFileSync(lockfilePath(proj), "");
    assert.equal(await isProjectLocked(proj), false);
  });

  test("Windows: a lockfile held open counts as locked", { skip: P !== "win32" }, async () => {
    const proj = tempLabHome();
    mkdirSync(path.join(proj, "Temp"));
    writeFileSync(lockfilePath(proj), "");
    const fd = openSync(lockfilePath(proj), constants.O_RDWR | UV_FS_O_EXLOCK);
    try {
      assert.equal(await isProjectLocked(proj), true);
    } finally {
      closeSync(fd);
    }
    assert.equal(await isProjectLocked(proj), false);
  });
});

describe("build template", () => {
  function proj(version: string): string {
    const d = tempLabHome();
    mkdirSync(path.join(d, "ProjectSettings"));
    mkdirSync(path.join(d, "Assets"));
    writeFileSync(path.join(d, "ProjectSettings", "ProjectVersion.txt"), `m_EditorVersion: ${version}\n`);
    return d;
  }

  test("copies both files into a new Assets/EmuLab/Editor; again with the same files changes nothing", () => {
    const p = proj("6000.6.0f1");
    const lines: string[] = [];
    const r = installTemplate({ projectPath: p, report: (l) => lines.push(l) });
    assert.equal(r.added, true);
    for (const f of TEMPLATE_FILES) {
      const dst = path.join(p, "Assets", "EmuLab", "Editor", f);
      assert.ok(existsSync(dst), f);
      assert.deepEqual(readFileSync(dst), readFileSync(fileURLToPath(new URL(`../templates/${f}`, import.meta.url))));
    }
    assert.equal(lines.filter((l) => l.startsWith("TEMPLATE_ADDED")).length, 2);
    assert.equal(installTemplate({ projectPath: p, report: () => {} }).added, false);
  });

  test("refuses an existing Assets/EmuLab with other content, old Unity, and non-projects", () => {
    const p = proj("6000.6.0f1");
    mkdirSync(path.join(p, "Assets", "EmuLab"));
    writeFileSync(path.join(p, "Assets", "EmuLab", "Mine.cs"), "x");
    assert.throws(() => installTemplate({ projectPath: p, report: () => {} }), (e: unknown) => isEmuError(e, "TEMPLATE_EXISTS"));
    assert.equal(readFileSync(path.join(p, "Assets", "EmuLab", "Mine.cs"), "utf8"), "x");
    assert.throws(() => installTemplate({ projectPath: proj("2021.1.5f1"), report: () => {} }), (e: unknown) => isEmuError(e, "BAD_OPTION"));
    assert.throws(() => installTemplate({ projectPath: tempLabHome(), report: () => {} }), (e: unknown) => isEmuError(e, "NO_PROJECT"));
  });
});

describe("build watchdog", () => {
  test("stops the build when the process that started it dies, and not before", async () => {
    const dir = tempLabHome();
    const pidFile = path.join(dir, "pids.json");
    const watchdog = fileURLToPath(new URL("../src/watchdog.ts", import.meta.url));
    // The "caller": starts a long child (the build) and the watchdog, then waits to be killed.
    const callerJs = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", detached: process.platform !== "win32" });
      const w = spawn(process.execPath, [${JSON.stringify(watchdog)}, String(process.pid), String(child.pid)], { stdio: "ignore", detached: true });
      w.unref();
      fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: child.pid, watchdog: w.pid }));
      setTimeout(() => {}, 120000);
    `;
    const caller = spawn(process.execPath, ["-e", callerJs], { stdio: "ignore" });
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(100);
    const { child, watchdog: wpid } = JSON.parse(readFileSync(pidFile, "utf8")) as { child: number; watchdog: number };
    await sleep(1500);
    assert.ok(isAlive(child), "the build keeps running while its caller lives");
    caller.kill("SIGKILL");
    for (let i = 0; i < 150 && isAlive(child); i++) await sleep(100);
    assert.equal(isAlive(child), false, "the watchdog stopped the build");
    for (let i = 0; i < 50 && isAlive(wpid); i++) await sleep(100);
    assert.equal(isAlive(wpid), false, "the watchdog ended");
  });
});
