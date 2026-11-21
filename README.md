# unity-emu-lab

[English](README.en.md) · [변경 기록](CHANGELOG.md)

Unity 빌드를 내 PC에서 실제로 띄워 **사람·AI 에이전트가 직접 자체 테스트**하는 도구.

- **Android**: 에뮬레이터에 설치해 앱 안(로그 마커·탭 입력)과 앱 밖(시스템 대화상자·알림창·알림 탭 복귀)을 확인한다.
- **WebGL**: 로컬 서버로 띄워 Chrome/Edge/Chromium을 DevTools 프로토콜로 조종한다.
- **Windows**: 이 PC 바탕화면에서 exe를 창 모드로 띄워 `Player.log` 마커·크래시·스스로 종료·오류 대화상자를 가린다(PowerShell 스크립트만).

두 가지 형태로 쓴다.

| 형태 | 하는 일 | 실행 환경 |
|---|---|---|
| npm 패키지 `unity-emu-lab` (MCP 서버 + `emu-lab` CLI) | Android: 에뮬레이터 임대, 기동·놓기, 스모크, 앱 밖 알림 확인, 기기 시계, 스크린샷. APK를 받는다. WebGL: 빌드 폴더를 받아 브라우저 스모크 | Node.js 22.18+, Windows·macOS·Linux |
| PowerShell 스크립트 (`scripts/`) | 위 기능 + Windows 플레이어 스모크, Unity batchmode 빌드, 프로젝트 보호(`project-guard`), SDK 설치·점검 | Windows PowerShell 5.1 |

둘은 같은 임대 파일(`~/.emu-lab/leases/<AVD>.json`)을 써서, 함께 돌아도 서로의 임대를 존중한다.

## npm 패키지 (MCP 서버 + CLI)

### 무엇이 다른가

기기 조작 MCP(`@mobilenext/mobile-mcp`, `appium-mcp` 등)는 스크린샷·탭을 AI에게 넘긴다. 이 패키지는 그 대신 다음을 한다.

- **여러 세션이 기기 하나를 나눠 쓰기**: 임대를 잡고·연장하고·놓는다. 남의 유효한 임대가 있으면 기기를 건드리기 전에 `BUSY`로 멈춘다. 놓을 때는 이 임대가 띄운 에뮬레이터만 끄고, 이 임대에서 설치한 앱만 지운다.
- **Unity 빌드 판정**: logcat의 준비 마커, 크래시·ANR과 「앱이 스스로 끝남」(안티치트·무결성·에뮬레이터 감지)을 구분한다. 설치 전에 APK의 ABI를 보고 ARM 전용 빌드를 먼저 알린다. 전체화면 첫 안내·권한 대화상자는 자동으로 누른다.
- **앱 밖 확인**: 알림이 시스템에 게시됐는지 → 알림창에 그려졌는지 → 탭하면 앱이 열리는지 본다. 기기 시계를 앞당겨 몇 시간 뒤 알림을 바로 확인하고, 끝나면(실패해도) 되돌린다.

mobile-mcp와 같이 써도 된다. 다만 둘 다 UiAutomation을 쓰므로 스모크·알림 확인이 도는 동안에는 mobile-mcp로 기기를 조작하지 않는다.

### 준비물

- [Node.js](https://nodejs.org/) 22.18 이상
- Android SDK의 `platform-tools`(adb)·`emulator`와 AVD 하나(기본 이름 `unity-test`). Windows는 `scripts\setup-android-sdk.ps1`로 만든다(아래 [처음 한 번](#처음-한-번)). 다른 AVD는 `--avd <이름>`(MCP는 `avd`)이나 `EMU_AVD`로 고른다.
- Unity 6 Android 플레이어는 ARM 라이브러리만 있다. API 35 `google_apis` x86_64 이미지(ARM 변환 내장)나 Apple Silicon의 arm64 이미지에서 돈다. Mono·ARMv7 전용 빌드는 못 돈다(스모크가 설치 전에 `ABI_MISMATCH`로 알린다).
- WebGL만 볼 때는 Android SDK가 필요 없다. Chrome, Edge 또는 Chromium 하나가 있으면 된다(기본 설치 위치와 PATH에서 찾고, `EMU_BROWSER`·`CHROME_PATH`·`--browser`로 지정할 수 있다).

### 설치와 등록

```bash
npm install -g unity-emu-lab
emu-lab status
```

`emu-lab status`는 아무것도 바꾸지 않고 임대·에뮬레이터·adb·SDK 경로와 그 출처를 보여 준다.

MCP 서버 명령은 `emu-lab serve`다(인자 없이 실행해도 표준 입력이 터미널이 아니면 서버로 뜬다). Windows에서는 `.cmd`를 바로 실행하지 못하는 클라이언트가 많아 `cmd /c`로 띄운다.

**Claude Code**

```bash
claude mcp add emu-lab -s user -- emu-lab serve           # macOS·Linux
claude mcp add emu-lab -s user -- cmd /c emu-lab serve    # Windows
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.emu-lab]
command = "emu-lab"        # Windows: command = "cmd", args = ["/c", "emu-lab", "serve"]
args = ["serve"]
startup_timeout_sec = 60
```

**Cursor** (`~/.cursor/mcp.json`) / **Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "emu-lab": { "command": "cmd", "args": ["/c", "emu-lab", "serve"] }
  }
}
```

위는 Windows 예다. macOS·Linux에서는 `"command": "emu-lab", "args": ["serve"]`로 쓴다. 설치 없이 `npx -y unity-emu-lab@<버전> serve`로 띄워도 된다(첫 실행은 내려받느라 느리다).

### 빠른 사용 (CLI)

```bash
emu-lab start                                   # 임대를 잡고 에뮬레이터를 띄운다(이미 떠 있으면 다시 쓴다)
emu-lab smoke app.apk --ready-marker "<첫 화면 로그>" --no-tap-check --notif-delay 0
emu-lab release --uninstall                     # 기기 정리, 이 임대가 설치한 앱 제거, 이 임대가 띄운 에뮬레이터 종료
```

- 결과는 `~/.emu-lab/runs/<시각>-smoke-<pid>/`(`summary.json`, `logcat.txt`, `unity.txt`, PNG)에 쌓인다. `--out <폴더>`로 바꾼다.
- 스모크의 기본값은 이 저장소 샘플 앱의 로그 줄이다(`SMOKE_APP_READY`, `SMOKE_TAP count=1`, `SMOKE_NOTIF_SCHEDULED id=<n> title=<제목>`, `SMOKE_OPENED_FROM_NOTIFICATION`, 알림 20초). 다른 앱은 `--ready-marker`를 주고, 탭 로그가 없으면 `--no-tap-check`, 알림 예약 로그가 없으면 `--notif-delay 0`을 준다.
- 몇 시간 뒤 알림: `--notif-delay 7200 --time-travel 185`(비정확 알람은 최대 1시간 늦으니 예약 시간 + 60분 이상). 스모크가 끝나면 시계를 되돌린다.
- 따로 확인: `emu-lab notification --package <id> --title "<제목 일부>" --tap`, `emu-lab clock forward <분>` → `emu-lab clock reset`, `emu-lab screenshot [파일]`.
- 전체 옵션은 `emu-lab help`. 종료 코드는 0 성공, 1 실패·거부(`BUSY`, `NO_LEASE` 등), 2 사용법 오류.
- CLI는 임대 없이 기기 명령을 돌리면 `LEASE_NONE` 경고만 내고 진행한다(사람이 직접 돌릴 때). `--strict`면 거부한다. MCP 도구는 늘 엄격하다.

### WebGL 스모크 (CLI·MCP)

```bash
emu-lab webgl <빌드 폴더> --ready-mode loaded --no-tap-check --headless   # Unity 기본 템플릿, 로그 마커 없음
emu-lab webgl <빌드 폴더> --ready-marker "<콘솔에 찍히는 한 줄>" --tap-marker "<탭하면 찍히는 줄>"
```

- 에뮬레이터·임대가 필요 없다. 빌드 폴더를 `localhost`로 띄우고(127.0.0.1에만 열어 방화벽 창이 뜨지 않음) 브라우저를 임시 프로필·무음으로 연다. 끝나면 프로필을 지운다(`--keep-profile`이면 남김).
- 판정과 옵션 이름은 PowerShell `smoke-webgl.ps1`과 같다(`summary.json` 키도 같음): 준비 `--ready-mode marker|loaded|expression`, 탭 `--tap-marker`/`--tap-expression`·`--tap-retry`, `--after-tap-expression`, `--fail-expression`, `--info-expression`, `--no-isolation`.
- PowerShell 판보다 늘어난 것:
  - `--tap-input touch`: 터치 에뮬레이션을 켜고 터치로 탭한다.
  - `--fail-on-console-error`: 치명 오류가 아닌 콘솔 오류(예: C# 예외 로그)도 실패로 본다. 기본은 개수만 센다(`console_errors`, `managed_exceptions`).
  - `--ignore-error <정규식>`: 맞는 콘솔 오류·예외를 무시한다(외부 분석 스크립트 오류 등). 무시한 개수는 `ignored_errors`.
  - `canvas_blank`: 마지막 스크린샷에서 캔버스가 한 가지 색이면 참. `--fail-on-blank`일 때만 실패로 본다.
  - `--gpu auto|host|swiftshader`: GPU 없는 호스트용 소프트웨어 WebGL. `auto`는 디스플레이 없는 Linux의 headless 실행에서만 SwiftShader를 쓴다.
  - `--browser-arg=<스위치>`(여러 번): 브라우저 스위치 추가(예: 컨테이너의 `--browser-arg=--no-sandbox`. root면 자동으로 붙는다). 정해진 스위치만 받는다(`--no-sandbox`, `--disable-gpu`, `--disable-dev-shm-usage`, `--ignore-gpu-blocklist`, `--enable-unsafe-swiftshader`, `--use-gl=`, `--use-angle=`, `--lang=`, `--force-device-scale-factor=`, `--enable-features=`, `--disable-features=`). 다른 프로그램을 실행하는 스위치(`--renderer-cmd-prefix` 등)나 프로필·DevTools·소리를 바꾸는 스위치는 `BAD_OPTION`이다.
  - 브라우저 실행 파일은 CLI의 `--browser`와 환경 변수(`EMU_BROWSER`·`CHROME_PATH`)로만 고른다. MCP 도구는 실행 파일 경로를 받지 않는다.
  - `summary.json`에 `browser_version`, `webgl`(WebGL 버전과 렌더러), `cross_origin_isolated`, `gpu`가 남는다.
- 결과는 `~/.emu-lab/runs/<시각>-webgl-<pid>/`(`summary.json`, `console.txt`, `server.log`, `browser.log`, PNG). 종료 코드 0 PASS, 1 FAIL.

### MCP 도구

| 도구 | 하는 일 |
|---|---|
| `emu_status` | 임대(주인·만료·유효 여부), 에뮬레이터, 부팅 상태, adb·SDK 경로. 아무것도 바꾸지 않는다 |
| `emu_start` | 임대를 잡고(같은 주인이면 연장, 만료된 임대는 넘겨받기) 에뮬레이터를 띄워 부팅을 기다린다. 애니메이션·전체화면 안내를 끄고, 앞당겨진 시계를 되돌린다 |
| `emu_renew` | 내 임대 연장 |
| `emu_release` | Firebase 디버그 속성·앞당긴 시계를 되돌리고, (선택) 이 임대에서 설치한 앱을 지우고, 이 임대가 띄운 에뮬레이터만 끄고 임대를 지운다 |
| `emu_smoke` | APK 설치 → 실행 → 준비 마커 → 탭 → (선택) 알림 확인·탭 복귀. `summary.json` 키는 PowerShell 스모크와 같다 |
| `emu_check_notification` | 앱 밖 알림 확인(게시 → 알림창 → 탭 복귀). 시작 이후 게시된 알림만 인정한다 |
| `emu_clock` | `forward`(분) / `reset` |
| `emu_screenshot` | 지금 화면을 이미지로 돌려준다. 임대가 없어도 된다 |
| `emu_job` | 오래 걸린 도구의 결과 받기 |
| `emu_webgl_smoke` | WebGL 빌드 폴더를 브라우저로 스모크(위 「WebGL 스모크」). 에뮬레이터·임대가 필요 없다 |

- 기기를 바꾸는 도구는 이 세션의 유효한 임대가 있어야 돈다(`NO_LEASE`). 남의 임대면 `BUSY`: 기다리거나 사람에게 알린다. 남의 임대 풀기(`--any-owner`)·만료 임대 버리기(`--stale`)는 사람만 CLI로 한다.
- `emu_start`·`emu_smoke`·`emu_check_notification`·`emu_release`·`emu_webgl_smoke`는 작업(job)으로 돈다. `wait_sec`(기본 50초)까지 기다렸다가 안 끝나면 `job_id`를 돌려주고, `emu_job`으로 이어 받는다. Codex처럼 도구 제한 시간이 짧은 클라이언트도 끊기지 않는다.
- 한 서버에서 한 AVD에 기기를 바꾸는 작업은 하나씩만 돈다(`JOB_RUNNING`).
- 서버가 닫히면(클라이언트 종료, Ctrl+C) 이 서버가 앞당긴 시계를 되돌리고, 돌던 WebGL 스모크의 브라우저를 끈다. 강제 종료로 남은 시계는 다음 `start`·`release`가 되돌린다.

### 임대

- 파일: `<EMU_LAB_HOME>/leases/<AVD>.json`(기본 `~/.emu-lab`). 새로 잡을 때 「없을 때만 만들기」라 두 세션이 동시에 잡아도 하나만 이긴다. 넘겨받기·연장·놓기는 `<AVD>.json.lock`을 잠깐 잡고 한다.
- 주인: `--owner` → `EMU_OWNER` → Claude Code 세션 `claude:<앞 8자>` → Codex 스레드 `codex:<끝 8자>` → `사용자@PC`. 대소문자는 가리지 않는다(PowerShell과 같음). 기본 4시간, 같은 주인이 다시 `start`하면 연장한다.
- 놓기(`release`)는 읽은 임대가 그새 바뀌었으면(남이 넘겨받음) `LEASE_CHANGED`로 멈추고 아무것도 안 한다.
- PowerShell 스크립트와 같은 형식이라, 한쪽이 잡은 임대를 다른 쪽이 `BUSY`로 존중한다(Windows에서 양쪽으로 시험함).

### 경로와 환경 변수

| 변수 | 뜻 |
|---|---|
| `EMU_LAB_HOME` | 임대·결과·에뮬레이터 로그·설정 폴더(기본 `~/.emu-lab`) |
| `EMU_AVD` | AVD 이름(기본 `unity-test`) |
| `EMU_OWNER` | 임대 주인 |
| `EMU_ADB` | adb 경로 |
| `ANDROID_SDK_ROOT`, `ANDROID_AVD_HOME` | SDK·AVD 위치. macOS·Linux는 `ANDROID_HOME`도 읽는다 |
| `EMU_BROWSER`, `CHROME_PATH` | WebGL 스모크에 쓸 브라우저 실행 파일(이 순서, 없으면 기본 설치 위치 → PATH) |

`<EMU_LAB_HOME>/config.json`에 `sdkRoot`·`avdHome`·`adb`를 적어 둘 수도 있다(PowerShell의 `local.settings.json`과 같은 키). 순서는 환경 변수 → `config.json` → 기본 위치(Windows `%USERPROFILE%\Android\Sdk`, macOS `~/Library/Android/sdk`, Linux `~/Android/Sdk`)다.
Windows는 `ANDROID_HOME`을 일부러 무시한다(Android Studio의 SDK를 건드리지 않으려고).

같은 PC에서 Unity로 Android 빌드도 하면 adb를 하나로 맞춘다(`EMU_ADB`나 `config.json`의 `adb`에 Unity 내장 adb `<에디터>/Editor/Data/PlaybackEngines/AndroidPlayer/SDK/platform-tools/adb`). 버전이 다른 adb 둘이 섞이면 서버가 꺼졌다 다시 떠 logcat이 끊긴다. Unity의 Android 빌드는 끝날 때 adb 서버를 끄므로, 스모크 중에는 같은 PC에서 Android 빌드를 돌리지 않는다.

### 검증 범위

2026-11-20, Windows 10 + Node.js 24.18: 기기 없는 시험 281개(가짜 adb), PowerShell 5.1 스크립트와의 임대 상호 시험(양쪽 BUSY), Unity 6000.6.0f1 샘플 APK(IL2CPP ARM64)의 패키지·ABI 읽기.
2026-11-21, 같은 PC: 시험 311개. 그중 WebGL 스모크 시험은 실제 Chrome 157(headless)로 가짜 빌드 폴더(Brotli·Gzip 빌드 파일, 경고창, 빠진 `/Build/` 파일, 잡히지 않은 오류, 검은 캔버스, C# 예외 로그)를 돌린다.
실제 에뮬레이터(Android 15, API 35 `google_apis` x86_64)로 하는 npm 패키지 확인과 실제 Unity WebGL 빌드로 하는 `emu-lab webgl` 확인은 아직이다(같은 환경에서 PowerShell 스크립트는 둘 다 확인함).
CI는 Windows·macOS·Linux × Node.js 22·24에서 기기 없는 시험과 실제 브라우저 WebGL 시험을 돌리고, Windows에서는 PowerShell과의 임대 상호 시험, `.ps1` 검사(`scripts\check-scripts.ps1`), PowerShell WebGL 스모크도 돌린다. 에뮬레이터 PASS는 실기기 인증이 아니다.

### 개발

```bash
git clone https://github.com/cyKim0115/unity-emu-lab.git
cd unity-emu-lab
npm install
npm link        # emu-lab이 이 폴더의 TypeScript 소스를 빌드 없이 실행한다
npm test        # 가짜 adb로 도는 시험(기기·에뮬레이터를 건드리지 않음). WebGL 시험은 설치된 브라우저를 headless·무음으로 띄운다
npm run typecheck
```

`.ps1`을 고쳤으면 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-scripts.ps1`(ASCII·PowerShell 5.1 구문 검사)도 돌린다.

npm 패키지에는 `bin/`과 컴파일된 `dist/`만 들어간다(`npm publish`가 `prepack`에서 빌드). 배포 절차: `CHANGELOG.md`에 버전·날짜 → `npm version <patch|minor|major>` → `npm publish`(2FA) → `npm view unity-emu-lab version`으로 확인한 뒤 `git push --follow-tags`.

## PowerShell 스크립트 (Windows)

검증: 2026-11-04, Windows 10 + Windows PowerShell 5.1, Unity 6000.6.0f1, Android 15(API 35) `google_apis` x86_64 AVD, Chrome 156.

### 공유받은 분께: AI에게 맡기기

저장소는 Unity 프로젝트 폴더와 그 git 저장소 **밖**에 받는다(예: `git clone <url> %USERPROFILE%\unity-emu-lab`). 그 폴더에서 쓰는 AI(Claude Code·Cursor·Codex)에게 이렇게 말하면 된다.

> 이 저장소의 AGENTS.md 절차대로 내 PC에 설치하고, 샘플로 확인한 다음 `<내 Unity 프로젝트 경로>`에 붙여 Android(또는 WebGL·Windows) 빌드·테스트까지 해줘.

AI는 `AGENTS.md`를 따른다(Claude Code는 `CLAUDE.md`가 이를 불러온다). 아래는 **사람이 직접 하는 일**이다. AI가 `scripts\doctor.ps1` 결과의 `[HUMAN]` 줄로 알려 준다.

| 할 일 | 언제 |
|---|---|
| Unity Hub에서 프로젝트 버전 에디터 + **Android Build Support**(OpenJDK, Android SDK & NDK Tools) / **WebGL Build Support** / (IL2CPP 프로젝트의 Windows) **Windows Build Support (IL2CPP)** + Visual Studio C++ 설치 | 없을 때 |
| 샘플 확인용 **Unity 6000.6.0f1**(정확한 버전, Hub 아카이브) + 쓸 대상 모듈 설치. 건너뛰려면 AI에게 「샘플 확인은 생략」 | 샘플로 먼저 확인할 때 |
| Android SDK 설치용 **JDK 17**: Unity 6 에디터(OpenJDK 17) + Android Build Support, 또는 Unity External Tools·`JAVA_HOME`의 JDK 17. 프로젝트가 2022.3이어도 필요 | JDK 17이 없을 때 |
| BIOS의 CPU 가상화, Windows 기능 **Windows 하이퍼바이저 플랫폼** 켜기(관리자, 재부팅) | Android 에뮬레이터 가속이 안 될 때 |
| **Android SDK 라이선스 동의**(AI가 묻는다. 약 1.5GB 다운로드, SDK 약 4.5GB + AVD 최대 약 10GB) | Android를 처음 쓸 때 |
| 오래 걸리는 단계를 기다리기: SDK 설치 5~20분, 샘플 첫 실행 3~6분, 프로젝트 빌드 최대 40분(기본 제한) | 설치·빌드 때 |
| (Claude Code에서 mobile-mcp를 쓸 때) `claude` 실행 중 프로젝트 MCP 승인 | 선택 |
| (Codex에서 mobile-mcp를 쓸 때) 전역 `~/.codex/config.toml`에 mobile-mcp 추가 승인(모든 Codex 세션에 적용) | 선택 |
| 다른 에뮬레이터(Android Studio 개인 AVD 등)가 떠 있으면 닫기. 스크립트는 AVD `unity-test`만 건드린다 | Android 테스트 때 |
| 빌드 전 사용자 프로젝트의 작업 중 변경을 커밋·stash할지, 빌드가 바꾼 파일을 되돌릴지 결정(AI가 묻는다) | 프로젝트에 붙일 때 |

필요한 것: Windows 10/11 x64(Windows on ARM은 WebGL만), RAM 16GB 이상 권장, 디스크 여유 약 20GB, Chrome 또는 Edge(WebGL), git, Node.js 20+(mobile-mcp를 쓸 때만).
Python·Node·Playwright 없이 PowerShell 5.1만으로 돈다.

### 구성

| 경로 | 역할 |
|---|---|
| `AGENTS.md`, `CLAUDE.md` | AI가 따를 설치·적용 절차와 규칙 |
| `package.json`, `src/`, `bin/`, `test/` | npm 패키지 `unity-emu-lab`(MCP 서버 + `emu-lab` CLI, 위 「npm 패키지」). `npm test`는 가짜 adb로 돈다 |
| `scripts/doctor.ps1` | 새 PC 사전 점검(바꾸는 것 없음). 가상화·Unity 모듈(External Tools 포함)·SDK·AVD 위치·디스크·브라우저·앱 가상화·이 저장소 위치·프로젝트 잠금·git을 `OK/TODO/HUMAN/WARN/FAIL`로 출력 |
| `scripts/setup-android-sdk.ps1` | 독립 Android SDK에 emulator·platform-tools·시스템 이미지 설치, AVD 생성. Unity에 딸린(또는 External Tools) JDK 17·cmdline-tools로 부트스트랩. `-SdkRoot`/`-AvdHome`은 `local.settings.json`(git 제외)에 남는다. `-Proxy host:port`. 끝 줄 `SETUP_DONE accel=ok`(0) 또는 `accel=missing`(2) |
| `scripts/start-emulator.ps1` | AVD 임대를 잡고(남이 잡고 있으면 `BUSY`로 멈춤, 같은 주인이면 연장) 부팅(기본 창 모드, 무음), 부팅 완료 대기, 애니메이션 끄기·전체화면 첫 안내 끄기, 이전 실행이 앞당겨 둔 시계 복구(`TIME_RESET`) |
| `scripts/release-emulator.ps1` | 임대 놓기: Firebase 디버그 모드·`log.tag.FA` 끄기, 앞당긴 시계 복구, (`-Uninstall`) 이 임대에서 설치한 앱 제거, 이 임대가 띄운 에뮬레이터만 끄기, 임대 파일 삭제. 남의 임대는 `-AnyOwner`, 시간이 지난 임대는 `-Stale`(사람만) |
| `scripts/build-unity.ps1` | Unity batchmode 빌드(`-Target Android\|WebGL\|Windows`). `-Method`(빌드 메서드) 또는 `-BuildProfile`(Unity 6 빌드 프로필). 이번 빌드가 `-Out`에 새로 쓴 경우에만 `BUILD_OK`. 호출자가 죽으면 숨은 Unity도 끈다. 출력 기본값은 `artifacts\builds\<폴더>-<해시8>\`. `build-android.ps1`은 Android 단축 |
| `scripts/smoke-webgl.ps1` | WebGL 빌드를 로컬 서버로 띄우고 브라우저(임시 프로필, 무음)로 열어 준비 확인 → 캔버스 클릭 → 콘솔 오류·경고창·Unity 오류 배너 수집. 결과는 `artifacts\<시각>-webgl-<PID>\` |
| `scripts/smoke-windows.ps1` | Windows 플레이어를 이 PC에서 창 모드로 띄워 `Player.log` 준비 마커 → (`-Tap`일 때만) 실제 마우스 클릭 → 창 캡처, 크래시·스스로 종료·오류 대화상자·C# 예외 구분. 소리 끈 빌드만 띄움. 결과는 `artifacts\<시각>-windows-<PID>\` |
| `scripts/serve-static.ps1`, `scripts/cdp.ps1` | 관리자 권한 없는 정적 서버(`.br`·`.gz`에 Content-Encoding), PowerShell 5.1용 DevTools 클라이언트 |
| `scripts/smoke-test.ps1` | 설치 → 실행 → 준비 마커 → 탭 → 홈 → 로컬 알림 확인 → 알림 탭 복귀. 결과는 `artifacts\<시각>-smoke-<PID>\` |
| `scripts/check-notification.ps1` | 앱 밖에서 알림 확인: `dumpsys notification` → 알림창 펼치기 + `uiautomator dump` → (옵션) 탭해서 앱 복귀 |
| `scripts/time-travel.ps1` | 기기 시계를 앞당겨 몇 시간 뒤 알림을 바로 확인. `-Reset`으로 복구(두 번 해도 된다) |
| `scripts/run-all.ps1` | 부팅 → 빌드 → 스모크 한 번에. 다른 대상의 옵션을 섞으면 시작 전에 멈춘다 |
| `scripts/watch-parent.ps1` | 감시 프로세스: 호출자가 강제 종료되면 서버·브라우저·logcat(`-Match`), 숨은 Unity(`-ChildPid`)를 끄고 기기 시계를 되돌린다(`-ResetClock`) |
| `sample/EmuSmoke` | 검증용 Unity 6.6 프로젝트(Mobile Notifications 2.5.0, OnGUI, `SMOKE_*` 로그 마커. Windows 플레이어는 `-emuSmokeFault crash\|exception\|quit`로 일부러 실패) |
| `scripts/project-guard.ps1` | 사용자 프로젝트 빌드 전후 보호: `Snapshot`(첫 빌드 전 한 번. 작업 중 변경 기록, 추적 파일만 패치 백업) → `Report`(빌드가 바꾼 것) → 동의 후 `Revert`(Report에 있던 빌드 변경만 되돌리고 새 파일은 백업으로 이동, 남길 파일은 `-Keep`). 두 번째 Snapshot은 그사이 변경이 있으면 `-Replace` 없이 멈추고, Unity가 프로젝트를 잡고 있거나 Report 뒤 내용·커밋이 바뀌면 Report·Revert가 멈춘다. Revert 뒤 기록은 보관 처리. 한글·공백·대괄호 경로, 하위 폴더 프로젝트 지원 |
| `templates/EmuProjectBuild.cs`, `templates/EmuLab.Editor.asmdef` | 빌드 메서드가 없는 사용자 프로젝트용 batchmode 빌드 진입점(Unity 2021.2+). 동의 후 두 파일을 **새 폴더** `Assets/EmuLab/Editor/`에 복사, 커밋하지 않음. 켜진 씬을 현재 설정으로 빌드하고, 그 빌드 동안만 AAB·Export Project·ABI별 분할을 끄고 되돌린다. 키스토어 암호가 없으면 디버그 서명. Mono 프로젝트는 `-EmuArm64`로 그 빌드만 IL2CPP + ARM64. `BuildWindows`는 그 빌드 동안만 Disable Unity Audio·Run In Background·Use Player Log를 켜고 되돌린다 |
| `.mcp.json`, `.cursor/mcp.json` | 에이전트용 `mobile-mcp`(1.0.12): 스크린샷·탭·스와이프·요소 목록·앱 설치. Codex는 전역 설정이라 사용자 승인 후 추가(아래 조각, `AGENTS.md` 「mobile-mcp」) |

Codex에서 mobile-mcp를 쓸 때 `~/.codex/config.toml` 끝에 붙이는 조각이다. 모든 Codex 세션에 적용되므로 사용자 승인 뒤에만 넣는다. `<USERPROFILE>`은 실제 경로로 바꾼다.

```toml
[mcp_servers.mobile-mcp]
command = "cmd"
args = ["/c", "npx", "-y", "@mobilenext/mobile-mcp@1.0.12"]
env = { ANDROID_HOME = "<USERPROFILE>\\Android\\Sdk" }
startup_timeout_sec = 120
```

Unity 에디터는 `UNITY_EDITOR_ROOT`, Unity Hub 설치 위치(Preferences > Installs), 기본 위치(`C:\Program Files\Unity\Hub\Editor`), Hub에 「Locate」로 추가한 에디터 순으로 찾는다. 같은 버전이 두 곳에 있으면 앞의 것을 쓴다.
Android SDK는 `ANDROID_SDK_ROOT` → `local.settings.json`의 `sdkRoot` → `%USERPROFILE%\Android\Sdk`, AVD는 `ANDROID_AVD_HOME` → `avdHome` → `%USERPROFILE%\.android\avd` 순이다.
`ANDROID_HOME`은 일부러 무시한다(Android Studio가 `%LOCALAPPDATA%\Android\Sdk`로 두는 경우가 많고, 그 SDK의 emulator를 바꾸지 않으려고). 결과는 `artifacts\`(git 제외)에 쌓인다.
adb는 `EMU_ADB` → `local.settings.json`의 `adb` → SDK의 `platform-tools\adb.exe` 순이다. 같은 PC에서 Unity로 Android 빌드도 하면 Unity 내장 adb(`<에디터>\Editor\Data\PlaybackEngines\AndroidPlayer\SDK\platform-tools\adb.exe`)를 고른다. 버전이 다른 adb 둘이 섞이면 서버가 꺼졌다 다시 떠 logcat 수집이 끊긴다. 에뮬레이터는 adb 버전과 상관없이 붙는다.

PowerShell 스크립트는 ASCII만 쓴다(Windows PowerShell 5.1이 BOM 없는 파일을 CP949로 읽음).
adb 출력은 UTF-8로 읽는다(콘솔 코드 페이지 CP949로 읽으면 한글 알림 제목이 깨진다).
에뮬레이터·logcat 같은 오래 사는 자식 프로세스는 `cmd`를 거쳐 띄운다. `Start-Process -Redirect*`로 띄우면 호출자의 출력 파이프를 물려받아,
출력을 받는 호출자(CI, 에이전트, `| Tee-Object`)가 에뮬레이터가 꺼질 때까지 끝나지 않는다.

### 처음 한 번

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\doctor.ps1 -Target Android
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-android-sdk.ps1 -AcceptLicenses
```

`-Target`은 쓰는 대상만 준다(`Android`, `WebGL`, `Windows`, Android와 WebGL 둘 다 `Both`). 프로젝트까지 보려면 `-ProjectPath <프로젝트>`, 샘플 확인을 건너뛰려면 `-NoSample`.

`-AcceptLicenses`는 Android SDK 라이선스 동의다. 받는 양: emulator 약 1.0GB, 시스템 이미지 약 3.5GB(압축 해제 기준).

### 매번

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-all.ps1
```

결과 예(2026-11-04 실측): 첫 빌드 99초·증분 22~66초(IL2CPP ARM64, 22.4MB), 실행 0.9~4.9초, 20초 예약 알림 25~34초에 게시, 알림창 표시·탭 복귀 PASS.
출력을 캡처하는 호출(`$r = powershell -File scripts\run-all.ps1 -AskPermission`)로 빌드부터 권한 대화상자 자동 허용까지 118초에 끝났다.

다 쓰면 놓는다(Android):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release-emulator.ps1 -Uninstall
```

#### 임대 (한 번에 한 세션)

에뮬레이터는 PC에 하나라, 두 세션(사람·AI)이 동시에 설치·탭하면 서로의 테스트를 망친다. 그래서 unity-slot처럼 잡고 놓는다.

- `start-emulator.ps1`(`run-all.ps1`이 부름)이 `%USERPROFILE%\.emu-lab\leases\<AVD>.json`을 `CreateNew`로 만든다. 두 세션이 동시에 만들어도 하나만 이긴다. 위치는 `EMU_LAB_HOME`으로 옮길 수 있다.
- 주인: `-Owner` → `EMU_OWNER` → Claude Code 세션 `claude:<앞 8자>` → Codex 스레드 `codex:<끝 8자>` → `사용자@PC`(unity-slot과 같은 규칙). 기본 4시간(`-Hours`), 같은 주인이 다시 부르면 연장한다. 시간이 지난 임대는 다음 `start-emulator.ps1`이 넘겨받는다.
- 남의 유효한 임대가 있으면 `start-emulator`·`smoke-test`·`check-notification`·`time-travel`(앞당기기)이 기기를 건드리기 전에 `BUSY`로 멈춘다. 임대 없이 돌리면 `LEASE_NONE` 경고만 내고 진행한다(사람이 직접 돌릴 때).
- `smoke-test.ps1`은 설치한 패키지를 임대에 적어 두고, `release-emulator.ps1 -Uninstall`이 그 앱(과 데이터)을 지운다. 빼면 `KEPT apps ...`로 남긴 앱을 알린다.
- `release-emulator.ps1`은 임대를 잡을 때 이미 떠 있던 에뮬레이터는 끄지 않는다. 이 임대가 띄운 인스턴스(pid·시작 시각으로 확인)만 `emu kill`한다. `-KeepRunning`이면 그것도 둔다.

#### WebGL

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-all.ps1 -Target WebGL
```

필요한 것: Unity의 WebGL Build Support 모듈, Chrome 또는 Edge. 추가 설치(Python·Node·Playwright)는 없다.
결과 예(2026-11-04 실측): 개발 빌드 43초(32.7MB), 준비 2.6초, 캔버스 클릭 PASS, 전체 54초.
릴리스 빌드 Brotli(4.7MB)·Gzip(6.1MB) 모두 http://localhost에서 그대로 떴다(Chrome 156).

- 준비 판정: 기본은 콘솔 로그 `-ReadyMarker`. 로그가 없는 프로젝트는 `-ReadyMode Loaded`(Unity 기본 템플릿의 로딩바가 사라지면 준비, 커스텀 템플릿이면 마커를 쓴다).
  페이지가 상태를 노출하면 `-ReadyMode Expression -ReadyExpression "<JS>"`, 탭 결과는 `-TapExpression "<JS>" -TapTimeoutSec <초>`,
  페이지 자체 오류 UI는 `-FailExpression "<오류일 때 문자열을 돌려주는 JS>"`, 기록할 값은 `-InfoExpression "<JS>"`(식 안에서는 작은따옴표).
- 실패 판정: 잡히지 않은 예외, 렌더러 크래시, 경고창(Unity 로더는 치명 오류를 `alert()`로 띄움, 자동으로 닫고 기록), Unity 오류 배너,
  `/Build/` 파일 4xx·5xx, wasm 준비 실패, WebGL 컨텍스트 실패. 고장 낸 빌드(.wasm 삭제)로 4초 만에 FAIL 나는 것을 확인했다.
- 옵션: `-Headless`(창 없이), `-Width/-Height`(뷰포트), `-TapX/-TapY`(캔버스 비율), `-NoTap`, `-NoTapCheck`, `-Browser <exe>`,
  `-ReadyTimeoutSec`, `-KeepProfile`(임시 브라우저 프로필을 지우지 않음, 기본은 실행 뒤 삭제). `run-all.ps1`도 같은 이름으로 넘겨준다(모르는 옵션은 오류).
- 서버는 Unity Build And Run 서버처럼 COOP/COEP/CORP 헤더를 보낸다. 멀티스레드 빌드가 SharedArrayBuffer를 쓸 수 있다.
  커스텀 템플릿이 CORP/CORS 없는 외부 파일을 불러오면 `-NoIsolation`으로 끈다.
  `.br`·`.gz` Content-Encoding은 Unity 빌드 파일(`*.data|js|wasm|symbols.json`)에만 붙인다. 동시 요청과 Range 요청(동영상)도 처리한다.
- 호출자가 강제 종료돼도 감시 프로세스(`watch-parent.ps1`)가 서버·브라우저·logcat을 정리한다. 결과 폴더는 `artifacts\<시각>-<종류>-<PID>\`.
- 샘플 빌드 옵션: `-Release`(개발 빌드 아님, WebGL은 이때만 압축), `-WebGLCompression brotli|gzip|disabled`(그 빌드에만 적용, ProjectSettings는 원래대로 되돌림).
- 다른 프로젝트: `run-all.ps1 -Target WebGL -SkipBuild -BuildDir <빌드 폴더> -ReadyMode Loaded -NoTapCheck`.
- 빌드가 이미 있으면 npm 패키지의 `emu-lab webgl <빌드 폴더>`로도 같은 판정을 한다(macOS·Linux 포함, 위 「WebGL 스모크 (CLI·MCP)」).
- 탭이 먹을 때까지 다시 탭: `-TapExpression "<탭이 먹혔을 때 참>" -TapRetrySec 5 -TapTimeoutSec 60`, 그 뒤 기다릴 상태는 `-AfterTapExpression`·`-AfterTapTimeoutSec`. 마지막 대기 `-SettleSec`(기본 2초) 뒤 `03-final.png`.

##### 예: 상태를 노출하는 커스텀 템플릿

WebGL 템플릿이 진행 상태를 `window.app.stage`(`loading` → `title` → `playing`)로 노출하고, 오류는 `#error` 요소에 보여 준다고 하자.
타이틀이 인트로 동안 입력을 무시해서 탭이 먹을 때까지 다시 탭하고, 탭 뒤 `playing`이 될 때까지 기다린다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke-webgl.ps1 -BuildDir <out> -NoIsolation -SettleSec 10 -ReadyTimeoutSec 240 `
    -ReadyMode Expression -ReadyExpression "window.app && window.app.stage === 'title'" `
    -TapX 0.5 -TapY 0.6 -TapExpression "window.app && window.app.stage !== 'title'" -TapRetrySec 5 -TapTimeoutSec 60 `
    -AfterTapExpression "window.app && window.app.stage === 'playing'" -AfterTapTimeoutSec 120 `
    -FailExpression "document.querySelector('#error') && getComputedStyle(document.querySelector('#error')).display !== 'none' && document.querySelector('#error').innerText.slice(0, 300)"
```

- `-ReadyExpression`: 타이틀이 뜨면 준비로 본다.
- `-TapExpression` + `-TapRetrySec`: 상태가 `title`에서 벗어날 때까지 5초마다 다시 탭한다(최대 60초).
- `-AfterTapExpression`: 탭 뒤 게임 화면(`playing`)까지 기다린다.
- `-FailExpression`: 템플릿 오류 UI가 보이면 그 글을 실패 이유로 남긴다.
- `-NoIsolation`: 배포처(GitHub Pages 등)가 COOP/COEP를 보내지 않는 단일 스레드 빌드면 같은 조건으로 맞춘다.
- 빌드가 프로젝트 파일을 바꿔 놓으면 `scripts\project-guard.ps1`(Snapshot → Report → 동의 후 Revert)로 되돌린다(`AGENTS.md` 규칙 5).

몇 시간 뒤 알림(샘플처럼 앱이 예약 로그를 남길 때):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke-test.ps1 -Apk <apk> -NotifDelay 7200 -TimeTravelMinutes 185
```

#### Windows

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-all.ps1 -Target Windows
```

이 PC 바탕화면에서 Windows 플레이어(exe)를 창 모드로 띄워 판정한다. 에뮬레이터·브라우저·임대가 없다. 필요한 것: Unity의 Windows Build Support(Windows 에디터에 Mono가 딸려 온다. 프로젝트가 IL2CPP면 IL2CPP 모듈 + Visual Studio의 「C++를 사용한 데스크톱 개발」).
결과 예(2026-11-21 실측, 6000.6.0f1 Mono 개발 빌드 41.7MB): 첫 빌드 46초(플랫폼 전환 포함)·증분 14초, 준비 4~8초, 전체 30초 안팎.

- 빌드: `EmuProjectBuild.BuildWindows`(템플릿)와 샘플 `EmuBuild.BuildWindows`는 그 빌드 동안만 **Disable Unity Audio**를 켜고 끝나면 되돌린다(`EMU_BUILD_NOTE audio-off:`). 소리 끈 테스트 빌드라 배포 빌드와 바이너리가 다르다.
  템플릿은 Run In Background·Use Player Log도 그 빌드 동안만 켠다. `-Out`은 `.exe`, 기본 출력은 `artifacts\builds\<폴더>-<해시8>\Windows\app.exe`(샘플은 `Builds\Windows\app.exe`).
- 소리: 플레이어를 무음으로 띄우는 명령줄 스위치가 없다(`UnityPlayer.dll`에 `disableaudio` 문자열이 있지만 `-disableaudio`를 줘도 오디오 시계가 돌았다). 그래서 `smoke-windows.ps1`은 exe 옆 빌드 로그에 `audio-off` 줄이 있을 때만 띄우고,
  없으면(자체 빌드 메서드·빌드 프로필·에디터 빌드) 시작 전에 멈춘다. 소리가 나도 되면 `-AllowAudio`. 시스템 음량·음소거·볼륨 믹서는 건드리지 않는다.
- 준비: `-logFile <결과 폴더>\Player.log`로 받은 로그에서 `-ReadyMarker`(기본 `SMOKE_APP_READY`)를 기다린다. `-screen-fullscreen 0 -screen-width/-height`로 창 모드(`-Width`·`-Height`, 기본 1280×720).
- 판정: `crash`(Player.log `Crash!!!`, `%TEMP%\<회사>\<제품>\Crashes\`의 새 폴더, NTSTATUS 종료 코드), `app_exited`(크래시 없이 스스로 종료), `dialog`(오류 대화상자 글), `data_dir`(`<이름>_Data` 없음)는 FAIL.
  C# 예외는 `exceptions`·`first_exception`으로 세기만 하고 `-FailOnException`이면 FAIL. 끝나면 이 실행이 띄운 플레이어만 WM_CLOSE로 닫고, 안 닫히면 그 프로세스 트리만 끈다. 같은 exe가 이미 떠 있으면 시작하지 않는다.
  샘플 `-ExeArgs @('-emuSmokeFault','crash'|'exception'|'quit')`로 확인: 크래시 FAIL(`0xC0000005`, 크래시 폴더), 예외 PASS(`exceptions=1`)·`-FailOnException` FAIL, 종료 FAIL(`exit_code=3`), `app_Data`를 지운 복사본 FAIL, `MonoBleedingEdge`를 지운 복사본 FAIL(대화상자 「Failed to load mono」).
- 스크린샷: `PrintWindow`로 플레이어 창 클라이언트 영역만 찍는다(다른 창에 가려져도 됨, 화면 복사는 창이 맨 앞일 때만). `01-ready.png`, `02-after-tap.png`, `03-final.png`.
- 탭: 기본은 없다. `-Tap [-TapX -TapY -TapMarker | -NoTapCheck]`일 때만 실제 마우스 입력(SendInput)으로 누른다. **플레이어 창을 앞으로 올려 포커스를 가져가고 커서를 잠깐 옮긴다**(되돌림).
  창이 최소화돼 있으면 복원하고, 그 점이 화면 밖이거나 다른 창이 덮고 있으면 누르지 않는다.
- PlayerPrefs: 플레이어는 `HKCU\Software\<회사>\<제품>`에 남기고 실행할 때마다 창 크기를 쓴다. 기본은 두고 `prefs_key`·`PREFS_LEFT`로 알린다. `-CleanPrefs`면 그 키 하나만 결과 폴더에 `reg export`한 뒤 지우고 시작하고(`prefs-before.reg`), 끝나면 다시 내보내 지운다(`prefs-after.reg`). 되돌리기 `reg import <파일>`.
- 플레이어 인자는 `-ExeArgs @(...)`(`powershell -Command`로만). 결과는 `artifacts\<시각>-windows-<PID>\`(`Player.log`, PNG, `summary.json`), 끝 줄 `WINDOWS_SMOKE PASS/FAIL`.
- Claude 데스크톱 같은 패키지(MSIX) 앱 안에서 띄우면 플레이어의 PlayerPrefs·크래시 폴더가 그 앱 전용 사본에 남을 수 있다(doctor `packaged-host`).

### 다른 프로젝트에 붙이기 (Android)

빌드 전후는 `project-guard.ps1`로 감싼다(첫 빌드 전 `Snapshot`, 마지막 빌드 뒤 `Report`, 동의 후 `Revert`. `AGENTS.md` 규칙 5).

1. 빌드: 그 프로젝트가 에디터에 열려 있으면 batchmode가 막힌다(`Temp\UnityLockfile`. doctor·build-unity가 잡고 있는 프로세스를 알려 준다).
   에디터를 닫고 `run-all.ps1 -ProjectPath <p> -Method <Class.Method>`(또는 `-BuildProfile <asset>`)로 빌드부터 하거나,
   열린 에디터에서 빌드(Build Profiles 창 또는 unityMCP `manage_build`)한 APK를 `-SkipBuild -Apk`로 넘긴다.
   출력 기본값은 이 저장소 `artifacts\builds\<폴더>-<해시8>\Android\app.apk`(프로젝트 밖)다. Mono·ARMv7 프로젝트는 템플릿 + `-EmuArm64`.
   패키지 이름은 APK에서 읽는다(aapt2). `-Package`를 주면 APK와 맞는지 확인한다.

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-all.ps1 -SkipBuild -Apk <apk> -ReadyMarker "<로그>" -NoTapCheck -NotifDelay 0
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-all.ps1 -ProjectPath <p> -Method EmuProjectBuild.BuildApk -EmuArm64 -ReadyMarker "<로그>" -NoTapCheck -NotifDelay 0
   ```

2. 준비 신호: `-ReadyMarker "<첫 화면이 뜰 때 찍히는 로그>"`. 없으면 첫 화면에서 `Debug.Log` 한 줄을 추가한다.
3. 탭: `-TapX/-TapY`(회전 반영한 현재 화면 비율)로 위치를 정한다. 확인은 `-TapMarker "<탭 로그>"`(기본 `SMOKE_TAP count=1`은 샘플만 찍는다). 탭 로그가 없으면 `-NoTapCheck`, 탭 자체를 빼려면 `-NoTap`.
4. 알림: 앱이 예약 때 로그를 남기면 `-NotifScheduledRegex "<정규식, 1번 그룹 = 제목>"`(예: `"Scheduled notification: (.+)"`)으로 스모크가 자동 확인한다.
   알림 탭 뒤 열림은 `-OpenedMarker "<로그>"`, 그런 로그가 없으면 `-NoOpenedMarker`(앞에 뜬 화면으로 판단). 이때만 `-TimeTravelMinutes`를 쓴다.
   예약 로그가 없으면 `-NotifDelay 0`으로 스모크에서 빼고, 게임에서 알림을 예약한 뒤 `check-notification.ps1 -Package <id> -Title "<알림 제목 일부>" -Tap`으로 따로 확인한다.
   - 제목은 와일드카드 없는 부분 문자열이다. 한글·대괄호(`[이벤트]`) 제목도 된다.
   - 스크립트를 시작한 시각 이후에 게시된 알림만 인정한다(같은 제목의 옛 알림으로 통과하지 않게). 이미 게시된 알림을 보려면 `-SinceMs <기기 epoch ms>`를 준다.
   - `-Tap`이면 앱이 앞에 떠 있을 때 먼저 홈으로 보낸 뒤 알림을 탭한다. 앱이 「알림으로 열림」 로그를 남기면 `-OpenedMarker "<로그>"`로 더 확실히 본다(logcat은 스크립트가 직접 받는다).
   - 몇 시간 뒤 알림을 수동으로 볼 때: `time-travel.ps1 -Minutes <지연+60 이상>` → `check-notification.ps1` → 결과와 상관없이 `time-travel.ps1 -Reset`.
5. 권한 대화상자까지 보려면 `-AskPermission`(이전 실행의 알림 권한을 회수하고 대화상자가 다시 뜨게 함, 「Allow」는 자동 탭).
6. `summary.json`의 `app_exited=true`는 앱이 크래시 없이 스스로 끝난 것이다(안티치트·무결성·에뮬레이터 감지, 시작 때 로그인·네트워크 확인). 그 확인을 끈 테스트 빌드가 필요하다.

### 이번에 확인한 함정

- **x86_64 이미지 + ARM 전용 APK**: Unity 6.6 Android 플레이어에는 x86_64 라이브러리가 없다(arm64-v8a/armeabi-v7a만).
  API 35 이미지는 `abilist=x86_64,arm64-v8a`, native bridge(Berberis)로 ARM64 IL2CPP 빌드를 그대로 돌린다. Vulkan은 호스트 GPU로 동작(검증 PC는 NVIDIA).
- **첫 실행 「Viewing full screen」 안내**: 전체화면 앱 첫 실행 때 시스템 대화상자가 포커스를 가져갔고,
  이번 실측(6000.6.0f1, GameActivity)에서는 포커스가 돌아올 때까지 첫 씬의 `Start()`가 돌지 않았다(CPU 0%, 마커 없음).
  Unity 문서에 적힌 동작은 아니다.
  `start-emulator.ps1`이 `immersive_mode_confirmations=confirmed`로 미리 끄고, `smoke-test.ps1`은 「Got it」「Allow」「OK」를 찾아 눌러 `system-dialogs.txt`에 남긴다.
- **비정확 알람의 1시간 창**: Mobile Notifications 기본값은 `AlarmManager.set(RTC_WAKEUP)`(비정확).
  Android 15에서 2시간 뒤 예약은 `window=+1h` → 실기기에서도 최대 1시간 늦을 수 있다. 정확한 시각이 필요하면 Mobile Notifications 설정의 Exact scheduling을 검토(구글 플레이 정책 제약 있음).
- **AI 앱 안에서 설치하면 AppData가 가상화된다**: Claude 데스크톱 앱처럼 패키지(MSIX)로 설치된 앱 안의 에이전트가 `%LOCALAPPDATA%`에 쓰면,
  실제로는 `AppData\Local\Packages\<앱>\LocalCache\Local\...`로 들어간다. 에이전트 셸에서는 보이지만 일반 터미널에서는 없다
  (`adb.exe ... 인식되지 않습니다`). 그래서 SDK 기본 위치를 `%USERPROFILE%\Android\Sdk`로 둔다.
- **cmdline-tools 23의 avdmanager는 Java 17 이상**: sdkmanager는 Android CLI(자체 JRE)로 넘어가 JAVA_HOME과 상관없다. 그러나 avdmanager.bat는 Java 17 미만이면
  메시지만 찍고 종료 코드 0으로 끝난다(AVD 없음). Unity 2023.x 이하의 OpenJDK는 11이라 SDK 설치는 Unity 6 에디터의 JDK로 한다(스크립트가 고르고, 없으면 미리 멈춘다).
- **ARMv7 전용 APK는 못 돈다**: x86_64 이미지는 `x86_64`·`arm64-v8a`만 돌린다. Mono 백엔드나 ARMv7만 체크한 빌드는 IL2CPP + ARM64로 테스트 빌드를 따로 만든다
  (템플릿 + `-EmuArm64` 스위치: Mono·ARMv7 설정에서 `arm64-v8a` APK를 만들고 설정을 원래대로 되돌리는 것을 확인했다).
  스모크는 설치 전에 APK의 ABI를 보고 먼저 알린다.
- **다른 에뮬레이터**: 스크립트는 `adb emu avd name`으로 AVD `unity-test`만 고른다. 다른 AVD만 떠 있으면 설정·시계를 건드리지 않고 멈춘다.
- **`-File` 인자 끝의 `\`**: `-ProjectPath "C:\Game\"`처럼 쓰면 PowerShell 5.1이 `\"`를 따옴표 글자로 읽어 뒤 인자를 삼킨다. 경로는 `\`로 끝내지 않는다(스크립트는 따옴표가 섞인 경로를 거부한다).
- **한글 프로젝트 경로(Android)**: Unity가 Android 빌드를 바로 거부한다(「Project path ... contains non-ASCII characters ... Android Tools don't work properly」). 프로젝트는 ASCII 경로에 둔다. WebGL은 같은 경로에서 빌드됐다.
- **대괄호 프로젝트 경로(Android)**: `C:\Work\Game [v2]`처럼 `[ ]`가 든 경로는 GameActivity의 CMake가 패턴으로 읽어 「No SOURCES given to target: game」으로 실패한다(Unity·CMake 쪽 제한). 스크립트·WebGL 빌드는 대괄호 경로에서 동작한다.
- **대괄호 경로**: PowerShell은 `Test-Path`·`Resolve-Path`에서 `[v2]`를 와일드카드로 읽어, `My Game [v2]` 안의 파일을 「없음」으로 본다. 스크립트는 모두 `-LiteralPath`로 다룬다.
- **증분 빌드의 옛 시각**: Unity 증분 빌드는 안 바뀐 파일(WebGL `index.html` 등)의 시각을 그대로 둔다. `build-unity.ps1`은 폴더 안 가장 새 파일과 크기·개수로 「이번 빌드가 썼는지」를 본다.
- **sdkmanager 입력**: PowerShell 파이프로는 라이선스 `y`가 안 들어간다 → `cmd /c ... < yes.txt`. cmdline-tools 23은 stderr로 사용 중단 경고를 낸다.
- **mobile-mcp 기기 ID**: `emulator-5554`가 아니라 AVD 이름(`unity-test`). Unity 화면은 접근성 트리에 `unitySurfaceView` 하나라 게임 안은 스크린샷+좌표로 다룬다.
- **mobile-mcp와 스크립트를 동시에 쓰지 않는다**: mobile-mcp는 기기 안에 `com.mobilenext.mobilecli.DeviceServer`(유휴 30분 유지)를 띄워 UiAutomation을 잡는다.
  그동안 `uiautomator dump`는 종료 코드 137로 죽는다. 스크립트는 덤프가 실패하면 이 서버를 끄고 다시 시도한다(mobile-mcp는 다음 호출 때 다시 띄운다).
- **실패한 덤프의 옛 파일**: `uiautomator dump`가 실패해도 기기에 이전 XML이 남는다. 그 파일을 읽으면 지난 실행의 알림·대화상자를 보고 판단하게 된다.
  `Get-UiDump`가 덤프 전에 파일을 지우고 「dumped to」 응답을 확인한다.

### 한계

- Unity는 에뮬레이터를 공식 지원하지 않는다. 성능·발열·GPU 드라이버 차이는 실기기에서 따로 본다(여기 수치는 ARM 변환 위 수치).
- iOS는 범위 밖(Windows에서 불가).
- Windows 스모크는 격리 환경이 아니라 사용자 바탕화면에서 돈다. 이 PC의 GPU·드라이버 결과이고, 다른 PC·Windows 버전은 따로 본다. macOS·Linux 플레이어는 아직 없다.
- 자동 실행·예약 작업은 만들지 않았다. 필요할 때 사람이 스크립트를 실행한다.
