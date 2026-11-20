// The package version, read from package.json (one level up from src/ and from dist/).

import { readFileSync } from "node:fs";

export const PACKAGE_NAME = "unity-emu-lab";
export const PACKAGE_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
