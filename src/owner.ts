// Lease owner ids, the same rules as Get-EmuOwner in scripts/common.ps1 and unity-slot:
// EMU_OWNER, claude:<session id first 8>, codex:<thread id last 8>, else user@host.

import os from "node:os";

export function getOwner(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const explicit = (env.EMU_OWNER ?? "").trim();
  if (explicit) return explicit;
  const claude = env.CLAUDE_CODE_SESSION_ID;
  if (claude) return "claude:" + claude.slice(0, 8);
  const codex = env.CODEX_THREAD_ID;
  if (codex) return "codex:" + codex.slice(Math.max(0, codex.length - 8));
  if (platform === "win32") {
    // Exactly PS "$env:USERNAME@$env:COMPUTERNAME", so a person running the scripts and the CLI is one owner.
    return `${env.USERNAME ?? ""}@${env.COMPUTERNAME ?? ""}`;
  }
  let user = "";
  try {
    user = os.userInfo().username;
  } catch {
    user = env.USER ?? env.LOGNAME ?? "";
  }
  return `${user}@${os.hostname()}`;
}

/** The host written into a lease: Windows COMPUTERNAME (like PS), else os.hostname(). */
export function hostName(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return env.COMPUTERNAME || os.hostname();
  return os.hostname();
}
