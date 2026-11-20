// Entry point of `emu-lab` / `unity-emu-lab` (bin/emu-lab.js imports this file).
// No arguments: stdin is not a terminal → the MCP server on stdio (how MCP clients launch it); a terminal → help.
// `emu-lab serve` starts the server explicitly. In serve mode nothing but the MCP transport writes to stdout.

import { runCli } from "./cli.ts";
import { formatError } from "./jobs.ts";
import { serve } from "./server.ts";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 && !process.stdin.isTTY) {
    await serve();
    return;
  }
  const code = await runCli(argv);
  if (code !== null) process.exitCode = code;
}

main().catch((err) => {
  process.stderr.write(`${formatError(err)}\n`);
  process.exit(1);
});
