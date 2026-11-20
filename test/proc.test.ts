import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  exeNameFromLink,
  findProcesses,
  getProcessInfo,
  parseLstart,
  parsePsLines,
  parseWindowsProcessLines,
  runProcess,
  runProcessBuffer,
  sleep,
  spawnDetached,
} from "../src/proc.ts";
import { tempLabHome } from "./helpers/fake.ts";

const node = process.execPath;

describe("runProcess", () => {
  it("returns UTF-8 stdout, stderr and a non-zero code without throwing", async () => {
    const r = await runProcess(node, [
      "-e",
      "process.stdout.write('한글 알림 ✓'); process.stderr.write('err text'); process.exitCode = 3",
    ]);
    assert.deepEqual(r, { code: 3, stdout: "한글 알림 ✓", stderr: "err text", timedOut: false });
  });

  it("keeps multi-byte characters split across chunks intact", async () => {
    const r = await runProcess(node, [
      "-e",
      "const b = Buffer.from('가나다'); process.stdout.write(b.subarray(0, 4)); setTimeout(() => process.stdout.write(b.subarray(4)), 50)",
    ]);
    assert.equal(r.stdout, "가나다");
  });

  it("kills the child on timeout", async () => {
    const t0 = Date.now();
    const r = await runProcess(node, ["-e", "setTimeout(() => {}, 30000)"], { timeoutMs: 300 });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - t0 < 5000, "resolved soon after the timeout");
  });

  it("resolves on exit even when a grandchild keeps the pipes open", async () => {
    // The child spawns a detached grandchild that inherits stdout/stderr (like an adb client forking the
    // server) and exits at once. Waiting for "close" would hang ~10 s.
    const script = [
      "const { spawn } = require('node:child_process');",
      "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });",
      "c.unref();",
      "process.stdout.write('parent done');",
    ].join(" ");
    const t0 = Date.now();
    const r = await runProcess(node, ["-e", script], { timeoutMs: 20_000 });
    const took = Date.now() - t0;
    assert.equal(r.timedOut, false);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "parent done");
    assert.ok(took < 5000, `resolved in ${took} ms`);
  });

  it("throws ENOENT for a missing program", async () => {
    await assert.rejects(runProcess(join(tmpdir(), "no-such-program-xyz.exe"), []), (e: NodeJS.ErrnoException) => e.code === "ENOENT");
  });

  it("passes env and cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "emu-lab-proc-"));
    const r = await runProcess(node, ["-e", "process.stdout.write(process.env.EMU_TEST_X + '|' + process.cwd())"], {
      env: { ...process.env, EMU_TEST_X: "yes" },
      cwd: dir,
    });
    assert.equal(r.stdout.split("|")[0], "yes");
    assert.equal(r.stdout.split("|")[1].toLowerCase(), dir.toLowerCase());
  });
});

describe("runProcessBuffer", () => {
  it("returns raw bytes", async () => {
    const r = await runProcessBuffer(node, ["-e", "process.stdout.write(Buffer.from([0x89, 0x50, 0x00, 0xff, 0x0d, 0x0a]))"]);
    assert.deepEqual([...r.stdout], [0x89, 0x50, 0x00, 0xff, 0x0d, 0x0a]);
    assert.equal(r.code, 0);
  });
});

describe("spawnDetached", () => {
  it("writes the child's output to its files and reports the exit", async () => {
    const dir = tempLabHome();
    const out = join(dir, "x.out.log");
    const err = join(dir, "x.err.log");
    const p = spawnDetached(node, ["-e", "console.log('to out'); console.error('to err'); process.exitCode = 4"], { outFile: out, errFile: err });
    assert.ok(p.pid > 0);
    const deadline = Date.now() + 10_000;
    while (!p.exited() && Date.now() < deadline) await sleep(50);
    assert.equal(p.exited(), true);
    assert.equal(p.exitCode(), 4);
    assert.equal(readFileSync(out, "utf8").trim(), "to out");
    assert.equal(readFileSync(err, "utf8").trim(), "to err");
  });

  it("throws for a missing program and leaves no open handles", () => {
    const dir = tempLabHome();
    assert.throws(
      () => spawnDetached(join(dir, "missing.exe"), [], { outFile: join(dir, "o.log"), errFile: join(dir, "e.log") }),
      (e: NodeJS.ErrnoException) => e.code === "ENOENT",
    );
    assert.ok(existsSync(join(dir, "o.log")));
  });
});

describe("process lookup", () => {
  it("getProcessInfo(process.pid) returns this node process with a sane start time", async () => {
    const info = await getProcessInfo(process.pid);
    assert.ok(info, "found");
    assert.equal(info.pid, process.pid);
    assert.match(info.name, /^node/i);
    const started = Date.now() - process.uptime() * 1000;
    assert.ok(Math.abs(info.startTime.getTime() - started) < 10_000, `start ${info.startTime.toISOString()} vs ${new Date(started).toISOString()}`);
  });

  it("getProcessInfo returns null for a pid that does not exist", async () => {
    assert.equal(await getProcessInfo(0), null);
    assert.equal(await getProcessInfo(4_000_000_000), null);
  });

  it("findProcesses(/^node/i) finds this process, newest first", async () => {
    const list = await findProcesses(/^node/i);
    assert.ok(list.some((p) => p.pid === process.pid));
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].startTime.getTime() >= list[i].startTime.getTime());
  });

  it("parses the Windows and ps formats", () => {
    assert.deepEqual(parseWindowsProcessLines("123|qemu-system-x86_64|2026-11-20T10:43:00.1234567+09:00\r\nbad line\r\n7|x|nope\r\n"), [
      { pid: 123, name: "qemu-system-x86_64", startTime: new Date("2026-11-20T01:43:00.123Z") },
    ]);
    const list = parsePsLines(" 4321 Thu Nov 20 10:43:00 2026 /opt/sdk/emulator/qemu/qemu-system-aarch64\n  9 Mon Nov  3 09:05:07 2026 node\n");
    assert.deepEqual(
      list.map((p) => [p.pid, p.name]),
      [
        [4321, "qemu-system-aarch64"],
        [9, "node"],
      ],
    );
    assert.deepEqual(list[0].startTime, new Date(2026, 10, 20, 10, 43, 0));
    assert.deepEqual(parseLstart("Mon Nov  3 09:05:07 2026"), new Date(2026, 10, 3, 9, 5, 7));
    assert.equal(parseLstart("garbage"), null);
  });

  it("takes the Linux executable name from the /proc/<pid>/exe link (comm is a thread name, cut to 15 chars)", () => {
    assert.equal(exeNameFromLink("/usr/bin/node"), "node");
    assert.equal(exeNameFromLink("/opt/sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64 (deleted)"), "qemu-system-x86_64");
    assert.equal(exeNameFromLink(""), null);
  });
});
