import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Store, uid } from "./store";
import { Tripo, TripoError } from "./tripo";
import { catalog } from "../shared/catalog";
import {
  identity,
  type Asset,
  type Generation,
  type Job,
  type Part,
  type Project,
  type Quote,
} from "../shared/types";
const generationSchema = z.object({
  kind: z.enum([
    "image",
    "edit",
    "model",
    "rig-check",
    "rig",
    "animate",
    "segment",
    "smartsegment",
    "complete",
    "retopology",
    "uv-pack",
    "texture",
    "convert",
  ]),
  prompt: z.string().max(6000),
  model: z.string().max(80),
  size: z.string().max(30).optional(),
  count: z.number().int().min(1).max(4),
  partId: z.string().optional(),
  sourceId: z.string().optional(),
  sourceTaskId: z.string().optional(),
  animation: z.string().optional(),
  inputMode: z.enum(["image", "text", "multiview"]).optional(),
  sourceIds: z.array(z.string()).min(1).max(4).optional(),
  faceLimit: z.number().int().positive().max(1000000).optional(),
  quad: z.boolean().optional(),
  texture: z.boolean().optional(),
  pbr: z.boolean().optional(),
  exportUv: z.boolean().optional(),
  textureQuality: z
    .enum(["fast", "standard", "detailed", "extreme"])
    .optional(),
  textureVersion: z.string().max(80).optional(),
  segmentationGranularity: z
    .enum(["simple", "balanced", "detailed"])
    .optional(),
  splitByConnectivity: z.boolean().optional(),
  smartGranularity: z.enum(["coarse", "medium", "fine"]).optional(),
  segType: z.enum(["image", "model"]).optional(),
  completionMode: z.enum(["ai_completion", "quick_cap"]).optional(),
  partNames: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  bake: z.boolean().optional(),
  textureSize: z.number().int().optional(),
  format: z.enum(["GLTF", "FBX", "OBJ", "STL", "USDZ", "3MF"]).optional(),
  rigType: z.enum(["biped", "quadruped"]).optional(),
});
const processing = [
  "segment",
  "smartsegment",
  "complete",
  "retopology",
  "uv-pack",
  "texture",
  "convert",
  "rig-check",
  "rig",
  "animate",
];
const modelInputs = [
  "segment",
  "retopology",
  "uv-pack",
  "texture",
  "convert",
  "rig-check",
  "rig",
];
const modelFormats = ["glb", "gltf", "fbx", "obj", "stl", "usdz", "3mf", "zip"];

/** Inspect content before URL suffix: Tripo P2 quad can return FBX despite a generic URL. */
function outputExtension(
  url: string,
  bytes: Uint8Array,
  image: boolean,
): string {
  const b = Buffer.from(bytes),
    header = b.subarray(0, 128).toString("utf8");
  if (b.subarray(0, 4).toString("ascii") === "glTF") return "glb";
  if (
    header.startsWith("Kaydara FBX Binary") ||
    /^(;\s*FBX|FBXHeaderExtension)/.test(header.trimStart())
  )
    return "fbx";
  if (
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "jpg";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP")
    return "webp";
  const ext = path.extname(new URL(url).pathname).slice(1).toLowerCase();
  if (b[0] === 80 && b[1] === 75)
    return ["usdz", "3mf"].includes(ext) ? ext : "zip";
  // Text/native formats have no shared signature here. Binary previews and images
  // must match magic bytes; a signed CDN URL can still return an HTML error.
  if (!image && ["gltf", "obj", "stl"].includes(ext)) return ext;
  throw new Error(
    "결과 파일 형식을 확인하지 못했습니다. 원격 작업 ID를 유지합니다.",
  );
}
export class Engine {
  private busy = new Set<string>();
  private imageQueueBusy = false;
  constructor(
    public store: Store,
    public tripo: Tripo,
    private modelPreview?: (
      projectId: string,
      nativeRelative: string,
    ) => Promise<string>,
  ) {}
  create(name: string, demo = false) {
    const now = new Date().toISOString();
    const p: Project = {
      schemaVersion: 1,
      id: uid(),
      name: z.string().trim().min(1).max(100).parse(name),
      style: "스타일라이즈드 · 게임 캐릭터",
      height: 1.7,
      unityPath: this.store.settings.unityPath,
      unityFolder: "PartsmithGenerated",
      createdAt: now,
      updatedAt: now,
      revision: 0,
      assets: [],
      parts: [],
      jobs: [],
      assemblies: [],
      builds: [],
      demo,
    };
    p.parts = [
      this.part("몸체", "body"),
      this.part("머리", "head"),
      this.part("헤어", "hair"),
    ];
    return this.store.save(p);
  }
  part(name: string, role: Part["role"] = "other"): Part {
    return {
      id: uid(),
      name,
      role,
      prompt: "",
      candidates: [],
      locked: false,
      visible: true,
      transform: identity(),
      occluded: false,
    };
  }
  touch(p: Project) {
    p.revision++;
    return this.store.save(p);
  }
  asset(
    p: Project,
    file: string,
    kind: Asset["kind"],
    label: string,
    origin: Asset["origin"],
    extra: Partial<Asset> = {},
  ) {
    const a: Asset = {
      id: uid(),
      file,
      kind,
      label,
      origin,
      createdAt: new Date().toISOString(),
      ...extra,
    };
    p.assets.push(a);
    return a;
  }
  quote(id: string, raw: Generation) {
    const p = this.store.project(id),
      r = generationSchema.parse(raw);
    const asset = (assetId: string | undefined, kind: Asset["kind"]) => {
      const a = p.assets.find((x) => x.id === assetId);
      if (!a || a.kind !== kind)
        throw new Error(
          kind === "image"
            ? "입력 이미지를 선택하세요."
            : "입력 모델을 선택하세요.",
        );
      if (!fs.existsSync(this.store.file(id, a.file)))
        throw new Error("입력 파일이 없습니다. 프로젝트 파일을 복구하세요.");
      return a;
    };
    if (r.partId) {
      const part = p.parts.find((x) => x.id === r.partId);
      if (!part) throw new Error("파츠를 찾을 수 없습니다.");
      if (part.locked) throw new Error("고정한 파츠입니다. 잠금을 해제하세요.");
    }
    if (r.kind === "image" || r.kind === "edit") {
      const model = catalog.image.find((m) => m.id === r.model);
      if (!model || !model.sizes.includes(r.size ?? ""))
        throw new Error("지원 목록에서 모델과 해상도를 선택하세요.");
      if (!r.prompt.trim()) throw new Error("프롬프트를 입력하세요.");
    }
    if (r.kind === "model") {
      if (!catalog.model.some((m) => m.id === r.model))
        throw new Error("지원 목록의 3D 모델을 선택하세요.");
      r.inputMode ??= "image";
      if (r.inputMode === "text") {
        if (!r.prompt.trim() || r.prompt.length > 1024)
          throw new Error("3D 텍스트 프롬프트는 1–1024자로 입력하세요.");
        if (r.sourceId || r.sourceIds || r.sourceTaskId)
          throw new Error(
            "텍스트 생성에는 이미지 입력을 함께 보내지 않습니다.",
          );
      } else if (r.inputMode === "multiview") {
        if (!r.sourceIds?.[0] || r.sourceIds.filter(Boolean).length < 2)
          throw new Error("멀티뷰는 정면과 추가 뷰 1개 이상이 필요합니다.");
        if (r.sourceId || r.sourceTaskId)
          throw new Error("멀티뷰 입력만 선택하세요.");
        r.sourceIds.filter(Boolean).forEach((source) => asset(source, "image"));
      } else {
        if (r.sourceIds || r.sourceTaskId)
          throw new Error("단일 이미지를 선택하세요.");
        r.sourceId ??= p.parts.find((x) => x.id === r.partId)?.imageId;
        asset(r.sourceId, "image");
      }
      const p2 = r.model === "P2-20260801",
        p1 = r.model === "P1-20260311";
      if (p1 && r.quad)
        throw new Error(
          "P1은 사각면 생성 옵션을 지원하지 않습니다. P2를 선택하세요.",
        );
      if (!p2 && !p1 && r.exportUv !== undefined)
        throw new Error("생성 시 UV 전개 옵션은 P-series 모델에서 지원합니다.");
      if (r.faceLimit !== undefined) {
        const min = p2 ? 48 : p1 ? 50 : 500;
        const max = p2 ? (r.quad ? 25000 : 50000) : p1 ? 20000 : 1000000;
        if (r.faceLimit < min || r.faceLimit > max)
          throw new Error(
            `현재 모델과 토폴로지의 폴리곤 범위는 ${min}–${max}입니다.`,
          );
      }
      if (
        r.textureVersion &&
        !catalog.texture.some((m) => m.id === r.textureVersion)
      )
        throw new Error("지원하는 텍스처 버전을 선택하세요.");
      if (r.textureQuality === "fast" && r.textureVersion !== "v3.5-20260815")
        throw new Error("fast 품질은 Texture v3.5가 필요합니다.");
      r.texture ??= true;
      r.pbr = r.texture === false ? false : (r.pbr ?? true);
      r.textureQuality ??= "standard";
      if (r.texture) r.textureVersion ??= "v3.0-20250812";
      if (p2) r.quad ??= false;
    }
    if (r.kind === "edit") {
      const a = asset(r.sourceId, "image");
      if (path.extname(a.file).toLowerCase() === ".webp")
        throw new Error(
          "이미지 편집 입력은 PNG/JPEG를 사용하세요. WebP는 3D 생성 입력에서 사용할 수 있습니다.",
        );
    }
    if (modelInputs.includes(r.kind)) {
      const a = asset(r.sourceId, "model");
      const nativeFormat = path.extname(a.nativeFile ?? a.file).toLowerCase();
      if (![".glb", ".fbx", ".obj", ".stl"].includes(nativeFormat))
        throw new Error(
          "이 후처리의 입력은 자체 포함 GLB/FBX/OBJ/STL 모델이어야 합니다. 압축 파일은 먼저 가져오기 가능한 모델로 준비하세요.",
        );
      if (
        ["rig-check", "rig"].includes(r.kind) &&
        path.extname(a.file).toLowerCase() !== ".glb"
      )
        throw new Error("리깅 입력은 GLB 모델이 필요합니다.");
      if (
        r.kind === "rig" &&
        !p.jobs.some(
          (j) =>
            j.kind === "rig-check" &&
            j.status === "success" &&
            j.request.sourceId === r.sourceId &&
            j.revision === p.revision &&
            j.output?.riggable === true,
        )
      )
        throw new Error("현재 조립 버전의 리깅 적합성 검사를 먼저 완료하세요.");
    }
    if (r.kind === "segment") {
      if (!catalog.segment.some((m) => m.id === r.model))
        throw new Error("지원 목록의 분할 모델을 선택하세요.");
      if (
        r.model === "v1.0-20250506" &&
        (r.segmentationGranularity || r.splitByConnectivity !== undefined)
      )
        throw new Error("분할 세밀도·연결요소 옵션은 v2 모델이 필요합니다.");
      if (r.model === "v2.0-20260430") {
        r.segmentationGranularity ??= "balanced";
        r.splitByConnectivity ??= true;
      }
    }
    if (r.kind === "smartsegment") {
      r.segType ??= "model";
      r.smartGranularity ??= "medium";
      const a = asset(r.sourceId, r.segType === "image" ? "image" : "model");
      if (r.sourceTaskId)
        throw new Error("스마트 분할은 파일 입력만 지원합니다.");
      if (
        r.segType === "model" &&
        path.extname(a.file).toLowerCase() !== ".glb"
      )
        throw new Error("스마트 모델 분할은 GLB가 필요합니다.");
      if (r.prompt.length > 1024)
        throw new Error("스마트 분할 힌트는 1024자 이하로 입력하세요.");
    }
    if (r.kind === "complete") {
      const segment = p.jobs.find(
        (j) =>
          ["segment", "smartsegment"].includes(j.kind) &&
          j.status === "success" &&
          (j.remoteId === r.sourceTaskId ||
            j.output?.seg_task_id === r.sourceTaskId),
      );
      if (!segment || !r.sourceTaskId)
        throw new Error("성공한 Tripo 분할 작업을 먼저 선택하세요.");
      if (
        segment.kind === "smartsegment" &&
        typeof segment.output?.seg_task_id !== "string"
      )
        throw new Error("스마트 분할 응답에 보완용 seg_task_id가 없습니다.");
      if (r.model !== "v1.0-20250506")
        throw new Error("보완 모델은 v1.0-20250506을 사용하세요.");
      r.sourceId = segment.assetId;
      r.completionMode ??= "ai_completion";
    }
    if (r.kind === "retopology") {
      if (!catalog.retopology.some((m) => m.id === r.model))
        throw new Error("지원 목록의 리토폴로지 모델을 선택하세요.");
      if (
        r.model === "v2.0" &&
        r.faceLimit !== undefined &&
        (r.faceLimit < 500 || r.faceLimit > (r.quad ? 10000 : 20000))
      )
        throw new Error(
          "리토폴로지 v2는 삼각면 500–20000, 사각면 500–10000을 지원합니다.",
        );
      if (
        r.model === "v1.0" &&
        (!r.faceLimit || r.bake !== undefined || r.partNames?.length)
      )
        throw new Error(
          "리토폴로지 v1은 폴리곤 수가 필수이며 bake·파트 선택을 지원하지 않습니다.",
        );
      if (r.model === "v1.0" && r.quad && r.faceLimit! > 150000)
        throw new Error("리토폴로지 v1 사각면 한도는 150000입니다.");
      if (r.model === "v2.0") r.bake ??= true;
    }
    if (["convert", "uv-pack"].includes(r.kind)) {
      r.format ??= "GLTF";
      r.bake ??= true;
      r.textureSize ??= 2048;
      if (r.quad && r.format !== "FBX")
        throw new Error("사각면 변환은 FBX 출력만 지원합니다.");
      if (
        r.textureSize !== undefined &&
        ![1024, 2048, 4096].includes(r.textureSize)
      )
        throw new Error("텍스처 크기는 1024/2048/4096 중 선택하세요.");
    }
    if (r.kind === "texture") {
      if (!catalog.texture.some((m) => m.id === r.model))
        throw new Error("지원 목록의 텍스처 모델을 선택하세요.");
      if (r.textureQuality === "fast" && r.model !== "v3.5-20260815")
        throw new Error("fast 품질은 Texture v3.5가 필요합니다.");
      if (r.prompt.length > 1024)
        throw new Error("텍스처 프롬프트는 1024자 이하로 입력하세요.");
      if (r.sourceIds) {
        if (r.prompt.trim())
          throw new Error(
            "텍스처는 텍스트 또는 참조 이미지를 하나만 선택하세요.",
          );
        if (![1, 4].includes(r.sourceIds.length) || r.sourceIds.some((s) => !s))
          throw new Error(
            "텍스처 참조는 이미지 1개 또는 정면/왼쪽/뒤/오른쪽 4개가 필요합니다.",
          );
        r.sourceIds.forEach((s) => asset(s, "image"));
      }
      r.textureQuality ??= "standard";
      r.pbr ??= true;
    }
    if (
      r.kind === "rig" &&
      (r.model !== "v1.0-20240301" || (r.rigType && r.rigType !== "biped"))
    )
      throw new Error("현재 리깅은 v1 biped / Mixamo를 지원합니다.");
    if (
      r.kind === "animate" &&
      !p.jobs.some(
        (j) =>
          j.kind === "rig" &&
          j.status === "success" &&
          j.remoteId === r.sourceTaskId &&
          j.revision === p.revision,
      )
    )
      throw new Error("현재 버전의 Tripo 리깅 작업을 선택하세요.");
    if (
      r.kind === "animate" &&
      !["preset:biped:idle", "preset:biped:walk"].includes(r.animation ?? "")
    )
      throw new Error("기본 대기·걷기만 지원합니다.");
    if (processing.includes(r.kind) && r.count !== 1)
      throw new Error("후처리는 한 번씩 승인하세요.");
    if (r.kind === "rig") r.rigType ??= "biped";
    const inputDetails: string[] = [];
    const label = (assetId: string) =>
      p.assets.find((a) => a.id === assetId)?.label ?? assetId;
    if (r.sourceId) inputDetails.push(label(r.sourceId));
    if (r.sourceIds)
      r.sourceIds.forEach((sourceId, index) => {
        if (sourceId)
          inputDetails.push(
            `${r.inputMode === "multiview" ? ["정면", "왼쪽", "뒷면", "오른쪽"][index] : r.sourceIds!.length === 4 ? `텍스처 참조 ${["정면", "왼쪽", "뒷면", "오른쪽"][index]}` : "텍스처 참조"}: ${label(sourceId)}`,
          );
      });
    if (r.sourceTaskId) {
      inputDetails.push(`Tripo 작업: ${r.sourceTaskId}`);
      const sourceJob = p.jobs.find((j) => j.remoteId === r.sourceTaskId);
      if (r.kind === "complete" && sourceJob?.kind === "smartsegment")
        inputDetails.push(`보완 입력: ${sourceJob.output?.seg_task_id}`);
      if (!r.sourceId && sourceJob?.assetId)
        inputDetails.push(label(sourceJob.assetId));
    }
    const q: Quote = {
      id: uid(),
      projectId: id,
      request: r,
      revision: p.revision,
      expiresAt: Date.now() + 10 * 60 * 1000,
      estimatedCredits: r.kind === "rig-check" ? 0 : null,
      costSource:
        r.kind === "rig-check"
          ? "공식 API의 무료 리깅 적합성 검사 · 생성/리깅은 별도 승인"
          : "계정별 v3 가격 견적 API 미확인 · 공식 요금표에서 확인 필요",
      inputSummary: inputDetails.length ? inputDetails.join(" · ") : r.prompt,
      consumed: false,
    };
    this.store.quote(q);
    return q;
  }
  approve(quoteId: string, unknownCostAccepted: boolean) {
    const q = this.store.get<Quote>("quote", quoteId);
    if (!q || q.consumed || q.expiresAt < Date.now())
      throw new Error("승인이 만료되었거나 이미 사용되었습니다.");
    const p = this.store.project(q.projectId);
    if (p.revision !== q.revision)
      throw new Error("입력이 변경됐습니다. 다시 검토하세요.");
    if (q.estimatedCredits === null && !unknownCostAccepted)
      throw new Error("비용 미확인 상태의 실행 동의가 필요합니다.");
    q.consumed = true;
    this.store.quote(q);
    const jobs: Job[] = Array.from({ length: q.request.count }, () => ({
      id: uid(),
      quoteId: q.id,
      kind: q.request.kind,
      status: "queued",
      progress: 0,
      request: { ...q.request, count: 1 },
      createdAt: new Date().toISOString(),
      revision: p.revision,
    }));
    p.jobs.push(...jobs);
    this.store.save(p);
    void this.runBatch(
      p.id,
      jobs.map((j) => j.id),
    );
    return jobs;
  }
  private async runBatch(id: string, jobIds: string[]) {
    if (
      ["image", "edit"].includes(
        this.store.project(id).jobs.find((job) => job.id === jobIds[0])!.kind,
      )
    ) {
      await this.runImageQueue();
      return;
    }
    for (const jid of jobIds) {
      await this.submit(id, jid);
      const p = this.store.project(id),
        job = p.jobs.find((j) => j.id === jid)!;
      if (["failed", "submission_unknown"].includes(job.status)) {
        for (const pending of p.jobs.filter(
          (j) => jobIds.includes(j.id) && j.status === "queued",
        )) {
          pending.status = "cancelled_local";
          pending.message = "앞선 요청 오류로 나머지 후보 제출 중지";
        }
        this.store.save(p);
        break;
      }
    }
  }
  private async runImageQueue() {
    if (this.imageQueueBusy) return;
    this.imageQueueBusy = true;
    try {
      while (true) {
        const images = this.store
          .projects()
          .flatMap((project) =>
            project.jobs
              .filter((job) => ["image", "edit"].includes(job.kind))
              .map((job) => ({ project, job })),
          );
        const pending = images.find(({ job }) => job.status === "queued");
        if (!pending) return;
        const stopped = images.find(
          ({ job }) =>
            job.quoteId === pending.job.quoteId &&
            [
              "failed",
              "submission_unknown",
              "paused",
              "cancelled",
              "cancelled_local",
            ].includes(job.status),
        );
        if (stopped) {
          for (const { project, job } of images.filter(
            ({ job }) =>
              job.quoteId === pending.job.quoteId && job.status === "queued",
          ))
            this.updateJob(project.id, job.id, {
              status: "cancelled_local",
              message: "앞선 이미지 작업이 완료되지 않아 나머지 후보 제출 중지",
            });
          continue;
        }
        const active = images.find(({ job }) =>
          ["running", "submitting"].includes(job.status),
        );
        if (active) {
          if (active.job.remoteId)
            await this.poll(active.project.id, active.job.id).catch(() => {});
          // Only safe GET polling is repeated. A pending candidate gets its own one-time POST after success.
          if (
            ["running", "submitting"].includes(
              this.store
                .project(active.project.id)
                .jobs.find((job) => job.id === active.job.id)!.status,
            )
          )
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 3000);
              timer.unref();
            });
          continue;
        }
        await this.submit(pending.project.id, pending.job.id);
      }
    } finally {
      this.imageQueueBusy = false;
    }
  }
  private updateJob(id: string, jid: string, patch: Partial<Job>) {
    const p = this.store.project(id);
    const j = p.jobs.find((x) => x.id === jid);
    if (!j) throw new Error("작업 없음");
    Object.assign(j, patch);
    this.store.save(p);
    return j;
  }
  private async submit(id: string, jid: string) {
    let p = this.store.project(id),
      j = p.jobs.find((x) => x.id === jid)!;
    if (j.status !== "queued") return;
    this.updateJob(id, jid, { status: "submitting", message: "입력 준비 중" });
    let submitted = false;
    try {
      const r = j.request;
      let input = r.sourceTaskId;
      if (r.kind === "complete") {
        const segment = p.jobs.find(
          (job) =>
            job.remoteId === r.sourceTaskId ||
            job.output?.seg_task_id === r.sourceTaskId,
        );
        input =
          segment?.kind === "smartsegment"
            ? String(segment.output!.seg_task_id)
            : r.sourceTaskId;
      } else if (r.sourceId && r.kind !== "animate") {
        const a = p.assets.find((a) => a.id === r.sourceId)!;
        const requireGlb = ["smartsegment", "rig-check", "rig"].includes(
          r.kind,
        );
        input = await this.tripo.upload(
          this.store.file(id, requireGlb ? a.file : (a.nativeFile ?? a.file)),
        );
      }
      const references: (string | undefined)[] = [];
      if (
        (r.kind === "model" && r.inputMode === "multiview") ||
        r.kind === "texture"
      )
        for (const sourceId of r.sourceIds ?? []) {
          references.push(
            sourceId
              ? await this.tripo.upload(
                  this.store.file(
                    id,
                    p.assets.find((a) => a.id === sourceId)!.file,
                  ),
                )
              : undefined,
          );
        }
      p = this.store.project(id);
      if (p.jobs.find((x) => x.id === jid)?.status === "cancelled_local")
        return;
      const endpoint: Record<string, string> = {
        image: "/generation/text-to-image",
        edit: "/generation/image-to-image",
        model: "/generation/image-to-model",
        "rig-check": "/animations/rig-check",
        rig: "/animations/rig",
        animate: "/animations/retarget",
        segment: "/mesh/segment",
        smartsegment: "/mesh/smartsegment",
        complete: "/mesh/complete",
        retopology: "/mesh/decimate",
        "uv-pack": "/models/convert",
        texture: "/models/texture",
        convert: "/models/convert",
      };
      if (r.kind === "model" && r.inputMode === "text")
        endpoint.model = "/generation/text-to-model";
      if (r.kind === "model" && r.inputMode === "multiview")
        endpoint.model = "/generation/multiview-to-model";
      let body: Record<string, unknown>;
      if (r.kind === "image" || r.kind === "edit")
        body = {
          model: r.model,
          prompt: r.prompt,
          size: r.size,
          output_format: "png",
          ...(r.kind === "edit" ? { input } : {}),
        };
      else if (r.kind === "model")
        body = {
          ...(r.inputMode === "text"
            ? { prompt: r.prompt }
            : r.inputMode === "multiview"
              ? {
                  inputs: references.flatMap((token, index) =>
                    token
                      ? [{ [["front", "left", "back", "right"][index]]: token }]
                      : [],
                  ),
                }
              : { input }),
          model: r.model,
          texture: r.texture ?? true,
          pbr: r.texture === false ? false : (r.pbr ?? true),
          texture_quality: r.textureQuality ?? "standard",
          ...(r.textureVersion ? { texture_version: r.textureVersion } : {}),
          ...(r.faceLimit !== undefined ? { face_limit: r.faceLimit } : {}),
          ...(r.quad !== undefined && r.model !== "P1-20260311"
            ? { quad: r.quad }
            : {}),
          ...(r.exportUv !== undefined ? { export_uv: r.exportUv } : {}),
        };
      else if (r.kind === "segment")
        body = {
          input,
          model: r.model,
          ...(r.model === "v2.0-20260430"
            ? {
                segmentation_granularity:
                  r.segmentationGranularity ?? "balanced",
                split_by_connectivity: r.splitByConnectivity ?? true,
              }
            : {}),
        };
      else if (r.kind === "smartsegment")
        body = {
          input,
          seg_type: r.segType ?? "model",
          granularity: r.smartGranularity ?? "medium",
          ...(r.prompt.trim() ? { hint: r.prompt } : {}),
          ...(r.segType !== "image"
            ? { transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }
            : {}),
        };
      else if (r.kind === "complete")
        body = {
          input,
          model: r.model,
          completion_mode: r.completionMode ?? "ai_completion",
          ...(r.partNames?.length ? { part_names: r.partNames } : {}),
        };
      else if (r.kind === "retopology")
        body = {
          input,
          model: r.model,
          ...(r.faceLimit !== undefined ? { face_limit: r.faceLimit } : {}),
          ...(r.quad !== undefined ? { quad: r.quad } : {}),
          ...(r.model === "v2.0"
            ? {
                bake: r.bake ?? true,
                ...(r.partNames?.length ? { part_names: r.partNames } : {}),
              }
            : {}),
        };
      else if (r.kind === "uv-pack" || r.kind === "convert")
        body = {
          input,
          format: r.format ?? "GLTF",
          pack_uv: r.kind === "uv-pack",
          bake: r.bake ?? true,
          texture_size: r.textureSize ?? 2048,
          texture_format: "PNG",
          with_animation: true,
          ...(r.quad !== undefined ? { quad: r.quad } : {}),
        };
      else if (r.kind === "texture")
        body = {
          input,
          model: r.model,
          texture_quality: r.textureQuality ?? "standard",
          pbr: r.pbr ?? true,
          ...(r.model === "v3.5-20260815" ? { delight: true } : {}),
          ...(references.length === 1
            ? { texture_prompt: { image: references[0] } }
            : references.length === 4
              ? { texture_prompt: { images: references } }
              : r.prompt.trim()
                ? { texture_prompt: { text: r.prompt } }
                : {}),
          ...(r.partNames?.length ? { part_names: r.partNames } : {}),
        };
      else if (r.kind === "rig-check") body = { input };
      else if (r.kind === "rig")
        body = {
          input,
          model: "v1.0-20240301",
          rig_type: "biped",
          spec: "mixamo",
          out_format: "glb",
        };
      else
        body = {
          input,
          animation: r.animation,
          out_format: "glb",
          bake_animation: true,
          animate_in_place: true,
          export_with_geometry: true,
        };
      this.updateJob(id, jid, {
        message: "Tripo에 요청 전송 중 · 자동 재전송 없음",
      });
      submitted = true;
      const data = await this.tripo.submit(endpoint[r.kind], body);
      if (!data?.task_id) throw new Error("작업 ID 없는 제출 응답");
      this.updateJob(id, jid, {
        remoteId: data.task_id,
        status: "running",
        message: "원격 작업 진행 중",
      });
    } catch (e) {
      this.updateJob(id, jid, {
        status:
          submitted && !(e instanceof TripoError && e.definitive)
            ? "submission_unknown"
            : "failed",
        message: e instanceof Error ? e.message : "요청 실패",
      });
    }
  }
  async poll(id: string, jid: string) {
    const lock = id + jid;
    if (this.busy.has(lock)) return;
    const p = this.store.project(id),
      j = p.jobs.find((x) => x.id === jid);
    if (!j?.remoteId) throw new Error("원격 작업 ID가 없습니다.");
    if (j.status === "success") return j;
    this.busy.add(lock);
    try {
      const d = await this.tripo.task(j.remoteId);
      const status = d.status;
      if (status === "success") {
        const output = d.output ?? {};
        // Persist billing and remote output before any download or local conversion can fail.
        this.updateJob(id, jid, { output, credits: d.credits_consumed });
        const imageOutput = j.kind === "image" || j.kind === "edit";
        const mainUrl = imageOutput
          ? output.generated_image_url
          : j.kind === "smartsegment"
            ? output.seg_model_url
            : output.model_url;
        if (j.kind === "rig-check") {
          if (typeof output.riggable !== "boolean")
            throw new Error("리깅 검사 응답에 riggable 값이 없습니다.");
        } else if (typeof mainUrl !== "string" || !mainUrl) {
          throw new Error(
            "완료 응답에 결과 파일 URL이 없습니다. 새 생성 없이 기존 작업을 다시 조회하세요.",
          );
        }
        const downloads: { url: string; kind: Asset["kind"]; label: string }[] =
          [];
        if (mainUrl)
          downloads.push({
            url: mainUrl,
            kind: imageOutput ? "image" : "model",
            label: j.kind,
          });
        if (
          j.kind === "smartsegment" &&
          typeof output.mask_url === "string" &&
          output.mask_url
        )
          downloads.push({
            url: output.mask_url,
            kind: "image",
            label: "smartsegment · mask",
          });
        const prepared: {
          file: string;
          nativeFile: string;
          format: string;
          kind: Asset["kind"];
          label: string;
        }[] = [];
        const nativeFiles = [
          ...(this.store.project(id).jobs.find((job) => job.id === jid)!
            .nativeFiles ?? []),
        ];
        for (const [index, download] of downloads.entries()) {
          let nativeFile = nativeFiles[index];
          if (!nativeFile || !fs.existsSync(this.store.file(id, nativeFile))) {
            const bytes = await this.tripo.download(download.url);
            const ext = outputExtension(
              download.url,
              bytes,
              download.kind === "image",
            );
            if (
              !(
                download.kind === "image"
                  ? ["png", "jpg", "jpeg", "webp"]
                  : modelFormats
              ).includes(ext)
            )
              throw new Error(
                "결과 파일의 실제 형식과 요청 유형이 다릅니다. 원격 결과를 확인하세요.",
              );
            nativeFile = `assets/${jid}${index ? `-${index}` : ""}.${ext}`;
            this.store.write(id, nativeFile, bytes);
            nativeFiles[index] = nativeFile;
            this.updateJob(id, jid, { nativeFiles });
          }
          const format = path.extname(nativeFile).slice(1).toLowerCase();
          let file = nativeFile;
          if (download.kind === "model" && format === "fbx") {
            if (!this.modelPreview)
              throw new Error(
                "원본 FBX 저장 완료. GLB 미리보기를 만들 Blender 연결이 필요합니다.",
              );
            file = await this.modelPreview(id, nativeFile);
            if (
              path.extname(file).toLowerCase() !== ".glb" ||
              !fs.existsSync(this.store.file(id, file))
            )
              throw new Error(
                "FBX 미리보기 변환 결과를 확인하지 못했습니다. 원본은 보존됐습니다.",
              );
          }
          prepared.push({
            file,
            nativeFile,
            format,
            kind: download.kind,
            label: download.label,
          });
        }
        const latest = this.store.project(id),
          live = latest.jobs.find((x) => x.id === jid)!;
        for (const result of prepared) {
          const existing = latest.assets.find(
            (a) =>
              a.jobId === jid && (a.nativeFile ?? a.file) === result.nativeFile,
          );
          if (existing) {
            live.assetIds ??= [];
            if (!live.assetIds.includes(existing.id))
              live.assetIds.push(existing.id);
            live.assetId ??= existing.id;
            continue;
          }
          const parentIds = [
            ...new Set(
              [
                j.request.sourceId,
                ...(j.request.sourceIds ?? []),
                latest.jobs.find(
                  (job) => job.remoteId === j.request.sourceTaskId,
                )?.assetId,
              ].filter((value): value is string => Boolean(value)),
            ),
          ];
          const a = this.asset(
            latest,
            result.file,
            result.kind,
            `${result.label} · ${latest.assets.length + 1}`,
            "tripo",
            {
              nativeFile: result.nativeFile,
              format: result.format,
              jobId: jid,
              parentId: parentIds[0],
              parentIds,
              prompt: j.request.prompt,
            },
          );
          live.assetId ??= a.id;
          (live.assetIds ??= []).push(a.id);
          if (result.kind === "model" && j.request.partId) {
            const part = latest.parts.find((x) => x.id === j.request.partId);
            if (part && !part.candidates.includes(a.id))
              part.candidates.push(a.id);
          }
        }
        Object.assign(live, {
          status: "success",
          progress: 100,
          output,
          credits: d.credits_consumed,
          message:
            j.kind === "rig-check"
              ? output.riggable
                ? "리깅 적합성 검사 통과"
                : "리깅 부적합 · 입력 수정 필요"
              : "Tripo 원본 다운로드 완료",
        });
        this.store.save(latest);
        return live;
      }
      return this.updateJob(id, jid, {
        status: ["failed", "banned", "expired"].includes(status)
          ? "failed"
          : status === "cancelled"
            ? "cancelled"
            : "running",
        progress: Math.max(0, Math.min(100, Number(d.progress) || 0)),
        message: ["failed", "banned", "expired"].includes(status)
          ? `Tripo 작업 실패 · code ${d.error_code ?? "unknown"}`
          : "원격 작업 진행 중",
        credits: d.credits_consumed,
      });
    } catch (e) {
      this.updateJob(id, jid, {
        message: `조회/다운로드 오류 · ${e instanceof Error ? e.message : "연결 끊김"} · 기존 작업 ID 유지`,
      });
      throw e;
    } finally {
      this.busy.delete(lock);
    }
  }
  cancel(id: string, jid: string) {
    const p = this.store.project(id),
      j = p.jobs.find((x) => x.id === jid)!;
    if (
      !j ||
      ["success", "failed", "cancelled", "cancelled_local"].includes(j.status)
    )
      return j;
    if (
      j.status === "queued" ||
      (j.status === "submitting" && j.message === "입력 준비 중")
    ) {
      j.status = "cancelled_local";
      j.message = "원격 생성 제출 전 취소";
    } else {
      j.status = j.remoteId ? "paused" : "submission_unknown";
      j.message =
        "로컬 추적 중지. 원격 작업 취소는 지원 확인되지 않았으며 과금이 계속될 수 있습니다.";
    }
    this.store.save(p);
    return j;
  }
  reconcile(id: string, jid: string, remoteId: string) {
    if (
      !/^(task_[\w-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(
        remoteId,
      )
    )
      throw new Error("Tripo 작업 ID를 확인하세요.");
    return this.updateJob(id, jid, {
      remoteId,
      status: "running",
      message: "기존 작업 ID 연결 · 재제출 없음",
    });
  }
  async pollActive() {
    for (const p of this.store.projects())
      for (const j of p.jobs)
        if (j.status === "running" && j.remoteId)
          await this.poll(p.id, j.id).catch(() => {});
  }
  importFile(id: string, source: string, kind: Asset["kind"], partId?: string) {
    const ext = path.extname(source).toLowerCase();
    if (
      !(
        kind === "image" ? [".png", ".jpg", ".jpeg", ".webp"] : [".glb"]
      ).includes(ext)
    )
      throw new Error(
        "이미지는 PNG/JPEG/WebP, 모델은 자체 포함 GLB를 사용하세요.",
      );
    if (fs.statSync(source).size > (kind === "image" ? 20 : 150) * 1024 * 1024)
      throw new Error("파일 크기 한도 초과");
    const p = this.store.project(id);
    const part = partId ? p.parts.find((x) => x.id === partId) : undefined;
    if (part?.locked) throw new Error("파츠 고정을 해제하세요.");
    const rel = `assets/${uid()}${ext}`;
    this.store.write(id, rel, fs.readFileSync(source));
    const a = this.asset(p, rel, kind, path.basename(source), "import");
    if (kind === "image") {
      if (part) part.imageId = a.id;
      else p.selectedImageId = a.id;
    } else if (part) {
      part.candidates.push(a.id);
      part.selectedId = a.id;
    }
    this.touch(p);
    return a;
  }
}
