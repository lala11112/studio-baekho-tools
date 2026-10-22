import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultCreation } from '../shared/graphics-creation';

test('guided Unity target separates drafts, validates explicit save and blocks changes during fixed requests', {timeout:90000}, async()=>{
  const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
  const {build}=await import('esbuild'),{_electron:electron}=await import('playwright'),{default:binary}=await import('electron');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'graphics-unity-target-ui-'));
  const object={id:'crate',name:'상자',kind:'prop',createdAt:'',selectedTasks:[],instruction:'',settings:{},references:[],accepted:{'model:main':'model'},creation:defaultCreation('prop')};
  const fixture={schemaVersion:1,id:'ws',projectId:'p',revision:0,objects:[object],versions:[{id:'model',objectId:'crate',role:'model',slot:'main',label:'상자 모델',files:[],createdAt:'',sourceVersionIds:[],provenance:{type:'import'},warnings:[]}],tasks:[],deliveries:[],target:{projectPath:'C:/Unity/Existing',unityVersion:'6000.3',pipeline:'urp',inspectedAt:'',packages:{},warnings:[]}};
  const entry=`import React from 'react';import{createRoot}from'react-dom/client';import{GraphicsStudio}from${JSON.stringify(path.resolve('src/GraphicsStudio.tsx'))};import${JSON.stringify(path.resolve('src/style.css'))};
    window.fixture=${JSON.stringify(fixture)};window.actions=[];window.desktop={assetUrl:()=>'',call:()=>{throw Error('Unexpected desktop call')}};
    const project={schemaVersion:1,id:'p',name:'Unity target fixture',unityPath:'C:/Unity/Existing',assets:[],parts:[],jobs:[],assemblies:[],builds:[],demo:false};
    const root=createRoot(document.getElementById('root'));window.render=()=>root.render(<GraphicsStudio project={project} workspace={structuredClone(window.fixture)} busy={false} onAction={async action=>{
      window.actions.push(action);if(action.kind!=='set-unity-target')throw Error('Unexpected action');if(action.projectPath==='C:/bad')throw Error('Fixture: Unity 프로젝트 폴더가 아닙니다');
      await new Promise(resolve=>window.finishSave=resolve);window.fixture.target.projectPath=action.projectPath;window.render();return window.fixture;
    }}/>);window.render();`;
  await build({stdin:{contents:entry,loader:'tsx',resolveDir:process.cwd()},bundle:true,format:'iife',outfile:path.join(root,'ui.js'),jsx:'automatic',logLevel:'silent'});
  fs.writeFileSync(path.join(root,'index.html'),'<html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\';script-src \'self\';style-src \'self\' \'unsafe-inline\';connect-src \'none\'"><link rel="stylesheet" href="ui.css"></head><body style="margin:0"><div id="root" class="app-body" style="height:100vh"></div><script src="ui.js"></script></body></html>');
  fs.writeFileSync(path.join(root,'main.cjs'),`const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root,'profile'))});app.whenReady().then(()=>new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadFile(${JSON.stringify(path.join(root,'index.html'))}));`);
  const app=await electron.launch({executablePath:binary as unknown as string,args:[path.join(root,'main.cjs')]});
  try{
    const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(8000);
    await page.getByRole('navigation',{name:'제작 단계'}).getByRole('button',{name:'7 Unity 전달',exact:true}).click();
    const change=page.getByTestId('graphics-change-unity-target'),summary=page.getByTestId('graphics-unity-target-path'),dialog=page.getByRole('dialog',{name:'Unity 프로젝트 변경',exact:true}),input=page.getByLabel('새 Unity 프로젝트 경로'),save=dialog.getByRole('button',{name:'검사하고 저장',exact:true});
    assert.equal(await summary.innerText(),'C:/Unity/Existing');
    await change.click();await input.fill('C:/Unity/Draft');
    for(const width of [800,960,1280,1920]) {
      await page.setViewportSize({width,height:900});
      const layout=await dialog.evaluate(element=>{const r=element.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:element.scrollWidth-element.clientWidth};});
      assert.ok(layout.left>=0&&layout.top>=0&&layout.right<=layout.width+1&&layout.bottom<=layout.height+1&&layout.overflow===0,JSON.stringify(layout));
      assert.equal(await save.isVisible(),true);
    }
    assert.equal(await summary.innerText(),'C:/Unity/Existing');
    await dialog.getByRole('button',{name:'취소',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>(window as any).actions),[]);
    await change.click();assert.equal(await input.inputValue(),'C:/Unity/Existing');
    await input.fill('C:/bad');await save.click();
    await dialog.getByRole('alert').filter({hasText:'Unity 프로젝트 폴더가 아닙니다'}).waitFor();
    assert.equal(await input.inputValue(),'C:/bad');assert.equal(await summary.innerText(),'C:/Unity/Existing');
    await input.fill('  C:/Unity/New  ');await save.click();
    await page.waitForFunction(()=>(window as any).actions.length===2);
    assert.equal(await input.isDisabled(),true);assert.equal(await dialog.getByRole('button',{name:'취소',exact:true}).isDisabled(),true);
    assert.deepEqual(await page.evaluate(()=>(window as any).actions),[{kind:'set-unity-target',projectPath:'C:/bad'},{kind:'set-unity-target',projectPath:'C:/Unity/New'}]);
    await page.evaluate(()=>(window as any).finishSave());await dialog.waitFor({state:'hidden'});
    assert.equal(await summary.innerText(),'C:/Unity/New');
    for(const status of ['awaiting_approval','running','submission_unknown']){
      await page.evaluate(status=>{const w=window as any;w.fixture.tasks=[{id:'other-object-task',objectId:'another',taskId:'M01',status,createdAt:'',updatedAt:'',inputVersionIds:[],outputVersionIds:[],settings:{},backendJobIds:[],requestHash:'frozen',message:''}];w.render();},status);
      await page.waitForFunction(()=>document.querySelector<HTMLButtonElement>('[data-testid=graphics-change-unity-target]')?.disabled===true);
      assert.equal(await change.isDisabled(),true);
    }
    await page.evaluate(()=>{const w=window as any;w.fixture.tasks=[];w.fixture.deliveries=[{id:'queued',objectId:'crate',versionIds:['model'],status:'queued',destination:'Assets/Partsmith/Crate',profileFingerprint:'frozen',converterVersion:'fixture',createdAt:'',files:[],warnings:[],errors:[],playbackVerified:false}];w.render();});
    await page.waitForFunction(()=>document.querySelector('[data-testid=graphics-guide]')?.textContent?.includes('Unity'));
    assert.equal(await change.isDisabled(),true);
    assert.deepEqual(await page.evaluate(()=>(window as any).fixture.objects[0].accepted),object.accepted);
    assert.deepEqual(errors,[]);
  }finally{await app.close();}
});
