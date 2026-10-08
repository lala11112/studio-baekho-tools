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
  kind: z.enum(["image", "edit", "model", "rig-check", "rig", "animate"]),
  prompt: z.string().max(6000),
  model: z.string().max(80),
  size: z.string().max(30).optional(),
  count: z.number().int().min(1).max(4),
  partId: z.string().optional(),
  sourceId: z.string().optional(),
  sourceTaskId: z.string().optional(),
  animation: z.string().optional(),
});
export class Engine {
  private busy = new Set<string>();
  constructor(
    public store: Store,
    public tripo: Tripo,
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
    if (r.kind === "image" || r.kind === "edit") {
      const model = catalog.image.find((m) => m.id === r.model);
      if (!model || !model.sizes.includes(r.size ?? ""))
        throw new Error("지원 목록에서 모델과 해상도를 선택하세요.");
      if (!r.prompt.trim()) throw new Error("프롬프트를 입력하세요.");
    }
    if (r.kind === "model") {
      if (!catalog.model.some((m) => m.id === r.model))
        throw new Error("지원 목록의 3D 모델을 선택하세요.");
      const part = p.parts.find((x) => x.id === r.partId);
      if (!part?.imageId) throw new Error("파츠 이미지를 먼저 준비하세요.");
      if (part.locked) throw new Error("고정한 파츠입니다. 잠금을 해제하세요.");
      r.sourceId = part.imageId;
    }
    if (["edit", "model", "rig-check", "rig"].includes(r.kind)) {
      const a = p.assets.find((x) => x.id === r.sourceId);
      if (!a) throw new Error("입력 파일을 선택하세요.");
      if (["edit", "model"].includes(r.kind) && a.kind !== "image")
        throw new Error("이미지가 필요합니다.");
      if (["rig-check", "rig"].includes(r.kind) && a.kind !== "model")
        throw new Error("확정한 모델이 필요합니다.");
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
    if (["rig", "rig-check", "animate"].includes(r.kind) && r.count !== 1)
      throw new Error("후처리는 한 번씩 승인하세요.");
    const q: Quote = {
      id: uid(),
      projectId: id,
      request: r,
      revision: p.revision,
      expiresAt: Date.now() + 10 * 60 * 1000,
      estimatedCredits: null,
      costSource: "v3 가격 견적 API 미확인 · 공식 요금표에서 확인 필요",
      inputSummary:
        p.assets.find((a) => a.id === r.sourceId)?.label ?? r.prompt,
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
      if (r.sourceId) {
        const a = p.assets.find((a) => a.id === r.sourceId)!;
        input = await this.tripo.upload(this.store.file(id, a.file));
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
      };
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
          input,
          model: r.model,
          texture: true,
          pbr: true,
          texture_quality: "standard",
          face_limit: 20000,
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
        const url =
          j.kind === "image" || j.kind === "edit"
            ? output.generated_image_url
            : output.model_url;
        let file: string | undefined;
        if (url) {
          const ext = j.kind === "image" || j.kind === "edit" ? ".png" : ".glb";
          file = `assets/${jid}${ext}`;
          const destination = this.store.file(id, file);
          if (!fs.existsSync(destination))
            this.store.write(id, file, await this.tripo.download(url));
        }
        const latest = this.store.project(id),
          live = latest.jobs.find((x) => x.id === jid)!;
        if (file && !live.assetId) {
          const a = this.asset(
            latest,
            file,
            j.kind === "image" || j.kind === "edit" ? "image" : "model",
            `${j.kind} · ${latest.assets.length + 1}`,
            "tripo",
            {
              jobId: jid,
              parentId: j.request.sourceId,
              prompt: j.request.prompt,
            },
          );
          live.assetId = a.id;
          if (j.kind === "model") {
            const part = latest.parts.find((x) => x.id === j.request.partId);
            part?.candidates.push(a.id);
          }
        }
        Object.assign(live, {
          status: "success",
          progress: 100,
          output,
          credits: d.credits_consumed,
          message: "다운로드 완료",
        });
        this.store.save(latest);
        return live;
      }
      return this.updateJob(id, jid, {
        status:
          status === "failed"
            ? "failed"
            : status === "cancelled"
              ? "cancelled"
              : "running",
        progress: Math.max(0, Math.min(100, Number(d.progress) || 0)),
        message:
          status === "failed"
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
    if (!/^task_[\w-]+$/.test(remoteId))
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
      !(kind === "image" ? [".png", ".jpg", ".jpeg"] : [".glb"]).includes(ext)
    )
      throw new Error("이미지는 PNG/JPEG, 모델은 자체 포함 GLB를 사용하세요.");
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
