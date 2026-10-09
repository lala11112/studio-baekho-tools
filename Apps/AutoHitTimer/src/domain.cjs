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
function newJob(clip) {
  clip = validateClip(clip);
  return { id: randomUUID(), clip, status: 'draft', progressText: '', error: '', frames: [], duration: clip.length,
    windows: [], reviewed: false, analysisStatus: '', sourceGuid: '', actionPath: '', mode: 'update', group: 'combo',
    templatePath: '', copy: true, outputFolder: 'Assets/StudioBaekho/AutoHitTimer/Results', timeOverrides: [],
    savedAssets: [], createdUtc: new Date().toISOString(), versions: [] };
}
module.exports = { fault, validateClip, validateWindows, frameChunks, refinementTimes, mergeWindows, newJob };
