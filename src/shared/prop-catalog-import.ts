import { MAX_BINDINGS } from './map';
import { applyImportedPropBounds, parsePropBoundsCatalog, preparePropBoundsImport, suggestPropDefinition, type PropBoundsCatalog } from './props';
import type { AssetBinding, PrefabAsset } from './types';

export type PropCatalogImportRole = 'prop' | 'decoration' | 'vegetation' | 'light';

export interface PropCatalogImportResult {
  bindings: AssetBinding[];
  catalog: PropBoundsCatalog;
  added: number;
  /** Existing prop, decoration and vegetation bindings with matching measurements. */
  updated: number;
  /** Measurements matched to the connected project's scanned prefab GUIDs. */
  available: number;
  /** Existing eligible bindings without matching measurements. */
  missing: number;
  /** Measurements whose GUID is absent from the connected project's scan. */
  unmatched: number;
  /** Matching GUIDs already registered solely under another role, so no prop is added. */
  existingOtherRoles: number;
}

const eligible = (binding: AssetBinding) => ['prop', 'decoration', 'vegetation','light'].includes(binding.role);
const supportsWallMount = (role: AssetBinding['role']) => !['floor', 'wall', 'door', 'prop', 'stair', 'slope', 'bridge', 'ceiling', 'cliff', 'deadzone'].includes(role);

/**
 * A bounds file supplies measurements and optional wall mount metadata. Prefab identity and paths for additions
 * always come from the connected project's scan. Existing bindings keep their role
 * and settings, including when the same prefab already serves a structural role.
 * No input is mutated. Incompatible wall roles and catalog limit overflow reject the entire import.
 */
export function importPropCatalogBindings(
  bindings: AssetBinding[], value: unknown, assets: PrefabAsset[] | null, role: PropCatalogImportRole = 'prop',
): PropCatalogImportResult {
  if (!['prop', 'decoration', 'vegetation','light'].includes(role)) throw new Error('일괄 등록할 종류는 소품·장식·식생·조명 중에서 선택해 주세요.');
  if (bindings.length > MAX_BINDINGS) throw new Error(`등록된 에셋은 최대 ${MAX_BINDINGS}개여야 합니다.`);
  const originalCatalog = parsePropBoundsCatalog(value);
  const prepared = preparePropBoundsImport(bindings, originalCatalog, assets);
  const existingGuids = new Set(bindings.map(binding => binding.prefabGuid.toLowerCase()));
  const eligibleGuids = new Set(bindings.filter(eligible).map(binding => binding.prefabGuid.toLowerCase()));
  const assetsByGuid = new Map((assets ?? []).map(asset => [asset.guid.toLowerCase(), asset]));
  const additions = prepared.catalog.assets.filter(entry => !existingGuids.has(entry.guid.toLowerCase()) && assetsByGuid.has(entry.guid.toLowerCase()));
  for (const entry of prepared.catalog.assets) {
    if (!entry.wallMount) continue;
    const incompatible = bindings.find(binding => binding.prefabGuid.toLowerCase() === entry.guid.toLowerCase() && !supportsWallMount(binding.role));
    if (incompatible) {
      throw new Error(`벽 부착 정보가 있는 기존 에셋 '${incompatible.label}'은 현재 종류(${incompatible.role})로 가져올 수 없습니다. 이 에셋의 종류를 장식 또는 조명으로 먼저 변경한 뒤 다시 가져와 주세요. 가져오기는 적용되지 않았습니다.`);
    }
  }
  const incompatibleAddition = !supportsWallMount(role) && additions.find(entry => entry.wallMount);
  if (incompatibleAddition) {
    const asset = assetsByGuid.get(incompatibleAddition.guid.toLowerCase())!;
    throw new Error(`벽 부착 정보가 있는 프리팹 '${asset.name}'을 소품으로 등록할 수 없습니다. 일괄 등록 종류에서 장식 또는 조명을 선택해 주세요. 가져오기는 적용되지 않았습니다.`);
  }
  if (bindings.length + additions.length > MAX_BINDINGS) {
    throw new Error(`현재 ${bindings.length}개에 프리팹 ${additions.length}개를 추가하면 최대 ${MAX_BINDINGS}개를 초과합니다. 기존 에셋을 줄이거나 Unity에서 내보낼 프리팹 수를 줄여 주세요. 가져오기는 적용되지 않았습니다.`);
  }

  const usedIds = new Set(bindings.map(binding => binding.id));
  const addedBindings = additions.map(entry => {
    const guid = entry.guid.toLowerCase(), asset = assetsByGuid.get(guid)!;
    const baseId = `asset_bounds_${guid}`;
    let id = baseId, suffix = 2;
    while (usedIds.has(id)) id = `${baseId}_${suffix++}`;
    usedIds.add(id);
    const binding: AssetBinding = {
      id, label: asset.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || '프리팹', role, prefabGuid: asset.guid.toLowerCase(), prefabPath: asset.path,
      scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0,
    };
    if(role!=='light')binding.prop = { ...suggestPropDefinition(binding), size: structuredClone(entry.size) };
    return applyImportedPropBounds(binding,prepared.catalog);
  });

  return {
    ...prepared, bindings: [...prepared.bindings, ...addedBindings], added: addedBindings.length,
    unmatched: originalCatalog.assets.length - prepared.catalog.assets.length,
    existingOtherRoles: prepared.catalog.assets.filter(entry => existingGuids.has(entry.guid.toLowerCase()) && !eligibleGuids.has(entry.guid.toLowerCase())).length,
  };
}
