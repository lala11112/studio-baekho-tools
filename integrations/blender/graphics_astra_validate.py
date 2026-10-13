"""Host-owned Graphics Astra preparation, native validation and previews.

No authoring, motion inference, service calls, source saves or quality claims.
The original input and prepared source are read-only; renders/GLB are derivatives.
"""
import bpy
import hashlib
import json
import math
import pathlib
import re
import sys
from mathutils import Vector, Quaternion

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from graphics_glb import export_packed_glb


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def file_hash(file):
    return hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()


def numbers(values):
    result = [round(float(value), 7) for value in values]
    if not all(math.isfinite(value) for value in result):
        raise RuntimeError('Non-finite geometry, transform, curve or weight')
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


def action_evidence(action):
    values = []
    for curve in curves(action):
        if curve.modifiers:
            raise RuntimeError('Action modifiers need explicit baked animation: ' + action.name)
        keys = [{'co': numbers(key.co), 'left': numbers(key.handle_left), 'right': numbers(key.handle_right),
                 'interpolation': key.interpolation, 'leftType': key.handle_left_type, 'rightType': key.handle_right_type}
                for key in curve.keyframe_points]
        values.append({'path': curve.data_path, 'index': curve.array_index, 'extrapolation': curve.extrapolation, 'keys': keys})
    values.sort(key=lambda value: (value['path'], value['index']))
    return {'name': action.name, 'sha256': digest(values), 'frameRange': numbers(action.frame_range),
            'channels': len(values), 'poseChannels': sum('pose.bones[' in item['path'] for item in values),
            'keyframes': sum(len(item['keys']) for item in values),
            'varyingPoseChannels': sum('pose.bones[' in item['path'] and len({key['co'][1] for key in item['keys']}) > 1 for item in values)}


def texture_evidence():
    values = []
    for image in bpy.data.images:
        if image.source == 'VIEWER':
            continue
        if image.source != 'FILE' or not image.packed_file or min(image.size) < 1:
            raise RuntimeError('All source/output textures must be original packed files: ' + image.name)
        values.append({'name': image.name, 'size': list(image.size), 'sha256': hashlib.sha256(bytes(image.packed_file.data)).hexdigest(),
                       'colorSpace': image.colorspace_settings.name})
    return sorted(values, key=lambda value: value['name'])


def material_evidence():
    result = []
    for material in bpy.data.materials:
        nodes, links = [], []
        if material.use_nodes:
            for node in material.node_tree.nodes:
                inputs = []
                for socket in node.inputs:
                    value = getattr(socket, 'default_value', None)
                    if isinstance(value, (int, float)):
                        value = numbers([value])[0]
                    elif hasattr(value, '__iter__') and not isinstance(value, str):
                        try:
                            value = numbers(value)
                        except (TypeError, ValueError):
                            value = None
                    elif not isinstance(value, (str, bool)):
                        value = None
                    inputs.append([socket.identifier, value])
                nodes.append({'name': node.name, 'type': node.bl_idname, 'inputs': inputs,
                              'image': node.image.name if getattr(node, 'image', None) else None,
                              'operation': getattr(node, 'operation', None), 'blendType': getattr(node, 'blend_type', None)})
            links = sorted([link.from_node.name, link.from_socket.identifier, link.to_node.name, link.to_socket.identifier] for link in material.node_tree.links)
        result.append({'name': material.name, 'diffuse': numbers(material.diffuse_color),
                       'nodes': sorted(nodes, key=lambda node: node['name']), 'links': links})
    return sorted(result, key=lambda value: value['name'])


def surface_evidence():
    """Exact partition proof, independent of mesh/vertex ordering and object transforms."""
    faces = []
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH':
            continue
        for face in obj.data.polygons:
            corners = []
            for loop_index in face.loop_indices:
                vertex = obj.data.vertices[obj.data.loops[loop_index].vertex_index]
                weights = sorted([obj.vertex_groups[group.group].name, round(group.weight, 7)] for group in vertex.groups)
                corners.append(json.dumps([numbers(obj.matrix_world @ vertex.co),
                    [[layer.name, numbers(layer.data[loop_index].uv)] for layer in obj.data.uv_layers], weights], separators=(',', ':')))
            # Rotation of the first corner is immaterial; reversed winding is not.
            cycle = min(tuple(corners[index:] + corners[:index]) for index in range(len(corners)))
            material = obj.data.materials[face.material_index].name if face.material_index < len(obj.data.materials) and obj.data.materials[face.material_index] else None
            skin = [[modifier.object.name if modifier.object else None, modifier.show_viewport, modifier.show_render,
                     modifier.vertex_group, modifier.use_vertex_groups, modifier.use_bone_envelopes, modifier.use_deform_preserve_volume]
                    for modifier in obj.modifiers if modifier.type == 'ARMATURE']
            faces.append(digest([cycle, material, skin]))
    return {'surfaceSha256': digest(sorted(faces)), 'surfaceFaces': len(faces)}


def animation_contract():
    """Action-only Unity combination cannot transport new skin or dependencies."""
    rigs = [obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE']
    if bpy.data.libraries or len(rigs) != 1:
        raise RuntimeError('Animation requires one local armature for compatible Action-only export')
    rig = rigs[0]
    if rig.parent or any(obj.constraints for obj in bpy.context.scene.objects) or any(bone.constraints for bone in rig.pose.bones):
        raise RuntimeError('Animation constraints or a parented rig require an explicit baked compatible export before authoring')
    # Include data/shape-key/material node drivers, which do not travel with an Action.
    for owner in bpy.data.user_map():
        for data in (owner, getattr(owner, 'node_tree', None)):
            animation = getattr(data, 'animation_data', None)
            if animation and animation.drivers:
                raise RuntimeError('Animation drivers require an explicit baked compatible export before authoring: ' + data.name)
    for obj in bpy.context.scene.objects:
        if obj.animation_data and any(track.strips for track in obj.animation_data.nla_tracks):
            raise RuntimeError('Animation NLA mixing requires explicit baked Actions before authoring')
    for action in bpy.data.actions:
        slots = list(getattr(action, 'slots', []))
        if len(slots) > 1 or slots and slots[0].target_id_type != 'OBJECT':
            raise RuntimeError('Animation Action must use one object slot: ' + action.name)
        for curve in curves(action):
            if curve.modifiers or curve.sampled_points:
                raise RuntimeError('Animation Action modifiers or sampled curves require explicit baked keyframes: ' + action.name)
            bone = re.fullmatch(r'pose\.bones\[("(?:[^"\\]|\\.)*")\]\.(location|rotation_euler|rotation_quaternion|rotation_axis_angle|scale)', curve.data_path)
            if bone:
                if json.loads(bone.group(1)) not in rig.pose.bones:
                    raise RuntimeError('Animation Action references a missing bone: ' + action.name)
            elif curve.data_path not in {'location', 'rotation_euler', 'rotation_quaternion', 'rotation_axis_angle', 'scale'}:
                raise RuntimeError('Animation Action contains a non-transform dependency: ' + action.name)
    skin, modifiers = {}, {}
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH':
            continue
        weights = [[(group.group, float(group.weight)) for group in vertex.groups] for vertex in obj.data.vertices]
        if any(not math.isfinite(weight) for vertex in weights for _, weight in vertex):
            raise RuntimeError('Non-finite animation skin weight')
        skin[obj['partsmith_id']] = digest({'groups': [group.name for group in obj.vertex_groups], 'weights': weights})
        values = []
        for index, modifier in enumerate(obj.modifiers):
            if modifier.type != 'ARMATURE':
                continue
            # Capture every writable ArmatureModifier property, including envelope,
            # mask inversion, multi-modifier and visibility flags; retain stack order.
            settings = {}
            for prop in modifier.bl_rna.properties:
                if prop.is_readonly:
                    continue
                value = getattr(modifier, prop.identifier)
                settings[prop.identifier] = value.name if prop.type == 'POINTER' and value else value
            values.append({'index': index, 'settings': settings})
        modifiers[obj['partsmith_id']] = digest(values)
    def exact_numbers(values):
        result = [float(value) for value in values]
        if not all(math.isfinite(value) for value in result):
            raise RuntimeError('Non-finite animation skeleton value')
        return result
    # Match graphics_combine.skeleton without the display snapshot's rounding.
    skeleton = {'transform': [exact_numbers(row) for row in rig.matrix_world], 'rotationMode': rig.rotation_mode,
        'bones': sorted([{'name': bone.name, 'parent': bone.parent.name if bone.parent else None,
            'bind': [exact_numbers(row) for row in bone.matrix_local], 'length': exact_numbers([bone.length])[0],
            'deform': bone.use_deform, 'connected': bone.use_connect, 'inheritScale': bone.inherit_scale,
            'inheritRotation': bone.use_inherit_rotation, 'localLocation': bone.use_local_location,
            'rotationMode': rig.pose.bones[bone.name].rotation_mode}
            for bone in rig.data.bones], key=lambda item: item['name'])}
    return {'skin': skin, 'armatureModifiers': modifiers, 'skeleton': digest(skeleton)}


def snapshot(allow_empty=False):
    if any(obj.library or obj.data and obj.data.library for obj in bpy.context.scene.objects):
        raise RuntimeError('External linked scene data is not a self-contained editable scene')
    meshes, rigs = [], []
    for obj in bpy.context.scene.objects:
        if obj.type == 'ARMATURE':
            bones = [{'name': bone.name, 'parent': bone.parent.name if bone.parent else None,
                      'rest': matrix(bone.matrix_local), 'length': round(bone.length, 7), 'deform': bone.use_deform,
                      'rotationMode': obj.pose.bones[bone.name].rotation_mode} for bone in obj.data.bones]
            rigs.append({'name': obj.name, 'bones': sorted(bones, key=lambda value: value['name'])})
        if obj.type != 'MESH':
            continue
        vertices = [numbers(vertex.co) for vertex in obj.data.vertices]
        faces = [list(face.vertices) for face in obj.data.polygons]
        if len(vertices) < 3 or not faces or any(len(face) < 3 for face in faces):
            raise RuntimeError('Missing or degenerate mesh: ' + obj.name)
        armatures = [modifier.object for modifier in obj.modifiers if modifier.type == 'ARMATURE' and modifier.object and modifier.show_viewport and modifier.show_render]
        bones = {bone.name for rig in armatures for bone in rig.data.bones if bone.use_deform}
        deform_groups = {group.index for group in obj.vertex_groups if group.name in bones}
        weighted, invalid = 0, 0
        for vertex in obj.data.vertices:
            weights = numbers(group.weight for group in vertex.groups if group.group in deform_groups)
            weighted += any(value > 1e-6 for value in weights)
            invalid += not weights or any(value < 0 or value > 1.00001 for value in weights) or abs(sum(weights) - 1) > 0.001
        meshes.append({'id': obj.get('partsmith_id', ''), 'name': obj.name, 'vertices': len(vertices), 'faces': len(faces),
                       'topology': digest(faces), 'positions': digest(vertices), 'transform': matrix(obj.matrix_world),
                       'uv': digest([[layer.name, [numbers(item.uv) for item in layer.data]] for layer in obj.data.uv_layers]),
                       'materials': [slot.material.name if slot.material else None for slot in obj.material_slots],
                       'faceMaterials': digest([face.material_index for face in obj.data.polygons]),
                       'armatures': [rig.name for rig in armatures], 'weightedVertices': weighted, 'invalidWeightVertices': invalid})
        meshes[-1]['weights'] = digest([sorted([obj.vertex_groups[group.group].name, round(group.weight, 7)] for group in vertex.groups) for vertex in obj.data.vertices])
        meshes[-1]['partId'] = obj.get('partsmith_part_id', '')
        meshes[-1]['modifiers'] = [{'type': modifier.type, 'target': modifier.object.name if modifier.type == 'ARMATURE' and modifier.object else None,
            'viewport': modifier.show_viewport, 'render': modifier.show_render,
            'vertexGroup': getattr(modifier, 'vertex_group', ''), 'envelopes': getattr(modifier, 'use_bone_envelopes', False),
            'vertexGroups': getattr(modifier, 'use_vertex_groups', False), 'preserveVolume': getattr(modifier, 'use_deform_preserve_volume', False)} for modifier in obj.modifiers]
        meshes[-1]['shapeKeys'] = digest([[key.name, [numbers(vertex.co) for vertex in key.data], key.value] for key in obj.data.shape_keys.key_blocks]) if obj.data.shape_keys else None
    if (not meshes and not allow_empty) or len({item['id'] for item in meshes}) != len(meshes) or any(not item['id'] for item in meshes):
        raise RuntimeError('Every original mesh requires one unique stable partsmith_id')
    return {'meshes': sorted(meshes, key=lambda value: value['id']), 'rigs': sorted(rigs, key=lambda value: value['name']),
            'textures': texture_evidence(), 'materials': material_evidence(),
            'actions': sorted([action_evidence(action) for action in bpy.data.actions], key=lambda value: value['name']),
            'rigTransforms': {obj.name: matrix(obj.matrix_world) for obj in bpy.context.scene.objects if obj.type == 'ARMATURE'}, **surface_evidence()}


def save_json(file, value):
    target = pathlib.Path(file)
    temporary = target.with_suffix(target.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf8')
    temporary.replace(target)


def prepare(q):
    source = pathlib.Path(q['source'])
    if file_hash(source) != q['sourceSha256']:
        raise RuntimeError('Source hash does not match frozen request')
    if q['operation'] == 'M15':
        if source.suffix.lower() not in ('.png', '.jpg', '.jpeg', '.webp'):
            raise RuntimeError('New model requires the accepted design image')
        bpy.ops.wm.read_factory_settings(use_empty=True)
    elif source.suffix.lower() == '.blend':
        bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
    elif source.suffix.lower() in ('.fbx', '.glb'):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        if source.suffix.lower() == '.fbx':
            bpy.ops.import_scene.fbx(filepath=str(source), use_image_search=False)
        else:
            bpy.ops.import_scene.gltf(filepath=str(source))
        # Only embedded/contained import textures may be packed. No global search.
        import_root = pathlib.Path(q.get('importRoot', source.parent)).resolve()
        for image in bpy.data.images:
            if image.source != 'FILE' or image.packed_file:
                continue
            image_path = pathlib.Path(bpy.path.abspath(image.filepath)).resolve()
            if not image_path.is_relative_to(import_root) or not image_path.is_file():
                # Native FBX may retain its original machine's absolute texture
                # path. Resolve only a unique supplied/extracted companion in
                # this private import root; never search the user's directories.
                basename = pathlib.PurePosixPath(image.filepath.replace('\\', '/')).name.casefold()
                matches = [item for item in import_root.rglob('*') if item.is_file() and item.name.casefold() == basename]
                if len(matches) != 1:
                    raise RuntimeError('Imported texture is missing or ambiguous in immutable companions: ' + image.name)
                image.filepath = str(matches[0])
                image.reload()
            if min(image.size) < 1:
                raise RuntimeError('Imported native texture could not be decoded: ' + image.name)
            image.pack()
    else:
        raise RuntimeError('Expected native BLEND/FBX/GLB source')
    for obj in bpy.context.scene.objects:
        if obj.type == 'MESH' and not obj.get('partsmith_id'):
            obj['partsmith_id'] = 'mesh-' + digest([q['sourceSha256'], obj.name])[:24]
    evidence = snapshot(allow_empty=q['operation'] == 'M15')
    if q['operation'] in ('R03', 'N04', 'N05', 'N06') and not evidence['rigs']:
        raise RuntimeError('Accepted editable source has no actual rig')
    if q['operation'] == 'N06' and not any(action['name'] == q['actionName'] for action in evidence['actions']):
        raise RuntimeError('Original animated scene does not contain the exact action to revise')
    if q['operation'] in ('N04', 'N05', 'N06'):
        evidence['animationContract'] = animation_contract()
    bpy.ops.wm.save_as_mainfile(filepath=q['outputBlend'], compress=False)
    if file_hash(source) != q['sourceSha256']:
        raise RuntimeError('Original source changed')
    evidence.update({'schemaVersion': 1, 'identity': q['identity'], 'nonce': q['nonce'], 'sourceSha256': q['sourceSha256'], 'blenderVersion': bpy.app.version_string})
    save_json(q['report'], evidence)


def prepare_assembly(q):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sources = q['sources']
    if len(sources) < 2 or len({item['versionId'] for item in sources}) != len(sources):
        raise RuntimeError('Assembly needs distinct accepted part versions')
    for source in sources:
        if file_hash(source['path']) != source['sha256'] or pathlib.Path(source['path']).suffix.lower() != '.blend':
            raise RuntimeError('Assembly original hash or format differs')
        with bpy.data.libraries.load(source['path'], link=False) as (available, loaded):
            if len(available.scenes) != 1:
                raise RuntimeError('Accepted assembly part must contain one unambiguous scene')
            loaded.scenes = list(available.scenes)
            loaded.actions = list(available.actions)
        part_scene = loaded.scenes[0]
        objects = list(part_scene.objects)
        meshes = [obj for obj in objects if obj.type == 'MESH']
        if not meshes:
            raise RuntimeError('Accepted part has no original meshes')
        ids = [obj.get('partsmith_id') for obj in meshes]
        if any(not value for value in ids) or len(set(ids)) != len(ids):
            raise RuntimeError('Accepted part needs unique original mesh IDs')
        for obj in objects:
            if obj and obj.type in ('MESH', 'ARMATURE', 'EMPTY'):
                bpy.context.scene.collection.objects.link(obj)
                if obj.type == 'MESH':
                    obj['partsmith_id'] = source['versionId'] + ':' + obj['partsmith_id']
                    obj['partsmith_part_id'] = source['slot']
        for action in loaded.actions:
            if action:
                action.use_fake_user = True
        bpy.data.scenes.remove(part_scene)
    bpy.context.view_layer.update()
    evidence = snapshot()
    bpy.ops.wm.save_as_mainfile(filepath=q['outputBlend'], compress=False)
    for source in sources:
        if file_hash(source['path']) != source['sha256']:
            raise RuntimeError('Assembly source changed')
    evidence.update({'schemaVersion': 1, 'identity': q['identity'], 'nonce': q['nonce'],
                     'sourceSha256': q['sourceSha256'], 'blenderVersion': bpy.app.version_string})
    save_json(q['report'], evidence)


def coordinates():
    graph = bpy.context.evaluated_depsgraph_get()
    values = {}
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH':
            continue
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        try:
            values[obj.get('partsmith_id')] = [tuple(numbers(evaluated.matrix_world @ vertex.co)) for vertex in mesh.vertices]
        finally:
            evaluated.to_mesh_clear()
    return values


def different(a, b):
    if set(a) != set(b) or any(len(a[key]) != len(b[key]) for key in a):
        raise RuntimeError('Evaluated mesh topology changes across pose samples')
    return {key for key in a if any(sum((x - y) ** 2 for x, y in zip(left, right)) > 1e-12 for left, right in zip(a[key], b[key]))}


def pose_test():
    # Temporary in-memory pose tests, never saved to the authored blend.
    rigs = [obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE']
    saved = [(rig, rig.animation_data.action if rig.animation_data else None,
              rig.animation_data.action_slot if rig.animation_data and hasattr(rig.animation_data, 'action_slot') else None,
              [(bone, bone.matrix_basis.copy(), bone.rotation_mode) for bone in rig.pose.bones]) for rig in rigs]
    moved = set()
    try:
        for rig, action, slot, poses in saved:
            if rig.animation_data:
                rig.animation_data.action = None
            for bone, basis, mode in poses:
                bone.matrix_basis.identity()
        bpy.context.view_layer.update()
        base = coordinates()
        for rig, action, slot, poses in saved:
            for bone, basis, mode in poses:
                if not bone.parent or not bone.bone.use_deform:
                    continue
                bone.rotation_mode = 'QUATERNION'
                bone.rotation_quaternion = Quaternion(Vector((0.3, 0.7, 0.5)).normalized(), 0.17)
                bpy.context.view_layer.update()
                moved.update(different(base, coordinates()))
                bone.matrix_basis.identity()
                bone.rotation_mode = mode
                bpy.context.view_layer.update()
        if moved != set(base):
            raise RuntimeError('Every mesh must actually deform under at least one non-root joint pose; rigid/static or broken skin found')
    finally:
        for rig, action, slot, poses in saved:
            for bone, basis, mode in poses:
                bone.rotation_mode = mode
                bone.matrix_basis = basis
            if rig.animation_data:
                rig.animation_data.action = action
                if action and slot:
                    rig.animation_data.action_slot = slot
        bpy.context.view_layer.update()
    return sorted(moved)


def bind_action(rig, action):
    rig.animation_data_create()
    rig.animation_data.action = action
    slots = list(getattr(action, 'slots', []))
    if slots:
        suitable = [slot for slot in slots if slot.target_id_type == 'OBJECT' and (slot.name_display == rig.name or len(slots) == 1)]
        if len(suitable) != 1:
            raise RuntimeError('Animation action slot is ambiguous for rig: ' + rig.name)
        rig.animation_data.action_slot = suitable[0]


def rig_feature_test(features):
    """Each explicitly enabled appendage must have weighted, moving deform joints."""
    if not isinstance(features, list) or len(set(features)) != len(features) or any(feature not in ('ears', 'tail', 'hair', 'cloth', 'wings', 'accessories') for feature in features):
        raise RuntimeError('Unknown or duplicate requested rig control feature')
    rigs = [obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE']
    saved = [(rig, rig.animation_data.action if rig.animation_data else None,
              rig.animation_data.action_slot if rig.animation_data and hasattr(rig.animation_data, 'action_slot') else None,
              [(bone, bone.matrix_basis.copy(), bone.rotation_mode) for bone in rig.pose.bones]) for rig in rigs]
    evidence = {}
    try:
        for rig, action, slot, poses in saved:
            if rig.animation_data:
                rig.animation_data.action = None
            for bone, basis, mode in poses:
                bone.matrix_basis.identity()
        bpy.context.view_layer.update()
        base = coordinates()
        for feature in features:
            tested = []
            for rig, action, slot, poses in saved:
                for bone, basis, mode in poses:
                    if bone.bone.get('partsmith_feature') != feature or not bone.parent or not bone.bone.use_deform:
                        continue
                    influenced = []
                    for obj in bpy.context.scene.objects:
                        if obj.type != 'MESH' or not any(mod.type == 'ARMATURE' and mod.object == rig and mod.show_viewport and mod.show_render for mod in obj.modifiers):
                            continue
                        group = obj.vertex_groups.get(bone.name)
                        if group and any(any(value.group == group.index and value.weight > 1e-6 for value in vertex.groups) for vertex in obj.data.vertices):
                            influenced.append(obj.get('partsmith_id'))
                    bone.rotation_mode = 'QUATERNION'
                    bone.rotation_quaternion = Quaternion(Vector((0.3, 0.7, 0.5)).normalized(), 0.23)
                    bpy.context.view_layer.update()
                    moving = sorted(set(influenced) & different(base, coordinates()))
                    bone.matrix_basis.identity()
                    bone.rotation_mode = mode
                    bpy.context.view_layer.update()
                    if moving:
                        tested.append({'bone': rig.name + '/' + bone.name, 'movingMeshIds': moving})
            if not tested:
                raise RuntimeError('Requested appendage lacks a tagged non-root deform bone with actual weighted pose response: ' + feature)
            evidence[feature] = tested
    finally:
        for rig, action, slot, poses in saved:
            for bone, basis, mode in poses:
                bone.rotation_mode = mode
                bone.matrix_basis = basis
            if rig.animation_data:
                rig.animation_data.action = action
                if action and slot:
                    rig.animation_data.action_slot = slot
        bpy.context.view_layer.update()
    return evidence


def motion_test(q):
    scene = bpy.context.scene
    action = bpy.data.actions.get(q['actionName'])
    if not action:
        raise RuntimeError('Exact requested animation action is missing')
    evidence = action_evidence(action)
    end = 1 + round(q['duration'] * q['fps'])
    if evidence['poseChannels'] < 1 or evidence['varyingPoseChannels'] < 1 or evidence['keyframes'] < 3:
        raise RuntimeError('No actual varying pose keyframes')
    if evidence['frameRange'] != [1.0, float(end)] or scene.frame_start != 1 or scene.frame_end != end or abs(scene.render.fps / scene.render.fps_base - q['fps']) > 1e-6:
        raise RuntimeError('Actual action/frame range/FPS differs from the frozen clip request')
    rigs = [obj for obj in scene.objects if obj.type == 'ARMATURE']
    for rig in rigs:
        bind_action(rig, action)
    samples = sorted(set(round(1 + (end - 1) * i / 8) for i in range(9)))
    scene.frame_set(samples[0])
    base = coordinates()
    pose_base = {(rig.name, bone.name): matrix(bone.matrix) for rig in rigs for bone in rig.pose.bones if bone.parent and bone.bone.use_deform}
    moving_bones, moving_meshes = set(), set()
    for frame in samples[1:]:
        scene.frame_set(frame)
        moving_meshes.update(different(base, coordinates()))
        for rig in rigs:
            for bone in rig.pose.bones:
                key = (rig.name, bone.name)
                if key in pose_base and pose_base[key] != matrix(bone.matrix):
                    moving_bones.add('/'.join(key))
    if not moving_bones or not moving_meshes:
        raise RuntimeError('Clip does not produce actual non-root pose movement and mesh deformation')
    scene.frame_set(1)
    return {**evidence, 'sampleFrames': samples, 'movingBones': sorted(moving_bones), 'movingMeshes': sorted(moving_meshes), 'fps': q['fps'], 'duration': q['duration']}


def preview(q):
    scene = bpy.context.scene
    out = pathlib.Path(q['output'])
    files = []
    bpy.ops.object.select_all(action='DESELECT')
    selected = [obj for obj in scene.objects if obj.type in ('MESH', 'ARMATURE', 'EMPTY')]
    for obj in selected:
        obj.select_set(True)
    meshes = [obj for obj in selected if obj.type == 'MESH']
    bpy.context.view_layer.objects.active = meshes[0]
    glb_images = export_packed_glb(out / 'asset.glb', use_selection=True, export_animations=True)
    files.append('asset.glb')
    # Native preview cameras/lights are temporary and never alter the authored scene file.
    for obj in list(scene.objects):
        if obj.type in ('LIGHT', 'CAMERA'):
            bpy.data.objects.remove(obj, do_unlink=True)
    if q['operation'].startswith('N'):
        scene.frame_set(1 + round(q['duration'] * q['fps'] / 2))
    bpy.context.view_layer.update()
    points = [Vector(point) for mesh in coordinates().values() for point in mesh]
    low = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    high = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    center = (low + high) * 0.5
    radius = max((high - low).length * 0.5, 0.01)
    engines = scene.render.bl_rna.properties['engine'].enum_items.keys()
    scene.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in engines else 'BLENDER_EEVEE'
    scene.render.resolution_x = 768
    scene.render.resolution_y = 768
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.film_transparent = False
    scene.world = bpy.data.worlds.new('HostPreviewWorld')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.055, 0.06, 0.08, 1)
    scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6
    for index, offset in enumerate(((2, -3, 4), (-3, -1, 2), (1, 3, 3))):
        light = bpy.data.lights.new('HostPreviewLight' + str(index), 'AREA')
        light.energy = 900 * radius * radius
        light.shape = 'DISK'
        light.size = radius * 3
        obj = bpy.data.objects.new(light.name, light)
        scene.collection.objects.link(obj)
        obj.location = center + Vector(offset) * radius
        obj.rotation_euler = (center - obj.location).to_track_quat('-Z', 'Y').to_euler()
    camera = bpy.data.cameras.new('HostPreviewCamera')
    camera.type = 'ORTHO'
    camera.ortho_scale = radius * 2.5
    camera.clip_start = 0.0001
    camera.clip_end = radius * 100 + 100
    obj = bpy.data.objects.new('HostPreviewCamera', camera)
    scene.collection.objects.link(obj)
    scene.camera = obj
    for name, offset in [('front', (0, -1, 0.15)), ('side', (1, 0, 0.15)), ('back', (0, 1, 0.15))]:
        obj.location = center + Vector(offset).normalized() * radius * 5
        obj.rotation_euler = (center - obj.location).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = str(out / (name + '.png'))
        bpy.ops.render.render(write_still=True)
        files.append(name + '.png')
    return files, glb_images


def model_checks(q, baseline, current):
    operation = q['operation']
    old, new = ({mesh['id']: mesh for mesh in value['meshes']} for value in (baseline, current))
    checks = {'meshLineage': set(old) == set(new), 'skeleton': baseline['rigs'] == current['rigs'] and (operation == 'M08' and not q.get('locks', {}).get('rig') or baseline.get('rigTransforms') == current.get('rigTransforms'))}
    checks['topology'] = checks['meshLineage'] and all(all(old[key][field] == new[key][field] for field in ('vertices', 'faces', 'topology')) for key in old)
    checks['materials'] = baseline['textures'] == current['textures'] and baseline['materials'] == current['materials']
    checks['actionsPreserved'] = all(action in current['actions'] for action in baseline['actions'])
    if any(any(modifier['type'] != 'ARMATURE' for modifier in mesh['modifiers']) or mesh['shapeKeys'] for mesh in current['meshes'] + baseline['meshes']):
        raise RuntimeError('Partial edit, partition, assembly and new-model verification currently require baked non-armature modifiers and no shape keys')
    if operation == 'M15':
        checks['newGeometry'] = not old and bool(new)
        if not checks['newGeometry']:
            raise RuntimeError('New model must start from the empty prepared scene and contain actual geometry')
    elif operation == 'M07':
        parts = q['requestedParts']
        checks['partition'] = (len(parts) >= 2 and set(mesh['partId'] for mesh in new.values()) == {part['id'] for part in parts}
            and baseline['surfaceFaces'] == current['surfaceFaces'] and baseline['surfaceSha256'] == current['surfaceSha256'])
        if not checks['partition']:
            raise RuntimeError('Part separation must partition every original polygon exactly once with unchanged world positions, UV, materials and weights')
        if not checks['materials'] or not checks['skeleton'] or not checks['actionsPreserved']:
            raise RuntimeError('Part separation changed original packed textures, materials, skeleton or actions')
    else:
        if not checks['meshLineage'] or not checks['topology']:
            raise RuntimeError('This partial edit/assembly preserves original mesh IDs and topology; replacement/remeshing is unsupported')
        checks['materials'] = checks['materials'] and all(all(old[key][field] == new[key][field] for field in ('uv', 'materials', 'faceMaterials')) for key in old)
        if not checks['materials'] or not checks['skeleton'] or not checks['actionsPreserved'] or any(old[key]['weights'] != new[key]['weights'] or old[key]['modifiers'] != new[key]['modifiers'] for key in old):
            raise RuntimeError('Partial edit/assembly changed original UV, materials, weights, skeleton or actions')
        if operation == 'M06':
            targets = set(q['editMeshIds'])
            checks['partialEdit'] = bool(targets) and targets.issubset(old) and any(old[key]['positions'] != new[key]['positions'] or old[key]['transform'] != new[key]['transform'] for key in targets)
            if not checks['partialEdit'] or any(old[key]['positions'] != new[key]['positions'] or old[key]['transform'] != new[key]['transform'] for key in old if key not in targets):
                raise RuntimeError('Partial edit must change the named meshes only and preserve all untargeted positions/transforms')
        elif operation == 'M08' and any(old[key]['positions'] != new[key]['positions'] for key in old):
            raise RuntimeError('Part assembly supports object transforms only; original vertex positions changed')
    for lock, check in [('topology', 'topology'), ('materials', 'materials'), ('rig', 'skeleton')]:
        if q.get('locks', {}).get(lock) is True and not checks[check]:
            raise RuntimeError('Explicit structural lock failed: ' + lock)
    return checks


def part_previews(q, current):
    original_scene = bpy.context.scene
    base = pathlib.Path(q['output'])
    candidates, files, images = [], [], []
    for part in q['requestedParts']:
        folder = base / ('part-' + part['id'])
        folder.mkdir()
        scene = bpy.data.scenes.new('Partsmith_' + part['id'])
        members = [obj for obj in original_scene.objects if obj.type in ('ARMATURE', 'EMPTY') or obj.type == 'MESH' and obj.get('partsmith_part_id') == part['id']]
        for obj in members:
            ancestor = obj.parent
            while ancestor:
                if ancestor not in members:
                    raise RuntimeError('Part depends on an object outside its separate scene')
                ancestor = ancestor.parent
            scene.collection.objects.link(obj)
        scene.frame_start, scene.frame_end = original_scene.frame_start, original_scene.frame_end
        scene.render.fps, scene.render.fps_base = original_scene.render.fps, original_scene.render.fps_base
        bpy.context.window.scene = scene
        try:
            bpy.data.libraries.write(str(folder / 'asset.blend'), {scene, *bpy.data.actions}, fake_user=True, compress=False)
            part_files, part_images = preview({**q, 'output': str(folder)})
            bpy.ops.object.select_all(action='DESELECT')
            for obj in members:
                obj.select_set(True)
            bpy.context.view_layer.objects.active = next(obj for obj in members if obj.type == 'MESH')
            bpy.ops.export_scene.fbx(filepath=str(folder / 'asset.fbx'), use_selection=True,
                object_types={'ARMATURE', 'MESH', 'EMPTY'}, axis_forward='-Z', axis_up='Y', apply_unit_scale=True,
                apply_scale_options='FBX_SCALE_UNITS', add_leaf_bones=False, bake_anim=True,
                bake_anim_use_all_actions=True, bake_anim_use_nla_strips=False, bake_anim_simplify_factor=0.0,
                path_mode='COPY', embed_textures=True)
            paths = [('part-' + part['id'] + '/' + file) for file in ['asset.blend', 'asset.fbx', *part_files]]
            candidates.append({'slot': part['id'], 'label': part['label'], 'files': paths,
                               'meshIds': [mesh['id'] for mesh in current['meshes'] if mesh['partId'] == part['id']]})
            files.extend(paths)
            images.extend(part_images)
        finally:
            bpy.context.window.scene = original_scene
    return files, images, candidates


def validate(q):
    output_hash, source_hash = file_hash(q['outputBlend']), file_hash(q['sourceBlend'])
    baseline = json.loads(pathlib.Path(q['baseline']).read_text(encoding='utf8'))
    if baseline['identity'] != q['identity'] or baseline['sourceSha256'] != q['sourceSha256']:
        raise RuntimeError('Baseline does not belong to this frozen request')
    bpy.ops.wm.open_mainfile(filepath=q['outputBlend'], load_ui=False, use_scripts=False)
    current = snapshot()
    checks = {}
    expanded_model = q['operation'] in ('M06', 'M07', 'M08', 'M15')
    old = {mesh['id']: mesh for mesh in baseline['meshes']}
    new = {mesh['id']: mesh for mesh in current['meshes']}
    checks['meshLineage'] = set(old) == set(new)
    if not checks['meshLineage'] and not expanded_model:
        raise RuntimeError('Original stable mesh IDs were lost, added or replaced')
    checks['topology'] = checks['meshLineage'] and all(all(old[key][field] == new[key][field] for field in ('vertices', 'faces', 'topology')) for key in old)
    checks['materials'] = checks['meshLineage'] and baseline['textures'] == current['textures'] and baseline['materials'] == current['materials'] and all(all(old[key][field] == new[key][field] for field in ('uv', 'materials', 'faceMaterials')) for key in old)
    if not expanded_model and (not checks['topology'] or not checks['materials']):
        raise RuntimeError('Original topology/UV/materials/full-resolution packed textures changed')
    if not expanded_model and q['operation'] != 'M05' and any(old[key]['positions'] != new[key]['positions'] or old[key]['transform'] != new[key]['transform'] for key in old):
        raise RuntimeError('Rig/animation authoring changed original mesh positions or transform')
    if q['operation'] == 'M05' and all(old[key]['positions'] == new[key]['positions'] and old[key]['transform'] == new[key]['transform'] for key in old):
        raise RuntimeError('Shape correction did not change any mesh shape or transform')
    checks['skeleton'] = baseline['rigs'] == current['rigs']
    if q.get('locks', {}).get('rig'):
        checks['skeleton'] = checks['skeleton'] and baseline.get('rigTransforms') == current.get('rigTransforms')
    if q['operation'] in ('M05', 'R03', 'N04', 'N05', 'N06') and not checks['skeleton']:
        raise RuntimeError('Original skeleton/rest pose/rotation mode changed')
    new_actions = {action['name']: action for action in current['actions']}
    checks['actionsPreserved'] = all(action['name'] == q['actionName'] and q['operation'].startswith('N') or action['name'] in new_actions and action['sha256'] == new_actions[action['name']]['sha256'] for action in baseline['actions'])
    if not checks['actionsPreserved']:
        raise RuntimeError('An untargeted original animation action was removed or modified')
    evidence = {}
    if expanded_model:
        checks = model_checks(q, baseline, current)
    for lock, check in [('topology', 'topology'), ('materials', 'materials'), ('rig', 'skeleton')]:
        if q.get('locks', {}).get(lock) is True and not checks.get(check):
            raise RuntimeError('Explicit structural lock failed: ' + lock)
    if q['operation'].startswith(('R', 'N')):
        rigs = current['rigs']
        if not rigs or any(len(rig['bones']) < 3 or not any(bone['parent'] for bone in rig['bones']) or any(bone['length'] < 1e-7 for bone in rig['bones']) for rig in rigs):
            raise RuntimeError('Missing, degenerate or unparented skeleton')
        if q['operation'] == 'R01':
            required = {'pelvis', 'spine', 'chest', 'neck', 'head'} | {name + '.' + side for name in ('upper_arm', 'forearm', 'hand', 'thigh', 'shin', 'foot') for side in ('L', 'R')}
            if not any(required.issubset({bone['name'] for bone in rig['bones']}) for rig in rigs):
                raise RuntimeError('Requested humanoid joint mapping is incomplete')
        checks['weights'] = all(mesh['armatures'] and mesh['weightedVertices'] == mesh['vertices'] and mesh['invalidWeightVertices'] == 0 for mesh in current['meshes'])
        if not checks['weights']:
            raise RuntimeError('Missing armature, unweighted vertices or invalid/non-normalized deform weights')
        if q['operation'] in ('N04', 'N05', 'N06'):
            current['animationContract'] = animation_contract()
            previous = baseline.get('animationContract')
            if not previous:
                raise RuntimeError('Animation baseline lacks the exact skin/dependency contract; prepare a new explicit request')
            checks['animationDependencies'] = True
            checks['skinPreserved'] = previous['skin'] == current['animationContract']['skin']
            checks['armatureModifiersPreserved'] = previous['armatureModifiers'] == current['animationContract']['armatureModifiers']
            checks['animationSkeletonPreserved'] = previous['skeleton'] == current['animationContract']['skeleton']
            if not checks['skinPreserved'] or not checks['armatureModifiersPreserved']:
                raise RuntimeError('Animation changed original skin weights/groups or Armature modifier settings/order; Action-only export cannot preserve these edits')
            if not checks['animationSkeletonPreserved']:
                raise RuntimeError('Animation changed original skeleton transform, bind pose or bone inheritance settings; Action-only export requires an exact compatible skeleton')
        evidence['deformingMeshIds'] = pose_test()
        checks['deformation'] = True
        if q['operation'] in ('R01', 'R02') and q.get('rigFeatures'):
            evidence['rigFeatures'] = rig_feature_test(q['rigFeatures'])
            checks['rigFeatures'] = True
    if q['operation'].startswith('N'):
        evidence['clip'] = motion_test(q)
        checks['clipRange'] = checks['motion'] = True
    candidates = []
    if q['operation'] == 'M07':
        files, glb_images, candidates = part_previews(q, current)
    else:
        files, glb_images = preview(q)
    if file_hash(q['sourceBlend']) != source_hash or file_hash(q['outputBlend']) != output_hash:
        raise RuntimeError('Native source or authored blend changed during read-only validation')
    report = {'schemaVersion': 1, 'identity': q['identity'], 'nonce': q['nonce'], 'operation': q['operation'],
              'sourceSha256': q['sourceSha256'], 'outputSha256': output_hash, 'passed': True, 'checks': checks,
              'blenderVersion': bpy.app.version_string, **current, **evidence, 'files': files,
              'glbImages': glb_images, 'candidates': candidates, 'validatorFingerprint': q.get('validatorFingerprint'),
              'visualQualityVerified': False, 'contactVerified': False, 'unityPlaybackVerified': False}
    save_json(q['report'], report)


q = json.loads(pathlib.Path(sys.argv[sys.argv.index('--') + 1]).read_text(encoding='utf8'))
if q['mode'] == 'prepare':
    prepare(q)
elif q['mode'] == 'prepare-assembly':
    prepare_assembly(q)
elif q['mode'] == 'validate':
    validate(q)
else:
    raise RuntimeError('Unknown host validation mode')
