# 백호툴 0.8.0 — AutoHitTimer 통합 검증

날짜: 2026-10-10 (한국 시간). Windows / Node 24.14.0 / Electron 44.7.0.
대상: `integration/baekho-studio`.
합친 원본: `feature/AutoHitTimer`의 `5d870e39760555d980485cedc4fd12c1d72d5025`.

## 변경
- 타격 타이밍 도구를 홈·도구·실행·결과·설정에 연결하고 개발 중으로 표시했습니다.
- 별도 앱 생명주기를 서비스로 분리해 기존 두 도구와 같은 창에서 전환합니다. 각 native view와 Controller를 유지하고 숨길 때 재생만 멈춥니다.
- 홈 요약은 파일 조회만 하며, AI·Unity 요청이나 초안 쓰기를 시작하지 않습니다.
- 명시적인 도구 열기 때만 초기화하고 기존 독립 앱의 검증된 데이터를 별도 저장소로 한 번 복사합니다. 원본과 이미 있는 통합 파일을 덮어쓰지 않습니다.
- 프로젝트 경로와 작업 ID를 함께 확인해 결과를 다시 엽니다. 중단된 디스크 기록은 활성 실행으로 표시하지 않습니다.
- 저장 대기·판단 불확실·타격 없음·검토 완료·저장 완료를 구분합니다. 기존 검토/변경 확인/기본 복사 저장을 유지합니다.
- 종료 시 분석 취소와 비동기 정리를 기다립니다. 불확실한 Unity 저장 요청은 자동 재전송하지 않습니다.

## 검사

| 항목 | 확인 결과 |
| --- | --- |
| 기존 Partsmith + 공통 테스트 | 158 통과, 고정 Blender 경로를 요구하는 기존 검사 1개 생략 |
| 기존 Combat Lab 테스트 | 118 통과 |
| AutoHitTimer 테스트 | 48 통과 |
| TypeScript / Vite / Electron 빌드 | 통과 |
| 개발 앱 통합 smoke | 13개 시나리오 통과, renderer 예외 0 |
| Windows 패키지 EXE 통합 smoke | 동일 13개 시나리오 통과, renderer 예외 0 |
| Unity 배포 키트 검사 | 패키지/어댑터/설치기 포함, 격리된 fixture에 설치 복사, 기존 fixture 소스 보존 |
| 패키지 동일성 | 새 서비스·renderer·호스트 번들의 SHA-256이 현재 소스/빌드와 일치 |
| 독립 코드 검토 | 중단 기록 상태 표기 수정 후 재검토에서 추가 지적 없음 |

통합 시나리오는 기존 10개에 새 도구의 프레임 미디어·API 분리·입력/뷰 유지, 정확한 저장 작업 복귀, 작은 창 배치를 더했습니다. 홈의 수동 조회가 새 도구의 초안과 Unity mailbox를 변경하지 않는 것도 확인합니다.

증거: [개발 앱](../artifacts/studio-development-smoke.json), [패키지 EXE](../artifacts/studio-packaged-smoke.json), [Unity 키트](../artifacts/hit-timer-kit-smoke.json), [화면](../artifacts/screenshots/studio/).

## 미완료 및 검증 경계

통합 검사에 표시된 작업·프레임·저장 에셋 기록은 **격리된 로컬 fixture**입니다. 실제 Unity 촬영, AI 분석 요청, 게임 에셋 적용을 실행하지 않았습니다. 키트 검사는 파일 배치와 설치 복사를 확인한 것이며 Unity 컴파일 성공을 뜻하지 않습니다.

원본 기능의 사람 기준 타수/경계 정확도, 여러 실제 동작과 무타격 평가, 전체 게임 플레이 통합은 여전히 개발 중입니다. [원본 검증 기록](../Apps/AutoHitTimer/VALIDATION.md)의 과거 실행 기록과 이번 통합 검사를 구분합니다.

현재 UI는 모델링 프로젝트, Combat Lab 프로젝트, AutoHitTimer 프로젝트를 도구별로 선택합니다. 기존 다른 브랜치의 추가 변경은 이번 새 기능 병합의 범위에 포함하지 않았습니다.

코드 서명/설치 프로그램은 없으며 `release/win-unpacked` 폴더 전체가 필요합니다. 기존 큰 프런트엔드 번들에 대한 Vite 경고는 남아 있지만 빌드와 실행은 통과했습니다.

## 원격 확인

구현 커밋 [c3f681c](https://github.com/lala11112/studio-baekho-tools/commit/c3f681c650d9cb4f37b28dd6fd5dfa0e17e9cbeb)의 [Windows CI](https://github.com/lala11112/studio-baekho-tools/actions/runs/38016420784)가 2026-10-10 성공했습니다. 세 테스트 모음과 빌드를 통과했고, 이후 이 완료 기록만 추가했습니다.
