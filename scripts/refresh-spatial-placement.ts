/** Replay current local placement on fresh AI test maps without another AI request.
 * npx tsx scripts/refresh-spatial-placement.ts --input=.local/spatial-ai/run --output=.local/spatial-ai/refreshed
 * Original candidates and generation/request provenance are never overwritten.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseProjectFile, validateMap } from '../src/shared/map';
import { analyzeLevelDesign } from '../src/shared/level-design';
import { variantGeometryKey } from '../src/shared/geometry-similarity';
import { placeGroupedProps } from '../src/shared/grouped-props';
import { protectedPropIds } from '../src/shared/prop-groups';
import { placeWallMounts, wallMountIssues } from '../src/shared/wall-mounts';
import type { GridMap, ProjectFile, ValidationIssue } from '../src/shared/types';

const argument = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const inputArgument = argument('input'), outputArgument = argument('output');
assert.ok(inputArgument && outputArgument, 'Specify --input and a new --output directory.');
const input = path.resolve(inputArgument), output = path.resolve(outputArgument);
const nested = (parent: string, child: string) => { const relative = path.relative(parent, child); return !relative || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };
assert.ok(!nested(input, output) && !nested(output, input), 'Input and output must be separate, non-nested directories.');
const names = await readdir(input), candidates = names.filter(name => /^candidate-\d+\.baekho\.json$/.test(name)).sort();
assert.ok(candidates.length, 'No completed candidate files exist yet. Wait for generation before replaying placement.');

function freshGeneratedMap(project: ProjectFile): GridMap {
  const map = structuredClone(project.map);
  assert.equal(project.settings.designer?.propLayout, 'grouped', 'This evidence replay accepts fresh grouped-generation maps only.');
  assert.equal(map.lockedCells?.length ?? 0, 0, 'Fresh test maps must not contain locks.');
  assert.equal(map.assetOverrides.length, 0, 'Fresh test maps must not contain user assignments.');
  assert.equal(protectedPropIds(map).size, 0, 'A protected prop/group cannot be replayed as fresh generation.');
  assert.ok((map.propInstances ?? []).every(p => p.provenance === 'generated' && !p.authored && !p.id.startsWith('prop_manual_')), 'Manual or unknown props cannot be stripped.');
  assert.ok((map.fixtures ?? []).every(f => !f.linkedId), 'Referenced facilities require an authored-content workflow, not this fresh-map replay.');
  for (const f of map.fixtures ?? []) if (f.wall) {
    assert.ok(!f.wall.authored, `Authored wall fixture: ${f.id}`);
    const auto = f.wall.runId ? /^wm-run-[0-9a-z]+-\d+$/.test(f.wall.runId) || /^wm-vertical-[0-9a-z]+$/.test(f.wall.runId)
      : /^wm-(?:wall|upper|lower|door|corner)-/.test(f.id) && !/_copy_|-copy-/.test(f.id);
    assert.ok(auto, `Manual, copied or unknown wall fixture: ${f.id}`);
  }
  const occupied = new Set((map.propInstances ?? []).flatMap(p => p.cells.map(c => `${c.x},${c.row}`)));
  const rows = map.rows.map(row => [...row]);
  for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) if (rows[row][x] === 'P') {
    assert.ok(occupied.has(`${x},${row}`), `Unattributed P occupancy at ${x},${row}`); rows[row][x] = '.';
  }
  map.rows = rows.map(row => row.join('')); map.propInstances = []; map.fixtures = (map.fixtures ?? []).filter(f => !f.wall);
  return map;
}
function geography(map: GridMap): unknown {
  const { propInstances: _props, fixtures, rows, ...terrain } = map;
  return { ...terrain, rows: rows.map(row => row.replace(/P/g, '.')), fixtures: (fixtures ?? []).filter(f => !f.wall) };
}
function replay(project: ProjectFile): { map: GridMap; issues: ValidationIssue[] } {
  const props = placeGroupedProps(freshGeneratedMap(project), project.settings, project.bindings);
  const walls = placeWallMounts(props.map, project.settings, project.bindings);
  return { map: walls.map, issues: [...props.issues, ...walls.issues] };
}

const refreshed: { name: string; project: ProjectFile; report: unknown }[] = [];
for (const name of candidates) {
  const source = parseProjectFile(JSON.parse(await readFile(path.join(input, name), 'utf8'))), original = structuredClone(source);
  const key = variantGeometryKey(source.map), result = replay(source);
  assert.equal(variantGeometryKey(result.map), key, `${name}: structural identity changed`);
  assert.deepEqual(geography(result.map), geography(source.map), `${name}: terrain, doors or retained gameplay data changed`);
  const project = parseProjectFile({ ...source, map: result.map });
  const errors = [...validateMap(project.map, project.bindings), ...wallMountIssues(project.map, project.bindings), ...analyzeLevelDesign(project.map, project.settings).issues].filter(i => i.severity === 'error');
  assert.deepEqual(errors, [], `${name}: latest placement failed safety checks`);
  assert.deepEqual(replay(project).map, project.map, `${name}: same-seed local replay is not stable`);
  assert.deepEqual(source, original, `${name}: input mutated`);
  refreshed.push({ name, project, report: { file: name, geometrySha256: createHash('sha256').update(key).digest('hex'),
    propsBefore: source.map.propInstances?.length ?? 0, propsAfter: project.map.propInstances?.length ?? 0,
    wallModulesBefore: source.map.fixtures?.filter(f => f.wall).length ?? 0, wallModulesAfter: project.map.fixtures?.filter(f => f.wall).length ?? 0,
    safetyErrors: errors, repeatStable: true, issues: result.issues } });
}
// Preflight every map before creating an output directory. EEXIST protects previous evidence.
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output);
for (const item of refreshed) await writeFile(path.join(output, item.name), JSON.stringify(item.project, null, 2));
const provenance = names.filter(name => /^(?:results|progress)\.json$|^request-\d+\.json$|^blueprint-\d+\.png$/.test(name));
for (const name of provenance) await copyFile(path.join(input, name), path.join(output, name));
await writeFile(path.join(output, 'local-placement-refresh.json'), JSON.stringify({ source: input, output, aiRequests: 0,
  originalGenerationEvidence: provenance, note: 'Copied generation results/requests describe the original AI run; only local prop and wall placement was replayed.',
  candidates: refreshed.map(item => item.report) }, null, 2));
console.log(JSON.stringify({ input, output, aiRequests: 0, candidates: refreshed.length, stableReplay: true, safetyErrors: 0 }));
