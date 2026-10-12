"""Host-owned Graphics Astra preparation, native validation and previews.

No authoring, motion inference, service calls, source saves or quality claims.
The original input and prepared source are read-only; renders/GLB are derivatives.
"""
import bpy
import hashlib
import json
import math
import pathlib
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


def snapshot():
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
    if not meshes or len({item['id'] for item in meshes}) != len(meshes) or any(not item['id'] for item in meshes):
        raise RuntimeError('Every original mesh requires one unique stable partsmith_id')
    return {'meshes': sorted(meshes, key=lambda value: value['id']), 'rigs': sorted(rigs, key=lambda value: value['name']),
            'textures': texture_evidence(), 'materials': material_evidence(),
            'actions': sorted([action_evidence(action) for action in bpy.data.actions], key=lambda value: value['name'])}


def save_json(file, value):
    target = pathlib.Path(file)
    temporary = target.with_suffix(target.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf8')
    temporary.replace(target)


def prepare(q):
    source = pathlib.Path(q['source'])
    if file_hash(source) != q['sourceSha256']:
        raise RuntimeError('Source hash does not match frozen request')
    if source.suffix.lower() == '.blend':
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
    evidence = snapshot()
    if q['operation'] in ('R03', 'N04', 'N05', 'N06') and not evidence['rigs']:
        raise RuntimeError('Accepted editable source has no actual rig')
    if q['operation'] == 'N06' and not any(action['name'] == q['actionName'] for action in evidence['actions']):
        raise RuntimeError('Original animated scene does not contain the exact action to revise')
    bpy.ops.wm.save_as_mainfile(filepath=q['outputBlend'], compress=False)
    if file_hash(source) != q['sourceSha256']:
        raise RuntimeError('Original source changed')
    evidence.update({'schemaVersion': 1, 'identity': q['identity'], 'nonce': q['nonce'], 'sourceSha256': q['sourceSha256'], 'blenderVersion': bpy.app.version_string})
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


def validate(q):
    output_hash, source_hash = file_hash(q['outputBlend']), file_hash(q['sourceBlend'])
    baseline = json.loads(pathlib.Path(q['baseline']).read_text(encoding='utf8'))
    if baseline['identity'] != q['identity'] or baseline['sourceSha256'] != q['sourceSha256']:
        raise RuntimeError('Baseline does not belong to this frozen request')
    bpy.ops.wm.open_mainfile(filepath=q['outputBlend'], load_ui=False, use_scripts=False)
    current = snapshot()
    checks = {}
    old = {mesh['id']: mesh for mesh in baseline['meshes']}
    new = {mesh['id']: mesh for mesh in current['meshes']}
    checks['meshLineage'] = set(old) == set(new)
    if not checks['meshLineage']:
        raise RuntimeError('Original stable mesh IDs were lost, added or replaced')
    checks['topology'] = all(all(old[key][field] == new[key][field] for field in ('vertices', 'faces', 'topology')) for key in old)
    checks['materials'] = baseline['textures'] == current['textures'] and baseline['materials'] == current['materials'] and all(all(old[key][field] == new[key][field] for field in ('uv', 'materials', 'faceMaterials')) for key in old)
    if not checks['topology'] or not checks['materials']:
        raise RuntimeError('Original topology/UV/materials/full-resolution packed textures changed')
    if q['operation'] != 'M05' and any(old[key]['positions'] != new[key]['positions'] or old[key]['transform'] != new[key]['transform'] for key in old):
        raise RuntimeError('Rig/animation authoring changed original mesh positions or transform')
    if q['operation'] == 'M05' and all(old[key]['positions'] == new[key]['positions'] and old[key]['transform'] == new[key]['transform'] for key in old):
        raise RuntimeError('Shape correction did not change any mesh shape or transform')
    checks['skeleton'] = baseline['rigs'] == current['rigs']
    if q['operation'] in ('M05', 'R03', 'N04', 'N05', 'N06') and not checks['skeleton']:
        raise RuntimeError('Original skeleton/rest pose/rotation mode changed')
    new_actions = {action['name']: action for action in current['actions']}
    checks['actionsPreserved'] = all(action['name'] == q['actionName'] and q['operation'].startswith('N') or action['name'] in new_actions and action['sha256'] == new_actions[action['name']]['sha256'] for action in baseline['actions'])
    if not checks['actionsPreserved']:
        raise RuntimeError('An untargeted original animation action was removed or modified')
    evidence = {}
    if q['operation'] != 'M05':
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
        evidence['deformingMeshIds'] = pose_test()
        checks['deformation'] = True
    if q['operation'].startswith('N'):
        evidence['clip'] = motion_test(q)
        checks['clipRange'] = checks['motion'] = True
    files, glb_images = preview(q)
    if file_hash(q['sourceBlend']) != source_hash or file_hash(q['outputBlend']) != output_hash:
        raise RuntimeError('Native source or authored blend changed during read-only validation')
    report = {'schemaVersion': 1, 'identity': q['identity'], 'nonce': q['nonce'], 'operation': q['operation'],
              'sourceSha256': q['sourceSha256'], 'outputSha256': output_hash, 'passed': True, 'checks': checks,
              'blenderVersion': bpy.app.version_string, **current, **evidence, 'files': files,
              'glbImages': glb_images, 'validatorFingerprint': q.get('validatorFingerprint'),
              'visualQualityVerified': False, 'contactVerified': False, 'unityPlaybackVerified': False}
    save_json(q['report'], report)


q = json.loads(pathlib.Path(sys.argv[sys.argv.index('--') + 1]).read_text(encoding='utf8'))
if q['mode'] == 'prepare':
    prepare(q)
elif q['mode'] == 'validate':
    validate(q)
else:
    raise RuntimeError('Unknown host validation mode')
