import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const profile = path.join(process.env.APPDATA, 'partsmith');
const projectId = '5844e13a-7892-422b-ac3f-410fe4f59231';
const sourceId = '383d5b63-6576-4f43-be5f-4d23586a1bf9';
const resultId = 'eefacd21-954b-49b4-970e-f1e79e682a89';
const file = path.resolve('artifacts/runtime/graphics-head-uv-preview-live.json');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const record = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const save = () => fs.writeFileSync(file, JSON.stringify(record, null, 2));
const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0];
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('index.html'));
assert(page);
const events = [];
page.on('console', message => { if (['error', 'warning'].includes(message.type())) events.push({ type: message.type(), message: message.text() }); });
page.on('pageerror', error => events.push({ type: 'pageerror', message: String(error) }));
page.on('requestfailed', request => events.push({ type: 'failed', url: request.url(), error: request.failure() }));
page.on('response', response => { if (response.status() >= 400) events.push({ type: 'response', url: response.url(), status: response.status() }); });
try {
  const state = await page.evaluate(() => window.desktop.call({ type: 'state' }));
  assert(!state.graphicsWorkspaces.some(s => s.tasks.some(t => ['running', 'submission_unknown'].includes(t.status))));
  assert(!state.projects.some(p => p.jobs.some(j => ['queued', 'running', 'submitting', 'processing', 'downloading'].includes(j.status))));
  assert(!(state.workbenches ?? []).some(w => w.activeJobId || w.jobs.some(j => j.status === 'running')));
  assert(!(state.productionRuns ?? []).some(r => r.status === 'running'));
  if (!record.beforeWorkspaces) {
    record.beforeWorkspaces = state.graphicsWorkspaces;
    const files = new Map();
    for (const space of state.graphicsWorkspaces) for (const version of space.versions) for (const item of version.files) {
      const absolute = path.join(profile, 'projects', space.projectId, item.path);
      assert.equal(hash(absolute), item.sha256); files.set(absolute, { path: absolute, sha256: item.sha256 });
    }
    record.protectedFiles = [...files.values()]; save();
  }
  record.projectFiles ??= state.projects.map(p => {
    const file = path.join(profile, 'projects', p.id, 'project.json');
    return { path: file, sha256: hash(file) };
  }); save();
  const space = state.graphicsWorkspaces.find(s => s.projectId === projectId);
  if (process.argv.includes('--select') && !await page.getByTestId('graphics-version-' + sourceId).isVisible()) {
    const all = page.getByRole('button', { name: '모든 프로젝트', exact: true });
    if (await all.isVisible()) await all.click();
    await page.locator(`[data-project-id="${projectId}"]`).getByTestId('project-open').click();
    await page.getByTestId('graphics-object-dedbdea6-d960-4120-b3ee-145b298a46c8').click();
  }
  const probes = [];
  for (const id of [resultId, sourceId]) {
    const version = space.versions.find(v => v.id === id); assert(version);
    const glb = version.files.find(f => f.path.endsWith('.glb')); assert(glb);
    const fetched = await page.evaluate(async ({ projectId, path }) => {
      const url = window.desktop.assetUrl(projectId, path);
      try { const response = await fetch(url); const bytes = await response.arrayBuffer(); return { url, status: response.status, bytes: bytes.byteLength, header: [...new Uint8Array(bytes.slice(0, 12))] }; }
      catch(error) { return { url, error: String(error) }; }
    }, { projectId, path: glb.path });
    const bytes = fs.readFileSync(path.join(profile, 'projects', projectId, glb.path));
    const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString().trim());
    probes.push({ id, fetched, buffers: json.buffers, images: json.images, extensions: json.extensionsRequired });
    if (process.argv.includes('--select')) {
      await page.getByTestId('graphics-version-' + id).click();
      if (process.argv.includes('--verify')) await page.locator('.viewport').getByText(/메시·부품 검사 · 1개 · 10,314 삼각형/).waitFor();
      else await page.waitForTimeout(1800);
      probes.at(-1).text = await page.locator('.viewport').innerText();
      if (process.argv.includes('--verify')) assert(!probes.at(-1).text.includes('읽지 못했습니다'));
      await page.getByTestId('graphics-preview').scrollIntoViewIfNeeded();
      await page.screenshot({ path: 'artifacts/runtime/graphics-head-uv-preview-' + (id === sourceId ? 'source' : 'result') + '.png' });
    }
  }
  const after = await page.evaluate(() => window.desktop.call({ type: 'state' }));
  assert.deepEqual(after.graphicsWorkspaces, record.beforeWorkspaces);
  for (const entry of [...record.protectedFiles, ...record.projectFiles]) assert.equal(hash(entry.path), entry.sha256);
  if (process.argv.includes('--verify')) {
    assert.deepEqual(events, []);
    await page.getByRole('navigation', { name: '제작 단계' }).getByRole('button', { name: '3 재질', exact: true }).click();
    await page.getByTestId('graphics-open-completed-result').click();
    assert.equal(await page.getByTestId('graphics-version-' + resultId).getAttribute('aria-pressed'), 'true');
    await page.locator('.viewport').getByText(/메시·부품 검사 · 1개 · 10,314 삼각형/).waitFor();
    await page.getByTestId('graphics-preview').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'artifacts/runtime/graphics-head-uv-preview-final.png' });
    record.finalVerifiedAt = new Date().toISOString();
  }
  record.runs ??= []; record.runs.push({ at: new Date().toISOString(), probes, events }); save();
  if (process.argv.includes('--close')) await page.close();
  console.log(JSON.stringify({ probes, events, filesPreserved: record.protectedFiles.length }));
} finally { await browser.close(); }
