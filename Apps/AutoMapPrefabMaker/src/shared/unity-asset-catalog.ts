import { defaultAssetScale } from './asset-scaling';
import { ASSET_ROLES } from './features';
import { MAX_BINDINGS, parseBindings } from './map';
import { suggestPropDefinition } from './props';
import type { AssetBinding, AssetRole, LocalBounds, PrefabAsset, Vec3, WallMountDefinition } from './types';

export interface UnityAssetCatalogEntry {
  guid: string;
  path: string;
  role: AssetRole;
  size: Vec3;
  bounds: LocalBounds;
  label?: string;
  scale?: Vec3;
  offset?: Vec3;
  rotationY?: number;
  stairNativeRise?: number;
  lightAnchor?: 'ceiling' | 'wall';
  wallMount?: WallMountDefinition;
}
export interface UnityAssetCatalogDiagnostic { path: string; reason: string }
export interface UnityAssetCatalog {
  format: 'baekho-asset-catalog';
  version: 1;
  assets: UnityAssetCatalogEntry[];
  skipped: UnityAssetCatalogDiagnostic[];
}
export interface UnityAssetCatalogImportResult {
  bindings: AssetBinding[];
  catalog: UnityAssetCatalog;
  added: number;
  updated: number;
  unmatched: number;
  byRole: Record<AssetRole, { added: number; updated: number }>;
  skipped: UnityAssetCatalogDiagnostic[];
}

const MAX_CATALOG_ENTRIES = 20_000;
const OPTIONS = ['label', 'scale', 'offset', 'rotationY', 'stairNativeRise', 'lightAnchor', 'wallMount'] as const;
const GUID = /^[a-fA-F0-9]{32}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const plainText = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
/** Unity AssetDatabase paths use forward slashes and are relative to the project. */
const prefabPath = (value: unknown): value is string => plainText(value, 2000) && value.startsWith('Assets/') && /\.prefab$/i.test(value)
  && !value.includes('\\') && value.split('/').every(part => !!part && part !== '.' && part !== '..');
const measuredSize = (value: unknown): value is Vec3 => record(value) && only(value, ['x', 'y', 'z'])
  && ['x', 'y', 'z'].every(axis => typeof value[axis] === 'number' && Number.isFinite(value[axis]) && value[axis] <= 1000 && Math.fround(value[axis]) > 0);
const propRole = (role: AssetRole) => ['prop', 'decoration', 'vegetation'].includes(role);
const supportsWallMount = (role: AssetRole) => !['floor', 'wall', 'door', 'prop', 'stair', 'slope', 'bridge', 'ceiling', 'cliff', 'deadzone'].includes(role);

/** A separate, versioned format: legacy prop measurement JSON cannot be mistaken for a registration catalog. */
export function parseUnityAssetCatalog(value: unknown): UnityAssetCatalog {
  if (!record(value) || !only(value, ['format', 'version', 'assets', 'skipped']) || value.format !== 'baekho-asset-catalog' || value.version !== 1
    || !Array.isArray(value.assets) || value.assets.length > MAX_CATALOG_ENTRIES || !Array.isArray(value.skipped) || value.skipped.length > MAX_CATALOG_ENTRIES) {
    throw new Error('Unity 프리팹 카탈로그의 형식과 버전(format: baekho-asset-catalog, version: 1)을 확인해 주세요. 항목은 최대 20,000개입니다.');
  }
  const seen = new Set<string>();
  const assets = Array.from(value.assets, (entry: unknown, index): UnityAssetCatalogEntry => {
    try {
      if (!record(entry) || !only(entry, ['guid', 'path', 'role', 'size', 'bounds', ...OPTIONS]) || typeof entry.guid !== 'string' || !GUID.test(entry.guid)
        || !prefabPath(entry.path) || !measuredSize(entry.size)) {
        throw new Error('GUID·Assets 프리팹 경로·양수 XYZ 측정 크기를 확인해 주세요.');
      }
      const guid = entry.guid.toLowerCase();
      if (seen.has(guid)) throw new Error(`GUID ${guid}가 중복됩니다.`);
      seen.add(guid);
      const options: Record<string, unknown> = {};
      for (const key of OPTIONS) if (Object.prototype.hasOwnProperty.call(entry, key) && !(key === 'wallMount' && entry[key] === null)) options[key] = entry[key];
      const [validated] = parseBindings([{
        id: 'catalog_entry', label: '프리팹', role: entry.role, prefabGuid: guid, prefabPath: entry.path,
        scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0, bounds: entry.bounds, ...options,
      }]);
      if (!validated.bounds) throw new Error('측정한 원본 경계(bounds)가 필요합니다.');
      const size = entry.size;
      if ((['x', 'y', 'z'] as const).some(axis => Math.abs(validated.bounds!.size[axis] - size[axis]) > 1e-5)) throw new Error('원본 경계 크기와 측정 크기가 다릅니다.');
      const result: UnityAssetCatalogEntry = { guid, path: entry.path, role: validated.role, size: structuredClone(size), bounds: validated.bounds };
      for (const key of OPTIONS) if (Object.prototype.hasOwnProperty.call(options, key)) Object.assign(result, { [key]: structuredClone(validated[key]) });
      return result;
    } catch (error) {
      throw new Error(`Unity 프리팹 카탈로그 assets[${index}]: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const skipped = Array.from(value.skipped, (entry: unknown): UnityAssetCatalogDiagnostic => {
    if (!record(entry) || !only(entry, ['path', 'reason']) || !plainText(entry.path, 2000) || !plainText(entry.reason, 2000)) throw new Error('Unity 프리팹 제외 항목의 경로와 이유는 2,000자 이하의 문자열이어야 합니다.');
    return { path: entry.path, reason: entry.reason };
  });
  return { format: 'baekho-asset-catalog', version: 1, assets, skipped };
}

/**
 * Only a current, unambiguous project scan supplies prefab identities. Refreshes preserve all app-authored
 * settings and update measurements on every existing registration of that GUID. The caller validates map
 * placement compatibility before committing the returned bindings as one undoable edit. No input is mutated.
 */
export function importUnityAssetCatalogBindings(bindings: AssetBinding[], value: unknown, assets: PrefabAsset[], cellSize: number): UnityAssetCatalogImportResult {
  if (!Number.isFinite(cellSize) || cellSize <= 0 || cellSize > 1000) throw new Error('프리팹을 등록할 셀 크기는 0보다 크고 1,000m 이하여야 합니다.');
  // Validate, but retain the original shape of existing registrations (including legacy optional defaults).
  parseBindings(bindings);
  const source = parseUnityAssetCatalog(value);
  if (!Array.isArray(assets)) throw new Error('연결한 Unity 프로젝트의 최신 프리팹 목록이 필요합니다.');
  const scanned = new Map<string, PrefabAsset>(), paths = new Set<string>();
  for (const asset of assets) {
    if (!record(asset) || typeof asset.guid !== 'string' || !GUID.test(asset.guid) || !prefabPath(asset.path) || typeof asset.name !== 'string') throw new Error('연결 프로젝트의 프리팹 GUID와 경로를 다시 스캔해 주세요.');
    const guid = asset.guid.toLowerCase(), path = asset.path.toLowerCase();
    if (scanned.has(guid) || paths.has(path)) throw new Error('연결 프로젝트의 프리팹 GUID 또는 경로가 중복됩니다. 프로젝트를 다시 스캔해 주세요.');
    scanned.set(guid, asset); paths.add(path);
  }
  const skipped = structuredClone(source.skipped);
  const matched = source.assets.filter(entry => {
    const asset = scanned.get(entry.guid);
    if (asset?.path === entry.path) return true;
    skipped.push({ path: entry.path, reason: asset ? '현재 프로젝트 스캔의 GUID와 프리팹 경로가 일치하지 않습니다.' : '현재 프로젝트 스캔에서 이 GUID를 찾을 수 없습니다.' });
    return false;
  });
  const byGuid = new Map(matched.map(entry => [entry.guid, entry]));
  const existingGuids = new Set(bindings.map(binding => binding.prefabGuid.toLowerCase()));
  const additions = matched.filter(entry => !existingGuids.has(entry.guid));
  for (const binding of bindings) {
    if (byGuid.get(binding.prefabGuid.toLowerCase())?.wallMount && !supportsWallMount(binding.role)) {
      throw new Error(`벽 부착 정보가 있는 기존 에셋 '${binding.label}'은 현재 종류(${binding.role})로 가져올 수 없습니다. 종류를 장식 또는 조명으로 먼저 변경해 주세요. 가져오기는 적용되지 않았습니다.`);
    }
  }
  if (bindings.length + additions.length > MAX_BINDINGS) throw new Error(`현재 ${bindings.length}개에 프리팹 ${additions.length}개를 추가하면 최대 ${MAX_BINDINGS}개를 초과합니다. 가져오기는 적용되지 않았습니다.`);
  const byRole = Object.fromEntries(ASSET_ROLES.map(role => [role, { added: 0, updated: 0 }])) as UnityAssetCatalogImportResult['byRole'];
  let updated = 0;
  function measured(binding: AssetBinding, entry: UnityAssetCatalogEntry): AssetBinding {
    const result = structuredClone(binding);
    result.prefabPath = scanned.get(entry.guid)!.path;
    result.bounds = structuredClone(entry.bounds);
    if (propRole(result.role)) result.prop = { ...(result.prop ?? suggestPropDefinition(result)), size: structuredClone(entry.size) };
    // Installation policy is editable in the app. Only the source's measured connection geometry is refreshed.
    // Without provenance a missing module cannot distinguish source removal from an app-authored wall setup.
    if (entry.wallMount) result.wallMount = binding.wallMount
      ? { ...structuredClone(binding.wallMount), mounts: structuredClone(entry.wallMount.mounts), sockets: structuredClone(entry.wallMount.sockets), collisionBoxes: structuredClone(entry.wallMount.collisionBoxes) }
      : structuredClone(entry.wallMount);
    return result;
  }
  const refreshed = bindings.map(binding => {
    const entry = byGuid.get(binding.prefabGuid.toLowerCase());
    if (!entry) return structuredClone(binding);
    updated++; byRole[binding.role].updated++;
    return measured(binding, entry);
  });
  const usedIds = new Set(bindings.map(binding => binding.id));
  const added = additions.map(entry => {
    const asset = scanned.get(entry.guid)!;
    const baseId = `asset_catalog_${entry.guid}`;
    let id = baseId, suffix = 2;
    while (usedIds.has(id)) id = `${baseId}_${suffix++}`;
    usedIds.add(id);
    const binding: AssetBinding = {
      id, label: entry.label ?? (asset.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || '프리팹'), role: entry.role,
      prefabGuid: asset.guid.toLowerCase(), prefabPath: asset.path,
      scale: structuredClone(entry.scale ?? defaultAssetScale(entry.role, cellSize)),
      offset: structuredClone(entry.offset ?? { x: 0, y: 0, z: 0 }), rotationY: entry.rotationY ?? 0,
      ...(['stair', 'slope'].includes(entry.role) ? { stairNativeRise: entry.stairNativeRise ?? 1 } : {}),
      ...(entry.lightAnchor ? { lightAnchor: entry.lightAnchor } : {}),
    };
    byRole[entry.role].added++;
    return measured(binding, entry);
  });
  const result = [...refreshed, ...added];
  // A preserved installation kind can be incompatible with newly measured sockets; reject the whole edit.
  parseBindings(result);
  return { bindings: result, catalog: { ...source, assets: structuredClone(matched), skipped: structuredClone(skipped) },
    added: added.length, updated, unmatched: source.assets.length - matched.length, byRole, skipped };
}
