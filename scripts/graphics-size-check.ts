// Local-only real Blender + isolated Unity verification. Never opens the user's project.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {runProcess} from '../engine/local';
import {prepareUnityDelivery,readUnityTarget,inspectUnityDelivery} from '../engine/graphics-unity';
import {createGraphicsNativeExecutor} from '../engine/graphics-native';
import {defaultPhysicalSize} from '../shared/graphics-size';
import type {GraphicsObject,AssetVersion,GraphicsTask} from '../shared/graphics';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ps-size-check-')),unity=path.join(root,'Unity'),source=path.join(root,'Source');
const blender=process.env.PARTSMITH_TEST_BLENDER??'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe',editor=process.env.PARTSMITH_TEST_UNITY??'C:/Program Files/Unity/Hub/Editor/6000.3.21f1/Editor/Unity.exe';
const sha=(file:string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const put=(name:string,text:string)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file;};
fs.mkdirSync(source);fs.mkdirSync(path.join(unity,'Assets'),{recursive:true});
put('Unity/ProjectSettings/ProjectVersion.txt','m_EditorVersion: 6000.3.21f1\n');
put('Unity/Packages/manifest.json',JSON.stringify({dependencies:{'com.unity.modules.animation':'1.0.0','com.unity.modules.imageconversion':'1.0.0','com.unity.modules.jsonserialize':'1.0.0','com.unity.modules.physics':'1.0.0','com.unity.modules.uielements':'1.0.0'}}));
console.log(JSON.stringify({root,phase:'isolated Unity initialization'}));
await runProcess(editor,['-batchmode','-nographics','-quit','-projectPath',unity,'-logFile',path.join(root,'initialize.log')]);
const fixture=put('fixture.py',String.raw`import bpy,pathlib,sys,json
p=pathlib.Path(sys.argv[sys.argv.index('--')+1]);bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=2,location=(2,0,3));o=bpy.context.object;o.name='Part_A';o.scale=(1,2,3)
bpy.ops.mesh.primitive_cube_add(size=2,location=(-1,0,1));bpy.context.object.name='Part_B'
bpy.ops.wm.save_as_mainfile(filepath=str(p/'static.blend'),compress=False)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=2,location=(0,0,1));mesh=bpy.context.object;mesh.name='Skin'
bpy.ops.object.armature_add();rig=bpy.context.object;rig.name='Rig';bpy.ops.object.mode_set(mode='EDIT');rig.data.edit_bones[0].name='Root';bpy.ops.object.mode_set(mode='OBJECT')
group=mesh.vertex_groups.new(name='Root');group.add(list(range(len(mesh.data.vertices))),1,'REPLACE');mod=mesh.modifiers.new('Armature','ARMATURE');mod.object=rig;mesh.parent=rig
bpy.context.scene.render.fps=30;bpy.context.scene.frame_start=1;bpy.context.scene.frame_end=61
bone=rig.pose.bones['Root'];bone.rotation_mode='XYZ'
for frame,angle in [(1,0),(31,.15),(61,0)]:bone.rotation_euler.y=angle;bone.keyframe_insert(data_path='rotation_euler',frame=frame)
rig.animation_data.action.name='Idle';bpy.context.scene.frame_set(1)
bpy.ops.wm.save_as_mainfile(filepath=str(p/'rig.blend'),compress=False)
`);
await runProcess(blender,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',fixture,'--',source]);
const hashes={static:sha(path.join(source,'static.blend')),rig:sha(path.join(source,'rig.blend'))};
const object=(id:string,size:object):GraphicsObject=>({id,name:id,kind:'prop',createdAt:'fixture',selectedTasks:[],instruction:'',references:[],accepted:{},settings:{physicalSize:JSON.stringify(size)}});
const staticObject=object('static-size',{...defaultPhysicalSize(),mode:'axes',dimensionsMeters:{x:.25,y:4,z:8},pivot:'bottom-center'}),rigObject=object('rig-size',{...defaultPhysicalSize(),mode:'uniform',axis:'y',lengthMeters:3,pivot:'bottom-center'});
const version=(o:GraphicsObject,rig=false):AssetVersion=>({id:rig?'rig':'static',objectId:o.id,role:rig?'rig':'model',slot:'main',label:'source',createdAt:'fixture',sourceVersionIds:[],provenance:{type:'import'},warnings:[],files:[{path:rig?'rig.blend':'static.blend',sha256:rig?hashes.rig:hashes.static,bytes:fs.statSync(path.join(source,rig?'rig.blend':'static.blend')).size,kind:'blend'}]});
const profile=readUnityTarget(unity),args=(o:GraphicsObject,rig=false)=>({projectRoot:source,object:o,versions:[version(o,rig)],profile,blenderPath:blender,resources:path.resolve('integrations')});
put('Unity/Assets/Editor/SizeCheck.cs',String.raw`using UnityEditor;public static class SizeCheck { public static void Run(){Partsmith.Graphics.PartsmithGraphicsBridge.ProcessAllForBatch();} }`);
const launch=async(name:string)=>runProcess(editor,['-batchmode','-nographics','-quit','-projectPath',unity,'-executeMethod','SizeCheck.Run','-logFile',path.join(root,name+'.log')]);
const receipts:any[]=[];
for(const [o,isRig] of [[staticObject,false],[rigObject,true]] as const){
 console.log(JSON.stringify({phase:'real Unity meter import',object:o.id}));
 const delivery=await prepareUnityDelivery(args(o,isRig));assert.equal(delivery.status,'queued',delivery.errors.join('\n'));await launch(o.id);
 const checked=inspectUnityDelivery(unity,delivery);assert.equal(checked.status,'imported',checked.errors.join('\n'));
 const report=JSON.parse(fs.readFileSync(path.join(unity,`Library/PartsmithGraphicsResults/${delivery.id}.json`),'utf8'));receipts.push({delivery,report});
}
const preserved=['Generated/Asset.prefab.meta','Generated/Asset.fbx.meta','User/Asset.prefab','User/Asset.prefab.meta'].map(name=>({name,sha256:sha(path.join(unity,receipts[0].delivery.destination,name))}));
staticObject.settings.physicalSize=JSON.stringify({...defaultPhysicalSize(),mode:'axes',dimensionsMeters:{x:5,y:20,z:30},pivot:'center'});
const resized=await prepareUnityDelivery(args(staticObject));assert.equal(resized.status,'queued',resized.errors.join('\n'));assert.notEqual(resized.id,receipts[0].delivery.id);await launch('static-resized');
assert.equal(inspectUnityDelivery(unity,resized).status,'imported');for(const f of preserved)assert.equal(sha(path.join(unity,resized.destination,f.name)),f.sha256,f.name+' changed');
const cached=await prepareUnityDelivery(args(staticObject));assert.equal(cached.id,resized.id);assert.equal(cached.status,'imported');
// An accepted absolute local work copy then the same Unity setting must not scale twice.
const execute=createGraphicsNativeExecutor({workerFactory:()=>{throw Error('No GPT for sizing');}});
const task:GraphicsTask={id:'local-size',objectId:rigObject.id,taskId:'A05',status:'running',createdAt:'fixture',updatedAt:'fixture',inputVersionIds:['rig'],settings:rigObject.settings,instruction:'',requestHash:'local-size',outputVersionIds:[],backendJobIds:[],message:'',localOnly:true};
const result=await execute({projectRoot:source,workspacePath:path.join(source,'workspace.json'),object:rigObject,task,inputs:[version(rigObject,true)],blenderPath:blender,resources:path.resolve('integrations'),signal:new AbortController().signal,onProgress:()=>{}});
const fitted:AssetVersion={...version(rigObject,true),id:'fitted-rig',files:result.files.map(f=>({path:f.path,kind:f.kind,bytes:fs.statSync(path.join(source,f.path)).size,sha256:sha(path.join(source,f.path))}))};
const double=await prepareUnityDelivery({...args(rigObject,true),versions:[fitted]});assert.equal(double.status,'queued',double.errors.join('\n'));await launch('fitted-rig');const doubleChecked=inspectUnityDelivery(unity,double);assert.equal(doubleChecked.status,'imported',doubleChecked.errors.join('\n'));
const doubleReport=JSON.parse(fs.readFileSync(path.join(unity,`Library/PartsmithGraphicsResults/${double.id}.json`),'utf8'));assert.ok(Math.abs(doubleReport.physicalSize.dimensionsMeters.y-3)<.003);
const blocked=await prepareUnityDelivery({...args({...rigObject,id:'reject-rig',settings:{physicalSize:staticObject.settings.physicalSize}},true),versions:[{...version(rigObject,true),objectId:'reject-rig'}]});assert.equal(blocked.status,'failed');assert.match(blocked.errors.join(' '),/proportional/);
assert.equal(sha(path.join(source,'static.blend')),hashes.static);assert.equal(sha(path.join(source,'rig.blend')),hashes.rig);
const evidence={root,receipts,resized,doubleReport,sourcePreserved:true,staticAxes:true,rigUniform:true,reuseId:cached.id,userAndGeneratedGuidsPreserved:true,doubleScale:false,paidSubmissions:0,modelTurns:0};
fs.mkdirSync('artifacts/runtime',{recursive:true});fs.writeFileSync('artifacts/runtime/graphics-size-check.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({verified:true,root,evidence:'artifacts/runtime/graphics-size-check.json'}));
