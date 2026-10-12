import assert from 'node:assert/strict';
import test from 'node:test';
import { buildManifest, connectionPose, resolveBinding, MAX_BINDINGS, cellElevation, createDemoMap, DEFAULT_SETTINGS, doorRotation, edgeHeight, MAP_JSON_SCHEMA, parseProjectFile, validateMap } from '../src/shared/map';
import type { AssetBinding, AssetRole, GridMap, ProjectFile } from '../src/shared/types';

const roles: AssetRole[] = ['floor', 'wall', 'door', 'prop', 'stair'];
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

const mapError = (map: unknown, fragment: string): boolean => validateMap(map).some(issue => issue.severity === 'error' && issue.message.includes(fragment));

function binding(role: AssetRole): AssetBinding {
  return {
    id: role, label: role, role, prefabGuid: String(roles.indexOf(role) + 1).repeat(32), prefabPath: `Assets/${role}.prefab`,
    scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0,
  };
}

function smallMap(rows: string[]): GridMap {
  return {
    version: 3, name: 'Test dungeon', width: 8, height: 8, cellSize: 2, rows,
    connections: [{id:'west',label:'West',x:1,row:1,direction:270,width:0.25,height:3,kind:'door'}], assetOverrides: [],
    elevations: Array.from({ length: 8 }, () => Array<number>(8).fill(0)), ramps: [], maxStepHeight: 0.4,
  };
}

function corridor(): GridMap {
  return smallMap(['________', '_D.D..__', '________', '________', '________', '________', '________', '________']);
}

function raisedCorridor(): GridMap {
  const map = smallMap(['________', '_D.R..._', '________', '________', '________', '________', '________', '________']);
  map.ramps = [{ x: 3, row: 1, direction: 90, rise: 2 }];
  for (const x of [4, 5, 6]) map.elevations[1][x] = 2;
  return map;
}

function project(map = createDemoMap()): ProjectFile {
  return { formatVersion: 1, map, settings: { ...DEFAULT_SETTINGS }, bindings: [] };
}

test('demo map is deterministic, connected, and contains every supported glyph', () => {
  const map = createDemoMap();
  assert.deepEqual(validateMap(map), []);
  assert.deepEqual(map, createDemoMap());
  assert.deepEqual([...new Set(map.rows.join(''))].sort(), [...'_.#DPR'].sort());
  map.rows[0] = 'changed';
  assert.equal(createDemoMap().rows[0], '________________');
  assert.deepEqual([DEFAULT_SETTINGS.width, DEFAULT_SETTINGS.height, DEFAULT_SETTINGS.cellSize], [16, 16, 2]);
  assert.equal(DEFAULT_SETTINGS.codexModel, '');
  assert.equal(DEFAULT_SETTINGS.elevationStep, 2);
  assert.equal(DEFAULT_SETTINGS.maxStepHeight, 0.4);
  assert.ok(map.ramps.length > 0);
  assert.ok(map.elevations.flat().some((value) => value > 0));
  for (const [x, row] of [[10, 12], [8, 11], [14, 12], [8, 14], [14, 14], [10, 10], [12, 10]]) {
    assert.equal(map.elevations[row][x], 2);
  }
  for (const ramp of map.ramps) assert.equal(map.elevations[ramp.row][ramp.x], 0);
});

test('schema has a strict root with every field required', () => {
  assert.equal(MAP_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual([...MAP_JSON_SCHEMA.required].sort(), Object.keys(MAP_JSON_SCHEMA.properties).sort());
  assert.deepEqual(MAP_JSON_SCHEMA.properties.version.enum, [3]);
  assert.equal(MAP_JSON_SCHEMA.properties.ramps.items.additionalProperties, false);
  assert.deepEqual([...MAP_JSON_SCHEMA.properties.ramps.items.required].sort(), Object.keys(MAP_JSON_SCHEMA.properties.ramps.items.properties).sort());
});

test('schema and export preserve the Unity filename boundary', () => {
  const schemaName = MAP_JSON_SCHEMA.properties.name;
  const schemaAccepts = (name: string): boolean => name.length >= schemaName.minLength
    && name.length <= schemaName.maxLength && new RegExp(schemaName.pattern).test(name);
  for (const name of ['백호 던전 01', 'a'.repeat(80), 'CONNECTION', 'COM10', 'LPT0', 'room.v2']) {
    assert.equal(schemaAccepts(name), true, name);
    assert.doesNotThrow(() => buildManifest({ ...corridor(), name }, [binding('floor'), binding('door')]));
  }
  // The API schema uses a simple regex; platform-specific reserved names are caught locally.
  for (const name of ['', 'a'.repeat(81), 'name/part', 'name\\part', 'name:part', 'name\u0000part', 'name\u007fpart']) {
    assert.equal(schemaAccepts(name), false, JSON.stringify(name));
  }
  for (const name of ['', 'a'.repeat(81), ' name', 'name ', 'name.', '.', '..', 'CON', 'con.test', 'PRN',
    'AUX', 'NUL', 'COM1', 'com9.txt', 'LPT1', 'lpt9.txt', 'name/part', 'name\\part', 'name:part',
    'name*part', 'name?part', 'name|part', 'name<part', 'name>part', 'name"part', 'name\u0000part',
    'name\u007fpart', 'name\npart', '\u0085name', 'name\u0085', 'name\u2028part ']) {
    assert.throws(() => buildManifest({ ...corridor(), name }, [binding('floor'), binding('door')]), /파일명/);
  }
});

test('validation safely rejects malformed shapes and invalid numeric values', () => {
  const map = corridor();
  for (const input of [null, [], 4, {}, { ...map, version: 1 }, { ...map, name: 12 },
    { ...map, width: 7 }, { ...map, width: 41 }, { ...map, height: 8.5 },
    { ...map, height: Infinity }, { ...map, cellSize: NaN }, { ...map, cellSize: 0.24 },
    { ...map, cellSize: 10.1 }, { ...map, rows: null }, { ...map, rows: [undefined] },
    { ...map, rows: map.rows.slice(1) }, { ...map, unexpected: true }]) {
    assert.ok(validateMap(input).some((issue) => issue.severity === 'error'), JSON.stringify(input));
  }
  assert.deepEqual(validateMap({ ...map, cellSize: 0.25 }), []);
  assert.deepEqual(validateMap({ ...map, cellSize: 10 }), []);
});

test('validation rejects wrong row widths, whitespace, and unknown glyphs', () => {
  for (const row of ['_______', '_________', '___ ___X', '____\t___', '___A____', '___s____']) {
    const map = corridor();
    map.rows[7] = row;
    assert.ok(validateMap(map).length > 0, row);
  }
});

test('props block connectivity, and disconnected floor islands also fail validation', () => {
  const blocked = corridor();
  blocked.rows[1] = '_D.P..__';
  assert.ok(validateMap(blocked).some((issue) => issue.message.includes('연결되어 있지')));
  const island = corridor();
  island.rows[6] = '____.___';
  assert.ok(validateMap(island).some((issue) => issue.message.includes('연결되어 있지')));
});

test('connectivity is cardinal and never wraps across row edges', () => {
  const diagonal = smallMap(['D_______', '_.______', '________', '________', '________', '________', '________', '________']);
  const wrapped = smallMap(['_______D', '._______', '________', '________', '________', '________', '________', '________']);
  assert.ok(validateMap(diagonal).some((issue) => issue.message.includes('연결되어 있지')));
  assert.ok(validateMap(wrapped).some((issue) => issue.message.includes('연결되어 있지')));
});

test('height-aware connectivity accepts stairs and rejects cliffs, reversed stairs, and side entry', () => {
  const map = raisedCorridor();
  assert.deepEqual(validateMap(map), []);
  const cliff = structuredClone(map);
  cliff.rows[1] = '_D....._';
  cliff.ramps = [];
  assert.ok(validateMap(cliff).some((issue) => issue.message.includes('연결되어 있지')));
  for (const direction of [0, 180, 270] as const) {
    const incorrect = structuredClone(map);
    incorrect.ramps[0].direction = direction;
    assert.ok(validateMap(incorrect).some((issue) => issue.message.includes('연결되어 있지')), `direction ${direction}`);
  }
});

test('ramp edges follow all four ascent directions and reject perpendicular or diagonal passage', () => {
  const map = raisedCorridor();
  map.elevations[1][3] = -4;
  for (const [direction, dx, dy] of [[0, 0, -1], [90, 1, 0], [180, 0, 1], [270, -1, 0]] as const) {
    map.ramps[0].direction = direction;
    assert.equal(edgeHeight(map, 1, 3, dx, dy), -2);
    assert.equal(edgeHeight(map, 1, 3, -dx, -dy), -4);
    assert.equal(edgeHeight(map, 1, 3, dy, -dx), null);
    assert.equal(edgeHeight(map, 1, 3, -dy, dx), null);
  }
  assert.equal(cellElevation(map, 1, 3), -4);
  assert.equal(edgeHeight(map, 1, 2, 1, 0), 0);
  assert.equal(edgeHeight(map, 1, 3, 1, 1), null);
  assert.equal(edgeHeight(map, 0, 0, 1, 0), null);
  assert.equal(edgeHeight(map, -1, 0, 1, 0), null);
});

test('ordinary steps obey maxStepHeight and adjacent stairs may form a continuous ascent', () => {
  const stepped = raisedCorridor();
  stepped.rows[1] = '_D....._';
  stepped.ramps = [];
  for (const x of [4, 5, 6]) stepped.elevations[1][x] = 0.4;
  assert.deepEqual(validateMap(stepped), []);
  stepped.maxStepHeight = 0.39;
  assert.ok(validateMap(stepped).some((issue) => issue.message.includes('연결되어 있지')));
  const chained = raisedCorridor();
  chained.rows[1] = '_D.RR.._';
  chained.ramps.push({ x: 4, row: 1, direction: 90, rise: 2 });
  chained.elevations[1][5] = 4;
  chained.elevations[1][6] = 4;
  assert.deepEqual(validateMap(chained), []);
  chained.elevations[1][4] = 2.5;
  assert.ok(validateMap(chained).some((issue) => issue.message.includes('연결되어 있지')));
});

test('height matrices, step limits, and ramp metadata are structurally bounded', () => {
  const map = raisedCorridor();
  for (const value of [undefined, [], [[0]], Array(8).fill(Array(7).fill(0)), Array(8).fill(Array(8).fill(Infinity)),
    Array(8).fill(Array(8).fill(NaN)), Array(8).fill(Array(8).fill(100.01)), Array(8).fill(Array(8).fill(-100.01))]) {
    assert.ok(validateMap({ ...map, elevations: value }).length > 0);
    assert.throws(() => parseProjectFile({ ...project(map), map: { ...map, elevations: value } }));
  }
  for (const maxStepHeight of [undefined, NaN, 0.049, 1.001]) {
    assert.ok(validateMap({ ...map, maxStepHeight }).length > 0);
  }
  for (const ramps of [undefined, new Array(1), Array(1601).fill(map.ramps[0]),
    [{ ...map.ramps[0], x: 8 }], [{ ...map.ramps[0], row: -1 }], [{ ...map.ramps[0], x: 3.5 }],
    [{ ...map.ramps[0], direction: 45 }], [{ ...map.ramps[0], direction: '90' }],
    [{ ...map.ramps[0], rise: 0.24 }], [{ ...map.ramps[0], rise: 10.01 }], [{ ...map.ramps[0], rise: NaN }],
    [{ ...map.ramps[0], unexpected: 1 }], [map.ramps[0], map.ramps[0]]]) {
    assert.ok(validateMap({ ...map, ramps }).length > 0);
    assert.throws(() => parseProjectFile({ ...project(map), map: { ...map, ramps } }));
  }
  assert.doesNotThrow(() => parseProjectFile({ ...project(map), map: { ...map, elevations: Array(8).fill(Array(8).fill(-100)) } }));
  assert.doesNotThrow(() => parseProjectFile({ ...project(map), map: { ...map, elevations: Array(8).fill(Array(8).fill(100)) } }));
});

test('each R tile requires exactly one matching ramp entry before export', () => {
  const map = raisedCorridor();
  assert.ok(validateMap({ ...map, ramps: [] }).some((issue) => issue.message.includes('계단 방향')));
  const misplaced = { ...map, ramps: [{ ...map.ramps[0], x: 2 }] };
  assert.ok(validateMap(misplaced).some((issue) => issue.message.includes('R 타일이 없습니다')));
  assert.throws(() => buildManifest(map, [binding('floor')]), /stair/);
  // Missing metadata is an unfinished edit; saving is allowed, export is not.
  assert.doesNotThrow(() => parseProjectFile(project({ ...map, ramps: [] })));
  assert.throws(() => buildManifest({ ...map, ramps: [] }, [binding('floor'), binding('stair')]), /계단 방향/);
});

test('export preserves surface heights and fits stair Y while keeping user XZ scales', () => {
  const map = raisedCorridor();
  map.elevations = map.elevations.map((row) => row.map((height) => height - 3));
  const floor = { ...binding('floor'), offset: { x: 0, y: 0.5, z: 0 } };
  const stair = { ...binding('stair'), offset: { x: 1, y: 0.25, z: -2 }, rotationY: 17, scale: { x: 2, y: 3, z: 4 } };
  const placements = buildManifest(map, [floor, binding('door'), stair]).placements;
  assert.equal(placements.find((item) => item.id === 'floor-1-1')?.position.y, -2.5);
  assert.equal(placements.find((item) => item.id === 'floor-6-1')?.position.y, -0.5);
  assert.equal(placements.find((item) => item.id === 'floor-3-1')?.position.y, -2.5);
  const instance = placements.find((item) => item.role === 'stair')!;
  assert.deepEqual(instance.position, { x: 0, y: -2.75, z: 3 });
  assert.deepEqual(instance.rotation, { x: 0, y: 107, z: 0 });
  assert.deepEqual(instance.scale, { x: 2, y: 2, z: 4 });
  assert.equal(stair.scale.y, 3);
});

test('one measured stair prefab automatically fits different cell rises', () => {
  const map = raisedCorridor();
  map.rows[1] = '_D.RR.._';
  map.ramps.push({ x: 4, row: 1, direction: 90, rise: 3 });
  map.elevations[1][5] = 5;
  map.elevations[1][6] = 5;
  const stair: AssetBinding = { ...binding('stair'), stairNativeRise: 0.5, scale: { x: 2, y: 9, z: 4 } };
  const stairs = buildManifest(map, [binding('floor'), binding('door'), stair]).placements.filter((item) => item.role === 'stair');
  assert.deepEqual(stairs.map((item) => item.scale), [{ x: 2, y: 4, z: 4 }, { x: 2, y: 6, z: 4 }]);
  assert.deepEqual(stairs.map((item) => item.position.y), [0, 2]);
  assert.equal(stair.scale.y, 9);
});

test('stair source rise is stair-only, bounded, preserved in projects, and defaults for older bindings', () => {
  const input = { ...project(raisedCorridor()), bindings: [binding('floor'), binding('door'), { ...binding('stair'), stairNativeRise: 1.5 }] };
  const parsed = parseProjectFile(input);
  assert.equal(parsed.bindings.find(item => item.role === 'stair')!.stairNativeRise, 1.5);
  assert.equal(parseProjectFile({ ...input, bindings: [binding('stair')] }).bindings[0].stairNativeRise, 1);
  for (const stairNativeRise of [0, -1, NaN, Infinity, 1000.01, '1']) {
    assert.throws(() => parseProjectFile({ ...input, bindings: [{ ...binding('stair'), stairNativeRise }] }), /stairNativeRise/);
  }
  assert.throws(() => parseProjectFile({ ...input, bindings: [{ ...binding('floor'), stairNativeRise: 1 }] }), /stair 역할/);
  assert.doesNotThrow(() => parseProjectFile({ ...input, bindings: [{ ...binding('stair'), stairNativeRise: 1000 }] }));
});

test('auto-fitted final stair scale stays within Unity export transform bounds', () => {
  const map = raisedCorridor();
  for (const stairNativeRise of [1e-8, 1e-320]) {
    assert.throws(() => buildManifest(map, [binding('floor'), binding('door'), { ...binding('stair'), stairNativeRise }]), /최종 scale/);
  }
  const largest = buildManifest(map, [binding('floor'), binding('door'), { ...binding('stair'), stairNativeRise: 0.000002 }]);
  assert.equal(largest.placements.find((item) => item.role === 'stair')?.scale.y, 1_000_000);
  const smallest = buildManifest(map, [binding('floor'), binding('door'), { ...binding('stair'), stairNativeRise: 1000 }]);
  assert.equal(smallest.placements.find((item) => item.role === 'stair')?.scale.y, 0.002);
});

test('manifest requires every used role and rejects an invalid map', () => {
  const map = createDemoMap();
  for (const missing of roles) {
    assert.throws(() => buildManifest(map, roles.filter((role) => role !== missing).map(binding)), new RegExp(missing));
  }
  assert.doesNotThrow(() => buildManifest(corridor(), ['floor', 'door'].map((role) => binding(role as AssetRole))));
  assert.throws(() => buildManifest({ ...map, cellSize: NaN }, roles.map(binding)), /cellSize/);
});

test('manifest places floors underneath . D P R and creates no spawn/exit markers', () => {
  const map = createDemoMap();
  const manifest = buildManifest(map, roles.map(binding));
  const count = (glyph: string): number => map.rows.join('').split(glyph).length - 1;
  assert.equal(manifest.placements.filter((item) => item.role === 'floor').length, [...'.DPR'].reduce((sum, tile) => sum + count(tile), 0));
  for (const [role, glyph] of [['wall', '#'], ['door', 'D'], ['prop', 'P'], ['stair', 'R']] as const) {
    assert.equal(manifest.placements.filter((item) => item.role === role).length, count(glyph));
  }
  for (const role of ['spawn', 'exit']) {
    const marker = manifest.placements.filter((item) => item.role === role);
    assert.equal(marker.length, 0);
  }
  assert.equal(new Set(manifest.placements.map((item) => item.id)).size, manifest.placements.length);
});

test('door orientation follows its passage and offsets stay in world axes', () => {
  const door = binding('door');
  door.rotationY = 15;
  door.offset = { x: 3, y: 4, z: 5 };
  door.scale = { x: 0.5, y: 2, z: 3 };
  const horizontal = buildManifest(corridor(), [binding('floor'), door]);
  const placed = horizontal.placements.find((item) => item.id === 'door-3-1')!;
  assert.deepEqual(placed.rotation, { x: 0, y: 105, z: 0 });
  assert.deepEqual(placed.position, { x: 2, y: 4, z: 10 });
  assert.deepEqual(placed.scale, { x: 0.5, y: 2, z: 3 });
  const vertical = smallMap(['_D______', '_.______', '_D______', '_.______', '_.______', '________', '________', '________']);
  assert.equal(doorRotation(vertical, 2, 1), 0);
});

test('bindings reject malformed GUIDs, duplicated IDs, and nonfinite transforms', () => {
  const floor = binding('floor');
  const door = binding('door');
  for (const malformed of [
    { ...floor, prefabGuid: 'bad-guid' },
    { ...floor, scale: { x: Infinity, y: 1, z: 1 } },
    { ...floor, offset: { x: 0, y: NaN, z: 0 } },
    { ...floor, rotationY: Infinity },
    { ...floor, prefabPath: '' },
  ]) {
    assert.throws(() => buildManifest(corridor(), [malformed, door]));
  }
  assert.throws(() => buildManifest(corridor(), [floor, floor, door]), /중복/);
  assert.throws(() => buildManifest(corridor(), [{ ...floor, role: 'spawn' } as unknown as AssetBinding, door]), /role/);
});

test('export and project parsing enforce bounded transforms and strictly positive Unity float scales', () => {
  for (const malformed of [
    { ...binding('floor'), scale: { x: 0, y: 1, z: 1 } },
    { ...binding('floor'), scale: { x: 1, y: -1, z: 1 } },
    { ...binding('floor'), scale: { x: 1, y: 1, z: Number.MIN_VALUE } },
    { ...binding('floor'), scale: { x: 1_000_001, y: 1, z: 1 } },
    { ...binding('floor'), offset: { x: -1_000_001, y: 0, z: 0 } },
    { ...binding('floor'), rotationY: 1_000_001 },
  ]) {
    const bindings = [malformed, binding('door')];
    assert.throws(() => buildManifest(corridor(), bindings));
    assert.throws(() => parseProjectFile({ ...project(), bindings }));
  }
  const floor: AssetBinding = {
    ...binding('floor'), scale: { x: 1_000_000, y: Math.fround(2 ** -149), z: 1 },
    offset: { x: 0, y: -1_000_000, z: 0 }, rotationY: 1_000_000,
  };
  assert.doesNotThrow(() => buildManifest(corridor(), [floor, binding('door')]));
  assert.doesNotThrow(() => parseProjectFile({ ...project(), bindings: [floor] }));
});

test('export checks world offsets and door rotation after combining them with grid placement', () => {
  const floor = { ...binding('floor'), offset: { x: -1_000_000, y: 0, z: 0 } };
  const door = { ...binding('door'), rotationY: 1_000_000 };
  assert.throws(() => buildManifest(corridor(), [floor, binding('door')]), /최종 배치/);
  assert.throws(() => buildManifest(corridor(), [binding('floor'), door]), /최종 배치/);
  assert.doesNotThrow(() => buildManifest(corridor(), [binding('floor'), { ...door, rotationY: 999_730 }]));
});

test('project parsing permits unfinished markers, disconnected edits, and missing bindings', () => {
  const map = corridor();
  map.rows[1] = '_..P..__';
  const input = project(map);
  assert.ok(validateMap(input.map).length > 0);
  assert.deepEqual(parseProjectFile(input), input);
  assert.equal(parseProjectFile({ ...input, map: { ...map, name: '' } }).map.name, '');
});

test('legacy projects migrate to independent v2 zero heights and default height settings', () => {
  const current = corridor();
  const legacyMap = { version: 1, name: current.name, width: 8, height: 8, cellSize: 2, rows: [...current.rows] };
  const { elevationStep: _elevationStep, maxStepHeight: _maxStepHeight, ...legacySettings } = DEFAULT_SETTINGS;
  const input = { formatVersion: 1, map: legacyMap, settings: legacySettings, bindings: [] };
  const parsed = parseProjectFile(input);
  assert.equal(parsed.formatVersion, 1);
  assert.equal(parsed.map.version, 3);
  assert.deepEqual(parsed.map.elevations, Array.from({ length: 8 }, () => Array(8).fill(0)));
  assert.deepEqual(parsed.map.ramps, []);
  assert.equal(parsed.map.maxStepHeight, 0.4);
  assert.equal(parsed.settings.elevationStep, 2);
  assert.equal(parsed.settings.maxStepHeight, 0.4);
  assert.ok(validateMap(parsed.map).some(issue => issue.message.includes('연결문')));
  assert.deepEqual(parseProjectFile(parsed), parsed);
  parsed.map.rows[0] = 'changed';
  assert.equal(legacyMap.rows[0], '________');
  assert.throws(() => parseProjectFile({ ...input, map: { ...legacyMap, unexpected: 1 } }));
  assert.throws(() => parseProjectFile({ ...input, map: { ...legacyMap, width: 1_000_000 } }));
  assert.throws(() => parseProjectFile({ ...input, map: { ...legacyMap, rows: raisedCorridor().rows } }));
  assert.throws(() => parseProjectFile({ ...input, map: current }), /settings/);
});

test('API-era v2 settings migrate to the Codex runtime default without losing map or blueprint data', () => {
  const { codexModel: _codexModel, ...settings } = DEFAULT_SETTINGS;
  const input = {
    ...project(raisedCorridor()), blueprintDataUrl: PNG,
    settings: { ...settings, imageModel: 'gpt-image-1.5', layoutModel: 'gpt-4.1' },
    bindings: [{ ...binding('stair'), stairNativeRise: 1.5 }],
  };
  const parsed = parseProjectFile(input);
  assert.deepEqual(parsed.map, input.map);
  assert.equal(parsed.blueprintDataUrl, PNG);
  assert.equal(parsed.bindings[0].stairNativeRise, 1.5);
  assert.equal(parsed.settings.codexModel, '');
  assert.equal('imageModel' in parsed.settings, false);
  assert.equal('layoutModel' in parsed.settings, false);
  assert.deepEqual(parseProjectFile(JSON.parse(JSON.stringify(parsed))), parsed);
  assert.equal(JSON.stringify(parsed).includes('gpt-image-1.5'), false);
  assert.equal(JSON.stringify(parsed).includes('gpt-4.1'), false);
  assert.equal(input.settings.imageModel, 'gpt-image-1.5');
});

test('API-era v1 maps migrate both flat geometry and model settings in a single load', () => {
  const { codexModel: _codexModel, elevationStep: _elevationStep, maxStepHeight: _maxStepHeight, ...settings } = DEFAULT_SETTINGS;
  const flat = corridor();
  const input = {
    formatVersion: 1,
    map: { version: 1, name: flat.name, width: flat.width, height: flat.height, cellSize: flat.cellSize, rows: flat.rows },
    settings: { ...settings, imageModel: 'legacy-image', layoutModel: 'legacy-layout' },
    bindings: [],
  };
  const parsed = parseProjectFile(input);
  assert.equal(parsed.map.version, 3);
  assert.deepEqual(parsed.map.elevations, flat.elevations);
  assert.deepEqual(parsed.map.ramps, []);
  assert.equal(parsed.settings.codexModel, '');
  assert.equal(parsed.settings.elevationStep, 2);
  assert.equal(parsed.settings.maxStepHeight, 0.4);
});

test('Codex model settings accept runtime default or an explicit ID and reject ambiguous legacy mixtures', () => {
  for (const codexModel of ['', 'codex-test-model', 'a'.repeat(100)]) {
    const parsed = parseProjectFile({ ...project(), settings: { ...DEFAULT_SETTINGS, codexModel } });
    assert.equal(parsed.settings.codexModel, codexModel);
  }
  const { codexModel: _codexModel, ...settings } = DEFAULT_SETTINGS;
  for (const invalid of [
    settings,
    { ...settings, imageModel: 'legacy-image' },
    { ...settings, layoutModel: 'legacy-layout' },
    { ...settings, imageModel: '', layoutModel: 'legacy-layout' },
    { ...settings, imageModel: 'legacy-image', layoutModel: 'bad model' },
    { ...settings, codexModel: '', imageModel: 'legacy-image', layoutModel: 'legacy-layout' },
    { ...settings, codexModel: undefined, imageModel: 'legacy-image', layoutModel: 'legacy-layout' },
    { ...settings, imageModel: 'legacy-image', layoutModel: 'legacy-layout', apiKey: 'must-not-persist' },
  ]) assert.throws(() => parseProjectFile({ ...project(), settings: invalid }));
});

test('project parsing returns independent nested objects and normalizes GUID casing', () => {
  const input = project();
  input.bindings = [{ ...binding('floor'), prefabGuid: 'ABCDEF0123456789ABCDEF0123456789' }];
  input.blueprintDataUrl = PNG;
  const parsed = parseProjectFile(input);
  assert.equal(parsed.bindings[0].prefabGuid, 'abcdef0123456789abcdef0123456789');
  parsed.map.rows[0] = 'changed';
  parsed.bindings[0].offset.x = 100;
  parsed.settings.width = 40;
  parsed.map.elevations[13][13] = 10;
  parsed.map.ramps[0].rise = 5;
  assert.equal(input.map.rows[0], '________________');
  assert.equal(input.bindings[0].offset.x, 0);
  assert.equal(input.settings.width, 16);
  assert.equal(input.map.elevations[13][13], 2);
  assert.equal(input.map.ramps[0].rise, 2);
  assert.equal(parsed.blueprintDataUrl, input.blueprintDataUrl);
});

test('project parsing rejects broken structures, bad settings, and external or active image URLs', () => {
  const input = project();
  for (const value of [null, [], {}, { ...input, formatVersion: 2 },
    { ...input, map: { ...input.map, rows: ['_'] } },
    { ...input, settings: { ...input.settings, width: 3 } },
    { ...input, settings: { ...input.settings, codexModel: null } },
    { ...input, settings: { ...input.settings, prompt: null } },
    { ...input, settings: { ...input.settings, prompt: ' ' } },
    { ...input, settings: { ...input.settings, prompt: 'a'.repeat(6001) } },
    { ...input, settings: { ...input.settings, codexModel: 'codex model' } },
    { ...input, settings: { ...input.settings, codexModel: 'g'.repeat(101) } },
    { ...input, settings: { ...input.settings, elevationStep: 0.2 } },
    { ...input, settings: { ...input.settings, elevationStep: 11 } },
    { ...input, settings: { ...input.settings, maxStepHeight: 0 } },
    { ...input, bindings: 'bad' },
    { ...input, bindings: new Array(1) },
    { ...input, bindings: [binding('floor'), binding('floor')] },
    { ...input, blueprintDataUrl: 'https://example.com/image.png' },
    { ...input, blueprintDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' },
    { ...input, blueprintDataUrl: PNG.replace('image/png', 'image/jpeg') },
    { ...input, blueprintDataUrl: PNG.replace('image/png', 'image/webp') },
    { ...input, blueprintDataUrl: 'data:image/png;base64,aGVsbG8=' },
    { ...input, blueprintDataUrl: PNG.slice(0, -1) },
    { ...input, unexpected: true }]) {
    assert.throws(() => parseProjectFile(value));
  }
});

test('project parsing accepts settings limits and validates the PNG header and dimensions', () => {
  assert.doesNotThrow(() => parseProjectFile({
    ...project(), settings: { ...DEFAULT_SETTINGS, prompt: 'a'.repeat(6000), codexModel: 'g'.repeat(100) },
  }));
  const bytes = Buffer.from(PNG.split(',')[1], 'base64');
  for (const [offset, value] of [[0, 0], [12, 0], [16, 8193], [16, 0], [20, 0], [20, 8193]]) {
    const bad = Buffer.from(bytes);
    if (offset >= 16) bad.writeUInt32BE(value, offset);
    else bad[offset] = value;
    assert.throws(() => parseProjectFile({ ...project(), blueprintDataUrl: `data:image/png;base64,${bad.toString('base64')}` }), /PNG/);
  }
});

test('v3 schema has strict connection/override entries and new maps never contain S/E', () => {
  for (const array of [MAP_JSON_SCHEMA.properties.connections, MAP_JSON_SCHEMA.properties.assetOverrides]) {
    assert.equal(array.items.additionalProperties, false);
    assert.deepEqual([...array.items.required].sort(), Object.keys(array.items.properties).sort());
  }
  assert.equal(MAP_JSON_SCHEMA.properties.assetOverrides.maxItems, 0);
  assert.equal(new RegExp(MAP_JSON_SCHEMA.properties.rows.items.pattern).test('S.E'), false);
  assert.equal(createDemoMap().connections.length, 4);
  assert.equal(DEFAULT_SETTINGS.connectionCount, 4);
  for (const glyph of ['S','E']) {
    const map = corridor(); map.rows[1] = `_D.${glyph}..__`; assert.ok(mapError(map,'허용되지 않는 문자'));
  }
});

test('ports require exterior-facing D cells and a reachable inward edge at the cell elevation', () => {
  const missing = { ...corridor(), connections: [] };
  assert.ok(mapError(missing,'1개 이상'));
  assert.doesNotThrow(() => parseProjectFile(project(missing)), 'unfinished modules can still be saved');
  assert.throws(() => buildManifest(missing, roles.map(role => binding(role))), /연결문/);
  const floor = corridor(); floor.rows[1] = '_..D..__'; assert.ok(mapError(floor,'D 타일'));
  const inward = corridor(); inward.connections[0].direction = 90; assert.ok(mapError(inward,'바깥쪽'));
  const prop = corridor(); prop.rows[1] = '_DPD..__'; assert.ok(mapError(prop,'안쪽'));
  const cliff = corridor(); cliff.elevations[1][1] = 2; assert.ok(mapError(cliff,'안쪽'));
  const step = corridor(); step.elevations[1][1] = 0.4; assert.deepEqual(validateMap(step),[]);
});

test('outside flood fill accepts boundary ports but rejects an enclosed courtyard opening', () => {
  const boundary = corridor(); boundary.rows[1] = 'D.....__'; boundary.connections[0].x = 0;
  assert.deepEqual(validateMap(boundary),[]);
  const hole = corridor();
  hole.rows = ['########','#......#','#..#...#','#.D_#..#','#..#...#','#......#','#......#','########'];
  hole.connections[0] = { ...hole.connections[0], x:2, row:3, direction:90 };
  assert.ok(mapError(hole,'내부 구멍'));
});

test('connection fields, duplicate IDs and duplicate doorway coordinates are rejected structurally', () => {
  const map = corridor();
  for (const invalid of [{id:''},{id:'with space'},{id:'x'.repeat(81)},{label:''},{label:'x'.repeat(81)},{label:'bad\nlabel'},
    {kind:'../path'},{kind:'x'.repeat(41)},{width:0.249},{width:2.01},{height:0.249},{height:20.01},{height:Infinity},
    {x:8},{row:-1},{direction:45},{unexpected:true}]) {
    const changed = { ...map, connections:[{...map.connections[0],...invalid}] };
    assert.ok(validateMap(changed).length,JSON.stringify(invalid));
    assert.throws(() => parseProjectFile({...project(),map:changed}));
  }
  for (const size of [0.25,20]) assert.doesNotThrow(() => parseProjectFile(project({...map,connections:[{...map.connections[0],height:size}]})));
  assert.ok(mapError({...map,connections:[map.connections[0],{...map.connections[0],x:5}]},'ID'));
  assert.ok(mapError({...map,connections:[map.connections[0],{...map.connections[0],id:'other'}]},'좌표'));
});

test('manual modules permit 17 and up to 1600 ports while AI settings remain capped at 16', () => {
  const map = corridor();
  map.connections = Array.from({length:17},(_,index)=>({...map.connections[0],id:`port-${index}`,x:index%8,row:Math.floor(index/8)}));
  assert.equal(parseProjectFile(project(map)).map.connections.length,17);
  assert.throws(()=>parseProjectFile({...project(map),settings:{...DEFAULT_SETTINGS,connectionCount:17}}),/settings/);
  const large: GridMap = { ...map,width:40,height:40,rows:Array(40).fill('.'.repeat(40)),elevations:Array.from({length:40},()=>Array(40).fill(0)),
    connections:Array.from({length:1600},(_,index)=>({...map.connections[0],id:`port-${index}`,x:index%40,row:Math.floor(index/40)})) };
  assert.equal(parseProjectFile(project(large)).map.connections.length,1600);
  assert.throws(()=>parseProjectFile(project({...large,connections:[...large.connections,large.connections[0]]})),/1,600/);
});

test('all four connection poses use the outward edge and ignore prefab offsets and rotation corrections', () => {
  const map = createDemoMap(), door = {...binding('door'),offset:{x:7,y:8,z:9},rotationY:13};
  const manifest = buildManifest(map,roles.map(role=>role==='door'?door:binding(role)));
  assert.equal(manifest.schemaVersion,3);
  assert.deepEqual(manifest.connections.map(item=>item.rotation.y).sort((a,b)=>a-b),[0,90,180,270]);
  for (const c of map.connections) {
    const pose=connectionPose(map,c),exported=manifest.connections.find(item=>item.id===c.id)!;
    assert.deepEqual(exported.position,pose.position);assert.equal(exported.position.y,map.elevations[c.row][c.x]);
    const [dx,dz]=({0:[0,1],90:[1,0],180:[0,-1],270:[-1,0]} as const)[c.direction];
    assert.equal(exported.position.x,(c.x-7.5)*2+dx);assert.equal(exported.position.z,(7.5-c.row)*2+dz);
    const placed=manifest.placements.find(item=>item.id===`door-${c.x}-${c.row}`)!;
    assert.deepEqual(placed.position,{x:pose.position.x+7,y:pose.position.y+8,z:pose.position.z+9});assert.equal(placed.rotation.y,c.direction+13);
  }
});

test('connections may meet a matching stair high landing but never stair side edges', () => {
  const map=raisedCorridor();map.rows[1]='_D.RD___';map.connections=[{...map.connections[0],id:'east',x:4,direction:90}];
  assert.deepEqual(validateMap(map),[]);
  map.elevations[1][4]=1;assert.ok(mapError(map,'안쪽'));
  map.elevations[1][4]=2;map.ramps[0].direction=0;assert.ok(mapError(map,'안쪽'));
});

test('same-role assets use documented deterministic selection and explicit cell overrides', () => {
  const map=corridor(),a={...binding('floor'),id:'floor-a'},b={...binding('floor'),id:'floor-b',prefabGuid:'f'.repeat(32)};
  const bindings=[a,b,binding('door')];
  assert.equal(resolveBinding(map,bindings,1,1,'floor')?.id,b.id);assert.equal(resolveBinding(map,bindings,2,1,'floor')?.id,a.id);
  map.assetOverrides=[{x:2,row:1,role:'floor',bindingId:b.id}];assert.equal(resolveBinding(map,bindings,2,1,'floor')?.id,b.id);
  const manifest=buildManifest(map,bindings);assert.deepEqual(buildManifest(map,bindings),manifest);
  assert.equal(manifest.placements.find(item=>item.id==='floor-2-1')?.prefabGuid,b.prefabGuid);
  assert.equal(resolveBinding(map,bindings,0,0,'floor'),undefined);
});

test('overrides reject missing/deleted bindings, wrong roles, impossible cells and duplicate cell-role entries', () => {
  const map=corridor(),bindings=[binding('floor'),binding('door')];
  for(const override of [{x:1,row:1,role:'floor',bindingId:'deleted'},{x:1,row:1,role:'floor',bindingId:'door'},
    {x:0,row:0,role:'floor',bindingId:'floor'},{x:2,row:1,role:'door',bindingId:'door'}] as const){
    const changed={...map,assetOverrides:[override]};assert.throws(()=>parseProjectFile({...project(changed),bindings}));assert.throws(()=>buildManifest(changed,bindings));
  }
  const override={x:1,row:1,role:'floor' as const,bindingId:'floor'};
  assert.ok(mapError({...map,assetOverrides:[override,override]},'중복'));
  for(const role of ['floor','door'] as const)assert.doesNotThrow(()=>buildManifest({...map,assetOverrides:[{...override,role,bindingId:role}]},bindings));
});

test('multi-asset bindings permit 256 same-role entries with unique IDs but reject invalid identity fields', () => {
  assert.equal(MAX_BINDINGS,256);
  const bindings=Array.from({length:256},(_,index)=>({...binding('floor'),id:`floor-${index}`}));
  assert.equal(parseProjectFile({...project(),bindings}).bindings.length,256);
  assert.throws(()=>parseProjectFile({...project(),bindings:[...bindings,{...binding('floor'),id:'extra'}]}),/256/);
  for(const invalid of [{id:''},{id:'bad/id'},{id:'x'.repeat(81)},{label:''},{label:'x'.repeat(81)}])assert.throws(()=>parseProjectFile({...project(),bindings:[{...binding('floor'),...invalid}]}));
});

test('v1 and v2 migrations remove S/E, assign binding identities and preserve heights and ramps', () => {
  const {connections:_connections,assetOverrides:_overrides,...v2}=raisedCorridor();
  const {connectionCount:_count,...settings}=DEFAULT_SETTINGS;
  const {id:_id,label:_label,...oldBinding}=binding('stair');
  const parsed=parseProjectFile({...project(),map:{...v2,version:2,rows:['_S.R..E_',...v2.rows.slice(1)]},settings,bindings:[oldBinding]});
  assert.equal(parsed.map.rows[0],'_..R..._');assert.deepEqual(parsed.map.connections,[]);assert.deepEqual(parsed.map.assetOverrides,[]);
  assert.deepEqual(parsed.map.elevations,v2.elevations);assert.deepEqual(parsed.map.ramps,v2.ramps);assert.equal(parsed.settings.connectionCount,4);
  assert.equal(parsed.bindings[0].id,'legacy-stair-1');assert.ok(parsed.bindings[0].label);assert.ok(mapError(parsed.map,'연결문'));
  const flat=parseProjectFile({...project(),map:{version:1,name:'Legacy',width:8,height:8,cellSize:2,rows:['_S...E__',...Array(7).fill('________')]},settings,bindings:[]});
  assert.equal(flat.map.rows[0],'_.....__');assert.ok(flat.map.elevations.flat().every(value=>value===0));
});

test('persistence clones connection metadata, asset overrides and binding identities', () => {
  const input=project(corridor());input.bindings=[binding('floor')];input.map.assetOverrides=[{x:1,row:1,role:'floor',bindingId:'floor'}];
  const parsed=parseProjectFile(input);parsed.map.connections[0].label='changed';parsed.map.assetOverrides[0].x=2;parsed.bindings[0].label='changed';
  assert.notEqual(input.map.connections[0].label,'changed');assert.equal(input.map.assetOverrides[0].x,1);assert.notEqual(input.bindings[0].label,'changed');
  assert.throws(()=>parseProjectFile({...input,bindings:[]}),/bindingId/);
});
