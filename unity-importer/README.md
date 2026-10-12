# Unity import adapter

Baekho의 제작·AI 생성·수정 화면은 외부 데스크톱 앱에서 실행됩니다. 이 작은 어댑터는 앱이 내보낸 배치 JSON을 Unity의 공식 `PrefabUtility`로 실제 `.prefab`으로 저장하는 마지막 단계입니다.

## 설치와 사용

1. Unity 프로젝트에 두 파일을 복사합니다. `Editor/BaekhoMapImporter.cs`는 `Assets/Baekho/Editor/BaekhoMapImporter.cs`로, `Runtime/BaekhoMapConnection.cs`는 `Assets/Baekho/Runtime/BaekhoMapConnection.cs`로 설치합니다. 내보낸 ZIP에는 두 파일이 함께 들어 있습니다. 별도 패키지는 필요하지 않습니다.
2. Baekho 앱에서 내보낸 `.baekhomap.json`을 같은 Unity 프로젝트의 `Assets` 안에 복사합니다. 매핑한 원본 프리팹과 `.meta` GUID가 해당 프로젝트에 있어야 합니다.
3. Unity Project 창에서 JSON을 선택하고 **Assets → Baekho → Build Prefab**을 실행합니다.
4. JSON 옆에 생성된 프리팹을 씬에 배치하거나 런타임 맵 조합 시스템에서 사용합니다. 같은 이름이 있으면 Unity가 새 이름을 붙이므로 기존 프리팹은 덮어쓰지 않습니다.

Unity 2022.3 LTS 이상 및 Unity 6용 API로 작성했습니다. 실제 자동 검증 버전은 저장소 루트 README의 검증 항목을 참고하세요.

0.3.1의 바닥 두께·높이 맞춤을 기존 맵에 적용하려면 새 앱에서 저장한 `.baekho.json`을 열어 ZIP을 다시 내보내세요. ZIP의 **두 스크립트를 같은 설치 위치에 업데이트**하고 새 JSON으로 **Build Prefab**을 다시 실행합니다. 이미 만들어진 프리팹은 자동으로 수정되지 않습니다. 기존 프로젝트의 배율·오프셋 값은 유지되며, 이전 버전 JSON은 이전 배치 방식을 유지합니다.

## 저장 동작

- 원본 에셋은 GUID로 확인하며, 실제 `Assets/.../*.prefab`이 없으면 생성을 중단합니다. 누락 에셋을 임시 큐브로 대체하지 않습니다.
- 원본 프리팹의 내부 구조·컴포넌트·머티리얼 및 중첩 프리팹 연결을 유지합니다.
- 새 형식 버전 3에서 `position.y`는 바닥 윗면 또는 벽·문·소품 아랫면의 목표 높이입니다. 가져오기 시 프리팹 경계를 측정하여 해당 면을 맞추므로 중앙 피벗의 에셋도 셀 높이 위아래로 배치됩니다. 앱의 Y 오프셋이 이미 더해진 값이며, 오프셋으로 기준면을 수동 이동할 수 있습니다. 계단은 기존 저단 피벗 위치를 사용합니다.
- 바닥의 실제 두께는 `cellSize × 0.12 × scale.y`입니다. 셀 간격 2m와 두께 배율 1이면 0.24m이며 바닥 윗면 아래로 두께가 생깁니다. 실제 경계 높이에 따라 루트 Y 스케일을 계산합니다. X/Z 스케일과 다른 역할의 스케일은 JSON 값으로 덮어쓰며 원본 루트 Transform에 곱하지 않습니다. 내부 자식 Transform은 유지합니다.
- 경계는 활성 오브젝트의 켜진 `MeshRenderer`·`SkinnedMeshRenderer`에서 측정합니다. 측정할 렌더러가 없으면 활성 상태이고 Trigger가 아닌 `BoxCollider`·`MeshCollider`를 사용합니다. 두 방식 모두 측정할 수 없으면 가져오기를 중단합니다. 높이가 0인 원본 평면은 두께를 만들지 않고 평면 그대로 윗면 높이만 맞춥니다.
- 좌표는 맵 중심을 원점으로 하는 Unity 단위이며 Y가 위쪽, XZ가 바닥입니다. 열은 +X 방향, 행은 -Z 방향으로 증가하며 첫 행이 +Z 쪽입니다.
- 셀별 고도는 바닥 윗면·벽/문/소품 아랫면과 외향 문 소켓의 Y 좌표에 반영됩니다. `stair`는 원본 계단 프리팹을 해당 저단 높이와 Y 회전으로 배치합니다. 기본 계단은 +Z 방향으로 올라가는 기준점을 사용하며, 90°는 +X, 180°는 -Z, 270°는 -X 방향입니다.
- 계단의 원본 상승 높이(`stairNativeRise`)를 앱에 입력하면 앱이 각 계단의 최종 Y 스케일을 `rise / stairNativeRise`로 계산하여 JSON에 기록합니다. 어댑터는 이 최종 스케일을 그대로 적용합니다. 폭·깊이와 기준점은 원본 에셋에 맞춰 별도로 조정합니다.
- 3D 편집 화면의 받침 기둥과 계단 블록은 높이·동선을 확인하는 블록아웃입니다. 내보내기에서는 연결한 바닥·벽·계단 원본 에셋을 사용하므로 해당 에셋의 폭·길이·단차와 충돌체를 맞춰야 합니다.
- 새 내보내기는 형식 버전 3을 사용하며 `root/Connections/<id>`에 외향 문 소켓을 저장합니다. 각 소켓에는 런타임 `StudioBaekho.BaekhoMapConnection` 컴포넌트와 공개 필드 `id`, `label`, `kind`, `width`, `height`가 있습니다. 형식 버전 1/2는 기존처럼 JSON 위치·Euler 각도·스케일을 루트에 그대로 적용하며 높이·두께를 보정하지 않습니다. 버전 1에서 GUID가 빈 `spawn`·`exit`는 이전과 같은 빈 마커로 저장합니다.
- 전체 입력을 검증한 뒤 격리된 Preview Scene에서 생성하고 즉시 닫습니다. 편집 중인 씬에 결과물을 추가하거나 씬을 저장하지 않습니다.
- 파일 8 MiB 이하, 너비·높이 각 1–256, cellSize 0 초과 1000 이하, 배치 1–10,000개를 지원합니다. 버전 2/3은 소켓 1–1,600개가 필요합니다. 소켓 ID는 영문·숫자·`_`·`-`로 1–80자이며 중복할 수 없습니다. label은 제어 문자를 제외한 1–80자, kind는 영문·숫자·`_`·`-`로 1–40자입니다. 소켓 너비는 0.25–10m 및 cellSize 이하, 높이는 0.25–20m입니다. 필수 필드 누락, 중복 ID, 잘못된 숫자, 0/음수 스케일, 잘못된 파일명은 거부합니다.
- 실패한 저장 결과는 제거하며 기존 에셋은 삭제하지 않습니다. 프리팹의 `ExecuteAlways` 같은 사용자 컴포넌트는 Unity 자체 동작에 따라 실행될 수 있습니다.

## 외향 문 소켓 사용

소켓 위치는 문 셀의 **바깥쪽 모서리 중앙, 바닥 높이**입니다. 소켓의 `transform.forward`(+Z)가 맵 바깥을 가리킵니다. JSON의 Y 회전은 0°(+Z), 90°(+X), 180°(-Z), 270°(-X) 중 하나이며 X/Z 회전은 0입니다. `width`와 `height`는 개구부 크기이며 소켓 Transform 스케일은 1입니다. 문 에셋의 배치 보정값은 소켓 위치에 더해지지 않으므로, 에셋의 피벗과 독립적으로 연결 기준을 사용할 수 있습니다.

게임에서는 `room.GetComponentsInChildren<StudioBaekho.BaekhoMapConnection>()`으로 소켓을 찾을 수 있습니다. 두 방의 호환되는 소켓을 같은 위치에 맞추고 바깥 방향을 서로 반대로 향하게 하면 방을 연결할 수 있습니다. `kind`와 크기 비교, 충돌 검사, 방 선택·조합, 복도 생성과 NavMesh 연결은 게임 프로젝트에서 구현합니다. 이 컴포넌트는 연결 정보를 보관하며 자동 배치 로직을 실행하지 않습니다. 조합 시 치수가 유지되도록 방 루트는 단위 스케일을 사용하는 것을 권장합니다.

자동화 진입점은 `StudioBaekho.BaekhoMapImporter.BuildFromPath("Assets/Maps/example.baekhomap.json")`이며, 새 프리팹의 Assets 상대 경로를 반환합니다. 임포터는 Editor 전용이고, `BaekhoMapConnection`은 게임 빌드에도 포함되어 생성된 프리팹의 소켓 정보를 읽는 데 사용합니다. `Runtime` 파일을 `Editor` 폴더 안에 넣지 마세요.

API 참고: [PrefabUtility.InstantiatePrefab](https://docs.unity3d.com/2022.3/Documentation/ScriptReference/PrefabUtility.InstantiatePrefab.html), [PrefabUtility.SaveAsPrefabAsset](https://docs.unity3d.com/2022.3/Documentation/ScriptReference/PrefabUtility.SaveAsPrefabAsset.html).
