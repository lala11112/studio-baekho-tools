"""Import real downloaded FBX files without editing geometry; create viewport derivatives.

This is file/mesh inspection, not Astra refinement, rigging, UV creation or animation.
Run with Blender --background --factory-startup --python this.py -- job-directory.
"""
import bpy
import hashlib
import json
import os
import sys
from mathutils import Vector

workspace = os.path.abspath(sys.argv[sys.argv.index('--') + 1])
results = []
for candidate in ('model-1', 'model-2'):
    folder = os.path.join(workspace, 'outputs', candidate)
    source = os.path.join(folder, 'source.fbx')
    digest = hashlib.sha256(open(source, 'rb').read()).hexdigest()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=source, use_image_search=False)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not meshes:
        raise RuntimeError('Downloaded FBX has no mesh: ' + candidate)
    points = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    for obj in meshes:
        obj.data.calc_loop_triangles()
    report = {
        'candidateId': candidate, 'sourceSha256': digest, 'geometryModified': False,
        'meshes': len(meshes), 'vertices': sum(len(o.data.vertices) for o in meshes),
        'polygons': sum(len(o.data.polygons) for o in meshes),
        'quads': sum(len(p.vertices) == 4 for o in meshes for p in o.data.polygons),
        'triangles': sum(len(o.data.loop_triangles) for o in meshes),
        'uvLayers': [len(o.data.uv_layers) for o in meshes],
        'armatures': sum(o.type == 'ARMATURE' for o in bpy.context.scene.objects),
        'textureImages': [i.name for i in bpy.data.images if i.type == 'IMAGE'],
        'dimensions': [max(p[i] for p in points) - min(p[i] for p in points) for i in range(3)],
        'note': 'Native FBX import and preview conversion only. Visual quality requires review.'
    }
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(folder, 'imported.blend'), compress=False)
    bpy.ops.export_scene.gltf(filepath=os.path.join(folder, 'preview.glb'), export_format='GLB', export_animations=False)
    if hashlib.sha256(open(source, 'rb').read()).hexdigest() != digest:
        raise RuntimeError('Native FBX changed')
    with open(os.path.join(folder, 'inspection.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    results.append(report)
print('RABBIT_FBX_INSPECTION ' + json.dumps(results))
