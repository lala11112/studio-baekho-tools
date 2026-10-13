import test from 'node:test';
import assert from 'node:assert/strict';
import type { GraphicsObject } from '../shared/graphics';
import { changeCreationAssemblyMode, compileCreation, creationSelectionProblem, creationTaskId, defaultCreation, selectMissingSurfaceRepair, selectModelRevision, setHumanPartsCreation } from '../shared/graphics-creation';

const human = (): GraphicsObject => ({ id: 'human', name: 'Ch', kind: 'character', createdAt: '', selectedTasks: [], instruction: '', settings: {}, references: [], accepted: { 'model:main': 'original', 'model:part-head': 'older-head' }, creation: setHumanPartsCreation(defaultCreation('character'), 'whole-then-split') });
const source = { id: 'repaired-head-candidate', slot: 'part-head', role: 'model' as const };

test('candidate correction freezes the displayed source without adopting it or inheriting mesh selection', () => {
  const object = human();
  object.creation = selectMissingSurfaceRepair(object.creation!, { ...source, id: 'old-split' }, { sourceId: 'old-mesh-id' });
  const before = structuredClone(object), spec = selectModelRevision(object.creation, source);
  assert.deepEqual(object, before);
  assert.equal(spec.activePartId, 'head');
  assert.equal(creationTaskId(spec, 'assembly'), 'M05');
  const compiled = compileCreation({ ...object, creation: spec }, 'M05');
  assert.equal(compiled.settings.sourceVersionId, source.id);
  assert.equal(compiled.settings.editSourceMode, 'candidate');
  assert.equal(compiled.settings.editSourceSlot, 'part-head');
  assert.equal(compiled.settings.count, 1);
  assert.equal(compiled.settings.partId, 'head');
  for (const key of ['meshSelectionVersionId', 'editMeshIds', 'editMeshNames']) assert.equal(compiled.settings[key], undefined);
  assert.deepEqual(object.accepted, { 'model:main': 'original', 'model:part-head': 'older-head' });
  assert.equal(selectModelRevision(object.creation!, { ...source, role: 'material' }).stageSettings.assembly!.values.sourceVersionId, source.id);
});

test('candidate correction stops when the selected part or composition changes and rejects unsupported sources', () => {
  const object = human();
  object.creation = selectModelRevision(object.creation!, source);
  object.creation.activePartId = 'body';
  assert.match(creationSelectionProblem(object.creation, 'assembly')!, /원본과 현재 파트/);
  assert.throws(() => compileCreation(object, 'M05'), /원본과 현재 파트/);
  object.creation.activePartId = 'head';
  object.creation.attributes.composition = 'whole';
  assert.throws(() => compileCreation(object, 'M05'), /원본과 현재 파트/);
  assert.throws(() => selectModelRevision(human().creation!, { ...source, role: 'rig' }), /모델 또는 재질/);
  assert.throws(() => selectModelRevision(human().creation!, { ...source, slot: 'part-unknown' }), /해당하는 파트/);
  assert.throws(() => selectModelRevision(human().creation!, { ...source, slot: 'main' }), /분리된 파트/);
  const whole = selectModelRevision(defaultCreation('prop'), { ...source, slot: 'main' });
  assert.equal(whole.activePartId, undefined);
  assert.equal(creationSelectionProblem(whole, 'assembly'), undefined);
});

test('deselecting or changing the operation clears candidate authority while stage changes retain it', () => {
  const spec = selectModelRevision(human().creation!, source), before = structuredClone(spec);
  for (const mode of ['', 'repair', 'partial', 'assemble', 'separate']) {
    const next = changeCreationAssemblyMode(spec, mode);
    assert.equal(next.stageSettings.assembly!.values.assemblyMode, mode);
    for (const key of ['editSourceMode', 'editSourceSlot', 'sourceVersionId']) assert.equal(next.stageSettings.assembly!.values[key], undefined);
    if (mode === '') assert.equal(creationTaskId(next, 'assembly'), '');
  }
  assert.deepEqual(spec, before);
  assert.equal(changeCreationAssemblyMode(spec, 'correct').stageSettings.assembly!.values.sourceVersionId, source.id);
  const repair = selectMissingSurfaceRepair(spec, source);
  assert.equal(creationTaskId(repair, 'assembly'), 'M09');
  assert.equal(repair.stageSettings.assembly!.values.editSourceMode, undefined);
  assert.equal(repair.stageSettings.assembly!.values.editSourceSlot, undefined);
  assert.equal(repair.stageSettings.assembly!.values.meshSelectionVersionId, source.id);
});

test('actual result button selects an unadopted correction source and prevents implicit production or cross-part preparation', { timeout: 60000 }, async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { build } = await import('esbuild'), { _electron: electron } = await import('playwright');
  const { default: electronBinary } = await import('electron');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graphics-revision-ui-'));
  const object = human(), createdAt = '2026-10-14T00:00:00Z';
  const version = (id: string, slot: string, label: string) => ({ id, objectId: object.id, role: 'model', slot, label, files: [], createdAt, sourceVersionIds: [], provenance: { type: 'codex' }, warnings: [] });
  const initial = { schemaVersion: 1, id: 'ws', projectId: 'p', revision: 0, objects: [object], versions: [version('original', 'main', '전체 원본'), version('older-head', 'part-head', '이전 머리'), version(source.id, source.slot, '보완한 머리 후보')], tasks: [], deliveries: [] };
  const entry = `
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';
    import{GraphicsStudio}from${JSON.stringify(path.resolve('src/GraphicsStudio.tsx'))};
    import${JSON.stringify(path.resolve('src/style.css'))};
    window.desktop={assetUrl:()=>'',call:()=>{throw Error('Unexpected desktop request')}};window.actions=[];
    const project={schemaVersion:1,id:'p',name:'Revision UI fixture',style:'',height:1,unityPath:'',unityFolder:'',createdAt:'',updatedAt:'',revision:0,assets:[],parts:[],jobs:[],assemblies:[],builds:[],demo:false};
    function Harness(){const[workspace,setWorkspace]=useState(${JSON.stringify(initial)});window.workspace=workspace;
      const action=async value=>{window.actions.push(value);if(value.kind!=='update-object')throw Error('Production forbidden in fixture');const next=structuredClone(workspace);Object.assign(next.objects[0],value.patch);setWorkspace(next);return next;};
      return <GraphicsStudio project={project} workspace={workspace} busy={false} onAction={action}/>;
    }createRoot(document.getElementById('root')).render(<Harness/>);`;
  await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, format: 'iife', outfile: path.join(root, 'ui.js'), jsx: 'automatic', logLevel: 'silent' });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="ui.css"></head><body style="margin:0"><div id="root"></div><script src="ui.js"></script></body></html>');
  fs.writeFileSync(path.join(root, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadFile(${JSON.stringify(path.join(root, 'index.html'))});});`);
  const app = await electron.launch({ executablePath: electronBinary as unknown as string, args: [path.join(root, 'main.cjs')] });
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(8000);
    await page.getByTestId(`graphics-version-${source.id}`).click();
    await page.getByRole('button', { name: '이 결과 더 보정', exact: true }).click();
    assert.equal(await page.getByRole('region', { name: '선택 결과 추가 보정', exact: true }).isVisible(), true);
    assert.match(await page.getByLabel('실행 설정 요약', { exact: true }).innerText(), /보정 원본.*보완한 머리 후보/);
    assert.equal(await page.evaluate(() => (window as any).actions.length), 0);
    await page.getByRole('button', { name: '옵션 저장', exact: true }).click();
    await page.waitForFunction(() => (window as any).actions.length === 1);
    const saved = await page.evaluate(() => (window as any).workspace.objects[0]);
    assert.equal(saved.creation.stageSettings.assembly.values.sourceVersionId, source.id);
    assert.equal(saved.creation.stageSettings.assembly.values.editSourceMode, 'candidate');
    assert.deepEqual(saved.accepted, object.accepted);
    const body = page.locator('.gs-part').filter({ has: page.getByRole('checkbox', { name: '몸통', exact: true }) });
    await body.getByRole('button', { name: '이 파트 설정', exact: true }).click();
    assert.equal(await page.getByTestId('graphics-prepare').isDisabled(), true);
    assert.match(await page.getByLabel('현재 단계 실행', { exact: true }).innerText(), /원본과 현재 파트/);
    await page.getByRole('button', { name: '이 결과 더 보정', exact: true }).click();
    await page.getByRole('button', { name: '빠진 면 보완', exact: true }).click();
    assert.equal(await page.getByRole('region', { name: '선택 결과 추가 보정', exact: true }).count(), 0);
    assert.equal(await page.getByTestId('graphics-prepare').isDisabled(), true);
    await page.getByRole('button', { name: '이 파트 빠진 면 보완', exact: true }).click();
    await page.getByRole('button', { name: '이 결과 더 보정', exact: true }).click();
    await page.getByRole('button', { name: '전체 비율·모양 수정', exact: true }).click();
    assert.equal(await page.getByTestId('graphics-prepare').isDisabled(), true);
    assert.equal(await page.evaluate(() => (window as any).actions.length), 1);
    assert.deepEqual(await page.evaluate(() => (window as any).workspace.objects[0].accepted), object.accepted);
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
});
