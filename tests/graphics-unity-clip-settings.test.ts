import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeUnityClipSettings } from '../engine/graphics';
import type { AssetVersion, GraphicsTask, GraphicsWorkspace } from '../shared/graphics';

const version = (id: string, name: string, type: AssetVersion['provenance']['type'] = 'codex'): AssetVersion => ({ id, objectId:'rabbit', role:'animation', slot:name, label:name, files:[], createdAt:'test', sourceVersionIds:[], provenance:{type}, warnings:[] });
const producer = (v: AssetVersion, loop: boolean, rootMotion = false): GraphicsTask => ({ id:`producer-${v.id}`, objectId:v.objectId, taskId:'N05', settings:{clipName:v.slot,loop,rootMotion,fps:30}, outputVersionIds:[v.id] } as unknown as GraphicsTask);
const workspace = (tasks: GraphicsTask[]): GraphicsWorkspace => ({tasks, objects:[{id:'rabbit',settings:{clipName:'Changed form',loop:false,rootMotion:true,fps:60}}]} as unknown as GraphicsWorkspace);

test('Unity freezes each adopted clip producer independently of current form and batch child provenance',()=>{
  const idle=version('idle','Rabbit_Idle'), jump=version('jump','토끼 점프.v2|원본');
  idle.provenance.jobId='parent-c2';
  const w=workspace([producer(idle,true),producer(jump,false)]);
  const settings=freezeUnityClipSettings(w,[idle,jump]);
  assert.deepEqual(settings,[{versionId:'idle',name:'Rabbit_Idle',loop:true,rootMotion:false,fps:30},{versionId:'jump',name:'토끼 점프.v2|원본',loop:false,rootMotion:false,fps:30}]);
  w.tasks[0].settings.loop=false;
  assert.equal(settings[0].loop,true);
});

test('unproven generated motion cannot invent delivery settings; imports keep unknown contracts',()=>{
  const v=version('missing','Idle');
  assert.throws(()=>freezeUnityClipSettings(workspace([]),[v]),/생성 설정/);
  assert.deepEqual(freezeUnityClipSettings(workspace([]),[version('import','Walk','import')]),[]);
  const p=producer(v,true);p.settings.clipName='different';
  assert.throws(()=>freezeUnityClipSettings(workspace([p]),[v]),/원래 클립/);
  p.settings.clipName=v.slot;p.settings.fps=Infinity;
  assert.throws(()=>freezeUnityClipSettings(workspace([p]),[v]),/FPS/);
});
