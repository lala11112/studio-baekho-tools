'use strict';
const { randomUUID } = require('node:crypto');

function fault(message, code = 'INVALID_INPUT') {
  return Object.assign(new Error(message), { code });
}
function validateClip(value) {
  if (!value || !/^[a-f0-9]{32}$/i.test(value.guid || '') || !/^-?\d+$/.test(String(value.localId)) ||
      !Number.isFinite(value.length) || value.length <= 0 || value.length > 120) {
    throw fault('유효한 0~120초 애니메이션 클립을 선택하세요.');
  }
  return { ...value, localId: String(value.localId), name: String(value.name || 'Animation').slice(0, 300) };
}
function validateWindows(windows, duration, { allowEmpty = true } = {}) {
  if (!Array.isArray(windows) || windows.length > 64 || (!allowEmpty && !windows.length))
    throw fault('타격 구간을 1~64개 지정하세요.');
  const mapped = new Set();
  const ids = new Set();
  return windows.map(value => {
    if (!value || !Number.isFinite(value.start) || !Number.isFinite(value.end) || value.start < 0 ||
        value.end <= value.start || value.end > duration + 0.00001) throw fault('판정 구간은 0초 이상, 종료는 시작 이후이며 동작 길이 이내여야 합니다.');
    const sourceIndex = value.sourceIndex == null ? -1 : value.sourceIndex;
    if (!Number.isInteger(sourceIndex) || sourceIndex < -1 || sourceIndex > 1023 || (sourceIndex >= 0 && mapped.has(sourceIndex)))
      throw fault('각 기존 타격은 한 구간에만 연결할 수 있습니다.');
    if (sourceIndex >= 0) mapped.add(sourceIndex);
    let id = typeof value.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value.id) ? value.id : randomUUID();
    if (ids.has(id)) id = randomUUID();
    ids.add(id);
    return { id, start: value.start, end: Math.min(duration, value.end), sourceIndex,
      reason: String(value.reason || '').slice(0, 2000), uncertain: value.uncertain === true };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
}
function frameChunks(frames, seconds = 2, overlap = 0.25) {
  if (!frames.length) return [];
  const sorted = [...frames].sort((a, b) => a.time - b.time);
  const chunks = [];
  const last = sorted.at(-1).time;
  for (let start = 0; start <= last; start += seconds - overlap) {
    const selected = sorted.filter(frame => frame.time >= start - 1e-6 && frame.time <= start + seconds + 1e-6);
    if (selected.length) chunks.push(selected);
    if (start + seconds >= last) break;
  }
  return chunks;
}
function refinementTimes(windows, duration) {
  const ticks = new Set();
  for (const window of windows) for (const boundary of [window.start, window.end]) {
    const first = Math.max(0, Math.floor((boundary - 0.15) * 60));
    const last = Math.min(Math.floor(duration * 60), Math.ceil((boundary + 0.15) * 60));
    for (let index = first; index <= last; index++) ticks.add(index);
  }
  return [...ticks].sort((a, b) => a - b).map(index => index / 60);
}
function mergeWindows(windows, duration) {
  const merged = [];
  for (const value of [...windows].sort((a, b) => a.start - b.start)) {
    const duplicate = merged.find(other => {
      const intersection = Math.max(0, Math.min(other.end, value.end) - Math.max(other.start, value.start));
      const union = Math.max(other.end, value.end) - Math.min(other.start, value.start);
      return intersection / union >= 0.6 || (Math.abs(other.start - value.start) <= 1 / 24 && Math.abs(other.end - value.end) <= 1 / 24);
    });
    if (duplicate) {
      duplicate.start = Math.min(duplicate.start, value.start);
      duplicate.end = Math.max(duplicate.end, value.end);
      duplicate.uncertain ||= value.uncertain;
    } else merged.push({ ...value, sourceIndex: -1 });
  }
  return validateWindows(merged, duration);
}
function sampleFramesByTime(frames, limit) {
  if (!Array.isArray(frames) || !Number.isInteger(limit) || limit < 2)
    throw fault('전체 동작 샘플 수는 2개 이상이어야 합니다.');
  const sorted = [...new Map(frames.map(frame => {
    if (!frame || typeof frame.id !== 'string' || !Number.isFinite(frame.time)) throw fault('촬영 프레임이 유효하지 않습니다.');
    return [frame.time, frame];
  })).values()].sort((a, b) => a.time - b.time);
  if (sorted.length <= limit) return sorted;
  const selected = new Map();
  let cursor = 0;
  const first = sorted[0].time, span = sorted.at(-1).time - first;
  for (let index = 0; index < limit; index++) {
    const time = first + span * index / (limit - 1);
    while (cursor < sorted.length - 1 && Math.abs(sorted[cursor + 1].time - time) < Math.abs(sorted[cursor].time - time)) cursor++;
    selected.set(sorted[cursor].time, sorted[cursor]);
  }
  return [...selected.values()];
}
function timingBracket(frames, time) {
  if (!Number.isFinite(time) || !Array.isArray(frames) || !frames.length) throw fault('전환 시점의 확인 범위가 유효하지 않습니다.');
  const sorted = [...frames].sort((a, b) => a.time - b.time);
  const before = sorted.filter(frame => frame.time < time - 1e-6).at(-1);
  const after = sorted.find(frame => frame.time > time + 1e-6);
  return { start: before?.time ?? sorted[0].time, end: after?.time ?? sorted.at(-1).time };
}
function reviewTimingSuggestions(suggestions, clip, windows = [], { checkOrder = true } = {}) {
  if (!suggestions) return null;
  const result = { ...suggestions };
  const lastHitEnd = Math.max(0, ...windows.map(window => window.end));
  const warn = (marker, message) => {
    marker.uncertain = true;
    if (!marker.reason.includes(message)) marker.reason += (marker.reason ? '\n' : '') + message;
  };
  for (const key of ['comboTransition', 'actionEnd']) {
    const value = suggestions[key];
    if (!value) { result[key] = null; continue; }
    const marker = result[key] = { ...value, reason: typeof value.reason === 'string' ? value.reason : '', uncertain: value.uncertain === true };
    if (value.time === null || !Number.isFinite(value.time) || value.time < 0 || !clip || value.time > clip.length + 0.0001 ||
        (key === 'actionEnd' && value.time <= 0)) warn(marker, '유효한 전환·종료 시점인지 직접 확인해야 합니다.');
    if (!windows.length) warn(marker, '확인된 타격이 없어 전환·종료 시점을 직접 확인해야 합니다.');
    if (windows.some(window => window.uncertain)) warn(marker, '불확실한 타격 구간을 먼저 확인해야 합니다.');
    if (Number.isFinite(value.time) && value.time < lastHitEnd - 0.0001) warn(marker, '마지막 타격을 보존하는 시점인지 직접 확인해야 합니다.');
  }
  const combo = result.comboTransition, end = result.actionEnd;
  if (checkOrder && Number.isFinite(combo?.time) && Number.isFinite(end?.time) && combo.time > end.time + 0.0001) {
    for (const marker of [combo, end]) warn(marker, '콤보 전환이 공격 종료보다 늦어 두 시점을 함께 확인해야 합니다.');
  }
  return result;
}
function newJob(clip) {
  clip = validateClip(clip);
  return { id: randomUUID(), clip, status: 'draft', progressText: '', error: '', frames: [], duration: clip.length,
    windows: [], reviewed: false, analysisStatus: '', sourceGuid: '', actionPath: '', mode: 'update', group: 'combo',
    templatePath: '', copy: true, outputFolder: 'Assets/StudioBaekho/AutoHitTimer/Results', timeOverrides: [], timingSuggestions: null, timingError: '',
    savedAssets: [], createdUtc: new Date().toISOString(), versions: [] };
}
module.exports = { fault, validateClip, validateWindows, frameChunks, refinementTimes, mergeWindows, sampleFramesByTime, timingBracket, reviewTimingSuggestions, newJob };
