"""Synthetic fixture for native I/O tests; never a production character."""
import bpy, sys, pathlib, math, zipfile
out = pathlib.Path(sys.argv[sys.argv.index('--')+1]); out.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8)
mesh = bpy.context.object; mesh.name = 'FixtureMesh'
bpy.ops.export_scene.fbx(filepath=str(out/'uv.fbx'), object_types={'MESH'}, bake_anim=False)
image = bpy.data.images.new('FixtureTexture', width=4096, height=4096)
image.generated_color = (0.8, 0.2, 0.1, 1)
image.filepath_raw = str(out/'color.png'); image.file_format='PNG'; image.save()
image = bpy.data.images.load(str(out/'color.png')); image.pack()
mat=bpy.data.materials.new('FixtureMaterial'); mat.use_nodes=True
node=mat.node_tree.nodes.new('ShaderNodeTexImage'); node.image=image
mat.node_tree.links.new(node.outputs['Color'],mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
mesh.data.materials.append(mat)
bpy.ops.export_scene.fbx(filepath=str(out/'textured.fbx'),object_types={'MESH'},bake_anim=False,path_mode='COPY',embed_textures=True)
with zipfile.ZipFile(out/'textured.zip','w') as z:
    z.write(out/'textured.fbx','textured.fbx');z.write(out/'color.png','color.png')
bpy.ops.object.armature_add();rig=bpy.context.object;rig.name='FixtureRig';rig['partsmith_rig_type']='generic'
bpy.ops.object.mode_set(mode='EDIT');root=rig.data.edit_bones[0];root.name='Root';root.head=(0,0,-1);root.tail=(0,0,1)
joint=rig.data.edit_bones.new('Body');joint.head=(0,0,0);joint.tail=(0,0,1);joint.parent=root
bpy.ops.object.mode_set(mode='OBJECT')
mesh.parent=rig;mod=mesh.modifiers.new('Skin','ARMATURE');mod.object=rig
group=mesh.vertex_groups.new(name='Body');group.add(list(range(len(mesh.data.vertices))),1,'REPLACE')
bpy.context.scene.render.fps=30
bpy.ops.wm.save_as_mainfile(filepath=str(out/'rig.blend'))
for name,amount in [('Idle',0.1),('Jump',0.5)]:
    rig.animation_data_clear()
    for action in list(bpy.data.actions):bpy.data.actions.remove(action)
    bone=rig.pose.bones['Body'];bone.rotation_mode='XYZ'
    for frame,angle in [(0,0),(30,amount),(60,0)]:
        bone.rotation_euler[1]=angle;bone.keyframe_insert('rotation_euler',frame=frame)
    rig.animation_data.action.name=name
    bpy.context.scene.frame_start=0;bpy.context.scene.frame_end=60;bpy.context.scene.frame_set(0)
    bpy.ops.wm.save_as_mainfile(filepath=str(out/(name+'.blend')))
