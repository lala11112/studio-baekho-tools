"""Read-only canonical Humanoid skin, part and FK evidence shared by authoring/export."""
import bpy
import math
from mathutils import Quaternion, Vector


def inspect_humanoid(contract, test_pose=False):
    rigs = [obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE']
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    if len(rigs) != 1 or not meshes:
        raise RuntimeError('Humanoid requires exactly one armature and skinned meshes')
    rig = rigs[0]
    mapping = contract.get('humanBones', [])
    required = {item['boneName'] for item in mapping}
    if any(obj.name in required for obj in bpy.context.scene.objects):
        raise RuntimeError('Humanoid mapped bone names must not collide with object names; preserve stable IDs and use Part_head/Part_body/Part_hair display names')
    if not required or not required.issubset(rig.data.bones.keys()):
        raise RuntimeError('Canonical Humanoid bone mapping is incomplete')
    parents = {'spine': 'pelvis', 'chest': 'spine', 'neck': 'chest', 'head': 'neck'}
    for side in ('L', 'R'):
        parents.update({f'upper_arm.{side}': 'chest', f'forearm.{side}': f'upper_arm.{side}', f'hand.{side}': f'forearm.{side}',
                        f'thigh.{side}': 'pelvis', f'shin.{side}': f'thigh.{side}', f'foot.{side}': f'shin.{side}'})
        if contract.get('fingers'):
            for finger in ('thumb', 'index', 'middle', 'ring', 'little'):
                for index in range(1, 4):
                    parents[f'{finger}.0{index}.{side}'] = f'hand.{side}' if index == 1 else f'{finger}.0{index-1}.{side}'
    for name in required:
        bone = rig.data.bones[name]
        if not bone.use_deform or bone.length < 1e-7:
            raise RuntimeError('Humanoid mapped bone must be a nondegenerate deform bone: ' + name)
        if name in parents:
            ancestor = bone.parent
            while ancestor and ancestor.name != parents[name]:
                ancestor = ancestor.parent
            if not ancestor:
                raise RuntimeError('Humanoid bone hierarchy is incompatible: ' + name)
    parts, direct = [], {name: [] for name in required}
    for mesh in meshes:
        part_id = str(mesh.get('partsmith_part_id', '')).removeprefix('part-')
        mods = [mod for mod in mesh.modifiers if mod.type == 'ARMATURE']
        if len(mods) != 1 or mods[0].object != rig or not mods[0].show_viewport or not mods[0].show_render or not mods[0].use_vertex_groups or mods[0].use_bone_envelopes or mods[0].vertex_group:
            raise RuntimeError('Every Humanoid part must use the same single unmasked vertex-group armature: ' + mesh.name)
        deform = {group.index: group.name for group in mesh.vertex_groups if group.name in rig.data.bones and rig.data.bones[group.name].use_deform}
        for vertex in mesh.data.vertices:
            weights = [(deform[g.group], float(g.weight)) for g in vertex.groups if g.group in deform]
            if not weights or any(not math.isfinite(weight) or weight < 0 or weight > 1.00001 for _, weight in weights) or abs(sum(weight for _, weight in weights) - 1) > .001:
                raise RuntimeError('Humanoid vertex has missing/invalid/non-normalized deform weights: ' + mesh.name)
            if part_id == 'hair' and contract.get('hairBinding') == 'head' and (abs(sum(weight for name, weight in weights if name == 'head')-1) > .001 or any(name != 'head' and weight > 1e-6 for name, weight in weights)):
                raise RuntimeError('Hair must follow Head with weight 1; independent hair controls were not requested')
            for name, weight in weights:
                if name in direct and weight > 1e-6:
                    direct[name].append((mesh, vertex.index))
        parts.append({'meshName': mesh.name, 'meshId': mesh.get('partsmith_id', ''), 'partId': part_id,
                      'vertices': len(mesh.data.vertices), 'armatureName': rig.name, 'normalizedWeights': True})
    if not set(contract.get('requiredParts', [])).issubset({part['partId'] for part in parts}):
        raise RuntimeError('Humanoid is missing a frozen requested part')
    evidence = []
    if test_pose:
        def coordinates():
            deps = bpy.context.evaluated_depsgraph_get()
            return {mesh.name: [mesh.matrix_world @ vertex.co for vertex in mesh.evaluated_get(deps).data.vertices] for mesh in meshes}
        saved = [(bone, bone.matrix_basis.copy(), bone.rotation_mode) for bone in rig.pose.bones]
        action = rig.animation_data.action if rig.animation_data else None
        slot = getattr(rig.animation_data, 'action_slot', None) if rig.animation_data else None
        try:
            if rig.animation_data:
                rig.animation_data.action = None
            for bone, _, _ in saved:
                bone.matrix_basis.identity()
            bpy.context.view_layer.update()
            baseline = coordinates()
            for name in sorted(required - {'pelvis'}):
                if not direct[name]:
                    raise RuntimeError('Mapped joint has no direct vertex influence: ' + name)
                bone = rig.pose.bones[name]
                moving = set()
                for axis in (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))):
                    bone.rotation_mode = 'QUATERNION'
                    bone.rotation_quaternion = Quaternion(axis, .16)
                    bpy.context.view_layer.update()
                    current = coordinates()
                    for mesh, index in direct[name]:
                        if (current[mesh.name][index] - baseline[mesh.name][index]).length > 1e-7:
                            moving.add(mesh.name)
                    bone.matrix_basis.identity()
                    bpy.context.view_layer.update()
                if not moving:
                    raise RuntimeError('Mapped joint lacks measurable direct-weight FK response: ' + name)
                evidence.append({'boneName': name, 'movingMeshNames': sorted(moving), 'directWeightedVertices': len(direct[name])})
        finally:
            for bone, basis, mode in saved:
                bone.rotation_mode = mode
                bone.matrix_basis = basis
            if rig.animation_data:
                rig.animation_data.action = action
                if action and slot:
                    rig.animation_data.action_slot = slot
            bpy.context.view_layer.update()
    return {'schemaVersion': 1, 'contract': contract, 'armatureName': rig.name, 'armatureCount': 1,
            'bones': sorted(required), 'parts': sorted(parts, key=lambda part: part['meshName']), 'jointEvidence': evidence}
