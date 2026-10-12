import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import {
  FourTigerError,
  type GenerationJob,
  type IconVersion,
  type SainGeomItemProject,
} from "../../shared/four-tiger-items";
import { blankReview } from "./domain";
import { FourTigerItemStore } from "./store";
import type {
  FourTigerIconRunner,
  IconRequest,
  IconRunnerResult,
} from "./icon-runner";

export const sha256 = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");
export async function inspectPng(
  file: string,
  expectedHash?: string,
): Promise<{ bytes: Buffer; png: PNG; sha256: string }> {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
    throw new FourTigerError(
      "INVALID_PNG",
      "PNG 파일 크기가 허용 범위를 넘습니다.",
    );
  const bytes = await fs.readFile(file);
  if (expectedHash && sha256(bytes) !== expectedHash)
    throw new FourTigerError(
      "ICON_HASH_MISMATCH",
      "아이콘 파일이 저장 후 변경됐습니다.",
    );
  if (
    bytes.length < 33 ||
    !bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(16) > 4096 ||
    bytes.readUInt32BE(20) > 4096
  )
    throw new FourTigerError(
      "INVALID_PNG",
      "PNG 형식 또는 해상도를 확인하세요.",
    );
  let png: PNG;
  try {
    png = PNG.sync.read(bytes);
  } catch {
    throw new FourTigerError("INVALID_PNG", "PNG를 읽을 수 없습니다.");
  }
  let transparent = false,
    visible = false;
  for (let n = 3; n < png.data.length; n += 4) {
    if (png.data[n] < 255) transparent = true;
    if (png.data[n] > 0) visible = true;
  }
  if (!transparent || !visible)
    throw new FourTigerError(
      "INVALID_PNG",
      "투명 배경과 보이는 물체가 모두 필요합니다.",
    );
  return { bytes, png, sha256: sha256(bytes) };
}
function thumbnail(png: PNG): Buffer {
  const out = new PNG({ width: 256, height: 256 }),
    scale = Math.min(256 / png.width, 256 / png.height),
    w = Math.max(1, Math.round(png.width * scale)),
    h = Math.max(1, Math.round(png.height * scale)),
    ox = Math.floor((256 - w) / 2),
    oy = Math.floor((256 - h) / 2);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.max(0, Math.min(png.width - 1, (x + 0.5) / scale - 0.5)),
        sy = Math.max(0, Math.min(png.height - 1, (y + 0.5) / scale - 0.5)),
        x0 = Math.floor(sx),
        y0 = Math.floor(sy),
        fx = sx - x0,
        fy = sy - y0;
      let a = 0,
        r = 0,
        g = 0,
        b = 0;
      for (const [dx, dy, weight] of [
        [0, 0, (1 - fx) * (1 - fy)],
        [1, 0, fx * (1 - fy)],
        [0, 1, (1 - fx) * fy],
        [1, 1, fx * fy],
      ]) {
        const n =
            (Math.min(png.height - 1, y0 + dy) * png.width +
              Math.min(png.width - 1, x0 + dx)) *
            4,
          alpha = (png.data[n + 3] / 255) * weight;
        a += alpha;
        r += png.data[n] * alpha;
        g += png.data[n + 1] * alpha;
        b += png.data[n + 2] * alpha;
      }
      const n = ((y + oy) * 256 + x + ox) * 4;
      if (a > 0) {
        out.data[n] = Math.round(r / a);
        out.data[n + 1] = Math.round(g / a);
        out.data[n + 2] = Math.round(b / a);
        out.data[n + 3] = Math.round(a * 255);
      }
    }
  return PNG.sync.write(out);
}
export class FourTigerIconQueue {
  private waiting: { projectId: string; jobId: string }[] = [];
  private pumping: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private stopped = false;
  constructor(
    private store: FourTigerItemStore,
    private runner: FourTigerIconRunner,
  ) {}
  hasActiveWork() {
    return this.pumping !== null || this.waiting.length > 0;
  }
  private async latest(
    projectId: string,
    change: (p: SainGeomItemProject) => SainGeomItemProject,
  ): Promise<SainGeomItemProject> {
    for (let n = 0; n < 8; n++) {
      const p = await this.store.read(projectId);
      try {
        return await this.store.update(projectId, p.revision, change);
      } catch (error) {
        if (
          !(error instanceof FourTigerError) ||
          error.code !== "REVISION_CONFLICT"
        )
          throw error;
      }
    }
    throw new FourTigerError(
      "REVISION_CONFLICT",
      "다른 편집이 진행 중입니다. 결과 복구를 다시 선택하세요.",
    );
  }
  async enqueue(
    projectId: string,
    expectedRevision: number,
    candidateKeys: string[],
  ): Promise<SainGeomItemProject> {
    if (this.stopped)
      throw new FourTigerError(
        "INVALID_INPUT",
        "종료 중에는 생성할 수 없습니다.",
      );
    if (
      !candidateKeys.length ||
      new Set(candidateKeys).size !== candidateKeys.length
    )
      throw new FourTigerError(
        "INVALID_INPUT",
        "생성할 항목을 중복 없이 선택하세요.",
      );
    const added: string[] = [],
      now = new Date().toISOString();
    const p = await this.store.update(projectId, expectedRevision, (p) => {
      for (const key of candidateKeys) {
        const item = p.items.find((i) => i.candidateKey === key);
        if (!item)
          throw new FourTigerError("INVALID_INPUT", "알 수 없는 아이템입니다.");
        if (
          p.jobs.some(
            (j) =>
              j.candidateKey === key &&
              ["queued", "running", "unknown", "generated"].includes(j.status),
          )
        )
          throw new FourTigerError(
            "JOB_UNCERTAIN",
            "진행 중이거나 결과가 불명확합니다. 기존 결과를 먼저 확인하세요.",
          );
        const prompt = `${p.iconStyle}\n아이템: ${item.name} (${item.itemId}), 오행 ${item.element}\n모티프: ${item.iconPrompt}`;
        const job: GenerationJob = {
          jobId: randomUUID(),
          candidateKey: key,
          contentRevision: item.contentRevision,
          prompt,
          promptHash: sha256(prompt),
          status: "queued",
          attempt: 1,
          resultPath: null,
          error: null,
          createdAt: now,
          updatedAt: now,
        };
        p.jobs.push(job);
        added.push(job.jobId);
      }
      return p;
    });
    this.waiting.push(...added.map((jobId) => ({ projectId, jobId })));
    this.start();
    return p;
  }
  private start() {
    if (this.pumping || this.stopped) return;
    this.pumping = this.pump().finally(() => {
      this.pumping = null;
      if (this.waiting.length && !this.stopped) this.start();
    });
  }
  private async pump(): Promise<void> {
    while (this.waiting.length && !this.stopped) {
      const work = this.waiting.shift()!;
      try {
        await this.execute(work.projectId, work.jobId);
      } catch {
        /* Durable running/unknown journal remains available for explicit recovery after disk errors. */
      }
    }
  }
  private async execute(projectId: string, jobId: string): Promise<void> {
    let p = await this.store.read(projectId),
      job = p.jobs.find((j) => j.jobId === jobId);
    if (!job || job.status !== "queued") return;
    p = await this.latest(projectId, (p) => {
      const j = p.jobs.find((j) => j.jobId === jobId)!;
      j.status = "running";
      j.updatedAt = new Date().toISOString();
      return p;
    });
    job = p.jobs.find((j) => j.jobId === jobId)!;
    const dir = await this.store.ensureDirectory(projectId, `jobs/${jobId}`);
    const request: IconRequest = {
      projectId,
      candidateKey: job.candidateKey,
      jobId,
      contentRevision: job.contentRevision,
      prompt: job.prompt,
      promptHash: job.promptHash,
      jobDirectory: dir,
    };
    // The request and running intent are durable before any generation call.
    await fs.writeFile(
      path.join(dir, "request.tmp"),
      JSON.stringify(request, null, 2),
    );
    await fs.rename(
      path.join(dir, "request.tmp"),
      path.join(dir, "request.json"),
    );
    this.abort = new AbortController();
    let result: IconRunnerResult;
    try {
      result = await this.runner.run(request, this.abort.signal);
    } catch {
      await this.latest(projectId, (p) => {
        const j = p.jobs.find((j) => j.jobId === jobId)!;
        j.status = "unknown";
        j.error =
          "작업 결과를 확인할 수 없습니다. 자동 재생성하지 않습니다. 결과 복구를 먼저 선택하세요.";
        return p;
      });
      this.abort = null;
      return;
    }
    this.abort = null;
    if (result.status === "needs_input") {
      await this.latest(projectId, (p) => {
        const j = p.jobs.find((j) => j.jobId === jobId)!;
        j.status = "failed";
        j.error = result.message.slice(0, 1000);
        return p;
      });
      return;
    }
    try {
      if (result.relativePath !== "outputs/source.png")
        throw new FourTigerError(
          "PATH_REJECTED",
          "등록되지 않은 이미지 경로입니다.",
        );
      await this.latest(projectId, (p) => {
        const j = p.jobs.find((j) => j.jobId === jobId)!;
        j.status = "generated";
        j.resultPath = `jobs/${jobId}/outputs/source.png`;
        return p;
      });
      await this.collect(projectId, jobId, result.observedModel);
    } catch (error) {
      await this.latest(projectId, (p) => {
        const j = p.jobs.find((j) => j.jobId === jobId)!;
        j.status =
          error instanceof FourTigerError &&
          ["INVALID_PNG", "PATH_REJECTED", "DUPLICATE_ICON"].includes(
            error.code,
          )
            ? "failed"
            : "unknown";
        j.error =
          error instanceof FourTigerError
            ? error.message
            : "생성 파일 저장을 완료하지 못했습니다. 결과 복구를 선택하세요.";
        return p;
      });
    }
  }
  private async collect(
    projectId: string,
    jobId: string,
    observedModel: string | null,
  ): Promise<void> {
    const p = await this.store.read(projectId),
      job = p.jobs.find((j) => j.jobId === jobId);
    if (!job)
      throw new FourTigerError("INVALID_INPUT", "등록된 작업이 아닙니다.");
    if (p.items.some((i) => i.icons.some((v) => v.jobId === jobId))) return;
    const source = await this.store.resolveFile(
        projectId,
        `jobs/${jobId}/outputs/source.png`,
      ),
      checked = await inspectPng(source);
    if (
      p.items.some(
        (i) =>
          i.candidateKey !== job.candidateKey &&
          i.icons.some((v) => v.sourceSha256 === checked.sha256),
      )
    )
      throw new FourTigerError(
        "DUPLICATE_ICON",
        "다른 아이템과 중복된 이미지입니다.",
      );
    const relative = `icons/${job.candidateKey}/v-${jobId}`,
      dir = await this.store.ensureDirectory(projectId, relative),
      sourceFile = path.join(dir, "source.png"),
      thumbFile = path.join(dir, "icon-256.png"),
      thumb = thumbnail(checked.png);
    try {
      await fs.copyFile(source, sourceFile, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (sha256(await fs.readFile(sourceFile)) !== checked.sha256)
        throw new FourTigerError(
          "ICON_HASH_MISMATCH",
          "이전 이미지 버전과 해시가 다릅니다.",
        );
    }
    try {
      await fs.writeFile(thumbFile, thumb, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (sha256(await fs.readFile(thumbFile)) !== sha256(thumb))
        throw new FourTigerError(
          "ICON_HASH_MISMATCH",
          "이전 미리보기 해시가 다릅니다.",
        );
    }
    const icon: IconVersion = {
      versionId: `v-${jobId}`,
      jobId,
      contentRevision: job.contentRevision,
      promptHash: job.promptHash,
      sourcePath: `${relative}/source.png`,
      thumbnailPath: `${relative}/icon-256.png`,
      sourceSha256: checked.sha256,
      thumbnailSha256: sha256(thumb),
      width: checked.png.width,
      height: checked.png.height,
      hasAlpha: true,
      prompt: job.prompt,
      tool: "imagegen",
      observedModel,
      createdAt: new Date().toISOString(),
    };
    await this.latest(projectId, (current) => {
      const item = current.items.find(
        (i) => i.candidateKey === job.candidateKey,
      );
      if (!item)
        throw new FourTigerError(
          "INVALID_INPUT",
          "결과에 해당하는 항목이 없습니다.",
        );
      if (!item.icons.some((v) => v.jobId === jobId)) item.icons.push(icon);
      if (
        !item.selectedIconVersion &&
        item.contentRevision === job.contentRevision
      ) {
        item.selectedIconVersion = icon.versionId;
        item.review = blankReview(icon.createdAt);
      }
      const j = current.jobs.find((j) => j.jobId === jobId)!;
      j.status = "validated";
      j.resultPath = icon.sourcePath;
      j.error = null;
      j.updatedAt = icon.createdAt;
      return current;
    });
  }
  async cancelPending(projectId: string): Promise<SainGeomItemProject> {
    return this.latest(projectId, (p) => {
      for (const j of p.jobs) if (j.status === "queued") j.status = "cancelled";
      return p;
    });
  }
  async reconcile(projectId: string): Promise<SainGeomItemProject> {
    if (this.hasActiveWork())
      throw new FourTigerError(
        "INVALID_INPUT",
        "진행 중 작업이 끝난 후 결과를 확인하세요.",
      );
    const p = await this.store.read(projectId);
    for (const job of p.jobs) {
      if (job.status === "queued") {
        await this.latest(projectId, (p) => {
          p.jobs.find((j) => j.jobId === job.jobId)!.status = "interrupted";
          return p;
        });
        continue;
      }
      if (
        !["running", "unknown", "generated", "interrupted"].includes(job.status)
      )
        continue;
      try {
        await this.collect(projectId, job.jobId, null);
      } catch (error) {
        await this.latest(projectId, (p) => {
          const j = p.jobs.find((j) => j.jobId === job.jobId)!;
          j.status =
            error instanceof FourTigerError &&
            ["INVALID_PNG", "PATH_REJECTED", "DUPLICATE_ICON"].includes(
              error.code,
            )
              ? "failed"
              : "unknown";
          j.error =
            error instanceof FourTigerError
              ? error.message
              : "회수할 결과가 확인되지 않았습니다. 자동 재생성하지 않습니다.";
          return p;
        });
      }
    }
    return this.store.read(projectId);
  }
  async selectIcon(
    projectId: string,
    expectedRevision: number,
    candidateKey: string,
    versionId: string,
  ): Promise<SainGeomItemProject> {
    await this.readIcon(projectId, candidateKey, versionId);
    return this.store.update(projectId, expectedRevision, (p) => {
      const item = p.items.find((i) => i.candidateKey === candidateKey)!;
      item.selectedIconVersion = versionId;
      item.review = blankReview(new Date().toISOString());
      return p;
    });
  }
  async abandonUnknown(
    projectId: string,
    expectedRevision: number,
    jobId: string,
  ): Promise<SainGeomItemProject> {
    if (this.hasActiveWork())
      throw new FourTigerError(
        "INVALID_INPUT",
        "실행 중 작업이 끝난 후 결과를 확인하세요.",
      );
    const p = await this.store.read(projectId),
      job = p.jobs.find((j) => j.jobId === jobId);
    if (p.revision !== expectedRevision)
      throw new FourTigerError(
        "REVISION_CONFLICT",
        "최신 내용을 확인한 뒤 다시 선택하세요.",
      );
    if (!job || job.status !== "unknown")
      throw new FourTigerError(
        "INVALID_INPUT",
        "결과 불명 작업만 명시적으로 종료할 수 있습니다.",
      );
    try {
      await this.store.resolveFile(
        projectId,
        `jobs/${jobId}/outputs/source.png`,
      );
      throw new FourTigerError(
        "REVIEW_REQUIRED",
        "결과 파일이 있습니다. 기존 결과 복구를 먼저 선택하세요.",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return this.store.update(projectId, expectedRevision, (current) => {
      const j = current.jobs.find((j) => j.jobId === jobId)!;
      j.status = "cancelled";
      j.updatedAt = new Date().toISOString();
      j.error =
        "사용자가 결과 없는 불명 요청 기록을 종료했습니다. 원격 중단을 뜻하지 않습니다. 새 생성은 별도 승인입니다.";
      current.reviewHistory.push({
        candidateKey: j.candidateKey,
        action: "abandonUnknownRequest",
        note: j.error,
        at: j.updatedAt,
        contentRevision: j.contentRevision,
        policyRevision: current.ruleProfile.revision,
      });
      return current;
    });
  }
  async readIcon(
    projectId: string,
    candidateKey: string,
    versionId: string,
  ): Promise<string> {
    const p = await this.store.read(projectId),
      icon = p.items
        .find((i) => i.candidateKey === candidateKey)
        ?.icons.find((v) => v.versionId === versionId);
    if (!icon)
      throw new FourTigerError(
        "INVALID_INPUT",
        "등록된 아이콘을 찾을 수 없습니다.",
      );
    const file = await this.store.resolveFile(projectId, icon.thumbnailPath),
      checked = await inspectPng(file, icon.thumbnailSha256);
    return `data:image/png;base64,${checked.bytes.toString("base64")}`;
  }
  async shutdown(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    this.runner.shutdown();
    await this.pumping;
    this.waiting = [];
  }
}
