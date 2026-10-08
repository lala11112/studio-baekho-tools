# API 근거와 확인 범위

문서 확인일: **2026-10-08 (Asia/Seoul)**. 아래 공식 Tripo v3 문서의 요청 규격을 사용했습니다. 초기 개발에서는 계정 키 없이 검증했으며, 문서와 로컬 테스트 통과만으로 실제 계정 가용성·잔액·과금·생성 성공을 확인한 것으로 간주하지 않습니다.

## API 지역과 401 수정 근거

공식 [국제 사이트 소개](https://developers.tripo3d.ai/en/docs/introduction)는 기본 주소를 `https://openapi.tripo3d.ai/v3`로 명시하고, 중국용 사이트를 별도로 `developers.tripo3d.com`이라고 안내합니다. [중국 사이트 문서](https://developers.tripo3d.com/en/docs/introduction)의 기본 주소는 `https://openapi.tripo3d.com/v3`입니다. 초기 구현은 `.com` 문서만 확인해 중국 주소로 고정한 오류가 있었습니다. 국제 계정용 기본 주소는 `.ai`이며, 지역이 다른 주소를 동일한 주소처럼 취급하면 안 됩니다. 아래 기능별 근거도 국제 사이트 링크로 정정했습니다.

[인증 문서](https://developers.tripo3d.ai/en/docs/authentication)의 형식은 `Authorization: Bearer {api_key}`이며, 연결 확인 예시는 `GET /account/balance`입니다. [공식 FAQ](https://docs.tripo3d.ai/other/support-faq.html)는 `tsk_`로 시작하는 API Key와 `tcli_`로 시작하는 Client ID를 구분합니다. 키의 실제 값은 채팅, 로그, 프로젝트 파일에 기록하지 않습니다.

[오류 문서](https://developers.tripo3d.ai/en/docs/error-handling)는 HTTP `401`을 인증 실패, `2010`을 크레딧 부족으로 구분합니다. 사용자에게 표시된 `HTTP 401 / code 2` 중 `code 2`의 개별 의미는 현재 공개 v3 오류 표에 없어 단정하지 않습니다. 401 자체를 충전 필요로 안내하거나, 주소 정정만으로 해당 계정의 인증 성공을 선언하지 않습니다. 앱의 잔액 조회 성공으로 인증을 확인한 뒤, 생성은 별도의 비용 승인 후 검증해야 합니다.

## 기능별 문서

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
