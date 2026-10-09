# API 근거와 확인 범위

문서 확인일: **2026-10-08 (Asia/Seoul)**. 아래 공식 Tripo v3 문서의 요청 규격을 사용했습니다. 초기 개발에서는 계정 키 없이 검증했으며, 문서와 로컬 테스트 통과만으로 실제 계정 가용성·잔액·과금·생성 성공을 확인한 것으로 간주하지 않습니다.

## API 지역과 401 수정 근거

공식 [국제 사이트 소개](https://developers.tripo3d.ai/en/docs/introduction)는 기본 주소를 `https://openapi.tripo3d.ai/v3`로 명시하고, 중국용 사이트를 별도로 `developers.tripo3d.com`이라고 안내합니다. [중국 사이트 문서](https://developers.tripo3d.com/en/docs/introduction)의 기본 주소는 `https://openapi.tripo3d.com/v3`입니다. 초기 구현은 `.com` 문서만 확인해 중국 주소로 고정한 오류가 있었습니다. 국제 계정용 기본 주소는 `.ai`이며, 지역이 다른 주소를 동일한 주소처럼 취급하면 안 됩니다. 아래 기능별 근거도 국제 사이트 링크로 정정했습니다.

[인증 문서](https://developers.tripo3d.ai/en/docs/authentication)의 형식은 `Authorization: Bearer {api_key}`이며, 연결 확인 예시는 `GET /account/balance`입니다. [공식 FAQ](https://docs.tripo3d.ai/other/support-faq.html)는 `tsk_`로 시작하는 API Key와 `tcli_`로 시작하는 Client ID를 구분합니다. 키의 실제 값은 채팅, 로그, 프로젝트 파일에 기록하지 않습니다.

[오류 문서](https://developers.tripo3d.ai/en/docs/error-handling)는 HTTP `401`을 인증 실패, `2010`을 크레딧 부족으로 구분합니다. 사용자에게 표시된 `HTTP 401 / code 2` 중 `code 2`의 개별 의미는 현재 공개 v3 오류 표에 없어 단정하지 않습니다. 401 자체를 충전 필요로 안내하거나, 주소 정정만으로 해당 계정의 인증 성공을 선언하지 않습니다. 앱의 잔액 조회 성공으로 인증을 확인한 뒤, 생성은 별도의 비용 승인 후 검증해야 합니다.

## 기능별 문서

### GPT 4방향 묶음 생성 — 2026-10-09

공식 [OpenAI 이미지 생성 안내](https://developers.openai.com/api/docs/guides/image-generation)는 Image API의 `n` 매개변수로 여러 이미지를 요청할 수 있다고 설명합니다. 이 API 기능과 현재 Codex 내장 `image_gen` 도구의 입력 규격은 별개입니다. 현재 연결된 내장 도구에는 이미지 개수 매개변수가 없으므로 앱은 `n=4`를 임의로 전달하거나 유료 API로 전환하지 않습니다. 사용자의 한 번에 4방향 생성 요구에 따라 한 투명 2×2 이미지 안에 동일 파츠의 정면·후면·좌·우를 생성하도록 요청하고, 실제 결과 픽셀을 호스트가 네 방향 파일로 분리합니다. 네 독립 파일을 한 호출로 반환하는 서비스 기능을 구현했다고 주장하지 않습니다.

품질 우선 조건 때문에 방향별 개별 생성이 기본이며, 묶음은 사용자가 직접 선택하는 옵션입니다. 묶음은 파츠당 한 생성 요청으로 작업 시작·대기 횟수를 줄이는 구현이며, 실제 생성 시간이나 방향별 외형 일관성을 보장하지 않습니다. 시트의 네 칸은 원본 해상도를 나누어 사용합니다. 정렬용 2048×2048 확대는 새로운 세부 정보를 생성하지 않습니다. 실제 이미지 생성 시험과 모의 작업자·합성 PNG 시험은 검증 기록에서 구분합니다.

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
