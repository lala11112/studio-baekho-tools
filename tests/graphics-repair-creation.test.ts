import test from 'node:test';
import assert from 'node:assert/strict';
import type { GraphicsObject } from '../shared/graphics';
import { compileCreation, creationPartForTask, creationSelectionProblem, creationTaskId, defaultCreation, selectMissingSurfaceRepair, setHumanPartsCreation, stageForTask } from '../shared/graphics-creation';
import { findGraphicsTask } from '../shared/graphics-catalog';

const human = (): GraphicsObject => ({ id: 'human', name: 'Ch', kind: 'character', createdAt: '', selectedTasks: [], instruction: '', settings: {}, references: [], accepted: { 'model:main': 'original' }, creation: setHumanPartsCreation(defaultCreation('character'), 'whole-then-split') });

test('repair draft freezes the displayed unadopted part without changing original acceptance or stale mesh selection', () => {
  const object = human(), before = structuredClone(object);
  object.creation!.stageSettings.assembly!.values = { assemblyMode: 'partial', editMeshIds: '["old-body"]', editMeshNames: '["Body"]', meshSelectionVersionId: 'old-body-version' };
  const source = { id: 'head-candidate', slot: 'part-head', role: 'model' as const };
  const spec = selectMissingSurfaceRepair(object.creation!, source);
  assert.deepEqual(object.accepted, before.accepted);
  assert.equal(object.creation!.stageSettings.assembly!.values.assemblyMode, 'partial');
  assert.equal(spec.activePartId, 'head');
  assert.equal(creationTaskId(spec, 'assembly'), 'M09');
  assert.equal(stageForTask('M09'), 'assembly');
  assert.equal(creationPartForTask(spec, 'M09')?.id, 'head');
  const compiled = compileCreation({ ...object, creation: spec }, 'M09');
  assert.equal(compiled.settings.sourceVersionId, source.id);
  assert.equal(compiled.settings.meshSelectionVersionId, source.id);
  assert.equal(compiled.settings.editMeshIds, '[]');
  assert.equal(compiled.settings.editMeshNames, '[]');
  assert.equal(compiled.settings.repairMaxAddedFaces, 1500);
  assert.equal(compiled.settings.repairMaxAddedVertices, 1000);
  assert.equal(compiled.settings.partId, 'head');
  assert.equal(compiled.settings.count, 1);
  assert.match(compiled.instruction, /기존 면·정점·UV·재질을 보존/);
  assert.equal(findGraphicsTask('M09')?.executor, 'astra');
  assert.equal(findGraphicsTask('M09')?.status, 'unverified');
});

test('repair explicit mesh selection retains exact original identity and rejects unsupported source kinds', () => {
  const object = human(), source = { id: 'head-candidate', slot: 'part-head', role: 'material' as const };
  const byId = selectMissingSurfaceRepair(object.creation!, source, { sourceId: 'original-head-id', sourceName: 'Head.Mesh' });
  assert.equal(byId.stageSettings.assembly!.values.editMeshIds, '["original-head-id"]');
  assert.equal(byId.stageSettings.assembly!.values.editMeshNames, '[]');
  const byName = selectMissingSurfaceRepair(object.creation!, source, { sourceName: 'Head.Mesh' });
  assert.equal(byName.stageSettings.assembly!.values.editMeshNames, '["Head.Mesh"]');
  assert.throws(() => selectMissingSurfaceRepair(object.creation!, { ...source, role: 'rig' }), /리깅 전/);
  assert.throws(() => selectMissingSurfaceRepair(object.creation!, { ...source, slot: 'main' }), /분리된 파트/);
  assert.throws(() => selectMissingSurfaceRepair(object.creation!, { ...source, slot: 'part-unknown' }), /해당하는 파트/);
});

test('repair preparation rejects missing selection and invalid bounds while preserving editable values', () => {
  const object = human();
  object.creation!.stageSettings.assembly!.values.assemblyMode = 'repair';
  assert.match(creationSelectionProblem(object.creation!, 'assembly')!, /원본 파트/);
  assert.throws(() => compileCreation(object, 'M09'), /원본 파트/);
  object.creation = selectMissingSurfaceRepair(object.creation!, { id: 'head', slot: 'part-head', role: 'model' });
  const values = object.creation.stageSettings.assembly!.values;
  for (const invalid of ['', -1, 0, 4001, 1.5]) {
    values.repairMaxAddedFaces = invalid;
    assert.match(creationSelectionProblem(object.creation, 'assembly')!, /추가 면 상한/);
    assert.throws(() => compileCreation(object, 'M09'), /추가 면 상한/);
    assert.equal(values.repairMaxAddedFaces, invalid);
  }
  values.repairMaxAddedFaces = 4000;
  for (const invalid of ['', -1, 4001, 1.5]) {
    values.repairMaxAddedVertices = invalid;
    assert.throws(() => compileCreation(object, 'M09'), /추가 정점 상한/);
  }
  values.repairMaxAddedVertices = 0;
  assert.equal(compileCreation(object, 'M09').settings.repairMaxAddedVertices, 0);
  object.creation.activePartId = undefined;
  assert.throws(() => compileCreation(object, 'M09'), /보완할 파트/);
});
