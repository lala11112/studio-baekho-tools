import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modelGeometryCapabilities, modelGeometryProblem, requireModelGeometry, changeModelGeometry } from '../shared/graphics-model-geometry';
import { defaultCreation, humanParts, creationSettings, compileCreation, effectiveCreation, updateCreationModelGeometry, validateCreation } from '../shared/graphics-creation';
import type { GraphicsObject } from '../shared/graphics';
import type { Quote } from '../shared/types';
import type { Tripo } from '../engine/tripo';
import { Store } from '../engine/store';
import { Engine } from '../engine/engine';
import { GraphicsEngine } from '../engine/graphics';

function object(): GraphicsObject { return { id:'o',name:'fixture',kind:'prop',createdAt:'',selectedTasks:[],instruction:'prop',settings:{},references:[],accepted:{},creation:defaultCreation('prop') }; }

test('new object and every human part start at 5,000 quad; explicit old settings are read without mutation', () => {
  const fresh = object();
  assert.equal(compileCreation(fresh,'M01').settings.faceLimit,5000);
  assert.equal(compileCreation(fresh,'M01').settings.quad,true);
  assert(humanParts().every(part=>part.faceLimit===5000));
  fresh.creation!.stageSettings.model!.values = { model:'P2-20260801', faceLimit:10000,quad:false };
  const before=structuredClone(fresh);
  assert.equal(compileCreation(fresh,'M01').settings.faceLimit,10000);
  assert.equal(compileCreation(fresh,'M01').settings.quad,false);
  assert.deepEqual(fresh,before);
  delete fresh.creation;fresh.settings={model:'P1-20260311',faceLimit:20000};
  const legacy=structuredClone(fresh);
  assert.equal(creationSettings(fresh,'model').quad,false);
  assert.equal(effectiveCreation(fresh).stageSettings.model!.values.model,'P1-20260311');
  assert.deepEqual(fresh,legacy);
});

test('P2 and P1 boundaries and required topology use the same validation without rounding explicit numbers', () => {
  for(const [model,quad,min,max] of [['P2-20260801',true,1000,25000],['P2-20260801',false,1000,50000],['P1-20260311',false,1000,20000]] as const){
    for(const faceLimit of [min,max,5001]) assert.equal(modelGeometryProblem({model,quad,faceLimit}),undefined);
    for(const faceLimit of [min-1,max+1,1000.5,'']) assert(modelGeometryProblem({model,quad,faceLimit}));
  }
  assert.match(modelGeometryProblem({model:'P1-20260311',quad:true,faceLimit:5000})!,/삼각형/);
  assert.match(modelGeometryProblem({model:'P2-20260801',quad:'',faceLimit:5000})!,/메시 형태 선택/);
  assert.equal(requireModelGeometry({model:'P1-20260311'}).quad,false);
  assert.equal(modelGeometryCapabilities({modelMethod:'local',quad:true}).min,100);
  assert.equal(modelGeometryCapabilities({modelMethod:'astra'}).basis,'authoring-target');
  assert.equal(modelGeometryCapabilities({model:'v3.1-20260211',quad:true}).max,1000000);
});

test('explicit tri-to-quad change clamps visibly, while cleared and invalid saved values remain untouched', () => {
  const saved={model:'P2-20260801',quad:false,faceLimit:50000};
  const change=changeModelGeometry(saved,{quad:true});
  assert.deepEqual(change.patch,{quad:true,faceLimit:25000});assert.match(change.notice!,/50,000 → 25,000/);
  assert.deepEqual(saved,{model:'P2-20260801',quad:false,faceLimit:50000});
  assert.deepEqual(changeModelGeometry({...saved,quad:true},{quad:''}).patch,{quad:''});
  const p1=changeModelGeometry(saved,{model:'P1-20260311'});
  assert.equal(p1.patch.faceLimit,20000);
  const o=object();o.creation!.stageSettings.model!.values={model:'P2-20260801',quad:true,faceLimit:50000};
  const before=structuredClone(o);validateCreation(o.creation!,'prop');creationSettings(o,'model');
  assert.throws(()=>compileCreation(o,'M01'),/25,000/);assert.deepEqual(o,before);
});

test('part targets change atomically with topology and individual edits keep other targets and saved results', () => {
  const c=defaultCreation('character');c.attributes.composition='parts';c.parts=humanParts();c.activePartId='head';
  c.stageSettings.model!.values={modelMethod:'tripo',model:'P2-20260801',quad:false,faceLimit:50000};
  c.parts[0].faceLimit=50000;c.parts[1].faceLimit=30000;c.parts[2].faceLimit=7500;
  const changed=updateCreationModelGeometry(c,{quad:true},true);
  assert.deepEqual(changed.spec.parts.map(part=>part.faceLimit),[25000,25000,7500]);
  assert.match(changed.notice!,/머리:/);assert.match(changed.notice!,/몸통:/);
  assert.deepEqual(c.parts.map(part=>part.faceLimit),[50000,30000,7500]);
  const clear=updateCreationModelGeometry(changed.spec,{faceLimit:''});
  assert.deepEqual(clear.spec.parts.map(part=>part.faceLimit),['',25000,7500]);
  validateCreation(clear.spec,'character');
  assert.throws(()=>compileCreation({...object(),kind:'character',creation:clear.spec},'M01'),/목표 면 수 선택/);
  const p1=updateCreationModelGeometry(changed.spec,{model:'P1-20260311'},true);
  assert.equal(p1.spec.stageSettings.model!.values.quad,false);
  assert.deepEqual(p1.spec.parts.map(part=>part.faceLimit),[20000,20000,7500]);
});

test('real GraphicsEngine preparation rejects invalid requests before quotation and freezes exact geometry in quote',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'graphics-density-')),store=new Store(root);await store.open(path.resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
  let calls=0;const api=new Proxy({},{get:()=>()=>{calls++;throw Error('No remote call authorized in preparation test');}}) as Tripo;
  const engine=new Engine(store,api),graphics=new GraphicsEngine(store,engine,{resources:path.resolve('integrations')}),project=engine.create('geometry limits');
  t.after(()=>{graphics.shutdown();store.db.close();fs.rmSync(root,{recursive:true,force:true});});
  let w=await graphics.action(project.id,{kind:'create-object',name:'Geometry',objectKind:'prop'});const objectId=w.objects[0].id;
  assert.equal(w.objects[0].settings.faceLimit,5000);assert.equal(w.objects[0].settings.quad,true);
  for(const settings of [
    {model:'P2-20260801',faceLimit:50000,quad:true},{model:'P2-20260801',faceLimit:5000,quad:''},
    {model:'P1-20260311',faceLimit:20001,quad:false},{model:'P1-20260311',faceLimit:5000,quad:true},
  ]){
    await graphics.action(project.id,{kind:'update-object',objectId,patch:{instruction:'A stone',settings}});
    const before=graphics.get(project.id);await assert.rejects(graphics.action(project.id,{kind:'prepare',objectId,taskId:'M03'}));
    assert.deepEqual(graphics.get(project.id),before);assert.equal(store.all<Quote>('quote').length,0);
  }
  for(const [model,quad,faceLimit] of [['P2-20260801',true,25000],['P2-20260801',false,50000],['P1-20260311',false,20000]] as const){
    await graphics.action(project.id,{kind:'update-object',objectId,patch:{settings:{model,quad,faceLimit}}});
    w=await graphics.action(project.id,{kind:'prepare',objectId,taskId:'M03'});const task=w.tasks.at(-1)!,quote=store.get<Quote>('quote',task.quoteId!)!;
    assert.equal(task.settings.quad,quad);assert.equal(task.settings.faceLimit,faceLimit);
    assert.equal(quote.request.quad,quad);assert.equal(quote.request.faceLimit,faceLimit);assert.equal(quote.request.model,model);
    await graphics.action(project.id,{kind:'cancel',taskId:task.id});
  }
  assert.equal(calls,0);assert.equal(store.project(project.id).jobs.length,0);
});
