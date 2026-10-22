import assert from 'node:assert/strict';
import { mkdtemp, rmdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { atomicWrite, normalizeProject, readProject, serializeProject } from '../electron/services/projects';
import { publicProject, validateSettings } from '../electron/services/validation';
import { assertManualConcept, conceptForRequest, conceptMode, parseConceptText, parseMapConcept } from '../src/shared/concepts';
import { createDemoMap, DEFAULT_SETTINGS, parseProjectFile } from '../src/shared/map';
import type { GenerationSettings, ProjectFile } from '../src/shared/types';
import { renderConceptControls, renderConceptResult, updateGenerationControl } from '../src/generation-controls';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const project = (): ProjectFile => ({ formatVersion: 1, map: createDemoMap(), settings: structuredClone(DEFAULT_SETTINGS), bindings: [] });

test('concept controls keep manual text across modes and render escaped result text with its source', () => {
  const settings = { ...DEFAULT_SETTINGS, prompt: '<고대 정원> & "안개"' };
  const manual = updateGenerationControl(settings, 'conceptMode', 'manual');
  assert.match(renderConceptControls(manual, false), /id="prompt"/);
  assert.match(renderConceptControls(manual, false), /&lt;고대 정원&gt; &amp; &quot;안개&quot;/);
  const automatic = updateGenerationControl(manual, 'conceptMode', 'ai');
  assert.equal(automatic.prompt, settings.prompt);
  assert.doesNotMatch(renderConceptControls(automatic, false), /id="prompt"/);
  assert.match(renderConceptControls(automatic, true), /disabled/);
  assert.equal(updateGenerationControl(automatic, 'conceptMode', 'manual').prompt, settings.prompt);
  assert.doesNotThrow(() => updateGenerationControl(DEFAULT_SETTINGS, 'conceptMode', 'manual'));
  assert.throws(() => updateGenerationControl(settings, 'conceptMode', 'unknown'));
  const result = renderConceptResult({ source: 'ai', text: '<script>안개</script>' }, '이 맵에 사용한 컨셉', 'map');
  assert.match(result, /AI 작성/);
  assert.match(result, /&lt;script&gt;안개&lt;\/script&gt;/);
  assert.doesNotMatch(result, /<script>/);
  assert.equal(renderConceptResult(undefined, '컨셉', 'draft'), '');
});

test('concept controls guide new inputs toward gameplay goals and player choices', () => {
  const manual = renderConceptControls({ ...DEFAULT_SETTINGS, conceptMode: 'manual', prompt: '' }, false);
  assert.match(manual, /플레이 목표와 플레이어가 판단할 선택/);
  assert.match(manual, /접근과 이탈 시점을 선택/);
  assert.doesNotMatch(manual, /테마와 분위기|공간 특징/);
  const automatic = renderConceptControls({ ...DEFAULT_SETTINGS, conceptMode: 'ai' }, false);
  assert.match(automatic, /플레이 목표와 선택 중심/);
  assert.match(automatic, /플레이 경험의 초점을 달리/);
});

test('new projects default to an empty AI concept input while legacy settings keep manual mode', () => {
  assert.equal(DEFAULT_SETTINGS.conceptMode, 'ai');
  assert.equal(DEFAULT_SETTINGS.prompt, '');
  const legacy: GenerationSettings = { ...DEFAULT_SETTINGS, prompt: '기존 파일에 작성한 컨셉' };
  delete legacy.conceptMode;
  assert.equal(conceptMode(legacy), 'manual');
  assert.equal(validateSettings(legacy).conceptMode, 'manual');
  const input = project();
  input.settings = legacy;
  const reopened = parseProjectFile(input);
  assert.equal(reopened.settings.conceptMode, 'manual');
  assert.equal(reopened.settings.prompt, legacy.prompt);
  assert.equal(reopened.concept, undefined, 'Legacy input is not evidence of the current map concept');
});

test('saving an unfinished manual input is valid and generation alone requires its text', () => {
  for (const mode of ['ai', 'manual'] as const) {
    const settings = { ...DEFAULT_SETTINGS, conceptMode: mode, prompt: '' };
    assert.equal(validateSettings(settings).prompt, '');
    const input = project();
    input.settings = settings;
    assert.equal(JSON.parse(serializeProject(input)).settings.prompt, '');
  }
  assert.throws(() => assertManualConcept({ ...DEFAULT_SETTINGS, conceptMode: 'manual', prompt: '   ' }));
  assert.doesNotThrow(() => assertManualConcept({ ...DEFAULT_SETTINGS, conceptMode: 'manual', prompt: '침수된 기록 보관소' }));
  assert.doesNotThrow(() => assertManualConcept({ ...DEFAULT_SETTINGS, conceptMode: 'ai', prompt: '' }));
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, conceptMode: 'unknown' }));
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, prompt: 'x'.repeat(6001) }));
});

test('concept validation rejects missing text, invalid sources, oversized output and hidden properties', () => {
  assert.equal(parseConceptText('  얼어붙은 수정 채굴장  '), '얼어붙은 수정 채굴장');
  assert.equal(parseConceptText('x'.repeat(2000)).length, 2000);
  assert.equal(parseConceptText('x'.repeat(6000), 'manual').length, 6000);
  for (const value of [null, undefined, {}, [], 1, '', '  ', 'x'.repeat(2001)]) assert.throws(() => parseConceptText(value));
  assert.throws(() => parseConceptText('x'.repeat(6001), 'manual'));
  for (const value of [null, undefined, [], {}, { source: 'ai' }, { source: 'manual', text: '' }, { source: 'user', text: '테마' }, { source: new String('ai'), text: '테마' }, { source: 'ai', text: '테마', apiKey: 'secret' }]) {
    assert.throws(() => parseMapConcept(value));
  }
  assert.deepEqual(parseMapConcept({ source: 'manual', text: '  오래된 천문대  ' }), { source: 'manual', text: '오래된 천문대' });
});

test('request concepts replace only transient prompt and keep the saved manual input intact', () => {
  const settings: GenerationSettings = { ...DEFAULT_SETTINGS, conceptMode: 'ai', prompt: '직접 입력 모드에서 남겨 둔 문구' };
  const before = structuredClone(settings);
  const concept = { source: 'ai', text: '잊힌 왕국의 지하 저수조' } as const;
  const request = conceptForRequest(settings, concept);
  assert.equal(request.prompt, concept.text);
  assert.deepEqual(settings, before);
  assert.notEqual(request, settings);
  assert.equal(request.width, settings.width);
  assert.equal(request.connectionWidth, settings.connectionWidth);
  assert.equal(request.codexModel, settings.codexModel);
});

test('current map and failed draft preserve independent concepts, source preferences and exact request context', () => {
  const input = project();
  input.settings.prompt = '다음에 직접 입력할 맵 아이디어';
  input.concept = { source: 'manual', text: '완성된 맵: 바닷가 요새' };
  const concept = { source: 'ai', text: '분석 대기 중인 맵: 물안개 낀 정원' } as const;
  const preferences = { ...structuredClone(input.settings), prompt: '', conceptMode: 'ai' as const };
  const request = conceptForRequest(preferences, concept);
  request.prompt += '\n후보 배치 지시: 동쪽 고지와 두 갈래 우회로.\n부분 재생성 내부 정보: 잠긴 셀 유지.';
  input.generationDraft = { imageDataUrl: PNG, settings: request, preferences, concept, region: { x: 1, row: 2, width: 3, height: 4 } };
  const snapshot = structuredClone(input);
  const parsed = parseProjectFile(JSON.parse(serializeProject(input)));
  assert.deepEqual(parsed.concept, snapshot.concept);
  assert.deepEqual(parsed.generationDraft?.concept, snapshot.generationDraft?.concept);
  assert.deepEqual(parsed.generationDraft?.preferences, validateSettings(preferences));
  assert.deepEqual(parsed.generationDraft?.settings, validateSettings(request));
  assert.equal(parsed.settings.prompt, input.settings.prompt);
  assert.equal(parsed.generationDraft?.preferences?.prompt, '');
  assert.doesNotMatch(parsed.generationDraft!.concept!.text, /후보 배치|부분 재생성/);
  assert.deepEqual(input, snapshot);
  parsed.concept!.text = '수정';
  parsed.generationDraft!.concept!.text = '수정';
  parsed.generationDraft!.preferences!.width = 8;
  assert.deepEqual(input, snapshot, 'Parsed public project must not retain mutable input references');
});

test('project file and automatic recovery round trips retain concept metadata and blank AI preferences', async t => {
  const input = project();
  input.concept = { source: 'ai', text: '따뜻한 등불이 켜진 폐쇄된 역 대합실' };
  input.generationDraft = { imageDataUrl: PNG, settings: conceptForRequest(input.settings, input.concept), preferences: structuredClone(input.settings), concept: structuredClone(input.concept) };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'baekho-concept-'));
  const files: string[] = [];
  t.after(async () => { await Promise.all(files.map(file => unlink(file))); await rmdir(directory); });
  for (const name of ['map.baekho.json', 'latest.baekho.json']) {
    const file = path.join(directory, name);
    await atomicWrite(file, serializeProject(input));
    files.push(file);
    assert.deepEqual(await readProject(file), normalizeProject(input));
  }
});

test('public project validates metadata and strips unrelated properties without exposing secrets', () => {
  const input = project();
  input.concept = { source: 'ai', text: '산속 수도원' };
  input.generationDraft = { imageDataUrl: PNG, settings: { ...DEFAULT_SETTINGS, prompt: '실제 이미지 생성 요청' }, preferences: { ...DEFAULT_SETTINGS }, concept: { source: 'manual', text: '지하 온실' } };
  const publicCopy = publicProject({ ...input, apiKey: 'secret' } as ProjectFile);
  assert.equal(JSON.stringify(publicCopy).includes('secret'), false);
  for (const invalid of [{ source: 'ai', text: '' }, { source: 'ai', text: 'x'.repeat(2001) }, { source: 'manual', text: 'x'.repeat(6001) }]) {
    assert.throws(() => normalizeProject({ ...input, concept: invalid }));
    assert.throws(() => normalizeProject({ ...input, generationDraft: { ...input.generationDraft, concept: invalid } }));
  }
  assert.throws(() => normalizeProject({ ...input, generationDraft: { ...input.generationDraft, preferences: { ...DEFAULT_SETTINGS, apiKey: 'secret' } } }));
  assert.deepEqual(publicCopy.concept, input.concept);
  assert.deepEqual(publicCopy.generationDraft?.concept, input.generationDraft.concept);
});
