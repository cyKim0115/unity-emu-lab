// One directory per run (smoke, notification check), never shared. Mirrors New-RunDir in scripts/common.ps1:
// <runsDir>/<yyyyMMdd-HHmmss>-<kind>-<pid>, then -2, -3 ... when a run of the same process started in the same
// second. Runs started in the same second by parallel sessions differ by pid.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locations } from "./config.ts";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** yyyyMMdd-HHmmss in the host's local time (the PS Get-Date -Format stamp). */
export function runStamp(d: Date = new Date()): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * Creates and returns a new run directory. `outDir` (absolute or relative to the current directory) is used as
 * is: created when missing, and an existing one is reused, like check-notification.ps1 -RunDir.
 */
export async function newRunDir(loc: Locations, kind: string, outDir?: string): Promise<string> {
  if (outDir !== undefined && outDir.trim()) {
    const dir = path.resolve(outDir.trim());
    await mkdir(dir, { recursive: true });
    return dir;
  }
  await mkdir(loc.runsDir, { recursive: true });
  const base = path.join(loc.runsDir, `${runStamp()}-${kind}-${process.pid}`);
  for (let n = 1; ; n++) {
    const dir = n === 1 ? base : `${base}-${n}`;
    try {
      // Not recursive: EEXIST tells us the name is taken (also when another call of this process won the race).
      await mkdir(dir);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}
