// Types shared by several modules.

/** Progress sink: one line per step, in the PowerShell scripts' style ("LEASE new avd=...", "SMOKE PASS dir=..."). */
export type Report = (line: string) => void;

/** A reporter that drops everything (tests, internal calls). */
export const silent: Report = () => {};

/**
 * The lease file <labHome>/leases/<avd>.json, the same format as scripts/common.ps1 (Enter-EmuLease).
 * Unknown fields written by other tools are kept when the file is rewritten.
 */
export interface LeaseRecord {
  avd: string;
  owner: string;
  host: string;
  /** ISO 8601 with offset (PowerShell writes 7 fraction digits, e.g. 2026-11-20T10:43:00.1234567+09:00). */
  acquiredAt: string;
  expiresAt: string;
  /** true when this lease launched the emulator (release stops only that instance). */
  startedEmulator: boolean;
  emulatorPid: number | null;
  emulatorStartedAt: string | null;
  /** Packages installed under this lease (release --uninstall removes them). */
  installed: string[];
  [extra: string]: unknown;
}
