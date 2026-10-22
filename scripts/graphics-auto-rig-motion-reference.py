import bpy, json, sys, math
from pathlib import Path
source=Path(sys.argv[sys.argv.index('--')+1]);dest=Path(sys.argv[sys.argv.index('--')+2])
bpy.ops.wm.open_mainfile(filepath=str(source),load_ui=False)
rig=next(o for o in bpy.context.scene.objects if o.type=='ARMATURE');meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
for side in ['l','r']:
 for limb in ['hand','foot']:rig.pose.bones['c_'+limb+'_ik.'+side]['ik_fk_switch']=1
baseline={b.name:b.matrix_basis.copy() for b in rig.pose.bones}
def sample():
 bpy.context.view_layer.update();result={}
 for obj in meshes:
  evaluated=obj.evaluated_get(bpy.context.evaluated_depsgraph_get());mesh=evaluated.to_mesh()
  result[obj.name]=[[p.x,p.z,-p.y] for v in mesh.vertices for p in [evaluated.matrix_world@v.co]]
  evaluated.to_mesh_clear()
 return result
result={'source':str(source),'coordinateSystem':'GLB [Blender.x,Blender.z,-Blender.y]','fps':24,'sampleFrame':13,'sampleSeconds':13/24,'rest':sample(),'poses':{}}
for name,rotations in [('검사용_arms',[('c_arm_fk.l',60),('c_arm_fk.r',-60)]),('검사용_elbows',[('c_forearm_fk.l',-75),('c_forearm_fk.r',75)]),('검사용_left_knee',[('c_leg_fk.l',90)]),('검사용_right_knee',[('c_leg_fk.r',-90)])]:
 for b in rig.pose.bones:b.matrix_basis=baseline[b.name]
 for bone,angle in rotations:
  pb=rig.pose.bones[bone];pb.rotation_mode='XYZ';pb.rotation_euler=(0,0,math.radians(angle))
 result['poses'][name]=sample()
dest.write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8')
print('REFERENCE_SAVED',str(dest))
