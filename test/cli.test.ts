// The emu-lab command line, run as a child process (`node bin/emu-lab.js ...`) with a temp EMU_LAB_HOME and EMU_ADB
// pointing at a file that does not exist: nothing here reaches a real adb, device or emulator.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLocations } from "../src/config.ts";
import { formatLocalIso, leasePath, readLease, writeLease } from "../src/lease.ts";
import { runCli, USAGE, type CliIo } from "../src/cli.ts";
import { makeFakeAdb, tempLabHome } from "./helpers/fake.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = path.join(ROOT, "bin", "emu-lab.js");
const VERSION = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const MISSING_ADB = path.join(ROOT, "test", "no-such-dir", process.platform === "win32" ? "adb.exe" : "adb");
const HOUR = 3_600_000;

function testEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, EMU_LAB_HOME: home, EMU_ADB: MISSING_ADB, EMU_OWNER: "test:me" };
  delete env.EMU_AVD;
  return env;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], home = tempLabHome()): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: ROOT, env: testEnv(home), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function seedOtherLease(home: string, expiresInMs: number): Promise<string> {
  const file = leasePath(resolveLocations({ env: testEnv(home) }), "unity-test");
  const now = Date.now();
  await writeLease(
    file,
    {
      avd: "unity-test",
      owner: "test:other",
      host: "OTHERHOST",
      acquiredAt: formatLocalIso(new Date(now - 60_000)),
      expiresAt: formatLocalIso(new Date(now + expiresInMs)),
      startedEmulator: false,
      emulatorPid: null,
      emulatorStartedAt: null,
      installed: [],
    },
    { create: false },
  );
  return file;
}

describe("help and version", () => {
  test("help lists the commands (exit 0)", async () => {
    for (const args of [["help"], ["--help"], ["-h"]]) {
      const r = await run(args);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Usage: emu-lab <command> \[options\]/);
      for (const cmd of ["status", "start", "renew", "release", "smoke <apk>", "notification", "clock forward <minutes>", "clock reset", "screenshot", "webgl <build-dir>", "serve"]) {
        assert.ok(r.stdout.includes(cmd), `${args.join(" ")}: ${cmd}`);
      }
      assert.equal(r.stderr, "");
    }
  });

  test("--version, -v and version print the package.json version", async () => {
    for (const args of [["--version"], ["-v"], ["version"]]) {
      const r = await run(args);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.trim(), VERSION);
    }
  });
});

describe("usage errors exit 2", () => {
  test("unknown option", async () => {
    const r = await run(["status", "--bogus"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^USAGE: /);
    assert.equal(r.stdout, "");
  });

  test("an option of another command, an unknown command, a bad number, missing arguments", async () => {
    const cases: string[][] = [
      ["status", "--stale"],
      ["frobnicate"],
      ["start", "--hours", "many"],
      ["smoke"],
      ["clock"],
      ["clock", "backward", "5"],
      ["clock", "forward", "-3"],
      ["notification", "--title", "Hello"],
      ["release", "--stale", "--any-owner"],
      ["webgl"],
      ["webgl", "a", "b"],
      ["webgl", "dir", "--ready-mode", "sometimes"],
      ["webgl", "dir", "--tap-input", "pen"],
      ["webgl", "dir", "--gpu", "magic"],
      ["webgl", "dir", "--width", "wide"],
      ["webgl", "dir", "--notif-delay", "0"],
      ["smoke", "app.apk", "--browser", "chrome"],
      ["build"],
      ["build", "proj"],
      ["build", "proj", "--target", "ios", "--method", "A.B"],
      ["build", "proj", "--target", "android", "--webgl-compression", "zip", "--method", "A.B"],
      ["build", "proj", "--target", "android"],
      ["build", "proj", "--target", "webgl", "--method", "A.B", "--build-profile", "x.asset"],
      ["build", "proj", "--target", "webgl", "--method", "A.B", "--hours", "1"],
      ["build", "proj", "--target", "webgl", "--method", "A.B", "--timeout-minutes", "soon"],
      ["template"],
      ["template", "a", "b"],
      ["guard"],
      ["guard", "snapshot"],
      ["guard", "frob", "p"],
      ["guard", "report", "p", "--replace"],
      ["guard", "snapshot", "p", "--keep", "x"],
      ["guard", "report", "p", "--target", "android"],
    ];
    for (const args of cases) {
      const r = await run(args);
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /^(USAGE|BAD_OPTION): /, args.join(" "));
    }
  });
});

describe("webgl", () => {
  test("a folder without index.html: NO_BUILD, exit 1, nothing started", async () => {
    const dir = tempLabHome();
    const r = await run(["webgl", dir]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /^NO_BUILD: No index\.html in /);
    assert.equal(r.stdout, "");
  });
});

describe("build and template", () => {
  test("a folder that is not a Unity project: NO_PROJECT, exit 1", async () => {
    const dir = tempLabHome();
    const r = await run(["build", dir, "--target", "android", "--method", "A.B"]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /^NO_PROJECT: Not a Unity project/);
    const t = await run(["template", dir]);
    assert.equal(t.code, 1, t.stdout + t.stderr);
    assert.match(t.stderr, /NO_PROJECT: /);
  });

  test("guard outside git: NOT_GIT, exit 1", async () => {
    const r = await run(["guard", "snapshot", tempLabHome()]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /^NOT_GIT: not a git work tree/);
  });
});

describe("status", () => {
  test("prints the lease state and a clear NO_ADB line without crashing", async () => {
    const home = tempLabHome();
    const r = await run(["status"], home);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^AVD\s+unity-test$/m);
    assert.match(r.stdout, /^owner\s+test:me/m);
    assert.match(r.stdout, /^lease\s+none/m);
    assert.match(r.stdout, /^NO_ADB adb not found/m);
    assert.ok(r.stdout.includes(MISSING_ADB), "names the adb path");
    assert.ok(r.stdout.includes("env EMU_ADB"), "names where the path came from");
    assert.equal(r.stderr, "");
  });

  test("another session's valid lease shows as BUSY; --json prints the status object on the last line", async () => {
    const home = tempLabHome();
    await seedOtherLease(home, HOUR);
    const r = await run(["status"], home);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^lease\s+test:other \(host OTHERHOST\).*\[valid, another session: BUSY\]$/m);

    const j = await run(["status", "--json"], home);
    assert.equal(j.code, 0, j.stderr);
    const lines = j.stdout.trim().split(/\r?\n/);
    const s = JSON.parse(lines[lines.length - 1]);
    assert.equal(s.lease.owner, "test:other");
    assert.equal(s.lease.valid, true);
    assert.equal(s.lease.mine, false);
    assert.equal(s.adbVersion, null);
    assert.equal(s.paths.labHome, home);
  });
});

describe("lease commands", () => {
  test("release with no lease: exit 0 and LEASE_NONE", async () => {
    const r = await run(["release"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^LEASE_NONE AVD 'unity-test' has no lease/m);
  });

  test("release --json with no lease prints released false", async () => {
    const r = await run(["release", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trim().split(/\r?\n/);
    assert.equal(JSON.parse(lines[lines.length - 1]).released, false);
  });

  test("renew without a lease: exit 1 and NO_LEASE on stderr", async () => {
    const r = await run(["renew"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^NO_LEASE: /);
    assert.ok(!r.stderr.startsWith("NO_LEASE: NO_LEASE"));
  });

  test("start under another session's valid lease: exit 1 BUSY, lease untouched", async () => {
    const home = tempLabHome();
    const file = await seedOtherLease(home, HOUR);
    const before = await readLease(file);
    const r = await run(["start"], home);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^BUSY: AVD 'unity-test' is leased by test:other/);
    assert.deepEqual(await readLease(file), before);
  });

  test("release of another session's lease: exit 1 NOT_OWNER, lease kept", async () => {
    const home = tempLabHome();
    const file = await seedOtherLease(home, HOUR);
    const r = await run(["release"], home);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^NOT_OWNER /);
    assert.ok(existsSync(file));
  });

  test("start with a missing adb gives the lease back and exits 1 with NO_ADB", async () => {
    const home = tempLabHome();
    const r = await run(["start"], home);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^NO_ADB: adb not found/);
    assert.match(r.stdout, /LEASE new avd=unity-test owner=test:me/);
    assert.match(r.stdout, /LEASE given back \(start failed\)/);
    assert.equal(existsSync(leasePath(resolveLocations({ env: testEnv(home) }), "unity-test")), false);
    rmSync(home, { recursive: true, force: true });
  });

  test("clock reset with a missing adb: exit 1 with NO_ADB", async () => {
    const r = await run(["clock", "reset"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^NO_ADB: /);
  });
});

describe("lease mode of the device commands (in process, fake adb)", () => {
  function cliBench(lease: "none" | "other") {
    const home = tempLabHome();
    const fake = makeFakeAdb([
      { match: "^devices$", stdout: "List of devices attached\nemulator-5554\tdevice\n\n" },
      { match: "^emu avd name", stdout: "unity-test\r\nOK\r\n" },
    ]);
    const env = testEnv(home);
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l), env, adbFactory: () => fake.adb };
    const ready = (async () => {
      if (lease === "other") {
        const now = Date.now();
        await writeLease(
          leasePath(resolveLocations({ env }), "unity-test"),
          {
            avd: "unity-test", owner: "codex:other1", host: "H", acquiredAt: formatLocalIso(new Date(now)),
            expiresAt: formatLocalIso(new Date(now + HOUR)), startedEmulator: false, emulatorPid: null, emulatorStartedAt: null, installed: [],
          },
          { create: true },
        );
      }
    })();
    return { home, fake, io, out, err, ready };
  }
  const DEVICE_CHANGES = /^(install|uninstall|logcat|shell (settings put|svc|input|wm|am|pm|cmd|setprop|date -u|monkey|uiautomator|rm))/;

  test("--strict without a lease: smoke, notification and clock forward refuse with NO_LEASE before any device change", async () => {
    const b = cliBench("none");
    await b.ready;
    for (const args of [
      ["smoke", "no-such.apk", "--strict"],
      ["notification", "--package", "com.x", "--title", "t", "--strict"],
      ["clock", "forward", "30", "--strict"],
    ]) {
      b.err.length = 0;
      const code = await runCli(args, b.io);
      assert.equal(code, 1, args.join(" "));
      assert.match(b.err.join("\n"), /^NO_LEASE: AVD 'unity-test' is not leased by test:me/, args.join(" "));
    }
    assert.deepEqual(b.fake.commands().filter((c) => DEVICE_CHANGES.test(c)), []);
  });

  test("another owner's valid lease: BUSY in the default warn mode too", async () => {
    const b = cliBench("other");
    await b.ready;
    for (const args of [["smoke", "no-such.apk"], ["notification", "--package", "com.x", "--title", "t"], ["clock", "forward", "30"]]) {
      b.err.length = 0;
      const code = await runCli(args, b.io);
      assert.equal(code, 1, args.join(" "));
      assert.match(b.err.join("\n"), /^BUSY: AVD 'unity-test' is leased by codex:other1/, args.join(" "));
    }
    assert.deepEqual(b.fake.commands().filter((c) => DEVICE_CHANGES.test(c)), []);
  });

  test("the help names the screenshot file as it is written", () => {
    assert.match(USAGE, /<lab home>\/runs\/<stamp>-screenshot-<pid>\.png/);
  });
});

describe("serve", () => {
  async function session(args: string[]): Promise<{ code: number | null; lines: string[] }> {
    const home = tempLabHome();
    const child = spawn(process.execPath, [BIN, ...args], { cwd: ROOT, env: testEnv(home), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", () => {});
    const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    const timer = setTimeout(() => child.kill(), 60_000);
    const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    const answers = () => stdout.split("\n").filter((l) => l.trim()).length;
    const waitFor = async (n: number) => {
      const deadline = Date.now() + 30_000;
      while (answers() < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    };

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cli-test", version: "0.0.0" } },
    });
    await waitFor(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    // Tool calls that run real code paths with a missing adb: nothing they do may reach stdout.
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "emu_status", arguments: {} } });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "emu_release", arguments: {} } });
    await waitFor(3); // emu_release holds the AVD as a job until it answers
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "emu_clock", arguments: { action: "reset" } } });
    await waitFor(4);
    child.stdin.end();
    const code = await exited;
    clearTimeout(timer);
    return { code, lines: stdout.split("\n").filter((l) => l.trim()) };
  }

  for (const args of [["serve"], []]) {
    const how = args.length ? "emu-lab serve" : "no command with stdin not a terminal (how MCP clients launch it)";
    test(`${how}: only JSON-RPC on stdout through initialize and tool calls, and exits when stdin closes`, async () => {
      const { code, lines } = await session(args);
      const byId = new Map<number, { jsonrpc: string; id: number; result?: { content?: { text: string }[]; isError?: boolean; serverInfo?: { name: string; version: string }; instructions?: string } }>();
      for (const l of lines) {
        const msg = JSON.parse(l) as { jsonrpc: string; id: number };
        assert.equal(msg.jsonrpc, "2.0", "only JSON-RPC on stdout");
        byId.set(msg.id, msg);
      }
      assert.deepEqual([...byId.keys()].sort(), [1, 2, 3, 4], lines.join("\n"));
      const init = byId.get(1)!.result!;
      assert.equal(init.serverInfo?.name, "unity-emu-lab");
      assert.equal(init.serverInfo?.version, VERSION);
      assert.match(init.instructions ?? "", /emu_start/);
      const status = byId.get(2)!.result!;
      assert.notEqual(status.isError, true);
      assert.match(status.content?.[0].text ?? "", /"avd": "unity-test"/);
      const release = byId.get(3)!.result!;
      assert.match(release.content?.[0].text ?? "", /"released": false/);
      const clock = byId.get(4)!.result!;
      assert.equal(clock.isError, true);
      assert.match(clock.content?.[0].text ?? "", /^NO_ADB: /);
      assert.equal(code, 0);
    });
  }
});
