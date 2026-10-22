import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import electronBinary from 'electron';

test('all category groups are visible, navigation is inert, target clears, and nonliving controls never expose pose or face', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graphics-subjects-ui-'));
  await build({ stdin: { contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {CreationSubjectChooser} from ${JSON.stringify(path.resolve('src/CreationSubjectChooser.tsx'))};
    import {CreationOptions} from ${JSON.stringify(path.resolve('src/CreationOptions.tsx'))};
    import {creationForSubject,creationSubjects,compileCreation} from ${JSON.stringify(path.resolve('shared/graphics-creation.ts'))};
    import ${JSON.stringify(path.resolve('src/graphics-studio.css'))};
    window.changes=[];
    function Harness(){const [value,setValue]=useState('human');const [spec,setSpec]=useState(creationForSubject('human'));const [disabled,setDisabled]=useState(false);
      window.spec=spec;window.disable=()=>setDisabled(true);window.value=value;
      const settings=spec.stageSettings.design.values;
      const setTarget=(id)=>{window.changes.push(id);setValue(id);if(id)setSpec(creationForSubject(id));};
      const o={id:'o',name:'fixture',kind:creationSubjects.find(s=>s.id===spec.subject).kind,creation:spec,createdAt:'',instruction:'',settings:{},references:[],accepted:{},selectedTasks:[]};
      window.compiled=compileCreation(o,'I01');
      return <main style={{maxWidth:640,padding:12}}><CreationSubjectChooser value={value} disabled={disabled} onChange={setTarget}/>
        <CreationOptions kind={o.kind} spec={spec} stage="design" settings={settings} disabled={disabled} onChange={setSpec}
          onSetting={(key,val)=>setSpec({...spec,stageSettings:{...spec.stageSettings,design:{...spec.stageSettings.design,values:{...settings,[key]:val}}}})}/></main>;
    }createRoot(document.getElementById('root')).render(<Harness/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, format: 'iife', outfile: path.join(root,'ui.js'), jsx: 'automatic', logLevel: 'silent' });
  fs.writeFileSync(path.join(root,'index.html'),'<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="ui.css"></head><body style="margin:0"><div id="root"></div><script src="ui.js"></script></body></html>');
  fs.writeFileSync(path.join(root,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root,'profile'))});app.whenReady().then(()=>{const win=new BrowserWindow({show:false,width:900,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});win.loadFile(${JSON.stringify(path.join(root,'index.html'))});});`);
  const app = await electron.launch({ executablePath: electronBinary as unknown as string,args:[path.join(root,'main.cjs')] });
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror',e=>errors.push(e.message));
    const groups = page.getByRole('group',{name:'오브젝트 분류',exact:true}), targets = page.getByRole('group',{name:'만들 대상 선택',exact:true});
    await groups.waitFor();
    assert.equal(await groups.getByRole('button').count(),5);
    await groups.getByRole('button',{name:'사물',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>(window as any).changes),[]);
    await targets.getByRole('button',{name:'기계',exact:true}).click();
    await page.waitForFunction(()=>(window as any).spec.subject==='machine');
    await page.getByText('세부 외형 · 구도 옵션',{exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'A 포즈',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'얼굴',exact:true}).count(),0);
    await page.getByText('수정할 때 유지할 특징',{exact:true}).click();
    assert.equal(await page.getByRole('checkbox',{name:'얼굴 유지',exact:true}).count(),0);
    await page.getByLabel('전체 외형 설명',{exact:true}).fill('커다란 고리와 파란 도장');
    assert.match(await page.evaluate(()=>(window as any).compiled.instruction),/커다란 고리/);
    await targets.getByRole('button',{name:'기계',exact:true}).click();
    assert.equal(await targets.getByRole('button',{name:'기계',exact:true}).getAttribute('aria-pressed'),'false');
    for(const [group,target,id] of [['건물·건축 부품','지붕','roof'],['자연환경','나무','tree'],['무기·장비','장신구','accessory']]){
      await groups.getByRole('button',{name:group,exact:true}).click();await targets.getByRole('button',{name:target,exact:true}).click();
      await page.waitForFunction(value=>(window as any).compiled.settings.subject===value,id);
    }
    for(const width of [900,640,360]){
      await page.setViewportSize({width,height:800});
      assert.equal(await page.getByTestId('creation-subject-chooser').evaluate(el=>el.scrollWidth>el.clientWidth),false);
    }
    await page.evaluate(()=>(window as any).disable());
    await page.waitForFunction(()=>document.querySelector<HTMLFieldSetElement>('[data-testid="creation-subject-chooser"]')?.disabled);
    assert.equal(await groups.getByRole('button',{name:'사물',exact:true}).isDisabled(),true);
    assert.deepEqual(errors,[]);
    assert.deepEqual(await page.evaluate(()=>(window as any).changes),['machine','','roof','tree','accessory']);
  } finally { await app.close(); }
});
