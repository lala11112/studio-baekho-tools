/**
 * Local, deterministic grouped-placement benchmark. Writes JSON lines only.
 * Run: npx tsx scripts/benchmark-grouped-props.ts
 * Options: --counts=1,16,256 --timeout-ms=30000 --size=1.2 --coverage=12 --seed=237
 * Each case runs in its own Node process so an exhausted search can be stopped safely.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DESIGNER } from '../src/shared/features';
import { placeGroupedProps } from '../src/shared/grouped-props';
import { analyzeLevelDesign, DEFAULT_LEVEL_DESIGN } from '../src/shared/level-design';
import { DEFAULT_SETTINGS, validateMap } from '../src/shared/map';
import { connected, getPropCoverageReport, propValidationIssues } from '../src/shared/props';
import type { AssetBinding, GenerationSettings, GridMap } from '../src/shared/types';

const option = (name: string, fallback: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const timeoutMs = Number(option('timeout-ms', '30000'));
const size = Number(option('size', '1.2'));
const coverage = Number(option('coverage', '12'));
const seed = Number(option('seed', '237'));
assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 1000, 'timeout-ms must be at least 1000');
assert.ok(Number.isFinite(size) && size > 0 && size <= 76, 'size must fit the 40 by 40 room');
assert.ok(Number.isFinite(coverage) && coverage >= 1 && coverage <= 30, 'coverage must be between 1 and 30');
assert.ok(Number.isFinite(seed), 'seed must be finite');

function benchmark(catalogSize: number) {
  const width = 40, height = 40, cellSize = 2, doorX = width / 2;
  const rows = Array.from({ length: height }, (_, row) => row === 0 || row === height - 1 ? '#'.repeat(width) : `#${'.'.repeat(width - 2)}#`);
  rows[0] = '#'.repeat(doorX) + 'D' + '#'.repeat(width - doorX - 1);
  const source: GridMap = { version: 5, name: 'Grouped benchmark', width, height, cellSize, maxStepHeight: .4, rows,
    elevations: Array.from({ length: height }, () => Array(width).fill(0)), ramps: [], assetOverrides: [],
    connections: [{ id: 'north', label: 'North', x: doorX, row: 0, direction: 0, width: 2, height: 3, kind: 'door' }] };
  const settings: GenerationSettings = { ...DEFAULT_SETTINGS, width, height, seed, connectionCount: 1,
    designer: { ...DEFAULT_DESIGNER, preset: 'battle', elevation: false, props: true, propLayout: 'grouped', propCoverage: coverage,
      decorations: false, vegetation: false }, levelDesign: { ...DEFAULT_LEVEL_DESIGN, pattern: 'openArena' } };
  const bindings: AssetBinding[] = Array.from({ length: catalogSize }, (_, index) => {
    const id = `Crate_${index.toString().padStart(3, '0')}`;
    return { id, label: id, role: 'prop', prefabGuid: (index + 1).toString(16).padStart(32, '0'), prefabPath: `Assets/${id}.prefab`,
      scale: { x: 1, y: 1, z: 1 }, rotationY: 0, offset: { x: 0, y: 0, z: 0 },
      prop: { category: id, tags: [], blocksMovement: true, size: { x: size, y: 1, z: size }, placement: 'floor', roomTypes: ['battle'], weight: 1,
        composition: { usage: 'storage', family: 'benchmark', member: 'either', arrangement: 'island' } } };
  });
  const started = performance.now(), result = placeGroupedProps(source, settings, bindings), elapsedMs = performance.now() - started;
  const validationStarted = performance.now();
  const errors = [...propValidationIssues(result.map, bindings), ...validateMap(result.map), ...analyzeLevelDesign(result.map, settings).issues]
    .filter(issue => issue.severity === 'error');
  assert.deepEqual(errors, []);
  assert.ok(connected(result.map), 'all remaining floor must stay connected');
  const groupMembers = new Map<string, NonNullable<GridMap['propInstances']>>();
  for (const prop of result.map.propInstances ?? []) {
    assert.ok(prop.groupId, 'every added prop must belong to a group');
    groupMembers.set(prop.groupId, [...(groupMembers.get(prop.groupId) ?? []), prop]);
  }
  assert.ok([...groupMembers.values()].every(group => group.length >= 2 && group.length <= 4), 'all groups must contain 2 to 4 members');
  const groupedCells = new Map<string, string>();
  for (const [groupId, group] of groupMembers) for (const prop of group) for (const cell of prop.cells) groupedCells.set(`${cell.x},${cell.row}`, groupId);
  for (const [groupId, group] of groupMembers) for (const prop of group) for (const cell of prop.cells)
    for (let dr = -1; dr <= 1; dr++) for (let dx = -1; dx <= 1; dx++) {
      const adjacentGroup = groupedCells.get(`${cell.x + dx},${cell.row + dr}`);
      assert.ok(!adjacentGroup || adjacentGroup === groupId, 'different groups must retain a one-cell gap');
    }
  const report = getPropCoverageReport(result.map, settings, bindings);
  console.log(JSON.stringify({ status: 'ok', width, height, cellSize, catalogSize, prefabSize: size, seed, targetPercent: coverage,
    elapsedMs: Math.round(elapsedMs), validationMs: Math.round(performance.now() - validationStarted),
    actualPercent: Number(report.actualPercent?.toFixed(3)), occupiedArea: Number(report.occupiedArea.toFixed(3)), floorArea: report.floorArea,
    unmet: report.unmet, groups: groupMembers.size, instances: result.map.propInstances?.length ?? 0,
    distinctBindings: new Set(result.map.propInstances?.map(prop => prop.bindingId)).size, safetyErrors: errors.length,
    issues: result.issues.map(issue => ({ code: issue.code, message: issue.message })) }));
}

const worker = process.argv.find(arg => arg.startsWith('--worker='));
if (worker) {
  const catalogSize = Number(worker.slice('--worker='.length));
  assert.ok(Number.isInteger(catalogSize) && catalogSize >= 1 && catalogSize <= 256);
  benchmark(catalogSize);
} else {
  const counts = option('counts', '1,16,256').split(',').map(Number);
  assert.ok(counts.length && counts.every(count => Number.isInteger(count) && count >= 1 && count <= 256), 'counts must be between 1 and 256');
  for (const count of counts) {
    const exitCode = await new Promise<number>(resolve => {
      const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), `--worker=${count}`, `--size=${size}`, `--coverage=${coverage}`, `--seed=${seed}`],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let timedOut = false;
      child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
      const timer = setTimeout(() => {
        timedOut = true;
        console.log(JSON.stringify({ status: 'timeout', catalogSize: count, timeoutMs, targetPercent: coverage, prefabSize: size, seed }));
        child.kill();
      }, timeoutMs);
      child.on('error', error => { clearTimeout(timer); console.error(error); resolve(1); });
      child.on('close', code => { clearTimeout(timer); resolve(timedOut ? 1 : code ?? 1); });
    });
    if (exitCode) process.exitCode = exitCode;
  }
}
