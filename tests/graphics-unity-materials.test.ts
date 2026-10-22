import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { prepareUnityDelivery, readUnityTarget, inspectUnityDelivery } from "../engine/graphics-unity";
import type { AssetVersion, GraphicsObject } from "../shared/graphics";

const hash=(file:string)=>createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const put=(root:string,file:string,value:string|Buffer)=>{const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);return target;};

test("real Blender freezes source-node material roles and packs full 4K metallic/smoothness without touching originals or Unity",{timeout:180_000},async(t)=>{
 const blender=process.env.PARTSMITH_TEST_BLENDER;
 if(!blender||!fs.existsSync(blender)){t.skip("Set PARTSMITH_TEST_BLENDER for real material conversion");return;}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"ps-material-test-"));
 t.after(()=>{assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true,maxRetries:3});});
 const project=path.join(root,"project"),unity=path.join(root,"unity");fs.mkdirSync(project);
 // Deliberately misleading names prove roles follow the graph rather than filenames.
 for(const [name,width,height] of [["not-a-normal.png",2,2],["not-metallic.png",4096,4096],["not-basecolor.png",2,2]] as const){
  const png=new PNG({width,height});
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
   const i=(y*width+x)*4;png.data[i]=17;png.data[i+1]=y===0?64:192;png.data[i+2]=x===0?51:204;png.data[i+3]=255;
  }
  put(project,name,PNG.sync.write(png));
 }
 const setup=put(root,"setup.py",String.raw`
import bpy,pathlib,sys
p=pathlib.Path(sys.argv[sys.argv.index('--')+1])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add()
mesh=bpy.context.object
material=bpy.data.materials.new('ExactSourceMaterial');material.use_nodes=True
mesh.data.materials.append(material)
nodes=material.node_tree.nodes;links=material.node_tree.links;bsdf=nodes.get('Principled BSDF')
bsdf.inputs['Emission Strength'].default_value=0
def tex(name,space):
 image=bpy.data.images.load(str(p/name));image.colorspace_settings.name=space;image.pack()
 node=nodes.new('ShaderNodeTexImage');node.image=image;return node
base=tex('not-a-normal.png','sRGB');links.new(base.outputs['Color'],bsdf.inputs['Base Color'])
orm=tex('not-metallic.png','Non-Color');separate=nodes.new('ShaderNodeSeparateColor');separate.mode='RGB'
links.new(orm.outputs['Color'],separate.inputs['Color']);links.new(separate.outputs['Blue'],bsdf.inputs['Metallic']);links.new(separate.outputs['Green'],bsdf.inputs['Roughness'])
normal=tex('not-basecolor.png','Non-Color');mapping=nodes.new('ShaderNodeNormalMap');mapping.space='TANGENT';mapping.uv_map=mesh.data.uv_layers[0].name;mapping.inputs['Strength'].default_value=0.75
links.new(normal.outputs['Color'],mapping.inputs['Color']);links.new(mapping.outputs['Normal'],bsdf.inputs['Normal'])
bpy.ops.wm.save_as_mainfile(filepath=str(p/'supported.blend'),compress=False)
math=nodes.new('ShaderNodeMath');math.operation='MULTIPLY';links.new(separate.outputs['Blue'],math.inputs[0]);links.new(math.outputs[0],bsdf.inputs['Metallic'])
bpy.ops.wm.save_as_mainfile(filepath=str(p/'unsupported.blend'),compress=False)
`);
 const run=spawnSync(blender,["--background","--factory-startup","--disable-autoexec","--python-exit-code","1","--python",setup,"--",project],{encoding:"utf8",timeout:90_000});
 assert.equal(run.status,0,run.stdout+run.stderr);
 fs.mkdirSync(path.join(unity,"Assets"),{recursive:true});
 put(unity,"ProjectSettings/ProjectVersion.txt","m_EditorVersion: 6000.3.21f1\n");
 put(unity,"ProjectSettings/GraphicsSettings.asset","GraphicsSettings:\n  m_CustomRenderPipeline: {fileID: 0}\n");
 put(unity,"ProjectSettings/QualitySettings.asset","QualitySettings:\n  m_CurrentQuality: 0\n  m_QualitySettings:\n  - serializedVersion: 4\n    customRenderPipeline: {fileID: 0}\n  m_PerPlatformDefaultQuality:\n    Standalone: 0\n");
 put(unity,"Packages/manifest.json",'{"dependencies":{}}');
 const object:GraphicsObject={id:"material-object",name:"Fixture",kind:"prop",createdAt:"fixture",selectedTasks:[],instruction:"",settings:{},references:[],accepted:{}};
 const version=(name:string):AssetVersion=>({id:name,objectId:object.id,role:"model",slot:"main",label:name,createdAt:"fixture",sourceVersionIds:[],provenance:{type:"import"},warnings:[],files:[{path:name+".blend",sha256:hash(path.join(project,name+".blend")),bytes:fs.statSync(path.join(project,name+".blend")).size,kind:"blend"}]});
 const originals=Object.fromEntries(fs.readdirSync(project).map(name=>[name,hash(path.join(project,name))]));
 const supported=version("supported");
 const args={projectRoot:project,object,versions:[supported],profile:readUnityTarget(unity),blenderPath:blender,resources:path.resolve("integrations")};
 const delivery=await prepareUnityDelivery(args);assert.equal(delivery.status,"queued",delivery.errors.join("\n"));
 const requestPath=path.join(unity,`Library/PartsmithGraphicsStaging/${delivery.id}/request.json`);
 const request=JSON.parse(fs.readFileSync(requestPath,"utf8"));
 assert.equal(request.materialManifest,delivery.destination+"/Generated/materials.json");
 const manifestFile=request.files.find((f:any)=>f.destination===request.materialManifest);
 const manifest=JSON.parse(fs.readFileSync(manifestFile.source,"utf8"));
 const binding=manifest.materials[0];assert.equal(binding.supported,true,binding.warning);
 assert.match(binding.baseColorTexture,/not-a-normal/);assert.match(binding.normalTexture,/not-basecolor/);
 assert.deepEqual(binding.baseColor,[1,1,1,1]);assert.equal(binding.normalScale,0.75);
 assert.equal(binding.metallicSource.channel,"B");assert.equal(binding.roughnessSource.channel,"G");
 assert.equal(manifest.originalImages.length,3);assert.equal(manifest.derivedImages.length,1);
 for(const image of manifest.originalImages){const file=request.files.find((f:any)=>f.destination.endsWith("/"+image.path));assert.equal(hash(file.source),image.sha256);assert.ok(Object.values(originals).includes(image.sha256));}
 const derived=request.files.find((f:any)=>f.destination.endsWith("/"+binding.metallicGlossTexture));
 const pixels=PNG.sync.read(fs.readFileSync(derived.source));assert.equal(pixels.width,4096);assert.equal(pixels.height,4096);
 const at=(x:number,y:number)=>[...pixels.data.subarray((y*pixels.width+x)*4,(y*pixels.width+x)*4+4)];
 assert.deepEqual(at(0,0),[51,0,0,191]);assert.deepEqual(at(4095,4095),[204,0,0,63]);
 assert.equal(fs.existsSync(path.join(unity,delivery.destination)),false,"Queueing must not run Unity or import generated assets");
 const again=await prepareUnityDelivery(args);assert.equal(again.id,delivery.id);
 put(unity,`Library/PartsmithGraphicsStaging/${delivery.id}/request.json`,JSON.stringify({...request,materialManifest:undefined}));
 assert.equal(inspectUnityDelivery(unity,delivery).status,"failed","Missing role manifest binding must not silently become fallback");
 put(unity,`Library/PartsmithGraphicsStaging/${delivery.id}/request.json`,JSON.stringify(request));
 // Use another fake target so the still-pending delivery is preserved.
 const other=path.join(root,"other-unity");fs.mkdirSync(path.join(other,"Assets"),{recursive:true});
 fs.cpSync(path.join(unity,"ProjectSettings"),path.join(other,"ProjectSettings"),{recursive:true});fs.cpSync(path.join(unity,"Packages"),path.join(other,"Packages"),{recursive:true});
 const unsupported=await prepareUnityDelivery({...args,versions:[version("unsupported")],profile:readUnityTarget(other)});
 assert.equal(unsupported.status,"queued",unsupported.errors.join("\n"));assert.ok(unsupported.warnings.some(w=>w.includes("Scalar requires an RGB Separate Color")));
 const uq=JSON.parse(fs.readFileSync(path.join(other,`Library/PartsmithGraphicsStaging/${unsupported.id}/request.json`),"utf8"));
 const um=JSON.parse(fs.readFileSync(uq.files.find((f:any)=>f.destination===uq.materialManifest).source,"utf8"));
 assert.equal(um.materials[0].supported,false);assert.equal(um.derivedImages.length,0);
 for(const [name,digest] of Object.entries(originals))assert.equal(hash(path.join(project,name)),digest,"Original bytes changed: "+name);
});
