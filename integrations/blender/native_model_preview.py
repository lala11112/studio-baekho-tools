"""Deterministic native FBX inspection/preview. No authored geometry changes."""
import bpy, sys, json, os, math, zipfile, pathlib, shutil

source, output = sys.argv[sys.argv.index('--') + 1:]
os.makedirs(output, exist_ok=True)
fbx = source
preserved = []
if source.lower().endswith('.zip'):
    root = pathlib.Path(output, 'native').resolve()
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > 2000 or sum(i.file_size for i in entries) > 400 * 1024 * 1024:
            raise RuntimeError('Native archive exceeds extraction limits')
        for entry in entries:
            name = entry.filename.replace('\\', '/')
            target = (root / name).resolve()
            if pathlib.PurePosixPath(name).is_absolute() or ':' in name or '..' in pathlib.PurePosixPath(name).parts or root not in target.parents or ((entry.external_attr >> 16) & 0o170000) == 0o120000:
                raise RuntimeError('Unsafe native archive path')
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as src, open(target, 'xb') as dst:
                    shutil.copyfileobj(src, dst)
                preserved.append(str(target))
    models = [p for p in preserved if p.lower().endswith('.fbx')]
    if len(models) != 1:
        raise RuntimeError('Expected exactly one FBX per native model download')
    fbx = models[0]
elif not source.lower().endswith('.fbx'):
    raise RuntimeError('Expected native FBX or ZIP')

bpy.ops.wm.read_factory_settings(use_empty=True)
# FBX import can extract embedded images alongside its input. Contain those
# writes in output, so both the native original and the staging input stay intact.
import_fbx = fbx
if not source.lower().endswith('.zip'):
    native_dir = pathlib.Path(output, 'native')
    native_dir.mkdir(parents=True, exist_ok=True)
    import_fbx = str(native_dir / 'model.fbx')
    shutil.copyfile(fbx, import_fbx)
bpy.ops.import_scene.fbx(filepath=import_fbx, use_image_search=False)
if not source.lower().endswith('.zip'):
    preserved = [str(p) for p in native_dir.rglob('*') if p.is_file() and str(p) != import_fbx]
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not meshes or not sum(len(o.data.polygons) for o in meshes):
    raise RuntimeError('Native FBX contains no mesh faces')
for obj in meshes:
    if not all(math.isfinite(v) for vert in obj.data.vertices for v in vert.co) or not all(math.isfinite(v) for row in obj.matrix_world for v in row):
        raise RuntimeError('Native FBX contains non-finite geometry')

# Only use embedded images or companions extracted from this same native archive.
textures = []
for image in bpy.data.images:
    if image.source != 'FILE':
        continue
    if image.packed_file:
        raw = bytes(image.packed_file.data)
        extension = '.png' if raw.startswith(b'\x89PNG\r\n\x1a\n') else '.jpg' if raw.startswith(b'\xff\xd8\xff') else None
        if extension is None:
            raise RuntimeError('Unsupported embedded texture format: ' + image.name)
        packed_dir = pathlib.Path(output, 'embedded')
        packed_dir.mkdir(exist_ok=True)
        packed_path = packed_dir / (str(len(textures)) + extension)
        packed_path.write_bytes(raw)
        preserved.append(str(packed_path))
    if not image.packed_file:
        basename = os.path.basename(image.filepath.replace('\\', '/'))
        matches = [p for p in preserved if os.path.basename(p).casefold() == basename.casefold()]
        if len(matches) != 1:
            raise RuntimeError('Missing or ambiguous native companion texture: ' + image.name)
        image.filepath = matches[0]
        image.reload()
    if min(image.size) <= 0:
        raise RuntimeError('Native texture could not be decoded')
    textures.append({'name': image.name, 'width': image.size[0], 'height': image.size[1]})

report = {'vertices': sum(len(o.data.vertices) for o in meshes),
          'faces': sum(len(o.data.polygons) for o in meshes),
          'quads': sum(len(p.vertices) == 4 for o in meshes for p in o.data.polygons),
          'triangles': sum(len(p.vertices) == 3 for o in meshes for p in o.data.polygons),
          'uvLayers': sum(len(o.data.uv_layers) for o in meshes),
          'meshes': len(meshes), 'textures': textures, 'nativeFbx': fbx,
          'companions': preserved, 'geometryEdited': False}
bpy.ops.export_scene.gltf(filepath=os.path.join(output, 'preview.glb'), export_format='GLB')
if import_fbx != fbx:
    os.unlink(import_fbx)
with open(os.path.join(output, 'inspection.json'), 'w', encoding='utf8') as stream:
    json.dump(report, stream, ensure_ascii=False, indent=2)
