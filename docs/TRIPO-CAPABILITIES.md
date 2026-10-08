# Tripo 기능과 API 매핑

확인일: 2026-10-08. 이 문서는 **공식 국제 API의 문서·CLI 조사 결과**다. 아래 예시는 요청 설계이며 실제 과금 작업의 성공 증거가 아니다. 앱은 입력/옵션/승인/결과 저장을 담당하고 모델 생성·분할·리토폴로지·UV 처리·텍스처·리깅은 Tripo 서버에 요청한다. Blender는 결과 형식 변환과 기존 Unity 출력 연결에만 사용한다.

## 화면과 처리 연결

| 사용자 기능          | 요청                                                   | 상태/주의점                                                                                    |
| -------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 스마트 메시 P2.0     | `POST /generation/image-to-model`, `model=P2-20260801` | 공식 P2는 Preview. 기본 모드로 사용하되 HD 모델과 구분                                         |
| 텍스트 → 스마트 메시 | `POST /generation/text-to-model`                       | 이미지 입력과 별도 요청 형태                                                                   |
| 멀티뷰 → 스마트 메시 | `POST /generation/multiview-to-model`                  | 정면 필수, 최소 2개 뷰                                                                         |
| HD 모델              | 동일 생성 endpoint, `model=v3.1-20260211`              | P2에 지원되지 않는 H-series 옵션을 섞지 않음                                                   |
| 분할                 | `POST /mesh/segment`                                   | v2는 semantic Beta. 결과 모델 내부 파츠를 표시                                                 |
| 스마트 분할          | `POST /mesh/smartsegment`                              | 별도 파이프라인. 파일 토큰/URL만 받음                                                          |
| 분할 부위 보완       | `POST /mesh/complete`                                  | segmentation task만 입력 가능                                                                  |
| 리토폴로지           | `POST /mesh/decimate`                                  | v2 스마트 방식/ v1 기본 방식                                                                   |
| Smart UV 영역        | `POST /models/convert`, `pack_uv=true`                 | 공개 API에서 확인한 기능은 **UV 패킹**. Studio의 Smart UV 전체 기능과 동일하다고 표기하지 않음 |
| 텍스처               | `POST /models/texture`                                 | 모델/품질/텍스트 또는 참조 이미지 선택                                                         |
| 리깅                 | `POST /animations/rig-check` → `POST /animations/rig`  | 검사 성공 후 유료 리깅 승인                                                                    |
| 애니메이션           | `POST /animations/retarget`                            | 해당 rig model과 호환되는 preset 사용                                                          |

공통 base는 `https://openapi.tripo3d.ai/v3`다. 중국 지역 `.com` endpoint와 국제 계정 키를 혼용하지 않는다. 작업 요청은 `Authorization: Bearer <key>`를 main process에서만 설정한다. [공식 인증](https://developers.tripo3d.ai/en/docs/authentication)

## 생성 요청

### 이미지 생성·편집 모델 ID 확인

현재 endpoint별 공식 문서는 `seedream_v5`, `banana2`, `chat_image_2`를 text-to-image와 image-to-image의 `model` 값으로 모두 열거한다. 일반 Models 페이지와 CLI skill에는 `gemini-*` 표기도 있으므로 endpoint별 명세를 우선한다. 앱의 기존 `banana2`를 근거 없이 `gemini-3.1-flash`로 치환하지 않는다. Seedream v5는 `2K/3K`, banana2는 `0.5K/1K/2K/4K`, Chat Image 2는 문서의 WxH preset을 사용한다. [텍스트→이미지](https://developers.tripo3d.ai/en/docs/generation-text-to-image), [이미지→이미지](https://developers.tripo3d.ai/en/docs/generation-image-to-image)

WebP는 이미지→3D에 사용할 수 있지만 일부 이미지 편집 provider route에서 거부된다. 편집에서는 PNG/JPEG로 준비하도록 안내하거나 업로드 전에 무손실 형식 변환한다. 문서에 없는 이미지 모델 권한을 성공으로 추정하지 않는다.

### 스마트 메시 P2

P2의 실제 wire value는 `P2-20260801`이다. `tripo-p2`는 CLI 별칭이다. 삼각면 한도는 48–50,000, 사각면은 48–25,000이다. `face_limit`을 생략하면 자동 결정된다. `texture=false`이면 `pbr=false`도 함께 전달한다. `export_uv=true`는 생성 시 UV 전개 옵션이다. P2에 `smart_low_poly`, `generate_parts`, `geometry_quality`를 보내지 않는다. [이미지 P-series](https://developers.tripo3d.ai/en/docs/generation-image-to-model/p), [Tripo CLI](https://developers.tripo3d.ai/en/docs/tripo-cli)

```json
{
  "input": "<uploaded-image-file-token>",
  "model": "P2-20260801",
  "face_limit": 12000,
  "quad": false,
  "texture": true,
  "pbr": true,
  "texture_quality": "standard",
  "export_uv": true
}
```

이미지는 PNG/JPEG/WebP, 20MB 이하. 입력은 파일 토큰, 공개 URL, 성공한 image-generation task 중 하나다. 파츠 메모를 이미지→3D의 `prompt`로 보내지 않는다. 프롬프트 기반 생성은 별도 endpoint를 쓴다.

`POST /generation/text-to-model`:

```json
{
  "prompt": "A stylized game character in T pose",
  "model": "P2-20260801",
  "face_limit": 12000,
  "quad": false,
  "texture": true,
  "pbr": true
}
```

`prompt` 최대 1024자, `negative_prompt` 최대 255자. `model_seed`, `texture_seed`, `image_seed`를 별도로 기록할 수 있다. [텍스트 P-series](https://developers.tripo3d.ai/en/docs/generation-text-to-model/p)

`POST /generation/multiview-to-model`:

```json
{
  "inputs": [
    { "front": "<front-file-token>" },
    { "back": "<back-file-token>" }
  ],
  "model": "P2-20260801",
  "face_limit": 12000,
  "texture": true,
  "pbr": true
}
```

뷰 키는 `front/left/back/right`이며 객체 하나당 한 뷰를 보낸다. 서로 다른 입력 형식을 섞지 않는다. [멀티뷰 P-series](https://developers.tripo3d.ai/en/docs/generation-multiview-to-model/p)

### 출력 형식 함정

P2 `quad=true`는 FBX 출력이다. GLB를 기대해 다운로드 파일 이름만 `.glb`로 바꾸면 안 된다. 원본 FBX를 그대로 저장하고 미리보기용 변환본을 별도 asset으로 관리한다. 앱 변환은 Tripo 생성 결과를 읽는 형식 변환이며 원본 쿼드 데이터를 대체하지 않는다. 후속 작업이 있으면 생성 단계의 `export_orientation`은 생략하고 최종 변환에서 설정한다.

다음 **무료 dry-run만** 실행해 P2 payload와 FBX 경고를 확인했다. CLI0.5.1 결과 `valid:true`, `model:P2-20260801`, `quad=true forces FBX output`이었다. 실제 업로드/생성 요청은 하지 않았다.

```powershell
npx --yes tripo-cli@0.5.1 make 'https://example.com/reference.png' --model tripo-p2 -p quad=true -p face_limit=12000 -p texture=false -p pbr=false --dry-run --json
```

## 분할과 보완

`POST /mesh/segment`:

```json
{
  "input": "<model-task-or-file-token>",
  "model": "v2.0-20260430",
  "segmentation_granularity": "balanced",
  "split_by_connectivity": true
}
```

v1은 `v1.0-20250506`, v2는 `v2.0-20260430` Beta. v2의 세밀도는 `simple/balanced/detailed`. `ref_image`를 보내면 세밀도와 연결요소 분리 옵션이 무시된다. 모델 입력은 GLB/GLTF/FBX/OBJ/STL, 150MB 이하. 결과는 `output.model_url`, 미리보기는 `rendered_image_url`이다. [분할 API](https://developers.tripo3d.ai/en/docs/mesh-segment)

`POST /mesh/smartsegment`:

```json
{
  "input": "<uploaded-glb-file-token>",
  "seg_type": "model",
  "granularity": "medium",
  "hint": "head, hair, body",
  "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}
```

`seg_type=model`은 GLB만, `seg_type=image`는 이미지부터 생성/분할한다. `input`은 **task ID를 받지 않는다**. 기존 결과를 로컬에서 다시 업로드한다. `granularity=coarse/medium/fine`. 모델 입력은 column-major 4×4 변환 행렬이 필요하다.

스마트 분할의 결과 필드는 `seg_model_url`, `mask_url`, `prompt`(파트 레이블), `seg_task_id`, `model_task_id`다. 일반 `model_url`만 찾는 downloader로는 결과를 놓친다. 이 정보는 공식 npm 배포물 `tripo-cli@0.5.1`의 `docs --topic commands/process`, `dist/core/requests.js`, `dist/knowledge/chains.js`에서 교차 확인했다. [공식 CLI 안내](https://developers.tripo3d.ai/en/docs/tripo-cli), [npm 배포물](https://www.npmjs.com/package/tripo-cli)

`POST /mesh/complete`:

```json
{
  "input": "<segmentation-task-id>",
  "model": "v1.0-20250506",
  "completion_mode": "quick_cap",
  "part_names": ["head", "body"]
}
```

입력은 `mesh/segment` 작업 ID이며 파일 토큰이 아니다. Smart Segmentation 다음에는 반환된 `seg_task_id`를 쓴다. 모드는 `ai_completion` 또는 `quick_cap`; `part_names` 생략 시 모든 부위다. [보완 API](https://developers.tripo3d.ai/en/docs/mesh-complete)

## 리토폴로지와 UV

`POST /mesh/decimate`:

```json
{
  "input": "<model-task-or-file-token>",
  "model": "v2.0",
  "face_limit": 5000,
  "quad": false,
  "bake": true
}
```

v2는 삼각면 500–20,000, 사각면 500–10,000을 받으며 adaptive 생략도 가능하다. `bake`와 `part_names`를 지원한다. v1은 face_limit 필수이며 이 두 필드를 보내지 않는다. decimate의 face_limit은 목표값이므로 실제 결과의 삼각형 수를 검증한다. 현재 문서는 v2 출력을 GLB로 기재하면서 quad도 지원한다고 설명한다. 따라서 서버 산출물 형식을 검사하고 반환물이 쿼드 원본을 보존한다고 무조건 주장하지 않는다. [리토폴로지 API](https://developers.tripo3d.ai/en/docs/mesh-decimate)

`POST /models/convert`를 통한 Tripo UV 패킹:

```json
{
  "input": "<model-task-or-file-token>",
  "format": "GLTF",
  "pack_uv": true,
  "bake": true,
  "texture_size": 2048,
  "texture_format": "PNG",
  "with_animation": true
}
```

요청 format enum은 `GLTF`이며 `GLB`가 아니다. `quad=true`는 FBX 출력으로 제한된다. 통합 UV 레이아웃 패킹은 확인했지만 Studio의 Smart UV 전용 알고리즘/UV 편집 화면과 같다는 근거는 없다. 앱 표기는 “Smart UV · Tripo UV 패킹”과 범위 설명을 함께 사용한다. 로컬 UV 대체 처리는 하지 않는다. [변환 API](https://developers.tripo3d.ai/en/docs/models-convert)

## 텍스처

`POST /models/texture`:

```json
{
  "input": "<model-task-or-file-token>",
  "model": "v3.5-20260815",
  "texture_prompt": { "text": "stylized hand painted colors" },
  "texture_quality": "standard",
  "pbr": true,
  "delight": true
}
```

모델은 `v3.5-20260815`, `v3.0-20250812`, `v2.5-20250123`; 품질은 `standard/detailed/extreme`, `fast`는 v3.5에서만 가능하다. `texture_prompt`의 `text/image/images`는 배타적이다. `style_image`는 text와 함께 사용 가능하다. 이미지 4개 모드는 front/left/back/right 순서다. `part_names`로 분할 부위를 선택할 수 있다. [텍스처 API](https://developers.tripo3d.ai/en/docs/models-texture)

## 리깅과 애니메이션

무료 검사 `POST /animations/rig-check`에 `{ "input": "<glb-task-or-file-token>" }`를 보낸다. `output.riggable`과 `output.rig_type`을 확인한다. [검사 API](https://developers.tripo3d.ai/en/docs/animations-rig-check)

Unity humanoid용 `POST /animations/rig`:

```json
{
  "input": "<model-task-or-file-token>",
  "model": "v1.0-20240301",
  "rig_type": "biped",
  "spec": "mixamo",
  "out_format": "glb"
}
```

v1은 biped용이며 v2.5 `v2.5-20260210`은 다양한 체형을 지원한다. CLI 기본값과 API 기본값이 다르므로 항상 버전을 기록한다. `spec=mixamo`만으로 Unity Avatar 유효성을 보장하지 않으므로 import 결과를 검사한다. [리깅 API](https://developers.tripo3d.ai/en/docs/animations-rig)

`POST /animations/retarget`:

```json
{
  "input": "<rig-task-id>",
  "animations": ["preset:biped:idle", "preset:biped:walk"],
  "out_format": "glb",
  "bake_animation": true,
  "export_with_geometry": true,
  "animate_in_place": true
}
```

`input`은 rig 작업 ID다. `animation` 한 개 또는 `animations` 목록 중 하나만 보낸다. v1 preset은 `preset:biped:*`, v2.5 biped는 `preset:idle/walk/run`이다. CLI는 한 작업 최대 5개를 허용하며 비용은 클립 수만큼이다. [애니메이션 API](https://developers.tripo3d.ai/en/docs/animations-retarget)

## 비용과 검증 수준

| 작업                                 |            문서 기준 예상 크레딧 |
| ------------------------------------ | -------------------------------: |
| P2 생성                              | bare 100 / standard textured 110 |
| P2 quad 추가                         |                               +5 |
| 분할 / 보완 / Quick Cap              |                     40 / 50 / 30 |
| 스마트 분할 image / model            |                          85 / 55 |
| 리토폴로지 v2 / v1                   |                          30 / 10 |
| 텍스처 standard / detailed / extreme |                     10 / 20 / 30 |
| 변환 basic / advanced                |                           5 / 10 |
| rig-check / rig / retarget           |               0 / 25 / 클립당 10 |

목록 가격은 계정별 견적이 아니다. P2 비용은 bundled Tripo skill의 가격표와 CLI 참조를 사용했다. 나머지 처리 비용은 [공식 API 가격표](https://developers.tripo3d.ai/en/pricing)에서 확인했다. UV 예시는 texture_size/texture_format을 변경하므로 advanced 10으로 계산한다. 화면의 Studio “생성 100”을 API의 모든 설정/후보 개수 비용으로 복사하지 않는다.

승인 전 요청별 예상 비용과 후보 수를 보여주고, 제출 이후 `credits_consumed` 실제 값을 기록한다. 후보 4개는 독립 요청 4회이며 중간 실패 시 남은 요청을 자동 재시도하지 않는다. 서버는 제출 때 크레딧을 동결하고 성공 때 청구하며 실패/취소 때 동결을 돌려준다. 앱의 추적 중지는 서버 취소가 아니다. [결제 API](https://developers.tripo3d.ai/en/docs/billing)

확인 수준: 공개 문서 읽기, 공식 CLI0.5.1 소스·명령 문서 조사, 무료 P2 dry-run. 인증된 유료 endpoint 호출·P2 계정 권한·실제 산출물 품질·Studio 기능 완전 동등성은 이 조사에서 검증하지 않았다.

공식 Account/endpoint 목록에서 확인한 읽기 기능은 잔액과 사용량이다. 계정별 P2 접근 가능 여부를 무료로 확인하는 capability/entitlement endpoint는 찾지 못했다. 무료 dry-run은 로컬 payload 검증이며 계정 권한 검사가 아니다. `accountVerified:false`를 유지하고 접근 불가 응답을 별도로 보여준다. [Account](https://developers.tripo3d.ai/en/docs/account), [API 목록](https://developers.tripo3d.ai/en/docs/introduction)

## 구현 시 결과 처리 원칙

1. 제출 intent와 승인 내용을 저장한 뒤 단 한 번 POST한다. 응답이 불명확하면 submission_unknown으로 남겨 재결제를 방지한다.
2. 일반 작업은 model_url, 스마트 분할은 seg_model_url, 검사 작업은 riggable/rig_type으로 분기한다. 원본 출력 metadata와 하위 task ID를 보존한다.
3. 다운로드는 HTTPS 허용 도메인, 크기 제한, 실제 파일 형식을 검사한다. URL 만료 시 기존 task를 재조회하고 재생성하지 않는다.
4. 파츠/후처리 후보는 원본을 덮어쓰지 않는다. 요청 옵션·부모 asset·원격 작업 ID·실제 비용을 함께 저장한다.
5. 문서의 복사된 공통 응답 예시에는 type/credits가 해당 endpoint와 어긋나는 경우가 있다. 예시 값 100을 비용 계산이나 task type 판정에 사용하지 않는다.
