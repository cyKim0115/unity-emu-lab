// A fake Unity editor for the build tests: `node fake-unity.mjs <Unity's batchmode arguments>`.
// What it does comes from the FAKE_UNITY environment variable (JSON):
//   exitCode      exit code (default 0)
//   write         write the output (default true): Android an APK file, WebGL a folder with index.html and
//                 Build/app.data, Windows the exe plus <name>_Data/data.unity3d
//   writeTo       write the output here instead of -buildOut (a method that ignores -buildOut)
//   extraFiles    more files to create (absolute paths), e.g. split APKs
//   noDataDir     Windows: write the exe without its _Data folder
//   folder        Android: write a folder at the output (Export Project)
//   finished      "Success" | "Failure" | ... -> a "Build Finished, Result: <x>" log line
//   result        "Succeeded" | "Failed" | ... -> "EMU_BUILD_RESULT <x> ... out=<-buildOut>"
//   log           more log lines
//   sleepMs       wait this long before doing anything (timeout tests)
//   argsFile      write the arguments it got (JSON) here
//   pidFile       write its pid here first
// Nothing here starts a real Unity.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const cfg = JSON.parse(process.env.FAKE_UNITY || "{}");

function arg(name) {
  const i = args.findIndex((a) => a.toLowerCase() === name.toLowerCase());
  return i >= 0 ? args[i + 1] : undefined;
}

if (cfg.pidFile) writeFileSync(cfg.pidFile, String(process.pid));
if (cfg.argsFile) writeFileSync(cfg.argsFile, JSON.stringify(args));
if (cfg.sleepMs) await new Promise((r) => setTimeout(r, cfg.sleepMs));

const target = (arg("-buildTarget") || "").toLowerCase();
const out = cfg.writeTo || arg("-buildOut") || arg("-build");
const lines = ["Fake Unity batchmode", `-projectPath ${arg("-projectPath")}`];
const stamp = String(Date.now());

if (cfg.write !== false && out) {
  if (target === "webgl") {
    mkdirSync(path.join(out, "Build"), { recursive: true });
    writeFileSync(path.join(out, "index.html"), `<html>${stamp}</html>`);
    writeFileSync(path.join(out, "Build", "app.data"), stamp);
  } else if (target === "android" && cfg.folder) {
    mkdirSync(path.join(out, "launcher"), { recursive: true });
    writeFileSync(path.join(out, "build.gradle"), stamp);
  } else {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${target}-binary-${stamp}`);
    if (target === "win64" && !cfg.noDataDir) {
      const data = path.join(path.dirname(out), `${path.basename(out, path.extname(out))}_Data`);
      mkdirSync(data, { recursive: true });
      writeFileSync(path.join(data, "data.unity3d"), stamp);
    }
  }
}
for (const f of cfg.extraFiles || []) {
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, stamp);
}
for (const l of cfg.log || []) lines.push(l);
if (cfg.result) lines.push(`EMU_BUILD_RESULT ${cfg.result} target=${target} errors=0 size=1 time=00:00:01 out=${arg("-buildOut") || out}`);
if (cfg.finished) lines.push(`Build Finished, Result: ${cfg.finished}.`);
const log = arg("-logFile");
if (log) writeFileSync(log, lines.join("\n") + "\n");
process.exit(cfg.exitCode ?? 0);
