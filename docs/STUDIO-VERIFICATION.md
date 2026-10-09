# 백호툴 0.7.0 통합 검증

검증일: 2026-10-09 (한국 시간)
브랜치: `integration/baekho-studio`
환경: Windows, Node.js 24.14.0, Electron 44.7.0

## 통합 범위

- 세 원본 브랜치의 이력을 보존해 통합하고 홈·도구·실행·결과·설정을 실제 저장 기록과 연결했습니다.
- 3D 제작실은 React 내부 화면으로, 타격감은 같은 창의 유지되는 WebContentsView로 제공합니다.
- 메뉴 전환 시 선택·미전송 입력을 유지하고 타격감 영상 재생만 정지합니다.
- 결과 이동에 프로젝트 경로를 함께 전달하고, 이전 프로젝트의 늦은 응답이 새 보고서를 닫지 않도록 보완했습니다.
- Windows 최소화 시 0으로 보고되는 크기를 작업 영역에 적용하지 않고 복원 시 다시 배치합니다.

## 실행한 검사

| 검사 | 결과 |
| --- | --- |
| `npm test` | 155개 중 154개 통과, 1개 건너뜀, 실패 0 |
| `npm run test:combat` | 118개 통과, 실패 0 |
| `npm run build` | TypeScript 및 Vite/Electron 빌드 통과 |
| `npm run test:integration` | 개발 앱 통합 시나리오 10개 통과, renderer 예외 0 |
| `npx electron-builder --win dir` | Windows 폴더 빌드 생성 |
| `node scripts/studio-smoke.mjs --packaged "release/win-unpacked/Baekho Tools.exe"` | 실제 배포 EXE에서 통합 시나리오 10개 통과, renderer 예외 0 |
| 독립 코드 검토 및 수정 재검토 | 프로젝트 전환 경합 수정 확인, 해당 재검토 테스트 39개 통과 |

건너뛴 검사는 기존 테스트의 고정 경로 `C:/Program Files/Blender Foundation/Blender 5.0/blender.exe`가 없으면 생략하는 실제 Blender 검사입니다. 이 통합 변경에서는 Unity C# 코드를 수정하지 않았으며 실제 Unity 프로젝트를 실행하지 않았습니다.

개발·배포 EXE 양쪽에서 확인한 시나리오:

1. 격리된 저장소의 파일 기록을 홈에 표시하고 renderer별 API를 분리한다.
2. 3D 프로젝트와 작성 중인 이미지 프롬프트를 다른 메뉴 왕복 후 유지한다.
3. 타격감 WebContents와 작성 중인 목표 입력을 왕복 후 유지한다.
4. 공통 결과에서 정확한 타격감 보고서를 열고 실험 설계 초안을 유지한다.
5. Unity 프로젝트 변경 후 새 프로젝트 보고서가 열리고 이후 폴링에도 유지된다.
6. 빠른 이동 시 타격감 화면이 설정 화면을 가리지 않는다.
7. 창 최소화·복원 후 작업 영역이 복구된다.
8. 1180×760 창에서 공통 화면과 타격감 영역이 창 안에 배치된다.
9. renderer 예외가 없다.
10. 화면 탐색·보고서 조회가 Unity 명령 요청 파일을 생성하지 않는다.

기계 판독 기록: [개발 앱](../artifacts/studio-development-smoke.json), [배포 EXE](../artifacts/studio-packaged-smoke.json).
[스크린샷](../artifacts/screenshots/studio/)의 Unity 프로젝트와 보고서는 **검사 전용 로컬 fixture**입니다.

## 한계

- 유료 Tripo 제작이나 AI 생성 호출을 실행하지 않았습니다. 실제 게임 자동 플레이·새 SO 내보내기와 실제 AI 캐릭터 전체 품질은 이번 검사에 포함하지 않았습니다.
- 사용자 실제 데이터로 업그레이드·동시 실행을 시도하지 않았습니다. 기존 Partsmith identity·경로·세션을 유지하고 테스트는 별도 데이터 경로에서 수행했습니다.
- 모델링 결과는 해당 프로젝트로 돌아가는 진입점입니다. 개별 과거 후보는 제작실 안의 이력에서 선택합니다.
- 앱 종료 후 임시 입력 복구는 각 도구의 기존 지원 범위입니다. 앱 내부 메뉴 이동 시 입력 보존은 확인했습니다.
- 코드 서명·설치 프로그램은 포함하지 않습니다. 실행 파일이 들어 있는 폴더 전체를 사용합니다.
- Vite는 기존 Three.js/도구 UI 번들이 500kB보다 크다는 경고를 표시합니다. 빌드와 실행은 통과했습니다.

GitHub Actions는 Windows에서 두 테스트 모음과 빌드를 검사하도록 추가했습니다. 로컬 기록과 원격 CI 결과는 별도로 확인합니다.

원격 CI 확인: 구현 커밋 3701fc786d919d8b86f36b9e63a27bfb8a2e1a1b의 [Windows 자동 검사](https://github.com/lala11112/studio-baekho-tools/actions/runs/37881533639)가 2026-10-09 성공했습니다. 두 테스트 모음과 빌드를 모두 통과했습니다. 이후 이 완료 기록만 추가했습니다.
