# AGENTS.md — unity-emu-lab

이 저장소를 받은 AI의 일: 사용자 PC에 「Unity 빌드 → 실행 → 자체 테스트」 환경을 갖추고, 사용자의 Unity 프로젝트에 붙여 실제로 돌린 뒤 결과를 보고한다.
대상은 Android(에뮬레이터, 앱 밖 알림창까지)와 WebGL(로컬 서버 + 브라우저)이다. Windows 10/11(x64) + Windows PowerShell 5.1 기준이다.

**받을 위치**: 사용자 Unity 프로젝트 폴더와 그 git 저장소 **밖**에 클론한다(예: `git clone <url> %USERPROFILE%\unity-emu-lab`). 프로젝트나 `Assets\` 안에 받지 않는다.
그 안에 받으면 이 저장소 파일이 사용자 변경으로 잡히고 빌드 출력이 프로젝트에 쌓인다. 모든 명령은 그 클론에서 실행한다. `doctor.ps1 -ProjectPath`가 `[FAIL] lab-location`으로 막는다.

`private/AGENTS.md`가 있으면(개인 덧붙임, 공개 저장소에서는 git이 무시한다) 그것도 읽고 따른다.

## 먼저 지킬 것

1. **Android SDK 라이선스는 사용자가 동의한다.** `setup-android-sdk.ps1 -AcceptLicenses`는 사용자에게 먼저 묻고 「예」를 받은 뒤에만 실행한다.
   물을 내용: Android SDK 라이선스 동의, dl.google.com에서 약 1.5GB를 받아 SDK 폴더에 약 4.5GB, AVD 폴더에 최대 약 10GB(합계 약 15GB) 사용,
   두 위치(`doctor.ps1`의 `[INFO] android-paths` 줄. 기본 `%USERPROFILE%\Android\Sdk`, `%USERPROFILE%\.android\avd`).
   다른 위치를 원하면 `setup-android-sdk.ps1 -AcceptLicenses -SdkRoot <폴더> -AvdHome <폴더>`로 설치한다. 이 저장소 안 `local.settings.json`(커밋 안 됨)에 남아 이후 모든 명령이 그 위치를 쓴다. 전역 환경 변수는 바꾸지 않는다.
   환경 변수 `ANDROID_SDK_ROOT`·`ANDROID_AVD_HOME`이 있으면 그 값이 이긴다(`ANDROID_HOME`은 무시한다. Android Studio SDK를 건드리지 않으려고). 위치를 처음으로 돌리려면 `local.settings.json`을 지운다.
2. **시스템 설정은 바꾸지 않는다.** BIOS 가상화, Windows 기능 「Windows 하이퍼바이저 플랫폼」, 관리자 권한 작업, 재부팅은 `doctor.ps1`의 `[HUMAN]` 줄을 그대로 사용자에게 안내하고 기다린다.
3. **Unity Hub 에디터·모듈 설치는 사용자가 한다.** Android/WebGL Build Support 같은 모듈은 수 GB라 대신 받지 않는다.
4. **소리는 끈 채로 둔다.** 에뮬레이터 `-no-audio`, 브라우저 `--mute-audio` 기본값을 바꾸지 않는다. 사용자가 그 요청에서 직접 원할 때만 예외다.
5. **사용자 프로젝트에서 작업 중인 변경은 건드리지 않는다.** 빌드는 ProjectSettings나 에셋 그룹을 바꿔 놓을 수 있다. 그 변경과 이 저장소 때문에 추가한 파일·코드 줄은 커밋하지 않는다. 사용자 프로젝트 쪽 자동 커밋 규칙이 있어도 이 작업에는 적용하지 않는다.
   빌드 전후 git 처리는 직접 하지 말고 `scripts\project-guard.ps1`로 한다. 한글·공백·대괄호 경로, 큰 저장소 안의 하위 폴더 프로젝트, PS 5.1 인코딩 문제를 이 스크립트가 처리한다.
   - **Snapshot은 첫 빌드 전에 한 번** 찍는다: `scripts\project-guard.ps1 -ProjectPath <p> -Mode Snapshot`. 템플릿 복사·`Debug.Log` 추가도 Snapshot **뒤에** 한다. 그래야 Report에 이 저장소 때문에 생긴 변경으로 잡혀 Revert로 치울 수 있다.
     이미 바뀐 파일 목록을 보여 주면 먼저 커밋·stash할지 그대로 빌드할지 묻는다. `prebuild.patch`는 git이 추적하는 변경만 백업한다. 추적 안 되는 파일(`??`)은 목록만 남고 백업되지 않는다(가드는 그 파일을 옮기거나 되돌리지 않는다). 그 파일이 중요하면 빌드 전에 커밋하거나 복사해 두라고 한다.
   - 그 Snapshot을 마지막 빌드까지 유지한다(마커 추가 뒤 재빌드, `-EmuArm64` 재빌드, 두 번째 대상 모두). 빌드 뒤에 새로 찍으면 빌드가 바꾼 파일이 사용자 작업으로 잡힌다.
     두 번째 Snapshot은 그사이 바뀌거나 사라진 파일이 있으면 목록을 보여 주고 멈춘다. 사용자가 「내 변경」이라고 할 때만 `-Replace`를 붙인다. 커밋·stash 뒤의 재Snapshot은 `-Replace` 없이 된다. Snapshot이 없으면 Report가 멈추니, 빌드 뒤에 새로 찍지 말고 사용자에게 알린다.
   - 마지막 빌드 뒤(실패·시간 초과로 끝난 빌드 포함): `-Mode Report`. 빌드가 바꾼 파일(`changed`), 새로 만든 파일(`created`), 빌드 전부터 바뀌어 있었는데 그사이 내용이 달라진 파일(`touched`, 절대 되돌리지 않음)을 보여 준다. 그사이 커밋이 생겼으면(`HEAD moved`) 그대로 알린다.
     이 목록을 사용자에게 보여 주고, 빌드하는 동안 직접 고친 파일이 있는지와 되돌릴지를 묻는다.
   - 「예」를 받은 뒤에만 `-Mode Revert`. 사용자가 남기라는 파일은 Report에 찍힌 경로 그대로 `-Keep "경로1|경로2"`로 뺀다(찍힌 경로면 어느 종류든 된다).
     Report 목록에 있던 것만 되돌린다. Report 뒤에 새로 바뀐 파일이 있거나, 목록에 있던 파일 내용이 바뀌었거나, 커밋이 생겼으면 아무것도 안 하고 멈춘다(Report부터 다시).
     `changed`는 패치로 백업하고 패치가 그 경로들과 정확히 같고 거꾸로 적용될 때만 되돌린다. `created`는 지우지 않고 백업 폴더로 옮긴다. 결과에 찍힌 `reverted`/`moved`/`kept` 경로 목록과 `backup=` 경로를 그대로 보고에 적는다.
     Revert가 끝나면 그 Snapshot·Report는 보관 처리된다. 다음 빌드는 새 Snapshot부터 한다.
   - Report·Revert는 Unity가 프로젝트를 잡고 있으면(에디터나 batchmode 빌드) 멈춘다. 사용자가 열린 에디터에서 빌드한 경우(`-SkipBuild`)는 Report 전에 에디터를 닫아 달라고 한다.
     batchmode 빌드라면 Snapshot 전에 에디터를 닫게 한다. 열린 채로 찍고 나중에 닫으면 에디터가 종료하며 쓴 설정이 빌드 변경으로 잡힌다.
   - `git checkout -- .`, `git reset --hard`, `git clean`은 쓰지 않는다. 사용자 동의 없이 `git stash`도 쓰지 않는다.
   - 「git not found on PATH ... inside a git repo」(doctor는 `[HUMAN] project-vcs`)면 git 프로젝트다. git 없는 프로젝트로 다루지 말고, Git for Windows 설치나 git 클라이언트의 git을 PATH에 넣게 한 뒤 새 셸에서 다시 한다.
   - git 작업 트리가 아니면(Plastic SCM, Perforce 등) 빌드 전에 멈추고 묻는다. 빌드는 `Assets\`의 파일도 바꿀 수 있다. 사용자 VCS로 체크포인트(Plastic 체크인·shelve, Perforce shelve)를 만들게 하거나,
     동의를 받아 `Library`·`Temp`·`Logs`·`obj`·`Builds`를 뺀 프로젝트 폴더 전체를 백업 폴더에 복사한다. 최소한 `ProjectSettings\`, `Packages\manifest.json`, `Packages\packages-lock.json`은 복사한다.
   - 빌드 전에 알린다: batchmode 빌드는 프로젝트의 활성 플랫폼을 Android/WebGL로 바꾼다. 이 값은 Library에 저장돼 git에는 안 보인다. 다음에 에디터를 열면 그 플랫폼으로 열리고, 원래 플랫폼으로 돌리면 재임포트가 걸릴 수 있다.
6. **에디터가 열려 있는 프로젝트는 batchmode 빌드가 막힌다.** `doctor.ps1`의 `project-open`과 `build-unity.ps1`이 잡고 있는 프로세스를 알려 준다.
   「open in a Unity Editor (pid N)」면 에디터를 닫아 달라고 하거나, 사용자가 에디터에서 빌드한 결과를 `-SkipBuild`로 받는다.
   「batchmode Unity (pid N) ... still building」이면 이전 실행이 남긴 빌드다. 끝날 때까지 기다리거나, 사용자 동의 후 `Stop-Process -Id N`으로 끄고 규칙 5의 Report를 돌린다.
7. **mobile-mcp와 스크립트를 동시에 쓰지 않는다.** 둘 다 UiAutomation을 쓰므로 동시에 쓰면 알림창 확인이 실패한다.
8. **AI 앱 안 셸이면 AppData가 가상화될 수 있다.** Claude 데스크톱처럼 패키지(MSIX) 앱 안에서 `%LOCALAPPDATA%`에 쓴 파일은 일반 터미널에서 보이지 않는다.
   설치는 AppData 밖(기본값)에 두고, 마지막 검증은 사용자의 일반 터미널에서 한 번 돌린다. `doctor.ps1`이 `packaged-host`로 알려 준다.
9. **결과를 부풀리지 않는다.** `summary.json`의 `pass`와 실패 항목, 스크린샷, 의심 가는 콘솔/로그 줄을 그대로 보여 준다. 에뮬레이터 PASS는 실기기 인증이 아니다.
10. `.ps1`은 ASCII만 쓴다. Windows PowerShell 5.1이 BOM 없는 파일을 CP949로 읽어 한글이 깨진다.
11. **샌드박스 안에서 돌리지 않는다.** Codex 기본 `workspace-write` 같은 샌드박스는 네트워크를 막고 쓰기를 작업 폴더 안으로 제한한다. Windows의 Codex 기본 샌드박스는 명령을 별도 Windows 사용자(`CodexSandboxOffline`/`Online` 등)로 돌린다. 다른 에이전트의 샌드박스 모드도 비슷하다.
    그러면 git이 사용자 프로젝트를 「dubious ownership」으로 거부하고, 사용자 폴더 아래에 깐 SDK가 없는 것처럼 보인다. `doctor.ps1`부터 모든 `scripts\*.ps1`과 사용자 프로젝트에 대한 git 명령은 처음부터 샌드박스 밖 실행(권한 상승)을 요청해 사용자 승인을 받는다.
    샌드박스 안에서 난 다운로드 실패·접근 거부·라이선스 오류·「not a git work tree」를 설치나 프로젝트 문제로 진단하지 않는다.
12. **사용자 홈의 전역 설정은 대신 바꾸지 않는다.** `~/.codex/config.toml`, `~/.claude*`, 영구 환경 변수처럼 이 저장소 밖에서 다른 작업에도 영향을 주는 설정은 바꿀 내용과 영향을 보여 주고 「예」를 받은 뒤에만 바꾸거나, 사용자가 직접 하게 한다.
13. **다른 에뮬레이터는 건드리지 않는다.** 스크립트는 AVD `unity-test`만 대상으로 하고, 다른 에뮬레이터(Android Studio의 개인 AVD 등)만 떠 있으면 멈춘다. 그때는 그 에뮬레이터를 닫아 달라고 하고 기다린다. 대신 끄지 않는다.
14. **오래 걸리는 단계는 도구 시간 제한을 넘긴다.** 대략: SDK 설치 5~20분, 샘플 첫 실행(Library 임포트 + 첫 빌드 + 첫 부팅) 3~6분, 사용자 프로젝트 빌드는 최대 `-TimeoutMinutes`(기본 40분).
    에이전트 셸 기본 제한(예: 2분)으로 돌리지 말고, 긴 시간 제한이나 백그라운드 실행으로 돌린 뒤 마지막 줄(`SETUP_DONE`, `BUILD_OK`, `SMOKE PASS/FAIL`, `WEBGL_SMOKE PASS/FAIL`)이나 `summary.json`을 읽는다.
    실행 중일 수 있는 동안 두 번째 실행을 시작하지 않는다. 실행이 잘렸으면 다시 하기 전에 `doctor.ps1 -ProjectPath <p>`의 `project-open`으로 남은 batchmode Unity가 있는지 본다(규칙 6). 잘린 빌드도 규칙 5의 Report를 돌린다.
15. **에뮬레이터는 잡고 쓰고 놓는다.** 한 PC의 AVD `unity-test`는 한 세션만 쓴다. `start-emulator.ps1`(`run-all.ps1`이 부름)이 임대(`%USERPROFILE%\.emu-lab\leases\unity-test.json`)를 잡고, 다 쓰면 `release-emulator.ps1`로 놓는다.
    - 임대 주인은 `EMU_OWNER`, 없으면 Claude Code 세션(`claude:<세션 앞 8자>`)·Codex 스레드(`codex:<끝 8자>`), 없으면 `사용자@PC`다. 기본 4시간이고 `start-emulator.ps1`을 다시 돌리면 늘어난다(`-Hours`).
    - `BUSY: AVD 'unity-test' is leased by ...`면 다른 세션이 쓰는 중이다. 설치·탭·`adb shell` 설정 변경을 하지 않고 기다리거나 사용자에게 알린다. 남의 임대는 사용자만 푼다(`release-emulator.ps1 -AnyOwner`, 시간이 지난 임대는 `-Stale`).
    - 스크립트 밖에서 `adb`로 직접 탭·설치할 때도 임대를 잡은 뒤에 한다(스크립트만 임대를 확인한다).
    - 끝나면 반드시 `release-emulator.ps1`. Firebase 디버그 모드(`debug.firebase.analytics.app`)와 `log.tag.FA`·`FA-SVC`를 끄고, 앞당긴 시계를 되돌리고, 이 임대가 띄운 에뮬레이터만 끈다(이미 떠 있던 것은 둔다). 다음 실행을 첫 실행으로 보려면 `-Uninstall`(이 임대에서 설치한 앱과 데이터를 지움). 사용자가 세이브를 이어 쓰자고 하면 빼고, 남긴 앱을 보고에 적는다.

## 순서

모든 명령은 이 저장소 루트에서, WSL bash가 아니라 Windows의 PowerShell이나 cmd에서 실행한다(bash에서는 `powershell`을 못 찾거나 `\`가 사라진다).
기본 형식: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\<이름>.ps1 ...`
`-File`로 부를 때 경로 인자를 `\`로 끝내지 않는다(`"C:\Game\"`처럼 쓰면 `\"`가 따옴표로 읽혀 뒤 인자가 사라진다). `"C:\Game"`처럼 쓴다.

1. **점검**: `scripts\doctor.ps1 -ProjectPath <사용자 프로젝트> -Target <사용자가 쓸 대상>`
   - `-Target`은 사용자가 원한 대상만 준다(`Android`, `WebGL`, 둘 다면 `Both`). 기본값 `Both`는 WebGL 모듈까지 요구한다.
   - 종료 코드: `0` READY, `2` TODO만 남음, `1` HUMAN/FAIL 있음.
   - `[HUMAN]`은 사용자에게 할 일을 전하고 기다린다. 사용자가 처리했다고 하면 같은 `-Target`/`-NoSample`로 doctor를 다시 돌려 종료 코드가 0이나 2가 된 뒤에 다음으로 간다.
   - `[TODO]`는 동의를 받고 진행한다. `[WARN] project-vcs`는 규칙 5대로 처리한다. 「dubious ownership」이면 규칙 11이다.
   - `[FAIL] lab-location`: 이 저장소가 프로젝트(또는 그 git 저장소) 안에 있다. 맨 위 「받을 위치」대로 다시 클론한다. 지우기 전에 묻는다.
   - `[FAIL] android-host`: Windows on ARM이다. Android 에뮬레이터는 안 되고 WebGL만 된다.
   - `[WARN] external-tools`: Unity Preferences > External Tools의 JDK/SDK/NDK를 쓴다. 막힌 게 아니니 Hub 하위 모듈을 따로 깔게 하지 않는다.
   - `sample-unity`: 샘플은 정확히 Unity 6000.6.0f1(새 패치도 안 됨)과 쓸 대상의 모듈이 필요하다. 없으면 두 가지 중에서 사용자가 고르게 한다. Hub 아카이브에서 설치(수 GB)하거나, 샘플 확인을 건너뛴다. 건너뛰면 `-NoSample`로 다시 점검하고 3단계를 빼고, 보고에 「샘플 확인 생략」을 적는다.
   - `android-sdk-jdk`가 `[HUMAN]`이면 그 줄을 그대로 전한다. SDK 설치 도구(avdmanager)가 JDK 17 이상을 쓴다(Unity 6의 OpenJDK, External Tools JDK, 또는 `JAVA_HOME`). 줄이 이미 설치된 에디터를 지목하면 그 에디터에 빠진 하위 모듈만 추가하게 하고(Unity Hub > Installs > 그 버전 > Add modules), 새 Unity 6 설치는 줄이 그렇게 말할 때만 안내한다.
2. **Android SDK**(Android를 쓸 때, 동의 후, 5~20분): `scripts\setup-android-sdk.ps1 -AcceptLicenses`.
   - 끝 줄 `SETUP_DONE accel=ok`(종료 0)면 다음으로 간다. `[HUMAN] emulator-accel ...` + `SETUP_DONE accel=missing`(종료 2)면 그 줄을 그대로 전하고 기다린 뒤 doctor를 다시 돌린다. 3단계로 가지 않는다.
   - 프록시 환경이면 `HTTPS_PROXY`/`HTTP_PROXY`(`http://host:port`)를 자동으로 쓴다. 일반 터미널에서도 다운로드가 실패하면 사용자에게 프록시 주소를 물어 `-Proxy host:port`로 다시 돌린다(인증 프록시는 지원하지 않는다).
3. **샘플로 환경 확인**(3~6분): `scripts\run-all.ps1 -Target Android` 또는 `-Target WebGL`. 사용자가 쓰는 대상이 `PASS`여야 다음으로 간다. 둘 다 쓸 때는 두 번 돌린다(`run-all.ps1`은 `Both`를 받지 않는다).
4. **사용자 프로젝트에 붙이기**: 아래 「프로젝트에 붙이기」. 규칙 5의 Snapshot부터 한다.
5. **놓기**(Android): `scripts\release-emulator.ps1 [-Uninstall]`(규칙 15). 끝 줄 `RELEASED`를 확인한다.
6. **보고**: 결과 폴더 `artifacts\<시각>-<smoke|webgl>-<PID>\`의 `summary.json`, PNG, `logcat.txt`/`console.txt`. PASS/FAIL과 근거를 짧게 전한다. 사용자 프로젝트에서 바꾸거나 추가한 경로, guard Report·Revert 결과, `EMU_BUILD_WARN` 줄이 있으면 함께 적는다. 놓기에서 남긴 앱(`KEPT apps`)도 적는다.

## 프로젝트에 붙이기

### 빌드

- 프로젝트에 batchmode 빌드 메서드가 있으면 그걸 쓴다. 먼저 그 프로젝트의 빌드 문서·스크립트(`Assets/Editor/*Build*.cs`, `docs/`)를 읽고 그 절차를 따른다.
  `scripts\run-all.ps1 -ProjectPath <p> -Target Android|WebGL -Method <Class.Method> ...`(빌드부터 테스트까지) 또는 `scripts\build-unity.ps1 -ProjectPath <p> -Target Android|WebGL -Method <Class.Method> -Out <출력>`(빌드만).
  - 메서드는 받은 `-buildOut`(Android는 `-apkOut`도) 경로에 써야 한다. 다른 곳에 쓰는 메서드면 `-Out`을 실제로 쓰는 경로로 주거나, 메서드의 출력 인자를 `-ExtraArgs`로 같은 절대 경로로 넘긴다. 실패하면 `EditorApplication.Exit(1)`로 끝나야 한다.
  - Android `-Out`은 설치할 수 있는 `.apk` 파일 하나다(`.aab`, Export Project 폴더, ABI별 분할 APK는 안 된다). `build-unity.ps1`은 이번 빌드가 `-Out`에 새로 쓴 게 없거나 로그의 마지막 결과가 실패면 `BUILD_OK`를 찍지 않고 이유를 알린다.
  - 출력 기본값은 프로젝트 밖인 이 저장소의 `artifacts\builds\<폴더명>-<해시8>\Android\app.apk`·`...\WebGL`이다(샘플만 자기 `Builds\`). `run-all.ps1 -SkipBuild -ProjectPath <p>`는 그 기본 위치를 찾는다.
- 메서드가 받는 다른 인자는 `-ExtraArgs`로 넘긴다. `-File`로는 배열과 `-`로 시작하는 값을 못 넘기므로 이때만 `-Command`로 부른다. 경로·값은 작은따옴표로 감싸고(값 안의 `'`는 `''`), 명령 안에 큰따옴표와 `$`는 쓰지 않는다.
  `-ExtraArgs` 안의 경로는 절대 경로로 쓴다. 스크립트는 `-Out`만 절대 경로로 바꾸고, Unity는 상대 경로를 사용자 프로젝트 기준으로 해석한다.
  `powershell -NoProfile -ExecutionPolicy Bypass -Command "& .\scripts\build-unity.ps1 -ProjectPath '<p>' -Target WebGL -Method <Class.Method> -Out '<출력>' -ExtraArgs @('-name','value')"`
- 메서드가 없으면 Unity 6 빌드 프로필을 쓴다: `-BuildProfile "Assets/Settings/Build Profiles/<이름>.asset"`(`-Method` 대신, `run-all.ps1`도 받는다).
- 둘 다 없으면 사용자 동의를 받고 템플릿을 넣는다(Unity 2021.2 이상). Snapshot **뒤에** `templates\EmuProjectBuild.cs`와 `templates\EmuLab.Editor.asmdef` **두 파일을 새 폴더** `Assets\EmuLab\Editor\`에 복사한다.
  기존 스크립트가 있는 폴더(`Assets\Editor\` 등)에 넣지 않는다. asmdef는 그 폴더와 하위 폴더의 스크립트를 모두 가져가므로 프로젝트의 에디터 스크립트가 컴파일되지 않는다.
  `-Method EmuProjectBuild.BuildApk` 또는 `EmuProjectBuild.BuildWebGL`. Build Settings에 켜 둔 씬을 현재 설정 그대로 빌드한다. 켜진 씬이 없으면 실패하니 어떤 씬을 빌드할지 사용자에게 묻는다.
  그 빌드 동안만 Build App Bundle·Export Project·Split APKs by target architecture를 끄고, 끝나면(실패해도) 원래 값으로 되돌린다. 커스텀 키스토어 암호가 batchmode에 없으면 디버그 키스토어로 서명한다.
  끝나면 `Assets\EmuLab`(와 `.meta`)는 guard Report에 `created`로 나오고 Revert가 백업 폴더로 옮긴다. 커밋하지 않는다.
  `sample/EmuSmoke/Assets/Editor/EmuBuild.cs`와 `EmuSmoke.cs`는 샘플 전용이다. 회사명·앱 ID·씬 목록을 덮어쓰고 빈 씬을 만들므로 사용자 프로젝트에 복사하지 않는다. `run-all.ps1`도 샘플이 아니면 `-Method`나 `-BuildProfile` 없이는 빌드하지 않는다.
- 빌드 로그의 `EMU_BUILD_WARN`·`EMU_BUILD_NOTE` 줄은 `build-unity.ps1`이 다시 찍는다. 그대로 보고한다.
  - 「signed with the debug keystore」: 디버그 서명 테스트 빌드라고 적는다. 키스토어 암호를 묻거나 명령줄에 넣지 않는다.
  - 「Addressables: ... build the Addressables content ... first」: 동의를 받아 그 대상의 콘텐츠를 먼저 빌드한다(Addressables Groups > Build > New Build). `Assets/AddressableAssetsData` 아래 추적 파일이 바뀌니 Report에 나온다.
- 에뮬레이터(API 35 x86_64)는 `x86_64`·`arm64-v8a` 코드만 돌린다. Mono 백엔드(ARMv7만)나 ARMv7만 체크한 빌드는 설치할 수 없다. 스모크가 설치 전에 `apk_abis`로 먼저 알리고, `doctor.ps1`은 `project-abi`로 미리 알린다.
  AVD를 다시 만들거나 ProjectSettings를 직접 고치지 않는다. 사용자 동의 후 그 빌드에서만 IL2CPP + ARM64로 빌드한다. 템플릿이면 `-EmuArm64` 스위치(`run-all.ps1`·`build-unity.ps1`, `-File`로 된다, `-Method`가 필요하다)가 그 빌드 동안만 바꾸고 되돌린다.
  자체 빌드 메서드면 그 안에서 같은 방식으로 한다. 큰 프로젝트의 첫 IL2CPP 빌드는 `-TimeoutMinutes 90` 정도로 늘린다. 보고에 「배포 빌드와 다른 바이너리로 테스트했다」고 적는다.
- `run-all.ps1`은 다른 대상의 옵션(예: `-Target WebGL`에 `-NotifDelay`·`-Apk`, Android에 `-ReadyMode`·`-BuildDir`)과 `-SkipBuild`에 빌드 옵션을 섞으면 시작 전에 멈춘다.

### Android 판정

- 준비: `-ReadyMarker "<logcat에 찍히는 한 줄>"`. 모르면 한 번 돌려 `unity.txt`에서 첫 화면 무렵의 줄을 고른다. 마땅한 줄이 없으면 사용자 동의 후(Snapshot 뒤) 첫 화면에 `Debug.Log` 한 줄을 넣는다. 이 줄은 커밋하지 않고 Report·Revert로 정리하며 보고에 경로를 적는다.
- 탭: `-TapX/-TapY`(화면 비율). 탭 확인은 `-TapMarker "<탭하면 찍히는 줄>"`을 기다린다(기본값 `SMOKE_TAP count=1`은 샘플만 찍는다). 그런 줄이 없으면 `-NoTapCheck`, 탭을 빼려면 `-NoTap`.
- 로컬 알림 자동 확인: 앱이 예약할 때 찍는 줄을 `-NotifScheduledRegex "<정규식>"`으로 준다. **1번 그룹이 알림 제목**이어야 한다(예: `-NotifScheduledRegex "Scheduled notification: (.+)"`). 기본값은 샘플의 `SMOKE_NOTIF_SCHEDULED id=<n> title=<제목>`이다.
  알림을 탭해 앱이 열렸는지는 `-OpenedMarker "<열릴 때 찍히는 줄>"`로 본다. 그런 줄이 없으면 `-NoOpenedMarker`(앞에 뜬 화면으로 판단).
  예약 줄이 없는 앱은 `-NotifDelay 0`으로 빼고, 게임에서 알림을 예약한 뒤 `scripts\check-notification.ps1 -Package <id> -Title "<제목 일부>" -Tap [-OpenedMarker "<줄>"]`로 따로 본다(logcat은 스크립트가 직접 받는다).
- 몇 시간 뒤 알림: 자동 확인(`-NotifDelay` > 0 + 예약 줄)일 때만 `-TimeTravelMinutes`로 기기 시계를 앞당긴다. 비정확 알람은 최대 1시간 늦으므로 예약 시간 + 60분 이상으로 잡는다. 스모크가 끝나면(죽어도) 시계를 되돌린다.
  수동이면: 게임에서 예약 → `scripts\time-travel.ps1 -Minutes <지연+60 이상>` → `check-notification.ps1` → 성공·실패와 상관없이 `scripts\time-travel.ps1 -Reset`(두 번 해도 된다).
- 예: `scripts\run-all.ps1 -SkipBuild -Apk <apk> -ReadyMarker "<로그>" -NoTapCheck -NotifDelay 0`
- `summary.json`의 `app_exited=true`: 앱 프로세스가 크래시·ANR 없이 스스로 끝났다. 안티치트·무결성·에뮬레이터/루팅 감지, 디버그 서명 감지, 시작 때 로그인·패치·네트워크 확인 실패가 흔한 원인이다. 그 확인을 끈 테스트 빌드를 사용자에게 요청하고 그대로 보고한다. 감지를 우회하거나 패치하지 않는다.

### WebGL 판정

- 준비: 로그가 있으면 `-ReadyMarker`, Unity 기본 템플릿이면 `-ReadyMode Loaded`.
  페이지가 상태를 노출하면 `-ReadyMode Expression -ReadyExpression "<JS>"`. 식 안의 문자열은 작은따옴표로 쓴다.
- 탭: 탭 확인은 콘솔 줄 `-TapMarker`(기본 `SMOKE_TAP count=1`)를 기다린다. 다른 판정이면 `-TapExpression`, 확인을 빼려면 `-NoTapCheck`.
  타이틀이 인트로 동안 입력을 무시할 수 있다. `-TapExpression "<탭이 먹혔을 때 참>" -TapRetrySec 5 -TapTimeoutSec 60`으로 먹을 때까지 다시 탭한다.
  그 뒤 상태는 `-AfterTapExpression`·`-AfterTapTimeoutSec`로 기다린다. 화면 전환이 있으면 `-SettleSec 10`.
- 페이지 자체 오류 UI: `-FailExpression "<오류일 때 문자열을 돌려주는 JS>"`.
- 배포처가 COOP/COEP를 보내지 않는 단일 스레드 빌드(GitHub Pages 등)는 `-NoIsolation`으로 같은 조건을 만든다.
- 예: `scripts\run-all.ps1 -Target WebGL -SkipBuild -BuildDir <폴더> -ReadyMode Loaded -NoTapCheck`. 상태를 노출하는 템플릿 예는 README의 「예: 상태를 노출하는 커스텀 템플릿」에 있다.

## npm 패키지 `unity-emu-lab` (MCP 서버 + CLI)

APK가 이미 있고 Android만 볼 때는 PowerShell 대신 npm 패키지를 써도 된다(Windows·macOS·Linux). 쓰는 법은 README의 「npm 패키지」.

- MCP: `emu_start`로 임대를 잡고 → `emu_smoke`·`emu_check_notification`·`emu_clock` → 끝나면 반드시 `emu_release`(첫 실행으로 보려면 `uninstall: true`). 결과에 `job_id`가 오면 `emu_job`으로 이어 받고, 같은 도구를 다시 시작하지 않는다.
- `BUSY`면 다른 세션이 쓰는 중이다. 기다리거나 사용자에게 주인·만료 시각을 전한다. 남의 임대를 풀지 않는다(`--any-owner`·`--stale`은 사람만 CLI로).
- 임대 파일은 PowerShell 스크립트와 같다. 한 세션 안에서는 한쪽(npm 또는 PowerShell)만 쓴다. 주인이 같으면 서로의 임대를 자기 것으로 본다.
- 이 저장소 클론에서 Node 코드를 고쳤으면 `npm test`(가짜 adb, 기기를 건드리지 않음)와 `npm run typecheck`를 돌린다. 기기 시험은 임대를 잡은 뒤에만 한다.

## mobile-mcp (선택: AI가 에뮬레이터 화면을 보고 탭)

- Node.js 20 이상이 필요하다(`doctor.ps1`의 `node` 줄). AI 세션·작업 공간을 **이 저장소 폴더**에서 열어야 프로젝트 MCP 설정을 읽는다.
- 기기 ID는 `emulator-5554`가 아니라 AVD 이름 `unity-test`다. Unity 화면 안은 요소 목록이 없어 스크린샷과 좌표로 다룬다.
- Claude Code: 저장소의 `.mcp.json`. 사용자가 `claude`를 실행할 때 프로젝트 MCP를 승인해야 붙는다(대신 승인하지 않는다).
- Cursor: `.cursor/mcp.json`.
- Codex: 이 저장소에는 Codex용 프로젝트 설정이 없어 사용자 전역 `~/.codex/config.toml`에 넣어야 한다. 넣으면 이 저장소와 무관한 모든 Codex 세션이 시작할 때 mobile-mcp를 띄운다. 그래서 규칙 12대로 사용자가 원할 때만, 아래 조각과 이 영향을 보여 주고 「예」를 받은 뒤 넣는다.
  넣기 전에 `[mcp_servers.mobile-mcp]`가 이미 있는지 확인한다(같은 표가 두 번 있으면 파일을 못 읽는다). 블록은 파일 끝, 최상위 키들 뒤에 붙인다. `<USERPROFILE>`은 `%USERPROFILE%`의 실제 절대 경로로 바꿔 보여 준다(TOML 문자열이라 `\`는 `\\`로 쓴다).
  Codex는 MCP를 세션 시작 때 읽으므로 추가한 뒤 새 세션을 열어야 붙는다. 첫 실행 때 npx가 패키지를 받느라 기본 대기 10초를 넘길 수 있어 `startup_timeout_sec = 120`으로 둔다. 다 쓰면 이 블록을 지우면 된다고 함께 알린다.

  ```toml
  [mcp_servers.mobile-mcp]
  command = "cmd"
  args = ["/c", "npx", "-y", "@mobilenext/mobile-mcp@1.0.12"]
  env = { ANDROID_HOME = "<USERPROFILE>\\Android\\Sdk" }
  startup_timeout_sec = 120
  ```

- SDK가 기본 위치가 아니면(`doctor.ps1`에 `mobile-mcp-sdk` WARN) 세 설정의 `ANDROID_HOME`을 그 경로로 바꾼다. 이 PC 전용 변경이라 커밋하지 않는다. mobile-mcp는 `ANDROID_HOME\platform-tools\adb`가 없으면 기기를 하나도 못 찾는다.

## 막혔을 때

README의 「이번에 확인한 함정」을 먼저 본다. 그 밖에 자주 생기는 것은 다음과 같다.

- `adb.exe ... 인식되지 않습니다`, 또는 `start-emulator.ps1`의 「No adb / No emulator / AVD unity-test not found ... (from <출처>)」: `doctor.ps1`의 `android-paths` 줄을 본다. AppData 가상화(규칙 8)나, 이 셸이 못 보는 위치(상속 안 된 환경 변수, 다른 클론의 `local.settings.json`)가 흔한 원인이다.
- 준비 마커가 안 찍히고 CPU 0%: 시스템 대화상자가 포커스를 가져갔다. 스크립트가 자동으로 누르고 `system-dialogs.txt`에 남긴다.
- 알림이 늦게 오거나 안 옴: 비정확 알람 창 때문이다. `dumpsys alarm`의 `window=`를 본다.
- `CLOCK_RESET_FAILED`(또는 `summary.json`의 `clock_reset_error`): 기기 시계가 앞당겨진 채다. `scripts\time-travel.ps1 -Reset`을 직접 돌린다. 다음 `start-emulator.ps1`도 `TIME_RESET`으로 되돌린다.
- 출력을 받는 호출이 끝나지 않음: 자식 프로세스가 출력 파이프를 물고 있다. 이 저장소 스크립트는 막아 두었다. 직접 띄우는 프로세스도 `Start-Detached`(common.ps1)를 쓴다.
- 다운로드 실패·`Access is denied`·Unity 라이선스 오류, 또는 doctor의 「dubious ownership」·「android-sdk missing」이 에이전트 셸에서만 난다: 샌드박스 안에서 돌았다(규칙 11). 권한 상승으로 다시 돌린다.
  사용자의 일반 터미널에서도 다운로드가 실패하면 네트워크 문제(프록시·TLS 검사)다. 2단계의 `-Proxy`를 쓴다. TLS 검사 환경이면 사용자가 `SDKMANAGER_OPTS=-Djavax.net.ssl.trustStoreType=Windows-ROOT`를 시도해 볼 수 있다(검증 안 됨).
- `Other emulator(s) running`: 다른 AVD가 떠 있다(규칙 13). 사용자에게 닫아 달라고 한다.
- `BUSY` / `NOT_OWNER` / `NOT_STALE`: 남의 임대다(규칙 15). 풀지 말고 사용자에게 주인·만료 시각을 그대로 전한다. `LEASE_NONE`은 임대 없이 스크립트를 돌린 경고다. `start-emulator.ps1`부터 다시 한다.
- logcat이 중간에 끊기거나 `daemon not running; starting now`가 자주 보임: adb 버전이 둘이다(SDK의 adb와 Unity 내장 adb). 두 버전이 섞이면 서버가 꺼졌다 다시 뜬다. Unity로 Android 빌드도 하는 PC면 `local.settings.json`에 `"adb": "<Unity 에디터>\\Editor\\Data\\PlaybackEngines\\AndroidPlayer\\SDK\\platform-tools\\adb.exe"`(또는 환경 변수 `EMU_ADB`)로 하나를 고른다. `doctor.ps1`의 `adb` 줄이 지금 쓰는 adb를 보여 준다. Unity의 Android 빌드는 끝날 때 adb 서버를 끄므로, 스모크 중에는 같은 PC에서 Android 빌드를 돌리지 않는다.
