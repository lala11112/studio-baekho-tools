# 메인 툴 연동 계약 v1

계약의 TypeScript 원본은 `shared/types.ts`입니다. 첫 버전은 서버 없이 프로세스 내부 호출을 사용합니다. 메인 툴의 기술이 결정되면 이 계약을 로컬 소켓/HTTP로 감싸되 인증·origin·요청 크기 제한을 추가해야 합니다. renderer에서 Node나 API 키를 직접 사용하지 않습니다.

## 계층

```text
React UI → window.desktop.call(Command)
         → sandbox preload → 단일 허용 IPC channel
         → host dispatcher
             ├ Engine + Store (UI 비의존)
             ├ Tripo (네트워크 제공자 어댑터)
             ├ LocalPipeline (Blender process / Unity queue)
             └ Vault / native dialogs / local image adapter
```

React를 제거해도 Store·Engine·Tripo·LocalPipeline을 그대로 사용할 수 있습니다. 앱 호스트에서 `new Store(root); await store.open(wasmPath)` 후 `new Engine(store,new Tripo(getKey), (id,file) => local.previewModel(id,file))`로 초기화합니다. 세 번째 콜백은 P2 사각면 등 FBX 결과의 GLB 미리보기를 만드는 로컬 어댑터입니다. crop·파일 대화상자·Vault는 플랫폼 어댑터입니다. 이미지 파일을 프로그램에서 가져오려면 `engine.importFile`을 사용합니다.

## 호출과 응답

IPC 응답 envelope는 `{ok:true,value}` 또는 `{ok:false,error}`입니다. preload의 `call()`은 성공 시 value를 반환하고 실패 시 Error를 던집니다. `Command`는 임의 파일 접근·셸 실행·URL 실행을 허용하지 않는 tagged union입니다. UUID로 프로젝트·파츠·후보·작업·조합·빌드를 구분합니다.

| 요청 | 결과 / 의미 |
|---|---|
| `state` | 프로젝트 목록, 공개 설정, 키 존재 여부, 모델 카탈로그 |
| `project.create/update/open/export` | 생성·메타데이터 변경·복원·백업 |
| `asset.import` | native 파일 선택, 프로젝트 내부 복사, Asset 반환 |
| `image.select` | 현재 참조 이미지 선택; 이전 버전은 유지 |
| `part.add/update/delete/crop` | 파츠 구성·후보 선택·위치·마스크 |
| `part.assign` | 보관함의 GLB 결과를 선택한 파츠 후보로 추가·선택; 고정된 파츠는 거부 |
| `assembly.save/restore` | 파츠 목록·선택·변환의 버전 스냅샷 |
| `generation.quote` | 실행 없는 요청 검증·만료되는 Quote 생성 |
| `generation.approve` | Quote 소비 후 한정된 개수의 Job 생성·비동기 제출 |
| `job.poll` | 기존 원격 ID 조회·다운로드; 생성 재제출 아님 |
| `job.cancel` | 미제출 후보 취소 또는 원격 추적만 중지 |
| `job.reconcile` | 불명확한 제출을 기존 Tripo ID에 연결 |
| `blender.build/open` | 출력물 및 보고서 / 수동 보정 도구 열기 |
| `unity.install/import/result` | Editor 브리지 / 요청 큐 / 실제 결과 |

### 생성 요청 → 승인

```json
{
  "type": "generation.quote",
  "id": "<project UUID>",
  "request": {
    "kind": "image",
    "prompt": "Stylized explorer, full body, T pose, plain background",
    "model": "seedream_v5",
    "size": "2K",
    "count": 2
  }
}
```

```json
{
  "id": "<quote UUID>",
  "projectId": "<project UUID>",
  "revision": 3,
  "expiresAt": 1791435600000,
  "estimatedCredits": null,
  "costSource": "v3 가격 견적 API 미확인 · 공식 요금표에서 확인 필요",
  "inputSummary": "Stylized explorer…",
  "consumed": false,
  "request": {"kind":"image","model":"seedream_v5","size":"2K","count":2,"prompt":"…"}
}
```

UI가 구체적인 입력·모델·단계·개수·비용 미확인 상태를 표시하고 사용자가 승인한 뒤에만 다음 요청을 전송합니다.

```json
{"type":"generation.approve","quoteId":"<quote UUID>","unknownCostAccepted":true}
```

같은 Quote는 한 번만 소비됩니다. 10분 만료, 프로젝트 revision 변경 시 재검토가 필요합니다. 반복 클릭으로 동일 요청이 다시 과금되지 않습니다. `count`는 1–4이며 후보를 순차 제출합니다. 이미지 생성·편집은 동시 작업 한도를 지키기 위해 이전 원격 작업 완료까지 대기합니다. 한 후보가 제출 실패/불명확이면 나머지 미제출 후보를 중지합니다. 해당 승인은 후속 리깅·애니메이션을 자동 승인하지 않습니다.

0.2.0은 `model`의 `inputMode=image|text|multiview`, 폴리곤·토폴로지·텍스처·UV 옵션과 `segment`, `smartsegment`, `complete`, `retopology`, `uv-pack`, `texture`, `convert`를 같은 승인 계약으로 확장했습니다. 멀티뷰 `sourceIds` 순서는 `[front,left,back,right]`이며 선택하지 않은 뷰는 빈 문자열입니다. 완료된 분할 작업은 `sourceTaskId`로 보완에 연결합니다. 요청별 공개 API 대응표는 `docs/TRIPO-CAPABILITIES.md`를 따릅니다.

### 진행·결과·후보 선택

```json
{"type":"job.poll","id":"<project UUID>","jobId":"<job UUID>"}
```

```json
{
  "id":"<job UUID>", "quoteId":"<quote UUID>", "kind":"model",
  "status":"running", "progress":48, "remoteId":"task_example",
  "revision":3, "createdAt":"2026-10-08T05:00:00Z",
  "message":"원격 작업 진행 중", "request":{"kind":"model","count":1,"model":"v3.1-20260211","prompt":"","partId":"<part UUID>","sourceId":"<asset UUID>"}
}
```

성공 시 `status:success`, `assetId`, `credits`(실제 API 응답이 제공하는 경우), `output`을 기록합니다. 앱 데이터에는 원격 결과 URL이 들어갈 수 있으므로 백업은 개인 파일로 취급하세요. API 키는 들어가지 않습니다. `state`에서 Asset과 Job을 함께 조회합니다.

여러 결과는 `Job.assetIds`로 보관합니다. `Asset.nativeFile`은 다운로드 원본이며 `Asset.file`은 표시 파일입니다. FBX 원본과 GLB 미리보기는 서로 다를 수 있습니다. GLB 이외의 다운로드 형식은 원본 저장에 성공해도 내장 미리보기를 지원하지 않을 수 있습니다. FBX 변환 실패 시 `Job.nativeFiles`, 원격 ID, 실제 사용량을 보존하고 기존 작업 조회로 변환만 재시도합니다. 새 생성 POST는 하지 않습니다.

```json
{"type":"part.update","id":"<project UUID>","partId":"<part UUID>","patch":{"selectedId":"<asset UUID>","locked":true}}
```

### 중단·불명확한 제출

```json
{"type":"job.cancel","id":"<project UUID>","jobId":"<job UUID>"}
{"type":"job.reconcile","id":"<project UUID>","jobId":"<job UUID>","remoteId":"task_existing"}
```

상태 의미:

- `queued`: 로컬 대기, 아직 생성 POST 없음.
- `submitting`: 입력 업로드/원격 제출 중. POST 직전 상태를 영속화합니다.
- `submission_unknown`: POST 응답 타임아웃 또는 제출 도중 앱 종료. **자동 POST 재시도 없음.** Tripo 대시보드에서 기존 ID를 확인해 연결해야 합니다.
- `running`: 원격 ID 있음. 주기적인 GET만 수행합니다.
- `paused`: 로컬 추적 중지. 원격 생성·과금 취소를 뜻하지 않습니다.
- `cancelled_local`: 원격 생성 제출 전에 취소.
- `cancelled`: 조회한 원격 API가 실제 취소 상태를 반환함.
- `success`: API 성공 및 필요한 파일 다운로드 완료.
- `failed`: 확정적인 거절·실패. 명시적인 새 승인 없이는 재시도하지 않습니다.

재시작 때 진행 중 remoteId는 유지하고 조회를 재개합니다. 원격 ID 없는 제출은 불명확, 아직 대기하던 후보는 로컬 취소로 복구합니다. 다운로드가 실패하면 remoteId를 유지하고 재조회로 다운로드만 다시 시도합니다.

## 저장 형식 v1

`Project.schemaVersion=1`. 핵심 관계:

```text
Project.selectedImageId → Asset.id
Asset.parentId         → 원본 이미지 / 이전 수정 / 보정 모델
Asset.jobId            → 생성 Job
Part.imageId           → 파츠 입력 PNG/JPEG
Part.candidates[]      → 모델 Asset IDs
Part.selectedId        → 현재 선택 후보
Assembly.parts[]       → 선택·변환·가시성 스냅샷
BuildResult.revision   → 사용한 제작 revision
UnityResult.revision   → 임포트한 revision
```

좌표는 Three.js/glTF 기준 오른손 Y-up, 미터, Euler XYZ 각도(도). Blender에서 Z-up 기저로 변환합니다. 조립 출력은 전체를 목표 키에 균일 정규화하며 상대 배치는 유지됩니다. `report.json`에 정규화 배율을 기록합니다. 후보·변환 변경 시 revision이 증가하고 예전 빌드의 Unity 전송을 막습니다. 메모/표시 변경에도 보수적으로 revision이 증가할 수 있습니다.

현재 형식은 UUID와 상대 경로를 사용합니다. SQLite가 원장이고 `project.json`은 백업 가능한 스냅샷입니다. v2 도입 시 명시적인 migration을 작성해야 하며 미지원 schemaVersion을 조용히 로드하지 않습니다.

## Unity 계약

요청: `<Unity>/Library/PartsmithInbox/<request UUID>.json`.

```json
{"schemaVersion":1,"projectId":"<UUID>","requestId":"<UUID>","source":"C:/.../character.fbx","textureDirectory":"C:/.../textures","destination":"Assets/PartsmithGenerated/<UUID>","revision":3,"resultPath":"C:/Unity/3D Tool Test/Library/PartsmithResults/<UUID>.json","humanoid":true}
```

결과: `Library/PartsmithResults/<UUID>.json`. `avatarValid`, `avatarHuman`, `playbackVerified`(Edit Mode Animator 평가), `runtimePlayModeVerified`(실제 Play Mode 검사), `runtimeClips`(진행한 상태), `runtimeMovingClips`(뼈 회전 변화가 감지된 상태), `clips`, `prefabPath`, `userPrefabPath`, `scenePath`, `warnings`, `errors`, `guid`를 반환합니다. Edit Mode 평가가 false여도 실제 Play Mode 검증이 true면 검수 가능한 완료 상태입니다. 결과 파일은 임포트 직후와 Play Mode 검사 후 두 번 갱신될 수 있으므로 계속 조회합니다.

Avatar와 클립이 있으면 자동 Play Mode 검사 후 이전 시작 씬 설정을 복원합니다. 미저장 씬이 있으면 저장하거나 버리지 않고 검사를 건너뜁니다. 캡처 PNG는 결과 JSON 옆에 저장합니다. 사용자 게임 스크립트도 일반 Play Mode 생명주기에 따라 실행될 수 있으므로 전용 테스트 프로젝트 사용을 권장합니다.

같은 프로젝트는 동일 관리 경로에 재임포트하여 `.meta`와 Prefab GUID를 유지합니다. 사용자 Prefab Variant는 처음 한 번만 생성하고 이후 덮어쓰지 않습니다. 관리 테스트 씬만 재생성하고 기존 활성 씬은 복원합니다. 결과가 `complete_review_required`여도 관절·접합부·헤어·텍스처의 육안 검수는 필요합니다.

## 후속 확장 경계

- 원격 모델 가용성 탐색/가격 API가 공개되면 `shared/catalog.ts`의 검증된 정적 목록과 null 비용을 대체합니다.
- 승인/취소/결과 조회 계약은 유지하면서 provider 어댑터를 교체할 수 있습니다.
- 자동 분할, 숨은 면 복원, 메시 표면 접합·재UV·재텍스처는 새 JobKind와 의존성 무효화 규칙을 추가해야 합니다.
- 서버·회원·결제 시스템은 포함하지 않습니다.
