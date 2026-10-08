# Auto-3D-Tool / Partsmith — Unity 캐릭터 제작실

스튜디오 백호 게임개발팀의 업무 자동화 도구. 저장소 `studio-baekho-tools`의 `Auto-3D-Tool` 브랜치에서 개발합니다.

[Notion 개발 기록](https://app.notion.com/p/3f32b4b0fef7818bb2f4e0616387554e): 각 작업 완료 후 문제·원인·수정·검증·남은 작업을 누적합니다.

Windows용 개인 제작 도구 프로토타입. Electron + React + TypeScript + Three.js, SQLite(sql.js), Tripo v3 API, Blender Python, Unity Editor C#으로 구성했습니다.

**정면 이미지 한 장에서 캐릭터 제작 전체를 이어서 실행하는 자동화 도구**가 목표입니다. 0.3.0은 기능별 Tripo 조작 화면 위주였던 방향을 수정해, 실제 Codex CLI 작업자와 Tripo Studio 브라우저를 연결하는 제작 엔진·검수·복구 화면을 추가합니다. 기존 API 요청 도구는 수동 도구로 유지합니다.

최신 사용자 요구: **멀티뷰 2D 애니메이션 이미지 시퀀스 → Codex Astra → Blender 3D 애니메이션**. 정면·측면·후면의 같은 동작 프레임과 타이밍을 Astra가 읽고, 모델의 리그에 포즈·키프레임·보간을 작성하는 방식입니다. 영상 파일이나 모션 캡처 서비스는 필수가 아니며, 프리셋 Idle/Walk로 대신하지 않습니다. 실제 AI 캐릭터 전체 제작과 결과 품질은 아직 검증하지 않았습니다.

## 실행

0.3.0 소스는 자동 제작 작업자를 포함합니다. Windows 폴더 빌드의 경로는 `release/0.3.0/win-unpacked/Partsmith.exe`입니다. 이전 앱을 닫고 새 파일을 실행하면 기존 사용자 저장소를 사용합니다. 폴더 전체가 필요하며 코드 서명·설치 프로그램은 제공하지 않는 로컬 테스트 빌드입니다. 버전별 실제 검증 범위는 [검증 기록](docs/VERIFICATION.md)을 확인하세요.

```powershell
cd 'C:\Users\김민준\Desktop\3D tool'
npm ci
npm run dev
```

```powershell
npm run build
npm start
npm test
npm run test:ui
node scripts/data-smoke.mjs
npm run package
```

`npm run dev`는 로컬 Vite와 Electron을 함께 실행합니다. Node 24.15.0에서 확인했습니다. `npm start`는 사전 빌드가 필요합니다. 설치한 패키지는 이 작업 폴더에만 있습니다.

## 가장 빠른 로컬 테스트

1. **새 프로젝트 → 로컬 데모 테스트 프로젝트**를 선택합니다.
2. **리깅 · 애니메이션 → 로컬 데모 리깅 실행**을 누릅니다. Blender가 마네킹, 뼈대, Idle·Walk를 실제로 생성하고 GLB·FBX·blend를 내보냅니다.
3. 뷰포트에서 동작을 선택하고 재생합니다. 데모는 절차적 마네킹이며 AI 생성물이 아닙니다.
4. **Unity로 보내기**에서 `C:\Unity\3D Tool Test`를 지정합니다.
5. **Unity 브리지 설치** 후 Unity 창을 활성화하여 스크립트 컴파일을 기다립니다. **Unity에 임포트**하면 실제 결과가 앱에 반환됩니다.
6. 임포트 후 미저장 씬이 없으면 전용 씬으로 잠시 Play Mode에 진입해 각 클립을 자동 검사하고 원래 씬으로 돌아옵니다. 미저장 씬이 있으면 검사를 건너뛰고 앱에 이유를 표시합니다. Unity 메뉴 **Tools → Partsmith → Play latest test scene**으로 변형을 직접 확인할 수도 있습니다.

## 캐릭터 자동 제작

1. 일반 프로젝트에서 **캐릭터 자동 제작**을 엽니다. 정면 이미지, 보존할 모습·비율·스타일, 원하는 동작, 단계별 보정 횟수를 입력합니다.
2. **실행 한도 · 연결**에서 Studio 브라우저를 열어 직접 로그인합니다. Codex는 기존 ChatGPT 로그인을 사용하는 로컬 CLI로 실행하며, 계정 사용량이 소모됩니다. 앱은 인증 토큰을 읽거나 복사하지 않습니다.
3. Studio 크레딧 상한을 정하고 **제작 흐름 준비**를 누릅니다. 이때는 계획과 입력 사본만 저장합니다. 준비한 범위·한도를 확인하고 **자동 제작 시작**을 누릅니다.
4. Codex 작업자가 파츠 분리, Studio 생성·검수·UV·텍스처, Blender 조립·수정, 최종 UV·텍스처·리깅, 멀티뷰 2D 동작 이미지, Astra 3D 동작 제작, Unity 검증을 의존 순서대로 처리합니다. 단계마다 산출물·검사 결과·시도 이력을 저장합니다.
5. 3D 애니메이션 단계는 `gpt-6-astra`로 실행합니다. 다른 단계는 기존 Codex 기본 모델을 유지합니다. 이미지 생성 도구나 Astra 접근이 없으면 실패 이유를 표시하고, 다른 모델·영상·프리셋으로 조용히 대체하지 않습니다.

앱을 켜 두어야 작업자가 실행됩니다. 멈춤은 로컬 작업자를 중지하며 이미 제출한 원격 생성·과금을 취소하지 않습니다. 종료 후 자동 재제출하지 않으며, 불명확한 유료 제출은 확인이 필요합니다. **산출물 파일·해시·필수 검사 통과**와 **실제 사람이 만족하는 외형·애니메이션 품질**은 별개의 검증입니다. 현재 통합 테스트는 모의 작업자·로컬 브라우저 화면을 사용하며 실제 Tripo 생성이나 완성 캐릭터의 품질을 증명하지 않습니다.

## 수동 도구 · 문제 해결

- **연결 설정**: 마스킹 입력, DPAPI 암호화 저장, 키 교체·삭제, 연결·API 잔액 확인. 보안 저장을 사용할 수 없으면 세션 한정으로 처리합니다.
- **Tripo 작업실 → 모델 생성**: Smart Mesh P2 Preview / P1 / HD, 텍스트·이미지·멀티뷰 입력, 삼각면·P2 사각면, 폴리곤 수·UV·텍스처·PBR·후보 수를 선택합니다. P2는 공식 v3 문서 지원이며 이 계정의 실제 생성 권한은 미검증입니다. 다른 모델로 자동 변경하거나 재결제하지 않습니다.
- **Tripo 후처리**: 메시 분할·스마트 분할·분할 부위 보완·리토폴로지·UV 패킹·텍스처·리깅·Idle/Walk·형식 변환을 원격 요청합니다. **Smart UV 영역은 공개 API에서 확인한 UV 패킹 범위**이며 Studio 전체 기능과 동일하지 않습니다.
- **결과 보관함**: 결과 선택·3D 재생·파츠 후보 적용·후속 Tripo 처리·Unity용 출력을 지원합니다. FBX 원본은 보존하고 Blender로 미리보기 GLB를 별도로 만듭니다. ZIP/OBJ/STL/USDZ/3MF 등은 원본 보관까지 지원하며 내장 미리보기나 바로 다음 단계 입력은 제한됩니다.
- **이미지 스튜디오**: 프롬프트, 모델·해상도·후보 수 선택, 유료 요청 검토, 생성 후보 선택, 선택 이미지를 추가 프롬프트로 수정, 이전 후보로 복귀. PNG/JPEG 가져오기도 지원합니다.
- **파츠 준비**: 전체 원본을 유지하고 드래그 crop 또는 클릭 다각형 마스크로 파츠 PNG를 만듭니다. 잘라낸 파츠는 가려진 면 복원 필요 상태로 표시됩니다.
- **조립 작업실**: 파츠별 이미지→3D 요청, 여러 후보 비교·선택·고정, 특정 파츠 재생성, GLB 가져오기, 숨기기·분리 보기, 변환 조작기와 수치 입력, 조합 저장·복원.
- **Blender로 조립**: 현재 표시 파츠를 같은 상대 배치로 가져와 목표 키에 균일 정규화하고 GLB·FBX·blend로 출력합니다. 오브젝트의 표면을 용접하지 않습니다. 변환·후보 변경 시 이전 출력은 오래된 버전으로 처리합니다.
- **리깅**: 최종 조립 GLB에 대한 Tripo 검사 → 리깅 → Idle/Walk 요청을 각각 검토·승인합니다. 모델 선택에서 완료된 결과를 고른 후 **Unity용 FBX로 변환**합니다. `.blend` 수동 보정 후 내보낸 GLB를 새 후보로 가져오는 경로도 제공합니다.
- **Unity**: FBX·텍스처 가져오기, URP 재질, Humanoid Avatar 검사, Animator Controller, 관리 Prefab, 사용자 Prefab Variant, 전용 테스트 씬, 재생 평가와 경고 반환.

## 데이터와 보안

실제 저장 경로는 **연결 설정 → 프로젝트 저장소**에 표시됩니다. 일반 실행은 Electron의 사용자 데이터 폴더를 사용합니다.

```text
userData/
  workbench.db                 SQLite 인덱스·프로젝트·작업·승인 기록
  tripo.key                    Windows DPAPI 암호화 데이터만
  projects/<UUID>/
    project.json               저장 형식 v1; 키 없음
    assets/<UUID>.*            Tripo 원본·수정본·파츠·후보
    previews/<ID>/model.glb    FBX 원본과 분리한 미리보기
    builds/<UUID>/             FBX, GLB, blend, textures, 검사 보고서
    production/<UUID>/         입력 사본, run.json, 공정별 산출물·검사·작업 이력
```

프로젝트 상단 다운로드 버튼은 폴더 전체를 별도 위치에 백업합니다. **프로젝트 열기**로 백업의 `project.json`을 복원할 수 있습니다. 같은 UUID가 이미 열려 있으면 중복 복원 대신 기존 목록을 사용합니다.

자동 제작 이력도 입력 사본·검증된 산출물·해시를 확인해 보관용으로 복원합니다. 가져온 백업의 편집 가능한 JSON을 원격 실행 승인으로 취급하지 않으므로 해당 실행은 중단 상태로 열립니다. 원격 Studio 로그인·비용 장부는 프로젝트 백업에 포함되지 않으며, 백업에서 자동으로 원격 작업을 재개하지 않습니다.

Electron은 `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`를 사용합니다. preload에 제한된 명령 인터페이스만 노출합니다. 생성 URL·API 키는 renderer에 직접 전달하지 않고 결과를 프로젝트 안에 내려받습니다. 로컬 파일 프로토콜은 등록된 프로젝트 에셋만 제공합니다.

## 문서와 디자인

- [메인 툴 연동 규격](docs/INTEGRATION.md)
- [검증 결과와 제한](docs/VERIFICATION.md)
- [공식 문서 근거](docs/API-SOURCES.md)
- [Tripo 기능·API 대응표와 지원 범위](docs/TRIPO-CAPABILITIES.md)
- [Figma 조립 작업실](https://www.figma.com/design/sBk7h2NHssstvG6KXWJuyP/3D-Tool?node-id=6-217)

Figma: 7개 1440×900 화면, Auto Layout, 색상 별칭·간격·글꼴 변수, 한국어 텍스트 스타일, 재사용 버튼과 7가지 상태. 앱 UI의 기본 색상·정보 구조를 공유합니다.

## 개발 디렉터리

```text
src/                         React UI, Three.js 뷰포트, 수동 마스크
shared/                      버전 1 명령·데이터 타입, 문서 기반 모델 목록
engine/                      SQLite, 제작 작업, Tripo, Blender·Unity 로컬 어댑터
electron/                    제한된 IPC, 파일 대화상자, DPAPI 키 저장
integrations/blender/        headless Python 처리
integrations/unity/Editor/   프로젝트에 설치하는 Editor 브리지
tests/                       승인·과금 중복 방지·복구 회귀 테스트
scripts/                     빌드·Electron/데이터/Unity 검증
artifacts/                   검증 보고서와 화면 캡처
```

기본 통합·번들 플러그인 설정은 변경하지 않았고 사용자 추가 blender/fal_ai/notion MCP도 활성화하지 않았습니다. Unity 검증용 CLI 바이너리는 `artifacts/runtime/tools`에 별도로 받아 체크섬을 검증했으며, 테스트 Unity 프로젝트에 `com.unity.pipeline`을 추가했습니다. 앱 자체는 이 CLI나 MCP 없이 Editor 브리지로 작동합니다.
