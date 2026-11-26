'use strict';
// Real Claude Code validation against previously captured Unity frames.
// Usage: node scripts/validate-claude.cjs <real-capture.json> [output.json]
// This checks the CLI, schema and time mapping with a real model. It is not an accuracy evaluation.
const fs = require('node:fs');
const path = require('node:path');
const { ClaudeCodeAnalyzer } = require('../src/ai.cjs');
const { frameChunks, sampleFramesByTime } = require('../src/domain.cjs');

const [capturePath, outputPath = path.resolve(__dirname, '../../../.test-unity/claude-real-ai.json')] = process.argv.slice(2);
if (!capturePath) { console.error('Usage: node scripts/validate-claude.cjs <real-capture.json> [output.json]'); process.exit(2); }

async function timed(label, callback) {
  const started = Date.now();
  try { const value = await callback(); console.log(`${label}: ok (${Date.now() - started} ms)`); return { ok: true, ms: Date.now() - started, value }; }
  catch (error) { console.log(`${label}: ${error.code || 'ERROR'} ${error.message}`); return { ok: false, ms: Date.now() - started, error: { code: error.code, message: error.message } }; }
}

(async () => {
  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8').replace(/^﻿/, ''));
  const clip = { name: capture.clip.name, length: capture.clip.length };
  const frames = capture.frames.map(frame => ({ id: frame.id, time: frame.time, path: frame.path }));
  const analyzer = new ClaudeCodeAnalyzer({ timeoutMs: 600000 });
  const record = { createdUtc: new Date().toISOString(), engine: 'Claude Code', clip: capture.clip.name, frameCount: frames.length, accuracyValidated: false };

  record.status = await analyzer.status();
  console.log('status:', record.status.label, record.status.model || '(default model)');
  if (!record.status.authenticated) { fs.mkdirSync(path.dirname(outputPath), { recursive: true }); fs.writeFileSync(outputPath, JSON.stringify(record, null, 2)); process.exit(1); }

  // Same synthetic metadata case as the 2026-10-12 Codex check.
  const catalog = [
    { name: 'Sword_Forward_Thrust', path: 'Assets/Combat/Sword/Sword_Forward_Thrust.anim', stateName: 'Base.Attack.Thrust', length: 0.7 },
    { name: 'Sword_Spin_Slash', path: 'Assets/Combat/Sword/Sword_Spin_Slash.anim', stateName: 'Base.Attack.Spin', length: 1.4 },
    { name: 'Bow_Forward_Shot', path: 'Assets/Combat/Bow/Bow_Forward_Shot.anim', stateName: 'Base.Bow.Shot', length: 1.1 },
    { name: 'Sword_Slash_Right', path: 'Assets/Combat/Sword/Sword_Slash_Right.anim', stateName: 'Base.Attack.SlashR', length: 0.9 },
    { name: 'Idle_Breathing', path: 'Assets/Locomotion/Idle_Breathing.anim', stateName: 'Base.Idle', length: 3 }
  ];
  const search = await timed('search', () => analyzer.rankAnimations({ query: '검으로 앞으로 찌르는 짧은 공격, 회전 베기와 활 제외', clips: catalog }));
  record.search = search.ok ? { ...search, value: { ...search.value, matches: search.value.matches.map(match => ({ ...match, name: catalog[match.index].name })) } } : search;

  // Coarse hit pass exactly as the controller chunks it.
  const chunks = frameChunks(frames);
  record.hits = [];
  const windows = [];
  for (const [index, chunk] of chunks.entries()) {
    const result = await timed(`hits chunk ${index + 1}/${chunks.length} (${chunk.length} frames)`, () => analyzer.analyze({ clip, frames: chunk }));
    record.hits.push(result);
    if (result.ok) windows.push(...result.value.windows.map(window => ({ start: window.start, end: window.end })));
  }

  // Whole-clip timing pass with the proposed windows, sampled like the controller (up to 96 frames).
  const timingFrames = sampleFramesByTime(frames, 96);
  record.timing = await timed(`timing (${timingFrames.length} frames, ${windows.length} windows)`, () => analyzer.analyzeTiming({ clip, frames: timingFrames, windows }));

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(record, null, 2));
  console.log('record:', outputPath);
  process.exit([search, ...record.hits, record.timing].every(item => item.ok) ? 0 : 1);
})();
