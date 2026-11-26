# Combat Lab v2 실제 실행 검증 기록

2026-10-23, Unity `6000.3.10f1`, Four-Tiger-Sword의 `Assets/_Project/Scenes/Game Scene.unity`에서 생성한 결과를 기록합니다. 완료된 보고서로 확인한 범위만 통과로 표시합니다. 사용법과 계약은 [Combat Lab v2](combat-lab-v2.md)를 참고하세요.

이 문서에서 결과 경로의 기준은 게임 프로젝트의 `CombatLabResults/`입니다. 검증한 PC의 프로젝트는 `C:/Users/Yoon Youngseok/Documents/GitHub/Four-Tiger-Sword/Four-Tiger-Sword`입니다. 영상·PNG·원본 보고서는 이 결과 폴더에 있으며 도구 저장소에 영상 전체를 포함하지 않습니다.

| 검증 | 확인한 결과 | 근거 |
|---|---|---|
| 대표 동작 실제 입력·명중·녹화 17개 | 17/17 통과, incomplete 0, failed 0, 모든 정밀 구간 complete | `feedback-suite-20261023-114133-705ccdc4/suite.json` 및 각 case의 `report.json` |
| 내보낸 폼 SO 직접 실행 대조 | 통과, 실제 런타임 설정 동등, 원본 불변 | `feedback-export-00104d78ab4a42ac88c68071bb148469/comparison.json` |
| 전역 timeScale 0 중 실제 캡처 | 정밀 PNG 45장, 실제 렌더 샘플 67개, complete | `precision-latest.txt`, `precision-capture-check-20261023-112823-283/samples.frames.json` |
| 명중 없음·명중 전 구간 없음 | 각각 missing-hit / incomplete로 기록 | `precision-incomplete-latest.txt`, `precision-incomplete-check-20261023-113616-118/*.frames.json` |
| 일반 Runner의 후보별 새 Play Mode 7회 | 원본 1회와 후보 2개×3회 모두 completed, 후보 6회 시작 조건 matched, 정밀 구간 모두 complete | `20261023-144510-2865ac26/report.json` |
| 최종 코드·직렬화·내보내기 회귀 | 10종 모두 통과 | `final-regressions-20261023-144724/results.json` |

최종 회귀는 바닥 사전 검사, v2 절대값·원본 보존, 카메라 런타임, 캐릭터 시계, 시작 조건, 기본 계약, 동작별 연결, 통합 내보내기, 그룹 데이터와 보고서 저장을 포함합니다. 동작 연결 회귀의 564개 검사는 검증용 임시 SO까지 포함한 소스 8개·동작 50개를 대상으로 한 수치이며, 실제 플레이를 564회 실행했다는 뜻이 아닙니다. 실제 플레이 검증은 아래 17개 대표 동작과 새 Play Mode 7회로 구분합니다.

최초 캐릭터 시계 회귀에서 Edit Mode의 `SendMessage` 호출 때문에 `ShouldRunBehaviour` assertion 7개가 발생했습니다. 진단 helper의 호출만 reflection으로 수정하고 실행부는 바꾸지 않았습니다. `final-regressions-20261023-144724/actor-clock-rerun.json`에서 37개 검사 재통과와 이전 콘솔 cursor 이후 새 오류 0개를 확인했습니다.

## 대표 동작 17개

각 동작을 5초씩 고정 표적에서 실행했습니다. 준비 단계에는 실제 어댑터의 seed `1701` 절차 생성 준비, 대기 전투방 활성화, 초기화 대기와 접지·표적·카메라 안정화가 사용됐습니다. 녹화가 준비된 뒤 가상 입력을 허용했습니다. 아래 결과는 **한 Play Mode에서 이어 실행한 진단**입니다. 후보마다 새로 시작하는 일반 Runner의 격리 검증과 구분합니다.

| 폼 | 동작 | 관측 피해 이벤트 / confirmed-impact | 실제 캡처 수 | 정밀 구간 |
|---|---|---:|---:|---|
| 수 | 일반 1타 | 2 / 2 | 158 | complete |
| 화 | 일반 1타 | 1 / 1 | 158 | complete |
| 토 | 일반 1타 | 1 / 1 | 161 | complete |
| 목 | 일반 1타 | 1 / 1 | 163 | complete |
| 금 | 일반 1타 | 1 / 1 | 171 | complete |
| 수 | 강공격 | 1 / 1 | 161 | complete |
| 수 | 스킬 | 1 / 1 | 174 | complete |
| 화 | 스킬 | 4 / 3 | 167 | complete |
| 토 | 스킬 | 1 / 1 | 170 | complete |
| 목 | 스킬 | 1 / 1 | 176 | complete |
| 금 | 스킬 | 1 / 1 | 160 | complete |
| 수 | 궁극기 | 10 / 10 | 148 | complete |
| 금 | 궁극기 | 5 / 5 | 169 | complete |
| 화 | 버프 궁극기와 후속 일반공격 | 3 / 3 | 171 | complete |
| 토 | 버프 궁극기와 후속 일반공격 | 2 / 2 | 176 | complete |
| 목 | 버프 궁극기와 후속 일반공격 | 3 / 3 | 177 | complete |
| 수 | 일반 전체 콤보 | 6 / 6 | 166 | complete |

모든 case의 `validationStatus`는 `completed`이며 실제 `action-executed`가 있습니다. 정밀 PNG 총 398장의 파일 존재를 별도로 확인했으며, 모두 실제 캡처이고 명중 전 150ms부터 후 600ms 이내이며 case당 최대 48장입니다. 수 일반 전체 콤보는 실행 단계 3개와 입력 요청 3개를 관측했습니다. 피해 이벤트에는 부가 효과가 포함될 수 있으므로 `hits`와 선택 공격의 `confirmed-impact` 수는 같은 지표가 아닙니다. 화·토·목 버프 궁극기의 명중 수는 후속 일반공격을 포함하며 궁극기 자체의 직접 타격으로 해석하지 않습니다.

진단 후보는 helper가 만든 명시적 수치 패치입니다. AI 생성 품질이나 선호도를 검증한 결과가 아닙니다. 일반 타격·강공격·스킬·직접 타격 궁극기에는 로컬 완전 정지와 절대 흔들림 값을 사용했습니다. 해당 14개 case에서 세계 시간이 계속되는 동안 플레이어의 `ActionDeltaTime=0`, 애니메이터 속도 0인 프레임을 관측하고 재개도 확인했습니다. 버프 궁극기 3개는 폼 버프 값만 편집했으므로 로컬 정지 관측을 요구하지 않았습니다.

이 실행의 실제 캡처 간격 중앙값은 case별 약 **26.54~32.17ms**였고 최대 간격은 **204.34ms**였습니다. 모든 case에 33.333ms 초과 간격이 있습니다. 정밀 구간의 `complete`는 필요한 시간 구간의 실제 샘플을 보존했다는 뜻이며 일정한 60fps나 모든 게임 프레임의 보존을 뜻하지 않습니다.

## 내보낸 SO 직접 플레이 대조

화 폼 일반 1타(`ddfdcb1b3fb44274a8bbf37f6fe3a95b`, `normal-1`)에 아래 패치를 적용했습니다.

- 히트스톱 0.06초, timeScale 0, Both, Maximum
- 흔들림 이동 X 0.05, 회전 Z 0.65, 지속 0.15초
- FOV 오프셋 곡선 `(0, 0) → (0.3, -2) → (1, 0)`

새 통합 폼 SO를 생성한 뒤, 같은 Play Mode에서 **원본+패치**와 **내보낸 SO+빈 패치**를 각각 실제 입력·녹화로 실행했습니다. 두 경로 모두 명중 1회, `confirmed-impact` 1회, 로컬 정지·복귀 관측, `validationStatus=completed`였습니다. 실제 캡처 수는 각각 127개와 118개였고 두 정밀 구간 모두 `complete`였습니다.

보고서의 `runtimeDataEqual=true`, `sourceUnchanged=true`, `cleanupErrors=[]`입니다. 내보내기 직후의 설정, 요청 경로의 실제 session 데이터, 내보낸 SO 경로의 실제 session 데이터 해시가 모두 같습니다.

```text
2ce4b5762ce7602976e21abbc5abaeacc0493b22a2603652f3fdf0b75b40be62
```

비교 대상은 실제 session의 선택 단계 직렬화와 전체 resolved binding 값입니다. 두 영상의 픽셀·피해량·물리 결과·프레임 시각이 같다는 검사는 아닙니다. 요청 경로의 telemetry에는 세계 배율 1에서 actor 배율·delta·애니메이터 속도 0을 관측한 기록과 만료 후 배율 1·애니메이터 속도 1.4로 복귀한 기록이 있습니다. 요청 60ms 정지는 약 63.5ms 뒤 만료 관측됐습니다. 매 프레임 만료를 처리하므로 요청 시간을 밀리초 단위로 정확히 종료한다는 의미로 해석하지 않습니다.

| 경로 | 실제 보고서 |
|---|---|
| 원본+패치 | `feedback-playback-20261023-114033-7527f9da/report.json` |
| 내보낸 SO+빈 패치 | `feedback-playback-20261023-114040-bdbf7bdf/report.json` |
| 실제 설정 대조 | `feedback-export-00104d78ab4a42ac88c68071bb148469/{comparison,request-runtime-snapshot,exported-runtime-snapshot}.json` |

## 캡처 자체의 회귀

`CombatLabPrecisionCaptureRegression.Run()`은 합성 명중 시각을 표시한 뒤 전역 `Time.timeScale=0`에서 실제 렌더 샘플 수집을 검사합니다. 전투 판정 검사는 별도의 실제 명중 session에서 수행했습니다.

| 경우 | 실제 렌더 샘플 | 보존한 PNG | 상태 | 캡처 간격 중앙값 / 최대 |
|---|---:|---:|---|---|
| 전역 정지 | 67 | 45 | complete | 13.96 / 39.87ms |
| 명중 표시 없음 | 21 | 0 | missing-hit | 14.80 / 44.04ms |
| 명중 전 샘플 없음 | 50 | 35 | incomplete | 14.36 / 26.67ms |

전역 정지 case에도 33.333ms 초과 간격이 1개 있습니다. 합성 영상 종료 hold는 실제 렌더 샘플이나 정밀 PNG로 세지 않습니다. 없는 명중·명중 전 이미지는 만들어 채우지 않습니다. 이 캡처 회귀의 13.96ms 중앙값을 실제 전투 실행의 캡처 성능으로 대신 사용하면 안 됩니다.

## 일반 Runner의 새 Play Mode 검증

`20261023-144510-2865ac26/report.json`에서 일반 `CombatLabRunner.Start`의 실행 결과를 확인했습니다. 화 폼 일반 1타, seed `1701`, 고정 표적, 실행당 3초이며 원본 control 1회와 후보 2개를 각각 3회 실행했습니다. 이 검증을 시작할 때 편집 씬은 clean 상태였고 production의 사전 검사와 후보별 씬·도메인 재시작을 그대로 사용했습니다. 진단 helper의 dirty scene 검사 우회를 사용하지 않았습니다.

후보 A는 절대 흔들림 이동 X 0.05와 히트스톱 60ms, 후보 B는 X 0.025와 30ms입니다. 두 후보 모두 회전 Z 0.5, 흔들림 지속 120ms, 정지 배율 0, Both, Maximum을 사용했습니다. 각 반복의 `metrics.appliedValues`에서 요청한 절대값을 확인했고, 각 후보 실행에 공격자·피격자의 정지 시작 2개와 종료 2개가 기록됐습니다. 원본은 후보 패치를 생략한 별도 control입니다.

| 실행 | 결과 / 시작 조건 | 실제 명중 / confirmed-impact | 실제 캡처 수 | 정밀 PNG | 정밀 구간 |
|---|---|---:|---:|---:|---|
| 원본 1회 | completed / baseline | 1 / 1 | 155 | 31 | complete |
| 후보 A 1회 | completed / matched | 1 / 1 | 152 | 34 | complete |
| 후보 A 2회 | completed / matched | 1 / 1 | 157 | 37 | complete |
| 후보 A 3회 | completed / matched | 1 / 1 | 154 | 35 | complete |
| 후보 B 1회 | completed / matched | 1 / 1 | 156 | 36 | complete |
| 후보 B 2회 | completed / matched | 1 / 1 | 154 | 36 | complete |
| 후보 B 3회 | completed / matched | 1 / 1 | 155 | 36 | complete |

후보 6회의 표적 identity, 플레이어·표적·렌더 카메라 시작 위치와 회전·FOV는 원본 baseline과 허용 오차 안에서 일치했습니다. 모든 `fixtureValidation.differences`가 비어 있습니다. 위치 허용 오차는 0.02m, 회전·FOV는 0.1도이며 실제 기록 시점은 안정 프레임 3개를 확인한 후 녹화와 입력 지연을 시작하기 직전입니다.

영상 7개, 전체 캡처 timestamp sidecar 7개와 정밀 PNG 총 245장의 존재를 확인했습니다. 실제 샘플 수와 `capturedFrameCount`가 같고, 첫 media PTS는 0이며 이후 실제 PTS가 증가합니다. 정밀 PNG는 모두 실제 캡처이고 명중 전 150ms부터 후 600ms 이내이며 실행당 48장 이하입니다. 이 실행의 캡처 간격 중앙값은 약 17.33~18.13ms, 최대 간격은 109.82ms입니다. 모든 실행에 33.333ms 초과 간격이 있어 동일한 프레임 간격을 보장하지는 않습니다.

`source-context.json` 본문의 SHA-256이 보고서의 `sourceContextHash`와 일치합니다. 이 실험은 직접 작성한 후보를 입력한 실행 검증이며 AI 생성 결과가 아닙니다. 완료 후 Runner는 대기 중인 Edit Mode로 돌아왔습니다.

같은 폴더의 `final-preservation.json`에서 원본 SO의 dependency hash와 직렬화 snapshot, 씬 dependency hash가 실행 전과 같음을 확인했습니다. 전용 임시 SO 폴더는 제거됐고 비교 보고서는 보존됐습니다. 최종 상태는 clean Edit Mode, Runner 대기, `timeScale=1`, capture framerate·delta 0, background 실행 false입니다.

## 재현 방법과 한계

`FourTigerFeedbackPlaybackRegression`과 `FourTigerFeedbackExportPlaybackRegression`은 개발자가 명시적으로 호출하는 진단 helper입니다. 이미 열린 Play Mode에서 session을 직접 실행해 저장되지 않은 편집 씬을 덮어쓰지 않고 경로를 확인합니다. **일반 Runner의 dirty scene 거부 조건은 그대로 유지합니다.** 앞선 17case·SO 진단 때문에 원본 씬을 저장하거나 dirty 상태를 지우지 않았으며, 이후 일반 Runner 검증에서는 시작 당시 clean인 씬을 사용했습니다. runtime 위치·입력·복제 폼·표적 상태는 임시 변경이며 원본 SO에 채택하지 않습니다. 내보내기 대조용 새 SO도 전용 임시 폴더에 생성하며 등록한 폴더만 별도 정리합니다.

같은 seed와 시작 위치는 비교 조건을 좁혀 주지만 Unity 물리·NavMesh·프레임 진행까지 결정적으로 만들지 않습니다. 17case 진단과 SO 대조는 한 Play Mode의 세계 상태를 이어 사용했습니다. 실제 피해량이나 명중 수의 우열을 타격감 점수로 삼지 않으며, 여러 실행의 프레임·파형이 같다는 주장도 하지 않습니다.

정밀 캡처는 실제 렌더 샘플의 real-time timestamp를 기준으로 비교합니다. 캡처 부하, Game View 상태와 PC 환경이 간격을 바꾸며 짧은 정지는 이미지 한 장으로만 관측될 수 있습니다. 영상 탐색 시 선택한 시간과 인코딩된 프레임이 정확히 일치한다는 보장도 없습니다. 구간 완전성, 실제 샘플 수, 최대 간격과 33.333ms 초과 횟수를 함께 확인해야 합니다.
