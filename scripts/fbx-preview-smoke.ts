import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Engine } from "../engine/engine";
import { LocalPipeline } from "../engine/local";
import { Store } from "../engine/store";
import { Tripo } from "../engine/tripo";

// Reproducible local-format test. No API key is loaded and no Tripo call is allowed.
const store = new Store(path.resolve("artifacts/runtime/fbx-preview-smoke"));
await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
let apiCalls = 0;
const tripo = new Tripo(
  () => "",
  async () => {
    apiCalls++;
    throw new Error("This smoke test must never call Tripo.");
  },
);
const engine = new Engine(store, tripo);
const project = engine.create("Local FBX preview smoke", true);
const local = new LocalPipeline(store, path.resolve("integrations"));
const build = await local.build(project.id, "demo-rig");
const native = "assets/native-demo.fbx";
store.write(
  project.id,
  native,
  fs.readFileSync(store.file(project.id, build.fbx)),
);
const digest = () =>
  createHash("sha256")
    .update(fs.readFileSync(store.file(project.id, native)))
    .digest("hex");
const before = digest();

const [preview, concurrentPreview] = await Promise.all([
  local.previewModel(project.id, native),
  local.previewModel(project.id, native),
]);
assert.equal(
  preview,
  concurrentPreview,
  "concurrent calls share the same derivative",
);
const previewPath = store.file(project.id, preview);
const firstModified = fs.statSync(previewPath).mtimeMs;
assert.equal(
  await local.previewModel(project.id, native),
  preview,
  "completed preview is reused",
);
assert.equal(
  fs.statSync(previewPath).mtimeMs,
  firstModified,
  "reuse does not rebuild the preview",
);
assert.equal(digest(), before, "native FBX must remain byte-identical");
await assert.rejects(
  () => local.previewModel(project.id, "../../outside.fbx"),
  /프로젝트 밖/,
);
assert.equal(apiCalls, 0);

const bytes = fs.readFileSync(previewPath);
assert.equal(bytes.subarray(0, 4).toString("ascii"), "glTF");
assert.equal(bytes.readUInt32LE(4), 2);
assert.equal(bytes.readUInt32LE(8), bytes.length);
assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, "GLB first chunk is JSON");
const gltf = JSON.parse(
  bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"),
);
const clips: string[] = (gltf.animations ?? []).map(
  (animation: { name: string }) => animation.name,
);
assert.equal(gltf.meshes.length, 16);
assert.equal(gltf.skins.length, 1);
assert(
  clips.some((clip) => /(^|\|)Idle$/.test(clip)),
  "Idle clip is retained",
);
assert(
  clips.some((clip) => /(^|\|)Walk$/.test(clip)),
  "Walk clip is retained",
);
const previewReport = JSON.parse(
  fs.readFileSync(previewPath.replace(/\.glb$/, ".report.json"), "utf8"),
);
assert.equal(previewReport.previewOnly, true);
assert(
  !fs.existsSync(previewPath.replace(/\.glb$/, ".fbx")),
  "preview must not export another native FBX",
);
assert(
  !fs.existsSync(previewPath.replace(/\.glb$/, ".blend")),
  "preview must not create an editing copy",
);

const report = {
  status: "passed",
  source: "local procedural demo FBX, not Tripo output",
  projectId: project.id,
  sourceUnchanged: true,
  preview,
  meshes: gltf.meshes.length,
  skins: gltf.skins.length,
  materials: gltf.materials.length,
  clips,
  previewOnly: true,
  duplicateAndTraversalChecks: true,
};
fs.writeFileSync(
  path.resolve("artifacts/fbx-preview-smoke.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
