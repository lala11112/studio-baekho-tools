# Baekho Studio 데스크톱 앱과 Unity 연결

Baekho Studio는 별도 Windows 앱에서 AI 전투 후보 생성, 실험 실행, 여러 영상 비교, 평가 기록과 프리셋 저장을 제공합니다. Unity에는 프로젝트 설정을 읽고 실제 게임을 실행하는 연결 코드가 남습니다. Unity 편집 창을 열지 않아도 패키지가 로드되면 연결이 시작됩니다.

## 구성과 책임

```text
Baekho Studio / Electron
  renderer/                 목표·후보 수 선택, 실행 상태, 여러 영상 비교 화면
  src/preload.cjs           화면에 허용된 기능만 제공하는 IPC 연결
  src/main.cjs              프로젝트 선택, 파일 대화상자, 화면과 기능 연결
  src/project-client.cjs    Unity 요청, 상태 확인, 보고서·영상·평가 파일 접근
  src/ai-candidates.cjs     로그인된 Codex CLI로 실제 수치 생성, 응답 검증
           │
           │ 프로젝트 내부 파일 mailbox
           ▼
Unity Editor
  CombatLabBridge           요청 확인, 명령 전달, 응답·상태 기록
  CombatLab / Runner        검증, Play Mode 전환, 실험 실행과 결과 저장
  CombatLabRecording        영상·오디오 캡처
  ICombatLabAdapter         게임별 설정 탐색·검증·내보내기
  ICombatLabSession         게임별 플레이·관측·복원
```

화면은 Node.js나 파일시스템에 직접 접근하지 않습니다. 데스크톱 메인 프로세스가 선택된 프로젝트의 경로와 결과 파일을 검증하며, 보고서에 등록된 영상만 앱의 로컬 미디어 프로토콜로 제공합니다. Unity API 호출은 모두 Editor의 메인 스레드에서 실행합니다. Unity 연결에 HTTP 서버나 소켓 수신 포트는 없습니다. AI 생성은 별도 Codex 프로세스가 기존 로그인으로 온라인 모델을 호출합니다.

소스 실행과 Windows 배포 폴더 생성은 저장소 루트에서 다음과 같이 할 수 있습니다. Node.js와 pnpm이 필요합니다.

```powershell
pnpm --dir Desktop install --frozen-lockfile
pnpm --dir Desktop start
pnpm --dir Desktop package:win
```

배포 결과는 `Desktop/dist/<version>/Baekho Studio-win32-x64/`에 생성되며, 실행 파일과 동봉 파일을 함께 배포합니다. 패키징은 기존 출력 폴더를 자동 덮어쓰지 않습니다. 일반 앱 실행은 마지막으로 선택한 프로젝트를 복원하며, `--project <프로젝트 루트>`로 처음 열 프로젝트를 지정할 수도 있습니다.

## 연결 조건

- Unity에서 대상 프로젝트가 열려 있고 Combat Lab 공통 패키지와 게임별 어댑터가 컴파일되어 있어야 합니다.
- 앱에는 `Assets`와 `ProjectSettings/ProjectVersion.txt`가 있는 프로젝트 루트를 선택합니다.
- 실험은 씬을 저장한 Edit Mode에서 시작하며, Reload Domain과 Reload Scene이 모두 켜져 있어야 합니다.
- 현재 Four-Tiger-Sword 연결은 수 속성 일반 공격과 유효한 플레이어·적·NavMesh가 있는 씬을 사용합니다.
- 자동 플레이 중에는 런타임 InputSettings 복사본으로 Game View 포커스 밖에서도 가상 입력을 처리합니다. 세션 종료 시 원래 InputSettings 참조와 입력·폼·설정을 복원합니다.

완료된 결과와 영상은 Unity가 닫혀 있어도 읽을 수 있습니다. 새 설정 탐색, 실험 시작·취소, SO 내보내기에는 열린 Unity가 필요합니다.

## 파일 배치와 원자적 전달

모든 연결 파일은 선택한 Unity 프로젝트의 다음 위치를 사용합니다.

```text
Library/CombatLabBridge/
  status.json
  requests/<id>.json
  processing/<id>.json
  responses/<id>.json

CombatLabResults/<run-id>/
  request.json
  report.json
  source-snapshot.json
  scene-dependency-hash.txt
  index.html
  <candidate-id>.mp4
  judgment.json                  사용자가 평가를 저장했을 때 생성
```

`id`는 하이픈 없는 소문자 GUID, 즉 `[a-f0-9]{32}`입니다. 연결 요청 ID와 실험 결과의 `run-id`는 별개입니다.

클라이언트는 요청을 같은 폴더의 임시 파일에 완전히 쓴 다음 `requests/<id>.json`으로 rename합니다. Unity는 최대 초당 4회 요청을 확인하고 먼저 `processing` 폴더로 이동해 처리 권한을 확보합니다. 응답도 임시 파일을 거쳐 원자적으로 게시합니다. 외부 클라이언트는 `processing` 파일을 수정하거나 삭제하지 않아야 합니다.

요청은 UTF-8 JSON이며 **전체 파일 크기 1 MiB 이하**여야 합니다. 버전, 파일명과 본문의 ID 일치, 명령 이름, 유효 시간을 검사한 다음 실제 실험 검증을 수행합니다. 임의 코드 실행이나 셸 실행 명령은 제공하지 않습니다.

## 공통 요청·응답

요청 예시:

```json
{
  "id": "97e4f77c67e745b6999e948a47d1d84a",
  "protocolVersion": 1,
  "command": "describe",
  "payloadJson": "{}",
  "expiresUtcMs": 1791439215000
}
```

`payloadJson`은 중첩 객체가 아닌 **JSON 문자열**입니다. 실제 클라이언트는 `JSON.stringify(payload)`로 생성합니다. `expiresUtcMs`는 UTC Unix 밀리초로 계산한 요청 만료 시각입니다. 예시의 고정 시각을 복사하지 말고 매 요청에서 `Date.now() + timeoutMs`로 지정하세요. 현재 브리지는 이 필드가 없거나 0이면 만료 검사를 생략하지만, 데스크톱 앱은 항상 지정합니다.

성공 응답:

```json
{
  "id": "97e4f77c67e745b6999e948a47d1d84a",
  "ok": true,
  "payloadJson": "{\"adapters\":[]}",
  "error": ""
}
```

실패 응답:

```json
{
  "id": "97e4f77c67e745b6999e948a47d1d84a",
  "ok": false,
  "payloadJson": "",
  "error": "지원하지 않는 Combat Lab 연결 프로토콜입니다."
}
```

성공 응답의 `payloadJson`을 한 번 더 JSON으로 파싱하면 명령별 결과 객체를 얻습니다. 오류 문구는 사용자 표시용이며 프로그램 분기용 고정 오류 코드는 아닙니다.

## 명령별 계약

다음 표의 요청·결과는 `payloadJson`을 파싱한 **내부 객체**입니다.

| 명령 | 요청 객체 | 성공 결과 객체 |
|---|---|---|
| `describe` | `{}` | `{ "adapters": [...] }` |
| `start` | `ExperimentRequest` 자체 | `{ "directory": "C:\\Games\\Project\\CombatLabResults\\<run-id>" }` |
| `cancel` | `{}` | `{ "cancelled": true }` |
| `export` | `{ "request": ExperimentRequest, "candidateId": "baseline", "assetPath": "Assets/CombatPreset.asset" }` | `{ "assetPath": "Assets/CombatPreset.asset", "guid": "<생성한 에셋 GUID>" }` |
| `export-combined` | `{ "request": CombinedExportRequest, "assetPath": "Assets/CombinedCombatForm.asset" }` | `{ "assetPath": "Assets/CombinedCombatForm.asset", "guid": "<생성한 에셋 GUID>" }` |

### describe

`adapters`의 각 항목은 다음 구조입니다.

```text
{
  id: string,
  displayName: string,
  error: string,
  sources: [{
    guid: string,
    label: string,
    error: string,
    parameters: [{
      id: string, label: string, unit: string, description: string,
      minimum: number, maximum: number, baseline: number
    }],
    defaultRequest: ExperimentRequest
  }]
}
```

`defaultRequest`는 JSON 문자열이 아니라 중첩 객체입니다. 기존 API 호환용 기준·약한·강한 후보가 포함되어 있으나, 데스크톱 앱은 이 후보 목록을 사용하지 않고 AI가 생성한 목록으로 교체합니다. 소스 하나를 읽는 데 실패하면 그 소스의 `error`에 원인을 기록하고 다른 소스는 유지합니다. 카탈로그의 GUID와 항목 ID를 사용하며 앱에 게임 필드명을 하드코딩하지 않습니다.

### start

현재 게임의 실험 요청 예시입니다. `sourceGuid`는 실제 `describe` 결과의 값으로 교체해야 합니다.

```json
{
  "schemaVersion": 1,
  "adapterId": "four-tiger-sword.water",
  "sourceGuid": "<describe에서 받은 소스 GUID>",
  "seed": 1701,
  "durationSeconds": 10,
  "recordVideo": true,
  "candidates": [
    {
      "id": "baseline",
      "label": "기준",
      "values": [
        { "id": "knockbackMultiplier", "value": 1 },
        { "id": "cameraShakeMultiplier", "value": 1 },
        { "id": "hitStopDuration", "value": 0.1 }
      ]
    }
  ]
}
```

이 예시의 `0.1`은 기준값을 보장하지 않습니다. 기준 비교에는 `defaultRequest`의 실제 기준값을 유지하세요. 후보는 1~12개, 실행 시간은 후보당 3~60초이며 각 후보는 어댑터의 모든 항목을 정확히 한 번 포함해야 합니다. 현재 어댑터는 넉백 배율 0~2, 카메라 배율 0~3, 히트스톱 0~0.3초를 허용합니다.

Four-Tiger-Sword 어댑터 0.5.0부터 `hitStopDuration`은 선택 공격의 그룹화된 `Feedback.HitStop` 및 활성 개별 타격 override에 저장됩니다. 플레이어 공통값을 변경하지 않습니다. 기준값은 첫 유효 타격이며 한 후보값을 선택 동작 전체에 적용합니다. ID가 같은 이전 JSON도 이 새로운 적용 방식을 사용합니다. 다른 어댑터의 항목 이름·범위·동작 ID는 반드시 `describe` 결과를 사용하세요. 독립 Example 어댑터의 동작은 `strike`입니다.

활성 플레이어가 없는 에셋 조회·내보내기에서는 상속값을 게임 선언 기본값인 0.25초/timeScale 0으로 해석합니다. 플레이어가 둘 이상이면 모호한 기준값을 사용하지 않고 오류로 처리합니다. 씬에 맞는 결과를 얻으려면 실제 테스트 씬을 열고 후보를 생성하세요.

`start`의 성공은 **실험 시작 요청을 수락했다는 의미**입니다. 완료를 의미하지 않습니다. 반환된 결과 폴더와 `status.json`, `report.json`을 통해 진행과 후보별 성공·실패를 확인합니다. Unity는 `Start` 호출이 돌아온 같은 Editor 콜백에서 응답을 기록한 뒤 Play Mode 전환과 도메인 재로드를 진행합니다.

### cancel

실행 중이면 취소를 요청하고 현재 기록·설정을 정리합니다. 이미 대기 중이어도 성공합니다. `{ "cancelled": true }`를 받았다고 즉시 Edit Mode 복귀가 완료된 것으로 판단하지 말고 상태 갱신을 확인하세요.

### export

편집 모드에서 선택한 후보를 **새 프리셋 SO**로 저장합니다. `assetPath`는 `Assets/` 아래의 새 `.asset` 경로이며 기존 파일을 덮어쓰지 않습니다. 상위 폴더는 존재해야 합니다. 현재 어댑터는 공격 데이터 복사본과 카메라 프로필 복사본을 프리셋의 하위 에셋으로 저장합니다. 원본 공격 SO나 플레이어 설정에 자동 채택하는 동작은 포함하지 않습니다.

### export-combined (앱 0.6 / 패키지 0.2부터)

`describe`에서 `adapter.supportsCombinedExport === true`인 어댑터에 사용할 수 있습니다. 같은 원본 폼의 동작별 후보 선택을 모아 파일 하나로 저장합니다. `CombinedExportRequest`는 다음 형태입니다. `requestForNormal1`과 `requestForSkill`은 해당 동작의 전체 `ExperimentRequest` 객체를 뜻합니다.

```javascript
{
  schemaVersion: 1,
  adapterId: "four-tiger-sword.water",
  sourceGuid: "<같은 원본 폼 GUID>",
  selections: [
    { request: requestForNormal1, candidateId: "candidate-1" },
    { request: requestForSkill, candidateId: "candidate-2" }
  ]
}
```

동작은 1~32개, 각 요청은 같은 어댑터·원본을 사용해야 하며 선택한 후보가 실제 후보 목록에 존재해야 합니다. 같은 동작의 중복은 거부합니다. Four-Tiger-Sword는 전체 콤보와 개별 일반 타격의 동시 선택도 거부합니다. 모든 선택을 검증한 뒤 원본을 복제·수정·저장하므로 유효하지 않은 선택으로 일부 동작만 담긴 에셋을 남기지 않습니다.

Four-Tiger-Sword 통합 내보내기의 메인 객체는 실제 폼 SO입니다. 카메라 프로필 복사본은 같은 `.asset` 파일 안의 subasset으로 저장하며, 공격별 프로필 배율은 서로 독립적으로 적용합니다. 원본 에셋과 선택하지 않은 동작은 보존합니다. 동작별 실험·보고서는 기존 `start` 요청으로 각각 실행하고, 마지막 `export-combined`에서 최종 선택만 합칩니다. 이전 `export`와 `ICombatLabAdapter` 계약은 그대로 지원합니다.

## 상태 확인

Unity가 게시하는 `status.json`의 전체 필드:

```json
{
  "protocolVersion": 1,
  "projectPath": "C:\\Games\\Project",
  "unityVersion": "6000.3.10f1",
  "timestampUtcMs": 1791439200000,
  "isPlaying": false,
  "isCompiling": false,
  "running": false,
  "status": "대기 중",
  "directory": ""
}
```

`timestampUtcMs`는 마지막 상태 기록 시각입니다. `directory`는 실행 중인 결과 폴더, 또는 같은 Editor 세션의 최근 결과 폴더입니다. `status`는 사람이 읽는 진행 문구입니다. 데스크톱 클라이언트는 프로젝트 경로와 프로토콜을 검증하고 15초보다 오래된 상태를 연결 끊김으로 취급합니다. 컴파일·Play Mode 전환처럼 메인 스레드가 오래 멈춘 상황도 일시적으로 연결 끊김으로 표시될 수 있습니다. 이는 실행 실패의 확정 신호가 아닙니다.

브리지의 파일에는 `connected` 필드가 없습니다. 앱의 `ProjectClient.getStatus()`가 최신성 검사를 거쳐 `connected`와 연결 오류 문구를 덧붙입니다.

## 중복 실행, 시간 초과, 재로드

1. **응답 파일이 있으면 같은 ID를 다시 실행하지 않습니다.** 동일 ID의 요청 파일은 제거하고 기존 응답을 유지합니다. 응답 파일은 영수증 역할을 하므로 자동 삭제하지 않습니다. 새로운 의도의 요청에는 새 GUID를 사용하세요.
2. **처리 전에 만료된 요청은 거부합니다.** 앱은 일반 명령에 기본 15초, 실험 시작에 20초의 응답 대기 시간을 적용합니다. 이것은 전체 실험 길이와 별개입니다. 이미 수락된 실험은 요청 만료 시각이 지나도 계속 실행됩니다.
3. **시간 초과 시 아직 `requests`에 있는 자기 요청만 철회합니다.** 삭제에 성공하면 Unity가 처리하기 전에 철회된 것입니다. 파일이 이미 이동되었으면 실행 여부가 불확실하므로 자동 재전송하지 않고 상태와 결과를 다시 확인합니다.
4. **재로드 후 남은 `processing` 요청은 재실행하지 않습니다.** 응답이 있으면 정리하고, 응답 없이 남아 있으면 이미 작업이 실행되었을 가능성을 알리는 실패 응답을 남깁니다. 같은 도메인에서 응답 파일 쓰기만 잠시 실패한 경우에는 메모리에 남은 원래 응답을 다시 게시합니다.
5. **앱 종료는 실행 중인 Unity 실험을 자동 취소하지 않습니다.** 실행 책임은 Unity에 있으며 앱을 다시 열어 결과를 확인할 수 있습니다. Unity가 종료되면 heartbeat도 멈춥니다. Unity 프로세스 강제 종료의 경우 완료 결과나 정상 복원을 보장할 수 없습니다.

이 계약은 같은 로컬 프로젝트와 보존된 응답 파일을 전제로 중복 실행을 방지합니다. `Library` 삭제, 응답 영수증 삭제, 하드 디스크 장애까지 포함한 분산 트랜잭션의 정확히 한 번 실행을 보장하지 않습니다. 정상 결과인 `no-hits`도 타격감을 비교할 충분한 근거로 취급하지 않습니다.

## 메인 게임 개발 툴로 확장하기

- **앱 셸:** 프로젝트 선택, 작업 목록, 결과 탐색과 사용자 평가를 소유합니다. 현재 Combat Lab 화면을 향후 다른 게임 개발 모듈과 나란히 배치할 수 있습니다.
- **기능 모듈:** 후보 작성·검증·실험 실행을 작업 단위로 노출합니다. 화면 버튼, 향후 AI 도구 호출, 자동화가 같은 명령 계약을 사용합니다.
- **Unity 공통 실행부:** 게임 타입을 모르며 실험 진행, 녹화, 요청 검증과 보고서 형식을 담당합니다.
- **게임 어댑터:** 기존 SO·컴포넌트·입력·이벤트를 연결합니다. 다른 프로젝트 지원은 `ICombatLabAdapter`와 `ICombatLabSession` 구현을 추가하는 경계입니다.
- **AI 제공자:** 현재 Codex CLI가 허용된 `ParameterSpec`과 사용자 목표를 받아 실제 후보를 생성합니다. 향후 다른 제공자를 같은 계약으로 추가하거나 `judgment.json`과 실험 결과를 다음 제안의 입력으로 연결할 수 있습니다. 현재 영상·피드백을 자동으로 재평가하는 반복 루프는 없습니다.

## AI 생성과 여러 후보 비교 (0.3)

화면의 `generateCandidates({adapterId, sourceGuid, actionId, goal, count})`는 메인 프로세스에서 현재 Unity 카탈로그를 다시 읽습니다. 화면이 임의로 보낸 범위를 신뢰하지 않습니다. `count`는 2~12개의 AI 제안 전체 수이고, 기준 후보를 추가하지 않습니다. 목표·개수·소스·동작을 바꾸면 생성 결과를 다시 받아야 실행할 수 있습니다.

Codex는 임시 작업 폴더에서 `exec --ephemeral --output-schema`로 호출합니다. shell/apps/multi-agent 도구와 웹 검색을 끄고 읽기 전용 실행을 사용합니다. 사용자·프로젝트 지침이 수치 생성에 섞이지 않도록 사용자 config를 불러오지 않으며, 인증은 Codex가 자체 처리합니다. 앱은 인증 파일을 읽거나 키를 보관하지 않습니다. 모델 이름을 강제하지 않고 Codex 기본 선택을 사용합니다. 응답은 후보 개수, 모든 항목의 정확한 1회 포함, 유한한 수치, 허용 범위, 서로 구분되는 값인지 검증합니다. 실패 시 가짜 제안으로 대체하지 않습니다.

생성은 180초 제한과 취소를 지원합니다. `request.json`의 `generation`에 provider/model(알려진 경우)/goal/count/createdUtc를, 각 후보의 `rationale`에 예상 효과와 절충점을 보관합니다. 설명은 실제 플레이 관측이 아닙니다. 후보마다 새 Play Mode로 실행하며 현재 최대 12개입니다.

결과 화면은 기본으로 모든 후보를 보여줍니다. `동시 비교 개수`를 줄이면 선택된 영상만 로드하고, 후보 선택이 겹치면 기존 위치와 교환합니다. 모든 로드된 영상에 같은 논리적 시간축을 사용하며 첫 명중 기준 오프셋, 재생 속도, 한 후보의 소리 선택을 적용합니다. 별도 `index.html`은 기존 A/B 형식의 보관용 보고서입니다.

현재 인터페이스는 전투 실험을 검증하기 위한 첫 버전입니다. 게임 생성·씬 제작 전체를 포괄하는 플러그인 시스템, 신규 게임용 기본 전투 프레임워크, 원격 장비 연결, 빌드된 게임 제어, 여러 프로젝트 동시 실행은 제공하지 않습니다. 연결 파일은 로컬 접근 권한을 전제로 하며 외부 네트워크용 인증 API로 취급하면 안 됩니다.

## 동작 선택 (0.4)

`ExperimentRequest`, 보고서, 프리셋의 `actionId`가 같은 대상을 식별합니다. 이전 요청에서 이 필드가 없으면 기존 일반 콤보로 해석합니다. Four Tiger 어댑터의 기존 ID `four-tiger-sword.water`는 저장된 실험의 호환성을 위해 유지하며 이제 다섯 속성을 탐색합니다.

공통 계약의 선택적 `ICombatLabActionAdapter`가 소스별 동작 목록과 동작별 `ParameterSpec`을 제공합니다. 기존 `ICombatLabAdapter` 구현을 바꾸지 않아도 됩니다. `describe`의 각 소스에 다음 항목을 추가합니다.

```text
actions[]
  id, label, available, unavailableReason
  parameters[]       선택한 동작에만 해당하는 항목과 범위
  defaultRequest     actionId를 포함한 템플릿
```

Four Tiger 동작 ID는 `normal-combo`, `normal-1`부터 실제 타수까지, `heavy`, `skill`, `ultimate`입니다. 미지원 동작에는 사유가 있으며 AI 생성·실행을 할 수 없습니다. Unity는 시작할 때 동작과 값 전체를 다시 검증합니다. 앱은 선택한 동작의 설명과 범위를 AI에 전달하고, 생성 응답에 그 동작의 요청 템플릿을 결합합니다.

세션은 실제 가상 입력으로 LMB, E, R을 전달합니다. 개별 일반 타격은 실행 복사본에 선택한 단계만 남깁니다. 강공격은 실제 홀드와 수 게이지 소모를 사용합니다. 스킬 SP와 궁극기 게이지는 시작할 때 한 번 준비하며 기존 재사용 대기시간을 유지합니다. 화·토·목 궁극기는 버프 실행을 관측한 뒤 일반 공격으로 효과를 보여줍니다. `action-executed`와 `follow-up-attack` 이벤트를 구분하므로 후속 일반 공격을 궁극기 직접 타격으로 계산하지 않습니다. 관측된 전체 피해에는 부가 효과가 포함될 수 있습니다.

## 검증

- `Desktop/tests/project-client.test.cjs`: 상태·경로·요청 응답·시간 초과·결과 파일 경계 검증.
- `Tests/CombatLabBridgeRegression.cs`: 실제 Unity mailbox에서 잘못된 입력 거부, `describe`, 중복 응답 보존, 재로드 후 재실행 방지 검증.
- `Tests/FourTigerSessionRegression.cs`: 게임 원본, 입력 참조, 런타임 복사본, InputSettings와 전역 설정 복원 검증.
- 실제 외부 앱 실행 검증은 앱에서 요청한 실험이 후보별 피해 이벤트와 MP4를 만들고, 앱 안에서 영상을 읽을 수 있는지까지 확인해야 합니다. 설정 복원 검증만으로 자동 플레이 성공을 판정하지 않습니다.

2026-10-08 검증에서는 Unity 브리지 회귀 11개와 세션 복원 회귀 118개 항목을 통과했습니다. 외부 앱에서 실행한 `20261008-053004-a2f5d2c1`은 10초 후보 2개가 모두 완료되어 명중 이벤트 14회·16회를 기록했습니다. 실행 후 원본 소스 해시가 유지되고 씬에 미저장 변경이 남지 않았음을 확인했습니다.
