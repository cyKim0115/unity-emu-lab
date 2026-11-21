// One error type for everything the package refuses or fails at. `code` is stable and machine-readable
// (CLI exit lines, MCP error text, tests); `message` is the human sentence, and for lease refusals it
// starts with the same token the PowerShell scripts print (BUSY:, NOT_OWNER, NOT_STALE, ...).

export type EmuErrorCode =
  | "BUSY" // another owner holds a valid lease
  | "NOT_OWNER" // release/renew of a lease that is someone else's
  | "NOT_STALE" // release --stale of a lease that is still valid
  | "NO_LEASE" // an operation that needs our own lease found none (strict mode, renew)
  | "LEASE_UNREADABLE" // the lease file stayed empty/locked/invalid after retries (or its .lock stayed taken)
  | "LEASE_CHANGED" // the lease read earlier was replaced or removed meanwhile (another session took it over)
  | "NO_ADB" // adb executable not found
  | "NO_EMULATOR_EXE" // emulator executable not found
  | "NO_AVD" // <avdHome>/<avd>.ini not found
  | "NO_EMULATOR" // the target AVD is not running (adb does not see it)
  | "OTHER_EMULATOR" // another AVD is running; it is never touched
  | "EMULATOR_EXITED" // the emulator process died right after launch
  | "BOOT_TIMEOUT" // the emulator did not show up / finish booting in time
  | "ABI_MISMATCH" // the APK's native ABIs cannot run on the device
  | "PACKAGE_UNKNOWN" // the APK package name could not be read and none was given
  | "PACKAGE_MISMATCH" // --package differs from the APK's package
  | "BAD_OPTION" // invalid or conflicting options
  | "ADB_FAILED" // an adb command failed in a way the caller cannot continue from
  | "CLOCK_FAILED" // the device clock could not be set
  | "JOB_UNKNOWN" // emu_job with an unknown job id
  | "JOB_RUNNING" // a device-changing job already runs on this AVD in this server process
  | "NO_BUILD" // WebGL: the build folder has no index.html
  | "NO_BROWSER" // WebGL: no Chrome, Edge or Chromium found (or the given one does not exist)
  | "NO_PROJECT" // not a Unity project folder (no ProjectSettings/ProjectVersion.txt)
  | "NO_UNITY" // the editor version the project needs is not installed
  | "PROJECT_OPEN" // a Unity Editor has the project open: batchmode builds and the guard Report/Revert wait
  | "BUILD_RUNNING" // a batchmode Unity is building the project (a leftover or another run)
  | "BUILD_FAILED" // Unity failed, or exited 0 while its log reports a failed build
  | "BUILD_TIMEOUT" // Unity ran longer than the timeout and was stopped
  | "BUILD_NO_OUTPUT" // Unity exited 0 but this build wrote nothing at the output
  | "TEMPLATE_EXISTS" // Assets/EmuLab is already in the project
  | "NO_GIT" // git is not on PATH (and the project may be in a git repository)
  | "NOT_GIT" // the project is not in a git work tree, or git refused it (dubious ownership)
  | "GUARD_REFUSED"; // project guard: a safety rule stopped snapshot/report/revert (or a change before the snapshot); nothing was changed

export class EmuError extends Error {
  readonly code: EmuErrorCode;
  constructor(code: EmuErrorCode, message: string) {
    super(message);
    this.name = "EmuError";
    this.code = code;
  }
}

export function isEmuError(err: unknown, code?: EmuErrorCode): err is EmuError {
  return err instanceof EmuError && (code === undefined || err.code === code);
}
