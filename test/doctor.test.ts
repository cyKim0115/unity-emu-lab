// emu-lab doctor (src/doctor.ts) with faked host probes: emulator acceleration per OS (KVM, Hypervisor.framework,
// WHPX/AEHD), the -gpu mode, Unity modules, the project checks, the Android SDK and AVD, disk and browser. Nothing here
// reads the real hypervisor, registry, Unity installs, processes or browser.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hostAbi, parseAccelCheck, runDoctor, type DoctorProbes, type DoctorResult } from "../src/doctor.ts";
import type { UnityInstall } from "../src/unity.ts";
import { playbackEnginesDir, unityExeIn } from "../src/unity.ts";
import { tempLabHome } from "./helpers/fake.ts";

const HOST = process.platform;
const EXE = HOST === "win32" ? ".exe" : "";
const BAT = HOST === "win32" ? ".bat" : "";

function fakeEditor(dir: string, version: string, modules: string[]): UnityInstall {
  const root = path.join(dir, version);
  mkdirSync(path.dirname(unityExeIn(root)), { recursive: true });
  writeFileSync(unityExeIn(root), "");
  for (const m of modules) {
    const f = path.join(playbackEnginesDir(root), m);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, "");
  }
  return { version, root, exe: unityExeIn(root), source: "UNITY_EDITOR_ROOT", shadowed: false, usedRoot: root };
}

const FULL_ANDROID = [
  `AndroidPlayer/OpenJDK/bin/java${EXE}`,
  `AndroidPlayer/SDK/cmdline-tools/16.0/bin/sdkmanager${BAT}`,
  `AndroidPlayer/SDK/build-tools/36.0.0/aapt2${EXE}`,
  "AndroidPlayer/NDK/source.properties",
];

interface Env {
  env: NodeJS.ProcessEnv;
  sdk: string;
  avd: string;
  home: string;
}

function labEnv(): Env {
  const home = tempLabHome();
  const sdk = path.join(home, "sdk");
  const avd = path.join(home, "avd");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, EMU_LAB_HOME: path.join(home, "lab"), ANDROID_SDK_ROOT: sdk, ANDROID_AVD_HOME: avd };
  return { env, sdk, avd, home };
}

/** A complete SDK + AVD for the given image ABI; adb and the emulator under both names, for tests that act as another OS. */
function installSdk(e: Env, abi = "x86_64"): void {
  const files = ["platform-tools/adb", "platform-tools/adb.exe", "emulator/emulator", "emulator/emulator.exe", `system-images/android-35/google_apis/${abi}/system.img`];
  for (const f of files) {
    mkdirSync(path.dirname(path.join(e.sdk, f)), { recursive: true });
    writeFileSync(path.join(e.sdk, f), "");
  }
  mkdirSync(path.join(e.avd, "unity-test.avd"), { recursive: true });
  writeFileSync(path.join(e.avd, "unity-test.ini"), "path=x\n");
  writeFileSync(path.join(e.avd, "unity-test.avd", "config.ini"), `abi.type=${abi}\n`);
}

function probes(o: Partial<DoctorProbes> = {}): Partial<DoctorProbes> {
  return {
    platform: HOST,
    arch: "x64",
    totalMemBytes: 32 * 1024 ** 3,
    osText: "TestOS",
    accelCheck: async () => "accel:\n0\nKVM (version 12) is installed and usable.\naccel\n",
    kvm: () => ({ exists: true, access: true }),
    macHvSupport: async () => "1",
    winVirtualization: async () => ({ hypervisorPresent: true, firmwareEnabled: true }),
    hasRenderNode: () => true,
    installs: () => [],
    externalTools: async () => ({ jdk: null, sdk: null, ndk: null }),
    lock: { isLocked: async () => false, processes: async () => [] },
    browser: () => ({ path: "/fake/chrome", source: "default location" }),
    freeBytes: () => 500 * 1024 ** 3,
    vsCpp: async () => "C:\\VS",
    packagedHost: () => null,
    gitState: async () => ({ inGit: true, changed: 0, snapshot: false }),
    ...o,
  };
}

async function doctor(e: Env, o: { target?: "Android" | "WebGL" | "Windows" | "Both"; projectPath?: string; p?: Partial<DoctorProbes> } = {}): Promise<DoctorResult & { text: string }> {
  const out: string[] = [];
  const r = await runDoctor({ target: o.target ?? "Android", projectPath: o.projectPath, env: e.env, report: (l) => out.push(l), probes: probes(o.p) });
  return { ...r, text: out.join("\n") };
}

function line(r: DoctorResult, key: string): { status: string; message: string } {
  const l = r.lines.find((x) => x.key === key);
  assert.ok(l, `no ${key} line in ${r.lines.map((x) => x.key).join(", ")}`);
  return l;
}

describe("parsers", () => {
  test("emulator -accel-check on Windows, Linux and macOS", () => {
    assert.deepEqual(parseAccelCheck("accel:\r\n0\r\nWHPX(10.0.19045) is installed and usable.\r\naccel\r\n"), { ok: true, message: "WHPX(10.0.19045) is installed and usable." });
    assert.deepEqual(parseAccelCheck("accel:\n0\nKVM (version 12) is installed and usable.\naccel\n"), { ok: true, message: "KVM (version 12) is installed and usable." });
    assert.deepEqual(parseAccelCheck("accel:\n0\nHypervisor.Framework OS X Version 14.5\naccel\n"), { ok: true, message: "Hypervisor.Framework OS X Version 14.5" });
    assert.deepEqual(parseAccelCheck("accel:\n6\nAndroid Emulator hypervisor driver is not installed on this machine\naccel\n"), {
      ok: false,
      message: "Android Emulator hypervisor driver is not installed on this machine",
    });
    assert.deepEqual(parseAccelCheck("accel:\n9\n/dev/kvm is not found: VT disabled in BIOS or KVM kernel module not loaded\naccel"), {
      ok: false,
      message: "/dev/kvm is not found: VT disabled in BIOS or KVM kernel module not loaded",
    });
    assert.equal(parseAccelCheck(""), null);
  });

  test("host ABI", () => {
    assert.equal(hostAbi("x64"), "x86_64");
    assert.equal(hostAbi("arm64"), "arm64-v8a");
    assert.equal(hostAbi("ia32"), null);
  });
});

describe("emulator acceleration per host OS", () => {
  test("with the emulator installed its -accel-check decides; ready host = exit 0", async () => {
    const e = labEnv();
    installSdk(e);
    const ed = fakeEditor(path.join(e.home, "eds"), "6000.6.0f1", FULL_ANDROID);
    const r = await doctor(e, { p: { installs: () => [ed] } });
    assert.equal(line(r, "emulator-accel").status, "OK");
    assert.equal(r.exit_code, 0, r.text);
    assert.match(r.text, /DOCTOR READY human\/fail=0 todo=0/);
  });

  test("-accel-check says no: HUMAN with the advice for the host OS", async () => {
    const e = labEnv();
    installSdk(e);
    const no = async () => "accel:\n6\nAndroid Emulator hypervisor driver is not installed on this machine\naccel\n";
    // Acting as Windows needs Windows paths (the SDK files are found through backslash-joined paths).
    if (HOST === "win32") {
      const winR = await doctor(e, { p: { platform: "win32", accelCheck: no, winVirtualization: async () => ({ hypervisorPresent: false, firmwareEnabled: true }) } });
      assert.equal(line(winR, "emulator-accel").status, "HUMAN");
      assert.match(line(winR, "emulator-accel").message, /CPU virtualization is already on: enable the Windows feature "Windows Hypervisor Platform"/);
    }
    const linR = await doctor(e, { p: { platform: "linux", accelCheck: no, kvm: () => ({ exists: true, access: false }) } });
    assert.match(line(linR, "emulator-accel").message, /usermod -aG kvm/);
    assert.equal(linR.exit_code, 1);
  });

  test("before the SDK: Linux /dev/kvm, macOS kern.hv_support, Windows firmware flags", async () => {
    const e = labEnv();
    const noKvm = await doctor(e, { p: { platform: "linux", kvm: () => ({ exists: false, access: false }) } });
    assert.equal(line(noKvm, "emulator-accel").status, "HUMAN");
    assert.match(line(noKvm, "emulator-accel").message, /KVM is missing: turn on Intel VT-x \/ AMD-V/);
    const okKvm = await doctor(e, { p: { platform: "linux" } });
    assert.equal(line(okKvm, "emulator-accel").status, "INFO");
    const macNo = await doctor(e, { p: { platform: "darwin", macHvSupport: async () => "0" } });
    assert.equal(line(macNo, "emulator-accel").status, "HUMAN");
    const macYes = await doctor(e, { p: { platform: "darwin", macHvSupport: async () => "1" } });
    assert.match(line(macYes, "emulator-accel").message, /kern\.hv_support=1/);
    const winOff = await doctor(e, { p: { platform: "win32", winVirtualization: async () => ({ hypervisorPresent: false, firmwareEnabled: false }) } });
    assert.equal(line(winOff, "emulator-accel").status, "HUMAN");
  });

  test("the -gpu mode start would use: SwiftShader on a Linux host without a display", async () => {
    const e = labEnv();
    const lin = await doctor(e, { p: { platform: "linux" } });
    assert.match(line(lin, "emulator-gpu").message, /-gpu swiftshader_indirect \(no display/);
    e.env.DISPLAY = ":0";
    const linDisplay = await doctor(e, { p: { platform: "linux" } });
    assert.match(line(linDisplay, "emulator-gpu").message, /-gpu host/);
    const mac = await doctor(e, { p: { platform: "darwin" } });
    assert.match(line(mac, "emulator-gpu").message, /-gpu host/);
  });

  test("hosts: Windows on ARM fails Android; Apple silicon needs arm64 images; Linux ARM64 warns", async () => {
    const e = labEnv();
    const woa = await doctor(e, { p: { platform: "win32", arch: "arm64" } });
    assert.equal(line(woa, "android-host").status, "FAIL");
    assert.ok(!woa.lines.some((l) => l.key === "emulator-accel"), "no acceleration check for an unsupported host");
    const mac = await doctor(e, { p: { platform: "darwin", arch: "arm64" } });
    assert.match(line(mac, "android-host").message, /arm64-v8a system image/);
    const lin = await doctor(e, { p: { platform: "linux", arch: "arm64" } });
    assert.equal(line(lin, "android-host").status, "WARN");
  });
});

describe("Android SDK and AVD", () => {
  test("missing parts: TODO when an sdkmanager is at hand (Unity's), HUMAN without one on macOS/Linux", async () => {
    const e = labEnv();
    const ed = fakeEditor(path.join(e.home, "eds"), "6000.6.0f1", FULL_ANDROID);
    const withTool = await doctor(e, { p: { installs: () => [ed] } });
    assert.equal(line(withTool, "android-sdk").status, "TODO");
    assert.match(line(withTool, "android-sdk").message, /sdkmanager/);
    assert.match(line(withTool, "android-sdk").message, /after the person agrees to the Android SDK license/);
    assert.equal(withTool.exit_code, 2, withTool.text);
    if (HOST !== "win32") {
      const bare = await doctor(e, { p: { installs: () => [] } });
      assert.equal(line(bare, "android-sdk").status, "HUMAN");
    }
  });

  test("an AVD whose image ABI does not fit the host CPU is flagged", async () => {
    const e = labEnv();
    installSdk(e, "x86_64");
    const r = await doctor(e, { p: { arch: "arm64", platform: HOST === "win32" ? "darwin" : HOST } });
    assert.equal(line(r, "avd-abi").status, "WARN");
    assert.match(line(r, "avd-abi").message, /x86_64 system image.*arm64-v8a/);
  });
});

describe("Unity and the project", () => {
  function project(e: Env, version: string, settings = ""): string {
    const p = path.join(e.home, "My Game");
    mkdirSync(path.join(p, "ProjectSettings"), { recursive: true });
    writeFileSync(path.join(p, "ProjectSettings", "ProjectVersion.txt"), `m_EditorVersion: ${version}\n`);
    writeFileSync(path.join(p, "ProjectSettings", "ProjectSettings.asset"), settings);
    return p;
  }

  test("no editor: HUMAN unity; an editor without the modules for the target: HUMAN project-modules", async () => {
    const e = labEnv();
    installSdk(e);
    const none = await doctor(e, { target: "WebGL" });
    assert.equal(line(none, "unity").status, "HUMAN");
    const ed = fakeEditor(path.join(e.home, "eds"), "6000.6.0f1", ["WindowsStandaloneSupport/Variations/win64_player_development_mono/x"]);
    const p = project(e, "6000.6.0f1");
    const r = await doctor(e, { target: "WebGL", projectPath: p, p: { installs: () => [ed] } });
    assert.equal(line(r, "project-unity").status, "OK");
    assert.match(line(r, "project-modules").message, /WebGL Build Support/);
  });

  test("project not installed, open in an Editor, git state and guard snapshot, Mono ABI", async () => {
    const e = labEnv();
    installSdk(e);
    const ed = fakeEditor(path.join(e.home, "eds"), "6000.6.0f1", FULL_ANDROID);
    const missing = await doctor(e, { projectPath: project(e, "6000.9.9f9"), p: { installs: () => [ed] } });
    assert.equal(line(missing, "project-unity").status, "FAIL");
    assert.match(line(missing, "project-unity").message, /Unity 6000\.9\.9f9 is not installed/);

    const p = project(e, "6000.6.0f1", "  scriptingBackend:\n    Android: 0\n");
    const r = await doctor(e, {
      projectPath: p,
      p: {
        installs: () => [ed],
        lock: { isLocked: async () => true, processes: async () => [{ pid: 42, ppid: 1, batchmode: false, worker: false, commandLine: "" }] },
        gitState: async () => ({ inGit: true, changed: 3, snapshot: false }),
      },
    });
    assert.match(line(r, "project-open").message, /Unity Editor \(pid 42\)/);
    assert.match(line(r, "project-vcs").message, /3 uncommitted path\(s\).*guard snapshot/);
    assert.match(line(r, "project-guard").message, /no guard snapshot yet/);
    assert.equal(line(r, "project-abi").status, "TODO");
    const g = await doctor(e, { projectPath: p, p: { installs: () => [ed], gitState: async () => ({ inGit: false, why: "no-git-on-path", gitAt: p }) } });
    assert.equal(line(g, "project-vcs").status, "HUMAN");
  });

  test("Windows target: IL2CPP fails on a non-Windows host, needs Visual Studio C++ on Windows", async () => {
    const e = labEnv();
    const ed = fakeEditor(path.join(e.home, "eds"), "6000.6.0f1", [
      "WindowsStandaloneSupport/Variations/win64_player_development_mono/x",
      "WindowsStandaloneSupport/Variations/win64_player_development_il2cpp/x",
    ]);
    const p = project(e, "6000.6.0f1", "  scriptingBackend:\n    Standalone: 1\n");
    const lin = await doctor(e, { target: "Windows", projectPath: p, p: { platform: HOST === "win32" ? "linux" : HOST, installs: () => [ed] } });
    if (HOST !== "win32") {
      assert.ok(lin.lines.some((l) => l.key === "project-windows" && l.status === "FAIL"), lin.text);
      assert.match(line(lin, "windows-desktop").message, /runs only on a Windows desktop/);
    }
    if (HOST === "win32") {
      const noVs = await doctor(e, { target: "Windows", projectPath: p, p: { installs: () => [ed], vsCpp: async () => null } });
      assert.equal(line(noVs, "windows-il2cpp-cpp").status, "HUMAN");
    }
  });

  test("the lab home inside the project is a FAIL", async () => {
    const e = labEnv();
    const p = project(e, "6000.6.0f1");
    e.env.EMU_LAB_HOME = path.join(p, ".emu-lab");
    const r = await doctor(e, { target: "WebGL", projectPath: p });
    assert.ok(r.lines.some((l) => l.key === "lab-location" && l.status === "FAIL"), r.text);
  });
});

describe("browser, disk, verdict", () => {
  test("WebGL without a browser fails; low disk fails; exit 1", async () => {
    const e = labEnv();
    const r = await doctor(e, { target: "WebGL", p: { browser: () => null, freeBytes: () => 1024 ** 3 } });
    assert.equal(line(r, "browser").status, "FAIL");
    assert.equal(line(r, "disk").status, "FAIL");
    assert.equal(r.verdict, "BLOCKED");
    assert.equal(r.exit_code, 1);
  });
});
