import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultCreation } from '../shared/graphics-creation';

test('automatic rig UI requires explicit orientation, keeps recovery local, and submits exact inspected island repair', { timeout: 90000 }, async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { build } = await import('esbuild'), { _electron: electron } = await import('playwright');
  const { default: binary } = await import('electron');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graphics-auto-rig-ui-'));
  const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{GraphicsAutoRig}from${JSON.stringify(path.resolve('src/GraphicsAutoRig.tsx'))};
    window.actions=[];window.previewVersionId='whole';window.view={ready:false,checked:false,readiness:[],running:false,recoverable:false,adopted:false,videos:[],checks:[],bones:[],islands:[],correctionAvailable:false};
    const version={id:'whole',objectId:'human',role:'model',slot:'main',label:'채택 전체 사람',provenance:{type:'import'},files:[{path:'source.blend',sha256:'exact-source',kind:'model'},{path:'source.glb',sha256:'preview-exact',kind:'preview'}]};
    const object={id:'human',accepted:{'model:main':'whole'}};const root=createRoot(document.getElementById('root'));
    const action=async(kind,value)=>{window.actions.push({kind,...(value===undefined?{}:{value})});};
    window.addMaterialSource=()=>{object.accepted['material:main']='material';window.extraSources=[{...version,id:'material',role:'material',label:'새 재질 모델'}];window.render();};
    window.makeSelectedAmbiguous=()=>{window.extraSources[0].files=window.extraSources[0].files.map(file=>({...file,kind:'model'}));window.render();};
    window.render=()=>root.render(<GraphicsAutoRig object={object} versions={[version,...(window.extraSources??[]),{...version,id:'unaccepted',label:'다른 후보'},{...version,id:'part',slot:'part-head'}]} view={window.view} previewVersionId={window.previewVersionId} disabled={false}
      onCheck={async()=>{await action('check');window.view={...window.view,ready:true,checked:true,readiness:['설치 확인 완료']};window.render();}}
      onRun={async draft=>{await action('start',draft);window.view={...window.view,running:true,state:'진행 중',sourceSha256:'exact-source',progress:'뼈 감지'};window.render();await new Promise(resolve=>window.finishRun=resolve);}}
      onCancel={async()=>{await action('cancel');window.finishRun();window.view={...window.view,running:false,recoverable:false,state:'작업 중단됨'};window.render();}}
      onRecover={async()=>{await action('recover');window.view={...window.view,recoverable:false,candidate:{...version,id:'rig',role:'rig',label:'자동 리그 후보'},state:'결과 검토'};window.render();}}
      onInspect={async()=>{await action('inspect');window.view={...window.view,correctionAvailable:true,highlightReady:true,bones:['spine_02','arm.L'],islands:[{mesh:'jacket',islandId:'island-7',vertices:12,vertexIndices:[0,1,2,3,4,5,6,7,8,9,10,11],bones:[{name:'arm.L',meanWeight:0.3,maxWeight:0.8}]}]};window.render();}}
      onCorrect={async selection=>{await action('repair',selection);}} onShow={version=>{window.previewVersionId=version.id;window.actions.push({kind:'show',value:version.id});window.render();}}
      onAdopt={async()=>{await action('accept');window.view={...window.view,adopted:true};window.render();}} onUnity={()=>window.actions.push({kind:'unity-settings'})}/>);window.render();`;
  await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, format: 'iife', outfile: path.join(root, 'ui.js'), jsx: 'automatic', logLevel: 'silent' });
  fs.writeFileSync(path.join(root, 'index.html'), '<html lang="ko"><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"></head><body style="margin:0"><div id="root" class="app-body" style="height:100vh"></div><script src="ui.js"></script></body></html>');
  fs.writeFileSync(path.join(root, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1000,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadFile(${JSON.stringify(path.join(root, 'index.html'))});});`);
  const app = await electron.launch({ executablePath: binary as unknown as string, args: [path.join(root, 'main.cjs')] });
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(8000);
    await page.getByTestId('graphics-auto-rig').waitFor();
    const start = page.getByTestId('auto-rig-run');
    assert.equal(await start.isDisabled(), true);
    assert.equal(await page.locator('select[aria-label="자동 리깅 원본"]').locator('option').count(), 2);
    await page.getByRole('button', { name: '설치 상태 확인' }).click();
    assert.equal(await start.isDisabled(), true);
    await page.getByLabel('모델 앞 방향').selectOption('+X');
    assert.equal(await start.isEnabled(), true);
    assert.deepEqual(await page.evaluate(() => (window as any).actions), [{ kind: 'check' }]);
    await start.click(); await page.getByRole('button', { name: '작업 중단' }).waitFor();
    assert.deepEqual(await page.evaluate(() => (window as any).actions.at(-1)), { kind: 'start', value: { versionId: 'whole', frontAxis: '+X', fingers: true } });
    await page.getByRole('button', { name: '작업 중단', exact: true }).click();
    assert.equal(await page.getByRole('button',{name:'저장된 결과만 복구'}).count(),0,'Cancelled work never offers unsupported recovery');
    await page.evaluate(()=>{const w=window as any;w.view={...w.view,recoverable:true,state:'저장된 완료 파일이 있는 실패 작업'};w.render();});
    await page.getByRole('button', { name: '저장된 결과만 복구' }).click();
    await page.getByTestId('auto-rig-review').waitFor();
    assert.match(await page.getByTestId('auto-rig-review').innerText(), /아직 사용하지 않음/);
    assert.equal(await page.evaluate(() => (window as any).actions.filter((item: any) => item.kind === 'start').length), 1);
    await page.getByText('선택 영역만 가중치 보정 · 선택 사항', { exact: true }).click();
    const repair = page.getByRole('button', { name: '선택 부위 보정 후보 만들기' });
    assert.equal(await repair.isDisabled(), true);
    await page.getByRole('button', { name: '부위·뼈 영향 검사' }).click();
    await page.getByLabel('보정 대상 부위').selectOption(JSON.stringify(['jacket', 'island-7']));
    await page.getByLabel('가중치 보정 방식').selectOption('remove-influence');
    assert.equal(await repair.isDisabled(), true);
    await page.getByLabel('보정 기준 뼈').selectOption('arm.L');
    await repair.click();
    assert.deepEqual(await page.evaluate(() => (window as any).actions.at(-1)), { kind: 'repair', value: { mesh: 'jacket', islandId: 'island-7', kind: 'remove-influence', bones: ['arm.L'] } });
    assert.equal(await page.evaluate(() => (window as any).actions.some((item: any) => item.kind === 'accept')), false);
    await page.getByTestId('auto-rig-adopt').click();
    await page.getByRole('button', { name: 'Unity 내보내기 설정', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).actions.slice(-2)), [{ kind: 'accept' }, { kind: 'unity-settings' }]);
    await page.getByText('실행 원본·설치 설정', { exact:true }).click();
    const previousActions=await page.evaluate(()=>(window as any).actions.length);
    await page.evaluate(()=>(window as any).addMaterialSource());
    await page.locator('select[aria-label="자동 리깅 원본"]').selectOption('material');
    assert.equal(await page.getByLabel('모델 앞 방향').inputValue(),'','New source requires its own orientation confirmation');
    assert.equal(await page.getByTestId('auto-rig-run-new').isDisabled(),true);
    await page.getByLabel('모델 앞 방향').selectOption('-Y');
    assert.equal(await page.evaluate(()=>(window as any).actions.length),previousActions+1,'Changing source only previews the explicitly selected source');
    assert.deepEqual(await page.evaluate(()=>(window as any).actions.at(-1)),{kind:'show',value:'material'});
    assert.equal(await page.evaluate(()=>(window as any).actions.filter((item:any)=>item.kind==='start').length),1,'Changing settings never starts another rig');
    const rerun=page.getByTestId('auto-rig-run-new');assert.equal(await rerun.isEnabled(),true);
    await rerun.click();await page.getByRole('button',{name:'작업 중단',exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>(window as any).actions.at(-1)),{kind:'start',value:{versionId:'material',frontAxis:'-Y',fingers:true}});
    assert.equal(await page.evaluate(()=>(window as any).actions.filter((item:any)=>item.kind==='start').length),2);
    assert.equal(await page.evaluate(()=>(window as any).view.candidate.id),'rig','Previous candidate remains saved');
    await page.getByRole('button',{name:'작업 중단',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'Unity 내보내기 설정',exact:true}).isVisible(),true,'Existing adoption remains available');
    const actionCount=await page.evaluate(()=>(window as any).actions.length);
    await page.evaluate(()=>(window as any).makeSelectedAmbiguous());
    await page.getByTestId('auto-rig-import-source-warning').waitFor();
    assert.equal(await page.getByTestId('auto-rig-run-new').isDisabled(),true);
    assert.equal(await page.getByLabel('모델 앞 방향').isDisabled(),true);
    assert.equal(await page.evaluate(()=>(window as any).actions.length),actionCount);
  } finally { await app.close(); }
});

test('studio makes automatic rigging primary and adoption opens Unity settings without executing export', { timeout: 90000 }, async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { build } = await import('esbuild'), { _electron: electron } = await import('playwright');
  const { default: binary } = await import('electron');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graphics-auto-rig-studio-'));
  const creation = defaultCreation('character');
  const object = { id: 'human', name: '사람', kind: 'character', createdAt: '', selectedTasks: [], instruction: '', settings: {}, references: [], accepted: { 'model:main': 'whole' }, creation };
  const version = { id: 'whole', objectId: 'human', role: 'model', slot: 'main', label: '전체 사람', createdAt: '', files: [{ path: 'source.blend', sha256: 'source-exact', kind: 'model', bytes: 100 }, { path: 'source.glb',sha256:'preview-exact',kind:'preview',bytes:100 }], sourceVersionIds: [], provenance: { type: 'import' }, warnings: [] };
  const workspace = { schemaVersion: 1, id: 'ws', projectId: 'p', revision: 0, objects: [object], versions: [version], tasks: [], deliveries: [], autoRigRuns: [] };
  const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{GraphicsStudio}from${JSON.stringify(path.resolve('src/GraphicsStudio.tsx'))};import${JSON.stringify(path.resolve('src/style.css'))};
    window.actions=[];window.fixture=${JSON.stringify(workspace)};window.desktop={assetUrl:()=>'',call:async()=>{throw Error('Unexpected desktop action')}};
    localStorage.setItem('partsmith.guided-workspace.v1:p:last-object','human');localStorage.setItem('partsmith.guided-workspace.v1:p:human',JSON.stringify({schemaVersion:1,stage:'rig',creation:${JSON.stringify(creation)},shownVersionId:'whole'}));
    const project={schemaVersion:1,id:'p',name:'AutoRig fixture',style:'',height:1,unityPath:'',unityFolder:'',createdAt:'',updatedAt:'',revision:0,assets:[],parts:[],jobs:[],assemblies:[],builds:[],demo:false};const root=createRoot(document.getElementById('root'));
    window.render=()=>root.render(<GraphicsStudio project={project} workspace={structuredClone(window.fixture)} busy={false} onAction={async action=>{window.actions.push(action);if(action.kind==='probe-auto-rig')window.fixture.autoRigReadiness={available:true,message:'準備',checkedAt:''};if(action.kind==='start-auto-rig'){window.fixture.versions.push({...window.fixture.versions[0],id:'rig-result',role:'rig',label:'自動リグ候補'});window.fixture.autoRigRuns=[{id:'run-1',objectId:'human',sourceVersionId:'whole',source:window.fixture.versions[0].files[0],operation:'rig',state:'review',createdAt:'',updatedAt:'',message:'完了',settings:{frontAxis:action.frontAxis,fingers:action.fingers},repairs:[],files:[],candidateVersionId:'rig-result'}];}if(action.kind==='accept')window.fixture.objects[0].accepted['rig:main']=action.versionId;window.render();return window.fixture;}}/>);window.render();`;
  await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, format: 'iife', outfile: path.join(root, 'ui.js'), jsx: 'automatic', logLevel: 'silent' });
  fs.writeFileSync(path.join(root, 'index.html'), '<html lang="ko"><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"></head><body style="margin:0"><div id="root" class="app-body" style="height:100vh"></div><script src="ui.js"></script></body></html>');
  fs.writeFileSync(path.join(root, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadFile(${JSON.stringify(path.join(root, 'index.html'))});});`);
  const app = await electron.launch({ executablePath: binary as unknown as string, args: [path.join(root, 'main.cjs')] });
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(8000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.getByTestId('graphics-object-human').click().catch(async error => { throw Error(String(error) + ' BODY=' + await page.locator('body').innerText() + ' ERRORS=' + errors.join(';')); });
    await page.getByTestId('graphics-auto-rig').waitFor();
    assert.equal(await page.getByTestId('graphics-guide-primary').count(), 0);
    assert.deepEqual(await page.evaluate(() => (window as any).actions), []);
    for (const width of [1280,960,800]) {
      await page.setViewportSize({width,height:1000});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const box=await page.getByTestId('auto-rig-run').boundingBox();
      assert.ok(box && box.x>=0 && box.x+box.width<=width+1 && box.y>=0 && box.y+box.height<=1001,`Fixed primary visible at ${width}: ${JSON.stringify(box)}`);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,`No horizontal page overflow at ${width}`);
    }
    await page.getByRole('button', { name: '설치 상태 확인' }).click();
    await page.getByLabel('모델 앞 방향').selectOption('+X');
    await page.getByTestId('auto-rig-run').click();
    await page.getByTestId('auto-rig-review').waitFor();
    assert.deepEqual(await page.evaluate(() => (window as any).actions), [{ kind: 'probe-auto-rig' }, { kind: 'start-auto-rig', objectId: 'human', versionId: 'whole', frontAxis: 'pos-x', fingers: true }]);
    await page.evaluate(()=>{const w=window as any;w.fixture.versions.push({...w.fixture.versions[0],id:'historical-rig',role:'rig',label:'이전 리그 후보'});w.fixture.autoRigRuns[0].inspection={islands:[],boneNames:['ONLY_NEW_BONE'],checks:[],warnings:[],humanBones:[]};w.render();});
    await page.locator('.gs-version-history > summary').click();
    await page.getByTestId('graphics-version-whole').click();
    assert.equal(await page.getByTestId('auto-rig-adopt').count(),0,'Model history preview cannot adopt an unseen rig');
    await page.getByTestId('graphics-version-historical-rig').click();
    assert.match(await page.getByTestId('auto-rig-review').innerText(),/이전 리그 후보/);
    assert.doesNotMatch(await page.getByTestId('auto-rig-review').innerText(),/自動リグ候補/);
    await page.getByText('선택 영역만 가중치 보정 · 선택 사항',{exact:true}).click();
    assert.equal(await page.getByLabel('보정 기준 뼈').locator('option').count(),1,'Historical rig never inherits latest rig bone inspection');
    await page.getByRole('button',{name:'부위·뼈 영향 검사',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>(window as any).actions.at(-1)),{kind:'inspect-auto-rig',objectId:'human',versionId:'historical-rig'});
    assert.equal(await page.getByRole('button',{name:'선택 부위 보정 후보 만들기',exact:true}).isDisabled(),true);
    await page.getByTestId('auto-rig-adopt').click();
    await page.getByRole('heading', { name: 'Unity로 가져와요', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => (window as any).actions.at(-1)), { kind: 'accept', objectId: 'human', versionId: 'historical-rig' });
    assert.equal(await page.evaluate(() => (window as any).actions.some((action: any) => ['prepare', 'export', 'approve', 'deliver'].includes(action.kind))), false);
  } finally { await app.close(); }
});
