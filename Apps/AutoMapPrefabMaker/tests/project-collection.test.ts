import assert from 'node:assert/strict';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { createProjectCollection, MAX_PROJECT_BYTES, MAX_PROJECT_COLLECTION_BYTES, normalizeProject, readProject } from '../electron/services/projects';
import { createDemoMap, DEFAULT_SETTINGS, parseProjectFile } from '../src/shared/map';
import type { ProjectFile } from '../src/shared/types';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

function project(name = '후보 맵'): ProjectFile {
  const map = createDemoMap();
  map.name = name;
  return { formatVersion: 1, map, settings: structuredClone(DEFAULT_SETTINGS), bindings: [], blueprintDataUrl: PNG };
}

test('selected projects become independent reopenable files with public light fields, transforms and images', async t => {
  const input = project();
  input.bindings = ['ceiling', 'wall'].map((anchor, index) => ({
    id: `light-${anchor}`, label: `${anchor} light`, role: 'light', lightAnchor: anchor as 'ceiling' | 'wall',
    prefabGuid: String(index + 1).repeat(32), prefabPath: `Assets/${anchor}-light.prefab`,
    scale: { x: 2, y: 3, z: 4 }, offset: { x: .5, y: -.2, z: 1 }, rotationY: 90,
  }));
  input.generationDraft = { imageDataUrl: PNG, settings: structuredClone(DEFAULT_SETTINGS), region: { x: 1, row: 2, width: 3, height: 4 } };
  input.concept = { source: 'ai', text: '붉은 사막 아래 묻힌 제단. 낮은 벽과 거대한 기둥이 교전 공간을 나눈다.' };
  input.generationDraft.concept = { source: 'ai', text: '푸른 결정이 자라는 지하 제련소. 중앙 용광로 주위로 우회 공간을 둔다.' };
  input.generationDraft.settings.prompt = `${input.generationDraft.concept.text}\n후보 배치 지시: 외곽 우회 동선을 배치한다.`;
  input.generationDraft.preferences = { ...structuredClone(DEFAULT_SETTINGS), conceptMode: 'ai', prompt: '' };
  const second = project();
  second.concept = { source: 'manual', text: '구름 위의 검술 훈련장' };
  second.map.elevations[2][2] = 2;
  const snapshot = structuredClone([input, second]);
  const entries = unzipSync(createProjectCollection([input, second]));
  assert.deepEqual(Object.keys(entries), ['01-후보 맵.baekho.json', '02-후보 맵.baekho.json', 'README.txt']);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'baekho-collection-'));
  const saved: string[] = [];
  t.after(async () => { await Promise.all(saved.map(file => unlink(file))); await rmdir(directory); });
  for (const [index, name] of Object.keys(entries).filter(name => name.endsWith('.baekho.json')).entries()) {
    const file = path.join(directory, name);
    await writeFile(file, entries[name]);
    saved.push(file);
    const reopened = await readProject(file);
    assert.deepEqual(reopened, normalizeProject(snapshot[index]));
    assert.deepEqual(parseProjectFile(JSON.parse(strFromU8(entries[name]))), reopened);
  }
  assert.deepEqual([input, second], snapshot);
  const reopened = JSON.parse(strFromU8(entries['01-후보 맵.baekho.json'])) as ProjectFile;
  assert.deepEqual(reopened.bindings.map(binding => binding.lightAnchor), ['ceiling', 'wall']);
  assert.equal(reopened.generationDraft?.imageDataUrl, PNG);
  assert.deepEqual(reopened.concept, input.concept);
  assert.deepEqual(reopened.generationDraft?.concept, input.generationDraft.concept);
  assert.equal(reopened.generationDraft?.settings.prompt, input.generationDraft.settings.prompt);
  assert.equal(reopened.generationDraft?.preferences?.prompt, '');
  assert.equal(reopened.generationDraft?.preferences?.conceptMode, 'ai');
  assert.equal(reopened.blueprintDataUrl, PNG);
  assert.match(strFromU8(entries['README.txt']), /열기.*\.baekho\.json/);
  assert.match(strFromU8(entries['README.txt']), /다시 스캔/);
});

test('entry names are bounded flat Windows-safe names even for unfinished invalid map names', () => {
  const inputs = [project('../escape\\bad:<name>|?*'), project('CON'), project('...'), project('A'.repeat(500)), project('README.txt')];
  const entries = unzipSync(createProjectCollection(inputs));
  const names = Object.keys(entries).filter(name => name !== 'README.txt');
  assert.equal(names.length, inputs.length);
  for (const [index, name] of names.entries()) {
    assert.ok(name.startsWith(`${String(index + 1).padStart(2, '0')}-`));
    assert.ok(name.endsWith('.baekho.json'));
    assert.ok(name.length <= 3 + 64 + '.baekho.json'.length);
    assert.equal(path.win32.basename(name), name);
    assert.doesNotMatch(name, /[<>:"/\\|?*\u0000-\u001f]/);
    assert.equal(JSON.parse(strFromU8(entries[name])).map.name, inputs[index].map.name);
  }
  assert.ok(names.includes('03-Map.baekho.json'));
});

test('collection requires one through eight valid project structures while retaining editable unfinished maps', () => {
  for (const input of [undefined, null, {}, [], Array(9).fill(project()), Array(1)])
    assert.throws(() => createProjectCollection(input));
  assert.throws(() => createProjectCollection([project(), { ...project(), apiKey: 'secret' }]), /2번째 맵 후보.*구조/);
  assert.throws(() => createProjectCollection([project(), { ...project(), blueprintDataUrl: 'broken PNG' }]), /2번째 맵 후보.*PNG/);
  const unfinished = project();
  unfinished.map.connections = [];
  const entries = unzipSync(createProjectCollection(Array(8).fill(unfinished)));
  assert.equal(Object.keys(entries).length, 9);
  assert.deepEqual(JSON.parse(strFromU8(entries['08-후보 맵.baekho.json'])).bindings, []);
  assert.deepEqual(JSON.parse(strFromU8(entries['08-후보 맵.baekho.json'])).map.connections, []);
  assert.equal(Object.keys(unzipSync(createProjectCollection([unfinished]))).length, 2);
});

test('each candidate and the combined uncompressed collection are bounded before ZIP compression', () => {
  const oversized = project('x'.repeat(MAX_PROJECT_BYTES));
  assert.throws(() => createProjectCollection([oversized]), /1번째 맵 후보.*너무 큽니다/);
  oversized.map.name = 'released';
  const large = project('x'.repeat(Math.ceil(MAX_PROJECT_COLLECTION_BYTES / 6)));
  assert.throws(() => createProjectCollection(Array(6).fill(large)), /전체 크기가 128 MiB/);
});
