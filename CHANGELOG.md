# 변경 기록

npm 패키지 `unity-emu-lab`의 버전별 변경 내용입니다.

## 0.1.0 — 배포 전

- 첫 버전. MCP 서버(`emu-lab serve`)와 CLI(`emu-lab`)로 Unity Android 빌드를 에뮬레이터에서 자체 테스트합니다. Windows·macOS·Linux, Node.js 22.18 이상.
- 임대: `start`·`renew`·`release`·`status`, 만료 임대 넘겨받기, 남의 임대 거부(`BUSY`), 이 임대가 띄운 에뮬레이터만 끄기, 이 임대가 설치한 앱만 지우기. PowerShell 스크립트(`scripts/`)와 같은 임대 파일을 써서 서로 존중합니다.
- 스모크: APK의 ABI 사전 확인, 설치, 실행, 준비 마커, 크래시·ANR·스스로 종료 구분, 시스템 대화상자 자동 처리, 탭, 로컬 알림 확인과 탭 복귀, 시계 앞당기기와 복구. `summary.json`은 PowerShell 스모크와 같은 키입니다.
- 앱 밖 알림 확인(`notification`), 기기 시계(`clock forward`·`clock reset`), 스크린샷.
- MCP 도구 9개(`emu_status`·`emu_start`·`emu_renew`·`emu_release`·`emu_smoke`·`emu_check_notification`·`emu_clock`·`emu_screenshot`·`emu_job`). 오래 걸리는 도구는 작업(job)으로 돌고 `emu_job`으로 결과를 받습니다.
