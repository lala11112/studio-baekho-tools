const test = require('node:test');
const assert = require('node:assert/strict');
const { validateWindows, validateClip, frameChunks, refinementTimes, mergeWindows } = require('../src/domain.cjs');
const { validateResult, schema } = require('../src/ai.cjs');

test('serialized subasset IDs preserve int64 precision', () => {
  const clip = validateClip({ guid: 'a'.repeat(32), localId: '9223372036854775806', length: 1 });
  assert.equal(clip.localId, '9223372036854775806');
});
test('windows reject nonfinite, reversed, out-of-bounds and duplicate mapped hits', () => {
  for (const windows of [[{ start: NaN, end: 1 }], [{ start: 0.5, end: 0.2 }], [{ start: 0, end: 1.1 }], [{ start: 0, end: 0.2, sourceIndex: 0 }, { start: 0.5, end: 0.7, sourceIndex: 0 }]])
    assert.throws(() => validateWindows(windows, 1));
  assert.equal(validateWindows([{ start: 0, end: 0.2, sourceIndex: -1 }, { start: 0.5, end: 0.7, sourceIndex: -1 }], 1).length, 2);
});
test('coarse chunks cover every sampled frame and overlap at a boundary', () => {
  const frames = Array.from({ length: 241 }, (_, index) => ({ id: String(index), time: index / 24 }));
  const chunks = frameChunks(frames);
  assert.equal(new Set(chunks.flat().map(frame => frame.id)).size, frames.length);
  assert.ok(chunks[0].some(frame => chunks[1].some(other => other.id === frame.id)));
  assert.ok(chunks.every(chunk => chunk.length <= 49));
});
test('dense boundary timestamps remain within clip and are unique and sorted', () => {
  const times = refinementTimes([{ start: 0, end: 1 }], 1);
  assert.equal(times[0], 0); assert.equal(times.at(-1), 1);
  assert.deepEqual([...new Set(times)].sort((a, b) => a - b), times);
});
test('chunk duplicate merge keeps separate rapid strikes', () => {
  const merged = mergeWindows([{ start: .2, end: .4 }, { start: .21, end: .41 }, { start: .5, end: .55 }], 1);
  assert.equal(merged.length, 2); assert.equal(merged[0].end, .41);
});
test('AI timestamps come exclusively from supplied frame IDs', () => {
  const frames = [{ id: 'a', time: .1 }, { id: 'b', time: .4 }];
  const result = { status: 'hits', summary: '타격', windows: [{ startFrameId: 'a', endFrameId: 'b', reason: '전방 베기', uncertain: false }] };
  assert.deepEqual(validateResult(result, frames).windows[0], { start: .1, end: .4, reason: '전방 베기', uncertain: false, sourceIndex: -1 });
  assert.throws(() => validateResult({ ...result, windows: [{ ...result.windows[0], endFrameId: 'unknown' }] }, frames));
  assert.throws(() => validateResult({ ...result, status: 'no-hit' }, frames));
  assert.equal(validateResult({ status: 'uncertain', summary: '가림', windows: [] }, frames).status, 'uncertain');
  assert.deepEqual(schema(frames).properties.windows.items.properties.endFrameId.enum, ['a', 'b']);
});
