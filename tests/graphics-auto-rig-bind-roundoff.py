import bpy,sys,pathlib
from mathutils import Matrix
sys.path.insert(0,str(pathlib.Path('integrations/blender').resolve()))
from graphics_humanoid import imported_bind_roundoff
bpy.ops.wm.read_factory_settings(use_empty=True)
data=bpy.data.armatures.new('Bones');rig=bpy.data.objects.new('Rig',data);bpy.context.collection.objects.link(rig);bpy.context.view_layer.objects.active=rig;rig.select_set(True)
bpy.ops.object.mode_set(mode='EDIT');bone=data.edit_bones.new('Bone');bone.head=(0,0,0);bone.tail=(0,0,1);bpy.ops.object.mode_set(mode='OBJECT')
mesh=bpy.data.meshes.new('Mesh');mesh.from_pydata([(0,0,0),(1,0,0),(0,1,0)],[],[(0,1,2)]);obj=bpy.data.objects.new('Mesh',mesh);bpy.context.collection.objects.link(obj)
group=obj.vertex_groups.new(name='Bone');group.add([0,1,2],1,'REPLACE');mod=obj.modifiers.new('Skin','ARMATURE');mod.object=rig
pose=rig.pose.bones['Bone'];pose.location=(0,0,0.000001);bpy.context.view_layer.update();before=pose.matrix_basis.copy();result=imported_bind_roundoff(rig,[obj]);assert result['maximumWorldVertexDelta']<1e-5;assert pose.matrix_basis==before and rig.data.pose_position=='POSE'
for delta,scale in [(0.001,1),(0.0001,100)]:
 pose.location=(delta,0,0);obj.scale=(scale,scale,scale);rig.scale=(scale,scale,scale);bpy.context.view_layer.update()
 try: imported_bind_roundoff(rig,[obj]);raise AssertionError('Unbounded pose accepted')
 except RuntimeError: pass
 assert rig.data.pose_position=='POSE'
print('AUTO_RIG_BIND_ROUNDOFF_PASS')
