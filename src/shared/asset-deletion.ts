import { ASSET_ROLES, FIXTURE_ROLES } from './features';
import { resolveFixtureBinding } from './light-bindings';
import { cellHasRole, parseProjectFile, resolveBinding } from './map';
import { removePropInstance } from './props';
import { markPropGroupAuthored } from './prop-groups';
import { wallMountDependencies } from './wall-mounts';
import type { Cell, ProjectFile } from './types';

export interface AssetDeletionResult {
  project: ProjectFile;
  removedBindings: number;
  removedPropInstances: number;
  clearedOverrides: number;
  clearedFixtureBindings: number;
  removedWallFixtures?: number;
}

const key = (cell: Cell) => `${cell.x},${cell.row}`;
const tileRoles = ASSET_ROLES.filter(role => !FIXTURE_ROLES.some(fixtureRole => fixtureRole === role));
const lockedMessage = '잠긴 셀의 에셋이나 소품 배치가 바뀝니다. 해당 셀의 잠금을 해제한 후 삭제해 주세요.';

/** Removes registrations and their explicit references in one detached, validated transaction. */
export function removeAssetBindings(source: ProjectFile, ids: readonly string[]): AssetDeletionResult {
  const requested = new Set(ids), removed = new Set(source.bindings.filter(binding => requested.has(binding.id)).map(binding => binding.id));
  const counts = { removedBindings: removed.size, removedPropInstances: 0, clearedOverrides: 0, clearedFixtureBindings: 0 };
  if (!removed.size) return { project: source, ...counts };

  const bindings = source.bindings.filter(binding => !removed.has(binding.id));
  const removedProps = (source.map.propInstances ?? []).filter(prop => removed.has(prop.bindingId));
  const overrides = source.map.assetOverrides.filter(override => removed.has(override.bindingId));
  const fixtures = (source.map.fixtures ?? []).filter(fixture => fixture.bindingId && removed.has(fixture.bindingId));
  const affectedRuns=new Set(fixtures.flatMap(f=>f.wall?.runId?[f.wall.runId]:[]));
  const wallFixtures=(source.map.fixtures??[]).filter(f=>f.wall&&(!!f.bindingId&&removed.has(f.bindingId)||!!f.wall.runId&&affectedRuns.has(f.wall.runId)));
  const removedFixtureIds=new Set(wallFixtures.map(f=>f.id));
  const locks = new Set((source.map.lockedCells ?? []).map(key));
  if (removedProps.some(prop => prop.cells.some(cell => locks.has(key(cell))))
    || wallFixtures.some(f=>wallMountDependencies(f).some(c=>locks.has(key(c))))
    || (source.map.fixtures??[]).some(f=>f.linkedId&&removedFixtureIds.has(f.linkedId)&&locks.has(key(f)))
    || overrides.some(cell => locks.has(key(cell))) || fixtures.some(cell => locks.has(key(cell)))) throw new Error(lockedMessage);

  // Match export: measured objects own their cells, and fixtures use their own resolver below.
  const explicitPropCells = new Set((source.map.propInstances ?? []).flatMap(prop => prop.cells.map(key)));
  for (const cell of source.map.lockedCells ?? []) for (const role of tileRoles) {
    if (role === 'prop' && explicitPropCells.has(key(cell))) continue;
    if (cellHasRole(source.map, cell.x, cell.row, role)
      && resolveBinding(source.map, source.bindings, cell.x, cell.row, role)?.id !== resolveBinding(source.map, bindings, cell.x, cell.row, role)?.id) throw new Error(lockedMessage);
  }
  for (const fixture of source.map.fixtures ?? []) if (locks.has(key(fixture))
    && resolveFixtureBinding(source.map, source.bindings, fixture)?.id !== resolveFixtureBinding(source.map, bindings, fixture)?.id) throw new Error(lockedMessage);

  const project = structuredClone(source);
  project.bindings = project.bindings.filter(binding => !removed.has(binding.id));
  project.map.assetOverrides = project.map.assetOverrides.filter(override => !removed.has(override.bindingId));
  if(wallFixtures.length)project.map.fixtures=project.map.fixtures!.filter(f=>!removedFixtureIds.has(f.id));
  for(const fixture of project.map.fixtures??[])if(fixture.linkedId&&removedFixtureIds.has(fixture.linkedId))delete fixture.linkedId;
  for (const fixture of project.map.fixtures ?? []) if (fixture.bindingId && removed.has(fixture.bindingId)) delete fixture.bindingId;
  if (project.generationDraft?.catalog) project.generationDraft.catalog = project.generationDraft.catalog.filter(binding => !removed.has(binding.id));

  if (removedProps.length) {
    for (const prop of removedProps) markPropGroupAuthored(project.map, prop.id);
    // Use the existing remover, then batch the other footprints without repeatedly cloning the map.
    project.map = removePropInstance(project.map, removedProps[0].id);
    project.map.propInstances = project.map.propInstances!.filter(prop => !removed.has(prop.bindingId));
    const retainedCells = new Set([
      ...project.map.propInstances.filter(prop => prop.blocksMovement).flatMap(prop => prop.cells),
      ...project.map.assetOverrides.filter(override => override.role === 'prop'),
    ].map(key));
    const rows = project.map.rows.map(row => [...row]);
    for (const prop of removedProps) for (const cell of prop.cells) if (source.map.rows[cell.row][cell.x] === 'P') {
      rows[cell.row][cell.x] = retainedCells.has(key(cell)) ? 'P' : '.';
    }
    project.map.rows = rows.map(row => row.join(''));
  }

  // Validate saved-project compatibility without normalizing unrelated optional fields or settings.
  parseProjectFile(project);
  return { project, removedBindings: removed.size, removedPropInstances: removedProps.length,
    clearedOverrides: overrides.length, clearedFixtureBindings: fixtures.filter(f=>!f.wall).length,
    ...(wallFixtures.length?{removedWallFixtures:wallFixtures.length}:{}) };
}
