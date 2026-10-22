"""Export the accepted rig and exact accepted Actions, without authoring motion."""
import bpy, json, sys, pathlib, math

spec_path = pathlib.Path(sys.argv[sys.argv.index('--') + 1])
q = json.loads(spec_path.read_text(encoding='utf8'))
out = spec_path.parent / 'export'
out.mkdir()
bpy.ops.wm.open_mainfile(filepath=q['rig'], load_ui=False, use_scripts=False)
rigs = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
if len(rigs) != 1:
    raise RuntimeError('Expected exactly one accepted armature')
rig = rigs[0]
if not any(o.type == 'MESH' for o in bpy.context.scene.objects):
    raise RuntimeError('Accepted rig has no meshes')
def signature(armature):
    return {b.name: (b.parent.name if b.parent else None, tuple(round(v, 5) for row in b.matrix_local for v in row)) for b in armature.bones}
expected = signature(rig.data)
for o in bpy.context.scene.objects:
    if o.animation_data:
        o.animation_data_clear()
for a in list(bpy.data.actions):
    bpy.data.actions.remove(a)
names = []
rotation_modes = None
for clip in q['clips']:
    with bpy.data.libraries.load(clip['path'], link=False) as (src, dst):
        if clip['name'] not in src.actions:
            raise RuntimeError('Accepted action missing: ' + clip['name'])
        dst.objects = src.objects
        dst.actions = [clip['name']]
    loaded_rigs = [o for o in dst.objects if o and o.type == 'ARMATURE']
    if len(loaded_rigs) != 1 or signature(loaded_rigs[0].data) != expected:
        raise RuntimeError('Accepted clip skeleton differs: ' + clip['name'])
    source_rig = loaded_rigs[0]
    modes = {b.name: b.rotation_mode for b in source_rig.pose.bones}
    modes['__armature_object__'] = source_rig.rotation_mode
    if rotation_modes is not None and modes != rotation_modes:
        raise RuntimeError('Accepted clips use incompatible bone rotation modes; author review required')
    rotation_modes = modes
    rig.rotation_mode = source_rig.rotation_mode
    for bone in rig.pose.bones:
        bone.rotation_mode = modes[bone.name]
    action = dst.actions[0]
    if action.name != clip['name'] or not action.frame_range[1] > action.frame_range[0]:
        raise RuntimeError('Conflicting or empty action: ' + clip['name'])
    action.use_fake_user = True
    names.append(action.name)
    for obj in dst.objects:
        if obj:
            bpy.data.objects.remove(obj, do_unlink=True)
rig.animation_data_create()
rig.animation_data.action = bpy.data.actions[names[0]]
if hasattr(rig.animation_data.action, 'slots'):
    slots = rig.animation_data.action.slots
    if len(slots) != 1:
        raise RuntimeError('Multiple action slots need explicit author review')
    rig.animation_data.action_slot = slots[0]
bpy.context.scene.render.fps = q['fps']
bpy.context.scene.render.fps_base = 1
textures = out / 'textures'
textures.mkdir()
for i, image in enumerate(bpy.data.images):
    if image.source != 'FILE':
        continue
    # The rig handed off by the app must be self-contained; no external file search.
    if not image.packed_file:
        raise RuntimeError('Accepted rig must contain packed textures: ' + image.name)
    raw = bytes(image.packed_file.data)
    suffix = '.png' if raw.startswith(b'\x89PNG') else '.jpg' if raw.startswith(b'\xff\xd8\xff') else None
    if not suffix or min(image.size) < 1:
        raise RuntimeError('Unsupported or undecodable packed image')
    image_path = textures / (str(i) + suffix)
    image_path.write_bytes(raw)
    image.filepath = str(image_path)
bpy.ops.wm.save_as_mainfile(filepath=str(out / 'character.blend'), compress=False)
bpy.ops.export_scene.fbx(filepath=str(out / 'character.fbx'), use_selection=False,
    object_types={'ARMATURE', 'MESH'}, add_leaf_bones=False, bake_anim=True,
    bake_anim_use_all_actions=True, bake_anim_use_nla_strips=False,
    bake_anim_simplify_factor=0.0, path_mode='COPY', embed_textures=True)
(out / 'export.json').write_text(json.dumps({'clips': names, 'bones': len(expected),
    'fps': q['fps'], 'animationAuthored': False, 'sourceGeometryEdited': False}), encoding='utf8')
