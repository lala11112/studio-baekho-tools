"""Read-only native audit of an app-authored contact reconstruction candidate.

Usage in background Blender: -- work_directory report.json helper_directory
The script never saves Blender assets, changes acceptance, or authors geometry.
"""
import hashlib
import json
import math
import pathlib
import sys
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

work = pathlib.Path(sys.argv[sys.argv.index('--') + 1])
report_path = pathlib.Path(sys.argv[sys.argv.index('--') + 2])
helpers = pathlib.Path(sys.argv[sys.argv.index('--') + 3])
sys.dont_write_bytecode = True
sys.path.insert(0, str(helpers))
import graphics_contact as c
import graphics_contact_reconstruct as reconstruct

source = work / 'inputs/1.blend'
candidate = work / 'corrected.blend'
baseline_path = work.parent / 'baseline.json'
scope_path = work.parent / 'reconstruction-scope.json'
files = [source, candidate, baseline_path, scope_path]
if any(not item.is_file() for item in files):
    raise RuntimeError('Existing source, saved candidate, baseline and frozen scope are required; audit never creates them')
if report_path.resolve() in [item.resolve() for item in files]:
    raise RuntimeError('Audit report must not replace any input')

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()

frozen_hashes = {str(item): sha(item) for item in files}
baseline, scope = c.load(baseline_path), c.load(scope_path)
if sha(source) != baseline['sourceSha256']:
    raise RuntimeError('Original source does not match recorded baseline')

def read_native(path):
    bpy.ops.wm.open_mainfile(filepath=str(path), load_ui=False, use_scripts=False)
    bpy.context.view_layer.update()
    objects = {}
    meshes = {}
    for obj in bpy.context.scene.objects:
        objects[obj.name] = {'type': obj.type, 'world': [[float(v) for v in row] for row in obj.matrix_world],
            'parent': obj.parent.name if obj.parent else None, 'partId': obj.get('partsmith_part_id'),
            'meshId': obj.get('partsmith_id'), 'modifiers': [(m.type, m.name) for m in obj.modifiers],
            'constraints': [(item.type, item.name) for item in obj.constraints]}
        if obj.type != 'MESH': continue
        data = obj.data
        meshes[obj['partsmith_id']] = {'partId': obj.get('partsmith_part_id'),
            'local': [tuple(float(v) for v in vertex.co) for vertex in data.vertices],
            'world': [tuple(float(v) for v in obj.matrix_world @ vertex.co) for vertex in data.vertices],
            'faces': [tuple(face.vertices) for face in data.polygons],
            'edges': [tuple(edge.vertices) for edge in data.edges],
            'uv': [(layer.name, layer.active_render, [tuple(float(v) for v in item.uv) for item in layer.data]) for layer in data.uv_layers],
            'materialSlots': [slot.material.name if slot.material else None for slot in obj.material_slots],
            'faceMaterials': [face.material_index for face in data.polygons],
            'smooth': [face.use_smooth for face in data.polygons],
            'stableIds': {name: {'domain': attr.domain, 'type': attr.data_type,
                'values': [item.value for item in attr.data]} for name in ('partsmith_source_vertex', 'partsmith_source_face', 'partsmith_source_corner') if (attr := data.attributes.get(name)) is not None}}
    return {'objects': objects, 'meshes': meshes, 'contract': c.exact_contract()}

before = read_native(source)
if before['contract'] != baseline['contract']:
    raise RuntimeError('Audit original differs from native baseline contract')
after = read_native(candidate)
checks = []

def require(label, expression):
    if not expression: raise RuntimeError('Read-only audit failed: ' + label)
    checks.append({'name': label, 'passed': True})

require('Original objects, stable part IDs, hierarchy and world transforms remain exact', before['objects'] == after['objects'])
require('Original mesh set remains exact', set(before['meshes']) == set(after['meshes']))
by_key = {mask['meshId']: mask for mask in scope['meshes']}
parts = []
for key, old in before['meshes'].items():
    new, mask = after['meshes'][key], by_key[key]
    nv, nf, ne = len(old['local']), len(old['faces']), len(old['edges'])
    allowed = set(mask['allowed']['neck'] + mask['allowed']['innerHair'])
    require(old['partId'] + ': original face and edge order preserved', new['faces'][:nf] == old['faces'] and new['edges'][:ne] == old['edges'])
    require(old['partId'] + ': original material slots and polygon assignments preserved', new['materialSlots'] == old['materialSlots'] and new['faceMaterials'][:nf] == old['faceMaterials'] and new['smooth'][:nf] == old['smooth'])
    require(old['partId'] + ': original UV layers and corners preserved', len(old['uv']) == len(new['uv']) and all(a[0:2] == b[0:2] and a[2] == b[2][:len(a[2])] for a, b in zip(old['uv'], new['uv'])))
    require(old['partId'] + ': original stable vertex/face/corner IDs preserved', set(old['stableIds']) == set(new['stableIds']) and all(value['domain'] == new['stableIds'][name]['domain'] and value['type'] == new['stableIds'][name]['type'] and value['values'] == new['stableIds'][name]['values'][:len(value['values'])] for name, value in old['stableIds'].items()))
    moved = [i for i, point in enumerate(old['local']) if point != new['local'][i]]
    require(old['partId'] + ': every moved original vertex belongs to frozen allowlist', set(moved) <= allowed)
    displacement = [math.dist(old['world'][i], new['world'][i]) for i in moved]
    require(old['partId'] + ': movement stays within frozen bound', max(displacement, default=0) <= mask['maxWorldDisplacement'] + 1e-10)
    if old['partId'] == 'body': require('Body and clothing native contract completely unchanged', before['contract']['exact']['meshes'][key] == after['contract']['exact']['meshes'][key] and old == new)
    new_uv_count = sum(len(layer[2]) - len(old['uv'][i][2]) for i, layer in enumerate(new['uv']))
    new_zero_uv_count = sum(uv == (0.0, 0.0) for i, layer in enumerate(new['uv']) for uv in layer[2][len(old['uv'][i][2]):])
    parts.append({'partId': old['partId'], 'meshId': key, 'originalVertices': nv, 'originalFaces': nf,
        'resultVertices': len(new['local']), 'resultFaces': len(new['faces']), 'addedVertices': len(new['local']) - nv,
        'addedFaces': len(new['faces']) - nf, 'allowedOriginalVertices': len(allowed), 'protectedOriginalVertices': nv - len(allowed),
        'movedOriginalVertices': len(moved), 'maximumWorldDisplacement': max(displacement, default=0),
        'displacementLimit': mask['maxWorldDisplacement'], 'newUvCorners': new_uv_count, 'zeroPlaceholderUvCorners': new_zero_uv_count})

native_proof = reconstruct.validate_reconstruction(before['contract'], after['contract'], scope)
checks.append({'name': 'Full frozen append-only locality, boundary, ID and attribute contract', 'passed': True})

def hair_contact_samples(value):
    head_vertices, head_faces = [], []
    for mesh in value['meshes'].values():
        if mesh['partId'] != 'head': continue
        offset = len(head_vertices); head_vertices.extend(Vector(p) for p in mesh['world'])
        head_faces.extend([index + offset for index in face] for face in mesh['faces'])
    tree = BVHTree.FromPolygons(head_vertices, head_faces, all_triangles=False)
    distances = []
    for key, mesh in value['meshes'].items():
        if mesh['partId'] != 'hair': continue
        for index in by_key[key]['allowed']['innerHair']:
            point = Vector(mesh['world'][index]); hit = tree.find_nearest(point)
            if hit[0] is not None: distances.append(float((point - hit[0]).dot(hit[1])))
    return {'sampleCount': len(distances), 'negativeNearestNormalSamples': sum(v < 0 for v in distances),
        'summedNegativeDistance': sum(max(0.0, -v) for v in distances), 'minimumSignedNearestDistance': min(distances, default=None)}

contact = {'before': hair_contact_samples(before), 'after': hair_contact_samples(after),
    'interpretation': 'Same original permitted hair vertices only. Signed distance uses nearest triangle normal; non-watertight surfaces and large hair faces prevent interpreting this as volumetric collision freedom or anatomical fit.'}
require('Read-only audit leaves all source, candidate and scope bytes unchanged', frozen_hashes == {str(item): sha(item) for item in files})
report = {'schemaVersion': 1, 'passed': True, 'readOnly': True, 'productionCalls': 0, 'actualBlender': bpy.app.version_string,
    'sourceSha256': sha(source), 'candidateSha256': sha(candidate), 'scopeSha256': sha(scope_path),
    'checks': checks, 'parts': parts, 'nativePreservation': native_proof, 'hairContactSamples': contact,
    'visualQualityVerified': False, 'adoptionChanged': False,
    'limitations': ['File preservation is separate from visual acceptance.',
        'Body skin and clothing remain untouched; lower head-neck changes do not prove a seamless body attachment.',
        'Existing hair outside the narrow contact allowlist remains unchanged, so remaining large-face penetration may persist.',
        'Any new UV values are placeholders; no unwrap, texture, rigging or final adoption is included.']}
report_path.parent.mkdir(parents=True, exist_ok=True)
report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print('READONLY_CONTACT_AUDIT', json.dumps({'passed': True, 'checks': len(checks), 'parts': parts, 'hairContactSamples': contact}, ensure_ascii=False))
