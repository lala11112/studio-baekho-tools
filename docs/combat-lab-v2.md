# Combat Lab v2 사용 및 연결

Combat Lab v2는 원본 주변의 배율 탐색에서 벗어나 **실행에 적용할 절대값과 선택 항목의 패치**를 저장합니다. 원본이 0이어도 새 카메라 효과·흔들림·히트스톱을 만들 수 있습니다. AI 생성과 직접 편집은 같은 후보 데이터를 사용합니다.

## 작업 순서

1. 원본 폼과 동작을 고르고 실제 연결의 지원 항목을 조회합니다.
2. 넓게 탐색(`explore`)으로 서로 다른 레시피를 비교하거나 직접 후보를 만듭니다.
3. 단계·타격별 값을 편집하고 유지할 항목을 잠급니다. 미세 조정(`refine`)에는 기준 후보와 평가를 함께 전달합니다. 원인별 비교에는 한 요소만 변경하거나 작은 요인 조합을 사용합니다.
4. 먼저 고정 표적에서 선택 동작을 한 번 실행해 실제 원본과 비교합니다. 이후 실전 모드·전체 콤보·반복 실행으로 확인합니다.
5. 선호 후보와 이유를 저장하고 새 프리셋 또는 통합 폼 SO를 내보냅니다.

AI 설명은 예상 효과입니다. 편집한 후보는 AI가 작성한 이전 수치와 달라질 수 있으며, 피해량·명중 수는 타격감의 자동 점수가 아닙니다.

## 절대값과 원본 보존

`schemaVersion: 2`의 `values`와 `curves`에는 의도적으로 바꿀 항목만 넣습니다. `step.0`은 선택 동작 목록의 첫 단계이고 `step.0.hit.0`은 그 단계의 첫 HitEvent입니다. 실제 ID는 어댑터가 반환하는 목록을 사용하며 임의의 코드 경로를 쓰지 않습니다.

다음 예시는 첫 단계에 피격자 로컬 정지를 지정하고 공격 진행 FOV 곡선을 교체합니다. GUID와 동작 ID는 실제 연결 값으로 바꿉니다.

```json
{
  "schemaVersion": 2,
  "adapterId": "four-tiger-sword.water",
  "sourceGuid": "실제 폼 GUID",
  "actionId": "normal-1",
  "durationSeconds": 5,
  "seed": 1701,
  "recordVideo": true,
  "includeSourceControl": true,
  "scenarioMode": "fixed",
  "precisionCapture": true,
  "precisionTargetId": "",
  "repeatCount": 1,
  "candidates": [{
    "id": "manual-01",
    "label": "짧은 피격자 정지와 줌",
    "origin": "manual",
    "values": [
      { "id": "step.0.hitstop.duration", "value": 0.05 },
      { "id": "step.0.hitstop.timeScale", "value": 0 },
      { "id": "step.0.hitstop.scope", "value": 2 }
    ],
    "curves": [{
      "id": "step.0.camera.motion.fovOffset",
      "keys": [
        { "time": 0, "value": 0 },
        { "time": 0.2, "value": -3 },
        { "time": 1, "value": 0 }
      ]
    }]
  }]
}
```

필드를 바꾸면 해당 채널은 자동으로 직접 설정됩니다. 명시적인 mode는 이 자동 활성화보다 우선합니다. `Inherit=0`은 원본 유지, `Off=1`은 끄기, `Override=2`는 직접 설정입니다. 편집하지 않은 Unity 곡선의 키·탄젠트·가중치·랩 모드는 보존하고, 편집한 곡선만 2~16개 키의 선형 보간으로 교체합니다.

요청의 mode 0은 기존 개별 타격 override를 해제하는 명령이 아닙니다. 그 채널의 숫자·곡선 패치를 모두 제외하고 원본의 override·프로필 상속 관계를 그대로 유지합니다. `camera.mode=0`은 공격 진행 Motion만 유지하며 Impact·Shake의 독립 편집은 허용합니다. 히트스톱·Impact·Shake의 mode 0도 각 채널만 보존합니다.

`minimum/maximum`은 유효성 제한이고 `suggestedMinimum/suggestedMaximum`은 추천 탐색 범위입니다. 현재 원본값이 추천 범위 밖에 있어도 후보를 만들 수 있습니다. 시간·값은 유한한 수여야 하며 timeScale은 0~1입니다. 최종 카메라 FOV는 1~179도, FramingWeight는 0~1로 제한됩니다. 실행 중 제한이 적용되면 `value-limited` 이벤트에 요청값·적용값·이유를 기록합니다.

## 카메라·명중·흔들림

| 채널 | 시간축과 값 |
|---|---|
| Motion | 공격 진행도 0~1의 FOV, 위치 XYZ, 회전 XYZ와 구도 가중치 |
| Impact | 실제 명중 후 delay가 지난 뒤 duration 동안의 FOV·위치·회전 킥 |
| Shake | 실제 명중 후 delay·duration·주파수·감쇠 곡선, 절대 이동 진폭(m)과 회전 진폭(deg) |

위치·회전은 Camera / World / Attack 좌표계를 선택합니다. 공격 중 곡선으로 명중 이전 연출을 만들고, 실제 명중을 요구하는 Impact·Shake에는 음수 지연을 사용하지 않습니다. 명중 곡선과 감쇠 곡선의 X축도 duration에 대한 0~1입니다.

World는 전체 timeScale, Actor는 공격자의 로컬 시간까지, Unscaled는 실시간을 따릅니다. 공격 진행 자체는 캐릭터 액션 시계에 연결되어 있습니다. Motion의 Clock은 추종 보간을, ReturnClock은 정상·취소 복귀를 제어합니다. Impact와 Shake는 각각 독립 시계를 사용합니다. 새 흔들림은 Cinemachine 전역 임펄스 시계를 바꾸지 않으며 원본 ImpulseSource 세기가 0이어도 작동합니다.

명중 채널의 Add / Replace / Strongest는 동시 효과의 합산·교체·가장 강한 신호 선택입니다. 기본 중복 단위는 공격 단계의 HitEvent당 한 번입니다. 같은 타격이 여러 콜라이더·적에 닿아도 반복하지 않으며 다른 HitEvent는 같은 적에게 다시 효과를 줄 수 있습니다. 단계당 한 번 또는 피격자마다 모드도 선택할 수 있습니다.

Feel 줌과 명시 FOV 곡선의 재생 소유권은 분리됩니다. FOV 곡선을 편집하면 기본적으로 Feel 줌을 끄고 명중 섬광은 유지합니다. `motion.useFeelZoom`을 명시하면 그 선택이 우선합니다. Shake가 Off/Override인 경우 기존 Feel 임펄스를 중복 재생하지 않습니다. 기존 원본 프로필은 v2를 켜지 않는 한 기존 경로를 사용합니다.

## 히트스톱과 캐릭터 시계

적용 대상은 `Global=0`, `Attacker=1`, `Victim=2`, `Both=3`입니다. duration은 실제 시간이고 timeScale은 대상의 진행 속도입니다. 로컬 정지는 세계 timeScale을 바꾸지 않습니다.

로컬 액션 시계에는 공격 타이머·타격 판정·애니메이션·이동·회전·중력·넉백·적 행동 진행을 연결합니다. NavMesh의 이동 잠금과 속도 합성도 함께 제어하므로 Animator만 멈추는 방식이 아닙니다. 이동을 수반하는 끌어당김·공중 띄우기 효과도 같은 시계를 따릅니다.

입력 수집, 세계시간 쿨다운·SP 재생·일반 버프·지속 피해와 이미 발생한 독립 효과는 계속됩니다. 입력 버퍼의 남은 시간과 홀드 시간은 행위자 시간을 사용하므로 완전한 로컬 정지 동안 유지되며, 정지 중 수집한 폼 전환 입력도 재개 시 처리합니다. 외부 피해와 사망은 정지 중에도 처리하며 사망·장면 이동·비활성화는 정지보다 우선합니다. 종료 시 과거 속도를 일괄 복구하지 않고 남은 행동·버프·잠금에서 현재 속도를 다시 계산합니다.

광역 타격의 피격자 정지는 실제로 피해가 적용된 각 대상에게 독립 적용됩니다. 공격자·전역 정지는 타격 이벤트당 한 번입니다. 중첩 방식은 교체·연장·더 낮은 속도와 더 늦은 종료 유지 중 선택합니다.

## 원본 비교와 캡처

`includeSourceControl`은 후보 패치를 적용하지 않은 원본을 별도로 실행합니다. 원본은 AI 후보 수에 포함되지 않습니다. v1의 모든 타격 히트스톱 통일 같은 보정을 원본에 적용하지 않습니다. 각 후보·반복은 새 Play Mode에서 시작합니다.

고정 표적 모드는 표적 AI를 수동 상태로 만들고 같은 상대 거리·방향에서 동작을 한 번 실행합니다. 피격·넉백은 유지하고 표적 런타임 HP를 높여 연타 중 사망을 방지합니다. 물리·프레임·씬 초기화까지 결정적으로 만드는 기능은 아니므로 동일 시드만으로 동일 전투를 보장하지 않습니다.

Four Tiger 연결은 씬 시작 전에 런타임 `RunManager`의 무작위 시드를 끄고 요청 시드를 지정합니다. 준비된 활성 적이 없으면 계층 경로·형제 순서로 선택한 Waiting 전투방을 기존 `BeginEncounter` API로 활성화합니다. 플레이어 capsule을 수용할 NavMesh 위치를 찾고 카메라 이력을 초기화하며, 접지·표적·렌더 카메라가 연속 3프레임 안정된 뒤 녹화를 시작합니다. 이 준비는 Play Mode 객체에만 적용합니다.

Arm 직전 플레이어·표적·렌더 카메라 위치와 플레이어 yaw, 카메라 pitch/yaw/roll·FOV 및 안정 표적 키를 기록합니다. 원본 비교 실행(없으면 첫 후보)을 기준으로 위치 0.02m, 각도·FOV 0.1도 허용 범위를 벗어나면 `conditions-mismatch`, 관측값이나 기준이 없으면 `conditions-unavailable`로 표시합니다. 실행 오류 상태는 유지하고 `fixtureValidation.executionStatus`에 조건 검증 전 상태를 보존합니다. 원본 컨텍스트는 편집 모드의 `DescribeContext` 결과를 그대로 `source-context.json`과 보고서에 저장하며 SHA-256·UTC 시각을 함께 기록합니다.

다른 프로젝트 연결에서는 `ICombatLabEarlyPlayAdapter`(씬 Start 이전), `ICombatLabScenePreparation`(준비가 끝날 때까지 대기), `ICombatLabReadySession`(입력 Arm 전 정착)을 선택적으로 구현할 수 있습니다. 기존 연결의 필수 인터페이스는 바뀌지 않습니다.

녹화는 히트스톱을 포함한 벽시계 시간을 사용합니다. `<candidate>-repeat-N.frames.json`에는 실제 캡처마다 캡처 인덱스·Unity frameCount·Unity 실시간·녹화 경과·영상 PTS를 별도로 기록합니다. 종료 시 마지막 영상 프레임을 유지하는 `terminalHold`는 새 렌더 샘플이나 PNG로 세지 않습니다.

정밀 캡처는 선택한 실제 명중의 전 150ms~후 600ms에서 최대 48장의 실제 캡처를 보존합니다. PNG 압축은 녹화 종료 후 수행합니다. 상태는 `disabled`, `missing-hit`, `complete`, `incomplete`이며 구간 누락·버퍼 초과·PNG 손실은 불완전으로 표시합니다. 캡처 간격의 중앙값·최대값·33.333ms 초과 간격 수도 기록합니다.

“이전/다음 캡처”는 저장된 PNG 인덱스를 하나 이동합니다. 보장하는 대상은 캡처한 렌더 샘플이며 모든 시뮬레이션 프레임이 아닙니다. 일반 MP4/WebM의 시간 탐색을 정확한 프레임 선택이라고 부르지 않습니다. 정밀 자료가 없는 이전 보고서는 일반 영상으로 계속 읽습니다.

## AI 참고 문서와 재현 기록

`Desktop/knowledge/combat-feel-guide.md`와 `recipe-library.json`은 배포 앱에 포함됩니다. 생성기는 파일 경로만 전달하지 않고 가이드·레시피 본문을 프롬프트에 주입합니다. 실제 주입한 본문·버전·해시·레시피와 explore/refine 기준·잠긴 항목을 요청에 기록합니다. 가이드의 수치는 자체 제안한 실험 시작값이며 장르 공통 정답이나 외부 제작자의 확정 수치가 아닙니다.

v1 JSON은 기존 배율·일괄 히트스톱 의미로 실행합니다. v2 절대값으로 조용히 변환하지 않습니다. 미지원 연결에는 v2를 지원한다고 표시하지 않습니다.

## 게임 실행부와 설치

Four-Tiger-Sword v2는 공통 패키지, Editor 어댑터 3파일, 게임 실행부가 함께 필요합니다.

- `FourTigerCombatAdapter.cs`, `FourTigerCombatSession.cs`, `FourTigerFeedbackAdapter.cs`
- 게임의 `CombatFeedbackV2`, `CombatFeedbackTelemetry`, `CombatCameraDirector`, `AttackCameraProfile`, Feel 연결
- 캐릭터 시계·히트스톱 토큰, 실제 명중·특수 동작·이동·NavMesh 연결

`Install-FourTigerAdapter.ps1`은 Editor 폴더의 모든 `.cs`를 복사하므로 세 번째 파일도 포함합니다. `Install-CombatLab.ps1 -Adapter FourTigerSword`와 배포 `UnityIntegration`도 어댑터 디렉터리를 포함합니다. 설치기는 게임 전투 소스를 자동 이식하지 않습니다. 게임 실행부가 이전 버전인 다른 체크아웃에는 실행부 변경을 먼저 통합해야 합니다.

필요한 실행부 변경은 [Four-Tiger-Sword 실행부 통합 자료](../Integrations/FourTigerSword/RuntimeIntegration/README.md)에 검토용 패치와 파일별 전후 SHA-256으로 동봉합니다. 기준은 작업 전 보관한 사용자 수정 포함 파일이며 upstream 커밋이 아닙니다. 다른 체크아웃에 자동 적용하지 않으며, 검토·수동 병합과 해당 프로젝트의 컴파일·플레이 검증이 필요합니다. 현재 검증에 사용한 게임에는 이미 통합돼 있습니다.

두 설치기 모두 기존 파일이 다르면 기본적으로 중단합니다. 검토 후 `-Force`로 업데이트하면 다른 기존 파일을 `CombatLabInstallBackups`에 백업하고 기존 `.meta` GUID를 보존합니다. 새 프리셋 내보내기는 기존 에셋을 덮어쓰지 않습니다.
