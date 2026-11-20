// In-memory job registry for the MCP server. Long tools (emu_start, emu_smoke, emu_check_notification,
// emu_release) run as jobs: the tool waits up to wait_sec for the result and otherwise hands back the job id,
// which emu_job waits on later. Each job keeps its own report lines (the last 400), so nothing is printed to
// stdout (an MCP stdio server's stdout belongs to the transport).
//
// At most one device-changing job per AVD runs at a time in this process: a second one is refused with an error
// naming the running job (another session is kept out by the lease file instead). emu_clock holds the AVD the same
// way for the length of its call (runExclusive) but answers inline.

import { EmuError } from "./errors.ts";
import type { Report } from "./types.ts";

export type JobStatus = "running" | "done" | "failed";

/** How many report lines a job keeps. */
export const JOB_MAX_LINES = 400;
/** How many lines a job view returns by default. */
export const JOB_TAIL_LINES = 40;
/** Finished jobs kept for emu_job (the oldest finished ones are dropped first). */
export const JOB_MAX_FINISHED = 50;
/** Longest single wait (seconds). */
export const JOB_MAX_WAIT_SEC = 600;

export interface JobView {
  id: string;
  kind: string;
  avd?: string;
  status: JobStatus;
  elapsed_sec: number;
  lines: string[];
  result?: unknown;
  /** "<CODE>: message" (EmuError) or the error message. */
  error?: string;
  /** Machine-readable code of the error, when it has one. */
  error_code?: string;
}

export interface JobSummary {
  id: string;
  kind: string;
  avd?: string;
  status: JobStatus;
  elapsed_sec: number;
  error?: string;
}

interface Job {
  id: string;
  kind: string;
  avd?: string;
  /** Holds the AVD while it runs (device-changing). */
  exclusive: boolean;
  startedAt: number;
  endedAt: number | null;
  status: JobStatus;
  lines: string[];
  result?: unknown;
  error?: unknown;
  done: Promise<void>;
}

/** A second device-changing job on an AVD that already has one running in this process: EmuError JOB_RUNNING. */
export function jobRunningError(jobId: string, kind: string, avd: string): EmuError {
  return new EmuError(
    "JOB_RUNNING",
    `JOB_RUNNING: job ${jobId} (${kind}) is still changing AVD '${avd}' in this server. ` +
      `Wait for it with emu_job (job_id "${jobId}") before starting another device-changing tool.`,
  );
}

/** The error code of anything thrown (EmuError, Node errors), if it has one. */
export function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : undefined;
}

/** "<CODE>: message" without doubling the token when the message already starts with it. */
export function formatError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof EmuError ? err.code : errorCode(err);
  if (!code) return message;
  if (message.startsWith(code)) return message;
  return `${code}: ${message}`;
}

function elapsedSec(job: Job, now = Date.now()): number {
  const end = job.endedAt ?? now;
  return Math.round((end - job.startedAt) / 100) / 10;
}

export class JobRegistry {
  private readonly jobs = new Map<string, Job>();
  private counter = 0;

  /** The running device-changing job on `avd`, if any. */
  runningOn(avd: string): { id: string; kind: string } | null {
    for (const job of this.jobs.values()) {
      if (job.status === "running" && job.exclusive && job.avd === avd) return { id: job.id, kind: job.kind };
    }
    return null;
  }

  /** Throws EmuError JOB_RUNNING when a device-changing job runs on `avd`. */
  assertFree(avd: string): void {
    const busy = this.runningOn(avd);
    if (busy) throw jobRunningError(busy.id, busy.kind, avd);
  }

  /**
   * Start `fn` in the background and return its id (`<kind>-<n>-<base36 time>`). With `avd` and `exclusive`
   * (the default when an AVD is given) a second device-changing job on the same AVD is refused synchronously.
   */
  startJob(kind: string, fn: (report: Report) => Promise<unknown>, o: { avd?: string; exclusive?: boolean } = {}): string {
    const exclusive = o.avd !== undefined && o.exclusive !== false;
    if (exclusive && o.avd !== undefined) this.assertFree(o.avd);
    this.counter += 1;
    const id = `${kind}-${this.counter}-${Date.now().toString(36)}`;
    const job: Job = {
      id,
      kind,
      avd: o.avd,
      exclusive,
      startedAt: Date.now(),
      endedAt: null,
      status: "running",
      lines: [],
      done: Promise.resolve(),
    };
    const report: Report = (line: string) => {
      for (const l of String(line).split(/\r?\n/)) {
        job.lines.push(l);
      }
      if (job.lines.length > JOB_MAX_LINES) job.lines.splice(0, job.lines.length - JOB_MAX_LINES);
    };
    this.jobs.set(id, job);
    job.done = (async () => {
      try {
        // Run after this call returns, so a synchronous throw in fn is also recorded as the job's error.
        await Promise.resolve();
        job.result = await fn(report);
        job.status = "done";
      } catch (err) {
        job.error = err;
        job.status = "failed";
      } finally {
        job.endedAt = Date.now();
        this.prune();
      }
    })();
    return id;
  }

  /**
   * Run `fn` as a device-changing job on `avd` and wait for it inline (emu_clock): other device-changing jobs on the
   * AVD are refused with JOB_RUNNING while it runs, and it is refused while one of them runs. Throws what fn throws.
   */
  async runExclusive<T>(kind: string, avd: string, fn: () => Promise<T>): Promise<T> {
    const id = this.startJob(kind, () => fn(), { avd });
    const job = this.jobs.get(id);
    if (!job) throw new Error(`job ${id} vanished`);
    await job.done;
    if (job.status === "failed") throw job.error;
    return job.result as T;
  }

  /** Has a job with this id. */
  has(id: string): boolean {
    return this.jobs.has(id);
  }

  /**
   * Wait up to `waitSec` (0..600) for the job to finish and return its view. Unknown id → EmuError JOB_UNKNOWN.
   */
  async waitJob(id: string, waitSec: number, o: { tail?: number } = {}): Promise<JobView> {
    const job = this.jobs.get(id);
    if (!job) {
      const known = [...this.jobs.keys()];
      throw new EmuError(
        "JOB_UNKNOWN",
        `JOB_UNKNOWN: no job '${id}' in this server` +
          (known.length ? ` (known: ${known.slice(-10).join(", ")})` : " (it has no jobs; jobs do not survive a server restart)") +
          ". Call emu_job without job_id to list the jobs.",
      );
    }
    const wait = Math.min(Math.max(Number.isFinite(waitSec) ? waitSec : 0, 0), JOB_MAX_WAIT_SEC);
    if (job.status === "running" && wait > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        job.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, wait * 1000);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    return this.view(job, o.tail ?? JOB_TAIL_LINES);
  }

  /** All jobs, newest first. */
  list(): JobSummary[] {
    return [...this.jobs.values()].reverse().map((job) => {
      const s: JobSummary = { id: job.id, kind: job.kind, status: job.status, elapsed_sec: elapsedSec(job) };
      if (job.avd !== undefined) s.avd = job.avd;
      if (job.status === "failed") s.error = formatError(job.error);
      return s;
    });
  }

  private view(job: Job, tail: number): JobView {
    const v: JobView = {
      id: job.id,
      kind: job.kind,
      status: job.status,
      elapsed_sec: elapsedSec(job),
      lines: tail > 0 ? job.lines.slice(-tail) : [],
    };
    if (job.avd !== undefined) v.avd = job.avd;
    if (job.status === "done") v.result = job.result;
    if (job.status === "failed") {
      v.error = formatError(job.error);
      const code = errorCode(job.error);
      if (code) v.error_code = code;
    }
    return v;
  }

  private prune(): void {
    const finished = [...this.jobs.values()].filter((j) => j.status !== "running");
    for (let i = 0; i < finished.length - JOB_MAX_FINISHED; i++) this.jobs.delete(finished[i].id);
  }
}

// A process-wide registry for callers that do not keep their own (the server creates one per instance).
const defaultRegistry = new JobRegistry();

export function startJob(kind: string, fn: (report: Report) => Promise<unknown>, o: { avd?: string; exclusive?: boolean } = {}): string {
  return defaultRegistry.startJob(kind, fn, o);
}

export function waitJob(id: string, waitSec: number): Promise<JobView> {
  return defaultRegistry.waitJob(id, waitSec);
}

export function listJobs(): JobSummary[] {
  return defaultRegistry.list();
}
