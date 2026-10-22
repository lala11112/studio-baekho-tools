import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultCreation } from '../shared/graphics-creation';
import { buildWorkbenchGlb } from './fixtures/workbench-glb';

test('imported FBX preview is explicit, deduplicates pending clicks, retries failures and preserves adoption', { timeout: 90000 }, async () => {
  const fs=await import('node:fs'), os=await import('node:os'), path=await import('node:path');
  const {build}=await import('esbuild'), {_electron:electron}=await import('playwright');
  const {default:binary}=await import('electron');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'graphics-import-preview-ui-'));
  const source={path:'imports/source.fbx',sha256:'exact-original-fbx',bytes:123,kind:'model'};
  const object={id:'crate',name:'가져온 상자',kind:'prop',createdAt:'',selectedTasks:[],instruction:'',settings:{},references:[],accepted:{'model:main':'existing'},creation:defaultCreation('prop')};
  const version=(id:string)=>({id,objectId:object.id,role:'model',slot:'main',label:id,files:[source],createdAt:'',sourceVersionIds:[],provenance:{type:'import'},warnings:[]});
  const fixture={schemaVersion:1,id:'ws',projectId:'p',revision:0,objects:[object],versions:[version('existing'),version('imported')],tasks:[],deliveries:[]};
  const glb='data:model/gltf-binary;base64,'+buildWorkbenchGlb().toString('base64');
  const entry=`import React from 'react';import{createRoot}from'react-dom/client';import{GraphicsStudio}from${JSON.stringify(path.resolve('src/GraphicsStudio.tsx'))};import${JSON.stringify(path.resolve('src/style.css'))};
    window.actions=[];window.fixture=${JSON.stringify(fixture)};window.desktop={assetUrl:()=>${JSON.stringify(glb)},call:()=>{throw Error('Unexpected desktop call')}};
    const project={schemaVersion:1,id:'p',name:'Preview UI fixture',style:'',height:1,unityPath:'',unityFolder:'',createdAt:'',updatedAt:'',revision:0,assets:[],parts:[],jobs:[],assemblies:[],builds:[],demo:false};
    const root=createRoot(document.getElementById('root'));window.render=()=>root.render(<GraphicsStudio project={project} workspace={structuredClone(window.fixture)} busy={false} onAction={async action=>{
      window.actions.push(action);if(action.kind!=='prepare-import-preview')throw Error('Unexpected action');
      await new Promise((resolve,reject)=>{window.finishPreview=success=>success?resolve():reject(Error('Fixture Blender conversion failed'));});
      window.fixture.versions.find(v=>v.id===action.versionId).files.push({path:'previews/imported.glb',sha256:'local-preview',bytes:${buildWorkbenchGlb().length},kind:'model'});window.render();return window.fixture;
    }}/>);window.render();`;
  await build({stdin:{contents:entry,loader:'tsx',resolveDir:process.cwd()},bundle:true,format:'iife',outfile:path.join(root,'ui.js'),jsx:'automatic',logLevel:'silent'});
  fs.writeFileSync(path.join(root,'index.html'),'<html lang="ko"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data:; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src data:"><link rel="stylesheet" href="ui.css"></head><body style="margin:0"><div id="root" class="app-body" style="height:100vh"></div><script src="ui.js"></script></body></html>');
  fs.writeFileSync(path.join(root,'main.cjs'),`const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root,'profile'))});app.whenReady().then(()=>new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadFile(${JSON.stringify(path.join(root,'index.html'))}));`);
  const app=await electron.launch({executablePath:binary as unknown as string,args:[path.join(root,'main.cjs')]});
  try {
    const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(8000);
    await page.route(/^https?:\/\//,route=>route.abort());
    await page.locator('.gs-version-history > summary').click();
    await page.getByTestId('graphics-version-imported').click();
    const button=page.getByTestId('graphics-prepare-import-preview');
    await button.waitFor();
    assert.match(await button.innerText(),/무료/);
    assert.match(await page.getByRole('region',{name:'가져온 모델 미리보기'}).innerText(),/추가 서비스 비용 없음 · 제작용 GPT 사용 없음/);
    assert.deepEqual(await page.evaluate(()=>(window as any).actions),[]);
    await button.click();
    await page.waitForFunction(()=>(window as any).actions.length===1);
    assert.equal(await button.isDisabled(),true);
    await button.evaluate((element:HTMLButtonElement)=>element.click());
    assert.deepEqual(await page.evaluate(()=>(window as any).actions),[{kind:'prepare-import-preview',objectId:'crate',versionId:'imported'}]);
    await page.evaluate(()=>(window as any).finishPreview(false));
    await page.getByRole('alert').filter({hasText:'Fixture Blender conversion failed'}).waitFor();
    assert.equal(await button.isEnabled(),true);
    assert.deepEqual(await page.evaluate(()=>(window as any).fixture.objects[0].accepted),object.accepted);
    await button.click();
    await page.waitForFunction(()=>(window as any).actions.length===2);
    await page.evaluate(()=>(window as any).finishPreview(true));
    await button.waitFor({state:'detached'});
    assert.deepEqual(await page.evaluate(()=>(window as any).actions),Array(2).fill({kind:'prepare-import-preview',objectId:'crate',versionId:'imported'}));
    assert.deepEqual(await page.evaluate(()=>(window as any).fixture.objects[0].accepted),object.accepted);
    assert.deepEqual(await page.evaluate(()=>(window as any).fixture.versions[1].files[0]),source);
    assert.equal(await page.evaluate(()=>(window as any).fixture.versions[1].files.length),2);
    assert.deepEqual(errors,[]);
  } finally {await app.close();}
});
