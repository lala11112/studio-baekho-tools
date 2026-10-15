import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { GraphicsFile } from "../shared/graphics";
import type {
  PlanarInspection,
  PlanarSelection,
} from "../shared/graphics-planar";
import { validatePlanarSelection } from "../shared/graphics-planar";
export type PlanarArgs = {
  projectRoot: string;
  source: GraphicsFile;
  sourceVersionId: string;
  resources: string;
  blenderPath: string;
  signal: AbortSignal;
  mode: "inspect" | "repair";
  inspectionAttempt?: string;
  selection?: PlanarSelection;
  inspection?: PlanarInspection;
  recoveryOnly?: boolean;
  onProgress?: (message: string) => void;
};
const hash = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const active = new Set<string>();
const requiredChecks = [
  "staticOnly",
  "appendOnly",
  "oldVerticesPreserved",
  "oldUVLayersPreserved",
  "oldCustomAttributesPreserved",
  "oldCustomNormalsPreserved",
  "otherMeshesPreserved",
  "materialsAndImagesPreserved",
  "intersectionValidation",
  "fbxRoundTrip",
  "glbRoundTrip",
];
function safe(root: string, file: string, missing = false) {
  const full = path.resolve(root, file),
    rel = path.relative(root, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(":"))
    throw Error("프로젝트 내부 경로가 필요합니다.");
  let at = root;
  for (const part of rel.split(path.sep)) {
    at = path.join(at, part);
    try {
      if (
        fs.lstatSync(at).isSymbolicLink() ||
        path.relative(at, fs.realpathSync(at))
      )
        throw Error("링크 경로는 지원하지 않습니다.");
    } catch (e) {
      if (!missing || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return full;
}
function verify(root: string, file: GraphicsFile) {
  const full = safe(root, file.path),
    st = fs.statSync(full);
  if (
    !st.isFile() ||
    st.size !== file.bytes ||
    !/^[a-f0-9]{64}$/.test(file.sha256) ||
    hash(fs.readFileSync(full)) !== file.sha256
  )
    throw Error("고정 원본 또는 결과 파일이 변경됐습니다.");
  return full;
}
function json(root: string, file: string) {
  const full = safe(root, file);
  if (fs.statSync(full).size > 16 * 1024 * 1024)
    throw Error("검사 기록이 너무 큽니다.");
  return JSON.parse(fs.readFileSync(full, "utf8"));
}
export function validatePlanarReport(
  report: any,
  args: PlanarArgs,
  identity: string,
) {
  if (
    report?.schemaVersion !== 1 ||
    report.mode !== args.mode ||
    report.passed !== true ||
    report.identity !== identity ||
    report.algorithmVersion !== "planar-v1" ||
    report.sourceVersionId !== args.sourceVersionId ||
    report.sourceSha256 !== args.source.sha256 ||
    report.localOnly !== true ||
    report.modelTurns !== 0 ||
    report.paidSubmissions !== 0
  )
    throw Error("로컬 검사 원본·실행 기록이 일치하지 않습니다.");
  if (args.mode === "inspect") {
    if (
      typeof report.inspectionId !== "string" ||
      !report.inspectionId ||
      !Array.isArray(report.meshes)
    )
      throw Error("경계 검사 기록이 없습니다.");
    const ids = new Set<string>();
    for (const mesh of report.meshes) {
      if (
        typeof mesh.meshId !== "string" ||
        ids.has(mesh.meshId) ||
        !Array.isArray(mesh.boundaries)
      )
        throw Error("메시 검사 기록이 잘못됐습니다.");
      ids.add(mesh.meshId);
      const bs = new Set<string>();
      for (const b of mesh.boundaries) {
        if (
          typeof b.id !== "string" ||
          bs.has(b.id) ||
          !["eligible", "blocked"].includes(b.status) ||
          !Array.isArray(b.reasons) ||
          !Array.isArray(b.materialOptions) ||
          !Array.isArray(b.worldVertices) ||
          (b.status === "eligible" && b.worldVertices.length < 3) ||
          b.worldVertices.some(
            (v: any) =>
              !Array.isArray(v) ||
              v.length !== 3 ||
              v.some((n: any) => !Number.isFinite(n)),
          )
        )
          throw Error("경계 좌표 기록이 잘못됐습니다.");
        bs.add(b.id);
      }
    }
  } else {
    const s = args.selection!;
    for (const k of [
      "inspectionId",
      "meshId",
      "materialPolicy",
      "selectedBoundaryIds",
      "keptBoundaryIds",
    ] as const)
      if (JSON.stringify(report[k]) !== JSON.stringify(s[k]))
        throw Error("보완 경계 선택이 달라졌습니다.");
    if (
      !report.checks ||
      requiredChecks.some((k) => report.checks[k] !== true) ||
      !Array.isArray(report.warnings)
    )
      throw Error("원본 보존 검사에 실패했습니다.");
  }
}
type Run = (
  binary: string,
  command: string[],
  signal: AbortSignal,
) => Promise<void>;
const run: Run = async (binary, command, signal) =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(binary, command, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => child.kill(), 600000);
    child.stdout.on("data", (v) => (tail = (tail + v).slice(-3000)));
    child.stderr.on("data", (v) => (tail = (tail + v).slice(-3000)));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      signal.aborted
        ? reject(Error("로컬 검사를 중지했습니다."))
        : code === 0
          ? resolve()
          : reject(Error("Blender 로컬 검사 실패: " + tail));
    });
  });
export function createGraphicsPlanarRunner(deps: { runBlender?: Run } = {}) {
  return async (args: PlanarArgs) => {
    args.signal.throwIfAborted();
    const root = fs.realpathSync(args.projectRoot),
      resources = fs.realpathSync(args.resources),
      source = verify(root, args.source);
    if (args.mode === "repair") {
      if (
        !args.selection ||
        !args.inspection ||
        args.inspection.sourceSha256 !== args.source.sha256 ||
        !args.inspection.reportFile
      )
        throw Error("고정된 원본의 저장 경계 검사가 필요합니다.");
      validatePlanarSelection(args.inspection, args.selection);
      const stored = json(root, verify(root, args.inspection.reportFile));
      if (
        JSON.stringify(stored) !==
        JSON.stringify(
          Object.fromEntries(
            Object.entries(args.inspection).filter(
              ([key]) => key !== "reportFile",
            ),
          ),
        )
      )
        throw Error("저장 경계 검사와 선택 기록이 다릅니다.");
    }
    if (!/\.(blend|fbx)$/i.test(source))
      throw Error("정적 BLEND 또는 FBX 원본이 필요합니다.");
    const names = [
      "graphics_planar_repair.py",
      "graphics_glb.py",
      "tripo_part_preservation.py",
    ];
    const scripts = names.map((name) => {
      const file = safe(resources, path.join("blender", name));
      return { name, file, sha256: hash(fs.readFileSync(file)) };
    });
    const binary = fs.realpathSync(args.blenderPath),
      binarySha256 = hash(fs.readFileSync(binary));
    const identity = hash(
      JSON.stringify({
        algorithmVersion: "planar-v1",
        sourceVersionId: args.sourceVersionId,
        sourceSha256: args.source.sha256,
        mode: args.mode,
        inspectionAttempt:
          args.mode === "inspect" ? (args.inspectionAttempt ?? null) : null,
        selection: args.selection ?? null,
        inspectionReportSha256: args.inspection?.reportFile?.sha256 ?? null,
        inspection: args.inspection?.meshes ?? null,
        binarySha256,
        scripts: scripts.map((s) => [s.name, s.sha256]),
      }),
    );
    const folder = safe(root, path.join("graphics", "planar", identity), true);
    fs.mkdirSync(folder, { recursive: true });
    const manifest = safe(root, path.join(folder, "manifest.json"), true),
      dispatch = safe(root, path.join(folder, "dispatch.json"), true);
    const check = () => {
      args.signal.throwIfAborted();
      verify(root, args.source);
      if (hash(fs.readFileSync(binary)) !== binarySha256)
        throw Error("Blender 실행 파일이 변경됐습니다.");
      for (const s of scripts)
        if (hash(fs.readFileSync(s.file)) !== s.sha256)
          throw Error("검사 도구가 변경됐습니다.");
    };
    if (active.has(folder)) throw Error("같은 검사가 실행 중입니다.");
    active.add(folder);
    const outputs =
      args.mode === "inspect"
        ? ["report.json"]
        : ["asset.blend", "asset.fbx", "asset.glb", "report.json"];
    const collect = () =>
      outputs.map((name) => {
        const file = safe(root, path.join(folder, "output", name)),
          st = fs.statSync(file);
        if (!st.isFile() || !st.size)
          throw Error("완전한 보완 결과가 없습니다.");
        return {
          path: path.relative(root, file).split(path.sep).join("/"),
          bytes: st.size,
          sha256: hash(fs.readFileSync(file)),
          kind: name.endsWith(".json")
            ? "report"
            : name.endsWith(".blend")
              ? "blend"
              : "model",
        };
      });
    let staging: string | undefined;
    try {
      if (fs.existsSync(manifest)) {
        const saved = json(root, manifest);
        if (
          saved.identity !== identity ||
          !Array.isArray(saved.files) ||
          saved.files.length !== outputs.length
        )
          throw Error("저장 결과 목록이 다릅니다.");
        const actual = collect();
        if (JSON.stringify(actual) !== JSON.stringify(saved.files))
          throw Error("저장 결과 파일·경로·해시가 다릅니다.");
        const report = json(
          root,
          verify(
            root,
            saved.files.find((f: GraphicsFile) => f.kind === "report"),
          ),
        );
        validatePlanarReport(report, args, identity);
        check();
        return { files: saved.files as GraphicsFile[], report, cached: true };
      }
      if (args.recoveryOnly && fs.existsSync(dispatch)) {
        const journal = json(root, dispatch);
        if (journal.identity !== identity) throw Error("실행 기록이 다릅니다.");
        const report = json(root, path.join(folder, "output", "report.json"));
        validatePlanarReport(report, args, identity);
        const files = collect();
        check();
        fs.writeFileSync(manifest, JSON.stringify({ identity, files }), {
          flag: "wx",
        });
        return { files, report, cached: true };
      }
      if (args.recoveryOnly || fs.existsSync(dispatch))
        throw Error(
          "이 검사는 이미 실행됐습니다. 저장된 완전한 결과만 복구할 수 있습니다. 새 실행하지 않습니다.",
        );
      staging = fs.mkdtempSync(path.join(os.tmpdir(), "ps-planar-"));
      const tools = path.join(staging, "tools"),
        output = path.join(folder, "output");
      fs.mkdirSync(tools);
      fs.mkdirSync(output);
      const localSource = path.join(staging, "source" + path.extname(source));
      fs.copyFileSync(source, localSource);
      for (const s of scripts)
        fs.copyFileSync(s.file, path.join(tools, s.name));
      const request = {
        schemaVersion: 1,
        mode: args.mode,
        source: localSource,
        output,
        report: path.join(output, "report.json"),
        sourceVersionId: args.sourceVersionId,
        sourceSha256: args.source.sha256,
        identity,
        algorithmVersion: "planar-v1",
        ...args.selection,
      };
      const requestFile = path.join(staging, "request.json");
      fs.writeFileSync(requestFile, JSON.stringify(request));
      const fd = fs.openSync(dispatch, "wx");
      try {
        fs.writeFileSync(
          fd,
          JSON.stringify({
            identity,
            request,
            startedAt: new Date().toISOString(),
            localOnly: true,
            modelTurns: 0,
            paidSubmissions: 0,
          }),
        );
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      args.onProgress?.(
        args.mode === "inspect"
          ? "원본을 읽고 열린 경계와 평면 조건을 검사합니다."
          : "선택한 경계를 보완하고 원본·재질·내보내기를 검사합니다.",
      );
      await (deps.runBlender ?? run)(
        args.blenderPath,
        [
          "--background",
          "--factory-startup",
          "--disable-autoexec",
          "--python-exit-code",
          "1",
          "--python",
          path.join(tools, names[0]),
          "--",
          requestFile,
        ],
        args.signal,
      );
      check();
      if (
        hash(fs.readFileSync(localSource)) !== args.source.sha256 ||
        scripts.some(
          (s) => hash(fs.readFileSync(path.join(tools, s.name))) !== s.sha256,
        )
      )
        throw Error("실행 중 원본 또는 도구가 변경됐습니다.");
      const report = json(root, path.join(output, "report.json"));
      validatePlanarReport(report, args, identity);
      const files = collect();
      check();
      const tmp = manifest + "." + randomUUID();
      fs.writeFileSync(tmp, JSON.stringify({ identity, files }), {
        flag: "wx",
      });
      fs.renameSync(tmp, manifest);
      return { files, report, cached: false };
    } finally {
      active.delete(folder);
      if (staging) {
        const temp = fs.realpathSync(os.tmpdir()),
          full = fs.realpathSync(staging);
        if (
          path.dirname(full) === temp &&
          /^ps-planar-[A-Za-z0-9]+$/.test(path.basename(full))
        )
          fs.rmSync(full, { recursive: true, force: true });
      }
    }
  };
}
export const runGraphicsPlanar = createGraphicsPlanarRunner();
