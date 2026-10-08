import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { prepareSeparationImages } from "../electron/separation-preview";
import type { WorkbenchArtifact } from "../shared/workbench";

const hash = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "partsmith-preview-safety-"),
  );
  const workspace = path.join(root, "workbench", "test", "jobs", "job");
  const sourceFolder = path.join(workspace, "outputs", "separate-head-front");
  fs.mkdirSync(sourceFolder, { recursive: true });
  const source = path.join(sourceFolder, "head-front.png");
  const png = new PNG({ width: 16, height: 16 });
  for (let y = 4; y < 12; y++)
    for (let x = 4; x < 12; x++)
      png.data.set([160, 90, 30, 255], (y * 16 + x) * 4);
  fs.writeFileSync(source, PNG.sync.write(png));
  const artifact: WorkbenchArtifact = {
    path: path.relative(root, source).split(path.sep).join("/"),
    kind: "image",
    role: "head",
    view: "front",
    sha256: hash(source),
    bytes: fs.statSync(source).size,
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prepare = () => prepareSeparationImages([artifact], workspace, root);
  return { root, workspace, source, sourceFolder, artifact, prepare };
}

test("normalization refuses a cached output directory redirected into the source folder", (t) => {
  const x = fixture(t);
  const initial = x.prepare()[0];
  const output = path.join(x.root, initial.normalized!.path);
  const folder = path.dirname(output);
  fs.rmSync(folder, { recursive: true });
  fs.symlinkSync(
    x.sourceFolder,
    folder,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(x.prepare, /연결 경로/);
  assert.equal(hash(x.source), x.artifact.sha256);
});

test("normalization refuses hard-linked cached image outputs without changing original bytes", (t) => {
  const x = fixture(t);
  const output = path.join(x.root, x.prepare()[0].normalized!.path);
  fs.unlinkSync(output);
  fs.linkSync(x.source, output);
  assert.throws(x.prepare, /원본·연결 파일/);
  assert.equal(hash(x.source), x.artifact.sha256);
});

test("alignment report replacement cannot write through a hard link to an original", (t) => {
  const x = fixture(t);
  const output = path.join(x.root, x.prepare()[0].normalized!.path);
  const report = path.join(path.dirname(output), "alignment.json");
  fs.unlinkSync(report);
  fs.linkSync(x.source, report);
  fs.appendFileSync(output, "invalidate derivative cache");
  assert.throws(x.prepare, /원본·연결 파일/);
  assert.equal(hash(x.source), x.artifact.sha256);
});

test("cached derivatives still verify source bytes and normal local repair preserves originals", (t) => {
  const x = fixture(t);
  const first = x.prepare()[0];
  const output = path.join(x.root, first.normalized!.path);
  fs.appendFileSync(output, "damaged derivative");
  const repaired = x.prepare()[0];
  assert.equal(hash(output), repaired.normalized!.sha256);
  assert.equal(hash(x.source), x.artifact.sha256);
  fs.appendFileSync(x.source, "changed original");
  assert.throws(x.prepare, /원본이 변경/);
});
