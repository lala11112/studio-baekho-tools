import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionCells } from '../src/shared/connections';
import { DEFAULT_DESIGNER } from '../src/shared/features';
import { DEFAULT_SETTINGS } from '../src/shared/map';
import { DEFAULT_LEVEL_DESIGN, placeLevelDesignContent } from '../src/shared/level-design';
import { placeTeleportMarkers, teleportClearance, teleportIssues, teleportReservedCells } from '../src/shared/teleport';
import type { AssetBinding, GameplayMarker, GenerationSettings, GridMap, MapFixture } from '../src/shared/types';

function room(size = 10): GridMap {
  const rows = Array.from({ length: size }, (_, row) => row === 0 || row === size - 1 ? '#'.repeat(size) : `#${'.'.repeat(size - 2)}#`);
  const x = Math.floor(size / 2); rows[0] = rows[0].slice(0, x) + 'D' + rows[0].slice(x + 1);
  return { version: 5, name: '순간이동 검증', width: size, height: size, cellSize: 2, rows,
    elevations: Array.from({ length: size }, () => Array(size).fill(0)), ramps: [], maxStepHeight: .4,
    connections: [{ id: 'north', label: '북문', kind: 'door', x, row: 0, direction: 0, width: 2, height: 3 }], assetOverrides: [] };
}
const settings = (count = 1): GenerationSettings => ({ ...DEFAULT_SETTINGS, seed: 72,
  designer: { ...DEFAULT_DESIGNER, preset: 'shop', teleports: true, teleportCount: count, headroom: 2 },
  levelDesign: { ...DEFAULT_LEVEL_DESIGN } });
const landing = (x = 4, row = 4, radius = .4, height = 2, id = 'landing'): GameplayMarker => ({ id, label: id, kind: 'teleport', contentKey: '', x, row,
  direction: 0, offset: { x: 0, y: 0, z: 0 }, clearance: { radius, height } });
const fixture = (id: string, x: number, row: number, role: MapFixture['role']): MapFixture => ({ id, role, x, row, direction: 0, offset: { x: 0, y: 0, z: 0 } });
const binding = (id: string, role: AssetBinding['role']): AssetBinding => ({ id, label: id, role, prefabGuid: 'a'.repeat(32), prefabPath: `Assets/${id}.prefab`, scale: { x: 1, y: 1, z: 1 }, rotationY: 0, offset: { x: 0, y: 0, z: 0 } });
const tile = (map: GridMap, x: number, row: number, value: string) => { map.rows[row] = map.rows[row].slice(0, x) + value + map.rows[row].slice(x + 1); };
function widenDoor(map: GridMap, width: number): void { map.connections[0].width = width; for (const c of connectionCells(map, map.connections[0])) tile(map, c.x, c.row, 'D'); }
const has = (map: GridMap, code: string, bindings?: AssetBinding[]) => teleportIssues(map, bindings).some(issue => issue.code === `teleport-${code}`);

test('landing generation returns an exact deterministic count and leaves its source unchanged', () => {
  const map = room(), before = structuredClone(map), s = settings(4);
  const a = placeTeleportMarkers(map, s), b = placeTeleportMarkers(map, s);
  assert.deepEqual(a, b); assert.deepEqual(map, before); assert.equal(a.markers!.length, 4);
  assert.deepEqual(teleportIssues(a), []);
  assert.equal(new Set(a.markers!.map(m => `${m.x},${m.row}`)).size, 4);
  assert.ok(a.markers!.every(m => m.kind === 'teleport' && m.clearance?.radius === .4 && m.clearance.height === 2));
  assert.notDeepEqual(placeTeleportMarkers(map, { ...s, seed: 73 }).markers, a.markers);
});

test('clearance snapshots use configured dimensions, permit short wide bodies, and do not require combat settings', () => {
  const map = room(), s = settings(); s.levelDesign!.characterRadius = 1.1; s.designer!.headroom = .5; widenDoor(map, 6);
  assert.deepEqual(teleportClearance(s), { radius: 1.1, height: .5 });
  const generated = placeTeleportMarkers(map, s); assert.deepEqual(teleportIssues(generated), []);
  delete s.levelDesign; delete s.designer;
  assert.deepEqual(teleportClearance(s, { ...map, headroom: 2.5 }), { radius: .4, height: 2.5 });
});

test('enemy distance is unrestricted while sharing a marker cell is rejected', () => {
  const map = room(), m = landing(); map.markers = [m, { ...landing(5, 4), id: 'enemy', kind: 'enemy', clearance: undefined }];
  assert.deepEqual(teleportIssues(map), []);
  map.markers[1].x = m.x; assert.ok(has(map, 'occupied'));
});

test('the complete landing disk and authored offset need flat same-height support', () => {
  const map = room(), m = landing(); map.markers = [m]; tile(map, 5, 4, '_');
  assert.deepEqual(teleportIssues(map), []);
  m.offset.x = .9; assert.ok(has(map, 'support'));
  m.offset.x = 0; m.offset.y = .1; assert.ok(has(map, 'support'));
  m.offset.y = 0;
  for (const t of ['R', 'B', 'D']) { tile(map, 4, 4, t); assert.ok(has(map, 'support')); }
  tile(map, 4, 4, '.'); tile(map, 5, 4, '.'); m.clearance!.radius = 1.1; widenDoor(map, 6);
  map.elevations[4][5] = .2; assert.ok(has(map, 'support'), 'even a traversable step cannot support a flat landing disk');
});

test('headroom covers every touched cell including horizontal offset and small cells', () => {
  const map = room(), m = landing(4, 4, 1.1); widenDoor(map, 6); map.markers = [m];
  map.ceilings = [{ x: 5, row: 4, undersideY: 1.8 }]; assert.ok(has(map, 'headroom'));
  m.clearance!.radius = .4; assert.deepEqual(teleportIssues(map), []);
  m.offset.x = .9; assert.ok(has(map, 'headroom'));
  const small = room(16); small.cellSize = .25; small.connections[0].width = .25; small.markers = [landing(7, 7, .4)];
  tile(small, 8, 7, '_'); assert.ok(has(small, 'support'));
});

test('saved landing disks cannot overlap and greedy exhaustion fails without modifying the source', () => {
  const map = room(); widenDoor(map, 6); map.markers = [landing(4, 4, 1.1), landing(5, 4, 1.1, 2, 'second')];
  assert.ok(has(map, 'overlap'));
  const source = room(); widenDoor(source, 6); const before = structuredClone(source), s = settings(20); s.levelDesign!.characterRadius = 1.1;
  assert.throws(() => placeTeleportMarkers(source, s), /착지 영역|공간이 부족/); assert.deepEqual(source, before);
});

test('water hazards and traps cannot occupy landing space or form the only exit route', () => {
  for (const role of ['water', 'hazard', 'trap'] as const) {
    const map = room(); map.markers = [landing(4, 6)];
    map.fixtures = Array.from({ length: 8 }, (_, i) => fixture(`${role}-${i}`, i + 1, 2, role));
    assert.ok(has(map, 'route'), role);
    map.fixtures = [fixture(role, 4, 6, role)]; assert.ok(has(map, 'obstacle'), role);
  }
});

test('routes require height-correct access through at least one door fitting the saved player', () => {
  const map = room(); map.markers = [landing()]; map.connections[0].width = .5; assert.ok(has(map, 'route'));
  map.connections[0].width = 2; map.connections[0].height = 1; assert.ok(has(map, 'route'));
  map.connections[0].height = 3;
  for (let row = 3; row < map.height - 1; row++) for (let x = 1; x < map.width - 1; x++) map.elevations[row][x] = 2;
  assert.ok(has(map, 'route'));
});

test('legitimate stair climbs and straight bridge routes remain usable for landing access', () => {
  const map = room(8); map.rows = Array(8).fill('########'); map.rows[3] = '_D.R..##';
  map.connections = [{ id: 'west', label: '서문', kind: 'door', x: 1, row: 3, direction: 270, width: 2, height: 3 }];
  map.ramps = [{ x: 3, row: 3, direction: 90, rise: 2 }]; map.elevations[3][4] = 2; map.elevations[3][5] = 2;
  map.markers = [landing(5, 3)]; assert.deepEqual(teleportIssues(map), [], 'a ramp joins the low doorway to a raised landing');
  map.ramps = []; map.elevations[3][4] = 0; map.elevations[3][5] = 0; tile(map, 3, 3, 'B'); tile(map, 3, 2, '_'); tile(map, 3, 4, '_');
  map.bridges = [{ x: 3, row: 3, direction: 90 }]; assert.deepEqual(teleportIssues(map), [], 'a bridge is traversed along its saved axis');
});

test('registered prop offsets and hanging nonblocking props participate in body clearance', () => {
  const map = room(), b = binding('decoration', 'decoration'); map.markers = [landing()];
  b.offset.x = -.2;
  map.propInstances = [{ id: 'measured', bindingId: b.id, x: 5, row: 4, direction: 0, offset: { x: -1.2, y: 0, z: 0 },
    size: { x: 1, y: 2, z: 1 }, cells: [{ x: 5, row: 4 }], blocksMovement: false, category: 'decoration', anchor: 'floor' }];
  assert.ok(has(map, 'obstacle', [b]));
  b.offset.x = 0; Object.assign(map.propInstances[0], { x: 4, anchor: 'ceiling', offset: { x: 0, y: 0, z: 0 } }); map.ceilings = [{ x: 4, row: 4, undersideY: 3 }];
  assert.ok(has(map, 'obstacle', [b]));
  map.propInstances[0].size.y = .5; assert.deepEqual(teleportIssues(map, [b]), []);
});

test('registered fixture pivots and saved wall collision boxes use world bounds', () => {
  const map = room(), b = binding('merchant', 'merchant'); map.markers = [landing()];
  b.bounds = { center: { x: -1.5, y: 1, z: 0 }, size: { x: 1, y: 2, z: 1 } };
  map.fixtures = [fixture('merchant', 5, 4, 'merchant')]; assert.ok(has(map, 'obstacle', [b]));
  const x = (4 - 4.5) * 2, z = (4.5 - 4) * 2;
  map.fixtures = [{ ...fixture('wall', 0, 4, 'decoration'), wall: { position: { x, y: 0, z }, rotationY: 0, support: [{ x: 0, row: 4, direction: 90 }],
    sockets: [], site: 'wall', bounds: [{ center: { x, y: 1, z }, size: { x: 1, y: 2, z: 1 } }] } }];
  assert.ok(has(map, 'obstacle'));
});

test('legacy prop tiles and registered wall prefabs reserve measured overhang outside their grid cell', () => {
  const map = room(), b = binding('legacy-prop', 'prop'); map.markers = [landing()]; tile(map, 5, 4, 'P');
  b.bounds = { center: { x: -1.2, y: 3, z: 0 }, size: { x: 1, y: 2, z: 1 } };
  assert.ok(has(map, 'obstacle', [b]), 'surface bottom alignment ignores the original pivot Y');
  tile(map, 5, 4, '#'); b.role = 'wall'; map.wallHeights = [{ x: 5, row: 4, height: 3 }];
  assert.ok(has(map, 'obstacle', [b]));
});

test('thin registered obstacles and hazards between clear cell centers block swept route edges', () => {
  for (const role of ['decoration', 'trap'] as const) {
    const map = room(8); map.rows = Array(8).fill('########'); map.rows[3] = '_D....##';
    map.connections = [{ id: 'west', label: '서문', kind: 'door', x: 1, row: 3, direction: 270, width: 2, height: 3 }]; map.markers = [landing(5, 3)];
    const b = binding('barrier', role); b.bounds = { center: { x: 0, y: 1, z: 0 }, size: { x: .1, y: 2, z: 2 } };
    map.fixtures = [{ ...fixture('barrier', 2, 3, role), offset: { x: 1, y: 0, z: 0 } }];
    assert.ok(has(map, 'route', [b]), role);
  }
});

test('resolved structure binding offsets and shifted floor assets cannot invalidate a landing silently', () => {
  const map = room(), wall = binding('wall', 'wall'); map.markers = [landing()];
  const p = { x: (5 - 4.5) * 2, y: 1, z: (4.5 - 4) * 2 };
  map.structureFills = [{ id: 'fill', role: 'wall', purpose: 'doorSide', x: 5, row: 4, direction: 0, position: p, size: { x: .2, y: 2, z: 1 } }];
  assert.deepEqual(teleportIssues(map, [wall]), []); wall.offset.x = -1.6; assert.ok(has(map, 'obstacle', [wall]));
  map.structureFills = []; const floor = binding('floor', 'floor'); floor.offset.y = .1;
  assert.ok(has(map, 'floor-offset', [floor])); assert.match(teleportIssues(map, [floor])[0].message, /바닥 에셋 위치 보정/);
  floor.offset.y = 0; floor.offset.x = .5; assert.ok(has(map, 'floor-offset', [floor]));
  floor.offset.x = 0; floor.offset.z = .5; assert.ok(has(map, 'floor-offset', [floor]));
  floor.offset.z = 0; const ceiling = binding('ceiling', 'ceiling'); ceiling.offset.y = -.5;
  map.ceilings = [{ x: 4, row: 4, undersideY: 2.25 }]; assert.ok(has(map, 'headroom', [floor, ceiling]));
});

test('partial generation preserves locked and outside markers and treats the count as a map total', () => {
  const map = room(); map.markers = [landing(2, 2, .4, 2, 'outside'), landing(3, 3, .4, 2, 'locked'), landing(6, 6, .4, 2, 'replace')];
  map.lockedCells = [{ x: 3, row: 3 }]; const before = structuredClone(map);
  const result = placeTeleportMarkers(map, settings(3), [], { x: 3, row: 3, width: 5, height: 5 });
  assert.equal(result.markers!.length, 3); assert.deepEqual(result.markers!.find(m => m.id === 'outside'), before.markers![0]);
  assert.deepEqual(result.markers!.find(m => m.id === 'locked'), before.markers![1]); assert.ok(!result.markers!.some(m => m.id === 'replace'));
  assert.throws(() => placeTeleportMarkers(map, settings(1), [], { x: 3, row: 3, width: 5, height: 5 }), /保|보존/);
  assert.deepEqual(map, before);
});

test('footprint reservations honor saved radius and offset and generic content placement keeps the landing pose', () => {
  const map = room(16); widenDoor(map, 6); const m = landing(6, 6, 1.1); m.offset.x = .2; map.markers = [m];
  const cells = new Set(teleportReservedCells(map).map(c => `${c.x},${c.row}`));
  assert.ok(cells.has('6,6')); assert.ok(cells.has('7,6')); assert.ok(cells.has('6,5'));
  const s = settings(); const placed = placeLevelDesignContent(map, s);
  assert.deepEqual(placed.markers!.find(item => item.id === m.id), m);
});

test('disabled generation is unchanged and malformed teleport snapshots produce a targeted error', () => {
  const map = room(), s = settings(); s.designer!.teleports = false; assert.deepEqual(placeTeleportMarkers(map, s), map);
  map.markers = [landing()]; delete map.markers[0].clearance; assert.ok(has(map, 'clearance'));
  map.markers[0].kind = 'event'; assert.deepEqual(teleportIssues(map), []);
});
