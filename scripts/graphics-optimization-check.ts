// Offline synthetic verification. The project is newly created under the OS temp folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runProcess } from '../engine/local';
import { prepareUnityDelivery, readUnityTarget, inspectUnityDelivery } from '../engine/graphics-unity';
import type { AssetVersion, GraphicsObject } from '../shared/graphics';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-optimization-check-')), unity = path.join(root, 'Unity'), source = path.join(root, 'Source');
const blender = process.env.PARTSMITH_TEST_BLENDER ?? 'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe';
const editor = process.env.PARTSMITH_TEST_UNITY ?? 'C:/Program Files/Unity/Hub/Editor/6000.3.21f1/Editor/Unity.exe';
const sha = (file:string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const put = (relative:string, text:string) => { const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file; };
fs.mkdirSync(path.join(unity,'Assets'),{recursive:true});fs.mkdirSync(source);
put('Unity/ProjectSettings/ProjectVersion.txt','m_EditorVersion: 6000.3.21f1\n');
put('Unity/Packages/manifest.json',JSON.stringify({dependencies:{'com.unity.modules.animation':'1.0.0','com.unity.modules.imageconversion':'1.0.0','com.unity.modules.jsonserialize':'1.0.0','com.unity.modules.physics':'1.0.0','com.unity.modules.uielements':'1.0.0'}}));
console.log(JSON.stringify({root,phase:'initialize isolated Unity'}));
await runProcess(editor,['-batchmode','-nographics','-quit','-projectPath',unity,'-logFile',path.join(root,'initialize.log')]);
const fixture=put('fixture.py',`import bpy,pathlib,sys\np=pathlib.Path(sys.argv[sys.argv.index('--')+1])\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_uv_sphere_add(segments=24,ring_count=12)\no=bpy.context.object;o.name='SourceSphere'\nm=bpy.data.materials.new('FixtureMaterial');m.use_nodes=True;o.data.materials.append(m)\ni=bpy.data.images.new('OriginalPixels',width=1024,height=1024,alpha=True);i.generated_color=(.3,.7,.2,1);i.filepath_raw=str(p/'original.png');i.file_format='PNG';i.save();i.source='FILE';i.reload();i.pack()\nn=m.node_tree.nodes.new('ShaderNodeTexImage');n.image=i;m.node_tree.links.new(n.outputs['Color'],m.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])\nbpy.ops.wm.save_as_mainfile(filepath=str(p/'source.blend'),compress=False)\n`);
await runProcess(blender,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',fixture,'--',source]);
const originalBlend=sha(path.join(source,'source.blend')), originalTexture=sha(path.join(source,'original.png'));
const profile=readUnityTarget(unity), objects:GraphicsObject[]= ['box','mesh','convex'].map(collider=>({id:'opt-'+collider,name:collider,kind:'prop',createdAt:'fixture',selectedTasks:[],instruction:'',references:[],accepted:{},settings:{lodEnabled:collider==='box',lodRatio:.5,collider,deliveryTextureSize:256,deliveryCompression:'normal'}}));
const version=(object:GraphicsObject):AssetVersion=>({id:'source',objectId:object.id,role:'model',slot:'main',label:'source',createdAt:'fixture',sourceVersionIds:[],provenance:{type:'import'},warnings:[],files:[{path:'source.blend',sha256:originalBlend,bytes:fs.statSync(path.join(source,'source.blend')).size,kind:'blend'}]});
const args=(object:GraphicsObject)=>({projectRoot:source,object,versions:[version(object)],profile,blenderPath:blender,resources:path.resolve('integrations')});
const deliveries=[];
put('Unity/Assets/Editor/OptimizationInspection.cs',String.raw`
using System;using System.IO;using System.Linq;using System.Collections.Generic;using UnityEngine;using UnityEditor;
public static class OptimizationInspection {
 [Serializable] public class Item { public string id,guid,compression;public int lods,box,mesh,convex,width,maxSize;public int[] triangles; }
 [Serializable] public class Report { public Item[] items; }
 public static void Run(){
  Partsmith.Graphics.PartsmithGraphicsBridge.ProcessAllForBatch();var items=new List<Item>();
  foreach(var folder in Directory.GetDirectories("Assets/PartsmithGraphics")){
   var prefab=AssetDatabase.LoadAssetAtPath<GameObject>(folder+"/Generated/Asset.prefab");if(!prefab)throw new Exception("Missing prefab: "+folder);
   var lod=prefab.GetComponent<LODGroup>();var colliders=prefab.GetComponentsInChildren<MeshCollider>(true);
   var texturePath=Directory.GetFiles(folder+"/Generated/Textures","*.png").Single(p=>p.Contains("OriginalPixels")).Replace('\\','/');
   var texture=AssetDatabase.LoadAssetAtPath<Texture2D>(texturePath);var importer=(TextureImporter)AssetImporter.GetAtPath(texturePath);
   items.Add(new Item{id=Path.GetFileName(folder),guid=AssetDatabase.AssetPathToGUID(folder+"/Generated/Asset.prefab"),lods=lod?lod.lodCount:0,box=prefab.GetComponentsInChildren<BoxCollider>(true).Length,mesh=colliders.Count(c=>!c.convex),convex=colliders.Count(c=>c.convex),width=texture.width,maxSize=importer.maxTextureSize,compression=importer.textureCompression.ToString(),triangles=lod?lod.GetLODs().Select(l=>l.renderers.Sum(r=>r.GetComponent<MeshFilter>().sharedMesh.triangles.Length/3)).ToArray():Array.Empty<int>()});
  }
  File.WriteAllText(Path.GetFullPath("../inspection.json"),JsonUtility.ToJson(new Report{items=items.ToArray()},true));
 }
}`);
const launch=async(name:string)=>{await runProcess(editor,['-batchmode','-nographics','-quit','-projectPath',unity,'-executeMethod','OptimizationInspection.Run','-logFile',path.join(root,name+'.log')]);return JSON.parse(fs.readFileSync(path.join(root,'inspection.json'),'utf8'));};
console.log(JSON.stringify({root,phase:'actual LOD/collider/texture import'}));
let first:any;
for(const object of objects){const delivery=await prepareUnityDelivery(args(object));assert.equal(delivery.status,'queued',delivery.errors.join('\n'));deliveries.push(delivery);first=await launch('optimized-'+object.id);}
for(const item of first.items){assert.equal(item.width,256);assert.equal(item.maxSize,256);assert.equal(item.compression,'Compressed');assert.equal(item[item.id.slice(4)],1);}
const lod=first.items.find((i:any)=>i.id==='opt-box');assert.equal(lod.lods,2);assert.ok(lod.triangles[1]<lod.triangles[0]);
for(const delivery of deliveries)assert.equal(inspectUnityDelivery(unity,delivery).status,'imported');
const base=deliveries[0].destination, preserved=['Generated/Asset.prefab.meta','User/Asset.prefab','User/Asset.prefab.meta'].map(name=>({name,sha256:sha(path.join(unity,base,name))}));
objects[0].settings={lodEnabled:false,lodRatio:.5,collider:'none',deliveryTextureSize:0,deliveryCompression:'none'};
const updated=await prepareUnityDelivery(args(objects[0]));assert.equal(updated.status,'queued',updated.errors.join('\n'));assert.notEqual(updated.id,deliveries[0].id);
console.log(JSON.stringify({root,phase:'same source default-options reimport and GUID/User preservation'}));
const second=await launch('restored'), restored=second.items.find((i:any)=>i.id==='opt-box');
assert.equal(inspectUnityDelivery(unity,updated).status,'imported');assert.equal(restored.lods,0);assert.equal(restored.box,0);assert.equal(restored.width,1024);assert.equal(restored.compression,'Uncompressed');assert.equal(restored.guid,lod.guid);
for(const item of preserved)assert.equal(sha(path.join(unity,base,item.name)),item.sha256,item.name+' changed');
assert.equal(sha(path.join(source,'source.blend')),originalBlend);assert.equal(sha(path.join(source,'original.png')),originalTexture);
for(const delivery of [...deliveries,updated])assert.ok(delivery.files.some(file=>file.sha256===originalTexture));
const again=await prepareUnityDelivery(args(objects[0]));assert.equal(again.id,updated.id);assert.equal(again.status,'imported');
const evidence={root,first,second,sourceBlend:originalBlend,sourceTexture:originalTexture,sourcePreserved:true,userBytesAndGeneratedGuidPreserved:true,reusedDeliveryId:again.id,localOnly:true,modelTurns:0,paidSubmissions:0};
fs.mkdirSync('artifacts/runtime',{recursive:true});fs.writeFileSync('artifacts/runtime/graphics-optimization-check.json',JSON.stringify(evidence,null,2));
console.log(JSON.stringify({verified:true,root,evidence:'artifacts/runtime/graphics-optimization-check.json'}));
