/** Actual app buttons on a disposable existing-parts copy. Each command is explicit, never retries a task. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { _electron as electron } from 'playwright';

const out = path.resolve('artifacts/runtime/qa-20261018-parts-keep-app');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const fixture = read(path.join(out, 'fixture.json')), file = path.join(out, 'report.json');
const report = fs.existsSync(file) ? read(file) : { events: [], operations: {}, paid: 0, GPT: 0, AI: 0, osInput: 0 };
const command = process.argv[2];
assert(['assembly', 'adopt', 'uv', 'material', 'reassembly', 'restart'].includes(command));
const save = () => fs.writeFileSync(file, JSON.stringify(report, null, 2));
const env = { ...process.env, PARTSMITH_DATA: fixture.profile, PARTSMITH_DEV: '' }; delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.PARTSMITH_QA_EXE ?? path.resolve('release/0.7.0-preview.39/win-unpacked/Partsmith.exe');
const app = await electron.launch({ executablePath, args: [], env });
let page;
try {
  report.package = await app.evaluate(({ app, session, BrowserWindow }) => {
    global.qaExternal = []; global.fetch = async (...args) => { global.qaExternal.push(String(args[0])); throw Error('QA external forbidden'); };
    session.defaultSession.webRequest.onBeforeRequest((r, cb) => cb({ cancel: /^https?:/.test(r.url) }));
    for (const w of BrowserWindow.getAllWindows()) { w.showInactive(); w.webContents.setBackgroundThrottling(false); }
    return { version: app.getVersion(), packaged: app.isPackaged, data: app.getPath('userData') };
  });
  page = await app.firstWindow(); page.setDefaultTimeout(12000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = () => page.evaluate(() => window.desktop.call({ type: 'state' }));
  const ws = async () => (await state()).graphicsWorkspaces.find(w => w.projectId === fixture.projectId);
  const wait = async (predicate, label) => {
    const end = Date.now() + 240000;
    while (Date.now() < end) { const w = await ws(); if (predicate(w)) return w; await new Promise(r => setTimeout(r, 350)); }
    throw Error('Timed out observing same state: ' + label);
  };
  const click = async (locator, label) => { await locator.scrollIntoViewIfNeeded(); await locator.click(); report.events.push({ command, label, at: new Date().toISOString() }); save(); };
  const capture = async label => {
    const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    fs.writeFileSync(path.join(out, label + '.png'), Buffer.from(b64, 'base64'));
  };
  const choice = async (group, name) => { const b = page.getByRole('group', { name: group, exact: true }).getByRole('button', { name, exact: true }); if (await b.getAttribute('aria-pressed') !== 'true') await click(b, group + ':' + name); };
  const history = async id => {
    const d = page.locator('.gs-version-history'); if (await d.getAttribute('open') === null) await click(d.locator('summary'), 'history');
    await click(page.getByTestId('graphics-version-' + id), 'preview ' + id);
  };
  const adopt = async id => {
    await history(id); const button = page.getByTestId('graphics-accept-version'), d = button.locator('xpath=ancestor::details[1]');
    if (await d.getAttribute('open') === null) await click(d.locator('summary').first(), 'result details');
    await click(button, 'explicit TEST adoption ' + id);
    await wait(w => Object.values(w.objects[0].accepted).includes(id), 'adopted exact candidate');
  };
  const baseline = structuredClone(await ws());
  await click(page.locator(`[data-project-id="${fixture.projectId}"]`).getByTestId('project-open'), 'open isolated project');
  await click(page.getByTestId('graphics-object-' + fixture.objectId), 'open isolated object');
  if (command === 'assembly' || command === 'reassembly') {
    await click(page.getByRole('button', { name: '4 조립·수정', exact: true }), 'assembly stage');
    await choice('이번에 할 작업', '채택 파트 조립');
    await choice('조립 배치', '기존 배치 유지 · 로컬');
  } else if (command === 'uv' || command === 'material') {
    await click(page.getByRole('button', { name: '3 재질', exact: true }), 'surface stage');
    // The fixture and all previous operations keep head as the active part.
    assert.equal((await ws()).objects[0].creation.activePartId, 'head');
    await choice('이번에 할 작업', command === 'uv' ? 'UV 준비' : '텍스처 · 재질');
    await choice(command === 'uv' ? 'UV 방식' : '표면 제작 방식', command === 'uv' ? '기존 UV 유지' : '로컬 기본 재질');
    if (command === 'material') {
      const d = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: '상세 설정 · 기본 재질 수치' }) });
      if (await d.getAttribute('open') === null) await click(d.locator('summary').first(), 'material values');
      await page.getByLabel('기본 색', { exact: true }).fill('#eaaf8c');
    }
  }
  if (['assembly', 'reassembly', 'uv', 'material'].includes(command)) {
    assert(!report.operations[command], 'Already dispatched; inspect the saved task, never repeat');
    const taskId = command.endsWith('assembly') ? 'M08' : command === 'uv' ? 'T02' : 'T05';
    const before = structuredClone(await ws()), known = new Set(before.tasks.map(t => t.id));
    await wait(w => !w.tasks.some(t => t.status === 'running'), 'existing checks terminal');
    const prepareNew = page.getByRole('button', { name: /^새 (모델|UV|재질|텍스처|작업) 준비$/ });
    await click(await prepareNew.count() ? prepareNew.last() : page.getByTestId('graphics-guide-primary'), 'prepare local ' + taskId);
    const prepared = await wait(w => w.tasks.some(t => !known.has(t.id) && t.taskId === taskId), 'prepared task');
    const task = prepared.tasks.find(t => !known.has(t.id) && t.taskId === taskId);
    report.operations[command] = { before, prepared: task }; save();
    assert.equal(task.status, 'awaiting_approval', task.message); assert.equal(task.cost.credits, 0); assert(task.localOnly); assert.deepEqual(task.backendJobIds, []);
    if (taskId === 'M08') { assert.equal(task.settings.assemblyPlacement, 'keep'); assert.equal(task.inputVersionIds.length, 3); }
    else assert.deepEqual(task.inputVersionIds, [before.objects[0].accepted['model:part-head']]);
    await capture(command + '-approval');
    await click(page.getByTestId('graphics-approve-' + task.id), 'approve exact free local ' + task.id);
    const done = await wait(w => ['review', 'failed', 'blocked'].includes(w.tasks.find(t => t.id === task.id)?.status), 'same task terminal');
    const finished = done.tasks.find(t => t.id === task.id); report.operations[command].finished = finished; save();
    assert.equal(finished.status, 'review', finished.message);
    assert.deepEqual(done.objects[0].accepted, before.objects[0].accepted, 'No automatic adoption');
    report.operations[command].versions = finished.outputVersionIds.map(id => done.versions.find(v => v.id === id));
    await capture(command + '-review');
  } else if (command === 'adopt') {
    const step = process.argv[3]; assert(report.operations[step]?.finished?.status === 'review');
    const versions = report.operations[step].versions, main = versions.find(v => v.slot === 'main') ?? versions[0];
    await adopt(main.id);
    const after = await ws();
    for (const version of versions) assert.equal(after.objects[0].accepted[version.role + ':' + version.slot], version.id);
    report.operations[step].testAdopted = after.objects[0].accepted;
    await capture(step + '-test-adopted');
  } else {
    const id = report.operations.reassembly?.versions.find(v => v.slot === 'main')?.id ?? report.operations.assembly.versions.find(v => v.slot === 'main').id;
    await history(id); await wait(w => !w.tasks.some(t => t.status === 'running'), 'restart idle');
    assert.deepEqual(await ws(), baseline); await capture('restart-exact-result');
    report.restart = { at: new Date().toISOString(), exact: true, accepted: baseline.objects[0].accepted };
  }
  const final = await ws();
  for (const v of baseline.versions) assert.deepEqual(final.versions.find(x => x.id === v.id), v);
  for (const v of final.versions) for (const f of v.files) assert.equal(sha(path.join(fixture.profile, 'projects', fixture.projectId, f.path)), f.sha256);
  for (const f of fixture.protectedFiles) assert.equal(sha(f.path), f.sha256);
  assert.equal(sha(fixture.sourceWorkspace), fixture.workspaceSha);
  assert.deepEqual(await app.evaluate(() => global.qaExternal), []);
  assert.equal((await state()).projects.find(p => p.id === fixture.projectId).jobs.length, 0);
  report.final = final; report.lastVerified = new Date().toISOString(); save();
  console.log(JSON.stringify({ command, passed: true, task: report.operations[command]?.finished?.id, versions: final.versions.length }));
} catch (error) {
  report.failures ??= []; report.failures.push({ command, at: new Date().toISOString(), error: String(error), body: await page?.locator('body').innerText().catch(() => '') }); save();
  if (page) await page.screenshot({ path: path.join(out, 'failure-' + command + '.png'), fullPage: true }).catch(() => {});
  throw error;
} finally { await app.close(); }
