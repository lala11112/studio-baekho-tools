'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tuning = require('../renderer/tuning-contract.js');
const { validateGenerationInput, validateCandidates, createPrompt, outputSchema } = require('../src/ai-candidates.cjs');
const parameter = { id: 'step.0.camera.amplitude', label: '흔들림', targetId: 'step.0', group: 'camera', kind: 'number', minimum: 0, maximum: 10, baseline: 0.3, suggestedMinimum: 0.1, suggestedMaximum: 1, useSuggestedRange: true };
const curve = { id: 'step.0.camera.envelope', label: '감쇠', minimum: 0, maximum: 1, maximumTime: 1, timeUnit: 'progress', keys: [{ time: 0, value: 1 }, { time: 1, value: 0 }] };
function input() { return { schemaVersion: 2, goal: '반응은 빠르게', count: 2, parameters: [parameter], curves: [curve], mode: 'refine', feedback: '복귀를 빠르게', lockedIds: [] }; }
function response() { return { candidates: [0.2, 0.4].map(value => ({ label: `후보 ${value}`, rationale: '복귀와 충격을 직접 비교합니다.', values: [{ id: parameter.id, value }], curves: [{ id: curve.id, keys: curve.keys }] })) }; }
test('v2 retains absolute current values, design context, curve schema and provenance', () => {
  const spec = validateGenerationInput({ ...input(), context: { projection: 'perspective' }, knowledge: { guide: '실제 로컬 가이드' } });
  assert.equal(spec.parameters[0].baseline, 0.3); assert.equal(spec.parameters[0].suggestedMaximum, 1);
  assert.equal(spec.context.projection, 'perspective');
  assert.match(createPrompt(spec), /실제 로컬 가이드/); assert.match(createPrompt(spec), /absolute current game units/);
  assert.equal(outputSchema(spec).properties.candidates.items.properties.curves.maxItems, 1);
  const candidates = validateCandidates(response(), spec); assert.equal(candidates[1].values[0].value, 0.4);
  assert.equal(candidates[0].origin, 'ai'); assert.equal(candidates[0].revision, 1);
});
test('v2 rejects changes to locked scalars and locked curve keys', () => {
  const spec = input(); spec.referenceCandidate = tuning.sourceCandidate(spec.parameters, spec.curves); spec.lockedIds = [parameter.id];
  assert.throws(() => validateCandidates(response(), spec), { code: 'AI_INVALID_OUTPUT' });
  spec.lockedIds = [curve.id]; const value = response(); value.candidates[0].curves[0].keys = [{ time: 0, value: 0.9 }, { time: 1, value: 0 }];
  assert.throws(() => validateCandidates(value, spec), { code: 'AI_INVALID_OUTPUT' });
});
test('v2 enforces boolean/enum integers and finite linear curve keys in sorted range', () => {
  for (const [kind, options, valid, invalid] of [['boolean', [], 1, 0.5], ['enum', ['상속', '끔', '직접'], 2, 1.5]]) {
    const spec = { ...parameter, kind, options, minimum: 0, maximum: 2, baseline: 0 };
    assert.equal(tuning.validValue(valid, spec), true); assert.equal(tuning.validValue(invalid, spec), false);
  }
  for (const keys of [[], [{ time: 0, value: 1 }], [{ time: 0, value: 1 }, { time: 0, value: 0 }], [{ time: -1, value: 1 }, { time: 1, value: 0 }], [{ time: 0, value: 2 }, { time: 1, value: 0 }], Array.from({ length: 17 }, (_, i) => ({ time: i / 16, value: 0 }))]) assert.throws(() => tuning.validateKeys(keys, curve));
  assert.deepEqual(tuning.validateKeys(curve.keys, curve), curve.keys);
});
test('captured-frame sampling preserves variable gaps without synthesizing a 60 fps grid', () => {
  const frames = [0, 17000, 50000, 100000].map(captureElapsedUs => ({ captureElapsedUs }));
  assert.equal(tuning.sampleAt(frames, 0.033), 1); assert.equal(tuning.sampleAt(frames, 0.05), 2); assert.equal(tuning.sampleAt(frames, -1), -1);
});

test('v2 uses observed scale for candidate diversity and accepts large target catalogs within the byte budget', () => {
  const spec = input(); spec.parameters[0] = { ...parameter, maximum: 3.4028235e38 };
  assert.equal(validateCandidates(response(), spec).length, 2);
  const parameters = Array.from({ length: 600 }, (_, i) => ({ ...parameter, id: `step.${i}.knockback` }));
  assert.equal(validateGenerationInput({ ...input(), parameters }).parameters.length, 600);
  assert.throws(() => validateGenerationInput({ ...input(), observations: { data: 'x'.repeat(128 * 1024) } }), { code: 'AI_INVALID_INPUT' });
});

test('locked mode catches indirect activation and explicit source-preserve restores only its own channel', () => {
  const mode = { ...parameter, id: 'step.0.camera.shake.mode', kind: 'enum', options: ['유지', '끔', '직접'], minimum: 0, maximum: 2, baseline: 0 };
  const amplitude = { ...parameter, id: 'step.0.camera.shake.amplitude' };
  const spec = { ...input(), parameters: [mode, amplitude], curves: [], lockedIds: [mode.id] };
  const value = { candidates: [0.4, 0.6].map(value => ({ label: String(value), rationale: '카메라만 비교', values: [{ id: amplitude.id, value }], curves: [] })) };
  assert.throws(() => validateCandidates(value, spec), { code: 'AI_INVALID_OUTPUT' });
  const parameters = [{ ...mode, id: 'step.0.camera.mode', baseline: 2 }, { ...amplitude, id: 'step.0.camera.motion.distance', baseline: 0.3 }, mode, amplitude];
  const patch = { values: [{ id: 'step.0.camera.mode', value: 0 }, { id: 'step.0.camera.motion.distance', value: 9 }, { id: amplitude.id, value: 0.9 }], curves: [] };
  const actual = new Map(tuning.effectiveValues(patch, parameters).map(value => [value.id, value.value]));
  assert.equal(actual.get('step.0.camera.mode'), 2); assert.equal(actual.get('step.0.camera.motion.distance'), 0.3);
  assert.equal(actual.get(mode.id), 2); assert.equal(actual.get(amplitude.id), 0.9);
});

test('an edited FOV curve also respects a locked Feel zoom flag through the adapter side effect', () => {
  const flag = { ...parameter, id: 'step.0.camera.motion.useFeelZoom', kind: 'boolean', minimum: 0, maximum: 1, baseline: 1 };
  const fov = { ...curve, id: 'step.0.camera.motion.fovOffset' };
  const spec = { ...input(), parameters: [flag], curves: [fov], lockedIds: [flag.id] };
  const response = { candidates: [0.7, 0.9].map(value => ({ label: String(value), rationale: 'FOV 곡선 비교', values: [], curves: [{ id: fov.id, keys: [{ time: 0, value }, { time: 1, value: 0 }] }] })) };
  assert.throws(() => validateCandidates(response, spec), { code: 'AI_INVALID_OUTPUT' });
  assert.equal(tuning.effectiveValues(response.candidates[0], [flag], [fov])[0].value, 0);
});

test('cause restrictions and factorial require actual controlled output rather than labels alone', () => {
  const hitstop = { ...parameter, id: 'step.0.hitstop.duration', baseline: 0.05 };
  const spec = { ...input(), curves: [], parameters: [parameter, hitstop], strategy: 'camera-only' };
  const response = { candidates: [0.2, 0.4].map(value => ({ label: String(value), rationale: '비교', values: [{ id: hitstop.id, value }], curves: [] })) };
  assert.throws(() => validateCandidates(response, spec), { code: 'AI_INVALID_OUTPUT' });
  const factorial = { ...spec, mode: 'factorial', strategy: 'factorial', count: 4 };
  response.candidates = [0.2, 0.4].flatMap(a => [0.03, 0.07].map(b => ({ label: `${a}/${b}`, rationale: '두 요인의 낮음/높음', values: [{ id: parameter.id, value: a }, { id: hitstop.id, value: b }], curves: [] })));
  assert.equal(validateCandidates(response, factorial).length, 4);
  response.candidates[3].values[1].value = 0.09;
  assert.throws(() => validateCandidates(response, factorial), { code: 'AI_INVALID_OUTPUT' });
});
