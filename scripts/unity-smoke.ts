import fs from "node:fs";
import path from "node:path";
import { Store } from "../engine/store";
import { LocalPipeline } from "../engine/local";
const store = new Store(path.resolve("artifacts/runtime/electron-smoke"));
await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
const p = store.projects().find((x) => x.demo && x.builds.length)!;
if (!p) throw Error("Run Electron smoke first.");
const pipeline = new LocalPipeline(store, path.resolve("integrations"));
console.log(pipeline.install(p.id));
const build = process.argv.includes("--rebuild")
  ? await pipeline.build(p.id, "demo-rig")
  : p.builds.at(-1)!;
const q = pipeline.importUnity(p.id, build.id);
console.log(q);
fs.writeFileSync(
  "artifacts/unity-request.json",
  JSON.stringify({ projectId: p.id, ...q }, null, 2),
);
