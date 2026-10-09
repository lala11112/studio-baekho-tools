import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Store, uid } from "./store";
import { parseJsonText } from "./json";
import { CodexWorker, type ProductionWorker } from "./codex-worker";
import type {
  ProductionArtifact,
  ProductionConfig,
  ProductionRun,
  ProductionStage,
  ProductionStageKind,
  StageResult,
} from "../shared/production";

const configSchema = z
  .object({
    sourceId: z.string().min(1),
    brief: z.string().trim().min(1).max(6000),
    motions: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
    maxIterations: z.number().int().min(1).max(5),
    studioCreditLimit: z.number().int().min(0).max(100000),
    videoCreditLimit: z.number().int().min(0).max(100000),
    videoUrl: z.string().url().optional(),
    mode: z.literal("studio"),
  })
  .strict();
const resultSchema = z
  .object({
    status: z.enum(["completed", "needs_input", "rework"]),
    summary: z.string().min(1).max(12000),
    artifacts: z
      .array(
        z
          .object({
            path: z.string().min(1).max(2000),
            kind: z.enum(["image", "model", "video", "report"]),
            role: z
              .string()
              .max(100)
              .nullable()
              .optional()
              .transform((value) => value ?? undefined),
          })
          .strict(),
      )
      .max(100),
    checks: z
      .array(
        z
          .object({ name: z.string().min(1).max(200), passed: z.boolean() })
          .strict(),
      )
      .max(100),
    reworkStageId: z
      .string()
      .max(100)
      .nullable()
      .optional()
      .transform((value) => value ?? undefined),
  })
  .strict();
export const stageResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "artifacts", "checks", "reworkStageId"],
  properties: {
    status: { type: "string", enum: ["completed", "needs_input", "rework"] },
    summary: { type: "string" },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "kind", "role"],
        properties: {
          path: { type: "string" },
          kind: { type: "string", enum: ["image", "model", "video", "report"] },
          role: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
    },
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "passed"],
        properties: { name: { type: "string" }, passed: { type: "boolean" } },
      },
    },
    reworkStageId: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
};
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const now = () => new Date().toISOString();
const roles = ["body", "head", "hair"];
function inspectGlb(bytes: Buffer) {
  if (
    bytes.length < 20 ||
    bytes.subarray(0, 4).toString() !== "glTF" ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length
  )
    throw new Error("GLB 파일 검증 실패");
  const length = bytes.readUInt32LE(12);
  if (
    bytes.readUInt32LE(16) !== 0x4e4f534a ||
    length < 2 ||
    20 + length > bytes.length
  )
    throw new Error("GLB JSON 데이터가 없습니다.");
  const data = JSON.parse(
    bytes
      .subarray(20, 20 + length)
      .toString("utf8")
      .trim(),
  );
  const binaryOffset = 20 + length;
  if (
    binaryOffset + 8 > bytes.length ||
    bytes.readUInt32LE(binaryOffset + 4) !== 0x004e4942 ||
    bytes.readUInt32LE(binaryOffset) > bytes.length - binaryOffset - 8 ||
    !data.buffers?.[0]?.byteLength ||
    data.buffers[0].byteLength > bytes.readUInt32LE(binaryOffset)
  )
    throw new Error("실제 GLB 정점 바이너리 데이터가 없습니다.");
  if (
    !Array.isArray(data.meshes) ||
    !data.meshes.some((mesh: any) =>
      mesh.primitives?.some((primitive: any) => {
        const accessor = data.accessors?.[primitive.attributes?.POSITION];
        const view = data.bufferViews?.[accessor?.bufferView];
        return (
          accessor?.type === "VEC3" &&
          accessor.count >= 3 &&
          view?.byteLength >= accessor.count * 12 &&
          data.buffers?.[view.buffer]?.byteLength >= view.byteLength
        );
      }),
    )
  )
    throw new Error("실제 정점 데이터를 갖춘 메시가 없는 GLB입니다.");
  return data;
}
const requiredKinds: Record<ProductionStageKind, ProductionArtifact["kind"][]> =
  {
    separate: ["image", "report"],
    generate: ["model", "image", "report"],
    review: ["image", "report"],
    uv: ["model", "report"],
    texture: ["model", "image", "report"],
    assemble: ["model", "image", "report"],
    "assembly-review": ["image", "report"],
    "final-uv": ["model", "report"],
    "final-texture": ["model", "image", "report"],
    rig: ["model", "image", "report"],
    "view-reference": ["image", "report"],
    "animation-reference": ["image", "report"],
    "motion-transfer": ["model", "image", "report"],
    unity: ["model", "image", "report"],
  };
function stages(config: ProductionConfig): ProductionStage[] {
  const result: ProductionStage[] = [];
  const add = (
    id: string,
    kind: ProductionStageKind,
    title: string,
    dependsOn: string[],
    requiredChecks: string[],
    extra: Partial<ProductionStage> = {},
  ) =>
    result.push({
      id,
      kind,
      title,
      dependsOn,
      requiredChecks,
      status: "pending",
      attempt: 0,
      charged: false,
      artifacts: [],
      ...extra,
    });
  add(
    "separate",
    "separate",
    "정면 이미지에서 몸체·머리·헤어 분리",
    [],
    ["three_semantic_parts", "transparent_masks", "source_identity_preserved"],
  );
  for (const role of roles) {
    const label = { body: "몸체", head: "머리", hair: "헤어" }[role];
    add(
      `${role}.generate`,
      "generate",
      `${label} · Tripo Studio 모델 생성`,
      ["separate"],
      ["studio_result_downloaded", "part_identity", "geometry_present"],
      { role, charged: true, capability: "studio" },
    );
    add(
      `${role}.review`,
      "review",
      `${label} · 다각도 품질 검수`,
      [`${role}.generate`],
      ["front_reference_match", "silhouette_and_back", "mesh_integrity"],
      { role },
    );
    add(
      `${role}.uv`,
      "uv",
      `${label} · Studio UV 처리`,
      [`${role}.review`],
      ["uv_present", "uv_overlap_reviewed"],
      { role, charged: true, capability: "studio" },
    );
    add(
      `${role}.texture`,
      "texture",
      `${label} · Studio 텍스처`,
      [`${role}.uv`],
      ["texture_files_present", "material_consistency", "no_missing_maps"],
      { role, charged: true, capability: "studio" },
    );
  }
  add(
    "assemble",
    "assemble",
    "Blender 조립·비율·접합부 보정",
    roles.map((role) => `${role}.texture`),
    ["parts_aligned", "seams_reviewed", "real_meshes_preserved"],
  );
  add(
    "assembly-review",
    "assembly-review",
    "조립 결과 다각도 검수",
    ["assemble"],
    ["reference_identity", "topology_and_seams", "scale_and_orientation"],
  );
  add(
    "final-uv",
    "final-uv",
    "최종 메시 Studio UV 재처리",
    ["assembly-review"],
    ["final_topology_uv", "uv_overlap_reviewed"],
    { charged: true, capability: "studio" },
  );
  add(
    "final-texture",
    "final-texture",
    "최종 메시 Studio 텍스처 재처리",
    ["final-uv"],
    ["final_texture_complete", "seam_color_consistency"],
    { charged: true, capability: "studio" },
  );
  add(
    "rig",
    "rig",
    "최종 캐릭터 리깅·변형 검사",
    ["final-texture"],
    ["armature_and_weights", "joint_deformation", "hair_bound_to_head"],
    { charged: true, capability: "studio" },
  );
  config.motions.forEach((motion, index) => {
    for (const view of ["front", "side", "back"]) {
      add(
        `motion-${index}.${view}.reference`,
        "view-reference",
        `${motion} · ${view} 방향 캐릭터 참조 이미지`,
        ["rig"],
        ["same_character_identity", "requested_view", "reference_quality"],
        {
          motion,
          role: view,
          charged: false,
        },
      );
      add(
        `motion-${index}.${view}.frames`,
        "animation-reference",
        `${motion} · ${view} 방향 2D 애니메이션 이미지 시퀀스`,
        [
          `motion-${index}.${view}.reference`,
          ...(view === "front" ? [] : [`motion-${index}.front.frames`]),
        ],
        [
          "actual_sequence_frames",
          "same_character_identity",
          "requested_motion_visible",
          "fixed_camera",
          "requested_view",
          "timestamp_manifest",
        ],
        { motion, role: view },
      );
    }
    add(
      `motion-${index}.transfer`,
      "motion-transfer",
      `${motion} · Codex Astra 3D 애니메이션 제작·검수`,
      [
        "rig",
        ...["front", "side", "back"].map(
          (view) => `motion-${index}.${view}.frames`,
        ),
      ],
      [
        "image_motion_analyzed",
        "animation_baked",
        "contact_and_timing_reviewed",
        "multi_view_consistency",
        "view_time_alignment",
        "synchronized_reference_manifest",
      ],
      { motion },
    );
  });
  add(
    "unity",
    "unity",
    "Unity 출력·Avatar·실제 애니메이션 검증",
    config.motions.map((_, index) => `motion-${index}.transfer`),
    [
      "humanoid_avatar_valid",
      "requested_clips_present",
      "unity_playback_verified",
    ],
  );
  return result;
}
function within(root: string, relative: string) {
  if (path.isAbsolute(relative))
    throw new Error("산출물은 작업 폴더 안의 상대 경로여야 합니다.");
  const file = path.resolve(root, relative);
  if (!file.startsWith(path.resolve(root) + path.sep))
    throw new Error("작업 폴더 밖 산출물 경로를 거부했습니다.");
  return file;
}
function verifyFormat(
  file: string,
  bytes: Buffer,
  kind: ProductionArtifact["kind"],
) {
  const ext = path.extname(file).toLowerCase();
  if (kind === "report") {
    if (![".json", ".md", ".txt", ".html"].includes(ext))
      throw new Error("검증 보고서 형식 오류");
    if (ext === ".json") parseJsonText(bytes.toString("utf8"));
  } else if (kind === "image") {
    if (!(
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
      (bytes.subarray(0, 4).toString() === "RIFF" &&
        bytes.subarray(8, 12).toString() === "WEBP")
    ))
      throw new Error("이미지 파일 시그니처 검증 실패");
  } else if (kind === "model") {
    if (ext === ".glb") {
      inspectGlb(bytes);
    } else if (ext === ".fbx") {
      if (
        !/^(Kaydara FBX Binary|;\s*FBX|FBXHeaderExtension)/.test(
          bytes.subarray(0, 100).toString().trimStart(),
        )
      )
        throw new Error("FBX 파일 검증 실패");
    } else if (
      ext !== ".blend" ||
      bytes.subarray(0, 7).toString() !== "BLENDER"
    )
      throw new Error("모델은 검증 가능한 GLB/FBX/BLEND가 필요합니다.");
  } else if (kind === "video") {
    if (
      bytes.length < 32 ||
      !(
        ((ext === ".mp4" || ext === ".mov") &&
          bytes.subarray(4, 8).toString() === "ftyp") ||
        (ext === ".webm" &&
          bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])))
      )
    )
      throw new Error(
        "실제 MP4/MOV/WebM 동영상 파일이 필요합니다. 정지 이미지나 포즈 목록으로 대신할 수 없습니다.",
      );
  }
}

export class ProductionEngine {
  private active = new Map<string, AbortController>();
  constructor(
    private store: Store,
    private worker: ProductionWorker = new CodexWorker(),
  ) {
    for (const run of this.store.all<ProductionRun>("production")) {
      if (run.status !== "running") continue;
      run.status = "needs_input";
      run.message =
        "앱 종료 후 작업 상태 확인이 필요합니다. 원격 요청은 자동으로 다시 제출하지 않습니다.";
      for (const stage of run.stages.filter(
        (stage) => stage.status === "running",
      )) {
        stage.status = "needs_input";
        stage.remoteAmbiguous = this.ambiguous(run, stage);
        stage.summary = stage.charged
          ? "원격 제출 여부 미확인 · Studio 작업 기록 확인 후 새 승인 필요"
          : "중단된 로컬 단계 · 재개 시 새 시도로 검증";
      }
      this.save(run);
    }
  }
  private save(run: ProductionRun) {
    run.updatedAt = now();
    this.store.put("production", run.id, run);
    this.store.write(
      run.projectId,
      `production/${run.id}/run.json`,
      JSON.stringify(run, null, 2),
    );
    return run;
  }
  private ambiguous(run: ProductionRun, stage: ProductionStage) {
    if (!stage.charged) return false;
    try {
      const receipt = this.worker.stageReceipt?.(
        run.id,
        stage.id,
        stage.attempt,
      );
      return !receipt || receipt.charges.length > 0;
    } catch {
      return true;
    }
  }
  create(projectId: string, raw: ProductionConfig) {
    const config = configSchema.parse(raw),
      project = this.store.project(projectId);
    if (config.videoUrl && !/^https:\/\//i.test(config.videoUrl))
      throw new Error("동영상 생성 서비스는 HTTPS 주소를 사용하세요.");
    const source = project.assets.find(
      (asset) => asset.id === config.sourceId && asset.kind === "image",
    );
    if (!source) throw new Error("캐릭터 정면 이미지를 선택하세요.");
    const sourceFile = this.store.file(projectId, source.file),
      bytes = fs.readFileSync(sourceFile);
    verifyFormat(sourceFile, bytes, "image");
    const id = uid(),
      workspace = this.store.file(projectId, `production/${id}`),
      sourcePath = `inputs/front${path.extname(source.file)}`;
    this.store.write(projectId, `production/${id}/${sourcePath}`, bytes);
    const run: ProductionRun = {
      schemaVersion: 1,
      id,
      projectId,
      projectRevision: project.revision,
      config,
      status: "ready",
      createdAt: now(),
      updatedAt: now(),
      workspace,
      source: { path: sourcePath, sha256: digest(bytes), label: source.label },
      stages: stages(config),
      message:
        "자동 제작 계획이 준비됐습니다. 범위와 비용 한도를 승인한 뒤 시작하세요.",
    };
    return this.save(run);
  }
  list(projectId?: string) {
    return this.store
      .all<ProductionRun>("production")
      .filter((run) => !projectId || run.projectId === projectId);
  }
  get(runId: string) {
    const run = this.store.get<ProductionRun>("production", runId);
    if (!run) throw new Error("자동 제작 작업이 없습니다.");
    return run;
  }
  isProjectActive(projectId: string) {
    return this.list(projectId).some(
      (run) =>
        this.active.has(run.id) ||
        run.status === "running" ||
        run.stages.some((stage) => stage.status === "running"),
    );
  }
  probe() {
    return this.worker.probe();
  }
  start(runId: string) {
    const run = this.get(runId);
    if (this.active.has(runId)) return run;
    if (this.active.size)
      throw new Error(
        "다른 자동 제작 작업이 실행 중입니다. Studio 작업자는 한 번에 하나만 실행합니다.",
      );
    if (run.status === "completed" || run.status === "cancelled")
      throw new Error("종료된 제작 작업은 다시 시작할 수 없습니다.");
    // A browser charge may settle just after the user pauses the local process.
    // Recheck the canonical journal before permitting another stage attempt.
    for (const stage of run.stages)
      if (
        stage.charged &&
        stage.attempt > 0 &&
        ["needs_input", "failed"].includes(stage.status) &&
        this.ambiguous(run, stage)
      )
        stage.remoteAmbiguous = true;
    if (
      run.stages.some(
        (stage) => stage.remoteAmbiguous || stage.requiresApproval,
      )
    ) {
      this.save(run);
      throw new Error(
        "원격 제출 여부 또는 유료 재작업 승인이 필요합니다. 자동 재제출을 막기 위해 이 작업은 재개하지 않습니다.",
      );
    }
    if (this.store.project(run.projectId).revision !== run.projectRevision)
      throw new Error(
        "입력 프로젝트 버전이 변경됐습니다. 현재 입력으로 새 제작 계획을 만드세요.",
      );
    const source = fs.readFileSync(within(run.workspace, run.source.path));
    if (digest(source) !== run.source.sha256)
      throw new Error(
        "승인한 정면 이미지가 변경됐습니다. 새 제작 계획이 필요합니다.",
      );
    for (const stage of run.stages)
      if (stage.status === "needs_input" || stage.status === "failed")
        stage.status = "pending";
    run.status = "running";
    run.approvedAt ??= now();
    run.message = "Codex 자동 제작 작업자가 단계별 증거를 검증하며 진행합니다.";
    const controller = new AbortController();
    this.active.set(runId, controller);
    this.save(run);
    void this.execute(runId, controller).finally(() =>
      this.active.delete(runId),
    );
    return run;
  }
  resume(runId: string) {
    if (!this.get(runId).approvedAt)
      throw new Error(
        "제작 계획과 비용 한도를 먼저 승인해야 합니다. 재개로 최초 승인을 건너뛸 수 없습니다.",
      );
    return this.start(runId);
  }
  pause(runId: string) {
    return this.stop(runId, false);
  }
  cancel(runId: string) {
    return this.stop(runId, true);
  }
  private stop(runId: string, cancel: boolean) {
    const run = this.get(runId);
    if (["completed", "cancelled"].includes(run.status)) return run;
    if (!cancel && !run.approvedAt) return run;
    run.status = cancel ? "cancelled" : "paused";
    run.message =
      "로컬 작업자를 중지했습니다. 원격 생성·과금 취소를 의미하지 않습니다.";
    for (const stage of run.stages.filter(
      (stage) => stage.status === "running",
    )) {
      stage.status = cancel ? "cancelled" : "needs_input";
      stage.remoteAmbiguous = this.ambiguous(run, stage);
      stage.summary = run.message;
    }
    this.save(run);
    this.active.get(runId)?.abort();
    return run;
  }
  shutdown() {
    for (const id of this.active.keys()) this.pause(id);
    this.worker.shutdown?.();
  }
  private ancestors(run: ProductionRun, stage: ProductionStage) {
    const ids = new Set<string>();
    const visit = (id: string) => {
      if (ids.has(id)) return;
      ids.add(id);
      run.stages.find((item) => item.id === id)?.dependsOn.forEach(visit);
    };
    stage.dependsOn.forEach(visit);
    return run.stages.filter((item) => ids.has(item.id));
  }
  verifyArtifacts(
    run: ProductionRun,
    stage: ProductionStage,
    result: StageResult,
  ) {
    if (!result.artifacts.length)
      throw new Error("산출물 없는 완료 응답은 인정하지 않습니다.");
    const realRoot = fs.realpathSync(run.workspace),
      attemptRoot = path.resolve(
        run.workspace,
        `stages/${stage.id}/attempt-${stage.attempt}`,
      );
    const artifacts = result.artifacts.map((artifact) => {
      const file = within(run.workspace, artifact.path);
      if (!file.startsWith(attemptRoot + path.sep))
        throw new Error("현재 시도의 출력 폴더에 새 산출물을 저장해야 합니다.");
      if (!fs.existsSync(file) || !fs.statSync(file).isFile())
        throw new Error("보고한 산출물 파일이 없습니다: " + artifact.path);
      if (!fs.realpathSync(file).startsWith(realRoot + path.sep))
        throw new Error("작업 폴더 밖을 가리키는 산출물을 거부했습니다.");
      const bytes = fs.readFileSync(file);
      if (!bytes.length)
        throw new Error("빈 산출물은 완료로 인정하지 않습니다.");
      verifyFormat(file, bytes, artifact.kind);
      return {
        ...artifact,
        sha256: digest(bytes),
        bytes: bytes.length,
        stageId: stage.id,
      };
    });
    for (const kind of requiredKinds[stage.kind])
      if (!artifacts.some((artifact) => artifact.kind === kind))
        throw new Error(`필수 ${kind} 산출물이 없습니다.`);
    if (stage.kind === "separate")
      for (const role of roles)
        if (
          !artifacts.some(
            (artifact) => artifact.kind === "image" && artifact.role === role,
          )
        )
          throw new Error(`분리된 ${role} 이미지가 없습니다.`);
    if (stage.kind === "animation-reference") {
      const manifest = artifacts.find(
        (artifact) =>
          artifact.kind === "report" &&
          path.basename(artifact.path) === "sequence-manifest.json",
      );
      if (!manifest)
        throw new Error("실제 애니메이션 이미지 시퀀스 manifest가 없습니다.");
      const data = parseJsonText(
        fs.readFileSync(within(run.workspace, manifest.path), "utf8"),
      );
      if (
        data.view !== stage.role ||
        data.camera !== "fixed" ||
        !Array.isArray(data.frames) ||
        data.frames.length < 3
      )
        throw new Error(
          "고정 카메라의 방향별 실제 프레임 3개 이상이 필요합니다.",
        );
      let previous = -1;
      const used = new Set<string>();
      const hashes = new Set<string>();
      for (const frame of data.frames) {
        const image = artifacts.find(
          (artifact) =>
            artifact.kind === "image" && artifact.path === frame.path,
        );
        if (
          !image ||
          image.sha256 !== frame.sha256 ||
          !Number.isFinite(frame.time) ||
          frame.time < 0 ||
          frame.time <= previous ||
          used.has(frame.path)
        )
          throw new Error("프레임 파일·해시·시간 순서를 검증하지 못했습니다.");
        previous = frame.time;
        used.add(frame.path);
        hashes.add(image.sha256);
      }
      if (hashes.size < 3)
        throw new Error(
          "서로 다른 동작 프레임 이미지 3개 이상이 필요합니다. 파일 복사로 대체할 수 없습니다.",
        );
    }
    if (stage.kind === "motion-transfer") {
      const manifest = artifacts.find(
        (artifact) =>
          artifact.kind === "report" &&
          path.basename(artifact.path) ===
            "synchronized-reference-manifest.json",
      );
      if (!manifest)
        throw new Error(
          "다방향 이미지 시퀀스의 실제 동기화 manifest가 없습니다.",
        );
      const data = parseJsonText(
        fs.readFileSync(within(run.workspace, manifest.path), "utf8"),
      );
      const sequences = this.ancestors(run, stage).filter(
        (item) => item.kind === "animation-reference",
      );
      const frameSets: Record<string, { path: string; time: number }[]> = {};
      for (const view of ["front", "side", "back"]) {
        const entry = data.views?.find(
          (entry: { view?: string }) => entry.view === view,
        );
        const sequence = sequences
          .find((item) => item.role === view)
          ?.artifacts.find(
            (artifact) =>
              path.basename(artifact.path) === "sequence-manifest.json",
          );
        if (
          !entry ||
          !sequence ||
          entry.sha256 !== sequence.sha256 ||
          entry.sequenceManifestPath !== sequence.path
        )
          throw new Error(
            `${view} 이미지 시퀀스의 동기화 근거가 불완전합니다.`,
          );
        frameSets[view] = parseJsonText(
          fs.readFileSync(within(run.workspace, sequence.path), "utf8"),
        ).frames;
      }
      let previousTime = -1;
      if (
        !Array.isArray(data.frameCorrespondence) ||
        data.frameCorrespondence.length < 3 ||
        data.frameCorrespondence.some((sample: Record<string, unknown>) => {
          const invalid =
            !Number.isFinite(sample.time) ||
            Number(sample.time) <= previousTime ||
            !["front", "side", "back"].every((view) =>
              frameSets[view].some(
                (frame) =>
                  frame.path === sample[`${view}Path`] &&
                  Math.abs(frame.time - Number(sample.time)) < 0.0001,
              ),
            );
          previousTime = Number(sample.time);
          return invalid;
        })
      )
        throw new Error(
          "같은 시점에 대응하는 정면·측면·후면 프레임이 필요합니다.",
        );
    }
    for (const name of stage.requiredChecks)
      if (!result.checks.some((check) => check.name === name && check.passed))
        throw new Error(`필수 품질 검사 미통과: ${name}`);
    if (result.checks.some((check) => !check.passed))
      throw new Error("실패한 품질 검사가 있어 완료로 인정하지 않습니다.");
    if (requiredKinds[stage.kind].includes("model")) {
      const glb = artifacts.find(
        (artifact) =>
          artifact.kind === "model" &&
          path.extname(artifact.path).toLowerCase() === ".glb",
      );
      if (!glb)
        throw new Error(
          "원본 모델과 함께 호스트가 검증할 실제 메시 GLB가 필요합니다.",
        );
      const model = inspectGlb(
        fs.readFileSync(within(run.workspace, glb.path)),
      );
      if (
        ["rig", "motion-transfer", "unity"].includes(stage.kind) &&
        (!model.skins?.length ||
          !model.nodes?.some((node: any) => Number.isInteger(node.skin)))
      )
        throw new Error("실제 스킨·리그가 없는 모델입니다.");
      if (
        ["motion-transfer", "unity"].includes(stage.kind) &&
        !model.animations?.some(
          (clip: any) => clip.channels?.length && clip.samplers?.length,
        )
      )
        throw new Error("실제 애니메이션 채널이 없는 모델입니다.");
    }
    if (stage.charged) {
      const receipt = this.worker.stageReceipt?.(
        run.id,
        stage.id,
        stage.attempt,
      );
      if (
        !receipt ||
        !receipt.downloads.some(
          (download) =>
            download.state === "completed" &&
            artifacts.some(
              (artifact) =>
                artifact.kind === "model" &&
                artifact.sha256 === download.sha256 &&
                artifact.bytes === download.bytes,
            ),
        )
      )
        throw new Error(
          "호스트 Studio 다운로드 기록과 일치하는 실제 원본 모델이 없습니다.",
        );
    }
    return artifacts;
  }
  private workerImages(run: ProductionRun, stage: ProductionStage) {
    const images = [within(run.workspace, run.source.path)];
    if (stage.kind === "motion-transfer") {
      for (const sequence of this.ancestors(run, stage).filter(
        (item) => item.kind === "animation-reference",
      )) {
        const manifest = sequence.artifacts.find(
          (item) => path.basename(item.path) === "sequence-manifest.json",
        );
        const frames = parseJsonText(
          fs.readFileSync(within(run.workspace, manifest!.path), "utf8"),
        ).frames as { path: string }[];
        for (const index of [
          ...new Set([
            0,
            Math.floor((frames.length - 1) / 2),
            frames.length - 1,
          ]),
        ])
          if (frames[index])
            images.push(within(run.workspace, frames[index].path));
      }
    }
    return images;
  }
  private allowedWritePaths(run: ProductionRun, stage: ProductionStage) {
    if (stage.kind !== "unity") return [];
    const configured = this.store.project(run.projectId).unityPath;
    if (
      !configured ||
      !path.isAbsolute(configured) ||
      !fs.existsSync(configured)
    )
      throw new Error("Unity 프로젝트 경로를 먼저 연결하세요.");
    const root = fs.realpathSync(configured);
    for (const folder of ["Assets", "ProjectSettings"])
      if (!fs.existsSync(path.join(root, folder)))
        throw new Error("유효한 Unity 프로젝트 폴더가 아닙니다.");
    return [root];
  }
  private prompt(run: ProductionRun, stage: ProductionStage, folder: string) {
    const instructions: Record<ProductionStageKind, string> = {
      separate:
        "Inspect the attached actual front reference. Use the built-in Codex image_gen/imagegen capability and its applicable imagegen skill first for semantic isolation and faithful inpainting when necessary. Produce THREE transparent masked PNG images for body (excluding head/hair), head (excluding hair), and hair. Never use horizontal-strip placeholders. Preserve identity, detail and colors; document inferred/occluded regions. Include mask overlays and dimensions in a JSON report. Do not silently fall back to an external image API or read API keys. If the required image tool is unavailable or usable images cannot be produced, return needs_input with the actual blocker.",
      generate: `Use the authenticated Tripo Studio browser tools to upload the separated ${stage.role} image and generate Smart Mesh P2. Use only ONE authorized charged submission in this stage attempt. Read the actual displayed cost before submitting; record Studio task identity and screenshot evidence, wait on the existing job, download the actual mesh. Never replace it with a local primitive or use a different model silently. Render/view multiple angles and preserve native format.`,
      review: `Inspect the actual ${stage.role} mesh using Blender and render front/back/side views. Compare front silhouette and identity against the input part, inspect missing surfaces, unwanted connected parts, mesh count, normals, holes, topology and bounds. Produce a review report with concrete measurements and images. If unacceptable, return rework naming the upstream stage; do not generate a new paid candidate yourself.`,
      uv: "Open the approved actual part model in Tripo Studio and use its UV workflow, recording the available feature and actual displayed cost. Submit at most one charged operation; download the resulting model and UV/map evidence. Check UV presence and overlap. Do not replace Studio UV with a local substitute.",
      texture:
        "Texture the UV-processed part in Tripo Studio using the original character reference and consistent color/material direction. Read displayed cost, submit at most once, download native model and maps. Verify texture files exist and render material consistency/missing maps. Do not claim local demo textures are Studio output.",
      assemble:
        "Use local Blender with real downloaded body/head/hair models. Inspect scale and proportions against the front reference; align parts, refine overlaps and neck/hair seams, preserve identity and native geometry. Write and execute task-specific bpy scripts as needed; render front/back/side comparisons. Report exact topology changes, normals, face counts, transforms, height and remaining defects. This stage is actual refinement, not just parenting three objects. Output editable .blend and portable .glb or .fbx.",
      "assembly-review":
        "Render and review the actual assembled model from front/back/side and at neck/hair seams. Compare identity/proportions with the front reference and inspect topology, normals, component boundaries, scale and orientation. If a correctable local defect exists request rework of assemble; if the generated part itself is wrong request its generate stage within the approved run credit and iteration limits. Never repeat an ambiguous submission. Output review renders and detailed evidence report.",
      "final-uv":
        "Because Blender refinement may change topology, perform final UV processing on the complete assembled mesh in Tripo Studio. This v1 workflow always rechecks final UV after assembly. Submit at most one authorized charged operation and download the actual final mesh/UV evidence. Never reuse old per-part UV as if final topology had been checked.",
      "final-texture":
        "In Tripo Studio texture the final UV-processed combined mesh with the original character reference. Submit at most one authorized charge. Download actual maps/model, render front/back/side, and review neck/hair color continuity, UV seams and missing maps. Preserve evidence and native result.",
      rig: "Use the verified Studio rigging workflow on the final textured combined character. Read cost and submit at most one charged operation, retaining task identity. Download real rigged model, inspect armature/weights with Blender, check shoulder/elbow/hip/knee test deformations and head-bound hair. Do not fabricate a placeholder rig or substitute the procedural demo. Return needs_input if a usable rig cannot be produced or inspected.",
      "view-reference": `Prepare a high-quality ${stage.role} view image of the SAME character from the original front reference, preserving identity, proportions, outfit, hair and colors. For front preserve/copy and inspect the original. For side/back use the built-in Codex image_gen/imagegen capability and applicable imagegen skill, not an external API fallback or a 3D render posing as a generated reference. Review viewpoint and identity and record the source hash. If the built-in tool is not actually available return needs_input.`,
      "animation-reference": `Use the built-in Codex image_gen/imagegen capability to create a coherent high-quality 2D ANIMATION IMAGE SEQUENCE for '${stage.motion}', viewed from ${stage.role}, using the actual corresponding character reference. Keep camera fixed, identity/scale consistent, and use the same explicitly described action phases and timestamps across front/side/back. For side/back, inspect the verified upstream front image sequence first and reproduce exactly its action phases and timestamps from the new view. The front sequence defines the shared timeline; do not independently choose timing. A contact sheet may be generated then split into ACTUAL individual frame image files. Produce at least 3 distinct phase frames with meaningful pose changes, not copies or a textual pose list. Video is OPTIONAL, not a requirement. Write sequence-manifest.json {view:'${stage.role}',camera:'fixed',motion:<description>,frames:[{path:<workspace-relative frame PNG>,sha256:<actual file hash>,time:<seconds>}]} with strictly increasing timestamps. Every frame must be returned as an image artifact. Visually inspect frame identity, pose and time correspondence; independently generated views are not assumed aligned. If image_gen is unavailable or frames cannot be made reliably, return needs_input. Do not use an external image/video API automatically.`,
      "motion-transfer": `You are running as the USER-REQUESTED Codex gpt-6-astra model. Read the actual front/side/back 2D ANIMATION IMAGE SEQUENCES for '${stage.motion}' and their timestamp/camera manifests. Use your visual reasoning to author and EXECUTE Blender bpy code that sets the REAL character rig poses, keyframes, interpolation and timing from those images; this is direct Codex Astra animation work, not a preset retarget or a video-provider requirement. Inspect all keyframes and matching multi-view renders, fix foot contacts, sliding and penetrations, and bake the action. Output the actual animated GLB/FBX, frame comparison renders, editable Blender work and evidence report. Write synchronized-reference-manifest.json {views:[{view:'front'|'side'|'back',sequenceManifestPath:<actual upstream path>,sha256:<upstream manifest hash>}],frameCorrespondence:[{time:<seconds>,frontPath:<actual frame>,sidePath:<actual frame>,backPath:<actual frame>}]} with at least 3 same-time correspondences. If identity/view/pose timing disagree, return needs_input or rework the offending animation-reference stage instead of pretending independent images synchronize. No Idle/Walk preset substitution, invented fixed poses, external API fallback, or completion without actual animation files. If Astra is unavailable, report the model failure without switching models.`,
      unity:
        "Combine all requested baked motion clips into the final real rigged character; export FBX/GLB and textures. Inspect the existing Unity Editor bridge at <unityPath>/Assets/PartsmithBridge/Editor/PartsmithBridge.cs and PartsmithPlayModeCheck.cs; follow its actual Library/PartsmithInbox request contract. If the bridge or Unity project is missing, return needs_input instead of inventing an API. Import into the configured managed Assets folder, preserving unrelated scenes/assets. Verify actual Humanoid Avatar validity, clips, materials and Play Mode playback; capture a rendered image and JSON evidence from Unity, not self-reported assumptions. If Unity is unavailable return needs_input. Preserve user-owned Prefab overrides.",
    };
    const dependencies = this.ancestors(run, stage).map((item) => ({
      id: item.id,
      summary: item.summary,
      artifacts: item.artifacts,
    }));
    return [
      "You are the real production worker for Partsmith, not a UI demo or a planning assistant. Complete ONLY the assigned stage and return the strict JSON result. Do actual tool work, inspect the outputs, and preserve evidence. Never claim success from a plan, screenshot of a button, or mocked result.",
      `Run: ${run.id}; stage: ${stage.id}; attempt: ${stage.attempt}/${run.config.maxIterations}. Brief: ${run.config.brief}`,
      `Workspace: ${run.workspace}. Output folder: ${folder}. All reported artifact paths MUST be workspace-relative and inside this exact output folder. Keep prior artifacts immutable.`,
      `Original front image: ${run.source.path}. Approved Studio run credit limit: ${run.config.studioCreditLimit}; video run credit limit: ${run.config.videoCreditLimit}. Confirmed-result quality rework is authorized only within these caps and maxIterations; each stage attempt permits one charge. Use the host's credit-gated browser action tool for EVERY charge. Never automate a paid action via shell/network/browser bypass. If price is unknown or exceeds remaining limit return needs_input. Never retry ambiguous remote submissions.`,
      `Tool services: ${JSON.stringify({ blenderPath: this.store.settings.blenderPath, unityPath: this.store.project(run.projectId).unityPath, unityEditorPath: this.store.settings.unityEditorPath, videoUrl: run.config.videoUrl ?? null })}. Do not read credential/auth files or API keys. Do not alter Codex/MCP configuration, sign out, or enable user-added integrations.`,
      `Upstream evidence: ${JSON.stringify(dependencies)}. Use the actual files, not their labels alone.`,
      instructions[stage.kind],
      `Completion requires artifact kinds: ${requiredKinds[stage.kind].join(", ")}; required checks exactly: ${stage.requiredChecks.join(", ")}. Each passed check must be substantiated in an output report. A false/missing check or missing/empty artifact prevents completion.`,
      "Pack all external textures into editable .blend outputs using bpy.ops.file.pack_all() before saving; also report every external texture image artifact required by native exports. Whenever model artifacts are required, include a real geometry GLB for host validation in addition to any native FBX/BLEND. Rig outputs need actual GLB skins and skinned nodes; animation/Unity outputs need real animation channels and samplers. For Studio stages also include the unchanged native downloaded model so its SHA matches the trusted host download journal.",
      "Return status completed only after actual execution and file validation. Use needs_input for login/captcha, missing connection, unsupported operation, uncertain charge, insufficient credits, or missing material. Use rework with a valid upstream reworkStageId for quality failure. Rework is bounded by the approved run credit cap and maxIterations; confirmed results may be regenerated in a new host-controlled attempt. Never spend twice inside this attempt or repeat an ambiguous submission. Keep summary factual and distinguish observed results from uncertainty.",
    ].join("\n\n");
  }
  private async execute(runId: string, controller: AbortController) {
    try {
      while (!controller.signal.aborted) {
        let run = this.get(runId);
        if (run.status !== "running") return;
        const stage = run.stages.find(
          (item) =>
            ["pending", "invalidated"].includes(item.status) &&
            item.dependsOn.every(
              (id) =>
                run.stages.find((dependency) => dependency.id === id)
                  ?.status === "completed",
            ),
        );
        if (!stage) {
          run.status = run.stages.every((item) => item.status === "completed")
            ? "completed"
            : "needs_input";
          run.activeStageId = undefined;
          run.message =
            run.status === "completed"
              ? "모든 단계의 실제 파일과 품질 검사 결과를 확인했습니다."
              : "완료되지 않은 선행 단계가 있어 진행을 멈췄습니다.";
          this.save(run);
          return;
        }
        if (this.store.project(run.projectId).revision !== run.projectRevision)
          throw new Error(
            "입력 프로젝트 버전이 변경되어 자동 진행을 중지했습니다.",
          );
        if (
          digest(fs.readFileSync(within(run.workspace, run.source.path))) !==
          run.source.sha256
        )
          throw new Error(
            "승인한 정면 이미지가 실행 중 변경되어 자동 진행을 중지했습니다.",
          );
        for (const ancestor of this.ancestors(run, stage))
          for (const artifact of ancestor.artifacts)
            if (
              !fs.existsSync(within(run.workspace, artifact.path)) ||
              digest(fs.readFileSync(within(run.workspace, artifact.path))) !==
                artifact.sha256
            )
              throw new Error(
                "검증한 선행 산출물이 변경됐습니다. 새 계획 또는 명시적 재검수가 필요합니다.",
              );
        if (stage.attempt >= run.config.maxIterations) {
          stage.status = "failed";
          stage.summary = "허용한 최대 검수·수정 횟수에 도달했습니다.";
          run.status = "needs_input";
          run.message = stage.summary;
          this.save(run);
          return;
        }
        const probe = await this.worker.probe();
        if (controller.signal.aborted) return;
        if (
          !probe.codex.available ||
          !probe.codex.authenticated ||
          (stage.capability && !probe.capabilities[stage.capability]) ||
          (stage.charged &&
            (stage.capability === "video"
              ? run.config.videoCreditLimit
              : run.config.studioCreditLimit) <= 0)
        ) {
          stage.status = "needs_input";
          stage.summary =
            !probe.codex.available || !probe.codex.authenticated
              ? probe.codex.message
              : stage.charged &&
                  (stage.capability === "video"
                    ? run.config.videoCreditLimit
                    : run.config.studioCreditLimit) <= 0
                ? "이 단계의 유료 실행 한도가 0입니다. 비용 범위를 승인한 새 계획이 필요합니다."
                : `${stage.capability} 연결 또는 로그인이 필요합니다. 실제 작업이 실행되지 않았습니다.`;
          run.status = "needs_input";
          run.activeStageId = stage.id;
          run.message = stage.summary;
          this.save(run);
          return;
        }
        if (
          stage.charged &&
          !this.worker.stageReceipt?.(run.id, stage.id, stage.attempt + 1)
        )
          throw new Error(
            "Studio 호스트 실행·다운로드 증거 연결이 없어 유료 실행을 시작하지 않았습니다.",
          );
        const allowedWritePaths = this.allowedWritePaths(run, stage);
        stage.attempt++;
        stage.status = "running";
        stage.startedAt = now();
        stage.summary = "Codex가 실제 도구 작업과 산출물 검증을 실행 중입니다.";
        run.activeStageId = stage.id;
        run.message = stage.title;
        this.save(run);
        const folder = `stages/${stage.id}/attempt-${stage.attempt}`,
          absolute = within(run.workspace, folder);
        fs.mkdirSync(absolute, { recursive: true });
        const schemaPath = path.join(absolute, "result.schema.json"),
          resultPath = path.join(absolute, "result.json");
        fs.writeFileSync(
          schemaPath,
          JSON.stringify(stageResultJsonSchema, null, 2),
        );
        const prompt = this.prompt(run, stage, folder);
        fs.writeFileSync(path.join(absolute, "instructions.txt"), prompt);
        let response;
        try {
          response = await this.worker.run({
            run,
            stage,
            prompt,
            imagePaths: this.workerImages(run, stage),
            allowedWritePaths,
            schemaPath,
            resultPath,
            signal: controller.signal,
            onEvent: (event) => {
              if (controller.signal.aborted) return;
              const current = this.get(runId),
                live = current.stages.find((item) => item.id === stage.id)!;
              if (event.threadId) live.threadId = event.threadId;
              if (event.message) live.summary = event.message.slice(0, 2000);
              this.save(current);
            },
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          run = this.get(runId);
          const live = run.stages.find((item) => item.id === stage.id)!;
          live.status = "needs_input";
          live.remoteAmbiguous = this.ambiguous(run, live);
          live.summary =
            error instanceof Error ? error.message : "작업자 실행 실패";
          run.status = "needs_input";
          run.message = live.summary;
          this.save(run);
          return;
        }
        if (controller.signal.aborted) return;
        run = this.get(runId);
        const live = run.stages.find((item) => item.id === stage.id)!;
        let result: StageResult;
        try {
          result = resultSchema.parse(response.result);
          live.result = result;
          live.summary = result.summary;
          live.threadId = response.threadId ?? live.threadId;
          live.finishedAt = now();
          if (result.status === "completed") {
            live.artifacts = this.verifyArtifacts(run, live, result);
            live.status = "completed";
            this.save(run);
            continue;
          }
        } catch (error) {
          live.status = "needs_input";
          live.remoteAmbiguous = this.ambiguous(run, live);
          live.summary = `완료 증거 검증 실패: ${error instanceof Error ? error.message : "잘못된 결과"}`;
          run.status = "needs_input";
          run.message = live.summary;
          this.save(run);
          return;
        }
        if (result.status === "rework") {
          if (live.charged && this.ambiguous(run, live)) {
            const receipt = this.worker.stageReceipt?.(
              run.id,
              live.id,
              live.attempt,
            );
            const completedDownload = receipt?.downloads.some((download) => {
              try {
                return (
                  download.state === "completed" &&
                  digest(
                    fs.readFileSync(within(run.workspace, download.file)),
                  ) === download.sha256
                );
              } catch {
                return false;
              }
            });
            if (!completedDownload) {
              live.status = "needs_input";
              live.remoteAmbiguous = true;
              run.status = "needs_input";
              run.message =
                "원격 단계 완료가 확인되지 않아 재작업을 재제출하지 않습니다. Studio 작업 기록을 확인하세요.";
              this.save(run);
              return;
            }
          }
          const allowed = this.ancestors(run, live),
            target = allowed.find((item) => item.id === result.reworkStageId);
          if (!target) {
            live.status = "needs_input";
            run.status = "needs_input";
            run.message = "잘못된 재작업 대상입니다. 검수 결과를 확인하세요.";
            this.save(run);
            return;
          }
          const affected = new Set([target.id]);
          let changed = true;
          while (changed) {
            changed = false;
            for (const item of run.stages)
              if (
                !affected.has(item.id) &&
                item.dependsOn.some((id) => affected.has(id))
              ) {
                affected.add(item.id);
                changed = true;
              }
          }
          for (const item of run.stages.filter((item) =>
            affected.has(item.id),
          )) {
            item.status = "invalidated";
            item.artifacts = [];
          }
          if (target.attempt >= run.config.maxIterations) {
            target.status = "failed";
            run.status = "needs_input";
            run.message = "최대 검수·수정 횟수에 도달했습니다.";
          } else {
            run.message = `${target.title} 단계부터 검수 지적 사항을 자동 수정합니다.`;
          }
          this.save(run);
          if (run.status !== "running") return;
          continue;
        }
        live.status = "needs_input";
        live.remoteAmbiguous = this.ambiguous(run, live);
        run.status = "needs_input";
        run.message = result.summary;
        this.save(run);
        return;
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const run = this.get(runId);
      run.status = "needs_input";
      run.message =
        error instanceof Error ? error.message : "자동 제작 실행 오류";
      this.save(run);
    }
  }
}
