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
};
type Journal = { jobId: string; requestHash: string; entries: Entry[] };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const validUrl = (
  value: string,
  provider: "chatgpt" | "tripo",
  id?: string,
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
        /^\/(?:[a-z]{2}\/)?workspace\/(generate|texture|smart-uv)\/[^/]+$/.test(
          u.pathname,
        ) &&
        (!id || u.pathname.endsWith(id)))
  );
};

/** Host-only durable journal, kept outside the worker's writable job directory. */
export class ChromeJobLedger {
  private journal: Journal;
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
  begin(args: {
    phase: string;
    observedCost: number;
    sourceModelId: string;
    url: string;
  }) {
    const { request: r, approval: a } = this.packet;
    if (!a.accepted || this.journal.entries.some((e) => e.phase === args.phase))
      throw Error(
        "이미 예약한 단계이거나 승인되지 않았습니다. 새로 제출하지 말고 기존 결과를 확인하세요.",
      );
    let limit: number,
      source = "";
    if (r.step === "concept" && args.phase === "images") limit = 0;
    else if (r.externalModel && args.phase === "model")
      limit = r.externalModel.observedCreditCost;
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
      ) ||
      this.journal.entries.reduce((n, e) => n + e.cost, 0) + args.observedCost >
        a.studioCreditLimit
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
