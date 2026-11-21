# 변경 기록

npm 패키지 `unity-emu-lab`의 버전별 변경 내용입니다. npm 패키지에 들어가지 않는 PowerShell 스크립트의 변경은 각 버전의 「PowerShell 스크립트(저장소 클론 전용)」 소절에 적습니다.

## 0.1.0 — 2026-11-21

### npm 패키지

- 첫 버전. MCP 서버(`emu-lab serve`)와 CLI(`emu-lab`)로 Unity Android 빌드를 에뮬레이터에서 자체 테스트합니다. Windows·macOS·Linux, Node.js 22.18 이상.
- 임대: `start`·`renew`·`release`·`status`, 만료 임대 넘겨받기, 남의 임대 거부(`BUSY`), 이 임대가 띄운 에뮬레이터만 끄기, 이 임대가 설치한 앱만 지우기. PowerShell 스크립트(`scripts/`)와 같은 임대 파일을 써서 서로 존중합니다.
- 스모크: APK의 ABI 사전 확인, 설치, 실행, 준비 마커, 크래시·ANR·스스로 종료 구분, 시스템 대화상자 자동 처리, 탭, 로컬 알림 확인과 탭 복귀, 시계 앞당기기와 복구. `summary.json`은 PowerShell 스모크와 같은 키입니다.
- 앱 밖 알림 확인(`notification`), 기기 시계(`clock forward`·`clock reset`), 스크린샷.
- MCP 도구 10개(`emu_status`·`emu_start`·`emu_renew`·`emu_release`·`emu_smoke`·`emu_check_notification`·`emu_clock`·`emu_screenshot`·`emu_job`·`emu_webgl_smoke`). 오래 걸리는 도구는 작업(job)으로 돌고 `emu_job`으로 결과를 받습니다.
- WebGL 스모크(`emu-lab webgl <빌드 폴더>`, `emu_webgl_smoke`): 빌드 폴더를 localhost로 띄워 Chrome·Edge·Chromium을 DevTools로 조종합니다. 에뮬레이터·임대가 필요 없고 Windows·macOS·Linux에서 돕니다. 판정·`summary.json` 키는 PowerShell `smoke-webgl.ps1`과 같고, 터치 탭, 콘솔 오류 실패 옵션, 무시할 오류 정규식, 빈 캔버스 판정, GPU 없는 호스트용 SwiftShader, 브라우저 스위치 추가가 더 있습니다. 서버가 닫히면 돌던 브라우저를 끕니다.
- MCP 레지스트리 메타데이터: `package.json`의 `mcpName`(`io.github.cyKim0115/unity-emu-lab`)과 저장소 루트의 `server.json`(npm·stdio·`serve`). `npm version`이 `server.json`의 버전을 같이 올립니다.

### PowerShell 스크립트(저장소 클론 전용)

npm 패키지에는 들어가지 않습니다. 저장소 클론에서 Windows PowerShell 5.1로 실행하며, 사용법은 [저장소](https://github.com/cyKim0115/unity-emu-lab) README.md의 「PowerShell 스크립트 (Windows)」에 있습니다.

- 점검·설치: `doctor.ps1`(대상별 점검, 사람이 할 일은 `[HUMAN]` 줄), `setup-android-sdk.ps1`(라이선스 동의 후 SDK와 AVD `unity-test` 설치, 위치 지정).
- 빌드: `build-unity.ps1`·`run-all.ps1`이 Unity를 batchmode로 빌드합니다(Android APK, WebGL 폴더, Windows exe). 프로젝트의 빌드 메서드나 빌드 프로필을 쓰고, 둘 다 없으면 동의 후 `templates/EmuProjectBuild.cs`를 잠시 넣습니다. `-EmuArm64`는 그 빌드만 IL2CPP + ARM64로 만듭니다.
- 프로젝트 보호: `project-guard.ps1`의 Snapshot·Report·Revert로 빌드가 바꾼 파일만 보여 주고 동의 후 되돌립니다.
- Android: `start-emulator.ps1`·`release-emulator.ps1`(npm 패키지와 같은 임대 파일), `smoke-test.ps1`, `check-notification.ps1`, `time-travel.ps1`.
- WebGL: `smoke-webgl.ps1`(로컬 서버 + Chrome·Edge DevTools). CI가 가짜 빌드 폴더로 이 스크립트를 돌립니다.
- Windows Standalone 대상: `doctor.ps1`·`build-unity.ps1`·`run-all.ps1`의 `-Target Windows`와 `smoke-windows.ps1`. 무음 테스트 빌드의 exe를 이 PC 바탕화면에 창 모드로 띄워 `Player.log` 준비 마커를 기다리고, 크래시·스스로 종료·오류 대화상자를 구분합니다. 실제 마우스 클릭은 `-Tap`일 때만, PlayerPrefs 레지스트리 키 백업·삭제는 `-CleanPrefs`일 때만 합니다. 템플릿과 샘플의 `BuildWindows`는 그 빌드 동안만 Disable Unity Audio·Run In Background를 켜고 끝나면 되돌립니다.
- 검사: `check-scripts.ps1`(ASCII만 쓰는지, Windows PowerShell 5.1 구문 오류가 없는지). CI가 Windows에서 돌립니다.
