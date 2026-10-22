import type {
  AssetBinding, AssetRole, ExportManifest, GenerationSettings, GridMap,
  MapConnection, Placement, ProjectFile, ValidationIssue, Vec3,
} from './types';
import { ASSET_ROLES, featureStructureErrors, featureValidationIssues, fixturePosition, parseGenerationSettings } from './features';
import { connectionCells, connectionAt, maximumConnectionWidth, MAX_CONNECTION_WIDTH } from './connections';
import { resolveFixtureBinding } from './light-bindings';
import { structureDataErrors, structureIssues, synchronizeStructures, FLOOR_THICKNESS_RATIO, resolvedStructureFill, resolvedCliffFace } from './structures';
import { parsePropDefinition, propStructureErrors, propValidationIssues, propPosition } from './props';
import { parseMapConcept } from './concepts';
import { parseLocalBounds, parseWallMountDefinition, wallMountIssues } from './wall-mounts';
import { wallBaseClosure } from './wall-geometry';
export { connectionCells, connectionAt, maximumConnectionWidth, MAX_CONNECTION_WIDTH } from './connections';

const MAP_NAME = /^(?!(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])(?:$|\.))(?![\s\u0085])(?![\s\S]*[\s\u0085.]$)[^<>:"\/\\|?*\u0000-\u001F\u007F]+$/;
const MAX_TRANSFORM = 1_000_000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const SAFE_KIND = /^[A-Za-z0-9_-]{1,40}$/;
export const MAX_BINDINGS = 256;
/** Schema 3 floor thickness before its binding's Y multiplier. Keep in sync with the Unity importer. */
export { FLOOR_THICKNESS_RATIO } from './structures';
const DIRECTIONS = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] } as const;

export const DEFAULT_SETTINGS: GenerationSettings = {
  conceptMode: 'ai',
  prompt: '',
  width: 16,
  height: 16,
  cellSize: 2,
  elevationStep: 2,
  maxStepHeight: 0.4,
  connectionCount: 4,
  connectionWidth: 2,
  connectionHeight: 3,
  codexModel: '',
};

/** Strict structured-output schema; adjacency and exact row widths are checked locally. */
export const MAP_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'name', 'width', 'height', 'cellSize', 'rows', 'elevations', 'ramps', 'maxStepHeight', 'connections', 'assetOverrides', 'bridges'],
  properties: {
    version: { type: 'integer', enum: [4] },
    name: {
      // Keep API regex constraints simple; reserved names and edge whitespace are checked locally.
      type: 'string', minLength: 1, maxLength: 80, pattern: '^[^<>:"/\\\\|?*\\u0000-\\u001F\\u007F]+$',
      description: 'A valid file name of 1–80 characters: no leading/trailing whitespace, trailing period, control characters, <>:"/\\|?*, or Windows device names such as CON and NUL.',
    },
    width: { type: 'integer', minimum: 8, maximum: 40 },
    height: { type: 'integer', minimum: 8, maximum: 40 },
    cellSize: { type: 'number', minimum: 0.25, maximum: 10 },
    maxStepHeight: { type: 'number', minimum: 0.05, maximum: 1 },
    rows: {
      type: 'array', minItems: 8, maxItems: 40,
      items: { type: 'string', pattern: '^[_.#DPRB]+$' },
      description: 'Exactly height rows of width characters. _ void, . floor, # wall, D door, P blocking prop, R stair, B straight bridge. Row 0 is north (+Z). No player spawn or exit markers. All . D R B cells must connect through cardinal neighbors with matching edge heights. P is not walkable.',
    },
    elevations: {
      type: 'array', minItems: 8, maxItems: 40,
      items: { type: 'array', minItems: 8, maxItems: 40, items: { type: 'number', minimum: -100, maximum: 100 } },
      description: 'Exactly height arrays of width numbers. Height in meters for every cell. An R cell height is the low base of the stair.',
    },
    ramps: {
      type: 'array', maxItems: 1600,
      items: {
        type: 'object', additionalProperties: false, required: ['x', 'row', 'direction', 'rise'],
        properties: {
          x: { type: 'integer', minimum: 0, maximum: 39 },
          row: { type: 'integer', minimum: 0, maximum: 39 },
          direction: { type: 'integer', enum: [0, 90, 180, 270] },
          rise: { type: 'number', minimum: 0.25, maximum: 10 },
        },
      },
      description: 'Exactly one entry per R cell. direction is ascent: 0 north/row-1, 90 east/x+1, 180 south/row+1, 270 west/x-1. Opposite low edge is base; high edge is base+rise. Side edges are impassable. Neighbor edge heights must differ by no more than maxStepHeight.',
    },
    connections: {
      type: 'array', minItems: 1, maxItems: 1600,
      items: { type: 'object', additionalProperties: false, required: ['id', 'label', 'x', 'row', 'direction', 'width', 'height', 'kind'], properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$' }, label: { type: 'string', minLength: 1, maxLength: 80 },
        x: { type: 'integer', minimum: 0, maximum: 39 }, row: { type: 'integer', minimum: 0, maximum: 39 },
        direction: { type: 'integer', enum: [0, 90, 180, 270] }, width: { type: 'number', minimum: 0.25, maximum: 40 },
        height: { type: 'number', minimum: 0.25, maximum: 20 }, kind: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,40}$' },
      } },
      description: 'Exactly the requested number of external connection doors. width .25..40m may span multiple D cells: span=ceil(width/cellSize). x,row is the first cell; directions 0/180 extend +X, 90/270 extend +row. All covered D cells have identical height, outward exterior void and inward matching traversable land. Footprints cannot overlap or extend outside the grid. No external corridors.',
    },
    assetOverrides: {
      type: 'array', maxItems: 0,
      items: { type: 'object', additionalProperties: false, required: ['x', 'row', 'role', 'bindingId'], properties: {
        x: { type: 'integer', minimum: 0, maximum: 39 }, row: { type: 'integer', minimum: 0, maximum: 39 },
        role: { type: 'string', enum: ['floor', 'wall', 'door', 'prop', 'stair'] }, bindingId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$' },
      } }, description: 'Always an empty array. Asset assignments are edited locally after generation.',
    },
    bridges: {
      type: 'array', maxItems: 1600,
      items: { type: 'object', additionalProperties: false, required: ['x', 'row', 'direction'], properties: {
        x: { type: 'integer', minimum: 0, maximum: 39 }, row: { type: 'integer', minimum: 0, maximum: 39 },
        direction: { type: 'integer', enum: [0,90,180,270] },
      } },
      description: 'Exactly one entry per B cell. Straight one-cell-wide bridge: two axial neighbors are bridges or walkable land; both perpendicular neighbors are void. No floor beneath B. Entire span is level and connects valid land at both ends.',
    },
  },
} as const;

const LEGACY_MAP_KEYS = ['version', 'name', 'width', 'height', 'cellSize', 'rows'];
const V2_MAP_KEYS = [...LEGACY_MAP_KEYS, 'elevations', 'ramps', 'maxStepHeight'];
const MAP_KEYS = [...V2_MAP_KEYS, 'connections', 'assetOverrides', 'ceilings', 'wallHeights', 'bridges', 'cliffs', 'fixtures', 'markers', 'lockedCells', 'zones', 'headroom','structureSettings','pitBottoms','structureFills','propInstances'];
const ROLES = ASSET_ROLES;
const WALKABLE = new Set(['.', 'D', 'R', 'B']);
const HAS_FLOOR = new Set(['.', 'D', 'P', 'R']);
const GUID = /^[a-fA-F0-9]{32}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isDimension(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 8 && value <= 40;
}

function isCellSize(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0.25 && value <= 10;
}

function isStepHeight(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0.05 && value <= 1;
}

function extraKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function isLabel(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 80 && !/[\u0000-\u001F\u007F]/.test(value);
}

function cellCoordinate(value: unknown, size: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0 && isDimension(size) && value < size;
}

export function mapStructureErrors(input: unknown): string[] {
  if (!isRecord(input)) return ['map은 객체여야 합니다.'];
  const errors: string[] = [];
  if (extraKeys(input, MAP_KEYS).length) errors.push('map에 지원하지 않는 속성이 있습니다.');
  if (![3,4,5].includes(input.version as number)) errors.push('map.version은 3, 4 또는 5이어야 합니다.');
  if(input.version!==5){
    if(['structureSettings','pitBottoms','structureFills','propInstances'].some(k=>input[k]!==undefined))errors.push('구조 보완과 측정된 소품 데이터는 map.version 5에서만 지원합니다.');
    if(['ceilings','wallHeights'].some(k=>Array.isArray(input[k])&&(input[k] as unknown[]).some(c=>isRecord(c)&&c.heightMode!==undefined)))errors.push('자동·수동 높이 모드는 map.version 5에서만 지원합니다.');
  }
  if (typeof input.name !== 'string') errors.push('map.name은 문자열이어야 합니다.');
  if (!isDimension(input.width)) errors.push('map.width는 8~40 사이의 정수여야 합니다.');
  if (!isDimension(input.height)) errors.push('map.height는 8~40 사이의 정수여야 합니다.');
  if (!isCellSize(input.cellSize)) errors.push('map.cellSize는 0.25~10 사이의 유한한 수여야 합니다.');
  if (!isStepHeight(input.maxStepHeight)) errors.push('map.maxStepHeight는 0.05~1 사이의 유한한 수여야 합니다.');
  if (!Array.isArray(input.rows)) {
    errors.push('map.rows는 문자열 배열이어야 합니다.');
    return errors;
  }
  if (input.rows.length !== input.height) errors.push('map.rows의 행 수가 height와 일치하지 않습니다.');
  // A supported map has at most 40 rows; do not traverse oversized untrusted arrays.
  if (input.rows.length > 40) {
    errors.push('map.rows는 최대 40행까지 지원합니다.');
    return errors;
  }
  for (let row = 0; row < input.rows.length; row++) {
    const cells = input.rows[row];
    if (typeof cells !== 'string') {
      errors.push(`map.rows[${row}]는 문자열이어야 합니다.`);
      continue;
    }
    if (cells.length !== input.width) errors.push(`map.rows[${row}]의 길이가 width와 일치하지 않습니다.`);
    if (!/^[_.#DPRB]*$/.test(cells)) {
      errors.push(`map.rows[${row}]에 허용되지 않는 문자가 있습니다. 허용 문자: _ . # D P R B`);
    }
  }
  if (!Array.isArray(input.elevations) || input.elevations.length !== input.height || input.elevations.length > 40) {
    errors.push('map.elevations는 height개의 행으로 구성된 높이 배열이어야 합니다.');
  } else {
    for (let row = 0; row < input.elevations.length; row++) {
      const elevations = input.elevations[row];
      if (!Array.isArray(elevations) || elevations.length !== input.width || elevations.length > 40) {
        errors.push(`map.elevations[${row}]는 width개의 높이로 구성되어야 합니다.`);
        continue;
      }
      for (let x = 0; x < elevations.length; x++) {
        if (!isFiniteNumber(elevations[x]) || Math.abs(elevations[x]) > 100) {
          errors.push(`map.elevations[${row}][${x}]는 -100~100m 사이의 유한한 수여야 합니다.`);
        }
      }
    }
  }
  if (!Array.isArray(input.ramps) || input.ramps.length > 1600) {
    errors.push('map.ramps는 최대 1,600개의 계단 정보 배열이어야 합니다.');
  } else {
    const positions = new Set<string>();
    for (let index = 0; index < input.ramps.length; index++) {
      const ramp: unknown = input.ramps[index];
      if (!isRecord(ramp) || extraKeys(ramp, ['x', 'row', 'direction', 'rise', 'kind']).length
        || (ramp.kind !== undefined && ramp.kind !== 'stair' && ramp.kind !== 'slope')
        || !isFiniteNumber(ramp.x) || !Number.isInteger(ramp.x) || ramp.x < 0 || !isDimension(input.width) || ramp.x >= input.width
        || !isFiniteNumber(ramp.row) || !Number.isInteger(ramp.row) || ramp.row < 0 || !isDimension(input.height) || ramp.row >= input.height
        || ![0, 90, 180, 270].includes(ramp.direction as number) || !isCellSize(ramp.rise)) {
        errors.push(`map.ramps[${index}]는 맵 내부 정수 x,row, 방향 0/90/180/270, 상승 높이 0.25~10m가 필요합니다.`);
        continue;
      }
      const key = `${ramp.x},${ramp.row}`;
      if (positions.has(key)) errors.push(`map.ramps의 계단 좌표가 중복되었습니다: ${key}`);
      positions.add(key);
    }
  }
  if (!Array.isArray(input.connections) || input.connections.length > 1600) errors.push('map.connections는 최대 1,600개의 연결문 배열이어야 합니다.');
  else {
    const ids = new Set<string>();
    const positions = new Set<string>();
    for (const connection of input.connections) {
      if (!isRecord(connection) || extraKeys(connection, ['id', 'label', 'x', 'row', 'direction', 'width', 'height', 'kind']).length
        || typeof connection.id !== 'string' || !SAFE_ID.test(connection.id) || !isLabel(connection.label)
        || !cellCoordinate(connection.x, input.width) || !cellCoordinate(connection.row, input.height)
        || ![0, 90, 180, 270].includes(connection.direction as number)
        || !isFiniteNumber(connection.width) || connection.width < 0.25 || connection.width > MAX_CONNECTION_WIDTH
        || !isFiniteNumber(connection.height) || connection.height < 0.25 || connection.height > 20
        || typeof connection.kind !== 'string' || !SAFE_KIND.test(connection.kind)) {
        errors.push('연결문에는 올바른 id, label, 좌표, 외향 방향, 0.25~40m 폭, 0.25~20m 높이, kind가 필요합니다.');
        continue;
      }
      const coordinate = `${connection.x},${connection.row}`;
      if (ids.has(connection.id)) errors.push(`연결문 ID가 중복되었습니다: ${connection.id}`);
      if (positions.has(coordinate)) errors.push(`연결문 좌표가 중복되었습니다: ${coordinate}`);
      ids.add(connection.id); positions.add(coordinate);
    }
  }
  if (!Array.isArray(input.assetOverrides) || input.assetOverrides.length > 3200) errors.push('map.assetOverrides는 최대 3,200개의 셀 에셋 지정 배열이어야 합니다.');
  else {
    const positions = new Set<string>();
    for (const override of input.assetOverrides) {
      if (!isRecord(override) || extraKeys(override, ['x', 'row', 'role', 'bindingId']).length
        || !cellCoordinate(override.x, input.width) || !cellCoordinate(override.row, input.height)
        || !ROLES.includes(override.role as AssetRole) || typeof override.bindingId !== 'string' || !SAFE_ID.test(override.bindingId)) {
        errors.push('셀 에셋 지정에는 맵 내부 좌표, 올바른 role, bindingId가 필요합니다.'); continue;
      }
      const key = `${override.x},${override.row},${override.role}`;
      if (positions.has(key)) errors.push(`셀 에셋 지정이 중복되었습니다: ${key}`);
      positions.add(key);
    }
  }
  errors.push(...featureStructureErrors(input));
  errors.push(...structureDataErrors(input),...propStructureErrors(input));
  return errors;
}

/** Cell base height, before binding offsets. */
export function cellElevation(map: GridMap, row: number, column: number): number {
  return map.elevations[row]?.[column] ?? 0;
}

/** Cardinal edge height; ramp sides and nonwalkable cells have no traversable edge. */
export function edgeHeight(map: GridMap, row: number, column: number, dx: number, dy: number): number | null {
  if (!((Math.abs(dx) === 1 && dy === 0) || (Math.abs(dy) === 1 && dx === 0))) return null;
  const tile = map.rows[row]?.[column] ?? '_';
  if (!WALKABLE.has(tile)) return null;
  const base = cellElevation(map, row, column);
  if (tile === 'B') {
    const bridge = map.bridges?.find(item => item.x === column && item.row === row);
    if (!bridge) return null;
    const [axisX,axisY] = DIRECTIONS[bridge.direction];
    return (dx === axisX && dy === axisY) || (dx === -axisX && dy === -axisY) ? base : null;
  }
  if (tile !== 'R') return base;
  const ramp = map.ramps.find((item) => item.x === column && item.row === row);
  if (!ramp) return null;
  const [ascentX, ascentY] = ({ 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] } as const)[ramp.direction];
  if (dx === ascentX && dy === ascentY) return base + ramp.rise;
  if (dx === -ascentX && dy === -ascentY) return base;
  return null;
}

/** Roles actually instantiated by a tile, including supporting floors. */
export function cellHasRole(map: GridMap, x: number, row: number, role: AssetRole): boolean {
  const tile = map.rows[row]?.[x];
  if(map.structureFills?.some(f=>f.x===x&&f.row===row&&f.role===role)||map.pitBottoms?.some(p=>p.x===x&&p.row===row&&p.kind===role))return true;
  if(role === 'floor') return HAS_FLOOR.has(tile);
  if(role === 'stair' || role === 'slope') return tile === 'R' && (map.ramps.find(r=>r.x===x&&r.row===row)?.kind ?? 'stair') === role;
  if(role === 'ceiling') return !!map.ceilings?.some(c=>c.x===x&&c.row===row);
  if(role === 'cliff') return !!map.cliffs?.some(c=>c.x===x&&c.row===row);
  if(role === 'bridge') return tile === 'B';
  if(role === 'door') { const connection=connectionAt(map,x,row); return tile === 'D' && (!connection || connection.x === x && connection.row === row); }
  const symbol=({ wall: '#', door: 'D', prop: 'P' } as Partial<Record<AssetRole,string>>)[role];
  return symbol!==undefined && symbol === tile;
}

/** Flood only boundary-connected void: enclosed courtyards cannot become exterior ports. */
function outsideVoid(map: GridMap): Set<number> {
  const outside = new Set<number>();
  const queue: number[] = [];
  const add = (x: number, row: number) => {
    const key = row * map.width + x;
    if (x < 0 || row < 0 || x >= map.width || row >= map.height || map.rows[row][x] !== '_' || outside.has(key)) return;
    outside.add(key); queue.push(key);
  };
  for (let x = 0; x < map.width; x++) { add(x, 0); add(x, map.height - 1); }
  for (let row = 0; row < map.height; row++) { add(0, row); add(map.width - 1, row); }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const x = queue[cursor] % map.width, row = Math.floor(queue[cursor] / map.width);
    for (const [dx, dy] of Object.values(DIRECTIONS)) add(x + dx, row + dy);
  }
  return outside;
}

/** Validate grid topology and placements; an available catalog calibrates physical support and collision checks. */
export function validateMap(input: unknown, bindings?: AssetBinding[]): ValidationIssue[] {
  const issues: ValidationIssue[] = mapStructureErrors(input).map((message) => ({ severity: 'error', message }));
  if (issues.length) return issues;
  const map = input as GridMap;
  if (map.name.length > 80 || !MAP_NAME.test(map.name)) {
    issues.push({ severity: 'error', message: '맵 이름은 유효한 파일명 1~80자여야 합니다. 양끝 공백, 끝의 마침표, 예약 이름(CON 등), 제어 문자, <>:"/\\|?*는 사용할 수 없습니다.' });
  }

  const ramps = new Map(map.ramps.map((ramp) => [`${ramp.x},${ramp.row}`, ramp]));
  for (const ramp of map.ramps) {
    if (map.rows[ramp.row][ramp.x] !== 'R') {
      issues.push({ severity: 'error', message: `계단 정보(${ramp.x}, ${ramp.row})에 해당하는 R 타일이 없습니다.` });
    }
  }
  const walkable = new Set<number>();
  for (let row = 0; row < map.height; row++) {
    for (let column = 0; column < map.width; column++) {
      const tile = map.rows[row][column];
      if (tile === 'R' && !ramps.has(`${column},${row}`)) {
        issues.push({ severity: 'error', message: `R 타일(${column}, ${row})에 계단 방향과 상승 높이 정보가 필요합니다.` });
      }
      if (WALKABLE.has(tile)) walkable.add(row * map.width + column);
    }
  }
  if (!walkable.size) issues.push({ severity: 'error', message: '통행 가능한 타일이 하나 이상 필요합니다.' });
  if (!map.connections.length) issues.push({ severity: 'error', message: '외부 모듈과 연결할 연결문을 1개 이상 지정해 주세요.' });
  const exterior = outsideVoid(map);
  const covered = new Set<string>();
  for (const connection of map.connections) {
    const [dx, dy] = DIRECTIONS[connection.direction];
    const height = cellElevation(map, connection.row, connection.x);
    for (const cell of connectionCells(map, connection)) {
    if (cell.x >= map.width || cell.row >= map.height) { issues.push({ severity: 'error', message: `연결문 ${connection.id}의 폭이 맵 경계를 벗어납니다.` }); continue; }
    const key = `${cell.x},${cell.row}`;
    if (covered.has(key)) issues.push({ severity: 'error', message: `연결문 ${connection.id}의 개구부가 다른 연결문과 겹칩니다.` });
    covered.add(key);
    const outsideX = cell.x + dx, outsideRow = cell.row + dy;
    const outOfBounds = outsideX < 0 || outsideX >= map.width || outsideRow < 0 || outsideRow >= map.height;
    if (map.rows[cell.row][cell.x] !== 'D') issues.push({ severity: 'error', message: `연결문 ${connection.id}의 전체 개구부(${cell.x}, ${cell.row})는 D 타일이어야 합니다.` });
    if (Math.abs(cellElevation(map, cell.row, cell.x) - height) > 1e-8) issues.push({ severity: 'error', message: `연결문 ${connection.id}의 전체 개구부 높이가 같아야 합니다.` });
    if (!outOfBounds && !exterior.has(outsideRow * map.width + outsideX)) {
      issues.push({ severity: 'error', message: `연결문 ${connection.id}의 바깥쪽은 맵 외부로 이어진 빈 공간이어야 합니다. 내부 구멍이나 복도에는 연결할 수 없습니다.` });
    }
    const inward = edgeHeight(map, cell.row - dy, cell.x - dx, dx, dy);
    if (inward === null || Math.abs(inward - height) > map.maxStepHeight + 1e-8) {
      issues.push({ severity: 'error', message: `연결문 ${connection.id}의 안쪽에 같은 높이로 이동 가능한 바닥 또는 계단 끝이 필요합니다.` });
    }
    const ceiling = map.ceilings?.find(item => item.x === cell.x && item.row === cell.row);
    if (ceiling && ceiling.undersideY - height + 1e-8 < connection.height) issues.push({ severity: 'error', message: `연결문 ${connection.id}의 천장(${cell.x}, ${cell.row})이 문 높이보다 낮습니다.` });
    }
  }
  for (const override of map.assetOverrides) if (!cellHasRole(map, override.x, override.row, override.role)) {
    issues.push({ severity: 'error', message: `셀(${override.x}, ${override.row})에 ${override.role} 역할을 지정할 수 없습니다.` });
  }

  const first = walkable.values().next().value;
  if (first !== undefined) {
    const visited = new Set<number>([first]);
    const queue: number[] = [first];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const id = queue[cursor];
      const row = Math.floor(id / map.width);
      const column = id % map.width;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const x = column + dx;
        const y = row + dy;
        if (x < 0 || x >= map.width || y < 0 || y >= map.height) continue;
        const neighbor = y * map.width + x;
        if (walkable.has(neighbor) && !visited.has(neighbor)) {
          const fromHeight = edgeHeight(map, row, column, dx, dy);
          const toHeight = edgeHeight(map, y, x, -dx, -dy);
          if (fromHeight === null || toHeight === null || Math.abs(fromHeight - toHeight) > map.maxStepHeight + 1e-8) continue;
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    if (visited.size !== walkable.size) {
      issues.push({ severity: 'error', message: '통행 가능한 타일(. D R B)이 높이를 고려했을 때 연결되어 있지 않습니다. 단차는 maxStepHeight 이하여야 하며 계단과 다리는 양 끝으로만 통과할 수 있습니다. P는 장애물입니다.' });
    }
  }
  issues.push(...featureValidationIssues(map));
  issues.push(...structureIssues(map),...propValidationIssues(map,bindings),...wallMountIssues(map,bindings));
  return issues;
}

export function createDemoMap(): GridMap {
  return {
    version: 3,
    name: '백호 던전 샘플',
    width: 16,
    height: 16,
    cellSize: 2,
    maxStepHeight: 0.4,
    assetOverrides: [],
    connections: [
      { id: 'north', label: '북쪽 연결문', x: 4, row: 1, direction: 0, width: 2, height: 3, kind: 'door' },
      { id: 'west', label: '서쪽 연결문', x: 1, row: 9, direction: 270, width: 2, height: 3, kind: 'door' },
      { id: 'east', label: '동쪽 연결문', x: 14, row: 12, direction: 90, width: 2, height: 3, kind: 'door' },
      { id: 'south', label: '남쪽 연결문', x: 11, row: 14, direction: 180, width: 2, height: 3, kind: 'door' },
    ],
    elevations: Array.from({ length: 16 }, (_, row) => Array.from({ length: 16 }, (_, x) => {
      const stairBase = (row === 10 && x === 11) || (row === 13 && x === 8);
      return row >= 10 && row <= 14 && x >= 8 && x <= 14 && !stairBase ? 2 : 0;
    })),
    ramps: [{ x: 11, row: 10, direction: 180, rise: 2 }, { x: 8, row: 13, direction: 90, rise: 2 }],
    rows: [
      '________________',
      '_###D##########_',
      '_#.....#......#_',
      '_#.....#..P...#_',
      '_#..P..D......#_',
      '_#.....#......#_',
      '_#.....#......#_',
      '_###D#####D####_',
      '_#............#_',
      '_D..P.........#_',
      '_#......###R###_',
      '_#......#.....#_',
      '_#......#..P..D_',
      '_#......R.....#_',
      '_##########D###_',
      '________________',
    ],
  };
}

function isTransformNumber(value: unknown): value is number {
  return isFiniteNumber(value) && Math.abs(value) <= MAX_TRANSFORM;
}

function parseVector(input: unknown, field: string, positive = false): Vec3 {
  if (!isRecord(input) || extraKeys(input, ['x', 'y', 'z']).length
    || !isTransformNumber(input.x) || !isTransformNumber(input.y) || !isTransformNumber(input.z)) {
    throw new Error(`${field}는 ±1,000,000 이내의 유한한 x, y, z 값으로 구성되어야 합니다.`);
  }
  // Unity serializes float32 transforms: a positive JS number must not underflow to zero.
  if (positive && [input.x, input.y, input.z].some((value) => Math.fround(value) <= 0)) {
    throw new Error(`${field}의 모든 축은 Unity에서도 표현 가능한 0보다 큰 크기여야 합니다.`);
  }
  return { x: input.x, y: input.y, z: input.z };
}

export function parseBindings(input: unknown, legacy = false): AssetBinding[] {
  if (!Array.isArray(input) || input.length > MAX_BINDINGS) throw new Error('bindings는 최대 256개의 프리팹 배열이어야 합니다.');
  const usedIds = new Set<string>();
  return Array.from(input, (item: unknown, index: number) => {
    const field = `bindings[${index}]`;
    if (!isRecord(item) || extraKeys(item, ['id', 'label', 'role', 'prefabGuid', 'prefabPath', 'scale', 'offset', 'rotationY', 'stairNativeRise', 'lightAnchor','prop','bounds','wallMount']).length) {
      throw new Error(`${field}의 구조가 올바르지 않습니다.`);
    }
    if (typeof item.role !== 'string' || !ROLES.includes(item.role as AssetRole)) throw new Error(`${field}.role이 올바르지 않습니다.`);
    const id = legacy && item.id === undefined ? `legacy-${item.role}-${index + 1}` : item.id;
    const label = legacy && item.label === undefined ? `${item.role} ${index + 1}` : item.label;
    if (typeof id !== 'string' || !SAFE_ID.test(id) || !isLabel(label)) throw new Error(`${field}에 올바른 id(영숫자_- 1~80자)와 label(1~80자)이 필요합니다.`);
    if (usedIds.has(id)) throw new Error(`${field}.id가 중복되었습니다: ${id}`);
    usedIds.add(id);
    if (typeof item.prefabGuid !== 'string' || !GUID.test(item.prefabGuid)) throw new Error(`${field}.prefabGuid는 32자리 16진수 GUID여야 합니다.`);
    if (typeof item.prefabPath !== 'string' || !item.prefabPath.trim()) throw new Error(`${field}.prefabPath가 필요합니다.`);
    if (!isTransformNumber(item.rotationY)) throw new Error(`${field}.rotationY는 ±1,000,000 이내의 유한한 수여야 합니다.`);
    if (item.role !== 'stair' && item.role !== 'slope' && Object.prototype.hasOwnProperty.call(item, 'stairNativeRise')) {
      throw new Error(`${field}.stairNativeRise는 stair 역할에만 사용할 수 있습니다.`);
    }
    const stairNativeRise = item.stairNativeRise === undefined ? 1 : item.stairNativeRise;
    if ((item.role === 'stair' || item.role === 'slope') && (!isFiniteNumber(stairNativeRise) || stairNativeRise <= 0 || stairNativeRise > 1000)) {
      throw new Error(`${field}.stairNativeRise는 0보다 크고 1,000m 이하인 유한한 수여야 합니다.`);
    }
    if (Object.prototype.hasOwnProperty.call(item, 'lightAnchor') && (item.role !== 'light' || !['ceiling', 'wall'].includes(item.lightAnchor as string)))
      throw new Error(`${field}.lightAnchor는 light 역할의 ceiling 또는 wall이어야 합니다.`);
    const binding: AssetBinding = {
      id, label,
      role: item.role as AssetRole,
      prefabGuid: item.prefabGuid.toLowerCase(),
      prefabPath: item.prefabPath,
      scale: parseVector(item.scale, `${field}.scale`, true),
      offset: parseVector(item.offset, `${field}.offset`),
      rotationY: item.rotationY,
    };
    if (item.role === 'stair' || item.role === 'slope') binding.stairNativeRise = stairNativeRise as number;
    if (item.lightAnchor !== undefined) binding.lightAnchor = item.lightAnchor as 'ceiling' | 'wall';
    if(item.prop!==undefined){if(!['prop','decoration','vegetation'].includes(binding.role))throw new Error('소품 정보는 소품·장식·식생 에셋에만 지정할 수 있습니다.');binding.prop=parsePropDefinition(item.prop);}
    if(item.bounds!==undefined)binding.bounds=parseLocalBounds(item.bounds);
    if(item.wallMount!==undefined){
      if(!ASSET_ROLES.includes(binding.role)||['floor','wall','door','prop','stair','slope','bridge','ceiling','cliff','deadzone'].includes(binding.role))throw new Error('벽 부착 설정은 조명·장식·시설 에셋에만 지정할 수 있습니다.');
      binding.wallMount=parseWallMountDefinition(item.wallMount);
    }
    return binding;
  });
}

function validateOverrideBindings(map: GridMap, bindings: AssetBinding[]): void {
  for(const prop of map.propInstances??[])if(!bindings.some(b=>b.id===prop.bindingId&&['prop','decoration','vegetation'].includes(b.role)))throw new Error(`소품 ${prop.id}의 프리팹 연결을 찾을 수 없습니다.`);
  for (const fixture of map.fixtures ?? []) if (fixture.bindingId && !resolveFixtureBinding(map, bindings, fixture))
    throw new Error(`시설 ${fixture.id}의 지정 프리팹이 역할 또는 조명 부착 기준과 일치하지 않습니다.`);
  for (const override of map.assetOverrides) {
    const binding = bindings.find(item => item.id === override.bindingId);
    if (!binding) throw new Error(`셀 에셋 지정이 삭제되었거나 없는 bindingId를 참조합니다: ${override.bindingId}`);
    if (binding.role !== override.role || !cellHasRole(map, override.x, override.row, override.role)) {
      throw new Error(`셀 에셋 지정 ${override.bindingId}의 역할이 해당 타일과 일치하지 않습니다.`);
    }
  }
}

/** Explicit cell-role override wins; otherwise row-major cell index modulo role candidate count. */
export function resolveBinding(map: GridMap, bindings: AssetBinding[], x: number, row: number, role: AssetRole): AssetBinding | undefined {
  if (!cellHasRole(map, x, row, role)) return undefined;
  const override = map.assetOverrides.find(item => item.x === x && item.row === row && item.role === role);
  if (override) return bindings.find(binding => binding.id === override.bindingId && binding.role === role);
  const candidates = bindings.filter(binding => binding.role === role);
  return candidates[(row * map.width + x) % candidates.length];
}

/** Module-local port pose at the OUTWARD cell edge, independent of asset offsets. */
export function connectionPose(map: GridMap, connection: MapConnection): { position: Vec3; rotation: Vec3 } {
  const [dx, dy] = DIRECTIONS[connection.direction];
  const cells = connectionCells(map, connection), last = cells[cells.length - 1];
  const x = (connection.x + last.x) / 2, row = (connection.row + last.row) / 2;
  return {
    position: { x: (x - (map.width - 1) / 2 + dx / 2) * map.cellSize,
      y: cellElevation(map, connection.row, connection.x), z: ((map.height - 1) / 2 - row - dy / 2) * map.cellSize },
    rotation: { x: 0, y: connection.direction, z: 0 },
  };
}

/** Add an opening atomically, including every cell covered by its requested width. */
export function addMapConnection(map: GridMap, connection: MapConnection, bindings?: AssetBinding[]): GridMap {
  const candidate = { ...map, connections: [...map.connections, { ...connection }] };
  const errors = mapStructureErrors(candidate);
  if (errors.length) throw new Error(errors.slice(0, 3).join(' '));
  const cells = new Set(connectionCells(map, connection).map(cell => `${cell.x},${cell.row}`));
  if (map.fixtures?.some(cell => cells.has(`${cell.x},${cell.row}`)) || map.markers?.some(cell => cells.has(`${cell.x},${cell.row}`)))
    throw new Error('연결문 개구부의 배치물·게임 지점을 먼저 옮기거나 제거하세요.');
  return updateConnectionGeometry(candidate, connection.id, {}, bindings);
}

/** Resize/reorient one opening atomically; the returned map contains its complete D-cell footprint. */
export function updateConnectionGeometry(map: GridMap, id: string,
  change: Partial<Pick<MapConnection, 'width' | 'height' | 'direction'>>, bindings?: AssetBinding[]): GridMap {
  const original = map.connections.find(item => item.id === id);
  if (!original) throw new Error('크기를 바꿀 연결문을 찾지 못했습니다.');
  const next = { ...original, ...change };
  if (![0, 90, 180, 270].includes(next.direction) || !Number.isFinite(next.width) || next.width < .25 ||
    next.width > maximumConnectionWidth(map, next) || !Number.isFinite(next.height) || next.height < .25 || next.height > 20)
    throw new Error('연결문 폭은 0.25~40m 및 맵 범위 이내, 높이는 0.25~20m, 방향은 90도 단위여야 합니다.');
  const before = connectionCells(map, original), after = connectionCells(map, next);
  const key = (cell: { x: number; row: number }) => `${cell.x},${cell.row}`;
  const oldKeys = new Set(before.map(key)), newKeys = new Set(after.map(key));
  const affected = new Set([...oldKeys, ...newKeys]);
  if (map.lockedCells?.some(cell => affected.has(key(cell)))) throw new Error('연결문 개구부에 잠긴 셀이 있습니다. 먼저 잠금을 해제하세요.');
  for (const other of map.connections) if (other.id !== id && connectionCells(map, other).some(cell => newKeys.has(key(cell))))
    throw new Error('넓어진 연결문이 다른 연결문과 겹칩니다.');
  const changed = new Set([...oldKeys].filter(cell => !newKeys.has(cell)).concat([...newKeys].filter(cell => !oldKeys.has(cell))));
  if (map.fixtures?.some(cell => changed.has(key(cell))) || map.markers?.some(cell => oldKeys.has(key(cell)) && !newKeys.has(key(cell))))
    throw new Error('크기가 바뀌는 개구부의 배치물·게임 지점을 먼저 옮기거나 제거하세요.');
  const baseY = cellElevation(map, original.row, original.x);
  for (const cell of after) {
    if (!'#.D'.includes(map.rows[cell.row]?.[cell.x] ?? '_')) throw new Error('연결문은 이어진 벽·바닥·문 셀로만 넓힐 수 있습니다.');
    if (Math.abs(cellElevation(map, cell.row, cell.x) - baseY) > 1e-8) throw new Error('연결문 전체 개구부의 바닥 높이를 먼저 같게 맞춰 주세요.');
  }
  const result = structuredClone(map), rows = result.rows.map(row => [...row]);
  result.connections = result.connections.map(item => item.id === id ? next : item);
  const released = before.filter(cell => !newKeys.has(key(cell)));
  for (const cell of released) rows[cell.row][cell.x] = '#';
  for (const cell of after) rows[cell.row][cell.x] = 'D';
  result.rows = rows.map(row => row.join(''));
  result.wallHeights = (result.wallHeights ?? []).filter(cell => !affected.has(key(cell)));
  for (const cell of released) {
    const ceilingY = map.ceilings?.find(item => item.x === cell.x && item.row === cell.row)?.undersideY;
    const adjacentWall = Object.values(DIRECTIONS).map(([dx, dy]) => map.wallHeights?.find(wall => wall.x === cell.x + dx && wall.row === cell.row + dy)).find(Boolean);
    result.wallHeights.push({ ...cell, height: Math.max(.25, ceilingY === undefined ? adjacentWall?.height ?? original.height : ceilingY - baseY) });
  }
  const releasedKeys = new Set(released.map(key));
  result.ceilings = (result.ceilings ?? []).filter(cell => !releasedKeys.has(key(cell)));
  result.cliffs = (result.cliffs ?? []).filter(cell => !newKeys.has(key(cell)));
  result.zones = (result.zones ?? []).filter(cell => !releasedKeys.has(key(cell)));
  result.assetOverrides = result.assetOverrides.filter(item => cellHasRole(result, item.x, item.row, item.role));
  const synchronized = synchronizeStructures(result);
  const errors = validateMap(synchronized, bindings).filter(issue => issue.severity === 'error');
  if (errors.length) throw new Error(errors.slice(0, 3).map(issue => issue.message).join(' '));
  return synchronized;
}

export function doorRotation(map: GridMap, row: number, column: number): number {
  const isOpen = (r: number, c: number): number => WALKABLE.has(map.rows[r]?.[c] ?? '_') ? 1 : 0;
  const horizontal = isOpen(row, column - 1) + isOpen(row, column + 1);
  const vertical = isOpen(row - 1, column) + isOpen(row + 1, column);
  // A door's default passage is along Z; ambiguous junctions keep this orientation.
  return horizontal > vertical ? 90 : 0;
}

/** Grid centers sit on XZ, row 0 at +Z. Schema 3 Y targets a surface, including world offsets.
 * Unity aligns floor tops and object bottoms from bounds; stairs/slopes use bottom-centered source geometry.
 * Floor Y scale is a thickness multiplier; stair Y scale fits its measured source rise.
 */
export function buildManifest(map: GridMap, bindings: AssetBinding[]): ExportManifest {
  const temporaryWallCount = map.fixtures?.filter(fixture => fixture.wall?.placeholder).length ?? 0;
  if (temporaryWallCount) throw new Error(`임시 벽 부착물 ${temporaryWallCount}개가 남아 있습니다. 맵 저장은 가능하며, Unity로 내보내기 전에 실제 프리팹으로 교체하거나 제거해 주세요.`);
  const checkedBindings = parseBindings(bindings);
  const errors = validateMap(map, checkedBindings).filter((issue) => issue.severity === 'error');
  if (errors.length) throw new Error(errors.map((issue) => issue.message).join('\n'));
  const explicitPropCells=new Set((map.propInstances??[]).flatMap(p=>p.cells.map(c=>`${c.x},${c.row}`)));
  validateOverrideBindings(map, checkedBindings);
  const byRole = new Map(checkedBindings.map((binding) => [binding.role, binding]));
  const required = new Set<AssetRole>();
  for (let row=0;row<map.height;row++) {
    for (let column=0;column<map.width;column++) {
      const tile=map.rows[row][column];
      if (HAS_FLOOR.has(tile)) required.add('floor');
      if (tile === '#') required.add('wall');
      if (tile === 'D') required.add('door');
      if (tile === 'P'&&!explicitPropCells.has(`${column},${row}`)) required.add('prop');
      if (tile === 'B') required.add('bridge');
    }
  }
  for(const ramp of map.ramps) required.add(ramp.kind ?? 'stair');
  if(map.ceilings?.length) required.add('ceiling');
  if(map.cliffs?.some(cliff=>resolvedCliffFace(map,cliff,checkedBindings))) required.add('cliff');
  for(const fixture of map.fixtures??[]) required.add(fixture.role);
  for(const fill of map.structureFills??[])if(resolvedStructureFill(map,fill,checkedBindings))required.add(fill.role);
  for(const bottom of map.pitBottoms??[])required.add(bottom.kind);
  for(const instance of map.propInstances??[]){const binding=checkedBindings.find(b=>b.id===instance.bindingId);if(!binding)throw new Error(`소품 ${instance.id}의 프리팹이 없습니다.`);required.add(binding.role);}
  const missing = [...required].filter((role) => !byRole.has(role));
  if (missing.length) throw new Error(`사용한 타일에 프리팹을 연결해 주세요: ${missing.join(', ')}`);

  const placements: Placement[] = [];
  for (let row = 0; row < map.height; row++) {
    for (let column = 0; column < map.width; column++) {
      const tile = map.rows[row][column];
      const position: Vec3 = {
        x: (column - (map.width - 1) / 2) * map.cellSize,
        y: cellElevation(map, row, column),
        z: ((map.height - 1) / 2 - row) * map.cellSize,
      };
      const addPrefab = (role: AssetRole, rotation = 0, stairRise?: number, origin = position, suffix = '', fitHeight?: number): void => {
        const binding = resolveBinding(map, checkedBindings, column, row, role)!;
        const scale = { ...binding.scale };
        if ((role === 'stair' || role === 'slope') && stairRise !== undefined) {
          scale.y = stairRise / (binding.stairNativeRise ?? 1);
          parseVector(scale, 'stair의 최종 scale', true);
        }
        const placement: Placement = {
          id: `${role}-${column}-${row}${suffix}`,
          role,
          prefabGuid: binding.prefabGuid,
          position: { x: origin.x + binding.offset.x, y: origin.y + binding.offset.y, z: origin.z + binding.offset.z },
          rotation: { x: 0, y: rotation + binding.rotationY, z: 0 },
          scale,
          surface: role === 'floor' || role === 'bridge' ? 'top' : 'bottom',
          ...(fitHeight === undefined ? {} : { fitHeight }),
        };
        if (![...Object.values(placement.position), placement.rotation.y].every(isTransformNumber)) {
          throw new Error(`${role}의 최종 배치 좌표 또는 회전이 ±1,000,000 범위를 벗어났습니다.`);
        }
        placements.push(placement);
      };
      if (HAS_FLOOR.has(tile)) addPrefab('floor');
      if (tile === '#') {
        addPrefab('wall', 0, undefined, position, '', map.wallHeights?.find(w=>w.x===column&&w.row===row)?.height);
        const closure = wallBaseClosure(map, { x: column, row }, checkedBindings);
        if (closure) {
          const binding = resolveBinding(map, checkedBindings, column, row, 'wall')!;
          addPrefab('wall', 0, undefined, { ...position, y: closure.bottom - binding.offset.y }, '-base', closure.height);
        }
      }
      if (tile === 'B') addPrefab('bridge', map.bridges!.find(b=>b.x===column&&b.row===row)!.direction);
      const ceiling=map.ceilings?.find(c=>c.x===column&&c.row===row);
      if(ceiling) addPrefab('ceiling',0,undefined,{...position,y:ceiling.undersideY});
      for(const cliff of map.cliffs?.filter(c=>c.x===column&&c.row===row)??[]) {
        const geometry=resolvedCliffFace(map,cliff,checkedBindings),binding=resolveBinding(map,checkedBindings,column,row,'cliff')!;
        if(geometry)addPrefab('cliff',cliff.direction,undefined,{x:geometry.position.x-binding.offset.x,y:geometry.position.y-geometry.size.y/2-binding.offset.y,z:geometry.position.z-binding.offset.z},`-${cliff.direction}`,geometry.size.y);
      }
      if (tile === 'D') {
        const connection = connectionAt(map, column, row);
        if (!connection || (connection.x === column && connection.row === row)) {
          addPrefab('door', connection?.direction ?? doorRotation(map, row, column), undefined, connection ? connectionPose(map, connection).position : position);
          if (connection && connection.width > map.cellSize) placements[placements.length - 1].fitWidth = connection.width;
        }
      }
      if (tile === 'P'&&!explicitPropCells.has(`${column},${row}`)) addPrefab('prop');
      if (tile === 'R') {
        const ramp = map.ramps.find((item) => item.x === column && item.row === row)!;
        addPrefab(ramp.kind ?? 'stair', ramp.direction, ramp.rise);
      }
    }
  }
  const addFitted=(id:string,role:AssetRole,x:number,row:number,center:Vec3,size:Vec3,offsetResolved=false)=>{
    const binding=resolveBinding(map,checkedBindings,x,row,role)??checkedBindings.find(b=>b.role===role);
    if(!binding)throw new Error(`${role} 프리팹을 연결하세요.`);
    placements.push({id,role,prefabGuid:binding.prefabGuid,position:{x:center.x+(offsetResolved?0:binding.offset.x),y:center.y+(offsetResolved?0:binding.offset.y),z:center.z+(offsetResolved?0:binding.offset.z)},rotation:{x:0,y:0,z:0},scale:{...binding.scale},surface:'pivot',fitSize:{...size}});
  };
  for(const fill of map.structureFills??[]){const geometry=resolvedStructureFill(map,fill,checkedBindings);if(geometry)addFitted(`fill-${fill.id}`,fill.role,fill.x,fill.row,geometry.position,geometry.size,true);}
  for(const bottom of map.pitBottoms??[])addFitted(`pit-${bottom.x}-${bottom.row}`,bottom.kind,bottom.x,bottom.row,{x:(bottom.x-(map.width-1)/2)*map.cellSize,y:bottom.y-bottom.thickness/2,z:((map.height-1)/2-bottom.row)*map.cellSize},{x:map.cellSize,y:bottom.thickness,z:map.cellSize});
  for(const prop of map.propInstances??[]){
    const binding=checkedBindings.find(b=>b.id===prop.bindingId)!;
    const position=propPosition(map,prop,binding);
    placements.push({id:`prop-instance-${prop.id}`,role:binding.role,prefabGuid:binding.prefabGuid,position,rotation:{x:0,y:prop.direction+binding.rotationY,z:0},scale:{...binding.scale},surface:'bottom',centerXZ:true});
  }
  for (const fixture of map.fixtures??[]) {
    const binding=resolveFixtureBinding(map, checkedBindings, fixture);
    if(!binding)throw new Error(`시설 ${fixture.id}의 프리팹 슬롯을 연결해 주세요.`);
    if(fixture.wall){
      placements.push({id:`fixture-${fixture.id}`,role:fixture.role,prefabGuid:binding.prefabGuid,position:{...fixture.wall.position},rotation:{x:0,y:fixture.wall.rotationY,z:fixture.wall.rotationZ??0},scale:{...binding.scale},surface:'pivot',...(fixture.linkedId?{linkedId:`fixture-${fixture.linkedId}`}:{})});
      continue;
    }
    const origin=fixturePosition(map,fixture);
    const position={x:origin.x+binding.offset.x,y:origin.y+binding.offset.y,z:origin.z+binding.offset.z};
    if(![...Object.values(position),fixture.direction+binding.rotationY].every(isTransformNumber))throw new Error('시설의 최종 배치 좌표 또는 회전이 범위를 벗어났습니다.');
    placements.push({id:`fixture-${fixture.id}`,role:fixture.role,prefabGuid:binding.prefabGuid,position,rotation:{x:0,y:fixture.direction+binding.rotationY,z:0},scale:{...binding.scale},surface:'pivot',...(fixture.linkedId?{linkedId:`fixture-${fixture.linkedId}`}:{})});
  }
  if(placements.length>10000)throw new Error('Unity 내보내기는 최대 10,000개 프리팹 배치를 지원합니다. 장식이나 시설 수를 줄여 주세요.');
  return { schemaVersion: map.version===5?5:4, name: map.name, width: map.width, height: map.height, cellSize: map.cellSize, placements,
    markers:(map.markers??[]).map(m=>({id:m.id,label:m.label,kind:m.kind,contentKey:m.contentKey,position:fixturePosition(map,m),rotation:{x:0,y:m.direction,z:0}})),
    connections: map.connections.map(connection => ({ id: connection.id, label: connection.label, kind: connection.kind,
      width: connection.width, height: connection.height, ...connectionPose(map, connection) })),
  };
}

function isPngDataUrl(input: unknown): input is string {
  const prefix = 'data:image/png;base64,';
  if (typeof input !== 'string' || !input.startsWith(prefix)
    || input.length > prefix.length + Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return false;
  const encoded = input.slice(prefix.length);
  if (encoded.length < 32 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return false;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const byteLength = encoded.length / 4 * 3 - padding;
  if (byteLength < 24 || byteLength > MAX_IMAGE_BYTES) return false;
  // Inspect only the header, keeping browser parsing bounded even for a 20 MiB PNG.
  const header = Uint8Array.from(atob(encoded.slice(0, 32)), (character) => character.charCodeAt(0));
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => header[index] === byte)
    || header[12] !== 73 || header[13] !== 72 || header[14] !== 68 || header[15] !== 82) return false;
  const view = new DataView(header.buffer);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width >= 1 && height >= 1 && width <= 8192 && height <= 8192 && width * height <= 33554432;
}

function migrateLegacyMap(input: Record<string, unknown>): unknown {
  const flat = input.version === 1;
  if (extraKeys(input, flat ? LEGACY_MAP_KEYS : V2_MAP_KEYS).length) throw new Error('기존 map에 지원하지 않는 속성이 있습니다.');
  if (flat && Array.isArray(input.rows) && input.rows.some((row: unknown) => typeof row === 'string' && row.includes('R'))) {
    throw new Error('기존 v1 map에는 R 계단 타일을 사용할 수 없습니다.');
  }
  const width = isDimension(input.width) ? input.width : 0;
  const height = isDimension(input.height) ? input.height : 0;
  return {
    ...input, ...(flat ? { maxStepHeight: 0.4, ramps: [], elevations: Array.from({ length: height }, () => Array<number>(width).fill(0)) } : {}),
    version: 3, connections: [], assetOverrides: [],
    rows: Array.isArray(input.rows) ? input.rows.map(row => typeof row === 'string' ? row.replace(/[SE]/g, '.') : row) : input.rows,
  };
}

/** Load old maps into v4 without inventing features or changing legacy wall scale. */
export function parseProjectFile(input: unknown): ProjectFile {
  if (!isRecord(input) || extraKeys(input, ['formatVersion', 'map', 'settings', 'bindings', 'blueprintDataUrl', 'generationDraft', 'concept']).length) {
    throw new Error('프로젝트 파일의 구조가 올바르지 않습니다.');
  }
  if (input.formatVersion !== 1) throw new Error('지원하지 않는 프로젝트 formatVersion입니다.');
  const legacy = isRecord(input.map) && [1, 2].includes(input.map.version as number);
  const flat = isRecord(input.map) && input.map.version === 1;
  const mapInput = legacy ? migrateLegacyMap(input.map as Record<string, unknown>) : input.map;
  const mapErrors = mapStructureErrors(mapInput);
  if (mapErrors.length) throw new Error(mapErrors.join('\n'));
  let settings = input.settings;
  if (flat && isRecord(settings)) {
    settings = { ...settings, elevationStep: settings.elevationStep === undefined ? 2 : settings.elevationStep, maxStepHeight: settings.maxStepHeight === undefined ? 0.4 : settings.maxStepHeight };
  }
  if (legacy && isRecord(settings) && settings.connectionCount === undefined) settings = { ...settings, connectionCount: 4 };
  // Model migration is independent of GridMap.version: API-era projects also contain v2 height maps.
  if (isRecord(settings) && !Object.prototype.hasOwnProperty.call(settings, 'codexModel')
    && Object.prototype.hasOwnProperty.call(settings, 'imageModel') && Object.prototype.hasOwnProperty.call(settings, 'layoutModel')) {
    if (typeof settings.imageModel !== 'string' || !MODEL_ID.test(settings.imageModel)
      || typeof settings.layoutModel !== 'string' || !MODEL_ID.test(settings.layoutModel)) {
      throw new Error('기존 프로젝트 settings의 이미지·해석 모델 ID가 올바르지 않습니다.');
    }
    const { imageModel: _imageModel, layoutModel: _layoutModel, ...remainingSettings } = settings;
    settings = { ...remainingSettings, codexModel: '' };
  }
  const parsedSettings = parseGenerationSettings(settings);
  if (input.blueprintDataUrl !== undefined && !isPngDataUrl(input.blueprintDataUrl)) {
    throw new Error('blueprintDataUrl은 20MB 이하의 올바른 PNG base64 이미지여야 합니다.');
  }
  const map = mapInput as GridMap;
  const project: ProjectFile = {
    formatVersion: 1,
    map: {
      version: map.version===5?5:4, name: map.name, width: map.width, height: map.height, cellSize: map.cellSize, rows: [...map.rows],
      elevations: map.elevations.map((row) => [...row]), ramps: map.ramps.map((ramp) => ({ ...ramp })), maxStepHeight: map.maxStepHeight,
      connections: map.connections.map(connection => ({ ...connection })), assetOverrides: map.assetOverrides.map(override => ({ ...override })),
      ceilings:(map.ceilings??[]).map(c=>({...c})),wallHeights:(map.wallHeights??[]).map(w=>({...w})),bridges:(map.bridges??[]).map(b=>({...b})),cliffs:(map.cliffs??[]).map(c=>({...c})),
      fixtures:(map.fixtures??[]).map(f=>structuredClone(f)),markers:(map.markers??[]).map(m=>({...m,offset:{...m.offset}})),lockedCells:(map.lockedCells??[]).map(c=>({...c})),zones:(map.zones??[]).map(z=>({...z})),
      ...(map.headroom===undefined?{}:{headroom:map.headroom}),
      ...(map.structureSettings?{structureSettings:structuredClone(map.structureSettings)}:{}),
      ...(map.pitBottoms?{pitBottoms:structuredClone(map.pitBottoms)}:{}),
      ...(map.structureFills?{structureFills:structuredClone(map.structureFills)}:{}),
      ...(map.propInstances?{propInstances:structuredClone(map.propInstances)}:{}),
    },
    settings: parsedSettings,
    bindings: parseBindings(input.bindings, legacy),
  };
  validateOverrideBindings(project.map, project.bindings);
  if (typeof input.blueprintDataUrl === 'string') project.blueprintDataUrl = input.blueprintDataUrl;
  if (input.concept !== undefined) project.concept = parseMapConcept(input.concept);
  if (input.generationDraft!==undefined) {
    const draft=input.generationDraft;
    if(!isRecord(draft)||extraKeys(draft,['imageDataUrl','settings','region','catalog','concept','preferences']).length||!isPngDataUrl(draft.imageDataUrl))throw new Error('generationDraft에 올바른 PNG와 설정이 필요합니다.');
    project.generationDraft={imageDataUrl:draft.imageDataUrl,settings:parseGenerationSettings(draft.settings)};
    if(draft.concept!==undefined)project.generationDraft.concept=parseMapConcept(draft.concept);
    if(draft.preferences!==undefined)project.generationDraft.preferences=parseGenerationSettings(draft.preferences);
    if(draft.catalog!==undefined)project.generationDraft.catalog=parseBindings(draft.catalog);
    if(draft.region!==undefined){const r=draft.region,s=project.generationDraft.settings;
      if(!isRecord(r)||extraKeys(r,['x','row','width','height']).length||![r.x,r.row,r.width,r.height].every(n=>isFiniteNumber(n)&&Number.isInteger(n))||Number(r.x)<0||Number(r.row)<0||Number(r.width)<1||Number(r.height)<1||Number(r.x)+Number(r.width)>s.width||Number(r.row)+Number(r.height)>s.height)throw new Error('generationDraft.region은 생성 맵 내부 영역이어야 합니다.');
      project.generationDraft.region={x:Number(r.x),row:Number(r.row),width:Number(r.width),height:Number(r.height)};
    }
  }
  return project;
}
