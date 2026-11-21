// Unity batchmode build (src/build.ts) against a fake Unity (test/helpers/fake-unity.mjs): output checks, log
// verdicts, EMU_BUILD_WARN/NOTE, the lock refusal, the timeout stop. No real Unity, no real project lock.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildErrorSummary,
  buildLogPath,
  buildUnity,
  defaultBuildOut,
  logHits,
  outputStamp,
  windowsDataDir,
  type BuildDeps,
  type BuildOptions,
} from "../src/build.ts";
import { isEmuError } from "../src/errors.ts";
import { isAlive, type LockProbe, type UnityProcess } from "../src/project-lock.ts";
import { sleep } from "../src/proc.ts";
import { tempLabHome } from "./helpers/fake.ts";

const FAKE_UNITY = fileURLToPath(new URL("./helpers/fake-unity.mjs", import.meta.url));

const FREE: LockProbe = { isLocked: async () => false, processes: async () => [] };

function lockedBy(holders: UnityProcess[]): LockProbe {
  return { isLocked: async () => true, processes: async () => holders };
}

function project(version = "6000.6.0f1"): string {
  const dir = path.join(tempLabHome(), "My Game");
  mkdirSync(path.join(dir, "ProjectSettings"), { recursive: true });
  mkdirSync(path.join(dir, "Assets"), { recursive: true });
  writeFileSync(path.join(dir, "ProjectSettings", "ProjectVersion.txt"), `m_EditorVersion: ${version}\nm_EditorVersionWithRevision: ${version} (abc123)\n`);
  return dir;
}

interface Bench {
  home: string;
  env: NodeJS.ProcessEnv;
  lines: string[];
  spawned: { exe: string; args: string[] }[];
  deps: (cfg?: Record<string, unknown>, lock?: LockProbe) => BuildDeps;
  opts: (o: Partial<BuildOptions> & Pick<BuildOptions, "projectPath" | "target">, cfg?: Record<string, unknown>, lock?: LockProbe) => BuildOptions;
}

function bench(): Bench {
  const home = tempLabHome();
  const env: NodeJS.ProcessEnv = { ...process.env, EMU_LAB_HOME: home };
  const lines: string[] = [];
  const spawned: { exe: string; args: string[] }[] = [];
  const deps = (cfg: Record<string, unknown> = {}, lock: LockProbe = FREE): BuildDeps => ({
    findUnity: () => ({ version: "6000.6.0f1", exe: "/fake/Unity" }),
    lock,
    watchdog: false,
    spawnUnity: (exe, args) => {
      spawned.push({ exe, args });
      return spawn(process.execPath, [FAKE_UNITY, ...args], {
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, FAKE_UNITY: JSON.stringify(cfg) },
      });
    },
  });
  return {
    home,
    env,
    lines,
    spawned,
    deps,
    opts: (o, cfg, lock) => ({ env, report: (l) => lines.push(l), deps: deps(cfg, lock), ...o }),
  };
}

async function rejectsCode(p: Promise<unknown>, code: string, msg?: RegExp): Promise<Error> {
  try {
    await p;
  } catch (err) {
    assert.ok(isEmuError(err), `expected EmuError ${code}, got ${String(err)}`);
    assert.equal((err as { code: string }).code, code, (err as Error).message);
    if (msg) assert.match((err as Error).message, msg);
    return err as Error;
  }
  assert.fail(`expected ${code}`);
}

describe("build helpers", () => {
  test("defaultBuildOut: <labHome>/builds/<folder>-<sha256 of the lowercased path, 8 hex>/<target>", () => {
    const proj = path.resolve("Some Proj [x]");
    const hash = createHash("sha256").update(proj.toLowerCase(), "utf8").digest("hex").slice(0, 8);
    assert.equal(defaultBuildOut("/lab", proj, "Android"), path.join("/lab", "builds", `Some_Proj__x_-${hash}`, "Android", "app.apk"));
    assert.equal(defaultBuildOut("/lab", proj, "WebGL"), path.join("/lab", "builds", `Some_Proj__x_-${hash}`, "WebGL"));
    assert.equal(defaultBuildOut("/lab", proj, "Windows"), path.join("/lab", "builds", `Some_Proj__x_-${hash}`, "Windows", "app.exe"));
    // A trailing separator does not change the folder.
    assert.equal(defaultBuildOut("/lab", proj + path.sep, "WebGL"), defaultBuildOut("/lab", proj, "WebGL"));
  });

  test("defaultBuildOut matches Get-DefaultBuildOut's hash on Windows", { skip: process.platform !== "win32" }, () => {
    // PowerShell: SHA256 over UTF-8 of "c:\work\내 게임" (lowercased, backslashes) -> first 4 bytes as hex.
    const p = "C:\\Work\\내 게임";
    const hash = createHash("sha256").update("c:\\work\\내 게임", "utf8").digest("hex").slice(0, 8);
    assert.equal(defaultBuildOut("C:\\lab", p, "Android"), `C:\\lab\\builds\\____-${hash}\\Android\\app.apk`);
  });

  test("log path and Windows data folder", () => {
    assert.equal(buildLogPath(path.join("o", "app.apk"), "Android"), path.join("o", "app.build.log"));
    assert.equal(buildLogPath(path.join("o", "WebGL"), "WebGL"), path.join("o", "WebGL.build.log"));
    assert.equal(windowsDataDir(path.join("o", "Game.exe")), path.join("o", "Game_Data"));
  });

  test("logHits keeps markers, the build summary and compile errors", () => {
    const text = [
      "noise",
      "EMU_BUILD_NOTE audio-off: Disable Unity Audio is on",
      "Assets/A.cs(1,2): error CS0103: x",
      "Build Finished, Result: Success.",
      "EMU_BUILD_RESULT Succeeded target=Android out=/x",
    ].join("\r\n");
    assert.equal(logHits(text).length, 4);
  });

  test("buildErrorSummary picks the reason lines, with the line after UnityException", () => {
    const text = ["x", "UnityException: Build failed", "  Missing scene", "Assets/B.cs(3,4): error CS1002: ; expected", "y"].join("\n");
    assert.equal(buildErrorSummary(text), " Reason: UnityException: Build failed | Missing scene | Assets/B.cs(3,4): error CS1002: ; expected");
    assert.equal(buildErrorSummary("all fine"), "");
    assert.match(buildErrorSummary("No valid Unity Editor license found. Please activate your license."), /license/);
    // Case-insensitive like the PowerShell -match: Unity 6.6 writes "player" in lower case (a missing WebGL module).
    assert.equal(buildErrorSummary("Error building player because build target was unsupported"), " Reason: Error building player because build target was unsupported");
    assert.equal(logHits("build finished, result: failure.").length, 1);
  });

  test("outputStamp: APK file, WebGL folder with index.html, exe plus _Data", () => {
    const d = tempLabHome();
    assert.equal(outputStamp("Android", path.join(d, "a.apk")), null);
    writeFileSync(path.join(d, "a.apk"), "12345");
    assert.equal(outputStamp("Android", path.join(d, "a.apk"))?.bytes, 5);
    mkdirSync(path.join(d, "web", "Build"), { recursive: true });
    writeFileSync(path.join(d, "web", "Build", "x.data"), "1");
    assert.equal(outputStamp("WebGL", path.join(d, "web")), null, "no index.html");
    writeFileSync(path.join(d, "web", "index.html"), "12");
    assert.deepEqual({ ...outputStamp("WebGL", path.join(d, "web")), time: 0 }, { time: 0, bytes: 3, count: 2 });
    writeFileSync(path.join(d, "g.exe"), "1");
    mkdirSync(path.join(d, "g_Data"));
    writeFileSync(path.join(d, "g_Data", "d"), "123");
    assert.equal(outputStamp("Windows", path.join(d, "g.exe"))?.count, 2);
  });
});

describe("buildUnity options", () => {
  test("needs a method or a build profile, not both", async () => {
    const b = bench();
    const p = project();
    await rejectsCode(buildUnity(b.opts({ projectPath: p, target: "Android" })), "BAD_OPTION", /method/);
    await rejectsCode(buildUnity(b.opts({ projectPath: p, target: "Android", method: "A.B", buildProfile: "x.asset" })), "BAD_OPTION", /not both/);
    await rejectsCode(buildUnity(b.opts({ projectPath: p, target: "Android", method: "Bad Method" })), "BAD_OPTION", /Class\.Method/);
  });

  test("emuArm64 needs Android + method; webglCompression only WebGL; bad outputs", async () => {
    const b = bench();
    const p = project();
    await rejectsCode(buildUnity(b.opts({ projectPath: p, target: "WebGL", method: "A.B", emuArm64: true })), "BAD_OPTION", /emuArm64/);
    await rejectsCode(buildUnity(b.opts({ projectPath: p, target: "Android", buildProfile: "x.asset", emuArm64: true })), "BAD_OPTION", /emuArm64/);
    await rejectsCode(buildUnity(b.opts({ projectPath: p, target: "Android", method: "A.B", webglCompression: "gzip" })), "BAD_OPTION", /WebGL/);
    await rejectsCode(buildUnity(b.opts({ projectPath: p, target: "Android", method: "A.B", out: path.join(b.home, "x.aab") })), "BAD_OPTION", /\.apk/);
    await rejectsCode(buildUnity(b.opts({ projectPath: p, target: "Windows", method: "A.B", out: path.join(b.home, "x") })), "BAD_OPTION", /\.exe/);
    mkdirSync(path.join(b.home, "dir.apk"));
    await rejectsCode(buildUnity(b.opts({ projectPath: p, target: "Android", method: "A.B", out: path.join(b.home, "dir.apk") })), "BAD_OPTION", /folder/);
    await rejectsCode(buildUnity(b.opts({ projectPath: path.join(b.home, "missing"), target: "Android", method: "A.B" })), "NO_PROJECT");
    assert.equal(b.spawned.length, 0, "Unity never started");
  });
});

describe("buildUnity with a fake Unity", () => {
  test("Android: arguments, BUILD_OK, EMU_BUILD_WARN/NOTE reported once", async () => {
    const b = bench();
    const p = project();
    const r = await buildUnity(
      b.opts(
        { projectPath: p, target: "Android", method: "EmuProjectBuild.BuildApk", release: true, emuArm64: true, extraArgs: ["-flavor", "with space"] },
        {
          finished: "Success",
          result: "Succeeded",
          log: ["EMU_BUILD_WARN signed with the debug keystore", "EMU_BUILD_WARN signed with the debug keystore", "EMU_BUILD_NOTE Export Project is off"],
        },
      ),
    );
    const out = defaultBuildOut(b.home, p, "Android");
    assert.equal(r.out, out);
    assert.equal(r.target, "Android");
    assert.equal(r.unchanged, false);
    assert.deepEqual(r.warnings, ["EMU_BUILD_WARN signed with the debug keystore"]);
    assert.deepEqual(r.notes, ["EMU_BUILD_NOTE Export Project is off"]);
    assert.ok(existsSync(out));
    const args = b.spawned[0].args;
    assert.deepEqual(args.slice(0, 10), ["-batchmode", "-quit", "-nographics", "-projectPath", p, "-buildTarget", "android", "-logFile", buildLogPath(out, "Android"), "-executeMethod"]);
    assert.deepEqual(args.slice(10), ["EmuProjectBuild.BuildApk", "-buildOut", out, "-apkOut", out, "-release", "-emuArm64", "-flavor", "with space"]);
    assert.equal(b.lines.filter((l) => l === "EMU_BUILD_WARN signed with the debug keystore").length, 1);
    assert.ok(b.lines.some((l) => l.startsWith(`BUILD_OK ${out} (`)));
  });

  test("build profile: -activeBuildProfile + -build; WebGL compression passed on", async () => {
    const b = bench();
    const p = project();
    const r = await buildUnity(b.opts({ projectPath: p, target: "WebGL", buildProfile: "Assets/Settings/Build Profiles/Web.asset" }, { finished: "Success" }));
    const args = b.spawned[0].args;
    assert.deepEqual(args.slice(-4), ["-activeBuildProfile", "Assets/Settings/Build Profiles/Web.asset", "-build", r.out]);
    assert.ok(existsSync(path.join(r.out, "index.html")));
    const b2 = bench();
    await buildUnity(b2.opts({ projectPath: p, target: "WebGL", method: "A.B", webglCompression: "brotli" }, {}));
    assert.deepEqual(b2.spawned[0].args.slice(-2), ["-webglCompression", "brotli"]);
  });

  test("an old output in the lab's builds folder is cleared first", async () => {
    const b = bench();
    const p = project();
    const out = defaultBuildOut(b.home, p, "WebGL");
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, "stale.txt"), "old");
    await buildUnity(b.opts({ projectPath: p, target: "WebGL", method: "A.B" }, {}));
    assert.equal(existsSync(path.join(out, "stale.txt")), false);
    assert.ok(b.lines.some((l) => l.startsWith("Cleared the previous lab output")));
  });

  test("Windows: exe plus _Data passes; exe alone fails", async () => {
    const b = bench();
    const p = project();
    const r = await buildUnity(b.opts({ projectPath: p, target: "Windows", method: "EmuProjectBuild.BuildWindows" }, { result: "Succeeded" }));
    assert.equal(path.basename(r.out), "app.exe");
    assert.equal(b.spawned[0].args[6], "win64");
    assert.equal(r.files, 2);
    await rejectsCode(buildUnity(bench().opts({ projectPath: p, target: "Windows", method: "A.B" }, { noDataDir: true })), "BUILD_NO_OUTPUT", /app_Data/);
  });

  test("exit code 1: BUILD_FAILED with the reason from the log", async () => {
    const b = bench();
    await rejectsCode(
      buildUnity(b.opts({ projectPath: project(), target: "Android", method: "A.B" }, { exitCode: 1, write: false, log: ["UnityException: Build failed", "  No enabled scene"] })),
      "BUILD_FAILED",
      /exit 1\)\. Reason: UnityException: Build failed \| No enabled scene Log: /,
    );
  });

  test("exit 0 with a failed build in the log: BUILD_FAILED (Build Finished, then EMU_BUILD_RESULT)", async () => {
    await rejectsCode(
      buildUnity(bench().opts({ projectPath: project(), target: "Android", method: "A.B" }, { finished: "Failure" })),
      "BUILD_FAILED",
      /Build Finished, Result: Failure/,
    );
    await rejectsCode(
      buildUnity(bench().opts({ projectPath: project(), target: "Android", method: "A.B" }, { result: "Failed" })),
      "BUILD_FAILED",
      /EMU_BUILD_RESULT Failed/,
    );
  });

  test("exit 0 but nothing written: BUILD_NO_OUTPUT", async () => {
    await rejectsCode(
      buildUnity(bench().opts({ projectPath: project(), target: "Android", method: "A.B" }, { write: false })),
      "BUILD_NO_OUTPUT",
      /nothing was written/,
    );
  });

  test("an output an earlier build left (outside the lab) does not count", async () => {
    const b = bench();
    const p = project();
    const outDir = tempLabHome();
    const out = path.join(outDir, "app.apk");
    writeFileSync(out, "old apk");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(out, old, old);
    await rejectsCode(
      buildUnity(b.opts({ projectPath: p, target: "Android", method: "A.B", out }, { write: false, finished: "Success" })),
      "BUILD_NO_OUTPUT",
      /earlier build left it\. The log says the build succeeded/,
    );
    assert.equal(readFileSync(out, "utf8"), "old apk", "an output outside the lab is never cleared");
  });

  test("an unchanged incremental build of the same path passes when EMU_BUILD_RESULT names it", async () => {
    const b = bench();
    const p = project();
    const outDir = tempLabHome();
    const out = path.join(outDir, "app.apk");
    writeFileSync(out, "same apk");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(out, old, old);
    const r = await buildUnity(b.opts({ projectPath: p, target: "Android", method: "A.B", out }, { write: false, result: "Succeeded" }));
    assert.equal(r.unchanged, true);
    assert.ok(b.lines.some((l) => /unchanged: incremental build/.test(l)));
  });

  test("split APKs written next to the output are named", async () => {
    const b = bench();
    const p = project();
    const outDir = tempLabHome();
    const out = path.join(outDir, "app.apk");
    await rejectsCode(
      buildUnity(b.opts({ projectPath: p, target: "Android", method: "A.B", out }, { write: false, extraFiles: [path.join(outDir, "app.arm64_v8a.apk")] })),
      "BUILD_NO_OUTPUT",
      /app\.arm64_v8a\.apk.*Split APKs/,
    );
  });

  test("Export Project left a folder at the output", async () => {
    const b = bench();
    const outDir = tempLabHome();
    await rejectsCode(
      buildUnity(b.opts({ projectPath: project(), target: "Android", method: "A.B", out: path.join(outDir, "app.apk") }, { folder: true })),
      "BUILD_NO_OUTPUT",
      /Export Project/,
    );
  });

  test("a method that writes its own exe name is named", async () => {
    const b = bench();
    const outDir = tempLabHome();
    await rejectsCode(
      buildUnity(
        b.opts({ projectPath: project(), target: "Windows", method: "A.B", out: path.join(outDir, "app.exe") }, { writeTo: path.join(outDir, "MyGame.exe") }),
      ),
      "BUILD_NO_OUTPUT",
      /MyGame\.exe/,
    );
  });

  test("refused while an Editor has the project open, or a batchmode build runs; Unity never starts", async () => {
    const b = bench();
    const p = project();
    const editor: UnityProcess = { pid: 11, ppid: 1, batchmode: false, worker: false, commandLine: "Unity -projectpath x" };
    const worker: UnityProcess = { pid: 12, ppid: 11, batchmode: true, worker: true, commandLine: "Unity -batchMode -name AssetImportWorker0" };
    const build: UnityProcess = { pid: 13, ppid: 1, batchmode: true, worker: false, commandLine: "Unity -batchmode -quit" };
    await rejectsCode(buildUnity(b.opts({ projectPath: p, target: "Android", method: "A.B" }, {}, lockedBy([editor, worker]))), "PROJECT_OPEN", /pid 11\)/);
    await rejectsCode(buildUnity(b.opts({ projectPath: p, target: "Android", method: "A.B" }, {}, lockedBy([worker]))), "PROJECT_OPEN", /pid 11\)/);
    await rejectsCode(buildUnity(b.opts({ projectPath: p, target: "Android", method: "A.B" }, {}, lockedBy([build]))), "BUILD_RUNNING", /pid 13/);
    await rejectsCode(buildUnity(b.opts({ projectPath: p, target: "Android", method: "A.B" }, {}, lockedBy([]))), "PROJECT_OPEN", /no running Unity that this shell can see/);
    assert.equal(b.spawned.length, 0);
  });

  test("a second build of the same project in this process is refused while the first runs", async () => {
    const b = bench();
    const p = project();
    const first = buildUnity(b.opts({ projectPath: p, target: "Android", method: "A.B" }, { sleepMs: 800 }));
    await sleep(100);
    await rejectsCode(buildUnity(b.opts({ projectPath: p, target: "WebGL", method: "A.B" }, {})), "BUILD_RUNNING", /already building/);
    await first;
  });

  test("timeout: Unity is stopped and BUILD_TIMEOUT names the guard Report", async () => {
    const b = bench();
    const p = project();
    const pidFile = path.join(b.home, "unity.pid");
    await rejectsCode(
      buildUnity(b.opts({ projectPath: p, target: "Android", method: "A.B", timeoutMinutes: 0.02 }, { sleepMs: 60_000, pidFile })),
      "BUILD_TIMEOUT",
      /guard report/,
    );
    const pid = Number(readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 50 && isAlive(pid); i++) await sleep(100);
    assert.equal(isAlive(pid), false, "the fake Unity was stopped");
    assert.ok(b.lines.some((l) => l.startsWith(`Stopping Unity pid`)));
  });
});
