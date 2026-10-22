/** One explicitly authorized app-button M01 pilot. No other paid step or new model adoption. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { _electron as electron, type ElectronApplication } from 'playwright';
import type { AppState } from '../shared/types';
import { graphicsTripoReserved } from '../shared/graphics-catalog';

const repo = process.cwd(), profile = path.join(process.env.APPDATA!, 'partsmith');
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const executablePath = path.join(repo, `release/${version}/win-unpacked/Partsmith.exe`);
const evidence = path.join(repo, 'artifacts/runtime/graphics-human-live.json');
const source = path.join(profile, 'projects/81ac0f31-8c0a-411c-8f95-b53a518fe766/assets/9c7ea92e-9ab6-4271-b3ba-db055f0cf0bc.png');
const name = '인간형 파츠 완주 검증';
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mode = process.argv[2]; assert(['prepare', 'submit', 'inspect'].includes(mode), 'Explicit prepare/submit/inspect required');
const report: any = fs.existsSync(evidence) ? JSON.parse(fs.readFileSync(evidence, 'utf8')) : { schemaVersion: 1, profile, limit: 300, source, sourceSha256: digest(source), createdAt: new Date().toISOString() };
assert.equal(report.profile, profile); assert.equal(report.limit, 300); assert.equal(digest(source), report.sourceSha256);
const save = () => fs.writeFileSync(evidence, JSON.stringify(report, null, 2)); save();
const env = { ...process.env, PARTSMITH_DATA: profile, PARTSMITH_DEV: '' }; delete env.ELECTRON_RUN_AS_NODE;
let app: ElectronApplication | undefined;
try {
  app = await electron.launch({ executablePath, env, args: ['--remote-debugging-port=0'], timeout: 30000 });
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), version);
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const state = () => page.evaluate(() => window.desktop.call<AppState>({ type: 'state' }));
  await page.getByRole('button', { name: '새 프로젝트', exact: true }).waitFor();
  const initial = await state(); assert.equal(path.resolve(initial.dataDir), path.resolve(profile)); assert(initial.key.configured);
  assert(!(initial.graphicsWorkspaces ?? []).some(w => w.tasks.some(t => t.status === 'running')), 'Existing production active; do not restart');
  const protectedWorkspaces = initial.graphicsWorkspaces.filter(w => w.projectId !== report.projectId && initial.projects.find(p => p.id === w.projectId)?.name !== name);
  const protectedFiles = protectedWorkspaces.flatMap(w => w.versions.flatMap(v => v.files.map(f => ({ path: path.join(profile, 'projects', w.projectId, f.path), sha256: f.sha256 }))));
  for (const f of protectedFiles) assert.equal(digest(f.path), f.sha256);
  const existing = initial.projects.filter(p => p.name === name); assert(existing.length <= 1, 'Ambiguous pilot project');
  if (!report.projectId && existing.length) { report.projectId = existing[0].id; save(); }
  if (!report.projectId) {
    assert.equal(mode, 'prepare'); await page.getByRole('button', { name: '새 프로젝트', exact: true }).click();
    const modal = page.getByRole('dialog'); await modal.getByLabel('프로젝트 이름').fill(name);
    assert.equal(await modal.getByRole('checkbox').isChecked(), false);
    await modal.getByRole('button', { name: '프로젝트 만들기' }).click(); await page.getByTestId('graphics-studio').waitFor();
    report.projectId = (await state()).projects.find(p => p.name === name)!.id; save();
  } else {
    await page.locator(`[data-project-id="${report.projectId}"]`).getByTestId('project-open').click(); await page.getByTestId('graphics-studio').waitFor();
  }
  const workspace = async () => (await state()).graphicsWorkspaces.find(w => w.projectId === report.projectId)!;
  const wait = async (predicate: (w: Awaited<ReturnType<typeof workspace>>) => boolean) => { for (let i = 0; i < 80; i++) { const w = await workspace(); if (predicate(w)) return w; await new Promise(r => setTimeout(r, 250)); } throw Error('App state timed out'); };
  if (!report.objectId) {
    const objects = (await workspace())?.objects ?? []; assert(objects.length <= 1);
    if (objects.length) { report.objectId = objects[0].id; save(); }
    else {
      assert.equal(mode, 'prepare'); await page.getByTestId('graphics-new-object').click();
      const modal = page.getByTestId('graphics-create-dialog');
      await modal.getByRole('group', { name: '오브젝트 분류', exact: true }).getByRole('button', { name: '생물', exact: true }).click();
      await modal.getByRole('button', { name: '인간형 캐릭터', exact: true }).click();
      await modal.getByLabel('이름', { exact: true }).fill('흰 재킷 인간형 캐릭터');
      await modal.getByRole('button', { name: '오브젝트 만들기', exact: true }).click();
      report.objectId = (await wait(w => w.objects.length === 1)).objects[0].id; save();
    }
  }
  await page.getByTestId(`graphics-object-${report.objectId}`).click();
  if (!report.sourceVersionId) {
    assert.equal(mode, 'prepare');
    const previous = (await workspace()).versions.filter(v => v.files.some(f => f.sha256 === report.sourceSha256)); assert(previous.length <= 1);
    if (!previous.length) {
      // Exact native file chooser result, invoked only by the real app import button.
      await app.evaluate(({ dialog }, source) => { const original = dialog.showOpenDialog; Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: Function('dialog', 'original', 'source', 'return async function(){Object.defineProperty(dialog,"showOpenDialog",{configurable:true,value:original});return {canceled:false,filePaths:[source]};}')(dialog, original, source) }); }, source);
      await page.getByText('이미 가진 이미지 · 모델 · 동작 가져오기', { exact: true }).click();
      await page.getByLabel('가져올 자료의 역할').selectOption('design'); await page.getByTestId('graphics-import').click();
      await wait(w => w.versions.some(v => v.files.some(f => f.sha256 === report.sourceSha256)));
    }
    report.sourceVersionId = (await workspace()).versions.find(v => v.files.some(f => f.sha256 === report.sourceSha256))!.id; save();
  }
  if (mode === 'prepare' && !report.taskId) {
    await page.getByTestId(`graphics-version-${report.sourceVersionId}`).click();
    if ((await workspace()).objects[0].accepted['design:main'] !== report.sourceVersionId) {
      await page.getByTestId('graphics-accept-version').click(); await wait(w => w.objects[0].accepted['design:main'] === report.sourceVersionId);
    }
    await page.getByRole('navigation', { name: '제작 단계' }).getByRole('button', { name: '2 모델', exact: true }).click();
    await page.getByRole('button', { name: '인간 3파트 설정 · 전체 제작 후 분리', exact: true }).click();
    await page.getByLabel('후보 개수', { exact: true }).fill('1');
    await page.getByRole('button', { name: '옵션 저장', exact: true }).click();
    await wait(w => w.objects[0].creation?.attributes.compositionStrategy === 'whole-then-split');
    await page.getByText('Tripo API 누적 승인 한도', { exact: true }).click();
    await page.getByLabel('Tripo API 한도').fill('300'); await page.getByRole('button', { name: '한도 저장', exact: true }).click();
    await wait(w => w.tripoBudget?.limit === 300);
    const prior = (await workspace()).tasks.filter(t => t.taskId === 'M01'); assert.equal(prior.length, 0, 'Inspect prior M01 instead of another request');
    await page.getByTestId('graphics-prepare').click();
    const t = (await wait(w => w.tasks.some(t => t.taskId === 'M01' && t.status === 'awaiting_approval'))).tasks.at(-1)!;
    assert.equal(t.cost?.credits, 100); assert.equal(t.settings.count, 1); assert.equal(t.settings.faceLimit, 5000); assert.equal(t.settings.quad, true); assert.equal(t.settings.partId, undefined); assert.deepEqual(t.inputVersionIds, [report.sourceVersionId]);
    Object.assign(report, { taskId: t.id, requestHash: t.requestHash, estimatedCredits: 100, preparedAt: new Date().toISOString() }); save();
    await page.getByTestId(`graphics-cost-${t.id}`).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(repo, 'artifacts/runtime/graphics-human-model-cost.png') });
  }
  assert(report.taskId, 'No existing task');
  let task = (await workspace()).tasks.find(t => t.id === report.taskId)!; assert.equal(task.requestHash, report.requestHash);
  if (mode === 'submit' && !report.approvalAttemptAt) {
    assert.equal(task.status, 'awaiting_approval'); assert.equal(task.cost?.provider, 'Tripo API'); assert.equal(task.cost?.credits, 100);
    assert.equal((await workspace()).tripoBudget?.limit, 300); assert.equal(graphicsTripoReserved(await workspace()), 0);
    report.approvalAttemptAt = new Date().toISOString(); save();
    await page.getByTestId(`graphics-approve-${task.id}`).click();
    await wait(w => w.tasks.find(t => t.id === report.taskId)?.status !== 'awaiting_approval');
  }
  if (mode === 'submit') {
    let last = ''; const end = Date.now() + 20 * 60_000;
    do {
      task = (await workspace()).tasks.find(t => t.id === report.taskId)!;
      const message = task.status + ': ' + task.message; if (message !== last) { console.log(message); last = message; }
      Object.assign(report, { status: task.status, message: task.message, backendJobIds: task.backendJobIds, outputVersionIds: task.outputVersionIds }); save();
      if (task.status !== 'running') break;
      await new Promise(r => setTimeout(r, 5000));
    } while (Date.now() < end);
    assert.notEqual(task.status, 'running', 'Task still running; preserve app and inspect');
  }
  const final = await state(), w = await workspace();
  for (const protectedWorkspace of protectedWorkspaces) assert.deepEqual(final.graphicsWorkspaces.find(w => w.projectId === protectedWorkspace.projectId), protectedWorkspace);
  for (const f of protectedFiles) assert.equal(digest(f.path), f.sha256);
  for (const v of w.versions) for (const f of v.files) assert.equal(digest(path.join(profile, 'projects', report.projectId, f.path)), f.sha256);
  assert.equal(w.objects[0].accepted['model:main'], undefined, 'New model must await user review');
  Object.assign(report, { status: task.status, message: task.message, reservedCredits: graphicsTripoReserved(w), outputVersionIds: task.outputVersionIds, backendJobIds: task.backendJobIds, jobs: final.projects.find(p => p.id === report.projectId)!.jobs.map(j => ({ id: j.id, remoteId: j.remoteId, status: j.status, credits: j.credits })), protectedVersions: protectedWorkspaces.reduce((n, w) => n + w.versions.length, 0), errors, lastCheckedAt: new Date().toISOString() }); save();
  console.log(JSON.stringify(report));
} catch (error) { report.lastError = String(error); save(); throw error; }
finally {
  // Never terminate an active paid task. Normal prepare/review closure retains all state on disk.
  if (app) { const active = await app.firstWindow().then(p => p.evaluate(() => window.desktop.call<AppState>({ type: 'state' }))).then(s => s.graphicsWorkspaces.some(w => w.tasks.some(t => t.status === 'running'))).catch(() => true); if (!active) await app.close(); else { console.error('Production remains active; leave app running and inspect the existing task.'); await new Promise(() => {}); } }
}
