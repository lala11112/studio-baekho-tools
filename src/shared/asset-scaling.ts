import type { AssetBinding, AssetRole, Vec3 } from './types';

export const TILE_ASSET_ROLES: readonly AssetRole[] = ['floor', 'wall', 'door', 'stair', 'slope', 'bridge', 'ceiling', 'cliff'];
export type ScaleScope = 'all' | 'tiles' | AssetRole;
export type ScaleOperation = { kind: 'set' | 'multiply'; axes: Partial<Vec3> } | { kind: 'cell'; cellSize: number };
export const matchesScaleScope = (role: AssetRole, scope: ScaleScope) => scope === 'all' || (scope === 'tiles' ? TILE_ASSET_ROLES.includes(role) : role === scope);

/** Unit tiles span one grid cell; doors start at native scale for authored doorway prefabs. */
export function defaultAssetScale(role: AssetRole, cellSize: number): Vec3 {
  return role !== 'door' && TILE_ASSET_ROLES.includes(role) ? { x: cellSize, y: 1, z: cellSize } : { x: 1, y: 1, z: 1 };
}

/** Batch edits are atomic and leave offsets, pivots, identifiers and non-selected roles intact. */
export function scaleAssets(bindings: AssetBinding[], scope: ScaleScope, operation: ScaleOperation): AssetBinding[] {
  const axes: Partial<Vec3> = operation.kind === 'cell' ? { x: operation.cellSize, z: operation.cellSize } : operation.axes;
  if (!Object.keys(axes).length) throw new Error('조정할 X, Y 또는 Z 배율을 입력하세요.');
  if (Object.keys(axes).some(axis => !['x', 'y', 'z'].includes(axis)) || Object.values(axes).some(value => !Number.isFinite(value) || value <= 0 || value > 10000)) {
    throw new Error('배율은 0보다 크고 10,000 이하인 숫자로 입력하세요.');
  }
  return bindings.map(binding => {
    if (!matchesScaleScope(binding.role, scope)) return structuredClone(binding);
    const scale = { ...binding.scale };
    for (const axis of ['x', 'y', 'z'] as const) {
      const value = axes[axis]; if (value === undefined) continue;
      scale[axis] = operation.kind === 'multiply' ? scale[axis] * value : value;
      if (!Number.isFinite(scale[axis]) || scale[axis] > 10000 || Math.fround(scale[axis]) <= 0) throw new Error('최종 배율이 허용 범위를 벗어납니다. 원래 에셋 배율을 확인하세요.');
    }
    return { ...structuredClone(binding), scale };
  });
}
