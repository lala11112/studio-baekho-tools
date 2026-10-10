"""Host-owned read-only inspection of an authored Blender revision.

This never fixes a scene or reports artistic quality. It produces structural
evidence independently of the authoring worker's self-reported checks.
"""
import bpy
import json
import math
import sys


def finite(values):
    return all(math.isfinite(float(value)) for value in values)


def bone_evidence(rig, bone):
    weighted = 0
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH" or not any(mod.type == "ARMATURE" and mod.object == rig for mod in obj.modifiers):
            continue
        group = obj.vertex_groups.get(bone.name)
        if group:
            weighted += sum(1 for vertex in obj.data.vertices if any(g.group == group.index and g.weight > 0.00001 for g in vertex.groups))
    return {"name": bone.name, "parent": bone.parent.name if bone.parent else None,
            "target": bone.get("partsmith_target_id", ""),
            "limb": bone.get("partsmith_limb", ""), "control": bone.get("partsmith_control", ""),
            "deform": bone.use_deform, "weightedVertices": weighted}


def inspect():
    objects = []
    rigs = []
    for obj in bpy.context.scene.objects:
        if obj.type == "ARMATURE":
            rigs.append({
                "name": obj.name,
                "type": obj.get("partsmith_rig_type", ""),
                "bones": [bone_evidence(obj, bone) for bone in obj.data.bones],
            })
        if obj.type != "MESH":
            continue
        bound_rigs = [mod.object for mod in obj.modifiers if mod.type == "ARMATURE" and mod.object]
        deform_bones = {bone.name for rig in bound_rigs for bone in rig.data.bones if bone.use_deform}
        deform_groups = {group.index for group in obj.vertex_groups if group.name in deform_bones}
        weighted = sum(1 for vertex in obj.data.vertices if any(group.group in deform_groups and group.weight > 0.00001 for group in vertex.groups))
        invalid_weights = 0
        for vertex in obj.data.vertices:
            values = [g.weight for g in vertex.groups if g.group in deform_groups]
            if not finite(values) or any(v < 0 for v in values) or abs(sum(values) - 1.0) > 0.001:
                invalid_weights += 1
        armatures = [rig.name for rig in bound_rigs]
        objects.append({
            "id": obj.get("partsmith_id", ""),
            "name": obj.name,
            "category": obj.get("partsmith_category", "other"),
            "separate": True,
            "vertices": len(obj.data.vertices),
            "faces": len(obj.data.polygons),
            "finite": all(finite(vertex.co) for vertex in obj.data.vertices) and finite(obj.matrix_world[0])
                      and finite(obj.matrix_world[1]) and finite(obj.matrix_world[2]) and finite(obj.matrix_world[3]),
            "weightedVertices": weighted,
            "invalidWeightVertices": invalid_weights,
            "armatures": armatures,
            "parentBone": obj.parent_bone if obj.parent_type == "BONE" else None,
            "uvLayers": len(obj.data.uv_layers),
            "materialSlots": len(obj.material_slots),
        })
    actions = []
    for action in bpy.data.actions:
        curves = []
        # Blender 4.4+ layered actions and older legacy actions are both supported.
        if hasattr(action, "fcurves"):
            curves.extend(action.fcurves)
        for layer in getattr(action, "layers", []):
            for strip in layer.strips:
                for bag in getattr(strip, "channelbags", []):
                    curves.extend(bag.fcurves)
        curves = list({id(curve): curve for curve in curves}.values())
        actions.append({"name": action.name,
                        "channels": len(curves),
                        "keyframes": sum(len(curve.keyframe_points) for curve in curves),
                        "poseChannels": sum(1 for curve in curves if "pose.bones[" in curve.data_path),
                        "varyingChannels": sum(1 for curve in curves if len({round(float(key.co.y), 6) for key in curve.keyframe_points}) > 1)})
    missing = []
    for image in bpy.data.images:
        if image.source == "FILE" and image.filepath and not image.packed_file:
            import os
            if not os.path.isfile(bpy.path.abspath(image.filepath)):
                missing.append(image.name)
    return {"schemaVersion": 1, "blenderVersion": bpy.app.version_string,
            "objects": objects, "rigs": rigs, "actions": actions,
            "missingImages": missing, "fps": bpy.context.scene.render.fps,
            "frameStart": bpy.context.scene.frame_start, "frameEnd": bpy.context.scene.frame_end}


args = sys.argv[sys.argv.index("--") + 1:]
if len(args) != 1:
    raise RuntimeError("Expected one host-owned inspection output path")
with open(args[0], "w", encoding="utf-8") as stream:
    json.dump(inspect(), stream, ensure_ascii=False, indent=2)
