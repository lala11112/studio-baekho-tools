import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PNG } from "pngjs";
import { prepareGraphicsMotionImport } from "../engine/graphics-motion-import";
import { createGraphicsAstraExecutor } from "../engine/graphics-astra";
import type { GraphicsFile, AssetVersion } from "../shared/graphics";
import type { GraphicsNativeArgs } from "../engine/graphics-native";

const ffmpeg = path.resolve("node_modules/ffmpeg-static/ffmpeg.exe");
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function fixture(t: any, extraAudio = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-motion-import-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, "graphics/originals/imported-1"); fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, "native.mp4");
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=30:duration=1.2",
    ...(extraAudio ? ["-f", "lavfi", "-i", "sine=frequency=440:duration=2.2", "-c:a", "aac"] : []), "-c:v", "libx264", "-pix_fmt", "yuv420p", file], { windowsHide: true, timeout: 30_000 });
  const source: GraphicsFile = { path: path.relative(root, file).split(path.sep).join("/"), sha256: hash(file), bytes: fs.statSync(file).size, kind: "video" };
  const controller = new AbortController();
  const args = { projectRoot: root, source, versionId: "imported-1", clipName: "가져온 Idle.001", ffmpegPath: ffmpeg, signal: controller.signal };
  return { root, file, source, args, controller };
}

test("native video import decodes original-size frames, retains video hash and recovers without decoding again", { skip: !fs.existsSync(ffmpeg), timeout: 30_000 }, async t => {
  const f = fixture(t), result = await prepareGraphicsMotionImport(f.args);
  assert.equal(result.slot, f.args.clipName); assert.equal(result.files.length, 7); assert.equal(result.preview, f.source.path);
  assert.deepEqual(result.metadata, { duration: 1.2, fps: 30, width: 160, height: 120, decodedFrames: 36 });
  const manifestFile = result.files.find(file => file.kind === "frames")!, manifest = JSON.parse(fs.readFileSync(path.join(f.root, manifestFile.path), "utf8"));
  assert.equal(manifest.source, "video-import"); assert.equal(manifest.camera, "unknown"); assert.equal(manifest.visualReview, "pending");
  assert.equal(manifest.clipName, f.args.clipName); assert.equal(manifest.videos.side.sha256, f.source.sha256);
  assert.deepEqual(manifest.frames.map((frame: any) => frame.time), [0, 0.3, 0.6, 0.9, 1.2]);
  assert(manifest.frames.at(-1).decodedTime < manifest.duration);
  for (const file of result.files) assert.equal(hash(path.join(f.root, file.path)), file.sha256);
  for (const frame of manifest.frames) { const png = PNG.sync.read(fs.readFileSync(path.join(f.root, frame.side))); assert.equal(png.width, 160); assert.equal(png.height, 120); }
  assert.equal(new Set(manifest.frames.map((frame: any) => frame.sha256)).size, 5);
  // A different existing binary would fail if invoked. Checkpoint reuse is local hash verification only.
  assert.deepEqual(await prepareGraphicsMotionImport({ ...f.args, ffmpegPath: process.execPath }), result);
  await assert.rejects(prepareGraphicsMotionImport({ ...f.args, clipName: "AnotherClip" }), /요청이 다릅니다/);
  const first = path.join(f.root, manifest.frames[0].side), checkpoint = path.join(f.root, "graphics/motion-imports/imported-1/checkpoint.json"), checkpointHash = hash(checkpoint);
  fs.appendFileSync(first, "changed");
  await assert.rejects(prepareGraphicsMotionImport(f.args), /해시가 변경/);
  assert.equal(hash(checkpoint), checkpointHash); assert.equal(hash(f.file), f.source.sha256);
});

test("imported motion uses decoded video duration when audio outlasts the video", { skip: !fs.existsSync(ffmpeg), timeout: 30_000 }, async t => {
  const f = fixture(t, true), result = await prepareGraphicsMotionImport(f.args);
  assert.equal(result.metadata.duration, 1.2); assert.equal(result.metadata.decodedFrames, 36);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.root, result.files.find(file => file.kind === "frames")!.path), "utf8"));
  assert.equal(manifest.containerDuration, 2.2); assert.equal(hash(f.file), f.source.sha256);
});

test("imported video and extracted manifest reach N04 with the exact accepted clip and no service call", { skip: !fs.existsSync(ffmpeg), timeout: 30_000 }, async t => {
  const f = fixture(t), result = await prepareGraphicsMotionImport(f.args), rigPath = path.join(f.root, "rig.blend");
  fs.writeFileSync(rigPath, "immutable rig fixture; Blender boundary mocked");
  const rig: AssetVersion = { id: "rig", objectId: "object", role: "rig", slot: "main", label: "Rig", createdAt: "test", sourceVersionIds: [], provenance: { type: "import" }, warnings: [], files: [{ path: "rig.blend", kind: "blend", bytes: fs.statSync(rigPath).size, sha256: hash(rigPath) }] };
  const motion: AssetVersion = { id: f.args.versionId, objectId: "object", role: "motion-reference", slot: result.slot, label: result.label, createdAt: "test", sourceVersionIds: [], provenance: { type: "import" }, files: result.files, warnings: result.warnings };
  const args: GraphicsNativeArgs = { projectRoot: f.root, workspacePath: path.join(f.root, "graphics.json"), resources: path.resolve("integrations"), blenderPath: process.execPath, signal: f.args.signal, onProgress: () => {}, inputs: [rig, motion],
    object: { id: "object", kind: "character", name: "Synthetic rig", createdAt: "test", selectedTasks: ["N04"], instruction: "", settings: {}, references: [], accepted: { "rig:main": rig.id, ["motion-reference:" + result.slot]: motion.id } },
    task: { id: "n04", objectId: "object", taskId: "N04", createdAt: "test", updatedAt: "test", status: "running", inputVersionIds: [rig.id, motion.id], settings: { clipName: result.slot, duration: 1.2, fps: 30 }, instruction: "Transfer the imported original motion", requestHash: "frozen", outputVersionIds: [], backendJobIds: [], message: "", localOnly: false } };
  let workers = 0;
  const execute = createGraphicsAstraExecutor({ runBlender: async (_binary, command) => {
    const q = JSON.parse(fs.readFileSync(command.at(-1)!, "utf8")); assert.equal(q.mode, "prepare");
    fs.writeFileSync(q.outputBlend, "prepared immutable rig"); fs.writeFileSync(q.report, JSON.stringify({ identity: q.identity, nonce: q.nonce, sourceSha256: q.sourceSha256, meshes: [{ id: "mesh" }] }));
  }, workerFactory: () => ({ probe: async () => { throw Error("Service forbidden"); }, run: async task => {
    workers++; assert.equal(task.requestedModel, "gpt-6-astra"); assert.equal(task.imagePaths.length, result.metadata.decodedFrames);
    // Import review keeps five thumbnails; authoring receives every native frame.
    for(const file of task.imagePaths){const png=PNG.sync.read(fs.readFileSync(path.resolve(task.run.workspace,file)));assert.equal(png.width,result.metadata.width);assert.equal(png.height,result.metadata.height);}
    assert(task.referencePaths?.some(file => file.endsWith("native.mp4"))); assert(task.referencePaths?.some(file => file.endsWith("motion-reference.json")));
    assert.match(task.prompt, /ORIGINAL VIDEO AND decoded frames/); assert(task.prompt.includes(result.slot));
    throw Error("Synthetic authoring boundary only; no Astra call");
  } }) });
  await assert.rejects(execute(args), /Synthetic authoring boundary/); assert.equal(workers, 1); assert.equal(hash(f.file), f.source.sha256);
});

test("import rejects changed originals, unsafe clips and disguised containers without overwriting native bytes", { skip: !fs.existsSync(ffmpeg), timeout: 30_000 }, async t => {
  const f = fixture(t);
  await assert.rejects(prepareGraphicsMotionImport({ ...f.args, clipName: "../Idle" }), /클립 이름/);
  await assert.rejects(prepareGraphicsMotionImport({ ...f.args, source: { ...f.source, sha256: "0".repeat(64) } }), /해시가 변경/);
  assert.equal(hash(f.file), f.source.sha256);
  fs.writeFileSync(f.file, "#EXTM3U\nhttps://example.invalid/not-a-local-video");
  const source = { ...f.source, sha256: hash(f.file), bytes: fs.statSync(f.file).size };
  await assert.rejects(prepareGraphicsMotionImport({ ...f.args, source }), /실제 MP4/);
  assert.equal(hash(f.file), source.sha256);
  f.controller.abort(); await assert.rejects(prepareGraphicsMotionImport(f.args), /abort/i);
});
