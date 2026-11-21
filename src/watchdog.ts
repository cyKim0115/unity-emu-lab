// Watchdog for a hidden Unity build: started detached next to it, it stops the build's process tree when the process
// that started the build is gone (an agent tool timeout or a closed terminal killed it before its cleanup ran), and
// ends by itself when the build ends. Mirrors scripts/watch-parent.ps1.
//
//   node watchdog.js <parentPid> <childPid> [<child start time, ISO>]

import { isAlive, stopProcessTree } from "./project-lock.ts";
import { sleep } from "./proc.ts";

const POLL_MS = 1_000;

async function main(): Promise<void> {
  const parent = Number(process.argv[2]);
  const child = Number(process.argv[3]);
  const started = process.argv[4] ? new Date(process.argv[4]) : undefined;
  if (!Number.isInteger(parent) || !Number.isInteger(child) || parent <= 0 || child <= 0) process.exit(2);
  for (;;) {
    if (!isAlive(child)) return;
    if (!isAlive(parent)) {
      await stopProcessTree(child, { rootStarted: started && !Number.isNaN(started.getTime()) ? started : undefined });
      return;
    }
    await sleep(POLL_MS);
  }
}

main().then(
  () => process.exit(0),
  () => process.exit(1),
);
