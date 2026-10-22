import bpy, pathlib, os, sys, json, runpy, hashlib, struct
repo=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(repo/'integrations/blender'))
from graphics_glb import active_uv_first_export, export_packed_glb, inspect_glb
root=pathlib.Path(os.environ['GRAPHICS_UV_EXPORT_ROOT']);root.mkdir(parents=True,exist_ok=True)
checks=[];sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def worker(name,script,spec):
    request=root/(name+'.json');request.write_text(json.dumps(spec));sys.argv=['worker','--',str(request)]
    runpy.run_path(str(repo/'integrations/blender'/script),run_name='__main__')
    return pathlib.Path(spec['output'])
def native(file):
    bpy.ops.wm.open_mainfile(filepath=str(file),load_ui=False,use_scripts=False)
    return {o.name:{'location':list(o.location),'rotation':list(o.rotation_euler),'scale':list(o.scale),'world':[list(r) for r in o.matrix_world],'vertices':[tuple(v.co) for v in o.data.vertices],'polygons':[tuple(p.vertices) for p in o.data.polygons],'uv':[(l.name,l.active_render,[tuple(x.uv) for x in l.data]) for l in o.data.uv_layers],'active':o.data.uv_layers.active.name,'materials':[(m.name,dict((k,list(m.node_tree.nodes.get('Principled BSDF').inputs[k].default_value) if k=='Base Color' else m.node_tree.nodes.get('Principled BSDF').inputs[k].default_value) for k in ('Base Color','Roughness','Metallic','Alpha'))) for m in o.data.materials]} for o in bpy.context.scene.objects if o.type=='MESH'}
def validate_export(file,expected):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if file.suffix=='.fbx':bpy.ops.import_scene.fbx(filepath=str(file),use_image_search=False)
    else:bpy.ops.import_scene.gltf(filepath=str(file))
    for o in bpy.context.scene.objects:
        if o.type!='MESH':continue
        source=expected[o.name];order=[source['active']]+[name for name,_,_ in source['uv'] if name!=source['active']]
        assert len(o.data.uv_layers)==len(order)
        # FBX retains polygon/corner indices; glTF splits vertices and triangulates.
        if file.suffix=='.fbx':
            assert [l.name for l in o.data.uv_layers]==order
            for l in o.data.uv_layers:assert [tuple(x.uv) for x in l.data]==next(v for name,_,v in source['uv'] if name==l.name)
        chosen=dict((n,v) for n,_,v in source['uv'])[source['active']]
        assert o.data.uv_layers.active_index==0
        # Every imported corner must retain a corner pair from its source UV set.
        for index,l in enumerate(o.data.uv_layers):
            original=dict((n,v) for n,_,v in source['uv'])[order[index]]
            assert all(any(max(abs(a-b) for a,b in zip(item.uv,uv))<2e-6 for uv in original) for item in l.data)

settings={'subject':'box','variationSeed':2,'faceLimit':10000,'quad':True,'symmetry':True,'attr.style':'lowpoly','attr.shape':'angular','attr.container':'chest','attr.interior':'hollow','attr.lid':'open'}
input_root=root/'input';input_root.mkdir()
box=worker('m04','graphics_procedural.py',{'taskId':'M04','settings':settings,'output':str(root/'m04'),'identity':'uv-m04','inputRoot':str(input_root),'files':[]})
baseline=native(box/'Asset.blend');assert all(len(o['uv'])==2 and o['active']==o['uv'][1][0] for o in baseline.values())
for ext in ('fbx','glb'):validate_export(box/('Asset.'+ext),baseline)
checks.append('M04 editable two-layer order unchanged; selected UV0 and all UV sets exported')
previous=box/'Asset.blend'
for operation,options in [('T02',{'uvMode':'keep'}),('T05',{'color':'#FF8000','roughness':.2,'metallic':0,'emission':0,'opacity':1})]:
    immutable=sha(previous);before=native(previous)
    result=worker(operation,'graphics_procedural.py',{'taskId':operation,'settings':options,'output':str(root/operation),'identity':'uv-'+operation,'source':str(previous),'inputRoot':str(root),'files':[{'local':str(previous),'original':'Asset.blend','sha256':immutable}]})
    actual=native(result/'Asset.blend')
    if operation=='T02':assert actual==before
    else:assert {n:{k:v for k,v in d.items() if k!='materials'} for n,d in actual.items()}=={n:{k:v for k,v in d.items() if k!='materials'} for n,d in before.items()}
    for ext in ('fbx','glb'):validate_export(result/('Asset.'+ext),actual)
    assert sha(previous)==immutable
    checks.append(operation+' native original preserved; two-layer active-first exports retain all UV corners')
    previous=result/'Asset.blend'
for operation in ('A05','X04'):
    immutable=sha(previous);before=native(previous)
    result=worker(operation.lower(),'graphics_local.py',{'operation':operation,'scale':1,'pivot':'keep','format':'both','source':str(previous),'sourceSha256':immutable,'output':str(root/operation.lower()),'identity':'uv-'+operation})
    assert native(result/'asset.blend')==before
    for ext in ('fbx','glb'):validate_export(result/('asset.'+ext),before)
    assert sha(previous)==immutable
    checks.append(operation+' native original preserved; selected UV0/all UV sets exported')
# T02's existing local-UV contract remains one selected new layer in exports only.
local=worker('t02-local','graphics_procedural.py',{'taskId':'T02','settings':{'uvMode':'local'},'output':str(root/'t02-local'),'identity':'uv-local-unchanged','source':str(previous),'inputRoot':str(root),'files':[{'local':str(previous),'original':'Asset.blend','sha256':sha(previous)}]})
assert all(len(o['uv'])==3 for o in native(local/'Asset.blend').values())
report=json.loads((local/'inspection.json').read_text());assert all(item['layerCount']==1 for item in report['exportUV'])
for ext in ('fbx','glb'):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if ext=='fbx':bpy.ops.import_scene.fbx(filepath=str(local/'Asset.fbx'),use_image_search=False)
    else:bpy.ops.import_scene.gltf(filepath=str(local/'Asset.glb'))
    assert all(len(o.data.uv_layers)==1 for o in bpy.context.scene.objects if o.type=='MESH')
checks.append('T02 local single-newUV/exportUV report contract unchanged')

# Tiny packed image and two explicit, distinct coordinate sets exercise texCoord semantics.
bpy.ops.wm.read_factory_settings(use_empty=True);bpy.ops.mesh.primitive_plane_add();obj=bpy.context.object
old=obj.data.uv_layers[0];old.name='Old UV';chosen=obj.data.uv_layers.new(name='Chosen UV')
old.data[0].pin_uv=True
for i,uv in enumerate(((.2,.2),(.8,.2),(.8,.8),(.2,.8))):chosen.data[i].uv=uv
obj.data.uv_layers.active_index=1;chosen.active_render=True
tag=obj.data.attributes.new(name='qa_vertex_tag',type='INT',domain='POINT')
for i,item in enumerate(tag.data):item.value=37+i
group=obj.vertex_groups.new(name='QA weights')
for i in range(len(obj.data.vertices)):group.add([i],.25+i*.1,'REPLACE')
obj.shape_key_add(name='Basis');key=obj.shape_key_add(name='QA morph');key.data[0].co.z=.01
def extra_signature(data):
    return {'positions':[tuple(v.co) for v in data.vertices],'polygons':[tuple(p.vertices) for p in data.polygons],'tags':[v.value for v in data.attributes['qa_vertex_tag'].data],'weights':[[(g.group,g.weight) for g in v.groups] for v in data.vertices],'shapes':[(k.name,[tuple(v.co) for v in k.data]) for k in data.shape_keys.key_blocks]}
extra_before=extra_signature(obj.data)
image=bpy.data.images.new('TinyOriginal',width=2,height=2);image.generated_color=(.2,.4,.6,1);image.filepath_raw=str(root/'tiny.png');image.file_format='PNG';image.save();raw=(root/'tiny.png').read_bytes();image.pack();image.source='FILE'
mat=bpy.data.materials.new('Explicit other UV');mat.use_nodes=True;obj.data.materials.append(mat)
texture=mat.node_tree.nodes.new('ShaderNodeTexImage');texture.image=image;uvnode=mat.node_tree.nodes.new('ShaderNodeUVMap');uvnode.uv_map='Old UV';mat.node_tree.links.new(uvnode.outputs['UV'],texture.inputs['Vector']);mat.node_tree.links.new(texture.outputs['Color'],mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
source=root/'textured.blend';bpy.ops.wm.save_as_mainfile(filepath=str(source));original_sha=sha(source)
source_data=obj.data;source_uv=[(l.name,[tuple(x.uv) for x in l.data]) for l in obj.data.uv_layers];source_nodes=[(n.name,n.type) for n in mat.node_tree.nodes]
try:
    with active_uv_first_export([obj],fbx=True):raise AssertionError('FBX other-UV texture accepted')
except RuntimeError as error:assert 'GLB' in str(error) and 'Old UV' in str(error)
checks.append('FBX explicit otherUV texture blocked before export with GLB-only guidance')
with active_uv_first_export([obj],fbx=False):
    assert [l.name for l in obj.data.uv_layers]==['Chosen UV','Old UV']
    assert obj.data.uv_layers['Old UV'].data[0].pin_uv is True
    assert extra_signature(obj.data)==extra_before
    images=export_packed_glb(root/'explicit-other.glb',use_selection=True)
raw_glb=(root/'explicit-other.glb').read_bytes();size=struct.unpack_from('<I',raw_glb,12)[0];document=json.loads(raw_glb[20:20+size])
assert document['materials'][0]['pbrMetallicRoughness']['baseColorTexture']['texCoord']==1
assert images[0]['sha256']==hashlib.sha256(raw).hexdigest()
assert obj.data==source_data and [(l.name,[tuple(x.uv) for x in l.data]) for l in obj.data.uv_layers]==source_uv
assert [(n.name,n.type) for n in mat.node_tree.nodes]==source_nodes and bytes(image.packed_file.data)==raw
assert extra_signature(obj.data)==extra_before
checks.append('GLB explicit otherUV uses texCoord1 and exact original packed PNG; source mesh/material/image unchanged')
checks.append('mesh custom POINT attribute, vertex weights and all shape-key coordinates exact in copy and original')
uvnode.from_instancer=True
try:
    with active_uv_first_export([obj],fbx=False):raise AssertionError('instancer UV accepted')
except RuntimeError:pass
uvnode.from_instancer=False
coordinates=mat.node_tree.nodes.new('ShaderNodeTexCoord');coordinates.from_instancer=True;mat.node_tree.links.new(coordinates.outputs['UV'],texture.inputs['Vector'])
try:
    with active_uv_first_export([obj],fbx=False):raise AssertionError('instancer texture coordinates accepted')
except RuntimeError:pass
mat.node_tree.nodes.remove(coordinates);mat.node_tree.links.new(uvnode.outputs['UV'],texture.inputs['Vector'])
checks.append('Texture Coordinate from-instancer UV rejected')
attribute=mat.node_tree.nodes.new('ShaderNodeAttribute');attribute.attribute_name='Old UV';attribute.attribute_type='OBJECT';mat.node_tree.links.new(attribute.outputs['Vector'],texture.inputs['Vector'])
try:
    with active_uv_first_export([obj],fbx=False):raise AssertionError('object attribute accepted as mesh UV')
except RuntimeError:pass
mat.node_tree.nodes.remove(attribute);mat.node_tree.links.new(uvnode.outputs['UV'],texture.inputs['Vector'])
checks.append('instancer UV and OBJECT attribute coordinates rejected instead of guessed')
try:
    with active_uv_first_export([obj],fbx=False):raise ValueError('forced exporter failure')
except ValueError:pass
assert obj.data==source_data and [(l.name,[tuple(x.uv) for x in l.data]) for l in obj.data.uv_layers]==source_uv
checks.append('finally restores original mesh and UV order after exporter failure')
second=obj.copy();second.data=obj.data.copy();bpy.context.collection.objects.link(second)
originals=(obj.data,second.data);mesh_count=len(bpy.data.meshes)
corner=tuple(source_data.uv_layers['Old UV'].data[0].uv)
try:
    with active_uv_first_export([obj,second],fbx=False):source_data.uv_layers['Old UV'].data[0].uv=(.123,.456)
except RuntimeError as error:assert '원본 UV' in str(error)
else:raise AssertionError('source UV mutation not detected')
assert obj.data==originals[0] and second.data==originals[1] and len(bpy.data.meshes)==mesh_count
source_data.uv_layers['Old UV'].data[0].uv=corner
bpy.data.objects.remove(second,do_unlink=True);bpy.data.meshes.remove(originals[1])
checks.append('all objects restored and all private copies removed before preservation error is raised')
obj.data.uv_layers.active_index=0
try:
    with active_uv_first_export([obj],fbx=False):raise AssertionError('ambiguous active/render accepted')
except RuntimeError:pass
checks.append('active/render UV ambiguity blocked')
obj.data.uv_layers.active_index=1
before_local=sha(source)
try:worker('blocked-both','graphics_local.py',{'operation':'X04','scale':1,'pivot':'keep','format':'both','source':str(source),'sourceSha256':before_local,'output':str(root/'blocked-both'),'identity':'blocked-both'})
except RuntimeError as error:assert 'GLB' in str(error)
else:raise AssertionError('both export accepted unsupported FBX texture')
assert not (root/'blocked-both/asset.glb').exists() and not (root/'blocked-both/asset.fbx').exists() and not (root/'blocked-both/report.json').exists()
assert sha(source)==original_sha
checks.append('both preflight creates no FBX/GLB/report on unsupported UV binding; source SHA exact')
glb_only=worker('glb-only','graphics_local.py',{'operation':'X04','scale':1,'pivot':'keep','format':'glb','source':str(source),'sourceSha256':original_sha,'output':str(root/'glb-only'),'identity':'explicit-other-glb'})
raw_glb=(glb_only/'asset.glb').read_bytes();size=struct.unpack_from('<I',raw_glb,12)[0];document=json.loads(raw_glb[20:20+size])
assert document['materials'][0]['pbrMetallicRoughness']['baseColorTexture']['texCoord']==1
assert inspect_glb(raw_glb)[0]['sha256']==hashlib.sha256(raw).hexdigest() and sha(source)==original_sha
checks.append('actual X04 GLB-only retains explicit otherUV texCoord1 and exact packed PNG')
# A one-UV textured source remains valid for both formats.
bpy.ops.wm.open_mainfile(filepath=str(source),load_ui=False,use_scripts=False);obj=bpy.context.scene.objects[0]
obj.data.uv_layers.remove(obj.data.uv_layers['Old UV']);mat=obj.data.materials[0]
next(n for n in mat.node_tree.nodes if n.type=='UVMAP').uv_map='Chosen UV'
single=root/'single-textured.blend';bpy.ops.wm.save_as_mainfile(filepath=str(single));single_sha=sha(single)
single_out=worker('single-both','graphics_local.py',{'operation':'X04','scale':1,'pivot':'keep','format':'both','source':str(single),'sourceSha256':single_sha,'output':str(root/'single-both'),'identity':'single-both'})
assert (single_out/'asset.fbx').is_file() and (single_out/'asset.glb').is_file() and sha(single)==single_sha
assert inspect_glb((single_out/'asset.glb').read_bytes())[0]['sha256']==hashlib.sha256(raw).hexdigest()
checks.append('textured single explicit activeUV remains supported in both formats with exact packed PNG')
# No-UV untextured inputs retain their previous support.
bpy.ops.wm.read_factory_settings(use_empty=True);bpy.ops.mesh.primitive_cube_add();obj=bpy.context.object
for layer in list(obj.data.uv_layers):obj.data.uv_layers.remove(layer)
data=obj.data
with active_uv_first_export([obj],fbx=True) as records:assert records==[] and obj.data==data
checks.append('untextured no-UV mesh remains supported')
(root/'evidence.json').write_text(json.dumps({'status':'PASS','root':str(root),'checks':checks,'explicitGLB':str(root/'explicit-other.glb'),'paid':0,'GPT':0,'ARP':0},indent=2))
