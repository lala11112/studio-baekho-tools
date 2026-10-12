import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { setTimeout as delay } from "node:timers/promises";
import type { ExternalWorkbenchRunner, WorkbenchExecutionContext, WorkbenchArtifact, WorkbenchResult } from "../shared/workbench";
import { RUNWAY_RATE, runwayEstimate } from "../shared/runway";
import { renderRunwayFrame, runwayFrameLayout, RUNWAY_FULL_BODY_PROMPT } from "../shared/runway-framing";
import { CodexRunwayConnection, type RunwayConnection } from "./runway-client";
import { MotionVideoLedger } from "./motion-video-ledger";
import { prepareMotionVideoFrames } from "./motion-video-media";
import { approvalText } from "./codex-app-server-worker";

type Context = Parameters<ExternalWorkbenchRunner["run"]>[0];
type Saved = { requestHash: string; sourceHash: string; teamId?: number; assetEncrypted?: string;
  uploadModelTurns?: number; uploadUsage?: unknown; uploadHash?: string;
  taskId?: string; status?: string; approved?: { at: string; estimatedCredits: number; basis: Omit<typeof RUNWAY_RATE, "resolution"> & { resolution: string } } };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (file: string) => hash(fs.readFileSync(file));
function save(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".tmp", fd = fs.openSync(temp, "w");
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
function mediaUrl(value: string) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.port || !u.hostname.includes(".") ||
    /^[\d.:[\]]+$/.test(u.hostname) || /(^|\.)(localhost|local|internal)$/.test(u.hostname)) throw Error("Runway 파일 주소 형식이 올바르지 않습니다.");
  return u;
}
/** Paid submission, polling and collection are host-only; a new upload uses one scoped Codex turn. */
export class RunwayWorkbenchRunner implements ExternalWorkbenchRunner {
  private connections = new Set<RunwayConnection>();
  constructor(private options: { journalRoot: string; projectRoot: (id: string) => string; ffmpegPath: string;
    encrypt: (value: string) => string; decrypt: (value: string) => string;
    connection?: () => RunwayConnection; fetch?: typeof fetch; wait?: (signal: AbortSignal) => Promise<void> }) {}
  private records(ctx: WorkbenchExecutionContext) {
    const raw = fs.readFileSync(path.join(ctx.workspace, "external-request.json"));
    if (hash(raw) !== ctx.job.externalExecution?.requestHash) throw Error("고정된 작업 명세가 변경되었습니다.");
    const packet = JSON.parse(raw.toString("utf8"));
    if (packet.jobId !== ctx.job.id) throw Error("Runway 작업 ID가 명세와 다릅니다.");
    const base = path.join(this.options.journalRoot, ctx.workbench.id, ctx.job.id);
    return { packet, stateFile: base + "-state.json", ledger: new MotionVideoLedger(base + ".json", packet, hash(raw)) };
  }
  private source(ctx: Context): { artifact: WorkbenchArtifact; bytes: Buffer } {
    const slot = ctx.job.request.motionVideo?.sourceSlot ?? "whole-reference";
    const selection = ctx.job.dependencies[slot];
    const candidate = ctx.workbench.jobs.find(j => j.id === selection?.jobId)?.candidates.find(c => c.id === selection?.candidateId);
    const artifact = candidate?.artifacts.find(a => a.kind === "image" && a.role === (slot === "motion-source" ? "motion-source" : "whole") && a.view === ctx.job.request.motionVideo?.sourceView);
    if (!artifact || !ctx.inputs.some(a => a.path === artifact.path && a.sha256 === artifact.sha256)) throw Error("채택한 영상 입력 중 선택한 측면 이미지가 필요합니다.");
    const root = fs.realpathSync(this.options.projectRoot(ctx.workbench.projectId)), file = fs.realpathSync(path.resolve(root, artifact.path));
    if (!file.startsWith(root + path.sep)) throw Error("측면 원본이 프로젝트 밖에 있습니다.");
    const bytes = fs.readFileSync(file);
    if (hash(bytes) !== artifact.sha256 || bytes.length !== artifact.bytes || bytes.length < 24 || bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a")
      throw Error("채택한 측면 PNG 원본의 형식·크기·해시가 다릅니다.");
    return { artifact, bytes };
  }
  private async transfer(url: string, init: RequestInit, signal: AbortSignal) {
    mediaUrl(url);
    try {
      const response = await (this.options.fetch ?? fetch)(url, { ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      return response;
    } catch { throw Error("Runway 원본 파일 전송 실패. 저장된 작업을 재생성하지 않습니다."); }
  }
  async run(ctx: Context, progress: (message: string) => void) {
    const { packet, ledger, stateFile } = this.records(ctx), r = packet.request, settings = r.motionVideo;
    if (r.step !== "reference" || settings?.backend !== "runway-mcp" || settings.mode !== "side" || settings.model !== RUNWAY_RATE.model ||
      !["720p", "1080p"].includes(settings.resolution) || settings.serviceUrl !== "https://app.runwayml.com" ||
      (settings.framing !== undefined && settings.framing !== "full-body-v1") ||
      (settings.framing === "full-body-v1" && settings.resolution !== "720p")) throw Error("지원하는 Runway 측면 동작 설정이 아닙니다.");
    const cost = runwayEstimate(settings.nativeDuration);
    if (settings.nativeDuration < r.duration) throw Error("원본 영상 길이가 검토 길이보다 짧습니다.");
    const { artifact, bytes } = this.source(ctx);
    let uploadBytes = bytes;
    let layout: ReturnType<typeof runwayFrameLayout> | undefined;
    if (settings.framing === "full-body-v1") {
      // Validate allocation bounds before PNG decompression. Retain every source pixel.
      layout = runwayFrameLayout(bytes.readUInt32BE(16), bytes.readUInt32BE(20), r.loop === true);
      const png = PNG.sync.read(bytes);
      const framed = new PNG({ width: layout.width, height: layout.height });
      framed.data = Buffer.from(renderRunwayFrame(png.data, layout));
      uploadBytes = PNG.sync.write(framed);
    }
    const uploadHash = hash(uploadBytes), providerPrompt = layout ? `${r.prompt}\n\n${RUNWAY_FULL_BODY_PROMPT}` : r.prompt;
    const state: Saved = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { requestHash: ctx.job.externalExecution!.requestHash, sourceHash: artifact.sha256 };
    if (state.requestHash !== ctx.job.externalExecution!.requestHash || state.sourceHash !== artifact.sha256) throw Error("Runway 체크포인트가 현재 입력과 다릅니다.");
    if (state.uploadHash && state.uploadHash !== uploadHash) throw Error("Runway 전신 입력 구도가 저장된 작업과 다릅니다.");
    state.uploadHash = uploadHash;
    const connection = this.options.connection?.() ?? new CodexRunwayConnection(); this.connections.add(connection);
    const ask = ctx.requestApproval ?? (async () => { throw Error("앱 비용 확인 창을 사용할 수 없습니다."); });
    try {
      if (ctx.signal.aborted) throw Error("취소되었습니다.");
      const receiptFile = path.join(ctx.workspace, "external-result.json");
      if (fs.existsSync(receiptFile)) {
        const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
        ledger.verify(receipt);
        for (const artifact of receipt.files ?? []) {
          const file = fs.realpathSync(path.resolve(ctx.workspace, artifact.path));
          if (!file.startsWith(fs.realpathSync(ctx.workspace) + path.sep) || fileHash(file) !== artifact.sha256) throw Error("저장된 Runway 결과가 변경되었습니다.");
        }
        return { status: "completed" as const, summary: "저장된 Runway 원본과 완료 기록을 재사용했습니다. 새 제출 없이 앱에 등록합니다.", usage: { modelTurns: 0 } };
      }
      // A crash after reserve but before task ID persistence is NEVER a retryable submit.
      if (ledger.read().entries.length && !state.taskId) return { status: "submission_unknown" as const, summary: "제출 여부가 불명확합니다. Runway 작업 내역에서 확인해야 하며 자동 재제출하지 않습니다." };
      progress("Runway 계정과 선택한 영상 모델을 확인합니다.");
      await connection.open(ctx.workspace, ctx.signal, ask);
      const account = await connection.call("whoami", { rationale: "Partsmith 측면 동작 생성 전 계정·잔액·모델 확인" });
      if (!account.authenticated || !account.team?.id) throw Error("Runway 플러그인 계정 연결을 확인하세요.");
      if (state.teamId && state.teamId !== account.team.id) throw Error("이 작업을 시작한 Runway 작업 공간으로 연결하세요.");
      state.teamId = account.team.id; save(stateFile, state);
      if (!state.taskId) {
        if (!account.availableVideoModels?.includes(settings.model)) throw Error("연결한 계정에서 선택한 영상 모델을 사용할 수 없습니다.");
        if (!Number.isFinite(account.credits?.total) || account.credits.total < cost) throw Error(`예상 ${cost}크레딧에 필요한 잔액이 없습니다.`);
        const snapshot = path.join(ctx.workspace, "inputs", "runway-source.png");
        fs.mkdirSync(path.dirname(snapshot), { recursive: true });
        if (fs.existsSync(snapshot)) {
          if (fileHash(snapshot) !== uploadHash) throw Error("업로드용 입력 사본이 변경되었습니다.");
        } else fs.writeFileSync(snapshot, uploadBytes, { flag: "wx" });
        if (layout) save(path.join(ctx.workspace, "inputs", "runway-framing.json"), { ...layout, sourceSha256: artifact.sha256, uploadSha256: uploadHash, prompt: providerPrompt });
        const uploadCache = path.join(this.options.journalRoot, "uploads", String(state.teamId), `${uploadHash}.json`);
        if (!state.assetEncrypted && fs.existsSync(uploadCache)) {
          const cached: Saved = JSON.parse(fs.readFileSync(uploadCache, "utf8"));
          if (cached.teamId !== state.teamId || cached.sourceHash !== artifact.sha256 || (cached.uploadHash ?? cached.sourceHash) !== uploadHash || !cached.assetEncrypted) throw Error("Runway 원본 업로드 캐시가 일치하지 않습니다.");
          mediaUrl(this.options.decrypt(cached.assetEncrypted));
          state.assetEncrypted = cached.assetEncrypted; state.uploadModelTurns = 0; save(stateFile, state);
          progress("같은 계정에 이미 올린 동일한 입력 구도를 재사용합니다. 새 업로드나 GPT 호출은 없습니다.");
        }
        if (!state.assetEncrypted) {
          progress(layout ? "원본 픽셀을 보존하고 배경 여백을 더한 16:9 전신 입력을 Runway에 업로드합니다." : "채택한 측면 PNG 원본을 Runway에 업로드합니다. 크기와 화질을 유지합니다.");
          // This Codex connector exposes a local-file parameter. The connector uploads
          // the bytes; a metadata-only request is explicitly unsupported in this runtime.
          const uploaded = await connection.call("init_upload", { file: snapshot,
            rationale: "Partsmith의 미리보기와 같은 토끼 측면 PNG 입력을 업로드. 유료 생성은 아직 승인 전입니다." });
          if (uploaded.kind !== "upload_complete" || !uploaded.assetUrl) throw Error("Runway 원본 업로드가 완료되지 않았습니다.");
          mediaUrl(uploaded.assetUrl); state.assetEncrypted = this.options.encrypt(uploaded.assetUrl);
          state.uploadModelTurns = uploaded.uploadModelTurns ?? 0; state.uploadUsage = uploaded.uploadUsage; save(stateFile, state);
          save(uploadCache, { sourceHash: state.sourceHash, uploadHash, teamId: state.teamId, assetEncrypted: state.assetEncrypted });
        }
        progress(`측면 원본 업로드 완료. ${r.motion} 1개 · ${settings.nativeDuration}초 · 예상 ${cost}크레딧의 앱 확인을 기다립니다.`);
        const answer = await ask({ id: `runway-cost-${ctx.job.id}`, title: `${r.motion} · 측면 영상 1개 생성`,
          detail: `${settings.model} · ${settings.resolution} · ${settings.nativeDuration}초 · ${layout ? "16:9 전신 구도 / 원본 픽셀 보존 + 배경 여백" : "원본 PNG 그대로 사용"}\n새 영상 1개 추가 예상 ${cost}크레딧 (공식 공개 요율 ${RUNWAY_RATE.creditsPerSecond}/초, ${RUNWAY_RATE.checkedAt} 확인). 실시간 견적 API는 없으며 최종 차감은 Runway 기준입니다. 현재 잔액 ${account.credits.total}.\n기존 결과는 보존합니다. 이 동작 1개만 제출하며 자동 재생성하지 않습니다. 결과는 앱에서 검토·채택하며 3D 작업은 시작하지 않습니다.\n${providerPrompt}`, fields: [] });
        if (!answer.accepted || ctx.signal.aborted) return { status: "needs_input" as const, summary: "생성 승인을 받지 않아 제출하지 않았습니다. 업로드한 원본은 보존했습니다." };
        state.approved = { at: new Date().toISOString(), estimatedCredits: cost, basis: { ...RUNWAY_RATE, resolution: settings.resolution } }; save(stateFile, state);
        this.source(ctx); // Revalidate accepted source immediately before the paid boundary.
        const assetUrl = this.options.decrypt(state.assetEncrypted!); mediaUrl(assetUrl);
        ledger.reserveApproved({ phase: "side", observedCost: cost, costBasis: "published-rate", model: settings.model, duration: settings.nativeDuration,
          resolution: settings.resolution, url: settings.serviceUrl, sourceModelId: "" });
        progress("승인한 측면 영상 1개를 Runway에 제출합니다.");
        const created = await connection.call("generate_video", { model: settings.model, promptText: providerPrompt, duration: settings.nativeDuration,
          resolution: settings.resolution, ...(layout ? { ratio: layout.ratio } : {}), startFrame: { url: assetUrl }, rationale: `Partsmith에서 승인한 ${r.motion} 측면 동작 1개` });
        if (!created.taskId || !/^[\w-]{1,200}$/.test(created.taskId)) return { status: "submission_unknown" as const, summary: "Runway 작업 ID를 확인하지 못했습니다. 재제출하지 않습니다." };
        state.taskId = created.taskId; state.status = created.status ?? "submitted"; save(stateFile, state);
      }
      let task: any;
      for (let count = 0; count < 30; count++) {
        if (ctx.signal.aborted) throw Error("취소되었습니다.");
        task = await connection.call("get_task", { id: state.taskId, rationale: "이미 제출한 측면 동작 결과만 확인" });
        if (task.taskId !== state.taskId) throw Error("Runway 결과 작업 ID가 다릅니다.");
        state.status = task.kind; save(stateFile, state);
        if (task.kind === "video" || task.kind === "task_failed") break;
        if (task.kind !== "task_pending") throw Error("Runway 작업에 사용할 수 있는 영상 원본이 없습니다.");
        progress(`Runway에서 ${r.motion} 생성 중입니다. 기존 작업만 확인합니다 (${count + 1}/30).`);
        await (this.options.wait?.(ctx.signal) ?? delay(60000, undefined, { signal: ctx.signal }));
      }
      if (task.kind === "task_failed") throw Error("Runway 생성이 실패했습니다. 기존 작업을 보존하며 자동 재생성하지 않습니다.");
      if (task.kind !== "video" || !task.url) return { status: "needs_input" as const, summary: "Runway가 아직 생성 중입니다. 기존 작업 이어서 확인으로 결과를 수집하세요." };
      ledger.complete({ phase: "side", resultId: state.taskId!, url: settings.serviceUrl });
      const relative = "outputs/video-reference/side.mp4", file = path.join(ctx.workspace, relative);
      if (!ledger.read().entries[0].download) {
        progress("완료된 Runway 원본 영상을 내려받습니다.");
        const response = await this.transfer(task.url, {}, ctx.signal);
        const chunks: Buffer[] = []; let size = 0;
        if (!response.body) throw Error("Runway 원본 영상이 비어 있습니다.");
        for await (const chunk of response.body as any) { size += chunk.length; if (size > 256 * 1024 * 1024) throw Error("원본 영상 크기 한도를 초과했습니다."); chunks.push(Buffer.from(chunk)); }
        const video = Buffer.concat(chunks);
        if (video.toString("ascii", 4, 8) !== "ftyp") throw Error("Runway 결과가 MP4 원본이 아닙니다.");
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + ".tmp", video); fs.renameSync(file + ".tmp", file);
        ledger.recordDownload("side", { path: relative, sha256: hash(video) });
      }
      progress("원본 해상도에서 주요 시점 프레임을 추출하고 앱에 등록합니다.");
      const decoded = await prepareMotionVideoFrames(this.options.ffmpegPath, ctx.workspace, r, ledger.read().entries, ctx.signal);
      ledger.recordDecoded(decoded.artifacts.filter(a => a.kind !== "video").map(a => ({ path: a.path, sha256: fileHash(path.join(ctx.workspace, a.path)) })));
      const provenance = "outputs/video-reference/runway-provenance.json";
      save(path.join(ctx.workspace, provenance), { backend: "runway-mcp", taskId: state.taskId, teamId: state.teamId, model: settings.model,
        source: { path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes, view: settings.sourceView }, approval: state.approved,
        duration: settings.nativeDuration, resolution: settings.resolution, framing: layout, uploadSha256: uploadHash, prompt: providerPrompt,
        serviceUrl: settings.serviceUrl, uploadModelTurns: state.uploadModelTurns, orchestrationModelTurns: 0, visualReview: "pending" });
      const actual = JSON.parse(fs.readFileSync(path.join(ctx.workspace, "outputs/video-reference/decode-report.json"), "utf8")).metadata.side;
      const artifacts = [...decoded.artifacts, { path: provenance, kind: "report" as const }];
      const result: WorkbenchResult = { status: "completed", summary: `${r.motion} 측면 원본 영상이 준비됐습니다. 외형·발 접지·동작을 확인한 뒤 채택하세요.`,
        candidates: [{ id: `runway-${state.taskId}`, label: `${r.motion} · 측면`, artifacts }], checks: [
          { name: "native_video_decode", passed: true }, { name: "visual_quality", passed: false, severity: "warning", visualCategory: "appearance",
            detail: `실제 원본 ${actual.width}×${actual.height}. 귀 끝·네 발이 전 구간에 보이는지, 외형 유지·발 접지·착지·반복 연결을 검토하세요. 자동 검증됐다고 간주하지 않습니다.` },
          ...(layout && (actual.width !== 1280 || actual.height !== 720) ? [{ name: "visual_quality", passed: false, severity: "warning" as const, visualCategory: "appearance" as const,
            detail: `요청한 16:9 720p(1280×720)와 실제 ${actual.width}×${actual.height}가 다릅니다. 원본 보존, 자동 재생성 없음.` }] : [])] };
      const entry = ledger.read().entries[0];
      const receipt = { schemaVersion: 1, jobId: ctx.job.id, requestHash: ctx.job.externalExecution!.requestHash, result,
        files: artifacts.map(a => ({ path: a.path, sha256: fileHash(path.join(ctx.workspace, a.path)) })),
        videos: [{ view: "side", resultId: state.taskId!, url: settings.serviceUrl, ...entry.download! }] };
      ledger.verify(receipt); save(path.join(ctx.workspace, "external-result.json"), receipt);
      return { status: "completed" as const, summary: result.summary, usage: { uploadModelTurns: state.uploadModelTurns, upload: state.uploadUsage, orchestrationModelTurns: 0 } };
    } catch (error) {
      return { status: ledger.read().entries.length && !state.taskId ? "submission_unknown" as const : "needs_input" as const,
        summary: ctx.signal.aborted ? "취소되었습니다. 원본과 기존 작업 ID를 보존했으며 자동 재시작하지 않습니다." : approvalText(error instanceof Error ? error.message : "Runway 연결 오류") };
    } finally { connection.close(); this.connections.delete(connection); }
  }
  verifyReceipt(ctx: WorkbenchExecutionContext) {
    this.records(ctx).ledger.verify(JSON.parse(fs.readFileSync(path.join(ctx.workspace, "external-result.json"), "utf8")));
  }
  shutdown() { for (const connection of this.connections) connection.close(); }
}

export function routeExternalRunners(chrome: ExternalWorkbenchRunner, runway: ExternalWorkbenchRunner): ExternalWorkbenchRunner {
  const choose = (ctx: WorkbenchExecutionContext) => ctx.job.request.motionVideo?.backend === "runway-mcp" ? runway : chrome;
  return { run: (ctx, progress) => choose(ctx).run(ctx, progress), verifyReceipt: ctx => choose(ctx).verifyReceipt(ctx),
    repairApproval:ctx=>{if(ctx.job.request.motionVideo||!chrome.repairApproval)throw Error('UV 승인 전달 복구 대상이 아닙니다.');chrome.repairApproval(ctx);},
    shutdown: () => { chrome.shutdown?.(); runway.shutdown?.(); } };
}
