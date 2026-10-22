import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultCreation } from '../shared/graphics-creation';
import type { GraphicsObject } from '../shared/graphics';
import { lastGraphicsObject, readGraphicsView, saveGraphicsView, type GraphicsViewState } from '../src/graphics-view-state';

const object: GraphicsObject = {
  id: 'object-a', name: 'Saved original', kind: 'prop', createdAt: '2026-10-15',
  selectedTasks: [], instruction: 'Original instruction', settings: {}, references: [], accepted: {}, creation: defaultCreation('prop'),
};
const prefix = 'partsmith.guided-workspace.v1';
function memory() {
  const values = new Map<string, string>();
  let writes = 0;
  return { values, get writes() { return writes; }, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { writes++; values.set(key, value); } };
}
function draft(): GraphicsViewState {
  const creation = defaultCreation('prop');
  creation.instruction = 'Unsaved rounded stone draft';
  creation.stageSettings.model = { instruction: 'Keep its silhouette', values: { modelMethod: '', faceLimit: 5000 } };
  return { schemaVersion: 1, stage: 'model', creation, shownVersionId: 'review-candidate', taskOverride: 'M01', movementExpanded: true };
}

test('draft view roundtrips without changing source, acceptance, or executing work', () => {
  const storage = memory(), before = structuredClone(object), view = draft();
  assert.equal(saveGraphicsView(storage, 'project-a', object.id, view), true);
  assert.equal(lastGraphicsObject(storage, 'project-a'), object.id);
  const writes = storage.writes;
  const restored = readGraphicsView(storage, 'project-a', object);
  assert.deepEqual(restored, view);
  assert.equal(restored?.creation.stageSettings.model?.values.modelMethod, '', 'A cleared required choice stays cleared');
  assert.equal(storage.writes, writes, 'Reading must never rewrite or repair storage');
  restored!.creation.instruction = 'Later edit';
  assert.deepEqual(object, before, 'Restored drafts must never mutate the accepted/source object');
  assert.equal(readGraphicsView(storage, 'project-a', object)?.creation.instruction, view.creation.instruction);
});

test('storage keys isolate project and object; stale last selection is only a hint', () => {
  const storage = memory();
  saveGraphicsView(storage, 'project-a', object.id, draft());
  assert.equal(readGraphicsView(storage, 'project-b', object), undefined);
  assert.equal(readGraphicsView(storage, 'project-a', { ...object, id: 'object-b' }), undefined);
  assert.equal(lastGraphicsObject(storage, 'project-b'), undefined);
  storage.values.set(`${prefix}:project-a:last-object`, 'deleted-object');
  assert.equal(lastGraphicsObject(storage, 'project-a'), 'deleted-object');
  assert.deepEqual(object.accepted, {});
});

test('missing, malformed, incompatible and invalid drafts are ignored without writes', () => {
  const storage = memory(), key = `${prefix}:project-a:${object.id}`;
  assert.equal(readGraphicsView(storage, 'project-a', object), undefined);
  for (const raw of ['{', 'null', '[]', JSON.stringify({ ...draft(), schemaVersion: 2 }),
    JSON.stringify({ ...draft(), stage: 'unknown' }), JSON.stringify({ ...draft(), shownVersionId: 42 }),
    JSON.stringify({ ...draft(), taskOverride: false }), JSON.stringify({ ...draft(), creation: defaultCreation('character') }),
    JSON.stringify({ ...draft(), creation: { ...draft().creation, locks: ['invalid-lock'] } })]) {
    storage.values.set(key, raw);
    assert.equal(readGraphicsView(storage, 'project-a', object), undefined, raw);
  }
  assert.equal(storage.writes, 0);
});

test('unavailable or full browser storage fails safely', () => {
  const blocked = { getItem: (_key: string): string | null => { throw new Error('Unavailable'); },
    setItem: (_key: string, _value: string) => { throw new Error('Full'); } };
  assert.equal(readGraphicsView(blocked, 'project-a', object), undefined);
  assert.equal(lastGraphicsObject(blocked, 'project-a'), undefined);
  assert.equal(saveGraphicsView(blocked, 'project-a', object.id, draft()), false);
});
