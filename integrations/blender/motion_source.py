"""Render the accepted character from opposite sides without saving/modifying its blend."""
import bpy, sys, os, json, math
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

source, output, axis = sys.argv[sys.argv.index('--') + 1:]
if axis not in ('X', 'Y'):
    raise RuntimeError('Invalid side axis')
bpy.ops.wm.open_mainfile(filepath=source, load_ui=False, use_scripts=False)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH' and o.get('partsmith_id')]
if not meshes:
    raise RuntimeError('No accepted character mesh IDs')
missing = [i.name for i in bpy.data.images if i.source == 'FILE' and not i.packed_file and not os.path.isfile(bpy.path.abspath(i.filepath))]
if missing:
    raise RuntimeError('Missing textures: ' + ', '.join(missing))
scene = bpy.data.scenes.new('Partsmith_Motion_Input')
bpy.context.window.scene = scene
objects = set(meshes)
for obj in meshes:
    parent = obj.parent
    while parent:
        objects.add(parent)
        parent = parent.parent
    for mod in obj.modifiers:
        if mod.type == 'ARMATURE' and mod.object:
            objects.add(mod.object)
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
    points.extend(evaluated.matrix_world @ v.co for v in evaluated.data.vertices)
if not points or any(not math.isfinite(n) for p in points for n in p):
    raise RuntimeError('Invalid accepted geometry')
lo = Vector(tuple(min(p[i] for p in points) for i in range(3)))
hi = Vector(tuple(max(p[i] for p in points) for i in range(3)))
center = (lo + hi) * .5
size = max(hi - lo)
if size <= 0:
    raise RuntimeError('Empty geometry bounds')
scene.render.engine = 'CYCLES'
scene.cycles.samples = 64
scene.cycles.use_denoising = True
scene.render.resolution_x = scene.render.resolution_y = 2048
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.film_transparent = False
scene.view_settings.view_transform = 'Standard'
scene.world = bpy.data.worlds.new('Partsmith_Neutral_World')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (.7,.7,.7,1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = .8
def aim(obj):
    obj.rotation_euler = (center - obj.location).to_track_quat('-Z', 'Y').to_euler()
for i, delta in enumerate(((3,-2,4),(-3,-2,4),(0,3,3))):
    data = bpy.data.lights.new('Motion_Light_'+str(i), 'AREA')
    data.energy = 180 * size * size
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
data.ortho_scale = max(hi.z-lo.z, (hi.y-lo.y) if axis=='X' else (hi.x-lo.x)) * 1.3
data.clip_start = size * .001
data.clip_end = size * 20
checks = []
for view, sign in (('left',1), ('right',-1)):
    direction = Vector((sign,0,0) if axis=='X' else (0,sign,0))
    camera.location = center + direction * size * 4
    aim(camera)
    bpy.context.view_layer.update()
    projected = [world_to_camera_view(scene,camera,p) for p in points]
    limits = [min(p.x for p in projected),max(p.x for p in projected),min(p.y for p in projected),max(p.y for p in projected)]
    if limits[0] < .09 or limits[1] > .91 or limits[2] < .09 or limits[3] > .91:
        raise RuntimeError('Full body framing failed')
    scene.render.filepath = os.path.join(output, view+'.png')
    bpy.ops.render.render(write_still=True)
    checks.append({'view':view,'projectedBounds':limits})
with open(os.path.join(output,'render.json'),'w',encoding='utf-8') as f:
    json.dump({'source':'accepted-rig-render','axis':axis,'resolution':[2048,2048],'restPose':True,'fullBodyInFrame':True,'missingImages':missing,'meshIds':[o['partsmith_id'] for o in meshes],'views':checks}, f, indent=2)
