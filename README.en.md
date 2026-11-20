# unity-emu-lab

[한국어](README.md) · [Changelog](CHANGELOG.md)

Self-test Unity Android builds on an emulator on your own PC — by a person or by AI agents, several at a time.

`unity-emu-lab` is an MCP server and a CLI (`emu-lab`) for Windows, macOS and Linux:

- **One device, several sessions**: take, renew and release a lease on the emulator. Another owner's valid lease stops every device-changing step before it runs (`BUSY`). Releasing stops only the emulator this lease started and uninstalls only the apps installed under it.
- **Unity-aware verdicts**: a ready marker in logcat, crashes and ANRs told apart from an app that quits by itself (anti-cheat, integrity or emulator detection), the APK's native ABIs checked before installing (ARM-only builds), the first-run full-screen hint and permission dialogs tapped away.
- **Checks outside the app**: a local notification is posted, drawn in the shade, and tapping it opens the app. The device clock can jump ahead to check notifications scheduled hours later, and is always put back.

Device-control MCP servers such as `@mobilenext/mobile-mcp` or `appium-mcp` hand screenshots and taps to the agent; this package judges the build instead. You can use both, but not at the same time as `emu_smoke` / `emu_check_notification`: both need Android's single UiAutomation connection.

The repository also contains Windows PowerShell scripts (`scripts/`, documented in Korean in [README.md](README.md)) that add Unity batchmode builds, a project guard and a WebGL smoke test. Both share the same lease file and respect each other's leases.

## Requirements

- [Node.js](https://nodejs.org/) 22.18 or later
- Android SDK `platform-tools` (adb) and `emulator`, and one AVD (default name `unity-test`; pick another with `--avd` / the `avd` input / `EMU_AVD`). On Windows, `scripts\setup-android-sdk.ps1` installs both.
- Unity 6 Android players ship ARM libraries only. They run on an API 35 `google_apis` x86_64 image (with ARM translation) or on an arm64 image on Apple Silicon. Mono / ARMv7-only builds cannot run there; the smoke test says so before installing (`ABI_MISMATCH`).

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

## MCP tools

| Tool | What it does |
|---|---|
| `emu_status` | Lease (owner, expiry, valid), emulators, boot state, adb and SDK paths. Changes nothing |
| `emu_start` | Take the lease (renew our own, take over an expired one) and boot the AVD; animations and the full-screen hint off; restore a clock left ahead |
| `emu_renew` | Extend our lease |
| `emu_release` | Reset Firebase debug properties and a clock left ahead, optionally uninstall the apps installed under the lease, stop the emulator only if this lease started it, delete the lease |
| `emu_smoke` | Install → launch → ready marker → tap → optional notification check and tap back in. `summary.json` uses the same keys as the PowerShell smoke test |
| `emu_check_notification` | Posted → in the shade → tap opens the app; only notifications posted after the call count |
| `emu_clock` | `forward` (minutes) / `reset` |
| `emu_screenshot` | The current screen as an image; works without a lease |
| `emu_job` | Collect the result of a long-running tool |

- Device-changing tools need this session's valid lease (`NO_LEASE`). On `BUSY`, wait or ask the person. Releasing someone else's lease (`--any-owner`) or dropping an expired one (`--stale`) is CLI-only, for the person.
- `emu_start`, `emu_smoke`, `emu_check_notification` and `emu_release` run as jobs: they wait `wait_sec` (default 50 s) and otherwise return a `job_id` for `emu_job`, so clients with short tool timeouts are fine.
- One device-changing job per AVD per server at a time (`JOB_RUNNING`).
- When the server shuts down (client exit, Ctrl+C) it puts back any clock it moved. A clock left ahead by a hard kill is reset by the next `start` or `release`.

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

`<EMU_LAB_HOME>/config.json` may hold `sdkRoot`, `avdHome` and `adb`. Order: environment → `config.json` → default (Windows `%USERPROFILE%\Android\Sdk`, macOS `~/Library/Android/sdk`, Linux `~/Android/Sdk`). Windows ignores `ANDROID_HOME` on purpose (it often points at Android Studio's SDK).

If the same PC also builds Android with Unity, use one adb (`EMU_ADB` or `config.json` `adb` → `<Editor>/Data/PlaybackEngines/AndroidPlayer/SDK/platform-tools/adb`): two adb versions restart each other's server and cut logcat. Unity's Android build stops the adb server when it finishes, so do not build Android on the same PC during a smoke test.

## Tested

2026-11-20 on Windows 10 with Node.js 24.18: 281 device-free tests (fake adb), lease interop with the Windows PowerShell 5.1 scripts (BUSY both ways), and reading the package and ABIs of the Unity 6000.6.0f1 sample APK (IL2CPP ARM64). A run of this npm package against a real emulator (Android 15, API 35 `google_apis` x86_64) is still to come; the PowerShell scripts were checked on that setup. macOS and Linux run the device-free tests only (CI). An emulator PASS is not a device certification.

## Development

```bash
git clone https://github.com/cyKim0115/unity-emu-lab.git
cd unity-emu-lab
npm install
npm link        # emu-lab runs the TypeScript sources directly
npm test        # runs against a fake adb; never touches a device
npm run typecheck
```

The npm package contains only `bin/` and the compiled `dist/` (`prepack` builds it). Release: CHANGELOG entry → `npm version <level>` → `npm publish` (2FA) → `npm view unity-emu-lab version` → `git push --follow-tags`.

## License

[MIT](LICENSE)
