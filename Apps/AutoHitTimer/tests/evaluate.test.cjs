const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../scripts/evaluate.cjs');
test('accuracy reports missing/count mismatch separately and measures matched boundaries in milliseconds', () => {
  const a = { guid: 'a'.repeat(32), localId: '1', reviewer: 'fixture reviewer', windows: [{ start: .2, end: .4 }] };
  const b = { ...a, guid: 'b'.repeat(32) }, c = { ...a, guid: 'c'.repeat(32) };
  const predicted = [{ ...a, source: 'real-ai-unedited', windows: [{ start: .21, end: .42 }] }, { ...b, source: 'real-ai-unedited', windows: [] }];
  const result = evaluate({ clips: [a, b, c] }, { clips: predicted });
  assert.equal(result.missing, 1); assert.equal(result.hitCountMatchRate, .5);
  assert.ok(Math.abs(result.boundaryMeanAbsoluteErrorMs - 15) < 1e-6);
  assert.equal(result.rows[1].boundaryErrorsMs.length, 0);
  assert.throws(() => evaluate({ clips: [a] }, { clips: [{ ...a, source: 'mock' }] }), /Mock/);
});
