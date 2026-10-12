# 사인검 전용 아이템 자동 생성기 — 설계 검토안

작성일: 2026-10-12 · 상태: **설계 검토용 / 제품 구현 전**

## 1. 목적과 경계

사용자가 말한 “이모티콘”은 문맥상 아이템 아이콘으로 해석한다. 백호툴 안에서 **아이템 20개 후보 + 실제 아이콘 생성 → 카드/목록 편집 → 검토·채택 → 규칙 검사 → Unity용 데이터 출력**을 완결한다. 초기 구성은 목·화·토·금·수 × 1~4등급이다. 공통 생성기 프레임워크, 다른 게임용 재사용, 상점·런 전체 구현은 만들지 않는다.

이번 제출은 조사와 설계다. 제품 코드, 패키지 설치, 이미지 생성, 외부 유료 API 호출, 게시를 수행하지 않았다. 이름·ID·태그·효과·수치·상한을 자동 확정하지 않는다. 아이콘 생성/검증 성공도 게임 밸런스 승인과 구분한다.

## 2. 기준 소스와 작업 위치

| 구분 | 확인 기준 |
| --- | --- |
| 백호툴 | `lala11112/studio-baekho-tools` · `integration/baekho-studio` · `5d0cb0f416184d4752ebe6667152cc74fdd0b697` |
| 사인검 기획 | `lala11112/Four-Tiger-Sword` · `codex/system-design-2026-10-07` · `fe533a25a0df81eb317059ee18708229d63320ad` |
| 확정 방향 | `docs/planning/2026-10-07-roguelike-direction.md` |
| 제안 데이터 | `docs/planning/2026-10-07-initial-content-draft.md` |
| 로컬 | PJW-PC. 백호툴 `C:/Users/a0102/Documents/codex yes/백호툴/studio-baekho-tools`, 기획 `D:/unity project/Four-Tiger-Sword-system-design` |
| 이번 산출물 | `C:/Users/a0102/Documents/Codex/2026-10-12/task-2`의 독립 문서 폴더. 기존 체크아웃·평가기 작업을 수정하지 않음 |

로컬 안내는 백호툴 `AGENTS.md`와 관련 `.agents/skills`를 읽었다. 기존 세 도구 및 다른 작업 보존, 자격증명 비노출, 이미지 결과의 실제 검증을 준수한다. AGENTS의 Notion 개발 기록은 이번 “게시 시작 금지” 지시에 따라 로컬 대기 기록으로만 남긴다. 이 작업 폴더는 별도 Git 저장소가 아니므로 설계 커밋/PR은 만들지 않았다.

[확정 방향 원문](https://github.com/lala11112/Four-Tiger-Sword/blob/fe533a25a0df81eb317059ee18708229d63320ad/docs/planning/2026-10-07-roguelike-direction.md) · [초기 초안 원문](https://github.com/lala11112/Four-Tiger-Sword/blob/fe533a25a0df81eb317059ee18708229d63320ad/docs/planning/2026-10-07-initial-content-draft.md)

## 3. 선택한 구조

**백호툴 네 번째 전용 도구 `사인검 아이템`을 추천한다.** 기존 셸에 전용 React 화면을 붙이고, 사인검 전용 데이터·생성 작업·저장·검증·출력을 분리한다. 기존 이미지 작업자 호출 방식을 참고하되 Partsmith의 3D 제작 단계나 다목적 도구 구조로 편입하지 않는다.

연결 지점은 `shared/studio.ts`, `src/StudioShell.tsx`, 전용 `src/FourTigerItems.tsx`, `shared/four-tiger-items.ts`, 전용 engine/worker와 preload/main IPC다. 현재 `StudioNativeTool = Exclude<StudioTool,"modeling">` 및 `activeTool !== "modeling"` 조건은 새 React 도구를 native로 오인하므로 `combat | hit-timing`의 명시 판별로 바꾼다. 기존 `asset://project`는 모델링 allowlist 전용이므로 사인검 manifest에 등록한 아이콘만 읽는 별도 IPC/프로토콜을 둔다. 자세한 근거는 [백호툴 구조 조사](../../../research/tool-architecture.md)에 있다.

홈/도구 카드와 `engine/studio-summary.ts`의 읽기 전용 실행·결과 목록에도 사인검 레코드를 연결한다. 요약 조회가 생성이나 저장 변경을 일으켜서는 안 된다.

저장은 `<dataRoot>/four-tiger-items/<batchId>/`로 격리한다. `draft.json`은 임시 파일 저장 후 동일 파일시스템에서 교체하고 이전 정상 snapshot을 유지한다. 동시 수정은 revision 비교로 거부하며, 생성 중 편집된 항목의 오래된 결과는 새 내용에 자동 채택하지 않는다. 실패한 저장을 성공으로 표시하지 않는다.

| 대안 | 판단 |
| --- | --- |
| 백호툴 전용 화면 + 전용 JSON/PNG 출력 | 기존 작업 흐름에 맞고 변경 범위가 작음. 추천 |
| 별도 독립 앱 | 통합 요구와 어긋나고 설정·실행 창이 늘어남. 제외 |
| Unity SO 편집기부터 구현 | 실제 아이템 SO/효과 실행기가 없어 런타임 설계까지 확장됨. 현 범위에서 제외 |

첫 버전의 데이터 후보는 지정 문서의 기존 20개를 검증된 내장 초안으로 생성한다. 버튼을 반복해 누르면 현재 편집본을 덮어쓰지 않고 새 배치를 만든다. 아이콘은 20개 각각 실제 생성하며, 카드별 효과/수치/설명 수정과 선택한 아이콘 재생성을 제공한다. 범용 자유문장→임의 게임 로직 생성기는 만들지 않는다.

## 4. 화면 흐름

`기획·규칙 확인 → 20개 초안 생성 → 아이콘 생성 → 편집·검토 → 채택 → 검사 → 내보내기`

- **첫 화면:** 기준 브랜치/SHA와 “가격·기본 규칙 확정 / 개별 효과·수치 검토 대기” 표시. 주 동작은 `20개 초안 만들기`, 이어서 `아이콘 20개 생성`. 데이터 생성 직후 모든 상태는 초안이다.
- **작업 화면:** 상단에 배치 이름, 저장 상태, 아이콘 진행률(예: 7/20), 초안/검토/채택/보류 개수. 왼쪽에 오행·등급·상태 필터. 중앙은 카드/표 전환. 오른쪽 상세 편집 패널.
- **카드/표:** 아이콘, 이름·ID, 오행, 등급, 파생 가격, 효과 한 줄, 검토 상태, 검사 결과. 빈 이미지에는 “미생성”을 표시하고 실제 생성본처럼 꾸미지 않는다.
- **상세 편집:** 이름·ID·설명, 고정 오행 하나, 등급, 효과 목록과 단위·발동 조건·지속시간·적용 폼, 태그, 아이콘 프롬프트·버전·크게 보기·재생성. 가격은 등급 변경에 따라 자동 산출하며 직접 입력하지 않는다. 원문 대비 변경점과 제안 표시를 보여준다.
- **검토/채택:** `초안 → 검토됨 → 채택` 또는 `보류`. 데이터와 아이콘 검토를 별도로 기록한다. 묶음 채택은 선택 목록과 미확정 정책을 한 화면에서 확인한 뒤 명시적으로 실행한다. 생성·검사 통과만으로 채택하지 않는다.
- **채택 후 수정:** 내용 또는 선택 아이콘이 바뀌면 해당 revision의 채택을 해제한다. 오래된 검증 결과로 새 revision을 내보내지 않는다.
- **검사/출력:** 오류를 누르면 해당 카드·필드로 이동. “기획 초안 보관”은 초안 상태와 미확정 정책을 그대로 포함하고, “채택본 Unity 데이터 출력”은 아래 조건을 모두 만족할 때만 가능하다.

도구는 PC용 백호툴 UI다. 현재 사용자의 휴대폰 상황 때문에 PC 수동 설정이나 파일 이동을 요구하지 않는다. 이 설계가 모바일 웹앱을 추가한다는 뜻은 아니다.

## 5. 전용 데이터 계약

아래 이름은 **새로 구현할 사인검 전용 설계 타입**이며 현재 Unity 클래스가 아니다.

| 객체 | 핵심 필드·의미 |
| --- | --- |
| `SainGeomItemProject` | `schemaVersion=1`, projectId, revision, 기준 두 repo SHA/문서 경로, items[20], ruleProfile, iconStyle, jobs, reviewHistory |
| `ItemDraft` | immutable candidateKey, itemId, name, description, element(`wood/fire/earth/metal/water`), grade(1..4), purchasePrice(파생), effects[], synergyTags[], iconKey, selectedIconVersion, review |
| `EffectDraft` | stat, operation, amount, unit, trigger, targetForms, durationSeconds, stackLimit, refreshPolicy, removeOnItemLoss |
| `RuleProfile` | 확정 규칙 + 제안 정책을 분리. 정책별 origin/source/status/revision/명시 채택 기록. 상한을 확정값처럼 하드코딩하지 않음 |
| `IconVersion` | 상대경로, SHA-256, 실제 폭·높이·alpha, 생성 prompt, 제공 도구/관측 model, source revision, 생성/검토 상태 |
| `GenerationJob` | jobId, candidateKey, 대상 revision, prompt hash, 상태, 결과 경로·해시, 실패 이유. 비밀값은 저장하지 않음 |
| `Review` | draft/reviewed/adopted/held, contentRevision, iconVersion, 검토 시간/메모. 문서의 확정 출처와 앱에서의 채택 이력은 별개 |

효과 종류는 20개에 필요한 7개만 지원한다: 최대 HP, 최대 SP, SP 재생/초, 일반 공격 피해, 전환 강화 스킬 피해, 회피 SP 비용, 전환 SP 비용. 피해/HP 백분율은 내부적으로 비율(`0.08`)로 저장하고 UI에서 `8%`로 표시한다. 절대량은 SP 또는 SP/초이며 비용 감소는 음수 보정값이다. 부호·단위를 명시해 “8”을 800%로 해석하지 않는다.

발동은 `whileOwned` 또는 `formSwitchSucceeded`, 적용 폼은 기본 all이다. 지속형은 durationSeconds=null, 시간형은 양수. 초안의 3초 버프·소스당 1중첩·재발동 갱신·소지 해제 시 제거는 **제안 정책**과 함께 기록한다. 지원하지 않는 새 효과는 텍스트 메모로 보존할 수 있으나 실행 가능한 채택본 출력은 막고 “효과 타입 추가 필요”를 안내한다.

설명은 구조화 효과에서 기본 문장을 만들되 편집을 허용한다. 수치 변경 뒤 설명이 오래되면 차이를 표시하고 설명 재생성 또는 검토를 요구한다. ID는 내보내기 파일명으로 직접 신뢰하지 않고 허용 문자/유일성을 검사한다. ID 변경은 5개 참조 시너지와 iconKey 연결 검사도 갱신하며 깨진 참조를 숨기지 않는다.

## 6. 20개 초안과 확정 규칙

초안 전체는 [아이템 20개 검토표](../../../research/item-drafts.md)를 따른다. 기존 제안의 `IT_WOOD_01~04`, `IT_FIRE_01~04`, `IT_EARTH_01~04`, `IT_METAL_01~04`, `IT_WATER_01~04`와 수치를 유지한다. 임의로 새로운 밸런스를 만들어 대체하지 않는다. 각 행에 별도 아이콘 모티프를 붙인다.

| 구분 | 처리 |
| --- | --- |
| 확정 | 총20개, 오행별 등급1~4 각1개; 가격20/40/80/160; 고정 오행1개; 현재 보유 동일ID 최대1; 보유 패시브; 기본 모든 폼 적용 |
| 확정 기준값 | SP100, 재생20/초, 소비 후 지연1초, 회피20, 전환10, 전환 공통 쿨타임2초; 공통 회피 성능은 변경하지 않음 |
| 제안 | 개별 이름·ID·태그·아이콘 키·효과량·3초 버프·가산 처리·현재 HP/SP 비충전·상한/하한 |
| 제안 정책의 값 | 최대SP200, 재생40/초 상한, 회피비용8/전환비용4 하한. 미확정 표시 및 별도 채택 필요 |
| 참조만 | 강화10개·시너지5조합은 기획 규모/참조 검사용. 이번 도구가 강화 생성기·시너지 편집기·게임 실행기를 만드는 것은 아님 |

20개 풀의 제약은 정상으로 안내한다. 같은 오행 아이템은 최대4개라 상점5칸을 채우지 못한다. 미보유 후보1/0개, 이미 보유한 유일한4등급 때문에 합성 결과0개 등의 상태를 검사하되 아이템을 추가하거나 중복 보유를 허용해 메우지 않는다.

중복 방지는 현재 보유 ID 기준이다. 판매·소비한 ID를 그 런에서 영구 재획득 금지하는 규칙으로 확대하지 않는다.

## 7. 아이콘 제작과 파일 전달

[아트·전달 조사](../../../research/art-and-delivery.md)의 원본 UI 색과 전통 문양을 참고한다. **회화형 퇴마 장신구, 정사각 투명 PNG, 단일 물체, 단순 실루엣**을 수정 가능한 기본안으로 둔다. 기존 승인된 아이템 아이콘이 있는 것처럼 표현하지 않는다.

- 공통 style prompt + 아이템별 모티프/재질 prompt로 각1장, 총20개. 글자·숫자·등급 프레임은 그림에 넣지 않는다. 정확한 색값은 미확정이며 오행은 색·실루엣·UI 텍스트를 함께 사용한다.
- 내장 imagegen 우선. 서로 다른 20개는 20건으로 추적한다. 최초 버전은 직렬1건씩 진행하고 완료된 파일은 즉시 보존한다. 남은 작업 취소는 대기 작업만 중단하며 진행 중 결과도 검증 후 별도 버전으로 회수한다.
- `queued → running → generated → validated → reviewed`를 구분한다. 실패·중단·결과 불명 상태를 보존하고, 재시작 시 자동 재호출하지 않는다. 누락만 재시도할 수 있고 결과가 불명확한 요청은 먼저 기존 출력을 확인한다.
- 호출 전 jobId·대상 revision·prompt hash·시작 의도를 journal에 원자 저장한다. 생성 파일을 임시 작업 위치로 복사 → PNG/alpha/해시 검사 → 새 icon version 확정 → manifest와 job 완료 상태 저장 순서로 연결한다. 중간 종료 때 실제 파일과 journal을 대조하고 수집 가능한 결과부터 복구하며 다시 생성하지 않는다.
- 작업자는 반환된 실제 생성 경로를 확인한 뒤 전용 프로젝트로 복사한다. `$CODEX_HOME/generated_images/...`만 가리키는 미리보기 링크를 납품으로 취급하지 않는다. 관련 run 산출물만 허용하고 임의 파일 경로를 읽는 결과는 거부한다.
- 새 경로 예: `icons/<candidateKey>/v001/source.png`, `icon-256.png`; 생성된 파일의 원본 해시/실제 크기를 기록한다. 출력 패키지에서 `icons/<validated-itemId>.png`로 매핑한다. 원본·이전 버전은 덮어쓰지 않는다.
- 알파·PNG 디코드·ID 대응·파일 존재/해시는 필수. 64/128px 가독성, 매듭끼리 실루엣 차이, 밝은/어두운 배경 경계는 검토 의견으로 남기고 자동 유료 재생성을 하지 않는다.
- 현재 도구 제공 여부와 과거 백호툴 smoke는 확인했다. **현 제품 worker에서 20개 전 과정이 성공했음을 입증한 상태는 아니다.** 첫 실제 생성에서 파일 복사까지 확인한 뒤 남은19개를 진행한다. 새 비용·키가 필요한 경로로 바뀌면 먼저 보고한다.
- 현재 로컬 CLI는 0.146.1, 과거 smoke 기록은 0.153.4여서 같은 버전의 재현 증거가 아니다. ChatGPT 로그인 상태까지만 읽기 전용으로 확인했다.

## 8. Unity 출력

지정 fe533 기획 커밋에는 사용자 게임 C#이 없고 ThirdParty C#만 있다. PJW 코드 조사에서도 아이템 타입/Importer는 확인되지 않았다. 상세 범위는 [Unity 조사](../../../research/unity-audit.md)에 기록한다. 따라서 출력은 **사인검 전용 JSON + PNG + manifest**로 정한다.

부재 근거: 지정 `fe533a25`의 추적 파일519개 중 C#19개는 모두 ThirdParty이며 `_Project`의 게임 C#은0개다. 같은 저장소의 실행 코드 참고 `PJW@e9e0d866b6786c3318b2c6ee3ad011dbac76e2ea`의 게임 C#114개를 추가 조사해도 `ItemDefinition`, 아이템 SO, 인벤토리, 아이템 JSON Importer가 없었다. 파일 목록 전수 확인과 `ItemDefinition|ItemData|Inventory|ItemEffect|ScriptedImporter|JsonUtility` 검색으로 확인했다. 수정이 많은 PJW 작업 트리는 편집하지 않고 커밋의 코드를 읽었다.

존재하는 `PlayerStatManager.AddModifier/RemoveModifier`는 아이템 소스 ID 없이 능력치 누적 합을 관리한다. `StatusEffectHandler`는 적 대상·효과 타입별 갱신이라 소지한 아이템별 적용/해제 계약과 바로 호환되지 않는다. `WeaponActionDataSO`도 공격 동작 데이터이지 아이템 정의가 아니다. [능력치 코드 근거](https://github.com/lala11112/Four-Tiger-Sword/blob/e9e0d866b6786c3318b2c6ee3ad011dbac76e2ea/Four-Tiger-Sword/Assets/_Project/Scripts/Manager/PlayerStatManager.cs#L87) · [상태효과 코드 근거](https://github.com/lala11112/Four-Tiger-Sword/blob/e9e0d866b6786c3318b2c6ee3ad011dbac76e2ea/Four-Tiger-Sword/Assets/_Project/Scripts/StatusEffect/StatusEffectHandler.cs#L20).

후속 게임 통합에는 대상 실행 브랜치를 지정하고 **신규 아이템 catalog/소비자, 소지 목록, 소스별 효과 적용·해제, 일반/전환 피해 구분, SP 비용·버프 계산, 저장 복구 및 Unity Importer**를 구현해야 한다. 이 생성기의 JSON·PNG를 출력하거나 Unity 프로젝트에 반입하는 것만으로 이 효과들이 연결되지는 않는다. 해당 런타임 작업은 이번 설계·문서 전달 범위에 포함하지 않는다.

참고 PJW의 금 enum은 `ELEMENT_GOLD`이지만 출력은 문서의 `metal` 문자열로 고정하고 향후 소비자에서 명시 매핑한다. enum 정수나 기존 SP/STM·상태효과 타입에 억지로 맞추지 않는다. Unity 조사 문서의 대안 필드명·SO 제안보다 이 설계의 JSON 파일명·비율 단위(`0.08 = 8%`)·PNG 출력 계약을 우선한다.

출력 폴더는 `exports/<batchId>-r<revision>/`로 새로 만든다.

- `saingeom-items.v1.json`: schemaVersion, sourceRefs, contentRevision, 승인된 ruleProfile, 채택된 items 배열. JSON object/array/기본값만 사용해 향후 Unity 직렬화 DTO에서 읽기 쉽게 한다.
- `icons/<itemId>.png`: 선택·검증된256px 파일. `iconPath`는 패키지 내부 상대경로다.
- `manifest.json`: 모든 파일 해시, ID→iconPath, 규칙·콘텐츠 revision, 생성/검토 출처. 로컬 사용자명·절대경로는 넣지 않는다.
- `validation-report.json`, `README.md`: 검사 결과, 채택 상태, Unity 반입 방법과 런타임 미연결 사실.
- 초안 보관 출력은 별도 `review-bundle/`에 저장하며 `contentStatus=draft`와 제안 정책을 유지한다. 채택본처럼 이름 붙이지 않는다.

Unity는 JSON을 TextAsset으로, PNG를 Texture로 반입할 수 있지만 Sprite 설정과 실제 소비 코드가 필요하다. **.asset/SO, GUID 또는 .meta를 임의 생성하지 않는다.** 첫 버전의 완료 기준은 스키마/파일의 무결성과 Unity 에셋 반입까지이며 아이템 효과가 게임에서 작동한다는 보장은 아니다. 추후 타입을 새로 만들면 `SainGeomItemCatalogDto` 같은 전용 DTO/Importer 계약을 추가해야 한다.

채택본 출력 조건: 선택 항목의 현재 데이터·아이콘 revision 채택, 확정 규칙 오류0, 선택한 제안 정책의 명시 채택, 깨진 참조0, 파일 해시 일치. 첫20개 세트 출력에는5×4 완전성도 필요하다. 일부만 검토된 상태는 초안 묶음으로 저장 가능하다. 출력은 먼저 임시 새 폴더에 쓰고 전부 검증한 뒤 완성 폴더로 전환하며 경로 충돌 시 새 버전을 사용한다. 기존 Unity Assets에 자동 복사/덮어쓰지 않는다.

## 9. 구현 시 검증과 수용 기준

| 검증 | 기대 결과 |
| --- | --- |
| 원문 초안 import | ID20개 유일,5×4 각1개, 모든 이름·효과값 원문 일치, 전부 draft |
| 확정 규칙 | 가격 유도, 잘못된 오행/등급/필수값/중복ID 차단; 쿨타임·회피 성능 변경 효과 차단 |
| 제안 분리 | cap200/40, floor8/4 등이 확정으로 표시되지 않음; 채택 이력 없는 정책은 release 출력 불가 |
| SP 산술 프리뷰 | 아이템20개만: 최대SP145, 재생30, 회피15, 전환6; 목4 버프 재생38, 토4 버프 회피11. “초안 산술/플레이테스트 아님” 표시 |
| 편집/채택 | 수정 revision에 이전 채택을 재사용하지 않음; ID 변경 시 참조 검사; %/SP 단위 왕복 보존 |
| 작업 복구 | 7/20 완료 후 취소/종료해도7개와 수정본 유지, 재실행 자동 생성 없음; 모호한 결과 중복 호출 없음 |
| 이미지 | 20개 distinct job/파일, 잘못된 PNG·불투명 배경·경로 탈출·다른 ID 매핑 거부; 64px 수동 시각 검토 |
| 출력 | 입력과 JSON round-trip 일치, 유니코드 이름·효과·상태 보존, 모든 manifest 해시 검증, 기존 파일0개 변경 |
| Unity | 빈 검증 프로젝트에서 JSON/PNG 반입 확인; 게임 런타임 효과 테스트로 보고하지 않음 |
| 회귀 | modeling/combat/hit-timing 세 도구 진입·기존 데이터 보존, 사인검 상태/단축키/스타일 격리 |

검증은 데이터·출력·작업 복구를 중심으로 의미 있는 자동 테스트를 쓰고, UI 편집→저장→재실행→채택→출력 한 경로를 smoke로 확인한다. 생성 mock은 파일/상태 테스트용이며 실제 생성 성공 증거로 쓰지 않는다. 이번 설계 단계에는 제품 테스트와 Unity 실행을 수행하지 않았다.

## 10. 별도 범위와 묶음 검토 항목

- 전투 도구의 E 스킬/R 궁극기와 새 기획의 숫자1~5 전환/E 상호작용 불일치는 별도 전투 도구 작업이다. 아이템 효과 필드에 E/R을 넣어 충돌을 전파하지 않는다.
- 상점·합성·런·보유 효과 실행, 강화10종/시너지5종 생성 UI, 신규 외부 유료 API 연동, 모바일 버전은 이번 범위 밖이다.
- 설계 승인 후 구현자는 현재 대상 branch/HEAD/status를 다시 확인하고 전용 작업 위치를 확보한다. 이 조사 중 다른 에이전트가 작업한 체크아웃을 reset/checkout하지 않는다.

부모에게 전달할 **기획 불확실성은 두 묶음**이다.

1. 20개 이름·효과·수치 및 cap/가산/3초 갱신 정책은 기존 초안을 카드에서 한 번에 검토·수정·채택하는 방식으로 유지한다. 지금 전체를 확정하도록 요구하지 않는다.
2. 아이콘은 확인된 옛 UI의 오행 색과 전통 문양을 참고한 위 회화형 장신구 방향을 초안으로 삼는다. 현재 확정된 아이템 아트 규격은 없으므로 첫 실제 결과를 검토 가능하게 보여준다.

데이터 출력 형식은 조사 결과 JSON/PNG를 선택했으므로 기술 선택을 다시 사용자에게 묻지 않는다. 향후 실제 게임 적용까지 원하면 새 런타임 타입·효과 실행기·Importer 범위가 추가된다는 점만 분명히 한다. 지금 필요한 협조는 이 설계의 검토이며 PC 수동 조작, 키 전달, 결제가 아니다.

