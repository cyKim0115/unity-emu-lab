// Project guard (src/guard.ts) on real git repositories in temp folders: what a snapshot records, what the report
// lists, and that the revert touches only what the build changed and the person approved. The person's own work
// (changes before the build, staged changes, files they kept) must never be reverted, moved or lost.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isEmuError } from "../src/errors.ts";
import { defaultStateDir, fileHashText, guardReport, guardRevert, guardSnapshot, guardState, parseNumstatZ, parseStatusZ, type GuardOptions } from "../src/guard.ts";
import type { LockProbe, UnityProcess } from "../src/project-lock.ts";
import { addTemplate } from "../src/template.ts";
import { tempLabHome } from "./helpers/fake.ts";

const FREE: LockProbe = { isLocked: async () => false, processes: async () => [] };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A repository with one commit: Assets/A.cs, Assets/B.asset, ProjectSettings/ProjectSettings.asset, a binary file. */
function repo(o: { sub?: string } = {}): { top: string; proj: string } {
  const top = path.join(tempLabHome(), "repo root");
  mkdirSync(top, { recursive: true });
  git(top, ["init", "-q"]);
  for (const [k, v] of [
    ["user.email", "test@example.invalid"],
    ["user.name", "Test"],
    ["core.autocrlf", "false"],
    ["commit.gpgsign", "false"],
  ]) {
    git(top, ["config", k, v]);
  }
  const proj = o.sub ? path.join(top, o.sub) : top;
  for (const [rel, text] of [
    ["Assets/A.cs", "class A {}\n"],
    ["Assets/B.asset", "b: 1\n"],
    ["ProjectSettings/ProjectSettings.asset", "companyName: Me\n"],
    ["Assets/[x] 그림 1.txt", "korean and brackets\n"],
  ]) {
    mkdirSync(path.dirname(path.join(proj, rel)), { recursive: true });
    writeFileSync(path.join(proj, rel), text);
  }
  writeFileSync(path.join(proj, "Assets", "tex.bin"), Buffer.from([0, 1, 2, 3, 255, 0, 7]));
  if (o.sub) {
    writeFileSync(path.join(top, "outside.txt"), "outside the project\n");
  }
  git(top, ["add", "-A"]);
  git(top, ["commit", "-q", "-m", "init"]);
  return { top, proj };
}

interface Bench {
  home: string;
  lines: string[];
  o: (extra?: Partial<GuardOptions & { keep: string | string[]; replace: boolean }>) => GuardOptions & { keep?: string | string[]; replace?: boolean };
}

function bench(proj: string, lock: LockProbe = FREE): Bench {
  const home = tempLabHome();
  const lines: string[] = [];
  return {
    home,
    lines,
    o: (extra = {}) => ({ projectPath: proj, env: { ...process.env, EMU_LAB_HOME: home }, report: (l) => lines.push(l), deps: { lock }, ...extra }),
  };
}

function write(proj: string, rel: string, text: string | Buffer): void {
  mkdirSync(path.dirname(path.join(proj, rel)), { recursive: true });
  writeFileSync(path.join(proj, rel), text);
}

function read(proj: string, rel: string): string {
  return readFileSync(path.join(proj, rel), "utf8");
}

async function refused(p: Promise<unknown>, code: string, msg?: RegExp): Promise<void> {
  try {
    await p;
  } catch (err) {
    assert.ok(isEmuError(err), String(err));
    assert.equal((err as { code: string }).code, code, (err as Error).message);
    if (msg) assert.match((err as Error).message, msg);
    return;
  }
  assert.fail(`expected ${code}`);
}

/** Everything git sees as changed, for "nothing changed" checks. */
function porcelain(top: string): string {
  return git(top, ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-uall"]);
}

describe("parsers", () => {
  test("status -z: XY and path, renames keep the new path", () => {
    const raw = " M Assets/A.cs\0?? Assets/new file.txt\0R  Assets/New.cs\0Assets/Old.cs\0A  Assets/x.cs\0";
    assert.deepEqual(parseStatusZ(raw), [
      { Path: "Assets/A.cs", XY: " M" },
      { Path: "Assets/new file.txt", XY: "??" },
      { Path: "Assets/New.cs", XY: "R " },
      { Path: "Assets/x.cs", XY: "A " },
    ]);
  });

  test("numstat -z paths", () => {
    assert.deepEqual(parseNumstatZ("1\t1\tAssets/A.cs\0-\t-\tAssets/tex.bin\0"), ["Assets/A.cs", "Assets/tex.bin"]);
  });

  test("file hash in the PowerShell form", async () => {
    const d = tempLabHome();
    writeFileSync(path.join(d, "f"), "abc");
    assert.equal(await fileHashText(d, "f"), "BA-78-16-BF-8F-01-CF-EA-41-41-40-DE-5D-AE-22-23-B0-03-61-A3-96-17-7A-9C-B4-10-FF-61-F2-00-15-AD");
    assert.equal(await fileHashText(d, "nope"), "missing");
  });

  test("default state folder: <labHome>/guard/<folder>-<hash8 of top|prefix>", () => {
    const d = defaultStateDir("/lab", "/x/My Game!", "/x", "My Game!/");
    assert.match(d.replace(/\\/g, "/"), /^\/lab\/guard\/My_Game_-[0-9a-f]{8}$/);
  });
});

describe("a clean project: build changes and creates files, the revert undoes exactly those", () => {
  test("snapshot -> build -> report -> revert", async () => {
    const { top, proj } = repo();
    const b = bench(proj);
    const snap = await guardSnapshot(b.o());
    assert.equal(snap.changed_before_build, 0);
    assert.equal(snap.backup, null);
    assert.ok(existsSync(path.join(snap.state_dir, "snapshot.json")));
    assert.ok(b.lines.some((l) => l.startsWith("GUARD_SNAPSHOT changed_before_build=0 tracked=0 untracked=0")));

    // The "build": changes a tracked text file and a binary, deletes one, creates files incl. a new folder with .meta.
    write(proj, "ProjectSettings/ProjectSettings.asset", "companyName: Build\n");
    write(proj, "Assets/tex.bin", Buffer.from([9, 9, 9]));
    unlinkSync(path.join(proj, "Assets", "B.asset"));
    write(proj, "Assets/[x] 그림 1.txt", "changed by the build\n");
    write(proj, "Assets/EmuLab/Editor/EmuProjectBuild.cs", "// template\n");
    write(proj, "Assets/EmuLab/Editor.meta", "guid: 1\n");
    write(proj, "Assets/EmuLab.meta", "guid: 2\n");

    const rep = await guardReport(b.o());
    assert.deepEqual([...rep.changed].sort(), ["Assets/B.asset", "Assets/[x] 그림 1.txt", "Assets/tex.bin", "ProjectSettings/ProjectSettings.asset"]);
    assert.deepEqual([...rep.created].sort(), ["Assets/EmuLab.meta", "Assets/EmuLab/Editor.meta", "Assets/EmuLab/Editor/EmuProjectBuild.cs"]);
    assert.equal(rep.head_moved, false);
    assert.ok(b.lines.some((l) => l === "GUARD_REPORT changed=4 created=3 staged=0 preexisting_touched=0"));

    const rev = await guardRevert(b.o());
    assert.equal(rev.reverted.length, 4);
    assert.equal(rev.moved.length, 3);
    assert.equal(porcelain(top), "", "the work tree is back at HEAD");
    assert.equal(read(proj, "Assets/[x] 그림 1.txt"), "korean and brackets\n");
    assert.deepEqual([...readFileSync(path.join(proj, "Assets", "tex.bin"))], [0, 1, 2, 3, 255, 0, 7]);
    assert.equal(existsSync(path.join(proj, "Assets", "EmuLab")), false, "the emptied template folders are gone");
    // Moved, never deleted.
    const movedCs = path.join(rev.backup, "created", "Assets", "EmuLab", "Editor", "EmuProjectBuild.cs");
    assert.equal(readFileSync(movedCs, "utf8"), "// template\n");
    assert.ok(readdirSync(rev.backup).some((n) => /^build-changes-1\.patch$/.test(n)));
    assert.deepEqual([...rev.removed_empty_folders].sort(), [path.join("Assets", "EmuLab"), path.join("Assets", "EmuLab", "Editor")].sort());
    // The cycle is archived: a new report needs a new snapshot.
    assert.equal(existsSync(path.join(rev.state_dir, "snapshot.json")), false);
    assert.ok(rev.archived.some((a) => /snapshot-\d{8}-\d{6}\.json$/.test(a)));
    await refused(guardReport(b.o()), "GUARD_REFUSED", /archived \(snapshot-.*after a revert/);
  });

  test("an empty folder that keeps its tracked .meta is not removed", async () => {
    const { top, proj } = repo();
    write(proj, "Assets/Plugins.meta", "guid: p\n");
    write(proj, "Assets/Plugins/keep.txt", "k\n");
    git(top, ["add", "-A"]);
    git(top, ["commit", "-q", "-m", "plugins"]);
    const b = bench(proj);
    await guardSnapshot(b.o());
    write(proj, "Assets/Plugins/Gen/new.dll", "x");
    await guardReport(b.o());
    const rev = await guardRevert(b.o());
    assert.equal(rev.moved.length, 1);
    assert.equal(existsSync(path.join(proj, "Assets", "Plugins", "Gen")), false);
    assert.ok(existsSync(path.join(proj, "Assets", "Plugins")));
  });
});

describe("the person's own work is never reverted", () => {
  test("changes before the build: backed up in prebuild.patch, untracked listed; touched files are reported, never reverted", async () => {
    const { top, proj } = repo();
    write(proj, "Assets/A.cs", "class A { int mine; }\n");
    write(proj, "Assets/Mine.txt", "my untracked notes\n");
    const b = bench(proj);
    const snap = await guardSnapshot(b.o());
    assert.equal(snap.changed_before_build, 2);
    assert.equal(snap.tracked, 1);
    assert.equal(snap.untracked, 1);
    assert.ok(snap.backup && readFileSync(snap.backup, "utf8").includes("int mine;"));
    assert.ok(b.lines.some((l) => /NOT backed up/.test(l)));

    // The build changes one of the person's files again, and another file.
    write(proj, "Assets/A.cs", "class A { int mine; int build; }\n");
    write(proj, "Assets/B.asset", "b: 2\n");
    const rep = await guardReport(b.o());
    assert.deepEqual(rep.changed, ["Assets/B.asset"]);
    assert.deepEqual(rep.preexisting_changed_meanwhile, ["Assets/A.cs"]);
    const rev = await guardRevert(b.o());
    assert.deepEqual(rev.reverted, ["Assets/B.asset"]);
    assert.equal(rev.preexisting_left, 1);
    assert.equal(read(proj, "Assets/A.cs"), "class A { int mine; int build; }\n", "a touched file stays as it is");
    assert.equal(read(proj, "Assets/Mine.txt"), "my untracked notes\n");
    assert.equal(porcelain(top).split("\n").filter(Boolean).length, 2);
  });

  test("staged changes made meanwhile are listed but never reverted", async () => {
    const { proj, top } = repo();
    const b = bench(proj);
    await guardSnapshot(b.o());
    write(proj, "Assets/B.asset", "b: staged by the person\n");
    git(top, ["add", "Assets/B.asset"]);
    write(proj, "Assets/A.cs", "class A { build }\n");
    const rep = await guardReport(b.o());
    assert.deepEqual(rep.staged_not_reverted, ["Assets/B.asset"]);
    assert.deepEqual(rep.changed, ["Assets/A.cs"]);
    await guardRevert(b.o());
    assert.equal(read(proj, "Assets/B.asset"), "b: staged by the person\n");
    assert.equal(read(proj, "Assets/A.cs"), "class A {}\n");
  });

  test("keep: a file the person edited during the build stays; a keep path not in the report is refused", async () => {
    const { proj } = repo();
    const b = bench(proj);
    await guardSnapshot(b.o());
    write(proj, "Assets/A.cs", "class A { person }\n");
    write(proj, "Assets/B.asset", "b: build\n");
    write(proj, "Assets/Person.cs", "// new by the person\n");
    write(proj, "Assets/Gen.cs", "// generated\n");
    await guardReport(b.o());
    await refused(guardRevert(b.o({ keep: "Assets/A.cs|Assets/Nope.cs" })), "GUARD_REFUSED", /not in the report: Assets\/Nope\.cs/);
    assert.equal(read(proj, "Assets/B.asset"), "b: build\n", "nothing reverted on a refusal");
    const rev = await guardRevert(b.o({ keep: "Assets\\A.cs|Assets/Person.cs" }));
    assert.deepEqual(rev.kept.sort(), ["Assets/A.cs", "Assets/Person.cs"]);
    assert.equal(read(proj, "Assets/A.cs"), "class A { person }\n");
    assert.equal(read(proj, "Assets/Person.cs"), "// new by the person\n");
    assert.equal(read(proj, "Assets/B.asset"), "b: 1\n");
    assert.equal(existsSync(path.join(proj, "Assets", "Gen.cs")), false);
  });
});

describe("the revert stops before changing anything", () => {
  test("a file changed after the report, or a new file since the report", async () => {
    const { proj } = repo();
    const b = bench(proj);
    await guardSnapshot(b.o());
    write(proj, "Assets/B.asset", "b: build\n");
    write(proj, "Assets/Gen.cs", "// generated\n");
    await guardReport(b.o());
    write(proj, "Assets/B.asset", "b: edited after the report\n");
    await refused(guardRevert(b.o()), "GUARD_REFUSED", /changed after the report/);
    assert.equal(read(proj, "Assets/B.asset"), "b: edited after the report\n");
    assert.ok(existsSync(path.join(proj, "Assets", "Gen.cs")));
    await guardReport(b.o());
    write(proj, "Assets/Late.cs", "// after the report\n");
    await refused(guardRevert(b.o()), "GUARD_REFUSED", /Files changed after the report/);
    assert.ok(b.lines.some((l) => l === "  new since report: ?? Assets/Late.cs"));
    assert.ok(existsSync(path.join(proj, "Assets", "Gen.cs")));
  });

  test("a commit since the snapshot: the report warns, the revert refuses", async () => {
    const { proj, top } = repo();
    const b = bench(proj);
    await guardSnapshot(b.o());
    write(proj, "Assets/A.cs", "class A { committed }\n");
    git(top, ["commit", "-q", "-am", "meanwhile"]);
    write(proj, "Assets/B.asset", "b: build\n");
    const rep = await guardReport(b.o());
    assert.equal(rep.head_moved, true);
    assert.ok(b.lines.some((l) => /^WARN: HEAD moved/.test(l)));
    await refused(guardRevert(b.o()), "GUARD_REFUSED", /HEAD moved/);
    assert.equal(read(proj, "Assets/B.asset"), "b: build\n");
  });

  test("no report yet, no snapshot at all, a report from an older script without hashes", async () => {
    const { proj } = repo();
    const b = bench(proj);
    await refused(guardReport(b.o()), "GUARD_REFUSED", /No snapshot in .*BEFORE the build/);
    const snap = await guardSnapshot(b.o());
    write(proj, "Assets/B.asset", "b: build\n");
    await refused(guardRevert(b.o()), "GUARD_REFUSED", /Run the report first/);
    await guardReport(b.o());
    const rf = path.join(snap.state_dir, "report.json");
    const r = JSON.parse(readFileSync(rf, "utf8"));
    delete r.hashes;
    writeFileSync(rf, JSON.stringify(r));
    await refused(guardRevert(b.o()), "GUARD_REFUSED", /without content hashes/);
    assert.equal(read(proj, "Assets/B.asset"), "b: build\n");
  });

  test("the project is open in Unity or a build runs: report and revert refuse; a snapshot refuses only during a build", async () => {
    const { proj } = repo();
    const editor: UnityProcess = { pid: 5, ppid: 1, batchmode: false, worker: false, commandLine: "" };
    const build: UnityProcess = { pid: 6, ppid: 1, batchmode: true, worker: false, commandLine: "" };
    const open: LockProbe = { isLocked: async () => true, processes: async () => [editor] };
    const building: LockProbe = { isLocked: async () => true, processes: async () => [build] };
    await refused(guardSnapshot(bench(proj, building).o()), "BUILD_RUNNING", /batchmode Unity pid 6/);
    const b = bench(proj, open);
    await guardSnapshot(b.o());
    assert.ok(b.lines.some((l) => /^NOTE: the project is open \(Unity Editor pid 5\)/.test(l)));
    write(proj, "Assets/B.asset", "b: build\n");
    await refused(guardReport(b.o()), "PROJECT_OPEN", /close the Unity Editor/);
    await refused(guardReport(b.o({ deps: { lock: building } })), "BUILD_RUNNING");
    await guardReport(b.o({ deps: { lock: FREE } }));
    await refused(guardRevert(b.o()), "PROJECT_OPEN", /Nothing reverted/);
    assert.equal(read(proj, "Assets/B.asset"), "b: build\n");
  });

  test("a created folder entry (a nested repository) stops the revert before anything changes", async () => {
    const { proj } = repo();
    const b = bench(proj);
    await guardSnapshot(b.o());
    write(proj, "Assets/B.asset", "b: build\n");
    const nested = path.join(proj, "Assets", "Nested");
    mkdirSync(nested, { recursive: true });
    git(nested, ["init", "-q"]);
    writeFileSync(path.join(nested, "x.txt"), "x");
    const rep = await guardReport(b.o());
    assert.ok(rep.created.includes("Assets/Nested/"), JSON.stringify(rep.created));
    await refused(guardRevert(b.o()), "GUARD_REFUSED", /not a file that can be moved/);
    assert.equal(read(proj, "Assets/B.asset"), "b: build\n");
  });
});

describe("snapshot rules", () => {
  test("a second snapshot refuses while paths changed since the first; replace takes it; a commit explains gone paths", async () => {
    const { proj, top } = repo();
    write(proj, "Assets/A.cs", "class A { mine }\n");
    const b = bench(proj);
    await guardSnapshot(b.o());
    // A build changed a file and nobody reverted it.
    write(proj, "Assets/B.asset", "b: build\n");
    await refused(guardSnapshot(b.o()), "GUARD_REFUSED", /1 path\(s\) changed since it/);
    assert.ok(b.lines.some((l) => l === "  changed since the last snapshot:  M Assets/B.asset"));
    // Reset by a build (gone, no commit or stash): refused too.
    write(proj, "Assets/B.asset", "b: 1\n");
    git(top, ["checkout", "--", "Assets/A.cs"]);
    await refused(guardSnapshot(b.o()), "GUARD_REFUSED", /changed since it/);
    assert.ok(b.lines.some((l) => /gone since the last snapshot:  M Assets\/A\.cs/.test(l)));
    // After a commit the gone path is explained.
    write(proj, "Assets/A.cs", "class A { mine }\n");
    git(top, ["commit", "-q", "-am", "mine"]);
    const again = await guardSnapshot(b.o());
    assert.equal(again.changed_before_build, 0);
    assert.ok(again.archived.some((a) => /snapshot-.*\.json$/.test(a)), "the old snapshot is archived, not deleted");
    // replace: the person says the changes are theirs.
    write(proj, "Assets/B.asset", "b: mine too\n");
    await refused(guardSnapshot(b.o()), "GUARD_REFUSED");
    const replaced = await guardSnapshot(b.o({ replace: true }));
    assert.equal(replaced.changed_before_build, 1);
  });

  test("a stash explains gone paths too", async () => {
    const { proj, top } = repo();
    write(proj, "Assets/A.cs", "class A { mine }\n");
    const b = bench(proj);
    await guardSnapshot(b.o());
    git(top, ["stash", "-q"]);
    const s = await guardSnapshot(b.o());
    assert.equal(s.changed_before_build, 0);
  });

  test("a state folder of another project refuses without replace", async () => {
    const a = repo();
    const c = repo();
    const b = bench(a.proj);
    const snap = await guardSnapshot(b.o());
    const other = bench(c.proj);
    await refused(guardSnapshot(other.o({ stateDir: snap.state_dir })), "GUARD_REFUSED", /another project/);
    await refused(guardReport(other.o({ stateDir: snap.state_dir })), "GUARD_REFUSED", /belongs to another project/);
  });
});

describe("a project in a subfolder of a larger repository", () => {
  test("only the project folder is looked at; changes outside it are never touched", async () => {
    const { proj, top } = repo({ sub: "Client" });
    const b = bench(proj);
    await guardSnapshot(b.o());
    write(top, "outside.txt", "edited outside\n");
    write(top, "Server/new.txt", "new outside\n");
    write(proj, "Assets/A.cs", "class A { build }\n");
    write(proj, "Library/x", "ignored? no .gitignore, so it is created\n");
    const rep = await guardReport(b.o());
    assert.deepEqual(rep.changed, ["Client/Assets/A.cs"]);
    assert.deepEqual(rep.created, ["Client/Library/x"]);
    const rev = await guardRevert(b.o());
    assert.deepEqual(rev.reverted, ["Client/Assets/A.cs"]);
    assert.equal(read(top, "outside.txt"), "edited outside\n");
    assert.equal(read(top, "Server/new.txt"), "new outside\n");
    assert.deepEqual(rev.removed_empty_folders, ["Library"]);
    assert.ok(existsSync(proj), "never the project folder itself");
  });
});

describe("big reverts and moves across volumes", () => {
  test("more than 40 changed files are reverted in batches, each with its own backup patch", async () => {
    const { proj, top } = repo();
    for (let i = 0; i < 45; i++) write(proj, `Assets/Many/f${i}.txt`, `${i}\n`);
    git(top, ["add", "-A"]);
    git(top, ["commit", "-q", "-m", "many"]);
    const b = bench(proj);
    await guardSnapshot(b.o());
    for (let i = 0; i < 45; i++) write(proj, `Assets/Many/f${i}.txt`, `build ${i}\n`);
    await guardReport(b.o());
    const rev = await guardRevert(b.o());
    assert.equal(rev.reverted.length, 45);
    assert.ok(existsSync(path.join(rev.backup, "build-changes-2.patch")));
    assert.equal(porcelain(top), "");
  });

  test("a move that cannot rename across volumes copies, checks the size and removes the source", async () => {
    const { proj } = repo();
    const b = bench(proj);
    await guardSnapshot(b.o());
    write(proj, "Assets/Gen.cs", "// generated\n");
    await guardReport(b.o());
    const exdev = () => {
      const e = new Error("cross-device link not permitted") as NodeJS.ErrnoException;
      e.code = "EXDEV";
      throw e;
    };
    const rev = await guardRevert(b.o({ deps: { lock: FREE, rename: exdev } }));
    assert.equal(existsSync(path.join(proj, "Assets", "Gen.cs")), false);
    assert.equal(readFileSync(rev.moved[0].to, "utf8"), "// generated\n");
  });
});

describe("the build template goes in after the snapshot and out with the revert", () => {
  test("refused before the snapshot; after it, the report lists it as created and the revert moves it out", async () => {
    const { proj, top } = repo();
    write(proj, "ProjectSettings/ProjectVersion.txt", "m_EditorVersion: 6000.6.0f1\n");
    git(top, ["add", "-A"]);
    git(top, ["commit", "-q", "-m", "version"]);
    const b = bench(proj);
    const env = { ...process.env, EMU_LAB_HOME: b.home };
    await refused(addTemplate({ projectPath: proj, env, report: () => {} }), "GUARD_REFUSED", /snapshot/);
    assert.equal(existsSync(path.join(proj, "Assets", "EmuLab")), false);
    await guardSnapshot(b.o());
    const t = await addTemplate({ projectPath: proj, env, report: () => {} });
    assert.equal(t.added, true);
    // Unity adds .meta files on import.
    write(proj, "Assets/EmuLab.meta", "guid: a\n");
    write(proj, "Assets/EmuLab/Editor.meta", "guid: b\n");
    write(proj, "Assets/EmuLab/Editor/EmuProjectBuild.cs.meta", "guid: c\n");
    const rep = await guardReport(b.o());
    assert.equal(rep.created.length, 5);
    assert.ok(rep.created.every((p) => p.startsWith("Assets/EmuLab")));
    const rev = await guardRevert(b.o());
    assert.equal(rev.moved.length, 5);
    assert.equal(existsSync(path.join(proj, "Assets", "EmuLab")), false);
    assert.equal(porcelain(top), "");
  });
});

describe("not git", () => {
  test("a folder outside any git repository: NOT_GIT; guardState says so", async () => {
    const d = tempLabHome();
    const b = bench(d);
    await refused(guardSnapshot(b.o()), "NOT_GIT", /not a git work tree/);
    assert.deepEqual(await guardState({ projectPath: d }), { inGit: false });
  });

  test("a repository without a commit: refused", async () => {
    const d = path.join(tempLabHome(), "fresh");
    mkdirSync(d);
    git(d, ["init", "-q"]);
    await refused(guardSnapshot(bench(d).o()), "GUARD_REFUSED", /no commit yet/);
  });

  test("git missing from PATH inside a repository: NO_GIT names the .git folder", async () => {
    const { proj } = repo();
    const b = bench(proj);
    await refused(guardSnapshot(b.o({ deps: { lock: FREE, git: path.join(tempLabHome(), "no-git-here") } })), "NO_GIT", /inside a git repo/);
  });

  test("guardState: snapshot present or not", async () => {
    const { proj } = repo();
    const b = bench(proj);
    const env = { ...process.env, EMU_LAB_HOME: b.home };
    assert.equal((await guardState({ projectPath: proj, env })).snapshot, false);
    await guardSnapshot(b.o());
    const st = await guardState({ projectPath: proj, env });
    assert.equal(st.inGit, true);
    assert.equal(st.snapshot, true);
    rmSync(st.stateDir!, { recursive: true });
  });
});
