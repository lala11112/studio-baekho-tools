# 다른 Unity 프로젝트에서 Combat Lab 사용하기

Baekho Studio 앱과 공통 Unity 패키지는 프로젝트를 바꿔 사용할 수 있습니다. **게임마다 SO 구조·입력·명중 이벤트가 다르므로 실제 게임 전투에는 그 게임의 어댑터가 필요합니다.** 설치한 것만으로 임의의 게임을 자동 분석하거나 조작하지는 않습니다. 제공되는 Example 어댑터는 Four-Tiger-Sword 코드 없이 새 Unity 프로젝트에서 설치·후보 실행·녹화·내보내기 흐름을 확인할 수 있는 완성된 작은 데모입니다.

## 1. 공통 연결과 예제 설치

현재 패키지 기준은 Unity **6000.3 이상**이며, 검증 버전은 **6000.3.10f1**입니다. 프로젝트를 복사하거나 버전 관리에 저장하고 Unity가 컴파일 중이 아닐 때 설치하세요.

저장소를 받은 경우 저장소 루트에서 아래 명령을 실행합니다. 배포 앱을 받은 경우에는 exe 옆의 **`UnityIntegration` 폴더**를 열어 같은 명령을 실행합니다. 설치 후에는 이 저장소나 `UnityIntegration`의 원래 위치를 유지할 필요가 없습니다.

```powershell
./scripts/Install-CombatLab.ps1 -UnityProject 'D:/Unity/MyGame' -Adapter Example
```

`UnityProject`는 `Assets`, `Packages`, `ProjectSettings`를 포함하는 실제 Unity 프로젝트 폴더입니다. 상위 Git 저장소 폴더와 다를 수 있습니다. 경로에 공백이 있으면 위처럼 따옴표로 감싸세요.

설치 결과:

| 대상 | 설치되는 파일 |
|---|---|
| `Packages/com.studiobaekho.combat-lab` | 독립 복사된 embedded UPM 패키지: 브리지·실행·녹화·보고서 |
| `Assets/StudioBaekho/CombatLabExample/Runtime` | 빌드에도 사용할 수 있는 예제 SO·플레이어·훈련 표적 |
| `Assets/StudioBaekho/CombatLabExample/Editor` | 어댑터·세션·예제 씬 생성 메뉴 |

`Packages/manifest.json`은 수정하지 않습니다. 설치 파일은 프로젝트 버전 관리에 함께 넣을 수 있습니다. 기존 `.meta`는 덮어쓰지 않아 GUID를 유지합니다. 같은 파일로 다시 설치하면 변경하지 않습니다. 내용이 다른 파일이 있으면 **전체 복사 전에 중단**하고 경로를 표시합니다. 의도적으로 도구를 업데이트할 때만 `-Force`를 추가하세요.

```powershell
./scripts/Install-CombatLab.ps1 -UnityProject 'D:/Unity/MyGame' -Adapter Example -Force
```

이 경우 기존에 달랐던 파일을 프로젝트의 `CombatLabInstallBackups/<시각>-<ID>/`에 백업한 뒤 교체합니다. 기존 파일을 자동 삭제하지 않으므로 이전 배포에서 삭제·이름 변경된 C# 파일이 있다면 업데이트 내용을 확인하고 직접 정리하세요. 수정한 프로젝트 전용 어댑터는 별도 폴더·이름으로 유지하는 편이 좋습니다.

## 2. 독립 예제로 전체 흐름 확인

1. Unity에서 프로젝트를 열고 컴파일 완료를 기다립니다.
2. **Tools → Baekho → Combat Lab Example → Create Demo Scene**을 실행합니다. 현재 씬의 변경 사항이 있으면 Unity가 저장 여부를 묻습니다. 예제 SO와 저장된 씬은 `Assets/CombatLabExampleData`에 새로 생성됩니다. 기존 예제는 덮어쓰지 않습니다.
3. Game View를 열어 두고 Baekho Studio 앱에서 이 Unity 프로젝트를 선택합니다.
4. 어댑터 **Example / 기본 연결 예제**, 생성한 `Example Strike` SO, **훈련 표적 공격**을 선택합니다.
5. 예를 들어 “공격 간격은 짧고 넉백은 작게”라고 입력하여 AI 후보를 생성하고 비교 실행합니다. AI 생성에는 설치·로그인된 Codex CLI와 인터넷 연결이 필요합니다.
6. 피해량·공격 간격·밀리는 거리 후보를 영상과 실제 명중 이벤트로 비교합니다. 후보마다 새로운 Play Mode로 실행됩니다.
7. **새 프리셋 SO**로 내보내면 예제 어댑터는 별도의 `ExampleActionData` 에셋을 생성합니다. 예제 플레이어의 **Action Data**에 이 에셋을 연결하면 실제로 사용할 수 있습니다.

예제는 훈련 표적을 자동 공격합니다. 표적은 죽지 않고 제자리로 돌아오며, 밀려서 사거리 밖에 있으면 공격이 빗나갑니다. 피해 이벤트는 예제 플레이어가 실제로 명중시켰을 때만 기록됩니다. 게임의 입력·상태 머신·적 AI를 검증한 결과는 아닙니다.

예제 런타임 어셈블리는 `UnityEditor`나 Combat Lab 편집기 코드를 참조하지 않습니다. 내보낸 SO를 연결한 예제 플레이어를 게임 빌드에 포함할 수 있습니다. 편집기 어댑터와 씬 생성 도구는 빌드에서 제외됩니다.

## 3. 자신의 게임에 연결

예제를 시험한 뒤 자신의 SO와 컨트롤러에 맞게 어댑터를 구현합니다. 예제 어댑터를 유지한 채 별도의 게임 어댑터를 추가할 수도 있습니다. 공통 패키지만 설치하려면 다음을 사용합니다.

```powershell
./scripts/Install-CombatLab.ps1 -UnityProject 'D:/Unity/MyGame' -Adapter None
```

시작점은 [ExampleCombatAdapter.cs](../Integrations/Example/Editor/ExampleCombatAdapter.cs), [ExampleCombatSession.cs](../Integrations/Example/Editor/ExampleCombatSession.cs), [계약 인터페이스](../Packages/com.studiobaekho.combat-lab/Editor/CombatLabContracts.cs)입니다.

| 구현 부분 | 자신의 게임에 맞게 바꿀 내용 |
|---|---|
| `Id`, `DisplayName` | 프로젝트마다 고유하고 지속적으로 사용할 ID와 표시 이름 |
| `DiscoverSources()` | `AssetDatabase.FindAssets("t:YourFormSO")` 등으로 조정 가능한 원본 SO 검색; 에셋 GUID와 표시 이름 반환 |
| `DiscoverActions(sourceGuid)` | 일반 공격·스킬 등 실제 지원하는 동작과 사용할 수 없는 이유 |
| `Describe(sourceGuid, actionId)` | 해당 동작이 실제 사용하는 값의 ID·설명·단위·허용 범위·기준값 |
| `Validate(request)` | 선택 SO·후보 값·저장된 테스트 씬·플레이어·필수 컴포넌트 확인 |
| `Begin(request, candidate)` | SO를 복제하고 후보 값을 적용한 뒤 런타임 플레이어에 연결; 세션 생성 |
| `Tick(unscaledDeltaTime)` | 실제 게임 입력 또는 컨트롤러 API를 통해 이동·공격 요청 |
| `Metrics` | 실제 명중·피해 이벤트에서 횟수, 피해, 첫 명중 시각, 적용값 기록 |
| `Dispose()` | 이벤트 구독 해제, 원래 참조·설정 복원, 임시 객체 해제; 반복 호출에도 안전하게 구현 |
| `Export(...)` | 원본과 별개의 런타임용 SO 또는 프리셋을 새 경로에 저장 |

동작 선택을 지원할 때는 `ICombatLabActionAdapter`를 구현합니다. 공개 기본 생성자가 있는 구현은 자동 검색되며 별도의 중앙 등록 파일은 없습니다. 단일 동작만 있는 기존 `ICombatLabAdapter`도 지원합니다. 어댑터마다 ID가 중복되지 않도록 정하세요.

여러 동작에서 고른 후보를 한 에셋으로 합쳐 저장하려면 선택적 `ICombatLabMultiActionAdapter`도 구현하고 `ExportCombined(CombinedExportRequest request, string assetPath)`를 제공하세요. `CombatLab.ValidateCombinedData(request)`로 같은 어댑터·원본·중복 없는 동작·유효한 후보 선택을 검증한 다음, 게임에서 같은 필드를 수정하는 동작 조합도 거부해야 합니다. 원본을 한 번 복제한 뒤 서로 겹치지 않는 선택 동작의 값들을 적용하고, 결과 폼을 메인 SO로 새 파일 하나에 저장합니다. 공유 카메라 SO를 다르게 조절하는 동작은 별도 복사본이 필요하며 같은 파일의 subasset으로 넣을 수 있습니다. `FourTigerCombatAdapter.ExportCombined`가 구현 예시입니다. 지원 여부는 `describe`의 `adapter.supportsCombinedExport`로 표시됩니다. 이 인터페이스를 구현하지 않은 기존 어댑터의 단일 동작 흐름은 유지됩니다.

**원본 SO 보존:** `Instantiate(source)`는 참조하는 다른 SO까지 복제하지 않습니다. 중첩 공격·카메라·범위 데이터 SO를 수정한다면 그 객체도 복제하고 복제본끼리 연결해야 합니다. 실험 종료 시 복제한 모든 객체를 정리합니다. 내보낼 때는 수정된 참조 에셋까지 함께 저장해야 결과가 유지됩니다.

**씬과 입력:** 공통 실행기가 후보마다 Play Mode를 다시 시작합니다. 게임 어댑터는 테스트 씬의 시작 상태와 필요한 자원을 확인하고, 게임에 맞는 입력 방식과 종료 처리를 구현해야 합니다. Example의 `RequestAttack()` 호출을 그대로 두면 자신의 게임 플레이어는 조작되지 않습니다. 녹화·AI 생성만으로 입력 연결이 만들어지지는 않습니다.

**어셈블리 배치:** 게임 코드가 기본 `Assembly-CSharp`에 있으면 어댑터를 게임의 `Assets/.../Editor` 폴더에 두고 별도 asmdef를 만들지 않으면 됩니다. 게임 코드가 asmdef에 있다면 편집기 전용 asmdef에서 해당 런타임 어셈블리와 `StudioBaekho.CombatLab.Editor`를 참조하세요. 기본 `Assembly-CSharp`를 asmdef에서 직접 참조할 수는 없습니다. 예제는 독립적인 Runtime/Editor asmdef를 사용합니다.

새 어댑터를 적용한 뒤에는 기준값 실행, 값이 다른 후보 실행, 취소, 원본 SO가 바뀌지 않았는지, 내보낸 SO가 게임에서 사용되는지를 확인하세요. 다른 게임의 입력이나 SO 구조까지 자동 호환된다고 가정하지 마세요.

## Four-Tiger-Sword의 다른 체크아웃에 설치

동일 게임의 지원되는 SO·플레이어 구조를 사용하는 프로젝트라면 제공된 게임 어댑터를 선택합니다.

```powershell
./scripts/Install-CombatLab.ps1 -UnityProject 'D:/Unity/Four-Tiger-Sword' -Adapter FourTigerSword
```

이 모드는 공통 패키지와 `Assets/StudioBaekho/CombatLab/Editor`의 FourTiger 어댑터를 함께 설치합니다. FourTiger의 런타임 타입과 Input System을 참조하므로 관련 게임 코드가 없는 프로젝트에는 이 모드를 설치하지 마세요. 기존 설치를 최신 버전으로 바꿀 때 변경 파일을 먼저 확인한 뒤 `-Force`로 백업·교체할 수 있습니다.

Unity가 열린 상태에서 컴파일이 끝나고 테스트 씬이 저장되면 앱에서 그 프로젝트를 선택합니다. 결과는 각 프로젝트의 `CombatLabResults`에 별도로 저장됩니다. 앱은 exe 하나만이 아니라 **배포 폴더 전체**를 이동해야 합니다.

## 검증 범위

2026-10-08에 Four-Tiger-Sword 코드가 없는 새 Unity 6000.3.10f1 프로젝트에서 예제 설치·컴파일·어댑터/원본/동작 검색·새 SO 내보내기·두 후보의 개별 Play Mode 실행을 검증했습니다. 실제 명중·피해 이벤트와 적용값이 기록되었고 원본 SO와 저장된 씬이 보존되었습니다. 이 독립 프로젝트 자동 검증은 영상 녹화를 끈 상태로 수행했습니다. 자신의 게임용 어댑터와 렌더 파이프라인의 녹화는 해당 프로젝트에서 별도로 확인해야 합니다.

설치 스크립트는 첫 설치, 같은 파일 재설치, 변경 파일 감지 시 전체 중단, `-Force` 백업·교체, 기존 `.meta` 보존을 임시 프로젝트에서 확인했습니다.

여러 동작 저장을 추가한 공통 패키지 0.2.0에서도 선택적 인터페이스를 구현하지 않은 Example 어댑터로 위 설치·컴파일·SO 내보내기·두 후보 실행을 다시 통과했습니다. 기존 어댑터는 단일 동작으로 계속 사용할 수 있습니다.
