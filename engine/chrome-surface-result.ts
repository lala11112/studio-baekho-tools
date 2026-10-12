import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ChromeJobLedger, type ChromePacket } from "./chrome-job-ledger";
import { NativeDownloadCollector } from "./native-download";
import { runNativeModelPreview } from "./chrome-model-result";
import type { WorkbenchCheck } from "../shared/workbench";

const hash = (p: string) =>
  createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const write = (p: string, v: unknown) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + ".tmp", JSON.stringify(v, null, 2));
  fs.renameSync(p + ".tmp", p);
};
function safe(root: string, p: string) {
  const f = path.resolve(root, p);
  if (
    !f.startsWith(path.resolve(root) + path.sep) ||
    !fs.realpathSync(f).startsWith(fs.realpathSync(root) + path.sep)
  )
    throw Error("표면 결과 경로가 작업 폴더 밖입니다.");
  return f;
}
/** Finalize each already-paid native phase independently; never submits or uses inference. */
export async function collectSurfaceResult(o: {
  workspace: string;
  packet: ChromePacket;
  requestHash: string;
  ledger: ChromeJobLedger;
  downloads: NativeDownloadCollector;
  cacheFile: string;
  blender: string;
  script: string;
  signal: AbortSignal;
  progress?: (s: string) => void;
  convert?: typeof runNativeModelPreview;
}) {
  const { workspace, packet, ledger, downloads, signal } = o,
    s = packet.request.externalSurface;
  if (packet.request.step !== "surface" || !s)
    throw Error("UV·텍스처 작업이 아닙니다.");
  signal.throwIfAborted();
  const journal = ledger.read();
  type Phase = {
    sourceHash: string;
    fbx: string;
    textures: string[];
    artifacts: { path: string; kind: string; role?: string }[];
    files: { path: string; sha256: string }[];
    uvLayers: number;
  };
  let cache: {
    jobId: string;
    requestHash: string;
    phases: Partial<Record<"uv" | "texture", Phase>>;
  } = { jobId: packet.jobId, requestHash: o.requestHash, phases: {} };
  if (fs.existsSync(o.cacheFile)) {
    cache = JSON.parse(fs.readFileSync(o.cacheFile, "utf8"));
    if (cache.jobId !== packet.jobId || cache.requestHash !== o.requestHash)
      throw Error("표면 검사 기록이 현재 작업과 다릅니다.");
  }
  for (const phase of ["uv", "texture"] as const) {
    signal.throwIfAborted();
    const entry = journal.entries.find(
      (e) => e.phase === phase && e.state === "completed",
    );
    if (!entry?.resultUrl) continue;
    const pending = downloads.status().pending;
    if (pending?.phase === phase && pending.url === entry.resultUrl)
      downloads.collect(pending.id);
    const matches = downloads
      .status()
      .collected.filter(
        (r) => r.phase === phase && r.pageUrl === entry.resultUrl,
      );
    if (matches.length > 1)
      throw Error(
        "같은 표면 단계의 원본이 여러 개입니다. 자동으로 선택하지 않습니다.",
      );
    if (!matches.length) continue;
    const original = downloads.collect(matches[0].id) as {
        path: string;
        sha256: string;
      },
      saved = cache.phases[phase];
    if (saved) {
      if (saved.sourceHash !== original.sha256)
        throw Error("표면 원본이 기존 검사와 다릅니다.");
      for (const f of saved.files)
        if (hash(safe(workspace, f.path)) !== f.sha256)
          throw Error("저장된 표면 검사 결과가 변경됐습니다.");
      continue;
    }
    o.progress?.(
      `앱에서 ${phase === "uv" ? "Smart UV" : "텍스처"} 원본 검사·미리보기 변환 중 · GPT 호출 없음`,
    );
    const out = path.join(workspace, "outputs", "app-surface", randomUUID());
    fs.mkdirSync(out, { recursive: true });
    safe(workspace, out);
    await (o.convert ?? runNativeModelPreview)(
      o.blender,
      o.script,
      safe(workspace, original.path),
      out,
      signal,
    );
    signal.throwIfAborted();
    if (hash(safe(workspace, original.path)) !== original.sha256)
      throw Error("표면 검사 중 원본이 변경됐습니다.");
    const reportPath = safe(workspace, path.join(out, "inspection.json")),
      preview = safe(workspace, path.join(out, "preview.glb")),
      report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const glb = fs.readFileSync(preview);
    if (
      glb.length < 20 ||
      glb.toString("ascii", 0, 4) !== "glTF" ||
      glb.readUInt32LE(4) !== 2 ||
      glb.readUInt32LE(8) !== glb.length
    )
      throw Error("표면 GLB 검사 실패");
    if (
      !Number.isSafeInteger(report.faces) ||
      report.faces < 1 ||
      !Number.isSafeInteger(report.uvLayers) ||
      report.uvLayers < 1 ||
      report.geometryEdited !== false
    )
      throw Error("실제 메시와 UV가 있는 원본이 필요합니다.");
    const native = safe(workspace, report.nativeFbx);
    if (
      !/\.fbx$/i.test(native) ||
      (!/\.zip$/i.test(original.path) &&
        native !== safe(workspace, original.path))
    )
      throw Error("표면 FBX 출처가 다릅니다.");
    const companions = report.companions.map((p: string) => safe(workspace, p));
    const textures = companions.filter((p: string) =>
      /\.(png|jpe?g|webp)$/i.test(p),
    );
    if (phase === "texture") {
      const size = { "2K": 2048, "4K": 4096, "8K": 8192 }[s.textureResolution];
      if (
        !textures.length ||
        !report.textures.some((t: any) => t.width === size && t.height === size)
      )
        throw Error(
          `요청한 ${s.textureResolution} 실제 연결 텍스처가 없습니다. 기존 결과를 보존하며 재생성하지 않습니다.`,
        );
    }
    const relative = (p: string) =>
      path.relative(workspace, p).replaceAll("\\", "/");
    const paths = [
      ...new Set<string>([
        safe(workspace, original.path),
        native,
        preview,
        reportPath,
        ...companions,
      ]),
    ];
    const converted: Phase = {
      sourceHash: original.sha256,
      fbx: relative(native),
      textures: textures.map(relative),
      uvLayers: report.uvLayers,
      files: paths.map((p) => ({ path: relative(p), sha256: hash(p) })),
      artifacts: paths.map((p) => ({
        path: relative(p),
        kind:
          p === native || p === preview
            ? phase === "texture"
              ? "model"
              : "export"
            : textures.includes(p)
              ? "image"
              : p === reportPath
                ? "report"
                : "export",
        ...(textures.includes(p)
          ? { role: "texture" }
          : p === native || p === preview
            ? { role: "whole" }
            : {}),
      })),
    };
    cache.phases[phase] = converted;
    write(o.cacheFile, cache);
  }
  if (!cache.phases.uv || !cache.phases.texture) return null;
  const uv = journal.entries.find(
      (e) => e.phase === "uv" && e.state === "completed",
    ),
    texture = journal.entries.find(
      (e) => e.phase === "texture" && e.state === "completed",
    );
  if (!uv || !texture) return null;
  const surface = {
    sourceModelId: packet.sourceStudioModel!.modelId,
    uv: {
      sourceModelId: uv.sourceModelId,
      modelId: uv.resultId!,
      url: uv.resultUrl!,
      creditCost: uv.cost,
      fbxPath: cache.phases.uv.fbx,
    },
    texture: {
      sourceModelId: texture.sourceModelId,
      modelId: texture.resultId!,
      url: texture.resultUrl!,
      creditCost: texture.cost,
      fbxPath: cache.phases.texture.fbx,
      texturePaths: cache.phases.texture.textures,
      resolution: s.textureResolution,
      removeLighting: s.removeLighting,
    },
  };
  const phases = [cache.phases.uv, cache.phases.texture],
    checks: WorkbenchCheck[] = [
      {
        name: "native_surface_integrity",
        passed: true,
        detail: `Smart UV 원본과 ${s.textureResolution} 연결 텍스처·FBX 보존. 외형은 직접 확인 후 채택하세요.`,
      },
    ];
  for (const observation of journal.surfaceObservations ?? [])
    checks.push({
      name: "visual_review",
      passed: false,
      severity: "warning",
      detail: observation,
    });
  const receipt = {
    jobId: packet.jobId,
    requestHash: o.requestHash,
    surface,
    files: phases.flatMap((p) => p.files),
    result: {
      status: "completed",
      summary: `Smart UV·${s.textureResolution} 텍스처 원본 준비 완료 · 외형 확인 후 채택하세요.`,
      checks,
      candidates: [
        {
          id: "surface-1",
          label: `Smart UV · ${s.textureResolution}`,
          artifacts: phases.flatMap((p) => p.artifacts),
        },
      ],
    },
  };
  ledger.verify(receipt);
  signal.throwIfAborted();
  write(path.join(workspace, "external-result.json"), receipt);
  return { status: "completed" as const, summary: receipt.result.summary };
}
