"""Run the user's installed Auto-Rig Pro on an isolated saved model copy.

No operating-system input; addon and AI files remain outside the app package.
"""
import bpy, addon_utils, sys, os, json, hashlib, traceback, time, math
from pathlib import Path
from mathutils import Matrix, Vector
sys.path.insert(0,str(Path(__file__).resolve().parent))
from graphics_auto_rig_parts import policy as part_policy, identities as part_identities, head_binding, snapshot as part_snapshot, verify_export as verify_part_export

if '--probe' in sys.argv:
    try:
        module='bl_ext.user_default.auto_rig_pro'
        addon_utils.enable(module,default_set=True,persistent=True)
        addon=sys.modules[module]
        ai=Path(bpy.context.preferences.addons[module].preferences.ai_presets_path)
        required=['info.dat']+['inference/'+name for name in ['inference_front.exe','inference_side.exe','inference_top.exe','inference_fingers.exe','front_model.pth','side_model.pth','top_model.pth','fingers_model.pth']]
        available=all((ai/name).is_file() for name in required)
        import tomllib
        manifest=Path(addon.__file__).parent/'blender_manifest.toml'
        addon_version=tomllib.loads(manifest.read_text()).get('version','unknown') if manifest.is_file() else '.'.join(map(str,getattr(addon,'bl_info',{}).get('version',[])))
        print('PARTSMITH_PROBE '+json.dumps({'available':available,'blenderVersion':bpy.app.version_string,'addonVersion':addon_version,'aiVersion':(ai/'info.dat').read_text() if (ai/'info.dat').is_file() else '', 'message':'Installed local tools ready' if available else 'ARP AI files missing'}),flush=True)
    except Exception as ex:
        print('PARTSMITH_PROBE '+json.dumps({'available':False,'message':str(ex)}),flush=True)
    sys.exit(0)

ROOT = Path(sys.argv[sys.argv.index('--')+1]).resolve().parent / 'output'
ROOT.mkdir(parents=True, exist_ok=True)
REQUEST = json.loads(Path(sys.argv[sys.argv.index('--')+1]).read_text(encoding='utf-8-sig'))
REPORT = {'schemaVersion':1, 'status':'running','steps':[], 'osInputUsed':False, 'paidSubmissions':0,
          'sourceSha256':REQUEST['sourceSha256'], 'operation':REQUEST['operation'],
          'requestSha256':hashlib.sha256(Path(sys.argv[sys.argv.index('--')+1]).read_bytes()).hexdigest()}

def save_report():
    (ROOT / 'run-report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2), encoding='utf-8')

def step(name, fn):
    REPORT['currentStep'] = name
    save_report()
    print('PARTSMITH STEP', name, flush=True)
    started = time.time()
    result = fn()
    REPORT['steps'].append({'name':name,'seconds':time.time()-started,'result':str(result)})
    save_report()
    return result

def sha(path):
    return hashlib.file_digest(open(path,'rb'),'sha256').hexdigest()

def installed_tools():
    module='bl_ext.user_default.auto_rig_pro'; addon=sys.modules[module]
    ai=Path(bpy.context.preferences.addons[module].preferences.ai_presets_path)
    files=[Path(addon.__file__),Path(addon.__file__).parent/'blender_manifest.toml',ai/'info.dat']+[ai/'inference'/name for name in ['inference_front.exe','inference_side.exe','inference_top.exe','inference_fingers.exe','front_model.pth','side_model.pth','top_model.pth','fingers_model.pth']]
    REPORT['installedTools']=[{'path':str(p),'sha256':sha(p)} for p in files if p.is_file()]
    save_report()

def activate(objects, active=None):
    current=bpy.context.view_layer.objects.active
    if current and current.mode != 'OBJECT': bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.hide_set(False); obj.hide_viewport=False; obj.select_set(True)
    bpy.context.view_layer.objects.active=active or objects[0]

def protected_mesh(obj):
    data=obj.data
    def value(item):
        for field in ['value','vector','color']:
            if hasattr(item,field):
                v=getattr(item,field)
                try: return list(v)
                except TypeError: return v
        raise ValueError('Unsupported protected mesh attribute')
    return {'partIdentity':[obj.get('partsmith_id'),obj.get('partsmith_part_id')],
            'topology':[[int(i) for i in p.vertices] for p in data.polygons],
            'edges':[list(e.vertices) for e in data.edges],
            'uv':{uv.name:[list(v.uv) for v in uv.data] for uv in data.uv_layers},
            'attributes':{a.name:[value(v) for v in a.data] for a in data.attributes if not a.name.startswith('.') and a.name!='position'},
            'materials':[m.name if m else None for m in data.materials],
            'faceMaterials':[p.material_index for p in data.polygons]}

def protected_images(reference=None):
    result={}
    selected=list(bpy.data.images) if reference is None else [bpy.data.images.get(name) for name in reference]
    assert all(image is not None for image in selected), 'Protected source image was removed'
    for image in selected:
        if image.source=='FILE':
            if not image.packed_file:
                file=Path(bpy.path.abspath(image.filepath))
                assert file.is_file(), 'Image missing from isolated input; pack source textures first: '+image.name
                image.pack()
            result[image.name]=hashlib.sha256(bytes(image.packed_file.data)).hexdigest()
    return result

def skin_meshes(rig):
    helpers={bone.custom_shape for bone in rig.pose.bones if bone.custom_shape}
    meshes=[o for o in bpy.context.scene.objects if o.type=='MESH' and o not in helpers]
    assert meshes and all(any(m.type=='ARMATURE' and m.object==rig for m in o.modifiers) for o in meshes), 'Unbound non-controller mesh requires explicit rig preparation'
    return meshes

def set_fk(rig):
    for side in ['l','r']:
        for limb in ['hand','foot']:
            bone=rig.pose.bones.get('c_'+limb+'_ik.'+side)
            assert bone and 'ik_fk_switch' in bone, 'ARP FK switch unavailable'
            bone['ik_fk_switch']=1
    bpy.context.view_layer.update()

def bootstrap():
    source = Path(REQUEST['sourceBlend'])
    assert sha(source)==REQUEST['sourceSha256'], 'Source hash changed'
    # Factory startup retains the user's extension repository definitions, but does
    # not load their other add-ons or startup scene.
    module='bl_ext.user_default.auto_rig_pro'
    # default_set creates this process's preference entry; never save_userpref.
    addon_utils.enable(module, default_set=True, persistent=True)
    assert module in bpy.context.preferences.addons, 'ARP not enabled'
    prefs=bpy.context.preferences.addons[module].preferences
    REPORT['aiPath']=prefs.ai_presets_path
    assert Path(prefs.ai_presets_path,'info.dat').is_file(), 'AI installation missing'
    installed_tools()
    if source.suffix.lower()=='.blend': bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False)
    elif source.suffix.lower()=='.fbx':
        bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete()
        bpy.ops.import_scene.fbx(filepath=str(source),use_anim=False)
    else: raise ValueError('Supported static input formats: BLEND/FBX')

def main():
    source=Path(REQUEST['sourceBlend'])
    meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
    assert meshes and not any(o.type=='ARMATURE' for o in bpy.context.scene.objects)
    assert all(not o.modifiers and not o.data.shape_keys and not o.vertex_groups and not o.animation_data and not o.constraints and (not o.parent or o.parent.type=='EMPTY') for o in meshes), 'Input not a fresh static mesh'
    assert not bpy.data.actions, 'Animated input is unsupported for a new rig'
    frozen_parts=part_policy(REQUEST.get('partPolicy'))
    part_identities(meshes,frozen_parts)  # Must precede the first AI/Smart operation.
    if frozen_parts:REPORT['partPolicy']=frozen_parts
    source_matrix=Matrix(REQUEST['sourceToRigMatrix'])
    protected={o.name:protected_mesh(o) for o in meshes}; images=protected_images()
    expected={o.name:[source_matrix @ o.matrix_world @ v.co for v in o.data.vertices] for o in meshes}
    for obj in meshes: obj.matrix_world=source_matrix @ obj.matrix_world
    bpy.context.view_layer.update()
    REPORT['meshes']=[{'name':o.name,'vertices':len(o.data.vertices),'polygons':len(o.data.polygons),'dimensions':list(o.dimensions)} for o in meshes]
    REPORT['sourceToRigMatrix']=REQUEST['sourceToRigMatrix']
    REPORT['sourceSha256']=sha(source)
    sc=bpy.context.scene
    sc.unit_settings.scale_length=1
    sc.arp_smart_type='BODY'; sc.arp_smart_overwrite=False
    sc.arp_fingers_enable=REQUEST.get('fingers', True); sc.arp_fingers_to_detect=5
    sc.arp_smart_sym=True; sc.arp_smart_depth=True
    sc.arp_smart_AI_body_samples=1
    sc.arp_smart_fingers_engine='AI'
    sc.arp_disable_smart_fx=True
    window=bpy.context.window_manager.windows[0]
    area=next(a for a in window.screen.areas if a.type=='VIEW_3D')
    region=next(r for r in area.regions if r.type=='WINDOW')
    with bpy.context.temp_override(window=window,area=area,region=region,scene=window.scene,view_layer=window.view_layer):
        activate(meshes)
        step('prepare-smart-copy',lambda:bpy.ops.id.get_selected_objects('EXEC_DEFAULT'))
        bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'prepared.blend'))
        step('ai-body-markers',lambda:bpy.ops.arp.guess_markers('EXEC_DEFAULT',symmetry=True))
        names=['neck_loc','chin_loc','shoulder_loc','hand_loc','hand_tip_loc','elbow_loc','root_loc','foot_loc','knee_loc','thigh_loc','head_tip_loc']
        REPORT['markers']={n:list(bpy.data.objects[n].matrix_world.translation) for n in names if n in bpy.data.objects}
        assert all(n in bpy.data.objects for n in names), 'AI body markers incomplete'
        bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'body-markers.blend'))
        if REQUEST.get('fingers', True):
            step('ai-finger-markers',lambda:bpy.ops.arp.guess_fingers('EXEC_DEFAULT'))
            assert 'thumb1_loc' in bpy.data.objects, 'AI finger markers absent'
        bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'finger-markers.blend'))
        step('detect-reference-rig',lambda:bpy.ops.id.go_detect('INVOKE_DEFAULT'))
        rigs=[o for o in sc.objects if o.type=='ARMATURE' and 'rig' in o.name.lower()]
        assert rigs, 'No reference rig produced'
        rig=bpy.context.view_layer.objects.active
        assert rig and rig.type=='ARMATURE', 'Expected active ARP rig'
        step('match-control-rig',lambda:bpy.ops.arp.match_to_rig('EXEC_DEFAULT'))
        bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'matched.blend'))
        activate(meshes+[rig],rig)
        sc.arp_bind_engine='HEAT_MAP'; sc.arp_bind_scale_fix=False
        sc.arp_bind_preserve=False  # Linear skinning agrees with Unity.
        step('bind-weights',lambda:bpy.ops.arp.bind_to_rig('EXEC_DEFAULT'))
        for obj in meshes:
            assert any(m.type=='ARMATURE' and m.object==rig for m in obj.modifiers), 'Mesh not bound to output rig'
            assert len(obj.vertex_groups)>0, 'Mesh has no weights'
            for vertex in obj.data.vertices:
                values=[(g.group,g.weight) for g in vertex.groups]
                total=sum(w for _,w in values)
                assert total>0 and all(math.isfinite(w) and w>=0 for _,w in values), 'Invalid or unweighted vertex'
                for group,w in values: obj.vertex_groups[group].add([vertex.index],w/total,'REPLACE')
        head_binding(meshes,rig,frozen_parts,apply=True)
        REPORT['rig']=rig.name
        REPORT['bones']=[{'name':b.name,'deform':b.use_deform,'parent':b.parent.name if b.parent else None} for b in rig.data.bones]
        set_fk(rig)
        REPORT['neutralControlMode']='FK'
        # Diagnostic checkpoint only; never registered as a review candidate.
        bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'bound-unvalidated.blend'))
        REPORT['restGeometryMetrics']=[]
        for obj in meshes:
            assert protected_mesh(obj)==protected[obj.name], 'Protected topology, UV, attributes or materials changed'
            actual=obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
            try:
                assert len(actual.vertices)==len(expected[obj.name]), 'Rigging changed vertex count'
                deviation=max(((obj.matrix_world@v.co)-wanted).length for v,wanted in zip(actual.vertices,expected[obj.name]))
                REPORT['restGeometryMetrics'].append({'mesh':obj.name,'maximumDisplacement':deviation,'tolerance':1e-5,'units':'source units','controlMode':'FK'})
                save_report()
                assert deviation<1e-5, 'Rig rest geometry changed'
            finally: obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh_clear()
        assert protected_images(images)==images, 'Packed source image bytes changed'
        REPORT['preservationChecks']={'restGeometry':True,'topology':True,'uv':True,'attributes':True,'materials':True,'images':True,'allWeighted':True,'normalized':True}
        bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'rigged.blend'))
        sc.arp_engine_type='UNITY'; sc.arp_export_rig_type='HUMANOID'; sc.arp_bake_anim=False
        activate(meshes+[rig],rig)
        step('export-fbx',lambda:bpy.ops.arp.arp_export_fbx_panel('EXEC_DEFAULT',filepath=str(ROOT/'character.fbx')))
        assert (ROOT/'character.fbx').stat().st_size>1000, 'No FBX result'
    assert sha(source)==REQUEST['sourceSha256'], 'Original changed'
    REPORT['files']=[{'path':str(ROOT/n),'sha256':sha(ROOT/n),'bytes':(ROOT/n).stat().st_size} for n in ['rigged.blend','character.fbx']]
    REPORT['status']='exported-review-pending'
    save_report()


def components(obj):
    links=[set() for _ in obj.data.vertices]
    for edge in obj.data.edges:
        a,b=edge.vertices; links[a].add(b); links[b].add(a)
    unseen=set(range(len(links))); result=[]
    while unseen:
        pending=[min(unseen)]; found=set(pending); unseen.difference_update(found)
        while pending:
            for v in links[pending.pop()]:
                if v in unseen: unseen.remove(v); found.add(v); pending.append(v)
        ids=sorted(found)
        result.append({'id':hashlib.sha256(json.dumps(ids).encode()).hexdigest(), 'vertices':ids})
    return result


def rows(obj):
    return [{obj.vertex_groups[g.group].name:g.weight for g in v.groups} for v in obj.data.vertices]

def inspection(meshes,rig):
    islands=[]
    for obj in meshes:
        weights=rows(obj)
        for component in components(obj):
            ids=component['vertices']; names=sorted({bone for i in ids for bone in weights[i]})
            bones=[{'name':name,'meanWeight':sum(weights[i].get(name,0) for i in ids)/len(ids),'maxWeight':max(weights[i].get(name,0) for i in ids)} for name in names]
            warnings=[]
            if any(abs(sum(weights[i].values())-1)>1e-4 or not weights[i] for i in ids): warnings.append('Invalid or nonnormalized weight rows')
            if len(ids)<len(obj.data.vertices)*0.1 and any('finger' in b['name'] or any(t in b['name'] for t in ['thumb','index','middle','ring','pinky']) for b in bones): warnings.append('Small disconnected island has finger influences; inspect motion before correction')
            islands.append({'mesh':obj.name,'islandId':component['id'],'vertices':len(ids),'vertexIndices':ids,'bones':bones,'warnings':warnings})
    human=[{'humanName':h,'boneName':b} for h,b in [('Hips','root.x'),('Spine','spine_01.x'),('Chest','spine_02.x'),('UpperChest','spine_03.x'),('Neck','neck.x'),('Head','head.x')]]
    for side,prefix in [('l','Left'),('r','Right')]:
        for h,b in [('Shoulder','shoulder'),('UpperArm','arm_stretch'),('LowerArm','forearm_stretch'),('Hand','hand'),('UpperLeg','thigh_stretch'),('LowerLeg','leg_stretch'),('Foot','foot'),('Toes','toes_01')]: human.append({'humanName':prefix+h,'boneName':b+'.'+side})
        for finger,h in [('thumb','Thumb'),('index','Index'),('middle','Middle'),('ring','Ring'),('pinky','Little')]:
            for i,joint in enumerate(['Proximal','Intermediate','Distal'],1):
                name='c_'+finger+str(i)+'.'+side
                if name in rig.data.bones: human.append({'humanName':prefix+h+joint,'boneName':name})
    human=[v for v in human if v['boneName'] in rig.data.bones]
    return {'islands':islands,'boneNames':[b.name for b in rig.data.bones if b.use_deform], 'humanBones':human,'checks':[{'id':'sourceHashBound','passed':True}]+[{'id':key,'passed':bool(passed)} for key,passed in REPORT.get('preservationChecks',{}).items()], 'warnings':['Visual review required; no collision or natural-deformation certification','FBX mapping uses installed ARP Unity exporter conventions; actual Unity validation remains required'], 'poses':[]}

def preview_motion(meshes,rig):
    # Preview-only actions are authored after neutral native/FBX saves.
    # ARP FK switches and local Z axes are named rig controls, never vertex masks.
    definitions=[('검사용_arms','Arms spread',[('c_arm_fk.l',60),('c_arm_fk.r',-60)]),('검사용_elbows','Elbows bend',[('c_forearm_fk.l',-75),('c_forearm_fk.r',75)]),('검사용_left_knee','Left knee bend',[('c_leg_fk.l',90)]),('검사용_right_knee','Right knee bend',[('c_leg_fk.r',-90)])]
    for action in list(bpy.data.actions): bpy.data.actions.remove(action)
    for side in ['l','r']:
        for limb in ['hand','foot']:
            bone=rig.pose.bones.get('c_'+limb+'_ik.'+side)
            if bone and 'ik_fk_switch' in bone: bone['ik_fk_switch']=1
    rig.animation_data_create(); scene=bpy.context.scene; scene.frame_start=1;scene.frame_end=25
    for name,label,rotations in definitions:
        if not all(bone in rig.pose.bones for bone,_ in rotations):
            REPORT['inspection']['warnings'].append('Missing preview controls: '+label);continue
        action=bpy.data.actions.new(name=name); action.use_fake_user=True; rig.animation_data.action=action
        for frame,amount in [(1,0),(13,1),(25,0)]:
            scene.frame_set(frame)
            for bone,angle in rotations:
                pb=rig.pose.bones[bone];pb.rotation_mode='XYZ';pb.rotation_euler=(0,0,math.radians(angle)*amount)
                pb.keyframe_insert(data_path='rotation_euler',frame=frame,group=bone)
        REPORT['inspection']['poses'].append({'name':name,'label':label,'warning':'Diagnostic motion only; not a natural motion quality guarantee'})
        for bone,_ in rotations: rig.pose.bones[bone].rotation_euler=(0,0,0)
    rig.animation_data.action=None;scene.frame_set(1);bpy.context.view_layer.update()

def verify_exported_names():
    original=bpy.context.window.scene
    frozen_parts=part_policy(REQUEST.get('partPolicy'))
    native_rigs=[o for o in original.objects if o.type=='ARMATURE']
    native_meshes=skin_meshes(native_rigs[0]) if frozen_parts else []
    expected_parts=part_snapshot(native_meshes,frozen_parts)
    if frozen_parts:head_binding(native_meshes,native_rigs[0],frozen_parts)
    # Avoid Blender's automatic .001 name suffixes when comparing exact exported
    # material slots. No export or saved native file uses these temporary names.
    renamed=[]
    original_mesh_data={mesh.as_pointer() for mesh in bpy.data.meshes}
    if frozen_parts:
        for index,material in enumerate(list(bpy.data.materials)):
            renamed.append((material,material.name));material.name='__PARTSMITH_NATIVE_MATERIAL_'+str(index)
    scene=bpy.data.scenes.new('PartsmithFBXValidation')
    try:
        bpy.context.window.scene=scene
        bpy.ops.import_scene.fbx(filepath=str(ROOT/'character.fbx'),use_anim=False,use_image_search=False)
        exported=[o for o in scene.objects if o.type=='ARMATURE']
        assert len(exported)==1, 'FBX must contain one export skeleton'
        names={b.name for b in exported[0].data.bones}
        mapping=REPORT['inspection']['humanBones']
        assert all(v['boneName'] in names for v in mapping), 'Humanoid mapping does not match exported FBX names'
        REPORT['inspection']['checks'].append({'id':'exportedBoneNames','passed':True})
        REPORT['exportedBoneNames']=sorted(names)
        REPORT['exportedParts']=[{'name':o.name,'meshName':o.data.name,'partId':str(o.get('partsmith_part_id','')),'sourceId':str(o.get('partsmith_id','')),'vertices':len(o.data.vertices),'polygons':len(o.data.polygons)} for o in scene.objects if o.type=='MESH']
        assert REPORT['exportedParts'], 'Exported FBX contains no meshes'
        if frozen_parts:
            REPORT['partPolicy']=frozen_parts
            REPORT['partChecks']=verify_part_export([o for o in scene.objects if o.type=='MESH'],exported[0],frozen_parts,expected_parts)
            REPORT['inspection']['checks'].extend({'id':name,'passed':True} for name in ['partIdentity','partExport','headBinding'])
    finally:
        for obj in list(scene.objects): bpy.data.objects.remove(obj,do_unlink=True)
        bpy.context.window.scene=original
        bpy.data.scenes.remove(scene)
        # Remove only imported, now-unused validation materials before restoring
        # original exact names; otherwise Blender would rename the originals.
        old={m.as_pointer() for m,_ in renamed}
        if frozen_parts:
            # Removing imported objects does not remove their mesh datablocks.
            # Those orphan meshes keep material users alive and would steal the
            # original names during restoration. Never remove source mesh data.
            for mesh in list(bpy.data.meshes):
                if mesh.as_pointer() not in original_mesh_data and mesh.users==0:bpy.data.meshes.remove(mesh)
            for material in list(bpy.data.materials):
                if material.as_pointer() not in old and material.users==0:bpy.data.materials.remove(material)
            for material,name in renamed:material.name=name
            assert all(material.name==name for material,name in renamed),'Native material names changed during FBX validation cleanup'


def inspect_repair():
    source=Path(REQUEST['sourceBlend']); assert sha(source)==REQUEST['sourceSha256']
    bpy.ops.wm.open_mainfile(filepath=str(source),load_ui=False)
    rigs=[o for o in bpy.context.scene.objects if o.type=='ARMATURE']
    assert len(rigs)==1, 'Exactly one existing rig required'
    meshes=skin_meshes(rigs[0])
    frozen_parts=part_policy(REQUEST.get('partPolicy'))
    part_identities(meshes,frozen_parts)
    if frozen_parts:REPORT['partPolicy']=frozen_parts
    protected={o.name:protected_mesh(o) for o in meshes}; images=protected_images()
    skeleton=[(b.name,b.parent.name if b.parent else None,tuple(b.head_local),tuple(b.tail_local),b.use_deform,tuple(tuple(row) for row in b.matrix_local)) for b in rigs[0].data.bones]
    inventory=[]; selection={}; before={o.name:rows(o) for o in meshes}
    geometry={o.name:hashlib.sha256(repr(([tuple(v.co) for v in o.data.vertices],[tuple(p.vertices) for p in o.data.polygons],[[tuple(v.uv) for v in uv.data] for uv in o.data.uv_layers])).encode()).hexdigest() for o in meshes}
    for obj in meshes:
        for component in components(obj):
            weights={}; invalid=0
            for i in component['vertices']:
                row=before[obj.name][i]
                invalid+=not row or abs(sum(row.values())-1)>1e-4 or any(not math.isfinite(w) or w<0 for w in row.values())
                for bone,w in row.items(): weights[bone]=weights.get(bone,0)+w
            selection[(obj.name,component['id'])]=component['vertices']
            inventory.append({'mesh':obj.name,'islandId':component['id'],'vertexCount':len(component['vertices']),'invalidWeightRows':invalid,'influenceMass':weights,'reviewRequired':True})
    touched={o.name:set() for o in meshes}
    repairs=REQUEST.get('repairs',[])
    assert REQUEST['operation']=='repair' or not repairs
    assert REQUEST['operation']!='repair' or repairs, 'Explicit repairs required'
    for repair in repairs:
        obj=bpy.data.objects[repair['mesh']]; ids=selection[(obj.name,repair['islandId'])]
        assert not touched[obj.name].intersection(ids), 'Overlapping repair selections'
        touched[obj.name].update(ids)
        kind=repair['kind']; assert kind in ['normalize','remove-influence','rigid-bind'], 'Unsupported repair'
        for i in ids:
            row=before[obj.name][i].copy()
            if kind=='remove-influence':
                assert repair.get('bones'), 'Explicit bone removal required'
                for bone in repair['bones']: row.pop(bone,None)
            if kind=='rigid-bind':
                bone=repair['targetBone']; assert bone in rigs[0].data.bones and rigs[0].data.bones[bone].use_deform, 'Target must be deform bone'
                row={bone:1.0}
            total=sum(row.values()); assert total>0 and all(math.isfinite(w) and w>=0 for w in row.values()), 'Repair has no valid remaining mass'
            for group in obj.vertex_groups: group.remove([i])
            for bone,w in row.items():
                group=obj.vertex_groups.get(bone) or obj.vertex_groups.new(name=bone)
                group.add([i],w/total,'REPLACE')
    for obj in meshes:
        after=rows(obj)
        assert all(after[i]==row for i,row in enumerate(before[obj.name]) if i not in touched[obj.name]), 'Outside weights changed'
        actual=hashlib.sha256(repr(([tuple(v.co) for v in obj.data.vertices],[tuple(p.vertices) for p in obj.data.polygons],[[tuple(v.uv) for v in uv.data] for uv in obj.data.uv_layers])).encode()).hexdigest()
        assert actual==geometry[obj.name], 'Geometry or UV changed'
        assert protected_mesh(obj)==protected[obj.name], 'Topology/UV/attributes/materials changed'
    assert protected_images(images)==images, 'Source image bytes changed'
    assert skeleton==[(b.name,b.parent.name if b.parent else None,tuple(b.head_local),tuple(b.tail_local),b.use_deform,tuple(tuple(row) for row in b.matrix_local)) for b in rigs[0].data.bones], 'Skeleton changed'
    head_binding(meshes,rigs[0],frozen_parts)  # Verify only; explicit repair selections are the sole edits.
    REPORT.update({'inventory':inventory,'changedVertices':sum(len(v) for v in touched.values()),'preservationChecks':{'geometryAndUV':True,'outsideWeights':True,'attributes':True,'materials':True,'images':True,'skeleton':True},'qualityReview':'pending','fullPosedExportEquivalence':'unverified'})
    bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'rigged.blend'))
    # ARP export uses installed licensed addon; never bundle it.
    addon_utils.enable('bl_ext.user_default.auto_rig_pro',default_set=True,persistent=True)
    installed_tools()
    activate(meshes+rigs,rigs[0])
    sc=bpy.context.scene; sc.arp_engine_type='UNITY'; sc.arp_export_rig_type='HUMANOID'; sc.arp_bake_anim=False
    step('export-fbx',lambda:bpy.ops.arp.arp_export_fbx_panel('EXEC_DEFAULT',filepath=str(ROOT/'character.fbx')))


def run_main():
    try:
        if REQUEST['operation']=='rig': main()
        else: step('inspect-repair',inspect_repair)
        rigs=[o for o in bpy.context.scene.objects if o.type=='ARMATURE']
        meshes=skin_meshes(rigs[0])
        REPORT['inspection']=inspection(meshes,rigs[0])
        step('verify-exported-skeleton',verify_exported_names)
        preview_motion(meshes,rigs[0])
        for obj in meshes:
            assert '_PARTSMITH_VERTEX' not in obj.data.attributes, 'Reserved preview vertex attribute already exists'
            attr=obj.data.attributes.new(name='_PARTSMITH_VERTEX',type='INT',domain='POINT')
            for vertex in obj.data.vertices: attr.data[vertex.index].value=vertex.index
            obj['partsmith_source_mesh']=obj.name
        activate(meshes+rigs,rigs[0])
        step('export-preview',lambda:bpy.ops.export_scene.gltf(filepath=str(ROOT/'character.glb'),export_format='GLB',use_selection=True,export_animations=True,export_animation_mode='ACTIONS',export_bake_animation=True,export_force_sampling=True,export_all_influences=True,export_attributes=True,export_extras=True))
        assert sha(REQUEST['sourceBlend'])==REQUEST['sourceSha256'], 'Source changed'
        assert all(sha(v['path'])==v['sha256'] for v in REPORT['installedTools']), 'Installed tools changed during execution'
        REPORT['files']=[{'path':str(ROOT/n),'sha256':sha(ROOT/n),'bytes':(ROOT/n).stat().st_size} for n in ['rigged.blend','character.fbx','character.glb']]
        REPORT['status']='exported-review-pending'; REPORT['qualityReview']='pending'; save_report()
    except Exception as ex:
        REPORT['status']='failed'; REPORT['error']=str(ex); REPORT['traceback']=traceback.format_exc(); save_report(); traceback.print_exc()
    finally:
        if not bpy.app.background: bpy.app.timers.register(lambda:bpy.ops.wm.quit_blender() and None,first_interval=0.1)
    return None

if REQUEST['operation']=='rig': bootstrap()
if bpy.app.background: run_main()
else: bpy.app.timers.register(run_main,first_interval=1.0)
