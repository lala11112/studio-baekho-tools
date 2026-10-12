"""Inspect the saved real API pilot .blend without changing it or running generation."""
import bpy
import hashlib
import json
import os
import sys
from mathutils import Vector

repo = sys.argv[sys.argv.index("--") + 1]
evidence = json.load(open(os.path.join(repo, "artifacts/runtime/graphics-api-live.json"), encoding="utf8"))
root = os.path.join(evidence["profile"], "projects", evidence["projectId"])
workspace = json.load(open(os.path.join(root, "graphics/workspace.json"), encoding="utf8"))
version_id = evidence["stages"]["X04"]["versionIds"][0]
version = next(v for v in workspace["versions"] if v["id"] == version_id)
source_file = next(f for f in version["files"] if f["path"].endswith(".blend"))
source = os.path.join(root, source_file["path"])
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
assert sha(source) == source_file["sha256"]
bpy.ops.wm.open_mainfile(filepath=source)
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
assert meshes
report = {"sourceSha256": sha(source), "vertices": sum(len(o.data.vertices) for o in meshes),
          "polygons": sum(len(o.data.polygons) for o in meshes),
          "triangles": sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes),
          "uvLayers": {o.name: len(o.data.uv_layers) for o in meshes},
          "images": [{"name": i.name, "size": list(i.size), "packed": bool(i.packed_file)} for i in bpy.data.images if i.type == "IMAGE"],
          "materials": [m.name for m in bpy.data.materials if m.users]}
assert all(o.data.uv_layers for o in meshes)
assert report["images"] and all(i["size"][0] > 0 for i in report["images"])
points = [o.matrix_world @ Vector(corner) for o in meshes for corner in o.bound_box]
low = Vector([min(p[i] for p in points) for i in range(3)])
high = Vector([max(p[i] for p in points) for i in range(3)])
center, extent = (low + high) / 2, max(high - low)
camera_data = bpy.data.cameras.new("EvidenceCamera")
camera = bpy.data.objects.new("EvidenceCamera", camera_data)
bpy.context.scene.collection.objects.link(camera)
thin_axis = min(range(3), key=lambda i: high[i] - low[i])
direction = Vector((0, 0, 0)); direction[thin_axis] = 3 * extent
camera.location = center + direction
camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
camera_data.type, camera_data.ortho_scale = "ORTHO", extent * 1.2
bpy.context.scene.camera = camera
for offset, energy in [((1, -2, 2), 350), ((-2, -1, -1), 200)]:
    data = bpy.data.lights.new("EvidenceLight", "AREA"); data.energy = energy; data.shape = "DISK"; data.size = extent * 2
    light = bpy.data.objects.new(data.name, data); bpy.context.scene.collection.objects.link(light)
    light.location = center + Vector(offset) * extent
    light.rotation_euler = (center - light.location).to_track_quat("-Z", "Y").to_euler()
scene = bpy.context.scene
scene.render.engine = "CYCLES"; scene.cycles.samples = 24; scene.cycles.use_denoising = True
scene.render.resolution_x = 700; scene.render.resolution_y = 1000; scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
if scene.world is None:
    scene.world = bpy.data.worlds.new("EvidenceWorld")
scene.world.color = (0.15, 0.15, 0.15)
scene.render.filepath = os.path.join(repo, "artifacts/runtime/graphics-api-sword.png")
bpy.ops.render.render(write_still=True)
assert sha(source) == report["sourceSha256"]
report["originalPreserved"] = True
with open(os.path.join(repo, "artifacts/runtime/graphics-api-assets.json"), "w", encoding="utf8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print(json.dumps(report, ensure_ascii=False))
