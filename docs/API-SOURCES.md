# API 근거와 확인 범위

문서 확인일: **2026-10-08 (Asia/Seoul)**. 아래 공식 Tripo v3 문서의 요청 규격을 사용했습니다. 초기 개발에서는 계정 키 없이 검증했으며, 문서와 로컬 테스트 통과만으로 실제 계정 가용성·잔액·과금·생성 성공을 확인한 것으로 간주하지 않습니다.

## API 지역과 401 수정 근거

공식 [국제 사이트 소개](https://developers.tripo3d.ai/en/docs/introduction)는 기본 주소를 `https://openapi.tripo3d.ai/v3`로 명시하고, 중국용 사이트를 별도로 `developers.tripo3d.com`이라고 안내합니다. [중국 사이트 문서](https://developers.tripo3d.com/en/docs/introduction)의 기본 주소는 `https://openapi.tripo3d.com/v3`입니다. 초기 구현은 `.com` 문서만 확인해 중국 주소로 고정한 오류가 있었습니다. 국제 계정용 기본 주소는 `.ai`이며, 지역이 다른 주소를 동일한 주소처럼 취급하면 안 됩니다. 아래 기능별 근거도 국제 사이트 링크로 정정했습니다.

[인증 문서](https://developers.tripo3d.ai/en/docs/authentication)의 형식은 `Authorization: Bearer {api_key}`이며, 연결 확인 예시는 `GET /account/balance`입니다. [공식 FAQ](https://docs.tripo3d.ai/other/support-faq.html)는 `tsk_`로 시작하는 API Key와 `tcli_`로 시작하는 Client ID를 구분합니다. 키의 실제 값은 채팅, 로그, 프로젝트 파일에 기록하지 않습니다.

[오류 문서](https://developers.tripo3d.ai/en/docs/error-handling)는 HTTP `401`을 인증 실패, `2010`을 크레딧 부족으로 구분합니다. 사용자에게 표시된 `HTTP 401 / code 2` 중 `code 2`의 개별 의미는 현재 공개 v3 오류 표에 없어 단정하지 않습니다. 401 자체를 충전 필요로 안내하거나, 주소 정정만으로 해당 계정의 인증 성공을 선언하지 않습니다. 앱의 잔액 조회 성공으로 인증을 확인한 뒤, 생성은 별도의 비용 승인 후 검증해야 합니다.

## 기능별 문서

### ChatGPT 인증 팝업과 내장 브라우저 한계 — 0.6.2, 2026-10-09

Electron 공식 [창 열기](https://www.electronjs.org/docs/latest/api/window-open) 문서에서 `setWindowOpenHandler`의 `deny`는 실제 창 생성을 취소합니다. 기존 코드의 인증 팝업은 추가 창을 항상 거부했습니다. 새 구현은 메인 창과 인증 팝업에 같은 주소 검사와 세션을 적용하고, 임시 `about:blank` 이후에도 이동을 검사합니다. 이 코드 결함의 수정과 사용자 환경의 실제 실패 원인 확인은 구분합니다.

Google 공식 [네이티브 앱 OAuth 오류 안내](https://developers.google.com/identity/protocols/oauth2/native-app#disallowed_useragent)는 허용하지 않는 내장 사용자 에이전트에서 `disallowed_useragent` 오류가 발생할 수 있다고 설명합니다. 실제 오류가 확인되면 현재 내장 방식의 한계로 표시하며 사용자 에이전트 위장이나 쿠키 복사로 우회하지 않습니다. 로컬 인증 페이지 시험은 실제 Google 계정 로그인 성공의 근거가 아닙니다.

### GPT 한 요청에서 4개 독립 원본 받기 — 2026-10-09 정정

공식 [OpenAI 이미지 생성 안내](https://developers.openai.com/api/docs/guides/image-generation)의 Image API `n` 매개변수, Codex 내장 이미지 도구의 입력 규격, 사용자가 ChatGPT에서 보내는 한 번의 채팅 요청은 서로 다른 층위입니다. 내장 도구에 개수 매개변수가 없다는 사실만으로 한 GPT 요청에서 여러 독립 이미지를 받을 수 없다고 결론 내린 것은 잘못이었습니다. 사용자의 의도는 정면·후면·좌·우 각각의 원본 네 장이며, 2×2 시트를 잘라 네 파일로 만드는 기능이 아닙니다. 0.5.4부터 새 시트 생성 옵션을 제거하고 파츠마다 한 GPT 작업에 필요한 방향별 독립 원본을 요청합니다.

새 구현은 같은 GPT 작업 안에서 실제 지원되는 다중 출력 또는 개별 이미지 도구 호출을 사용하도록 지시하고, 받은 원본을 재인코딩·크롭하지 않고 보존합니다. 내부 이미지 호출 횟수나 처리 속도는 실제 도구 실행 없이 단정하지 않습니다. 모델·추론 설정·필수 원본 참조를 낮추지 않으며, 기존 이미지 정렬용 2048×2048 사본은 원본과 별도로 관리합니다. Image API로 자동 전환하지 않습니다. 이전 시트는 저장 기록·로컬 검사만 유지합니다.

0.5.4까지 앱의 GPT 경로는 사용자 로그인으로 Codex CLI 작업자를 실행하는 방식이었으며, ChatGPT 웹 채팅 자동 조작과 같지 않습니다. 실제 생성과 모의 작업자·합성 PNG 시험은 검증 기록에서 구분합니다.

### 내부 브라우저 도구의 비대화형 권한 — 0.6.1, 2026-10-09

공식 [Codex 설정 참조](https://learn.chatgpt.com/docs/config-file/config-reference)는 `mcp_servers.<id>.tools.<tool>.approval_mode`를, [플러그인 설정 예시](https://developers.openai.com/plugins/build/plugins)는 특정 도구의 `approval_mode="approve"`를 설명합니다. Partsmith는 이 설정을 자식 프로세스 명령 인자로만 전달하며 실제 앱 소유 도구 이름을 allowlist로 고정합니다. `approval_policy="never"`와 `workspace-write`는 유지하고 전역 설정·계정 권한·다른 서버는 바꾸지 않습니다. 앱 자체의 비용 한도·제출 기록·중복 방지·인증 보호도 유지합니다. 실제 인증된 CLI가 로컬 시험 MCP의 상태·다운로드 조회를 호출하는지 별도로 검증합니다. 이는 실제 Tripo 생성 검증과 다릅니다.

0.6.1의 생성 개수는 앱의 요청값입니다. Tripo의 실제 화면에 있는 옵션과 선택 상태를 관찰한 뒤 그 값으로 한 번 제출하도록 지시합니다. 1–16이라는 앱 입력 범위를 Tripo의 지원 개수나 고정 요금으로 주장하지 않으며, 지원하지 않는 개수를 여러 제출로 대신하지 않습니다.

### 사용자 계정의 ChatGPT 웹 연결 — 0.6.0, 2026-10-09

공식 [ChatGPT 이미지 생성 안내](https://learn.chatgpt.com/docs/image-generation)는 웹 채팅에 이미지 생성을 요청하고 참조를 첨부하며, 생성된 이미지를 확대 뷰어에서 확인하는 사용 방법을 설명합니다. 웹에서의 이미지 가용성과 사용 한도는 계정·워크스페이스 설정에 달려 있습니다. 이것을 별도 API 키나 API의 다중 이미지 인자와 동일하게 취급하지 않습니다.

실제 로그인된 ChatGPT의 작성기는 `contenteditable` 입력창, 이미지 첨부 입력, 생성 이미지 갤러리와 뷰어의 다운로드 버튼을 사용했습니다. 기존 이미지 한 장을 브라우저 UI에서 실제 다운로드해 1024×1536 PNG 원본을 확인했습니다. 이 검사는 기존 이미지의 다운로드이며 새 생성이나 Partsmith 자체 로그인 세션의 종단 시험이 아닙니다. 해당 사용자 이미지·대화 내용은 저장소와 개발 기록에 넣지 않습니다.

Partsmith는 별도 영구 브라우저 세션을 사용하고 일반 UI의 입력·첨부·전송·이미지 뷰어·다운로드만 연결합니다. 프롬프트와 참조는 호스트가 고정하고 전송 전에 한 번의 요청을 기록합니다. 원본 출력은 해당 작업·단계·확인된 대화의 다운로드 해시와 대조합니다. 다른 브라우저의 쿠키나 로그인 정보를 옮기지 않으며 사설 엔드포인트·API 전환·모델 자동 변경·모호한 요청 재전송을 사용하지 않습니다. 실제 계정에서 새 멀티뷰를 생성했을 때의 품질·속도·사용량 절감은 별도 검증이 필요합니다.

### Studio 4방향 입력과 0.5.0 선택 방식

2026-10-08 확인한 공식 [Smart Mesh Studio 사용 안내](https://www.tripo3d.ai/blog/smart-mesh-tutorial)는 정면·좌측·우측·후면 이미지를 넣는 멀티뷰 입력을 설명합니다. 문서 제목과 본문은 P1.0 기준이므로 P2의 해당 계정 권한·가격·수량·프롬프트 입력 지원을 증명하지 않습니다. 0.5.0 제작 작업자는 실제 Studio에서 P2, 방향별 입력 칸, 모델 1개, 폴리곤 설정과 실제 비용을 확인한 뒤 진행하도록 연결했습니다. 사용자 수정 프롬프트를 받을 수 없는 화면에서는 전달했다고 간주하거나 다른 모델/API로 전환하지 않습니다. 공개 API의 [P 시리즈 멀티뷰 문서](https://developers.tripo3d.ai/en/docs/generation-multiview-to-model/p)는 별도 참고이며 Studio 대신 API를 호출하는 근거가 아닙니다.

공식 [P2.0 안내](https://www.tripo3d.ai/blog/tripo-p2-0-preview)는 네 방향 입력과 **Mesh Edit**를 명시합니다. 기존 모델에서 Edit Mesh를 열고 선택 상자의 핸들을 움직인 뒤 Retry Selection/Regenerate로 해당 영역을 수정합니다. 같은 문서는 Pro에 모델당 무료 수정 3회, Max·Team에 무제한, 무료 범위 이후 회당 50크레딧을 안내합니다. 이는 확인일의 문서 설명이며 실제 계정 횟수·요금을 하드코딩하지 않습니다. 앱의 모델 리롤은 이 기존 모델 편집에 연결하고 전체/부분 범위를 지정합니다. 횟수·비용·선택 범위를 확인하지 못하면 새 모델 생성으로 대체하지 않습니다. 공식 안내에는 Mesh Edit의 자유 텍스트 형상 지시 지원이 명시되지 않아 실제 입력란이 없으면 프롬프트를 전달했다고 주장하지 않습니다.

| 기능 | 공식 근거 | 구현 선택 |
|---|---|---|
| 이미지 생성 | https://developers.tripo3d.ai/en/docs/generation-text-to-image | `/generation/text-to-image`; 문서에 명시된 모델·해상도 조합 일부 제공 |
| 이미지 수정 | https://developers.tripo3d.ai/en/docs/generation-image-to-image | 업로드한 원본 `file_token`과 추가 prompt를 전달, parentId 보존 |
| 파츠 모델 | https://developers.tripo3d.ai/en/docs/generation-image-to-model/standard | endpoint-specific 버전 ID, PBR standard, face_limit 20000 |
| 파일 업로드 | https://developers.tripo3d.ai/en/docs/files | multipart 업로드; 로컬 키를 포함한 URL 사용 안 함 |
| 상태·결과 | https://developers.tripo3d.ai/en/docs/task-query | 기존 ID로 GET; 결과 다운로드 실패는 재생성하지 않음 |
| 잔액 | https://developers.tripo3d.ai/en/docs/account | 계정 balance/frozen 조회 |
| 검사 | https://developers.tripo3d.ai/en/docs/animations-rig-check | 조립된 GLB의 riggable 확인 |
| 리깅 | https://developers.tripo3d.ai/en/docs/animations-rig | 인간형 v1.0, Mixamo 명명, GLB 결과 |
| 기본 동작 | https://developers.tripo3d.ai/en/docs/animations-retarget | 해당 rig 버전의 biped idle/walk, GLB에 bake |
| 요금 | https://developers.tripo3d.ai/en/docs/billing | 실시간 견적 API 미확인; 예상 금액은 null, 실제 사용량만 저장 |

이전 `platform.tripo3d.ai` v2 문서와 새로운 개발자 사이트 v3에 모델 이름 차이가 있습니다. v3의 공통 모델 설명에도 별칭과 endpoint 문서의 버전 ID가 다르므로, 앱은 구체적인 endpoint 문서를 기준으로 목록을 분리합니다. 근거 없는 모델명을 입력하지 않습니다.

계정별 모델 목록 조회 API와 원격 취소 API는 이번 확인에서 검증되지 않았습니다. 인증 성공만으로 모든 모델 접근을 보증하지 않습니다. 사용자가 승인한 첫 실제 요청의 성공/오류가 계정 접근 검증 근거가 됩니다.

**Smart Mesh / Smart UV**: Studio 기능과 API의 동등성을 주장하지 않습니다. 문서에는 topology·low-poly·UV 관련 개별 옵션이 있지만 이 프로토타입은 기본 PBR 메시 생성만 사용합니다. 자동 표면 접합이나 UV 변경 뒤 텍스처 자동 재생성은 제공하지 않습니다. Blender 수동 보정·재출력과 새 후보 등록이 대체 경로이며, 모델의 게임 사용 품질은 별도 검사해야 합니다.

안전한 다운로드를 위해 결과 URL은 HTTPS와 Tripo 및 지정된 공용 스토리지 도메인으로 제한합니다. 다른 CDN이 반환되면 원격 ID를 보존하고 오류를 표시합니다. 검증된 도메인을 명시적으로 추가해야 합니다.
