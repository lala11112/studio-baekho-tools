import { revealGraphicsControl, openGraphicsInspection } from './graphics-ui-disclosures';
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultCreation, setHumanPartsCreation } from '../shared/graphics-creation';

test('later cancelled paid UV request keeps the completed part result visible and opens it without producing or adopting', { timeout: 60000 }, async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { build } = await import('esbuild'), { _electron: electron } = await import('playwright');
  const { default: electronBinary } = await import('electron');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graphics-completed-ui-'));
  const creation = setHumanPartsCreation(defaultCreation('character'), 'whole-then-split');
  creation.stageSettings.surface!.values = { count: 1, surfaceOperation: 'uv', uvMode: 'tripo' };
  const object = { id: 'human', name: 'Ch', kind: 'character', createdAt: '', selectedTasks: [], instruction: '', settings: {}, references: [], accepted: { 'model:part-head': 'head-source' }, creation };
  const version = (id: string, label: string) => ({ id, objectId: object.id, role: 'model', slot: 'part-head', label, files: [], createdAt: '', sourceVersionIds: [], provenance: { type: 'tripo' }, warnings: [] });
  const completed = { id: 'completed-uv', objectId: object.id, taskId: 'T01', createdAt: '2026-10-14T01:00:00Z', updatedAt: '2026-10-14T01:00:00Z', status: 'review', inputVersionIds: ['head-source'], outputVersionIds: ['uv-result'], settings: { partId: 'head', partLabel: '머리', count: 1 }, instruction: '', requestHash: 'same-request', backendJobIds: ['completed-remote-job'], message: '머리 UV 완료', localOnly: false, paidApproval: { provider: 'Tripo API', credits: 20, requestHash: 'same-request', approvedAt: '' } };
  const cancelled = { ...completed, id: 'cancelled-uv', createdAt: '2026-10-14T02:00:00Z', updatedAt: '2026-10-14T02:00:00Z', status: 'cancelled', outputVersionIds: [], backendJobIds: ['later-remote-job'], message: '사용자가 추적을 중지했습니다.' };
  const initial = { schemaVersion: 1, id: 'ws', projectId: 'p', revision: 0, objects: [object], versions: [version('head-source', '채택한 머리'), version('uv-result', '완료된 머리 UV')], tasks: [completed, cancelled], deliveries: [] };
  const entry = `
    import React from 'react';import{createRoot}from'react-dom/client';
    import{GraphicsStudio}from${JSON.stringify(path.resolve('src/GraphicsStudio.tsx'))};
    import${JSON.stringify(path.resolve('src/style.css'))};
    window.desktop={assetUrl:()=>'',call:()=>{throw Error('Unexpected desktop request')}};window.actions=[];
    const project={schemaVersion:1,id:'p',name:'Completed UI fixture',style:'',height:1,unityPath:'',unityFolder:'',createdAt:'',updatedAt:'',revision:0,assets:[],parts:[],jobs:[],assemblies:[],builds:[],demo:false};
    window.workspace=${JSON.stringify(initial)};
    const action=async value=>{window.actions.push(value);throw Error('Production forbidden in fixture');};
    createRoot(document.getElementById('root')).render(<GraphicsStudio project={project} workspace={window.workspace} busy={false} onAction={action}/>);`;
  await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, format: 'iife', outfile: path.join(root, 'ui.js'), jsx: 'automatic', logLevel: 'silent' });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="ui.css"></head><body style="margin:0"><div id="root"></div><script src="ui.js"></script></body></html>');
  fs.writeFileSync(path.join(root, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadFile(${JSON.stringify(path.join(root, 'index.html'))});});`);
  const app = await electron.launch({ executablePath: electronBinary as unknown as string, args: [path.join(root, 'main.cjs')] });
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(8000);
    await page.getByRole('navigation', { name: '제작 단계', exact: true }).getByRole('button', { name: '3 재질', exact: true }).click();
    await revealGraphicsControl(page.getByTestId('graphics-current-task-completed-uv'));
    const result = page.getByTestId('graphics-current-task-completed-uv'), stopped = page.getByTestId('graphics-current-task-cancelled-uv');
    assert.equal(await result.isVisible(), true);
    assert.equal(await stopped.isVisible(), true);
    assert.match(await result.innerText(), /머리.*완료 · 결과 확인/);
    assert.match(await stopped.innerText(), /추적 중지 · 원격 상태 확인 필요/);
    assert.match(await stopped.innerText(), /과금 취소를 뜻하지 않습니다/);
    assert.equal(await stopped.getByRole('button', { name: '완료 · 결과 보기', exact: true }).count(), 0);
    assert.equal(await page.getByTestId('graphics-prepare').innerText(), '새 작업 준비');
    assert.match(await page.getByTestId('graphics-guide').innerText(), /화면 이동·후보 비교만으로 생성하거나 과금하지 않습니다/);
    await result.getByRole('button', { name: '완료 · 결과 보기', exact: true }).click();
    assert.equal(await page.getByTestId('graphics-version-uv-result').getAttribute('aria-pressed'), 'true');
    await result.getByRole('button', { name: '완료 · 결과 보기', exact: true }).click();
    assert.equal(await page.getByTestId('graphics-version-uv-result').getAttribute('aria-pressed'), 'true');
    await revealGraphicsControl(page.locator('.gs-version-detail > summary'));
    assert.match(await page.locator('.gs-version-detail').innerText(), /완료된 머리 UV/);
    await result.getByRole('button', { name: '기록', exact: true }).click();
    const history = page.getByRole('dialog', { name: '작업 기록', exact: true });
    await history.waitFor();
    assert.equal(await history.locator('.gs-history > details').count(), 2);
    assert.equal(await page.evaluate(() => (window as any).actions.length), 0);
    assert.deepEqual(await page.evaluate(() => (window as any).workspace.objects[0].accepted), object.accepted);
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
});
