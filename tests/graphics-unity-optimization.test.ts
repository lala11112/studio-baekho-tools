import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { graphicsUnityOptimization, prepareUnityDelivery, readUnityTarget, inspectUnityDelivery, cancelUnityDelivery } from '../engine/graphics-unity';
import type { GraphicsObject, AssetVersion } from '../shared/graphics';
const hash=(file:string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
test('Unity optimization defaults preserve original import resolution and reject unsupported settings',()=>{
 assert.deepEqual(graphicsUnityOptimization({}),{lodEnabled:false,lodRatio:.5,collider:'none',deliveryTextureSize:0,deliveryCompression:'none'});
 for(const settings of [{lodEnabled:'true'},{lodRatio:0},{lodRatio:NaN},{collider:'capsule'},{deliveryTextureSize:1000},{deliveryCompression:'crunch'}] as GraphicsObject['settings'][])assert.throws(()=>graphicsUnityOptimization(settings));
 assert.equal(graphicsUnityOptimization({collider:'mesh',deliveryCompression:'normal',deliveryTextureSize:1024}).deliveryTextureSize,1024);
});
test('real static Blender LOD freezes original structure, measured reduction and options; changed queue cannot reuse evidence',{timeout:120000},async t=>{
 const blender=process.env.PARTSMITH_TEST_BLENDER;if(!blender||!fs.existsSync(blender)){t.skip('Set PARTSMITH_TEST_BLENDER for measured local LOD verification');return;}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ps-lod-test-'));t.after(()=>{assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true,maxRetries:3});});
 const put=(name:string,text:string)=>{const p=path.join(root,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text);return p;};
 const project=path.join(root,'source'),unity=path.join(root,'Unity');fs.mkdirSync(project);fs.mkdirSync(path.join(unity,'Assets'),{recursive:true});
 put('Unity/ProjectSettings/ProjectVersion.txt','m_EditorVersion: 6000.3.21f1\n');put('Unity/ProjectSettings/GraphicsSettings.asset','GraphicsSettings:\n  m_CustomRenderPipeline: {fileID: 0}\n');put('Unity/ProjectSettings/QualitySettings.asset','QualitySettings:\n  m_CurrentQuality: 0\n  m_QualitySettings:\n  - serializedVersion: 4\n    customRenderPipeline: {fileID: 0}\n  m_PerPlatformDefaultQuality:\n    Standalone: 0\n');put('Unity/Packages/manifest.json','{"dependencies":{}}');
 const setup=put('setup.py',`import bpy,pathlib,sys\np=pathlib.Path(sys.argv[sys.argv.index('--')+1])\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_uv_sphere_add(segments=24,ring_count=12)\no=bpy.context.object;o.name='Sphere'\nbpy.ops.wm.save_as_mainfile(filepath=str(p/'source.blend'),compress=False)\nbpy.ops.object.armature_add()\nbpy.ops.wm.save_as_mainfile(filepath=str(p/'rig.blend'),compress=False)\n`);
 const run=spawnSync(blender,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',setup,'--',project],{encoding:'utf8',timeout:60000});assert.equal(run.status,0,run.stdout+run.stderr);
 const original=hash(path.join(project,'source.blend'));
 const object:GraphicsObject={id:'lod-object',name:'Sphere',kind:'prop',createdAt:'fixture',instruction:'',settings:{lodEnabled:true,lodRatio:.5,collider:'box',deliveryTextureSize:512,deliveryCompression:'normal'},selectedTasks:[],references:[],accepted:{}};
 const version=(name:string):AssetVersion=>({id:name,objectId:object.id,role:'model',slot:'main',label:'sphere',createdAt:'fixture',sourceVersionIds:[],provenance:{type:'import'},warnings:[],files:[{path:name+'.blend',sha256:hash(path.join(project,name+'.blend')),bytes:fs.statSync(path.join(project,name+'.blend')).size,kind:'blend'}]});
 const args={projectRoot:project,object,versions:[version('source')],profile:readUnityTarget(unity),blenderPath:blender,resources:path.resolve('integrations')};
 const delivery=await prepareUnityDelivery(args);assert.equal(delivery.status,'queued',delivery.errors.join('\n'));
 const requestPath=path.join(unity,`Library/PartsmithGraphicsStaging/${delivery.id}/request.json`),request=JSON.parse(fs.readFileSync(requestPath,'utf8'));
 const manifestFile=request.files.find((f:any)=>f.destination.endsWith('/optimization.json')),manifest=JSON.parse(fs.readFileSync(manifestFile.source,'utf8'));
 assert.equal(manifest.lods.length,1);assert.equal(manifest.lods[0].source,'Sphere');assert.ok(manifest.lods[0].derivedTriangles<manifest.lods[0].sourceTriangles);assert.deepEqual(manifest.settings,request.optimization);
 assert.equal(hash(path.join(project,'source.blend')),original);assert.equal(fs.existsSync(path.join(unity,delivery.destination)),false);
 assert.equal((await prepareUnityDelivery(args)).id,delivery.id);
 fs.writeFileSync(requestPath,JSON.stringify({...request,optimization:{...request.optimization,lodRatio:.9}}));
 assert.equal(inspectUnityDelivery(unity,delivery).status,'failed');fs.writeFileSync(requestPath,JSON.stringify(request));
 cancelUnityDelivery(unity,delivery);
 const rig=await prepareUnityDelivery({...args,versions:[version('rig')]});assert.equal(rig.status,'failed');assert.ok(rig.errors.some(e=>e.includes('static meshes')));
});
