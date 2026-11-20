// Device lease: one session at a time per AVD. One file, <labHome>/leases/<avd>.json, the same format and rules as
// the *-EmuLease functions in scripts/common.ps1, so the PowerShell scripts and this package see each other's leases.
// Creating the file is the lock (open "wx" = FileMode.CreateNew): two sessions cannot both take it.
//
// Every read-modify-write of the lease (take, takeover, renew, update, release) also runs under a short lock file
// <lease>.lock (open "wx"), so two of this package's sessions (or two calls in one process) cannot both delete and
// recreate an expired lease, and one cannot overwrite or delete the lease another has just written. The PowerShell
// scripts do not take that lock; against them a re-read after each change catches a lost race.
//
// Owners compare case-insensitively, like PowerShell -eq / -ne.

import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, stat, unlink, mkdir } from "node:fs/promises";
import path from "node:path";
import { EmuError } from "./errors.ts";
import type { LeaseRecord, Report } from "./types.ts";
import type { Locations } from "./config.ts";

const KNOWN_FIELDS = [
  "avd",
  "owner",
  "host",
  "acquiredAt",
  "expiresAt",
  "startedEmulator",
  "emulatorPid",
  "emulatorStartedAt",
  "installed",
] as const;

/** Internal timing (tests shorten it); not exposed in the CLI or MCP. */
export interface LeaseReadTiming {
  attempts?: number;
  intervalMs?: number;
}

const READ_ATTEMPTS = 6;
const READ_INTERVAL_MS = 300;
const RENAME_ATTEMPTS = 10;
const RENAME_INTERVAL_MS = 100;
/** How long a session waits for the lease lock before it gives up. */
const LOCK_WAIT_MS = 15_000;
/** A lock file older than this was left by a killed process (the locked steps take well under a second). */
const LOCK_STALE_MS = 10_000;
const LOCK_POLL_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function leasePath(loc: Locations, avd?: string): string {
  const name = avd ?? loc.avd;
  // Locations may be built for another platform's path flavour (tests); join with the one the lease dir uses.
  const p = loc.leaseDir.includes("\\") ? path.win32 : loc.leaseDir.includes("/") ? path.posix : path;
  return p.join(loc.leaseDir, `${name}.json`);
}

/** Owner ids are the same when they match ignoring case (PowerShell -eq / -ne). */
export function sameOwner(a: string | null | undefined, b: string | null | undefined): boolean {
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

/**
 * The same lease (not a newer one): same owner and the same acquiredAt instant, compared at millisecond precision
 * (a PowerShell rewrite may reformat the time, e.g. ".120+09:00" -> ".12+09:00" or to UTC). Times that cannot be
 * read compare as text.
 */
export function sameLease(a: LeaseRecord, b: LeaseRecord): boolean {
  if (!sameOwner(a.owner, b.owner)) return false;
  if (a.acquiredAt === b.acquiredAt) return true;
  const x = parseLeaseDate(a.acquiredAt);
  const y = parseLeaseDate(b.acquiredAt);
  return x !== null && y !== null && x.getTime() === y.getTime();
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** Local time with offset, e.g. "2026-11-20T10:43:00.123+09:00" (PS DateTimeOffset.ToString('o') with 3 digits). */
export function formatLocalIso(d: Date): string {
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * A lease time: ISO 8601 with offset or Z, any number of fraction digits (PowerShell writes 7), no offset = local
 * time (like .NET DateTimeOffset.Parse). Also a Date, epoch milliseconds and the old "\/Date(ms)\/" JSON form.
 * Null when it cannot be read.
 */
export function parseLeaseDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "number") return Number.isFinite(v) ? new Date(v) : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  const msJson = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(s);
  if (msJson) return new Date(Number(msJson[1]));
  const m = ISO_RE.exec(s);
  if (m) {
    const [, y, mo, da, h = "0", mi = "0", se = "0", frac = "", tz] = m;
    const ms = Number((frac + "000").slice(0, 3));
    const year = Number(y);
    const month = Number(mo) - 1;
    const day = Number(da);
    const hour = Number(h);
    const minute = Number(mi);
    const second = Number(se);
    if (month > 11 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
    let t: number;
    if (tz === undefined) {
      t = new Date(year, month, day, hour, minute, second, ms).getTime();
    } else {
      t = Date.UTC(year, month, day, hour, minute, second, ms);
      if (tz !== "Z" && tz !== "z") {
        const tm = /^([+-])(\d{2}):?(\d{2})?$/.exec(tz);
        if (!tm) return null;
        const off = Number(tm[2]) * 60 + Number(tm[3] ?? "0");
        t -= (tm[1] === "+" ? 1 : -1) * off * 60_000;
      }
    }
    return Number.isNaN(t) ? null : new Date(t);
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

function normalizeInstalled(v: unknown): string[] {
  // PowerShell may write null, a single string or an array.
  const list = Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
  const out: string[] = [];
  for (const item of list) {
    if (item === null || item === undefined) continue;
    const s = String(item).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function normalizeLease(raw: Record<string, unknown>): LeaseRecord {
  const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
  const pidRaw = raw.emulatorPid;
  const pidNum = typeof pidRaw === "number" ? pidRaw : typeof pidRaw === "string" && pidRaw.trim() ? Number(pidRaw) : NaN;
  const lease: LeaseRecord = {
    ...raw,
    avd: str(raw.avd),
    owner: str(raw.owner),
    host: str(raw.host),
    acquiredAt: str(raw.acquiredAt),
    expiresAt: str(raw.expiresAt),
    startedEmulator: raw.startedEmulator === true || raw.startedEmulator === "true" || raw.startedEmulator === "True",
    emulatorPid: Number.isFinite(pidNum) ? pidNum : null,
    emulatorStartedAt:
      raw.emulatorStartedAt === null || raw.emulatorStartedAt === undefined || raw.emulatorStartedAt === ""
        ? null
        : String(raw.emulatorStartedAt),
    installed: normalizeInstalled(raw.installed),
  };
  return lease;
}

/**
 * The lease, or null when there is none. A file another session is writing can be empty or locked for a moment:
 * retry, then LEASE_UNREADABLE.
 */
export async function readLease(path: string, timing?: LeaseReadTiming): Promise<LeaseRecord | null> {
  const attempts = Math.max(1, timing?.attempts ?? READ_ATTEMPTS);
  const interval = timing?.intervalMs ?? READ_INTERVAL_MS;
  let why = "";
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(interval);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      why = (err as Error).message;
      continue;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (!text.trim()) {
      why = "it is empty";
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        why = "it is not a JSON object";
        continue;
      }
      return normalizeLease(parsed as Record<string, unknown>);
    } catch (err) {
      why = `invalid JSON: ${(err as Error).message}`;
    }
  }
  throw new EmuError(
    "LEASE_UNREADABLE",
    `Cannot read the lease file ${path} (${why}). Look at it; delete it only when no session uses the emulator.`,
  );
}

export function isLeaseValid(lease: LeaseRecord | null, now: Date = new Date()): boolean {
  if (!lease) return false;
  const until = parseLeaseDate(lease.expiresAt);
  if (!until) return true; // fail safe, like PS: an unreadable time counts as still held
  return until.getTime() > now.getTime();
}

export function busyMessage(lease: LeaseRecord, avd: string): string {
  return (
    `BUSY: AVD '${avd}' is leased by ${lease.owner} (host ${lease.host}, since ${lease.acquiredAt}, until ${lease.expiresAt}). ` +
    "Another session is using the emulator: do not install, tap or change its settings. Wait, or ask the person; " +
    "only the person releases someone else's lease (emu-lab release --any-owner)."
  );
}

function serializeLease(lease: LeaseRecord): string {
  const ordered: Record<string, unknown> = {};
  for (const k of KNOWN_FIELDS) ordered[k] = lease[k] === undefined ? null : lease[k];
  ordered.installed = normalizeInstalled(lease.installed);
  for (const [k, v] of Object.entries(lease)) {
    if ((KNOWN_FIELDS as readonly string[]).includes(k) || v === undefined) continue;
    ordered[k] = v;
  }
  const eol = process.platform === "win32" ? "\r\n" : "\n";
  let json = JSON.stringify(ordered, null, 2);
  if (eol !== "\n") json = json.replace(/\n/g, eol);
  return json + eol;
}

function isRetryableFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

// Replacing writes to one file from this process run one after another (they share the <path>.<pid>.tmp name).
const writeChains = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  writeChains.set(key, tail);
  void tail.then(() => {
    if (writeChains.get(key) === tail) writeChains.delete(key);
  });
  return next;
}

/**
 * create: make the file only if it does not exist (the lock; EEXIST otherwise). Else replace it in one step
 * (temp file + rename; a reader holding the file on Windows makes the rename fail for a moment, so retry).
 */
export async function writeLease(file: string, lease: LeaseRecord, opts: { create: boolean }): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const data = Buffer.from(serializeLease(lease), "utf8");
  if (opts.create) {
    const fh = await open(file, "wx");
    try {
      await fh.writeFile(data);
    } finally {
      await fh.close();
    }
    return;
  }
  await serialized(path.resolve(file), () => replaceFile(file, data));
}

async function replaceFile(file: string, data: Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
  const attempts = process.platform === "win32" ? RENAME_ATTEMPTS : 1;
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, file);
      return;
    } catch (err) {
      if (i + 1 < attempts && isRetryableFsError(err)) {
        await sleep(RENAME_INTERVAL_MS);
        continue;
      }
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }
}

/** Delete the lease file (gone already is fine). */
export async function removeLease(file: string): Promise<void> {
  const attempts = process.platform === "win32" ? RENAME_ATTEMPTS : 1;
  for (let i = 0; ; i++) {
    try {
      await unlink(file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (i + 1 < attempts && isRetryableFsError(err)) {
        await sleep(RENAME_INTERVAL_MS);
        continue;
      }
      throw err;
    }
  }
}

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/** The lock file next to the lease. */
export function leaseLockPath(file: string): string {
  return `${file}.lock`;
}

/** Internal test hooks (not part of the API): run just before a stale lock is moved aside. */
export const leaseLockTestHooks: { beforeStaleMove?: (lock: string) => Promise<void> } = {};

async function lockState(file: string): Promise<{ text: string; mtimeMs: number } | null> {
  try {
    const before = (await stat(file)).mtimeMs;
    const text = await readFile(file, "utf8");
    const after = (await stat(file)).mtimeMs;
    return before === after ? { text, mtimeMs: after } : null;
  } catch {
    return null;
  }
}

/**
 * A lock left behind by a killed process: move it aside and delete it. True when it was removed (or is gone).
 *
 * Two waiters can both see the same stale lock; the first drops it and creates a fresh one, and the second would
 * then move that fresh lock aside. So the file moved aside is compared with the stale one that was judged (same
 * token and mtime); when it is another one, it is put back (link: only when nothing took its place) and this waiter
 * keeps waiting.
 */
async function dropStaleLock(lock: string): Promise<boolean> {
  const seen = await lockState(lock);
  if (!seen) {
    try {
      await stat(lock);
      return false; // it changed while we looked: look again on the next round
    } catch (err) {
      return errnoOf(err) === "ENOENT"; // gone meanwhile: try again at once
    }
  }
  if (Date.now() - seen.mtimeMs < LOCK_STALE_MS) return false;
  if (leaseLockTestHooks.beforeStaleMove) await leaseLockTestHooks.beforeStaleMove(lock);
  const aside = `${lock}.${process.pid}.${randomUUID()}.stale`;
  try {
    await rename(lock, aside);
  } catch {
    return false;
  }
  const moved = await lockState(aside);
  if (moved && moved.text === seen.text && moved.mtimeMs === seen.mtimeMs) {
    await unlink(aside).catch(() => {});
    return true;
  }
  // Not the stale lock: another waiter's fresh one. Put it back unless a new lock already took its place.
  try {
    await link(aside, lock);
  } catch (err) {
    if (errnoOf(err) !== "EEXIST") {
      // No hard links on this file system: rename back while the path is free.
      let free = false;
      try {
        await stat(lock);
      } catch (e) {
        free = errnoOf(e) === "ENOENT";
      }
      if (free) {
        await rename(aside, lock).catch(() => {});
        return false;
      }
    }
  }
  await unlink(aside).catch(() => {});
  return false;
}

async function releaseLock(lock: string, token: string): Promise<void> {
  // Delete only our own lock (a waiter may have dropped it as stale and taken it).
  let text = "";
  try {
    text = await readFile(lock, "utf8");
  } catch {
    return;
  }
  if (text !== token) return;
  const attempts = process.platform === "win32" ? RENAME_ATTEMPTS : 1;
  for (let i = 0; ; i++) {
    try {
      await unlink(lock);
      return;
    } catch (err) {
      if (errnoOf(err) === "ENOENT") return;
      if (i + 1 < attempts && isRetryableFsError(err)) {
        await sleep(RENAME_INTERVAL_MS);
        continue;
      }
      return; // a leftover lock is dropped as stale by the next session
    }
  }
}

/**
 * Run `fn` while holding <lease>.lock (created with "wx", so one holder at a time across processes). A lock older
 * than 10 s is treated as left by a killed process; waiting longer than 15 s gives LEASE_UNREADABLE.
 */
export async function withLeaseLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = leaseLockPath(file);
  await mkdir(path.dirname(file), { recursive: true });
  const token = `${process.pid} ${randomUUID()} ${new Date().toISOString()}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fh = await open(lock, "wx");
      try {
        await fh.writeFile(token);
      } finally {
        await fh.close();
      }
      break;
    } catch (err) {
      const code = errnoOf(err);
      if (code !== "EEXIST" && !isRetryableFsError(err)) throw err;
      if (code === "EEXIST" && (await dropStaleLock(lock))) continue;
      if (Date.now() >= deadline) {
        throw new EmuError(
          "LEASE_UNREADABLE",
          `The lease lock ${lock} stayed taken for ${LOCK_WAIT_MS / 1000} s. Another emu-lab command may hang on it; ` +
            "delete the .lock file only when no emu-lab command runs.",
        );
      }
      await sleep(LOCK_POLL_MS + Math.floor(Math.random() * LOCK_POLL_MS));
    }
  }
  try {
    return await fn();
  } finally {
    await releaseLock(lock, token);
  }
}

/** The lease at `file` is no longer the one this call read (another session took it over, or it is gone). */
function leaseChanged(file: string, expect: LeaseRecord, cur: LeaseRecord | null, avd: string): EmuError {
  const now = cur ? `it is now held by ${cur.owner} (since ${cur.acquiredAt}, until ${cur.expiresAt})` : "it is gone";
  return new EmuError(
    "LEASE_CHANGED",
    `LEASE_CHANGED the lease of AVD '${avd}' (${file}) is no longer the one of ${expect.owner} since ${expect.acquiredAt}: ${now}. ` +
      "Stopped before changing the device or the lease; another session may be using the emulator.",
  );
}

/**
 * Before acting on a lease read earlier: throws LEASE_CHANGED unless the file still holds the same lease
 * (same owner and acquiredAt).
 */
export async function assertSameLease(file: string, expect: LeaseRecord, avd: string = expect.avd): Promise<LeaseRecord> {
  const cur = await readLease(file);
  if (!cur || !sameLease(cur, expect)) throw leaseChanged(file, expect, cur, avd);
  return cur;
}

/** What holdLease did: the current lease, and the expiresAt it replaced (null when it wrote nothing). */
export interface LeaseHold {
  lease: LeaseRecord;
  /** The expiresAt that was in the file right before the hold extended it; null when the hold did not write. */
  replacedExpiresAt: string | null;
}

/**
 * Keep a lease read earlier from running out for `holdMs` (release: it cannot be taken over while it runs).
 * Throws LEASE_CHANGED when the file no longer holds that lease. The result says which expiresAt the hold replaced
 * (read under the lock, so a renewal between the caller's read and the hold is what a give-back restores).
 */
export async function holdLease(
  file: string,
  expect: LeaseRecord,
  holdMs: number,
  o: { avd?: string; now?: Date } = {},
): Promise<LeaseHold> {
  return withLeaseLock(file, async () => {
    const cur = await readLease(file);
    if (!cur || !sameLease(cur, expect)) throw leaseChanged(file, expect, cur, o.avd ?? expect.avd);
    const now = o.now ?? new Date();
    const until = parseLeaseDate(cur.expiresAt);
    if (until && until.getTime() >= now.getTime() + holdMs) return { lease: cur, replacedExpiresAt: null };
    const lease: LeaseRecord = { ...cur, expiresAt: formatLocalIso(new Date(now.getTime() + holdMs)) };
    await writeLease(file, lease, { create: false });
    return { lease, replacedExpiresAt: cur.expiresAt };
  });
}

/**
 * Undo a holdLease that extended a lease: put back the expiresAt the hold replaced, but only while the file still
 * holds the held lease with the held expiresAt (nobody renewed or replaced it since). Nothing when the hold did not
 * write. True when it was put back.
 */
export async function giveBackHold(file: string, hold: LeaseHold): Promise<boolean> {
  const original = hold.replacedExpiresAt;
  if (original === null || original === hold.lease.expiresAt) return false;
  return withLeaseLock(file, async () => {
    const cur = await readLease(file);
    if (!cur || !sameLease(cur, hold.lease) || cur.expiresAt !== hold.lease.expiresAt) return false;
    await writeLease(file, { ...cur, expiresAt: original }, { create: false });
    return true;
  });
}

/**
 * Delete the lease only while it is still `expect` (same owner and acquiredAt; with `expired`, also still run out:
 * NOT_STALE otherwise). "gone" when there is no lease any more; another lease there throws LEASE_CHANGED.
 */
export async function removeLeaseIfSame(
  file: string,
  expect: LeaseRecord,
  o: { expired?: boolean; avd?: string; now?: Date } = {},
): Promise<"removed" | "gone"> {
  return withLeaseLock(file, async () => {
    const cur = await readLease(file);
    if (!cur) return "gone";
    if (!sameLease(cur, expect)) throw leaseChanged(file, expect, cur, o.avd ?? expect.avd);
    if (o.expired && isLeaseValid(cur, o.now ?? new Date())) {
      throw new EmuError(
        "NOT_STALE",
        `NOT_STALE the lease of ${cur.owner} was renewed and is valid until ${cur.expiresAt}. --stale drops only a lease that ran out.`,
      );
    }
    await removeLease(file);
    return "removed";
  });
}

function checkHours(hours: number): void {
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new EmuError("BAD_OPTION", `hours must be a number greater than 0 (got ${hours}).`);
  }
}

function addHours(now: Date, hours: number): Date {
  return new Date(now.getTime() + hours * 3_600_000);
}

/**
 * Take or renew the lease. Same owner: renew. Another owner's valid lease: BUSY (nothing touched). Expired: take it
 * over. None: create. Losing the create race to another session gives BUSY.
 */
export async function enterLease(o: {
  path: string;
  avd: string;
  owner: string;
  hours: number;
  host: string;
  now?: Date;
  report: Report;
}): Promise<{ action: "new" | "renewed" | "takeover"; lease: LeaseRecord }> {
  checkHours(o.hours);
  const now = o.now ?? new Date();
  const until = formatLocalIso(addHours(now, o.hours));
  return withLeaseLock(o.path, async () => {
    const cur = await readLease(o.path);
    if (cur && sameOwner(cur.owner, o.owner)) {
      const lease: LeaseRecord = { ...cur, expiresAt: until };
      await writeLease(o.path, lease, { create: false });
      return { action: "renewed" as const, lease };
    }
    let action: "new" | "takeover" = "new";
    if (cur) {
      if (isLeaseValid(cur, now)) throw new EmuError("BUSY", busyMessage(cur, o.avd));
      action = "takeover";
      o.report(
        `LEASE_TAKEOVER the lease of ${cur.owner} ran out at ${cur.expiresAt}; taking it over (an emulator it started keeps running)`,
      );
      // Under the lock no other session of this package can recreate the file between this read and the delete.
      await removeLease(o.path);
    }
    const lease: LeaseRecord = {
      avd: o.avd,
      owner: o.owner,
      host: o.host,
      acquiredAt: formatLocalIso(now),
      expiresAt: until,
      startedEmulator: false,
      emulatorPid: null,
      emulatorStartedAt: null,
      installed: [],
    };
    try {
      await writeLease(o.path, lease, { create: true });
    } catch (err) {
      if (errnoOf(err) === "EEXIST") {
        // A PowerShell session (it does not take the lock) created the file between our read and our create.
        let other: LeaseRecord | null = null;
        try {
          other = await readLease(o.path);
        } catch {
          other = null;
        }
        if (other && !sameOwner(other.owner, o.owner)) throw new EmuError("BUSY", busyMessage(other, o.avd));
      }
      throw err;
    }
    // Confirm the file holds our lease: a PowerShell takeover of the same expired lease may have replaced it.
    let after: LeaseRecord | null = null;
    try {
      after = await readLease(o.path);
    } catch {
      after = null;
    }
    if (after && !sameOwner(after.owner, o.owner)) throw new EmuError("BUSY", busyMessage(after, o.avd));
    if (!after) throw leaseChanged(o.path, lease, null, o.avd);
    return { action, lease: after };
  });
}

/** Extend our own lease (valid or expired) by `hours` from now. */
export async function renewLease(o: { path: string; avd: string; owner: string; hours: number; now?: Date }): Promise<LeaseRecord> {
  checkHours(o.hours);
  const now = o.now ?? new Date();
  return withLeaseLock(o.path, async () => {
    const cur = await readLease(o.path);
    if (!cur) {
      throw new EmuError("NO_LEASE", `NO_LEASE: AVD '${o.avd}' has no lease to renew; take it with emu-lab start (MCP: emu_start).`);
    }
    if (!sameOwner(cur.owner, o.owner)) {
      if (isLeaseValid(cur, now)) {
        throw new EmuError("NOT_OWNER", "NOT_OWNER: " + busyMessage(cur, o.avd).replace(/^BUSY:\s*/, ""));
      }
      throw new EmuError(
        "NOT_OWNER",
        `NOT_OWNER AVD '${o.avd}' is leased by ${cur.owner}, not by ${o.owner}, and that lease ran out at ${cur.expiresAt}. ` +
          "Take it over with emu-lab start (MCP: emu_start).",
      );
    }
    const lease: LeaseRecord = { ...cur, expiresAt: formatLocalIso(addHours(now, o.hours)) };
    await writeLease(o.path, lease, { create: false });
    return lease;
  });
}

/** Change fields of our own lease. False when the lease is gone or someone else's. */
export async function updateLease(file: string, owner: string, set: Partial<LeaseRecord>): Promise<boolean> {
  return withLeaseLock(file, async () => {
    const cur = await readLease(file);
    if (!cur || !sameOwner(cur.owner, owner)) return false;
    const lease: LeaseRecord = { ...cur };
    for (const [k, v] of Object.entries(set)) {
      if (v !== undefined) lease[k] = v;
    }
    await writeLease(file, lease, { create: false });
    return true;
  });
}

let leaseNoneWarned = false;

/** Tests: forget that LEASE_NONE was already reported in this process. */
export function resetLeaseWarning(): void {
  leaseNoneWarned = false;
}

/**
 * Before changing the device: another owner's valid lease stops us (BUSY); our valid lease is returned. Without a
 * usable lease, "warn" reports LEASE_NONE once per process and returns null, "strict" throws NO_LEASE.
 */
export async function assertLeaseUsable(o: {
  path: string;
  avd: string;
  owner: string;
  mode: "strict" | "warn";
  report: Report;
  now?: Date;
}): Promise<LeaseRecord | null> {
  const now = o.now ?? new Date();
  const cur = await readLease(o.path);
  if (cur && isLeaseValid(cur, now)) {
    if (!sameOwner(cur.owner, o.owner)) throw new EmuError("BUSY", busyMessage(cur, o.avd));
    return cur;
  }
  const why = cur ? `the lease of ${cur.owner} ran out at ${cur.expiresAt}` : "no session holds it";
  if (o.mode === "strict") {
    throw new EmuError(
      "NO_LEASE",
      `NO_LEASE: AVD '${o.avd}' is not leased by ${o.owner} (${why}). Take it first with emu_start (CLI: emu-lab start).`,
    );
  }
  if (!leaseNoneWarned) {
    leaseNoneWarned = true;
    o.report(
      `LEASE_NONE AVD '${o.avd}' is not leased (${why}). Run emu-lab start first so other sessions see the emulator as busy, and emu-lab release when done.`,
    );
  }
  return null;
}

/** Remember an app installed under our lease (release --uninstall removes it). Only on our own lease; once. */
export async function addInstalled(file: string, owner: string, pkg: string): Promise<void> {
  await withLeaseLock(file, async () => {
    const cur = await readLease(file);
    if (!cur || !sameOwner(cur.owner, owner)) return;
    const list = normalizeInstalled(cur.installed);
    if (list.includes(pkg)) return;
    list.push(pkg);
    await writeLease(file, { ...cur, installed: list }, { create: false });
  });
}
