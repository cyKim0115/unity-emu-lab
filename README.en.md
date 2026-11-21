# unity-emu-lab

[한국어](README.md) · [Changelog](CHANGELOG.md)

Self-test Unity Android builds on an emulator, and Unity WebGL builds in a browser, on your own PC — by a person or by AI agents, several at a time.

`unity-emu-lab` is an MCP server and a CLI (`emu-lab`) for Windows, macOS and Linux:

- **One device, several sessions**: take, renew and release a lease on the emulator. Another owner's valid lease stops every device-changing step before it runs (`BUSY`). Releasing stops only the emulator this lease started and uninstalls only the apps installed under it.
- **Unity-aware verdicts**: a ready marker in logcat, crashes and ANRs told apart from an app that quits by itself (anti-cheat, integrity or emulator detection), the APK's native ABIs checked before installing (ARM-only builds), the first-run full-screen hint and permission dialogs tapped away.
- **Checks outside the app**: a local notification is posted, drawn in the shade, and tapping it opens the app. The device clock can jump ahead to check notifications scheduled hours later, and is always put back.
- **WebGL in a real browser**: serve a WebGL build folder on localhost, open it in Chrome, Edge or Chromium over DevTools (throwaway profile, muted), wait until it is ready, click or touch the canvas, and fail on loader/wasm errors, uncaught exceptions, dialogs, the Unity error banner or a renderer crash. No emulator needed.
- **Unity builds and a project guard**: build the person's project in batchmode (Android APK, WebGL folder, Windows exe) with its own build method or a Unity 6 build profile, and protect the project around it: snapshot before the first build, report what the build changed, revert only what the person approves. Plus `emu-lab doctor`, a host check per OS (KVM, Hypervisor.framework, WHPX/AEHD, Unity modules, SDK and AVD).

Device-control MCP servers such as `@mobilenext/mobile-mcp` or `appium-mcp` hand screenshots and taps to the agent; this package judges the build instead. You can use both, but not at the same time as `emu_smoke` / `emu_check_notification`: both need Android's single UiAutomation connection.

The repository also contains Windows PowerShell scripts (`scripts/`, documented in Korean in [README.md](README.md)) that add a Windows Standalone smoke test (the player exe runs windowed on this desktop from a muted test build; `Player.log` ready marker, crash / self-exit / error dialog verdicts, a real mouse click only with `-Tap`, PlayerPrefs left alone unless `-CleanPrefs`) and Android SDK setup, next to the same builds, guard and checks. Both share the same lease file and respect each other's leases, and the guard state folder has the same format.

### Host support

| Feature \ host | Windows | macOS | Linux |
|---|---|---|---|
| Host check (`emu-lab doctor`, `doctor.ps1`) | npm, PS | npm | npm |
| Unity batchmode build: Android APK, WebGL | npm, PS | npm | npm |
| Unity batchmode build: Windows exe | npm, PS | npm (Mono backend only) | npm (Mono backend only) |
| Project guard (snapshot, report, revert) | npm, PS | npm | npm |
| Android emulator lease, smoke, notification, clock | npm, PS (x86_64, WHPX/AEHD) | npm (arm64 images on Apple silicon, Hypervisor.framework) | npm (x86_64 images, KVM; SwiftShader without GPU or display) |
| WebGL smoke | npm, PS | npm | npm |
| Windows player smoke | PS | – | – |
| Android SDK and AVD setup | PS (`setup-android-sdk.ps1`) | by the person with Android Studio or sdkmanager (`doctor` prints the commands) | as macOS |

Windows on ARM cannot run the Android emulator (WebGL only). See "Tested" for what ran on real macOS and Linux hosts.

## Requirements

- [Node.js](https://nodejs.org/) 22.18 or later
- Android SDK `platform-tools` (adb) and `emulator`, and one AVD (default name `unity-test`; pick another with `--avd` / the `avd` input / `EMU_AVD`). On Windows, `scripts\setup-android-sdk.ps1` installs both.
- Unity 6 Android players ship ARM libraries only. They run on an API 35 `google_apis` x86_64 image (with ARM translation) or on an arm64 image on Apple Silicon. Mono / ARMv7-only builds cannot run there; the smoke test says so before installing (`ABI_MISMATCH`).
- WebGL only needs Chrome, Edge or Chromium (found in the usual install locations and on PATH; set one with `EMU_BROWSER`, `CHROME_PATH` or `--browser`). No Android SDK.
- Builds need the project's exact Unity version from Unity Hub with the target's modules, and git for the project guard. `emu-lab doctor --project <project> --target <target>` lists what is missing.

## Install and register

```bash
npm install -g unity-emu-lab
emu-lab status     # lease, emulators, adb and SDK paths with their sources; changes nothing
```

The MCP server command is `emu-lab serve` (with no arguments it also serves when stdin is not a terminal). On Windows, start it through `cmd /c`, since many clients cannot run `.cmd` files directly.

```bash
claude mcp add emu-lab -s user -- emu-lab serve           # Claude Code, macOS/Linux
claude mcp add emu-lab -s user -- cmd /c emu-lab serve    # Claude Code, Windows
```

```toml
# Codex (~/.codex/config.toml)
[mcp_servers.emu-lab]
command = "emu-lab"        # Windows: command = "cmd", args = ["/c", "emu-lab", "serve"]
args = ["serve"]
startup_timeout_sec = 60
```

```json
{ "mcpServers": { "emu-lab": { "command": "cmd", "args": ["/c", "emu-lab", "serve"] } } }
```

(Cursor `~/.cursor/mcp.json` / Claude Desktop, Windows; on macOS/Linux use `"command": "emu-lab", "args": ["serve"]`.) Without installing: `npx -y unity-emu-lab@<version> serve`.

## CLI quick start

```bash
emu-lab doctor --target android                 # check this host (changes nothing): 0 ready, 2 only agent TODOs, 1 the person must act
emu-lab start                                   # take the lease and boot the AVD (or reuse it)
emu-lab smoke app.apk --ready-marker "<a line your app logs when ready>" --no-tap-check --notif-delay 0
emu-lab release --uninstall                     # reset the device, uninstall what this lease installed, stop the emulator it started
```

- Results go to `~/.emu-lab/runs/<stamp>-smoke-<pid>/` (`summary.json`, `logcat.txt`, `unity.txt`, PNG screenshots); `--out <dir>` changes it.
- The smoke defaults match the bundled sample app's log lines (`SMOKE_APP_READY`, `SMOKE_TAP count=1`, `SMOKE_NOTIF_SCHEDULED id=<n> title=<title>`, `SMOKE_OPENED_FROM_NOTIFICATION`, a 20 s notification). For another app, pass `--ready-marker`, and `--no-tap-check` / `--notif-delay 0` when it logs no tap or notification lines.
- Notifications hours ahead: `--notif-delay 7200 --time-travel 185` (inexact alarms may fire up to an hour late, so jump at least delay + 60 min). The clock is reset when the smoke test ends.
- Separately: `emu-lab notification --package <id> --title "<part of the title>" --tap`, `emu-lab clock forward <minutes>` then `emu-lab clock reset`, `emu-lab screenshot [file]`.
- `emu-lab help` lists every option. Exit codes: 0 ok, 1 failed or refused (`BUSY`, `NO_LEASE`, ...), 2 usage error.
- Without a lease the CLI only warns (`LEASE_NONE`) and goes on, for a person running a command by hand; `--strict` refuses. The MCP tools are always strict.
- Emulator GPU: `start --gpu auto` (default) uses `host` on Windows and macOS, and on Linux only with a display (`DISPLAY` / `WAYLAND_DISPLAY`) and a GPU render node (`/dev/dri/renderD*`); otherwise `swiftshader_indirect` (software, slower, but it boots on a GPU-less server or CI runner). Pick one with `--gpu` or `EMU_GPU`.

## WebGL smoke test

```bash
emu-lab webgl <build-dir> --ready-mode loaded --no-tap-check --headless    # Unity Default template, no console marker
emu-lab webgl <build-dir> --ready-marker "<a console line>" --tap-marker "<a line the tap logs>"
```

- No emulator and no lease. The folder is served on `localhost` (bound to 127.0.0.1 only) with Unity's Content-Encoding for `.br`/`.gz` build files, COOP/COEP (off with `--no-isolation`) and byte ranges; the browser gets a throwaway profile, muted, removed afterwards (`--keep-profile` keeps it).
- Verdicts and option names follow the PowerShell `smoke-webgl.ps1` (same `summary.json` keys): `--ready-mode marker|loaded|expression`, `--tap-marker` / `--tap-expression` with `--tap-retry`, `--after-tap-expression`, `--fail-expression`, `--info-expression`.
- Added over the PowerShell script: `--tap-input touch`; `--fail-on-console-error` (by default non-fatal console errors such as a logged C# exception are only counted: `console_errors`, `managed_exceptions`); `--ignore-error <regex>` for known third-party errors (`ignored_errors`); `canvas_blank` (the canvas is one flat colour in the final screenshot; fails only with `--fail-on-blank`); `--gpu auto|host|swiftshader` (software WebGL for hosts without a GPU; `auto` uses SwiftShader for a headless run on Linux without a display); `--browser-arg=<switch>` (repeatable, only `--no-sandbox`, `--disable-gpu`, `--disable-dev-shm-usage`, `--ignore-gpu-blocklist`, `--enable-unsafe-swiftshader`, `--use-gl=`, `--use-angle=`, `--lang=`, `--force-device-scale-factor=`, `--enable-features=`, `--disable-features=`; switches that run another program or change the profile, DevTools or audio are `BAD_OPTION`; `--no-sandbox` is added for root). The browser executable comes only from the CLI's `--browser` or `EMU_BROWSER` / `CHROME_PATH`: the MCP tool takes no executable path; `browser_version`, `webgl` (version and renderer), `cross_origin_isolated` and `gpu` in the summary.
- Results: `~/.emu-lab/runs/<stamp>-webgl-<pid>/` (`summary.json`, `console.txt`, `server.log`, `browser.log`, PNG screenshots). Exit 0 PASS, 1 FAIL.

## Builds and the project guard

```bash
emu-lab doctor --project <project> --target android            # editor version and modules, open Editor, git, guard state
emu-lab guard snapshot <project>                                # once, before the first build
emu-lab build <project> --target android --method <Class.Method>   # or --build-profile "Assets/Settings/Build Profiles/<name>.asset"
emu-lab smoke ~/.emu-lab/builds/<folder>-<hash8>/Android/app.apk --ready-marker "<line>"
emu-lab guard report <project>                                  # after the last build: show the list to the person
emu-lab guard revert <project> [--keep "a|b"]                   # only after the person said yes
```

- `build` / `emu_build` follows `build-unity.ps1`: the project's build method (gets `-buildOut <out>`, and `-apkOut` for Android) or a Unity 6 build profile; `BUILD_OK` only when this build wrote the output; a log that reports a failed build fails even with exit code 0; `EMU_BUILD_WARN` / `EMU_BUILD_NOTE` lines are repeated. `PROJECT_OPEN` while an Editor has the project open, `BUILD_RUNNING` while another batchmode Unity builds it. Default output outside the project: `~/.emu-lab/builds/<folder>-<hash8>/` (Android `app.apk`, `WebGL`, Windows `app.exe`). Also `--emu-arm64`, `--release`, `--webgl-compression`, `--extra-arg=<value>` (repeatable), `--timeout-minutes` (default 40).
- Unity is found in this order: `UNITY_EDITOR_ROOT` → Unity Hub's install location (`secondaryInstallPath.json`) → the default location (Windows `%ProgramFiles%\Unity\Hub\Editor`, macOS `/Applications/Unity/Hub/Editor`, Linux `~/Unity/Hub/Editor`) → editors added with Hub's "Locate". Only the exact version in `ProjectVersion.txt` is used.
- If the command is killed (tool timeout, closed terminal) a watchdog stops the hidden Unity; a closing MCP server stops it too. Run `guard report` after a stopped build.
- A project without a build method: after the person agrees, `emu-lab template <project>` / `emu_build_template` copies `EmuProjectBuild.cs` and `EmuLab.Editor.asmdef` (shipped in the package) into a new `Assets/EmuLab/Editor/` — in a git project only after `guard snapshot`, so the report lists it as created and the revert moves it out. Methods: `EmuProjectBuild.BuildApk`, `BuildWebGL`, `BuildWindows`. Never commit it.
- The guard (`guard`, `emu_guard_snapshot` / `emu_guard_report` / `emu_guard_revert`) keeps every rule of `project-guard.ps1`: `changed` files are reverted only when a backup patch covers exactly them and reverse-applies; `created` files are moved to a backup folder, never deleted; files changed before the build (`touched`) and staged files are never reverted; anything changed after the report, or a commit since the snapshot, stops the revert before it changes anything. Its default state folder is `~/.emu-lab/guard/<folder>-<hash8>/`, unlike the script's `<clone>\artifacts\guard\...`; pass `--state-dir` (`state_dir`, `-StateDir`) to continue a cycle the other side started.
- A build switches the project's active platform (stored in Library, not in git). An IL2CPP Windows player builds only on a Windows host with Visual Studio C++ (macOS and Linux: Mono). The Windows player smoke test exists only as `smoke-windows.ps1`.

## MCP tools

| Tool | What it does |
|---|---|
| `emu_doctor` | Host check (emulator acceleration, `-gpu`, Unity editors and modules, the project, SDK and AVD, disk, browser). Changes nothing |
| `emu_status` | Lease (owner, expiry, valid), emulators, boot state, adb and SDK paths. Changes nothing |
| `emu_start` | Take the lease (renew our own, take over an expired one) and boot the AVD; animations and the full-screen hint off; restore a clock left ahead |
| `emu_renew` | Extend our lease |
| `emu_release` | Reset Firebase debug properties and a clock left ahead, optionally uninstall the apps installed under the lease, stop the emulator only if this lease started it, delete the lease |
| `emu_smoke` | Install → launch → ready marker → tap → optional notification check and tap back in. `summary.json` uses the same keys as the PowerShell smoke test |
| `emu_check_notification` | Posted → in the shade → tap opens the app; only notifications posted after the call count |
| `emu_clock` | `forward` (minutes) / `reset` |
| `emu_screenshot` | The current screen as an image; works without a lease |
| `emu_job` | Collect the result of a long-running tool |
| `emu_webgl_smoke` | The WebGL smoke test above, on a build folder. No emulator, no lease |
| `emu_build` | Unity batchmode build (above) |
| `emu_build_template` | Add the build entry to a project without a build method (after the person agrees; after the snapshot in git) |
| `emu_guard_snapshot`, `emu_guard_report`, `emu_guard_revert` | The project guard; revert only after the person said yes to the report |

- Device-changing tools need this session's valid lease (`NO_LEASE`). On `BUSY`, wait or ask the person. Releasing someone else's lease (`--any-owner`) or dropping an expired one (`--stale`) is CLI-only, for the person.
- `emu_start`, `emu_smoke`, `emu_check_notification`, `emu_release`, `emu_webgl_smoke` and `emu_build` run as jobs: they wait `wait_sec` (default 50 s) and otherwise return a `job_id` for `emu_job`, so clients with short tool timeouts are fine.
- One device-changing job per AVD per server at a time (`JOB_RUNNING`).
- When the server shuts down (client exit, Ctrl+C) it puts back any clock it moved and stops the browser of a running WebGL smoke test and a running Unity build. A clock left ahead by a hard kill is reset by the next `start` or `release`.

## Lease

- File `<EMU_LAB_HOME>/leases/<AVD>.json` (default `~/.emu-lab`), created with create-if-absent semantics, so two sessions racing for it cannot both win. Takeover, renew and release briefly hold `<AVD>.json.lock`.
- Owner: `--owner` → `EMU_OWNER` → Claude Code session `claude:<first 8>` → Codex thread `codex:<last 8>` → `user@host`, compared ignoring case. Default 4 hours; `start` again by the same owner renews.
- `release` stops with `LEASE_CHANGED` and does nothing if the lease it read was taken over meanwhile.
- Same format as the PowerShell scripts: a lease taken by either side makes the other side answer `BUSY` (tested both ways on Windows).

## Paths and environment

| Variable | Meaning |
|---|---|
| `EMU_LAB_HOME` | Leases, results, emulator logs, config (default `~/.emu-lab`) |
| `EMU_AVD` | AVD name (default `unity-test`) |
| `EMU_OWNER` | Lease owner |
| `EMU_ADB` | adb executable |
| `ANDROID_SDK_ROOT`, `ANDROID_AVD_HOME` | SDK and AVD locations; macOS/Linux also read `ANDROID_HOME` |
| `EMU_BROWSER`, `CHROME_PATH` | Browser for the WebGL smoke test (in this order; else the default install locations, then PATH) |
| `EMU_GPU` | What `start --gpu auto` uses (`host`, `swiftshader_indirect`, `guest`) |
| `UNITY_EDITOR_ROOT` | Folder holding Unity version folders (or one version folder); searched before Unity Hub's locations |

`<EMU_LAB_HOME>/config.json` may hold `sdkRoot`, `avdHome` and `adb`. Order: environment → `config.json` → default (Windows `%USERPROFILE%\Android\Sdk`, macOS `~/Library/Android/sdk`, Linux `~/Android/Sdk`). Windows ignores `ANDROID_HOME` on purpose (it often points at Android Studio's SDK).

If the same PC also builds Android with Unity, use one adb (`EMU_ADB` or `config.json` `adb` → `<Editor>/Data/PlaybackEngines/AndroidPlayer/SDK/platform-tools/adb`): two adb versions restart each other's server and cut logcat. Unity's Android build stops the adb server when it finishes, so do not build Android on the same PC during a smoke test.

## Tested

2026-11-20 on Windows 10 with Node.js 24.18: 281 device-free tests (fake adb), lease interop with the Windows PowerShell 5.1 scripts (BUSY both ways), and reading the package and ABIs of the Unity 6000.6.0f1 sample APK (IL2CPP ARM64). 2026-11-21 on the same PC: 318 tests (one skipped: it reads the sample APK, which was not built that day), among them the WebGL smoke tests in a real headless Chrome 157 against fake build folders (Brotli and Gzip build files, a dialog, a missing `/Build/` file, an uncaught error, a black canvas, a logged C# exception).

2026-11-21, same PC (0.2.0 work): 421 tests (3 skipped: the sample APK, symlinks on Windows, a case-sensitive file system) — build verdicts against a fake Unity, the guard on real git repositories (Korean, spaces and brackets in paths, a project in a subfolder, more than 40 files in batches, a failing patch, moves across volumes), guard state shared both ways with `project-guard.ps1`, and per-OS host checks with fake probes. A real Unity 6000.6.0f1 built the sample's Windows player through `emu-lab build` (`BUILD_OK`, `EMU_BUILD_NOTE audio-off`; on an editor without the WebGL module it failed with the reason "Error building player because build target was unsupported"), `emu-lab doctor` and `doctor.ps1` gave the same verdicts on this PC, and the lock check found a real open Editor and its import worker.

**Not checked yet (as of 0.2.0):**

- macOS and Linux: builds, the guard and the host check have run only in unit tests and CI on the three OSes, not yet with a real Unity build, a real emulator acceleration check or the lock check (`lsof`, `/proc`) on a real Mac or Linux host.

- Android: the npm package's Android path (`start`, `smoke`, `notification`, `clock`, `release` and the matching MCP tools) has been checked only with the fake-adb tests above and in CI on Windows, macOS and Linux. It has not run against a real emulator yet.
- WebGL: `emu-lab webgl` / `emu_webgl_smoke` has run in a real headless Chrome against fake build folders, not against a real Unity WebGL build.

The PowerShell scripts were checked on both: a real emulator (Android 15, API 35 `google_apis` x86_64) and a real Unity WebGL build. CI runs the device-free tests and the real-browser WebGL tests on Windows, macOS and Linux with Node.js 22 and 24, and on Windows also the lease interop tests, the `.ps1` check (`scripts\check-scripts.ps1`) and the PowerShell WebGL smoke test. An emulator PASS is not a device certification.

## Development

```bash
git clone https://github.com/cyKim0115/unity-emu-lab.git
cd unity-emu-lab
npm install
npm link        # emu-lab runs the TypeScript sources directly
npm test        # runs against a fake adb; never touches a device. The WebGL tests start the installed browser headless and muted
npm run typecheck
```

After changing a `.ps1`, also run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-scripts.ps1` (ASCII and Windows PowerShell 5.1 parser check).

The npm package contains only `bin/`, the compiled `dist/` and the build templates `templates/` (`prepack` builds it). Release: CHANGELOG entry → `npm version <level>` (also bumps `server.json`) → `npm publish` (2FA) → `npm view unity-emu-lab version` → `git push --follow-tags` → MCP Registry: `mcp-publisher login github` → `mcp-publisher publish` (the name `io.github.cyKim0115/unity-emu-lab` must equal `mcpName` in `package.json`; a published version cannot be published again).

## License

[MIT](LICENSE)
