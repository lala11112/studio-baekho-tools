"""Combine exact accepted Actions with their compatible native rig; no authoring.

Only private copies are opened. Original rig geometry, material data, rest pose,
rotation modes and every Action not explicitly replaced remain unchanged.
"""
import bpy
import hashlib
import json
import math
import pathlib
import re
import sys


def file_hash(file):
    return hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def numbers(values):
    result = [float(value) for value in values]
    if not all(math.isfinite(value) for value in result):
        raise RuntimeError('Non-finite rig, mesh or animation value')
    return result


def matrix(value):
    return [numbers(row) for row in value]


def curves(action):
    result = list(getattr(action, 'fcurves', []))
    for layer in getattr(action, 'layers', []):
        for strip in layer.strips:
            for bag in getattr(strip, 'channelbags', []):
                result.extend(bag.fcurves)
    return list({curve.as_pointer(): curve for curve in result}.values())


def action_evidence(action, rig):
    slots = list(getattr(action, 'slots', []))
    if len(slots) > 1 or slots and slots[0].target_id_type != 'OBJECT':
        raise RuntimeError('Exact rig Action must use one object slot: ' + action.name)
    values = []
    for curve in curves(action):
        if curve.modifiers or curve.sampled_points:
            raise RuntimeError('Action modifiers or sampled curves require explicit baked keyframes: ' + action.name)
        # External targets, drivers and custom properties cannot be guessed when moving Actions.
        bone = re.fullmatch(r'pose\.bones\[("(?:[^"\\]|\\.)*")\]\.(location|rotation_euler|rotation_quaternion|rotation_axis_angle|scale)', curve.data_path)
        if bone:
            if json.loads(bone.group(1)) not in rig.pose.bones:
                raise RuntimeError('Action references a missing bone: ' + action.name)
        elif curve.data_path not in {'location', 'rotation_euler', 'rotation_quaternion', 'rotation_axis_angle', 'scale'}:
            raise RuntimeError('Action contains a non-transform dependency: ' + action.name)
        keys = [{'co': numbers(key.co), 'left': numbers(key.handle_left), 'right': numbers(key.handle_right),
                 'interpolation': key.interpolation, 'easing': key.easing,
                 'amplitude': key.amplitude, 'back': key.back, 'period': key.period,
                 'leftType': key.handle_left_type, 'rightType': key.handle_right_type}
                for key in curve.keyframe_points]
        values.append({'path': curve.data_path, 'index': curve.array_index, 'extrapolation': curve.extrapolation,
                       'mute': curve.mute, 'keys': keys})
    values.sort(key=lambda value: (value['path'], value['index']))
    if not values or action.frame_range[1] <= action.frame_range[0]:
        raise RuntimeError('Exact selected Action has no playable keyframes: ' + action.name)
    return {'sha256': digest(values), 'frameRange': numbers(action.frame_range), 'channels': len(values)}


def armature():
    if bpy.data.libraries:
        raise RuntimeError('Linked Blender libraries must be made local')
    rigs = [obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE']
    if len(rigs) != 1:
        raise RuntimeError('Each accepted rig and clip must contain exactly one armature')
    rig = rigs[0]
    if rig.parent or rig.constraints or any(bone.constraints for bone in rig.pose.bones):
        raise RuntimeError('Parented or constrained rigs need an explicit baked compatible export')
    if any(obj.animation_data and obj.animation_data.drivers for obj in bpy.context.scene.objects):
        raise RuntimeError('Drivers require an explicit baked compatible export')
    return rig


def skeleton(rig):
    return {'transform': matrix(rig.matrix_world), 'rotationMode': rig.rotation_mode,
            'bones': sorted([{'name': bone.name, 'parent': bone.parent.name if bone.parent else None,
                              'bind': matrix(bone.matrix_local), 'length': float(bone.length),
                              'deform': bone.use_deform, 'connected': bone.use_connect,
                              'inheritScale': bone.inherit_scale, 'inheritRotation': bone.use_inherit_rotation,
                              'localLocation': bone.use_local_location,
                              'rotationMode': rig.pose.bones[bone.name].rotation_mode}
                             for bone in rig.data.bones], key=lambda item: item['name'])}


def appearance():
    meshes = []
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH':
            continue
        meshes.append({'name': obj.name, 'transform': matrix(obj.matrix_world),
                       'vertices': [numbers(vertex.co) for vertex in obj.data.vertices],
                       'faces': [list(face.vertices) for face in obj.data.polygons],
                       'uv': [[layer.name, [numbers(item.uv) for item in layer.data]] for layer in obj.data.uv_layers],
                       'groups': [group.name for group in obj.vertex_groups],
                       'weights': [[(group.group, group.weight) for group in vertex.groups] for vertex in obj.data.vertices],
                       'materials': [material.name if material else None for material in obj.data.materials],
                       'faceMaterials': [face.material_index for face in obj.data.polygons]})
    # Loading Actions alone must not add or replace the rig's texture/material datablocks.
    return digest({'meshes': meshes, 'materials': [(item.name, item.as_pointer()) for item in bpy.data.materials],
                   'images': [(item.name, item.as_pointer(), file_hash_bytes(item.packed_file.data) if item.packed_file else item.filepath)
                              for item in bpy.data.images]})


def file_hash_bytes(value):
    return hashlib.sha256(bytes(value)).hexdigest()


def fps():
    return bpy.context.scene.render.fps / bpy.context.scene.render.fps_base


q = json.loads(pathlib.Path(sys.argv[sys.argv.index('--') + 1]).read_text(encoding='utf8'))
input_root = pathlib.Path(q['inputRoot']).resolve()
declared = {str(pathlib.Path(item['local']).resolve()): item['sha256'] for item in q['files']}
for file, expected_hash in declared.items():
    if not pathlib.Path(file).is_relative_to(input_root) or file_hash(file) != expected_hash:
        raise RuntimeError('Declared source changed or escaped the private staging folder')
source = pathlib.Path(q['source']).resolve()
output = pathlib.Path(q['output']).resolve()
if str(source) not in declared or output.exists() or str(output) in declared or not output.is_relative_to(input_root):
    raise RuntimeError('Combined derivative cannot overwrite a source or leave private staging')
names = [clip['name'] for clip in q['clips']]
if not names or len(names) != len(set(names)):
    raise RuntimeError('Every selected clip needs one unique exact Action name')
clip_info = {}
for clip in q['clips']:
    file = pathlib.Path(clip['path']).resolve()
    if str(file) not in declared or file.suffix.lower() != '.blend':
        raise RuntimeError('Clip source must be a declared native Blender file')
    bpy.ops.wm.open_mainfile(filepath=str(file), load_ui=False, use_scripts=False)
    rig = armature()
    action = bpy.data.actions.get(clip['name'])
    if action is None:
        raise RuntimeError('Exact selected Action is missing: ' + clip['name'])
    clip_info[clip['name']] = {'skeleton': skeleton(rig), 'fps': fps(), 'action': action_evidence(action, rig)}

bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
rig = armature()
expected = skeleton(rig)
if not any(obj.type == 'MESH' and len(obj.data.vertices) for obj in bpy.context.scene.objects):
    raise RuntimeError('Accepted rig has no usable mesh')
original_appearance = appearance()
untouched = {action.name: action_evidence(action, rig) for action in bpy.data.actions if action.name not in names}
clip_fps = clip_info[names[0]]['fps']
if any(abs(info['fps'] - clip_fps) > 1e-6 for info in clip_info.values()) or untouched and abs(fps() - clip_fps) > 1e-6:
    raise RuntimeError('Selected clips or unchanged rig Actions have different FPS; no timing is resampled')
for name, info in clip_info.items():
    if info['skeleton'] != expected:
        raise RuntimeError('Clip bind pose, bone lengths, hierarchy, transform or rotation modes differ: ' + name)

# Disconnect the base rig's active Action/NLA only in the derivative. All Action
# data remains; the final FBX exports each Action independently, without NLA mixing.
for obj in bpy.context.scene.objects:
    if obj.animation_data:
        obj.animation_data_clear()
for clip in q['clips']:
    previous = bpy.data.actions.get(clip['name'])
    if previous:
        bpy.data.actions.remove(previous)
    with bpy.data.libraries.load(clip['path'], link=False) as (src, dst):
        if clip['name'] not in src.actions:
            raise RuntimeError('Selected Action disappeared from immutable clip')
        dst.actions = [clip['name']]
    action = dst.actions[0]
    if not action or action.name != clip['name'] or action_evidence(action, rig) != clip_info[clip['name']]['action']:
        raise RuntimeError('Selected Action curves changed during combination: ' + clip['name'])
    action.use_fake_user = True
for name, evidence in untouched.items():
    action = bpy.data.actions.get(name)
    if not action or action_evidence(action, rig) != evidence:
        raise RuntimeError('An unaffected rig Action changed: ' + name)
    action.use_fake_user = True
if appearance() != original_appearance or skeleton(rig) != expected:
    raise RuntimeError('Rig geometry, materials, textures, transforms or skeleton changed')
rig.animation_data_create()
rig.animation_data.action = bpy.data.actions[names[0]]
slots = list(getattr(rig.animation_data.action, 'slots', []))
if slots:
    rig.animation_data.action_slot = slots[0]
# Preserve fractional frame rates rather than rounding clip duration.
bpy.context.scene.render.fps = round(clip_fps)
bpy.context.scene.render.fps_base = round(clip_fps) / clip_fps
bpy.ops.wm.save_as_mainfile(filepath=str(output), compress=False)
for file, expected_hash in declared.items():
    if file_hash(file) != expected_hash:
        raise RuntimeError('A declared original changed during combination')
pathlib.Path(q['report']).write_text(json.dumps({'schemaVersion': 1, 'selectedClips': names,
    'untouchedActions': untouched, 'selectedActions': {name: info['action'] for name, info in clip_info.items()},
    'skeletonSha256': digest(expected), 'fps': clip_fps, 'outputSha256': file_hash(output),
    'sourceChanged': False, 'animationAuthored': False}, ensure_ascii=False), encoding='utf8')
