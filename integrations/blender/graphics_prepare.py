"""Deterministic Unity derivative; no authoring, online operations, or source writes."""
import bpy, json, pathlib, sys, hashlib, shutil, re

q = json.loads(pathlib.Path(sys.argv[sys.argv.index('--') + 1]).read_text(encoding='utf8'))
source = pathlib.Path(q['source']).resolve()
out = pathlib.Path(q['output']).resolve()
out.mkdir(parents=True, exist_ok=False)
root = source.parent
input_root = pathlib.Path(q.get('inputRoot', str(root))).resolve()
declared = q['files']
for item in declared:
    item['local'] = str(pathlib.Path(item['local']).resolve())
    if not pathlib.Path(item['local']).is_relative_to(input_root) or hashlib.sha256(pathlib.Path(item['local']).read_bytes()).hexdigest() != item['sha256']:
        raise RuntimeError('Declared source changed or escaped the private staging folder')

suffix = source.suffix.lower()
if suffix == '.blend':
    bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
    if bpy.data.libraries:
        raise RuntimeError('Linked Blender libraries must be made local before Unity delivery')
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if suffix == '.fbx':
        bpy.ops.import_scene.fbx(filepath=str(source), use_image_search=False)
    elif suffix == '.glb':
        # A GLB with external URIs is not a self-contained source. Do not let the importer search outside staging.
        raw = source.read_bytes()
        if raw[:4] != b'glTF' or int.from_bytes(raw[4:8], 'little') != 2:
            raise RuntimeError('Invalid GLB source')
        length = int.from_bytes(raw[12:16], 'little')
        data = json.loads(raw[20:20+length].decode('utf8').rstrip('\x00 '))
        for item in data.get('buffers', []) + data.get('images', []):
            if item.get('uri') and not item['uri'].startswith('data:'):
                raise RuntimeError('GLB external URI requires an explicit self-contained import')
        bpy.ops.import_scene.gltf(filepath=str(source))
    elif suffix == '.obj':
        text = source.read_text(encoding='utf8', errors='strict')
        for name in re.findall(r'^mtllib\s+(.+)$', text, re.MULTILINE):
            if ':' in name or pathlib.Path(name.strip()).is_absolute():
                raise RuntimeError('OBJ material path must be local and declared')
            material_path = (root/name.strip()).resolve()
            if not material_path.is_relative_to(input_root):
                raise RuntimeError('OBJ material escaped source manifest root')
            found = [f for f in declared if pathlib.Path(f['local']) == material_path]
            if len(found) != 1:
                raise RuntimeError('OBJ material file missing from source manifest: '+name)
            material = pathlib.Path(found[0]['local']).read_text(encoding='utf8')
            for map_name in re.findall(r'^\s*(?:map_\w+|bump|disp|decal|norm)\s+(.+)$', material, re.MULTILINE):
                # Options and external paths need deliberate import rather than a speculative file search.
                if ':' in map_name or pathlib.Path(map_name.strip()).is_absolute() or map_name.startswith('-'):
                    raise RuntimeError('OBJ texture path requires an explicit contained import')
                image_path = (material_path.parent/map_name.strip()).resolve()
                if not image_path.is_relative_to(input_root):
                    raise RuntimeError('OBJ texture escaped source manifest root')
                images = [f for f in declared if pathlib.Path(f['local']) == image_path]
                if len(images) != 1:
                    raise RuntimeError('OBJ texture missing from source manifest: '+map_name)
        bpy.ops.wm.obj_import(filepath=str(source))
    else:
        raise RuntimeError('Unsupported model format')

meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
rigs = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
if not meshes or any(len(o.data.vertices) == 0 for o in meshes):
    raise RuntimeError('Model has no usable mesh')
if len(rigs) > 1:
    raise RuntimeError('Multiple skeletons require an explicit compatible export')

textures = out/'Textures'
textures.mkdir()
warnings = []
for index, image in enumerate(bpy.data.images):
    if image.type == 'RENDER_RESULT' or image.source not in {'FILE', 'GENERATED'}:
        continue
    if image.packed_file:
        raw = bytes(image.packed_file.data)
    else:
        basename = pathlib.Path(image.filepath.replace('\\','/')).name
        matches = [f for f in declared if pathlib.Path(f['original']).name == basename]
        current = pathlib.Path(bpy.path.abspath(image.filepath)).resolve()
        if len(matches) == 1:
            raw = pathlib.Path(matches[0]['local']).read_bytes()
        elif current.is_file() and current.is_relative_to(input_root):
            raw = current.read_bytes()
        else:
            raise RuntimeError('Texture is not packed or declared in the immutable source: '+image.name)
    extension = '.png' if raw.startswith(b'\x89PNG\r\n\x1a\n') else '.jpg' if raw.startswith(b'\xff\xd8\xff') else None
    if extension is None:
        raise RuntimeError('Texture is not a preserved PNG/JPEG: '+image.name)
    # Stable image names preserve importer material bindings; bytes are never resampled.
    name = re.sub(r'[^A-Za-z0-9_-]', '_', pathlib.Path(image.name).stem) or 'Texture'
    texture = textures/(str(index)+'_'+name+extension)
    texture.write_bytes(raw)
    image.filepath = str(texture)

def signature(o):
    return {'name': o.name, 'parent': o.parent.name if o.parent else None,
            'vertices': len(o.data.vertices), 'edges': len(o.data.edges),
            'polygons': [list(p.vertices) for p in o.data.polygons],
            'materials': [m.name if m else '' for m in o.data.materials]}

structure = {'meshes': sorted([signature(o) for o in meshes], key=lambda m:m['name']),
             'bones': [{'name':b.name,'parent':b.parent.name if b.parent else None,
                        'bind':[round(v,6) for row in b.matrix_local for v in row]}
                       for rig in rigs for b in rig.data.bones]}
clips = sorted(a.name for a in bpy.data.actions if a.frame_range[1] > a.frame_range[0])
if clips and not rigs:
    warnings.append('Transform animation is retained; skeletal deformation was not verified.')
if any(o.modifiers for o in meshes):
    warnings.append('Blender modifiers are evaluated in the FBX derivative; source geometry remains unchanged.')

if suffix == '.fbx':
    # Preserve native animation curves and original FBX bytes instead of re-encoding them.
    shutil.copyfile(source, out/'Asset.fbx')
    # FBX take names are reported by Unity rather than guessed from Blender action names.
    clips = []
else:
    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes + rigs:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = rigs[0] if rigs else meshes[0]
    bpy.ops.export_scene.fbx(filepath=str(out/'Asset.fbx'), use_selection=True,
        object_types={'ARMATURE','MESH'}, add_leaf_bones=False, bake_anim=bool(clips),
        bake_anim_use_all_actions=True, bake_anim_use_nla_strips=False,
        bake_anim_simplify_factor=0.0, path_mode='COPY', embed_textures=True)
warnings.append('Import checks do not establish visual material fidelity or animation playback quality.')
(out/'inspection.json').write_text(json.dumps({'structure':structure,'clips':clips,
    'bones':sum(len(r.data.bones) for r in rigs),'warnings':warnings,
    'sourceChanged':False,'animationAuthored':False},ensure_ascii=False),encoding='utf8')
