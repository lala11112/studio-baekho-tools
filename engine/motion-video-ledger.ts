import fs from "node:fs";
import path from "node:path";
import { motionVideoViews, motionServiceUrl } from "../shared/motion-video";
import type { ChromePacket } from "./chrome-job-ledger";

export type VideoPlan = { phase: string; observedCost: number; costBasis?: "published-rate"; model: string; duration: number; resolution: string; url: string; sourceModelId: string };
type VideoEntry = { phase: string; cost: number; sourceModelId: string; url: string; state: "reserved" | "completed"; resultId?: string; resultUrl?: string; plan: VideoPlan; download?: { path: string; sha256: string } };
type Journal = { jobId: string; requestHash: string; entries: VideoEntry[]; decoded?: { path: string; sha256: string }[] };

/** Outside the worker workspace. Approval freezes the actual service settings before ONE click per view. */
export class MotionVideoLedger {
  private journal: Journal;
  constructor(private file: string, private packet: ChromePacket, requestHash: string) {
    this.journal = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { jobId: packet.jobId, requestHash, entries: [] };
    if (this.journal.jobId !== packet.jobId || this.journal.requestHash !== requestHash) throw Error("영상 작업 기록이 다릅니다.");
  }
  read() { return structuredClone(this.journal); }
  private persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + ".tmp", fd = fs.openSync(temp, "w");
    try { fs.writeFileSync(fd, JSON.stringify(this.journal, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
  }
  private url(text: string) {
    const actual = motionServiceUrl(text), expected = motionServiceUrl(this.packet.request.motionVideo!.serviceUrl);
    if (actual.origin !== expected.origin) throw Error("선택한 영상 서비스의 주소가 아닙니다.");
    return text;
  }
  validatePlan(plan: VideoPlan) {
    if (!this.packet.approval.accepted || !motionVideoViews(this.packet.request.motionVideo?.mode).includes(plan.phase as any) ||
        this.journal.entries.some(e => e.phase === plan.phase)) throw Error("승인되지 않았거나 이미 제출 예약된 방향입니다. 재생성하지 마세요.");
    const r = this.packet.request;
    if (!Number.isFinite(plan.observedCost) || plan.observedCost < 0 || plan.model !== r.motionVideo?.model ||
        !Number.isFinite(plan.duration) || plan.duration < r.duration! || plan.duration > 30 ||
        !plan.resolution?.trim() || plan.resolution.length > 100) throw Error("실제 영상 모델·길이·해상도·비용 설정을 확인하세요.");
    this.url(plan.url);
    const front = this.journal.entries.find(e => e.phase === "front" && e.state === "completed");
    if (this.packet.request.motionVideo?.mode === "side" ? plan.sourceModelId !== "" : (plan.phase === "front" ? plan.sourceModelId !== "" : !front?.download || plan.sourceModelId !== front.resultId))
      throw Error("측면·후면은 완료된 정면 동작 원본을 참조해야 합니다. 독립된 다른 동작으로 대체하지 마세요.");
  }
  /** Call ONLY after the host has received the matching app approval. */
  reserveApproved(plan: VideoPlan) {
    this.validatePlan(plan);
    const entry: VideoEntry = { phase: plan.phase, cost: plan.observedCost, sourceModelId: plan.sourceModelId, url: plan.url, state: "reserved", plan: structuredClone(plan) };
    this.journal.entries.push(entry); this.persist(); return structuredClone(entry);
  }
  begin(_args: unknown): never { throw Error("영상 제출은 앱의 실제 비용 확인 후 전용 제출 도구를 사용하세요."); }
  complete(args: { phase: string; resultId: string; url: string }) {
    const entry = this.journal.entries.find(e => e.phase === args.phase);
    if (!entry || !/^[a-zA-Z0-9_-]{1,200}$/.test(args.resultId)) throw Error("실제 영상 결과 ID가 필요합니다.");
    this.url(args.url);
    if (entry.state === "completed" && (entry.resultId !== args.resultId || entry.resultUrl !== args.url)) throw Error("완료한 결과를 바꿀 수 없습니다.");
    if (this.journal.entries.some(e => e !== entry && e.resultId === args.resultId)) throw Error("서로 다른 방향 결과 ID가 필요합니다.");
    Object.assign(entry, { state: "completed", resultId: args.resultId, resultUrl: args.url }); this.persist(); return structuredClone(entry);
  }
  recordDownload(phase: string, download: { path: string; sha256: string }) {
    const entry = this.journal.entries.find(e => e.phase === phase && e.state === "completed");
    if (!entry || !/\.mp4$/i.test(download.path) || !/^[a-f0-9]{64}$/.test(download.sha256)) throw Error("완료한 영상의 MP4 원본이 필요합니다.");
    if (entry.download && JSON.stringify(entry.download) !== JSON.stringify({ path: download.path, sha256: download.sha256 })) throw Error("원본 다운로드를 덮어쓸 수 없습니다.");
    entry.download = { path: download.path, sha256: download.sha256 }; this.persist();
  }
  recordDecoded(files: { path: string; sha256: string }[]) {
    if (!files.length || files.some(f => !f.path.startsWith("outputs/video-reference/") || !/^[a-f0-9]{64}$/.test(f.sha256))) throw Error("원본 프레임 추출 기록이 올바르지 않습니다.");
    if (this.journal.decoded && JSON.stringify(this.journal.decoded) !== JSON.stringify(files)) throw Error("기존 추출 원본을 덮어쓸 수 없습니다.");
    this.journal.decoded = structuredClone(files); this.persist();
  }
  verify(receipt: { files?: { path: string; sha256: string }[]; videos?: { view: string; resultId: string; url: string; path: string; sha256: string }[]; result?: { candidates: { artifacts: { kind: string; role?: string; path: string }[] }[] } }) {
    if (!this.journal.decoded?.length || this.journal.decoded.some(file => !receipt.files?.some(f => f.path === file.path && f.sha256 === file.sha256)))
      throw Error("원본 영상에서 추출한 프레임·명세가 호스트 기록과 다릅니다.");
    const views = motionVideoViews(this.packet.request.motionVideo?.mode);
    if (receipt.videos?.length !== views.length || new Set(receipt.videos.map(v => v.view)).size !== views.length || this.journal.entries.length !== views.length)
      throw Error("요청한 방향별 영상의 제출·다운로드 기록이 필요합니다.");
    for (const view of views) {
      const e = this.journal.entries.find(e => e.phase === view), v = receipt.videos.find(v => v.view === view);
      if (!e || e.state !== "completed" || !e.download || !v || e.resultId !== v.resultId || e.resultUrl !== v.url ||
          e.download.path !== v.path || e.download.sha256 !== v.sha256 ||
          !receipt.result?.candidates.flatMap(c => c.artifacts).some(a => a.kind === "video" && a.role === view && a.path === v.path)) throw Error("영상 결과가 호스트 제출·다운로드 기록과 다릅니다.");
    }
  }
}
