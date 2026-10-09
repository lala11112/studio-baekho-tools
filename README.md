# 스튜디오 백호툴

3D 제작과 타격감 실험을 하나의 Windows 앱에서 사용하는 게임 개발 작업실입니다.

## 시작하기

Node.js 24와 Windows 환경에서 실행합니다.

```powershell
npm ci
npm run build
npm start
```

개발 중에는 `npm run dev`, Windows 폴더 빌드는 `npm run package`를 사용합니다. 빌드 결과는 `release/win-unpacked/Baekho Tools.exe`이며 실행 파일을 포함한 폴더 전체가 필요합니다.

## 하나의 작업실, 두 개의 도구

| 메뉴 | 할 수 있는 일 |
| --- | --- |
| 홈 | 3D 제작·타격감 도구 열기, 최근 프로젝트 이어서 작업 |
| 도구 | 두 도구의 역할을 확인하고 작업실로 이동 |
| 실행 | 각 도구에 저장된 실행 기록과 실제 상태 확인 |
| 결과 | 저장된 이미지·모델·실험 보고서 확인, 원래 작업으로 이동 |
| 설정 | 도구별 연결 설정, Unity 프로젝트 선택, 저장 위치 확인 |

3D 제작은 Partsmith의 프로젝트·단계별 제작·고급 수동 도구를 사용합니다. 타격감은 Combat Lab의 후보 생성·자동 실행·녹화·비교·새 SO 저장을 사용합니다. 두 도구는 같은 창 안에 열리고, 공통 메뉴로 이동해도 입력과 진행 중인 작업을 유지합니다. 화면을 바꿀 때 타격감 영상 재생만 멈춥니다.

모델링 프로젝트와 타격감 실험의 Unity 프로젝트는 각 도구 안에서 선택합니다. 프로젝트 형식과 결과 파일을 강제로 합치지 않습니다. 실행 완료, 결과 검토, 채택 상태를 따로 표시합니다. 과거 기록은 해당 도구의 프로젝트 또는 실험으로 다시 열립니다.

## 저장소와 기존 데이터

- 기존 Partsmith 사용자 데이터와 Tripo 로그인 세션을 계속 사용합니다. 기본 위치는 `%APPDATA%/partsmith`입니다. 기존 Partsmith와 통합 앱을 동시에 실행하지 마세요.
- 타격감 프로젝트 선택은 별도 `combat-lab/settings.json`에 저장합니다. 처음 연결할 때 기존 `%APPDATA%/Baekho Studio/settings.json`의 프로젝트 선택을 읽을 수 있지만 원본 설정을 덮어쓰지 않습니다.
- 타격감 결과는 각 Unity 프로젝트의 `CombatLabResults`에 그대로 남습니다.
- 테스트 데이터 경로는 `BAEKHO_DATA` 또는 기존 `PARTSMITH_DATA` 환경변수로 지정할 수 있습니다. 테스트 경로 사용 시 기존 Combat 설정을 자동으로 가져오지 않습니다.
- 앱 종료 후 임시 입력의 영속 복구는 도구별 기존 지원 범위를 따릅니다. 메뉴 전환과 앱 종료는 다릅니다.

## 연결과 실제 생성

타격감의 새 실험에는 Unity Editor와 게임별 Combat Lab 어댑터가 필요합니다. 3D 제작에는 선택한 단계에 따라 Codex, Tripo, Blender, Unity가 필요합니다. 홈의 도구 열기만으로 생성이나 게임 실행을 시작하지 않습니다. 실제 AI 사용량과 유료 제작 승인은 각 도구의 기존 확인 절차를 유지합니다.

- [3D 제작 기능·실행 안내](docs/partsmith.md)
- [타격감 실험 기능·연결 안내](docs/combat-lab.md)
- [다른 Unity 프로젝트에 Combat Lab 연결](docs/reusing-combat-lab.md)
- [공통 UI·UX 규칙](docs/ux-principles.md)
- [통합 검증 기록](docs/STUDIO-VERIFICATION.md)

## 검사

```powershell
npm test
npm run test:combat
npm run build
npm run test:integration
```

통합 화면 검사는 격리된 임시 저장소와 로컬 보고서 fixture를 사용합니다. 실제 AI 생성, 유료 Tripo 제작, 실제 게임 실행 검증과 구분합니다. 기존 Partsmith 단독 화면은 `npm run start:partsmith`로 열 수 있습니다.
