import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PNG } from "pngjs";
import { prepareGraphicsMotionFrames, type GraphicsMotionFramesArgs } from "../engine/graphics-motion-frames";
import type { GraphicsFile } from "../shared/graphics";

const ffmpeg = path.resolve("node_modules/ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function fixture(t: { after(callback: () => void): void }, suffix = ".mp4") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-native-frames-"));
  t.after(() => {
    const real = fs.realpathSync(root);
    assert.equal(path.dirname(real), fs.realpathSync(os.tmpdir()));
    assert(path.basename(real).startsWith("ps-native-frames-"));
    fs.rmSync(real, { recursive: true, force: true });
  });
  const original = path.join(root, "original" + suffix), controller = new AbortController();
  const source = (): GraphicsFile => ({ path: path.basename(original), bytes: fs.statSync(original).size, sha256: hash(original), kind: "video" });
  const args = (): GraphicsMotionFramesArgs => ({ projectRoot: root, source: source(), outputDirectory: "task/work/motion-frames/side", ffmpegPath: ffmpeg, signal: controller.signal });
  const make = (input = "testsrc2=size=160x90:rate=24:duration=2.041667", output: string[] = [], audio = false) => {
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-n", "-f", "lavfi", "-i", input,
      ...(audio ? ["-f", "lavfi", "-i", "sine=frequency=400:duration=4", "-c:a", "aac"] : []),
      ...output, "-c:v", suffix === ".webm" ? "libvpx-vp9" : "libx264", "-pix_fmt", "yuv420p", original],
      { windowsHide: true, timeout: 30_000 });
  };
  return { root, original, source, args, controller, make };
}
const real = { skip: !fs.existsSync(ffmpeg), timeout: 30_000 };

test("every native 24fps frame is decoded losslessly at original size; hash-verified cache never launches another process", real, async t => {
  const f = fixture(t); f.make("testsrc2=size=160x90:rate=24:duration=2.041667", ["-frames:v", "49"], true);
  const original = f.source(), result = await prepareGraphicsMotionFrames(f.args());
  assert.equal(result.frames.length, 49); assert.equal(result.framePaths.length, 49);
  assert.equal(result.nativeFrameRate!.numerator / result.nativeFrameRate!.denominator, 24);
  assert(Math.abs(result.durationSeconds - 49 / 24) < 1e-8);
  assert(Math.abs(result.frames.at(-1)!.relativeTime - 2) < 1e-8);
  for (let index = 0; index < 49; index++) {
    const frame = result.frames[index], file = path.join(f.root, frame.path), image = PNG.sync.read(fs.readFileSync(file), { checkCRC: true });
    assert.equal(frame.index, index); assert.equal(hash(file), frame.sha256); assert.equal(image.width, 160); assert.equal(image.height, 90);
    assert(Math.abs(frame.time - frame.pts * result.timeBase.numerator / result.timeBase.denominator) < 1e-10);
    assert(Math.abs(frame.relativeTime - index / 24) < 1e-8);
  }
  assert(new Set(result.frames.map(frame => frame.sha256)).size > 30);
  assert.deepEqual(f.source(), original);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.root, result.manifest.path), "utf8"));
  assert.equal(manifest.complete, true); assert.equal(manifest.scaled, false); assert.equal(manifest.resampled, false);
  assert.equal(manifest.frameCount, 49); assert.deepEqual(manifest.source, original);
  assert.deepEqual(await prepareGraphicsMotionFrames({ ...f.args(), ffmpegPath: process.execPath }), result);
  // A changed derivative is an error, never a reason to silently re-decode/rebind.
  const checkpoint = path.join(f.root, f.args().outputDirectory, "checkpoint.json"), checkpointHash = hash(checkpoint);
  fs.appendFileSync(result.framePaths[12], "corrupted");
  await assert.rejects(prepareGraphicsMotionFrames(f.args()), /해시가 변경/);
  assert.equal(hash(checkpoint), checkpointHash); assert.deepEqual(f.source(), original);
});

test("MOV VFR preserves native unequal PTS intervals rather than requested or nominal FPS", real, async t => {
  const f = fixture(t, ".mov");
  f.make("testsrc2=size=96x64:rate=10:duration=0.6", ["-vf", "setpts=if(lt(N\\,3)\\,N\\,3+(N-3)*3)/(10*TB)", "-fps_mode", "vfr"]);
  const source = f.source(), result = await prepareGraphicsMotionFrames(f.args());
  assert.equal(result.frames.length, 6);
  const expected = [0, .1, .2, .3, .6, .9];
  result.frames.forEach((frame, index) => assert(Math.abs(frame.relativeTime - expected[index]) < 1e-8));
  assert.notEqual(result.frames[1].pts - result.frames[0].pts, result.frames[4].pts - result.frames[3].pts);
  assert.deepEqual(f.source(), source);
});

test("WebM is decoded with native PTS and unchanged original bytes", real, async t => {
  const f = fixture(t, ".webm"); f.make("testsrc2=size=96x64:rate=12:duration=0.5");
  const source = f.source(), result = await prepareGraphicsMotionFrames(f.args());
  assert.equal(result.frames.length, 6);
  assert.equal(result.frames[0].width, 96); assert.equal(result.frames[0].height, 64);
  assert(Math.abs(result.frames[5].relativeTime - 5 / 12) < .001);
  assert.deepEqual(f.source(), source);
});

test("nonzero native starting PTS is retained separately from relative review time", real, async t => {
  const f = fixture(t, ".mov");
  f.make("testsrc2=size=96x64:rate=10:duration=0.3", ["-output_ts_offset", "2"]);
  const result = await prepareGraphicsMotionFrames(f.args());
  assert.equal(result.frames.length, 3); assert.equal(result.frames[0].time, 2);
  assert.equal(result.frames[0].relativeTime, 0); assert(result.frames[0].pts > 0);
  assert(Math.abs(result.frames[2].time - 2.2) < 1e-8);
  assert(Math.abs(result.durationSeconds - .3) < 1e-8);
});

test("frame/duration capacity stops explicitly without sampling, a checkpoint or reuse of partial decode", real, async t => {
  const f = fixture(t); f.make("testsrc2=size=96x64:rate=24:duration=0.5");
  const source = f.source(), output = path.join(f.root, f.args().outputDirectory);
  await assert.rejects(prepareGraphicsMotionFrames({ ...f.args(), maxFrames: 3 }), /분석 한도 3프레임/);
  assert.equal(fs.existsSync(path.join(output, "checkpoint.json")), false);
  const firstAttempts = fs.readdirSync(output); assert.equal(firstAttempts.length, 1);
  const partials = fs.readdirSync(path.join(output, firstAttempts[0])).map(name => ({ path: path.join(output, firstAttempts[0], name), sha256: hash(path.join(output, firstAttempts[0], name)) }));
  await assert.rejects(prepareGraphicsMotionFrames({ ...f.args(), maxDurationSeconds: .2 }), /분석 한도 240프레임·0.2초/);
  assert.equal(fs.existsSync(path.join(output, "checkpoint.json")), false);
  const result = await prepareGraphicsMotionFrames(f.args());
  assert.equal(result.frames.length, 12); assert.equal(fs.readdirSync(output).filter(name => name.startsWith("decoded-")).length, 3);
  for (const file of partials) assert.equal(hash(file.path), file.sha256);
  assert.deepEqual(f.source(), source);
});

test("corrupt native decode is retained as partial evidence and is never accepted as complete", real, async t => {
  const f = fixture(t); fs.writeFileSync(f.original, "not a video");
  const source = f.source();
  await assert.rejects(prepareGraphicsMotionFrames(f.args()), /해독 실패/);
  await assert.rejects(prepareGraphicsMotionFrames(f.args()), /해독 실패/);
  const output = path.join(f.root, f.args().outputDirectory);
  assert.equal(fs.existsSync(path.join(output, "checkpoint.json")), false);
  assert.equal(fs.readdirSync(output).length, 2); assert.deepEqual(f.source(), source);
});

test("manifest corruption and different cache requests fail closed without changing originals", real, async t => {
  const f = fixture(t); f.make("testsrc2=size=96x64:rate=10:duration=0.3");
  const source = f.source(), result = await prepareGraphicsMotionFrames(f.args());
  await assert.rejects(prepareGraphicsMotionFrames({ ...f.args(), maxFrames: 10 }), /저장된.*요청이 다릅니다/);
  fs.appendFileSync(path.join(f.root, result.manifest.path), " ");
  await assert.rejects(prepareGraphicsMotionFrames(f.args()), /해시가 변경/);
  assert.deepEqual(f.source(), source);
});

test("invalid source hashes, escaping paths and pre-cancelled requests cannot launch decoding", async t => {
  const f = fixture(t); fs.writeFileSync(f.original, "synthetic native boundary");
  await assert.rejects(prepareGraphicsMotionFrames({ ...f.args(), source: { ...f.source(), sha256: "0".repeat(64) } }), /해시가 변경/);
  await assert.rejects(prepareGraphicsMotionFrames({ ...f.args(), outputDirectory: "../outside" }), /프로젝트 밖/);
  await assert.rejects(prepareGraphicsMotionFrames({ ...f.args(), maxFrames: 1 }), /분석 한도/);
  f.controller.abort(); await assert.rejects(prepareGraphicsMotionFrames(f.args()), /abort/i);
  assert.equal(fs.existsSync(path.join(f.root, "task")), false);
});

test("cancellation interrupts an owned ffmpeg process and publishes no complete cache", real, async t => {
  const f = fixture(t); f.make("testsrc2=size=320x180:rate=60:duration=2");
  const source = f.source();
  const execution = prepareGraphicsMotionFrames({ ...f.args(), onProgress: () => setTimeout(() => f.controller.abort(), 1) });
  await assert.rejects(execution, /중지|abort/i);
  assert.equal(fs.existsSync(path.join(f.root, f.args().outputDirectory, "checkpoint.json")), false);
  assert.deepEqual(f.source(), source);
});
