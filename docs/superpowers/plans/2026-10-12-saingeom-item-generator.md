# 사인검 아이템 제작 도구 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 백호툴에서 사인검 아이템 초안20개와 실제 아이콘을 만들고, 편집·검토·채택한 데이터를 Unity용 JSON/PNG 묶음으로 출력한다.

**Architecture:** 기존 Electron/React 셸에 `four-tiger-items` 전용 화면과 파일 저장 서비스를 추가한다. 기존 `CodexWorker`는 사인검 아이콘 호출 어댑터에서만 사용하고, 데이터·검토·작업 복구·출력은 이 도구 안에서 처리한다. Unity 게임의 아이템 효과 실행기는 만들지 않는다.

**Tech Stack:** 기존 React19.2, TypeScript5.9, Electron44.7, Zod4.1, pngjs7, Node test/tsx, Playwright, 설치된 Unity6000.3.10f1. 의존성 추가·업그레이드 없음.

**Spec:** `docs/superpowers/specs/2026-10-12-saingeom-item-generator-design.md` 및 `research/item-drafts.md`. 휴대폰 전달본은 Library의 `사인검_아이템_생성기_설계안.md`와 `사인검_아이템_20개_초안표.md`다. 구현자는 이 계획과 두 문서를 함께 읽는다.

상태: **설계 승인 후 구현 계획 검토용. 제품 코드·패키지 설치·아이콘 생성 전.** 사용자의 “제작 도구부터 진행해줘”를 반영했다. 이번 문서는 실제 이미지나 완성된 기능의 증거가 아니다.

검토할 핵심은 6단계 실행 순서, 기존 내장 imagegen을 이용한 실제20개 생성, 미채택 콘텐츠는 초안으로만 출력한다는 점이다. 새 기획 결정은 추가하지 않았다. 남은 선택은 실행 방식이며 **Native 순차 구현 + 마지막 독립 리뷰**를 추천한다. 아래 상세 계약은 구현자가 그대로 따라갈 수 있도록 적었다.

## Global Constraints

- 백호툴 기준: `integration/baekho-studio@5d0cb0f416184d4752ebe6667152cc74fdd0b697`.
- 사인검 기준: `codex/system-design-2026-10-07@fe533a25a0df81eb317059ee18708229d63320ad`. `main` 기획으로 대체하지 않는다.
- 확정 규칙 원문: `docs/planning/2026-10-07-roguelike-direction.md`; 제안 데이터: `docs/planning/2026-10-07-initial-content-draft.md`.
- 목·화·토·금·수 × 등급1~4 각1개, 총20개. 구매가20/40/80/160은 등급에서 계산한다. 현재 보유 동일ID 최대1개이며 영구 재획득 금지로 확대하지 않는다.
- 확정 SP 기준값100, 재생20/초, 소비 후 지연1초, 회피비용20, 전환비용10, 공통 전환 쿨타임2초. 회피 성능·쿨타임 변경 효과는 지원하지 않는다.
- 이름·ID·태그·개별 효과와 수치·3초 버프·합산/중첩 정책·상한200/40·하한8/4는 제안이다. 생성·검사 성공·도구 설계 승인을 콘텐츠 채택으로 간주하지 않는다.
- 비율은 `0.08 = 8%`, 비용 감소는 음수 SP 보정, 금 오행은 `metal` 문자열이다. 기존 Unity enum 정수로 출력하지 않는다.
- 신규 데이터는 `<dataRoot>/four-tiger-items/<projectId>/`에 저장한다. 설계의 batchId와 projectId는 같은 식별자이며 UI 이름은 “초안 묶음”이다.
- 아이콘은 내장 imagegen으로 각1장,20건을 직렬 처리한다. 기존 로그인 사용, 새 키·구독·유료 외부 API·모델 변경 없음. 새 비용/자격증명 필요 시 해당 경로를 중단하고 보고한다.
- 실제 생성 파일을 프로젝트에 복사하고 PNG·alpha·해시를 검사한다. 생성 경로 링크나 mock을 납품 이미지로 세지 않는다. 이전 이미지와 기존 에셋을 덮어쓰지 않는다.
- 출력은 JSON/PNG/manifest/검사 보고서/README다. `.asset`, SO, GUID, `.meta`를 생성하거나 실제 게임 Assets에 쓰지 않는다.
- 공통 생성기 프레임워크, 강화10종·시너지5종 제작 UI, 상점·합성·런·전투 효과 구현, 모바일 앱은 범위 밖이다. E/R 대 숫자전환/E 입력 불일치도 별도 범위다.
- 제품 구현 시작 때 최신 AGENTS.md·관련 로컬 스킬·HEAD/status를 다시 확인하고 전용 작업 위치를 확보한다. 기존 체크아웃·평가기 작업은 reset/checkout하지 않는다. 현재 계획 단계에는 worktree를 만들지 않는다.
- 테스트/실제 생성은 구현 단계에서 실행한다. 현재 문서의 예상 PASS는 실행 결과가 아니다. 외부 게시·Notion 기록은 로컬 대기 기록으로 유지한다.

## Review Focus

1. 한글·공백 경로, Windows 예약명, 대소문자 중복, `../`·절대경로·junction: 정상 이름은 보존하고 파일 경계 이탈은 거부한다. Task1/2/3/4 테스트로 고정한다.
2. 생성·채택·출력 도중 편집: 오래된 결과는 보존하되 새 revision에 선택·채택하지 않고, 출력은 한 번 읽은 검토된 snapshot만 사용한다. Task2/3/4.
3. 7/20 이후 종료·저장 실패·응답 불명: 완료본과 사용자 수정본을 보존하고 재시작 시 자동 호출하지 않는다. Task2/3.
4. PNG 확장자만 맞거나 불투명/완전 투명/중복/변조된 이미지: 실패 이유를 표시하고 생성 개수·채택본에 포함하지 않는다. Task3/4.
5. 네 번째 도구가 기존 세 도구의 화면·단축키·종료 동작을 침범하거나 요약 조회가 생성하는 경우: 명시적 native 판별, 읽기 전용 요약, 실행 중 종료 보호를 검증한다. Task5/6.

---

## 파일 지도와 실행 순서

경로는 구현용 백호툴 worktree 기준이다. 이 문서와 승인 설계·초안표는 Task1 때 해당 worktree에 함께 보관한다.

| 파일 | 책임 |
| --- | --- |
| `shared/four-tiger-items.ts` | 전용 데이터, 검증 스키마, renderer API 계약 |
| `shared/four-tiger-item-seed.ts` | 원문20개·모티프·출처·읽기 전용 시너지5개 참조 |
| `engine/four-tiger-items/domain.ts` | 파생 가격·효과 설명·규칙·산술·검토 상태 전이 |
| `engine/four-tiger-items/store.ts` | revision 비교, 원자 저장, 이전 정상본, 읽기 전용 목록 |
| `engine/four-tiger-items/icons.ts` | 직렬 큐·journal·이미지 검사/버전·복구 |
| `engine/four-tiger-items/icon-runner.ts` | 기존 CodexWorker를 호출하는 전용 어댑터 |
| `engine/four-tiger-items/export.ts` | 초안 보관/채택본 새 폴더 출력·hash manifest |
| `engine/four-tiger-items/service.ts` | 앞의 전용 모듈 조합과 API 실행 |
| `electron/four-tiger-items-ipc.ts` | 신뢰하는 renderer에서만 API 허용, 입력 검사 |
| `src/FourTigerItems.tsx`, `src/FourTigerItemEditor.tsx`, `src/four-tiger-items.css` | 목록/카드·편집·아이콘·검토·출력 UI |
| 기존 `shared/studio.ts`, `src/StudioShell.tsx`, `engine/studio-summary.ts`, `electron/studio-host.ts`, `electron/main.ts`, `electron/preload.ts` | 네 번째 도구 등록·요약·IPC·종료 연결 |
| `tests/four-tiger-items-domain.test.ts`, `tests/four-tiger-items-store.test.ts`, `tests/four-tiger-items-icons.test.ts`, `tests/four-tiger-items-export.test.ts`, `tests/four-tiger-items-ipc.test.ts` | 각 작업의 계약·실패 사례 |
| `tests/fixtures/four-tiger-items.ts` | 테스트 전용 PNG/채택 fixture. 제품 seed와 분리 |
| 기존 `tests/studio-summary.test.ts`, `scripts/studio-smoke.mjs` | 기존 셸·읽기 전용 요약 회귀 |
| `scripts/four-tiger-items-smoke.mjs`, `scripts/four-tiger-items-unity-smoke.ts`, `tests/unity/FourTigerItemPackageImportCheck.cs` | UI·실제 생성 증거·빈 Unity 프로젝트 반입 |
| `docs/four-tiger-items.md` | 사용법, 데이터 계약, Unity 경계, 실제 검증 결과 |

작업1→2→3→4→5→6 순서로 통합한다. 데이터 계약을 먼저 고정한다. 테스트가 통과한 작업별로 로컬 커밋하며 이 계획은 원격 push/PR/게시를 포함하지 않는다.

## 계약 요약

아래는 **새 TypeScript 타입**이다. 기존 게임 타입이 아니다. 상세 필드는 승인 설계5절을 따른다.

- `Element = "wood" | "fire" | "earth" | "metal" | "water"`; `Grade = 1 | 2 | 3 | 4`; `ExportKind = "draft" | "release"`.
- `SainGeomItemProject`: schemaVersion1, projectId(UUID), name, revision(저장 성공당+1), sourceRefs, createdAt/updatedAt(ISO), items, ruleProfile, iconStyle, jobs, reviewHistory, synergyReferences. 저장 스키마는 알 수 없는 필드를 묵인하지 않는다.
- `ItemDraft`: candidateKey(UUID·불변), itemId, name, description, descriptionStale, element, grade, purchasePrice(파생), effects, unsupportedEffectNotes, synergyTags, iconPrompt, iconKey(`icon.<itemId>`·파생), icons, selectedIconVersion(null|string), contentRevision, review. 화면에서 필수값을 비워 둔 수정본도 저장할 수 있으나 채택본 검사는 실패한다.
- `EffectDraft`: stat(`maxHp/maxSp/spRegen/normalDamage/switchDamage/dodgeSpCost/switchSpCost`), operation(`addRatio/add`), amount, unit(`ratio/SP/SPPerSecond`), trigger(`whileOwned/formSwitchSucceeded`), targetForms(`all` 또는 중복 없는 Element 배열), durationSeconds(null|양수), stackLimit, refreshPolicy(`refresh`), removeOnItemLoss. 유한 숫자만 허용한다. % stat은 addRatio/ratio, 나머지는 add와 해당 절대단위만 허용한다.
- `RuleProfile`: confirmed(수정 불가), proposed(`PolicyValues`), revision, adoptions(정책키→채택 revision/시각). `PolicyKey = keyof PolicyValues`. 정책값은 `maxSpCap=200`, `regenCap=40`, `minDodgeCost=8`, `minSwitchCost=4`, `stacking=additiveBySource`, `sourceStackLimit=1`, `timedRefresh=refresh`, `removeOnItemLoss=true`, `refillOnMaxIncrease=false`, `clampOnMaxDecrease=true`. cap/floor는 number, stackLimit은 literal1, 나머지는 표시한 literal 문자열/boolean이다. cap/floor는 편집 가능하다. 다른 정책 변경안은 메모로 보관하고 release를 막는다.
- `ItemReview`: state(`draft/reviewed/adopted/held`), dataRevision(null|number), iconVersion(null|string), policyRevision(null|number), note, updatedAt. data/icon 검토가 모두 현재일 때 reviewed, 명시 adopt에서만 adopted다. 검토 이력은 덮어쓰지 않는다.
- `IconVersion`: versionId, jobId, contentRevision, promptHash, sourcePath, thumbnailPath(프로젝트 상대경로), sourceSha256, thumbnailSha256, width/height, hasAlpha, prompt, tool, observedModel(null|string), createdAt. 실제 관측하지 않은 모델명을 만들지 않는다.
- `GenerationJob`: jobId, candidateKey, contentRevision, prompt/promptHash, status(`queued/running/generated/validated/reviewed/failed/interrupted/unknown/cancelled`), attempt, resultPath(null|상대경로), error(null|string), createdAt/updatedAt. 상태를 파일 존재·검증·검토와 구분한다.
- `ValidationIssue`: code, severity(`error/warning`), candidateKey(null|string), field, message. `ValidationReport`: projectId, revision, mode, issues, canExport. draft 보관은 미완성 콘텐츠를 허용하되 손상/경로 오류는 허용하지 않는다.
- `ItemPatch`: 이름/ID/설명/오행/등급/effects/메모/tags/iconPrompt만; 가격·키·revision·채택·파일경로·출처는 입력 금지. `ReviewAction = "reviewData" | "reviewIcon" | "adopt" | "hold" | "reset"`.
- `ExportReceipt`: exportId, kind, projectId, revision, directory, files(상대경로/sha256), createdAt. absolute directory는 로컬 API 응답에만 쓰고 패키지 내용에는 넣지 않는다.
- `ProjectSummary`: projectId, name, revision, updatedAt, total, validatedIcons, adopted, pendingJobs, failedJobs, exports. 생성 성공과 사용자 채택 수를 분리한다.

## Task 1: 원문20개와 규칙·검토 계약

**Files:** Create `shared/four-tiger-items.ts`, `shared/four-tiger-item-seed.ts`, `engine/four-tiger-items/domain.ts`; Test `tests/four-tiger-items-domain.test.ts`.

**Interfaces:**
- Consumes: 승인 설계와 초안표, 지정 원문2개. 런타임 네트워크 접근 없이 내장 seed로 만든다.
- Produces in domain: `createInitialProject(input: { projectId: string; name: string; now: string }): SainGeomItemProject`; `gradePrice(grade: Grade): number`; `describeEffects(effects: EffectDraft[]): string`; `validateProject(project: SainGeomItemProject, mode: ExportKind): ValidationReport`.
- Produces: `patchItem(project: SainGeomItemProject, candidateKey: string, patch: ItemPatch, now: string): SainGeomItemProject`; `reviewItem(project: SainGeomItemProject, candidateKey: string, action: ReviewAction, note: string, now: string): SainGeomItemProject`; `updatePolicies(project: SainGeomItemProject, patch: Partial<PolicyValues>, now: string): SainGeomItemProject`; `adoptPolicies(project: SainGeomItemProject, keys: PolicyKey[], now: string): SainGeomItemProject`.
- Produces: `acknowledgeDescription(project: SainGeomItemProject, candidateKey: string, regenerate: boolean, now: string): SainGeomItemProject`; `repairReferenceIds(project: SainGeomItemProject, now: string): SainGeomItemProject`; `updateIconStyle(project: SainGeomItemProject, style: string, now: string): SainGeomItemProject`; `previewSp(project: SainGeomItemProject, form: Element, timedBuffs: boolean): SpPreview`; `eligibleItemIds(project: SainGeomItemProject, ownedIds: string[], element: Element, grade?: Grade): string[]`.
- `SpPreview = { maxSp: number; regenPerSecond: number; dodgeCost: number; switchCost: number; proposal: true }`. 가격은 domain에서 파생하고 스키마에서도 일치 여부를 검사한다. project.revision 증가는 Task2 store만 담당한다. 공통 iconStyle 변경은 모든 항목의 contentRevision 증가와 채택 해제로 연결한다.

- [ ] **1. 독립 작업 위치를 확보한다.** 실행 때 using-git-worktrees를 읽고 적합한 전용 worktree를 찾아 사용하거나 확인된 integration 브랜치에서 만든다. AGENTS와 위 source SHA를 재확인하고 평가기 작업 위치에 쓰지 않는다. 설계·계획·초안표를 worktree의 같은 경로에 복사한다.
- [ ] **2. 원문에 근거한 실패 테스트를 쓴다.** 기대값20행을 seed에서 가져오지 말고 `research/item-drafts.md` 표에서 전사한다. 이름·ID·element·grade·amount·unit·trigger·duration을 전부 비교한다. 아래 assertion을 포함한다(`p`는 createInitialProject 반환값).

```ts
assert.equal(p.items.length, 20);
assert.equal(new Set(p.items.map(i => `${i.element}:${i.grade}`)).size, 20);
assert.deepEqual([1,2,3,4].map(g => gradePrice(g as Grade)), [20,40,80,160]);
assert.ok(p.items.every(i => i.review.state === 'draft' && i.selectedIconVersion === null));
assert.equal(p.items.find(i => i.itemId === 'IT_FIRE_01')!.effects[0].amount, 0.08);
assert.deepEqual(previewSp(p, 'wood', false), {maxSp:145,regenPerSecond:30,dodgeCost:15,switchCost:6,proposal:true});
assert.deepEqual(previewSp(p, 'wood', true), {maxSp:145,regenPerSecond:38,dodgeCost:11,switchCost:6,proposal:true});
assert.equal(eligibleItemIds(p, [], 'wood').length, 4);
assert.equal(eligibleItemIds(p, ['IT_WOOD_01','IT_WOOD_02','IT_WOOD_03','IT_WOOD_04'], 'wood').length, 0);
assert.equal(eligibleItemIds(p, ['IT_WOOD_04'], 'wood', 4).length, 0);
assert.equal(eligibleItemIds(p, [], 'wood', 4).length, 1); // 다시 미보유가 되면 후보 복귀
assert.equal(validateProject(p, 'release').canExport, false);
```

- [ ] **3. 경계·편집·정책 실패 테스트를 추가한다.** `../A`, `C:\\A`, `CON`, `it_fire_01`은 ID 검사 오류, 동일 대문자 ID2개도 오류로 고정한다. 문자열 이름 `새싹 부적 / 테스트`는 보존한다. 0.08↔8% 왕복, NaN/Infinity 거부, 잘못된 unit/trigger-duration 조합/빈 적용 폼/쿨타임 효과 오류를 검사한다. 효과 수정은 contentRevision+1, descriptionStale=true, adopted 해제; 설명 재생성/명시 확인 후만 data 검토 가능하다. 정책수정은 ruleProfile.revision+1과 영향받는 채택 해제, 미채택 정책은 release 오류다. ID 변경은 iconKey 재계산·시너지 `REFERENCE_STALE` 표시, `repairReferenceIds` 명시 실행 후 동일 candidateKey 대상만 새 ID로 갱신한다. 기존 ID를 다른 항목에 재할당해도 참조 대상을 바꾸지 않는다. 구현에 없는 효과 메모는 보존하면서 `UNSUPPORTED_EFFECT`로 release를 막는다.
- [ ] **4. 테스트가 실패하는지 확인한다.** `node --import tsx --test tests/four-tiger-items-domain.test.ts` → 아직 없는 모듈/함수 때문에 FAIL이어야 한다.
- [ ] **5. 위 공개 함수와 Zod 스키마를 지정 파일에 구현한다.** seed에 출처 SHA와 원문 제안값20행·별도 모티프를 기록한다. snapshot별 정책·data/icon 검토를 분리하고 가격 입력을 받지 않는다. 5개 시너지 참조는 원래ID와 immutable candidateKey 쌍을 유지한다. preview/후보 검사는 순수 산술·경고용이며 상점이나 런 상태를 만들지 않는다. 5칸보다 후보가 적은 것을 경고로 알리고 임의 보충하지 않는다.
- [ ] **6. 테스트를 통과시킨다.** 같은 명령 → 전체 PASS. 지정 원문과 seed20행의 대조 결과를 테스트 출력에 남긴다.
- [ ] **7. 해당 파일과 동반 문서만 커밋한다.** `git add shared/four-tiger-items.ts shared/four-tiger-item-seed.ts engine/four-tiger-items/domain.ts tests/four-tiger-items-domain.test.ts docs/superpowers/specs/2026-10-12-saingeom-item-generator-design.md docs/superpowers/plans/2026-10-12-saingeom-item-generator.md research/item-drafts.md` 다음 `git commit -m "feat: define SainGeom item draft and review rules"`.

## Task 2: 저장·revision 충돌·정상본 복구

**Files:** Create `engine/four-tiger-items/store.ts`; Test `tests/four-tiger-items-store.test.ts`.

**Interfaces:**
- Consumes: `SainGeomItemProject`, `ProjectSummary`, Task1 domain 함수와 스키마.
- Produces: `new FourTigerItemStore(root: string)`; `create(project: SainGeomItemProject): Promise<SainGeomItemProject>`; `read(projectId: string): Promise<SainGeomItemProject>`; `list(): Promise<ProjectSummary[]>`; `update(projectId: string, expectedRevision: number, change: (current: SainGeomItemProject) => SainGeomItemProject): Promise<SainGeomItemProject>`; `restorePrevious(projectId: string): Promise<SainGeomItemProject>`.
- `FourTigerError`의 code는 `REVISION_CONFLICT | INVALID_INPUT | IO_ERROR | CORRUPT_PROJECT | UNSUPPORTED_SCHEMA | PATH_REJECTED | REVIEW_REQUIRED | JOB_UNCERTAIN`; 사용자용 message와 재시도 가능한지 구분한다. renderer에 stack/환경변수를 반환하지 않는다.

- [ ] **1. 저장 계약 실패 테스트를 쓴다.** `fs.mkdtemp` 아래 `한글 묶음 with space`에 두 프로젝트를 생성한다. 저장/재읽기 deepEqual, 별도 프로젝트의 파일 불변, 같은 revision 동시 update2회 중1회만 성공, 두 번째는 `REVISION_CONFLICT`를 assert한다. 다음 assertion도 고정한다.

```ts
assert.equal(reloaded.items[0].name, '편집한 새싹 부적');
assert.equal(reloaded.revision, before.revision + 1);
assert.equal(reloaded.items[0].review.state, 'draft');
assert.deepEqual(await store.read(other.projectId), other);
assert.deepEqual(await store.list(), await store.list()); // 파일 mtime도 전후 동일
```

- [ ] **2. 실패 지점을 주입해 저장 중단 테스트를 쓴다.** test의 Node mock으로 temp write 및 최종 rename을 각각 실패시킨다. 원본 draft와 이전 정상본 중 적어도 하나가 유효하고 read/list가 실패를 성공으로 숨기지 않는지 확인한다. corrupt draft는 목록의 복구 필요 상태에 나타내며 명시 restorePrevious로만 복구한다. schemaVersion2는 읽기 오류로 보고하고 어떤 파일도 덮어쓰지 않는다. 프로젝트ID에 traversal/절대경로를 전달하면 쓰기0회인지 검사한다. 첫 버전은 한 Electron 서비스가 전용 root를 소유하며 테스트 인스턴스는 항상 별도 root를 사용한다.
- [ ] **3. 실행한다.** `node --import tsx --test tests/four-tiger-items-store.test.ts` → 저장 클래스 부재로 FAIL.
- [ ] **4. `FourTigerItemStore`를 구현한다.** UUID 식별자만 경로에 사용한다. 같은 프로젝트 update는 직렬화하고 revision을 확인한 뒤 현재본을 읽어 reducer를 적용한다. temp에 완전히 기록/flush→이전 정상 snapshot 확보→draft 교체 순서로 저장한다. 저장 성공 뒤에만 revision/updatedAt를 반환한다. 깨진 파일을 읽을 때 자동 정상본 복사/자동 생성하지 않는다. `list`의 반환은 corrupt 항목도 알려야 하므로 `ProjectSummary`에 `readError: string | null`을 추가하고 정상 항목은 null로 둔다.
- [ ] **5. 실행해 PASS를 확인한다.** Task1과 Task2 테스트를 명시 파일2개로 함께 실행한다. 오류가 난 프로젝트와 독립된 정상 프로젝트는 계속 읽을 수 있어야 한다.
- [ ] **6. 커밋한다.** `git add shared/four-tiger-items.ts engine/four-tiger-items/store.ts tests/four-tiger-items-store.test.ts` 다음 `git commit -m "feat: persist item drafts with revision recovery"`.

## Task 3: 실제 내장 이미지 작업 연결과 중단 복구

**Files:** Create `engine/four-tiger-items/icons.ts`, `engine/four-tiger-items/icon-runner.ts`, `tests/fixtures/four-tiger-items.ts`; Test `tests/four-tiger-items-icons.test.ts`. 기존 `engine/codex-worker.ts`는 우선 수정하지 않는다.

**Interfaces:**
- Consumes: Task2 `FourTigerItemStore`; 기존 `new CodexWorker(options?)`, `probe(): Promise<ProductionProbe>`, `run(task: WorkerTask): Promise<{result: unknown; threadId?: string}>`, `shutdown(): void`.
- Produces: `IconRequest = { projectId: string; candidateKey: string; jobId: string; contentRevision: number; prompt: string; promptHash: string; jobDirectory: string }`; `IconRunnerResult = { status: "generated"; relativePath: string; tool: "imagegen"; observedModel: string | null } | { status: "needs_input"; message: string }`.
- `FourTigerIconRunner`: `probe(): Promise<{available: boolean; authenticated: boolean; message: string}>`; `run(request: IconRequest, signal: AbortSignal): Promise<IconRunnerResult>`; `shutdown(): void`. 구현 클래스 `CodexFourTigerIconRunner`는 이 interface를 따른다.
- `new FourTigerIconQueue(store: FourTigerItemStore, runner: FourTigerIconRunner)`; `enqueue(projectId: string, expectedRevision: number, candidateKeys: string[]): Promise<SainGeomItemProject>`; `cancelPending(projectId: string): Promise<SainGeomItemProject>`; `reconcile(projectId: string): Promise<SainGeomItemProject>`; `selectIcon(projectId: string, expectedRevision: number, candidateKey: string, versionId: string): Promise<SainGeomItemProject>`; `readIcon(projectId: string, candidateKey: string, versionId: string): Promise<string>`(검증된256PNG data URL); `hasActiveWork(): boolean`; `shutdown(): Promise<void>`.
- test fixture: `writeTestPng(path: string, mode: "valid" | "opaque" | "empty"): Promise<void>`; pngjs로 테스트 이미지임이 명확한 단순 픽셀을 만든다. `valid`의 hash가 달라야 하는 테스트는 고유 픽셀 색을 직접 변경한다. 실제 생성 이미지로 보고하지 않는다.

- [ ] **1. mock runner로 큐·복구 실패 테스트를 쓴다.** fake의 `run` 호출수를 측정하고 최대 동시실행1을 assert한다. 7개 완료+8번째 running 상태에서 cancelPending:1~7결과 유지,9~20cancelled,8은 반환 결과를 회수한다. 재생성 호출은 새 job/version이고 기존 PNG bytes 불변이다. 재시작/reconcile의 `run` 호출수0, 명시 enqueue만 호출한다. 응답 유실+실제 output존재는 파일 회수만 하고 호출수를 늘리지 않는다. output없는 running은 unknown으로 남아 자동 enqueue를 거부한다.
- [ ] **2. revision·파일 검증 테스트를 쓴다.** 실행 중 item 이름/프롬프트 수정 후 도착한 결과는 그 job의 옛 revision 아이콘으로 보존하고 선택/채택하지 않는다. 다음 결과를 assert한다.

```ts
assert.equal(after.items[0].icons.length, 1);
assert.equal(after.items[0].selectedIconVersion, null);
assert.equal(after.items[0].review.state, 'draft');
assert.equal(fakeCalls, 1);
assert.equal(await fileHash(previousSource), previousHash);
```

유효PNG, signature불일치, 완전불투명, 완전투명, 과대파일(16MiB 초과), 한 변4096px 초과, 다른 candidateKey, 절대경로/../경로/junction 탈출, 동일hash를 다른 아이템에 재사용한 경우를 각각 검사한다. 유효하지 않은 경우 validatedIcons는 증가하지 않는다. source복사→thumbnail생성→manifest저장 각 실패 지점 후 reconcile이 버전중복 없이 기존 산출물을 회수하는지 검사한다. PNG bytes가 바뀐 뒤 readIcon은 data URL 대신 오류를 반환해야 한다.
- [ ] **3. 실행한다.** `node --import tsx --test tests/four-tiger-items-icons.test.ts` → 큐/어댑터 부재로 FAIL.
- [ ] **4. `CodexFourTigerIconRunner`를 구현한다.** 현재 `WorkerTask`는 ProductionRun/ProductionStage 필수이므로 이 파일 내부에서만 최소 envelope를 만든다. 새 image API가 있다고 가정하지 않는다. source는 이 job의 request.json과 hash, stage.kind=`generate`, workspace=jobDirectory, maxIterations1, studio/video creditLimit0, requestedModel/capability/connectionFactory 없음. 기존 워커의 숨김 프로세스·정리된 환경·ChatGPT auth를 재사용한다. `probe`는 codex.available/authenticated만 판정하며 studio/video 부재를 imagegen 부재로 오인하지 않는다. 실제 imagegen 가용성은 Task6 첫 생성으로 입증한다.
- [ ] **5. 전용 prompt와 결과 파일 계약을 구현한다.** `request.json`을 journal과 함께 호출 전에 저장한다. 작업자에게 내장 imagegen1회, transparent=true, 정사각1024px 목표, 회화형 퇴마 장신구·단일물체·10%여백·글자/등급테두리없음·오행별 색/모티프를 전달한다. 프롬프트/스타일은 사용자 수정 가능하다. 실제 반환 파일을 `outputs/source.png`로 복사한 뒤 strict JSON 결과를 남기게 한다. 사용할 수 없으면 needs_input으로 종료하며 다른 API로 넘어가지 않는다. 원본 절대경로는 runner내 복사에만 쓰고 호스트 응답/manifest에 넣지 않는다.
- [ ] **6. 큐·PNG 검증·새 버전 저장을 구현한다.** PNG signature/decode, 알파채널 및 투명/불투명 픽셀 공존, 경로realpath 경계, hash와 소유job을 확인한다. 원본은 변경하지 않고 pngjs로 비율 유지·투명 캔버스256px preview를 만든다(알파를 반영해 리샘플링). 버전명은 새 ID를 사용해 충돌시 덮어쓰지 않는다. 첫 결과가 현재 contentRevision이고 선택본이 없을 때만 선택하며 재생성은 명시 선택까지 이전본을 유지한다. 완료 저장 때 최신 프로젝트를 다시 읽어 작업결과만 합치며 사용자 편집을 덮어쓰지 않는다. 재실행에서 journal과 해당 job 폴더만 대조하고 `.codex` 전체를 검색하지 않는다. shutdown으로 결과가 불명확하면 unknown을 저장한다.
- [ ] **7. 실행해 PASS를 확인한다.** domain/store/icons 테스트3개. 여기까지 fake 테스트이므로 실제 이미지 성공으로 발표하지 않는다.
- [ ] **8. 커밋한다.** `git add engine/four-tiger-items/icons.ts engine/four-tiger-items/icon-runner.ts tests/fixtures/four-tiger-items.ts tests/four-tiger-items-icons.test.ts` 다음 `git commit -m "feat: add recoverable SainGeom icon generation"`.

## Task 4: 초안 보관과 채택본 패키지

**Files:** Create `engine/four-tiger-items/export.ts`; Extend `tests/fixtures/four-tiger-items.ts`; Test `tests/four-tiger-items-export.test.ts`.

**Interfaces:**
- Consumes: Task1 `validateProject`; Task2 store.read/update; Task3의 프로젝트상대경로·hash 계약.
- Produces: `exportItemPackage(input: { store: FourTigerItemStore; projectId: string; expectedRevision: number; kind: ExportKind; exportRoot: string }): Promise<ExportReceipt>`.
- fixture produces `createReviewedFixture(root: string): Promise<{store: FourTigerItemStore; project: SainGeomItemProject}>`: 명백한 테스트 PNG20개를 만들고 domain의 명시 review/adopt 함수로 채택한다. 제품 실행에서는 호출하지 않는다.

- [ ] **1. 출력 계약 실패 테스트를 쓴다.** fixture package를 읽어 sourceRefs/schemaVersion1/element metal/비율0.08/한글 설명/가격을 검사한다. PNG20개와 manifest의 hash를 다시 계산한다. 미검토 data, 미검토 icon, 정책미채택,5×4미완성,descriptionStale,깨진참조,unsupported메모를 각각1개씩 넣어 release가 실패하는지 assert한다. draft는 `contentStatus=draft`와 미확정 정책을 보존하고 누락 이미지 상태를 명시한다.

```ts
assert.equal(catalog.schemaVersion, 1);
assert.equal(catalog.items.length, 20);
assert.equal(catalog.items.find(i => i.itemId === 'IT_FIRE_01').effects[0].amount, 0.08);
assert.equal(catalog.items.find(i => i.itemId === 'IT_METAL_01').element, 'metal');
assert.equal(exportedPngCount, 20);
assert.ok(manifest.files.every(f => !f.path.includes('..') && !/^[A-Za-z]:/.test(f.path)));
assert.equal(existingAssetHashAfter, existingAssetHashBefore);
```

- [ ] **2. 변경·실패 테스트를 쓴다.** 출력을 시작한 뒤 사용자가 편집하더라도 출력 catalog/manifest/검사보고서가 모두 동일한 시작 revision임을 확인한다. 파일변조는 `ICON_HASH_MISMATCH`로 실패, 같은 exportRoot 재출력은 새폴더, 중간 쓰기 실패는 완성폴더 없음·원본불변을 assert한다. source/job prompt에 로컬 절대경로를 넣어도 패키지에는 출력되지 않아야 한다. manifest는 자기 자신의 hash를 포함하지 않고 나머지 모든 파일을 포함하며, manifest hash는 ExportReceipt에서 따로 제공한다.
- [ ] **3. 실행한다.** `node --import tsx --test tests/four-tiger-items-export.test.ts` → 함수부재로 FAIL.
- [ ] **4. `exportItemPackage`를 구현한다.** expectedRevision을 확인한 immutable snapshot을 사용한다. release는 current data/icon/policy adoption·규칙오류0·참조오류0·아이콘hash·5×4를 모두 확인한다. `exports/<projectId>-r<revision>-<exportId>/` 새 staging 폴더에 쓰고 전체 검사 후 완성폴더로 rename한다. draft는 `review-bundle/<projectId>-r<revision>-<exportId>/`로 구분한다. 외부파일은 복사하지 않고 검증된 프로젝트 PNG만 포함한다.
- [ ] **5. 파일 계약과 README를 작성한다.** `saingeom-items.v1.json`, `icons/<validated-itemId>.png`(256px), `manifest.json`, `validation-report.json`, `README.md`. catalog는 JSON object/array/기본형만 사용한다. manifest에는 itemId→iconPath, source/content/policy revisions, 생성도구/검토시각을 담되 절대경로·로컬사용자명·환경/키·rawworker로그는 빼고 필요한 필드만 명시 선택한다. README에 “Unity에서 JSON/PNG 반입 가능; 아이템 런타임 적용 미연결”을 적는다. 파일명용 ID는 `[A-Z][A-Z0-9_]{0,63}` 및 Windows 예약명 제외로 검증한다.
- [ ] **6. 실행해 PASS를 확인한다.** domain/store/icons/export 테스트4개. 실제 사용자 콘텐츠 채택을 흉내 내지 않고 테스트 fixture만 release 검증에 사용한다.
- [ ] **7. 커밋한다.** `git add engine/four-tiger-items/export.ts tests/fixtures/four-tiger-items.ts tests/four-tiger-items-export.test.ts` 다음 `git commit -m "feat: export reviewed item packages without overwrites"`.

## Task 5: 네 번째 도구·편집·명시 채택·출력 UI 연결

**Files:** Create `engine/four-tiger-items/service.ts`, `electron/four-tiger-items-ipc.ts`, `src/FourTigerItems.tsx`, `src/FourTigerItemEditor.tsx`, `src/four-tiger-items.css`, `scripts/four-tiger-items-smoke.mjs`; Modify `shared/four-tiger-items.ts`, `shared/studio.ts`, `src/StudioShell.tsx`, `engine/studio-summary.ts`, `electron/studio-host.ts`, `electron/main.ts`, `electron/preload.ts`, `scripts/studio-smoke.mjs`; Test `tests/four-tiger-items-ipc.test.ts`, `tests/studio-summary.test.ts`.

**Interfaces:**
- Consumes: Task1–4 public interfaces. 새 범용 명령 기반은 만들지 않는다.
- Produces: `FourTigerItemsApi`, `Window.fourTigerItems`. 아래 인자는 한 object로 IPC에 전달한다. `projectId/expectedRevision`이 필요한 변경에서는 생략할 수 없다.
  - `list(): Promise<ProjectSummary[]>`; `create(input: {name: string}): Promise<SainGeomItemProject>`; `read(input: {projectId: string}): Promise<SainGeomItemProject>`.
  - `patchItem(input: {projectId: string; expectedRevision: number; candidateKey: string; patch: ItemPatch}): Promise<SainGeomItemProject>`.
  - `reviewItems(input: {projectId: string; expectedRevision: number; candidateKeys: string[]; action: ReviewAction; note: string}): Promise<SainGeomItemProject>`.
  - `updatePolicies(input: {projectId: string; expectedRevision: number; patch: Partial<PolicyValues>}): Promise<SainGeomItemProject>`; `adoptPolicies(input: {projectId: string; expectedRevision: number; keys: PolicyKey[]}): Promise<SainGeomItemProject>`.
  - `acknowledgeDescription(input: {projectId: string; expectedRevision: number; candidateKey: string; regenerate: boolean}): Promise<SainGeomItemProject>`; `repairReferenceIds(input: {projectId: string; expectedRevision: number}): Promise<SainGeomItemProject>`.
  - `updateIconStyle(input: {projectId: string; expectedRevision: number; style: string}): Promise<SainGeomItemProject>`.
  - `generateIcons(input: {projectId: string; expectedRevision: number; candidateKeys: string[]}): Promise<SainGeomItemProject>`; `cancelPending(input: {projectId: string}): Promise<SainGeomItemProject>`; `reconcile(input: {projectId: string}): Promise<SainGeomItemProject>`.
  - `selectIcon(input: {projectId: string; expectedRevision: number; candidateKey: string; versionId: string}): Promise<SainGeomItemProject>`; `readIcon(input: {projectId: string; candidateKey: string; versionId: string}): Promise<string>`.
  - `validate(input: {projectId: string; mode: ExportKind}): Promise<ValidationReport>`; `exportPackage(input: {projectId: string; expectedRevision: number; kind: ExportKind}): Promise<ExportReceipt>`; `probe(): Promise<{available: boolean; authenticated: boolean; message: string}>`; `restorePrevious(input: {projectId: string}): Promise<SainGeomItemProject>`.
- `new FourTigerItemsService(root: string, runner: FourTigerIconRunner)` implements FourTigerItemsApi plus `hasActiveWork(): boolean`, `shutdown(): Promise<void>`. 서비스가 UUID/now를 정하며 exportRoot는 trusted main의 dataRoot 아래로만 정한다.
- `installFourTigerItemsIpc(window: BrowserWindow, service: FourTigerItemsService): () => void`(dispose). 채널은 `four-tiger-items:<method>` 고정 allowlist다.
- `SummaryInput.itemProjects?: ProjectSummary[]`, `StudioSummary.storage.fourTigerItems: string`. `installStudioHost` options에 `itemProjects: () => Promise<ProjectSummary[]>`, `itemsBusy: () => boolean`를 추가한다. 새 목록의 집계는 기존 buildStudioSummary에서만 수행한다.

- [ ] **1. IPC/summary 실패 테스트를 쓴다.** trusted sender가 아닌 webContents/subframe 요청, 임의 method, 알 수 없는 필드, 과대payload, 임의 파일경로는 서비스 호출0회로 거부한다. summary2회가 list 외 생성·저장 함수를 호출하지 않는지 확인한다. validatedIcons7/adopted0는 생성진행7·채택0으로 표기하고 결과 성공20으로 표시하지 않는다. corrupt project1개가 정상 목록을 숨기지 않아야 한다.
- [ ] **2. UI smoke를 쓴다.** 별도 BAEKHO_DATA와 fake runner 전용 테스트 주입으로 `20개 초안 만들기`→20카드·모두초안→8%편집/가격파생→아이콘진행→재시작복원→data/icon검토→정책검토→선택항목채택→draft출력 흐름을 assertion으로 고정한다. 생성만으로 “채택20”이 되지 않으며 충돌 시 입력중 편집 버퍼가 유지되는지 검사한다. 전체 release흐름은 명확한 fixture 배치로 검증한다. 테스트 주입은 production 빌드에서 받을 수 없는 CLI/env 조건으로 제한한다.
- [ ] **3. 실행한다.** `node --import tsx --test tests/four-tiger-items-ipc.test.ts tests/studio-summary.test.ts` 및 `node scripts/four-tiger-items-smoke.mjs --mode fixture` → 새 API/화면 부재로 FAIL. 기존앱을 닫으라는 사용자 조작 요청 없이 테스트 인스턴스를 분리한다.
- [ ] **4. service/IPC/preload/main을 연결한다.** 명시 schema로 입력검사하고 대상 main frame만 허용한다. preload API를 freeze한다. readIcon은 manifest등록된256PNG data URL만 반환하며 renderer가 원시경로를 보내는 기능은 없다. 기존 `asset://project` allowlist를 확장하지 않는다. 앱 종료 경고에 itemsBusy를 포함하고 main before-quit에서 item queue.shutdown과 기존 host.shutdown을 기다린다. 생성중 종료/불명 상태를 성공으로 표시하지 않는다.
- [ ] **5. `StudioShell`과 summary를 연결한다.** StudioTool에 `four-tiger-items`, StudioNativeTool은 명시 `combat | hit-timing`으로 고친다. 기존 `activeTool !== "modeling"` 같은 native 가정을 찾아 두 native만 통과시킨다. 사인검 React 화면은 modeling처럼 mounted 상태를 유지하되 비활성 화면의 입력/단축키는 처리하지 않는다. 홈 프로젝트/실행/결과/저장위치에 읽기 전용 사인검 요약을 추가하고 클릭하면 해당 묶음/항목으로 이동한다. CSS는 `.four-tiger-items` 아래로 제한한다.
- [ ] **6. 화면을 구현한다.** 초기 규칙·출처와 새묶음, 오행/등급/상태필터·카드/표·우측편집기, 저장/충돌표시, data/icon별 검토·보류·채택을 만든다. 에러의 candidateKey/field로 이동하고 제안 산술과 원문변경점을 표시한다. 효과수정 후 설명확인, ID변경 후 참조갱신은 별도 명시 동작이다. 묶음채택은 선택 항목/정책을 보여준 확인 화면을 통과한다. 아이콘64/128/256 미리보기·어두운/밝은 배경·프롬프트/버전선택·재생성·남은작업취소·결과복구·누락재시도를 제공한다. readonly가격과 “미생성/결과 확인 필요/초안/검토됨/채택/보류”를 구분한다. 실행중에는1초마다 read로 진행만 읽고 비활성/idle이면 중단한다. incomplete release 버튼에는 막힌 이유와 draft보관 경로를 제시한다.
- [ ] **7. 실행해 PASS를 확인한다.** 위 unit/UI명령, `npm run build`, `npm run test:integration`. 기존3도구 왕복 후 편집상태·독립단축키·native visibility·저장데이터hash 불변, 아이콘진행중 종료경고를 smoke assertion으로 검증한다.
- [ ] **8. 커밋한다.** 이 Task의 Files에 명시한 파일만 `git add`한 뒤 `git commit -m "feat: integrate SainGeom item authoring in Baekho Studio"`. 공용 파일의 다른 작업 변경이 섞였으면 해당 변경을 포함하지 않는다.

## Task 6: 실제20개 생성·Unity 반입·최종 인계

**Files:** Extend `scripts/four-tiger-items-smoke.mjs`; Create `scripts/four-tiger-items-unity-smoke.ts`, `tests/unity/FourTigerItemPackageImportCheck.cs`, `docs/four-tiger-items.md`. 실제이미지·로그·테스트프로젝트는 별도 artifact/data 폴더에 두고 제품 source에 대량 커밋하지 않는다.

**Interfaces:**
- Consumes: Task5 API와 Task4 패키지/manifest. `--mode fixture`는 fake만, `--mode live --count 1`과 `--mode live --project <id> --count 19`는 실제 worker만 실행한다. 같은 live manifest를 이어쓰며 이미 완료/불명인 job은 새 요청에서 제외한다.
- Produces: `scripts/four-tiger-items-unity-smoke.ts --unity <exe> --package <exportDir> --project <freshTempDir>`; test-only C# 진입점 `public static void FourTigerItemPackageImportCheck.Run()`; `unity-import-report.json = { jsonImported: boolean; textureCount: number; spriteCount: number; errors: string[] }`.
- Completion artifacts: 실제 초안20+선택아이콘20+draft보관묶음,64px/128pxcontact sheet,생성/검사보고서, 테스트결과와 제한사항. 사용자 채택 없는 콘텐츠는 release로 납품하지 않는다.

- [ ] **1. 실제 생성 전 회귀 기준을 통과시킨다.** `npm test`, `npm run test:combat`, `npm run test:hit-timer`, `npm run build`, `npm run test:integration`, `node scripts/four-tiger-items-smoke.mjs --mode fixture`. 기존 사유의 실패는 새 실패와 구분해 증거를 남기며 새 실패를 무시하지 않는다. 이 시점까지 imagegen 실제호출은0회다.
- [ ] **2. live smoke 기록 계약을 먼저 검증한다.** fixture 실행 결과에서 run별 jobId/candidateKey/revision/promptHash/PNGhash/실제크기/투명성/결과경로를 기록하고, mockProvider=true이면 “실제생성20개” 결과를 낼 수 없도록 assertion을 추가한다. `node scripts/four-tiger-items-smoke.mjs --mode fixture` → live검증이 없는 상태는 FAIL로 만든 뒤 해당 기록코드를 구현해 PASS시킨다.
- [ ] **3. 실제1장을 생성·복사·검증한다.** `node scripts/four-tiger-items-smoke.mjs --mode live --count 1`로 새 사인검 묶음의 첫아이템만 실행한다. imagegen에서 반환된 실제파일, worker복사본, 프로젝트원본의hash일치와256thumbnail·alpha검증까지 확인한다. CLI/login/tool제한으로 실패하면 정확한 가용성/실패단계만 보고하고 모사이미지나 새API로 채우지 않는다. 첫결과를64/128px와 두 배경에서 시각 확인해 모티프·실루엣·배경/글자 여부를 기록한다. 미학 판단은 검토의견이며 자동사용자채택이 아니다.
- [ ] **4. 남은19개를 만든다.** `node scripts/four-tiger-items-smoke.mjs --mode live --project <첫결과 projectId> --count 19`. 정상 첫경로를 재사용하고20개의distinct job/hash/파일을 확인한다. 불명요청은 먼저 reconcile하며 자동재호출하지 않는다. 실패한 항목은 실패카드로 남기고 원인과 완료수량을 보고한다. 실제 생성완료20개에 한해서 전체 contact sheet를 만든다. 각 아이콘의64px모티프 구분과alpha 가장자리 문제를 의견으로 기록하며 유료/자동반복 생성하지 않는다.
- [ ] **5. Unity 반입 smoke를 구현하고 실행한다.** 기존 `scripts/unity-smoke.ts`는 FBX production inbox용이므로 사용하지 않는다. 새 실행기는 freshTempDir이 비어있고 기존 게임경로가 아님을 확인해 임시 프로젝트를 만들고 package를 새 Assets폴더로 복사한다. C# test는 AssetDatabase.Refresh 후 JSON=TextAsset,PNG20개=Texture2D로읽힘,256×256을 검사한다. 이 임시프로젝트에서만 TextureImporter.textureType=Sprite·spriteImportMode=Single 후 재임포트하여 Sprite20개를 확인한다. Unity가 생성한 .meta는 테스트프로젝트에만 두며 패키지에는 되돌리지 않는다. C# Run은 report를 기록하고 오류가 있으면 EditorApplication.Exit(1), 없으면0으로 종료한다. 첫 failing check는PNG1개 누락 fixture로 textureCount19/errors존재, 정상fixture는20/20/errors0을 assert한다.

실행 예(별도 PowerShell 명령, 경로는 해당 실행의 실제값):

```powershell
node --import tsx scripts/four-tiger-items-unity-smoke.ts --unity 'C:\Program Files\Unity\Hub\Editor\6000.3.10f1\Editor\Unity.exe' --package '<exportDir>' --project '<freshTempDir>'
```

Unity subprocess는 shell없이 숨김창으로 `-batchmode -nographics -projectPath <freshTempDir> -executeMethod FourTigerItemPackageImportCheck.Run -logFile <log>`를 전달한다. CLI runner가 새프로젝트 생성단계와 import단계를 구분해 exit/report를 검사한다. 라이선스/실행제약이면 게임코드를 추가하거나 사용자의PC조작을 요구하지 않고 blocker로 기록한다. 검증은 데이터 반입이며 전투효과 실행 검증이 아니다.

- [ ] **6. 실제초안보관 출력과 사용법을 마무리한다.** 현재 revision을 draft로 출력하고20아이콘/hash/경로를검사한다. README/사용법에 시작→생성→편집→data/icon검토→정책채택→출력과 실패복구를 설명한다. 실제20개는 기본 draft, 모든 release 가능조건은 fixture로 입증했다는 차이를 명시한다. 런타임 아이템타입/효과 적용/Importer가 없다는 조사결과와 후속경계를 적는다.
- [ ] **7. 최종 검토·전달한다.** 독립리뷰어에게 최종diff와 실행증거를 제공하고 사용자범위·기존도구보존·파일복구·채택누락을 검토받는다. 변경/실패와 관련된 검사만 추가반복한다. 실제 결과20개, contact sheet, 보고서와 문서는 휴대폰에서 열 수 있는 Library첨부로 전달한다. 업로드 성공 전에는 전달완료로 보고하지 않는다. 실제생성 일부/Unity실패는 완성으로 숨기지 않고 완료수량과남은단계를 적는다.
- [ ] **8. 커밋한다.** `git add scripts/four-tiger-items-smoke.mjs scripts/four-tiger-items-unity-smoke.ts tests/unity/FourTigerItemPackageImportCheck.cs docs/four-tiger-items.md` 다음 `git commit -m "test: verify item generation and Unity asset import"`. 실제로 실행한 검사 결과·버전·artifact위치는 docs에 적고 민감정보는 넣지 않는다.

## 이 계획의 검토·인계 기준

설계10절까지의 요구는 Task1(초안/규칙),2(저장),3(아이콘),4(출력),5(화면),6(실제생성/반입/인계)에 대응한다. 기존코드 접점과 설치된 도구는 읽기전용으로 확인했으며 이번 단계에 제품테스트는 실행하지 않았다.

기획상 남은 값·아트는 승인설계대로 앱에서 검토할 초안이다. 지금 새로 기획 전체를 확정받을 필요는 없다. 기술 선택은 전용도구/내장이미지/JSON·PNG로 정했으며 후속 구현자는 범용화나 게임런타임 작업을 추가하지 않는다.

**추천 실행 방식: Native 순차 구현 + 마지막 독립 리뷰.** 6개 작업이 동일 데이터/revision 계약과 셸 연결을 공유하므로 인터페이스를 유지하며 한 세션에서 구현하고 끝에 전체변경을 따로 검토하는 편이 적합하다. 작업마다 별도 구현자·리뷰어를 두는 Subagent-driven도 가능하지만 컨텍스트 비용이 더 든다.

이번 인계는 계획 검토를 위한 것이다. 부모 스레드는 이 문서를 사용자에게 첨부하고 범위 확인 및 실행 방식만 묶어서 확인한 뒤, 선택한 방식으로 구현을 진행한다. PC수동조작·키전달·결제는 요청하지 않는다.
