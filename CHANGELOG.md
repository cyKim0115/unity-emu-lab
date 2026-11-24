# 변경 기록

npm 패키지 `unity-emu-lab`의 버전별 변경 내용입니다. npm 패키지에 들어가지 않는 PowerShell 스크립트의 변경은 각 버전의 「PowerShell 스크립트(저장소 클론 전용)」 소절에 적습니다.

## 0.2.0 — 날짜 미정 (초안)

### npm 패키지

- macOS·Linux 호스트에서도 빌드부터 테스트까지 하도록, PowerShell 스크립트에만 있던 빌드·프로젝트 보호·점검을 옮겼습니다. 판정·안전 규칙은 PowerShell 스크립트와 같습니다.
- WebGL 스모크(`emu-lab webgl <빌드 폴더>`, `emu_webgl_smoke`): 빌드 폴더를 localhost로 띄워 Chrome·Edge·Chromium을 DevTools로 조종합니다. 에뮬레이터·임대가 필요 없고 Windows·macOS·Linux에서 돕니다. 판정·`summary.json` 키는 PowerShell `smoke-webgl.ps1`과 같고, 터치 탭, 콘솔 오류 실패 옵션, 무시할 오류 정규식, 빈 캔버스 판정, GPU 없는 호스트용 SwiftShader, 브라우저 스위치 추가가 더 있습니다. 서버가 닫히면 돌던 브라우저를 끕니다.
- 빌드(`emu-lab build <프로젝트>`, MCP `emu_build`): Unity batchmode로 Android APK·WebGL 폴더·Windows exe를 만듭니다. 프로젝트의 빌드 메서드나 Unity 6 빌드 프로필을 쓰고, 이번 빌드가 출력에 새로 쓴 경우에만 `BUILD_OK`입니다. 로그가 실패라고 하면 종료 코드 0이어도 실패이고, `EMU_BUILD_WARN`·`EMU_BUILD_NOTE` 줄을 다시 알립니다. 에디터는 Windows·macOS·Linux의 Unity Hub 위치와 `UNITY_EDITOR_ROOT`에서 찾습니다. 프로젝트를 연 에디터(`PROJECT_OPEN`)나 돌고 있는 batchmode 빌드(`BUILD_RUNNING`)가 있으면 멈추고, 이 명령이 죽거나 MCP 서버가 닫히면 숨은 Unity를 끕니다. 작업(job)으로 돕니다.
- 빌드 진입점 템플릿(`emu-lab template`, MCP `emu_build_template`): 빌드 메서드가 없는 프로젝트에 `EmuProjectBuild`를 새 폴더 `Assets/EmuLab/Editor/`로 넣습니다. git 프로젝트에서는 보호 스냅샷 뒤에만 넣습니다. 템플릿 파일이 패키지에 들어갑니다.
- 프로젝트 보호(`emu-lab guard snapshot|report|revert`, MCP `emu_guard_snapshot`·`emu_guard_report`·`emu_guard_revert`): `project-guard.ps1`과 같은 규칙으로 빌드가 바꾼 파일만 보여 주고, 사람이 동의한 것만 되돌립니다(만든 파일은 지우지 않고 백업 폴더로 이동). 상태 파일 형식이 같아 `--state-dir`로 PowerShell 쪽과 이어 쓸 수 있습니다. git 출력은 끝까지 읽고, 승인된 경로는 대소문자까지 같아야 되돌립니다.
- 점검(`emu-lab doctor`, MCP `emu_doctor`): 에뮬레이터 가속(Linux KVM, macOS Hypervisor.framework, Windows WHPX/AEHD), `-gpu` 선택, Unity 에디터·모듈, 사용자 프로젝트(버전, 모듈, 열린 에디터, git과 보호 스냅샷, Android ABI, Windows 백엔드), SDK·AVD(호스트 CPU에 맞는 이미지인지), 디스크, 브라우저를 봅니다. 종료 코드는 `doctor.ps1`과 같습니다(0 준비됨, 2 할 일만 남음, 1 사람이 할 일).
- 에뮬레이터 GPU: `emu-lab start --gpu`, MCP `emu_start`의 `gpu`, 환경 변수 `EMU_GPU`. 기본 `auto`는 Windows·macOS에서 `host`, Linux에서는 디스플레이와 GPU가 있을 때만 `host`이고 아니면 `swiftshader_indirect`를 씁니다(전에는 늘 `host`라 GPU 없는 Linux에서 뜨지 않을 수 있었습니다).
- MCP 레지스트리 메타데이터: `package.json`의 `mcpName`(`io.github.cyKim0115/unity-emu-lab`)과 저장소 루트의 `server.json`(npm·stdio·`serve`). `npm version`이 `server.json`의 버전을 같이 올립니다. 0.1.0에는 `mcpName`이 없어 MCP 레지스트리 등록은 이 버전부터 됩니다.
- MCP 도구가 9개에서 16개로 늘었습니다(`emu_webgl_smoke`, `emu_build`, `emu_build_template`, `emu_guard_snapshot`, `emu_guard_report`, `emu_guard_revert`, `emu_doctor`). 새 오류 코드: `NO_PROJECT`, `NO_UNITY`, `PROJECT_OPEN`, `BUILD_RUNNING`, `BUILD_FAILED`, `BUILD_TIMEOUT`, `BUILD_NO_OUTPUT`, `TEMPLATE_EXISTS`, `NO_GIT`, `NOT_GIT`, `GUARD_REFUSED`.

### PowerShell 스크립트(저장소 클론 전용)

- Windows Standalone 대상: `doctor.ps1`·`build-unity.ps1`·`run-all.ps1`의 `-Target Windows`와 `smoke-windows.ps1`. 무음 테스트 빌드의 exe를 이 PC 바탕화면에 창 모드로 띄워 `Player.log` 준비 마커를 기다리고, 크래시·스스로 종료·오류 대화상자를 구분합니다. 실제 마우스 클릭은 `-Tap`일 때만, PlayerPrefs 레지스트리 키 백업·삭제는 `-CleanPrefs`일 때만 합니다. 템플릿과 샘플의 `BuildWindows`는 그 빌드 동안만 Disable Unity Audio·Run In Background를 켜고 끝나면 되돌립니다.
- 검사: `check-scripts.ps1`(ASCII만 쓰는지, Windows PowerShell 5.1 구문 오류가 없는지). CI가 Windows에서 돌립니다.
- CI: Windows·macOS·Linux에서 시험하고, `smoke-webgl.ps1`을 가짜 빌드 폴더로 돌리며, npm 보호 기능과 `project-guard.ps1`의 상태 폴더 상호 시험을 Windows에서 돌립니다.

## 0.1.0 — 2026-11-24

npm에 올라간 첫 버전입니다. WebGL 스모크와 MCP 레지스트리 메타데이터(`mcpName`)는 들어 있지 않습니다(0.2.0부터).

### npm 패키지

- 첫 버전. MCP 서버(`emu-lab serve`)와 CLI(`emu-lab`)로 Unity Android 빌드를 에뮬레이터에서 자체 테스트합니다. Windows·macOS·Linux, Node.js 22.18 이상.
- 임대: `start`·`renew`·`release`·`status`, 만료 임대 넘겨받기, 남의 임대 거부(`BUSY`), 이 임대가 띄운 에뮬레이터만 끄기, 이 임대가 설치한 앱만 지우기. PowerShell 스크립트(`scripts/`)와 같은 임대 파일을 써서 서로 존중합니다.
- 스모크: APK의 ABI 사전 확인, 설치, 실행, 준비 마커, 크래시·ANR·스스로 종료 구분, 시스템 대화상자 자동 처리, 탭, 로컬 알림 확인과 탭 복귀, 시계 앞당기기와 복구. `summary.json`은 PowerShell 스모크와 같은 키입니다.
- 앱 밖 알림 확인(`notification`), 기기 시계(`clock forward`·`clock reset`), 스크린샷.
- MCP 도구 9개(`emu_status`·`emu_start`·`emu_renew`·`emu_release`·`emu_smoke`·`emu_check_notification`·`emu_clock`·`emu_screenshot`·`emu_job`). 오래 걸리는 도구는 작업(job)으로 돌고 `emu_job`으로 결과를 받습니다.

### PowerShell 스크립트(저장소 클론 전용)

npm 패키지에는 들어가지 않습니다. 저장소 클론에서 Windows PowerShell 5.1로 실행하며, 사용법은 [저장소](https://github.com/cyKim0115/unity-emu-lab) README.md의 「PowerShell 스크립트 (Windows)」에 있습니다.

- 점검·설치: `doctor.ps1`(대상별 점검, 사람이 할 일은 `[HUMAN]` 줄), `setup-android-sdk.ps1`(라이선스 동의 후 SDK와 AVD `unity-test` 설치, 위치 지정).
- 빌드: `build-unity.ps1`·`run-all.ps1`이 Unity를 batchmode로 빌드합니다(Android APK, WebGL 폴더). 프로젝트의 빌드 메서드나 빌드 프로필을 쓰고, 둘 다 없으면 동의 후 `templates/EmuProjectBuild.cs`를 잠시 넣습니다. `-EmuArm64`는 그 빌드만 IL2CPP + ARM64로 만듭니다.
- 프로젝트 보호: `project-guard.ps1`의 Snapshot·Report·Revert로 빌드가 바꾼 파일만 보여 주고 동의 후 되돌립니다.
- Android: `start-emulator.ps1`·`release-emulator.ps1`(npm 패키지와 같은 임대 파일), `smoke-test.ps1`, `check-notification.ps1`, `time-travel.ps1`.
- WebGL: `smoke-webgl.ps1`(로컬 서버 + Chrome·Edge DevTools).
