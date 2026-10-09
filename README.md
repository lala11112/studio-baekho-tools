# studio-baekho-tools
스튜디오 백호 게임개발팀의 업무 자동화 도구

## AutoHitTimer

애니메이션에서 공격 판정 구간을 제안하고 사인검의 공격 ScriptableObject에 기록하는 Windows 데스크톱 도구입니다.

**애니메이션 검색·파일 드롭 → Unity 두 시점 촬영 → Codex AI 분석 → 타임라인 검토 → 원본 적용 또는 복사 저장**

### 실행

필요 환경: Windows, Unity **6000.3.10f1**에서 컴파일 가능한 사인검 프로젝트, 로그인한 Codex CLI. AI는 기존 Codex 인증과 설정된 기본 모델을 사용합니다. 별도 API 키 입력은 없습니다.

```powershell
cd Apps/AutoHitTimer
pnpm install
pnpm start
```

배포용 앱 생성:

```powershell
pnpm package:win
```

결과는 `Apps/AutoHitTimer/dist/0.1.0/AutoHitTimer-win32-x64/AutoHitTimer.exe`입니다. **UnityIntegration 폴더를 포함한 전체 배포 폴더**를 복사하세요.

### Unity 연결

1. 사인검 프로젝트를 Unity에서 열고 컴파일 오류를 해결합니다. 플레이 모드를 종료합니다.
2. 앱에서 프로젝트 루트를 선택하고 **연결 모듈 설치**를 누릅니다. 또는 저장소 루트에서 아래 설치 스크립트를 실행합니다.
3. Unity로 돌아가 파일을 새로고침합니다. 부트스트랩이 Package Manager API로 `com.studiobaekho.auto-hit-timer`와 Newtonsoft JSON 의존성을 설치하고 사인검 어댑터를 복사합니다.
4. 컴파일이 끝나면 앱에서 목록을 새로고침하고, **저장된 열린 장면의 Animator**와 무기를 선택합니다. 캐릭터가 여러 개면 직접 선택합니다.

```powershell
./scripts/Install-AutoHitTimer.ps1 -UnityProject 'C:/path/to/Four-Tiger-Sword'
```

설치 경로는 프로젝트의 `AutoHitTimerIntegration`과 `Assets/StudioBaekho/AutoHitTimer*`입니다. 기존 패키지 의존성은 제거하지 않습니다. 설치 결과는 `Library/AutoHitTimerInstallResult.json`에 기록합니다. 다른 게임에는 별도 어댑터가 필요합니다.

현재 `feature/AutoHitTimer` 브랜치는 다른 자동화 도구를 포함하지 않습니다. 게임 프로젝트가 기존 Combat Lab의 로컬 패키지를 참조한다면 그 패키지가 실제 존재하는 경로를 유지해야 합니다. 이 도구의 설치가 누락된 다른 패키지를 대신 복구하지는 않습니다.

### 사용 방법

- 클립 이름이나 Animator 상태 이름을 검색하거나 `.fbx`/`.anim` 파일을 놓습니다. 같은 이름과 FBX 안의 여러 클립은 결과 목록에서 선택합니다. 외부 파일은 프로젝트의 도구용 Imports 폴더에 복사하여 가져옵니다.
- 외부 FBX의 Rig가 선택한 캐릭터와 맞지 않으면 이유를 표시합니다. Unity에서 해당 파일의 Rig/Avatar 설정을 맞춘 뒤 다시 검색하세요.
- 여러 클립을 작업 목록에 넣고 순차 분석합니다. 전체 동작은 24fps, 후보 경계는 60fps로 촬영합니다. 긴 클립은 촬영과 AI 입력을 나눠 처리합니다. 클립은 최대 120초, 프로젝트당 작업은 최대 300개입니다.
- 두 시점이 나란히 있는 프레임을 재생·저속 재생하고 타임라인의 시작·종료 경계를 수정합니다. **Space**는 재생, **←/→**는 촬영 프레임 이동입니다. 구간을 직접 추가·삭제할 수 있습니다.
- 기존 공격 보정에서는 SO와 공격 단계를 선택하고, 각 후보를 어느 기존 타격에 연결할지 확인합니다. 기존 타격을 연결하면 해당 데미지·피드백을 유지합니다. 새 타격은 공격 기본값을 상속하며, 타수 증가로 총 피해가 늘 수 있습니다.
- 새 공격 등록에서는 폼·공격 종류·기존 템플릿을 고릅니다. 길이를 벗어나는 템플릿 시간 설정은 화면에서 수정합니다. Animator 기본 레이어에 고유한 상태와 SO 공격 단계를 함께 만듭니다.
- 검토 완료를 표시하고 변경 내용·타수·피해 변화를 확인한 다음 저장합니다. **복사 저장이 기본값**입니다. 새 공격의 복사 저장에서는 SO와 Controller를 함께 복사하며, 결과 에셋을 게임에 연결하는 작업은 사용자가 수행합니다.

### 지원 범위

| 공격 | 지원 |
| --- | --- |
| 모든 폼 일반 콤보, 공중 착지 마무리, 반격 | 보정·신규 등록 |
| 화·금 폼 스킬 | 보정·신규 등록 |
| 금 폼 궁극기 | 보정·신규 등록 |
| 수 폼 강공격·스킬·궁극기, 목·토 특수 스킬, 버프 궁극기 | 사유 표시, 저장 제외 |

시간은 **공격 속도 배율 적용 전 초**입니다. 단일 클립, 상태 속도 1, 오프셋 0을 지원합니다. Blend Tree, Override Controller, 동적 속도·시간 파라미터, 미러링, 연속 단계의 동일 상태 재사용은 적용하지 않습니다. Humanoid는 유효한 Avatar, Generic은 맞는 바인딩 계층이 필요합니다.

AI는 시각적인 공격 활성 구간을 제안합니다. 실제 충돌 판정이나 게임 플레이를 측정하지 않으며, 60fps 촬영은 정확도 보장이 아닙니다. 가려지거나 애매한 동작·타격 없는 동작은 검토 상태로 남습니다. AI에 실제 촬영 이미지와 클립 정보가 전달됩니다.

### 저장·복구

- 분석 완료가 저장을 의미하지 않습니다. 확인한 결과만 Unity API로 저장합니다.
- 원본 SO·Controller·클립의 변경을 검사하여 오래된 결과 적용을 막습니다. 기존 타격의 데미지와 피드백은 유지하고 신규 타격의 `Damage`와 `PoiseDamage`는 0으로 설정해 기본값을 상속합니다.
- Unity Undo와 변경 전 스냅샷을 제공합니다. 저장 중 중단된 경우 **Tools → Studio Baekho → Auto Hit Timer → Recover Interrupted Save** 메뉴로 복구합니다. 불확실한 저장 요청은 자동 재전송하지 않습니다.
- 앱은 저장 요청 ID를 먼저 기록합니다. 재시작 후 브리지 응답과 어댑터 저장 저널을 조회해 완료·미실행·롤백·복구 필요를 구분하며, 결과가 불확실한 작업은 편집과 재분석을 잠급니다.
- 초안·작업 목록은 `%APPDATA%/StudioBaekho/AutoHitTimer`에 프로젝트별로 보존합니다. 이전 분석은 최대 5개 버전으로 기록합니다. 앱을 다시 열어도 중단된 분석을 자동 재실행하지 않습니다.
- 촬영 파일과 브리지 기록은 프로젝트 `Library/AutoHitTimerBridge`에 있습니다. Library를 삭제하면 촬영 프레임을 다시 만들어야 합니다. 원본 에셋과 최종 저장 결과는 Assets에 남습니다.

### 구조와 검증

- `Apps/AutoHitTimer`: Electron 화면, 프로젝트 연결, 분석 큐, Codex 이미지 분석, 초안 보존.
- `Packages/com.studiobaekho.auto-hit-timer`: Editor 전용 브리지, 검색·임포트, 게임 스크립트를 실행하지 않는 렌더 계층 촬영.
- `Integrations/FourTigerSword/AutoHitTimer`: 게임별 SO 매핑·변경 검토·등록·저장 및 회귀 시험.

브리지는 `Library/AutoHitTimerBridge/requests → processing → responses` 파일 mailbox를 사용합니다. 요청 ID, 만료 시간, 처리 영수증을 보존하며 UI에는 파일 시스템 권한을 노출하지 않습니다. 기존 Combat Lab과 실행·설정·통신 경로가 분리되어 있습니다.

```powershell
cd Apps/AutoHitTimer
pnpm test       # 시간 변환, 매핑 검증, 큐·검토·초안·통신 단위 시험
pnpm smoke      # 모의 데이터 기반 실제 Electron UI 조작 및 캡처
```

Unity 패키지의 `Tests/Editor`에는 EditMode 시험이 있습니다. 사인검 어댑터 회귀 시험은 **원본 게임과 분리된 검증 프로젝트**에서 `StudioBaekho.AutoHitTimer.FourTigerSword.FourTigerAutoHitTimerRegression.Run`을 실행합니다. 실제 AI 실행·Unity 렌더링과 모의 UI·AI 테스트는 별도로 기록합니다.

[검증 결과와 남은 검증 범위](Apps/AutoHitTimer/VALIDATION.md)에는 실제 Codex 24/60fps 분석 결과, 테스트 범위, 사람 기준 비교 도구 사용법을 기록했습니다. 사람 기준 정확도와 전체 게임 씬 통합은 아직 완료되지 않았습니다.
