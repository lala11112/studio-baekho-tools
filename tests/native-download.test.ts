import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NativeDownloadCollector } from "../engine/native-download";
const fbx = Buffer.concat([
  Buffer.from("Kaydara FBX Binary  \x00\x1a\x00"),
  Buffer.alloc(40),
]);
test("native export collector excludes old files, preserves originals and rejects stale tickets", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-export-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const downloads = path.join(root, "downloads"),
    workspace = path.join(root, "job");
  fs.mkdirSync(downloads);
  fs.writeFileSync(path.join(downloads, "old.fbx"), fbx);
  const collector = new NativeDownloadCollector(downloads, workspace),
    ticket = collector.prepare("uv", "https://studio.tripo3d.ai/example");
  assert.equal(collector.collect(ticket.id).status, "pending");
  fs.writeFileSync(path.join(downloads, "rabbit.fbx.crdownload"), fbx);
  assert.equal(collector.collect(ticket.id).status, "pending");
  fs.renameSync(
    path.join(downloads, "rabbit.fbx.crdownload"),
    path.join(downloads, "rabbit.fbx"),
  );
  const result = collector.collect(ticket.id);
  assert.equal(result.status, "collected");
  assert("path" in result);
  assert.deepEqual(fs.readFileSync(path.join(workspace, result.path!)), fbx);
  assert(fs.existsSync(path.join(downloads, "rabbit.fbx")));
  assert.throws(() => collector.collect(ticket.id), /예약/);
});
test("native export collector refuses ambiguous files and HTML disguised as a model", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-export-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "job"),
    collector = new NativeDownloadCollector(root, workspace);
  const a = collector.prepare("uv", "https://studio.tripo3d.ai/example");
  fs.writeFileSync(
    path.join(root, "bad.fbx"),
    "<html>authentication required</html>",
  );
  assert.throws(() => collector.collect(a.id), /형식/);
  fs.writeFileSync(path.join(root, "other.fbx"), fbx);
  assert.throws(() => collector.collect(a.id), /여러 개/);
  assert(!fs.existsSync(workspace));
});
