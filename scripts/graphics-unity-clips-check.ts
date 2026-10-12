// Synthetic Generic clip importer verification in a fresh temporary Unity project; no Play Mode.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {runProcess} from '../engine/local';import {prepareUnityDelivery,readUnityTarget,inspectUnityDelivery} from '../engine/graphics-unity';
import type {AssetVersion,GraphicsObject,UnityClipSettings} from '../shared/graphics';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ps-unity-clips-check-')),unity=path.join(root,'Unity'),source=path.join(root,'Source');
const blender=process.env.PARTSMITH_TEST_BLENDER??'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe',editor=process.env.PARTSMITH_TEST_UNITY??'C:/Program Files/Unity/Hub/Editor/6000.3.21f1/Editor/Unity.exe';
const sha=(file:string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const put=(relative:string,text:string)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file;};
fs.mkdirSync(path.join(unity,'Assets'),{recursive:true});fs.mkdirSync(source);
put('Unity/ProjectSettings/ProjectVersion.txt','m_EditorVersion: 6000.3.21f1\n');
put('Unity/Packages/manifest.json',JSON.stringify({dependencies:{'com.unity.modules.animation':'1.0.0','com.unity.modules.imageconversion':'1.0.0','com.unity.modules.jsonserialize':'1.0.0','com.unity.modules.physics':'1.0.0','com.unity.modules.uielements':'1.0.0'}}));
console.log(JSON.stringify({root,phase:'initialize isolated Unity'}));
await runProcess(editor,['-batchmode','-nographics','-quit','-projectPath',unity,'-logFile',path.join(root,'initialize.log')]);
const fixture=put('fixture.py',String.raw`
import bpy,pathlib,sys
p=pathlib.Path(sys.argv[sys.argv.index('--')+1]);bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.object.armature_add();rig=bpy.context.object;rig.name='Rig';rig.rotation_mode='XYZ'
bpy.ops.object.mode_set(mode='EDIT');bone=rig.data.edit_bones[0];bone.name='Root';child=rig.data.edit_bones.new('BodyBone');child.head=(0,0,1);child.tail=(0,0,2);child.parent=bone
bpy.ops.object.mode_set(mode='OBJECT')
for bone in rig.pose.bones:bone.rotation_mode='XYZ'
bpy.ops.mesh.primitive_cube_add(size=1,location=(0,0,1.5));mesh=bpy.context.object;mesh.name='Body';mesh.parent=rig
modifier=mesh.modifiers.new('Skin','ARMATURE');modifier.object=rig;group=mesh.vertex_groups.new(name='BodyBone');group.add(list(range(len(mesh.data.vertices))),1,'REPLACE')
material=bpy.data.materials.new('BodyMaterial');material.use_nodes=True;mesh.data.materials.append(material)
bpy.context.scene.render.fps=30;bpy.context.scene.frame_start=1;bpy.context.scene.frame_end=31
bpy.ops.wm.save_as_mainfile(filepath=str(p/'rig.blend'),compress=False)
for name in ['Idle','Jump']:
 bpy.ops.wm.open_mainfile(filepath=str(p/'rig.blend'),load_ui=False,use_scripts=False);rig=bpy.data.objects['Rig'];rig.animation_data_create()
 for frame,value in [(1,0),(16,.5),(31,0)]:
  rig.pose.bones['BodyBone'].rotation_euler.z=value;rig.pose.bones['BodyBone'].keyframe_insert(data_path='rotation_euler',index=2,frame=frame)
  rig.pose.bones['Root'].location.x=(frame-1)/30 if name=='Jump' else 0;rig.pose.bones['Root'].keyframe_insert(data_path='location',index=0,frame=frame)
 rig.animation_data.action.name=name;rig.animation_data.action.use_fake_user=True;bpy.context.scene.frame_set(1)
 bpy.ops.wm.save_as_mainfile(filepath=str(p/(name+'.blend')),compress=False)
`);
await runProcess(blender,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',fixture,'--',source]);
const object:GraphicsObject={id:'clip-fixture',name:'Character clips',kind:'character',createdAt:'fixture',instruction:'',settings:{unityRigType:'generic'},selectedTasks:[],references:[],accepted:{}};
const versions:AssetVersion[]=['rig','Idle','Jump'].map(name=>{const file=path.join(source,name+'.blend'),role=name==='rig'?'rig':'animation',slot=name==='rig'?'main':name;object.accepted[role+':'+slot]=name;return {id:name,objectId:object.id,role,slot,label:name,createdAt:'fixture',sourceVersionIds:[],provenance:{type:'codex'},warnings:[],files:[{path:name+'.blend',sha256:sha(file),bytes:fs.statSync(file).size,kind:'blend'}]};});
const originals=versions.flatMap(v=>v.files);const clipSettings:UnityClipSettings[]=[{versionId:'Idle',name:'Idle',loop:true,rootMotion:false,fps:30},{versionId:'Jump',name:'Jump',loop:false,rootMotion:true,fps:30}];
const args={projectRoot:source,object,versions,profile:readUnityTarget(unity),blenderPath:blender,resources:path.resolve('integrations'),clipSettings};
put('Unity/Assets/Editor/ClipInspection.cs',String.raw`
using System;using System.IO;using System.Linq;using UnityEngine;using UnityEditor;
public static class ClipInspection {
 [Serializable] public class Clip { public string name,fileId;public bool loop,lockRotation,lockY,lockXZ,rootCurves;public float fps; }
 [Serializable] public class Report { public Clip[] clips;public string animationType,rootBone,guid;public bool applyRootMotion; }
 public static void Run(){
  Partsmith.Graphics.PartsmithGraphicsBridge.ProcessAllForBatch();string path="Assets/PartsmithGraphics/clip-fixture/Generated/Asset.fbx";
  var importer=(ModelImporter)AssetImporter.GetAtPath(path);var prefab=AssetDatabase.LoadAssetAtPath<GameObject>("Assets/PartsmithGraphics/clip-fixture/Generated/Asset.prefab");
  if(!prefab)throw new Exception("Import did not produce a prefab; inspect delivery receipt");
  var actual=AssetDatabase.LoadAllAssetsAtPath(path).OfType<AnimationClip>().Where(c=>!c.name.StartsWith("__preview__")).ToArray();
  var clips=importer.clipAnimations.Select(c=>{var native=actual.Single(a=>a.name==c.name);string guid;long id;AssetDatabase.TryGetGUIDAndLocalFileIdentifier(native,out guid,out id);return new Clip{name=c.name,loop=c.loopTime,lockRotation=c.lockRootRotation,lockY=c.lockRootHeightY,lockXZ=c.lockRootPositionXZ,fps=native.frameRate,rootCurves=native.hasRootCurves,fileId=id.ToString(System.Globalization.CultureInfo.InvariantCulture)};}).ToArray();
  var root=new SerializedObject(importer).FindProperty("m_HumanDescription.m_RootMotionBoneName");
  File.WriteAllText(Path.GetFullPath("../clips.json"),JsonUtility.ToJson(new Report{clips=clips,animationType=importer.animationType.ToString(),rootBone=root.stringValue,guid=AssetDatabase.AssetPathToGUID(path),applyRootMotion=prefab.GetComponent<Animator>().applyRootMotion},true));
 }
}`);
const launch=async(name:string)=>{await runProcess(editor,['-batchmode','-nographics','-quit','-projectPath',unity,'-executeMethod','ClipInspection.Run','-logFile',path.join(root,name+'.log')]);return JSON.parse(fs.readFileSync(path.join(root,'clips.json'),'utf8'));};
const firstDelivery=await prepareUnityDelivery(args);assert.equal(firstDelivery.status,'queued',firstDelivery.errors.join('\n'));console.log(JSON.stringify({root,phase:'apply exact Idle/Jump importer contracts',delivery:firstDelivery.id}));
const first=await launch('first');const firstReceipt=inspectUnityDelivery(unity,firstDelivery);assert.equal(firstReceipt.status,'imported',firstReceipt.errors.join('\n'));
assert.equal(first.animationType,'Generic');assert.equal(first.rootBone,'Root');assert.equal(first.applyRootMotion,true);
assert.deepEqual(first.clips.map((c:any)=>c.name).sort(),['Idle','Jump']);
for(const setting of clipSettings){const clip=first.clips.find((c:any)=>c.name===setting.name);assert.equal(clip.loop,setting.loop);assert.equal(clip.lockRotation,!setting.rootMotion);assert.equal(clip.lockY,!setting.rootMotion);assert.equal(clip.lockXZ,!setting.rootMotion);assert.equal(clip.fps,30);}
assert.equal(first.clips.find((c:any)=>c.name==='Jump').rootCurves,true);
const base=firstDelivery.destination,kept=['Generated/Asset.prefab.meta','User/Asset.prefab','User/Asset.prefab.meta'].map(name=>({name,sha256:sha(path.join(unity,base,name))}));
const changed=args.clipSettings.map(clip=>({...clip,loop:false,rootMotion:false}));
const secondDelivery=await prepareUnityDelivery({...args,clipSettings:changed});assert.equal(secondDelivery.status,'queued',secondDelivery.errors.join('\n'));assert.notEqual(secondDelivery.id,firstDelivery.id);
console.log(JSON.stringify({root,phase:'change only importer contract, preserve exact sources/GUID/User',delivery:secondDelivery.id}));
const second=await launch('second');const secondReceipt=inspectUnityDelivery(unity,secondDelivery);assert.equal(secondReceipt.status,'imported',secondReceipt.errors.join('\n'));
assert.equal(second.applyRootMotion,false);assert.equal(second.guid,first.guid);
for(const clip of second.clips){assert.equal(clip.loop,false);assert.equal(clip.lockRotation,true);assert.equal(clip.lockY,true);assert.equal(clip.lockXZ,true);assert.equal(clip.fps,30);assert.equal(clip.fileId,first.clips.find((c:any)=>c.name===clip.name).fileId);}
for(const item of kept)assert.equal(sha(path.join(unity,base,item.name)),item.sha256,item.name+' changed');
for(const item of originals)assert.equal(sha(path.join(source,item.path)),item.sha256,item.path+' changed');
const reused=await prepareUnityDelivery({...args,clipSettings:changed});assert.equal(reused.id,secondDelivery.id);assert.equal(reused.status,'imported');
const evidence={root,first,second,deliveries:[firstDelivery.id,secondDelivery.id],sourceBytesPreserved:true,userPrefabBytesPreserved:true,generatedPrefabGuidPreserved:true,clipFileIdsPreserved:true,reusedDeliveryId:reused.id,playMode:false,modelTurns:0,paidSubmissions:0};
fs.mkdirSync('artifacts/runtime',{recursive:true});fs.writeFileSync('artifacts/runtime/graphics-unity-clips-check.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({verified:true,evidence:'artifacts/runtime/graphics-unity-clips-check.json'}));
