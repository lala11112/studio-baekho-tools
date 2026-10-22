import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { prepareMotionVideoFrames } from "../engine/motion-video-media";
import type { MotionVideoLedger } from "../engine/motion-video-ledger";

test("real decoder preserves synthetic native video bytes/dimensions and extracts exact frozen times without image AI", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "motion-decode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.resolve("node_modules/ffmpeg-static/ffmpeg.exe");
  const hash = (name: string) => createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex");
  const entries: ReturnType<MotionVideoLedger["read"]>["entries"] = [];
  for (const [index, view] of ["front", "side", "back"].entries()) {
    const file = `${view}.mp4`;
    execFileSync(binary, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=10:duration=2.2", "-vf", `hue=h=${index * 80}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(root, file)], { windowsHide: true });
    entries.push({ phase: view, state: "completed", cost: 0, sourceModelId: "", url: "", resultId: view, resultUrl: "https://example.com/" + view,
      plan: { phase: view, observedCost: 0, model: "synthetic-fixture", duration: 2.2, resolution: "96x64", url: "", sourceModelId: "" }, download: { path: file, sha256: hash(file) } });
  }
  const request = { step: "reference" as const, prompt: "synthetic fixture only", motion: "Test", duration: 2, fps: 30, referenceFrameCount: 3, referenceTimes: [0, 0.8, 2] };
  const result = await prepareMotionVideoFrames(binary, root, request, entries, new AbortController().signal);
  const doc = JSON.parse(fs.readFileSync(path.join(root, result.manifestPath), "utf8"));
  assert.deepEqual(doc.frames.map((f: any) => f.time), [0, 0.8, 2]);
  assert.equal(result.artifacts.filter(a => a.kind === "image").length, 9);
  for (const entry of entries) assert.equal(hash(entry.download!.path), entry.download!.sha256);
  for (const a of result.artifacts.filter(a => a.kind === "image")) {
    const b = fs.readFileSync(path.join(root, a.path)); assert.equal(b.readUInt32BE(16), 96); assert.equal(b.readUInt32BE(20), 64);
  }
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(prepareMotionVideoFrames(binary, root, request, entries, cancelled.signal), /취소/);
  await assert.rejects(prepareMotionVideoFrames(binary, root, { ...request, duration: 5 }, entries, new AbortController().signal), /짧습니다/);
});
