import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { CodexWorker, type ProductionWorker } from "./codex-worker";
import type { GraphicsNativeArgs, GraphicsNativeResult } from "./graphics-native";
import type { AssetVersion, GraphicsRole } from "../shared/graphics";
import { isGraphicsClipName } from "../shared/graphics";
import type { ProductionRun, ProductionStage } from "../shared/production";

export const graphicsAstraOperations = ["M05", "R01", "R02", "R03", "N04", "N05", "N06"] as const;
type Dependencies = {
  workerFactory?: () => ProductionWorker;
  runBlender?: (executable: string, args: string[], signal: AbortSignal) => Promise<void>;
};
type Input = { localPath: string; path: string; sha256: string; bytes: number; kind: string; version: AssetVersion };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hashFile = (file: string) => hash(fs.readFileSync(file));
const read = (file: string): any => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2));
  fs.renameSync(file + ".tmp", file);
};
const inside = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
};
const relative = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");
function directory(root: string, file: string) {
  if (!inside(root, file)) throw Error("Astra 작업 폴더가 프로젝트 밖입니다.");
  let ancestor = file;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (ancestor !== root && !inside(root, fs.realpathSync(ancestor))) throw Error("Astra 작업 폴더 연결이 프로젝트 밖입니다.");
  fs.mkdirSync(file, { recursive: true });
  if (!inside(root, fs.realpathSync(file))) throw Error("Astra 작업 폴더가 프로젝트 밖입니다.");
}
function fileWithin(root: string, file: string) {
  const absolute = path.resolve(root, file);
  if (!inside(root, absolute) || !inside(root, fs.realpathSync(absolute)) || !fs.statSync(absolute).isFile()) throw Error("Astra 파일 경로가 허용된 폴더 밖입니다.");
  return absolute;
}
function unchanged(inputs: { localPath: string; sha256: string; bytes: number }[]) {
  for (const file of inputs)
    if (!fs.existsSync(file.localPath) || hashFile(file.localPath) !== file.sha256 || fs.statSync(file.localPath).size !== file.bytes) throw Error("고정한 Astra 입력 원본 또는 작업 사본이 변경됐습니다.");
}
function accepted(args: GraphicsNativeArgs, version: AssetVersion) {
  const snapshot = args.task.objectSnapshot ?? args.object;
  return version.objectId === args.object.id && snapshot.accepted[`${version.role}:${version.slot}`] === version.id;
}
function selectInputs(args: GraphicsNativeArgs, root: string) {
  if (args.task.objectId !== args.object.id) throw Error("Astra 작업의 대상이 다릅니다.");
  const ids = new Set(args.task.inputVersionIds), files: Input[] = [];
  if (ids.size !== args.task.inputVersionIds.length || ids.size !== args.inputs.length) throw Error("고정한 Astra 입력 버전 목록이 다릅니다.");
  for (const version of args.inputs) {
    if (!ids.delete(version.id) || !version.files.length) throw Error("고정한 Astra 입력 버전이 없습니다.");
    for (const file of version.files) files.push({ ...file, version, localPath: fileWithin(root, file.path) });
  }
  unchanged(files);
  const operation = args.task.taskId, animation = operation.startsWith("N"), clipName = String(args.task.settings.clipName ?? "");
  if (animation && !isGraphicsClipName(clipName)) throw Error("명시적인 클립 이름이 필요합니다.");
  const roles: GraphicsRole[] = operation === "N06" ? ["animation"] : animation || operation === "R03" ? ["rig"] : ["model", "material", "rig"];
  const specified = args.task.settings.sourceVersionId;
  let candidates = args.inputs.filter(version => roles.includes(version.role) && accepted(args, version) && (operation !== "N06" || version.slot === clipName));
  if (specified !== undefined) candidates = candidates.filter(version => version.id === specified);
  // Resolve different accepted representations explicitly; never choose by file order.
  if (candidates.length !== 1) throw Error("편집할 채택 원본 버전 하나를 명시적으로 지정하세요.");
  const version = candidates[0], editable = files.filter(file => file.version.id === version.id);
  const source = editable.find(file => /\.blend$/i.test(file.path)) ?? (!animation && operation !== "R03" ? editable.find(file => /\.fbx$/i.test(file.path)) ?? editable.find(file => /\.glb$/i.test(file.path)) : undefined);
  if (!source) throw Error(animation || operation === "R03" ? "이 작업에는 채택된 편집 가능한 원본 .blend가 필요합니다." : "채택 원본 BLEND·FBX·GLB가 필요합니다.");
  const fps = animation ? Number(args.task.settings.fps ?? 30) : 30, duration = animation ? Number(args.task.settings.duration ?? 2) : 2;
  if (!Number.isInteger(fps) || fps < 1 || fps > 120 || !Number.isFinite(duration) || duration <= 0 || duration > 120 || Math.abs(duration * fps - Math.round(duration * fps)) > 1e-6) throw Error("클립 FPS·길이를 확인하세요. 프레임 수는 정수여야 합니다.");
  const actionName = animation ? String(args.task.settings.actionName ?? clipName) : "";
  if (animation && !isGraphicsClipName(actionName)) throw Error("클립 액션 이름이 잘못됐습니다.");
  // An animation revision retains its original reference lineage even if the user
  // subsequently accepted a different reference. Never silently replace that video.
  const motion = args.inputs.filter(v => v.role === "motion-reference" && v.slot === clipName &&
    (accepted(args, v) || operation === "N06" && source.version.sourceVersionIds.includes(v.id)));
  if (operation === "N04" && motion.length !== 1) throw Error("같은 클립 이름으로 채택한 동작 영상·프레임 참조가 필요합니다.");
  const motionFiles = files.filter(file => motion.some(v => v.id === file.version.id));
  if (motion.length) {
    if (motion.length !== 1) throw Error("동작 참조 버전이 모호합니다.");
    const manifests = motionFiles.filter(file => file.kind === "frames" || /(?:motion-reference|frames)\.json$/i.test(file.path));
    const manifest = manifests.map(file => { try { return read(file.localPath); } catch { return null; } }).find(value => value?.source === "video-ai" && Array.isArray(value.frames) && value.videos);
    if (!manifest || (manifest.clipName ?? manifest.motion) !== clipName || !manifest.frames.length) throw Error("채택 동작 참조의 실제 영상·프레임 명세가 없습니다.");
    const find = (file: string, digest: string) => motionFiles.find(input => path.resolve(root, input.path) === path.resolve(root, file) && input.sha256 === digest);
    for (const video of Object.values(manifest.videos) as any[]) if (!video || !find(video.path, video.sha256) || !/\.(mp4|mov|webm)$/i.test(video.path)) throw Error("채택 영상의 경로·해시가 명세와 다릅니다.");
    if (!Object.keys(manifest.videos).length) throw Error("채택 동작 영상이 없습니다.");
    for (const frame of manifest.frames) {
      if (!Number.isFinite(frame.time) || frame.time < 0 || frame.time > Number(manifest.duration) + 0.1 || !find(frame.side, frame.sha256) || !/\.(png|jpe?g|webp)$/i.test(frame.side)) throw Error("채택 동작 프레임의 경로·해시·시간이 잘못됐습니다.");
    }
  }
  return { files, source, animation, clipName, actionName, fps, duration, motionFiles };
}

function runBlender(executable: string, args: string[], signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) { if (child.exitCode === null) child.kill(); reject(error); } else resolve();
    };
    const abort = () => finish(Error("Blender 검증을 중지했습니다."));
    const timer = setTimeout(() => finish(Error("Blender 검증 시간이 초과됐습니다. 저장 결과는 보존합니다.")), 15 * 60_000);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", chunk => { output = (output + chunk.toString()).slice(-5000); });
    child.stderr.on("data", chunk => { output = (output + chunk.toString()).slice(-5000); });
    child.on("error", error => finish(error));
    child.on("close", code => finish(code === 0 ? undefined : Error(`실제 Blender 장면 검증 실패 (${code}): ${output}`)));
    if (signal.aborted) abort();
  });
}
const schema = {
  type: "object", additionalProperties: false, required: ["status", "summary", "blendPath", "warnings"],
  properties: { status: { type: "string", enum: ["completed", "needs_input"] }, summary: { type: "string" }, blendPath: { type: "string" }, warnings: { type: "array", items: { type: "string" } } },
};

/** One immutable app-owned Astra authoring dispatch; saved-result recovery is host-only. */
export function createGraphicsAstraExecutor(dependencies: Dependencies = {}) {
  return async (args: GraphicsNativeArgs): Promise<GraphicsNativeResult> => {
    args.signal.throwIfAborted();
    if (!(graphicsAstraOperations as readonly string[]).includes(args.task.taskId)) throw Error("이 Astra 작업은 아직 구현하지 않았습니다.");
    if (!args.task.instruction.trim()) throw Error("보정·리깅·동작의 구체적인 작업 지시가 필요합니다.");
    const root = fs.realpathSync(args.projectRoot), task = args.task, selected = selectInputs(args, root);
    const { source, files, animation, clipName, actionName, fps, duration, motionFiles } = selected;
    const folder = path.resolve(root, "graphics/jobs", task.id, "astra"), work = path.join(folder, "work");
    directory(root, folder); directory(root, work);
    const identity = hash(JSON.stringify({ schemaVersion: 1, taskId: task.id, operation: task.taskId, requestHash: task.requestHash, settings: task.settings, instruction: task.instruction, object: task.objectSnapshot ?? args.object, inputs: files.map(file => ({ versionId: file.version.id, role: file.version.role, slot: file.version.slot, path: file.path, sha256: file.sha256, bytes: file.bytes })), source: source.version.id }));
    const checkpointPath = path.join(folder, "checkpoint.json"), dispatchPath = path.join(folder, "dispatch.json"), preparedPath = path.join(folder, "prepared.json");
    if (fs.existsSync(checkpointPath)) {
      const cached = read(checkpointPath);
      if (cached.identity !== identity || !Array.isArray(cached.files)) throw Error("저장된 Astra 결과의 요청이 다릅니다.");
      unchanged(cached.files.map((file: any) => ({ ...file, localPath: fileWithin(root, file.path) })));
      args.onProgress("저장된 Astra 결과와 해시를 재사용합니다. 새 모델 호출 없음.");
      return cached.result;
    }
    if (args.recoveryOnly && !fs.existsSync(dispatchPath)) throw Error("저장된 Astra 실행 기록이 없습니다. 복구에서 새 모델 호출을 시작하지 않습니다.");
    if (!args.blenderPath || !fs.existsSync(args.blenderPath)) throw Error("설정된 Blender 실행 파일을 확인하세요.");
    const script = path.join(args.resources, "blender/graphics_astra_validate.py"), glbHelper = path.join(args.resources, "blender/graphics_glb.py");
    if (!fs.existsSync(script) || !fs.existsSync(glbHelper)) throw Error("Astra 원본·장면 검증 스크립트가 없습니다.");
    const validatorFingerprint = hash(hashFile(script) + hashFile(glbHelper));
    const invoke = async (request: unknown, name: string, specRoot = folder) => {
      const spec = path.join(specRoot, name + ".json"); write(spec, request);
      await (dependencies.runBlender ?? runBlender)(args.blenderPath, ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python", script, "--", spec], args.signal);
      args.signal.throwIfAborted(); unchanged(files);
    };
    if (fs.existsSync(dispatchPath) && read(dispatchPath).identity !== identity) throw Error("이미 실행한 Astra 요청이 다릅니다. 재제출하지 않습니다.");
    if (!fs.existsSync(preparedPath)) {
      if (fs.existsSync(dispatchPath)) throw Error("기존 요청의 준비 기록이 없습니다. Astra를 재호출하지 않습니다.");
      const versionRoots = new Map<string, string>();
      for (const file of files) {
        let common = versionRoots.get(file.version.id) ?? path.dirname(file.localPath);
        while (common !== path.dirname(file.localPath) && !inside(common, file.localPath)) common = path.dirname(common);
        versionRoots.set(file.version.id, common);
      }
      const versionIds = [...versionRoots.keys()];
      const copies = files.map(file => {
        // Preserve native companion relative paths within each immutable version.
        const destination = path.join(work, "inputs", String(versionIds.indexOf(file.version.id) + 1), path.relative(versionRoots.get(file.version.id)!, file.localPath)); directory(root, path.dirname(destination));
        if (!fs.existsSync(destination)) fs.copyFileSync(file.localPath, destination, fs.constants.COPYFILE_EXCL);
        const copy = { localPath: destination, sha256: file.sha256, bytes: file.bytes, sourcePath: file.path, versionId: file.version.id, role: file.version.role, kind: file.kind };
        unchanged([copy]); return copy;
      });
      const preparedBlend = path.join(work, "source.blend"), baseline = path.join(folder, "baseline.json");
      const nonce = randomUUID();
      const originalCopy = copies.find(copy => copy.sourcePath === source.path)!;
      if (/\.fbx$/i.test(originalCopy.localPath)) {
        // Blender's FBX importer can fail on Windows paths readable by Node.
        // Keep import, embedded texture extraction, packing and native save in a
        // short private directory, then copy the prepared outputs back unchanged.
        const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ps-ga-fbx-"));
        const importFile = path.join(staging, "input.fbx"), stagedBlend = path.join(staging, "source.blend"), stagedReport = path.join(staging, "baseline.json");
        try {
          fs.copyFileSync(originalCopy.localPath, importFile, fs.constants.COPYFILE_EXCL);
          const versionRoot = path.join(work, "inputs", String(versionIds.indexOf(source.version.id) + 1));
          const companions: { localPath: string; sha256: string; bytes: number }[] = [];
          for (const copy of copies.filter(copy => copy.versionId === source.version.id && copy.sourcePath !== source.path)) {
            const rel = path.relative(versionRoot, copy.localPath);
            if (!inside(versionRoot, copy.localPath)) throw Error("FBX 동반 파일이 고정 입력 폴더 밖입니다.");
            const destination = path.join(staging, "companions", rel);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(copy.localPath, destination, fs.constants.COPYFILE_EXCL);
            companions.push({ localPath: destination, sha256: copy.sha256, bytes: copy.bytes });
          }
          await invoke({ mode: "prepare", identity, nonce, operation: task.taskId, source: importFile, sourceSha256: source.sha256, importRoot: staging, outputBlend: stagedBlend, report: stagedReport, actionName }, "prepare-request", staging);
          unchanged([{ localPath: importFile, sha256: source.sha256, bytes: source.bytes }, ...companions]);
          fs.copyFileSync(stagedBlend, preparedBlend); fs.copyFileSync(stagedReport, baseline);
        } finally {
          const real = fs.realpathSync(staging);
          if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith("ps-ga-fbx-")) throw Error("임시 FBX 폴더 정리 경로가 잘못됐습니다.");
          fs.rmSync(real, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        }
      } else await invoke({ mode: "prepare", identity, nonce, operation: task.taskId, source: originalCopy.localPath, sourceSha256: source.sha256, outputBlend: preparedBlend, report: baseline, actionName }, "prepare-request");
      const report = read(baseline);
      if (report.identity !== identity || report.nonce !== nonce || report.sourceSha256 !== source.sha256 || !report.meshes?.length) throw Error("Blender 원본 준비 증거가 잘못됐습니다.");
      fileWithin(work, preparedBlend);
      write(preparedPath, { identity, copies, preparedBlend, preparedSha256: hashFile(preparedBlend), preparedBytes: fs.statSync(preparedBlend).size, baseline, baselineSha256: hashFile(baseline) });
    }
    const prepared = read(preparedPath);
    if (prepared.identity !== identity) throw Error("Blender 준비 요청이 다릅니다.");
    const protectedFiles = [...files, ...prepared.copies, { localPath: fileWithin(work, prepared.preparedBlend), sha256: prepared.preparedSha256, bytes: prepared.preparedBytes }];
    unchanged(protectedFiles);
    if (hashFile(fileWithin(folder, prepared.baseline)) !== prepared.baselineSha256) throw Error("원본 Blender 검사 기록이 변경됐습니다.");
    const resultPath = path.join(work, "result.json"), schemaPath = path.join(work, "result.schema.json"), outputBlend = path.join(work, "outputs/asset.blend");
    directory(root, path.dirname(outputBlend));
    if (!fs.existsSync(dispatchPath)) {
      if (fs.existsSync(outputBlend) || fs.existsSync(resultPath)) throw Error("실행 기록 없는 기존 결과가 있습니다. 덮어쓰거나 재호출하지 않습니다.");
      write(schemaPath, schema);
      const stage: ProductionStage = { id: task.id, kind: animation ? "motion-transfer" : task.taskId.startsWith("R") ? "rig" : "assemble", title: task.taskId, status: "running", dependsOn: [], attempt: 1, charged: false, requiredChecks: [], artifacts: [] };
      const run: ProductionRun = { schemaVersion: 1, id: task.id, projectId: args.object.id, projectRevision: 1, workspace: work, status: "running", createdAt: task.createdAt, updatedAt: task.updatedAt, config: { sourceId: task.objectId, brief: task.instruction, motions: animation ? [clipName] : [], maxIterations: 1, studioCreditLimit: 0, videoCreditLimit: 0, mode: "studio" }, source: { path: prepared.preparedBlend, sha256: prepared.preparedSha256, label: args.object.name }, stages: [stage], message: "App-owned local Blender Astra authoring" };
      const modes: Record<string, string> = {
        M05: "Edit ONLY requested shape/proportion of the existing meshes; preserve topology, mesh IDs, UVs, textures, materials, existing armatures and actions. Do not rebuild, decimate, replace or discard the model. Initial FBX/GLB has already been imported into the original working scene by the host.",
        R01: "Create an anatomically appropriate humanoid skeleton and skin the supplied character. Use canonical bones pelvis, spine, chest, neck, head, upper_arm.L/R, forearm.L/R, hand.L/R, thigh.L/R, shin.L/R, foot.L/R. Use a connected hierarchy and valid normalized deform weights. Include real joint pose checks; appearance/Humanoid compatibility still requires review.",
        R02: "Create an anatomically appropriate animal/nonhuman Generic skeleton using the actual supplied shape and requested species/limbs/wings. Do not impose a humanoid preset. Use a hierarchy with at least 3 nondegenerate bones, valid normalized deform weights and actual per-mesh joint pose checks.",
        R03: "Edit skinning/weights of the existing accepted rig only. Preserve the exact original bone names, hierarchy, rest matrices, mesh topology/positions, UVs, textures, materials and actions. Normalize every mesh vertex's valid deform-bone weights and inspect actual deformation; never replace the skeleton.",
        N04: "Author the named 3D action from the accepted ORIGINAL VIDEO AND decoded frames. Inspect every supplied reference frame and timing; compare actual video when tooling permits. Preserve visual identity, native geometry, skeleton, materials, UV and every other action. Never use a preset sine motion as a substitute for the requested reference behavior. Unknown timing/contact/occluded motion must be reported honestly.",
        N05: "Author the named 3D action from the user's text and original accepted rig. This is explicitly text-based motion: never claim video/reference analysis. Preserve geometry, skeleton, materials and all other actions. Use actual varying non-root pose keys and deformation, not root-only translation.",
        N06: "ANIMATION REVISION: Open the supplied ORIGINAL ANIMATED .blend and edit its existing named action. Do NOT start from a static rig or fresh scene. Keep untargeted pose keys/intervals, all other actions, original skeleton, geometry, materials and stable mesh IDs. Retained accepted video and frame references remain references; the user's correction specifies deviations. No new video request.",
      };
      const prompt = [
        "You are the app-owned gpt-6-astra Blender authoring worker. Execute exactly this frozen task using the configured Blender executable and local bpy/headless tooling. Preserve the configured reasoning effort; no model/effort downgrade, no configuration changes, no MCP toggling.",
        "No browser production, paid/cloud service, image generation, video generation, Tripo, remote upload, API key, separate asset regeneration or external account operation. Keep all existing integrations enabled. Do not inspect credentials or unrelated projects. Only author this task's local output.",
        `Operation: ${task.taskId}. Object kind: ${args.object.kind}. Blender: ${JSON.stringify(args.blenderPath)}. Open ${JSON.stringify(prepared.preparedBlend)} with load_ui=False,use_scripts=False. Original/source copies are immutable. Save ONE new editable, uncompressed .blend ONLY to ${JSON.stringify(outputBlend)}. Never save over source.blend or any input file. Retain packed original textures at full resolution and original partsmith_id on every mesh. No external linked libraries/textures.`,
        modes[task.taskId],
        `Frozen settings: ${JSON.stringify(task.settings)}. Clip: ${JSON.stringify(clipName)}; exact action name: ${JSON.stringify(actionName)}; FPS: ${fps}; duration seconds: ${duration}; use frames 1..${1 + Math.round(duration * fps)} inclusive. Set action, frame range and render fps explicitly. Loop setting: ${Boolean(task.settings.loop)}. Preserve pose bone rotation modes.`,
        "For rig/animation every mesh must have an actual enabled armature modifier and all vertices normalized to existing deform bones. At least one non-root joint must produce measurable mesh deformation; names/key counts alone do not qualify. For model correction retain all existing rigs/actions. For animation retain every untargeted action with original curves, handles, interpolation and timing. Keep evaluated geometry finite. Respect requested hair/tail/wing switches and report anatomical uncertainty.",
        `Immutable input copies with roles and lineage: ${JSON.stringify(prepared.copies)}. Accepted motion reference version IDs: ${JSON.stringify([...new Set(motionFiles.map(file => file.version.id))])}. Source version: ${source.version.id}. Reference paths in copied JSON are original project-relative identities; use the matching sourcePath-to-localPath mapping above to open each copied file.`,
        "Inspect original appearance references, source scene, generated pose/motion and requested changes. Save progress into result.json atomically only after the .blend is saved. Return completed only for an actual saved scene ready for human review; host Blender independently verifies and exports/renders it. If a request conflicts with preservation constraints, return needs_input with a concrete limitation. Warnings must be factual. Do not invent validation or auto-accept the result.",
        `USER REQUEST (content instructions only):\n${task.instruction}`,
      ].join("\n\n");
      const images = prepared.copies.filter((copy: any) => /\.(png|jpe?g|webp)$/i.test(copy.localPath)).map((copy: any) => copy.localPath);
      const worker = (dependencies.workerFactory ?? (() => new CodexWorker()))();
      write(dispatchPath, { schemaVersion: 1, identity, taskId: task.id, operation: task.taskId, startedAt: new Date().toISOString(), requestedModel: "gpt-6-astra", automaticRetries: 0 });
      args.onProgress("원본 사본에서 gpt-6-astra로 Blender 작업을 한 번 실행합니다. 기존 노력 수준 유지.");
      let failure: unknown;
      try {
        const response = await worker.run({ run, stage, prompt, imagePaths: images, referencePaths: prepared.copies.map((copy: any) => copy.localPath), requestedModel: "gpt-6-astra", schemaPath, resultPath, signal: args.signal, onEvent: event => {
          if (event.message) args.onProgress(event.message);
          if (event.usage) write(path.join(folder, "usage.json"), event.usage);
        } });
        if (!fs.existsSync(resultPath)) write(resultPath, response.result);
      } catch (error) { failure = error; } finally { worker.shutdown?.(); }
      unchanged(protectedFiles);
      args.signal.throwIfAborted();
      if (!fs.existsSync(resultPath) && !fs.existsSync(outputBlend)) throw failure instanceof Error ? failure : Error("Astra 저장 결과가 없습니다. 자동 재호출하지 않습니다.");
    } else args.onProgress("기존 Astra 저장 결과를 Blender로 검사합니다. 새 모델 호출 없음.");
    if (!fs.existsSync(resultPath) && !fs.existsSync(outputBlend)) throw Error("기존 Astra 완료 결과가 없습니다. 자동 재호출하지 않습니다.");
    // A transport-disconnected final message is not a reason to reauthor a saved
    // native scene. This host recovery claim is kept separate from worker output;
    // every normal Blender validation still applies before registering review.
    const recoveredWithoutMessage = !fs.existsSync(resultPath);
    const authored = recoveredWithoutMessage
      ? { status: "completed", summary: "Host-only native scene recovery", blendPath: "outputs/asset.blend", warnings: ["Astra 완료 메시지가 누락되어 저장된 Blender 파일만 독립 검사했습니다. 작업 지시 충족 여부를 직접 검토하세요."] }
      : read(resultPath);
    if (authored.status !== "completed" || typeof authored.blendPath !== "string" || !Array.isArray(authored.warnings)) throw Error(`Astra 결과가 검토 준비 상태가 아닙니다: ${String(authored.summary ?? "미완료")}`);
    const blend = fileWithin(work, authored.blendPath);
    if (path.resolve(blend) !== path.resolve(outputBlend) || hashFile(blend) === prepared.preparedSha256) throw Error("새 편집 Blender 결과 경로·내용이 잘못됐습니다.");
    // A failed preview may already contain a valid GLB. Retain every derivative
    // attempt; local recovery must not overwrite it or dispatch another worker.
    const validation = path.join(folder, "validated-" + hash(hashFile(blend) + validatorFingerprint).slice(0, 20) + "-" + randomUUID().slice(0, 8)); directory(root, validation);
    const reportPath = path.join(validation, "report.json"), nonce = randomUUID();
    args.onProgress("실제 Blender에서 원본 계보·메시·웨이트·액션·변형을 검사하고 미리보기를 만듭니다.");
    await invoke({ mode: "validate", identity, nonce, validatorFingerprint, operation: task.taskId, sourceSha256: source.sha256, sourceBlend: prepared.preparedBlend, outputBlend: blend, baseline: prepared.baseline, output: validation, report: reportPath, actionName, clipName, fps, duration, loop: Boolean(task.settings.loop) }, "validate-request");
    unchanged(protectedFiles);
    if (hashFile(prepared.baseline) !== prepared.baselineSha256) throw Error("원본 Blender 검사 기록이 변경됐습니다.");
    const report = read(reportPath);
    if (report.identity !== identity || report.nonce !== nonce || report.operation !== task.taskId || report.sourceSha256 !== source.sha256 || report.outputSha256 !== hashFile(blend) || report.passed !== true || !report.meshes?.length || !Array.isArray(report.files)) throw Error("실제 Blender 결과의 검증 증거가 잘못됐습니다.");
    const required = ["meshLineage", "topology", "materials", "actionsPreserved", ...(task.taskId !== "M05" ? ["weights", "deformation"] : []), ...(animation ? ["skeleton", "clipRange", "motion"] : [])];
    if (required.some(check => report.checks?.[check] !== true)) throw Error("Blender 원본 보존·변형·액션 검사가 통과하지 않았습니다.");
    const outputFiles: GraphicsNativeResult["files"] = [{ path: relative(root, blend), kind: "blend" }];
    for (const item of report.files) {
      if (typeof item !== "string") throw Error("Blender 출력 파일 목록이 잘못됐습니다.");
      const output = fileWithin(validation, item), extension = path.extname(output).toLowerCase();
      if (![".glb", ".png"].includes(extension) || !fs.statSync(output).size) throw Error("Blender 출력 파일 형식이 잘못됐습니다.");
      if (extension === ".glb") {
        const bytes = fs.readFileSync(output);
        if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "glTF" || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw Error("Blender GLB 미리보기가 손상됐습니다.");
      }
      outputFiles.push({ path: relative(root, output), kind: extension === ".glb" ? "model" : "image" });
    }
    if (!outputFiles.some(file => file.kind === "model") || outputFiles.filter(file => file.kind === "image").length < 3) throw Error("실제 모델·정면·측면·후면 미리보기가 없습니다.");
    outputFiles.push({ path: relative(root, reportPath), kind: "report" });
    if (recoveredWithoutMessage) write(path.join(folder, "native-recovery.json"), { schemaVersion: 1, identity, mode: "saved-blend-without-completion-message", outputSha256: hashFile(blend), validation: relative(root, reportPath), modelTurns: 0, recoveredAt: new Date().toISOString() });
    const result: GraphicsNativeResult = { files: outputFiles, label: animation ? `${clipName} · ${task.taskId === "N06" ? "동작 수정" : "3D 동작"}` : task.taskId === "M05" ? "형태·비율 보정" : "리그·웨이트", role: animation ? "animation" : task.taskId === "M05" ? source.version.role : "rig", slot: animation ? clipName : "main", warnings: [...authored.warnings.filter((value: unknown) => typeof value === "string").slice(0, 30), "구조·실제 변형을 검사했습니다. 해부학적 품질·접지·관통·루프의 시각 품질과 Unity 재생은 별도 검토가 필요합니다."], ...(fs.existsSync(path.join(folder, "usage.json")) ? { usage: read(path.join(folder, "usage.json")) } : {}) };
    write(checkpointPath, { schemaVersion: 1, identity, validatorFingerprint, createdAt: new Date().toISOString(), files: outputFiles.map(file => { const localPath = fileWithin(root, file.path); return { path: file.path, bytes: fs.statSync(localPath).size, sha256: hashFile(localPath) }; }), result });
    return result;
  };
}
export const executeGraphicsAstra = createGraphicsAstraExecutor();
