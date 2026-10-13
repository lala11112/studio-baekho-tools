"""Local-only, hash-bound preparation/preflight of one generated static part.

Import only private FBX copies. Preparation adds app identity properties without
changing source geometry, UVs or materials; preflight creates only a receipt.
"""
import bpy
import hashlib
import json
import math
import pathlib
import sys
import numpy as np

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from tripo_part_preservation import (
    file_hash, digest, import_fbx, mesh_snapshot, material_snapshot, similarity,
)
from graphics_glb import export_packed_glb


def inspect(q):
    source_path, output = pathlib.Path(q['source']).resolve(), pathlib.Path(q['output']).resolve()
    if q['mode'] not in ('prepare', 'preflight') or source_path.suffix.lower() != '.fbx':
        raise RuntimeError('Native part preparation requires FBX and an explicit supported mode')
    if file_hash(source_path) != q['sourceSha256']:
        raise RuntimeError('Source FBX hash differs from the frozen request')
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise RuntimeError('Part preparation never overwrites existing outputs')
    obj = import_fbx(source_path)
    source, materials = mesh_snapshot(obj), material_snapshot()
    # The same nondegenerate full-rank contract used after SmartUV must pass
    # before submission. No future provider correspondence is claimed here.
    similarity(source, source)
    for face in obj.data.polygons:
        if len(set(face.vertices)) != len(face.vertices) or not math.isfinite(face.area) or face.area <= 0:
            raise RuntimeError('Native part contains a non-finite or degenerate polygon')
    part_id = q['slot'][len('part-'):]
    if not part_id or q['slot'] != 'part-' + part_id:
        raise RuntimeError('Exact part slot is required')
    prior_object_id = obj.get('partsmith_object_id')
    if prior_object_id is not None and prior_object_id != q['objectId']:
        raise RuntimeError('Native part belongs to a different object')
    if q['mode'] == 'prepare':
        expected = {'partsmith_id': q['stableMeshId'], 'partsmith_part_id': part_id,
                    'partsmith_object_id': q['objectId'], 'partsmith_source_sha256': q['sourceSha256']}
        for key, value in expected.items():
            if key in obj and obj[key] != value:
                raise RuntimeError('Native part already has conflicting stable identity; refusing to rebind it')
            obj[key] = value
    else:
        if not isinstance(source['stableId'], str) or not source['stableId'].strip() or source['partId'] != part_id:
            raise RuntimeError('UV preflight requires an existing stable mesh ID and the exact part ID')
        origin_hash = obj.get('partsmith_source_sha256')
        if prior_object_id is not None or origin_hash is not None:
            if (prior_object_id != q['objectId'] or not isinstance(origin_hash, str) or len(origin_hash) != 64
                    or any(c not in '0123456789abcdef' for c in origin_hash)):
                raise RuntimeError('Native part has incomplete object/source identity binding')
            binding = json.dumps({'objectId': q['objectId'], 'slot': q['slot'], 'sourceSha256': origin_hash}, ensure_ascii=False, separators=(',', ':'))
            bound_id = 'partsmith-' + hashlib.sha256(binding.encode('utf8')).hexdigest()[:32]
            if source['stableId'] != bound_id:
                raise RuntimeError('Native part stable ID does not match its object/part/source hash binding')
    current = mesh_snapshot(obj)
    obj.data.calc_loop_triangles()
    triangle_count = len(obj.data.loop_triangles)
    unchanged = all(source[key] == current[key] for key in (
        'positions', 'world', 'matrix', 'polygons', 'edges', 'smooth',
        'customNormals', 'normals', 'name', 'meshName', 'materialSlots', 'faceMaterials', 'uv'))
    checks = {'staticOnly': True, 'finiteNondegenerateGeometry': True, 'sourceGeometry': unchanged,
              'sourceUV': current['uv'] == source['uv'], 'sourceMaterials': material_snapshot() == materials,
              'stablePartIdentity': current['partId'] == part_id and isinstance(current['stableId'], str) and bool(current['stableId'].strip()),
              'selfContainedTextures': True, 'restorationCompatible': True}
    if not all(checks.values()):
        raise RuntimeError('Native part identity preparation changed source contents')
    report = {'schemaVersion': 1, 'mode': q['mode'], 'identity': q['identity'], 'sourceSha256': q['sourceSha256'],
              'sourceVersionId': q['sourceVersionId'], 'objectId': q['objectId'], 'slot': q['slot'],
              'validatorFingerprint': q['validatorFingerprint'], 'passed': True, 'checks': checks,
              'blenderVersion': bpy.app.version_string, 'stableMeshId': current['stableId'], 'partId': part_id,
              'vertices': len(source['positions']), 'faces': len(source['polygons']), 'triangles': triangle_count,
              'polygonSizes': {str(size): sum(len(face) == size for face in source['polygons']) for size in sorted(set(map(len, source['polygons'])))},
              'sourcePositionsSha256': digest(source['positions']), 'preparedPositionsSha256': digest(current['positions']),
              'sourceUvSha256': digest(source['uv']), 'preparedUvSha256': digest(current['uv']),
              'sourceMaterialsSha256': digest(materials), 'textures': materials['textures'],
              'limitations': ['This preflight cannot guarantee that a future provider result preserves indexed topology or a uniform transform.',
                              'Only one static unparented mesh with self-contained textures and nondegenerate three-dimensional geometry is supported.',
                              'UV layout quality, anatomy and self-intersection are not evaluated.']}
    if q['mode'] == 'prepare':
        bpy.ops.object.select_all(action='DESELECT'); obj.select_set(True); bpy.context.view_layer.objects.active = obj
        bpy.ops.wm.save_as_mainfile(filepath=str(output / 'asset.blend'), compress=False)
        bpy.ops.export_scene.fbx(filepath=str(output / 'asset.fbx'), use_selection=True, object_types={'MESH'},
            axis_forward='-Z', axis_up='Y', apply_unit_scale=True, apply_scale_options='FBX_SCALE_UNITS',
            use_mesh_modifiers=False, use_triangles=False, use_custom_props=True, add_leaf_bones=False,
            bake_anim=False, path_mode='COPY', embed_textures=True)
        report['glbImages'] = export_packed_glb(output / 'asset.glb', use_selection=True, use_active_scene=True, export_animations=False, export_extras=True)
        after = mesh_snapshot(obj)
        if after != current or material_snapshot() != materials:
            raise RuntimeError('Native export altered prepared geometry, UV or materials')
        fbx = mesh_snapshot(import_fbx(output / 'asset.fbx'))
        delta = max(math.dist(a, b) for a, b in zip(source['world'], fbx['world'])) if len(source['world']) == len(fbx['world']) else float('inf')
        values = np.array(source['world']); tolerance = max(float(np.linalg.norm(values.max(axis=0) - values.min(axis=0))) * 2e-6, 1e-7)
        if (fbx['polygons'] != source['polygons'] or fbx['edges'] != source['edges'] or delta > tolerance
                or fbx['uv'] != source['uv'] or fbx['stableId'] != q['stableMeshId'] or fbx['partId'] != part_id
                or fbx['faceMaterials'] != source['faceMaterials'] or bpy.context.scene.objects[0].get('partsmith_object_id') != q['objectId']
                or bpy.context.scene.objects[0].get('partsmith_source_sha256') != q['sourceSha256']):
            raise RuntimeError('Prepared native FBX failed topology, placement, UV, material-assignment or stable identity roundtrip')
        original_textures = sorted((item['sha256'], item['colorSpace'], item['size']) for item in materials['textures'])
        exported_textures = sorted((item['sha256'], item['colorSpace'], item['size']) for item in material_snapshot()['textures'])
        if original_textures != exported_textures:
            raise RuntimeError('Prepared native FBX changed original embedded texture content')
        report.update({'fbxRoundTripMaxWorldDeviation': delta, 'fbxRoundTripTolerance': tolerance,
                       'nativeSourceSha256': file_hash(output / 'asset.fbx'),
                       'files': ['asset.blend', 'asset.fbx', 'asset.glb', 'report.json']})
    else:
        report['files'] = ['report.json']
    if file_hash(source_path) != q['sourceSha256']:
        raise RuntimeError('Immutable source FBX changed during local preparation')
    with pathlib.Path(q['report']).open('x', encoding='utf8') as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2, allow_nan=False)


if __name__ == '__main__':
    inspect(json.loads(pathlib.Path(sys.argv[sys.argv.index('--') + 1]).read_text(encoding='utf-8-sig')))
