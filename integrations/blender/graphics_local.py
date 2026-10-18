"""Deterministic graphics transform/export. Never authors geometry, textures or motion."""
import bpy
import hashlib
import json
import math
import pathlib
import sys
from mathutils import Matrix, Vector
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from graphics_glb import export_packed_glb
from graphics_size import apply_physical_size
from graphics_source_images import import_fbx_deferred, pack_registered_companions

spec_path = pathlib.Path(sys.argv[sys.argv.index('--') + 1]).resolve()
q = json.loads(spec_path.read_text(encoding='utf8'))
source = pathlib.Path(q['source']).resolve()
out = pathlib.Path(q['output']).resolve()
out.mkdir(parents=True, exist_ok=True)
original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
if q.get('sourceSha256') and original_hash != q['sourceSha256']:
    raise RuntimeError('Frozen source hash changed')
operation = q['operation']
scale = float(q['scale'])
pivot = q['pivot']
if operation not in ('A05', 'X04') or not math.isfinite(scale) or scale <= 0 or pivot not in ('keep', 'center', 'bottom'):
    raise RuntimeError('Invalid frozen transform request')
if q['format'] not in ('glb', 'fbx', 'both'):
    raise RuntimeError('Invalid frozen export format')
if any((out / name).exists() for name in ('asset.blend', 'asset.glb', 'asset.fbx', 'report.json')):
    raise RuntimeError('Existing output must be inspected; it will not be overwritten')
if source.suffix.lower() == '.blend':
    bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
elif source.suffix.lower() == '.glb':
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source))
elif source.suffix.lower() == '.fbx':
    bpy.ops.wm.read_factory_settings(use_empty=True)
    import_fbx_deferred(source)
else:
    raise RuntimeError('Expected Blender, GLB or FBX source')
source_images = pack_registered_companions(q, source)
meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
if not meshes:
    raise RuntimeError('No mesh in the selected source')
if any(obj.library for obj in bpy.context.scene.objects):
    raise RuntimeError('Linked external objects must be made local explicitly before export')

# Legacy relative transforms remain explicit. New absolute fitting is shared with Unity.
if not q.get('physicalSize') and operation == 'A05' and (scale != 1 or pivot != 'keep'):
    if any(obj.animation_data or obj.constraints for obj in bpy.context.scene.objects):
        raise RuntimeError('Transforming animated/constrained objects needs an explicit authoring review')
    if any(obj.type == 'ARMATURE' for obj in bpy.context.scene.objects):
        raise RuntimeError('Rig transform requires a separate rig-aware authoring review')
points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
low = Vector(tuple(min(point[i] for point in points) for i in range(3)))
high = Vector(tuple(max(point[i] for point in points) for i in range(3)))
anchor = Vector((0, 0, 0))
if pivot in ('center', 'bottom'):
    anchor = (low + high) / 2
    if pivot == 'bottom':
        anchor.z = low.z
transform = Matrix.Scale(scale, 4) @ Matrix.Translation(-anchor)
roots = [obj for obj in bpy.context.scene.objects if obj.parent is None and obj.type not in ('CAMERA', 'LIGHT')]
if not q.get('physicalSize') and operation == 'A05' and (scale != 1 or pivot != 'keep'):
    # A common asset root gives Unity a stable pivot without changing vertex/UV data.
    root = bpy.data.objects.new('Partsmith_AssetRoot', None)
    bpy.context.scene.collection.objects.link(root)
    root['partsmith_scale'] = scale
    root['partsmith_pivot'] = pivot
    for obj in roots:
        world = obj.matrix_world.copy()
        obj.parent = root
        obj.matrix_world = transform @ world
    bpy.context.view_layer.update()

physical_size = apply_physical_size(q.get('physicalSize'), original_hash)

files = []
glb_images = []
texture_folder = out / 'textures'
warnings = []
for index, image in enumerate(bpy.data.images):
    if image.source in ('VIEWER',):
        continue
    if image.source != 'FILE':
        raise RuntimeError('Only existing file textures can be exported without image authoring: ' + image.name)
    if not image.packed_file:
        raise RuntimeError('Source textures must be packed; no external texture search: ' + image.name)
    raw = bytes(image.packed_file.data)
    suffix = '.png' if raw.startswith(b'\x89PNG') else '.jpg' if raw.startswith(b'\xff\xd8\xff') else '.webp' if raw[:4] == b'RIFF' and raw[8:12] == b'WEBP' else None
    if not suffix or min(image.size) < 1:
        raise RuntimeError('Unsupported packed texture: ' + image.name)
    texture_folder.mkdir(exist_ok=True)
    texture_path = texture_folder / (str(index) + suffix)
    texture_path.write_bytes(raw)
    image.filepath = str(texture_path)
    files.append(texture_path.relative_to(out).as_posix())

bpy.ops.object.select_all(action='DESELECT')
selected = [obj for obj in bpy.context.scene.objects if obj.type in ('MESH', 'ARMATURE', 'EMPTY')]
for obj in selected:
    obj.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.wm.save_as_mainfile(filepath=str(out / 'asset.blend'), compress=False)
files.append('asset.blend')
if q['format'] in ('glb', 'both'):
    glb_images = export_packed_glb(out / 'asset.glb', use_selection=True, export_animations=True)
    files.append('asset.glb')
if q['format'] in ('fbx', 'both'):
    bpy.ops.export_scene.fbx(filepath=str(out / 'asset.fbx'), use_selection=True,
        object_types={'ARMATURE', 'MESH', 'EMPTY'}, axis_forward='-Z', axis_up='Y',
        apply_unit_scale=True, apply_scale_options='FBX_SCALE_UNITS', add_leaf_bones=False,
        bake_anim=True, bake_anim_use_all_actions=True, bake_anim_use_nla_strips=False,
        bake_anim_simplify_factor=0.0, path_mode='COPY', embed_textures=True)
    files.append('asset.fbx')
if hashlib.sha256(source.read_bytes()).hexdigest() != original_hash:
    raise RuntimeError('Original source changed during local export')
report = {'schemaVersion': 1, 'identity': q['identity'], 'operation': operation,
    'originalPreserved': True, 'sourceSha256': original_hash, 'files': files,
    'scale': scale, 'pivot': pivot, 'boundsBefore': {'min': list(low), 'max': list(high)},
    'meshCount': len(meshes), 'vertexCount': sum(len(obj.data.vertices) for obj in meshes),
    'geometryAuthored': False, 'motionAuthored': False, 'unityPlaybackVerified': False,
    'warnings': warnings, 'glbImages': glb_images}
report['physicalSize'] = physical_size
if q.get('sourceManifestVersion') == 1:
    report['sourceManifestVersion'] = 1
    report['sourceCompanions'] = q.get('sourceCompanions', [])
report['sourceImages'] = source_images
temporary = out / 'report.json.tmp'
temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
temporary.replace(out / 'report.json')
