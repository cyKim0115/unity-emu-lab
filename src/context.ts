// Session context for commands that act on the running emulator: locations, owner, lease file and an adb client
// bound to the target AVD's serial. The lease check runs before the caller can send any device-changing command.

import { existsSync } from "node:fs";
import { Adb } from "./adb.ts";
import { androidEnv, resolveLocations } from "./config.ts";
import type { Locations } from "./config.ts";
import { EmuError } from "./errors.ts";
import { assertLeaseUsable, leasePath } from "./lease.ts";
import { getOwner } from "./owner.ts";
import type { Report } from "./types.ts";

export interface EmuContext {
  loc: Locations;
  avd: string;
  owner: string;
  leaseFile: string;
  /** bound to the AVD's serial */
  adb: Adb;
  serial: string;
  report: Report;
}

export async function connect(o: {
  avd?: string;
  owner?: string;
  env?: NodeJS.ProcessEnv;
  report: Report;
  /** none = no lease check (clock reset, screenshot, status) */
  leaseMode: "strict" | "warn" | "none";
  /** wait for the AVD to appear in adb devices (default 30) */
  waitSec?: number;
  /** tests inject the fake adb */
  adbFactory?: (loc: Locations, env: NodeJS.ProcessEnv) => Adb;
}): Promise<EmuContext> {
  const env = o.env ?? process.env;
  const loc = resolveLocations({ env });
  const avd = (o.avd ?? "").trim() || loc.avd;
  const owner = (o.owner ?? "").trim() || getOwner(env);
  const leaseFile = leasePath(loc, avd);

  let adb: Adb;
  if (o.adbFactory) {
    adb = o.adbFactory(loc, env);
  } else {
    if (!existsSync(loc.adb)) {
      throw new EmuError(
        "NO_ADB",
        `adb not found at ${loc.adb} (from ${loc.adbSource}). Install the Android SDK platform-tools there, or point EMU_ADB ` +
          `(or "adb" in ${loc.configPath}) at an adb executable.`,
      );
    }
    adb = new Adb({ exe: loc.adb, env: androidEnv(loc, env), report: o.report });
  }

  await adb.ensureServer();
  const serial = await adb.findSerial(avd, o.waitSec ?? 30);
  if (!serial) {
    throw new EmuError("NO_EMULATOR", `No running emulator for AVD '${avd}'. Run emu-lab start (MCP: emu_start) first.`);
  }

  if (o.leaseMode !== "none") {
    await assertLeaseUsable({ path: leaseFile, avd, owner, mode: o.leaseMode, report: o.report });
  }

  return { loc, avd, owner, leaseFile, adb: adb.withSerial(serial), serial, report: o.report };
}
