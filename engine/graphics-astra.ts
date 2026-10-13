import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { CodexWorker, type ProductionWorker } from "./codex-worker";
import { prepareGraphicsMotionFrames } from "./graphics-motion-frames";
import type { GraphicsNativeArgs, GraphicsNativeResult } from "./graphics-native";
import type { AssetVersion, GraphicsRole } from "../shared/graphics";
import { isGraphicsClipName } from "../shared/graphics";
import { rigContractForProducer } from "../shared/graphics-rig";
import type { ProductionRun, ProductionStage } from "../shared/production";

export const graphicsAstraOperations = ["M05", "M06", "M07", "M08", "M15", "R01", "R02", "R03", "N04", "N05", "N06"] as const;
type Dependencies = {
  workerFactory?: () => ProductionWorker;
  runBlender?: (executable: string, args: string[], signal: AbortSignal) => Promise<void>;
  prepareMotionFrames?: typeof prepareGraphicsMotionFrames;
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
function jsonSetting(value: unknown, label: string): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { throw Error(label + " JSON 형식을 확인하세요."); }
}
export function resolveEditMeshNames(meshes: {id: string; name: string}[], names: string[], ids: string[] = []): string[] {
  return [...new Set([...ids, ...names.map(name => {
    const matches = meshes.filter(mesh => mesh.name === name);
    if (matches.length !== 1 || !matches[0].id) throw Error('선택 부품 이름이 채택 원본과 유일하게 연결되지 않습니다. 메시 ID를 확인하세요.');
    return matches[0].id;
  })])];
}
function modelingContract(args: GraphicsNativeArgs) {
  const settings = args.task.settings, operation = args.task.taskId;
  if (["M06", "M07", "M08", "M15"].includes(operation) && Number(settings.count ?? 1) !== 1)
    throw Error("Astra 모델 후보는 독립 작업으로 한 개씩 실행해야 합니다.");
  const requested = operation === "M07" ? jsonSetting(settings.requestedParts, "분리 파츠") : [];
  if (!Array.isArray(requested) || operation === "M07" && (requested.length < 2 || requested.length > 32)) throw Error("분리할 파츠 2–32개를 명시하세요.");
  const requestedParts = requested.map((part: any) => {
    if (!part || typeof part.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(part.id) || part.id === "main" || typeof part.label !== "string" || !part.label.trim()) throw Error("분리 파츠의 고유 ID와 이름이 필요합니다.");
    return { id: part.id, label: part.label.trim().slice(0, 120) };
  });
  if (new Set(requestedParts.map(part => part.id)).size !== requestedParts.length) throw Error("분리 파츠 ID가 중복됩니다.");
  const editMeshIds = operation === "M06" ? jsonSetting(settings.editMeshIds ?? '[]', "부분 수정 메시 ID") : [];
  const editMeshNames = operation === "M06" ? jsonSetting(settings.editMeshNames ?? '[]', "부분 수정 메시 이름") : [];
  if (!Array.isArray(editMeshNames) || editMeshNames.length > 64 || editMeshNames.some(value => typeof value !== 'string' || !value.trim() || value.length > 200) || new Set(editMeshNames).size !== editMeshNames.length) throw Error('부분 수정 메시 이름을 확인하세요.');
  if (!Array.isArray(editMeshIds) || editMeshIds.some(value => typeof value !== "string" || !value.trim() || value.length > 200) || new Set(editMeshIds).size !== editMeshIds.length || operation === "M06" && !editMeshIds.length && !editMeshNames.length)
    throw Error("부분 수정에는 원본 partsmith_id 목록(editMeshIds)이 필요합니다. 지정 메시의 형태만 수정하며 재토폴로지·재생성은 지원하지 않습니다.");
  const locks = Object.fromEntries(["topology", "materials", "rig"].map(name => [name, settings[`lock.${name}`] === true]));
  return { requestedParts, editMeshIds, editMeshNames, locks };
}
function requestedRigFeatures(settings: GraphicsNativeArgs["task"]["settings"]) {
  const enabled: Record<string, boolean> = {
    ears: settings.rigEars === true, tail: settings.rigTail === true, hair: settings.rigHair === true,
    cloth: settings.rigClothing === true || settings.rigCloth === true,
    wings: settings.rigWings === true, accessories: settings.rigAccessories === true,
  };
  return Object.keys(enabled).filter(name => enabled[name]);
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
  const roles: GraphicsRole[] = operation === "M15" ? ["design"] : operation === "N06" ? ["animation"] : animation || operation === "R03" ? ["rig"] : ["model", "material", "rig"];
  const specified = args.task.settings.sourceVersionId;
  let candidates = args.inputs.filter(version => roles.includes(version.role) && accepted(args, version) && (operation !== "N06" || version.slot === clipName));
  if (operation === "M08") candidates = candidates.filter(version => version.role === "model" && version.slot !== "main");
  else if (operation === "M15" && specified === undefined) candidates = candidates.sort((a, b) => Number(b.slot === "main") - Number(a.slot === "main") || a.id.localeCompare(b.id)).slice(0, 1);
  else if (specified !== undefined) candidates = candidates.filter(version => version.id === specified);
  // Resolve different accepted representations explicitly; never choose by file order.
  if (operation === "M08" ? candidates.length < 2 || new Set(candidates.map(version => version.slot)).size !== candidates.length : candidates.length !== 1) throw Error(operation === "M08" ? "서로 다른 파츠 슬롯에서 채택한 모델 두 개 이상이 필요합니다." : "편집할 채택 원본 버전 하나를 명시적으로 지정하세요.");
  const version = candidates[0], editable = files.filter(file => file.version.id === version.id);
  const preferred = (entries: Input[]) => entries.find(file => /\.blend$/i.test(file.path)) ?? (!animation && operation !== "R03" ? entries.find(file => /\.fbx$/i.test(file.path)) ?? entries.find(file => /\.glb$/i.test(file.path)) : undefined);
  const source = operation === "M15" ? editable.find(file => /\.(png|jpe?g|webp)$/i.test(file.path)) : preferred(editable);
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
    const manifest = manifests.map(file => { try { return read(file.localPath); } catch { return null; } }).find(value => ["video-ai", "video-import"].includes(value?.source) && Array.isArray(value.frames) && value.videos);
    if (!manifest || (manifest.clipName ?? manifest.motion) !== clipName || !manifest.frames.length) throw Error("채택 동작 참조의 실제 영상·프레임 명세가 없습니다.");
    const find = (file: string, digest: string) => motionFiles.find(input => path.resolve(root, input.path) === path.resolve(root, file) && input.sha256 === digest);
    for (const video of Object.values(manifest.videos) as any[]) if (!video || !find(video.path, video.sha256) || !/\.(mp4|mov|webm)$/i.test(video.path)) throw Error("채택 영상의 경로·해시가 명세와 다릅니다.");
    if (!Object.keys(manifest.videos).length) throw Error("채택 동작 영상이 없습니다.");
    for (const frame of manifest.frames) {
      if (!Number.isFinite(frame.time) || frame.time < 0 || frame.time > Number(manifest.duration) + 0.1 || !find(frame.side, frame.sha256) || !/\.(png|jpe?g|webp)$/i.test(frame.side)) throw Error("채택 동작 프레임의 경로·해시·시간이 잘못됐습니다.");
    }
  }
  const sources = operation === "M08" ? candidates.map(candidate => preferred(files.filter(file => file.version.id === candidate.id))) : [source];
  if (sources.some(file => !file) && operation === "M08") throw Error("파츠 조립에는 각 채택 파츠의 원본 BLEND·FBX·GLB가 필요합니다.");
  return { files, source, sources: sources as Input[], animation, clipName, actionName, fps, duration, motionFiles };
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
    const root = fs.realpathSync(args.projectRoot), task = args.task, selected = selectInputs(args, root), contract = modelingContract(args);
    const { source, sources, files, animation, clipName, actionName, fps, duration, motionFiles } = selected;
    const rigFeatures = requestedRigFeatures(task.settings);
    const rigContract = task.taskId === "R01" ? rigContractForProducer(task, task.id) : undefined;
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
    const script = path.join(args.resources, "blender/graphics_astra_validate.py"), glbHelper = path.join(args.resources, "blender/graphics_glb.py"), humanoidHelper = path.join(args.resources, "blender/graphics_humanoid.py");
    if (!fs.existsSync(script) || !fs.existsSync(glbHelper) || !fs.existsSync(humanoidHelper)) throw Error("Astra 원본·장면 검증 스크립트가 없습니다.");
    const validatorFingerprint = hash(hashFile(script) + hashFile(glbHelper) + hashFile(humanoidHelper));
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
      const prepareSource = async (input: Input, outputBlend: string, report: string, name: string, prepareNonce = nonce) => {
        const originalCopy = copies.find(copy => copy.sourcePath === input.path && copy.versionId === input.version.id)!;
        const request = { mode: "prepare", identity, nonce: prepareNonce, operation: task.taskId, sourceSha256: input.sha256, outputBlend, report, actionName };
        if (!/\.(fbx|glb)$/i.test(originalCopy.localPath)) {
          await invoke({ ...request, source: originalCopy.localPath }, name);
          return;
        }
        // Blender's FBX importer can fail on Windows paths readable by Node.
        // Keep native import, texture extraction, packing and save in a short
        // private directory. The same path handles API parts before assembly.
        const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ps-ga-fbx-"));
        const importFile = path.join(staging, "input" + path.extname(input.path).toLowerCase()), stagedBlend = path.join(staging, "source.blend"), stagedReport = path.join(staging, "baseline.json");
        try {
          fs.copyFileSync(originalCopy.localPath, importFile, fs.constants.COPYFILE_EXCL);
          const versionRoot = path.join(work, "inputs", String(versionIds.indexOf(input.version.id) + 1));
          const companions: { localPath: string; sha256: string; bytes: number }[] = [];
          for (const copy of copies.filter(copy => copy.versionId === input.version.id && copy.sourcePath !== input.path)) {
            const rel = path.relative(versionRoot, copy.localPath);
            if (!inside(versionRoot, copy.localPath)) throw Error("FBX 동반 파일이 고정 입력 폴더 밖입니다.");
            const destination = path.join(staging, "companions", rel);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(copy.localPath, destination, fs.constants.COPYFILE_EXCL);
            companions.push({ localPath: destination, sha256: copy.sha256, bytes: copy.bytes });
          }
          await invoke({ ...request, source: importFile, importRoot: staging, outputBlend: stagedBlend, report: stagedReport }, name, staging);
          unchanged([{ localPath: importFile, sha256: input.sha256, bytes: input.bytes }, ...companions]);
          fs.copyFileSync(stagedBlend, outputBlend); fs.copyFileSync(stagedReport, report);
        } finally {
          const real = fs.realpathSync(staging);
          if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith("ps-ga-fbx-")) throw Error("임시 FBX 폴더 정리 경로가 잘못됐습니다.");
          fs.rmSync(real, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        }
      };
      const assemblySources: { path: string; sha256: string; bytes: number; versionId: string; slot: string; sourcePath: string; sourceSha256: string; report: string; reportSha256: string; reportBytes: number }[] = [];
      if (task.taskId === "M08") {
        const preparedParts = path.join(work, "assembly-inputs"); directory(root, preparedParts);
        for (const [index, input] of sources.entries()) {
          const blend = path.join(preparedParts, `${index + 1}.blend`), reportPath = path.join(preparedParts, `${index + 1}.json`), partNonce = randomUUID();
          args.onProgress(`${input.version.slot} 원본을 로컬 Blender 사본으로 준비합니다. 생성 서비스 호출 없음.`);
          await prepareSource(input, blend, reportPath, `prepare-part-${index + 1}`, partNonce);
          const part = read(reportPath);
          if (part.identity !== identity || part.nonce !== partNonce || part.sourceSha256 !== input.sha256 || !part.meshes?.length) throw Error("조립 파츠의 로컬 원본 준비 증거가 잘못됐습니다.");
          fileWithin(work, blend); fileWithin(work, reportPath);
          assemblySources.push({ path: blend, sha256: hashFile(blend), bytes: fs.statSync(blend).size, versionId: input.version.id, slot: input.version.slot,
            sourcePath: input.path, sourceSha256: input.sha256, report: reportPath, reportSha256: hashFile(reportPath), reportBytes: fs.statSync(reportPath).size });
        }
        await invoke({ mode: "prepare-assembly", identity, nonce, operation: task.taskId, sourceSha256: source.sha256,
          sources: assemblySources, outputBlend: preparedBlend, report: baseline }, "prepare-request");
      } else await prepareSource(source, preparedBlend, baseline, "prepare-request");
      const report = read(baseline);
      if (report.identity !== identity || report.nonce !== nonce || report.sourceSha256 !== source.sha256 || (task.taskId !== "M15" && !report.meshes?.length)) throw Error("Blender 원본 준비 증거가 잘못됐습니다.");
      fileWithin(work, preparedBlend);
      write(preparedPath, { identity, copies, assemblySources, preparedBlend, preparedSha256: hashFile(preparedBlend), preparedBytes: fs.statSync(preparedBlend).size, baseline, baselineSha256: hashFile(baseline) });
    }
    const prepared = read(preparedPath);
    if (prepared.identity !== identity) throw Error("Blender 준비 요청이 다릅니다.");
    const protectedFiles = [...files, ...prepared.copies, ...(prepared.assemblySources ?? []).flatMap((part: any) => [
      { localPath: fileWithin(work, part.path), sha256: part.sha256, bytes: part.bytes },
      { localPath: fileWithin(work, part.report), sha256: part.reportSha256, bytes: part.reportBytes },
    ]), { localPath: fileWithin(work, prepared.preparedBlend), sha256: prepared.preparedSha256, bytes: prepared.preparedBytes }];
    unchanged(protectedFiles);
    if (hashFile(fileWithin(folder, prepared.baseline)) !== prepared.baselineSha256) throw Error("원본 Blender 검사 기록이 변경됐습니다.");
    const baseline = read(prepared.baseline);
    if (task.taskId === 'M06' && contract.editMeshNames.length) {
      contract.editMeshIds = resolveEditMeshNames(baseline.meshes, contract.editMeshNames, contract.editMeshIds);
    }
    if (task.taskId === "M06" && contract.editMeshIds.some(id => !baseline.meshes.some((mesh: any) => mesh.id === id))) throw Error("부분 수정 메시 ID가 채택 원본에 없습니다. 원본 partsmith_id를 확인하세요.");
    if (["M06", "M07", "M08"].includes(task.taskId) && baseline.meshes.some((mesh: any) => mesh.shapeKeys || mesh.modifiers?.some((modifier: any) => modifier.type !== "ARMATURE"))) throw Error("부분 수정·분리·조립은 셰이프 키나 적용하지 않은 변형 모디파이어가 있는 원본을 아직 검증하지 못합니다. 원본을 보존하고 중지합니다.");
    if (task.taskId === "M15" && Object.values(contract.locks).some(Boolean)) throw Error("신규 모델에는 보존할 원본 3D 구조가 없어 구조 잠금을 검증할 수 없습니다.");
    const resultPath = path.join(work, "result.json"), schemaPath = path.join(work, "result.schema.json"), outputBlend = path.join(work, "outputs/asset.blend");
    const motionInputPath = path.join(work, "motion-input.json");
    const motionProtected: { localPath: string; sha256: string; bytes: number }[] = [];
    if (fs.existsSync(dispatchPath) && read(dispatchPath).motionInput) {
      const recorded = read(dispatchPath).motionInput;
      if (recorded.path !== relative(root, motionInputPath) || hashFile(fileWithin(root, recorded.path)) !== recorded.sha256) throw Error("기존 동작 영상 입력 명세가 변경됐습니다. 재실행하지 않습니다.");
      const saved = read(motionInputPath);
      if (saved.identity !== identity || !Array.isArray(saved.files)) throw Error("기존 동작 영상 입력 요청이 다릅니다.");
      motionProtected.push(...saved.files.map((file: any) => ({ ...file, localPath: fileWithin(root, file.path) })));
      unchanged(motionProtected);
    }
    directory(root, path.dirname(outputBlend));
    if (!fs.existsSync(dispatchPath)) {
      if (fs.existsSync(outputBlend) || fs.existsSync(resultPath)) throw Error("실행 기록 없는 기존 결과가 있습니다. 덮어쓰거나 재호출하지 않습니다.");
      const motionIds = new Set(motionFiles.map(file => file.version.id));
      const decodedImages: string[] = [], motionViews: unknown[] = [], decodedFiles: { path: string; sha256: string; bytes: number }[] = [];
      const videos = motionFiles.filter(file => /\.(mp4|mov|webm)$/i.test(file.path));
      for (const [index, video] of videos.entries()) {
        const copy = prepared.copies.find((copy: any) => copy.sourcePath === video.path && copy.versionId === video.version.id);
        if (!copy) throw Error("채택 영상의 고정 사본이 없습니다.");
        const decoded = await (dependencies.prepareMotionFrames ?? prepareGraphicsMotionFrames)({ projectRoot: root,
          source: { path: relative(root, copy.localPath), sha256: video.sha256, bytes: video.bytes, kind: "video" },
          outputDirectory: path.join(work, "motion-frames", String(index + 1)), resources: args.resources,
          signal: args.signal, maxFrames: 240, maxDurationSeconds: 120, onProgress: args.onProgress });
        if (!decoded.frames.length || decoded.frames.length !== decoded.framePaths.length) throw Error("원본 영상의 전체 프레임 입력이 없습니다.");
        for (const frame of decoded.frames) {
          const localPath = fileWithin(root, frame.path);
          if (!inside(work, localPath)) throw Error("동작 프레임이 현재 작업 폴더 밖입니다.");
          decodedImages.push(relative(work, localPath));
        }
        decodedFiles.push(decoded.manifest, ...decoded.frames);
        motionViews.push({ versionId: video.version.id, originalPath: video.path, originalSha256: video.sha256,
          manifest: relative(work, fileWithin(root, decoded.manifest.path)), frameCount: decoded.frames.length,
          timeBase: decoded.timeBase, nativeFrameRate: decoded.nativeFrameRate, durationSeconds: decoded.durationSeconds,
          attachmentPaths: decoded.frames.map(frame => relative(work, fileWithin(root, frame.path))) });
      }
      if (motionIds.size && !videos.length) throw Error("연속 동작 분석에 사용할 채택 원본 영상이 없습니다.");
      // Explicit capacity guard: never silently drop frames, lower resolution or start a costly turn with incomplete motion.
      if (decodedImages.length > 240) throw Error("이번 동작 참조는 전체 240프레임 입력 범위를 넘습니다. 사용할 구간을 짧게 지정한 영상으로 준비하세요. 프레임을 생략하거나 Astra를 실행하지 않았습니다.");
      const images = prepared.copies.filter((copy: any) => !motionIds.has(copy.versionId) && /\.(png|jpe?g|webp)$/i.test(copy.localPath)).map((copy: any) => copy.localPath).concat(decodedImages);
      if (images.reduce((sum: number, file: string) => sum + file.length + 12, 0) > 26000) throw Error("동작 참조 이미지 경로가 실행 길이 한도를 넘습니다. 입력을 줄이지 않고 중지했습니다.");
      if (videos.length) {
        motionProtected.push(...decodedFiles.map(file => ({ ...file, localPath: fileWithin(root, file.path) })));
        unchanged(motionProtected);
        write(motionInputPath, { schemaVersion: 1, identity, source: "all-native-video-frames", views: motionViews, files: decodedFiles });
        motionProtected.push({ localPath: motionInputPath, sha256: hashFile(motionInputPath), bytes: fs.statSync(motionInputPath).size });
      }
      write(schemaPath, schema);
      const stage: ProductionStage = { id: task.id, kind: animation ? "motion-transfer" : task.taskId.startsWith("R") ? "rig" : "assemble", title: task.taskId, status: "running", dependsOn: [], attempt: 1, charged: false, requiredChecks: [], artifacts: [] };
      const run: ProductionRun = { schemaVersion: 1, id: task.id, projectId: args.object.id, projectRevision: 1, workspace: work, status: "running", createdAt: task.createdAt, updatedAt: task.updatedAt, config: { sourceId: task.objectId, brief: task.instruction, motions: animation ? [clipName] : [], maxIterations: 1, studioCreditLimit: 0, videoCreditLimit: 0, mode: "studio" }, source: { path: prepared.preparedBlend, sha256: prepared.preparedSha256, label: args.object.name }, stages: [stage], message: "App-owned local Blender Astra authoring" };
      const modes: Record<string, string> = {
        M05: "Edit ONLY requested shape/proportion of the existing meshes; preserve topology, mesh IDs, UVs, textures, materials, existing armatures and actions. Do not rebuild, decimate, replace or discard the model. Initial FBX/GLB has already been imported into the original working scene by the host.",
        M06: `PARTIAL EDIT: edit positions only within exact mesh IDs ${JSON.stringify(contract.editMeshIds)}. Every untargeted mesh must retain its original positions and world transform. Preserve every mesh ID, topology, UV, material, rig and action. Rebuilding, adding/removing meshes or topology-changing surgery is unsupported; return needs_input when required.`,
        M07: `PART SEPARATION: partition every original polygon exactly once into these requested parts: ${JSON.stringify(contract.requestedParts)}. Assign each output MESH custom property partsmith_part_id to exactly one requested id, and retain a unique partsmith_id. Do not duplicate, omit, triangulate, remesh or move any surface. Retain world-space positions, per-corner UVs, materials and skin weights, original rigs and actions. Host exports separate editable BLEND/FBX/GLB for each part from this one authored scene.`,
        M08: "PART ASSEMBLY: arrange ALL supplied accepted parts in the prepared scene using object/root transforms only. Preserve mesh IDs, vertices, topology, UV, materials, packed texture originals, rigs and actions. Do not fuse, remesh, substitute, delete or regenerate parts. Inspect the whole-appearance references for proportions; report uncertain alignment. Produce one combined editable scene.",
        M15: "NEW LOCAL MODEL: author exactly one independent editable Blender model using the accepted design images and compiled request. The prepared scene is intentionally empty. Create actual finite mesh geometry with unique partsmith_id on each mesh, coherent UV/material assignments and packed file textures if used. Bake non-armature modifiers into the new mesh; shape keys are not supported in this initial model contract. Do not use a prior generated model or copy another candidate. Semantic similarity, style, silhouette and requested quality require human visual review; do not claim they are machine verified.",
        R01: `Create exactly one anatomically appropriate humanoid armature and skin ALL supplied character meshes with normalized deform weights. Canonical host-owned Unity mapping: ${JSON.stringify(rigContract)}. Use pelvis as the root of the mapped human hierarchy; parent each joint to its anatomically correct upstream joint, with nondegenerate segments and plausible rest placement. ${rigContract?.fingers ? "Author all 30 mapped thumb/index/middle/ring/little .01/.02/.03.L/.R finger deform bones. Every mapped non-root bone including every finger segment requires direct vertex influence and measurable individual FK response; labels or zero-weight bones do not qualify." : "Finger controls were not requested."} Preserve all head/body/hair meshes, their stable IDs and partsmith_part_id slots; part-hair and hair denote the hair part. ${rigContract?.hairBinding === "head" ? "Bind every hair-part vertex rigidly with weight 1 to canonical head. Do not add hair or facial deform controls." : "Add the explicitly requested hair controls with measurable weighted deformation."} Keep a connected hierarchy suitable for the explicit Humanoid mapping. Include real joint pose checks; anatomical quality and actual Unity Avatar validity still require independent review.`,
        R02: "Create an anatomically appropriate animal/nonhuman Generic skeleton using the actual supplied shape and requested species/limbs/wings. Do not impose a humanoid preset. Use a hierarchy with at least 3 nondegenerate bones, valid normalized deform weights and actual per-mesh joint pose checks.",
        R03: "Edit skinning/weights of the existing accepted rig only. Preserve the exact original bone names, hierarchy, rest matrices, mesh topology/positions, UVs, textures, materials and actions. Normalize every mesh vertex's valid deform-bone weights and inspect actual deformation; never replace the skeleton.",
        N04: "Author the named 3D action from the accepted ORIGINAL VIDEO AND decoded frames. ALL native frames, in their native resolution and chronological order, are attached. Inspect the continuous pose/contact progression using every attached frame and the native timestamp index, not just the prior 0/1/2-second thumbnails. Preserve visual identity, native geometry, skeleton, weights, armature modifier settings, materials, UV and every other action. Never use a preset sine motion as a substitute for the requested reference behavior. Unknown timing/contact/occluded motion must be reported honestly.",
        N05: "Author the named 3D action from the user's text and original accepted rig. This is explicitly text-based motion: never claim video/reference analysis. Preserve geometry, skeleton, materials and all other actions. Use actual varying non-root pose keys and deformation, not root-only translation.",
        N06: "ANIMATION REVISION: Open the supplied ORIGINAL ANIMATED .blend and edit its existing named action. Do NOT start from a static rig or fresh scene. Keep untargeted pose keys/intervals, all other actions, original skeleton, geometry, materials and stable mesh IDs. Retained accepted video and frame references remain references; the user's correction specifies deviations. No new video request.",
      };
      const prompt = [
        "You are the app-owned gpt-6-astra Blender authoring worker. Execute exactly this frozen task using the configured Blender executable and local bpy/headless tooling. Preserve the configured reasoning effort; no model/effort downgrade, no configuration changes, no MCP toggling.",
        "No browser production, paid/cloud service, image generation, video generation, Tripo, remote upload, API key or external account operation. No separate asset regeneration except the explicitly requested NEW LOCAL MODEL operation M15. Keep all existing integrations enabled. Do not inspect credentials or unrelated projects. Only author this task's local output.",
        `Operation: ${task.taskId}. Object kind: ${args.object.kind}. Blender: ${JSON.stringify(args.blenderPath)}. Open ${JSON.stringify(prepared.preparedBlend)} with load_ui=False,use_scripts=False. Original/source copies are immutable. Save ONE new editable, uncompressed .blend ONLY to ${JSON.stringify(outputBlend)}. Never save over source.blend or any input file. Retain packed original textures at full resolution and original partsmith_id on every mesh. No external linked libraries/textures.`,
        modes[task.taskId],
        ...(rigContract ? ["Unity Humanoid transform names must be unambiguous. No scene object display name may equal a mapped canonical bone name (for example a mesh named head conflicts with the head bone). Prefix mesh/object display names when needed, for example Part_head/Part_body/Part_hair; preserve every partsmith_id, partsmith_part_id, geometry, material and transform."] : []),
        `Independent candidate variationSeed: ${JSON.stringify(task.settings.variationSeed ?? null)}; candidateIndex: ${JSON.stringify(task.settings.candidateIndex ?? null)}. For a candidate batch, create a distinct authored interpretation of this same request within all preservation constraints. Do not duplicate another candidate's scene or merely rename/re-save identical geometry/actions. No borrowing prior candidate outputs. If the allowed edit has no meaningful independent variation, report needs_input rather than claim multiple originals.`,
        `Structural lock flags: ${JSON.stringify(contract.locks)}. These are hard host checks only when explicitly true; operation-specific preservation requirements above still apply. For R01/R02 set armature.data.bones[name]["partsmith_feature"] (not PoseBone properties) to ears, tail, hair, cloth, wings or accessories on the corresponding deform bones. Required features: ${JSON.stringify(rigFeatures)}. rigClothing and legacy rigCloth both request cloth controls; rigAccessories requests independent equipment/accessory controls. Every required feature needs non-root deform bones, direct normalized vertex influence and measurable FK pose response. IK/CopyTransforms must not completely override the tagged deform bone's rotation during host pose tests.`,
        `Frozen settings: ${JSON.stringify(task.settings)}. Clip: ${JSON.stringify(clipName)}; exact action name: ${JSON.stringify(actionName)}; FPS: ${fps}; duration seconds: ${duration}; use frames 1..${1 + Math.round(duration * fps)} inclusive. For animation, both action and scene ranges must match these exact endpoints, with actual keys at both ends and render fps explicitly set. No F-curve modifiers, including CYCLES: bake motion and loops into keys within that range. Loop setting: ${Boolean(task.settings.loop)}. Preserve pose bone rotation modes.`,
        "For rig/animation preserve the exact existing MESH object set: do not add control-widget, ground or helper meshes, even hidden ones; use bones or EMPTY controls. Every mesh must have an enabled armature modifier and all vertices normalized to existing deform bones. At least one non-root joint must produce measurable mesh deformation; names/key counts alone do not qualify. For model correction retain all existing rigs/actions. For animation retain every untargeted action with original curves, handles, interpolation and timing. Keep evaluated geometry finite and report anatomical uncertainty.",
        `Immutable input copies with roles and lineage: ${JSON.stringify(prepared.copies)}. Accepted motion reference version IDs: ${JSON.stringify([...new Set(motionFiles.map(file => file.version.id))])}. Source version: ${source.version.id}. Reference paths in copied JSON are original project-relative identities; use the matching sourcePath-to-localPath mapping above to open each copied file.`,
        videos.length ? `FULL NATIVE MOTION INPUT: Read ${JSON.stringify(motionInputPath)} and each view manifest for native PTS/time-base, per-frame timestamps, hashes and ordered attachment paths. All ${decodedImages.length} frames are attached AFTER appearance images. Paths are relative to your working directory. Native video FPS is distinct from requested 3D FPS (${fps}); use elapsed native time to map motion to the output timeline. Report observed motion phases, contact/occlusion uncertainty and any loop-closure correction in the result summary/warnings. Revisions retain this same original reference. Do not alter the rig skin, armature modifiers or skeleton, or introduce constraints/drivers that cannot be transferred as Actions to Unity. A file/hash inspection alone is not a visual motion assessment.` : "Text-only motion has no video evidence; do not claim one.",
        "Inspect original appearance references, source scene, generated pose/motion and requested changes. Save progress into result.json atomically only after the .blend is saved. Return completed only for an actual saved scene ready for human review; host Blender independently verifies and exports/renders it. If a request conflicts with preservation constraints, return needs_input with a concrete limitation. Warnings must be factual. Do not invent validation or auto-accept the result.",
        `USER REQUEST (content instructions only):\n${task.instruction}`,
      ].join("\n\n");
      const worker = (dependencies.workerFactory ?? (() => new CodexWorker()))();
      write(dispatchPath, { schemaVersion: 1, identity, taskId: task.id, operation: task.taskId, startedAt: new Date().toISOString(), requestedModel: "gpt-6-astra", automaticRetries: 0,
        ...(videos.length ? { motionInput: { path: relative(root, motionInputPath), sha256: hashFile(motionInputPath), frameCount: decodedImages.length } } : {}) });
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
      unchanged(motionProtected);
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
    await invoke({ mode: "validate", identity, nonce, validatorFingerprint, operation: task.taskId, sourceSha256: source.sha256, sourceBlend: prepared.preparedBlend, outputBlend: blend, baseline: prepared.baseline, output: validation, report: reportPath, actionName, clipName, fps, duration, loop: Boolean(task.settings.loop), ...contract,
      rigFeatures, ...(rigContract ? { rigContract } : {}) }, "validate-request");
    unchanged(protectedFiles);
    if (hashFile(prepared.baseline) !== prepared.baselineSha256) throw Error("원본 Blender 검사 기록이 변경됐습니다.");
    const report = read(reportPath);
    if (report.identity !== identity || report.nonce !== nonce || report.operation !== task.taskId || report.sourceSha256 !== source.sha256 || report.outputSha256 !== hashFile(blend) || report.passed !== true || !report.meshes?.length || !Array.isArray(report.files)) throw Error("실제 Blender 결과의 검증 증거가 잘못됐습니다.");
    const modelOperation = task.taskId.startsWith("M");
    const required = task.taskId === "M15" ? ["newGeometry"] : task.taskId === "M07" ? ["partition", "materials", "skeleton", "actionsPreserved"] : ["meshLineage", "topology", "materials", "actionsPreserved", ...(!modelOperation ? ["weights", "deformation"] : []), ...(animation ? ["skeleton", "clipRange", "motion", "skinPreserved", "armatureModifiersPreserved", "animationDependencies", "animationSkeletonPreserved"] : []), ...(task.taskId === "M06" ? ["partialEdit"] : [])];
    if (required.some(check => report.checks?.[check] !== true)) throw Error("Blender 원본 보존·변형·액션 검사가 통과하지 않았습니다.");
    if (["R01", "R02"].includes(task.taskId) && rigFeatures.length && (report.checks?.rigFeatures !== true || rigFeatures.some(feature => !report.rigFeatures?.[feature]?.length))) throw Error("요청한 부속 관절의 웨이트·실제 변형 검사가 없습니다.");
    if (rigContract && (report.checks?.humanoid !== true || JSON.stringify(report.humanoid?.contract) !== JSON.stringify(rigContract) || report.humanoid?.armatureCount !== 1 || report.humanoid?.jointEvidence?.length !== rigContract.humanBones.length - 1)) throw Error("요청한 Humanoid 본 매핑·관절별 실제 변형 검사가 없습니다.");
    if (Object.entries(contract.locks).some(([lock, enabled]) => enabled && report.checks?.[{ topology: "topology", materials: "materials", rig: "skeleton" }[lock]!] !== true)) throw Error("명시한 구조 잠금 검사가 통과하지 않았습니다.");
    const outputFiles: GraphicsNativeResult["files"] = [{ path: relative(root, blend), kind: "blend" }];
    for (const item of report.files) {
      if (typeof item !== "string") throw Error("Blender 출력 파일 목록이 잘못됐습니다.");
      const output = fileWithin(validation, item), extension = path.extname(output).toLowerCase();
      if (!(task.taskId === "M07" ? [".glb", ".png", ".blend", ".fbx"] : [".glb", ".png"]).includes(extension) || !fs.statSync(output).size) throw Error("Blender 출력 파일 형식이 잘못됐습니다.");
      if (extension === ".glb") {
        const bytes = fs.readFileSync(output);
        if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "glTF" || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw Error("Blender GLB 미리보기가 손상됐습니다.");
      }
      const outputPath = relative(root, output);
      if (outputFiles.some(file => file.path === outputPath)) throw Error("Blender 출력 파일 경로가 중복됩니다.");
      outputFiles.push({ path: outputPath, kind: extension === ".blend" ? "blend" : extension === ".png" ? "image" : "model" });
    }
    if (!outputFiles.some(file => file.kind === "model") || outputFiles.filter(file => file.kind === "image").length < 3) throw Error("실제 모델·정면·측면·후면 미리보기가 없습니다.");
    outputFiles.push({ path: relative(root, reportPath), kind: "report" });
    if (fs.existsSync(motionInputPath)) outputFiles.push({ path: relative(root, motionInputPath), kind: "report" });
    if (recoveredWithoutMessage) write(path.join(folder, "native-recovery.json"), { schemaVersion: 1, identity, mode: "saved-blend-without-completion-message", outputSha256: hashFile(blend), validation: relative(root, reportPath), modelTurns: 0, recoveredAt: new Date().toISOString() });
    const warnings = [...authored.warnings.filter((value: unknown) => typeof value === "string").slice(0, 30), "구조 검사를 통과했습니다. 요청한 형태·스타일·해부학적 품질·접지·관통·루프의 시각 품질과 Unity 재생은 별도 검토가 필요합니다."];
    const candidates: NonNullable<GraphicsNativeResult["candidates"]> = [];
    if (task.taskId === "M07") {
      const used = new Set<string>();
      if (!Array.isArray(report.candidates) || report.candidates.length !== contract.requestedParts.length) throw Error("분리 파츠별 결과 명세가 없습니다.");
      for (const part of contract.requestedParts) {
        const matches = report.candidates.filter((item: any) => item.slot === part.id);
        if (matches.length !== 1 || !Array.isArray(matches[0].files) || !matches[0].meshIds?.length) throw Error("분리 파츠 결과가 누락되거나 중복됐습니다.");
        const files = matches[0].files.map((item: unknown) => {
          if (typeof item !== "string") throw Error("분리 파츠 파일 명세가 잘못됐습니다.");
          const candidatePath = relative(root, fileWithin(validation, item)), file = outputFiles.find(file => file.path === candidatePath);
          if (!file || used.has(candidatePath)) throw Error("분리 파츠 파일이 검증 목록 밖이거나 다른 파츠와 중복됩니다.");
          used.add(candidatePath); return file;
        });
        if (![".blend", ".fbx", ".glb"].every(extension => files.some((file: { path: string }) => file.path.endsWith(extension))) || files.filter((file: { kind: string }) => file.kind === "image").length < 3) throw Error("각 파츠에 편집 가능한 BLEND·FBX·GLB 및 세 방향 미리보기가 필요합니다.");
        candidates.push({ slot: `part-${part.id}`, label: part.label, files: [...files, outputFiles.at(-1)!], role: "model", warnings });
      }
      if (used.size !== report.files.length) throw Error("어느 파츠에도 연결되지 않은 분리 출력이 있습니다.");
    }
    const labels: Record<string, string> = { M05: "형태·비율 보정", M06: "부분 형태 수정", M07: "파츠 분리", M08: "파츠 조립", M15: "새 Blender 모델" };
    const result: GraphicsNativeResult = { files: outputFiles, label: animation ? `${clipName} · ${task.taskId === "N06" ? "동작 수정" : "3D 동작"}` : labels[task.taskId] ?? "리그·웨이트", role: animation ? "animation" : task.taskId === "M05" ? source.version.role : modelOperation ? "model" : "rig", slot: animation ? clipName : "main", warnings, ...(candidates.length ? { candidates } : {}), ...(fs.existsSync(path.join(folder, "usage.json")) ? { usage: read(path.join(folder, "usage.json")) } : {}) };
    write(checkpointPath, { schemaVersion: 1, identity, validatorFingerprint, createdAt: new Date().toISOString(), files: outputFiles.map(file => { const localPath = fileWithin(root, file.path); return { path: file.path, bytes: fs.statSync(localPath).size, sha256: hashFile(localPath) }; }), result });
    return result;
  };
}
export const executeGraphicsAstra = createGraphicsAstraExecutor();
