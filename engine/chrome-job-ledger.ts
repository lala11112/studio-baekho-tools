import fs from "node:fs";
import path from "node:path";
import type {
  WorkbenchRequest,
  WorkbenchSurfaceReceipt,
} from "../shared/workbench";

export type ChromePacket = {
  jobId: string;
  request: WorkbenchRequest;
  approval: {
    accepted: boolean;
    studioCreditLimit: number;
    imageCreditLimit: number;
  };
  sourceStudioModel?: { modelId: string; url: string };
};
type Entry = {
  phase: string;
  sourceModelId: string;
  cost: number;
  url: string;
  state: "reserved" | "completed";
  reservedAt: string;
  resultId?: string;
  resultUrl?: string;
  approvedModelPlan?: ModelPlan;
};
export type ModelPlan = {
  observedCost: number; url: string; model: "P2.0";
  topology: "quad" | "triangle"; generationCount: number; polygonCount: number;
  inputMode: "single" | "multiview";
};
type Journal = { jobId: string; requestHash: string; entries: Entry[]; modelResults?: {modelId:string;url:string;observations?:string[]}[] };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const validUrl = (
  value: string,
  provider: "chatgpt" | "tripo",
  id?: string,
  allowModelDraft = false,
) => {
  const u = new URL(value);
  return (
    u.protocol === "https:" &&
    !u.port &&
    !u.username &&
    !u.password &&
    !u.search &&
    !u.hash &&
    (provider === "chatgpt"
      ? u.hostname === "chatgpt.com" && (!id || u.pathname === `/c/${id}`)
      : u.hostname === "studio.tripo3d.ai" &&
        (/^\/(?:[a-z]{2}\/)?workspace\/(generate|texture|smart-uv)\/[^/]+$/.test(
          u.pathname,
        ) || (allowModelDraft && !id && /^\/(?:[a-z]{2}\/)?workspace\/generate\/?$/.test(u.pathname))) &&
        (!id || u.pathname.endsWith(id)))
  );
};

/** Host-only durable journal, kept outside the worker's writable job directory. */
export class ChromeJobLedger {
  private journal: Journal;
  private modelApprovalPending = false;
  constructor(
    private file: string,
    private packet: ChromePacket,
    requestHash: string,
  ) {
    this.journal = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : { jobId: packet.jobId, requestHash, entries: [] };
    if (
      this.journal.jobId !== packet.jobId ||
      this.journal.requestHash !== requestHash
    )
      throw Error("Chrome 제출 기록의 작업/명세가 일치하지 않습니다.");
  }
  read() {
    return structuredClone(this.journal);
  }
  private persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(this.journal, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }
  async approveModel(plan: ModelPlan, approve: (plan: ModelPlan) => Promise<boolean>, cancelled: () => boolean) {
    const r = this.packet.request, settings = r.externalModel;
    const frozen = structuredClone(plan);
    if (this.modelApprovalPending || !this.packet.approval.accepted || r.step !== "model" ||
        r.executionMode !== "codex-app" || settings?.costApproval !== "in-app" ||
        this.journal.entries.length || cancelled() ||
        frozen.model !== settings.model || frozen.topology !== settings.topology ||
        frozen.inputMode !== (settings.inputMode ?? "multiview") ||
        frozen.generationCount !== r.generationCount || frozen.polygonCount !== r.polygonCount ||
        !Number.isSafeInteger(frozen.observedCost) || frozen.observedCost < 0 ||
        !validUrl(frozen.url, "tripo", undefined, true))
      throw Error("모델 설정·개수·면 수·입력·비용 또는 제출 기록이 맞지 않습니다. 제출하지 마세요.");
    this.modelApprovalPending = true;
    try {
      if (!await approve(structuredClone(frozen)) || cancelled())
        throw Error("사용자가 모델 생성을 승인하지 않았거나 취소했습니다. 제출하지 마세요.");
      return this.reserve({phase:"model", sourceModelId:"", observedCost:frozen.observedCost, url:frozen.url}, frozen);
    } finally { this.modelApprovalPending = false; }
  }
  begin(args: {
    phase: string; observedCost: number; sourceModelId: string; url: string;
  }) { return this.reserve(args); }
  private reserve(args: {
    phase: string;
    observedCost: number;
    sourceModelId: string;
    url: string;
  }, approvedModelPlan?: ModelPlan) {
    const { request: r, approval: a } = this.packet;
    if (!a.accepted || this.journal.entries.some((e) => e.phase === args.phase))
      throw Error(
        "이미 예약한 단계이거나 승인되지 않았습니다. 새로 제출하지 말고 기존 결과를 확인하세요.",
      );
    let limit: number,
      source = "";
    if (r.step === "concept" && args.phase === "images") limit = 0;
    else if (r.externalModel && args.phase === "model") {
      if (r.externalModel.costApproval === "in-app" && !approvedModelPlan)
        throw Error("앱에서 실제 모델 생성 비용을 먼저 승인해야 합니다. studio_model_begin을 사용하세요.");
      limit = approvedModelPlan?.observedCost ?? r.externalModel.observedCreditCost;
    }
    else if (r.externalSurface && args.phase === "uv") {
      limit = r.externalSurface.observedUvCost;
      source = this.packet.sourceStudioModel?.modelId ?? "";
      if (!uuid.test(source)) throw Error("채택한 모델 ID가 없습니다.");
    } else if (r.externalSurface && args.phase === "texture") {
      const uv = this.journal.entries.find(
        (e) => e.phase === "uv" && e.state === "completed",
      );
      if (!uv?.resultId) throw Error("완료한 Smart UV 결과가 필요합니다.");
      limit = r.externalSurface.observedTextureCost;
      source = uv.resultId;
    } else throw Error("이 작업 명세에 없는 생성 단계입니다.");
    if (
      !Number.isSafeInteger(args.observedCost) ||
      args.observedCost < 0 ||
      args.observedCost > limit ||
      args.sourceModelId !== source ||
      !validUrl(
        args.url,
        r.step === "concept" ? "chatgpt" : "tripo",
        source || undefined,
        args.phase === "model",
      ) ||
      this.journal.entries.reduce((n, e) => n + e.cost, 0) + args.observedCost >
        (approvedModelPlan?.observedCost ?? a.studioCreditLimit)
    )
      throw Error(
        "화면 비용/대상/주소가 승인한 범위를 벗어났습니다. 제출하지 마세요.",
      );
    const entry: Entry = {
      phase: args.phase,
      sourceModelId: source,
      cost: args.observedCost,
      url: args.url,
      state: "reserved",
      reservedAt: new Date().toISOString(),
      ...(approvedModelPlan ? {approvedModelPlan} : {}),
    };
    this.journal.entries.push(entry);
    this.persist();
    return structuredClone(entry);
  }
  complete(args: { phase: string; resultId: string; url: string }) {
    const entry = this.journal.entries.find((e) => e.phase === args.phase);
    const images = args.phase === "images";
    if (
      !entry ||
      !(images
        ? /^[a-zA-Z0-9-]+$/.test(args.resultId)
        : uuid.test(args.resultId)) ||
      !validUrl(args.url, images ? "chatgpt" : "tripo", args.resultId)
    )
      throw Error("관찰된 결과 ID/주소가 올바르지 않습니다.");
    if (
      entry.state === "completed" &&
      (entry.resultId !== args.resultId || entry.resultUrl !== args.url)
    )
      throw Error("이미 기록한 결과를 다른 결과로 바꿀 수 없습니다.");
    Object.assign(entry, {
      state: "completed",
      resultId: args.resultId,
      resultUrl: args.url,
    });
    this.persist();
    return structuredClone(entry);
  }
  recordModelResult(modelId:string,url:string,observations?:string[]) {
    if(observations!==undefined && (!Array.isArray(observations)||observations.length>8||observations.some(o=>typeof o!=="string"||!o.trim()||o.length>500)))throw Error("외형 관찰은 500자 이내 최대 8개로 기록하세요.");
    const entry=this.journal.entries.find(e=>e.phase==='model' && e.state==='completed');
    if(!this.packet.request.externalModel || !entry || !uuid.test(modelId) || !validUrl(url,'tripo',modelId) || !/^\/(?:[a-z]{2}\/)?workspace\/generate\//.test(new URL(url).pathname))
      throw Error('완료된 모델 배치의 실제 모델 ID와 주소가 필요합니다.');
    const results=this.journal.modelResults ?? [{modelId:entry.resultId!,url:entry.resultUrl!}];
    const old=results.find(r=>r.modelId===modelId);
    if(old && old.url!==url)throw Error('기록한 모델 주소를 변경할 수 없습니다.');
    if(!old){
      if(results.length >= (this.packet.request.generationCount ?? 4))throw Error('승인한 모델 개수를 초과했습니다.');
      results.push({modelId,url});
    }
    if(observations?.length){const item=results.find(r=>r.modelId===modelId)!;item.observations=[...new Set([...(item.observations??[]),...observations])];}
    this.journal.modelResults=results;this.persist();return structuredClone(results);
  }
  verify(receipt: {
    surface?: WorkbenchSurfaceReceipt;
    conversationUrl?: string;
    studioModels?: { modelId: string; url: string }[];
  }) {
    const r = this.packet.request;
    const expected = r.externalSurface
      ? ["uv", "texture"]
      : [r.externalModel ? "model" : "images"];
    if (
      this.journal.entries.length !== expected.length ||
      expected.some(
        (p) =>
          !this.journal.entries.some(
            (e) => e.phase === p && e.state === "completed",
          ),
      )
    )
      throw Error("호스트가 보존한 단계별 제출·완료 기록이 부족합니다.");
    if (r.externalSurface) {
      for (const phase of ["uv", "texture"] as const) {
        const e = this.journal.entries.find((e) => e.phase === phase)!;
        const got = receipt.surface?.[phase];
        if (
          !got ||
          got.modelId !== e.resultId ||
          got.sourceModelId !== e.sourceModelId ||
          got.url !== e.resultUrl ||
          got.creditCost !== e.cost
        )
          throw Error("UV·텍스처 결과가 호스트 제출 기록과 다릅니다.");
      }
    } else if (r.externalModel) {
      const recorded=this.journal.modelResults;
      if(recorded && (recorded.length!==(r.generationCount??4)||receipt.studioModels?.length!==recorded.length||recorded.some(m=>!receipt.studioModels?.some(s=>s.modelId===m.modelId&&s.url===m.url))))throw Error("모델 배치 결과가 호스트 기록과 다릅니다.");
      if (
        !receipt.studioModels?.some(
          (s) =>
            s.modelId === this.journal.entries[0].resultId &&
            s.url === this.journal.entries[0].resultUrl,
        )
      )
        throw Error("모델 결과가 호스트 제출 기록과 다릅니다.");
    } else if (receipt.conversationUrl !== this.journal.entries[0].resultUrl)
      throw Error("이미지 대화가 호스트 제출 기록과 다릅니다.");
  }
}
