// The batchmode build entry for a project that has no build method or build profile: templates/EmuProjectBuild.cs and
// templates/EmuLab.Editor.asmdef, copied into a NEW folder Assets/EmuLab/Editor/ of the person's project, only after
// the person agrees (AGENTS.md). Never into an existing folder with scripts (an .asmdef takes every script in its
// folder and below, so the project's own editor scripts would stop compiling). Not to be committed: the guard Report
// lists Assets/EmuLab as created and Revert moves it to the backup folder.

import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EmuError } from "./errors.ts";
import type { Report } from "./types.ts";
import { compareUnityVersions, readProjectVersion } from "./unity.ts";

export const TEMPLATE_FILES = ["EmuProjectBuild.cs", "EmuLab.Editor.asmdef"] as const;
export const TEMPLATE_METHODS = {
  Android: "EmuProjectBuild.BuildApk",
  WebGL: "EmuProjectBuild.BuildWebGL",
  Windows: "EmuProjectBuild.BuildWindows",
} as const;

/** The templates folder of this package (next to src/ and dist/). */
export function templatesDir(): string {
  return fileURLToPath(new URL("../templates/", import.meta.url));
}

export interface TemplateResult {
  /** false: the same two files were already there. */
  added: boolean;
  dir: string;
  files: string[];
  methods: typeof TEMPLATE_METHODS;
}

/** Copy the two template files into <project>/Assets/EmuLab/Editor/ (a new folder). */
export function installTemplate(o: { projectPath: string; report: Report; sourceDir?: string }): TemplateResult {
  const project = path.resolve(o.projectPath);
  const pv = readProjectVersion(project);
  if (!pv) throw new EmuError("NO_PROJECT", `Not a Unity project (no ProjectSettings/ProjectVersion.txt): ${project}`);
  if (compareUnityVersions(pv.version, "2021.2.0a1") < 0) {
    throw new EmuError("BAD_OPTION", `The template needs Unity 2021.2 or newer (NamedBuildTarget); this project uses ${pv.version}. Use the project's own build method.`);
  }
  const src = o.sourceDir ?? templatesDir();
  const root = path.join(project, "Assets", "EmuLab");
  const dir = path.join(root, "Editor");
  const files = TEMPLATE_FILES.map((f) => path.join(dir, f));
  if (existsSync(root) || existsSync(`${root}.meta`)) {
    const same = TEMPLATE_FILES.every((f, i) => {
      try {
        return readFileSync(files[i]).equals(readFileSync(path.join(src, f)));
      } catch {
        return false;
      }
    });
    if (same) {
      o.report(`TEMPLATE_PRESENT ${dir} (already holds this version of ${TEMPLATE_FILES.join(" and ")})`);
      return { added: false, dir, files, methods: TEMPLATE_METHODS };
    }
    throw new EmuError(
      "TEMPLATE_EXISTS",
      `${root} already exists and does not hold exactly this template. Ask the person what it is; never copy into it or replace it.`,
    );
  }
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < TEMPLATE_FILES.length; i++) {
    copyFileSync(path.join(src, TEMPLATE_FILES[i]), files[i], constants.COPYFILE_EXCL);
    o.report(`TEMPLATE_ADDED ${files[i]}`);
  }
  o.report(
    `Build with --method ${TEMPLATE_METHODS.Android}, ${TEMPLATE_METHODS.WebGL} or ${TEMPLATE_METHODS.Windows}. Do not commit Assets/EmuLab: ` +
      "the guard Report lists it (and the .meta files Unity adds) as created, and Revert moves it out after the person agrees.",
  );
  return { added: true, dir, files, methods: TEMPLATE_METHODS };
}
