import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssetVersion, GraphicsTask } from '../shared/graphics';
import { hasPersistedNativeMeterUnits } from '../shared/graphics-size-provenance';
const version = { id:'output', objectId:'object', provenance:{type:'local',jobId:'producer'} } as AssetVersion;
const task = { createdAt:'test',updatedAt:'test',inputVersionIds:[],instruction:'',requestHash:'hash',backendJobIds:[],message:'',id:'producer',objectId:'object',taskId:'A05',status:'review',localOnly:true,outputVersionIds:['output'],settings:{physicalSize:JSON.stringify({mode:'uniform',axis:'x',lengthMeters:2.5})} } as GraphicsTask;
test('only exact successful local A05/X04 outputs inherit frozen native meter calibration',()=>{
  assert.equal(hasPersistedNativeMeterUnits(version,[task]),true);
  assert.equal(hasPersistedNativeMeterUnits(version,[{...task,taskId:'X04'}]),true);
  for(const change of [{status:'failed'},{objectId:'other'},{id:'other'},{outputVersionIds:['other']},{taskId:'M09'},{localOnly:false}])
    assert.equal(hasPersistedNativeMeterUnits(version,[{...task,...change} as GraphicsTask]),false);
  assert.equal(hasPersistedNativeMeterUnits(version,[task,task]),false);
});
test('imports, legacy keep and malformed settings stay unknown regardless of unrelated draft/tasks',()=>{
  assert.equal(hasPersistedNativeMeterUnits({...version,provenance:{type:'import'}},[task]),false);
  assert.equal(hasPersistedNativeMeterUnits({...version,provenance:{type:'legacy',jobId:task.id}},[task]),false);
  for(const physicalSize of [undefined,'',JSON.stringify({mode:'keep'}),'broken',JSON.stringify({mode:'uniform',lengthMeters:-1})])
    assert.equal(hasPersistedNativeMeterUnits(version,[{...task,settings:{physicalSize} as GraphicsTask['settings']}]),false);
  assert.equal(hasPersistedNativeMeterUnits(version,[{...task,id:'draft',settings:{physicalSize:task.settings.physicalSize}}]),false);
});
