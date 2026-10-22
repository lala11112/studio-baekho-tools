"""Isolated native regression fixture; no provider, worker or production data."""
import copy
import json
import pathlib
import sys
import bpy

folder = pathlib.Path(sys.argv[sys.argv.index('--') + 1])
helpers = pathlib.Path(sys.argv[sys.argv.index('--') + 2])
sys.dont_write_bytecode = True
sys.path.insert(0, str(helpers))
import graphics_contact as c

folder.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
material = bpy.data.materials.new('OriginalMaterial'); material.use_nodes = True
for index, part in enumerate(('head', 'body', 'hair')):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(index * 1.1, 0, 0))
    obj = bpy.context.object; obj.name = 'Original_' + part
    obj['partsmith_id'] = 'mesh-' + part; obj['partsmith_part_id'] = part
    obj.data.materials.append(material)
source = folder / 'source.blend'; bpy.ops.wm.save_as_mainfile(filepath=str(source), compress=False)
source_hash = c.file_hash(source)
original = c.exact_contract()
baseline = {'schemaVersion': 1, 'identity': 'fixture-contact', 'sourceVersionId': 'assembly',
    'partVersionIds': ['head', 'body', 'hair'], 'sourceSha256': source_hash, 'contract': original}
c.save_json(folder / 'baseline.json', baseline)
proposal = {'schemaVersion': 1, 'status': 'ready', 'sourceVersionId': 'assembly', 'partVersionIds': ['head', 'body', 'hair'],
    'sourceSha256': source_hash, 'camera': {'front': '+X', 'confidence': 'confirmed', 'evidence': 'Synthetic test axis, not human anatomy'}, 'meshes': []}
for key, mesh in original['exact']['meshes'].items():
    part = original['assembly']['meshes'][key]['partId']
    proposal['meshes'].append({'meshId': key, 'partId': part, 'topologySha256': c.digest(mesh['faces']),
        'vertexCount': len(mesh['positions']), 'certainty': 'confirmed', 'evidence': 'Synthetic controlled one-vertex fixture',
        'allowed': {'neck': [0] if part != 'hair' else [], 'innerHair': [0] if part == 'hair' else []},
        'protected': {'face': [], 'ears': [], 'hairOuter': [], 'clothing': [], 'other': list(range(1, len(mesh['positions'])))}})
regions = c.validate_proposal(proposal, baseline)
c.save_json(folder / 'proposal.json', proposal); c.save_json(folder / 'regions.json', regions)
checks = []

def reject(label, operation, expected):
    try: operation()
    except RuntimeError as error:
        if expected.lower() not in str(error).lower(): raise
        checks.append({'name': label, 'passed': True, 'rejected': str(error)})
    else: raise AssertionError('Expected rejection: ' + label)

def bad_proposal(label, mutation, expected):
    changed = copy.deepcopy(proposal); mutation(changed)
    reject(label, lambda: c.validate_proposal(changed, baseline), expected)

bad_proposal('stale native hash', lambda p: p.update(sourceSha256='0' * 64), 'hash')
bad_proposal('wrong source version', lambda p: p.update(sourceVersionId='another'), 'versions')
bad_proposal('ambiguous camera blocks', lambda p: p['camera'].update(confidence='uncertain'), 'orientation')
bad_proposal('ambiguous semantic region blocks', lambda p: p['meshes'][0].update(certainty='uncertain'), 'uncertain')
bad_proposal('forged topology mask', lambda p: p['meshes'][0].update(topologySha256='0' * 64), 'topology')
bad_proposal('protected overlap', lambda p: p['meshes'][0]['protected']['face'].append(0), 'overlap')
bad_proposal('unclassified vertex', lambda p: p['meshes'][0]['protected']['other'].pop(), 'every vertex')
bad_proposal('out of range vertex', lambda p: p['meshes'][0]['allowed']['neck'].append(5000), 'exceed')
bad_proposal('invalid part semantic', lambda p: p['meshes'][0]['allowed'].update(neck=[], innerHair=[0]), 'declared part')

c.open_scene(source)
bpy.data.objects['Original_head'].data.vertices[0].co.z += .01
authored = folder / 'corrected.blend'; bpy.ops.wm.save_as_mainfile(filepath=str(authored), compress=False)
actual = c.exact_contract(); proof = c.validate_repair(original, actual, regions)
assert proof['movedVertices'] == 1
checks.append({'name': 'one bounded allowed vertex moves', 'passed': True})

def bad_native(label, mutate, expected):
    c.open_scene(authored); mutate()
    reject(label, lambda: c.validate_repair(original, c.exact_contract(), regions), expected)

bad_native('protected vertex exact', lambda: setattr(bpy.data.objects['Original_head'].data.vertices[1].co, 'x', .500001), 'protected vertex')
bad_native('object transform exact', lambda: setattr(bpy.data.objects['Original_head'].location, 'y', .02), 'transforms')
bad_native('UV exact', lambda: setattr(bpy.data.objects['Original_head'].data.uv_layers[0].data[0].uv, 'x', .123), 'UV')
bad_native('material exact below old rounding', lambda: setattr(bpy.data.materials['OriginalMaterial'], 'diffuse_color', (.8, .8, .8, .50000001)), 'materials')
bad_native('part ID exact', lambda: bpy.data.objects['Original_head'].__setitem__('partsmith_part_id', 'hair'), 'IDs')
def change_topology():
    mesh = bpy.data.objects['Original_head'].data
    mesh.clear_geometry(); mesh.from_pydata([(0,0,0), (1,0,0), (0,1,0)], [], [(0,1,2)])
bad_native('new geometry rejected', change_topology, 'topology')
bad_native('large allowed move rejected', lambda: setattr(bpy.data.objects['Original_head'].data.vertices[0].co, 'z', 3), 'bound')
bad_native('new modifier rejected', lambda: bpy.data.objects['Original_head'].modifiers.new('NotAllowed', 'SUBSURF'), 'modifiers')
forged = copy.deepcopy(regions); forged['baselineContractSha256'] = 'f' * 64
reject('mask baseline binding', lambda: c.validate_repair(original, actual, forged), 'baseline')

analysis_out = folder / 'analysis'; analysis_out.mkdir()
c.analyze({'identity': 'fixture-contact', 'sourceBlend': str(source), 'baseline': str(folder / 'baseline.json'),
    'proposal': str(folder / 'proposal.json'), 'regions': str(analysis_out / 'regions.json'), 'output': str(analysis_out), 'report': str(analysis_out / 'report.json')})
analysis = c.load(analysis_out / 'report.json'); assert analysis['status'] == 'ready'
assert len(analysis['views']) == 10 and len(analysis['overlays']) == 10
checks.append({'name': 'confirmed +X front, hair-hidden neck and inner-hair masked views', 'passed': True})

out = folder / 'export'; out.mkdir()
c.repair({'identity': 'fixture-contact-repair', 'sourceBlend': str(source), 'baseline': str(folder / 'baseline.json'),
    'regions': str(analysis_out / 'regions.json'), 'regionsSha256': c.file_hash(analysis_out / 'regions.json'),
    'outputBlend': str(authored), 'output': str(out), 'report': str(out / 'report.json')})
report = c.load(out / 'report.json')
assert report['passed'] and len(report['candidates']) == 3 and len(report['nativePartExports']) == 3
assert len(report['views']) == 10 and len(report['afterViews']) == 10
assert report['visualQualityVerified'] is False
assert c.file_hash(source) == source_hash
checks.append({'name': 'native FBX/BLEND parts roundtrip and same framing before-after', 'passed': True})
c.save_json(folder / 'result.json', {'passed': True, 'checks': checks, 'count': len(checks),
    'actualBlender': bpy.app.version_string, 'sourceSha256': source_hash, 'productionCalls': 0})
