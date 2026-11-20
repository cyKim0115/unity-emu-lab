// Fake adb for tests: `node fake-adb.mjs <adb args...>`. Behaviour comes from a JSON state file named by
// the FAKE_ADB_STATE environment variable:
//
//   { "log": "<file; one JSON line {args, cmd} appended per call>",
//     "rules": [ { "match": "<regex against the args joined by spaces, a leading '-s <serial>' removed>",
//                  "stdout": "text", "stdoutFile": "path", "stdoutBase64": "...", "stderr": "text",
//                  "exitCode": 0, "times": 1, "delayMs": 0, "stream": "path", "serial": "emulator-5556" } ] }
//
// The first matching rule with remaining `times` wins (missing = unlimited). Use counts live next to the
// state file (<state>.used.<index>, one byte per use) so separate processes share them. `stream` prints the
// file's content, then whatever is appended to it every 100 ms, until the process is killed (logcat).
// No match: exit 0 with empty output. Never touches a real device.

import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";

const statePath = process.env.FAKE_ADB_STATE;
const args = process.argv.slice(2);

function readState() {
  if (!statePath) return { rules: [] };
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return { rules: [] };
  }
}

function usedCount(index) {
  const p = `${statePath}.used.${index}`;
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

function markUsed(index) {
  appendFileSync(`${statePath}.used.${index}`, "x");
}

function write(stream, data) {
  return new Promise((resolve) => {
    if (data === undefined || data === null || data.length === 0) return resolve();
    stream.write(data, () => resolve());
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function streamFile(path) {
  let offset = 0;
  for (;;) {
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      size = 0;
    }
    if (size > offset) {
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(size - offset);
        const n = readSync(fd, buf, 0, buf.length, offset);
        offset += n;
        await write(process.stdout, buf.subarray(0, n));
      } finally {
        closeSync(fd);
      }
    }
    await sleep(100);
  }
}

async function main() {
  const state = readState();
  const cmdArgs = args[0] === "-s" ? args.slice(2) : args;
  const cmd = cmdArgs.join(" ");
  if (state.log) appendFileSync(state.log, JSON.stringify({ args, cmd }) + "\n");

  const rules = Array.isArray(state.rules) ? state.rules : [];
  let rule = null;
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (r.times !== undefined && r.times !== null && usedCount(i) >= r.times) continue;
    // "serial": the rule answers only calls made with "-s <serial>" (a second device in the same bench).
    if (r.serial !== undefined && r.serial !== null && !(args[0] === "-s" && args[1] === r.serial)) continue;
    if (new RegExp(r.match).test(cmd)) {
      if (r.times !== undefined && r.times !== null) markUsed(i);
      rule = r;
      break;
    }
  }
  if (!rule) return;

  if (rule.delayMs) await sleep(rule.delayMs);
  if (rule.stdoutBase64) await write(process.stdout, Buffer.from(rule.stdoutBase64, "base64"));
  if (rule.stdoutFile && existsSync(rule.stdoutFile)) await write(process.stdout, readFileSync(rule.stdoutFile));
  if (rule.stdout) await write(process.stdout, Buffer.from(rule.stdout, "utf8"));
  if (rule.stderr) await write(process.stderr, Buffer.from(rule.stderr, "utf8"));
  if (rule.stream) await streamFile(rule.stream); // until killed
  process.exitCode = rule.exitCode ?? 0;
}

await main();
