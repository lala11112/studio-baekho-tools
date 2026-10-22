import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { NativeDownloadCollector } from "./native-download";
import { ChromeJobLedger, type ChromePacket } from "./chrome-job-ledger";
import type { WorkbenchCheck } from "../shared/workbench";

const hash = (p: string) =>
  createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const write = (p: string, data: unknown) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + ".tmp", JSON.stringify(data, null, 2));
  fs.renameSync(p + ".tmp", p);
};
const safe = (root: string, p: string) => {
  const absolute = path.resolve(root, p);
  if (
    !absolute.startsWith(path.resolve(root) + path.sep) ||
    !fs.realpathSync(absolute).startsWith(fs.realpathSync(root) + path.sep)
  )
    throw Error("작업 폴더 밖 모델 파일은 등록할 수 없습니다.");
  return absolute;
};
export async function runNativeModelPreview(
  blender: string,
  script: string,
  source: string,
  output: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!fs.existsSync(blender) || !fs.existsSync(script))
    throw Error("Blender 실행 파일 또는 앱 변환 스크립트가 없습니다.");
  // Blender's FBX importer can reject long Windows paths even when Node reads
  // them correctly. Keep both import and export under a short private directory.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ps-fbx-"));
  const input = path.join(staging, "input" + path.extname(source));
  const result = path.join(staging, "result");
  try {
    fs.copyFileSync(source, input);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        blender,
        [
          "--background",
          "--factory-startup",
          "--python-exit-code",
          "1",
          "--python",
          script,
          "--",
          input,
          result,
        ],
        { windowsHide: true, shell: false, signal },
      );
      let log = "",
        failure: Error | undefined;
      const timer = setTimeout(() => {
        failure = Error("로컬 FBX 검사 시간 초과. 원본은 보존됩니다.");
        child.kill();
      }, 240000);
      child.stdout.on("data", (d) => {
        log = (log + d).slice(-8000);
      });
      child.stderr.on("data", (d) => {
        log = (log + d).slice(-8000);
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        failure = e;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failure) return reject(failure);
        if (signal.aborted) return reject(Error("모델 검사 취소됨"));
        code === 0
          ? resolve()
          : reject(Error(`로컬 FBX 검사 실패: ${log.slice(-1500)}`));
      });
    });
    signal.throwIfAborted();
    if (hash(input) !== hash(source))
      throw Error("검사 중 원본이 변경됐습니다.");
    const report = JSON.parse(
      fs.readFileSync(path.join(result, "inspection.json"), "utf8"),
    );
    const relocate = (p: string) =>
      path.join(output, path.relative(result, safe(result, p)));
    report.nativeFbx =
      path.resolve(report.nativeFbx) === input
        ? source
        : relocate(report.nativeFbx);
    report.companions = report.companions.map(relocate);
    fs.cpSync(result, output, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    write(path.join(output, "inspection.json"), report);
  } finally {
    // mkdtemp creates this exact private child; never remove caller-provided paths.
    if (path.dirname(fs.realpathSync(staging)) !== fs.realpathSync(os.tmpdir()))
      throw Error("임시 변환 폴더의 정리 경로가 올바르지 않습니다.");
    fs.rmSync(staging, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 200,
    });
  }
}
type Converted = {
  files: { path: string; sha256: string }[];
  artifacts: { path: string; kind: string; role?: string }[];
  checks: WorkbenchCheck[];
  faces: number;
};

/** No inference or network. Source identities come from host journals/downloads. */
export async function collectModelResult(options: {
  workspace: string;
  packet: ChromePacket;
  requestHash: string;
  ledger: ChromeJobLedger;
  downloads: NativeDownloadCollector;
  cacheFile: string;
  blender: string;
  script: string;
  signal: AbortSignal;
  convert?: typeof runNativeModelPreview;
  progress?: (message: string) => void;
}) {
  const { workspace, packet, requestHash, ledger, downloads, signal } = options;
  if (packet.request.step !== "model" || !packet.request.externalModel)
    throw Error("초기 모델 결과에만 사용할 수 있습니다.");
  signal.throwIfAborted();
  const journal = ledger.read(),
    entry = journal.entries.find(
      (e) => e.phase === "model" && e.state === "completed",
    );
  if (!entry?.resultId || !entry.resultUrl) return null;
  const models = journal.modelResults ?? [
    { modelId: entry.resultId, url: entry.resultUrl },
  ];
  const count = packet.request.generationCount ?? 4;
  if (models.length !== count) return null;
  const pending = downloads.status().pending;
  if (pending?.phase === "model" && models.some((m) => m.url === pending.url))
    downloads.collect(pending.id);
  const sources = models.map((m) => {
    const records = downloads
      .status()
      .collected.filter((r) => r.phase === "model" && r.pageUrl === m.url);
    if (records.length > 1)
      throw Error(
        "같은 모델의 다운로드가 여러 개입니다. 자동으로 선택하지 않습니다.",
      );
    return records[0]
      ? (downloads.collect(records[0].id) as { path: string; sha256: string })
      : undefined;
  });
  if (sources.some((s) => !s)) return null;
  if (new Set(sources.map((s) => s!.sha256)).size !== count)
    throw Error("서로 다른 모델에 동일 원본을 등록할 수 없습니다.");
  let cache: {
    jobId: string;
    requestHash: string;
    version: number;
    models: Record<string, Converted>;
  } = { jobId: packet.jobId, requestHash, version: 1, models: {} };
  if (fs.existsSync(options.cacheFile)) {
    cache = JSON.parse(fs.readFileSync(options.cacheFile, "utf8"));
    if (
      cache.jobId !== packet.jobId ||
      cache.requestHash !== requestHash ||
      cache.version !== 1
    )
      throw Error("로컬 모델 검사 기록이 현재 작업과 다릅니다.");
  }
  const candidates = [],
    checks: WorkbenchCheck[] = [],
    files: { path: string; sha256: string }[] = [];
  for (let i = 0; i < count; i++) {
    signal.throwIfAborted();
    const source = sources[i]!;
    const model = models[i];
    const key = model.modelId + ":" + source.sha256;
    let converted = cache.models[key];
    if (converted) {
      for (const file of converted.files)
        if (hash(safe(workspace, file.path)) !== file.sha256)
          throw Error(
            "저장된 모델 검사 결과가 변경됐습니다. 재생성하지 않습니다.",
          );
    } else {
      options.progress?.(
        `앱에서 FBX 검사·미리보기 변환 중 (${i + 1}/${count}) · GPT 호출 없음`,
      );
      const directory = path.join(
        workspace,
        "outputs",
        "app-models",
        randomUUID(),
      );
      fs.mkdirSync(directory, { recursive: true });
      safe(workspace, directory);
      await (options.convert ?? runNativeModelPreview)(
        options.blender,
        options.script,
        safe(workspace, source.path),
        directory,
        signal,
      );
      signal.throwIfAborted();
      if (hash(safe(workspace, source.path)) !== source.sha256)
        throw Error("검사 중 원본이 변경됐습니다.");
      const reportPath = safe(
          workspace,
          path.join(directory, "inspection.json"),
        ),
        preview = safe(workspace, path.join(directory, "preview.glb"));
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")),
        bytes = fs.readFileSync(preview);
      if (
        bytes.length < 20 ||
        bytes.toString("ascii", 0, 4) !== "glTF" ||
        bytes.readUInt32LE(4) !== 2 ||
        bytes.readUInt32LE(8) !== bytes.length
      )
        throw Error("변환된 GLB 형식을 검증하지 못했습니다.");
      if (
        ![
          report.vertices,
          report.faces,
          report.quads,
          report.triangles,
          report.uvLayers,
        ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
        report.vertices === 0 ||
        report.faces === 0 ||
        report.geometryEdited !== false
      )
        throw Error("FBX 검사 결과가 올바르지 않습니다.");
      const native = safe(workspace, report.nativeFbx);
      if (
        !/\.fbx$/i.test(native) ||
        (!/\.zip$/i.test(source.path) &&
          native !== safe(workspace, source.path))
      )
        throw Error("검사한 FBX와 수집 원본이 다릅니다.");
      const relative = (p: string) =>
        path.relative(workspace, p).replace(/\\/g, "/");
      const paths = [
        ...new Set([
          safe(workspace, source.path),
          native,
          preview,
          reportPath,
          ...report.companions.map((p: string) => safe(workspace, p)),
        ]),
      ];
      const localChecks: WorkbenchCheck[] = [
        {
          name: "native_model_inspection",
          passed: true,
          detail: `모델 ${i + 1}: 정점 ${report.vertices}, 면 ${report.faces}, UV 레이어 ${report.uvLayers}. 외형은 사용자 검토가 필요합니다.`,
        },
      ];
      if (report.faces !== packet.request.polygonCount)
        localChecks.push({
          name: "model_polygon_target",
          passed: false,
          severity: "warning",
          detail: `모델 ${i + 1}: 목표 ${packet.request.polygonCount}면, 실제 ${report.faces}면.`,
        });
      if (
        packet.request.externalModel.topology === "quad" &&
        report.quads !== report.faces
      )
        localChecks.push({
          name: "model_quad_ratio",
          passed: false,
          severity: "warning",
          detail: `모델 ${i + 1}: 쿼드 ${report.quads}, 삼각형 ${report.triangles}, 전체 ${report.faces}면.`,
        });
      converted = {
        faces: report.faces,
        checks: localChecks,
        files: paths.map((p) => ({ path: relative(p), sha256: hash(p) })),
        artifacts: paths.map((p) => ({
          path: relative(p),
          kind:
            p === native || p === preview
              ? "model"
              : /\.(png|jpe?g|webp|tga|bmp|exr)$/i.test(p)
                ? "image"
                : p === reportPath
                  ? "report"
                  : "export",
          ...(p === native || p === preview
            ? { role: "whole" }
            : /\.(png|jpe?g|webp|tga|bmp|exr)$/i.test(p)
              ? { role: "texture" }
              : {}),
        })),
      };
      cache.models[key] = converted;
      write(options.cacheFile, cache);
    }
    candidates.push({
      id: `model-${i + 1}`,
      label: `Tripo 모델 ${i + 1} · ${converted.faces.toLocaleString()}면`,
      artifacts: converted.artifacts,
    });
    files.push(...converted.files);
    checks.push(...converted.checks);
    for (const observation of model.observations ?? [])
      checks.push({
        name: "model_visual_review",
        passed: false,
        severity: "warning",
        detail: `모델 ${i + 1}: ${observation}`,
      });
  }
  signal.throwIfAborted();
  const receipt = {
    jobId: packet.jobId,
    requestHash,
    studioModels: models.map((m, i) => ({
      candidateId: `model-${i + 1}`,
      ...m,
    })),
    files,
    result: {
      status: "completed",
      summary: `모델 ${count}개 원본·검사·미리보기 준비 완료 · 외형을 확인하고 채택하세요.`,
      candidates,
      checks,
    },
  };
  ledger.verify(receipt);
  write(path.join(workspace, "external-result.json"), receipt);
  return { status: "completed" as const, summary: receipt.result.summary };
}
