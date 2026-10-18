"""Partsmith v1. Object assembly preserves surfaces; it does not weld or retopologize.
Run: blender --background --factory-startup --python pipeline.py -- input.json
"""
import bpy, sys, json, os, math, traceback, hashlib
from mathutils import Matrix, Vector, Euler

def material(name, color):
    m = bpy.data.materials.new(name); m.diffuse_color = (*color, 1); m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF'); bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value = .48
    return m

def demo_character():
    suit = material('Demo_Sage', (.24,.58,.46)); dark = material('Demo_Graphite', (.06,.085,.08)); skin = material('Demo_Sand', (.7,.55,.38))
    # Unity HumanBodyBones names, Blender coordinates X right, Y backward, Z up.
    defs = [('Hips',(0,0,.88),(0,0,1.0),None),('Spine',(0,0,1.0),(0,0,1.18),'Hips'),('Chest',(0,0,1.18),(0,0,1.4),'Spine'),('Neck',(0,0,1.4),(0,0,1.49),'Chest'),('Head',(0,0,1.49),(0,0,1.7),'Neck')]
    for side, s in [('Left',1),('Right',-1)]:
        defs += [(side+'Shoulder',(0,0,1.38),(s*.2,0,1.38),'Chest'),(side+'UpperArm',(s*.2,0,1.38),(s*.47,0,1.38),side+'Shoulder'),(side+'LowerArm',(s*.47,0,1.38),(s*.71,0,1.38),side+'UpperArm'),(side+'Hand',(s*.71,0,1.38),(s*.82,0,1.38),side+'LowerArm'),(side+'UpperLeg',(s*.13,0,.9),(s*.13,0,.49),'Hips'),(side+'LowerLeg',(s*.13,0,.49),(s*.13,0,.09),side+'UpperLeg'),(side+'Foot',(s*.13,0,.09),(s*.13,-.14,.04),side+'LowerLeg'),(side+'Toes',(s*.13,-.14,.04),(s*.13,-.23,.04),side+'Foot')]
    arm = bpy.data.armatures.new('PartsmithHumanoid'); rig=bpy.data.objects.new('CharacterRig',arm); bpy.context.collection.objects.link(rig); bpy.context.view_layer.objects.active=rig;rig.select_set(True);bpy.ops.object.mode_set(mode='EDIT')
    for name,head,tail,parent in defs:
        b=arm.edit_bones.new(name);b.head=head;b.tail=tail
        if parent:b.parent=arm.edit_bones[parent]
    bpy.ops.object.mode_set(mode='OBJECT');rig.select_set(False)
    def ellipsoid(name, center, scale, mat, bone):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=16,ring_count=10,location=center)
        obj=bpy.context.object;obj.name='Mesh_'+name;obj.scale=scale;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);obj.data.materials.append(mat)
        vg=obj.vertex_groups.new(name=bone);vg.add(list(range(len(obj.data.vertices))),1,'REPLACE');mod=obj.modifiers.new('Demo armature','ARMATURE');mod.object=rig;obj.parent=rig;obj.select_set(False)
        for p in obj.data.polygons:p.use_smooth=True
        return obj
    ellipsoid('Body',(0,0,1.18),(.22,.12,.27),suit,'Chest')
    ellipsoid('Pelvis',(0,0,.89),(.21,.13,.13),dark,'Hips')
    ellipsoid('Head',(0,-.015,1.57),(.135,.12,.16),skin,'Head')
    ellipsoid('Hair',(0,.02,1.66),(.14,.13,.08),dark,'Head')
    for side,s in [('Left',1),('Right',-1)]:
        for suffix,x,sx,sz,mat in [('UpperArm',.34,.15,.075,suit),('LowerArm',.59,.13,.062,suit),('Hand',.765,.07,.055,skin)]:
            ellipsoid(side+suffix,(s*x,0,1.38),(sx,.065,sz),mat,side+suffix)
        ellipsoid(side+'Thigh',(s*.13,0,.69),(.10,.10,.23),suit,side+'UpperLeg')
        ellipsoid(side+'Shin',(s*.13,0,.29),(.073,.075,.22),suit,side+'LowerLeg')
        ellipsoid(side+'Shoe',(s*.13,-.075,.065),(.09,.16,.065),dark,side+'Foot')
    bpy.context.scene.render.fps=30
    rig.animation_data_create()
    for name in ['Idle','Walk']:
        rig.animation_data.action=None
        for frame in range(1,62,5):
            phase=(frame-1)/60*math.tau
            for b in rig.pose.bones:
                b.rotation_mode='XYZ';b.rotation_euler=(0,0,0);b.location=(0,0,0)
            rig.pose.bones['Chest'].rotation_euler.x=.025*math.sin(phase)
            if name=='Walk':
                for side,s in [('Left',1),('Right',-1)]:
                    rig.pose.bones[side+'UpperLeg'].rotation_euler.x=.48*math.sin(phase)*s
                    rig.pose.bones[side+'LowerLeg'].rotation_euler.x=max(0,-math.sin(phase)*s)*.6
                    rig.pose.bones[side+'UpperArm'].rotation_euler.y=-s*1.2
                    rig.pose.bones[side+'UpperArm'].rotation_euler.z=.3*math.sin(phase)*s
            for b in rig.pose.bones:b.keyframe_insert(data_path='rotation_euler',frame=frame,group=b.name)
        action=rig.animation_data.action;action.name=name
        track=rig.animation_data.nla_tracks.new();track.name=name
        strip=track.strips.new(name,1,action)
        if hasattr(strip,'action_slot') and action.slots: strip.action_slot=action.slots[0]
        rig.animation_data.action=None
    for b in rig.pose.bones:b.rotation_euler=(0,0,0)
    bpy.context.scene.frame_set(1)
    return rig

def import_model(file):
    before=set(bpy.data.objects)
    # Viewport-only bone shape helpers must not become exported character meshes.
    extension=os.path.splitext(file)[1].lower()
    if extension=='.blend':
        bpy.ops.wm.open_mainfile(filepath=file,load_ui=False,use_scripts=False)
        return list(bpy.context.scene.objects)
    if extension=='.obj':
        bpy.ops.wm.obj_import(filepath=file)
    elif extension=='.stl':
        bpy.ops.wm.stl_import(filepath=file)
    elif extension=='.fbx':
        bpy.ops.import_scene.fbx(filepath=file,use_image_search=False)
    elif extension in ('.glb','.gltf'):
        bpy.ops.import_scene.gltf(filepath=file,disable_bone_shape=True)
    else:
        raise ValueError('Supported import formats are BLEND, OBJ, STL, GLB, glTF and FBX')
    objects=[o for o in bpy.data.objects if o not in before]
    # glTF import stashes non-active clips in muted NLA tracks. FBX's NLA
    # exporter omits those tracks unless enabled, silently dropping animations.
    for obj in objects:
        if obj.animation_data:
            for track in obj.animation_data.nla_tracks:
                track.mute=False
                for strip in track.strips:strip.mute=False
    return objects

def main(config):
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
    bpy.context.scene.unit_settings.system='METRIC';bpy.context.scene.unit_settings.scale_length=1
    warnings=[]; mode=config['mode']
    if mode=='demo-rig':
        rig=demo_character();rig.scale=(config['height']/1.7,)*3
        warnings.append('DEMO: procedural mannequin, rigid segment weights. Not an AI-generated or production-quality character.')
    elif mode=='convert':
        import_model(config['source'])
    else:
        # glTF Y-up -> Blender Z-up basis. Preserve each imported object's original transform.
        C=Matrix.Rotation(math.pi/2,4,'X')
        for part in config['parts']:
            objects=import_model(part['file']);roots=[o for o in objects if o.parent not in objects]
            group=bpy.data.objects.new('Part_'+part['name'],None);bpy.context.collection.objects.link(group)
            t=part['transform'];rot=Euler([math.radians(v) for v in t['rotation']],'XYZ').to_matrix().to_4x4()
            mat=Matrix.Translation(Vector(t['position'])) @ rot @ Matrix.Diagonal((*t['scale'],1))
            group.matrix_world=C @ mat @ C.inverted()
            for o in roots:o.parent=group
        warnings.append('Object assembly only. Surfaces are not welded; inspect seams, intersection, UVs and articulation before rigging.')
    bpy.context.view_layer.update()
    meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
    if not meshes:raise ValueError('No mesh to export')
    # Tessellation fills a read-only cache; it does not triangulate source polygons.
    for obj in meshes:obj.data.calc_loop_triangles()
    faces=sum(len(o.data.polygons) for o in meshes)
    triangles=sum(len(o.data.loop_triangles) for o in meshes)
    points=[o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    min_z=min(p.z for p in points); max_z=max(p.z for p in points)
    original_height=max_z-min_z
    normalization_scale=1.0
    if mode=='assemble' and original_height>0.0001:
        normalization_scale=config['height']/original_height
        root=bpy.data.objects.new('TargetHeightNormalization',None);bpy.context.collection.objects.link(root)
        roots=[o for o in bpy.context.scene.objects if o!=root and o.parent is None]
        for obj in roots:obj.parent=root
        root.scale=(normalization_scale,)*3;root.location.z=-min_z*normalization_scale
        warnings.append('Assembly uniformly normalized to requested height; relative part placement is preserved.')
        bpy.context.view_layer.update()
    if any(not o.data.uv_layers for o in meshes):warnings.append('Some meshes have no UV map. Reunwrap and retexture if required.')
    has_rig=any(o.type=='ARMATURE' for o in bpy.context.scene.objects)
    clips=[a.name for a in bpy.data.actions]
    if not has_rig:warnings.append('No armature: Unity Humanoid Avatar validation will require rigging.')
    if has_rig:
        detached=[o.name for o in meshes if not any(m.type=='ARMATURE' for m in o.modifiers) and not (o.parent and o.parent.type=='ARMATURE')]
        if detached:warnings.append('Check detached meshes: '+', '.join(detached))
    out=config['output'];os.makedirs(os.path.dirname(out),exist_ok=True)
    preview_only=config.get('previewOnly',False)
    if not preview_only:
        # Export material textures to a sibling directory for Unity's persistent material remap.
        texture_dir=os.path.join(os.path.dirname(out),'textures');os.makedirs(texture_dir,exist_ok=True)
        for image in bpy.data.images:
            if image.type=='IMAGE' and image.size[0]>0:
                safe=''.join(c if c.isalnum() or c in '-_' else '_' for c in image.name)
                image.filepath_raw=os.path.join(texture_dir,safe+'.png');image.file_format='PNG';image.save()
        bpy.ops.wm.save_as_mainfile(filepath=out+'.blend')
    # FBX import stores clips as actions, whereas glTF import uses NLA tracks.
    animation_mode='ACTIONS' if mode=='convert' and os.path.splitext(config['source'])[1].lower()=='.fbx' else 'NLA_TRACKS'
    bpy.ops.export_scene.gltf(filepath=out+'.glb',export_format='GLB',export_animations=True,export_animation_mode=animation_mode)
    if not preview_only:
        bpy.ops.export_scene.fbx(filepath=out+'.fbx',use_selection=False,object_types={'MESH','ARMATURE','EMPTY'},axis_forward='-Z',axis_up='Y',add_leaf_bones=False,bake_anim=True,bake_anim_use_all_actions=animation_mode=='ACTIONS',bake_anim_use_nla_strips=True,path_mode='COPY',embed_textures=True)
    report={'schemaVersion':1,'mode':mode,'previewOnly':preview_only,'meshes':len(meshes),'vertices':sum(len(o.data.vertices) for o in meshes),'faces':faces,'triangles':triangles,'hasRig':has_rig,'clips':clips,'warnings':warnings,'surfaceWelded':False,'textureRebuildRequired':False,'sourceHeight':original_height,'normalizationScale':normalization_scale}
    if mode=='convert':
        with open(config['source'],'rb') as source:report['nativeSourceSha256']=hashlib.file_digest(source,'sha256').hexdigest()
    with open(out+'.report.json','w',encoding='utf8') as f:json.dump(report,f,ensure_ascii=False,indent=2)
    print('PARTSMITH_OK '+json.dumps(report))

if __name__=='__main__':
    try:
        with open(sys.argv[sys.argv.index('--')+1],encoding='utf-8-sig') as f:config=json.load(f)
        main(config)
    except Exception:
        traceback.print_exc();sys.exit(1)
