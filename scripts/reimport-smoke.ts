import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { Store } from "../engine/store";
import { LocalPipeline } from "../engine/local";
const store = new Store(path.resolve("artifacts/runtime/electron-smoke"));
await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
const fixture = JSON.parse(
  fs.readFileSync("artifacts/electron-smoke.json", "utf8"),
);
let p = store.project(fixture.projectId);
const pipeline = new LocalPipeline(store, path.resolve("integrations"));
const folder = path.join(p.unityPath, "Assets", p.unityFolder, p.id);
const hash = (f: string) =>
  crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const prefab = path.join(folder, "Generated/Character.prefab.meta");
const variant = path.join(folder, "User/Character.prefab");
const before = {
  meta: hash(prefab),
  variant: hash(variant),
  variantMeta: hash(variant + ".meta"),
};
const original = p.builds.filter((b) => b.mode === "demo-rig").at(-1)!;
p.height = 1.8;
p.revision++;
store.save(p);
const candidate = await pipeline.build(p.id, "demo-rig");
p = store.project(p.id);
p.parts[0].candidates = [original.id, candidate.id];
p.parts[0].selectedId = candidate.id;
p.parts[0].transform.position = [0.15, 0, 0];
p.parts[0].transform.rotation = [0, 12, 0];
p.parts.slice(1).forEach((x) => (x.visible = false));
p.revision++;
store.save(p);
const assembled = await pipeline.build(p.id, "assemble");
const assembledReport = JSON.parse(
  fs.readFileSync(store.file(p.id, assembled.report), "utf8"),
);
assert.equal(
  assembledReport.meshes,
  16,
  "Unexpected helper mesh in the character export",
);
const request = pipeline.importUnity(p.id, assembled.id);
console.log(
  "Replacement candidate assembled; waiting for Unity",
  request.requestId,
);
const resultFile = path.join(
  p.unityPath,
  "Library/PartsmithResults",
  request.requestId + ".json",
);
let result: any;
for (let i = 0; i < 90; i++) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (fs.existsSync(resultFile)) {
    result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    if (
      result.runtimePlayModeVerified ||
      result.errors.length ||
      !result.clips.length
    )
      break;
  }
}
assert(result, "Unity did not return a result");
assert.equal(result.errors.length, 0);
assert(result.avatarValid && result.avatarHuman);
assert(
  result.runtimePlayModeVerified,
  "Unity Play Mode did not verify all clips",
);
assert.equal(hash(prefab), before.meta, "Generated prefab GUID changed");
assert.equal(hash(variant), before.variant, "User variant changed");
assert.equal(
  hash(variant + ".meta"),
  before.variantMeta,
  "User variant GUID changed",
);
assert.equal(
  fs
    .readdirSync(path.join(folder, "Generated"))
    .filter((f) => f.endsWith(".prefab")).length,
  1,
);
pipeline.result(p.id);
fs.copyFileSync(resultFile, "artifacts/unity-result.json");
if (fs.existsSync(resultFile.replace(".json", ".png")))
  fs.copyFileSync(
    resultFile.replace(".json", ".png"),
    "artifacts/screenshots/unity-play-mode.png",
  );
fs.writeFileSync(
  "artifacts/reimport-smoke.json",
  JSON.stringify(
    {
      passed: true,
      projectId: p.id,
      requestId: request.requestId,
      revision: p.revision,
      candidateReplaced: true,
      transformChanged: true,
      blenderAssembly: true,
      prefabGuidPreserved: true,
      userVariantPreserved: true,
      noDuplicatePrefab: true,
      ...result,
    },
    null,
    2,
  ),
);
console.log("Candidate replacement and Unity reimport passed.");
