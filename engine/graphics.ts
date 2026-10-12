import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store, uid } from "./store";
import { Engine } from "./engine";
import { findGraphicsTask, graphicsAstraTasks, graphicsVideoTasks, graphicsTripoReserved } from "../shared/graphics-catalog";
import { getGraphicsCompatibility } from "../shared/graphics-lineage";
import { workbenchUsage } from "../shared/workbench-usage";
import type { Workbench } from "../shared/workbench";
import type { Generation, Quote } from "../shared/types";
import type { AssetVersion, GraphicsAction, GraphicsFile, GraphicsObject, GraphicsRole, GraphicsTask, GraphicsWorkspace } from "../shared/graphics";
import { isGraphicsClipName } from "../shared/graphics";
import { executeGraphicsNative } from "./graphics-native";
import { executeGraphicsAstra } from "./graphics-astra";
import { prepareGraphicsVideo } from "./graphics-video";
import { executeGraphicsMotionSource } from "./graphics-motion-source";
import { readUnityTarget, prepareUnityDelivery, inspectUnityDelivery, cancelUnityDelivery } from "./graphics-unity";

const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const now = () => new Date().toISOString();
const image = /\.(png|jpe?g|webp)$/i;
const model = /\.(blend|fbx|glb|obj|stl)$/i;
const API = new Set(["M01", "M02", "M03", "M10", "T01", "T03"]);
type Options = {
  resources: string;
  native?: typeof executeGraphicsNative;
  astra?: typeof executeGraphicsNative;
  video?: typeof executeGraphicsNative;
  motionSource?: typeof executeGraphicsNative;
  prepareUnity?: typeof prepareUnityDelivery;
  legacyActive?: (id: string) => boolean;
  probe?: () => Promise<NonNullable<GraphicsWorkspace["connections"]>>;
};

/** Object workspace is an adapter over the existing submission journal, not another paid-job engine. */
export class GraphicsEngine {
  private active = new Map<string, { projectId: string; controller: AbortController }>();
  private native: typeof executeGraphicsNative;
  private astra: typeof executeGraphicsNative;
  private unity: typeof prepareUnityDelivery;
  constructor(private store: Store, private engine: Engine, private options: Options) {
    this.native = options.native ?? executeGraphicsNative;
    this.astra = options.astra ?? executeGraphicsAstra;
    this.unity = options.prepareUnity ?? prepareUnityDelivery;
    // Opening the app never starts a worker or repeats a service submission.
    for (const w of this.list()) {
      let changed = false;
      for (const t of w.tasks.filter(t => t.status === "running")) {
        if (t.taskId === "X05" && t.deliveryId && w.deliveries.some(d => d.id === t.deliveryId && d.status === "queued")) continue;
        const jobs = store.project(w.projectId).jobs.filter(j => j.quoteId === t.quoteId);
        if (jobs.length) t.backendJobIds = jobs.map(j => j.id);
        else {
          t.status = t.localOnly ? "failed" : "submission_unknown";
          t.message = "앱 종료로 실행이 중단됐습니다. 저장 결과만 복구할 수 있으며 자동 재실행하지 않습니다.";
        }
        changed = true;
      }
      if (changed) this.save(w);
    }
  }
  list() { return this.store.all<GraphicsWorkspace>("graphics"); }
  get(id: string): GraphicsWorkspace {
    this.store.project(id);
    return this.store.get<GraphicsWorkspace>("graphics", id) ?? {
      schemaVersion: 1, id, projectId: id, revision: 0, objects: [], versions: [], tasks: [], deliveries: [],
    };
  }
  private save(w: GraphicsWorkspace) {
    w.revision++;
    this.store.put("graphics", w.projectId, w);
    this.store.write(w.projectId, "graphics/workspace.json", JSON.stringify(w, null, 2));
    return w;
  }
  isActive(id: string) { return [...this.active.values()].some(a => a.projectId === id) || this.get(id).tasks.some(t => t.status === "running" && t.taskId === "X05"); }
  shutdown() { for (const a of this.active.values()) a.controller.abort(); }
  private object(w: GraphicsWorkspace, id: string) {
    const o = w.objects.find(o => o.id === id);
    if (!o) throw Error("오브젝트를 찾을 수 없습니다.");
    return o;
  }
  private verified(id: string, f: GraphicsFile) {
    const file = this.store.file(id, f.path), root = fs.realpathSync(this.store.directory(id));
    if (!fs.existsSync(file) || !fs.realpathSync(file).startsWith(root + path.sep)) throw Error("원본 파일이 없거나 프로젝트 밖에 있습니다.");
    if (fs.statSync(file).size !== f.bytes || hash(fs.readFileSync(file)) !== f.sha256) throw Error("원본 해시가 달라졌습니다. 파일을 다시 가져와 새 버전으로 등록하세요.");
    return file;
  }
  private file(id: string, rel: string, kind: string): GraphicsFile {
    const f = this.store.file(id, rel);
    const result = { path: rel.replaceAll("\\", "/"), sha256: hash(fs.readFileSync(f)), bytes: fs.statSync(f).size, kind };
    this.verified(id, result);
    return result;
  }
  private selected(w: GraphicsWorkspace, o: GraphicsObject, role: GraphicsRole) {
    return w.versions.find(v => v.id === o.accepted[`${role}:main`]);
  }
  private inputs(w: GraphicsWorkspace, o: GraphicsObject, taskId: string): AssetVersion[] {
    const refs = [...new Set(o.references.map(r => r.versionId))].map(id => w.versions.find(v => v.id === id)).filter((v): v is AssetVersion => !!v);
    const design = this.selected(w, o, "design");
    const mesh = this.selected(w, o, "model");
    const rig = this.selected(w, o, "rig");
    const material = this.selected(w, o, "material");
    const clipName = String(o.settings.clipName ?? "");
    const acceptedClip = (role: GraphicsRole) => w.versions.find(v => v.id === o.accepted[`${role}:${clipName}`]);
    let values: AssetVersion[] = [];
    if (taskId === "I01") values = refs;
    else if (["I02", "I06"].includes(taskId)) { if (!refs.length) throw Error("참고 자료를 먼저 연결하세요."); values = refs; }
    else if (["I03", "I05", "I07", "M01"].includes(taskId)) { if (!design) throw Error("사용할 이미지 버전을 먼저 채택하세요."); values = [design, ...(["I05", "I07"].includes(taskId) ? refs : [])]; }
    else if (taskId === "M02") {
      values = ["front", "left", "back", "right"].map(direction => {
        const v = w.versions.find(v => v.id === o.settings[`${direction}VersionId`]);
        if (!v || !v.files.some(f => image.test(f.path))) throw Error(`${direction} 방향의 독립 원본을 지정하세요.`);
        return v;
      });
      if (new Set(values.map(v => v.id)).size !== 4) throw Error("멀티뷰는 네 방향의 서로 다른 원본이 필요합니다.");
    } else if (taskId === "M03") values = [];
    else if (["T01", "T03", "M10"].includes(taskId)) {
      if (!mesh) throw Error("채택한 모델이 필요합니다."); values = [mesh];
    } else if (graphicsAstraTasks.has(taskId)) {
      const source = taskId === "N06" ? acceptedClip("animation") : ["R03", "N04", "N05"].includes(taskId) ? rig : mesh;
      if (!source) throw Error(taskId === "N06" ? "수정할 클립의 애니메이션을 먼저 채택하세요." : ["R03", "N04", "N05"].includes(taskId) ? "사용할 리그를 먼저 채택하세요." : "사용할 모델을 먼저 채택하세요.");
      values = [source, ...refs.filter(v => v.role !== "motion-reference")];
      if (["N04", "N06"].includes(taskId)) {
        const reference = acceptedClip("motion-reference");
        if (taskId === "N04" && !reference) throw Error("이 클립의 동작 참조 영상을 먼저 채택하세요.");
        if (reference && taskId === "N04") values.push(reference);
        if (taskId === "N06") {
          const visit = (version: AssetVersion, seen = new Set<string>()) => {
            if (seen.has(version.id)) return; seen.add(version.id);
            for (const id of version.sourceVersionIds) {
              const parent = w.versions.find(v => v.id === id);
              if (!parent) throw Error("기존 동작의 참조 원본 연결이 없습니다. 새로 만들지 않고 중지합니다.");
              if (parent.role === "motion-reference") values.push(parent);
              else if (parent.role === "animation") visit(parent, seen);
            }
          };
          visit(source);
        }
      }
    } else if (taskId === "N01") {
      const source = rig ?? mesh;
      if (!source) throw Error("측면을 렌더할 모델 또는 리그를 먼저 채택하세요.");
      values = [source];
    } else if (graphicsVideoTasks.has(taskId)) {
      const source = w.versions.find(v => v.id === o.settings.motionSourceVersionId);
      if (!source || !source.files.some(f => image.test(f.path))) throw Error("동작 영상에 사용할 원본 이미지를 선택하세요.");
      values = [source];
    } else if (["A05", "X04", "X05"].includes(taskId)) {
      const base = rig ?? mesh ?? design;
      if (!base) throw Error("가져온 자료를 채택한 뒤 실행하세요.");
      values = [base];
      if (taskId === "X05") {
        const animations = Object.entries(o.accepted).filter(([key]) => key.startsWith("animation:")).map(([, id]) => w.versions.find(v => v.id === id)!);
        values.push(...animations);
        if (material && material.id !== base.id) values.push(material);
      }
    }
    values = [...new Map(values.map(v => [v.id, v])).values()];
    for (const v of values) for (const f of v.files) this.verified(w.projectId, f);
    return values;
  }
  importFiles(id: string, objectId: string, role: GraphicsRole, sources: string[], clipName?: string) {
    const w = this.get(id), o = this.object(w, objectId);
    if (!sources.length) return w;
    if (role === "animation") {
      if (!isGraphicsClipName(clipName))
        throw Error("애니메이션 원본의 정확한 Blender 액션 이름을 100자 이내로 입력하세요. 경로 구분자와 제어 문자는 사용할 수 없습니다.");
      if (sources.length !== 1 || !/\.blend$/i.test(sources[0]))
        throw Error("기존 동작 수정용 가져오기는 액션과 리그가 담긴 편집 가능한 .blend 원본 한 개만 지원합니다. FBX·GLB·이미지는 모델 또는 참고 역할로 가져오세요.");
    }
    const allowed = /\.(png|jpe?g|webp|fbx|glb|blend|obj|mtl|stl|mp4|webm)$/i;
    for (const source of sources) if (!allowed.test(source) || !fs.statSync(source).isFile()) throw Error("지원되는 원본 파일을 선택하세요.");
    const groups = role === "design" ? sources.map(source => [source]) : [sources];
    for (const group of groups) {
      const versionId = uid(), prefix = `graphics/originals/${versionId}`;
      const common = path.dirname(group[0]);
      const names = new Set<string>();
      const files = group.map(source => {
        // Keep companion names; reject collisions rather than silently renaming texture links.
        const name = path.basename(source);
        if (names.has(name.toLowerCase())) throw Error("동반 파일 이름이 중복됩니다."); names.add(name.toLowerCase());
        if (group.length > 1 && path.dirname(source) !== common) throw Error("동반 파일은 같은 폴더에서 선택하세요.");
        const rel = `${prefix}/${name}`;
        this.store.write(id, rel, fs.readFileSync(source));
        return this.file(id, rel, role === "animation" ? "blend" : image.test(name) ? "image" : model.test(name) ? "model" : /\.(mp4|webm)$/i.test(name) ? "video" : "companion");
      });
      w.versions.push({ id: versionId, objectId: o.id, role, slot: role === "animation" ? clipName! : "main", label: path.basename(group[0]), files,
        createdAt: now(), sourceVersionIds: [], provenance: { type: "import" }, warnings: [],
        preview: files.find(f => image.test(f.path))?.path });
    }
    return this.save(w);
  }
  async action(id: string, action: GraphicsAction): Promise<GraphicsWorkspace> {
    const w = this.get(id);
    switch (action.kind) {
      case "create-object": {
        if (!["character", "weapon", "prop", "environment", "sprite", "ui", "vfx"].includes(action.objectKind)) throw Error("잘못된 대상 종류입니다.");
        const name = action.name.trim(); if (!name || name.length > 100) throw Error("이름을 1–100자로 입력하세요.");
        w.objects.push({ id: uid(), name, kind: action.objectKind, createdAt: now(), selectedTasks: [], instruction: "", settings: { count: 1, faceLimit: 10000, textureSize: 4096, scale: 1, pivot: "keep", exportFormat: "both" }, references: [], accepted: {} });
        return this.save(w);
      }
      case "update-object": {
        const o = this.object(w, action.objectId), p = action.patch;
        if (p.name !== undefined) { if (!p.name.trim() || p.name.length > 100) throw Error("이름을 확인하세요."); o.name = p.name.trim(); }
        if (p.instruction !== undefined) { if (p.instruction.length > 12000) throw Error("지시는 12,000자 이내로 입력하세요."); o.instruction = p.instruction; }
        if (p.selectedTasks) { if (p.selectedTasks.some(id => !findGraphicsTask(id))) throw Error("등록되지 않은 작업입니다."); o.selectedTasks = [...new Set(p.selectedTasks)]; }
        if (p.references) { if (p.references.some(r => !w.versions.some(v => v.id === r.versionId) || !["appearance", "style", "motion", "dimensions"].includes(r.role))) throw Error("참고 자료 연결을 확인하세요."); o.references = p.references; }
        if (p.settings) {
          if (Object.entries(p.settings).some(([key, v]) => key.length > 100 || !["string", "boolean", "number"].includes(typeof v) || (typeof v === "number" && !Number.isFinite(v)) || (typeof v === "string" && v.length > 2000))) throw Error("설정을 확인하세요.");
          o.settings = { ...o.settings, ...p.settings };
        }
        return this.save(w);
      }
      case "accept": {
        const o = this.object(w, action.objectId), v = w.versions.find(v => v.id === action.versionId && v.objectId === o.id);
        if (!v) throw Error("이 대상의 결과가 아닙니다."); for (const f of v.files) this.verified(id, f);
        o.accepted[`${v.role}:${v.slot}`] = v.id;
        // Other slots and clips remain accessible. Compatibility is checked on delivery, not by deleting history.
        return this.save(w);
      }
      case "inspect-target": w.target = readUnityTarget(this.store.project(id).unityPath || this.store.settings.unityPath); return this.save(w);
      case "audit-usage": return this.audit(id);
      case "set-tripo-budget": {
        if (!Number.isSafeInteger(action.credits) || action.credits < 0 || action.credits > 100000) throw Error("API 한도는 0–100,000크레딧의 정수로 입력하세요.");
        if (this.isActive(id) || this.engine.isProjectActive(id)) throw Error("실행이 끝난 후 한도를 변경하세요.");
        if (action.credits < graphicsTripoReserved(w)) throw Error("이미 승인한 누적 비용보다 낮게 설정할 수 없습니다.");
        w.tripoBudget = { limit: action.credits, setAt: now() }; return this.save(w);
      }
      case "probe-connections": {
        if (!this.options.probe) throw Error("연결 진단이 준비되지 않았습니다.");
        const connections = await this.options.probe();
        const latest = this.get(id); latest.connections = connections; return this.save(latest);
      }
      case "import-legacy": return this.importLegacy(id);
      case "prepare": return this.prepare(id, action.objectId, action.taskId);
      case "approve": return this.approve(id, action.taskId);
      case "recover": return this.recover(id, action.taskId);
      case "cancel": {
        const t = w.tasks.find(t => t.id === action.taskId); if (!t) throw Error("작업 없음");
        if (t.status === "review") throw Error("완료한 결과는 취소하지 않습니다. 다른 버전을 채택할 수 있습니다.");
        this.active.get(t.id)?.controller.abort();
        for (const jid of t.backendJobIds) this.engine.cancel(id, jid);
        if (t.deliveryId && t.targetProfile) {
          const index = w.deliveries.findIndex(d => d.id === t.deliveryId);
          if (index >= 0) {
            w.deliveries[index] = cancelUnityDelivery(t.targetProfile.projectPath, w.deliveries[index]);
            if (w.deliveries[index].status === "imported") {
              t.status = "review"; t.message = "중지 요청 전에 Unity 가져오기가 완료됐습니다. 전달 파일은 유지했습니다."; t.updatedAt = now(); return this.save(w);
            }
          }
        }
        t.status = "cancelled"; t.message = "사용자가 중지했습니다. 이미 제출한 원격 작업의 과금 취소를 뜻하지는 않습니다."; t.updatedAt = now();
        return this.save(w);
      }
      case "import": throw Error("앱 파일 선택 창을 사용하세요.");
    }
  }
  private prepare(id: string, objectId: string, taskId: string) {
    const w = this.get(id), o = this.object(w, objectId), definition = findGraphicsTask(taskId);
    if (!definition || definition.status === "planned") throw Error(definition?.reason ?? "등록되지 않은 작업입니다.");
    if (["A01", "A02", "A03"].includes(taskId)) throw Error("자료 가져오기·대상 추가·참고 연결 버튼을 사용하세요.");
    if (w.tasks.some(t => t.objectId === o.id && ["awaiting_approval", "running", "submission_unknown"].includes(t.status))) throw Error("이 대상의 기존 작업을 확인하거나 취소한 뒤 새 작업을 준비하세요.");
    const inputs = this.inputs(w, o, taskId);
    const count = Number(o.settings.count ?? 1);
    if (!Number.isInteger(count) || count < 1 || count > 4) throw Error("출력 개수는 1–4개입니다.");
    if (["I01", "I02", "I03", "I05", "I06", "M03", "M05", "N02", "N05", "N06"].includes(taskId) && !o.instruction.trim()) throw Error("제작 또는 수정할 내용을 입력하세요.");
    if (["N02", "N04", "N05", "N06"].includes(taskId)) {
      if (!isGraphicsClipName(o.settings.clipName)) throw Error("정확한 클립 이름을 100자 이내로 입력하세요. 경로 구분자와 제어 문자는 사용할 수 없습니다.");
      if (!Number.isFinite(Number(o.settings.duration ?? 2)) || Number(o.settings.duration ?? 2) <= 0 || Number(o.settings.duration ?? 2) > 30) throw Error("동작 길이는 0초 초과 30초 이하입니다.");
    }
    if (graphicsVideoTasks.has(taskId) && !this.options.video) throw Error("동작 영상 연결이 준비되지 않았습니다.");
    if (taskId === "X05" && !w.target) throw Error("Unity 프로젝트를 연결하고 설정을 확인하세요.");
    if (taskId === "X05") {
      const issues = getGraphicsCompatibility(o, w.versions);
      if (issues.length) throw Error(issues.join(" · "));
    }
    const snapshot = { taskId, objectId, inputVersionIds: inputs.map(v => v.id), settings: { ...o.settings }, instruction: o.instruction };
    if (graphicsAstraTasks.has(taskId)) snapshot.settings.sourceVersionId = inputs[0].id;
    if (taskId === "N06" && inputs[0].provenance.type === "import") {
      if (inputs[0].role !== "animation" || inputs[0].slot !== snapshot.settings.clipName || !inputs[0].files.some(file => /\.blend$/i.test(file.path)))
        throw Error("가져온 애니메이션의 원래 클립 이름과 편집 가능한 .blend 원본을 확인하세요.");
      if (snapshot.settings.actionName !== undefined && snapshot.settings.actionName !== inputs[0].slot)
        throw Error("가져온 애니메이션 수정은 등록한 원래 액션 이름과 같아야 합니다.");
      snapshot.settings.actionName = inputs[0].slot;
    }
    if (["M01", "M02", "M03"].includes(taskId)) snapshot.settings.model = "P2-20260801";
    if (!["I01", "I02", "I03", "I05", "I06", "I07", "M01", "M02", "M03"].includes(taskId)) snapshot.settings.count = 1;
    if (taskId === "N02") snapshot.settings.motionSourceView ??= "left";
    const t: GraphicsTask = { ...snapshot, id: uid(), createdAt: now(), updatedAt: now(), status: "awaiting_approval", requestHash: hash(JSON.stringify(snapshot)), outputVersionIds: [], backendJobIds: [], localOnly: definition.executor === "local", message: "요청을 저장했습니다. 실행 전까지 작업자·유료 서비스 호출은 없습니다." };
    t.objectSnapshot = { name: o.name, kind: o.kind, references: structuredClone(o.references), accepted: structuredClone(o.accepted) };
    if (taskId === "X05") t.targetProfile = structuredClone(w.target);
    t.requestHash = hash(JSON.stringify({ ...snapshot, object: t.objectSnapshot, target: t.targetProfile }));
    if (API.has(taskId)) {
      const q = this.apiQuote(w, o, t, inputs); t.quoteId = q.id;
      t.cost = { provider: "Tripo API", credits: q.estimatedCredits, basis: q.costSource, expiresAt: q.expiresAt };
    } else if (graphicsVideoTasks.has(taskId)) {
      t.cost = prepareGraphicsVideo({ projectRoot: this.store.directory(id), object: { ...o, settings: t.settings }, task: t, inputs }).cost;
    } else t.cost = { provider: t.localOnly ? "로컬" : "Codex", credits: t.localOnly ? 0 : null, basis: t.localOnly ? "로컬 처리 · GPT 요청 0회" : graphicsAstraTasks.has(taskId) ? "Blender + gpt-6-astra · Codex 계정 사용량. 저장 결과 복구·파일 변환은 새 GPT 요청 없이 처리합니다." : "Codex 계정 사용량을 사용합니다. 비교 가능한 실측이 없어 예상 토큰 수를 표시하지 않습니다." };
    w.tasks.push(t); return this.save(w);
  }
  private apiQuote(w: GraphicsWorkspace, o: GraphicsObject, t: GraphicsTask, inputs: AssetVersion[]): Quote {
    const p = this.store.project(w.projectId);
    const alias = (v: AssetVersion, isImage: boolean) => {
      const f = v.files.find(f => (isImage ? image : /\.(fbx|glb|obj|stl)$/i).test(f.path));
      if (!f) throw Error(isImage ? "원본 이미지가 필요합니다." : "API 입력에는 FBX/GLB/OBJ/STL 원본이 필요합니다. 먼저 형식 내보내기를 실행하세요.");
      this.verified(w.projectId, f);
      let a = p.assets.find(a => a.id === `graphics-${v.id}`);
      if (!a) a = this.engine.asset(p, f.path, isImage ? "image" : "model", v.label, "import", { id: `graphics-${v.id}` });
      return a.id;
    };
    let request: Generation, unit: number;
    if (["M01", "M02", "M03"].includes(t.taskId)) {
      request = { kind: "model", prompt: t.instruction, model: "P2-20260801", count: Number(t.settings.count), faceLimit: Number(t.settings.faceLimit ?? 10000), quad: t.settings.quad !== false, texture: false, inputMode: t.taskId === "M03" ? "text" : t.taskId === "M02" ? "multiview" : "image" };
      if (t.taskId === "M01") request.sourceId = alias(inputs[0], true);
      if (t.taskId === "M02") request.sourceIds = inputs.map(v => alias(v, true));
      unit = 100;
    } else if (t.taskId === "T01") {
      request = { kind: "smart-uv", model: "default", prompt: "", count: 1, sourceId: alias(inputs[0], false), bake: true }; unit = 20;
    } else if (t.taskId === "M10") {
      request = { kind: "retopology", model: "v2.0", prompt: "", count: 1, sourceId: alias(inputs[0], false), faceLimit: Number(t.settings.faceLimit ?? 10000), quad: t.settings.quad !== false, bake: true }; unit = 30;
    } else {
      const resolution = Number(t.settings.textureSize ?? 4096);
      if (![2048, 4096, 8192].includes(resolution)) throw Error("텍스처 해상도는 2048/4096/8192 중 선택하세요.");
      request = { kind: "texture", model: "v3.5-20260815", prompt: t.instruction, count: 1, sourceId: alias(inputs[0], false), textureQuality: resolution === 8192 ? "extreme" : resolution === 4096 ? "detailed" : "standard", pbr: true }; unit = resolution === 8192 ? 30 : resolution === 4096 ? 20 : 10;
    }
    this.store.save(p);
    const q = this.engine.quote(w.projectId, request);
    q.estimatedCredits = unit * request.count;
    q.costSource = `2026-10-12 공식 API 공개 요금 기준 ${unit} × ${request.count} = ${q.estimatedCredits}크레딧. Studio 구독과 별도. 계정별 할인·실시간 견적은 미확인. https://developers.tripo3d.ai/en/pricing`;
    this.store.quote(q); return q;
  }
  private async approve(id: string, taskId: string) {
    let w = this.get(id), t = w.tasks.find(t => t.id === taskId);
    if (!t || t.status !== "awaiting_approval") throw Error("승인 대기 중인 요청이 아닙니다.");
    if (this.isActive(id) || this.options.legacyActive?.(id) || this.engine.isProjectActive(id)) throw Error("다른 제작이 진행 중입니다. 완료 후 실행하세요.");
    const o = { ...this.object(w, t.objectId), ...t.objectSnapshot }, inputs = t.inputVersionIds.map(vid => w.versions.find(v => v.id === vid)!);
    for (const v of inputs) { if (!v) throw Error("고정 입력 버전이 없습니다."); for (const f of v.files) this.verified(id, f); }
    if (t.taskId === "X05") {
      if (!t.objectSnapshot?.accepted) throw Error("이전 Unity 요청에 채택 버전의 고정 기록이 없습니다. 기존 요청을 취소하고 전달을 다시 준비하세요.");
      const issues = getGraphicsCompatibility(o, w.versions);
      if (issues.length) throw Error(issues.join(" · "));
    }
    if (API.has(t.taskId)) {
      const q = this.store.get<Quote>("quote", t.quoteId!);
      if (!q || q.consumed) throw Error("이미 사용했거나 없는 견적입니다. 기존 결과 확인을 사용하세요.");
      if (w.tripoBudget && graphicsTripoReserved(w) + (q.estimatedCredits ?? Infinity) > w.tripoBudget.limit) throw Error(`Tripo 누적 승인 한도 ${w.tripoBudget.limit}크레딧을 넘습니다. 이미 승인 ${graphicsTripoReserved(w)}, 이번 ${q.estimatedCredits}크레딧. 업로드·제출하지 않았습니다.`);
      if (q.expiresAt < Date.now() || q.revision !== this.store.project(id).revision) {
        const fresh = this.apiQuote(w, o, t, inputs); t.quoteId = fresh.id;
        t.cost = { provider: "Tripo API", credits: fresh.estimatedCredits, basis: fresh.costSource, expiresAt: fresh.expiresAt };
        t.message = "견적만 갱신했습니다. 새 비용 카드를 확인하고 다시 실행하세요. 업로드·생성은 하지 않았습니다.";
        return this.save(w);
      }
      const controller = new AbortController();
      this.active.set(t.id, { projectId: id, controller });
      try {
        // Account metadata is host code; insufficient/unknown balance never consumes a quote or uploads files.
        const account = await this.engine.tripo.balance();
        w = this.get(id); t = w.tasks.find(task => task.id === taskId);
        if (controller.signal.aborted || !t || t.status !== "awaiting_approval") throw Error("실행 확인이 취소됐습니다. 업로드·제출하지 않았습니다.");
        if (typeof account?.balance !== "number" || !Number.isFinite(account.balance)) throw Error("Tripo API 잔액을 확인하지 못했습니다. 업로드·제출하지 않았습니다.");
        if (account.balance < q.estimatedCredits!) throw Error(`Tripo API 잔액이 부족합니다. 현재 ${account.balance}, 예상 ${q.estimatedCredits}크레딧입니다. Studio 구독 잔액과 별도이며 업로드·제출하지 않았습니다.`);
        if (q.expiresAt < Date.now() || q.revision !== this.store.project(id).revision) {
          const fresh = this.apiQuote(w, o, t, inputs); t.quoteId = fresh.id;
          t.cost = { provider: "Tripo API", credits: fresh.estimatedCredits, basis: fresh.costSource, expiresAt: fresh.expiresAt };
          t.message = "잔액 확인 중 견적이 만료되어 비용 카드만 갱신했습니다. 다시 확인 후 실행하세요.";
          return this.save(w);
        }
        for (const version of inputs) for (const file of version.files) this.verified(id, file);
        if (w.tripoBudget && graphicsTripoReserved(w) + (q.estimatedCredits ?? Infinity) > w.tripoBudget.limit) throw Error("API 누적 승인 한도를 넘습니다. 업로드·제출하지 않았습니다.");
        t.paidApproval = { requestHash: t.requestHash, provider: "Tripo API", credits: q.estimatedCredits!, approvedAt: now() };
        t.status = "running"; t.updatedAt = now(); t.message = "승인한 API 요청을 한 번 제출합니다."; this.save(w);
        try { t.backendJobIds = this.engine.approve(q.id, false).map(j => j.id); }
        catch (error) { t.status = "submission_unknown"; t.message = String(error); }
        return this.save(w);
      } finally { this.active.delete(taskId); }
    }
    if (graphicsVideoTasks.has(t.taskId)) {
      if (t.cost?.provider !== "Runway" || typeof t.cost.credits !== "number" || t.cost.credits <= 0) throw Error("영상 생성 비용을 확인하지 못했습니다.");
      t.paidApproval = { requestHash: t.requestHash, provider: "Runway", credits: t.cost.credits, approvedAt: now() };
    }
    t.status = "running"; t.updatedAt = now(); t.message = t.localOnly ? "저장된 로컬 작업을 실행합니다." : graphicsAstraTasks.has(t.taskId) ? "Blender + Astra로 선택한 원본을 새 버전으로 작업합니다." : graphicsVideoTasks.has(t.taskId) ? "승인한 영상 요청을 실행합니다." : "Codex 원본 이미지 도구를 실행합니다.";
    this.save(w); this.launch(id, t.id); return this.get(id);
  }
  private launch(id: string, taskId: string, recoveryOnly = false) {
    if (this.active.has(taskId)) throw Error("이미 실행 중입니다.");
    const controller = new AbortController(); this.active.set(taskId, { projectId: id, controller });
    void this.execute(id, taskId, controller.signal, recoveryOnly).catch(error => {
      const w = this.get(id), t = w.tasks.find(t => t.id === taskId)!;
      // Native usage may exist even when output registration failed; keep it without running another worker.
      const usage = this.savedNativeUsage(id, taskId);
      if (usage !== undefined) t.usage = usage;
      if (t.status !== "cancelled") {
        const code = typeof error?.code === "string" ? error.code : undefined;
        t.status = code === "submission_unknown" ? "submission_unknown" : "failed";
        t.errorCode = code;
        t.message = error instanceof Error ? error.message : String(error); t.updatedAt = now();
      }
      this.save(w);
    }).finally(() => this.active.delete(taskId));
  }
  private savedNativeUsage(id: string, taskId: string): unknown {
    for (const relative of [`graphics/jobs/${taskId}/usage.json`, `graphics/jobs/${taskId}/astra/usage.json`]) {
      const file = this.store.file(id, relative);
      try { if (fs.statSync(file).size <= 65536) return JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* Missing metadata is unknown, not zero usage. */ }
    }
    return undefined;
  }
  private async execute(id: string, taskId: string, signal: AbortSignal, recoveryOnly = false) {
    let w = this.get(id); const t = w.tasks.find(t => t.id === taskId)!;
    const o = { ...this.object(w, t.objectId), ...t.objectSnapshot }, inputs = t.inputVersionIds.map(vid => w.versions.find(v => v.id === vid)!);
    if (t.taskId === "X05") {
      if (!t.targetProfile) throw Error("고정된 Unity 프로젝트 설정이 없습니다.");
      const delivery = await this.unity({ projectRoot: this.store.directory(id), object: { ...o, settings: t.settings }, versions: inputs, profile: t.targetProfile, blenderPath: this.store.settings.blenderPath, resources: this.options.resources, signal });
      w = this.get(id); if (signal.aborted) return;
      const priorIndex = w.deliveries.findIndex(d => d.id === delivery.id);
      if (priorIndex < 0) w.deliveries.push(delivery); else w.deliveries[priorIndex] = delivery;
      const current = w.tasks.find(x => x.id === taskId)!; current.deliveryId = delivery.id;
      current.status = delivery.status === "failed" || delivery.status === "conflict" ? "failed" : delivery.status === "imported" ? "review" : "running";
      current.message = delivery.errors.length ? delivery.errors.join(" · ") : delivery.status === "imported" ? "동일한 Unity 전달본을 재사용했습니다. 새 생성·재생은 없습니다." : "Unity 가져오기 요청을 저장했습니다. 연결된 Editor가 열리면 처리합니다. 재생은 실행하지 않습니다.";
      current.outputVersionIds = []; this.save(w); return;
    }
    const executor = t.taskId === "N01" ? this.options.motionSource ?? executeGraphicsMotionSource : graphicsAstraTasks.has(t.taskId) ? this.astra : graphicsVideoTasks.has(t.taskId) ? this.options.video! : this.native;
    const result = await executor({ projectRoot: this.store.directory(id), workspacePath: this.store.file(id, "graphics/workspace.json"), object: { ...o, settings: t.settings, instruction: t.instruction }, task: t, inputs, blenderPath: this.store.settings.blenderPath, resources: this.options.resources, signal, recoveryOnly,
      onProgress: message => { const latest = this.get(id), task = latest.tasks.find(x => x.id === taskId)!; if (task.status === "running") { task.message = message; task.updatedAt = now(); this.save(latest); } } });
    if (signal.aborted) return;
    w = this.get(id); const current = w.tasks.find(x => x.id === taskId)!;
    const files = result.files.map(f => this.file(id, f.path, f.kind));
    const groups = ["I01", "I02", "I03", "I05", "I06", "I07"].includes(t.taskId) ? files.filter(f => image.test(f.path)).map(f => [f]) : [files];
    if (!groups.length || groups.some(g => !g.length)) throw Error("등록할 원본 결과가 없습니다.");
    const versions = groups.map((group, index): AssetVersion => ({ id: uid(), objectId: o.id, role: result.role, slot: result.slot, label: result.imageCandidates?.find(c => c.path === group[0].path)?.label ?? (groups.length > 1 ? `${result.label} ${index + 1}` : result.label), files: group, createdAt: now(), sourceVersionIds: t.inputVersionIds, provenance: { type: t.localOnly ? "local" : graphicsVideoTasks.has(t.taskId) ? "runway" : "codex", jobId: t.id }, preview: result.role === "motion-reference" ? group.find(f => /\.(mp4|webm)$/i.test(f.path))?.path : group.find(f => image.test(f.path))?.path, warnings: result.warnings }));
    w.versions.push(...versions); current.outputVersionIds = versions.map(v => v.id); current.status = "review"; current.message = "원본을 보존해 새 결과를 등록했습니다. 확인 후 채택하세요."; current.updatedAt = now(); current.usage = result.usage;
    this.save(w);
  }
  async recover(id: string, taskId: string) {
    const w = this.get(id), t = w.tasks.find(t => t.id === taskId);
    if (!t || !["failed", "submission_unknown"].includes(t.status)) throw Error("복구할 중단 작업이 없습니다.");
    if (this.isActive(id) || this.options.legacyActive?.(id) || this.engine.isProjectActive(id)) throw Error("다른 제작이 실행 중입니다.");
    if (t.taskId === "X05" && !t.objectSnapshot?.accepted && !t.deliveryId) throw Error("이전 Unity 요청에 고정된 채택 기록이 없습니다. 새 전달 요청을 준비하세요. 원본은 보존됩니다.");
    if (t.quoteId) {
      const p = this.store.project(id), jobs = p.jobs.filter(j => j.quoteId === t.quoteId);
      if (!jobs.length || jobs.some(j => !j.remoteId)) throw Error("제출 확인이 없어 자동 재제출하지 않습니다. API 작업 ID를 확인하세요.");
      t.backendJobIds = jobs.map(j => j.id); t.status = "running"; this.save(w);
      for (const j of jobs) await this.engine.poll(id, j.id);
      this.sync(); return this.get(id);
    }
    if (!t.localOnly) {
      const readProof = (relative: string) => {
        try {
          const file = this.store.file(id, relative), root = fs.realpathSync(this.store.directory(id));
          if (!fs.statSync(file).isFile() || fs.statSync(file).size > 1_000_000 || !fs.realpathSync(file).startsWith(root + path.sep)) return undefined;
          return JSON.parse(fs.readFileSync(file, "utf8"));
        } catch { return undefined; }
      };
      if (graphicsVideoTasks.has(t.taskId)) {
        const packet = readProof(`graphics/jobs/${t.id}/external-request.json`);
        const state = readProof(`graphics/video-journal/${t.objectId}/${t.id}-state.json`);
        const receipt = readProof(`graphics/jobs/${t.id}/external-result.json`);
        if (packet?.jobId !== t.id || (!receipt && (typeof state?.taskId !== "string" || !/^[\w-]{1,200}$/.test(state.taskId))))
          throw Error("기존 영상의 원격 작업 ID 또는 저장 결과가 없습니다. 복구에서 첫 업로드·유료 제출을 시작하지 않습니다.");
      } else {
        const relative = graphicsAstraTasks.has(t.taskId) ? `graphics/jobs/${t.id}/astra/dispatch.json` : `graphics/jobs/${t.id}/dispatch.json`;
        if (readProof(relative)?.taskId !== t.id) throw Error("저장된 원본 생성 실행 기록이 없습니다. 복구에서 새 GPT 요청을 시작하지 않습니다.");
      }
    }
    // Recovery explicitly forbids first dispatch even when failure happened before
    // a durable record. Executors recheck this independently at their boundary.
    t.status = "running"; t.message = "기존 저장 결과와 로컬 완료 지점만 복구합니다."; this.save(w); this.launch(id, t.id, true); return this.get(id);
  }
  sync() {
    for (const w of this.list()) {
      let changed = false;
      const p = this.store.project(w.projectId);
      for (const t of w.tasks.filter(t => t.status === "running" && t.quoteId)) {
        const jobs = p.jobs.filter(j => j.quoteId === t.quoteId);
        if (!jobs.length) continue;
        if (jobs.some(j => ["queued", "submitting", "running"].includes(j.status))) continue;
        t.backendJobIds = jobs.map(j => j.id);
        const batchAssets = p.assets.filter(a => jobs.some(j => j.id === a.jobId && j.status === "success"));
        const newVersions: AssetVersion[] = [];
        try {
          const pending = jobs.filter(j => j.status === "success" && !w.versions.some(v => v.provenance.jobId === j.id));
          if (pending.length) {
            const inputs = t.inputVersionIds.map(versionId => w.versions.find(version => version.id === versionId));
            if (inputs.some(version => !version || version.objectId !== t.objectId)) throw Error("고정 입력 버전의 계보가 없습니다.");
            for (const version of inputs) for (const file of version!.files) this.verified(w.projectId, file);
            for (const j of pending) {
              const sourceIds = [j.request.sourceId, ...(j.request.sourceIds ?? [])].filter((value): value is string => !!value);
              if (j.request.sourceTaskId || JSON.stringify(sourceIds) !== JSON.stringify(inputs.map(version => `graphics-${version!.id}`)))
                throw Error("API 결과의 입력 연결이 고정한 버전과 다릅니다.");
              for (const [index, sourceId] of sourceIds.entries()) {
                const alias = p.assets.find(asset => asset.id === sourceId);
                const original = inputs[index]!.files.find(file => (["M01", "M02"].includes(t.taskId) ? image : /\.(fbx|glb|obj|stl)$/i).test(file.path));
                if (!alias || !original || alias.file !== original.path || (alias.nativeFile ?? alias.file) !== original.path)
                  throw Error("API 업로드 원본과 고정한 입력 파일이 다릅니다.");
              }
              for (const a of this.engine.verifiedTripoAssets(w.projectId, j.id)) {
                const rels = [...new Set([a.nativeFile, a.file, ...(j.nativeFiles ?? [])].filter((r): r is string => typeof r === "string"))];
                const files = rels.map(rel => this.file(w.projectId, rel, a.kind));
                const label = (findGraphicsTask(t.taskId)?.name ?? a.label) + (batchAssets.length > 1 ? ` · ${batchAssets.indexOf(a) + 1}` : "");
                const v: AssetVersion = { id: uid(), objectId: t.objectId, role: "model", slot: "main", label, files, createdAt: now(), sourceVersionIds: t.inputVersionIds, provenance: { type: "tripo", jobId: j.id, remoteId: j.remoteId }, warnings: j.message ? [j.message] : [] };
                newVersions.push(v);
              }
            }
          }
        } catch (error) {
          t.status = "failed"; t.message = `API 결과 등록 보류 · ${error instanceof Error ? error.message : String(error)} · 원본·원격 작업 ID 유지, 자동 재생성 없음`;
          t.updatedAt = now(); changed = true; continue;
        }
        w.versions.push(...newVersions); t.outputVersionIds.push(...newVersions.map(version => version.id));
        t.status = jobs.some(j => j.status === "submission_unknown") ? "submission_unknown" : jobs.every(j => j.status === "success") && t.outputVersionIds.length ? "review" : "failed";
        t.message = t.status === "review" ? "API 원본을 수집했습니다. 외형·UV·재질을 검토한 뒤 채택하세요." : jobs.map(j => j.message ?? j.status).join(" · "); t.updatedAt = now(); changed = true;
      }
      for (let i = 0; i < w.deliveries.length; i++) {
        const d = w.deliveries[i];
        const owner = w.tasks.find(t => t.deliveryId === d.id);
        if (d.status !== "queued" || !owner?.targetProfile || owner.status === "cancelled") continue;
        const next = inspectUnityDelivery(owner.targetProfile.projectPath, d);
        if (JSON.stringify(next) !== JSON.stringify(d)) { w.deliveries[i] = next; changed = true; }
        if (next.status !== "queued") {
          const t = w.tasks.find(t => t.deliveryId === d.id && t.status === "running");
          if (t) { t.status = next.status === "imported" ? "review" : "failed"; t.message = next.status === "imported" ? "Unity 가져오기 완료. Play Mode는 실행하지 않았습니다." : next.errors.join(" · "); t.updatedAt = now(); changed = true; }
        }
      }
      if (changed) this.save(w);
    }
  }
  private importLegacy(id: string) {
    const w = this.get(id), p = this.store.project(id);
    let o = w.objects.find(o => o.id === "legacy");
    if (!o) { o = { id: "legacy", name: `${p.name} · 기존 결과`, kind: "prop", createdAt: now(), selectedTasks: [], instruction: "", settings: { count: 1 }, references: [], accepted: {} }; w.objects.push(o); }
    for (const a of p.assets) {
      const versionId = `legacy-${a.id}`;
      if (w.versions.some(v => v.id === versionId) || a.id.startsWith("graphics-")) continue;
      try { const files = [...new Set([a.file, a.nativeFile].filter((v): v is string => !!v))].map(rel => this.file(id, rel, a.kind));
        w.versions.push({ id: versionId, objectId: o.id, role: a.kind === "image" ? "design" : "model", slot: "main", label: a.label, files, createdAt: a.createdAt, sourceVersionIds: [], provenance: { type: "legacy", jobId: a.jobId }, warnings: [] });
      } catch { /* Missing originals remain in legacy history; do not invent copies. */ }
    }
    const roles: Record<string, GraphicsRole> = { concept: "design", separate: "design", model: "model", surface: "model", assembly: "model", rig: "rig", reference: "motion-reference", animation: "animation" };
    for (const bench of this.store.all<Workbench>("workbench").filter(b => b.projectId === id)) {
      for (const j of bench.jobs.filter(j => j.status === "review" && roles[j.step])) for (const c of j.candidates) {
        const versionId = `legacy-${j.id}-${c.id}`; if (w.versions.some(v => v.id === versionId)) continue;
        try { const files = c.artifacts.map(f => { this.verified(id, f); return { path: f.path, kind: f.kind, sha256: f.sha256, bytes: f.bytes }; });
          w.versions.push({ id: versionId, objectId: o.id, role: roles[j.step], slot: j.step === "animation" ? j.slot : "main", label: c.label, files, createdAt: j.createdAt, sourceVersionIds: [], provenance: { type: "legacy", jobId: j.id }, warnings: ["기존 기록에서 가져온 결과입니다. 새 작업 공간에서는 채택을 다시 확인하세요."] });
        } catch { /* Invalid old artifacts stay visible in the original workbench only. */ }
      }
    }
    return this.save(w);
  }
  private audit(id: string) {
    const w = this.get(id);
    const oldEntries = this.store.all<Workbench>("workbench").flatMap(b => b.jobs.map(job => ({ projectId: b.projectId, createdAt: job.createdAt, job, task: undefined as GraphicsTask | undefined })));
    const newEntries = this.list().flatMap(space => space.tasks.filter(task => task.status !== "awaiting_approval" && (task.status !== "cancelled" || task.usage !== undefined)).map(task => ({ projectId: space.projectId, createdAt: task.createdAt, task, job: undefined as Workbench["jobs"][number] | undefined })));
    const entries = [...oldEntries, ...newEntries].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10);
    const usage = { sampledJobs: entries.length, measuredWorkers: 0, missingWorkers: 0, localExecutions: 0, inputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, findings: [] as { severity: "info" | "warning"; message: string }[] };
    let apiTasks = 0;
    for (const entry of entries) {
      if (entry.job) {
        const u = workbenchUsage(entry.job); usage.measuredWorkers += u.measured; usage.missingWorkers += u.missing; usage.localExecutions += u.local; usage.inputTokens += u.input; usage.cachedInputTokens += u.cached; usage.uncachedInputTokens += u.uncached; usage.outputTokens += u.output;
      } else if (entry.task) {
        const task = entry.task;
        if (task.localOnly) { usage.localExecutions++; continue; }
        if (API.has(task.taskId)) { apiTasks++; continue; }
        const raw = (task.usage ?? this.savedNativeUsage(entry.projectId, task.id)) as { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } | undefined;
        if (!raw || ![raw.input_tokens, raw.cached_input_tokens, raw.output_tokens].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) || raw.cached_input_tokens! > raw.input_tokens!) { usage.missingWorkers++; continue; }
        usage.measuredWorkers++; usage.inputTokens += raw.input_tokens!; usage.cachedInputTokens += raw.cached_input_tokens!; usage.uncachedInputTokens += raw.input_tokens! - raw.cached_input_tokens!; usage.outputTokens += raw.output_tokens!;
      }
    }
    const repeated = entries.filter(e => (e.job?.externalExecution?.workerHistory?.length ?? 0) > 0).length;
    if (repeated) usage.findings.push({ severity: "warning", message: `${repeated}개 작업에 반복 작업자 실행 기록이 있습니다. 재시도분이 전부 낭비였는지는 이 집계만으로 확정할 수 없습니다.` });
    usage.findings.push({ severity: "info", message: "새 작업 공간과 기존 단계의 최근 최대 10개 실행 기록입니다. 승인 대기는 제외합니다. 개발 채팅·계정 잔여 퍼센트와 동일하지 않으며, 캐시 입력도 별도 표시합니다." });
    if (apiTasks) usage.findings.push({ severity: "info", message: `${apiTasks}개 Tripo API 작업의 업로드·조회·수집은 앱 코드로 처리하며 GPT를 호출하지 않습니다. 서비스 크레딧은 별도입니다.` });
    if (usage.missingWorkers || !usage.measuredWorkers) usage.findings.push({ severity: "warning", message: "사용량 기록이 없는 실행은 0으로 단정하지 않습니다. 동일 품질 전후 비교가 아직 없어 절감률은 미확정입니다." });
    w.usage = usage; return this.save(w);
  }
}
