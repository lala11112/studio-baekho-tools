# Baekho Studio

스튜디오 백호의 **독립 Windows 데스크톱 앱**입니다. 첫 모듈인 Combat Lab에서 원하는 타격감을 설명하면 **AI가 수치를 작성**합니다. 사용자가 후보 개수를 정하고 Unity에 실험을 요청한 뒤, 여러 플레이 영상과 측정값을 앱 안에서 비교합니다.

Unity에는 실행·녹화용 연결 패키지와 게임별 어댑터만 설치합니다. 기존 `Tools → Baekho → Combat Lab` 편집 창은 제거했습니다. 실제 게임 실행과 프리셋 생성에는 **해당 Unity 프로젝트가 열려 있어야 합니다.** 저장된 실험 기록은 Unity 연결 없이도 읽을 수 있습니다.

## 바로 실행

빌드된 앱은 `Desktop/dist/0.6.0/Baekho Studio-win32-x64/Baekho Studio.exe`입니다. 배포할 때는 exe가 들어 있는 **폴더 전체**를 복사하세요. Node.js를 별도로 설치할 필요는 없습니다. AI 후보 생성에는 설치·로그인된 Codex CLI와 인터넷 연결이 필요합니다.

1. Unity에서 Four-Tiger-Sword 프로젝트와 `Game Scene`을 열고 씬을 저장합니다.
2. Baekho Studio를 실행합니다. **프로젝트 선택**에서 `Assets`, `Packages`, `ProjectSettings`가 있는 프로젝트 루트를 선택합니다.
3. **실험 설계**에서 속성별 공격 데이터와 **테스트할 동작**을 고릅니다. 원하는 느낌과 **후보 수 2~12개**를 정합니다. 예: “화 속성 스킬을 묵직하게, 화면 흔들림은 절제해서”.
4. **AI 후보 생성**을 누릅니다. AI가 작성한 수치와 예상 효과를 읽고 후보당 실행 시간을 정합니다. 수치는 읽기 전용입니다.
5. **후보 비교 실행**을 누릅니다. 요청한 개수의 후보가 새로운 Play Mode에서 차례로 플레이·녹화됩니다.
6. **결과 비교**에서 전체 후보 영상을 함께 보거나 **동시 비교 개수**를 줄여 살펴봅니다. 첫 명중 정렬·느린 재생·실제 피해 이벤트를 지원합니다.
7. 선호 후보와 이유를 저장하거나 **새 프리셋 SO**로 내보냅니다.

속성·동작·목표·후보 수를 바꾸면 다시 생성해야 실행할 수 있습니다. 생성 중 취소할 수 있으며, 연결 실패나 잘못된 AI 응답은 오류로 표시합니다. 임의의 배율이나 난수로 대체하지 않습니다. 후보 개수에는 AI가 제안한 모든 후보가 포함되며, 기준 후보를 자동으로 끼워 넣지 않습니다.

AI 연결은 [Codex 비대화형 실행](https://learn.chatgpt.com/docs/non-interactive-mode)의 구조화된 출력을 사용합니다. 기존 Codex 로그인을 사용하며 앱에서 인증 파일을 읽거나 토큰을 복사하지 않습니다. 현재 PC는 로그인되어 있습니다. 다른 PC에서는 `codex login` 후 사용하세요. AI에는 목표·항목 설명·현재값·허용 범위를 전달하며, 이 단계에서 게임 소스나 플레이 영상을 분석하지는 않습니다.

실행 도중 취소할 수 있습니다. 앱을 닫아도 이미 시작한 Unity 실험은 계속 진행되며, 다시 열면 결과를 읽습니다. 녹화 중 Unity를 최소화하거나 Game View를 닫지 마세요. 씬/도메인 재로드를 모두 사용하는 Play Mode 설정이 필요합니다.

## 여러 공격을 하나의 폼 SO로 만들기

같은 원본 폼에서 여러 동작을 선택하면 **선택한 동작 수만큼 후보 생성 영역**이 표시됩니다. 각 동작마다 원하는 느낌과 후보 수를 따로 정하고 AI 후보를 생성하세요. 한 동작의 후보를 다시 생성해도 다른 동작의 후보는 유지됩니다.

각 동작의 **이 동작 후보 비교 실행**으로 결과를 확인하고 **이 동작의 최종 후보**를 하나씩 선택하세요. 마지막으로 **선택한 동작을 SO 하나로 저장**을 누르면 선택한 후보 값이 모두 들어 있는 새 폼 `.asset` 파일 하나가 생성됩니다. 파일의 메인 객체는 실제 `WaterFormActionDataSO` 등의 폼 SO이므로 플레이어의 해당 폼 참조에 바로 연결할 수 있습니다. 수정된 카메라 프로필이 필요하면 같은 파일 안에 포함합니다. 원본 SO와 선택하지 않은 동작은 보존합니다.

전체 일반 콤보와 개별 일반 타격은 같은 데이터를 수정하므로 함께 선택할 수 없습니다. 예를 들어 **일반 1타 + 일반 3타 + 스킬 + 궁극기** 또는 **전체 콤보 + 스킬 + 궁극기**로 선택하세요. 서로 다른 원본 폼은 한 SO로 합칠 수 없습니다. 모든 선택 동작에 유효한 후보를 생성하고 최종 후보를 골라야 합쳐 저장할 수 있습니다.

여러 동작 저장은 어댑터의 `ICombatLabMultiActionAdapter` 지원이 필요합니다. Four-Tiger-Sword는 지원하며, 다른 게임의 기존 단일 동작 어댑터도 계속 사용할 수 있습니다. Unity 연결 패키지와 게임 어댑터를 함께 업데이트하세요.

## Unity 연결 설치

현재 검증 대상은 Unity 6000.3.10f1 / Input System 1.18.0 / Four-Tiger-Sword입니다. 현재 로컬 게임 프로젝트에는 연결이 설치되어 있습니다.

다른 체크아웃에 설치할 때:

1. Unity Package Manager의 **Install package from disk**로 `Packages/com.studiobaekho.combat-lab/package.json`을 선택합니다.
2. 이 저장소의 PowerShell에서 게임별 연결 코드를 복사합니다.

```powershell
./scripts/Install-FourTigerAdapter.ps1 -UnityProject 'C:/path/to/Four-Tiger-Sword/Four-Tiger-Sword'
```

3. Unity 컴파일이 끝나면 앱에서 해당 프로젝트를 선택합니다. 별도의 Unity 편집 창을 열 필요는 없습니다.

게임 코드가 Assembly-CSharp에 있으므로 어댑터는 게임의 `Assets/StudioBaekho/CombatLab/Editor`에 설치됩니다. 공통 패키지는 게임 타입을 참조하지 않습니다. 다른 게임에는 해당 게임의 `ICombatLabAdapter` / `ICombatLabSession` 구현이 필요합니다.

## 다른 Unity 프로젝트에서 사용하기

Unity 6000.3 이상 프로젝트에 공통 패키지와 독립 실행 예제를 설치할 수 있습니다. 프로젝트를 닫은 상태에서 이 저장소 루트에서 실행하세요.

```powershell
./scripts/Install-CombatLab.ps1 -UnityProject 'C:/path/to/MyGame' -Adapter Example
```

공통 패키지는 대상 프로젝트의 `Packages`에 복사되므로 이 도구 저장소의 로컬 경로에 의존하지 않습니다. Unity를 연 뒤 **Tools → Baekho → Combat Lab Example → Create Demo Scene**으로 예제 씬을 만들고, Baekho Studio에서 해당 프로젝트와 예제 어댑터를 선택하면 후보 생성·실행·결과 비교를 확인할 수 있습니다. 배포 앱에도 `UnityIntegration` 폴더가 포함되므로 저장소 없이 그 폴더에서 같은 설치 명령을 실행할 수 있습니다.

자신의 게임 전투를 실험하려면 예제의 SO 탐색·수치 적용·자동 플레이·피해 이벤트를 그 게임에 연결해야 합니다. 서로 다른 게임의 상태 머신과 입력을 자동으로 추측하지는 않습니다. 게임 연결은 어댑터에만 구현하며 앱과 공통 패키지를 수정할 필요가 없습니다. 공통 패키지만 설치하려면 `-Adapter None`을 사용하세요. 업데이트 및 어댑터 구현 방법은 [다른 프로젝트 연결 가이드](docs/reusing-combat-lab.md)에 있습니다.

## 현재 지원 범위

- 수·화·목·금·토 속성의 전체 일반 콤보, 개별 일반 타격, 스킬, 궁극기와 수 속성 강공격.
- 선택한 동작에서 사용하는 항목만 AI가 조정합니다. 일반 타격은 넉백·카메라·히트스톱, 목 스킬은 끌어당김, 버프형 궁극기는 실제 강화 설정을 사용합니다.
- 원본 SO를 보존하는 런타임 복제 실험과 AI의 2~12개 후보 생성.
- 가상 입력 → 기존 입력 처리 → 실제 플레이어 상태 머신으로 접근·공격·콤보 요청.
- 후보별 새 Play Mode, 피해 이벤트·실제 적용값·게임 시간과 실시간 기록.
- 히트스톱을 포함하는 실시간 MP4 녹화, 여러 후보의 동시 영상 비교, 판단 기록.
- 동작별 실험 JSON 입출력, 단일 후보의 새 프리셋 SO 내보내기, 여러 동작의 선택 후보를 새 폼 SO 하나로 저장.

수치 생성은 **Codex AI**, 자동 플레이는 현재 **규칙 기반**입니다. 생성 이유는 예상 효과이며 실제 타격감의 평가가 아닙니다. 영상까지 AI가 평가하여 자동 개선하는 반복 루프, 강화학습, 회피/패링, 공중 공격, 장애물 우회는 아직 포함하지 않습니다. 적 AI와 프레임 차이가 있어 동일 시드도 동일 전투를 보장하지 않습니다.

개별 일반 타격은 실행 복사본에 해당 단계만 남겨 따로 반복합니다. 스킬·궁극기·강공격에 필요한 자원은 실행 시작에 준비하고 실제 재사용 대기시간은 유지합니다. 화·토·목의 버프형 궁극기는 R 입력 후 일반 공격으로 효과를 관찰합니다. 실행 준비와 후속 공격은 결과에 기록됩니다. 데이터가 없거나 프로젝트에서 구현되지 않은 동작은 이유와 함께 사용할 수 없다고 표시합니다.

새 폼 SO의 `Actions`, `CommonBalance/CommonExecution/CommonFeedback`, `FormBalance/FormExecution/FormFeedback`와 공격·개별 타격의 `Balance/Execution/Feedback` 구조를 사용합니다. 선택 동작의 히트스톱은 `Feedback.HitStop`에 적용하며 활성화된 개별 타격 override에도 반영합니다. 기존 유효 시간 배율은 유지하고 플레이어 공통 설정은 변경하지 않습니다. 화면의 히트스톱 기준값은 선택 동작의 첫 유효 타격이며, 후보의 한 값은 선택 동작의 모든 타격에 적용됩니다.

플레이어가 없는 씬에서 에셋을 조회·내보내면 상속된 히트스톱은 게임 선언 기본값(0.25초, timeScale 0)을 기준으로 삼습니다. 해당 게임 씬의 플레이어 설정을 반영하려면 그 씬을 연 상태에서 후보를 생성·내보내세요.

단일 동작 프리셋의 `actionAsset`은 히트스톱까지 포함하는 선택한 폼의 복제 SO이며 `actionId`에 대상 동작을 보관합니다. 게임에 채택할 때 프리셋 아래의 폼 SO를 플레이어의 해당 폼 참조에 연결하세요. 여러 동작 저장은 폼 SO 자체가 파일의 메인 객체이므로 저장된 파일을 바로 연결합니다. 두 방식 모두 새 에셋을 생성하며 원본 설정에 자동 적용하지 않습니다. 이전 실험 JSON의 ID는 계속 읽을 수 있지만, 새 적용 방식으로 재실행되므로 후보를 다시 생성하는 것을 권장합니다.

## 결과와 구조

게임 프로젝트의 `CombatLabResults/<run-id>/`에 다음 파일을 저장합니다.

| 파일 | 내용 |
|---|---|
| `request.json` | 고정된 요청·후보 수치·AI 생성 목표와 시각·제안 이유 |
| `source-snapshot.json` | 기준 공격 데이터 |
| `scene-dependency-hash.txt` | 시작 시 씬 의존성 해시 |
| `report.json` | 실행 상태·피해 이벤트·적용값·경고 |
| `<candidate-id>.mp4` | 플레이 영상 |
| `judgment.json` | 사용자가 선택한 후보와 이유 |
| `index.html` | 별도로 보관할 수 있는 이전 형식 비교 보고서 |

```text
Desktop/                                    독립 앱: 워크스페이스·Combat Lab 화면·로컬 통신
Packages/com.studiobaekho.combat-lab/Editor/  Unity 연결·계약·실행·녹화·보고서
Packages/com.studiobaekho.combat-lab/Runtime/ 에디터 실행용 캡처 컴포넌트
Integrations/FourTigerSword/Editor/          현재 게임의 설정·플레이 연결
Tests/                                     Unity 회귀 검증
Desktop/tests/                             앱의 파일·연결·결과 검증
scripts/                                   설치·실행 지원
docs/                                      프로젝트 분석·연결 프로토콜
```

향후 메인 개발 툴의 다른 기능은 `Desktop`의 모듈로 추가하고, 게임별 차이는 어댑터에 둡니다. `Integrations/Example`에는 게임 코드 의존성이 없는 전투 예제를 제공합니다. [다른 프로젝트 연결 가이드](docs/reusing-combat-lab.md), [연결 구조와 API](docs/desktop-bridge.md), [현재 게임 분석과 검증 기록](docs/four-tiger-sword-analysis.md)을 참고하세요.

## 앱 개발

Node.js 22.12 이상과 pnpm 11 기준입니다.

```powershell
cd Desktop
pnpm install
pnpm test
pnpm start --project 'C:/path/to/UnityProject'
pnpm package:win
```

`pnpm-workspace.yaml`은 Electron 설치 스크립트 실행을 허용합니다. 빌드는 `Desktop/dist/<version>`에 생성되며 기존 출력 폴더가 있으면 덮어쓰지 않습니다. Electron/패키징 도구는 정확한 버전과 lockfile로 고정합니다.

Unity 회귀 검증은 `Tests/*.cs`와 `Integrations/FourTigerSword/Tests~`를 Unity Pipeline의 `run_script`로 실행합니다. 앱의 명시적 개발 진단 모드 `--diagnostic-output <절대 JSON 경로>`는 Unity 연결, 실제 앱 화면과 여러 영상의 재생·탐색을 검사한 뒤 종료합니다. `--diagnostic-ai`를 추가하면 실제 AI로 후보 4개를 생성합니다. `--diagnostic-run`까지 추가하면 그 후보를 실제 플레이하므로 저장된 테스트 씬에서만 사용하세요. `--diagnostic-source <GUID 또는 이름 일부>`, `--diagnostic-action <동작 ID>`, `--diagnostic-count <2~12>`, `--diagnostic-duration <3~60>`으로 검증 대상을 지정할 수 있습니다.

여러 동작 진단에는 `--diagnostic-multi --diagnostic-export-asset Assets/ExistingFolder/NewCombined.asset`를 사용합니다. 실제 AI로 수 폼의 일반 1타와 스킬 후보를 각각 두 개 생성하고, 최종 후보를 달리 선택해 지정한 새 파일 하나로 저장합니다. 대상 폴더가 있어야 하며 기존 파일은 덮어쓰지 않습니다. `--diagnostic-multi-run`을 추가하면 두 동작의 모든 후보를 각각 3초씩 실제 플레이합니다. 이 진단은 저장 대화상자만 지정한 경로로 대체하며 일반 내보내기의 검증은 그대로 수행합니다.

성공한 여러 동작 진단 JSON을 `--diagnostic-multi-replay <절대 경로>`로 지정하면 그때 생성한 실제 AI 후보를 JSON 불러오기로 다시 열고 저장된 실제 결과에서 최종 후보를 선택합니다. AI를 다시 호출하지 않고 Unity의 소수점 직렬화와 결과 선택·통합 저장 경로를 재검증하는 용도입니다.

`Desktop/scripts/action-smoke.cjs`는 기준값으로 선택 동작의 입력 경로만 확인하는 명시적 개발 검사입니다. 앱의 AI 생성 경로를 대체하지 않습니다. 저장된 씬과 편집 모드에서 `node Desktop/scripts/action-smoke.cjs <프로젝트> <결과.json> Fire:skill Water:heavy`처럼 실행합니다.
