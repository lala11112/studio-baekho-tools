import type { Cell, GenerationRegion, GridMap, PropInstance } from './types';

const key = (cell: Cell) => `${cell.x}:${cell.row}`;
const inside = (cell: Cell, region: GenerationRegion) => cell.x >= region.x && cell.row >= region.row
  && cell.x < region.x + region.width && cell.row < region.row + region.height;

/** Protection is shared by every member, including members outside the selected region. */
export function protectedPropIds(map: GridMap, region?: GenerationRegion): Set<string> {
  const result = new Set<string>();
  const protectedCells = new Set([...(map.lockedCells ?? []), ...map.assetOverrides.filter(item => item.role === 'prop')].map(key));
  const groups = new Map<string, PropInstance[]>();
  for (const prop of map.propInstances ?? []) {
    const crossing = !!region && prop.cells.some(cell => inside(cell, region)) && !prop.cells.every(cell => inside(cell, region));
    if (prop.authored || prop.provenance === 'manual' || prop.id.startsWith('prop_manual_') || crossing
      || prop.cells.some(cell => protectedCells.has(key(cell)))) result.add(prop.id);
    if (prop.groupId) {
      const members = groups.get(prop.groupId);
      if (members) members.push(prop); else groups.set(prop.groupId, [prop]);
    }
  }
  for (const members of groups.values()) {
    const cells = members.flatMap(prop => prop.cells);
    const crossing = !!region && cells.some(cell => inside(cell, region)) && !cells.every(cell => inside(cell, region));
    if (crossing || members.some(prop => result.has(prop.id))) for (const prop of members) result.add(prop.id);
  }
  return result;
}

/** A direct edit claims the entire composition so later automatic work preserves it. */
export function markPropGroupAuthored(map: GridMap, instanceId: string): void {
  const selected = map.propInstances?.find(prop => prop.id === instanceId);
  if (!selected) return;
  for (const prop of map.propInstances ?? []) if (prop.id === selected.id || selected.groupId && prop.groupId === selected.groupId) {
    prop.authored = true;
    prop.provenance = 'manual';
  }
}
