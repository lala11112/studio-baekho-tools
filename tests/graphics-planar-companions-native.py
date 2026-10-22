import bpy,sys,pathlib,json,os,hashlib,copy
root=pathlib.Path(os.environ['PLANAR_COMPANION_ROOT']);root.mkdir(exist_ok=True)
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'integrations/blender'))
import graphics_planar_repair as p
bpy.ops.wm.read_factory_settings(use_empty=True)
mesh=bpy.data.meshes.new('OpenCube');mesh.from_pydata([(0,0,0),(1,0,0),(1,1,0),(0,1,0),(0,0,1),(1,0,1),(1,1,1),(0,1,1)],[],[(0,3,2,1),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)])
obj=bpy.data.objects.new('OpenCube',mesh);bpy.context.collection.objects.link(obj);obj.select_set(True);bpy.context.view_layer.objects.active=obj
uv=mesh.uv_layers.new(name='OriginalUV')
for face in mesh.polygons:
 for index,value in zip(face.loop_indices,[(0,0),(1,0),(1,1),(0,1)]):uv.data[index].uv=value
image=bpy.data.images.new('ExactPattern',width=2,height=2);image.pixels=[1,0,0,1,0,1,0,1,0,0,1,1,1,1,1,1];image.filepath_raw=str(root/'pattern.png');image.file_format='PNG';image.save()
material=bpy.data.materials.new('Textured');material.use_nodes=True;node=material.node_tree.nodes.new('ShaderNodeTexImage');node.image=image;material.node_tree.links.new(node.outputs['Color'],material.node_tree.nodes.get('Principled BSDF').inputs['Base Color']);obj.data.materials.append(material)
source=root/'external.fbx';bpy.ops.export_scene.fbx(filepath=str(source),use_selection=True,path_mode='RELATIVE',embed_textures=False,bake_anim=False,add_leaf_bones=False)
data=(root/'pattern.png').read_bytes();file={'path':'originals/pattern.png','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'kind':'image'}
q={'source':str(source),'sourceVersionId':'external','sourceSha256':p.file_hash(source),'identity':'native-companions','algorithmVersion':'planar-v2','mode':'inspect','output':str(root/'output'),'report':str(root/'inspect.json'),'sourceManifestVersion':1,'sourceCompanions':[file],'companionResources':[{'file':file,'stagedPath':str(root/'pattern.png')}]}
inspection=p.run(q);mesh=inspection['meshes'][0];boundary=next(b for b in mesh['boundaries'] if b['status']=='eligible')
repair=copy.deepcopy(q);repair.update(mode='repair',report=str(root/'repair.json'),inspectionId=inspection['inspectionId'],meshId=mesh['meshId'],selectedBoundaryIds=[boundary['id']],keptBoundaryIds=[b['id'] for b in mesh['boundaries'] if b['id']!=boundary['id']],materialPolicy=boundary['materialOptions'][0])
result=p.run(repair)
assert result['checks']['oldUVLayersPreserved'] and result['checks']['materialsAndImagesPreserved']
assert file['sha256'] in [t['sha256'] for t in result['textures']]
embedded={**q,'source':str(root/'output/asset.fbx'),'sourceSha256':p.file_hash(root/'output/asset.fbx'),'sourceCompanions':[],'companionResources':[],'report':str(root/'embedded.json')};p.run(embedded)
checks=['external-inspect','selected-only-repair','original-uv-preserved','packed-image-bytes-exact','embedded-fbx-regression']
conflict=root/'output/pattern.png';conflict.write_bytes(b'different registered bytes')
conflict_file={**file,'sha256':p.file_hash(conflict),'bytes':conflict.stat().st_size}
negative={**embedded,'sourceCompanions':[conflict_file],'companionResources':[{'file':conflict_file,'stagedPath':str(conflict)}]}
try:p.run(negative);raise AssertionError('conflicting embedded image accepted')
except ValueError as error:
 assert 'disagree' in str(error);checks.append('embedded-companion-conflict-blocked')
for name in ['unlisted','missing','wrong-hash','duplicate-name']:
 negative=copy.deepcopy(q);negative['report']=str(root/(name+'.json'))
 if name=='unlisted':negative['sourceCompanions']=[];negative['companionResources']=[]
 if name=='missing':negative['companionResources'][0]['stagedPath']=str(root/'missing.png')
 if name=='wrong-hash':negative['sourceCompanions'][0]['sha256']='0'*64;negative['companionResources'][0]['file']['sha256']='0'*64
 if name=='duplicate-name':negative['sourceCompanions']*=2;negative['companionResources']*=2
 try:p.run(negative);raise AssertionError(name+' accepted')
 except (ValueError,RuntimeError):checks.append(name+'-blocked')
assert (root/'pattern.png').read_bytes()==data and p.file_hash(source)==q['sourceSha256']
(root/'evidence.json').write_text(json.dumps({'passed':True,'checks':checks,'imageSha256':file['sha256'],'sourceSha256':q['sourceSha256'],'repair':result},indent=2))
