/** Real packaged UI, private profile, existing rabbit only. Never submits production. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {_electron as electron,type ElectronApplication} from 'playwright';
import {Store} from '../engine/store';
import {Engine} from '../engine/engine';
import {GraphicsEngine} from '../engine/graphics';
import {creationForSubject} from '../shared/graphics-creation';
import type {AppState} from '../shared/types';
import type {GraphicsWorkspace} from '../shared/graphics';

const repo=process.cwd(),version=JSON.parse(fs.readFileSync('package.json','utf8')).version;
const runtime=path.join(repo,'artifacts/runtime');fs.mkdirSync(runtime,{recursive:true});
const productionRoot=path.join(process.env.APPDATA!,'partsmith/projects/ff70e6a6-b1cc-4dea-9a92-f9e092114578');
const workspacePath=path.join(productionRoot,'graphics/workspace.json');
const productionBytes=fs.readFileSync(workspacePath),production:GraphicsWorkspace=JSON.parse(productionBytes.toString());
const sha=(file:string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const originalFiles=[...new Set(production.versions.flatMap(v=>v.files.map(f=>f.path)))].map(file=>({file:path.join(productionRoot,file),sha:sha(path.join(productionRoot,file))}));
const rig=production.versions.find(v=>v.id==='123fbd42-4d02-4b4e-a58a-7086a6230321')!;
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'ps-preview12-package-'));
const inputs=path.join(profile,'inputs');fs.mkdirSync(inputs);
const copied=rig.files.filter(f=>/\.(blend|glb)$/i.test(f.path)).map(f=>{const target=path.join(inputs,path.basename(f.path));assert(!fs.existsSync(target));fs.copyFileSync(path.join(productionRoot,f.path),target);assert.equal(sha(target),f.sha256);return target;});
const store=new Store(profile);await store.open(path.join(repo,'node_modules/sql.js/dist/sql-wasm.wasm'));
const forbidden=async()=>{throw Error('No external services in package verification');};
const engine=new Engine(store,{balance:forbidden,upload:forbidden,submit:forbidden} as any);
const emptyProject=engine.create('새 오브젝트 화면 검증'),rigProject=engine.create('기존 토끼 원본 선 검증');
store.settings={...store.settings,unityPath:''};
const graphics=new GraphicsEngine(store,engine,{resources:path.join(repo,'integrations')});
let rigSpace=await graphics.action(rigProject.id,{kind:'create-object',name:'검사용 기존 토끼',objectKind:'character',creation:creationForSubject('animal')});
const rigObject=rigSpace.objects[0].id;
rigSpace=graphics.importFiles(rigProject.id,rigObject,'rig',copied);
const rigVersion=rigSpace.versions[0].id;
rigSpace=await graphics.action(rigProject.id,{kind:'accept',objectId:rigObject,versionId:rigVersion});
store.db.close();
let app:ElectronApplication|undefined;const errors:string[]=[],layouts:unknown[]=[];
let finalSpaces:GraphicsWorkspace[]=[];let topology:unknown;
try{
 for(let run=0;run<2;run++){
  const env={...process.env,PARTSMITH_DATA:profile,PARTSMITH_DEV:''};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:path.join(repo,`release/${version}/win-unpacked/Partsmith.exe`),env,timeout:30000});
  const page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
  const state=()=>page.evaluate(()=>window.desktop.call<AppState>({type:'state'}));
  const workspace=async(id:string)=>(await state()).graphicsWorkspaces!.find(w=>w.projectId===id)!;
  if(run===0){
   await page.locator(`[data-project-id="${emptyProject.id}"]`).getByTestId('project-open').click();
   await page.getByTestId('graphics-empty-new-object').click();
   const dialog=page.getByTestId('graphics-create-dialog');await dialog.waitFor();
   await dialog.getByRole('group',{name:'오브젝트 분류',exact:true}).getByRole('button',{name:'건물·건축 부품',exact:true}).click();
   await dialog.getByRole('group',{name:'만들 대상 선택',exact:true}).getByRole('button',{name:'단독 건물',exact:true}).click();
   await dialog.getByRole('textbox',{name:'이름',exact:true}).fill('검사용 건물');
   const resize=async(width:number,zoom:number)=>{
    const content=await app!.evaluate(({BrowserWindow},{width,zoom})=>{const win=BrowserWindow.getAllWindows()[0];win.setSize(width,900);win.webContents.setZoomFactor(zoom);return win.getContentSize();},{width,zoom});
    await page.waitForFunction(({content,zoom})=>Math.abs(innerWidth-content[0]/zoom)<=2&&Math.abs(innerHeight-content[1]/zoom)<=2,{content,zoom});
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
   };
   for(const width of [1920,1280,960,800])for(const zoom of [1,1.25,1.5]){
    await resize(width,zoom);
    const bounds=await dialog.evaluate(el=>{const r=el.getBoundingClientRect();const submit=el.querySelector('button[type="submit"]')!.getBoundingClientRect();return {viewport:{width:innerWidth,height:innerHeight},dialog:{x:r.x,y:r.y,width:r.width,height:r.height},scroll:el.scrollWidth,client:el.clientWidth,submit:{x:submit.x,y:submit.y,width:submit.width,height:submit.height},documentWidth:document.documentElement.scrollWidth};});
    assert(bounds.dialog.x>=-1&&bounds.dialog.y>=-1&&bounds.dialog.x+bounds.dialog.width<=bounds.viewport.width+1&&bounds.dialog.y+bounds.dialog.height<=bounds.viewport.height+1,JSON.stringify(bounds));
    assert(bounds.submit.y>=bounds.dialog.y&&bounds.submit.y+bounds.submit.height<=bounds.viewport.height+1,JSON.stringify(bounds));
    assert(bounds.scroll<=bounds.client+1&&bounds.documentWidth<=bounds.viewport.width+1,JSON.stringify(bounds));
    layouts.push({width,zoom,...bounds});
   }
   await resize(1280,1);
   await page.screenshot({path:path.join(runtime,'graphics-preview12-create.png')});
   await dialog.getByRole('button',{name:'취소',exact:true}).click();
   assert.equal((await workspace(emptyProject.id))?.objects.length??0,0);
   await page.getByTestId('graphics-new-object').click();
   assert.equal(await dialog.getByRole('textbox',{name:'이름',exact:true}).inputValue(),'검사용 건물');
   await dialog.getByRole('button',{name:'오브젝트 만들기',exact:true}).click();
   await page.getByLabel('만들 대상',{exact:true}).waitFor();
   let w=await workspace(emptyProject.id);assert.equal(w.objects.length,1);assert.equal(w.tasks.length,0);assert.equal(w.objects[0].kind,'environment');
   assert.equal(w.objects[0].creation?.stageSettings.model?.values.faceLimit,5000);
   assert.equal(w.objects[0].creation?.stageSettings.model?.values.quad,true);
   await page.getByRole('navigation',{name:'제작 단계'}).getByRole('button',{name:'2 모델',exact:true}).click();
   const number=page.getByLabel('목표 면 수',{exact:true}),slider=page.getByLabel('목표 면 수 슬라이더',{exact:true});
   assert.equal(await number.inputValue(),'5000');assert.equal(await slider.getAttribute('max'),'25000');
   await page.getByRole('button',{name:'삼각형',exact:true}).click();assert.equal(await slider.getAttribute('max'),'50000');
   await number.fill('50000');await number.blur();await page.getByRole('button',{name:'쿼드',exact:true}).click();
   assert.equal(await number.inputValue(),'25000');
   await page.getByRole('button',{name:'쿼드',exact:true}).click();assert.equal(await page.getByRole('button',{name:'쿼드',exact:true}).getAttribute('aria-pressed'),'false');
   await page.getByRole('button',{name:'쿼드',exact:true}).click();await number.fill('5000');await number.blur();
   await page.getByRole('button',{name:'옵션 저장',exact:true}).click();
   w=await workspace(emptyProject.id);assert.equal(w.tasks.length,0);
   await page.getByRole('button',{name:'모든 프로젝트',exact:true}).click();
   await page.locator(`[data-project-id="${rigProject.id}"]`).getByTestId('project-open').click();
   await page.getByTestId(`graphics-object-${rigObject}`).click();
   await page.getByRole('navigation',{name:'제작 단계'}).getByRole('button',{name:'5 리깅',exact:true}).click();
   await page.getByTestId('graphics-preview').locator('canvas').waitFor();
   await page.getByTestId('viewport-wire-toggle').click();
   await page.getByRole('button',{name:'원본 면 선',exact:true}).click();
   // Topology UI waits on a deterministic local export; no model inference or service request.
   await page.locator('[data-testid="viewport-topology-status"]:is([data-state="ready"],[data-state="unavailable"])').waitFor({timeout:120000});
   assert.equal(await page.getByTestId('viewport-topology-status').getAttribute('data-state'),'ready',await page.getByTestId('viewport-topology-status').innerText());
   topology=await page.getByTestId('viewport-topology-status').innerText();
   await page.screenshot({path:path.join(runtime,'graphics-preview12-native.png')});
   assert.deepEqual(await workspace(rigProject.id),rigSpace,'Inspecting must not modify workspace/adoption');
   finalSpaces=(await state()).graphicsWorkspaces!.filter(w=>[emptyProject.id,rigProject.id].includes(w.projectId));
   assert((await state()).projects.filter(p=>[emptyProject.id,rigProject.id].includes(p.id)).every(p=>p.jobs.length===0));
  }else{
   for(const before of finalSpaces)assert.deepEqual(await workspace(before.projectId),before);
  }
  await app.close();app=undefined;
 }
 assert.deepEqual(errors,[]);assert(fs.readFileSync(workspacePath).equals(productionBytes));
 for(const file of originalFiles)assert.equal(sha(file.file),file.sha);
 fs.writeFileSync(path.join(runtime,'graphics-preview12-package.json'),JSON.stringify({passed:true,version,profile,layouts,topology,errors,originalFiles:originalFiles.length,productionWorkspacePreserved:true,privateRestartPreserved:true,paidSubmissions:0,productionWorkers:0},null,2));
 console.log(JSON.stringify({passed:true,version,profile,layouts:layouts.length,topology,errors}));
}catch(error){
 if(app){const page=await app.firstWindow();console.log((await page.locator('body').innerText()).slice(-7000));await page.screenshot({path:path.join(runtime,'graphics-preview12-package-failure.png')}).catch(()=>{});}
 throw error;
}finally{await app?.close();}
