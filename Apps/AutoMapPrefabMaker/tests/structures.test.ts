import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticCeilingY, configureStructures, DEFAULT_STRUCTURE_SETTINGS, highestFloorSurface, setPitBottom, structureDataErrors, structureIssues, synchronizeStructures, floorSlabBounds, resolvedStructureFill, resolvedCliffFace } from '../src/shared/structures';
import { buildManifest } from '../src/shared/map';
import type { AssetBinding, GridMap, StructureFill } from '../src/shared/types';

function room(): GridMap {
  return { version: 4, name: 'Structures', width: 8, height: 8, cellSize: 2, maxStepHeight: .4,
    rows: ['#D######','#......#','#......#','#......#','#......#','#......#','#......#','########'],
    elevations: Array.from({ length: 8 }, () => Array(8).fill(0)), ramps: [],
    connections: [{ id: 'north', label: 'North', x: 1, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }], assetOverrides: [] };
}
const repair = (map: GridMap) => configureStructures(map, DEFAULT_STRUCTURE_SETTINGS);
function pitRoom(): GridMap { const m = room(); m.rows[2] = '#..__..#'; m.rows[3] = '#..BB..#'; m.rows[4] = '#..__..#'; m.bridges = [{ x: 3, row: 3, direction: 90 }, { x: 4, row: 3, direction: 90 }]; return m; }

test('automatic roof uses highest physical floor surface, including ramp high end and bridge deck', () => {
  const m = room(); m.elevations[0][0] = 100; m.rows[3] = '#..R...#'; m.elevations[3][3] = 4; m.ramps = [{ x: 3, row: 3, direction: 90, rise: 2 }];
  m.pitBottoms = [{ x: 4, row: 4, y: 150, kind: 'floor', thickness: 1 }];
  assert.equal(highestFloorSurface(m), 6); assert.equal(automaticCeilingY(m, 4), 10);
  m.rows[2] = '#..B...#'; m.elevations[2][3] = 8; assert.equal(highestFloorSurface(m), 8);
});

test('repair adopts unlocked roofs while sync preserves manual roofs, holes and ceiling anchored offsets', () => {
  const m = room(); m.ceilings = [{ x: 2, row: 2, undersideY: 4 }, { x: 3, row: 2, undersideY: 7 }]; m.lockedCells = [{ x: 3, row: 2 }];
  m.fixtures = [{ id: 'lamp', role: 'light', x: 2, row: 2, direction: 0, anchor: 'ceiling', offset: { x: 0, y: -.2, z: 0 } }];
  const adopted = repair(m); adopted.elevations[4][4] = 6;
  adopted.ceilings!.push({ x: 4, row: 2, undersideY: 15, heightMode: 'manual' });
  const updated = synchronizeStructures(adopted);
  assert.equal(updated.ceilings![0].undersideY, 10); assert.equal(updated.ceilings![1].undersideY, 7); assert.equal(updated.ceilings![2].undersideY, 15);
  assert.equal(updated.ceilings!.length, 3); assert.equal(updated.wallHeights![0].height, 10); assert.equal(updated.fixtures![0].offset.y, -.2);
  assert.equal(m.ceilings![0].heightMode, undefined, 'source is not mutated');
});

test('partial regeneration rejects changed automatic roof outside its region', () => {
  const m = room(); m.ceilings = [{ x: 2, row: 2, undersideY: 4 }]; const adopted = repair(m); adopted.elevations[4][4] = 2;
  assert.throws(() => synchronizeStructures(adopted, { x: 4, row: 4, width: 1, height: 1 }), /\(2, 2\)/);
  assert.equal(adopted.ceilings![0].undersideY, 4);
});

test('connected lower pit closure extends under bridges and every rim reaches the same bottom', () => {
  const m = pitRoom(); m.elevations = m.elevations.map(row => row.map(() => -2)); m.elevations[2][2] = 3;
  const updated = repair(m); assert.equal(updated.pitBottoms!.length, 6); assert.ok(updated.pitBottoms!.every(b => b.y === -6 && b.kind === 'deadzone' && b.thickness === 1));
  assert.ok(updated.pitBottoms!.some(b => b.x === 3 && b.row === 3));
  const sides = updated.structureFills!.filter(f => f.purpose === 'pitSide');
  assert.equal(sides.length, 10); assert.ok(sides.every(f => Math.abs(f.position.y - f.size.y / 2 + 6) < 1e-8));
  assert.equal(sides.find(f => f.x === 2 && f.row === 2)!.size.y, 9);
  assert.deepEqual(structureIssues(updated), []);
  const edited = setPitBottom(updated, { x: 3, row: 2 }, { y: -8, kind: 'floor', thickness: .24 });
  assert.ok(edited.pitBottoms!.every(b => b.kind === 'floor' && b.y === -8 && b.thickness === .24));
});

test('exterior void and open space beyond a door do not receive pit bottoms', () => {
  const m = room(); m.rows[0] = '_D######'; m.rows[1] = '_......#';
  assert.deepEqual(repair(m).pitBottoms, []);
});

test('wide noninteger door fills opening top and both side margins in every direction', () => {
  for (const direction of [0, 90, 180, 270] as const) {
    const m = room(); m.connections = [{ ...m.connections[0], x: 2, row: 2, width: 5.5, direction }];
    m.ceilings = (direction % 180 === 0 ? [0,1,2].map(i => ({ x: 2 + i, row: 2, undersideY: 6 })) : [0,1,2].map(i => ({ x: 2, row: 2 + i, undersideY: 6 })));
    const updated = configureStructures(m, { ...DEFAULT_STRUCTURE_SETTINGS, ceilingClearance: 6 });
    const tops = updated.structureFills!.filter(f => f.purpose === 'doorTop'), sides = updated.structureFills!.filter(f => f.purpose === 'doorSide');
    assert.equal(tops.length, 3); assert.ok(tops.every(f => f.size.y === 3 && f.position.y === 4.5));
    assert.ok(tops.every(f => f.size.x === m.cellSize && f.size.z === m.cellSize), 'door tops span the same footprint as wall cells');
    assert.ok(tops.every(f => f.position.y - f.size.y / 2 === m.connections[0].height && f.position.y + f.size.y / 2 === 6), 'opening and roof heights are preserved');
    assert.equal(sides.length, 2); assert.ok(sides.every(f => (direction % 180 === 0 ? f.size.x : f.size.z) === .25));
    const axis = direction % 180 === 0 ? 'x' : 'z'; const centers = sides.map(f => f.position[axis]).sort((a,b)=>a-b);
    assert.equal(centers[1] - centers[0] - .25, 5.5, 'exact unobstructed width remains');
  }
});

test('door with equal roof height has no lintel, and unroofed door uses adjacent wall top', () => {
  const m = room(); m.ceilings = [{ x: 1, row: 0, undersideY: 3 }];
  assert.equal(configureStructures(m, { ...DEFAULT_STRUCTURE_SETTINGS, ceilingClearance: 3 }).structureFills!.filter(f => f.purpose === 'doorTop').length, 0);
  const manual = room(); manual.structureSettings = DEFAULT_STRUCTURE_SETTINGS; manual.wallHeights = [{ x: 0, row: 0, height: 8, heightMode: 'manual' }];
  assert.equal(synchronizeStructures(manual).structureFills!.find(f => f.purpose === 'doorTop')!.size.y, 5);
});

test('step faces emit once on high side and never obstruct a ramp high landing or bridge entrance', () => {
  const m = room(); m.elevations[3][3] = 2;
  const updated = repair(m); assert.equal(updated.structureFills!.filter(f => f.purpose === 'heightGap').length, 4);
  m.rows[3] = '#.R....#'; m.ramps = [{ x: 2, row: 3, direction: 90, rise: 2 }];
  assert.ok(!repair(m).structureFills!.some(f => f.purpose === 'heightGap' && f.x === 3 && f.row === 3 && f.direction === 270));
  m.rows[3] = '#.B....#'; m.bridges = [{ x: 2, row: 3, direction: 90 }]; m.ramps = []; m.elevations[3][2] = 2;
  assert.ok(!repair(m).structureFills!.some(f => f.purpose === 'heightGap' && f.x === 3 && f.row === 3 && f.direction === 270));
});

test('v5 structure parser rejects malformed dimensions, duplicate entries and unsafe ids', () => {
  const m = repair(pitRoom()); assert.deepEqual(structureDataErrors(m as unknown as Record<string, unknown>), []);
  for (const patch of [ { structureSettings: { ...DEFAULT_STRUCTURE_SETTINGS, pitDepth: NaN } }, { pitBottoms: [...m.pitBottoms!, m.pitBottoms![0]] }, { structureFills: [{ ...m.structureFills![0], size: { x: 1, y: 0, z: 1 } }] }, { structureFills: [{ ...m.structureFills![0], id: 'bad/id' }] } ]) assert.ok(structureDataErrors({ ...m, ...patch }).length);
});

const binding = (role: AssetBinding['role'], id: string = role): AssetBinding => ({ id, role, label: id, prefabGuid: '1'.repeat(32), prefabPath: `Assets/${id}.prefab`, scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0 });
const near = (a: number, b: number) => assert.ok(Math.abs(a-b) < 1e-8, `${a} != ${b}`);

test('saved thin door tops resolve and export as full wall cells without rewriting saved geometry', () => {
  for (const direction of [0, 90, 180, 270] as const) for (const cellSize of [1, 2, 4]) {
    const m = room(); m.cellSize = cellSize;
    const x = direction === 90 ? 7 : direction === 270 ? 0 : 2, row = direction === 0 ? 0 : direction === 180 ? 7 : 2;
    m.rows[0] = '########'; m.rows[row] = m.rows[row].slice(0, x) + 'D' + m.rows[row].slice(x + 1);
    m.connections[0] = { ...m.connections[0], x, row, width: cellSize, direction };
    const saved = repair(m), fill = saved.structureFills!.find(f => f.purpose === 'doorTop')!;
    fill.size[direction % 180 === 0 ? 'z' : 'x'] = Math.min(.2, cellSize * .12);
    saved.lockedCells = [{ x, row }];
    const original = structuredClone(saved), wall = binding('wall'); wall.offset = { x: .1, y: .2, z: -.3 };
    const bindings = [binding('floor'), wall, binding('door')];
    const geometry = resolvedStructureFill(saved, fill, bindings)!;
    assert.deepEqual(geometry.size, { x: cellSize, y: fill.size.y, z: cellSize });
    assert.deepEqual(geometry.position, { x: fill.position.x + .1, y: fill.position.y + .2, z: fill.position.z - .3 });
    const exported = buildManifest(saved, bindings).placements.find(p => p.id === `fill-${fill.id}`)!;
    assert.deepEqual(exported.fitSize, geometry.size); assert.deepEqual(exported.position, geometry.position);
    assert.deepEqual(synchronizeStructures(saved, { x: 3, row: 3, width: 1, height: 1 }), saved, 'legacy footprint must not cause an unrelated regional edit conflict');
    assert.deepEqual(saved, original, 'preview/export must preserve saved and locked geometry records');
  }
});

test('step and pit supports terminate at the resolved floor underside without moving the lower edge', () => {
  const m = room(); m.elevations[3][3] = 4;
  const floor = binding('floor'), wall = binding('wall'); floor.scale.y = 2; floor.offset.y = .1; wall.offset.y = -.2;
  const fill = repair(m).structureFills!.find(f => f.purpose === 'heightGap')!;
  const result = resolvedStructureFill(m,fill,[floor,wall])!;
  near(result.position.y+result.size.y/2, 4+.1-.48); near(result.position.y-result.size.y/2, -.2);
  assert.equal(fill.position.y+fill.size.y/2,4,'saved topology span remains independent of the library');
  const pit = repair(pitRoom()), side = pit.structureFills!.find(f => f.purpose === 'pitSide')!;
  const cliff = binding('cliff'); cliff.offset.y = -.1;
  const fitted = resolvedStructureFill(pit,side,[floor,cliff])!;
  near(fitted.position.y+fitted.size.y/2, .1-.48); near(fitted.position.y-fitted.size.y/2,-4.1);
});

test('floor overrides and cyclic role binding select the exact slab thickness used by export', () => {
  const m = repair(pitRoom()), first = binding('floor','floor-a'), second = binding('floor','floor-b');
  first.scale.y = .5; second.scale.y = 3; second.offset.y = -.25;
  const side = m.structureFills!.find(f => f.purpose === 'pitSide')!;
  m.assetOverrides.push({ x: side.x, row: side.row, role: 'floor', bindingId: second.id });
  const bindings = [first,second,binding('wall'),binding('door'),binding('bridge'),binding('cliff'),binding('deadzone')];
  near(floorSlabBounds(m,side,bindings)!.bottom,-.97);
  const expected = resolvedStructureFill(m,side,bindings)!;
  const exported = buildManifest(m,bindings).placements.find(p => p.id === `fill-${side.id}`)!;
  assert.deepEqual(exported.position,expected.position);assert.deepEqual(exported.fitSize,expected.size);
  const alternating = { x: 2, row: 1 }; near(floorSlabBounds(m,alternating,[first,second])!.thickness,.12);
  near(floorSlabBounds(m,{x:3,row:1},[first,second])!.thickness,.72);
});

test('a slab that covers a small height gap omits negative or zero sized support geometry', () => {
  const m = room(); m.elevations[3][3] = .1;
  const fill = repair(m).structureFills!.find(f => f.purpose === 'heightGap')!;
  assert.equal(resolvedStructureFill(m,fill),undefined);
  const door: StructureFill = { ...fill, purpose: 'doorTop' }; assert.ok(resolvedStructureFill(m,door), 'door top has no terrain slab trim');
});

test('legacy cliffs trim their upper edge with the same overridden slab bounds', () => {
  const m = pitRoom(), cliff = { x: 2, row: 3, direction: 90 as const, depth: 4 }, floor = binding('floor');
  floor.scale.y=2;floor.offset.y=.2;
  const result=resolvedCliffFace(m,cliff,[floor])!;
  near(result.position.y+result.size.y/2,-.28);near(result.position.y-result.size.y/2,-4);
});

test('fully covered pit faces do not require a cliff prefab or emit empty placements', () => {
  const m=repair(pitRoom()), floor=binding('floor');floor.scale.y=20;
  const bindings=[floor,binding('wall'),binding('door'),binding('bridge'),binding('deadzone')];
  const manifest=buildManifest(m,bindings);
  assert.ok(!manifest.placements.some(p=>p.role==='cliff'));
  m.cliffs=[{x:2,row:2,direction:90,depth:4}];
  assert.ok(!buildManifest(m,bindings).placements.some(p=>p.role==='cliff'),'legacy covered face also needs no unused cliff asset');
});
