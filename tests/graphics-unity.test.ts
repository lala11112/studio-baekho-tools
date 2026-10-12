import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { readUnityTarget,prepareUnityDelivery,inspectUnityDelivery,cancelUnityDelivery } from "../engine/graphics-unity";
import type { GraphicsObject,AssetVersion } from "../shared/graphics";

const sha=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex");
const put=(root:string,file:string,text:string|Buffer)=>{const p=path.join(root,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text);return p;};
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"graphics-unity-test-"));
 const unity=path.join(root,"Unity 한국어"),project=path.join(root,"Partsmith");
 fs.mkdirSync(path.join(unity,"Assets"),{recursive:true});fs.mkdirSync(project);
 put(unity,"ProjectSettings/ProjectVersion.txt","m_EditorVersion: 6000.3.21f1\n");
 put(unity,"ProjectSettings/GraphicsSettings.asset","GraphicsSettings:\n  m_CustomRenderPipeline: {fileID: 0}\n");
 put(unity,"ProjectSettings/QualitySettings.asset","QualitySettings:\n  m_CurrentQuality: 0\n  m_QualitySettings:\n  - serializedVersion: 4\n    customRenderPipeline: {fileID: 0}\n  m_PerPlatformDefaultQuality:\n    Standalone: 0\n");
 put(unity,"Packages/manifest.json",JSON.stringify({dependencies:{"com.unity.render-pipelines.universal":"17.3.0"}}));
 const image=new PNG({width:2,height:2});image.data.fill(255);const png=PNG.sync.write(image);
 put(project,"assets/원본.png",png);
 const object:GraphicsObject={id:"fixture-object",name:"아이콘",kind:"sprite",createdAt:new Date().toISOString(),selectedTasks:[],instruction:"",settings:{},references:[],accepted:{}};
 const version:AssetVersion={id:"version-1",objectId:object.id,role:"design",slot:"default",label:"원본",files:[{path:"assets/원본.png",sha256:sha(png),bytes:png.length,kind:"image"}],createdAt:object.createdAt,sourceVersionIds:[],provenance:{type:"import"},warnings:[]};
 const args=()=>({projectRoot:project,object,versions:[version],profile:readUnityTarget(unity),blenderPath:"",resources:path.resolve("integrations")});
 const cleanup=()=>{assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});};
 return{root,unity,project,object,version,args,cleanup};
}
test("Unity PC profile uses actual pipeline asset and quality override, never package presence",()=>{
 const f=fixture();try{
  assert.equal(readUnityTarget(f.unity).pipeline,"builtin");
  const guid="a".repeat(32);
  put(f.unity,"Assets/Settings/PC.asset.meta",`fileFormatVersion: 2\nguid: ${guid}\n`);
  put(f.unity,"Assets/Settings/PC.asset","MonoBehaviour:\n  m_RendererDataList: []\n");
  put(f.unity,"ProjectSettings/QualitySettings.asset",`QualitySettings:\n  m_CurrentQuality: 0\n  m_QualitySettings:\n  - serializedVersion: 4\n    customRenderPipeline: {fileID: 0}\n  - serializedVersion: 4\n    customRenderPipeline: {fileID: 11400000, guid: ${guid},\n      type: 2}\n  m_PerPlatformDefaultQuality:\n    Standalone: 1\n`);
  const p=readUnityTarget(f.unity);assert.equal(p.pipeline,"urp");assert.equal(p.platform,"pc");
  put(f.unity,"Assets/Settings/PC.asset","MonoBehaviour:\n  m_RendererDataList: []\n  changed: 1\n");
  assert.notEqual(readUnityTarget(f.unity).fingerprint,p.fingerprint);
  fs.unlinkSync(path.join(f.unity,"Assets/Settings/PC.asset.meta"));assert.equal(readUnityTarget(f.unity).pipeline,"unknown");
 }finally{f.cleanup();}
});
test("sprite queues immutable source once without Play Mode, same inputs reuse and User bytes survive",async()=>{
 const f=fixture();try{
  const user=put(f.unity,"Assets/PartsmithGraphics/fixture-object/User/Asset.prefab","user modifications");
  const d=await prepareUnityDelivery(f.args());assert.equal(d.status,"queued");assert.equal(d.playbackVerified,false);
  const q=JSON.parse(fs.readFileSync(path.join(f.unity,`Library/PartsmithGraphicsInbox/${d.id}.json`),"utf8"));
  assert.equal(q.mode,"sprite");assert.equal(q.files[0].sha256,f.version.files[0].sha256);assert.equal(q.playback,undefined);
  const again=await prepareUnityDelivery(f.args());assert.equal(again.id,d.id);assert.equal(fs.readFileSync(user,"utf8"),"user modifications");
  assert.equal(inspectUnityDelivery(f.unity,d).status,"queued");
 }finally{f.cleanup();}
});
test("changed inputs and changed Unity profiles stop before queueing",async()=>{
 const f=fixture();try{
  const a=f.args();put(f.project,"assets/원본.png","changed");await assert.rejects(()=>prepareUnityDelivery(a),/해시/);
  assert.equal(fs.existsSync(path.join(f.unity,"Library/PartsmithGraphicsInbox")),false);
  put(f.unity,"Packages/manifest.json","{\"dependencies\":{}} ");await assert.rejects(()=>prepareUnityDelivery(a),/설정이 바뀌/);
 }finally{f.cleanup();}
});
test("bridge collision and unowned Generated content produce conflict without overwrite",async()=>{
 const f=fixture();try{
  const script=put(f.unity,"Assets/PartsmithGraphicsBridge/Editor/PartsmithGraphicsBridge.cs","// user code");
  let d=await prepareUnityDelivery(f.args());assert.equal(d.status,"conflict");assert.equal(fs.readFileSync(script,"utf8"),"// user code");
  fs.unlinkSync(script);const file=put(f.unity,"Assets/PartsmithGraphics/fixture-object/Generated/Asset.fbx","original");
  d=await prepareUnityDelivery(f.args());assert.equal(d.status,"conflict");assert.equal(fs.readFileSync(file,"utf8"),"original");
 }finally{f.cleanup();}
});
test("source escape, wrong object, cancellation and project lock cannot enqueue",async()=>{
 const f=fixture();try{
  let a=f.args();a.versions=[{...f.version,objectId:"other"}];await assert.rejects(()=>prepareUnityDelivery(a),/다른 오브젝트/);
  a=f.args();a.versions=[{...f.version,files:[{...f.version.files[0],path:"../outside.png"}]}];await assert.rejects(()=>prepareUnityDelivery(a),/프로젝트 밖/);
  const controller=new AbortController();controller.abort();await assert.rejects(()=>prepareUnityDelivery({...f.args(),signal:controller.signal}));
  put(f.unity,"Library/PartsmithGraphicsPreparation.lock","other owner");const d=await prepareUnityDelivery(f.args());assert.equal(d.status,"failed");assert.match(d.errors.join(" "),/잠금/);
  assert.equal(fs.readFileSync(path.join(f.unity,"Library/PartsmithGraphicsPreparation.lock"),"utf8"),"other owner");
 }finally{f.cleanup();}
});
test("inspection checks receipt identity, actual imported file hashes and prefab GUID",async()=>{
 const f=fixture();try{
  const d=await prepareUnityDelivery(f.args());
  const file=d.files[0];put(f.unity,file.path,fs.readFileSync(path.join(f.project,f.version.files[0].path)));
  const prefab=d.destination+"/Generated/Asset.prefab",user=d.destination+"/User/Asset.prefab",guid="b".repeat(32);
  put(f.unity,prefab,"prefab");put(f.unity,prefab+".meta",`guid: ${guid}\n`);put(f.unity,user,"variant");
  const receipt=`Library/PartsmithGraphicsResults/${d.id}.json`;
  put(f.unity,receipt,JSON.stringify({requestId:d.id,objectId:d.objectId,profileFingerprint:d.profileFingerprint,converterVersion:d.converterVersion,status:"imported",guid,prefabPath:prefab,userPrefabPath:user,warnings:[],errors:[],playbackVerified:true}));
  const verified=inspectUnityDelivery(f.unity,d);assert.equal(verified.status,"imported");assert.equal(verified.playbackVerified,false);assert.equal(verified.guid,guid);
  put(f.unity,file.path,"tampered");assert.equal(inspectUnityDelivery(f.unity,d).status,"failed");
 }finally{f.cleanup();}
});
test("cancel removes only the matching queued request and keeps source, staging and user assets",async()=>{
 const f=fixture();try{
  const d=await prepareUnityDelivery(f.args()),source=path.join(f.project,f.version.files[0].path),before=fs.readFileSync(source);
  const user=put(f.unity,d.destination+"/User/Asset.prefab","user asset");
  const cancelled=cancelUnityDelivery(f.unity,d);assert.equal(cancelled.status,"failed");assert.match(cancelled.errors.join(" "),/취소/);
  assert.equal(fs.existsSync(path.join(f.unity,`Library/PartsmithGraphicsInbox/${d.id}.json`)),false);
  assert.ok(fs.existsSync(path.join(f.unity,`Library/PartsmithGraphicsStaging/${d.id}/cancelled.json`)));
  assert.deepEqual(fs.readFileSync(source),before);assert.equal(fs.readFileSync(user,"utf8"),"user asset");
  assert.equal((await prepareUnityDelivery(f.args())).status,"failed");
 }finally{f.cleanup();}
});
test("compatible PC profile changes can queue a new delivery without resetting source or User",async()=>{
 const f=fixture();try{
  const args=f.args();const user=put(f.unity,"Assets/PartsmithGraphics/fixture-object/User/Asset.prefab","preserve");
  put(f.unity,"Assets/PartsmithGraphics/fixture-object/Generated/partsmith-manifest.json",JSON.stringify({objectId:f.object.id,profileFingerprint:"old",pipeline:"builtin",unityVersion:"6000.3.21f1",structure:"sprite",files:[]}));
  const d=await prepareUnityDelivery(args);assert.equal(d.status,"queued");assert.ok(d.warnings.some(w=>w.includes("설정 변경")));assert.equal(fs.readFileSync(user,"utf8"),"preserve");
 }finally{f.cleanup();}
});
test("queued polling avoids directory scans, detects changed pipeline metadata, and fully inspects completion",async(t)=>{
 const f=fixture();try{
  const guid="c".repeat(32),meta=`fileFormatVersion: 2\nguid: ${guid}\n`;
  put(f.unity,"Assets/Settings/PC.asset","MonoBehaviour:\n  m_RendererDataList: []\n");
  put(f.unity,"Assets/Settings/PC.asset.meta",meta);
  put(f.unity,"ProjectSettings/GraphicsSettings.asset",`GraphicsSettings:\n  m_CustomRenderPipeline: {fileID: 11400000, guid: ${guid}, type: 2}\n`);
  const d=await prepareUnityDelivery(f.args());assert.equal(d.status,"queued");
  const original=fs.readdirSync;
  const reads=t.mock.method(fs,"readdirSync",original);
  assert.equal(inspectUnityDelivery(f.unity,d).status,"queued");assert.equal(reads.mock.callCount(),0);
  put(f.unity,"Assets/Settings/PC.asset.meta",meta+"changed: 1\n");
  assert.equal(inspectUnityDelivery(f.unity,d).status,"conflict");assert.equal(reads.mock.callCount(),0);
  put(f.unity,"Assets/Settings/PC.asset.meta",meta);
  put(f.unity,`Library/PartsmithGraphicsResults/${d.id}.json`,JSON.stringify({requestId:d.id,objectId:d.objectId,profileFingerprint:d.profileFingerprint,converterVersion:d.converterVersion,status:"failed",warnings:[],errors:["synthetic terminal report"]}));
  assert.equal(inspectUnityDelivery(f.unity,d).status,"failed");assert.ok(reads.mock.callCount()>0);
 }finally{f.cleanup();}
});
test("cached delivery reuse rejects another delivery ID or changed input versions",async()=>{
 const f=fixture();try{
  const first=await prepareUnityDelivery(f.args());cancelUnityDelivery(f.unity,first);
  const second=await prepareUnityDelivery({...f.args(),versions:[{...f.version,id:"second-version"}]});assert.equal(second.status,"queued");
  const cached=`Library/PartsmithGraphicsStaging/${first.id}/delivery.json`;
  const secondQueue=path.join(f.unity,`Library/PartsmithGraphicsInbox/${second.id}.json`),before=fs.readFileSync(secondQueue);
  put(f.unity,cached,JSON.stringify(second));
  await assert.rejects(()=>prepareUnityDelivery(f.args()),/현재 고정 입력/);
  put(f.unity,cached,JSON.stringify({...first,versionIds:["wrong-version"]}));
  await assert.rejects(()=>prepareUnityDelivery(f.args()),/현재 고정 입력/);
  assert.deepEqual(fs.readFileSync(secondQueue),before);
 }finally{f.cleanup();}
});
test("delivery file inventory cannot be dropped and copied project requests cannot be cancelled in another target",async()=>{
 const f=fixture();try{
  const d=await prepareUnityDelivery(f.args());
  assert.equal(inspectUnityDelivery(f.unity,{...d,files:[]}).status,"failed");
  const copied=path.join(f.root,"Copied Unity");fs.cpSync(f.unity,copied,{recursive:true});
  const queued=path.join(copied,`Library/PartsmithGraphicsInbox/${d.id}.json`),before=fs.readFileSync(queued);
  assert.throws(()=>cancelUnityDelivery(copied,d),/대상 프로젝트/);
  assert.deepEqual(fs.readFileSync(queued),before);assert.equal(inspectUnityDelivery(copied,d).status,"failed");
  // Profile settings may change in the same target; that must not prevent cancelling its own pending request.
  fs.appendFileSync(path.join(f.unity,"ProjectSettings/QualitySettings.asset"),"# changed setting\n");
  assert.match(cancelUnityDelivery(f.unity,d).errors.join(" "),/취소/);
 }finally{f.cleanup();}
});
test("identical asset inputs get distinct delivery identities for distinct Unity projects",async()=>{
 const f=fixture(),g=fixture();try{
  const first=await prepareUnityDelivery(f.args());
  const second=await prepareUnityDelivery({...f.args(),profile:readUnityTarget(g.unity)});
  assert.equal(first.status,"queued");assert.equal(second.status,"queued");assert.notEqual(first.id,second.id);
  assert.notEqual(first.profileFingerprint,second.profileFingerprint);
  assert.equal(inspectUnityDelivery(f.unity,first).status,"queued");assert.equal(inspectUnityDelivery(g.unity,second).status,"queued");
 }finally{f.cleanup();g.cleanup();}
});
