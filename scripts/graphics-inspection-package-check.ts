/** Packaged app buttons on a private profile; reuses native rabbit rig, never runs AI/API. */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {_electron as electron,type ElectronApplication} from 'playwright';
import {Store} from '../engine/store';import {Engine} from '../engine/engine';import {GraphicsEngine} from '../engine/graphics';
import {creationForSubject} from '../shared/graphics-creation';
import type {AppState} from '../shared/types';import type {GraphicsWorkspace} from '../shared/graphics';
const repo=process.cwd(),version=JSON.parse(fs.readFileSync('package.json','utf8')).version;
const productionRoot=path.join(process.env.APPDATA!,'partsmith/projects/ff70e6a6-b1cc-4dea-9a92-f9e092114578');
const productionWorkspace=fs.readFileSync(path.join(productionRoot,'graphics/workspace.json'));
const prod:GraphicsWorkspace=JSON.parse(productionWorkspace.toString());
const rig=prod.versions.find(v=>v.id==='123fbd42-4d02-4b4e-a58a-7086a6230321')!;
const originalFiles=rig.files.filter(f=>/\.(blend|glb)$/i.test(f.path));
const sha=(file:string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashes=originalFiles.map(f=>({file:path.join(productionRoot,f.path),sha:sha(path.join(productionRoot,f.path))}));
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'ps-inspection-package-'));
const importedFolder=path.join(profile,'fixture-input');fs.mkdirSync(importedFolder);
const importedFiles=originalFiles.map(file=>{const target=path.join(importedFolder,path.basename(file.path));assert(!fs.existsSync(target));fs.copyFileSync(path.join(productionRoot,file.path),target);assert.equal(sha(target),file.sha256);return target;});
const store=new Store(profile);await store.open(path.join(repo,'node_modules/sql.js/dist/sql-wasm.wasm'));
const forbid=async()=>{throw Error('External service forbidden in local verification');};
const engine=new Engine(store,{balance:forbid,upload:forbid,submit:forbid} as any),project=engine.create('메시·미터 앱 검증');
store.settings={...store.settings,unityPath:''};
const graphics=new GraphicsEngine(store,engine,{resources:path.join(repo,'integrations')});
const creation=creationForSubject('animal');
let space=await graphics.action(project.id,{kind:'create-object',name:'기존 토끼 리그 검사 사본',objectKind:'character',creation});
const objectId=space.objects[0].id;
space=graphics.importFiles(project.id,objectId,'rig',importedFiles);
space=await graphics.action(project.id,{kind:'accept',objectId,versionId:space.versions[0].id});
store.db.close();
let app:ElectronApplication|undefined;const errors:string[]=[];let finalSpace:GraphicsWorkspace|undefined;
try{
 for(let run=0;run<2;run++){
  const env={...process.env,PARTSMITH_DATA:profile,PARTSMITH_DEV:''};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:path.join(repo,`release/${version}/win-unpacked/Partsmith.exe`),env,timeout:30000});
  const page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));
  await page.locator(`[data-project-id="${project.id}"]`).getByTestId('project-open').click();
  await page.getByTestId(`graphics-object-${objectId}`).click();
  const state=()=>page.evaluate(()=>window.desktop.call<AppState>({type:'state'}));
  const workspace=async()=>(await state()).graphicsWorkspaces!.find(w=>w.projectId===project.id)!;
  if(run===0){
   await page.getByRole('navigation',{name:'제작 단계'}).getByRole('button',{name:'2 모델',exact:true}).click();
   await page.getByLabel('실제 크기 모드').selectOption('uniform');await page.getByLabel('기준 길이 미터').fill('0.5');
   await page.getByLabel('크기 피벗').selectOption('bottom-center');
   await page.getByRole('button',{name:'크기 설정 저장 · 생성 없음',exact:true}).click();
   assert.equal((await workspace()).tasks.length,0);
   await page.getByRole('button',{name:'크기 맞춤 사본 준비 · 무료',exact:true}).click();
   let w=await workspace();assert.equal(w.tasks.length,1);const task=w.tasks[0];assert.equal(task.taskId,'A05');assert.equal(task.cost?.credits,0);
   assert.equal(JSON.parse(String(task.settings.physicalSize)).lengthMeters,.5);
   await page.getByTestId(`graphics-approve-${task.id}`).click();
   const deadline=Date.now()+120000;
   while(Date.now()<deadline){const current=(await workspace()).tasks.find(t=>t.id===task.id)!;if(['review','failed'].includes(current.status))break;await page.waitForTimeout(250);}
   w=await workspace();assert.equal(w.tasks[0].status,'review',w.tasks[0].message);
   const result=w.versions.find(v=>v.id===w.tasks[0].outputVersionIds[0])!;assert.equal(result.role,'rig');
   assert.equal(w.objects[0].accepted['rig:main'],space.versions[0].id,'No automatic adoption');
   await page.getByTestId(`graphics-version-${result.id}`).click();
   await page.getByTestId('graphics-preview').locator('canvas').waitFor();
   const reportFile=result.files.find(f=>f.kind==='report')!;const report=JSON.parse(fs.readFileSync(path.join(profile,'projects',project.id,reportFile.path),'utf8'));
   assert(Math.abs(report.physicalSize.dimensionsMeters.y-.5)<=.001);assert.equal(report.originalPreserved,true);
   await page.getByLabel('보조 메뉴').click();await page.getByRole('button',{name:'저장 공간 현황',exact:true}).click();
   await page.getByRole('button',{name:'저장 공간 조사',exact:true}).click();await page.getByRole('heading',{name:/조사한 파일 합계/}).waitFor({timeout:60000});
   await page.getByLabel('보조 화면 닫기').click();
   finalSpace=await workspace();assert.equal(finalSpace.tasks.length,1);assert.equal((await state()).projects.find(p=>p.id===project.id)!.jobs.length,0);
   await page.screenshot({path:path.join(repo,'artifacts/runtime/graphics-inspection-package.png')});
  }else assert.deepEqual(await workspace(),finalSpace);
  await app.close();app=undefined;
 }
 assert.deepEqual(errors,[]);assert.equal(fs.readFileSync(path.join(productionRoot,'graphics/workspace.json')).equals(productionWorkspace),true);
 for(const item of hashes)assert.equal(sha(item.file),item.sha);
 for(const v of finalSpace!.versions)for(const file of v.files)assert.equal(sha(path.join(profile,'projects',project.id,file.path)),file.sha256);
 const result={passed:true,version,profile,projectId:project.id,objectId,actualAppButtons:true,nativeRabbitRig:true,targetHeightMeters:.5,localTasks:1,paidSubmissions:0,gptRequests:0,sourceHashesPreserved:true,productionWorkspaceUnchanged:true,restartPreserved:true,errors};
 fs.writeFileSync(path.join(repo,'artifacts/runtime/graphics-inspection-package.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await app?.close();}
