// Prepare a head-only UV cost card through Partsmith. Never click paid approval.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const profile = path.join(process.env.APPDATA, 'partsmith');
const projectId = '5844e13a-7892-422b-ac3f-410fe4f59231';
const objectId = 'dedbdea6-d960-4120-b3ee-145b298a46c8';
const sourceId = '383d5b63-6576-4f43-be5f-4d23586a1bf9';
const imageId = 'a66e8746-46fd-440a-b5f5-05bd1e255e87';
const evidence = path.resolve('artifacts/runtime/graphics-independent-head-material-prepare.json');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let record = fs.existsSync(evidence) ? JSON.parse(fs.readFileSync(evidence, 'utf8')) : { schemaVersion: 1, projectId, objectId, sourceId, imageId };
for (const [key, value] of Object.entries({ projectId, objectId, sourceId, imageId })) assert.equal(record[key], value);
const save = () => { fs.mkdirSync(path.dirname(evidence), { recursive: true }); fs.writeFileSync(evidence, JSON.stringify(record, null, 2)); };
const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0];
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('index.html'));
assert(page); page.setDefaultTimeout(15000);
const state = () => page.evaluate(() => window.desktop.call({ type: 'state' }));
const workspace = state => state.graphicsWorkspaces.find(space => space.projectId === projectId);
const taskForSource = space => space.tasks.filter(task => task.taskId === 'T01' && task.settings.partId === 'head' && task.inputVersionIds.includes(sourceId));
const checked = current => {
  const space = workspace(current), object = space.objects.find(object => object.id === objectId);
  assert.equal(object.accepted['model:part-head'], sourceId); assert.equal(object.accepted['design:part-head'], imageId);
  for (const before of record.beforeWorkspaces) {
    const after = current.graphicsWorkspaces.find(space => space.projectId === before.projectId); assert(after);
    if (before.projectId !== projectId) { assert.deepEqual(after, before); continue; }
    assert.deepEqual(after.versions, before.versions); assert.deepEqual(after.deliveries, before.deliveries);
    assert.deepEqual(after.tripoBudget, before.tripoBudget);
    for (const object of before.objects) assert.deepEqual(after.objects.find(item => item.id === object.id).accepted, object.accepted);
    for (const task of before.tasks) assert.deepEqual(after.tasks.find(item => item.id === task.id), task);
    const added = after.tasks.filter(task => !before.tasks.some(old => old.id === task.id));
    assert(added.length <= 1 && added.every(task => taskForSource(after).includes(task)));
  }
  for (const file of record.protectedFiles) assert.equal(hash(file.path), file.sha256, 'Original file changed');
  return space;
};

try {
  let current = await state(), space = workspace(current); assert(space);
  assert(!current.graphicsWorkspaces.some(space => space.tasks.some(task => ['running', 'submission_unknown'].includes(task.status))));
  if (!record.beforeWorkspaces) {
    assert.equal(taskForSource(space).length, 0, 'Existing matching task requires inspection, not new preparation');
    const files = new Map();
    for (const space of current.graphicsWorkspaces) for (const version of space.versions) for (const file of version.files) {
      const absolute = path.join(profile, 'projects', space.projectId, file.path);
      assert.equal(hash(absolute), file.sha256); files.set(absolute, { path: absolute, sha256: file.sha256 });
    }
    record.beforeWorkspaces = current.graphicsWorkspaces; record.protectedFiles = [...files.values()]; record.startedAt = new Date().toISOString(); save();
  }
  checked(current);
  if (!await page.getByTestId('graphics-object-' + objectId).isVisible()) {
    await page.getByRole('button', { name: '모든 프로젝트', exact: true }).click();
    await page.locator(`[data-project-id="${projectId}"]`).getByTestId('project-open').click();
  }
  await page.getByTestId('graphics-object-' + objectId).click();
  await page.getByRole('navigation', { name: '제작 단계' }).getByRole('button', { name: '3 재질', exact: true }).click();
  await page.getByTestId('graphics-version-' + sourceId).click(); // Preview only; never adoption.
  // Selecting a model opens its owning stage; return to material settings explicitly.
  await page.getByRole('navigation', { name: '제작 단계' }).getByRole('button', { name: '3 재질', exact: true }).click();
  if (!taskForSource(space).length) {
    assert(!record.prepareIntentAt, 'Preparation outcome uncertain; inspect same task instead of repeating');
    assert(!space.tasks.some(task => ['awaiting_approval', 'running', 'submission_unknown'].includes(task.status)));
    const part = page.getByTestId('graphics-creation-options').locator('.gs-part').filter({ has: page.getByRole('checkbox', { name: '머리', exact: true }) });
    await part.getByRole('button', { name: /현재 파트|이 파트 설정/ }).click();
    for (const name of ['UV 준비', 'Tripo Smart UV']) {
      const button = page.getByRole('button', { name, exact: true });
      if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
      assert.equal(await button.getAttribute('aria-pressed'), 'true');
    }
    record.prepareIntentAt = new Date().toISOString(); save();
    await page.getByTestId('graphics-prepare').click();
    for (let attempt = 0; attempt < 100; attempt++) {
      current = await state(); space = workspace(current);
      if (taskForSource(space).length) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
  current = await state(); space = checked(current);
  const matching = taskForSource(space); assert.equal(matching.length, 1);
  const task = matching[0]; assert.equal(task.status, 'awaiting_approval'); assert.deepEqual(task.inputVersionIds, [sourceId]);
  assert.deepEqual(task.backendJobIds, []); assert(!task.paidApproval); assert.equal(task.cost.provider, 'Tripo API'); assert.equal(task.cost.credits, 20);
  assert.equal(task.settings.count, 1); assert.equal(task.settings.uvMode, 'tripo');
  const approve = page.getByTestId('graphics-approve-' + task.id); await approve.scrollIntoViewIfNeeded(); assert(await approve.isVisible());
  await page.screenshot({ path: 'artifacts/runtime/graphics-independent-head-uv-cost.png' });
  Object.assign(record, { taskId: task.id, requestHash: task.requestHash, settings: task.settings, cost: task.cost, inputVersionIds: task.inputVersionIds,
    checkedAt: new Date().toISOString(), originalsPreserved: true, acceptedUnchanged: true, oldCancelledUvUntouched: true, paidSubmissions: 0, productionGptCalls: 0 }); save();
  console.log(JSON.stringify({ taskId: task.id, status: task.status, cost: task.cost, sourceId, protectedFiles: record.protectedFiles.length, paidSubmissions: 0, productionGptCalls: 0, acceptedUnchanged: true }));
} catch (error) { record.lastError = { at: new Date().toISOString(), message: String(error) }; save(); throw error; }
finally { await browser.close(); }
