import type { AssetBinding, Cell, Direction, PropBehavior, PropComposition, PropInstance } from './types';
import { propFacingOffset, propFrontYaw } from './prop-orientation';

/** Names suggest function only. Neither dimensions nor set membership prove floor support. */
export function propSemanticName(binding: AssetBinding): string {
  return `${binding.label} ${binding.prefabPath.split('/').pop() ?? ''} ${binding.prop?.category ?? ''}`
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2').toLowerCase().replace(/[_\-.]+/g, ' ');
}

export function suggestPropBehavior(binding: AssetBinding): PropBehavior {
  const name = propSemanticName(binding);
  if (/\b(?:chair|stool)\b|의자/.test(name)) return 'seat';
  if (/\b(?:desk|table)\b|책상|탁자/.test(name)) return 'workSurface';
  if (/\b(?:monitor|screen|display|keyboard|laptop|computer)\b|모니터|화면|디스플레이|키보드|노트북|컴퓨터/.test(name)) return 'surfaceAccessory';
  if (/\b(?:console|terminal|machine|machinery|generator|engine|workbench)\b|콘솔|단말|기계|발전기|작업대/.test(name)) return 'floorEquipment';
  return 'generic';
}

export function effectivePropBehavior(binding: AssetBinding): PropBehavior {
  return binding.prop?.behavior ?? suggestPropBehavior(binding);
}

/** Functional requirements remain hard constraints inside a manually authored family or Unity set. */
export function compatiblePropBehaviors(anchor: AssetBinding, companion: AssetBinding): boolean {
  const a = effectivePropBehavior(anchor), b = effectivePropBehavior(companion);
  if (a === 'seat' || a === 'surfaceAccessory' || b === 'surfaceAccessory') return false;
  if (a === 'workSurface') return b === 'seat';
  return b !== 'seat' && b !== 'workSurface';
}

function sample(value: string, seed: number): number {
  let n = seed >>> 0;
  for (const c of value) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
  n = Math.imul(n ^ n >>> 16, 0x85ebca6b); n = Math.imul(n ^ n >>> 13, 0xc2b2ae35);
  return ((n ^ n >>> 16) >>> 0) / 4294967296;
}

/** Offsets are sampled before measuring geometry. A calibrated cardinal pose is the safe fallback. */
export function groupedYawOffsets(binding: AssetBinding, composition: PropComposition, seed: number, salt: string, behavior = effectivePropBehavior(binding)): number[] {
  const calibrated = propFacingOffset(binding);
  const spread = behavior === 'seat' ? 6 : behavior === 'workSurface' || behavior === 'floorEquipment' ? 0
    : composition.usage === 'natural' ? 180 : composition.usage === 'storage' ? 6 : 0;
  if (!spread) return [calibrated];
  // Equivalent prefabs share a sample for this group slot, preserving geometry-cache reuse
  // for large libraries while different groups and companions still vary independently.
  const varied = calibrated + (sample(`${salt}:yaw`, seed) * 2 - 1) * spread;
  return Math.abs(varied - calibrated) < 1e-6 ? [calibrated] : [varied, calibrated];
}

/** Conservative grid space for using equipment, or getting in/out behind a seated chair. */
export function propAccessCells(prop: PropInstance, binding: AssetBinding, characterRadius: number, cellSize: number, behavior = effectivePropBehavior(binding)): Cell[] {
  if (!['workSurface', 'seat', 'floorEquipment'].includes(behavior)) return [];
  const yaw = propFrontYaw(prop, binding) + (behavior === 'seat' ? 180 : 0);
  const side = ((Math.round(yaw / 90) * 90 % 360 + 360) % 360) as Direction;
  const left = Math.min(...prop.cells.map(c => c.x)), right = Math.max(...prop.cells.map(c => c.x));
  const top = Math.min(...prop.cells.map(c => c.row)), bottom = Math.max(...prop.cells.map(c => c.row));
  const depth = Math.max(1, Math.ceil(characterRadius * 2 / cellSize)), cells: Cell[] = [];
  for (let step = 1; step <= depth; step++) {
    if (side === 0 || side === 180) for (let x = left; x <= right; x++) cells.push({ x, row: side === 0 ? top - step : bottom + step });
    else for (let row = top; row <= bottom; row++) cells.push({ x: side === 90 ? right + step : left - step, row });
  }
  return cells;
}
