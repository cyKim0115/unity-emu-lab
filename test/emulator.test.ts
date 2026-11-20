// emulator.ts against the fake adb and injected process functions: nothing here touches a real device, emulator,
// process list or the real ~/.emu-lab.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { movedClockSerials, resetClockRegistry, timeTravel } from "../src/clock.ts";
import { resolveLocations } from "../src/config.ts";
import {
  getStatus,
  releaseEmulator,
  renew,
  startEmulator,
  type EmulatorDeps,
  type EmulatorTiming,
} from "../src/emulator.ts";
import { isEmuError } from "../src/errors.ts";
import { formatLocalIso, isLeaseValid, leasePath, readLease, renewLease, updateLease, writeLease } from "../src/lease.ts";
import type { ProcInfo } from "../src/proc.ts";
import type { LeaseRecord } from "../src/types.ts";
import { makeFakeAdb, tempLabHome, type FakeAdb, type FakeRule } from "./helpers/fake.ts";

const AVD = "unity-test";
const ME = "test:me";
const OTHER = "test:other";
const SERIAL = "emulator-5554";
const HOUR = 3_600_000;

const FAST: Partial<EmulatorTiming> = {
  reattachWaitMs: 400,
  lingerWaitMs: 300,
  lingerPollMs: 20,
  launchCheckMs: 10,
  bootPollMs: 20,
  releaseFindWaitMs: 150,
  stopWaitMs: 300,
  stopPollMs: 20,
  clock: { settleMs: 0, rootPollMs: 10, rootWaitMs: 500 },
};

/** Commands that only read (status, OTHER_EMULATOR refusal). */
const READ_ONLY = /^(devices|version|emu avd name|shell getprop \S+)$/;

interface DeviceOpts {
  running?: boolean;
  serial?: string;
  avd?: string;
  bootCompleted?: string;
  autoTime?: string;
  props?: Record<string, string>;
  extra?: FakeRule[];
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deviceRules(o: DeviceOpts = {}): FakeRule[] {
  const running = o.running ?? true;
  const serial = o.serial ?? SERIAL;
  const props: Record<string, string> = {
    "sys.boot_completed": o.bootCompleted ?? "1",
    "ro.product.cpu.abilist": "x86_64,arm64-v8a",
    "ro.dalvik.vm.native.bridge": "libndk_translation.so",
    "ro.build.version.release": "14",
    ...(o.props ?? {}),
  };
  return [
    ...(o.extra ?? []),
    { match: "^devices$", stdout: running ? `List of devices attached\r\n${serial}\tdevice\r\n\r\n` : "List of devices attached\r\n\r\n" },
    { match: "^emu avd name$", stdout: `${o.avd ?? AVD}\r\nOK\r\n` },
    ...Object.entries(props).map(([k, v]) => ({ match: `^shell getprop ${esc(k)}$`, stdout: `${v}\n` })),
    { match: "^shell settings get global auto_time$", stdout: `${o.autoTime ?? "1"}\n` },
    { match: "^shell date \\+%s%3N$", stdout: "1763600000000\n" },
    { match: "^version$", stdout: "Android Debug Bridge version 1.0.41\nInstalled as C:\\sdk\\platform-tools\\adb.exe\n" },
  ];
}

class FakeProcs {
  list: ProcInfo[] = [];
  /** Called when getProcessInfo runs (to drop a process after `emu kill`). */
  beforeInfo?: () => void;
  find = async (re: RegExp): Promise<ProcInfo[]> =>
    this.list.filter((p) => re.test(p.name)).sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
  info = async (pid: number): Promise<ProcInfo | null> => {
    this.beforeInfo?.();
    return this.list.find((p) => p.pid === pid) ?? null;
  };
}

interface Spawned {
  exe: string;
  args: string[];
  o: { outFile: string; errFile: string; env?: NodeJS.ProcessEnv };
}

interface Lab {
  home: string;
  env: NodeJS.ProcessEnv;
  file: string;
  fake: FakeAdb;
  procs: FakeProcs;
  spawned: Spawned[];
  out: string[];
  report: (l: string) => void;
  deps: EmulatorDeps;
  /** What the fake launch does (default: the emulator shows up in adb and a qemu process appears). */
  onSpawn: (s: Spawned) => { pid: number; exited: () => boolean; exitCode: () => number | null };
}

function lab(o: { device?: DeviceOpts; avdIni?: boolean; emulatorExe?: boolean } = {}): Lab {
  const home = tempLabHome();
  const sdk = path.join(home, "sdk");
  const avdHome = path.join(home, "avd");
  mkdirSync(path.join(sdk, "emulator"), { recursive: true });
  mkdirSync(avdHome, { recursive: true });
  if (o.emulatorExe ?? true) {
    writeFileSync(path.join(sdk, "emulator", process.platform === "win32" ? "emulator.exe" : "emulator"), "");
  }
  if (o.avdIni ?? true) writeFileSync(path.join(avdHome, `${AVD}.ini`), "path=x\n");
  const env: NodeJS.ProcessEnv = { EMU_LAB_HOME: home, ANDROID_SDK_ROOT: sdk, ANDROID_AVD_HOME: avdHome, EMU_OWNER: ME };
  const file = leasePath(resolveLocations({ env }), AVD);
  const fake = makeFakeAdb(deviceRules(o.device));
  const procs = new FakeProcs();
  const spawned: Spawned[] = [];
  const out: string[] = [];
  const l: Lab = {
    home,
    env,
    file,
    fake,
    procs,
    spawned,
    out,
    report: (line: string) => out.push(line),
    deps: {} as EmulatorDeps,
    onSpawn: () => {
      fake.setRules(deviceRules({ ...o.device, running: true }));
      procs.list.push({ pid: 7001, name: "qemu-system-x86_64", startTime: new Date(Date.now() - 1500) });
      return { pid: 7000, exited: () => false, exitCode: () => null };
    },
  };
  l.deps = {
    adbFactory: () => fake.adb,
    spawnDetached: (exe, args, so) => {
      const s = { exe, args, o: so };
      spawned.push(s);
      return l.onSpawn(s);
    },
    findProcesses: procs.find,
    getProcessInfo: procs.info,
    timing: FAST,
  };
  return l;
}

function leaseRecord(owner: string, fields: Partial<LeaseRecord> = {}): LeaseRecord {
  const now = Date.now();
  return {
    avd: AVD,
    owner,
    host: "HOST",
    acquiredAt: formatLocalIso(new Date(now - HOUR)),
    expiresAt: formatLocalIso(new Date(now + HOUR)),
    startedEmulator: false,
    emulatorPid: null,
    emulatorStartedAt: null,
    installed: [],
    ...fields,
  };
}

async function putLease(l: Lab, owner: string, fields: Partial<LeaseRecord> = {}): Promise<void> {
  await writeLease(l.file, leaseRecord(owner, fields), { create: true });
}

function has(l: Lab, prefix: string): boolean {
  return l.out.some((line) => line.startsWith(prefix));
}

const isCode = (code: Parameters<typeof isEmuError>[1]) => (e: unknown) => {
  assert.ok(isEmuError(e, code), `expected ${code}, got ${String(e)}`);
  return true;
};

describe("startEmulator", { concurrency: 4 }, () => {
  test("a failed start does not give back a lease another session took meanwhile", async () => {
    const l = lab({ device: { running: false }, emulatorExe: false });
    const theirs = leaseRecord(OTHER, { acquiredAt: formatLocalIso(new Date()) });
    // While start looks for a running qemu, a PowerShell session replaces the lease file.
    l.deps.findProcesses = async () => {
      writeFileSync(l.file, JSON.stringify(theirs, null, 2));
      return [];
    };
    await assert.rejects(startEmulator({ env: l.env, report: l.report, deps: l.deps }), isCode("NO_EMULATOR_EXE"));
    assert.equal((await readLease(l.file))?.owner, OTHER);
    assert.ok(has(l, "LEASE not given back: LEASE_CHANGED"), l.out.join("\n"));
  });

  test("BUSY on another owner's valid lease before any adb call", async () => {
    const l = lab();
    await putLease(l, OTHER);
    const before = readFileSync(l.file);
    await assert.rejects(startEmulator({ env: l.env, report: l.report, deps: l.deps }), (e: unknown) => {
      assert.ok(isEmuError(e, "BUSY"));
      assert.match((e as Error).message, /^BUSY: AVD 'unity-test' is leased by test:other/);
      return true;
    });
    assert.deepEqual(l.fake.calls(), []);
    assert.deepEqual(readFileSync(l.file), before);
    assert.equal(l.spawned.length, 0);
  });

  test("hours <= 0 is BAD_OPTION and takes no lease", async () => {
    const l = lab();
    await assert.rejects(startEmulator({ env: l.env, hours: 0, report: l.report, deps: l.deps }), isCode("BAD_OPTION"));
    assert.equal(existsSync(l.file), false);
    assert.deepEqual(l.fake.calls(), []);
  });

  test("new lease, reuses a running target and makes the device predictable", async () => {
    const l = lab();
    const r = await startEmulator({ env: l.env, report: l.report, deps: l.deps });
    assert.equal(r.action, "new");
    assert.equal(r.serial, SERIAL);
    assert.equal(r.launched, false);
    assert.equal(r.owner, ME);
    assert.equal(r.android, "14");
    assert.equal(r.abilist, "x86_64,arm64-v8a");
    assert.equal(r.nativeBridge, "libndk_translation.so");
    assert.equal(l.spawned.length, 0);
    assert.ok(has(l, `LEASE new avd=${AVD} owner=${ME} until=`));
    assert.ok(has(l, `Emulator already running: ${SERIAL} (it stays running after emu-lab release)`));
    assert.ok(
      l.out.includes(
        `EMULATOR_READY serial=${SERIAL} android=14 abilist=x86_64,arm64-v8a native_bridge=libndk_translation.so owner=${ME}`,
      ),
    );
    const cmds = l.fake.commands();
    for (const c of [
      "shell settings put global window_animation_scale 0",
      "shell settings put global transition_animation_scale 0",
      "shell settings put global animator_duration_scale 0",
      "shell settings put system screen_off_timeout 1800000",
      "shell svc power stayon true",
      "shell settings put secure immersive_mode_confirmations confirmed",
      "shell input keyevent KEYCODE_WAKEUP",
      "shell wm dismiss-keyguard",
      "shell settings get global auto_time",
    ]) {
      assert.ok(cmds.includes(c), `missing ${c}`);
    }
    // Device commands go to the target serial.
    for (const args of l.fake.calls().filter((a) => a.includes("shell") && a.includes("settings"))) {
      assert.deepEqual(args.slice(0, 2), ["-s", SERIAL]);
    }
    assert.equal(cmds.some((c) => c.startsWith("shell cmd alarm set-time")), false, "no clock reset when auto_time is 1");
    const lease = await readLease(l.file);
    assert.equal(lease?.owner, ME);
    assert.equal(lease?.startedEmulator, false);
    assert.equal(lease?.expiresAt, r.expiresAt);
  });

  test("renews our own lease and says the emulator was started under it", async () => {
    const l = lab();
    await putLease(l, ME, { startedEmulator: true, emulatorPid: 99, installed: ["com.example.a"] });
    const before = await readLease(l.file);
    const r = await startEmulator({ env: l.env, hours: 8, report: l.report, deps: l.deps });
    assert.equal(r.action, "renewed");
    const after = await readLease(l.file);
    assert.equal(after?.acquiredAt, before?.acquiredAt);
    assert.deepEqual(after?.installed, ["com.example.a"]);
    assert.equal(after?.emulatorPid, 99);
    assert.notEqual(after?.expiresAt, before?.expiresAt);
    assert.ok(has(l, `Emulator already running: ${SERIAL} (started under this lease)`));
  });

  test("takes over another owner's expired lease", async () => {
    const l = lab();
    await putLease(l, OTHER, { expiresAt: formatLocalIso(new Date(Date.now() - 60_000)), startedEmulator: true, emulatorPid: 5 });
    const r = await startEmulator({ env: l.env, report: l.report, deps: l.deps });
    assert.equal(r.action, "takeover");
    assert.ok(has(l, "LEASE_TAKEOVER the lease of test:other ran out at"));
    const lease = await readLease(l.file);
    assert.equal(lease?.owner, ME);
    assert.equal(lease?.startedEmulator, false);
    assert.equal(lease?.emulatorPid, null);
  });

  test("OTHER_EMULATOR: refuses without touching the other AVD and gives the lease back", async () => {
    const l = lab({ device: { serial: "emulator-5556", avd: "personal" } });
    await assert.rejects(startEmulator({ env: l.env, report: l.report, deps: l.deps }), (e: unknown) => {
      assert.ok(isEmuError(e, "OTHER_EMULATOR"));
      assert.match((e as Error).message, /emulator-5556=personal/);
      return true;
    });
    for (const c of l.fake.commands()) assert.match(c, READ_ONLY);
    assert.equal(l.spawned.length, 0);
    assert.equal(existsSync(l.file), false);
    assert.ok(l.out.includes("LEASE given back (start failed)"));
  });

  test("waits for a running qemu to re-attach instead of launching", async () => {
    const l = lab({
      device: { extra: [{ match: "^devices$", stdout: "List of devices attached\r\n\r\n", times: 2 }] },
    });
    l.procs.list.push({ pid: 300, name: "qemu-system-x86_64", startTime: new Date(Date.now() - 60_000) });
    const r = await startEmulator({ env: l.env, report: l.report, deps: l.deps });
    assert.equal(r.launched, false);
    assert.equal(r.serial, SERIAL);
    assert.equal(l.spawned.length, 0);
  });

  test("launches the AVD: args, logs, lease records the qemu instance", async () => {
    const l = lab({ device: { running: false } });
    const r = await startEmulator({ env: l.env, report: l.report, deps: l.deps });
    assert.equal(r.launched, true);
    assert.equal(r.serial, SERIAL);
    assert.equal(l.spawned.length, 1);
    const s = l.spawned[0];
    const loc = resolveLocations({ env: l.env });
    assert.equal(s.exe, loc.emulator);
    assert.deepEqual(s.args, ["-avd", AVD, "-no-boot-anim", "-gpu", "host", "-no-audio"]);
    assert.equal(path.dirname(s.o.outFile), loc.emulatorLogDir);
    assert.match(path.basename(s.o.outFile), /^\d{8}-\d{6}\.out\.log$/);
    assert.match(path.basename(s.o.errFile), /^\d{8}-\d{6}\.err\.log$/);
    assert.equal(s.o.env?.ANDROID_SDK_ROOT, loc.sdkRoot);
    assert.equal(s.o.env?.ANDROID_AVD_HOME, loc.avdHome);
    const lease = await readLease(l.file);
    assert.equal(lease?.startedEmulator, true);
    assert.equal(lease?.emulatorPid, 7001);
    assert.equal(lease?.emulatorStartedAt, formatLocalIso(l.procs.list[0].startTime));
    assert.ok(has(l, `Starting ${AVD} (-avd ${AVD} -no-boot-anim -gpu host -no-audio) log=`));
  });

  test("launch options: headless, cold boot, audio; launcher pid when no qemu shows", async () => {
    const l = lab({ device: { running: false } });
    const launcherStart = new Date(Date.now() - 3000);
    l.onSpawn = () => {
      l.fake.setRules(deviceRules({ running: true }));
      l.procs.list.push({ pid: 7000, name: "emulator", startTime: launcherStart });
      return { pid: 7000, exited: () => false, exitCode: () => null };
    };
    await startEmulator({ env: l.env, headless: true, coldBoot: true, audio: true, report: l.report, deps: l.deps });
    assert.deepEqual(l.spawned[0].args, ["-avd", AVD, "-no-boot-anim", "-gpu", "host", "-no-window", "-no-snapshot-load"]);
    const lease = await readLease(l.file);
    assert.equal(lease?.emulatorPid, 7000);
    assert.equal(lease?.emulatorStartedAt, formatLocalIso(launcherStart));
  });

  test("EMULATOR_EXITED names the err log and keeps the lease of the launch", async () => {
    const l = lab({ device: { running: false } });
    l.onSpawn = () => ({ pid: 7000, exited: () => true, exitCode: () => 1 });
    await assert.rejects(startEmulator({ env: l.env, report: l.report, deps: l.deps }), (e: unknown) => {
      assert.ok(isEmuError(e, "EMULATOR_EXITED"));
      assert.ok((e as Error).message.includes(l.spawned[0].o.errFile));
      assert.match((e as Error).message, /exit 1/);
      return true;
    });
    const lease = await readLease(l.file);
    assert.equal(lease?.owner, ME);
    assert.equal(lease?.startedEmulator, true);
    assert.ok(l.out.includes("LEASE kept: this call launched the emulator; run emu-lab release to stop it"));
  });

  test("BOOT_TIMEOUT when the launched emulator never shows up (lease kept)", async () => {
    const l = lab({ device: { running: false } });
    l.onSpawn = () => ({ pid: 7000, exited: () => false, exitCode: () => null });
    await assert.rejects(
      startEmulator({ env: l.env, bootTimeoutSec: 0.3, report: l.report, deps: l.deps }),
      (e: unknown) => {
        assert.ok(isEmuError(e, "BOOT_TIMEOUT"));
        assert.match((e as Error).message, /did not show up in adb devices/);
        return true;
      },
    );
    assert.ok(existsSync(l.file));
    assert.ok(has(l, "LEASE kept"));
  });

  test("BOOT_TIMEOUT on a running target that does not finish booting gives a new lease back", async () => {
    const l = lab({ device: { bootCompleted: "0" } });
    await assert.rejects(
      startEmulator({ env: l.env, bootTimeoutSec: 0.3, report: l.report, deps: l.deps }),
      (e: unknown) => {
        assert.ok(isEmuError(e, "BOOT_TIMEOUT"));
        assert.match((e as Error).message, /did not finish booting/);
        return true;
      },
    );
    assert.equal(existsSync(l.file), false);
    assert.ok(l.out.includes("LEASE given back (start failed)"));
    assert.equal(l.fake.commands().some((c) => c.startsWith("shell settings put")), false);
  });

  test("NO_AVD gives a new lease back; a renewed lease stays", async () => {
    const l = lab({ device: { running: false }, avdIni: false });
    await assert.rejects(startEmulator({ env: l.env, report: l.report, deps: l.deps }), isCode("NO_AVD"));
    assert.equal(existsSync(l.file), false);
    assert.ok(l.out.includes("LEASE given back (start failed)"));

    const l2 = lab({ device: { running: false }, avdIni: false });
    await putLease(l2, ME);
    await assert.rejects(startEmulator({ env: l2.env, report: l2.report, deps: l2.deps }), isCode("NO_AVD"));
    assert.ok(existsSync(l2.file));
    assert.equal(l2.out.some((x) => x.startsWith("LEASE given back") || x.startsWith("LEASE kept")), false);
  });

  test("NO_EMULATOR_EXE when the SDK has no emulator", async () => {
    const l = lab({ device: { running: false }, emulatorExe: false });
    await assert.rejects(startEmulator({ env: l.env, report: l.report, deps: l.deps }), isCode("NO_EMULATOR_EXE"));
    assert.equal(l.spawned.length, 0);
    assert.equal(existsSync(l.file), false);
  });

  test("NO_ADB without an injected adb when the executable is missing", async () => {
    const l = lab();
    const env = { ...l.env, EMU_ADB: path.join(l.home, "missing", "adb.exe") };
    const deps = { ...l.deps, adbFactory: undefined };
    await assert.rejects(startEmulator({ env, report: l.report, deps }), isCode("NO_ADB"));
    assert.equal(existsSync(l.file), false);
  });

  test("waits for lingering emulator processes before launching", async () => {
    const l = lab({ device: { running: false } });
    l.procs.list.push({ pid: 50, name: "emulator", startTime: new Date(Date.now() - 30_000) });
    let lingerChecks = 0;
    const find = l.procs.find;
    l.deps.findProcesses = async (re) => {
      if (/emulator/.test(re.source)) {
        lingerChecks++;
        if (lingerChecks === 3) l.procs.list = l.procs.list.filter((p) => p.pid !== 50);
      }
      return find(re);
    };
    await startEmulator({ env: l.env, report: l.report, deps: l.deps });
    assert.ok(lingerChecks >= 3);
    assert.equal(l.spawned.length, 1);
  });

  test("TIME_RESET when auto_time is 0", async () => {
    const l = lab({ device: { autoTime: "0" } });
    await startEmulator({ env: l.env, report: l.report, deps: l.deps });
    assert.ok(has(l, "TIME_RESET"));
    const cmds = l.fake.commands();
    const setTime = cmds.findIndex((c) => /^shell cmd alarm set-time \d+$/.test(c));
    const autoOn = cmds.indexOf("shell settings put global auto_time 1");
    assert.ok(setTime >= 0 && autoOn > setTime);
    assert.ok(has(l, "TIME_TRAVEL before="));
  });
});

describe("renew", { concurrency: 4 }, () => {
  test("extends our own lease", async () => {
    const l = lab();
    await putLease(l, ME, { expiresAt: formatLocalIso(new Date(Date.now() - 1000)), installed: ["com.x"] });
    const lease = await renew({ env: l.env, hours: 2 });
    const until = new Date(lease.expiresAt.replace(/(\.\d{3})\d*/, "$1")).getTime();
    assert.ok(Math.abs(until - (Date.now() + 2 * HOUR)) < 10_000);
    assert.deepEqual((await readLease(l.file))?.installed, ["com.x"]);
    assert.deepEqual(l.fake.calls(), []);
  });

  test("NO_LEASE without a lease, NOT_OWNER on someone else's", async () => {
    const l = lab();
    await assert.rejects(renew({ env: l.env }), isCode("NO_LEASE"));
    await putLease(l, OTHER);
    await assert.rejects(renew({ env: l.env }), isCode("NOT_OWNER"));
  });
});

describe("releaseEmulator", { concurrency: 4 }, () => {
  test("LEASE_NONE: nothing to release, not an error, no device calls", async () => {
    const l = lab();
    const r = await releaseEmulator({ env: l.env, report: l.report, deps: l.deps });
    assert.equal(r.released, false);
    assert.equal(r.leaseOwner, null);
    assert.equal(r.stopped, "none");
    assert.ok(has(l, `LEASE_NONE AVD '${AVD}' has no lease (`));
    assert.deepEqual(l.fake.calls(), []);
  });

  test("BAD_OPTION combinations before anything else", async () => {
    const l = lab();
    await putLease(l, ME);
    const before = readFileSync(l.file);
    const bad: Parameters<typeof releaseEmulator>[0][] = [
      { stale: true, anyOwner: true, report: l.report },
      { stale: true, uninstall: true, report: l.report },
      { stale: true, keepRunning: true, report: l.report },
      { packages: ["com.a"], report: l.report },
    ];
    for (const o of bad) {
      await assert.rejects(releaseEmulator({ ...o, env: l.env, deps: l.deps }), isCode("BAD_OPTION"));
    }
    assert.deepEqual(readFileSync(l.file), before);
    assert.deepEqual(l.fake.calls(), []);
  });

  test("NOT_OWNER on another owner's lease, device untouched", async () => {
    const l = lab();
    await putLease(l, OTHER);
    await assert.rejects(releaseEmulator({ env: l.env, report: l.report, deps: l.deps }), (e: unknown) => {
      assert.ok(isEmuError(e, "NOT_OWNER"));
      assert.match(
        (e as Error).message,
        /^NOT_OWNER AVD 'unity-test' is leased by test:other, not by test:me\. Leave it: another session may still be testing\./,
      );
      return true;
    });
    assert.ok(existsSync(l.file));
    assert.deepEqual(l.fake.calls(), []);
  });

  test("--any-owner releases someone else's lease", async () => {
    const l = lab();
    await putLease(l, OTHER);
    const r = await releaseEmulator({ env: l.env, anyOwner: true, report: l.report, deps: l.deps });
    assert.equal(r.released, true);
    assert.equal(r.leaseOwner, OTHER);
    assert.equal(r.by, ME);
    assert.equal(r.stopped, "kept");
    assert.ok(l.out.includes(`RELEASED avd=${AVD} owner=${OTHER} by ${ME} (--any-owner)`));
    assert.equal(existsSync(l.file), false);
  });

  test("--stale drops an expired lease without device calls; NOT_STALE on a valid one", async () => {
    const l = lab();
    await putLease(l, OTHER);
    await assert.rejects(releaseEmulator({ env: l.env, stale: true, report: l.report, deps: l.deps }), isCode("NOT_STALE"));
    assert.ok(existsSync(l.file));

    const l2 = lab();
    await putLease(l2, OTHER, { expiresAt: formatLocalIso(new Date(Date.now() - 60_000)) });
    const r = await releaseEmulator({ env: l2.env, stale: true, report: l2.report, deps: l2.deps });
    assert.equal(r.released, true);
    assert.equal(existsSync(l2.file), false);
    assert.ok(has(l2, "RELEASED stale lease of test:other"));
    assert.deepEqual(l.fake.calls(), []);
    assert.deepEqual(l2.fake.calls(), []);
  });

  test("resets Firebase debug mode and FA log tags, keeps recorded apps", async () => {
    const l = lab({
      device: {
        props: { "debug.firebase.analytics.app": "com.example.emusmoke", "log.tag.FA": "VERBOSE", "log.tag.FA-SVC": "" },
      },
    });
    await putLease(l, ME, { installed: ["com.example.emusmoke"] });
    const r = await releaseEmulator({ env: l.env, report: l.report, deps: l.deps });
    const cmds = l.fake.commands();
    assert.ok(cmds.includes("shell setprop debug.firebase.analytics.app .none."));
    const tagCall = l.fake.calls().find((a) => a.at(-1) === "setprop log.tag.FA ''");
    assert.ok(tagCall, "log.tag.FA reset as one shell argument");
    assert.deepEqual(tagCall.slice(0, 3), ["-s", SERIAL, "shell"]);
    assert.equal(cmds.some((c) => c.includes("setprop log.tag.FA-SVC")), false);
    assert.deepEqual(r.resets, ["debug.firebase.analytics.app", "log.tag.FA"]);
    assert.ok(l.out.includes("RESET debug.firebase.analytics.app com.example.emusmoke -> .none."));
    assert.ok(has(l, "KEPT apps com.example.emusmoke with their data"));
    assert.deepEqual(r.kept, ["com.example.emusmoke"]);
    assert.equal(cmds.some((c) => c.startsWith("uninstall")), false);
    assert.equal(r.stopped, "kept");
    assert.ok(has(l, `KEPT_RUNNING emulator ${SERIAL} (it was already running when the lease was taken)`));
    assert.equal(existsSync(l.file), false);
    assert.ok(l.out.includes(`RELEASED avd=${AVD} owner=${ME}`));
  });

  test("Firebase already .none. is left alone; clock reset when auto_time is 0", async () => {
    const l = lab({ device: { autoTime: "0", props: { "debug.firebase.analytics.app": ".none." } } });
    await putLease(l, ME);
    const r = await releaseEmulator({ env: l.env, report: l.report, deps: l.deps });
    assert.deepEqual(r.resets, ["clock"]);
    assert.equal(l.fake.commands().some((c) => c.startsWith("shell setprop")), false);
    assert.ok(has(l, "TIME_RESET"));
    assert.ok(l.fake.commands().includes("shell settings put global auto_time 1"));
  });

  test("--uninstall removes the recorded apps", async () => {
    const l = lab({ device: { extra: [{ match: "^uninstall ", stdout: "Success\r\n" }] } });
    await putLease(l, ME, { installed: ["com.example.a", "com.example.b"] });
    const r = await releaseEmulator({ env: l.env, uninstall: true, report: l.report, deps: l.deps });
    const cmds = l.fake.commands();
    assert.ok(cmds.includes("uninstall com.example.a"));
    assert.ok(cmds.includes("uninstall com.example.b"));
    assert.deepEqual(r.uninstalled, ["com.example.a", "com.example.b"]);
    assert.deepEqual(r.kept, []);
    assert.ok(l.out.includes("UNINSTALL com.example.a Success"));
  });

  test("--uninstall --package removes only the named packages", async () => {
    const l = lab({
      device: {
        extra: [
          { match: "^uninstall com\\.example\\.c$", stdout: "Success\n" },
          { match: "^uninstall ", stdout: "Failure [DELETE_FAILED_INTERNAL_ERROR]\n" },
        ],
      },
    });
    await putLease(l, ME, { installed: ["com.example.a"] });
    const r = await releaseEmulator({
      env: l.env,
      uninstall: true,
      packages: ["com.example.c, com.example.d"],
      report: l.report,
      deps: l.deps,
    });
    const un = l.fake.commands().filter((c) => c.startsWith("uninstall"));
    assert.deepEqual(un, ["uninstall com.example.c", "uninstall com.example.d"]);
    assert.deepEqual(r.uninstalled, ["com.example.c"]);
    assert.deepEqual(r.kept, ["com.example.a"]);
  });

  test("--uninstall with nothing recorded says so", async () => {
    const l = lab();
    await putLease(l, ME);
    await releaseEmulator({ env: l.env, uninstall: true, report: l.report, deps: l.deps });
    assert.ok(has(l, "UNINSTALL nothing"));
  });

  test("stops the emulator this lease started when pid, name and start time match", async () => {
    const l = lab();
    const t = new Date(Date.now() - 600_000);
    await putLease(l, ME, { startedEmulator: true, emulatorPid: 4242, emulatorStartedAt: formatLocalIso(t) });
    l.procs.list.push({ pid: 4242, name: "qemu-system-x86_64", startTime: new Date(t.getTime() + 400) });
    l.procs.beforeInfo = () => {
      if (l.fake.commands().includes("emu kill")) l.procs.list = [];
    };
    const r = await releaseEmulator({ env: l.env, report: l.report, deps: l.deps });
    assert.equal(r.stopped, "stopped");
    const kill = l.fake.calls().find((a) => a.join(" ").endsWith("emu kill"));
    assert.deepEqual(kill, ["-s", SERIAL, "emu", "kill"]);
    assert.ok(l.out.includes(`STOPPED emulator ${SERIAL} (this lease started it)`));
    assert.equal(existsSync(l.file), false);
  });

  test("STOP_PENDING when the stopped emulator does not exit in time", async () => {
    const l = lab();
    const t = new Date(Date.now() - 600_000);
    await putLease(l, ME, { startedEmulator: true, emulatorPid: 4242, emulatorStartedAt: formatLocalIso(t) });
    l.procs.list.push({ pid: 4242, name: "qemu-system-x86_64", startTime: t });
    const r = await releaseEmulator({ env: l.env, report: l.report, deps: l.deps });
    assert.equal(r.stopped, "pending");
    assert.ok(l.fake.commands().includes("emu kill"));
    assert.ok(has(l, `STOP_PENDING emulator ${SERIAL}`));
    assert.equal(existsSync(l.file), false);
  });

  test("no emulatorStartedAt: the name match alone is enough (as PS)", async () => {
    const l = lab();
    await putLease(l, ME, { startedEmulator: true, emulatorPid: 4242, emulatorStartedAt: null });
    l.procs.list.push({ pid: 4242, name: "emulator", startTime: new Date(0) });
    l.procs.beforeInfo = () => {
      if (l.fake.commands().includes("emu kill")) l.procs.list = [];
    };
    const r = await releaseEmulator({ env: l.env, report: l.report, deps: l.deps });
    assert.equal(r.stopped, "stopped");
  });

  test("KEPT_RUNNING when the process is not the instance this lease started", async () => {
    const t = new Date(Date.now() - 600_000);
    const cases: { name: string; proc: ProcInfo | null; pid: number | null; startedAt?: string }[] = [
      { name: "start time differs", proc: { pid: 4242, name: "qemu-system-x86_64", startTime: new Date(t.getTime() + 5000) }, pid: 4242 },
      { name: "pid reused by another program", proc: { pid: 4242, name: "notepad", startTime: t }, pid: 4242 },
      { name: "process gone", proc: null, pid: 4242 },
      { name: "no pid recorded", proc: null, pid: null },
      // A corrupt or foreign start time is not "missing": the pid alone could be any reused emulator process.
      { name: "unreadable start time", proc: { pid: 4242, name: "qemu-system-x86_64", startTime: t }, pid: 4242, startedAt: "garbage" },
    ];
    for (const c of cases) {
      const l = lab();
      await putLease(l, ME, { startedEmulator: true, emulatorPid: c.pid, emulatorStartedAt: c.startedAt ?? formatLocalIso(t) });
      if (c.proc) l.procs.list.push(c.proc);
      const r = await releaseEmulator({ env: l.env, report: l.report, deps: l.deps });
      assert.equal(r.stopped, "not-ours", c.name);
      assert.equal(l.fake.commands().includes("emu kill"), false, c.name);
      assert.ok(has(l, `KEPT_RUNNING emulator ${SERIAL} is not the instance this lease started`), c.name);
      assert.equal(existsSync(l.file), false, c.name);
    }
  });

  test("a lease taken over while release runs: LEASE_CHANGED, no emu kill, the new lease is kept", async () => {
    const l = lab();
    const t = new Date(Date.now() - 600_000);
    await putLease(l, ME, { startedEmulator: true, emulatorPid: 4242, emulatorStartedAt: formatLocalIso(t) });
    l.procs.list.push({ pid: 4242, name: "qemu-system-x86_64", startTime: t });
    // A PowerShell session (it takes no lock) replaces the lease file while release is busy with the device.
    const theirs = leaseRecord(OTHER, { acquiredAt: formatLocalIso(new Date()) });
    l.procs.beforeInfo = () => writeFileSync(l.file, JSON.stringify(theirs, null, 2));
    await assert.rejects(releaseEmulator({ env: l.env, report: l.report, deps: l.deps }), isCode("LEASE_CHANGED"));
    assert.equal(l.fake.commands().includes("emu kill"), false);
    const cur = await readLease(l.file);
    assert.equal(cur?.owner, OTHER);
    assert.equal(cur?.acquiredAt, theirs.acquiredAt);
    assert.ok(!has(l, "RELEASED"));
  });

  test("a lease replaced before the delete is not deleted (LEASE_CHANGED)", async () => {
    // The auto_time check (the last device step before the delete) answers slowly; the file is replaced meanwhile.
    const l = lab({ device: { extra: [{ match: "^shell settings get global auto_time$", stdout: "1\n", delayMs: 400 }] } });
    await putLease(l, ME);
    const theirs = leaseRecord(OTHER, { acquiredAt: formatLocalIso(new Date()) });
    let replaced = false;
    const timer = setInterval(() => {
      if (!replaced && l.fake.commands().includes("shell settings get global auto_time")) {
        writeFileSync(l.file, JSON.stringify(theirs, null, 2));
        replaced = true;
      }
    }, 5);
    try {
      await assert.rejects(releaseEmulator({ env: l.env, report: l.report, deps: l.deps }), isCode("LEASE_CHANGED"));
    } finally {
      clearInterval(timer);
    }
    assert.ok(replaced);
    assert.equal((await readLease(l.file))?.owner, OTHER);
  });

  test("our own lease that ran out stays valid while release runs (no takeover midway), then it is deleted", async () => {
    const l = lab();
    const t = new Date(Date.now() - 600_000);
    await putLease(l, ME, {
      expiresAt: formatLocalIso(new Date(Date.now() - 60_000)),
      startedEmulator: true,
      emulatorPid: 4242,
      emulatorStartedAt: formatLocalIso(t),
    });
    l.procs.list.push({ pid: 4242, name: "qemu-system-x86_64", startTime: t });
    const seen: boolean[] = [];
    l.procs.beforeInfo = () => {
      seen.push(isLeaseValid(JSON.parse(readFileSync(l.file, "utf8")) as LeaseRecord));
      if (l.fake.commands().includes("emu kill")) l.procs.list = [];
    };
    const r = await releaseEmulator({ env: l.env, report: l.report, deps: l.deps });
    assert.equal(r.released, true);
    assert.equal(r.stopped, "stopped");
    assert.ok(seen.length > 0 && seen.every(Boolean), String(seen));
    assert.equal(existsSync(l.file), false);
  });

  test("the owner compares ignoring case (PowerShell -eq): release and status treat TEST:ME as test:me", async () => {
    const l = lab();
    await putLease(l, "TEST:ME");
    const s = await getStatus({ env: l.env, deps: l.deps });
    assert.equal(s.lease?.mine, true);
    const r = await releaseEmulator({ env: l.env, report: l.report, deps: l.deps });
    assert.equal(r.released, true);
    assert.ok(l.out.includes(`RELEASED avd=${AVD} owner=TEST:ME`), l.out.join("\n"));
  });

  test("--keep-running leaves an emulator this lease started", async () => {
    const l = lab();
    const t = new Date(Date.now() - 600_000);
    await putLease(l, ME, { startedEmulator: true, emulatorPid: 4242, emulatorStartedAt: formatLocalIso(t) });
    l.procs.list.push({ pid: 4242, name: "qemu-system-x86_64", startTime: t });
    const r = await releaseEmulator({ env: l.env, keepRunning: true, report: l.report, deps: l.deps });
    assert.equal(r.stopped, "kept");
    assert.equal(l.fake.commands().includes("emu kill"), false);
    assert.ok(l.out.includes(`KEPT_RUNNING emulator ${SERIAL} (--keep-running)`));
  });

  test("AVD not running: nothing reset, lease deleted", async () => {
    const l = lab({ device: { running: false } });
    await putLease(l, ME, { startedEmulator: true, emulatorPid: 4242, installed: ["com.example.a"] });
    const r = await releaseEmulator({ env: l.env, report: l.report, deps: l.deps });
    assert.equal(r.released, true);
    assert.equal(r.stopped, "not-running");
    assert.deepEqual(r.kept, ["com.example.a"]);
    for (const c of l.fake.commands()) assert.match(c, READ_ONLY);
    assert.ok(has(l, `EMULATOR_NOT_RUNNING AVD '${AVD}'`));
    assert.equal(existsSync(l.file), false);
  });
});

describe("getStatus", { concurrency: 4 }, () => {
  test("reports lease, emulators and boot state and changes nothing", async () => {
    const l = lab();
    await putLease(l, ME, { startedEmulator: true, emulatorPid: 4242 });
    const before = readFileSync(l.file);
    const s = await getStatus({ env: l.env, deps: l.deps });
    assert.deepEqual(readFileSync(l.file), before);
    assert.equal(s.avd, AVD);
    assert.equal(s.owner, ME);
    assert.equal(s.lease?.owner, ME);
    assert.equal(s.lease?.valid, true);
    assert.equal(s.lease?.mine, true);
    assert.equal(s.serial, SERIAL);
    assert.equal(s.bootCompleted, true);
    assert.deepEqual(s.emulators, [{ serial: SERIAL, avd: AVD }]);
    assert.match(s.adbVersion ?? "", /^Android Debug Bridge version 1\.0\.41; Installed as /);
    assert.equal(s.leaseFile, l.file);
    assert.equal(s.paths.labHome, l.home);
    assert.ok(l.fake.commands().length > 0);
    for (const c of l.fake.commands()) assert.match(c, READ_ONLY);
  });

  test("another owner's expired lease, no emulator", async () => {
    const l = lab({ device: { running: false } });
    await putLease(l, OTHER, { expiresAt: formatLocalIso(new Date(Date.now() - 1000)) });
    const before = readFileSync(l.file);
    const s = await getStatus({ env: l.env, deps: l.deps });
    assert.deepEqual(readFileSync(l.file), before);
    assert.equal(s.lease?.valid, false);
    assert.equal(s.lease?.mine, false);
    assert.equal(s.serial, null);
    assert.equal(s.bootCompleted, null);
    assert.deepEqual(s.emulators, []);
  });

  test("missing adb is not an error: no emulators, no version", async () => {
    const l = lab();
    const env = { ...l.env, EMU_ADB: path.join(l.home, "missing", "adb.exe") };
    const s = await getStatus({ env, deps: { ...l.deps, adbFactory: undefined } });
    assert.equal(s.lease, null);
    assert.equal(s.adbVersion, null);
    assert.deepEqual(s.emulators, []);
    assert.equal(s.paths.adbSource, "env EMU_ADB");
    assert.equal(existsSync(l.file), false);
  });
});

describe("releaseEmulator: the hold", { concurrency: 4 }, () => {
  test("acts on the record the hold returns: an update between the first read and the hold is not lost", async () => {
    const l = lab({
      device: {
        extra: [
          // Finding the serial answers slowly; the lease file is updated by this owner meanwhile.
          { match: "^devices$", stdout: `List of devices attached\r\n${SERIAL}\tdevice\r\n\r\n`, delayMs: 300, times: 1 },
          { match: "^uninstall ", stdout: "Success\r\n" },
        ],
      },
    });
    await putLease(l, ME, { installed: ["com.example.a"] });
    let updated: Promise<boolean> | null = null;
    const timer = setInterval(() => {
      if (!updated && l.fake.commands().includes("devices")) {
        updated = updateLease(l.file, ME, { installed: ["com.example.a", "com.example.late"] });
      }
    }, 5);
    let r;
    try {
      r = await releaseEmulator({ env: l.env, uninstall: true, report: l.report, deps: l.deps });
    } finally {
      clearInterval(timer);
    }
    assert.ok(updated);
    assert.equal(await updated, true);
    assert.deepEqual(r.uninstalled, ["com.example.a", "com.example.late"]);
    assert.ok(l.fake.commands().includes("uninstall com.example.late"));
    assert.equal(existsSync(l.file), false);
  });

  test("adb missing (a step before any device change): an expired own lease is not extended", async () => {
    const l = lab();
    const expiresAt = formatLocalIso(new Date(Date.now() - 60_000));
    await putLease(l, ME, { expiresAt });
    const env = { ...l.env, EMU_ADB: path.join(l.home, "missing", "adb.exe") };
    await assert.rejects(releaseEmulator({ env, report: l.report, deps: { ...l.deps, adbFactory: undefined } }), isCode("NO_ADB"));
    const cur = await readLease(l.file);
    assert.equal(cur?.expiresAt, expiresAt);
    assert.equal(isLeaseValid(cur), false);
  });

  test("a failure after the hold gives the hold back: the expired lease runs out again, nothing deleted", async () => {
    const l = lab();
    const expiresAt = formatLocalIso(new Date(Date.now() - 60_000));
    await putLease(l, ME, { expiresAt, startedEmulator: true, emulatorPid: 4242 });
    const validDuring: boolean[] = [];
    l.deps.getProcessInfo = async () => {
      validDuring.push(isLeaseValid(await readLease(l.file)));
      throw new Error("process list failed");
    };
    await assert.rejects(releaseEmulator({ env: l.env, report: l.report, deps: l.deps }), /process list failed/);
    assert.deepEqual(validDuring, [true]); // held while release ran
    const cur = await readLease(l.file);
    assert.equal(cur?.expiresAt, expiresAt);
    assert.ok(has(l, "LEASE hold given back (release failed)"), l.out.join("\n"));
    assert.ok(!has(l, "RELEASED"));
  });

  test("a renewal between the first read and the hold survives a failed release (not shortened to the old expiry)", async () => {
    const l = lab({
      device: {
        extra: [{ match: "^devices$", stdout: `List of devices attached\r\n${SERIAL}\tdevice\r\n\r\n`, delayMs: 300, times: 1 }],
      },
    });
    const expiresAt = formatLocalIso(new Date(Date.now() - 60_000));
    await putLease(l, ME, { expiresAt, startedEmulator: true, emulatorPid: 4242 });
    // The same owner renews for 4 h while release is finding the serial (after its first read, before the hold).
    let renewed: Promise<LeaseRecord> | null = null;
    const timer = setInterval(() => {
      if (!renewed && l.fake.commands().includes("devices")) {
        renewed = renewLease({ path: l.file, avd: AVD, owner: ME, hours: 4 });
      }
    }, 5);
    l.deps.getProcessInfo = async () => {
      throw new Error("process list failed");
    };
    try {
      await assert.rejects(releaseEmulator({ env: l.env, report: l.report, deps: l.deps }), /process list failed/);
    } finally {
      clearInterval(timer);
    }
    const pending = renewed as Promise<LeaseRecord> | null;
    assert.ok(pending, "the renewal ran while release was finding the serial");
    const after = await pending;
    const cur = await readLease(l.file);
    assert.equal(cur?.expiresAt, after.expiresAt);
    assert.ok(isLeaseValid(cur, new Date(Date.now() + 3 * HOUR)));
    assert.ok(!has(l, "LEASE hold given back"), l.out.join("\n"));
  });

  test("a valid lease with a longer expiry is not changed by the hold (nothing to give back)", async () => {
    const l = lab();
    await putLease(l, ME, { startedEmulator: true, emulatorPid: 4242 });
    const before = (await readLease(l.file))?.expiresAt;
    l.deps.getProcessInfo = async () => {
      throw new Error("process list failed");
    };
    await assert.rejects(releaseEmulator({ env: l.env, report: l.report, deps: l.deps }), /process list failed/);
    assert.equal((await readLease(l.file))?.expiresAt, before);
    assert.ok(!has(l, "LEASE hold given back"));
  });
});

// Changes the process-wide clock registry: one test, after the suites above.
describe("releaseEmulator forgets the clocks moved under the lease it gives back", () => {
  test("a later shutdown no longer resets that serial", async () => {
    resetClockRegistry();
    try {
      const l = lab();
      await putLease(l, ME);
      // The fake clock never moves (CLOCK_FAILED), but the serial is remembered from auto_time 0 on.
      await assert.rejects(
        timeTravel(l.fake.adb.withSerial(SERIAL), 30, () => {}, { timing: FAST.clock, target: { avd: AVD, leaseFile: l.file, owner: ME } }),
        isCode("CLOCK_FAILED"),
      );
      assert.deepEqual(movedClockSerials(), [SERIAL]);
      const r = await releaseEmulator({ env: l.env, report: l.report, deps: l.deps });
      assert.equal(r.released, true);
      assert.deepEqual(movedClockSerials(), []);
    } finally {
      resetClockRegistry();
    }
  });
});
