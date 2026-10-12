/** Isolated packaged-app buttons -> real local Blender candidates -> review/restart. No AI/API. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { Store } from '../engine/store';
import { Engine } from '../engine/engine';
import { GraphicsEngine } from '../engine/graphics';
import { defaultCreation } from '../shared/graphics-creation';
import type { AppState } from '../shared/types';
import type { GraphicsWorkspace } from '../shared/graphics';

const repo=process.cwd(),version=JSON.parse(fs.readFileSync('package.json','utf8')).version;
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'ps-3d-package-'));
const store=new Store(profile);await store.open(path.join(repo,'node_modules/sql.js/dist/sql-wasm.wasm'));
const forbidden=async()=>{throw Error('No external service permitted in this local fixture');};
const engine=new Engine(store,{balance:forbidden,upload:forbidden,submit:forbidden} as any),project=engine.create('3D 버튼 검증 · 로컬 바위');
store.settings={...store.settings,unityPath:''};
const graphics=new GraphicsEngine(store,engine,{resources:path.join(repo,'integrations')});
let w=await graphics.action(project.id,{kind:'create-object',name:'로컬 바위',objectKind:'prop'});const objectId=w.objects[0].id;
const creation=defaultCreation('prop');creation.subject='rock';creation.attributes={style:'lowpoly',shape:'angular',surface:'rough',composition:'whole'};creation.stageSettings.model!.values={...creation.stageSettings.model!.values,modelMethod:'local',count:2,faceLimit:1000};
await graphics.action(project.id,{kind:'update-object',objectId,patch:{creation}});
const image=new PNG({width:64,height:64});image.data.fill(220);const original=path.join(profile,'synthetic-reference.png');fs.writeFileSync(original,PNG.sync.write(image));
w=graphics.importFiles(project.id,objectId,'design',[original]);await graphics.action(project.id,{kind:'accept',objectId,versionId:w.versions[0].id});
store.db.close();
const hash=(p:string)=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const root=path.join(profile,'projects',project.id),errors:string[]=[];let app:ElectronApplication|undefined,baseline:GraphicsWorkspace|undefined;
const executablePath=path.join(repo,`release/${version}/win-unpacked/Partsmith.exe`);
try{
 for(let run=0;run<2;run++){
  const env={...process.env,PARTSMITH_DATA:profile,PARTSMITH_DEV:''};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath,env,timeout:30000});const page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
  await page.locator(`[data-project-id="${project.id}"]`).getByTestId('project-open').click();await page.getByTestId('graphics-studio').waitFor();await page.getByTestId(`graphics-object-${objectId}`).click();
  const state=()=>page.evaluate(()=>window.desktop.call<AppState>({type:'state'}));
  const workspace=async()=>(await state()).graphicsWorkspaces!.find(s=>s.projectId===project.id)!;
  const wait=async(check:(space:GraphicsWorkspace)=>boolean)=>{const end=Date.now()+120000;while(Date.now()<end){const space=await workspace();if(check(space))return space;await new Promise(r=>setTimeout(r,300));}throw Error('App local result timeout');};
  if(run===0){
   await page.getByRole('navigation',{name:'제작 단계'}).getByRole('button',{name:'2 모델',exact:true}).click();
   assert.equal(await page.getByLabel('후보 개수',{exact:true}).inputValue(),'2');
   assert.equal((await workspace()).tasks.length,0);
   await page.getByTestId('graphics-prepare').click();let space=await wait(s=>s.tasks.length===1),task=space.tasks[0];
   assert.equal(task.status,'awaiting_approval');assert.equal(task.cost?.credits,0);assert.equal(task.settings.count,2);assert.equal(task.taskId,'M04');
   await page.getByTestId(`graphics-approve-${task.id}`).click();space=await wait(s=>['review','failed'].includes(s.tasks[0].status));assert.equal(space.tasks[0].status,'review',space.tasks[0].message);
   assert.equal(space.tasks[0].outputVersionIds.length,2);assert.equal(space.objects[0].accepted['model:main'],undefined);
   const candidate=space.tasks[0].outputVersionIds[0];await page.getByTestId(`graphics-version-${candidate}`).click();await page.getByTestId('graphics-preview').locator('canvas').waitFor();
   await page.getByTestId('graphics-accept-version').click();await wait(s=>s.objects[0].accepted['model:main']===candidate);
   await page.getByTestId('graphics-preview').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(repo,'artifacts/runtime/graphics-creation-preview.png')});
   for(const [width,height]of [[1440,1000],[1024,768],[800,600]]){
    await app.browserWindow(page).then(b=>b.evaluate((window,size)=>window.setSize(size[0],size[1]),[width,height]));
    await page.getByTestId('graphics-prepare').scrollIntoViewIfNeeded();const box=await page.getByTestId('graphics-prepare').boundingBox();const viewport=await page.evaluate(()=>({w:innerWidth,h:innerHeight}));assert(box&&box.x>=0&&box.x+box.width<=viewport.w+1&&box.y>=0&&box.y+box.height<=viewport.h+1);
   }
   await app.browserWindow(page).then(b=>b.evaluate(window=>window.setSize(1440,1000)));
   for (const factor of [1.25,1.5,1]) {
    await app.browserWindow(page).then(b=>b.evaluate((window,zoom)=>window.webContents.setZoomFactor(zoom),factor));
    await page.getByTestId('graphics-prepare').scrollIntoViewIfNeeded();const box=await page.getByTestId('graphics-prepare').boundingBox();const viewport=await page.evaluate(()=>({w:innerWidth,h:innerHeight}));assert(box&&box.x>=0&&box.x+box.width<=viewport.w+1&&box.y>=0&&box.y+box.height<=viewport.h+1);
   }
   await page.getByRole('navigation',{name:'제작 단계'}).scrollIntoViewIfNeeded();
   await page.screenshot({path:path.join(repo,'artifacts/runtime/graphics-creation-package.png')});
   baseline=await workspace();assert.equal((await state()).projects.find(p=>p.id===project.id)!.jobs.length,0);
  }else assert.deepEqual(await workspace(),baseline);
  await app.close();app=undefined;
 }
 for(const v of baseline!.versions)for(const f of v.files)assert.equal(hash(path.join(root,f.path)),f.sha256);
 assert.deepEqual(errors,[]);
 const report={passed:true,version,profile,projectId:project.id,objectId,actualPackagedButtons:true,realBlenderModels:2,workerCalls:0,paidSubmissions:0,restartPreserved:true,viewports:[[1440,1000],[1024,768],[800,600]],zoomFactors:[1,1.25,1.5],versions:baseline!.versions.length,errors,checkedAt:new Date().toISOString()};
 fs.writeFileSync(path.join(repo,'artifacts/runtime/graphics-creation-package.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await app?.close();}
