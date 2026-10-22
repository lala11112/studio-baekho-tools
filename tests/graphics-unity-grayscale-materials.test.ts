import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { prepareUnityDelivery, readUnityTarget } from '../engine/graphics-unity';
import type { AssetVersion, GraphicsObject } from '../shared/graphics';

const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const put = (root: string, name: string, value: string | Buffer) => {
  const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file;
};

test('real Blender direct grayscale scalar maps preserve originals and every native 4K metallic/smoothness pixel; colored and sRGB inputs remain unsupported', { timeout: 180_000 }, async t => {
  const blender = process.env.PARTSMITH_TEST_BLENDER;
  if (!blender || !fs.existsSync(blender)) { t.skip('Set PARTSMITH_TEST_BLENDER for real material conversion'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-grayscale-material-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });
  const project = path.join(root, 'source'); fs.mkdirSync(project);
  const size = 4096;
  // Asymmetric rows/columns exercise packing orientation as well as all 256 byte values.
  const metallicAt = (x: number) => x === 0 ? 51 : x === size - 1 ? 204 : x % 256;
  const roughnessAt = (y: number) => y === 0 ? 64 : y === size - 1 ? 192 : y % 256;
  for (const name of ['first.png', 'second.png', 'colored.png']) {
    const png = new PNG({ width: size, height: size });
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4, value = name === 'second.png' ? roughnessAt(y) : metallicAt(x);
      png.data[offset] = png.data[offset + 1] = png.data[offset + 2] = value; png.data[offset + 3] = 255;
    }
    // One unequal component far from the borders must reject the whole direct scalar image.
    if (name === 'colored.png') png.data[(2048 * size + 2048) * 4 + 1] = 1;
    put(project, name, PNG.sync.write(png));
  }
  const setup = put(root, 'setup.py', String.raw`
import bpy,pathlib,sys
p=pathlib.Path(sys.argv[sys.argv.index('--')+1])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add()
material=bpy.data.materials.new('DirectGrayscale');material.use_nodes=True
bpy.context.object.data.materials.append(material)
nodes=material.node_tree.nodes;links=material.node_tree.links;bsdf=nodes.get('Principled BSDF')
bsdf.inputs['Emission Strength'].default_value=0
def image(name):
 value=bpy.data.images.load(str(p/name));value.colorspace_settings.name='Non-Color';value.pack()
 node=nodes.new('ShaderNodeTexImage');node.image=value;return node
metallic=image('first.png');roughness=image('second.png')
links.new(metallic.outputs['Color'],bsdf.inputs['Metallic'])
links.new(roughness.outputs['Color'],bsdf.inputs['Roughness'])
bpy.ops.wm.save_as_mainfile(filepath=str(p/'supported.blend'),compress=False)
original=metallic.image
bad=bpy.data.images.load(str(p/'colored.png'));bad.colorspace_settings.name='Non-Color';bad.pack();metallic.image=bad
bpy.ops.wm.save_as_mainfile(filepath=str(p/'colored.blend'),compress=False)
metallic.image=original;original.colorspace_settings.name='sRGB'
bpy.ops.wm.save_as_mainfile(filepath=str(p/'srgb.blend'),compress=False)
`);
  const run = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', setup, '--', project], { encoding: 'utf8', timeout: 90_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const originals = Object.fromEntries(fs.readdirSync(project).map(name => [name, sha(path.join(project, name))]));
  const object: GraphicsObject = { id: 'grayscale-object', name: 'Fixture', kind: 'prop', createdAt: 'fixture', selectedTasks: [], instruction: '', settings: {}, references: [], accepted: {} };
  async function convert(name: string) {
    const unity = path.join(root, 'unity-' + name); fs.mkdirSync(path.join(unity, 'Assets'), { recursive: true });
    put(unity, 'ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.3.21f1\n');
    put(unity, 'ProjectSettings/GraphicsSettings.asset', 'GraphicsSettings:\n  m_CustomRenderPipeline: {fileID: 0}\n');
    put(unity, 'ProjectSettings/QualitySettings.asset', 'QualitySettings:\n  m_CurrentQuality: 0\n  m_QualitySettings:\n  - serializedVersion: 4\n    customRenderPipeline: {fileID: 0}\n  m_PerPlatformDefaultQuality:\n    Standalone: 0\n');
    put(unity, 'Packages/manifest.json', '{"dependencies":{}}');
    const file = path.join(project, name + '.blend');
    const version: AssetVersion = { id: name, objectId: object.id, role: 'model', slot: 'main', label: name, createdAt: 'fixture', sourceVersionIds: [], provenance: { type: 'import' }, warnings: [], files: [{ path: name + '.blend', sha256: sha(file), bytes: fs.statSync(file).size, kind: 'blend' }] };
    const delivery = await prepareUnityDelivery({ projectRoot: project, object, versions: [version], profile: readUnityTarget(unity), blenderPath: blender!, resources: path.resolve('integrations') });
    assert.equal(delivery.status, 'queued', delivery.errors.join('\n'));
    const request = JSON.parse(fs.readFileSync(path.join(unity, 'Library/PartsmithGraphicsStaging', delivery.id, 'request.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(request.files.find((entry: any) => entry.destination === request.materialManifest).source, 'utf8'));
    assert.equal(fs.existsSync(path.join(unity, delivery.destination)), false, 'Conversion only queues; it must not launch Unity');
    return { request, manifest };
  }
  const { request, manifest } = await convert('supported');
  const binding = manifest.materials[0]; assert.equal(binding.supported, true, binding.warning);
  assert.equal(binding.metallicSource.channel, 'GRAYSCALE'); assert.equal(binding.roughnessSource.channel, 'GRAYSCALE');
  assert.equal(manifest.originalImages.length, 2); assert.equal(manifest.derivedImages.length, 1);
  for (const image of manifest.originalImages) {
    const entry = request.files.find((entry: any) => entry.destination.endsWith('/' + image.path));
    assert.equal(sha(entry.source), image.sha256); assert.ok(Object.values(originals).includes(image.sha256));
    assert.equal(image.width, size); assert.equal(image.height, size);
  }
  const derived = request.files.find((entry: any) => entry.destination.endsWith('/' + binding.metallicGlossTexture));
  const png = PNG.sync.read(fs.readFileSync(derived.source)); assert.equal(png.width, size); assert.equal(png.height, size);
  let mismatch = '';
  for (let y = 0; y < size && !mismatch; y++) for (let x = 0; x < size; x++) {
    const offset = (y * size + x) * 4;
    if (png.data[offset] !== metallicAt(x) || png.data[offset + 1] !== 0 || png.data[offset + 2] !== 0 || png.data[offset + 3] !== 255 - roughnessAt(y)) { mismatch = x + ',' + y; break; }
  }
  assert.equal(mismatch, '', 'Every native pixel must pack metallic R / inverse roughness A exactly');
  const colored = (await convert('colored')).manifest;
  assert.equal(colored.materials[0].supported, false); assert.match(colored.materials[0].warning, /requires exactly equal RGB values/); assert.equal(colored.derivedImages.length, 0);
  const srgb = (await convert('srgb')).manifest;
  assert.equal(srgb.materials[0].supported, false); assert.match(srgb.materials[0].warning, /Unexpected color space.*sRGB/); assert.equal(srgb.derivedImages.length, 0);
  for (const [name, digest] of Object.entries(originals)) assert.equal(sha(path.join(project, name)), digest, 'Original bytes changed: ' + name);
});
