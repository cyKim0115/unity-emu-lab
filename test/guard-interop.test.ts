// The guard state folder must work both ways with scripts/project-guard.ps1 (Windows PowerShell 5.1): a snapshot taken
// by one side is reported and reverted by the other, with the same safety refusals. Windows only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { guardReport, guardRevert, guardSnapshot } from "../src/guard.ts";
import type { LockProbe } from "../src/project-lock.ts";
import { tempLabHome } from "./helpers/fake.ts";

const skip = process.platform !== "win32" ? "PowerShell interop runs on Windows only" : false;
const GUARD_PS1 = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "project-guard.ps1");
const FREE: LockProbe = { isLocked: async () => false, processes: async () => [] };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function repo(): string {
  const top = path.join(tempLabHome(), "내 프로젝트 [1]");
  mkdirSync(path.join(top, "Assets"), { recursive: true });
  git(top, ["init", "-q"]);
  for (const [k, v] of [["user.email", "test@example.invalid"], ["user.name", "Test"], ["core.autocrlf", "false"], ["commit.gpgsign", "false"]]) git(top, ["config", k, v]);
  writeFileSync(path.join(top, "Assets", "A.cs"), "class A {}\n");
  writeFileSync(path.join(top, "Assets", "B.asset"), "b: 1\n");
  git(top, ["add", "-A"]);
  git(top, ["commit", "-q", "-m", "init"]);
  return top;
}

function ps(project: string, mode: string, stateDir: string, extra: string[] = []): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", GUARD_PS1, "-ProjectPath", project, "-Mode", mode, "-StateDir", stateDir, ...extra],
      { timeout: 120_000, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
        if (code === -1) return reject(new Error(`powershell failed: ${err?.message}\n${stderr}`));
        resolve({ code, out: String(stdout) + String(stderr) });
      },
    );
  });
}

const o = (project: string, stateDir: string) => ({ projectPath: project, stateDir, report: () => {}, deps: { lock: FREE } });

test("Node snapshot -> PowerShell report -> Node revert", { skip, timeout: 180_000 }, async () => {
  const p = repo();
  const state = path.join(tempLabHome(), "state");
  writeFileSync(path.join(p, "Assets", "A.cs"), "class A { mine }\n");
  await guardSnapshot(o(p, state));
  writeFileSync(path.join(p, "Assets", "B.asset"), "b: build\n");
  writeFileSync(path.join(p, "Assets", "Gen 생성.cs"), "// gen\n");
  const r = await ps(p, "Report", state);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /GUARD_REPORT changed=1 created=1 staged=0 preexisting_touched=0/);
  const rev = await guardRevert(o(p, state));
  assert.deepEqual(rev.reverted, ["Assets/B.asset"]);
  assert.deepEqual(rev.moved.map((m) => m.path), ["Assets/Gen 생성.cs"]);
  assert.equal(readFileSync(path.join(p, "Assets", "A.cs"), "utf8"), "class A { mine }\n", "the person's change stays");
  assert.equal(readFileSync(path.join(p, "Assets", "B.asset"), "utf8"), "b: 1\n");
});

test("PowerShell snapshot -> Node report -> PowerShell revert; PowerShell refuses a change after the Node report", { skip, timeout: 180_000 }, async () => {
  const p = repo();
  const state = path.join(tempLabHome(), "state");
  const s = await ps(p, "Snapshot", state);
  assert.equal(s.code, 0, s.out);
  writeFileSync(path.join(p, "Assets", "B.asset"), "b: build\n");
  writeFileSync(path.join(p, "Assets", "Gen.cs"), "// gen\n");
  const rep = await guardReport(o(p, state));
  assert.deepEqual(rep.changed, ["Assets/B.asset"]);
  assert.deepEqual(rep.created, ["Assets/Gen.cs"]);
  writeFileSync(path.join(p, "Assets", "B.asset"), "b: edited after the report\n");
  const refused = await ps(p, "Revert", state);
  assert.notEqual(refused.code, 0, refused.out);
  assert.match(refused.out, /changed after the Report/);
  writeFileSync(path.join(p, "Assets", "B.asset"), "b: build\n");
  const ok = await ps(p, "Revert", state);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /GUARD_REVERT reverted=1 moved=1/);
  assert.equal(readFileSync(path.join(p, "Assets", "B.asset"), "utf8"), "b: 1\n");
  assert.equal(existsSync(path.join(p, "Assets", "Gen.cs")), false);
});
