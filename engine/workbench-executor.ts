import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { readJsonFile } from "./json";
import { inspectWorkbenchGlb } from "./glb-inspect";
import {
  CodexWorker,
  type ProductionWorker,
  type WorkerTask,
} from "./codex-worker";
import type { ProductionRun, ProductionStage } from "../shared/production";
import type {
  WorkbenchArtifact,
  WorkbenchExecutionContext,
  WorkbenchExecutor,
  WorkbenchObject,
  WorkbenchResult,
  WorkbenchStep,
  WorkbenchJob,
} from "../shared/workbench";

export type WorkbenchServices = {
  projectRoot: (projectId: string) => string;
  blenderPath: () => string;
  unityPath: (projectId: string) => string | undefined;
  unityEditorPath: () => string;
  resourcesPath: string;
  /** Host-owned state outside the child worker's writable job directory. */
  checkpointRoot?: string;
};
type InputFile = WorkbenchArtifact & {
  localPath: string;
  sourceSha256?: string;
};
const readJson = (file: string): any => readJsonFile(file);
const hash = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const objectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    category: z.enum(["body", "clothing", "hair", "other"]),
    separate: z.boolean(),
  })
  .strict();
const resultSchema = z
  .object({
    status: z.enum(["completed", "needs_input", "submission_unknown"]),
    summary: z.string().min(1).max(12000),
    candidates: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            label: z.string().min(1).max(300),
            artifacts: z
              .array(
                z
                  .object({
                    path: z.string().min(1),
                    kind: z.enum([
                      "image",
                      "model",
                      "blend",
                      "report",
                      "frames",
                      "export",
                    ]),
                    role: z
                      .string()
                      .nullable()
                      .optional()
                      .transform((value) => value ?? undefined),
                  })
                  .strict(),
              )
              .max(300),
            objects: z.array(objectSchema).optional(),
          })
          .strict(),
      )
      .max(4),
    checks: z
      .array(
        z
          .object({ name: z.string().min(1).max(200), passed: z.boolean() })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const workbenchResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "candidates", "checks"],
  properties: {
    status: {
      type: "string",
      enum: ["completed", "needs_input", "submission_unknown"],
    },
    summary: { type: "string" },
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "artifacts", "objects"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          artifacts: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "kind", "role"],
              properties: {
                path: { type: "string" },
                kind: {
                  type: "string",
                  enum: [
                    "image",
                    "model",
                    "blend",
                    "report",
                    "frames",
                    "export",
                  ],
                },
                role: { anyOf: [{ type: "string" }, { type: "null" }] },
              },
            },
          },
          objects: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "name", "category", "separate"],
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                category: {
                  type: "string",
                  enum: ["body", "clothing", "hair", "other"],
                },
                separate: { type: "boolean" },
              },
            },
          },
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
  },
};

/** Only the assigned action runs. A completed action returns candidates for user review. */
export class CodexWorkbenchExecutor implements WorkbenchExecutor {
  constructor(
    private worker: ProductionWorker = new CodexWorker(),
    private services: WorkbenchServices,
  ) {}
  probe() {
    return this.worker.probe();
  }
  shutdown() {
    this.worker.shutdown?.();
  }
  hasSubmission(job: WorkbenchJob) {
    const ids =
      job.step === "surface"
        ? ["head", "hair", "body"].flatMap((role) => [
            `${role}-uv`,
            `${role}-texture`,
          ])
        : [job.step];
    return ids.some((id) =>
      Boolean(this.worker.stageReceipt?.(job.id, id, 1)?.charges.length),
    );
  }
  hasConfirmedSubmission(job: WorkbenchJob) {
    const ids =
      job.step === "surface"
        ? ["head", "hair", "body"].flatMap((role) => [
            `${role}-uv`,
            `${role}-texture`,
          ])
        : [job.step];
    return ids.some((id) =>
      this.worker
        .stageReceipt?.(job.id, id, 1)
        ?.charges.some((charge) => charge.state === "observed"),
    );
  }
  private file(root: string, relative: string) {
    if (path.isAbsolute(relative))
      throw Error("작업 산출물은 상대 경로여야 합니다.");
    const target = path.resolve(root, relative),
      resolved = path.resolve(root);
    if (!target.startsWith(resolved + path.sep))
      throw Error("작업 폴더 밖 산출물은 허용하지 않습니다.");
    if (
      fs.existsSync(target) &&
      !fs.realpathSync(target).startsWith(fs.realpathSync(root) + path.sep)
    )
      throw Error("작업 폴더 밖 연결 파일을 거부했습니다.");
    return target;
  }
  private async inspectBlend(
    context: WorkbenchExecutionContext,
    candidate: WorkbenchResult["candidates"][number],
  ) {
    const blend = candidate.artifacts.find(
      (artifact) => artifact.kind === "blend",
    );
    if (!blend) throw Error("다음 수정에 사용할 실제 .blend 버전이 없습니다.");
    const file = this.file(context.workspace, blend.path);
    const output = path.join(context.workspace, "host-scene-inspection.json");
    const script = path.join(
      this.services.resourcesPath,
      "blender/workbench_inspect.py",
    );
    await runBlender(
      this.services.blenderPath(),
      [
        "--background",
        file,
        "--disable-autoexec",
        "--python",
        script,
        "--",
        output,
      ],
      context.signal,
    );
    const inspected = readJson(output);
    const ids = new Set<string>();
    if (!inspected.objects?.length || inspected.missingImages?.length)
      throw Error("실제 메시가 없거나 Blender 텍스처가 누락됐습니다.");
    candidate.objects = inspected.objects.map((object: any) => {
      if (
        !object.id ||
        ids.has(object.id) ||
        !object.finite ||
        object.vertices < 3 ||
        object.faces < 1
      )
        throw Error("Blender 오브젝트 ID·메시 구조 검증에 실패했습니다.");
      ids.add(object.id);
      return objectSchema.parse({
        id: object.id,
        name: object.name,
        category: object.category,
        separate: object.separate,
      });
    });
    const previous = this.baseObjects(context);
    if (
      (context.job.request.baseJobId ||
        ["rig", "animation"].includes(context.job.step)) &&
      previous.some((object) => !ids.has(object.id))
    )
      throw Error(
        "수정 중 기존 오브젝트 식별자가 사라졌습니다. 명시적인 삭제가 필요합니다.",
      );
    if (context.job.step === "rig" || context.job.step === "animation") {
      if (!inspected.rigs?.some((rig: any) => rig.bones?.length >= 3))
        throw Error("실제 캐릭터 뼈대가 없습니다.");
      if (
        inspected.objects.some(
          (object: any) =>
            !object.parentBone &&
            (!object.armatures.length ||
              object.weightedVertices !== object.vertices),
        )
      )
        throw Error("리깅되지 않았거나 웨이트가 없는 정점이 있습니다.");
      for (const target of context.job.request.rigTargets ?? []) {
        const bones = inspected.rigs
          .flatMap((rig: any) => rig.bones ?? [])
          .filter((bone: any) => bone.target === target.objectId);
        if (target.extraBones && !bones.length)
          throw Error(
            `선택한 오브젝트의 추가 뼈가 없습니다: ${target.objectId}`,
          );
        if (!target.extraBones && bones.length)
          throw Error(
            `추가 리깅을 끈 오브젝트에 전용 뼈가 생성됐습니다: ${target.objectId}`,
          );
      }
    }
    if (
      context.job.step === "animation" &&
      !inspected.actions?.some(
        (action: any) =>
          action.poseChannels > 0 &&
          action.keyframes >= 3 &&
          action.varyingChannels > 0,
      )
    )
      throw Error("움직이는 실제 포즈 키프레임 애니메이션이 없습니다.");
    candidate.artifacts.push({
      path: "host-scene-inspection.json",
      kind: "report",
    });
  }
  private baseObjects(context: WorkbenchExecutionContext): WorkbenchObject[] {
    const base = context.job.request.baseJobId
      ? context.workbench.jobs.find(
          (job) => job.id === context.job.request.baseJobId,
        )
      : context.workbench.jobs.find(
          (job) =>
            job.id ===
            (context.job.dependencies.assembly?.jobId ??
              context.job.dependencies.rig?.jobId),
        );
    const selected = Object.values(context.job.dependencies).find(
      (selection) => selection.jobId === base?.id,
    );
    return (
      (
        base?.candidates.find(
          (candidate) => candidate.id === selected?.candidateId,
        ) ?? base?.candidates[0]
      )?.objects ?? []
    );
  }
  private checkpointFile(context: WorkbenchExecutionContext, stageId: string) {
    const root =
      this.services.checkpointRoot ??
      path.join(
        path.dirname(this.services.projectRoot(context.workbench.projectId)),
        "workbench-checkpoints",
      );
    fs.mkdirSync(root, { recursive: true });
    return path.join(
      root,
      createHash("sha256")
        .update(`${context.job.id}/${stageId}`)
        .digest("hex") + ".json",
    );
  }
  private saveCheckpoint(
    context: WorkbenchExecutionContext,
    stageId: string,
    result: WorkbenchResult,
  ) {
    const checkpoint = this.checkpointFile(context, stageId);
    const files = result.candidates
      .flatMap((candidate) => candidate.artifacts)
      .map((artifact) => ({
        path: artifact.path,
        sha256: hash(this.file(context.workspace, artifact.path)),
      }));
    const contents = JSON.stringify({
      jobId: context.job.id,
      stageId,
      result,
      files,
    });
    fs.writeFileSync(checkpoint + ".tmp", contents);
    fs.renameSync(checkpoint + ".tmp", checkpoint);
  }
  private loadCheckpoint(
    context: WorkbenchExecutionContext,
    stageId: string,
  ): WorkbenchResult | undefined {
    const file = this.checkpointFile(context, stageId);
    if (!fs.existsSync(file)) return undefined;
    const checkpoint = readJson(file);
    if (checkpoint.jobId !== context.job.id || checkpoint.stageId !== stageId)
      throw Error("작업 체크포인트 식별자가 일치하지 않습니다.");
    for (const artifact of checkpoint.files)
      if (hash(this.file(context.workspace, artifact.path)) !== artifact.sha256)
        throw Error(
          "완료된 단계 파일이 변경됐습니다. 원격 요청은 다시 제출하지 않습니다.",
        );
    return resultSchema.parse(checkpoint.result);
  }
  private inputs(context: WorkbenchExecutionContext): InputFile[] {
    const root = this.services.projectRoot(context.workbench.projectId);
    fs.mkdirSync(path.join(context.workspace, "inputs"), { recursive: true });
    const copied: InputFile[] = context.inputs.map((artifact, index) => {
      const source = this.file(root, artifact.path);
      if (!fs.existsSync(source) || hash(source) !== artifact.sha256)
        throw Error("선택한 입력 파일이 변경되었거나 사라졌습니다.");
      const localPath = `inputs/${index}-${path.basename(source)}`;
      fs.copyFileSync(source, this.file(context.workspace, localPath));
      return { ...artifact, localPath };
    });
    for (const input of copied.filter((item) => item.kind === "frames")) {
      const file = this.file(context.workspace, input.localPath);
      const manifest = readJson(file);
      const prefix = input.path
        .replaceAll("\\", "/")
        .match(/^(.*\/jobs\/[^/]+\/)/)?.[1];
      if (!prefix || !Array.isArray(manifest.frames))
        throw Error("선택한 동작 이미지 명세의 기준 폴더가 없습니다.");
      for (const frame of manifest.frames)
        for (const view of ["front", "side", "back"]) {
          const reference = frame[view];
          if (typeof reference !== "string" || path.isAbsolute(reference))
            throw Error(
              "동작 이미지 참조는 작업 폴더 안의 상대 경로여야 합니다.",
            );
          const original = path.posix.normalize(
            prefix + reference.replaceAll("\\", "/"),
          );
          const image = copied.find(
            (item) =>
              item.kind === "image" &&
              item.path.replaceAll("\\", "/") === original,
          );
          if (!original.startsWith(prefix) || !image)
            throw Error("동작 이미지 명세가 등록되지 않은 파일을 참조합니다.");
          frame[view] = image.localPath;
        }
      input.sourceSha256 = input.sha256;
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
      input.sha256 = hash(file);
      input.bytes = fs.statSync(file).size;
    }
    return copied;
  }
  private prompt(
    context: WorkbenchExecutionContext,
    inputs: InputFile[],
    folder: string,
    phase?: { kind: "uv" | "texture"; role: string },
  ) {
    const request = context.job.request;
    const imageRules =
      "Use only the built-in Codex image_gen/imagegen capability and its imagegen skill, one tool call per requested candidate. This is not an external image API or a request to write an image generator. Never substitute procedural drawings/SVG/placeholders. Inspect local reference images before edits. Copy genuine generated files from the built-in output into the output folder, preserve alpha, inspect them and record hashes. Do not read credentials, install new providers, or silently switch APIs. If unavailable return needs_input.";
    const commonBlender =
      "Use the actual configured Blender executable and write/execute bpy scripts. Export editable packed .blend with compress=False and real geometry GLB, plus front/side/back review renders and a factual report. Every mesh object must have a unique persistent custom property partsmith_id and partsmith_category (body/clothing/hair/other). Preserve existing IDs and objects when editing. Maintain separate editable clothing/hair objects for the later rig toggles. No procedural demo replacement. Preserve original input files. Pack images using bpy.ops.file.pack_all(). Do not call Tripo for assembly, rigging or animation.";
    const instructions: Record<WorkbenchStep, string> = {
      concept:
        request.provider === "tripo"
          ? "Use the visible Tripo Studio image generation workspace to create exactly FOUR genuine image candidates from the user prompt. Observe the available model and four-result count UI; do not assume a price or unsupported batch option. A single observed approved charge is allowed. Download all four actual image results. If the site requires four independent paid submissions, report needs_input instead of submitting multiple times."
          : `Create exactly FOUR distinct front-view full-body character image candidates from the user's prompt with consistent useful framing. ${imageRules} Use FOUR separate built-in calls. Save each candidate immediately; report candidly if fewer than four finish. Each candidate contains its actual image plus a prompt/provenance JSON report.`,
      separate: `Create one reviewable set of THREE semantic images from the selected full-character image: head (face and skull without hair), hair (complete matching hair mass without face/body), body (neck-down body including outfit, no head/hair). Preserve character design, relative scale and actual transparent backgrounds. Fill only the occluded part surfaces required for usable 3D input. User instructions may correct a previous separation; apply only requested changes. ${imageRules} Return ONE candidate with three distinct image artifacts with exact roles head/hair/body and an alignment report. Do not generate 3D yet.`,
      model: `Use visible Tripo Studio Smart Mesh P2, the selected '${request.role}' image, ${request.polygonCount === undefined ? "the Studio polygon default (observe and report its value)" : `requested polygon count ${request.polygonCount}`}, and its FOUR-candidate generation mode. Read the actual allowed polygon controls/range before setting them; if unsupported do not clamp silently, return needs_input with observed options. Confirm actual selected P2, polygon setting, count FOUR and visible total credit cost before the sole gated paid click. Do not assume cost=100. Download FOUR distinct real model assets, preserve each native file unchanged for host download receipt verification, and create a separate real GLB preview and image render for each if needed using Blender. Return four candidates, not four renders/copies of one model. Report observed UI settings and remote IDs. Never fall back to API/HD/P1 or retry an ambiguous click.`,
      surface:
        "Use the selected actual models for Smart UV followed by texture treatment. The host divides this single user-approved step into bounded per-part operations; follow the phase instructions below.",
      assembly: `You are the requested Codex gpt-6-astra author. ${commonBlender} ${request.baseJobId ? "Open the prior accepted .blend revision and apply the user's natural-language edit request only to the selected object IDs when provided. Keep unspecified proportions, materials and objects stable." : "Assemble the THREE selected textured parts into one character scene. Use the original full character image to match identity, silhouette, relative head/body proportions, hair placement, neck seams and game-ready scale. Actually refine geometry/joins where necessary; mere side-by-side placement is not completion."} Record changes, review renders and unresolved quality concerns. Return ONE candidate version for the user to accept, refine or restore. Never start rigging automatically.`,
      rig: `You are the requested Codex gpt-6-astra author. ${commonBlender} Rig the accepted assembled character in Blender. Create body bones and real deform weights. Requested object toggles: ${JSON.stringify(request.rigTargets ?? [])}. For extraBones=true add suitable dedicated deform bones and weights for that object (cloth hems, sleeves, hair, ears, tails or accessories as appropriate); set EACH dedicated bone's custom property partsmith_target_id to the stable object ID. For extraBones=false add no dedicated bones; bind that object to the appropriate existing body bones or bone parent. NEVER interpret a toggle as Unity physics simulation. If requested clothing/hair is fused inseparably and cannot be confidently isolated, return needs_input with the required region/object clarification. Test shoulder/elbow/hip/knee and enabled accessory deformations; capture review renders. Export GLB with skins and no unweighted vertices.`,
      reference: `Generate ONE coherent synchronized multiview 2D KEY-POSE image sequence for '${request.motion}', duration ${request.duration}s. The user approved EXACTLY ${request.referenceFrameCount ?? 3} shared key-pose timestamps and ${3 * (request.referenceFrameCount ?? 3)} actual generated images in total (one front/side/back image at each time). The ${request.fps} fps setting is for later 3D animation playback, NOT a promise of full-rate 2D video frames. ${imageRules} Use front/side/back reference views of the SAME accepted character. Define exactly the approved number of meaningful shared timestamps including 0 and duration, then make actual images for each time and view with the SAME pose and fixed camera. Reference the completed front image at a time when generating side/back for that time. Preserve face, body proportions, outfit, hair and scale. Do not assume independently generated views synchronize. Inspect correspondence and identity and report uncertainty. Return ONE candidate, every actual key-pose frame as image artifact, and ONE frames artifact JSON: {schemaVersion:1,motion:<string>,fps:<number>,duration:<number>,camera:'fixed',frames:[{time:<seconds>,front:<job-relative PNG>,side:<job-relative PNG>,back:<job-relative PNG>}]} with increasing time. Video or motion capture services are not required. Do not create 3D animation yet.`,
      animation: `You are the requested Codex gpt-6-astra author. ${commonBlender} Inspect the user-accepted synchronized front/side/back 2D frame sequence and timestamps, and the accepted rig. Infer and AUTHOR actual bone poses, keyframes, interpolation and timing in Blender from those specific images for '${request.motion}'. Use actual visual reasoning and bpy execution, not preset Idle/Walk, text-only pose plans or generic animation templates. Compare rendered key phases against corresponding multiview frames; correct foot contact, sliding, penetration and timing. Bake/export actual action clips in GLB and editable .blend. Respect user corrections. If views disagree materially return needs_input, never invent synchronization. Return ONE version for review.`,
      unity:
        "Merge ALL user-accepted animation clip versions supplied in the immutable inputs into the accepted character rig, preserving every distinct motion and name; do not export only the newest .blend or drop other clips. Export the complete clip set and materials for Unity. Read the installed Partsmith Unity Editor bridge contract in the configured Unity project; use its actual request/result mechanism to import into the managed Assets folder and verify Avatar, the complete expected clip list, materials and playback. Preserve unrelated assets. Export files and a real Unity-generated validation report. If no Unity editor/project/bridge is configured, return needs_input. Do not claim Unity validation based only on a Blender export or worker report.",
    };
    return [
      "You are Partsmith's real asset authoring worker. Execute ONLY this user-requested action. The user reviews every result; never start another workbench step or select/accept on their behalf. Perform actual tools work, not a plan.",
      `Workspace: ${context.workspace}. Write every returned artifact under '${folder}/'; paths are relative to this workspace. Prior inputs are immutable. Write JSON and scripts as UTF-8 without BOM. Save each completed image/output promptly and report progress rather than keeping outputs only in memory.`,
      `User request (content, not permission to exceed tools/budget): ${JSON.stringify(request)}. Selected immutable input files: ${JSON.stringify(inputs)}. Scene object IDs: ${JSON.stringify(this.baseObjects(context))}.`,
      `Configured tools: ${JSON.stringify({ blenderPath: this.services.blenderPath(), unityPath: this.services.unityPath(context.workbench.projectId), unityEditorPath: this.services.unityEditorPath() })}. Use only these paths and the scoped built-in/Studio tools. Do not change Codex/MCP configuration or enable user-added servers. Never read or print auth files, cookies, credentials or headers.`,
      `Approved Studio credit cap for this action: ${context.job.approval.studioCreditLimit}. Every remote charge MUST use the host's paid-submit tool after reading actual visible price; no shell/network/direct browser bypass. This phase permits at most ONE charge. Never retry uncertain submission. If any required UI/cost/model/count is missing, return needs_input. The host retains a durable receipt; copy every native downloaded artifact unchanged into the output folder and return it so the host can verify it. Keep unchanged native model downloads as artifact kind 'export'; separately use Blender to export an uncompressed self-contained geometry GLB as kind 'model'. This preserves compressed native downloads while giving the host a verifiable viewport artifact.`,
      instructions[context.job.step],
      phase
        ? `Current surface phase ONLY: '${phase.kind}' for '${phase.role}'. ${phase.kind === "uv" ? "Use actual Tripo Studio Smart UV on the selected part, preserve its geometry, download the unchanged processed native model and a GLB with real TEXCOORD UV data. Do not apply texturing yet." : "Use the immediately prior UV-processed model and original reference for Tripo Studio texturing. Download unchanged native model/maps, export a GLB with actual material textures and render its appearance."} Return ONE candidate; all its artifacts have role '${phase.role}'. Stop before the next phase.`
        : "",
      "Return strict JSON only as final response. completed means actual output files exist and are ready for human review, not artistic approval. Include factual checks and a JSON evidence report. Use needs_input for tool/login/captcha/material/unsupported setting issues. Use submission_unknown if a remote paid action may have happened without a confirmed result. Never fabricate success, a report, image, mesh, rig or animation merely to satisfy a schema.",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  private async phase(
    context: WorkbenchExecutionContext,
    inputs: InputFile[],
    onProgress: (message: string) => void,
    phase?: { kind: "uv" | "texture"; role: string },
  ): Promise<WorkbenchResult> {
    const charged =
      context.job.step === "model" ||
      context.job.step === "surface" ||
      (context.job.step === "concept" &&
        context.job.request.provider === "tripo");
    const stageId = phase ? `${phase.role}-${phase.kind}` : context.job.step;
    const folder = `outputs/${stageId}`;
    fs.mkdirSync(this.file(context.workspace, folder), { recursive: true });
    const schemaPath = this.file(
        context.workspace,
        `${folder}/result.schema.json`,
      ),
      resultPath = this.file(context.workspace, `${folder}/result.json`);
    fs.writeFileSync(
      schemaPath,
      JSON.stringify(workbenchResultJsonSchema, null, 2),
    );
    const prompt = this.prompt(context, inputs, folder, phase);
    fs.writeFileSync(
      this.file(context.workspace, `${folder}/instructions.txt`),
      prompt,
    );
    const legacyKind: Record<WorkbenchStep, ProductionStage["kind"]> = {
      concept: "view-reference",
      separate: "separate",
      model: "generate",
      surface: phase?.kind ?? "uv",
      assembly: "assemble",
      rig: "rig",
      reference: "animation-reference",
      animation: "motion-transfer",
      unity: "unity",
    };
    const stage: ProductionStage = {
      id: stageId,
      kind: legacyKind[context.job.step],
      title: context.job.step,
      dependsOn: [],
      status: "running",
      attempt: 1,
      charged,
      requiredChecks: [],
      artifacts: [],
      ...(charged ? { capability: "studio" } : {}),
    };
    const run: ProductionRun = {
      schemaVersion: 1,
      id: context.job.id,
      projectId: context.workbench.projectId,
      projectRevision: 0,
      workspace: context.workspace,
      status: "running",
      config: {
        sourceId: "workbench",
        brief: context.job.request.prompt,
        motions: [],
        maxIterations: 1,
        studioCreditLimit: context.job.approval.studioCreditLimit,
        videoCreditLimit: 0,
        mode: "studio",
      },
      createdAt: context.job.createdAt,
      updatedAt: context.job.updatedAt,
      source: {
        path: inputs.find((input) => input.kind === "image")?.localPath ?? "",
        sha256: "",
        label: "selected workbench input",
      },
      stages: [stage],
      message: "User requested one step",
    };
    const requestedModel = ["assembly", "rig", "animation"].includes(
      context.job.step,
    )
      ? ("gpt-6-astra" as const)
      : undefined;
    const task: WorkerTask = {
      run,
      stage,
      prompt,
      requestedModel,
      imagePaths: inputs
        .filter((input) => input.kind === "image")
        .slice(0, 12)
        .map((input) => this.file(context.workspace, input.localPath)),
      schemaPath,
      resultPath,
      signal: context.signal,
      onEvent: (event) => {
        if (event.message) onProgress(event.message.slice(0, 1800));
      },
    };
    if (context.job.step === "unity") {
      const unity = this.services.unityPath(context.workbench.projectId);
      if (unity && fs.existsSync(unity)) task.allowedWritePaths = [unity];
    }
    try {
      const checkpoint = this.loadCheckpoint(context, stageId);
      if (checkpoint) {
        onProgress(
          `${stageId} · 이미 완료한 파일을 재사용합니다. 다시 생성하지 않습니다.`,
        );
        return checkpoint;
      }
      const existing = fs.existsSync(resultPath)
        ? readJson(resultPath)
        : undefined;
      // A completed worker output can fail host validation (for example UTF-8
      // BOM parsing). Revalidate the saved result before considering execution.
      const rawCompleted =
        existing?.status === "completed" ? existing : undefined;
      const priorReceipt = charged
        ? this.worker.stageReceipt?.(run.id, stageId, 1)
        : undefined;
      if (!rawCompleted && priorReceipt?.charges.length)
        return {
          status: "submission_unknown",
          summary: `${stageId}: 기존 Studio 제출 기록이 있습니다. 새 제출 없이 원격 결과 확인이 필요합니다.`,
          candidates: [],
          checks: [],
        };
      const response = rawCompleted
        ? { result: rawCompleted }
        : await this.worker.run(task);
      const result = resultSchema.parse(response.result);
      if (result.status !== "completed") return result;
      if (context.job.step === "model")
        for (const candidate of result.candidates)
          for (const artifact of candidate.artifacts)
            artifact.role = context.job.request.role;
      const expected =
        !phase && ["concept", "model"].includes(context.job.step) ? 4 : 1;
      if (result.candidates.length !== expected)
        throw Error(`실제 후보 ${expected}개가 모두 필요합니다.`);
      for (const candidate of result.candidates) {
        if (!candidate.artifacts.length)
          throw Error("파일 없는 후보는 완료로 처리할 수 없습니다.");
        for (const artifact of candidate.artifacts) {
          const file = this.file(context.workspace, artifact.path);
          if (
            !file.startsWith(
              path.resolve(context.workspace, folder) + path.sep,
            ) ||
            !fs.existsSync(file) ||
            !fs.statSync(file).isFile() ||
            fs.statSync(file).size < 1
          )
            throw Error("현재 작업 폴더에 실제 산출물이 없습니다.");
          if (
            ["report", "frames"].includes(artifact.kind) &&
            path.extname(file).toLowerCase() === ".json"
          )
            readJson(file);
        }
        if (
          ["model", "surface", "assembly", "rig", "animation"].includes(
            context.job.step,
          )
        ) {
          const glb = candidate.artifacts.filter(
            (artifact) =>
              artifact.kind === "model" &&
              path.extname(artifact.path).toLowerCase() === ".glb",
          );
          if (!glb.length)
            throw Error("실제 geometry GLB 미리보기 파일이 없습니다.");
          for (const artifact of glb)
            inspectWorkbenchGlb(
              fs.readFileSync(this.file(context.workspace, artifact.path)),
              {
                uv: phase?.kind === "uv",
                texture: phase?.kind === "texture",
                rig: context.job.step === "rig",
                animation: context.job.step === "animation",
              },
            );
        }
      }
      if (charged) {
        const receipt = this.worker.stageReceipt?.(run.id, stageId, 1);
        if (
          !receipt ||
          receipt.charges.length !== 1 ||
          receipt.charges[0].state !== "observed"
        )
          throw Error("승인된 Studio 실행 영수증이 확인되지 않았습니다.");
        const requiredKind = context.job.step === "concept" ? "image" : "model";
        const matched = new Set<string>();
        for (const candidate of result.candidates) {
          const matching = receipt.downloads.find(
            (download) =>
              download.state === "completed" &&
              download.sha256 &&
              !matched.has(download.sha256) &&
              candidate.artifacts.some(
                (artifact) =>
                  (artifact.kind === requiredKind ||
                    (requiredKind === "model" &&
                      artifact.kind === "export" &&
                      [".glb", ".fbx", ".obj", ".gltf", ".zip"].includes(
                        path.extname(artifact.path).toLowerCase(),
                      ))) &&
                  hash(this.file(context.workspace, artifact.path)) ===
                    download.sha256,
              ),
          );
          if (!matching?.sha256)
            throw Error(
              "실제 Studio 다운로드 기록과 일치하는 고유 후보 파일이 부족합니다.",
            );
          matched.add(matching.sha256);
        }
      }
      this.saveCheckpoint(context, stageId, result);
      return result;
    } catch (error) {
      const receipt = charged
        ? this.worker.stageReceipt?.(run.id, stageId, 1)
        : undefined;
      return {
        status: receipt?.charges.length ? "submission_unknown" : "needs_input",
        summary: error instanceof Error ? error.message : "작업 실행 실패",
        candidates: [],
        checks: [],
      };
    }
  }
  async execute(
    context: WorkbenchExecutionContext,
    onProgress: (message: string) => void,
  ): Promise<WorkbenchResult> {
    const probe = await this.worker.probe();
    if (!probe.codex.available || !probe.codex.authenticated)
      return {
        status: "needs_input",
        summary: probe.codex.message,
        candidates: [],
        checks: [],
      };
    const inputs = this.inputs(context);
    let result: WorkbenchResult;
    if (context.job.step === "surface") {
      const artifacts: WorkbenchResult["candidates"][number]["artifacts"] = [];
      const checks: WorkbenchResult["checks"] = [];
      for (const role of ["head", "hair", "body"]) {
        let current = inputs.filter(
          (input) => input.role === role || input.kind === "image",
        );
        for (const kind of ["uv", "texture"] as const) {
          if (context.signal.aborted)
            return {
              status: "needs_input",
              summary:
                "작업이 중지됐습니다. 완료된 원격 작업은 자동 재제출하지 않습니다.",
              candidates: [],
              checks,
            };
          onProgress(
            `${role} · ${kind === "uv" ? "Smart UV" : "텍스처"} 처리 중`,
          );
          const output = await this.phase(context, current, onProgress, {
            kind,
            role,
          });
          if (output.status !== "completed") return output;
          checks.push(...output.checks);
          const roleArtifacts = output.candidates[0].artifacts.map(
            (artifact) => ({ ...artifact, role }),
          );
          if (kind === "texture") artifacts.push(...roleArtifacts);
          current = [
            ...inputs.filter((input) => input.kind === "image"),
            ...roleArtifacts.map((artifact) => ({
              ...artifact,
              localPath: artifact.path,
              sha256: hash(this.file(context.workspace, artifact.path)),
              bytes: fs.statSync(this.file(context.workspace, artifact.path))
                .size,
            })),
          ];
        }
      }
      result = {
        status: "completed",
        summary:
          "선택한 세 파츠의 Smart UV·텍스처 결과가 준비됐습니다. 외형을 확인한 뒤 채택하세요.",
        candidates: [
          {
            id: "surface",
            label: "세 파츠 후처리 결과",
            artifacts,
            objects: [],
          },
        ],
        checks,
      };
    } else result = await this.phase(context, inputs, onProgress);
    if (
      result.status === "completed" &&
      ["assembly", "rig", "animation"].includes(context.job.step)
    ) {
      try {
        await this.inspectBlend(context, result.candidates[0]);
      } catch (error) {
        return {
          status: "needs_input",
          summary: error instanceof Error ? error.message : "Blender 검사 실패",
          candidates: [],
          checks: result.checks,
        };
      }
    }
    return result;
  }
}

function runBlender(
  exe: string,
  args: string[],
  signal: AbortSignal,
): Promise<void> {
  if (!exe || !fs.existsSync(exe))
    return Promise.reject(
      Error("설정된 Blender 실행 파일을 찾을 수 없습니다."),
    );
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve();
    };
    const abort = () => {
      child.kill();
      finish(Error("Blender 검사가 중지됐습니다."));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(Error("Blender 장면 검사 시간 초과"));
    }, 120000);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (data) => {
      output = (output + data.toString()).slice(-2000);
    });
    child.stderr.on("data", (data) => {
      output = (output + data.toString()).slice(-2000);
    });
    child.on("error", finish);
    child.on("close", (code) =>
      finish(
        code === 0
          ? undefined
          : Error(`Blender 검사 실패 (${code}): ${output}`),
      ),
    );
    if (signal.aborted) abort();
  });
}
