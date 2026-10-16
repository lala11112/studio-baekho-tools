/** Existing human originals copied into an isolated verification profile. No production writes. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../engine/store';
import { Engine } from '../engine/engine';
import { defaultCreation } from '../shared/graphics-creation';
import type { AssetVersion, GraphicsWorkspace } from '../shared/graphics';

const evidence = path.resolve('artifacts/runtime/graphics-external-rig-fixture.json');
assert(!fs.existsSync(evidence), 'Reuse the existing fixture; never duplicate the handoff');
const baseline = JSON.parse(fs.readFileSync('artifacts/runtime/graphics-external-rig-production.json','utf8'));
const old = baseline.before.records.find((r:any)=>r.kind==='graphics'&&r.id==='5844e13a-7892-422b-ac3f-410fe4f59231').data as GraphicsWorkspace;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ps-accurig-human-'));
const profile=path.join(root,'profile');
const store=new Store(profile);await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
const project=new Engine(store,{} as any).create('인간형 리깅 왕복 검증 · 원본 사본');
const sourceRoot=path.join(process.env.APPDATA!,'partsmith','projects',old.projectId);
const sha=(f:string)=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sourceIds=['ef127317-c570-4723-9712-925c9c2373e6','4cc99cd0-1611-4afb-92d6-df77a937e4b7','a8a984af-a88d-4529-955b-7c9437dfb292'];
const versions:AssetVersion[]=sourceIds.map(id=>{
  const version=old.versions.find(v=>v.id===id);assert(version);
  for(const file of version.files){const src=path.join(sourceRoot,file.path);assert.equal(sha(src),file.sha256);store.write(project.id,file.path,fs.readFileSync(src));assert.equal(sha(store.file(project.id,file.path)),file.sha256);}
  return {...structuredClone(version),objectId:'human-copy',provenance:{type:'import'},sourceVersionIds:[]};
});
const creation=defaultCreation('character');creation.subject='human';creation.attributes.composition='single';creation.parts=[];
creation.stageSettings.rig!.values={...creation.stageSettings.rig!.values,rigType:'humanoid',rigFingers:true,rigMethod:'accurig'};
const workspace:GraphicsWorkspace={schemaVersion:1,id:project.id,projectId:project.id,revision:1,objects:[{id:'human-copy',name:'인간형 리깅 검사 사본',kind:'character',createdAt:new Date().toISOString(),selectedTasks:[],instruction:'',settings:{},references:[],accepted:{'model:main':sourceIds[0],'design:main':sourceIds[1]},creation}],versions,tasks:[],deliveries:[]};
store.put('graphics',project.id,workspace);store.write(project.id,'graphics/workspace.json',JSON.stringify(workspace,null,2));
fs.mkdirSync(path.join(root,'return'),{recursive:true});
const source=versions[0].files.find(f=>/\.fbx$/i.test(f.path))!;
const data={root,profile,projectId:project.id,objectId:'human-copy',sourceVersionId:sourceIds[0],assemblyVersionId:sourceIds[2],projectRoot:store.directory(project.id),source,sourcePath:store.file(project.id,source.path),returnFolder:path.join(root,'return'),productionOriginals:sourceIds.flatMap(id=>old.versions.find(v=>v.id===id)!.files.map(f=>({path:path.join(sourceRoot,f.path),sha256:f.sha256}))),createdAt:new Date().toISOString(),paidSubmissions:0,productionGPT:0};
fs.writeFileSync(evidence,JSON.stringify(data,null,2));console.log(JSON.stringify({root,projectId:project.id,sourcePath:data.sourcePath,returnFolder:data.returnFolder}));
