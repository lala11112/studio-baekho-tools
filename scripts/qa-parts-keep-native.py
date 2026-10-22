"""Read-only independent comparison of actual app-produced multipart BLEND files."""
import bpy
import sys
import os
import json
import hashlib

folder = sys.argv[sys.argv.index('--') + 1]
fixture = json.load(open(os.path.join(folder, 'fixture.json'), encoding='utf8'))
report = json.load(open(os.path.join(folder, 'report.json'), encoding='utf8'))
root = os.path.join(fixture['profile'], 'projects', fixture['projectId'])
output = os.path.join(folder, 'native-independent.json')
if os.path.exists(output):
    raise RuntimeError('Existing independent evidence must not be overwritten')

def digest(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def file_sha(file):
    with open(file, 'rb') as handle:
        return hashlib.sha256(handle.read()).hexdigest()

def snapshot(version):
    file = next(f for f in version['files'] if f['path'].endswith('.blend'))
    absolute = os.path.join(root, file['path'])
    assert file_sha(absolute) == file['sha256']
    bpy.ops.wm.open_mainfile(filepath=absolute, load_ui=False, use_scripts=False)
    meshes = {}
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        key = obj.get('partsmith_part_id')
        assert key in ['head', 'body', 'hair'] and key not in meshes
        data = obj.data
        materials = []
        for mat in data.materials:
            item = {'name': mat.name, 'nodes': [], 'links': []}
            if mat.use_nodes:
                for node in mat.node_tree.nodes:
                    values = []
                    for socket in node.inputs:
                        if not hasattr(socket, 'default_value'):
                            continue
                        value = socket.default_value
                        if isinstance(value, (int, float, str, bool)):
                            values.append([socket.name, value])
                        elif hasattr(value, '__iter__'):
                            values.append([socket.name, list(value)])
                    item['nodes'].append([node.name, node.type, values])
                item['links'] = sorted([link.from_node.name, link.from_socket.name, link.to_node.name, link.to_socket.name] for link in mat.node_tree.links)
            materials.append(item)
        meshes[key] = {
            'meshId': obj.get('partsmith_id'),
            'vertices': len(data.vertices), 'faces': len(data.polygons),
            'geometry': digest([list(v.co) for v in data.vertices]),
            'topology': digest([list(p.vertices) for p in data.polygons]),
            'world': [list(row) for row in obj.matrix_world],
            'uv': digest([[layer.name, [list(loop.uv) for loop in layer.data]] for layer in data.uv_layers]),
            'activeUV': data.uv_layers.active.name if data.uv_layers.active else None,
            'faceMaterial': digest([p.material_index for p in data.polygons]),
            'materials': digest(materials),
            'images': sorted([img.name, hashlib.sha256(bytes(img.packed_file.data)).hexdigest()] for img in bpy.data.images if img.packed_file),
        }
    return {'path': absolute, 'sha256': file['sha256'], 'parts': meshes}

main = lambda step: next(v for v in report['operations'][step]['versions'] if v['slot'] == 'main')
before = snapshot(main('assembly'))
material = snapshot(report['operations']['material']['versions'][0])
after = snapshot(main('reassembly'))
assert set(before['parts']) == set(after['parts']) == {'head', 'body', 'hair'}
assert set(material['parts']) == {'head'}
for part in ['body', 'hair']:
    assert before['parts'][part] == after['parts'][part], part + ' changed'
assert material['parts']['head'] == after['parts']['head'], 'Selected material head was not preserved exactly'
for field in ['meshId', 'vertices', 'faces', 'geometry', 'topology', 'world', 'faceMaterial']:
    assert before['parts']['head'][field] == after['parts']['head'][field], 'head shape changed: ' + field
assert before['parts']['head']['materials'] != after['parts']['head']['materials']
for file in fixture['protectedFiles']:
    assert file_sha(file['path']) == file['sha256']
assert file_sha(fixture['sourceWorkspace']) == fixture['workspaceSha']
result = {'passed': True, 'before': before, 'headMaterial': material, 'after': after,
          'checks': {'unmodifiedBodyHairExact': True, 'headUsesExactSelectedMaterial': True, 'headShapeAndWorldExact': True, 'productionFilesAndWorkspaceExact': True},
          'scope': 'Actual local keep-placement assembly and one-part UV/material only. Not artistic seam quality, texture generation, rigging, or Unity animation proof.',
          'paid': 0, 'GPT': 0, 'ARP': 0}
json.dump(result, open(output, 'w', encoding='utf8'), indent=2, ensure_ascii=False)
print('ACTUAL PARTS KEEP INDEPENDENT PASS')
