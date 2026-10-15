import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AssetBinding, PrefabAsset, ScanResult } from '../../src/shared/types';

const MAX_PREFABS = 20000;
const MAX_ENTRIES = 200000;
const MAX_DEPTH = 64;
const GUID_LINE = /^guid:\s*([a-fA-F0-9]{32})\s*$/m;

function contained(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function metadataGuid(metaPath: string): Promise<string | null> {
  const info = await lstat(metaPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) return null;
  return (await readFile(metaPath, 'utf8')).match(GUID_LINE)?.[1].toLowerCase() ?? null;
}

export async function scanUnityProject(projectPath: string): Promise<ScanResult> {
  const root = await realpath(projectPath);
  for (const folder of ['Assets', 'ProjectSettings']) {
    const info = await lstat(path.join(root, folder)).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error('Assets와 ProjectSettings 폴더가 있는 Unity 프로젝트 폴더를 선택해 주세요.');
  }
  const assets: PrefabAsset[] = [];
  const warnings: string[] = [];
  const guids = new Map<string, PrefabAsset>();
  const duplicates = new Set<string>();
  let entries = 0;
  let prefabs = 0;
  const warn = (message: string) => { if (warnings.length < 100) warnings.push(message); };
  const pending: { directory: string; depth: number }[] = [{ directory: path.join(root, 'Assets'), depth: 0 }];
  while (pending.length > 0) {
    const { directory, depth } = pending.pop()!;
    if (depth > MAX_DEPTH) { warn('64단계보다 깊은 폴더는 건너뛰었습니다.'); continue; }
    // Resolve every directory again so replaced links cannot escape the selected project.
    const current = await lstat(directory).catch(() => null);
    if (!current?.isDirectory() || current.isSymbolicLink()) continue;
    if (!contained(root, await realpath(directory))) continue;
    const children = await readdir(directory, { withFileTypes: true }).catch(() => null);
    if (!children) { warn(`읽을 수 없는 폴더: ${path.relative(root, directory)}`); continue; }
    for (const entry of children) {
      if (++entries > MAX_ENTRIES) throw new Error('Assets 항목이 200,000개를 넘습니다. 사용할 프리팹만 포함한 프로젝트로 다시 시도해 주세요.');
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) { pending.push({ directory: fullPath, depth: depth + 1 }); continue; }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.prefab') continue;
      if (++prefabs > MAX_PREFABS) throw new Error('프리팹이 20,000개를 넘습니다. 사용할 프리팹 수를 줄여 주세요.');
      const assetPath = path.relative(root, fullPath).split(path.sep).join('/');
      try {
        const fileInfo = await lstat(fullPath);
        if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || !contained(root, await realpath(fullPath))) continue;
        const guid = await metadataGuid(`${fullPath}.meta`);
        if (!guid) { warn(`올바른 GUID가 없어 제외했습니다: ${assetPath}`); continue; }
        if (duplicates.has(guid)) continue;
        if (guids.has(guid)) {
          warn(`중복 GUID를 가진 프리팹을 제외했습니다: ${guids.get(guid)!.path}, ${assetPath}`);
          guids.delete(guid);
          duplicates.add(guid);
          continue;
        }
        guids.set(guid, { name: path.basename(entry.name, path.extname(entry.name)), path: assetPath, guid });
      } catch { warn(`프리팹 또는 .meta를 읽을 수 없습니다: ${assetPath}`); }
    }
  }
  assets.push(...guids.values());
  assets.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (!assets.length) warn('사용 가능한 .prefab + .meta 쌍을 찾지 못했습니다. Unity에서 에셋 가져오기를 먼저 완료해 주세요.');
  return { projectPath: root, assets, warnings };
}

export async function verifyBindingProvenance(bindings: AssetBinding[], scan: ScanResult | null): Promise<void> {
  if (!scan) throw new Error('내보내기 전에 사용할 Unity 프로젝트 폴더를 스캔해 주세요. 프로젝트를 다시 열었을 때도 스캔이 필요합니다.');
  const byGuid = new Map(scan.assets.map(asset => [asset.guid, asset]));
  for (const binding of bindings) {
    const asset = byGuid.get(binding.prefabGuid.toLowerCase());
    if (!asset || asset.path !== binding.prefabPath) throw new Error(`${binding.role} 프리팹이 현재 스캔한 Unity 프로젝트와 일치하지 않습니다. 다시 연결해 주세요.`);
    const fullPath = path.resolve(scan.projectPath, asset.path);
    if (!contained(scan.projectPath, fullPath)) throw new Error('프리팹 경로가 Unity 프로젝트 범위를 벗어납니다.');
    try {
      // Check every ancestor: resolving a symlink to another in-project asset is also disallowed.
      let cursor = fullPath;
      while (cursor !== scan.projectPath) {
        if ((await lstat(cursor)).isSymbolicLink()) throw new Error('symlink');
        cursor = path.dirname(cursor);
      }
      const info = await lstat(fullPath);
      if (!info.isFile() || !contained(scan.projectPath, await realpath(fullPath)) || await metadataGuid(`${fullPath}.meta`) !== asset.guid) throw new Error('changed');
    } catch { throw new Error(`프리팹이 변경되었거나 읽을 수 없습니다. 프로젝트를 다시 스캔해 주세요: ${asset.path}`); }
  }
}
