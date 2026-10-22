"""Local photographs of a frozen model/rig. Never saves its scene or authors motion."""
import bpy
import hashlib
import json
import math
import pathlib
import sys
import unicodedata
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

def image_name(value):
    return unicodedata.normalize('NFC', str(value).replace('\\','/').rsplit('/',1)[-1]).casefold()

q = json.loads(pathlib.Path(sys.argv[sys.argv.index('--') + 1]).read_text(encoding='utf8'))
source = pathlib.Path(q['source']).resolve()
input_root = pathlib.Path(q['inputRoot']).resolve()
output = pathlib.Path(q['output']).resolve()
axis = q['axis']
if axis not in ('X', 'Y') or not source.is_relative_to(input_root):
    raise RuntimeError('Invalid frozen source or side axis')
if any((output / name).exists() for name in ('left.png', 'right.png', 'render.json')):
    raise RuntimeError('Existing motion inputs cannot be overwritten')
for item in q['files']:
    item_path = pathlib.Path(item['local']).resolve()
    if not item_path.is_relative_to(input_root) or hashlib.sha256(item_path.read_bytes()).hexdigest() != item['sha256']:
        raise RuntimeError('Frozen source manifest changed')
if hashlib.sha256(source.read_bytes()).hexdigest() != q['sourceSha256']:
    raise RuntimeError('Frozen source hash changed')

suffix = source.suffix.lower()
if suffix == '.blend':
    bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
elif suffix in ('.glb', '.fbx'):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if suffix == '.glb':
        raw = source.read_bytes()
        if len(raw) < 20 or raw[:4] != b'glTF' or int.from_bytes(raw[4:8], 'little') != 2:
            raise RuntimeError('Invalid GLB')
        length = int.from_bytes(raw[12:16], 'little')
        gltf = json.loads(raw[20:20 + length].decode('utf8').rstrip('\x00 '))
        if any(item.get('uri') and not item['uri'].startswith('data:') for item in gltf.get('images', []) + gltf.get('buffers', [])):
            raise RuntimeError('GLB external sources must be packed first')
        bpy.ops.import_scene.gltf(filepath=str(source))
    else:
        # Embedded texture extraction stays in the private staging folder.
        bpy.ops.import_scene.fbx(filepath=str(source), use_image_search=False)
else:
    raise RuntimeError('Expected BLEND, GLB or FBX')
if bpy.data.libraries:
    raise RuntimeError('Linked libraries must be made local before rendering')

missing = []
for image in bpy.data.images:
    if image.type == 'RENDER_RESULT' or image.source == 'VIEWER':
        continue
    if image.packed_file or image.source == 'GENERATED':
        continue
    if image.source != 'FILE':
        raise RuntimeError('Unsupported animated or external texture: ' + image.name)
    basename = image_name(image.filepath)
    matches = [item for item in q['files'] if image_name(item['original']) == basename]
    if len(matches) > 1:
        raise RuntimeError('Ambiguous registered texture filename: ' + image.name)
    current = pathlib.Path(bpy.path.abspath(image.filepath)).resolve()
    if not current.is_file() or not current.is_relative_to(input_root):
        if len(matches) != 1:
            missing.append(image.name)
            continue
        current = pathlib.Path(matches[0]['local'])
    image.filepath = str(current)
    image.reload()
    if min(image.size) < 1:
        missing.append(image.name)
if missing:
    raise RuntimeError('Textures must be packed or explicitly declared: ' + ', '.join(missing))

meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
if not meshes:
    raise RuntimeError('Accepted source contains no mesh')
scene = bpy.data.scenes.new('Partsmith_Graphics_Motion_Input')
bpy.context.window.scene = scene
objects = set(meshes)
for obj in meshes:
    parent = obj.parent
    while parent:
        objects.add(parent)
        parent = parent.parent
    for modifier in obj.modifiers:
        if modifier.type == 'ARMATURE' and modifier.object:
            objects.add(modifier.object)
for obj in objects:
    scene.collection.objects.link(obj)
    obj.hide_render = False
    obj.hide_set(False)
    if obj.type == 'ARMATURE':
        obj.data.pose_position = 'REST'
scene.frame_set(0)
bpy.context.view_layer.update()
deps = bpy.context.evaluated_depsgraph_get()
points = []
for obj in meshes:
    evaluated = obj.evaluated_get(deps)
    points.extend(evaluated.matrix_world @ vertex.co for vertex in evaluated.data.vertices)
if not points or any(not math.isfinite(value) for point in points for value in point):
    raise RuntimeError('Invalid evaluated model bounds')
low = Vector(tuple(min(point[index] for point in points) for index in range(3)))
high = Vector(tuple(max(point[index] for point in points) for index in range(3)))
center = (low + high) * .5
size = max(high - low)
if size <= 0:
    raise RuntimeError('Empty model bounds')

scene.render.engine = 'CYCLES'
scene.cycles.samples = 32
scene.cycles.use_denoising = True
scene.render.resolution_x = scene.render.resolution_y = 2048
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.film_transparent = False
scene.view_settings.view_transform = 'Standard'
scene.world = bpy.data.worlds.new('Partsmith_Neutral_World')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (.7, .7, .7, 1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = .8

def aim(obj):
    obj.rotation_euler = (center - obj.location).to_track_quat('-Z', 'Y').to_euler()

for index, delta in enumerate(((3, -2, 4), (-3, -2, 4), (3, 2, 4), (-3, 2, 4))):
    data = bpy.data.lights.new('Motion_Light_' + str(index), 'AREA')
    data.energy = 100 * size * size
    data.shape = 'DISK'
    data.size = size * 3
    obj = bpy.data.objects.new(data.name, data)
    scene.collection.objects.link(obj)
    obj.location = center + Vector(delta) * size
    aim(obj)
data = bpy.data.cameras.new('Motion_Camera')
camera = bpy.data.objects.new(data.name, data)
scene.collection.objects.link(camera)
scene.camera = camera
data.type = 'ORTHO'
data.ortho_scale = max(high.z - low.z, (high.y - low.y) if axis == 'X' else (high.x - low.x)) * 1.4
data.clip_start = size * .001
data.clip_end = size * 20
views = []
for view, sign in (('left', 1), ('right', -1)):
    camera.location = center + Vector((sign, 0, 0) if axis == 'X' else (0, sign, 0)) * size * 4
    aim(camera)
    bpy.context.view_layer.update()
    projected = [world_to_camera_view(scene, camera, point) for point in points]
    limits = [min(point.x for point in projected), max(point.x for point in projected), min(point.y for point in projected), max(point.y for point in projected)]
    if limits[0] < .09 or limits[1] > .91 or limits[2] < .09 or limits[3] > .91 or any(point.z <= 0 for point in projected):
        raise RuntimeError('Full body framing failed')
    scene.render.filepath = str(output / (view + '.png'))
    bpy.ops.render.render(write_still=True)
    views.append({'view': view, 'projectedBounds': limits, 'sha256': hashlib.sha256((output / (view + '.png')).read_bytes()).hexdigest()})
for item in q['files']:
    if hashlib.sha256(pathlib.Path(item['local']).read_bytes()).hexdigest() != item['sha256']:
        raise RuntimeError('Source changed while rendering')
(output / 'render.json').write_text(json.dumps({'schemaVersion': 1, 'identity': q['identity'], 'source': 'accepted-model-render',
    'sourceSha256': q['sourceSha256'], 'axis': axis, 'resolution': [2048, 2048], 'restPose': True, 'originalPreserved': True,
    'fullBodyInFrame': True, 'missingImages': missing, 'meshCount': len(meshes), 'vertexCount': len(points),
    'bounds': {'min': list(low), 'max': list(high)}, 'views': views, 'materialsAuthored': False, 'motionAuthored': False}, indent=2), encoding='utf8')
