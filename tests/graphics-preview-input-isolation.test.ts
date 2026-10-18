import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../engine/store';
import { Engine } from '../engine/engine';
import { GraphicsEngine } from '../engine/graphics';
import { createGraphicsNativeExecutor, type GraphicsNativeArgs } from '../engine/graphics-native';
import { createGraphicsAstraExecutor } from '../engine/graphics-astra';
import { prepareUnityDelivery, readUnityTarget } from '../engine/graphics-unity';
import type { AssetVersion, GraphicsFile } from '../shared/graphics';

function fixture(t: any, extension='fbx') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ps-preview-input-'));
  t.after(()=>{assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  const put=(name:string,kind:string):GraphicsFile=>{const data=Buffer.from(name);fs.writeFileSync(path.join(root,name),data);return {path:name,kind,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};};
  const original=put('original.'+extension,'model'),preview=put('viewport.glb','preview');
  const version:AssetVersion={id:'version',objectId:'object',role:'model',slot:'main',label:'source',files:[preview,original],createdAt:'2026-10-18',sourceVersionIds:[],provenance:{type:'import'},warnings:[]};
  const args:GraphicsNativeArgs={projectRoot:root,workspacePath:path.join(root,'workspace.json'),object:{id:'object',name:'test',kind:'prop',createdAt:'2026-10-18',selectedTasks:[],instruction:'',settings:{},references:[],accepted:{'model:main':'version'}},task:{id:'task',objectId:'object',taskId:'X04',createdAt:'2026-10-18',updatedAt:'2026-10-18',status:'running',inputVersionIds:['version'],settings:{},instruction:'',requestHash:'frozen',outputVersionIds:[],backendJobIds:[],message:'',localOnly:true},inputs:[version],blenderPath:process.execPath,resources:path.resolve('integrations'),signal:new AbortController().signal,onProgress(){}};
  return {root,put,original,preview,version,args};
}

test('size and export operations keep original FBX despite a preview GLB listed first; native GLB remains supported',async t=>{
  for(const taskId of ['A05','X04'])for(const extension of ['fbx','glb'])await t.test(taskId+' '+extension,async child=>{
    const f=fixture(child,extension);f.args.task.taskId=taskId;let selected='';
    const execute=createGraphicsNativeExecutor({runBlender:async(_binary,argv)=>{selected=JSON.parse(fs.readFileSync(argv.at(-1)!,'utf8')).source;throw Error('captured source only');}});
    await assert.rejects(execute(f.args),/captured source only/);
    assert.notEqual(selected,path.join(f.root,f.original.path));
    assert.equal(path.basename(selected),path.basename(f.original.path));
    assert.equal(createHash('sha256').update(fs.readFileSync(selected)).digest('hex'),f.original.sha256);
    assert.match(selected,/work[\\/]input[\\/]/);
  });
});

test('Astra cannot turn an unsupported OBJ plus viewport derivative into a production GLB input',async t=>{
  const f=fixture(t,'obj');f.args.task.taskId='M05';f.args.task.instruction='Keep exact source geometry while adjusting bounded vertices.';f.args.task.objectSnapshot={name:f.args.object.name,kind:f.args.object.kind,references:[],accepted:f.args.object.accepted};
  let workerCalls=0;const execute=createGraphicsAstraExecutor({workerFactory:()=>{workerCalls++;throw Error('worker forbidden');}});
  await assert.rejects(execute(f.args),/원본 BLEND|원본 버전/);assert.equal(workerCalls,0);
});

test('BLEND-only API and UV preflight never select viewport GLB; FBX and native GLB aliases retain original bytes',async t=>{
  for(const extension of ['blend','fbx','glb'])await t.test(extension,async child=>{
    const f=fixture(child,extension),store=new Store(path.join(f.root,'store'));await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
    const engine=new Engine(store,new Proxy({}, {get:()=>()=>{throw Error('network forbidden');}}) as any),project=engine.create('test');
    const graphics=new GraphicsEngine(store,engine,{resources:path.resolve('integrations')});child.after(()=>{graphics.shutdown();store.db.close();});
    for(const file of f.version.files)store.write(project.id,file.path,fs.readFileSync(path.join(f.root,file.path)));
    const workspace=await graphics.action(project.id,{kind:'create-object',name:'test',objectKind:'prop'}),object=workspace.objects[0];f.version.objectId=object.id;
    const quote=()=> (graphics as any).apiQuote(workspace,object,{taskId:'T01',settings:{},instruction:''},[f.version]);
    if(extension==='blend'){
      assert.throws(quote,/원본이 필요|먼저 형식/);
      await assert.rejects((graphics as any).requireTextureSurface(project.id,f.version,new AbortController().signal),/원본이 필요/);
      assert.equal(store.project(project.id).assets.length,0);
    }else{quote();const alias=store.project(project.id).assets.find(a=>a.id==='graphics-version')!;assert.equal(alias.file,f.original.path);}
    assert.equal(store.project(project.id).jobs.length,0);
  });
});

test('Unity ignores viewport-only models and does not verify or stage their bytes as native input',async t=>{
  const f=fixture(t),unity=path.join(f.root,'Unity');
  const put=(name:string,data:string)=>{const p=path.join(unity,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,data);};
  put('Assets/keep.txt','keep');put('ProjectSettings/ProjectVersion.txt','m_EditorVersion: 6000.3.21f1\n');put('ProjectSettings/GraphicsSettings.asset','m_CustomRenderPipeline: {fileID: 0}\n');put('ProjectSettings/QualitySettings.asset','m_CurrentQuality: 0\nm_QualitySettings:\n- customRenderPipeline: {fileID: 0}\n');put('Packages/manifest.json','{"dependencies":{}}');
  fs.unlinkSync(path.join(f.root,f.preview.path));
  const args={projectRoot:f.root,object:f.args.object,versions:[f.version],profile:readUnityTarget(unity),resources:path.resolve('integrations'),blenderPath:''};
  const delivery=await prepareUnityDelivery(args);assert.equal(delivery.status,'failed');assert.match(delivery.errors.join(' '),/Blender 실행 파일/);
  f.version.files=[f.preview];
  await assert.rejects(prepareUnityDelivery(args),/원본 모델 버전/);
});
