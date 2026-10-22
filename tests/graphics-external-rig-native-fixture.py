import bpy, sys, os, tempfile, json
from mathutils import Vector
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'integrations'/'blender'))
import graphics_external_rig as w
root=Path(tempfile.mkdtemp(prefix='ps-external-rig-'))
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_uv_sphere_add(segments=12,ring_count=8)
obj=bpy.context.object; obj.name='Part_body'; obj['partsmith_id']='fixture-body'
material=bpy.data.materials.new('Fixture_original_material'); material.use_nodes=True
image=bpy.data.images.new('FixtureTexture',width=4,height=4); image.generated_color=(.2,.6,.8,1); image.pack()
node=material.node_tree.nodes.new('ShaderNodeTexImage'); node.image=image
material.node_tree.links.new(node.outputs['Color'],material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
obj.data.materials.append(material)
source=root/'fixture.blend'; bpy.ops.wm.save_as_mainfile(filepath=str(source))
req={'schemaVersion':1,'operation':'prepare','sourcePath':str(source),'sourceSha256':w.sha(source),'outputDir':str(root/'prepare')}
prep=w.run(req); assert {f['role'] for f in prep['files']}=={'source-image','source-scene','preparation-fbx'}
report=root/'preparation.json'; report.write_text(json.dumps(prep))
# Add smooth two-joint weights on the handoff mesh, retaining exact geometry.
w.load_scene(root/'prepare'/'handoff.fbx')
obj=next(o for o in bpy.context.scene.objects if o.type=='MESH')
assert any(n.type=='TEX_IMAGE' and n.image and n.image.size[0]==4 for n in obj.data.materials[0].node_tree.nodes)
bpy.ops.object.armature_add(); rig=bpy.context.object; rig.name='ExternalRig'
bpy.ops.object.mode_set(mode='EDIT'); rig.data.edit_bones[0].name='hips'
bone=rig.data.edit_bones.new('spine_twist'); bone.head=(0,0,1); bone.tail=(0,0,2); bone.parent=rig.data.edit_bones['hips']
bpy.ops.object.mode_set(mode='OBJECT')
a=obj.vertex_groups.new(name='hips'); b=obj.vertex_groups.new(name='spine_twist')
for v in obj.data.vertices:
    t=max(.05,min(.95,(v.co.z+1)/2)); a.add([v.index],1-t,'REPLACE'); b.add([v.index],t,'REPLACE')
mod=obj.modifiers.new('Skin','ARMATURE'); mod.object=rig
returned=root/'returned.fbx'
bpy.ops.export_scene.fbx(filepath=str(returned),object_types={'MESH','ARMATURE'},add_leaf_bones=False,bake_anim=False,axis_forward='-Z',axis_up='Y')
req.update(operation='inspect-return',outputDir=str(root/'inspect'),preparationReportPath=str(report),preparationReportSha256=w.sha(report),returnedFbxPath=str(returned),returnedFbxSha256=w.sha(returned))
inspection=w.run(req); assert len(inspection['bones'])==2
req.update(operation='import-return',outputDir=str(root/'import'))
result=w.run(req); assert len(result['files'])==4
w.load_scene(root/'import'/'rigged-original.blend')
assert max(abs(a-b) for p,q in zip(w.snapshot()[0]['positions'],prep['scene']['meshes'][0]['positions']) for a,b in zip(p,q)) < 0.000002
restored_rig=next(o for o in bpy.context.scene.objects if o.type=='ARMATURE')
assert 'spine_twist' in restored_rig.data.bones
restored_mesh=next(o for o in bpy.context.scene.objects if o.type=='MESH')
assert restored_mesh.data.materials[0].name=='Fixture_original_material'
print('IMAGES',[(n.type,n.image.name if n.type=='TEX_IMAGE' and n.image else None) for n in restored_mesh.data.materials[0].node_tree.nodes])
print('PACKS',[(i.name,i.source,bool(i.packed_file)) for i in bpy.data.images])
rest_positions=w.snapshot()[0]['positions']
restored_rig.pose.bones['spine_twist'].rotation_mode='XYZ'
restored_rig.pose.bones['spine_twist'].rotation_euler.x=.5
bpy.context.view_layer.update()
evaluated=restored_mesh.evaluated_get(bpy.context.evaluated_depsgraph_get())
assert max((evaluated.matrix_world@v.co-Vector(p)).length for v,p in zip(evaluated.data.vertices,rest_positions))>.01
posed_positions=[list(evaluated.matrix_world@v.co) for v in evaluated.data.vertices]
restored_rig.pose.bones['spine_twist'].rotation_euler.x=0
bpy.context.view_layer.update()
# Explicit proper rotation/scale/translation is proven against every source vertex.
from mathutils import Matrix
transform=Matrix.Translation((2,-3,1))@Matrix.Rotation(1.5707963267948966,4,'Y')@Matrix.Scale(2.5,4)
w.load_scene(returned)
for o in list(bpy.context.scene.objects):
    if o.type in {'MESH','ARMATURE'}: o.matrix_world=transform@o.matrix_world
transformed=root/'transformed.fbx'
bpy.ops.export_scene.fbx(filepath=str(transformed),object_types={'MESH','ARMATURE'},add_leaf_bones=False,bake_anim=False,axis_forward='-Z',axis_up='Y')
w.load_scene(transformed)
reference_rig=next(o for o in bpy.context.scene.objects if o.type=='ARMATURE')
reference_mesh=next(o for o in bpy.context.scene.objects if o.type=='MESH')
reference_rig.pose.bones['spine_twist'].rotation_mode='XYZ'; reference_rig.pose.bones['spine_twist'].rotation_euler.x=.5
bpy.context.view_layer.update()
reference_eval=reference_mesh.evaluated_get(bpy.context.evaluated_depsgraph_get())
reference_positions=[list(transform.inverted()@reference_eval.matrix_world@v.co) for v in reference_eval.data.vertices]
reference_matrix=[list(r) for r in transform.inverted()@reference_rig.matrix_world]
reference_bone=[list(r) for r in reference_rig.data.bones['spine_twist'].matrix_local]
req.update(operation='import-return',outputDir=str(root/'transformed-import'),returnedFbxPath=str(transformed),returnedFbxSha256=w.sha(transformed),sourceToReturnedMatrix=[list(r) for r in transform])
transformed_result=w.run(req)
assert 'coordinateTransformVerified' in transformed_result['checks']
w.load_scene(root/'transformed-import'/'rigged-original.blend')
assert w.snapshot()[0]['uv']==prep['scene']['meshes'][0]['uv']
assert max(abs(a-b) for p,q in zip(w.snapshot()[0]['positions'],rest_positions) for a,b in zip(p,q))<.000002
posed_rig=next(o for o in bpy.context.scene.objects if o.type=='ARMATURE')
posed_mesh=next(o for o in bpy.context.scene.objects if o.type=='MESH')
posed_rig.pose.bones['spine_twist'].rotation_mode='XYZ'; posed_rig.pose.bones['spine_twist'].rotation_euler.x=.5
bpy.context.view_layer.update()
evaluated=posed_mesh.evaluated_get(bpy.context.evaluated_depsgraph_get())
pose_error=max((evaluated.matrix_world@evaluated.data.vertices[key[1]].co-Vector(p)).length for key,p in zip(transformed_result['correspondence'][0],reference_positions))
assert pose_error<.00001, pose_error
for bad_matrix in ([[[1,0,0,0],[0,2,0,0],[0,0,1,0],[0,0,0,1]]],):
    try: w.coordinate_transform(bad_matrix[0])
    except ValueError: pass
    else: raise AssertionError('nonuniform scale accepted')
req.pop('sourceToReturnedMatrix')
req.update(operation='inspect-return',outputDir=str(root/'unknown-transform'))
try: w.run(req)
except ValueError: pass
else: raise AssertionError('unknown coordinate change accepted')
# Changed positions and coincident sources fail closed.
s=[{'positions':[[0,0,0],[1,0,0],[0,1,0]],'triangles':[[0,1,2]]}]
assert w.correspondence(s,s)
for bad in ([{'positions':[[0,0,0],[2,0,0],[0,1,0]],'triangles':[[0,1,2]]}],):
    try: w.correspondence(s,bad)
    except ValueError: pass
    else: raise AssertionError('changed geometry accepted')
try: w.correspondence(s+s,s)
except ValueError: pass
else: raise AssertionError('ambiguous source accepted')
# Alternate diagonal and vertex ordering/splits are accepted without changing geometry.
quad=[{'positions':[[0,0,0],[1,0,0],[1,1,0],[0,1,0]],'polygons':[[0,1,2,3]],'triangles':[[0,1,2],[0,2,3]]}]
other=[{'positions':[[1,1,0],[0,1,0],[0,0,0],[1,0,0],[1,0,0]],'triangles':[[2,4,1],[3,0,1]]}]
assert w.correspondence(quad,other)
assert w.sha(source)==req['sourceSha256']
assert w.snapshot()[0]['uv']==prep['scene']['meshes'][0]['uv']
# Reject a missing external dependency before creating a handoff.
w.load_scene(source)
missing=bpy.data.images.new('MissingExternal',width=2,height=2)
missing.use_fake_user=True
missing.source='FILE'; missing.filepath=str(root/'does-not-exist.png')
bad_source=root/'missing.blend'; bpy.ops.wm.save_as_mainfile(filepath=str(bad_source))
bad_req={'schemaVersion':1,'operation':'prepare','sourcePath':str(bad_source),'sourceSha256':w.sha(bad_source),'outputDir':str(root/'missing-output')}
try: w.run(bad_req)
except ValueError as exc: assert 'Missing external source image' in str(exc)
else: raise AssertionError('missing external image accepted')
assert not (root/'missing-output').exists()
# FBX animation must survive import so the static guard can reject it.
w.load_scene(source)
animated=next(o for o in bpy.context.scene.objects if o.type=='MESH')
animated.keyframe_insert(data_path='location',frame=1)
animated.location.x+=.1; animated.keyframe_insert(data_path='location',frame=5)
animated_path=root/'animated.fbx'
bpy.ops.export_scene.fbx(filepath=str(animated_path),object_types={'MESH'},bake_anim=True,add_leaf_bones=False)
bad_req.update(sourcePath=str(animated_path),sourceSha256=w.sha(animated_path),outputDir=str(root/'animated-output'))
try: w.run(bad_req)
except ValueError as exc: assert 'Animation' in str(exc) or 'Animated' in str(exc)
else: raise AssertionError('animated FBX accepted')
assert not (root/'animated-output').exists()
# Material drivers are also animation, even when no object/action is animated.
w.load_scene(source)
mat=next(o for o in bpy.context.scene.objects if o.type=='MESH').data.materials[0]
mat.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].driver_add('default_value')
try: w.snapshot(static=True)
except ValueError as exc: assert 'Animated datablocks' in str(exc)
else: raise AssertionError('material driver accepted')
print('EXTERNAL_RIG_NATIVE_PASS',root)
