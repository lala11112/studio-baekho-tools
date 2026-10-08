# Partsmith 0.1.1 검증 결과

검증일: 2026-10-08, Windows. 실제 API 생성과 로컬 데모 검증을 구분합니다.

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

- 자동 이미지 분할과 가려진 면 복원은 미구현이며 수동 crop·마스크·이미지 수정 경로를 제공합니다.
- Blender 조립은 상대 배치와 목표 키 정규화입니다. 표면 용접, 리토폴로지, UV 재생성, 메시 변경 후 자동 재텍스처는 미구현입니다.
- Tripo의 기본 동작은 각각 별도 결과 후보입니다. 서로 다른 리타게팅 결과를 하나의 다중 클립 캐릭터에 자동 병합하는 기능은 없습니다. Blender에서 수동으로 병합한 GLB를 가져올 수 있습니다.
- 실제 복잡한 캐릭터의 헤어 연결·관절 웨이트·접합부·PBR 맵 정확성은 육안 검수해야 합니다. 로컬 데모 재질은 색상 중심이며 실제 API 텍스처 세트를 검증하지 않았습니다.
- 원격 취소 API를 확인하지 못해 앱의 중지는 추적 중지로 표시합니다. 모호한 제출은 기존 작업 ID를 확인해 연결하며 자동으로 재과금하지 않습니다.
- Unity가 닫혀 있거나 컴파일 중이면 요청이 대기합니다. 미저장 씬이 있으면 자동 Play Mode 검사를 건너뜁니다.
- 코드 서명·자동 업데이트·설치 프로그램은 포함하지 않습니다. npm audit에 moderate 개발 의존성 항목이 남아 있으며 제품 배포 전 재검토가 필요합니다.

## 재현

```powershell
npm ci
npm run build
npm test
npm run test:ui
node scripts/data-smoke.mjs
npx tsx scripts/unity-smoke.ts --rebuild
# Unity 브리지 컴파일 후, 최초 임포트가 처리될 때까지 기다립니다.
npx tsx scripts/reimport-smoke.ts
npm run package
node scripts/package-smoke.mjs
node scripts/result-ui-smoke.mjs
```

Unity 검증 스크립트는 명시된 테스트 프로젝트의 Partsmith 관리 폴더만 대상으로 합니다. `artifacts/runtime`는 로컬 검증 데이터이며 제품 사용자 데이터와 별개입니다. 원본 사용자 씬과 별도 게임용 Variant는 덮어쓰지 않습니다. 테스트용 Unity CLI는 작업 폴더 범위에 설치했고 테스트 프로젝트에 `com.unity.pipeline`만 추가했습니다. 기본 통합 및 사용자 추가 MCP 설정은 변경하지 않았습니다.
