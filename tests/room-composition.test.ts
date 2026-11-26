import assert from 'node:assert/strict';
import test from 'node:test';
import { applyGeneratedFeatures, DEFAULT_DESIGNER } from '../src/shared/features';
import { mergeGeneratedRegion } from '../src/shared/editing';
import { furnishExistingMap, rearrangeMapProps } from '../src/shared/furnishing';
import { placeGroupedProps } from '../src/shared/grouped-props';
import { analyzeLevelDesign, DEFAULT_LEVEL_DESIGN } from '../src/shared/level-design';
import { DEFAULT_SETTINGS } from '../src/shared/map';
import { compositionTerrain, planRoomComposition } from '../src/shared/room-composition';
import { propValidationIssues } from '../src/shared/props';
import type { AssetBinding, Cell, GenerationSettings, GridMap, PropInstance } from '../src/shared/types';

const key = (c: Cell) => `${c.x},${c.row}`;
function room(width = 30, height = 24): GridMap {
  const rows = Array.from({ length: height }, (_, row) => row === 0 || row === height - 1 ? '#'.repeat(width) : `#${'.'.repeat(width - 2)}#`);
  const x = Math.floor(width / 2); rows[0] = rows[0].slice(0, x) + 'D' + rows[0].slice(x + 1);
  return { version: 5, name: 'Composition', width, height, cellSize: 2, maxStepHeight: .4, rows,
    elevations: rows.map(() => Array(width).fill(0)), ramps: [], assetOverrides: [],
    connections: [{ id: 'entry', label: 'Entry', x, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }] };
}
function settings(): GenerationSettings {
  return { ...DEFAULT_SETTINGS, width: 30, height: 24, connectionCount: 1, seed: 237,
    designer: { ...DEFAULT_DESIGNER, preset: 'shop', elevation: false, props: true, propLayout: 'grouped', propCoverage: 12, decorations: false, vegetation: false },
    levelDesign: { ...DEFAULT_LEVEL_DESIGN, pattern: 'openArena' } };
}
function asset(id = 'Crate'): AssetBinding {
  return { id, label: id, role: 'prop', prefabGuid: id.length.toString(16).padStart(32, '0'), prefabPath: `Assets/${id}.prefab`, scale: { x: 1, y: 1, z: 1 }, rotationY: 0, offset: { x: 0, y: 0, z: 0 },
    prop: { category: id, tags: [], blocksMovement: true, size: { x: 1.2, y: 1, z: 1.2 }, placement: 'floor', roomTypes: ['shop'], weight: 1,
      composition: { usage: 'storage', family: 'supply', member: 'either', arrangement: 'island' } } };
}
function assertConnected(cells: Cell[]): void {
  assert.ok(cells.length);
  const all = new Set(cells.map(key)), seen = new Set([key(cells[0])]), queue = [cells[0]];
  for (let i = 0; i < queue.length; i++) for (const [dx, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const next = { x: queue[i].x + dx, row: queue[i].row + dr }, k = key(next);
    if (all.has(k) && !seen.has(k)) { seen.add(k); queue.push(next); }
  }
  assert.equal(seen.size, all.size);
}

test('whole-room composition is deterministic, has extra connected quiet floor, and follows an irregular outline', () => {
  const map = room(), s = settings(), bindings = [asset('A'), asset('B')];
  // A broad bend with a smaller side pocket, rather than an externally fixed partition.
  for (let row = 1; row < 10; row++) map.rows[row] = map.rows[row].slice(0, 20) + '#'.repeat(10);
  const before = structuredClone(map), plan = planRoomComposition(map, s, bindings);
  assert.deepEqual(map, before); assert.deepEqual(plan, planRoomComposition(map, s, [...bindings].reverse()));
  assert.ok(plan.focal?.cells.length); assert.ok(plan.supports.length);
  assert.ok(plan.quietPatches[0].cells.length >= 4); plan.quietPatches.forEach(patch => assertConnected(patch.cells));
  const reserved = new Set(plan.reservedCells.map(key));
  assert.ok(plan.quietCells.length >= 4);
  assert.ok(plan.quietCells.every(c => map.rows[c.row][c.x] === '.' && !reserved.has(key(c))));
  assert.notDeepEqual(plan.zones, planRoomComposition(map, { ...s, seed: 993 }, bindings).zones);
  assert.ok(plan.zones.every(c => map.rows[c.row][c.x] === '.'));
});

test('ineligible wall, ceiling and nonblocking prop assets cannot consume focal and quiet floor', () => {
  const map = room(), s = settings(), valid = asset('Crate');
  const excluded = ['wall', 'ceiling', 'nonblocking'].map((kind, index) => {
    const binding = asset(`excluded-${index}`); binding.prop!.size = { x: 100, y: 1, z: 100 };
    if (kind === 'nonblocking') binding.prop!.blocksMovement = false;
    else binding.prop!.placement = kind as 'wall' | 'ceiling';
    return binding;
  });
  const baseline = planRoomComposition(map, s, [valid]), mixed = planRoomComposition(map, s, [valid, ...excluded]);
  assert.ok(baseline.quietCells.length); assert.ok(baseline.supports.length);
  assert.deepEqual(mixed, baseline);
  const before = placeGroupedProps(map, s, [valid]), after = placeGroupedProps(map, s, [valid, ...excluded]);
  assert.deepEqual(after.map, before.map);
  assert.ok(after.composition!.quietCells.length);
});

test('impossible oversized native registrations do not inflate scene statistics or eliminate quiet floor', () => {
  const source = room(24, 20), s = settings(); s.width = source.width; s.height = source.height;
  const console = asset('Console'); console.prop!.composition = { usage: 'equipment', family: 'machines', member: 'either', arrangement: 'either' };
  const huge = ['Huge_A', 'Huge_B'].map(id => {
    const binding = asset(id); binding.prop!.composition = structuredClone(console.prop!.composition);
    binding.prop!.size = { x: 100, y: 1, z: 100 }; return binding;
  });
  const baseline = placeGroupedProps(source, s, [console]), result = placeGroupedProps(source, s, [console, ...huge]);
  assert.deepEqual(result.composition, baseline.composition, 'only potentially placeable geometry informs scene scale');
  assert.ok(result.composition!.focal?.cells.length); assert.ok(result.composition!.supports.length); assert.ok(result.composition!.quietCells.length);
  assert.ok(result.map.propInstances!.length >= 2); assert.ok(result.map.propInstances!.every(p => p.bindingId === console.id));
  const occupied = new Set(result.map.propInstances!.flatMap(p => p.cells.map(key)));
  assert.ok(result.composition!.quietCells.every(c => !occupied.has(key(c))));
  assert.deepEqual(propValidationIssues(result.map, [console, ...huge]), []);
  assert.deepEqual(analyzeLevelDesign(result.map, s).issues.filter(i => i.severity === 'error'), []);
  assert.deepEqual(result, placeGroupedProps(source, s, [...huge].reverse().concat(console)));
});

test('central scene is denser than support areas and high coverage cannot consume the quiet patch', () => {
  const source = room(), s = settings(), bindings = [asset()], result = placeGroupedProps(source, s, bindings), plan = result.composition!;
  const props = result.map.propInstances ?? [], occupied = new Set(props.flatMap(p => p.cells.map(key)));
  const focal = plan.zones.filter(c => c.kind === 'focal'), support = plan.zones.filter(c => c.kind === 'support');
  const density = (cells: Cell[]) => cells.filter(c => occupied.has(key(c))).length / cells.length;
  assert.ok(density(focal) >= density(support) * 1.5, `focal ${density(focal)}; support ${density(support)}`);
  assert.ok(props.some(p => p.cells.some(c => support.some(n => key(c) === key(n)))), 'support scenes must also be present');
  assert.ok(plan.quietCells.every(c => !occupied.has(key(c))));
  assert.ok(plan.quietPatches[0].cells.length >= 4); plan.quietPatches.forEach(patch => assertConnected(patch.cells));
  assert.ok(result.issues.some(i => i.code === 'grouped-props-unmet' && i.message.includes('여백')));
  assert.deepEqual(propValidationIssues(result.map, bindings), []);
  assert.deepEqual(analyzeLevelDesign(result.map, s).issues.filter(i => i.severity === 'error'), []);
  assert.deepEqual(placeGroupedProps(result.map, s, bindings).map, result.map);
});

test('secondary scenes are compact distinct pockets and the main scene dominates each individual support scene', () => {
  const source = room(24, 20), s = settings(); s.width = 24; s.height = 20; s.designer!.propCoverage = 8;
  const bindings = [asset('Console'), asset('Generator'), asset('Crate')];
  for (const b of bindings) b.prop!.composition = { usage: 'equipment', family: 'machines', member: 'either', arrangement: 'either' };
  bindings[1].prop!.size!.x = 2.4;
  const placed = placeGroupedProps(source, s, bindings), plan = placed.composition!;
  const occupied = new Set(placed.map.propInstances!.flatMap(p => p.cells.map(key)));
  const mass = (cells: Cell[]) => cells.filter(c => occupied.has(key(c))).length;
  assert.ok(plan.supports.length >= 2, 'the room has distinct secondary activity spaces');
  assert.ok(plan.quietCells.length > plan.supports.reduce((sum, area) => sum + area.cells.length, 0), 'open floor must remain between local support scenes');
  assert.ok(plan.quietPatches[0].cells.length >= Math.sqrt(source.width * source.height));
  for (const support of plan.supports) {
    assertConnected(support.cells);
    assert.ok(support.cells.length < plan.focal!.cells.length, 'a support scene cannot consume the rest of the room');
    assert.ok(mass(plan.focal!.cells) >= mass(support.cells) * 1.5, 'the main scene reads as a larger individual mass');
    const width = Math.max(...support.cells.map(c => c.x)) - Math.min(...support.cells.map(c => c.x)) + 1;
    const height = Math.max(...support.cells.map(c => c.row)) - Math.min(...support.cells.map(c => c.row)) + 1;
    assert.ok(Math.max(width, height) <= Math.sqrt(support.cells.length) * 2, 'secondary influence stays compact');
  }
  assert.ok(plan.quietCells.every(c => !occupied.has(key(c))));
  assert.deepEqual(placed.map, placeGroupedProps(placed.map, s, bindings).map);
});

test('several seeds and broad irregular footprints retain an actual focal group, separated scenes and navigable quiet floor', () => {
  const outlines = ['rectangle', 'bend', 'inset', 'long'] as const, counts = new Set<number>();
  const bindings = [asset('Console'), asset('Generator'), asset('Crate')];
  for (const b of bindings) { b.prop!.composition = { usage: 'equipment', family: 'machines', member: 'either', arrangement: 'either' }; b.prop!.roomTypes.push('battle'); }
  bindings[1].prop!.size!.x = 2.4;
  for (const outline of outlines) for (const seed of [0, 1, 2, 3, 17, 99, 237, 1001]) {
    const map = outline === 'long' ? room(12, 40) : room(30, 24), s = settings();
    s.width = map.width; s.height = map.height; s.seed = seed; s.designer!.preset = 'battle';
    if (outline === 'bend') for (let row = 1; row < 11; row++) map.rows[row] = map.rows[row].slice(0, 21) + '#'.repeat(9);
    if (outline === 'inset') for (let row = 16; row < map.height; row++) map.rows[row] = map.rows[row].slice(0, 12) + '#'.repeat(6) + map.rows[row].slice(18);
    const result = placeGroupedProps(map, s, bindings), plan = result.composition!, context = `${outline}, seed ${seed}`;
    const occupied = new Set((result.map.propInstances ?? []).flatMap(p => p.cells.map(key))), focal = new Set(plan.focal!.cells.map(key));
    const focalGroups = new Set((result.map.propInstances ?? []).filter(p => p.cells.some(c => focal.has(key(c)))).map(p => p.groupId));
    assert.ok(focalGroups.size > 0, `${context}: the primary area needs a real completed scene`);
    assert.ok(plan.supports.some(support => support.cells.some(c => occupied.has(key(c)))), `${context}: at least one secondary scene fits`);
    assert.ok(plan.quietPatches.some(patch => patch.cells.length >= 4), `${context}: additional connected quiet floor`);
    assert.ok(plan.quietCells.every(c => !occupied.has(key(c))), `${context}: quiet floor stays clear`);
    for (const support of plan.supports) { assertConnected(support.cells); assert.ok(support.cells.length < plan.focal!.cells.length, context); }
    assert.deepEqual(propValidationIssues(result.map, bindings), [], context);
    assert.deepEqual(analyzeLevelDesign(result.map, s).issues.filter(i => i.severity === 'error'), [], context);
    counts.add(plan.supports.length);
  }
  assert.ok(counts.size > 1, 'secondary scene count adapts to seed and usable geometry');
});

test('movable generated furniture cannot shift the plan, while manual and locked content stays authoritative', () => {
  const s = settings(), map = room(), bindings = [asset()], placed = placeGroupedProps(map, s, bindings);
  assert.deepEqual(planRoomComposition(map, s, bindings), planRoomComposition(placed.map, s, bindings));
  const manual = structuredClone(placed.map); manual.propInstances![0].provenance = 'manual';
  // Claiming one member protects its entire group.
  const protectedGroup = manual.propInstances!.filter(p => p.groupId === manual.propInstances![0].groupId);
  const terrain = compositionTerrain(manual), plan = planRoomComposition(manual, s, bindings);
  assert.ok(protectedGroup.every(p => terrain.propInstances!.some(n => n.id === p.id)));
  const planned = new Set(plan.zones.map(key));
  assert.ok(protectedGroup.every(p => p.cells.every(c => !planned.has(key(c)))));
});

test('partial furnishing shares the whole-room focal point, and additive furnishing preserves measured objects', () => {
  const map = room(), s = settings(), bindings = [asset()], full = placeGroupedProps(map, s, bindings);
  const region = { x: 1, row: 1, width: 10, height: 20 }, partial = placeGroupedProps(map, s, bindings, region);
  assert.deepEqual(partial.composition, full.composition);
  assert.ok((partial.map.propInstances ?? []).every(p => p.cells.every(c => c.x >= region.x && c.row >= region.row && c.x < region.x + region.width && c.row < region.row + region.height)));
  const added = furnishExistingMap(full.map, { ...s, designer: { ...s.designer!, propCoverage: 30 } }, bindings, { props: true, decorations: false });
  for (const prop of full.map.propInstances ?? []) assert.deepEqual(added.map.propInstances!.find(p => p.id === prop.id), prop);
});

test('actual partial feature generation keeps whole-room quiet space and focal position despite synthetic prop locks', () => {
  const s = settings(), bindings = [asset()], base = room(); base.lockedCells = [{ x: 2, row: 2 }];
  const source = applyGeneratedFeatures(base, s, undefined, bindings), before = structuredClone(source);
  const full = placeGroupedProps(source, s, bindings).composition!, quiet = new Set(full.quietCells.map(key));
  let region: { x: number; row: number; width: number; height: number } | undefined;
  for (let row = 1; row < source.height - 6 && !region; row++) for (let x = 1; x < source.width - 6; x++) {
    if (Array.from({ length: 36 }, (_, i) => ({ x: x + i % 6, row: row + Math.floor(i / 6) })).every(c => quiet.has(key(c)))) {
      region = { x, row, width: 6, height: 6 }; break;
    }
  }
  assert.ok(region, 'the fixture needs a substantial quiet regeneration region');
  const area = region!, candidate = structuredClone(source);
  candidate.propInstances = []; candidate.fixtures = []; candidate.rows = candidate.rows.map(row => row.replace(/P/g, '.'));
  const result = mergeGeneratedRegion(source, candidate, area,
    merged => applyGeneratedFeatures(merged, s, area, bindings, undefined, source.lockedCells ?? []), bindings);
  // The old synthetic-lock plan selected a new primary inside this previously quiet patch.
  assert.deepEqual(result.propInstances, source.propInstances, 'an unedited quiet region must not acquire a second focal scene');
  assert.deepEqual(result.rows, source.rows); assert.deepEqual(result.elevations, source.elevations);
  assert.deepEqual(result.connections, source.connections); assert.deepEqual(result.lockedCells, source.lockedCells);
  const synthetic = { ...source, lockedCells: [...source.lockedCells!, ...source.propInstances!.flatMap(p => p.cells)] };
  const partialPlan = placeGroupedProps(synthetic, s, bindings, area, [], undefined, source.lockedCells).composition!;
  assert.deepEqual(partialPlan.focal, full.focal); assert.deepEqual(partialPlan.quietCells, full.quietCells);
  assert.deepEqual(source, before); assert.deepEqual(propValidationIssues(result, bindings), []);
  assert.deepEqual(analyzeLevelDesign(result, s).issues.filter(i => i.severity === 'error'), []);
});

test('a rearrangement with no complete replacement preserves all old generated furniture', () => {
  const map = room(), s = settings(), binding = asset();
  const p: PropInstance = { id: 'old-generated', bindingId: binding.id, role: 'prop', x: 3, row: 4, direction: 0, offset: { x: 0, y: 0, z: 0 },
    cells: [{ x: 3, row: 4 }], size: { x: 1.2, y: 1, z: 1.2 }, blocksMovement: true, category: 'Crate', provenance: 'generated' };
  map.propInstances = [p]; map.rows[4] = map.rows[4].slice(0, 3) + 'P' + map.rows[4].slice(4);
  binding.prop!.composition!.member = 'anchor';
  const before = structuredClone(map), result = rearrangeMapProps(map, s, [binding], { props: true, decorations: false });
  assert.deepEqual(result.map, before); assert.equal(result.unchanged, true); assert.equal(result.removedProps, 0);
  assert.ok(result.issues.some(i => i.code === 'furnishing-rearranged-unavailable'), JSON.stringify(result.issues));
});
