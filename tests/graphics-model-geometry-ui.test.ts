import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import electronBinary from 'electron';

test('model geometry controls stay synchronized, clamp only explicit choices, and retain invalid saved drafts without executing', {timeout:60000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'graphics-density-ui-'));
  await build({stdin:{contents:`
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';
    import{CreationOptions}from${JSON.stringify(path.resolve('src/CreationOptions.tsx'))};
    import{defaultCreation,humanParts,creationSettings,creationSelectionProblem,validateCreation}from${JSON.stringify(path.resolve('shared/graphics-creation.ts'))};
    import${JSON.stringify(path.resolve('src/graphics-studio.css'))};
    window.changes=0;window.serviceCalls=0;
    function Harness(){const initial=defaultCreation('character');const[spec,setSpec]=useState(()=>JSON.parse(localStorage.getItem('draft')??JSON.stringify(initial)));const[disabled,setDisabled]=useState(false);
      const o={id:'o',name:'fixture',kind:'character',createdAt:'',selectedTasks:[],instruction:'',settings:{},references:[],accepted:{},creation:spec};
      const settings=creationSettings(o,'model');window.spec=spec;window.problem=creationSelectionProblem(spec,'model');window.disable=()=>setDisabled(true);
      window.invalid=()=>{const c=structuredClone(spec);c.stageSettings.model.values={...settings,quad:true,faceLimit:50000};setSpec(c);localStorage.setItem('draft',JSON.stringify(c));};
      window.parts=()=>{const c=structuredClone(spec);c.attributes.composition='parts';c.parts=humanParts();c.parts[0].faceLimit=50000;c.parts[1].faceLimit=30000;c.activePartId='head';c.stageSettings.model.values={...settings,model:'P2-20260801',quad:false};setSpec(c);};
      const change=(next)=>{window.changes++;setSpec(next);};
      return <main className="graphics-studio" style={{padding:12,maxWidth:480}}><CreationOptions kind="character" stage="model" spec={spec} settings={settings} disabled={disabled} onChange={change}
        onSetting={(key,value)=>change({...spec,stageSettings:{...spec.stageSettings,model:{...spec.stageSettings.model,values:{...settings,[key]:value}}}})}/>
        <button onClick={()=>{validateCreation(spec,'character');localStorage.setItem('draft',JSON.stringify(spec));}}>옵션 저장</button></main>;
    }createRoot(document.getElementById('root')).render(<Harness/>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,format:'iife',outfile:path.join(root,'ui.js'),jsx:'automatic',logLevel:'silent'});
  fs.writeFileSync(path.join(root,'index.html'),'<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="ui.css"></head><body style="margin:0"><div id="root"></div><script src="ui.js"></script></body></html>');
  fs.writeFileSync(path.join(root,'main.cjs'),`const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root,'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:800,height:1100,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadFile(${JSON.stringify(path.join(root,'index.html'))});});`);
  const app=await electron.launch({executablePath:electronBinary as unknown as string,args:[path.join(root,'main.cjs')]});
  try{
    const page=await app.firstWindow(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(8000);
    const count=page.getByRole('spinbutton',{name:'목표 면 수',exact:true}),slider=page.getByRole('slider',{name:'목표 면 수 슬라이더',exact:true});
    const topology=page.getByRole('group',{name:/^메시 형태/}),quad=topology.getByRole('button',{name:'쿼드',exact:true}),tri=topology.getByRole('button',{name:'삼각형',exact:true});
    const provider=page.getByRole('combobox',{name:'모델 제작 모델',exact:true});
    await count.waitFor();assert.equal(await count.inputValue(),'5000');assert.equal(await quad.getAttribute('aria-pressed'),'true');assert.equal(await slider.getAttribute('step'),'100');
    await slider.focus();await slider.press('ArrowRight');assert.equal(await count.inputValue(),'5100');
    await count.fill('7600');assert.equal(await slider.inputValue(),'7600');
    await quad.click();assert.equal(await quad.getAttribute('aria-pressed'),'false');assert.match(await page.evaluate(()=>(window as any).problem),/메시 형태 선택/);
    await page.getByRole('button',{name:'옵션 저장',exact:true}).click();await page.reload();await count.waitFor();assert.equal(await quad.getAttribute('aria-pressed'),'false');assert.equal(await tri.getAttribute('aria-pressed'),'false');
    await tri.click();await count.fill('50000');assert.equal(await slider.getAttribute('max'),'50000');
    await quad.click();assert.equal(await count.inputValue(),'25000');assert.match(await page.getByRole('status').innerText(),/50,000 → 25,000/);assert.equal(await slider.getAttribute('max'),'25000');
    await provider.selectOption('P1-20260311');assert.equal(await quad.isDisabled(),true);assert.equal(await tri.getAttribute('aria-pressed'),'true');assert.equal(await count.inputValue(),'20000');
    assert.match(await page.getByRole('status').innerText(),/삼각형/);
    await tri.click();assert.equal(await tri.getAttribute('aria-pressed'),'false');assert.match(await page.evaluate(()=>(window as any).problem),/메시 형태 선택/);
    await provider.selectOption('P2-20260801');assert.equal(await quad.getAttribute('aria-pressed'),'false','Changing model does not restore a deliberately cleared topology');
    await count.fill('');await page.getByRole('button',{name:'옵션 저장',exact:true}).click();await page.reload();await count.waitFor();assert.equal(await count.inputValue(),'');
    await page.evaluate(()=>(window as any).invalid());await page.reload();await count.waitFor();assert.equal(await count.inputValue(),'50000');assert.equal(await page.evaluate(()=>(window as any).changes),0);assert.match(await page.getByRole('alert').innerText(),/25,000/);
    await page.evaluate(()=>(window as any).parts());await quad.click();assert.deepEqual(await page.evaluate(()=>(window as any).spec.parts.map((p:any)=>p.faceLimit)),[25000,25000,5000]);assert.match(await page.getByRole('status').innerText(),/몸통/);
    await count.fill('7400');assert.deepEqual(await page.evaluate(()=>(window as any).spec.parts.map((p:any)=>p.faceLimit)),[7400,25000,5000]);assert.equal(await count.count(),1);
    for(const width of [480,360,300]){await page.setViewportSize({width,height:1000});const overflow=await page.getByTestId('model-geometry-settings').evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth,children:[...el.querySelectorAll('*')].filter(child=>child.getBoundingClientRect().right>el.getBoundingClientRect().right+1).map(child=>({tag:child.tagName,class:child.className,width:child.getBoundingClientRect().width,text:child.textContent?.slice(0,80)}))}));assert(overflow.scroll<=overflow.client,JSON.stringify({width,...overflow}));}
    await page.evaluate(()=>(window as any).disable());assert.equal(await count.isDisabled(),true);assert.equal(await quad.isDisabled(),true);assert.equal(await slider.isDisabled(),true);
    assert.equal(await page.evaluate(()=>(window as any).serviceCalls),0);assert.deepEqual(errors,[]);
  }finally{await app.close();}
});
