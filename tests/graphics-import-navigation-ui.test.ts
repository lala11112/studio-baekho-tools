import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultCreation } from '../shared/graphics-creation';

test('explicit import opens its exact unadopted result; cancel and another object keep their view', {timeout: 60000}, async () => {
  const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
  const {build}=await import('esbuild'),{_electron:electron}=await import('playwright');
  const {default:binary}=await import('electron');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'graphics-import-navigation-'));
  const object=(id:string)=>({id,name:id,kind:'prop',createdAt:'',selectedTasks:[],instruction:'',settings:{},references:[],accepted:{},creation:defaultCreation('prop')});
  const initial={schemaVersion:1,id:'p',projectId:'p',revision:0,objects:[object('first'),object('second')],versions:[],tasks:[],deliveries:[]};
  const entry=`import React from'react';import{createRoot}from'react-dom/client';import{GraphicsStudio}from${JSON.stringify(path.resolve('src/GraphicsStudio.tsx'))};import${JSON.stringify(path.resolve('src/style.css'))};
  window.fixture=${JSON.stringify(initial)};window.actions=[];window.importMode='success';window.counter=0;window.desktop={assetUrl:()=>'',call:async()=>{throw Error('Unexpected desktop call')}};
  const project={schemaVersion:1,id:'p',name:'Import fixture',style:'',height:1,unityPath:'',unityFolder:'',createdAt:'',updatedAt:'',revision:0,assets:[],parts:[],jobs:[],assemblies:[],builds:[],demo:false};
  const root=createRoot(document.getElementById('root'));
  window.renderFixture=()=>root.render(<GraphicsStudio project={project} workspace={structuredClone(window.fixture)} busy={false} onAction={async action=>{
    window.actions.push(action);
    if(action.kind==='update-object')Object.assign(window.fixture.objects.find(o=>o.id===action.objectId),action.patch);
    if(action.kind==='import'){
      if(window.importMode==='deferred')await new Promise(resolve=>window.resolveImport=resolve);
      if(window.importMode!=='cancel')for(let i=0;i<(action.role==='design'?2:1);i++)window.fixture.versions.push({id:'import-'+(++window.counter),objectId:action.objectId,role:action.role,slot:'main',label:'Imported '+action.role+' '+window.counter,files:[],createdAt:'2026-10-18',sourceVersionIds:[],provenance:{type:'import'},warnings:[]});
    }
    window.renderFixture();return structuredClone(window.fixture);
  }}/>);window.renderFixture();`;
  await build({stdin:{contents:entry,loader:'tsx',resolveDir:process.cwd()},bundle:true,format:'iife',outfile:path.join(root,'ui.js'),jsx:'automatic',logLevel:'silent'});
  fs.writeFileSync(path.join(root,'index.html'),'<html lang="ko"><head><meta charset="UTF-8"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>');
  fs.writeFileSync(path.join(root,'main.cjs'),`const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root,'profile'))});app.whenReady().then(()=>new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadFile(${JSON.stringify(path.join(root,'index.html'))}));`);
  const app=await electron.launch({executablePath:binary as unknown as string,args:[path.join(root,'main.cjs')]});
  try{
    const page=await app.firstWindow();page.setDefaultTimeout(7000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    const stages=page.getByRole('navigation',{name:'제작 단계',exact:true});
    const openImport=async(role:string)=>{const detail=page.locator('.gs-import-details');if(await detail.getAttribute('open')===null)await detail.locator('summary').click();await page.getByLabel('가져올 자료의 역할').selectOption(role);await page.getByTestId('graphics-import').click();};
    const selected=async(id:string)=>{await page.getByTestId('graphics-version-'+id).waitFor({state:'attached'});assert.equal(await page.getByTestId('graphics-version-'+id).getAttribute('aria-pressed'),'true');};
    await page.getByTestId('graphics-object-first').click();
    await openImport('model');await selected('import-1');
    assert.match(await stages.locator('[aria-current="step"]').innerText(),/모델/);
    assert.match(await page.getByTestId('graphics-guide-primary').innerText(),/이 (모델|결과) 사용/);
    assert.deepEqual(await page.evaluate(()=>(window as any).fixture.objects[0].accepted),{});
    assert.deepEqual(await page.evaluate(()=>(window as any).actions.map((a:any)=>a.kind)),['update-object','import']);
    await page.evaluate(()=>{(window as any).importMode='cancel';(window as any).actions=[];});
    await openImport('design');await selected('import-1');
    assert.match(await stages.locator('[aria-current="step"]').innerText(),/모델/);
    assert.equal(await page.evaluate(()=>(window as any).fixture.versions.length),1);
    await page.evaluate(()=>{(window as any).importMode='success';});
    await openImport('material');await selected('import-2');
    assert.match(await stages.locator('[aria-current="step"]').innerText(),/재질/);
    await openImport('design');await selected('import-3');
    assert.match(await stages.locator('[aria-current="step"]').innerText(),/이미지/);
    assert.equal(await page.evaluate(()=>(window as any).fixture.versions.length),4);
    await page.evaluate(()=>{(window as any).importMode='deferred';});
    await openImport('model');await page.waitForFunction(()=>typeof(window as any).resolveImport==='function');
    // Pending import does not prevent inspection of a different object's existing work.
    await page.getByTestId('graphics-object-second').click();
    await page.evaluate(()=>{(window as any).importMode='success';(window as any).resolveImport();});
    await page.waitForFunction(()=>(window as any).fixture.versions.length===5);
    assert.equal(await page.getByTestId('graphics-object-second').getAttribute('aria-pressed'),'true');
    assert.match(await stages.locator('[aria-current="step"]').innerText(),/이미지/);
    assert.deepEqual(await page.evaluate(()=>(window as any).fixture.objects.map((o:any)=>o.accepted)),[{},{}]);
    assert.equal(await page.evaluate(()=>(window as any).actions.some((a:any)=>['accept','prepare','approve','recover'].includes(a.kind))),false);
    assert.deepEqual(errors,[]);
  }finally{await app.close();}
});
