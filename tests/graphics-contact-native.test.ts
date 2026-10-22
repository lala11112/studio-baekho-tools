import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createGraphicsContactExecutor } from '../engine/graphics-contact';
import type { GraphicsNativeArgs } from '../engine/graphics-native';
import type { AssetVersion } from '../shared/graphics';

const blender = process.env.BLENDER_PATH ?? 'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe';
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-contact-'));
  t.after(() => { const actual = fs.realpathSync(root); assert.equal(path.dirname(actual), fs.realpathSync(os.tmpdir())); assert(path.basename(actual).startsWith('ps-contact-')); fs.rmSync(actual, { recursive: true, force: true }); });
  const inputs: AssetVersion[] = ['main', 'part-head', 'part-body', 'part-hair'].map((slot, index) => {
    const file = path.join(root, slot + '.blend'); fs.writeFileSync(file, 'immutable native fixture ' + index);
    return { id: slot, objectId: 'object', role: 'model', slot, label: slot, createdAt: '2026-10-14', sourceVersionIds: [], provenance: { type: 'codex', jobId: 'm08' }, warnings: [], files: [{ path: path.basename(file), sha256: hash(file), bytes: fs.statSync(file).size, kind: 'blend' }] };
  });
  const args: GraphicsNativeArgs = { projectRoot: root, workspacePath: path.join(root, 'graphics.json'),
    object: { id: 'object', kind: 'character', name: 'Existing assembly', createdAt: '2026-10-14', selectedTasks: ['M06'], instruction: '', settings: {}, references: [], accepted: {} },
    task: { id: 'analyze-1', objectId: 'object', taskId: 'M06', createdAt: '2026-10-14', updatedAt: '2026-10-14', status: 'running', inputVersionIds: inputs.map(v => v.id), settings: { contactPhase: 'analyze', sourceVersionId: 'main', contactPartVersionIds: JSON.stringify(inputs.slice(1).map(v => v.id)) }, instruction: 'Inspect neck and inner hair only', requestHash: 'same-fixed-request', outputVersionIds: [], backendJobIds: [], message: '', localOnly: false },
    inputs, blenderPath: process.execPath, resources: path.resolve('integrations'), signal: new AbortController().signal, onProgress() {} };
  return { root, args };
}

test('contact worker is dispatched once; saved blocked analysis recovers without worker or paid calls', async t => {
  const { root, args } = fixture(t); let workers = 0, calls = 0;
  const execute = createGraphicsContactExecutor({ runBlender: async (_exe, command) => {
    const q = read(command.at(-1)!); calls++;
    if (q.mode === 'prepare') {
      write(q.report, { identity: q.identity, sourceSha256: q.sourceSha256, contract: { exact: { meshes: {} } } });
      const image = path.join(q.output, 'before.png'); fs.writeFileSync(image, 'fixed local render');
      write(q.previewReport, { views: [{ id: 'posX', file: 'before.png' }] });
    } else {
      assert.equal(q.mode, 'analyze');
      write(q.report, { identity: q.identity, phase: 'analyze', status: 'blocked', sourceVersionId: 'main', partVersionIds: ['part-head', 'part-body', 'part-hair'], files: [], views: [], allowedVertexCount: 0, warnings: ['Clothing and neck cannot safely be separated'] });
    }
  }, workerFactory: () => ({ probe: async () => { throw Error('No probe'); }, run: async task => {
    workers++; assert.equal(task.requestedModel, 'gpt-6-astra'); assert.match(task.prompt, /ANALYSIS ONLY/);
    const dispatch = read(path.join(root, 'graphics/jobs/analyze-1/contact/dispatch.json'));
    assert.equal(dispatch.automaticRetries, 0); assert.equal(dispatch.phase, 'analyze');
    return { result: { status: 'needs_input', summary: 'Clothing and neck cannot safely be separated', warnings: [] } };
  } }) });
  const first = await execute(args);
  assert.equal(first.contact?.status, 'blocked'); assert.equal(first.slot, 'contact-review');
  assert(first.files.every(f => !/\.(blend|fbx|glb)$/.test(f.path)));
  args.recoveryOnly = true; assert.deepEqual(await execute(args), first);
  assert.equal(workers, 1); assert.equal(calls, 2);
  const source = path.join(root, 'main.blend'); fs.appendFileSync(source, 'changed');
  await assert.rejects(execute(args), /고정한 접합/); assert.equal(workers, 1);
});

test('interrupted contact dispatch never reauthors during recovery', async t => {
  const { root, args } = fixture(t); let workers = 0;
  const execute = createGraphicsContactExecutor({ runBlender: async (_exe, command) => {
    const q = read(command.at(-1)!);
    write(q.report, { identity: q.identity, sourceSha256: q.sourceSha256, contract: { exact: { meshes: {} } } });
    write(q.previewReport, { views: [] });
  }, workerFactory: () => ({ probe: async () => { throw Error('No probe'); }, run: async () => { workers++; throw Error('Synthetic stream disconnected'); } }) });
  await assert.rejects(execute(args), /Synthetic stream/);
  assert(fs.existsSync(path.join(root, 'graphics/jobs/analyze-1/contact/dispatch.json')));
  args.recoveryOnly = true;
  // No proposal or response must not silently dispatch another expensive task.
  await assert.rejects(execute(args)); assert.equal(workers, 1);
});

test('contact repair requires exact same placed parts and explicit confirmed regions before worker', async t => {
  const { args } = fixture(t); let workers = 0;
  const execute = createGraphicsContactExecutor({ workerFactory: () => { workers++; throw Error('Must not run'); } });
  args.inputs[1].provenance.jobId = 'different-job'; await assert.rejects(execute(args), /같은 작업/);
  args.inputs[1].provenance.jobId = 'm08'; args.task.settings.contactPhase = 'repair';
  await assert.rejects(execute(args), /확인한 수정 영역/); assert.equal(workers, 0);
});

test('actual Blender contact masks, protected geometry and per-part native export', { skip: !fs.existsSync(blender), timeout: 240_000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-contact-native-'));
  t.after(() => { const actual = fs.realpathSync(root); assert.equal(path.dirname(actual), fs.realpathSync(os.tmpdir())); assert(path.basename(actual).startsWith('ps-contact-native-')); fs.rmSync(actual, { recursive: true, force: true }); });
  const process = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', path.resolve('scripts/graphics-contact-native-check.py'), '--', root, path.resolve('integrations/blender')], { encoding: 'utf8', windowsHide: true, timeout: 230_000, maxBuffer: 10 * 1024 * 1024 });
  assert.equal(process.status, 0, process.stdout.slice(-7000) + process.stderr.slice(-5000));
  const report = read(path.join(root, 'result.json')); assert.equal(report.passed, true); assert(report.count >= 20); assert.equal(report.productionCalls, 0);
});
