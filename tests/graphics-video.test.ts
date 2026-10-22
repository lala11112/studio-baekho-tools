import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PNG } from "pngjs";
import { createGraphicsVideoExecutor, prepareGraphicsVideo, prepareGraphicsVideoUploadRetry, type GraphicsVideoApproval } from "../engine/graphics-video";
import type { GraphicsNativeArgs } from "../engine/graphics-native";
import type { RunwayConnection, RunwayTool } from "../engine/runway-client";
import type { AssetVersion } from "../shared/graphics";
import type { WorkbenchRuntimeApproval, WorkbenchRuntimeAnswer } from "../shared/workbench";

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphics-video-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const image = new PNG({ width: 32, height: 32 }); image.data.fill(255);
  const png = PNG.sync.write(image), sourcePath = path.join(root, "left.png"); fs.writeFileSync(sourcePath, png);
  const version: AssetVersion = { id: "source-v1", objectId: "object-1", role: "design", slot: "main", label: "Accepted side", createdAt: "test",
    sourceVersionIds: [], provenance: { type: "import" }, warnings: [], files: [{ path: "left.png", kind: "image", bytes: png.length, sha256: digest(png) }] };
  const controller = new AbortController();
  const args: GraphicsNativeArgs = { projectRoot: root, workspacePath: path.join(root, "graphics/workspace.json"),
    object: { id: "object-1", name: "Rabbit", kind: "character", createdAt: "test", selectedTasks: ["N02"], instruction: "Side idle breathing", settings: {}, references: [], accepted: { "design:main": version.id } },
    task: { id: "task-idle", objectId: "object-1", taskId: "N02", createdAt: "test", updatedAt: "test", status: "running", inputVersionIds: [version.id],
      settings: { clipName: "Idle", duration: 2, fps: 30, loop: true, motionSourceVersionId: version.id, motionSourcePath: "left.png", motionSourceView: "left" },
      instruction: "Side idle breathing", requestHash: "frozen-idle-request", outputVersionIds: [], backendJobIds: [], message: "", localOnly: false,
      objectSnapshot: { name: "Rabbit", kind: "character", references: [], accepted: { "design:main": version.id } } },
    inputs: [version], blenderPath: "unused", resources: path.resolve("integrations"), signal: controller.signal, onProgress: () => {} };
  const approve = (patch: Partial<GraphicsVideoApproval> = {}) => {
    Object.assign(args.task, { paidApproval: { requestHash: args.task.requestHash, provider: "Runway", credits: 24, approvedAt: "2026-10-13T00:00:00.000Z", ...patch } });
  };
  const calls: RunwayTool[] = [];
  let submissions = 0, uploads = 0, downloads = 0, balance: number | undefined = 200, kind = "task_failed", ambiguous = false, downloadFails = false;
  let onUpload: (() => void) | undefined;
  let uploadPermission: WorkbenchRuntimeApproval | undefined, ask!: (request: WorkbenchRuntimeApproval) => Promise<WorkbenchRuntimeAnswer>;
  const connection: RunwayConnection = { open: async (_cwd, _signal, callback) => { ask = callback; }, close: () => {}, call: async (tool, input) => {
    calls.push(tool);
    if (tool === "whoami") return { authenticated: true, team: { id: 7 }, credits: { total: balance }, availableVideoModels: ["gen-4.5"] };
    if (tool === "init_upload") {
      uploads++; const uploaded = PNG.sync.read(fs.readFileSync(String(input.file)));
      assert.equal(uploaded.width / uploaded.height, 16 / 9); onUpload?.();
      if (uploadPermission && !(await ask(uploadPermission)).accepted) throw Error("Runway 원본 업로드 도구 실패: user rejected MCP tool call");
      return { kind: "upload_complete", assetUrl: "https://assets.example/source?secret=hidden", uploadModelTurns: 1, uploadUsage: { input: 30 } };
    }
    if (tool === "generate_video") {
      submissions++; assert.equal(input.duration, 2); assert.equal(input.model, "gen-4.5"); assert.equal(input.resolution, "720p"); assert.equal(input.ratio, "16:9");
      assert.equal((input.startFrame as any).url, "https://assets.example/source?secret=hidden");
      if (ambiguous) throw Error("connection lost after paid submit");
      return { taskId: "remote-video-1" };
    }
    return { taskId: "remote-video-1", kind, url: "https://assets.example/native.mp4?secret=hidden" };
  } };
  const deps = { ffmpegPath: path.resolve("node_modules/ffmpeg-static/ffmpeg.exe"), connection: () => connection,
    encrypt: (value: string) => Buffer.from(value).toString("base64"), decrypt: (value: string) => Buffer.from(value, "base64").toString(),
    wait: async () => {}, fetch: (async () => { downloads++; if (downloadFails) throw Error("download interrupted"); return new Response(new Uint8Array(fs.readFileSync(path.join(root, "native.mp4")))); }) as typeof fetch };
  const success = () => {
    kind = "video";
    execFileSync(deps.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=2.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(root, "native.mp4")], { windowsHide: true });
  };
  return { root, args, deps, approve, calls, controller, sourcePath, success, execute: createGraphicsVideoExecutor(deps),
    counts: () => ({ submissions, uploads, downloads }), setBalance: (value?: number) => { balance = value; }, ambiguous: () => { ambiguous = true; },
    failDownload: (value: boolean) => { downloadFails = value; }, onUpload: (value: () => void) => { onUpload = value; },
    permission: (value: WorkbenchRuntimeApproval) => { uploadPermission = value; } };
}

const permission: WorkbenchRuntimeApproval = { id: "connector-access", title: "codex_apps 접근 확인", detail: "Upload the selected Runway PNG", fields: [] };
const uploadDenied = "Runway 원본 업로드 도구 실패: user rejected MCP tool call";

test("Runway tool permission reaches the app and waits independently from saved paid approval", async t => {
  const f = fixture(t); f.approve(); f.permission(permission);
  let answer!: (value: WorkbenchRuntimeAnswer) => void, notified!: () => void;
  const shown = new Promise<void>(resolve => { notified = resolve; });
  f.args.requestApproval = async request => { assert.deepEqual(request, permission); notified(); return new Promise(resolve => { answer = resolve; }); };
  const execution = f.execute(f.args);
  await shown;
  assert.equal(f.counts().submissions, 0);
  assert(!fs.existsSync(path.join(f.root, "graphics/video-journal/object-1/task-idle.json")));
  answer({ accepted: true, values: {} });
  await assert.rejects(execution, /생성이 실패/);
  assert.equal(f.counts().submissions, 1);
});

test("permission denial preserves the request and only explicit proven same-task retry can upload again", async t => {
  const f = fixture(t); f.approve(); f.permission(permission);
  f.args.requestApproval = async () => ({ accepted: false, values: {} });
  await assert.rejects(f.execute(f.args), error => (error as Error).message === uploadDenied);
  const packetFile = path.join(f.root, "graphics/jobs/task-idle/external-request.json"), packet = fs.readFileSync(packetFile);
  assert.equal(f.counts().submissions, 0);
  f.args.recoveryOnly = true;
  await assert.rejects(createGraphicsVideoExecutor(f.deps)(f.args), /명시적인 업로드 재시도/);
  assert.equal(f.counts().uploads, 1);
  f.args.task.status = "failed"; f.args.task.message = uploadDenied;
  prepareGraphicsVideoUploadRetry(f.args);
  f.args.task.status = "running";
  f.args.requestApproval = async () => ({ accepted: true, values: {} });
  await assert.rejects(createGraphicsVideoExecutor(f.deps)(f.args), /생성이 실패/);
  assert.deepEqual(fs.readFileSync(packetFile), packet);
  assert.equal(f.counts().submissions, 1); assert.equal(f.counts().uploads, 2);
  await assert.rejects(createGraphicsVideoExecutor(f.deps)(f.args), /생성이 실패/);
  assert.equal(f.counts().submissions, 1); assert.equal(f.counts().uploads, 2);
});

test("retry proof is consumed once, another denied upload never retries automatically", async t => {
  const f = fixture(t); f.approve(); f.permission(permission); f.args.requestApproval = async () => ({ accepted: false, values: {} });
  await assert.rejects(f.execute(f.args), /user rejected/);
  f.args.task.status = "failed"; f.args.task.message = uploadDenied;
  prepareGraphicsVideoUploadRetry(f.args);
  prepareGraphicsVideoUploadRetry(f.args);
  assert.equal(fs.readdirSync(path.join(f.root, "graphics/jobs/task-idle/upload-retries")).length, 1);
  f.args.recoveryOnly = true;
  await assert.rejects(createGraphicsVideoExecutor(f.deps)(f.args), /user rejected/);
  await assert.rejects(createGraphicsVideoExecutor(f.deps)(f.args), /정확히 한 번/);
  assert.equal(f.counts().uploads, 2); assert.equal(f.counts().submissions, 0);
});

test("missing runtime bridge and cancellation grant no tool permission or paid submission", async t => {
  const missing = fixture(t); missing.approve(); missing.permission(permission);
  await assert.rejects(missing.execute(missing.args), /접근 확인 창/); assert.equal(missing.counts().submissions, 0);
  const cancelled = fixture(t); cancelled.approve(); cancelled.permission(permission);
  cancelled.args.requestApproval = async () => { cancelled.controller.abort(); return { accepted: true, values: {} }; };
  await assert.rejects(cancelled.execute(cancelled.args), /취소|abort/i); assert.equal(cancelled.counts().submissions, 0);
});

test("upload retry rejects missing evidence, ambiguous failures, changed inputs, reservations and stale proofs", async t => {
  const f = fixture(t); f.approve(); f.permission(permission); f.args.requestApproval = async () => ({ accepted: false, values: {} });
  await assert.rejects(f.execute(f.args), /user rejected/);
  f.args.task.status = "failed"; f.args.task.message = "connection lost";
  assert.throws(() => prepareGraphicsVideoUploadRetry(f.args), /확인된 업로드/);
  f.args.task.message = uploadDenied;
  const base = path.join(f.root, "graphics/video-journal/object-1/task-idle"), state = fs.readFileSync(base + "-state.json");
  for (const extra of [{ taskId: "remote-paid" }, { approved: {} }, { assetEncrypted: "cached" }, { status: "submitted" }]) {
    fs.writeFileSync(base + "-state.json", JSON.stringify({ ...JSON.parse(state.toString()), ...extra }));
    assert.throws(() => prepareGraphicsVideoUploadRetry(f.args), /거절 전용/);
  }
  fs.writeFileSync(base + "-state.json", state);
  fs.writeFileSync(base + ".json.tmp", "uncertain reservation");
  assert.throws(() => prepareGraphicsVideoUploadRetry(f.args), /미완료/); fs.unlinkSync(base + ".json.tmp");
  const snapshot = path.join(f.root, "graphics/jobs/task-idle/inputs/runway-source.png"), bytes = fs.readFileSync(snapshot);
  fs.appendFileSync(snapshot, "modified"); assert.throws(() => prepareGraphicsVideoUploadRetry(f.args), /업로드 입력/); fs.writeFileSync(snapshot, bytes);
  prepareGraphicsVideoUploadRetry(f.args); f.args.recoveryOnly = true;
  fs.writeFileSync(base + ".json", JSON.stringify({ jobId: "task-idle", requestHash: JSON.parse(state.toString()).requestHash, entries: [{ state: "reserved" }] }));
  const calls = [...f.calls];
  await assert.rejects(createGraphicsVideoExecutor(f.deps)(f.args), /유료 제출 기록/);
  assert.deepEqual(f.calls, calls); assert.equal(f.counts().submissions, 0);
});

test("explicit recovery without a saved video packet cannot upload or submit", async t => {
  const f = fixture(t); f.approve(); f.args.recoveryOnly = true;
  await assert.rejects(f.execute(f.args), /복구에서 첫 업로드·유료 제출/);
  assert.deepEqual(f.counts(), { submissions: 0, uploads: 0, downloads: 0 }); assert.equal(f.calls.length, 0);
});

test("video preparation is local and requires frozen accepted explicit source and side", t => {
  const f = fixture(t), p = prepareGraphicsVideo(f.args);
  assert.equal(p.cost.credits, 24); assert.equal(p.cost.provider, "Runway"); assert.equal(p.clipName, "Idle"); assert.match(p.cost.basis, /실시간 견적이 아닙니다/);
  assert.deepEqual(f.calls, []); assert(!fs.existsSync(path.join(f.root, "graphics")));
  delete f.args.task.objectSnapshot!.accepted["design:main"];
  assert.throws(() => prepareGraphicsVideo(f.args), /채택/);
  f.args.task.objectSnapshot!.accepted["design:main"] = f.args.inputs[0].id;
  f.args.task.settings.motionSourceView = "front";
  assert.throws(() => prepareGraphicsVideo(f.args), /측면/);
});

test("no upload or generation without the exact durable per-task paid approval", async t => {
  const f = fixture(t);
  await assert.rejects(f.execute(f.args), /저장된 실행 승인/);
  for (const patch of [{ requestHash: "another-task" }, { provider: "Tripo API" }, { credits: 0 }, { approvedAt: "invalid" }]) {
    f.approve(patch); await assert.rejects(f.execute(f.args), /저장된 실행 승인/);
  }
  assert.deepEqual(f.calls, []); assert.deepEqual(f.counts(), { submissions: 0, uploads: 0, downloads: 0 });
});

test("unknown or insufficient account balance stops before upload and recovery cannot begin a fresh submit", async t => {
  for (const balance of [undefined, 0]) {
    const f = fixture(t); f.approve(); f.setBalance(balance);
    await assert.rejects(f.execute(f.args), /잔액/);
    assert.deepEqual(f.calls, ["whoami"]); f.setBalance(200);
    await assert.rejects(createGraphicsVideoExecutor(f.deps)(f.args), /제출 결과 ID/);
    assert.deepEqual(f.calls, ["whoami"]); assert.equal(f.counts().uploads, 0);
  }
});

test("ambiguous paid submission remains blocked after restart with no automatic repayment", async t => {
  const f = fixture(t); f.approve(); f.ambiguous();
  await assert.rejects(f.execute(f.args), /connection lost/);
  const before = [...f.calls];
  await assert.rejects(createGraphicsVideoExecutor(f.deps)(f.args), /제출 결과 ID/);
  assert.deepEqual(f.calls, before); assert.equal(f.counts().submissions, 1);
  const ledger = JSON.parse(fs.readFileSync(path.join(f.root, "graphics/video-journal/object-1/task-idle.json"), "utf8"));
  assert.equal(ledger.entries.length, 1); assert.equal(ledger.entries[0].state, "reserved"); assert.equal(ledger.entries[0].cost, 24);
});

test("known failed task only checks its existing ID after restart", async t => {
  const f = fixture(t); f.approve();
  await assert.rejects(f.execute(f.args), /생성이 실패/);
  await assert.rejects(createGraphicsVideoExecutor(f.deps)(f.args), /생성이 실패/);
  assert.equal(f.counts().submissions, 1); assert.equal(f.counts().uploads, 1); assert.equal(f.calls.filter(call => call === "get_task").length, 2);
  const state = fs.readFileSync(path.join(f.root, "graphics/video-journal/object-1/task-idle-state.json"), "utf8");
  assert(!state.includes("secret=hidden"));
});

test("source mutation and cancellation during upload cannot pass the paid boundary", async t => {
  const changed = fixture(t); changed.approve(); changed.onUpload(() => fs.appendFileSync(changed.sourcePath, "changed"));
  await assert.rejects(changed.execute(changed.args), /해시/); assert.equal(changed.counts().submissions, 0);
  const cancelled = fixture(t); cancelled.approve(); cancelled.onUpload(() => cancelled.controller.abort());
  await assert.rejects(cancelled.execute(cancelled.args), /취소/); assert.equal(cancelled.counts().submissions, 0);
});

test("download interruption recovers the same original and immutable frames without another payment", async t => {
  const f = fixture(t), clipName = "Armature|대기 001.001"; f.args.task.settings.clipName = clipName; f.approve(); f.success(); f.failDownload(true);
  const accepted = structuredClone(f.args.object.accepted), sourceHash = digest(fs.readFileSync(f.sourcePath));
  await assert.rejects(f.execute(f.args), /전송 실패/); f.failDownload(false);
  const result = await createGraphicsVideoExecutor(f.deps)(f.args);
  assert.equal(result.role, "motion-reference"); assert.equal(result.slot, clipName); assert(result.warnings.length > 0);
  assert.deepEqual(f.counts(), { submissions: 1, uploads: 1, downloads: 2 });
  assert.deepEqual(f.args.object.accepted, accepted); assert.equal(digest(fs.readFileSync(f.sourcePath)), sourceHash);
  const manifestFile = result.files.find(file => file.kind === "frames")!;
  const manifest = JSON.parse(fs.readFileSync(path.join(f.root, manifestFile.path), "utf8"));
  assert.equal(manifest.clipName, clipName); assert.equal(manifest.motion, clipName); assert.equal(manifest.mode, "side"); assert.equal(manifest.remoteTaskId, "remote-video-1");
  assert.equal(manifest.frames.length, 3); assert.deepEqual(manifest.frames.map((frame: any) => frame.time), [0, 1, 2]);
  assert.equal(manifest.videos.side.sha256, digest(fs.readFileSync(path.join(f.root, manifest.videos.side.path))));
  for (const frame of manifest.frames) assert.equal(frame.sha256, digest(fs.readFileSync(path.join(f.root, frame.side))));
  const calls = [...f.calls], bytes = fs.readFileSync(path.join(f.root, manifestFile.path));
  const recovered = await createGraphicsVideoExecutor(f.deps)(f.args);
  assert.deepEqual(recovered, result); assert.deepEqual(f.calls, calls); assert.deepEqual(fs.readFileSync(path.join(f.root, manifestFile.path)), bytes);
  fs.appendFileSync(path.join(f.root, manifest.frames[0].side), "tampered");
  await assert.rejects(createGraphicsVideoExecutor(f.deps)(f.args), /해시/); assert.deepEqual(f.calls, calls);
});

test("Idle approval never authorizes a Jump request and changing frozen settings cannot reuse its packet", async t => {
  const f = fixture(t); f.approve();
  await assert.rejects(f.execute(f.args), /생성이 실패/);
  f.args.task.settings.clipName = "Jump";
  await assert.rejects(createGraphicsVideoExecutor(f.deps)(f.args), /고정된 영상 요청/);
  f.args.task.id = "task-jump"; f.args.task.requestHash = "frozen-jump-request"; f.args.task.settings.loop = false;
  await assert.rejects(createGraphicsVideoExecutor(f.deps)(f.args), /저장된 실행 승인/);
  assert.equal(f.counts().submissions, 1);
});
