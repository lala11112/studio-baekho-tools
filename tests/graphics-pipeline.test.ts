import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { Store } from "../engine/store";
import { Engine } from "../engine/engine";
import { GraphicsEngine } from "../engine/graphics";
import type { Tripo } from "../engine/tripo";
import type { GraphicsNativeArgs, GraphicsNativeResult } from "../engine/graphics-native";
import type { AssetVersion, GraphicsRole } from "../shared/graphics";
import { graphicsApprovalState, graphicsTripoReserved } from "../shared/graphics-catalog";

async function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-graphics-pipeline-"));
  const store = new Store(root); await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  let paid = 0; const dispatched: GraphicsNativeArgs[] = [];
  const api = { balance: async () => ({ balance: 1000 }), submit: async () => { paid++; return { task_id: `remote-${paid}` }; }, upload: async () => "token" } as unknown as Tripo;
  const engine = new Engine(store, api), p = engine.create("Isolated pipeline");
  let astra: (a: GraphicsNativeArgs) => Promise<GraphicsNativeResult> = async () => { throw Error("Injected authoring failure"); };
  let video: typeof astra = async () => { throw Error("Injected video failure before submission"); };
  const videoDispatches: GraphicsNativeArgs[] = [];
  const options = { resources: path.resolve("integrations"), astra: async (a: GraphicsNativeArgs) => { dispatched.push(a); return astra(a); }, video: async (a: GraphicsNativeArgs) => { videoDispatches.push(a); return video(a); } };
  let graphics = new GraphicsEngine(store, engine, options);
  const initial = await graphics.action(p.id, { kind: "create-object", objectKind: "character", name: "Character" });
  const objectId = initial.objects[0].id;
  const action = (a: Parameters<GraphicsEngine["action"]>[1]) => graphics.action(p.id, a);
  await action({kind:"update-object", objectId, patch:{instruction:"A static character",settings:{count:1,clipName:"Idle"}}});
  const idle = async () => { for(let i=0;i<200;i++){if(!graphics.isActive(p.id) && !engine.isProjectActive(p.id))return;await new Promise(r=>setTimeout(r,5));}throw Error("Worker did not settle"); };
  t.after(async()=>{graphics.shutdown();await idle();store.db.close();const actual=fs.realpathSync(root);assert.equal(path.dirname(actual),fs.realpathSync(os.tmpdir()));fs.rmSync(actual,{recursive:true,force:true});});
  return {root,store,engine,get graphics(){return graphics;},p,objectId,action,idle,dispatched,videoDispatches,get paid(){return paid;},
    setAstra:(next:typeof astra)=>{astra=next;},setVideo:(next:typeof video)=>{video=next;},
    restart:()=>{graphics.shutdown();graphics=new GraphicsEngine(store,engine,options);},
    seed:(role:GraphicsRole,slot="main",sourceVersionIds:string[]=[])=>{
      const workspace=graphics.get(p.id),id=`version-${workspace.versions.length+1}`,extension=role==="design"?".png":role==="motion-reference"?".mp4":".blend";
      const file=`graphics/fixture/${id}${extension}`;
      const png=new PNG({width:32,height:32});png.data.fill(200);
      const bytes=role==="design"?PNG.sync.write(png):Buffer.from(`synthetic ${id} ${role}`);
      store.write(p.id,file,bytes);
      const version:AssetVersion={id,objectId,role,slot,sourceVersionIds,label:id,createdAt:"2026-10-13",provenance:{type:"local"},warnings:[],files:[{path:file,kind:role==="design"?"image":role==="motion-reference"?"video":"blend",bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")}]};
      workspace.versions.push(version);store.put("graphics",p.id,workspace);return version;
    },
    output:(args:GraphicsNativeArgs,role:GraphicsRole,slot="main"):GraphicsNativeResult=>{
      const file=`graphics/fixture/result-${args.task.id}.blend`;store.write(p.id,file,Buffer.from("synthetic saved result"));
      return {files:[{path:file,kind:"blend"}],role,slot,label:"Injected saved result",warnings:["Synthetic boundary; no actual authoring or native quality claim"]};
    },
  };
}
test("Tripo approval cap persists and stops a paid request before dispatch without resetting prior approvals", async t=>{
  const f=await fixture(t);
  await f.action({kind:"set-tripo-budget",credits:100});
  const one=(await f.action({kind:"prepare",objectId:f.objectId,taskId:"M03"})).tasks.at(-1)!;
  await f.action({kind:"approve",taskId:one.id});
  for(let i=0;i<100 && !f.store.project(f.p.id).jobs[0]?.remoteId;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(f.paid,1);
  await f.action({kind:"cancel",taskId:one.id});
  await f.idle();
  const two=(await f.action({kind:"prepare",objectId:f.objectId,taskId:"M03"})).tasks.at(-1)!;
  await assert.rejects(f.action({kind:"approve",taskId:two.id}),/한도/);
  assert.equal(f.paid,1);assert.equal(graphicsTripoReserved(f.graphics.get(f.p.id)),100);
  const reopened=new GraphicsEngine(f.store,f.engine,{resources:path.resolve("integrations")});
  assert.equal(reopened.get(f.p.id).tripoBudget?.limit,100);
  await assert.rejects(f.action({kind:"set-tripo-budget",credits:99}),/이미 승인/);
});
test("rig and video-based motion cannot silently start without accepted inputs",async t=>{
  const f=await fixture(t);
  await assert.rejects(f.action({kind:"prepare",objectId:f.objectId,taskId:"R02"}),/모델/);
  await assert.rejects(f.action({kind:"prepare",objectId:f.objectId,taskId:"N04"}),/리그/);
  assert.equal(f.dispatched.length,0);assert.equal(f.paid,0);
});
test("app-owned Astra approval dispatches once and preserves model after correction failure",async t=>{
  const f=await fixture(t),source=path.join(f.root,"source.glb");fs.writeFileSync(source,"synthetic authoring-boundary model");
  const version=f.graphics.importFiles(f.p.id,f.objectId,"model",[source]).versions[0];
  await f.action({kind:"accept",objectId:f.objectId,versionId:version.id});
  const task=(await f.action({kind:"prepare",objectId:f.objectId,taskId:"M05"})).tasks.at(-1)!;
  assert.equal(graphicsApprovalState(task,Date.now()),"execute");assert.equal(f.dispatched.length,0);
  await f.action({kind:"approve",taskId:task.id});await f.idle();
  assert.equal(f.dispatched.length,1);assert.deepEqual(f.dispatched[0].task.inputVersionIds,[version.id]);
  const w=f.graphics.get(f.p.id);assert.equal(w.tasks.at(-1)?.status,"failed");assert.equal(w.objects[0].accepted["model:main"],version.id);assert.equal(w.versions.length,1);
});

test("R01 approval uses the frozen source/settings after acceptance changes and restart, without adopting output",async t=>{
  const f=await fixture(t),original=f.seed("model");
  await f.action({kind:"accept",objectId:f.objectId,versionId:original.id});
  await f.action({kind:"update-object",objectId:f.objectId,patch:{instruction:"Preserve face and create humanoid rig",settings:{rigHair:true,rigTail:false}}});
  const task=(await f.action({kind:"prepare",objectId:f.objectId,taskId:"R01"})).tasks.at(-1)!;
  const replacement=f.seed("model");await f.action({kind:"accept",objectId:f.objectId,versionId:replacement.id});
  await f.action({kind:"update-object",objectId:f.objectId,patch:{instruction:"New unrelated request",settings:{rigHair:false}}});
  f.restart();assert.equal(f.dispatched.length,0);
  f.setAstra(async a=>{
    assert.deepEqual(a.task.inputVersionIds,[original.id]);assert.equal(a.task.settings.sourceVersionId,original.id);
    assert.equal(a.task.settings.rigHair,true);assert.equal(a.task.instruction,"Preserve face and create humanoid rig");
    assert.equal(a.object.accepted["model:main"],original.id);assert.equal(a.recoveryOnly,false);
    return f.output(a,"rig");
  });
  await f.action({kind:"approve",taskId:task.id});await f.idle();
  const w=f.graphics.get(f.p.id),result=w.versions.find(v=>v.id===w.tasks.at(-1)!.outputVersionIds[0])!;
  assert.equal(w.tasks.at(-1)!.status,"review");assert.equal(w.objects[0].accepted["model:main"],replacement.id);
  assert.equal(w.objects[0].accepted["rig:main"],undefined);assert.deepEqual(result.sourceVersionIds,[original.id]);
  f.restart();assert.equal(f.dispatched.length,1);assert.equal(f.paid,0);
});

test("N04 freezes accepted rig and same-clip reference; N06 retains that reference after new acceptances",async t=>{
  const f=await fixture(t),rig=f.seed("rig"),reference=f.seed("motion-reference","Idle");
  await f.action({kind:"accept",objectId:f.objectId,versionId:rig.id});await f.action({kind:"accept",objectId:f.objectId,versionId:reference.id});
  const task=(await f.action({kind:"prepare",objectId:f.objectId,taskId:"N04"})).tasks.at(-1)!;
  const newerRig=f.seed("rig"),newerReference=f.seed("motion-reference","Idle");
  await f.action({kind:"accept",objectId:f.objectId,versionId:newerRig.id});await f.action({kind:"accept",objectId:f.objectId,versionId:newerReference.id});
  f.restart();
  f.setAstra(async a=>{
    assert.deepEqual(a.task.inputVersionIds,[rig.id,reference.id]);
    assert.equal(a.object.accepted["rig:main"],rig.id);assert.equal(a.object.accepted["motion-reference:Idle"],reference.id);
    return f.output(a,"animation","Idle");
  });
  await f.action({kind:"approve",taskId:task.id});await f.idle();
  const animated=f.graphics.get(f.p.id).versions.at(-1)!;
  assert.equal(f.graphics.get(f.p.id).objects[0].accepted["animation:Idle"],undefined);
  await f.action({kind:"accept",objectId:f.objectId,versionId:animated.id});
  const revision=(await f.action({kind:"prepare",objectId:f.objectId,taskId:"N06"})).tasks.at(-1)!;
  assert.deepEqual(revision.inputVersionIds,[animated.id,reference.id]);
  assert(!revision.inputVersionIds.includes(newerRig.id));assert(!revision.inputVersionIds.includes(newerReference.id));
  f.restart();f.setAstra(async a=>{
    assert.equal(a.task.settings.sourceVersionId,animated.id);assert.deepEqual(a.inputs.map(v=>v.id),[animated.id,reference.id]);
    return f.output(a,"animation","Idle");
  });
  await f.action({kind:"approve",taskId:revision.id});await f.idle();
  const w=f.graphics.get(f.p.id);assert.equal(w.tasks.at(-1)!.status,"review");
  assert.equal(w.objects[0].accepted["animation:Idle"],animated.id);
  assert.equal(w.objects[0].accepted["rig:main"],newerRig.id);assert.equal(w.objects[0].accepted["motion-reference:Idle"],newerReference.id);
  assert.equal(f.dispatched.length,2);assert.equal(f.paid,0);
});

test("recovery before any Astra dispatch cannot start a first worker; durable saved execution recovers with explicit recoveryOnly",async t=>{
  const f=await fixture(t),model=f.seed("model");await f.action({kind:"accept",objectId:f.objectId,versionId:model.id});
  const task=(await f.action({kind:"prepare",objectId:f.objectId,taskId:"R01"})).tasks.at(-1)!;
  await f.action({kind:"approve",taskId:task.id});await f.idle();
  f.restart();await assert.rejects(f.action({kind:"recover",taskId:task.id}),/새 GPT 요청/);assert.equal(f.dispatched.length,1);
  f.store.write(f.p.id,`graphics/jobs/${task.id}/astra/dispatch.json`,JSON.stringify({taskId:task.id,identity:"synthetic saved boundary"}));
  f.setAstra(async a=>{assert.equal(a.recoveryOnly,true);assert.equal(a.task.requestHash,task.requestHash);return f.output(a,"rig");});
  await f.action({kind:"recover",taskId:task.id});await f.idle();
  assert.equal(f.graphics.get(f.p.id).tasks.length,1);assert.equal(f.graphics.get(f.p.id).tasks[0].status,"review");
  assert.equal(f.dispatched.length,2);assert.equal(f.paid,0);
});

test("ambiguous N02 stays submission_unknown, blocks a fresh job and requires remote evidence for recovery",async t=>{
  const f=await fixture(t),source=f.seed("design");await f.action({kind:"accept",objectId:f.objectId,versionId:source.id});
  await f.action({kind:"update-object",objectId:f.objectId,patch:{settings:{motionSourceVersionId:source.id,motionSourcePath:source.files[0].path,motionSourceView:"left",duration:2,fps:30,loop:true}}});
  f.setVideo(async()=>{throw Object.assign(Error("Lost response after video submission"),{code:"submission_unknown"});});
  const task=(await f.action({kind:"prepare",objectId:f.objectId,taskId:"N02"})).tasks.at(-1)!;
  await f.action({kind:"approve",taskId:task.id});await f.idle();
  let current=f.graphics.get(f.p.id).tasks[0];assert.equal(current.status,"submission_unknown");assert.equal(current.errorCode,"submission_unknown");
  assert.equal(current.paidApproval?.credits,24);assert.equal(f.videoDispatches.length,1);
  f.restart();await assert.rejects(f.action({kind:"prepare",objectId:f.objectId,taskId:"N02"}),/기존 작업/);
  await assert.rejects(f.action({kind:"recover",taskId:task.id}),/첫 업로드·유료 제출/);assert.equal(f.videoDispatches.length,1);
  current=f.graphics.get(f.p.id).tasks[0];assert.equal(current.status,"submission_unknown");
  f.store.write(f.p.id,`graphics/jobs/${task.id}/external-request.json`,JSON.stringify({jobId:task.id}));
  f.store.write(f.p.id,`graphics/video-journal/${f.objectId}/${task.id}-state.json`,JSON.stringify({taskId:"existing-remote-video"}));
  f.setVideo(async a=>{assert.equal(a.recoveryOnly,true);assert.equal(a.task.paidApproval?.requestHash,task.requestHash);return f.output(a,"motion-reference","Idle");});
  await f.action({kind:"recover",taskId:task.id});await f.idle();
  const w=f.graphics.get(f.p.id);assert.equal(w.tasks.length,1);assert.equal(w.tasks[0].status,"review");
  assert.equal(w.objects[0].accepted["motion-reference:Idle"],undefined);assert.equal(f.videoDispatches.length,2);assert.equal(f.paid,0);
});

test("imported animation stores the exact clip slot and N06 freezes that native original without a new rig",async t=>{
  const f=await fixture(t),source=path.join(f.root,"external-animation.blend");fs.writeFileSync(source,"synthetic imported native blend");
  const bytes=fs.readFileSync(source),before=f.graphics.get(f.p.id);
  const imported=f.graphics.importFiles(f.p.id,f.objectId,"animation",[source],"Rabbit_Idle").versions.at(-1)!;
  assert.equal(imported.slot,"Rabbit_Idle");assert.equal(imported.files[0].kind,"blend");assert.equal(imported.provenance.type,"import");
  assert.deepEqual(fs.readFileSync(f.store.file(f.p.id,imported.files[0].path)),bytes);
  assert.deepEqual(f.graphics.get(f.p.id).objects[0].accepted,before.objects[0].accepted);assert.equal(f.dispatched.length,0);
  await f.action({kind:"accept",objectId:f.objectId,versionId:imported.id});
  const otherRig=f.seed("rig");await f.action({kind:"accept",objectId:f.objectId,versionId:otherRig.id});
  await f.action({kind:"update-object",objectId:f.objectId,patch:{settings:{clipName:"Wrong_Clip"}}});
  await assert.rejects(f.action({kind:"prepare",objectId:f.objectId,taskId:"N06"}),/수정할 클립/);
  await f.action({kind:"update-object",objectId:f.objectId,patch:{settings:{clipName:"Rabbit_Idle",actionName:"Another_Action"},instruction:"Raise the existing right hand slightly"}});
  await assert.rejects(f.action({kind:"prepare",objectId:f.objectId,taskId:"N06"}),/원래 액션 이름/);
  await f.action({kind:"update-object",objectId:f.objectId,patch:{settings:{actionName:"Rabbit_Idle"}}});
  const task=(await f.action({kind:"prepare",objectId:f.objectId,taskId:"N06"})).tasks.at(-1)!;
  assert.deepEqual(task.inputVersionIds,[imported.id]);assert.equal(task.settings.actionName,"Rabbit_Idle");
  assert.equal(task.settings.sourceVersionId,imported.id);f.restart();
  f.setAstra(async a=>{assert.deepEqual(a.inputs.map(v=>v.id),[imported.id]);assert.equal(a.task.settings.clipName,a.inputs[0].slot);assert.equal(a.task.settings.actionName,a.inputs[0].slot);throw Error("Native preflight boundary; no actual worker");});
  await f.action({kind:"approve",taskId:task.id});await f.idle();
  const w=f.graphics.get(f.p.id);assert.equal(w.tasks.at(-1)!.status,"failed");assert.equal(w.objects[0].accepted["animation:Rabbit_Idle"],imported.id);
  assert.deepEqual(fs.readFileSync(source),bytes);assert.deepEqual(fs.readFileSync(f.store.file(f.p.id,imported.files[0].path)),bytes);assert.equal(f.paid,0);
});

test("animation imports reject missing or unsafe names, noneditable formats and multiple scenes before adding versions",async t=>{
  const f=await fixture(t),blend=path.join(f.root,"clip.blend"),fbx=path.join(f.root,"clip.fbx"),png=path.join(f.root,"frame.png");
  for(const file of [blend,fbx,png])fs.writeFileSync(file,"synthetic source");
  for(const name of [undefined,""," ",".","..","../Idle","Idle/Jump","Idle\\Jump","Idle\u0000","Idle\nJump","a".repeat(101)])
    assert.throws(()=>f.graphics.importFiles(f.p.id,f.objectId,"animation",[blend],name),/정확한 Blender 액션 이름/);
  for(const files of [[fbx],[png],[blend,png],[blend,blend]])
    assert.throws(()=>f.graphics.importFiles(f.p.id,f.objectId,"animation",files,"Idle"),/\.blend 원본 한 개/);
  assert.equal(f.graphics.get(f.p.id).versions.length,0);assert.equal(f.dispatched.length,0);assert.equal(f.paid,0);
});

test("import and N06 preserve native Unicode, spaces, dot and pipe Action names without sanitizing slots",async t=>{
  const f=await fixture(t),blend=path.join(f.root,"native-action-names.blend");fs.writeFileSync(blend,"synthetic native blend");
  for(const clipName of ["Armature|Take 001","Idle.001","걷기 동작"," Armature|대기 001.001 "]){
    const imported=f.graphics.importFiles(f.p.id,f.objectId,"animation",[blend],clipName).versions.at(-1)!;
    assert.equal(imported.slot,clipName);assert(!imported.files[0].path.includes(clipName));
    await f.action({kind:"accept",objectId:f.objectId,versionId:imported.id});
    await f.action({kind:"update-object",objectId:f.objectId,patch:{settings:{clipName},instruction:"원래 동작의 팔 높이만 수정"}});
    const prepared=await f.action({kind:"prepare",objectId:f.objectId,taskId:"N06"}),task=prepared.tasks.at(-1)!;
    assert.equal(task.settings.clipName,clipName);assert.equal(task.settings.actionName,clipName);assert.deepEqual(task.inputVersionIds,[imported.id]);
    await f.action({kind:"cancel",taskId:task.id});
  }
  f.restart();assert.equal(f.graphics.get(f.p.id).versions.length,4);assert.equal(f.dispatched.length,0);assert.equal(f.paid,0);
});

test("nonanimation import grouping, main slots and preexisting animation records remain unchanged",async t=>{
  const f=await fixture(t),existing=f.seed("animation","main"),before=structuredClone(existing);
  const mesh=path.join(f.root,"model.fbx"),texture=path.join(f.root,"texture.png"),image2=path.join(f.root,"other.png");
  for(const file of [mesh,texture,image2])fs.writeFileSync(file,"unchanged import bytes");
  const model=f.graphics.importFiles(f.p.id,f.objectId,"model",[mesh,texture],"Ignored_Clip").versions.at(-1)!;
  assert.equal(model.slot,"main");assert.equal(model.files.length,2);assert.equal(model.role,"model");
  const w=f.graphics.importFiles(f.p.id,f.objectId,"design",[texture,image2],"Ignored_Clip");
  assert.equal(w.versions.length,4);assert(w.versions.slice(-2).every(v=>v.slot==="main"&&v.files.length===1));
  assert.deepEqual(w.versions.find(v=>v.id===existing.id),before);assert.deepEqual(w.objects[0].accepted,{});
});
