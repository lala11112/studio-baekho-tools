// Isolated synthetic Unity import verification. Never touches a production Partsmith profile or Unity project.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { runProcess } from "../engine/local";
import { readUnityTarget,prepareUnityDelivery,inspectUnityDelivery } from "../engine/graphics-unity";
import type { GraphicsObject,AssetVersion,UnityDelivery } from "../shared/graphics";
const existingIndex=process.argv.indexOf("--existing");
const root=existingIndex>=0?fs.realpathSync(process.argv[existingIndex+1]):fs.mkdtempSync(path.join(os.tmpdir(),"ps-graphics-check-"));
assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(root).startsWith("ps-graphics-check-"));
const unity=path.join(root,"Unity"),source=path.join(root,existingIndex>=0?"SourcesTextured":"Sources");
const blender="C:/Program Files/Blender Foundation/Blender 5.0/blender.exe";
const editor="C:/Program Files/Unity/Hub/Editor/6000.3.21f1/Editor/Unity.exe";
const put=(relative:string,text:string|Buffer)=>{const p=path.join(root,relative);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text);return p;};
const sha=(f:string)=>createHash("sha256").update(fs.readFileSync(f)).digest("hex");
fs.mkdirSync(path.join(unity,"Assets"),{recursive:true});fs.mkdirSync(source,{recursive:true});
if(existingIndex<0){
put("Unity/ProjectSettings/ProjectVersion.txt","m_EditorVersion: 6000.3.21f1\n");
put("Unity/Packages/manifest.json",JSON.stringify({dependencies:{"com.unity.modules.animation":"1.0.0","com.unity.modules.imageconversion":"1.0.0","com.unity.modules.jsonserialize":"1.0.0","com.unity.modules.physics":"1.0.0","com.unity.modules.uielements":"1.0.0"}}));
if(process.argv.includes("--urp")){
 const reference="C:/Unity/3D Tool Test";
 fs.cpSync(path.join(reference,"Assets/Settings"),path.join(unity,"Assets/Settings"),{recursive:true});
 for(const name of ["GraphicsSettings.asset","QualitySettings.asset"])fs.copyFileSync(path.join(reference,"ProjectSettings",name),path.join(unity,"ProjectSettings",name));
 const manifest=JSON.parse(fs.readFileSync(path.join(unity,"Packages/manifest.json"),"utf8"));manifest.dependencies["com.unity.render-pipelines.universal"]="17.3.0";
 put("Unity/Packages/manifest.json",JSON.stringify(manifest));
}
console.log(JSON.stringify({root,phase:"initialize isolated Unity"}));
await runProcess(editor,["-batchmode","-nographics","-quit","-projectPath",unity,"-logFile",path.join(root,"initialize.log")]);
}
const py=put("fixture.py",`import bpy, pathlib\nout=pathlib.Path(${JSON.stringify(source.replaceAll("\\","/"))})\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_cube_add()\nobj=bpy.context.object\nobj.name='Cube'\nmat=bpy.data.materials.new('FixtureMaterial')\nmat.use_nodes=True\nimage=bpy.data.images.new('Fixture_BaseColor',width=64,height=64,alpha=True)\nimage.generated_color=(0.8,0.1,0.2,1)\nimage.filepath_raw=str(out/'fixture-texture.png')\nimage.file_format='PNG'\nimage.save()\nimage.source='FILE'\nimage.reload()\nimage.pack()\ntex=mat.node_tree.nodes.new('ShaderNodeTexImage')\ntex.image=image\nmat.node_tree.links.new(tex.outputs['Color'],mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])\nobj.data.materials.append(mat)\nbpy.ops.wm.save_as_mainfile(filepath=str(out/'static.blend'))\nobj.location=(0,0,0)\nobj.keyframe_insert(data_path='location',frame=1)\nobj.location=(0,0,1)\nobj.keyframe_insert(data_path='location',frame=30)\nobj.animation_data.action.name='Lift'\nbpy.ops.wm.save_as_mainfile(filepath=str(out/'animated.blend'))\nbpy.ops.mesh.primitive_uv_sphere_add()\nbpy.ops.wm.save_as_mainfile(filepath=str(out/'conflict.blend'))\n`);
await runProcess(blender,["--background","--factory-startup","--python-exit-code","1","--python",py]);
const png=new PNG({width:64,height:64});for(let n=0;n<png.data.length;n+=4){png.data[n]=220;png.data[n+1]=35;png.data[n+2]=70;png.data[n+3]=255;}fs.writeFileSync(path.join(source,"sprite.png"),PNG.sync.write(png));
fs.mkdirSync(path.join(source,"obj/materials"),{recursive:true});fs.mkdirSync(path.join(source,"obj/textures"),{recursive:true});
fs.writeFileSync(path.join(source,"obj/triangle.obj"),"mtllib materials/triangle.mtl\no Triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl Surface\nf 1/1 2/2 3/3\n");
fs.writeFileSync(path.join(source,"obj/materials/triangle.mtl"),"newmtl Surface\nKd 1 1 1\nmap_Kd ../textures/source.png\n");fs.copyFileSync(path.join(source,"sprite.png"),path.join(source,"obj/textures/source.png"));
const profile=readUnityTarget(unity),evidence:any={root,profile,deliveries:[]};
for(const name of ["static","animated","native","obj","sprite"]){
 const extension=name==="sprite"?".png":name==="native"?".fbx":".blend";
 if(name==="native")fs.copyFileSync(path.join(unity,"Assets/PartsmithGraphics/"+(existingIndex>=0?"fixture-textured-":"fixture-")+"static/Generated/Asset.fbx"),path.join(source,"native.fbx"));
 const relative=name==="obj"?"obj/triangle.obj":name+extension,file=path.join(source,relative),before=sha(file);
 const object:GraphicsObject={id:(existingIndex>=0?"fixture-textured-":"fixture-")+name,name,kind:name==="sprite"?"sprite":"prop",createdAt:new Date().toISOString(),selectedTasks:[],instruction:"",settings:{},references:[],accepted:{}};
 const fileNames=name==="obj"?[relative,"obj/materials/triangle.mtl","obj/textures/source.png"]:[relative];
 const version:AssetVersion={id:name+"-v1",objectId:object.id,role:name==="sprite"?"design":"model",slot:"default",label:name,files:fileNames.map(p=>({path:p,sha256:sha(path.join(source,p)),bytes:fs.statSync(path.join(source,p)).size,kind:path.extname(p).slice(1)})),createdAt:object.createdAt,sourceVersionIds:[],provenance:{type:"import"},warnings:[]};
 const args={projectRoot:source,object,versions:[version],profile,blenderPath:blender,resources:path.resolve("integrations")};
 const delivery=await prepareUnityDelivery(args);console.log(JSON.stringify({name,delivery}));assert.equal(delivery.status,"queued");
 if(name==="native")assert.equal(delivery.files.find(f=>f.kind==="fbx")!.sha256,before);
 if(name==="obj")assert.ok(delivery.files.some(f=>f.sha256===sha(path.join(source,"obj/textures/source.png"))));
 await runProcess(editor,["-batchmode","-nographics","-quit","-projectPath",unity,"-executeMethod","Partsmith.Graphics.PartsmithGraphicsBridge.ProcessAllForBatch","-logFile",path.join(root,name+".log")]);
 const result=inspectUnityDelivery(unity,delivery);console.log(JSON.stringify({name,result}));assert.equal(result.status,"imported");assert.equal(result.playbackVerified,false);assert.equal(sha(file),before);
 const prefabMeta=path.join(unity,result.prefabPath!+".meta"),guid=sha(prefabMeta);
 const user=path.join(unity,result.userPrefabPath!);fs.appendFileSync(user,"\n# preserved user modification\n");const userHash=sha(user);
 const reused=await prepareUnityDelivery(args);assert.equal(reused.id,result.id);assert.equal(sha(user),userHash);assert.equal(sha(prefabMeta),guid);
 if(name==="static"){
  const update=await prepareUnityDelivery({...args,versions:[{...version,id:"static-v2"}]});assert.equal(update.status,"queued");
  await runProcess(editor,["-batchmode","-nographics","-quit","-projectPath",unity,"-executeMethod","Partsmith.Graphics.PartsmithGraphicsBridge.ProcessAllForBatch","-logFile",path.join(root,"static-update.log")]);
  const updated=inspectUnityDelivery(unity,update);assert.equal(updated.status,"imported");assert.equal(updated.guid,result.guid);assert.equal(sha(user),userHash);assert.equal(sha(prefabMeta),guid);
  const changed=path.join(source,"conflict.blend");const conflict=await prepareUnityDelivery({...args,versions:[{...version,id:"static-v3",files:[{path:"conflict.blend",sha256:sha(changed),bytes:fs.statSync(changed).size,kind:"blend"}]}]});
  assert.equal(conflict.status,"conflict");assert.equal(sha(user),userHash);assert.equal(sha(prefabMeta),guid);
 }
 evidence.deliveries.push({name,result,sourcePreserved:true,reused:true,userBytesPreserved:true,guidPreserved:true});
}
put("evidence.json",JSON.stringify(evidence,null,2));
fs.mkdirSync("artifacts/runtime",{recursive:true});fs.writeFileSync("artifacts/runtime/graphics-unity-check.json",JSON.stringify(evidence,null,2));
console.log(JSON.stringify({verified:true,root,evidence:"artifacts/runtime/graphics-unity-check.json"}));
