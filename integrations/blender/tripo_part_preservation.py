"""Restore a verified SmartUV part to its native source frame, without services.

Both imported FBX files are immutable. Only one static, unparented mesh with
exact indexed polygons and a measured proper uniform similarity is supported.
Provider UVs/materials are kept; source coordinates, placement and IDs win.
"""
import bpy
import hashlib
import json
import math
import pathlib
import sys
import numpy as np
from mathutils import Matrix

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from graphics_glb import export_packed_glb


def file_hash(file):
    return hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def uv_snapshot(mesh):
    result = {'active': mesh.uv_layers.active_index, 'layers': []}
    for layer in mesh.uv_layers:
        values = [[float(c) for c in item.uv] for item in layer.data]
        if not all(math.isfinite(c) for uv in values for c in uv):
            raise RuntimeError('Non-finite provider UV coordinate')
        result['layers'].append({'name': layer.name, 'render': layer.active_render, 'values': values})
    return result


def material_snapshot():
    materials = []
    for material in bpy.data.materials:
        nodes, links = [], []
        if material.use_nodes:
            for node in material.node_tree.nodes:
                inputs = []
                for socket in node.inputs:
                    value = getattr(socket, 'default_value', None)
                    if not isinstance(value, (str, int, float, bool, type(None))):
                        try:
                            value = [float(c) for c in value]
                        except (TypeError, ValueError):
                            value = None
                    inputs.append([socket.identifier, value])
                nodes.append({'name': node.name, 'type': node.bl_idname, 'inputs': inputs,
                    'image': node.image.name if getattr(node, 'image', None) else None,
                    'operation': getattr(node, 'operation', None), 'blendType': getattr(node, 'blend_type', None)})
            links = sorted([link.from_node.name, link.from_socket.identifier, link.to_node.name, link.to_socket.identifier] for link in material.node_tree.links)
        materials.append({'name': material.name, 'diffuse': list(material.diffuse_color), 'nodes': sorted(nodes, key=lambda node: node['name']), 'links': links})
    textures = []
    for image in bpy.data.images:
        if image.source == 'VIEWER':
            continue
        if image.source != 'FILE' or not image.packed_file or min(image.size) < 1:
            raise RuntimeError('Provider textures must be valid packed original files')
        textures.append({'name': image.name, 'size': list(image.size), 'sha256': hashlib.sha256(bytes(image.packed_file.data)).hexdigest(), 'colorSpace': image.colorspace_settings.name})
    return {'materials': sorted(materials, key=lambda value: value['name']), 'textures': sorted(textures, key=lambda value: value['name'])}


def static_mesh():
    objects = list(bpy.context.scene.objects)
    if len(objects) != 1 or objects[0].type != 'MESH' or len(bpy.data.objects) != 1 or len(bpy.data.scenes) != 1:
        raise RuntimeError('Part restoration supports exactly one static mesh; multi-mesh, rig and unrelated objects are unsupported')
    obj = objects[0]
    if obj.parent or obj.modifiers or obj.constraints or obj.data.shape_keys or bpy.data.armatures or bpy.data.libraries:
        raise RuntimeError('Part restoration rejects rigs, morphs, modifiers, parenting and linked dependencies')
    for owner in bpy.data.user_map():
        if getattr(owner, 'animation_data', None):
            raise RuntimeError('Part restoration rejects dynamic animation/driver dependencies')
    if bpy.data.actions:
        raise RuntimeError('Part restoration rejects animation actions')
    return obj


def import_fbx(file):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=str(file), use_image_search=False)
    obj = static_mesh()
    root = pathlib.Path(file).resolve().parent
    for image in bpy.data.images:
        if image.source != 'FILE':
            raise RuntimeError('Unsupported provider image source')
        if not image.packed_file:
            image_file = pathlib.Path(bpy.path.abspath(image.filepath)).resolve()
            if not image_file.is_relative_to(root) or not image_file.is_file():
                raise RuntimeError('External or missing FBX texture is unsupported; provide self-contained native FBX')
            image.pack()
    return obj


def mesh_snapshot(obj):
    mesh = obj.data
    positions = [[float(c) for c in vertex.co] for vertex in mesh.vertices]
    world = [[float(c) for c in obj.matrix_world @ vertex.co] for vertex in mesh.vertices]
    matrix = [[float(c) for c in row] for row in obj.matrix_world]
    if len(positions) < 4 or not mesh.polygons or not all(math.isfinite(c) for point in positions + world + matrix for c in point):
        raise RuntimeError('Missing or non-finite native geometry/transform')
    return {'positions': positions, 'world': world, 'matrix': matrix, 'polygons': [list(face.vertices) for face in mesh.polygons],
        'edges': sorted(sorted(edge.vertices) for edge in mesh.edges), 'smooth': [face.use_smooth for face in mesh.polygons],
        'customNormals': mesh.has_custom_normals, 'normals': [[float(c) for c in item.vector] for item in mesh.corner_normals],
        'name': obj.name, 'meshName': mesh.name, 'stableId': obj.get('partsmith_id'), 'partId': obj.get('partsmith_part_id'),
        'materialSlots': [slot.material.name if slot.material else None for slot in obj.material_slots],
        'faceMaterials': [face.material_index for face in mesh.polygons], 'uv': uv_snapshot(mesh)}


def similarity(source, provider):
    if len(source['positions']) != len(provider['positions']) or source['polygons'] != provider['polygons'] or source['edges'] != provider['edges']:
        raise RuntimeError('Exact indexed topology differs; reordering, remeshing, loose-edge changes and correspondence guessing are unsupported')
    x, y = np.array(source['world'], dtype=np.float64), np.array(provider['world'], dtype=np.float64)
    xc, yc = x - x.mean(axis=0), y - y.mean(axis=0)
    if np.linalg.matrix_rank(xc, tol=max(float(np.linalg.norm(xc)) * 1e-10, 1e-12)) != 3:
        raise RuntimeError('Uniform correspondence requires a nondegenerate three-dimensional source')
    u, singular, vt = np.linalg.svd(xc.T @ yc)
    rotation = u @ vt
    if np.linalg.det(rotation) < 0:
        u[:, -1] *= -1
        rotation = u @ vt
    scale = float(np.sum((xc @ rotation) * yc) / np.sum(xc * xc))
    translation = y.mean(axis=0) - scale * (x.mean(axis=0) @ rotation)
    residual = np.linalg.norm(y - (scale * (x @ rotation) + translation), axis=1)
    diagonal = float(np.linalg.norm(y.max(axis=0) - y.min(axis=0)))
    tolerance = max(diagonal * 2e-6, 1e-7)
    if not math.isfinite(scale) or not 1e-8 <= scale <= 1e8 or float(residual.max()) > tolerance:
        raise RuntimeError('Provider geometry is not the original under a proper uniform transform; refusing nonuniform scale, shape edits or reflection')
    return {'uniformScale': scale, 'rowVectorRotation': rotation.tolist(), 'translation': translation.tolist(),
        'maxResidual': float(residual.max()), 'rmsResidual': float(np.sqrt(np.mean(residual * residual))), 'toleranceProviderUnits': tolerance}


def restore(q):
    source_path, provider_path, output = (pathlib.Path(q[key]).resolve() for key in ('source', 'provider', 'output'))
    if source_path == provider_path or source_path.suffix.lower() != '.fbx' or provider_path.suffix.lower() != '.fbx':
        raise RuntimeError('Two separate native FBX inputs are required')
    if file_hash(source_path) != q['sourceSha256'] or file_hash(provider_path) != q['providerSha256']:
        raise RuntimeError('Input FBX hashes do not match the immutable request')
    output.mkdir(parents=True, exist_ok=True)
    if any((output / name).exists() for name in ('asset.blend', 'asset.fbx', 'asset.glb', 'report.json')):
        raise RuntimeError('Existing native derivatives must not be overwritten')
    source = mesh_snapshot(import_fbx(source_path))
    if not isinstance(source['stableId'], str) or not source['stableId'] or not isinstance(source['partId'], str) or q['slot'] != 'part-' + source['partId']:
        raise RuntimeError('Source FBX must carry its exact stable mesh ID and the requested part ID')
    obj = import_fbx(provider_path)
    provider = mesh_snapshot(obj)
    if not provider['uv']['layers']:
        raise RuntimeError('Provider result has no actual UV layer')
    correspondence = similarity(source, provider)
    provider_materials = material_snapshot()
    for vertex, position in zip(obj.data.vertices, source['positions']):
        vertex.co = position
    obj.matrix_world = Matrix(source['matrix'])
    obj.name = source['name']
    obj['partsmith_id'], obj['partsmith_part_id'] = source['stableId'], source['partId']
    for face, smooth in zip(obj.data.polygons, source['smooth']):
        face.use_smooth = smooth
    obj.data.update()
    if source['customNormals']:
        obj.data.normals_split_custom_set(source['normals'])
    bpy.context.view_layer.update()
    restored = mesh_snapshot(static_mesh())
    checks = {'indexedTopology': source['polygons'] == restored['polygons'] and source['edges'] == restored['edges'],
        'uniformCorrespondence': True, 'sourcePlacement': source['positions'] == restored['positions'] and source['matrix'] == restored['matrix'],
        'sourceStableIds': restored['stableId'] == source['stableId'] and restored['partId'] == source['partId'],
        'providerUV': restored['uv'] == provider['uv'],
        'providerMaterials': restored['materialSlots'] == provider['materialSlots'] and restored['faceMaterials'] == provider['faceMaterials'] and material_snapshot() == provider_materials,
        'staticOnly': True}
    if not all(checks.values()):
        raise RuntimeError('Native restoration failed its source/provider preservation checks')
    bpy.ops.object.select_all(action='DESELECT');obj.select_set(True);bpy.context.view_layer.objects.active = obj
    bpy.ops.wm.save_as_mainfile(filepath=str(output / 'asset.blend'), compress=False)
    bpy.ops.export_scene.fbx(filepath=str(output / 'asset.fbx'), use_selection=True, object_types={'MESH'},
        axis_forward='-Z', axis_up='Y', apply_unit_scale=True, apply_scale_options='FBX_SCALE_UNITS',
        use_mesh_modifiers=False, use_triangles=False, use_custom_props=True, add_leaf_bones=False,
        bake_anim=False, path_mode='COPY', embed_textures=True)
    glb_images = export_packed_glb(output / 'asset.glb', use_selection=True, use_active_scene=True, export_animations=False, export_extras=True)
    if uv_snapshot(obj.data) != provider['uv'] or material_snapshot() != provider_materials:
        raise RuntimeError('Native export changed retained provider UV/materials')
    # Independently reopen the actual exported FBX. The editable BLEND retains
    # exact provider nodes and UVs; FBX must retain native polygons and placement.
    fbx = mesh_snapshot(import_fbx(output / 'asset.fbx'))
    deviation = max(math.dist(a, b) for a, b in zip(source['world'], fbx['world'])) if len(source['world']) == len(fbx['world']) else float('inf')
    source_diagonal = float(np.linalg.norm(np.array(source['world']).max(axis=0) - np.array(source['world']).min(axis=0)))
    export_tolerance = max(source_diagonal * 2e-6, 1e-7)
    if fbx['polygons'] != source['polygons'] or deviation > export_tolerance or fbx['uv'] != provider['uv'] or fbx['stableId'] != source['stableId'] or fbx['partId'] != source['partId'] or fbx['faceMaterials'] != provider['faceMaterials']:
        raise RuntimeError('Reimported native FBX failed polygon, placement, ID, UV or material-assignment preservation')
    if file_hash(source_path) != q['sourceSha256'] or file_hash(provider_path) != q['providerSha256']:
        raise RuntimeError('Immutable original FBX changed during restoration')
    def bounds(points):
        values = np.array(points)
        return {'min': values.min(axis=0).tolist(), 'max': values.max(axis=0).tolist(), 'dimensions': (values.max(axis=0) - values.min(axis=0)).tolist()}
    report = {'schemaVersion': 1, 'identity': q['identity'], 'sourceSha256': q['sourceSha256'], 'providerSha256': q['providerSha256'],
        'sourceVersionId': q['sourceVersionId'], 'providerJobId': q['providerJobId'], 'slot': q['slot'], 'validatorFingerprint': q['validatorFingerprint'],
        'passed': True, 'checks': checks, 'blenderVersion': bpy.app.version_string,
        'correspondence': correspondence, 'sourceBounds': bounds(source['world']), 'providerBounds': bounds(provider['world']), 'restoredBounds': bounds(restored['world']),
        'sourceStableId': source['stableId'], 'sourcePartId': source['partId'], 'vertices': len(source['positions']), 'faces': len(source['polygons']),
        'polygonSizes': {str(size): sum(len(face) == size for face in source['polygons']) for size in sorted(set(map(len, source['polygons'])))},
        'providerUvSha256': digest(provider['uv']), 'restoredUvSha256': digest(restored['uv']), 'providerMaterialsSha256': digest(provider_materials),
        'sourcePositionsSha256': digest(source['positions']), 'restoredPositionsSha256': digest(restored['positions']),
        'fbxRoundTripMaxWorldDeviation': deviation, 'fbxRoundTripTolerance': export_tolerance, 'glbImages': glb_images,
        'files': ['asset.blend', 'asset.fbx', 'asset.glb', 'report.json'],
        'limitations': ['UV overlap, packing quality, anatomy and self-intersection were not evaluated.', 'The native BLEND preserves provider material nodes; interchange formats use their supported material representation.', 'Only exact indexed single-mesh correspondence under a proper uniform similarity is supported.']}
    with pathlib.Path(q['report']).open('x', encoding='utf8') as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2, allow_nan=False)


if __name__ == '__main__':
    restore(json.loads(pathlib.Path(sys.argv[sys.argv.index('--') + 1]).read_text(encoding='utf-8-sig')))
