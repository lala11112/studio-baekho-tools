# AutoHitTimer 백호툴 통합

사용자 요청: 팀원의 새 미완성 기능 브랜치를 기존 백호툴에 합친다.
원본: `feature/AutoHitTimer`, `5d870e39760555d980485cedc4fd12c1d72d5025`.
대상: `integration/baekho-studio`. 원본 이력을 보존한다.

## 구현 범위
- 세 번째 도구 `타격 타이밍`을 홈·도구·실행·결과·설정에서 제공하고 `개발 중`으로 표시한다.
- 기능은 원본의 애니메이션 검색/드롭, Unity 프레임 촬영, AI 구간 제안, 타임라인 검토, 기본 복사 저장을 유지한다. 통합 검증에서 실제 생성/촬영/에셋 적용은 실행하지 않는다.
- Controller와 native view를 유지하여 화면 이동이 작업/초안을 버리지 않도록 한다. 숨길 때 미리보기 재생만 멈춘다.
- 요약은 순수 조회이며 미분석·검토 필요·저장 결과 확인 중·저장됨을 구분한다. `uncertain`과 `no-hit`을 성공으로 표시하지 않는다.
- 결과에서 프로젝트 경로+작업 ID로 정확히 복귀한다. 오래된 다른 프로젝트 링크를 자동으로 실행하거나 적용하지 않는다.
- 통합 데이터는 기존 호스트 아래 `auto-hit-timer`에 분리한다. 독립 앱의 데이터를 가져오는 경우 원본을 읽기 전용으로 보존하고 기존 통합 파일을 덮어쓰지 않는다. 시험에서는 기존 사용자 데이터를 읽지 않는다.
- 프레임 프로토콜·IPC는 도구 mainFrame과 허용된 문서에만 제한한다. 홈만 열어서는 Unity 요청/AI 프로세스/초안 쓰기를 수행하지 않는다.
- 두 native view 가운데 하나만 표시하고 최소화·복원·빠른 화면 전환을 검증한다. 종료 시 새 Controller의 분석 취소와 비동기 정리를 기다린다.
- Windows 패키지에 앱 소스·renderer와 Unity 키트(Packages, Integrations, Installer)를 포함한다.

## 미완성 범위
사람 기준 타수/타격 경계 정확도, 다단타·무타격 실전 평가, 게임 전체 씬 통합은 기존 브랜치에서 미완료다. UI에 제한을 알려주며 통합 완료와 기능 완성도를 구분한다.

## 분담과 검사
- AutoHitTimer 서비스/renderer: Apps/AutoHitTimer 내부.
- 공통 UI: src/StudioShell.tsx, src/studio.css.
- 호스트/요약/패키징: electron, engine/studio-summary.ts, shared/studio.ts, scripts, package.json.
- 기존 세 테스트 모음, 요약/서비스/보존 경계 검사, 개발/배포 Electron 통합 검사, 독립 코드 검토, Windows CI.
