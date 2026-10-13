// Synthetic three-part Humanoid/optional-finger validation in an isolated Unity project. Import only.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {runProcess} from '../engine/local';import {prepareUnityDelivery,readUnityTarget,inspectUnityDelivery} from '../engine/graphics-unity';
import {humanoidBoneMap,type UnityRigContract} from '../shared/graphics-rig';import type {AssetVersion,GraphicsObject} from '../shared/graphics';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ps-humanoid-check-')),unity=path.join(root,'Unity'),source=path.join(root,'Source');
const blender='C:/Program Files/Blender Foundation/Blender 5.0/blender.exe',editor='C:/Program Files/Unity/Hub/Editor/6000.3.21f1/Editor/Unity.exe';
const sha=(file:string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const put=(relative:string,text:string)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file;};
const contract:UnityRigContract={schemaVersion:1,versionId:'human-rig',producerVersionId:'human-rig',producerTaskId:'fixture-R01',rigType:'humanoid',fingers:true,hairBinding:'head',requiredParts:['body','hair','head'],humanBones:humanoidBoneMap(true)};
fs.mkdirSync(path.join(unity,'Assets'),{recursive:true});fs.mkdirSync(source);
put('Unity/ProjectSettings/ProjectVersion.txt','m_EditorVersion: 6000.3.21f1\n');put('Unity/Packages/manifest.json',JSON.stringify({dependencies:{'com.unity.modules.animation':'1.0.0','com.unity.modules.imageconversion':'1.0.0','com.unity.modules.jsonserialize':'1.0.0','com.unity.modules.physics':'1.0.0','com.unity.modules.uielements':'1.0.0'}}));
const config=put('fixture.json',JSON.stringify({contract,source,helpers:path.resolve('integrations/blender')}));
const fixture=put('fixture.py',String.raw`
import bpy,pathlib,sys,json
from mathutils import Vector
q=json.loads(pathlib.Path(sys.argv[sys.argv.index('--')+1]).read_text());sys.path.insert(0,q['helpers']);from graphics_humanoid import inspect_humanoid
bpy.ops.wm.read_factory_settings(use_empty=True);bpy.ops.object.armature_add();rig=bpy.context.object;rig.name='Rig'
bpy.ops.object.mode_set(mode='EDIT');rig.data.edit_bones.remove(rig.data.edit_bones[0])
def bone(name,head,tail,parent=None):
 b=rig.data.edit_bones.new(name);b.head=head;b.tail=tail
 if parent:b.parent=rig.data.edit_bones[parent]
bone('pelvis',(0,0,1),(0,0,1.15));bone('spine',(0,0,1.15),(0,0,1.4),'pelvis');bone('chest',(0,0,1.4),(0,0,1.6),'spine');bone('neck',(0,0,1.6),(0,0,1.7),'chest');bone('head',(0,0,1.7),(0,0,1.95),'neck')
for side,sign in [('L',1),('R',-1)]:
 bone('upper_arm.'+side,(sign*.2,0,1.5),(sign*.55,0,1.5),'chest');bone('forearm.'+side,(sign*.55,0,1.5),(sign*.85,0,1.5),'upper_arm.'+side);bone('hand.'+side,(sign*.85,0,1.5),(sign*1,0,1.5),'forearm.'+side)
 bone('thigh.'+side,(sign*.15,0,1),(sign*.15,0,.55),'pelvis');bone('shin.'+side,(sign*.15,0,.55),(sign*.15,0,.1),'thigh.'+side);bone('foot.'+side,(sign*.15,0,.1),(sign*.15,-.2,.1),'shin.'+side)
 for f,finger in enumerate(['thumb','index','middle','ring','little']):
  for index in range(1,4):
   bone(finger+'.0'+str(index)+'.'+side,(sign*(.96+(index-1)*.07),(f-2)*.035,1.5),(sign*(.96+index*.07),(f-2)*.035,1.5),'hand.'+side if index==1 else finger+'.0'+str(index-1)+'.'+side)
bpy.ops.object.mode_set(mode='OBJECT')
corners=[(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)];cube_faces=[(0,1,2,3),(4,7,6,5),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)]
for part in ['body','head','hair']:
 names=[item['boneName'] for item in q['contract']['humanBones'] if item['boneName']!='head'] if part=='body' else ['head']
 vertices=[];faces=[];groups=[]
 for name in names:
  center=(rig.data.bones[name].head_local+rig.data.bones[name].tail_local)*.5
  if part=='hair':center+=Vector((0,.03,.09))
  offset=len(vertices);vertices.extend([center+Vector(c)*.016 for c in corners]);faces.extend([tuple(offset+i for i in face) for face in cube_faces]);groups.append((name,list(range(offset,offset+8))))
 data=bpy.data.meshes.new(part);data.from_pydata(vertices,[],faces);mesh=bpy.data.objects.new('Part_'+part,data);bpy.context.collection.objects.link(mesh);mesh['partsmith_id']='mesh-'+part;mesh['partsmith_part_id']='part-'+part;mesh.parent=rig
 mod=mesh.modifiers.new('Skin','ARMATURE');mod.object=rig
 for name,indices in groups:mesh.vertex_groups.new(name=name).add(indices,1,'REPLACE')
 material=bpy.data.materials.new(part+'Material');material.use_nodes=True;mesh.data.materials.append(material)
evidence=inspect_humanoid(q['contract'],True);assert len(evidence['jointEvidence'])==46
rejections=[]
def reject(label,call):
 try:call()
 except RuntimeError:rejections.append(label)
 else:raise AssertionError('Failed to reject '+label)
hair=bpy.data.objects['Part_hair'];group=hair.vertex_groups['head'];group.add(list(range(8)),.5,'REPLACE');reject('unnormalized',lambda:inspect_humanoid(q['contract']));group.add(list(range(8)),1,'REPLACE')
group.remove(list(range(8)));hair.vertex_groups.new(name='neck').add(list(range(8)),1,'REPLACE');reject('hair-not-head',lambda:inspect_humanoid(q['contract']));hair.vertex_groups.remove(hair.vertex_groups['neck']);group.add(list(range(8)),1,'REPLACE')
finger=rig.data.bones['little.03.R'];finger.name='missing';reject('missing-finger',lambda:inspect_humanoid(q['contract']));finger.name='little.03.R'
other=rig.copy();other.data=rig.data.copy();bpy.context.collection.objects.link(other);reject('multiple-armatures',lambda:inspect_humanoid(q['contract']));bpy.data.objects.remove(other,do_unlink=True)
hair.modifiers['Skin'].show_viewport=False;reject('missing-skin',lambda:inspect_humanoid(q['contract']));hair.modifiers['Skin'].show_viewport=True
bpy.ops.wm.save_as_mainfile(filepath=str(pathlib.Path(q['source'])/'rig.blend'),compress=False)
pathlib.Path(q['source'],'local-evidence.json').write_text(json.dumps({'evidence':evidence,'rejections':rejections}))
`);
console.log(JSON.stringify({root,phase:'local Humanoid fixture and joint rejection checks'}));
await runProcess(blender,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',fixture,'--',config]);
console.log(JSON.stringify({root,phase:'initialize isolated Unity'}));await runProcess(editor,['-batchmode','-nographics','-quit','-projectPath',unity,'-logFile',path.join(root,'initialize.log')]);
const object:GraphicsObject={id:'human-fixture',name:'Human parts',kind:'character',createdAt:'',instruction:'',settings:{},selectedTasks:[],references:[],accepted:{'rig:main':'human-rig'}};
const native=path.join(source,'rig.blend');const version:AssetVersion={id:'human-rig',objectId:object.id,role:'rig',slot:'main',label:'human',createdAt:'',sourceVersionIds:[],provenance:{type:'codex'},warnings:[],files:[{path:'rig.blend',sha256:sha(native),bytes:fs.statSync(native).size,kind:'blend'}]};
const args={projectRoot:source,object,versions:[version],profile:readUnityTarget(unity),blenderPath:blender,resources:path.resolve('integrations'),rigContract:contract};
const launch=async(name:string)=>runProcess(editor,['-batchmode','-nographics','-quit','-projectPath',unity,'-executeMethod','Partsmith.Graphics.PartsmithGraphicsBridge.ProcessAllForBatch','-logFile',path.join(root,name+'.log')]);
const first=await prepareUnityDelivery(args);assert.equal(first.status,'queued',first.errors.join('\n'));console.log(JSON.stringify({root,phase:'explicit Humanoid import',delivery:first.id}));await launch('first');
const receipt=inspectUnityDelivery(unity,first);assert.equal(receipt.status,'imported',receipt.errors.join('\n'));assert.equal(receipt.rig?.avatarHuman,true);assert.equal(receipt.rig?.humanBones.length,47);assert.deepEqual(receipt.rig?.parts.map(part=>part.partId).sort(),['body','hair','head']);
const modelMeta=path.join(unity,first.destination,'Generated/Asset.fbx.meta'),modelGuid=fs.readFileSync(modelMeta,'utf8').match(/^guid: (.+)$/m)![1];
const kept=['Generated/Asset.prefab.meta','User/Asset.prefab','User/Asset.prefab.meta'].map(name=>({name,sha256:sha(path.join(unity,first.destination,name))}));
const nextVersion={...version,id:'human-rig-reimport'},nextContract={...contract,versionId:nextVersion.id};object.accepted['rig:main']=nextVersion.id;
const second=await prepareUnityDelivery({...args,versions:[nextVersion],rigContract:nextContract});assert.equal(second.status,'queued',second.errors.join('\n'));await launch('second');const secondReceipt=inspectUnityDelivery(unity,second);assert.equal(secondReceipt.status,'imported',secondReceipt.errors.join('\n'));
for(const item of kept)assert.equal(sha(path.join(unity,first.destination,item.name)),item.sha256,item.name+' changed');assert.equal(fs.readFileSync(modelMeta,'utf8').match(/^guid: (.+)$/m)![1],modelGuid);assert.equal(sha(native),version.files[0].sha256);
const report=path.join(unity,'Library/PartsmithGraphicsResults',second.id+'.json'),saved=fs.readFileSync(report,'utf8'),tampered=JSON.parse(saved);tampered.rig.avatarHuman=false;fs.writeFileSync(report,JSON.stringify(tampered));assert.equal(inspectUnityDelivery(unity,second).status,'failed');fs.writeFileSync(report,saved);
const evidence={root,receipt,secondReceipt,local:JSON.parse(fs.readFileSync(path.join(source,'local-evidence.json'),'utf8')),sourceBytesPreserved:true,userPrefabBytesPreserved:true,generatedGuidsPreserved:true,tamperedAvatarRejected:true,playMode:false,modelTurns:0,paidSubmissions:0};fs.mkdirSync('artifacts/runtime',{recursive:true});fs.writeFileSync('artifacts/runtime/graphics-humanoid-check.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({verified:true,evidence:'artifacts/runtime/graphics-humanoid-check.json'}));
