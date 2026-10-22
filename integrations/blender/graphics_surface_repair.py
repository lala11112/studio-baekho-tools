"""Local derivative: explicitly reuse an existing planar material patch on added UV-less faces.

This is deliberate shared UV/texture reuse, not a unique unwrap or new texture.
Only exact append-only repair ancestry and static native FBX are supported.
"""
import bpy
import itertools
import json
import math
import pathlib
import sys
import numpy as np

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from tripo_part_preservation import file_hash, digest, import_fbx, mesh_snapshot, material_snapshot, similarity
from graphics_glb import export_packed_glb


def uv_area(points):
    return abs(sum(points[i][0] * points[(i + 1) % len(points)][1] - points[(i + 1) % len(points)][0] * points[i][1] for i in range(len(points)))) / 2


def convex(points):
    p = np.array(points, dtype=np.float64)
    cross = [float(np.linalg.det(np.stack((p[(i + 1) % len(p)] - p[i], p[(i + 2) % len(p)] - p[(i + 1) % len(p)])))) for i in range(len(p))]
    return min(cross) > 1e-12 or max(cross) < -1e-12


def planar_quad(mesh, face):
    if len(face.vertices) != 4 or len(set(face.vertices)) != 4 or not math.isfinite(face.area) or face.area <= 1e-12:
        return False
    points = np.array([list(mesh.vertices[v].co) for v in face.vertices])
    normal = np.array(face.normal)
    diagonal = float(np.linalg.norm(points.max(axis=0) - points.min(axis=0)))
    axes = [i for i in range(3) if i != int(np.argmax(abs(normal)))]
    return (max(abs((points - points[0]) @ normal)) <= max(diagonal * 1e-4, 1e-8)
            and convex(points[:, axes]))


def one_uv(snapshot):
    layers = snapshot['uv']['layers']
    if len(layers) != 1 or snapshot['uv']['active'] != 0 or layers[0]['render'] is not True:
        raise RuntimeError('Material patch reuse requires one unambiguous active/render UV map')
    return layers[0]['values']


def prefix_lineage(original, repaired):
    count = len(original['polygons'])
    if (len(repaired['positions']) < len(original['positions']) or len(repaired['polygons']) <= count
            or repaired['polygons'][:count] != original['polygons']):
        raise RuntimeError('Repair ancestry is not append-only indexed geometry')
    points = np.array(original['world'])
    tolerance = max(float(np.linalg.norm(points.max(axis=0) - points.min(axis=0))) * 2e-6, 1e-7)
    if max(math.dist(a, b) for a, b in zip(original['world'], repaired['world'])) > tolerance:
        raise RuntimeError('Original geometry moved during repair ancestry')
    if original['faceMaterials'] != repaired['faceMaterials'][:count] or original['materialSlots'] != repaired['materialSlots']:
        raise RuntimeError('Original material assignments changed during repair ancestry')
    original_uv, repaired_uv = one_uv(original), one_uv(repaired)
    if repaired_uv[:len(original_uv)] != original_uv:
        raise RuntimeError('Original UVs changed during repair ancestry')
    if not set(map(tuple, original['edges'])).issubset(set(map(tuple, repaired['edges']))):
        raise RuntimeError('Original edges were removed during repair ancestry')
    return count


def inspect_and_repair(q):
    if q.get('mode') != 'reuse-planar-material':
        raise RuntimeError('Explicit existing-material reuse mode is required')
    inputs = [(key, pathlib.Path(q[key]).resolve()) for key in ('originalSource', 'repairSource', 'source')]
    for key, file in inputs:
        if file.suffix.lower() != '.fbx' or file_hash(file) != q[key + 'Sha256']:
            raise RuntimeError('Immutable native FBX input hash differs from request')
    output = pathlib.Path(q['output']).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise RuntimeError('Existing surface repair files must never be overwritten')
    original = mesh_snapshot(import_fbx(inputs[0][1]))
    repaired = mesh_snapshot(import_fbx(inputs[1][1]))
    original_count = prefix_lineage(original, repaired)
    obj = import_fbx(inputs[2][1]); mesh = obj.data
    source, materials = mesh_snapshot(obj), material_snapshot()
    correspondence = similarity(repaired, source)
    source_uv = one_uv(source); repair_uv = one_uv(repaired)
    if source_uv != repair_uv:
        raise RuntimeError('Textured UVs differ from the exact repaired input; no guessed correspondence is allowed')
    if source['faceMaterials'] != repaired['faceMaterials'] or len(source['materialSlots']) != len(repaired['materialSlots']):
        raise RuntimeError('Textured material assignments differ from repaired input')
    if not materials['textures']:
        raise RuntimeError('Existing embedded texture images are required for local reuse')
    layer = mesh.uv_layers.active.data
    invalid = [face.index for face in mesh.polygons if uv_area([list(layer[l].uv) for l in face.loop_indices]) <= 1e-12]
    if not invalid or len(invalid) > 64 or any(index < original_count for index in invalid):
        raise RuntimeError('Only 1 to 64 newly added degenerate-UV faces may be repaired')
    if any(not planar_quad(mesh, mesh.polygons[i]) for i in invalid):
        raise RuntimeError('Added UV-less faces must be finite planar convex quads')
    for face in mesh.polygons:
        if face.material_index >= len(mesh.materials) or mesh.materials[face.material_index] is None:
            raise RuntimeError('Missing material assignment cannot be repaired by texture reuse')
    mappings = []
    for index in invalid:
        target = mesh.polygons[index]
        candidates = []
        for face in mesh.polygons[:original_count]:
            uv = [list(layer[l].uv) for l in face.loop_indices]
            if (face.material_index == target.material_index and planar_quad(mesh, face)
                    and abs(face.normal.dot(target.normal)) >= .995 and uv_area(uv) > 1e-8
                    and convex(uv) and all(0 <= c <= 1 for pair in uv for c in pair)):
                candidates.append(face)
        if q.get('donorFaceIndex') is not None:
            candidates = [face for face in candidates if face.index == q['donorFaceIndex']]
        if not candidates:
            raise RuntimeError('No compatible existing planar quad material patch is available')
        donor = sorted(candidates, key=lambda face: (-face.area, face.index))[0]
        axes = [i for i in range(3) if i != int(np.argmax(abs(np.array(target.normal))))]
        def projected(face):
            points = np.array([list(mesh.vertices[v].co) for v in face.vertices])[:, axes]
            extent = points.max(axis=0) - points.min(axis=0)
            if min(extent) <= 1e-10:
                raise RuntimeError('Material patch projection is degenerate')
            return (points - points.min(axis=0)) / extent
        target_plane, donor_plane = projected(target), projected(donor)
        orders = [list(range(shift, 4)) + list(range(shift)) for shift in range(4)]
        orders += [list(reversed(order)) for order in orders]
        order = min(orders, key=lambda order: (float(np.sum((target_plane - donor_plane[order]) ** 2)), order))
        values = [list(layer[donor.loop_indices[i]].uv) for i in order]
        for loop, value in zip(target.loop_indices, values):
            layer[loop].uv = value
        mappings.append({'faceIndex': index, 'donorFaceIndex': donor.index, 'materialIndex': target.material_index,
                         'uv': values, 'donorArea': donor.area, 'targetArea': target.area,
                         'sharedUvIntentional': True, 'uvArea': uv_area(values)})
    current = mesh_snapshot(obj)
    original_loops = sum(map(len, original['polygons']))
    changed_loops = {loop for i in invalid for loop in mesh.polygons[i].loop_indices}
    stable_fields = ('positions', 'world', 'matrix', 'polygons', 'edges', 'smooth', 'customNormals', 'normals',
                     'name', 'meshName', 'stableId', 'partId', 'materialSlots', 'faceMaterials')
    checks = {'staticOnly': True, 'appendOnlyAncestry': True, 'uniformCorrespondence': True,
              'geometryPreserved': all(source[k] == current[k] for k in stable_fields),
              'originalUVPreserved': source_uv[:original_loops] == one_uv(current)[:original_loops],
              'onlyAddedDegenerateUVChanged': all(before == after for i, (before, after) in enumerate(zip(source_uv, one_uv(current))) if i not in changed_loops),
              'materialsAndImagesPreserved': materials == material_snapshot(),
              'allFacesHaveUV': all(uv_area([list(layer[l].uv) for l in face.loop_indices]) > 1e-12 for face in mesh.polygons)}
    if not all(checks.values()):
        raise RuntimeError('Local surface preservation checks failed')
    bpy.ops.object.select_all(action='DESELECT'); obj.select_set(True); bpy.context.view_layer.objects.active = obj
    bpy.ops.wm.save_as_mainfile(filepath=str(output / 'asset.blend'), compress=False)
    bpy.ops.export_scene.fbx(filepath=str(output / 'asset.fbx'), use_selection=True, object_types={'MESH'},
        axis_forward='-Z', axis_up='Y', apply_unit_scale=True, apply_scale_options='FBX_SCALE_UNITS',
        use_mesh_modifiers=False, use_triangles=False, use_custom_props=True, add_leaf_bones=False,
        bake_anim=False, path_mode='COPY', embed_textures=True)
    glb_images = export_packed_glb(output / 'asset.glb', use_selection=True, use_active_scene=True, export_animations=False, export_extras=True)
    if current != mesh_snapshot(obj) or materials != material_snapshot():
        raise RuntimeError('Export altered repaired model or retained texture content')
    fbx = mesh_snapshot(import_fbx(output / 'asset.fbx'))
    points = np.array(source['world']); tolerance = max(float(np.linalg.norm(points.max(axis=0) - points.min(axis=0))) * 2e-6, 1e-7)
    delta = max(math.dist(a, b) for a, b in zip(source['world'], fbx['world'])) if len(source['world']) == len(fbx['world']) else float('inf')
    if (fbx['polygons'] != current['polygons'] or fbx['edges'] != current['edges'] or delta > tolerance
            or fbx['uv'] != current['uv'] or fbx['faceMaterials'] != current['faceMaterials']
            or fbx['stableId'] != current['stableId'] or fbx['partId'] != current['partId']):
        raise RuntimeError('FBX roundtrip lost repaired UV, geometry, assignment or identity')
    texture_key = lambda item: (item['sha256'], item['colorSpace'], item['size'])
    if sorted(map(texture_key, materials['textures'])) != sorted(map(texture_key, material_snapshot()['textures'])):
        raise RuntimeError('FBX roundtrip changed original embedded texture bytes')
    for key, file in inputs:
        if file_hash(file) != q[key + 'Sha256']:
            raise RuntimeError('Immutable input changed during local repair')
    checks['fbxRoundTrip'] = True
    report = {key: q[key] for key in ('identity', 'mode', 'sourceSha256', 'sourceVersionId', 'repairSourceSha256', 'repairVersionId', 'originalSourceSha256', 'originalVersionId', 'validatorFingerprint')}
    report.update({'schemaVersion': 1, 'passed': True, 'checks': checks, 'localOnly': True, 'modelTurns': 0, 'paidSubmissions': 0,
                   'originalFaces': original_count, 'faces': len(current['polygons']), 'repairedFaces': invalid, 'mappings': mappings,
                   'correspondence': correspondence, 'textures': materials['textures'], 'glbImages': glb_images,
                   'sourceOriginalUVSha256': digest(source_uv[:original_loops]), 'resultOriginalUVSha256': digest(one_uv(current)[:original_loops]),
                   'sourceMaterialsSha256': digest(materials), 'fbxRoundTripMaxWorldDeviation': delta, 'fbxRoundTripTolerance': tolerance,
                   'files': ['asset.blend', 'asset.fbx', 'asset.glb', 'report.json'],
                   'warnings': ['기존 평면의 재질 무늬를 복사한 후보입니다. UV를 의도적으로 공유하므로 무늬 반복·늘어짐·경계 색 차이가 남을 수 있습니다.',
                                '새 텍스처 생성이나 독립 UV 펼치기를 수행하지 않았습니다. 외형을 확인하고 채택하세요.'],
                   'visualQualityVerified': False, 'uniqueUvLayout': False})
    with pathlib.Path(q['report']).open('x', encoding='utf8') as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2, allow_nan=False)


if __name__ == '__main__':
    inspect_and_repair(json.loads(pathlib.Path(sys.argv[sys.argv.index('--') + 1]).read_text(encoding='utf-8-sig')))
