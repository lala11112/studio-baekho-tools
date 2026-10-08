import { _electron as electron } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const root = path.resolve("artifacts/runtime/data-smoke");
fs.mkdirSync(root, { recursive: true });
let app = await electron.launch({
  executablePath: electronPath,
  args: ["."],
  env: { ...process.env, PARTSMITH_DATA: root },
});
let page = await app.firstWindow();
await page.waitForSelector(".home");
const call = (c) => page.evaluate((c) => window.desktop.call(c), c);
const p = await call({
  type: "project.create",
  name: "데이터 흐름 테스트",
  demo: true,
});
const fakeKey = "test-only-not-a-real-tripo-api-key-12345";
await call({ type: "key.save", key: fakeKey });
assert(
  !fs.readFileSync(path.join(root, "tripo.key")).includes(Buffer.from(fakeKey)),
);
assert(!JSON.stringify(await call({ type: "state" })).includes(fakeKey));
const png = await page.evaluate(() => {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const x = c.getContext("2d");
  x.fillStyle = "#c4e6bf";
  x.fillRect(0, 0, 512, 512);
  x.fillStyle = "#26392f";
  x.fillRect(100, 100, 300, 300);
  return c.toDataURL().split(",")[1];
});
const image = path.join(root, "fixture.png");
fs.writeFileSync(image, Buffer.from(png, "base64"));
await app.evaluate(({ dialog }, image) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [image] });
}, image);
const source = await call({ type: "asset.import", id: p.id, kind: "image" });
const crop = await call({
  type: "part.crop",
  id: p.id,
  partId: p.parts[0].id,
  sourceId: source.id,
  rect: { x: 60, y: 60, width: 350, height: 350 },
  polygon: [
    [60, 60],
    [410, 60],
    [60, 410],
  ],
});
const info = await app.evaluate(
  ({ nativeImage }, file) => {
    const i = nativeImage.createFromPath(file);
    return {
      size: i.getSize(),
      alphaTop: i.toBitmap()[3],
      alphaBottom: i.toBitmap().at(-1),
    };
  },
  path.join(root, "projects", p.id, crop.file),
);
assert.deepEqual(info.size, { width: 350, height: 350 });
assert.equal(info.alphaTop, 255);
assert.equal(info.alphaBottom, 0);
const cropped = (await call({ type: "state" })).projects.find(
  (x) => x.id === p.id,
);
assert.equal(cropped.parts[0].imageId, crop.id);
assert.equal(cropped.parts[0].occluded, true);
assert.equal(crop.parentId, source.id);
assert.equal(cropped.selectedImageId, source.id);
const glb = path.resolve("artifacts/runtime/blender/character.glb");
await app.evaluate(({ dialog }, file) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
}, glb);
const model = await call({
  type: "asset.import",
  id: p.id,
  kind: "model",
  partId: p.parts[0].id,
});
await call({ type: "assembly.save", id: p.id, name: "원래 조합" });
await call({
  type: "part.update",
  id: p.id,
  partId: p.parts[0].id,
  patch: { locked: true },
});
await assert.rejects(
  () =>
    call({
      type: "part.update",
      id: p.id,
      partId: p.parts[0].id,
      patch: {
        transform: {
          position: [1, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      },
    }),
  /고정/,
);
await call({
  type: "part.update",
  id: p.id,
  partId: p.parts[0].id,
  patch: { locked: false },
});
for (const part of p.parts.slice(1))
  await call({
    type: "part.update",
    id: p.id,
    partId: part.id,
    patch: { visible: false },
  });
const build = await call({ type: "blender.build", id: p.id, mode: "assemble" });
assert(fs.existsSync(path.join(root, "projects", p.id, build.fbx)));
await call({
  type: "part.update",
  id: p.id,
  partId: p.parts[0].id,
  patch: {
    transform: { position: [0.2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  },
});
await assert.rejects(
  () => call({ type: "unity.import", id: p.id, buildId: build.id }),
  /바뀌었/,
);
const backup = path.resolve("artifacts/runtime/data-backups");
const textureRelative = path.join(
  path.dirname(build.fbx),
  "textures",
  "test-base-color.png",
);
fs.mkdirSync(path.dirname(path.join(root, "projects", p.id, textureRelative)), {
  recursive: true,
});
fs.copyFileSync(image, path.join(root, "projects", p.id, textureRelative));
fs.mkdirSync(backup, { recursive: true });
await app.evaluate(({ dialog }, file) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
}, backup);
const exported = await call({ type: "project.export", id: p.id });
assert(fs.existsSync(path.join(exported, "project.json")));
assert(!fs.existsSync(path.join(exported, "tripo.key")));
await app.close();
app = await electron.launch({
  executablePath: electronPath,
  args: ["."],
  env: { ...process.env, PARTSMITH_DATA: root },
});
page = await app.firstWindow();
await page.waitForSelector(".home");
assert.equal((await call({ type: "state" })).key.configured, true);
await call({ type: "key.delete" });
assert(!fs.existsSync(path.join(root, "tripo.key")));
await app.close();
const reopenRoot = path.join(root, "reopened");
app = await electron.launch({
  executablePath: electronPath,
  args: ["."],
  env: { ...process.env, PARTSMITH_DATA: reopenRoot },
});
page = await app.firstWindow();
await page.waitForSelector(".home");
await app.evaluate(
  ({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  },
  path.join(exported, "project.json"),
);
const reopened = await call({ type: "project.open" });
assert.equal(reopened.id, p.id);
assert.equal(reopened.parts[0].selectedId, model.id);
assert.deepEqual(
  fs.readFileSync(path.join(reopenRoot, "projects", p.id, textureRelative)),
  fs.readFileSync(image),
);
await app.close();
fs.writeFileSync(
  "artifacts/data-smoke.json",
  JSON.stringify(
    {
      passed: true,
      encryptedKey: true,
      keyRestoredAndDeleted: true,
      maskAlphaVerified: true,
      originalPreserved: true,
      lockedPartProtected: true,
      blenderAssembly: true,
      staleExportBlocked: true,
      backupReopened: true,
    },
    null,
    2,
  ),
);
console.log("Data smoke passed.");
