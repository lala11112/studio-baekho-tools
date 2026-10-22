"""Private Blender reconstruction contract tests; no production/provider calls."""
import copy
import pathlib
import sys
import bpy

folder = pathlib.Path(sys.argv[sys.argv.index('--') + 1])
helpers = pathlib.Path(sys.argv[sys.argv.index('--') + 2])
sys.dont_write_bytecode = True
sys.path.insert(0, str(helpers))
import graphics_contact as c
import graphics_contact_reconstruct as r

folder.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
material = bpy.data.materials.new('Original'); material.use_nodes = True
for part in ('head', 'hair'):
    verts = [(0 if part == 'head' else .01, col / 10, row / 10) for row in range(11) for col in range(11)]
    faces = [(row * 11 + col, row * 11 + col + 1, (row + 1) * 11 + col + 1, (row + 1) * 11 + col) for row in range(10) for col in range(10)]
    mesh = bpy.data.meshes.new(part); mesh.from_pydata(verts, [], faces); mesh.update()
    mesh.uv_layers.new(name='OriginalUV')
    mesh.attributes.new(name='stable_vertex', type='INT', domain='POINT')
    for index, value in enumerate(mesh.attributes['stable_vertex'].data): value.value = index
    obj = bpy.data.objects.new(part, mesh); bpy.context.scene.collection.objects.link(obj)
    obj['partsmith_id'] = 'mesh-' + part; obj['partsmith_part_id'] = part; mesh.materials.append(material)
bpy.ops.mesh.primitive_cube_add(size=1, location=(3, 0, 0))
obj = bpy.context.object; obj.name = 'body'; obj['partsmith_id'] = 'mesh-body'; obj['partsmith_part_id'] = 'body'; obj.data.materials.append(material)
source = folder / 'source.blend'; bpy.ops.wm.save_as_mainfile(filepath=str(source), compress=False)
original = c.exact_contract()
baseline = {'schemaVersion': 1, 'identity': 'local-reconstruction-fixture', 'sourceVersionId': 'whole', 'partVersionIds': ['head', 'body', 'hair'], 'sourceSha256': c.file_hash(source), 'contract': original}
proposal = {'schemaVersion': 1, 'status': 'blocked', 'reason': 'Interior hair shares source outer vertices',
    'sourceVersionId': 'whole', 'partVersionIds': ['head', 'body', 'hair'], 'sourceSha256': c.file_hash(source),
    'camera': {'front': '+X', 'confidence': 'confirmed', 'evidence': 'Synthetic explicit grid orientation'}, 'meshes': []}
for key, mesh in original['exact']['meshes'].items():
    part = original['assembly']['meshes'][key]['partId']; allowed = list(range(11)) if part == 'head' else []
    proposal['meshes'].append({'meshId': key, 'partId': part, 'topologySha256': c.digest(mesh['faces']), 'vertexCount': len(mesh['positions']),
        'certainty': 'confirmed' if part == 'head' else 'uncertain', 'evidence': 'Exact synthetic neck row; other parts are not semantic permission',
        'allowed': {'neck': allowed, 'innerHair': []}, 'protected': {'face': [], 'ears': [], 'hairOuter': [], 'clothing': [], 'other': sorted(set(range(len(mesh['positions']))) - set(allowed))}})
c.save_json(folder / 'baseline.json', baseline); c.save_json(folder / 'proposal.json', proposal)
r.prepare_reconstruction({'sourceBlend': str(source), 'baseline': str(folder / 'baseline.json'), 'proposal': str(folder / 'proposal.json'), 'proposalSha256': c.file_hash(folder / 'proposal.json'), 'report': str(folder / 'scope.json')})
scope = c.load(folder / 'scope.json')
assert scope['allowedVertexCount'] == 132
assert scope['bodyExact'] and not scope['silhouetteExact']
checks = [{'name': 'host derives hair proximity from exact head, reuses confirmed neck only', 'passed': True}]

def reject(name, operation, expected):
    try: operation()
    except RuntimeError as error:
        if expected.lower() not in str(error).lower(): raise
        checks.append({'name': name, 'passed': True, 'rejected': str(error)})
    else: raise AssertionError('Did not reject ' + name)

def append_head_face():
    mesh = bpy.data.objects['head'].data
    original_mesh = c.repair_contract()['meshes']['mesh-head']
    verts = [tuple(v.co) for v in mesh.vertices] + [(0, 0, -.005), (0, .1, -.005)]
    edges = [tuple(e.vertices) for e in mesh.edges] + [(0, 121), (121, 122), (122, 1)]
    faces = [tuple(f.vertices) for f in mesh.polygons] + [(1, 0, 121, 122)]
    mesh.clear_geometry(); mesh.from_pydata(verts, edges, faces); mesh.update()
    # clear_geometry preserves the UV layer definition, extending data with 0.
    if not mesh.uv_layers: mesh.uv_layers.new(name='OriginalUV')
    if 'stable_vertex' not in mesh.attributes: mesh.attributes.new(name='stable_vertex', type='INT', domain='POINT')
    for index, value in enumerate(mesh.attributes['stable_vertex'].data): value.value = index
    for i, uv in enumerate(original_mesh['uv'][0][1]): mesh.uv_layers[0].data[i].uv = uv

c.open_scene(source)
bpy.data.objects['head'].data.vertices[0].co.z -= .001
bpy.data.objects['hair'].data.vertices[60].co.x += .001
append_head_face()
authored = folder / 'reconstructed.blend'; bpy.ops.wm.save_as_mainfile(filepath=str(authored), compress=False)
actual = c.exact_contract(); proof = r.validate_reconstruction(original, actual, scope)
assert proof['movedVertices'] == 2 and proof['addedVertices'] == 2 and proof['addedFaces'] == 1
checks.append({'name': 'localized added neck face and small near-head hair movement pass', 'passed': True})

def bad(name, mutate, expected):
    c.open_scene(authored); mutate()
    reject(name, lambda: r.validate_reconstruction(original, c.exact_contract(), scope), expected)

bad('face vertex cannot move', lambda: setattr(bpy.data.objects['head'].data.vertices[60].co, 'x', .001), 'protected')
bad('body clothing exact', lambda: setattr(bpy.data.objects['body'].data.vertices[0].co, 'x', .45), 'body')
bad('hair displacement bound', lambda: setattr(bpy.data.objects['hair'].data.vertices[60].co, 'x', .5), 'displacement')
bad('source UV prefix exact', lambda: setattr(bpy.data.objects['head'].data.uv_layers[0].data[0].uv, 'x', .1), 'UV')
bad('source stable vertex ID exact', lambda: setattr(bpy.data.objects['head'].data.attributes['stable_vertex'].data[1], 'value', 99), 'attribute')
bad('original face winding exact', lambda: setattr(bpy.data.objects['head'].data.loops[0], 'vertex_index', 1), 'topology')
bad('new vertex cannot bridge through skull', lambda: setattr(bpy.data.objects['head'].data.vertices[121].co, 'z', .5), 'bounds')
bad('transform exact', lambda: setattr(bpy.data.objects['hair'].location, 'x', .001), 'transforms')
bad('part ID exact', lambda: bpy.data.objects['hair'].__setitem__('partsmith_part_id', 'head'), 'identities')
bad('material exact', lambda: setattr(bpy.data.materials['Original'], 'diffuse_color', (.1, .2, .3, 1)), 'materials')

changed = copy.deepcopy(actual)
changed['exact']['meshes']['mesh-head']['faces'].append([0, 1, 60])
reject('new face cannot touch protected original vertex', lambda: r.validate_added(original['exact']['meshes']['mesh-head'], changed['exact']['meshes']['mesh-head'], original['assembly']['meshes']['mesh-head']['worldPositions'], actual['assembly']['meshes']['mesh-head']['worldPositions'], next(m for m in scope['meshes'] if m['partId'] == 'head')), 'protected')
changed = copy.deepcopy(proposal); changed['meshes'][0]['topologySha256'] = 'stale'
reject('stale diagnostic is not reconstruction permission', lambda: r.build_scope(baseline, changed, 'x'), 'topology')
changed = copy.deepcopy(proposal)
next(m for m in changed['meshes'] if m['partId'] == 'head')['certainty'] = 'uncertain'
reject('uncertain head semantics remain blocked', lambda: r.build_scope(baseline, changed, 'x'), 'confirmed')

# Saved authored result exports with true polygon prefixes and native part IDs.
c.repair({'mode': 'reconstruct', 'identity': 'reconstruction-fixture-export', 'sourceBlend': str(source), 'baseline': str(folder / 'baseline.json'),
    'regions': str(folder / 'scope.json'), 'regionsSha256': c.file_hash(folder / 'scope.json'), 'outputBlend': str(authored), 'output': str(folder / 'export'), 'report': str(folder / 'export/report.json')})
report = c.load(folder / 'export/report.json')
assert report['phase'] == 'reconstruct' and report['modifiedUVRequiresReview'] and len(report['nativePartExports']) == 3
assert report['checks']['bodyExact'] and len(report['afterViews']) == len(report['views'])
assert c.file_hash(source) == baseline['sourceSha256']
checks.append({'name': 'same-camera review and native FBX part export preserve source and new polygon IDs', 'passed': True})
c.save_json(folder / 'result.json', {'passed': True, 'count': len(checks), 'checks': checks, 'actualBlender': bpy.app.version_string, 'productionCalls': 0})
