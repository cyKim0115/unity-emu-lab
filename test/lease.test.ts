import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveLocations } from "../src/config.ts";
import { isEmuError } from "../src/errors.ts";
import {
  addInstalled,
  assertLeaseUsable,
  busyMessage,
  enterLease,
  formatLocalIso,
  isLeaseValid,
  leasePath,
  parseLeaseDate,
  readLease,
  removeLease,
  renewLease,
  resetLeaseWarning,
  updateLease,
  writeLease,
} from "../src/lease.ts";
import { silent } from "../src/types.ts";
import type { LeaseRecord } from "../src/types.ts";

function setup(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "emu-lab-lease-"));
  const loc = resolveLocations({ env: { EMU_LAB_HOME: dir } });
  return { dir, file: leasePath(loc, "test-avd"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function lines(): { report: (l: string) => void; out: string[] } {
  const out: string[] = [];
  return { report: (l: string) => out.push(l), out };
}

const HOUR = 3_600_000;

function psLease(file: string, fields: Record<string, unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(fields, null, 4).replace(/\n/g, "\r\n") + "\r\n");
}

beforeEach(() => resetLeaseWarning());

test("leasePath is <leaseDir>/<avd>.json; default AVD from locations", () => {
  const loc = resolveLocations({ env: { EMU_LAB_HOME: "/lab" }, platform: "linux", home: "/h" });
  assert.equal(leasePath(loc), "/lab/leases/unity-test.json");
  assert.equal(leasePath(loc, "x"), "/lab/leases/x.json");
  const win = resolveLocations({ env: {}, platform: "win32", home: "C:\\Profile\\me" });
  assert.equal(leasePath(win, "x"), "C:\\Profile\\me\\.emu-lab\\leases\\x.json");
});

test("formatLocalIso: local time with offset and 3 fraction digits, round trip", () => {
  const d = new Date(Date.UTC(2026, 10, 20, 1, 43, 0, 123));
  const s = formatLocalIso(d);
  assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  assert.equal(parseLeaseDate(s)?.getTime(), d.getTime());
});

test("parseLeaseDate: PS 7-digit fractions, Z, no fraction, local, junk", () => {
  assert.equal(parseLeaseDate("2026-11-20T10:43:00.1234567+09:00")?.toISOString(), "2026-11-20T01:43:00.123Z");
  assert.equal(parseLeaseDate("2026-11-20T01:43:00.9999999Z")?.toISOString(), "2026-11-20T01:43:00.999Z");
  assert.equal(parseLeaseDate("2026-11-20T10:43:00-05:30")?.toISOString(), "2026-11-20T16:13:00.000Z");
  assert.equal(parseLeaseDate("2026-11-20T10:43:00+0900")?.toISOString(), "2026-11-20T01:43:00.000Z");
  assert.equal(parseLeaseDate("2026-11-20T10:43:00")?.getTime(), new Date(2026, 10, 20, 10, 43, 0).getTime());
  assert.equal(parseLeaseDate("/Date(1700000000000)/")?.getTime(), 1700000000000);
  const d = new Date();
  assert.equal(parseLeaseDate(d), d);
  assert.equal(parseLeaseDate("not a date"), null);
  assert.equal(parseLeaseDate(""), null);
  assert.equal(parseLeaseDate(null), null);
  assert.equal(parseLeaseDate("2026-13-01T00:00:00Z"), null);
});

test("isLeaseValid: null false, unparsable true (fail safe), else expiresAt > now", () => {
  const now = new Date();
  const base = { avd: "a", owner: "o", host: "h", acquiredAt: "", startedEmulator: false, emulatorPid: null, emulatorStartedAt: null, installed: [] };
  assert.equal(isLeaseValid(null, now), false);
  assert.equal(isLeaseValid({ ...base, expiresAt: "garbage" }, now), true);
  assert.equal(isLeaseValid({ ...base, expiresAt: formatLocalIso(new Date(now.getTime() + 1000)) }, now), true);
  assert.equal(isLeaseValid({ ...base, expiresAt: formatLocalIso(new Date(now.getTime() - 1000)) }, now), false);
});

test("enterLease: new, renewed by the same owner, BUSY for another owner", async () => {
  const { file, cleanup } = setup();
  try {
    const now = new Date();
    const first = await enterLease({ path: file, avd: "test-avd", owner: "a", hours: 2, host: "H1", now, report: silent });
    assert.equal(first.action, "new");
    assert.deepEqual(
      { ...first.lease },
      {
        avd: "test-avd",
        owner: "a",
        host: "H1",
        acquiredAt: formatLocalIso(now),
        expiresAt: formatLocalIso(new Date(now.getTime() + 2 * HOUR)),
        startedEmulator: false,
        emulatorPid: null,
        emulatorStartedAt: null,
        installed: [],
      },
    );
    const text = readFileSync(file, "utf8");
    assert.ok(!text.startsWith("\uFEFF"));
    const eol = process.platform === "win32" ? "\r\n" : "\n";
    assert.ok(text.endsWith("}" + eol));
    assert.ok(text.includes(`{${eol}  "avd": "test-avd",${eol}  "owner": "a",`));
    assert.deepEqual(Object.keys(JSON.parse(text)), [
      "avd", "owner", "host", "acquiredAt", "expiresAt", "startedEmulator", "emulatorPid", "emulatorStartedAt", "installed",
    ]);

    const later = new Date(now.getTime() + 60_000);
    const again = await enterLease({ path: file, avd: "test-avd", owner: "a", hours: 4, host: "H2", now: later, report: silent });
    assert.equal(again.action, "renewed");
    assert.equal(again.lease.acquiredAt, first.lease.acquiredAt);
    assert.equal(again.lease.host, "H1");
    assert.equal(again.lease.expiresAt, formatLocalIso(new Date(later.getTime() + 4 * HOUR)));

    const before = readFileSync(file, "utf8");
    await assert.rejects(
      enterLease({ path: file, avd: "test-avd", owner: "b", hours: 1, host: "H3", report: silent }),
      (err: unknown) => {
        assert.ok(isEmuError(err, "BUSY"));
        assert.equal(err.message, busyMessage(again.lease, "test-avd"));
        assert.match(err.message, /^BUSY: AVD 'test-avd' is leased by a \(host H1, since .+, until .+\)\. Another session/);
        assert.match(err.message, /emu-lab release --any-owner\)\.$/);
        return true;
      },
    );
    assert.equal(readFileSync(file, "utf8"), before, "BUSY must not touch the file");
    // No temp files are left behind.
    assert.deepEqual(readdirSync(path.dirname(file)), ["test-avd.json"]);
  } finally {
    cleanup();
  }
});

test("enterLease: an expired lease of another owner is taken over (reported)", async () => {
  const { file, cleanup } = setup();
  try {
    psLease(file, {
      avd: "test-avd", owner: "old", host: "H", acquiredAt: "2026-11-19T08:00:00.1234567+09:00",
      expiresAt: "2026-11-19T09:00:00.1234567+09:00", startedEmulator: true, emulatorPid: 99, emulatorStartedAt: null, installed: ["x"],
    });
    const r = lines();
    const res = await enterLease({ path: file, avd: "test-avd", owner: "new", hours: 1, host: "H2", report: r.report });
    assert.equal(res.action, "takeover");
    assert.equal(res.lease.owner, "new");
    assert.equal(res.lease.startedEmulator, false);
    assert.deepEqual(res.lease.installed, []);
    assert.deepEqual(r.out, [
      "LEASE_TAKEOVER the lease of old ran out at 2026-11-19T09:00:00.1234567+09:00; taking it over (an emulator it started keeps running)",
    ]);
    assert.equal((await readLease(file))?.owner, "new");
  } finally {
    cleanup();
  }
});

test("enterLease: two concurrent calls with different owners, exactly one wins (EEXIST race)", async () => {
  for (let round = 0; round < 5; round++) {
    const { file, cleanup } = setup();
    try {
      const results = await Promise.allSettled([
        enterLease({ path: file, avd: "test-avd", owner: "a", hours: 1, host: "H", report: silent }),
        enterLease({ path: file, avd: "test-avd", owner: "b", hours: 1, host: "H", report: silent }),
      ]);
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      assert.equal(won.length, 1);
      assert.equal(lost.length, 1);
      assert.ok(isEmuError(lost[0].reason, "BUSY"), String(lost[0].reason));
      const winner = (won[0] as PromiseFulfilledResult<{ lease: LeaseRecord }>).value.lease.owner;
      assert.equal((await readLease(file))?.owner, winner);
      assert.match((lost[0].reason as Error).message, new RegExp(`leased by ${winner} `));
    } finally {
      cleanup();
    }
  }
});

test("enterLease validates hours", async () => {
  const { file, cleanup } = setup();
  try {
    await assert.rejects(enterLease({ path: file, avd: "a", owner: "o", hours: 0, host: "h", report: silent }), (e: unknown) => isEmuError(e, "BAD_OPTION"));
    assert.equal(existsSync(file), false);
  } finally {
    cleanup();
  }
});

test("readLease: unknown fields kept and written back after them; installed normalised", async () => {
  const { file, cleanup } = setup();
  try {
    psLease(file, {
      note: "keep me", avd: "test-avd", owner: "a", host: "H", acquiredAt: "2026-11-20T10:00:00.1234567+09:00",
      expiresAt: "2099-01-01T00:00:00.0000000+09:00", startedEmulator: false, emulatorPid: null, emulatorStartedAt: null,
      installed: "com.example.one", extra: { nested: [1, 2] },
    });
    const lease = await readLease(file);
    assert.ok(lease);
    assert.deepEqual(lease.installed, ["com.example.one"]);
    assert.equal(lease.note, "keep me");
    assert.deepEqual(lease.extra, { nested: [1, 2] });

    await addInstalled(file, "a", "com.example.two");
    await addInstalled(file, "a", "com.example.two");
    await addInstalled(file, "someone-else", "com.example.three");
    const text = readFileSync(file, "utf8");
    const parsed = JSON.parse(text);
    assert.deepEqual(parsed.installed, ["com.example.one", "com.example.two"]);
    assert.deepEqual(Object.keys(parsed), [
      "avd", "owner", "host", "acquiredAt", "expiresAt", "startedEmulator", "emulatorPid", "emulatorStartedAt", "installed", "note", "extra",
    ]);
    assert.equal(parsed.acquiredAt, "2026-11-20T10:00:00.1234567+09:00", "PS dates are kept as written");

    psLease(file, { avd: "test-avd", owner: "a", host: "H", acquiredAt: "", expiresAt: "", installed: null });
    assert.deepEqual((await readLease(file))?.installed, []);
    psLease(file, { avd: "test-avd", owner: "a", host: "H", acquiredAt: "", expiresAt: "", installed: ["p", "", null, "p", "q"] });
    assert.deepEqual((await readLease(file))?.installed, ["p", "q"]);
    psLease(file, { avd: "test-avd", owner: "a", host: "H", acquiredAt: "", expiresAt: "" });
    const minimal = await readLease(file);
    assert.deepEqual(minimal?.installed, []);
    assert.equal(minimal?.emulatorPid, null);
    assert.equal(minimal?.startedEmulator, false);
  } finally {
    cleanup();
  }
});

test("readLease: missing null, BOM stripped, invalid JSON throws LEASE_UNREADABLE after retries", async () => {
  const { file, cleanup } = setup();
  try {
    assert.equal(await readLease(file), null);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "\uFEFF" + JSON.stringify({ avd: "test-avd", owner: "a", expiresAt: "x" }));
    assert.equal((await readLease(file))?.owner, "a");

    writeFileSync(file, "{ broken");
    const t0 = Date.now();
    await assert.rejects(readLease(file, { attempts: 3, intervalMs: 20 }), (err: unknown) => {
      assert.ok(isEmuError(err, "LEASE_UNREADABLE"));
      assert.match(err.message, /^Cannot read the lease file .+test-avd\.json \(invalid JSON: .+\)\. Look at it; delete it only when no session uses the emulator\.$/);
      return true;
    });
    assert.ok(Date.now() - t0 >= 30); // two 20 ms retries, with slack for early timers

    writeFileSync(file, "   ");
    await assert.rejects(readLease(file, { attempts: 2, intervalMs: 10 }), /\(it is empty\)/);
  } finally {
    cleanup();
  }
});

test("readLease: an empty file that gets filled 400 ms later is read (default retry 6 x 300 ms)", async () => {
  const { file, cleanup } = setup();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "");
    const timer = setTimeout(() => {
      writeFileSync(file, JSON.stringify({ avd: "test-avd", owner: "late", expiresAt: "2099-01-01T00:00:00Z" }));
    }, 400);
    const t0 = Date.now();
    const lease = await readLease(file);
    clearTimeout(timer);
    assert.equal(lease?.owner, "late");
    assert.ok(Date.now() - t0 >= 350, "waited for the late write"); // timers may fire a ms early
  } finally {
    cleanup();
  }
});

test("renewLease: NO_LEASE, NOT_OWNER (valid and expired), own valid or expired extends", async () => {
  const { file, cleanup } = setup();
  try {
    await assert.rejects(renewLease({ path: file, avd: "test-avd", owner: "a", hours: 1 }), (err: unknown) => {
      assert.ok(isEmuError(err, "NO_LEASE"));
      assert.match(err.message, /^NO_LEASE: .*emu-lab start/);
      return true;
    });

    const now = new Date();
    await enterLease({ path: file, avd: "test-avd", owner: "a", hours: 1, host: "H", now, report: silent });
    await assert.rejects(renewLease({ path: file, avd: "test-avd", owner: "b", hours: 1 }), (err: unknown) => {
      assert.ok(isEmuError(err, "NOT_OWNER"));
      assert.match(err.message, /^NOT_OWNER: AVD 'test-avd' is leased by a \(host H, since/);
      return true;
    });

    const later = new Date(now.getTime() + 3 * HOUR); // the 1-hour lease ran out
    await assert.rejects(renewLease({ path: file, avd: "test-avd", owner: "b", hours: 1, now: later }), (err: unknown) => {
      assert.ok(isEmuError(err, "NOT_OWNER"));
      assert.match(err.message, /^NOT_OWNER AVD 'test-avd' is leased by a, not by b/);
      return true;
    });

    const renewed = await renewLease({ path: file, avd: "test-avd", owner: "a", hours: 2, now: later });
    assert.equal(renewed.expiresAt, formatLocalIso(new Date(later.getTime() + 2 * HOUR)));
    assert.equal((await readLease(file))?.expiresAt, renewed.expiresAt);
  } finally {
    cleanup();
  }
});

test("updateLease only changes our own lease; removeLease tolerates a missing file", async () => {
  const { file, cleanup } = setup();
  try {
    assert.equal(await updateLease(file, "a", { startedEmulator: true }), false);
    await enterLease({ path: file, avd: "test-avd", owner: "a", hours: 1, host: "H", report: silent });
    assert.equal(await updateLease(file, "b", { startedEmulator: true }), false);
    assert.equal(await updateLease(file, "a", { startedEmulator: true, emulatorPid: 1234, emulatorStartedAt: "2026-11-20T10:00:00.000+09:00" }), true);
    const lease = await readLease(file);
    assert.equal(lease?.startedEmulator, true);
    assert.equal(lease?.emulatorPid, 1234);
    assert.equal(lease?.emulatorStartedAt, "2026-11-20T10:00:00.000+09:00");
    // Concurrent replacing writes from one process do not trip over the shared temp file name.
    await Promise.all([
      addInstalled(file, "a", "p1"),
      updateLease(file, "a", { note: "n" }),
      writeLease(file, { ...(lease as LeaseRecord), host: "H9" }, { create: false }),
    ]);
    assert.equal((await readLease(file))?.owner, "a");
    await removeLease(file);
    assert.equal(existsSync(file), false);
    await removeLease(file);
  } finally {
    cleanup();
  }
});

test("writeLease create fails with EEXIST when the file exists", async () => {
  const { file, cleanup } = setup();
  try {
    const lease = (await enterLease({ path: file, avd: "test-avd", owner: "a", hours: 1, host: "H", report: silent })).lease;
    await assert.rejects(writeLease(file, lease, { create: true }), (err: unknown) => (err as NodeJS.ErrnoException).code === "EEXIST");
  } finally {
    cleanup();
  }
});

test("assertLeaseUsable: BUSY for another owner, own lease returned, strict NO_LEASE, warn LEASE_NONE once", async () => {
  const { file, cleanup } = setup();
  try {
    const r = lines();
    // No lease: warn reports once per process and returns null.
    assert.equal(await assertLeaseUsable({ path: file, avd: "test-avd", owner: "a", mode: "warn", report: r.report }), null);
    assert.equal(await assertLeaseUsable({ path: file, avd: "test-avd", owner: "a", mode: "warn", report: r.report }), null);
    assert.deepEqual(r.out, [
      "LEASE_NONE AVD 'test-avd' is not leased (no session holds it). Run emu-lab start first so other sessions see the emulator as busy, and emu-lab release when done.",
    ]);
    await assert.rejects(assertLeaseUsable({ path: file, avd: "test-avd", owner: "a", mode: "strict", report: r.report }), (err: unknown) => {
      assert.ok(isEmuError(err, "NO_LEASE"));
      assert.equal(err.message, "NO_LEASE: AVD 'test-avd' is not leased by a (no session holds it). Take it first with emu_start (CLI: emu-lab start).");
      return true;
    });

    const now = new Date();
    await enterLease({ path: file, avd: "test-avd", owner: "a", hours: 1, host: "H", now, report: silent });
    const own = await assertLeaseUsable({ path: file, avd: "test-avd", owner: "a", mode: "strict", report: r.report });
    assert.equal(own?.owner, "a");
    await assert.rejects(assertLeaseUsable({ path: file, avd: "test-avd", owner: "b", mode: "warn", report: r.report }), (e: unknown) => isEmuError(e, "BUSY"));
    await assert.rejects(assertLeaseUsable({ path: file, avd: "test-avd", owner: "b", mode: "strict", report: r.report }), (e: unknown) => isEmuError(e, "BUSY"));

    // Own expired lease: strict refuses with the reason, warn does not repeat LEASE_NONE in this process.
    const later = new Date(now.getTime() + 2 * HOUR);
    await assert.rejects(assertLeaseUsable({ path: file, avd: "test-avd", owner: "a", mode: "strict", report: r.report, now: later }), (err: unknown) => {
      assert.ok(isEmuError(err, "NO_LEASE"));
      assert.match(err.message, /\(the lease of a ran out at .+\)/);
      return true;
    });
    assert.equal(await assertLeaseUsable({ path: file, avd: "test-avd", owner: "b", mode: "warn", report: r.report, now: later }), null);
    assert.equal(r.out.length, 1);

    resetLeaseWarning();
    await assertLeaseUsable({ path: file, avd: "test-avd", owner: "b", mode: "warn", report: r.report, now: later });
    assert.match(r.out[1], /^LEASE_NONE AVD 'test-avd' is not leased \(the lease of a ran out at /);
  } finally {
    cleanup();
  }
});

// --- connect (context.ts) with the fake adb

const DEVICES = "List of devices attached\nemulator-5554\tdevice\n\n";

async function withFake(
  fn: (f: Awaited<ReturnType<typeof loadFake>>["fake"], env: NodeJS.ProcessEnv, file: string) => Promise<void>,
): Promise<void> {
  const { fake, home } = await loadFake();
  const env: NodeJS.ProcessEnv = { ...fake.env, EMU_LAB_HOME: home, EMU_OWNER: "me", EMU_AVD: "test-avd" };
  const file = leasePath(resolveLocations({ env }), "test-avd");
  try {
    await fn(fake, env, file);
  } finally {
    fake.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
}

async function loadFake() {
  const { makeFakeAdb, tempLabHome } = await import("./helpers/fake.ts");
  const fake = makeFakeAdb([
    { match: "^devices$", stdout: DEVICES },
    { match: "^emu avd name$", stdout: "test-avd\r\nOK\r\n" },
  ]);
  return { fake, home: tempLabHome() };
}

test("connect: binds the AVD's serial; leaseMode none needs no lease", async () => {
  const { connect } = await import("../src/context.ts");
  await withFake(async (fake, env) => {
    const ctx = await connect({ env, report: silent, leaseMode: "none", waitSec: 0, adbFactory: () => fake.adb });
    assert.equal(ctx.serial, "emulator-5554");
    assert.equal(ctx.adb.serial, "emulator-5554");
    assert.equal(ctx.avd, "test-avd");
    assert.equal(ctx.owner, "me");
    assert.ok(ctx.leaseFile.endsWith(path.join("leases", "test-avd.json")));
  });
});

test("connect: BUSY before any device command; strict NO_LEASE; warn LEASE_NONE; own lease ok", async () => {
  const { connect } = await import("../src/context.ts");
  await withFake(async (fake, env, file) => {
    const r = lines();
    await assert.rejects(connect({ env, report: r.report, leaseMode: "strict", waitSec: 0, adbFactory: () => fake.adb }), (e: unknown) => isEmuError(e, "NO_LEASE"));
    await connect({ env, report: r.report, leaseMode: "warn", waitSec: 0, adbFactory: () => fake.adb });
    assert.match(r.out.join("\n"), /^LEASE_NONE AVD 'test-avd' is not leased/m);

    await enterLease({ path: file, avd: "test-avd", owner: "someone", hours: 1, host: "H", report: silent });
    await assert.rejects(connect({ env, report: r.report, leaseMode: "warn", waitSec: 0, adbFactory: () => fake.adb }), (e: unknown) => isEmuError(e, "BUSY"));
    for (const cmd of fake.commands()) assert.match(cmd, /^(devices|emu avd name|shell getprop ro\.boot\.qemu\.avd_name)$/, cmd);

    await removeLease(file);
    await enterLease({ path: file, avd: "test-avd", owner: "me", hours: 1, host: "H", report: silent });
    const ctx = await connect({ env, report: r.report, leaseMode: "strict", waitSec: 0, adbFactory: () => fake.adb });
    assert.equal(ctx.serial, "emulator-5554");
  });
});

test("connect: NO_EMULATOR for another AVD, NO_ADB for a missing adb", async () => {
  const { connect } = await import("../src/context.ts");
  await withFake(async (fake, env) => {
    await assert.rejects(connect({ avd: "other-avd", env, report: silent, leaseMode: "none", waitSec: 0, adbFactory: () => fake.adb }), (err: unknown) => {
      assert.ok(isEmuError(err, "NO_EMULATOR"));
      assert.equal(err.message, "No running emulator for AVD 'other-avd'. Run emu-lab start (MCP: emu_start) first.");
      return true;
    });
    const missing = path.join(os.tmpdir(), "emu-lab-no-such-dir", "adb.exe");
    await assert.rejects(connect({ env: { ...env, EMU_ADB: missing }, report: silent, leaseMode: "none", waitSec: 0 }), (err: unknown) => {
      assert.ok(isEmuError(err, "NO_ADB"));
      assert.ok(err.message.includes(missing) && err.message.includes("env EMU_ADB"));
      return true;
    });
  });
});

// ---------------------------------------------------------------------------------------------------
// Races, lock and owner case

const EXPIRED_OLD = {
  avd: "test-avd", owner: "old", host: "H", acquiredAt: "2026-11-19T08:00:00.1234567+09:00",
  expiresAt: "2026-11-19T09:00:00.1234567+09:00", startedEmulator: false, emulatorPid: null, emulatorStartedAt: null, installed: [],
};

test("enterLease: two sessions taking over the same expired lease at once, exactly one wins (takeover race)", async () => {
  for (let round = 0; round < 40; round++) {
    const { dir, file, cleanup } = setup();
    try {
      psLease(file, EXPIRED_OLD);
      const results = await Promise.allSettled([
        enterLease({ path: file, avd: "test-avd", owner: "a", hours: 1, host: "H", report: silent }),
        enterLease({ path: file, avd: "test-avd", owner: "b", hours: 1, host: "H", report: silent }),
      ]);
      const won = results.filter((r): r is PromiseFulfilledResult<{ action: "new" | "renewed" | "takeover"; lease: LeaseRecord }> => r.status === "fulfilled");
      const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      assert.equal(won.length, 1, `round ${round}: both took the lease over`);
      assert.equal(won[0].value.action, "takeover");
      assert.ok(isEmuError(lost[0].reason, "BUSY"), String(lost[0].reason));
      const winner = won[0].value.lease.owner;
      assert.equal((await readLease(file))?.owner, winner);
      assert.match((lost[0].reason as Error).message, new RegExp(`leased by ${winner} `));
      // The lock is gone afterwards.
      assert.deepEqual(readdirSync(path.dirname(file)).filter((n) => n.includes(".lock")), [], dir);
    } finally {
      cleanup();
    }
  }
});

test("enterLease: the takeover race across processes, exactly one wins", async () => {
  const { spawn } = await import("node:child_process");
  const leaseUrl = new URL("../src/lease.ts", import.meta.url).href;
  const take = (file: string, owner: string): Promise<string> =>
    new Promise((resolve) => {
      const code =
        `const { enterLease } = await import(${JSON.stringify(leaseUrl)});` +
        `try { const r = await enterLease({ path: ${JSON.stringify(file)}, avd: "test-avd", owner: ${JSON.stringify(owner)}, hours: 1, host: "H", report: () => {} });` +
        ` process.stdout.write("WON " + r.action); } catch (e) { process.stdout.write("LOST " + e.code); }`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("close", () => resolve(out.trim()));
    });
  for (let round = 0; round < 6; round++) {
    const { file, cleanup } = setup();
    try {
      psLease(file, EXPIRED_OLD);
      const results = await Promise.all([take(file, "a"), take(file, "b"), take(file, "c")]);
      assert.equal(results.filter((r) => r === "WON takeover").length, 1, results.join(", "));
      assert.equal(results.filter((r) => r === "LOST BUSY").length, 2, results.join(", "));
    } finally {
      cleanup();
    }
  }
});

test("a lock file left by a killed process is dropped after 10 s; normal calls leave no lock behind", async () => {
  const { utimesSync } = await import("node:fs");
  const { leaseLockPath } = await import("../src/lease.ts");
  const { file, cleanup } = setup();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const lock = leaseLockPath(file);
    writeFileSync(lock, "4242 killed-process");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const res = await enterLease({ path: file, avd: "test-avd", owner: "a", hours: 1, host: "H", report: silent });
    assert.equal(res.action, "new");
    await renewLease({ path: file, avd: "test-avd", owner: "a", hours: 2 });
    await addInstalled(file, "a", "com.x");
    assert.equal(existsSync(lock), false);
    assert.deepEqual((await readLease(file))?.installed, ["com.x"]);
  } finally {
    cleanup();
  }
});

test("renew and addInstalled at the same time: neither update is lost", async () => {
  for (let round = 0; round < 20; round++) {
    const { file, cleanup } = setup();
    try {
      const now = new Date();
      await enterLease({ path: file, avd: "test-avd", owner: "a", hours: 1, host: "H", report: silent, now });
      const renewed = renewLease({ path: file, avd: "test-avd", owner: "a", hours: 5, now });
      const installed = addInstalled(file, "a", "com.example.app");
      const pid = updateLease(file, "a", { emulatorPid: 77 });
      const [lease] = await Promise.all([renewed, installed, pid]);
      const cur = await readLease(file);
      assert.equal(cur?.expiresAt, lease.expiresAt, `round ${round}: the renewal was lost`);
      assert.deepEqual(cur?.installed, ["com.example.app"], `round ${round}: the installed package was lost`);
      assert.equal(cur?.emulatorPid, 77, `round ${round}: the pid was lost`);
    } finally {
      cleanup();
    }
  }
});

test("owners compare case-insensitively, like PowerShell -eq", async () => {
  const { sameOwner } = await import("../src/lease.ts");
  assert.equal(sameOwner("claude:ABC", "claude:abc"), true);
  assert.equal(sameOwner("Alice", "Bob"), false);
  const { file, cleanup } = setup();
  try {
    await enterLease({ path: file, avd: "test-avd", owner: "Alice", hours: 1, host: "H", report: silent });
    const again = await enterLease({ path: file, avd: "test-avd", owner: "alice", hours: 2, host: "H", report: silent });
    assert.equal(again.action, "renewed");
    assert.equal(again.lease.owner, "Alice");
    const usable = await assertLeaseUsable({ path: file, avd: "test-avd", owner: "ALICE", mode: "strict", report: silent });
    assert.equal(usable?.owner, "Alice");
    await renewLease({ path: file, avd: "test-avd", owner: "alice", hours: 3 });
    assert.equal(await updateLease(file, "aLiCe", { emulatorPid: 5 }), true);
    await addInstalled(file, "alice", "com.x");
    const cur = await readLease(file);
    assert.equal(cur?.emulatorPid, 5);
    assert.deepEqual(cur?.installed, ["com.x"]);
    await assert.rejects(
      assertLeaseUsable({ path: file, avd: "test-avd", owner: "bob", mode: "warn", report: silent }),
      (e: unknown) => isEmuError(e, "BUSY"),
    );
  } finally {
    cleanup();
  }
});

test("removeLeaseIfSame and holdLease act only on the lease that was read (LEASE_CHANGED otherwise)", async () => {
  const { holdLease, removeLeaseIfSame, assertSameLease } = await import("../src/lease.ts");
  const { file, cleanup } = setup();
  try {
    assert.equal(await removeLeaseIfSame(file, EXPIRED_OLD as LeaseRecord), "gone");
    psLease(file, EXPIRED_OLD);
    const read = (await readLease(file))!;
    // Another session took it over after our read: its lease is neither extended nor deleted.
    const taken = await enterLease({ path: file, avd: "test-avd", owner: "b", hours: 1, host: "H", report: silent });
    await assert.rejects(holdLease(file, read, 15 * 60_000), (e: unknown) => isEmuError(e, "LEASE_CHANGED") && /held by b/.test((e as Error).message));
    await assert.rejects(removeLeaseIfSame(file, read), (e: unknown) => isEmuError(e, "LEASE_CHANGED"));
    await assert.rejects(assertSameLease(file, read), (e: unknown) => isEmuError(e, "LEASE_CHANGED"));
    assert.equal((await readLease(file))?.acquiredAt, taken.lease.acquiredAt);

    // The same lease (ran out): holdLease keeps it valid for the hold, then removeLeaseIfSame deletes it.
    rmSync(file);
    psLease(file, EXPIRED_OLD);
    const mine = (await readLease(file))!;
    const now = new Date();
    const { lease: held } = await holdLease(file, mine, 15 * 60_000, { now });
    assert.ok(isLeaseValid(held, new Date(now.getTime() + 14 * 60_000)));
    assert.equal(held.acquiredAt, mine.acquiredAt);
    assert.ok(isLeaseValid(await readLease(file), new Date(now.getTime() + 14 * 60_000)));
    // --stale: a lease renewed meanwhile is not stale any more.
    await assert.rejects(removeLeaseIfSame(file, mine, { expired: true }), (e: unknown) => isEmuError(e, "NOT_STALE"));
    assert.equal(await removeLeaseIfSame(file, mine), "removed");
    assert.equal(existsSync(file), false);
  } finally {
    cleanup();
  }
});

test("sameLease compares acquiredAt as an instant at ms precision (a PowerShell rewrite may reformat it)", async () => {
  const { sameLease, holdLease, removeLeaseIfSame, assertSameLease } = await import("../src/lease.ts");
  const base: LeaseRecord = {
    avd: "test-avd",
    owner: "a",
    host: "H",
    acquiredAt: "2026-11-20T10:43:00.120+09:00",
    expiresAt: "2026-11-20T11:43:00.120+09:00",
    startedEmulator: false,
    emulatorPid: null,
    emulatorStartedAt: null,
    installed: [],
  };
  const same = (acquiredAt: string, owner = "a") => sameLease(base, { ...base, acquiredAt, owner });
  assert.equal(same("2026-11-20T10:43:00.12+09:00"), true);
  assert.equal(same("2026-11-20T01:43:00.12Z"), true);
  assert.equal(same("2026-11-20T01:43:00.1200000Z"), true);
  assert.equal(same("2026-11-20T10:43:00.12+09:00", "A"), true);
  assert.equal(same("2026-11-20T10:43:00.121+09:00"), false);
  assert.equal(same("2026-11-20T10:43:00.12+09:00", "b"), false);
  assert.equal(same("not a time"), false);

  // The file holds the same lease rewritten by PowerShell 7 (".12+09:00"): release's hold, check and delete accept it.
  const { file, cleanup } = setup();
  try {
    psLease(file, { ...base, acquiredAt: "2026-11-20T01:43:00.12Z", expiresAt: formatLocalIso(new Date(Date.now() - 60_000)) });
    const read: LeaseRecord = { ...base, expiresAt: formatLocalIso(new Date(Date.now() - 60_000)) };
    const { lease: held } = await holdLease(file, read, 15 * 60_000);
    assert.ok(isLeaseValid(held));
    await assertSameLease(file, read);
    assert.equal(await removeLeaseIfSame(file, read), "removed");
  } finally {
    cleanup();
  }
});

test("two waiters on a stale lock: exactly one is inside at a time", async () => {
  const { utimesSync } = await import("node:fs");
  const { leaseLockPath, withLeaseLock } = await import("../src/lease.ts");
  for (let round = 0; round < 15; round++) {
    const { file, cleanup } = setup();
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const lock = leaseLockPath(file);
      writeFileSync(lock, "4242 killed-process");
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);
      let inside = 0;
      let most = 0;
      let ran = 0;
      const enter = () =>
        withLeaseLock(file, async () => {
          inside++;
          most = Math.max(most, inside);
          await new Promise((r) => setTimeout(r, 20));
          inside--;
          ran++;
        });
      await Promise.all([enter(), enter(), enter()]);
      assert.equal(most, 1, `round ${round}: two waiters were inside at once`);
      assert.equal(ran, 3);
      assert.equal(existsSync(lock), false);
      assert.deepEqual(readdirSync(path.dirname(file)).filter((n) => n.includes(".lock")), []);
    } finally {
      cleanup();
    }
  }
});

test("a waiter that moves aside a fresh lock (another waiter replaced the stale one) puts it back and waits", async () => {
  const { utimesSync } = await import("node:fs");
  const { leaseLockPath, leaseLockTestHooks, withLeaseLock } = await import("../src/lease.ts");
  const { file, cleanup } = setup();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const lock = leaseLockPath(file);
    writeFileSync(lock, "4242 killed-process");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    let replaced = false;
    // Waiter B drops the stale lock and takes a fresh one right after waiter A judged it stale.
    leaseLockTestHooks.beforeStaleMove = async (l) => {
      if (replaced) return;
      replaced = true;
      rmSync(l);
      writeFileSync(l, "B fresh-token");
    };
    let entered = 0;
    let releasedAt = 0;
    const a = withLeaseLock(file, async () => {
      entered = Date.now();
    });
    await new Promise((r) => setTimeout(r, 250));
    // B still holds its lock: A put it back and did not enter.
    assert.equal(replaced, true);
    assert.equal(entered, 0);
    assert.equal(readFileSync(lock, "utf8"), "B fresh-token");
    releasedAt = Date.now();
    rmSync(lock); // B releases
    await a;
    assert.ok(entered >= releasedAt, "A entered only after B released");
    assert.equal(existsSync(lock), false);
    assert.deepEqual(readdirSync(path.dirname(file)).filter((n) => n.includes(".stale")), []);
  } finally {
    leaseLockTestHooks.beforeStaleMove = undefined;
    cleanup();
  }
});

test("giveBackHold puts the expiry back only while the held lease is unchanged", async () => {
  const { giveBackHold, holdLease } = await import("../src/lease.ts");
  const { file, cleanup } = setup();
  try {
    const now = new Date();
    const first = await enterLease({ path: file, avd: "test-avd", owner: "a", hours: 1, host: "H", report: silent, now: new Date(now.getTime() - 2 * HOUR) });
    const read = (await readLease(file))!;
    assert.equal(isLeaseValid(read), false);
    const hold = await holdLease(file, read, 15 * 60_000);
    assert.equal(hold.replacedExpiresAt, read.expiresAt);
    assert.equal(await giveBackHold(file, hold), true);
    assert.equal((await readLease(file))?.expiresAt, first.lease.expiresAt);
    // Renewed after the hold: the renewal stays.
    const hold2 = await holdLease(file, read, 15 * 60_000);
    const renewed = await renewLease({ path: file, avd: "test-avd", owner: "a", hours: 3 });
    assert.equal(await giveBackHold(file, hold2), false);
    assert.equal((await readLease(file))?.expiresAt, renewed.expiresAt);
  } finally {
    cleanup();
  }
});

test("giveBackHold after a renewal between the read and the hold keeps the renewal (the hold did not write)", async () => {
  const { giveBackHold, holdLease } = await import("../src/lease.ts");
  const { file, cleanup } = setup();
  try {
    const now = new Date();
    // Entered 5 min, then read (T1), then renewed 4 h by the same owner, then held: the hold writes nothing.
    await enterLease({ path: file, avd: "test-avd", owner: "a", hours: 5 / 60, host: "H", report: silent, now: new Date(now.getTime() - 10 * 60_000) });
    const read = (await readLease(file))!;
    assert.equal(isLeaseValid(read), false);
    const renewed = await renewLease({ path: file, avd: "test-avd", owner: "a", hours: 4 });
    const hold = await holdLease(file, read, 15 * 60_000);
    assert.equal(hold.replacedExpiresAt, null);
    assert.equal(hold.lease.expiresAt, renewed.expiresAt);
    assert.equal(await giveBackHold(file, hold), false);
    assert.equal((await readLease(file))?.expiresAt, renewed.expiresAt);
    assert.ok(isLeaseValid(await readLease(file)));
  } finally {
    cleanup();
  }
});

test("giveBackHold after a short renewal the hold extended restores the renewal, not the value read before", async () => {
  const { giveBackHold, holdLease } = await import("../src/lease.ts");
  const { file, cleanup } = setup();
  try {
    const now = new Date();
    await enterLease({ path: file, avd: "test-avd", owner: "a", hours: 1, host: "H", report: silent, now: new Date(now.getTime() - 2 * HOUR) });
    const read = (await readLease(file))!;
    // Renewed for 6 min (shorter than the 15 min hold): the hold extends it and records the renewed expiry.
    const renewed = await renewLease({ path: file, avd: "test-avd", owner: "a", hours: 0.1 });
    const hold = await holdLease(file, read, 15 * 60_000);
    assert.equal(hold.replacedExpiresAt, renewed.expiresAt);
    assert.notEqual(hold.replacedExpiresAt, read.expiresAt);
    assert.equal(await giveBackHold(file, hold), true);
    assert.equal((await readLease(file))?.expiresAt, renewed.expiresAt);
    assert.ok(isLeaseValid(await readLease(file)));
  } finally {
    cleanup();
  }
});
