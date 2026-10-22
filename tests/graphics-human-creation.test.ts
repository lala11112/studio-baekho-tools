import test from 'node:test';
import assert from 'node:assert/strict';
import type { GraphicsObject } from '../shared/graphics';
import { compileCreation, creationCompositionStrategy, creationPartForTask, creationSelectionProblem, creationSettings, defaultCreation, effectiveCreation, humanParts, isWholeThenSplitCreation, setHumanPartsCreation, updateCreationModelGeometry, validateCreation } from '../shared/graphics-creation';

const human = (): GraphicsObject => ({ id: 'human', name: 'Ch', kind: 'character', createdAt: '2026-10-13', selectedTasks: [], instruction: '', settings: {}, references: [], accepted: {}, creation: defaultCreation('character') });

test('whole-then-split creates the complete model from main with one total target and no part budget', () => {
  const object = human();
  object.creation = setHumanPartsCreation(object.creation!, 'whole-then-split');
  const before = structuredClone(object);
  assert.ok(isWholeThenSplitCreation(object.creation));
  assert.deepEqual(object.creation.parts.map(part => part.faceLimit), ['', '', '']);
  for (const task of ['M01', 'M02', 'M15']) {
    const result = compileCreation(object, task);
    assert.equal(result.settings.partId, undefined);
    assert.equal(result.settings.partLabel, undefined);
    assert.equal(result.settings.count, 1);
    assert.equal(result.settings.faceLimit, 5000);
    assert.equal(result.settings.model, 'P2-20260801');
    assert.equal(result.settings.quad, true);
    assert.match(result.instruction, /전체의 합계/);
    assert.doesNotMatch(result.instruction, /제작 대상 파츠만/);
  }
  assert.deepEqual(object, before);
});

test('split pipeline routes part image, UV and texture to the selected part but split and assembly to main', () => {
  const object = human();
  object.creation = setHumanPartsCreation(object.creation!, 'whole-then-split');
  object.creation.activePartId = 'hair';
  for (const task of ['I08', 'T01', 'T02', 'T03', 'T05']) {
    const result = compileCreation(object, task);
    assert.equal(result.settings.partId, 'hair');
    assert.match(result.instruction, /제작 대상 파츠만: 머리카락/);
  }
  for (const task of ['I01', 'I02', 'M07', 'M08']) {
    const result = compileCreation(object, task);
    assert.equal(creationPartForTask(object.creation, task), undefined);
    assert.equal(result.settings.partId, undefined);
    assert.deepEqual(JSON.parse(String(result.settings.requestedParts)).map((part: { id: string }) => part.id), ['head', 'body', 'hair']);
  }
  object.creation.activePartId = undefined;
  assert.match(creationSelectionProblem(object.creation, 'surface')!, /파트를 선택/);
  assert.throws(() => compileCreation(object, 'T03'), /파트를 선택/);
  object.creation.parts[2].enabled = false;
  assert.throws(() => compileCreation(object, 'M07'), /세 파트를 모두/);
});

test('legacy independent parts and imported saved targets retain their original meaning', () => {
  const object = human();
  object.creation!.attributes.composition = 'parts';
  object.creation!.parts = humanParts();
  object.creation!.activePartId = 'body';
  object.creation!.parts[1].faceLimit = 12000;
  object.creation!.parts[1].count = 3;
  object.creation!.parts[1].instruction = '보존할 의상 설명';
  const before = structuredClone(object);
  assert.equal(creationCompositionStrategy(effectiveCreation(object)), 'independent-parts');
  assert.equal(compileCreation(object, 'M01').settings.faceLimit, 12000);
  assert.equal(compileCreation(object, 'M01').settings.partId, 'body');
  assert.deepEqual(object, before);
  const split = setHumanPartsCreation(object.creation!, 'whole-then-split');
  assert.equal(split.parts[1].faceLimit, 12000);
  assert.equal(split.parts[1].count, 3);
  assert.equal(split.parts[1].instruction, '보존할 의상 설명');
  object.creation = validateCreation(JSON.parse(JSON.stringify(split)), 'character');
  assert.equal(compileCreation(object, 'M01').settings.faceLimit, 5000);
  assert.equal(compileCreation(object, 'M01').settings.count, 1);
  object.creation = setHumanPartsCreation(object.creation, 'independent-parts');
  assert.equal(compileCreation(object, 'M01').settings.faceLimit, 12000);
});

test('split geometry changes update only the whole budget and preserve individual saved targets', () => {
  const object = human();
  object.creation = setHumanPartsCreation(object.creation!, 'whole-then-split');
  object.creation.parts[1].faceLimit = 17000;
  const before = structuredClone(object.creation.parts);
  const edited = updateCreationModelGeometry(object.creation, { faceLimit: 6500 }).spec;
  assert.equal(edited.stageSettings.model!.values.faceLimit, 6500);
  assert.deepEqual(edited.parts, before);
  const changedProvider = updateCreationModelGeometry(edited, { model: 'P1-20260311', quad: false }, true).spec;
  assert.deepEqual(changedProvider.parts, before);
  const cleared = updateCreationModelGeometry(edited, { faceLimit: '' }).spec;
  assert.equal(cleared.stageSettings.model!.values.faceLimit, '');
  assert.match(creationSelectionProblem(cleared, 'model')!, /目標|목표 면 수/);
});

test('human Humanoid defaults to fingers and head-bound hair while explicit finger opt-out is preserved', () => {
  const object = human();
  object.creation!.stageSettings.rig!.values.rigType = 'humanoid';
  assert.equal(creationSettings(object, 'rig').rigFingers, true);
  const result = compileCreation(object, 'R01');
  assert.equal(result.settings.rigFingers, true);
  assert.equal(result.settings.rigHair, false);
  assert.match(result.instruction, /양손 손가락/);
  assert.match(result.instruction, /Head 본/);
  object.creation!.stageSettings.rig!.values.rigFingers = false;
  assert.equal(compileCreation(object, 'R01').settings.rigFingers, false);
  object.creation!.stageSettings.rig!.values.rigFingers = true;
  object.creation!.stageSettings.rig!.values.rigType = 'generic';
  assert.equal(compileCreation(object, 'R02').settings.rigFingers, undefined);
  object.creation!.subject = 'animal';
  object.creation!.stageSettings.rig!.values.rigType = 'humanoid';
  assert.equal(compileCreation(object, 'R01').settings.rigFingers, undefined);
});

test('actual human controls keep the total budget, selected part status and optional fingers coherent', { timeout: 60000 }, async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { build } = await import('esbuild'), { _electron: electron } = await import('playwright');
  const { default: electronBinary } = await import('electron');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graphics-human-ui-'));
  await build({ stdin: { contents: `
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';
    import{CreationOptions}from${JSON.stringify(path.resolve('src/CreationOptions.tsx'))};
    import{defaultCreation,creationSettings,creationTaskId,compileCreation}from${JSON.stringify(path.resolve('shared/graphics-creation.ts'))};
    import${JSON.stringify(path.resolve('src/graphics-studio.css'))};
    function Harness(){const[spec,setSpec]=useState(defaultCreation('character'));const[stage,setStage]=useState('model');const[disabled,setDisabled]=useState(false);
      const o={id:'o',name:'Ch',kind:'character',createdAt:'',selectedTasks:[],instruction:'',settings:{},references:[],accepted:{},creation:spec};
      const settings=creationSettings(o,stage);window.spec=spec;window.setStage=setStage;window.disable=()=>setDisabled(true);
      try{window.compiled=compileCreation(o,creationTaskId(spec,stage));}catch{window.compiled=null;}
      return <main className="graphics-studio" style={{padding:12,maxWidth:480}}><CreationOptions kind="character" stage={stage} spec={spec} settings={settings} disabled={disabled}
        partStatus={{head:'모델 채택 · UV 대기',body:'모델 채택 · UV 대기',hair:'파트 참조 준비 필요'}} onChange={setSpec}
        onSetting={(key,value)=>setSpec({...spec,stageSettings:{...spec.stageSettings,[stage]:{...spec.stageSettings[stage],values:{...settings,[key]:value}}}})}/></main>;
    }createRoot(document.getElementById('root')).render(<Harness/>);`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, format: 'iife', outfile: path.join(root, 'ui.js'), jsx: 'automatic', logLevel: 'silent' });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="ui.css"></head><body style="margin:0"><div id="root"></div><script src="ui.js"></script></body></html>');
  fs.writeFileSync(path.join(root, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:700,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadFile(${JSON.stringify(path.join(root, 'index.html'))});});`);
  const app = await electron.launch({ executablePath: electronBinary as unknown as string, args: [path.join(root, 'main.cjs')] });
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(8000);
    await page.getByRole('button', { name: '전체 제작 후 3파트 분리', exact: true }).click();
    const count = page.getByRole('spinbutton', { name: '목표 면 수', exact: true });
    assert.equal(await count.inputValue(), '5000');
    assert.equal(await page.getByLabel('파트 모델 후보 수', { exact: true }).count(), 0);
    const hair = page.locator('.gs-part').filter({ has: page.getByRole('checkbox', { name: '머리카락', exact: true }) });
    await hair.getByRole('button', { name: '이 파트 설정', exact: true }).click();
    assert.equal(await count.inputValue(), '5000');
    assert.equal(await page.evaluate(() => (window as any).compiled.settings.partId), undefined);
    assert.equal(await hair.getByText('파트 참조 준비 필요', { exact: true }).count(), 1);
    for (const width of [640, 360, 300]) {
      await page.setViewportSize({ width, height: 1000 });
      const overflow = await page.getByRole('region', { name: '인간형 파트 제작 순서' }).evaluate(el => el.scrollWidth > el.clientWidth);
      assert.equal(overflow, false);
    }
    await page.evaluate(() => (window as any).setStage('surface'));
    await page.getByRole('button', { name: 'UV 준비', exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).compiled.settings.partId), 'hair');
    await page.evaluate(() => (window as any).setStage('assembly'));
    await page.getByRole('button', { name: '빠진 면 보완', exact: true }).click();
    const repair = page.getByRole('region', { name: '빠진 면 보완 범위', exact: true });
    assert.equal(await repair.isVisible(), true);
    assert.match(await repair.innerText(), /기존 면·정점·UV·재질 보존/);
    assert.equal(await page.getByRole('spinbutton', { name: '추가 면 상한', exact: true }).inputValue(), '1500');
    await page.getByRole('spinbutton', { name: '추가 면 상한', exact: true }).fill('');
    assert.equal(await page.evaluate(() => (window as any).spec.stageSettings.assembly.values.repairMaxAddedFaces), '');
    assert.equal(await page.evaluate(() => (window as any).compiled), null);
    await page.getByRole('button', { name: '빠진 면 보완', exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).spec.stageSettings.assembly.values.assemblyMode), '');
    assert.equal(await repair.count(), 0);
    await page.evaluate(() => (window as any).setStage('rig'));
    await page.getByRole('button', { name: 'Humanoid · 사람형', exact: true }).click();
    const fingers = page.getByRole('checkbox', { name: '손가락 본 · 양손', exact: true });
    assert.equal(await fingers.isChecked(), true);
    await fingers.uncheck(); assert.equal(await page.evaluate(() => (window as any).compiled.settings.rigFingers), false);
    await page.getByRole('button', { name: 'Generic · 동물/기타', exact: true }).click(); assert.equal(await fingers.count(), 0);
    await page.getByRole('button', { name: 'Humanoid · 사람형', exact: true }).click(); assert.equal(await fingers.isChecked(), false);
    await page.evaluate(() => (window as any).disable());
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[aria-label="손가락 본 · 양손"]')?.disabled);
    assert.equal(await fingers.isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
});
