/** Immutable chest copies in an isolated profile; never writes the production profile. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Store } from "../engine/store";
import { Engine } from "../engine/engine";
import { defaultCreation } from "../shared/graphics-creation";
import type { GraphicsWorkspace, AssetVersion } from "../shared/graphics";

const evidence = path.resolve("artifacts/runtime/graphics-planar-fixture.json");
assert(
  !fs.existsSync(evidence),
  "Reuse the recorded fixture; do not create repeated copies",
);
const baseline = JSON.parse(
  fs.readFileSync("artifacts/runtime/graphics-planar-production.json", "utf8"),
);
const production = baseline.before.records.find(
  (r: any) =>
    r.kind === "graphics" && r.id === "caae83af-1e58-4340-b419-3d155c01030b",
).data as GraphicsWorkspace;
const ids = [
  "7d228d37-240d-4fcb-91c8-e1cf81fc801a",
  "69e5699a-2530-4e49-b65f-c6c94bb068f4",
];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-planar-chest-")),
  profile = path.join(root, "profile"),
  unity = path.join(root, "Unity");
const sha = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const put = (relative: string, content: string) => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
fs.mkdirSync(path.join(unity, "Assets"), { recursive: true });
put(
  "Unity/ProjectSettings/ProjectVersion.txt",
  "m_EditorVersion: 6000.3.21f1\n",
);
put(
  "Unity/Packages/manifest.json",
  JSON.stringify(
    {
      dependencies: {
        "com.unity.render-pipelines.universal": "17.3.0",
        "com.unity.modules.animation": "1.0.0",
        "com.unity.modules.imageconversion": "1.0.0",
        "com.unity.modules.jsonserialize": "1.0.0",
        "com.unity.modules.physics": "1.0.0",
        "com.unity.modules.uielements": "1.0.0",
      },
    },
    null,
    2,
  ),
);
const reference = "C:/Unity/3D Tool Test";
fs.cpSync(
  path.join(reference, "Assets/Settings"),
  path.join(unity, "Assets/Settings"),
  { recursive: true },
);
for (const name of ["GraphicsSettings.asset", "QualitySettings.asset"])
  fs.copyFileSync(
    path.join(reference, "ProjectSettings", name),
    path.join(unity, "ProjectSettings", name),
  );
const store = new Store(profile);
await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
store.settings = { ...store.settings, unityPath: unity };
const project = new Engine(store, {} as any).create(
  "누락 평면 검증 · 상자 원본 복사본",
);
const sourceRoot = path.join(
    process.env.APPDATA!,
    "partsmith",
    "projects",
    production.projectId,
  ),
  copies: AssetVersion[] = [];
for (const id of ids) {
  const source = production.versions.find((v) => v.id === id)!;
  assert(source);
  for (const file of source.files) {
    const original = path.join(sourceRoot, file.path);
    assert.equal(sha(original), file.sha256);
    store.write(project.id, file.path, fs.readFileSync(original));
    assert.equal(sha(store.file(project.id, file.path)), file.sha256);
  }
  copies.push({
    ...structuredClone(source),
    objectId: "chest-copy",
    label:
      source.role === "design"
        ? "상자 원본 참고 이미지"
        : "보완 전 상자 · 검사 사본",
    provenance: { type: "import" },
    sourceVersionIds: source.role === "design" ? [] : [ids[1]],
  });
}
const creation = defaultCreation("prop");
creation.subject = "box";
creation.stageSettings.rig!.values.enabled = false;
creation.stageSettings.animation!.values.enabled = false;
const workspace: GraphicsWorkspace = {
  schemaVersion: 1,
  id: project.id,
  projectId: project.id,
  revision: 0,
  objects: [
    {
      id: "chest-copy",
      name: "상자 · 누락 평면 검사 사본",
      kind: "prop",
      createdAt: new Date().toISOString(),
      selectedTasks: [],
      instruction: "",
      settings: {},
      references: [{ versionId: ids[1], role: "appearance" }],
      accepted: { "model:main": ids[0], "design:main": ids[1] },
      creation,
    },
  ],
  versions: copies,
  tasks: [],
  deliveries: [],
};
store.put("graphics", project.id, workspace);
store.write(
  project.id,
  "graphics/workspace.json",
  JSON.stringify(workspace, null, 2),
);
store.db.close();
fs.writeFileSync(
  evidence,
  JSON.stringify(
    {
      root,
      profile,
      unity,
      projectId: project.id,
      objectId: "chest-copy",
      sourceVersionId: ids[0],
      designVersionId: ids[1],
      sourceRoot,
      sourceFiles: copies.flatMap((v) => v.files),
      createdAt: new Date().toISOString(),
      productionUnmodified: true,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    root,
    profile,
    unity,
    projectId: project.id,
    sourceFiles: copies.flatMap((v) => v.files).length,
  }),
);
