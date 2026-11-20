// The lease file must work both ways with scripts/common.ps1 (Windows PowerShell 5.1). Windows only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLocations } from "../src/config.ts";
import { isEmuError } from "../src/errors.ts";
import { enterLease, formatLocalIso, leasePath, parseLeaseDate, readLease, renewLease, updateLease, assertLeaseUsable } from "../src/lease.ts";
import { silent } from "../src/types.ts";

const skip = process.platform !== "win32" ? "PowerShell interop runs on Windows only" : false;
const COMMON_PS1 = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "common.ps1");
const AVD = "interop-avd";

interface PsResult {
  code: number;
  out: string;
}

/** Dot-source common.ps1 and run `body`. Single quotes only in `body`. Prints ERR:<message> when it throws. */
function runPs(labHome: string, owner: string, body: string): Promise<PsResult> {
  const script =
    `$ErrorActionPreference = 'Stop'; . '${COMMON_PS1.replace(/'/g, "''")}'; ` +
    `try { ${body} } catch { Write-Output ('ERR:' + $_.Exception.Message); exit 3 }`;
  const env: NodeJS.ProcessEnv = { ...process.env, EMU_LAB_HOME: labHome, EMU_OWNER: owner, EMU_AVD: AVD };
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { env, timeout: 60_000, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : -1) : 0;
        if (code === -1) return reject(new Error(`powershell failed: ${err?.message}\n${stderr}`));
        resolve({ code, out: String(stdout) + String(stderr) });
      },
    );
  });
}

function setup(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "emu-lab-interop-"));
  const loc = resolveLocations({ env: { EMU_LAB_HOME: dir } });
  return { dir, file: leasePath(loc, AVD), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("PS Enter-EmuLease creates a lease: Node sees BUSY and parses it", { skip }, async () => {
  const { dir, file, cleanup } = setup();
  try {
    const ps = await runPs(dir, "ps-owner", `$r = Enter-EmuLease -Owner (Get-EmuOwner) -Hours 2 -Avd '${AVD}'; Write-Output ('ACTION=' + $r.Action)`);
    assert.equal(ps.code, 0, ps.out);
    assert.match(ps.out, /ACTION=new/);

    const lease = await readLease(file);
    assert.ok(lease);
    assert.equal(lease.owner, "ps-owner");
    assert.equal(lease.avd, AVD);
    assert.deepEqual(lease.installed, []);
    assert.equal(lease.startedEmulator, false);
    assert.equal(lease.emulatorPid, null);
    assert.match(lease.expiresAt, /\.\d{7}[+-]\d{2}:\d{2}$/, "PS writes 7 fraction digits");
    const acquired = parseLeaseDate(lease.acquiredAt);
    const expires = parseLeaseDate(lease.expiresAt);
    assert.ok(acquired && expires);
    assert.ok(Math.abs(Date.now() - acquired.getTime()) < 120_000);
    assert.ok(Math.abs(expires.getTime() - acquired.getTime() - 2 * 3_600_000) < 1000);

    await assert.rejects(
      enterLease({ path: file, avd: AVD, owner: "node-owner", hours: 1, host: "H", report: silent }),
      (err: unknown) => {
        assert.ok(isEmuError(err, "BUSY"));
        assert.match(err.message, /^BUSY: AVD 'interop-avd' is leased by ps-owner /);
        return true;
      },
    );
    await assert.rejects(assertLeaseUsable({ path: file, avd: AVD, owner: "node-owner", mode: "warn", report: silent }), (e: unknown) => isEmuError(e, "BUSY"));
  } finally {
    cleanup();
  }
});

test("Node creates a lease: PS Enter-EmuLease and Assert-EmuLeaseUsable of another owner throw BUSY", { skip }, async () => {
  const { dir, file, cleanup } = setup();
  try {
    await enterLease({ path: file, avd: AVD, owner: "node-owner", hours: 1, host: "NODEHOST", report: silent });
    const enter = await runPs(dir, "ps-owner", `$r = Enter-EmuLease -Owner (Get-EmuOwner) -Hours 1 -Avd '${AVD}'; Write-Output 'TOOK'`);
    assert.equal(enter.code, 3, enter.out);
    assert.match(enter.out, /ERR:BUSY: AVD 'interop-avd' is leased by node-owner \(host NODEHOST,/);
    assert.doesNotMatch(enter.out, /TOOK/);

    const usable = await runPs(dir, "ps-owner", `$l = Assert-EmuLeaseUsable '${AVD}'; Write-Output 'USABLE'`);
    assert.equal(usable.code, 3, usable.out);
    assert.match(usable.out, /ERR:BUSY:/);

    // The owner itself may use it from PowerShell.
    const own = await runPs(dir, "node-owner", `$l = Assert-EmuLeaseUsable '${AVD}'; Write-Output ('OWNER=' + $l.owner)`);
    assert.equal(own.code, 0, own.out);
    assert.match(own.out, /OWNER=node-owner/);
    assert.equal((await readLease(file))?.owner, "node-owner");
  } finally {
    cleanup();
  }
});

test("PS renew of a Node-written lease keeps unknown fields and installed", { skip }, async () => {
  const { dir, file, cleanup } = setup();
  try {
    const first = await enterLease({ path: file, avd: AVD, owner: "same", hours: 1, host: "NODEHOST", report: silent });
    assert.ok(await updateLease(file, "same", { installed: ["com.example.one", "com.example.two"], note: "keep me", emulatorPid: 4242 }));
    const single = await runPs(dir, "same", `$r = Enter-EmuLease -Owner (Get-EmuOwner) -Hours 3 -Avd '${AVD}'; Write-Output ('ACTION=' + $r.Action)`);
    assert.equal(single.code, 0, single.out);
    assert.match(single.out, /ACTION=renewed/);

    const lease = await readLease(file);
    assert.ok(lease);
    assert.equal(lease.note, "keep me");
    assert.deepEqual(lease.installed, ["com.example.one", "com.example.two"]);
    assert.equal(lease.emulatorPid, 4242);
    assert.equal(lease.host, "NODEHOST");
    assert.equal(lease.acquiredAt, first.lease.acquiredAt);
    const expires = parseLeaseDate(lease.expiresAt);
    assert.ok(expires && expires.getTime() - Date.now() > 2.5 * 3_600_000);

    // One installed package goes through PS as well (Add-EmuLeaseInstalled appends to our lease).
    await updateLease(file, "same", { installed: ["com.example.one"] });
    const add = await runPs(dir, "same", `Add-EmuLeaseInstalled 'com.example.ps' '${AVD}'; Write-Output 'ADDED'`);
    assert.equal(add.code, 0, add.out);
    assert.deepEqual((await readLease(file))?.installed, ["com.example.one", "com.example.ps"]);
    assert.ok(!readFileSync(file).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), "PS writes UTF-8 without BOM");
  } finally {
    cleanup();
  }
});

test("Node renew of a PS lease", { skip }, async () => {
  const { dir, file, cleanup } = setup();
  try {
    const ps = await runPs(dir, "same", `$r = Enter-EmuLease -Owner (Get-EmuOwner) -Hours 1 -Avd '${AVD}'; Write-Output ('ACTION=' + $r.Action)`);
    assert.equal(ps.code, 0, ps.out);
    const before = await readLease(file);
    assert.ok(before);

    await assert.rejects(renewLease({ path: file, avd: AVD, owner: "other", hours: 1 }), (e: unknown) => isEmuError(e, "NOT_OWNER"));
    const renewed = await renewLease({ path: file, avd: AVD, owner: "same", hours: 5 });
    assert.equal(renewed.acquiredAt, before.acquiredAt, "the PS 7-digit acquiredAt is kept as written");
    assert.equal(renewed.host, before.host);
    const expires = parseLeaseDate(renewed.expiresAt);
    assert.ok(expires && expires.getTime() - Date.now() > 4.5 * 3_600_000);

    // PS reads the renewed lease back as valid and its own.
    const check = await runPs(dir, "same", `$l = Assert-EmuLeaseUsable '${AVD}'; Write-Output ('VALID=' + (Test-EmuLeaseValid $l) + ' OWNER=' + $l.owner)`);
    assert.equal(check.code, 0, check.out);
    assert.match(check.out, /VALID=True OWNER=same/);
  } finally {
    cleanup();
  }
});

test("Node writes an expired lease: PS parses its dates (Test-EmuLeaseValid False) and takes it over", { skip }, async () => {
  const { dir, file, cleanup } = setup();
  try {
    // A lease Node took 3 h ago for 1 h, with the emulator start time it records.
    const past = new Date(Date.now() - 3 * 3_600_000);
    await enterLease({ path: file, avd: AVD, owner: "node-owner", hours: 1, host: "NODEHOST", now: past, report: silent });
    await updateLease(file, "node-owner", { startedEmulator: true, emulatorPid: 4242, emulatorStartedAt: formatLocalIso(past) });

    // A date PS could not parse would count as valid (fail safe) and hide a format drift: check the parse itself.
    const parse = await runPs(
      dir,
      "ps-owner",
      `$l = Read-EmuLease '${AVD}'; Write-Output ('VALID=' + (Test-EmuLeaseValid $l)); ` +
        `Write-Output ('EXPIRES=' + (ConvertTo-LeaseDate $l.expiresAt).ToUnixTimeMilliseconds()); ` +
        `Write-Output ('STARTED=' + (ConvertTo-LeaseDate $l.emulatorStartedAt).ToUnixTimeMilliseconds())`,
    );
    assert.equal(parse.code, 0, parse.out);
    assert.match(parse.out, /VALID=False/);
    assert.equal(Number(/EXPIRES=(\d+)/.exec(parse.out)?.[1]), past.getTime() + 3_600_000);
    assert.equal(Number(/STARTED=(\d+)/.exec(parse.out)?.[1]), past.getTime());

    const take = await runPs(dir, "ps-owner", `$r = Enter-EmuLease -Owner (Get-EmuOwner) -Hours 1 -Avd '${AVD}'; Write-Output ('ACTION=' + $r.Action)`);
    assert.equal(take.code, 0, take.out);
    assert.match(take.out, /ACTION=takeover/);
    assert.equal((await readLease(file))?.owner, "ps-owner");
  } finally {
    cleanup();
  }
});

test("an owner spelled with other case is the same owner on both sides (PowerShell -eq)", { skip }, async () => {
  const { dir, file, cleanup } = setup();
  try {
    const ps = await runPs(dir, "Alice", `$r = Enter-EmuLease -Owner (Get-EmuOwner) -Hours 1 -Avd '${AVD}'; Write-Output ('ACTION=' + $r.Action)`);
    assert.equal(ps.code, 0, ps.out);
    const again = await enterLease({ path: file, avd: AVD, owner: "alice", hours: 2, host: "H", report: silent });
    assert.equal(again.action, "renewed");
    assert.equal((await assertLeaseUsable({ path: file, avd: AVD, owner: "ALICE", mode: "strict", report: silent }))?.owner, "Alice");
    const back = await runPs(dir, "aLiCe", `$l = Assert-EmuLeaseUsable '${AVD}'; Write-Output ('OWNER=' + $l.owner)`);
    assert.equal(back.code, 0, back.out);
    assert.match(back.out, /OWNER=Alice/);
  } finally {
    cleanup();
  }
});
