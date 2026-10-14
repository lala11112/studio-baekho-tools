import { randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { buildManifest, parseProjectFile, validateMap } from '../../src/shared/map';
import type { ProjectFile, ScanResult } from '../../src/shared/types';
import { decodePngDataUrl, MAX_IMAGE_BYTES, publicProject } from './validation';
import { verifyBindingProvenance } from './unity-project';

export const MAX_PROJECT_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 8 + 2 * 1024 * 1024;
export const MAX_PROJECT_COLLECTION_COUNT = 8;
export const MAX_PROJECT_COLLECTION_BYTES = 128 * 1024 * 1024;

export function normalizeProject(value: unknown): ProjectFile {
  return publicProject(parseProjectFile(value));
}

function serializeNormalizedProject(project: ProjectFile): string {
  const json = JSON.stringify(project, null, 2);
  if (Buffer.byteLength(json, 'utf8') > MAX_PROJECT_BYTES) throw new Error('프로젝트 파일이 너무 큽니다. 설계도 크기를 줄여 주세요.');
  return json;
}

export function serializeProject(value: unknown): string {
  return serializeNormalizedProject(normalizeProject(value));
}

/** Each ZIP entry is an ordinary project; no Unity scan is required to save editable candidates. */
export function createProjectCollection(value: unknown): Uint8Array {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PROJECT_COLLECTION_COUNT)
    throw new Error('한 번에 저장할 맵 후보를 1~8개 선택해 주세요.');
  const files: Record<string, Uint8Array> = Object.create(null);
  const names: string[] = [];
  let totalBytes = 0;
  for (let index = 0; index < value.length; index++) {
    let project: ProjectFile;
    let serialized: string;
    try {
      project = normalizeProject(value[index]);
      serialized = serializeNormalizedProject(project);
    } catch (error) {
      throw new Error(`${index + 1}번째 맵 후보: ${error instanceof Error ? error.message : '프로젝트를 저장할 수 없습니다.'}`);
    }
    totalBytes += Buffer.byteLength(serialized, 'utf8');
    if (totalBytes > MAX_PROJECT_COLLECTION_BYTES) throw new Error('선택한 맵 후보의 전체 크기가 128 MiB를 넘습니다. 후보 수나 설계도 크기를 줄여 주세요.');
    const safeName = Array.from(project.map.name.slice(0, 128).normalize('NFC').replace(/[^\p{L}\p{N} _-]/gu, '-'))
      .slice(0, 64).join('').replace(/^[ _-]+|[ _-]+$/g, '') || 'Map';
    const name = `${String(index + 1).padStart(2, '0')}-${safeName}.baekho.json`;
    names.push(name);
    files[name] = strToU8(serialized);
  }
  const readme = `BAEKHO MAP — 선택한 맵 후보\n\n이 ZIP에는 선택한 ${names.length}개의 편집 가능한 Baekho 프로젝트가 들어 있습니다.\n\n1. ZIP을 새 폴더에 압축 해제합니다.\n2. Baekho Map Forge의 열기에서 원하는 .baekho.json 파일을 선택합니다.\n3. 각 맵을 수정한 뒤 기존 저장 기능으로 개별 저장할 수 있습니다.\n4. Unity 프리팹이 필요하면 해당 프로젝트를 열고 원본 Unity 프로젝트를 다시 스캔한 뒤 Unity 번들을 내보내세요.\n\n맵 설정, 에셋 연결·배율, 천장·벽 조명 구분, 설계도와 진행 중인 설계도가 각 프로젝트에 보존됩니다. 원본 Unity 프리팹은 포함되지 않습니다. 미완성 맵도 저장할 수 있으며 Unity 내보내기 전에 맵 오류를 수정해야 합니다.\n번호는 선택 목록의 저장 순서이며 파일명이 같은 후보도 각각 보존됩니다.\n\n포함된 프로젝트\n${names.map(name => `- ${name}`).join('\n')}\n`;
  files['README.txt'] = strToU8(readme);
  if (totalBytes + files['README.txt'].byteLength > MAX_PROJECT_COLLECTION_BYTES)
    throw new Error('선택한 맵 후보의 전체 크기가 128 MiB를 넘습니다. 후보 수나 설계도 크기를 줄여 주세요.');
  const collection = zipSync(files, { level: 6 });
  if (collection.byteLength > MAX_PROJECT_COLLECTION_BYTES) throw new Error('저장할 ZIP 크기가 128 MiB를 넘습니다. 후보 수나 설계도 크기를 줄여 주세요.');
  return collection;
}

export async function readProject(filePath: string): Promise<ProjectFile> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size > MAX_PROJECT_BYTES) throw new Error('프로젝트 파일이 너무 크거나 올바른 파일이 아닙니다.');
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(filePath, 'utf8')); }
  catch { throw new Error('프로젝트 JSON을 읽을 수 없습니다. Baekho에서 저장한 파일을 선택해 주세요.'); }
  return normalizeProject(parsed);
}

/** Commit within the selected directory. A failed write leaves an existing target intact. */
export async function atomicWrite(filePath: string, contents: string | Uint8Array): Promise<void> {
  const target = path.resolve(filePath);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    created = true;
    try { await handle.writeFile(contents); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, target);
    created = false;
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
  }
}

export async function createExportBundle(value: unknown, scan: ScanResult | null, importer: string, runtimeScript: string, markerScript: string, fixtureScript: string, catalogScript?:string): Promise<Uint8Array> {
  const project = normalizeProject(value);
  const errors = validateMap(project.map).filter(issue => issue.severity === 'error');
  if (errors.length) throw new Error(`맵 오류를 수정한 뒤 내보내 주세요: ${errors.slice(0, 3).map(issue => issue.message).join(' ')}`);
  await verifyBindingProvenance(project.bindings, scan);
  const manifest = buildManifest(project.map, project.bindings);
  if (!importer.trim()) throw new Error('Unity 가져오기 스크립트를 찾지 못했습니다. 앱을 다시 설치하거나 빌드해 주세요.');
  if (!runtimeScript.trim()) throw new Error('Unity 연결문 런타임 스크립트를 찾지 못했습니다. 앱을 다시 설치하거나 빌드해 주세요.');
  if (!markerScript?.trim()) throw new Error('Unity 게임 지점 런타임 스크립트가 필요합니다.');
  if (!fixtureScript?.trim()) throw new Error('Unity 배치물 런타임 스크립트가 필요합니다.');
  const readme = `BAEKHO MAP — Unity 가져오기 0.5.1

1. ZIP 파일의 압축을 풉니다.
2. 원본 프리팹과 .meta가 있는 Unity 프로젝트를 엽니다. Window > Package Manager > Unity Registry에서 AI Navigation (com.unity.ai.navigation)을 설치합니다.
3. Unity/Editor/BaekhoMapImporter.cs를 Assets/Baekho/Editor/BaekhoMapImporter.cs로, BaekhoPropCatalog.cs를 Assets/Baekho/Editor/BaekhoPropCatalog.cs로 복사합니다. Unity/Runtime의 세 파일을 모두 Assets/Baekho/Runtime/에 복사합니다: Assets/Baekho/Runtime/BaekhoMapConnection.cs, BaekhoGameplayMarker.cs, BaekhoMapFixture.cs. 기존 설치는 같은 경로에서 업데이트하고 중복 설치하지 않습니다. 모든 스크립트를 설치한 뒤 Unity 컴파일을 기다립니다.
4. Map.baekhomap.json을 Assets 아래로 복사합니다.
5. JSON을 선택하고 Assets > Baekho > Build Prefab을 실행합니다. 맵 조립 후 루트에 NavMeshSurface를 추가하고 자동 베이크합니다.
6. JSON 파일과 같은 폴더에 새 프리팹과 .NavMesh.asset이 생성됩니다. 기존 프리팹과 베이크 데이터를 덮어쓰지 않습니다. 프리팹이 참조하는 .NavMesh.asset도 함께 보관하세요.

자동 NavMesh
- 프로젝트의 첫 Agent Type으로 베이크합니다. Window > AI > Navigation에서 캐릭터의 반지름·높이·경사·단차를 설정하고 NavMeshAgent에도 같은 Agent Type을 사용하세요.
- Children / Render Meshes / 모든 레이어 설정으로 생성된 맵의 활성 메시와 Terrain을 수집합니다. 현재 씬의 다른 오브젝트는 포함하지 않습니다. Collider 전용 지형은 생성된 Surface의 Geometry 설정을 바꿔 다시 베이크하세요.
- 원본 조각의 기존 NavMeshSurface는 생성된 인스턴스에서만 비활성화합니다. 원본 프리팹과 기존 데이터는 그대로 유지됩니다.
- AI Navigation이 없으면 설치 안내 후 중단합니다. 패키지 설치와 컴파일이 끝나면 Build Prefab을 다시 실행하세요.
- 루트 스케일은 1로 유지하세요. 지형·배치·캐릭터 크기가 바뀌면 다시 베이크합니다. 여러 방 사이의 NavMeshLink 연결은 게임 프로젝트에서 처리합니다.

배치 기준
- 새 구조·소품 맵은 형식 버전 5이며 기존 맵은 버전 4를 유지합니다. 좌표는 맵 중심 원점, X/Z 바닥, Y 높이, 미터 단위입니다. 원본 프리팹 사본은 포함되지 않고 GUID로 참조합니다.
- 바닥 윗면과 천장 아랫면이 지정된 높이에 맞춰집니다. 두께는 셀 간격 × 12% × 두께 배율 Y입니다.
- 다리는 상판 전용 프리팹의 윗면을 높이에 맞춥니다. 상판에 난간을 합치지 말고 별도 난간 프리팹을 사용하세요. 다리 아래 내부 구덩이는 선택한 마감 바닥 또는 데드존으로 닫습니다. 이 하부는 별도의 플레이 경로로 분석하지 않습니다.
- 벽의 지정 높이와 절벽 깊이는 실제 경계를 측정해 맞춥니다. 이전 프로젝트의 지정하지 않은 벽 높이와 에셋 배율은 보존합니다.
- 새 계단·경사로 배치는 측정된 아랫면 중심을 셀의 바닥 높이에 맞춥니다. 원본은 저단에서 +Z로 상승합니다. Y 스케일은 rise / stairNativeRise로 자동 계산합니다. X/Z 크기와 원본 상승 높이를 에셋 설정에서 맞춰 주세요.
- 넓은 연결문은 여러 셀을 실제로 열고 문 프리팹 하나만 배치합니다. 셀보다 넓은 문은 원본 전체 로컬 X 경계를 지정 폭에 맞추고 중심을 정렬합니다. 문틀 안쪽의 통과 폭과 충돌체는 Unity에서 확인하세요. 한 셀 이하의 문은 기존 배율을 유지합니다.
- 에셋 배율은 프리팹 루트의 최종 배율입니다. 내부 자식 Transform은 유지되며 바닥·천장 두께, 계단 상승 높이, 지정한 벽·절벽 높이와 넓은 문 폭은 역할별 맞춤 규칙을 사용합니다.
- 조명과 독립 구조물은 원본 프리팹 루트 피벗에 보정 Transform을 적용합니다. 광원 설정·컴포넌트·중첩 프리팹 참조는 보존합니다.
- 천장용 형광등과 벽용 발광 패널은 위치에 맞는 전용 에셋을 우선 사용하고, 전용 에셋이 없으면 공용 조명 에셋을 사용합니다. 임포터는 Light 컴포넌트나 광원 설정을 새로 만들지 않습니다.
- Connections에는 BaekhoMapConnection, GameplayMarkers에는 BaekhoGameplayMarker가 저장됩니다. 구조물의 BaekhoMapFixture.linkedId는 연결할 구조물의 내보내기 ID입니다.
- 게임 지점·함정·위험 바닥·문·스위치는 위치와 연결 정보입니다. 실제 스폰·피해·보상·상호작용과 맵 사이 통로 제작은 Unity에서 처리합니다.
- maxStepHeight와 머리 위 공간 검사는 설계 구조 기준이며 실제 캐릭터 충돌체·NavMesh·프리팹 메시 검증은 Unity에서 진행하세요.
- v5 문 위·옆벽, 단차벽, 낭떠러지 벽·하부는 fitSize XYZ 크기로 경계를 맞춥니다. 단차·낭떠러지 벽면의 윗끝은 연결된 바닥의 두께 배율과 Y 보정을 반영한 아랫면에서 끝나며 하단은 유지됩니다. 데드존은 원본 Trigger를 포함한 Collider 경계를 사용하며 실제 동작을 새로 만들지 않습니다.
- 소품 원본 크기: Unity Project에서 프리팹을 선택하고 Assets > Baekho > Export Prop Bounds Catalog로 JSON을 저장한 뒤 앱 에셋 탭에서 가져옵니다. 종류·태그·통행·배치 조건은 앱에서 수정합니다.
- 기존 schemaVersion 1/2/3/4 JSON도 각 버전의 배치 의미로 가져옵니다.
`;
  const files: Record<string, Uint8Array> = {
    'Map.baekhomap.json': strToU8(JSON.stringify(manifest, null, 2)),
    'Unity/Editor/BaekhoMapImporter.cs': strToU8(importer),
    'Unity/Runtime/BaekhoMapConnection.cs': strToU8(runtimeScript),
    'README.txt': strToU8(readme),
  };
  if (markerScript?.trim()) files['Unity/Runtime/BaekhoGameplayMarker.cs'] = strToU8(markerScript);
  if (fixtureScript?.trim()) files['Unity/Runtime/BaekhoMapFixture.cs'] = strToU8(fixtureScript);
  if(catalogScript?.trim())files['Unity/Editor/BaekhoPropCatalog.cs']=strToU8(catalogScript);
  if (project.blueprintDataUrl) files['blueprint.png'] = decodePngDataUrl(project.blueprintDataUrl);
  return zipSync(files, { level: 6 });
}
