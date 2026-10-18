"""Synthetic three-part proof using an existing rig; no AI or new binding."""
import bpy,addon_utils,sys,pathlib,json,hashlib,ast,shutil
root=pathlib.Path(sys.argv[sys.argv.index('--')+1]);source=pathlib.Path(sys.argv[sys.argv.index('--')+2]);resources=pathlib.Path(sys.argv[sys.argv.index('--')+3]);sys.path.insert(0,str(resources))
from graphics_auto_rig_parts import identities,head_binding,snapshot,verify_export
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
original=sha(source);root.mkdir(parents=True,exist_ok=True);checks=[]
bpy.ops.wm.open_mainfile(filepath=str(source),load_ui=False,use_scripts=False)
rigs=[o for o in bpy.context.scene.objects if o.type=='ARMATURE'];assert len(rigs)==1;rig=rigs[0]
for obj in list(bpy.context.scene.objects):
    if obj.type=='MESH' and any(m.type=='ARMATURE' and m.object==rig for m in obj.modifiers):bpy.data.objects.remove(obj,do_unlink=True)
meshes=[]
for index,part in enumerate(['body','hair','head']):
    bpy.ops.mesh.primitive_cube_add(size=.08,location=(index*.15,0,.5))
    obj=bpy.context.object;obj.name='Synthetic '+part;obj['partsmith_id']='synthetic-id-'+part;obj['partsmith_part_id']=part
    mat=bpy.data.materials.new('SyntheticMaterial_'+part);mat.use_nodes=True;mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(.1+index*.2,.3,.4,1);obj.data.materials.append(mat)
    mod=obj.modifiers.new('Synthetic existing skeleton','ARMATURE');mod.object=rig
    obj.vertex_groups.new(name='head.x').add(list(range(8)),.4 if part=='hair' else 1,'REPLACE')
    if part=='hair':obj.vertex_groups.new(name='spine_03.x').add(list(range(8)),.6,'REPLACE')
    meshes.append(obj)
policy={'schemaVersion':1,'requiredParts':['body','hair','head'],'headBoundParts':['hair']}
before=snapshot(meshes,policy);other=[[(g.group,g.weight) for v in o.data.vertices for g in v.groups] for o in meshes if o['partsmith_part_id']!='hair']
try:head_binding(meshes,rig,policy)
except AssertionError:checks.append('mixed legacy hair weights rejected without automatic correction')
else:raise AssertionError('bad hair weights accepted')
head_binding(meshes,rig,policy,apply=True);assert snapshot(meshes,policy)==before
assert other==[[(g.group,g.weight) for v in o.data.vertices for g in v.groups] for o in meshes if o['partsmith_part_id']!='hair'];checks.append('fresh head binding changes only hair weights; IDs geometry UV slots and body/head weights exact')
for kind in ['missing','duplicate','unknown']:
    hair=meshes[1];key='partsmith_id' if kind=='duplicate' else 'partsmith_part_id';old=hair[key]
    if kind=='missing':del hair[key]
    else:hair[key]=meshes[0]['partsmith_id'] if kind=='duplicate' else 'other'
    try:identities(meshes,policy)
    except AssertionError:checks.append(kind+' identity rejected before AI')
    else:raise AssertionError('invalid identity accepted')
    hair[key]=old
# Use the installed licensed exporter only once. No AI/Smart/bind operators run.
addon_utils.enable('bl_ext.user_default.auto_rig_pro',default_set=True,persistent=True)
bpy.ops.object.select_all(action='DESELECT')
for o in meshes+[rig]:o.hide_set(False);o.select_set(True)
bpy.context.view_layer.objects.active=rig
sc=bpy.context.scene;sc.arp_engine_type='UNITY';sc.arp_export_rig_type='HUMANOID';sc.arp_bake_anim=False
bpy.ops.wm.save_as_mainfile(filepath=str(root/'synthetic-source.blend'),compress=False)
synthetic_sha=sha(root/'synthetic-source.blend')
existing_export=sys.argv[sys.argv.index('--')+4] if len(sys.argv)>sys.argv.index('--')+4 else None
if existing_export:
    shutil.copyfile(existing_export,root/'character.fbx');checks.append('reused previous exact synthetic licensed FBX; no new export or AI')
else:
    bpy.ops.arp.arp_export_fbx_panel('EXEC_DEFAULT',filepath=str(root/'character.fbx'))
    checks.append('one installed licensed ARP export, no AI or rebinding')
tree=ast.parse((resources/'graphics_auto_rig.py').read_text(encoding='utf8'))
definitions=ast.Module(body=[n for n in tree.body if isinstance(n,(ast.FunctionDef,))],type_ignores=[])
from graphics_auto_rig_parts import policy as part_policy,identities as part_identities,snapshot as part_snapshot,verify_export as verify_part_export
namespace=dict(globals());namespace.update({'ROOT':root,'REQUEST':{'partPolicy':policy},'REPORT':{'inspection':{'humanBones':[{'humanName':'Head','boneName':'head.x'}],'checks':[]}},'part_policy':part_policy,'part_identities':part_identities,'part_snapshot':part_snapshot,'verify_part_export':verify_part_export})
exec(compile(definitions,'graphics_auto_rig.py','exec'),namespace)
error=None
try:namespace['verify_exported_names']();checks.append('real FBX exact three part IDs topology UV/material slots world geometry and hair Head1 passed')
except Exception as e:error=repr(e)
if error is None:
    expected=snapshot(meshes,policy)
    mutations=[('UV',lambda: setattr(meshes[0].data.uv_layers[0].data[0],'uv',(.123,.456)),lambda: setattr(meshes[0].data.uv_layers[0].data[0],'uv',expected['synthetic-id-body']['uv'][meshes[0].data.uv_layers[0].name][0])),
      ('geometry',lambda:setattr(meshes[0].data.vertices[0].co,'x',meshes[0].data.vertices[0].co.x+.01),lambda:setattr(meshes[0].data.vertices[0].co,'x',meshes[0].data.vertices[0].co.x-.01)),
      ('part-ID',lambda:meshes[0].__setitem__('partsmith_part_id','head'),lambda:meshes[0].__setitem__('partsmith_part_id','body')),
      ('mesh-ID',lambda:meshes[0].__setitem__('partsmith_id','changed'),lambda:meshes[0].__setitem__('partsmith_id','synthetic-id-body')),
      ('material',lambda:setattr(meshes[0].data.materials[0],'name','ChangedMaterial'),lambda:setattr(meshes[0].data.materials[0],'name','SyntheticMaterial_body'))]
    for name,change,restore in mutations:
        change()
        try:verify_export(meshes,rig,policy,expected)
        except AssertionError:checks.append('export '+name+' mutation rejected')
        else:raise AssertionError('export mutation accepted '+name)
        finally:restore()
    hair=meshes[1];hair.vertex_groups['head.x'].add([0],.4,'REPLACE');hair.vertex_groups.new(name='spine_03.x').add([0],.6,'REPLACE')
    try:verify_export(meshes,rig,policy,expected)
    except AssertionError:checks.append('export mixed hair weights rejected without repair')
    else:raise AssertionError('export mixed hair accepted')
    head_binding(meshes,rig,policy,apply=True)
assert sha(source)==original and sha(root/'synthetic-source.blend')==synthetic_sha
result={'status':'PASS' if error is None else 'FAIL','error':error,'checks':checks,'report':namespace['REPORT'],'source':str(source),'sourceSha256':original,'sourcePreserved':True,'syntheticFixture':True,'aiExecutions':0,'paid':0,'licensedExports':0 if existing_export else 1}
(root/'result.json').write_text(json.dumps(result,indent=2));print('PART_RESULT '+json.dumps(result))
assert error is None,error
