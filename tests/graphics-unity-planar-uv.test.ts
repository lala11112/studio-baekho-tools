import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const blender =
    process.env.PARTSMITH_TEST_BLENDER ??
    "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe",
  sha = (file: string) =>
    createHash("sha256").update(fs.readFileSync(file)).digest("hex");
test(
  "Unity planar export uses exact active UV0 while editable original UV layers and bytes stay unchanged",
  { skip: !fs.existsSync(blender), timeout: 120000 },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-planar-unity-uv-"));
    t.after(() => {
      assert.equal(
        path.dirname(fs.realpathSync(root)),
        fs.realpathSync(os.tmpdir()),
      );
      fs.rmSync(root, { recursive: true, force: true });
    });
    const run = (script: string, args: string[] = []) => {
      const result = spawnSync(
        blender,
        [
          "--background",
          "--factory-startup",
          "--disable-autoexec",
          "--python-exit-code",
          "1",
          "--python",
          script,
          "--",
          ...args,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 60000 },
      );
      assert.equal(
        result.status,
        0,
        result.stdout.slice(-3000) + result.stderr.slice(-3000),
      );
    };
    const fixture = path.join(root, "fixture.py");
    fs.writeFileSync(
      fixture,
      `import bpy,pathlib,sys\np=pathlib.Path(sys.argv[sys.argv.index('--')+1]);bpy.ops.wm.read_factory_settings(use_empty=True);bpy.ops.mesh.primitive_cube_add();o=bpy.context.object\nfor old in list(o.data.uv_layers):o.data.uv_layers.remove(old)\nold=o.data.uv_layers.new(name='LegacyUV')\nfor corner in old.data:corner.uv=(0,0)\nuv=o.data.uv_layers.new(name='DeliveryUV');o.data.uv_layers.active=uv;uv.active_render=True\nfor face in o.data.polygons:\n for i,coord in zip(face.loop_indices,[(0,0),(1,0),(1,1),(0,1)]):uv.data[i].uv=coord\nbpy.ops.wm.save_as_mainfile(filepath=str(p/'synthetic.blend'),compress=False)\n`,
    );
    run(fixture, [root]);
    const sources = [
      { name: "synthetic", file: path.join(root, "synthetic.blend") },
    ];
    const appfile = "artifacts/runtime/graphics-planar-app.json";
    if (fs.existsSync(appfile)) {
      const app = JSON.parse(fs.readFileSync(appfile, "utf8"));
      const source = app.candidate?.files.find((f: any) =>
        f.path.endsWith(".blend"),
      );
      if (source) {
        const actual = path.join(
          app.fixture.profile,
          "projects",
          app.fixture.projectId,
          source.path,
        );
        assert.equal(sha(actual), source.sha256);
        fs.copyFileSync(actual, path.join(root, "actual.blend"));
        sources.push({ name: "actual", file: path.join(root, "actual.blend") });
      }
    }
    for (const source of sources) {
      const original = sha(source.file),
        out = path.join(root, source.name + "-export"),
        request = path.join(root, source.name + "-request.json");
      fs.writeFileSync(
        request,
        JSON.stringify({
          source: source.file,
          inputRoot: root,
          files: [{ local: source.file, sha256: original }],
          output: out,
          optimization: {
            lodEnabled: false,
            lodRatio: 0.5,
            collider: "none",
            deliveryTextureSize: 0,
            deliveryCompression: "none",
          },
          clipSettings: [],
          physicalSize: {
            mode: "keep",
            axis: "y",
            lengthMeters: 1,
            dimensionsMeters: { x: 1, y: 1, z: 1 },
            pivot: "keep",
          },
          activeUvOnly: true,
        }),
      );
      run(path.resolve("integrations/blender/graphics_prepare.py"), [request]);
      assert.equal(sha(source.file), original);
      const report = JSON.parse(
        fs.readFileSync(path.join(out, "inspection.json"), "utf8"),
      );
      assert(report.exportUv.length > 0);
      assert(
        report.exportUv.every(
          (m: any) => m.uv0MatchesActive && m.sourceLayersPreserved,
        ),
      );
      const check = path.join(root, source.name + "-check.py");
      fs.writeFileSync(
        check,
        `import bpy,pathlib,sys,json\np=pathlib.Path(sys.argv[sys.argv.index('--')+1]);source=pathlib.Path(sys.argv[sys.argv.index('--')+2]);bpy.ops.wm.open_mainfile(filepath=str(source),load_ui=False,use_scripts=False);original=[(o.name,[l.name for l in o.data.uv_layers],o.data.uv_layers.active.name) for o in bpy.context.scene.objects if o.type=='MESH'];expected=[]\nfor o in bpy.context.scene.objects:\n if o.type=='MESH':\n  o.data.calc_loop_triangles();layer=o.data.uv_layers.active\n  for t in o.data.loop_triangles:expected.append(sorted(tuple(round(v,5) for v in layer.data[i].uv) for i in t.loops))\nbpy.ops.wm.read_factory_settings(use_empty=True);bpy.ops.import_scene.fbx(filepath=str(p/'Asset.fbx'),use_image_search=False);triangles=[];invalid=0\nfor o in bpy.context.scene.objects:\n if o.type=='MESH':\n  assert len(o.data.uv_layers)==1,'FBX UV0 is ambiguous';o.data.calc_loop_triangles();layer=o.data.uv_layers[0]\n  for t in o.data.loop_triangles:\n   uv=[tuple(layer.data[i].uv) for i in t.loops];a,b,c=uv;invalid+=abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))<=1e-12;triangles.append(sorted(tuple(round(v,5) for v in pair) for pair in uv))\nassert invalid==0,'export UV0 contains degenerate triangles';assert sorted(expected)==sorted(triangles),'FBX UV0 differs from exact editable active UV';(p/'uv-check.json').write_text(json.dumps({'passed':True,'triangles':len(triangles),'invalidUVTriangles':invalid,'editableLayers':original}))\n`,
      );
      run(check, [out, source.file]);
      assert.equal(sha(source.file), original);
      const checked = JSON.parse(
        fs.readFileSync(path.join(out, "uv-check.json"), "utf8"),
      );
      assert.equal(checked.invalidUVTriangles, 0);
      assert(checked.editableLayers.every((m: any) => m[1].length >= 2));
      if (source.name === "actual") {
        fs.writeFileSync(
          "artifacts/runtime/graphics-planar-unity-uv-export.json",
          JSON.stringify(
            {
              sourceSha256: original,
              converterSha256: sha(
                path.resolve("integrations/blender/graphics_prepare.py"),
              ),
              ...checked,
            },
            null,
            2,
          ),
        );
      }
    }
  },
);
