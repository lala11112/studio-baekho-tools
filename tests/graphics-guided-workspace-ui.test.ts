import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultCreation } from '../shared/graphics-creation';

test('guided static workflow reviews exact input, persists draft, and keeps cost and recovery explicit', { timeout: 90000 }, async () => {
  const fs=await import('node:fs'), os=await import('node:os'), path=await import('node:path');
  const {build}=await import('esbuild'), {_electron:electron}=await import('playwright');
  const {default:binary}=await import('electron');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'graphics-guided-'));
  const creation=defaultCreation('prop');
  const object={id:'crate',name:'나무 상자',kind:'prop',createdAt:'',selectedTasks:[],instruction:'',settings:{},references:[],accepted:{'design:main':'design-old'},creation};
  const version=(id:string,label:string)=>({id,objectId:'crate',role:'design',slot:'main',label,files:[],createdAt:'2026-10-15',sourceVersionIds:[],provenance:{type:'import'},warnings:[]});
  const task={id:'review-image',objectId:'crate',taskId:'I01',createdAt:'2026-10-15',updatedAt:'2026-10-15',status:'review',inputVersionIds:[],outputVersionIds:['design-new'],settings:{count:1},instruction:'',requestHash:'review-hash',backendJobIds:[],message:'디자인 결과 준비됨',localOnly:false};
  const initial={schemaVersion:1,id:'ws',projectId:'p',revision:0,objects:[object],versions:[version('design-old','기존 채택 이미지'),version('design-new','새 디자인 후보')],tasks:[task],deliveries:[]};
  const entry=`import React from 'react';import{createRoot}from'react-dom/client';import{GraphicsStudio}from${JSON.stringify(path.resolve('src/GraphicsStudio.tsx'))};import${JSON.stringify(path.resolve('src/style.css'))};
    window.actions=[];window.desktopCommands=[];window.fixture=${JSON.stringify(initial)};window.failAction='';window.desktop={assetUrl:()=>'',call:async command=>{window.desktopCommands.push(command);if(command.type==='unity.open')return 'Unity 프로젝트가 이미 열려 있습니다.';throw Error('Unexpected desktop call')}};
    const project={schemaVersion:1,id:'p',name:'Guided fixture',style:'',height:1,unityPath:'',unityFolder:'',createdAt:'',updatedAt:'',revision:0,assets:[],parts:[],jobs:[],assemblies:[],builds:[],demo:false};
    const root=createRoot(document.getElementById('root'));window.renderFixture=()=>root.render(<GraphicsStudio project={project} workspace={structuredClone(window.fixture)} busy={false} onAction={async action=>{window.actions.push(action);if(window.failAction===action.kind)throw Error('Fixture recovery unavailable');if(action.kind==='accept'){window.fixture.objects[0].accepted['design:main']=action.versionId;window.renderFixture();}if(action.kind==='update-object'){Object.assign(window.fixture.objects[0],action.patch);}return window.fixture;}}/>);window.renderFixture();`;
  await build({stdin:{contents:entry,loader:'tsx',resolveDir:process.cwd()},bundle:true,format:'iife',outfile:path.join(root,'ui.js'),jsx:'automatic',logLevel:'silent'});
  fs.writeFileSync(path.join(root,'index.html'),'<html lang="ko"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="ui.css"></head><body style="margin:0"><div id="root"></div><script src="ui.js"></script></body></html>');
  fs.writeFileSync(path.join(root,'main.cjs'),`const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root,'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadFile(${JSON.stringify(path.join(root,'index.html'))});});`);
  const app=await electron.launch({executablePath:binary as unknown as string,args:[path.join(root,'main.cjs')]});
  try {
    const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(8000);
    const guide=page.getByTestId('graphics-guide'),primary=page.getByTestId('graphics-guide-primary');
    await page.getByTestId('graphics-object-crate').click().catch(async error=>{throw new Error(String(error)+' UI='+await page.locator('body').innerText()+' ERRORS='+errors.join(';'));});
    await guide.waitFor();
    const stages=page.getByRole('navigation',{name:'제작 단계',exact:true});
    assert.equal(await stages.getByRole('button',{name:/리깅/}).count(),0);
    assert.equal(await page.getByRole('button',{name:'움직임 추가 · 선택 사항'}).isVisible(),true);

    await page.locator('.gs-version-history > summary').click();
    await page.getByTestId('graphics-version-design-new').click();
    assert.match(await primary.innerText(),/이 이미지 사용 · 다음 설정/);
    assert.equal(await page.evaluate(()=>(window as any).fixture.objects[0].accepted['design:main']),'design-old');
    assert.equal(await page.evaluate(()=>(window as any).actions.length),0);
    await primary.click();
    await page.waitForFunction(()=>(window as any).actions.some((a:any)=>a.kind==='accept'));
    assert.equal(await page.evaluate(()=>(window as any).fixture.objects[0].accepted['design:main']),'design-new');
    assert.deepEqual(await page.evaluate(()=>(window as any).actions.map((a:any)=>a.kind)),['accept']);
    assert.match(await stages.innerText(),/모델/);
    await guide.locator('.gs-guide-inputs').getByRole('button',{name:/새 디자인 후보/}).click();
    assert.equal(await page.getByTestId('graphics-version-design-new').getAttribute('aria-pressed'),'true');
    assert.deepEqual(await page.evaluate(()=>(window as any).actions.map((a:any)=>a.kind)),['accept']);
    await page.locator('#gs-instruction').fill('표면의 나뭇결을 유지해 주세요');
    await page.waitForFunction(()=>Object.keys(localStorage).some(key=>key.includes('guided-workspace')&&localStorage.getItem(key)?.includes('표면의 나뭇결')));
    await page.reload();await guide.waitFor();
    assert.equal(await page.locator('#gs-instruction').inputValue(),'표면의 나뭇결을 유지해 주세요');
    assert.equal(await page.evaluate(()=>(window as any).actions.length),0);
    await page.evaluate(()=>{const w=window as any;w.fixture.tasks=[{...w.fixture.tasks[0],id:'cost-model',taskId:'M01',status:'awaiting_approval',inputVersionIds:['design-old'],outputVersionIds:[],requestHash:'frozen-cost',cost:{provider:'Tripo API',credits:100,basis:'고정된 모델 생성 비용',requestHash:'frozen-cost'}}];w.renderFixture();});
    await page.getByTestId('graphics-cost-cost-model').waitFor();
    assert.match(await guide.innerText(),/100 크레딧/);
    assert.equal(await primary.innerText(),'100크레딧으로 생성');
    assert.equal(await page.getByTestId('graphics-approve-cost-model').isVisible(),true);
    assert.equal(await page.evaluate(()=>(window as any).actions.length),0);
    await page.evaluate(()=>{const w=window as any;w.fixture.tasks[0]={...w.fixture.tasks[0],id:'failed-model',status:'failed',cost:undefined,message:'저장된 작업의 결과를 확인하세요'};w.failAction='recover';w.renderFixture();});
    await page.getByTestId('graphics-recover-failed-model').click();
    await page.getByRole('alert').filter({hasText:'Fixture recovery unavailable'}).waitFor();
    assert.deepEqual(await page.evaluate(()=>(window as any).actions.map((a:any)=>a.kind)),['recover']);
    assert.equal(await page.getByTestId('graphics-recover-failed-model').isEnabled(),true);

    // An imported model can continue with surface work without generating a design or another model.
    await page.evaluate(()=>{const w=window as any;
      w.actions=[];w.failAction='';w.fixture.tasks=[];
      w.fixture.versions=[{...w.fixture.versions[0],id:'imported-model',role:'model',label:'가져온 기존 상자 모델',sourceVersionIds:[],provenance:{type:'import'}}];
      w.fixture.objects[0].accepted={'model:main':'imported-model'};
      w.renderFixture();
    });
    await stages.getByRole('button',{name:'3 재질',exact:true}).click();
    assert.equal(await page.getByTestId('graphics-surface-input-model').getAttribute('data-version-id'),'imported-model');
    await page.getByRole('button',{name:'설명만 사용',exact:true}).click();
    await page.locator('#gs-instruction').fill('기존 상자의 형태를 유지하고 밝은 나뭇결을 입혀 주세요');
    assert.match(await primary.innerText(),/준비|비용/);
    assert.equal(await primary.isEnabled(),true);
    await guide.locator('.gs-guide-inputs').getByRole('button',{name:/가져온 기존 상자 모델/}).click();
    assert.equal(await stages.getByRole('button',{name:'3 재질',exact:true}).getAttribute('aria-current'),'step','Inspecting the imported source keeps the active surface settings');
    assert.equal(await page.getByTestId('graphics-version-imported-model').getAttribute('aria-pressed'),'true');
    assert.deepEqual(await page.evaluate(()=>(window as any).actions),[],'Import continuation and source inspection must not generate, prepare, submit or adopt');
    assert.deepEqual(await page.evaluate(()=>(window as any).fixture.objects[0].accepted),{'model:main':'imported-model'});

    // File preparation is not an import receipt; only the exact imported branch exposes the editor action.
    await page.evaluate(()=>{const w=window as any;w.fixture.deliveries=[{
      id:'delivery',objectId:'crate',versionIds:['imported-model'],profileFingerprint:'fixture-profile',converterVersion:'fixture',createdAt:'2026-10-15',
      destination:'Assets/Partsmith/Crate',status:'queued',files:[],warnings:[],errors:[],playbackVerified:false,
    }];w.renderFixture();});
    await stages.getByRole('button',{name:'7 Unity 전달',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'Unity에서 확인',exact:true}).count(),0,'Queued files must not claim Unity import completion');
    assert.deepEqual(await page.evaluate(()=>(window as any).desktopCommands),[]);
    await page.evaluate(()=>{const w=window as any;w.fixture.deliveries[0].status='imported';w.renderFixture();});
    await page.getByRole('button',{name:'Unity에서 확인',exact:true}).waitFor();
    assert.match(await guide.innerText(),/현재 결과 가져오기 완료/);
    await page.getByRole('button',{name:'Unity에서 확인',exact:true}).click();
    await page.waitForFunction(()=>(window as any).desktopCommands.length===1);
    assert.deepEqual(await page.evaluate(()=>(window as any).desktopCommands),[{type:'unity.open',id:'p'}]);
    assert.deepEqual(await page.evaluate(()=>(window as any).actions),[],'Opening the editor must not prepare, submit, adopt or rerun delivery');
    await page.evaluate(()=>{const w=window as any;w.fixture.deliveries[0].versionIds=['stale-model'];w.renderFixture();});
    await page.getByRole('button',{name:'Unity에서 확인',exact:true}).waitFor({state:'detached'});
    assert.deepEqual(await page.evaluate(()=>(window as any).desktopCommands),[{type:'unity.open',id:'p'}],'A stale receipt cannot reopen Unity as the current result');
    assert.deepEqual(errors,[]);
  } finally {await app.close();}
});
