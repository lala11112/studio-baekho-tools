"""Prove one Blender RNA compatibility omission on synthetic geometry only.

The saved production author's module is parsed but NEVER executed. Only its
append_geometry function is compiled against isolated synthetic meshes.
"""
import ast
import copy
import hashlib
import json
import pathlib
import sys
import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
source, output, helpers = (pathlib.Path(value) for value in args)
sys.dont_write_bytecode = True
sys.path.insert(0, str(helpers))
import graphics_contact as c
import graphics_contact_reconstruct as r
import graphics_contact_compat as compat

raw = source.read_bytes(); source_sha = hashlib.sha256(raw).hexdigest()
tree = ast.parse(raw.decode('utf-8-sig'))
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'append_geometry']
assert len(functions) == 1
original = functions[0]
matches = [node for node in ast.walk(original) if isinstance(node, ast.Assign)
    and len(node.targets) == 1 and isinstance(node.targets[0], ast.Attribute)
    and isinstance(node.targets[0].value, ast.Name) and node.targets[0].value.id == 'f'
    and node.targets[0].attr == 'loop_total'
    and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name)
    and node.value.func.id == 'len' and len(node.value.args) == 1
    and isinstance(node.value.args[0], ast.Name) and node.value.args[0].id == 'face'
    and not node.value.keywords]
assert len(matches) == 1
match = matches[0]

class OmitReadOnlyAssignment(ast.NodeTransformer):
    def visit_Assign(self, node):
        return None if (node.lineno, node.col_offset, node.end_lineno, node.end_col_offset) == (match.lineno, match.col_offset, match.end_lineno, match.end_col_offset) else node

fixed_tree = OmitReadOnlyAssignment().visit(copy.deepcopy(tree))
expected_tree = copy.deepcopy(tree)
for node in ast.walk(expected_tree):
    for field, value in ast.iter_fields(node):
        if isinstance(value, list):
            setattr(node, field, [item for item in value if not isinstance(item, ast.Assign) or (item.lineno, item.col_offset, item.end_lineno, item.end_col_offset) != (match.lineno, match.col_offset, match.end_lineno, match.end_col_offset)])
assert ast.dump(fixed_tree, include_attributes=True) == ast.dump(expected_tree, include_attributes=True)
compatible_raw, compatibility_receipt = compat.omit_readonly_loop_total(raw)
assert ast.dump(ast.parse(compatible_raw.decode('utf-8-sig')), include_attributes=False) == ast.dump(fixed_tree, include_attributes=False)
assert compatibility_receipt['astEquivalenceAfterOmission'] and compatibility_receipt['otherSourceLinesExact']
function = next(node for node in fixed_tree.body if isinstance(node, ast.FunctionDef) and node.name == 'append_geometry')
context = {'bpy': bpy, 'Vector': Vector}
exec(compile(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])), '<synthetic append_geometry only>', 'exec'), context)
append = context['append_geometry']

bpy.ops.wm.read_factory_settings(use_empty=True)
mesh = bpy.data.meshes.new('SyntheticOpenStrip')
mesh.from_pydata([(0, 0, 0), (.1, 0, 0), (.2, 0, 0), (0, 0, .1), (.1, 0, .1), (.2, 0, .1)], [], [(0, 1, 4, 3), (1, 2, 5, 4)])
mesh.uv_layers.new(name='OriginalUV')
for index, value in enumerate(mesh.uv_layers[0].data): value.uv = (index / 10, index / 20)
for name, domain in [('partsmith_source_vertex', 'POINT'), ('partsmith_source_face', 'FACE'), ('partsmith_source_corner', 'CORNER')]:
    attr = mesh.attributes.new(name=name, type='INT', domain=domain)
    for index, value in enumerate(attr.data): value.value = index
obj = bpy.data.objects.new('SyntheticHead', mesh); bpy.context.scene.collection.objects.link(obj)
obj['partsmith_id'] = 'mesh-head'; obj['partsmith_part_id'] = 'head'
before = c.repair_contract()['meshes']['mesh-head']
new_points = [Vector((0, 0, -.005)), Vector((.1, 0, -.005)), Vector((.15, 0, -.005))]
new_faces = [[1, 0, 6, 7], [2, 1, 8]]
receipt = append(obj, new_points, new_faces)
after = c.repair_contract()['meshes']['mesh-head']
assert after['positions'][:6] == before['positions']
assert after['faces'] == before['faces'] + new_faces
assert after['edges'][:len(before['edges'])] == before['edges']
assert after['uv'][0][1][:8] == before['uv'][0][1]
assert [polygon.loop_total for polygon in mesh.polygons] == [4, 4, 4, 3]
assert [polygon.loop_start for polygon in mesh.polygons] == [0, 4, 8, 12]
for name, attribute in before['attributes'].items():
    assert after['attributes'][name]['values'][:len(attribute['values'])] == attribute['values']
assert all(value.value == -1 for value in mesh.attributes['partsmith_source_face'].data[2:])
assert all(value.value == -1 for value in mesh.attributes['partsmith_source_vertex'].data[6:])
assert all(value.value == -1 for value in mesh.attributes['partsmith_source_corner'].data[8:])
checks = ['AST changes only one exact read-only assignment', 'original vertices, edges, polygons, UV and stable attributes remain exact',
    'mixed quad/triangle loop counts derive correctly from loop starts and sentinel', 'new stable IDs get explicit -1', 'saved production author module never executes']

def reject(label, after_value, expect):
    mask = {'allowed': {'neck': [0, 1, 2], 'innerHair': []}, 'maxAddedVertices': 10, 'maxAddedFaces': 10,
        'newGeometryWorldBounds': [[0, 0, -.01], [.2, 0, 0]], 'newGeometryProximity': .06, 'maxNewEdgeLength': .2}
    try:
        r.validate_added(before, after_value, before['positions'], after['positions'], mask)
    except RuntimeError as error:
        assert expect in str(error), str(error); checks.append(label)
    else: raise AssertionError(label)

bad = copy.deepcopy(after); bad['faces'][-1] = [2, 1, 1]
reject('duplicate new polygon corners rejected', bad, 'duplicate')
bad = copy.deepcopy(after); bad['faces'][-1] = [2, 4, 8]
reject('protected old vertex attachment rejected', bad, 'protected')
assert before['faces'] != after['faces'][1:3]
checks.append('reindexed original polygon prefix differs and is detectable by unchanged contract')

# Appending no geometry must not corrupt existing loop starts or data.
saved = c.repair_contract(); append(obj, [], []); assert c.repair_contract() == saved
checks.append('zero append leaves exact data unchanged')
for label, altered in [
    ('multiple loop_total assignments rejected', raw + b'\nf.loop_total=len(face)\n'),
    ('unexpected loop_total writer rejected', raw.replace(b'f.loop_total=len(face)', b'f.loop_total=4')),
    ('different receiver rejected', raw.replace(b'f.loop_total=len(face)', b'g.loop_total=len(face)')),
]:
    try: compat.omit_readonly_loop_total(altered)
    except RuntimeError: checks.append(label)
    else: raise AssertionError(label)
private = output.parent / 'contact-loop-compat-fixture'; private.mkdir(parents=True, exist_ok=True)
private_author = private / 'author.py'; private_copy = private / 'author.compat.py'; private_report = private / 'receipt.json'
private_author.write_bytes(raw)
receipt = compat.prepare_compatibility({'authorPath': str(private_author), 'authorSha256': source_sha,
    'outputScript': str(private_copy), 'report': str(private_report)})
assert private_author.read_bytes() == raw and private_copy.read_bytes() == compatible_raw
assert not receipt['executedProcedure']
checks.append('compatibility creates distinct copy and receipt without executing authored module')
try:
    compat.prepare_compatibility({'authorPath': str(private_author), 'authorSha256': '0' * 64,
        'outputScript': str(private_copy), 'report': str(private_report)})
except RuntimeError: checks.append('source hash mismatch rejected before copy preparation')
else: raise AssertionError('Expected stale source hash rejection')
try:
    compat.prepare_compatibility({'authorPath': str(private_author), 'authorSha256': source_sha,
        'outputScript': str(private_author), 'report': str(private_report)})
except RuntimeError: checks.append('in-place source overwrite rejected')
else: raise AssertionError('Expected in-place overwrite rejection')
try:
    compat.prepare_compatibility({'authorPath': str(private_author), 'authorSha256': source_sha,
        'outputScript': str(private_copy), 'report': str(private_author)})
except RuntimeError: checks.append('receipt cannot overwrite source procedure')
else: raise AssertionError('Expected receipt overwrite rejection')
assert source.read_bytes() == raw
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps({'passed': True, 'sourceSha256': source_sha,
    'omittedNode': ast.dump(match, include_attributes=False), 'omittedLine': match.lineno,
    'unchangedOtherAst': True, 'syntheticOnly': True, 'productionCalls': 0,
    'appendReceipt': receipt, 'compatibilityReceipt': compatibility_receipt, 'checks': checks, 'blender': bpy.app.version_string}, ensure_ascii=False, indent=2), encoding='utf-8')
print('RNA_COMPATIBILITY_PROOF', json.dumps({'passed': True, 'checks': len(checks), 'productionCalls': 0}))
