import type { AssetBinding, AssetRole, Cell, GridMap } from './types';

const neighbors = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
const epsilon = 1e-8;

/** Keep geometry selection identical to terrain export without importing its dependency graph. */
function bindingFor(map: GridMap, cell: Cell, role: AssetRole, bindings: readonly AssetBinding[]): AssetBinding | undefined {
  const override = map.assetOverrides.find(item => item.x === cell.x && item.row === cell.row && item.role === role);
  if (override) return bindings.find(binding => binding.id === override.bindingId && binding.role === role);
  const candidates = bindings.filter(binding => binding.role === role);
  return candidates[(cell.row * map.width + cell.x) % candidates.length];
}

/** The physical terrain top; a ramp contributes its low entrance and void contributes nothing. */
export function terrainSurfaceY(map: GridMap, cell: Cell, bindings: readonly AssetBinding[] = []): number | undefined {
  const tile = map.rows[cell.row]?.[cell.x];
  if (!tile || !'.DPRB'.includes(tile)) return undefined;
  const role = tile === 'B' ? 'bridge' : 'floor';
  return map.elevations[cell.row][cell.x] + (bindingFor(map, cell, role, bindings)?.offset.y ?? 0);
}

function originalWallBaseY(map: GridMap, cell: Cell, bindings: readonly AssetBinding[]): number {
  return map.elevations[cell.row][cell.x] + (bindingFor(map, cell, 'wall', bindings)?.offset.y ?? 0);
}

export interface WallBaseClosure { bottom: number; top: number; height: number }

/** A derived closure under the original wall, independent of optional saved structure repairs. */
export function wallBaseClosure(map: GridMap, cell: Cell, bindings: readonly AssetBinding[] = []): WallBaseClosure | undefined {
  if (map.rows[cell.row]?.[cell.x] !== '#') return undefined;
  const top = originalWallBaseY(map, cell, bindings);
  let bottom = top;
  for (const [dx, dr] of neighbors) {
    const surface = terrainSurfaceY(map, { x: cell.x + dx, row: cell.row + dr }, bindings);
    if (surface !== undefined) bottom = Math.min(bottom, surface);
  }
  return top - bottom > epsilon ? { bottom, top, height: top - bottom } : undefined;
}

/** Effective lower support, including the derived closure and calibrated binding offsets. */
export function wallBaseY(map: GridMap, cell: Cell, bindings: readonly AssetBinding[] = []): number {
  return wallBaseClosure(map, cell, bindings)?.bottom ?? originalWallBaseY(map, cell, bindings);
}

/** Preserve a specified height or a measured native wall height; 4m is the legacy support fallback. */
export function wallTopY(map: GridMap, cell: Cell, bindings: readonly AssetBinding[] = []): number {
  const binding = bindingFor(map, cell, 'wall', bindings);
  const height = map.wallHeights?.find(wall => wall.x === cell.x && wall.row === cell.row)?.height
    ?? (binding?.bounds ? binding.bounds.size.y * binding.scale.y : undefined)
    ?? map.structureSettings?.defaultWallHeight ?? 4;
  return originalWallBaseY(map, cell, bindings) + height;
}
