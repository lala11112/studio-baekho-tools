// User-authorized UV adoption and head-only 4K texture preparation through app UI.
// Never clicks paid approval, uploads, or submits production work.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const profile = path.join(process.env.APPDATA, 'partsmith');
const projectId = '5844e13a-7892-422b-ac3f-410fe4f59231';
const objectId = 'dedbdea6-d960-4120-b3ee-145b298a46c8';
const sourceId = 'eefacd21-954b-49b4-970e-f1e79e682a89';
const imageId = 'a66e8746-46fd-440a-b5f5-05bd1e255e87';
const output = path.resolve('artifacts/runtime/graphics-independent-head-texture-prepare.json');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const record = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : { projectId, objectId, sourceId, imageId };
for (const [key, value] of Object.entries({ projectId, objectId, sourceId, imageId })) assert.equal(record[key], value);
const save = () => fs.writeFileSync(output, JSON.stringify(record, null, 2));
const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0];
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('index.html')); assert(page);
page.setDefaultTimeout(12000);
const state = () => page.evaluate(() => window.desktop.call({ type: 'state' }));
const workspace = s => s.graphicsWorkspaces.find(w => w.projectId === projectId);
const matching = w => w.tasks.filter(t => t.taskId === 'T03' && t.inputVersionIds.includes(sourceId));
const material = () => page.getByRole('navigation', { name: '제작 단계' }).getByRole('button', { name: '3 재질', exact: true }).click();
try {
  let current = await state(), space = workspace(current); assert(space);
  assert(!current.graphicsWorkspaces.some(w => w.tasks.some(t => ['running', 'submission_unknown'].includes(t.status))));
  if (!record.beforeWorkspaces) {
    assert.equal(matching(space).length, 0);
    record.beforeWorkspaces = current.graphicsWorkspaces;
    const files = new Map();
    for (const w of current.graphicsWorkspaces) for (const v of w.versions) for (const f of v.files) {
      const absolute = path.join(profile, 'projects', w.projectId, f.path); assert.equal(hash(absolute), f.sha256);
      files.set(absolute, { path: absolute, sha256: f.sha256 });
    }
    record.protectedFiles = [...files.values()]; record.startedAt = new Date().toISOString(); save();
  }
  if (!await page.getByTestId('graphics-object-' + objectId).isVisible()) {
    const all = page.getByRole('button', { name: '모든 프로젝트', exact: true }); if (await all.isVisible()) await all.click();
    await page.locator(`[data-project-id="${projectId}"]`).getByTestId('project-open').click();
  }
  await page.getByTestId('graphics-object-' + objectId).click();
  await page.getByTestId('graphics-version-' + sourceId).click();
  assert.equal(space.objects.find(o => o.id === objectId).accepted['design:part-head'], imageId);
  if (space.objects.find(o => o.id === objectId).accepted['model:part-head'] !== sourceId) {
    assert(!record.adoptIntentAt, 'Inspect uncertain adoption before retry');
    record.adoptIntentAt = new Date().toISOString(); save();
    await page.getByTestId('graphics-accept-preview').click();
    await page.waitForFunction(async ({ projectId, objectId, sourceId }) => {
      const s = await window.desktop.call({ type: 'state' });
      return s.graphicsWorkspaces.find(w => w.projectId === projectId).objects.find(o => o.id === objectId).accepted['model:part-head'] === sourceId;
    }, { projectId, objectId, sourceId });
    record.adoptedAt = new Date().toISOString(); save();
  }
  await material(); current = await state(); space = workspace(current);
  if (!matching(space).length) {
    assert(!record.prepareIntentAt, 'Inspect uncertain preparation before retry');
    assert(!space.tasks.some(t => ['awaiting_approval', 'running', 'submission_unknown'].includes(t.status)));
    const part = page.getByTestId('graphics-creation-options').locator('.gs-part').filter({ has: page.getByRole('checkbox', { name: '머리', exact: true }) });
    await part.getByRole('button', { name: /현재 파트|이 파트 설정/ }).click();
    // No new unwrap: the adopted Smart UV output is the texture input.
    for (const name of ['UV 준비', '기존 UV 유지', '텍스처 · 재질', 'AI 텍스처', '채택 이미지 사용']) {
      const button = page.getByRole('button', { name, exact: true });
      if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
      assert.equal(await button.getAttribute('aria-pressed'), 'true');
    }
    await page.getByRole('combobox', { name: '텍스처 해상도', exact: true }).selectOption('4096');
    await page.getByRole('spinbutton', { name: '후보 개수', exact: true }).fill('1');
    await page.getByRole('spinbutton', { name: '후보 개수', exact: true }).blur();
    assert.equal(await page.getByTestId('graphics-texture-reference').locator('img').getAttribute('data-version-id'), imageId);
    record.prepareIntentAt = new Date().toISOString(); save();
    await page.getByTestId('graphics-prepare').click();
    await page.waitForFunction(async ({ projectId, sourceId }) => {
      const s = await window.desktop.call({ type: 'state' });
      return s.graphicsWorkspaces.find(w => w.projectId === projectId).tasks.some(t => t.taskId === 'T03' && t.inputVersionIds.includes(sourceId));
    }, { projectId, sourceId });
  }
  current = await state(); space = workspace(current); const tasks = matching(space); assert.equal(tasks.length, 1);
  const task = tasks[0]; assert.equal(task.status, 'awaiting_approval'); assert.deepEqual(task.inputVersionIds, [sourceId, imageId]);
  assert.deepEqual(task.backendJobIds, []); assert(!task.paidApproval);
  assert.equal(task.settings.partId, 'head'); assert.equal(task.settings.textureSize, 4096); assert.equal(task.settings.count, 1);
  assert.equal(task.settings.textureReference, 'auto'); assert.equal(task.settings.surfaceOperation, 'texture'); assert.equal(task.settings.uvMode, 'keep');
  assert.equal(task.cost.provider, 'Tripo API'); assert.equal(task.cost.credits, 20);
  for (const before of record.beforeWorkspaces) {
    const after = current.graphicsWorkspaces.find(w => w.projectId === before.projectId); assert(after);
    if (before.projectId !== projectId) { assert.deepEqual(after, before); continue; }
    assert.deepEqual(after.versions, before.versions); assert.deepEqual(after.deliveries, before.deliveries); assert.deepEqual(after.tripoBudget, before.tripoBudget);
    for (const old of before.tasks) assert.deepEqual(after.tasks.find(t => t.id === old.id), old);
    assert.deepEqual(after.tasks.filter(t => !before.tasks.some(old => old.id === t.id)).map(t => t.id), [task.id]);
    for (const old of before.objects) assert.deepEqual(after.objects.find(o => o.id === old.id).accepted,
      old.id === objectId ? { ...old.accepted, 'model:part-head': sourceId } : old.accepted);
  }
  for (const f of record.protectedFiles) assert.equal(hash(f.path), f.sha256);
  const button = page.getByTestId('graphics-approve-' + task.id); await button.scrollIntoViewIfNeeded(); assert(await button.isVisible());
  await page.screenshot({ path: 'artifacts/runtime/graphics-independent-head-texture-cost.png' });
  Object.assign(record, { checkedAt: new Date().toISOString(), taskId: task.id, requestHash: task.requestHash, inputVersionIds: task.inputVersionIds,
    settings: task.settings, cost: task.cost, quoteId: task.quoteId, paidSubmissions: 0, productionGptCalls: 0, allOriginalsPreserved: true }); save();
  console.log(JSON.stringify({ taskId: task.id, status: task.status, inputs: task.inputVersionIds, cost: task.cost, settings: task.settings, preservedFiles: record.protectedFiles.length }));
} catch(error) { record.lastError = { at: new Date().toISOString(), message: String(error) }; save(); throw error; }
finally { await browser.close(); }
