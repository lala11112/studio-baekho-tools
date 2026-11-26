import assert from 'node:assert/strict';
import test from 'node:test';
import { GenerationMonitor } from '../src/generation-progress';
import { parseGenerationSettings } from '../src/shared/features';
import { createDemoMap, DEFAULT_SETTINGS, parseProjectFile, buildManifest } from '../src/shared/map';
import { publicProject } from '../electron/services/validation';
import type { GenerationProgress, ProjectFile } from '../src/shared/types';

test('legacy projects and new defaults use image generation; direct survives public serialization and export', () => {
  assert.equal(DEFAULT_SETTINGS.generationMethod, 'image');
  const { generationMethod: _method, ...legacy } = DEFAULT_SETTINGS;
  assert.equal(parseGenerationSettings(legacy).generationMethod, 'image');
  assert.throws(() => parseGenerationSettings({ ...legacy, generationMethod: 'turbo' }), /생성 방식/);
  const project: ProjectFile = { formatVersion: 1, map: createDemoMap(), settings: { ...legacy, generationMethod: 'direct' },
    bindings: (['wall', 'floor', 'door', 'prop', 'stair'] as const).map((role, index) => ({ id: role, role, label: role,
      prefabGuid: String(index + 1).repeat(32), prefabPath: `Assets/${role}.prefab`, scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotationY: 0 })) };
  const saved = parseProjectFile(JSON.parse(JSON.stringify(publicProject(project))));
  assert.equal(saved.settings.generationMethod, 'direct');
  assert.equal(saved.blueprintDataUrl, undefined);
  assert.deepEqual(buildManifest(saved.map, saved.bindings), buildManifest(project.map, project.bindings));
});

test('progress replaces running values, totals multiple stages and freezes the elapsed time on finish', () => {
  let now = 0;
  const monitor = new GenerationMonitor(() => now);
  monitor.begin('direct');
  const event: GenerationProgress = { id: 'stage', jobId: 'job', method: 'direct', stage: 'layout', state: 'running', elapsedMs: 0 };
  monitor.receive(event);
  now = 2000;
  assert.match(monitor.render(), /구조 설계 · 진행 중/);
  assert.match(monitor.render(), /2\.0초/);
  monitor.receive({ ...event, state: 'completed', elapsedMs: 1500, model: '<script>', reasoningEffort: 'ultra' });
  monitor.receive(event); // Late running notification cannot revive a completed stage.
  monitor.receive({ ...event, id: 'validation1', stage: 'validation', state: 'completed', elapsedMs: 10 });
  monitor.receive({ ...event, id: 'validation2', stage: 'validation', state: 'completed', elapsedMs: 15 });
  monitor.finish('completed');
  const result = monitor.render();
  assert.match(result, /완료 · 2\.0초/); assert.match(result, /<dd>1\.5초<\/dd>/); assert.match(result, /<dd>25ms<\/dd>/);
  assert.match(result, /&lt;script&gt;/); assert.doesNotMatch(result, /<script>/);
  now = 100000;
  monitor.receive({ ...event, id: 'late' });
  assert.equal(monitor.render(), result);
});

test('a cancelled progress run stops its live timer and a fresh run discards previous measurements', () => {
  let now = 1000;
  const monitor = new GenerationMonitor(() => now);
  monitor.begin('image');
  monitor.receive({ id: 'stage', jobId: 'job', method: 'image', stage: 'image', state: 'running', elapsedMs: 0 });
  now += 3200; monitor.finish('cancelled');
  assert.equal(monitor.active, false); assert.match(monitor.render(), /취소 · 3\.2초/); assert.doesNotMatch(monitor.render(), /진행 중/);
  monitor.begin('direct');
  assert.match(monitor.render(), /빠른 생성/); assert.doesNotMatch(monitor.render(), /설계도 생성/);
});
