# Unity import adapter

Baekho의 제작·AI 생성·수정 화면은 외부 데스크톱 앱에서 실행됩니다. 이 작은 어댑터는 앱이 내보낸 배치 JSON을 Unity의 공식 `PrefabUtility`로 실제 `.prefab`으로 저장하는 마지막 단계입니다.

## 설치와 사용

1. Unity 프로젝트에 다섯 파일을 복사합니다. `Editor/BaekhoMapImporter.cs`, `Editor/BaekhoPropCatalog.cs`는 `Assets/Baekho/Editor/`로, `Runtime/BaekhoMapConnection.cs`, `Runtime/BaekhoGameplayMarker.cs`, `Runtime/BaekhoMapFixture.cs`는 `Assets/Baekho/Runtime/`에 설치합니다. 내보낸 ZIP에는 다섯 파일이 함께 들어 있습니다. **Window → Package Manager → Unity Registry**에서 **AI Navigation** (`com.unity.ai.navigation`)도 설치합니다. 해당 Unity 버전에 호환되는 패키지를 사용하세요.
2. Baekho 앱에서 내보낸 `.baekhomap.json`을 같은 Unity 프로젝트의 `Assets` 안에 복사합니다. 매핑한 원본 프리팹과 `.meta` GUID가 해당 프로젝트에 있어야 합니다.
3. Unity Project 창에서 JSON을 선택하고 **Assets → Baekho → Build Prefab**을 실행합니다. 맵 조립이 끝나면 루트에 `NavMeshSurface`를 추가하고 자동 베이크합니다.
4. JSON 옆에 생성된 프리팹을 씬에 배치하거나 런타임 맵 조합 시스템에서 사용합니다. 프리팹이 참조하는 `<프리팹 이름>.NavMesh.asset`도 함께 보관합니다. 같은 이름이 있으면 Unity가 새 이름을 붙이므로 기존 프리팹과 NavMesh 데이터는 덮어쓰지 않습니다.

Unity 2022.3 LTS 이상 및 Unity 6용 API로 작성했습니다. 실제 자동 검증 버전은 저장소 루트 README의 검증 항목을 참고하세요.

## 자동 NavMesh 베이크

- 기본 **Build Prefab**은 프로젝트에 등록된 첫 번째 Agent Type 설정을 사용합니다. 캐릭터의 `NavMeshAgent`에도 같은 Agent Type을 지정하세요. 반지름·높이·최대 경사·단차는 **Window → AI → Navigation**에서 해당 Agent Type의 설정을 조절합니다.
- `Collect Objects = Children`, `Use Geometry = Render Meshes`, 모든 레이어를 사용합니다. 조립된 맵의 활성 메시·Terrain으로 베이크하며 현재 편집 중인 씬의 다른 오브젝트는 포함하지 않습니다. 기존 `NavMeshModifier` 설정도 Unity의 수집 규칙에 따라 반영됩니다. Collider만 있는 지형은 메시를 제공하거나 생성된 Surface의 Geometry 설정을 바꿔 다시 베이크하세요.
- 원본 조각에 이미 `NavMeshSurface`가 있으면 생성된 인스턴스에서만 비활성화하여 루트의 새 데이터와 중복 등록되지 않게 합니다. 원본 프리팹과 기존 베이크 데이터는 수정하지 않습니다.
- 패키지가 없어도 임포터는 컴파일됩니다. 자동 베이크를 실행하면 설치 안내와 함께 중단되며, 미완성 프리팹을 저장하지 않습니다. 베이크 데이터나 프리팹 저장 실패 시 이번 작업에서 만든 에셋을 정리합니다.
- 생성된 프리팹은 씬에서 활성화되면 저장된 NavMesh를 로드합니다. 루트의 이동·회전은 지원하지만 **스케일은 1을 유지**하세요. 지형·장애물 배치나 캐릭터 크기 설정을 바꾸면 다시 베이크해야 합니다. 메시와 Agent 설정에 따라 통행 영역이 비어 있거나 끊길 수 있으므로 Unity에서 실제 이동 경로를 확인하세요.
- 각 맵 내부의 NavMesh를 생성하며, 여러 맵 사이의 연결은 자동으로 만들지 않습니다. 방 조합 후 연결문에 `NavMeshLink`를 배치하거나 전체 배치에 맞춰 다시 베이크합니다.
- 자동화에서는 `BuildFromPath(path, true, agentTypeID)`로 특정 Agent Type을 선택할 수 있습니다. 기본값 `-1`은 프로젝트의 첫 Agent Type입니다. 베이크 없이 기존 지형만 가져오려면 `BuildFromPath(path, false)`를 사용합니다.

바닥·천장 두께와 새 지형·게임 표식을 기존 맵에 적용하려면 새 앱에서 저장한 `.baekho.json`을 열어 ZIP을 다시 내보내세요. ZIP의 **다섯 스크립트를 같은 설치 위치에 업데이트**하고 새 JSON으로 **Build Prefab**을 다시 실행합니다. 이미 만들어진 프리팹은 자동으로 수정되지 않습니다. 기존 프로젝트의 배율·오프셋 값은 유지되며, 이전 버전 JSON은 이전 배치 방식을 유지합니다.

## 저장 동작

- 원본 에셋은 GUID로 확인하며, 실제 `Assets/.../*.prefab`이 없으면 생성을 중단합니다. 누락 에셋을 임시 큐브로 대체하지 않습니다.
- 원본 프리팹의 내부 구조·컴포넌트·머티리얼 및 중첩 프리팹 연결을 유지합니다.
- 형식 버전 3/4에서 `position.y`는 바닥 윗면 또는 벽·문·소품 아랫면의 목표 높이입니다. 가져오기 시 프리팹 경계를 측정하여 해당 면을 맞추므로 중앙 피벗의 에셋도 셀 높이 위아래로 배치됩니다. 앱의 Y 오프셋이 이미 더해진 값이며, 오프셋으로 기준면을 수동 이동할 수 있습니다. 새 계단·경사로는 `surface: bottom`으로 측정된 아랫면 중심을 맞춥니다. 이전 JSON의 피벗 배치는 유지합니다.
- 바닥의 실제 두께는 `cellSize × 0.12 × scale.y`입니다. 셀 간격 2m와 두께 배율 1이면 0.24m이며 바닥 윗면 아래로 두께가 생깁니다. 실제 경계 높이에 따라 루트 Y 스케일을 계산합니다. X/Z 스케일과 높이 맞춤이 없는 역할의 스케일은 JSON 값으로 덮어쓰며 원본 루트 Transform에 곱하지 않습니다. 내부 자식 Transform은 유지합니다.
- 경계는 활성 오브젝트의 켜진 `MeshRenderer`·`SkinnedMeshRenderer`에서 측정합니다. 측정할 렌더러가 없으면 활성 상태이고 Trigger가 아닌 `BoxCollider`·`MeshCollider`를 사용합니다. 두 방식 모두 측정할 수 없으면 가져오기를 중단합니다. 높이가 0인 원본 평면은 두께를 만들지 않고 평면 그대로 윗면 높이만 맞춥니다.
- 좌표는 맵 중심을 원점으로 하는 Unity 단위이며 Y가 위쪽, XZ가 바닥입니다. 열은 +X 방향, 행은 -Z 방향으로 증가하며 첫 행이 +Z 쪽입니다.
- 셀별 고도는 바닥 윗면·벽/문/소품 아랫면과 외향 문 소켓의 Y 좌표에 반영됩니다. `stair`는 원본 계단 프리팹을 해당 저단 높이와 Y 회전으로 배치합니다. 기본 계단은 +Z 방향으로 올라가는 기준점을 사용하며, 90°는 +X, 180°는 -Z, 270°는 -X 방향입니다.
- 계단의 원본 상승 높이(`stairNativeRise`)를 앱에 입력하면 앱이 각 계단의 최종 Y 스케일을 `rise / stairNativeRise`로 계산하여 JSON에 기록합니다. 어댑터는 이 최종 스케일을 그대로 적용합니다. 폭·깊이와 기준점은 원본 에셋에 맞춰 별도로 조정합니다.
- 기존 맵의 3D 편집 화면 받침 기둥과 계단 블록은 높이·동선을 확인하는 블록아웃입니다. 내보내기에서는 연결한 바닥·벽·계단 원본 에셋을 사용하므로 해당 에셋의 폭·길이·단차와 충돌체를 맞춰야 합니다.
- 새 구조·소품 맵은 형식 버전 5, 기존 맵은 버전 4를 사용하며 `root/Connections/<id>`에 외향 문 소켓을 저장합니다. 각 소켓에는 런타임 `StudioBaekho.BaekhoMapConnection` 컴포넌트와 공개 필드 `id`, `label`, `kind`, `width`, `height`가 있습니다. 형식 버전 1/2는 기존처럼 JSON 위치·Euler 각도·스케일을 루트에 그대로 적용하며 높이·두께를 보정하지 않습니다. 버전 1에서 GUID가 빈 `spawn`·`exit`는 이전과 같은 빈 마커로 저장합니다. 형식 버전 3은 기존 바닥 두께·면 정렬을 유지합니다.
- 버전 4의 `surface`는 `top`(윗면), `bottom`(아랫면), `pivot`(원본 피벗)을 선택합니다. 생략 시 바닥·다리는 윗면, 계단·경사로·조명은 피벗, 나머지는 아랫면입니다. 앱의 독립 구조물·장식은 명시적 `pivot`을 사용하여 원본 피벗을 보존합니다. `pivot`은 렌더러·충돌체가 없는 프리팹도 허용하며 경계 보정을 하지 않습니다.
- 천장은 `cellSize × 0.12 × scale.y` 두께로 맞추고 아랫면을 지정된 Y에 배치합니다. 다리는 상판 전용 프리팹의 윗면을 지정된 Y에 맞추고 JSON의 배율을 적용합니다. 난간이 상판 프리팹에 포함되면 난간 윗면이 경계가 되므로 난간은 별도 구조물로 배치하세요.
- 벽·절벽의 선택 필드 `fitHeight`는 실제 전체 높이(m)입니다. 원본 경계를 측정하여 Y 배율을 계산하며, 절벽의 `position.y`는 낮은 쪽 바닥입니다. 기본 절벽의 윗면은 낮은 Y + `fitHeight`가 됩니다. 높이가 0인 프리팹, 피벗 정렬과 높이 맞춤의 동시 사용, X/Z로 기울어진 높이 맞춤은 거부합니다. `fitHeight`가 없는 벽은 버전 3처럼 배율을 그대로 적용합니다.
- 셀보다 넓은 연결문은 전체 개구부에 문 프리팹 하나를 배치합니다. 버전 4의 문 전용 `fitWidth`는 원본 전체 경계의 로컬 X 폭을 지정한 미터 값에 맞추고 폭 방향 중심을 배치 위치에 정렬합니다. 이때 루트 X 배율을 계산하며 Y/Z 배율과 아랫면 정렬은 유지합니다. 한 셀 이하의 기존 문은 `fitWidth` 없이 기존 배치·배율을 유지합니다. 문틀을 포함한 전체 경계에 맞추므로 실제 통과 폭과 충돌체는 원본 프리팹에서 조정하세요.
- 조명은 반드시 원본 프리팹 GUID를 사용합니다. Light 컴포넌트만 있는 프리팹도 피벗 정렬로 배치할 수 있으며, 강도·색·범위·그림자 등 설정과 컴포넌트는 그대로 유지됩니다. 임포터는 새로운 Light를 만들지 않습니다.
- 게임 표식은 `root/GameplayMarkers/<id>`에 빈 오브젝트와 런타임 `StudioBaekho.BaekhoGameplayMarker`로 저장합니다. 공개 필드는 `id`, `label`, `kind`(`enemy`/`reward`/`event`), `contentKey`이며 위치·회전은 JSON을 그대로 사용합니다. 스폰, 피해, 보상, 스위치 동작, 통로 생성은 게임 프로젝트에서 구현합니다.
- 독립 구조물에는 `StudioBaekho.BaekhoMapFixture`의 공개 필드 `id`, `role`, `linkedId`를 저장합니다. `linkedId`는 같은 맵의 다른 배치 ID를 참조하며 스위치와 문 같은 연결을 게임 코드에서 해석할 수 있습니다. 대상이 없거나 자기 자신을 참조하면 가져오기를 거부합니다. 원본 프리팹은 변경하지 않고 생성된 인스턴스에만 메타데이터를 추가합니다.
- 전체 입력을 검증한 뒤 격리된 Preview Scene에서 생성하고 즉시 닫습니다. 편집 중인 씬에 결과물을 추가하거나 씬을 저장하지 않습니다.
- 파일 8 MiB 이하, 너비·높이 각 1–256, cellSize 0 초과 1000 이하, 배치 1–10,000개를 지원합니다. 버전 2/3/4는 소켓 1–1,600개가 필요합니다. 소켓 ID는 영문·숫자·`_`·`-`로 1–80자이며 중복할 수 없습니다. label은 제어 문자를 제외한 1–80자, kind는 영문·숫자·`_`·`-`로 1–40자입니다. 버전 4 소켓 너비는 0.25–40m이며 이전 버전은 0.25–10m 및 cellSize 이하입니다. 소켓 높이는 0.25–20m입니다. 버전 4는 빈 배열을 허용하는 필수 `markers` 배열(최대 10,000개)을 사용하며 표식 ID는 1–100자, label은 1–80자, contentKey는 0–200자입니다. 필수 필드 누락, 중복 ID, 잘못된 숫자, 0/음수 스케일, 잘못된 파일명은 거부합니다.
- 실패한 저장 결과는 제거하며 기존 에셋은 삭제하지 않습니다. 프리팹의 `ExecuteAlways` 같은 사용자 컴포넌트는 Unity 자체 동작에 따라 실행될 수 있습니다.

## 외향 문 소켓 사용

소켓 위치는 문이 차지하는 전체 셀의 **바깥쪽 모서리 중앙, 바닥 높이**입니다. 앱에서 문 폭이 셀보다 넓으면 `ceil(width / cellSize)`개의 인접 셀을 실제 `D` 개구부로 만듭니다. 저장 맵의 `x`, `row`는 시작 셀이며 0°/180°는 +X, 90°/270°는 +행 방향으로 이어집니다. 모든 셀의 바닥 높이·바깥 경계·안쪽 접근·천장 여유를 검증하며 문 소켓과 문 프리팹은 각각 하나입니다. 한 셀 이하에서는 기존 소켓 위치를 유지합니다.

소켓의 `transform.forward`(+Z)가 맵 바깥을 가리킵니다. JSON의 Y 회전은 0°(+Z), 90°(+X), 180°(-Z), 270°(-X) 중 하나이며 X/Z 회전은 0입니다. `width`와 `height`는 개구부 크기이며 소켓 Transform 스케일은 1입니다. 문 에셋의 배치 보정값은 소켓 위치에 더해지지 않으므로, 에셋의 피벗과 독립적으로 연결 기준을 사용할 수 있습니다.

게임에서는 `room.GetComponentsInChildren<StudioBaekho.BaekhoMapConnection>()`으로 소켓을 찾을 수 있습니다. 두 방의 호환되는 소켓을 같은 위치에 맞추고 바깥 방향을 서로 반대로 향하게 하면 방을 연결할 수 있습니다. `kind`와 크기 비교, 충돌 검사, 방 선택·조합, 복도 생성과 NavMesh 연결은 게임 프로젝트에서 구현합니다. 이 컴포넌트는 연결 정보를 보관하며 자동 배치 로직을 실행하지 않습니다. 조합 시 치수가 유지되도록 방 루트는 단위 스케일을 사용하는 것을 권장합니다.

자동화 진입점은 `StudioBaekho.BaekhoMapImporter.BuildFromPath("Assets/Maps/example.baekhomap.json")`이며, 새 프리팹의 Assets 상대 경로를 반환합니다. 임포터는 Editor 전용이고, 세 Runtime 컴포넌트는 게임 빌드에도 포함되어 생성된 프리팹의 메타데이터를 읽는 데 사용합니다. `Runtime` 파일을 `Editor` 폴더 안에 넣지 마세요.

API 참고: [PrefabUtility.InstantiatePrefab](https://docs.unity3d.com/2022.3/Documentation/ScriptReference/PrefabUtility.InstantiatePrefab.html), [PrefabUtility.SaveAsPrefabAsset](https://docs.unity3d.com/2022.3/Documentation/ScriptReference/PrefabUtility.SaveAsPrefabAsset.html).

## v5 구조와 소품 크기

- v5의 `fitSize`는 월드 XYZ 목표 크기이며 `position`은 그 경계의 중심입니다. 벽·절벽·하부 바닥·데드존에 사용합니다. 치우친 피벗은 경계 중심으로 보정하며 중첩 참조는 유지합니다.
- 데드존은 Trigger를 포함한 원본 Collider의 합집합을 측정합니다. 앱은 Collider나 사망 처리 컴포넌트를 만들지 않습니다.
- `Assets → Baekho → Export Prop Bounds Catalog`로 선택한 프리팹의 GUID·원본 XYZ 경계를 JSON으로 내보냅니다. 앱의 에셋 탭에서 가져오고 크기와 조건을 수정할 수 있습니다. 실제 소품 메시·상호작용·충돌은 게임 프로젝트에서 검증하세요.
- 경사로의 기울어진 옆면은 측면이 닫힌 원본 프리팹을 사용해야 합니다. 구조 채움은 직사각형 단차와 개구부를 처리합니다.

- 측정된 v5 소품은 `centerXZ: true`를 사용합니다. 렌더러·Collider(Trigger 포함)의 합집합을 카탈로그와 동일하게 측정해 XZ 중심과 아랫면을 맞추며 원본 배율은 바꾸지 않습니다. 기존 소품은 이 플래그 없이 원래 피벗 배치를 유지합니다.
