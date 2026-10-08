# Partsmith 검증 결과

검증일: 2026-10-08, Windows. 실제 API 생성과 로컬 데모 검증을 구분합니다.

## 0.5.1 — 외형 경고의 반복 복구 중단·4방향 사진 크기와 중심 정렬

- **실제 원인:** 기존 작업에서 머리 후면 PNG는 저장됐지만 `back_view_geometry_convincing=false`라는 외형 경고를 알려지지 않은 실패로 처리해 같은 파일 검사에서 복구 3회를 소진했습니다. 파일 누락이나 새 생성 서비스 오류로 확인된 것은 아닙니다.
- **경고 처리:** 새로운 외형 검사 이름을 `visual_quality`로 통일하고 유형과 설명을 별도 보관합니다. 이미 저장된 방향별 외형 검사 이름은 제한된 호환 규칙으로 검토 경고로 표시합니다. 실패 값을 true로 바꾸지 않으며 파일·경로·해시·역할·중복·알 수 없는 실패의 차단은 유지합니다.
- **사진 정렬:** 원본과 별도로 2048×2048 PNG를 만듭니다. 같은 파츠의 정면을 기준으로 정면·후면·좌·우의 실루엣 높이와 중심을 맞추고 종횡비·좌우 방향·투명도를 보존합니다. 넓은 방향이 잘리지 않도록 해당 파츠 전체에 공통 제한을 적용합니다. 서로 다른 파츠를 같은 높이로 만드는 기능은 아닙니다. 불투명 배경·빈 이미지·정면 누락은 임의로 추정하지 않고 이유를 표시합니다.
- **재사용과 입력:** 갤러리와 Tripo 모델 입력에 같은 정렬 사본을 사용합니다. 사본에는 원본·정면·출력 해시를 기록하고 변조·프로젝트 밖 경로를 거부합니다. 저장된 사진 보기와 로컬 크기 맞추기는 작업자·이미지 생성·과금을 호출하지 않습니다. 원본 사진과 기존 버전은 보존합니다.
- **주요 파일:** `engine/separation-images.ts`, `electron/separation-preview.ts`, `engine/workbench.ts`, `engine/workbench-executor.ts`, `shared/workbench-checks.ts`, `shared/workbench.ts`, `src/AssetWorkbench.tsx`, `electron/main.ts`.
- **단위 검사:** 최종 `npm test` 146/146 통과. 정렬 폴더의 정션·출력 및 보고서 하드 링크·캐시 원본 변조를 통한 원본 덮어쓰기를 차단하는 4개 검사를 포함합니다. 외부 제작 결과는 모의 데이터이며, 기존 Blender 검사는 실제 로컬 테스트 메시의 구조에 한정합니다.
- **실제 Electron 화면 검사:** `scripts/workbench-smoke.mjs` 통과. 모의 제작 결과 12장의 실제 디코딩·2048 크기·정렬 사본 URL, 크기 맞추기 시 작업자 무호출, 사용자 채택과 단계 진입, 이전 버전과 다른 파츠 보존을 확인했습니다. 화면 오류 0개, 원격 생성·유료 요청 0회입니다.
- **실제 사진을 사용한 로컬 검사:** `scripts/separation-normalization-smoke.ts`의 5개 항목 통과. 저장돼 있던 사용자 사진 4개를 읽기 전용으로 확인하고 테스트 폴더의 복사본을 정렬했습니다. 네 사본 모두 2048×2048이며 머리 정면·후면의 실루엣 높이는 246픽셀, 중심이 일치했습니다. 원본 사진 해시와 제작실 JSON은 변경되지 않았고 작업자 호출은 0회였습니다. `artifacts/separation-normalization-smoke.json`에는 수치만 보관하며 실제 사진은 Git에서 제외합니다.
- **빌드·패키지:** TypeScript·웹·Electron 빌드, Windows 0.5.1 폴더 패키지와 별도 저장소에서 실제 EXE 실행 검사를 통과했습니다. 버전·SQLite·제작실·기존 로그인 상태 조회를 확인했습니다. 큰 웹 번들 경고는 남아 있습니다. `artifacts/workbench-package-smoke.json`.
- **실제 앱 적용:** 실행 중 제작 작업이 없는 상태에서 기존 앱을 정상 종료하고 최종 0.5.1을 열었습니다. ‘저장된 사진 보기’로 4/12장과 후면 외형 경고를 복구해 표시했습니다. 네 사진에 2048×2048 사본이 등록됐고 원본·사본 해시가 모두 일치합니다. 상태는 누락 사진이 남은 `needs_input`이며 새 생성·결과 채택·단계 진입은 실행하지 않았습니다.

현재 저장된 사진은 12장 중 4장(머리 정면·후면, 머리카락 정면, 몸통 정면)입니다. 나머지 8장의 생성과 방향별 외형 검토는 남아 있습니다. 후면의 외형 경고를 없애거나 품질 통과로 바꾸지 않습니다. 이번 수정의 새 이미지 생성·Tripo 유료 요청은 0회이며 사용자 캐릭터의 실제 Studio→Astra→Unity 종단 품질은 미검증입니다.

## 0.5.0 — 파츠 4방향·한 결과 수정·기존 모델 Mesh Edit

- **요구와 수정:** 첫 컨셉 이미지만 네 후보를 유지합니다. 머리·머리카락·몸통은 각각 정면·후면·좌·우 4방향, 총 12장을 검토한 뒤 파츠 모델을 한 개씩 생성합니다. 분리 사진의 특정 파츠·방향만 프롬프트로 수정하거나 누락된 방향만 채웁니다. 모델·UV/텍스처 등 후속 공정의 후보 수 선택을 없애고 이전 버전을 보존합니다. 다음 단계는 사용자가 실행합니다.
- **모델 리롤:** 새 Generate 대신 기존 Tripo Studio 모델의 Mesh Edit를 사용합니다. 전체 영역 또는 사용자가 지정한 부분 영역을 선택하고 Retry Selection/Regenerate를 실행하도록 연결했습니다. 기존 모델의 폴리곤 설정과 원본 버전을 보존합니다. 무료 횟수와 크레딧 가격을 구분하며 실제 무료 표시/0크레딧·남은 횟수 또는 명시된 유료 가격이 없으면 멈춥니다. 무료 수정도 제출 전 호스트 기록과 단회 실행 제한을 적용합니다. 불명확한 제출·복구에서 새 제출과 새 모델 생성 대체를 차단합니다.
- **서비스 경계:** 공식 P2 문서에는 선택 상자와 Retry Selection이 설명돼 있지만 Mesh Edit의 자유 텍스트 프롬프트 지원은 확인되지 않았습니다. 실제 화면이 수정 지시를 지원하지 않으면 지원되지 않는다고 알리고 멈춥니다. 앱이 프롬프트에 따른 형태 변경을 보장하지 않습니다. 계정별 횟수·가격을 코드에 고정하지 않습니다. 근거: `docs/API-SOURCES.md`.
- **입력·이력 보존:** 한 방향 수정 시 다른 11장과 원본 SHA를 보존합니다. 새 결과 채택 전 기존 선택을 유지하고 채택 후에도 입력이 변하지 않은 다른 파츠 모델은 유지합니다. 기존 정면 사진만 있는 작업은 읽거나 누락 방향을 채울 수 있고, 기존 모델이 있으면 4방향 이미지를 새로 생성하지 않고 Mesh Edit할 수 있습니다.
- **미리보기 오류 원인:** 검증 스크린샷에서 수정 후 재사용한 사진이 깨져 보이는 문제를 발견했습니다. PNG와 해시는 정상이지만 261자 경로를 Electron의 파일 URL 로더가 404로 반환했습니다. 등록 파일·실제 경로 검사를 유지하면서 Node 파일 스트림으로 제공하도록 수정하고 긴 경로의 12장 디코딩을 화면 검사에 추가했습니다.
- **주요 파일:** `shared/workbench.ts`, `engine/workbench.ts`, `engine/workbench-executor.ts`, `engine/codex-worker.ts`, `src/AssetWorkbench.tsx`, `src/TripoStudio.tsx`, `src/App.tsx`, `electron/studio-browser.ts`, `electron/studio-policy.ts`. 현재 요구를 `AGENTS.md`와 `README.md`에 반영했습니다.
- **단위·회귀 검사:** `npm test` **123/123 통과**. 이후 무료 횟수만으로 가격을 추정하지 않도록 강화한 Studio 정책 검사 **8/8 재통과**. 외부 생성은 모의 작업자·파일·영수증이며 실제 Blender 검사는 테스트 메시의 구조·뼈·웨이트·키프레임에 한정합니다.
- **Studio 로컬 브라우저 검사:** 실제 Electron과 오프라인 테스트 페이지에서 캔버스 영역 드래그, 오래되거나 가려지거나 사라진 요소 거부, 무료 수정 단회 기록, 횟수 소진·불명 가격·중복·복구 제출·새 Generate 차단을 확인했습니다. `artifacts/studio-browser-smoke.json`. 실제 Studio 계정과 모델은 사용하지 않았습니다.
- **실제 Electron + 모의 제작 결과:** `node scripts/workbench-smoke.mjs` 통과. 처음 실행은 Windows 스크린샷 캡처 대기로 종료돼 같은 명령 재실행이 통과했습니다. 이어 시각 검토에서 위 긴 경로 미리보기 문제를 발견해 실제 이미지 디코딩 검사를 추가했고 수정 후 재통과했습니다. 초기 네 후보, 첫 부분 사진 2장과 완성 12장, 한 방향 수정 후 11장 보존과 긴 경로의 12장 표시, 기존 모델 부분 재생성 요청, 다른 파츠 선택 보존·단계별 채택·이전 버전 복원·리깅 토글을 검증했습니다. renderer 오류 0개, 외부 생성·유료 요청 0회. `artifacts/workbench-smoke.json`과 합성 이미지 스크린샷.
- **빌드·패키지:** 최종 TypeScript·Vite·Electron 빌드와 Windows 폴더 패키징 통과. `release/0.5.0/win-unpacked/Partsmith.exe`를 별도 테스트 저장소에서 실행해 버전·SQLite·제작실·Codex 로그인 조회를 확인했습니다. 패키지 내부 MCP의 실제 초기화·도구 목록·상태 조회도 오프라인 Studio 브라우저 테스트와 함께 8항목 통과했습니다. `artifacts/workbench-package-smoke.json`, `artifacts/studio-browser-smoke-packaged.json`. 이 검사는 원격 생성·추론 요청 0회이며, Vite의 큰 번들 크기 경고는 남아 있습니다.

실제 사용자 몸통 이미지와 새 4방향 이미지는 이번 작업에서 생성하지 않았습니다. 사용자 저장소와 실행 중인 기존 앱은 변경하지 않았습니다. 실제 계정 화면 검증은 Windows 컴퓨터 제어가 현재 브라우저 URL을 확실하게 판별하지 못해 중단됐으며, 이후 해당 제어를 재시도하지 않았습니다. 실제 Tripo Mesh Edit부터 Astra·Unity까지의 사용자 캐릭터 종단 품질은 미검증입니다. 아래 기록은 각 버전 당시의 결과입니다.

## 0.4.2 — 분리 사진 검토를 막던 외형 검사 수정·기존 사진 복구

- **실제 원인:** 머리·머리카락 PNG는 저장돼 있었지만 원본과 정확히 같은 위치·크기, 완벽한 투명 경계 같은 외형 검사가 파일 오류처럼 처리됐습니다. 머리카락 정렬 실패로 자동 복구 3회를 소진했고 몸통은 시작하지 못했습니다. 전체 완료 전에는 이미 생성된 사진도 보이지 않았습니다.
- **수정:** 분리 단계의 명시된 외형 검사만 검토 경고로 표시하고 원래 실패 값은 보존합니다. 알 수 없는 실패, 경로·해시·파일·역할·중복 검사는 계속 차단합니다. 먼저 검증된 파츠 사진을 즉시 표시하며 세 파츠가 모두 준비되고 사용자가 채택해야 모델링으로 진행합니다.
- **기존 결과 확인:** 중단된 분리 작업의 `저장된 사진 보기`는 등록된 결과 파일과 체크포인트만 검사합니다. 작업자·Blender·새 이미지 생성은 호출하지 않습니다. 사용자가 이어서 실행하면 기존 완료 파츠를 재사용하고 아직 시작하지 않은 파츠만 원래 승인 범위에서 처리합니다. 취소·재시작 이후 자동 실행하지 않습니다.
- **실제 사용자 파일:** 별도 읽기 전용 검사에서 기존 머리·머리카락 사진 2개와 정렬 경고 1개를 확인했습니다. 검사 전후 PNG·결과 JSON·제작실 JSON의 해시와 수정 시간이 같았으며 작업자 호출 0회였습니다. 이후 실제 0.4.2 앱에서 `저장된 사진 보기`를 눌러 두 사진과 몸통 누락 안내가 표시되는 것을 확인했습니다. 앱 상태에는 검토용 사진을 등록했으며 분리 결과를 채택하거나 몸통 생성을 실행하지 않았습니다. `artifacts/saved-photo-inspection.json`.
- **단위·회귀 검사:** `npm test` **101/101 통과**. 부분 사진·경고·필수 파일 오류·체크포인트 변조·취소 후 늦은 결과·저장 사진 검사 시 작업자 무호출·기존 복구 상한과 단계 선택을 포함합니다. 외부 생성은 모의 데이터이며 로컬 Blender 구조 검사는 실제 테스트 메시를 사용합니다.
- **실제 Electron + 모의 제작 결과:** `node scripts/workbench-smoke.mjs` 통과. 생성 중 부분 사진, 외형 경고 후 사용자 검토, 불완전 사진의 모델링 차단, 클릭 없는 일시 오류 복구와 기존 단계별 흐름을 확인했습니다. 첫 부분 사진 시험은 앱 조회 주기보다 짧은 모의 지연으로 놓쳤으며, 시험이 화면 확인 후 모의 작업을 해제하도록 수정해 통과했습니다. renderer 오류 0개, 외부 생성·유료 요청 0회. `artifacts/workbench-smoke.json` 및 합성 이미지 스크린샷.
- **빌드·적용:** TypeScript·Vite·Electron 빌드, Windows 폴더 패키징, `node scripts/workbench-package-smoke.mjs` 통과. 별도 저장소의 실제 EXE 버전·SQLite·기존 로그인 조회를 확인했습니다. 제작 작업이 멈춘 상태에서 기존 앱을 정상 종료하고 `release/0.4.2/win-unpacked/Partsmith.exe`를 실제 사용자 저장소로 열어 적용했습니다.

이번 수정의 신규 GPT 이미지·Tripo 유료 요청은 0회입니다. 몸통 사진 생성과 세 사진의 사용자 검토는 남아 있습니다. 실제 Studio 생성부터 Astra·Unity까지의 종단 품질을 검증한 것은 아닙니다. 아래 기록은 해당 버전 당시의 검증입니다.

## 0.4.1 — 현재 단계 자동 복구·파츠별 생성·Tripo 사진 우선

- **실제 지연 원인:** 사용자가 취소한 분리 작업을 읽기 전용으로 조사했습니다. 27분 46초 동안 작업자 시작 7회, 완료 응답 6회가 모두 추가 입력 요청이었습니다. 세 파츠를 한 후보로 반환하면서 후보당 생성 1회를 지시했고, GPT 이미지 작업에 Studio 과금 1회·Blender 변환 지시가 섞여 합성 시트와 잘못된 분리가 반복됐습니다. 현재 작업을 재시작하거나 사용자 산출물을 변경하지 않았습니다. 익명화한 집계: `artifacts/separation-retry-diagnosis.json`.
- **수정:** 머리·머리카락·몸통을 독립 이미지 호출과 체크포인트로 분리했습니다. 성공한 부위는 재사용합니다. 현재 단계의 복구 가능한 오류는 2초·5초·10초 대기 후 최대 3회 처리하며 실제 직전 오류와 저장된 파일을 전달합니다. UI에 복구 횟수·이유·대기 시간을 표시합니다. 결과 채택과 다음 단계 실행은 사용자가 합니다.
- **중복 생성 방지:** 하위 작업 시작 전 호스트 실행 기록을 저장합니다. 시작한 작업의 복구에서는 내장 이미지 생성 기능과 Studio 신규 과금 제출을 차단합니다. 확정된 기존 Studio 결과만 재확인·다운로드하며 불명확한 제출·로그인·CAPTCHA·추가 생성이 필요한 경우는 멈춥니다. 취소·종료 후 자동 재시작하지 않습니다. 아직 시작하지 않은 하위 작업은 원래 승인 범위 안에서만 진행합니다.
- **파츠 모델 미리보기:** 작업자에게 후보별 실제 Tripo 화면 사진을 저장하도록 지시하고 앱은 사진부터 표시합니다. 필요할 때 3D 보기로 전환합니다. 호환 GLB는 그대로 사용하고 FBX·압축 GLB 등 변환이 필요할 때만 Blender를 사용합니다. 실제 Studio 후보 화면 획득은 이번에 유료 실행으로 검증하지 않았습니다.
- **단위·회귀 검사:** `npm test` **89/89 통과**. 동일 작업·입력·승인 유지, 복구 상한, 취소·종료·늦은 응답, 불명확한 제출 차단, 완료 파츠 재사용, 잘못된 JSON·실패 체크포인트·수정 도중 실패 복구, 복구 작업자의 이미지 생성 차단·Studio 신규 과금 차단을 포함합니다. 외부 작업자·영수증은 모의 데이터이며, Blender 구조 검사만 실제 로컬 실행입니다.
- **실제 Electron + 모의 제작 결과:** `scripts/workbench-smoke.mjs` 통과. 클릭 없는 자동 복구, 완료 후 사용자 채택, 사진 우선 모델 후보와 3D 전환, 기존 선택·버전 복원·리깅 토글·동시점 멀티뷰·재시작 무실행을 확인했습니다. 첫 실행은 검증 스크린샷 저장 중 Windows 파일 열기 오류로 종료됐으며, 코드 변경 없는 재실행이 끝까지 통과했습니다. 최종 renderer 오류 0개, 외부 생성 0회. `artifacts/workbench-smoke.json`, `artifacts/screenshots/workbench-auto-recovery.png`, `artifacts/screenshots/workbench-model-photo-first.png`.
- **빌드·패키지:** TypeScript·Vite·Electron 빌드와 `release/0.4.1/win-unpacked/Partsmith.exe` 생성 성공. 별도 데이터 폴더에서 실제 EXE의 0.4.1 버전·SQLite·제작실·기존 Codex 로그인 조회를 확인했습니다. 생성 요청 0회. 실행 중인 기존 앱은 종료·교체하지 않았습니다. `artifacts/workbench-package-smoke.json`.

이번 수정에서는 새 GPT 이미지 생성과 Tripo 유료 요청을 실행하지 않았습니다. 기존 파츠의 외형 품질이나 실제 Tripo→Astra→Unity 종단 품질을 검증 완료로 표시하지 않습니다. 아래 0.4.0 및 이전 검증은 각 버전 당시의 기록입니다.

## 0.4.0 — 사용자가 단계마다 선택하는 에셋 제작실

사용자의 최신 지시에 따라 자동으로 전체 공정을 진행하던 기본 화면을 교체했습니다. 완료 결과를 선택·채택한 다음, 다음 단계를 사용자가 직접 실행합니다. 기존 자동 제작은 기록 조회·기존 분리 결과 복구로 한정합니다.

- **실제 1단계 오류 원인 확인 및 복구 검증:** 이전 작업의 파츠 이미지는 생성되어 있었고 Codex 완료 이벤트도 존재했습니다. Windows에서 저장한 JSON 보고서 두 개의 UTF-8 BOM을 파서가 거부했습니다. 파서 수정 후 기존 산출물 **10개 모두 통과**, 재생성 **0회**, 사용자 원본 변경 **없음**. 근거: `artifacts/bom-recovery-check.json`. 외형 품질 승인과는 구분합니다.
- **실제 GPT 이미지 생성:** 별도 작은 비공개 정보 없는 이미지로 기존 Codex의 내장 이미지 생성 도구를 1회 호출했습니다. 완료 이벤트, 실제 PNG 저장, 디코딩·열람을 확인했습니다. 외부 이미지 API 대체나 Tripo 결제는 없었습니다. 네 후보 전체·멀티뷰 캐릭터 제작의 종단 성공을 증명하는 시험은 아닙니다.
- **실제 Electron + 모의 제작 결과:** `scripts/workbench-smoke.mjs`에서 네 후보 표시·선택, 분리 확인 전 모델 차단, 세 파츠 선택, 조립 대상 명령, 이전 버전 복원, 실제 목록 기반 리깅 토글, 2D 채택 전 3D 차단, 같은 시점의 정면·측면·후면 표시, 재시작 무실행, 구형 자동 시작 차단을 확인했습니다. 네트워크 생성 요청 0회, renderer 오류 0개. 삼각형·색상 이미지 등 명시적 테스트 데이터이며 실제 캐릭터 품질을 검증하지 않습니다. 근거: `artifacts/workbench-smoke.json`.
- **실제 로컬 Blender 검사:** 테스트용 메시·추가 뼈·웨이트·포즈 키프레임을 만들고 호스트 검사기로 오브젝트 ID·뼈·웨이트·동작 변화를 읽었습니다. 고품질 캐릭터 리깅 검증이 아닙니다.
- **단위·회귀 검사:** 사용자 채택, 입력 해시·파일 보존, 버전 복원과 하위 선택 해제, 전체 프로젝트 간 작업 직렬화, BOM 재검사, 기존 분리 복구, 백업 변조 거부, 부분 완료 유료 작업의 같은 작업 재개와 재결제 방지, 불명확 제출 차단, 멀티뷰 시간·프레임 수를 검사합니다. 대부분 외부 작업자는 모의 데이터입니다.
- **최종 확인:** `npm test` **68/68 통과**, TypeScript·웹·Electron 빌드 성공. `release/0.4.0/win-unpacked/Partsmith.exe` 생성 후 실제 패키지에서 버전·SQLite·새 제작실·저장된 ChatGPT 로그인 조회를 확인했습니다. 패키지 시험의 생성 요청은 0회입니다. 근거: `artifacts/workbench-package-smoke.json`, `artifacts/guided-imagegen-smoke.json`. UI/Blender 모의 시험과 실제 이미지 생성 연결 시험을 별도로 기록합니다.

멀티뷰 참조는 방향별 **3~12개의 핵심 동작 프레임**과 명시적 시간을 사용합니다. 전체 FPS 프레임을 채운 영상 생성이 아니며 UI에 총 이미지 수와 이 범위를 표시합니다. 이 참조를 사람이 확인한 뒤 Astra가 3D 타이밍·키프레임을 작성합니다.

**미검증·제한:** 실제 로그인된 Tripo Studio의 P2 4개 생성·폴리곤 설정·Smart UV·텍스처 유료 실행, 사용자 캐릭터의 Astra 조립·리깅·동작 품질, 해당 캐릭터의 Unity 종단 검증은 미완료입니다. 제출이 불명확하고 완료 파일도 없는 Studio 작업은 재결제하지 않고 수동 확인이 필요합니다. 압축 메시 등 검사기가 해석하지 못하는 형식은 호환 GLB 미리보기 변환이 필요합니다. 파일 검사와 구조 검사는 실루엣·접합·물리적 동작의 품질을 보장하지 않습니다.

이하 0.3.0 및 이전 기록은 당시 구현·시험 이력입니다. 현재 사용자 흐름은 위의 단계별 제작실을 기준으로 합니다.

## 0.3.0 — 자동 제작 실행기와 Codex Astra

방향을 수정했습니다. 앱의 중심은 Tripo 기능별 화면에서 전체 캐릭터 제작의 실행·검수·재작업으로 바뀝니다. 최신 애니메이션 요구는 **멀티뷰 2D 애니메이션 이미지 시퀀스 → Codex Astra의 Blender 포즈·키프레임·보간 제작**입니다. 영상 서비스나 모션 캡처를 필수 입력으로 두지 않습니다.

- 실제 Codex CLI 0.153.4: 저장된 ChatGPT 로그인으로 기본 작업자와 `--model gpt-6-astra` 작업자를 각각 실행했습니다. 두 실행에서 실제 `turn.completed`와 구조화된 결과 파일을 확인했습니다. Astra는 제공된 도구 목록에 `image_gen__imagegen`이 있다고 보고했습니다. **이미지 생성 도구 자체를 호출하거나 캐릭터를 만든 시험은 아닙니다.**
- `npm test`: **43/43 통과**. 신규 제작 엔진 12개, 보관용 제작 백업 2개, Studio 정책 4개 및 기존 25개 회귀 테스트입니다. 승인 우회·입력 변경·동시 실행·한도·재시작·확정 결과 재작업·모호한 제출 차단, 일시정지 직후 기록된 과금 재확인, 유효하지 않은 메시·리그·애니메이션, 단일 이미지·같은 이미지 복제·잘못된 프레임 시간 대응 거부를 포함합니다. 엔진의 생성물과 영수증은 모의 데이터입니다.
- `scripts/production-smoke.mjs`: 실제 Electron UI·IPC·SQLite·제작 실행기, 테스트 번들에서만 모의 Codex 작업자/Studio 영수증을 사용합니다. 19개 공정의 자동 진행, 승인·일시정지·재시작 무재제출·재개, 이미지/GLB 제공을 확인했습니다. 단일 이미지와 `checks=true`만 제출한 애니메이션 참조는 이미지 시퀀스 누락으로 `needs_input`이 되며 Astra·Unity 단계가 실행되지 않습니다. 보고서: `artifacts/production-smoke.json`.
- `scripts/studio-browser-smoke.ts`: 실제 Electron과 로컬 테스트 웹페이지에서 관찰한 요소 클릭·입력·선택·업로드, 비용 기록 후 실제 클릭, 다운로드 SHA·호스트 영수증, MCP 초기화, 로그인 화면 중단을 검사했습니다. 도메인·경로·중복 제출·변조된 다운로드 사본을 함께 검사합니다. **실제 Studio 계정이나 유료 생성 시험은 아닙니다.** 보고서: `artifacts/studio-browser-smoke.json`.
- 기존 `npm run test:ui`: 실제 Electron, renderer 격리, 로컬 Blender 마네킹, GLB·클립 재생, 재시작 검증 통과. 이 결과는 신규 Astra 제작 품질과 구분합니다.
- 최종 Windows 0.3.0 패키지 생성 성공. `scripts/production-package-smoke.mjs`에서 실제 EXE의 버전·SQLite·자동 제작 기본 화면·Codex 로그인 조회를 확인했습니다. `scripts/studio-browser-smoke.ts`는 패키지 내부 MCP 프로세스의 초기화·도구 목록·`studio_status`를 로컬 fixture에 연결해 검증했습니다. 보고서: `artifacts/production-package-smoke.json`, `artifacts/studio-browser-smoke-packaged.json`. 실제 생성 요청은 0회입니다.
- 제작 백업 복원은 검증된 파일의 경로·해시를 검사해 보관용으로 복원합니다. 실행 승인·활성 상태를 복원하지 않습니다. Markdown 보고서 복원도 확인했습니다. 신규 제작 이력 백업의 전체 UI 복원 시험은 아직 수행하지 않았습니다.

발견·수정한 문제: 기능별 버튼만 있던 흐름에 실행기가 없었음, 유료 제출 전 실패까지 불명확 제출로 처리하던 복구 문제, 승인 범위 내 재작업을 불필요하게 막던 문제, 동시에 시작한 실행이 하나의 Studio 브라우저를 공유하던 문제, 첫 브라우저 프레임 전 캡처 실패, 숨겨진 CAPTCHA iframe의 오탐, 작업자 보고만으로 표시되는 초록 체크, 재시작 후 기준 입력란의 기본값 회귀, 큰 백업을 한꺼번에 메모리에 보관하던 문제를 수정했습니다.

**미검증 범위:** 실제 파츠 분리·복원 이미지, Studio P2·Smart UV·텍스처·리깅, 캐릭터의 멀티뷰 이미지 시퀀스, Astra가 만든 동작의 자연스러움과 접지, 해당 결과의 Unity 종단 검증. 파일·해시·애니메이션 채널 검사는 시각 품질을 보장하지 않습니다. 정상 DOM 컨트롤을 통한 Studio 조작을 제공하며 임의 캔버스 드래그 도구는 없습니다. 로그인·CAPTCHA·지원하지 않는 조작·모호한 과금은 입력 필요 상태로 멈춥니다. 기본 통합 및 사용자 추가 MCP 설정은 바꾸지 않았습니다.

불명확한 원격 제출을 Studio 기록과 대조한 뒤 잠금을 해제하는 복구 UI는 아직 없습니다. 해당 실행은 잠금을 유지합니다. 과금 전 실패로 확인된 단계는 재개할 수 있습니다. Unity 단계는 실제 `Assets`·`ProjectSettings`가 있는 설정된 프로젝트만 쓰기 범위에 추가하고 기존 Partsmith Unity 브리지를 사용합니다. 브리지 또는 프로젝트가 준비되지 않으면 입력 필요 상태로 멈춥니다.

```powershell
npm run build
npm test
node scripts/production-smoke.mjs
npx tsx scripts/studio-browser-smoke.ts
```

아래는 기존 버전의 검증 이력이며 신규 자동 제작의 성공을 대신하지 않습니다.

## 실행 환경과 결과물

- Node.js 24.15.0 / npm 11.12.1 / Electron 44.7.0.
- Blender 5.0.0: `C:\Program Files\Blender Foundation\Blender 5.0\blender.exe`.
- Unity 6000.3.21f1, URP 17.3.0: `C:\Unity\3D Tool Test`.
- 실행 파일: `release/win-unpacked/Partsmith.exe`. 이 폴더 전체가 필요합니다. 코드 서명 없는 Windows x64 테스트 빌드입니다.
- Figma: 기존 파일 안에 편집 가능한 7개 화면과 컴포넌트·변수·텍스트 스타일을 작성하고 렌더를 확인했습니다. [조립 작업실](https://www.figma.com/design/sBk7h2NHssstvG6KXWJuyP/3D-Tool?node-id=6-217).

## 검증한 기능

| 범위 | 실제 확인 | 근거 |
|---|---|---|
| 빌드 | TypeScript 검사, Vite, Electron Windows 패키징 성공 | `npm run package` |
| 제작 엔진 | 승인 단회 사용, revision 고정, 모호한 POST 재전송 금지, 복구, 다운로드·취소 의미, 경로·도메인 검사 8/8 | `npm test` |
| Electron | 프로젝트 생성, 실제 Blender 실행, Three GLB·Idle/Walk 로드, 화면 탐색, 재시작 복구, renderer Node 격리 | `artifacts/electron-smoke.json` |
| 키 저장 | 테스트용 가짜 키의 DPAPI 암호화, 재시작 후 상태 복구, 삭제, 프로젝트로 유출되지 않음 | `artifacts/data-smoke.json` |
| 데이터 | PNG 원본 유지, 다각형 alpha 마스크, 후보 선택·고정, Blender 조립, 오래된 출력 차단, 프로젝트 및 텍스처 백업 복원 | `scripts/data-smoke.mjs` |
| 패키지 | 빌드된 EXE 실행, SQLite 초기화, 포함된 Blender 스크립트로 실제 데모 출력 | `artifacts/package-smoke.json` |
| Unity | FBX 임포트, URP 재질, 유효한 Humanoid, Idle·Walk, Controller·Prefab·Variant·테스트 씬 | `artifacts/unity-result.json` |
| 실제 재생 | 전용 씬 Play Mode에서 Idle·Walk 상태 진행과 뼈 회전 변화 감지, 렌더 캡처 | `artifacts/screenshots/unity-play-mode.png` |
| 재임포트 | 로컬 후보 교체·위치·회전 변경 → Blender 재조립 → Unity 재임포트, 같은 GUID, 사용자 Variant 내용·GUID 유지, Prefab 중복 없음 | `artifacts/reimport-smoke.json` |

Unity 최종 결과는 `complete_review_required`, `avatarValid=true`, `avatarHuman=true`, `runtimePlayModeVerified=true`, `runtimeMovingClips=[Idle, Walk]`, 오류 0개입니다. Edit Mode의 직접 Animator 평가는 false였으며, 별도 실제 Play Mode 검사로 진행과 변형을 확인했습니다. 기존 SampleScene이 깨끗한 상태로 복원되고 Play Mode 시작 씬 설정도 복원되는 것을 확인했습니다.

재임포트 테스트는 **로컬 마네킹 전체를 한 파츠 후보로 사용**했습니다. 실제 AI로 생성한 몸체·머리·헤어의 접합 품질을 검증한 것은 아닙니다. 데모는 16개 메시와 단순 가중치로 구성하며, 사람이 자연스럽게 걷는 고품질 애니메이션을 보장하지 않습니다.

## 검증하면서 수정한 문제

- Electron 로컬 asset 프로토콜의 GLB 요청 CORS 실패.
- Unity에서 메시 이름과 뼈 이름 중복으로 잘못된 Avatar가 생성되는 문제.
- 후보 교체 시 `.meta`에 남아 있던 이전 rest skeleton 재사용으로 캐릭터가 멀리 이동하는 문제. GUID는 유지하면서 관리 모델의 Avatar 설정을 재생성합니다.
- Blender GLB 가져오기가 저장한 muted NLA 클립을 FBX에서 누락하는 문제.
- Blender glTF 뼈대 표시용 보조 도형이 실제 메시로 출력되던 문제.
- 프로젝트 백업 복원 시 외부 텍스처 폴더 누락.

## 아직 확인하지 못한 범위

### 사용자 보고 401의 문서 재검토

2026-10-08 사용자가 `HTTP 401 / code 2`를 보고했습니다. 초기 앱은 중국용 `https://openapi.tripo3d.com/v3`를 고정 사용했습니다. 공식 [국제 API 소개](https://developers.tripo3d.ai/en/docs/introduction)의 국제 주소는 `https://openapi.tripo3d.ai/v3`입니다. 0.1.1에서 국제 주소를 기본으로 수정하고 연결 지역 선택, 지역 불일치 오류 안내, 구버전 설정 보존 마이그레이션을 추가했습니다. 지역별 호스트·자동 재시도 없음·설정 이관을 포함해 엔진 테스트 10/10이 통과했습니다. 새 실행 파일은 `release/0.1.1/win-unpacked/Partsmith.exe`이며, 실행 중인 기존 앱 파일을 덮어쓰지 않고 별도로 패키징했습니다.

공식 [오류 표](https://developers.tripo3d.ai/en/docs/error-handling)에 따르면 HTTP 401은 인증 문제이며, 크레딧 부족은 `2010`입니다. `code 2`는 공개 v3 표에 없어 개별 의미를 추정하지 않았습니다. 수정 후 기존 DPAPI 저장 키를 앱 프로세스 안에서만 사용해 국제 서버 `GET /v3/account/balance` 인증 성공을 실제 확인했습니다. 당시 응답 잔액과 예약 크레딧은 모두 0이었습니다. 키는 출력하거나 다른 파일로 복사하지 않았으며 유료 요청을 보내지 않았습니다.

**실제 Tripo 인증·잔액 조회: 성공. 실제 유료 생성: 미검증.** 키를 채팅으로 받거나 코드에 넣지 않았습니다. 계정별 지원 모델, 가격, 이미지 생성·수정, 파츠 3D 생성, 자동 리깅·리타게팅의 성공 여부는 API 크레딧 충전과 사용자 비용 승인 후 별도로 검증해야 합니다. 현재 목록은 공식 endpoint 문서 기반이며 계정 사용 가능 여부를 보증하지 않습니다. 예상 비용을 확인할 수 없으면 숫자를 만들지 않고 별도 승인을 받습니다.

- 0.2.0에서 Tripo 원격 분할·보완·리토폴로지·텍스처·UV 패킹 요청 경로를 추가했습니다. 실제 계정의 유료 처리 성공·품질은 미검증입니다. 기존 수동 crop·마스크는 별도 기능입니다.
- Blender 조립은 상대 배치와 목표 키 정규화입니다. 로컬 표면 용접·리토폴로지·UV 재생성은 구현하지 않습니다. 메시 변경 뒤 텍스처 처리는 사용자가 별도 Tripo 요청으로 승인합니다.
- Tripo의 기본 동작은 각각 별도 결과 후보입니다. 서로 다른 리타게팅 결과를 하나의 다중 클립 캐릭터에 자동 병합하는 기능은 없습니다. Blender에서 수동으로 병합한 GLB를 가져올 수 있습니다.
- 실제 복잡한 캐릭터의 헤어 연결·관절 웨이트·접합부·PBR 맵 정확성은 육안 검수해야 합니다. 로컬 데모 재질은 색상 중심이며 실제 API 텍스처 세트를 검증하지 않았습니다.
- 원격 취소 API를 확인하지 못해 앱의 중지는 추적 중지로 표시합니다. 모호한 제출은 기존 작업 ID를 확인해 연결하며 자동으로 재과금하지 않습니다.
- Unity가 닫혀 있거나 컴파일 중이면 요청이 대기합니다. 미저장 씬이 있으면 자동 Play Mode 검사를 건너뜁니다.
- 코드 서명·자동 업데이트·설치 프로그램은 포함하지 않습니다. npm audit에 moderate 개발 의존성 항목이 남아 있으며 제품 배포 전 재검토가 필요합니다.

## 재현

### 0.2.0 — Tripo 클라이언트 확장 (2026-10-08)

- `npm test`: **25/25 통과**. P2·멀티뷰·후처리 payload, 미지원 조합 사전 차단, 스마트 분할의 마스크·하위 작업 연결, 단일 승인·중복 결제 차단, 이미지 후보 순차 처리, 다운로드 오류 복구를 모의 API로 검증했습니다.
- `npm run build`: TypeScript·Vite·Electron 번들 생성 통과. Windows x64 `release/0.2.0/win-unpacked/Partsmith.exe` 폴더 빌드를 생성했습니다.
- `npm run test:ui`, `node scripts/data-smoke.mjs`: 기존 Electron·Blender·클립 미리보기·재시작·키 암호화·마스크·백업·stale 출력 검증 통과.
- `scripts/tripo-studio-smoke.mjs`: 실제 UI → IPC → SQLite의 **14개 미제출 견적**으로 입력·옵션 전달, P2 기본값·Preview 안내, H 옵션 분리, 분할·리토폴로지·UV 패킹·텍스처·무료 리깅 검사·변환 화면을 검증했습니다. 실행 승인은 0회, 생성 Job은 0개, API 키 없음, renderer 오류 0개입니다. 완료된 원격 분할·리깅 작업이 없는 상태에서 보완·리깅·동작 요청이 차단되는 것도 확인했습니다.
- 결과를 파츠에 적용하고 고정하면 UI와 IPC에서 모두 변경을 차단합니다. FBX 원본이 포함된 백업 복원 후 SHA가 같고, 별도의 GLB 미리보기가 다시 표시됩니다.
- 최종 **0.2.0 패키지 EXE**에서도 동일한 14개 요청 검토·파츠 고정·원본 백업 복원·GLB 애니메이션 검증을 통과했습니다. 보고서: `artifacts/tripo-studio-smoke-packaged.json`. 개발 번들 보고서는 `artifacts/tripo-studio-smoke-development.json`이며 각 실행의 스크린샷을 별도 보관합니다.
- `artifacts/fbx-preview-smoke.json`: 실제 로컬 Blender에서 FBX → GLB 미리보기 변환, 원본 SHA 보존, 메시 16개·스킨 1개·Idle/Walk, 중복 요청 재사용·경로 이탈 차단을 확인했습니다. 입력은 로컬 절차적 마네킹으로, Tripo 출력 검증은 아닙니다.

P2는 [공식 변경 이력](https://developers.tripo3d.ai/en/docs/changelog)과 [이미지 P-series API](https://developers.tripo3d.ai/en/docs/generation-image-to-model/p)에 `P2-20260801` Preview로 등재되어 있습니다. **계정별 P2 권한·유료 생성 성공은 미검증**입니다. 무료 모델 권한 조회 API는 확인하지 못했습니다. 앞선 실제 잔액 조회는 0이었고 이번 확장에서 유료 API를 호출하지 않았습니다.

Smart UV 탭은 `/models/convert`의 UV 패킹 요청을 제공합니다. 웹 Studio의 Smart UV 전체 기능과 동등성을 보장하지 않습니다. ZIP·GLTF와 외부 리소스 묶음은 원본 보관까지만 지원하며 압축 해제·외부 텍스처 수집·자동 재임포트는 제공하지 않습니다. GLB 및 별도 변환한 FBX 미리보기만 내장 뷰포트·조립 입력으로 사용합니다. 실제 AI 메시·쿼드·UV·재질·리깅 품질은 비용 승인 후 별도 검증이 필요합니다.

### 명령

```powershell
npm ci
npm run build
npm test
npm run test:ui
node scripts/data-smoke.mjs
npx tsx scripts/fbx-preview-smoke.ts
node scripts/tripo-studio-smoke.mjs
# 0.2.0 실행 파일 검증 (폴더 빌드 생성 후)
$env:PARTSMITH_EXE = 'release/0.2.0/win-unpacked/Partsmith.exe'
node scripts/tripo-studio-smoke.mjs
Remove-Item Env:PARTSMITH_EXE
npx tsx scripts/unity-smoke.ts --rebuild
# Unity 브리지 컴파일 후, 최초 임포트가 처리될 때까지 기다립니다.
npx tsx scripts/reimport-smoke.ts
npm run package
node scripts/package-smoke.mjs
node scripts/result-ui-smoke.mjs
```

Unity 검증 스크립트는 명시된 테스트 프로젝트의 Partsmith 관리 폴더만 대상으로 합니다. `artifacts/runtime`는 로컬 검증 데이터이며 제품 사용자 데이터와 별개입니다. 원본 사용자 씬과 별도 게임용 Variant는 덮어쓰지 않습니다. 테스트용 Unity CLI는 작업 폴더 범위에 설치했고 테스트 프로젝트에 `com.unity.pipeline`만 추가했습니다. 기본 통합 및 사용자 추가 MCP 설정은 변경하지 않았습니다.
