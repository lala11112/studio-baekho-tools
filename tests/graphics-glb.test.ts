import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PNG } from "pngjs";

const blender = process.env.PARTSMITH_TEST_BLENDER;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const blenderDirectory = path.resolve("integrations/blender");
function run(script: string, spec: string) {
  const result = spawnSync(blender!, ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python", script, "--", spec], { encoding: "utf8", windowsHide: true, timeout: 240_000, maxBuffer: 4_000_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
function embedded(file: string) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.toString("ascii", 0, 4), "glTF");
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const length = bytes.readUInt32LE(12), document = JSON.parse(bytes.toString("utf8", 20, 20 + length));
  const start = 28 + length;
  assert.equal(bytes.readUInt32LE(start - 4), 0x004e4942);
  assert.equal(document.buffers.length, 1);
  assert.equal(document.buffers[0].uri, undefined);
  return document.images.map((image: any) => {
    assert.equal(image.uri, undefined, "An embedded image must never retain an external URI");
    const view = document.bufferViews[image.bufferView];
    assert.equal(view.buffer, 0);
    const data = bytes.subarray(start + (view.byteOffset ?? 0), start + (view.byteOffset ?? 0) + view.byteLength);
    return { ...image, data, sha256: hash(data) };
  }) as { name: string; mimeType: string; data: Buffer; sha256: string }[];
}
function png(file: string, size: number, color: number[]) {
  const image = new PNG({ width: size, height: size });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = color[0]; image.data[i + 1] = color[1]; image.data[i + 2] = color[2]; image.data[i + 3] = 255;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(image));
}

test("real Blender GLB keeps exact 4K JPG/PNG bytes, composes ORM channels and refuses overwrite", { skip: !blender, timeout: 240_000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-glb-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  png(path.join(root, "color.png"), 4096, [100, 70, 20]);
  png(path.join(root, "normal.png"), 4096, [128, 128, 255]);
  png(path.join(root, "rough/shared.png"), 32, [60, 30, 10]);
  png(path.join(root, "metal/shared.png"), 32, [190, 130, 90]);
  const fixture = path.join(root, "fixture.py"), spec = path.join(root, "spec.json");
  fs.writeFileSync(spec, JSON.stringify({ root, helper: blenderDirectory }));
  fs.writeFileSync(fixture, `import bpy,json,pathlib,sys,hashlib
q=json.loads(pathlib.Path(sys.argv[sys.argv.index('--')+1]).read_text())
root=pathlib.Path(q['root']);sys.path.insert(0,q['helper'])
from graphics_glb import export_packed_glb
bpy.ops.wm.read_factory_settings(use_empty=True)
image=bpy.data.images.load(str(root/'color.png'));bpy.context.scene.render.image_settings.file_format='JPEG';image.save_render(filepath=str(root/'color.jpg'));bpy.data.images.remove(image)
bpy.ops.mesh.primitive_cube_add();mesh=bpy.context.object
material=bpy.data.materials.new('Original');material.use_nodes=True;mesh.data.materials.append(material)
nodes=material.node_tree.nodes;links=material.node_tree.links;bsdf=nodes.get('Principled BSDF')
def texture(file,noncolor=False):
 image=bpy.data.images.load(str(root/file));image.pack()
 if noncolor:image.colorspace_settings.name='Non-Color'
 node=nodes.new('ShaderNodeTexImage');node.image=image;return node
base=texture('color.jpg');links.new(base.outputs['Color'],bsdf.inputs['Base Color'])
normal=texture('normal.png',True);n=nodes.new('ShaderNodeNormalMap');links.new(normal.outputs['Color'],n.inputs['Color']);links.new(n.outputs['Normal'],bsdf.inputs['Normal'])
for filename,socket in [('rough/shared.png','Roughness'),('metal/shared.png','Metallic')]:
 node=texture(filename,True);sep=nodes.new('ShaderNodeSeparateColor');links.new(node.outputs['Color'],sep.inputs['Color']);links.new(sep.outputs['Red'],bsdf.inputs[socket])
bpy.ops.wm.save_as_mainfile(filepath=str(root/'source.blend'),compress=False)
before=[(image.name,image.filepath,hashlib.sha256(bytes(image.packed_file.data)).hexdigest()) for image in bpy.data.images]
records=export_packed_glb(root/'asset.glb',use_selection=True,export_animations=True)
after=[(image.name,image.filepath,hashlib.sha256(bytes(image.packed_file.data)).hexdigest()) for image in bpy.data.images]
assert before==after
try:export_packed_glb(root/'asset.glb',use_selection=True)
except RuntimeError:pass
else:raise RuntimeError('Existing output was overwritten')
(root/'images.json').write_text(json.dumps(records))
`);
  run(fixture, spec);
  const images = embedded(path.join(root, "asset.glb"));
  assert.equal(images.length, 3);
  for (const name of ["color.jpg", "normal.png"]) {
    const original = fs.readFileSync(path.join(root, name));
    const image = images.find(item => item.sha256 === hash(original));
    assert.ok(image, `${name} original compressed bytes were changed: ${original.subarray(0, 12).toString("hex")} / ${fs.readFileSync(path.join(root, "images.json"), "utf8")}`);
    assert.deepEqual(image.data, original);
  }
  const evidence = JSON.parse(fs.readFileSync(path.join(root, "images.json"), "utf8"));
  assert.equal(evidence.filter((item: any) => item.mode === "original" && item.size[0] === 4096 && item.size[1] === 4096).length, 2);
  const composed = evidence.find((item: any) => item.mode === "composed");
  assert.ok(composed);
  const orm = PNG.sync.read(images.find(item => item.sha256 === composed.sha256)!.data);
  assert.equal(orm.width, 32); assert.equal(orm.height, 32);
  assert.ok(Math.abs(orm.data[1] - 60) <= 1, `Roughness G=${orm.data[1]}`);
  assert.ok(Math.abs(orm.data[2] - 190) <= 1, `Metallic B=${orm.data[2]}`);
  // Exercise the actual local X04 entrypoint, not only the helper.
  const originalBlend = hash(fs.readFileSync(path.join(root, "source.blend")));
  const local = path.join(root, "local.json"), output = path.join(root, "local-output");
  fs.writeFileSync(local, JSON.stringify({ source: path.join(root, "source.blend"), output, operation: "X04", scale: 1, pivot: "keep", format: "glb", identity: "fresh-independent-test" }));
  run(path.join(blenderDirectory, "graphics_local.py"), local);
  assert.equal(hash(fs.readFileSync(path.join(root, "source.blend"))), originalBlend);
  assert.deepEqual(embedded(path.join(output, "asset.glb")).map(item => item.sha256).sort(), images.map(item => item.sha256).sort());
});

test("copied production packed blend exports full-resolution original image bytes without changing saved artifacts", { skip: !blender || !process.env.PARTSMITH_TEST_GRAPHICS_BLEND, timeout: 240_000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-glb-original-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidence: unknown[] = [];
  for (const [index, original] of process.env.PARTSMITH_TEST_GRAPHICS_BLEND!.split(";").entries()) {
    const before = hash(fs.readFileSync(original)), source = path.join(root, `source-${index}.blend`);
    fs.copyFileSync(original, source);
    const output = path.join(root, `output-${index}`), spec = path.join(root, `spec-${index}.json`);
    fs.writeFileSync(spec, JSON.stringify({ source, output, operation: "X04", scale: 1, pivot: "keep", format: "glb", identity: `isolated-${index}` }));
    run(path.join(blenderDirectory, "graphics_local.py"), spec);
    const images = embedded(path.join(output, "asset.glb"));
    const report = JSON.parse(fs.readFileSync(path.join(output, "report.json"), "utf8"));
    const originals = report.files.filter((file: string) => file.startsWith("textures/")).map((file: string) => hash(fs.readFileSync(path.join(output, file))));
    assert.equal(originals.length, 3);
    assert.equal(images.length, 3);
    assert.deepEqual(images.map(item => item.sha256).sort(), originals.sort());
    assert.ok(report.glbImages.every((item: any) => item.mode === "original" && item.size[0] === 4096 && item.size[1] === 4096));
    assert.equal(hash(fs.readFileSync(source)), before);
    assert.equal(hash(fs.readFileSync(original)), before);
    evidence.push({ source: original, sourceSha256: before, originalPreserved: true,
      glbSha256: hash(fs.readFileSync(path.join(output, "asset.glb"))), selfContained: true,
      allOriginalImageBytesPreserved: true, images: report.glbImages });
  }
  if (process.env.PARTSMITH_TEST_GRAPHICS_GLB_EVIDENCE)
    fs.writeFileSync(process.env.PARTSMITH_TEST_GRAPHICS_GLB_EVIDENCE, JSON.stringify({ checkedAt: new Date().toISOString(), copiedSourcesOnly: true, evidence }, null, 2));
});
