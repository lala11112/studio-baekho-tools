'use strict';

// Shared data validation, used by both the isolated renderer and the main process.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CombatTuning = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const finite = Number.isFinite;
  const clone = value => JSON.parse(JSON.stringify(value));
  function validateKeys(keys, spec) {
    if (!Array.isArray(keys) || keys.length < 2 || keys.length > 16) throw new Error(`${spec.label || spec.id}: 곡선에는 2–16개 키가 필요합니다.`);
    let previous = -Infinity;
    for (const key of keys) {
      if (!key || !finite(key.time) || !finite(key.value) || key.time < 0 || key.time > spec.maximumTime || key.time <= previous ||
          key.value < spec.minimum || key.value > spec.maximum) throw new Error(`${spec.label || spec.id}: 키 시간은 증가해야 하며 시간·값 범위 안에 있어야 합니다.`);
      previous = key.time;
    }
    return keys;
  }
  function validValue(value, spec) {
    return finite(value) && value >= spec.minimum && value <= spec.maximum &&
      (spec.kind !== 'boolean' || value === 0 || value === 1) &&
      (spec.kind !== 'enum' || Number.isInteger(value) && value >= 0 && value < (spec.options || []).length);
  }
  function validateCandidate(candidate, parameters, curves = [], partial = false) {
    if (!candidate || !Array.isArray(candidate.values) || !partial && candidate.values.length !== parameters.length || new Set(candidate.values.map(item => item?.id)).size !== candidate.values.length) throw new Error('후보 수치 ID가 없거나 중복됐습니다.');
    if (candidate.values.some(value => !parameters.some(spec => spec.id === value?.id))) throw new Error('알 수 없는 수치 ID입니다.');
    for (const spec of partial ? parameters.filter(spec => candidate.values.some(value => value.id === spec.id)) : parameters) {
      const values = candidate.values.filter(item => item && item.id === spec.id);
      if (values.length !== 1 || !validValue(values[0].value, spec)) throw new Error(`${spec.label || spec.id}: 허용 범위 또는 값 형식이 올바르지 않습니다.`);
    }
    const curveIds = new Set();
    for (const curve of candidate.curves || []) {
      const spec = curves.find(item => item.id === curve?.id);
      if (!spec || curveIds.has(curve.id)) throw new Error('곡선 ID가 없거나 중복됐습니다.');
      curveIds.add(curve.id); validateKeys(curve.keys, spec);
    }
    return candidate;
  }
  function sourceCandidate(parameters, curves = [], id = 'manual-01') {
    return { id, label: '직접 편집 후보', rationale: '현재 원본값에서 직접 조정합니다.', origin: 'manual', revision: 1,
      values: parameters.map(spec => ({ id: spec.id, value: spec.baseline })),
      curves: [] };
  }
  function lockedValue(candidate, id) {
    const parameter = candidate.values.find(item => item.id === id);
    return parameter ? parameter.value : candidate.curves?.find(item => item.id === id)?.keys;
  }
  function owningMode(id, targetId) {
    const channel = /^(.*\.(?:impact|shake|hitstop))\./.exec(id)?.[1];
    return id.includes('.camera.motion.') ? `${targetId}.camera.mode` : channel ? `${channel}.mode` : '';
  }
  function channelContains(modeId, id) {
    const prefix = modeId.slice(0, -'.mode'.length);
    return id === modeId || (prefix.endsWith('.camera') ? id.startsWith(prefix + '.motion.') : id.startsWith(prefix + '.'));
  }
  function activePatch(patch) {
    const preserved = (patch.values || []).filter(item => item.id.endsWith('.mode') && item.value === 0).map(item => item.id);
    const active = item => !preserved.some(modeId => channelContains(modeId, item.id));
    return { ...patch, values: (patch.values || []).filter(active), curves: (patch.curves || []).filter(active) };
  }
  function effectiveValues(patch, parameters, curves = []) {
    patch = activePatch(patch);
    const values = new Map(parameters.map(spec => [spec.id, spec.baseline]));
    const explicit = new Set((patch.values || []).map(item => item.id));
    const specs = new Map([...parameters, ...curves].map(spec => [spec.id, spec]));
    for (const item of [...(patch.values || []), ...(patch.curves || [])]) {
      const spec = specs.get(item.id);
      const mode = spec && !item.id.endsWith('.mode') ? owningMode(item.id, spec.targetId) : '';
      if (mode && values.has(mode) && !explicit.has(mode)) values.set(mode, 2);
    }
    for (const item of patch.values || []) values.set(item.id, item.value);
    for (const curve of patch.curves || []) if (curve.id.endsWith('.camera.motion.fovOffset')) {
      const flag = curve.id.slice(0, -'fovOffset'.length) + 'useFeelZoom';
      if (values.has(flag)) values.set(flag, 0);
    }
    return parameters.map(spec => ({ id: spec.id, value: values.get(spec.id) }));
  }
  function assertLocks(candidate, reference, lockedIds) {
    for (const id of lockedIds || []) {
      const value = lockedValue(candidate, id);
      const expected = lockedValue(reference, id);
      if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error(`잠근 항목 ${id}가 변경됐습니다.`);
    }
  }
  function sampleAt(frames, time) {
    let found = -1;
    for (let index = 0; index < frames.length; index++) {
      const value = frames[index].relativeSeconds ?? frames[index].captureElapsedUs / 1000000;
      if (value > time) break;
      found = index;
    }
    return found;
  }
  return { validateKeys, validValue, validateCandidate, sourceCandidate, assertLocks, sampleAt, owningMode, effectiveValues, channelContains, activePatch };
});
