"""Offline tiny FBX/registered-image regression; no services or source authoring."""
import bpy, hashlib, json, os, pathlib, runpy, shutil, sys
root = pathlib.Path(os.environ['LOCAL_COMPANIONS_ROOT'])
worker = pathlib.Path(__file__).resolve().parents[1] / 'integrations/blender/graphics_local.py'
sys.path.insert(0, str(worker.parent))
from graphics_source_images import import_fbx_deferred, pack_registered_companions

def sha(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def check(value, label):
    if not value: raise AssertionError(label)
    checks.append(label)
checks = []
original = root / 'original'; original.mkdir(parents=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=2)
obj = bpy.context.object
image = bpy.data.images.new('tiny', width=4, height=4)
image.pixels[:] = [0.3, 0.6, 0.8, 1] * 16
image.filepath_raw = str(original / 'Texture.PNG'); image.file_format = 'PNG'; image.save()
mat = bpy.data.materials.new('TinyMaterial'); mat.use_nodes = True
tex = mat.node_tree.nodes.new('ShaderNodeTexImage'); tex.image = image
mat.node_tree.links.new(tex.outputs['Color'], mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
obj.data.materials.append(mat)
def snapshot():
    mesh = next(o for o in bpy.context.scene.objects if o.type == 'MESH').data
    return {'positions': [list(v.co) for v in mesh.vertices], 'faces': [list(p.vertices) for p in mesh.polygons],
            'uv': [list(x.uv) for x in mesh.uv_layers.active.data], 'materials': [m.name for m in mesh.materials],
            'materialIndices': [p.material_index for p in mesh.polygons]}
bpy.ops.export_scene.fbx(filepath=str(original/'source.fbx'), use_selection=True, path_mode='RELATIVE', embed_textures=False, bake_anim=False)
original_hashes = {p.name: sha(p) for p in original.iterdir() if p.is_file()}

def spec(label, include=True, embedded=False):
    folder = root/label; inp = folder/'work/input'; out = folder/'outputs'; inp.mkdir(parents=True); out.mkdir()
    shutil.copyfile(original/('embedded.fbx' if embedded else 'source.fbx'), inp/'source.fbx')
    shutil.copyfile(original/'Texture.PNG', inp/'Texture.PNG')
    f = {'path': 'registered/Texture.PNG', 'kind': 'image', 'bytes': (inp/'Texture.PNG').stat().st_size, 'sha256': sha(inp/'Texture.PNG')}
    return {'identity': label, 'operation': 'A05', 'source': str(inp/'source.fbx'), 'sourceSha256': sha(inp/'source.fbx'),
            'sourceManifestVersion': 1, 'sourceCompanions': [f] if include else [],
            'companionResources': [{'file': f, 'stagedPath': str(inp/'Texture.PNG')}] if include else [],
            'output': str(out), 'scale': 1, 'pivot': 'keep', 'format': 'both'}
def run(q):
    p = pathlib.Path(q['output']).parent/'request.json'; p.write_text(json.dumps(q))
    sys.argv = [str(worker), '--', str(p)]
    runpy.run_path(str(worker), run_name='__main__')
def blocked(q, label):
    try: run(q)
    except (ValueError, RuntimeError): pass
    else: raise AssertionError('Accepted ' + label)
    check(not (pathlib.Path(q['output'])/'report.json').exists(), label)

for operation in ('A05', 'X04'):
    q = spec(operation); q['operation'] = operation
    # Host cannot authorize an FBX-recorded absolute path. Only its registered basename is used.
    bpy.ops.wm.read_factory_settings(use_empty=True); import_fbx_deferred(pathlib.Path(q['source'])); pack_registered_companions(q,pathlib.Path(q['source']))
    expected = snapshot(); run(q)
    report = json.loads((pathlib.Path(q['output'])/'report.json').read_text())
    check(report['sourceCompanions'] == q['sourceCompanions'], operation+' manifest exact')
    check(report['sourceImages'][0]['sha256'] == original_hashes['Texture.PNG'], operation+' packed original bytes')
    check(sha(pathlib.Path(q['output'])/'textures/0.png') == original_hashes['Texture.PNG'], operation+' output image exact')
    check(snapshot() == expected, operation+' geometry UV material assignment exact')
    check(report['glbImages'][0]['mode'] == 'original' and report['glbImages'][0]['sha256'] == original_hashes['Texture.PNG'], operation+' GLB original encoded bytes')
    bpy.ops.wm.open_mainfile(filepath=str(pathlib.Path(q['output'])/'asset.blend'),load_ui=False,use_scripts=False)
    check(snapshot() == expected and sha(q['source']) == q['sourceSha256'], operation+' saved BLEND/rest source exact')
blocked(spec('missing',include=False), 'missing manifest never searches existing original external texture')
q = spec('changed'); pathlib.Path(q['companionResources'][0]['stagedPath']).write_bytes(b'changed'); blocked(q,'changed staged bytes blocked')
q = spec('duplicate'); q['sourceCompanions'] *= 2; q['companionResources'] *= 2; blocked(q,'duplicate manifest basename blocked')
q = spec('casefold'); second=dict(q['sourceCompanions'][0],path='other/texture.png');q['sourceCompanions'].append(second);q['companionResources'].append({'file':second,'stagedPath':q['companionResources'][0]['stagedPath']});blocked(q,'NFC casefold basename conflict blocked')
# Create a tiny embedded texture fixture, then authorize different bytes with its same basename.
bpy.ops.wm.read_factory_settings(use_empty=True); import_fbx_deferred(original/'source.fbx')
q = spec('embedded-prepare'); pack_registered_companions(q,pathlib.Path(q['source']))
bpy.ops.export_scene.fbx(filepath=str(original/'embedded.fbx'),path_mode='COPY',embed_textures=True,bake_anim=False)
q = spec('embedded-conflict',embedded=True); imagepath=pathlib.Path(q['companionResources'][0]['stagedPath']); imagepath.write_bytes(b'conflicting registered bytes');q['sourceCompanions'][0]['bytes']=imagepath.stat().st_size;q['sourceCompanions'][0]['sha256']=sha(imagepath);blocked(q,'embedded registered bytes conflict blocked')
check(all(sha(original/name)==value for name,value in original_hashes.items()),'all original source bytes exact')
check(not (original/'source.fbm').exists(), 'external FBX source has no importer-created fbm folder')
(root/'evidence.json').write_text(json.dumps({'passed':True,'checks':checks,'paidSubmissions':0,'productionGPT':0},indent=2))
