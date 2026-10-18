import { isGraphicsProductionFile } from '../shared/graphics';
import { runGraphicsExternalRig } from './graphics-external-rig';
import { runGraphicsAutoRig, inspectSavedGraphicsAutoRig, probeGraphicsAutoRig } from './graphics-auto-rig';
import { autoRigOrientation, validateAutoRigRepairs, type AutoRigAction, type AutoRigRun, type AutoRigInspection } from '../shared/graphics-auto-rig';
import type { ExternalRigAction, ExternalRigWorkspaceHandoff } from '../shared/graphics-external-rig';
import { validateUnityRigContract, type UnityRigContract } from '../shared/graphics-rig';
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store, uid } from "./store";
import { Engine } from "./engine";
import { findGraphicsTask, graphicsAstraTasks, graphicsVideoTasks, graphicsProceduralTasks, graphicsTripoReserved } from "../shared/graphics-catalog";
import { getGraphicsCompatibility } from "../shared/graphics-lineage";
import { workbenchUsage } from "../shared/workbench-usage";
import type { Workbench, WorkbenchRuntimeApproval, WorkbenchRuntimeAnswer } from "../shared/workbench";
import type { Generation, Quote } from "../shared/types";
import type { AssetVersion, GraphicsAction, GraphicsFile, GraphicsObject, GraphicsRole, GraphicsTask, GraphicsWorkspace, UnityClipSettings } from "../shared/graphics";
import { isGraphicsClipName, graphicsLegacyUnlinkProblem, requiresPartSpaceRestoration, requiresPartSourcePreparation, surfaceRepairSources } from "../shared/graphics";
import { restoreTripoPartPreservation } from './tripo-part-preservation';
import { prepareTripoPartSource, preflightTripoPartSource } from './tripo-part-source';
import { inspectGraphicsSurface } from './graphics-surface-preflight';
import { repairGraphicsSurface } from './graphics-surface-repair';
import { runGraphicsPlanar, validatePlanarReport, validateSavedPlanarCandidate, planarCompanions } from './graphics-planar';
import { validatePlanarSelection, type PlanarSelection, type PlanarInspection, CURRENT_PLANAR_ALGORITHM } from '../shared/graphics-planar';
import { compileCreation, validateCreation, creationCompositionStrategy } from "../shared/graphics-creation";
import { freezeUnityRigContract } from '../shared/graphics-rig';
import { DEFAULT_MODEL_FACE_LIMIT, requireModelGeometry } from '../shared/graphics-model-geometry';
import { graphicsInputSupportProblem } from '../shared/graphics-input-support';
import { executeGraphicsProcedural, proceduralProblem } from "./graphics-procedural";
import { executeGraphicsNative } from "./graphics-native";
import { executeGraphicsAstra } from "./graphics-astra";
import { prepareGraphicsVideo, prepareGraphicsVideoUploadRetry } from "./graphics-video";
import { executeGraphicsMotionSource } from "./graphics-motion-source";
import { prepareGraphicsMotionImport } from "./graphics-motion-import";
import { readUnityTarget, prepareUnityDelivery, inspectUnityDelivery, cancelUnityDelivery } from "./graphics-unity";
import { inspectGraphicsStorage } from './graphics-storage';
import { validateContactReview } from '../shared/graphics-contact';

const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const now = () => new Date().toISOString();
const image = /\.(png|jpe?g|webp)$/i;
const model = /\.(blend|fbx|glb|obj|stl)$/i;
const API = new Set(["M01", "M02", "M03", "M10", "T01", "T03"]);
const BATCH = new Set(['M04', 'M15', 'N02', 'N04', 'N05', 'N06']);
/** Bind delivery to the adopted version's producer, never the currently edited clip form. */
export function freezeUnityClipSettings(workspace: GraphicsWorkspace, versions: AssetVersion[]): UnityClipSettings[] {
  return versions.filter(version => version.role === 'animation').flatMap(version => {
    const producer = workspace.tasks.find(task => task.objectId === version.objectId && task.outputVersionIds.includes(version.id));
    if (!producer) {
      if (version.provenance.type === 'codex') throw Error('채택한 동작의 생성 설정이 없습니다. 반복·이동·FPS를 확인해야 합니다.');
      return [];
    }
    const fps = Number(producer.settings.fps ?? 30);
    if (!['N04','N05','N06'].includes(producer.taskId) || producer.settings.clipName !== version.slot || !Number.isFinite(fps) || fps < 1 || fps > 120)
      throw Error('채택한 동작과 원래 클립 이름·FPS 설정이 다릅니다.');
    return [{ versionId: version.id, name: version.slot, loop: producer.settings.loop === true, rootMotion: producer.settings.rootMotion === true, fps }];
  });
}
function candidateTasks(task: GraphicsTask): GraphicsTask[] {
  const count = Number(task.settings.count ?? 1);
  if (!BATCH.has(task.taskId) || count <= 1) return [task];
  return Array.from({ length: count }, (_, index) => {
    const settings = { ...task.settings, count: 1, variationSeed: index + 1 };
    const requestHash = hash(JSON.stringify({ parent: task.requestHash, candidate: index + 1, settings }));
    return { ...task, id: `${task.id}-c${index + 1}`, settings, requestHash,
      ...(task.paidApproval ? { paidApproval: { ...task.paidApproval, requestHash, credits: task.paidApproval.credits / count } } : {}) };
  });
}
type Options = {
  resources: string;
  storageRoot?: string;
  ffmpegPath?: string;
  native?: typeof executeGraphicsNative;
  astra?: typeof executeGraphicsNative;
  video?: typeof executeGraphicsNative;
  motionSource?: typeof executeGraphicsNative;
  procedural?: typeof executeGraphicsNative;
  prepareUnity?: typeof prepareUnityDelivery;
  restorePartSpace?: typeof restoreTripoPartPreservation;
  preparePartSource?: typeof prepareTripoPartSource;
  preflightPartSource?: typeof preflightTripoPartSource;
  inspectSurface?: typeof inspectGraphicsSurface;
  repairSurface?: typeof repairGraphicsSurface;
  externalRig?: typeof runGraphicsExternalRig;
  autoRig?: typeof runGraphicsAutoRig;
  autoRigProbe?: typeof probeGraphicsAutoRig;
  planar?: typeof runGraphicsPlanar;
  legacyActive?: (id: string) => boolean;
  probe?: () => Promise<NonNullable<GraphicsWorkspace["connections"]>>;
};

/** Object workspace is an adapter over the existing submission journal, not another paid-job engine. */
export class GraphicsEngine {
  private planarQueue:{projectId:string;versionId:string}[]=[];
  private planarTimer?:ReturnType<typeof setTimeout>;
  private closing=false;
  private preparing = new Set<string>();
  private active = new Map<string, { projectId: string; controller: AbortController }>();
  private pendingApprovals = new Map<string, { projectId: string; approvalId: string; resolve: (answer: WorkbenchRuntimeAnswer) => void }>();
  private approvalQueues = new Map<string, Promise<void>>();
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
        this.closeRuntimeApproval(t, "interrupted");
        if(t.taskId==='LOCAL_PLANAR_INSPECT'||t.taskId==='LOCAL_PLANAR_REPAIR'){
          t.status='failed';t.message='앱 종료로 로컬 검사가 중단됐습니다. 저장된 완전한 결과만 복구하며 새 실행하지 않습니다.';
          changed=true;continue;
        }
        if (t.partSpaceRecoveryVersionId || t.partSourceRecoveryVersionId || t.surfaceRecoveryVersionId) {
          t.status = 'failed'; t.message = '로컬 처리가 중단됐습니다. 저장된 API 결과만 복구하며 새 제출은 하지 않습니다.';
          changed = true; continue;
        }
        if (t.taskId === "X05" && t.deliveryId && w.deliveries.some(d => d.id === t.deliveryId && d.status === "queued")) continue;
        const jobs = store.project(w.projectId).jobs.filter(j => j.quoteId === t.quoteId);
        if (jobs.length) t.backendJobIds = jobs.map(j => j.id);
        else {
          t.status = t.localOnly ? "failed" : "submission_unknown";
          t.message = "앱 종료로 실행이 중단됐습니다. 저장 결과만 복구할 수 있으며 자동 재실행하지 않습니다.";
        }
        changed = true;
      }
      for(const h of w.externalRigHandoffs??[]){if(['preparing','inspecting'].includes(h.state)){h.state='failed';h.error='앱 종료로 중단됐습니다. 저장된 완전한 결과만 명시적으로 복구할 수 있습니다.';h.updatedAt=now();changed=true;}}
      for(const run of w.autoRigRuns??[])if(run.state==='running'){run.state='failed';run.message='앱 종료로 중단됐습니다. 저장된 결과만 복구할 수 있으며 자동으로 리깅하지 않습니다.';run.updatedAt=now();changed=true;}
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
    const previous=this.store.get<GraphicsWorkspace>('graphics',w.projectId);
    const added=previous?w.versions.filter(v=>!previous.versions.some(old=>old.id===v.id)&&v.role==='model'&&v.files.some(f=>/\.(blend|fbx)$/i.test(f.path))):[];
    w.revision++;
    this.store.put("graphics", w.projectId, w);
    this.store.write(w.projectId, "graphics/workspace.json", JSON.stringify(w, null, 2));
    for(const version of added)this.planarQueue.push({projectId:w.projectId,versionId:version.id});
    if(added.length)this.schedulePlanar();
    return w;
  }
  private schedulePlanar(){if(this.closing||this.planarTimer||!this.planarQueue.length)return;this.planarTimer=setTimeout(()=>{this.planarTimer=undefined;const next=this.planarQueue[0];if(!next)return;if(this.isActive(next.projectId)||this.options.legacyActive?.(next.projectId)||this.engine.isProjectActive(next.projectId)){this.schedulePlanar();return;}this.planarQueue.shift();try{const w=this.get(next.projectId);if(!w.planarInspections?.[next.versionId]&&!w.tasks.some(t=>t.taskId==='LOCAL_PLANAR_INSPECT'&&t.inputVersionIds.includes(next.versionId)))this.planar(next.projectId,next.versionId);}catch{/* A refused local preflight never retries automatically. */}this.schedulePlanar();},500);this.planarTimer.unref?.();}
  isActive(id: string) { return [...this.active.values()].some(a => a.projectId === id) || this.get(id).tasks.some(t => t.status === "running" && t.taskId === "X05"); }
  shutdown() { this.closing=true;if(this.planarTimer)clearTimeout(this.planarTimer);this.planarQueue=[];for (const a of this.active.values()) a.controller.abort(); }
  private closeRuntimeApproval(task: GraphicsTask, decision: NonNullable<GraphicsTask["runtimeApprovalHistory"]>[number]["decision"]) {
    const request = task.runtimeApproval;
    if (!request) return;
    task.runtimeApprovalHistory = [...(task.runtimeApprovalHistory ?? []), {
      id: request.id, title: request.title, executionId: request.executionId, requestedAt: request.requestedAt, answeredAt: now(), decision,
    }].slice(-100);
    delete task.runtimeApproval;
  }
  private async requestRuntimeApproval(projectId: string, taskId: string, executionId: string, signal: AbortSignal, request: WorkbenchRuntimeApproval): Promise<WorkbenchRuntimeAnswer> {
    const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
    if (!request || !text(request.id, 200) || !request.id || !text(request.title, 500) || !text(request.detail, 20000) ||
      !Array.isArray(request.fields) || request.fields.length > 40 || request.fields.some(field => !field || !text(field.id, 200) || !field.id || !text(field.label, 6000) || typeof field.required !== "boolean" ||
        field.options !== undefined && (!Array.isArray(field.options) || field.options.length > 100 || field.options.some(option => !option || !text(option.value, 6000) || !text(option.label, 6000)))) ||
      new Set(request.fields.map(field => field.id)).size !== request.fields.length)
      throw Error("지원하지 않는 도구 확인 요청입니다. 자동 허용하지 않았습니다.");
    // Candidates can upload concurrently, but only one actionable question is shown.
    // Waiting here performs no inference, upload, or paid submission.
    const previous = this.approvalQueues.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const queued = new Promise<void>(resolve => { release = resolve; });
    this.approvalQueues.set(taskId, queued);
    try {
      await previous;
      signal.throwIfAborted();
      return await new Promise<WorkbenchRuntimeAnswer>((resolve, reject) => {
        const workspace = this.get(projectId), task = workspace.tasks.find(value => value.id === taskId);
        if (!task || task.status !== "running" || this.active.get(taskId)?.projectId !== projectId || this.pendingApprovals.has(taskId)) {
          reject(Error("이 확인 요청의 실행이 끝났습니다. 자동 허용하지 않았습니다.")); return;
        }
        // Worker-local request IDs can repeat across candidate connections. The
        // app answer is bound to a unique host ID, never that reusable source ID.
        const approvalId = uid();
        task.runtimeApproval = { ...structuredClone(request), id: approvalId, requestedAt: now(), executionId };
        task.message = "도구 접근 확인이 필요합니다. 앱에 표시된 요청 범위를 확인하고 답변하세요.";
        task.updatedAt = now();
        const abort = () => {
          this.pendingApprovals.delete(taskId);
          const latest = this.get(projectId), current = latest.tasks.find(value => value.id === taskId);
          if (current?.runtimeApproval?.id === approvalId) { this.closeRuntimeApproval(current, "cancelled"); this.save(latest); }
          resolve({ accepted: false, values: {} });
        };
        signal.addEventListener("abort", abort, { once: true });
        this.pendingApprovals.set(taskId, { projectId, approvalId, resolve: answer => {
          signal.removeEventListener("abort", abort); resolve(answer);
        } });
        this.save(workspace);
      });
    } finally {
      release();
      if (this.approvalQueues.get(taskId) === queued) this.approvalQueues.delete(taskId);
    }
  }
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
    const slot = o.settings.partId && ['design', 'model', 'material'].includes(role) ? `part-${o.settings.partId}` : 'main';
    return w.versions.find(v => v.id === o.accepted[`${role}:${slot}`] && v.objectId === o.id && v.role === role && v.slot === slot);
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
    else if (taskId === 'I08') {
      const whole = w.versions.find(v => v.id === o.accepted['design:main'] && v.objectId === o.id && v.role === 'design');
      if (!whole || !o.settings.partId) throw Error('전체 디자인을 채택하고 제작할 파츠를 선택하세요.'); values = [whole];
    }
    else if (["I03", "I05", "I07", "M01", 'M04', 'M15'].includes(taskId)) {
      if (!design) throw Error("사용할 이미지 버전을 먼저 채택하세요."); values = [design, ...(["I05", "I07", 'M15'].includes(taskId) ? refs : [])];
      if (taskId === 'M15' && o.settings.inputMode === 'multiview') {
        const views = ['front','left','back','right'].map(direction => {
          const version = w.versions.find(v => v.id === o.settings[`${direction}VersionId`] && v.objectId === o.id && v.role === 'design' && v.slot === design.slot);
          if (!version || !version.files.some(f => image.test(f.path))) throw Error(`${direction} 방향의 같은 대상·파츠 원본을 지정하세요.`); return version;
        });
        if (new Set(views.map(v => v.id)).size !== 4) throw Error('멀티뷰는 네 방향의 서로 다른 원본이 필요합니다.');
        values.push(...views);
      }
    }
    else if (taskId === "M02") {
      values = ["front", "left", "back", "right"].map(direction => {
        const v = w.versions.find(v => v.id === o.settings[`${direction}VersionId`]);
        if (!v || !v.files.some(f => image.test(f.path)) || o.creation && (v.objectId !== o.id || v.role !== 'design' || v.slot !== design?.slot)) throw Error(`${direction} 방향의 같은 대상·파츠 독립 원본을 지정하세요.`);
        return v;
      });
      if (new Set(values.map(v => v.id)).size !== 4) throw Error("멀티뷰는 네 방향의 서로 다른 원본이 필요합니다.");
    } else if (taskId === "M03") values = [];
    else if (["T01", "T02", "T03", 'T05', "M10"].includes(taskId)) {
      if (!mesh) throw Error("채택한 모델이 필요합니다."); values = [mesh];
      if (taskId === "T03") {
        const mode = o.settings.textureReference ?? "auto";
        if (mode !== "auto" && mode !== "text") throw Error("텍스처 참조는 채택 디자인 또는 설명만 사용 중 선택하세요.");
        // Match the model's selected slot; a part must not silently inherit the whole design.
        if (mode === "auto" && o.settings.partId && !design) throw Error('이 파츠에 채택한 디자인 이미지가 없습니다. 파츠 참조를 채택하거나 텍스처 입력을 설명만 사용으로 변경하세요.');
        if (mode === "auto" && design) values.push(design);
      }
    } else if (taskId === 'M09' || taskId === 'M05' && o.settings.editSourceMode === 'candidate') {
      const source = w.versions.find(v => v.id === o.settings.sourceVersionId && v.objectId === o.id && ['model', 'material'].includes(v.role));
      if (!source) throw Error('수정할 모델 후보를 결과 화면에서 선택하세요. 채택 전 후보도 수정할 수 있습니다.');
      if (o.settings.partId && source.slot !== `part-${o.settings.partId}` || taskId === 'M05' && o.settings.editSourceSlot !== source.slot) throw Error('선택한 수정 원본과 현재 파츠가 다릅니다. 해당 결과에서 다시 선택하세요.');
      values = [source, ...refs.filter(v => v.role !== 'motion-reference')];
      // Context is immutable and read-only: the original assembly plus sibling
      // parts help fit the patch without changing which candidate is repaired.
      const producer = w.tasks.find(t => t.id === source.provenance.jobId);
      if (producer) {
        const siblings = new Set<string>();
        for (const versionId of producer.taskId === 'M07' ? producer.outputVersionIds : []) {
          const version = w.versions.find(v => v.id === versionId && v.objectId === o.id && v.role === 'model');
          if (!version || version.slot === source.slot || siblings.has(version.slot)) continue;
          siblings.add(version.slot); values.push(version);
        }
        for (const versionId of producer.inputVersionIds) {
          const version = w.versions.find(v => v.id === versionId && v.objectId === o.id);
          if (!version) throw Error('수정 원본의 참조 연결이 없습니다. 작업을 시작하지 않습니다.');
          if (['model', 'material', 'rig', 'animation'].includes(version.role) && version.slot === source.slot) continue;
          values.push(version);
        }
      }
    } else if (taskId === 'M08') {
      const parts = o.creation?.parts.filter(part => part.enabled) ?? [];
      if (parts.length < 2) throw Error('조립할 파츠를 두 개 이상 설정하세요.');
      values = parts.map(part => {
        const slot = `part-${part.id}`;
        const model = w.versions.find(v => v.id === o.accepted[`model:${slot}`] && v.objectId === o.id && v.slot === slot && v.role === 'model');
        if (!model) throw Error(`${part.label} 모델을 먼저 채택하세요.`);
        const material = w.versions.find(v => v.id === o.accepted[`material:${slot}`] && v.objectId === o.id && v.slot === slot && v.role === 'material');
        if (!material) return model;
        const descendsFrom = (version: AssetVersion, wanted: string, materialOnly: boolean, seen = new Set<string>()): boolean => {
          if (version.id === wanted) return true;
          if (seen.has(version.id) || version.objectId !== o.id || version.slot !== slot || !['model', 'material'].includes(version.role)) return false;
          if (materialOnly && version.role === 'model') return false;
          const next = new Set(seen); next.add(version.id);
          return version.sourceVersionIds.some(id => { const source = w.versions.find(v => v.id === id); return !!source && descendsFrom(source, wanted, materialOnly, next); });
        };
        // The latest accepted material must refer to this exact selected shape.
        // A later assembled model already contains its ancestor's material.
        if (descendsFrom(model, material.id, false)) return model;
        if (descendsFrom(material, model.id, true)) return material;
        throw Error(`${part.label}의 채택 재질이 현재 채택 모델과 다른 형상을 참조합니다. 같은 모델에서 만든 재질과 모델을 선택한 뒤 조립하세요.`);
      });
      const whole = w.versions.find(v => v.id === o.accepted['design:main']); if (whole) values.push(whole);
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
    if (role === 'motion-reference') throw Error('동작 영상은 앱의 영상 가져오기에서 로컬 검사를 거쳐 등록하세요.');
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
      const part = o.creation?.attributes.composition === 'parts' && o.creation.activePartId && (role === 'model' && creationCompositionStrategy(o.creation) === 'independent-parts' || role === 'design' && o.creation.stageSettings.design?.values.designMode === 'parts') ? o.creation.activePartId : undefined;
      w.versions.push({ id: versionId, objectId: o.id, role, slot: role === "animation" ? clipName! : part ? `part-${part}` : "main", label: path.basename(group[0]), files,
        createdAt: now(), sourceVersionIds: [], provenance: { type: "import" }, warnings: [],
        preview: files.find(f => image.test(f.path))?.path });
    }
    return this.save(w);
  }
  /** Optional local viewport derivative. Import is durable even if Blender cannot preview it. */
  async prepareImportedPreviews(id: string, versionIds: string[], prepare: (projectId: string, sourcePath: string) => Promise<string>, throwOnFailure = false) {
    if (this.closing || this.isActive(id) || this.engine.isProjectActive(id) || this.options.legacyActive?.(id)) throw Error('현재 작업이 끝난 뒤 로컬 미리보기를 준비하세요.');
    const key = `import-preview:${id}`, controller = new AbortController();
    this.active.set(key, { projectId: id, controller });
    try {
    for (const versionId of versionIds) {
      const version = this.get(id).versions.find(v => v.id === versionId && v.provenance.type === 'import');
      if (!version || version.files.some(f => /\.glb$/i.test(f.path))) continue;
      const source = version.files.find(f => /\.(fbx|blend|obj|stl)$/i.test(f.path));
      if (!source) continue;
      const sourceFiles = version.files.map(f => ({ ...f }));
      try {
        for (const file of sourceFiles) this.verified(id, file);
        const relative = (await prepare(id, source.path)).replaceAll('\\', '/');
        if (!relative.startsWith('previews/') || !/\.glb$/i.test(relative)) throw Error('미리보기 출력 경로가 잘못됐습니다.');
        const preview = this.file(id, relative, 'preview');
        const data = fs.readFileSync(this.verified(id, preview));
        if (data.length < 12 || data.toString('ascii', 0, 4) !== 'glTF' || data.readUInt32LE(4) !== 2 || data.readUInt32LE(8) !== data.length) throw Error('미리보기 GLB 형식이 잘못됐습니다.');
        const reportFile = this.file(id, relative.replace(/\.glb$/i, '.report.json'), 'report');
        if (reportFile.bytes > 1024 * 1024) throw Error('미리보기 검사 기록이 너무 큽니다.');
        const report = JSON.parse(fs.readFileSync(this.verified(id, reportFile), 'utf8'));
        if (report.schemaVersion !== 1 || report.mode !== 'convert' || report.previewOnly !== true || report.nativeSourceSha256 !== source.sha256 || ![report.faces, report.triangles].every(v => Number.isSafeInteger(v) && v > 0) || report.triangles < report.faces) throw Error('미리보기와 원본 검사 기록이 일치하지 않습니다.');
        const latest = this.get(id), current = latest.versions.find(v => v.id === versionId);
        this.store.assertProjectAvailable(id);
        if (this.closing || controller.signal.aborted) throw Error('미리보기 등록이 중단됐습니다. 원본은 유지됩니다.');
        if (!current || JSON.stringify(current.files) !== JSON.stringify(sourceFiles)) throw Error('미리보기 처리 중 가져온 원본이 변경됐습니다.');
        for (const file of sourceFiles) this.verified(id, file);
        current.files.push(preview, reportFile);
        current.warnings = current.warnings.filter(warning => !warning.startsWith('로컬 미리보기 준비 실패'));
        current.preview = preview.path;
        this.save(latest);
      } catch (error) {
        const latest = this.get(id), current = latest.versions.find(v => v.id === versionId);
        if (current) {
          current.warnings.push(`로컬 미리보기 준비 실패 · 원본은 보존됐습니다. ${error instanceof Error ? error.message : String(error)}`);
          this.save(latest);
        }
        if (throwOnFailure) throw error;
      }
    }
    return this.get(id);
    } finally { this.active.delete(key); }
  }
  async importMotionFile(id: string, objectId: string, source: string, clipName: string) {
    const o = this.object(this.get(id), objectId);
    if (!isGraphicsClipName(clipName) || !/\.(mp4|webm)$/i.test(source) || !fs.statSync(source).isFile()) throw Error('클립 이름과 MP4/WebM 동작 원본 한 개를 확인하세요.');
    if (this.isActive(id) || this.engine.isProjectActive(id)) throw Error('현재 작업이 끝난 뒤 동작 영상을 가져오세요.');
    if (!this.options.ffmpegPath) throw Error('앱의 영상 해독 도구를 찾을 수 없습니다.');
    if (fs.statSync(source).size > 512 * 1024 ** 2) throw Error('가져올 동작 참조 영상은 512 MiB 이하여야 합니다. 원본을 변경하지 않았습니다.');
    const versionId = uid(), relative = `graphics/originals/${versionId}/${path.basename(source)}`;
    this.store.write(id, relative, fs.readFileSync(source));
    const controller = new AbortController(); this.active.set(versionId, { projectId:id, controller });
    try {
      const imported = await prepareGraphicsMotionImport({ projectRoot:this.store.directory(id), source:this.file(id,relative,'video'), versionId, clipName, ffmpegPath:this.options.ffmpegPath, signal:controller.signal });
      controller.signal.throwIfAborted();
      const w = this.get(id);
      w.versions.push({ id:versionId,objectId:o.id,role:'motion-reference',slot:imported.slot,label:imported.label,files:imported.files,preview:imported.preview,warnings:imported.warnings,createdAt:now(),sourceVersionIds:[],provenance:{type:'import'} });
      return this.save(w);
    } finally { this.active.delete(versionId); }
  }
  private async externalRigAction(id: string, action: ExternalRigAction): Promise<GraphicsWorkspace> {
    const w=this.get(id), object=this.object(w,action.objectId); let h:ExternalRigWorkspaceHandoff;
    if(action.kind==='prepare-external-rig') {
      if(this.isActive(id)||this.engine.isProjectActive(id))throw Error('현재 작업을 먼저 완료하세요.');
      const v=w.versions.find(v=>v.id===action.versionId&&v.objectId===object.id&&v.role==='model'&&v.slot==='main');
      if(!v||object.accepted['model:main']!==v.id||object.kind!=='character'||object.creation?.subject!=='human')throw Error('채택한 사람 전체 모델이 필요합니다.');
      if(w.externalRigHandoffs?.some(v=>v.objectId===object.id&&!['failed','blocked','cancelled'].includes(v.state)&&!v.candidateVersionId))throw Error('기존 외부 리그 전달을 먼저 확인하세요.');
      for(const f of v.files)this.verified(id,f);
      const source=v.files.find(f=>isGraphicsProductionFile(f)&&/\.blend$/i.test(f.path))??v.files.find(f=>isGraphicsProductionFile(f)&&/\.fbx$/i.test(f.path)); if(!source)throw Error('원본 BLEND 또는 FBX가 필요합니다.');
      h={id:uid(),objectId:object.id,sourceVersionId:v.id,source,requiredParts:(object.creation?.parts??[]).filter(p=>p.enabled).map(p=>p.id).sort(),state:'preparing',operation:'prepare',createdAt:now(),updatedAt:now()};
      (w.externalRigHandoffs??=[]).push(h);this.save(w);
    } else {
      h=w.externalRigHandoffs?.find(v=>v.id===action.handoffId&&v.objectId===object.id)!;if(!h)throw Error('전달 기록이 없습니다.');
      if(action.kind==='cancel-external-rig'){this.active.get(h.id)?.controller.abort();h.state='cancelled';h.updatedAt=now();return this.save(w);}
      if(h.state==='cancelled'||h.candidateVersionId)throw Error('취소되거나 완료한 전달은 반복하지 않습니다.');
      if(this.isActive(id)||this.engine.isProjectActive(id))throw Error('현재 작업을 먼저 완료하세요.');this.verified(id,h.source);
      if(action.kind==='inspect-external-rig') {
        if(h.preparation?.state!=='awaiting-external'||h.returnedFbx)throw Error('준비 완료 후 반환 파일 한 개를 선택하세요.');
        if(action.sourceToReturnedMatrix!==undefined&&(!Array.isArray(action.sourceToReturnedMatrix)||action.sourceToReturnedMatrix.length!==4||action.sourceToReturnedMatrix.some(r=>!Array.isArray(r)||r.length!==4||r.some(v=>typeof v!=='number'||!Number.isFinite(v)))))throw Error('명시적인 좌표 변환 행렬을 확인하세요.');
        h.sourceToReturnedMatrix=action.sourceToReturnedMatrix&&structuredClone(action.sourceToReturnedMatrix);
        const returned=path.resolve(action.returnedPath);if(!/\.fbx$/i.test(returned)||!fs.statSync(returned).isFile()||fs.lstatSync(returned).isSymbolicLink())throw Error('반환 FBX를 선택하세요.');
        const rel='graphics/external-rig/'+h.id+'/returned-original.fbx',dest=this.store.file(id,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});if(fs.existsSync(dest)){if(hash(fs.readFileSync(dest))!==hash(fs.readFileSync(returned)))throw Error('저장된 반환 원본과 선택한 FBX가 다릅니다.');}else fs.copyFileSync(returned,dest,fs.constants.COPYFILE_EXCL);h.returnedFbx=this.file(id,rel,'returned-fbx');h.operation='inspect-return';
      }
      if(action.kind==='import-external-rig') {
        if(h.inspection?.state!=='review'||!h.returnedFbx)throw Error('반환 검사와 명시적인 본 매핑이 필요합니다.');
        const reportFile=h.inspection.files.find(f=>f.kind==='report')!;const report=JSON.parse(fs.readFileSync(this.verified(id,reportFile),'utf8'));
        const names=new Set((report.bones??[]).map((b:{name:string})=>b.name));
        if(!Array.isArray(action.humanBones)||action.humanBones.some(b=>!names.has(b.boneName)))throw Error('검사된 실제 본 이름만 매핑하세요.');
        const contract:UnityRigContract={schemaVersion:2,versionId:h.id,producerVersionId:h.id,producerTaskId:h.id,rigType:'humanoid',fingers:action.fingers,hairBinding:'head',requiredParts:h.requiredParts,humanBones:action.humanBones};validateUnityRigContract([{id:h.id,role:'rig'} as AssetVersion],contract);
        h.humanBones=structuredClone(action.humanBones);h.fingers=action.fingers;h.operation='import-return';
      }
      h.state=h.operation==='prepare'?'preparing':'inspecting';h.updatedAt=now();delete h.error;this.save(w);
    }
    const controller=new AbortController();this.active.set(h.id,{projectId:id,controller});
    try {
      const result=await(this.options.externalRig??runGraphicsExternalRig)({projectRoot:this.store.directory(id),handoffId:h.id,sourceVersionId:h.sourceVersionId,source:h.source,operation:h.operation,blenderPath:this.store.settings.blenderPath,workerPath:path.join(this.options.resources,'blender','graphics_external_rig.py'),signal:controller.signal,preparationReport:h.preparation?.files.find(f=>f.kind==='report'),returnedFbx:h.returnedFbx,sourceToReturnedMatrix:h.sourceToReturnedMatrix,humanBones:h.humanBones,fingers:h.fingers,recoveryOnly:action.kind==='recover-external-rig'});
      const latest=this.get(id),current=latest.externalRigHandoffs!.find(v=>v.id===h.id)!;if(controller.signal.aborted||current.state==='cancelled')throw Error('전달을 취소했습니다.');
      current.state=result.handoff.state;current.error=result.handoff.error;current.updatedAt=now();
      if(h.operation==='prepare')current.preparation=result.handoff;else if(h.operation==='inspect-return')current.inspection=result.handoff;else {
        current.imported=result.handoff;
        if(result.handoff.state==='review') {
          if(!current.humanBones)throw Error('확인한 본 매핑이 없습니다.');
          const versionId=uid(),contract:UnityRigContract={schemaVersion:2,versionId,producerVersionId:versionId,producerTaskId:current.id,rigType:'humanoid',fingers:current.fingers===true,hairBinding:'head',requiredParts:current.requiredParts,humanBones:current.humanBones};
          const candidate:AssetVersion={id:versionId,objectId:object.id,role:'rig',slot:'main',label:'외부 반환 리그 · 검토 필요',files:result.files,createdAt:now(),sourceVersionIds:[current.sourceVersionId],provenance:{type:'local',jobId:current.id},warnings:['구조 검사만 완료했습니다. 관절 배치·포즈 변형·국소 웨이트 및 Unity Humanoid 검증은 아직 완료하지 않았습니다.'],externalRig:{schemaVersion:1,handoffId:current.id,reportPath:result.handoff.reportPath!,reportSha256:result.handoff.reportSha256,sourceSha256:current.source.sha256,returnedFbxSha256:current.returnedFbx?.sha256,contract}};
          validateUnityRigContract([candidate],contract);latest.versions.push(candidate);current.candidateVersionId=versionId;
        }
      }return this.save(latest);
    }catch(error){const latest=this.get(id),current=latest.externalRigHandoffs!.find(v=>v.id===h.id)!;current.state=controller.signal.aborted||current.state==='cancelled'?'cancelled':'failed';current.error=error instanceof Error?error.message:String(error);current.updatedAt=now();this.save(latest);throw error;}finally{this.active.delete(h.id);}
  }
  private autoRigFingerprint(run: AutoRigRun) {
    return hash(JSON.stringify({objectId:run.objectId,sourceVersionId:run.sourceVersionId,source:run.source,operation:run.operation,settings:run.settings,repairs:run.repairs,inspectionRunId:run.inspectionRunId,toolSha256:run.toolSha256}));
  }
  private autoRigOutput(id:string, run:AutoRigRun) { return this.store.file(id,`graphics/auto-rig/${run.id}`); }
  private checkAutoRigInspection(value:unknown, operation:AutoRigRun['operation']): AutoRigInspection {
    const v=value as AutoRigInspection;
    const text=(s:unknown):s is string=>typeof s==='string'&&s.length>0&&s.length<1000;
    const required=operation==='rig'?['sourceHashBound','restGeometry','topology','uv','attributes','materials','images','allWeighted','normalized','exportedBoneNames']:['sourceHashBound','geometryAndUV','outsideWeights','attributes','materials','images','skeleton','exportedBoneNames'];
    if(!v||!Array.isArray(v.checks)||required.some(id=>!v.checks.some(c=>c.id===id&&c.passed===true))||v.checks.some(c=>c.passed!==true)||!Array.isArray(v.humanBones)||!Array.isArray(v.warnings)||v.warnings.some(s=>!text(s))||!Array.isArray(v.boneNames)||!v.boneNames.length||v.boneNames.some(s=>!text(s))||new Set(v.boneNames).size!==v.boneNames.length||!Array.isArray(v.islands)||!v.islands.length||v.islands.length>100000)throw Error('자동 리그의 필수 보존 검사와 본·부위 기록이 완전하지 않습니다.');
    const ids=new Set<string>();
    for(const island of v.islands){const key=JSON.stringify([island.mesh,island.islandId]);if(!text(island.mesh)||!text(island.islandId)||ids.has(key)||!Number.isSafeInteger(island.vertices)||island.vertices<1||!Array.isArray(island.bones)||island.bones.some(b=>!text(b.name)||!Number.isFinite(b.meanWeight)||b.meanWeight<0||!Number.isFinite(b.maxWeight)||b.maxWeight<0))throw Error('검사한 연결 부위의 식별자·웨이트 기록이 잘못됐습니다.');
      if(island.vertexIndices!==undefined){const vertices=island.vertexIndices;if(!Array.isArray(vertices)||vertices.length!==island.vertices||vertices.some((value,index)=>!Number.isSafeInteger(value)||value<0||index>0&&value<=vertices[index-1])||hash('['+vertices.join(', ')+']')!==island.islandId)throw Error('검사한 부위의 정확한 정점 목록·해시가 다릅니다.');}
      ids.add(key);}
    return structuredClone(v);
  }
  private validateAutoRigCandidate(id:string,w:GraphicsWorkspace,candidate:AssetVersion){
    const meta=candidate.autoRig;if(!meta)return;
    if(candidate.role!=='rig'||candidate.slot!=='main')throw Error('자동 리그는 검사한 전체 리그 슬롯으로만 사용할 수 있습니다.');
    const run=w.autoRigRuns?.find(r=>r.id===meta.runId&&r.objectId===candidate.objectId&&r.candidateVersionId===candidate.id);
    if(!run||run.state!=='review'||run.operation==='inspect'||run.requestHash!==this.autoRigFingerprint(run)||meta.sourceSha256!==run.source.sha256||JSON.stringify(run.files)!==JSON.stringify(candidate.files)||JSON.stringify(run.reportFile)!==JSON.stringify(meta.reportFile)||candidate.provenance.jobId!==run.id||JSON.stringify(candidate.sourceVersionIds)!==JSON.stringify([run.sourceVersionId]))throw Error('자동 리그의 고정 원본·결과·실행 기록이 다릅니다.');
    const sourceVersion=w.versions.find(v=>v.id===run.sourceVersionId&&v.objectId===candidate.objectId);
    if(!sourceVersion?.files.some(f=>JSON.stringify(f)===JSON.stringify(run.source)))throw Error('자동 리그의 원본 버전·파일 연결이 변경됐습니다.');
    const inherited=sourceVersion.autoRig?.contract??sourceVersion.externalRig?.contract;
    if(meta.contract.fingers!==run.settings.fingers||meta.contract.hairBinding!=='head'||JSON.stringify(meta.contract.requiredParts)!==JSON.stringify(inherited?.requiredParts??[]))throw Error('자동 리그의 손가락·파트 설정이 고정 원본과 다릅니다.');
    this.verified(id,run.source);for(const file of run.files)this.verified(id,file);this.verified(id,meta.reportFile);
    const saved=inspectSavedGraphicsAutoRig(this.autoRigOutput(id,run));
    if(run.toolSha256!==undefined&&saved.toolSha256!==run.toolSha256)throw Error('자동 리그의 고정 작업 도구가 변경됐습니다.');
    const request=JSON.parse(fs.readFileSync(saved.requestPath,'utf8'));
    if(request.sourceSha256!==run.source.sha256||request.operation!==run.operation||request.fingers!==run.settings.fingers||JSON.stringify(request.repairs)!==JSON.stringify(run.repairs)||JSON.stringify(request.sourceToRigMatrix)!==JSON.stringify(run.operation==='rig'?autoRigOrientation(run.settings.frontAxis):undefined))throw Error('저장된 자동 리그 요청이 변경됐습니다.');
    const inspection=this.checkAutoRigInspection(saved.report.inspection,run.operation);
    if(JSON.stringify(inspection)!==JSON.stringify(run.inspection)||JSON.stringify(meta.contract.humanBones)!==JSON.stringify(inspection.humanBones)||meta.contract.producerTaskId!==run.id||meta.contract.versionId!==candidate.id||meta.contract.producerVersionId!==candidate.id||meta.contract.exportPolicy!=='auto-rig-fbx'||!candidate.files.some(f=>JSON.stringify(f)===JSON.stringify(meta.exportFbx)&&/\.fbx$/i.test(f.path)))throw Error('확인한 본 매핑·내보내기 결과가 변경됐습니다.');
    validateUnityRigContract([candidate],meta.contract);
  }
  private async autoRigAction(id:string,action:AutoRigAction):Promise<GraphicsWorkspace>{
    if(action.kind==='probe-auto-rig'){
      if(this.isActive(id)||this.engine.isProjectActive(id))throw Error('실행이 끝난 후 설치를 확인하세요.');
      const result=await(this.options.autoRigProbe??probeGraphicsAutoRig)(this.store.settings.blenderPath,path.join(this.options.resources,'blender','graphics_auto_rig.py'));
      const latest=this.get(id);latest.autoRigReadiness=result;return this.save(latest);
    }
    const w=this.get(id),object=this.object(w,action.objectId);let run:AutoRigRun;
    if(action.kind==='cancel-auto-rig'||action.kind==='recover-auto-rig'){
      const current=w.autoRigRuns?.find(r=>r.id===action.runId&&r.objectId===object.id);if(!current)throw Error('자동 리그 실행 기록이 없습니다.');run=current;
      if(action.kind==='cancel-auto-rig'){
        if(run.state!=='running')throw Error('현재 실행 중인 작업만 중단할 수 있습니다.');
        this.active.get(run.id)?.controller.abort();run.state='cancelled';run.message='로컬 작업을 중단했습니다. 기존 원본과 채택본은 유지합니다.';run.updatedAt=now();return this.save(w);
      }
      if(run.candidateVersionId||run.state==='review')return w;
      if(run.state==='cancelled')throw Error('취소한 실행은 복구·재실행하지 않습니다. 기존 결과를 사용하세요.');
      if(run.requestHash!==this.autoRigFingerprint(run))throw Error('복구할 고정 요청이 변경됐습니다.');
    }else{
      if(!('versionId' in action))throw Error('지원하지 않는 자동 리그 명령입니다.');
      const version=w.versions.find(v=>v.id===action.versionId&&v.objectId===object.id&&v.slot==='main');
      if(!version||object.kind!=='character'||object.creation?.subject!=='human')throw Error('사람 형태의 전체 모델 또는 리그가 필요합니다.');
      if(action.kind==='start-auto-rig'&&(!['model','material'].includes(version.role)||object.accepted[`${version.role}:main`]!==version.id||!['neg-y','pos-y','pos-x','neg-x'].includes(action.frontAxis)||typeof action.fingers!=='boolean'))throw Error('채택한 전체 모델과 앞 방향·손가락 설정을 확인하세요.');
      if(action.kind!=='start-auto-rig'&&version.role!=='rig')throw Error('검사·보정할 리그 결과를 선택하세요.');
      for(const file of version.files)this.verified(id,file);
      const source=version.files.find(f=>isGraphicsProductionFile(f)&&/\.blend$/i.test(f.path))??(action.kind==='start-auto-rig'?version.files.find(f=>isGraphicsProductionFile(f)&&/\.fbx$/i.test(f.path)):undefined);
      if(!source)throw Error('자동 리깅은 BLEND·FBX, 기존 리그 보정은 편집 가능한 Auto-Rig Pro BLEND가 필요합니다.');
      let repairs:AutoRigRun['repairs']=[];
      if(action.kind==='repair-auto-rig'){
        const inspection=w.autoRigRuns?.find(r=>r.id===action.inspectionRunId&&r.objectId===object.id&&r.sourceVersionId===version.id&&r.operation==='inspect'&&r.state==='review');
        if(!inspection?.inspection||!inspection.reportFile||inspection.source.sha256!==source.sha256||inspection.requestHash!==this.autoRigFingerprint(inspection))throw Error('현재 원본을 검사한 부위·본 기록이 필요합니다.');
        this.verified(id,inspection.reportFile);this.verified(id,inspection.source);
        const saved=inspectSavedGraphicsAutoRig(this.autoRigOutput(id,inspection));
        if(inspection.toolSha256!==undefined&&saved.toolSha256!==inspection.toolSha256)throw Error('부위 검사의 고정 작업 도구가 변경됐습니다.');
        const request=JSON.parse(fs.readFileSync(saved.requestPath,'utf8'));
        if(request.sourceSha256!==inspection.source.sha256||request.operation!=='inspect'||JSON.stringify(request.repairs)!==JSON.stringify([])||request.sourceToRigMatrix!==undefined||request.fingers!==inspection.settings.fingers||JSON.stringify(saved.report.inspection)!==JSON.stringify(inspection.inspection))throw Error('저장된 부위 검사가 변경됐습니다.');
        repairs=validateAutoRigRepairs(inspection.inspection,action.repairs);
      }
      const inherited=version.autoRig?.contract??version.externalRig?.contract;
      run={id:uid(),objectId:object.id,sourceVersionId:version.id,source:structuredClone(source),operation:action.kind==='start-auto-rig'?'rig':action.kind==='inspect-auto-rig'?'inspect':'repair',state:'running',createdAt:now(),updatedAt:now(),message:'로컬 작업을 접수했습니다. 정확한 원본과 설치된 도구를 확인합니다.',settings:{frontAxis:action.kind==='start-auto-rig'?action.frontAxis:'neg-y',fingers:action.kind==='start-auto-rig'?action.fingers:inherited?.fingers??true},repairs,files:[],...(action.kind==='repair-auto-rig'?{inspectionRunId:action.inspectionRunId}:{})};
      run.toolSha256=hash(fs.readFileSync(path.join(this.options.resources,'blender','graphics_auto_rig.py')));
      run.requestHash=this.autoRigFingerprint(run);
      const existing=w.autoRigRuns?.find(r=>r.requestHash===run.requestHash&&['running','review'].includes(r.state));
      if(existing)return w;
    }
    if(this.isActive(id)||this.engine.isProjectActive(id)||this.options.legacyActive?.(id))throw Error('현재 실행이 끝난 후 자동 리깅을 진행하세요.');
    this.verified(id,run.source);
    if(!w.autoRigRuns?.some(r=>r.id===run.id))(w.autoRigRuns??=[]).push(run);
    run.state='running';delete run.error;run.updatedAt=now();this.save(w);
    const controller=new AbortController();this.active.set(run.id,{projectId:id,controller});
    try{
      const result=await(this.options.autoRig??runGraphicsAutoRig)({blenderPath:this.store.settings.blenderPath,workerPath:path.join(this.options.resources,'blender','graphics_auto_rig.py'),sourceBlend:this.verified(id,run.source),sourceSha256:run.source.sha256,outputDir:this.autoRigOutput(id,run),operation:run.operation,fingers:run.settings.fingers,repairs:run.repairs,sourceToRigMatrix:run.operation==='rig'?autoRigOrientation(run.settings.frontAxis):undefined,recoveryOnly:action.kind==='recover-auto-rig'},{signal:controller.signal,onProgress:message=>{
        const latest=this.get(id),current=latest.autoRigRuns?.find(r=>r.id===run.id);if(current?.state==='running'&&current.message!==message&&!controller.signal.aborted){current.message=message;current.updatedAt=now();this.save(latest);}
      }});
      const latest=this.get(id),current=latest.autoRigRuns!.find(r=>r.id===run.id)!;
      if(controller.signal.aborted||current.state==='cancelled')throw Error('작업을 중단했습니다.');
      if(current.requestHash!==this.autoRigFingerprint(current))throw Error('실행 도중 고정 요청이 변경됐습니다.');
      if(current.toolSha256!==undefined&&result.toolSha256!==current.toolSha256)throw Error('고정한 작업 도구와 실행·복구 결과가 다릅니다.');
      this.verified(id,current.source);
      if(result.report.sourceSha256!==current.source.sha256||result.report.operation!==current.operation||result.report.osInputUsed!==false||result.report.paidSubmissions!==0||result.report.status!=='exported-review-pending')throw Error('작업 결과와 고정 원본이 일치하지 않습니다.');
      const inspection=this.checkAutoRigInspection(result.report.inspection,current.operation);
      const register=(absolute:string,kind:string)=>{const rel=path.relative(this.store.directory(id),absolute);if(!rel||rel.startsWith('..')||path.isAbsolute(rel)||!path.resolve(absolute).startsWith(path.resolve(this.autoRigOutput(id,current))+path.sep))throw Error('작업 폴더 밖의 결과입니다.');return this.file(id,rel,kind);};
      const files=[register(result.blendPath,'blend'),register(result.fbxPath,'fbx'),register(result.glbPath,'glb')];
      current.files=files;current.reportFile=register(result.reportPath,'auto-rig-report');current.inspection=inspection;
      if(current.operation!=='inspect'){
        const versionId=uid(),sourceVersion=latest.versions.find(v=>v.id===current.sourceVersionId&&v.objectId===object.id)!;
        const oldContract=sourceVersion.autoRig?.contract??sourceVersion.externalRig?.contract;
        const contract:UnityRigContract={schemaVersion:2,versionId,producerVersionId:versionId,producerTaskId:current.id,rigType:'humanoid',fingers:current.settings.fingers,hairBinding:'head',requiredParts:structuredClone(oldContract?.requiredParts??[]),humanBones:inspection.humanBones,exportPolicy:'auto-rig-fbx'};
        const candidate:AssetVersion={id:versionId,objectId:object.id,role:'rig',slot:'main',label:current.operation==='repair'?'선택 부위 웨이트 보정 · 외형 검토 대기':'Auto-Rig Pro · 외형 검토 대기',files,createdAt:now(),sourceVersionIds:[current.sourceVersionId],provenance:{type:'local',jobId:current.id},warnings:['시험 동작은 검사 전용이며 게임용 애니메이션으로 전달하지 않습니다.','구조 검사와 외형 검토는 별개입니다. 어깨·무릎·장식의 변형을 확인하세요.'],autoRig:{schemaVersion:1,runId:current.id,sourceSha256:current.source.sha256,reportFile:current.reportFile,exportFbx:files[1],contract}};
        validateUnityRigContract([candidate],contract);latest.versions.push(candidate);current.candidateVersionId=versionId;
      }
      current.state='review';current.message=current.operation==='inspect'?'연결 부위·본 영향 검사를 저장했습니다. 보정할 부위를 선택하세요.':'구조 검사 통과 · 외형 검토 대기. 결과 사용과 내보내기는 직접 선택하세요.';current.updatedAt=now();return this.save(latest);
    }catch(error){const latest=this.get(id),current=latest.autoRigRuns!.find(r=>r.id===run.id)!;current.state=controller.signal.aborted||current.state==='cancelled'?'cancelled':'failed';current.error=error instanceof Error?error.message:String(error);current.message=current.state==='cancelled'?'작업을 중단했습니다. 원본과 이전 채택을 유지합니다.':'로컬 작업이 완료되지 않았습니다. 기존 결과는 보존됩니다.';current.updatedAt=now();this.save(latest);throw error;}finally{this.active.delete(run.id);}
  }
  async action(id: string, action: GraphicsAction): Promise<GraphicsWorkspace> {
    if(action?.kind==='inspect-planar'||action?.kind==='repair-planar'){
      const identifier=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=500;
      if(!identifier(action.versionId))throw Error('경계 검사 원본 버전이 잘못됐습니다.');
      if(action.kind==='repair-planar'&&(!identifier(action.inspectionId)||!identifier(action.meshId)||!['preserve','reuse-existing-pattern'].includes(action.materialPolicy)||![action.selectedBoundaryIds,action.keptBoundaryIds].every(values=>Array.isArray(values)&&values.length<=10000&&values.every(identifier))))throw Error('경계 보완 선택·유지 목록과 재질 정책이 잘못됐습니다.');
    }
    const w = this.get(id);
    switch (action.kind) {
      case 'prepare-import-preview': throw Error('앱의 로컬 미리보기 준비 연결을 사용하세요.');
      case 'probe-auto-rig': case 'start-auto-rig': case 'inspect-auto-rig': case 'repair-auto-rig': case 'recover-auto-rig': case 'cancel-auto-rig': return this.autoRigAction(id,action);
      case 'prepare-external-rig': case 'inspect-external-rig': case 'import-external-rig': case 'recover-external-rig': case 'cancel-external-rig': return this.externalRigAction(id, action);
      case "create-object": {
        if (!["character", "weapon", "prop", "environment", "sprite", "ui", "vfx"].includes(action.objectKind)) throw Error("잘못된 대상 종류입니다.");
        const name = action.name.trim(); if (!name || name.length > 100) throw Error("이름을 1–100자로 입력하세요.");
        const creation = action.creation ? validateCreation(action.creation, action.objectKind) : undefined;
        w.objects.push({ id: uid(), name, kind: action.objectKind, createdAt: now(), selectedTasks: [], instruction: "", settings: { count: 1, faceLimit: DEFAULT_MODEL_FACE_LIMIT, quad: true, textureSize: 4096, scale: 1, pivot: "keep", exportFormat: "both" }, references: [], accepted: {}, ...(creation ? { creation } : {}) });
        return this.save(w);
      }
      case "update-object": {
        const o = this.object(w, action.objectId), p = action.patch;
        if (p.name !== undefined) { if (!p.name.trim() || p.name.length > 100) throw Error("이름을 확인하세요."); o.name = p.name.trim(); }
        if (p.instruction !== undefined) { if (p.instruction.length > 12000) throw Error("지시는 12,000자 이내로 입력하세요."); o.instruction = p.instruction; }
        if (p.creation !== undefined) o.creation = validateCreation(p.creation, o.kind);
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
        if (!v) throw Error("이 대상의 결과가 아닙니다.");
        if (v.contact && (!['repair', 'reconstruct'].includes(v.contact.phase) || v.contact.status !== 'repaired') || v.slot === 'contact-review')
          throw Error('접합 영역 분석은 채택할 모델이 아닙니다. 확인된 영역의 보정 결과를 비교하세요.');
        if (v.slot.startsWith('part-') && w.tasks.some(task => task.id === v.provenance.jobId && task.taskId === 'M06' && ['repair', 'reconstruct'].includes(String(task.settings.contactPhase))))
          throw Error('접합 보정은 전체 비교 화면의 수정한 조립·파트 채택 버튼으로 함께 채택하세요.');
        let candidates = [v];
        if (v.role === 'model' && v.slot === 'main') {
          const producers = w.tasks.filter(task => (task.taskId === 'M08' || task.taskId === 'M06' && ['repair', 'reconstruct'].includes(String(task.settings.contactPhase))) && task.outputVersionIds.includes(v.id));
          if (producers.length > 1) throw Error('조립 결과의 제작 작업이 중복됩니다. 채택 상태는 유지됩니다.');
          const producer = producers[0];
          const hasParts = producer && (producer.outputVersionIds.length > 1 || w.versions.some(version => version.provenance.jobId === producer.id && version.slot.startsWith('part-')));
          if ((v.contact || producer?.taskId === 'M06') && (!v.contact || !producer || producer.taskId !== 'M06' || producer.settings.contactPhase !== v.contact.phase || !['repair', 'reconstruct'].includes(String(producer.settings.contactPhase)) || !hasParts))
            throw Error('접합 보정 전체와 세 파트의 제작 기록이 필요합니다. 기존 채택을 유지합니다.');
          if (producer && hasParts) {
            if (producer.taskId === 'M06' && (!v.contact || !['repair', 'reconstruct'].includes(v.contact.phase) || v.contact.status !== 'repaired' || producer.status !== 'review'))
              throw Error('검사된 접합 보정 결과가 아닙니다. 기존 채택을 유지합니다.');
            if (producer.taskId === 'M06') {
              validateContactReview(v.contact!, v.files.map(file => file.path));
              if (producer.settings.sourceVersionId !== v.contact!.sourceVersionId || producer.settings.contactPartVersionIds !== JSON.stringify(v.contact!.partVersionIds) ||
                  producer.settings.contactAnalysisVersionId !== v.contact!.analysisVersionId ||
                  v.contact!.phase === 'reconstruct' && (producer.settings.contactTopologyReconstructionConfirmed !== true || producer.settings['lock.topology'] !== false))
                throw Error('접합 검토와 고정 원본의 연결이 다릅니다. 기존 채택을 유지합니다.');
            }
            if (producer.objectId !== o.id || v.provenance.jobId !== producer.id || new Set(producer.outputVersionIds).size !== producer.outputVersionIds.length)
              throw Error('조립 결과의 대상·제작 작업·후보 연결이 잘못됐습니다. 채택 상태는 유지됩니다.');
            const inputs = producer.inputVersionIds.map(versionId => w.versions.find(version => version.id === versionId));
            if (inputs.some(version => !version || version.objectId !== o.id)) throw Error('조립의 고정 입력이 누락됐거나 다른 대상입니다. 채택 상태는 유지됩니다.');
            const slots = inputs.filter(version => version && ['model', 'material'].includes(version.role) && version.slot.startsWith('part-')).map(version => version!.slot);
            if (slots.length < 2 || new Set(slots).size !== slots.length) throw Error('조립의 고정 파트가 누락됐거나 중복됩니다. 채택 상태는 유지됩니다.');
            candidates = producer.outputVersionIds.map(versionId => {
              const matches = w.versions.filter(version => version.id === versionId);
              if (matches.length !== 1) throw Error('조립 파트 후보가 누락됐거나 중복됩니다. 채택 상태는 유지됩니다.');
              const candidate = matches[0];
              if (candidate.objectId !== o.id || candidate.role !== 'model' || candidate.provenance.jobId !== producer.id ||
                  JSON.stringify(candidate.sourceVersionIds) !== JSON.stringify(producer.inputVersionIds) || !candidate.files.length)
                throw Error('같은 작업의 정확한 조립·파트 후보가 아닙니다. 채택 상태는 유지됩니다.');
              return candidate;
            });
            if (producer.taskId === 'M06' && producer.settings.contactPhase === 'reconstruct' && producer.contactProcedureRecoveryRequested) {
              // Keep the original failed-procedure diagnosis in history, but it is not an adoptable part.
              const diagnostics = candidates.filter(candidate => candidate.slot === 'contact-review');
              if (diagnostics.length !== 1 || diagnostics[0].contact?.phase !== 'reconstruct' || diagnostics[0].contact.status !== 'blocked' ||
                  diagnostics[0].contact.sourceVersionId !== v.contact!.sourceVersionId ||
                  JSON.stringify(diagnostics[0].contact.partVersionIds) !== JSON.stringify(v.contact!.partVersionIds) ||
                  diagnostics[0].contact.analysisVersionId !== v.contact!.analysisVersionId)
                throw Error('보정 절차 복구 전의 정확한 중단 진단이 없습니다. 기존 채택을 유지합니다.');
              validateContactReview(diagnostics[0].contact, diagnostics[0].files.map(file => file.path));
              for (const file of diagnostics[0].files) this.verified(id, file);
              candidates = candidates.filter(candidate => candidate.slot !== 'contact-review');
            }
            const expected = new Set(['main', ...slots]);
            if (candidates.length !== expected.size || new Set(candidates.map(candidate => candidate.slot)).size !== expected.size || candidates.some(candidate => !expected.has(candidate.slot)))
              throw Error('조립 파트 후보가 누락됐거나 중복됩니다. 채택 상태는 유지됩니다.');
          }
        }
        // Verify the entire assembly before changing even one accepted slot.
        for (const candidate of candidates) {
          this.validateAutoRigCandidate(id,w,candidate);
          if(candidate.externalRig){
            const meta=candidate.externalRig, handoff=w.externalRigHandoffs?.find(h=>h.id===meta.handoffId&&h.candidateVersionId===candidate.id&&h.objectId===candidate.objectId);
            if(!handoff?.imported||handoff.imported.state!=='review'||handoff.imported.reportPath!==meta.reportPath||handoff.imported.reportSha256!==meta.reportSha256||handoff.source.sha256!==meta.sourceSha256||handoff.returnedFbx?.sha256!==meta.returnedFbxSha256||JSON.stringify(handoff.imported.files)!==JSON.stringify(candidate.files))throw Error('외부 리그의 저장된 검사 출처가 다릅니다.');
            for(const f of [...handoff.preparation!.files,...handoff.inspection!.files,...handoff.imported.files,handoff.source,handoff.returnedFbx!])this.verified(id,f);
            validateUnityRigContract([candidate],meta.contract);
            if(JSON.stringify(meta.contract.humanBones)!==JSON.stringify(handoff.humanBones))throw Error('확인한 본 매핑이 변경됐습니다.');
          }
          for (const file of candidate.files) this.verified(id, file);
          validateSavedPlanarCandidate(this.store.directory(id),w,candidate);
          if (requiresPartSpaceRestoration(w, candidate)) throw Error('파트의 원래 크기·위치를 먼저 복원·검사하세요. API 원본은 별도로 보존합니다.');
          if (requiresPartSourcePreparation(w, candidate)) throw Error('파트 원본의 로컬 작업 사본을 먼저 준비하세요. API 원본은 별도로 보존합니다.');
        }
        o.accepted = { ...o.accepted, ...Object.fromEntries(candidates.map(candidate => [`${candidate.role}:${candidate.slot}`, candidate.id])) };
        // Other slots and clips remain accessible. Compatibility is checked on delivery, not by deleting history.
        return this.save(w);
      }
      case 'prepare-contact': return this.prepareContact(id, action.versionId, action.phase);
      case 'recover-contact-procedure': return this.recoverContactProcedure(id, action.taskId);
      case 'set-unity-target': {
        if (typeof action.projectPath !== 'string' || !action.projectPath.trim() || action.projectPath.length > 32767) throw Error('Unity 프로젝트 경로를 입력하세요.');
        if (this.isActive(id) || this.engine.isProjectActive(id) || this.options.legacyActive?.(id) || [...this.preparing].some(key => key.startsWith(`${id}:`)) ||
            w.tasks.some(task => ['running', 'awaiting_approval', 'submission_unknown'].includes(task.status)) ||
            w.deliveries.some(delivery => delivery.status === 'queued')) throw Error('진행 중이거나 승인·확인을 기다리는 작업과 Unity 전달을 먼저 완료하거나 취소하세요.');
        // Validate the complete target before changing either stored selection.
        // Existing requests and delivery receipts retain their frozen profiles.
        const target = readUnityTarget(action.projectPath.trim());
        const project = this.store.project(id);
        project.unityPath = target.projectPath;
        this.store.save(project);
        w.target = target;
        return this.save(w);
      }
      case "inspect-target": w.target = readUnityTarget(this.store.project(id).unityPath || this.store.settings.unityPath); return this.save(w);
      case "audit-usage": return this.audit(id);
      case "inspect-storage": return { ...w, storageReport: await inspectGraphicsStorage({
        profileRoot: this.store.root, appRoot: this.options.storageRoot,
        registeredFiles: this.list().flatMap(space => space.versions.flatMap(version => version.files.map(file => this.store.file(space.projectId, file.path)))),
      }) };
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
      case "inspect-legacy": return { ...w, legacyPreview: this.inspectLegacy(id) };
      case "import-legacy": return this.importLegacy(id, action.versionIds, action.fingerprint);
      case "unlink-legacy": {
        if (this.isActive(id) || this.engine.isProjectActive(id) || this.options.legacyActive?.(id)) throw Error("실행 중인 작업이 있습니다. 완료 후 연결을 해제하세요.");
        const problem = graphicsLegacyUnlinkProblem(w, action.objectId);
        if (problem) throw Error(problem);
        w.objects = w.objects.filter(object => object.id !== action.objectId);
        w.versions = w.versions.filter(version => version.objectId !== action.objectId);
        // Only collection metadata is removed. Project/Workbench records and all files remain intact.
        return this.save(w);
      }
      case "prepare": return this.prepare(id, action.objectId, action.taskId);
      case "approve": return this.approve(id, action.taskId);
      case "recover": return this.recover(id, action.taskId);
      case 'restore-part-space': return this.restorePartSpace(id, action.versionId);
      case 'prepare-part-source': return this.preparePartSource(id, action.versionId);
      case 'repair-surface-uv': return this.repairSurface(id, action.versionId);
      case 'inspect-planar': return this.planar(id, action.versionId);
      case 'repair-planar': return this.planar(id, action.versionId, action);
      case "refresh-parts": return this.refreshParts(id, action.taskId);
      case "runtime-approval": {
        const task = w.tasks.find(value => value.id === action.taskId), pending = this.pendingApprovals.get(action.taskId);
        const request = task?.runtimeApproval;
        if (!task || task.status !== "running" || !request || request.id !== action.approvalId || !pending || pending.projectId !== id || pending.approvalId !== action.approvalId || this.active.get(task.id)?.projectId !== id)
          throw Error("이 도구 확인은 이미 끝났거나 현재 실행의 요청이 아닙니다.");
        const answer = action.answer;
        if (!answer || typeof answer.accepted !== "boolean" || !answer.values || typeof answer.values !== "object" || Array.isArray(answer.values) ||
          Object.entries(answer.values).some(([key, value]) => !request.fields.some(field => field.id === key) || typeof value !== "string" || value.length > 6000) ||
          answer.accepted && request.fields.some(field => (field.required && !answer.values[field.id]?.trim()) ||
            answer.values[field.id] !== undefined && field.options && !field.options.some(option => option.value === answer.values[field.id])))
          throw Error("도구 확인 답변을 확인하세요. 필수 답변과 표시된 선택지만 사용할 수 있습니다.");
        this.pendingApprovals.delete(task.id);
        this.closeRuntimeApproval(task, answer.accepted ? "accepted" : "declined");
        task.updatedAt = now();
        task.message = answer.accepted ? "확인한 도구 요청을 이어서 실행합니다." : "도구 요청을 허용하지 않았습니다. 현재 작업을 정리하고 있습니다.";
        this.save(w);
        pending.resolve(structuredClone(answer));
        return w;
      }
      case "cancel": {
        const t = w.tasks.find(t => t.id === action.taskId); if (!t) throw Error("작업 없음");
        if (t.status === "review") throw Error("완료한 결과는 취소하지 않습니다. 다른 버전을 채택할 수 있습니다.");
        this.closeRuntimeApproval(t, "cancelled");
        this.active.get(t.id)?.controller.abort();
        if (!t.taskId.startsWith('LOCAL_PLANAR_') && !t.partSpaceRecoveryVersionId && !t.partSourceRecoveryVersionId && !t.surfaceRecoveryVersionId) for (const jid of t.backendJobIds) this.engine.cancel(id, jid);
        if (t.deliveryId && t.targetProfile) {
          const index = w.deliveries.findIndex(d => d.id === t.deliveryId);
          if (index >= 0) {
            w.deliveries[index] = cancelUnityDelivery(t.targetProfile.projectPath, w.deliveries[index]);
            if (w.deliveries[index].status === "imported") {
              t.status = "review"; t.message = "중지 요청 전에 Unity 가져오기가 완료됐습니다. 전달 파일은 유지했습니다."; t.updatedAt = now(); return this.save(w);
            }
          }
        }
        t.status = "cancelled"; t.message = t.partSpaceRecoveryVersionId || t.partSourceRecoveryVersionId || t.surfaceRecoveryVersionId || t.taskId.startsWith('LOCAL_PLANAR_') ? '로컬 처리를 중지했습니다. 기존 API 결과는 유지합니다.' : "사용자가 중지했습니다. 이미 제출한 원격 작업의 과금 취소를 뜻하지는 않습니다."; t.updatedAt = now();
        return this.save(w);
      }
      case "import": throw Error("앱 파일 선택 창을 사용하세요.");
    }
  }
  /** Explicit candidate review is independent of acceptance and the user's unsaved creation draft. */
  private prepareContact(id: string, versionId: string, phase: 'analyze' | 'repair' | 'reconstruct') {
    if (!['analyze', 'repair', 'reconstruct'].includes(phase)) throw Error('접합 확인 또는 영역 보정을 선택하세요.');
    const w = this.get(id);
    const uniqueVersion = (value: string) => {
      const matches = w.versions.filter(version => version.id === value);
      if (matches.length !== 1) throw Error('접합 원본 버전이 누락됐거나 중복됩니다.');
      return matches[0];
    };
    const selected = uniqueVersion(versionId);
    if (!selected) throw Error('접합을 확인할 저장 결과가 없습니다.');
    const o = this.object(w, selected.objectId);
    const analysis = phase !== 'analyze' ? selected : undefined;
    if (analysis) {
      const expectedStatus = phase === 'reconstruct' ? 'blocked' : 'ready';
      if (!analysis.contact || analysis.contact.phase !== 'analyze' || analysis.contact.status !== expectedStatus || analysis.slot !== 'contact-review')
        throw Error(phase === 'reconstruct' ? '기존 면 구조 유지로 보정할 수 없었던 저장된 접합 진단을 선택하세요. 새 분석은 실행하지 않습니다.' : '수정 영역이 확인된 분석 결과를 선택하세요. 불확실한 영역은 보정하지 않습니다.');
      validateContactReview(analysis.contact, analysis.files.map(file => file.path));
      const producer = w.tasks.filter(task => task.id === analysis.provenance.jobId && task.taskId === 'M06' && task.settings.contactPhase === 'analyze' && task.status === 'review' && task.outputVersionIds.includes(analysis.id));
      if (producer.length !== 1 || producer[0].objectId !== o.id || producer[0].settings.sourceVersionId !== analysis.contact.sourceVersionId ||
          !producer[0].completedExecutions?.includes(producer[0].id) ||
          producer[0].settings.contactPartVersionIds !== JSON.stringify(analysis.contact.partVersionIds) ||
          JSON.stringify(analysis.sourceVersionIds) !== JSON.stringify(producer[0].inputVersionIds))
        throw Error('분석 결과의 원본·작업 연결을 확인할 수 없습니다.');
    }
    const source = analysis ? uniqueVersion(analysis.contact!.sourceVersionId) : selected;
    if (!source || source.objectId !== o.id || source.role !== 'model' || source.slot !== 'main' || source.contact || !source.files.some(file => /\.blend$/i.test(file.path)))
      throw Error('기존 임시 조립의 편집 가능한 전체 후보를 선택하세요. 다시 조립하거나 채택할 필요는 없습니다.');
    const producers = w.tasks.filter(task => task.id === source.provenance.jobId && task.objectId === o.id && task.taskId === 'M08' && task.status === 'review' && task.outputVersionIds.includes(source.id));
    if (producers.length !== 1) throw Error('완료된 임시 조립의 정확한 파트 연결이 필요합니다.');
    const producer = producers[0], parts = producer.outputVersionIds.filter(value => value !== source.id).map(uniqueVersion);
    const slots = ['part-head', 'part-body', 'part-hair'];
    if (parts.length !== 3 || parts.some(part => !part || part.objectId !== o.id || part.role !== 'model' || part.provenance.jobId !== producer.id ||
          !slots.includes(part.slot) || JSON.stringify(part.sourceVersionIds) !== JSON.stringify(producer.inputVersionIds)) ||
        new Set(parts.map(part => part?.slot)).size !== 3 || JSON.stringify(source.sourceVersionIds) !== JSON.stringify(producer.inputVersionIds))
      throw Error('같은 임시 조립의 머리·몸통·머리카락 세 파트가 필요합니다.');
    const partVersions = parts as AssetVersion[];
    if (analysis && JSON.stringify(analysis.contact!.partVersionIds) !== JSON.stringify(partVersions.map(part => part.id)))
      throw Error('분석한 파트와 보정할 파트가 다릅니다. 기존 결과를 유지합니다.');
    const previous = w.tasks.filter(task => task.objectId === o.id && task.taskId === 'M06' && task.settings.contactPhase === phase && task.settings.sourceVersionId === source.id);
    if (previous.length) {
      if (previous.length !== 1) throw Error('접합 실행 기록이 중복돼 있습니다. 새 요청을 만들지 않습니다.');
      // Keep failed/cancelled/finished jobs too: recovery may inspect saved output but never spend another turn.
      return w;
    }
    if (w.tasks.some(task => task.objectId === o.id && ['awaiting_approval', 'running', 'submission_unknown'].includes(task.status)))
      throw Error('현재 대상의 진행 중인 작업부터 확인하세요.');
    const refs = [...new Set([...producer.inputVersionIds, ...Object.entries(o.accepted).filter(([key]) => key.startsWith('design:')).map(([, value]) => value), ...o.references.map(ref => ref.versionId)])].map(value => w.versions.find(version => version.id === value))
      .filter((version): version is AssetVersion => !!version && version.objectId === o.id && version.role === 'design');
    const inputs = [source, ...partVersions, ...refs, ...(analysis ? [analysis] : [])];
    for (const version of inputs) {
      if (!version.files.length) throw Error('접합 원본 파일이 없습니다.');
      for (const file of version.files) this.verified(id, file);
    }
    const settings: GraphicsTask['settings'] = { contactPhase: phase, sourceVersionId: source.id, contactPartVersionIds: JSON.stringify(partVersions.map(part => part.id)),
      count: 1, 'lock.topology': phase !== 'reconstruct', 'lock.materials': true, 'lock.rig': true,
      ...(analysis ? { contactAnalysisVersionId: analysis.id, contactAnalysisTaskId: analysis.provenance.jobId! } : {}),
      ...(phase === 'repair' ? { contactRegionsConfirmed: true } : {}),
      ...(phase === 'reconstruct' ? { contactTopologyReconstructionConfirmed: true } : {}) };
    const instruction = phase === 'analyze'
      ? '현재 임시 조립의 목 연결부와 헤어 안쪽만 분석합니다. 얼굴·귀·헤어 외곽·의상은 보호합니다. 정확한 수정 영역과 보호 영역을 색으로 표시하고 불확실하면 보정 불가로 보고하세요. 원본과 형상은 변경하지 않습니다.'
      : phase === 'reconstruct'
        ? '저장된 접합 진단을 재사용해 머리의 목 연결부와 헤어 안쪽의 면 구조를 한 번 보정합니다. 이 국소 영역의 새 면과 제한적인 형상 변경만 허용합니다. 얼굴·귀·몸통·의상과 보호 영역, 파트 구분·전체 배치·재질은 보존하고, 그 밖의 면과 UV는 유지합니다. 수정 영역과 보존 여부를 확인할 수 없으면 중단하세요. 전체 재토폴로지·메시 합치기·새 모델 생성·새 분석 실행·자동 재시도·UV·텍스처·리깅은 하지 않습니다. 수정된 면의 UV는 미완료로 표시합니다.'
        : '앱에서 확인한 목 연결부·헤어 안쪽 정점 영역만 한 번 보정합니다. 얼굴·귀·헤어 외곽·의상, 전체 배치·면 구조·UV·재질·식별자는 보존합니다. 허용 영역으로 해결되지 않으면 중단하세요. 자동 재시도·새 생성·UV·텍스처·리깅은 하지 않습니다.';
    const objectSnapshot = { name: o.name, kind: o.kind, references: structuredClone(o.references), accepted: structuredClone(o.accepted), ...(o.creation ? { creation: structuredClone(o.creation) } : {}) };
    const snapshot = { taskId: 'M06', objectId: o.id, inputVersionIds: inputs.map(version => version.id), settings, instruction, objectSnapshot };
    const task: GraphicsTask = { ...snapshot, id: uid(), createdAt: now(), updatedAt: now(), status: 'awaiting_approval', requestHash: hash(JSON.stringify(snapshot)),
      outputVersionIds: [], backendJobIds: [], localOnly: false, message: '요청을 저장했습니다. 실행 버튼 전까지 GPT·외부 생성 요청은 없습니다.',
      cost: { provider: 'Codex', credits: null, basis: `추가 Tripo·fal 비용 없음 · Blender + gpt-6-astra ${phase === 'analyze' ? '영역 분석' : phase === 'reconstruct' ? '목·헤어 국소 면 보정 (저장 진단 재사용)' : '영역 보정'} 최대 1회 · 자동 재시도 없음. GPT 사용량은 발생하며 모델·추론 설정은 유지합니다.` } };
    w.tasks.push(task); return this.save(w);
  }
  private async requireTextureSurface(id: string, source: AssetVersion, signal: AbortSignal) {
    // Inspect the same first native file selected by apiQuote, not a different preview.
    const file = source.files.find(file => isGraphicsProductionFile(file) && /\.(fbx|glb|obj|stl)$/i.test(file.path));
    if (!file) throw Error('텍스처 입력에는 FBX/GLB/OBJ/STL 원본이 필요합니다.');
    this.verified(id, file);
    const result = await (this.options.inspectSurface ?? inspectGraphicsSurface)({
      projectRoot: this.store.directory(id), source: file, sourceVersionId: source.id,
      blenderPath: this.store.settings.blenderPath, resources: this.options.resources, signal,
    });
    signal.throwIfAborted(); this.verified(id, file);
    if (!result.report.ready) throw Error(`텍스처 준비 불가 · ${source.label}: ${result.report.reason} UV 작업 결과를 확인·채택한 뒤 텍스처를 준비하세요. 업로드·유료 제출은 하지 않았습니다.`);
  }
  private async prepare(id: string, objectId: string, taskId: string) {
    if(taskId==='LOCAL_PLANAR_INSPECT'||taskId==='LOCAL_PLANAR_REPAIR')throw Error('로컬 평면 작업은 모델의 경계 검사 화면에서 명시적으로 선택하세요.');
    const key = `${id}:${objectId}`;
    if (this.preparing.has(key)) throw Error('같은 오브젝트의 입력을 확인 중입니다. 잠시 기다려 주세요.');
    this.preparing.add(key);
    try { return await this.prepareChecked(id, objectId, taskId); }
    finally { this.preparing.delete(key); }
  }
  private async prepareChecked(id: string, objectId: string, taskId: string) {
    let w = this.get(id);
    const stored = this.object(w, objectId), definition = findGraphicsTask(taskId);
    const compiled = stored.creation ? compileCreation(stored, taskId) : undefined;
    const base = compiled ? { ...stored, settings: compiled.settings, instruction: compiled.instruction, creation: compiled.spec } : stored;
    if (taskId === 'M06' && base.settings.contactPhase !== undefined) throw Error('접합 검토 버튼에서 정확한 조립 후보를 선택하세요.');
    const o = ['M01', 'M02', 'M03', 'M04', 'M15'].includes(taskId) ? { ...base, settings: requireModelGeometry(base.settings, taskId) } : base;
    if (!definition || definition.status === "planned") throw Error(definition?.reason ?? "등록되지 않은 작업입니다.");
    if (["A01", "A02", "A03"].includes(taskId)) throw Error("자료 가져오기·대상 추가·참고 연결 버튼을 사용하세요.");
    if (compiled && ['sprite', 'ui', 'vfx'].includes(o.kind)) throw Error('2D·게임 UI·이펙트는 이번 3D 제작 범위 밖입니다. 기존 자료는 보존됩니다.');
    if (compiled && taskId.startsWith('R') && o.settings.rigType === 'none') throw Error('리깅 없음이 선택돼 있습니다. 다음 단계로 이동하거나 리그 유형을 선택하세요.');
    if (compiled && ['M01','M02','M04','M15'].includes(taskId) && o.creation && creationCompositionStrategy(o.creation) === 'independent-parts' && !o.settings.partId) throw Error('파츠별 제작에서는 제작할 파츠와 해당 채택 이미지를 선택하세요.');
    if (graphicsProceduralTasks.has(taskId)) { const problem = proceduralProblem({ ...o.settings, count: 1 }, taskId); if (problem) throw Error(problem); }
    if (w.tasks.some(t => t.objectId === o.id && ["awaiting_approval", "running", "submission_unknown"].includes(t.status))) throw Error("이 대상의 기존 작업을 확인하거나 취소한 뒤 새 작업을 준비하세요.");
    const inputs = this.inputs(w, o, taskId);
    const inputSupportProblem = graphicsInputSupportProblem(taskId, inputs, o.kind);
    if (inputSupportProblem) throw Error(inputSupportProblem);
    if (inputs.some(version => requiresPartSpaceRestoration(w, version))) throw Error('API 파트 결과의 원래 크기·위치 복원을 먼저 완료하세요. 원본은 유지됩니다.');
    if (inputs.some(version => requiresPartSourcePreparation(w, version))) throw Error('API 파트 원본의 로컬 작업 사본 준비를 먼저 완료하세요. 원본은 유지됩니다.');
    if (['M06', 'M09'].includes(taskId) && o.settings.meshSelectionVersionId !== undefined && inputs[0]?.id !== o.settings.meshSelectionVersionId)
      throw Error('메시를 선택한 원본과 현재 채택 모델이 다릅니다. 현재 모델에서 부품을 다시 선택하세요.');
    const count = Number(o.settings.count ?? 1);
    if (!Number.isInteger(count) || count < 1 || count > 4) throw Error("출력 개수는 1–4개입니다.");
    if (["I01", "I02", "I03", "I05", "I06", "M03", "M05", "M09", "N02", "N05", "N06"].includes(taskId) && !o.instruction.trim()) throw Error("제작 또는 수정할 내용을 입력하세요.");
    if ((taskId === 'M09' || taskId === 'M05' && o.settings.editSourceMode === 'candidate') && compiled && !String(o.settings.freeInstruction ?? '').trim()) throw Error('추가 지시에 수정할 부분과 유지할 내용을 적어 주세요.');
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
    if (taskId === 'T03') {
      await this.requireTextureSurface(id, inputs[0], new AbortController().signal);
      // Another object may change while the local inspection runs. Never overwrite it
      // or prepare against a source/setting selection that the user changed meanwhile.
      w = this.get(id);
      if (JSON.stringify(this.object(w, objectId)) !== JSON.stringify(stored)) throw Error('검사 중 원본 또는 설정이 변경됐습니다. 현재 선택으로 다시 준비하세요.');
      if (w.tasks.some(task => task.objectId === objectId && ['awaiting_approval', 'running', 'submission_unknown'].includes(task.status)))
        throw Error('이 대상의 기존 작업을 먼저 확인하세요.');
    }
    const snapshot = { taskId, objectId, inputVersionIds: inputs.map(v => v.id), settings: { ...o.settings }, instruction: o.instruction };
    if (graphicsAstraTasks.has(taskId) && taskId !== 'M08') snapshot.settings.sourceVersionId = inputs[0].id;
    if (taskId === "N06" && inputs[0].provenance.type === "import") {
      if (inputs[0].role !== "animation" || inputs[0].slot !== snapshot.settings.clipName || !inputs[0].files.some(file => /\.blend$/i.test(file.path)))
        throw Error("가져온 애니메이션의 원래 클립 이름과 편집 가능한 .blend 원본을 확인하세요.");
      if (snapshot.settings.actionName !== undefined && snapshot.settings.actionName !== inputs[0].slot)
        throw Error("가져온 애니메이션 수정은 등록한 원래 액션 이름과 같아야 합니다.");
      snapshot.settings.actionName = inputs[0].slot;
    }
    if (["M01", "M02", "M03"].includes(taskId)) snapshot.settings.model ??= "P2-20260801";
    if (taskId === "T03") snapshot.settings.textureReference ??= "auto";
    if (!["I01", "I02", "I03", "I05", "I06", "I07", 'I08', "M01", "M02", "M03", 'M04', 'M15', 'T03', 'N02', 'N04', 'N05', 'N06'].includes(taskId)) snapshot.settings.count = 1;
    if (taskId === "N02") snapshot.settings.motionSourceView ??= "left";
    const t: GraphicsTask = { ...snapshot, id: uid(), createdAt: now(), updatedAt: now(), status: "awaiting_approval", requestHash: hash(JSON.stringify(snapshot)), outputVersionIds: [], backendJobIds: [], localOnly: definition.executor === "local", message: "요청을 저장했습니다. 실행 전까지 작업자·유료 서비스 호출은 없습니다." };
    if (taskId === 'M08' && t.settings.assemblyPlacement === 'keep') t.localOnly = true;
    t.objectSnapshot = { name: o.name, kind: o.kind, references: structuredClone(o.references), accepted: structuredClone(o.accepted), ...(o.creation ? { creation: structuredClone(o.creation) } : {}) };
    if (taskId === "X05") { t.targetProfile = structuredClone(w.target); t.unityClipSettings = freezeUnityClipSettings(w, inputs); t.unityRigContract = freezeUnityRigContract(w, inputs); }
    t.requestHash = hash(JSON.stringify({ ...snapshot, object: t.objectSnapshot, target: t.targetProfile, ...(t.unityClipSettings ? { unityClipSettings: t.unityClipSettings } : {}), ...(t.unityRigContract ? { unityRigContract: t.unityRigContract } : {}) }));
    if (API.has(taskId)) {
      const q = this.apiQuote(w, o, t, inputs); t.quoteId = q.id;
      t.cost = { provider: "Tripo API", credits: q.estimatedCredits, basis: q.costSource, expiresAt: q.expiresAt };
    } else if (graphicsVideoTasks.has(taskId)) {
      const unit = prepareGraphicsVideo({ projectRoot: this.store.directory(id), object: { ...o, settings: t.settings }, task: { ...t, settings: { ...t.settings, count: 1 } }, inputs }).cost;
      t.cost = { ...unit, credits: unit.credits * count, basis: `${unit.basis} · 독립 후보 ${count}개 합계 ${unit.credits * count}크레딧` };
    } else t.cost = { provider: t.localOnly ? "로컬" : "Codex", credits: t.localOnly ? 0 : null, basis: t.localOnly ? "로컬 처리 · GPT 요청 0회" : graphicsAstraTasks.has(taskId) ? "Blender + gpt-6-astra · Codex 계정 사용량. 저장 결과 복구·파일 변환은 새 GPT 요청 없이 처리합니다." : "Codex 계정 사용량을 사용합니다. 비교 가능한 실측이 없어 예상 토큰 수를 표시하지 않습니다." };
    w.tasks.push(t); return this.save(w);
  }
  private apiQuote(w: GraphicsWorkspace, o: GraphicsObject, t: GraphicsTask, inputs: AssetVersion[]): Quote {
    const p = this.store.project(w.projectId);
    const alias = (v: AssetVersion, isImage: boolean) => {
      const f = v.files.find(f => isGraphicsProductionFile(f) && (isImage ? image : /\.(fbx|glb|obj|stl)$/i).test(f.path));
      if (!f) throw Error(isImage ? "원본 이미지가 필요합니다." : "API 입력에는 FBX/GLB/OBJ/STL 원본이 필요합니다. 먼저 형식 내보내기를 실행하세요.");
      this.verified(w.projectId, f);
      let a = p.assets.find(a => a.id === `graphics-${v.id}`);
      if (a && (a.file !== f.path || (a.nativeFile ?? a.file) !== f.path || a.kind !== (isImage ? "image" : "model"))) throw Error("API 입력 별칭이 고정한 원본과 다릅니다.");
      if (!a) a = this.engine.asset(p, f.path, isImage ? "image" : "model", v.label, "import", { id: `graphics-${v.id}` });
      return a.id;
    };
    let request: Generation, unit: number;
    if (["M01", "M02", "M03"].includes(t.taskId)) {
      const geometry = requireModelGeometry(t.settings, t.taskId), version = String(geometry.model);
      request = { kind: "model", prompt: t.instruction, model: version, count: Number(t.settings.count), faceLimit: geometry.faceLimit, quad: geometry.quad, texture: false, inputMode: t.taskId === "M03" ? "text" : t.taskId === "M02" ? "multiview" : "image" };
      if (t.taskId === "M01") request.sourceId = alias(inputs[0], true);
      if (t.taskId === "M02") request.sourceIds = inputs.map(v => alias(v, true));
      unit = version === 'P2-20260801' ? 100 : version === 'P1-20260311' ? (t.taskId === 'M03' ? 30 : 40) : (t.taskId === 'M03' ? 10 : 20) + (request.quad ? 5 : 0);
    } else if (t.taskId === "T01") {
      request = { kind: "smart-uv", model: "default", prompt: "", count: 1, sourceId: alias(inputs[0], false), bake: true }; unit = 20;
    } else if (t.taskId === "M10") {
      request = { kind: "retopology", model: "v2.0", prompt: "", count: 1, sourceId: alias(inputs[0], false), faceLimit: Number(t.settings.faceLimit ?? 10000), quad: t.settings.quad !== false, bake: true }; unit = 30;
    } else {
      const resolution = Number(t.settings.textureSize ?? 4096);
      if (![2048, 4096, 8192].includes(resolution)) throw Error("텍스처 해상도는 2048/4096/8192 중 선택하세요.");
      // Use frozen inputs only, including when refreshing an older quote. Never
      // bind a newly accepted design to an already prepared text-only request.
      const references = inputs.slice(1);
      if (references.length > 1 || references.some(version => version.role !== "design") || t.settings.textureReference === "text" && references.length)
        throw Error("고정된 텍스처 모델·디자인 입력을 확인하세요.");
      request = { kind: "texture", model: "v3.5-20260815", prompt: references.length ? "" : t.instruction, count: Number(t.settings.count ?? 1), sourceId: alias(inputs[0], false), ...(references.length ? { sourceIds: references.map(version => alias(version, true)) } : {}), textureQuality: resolution === 8192 ? "extreme" : resolution === 4096 ? "detailed" : "standard", pbr: true }; unit = resolution === 8192 ? 30 : resolution === 4096 ? 20 : 10;
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
        if (t.taskId === 'T03') {
          t.message = '텍스처 입력의 모든 면에 유효한 UV가 있는지 로컬에서 확인합니다.'; this.save(w);
          await this.requireTextureSurface(id, inputs[0], controller.signal);
          const latest = this.get(id), current = latest.tasks.find(value => value.id === taskId);
          if (current?.status !== 'awaiting_approval') throw Error('실행 확인이 취소됐습니다. 업로드·제출하지 않았습니다.');
          w = latest; t = current;
        }
        if (['T01', 'T03'].includes(t.taskId) && t.settings.partId) {
          const source = inputs[0], sourceFile = source?.files.find(file => isGraphicsProductionFile(file) && /\.fbx$/i.test(file.path));
          if (!sourceFile || source.slot !== `part-${t.settings.partId}`) throw Error('파트 UV·텍스처에는 같은 파트의 원본 FBX와 식별자가 필요합니다. 업로드·제출하지 않았습니다.');
          if (requiresPartSourcePreparation(w, source) || requiresPartSpaceRestoration(w, source)) throw Error('파트 작업 사본·크기 복원을 먼저 완료하세요. 업로드·제출하지 않았습니다.');
          t.message = '유료 제출 전 파트 원본·식별자·복구 가능 구조를 로컬에서 검사합니다.'; this.save(w);
          await (this.options.preflightPartSource ?? preflightTripoPartSource)({ projectRoot: this.store.directory(id), source: sourceFile,
            objectId: source.objectId, sourceVersionId: source.id, slot: source.slot, blenderPath: this.store.settings.blenderPath,
            resources: this.options.resources, signal: controller.signal });
          controller.signal.throwIfAborted();
          const currentTask = this.get(id).tasks.find(value => value.id === taskId);
          if (currentTask?.status !== 'awaiting_approval') throw Error('실행 확인이 취소됐습니다. 업로드·제출하지 않았습니다.');
        }
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
      } catch (error) {
        const current = this.get(id), pending = current.tasks.find(value => value.id === taskId);
        if (pending?.status === 'awaiting_approval') {
          pending.message = `실행 전 확인 보류 · ${error instanceof Error ? error.message : String(error)} · 업로드·유료 제출 없음`;
          pending.updatedAt = now(); this.save(current);
        }
        throw error;
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
      this.closeRuntimeApproval(t, "interrupted");
      this.save(w);
    }).finally(() => {
      // A transport can finish while its independently delivered question still
      // awaits an answer. Settle that promise too; stale UI must never authorize
      // work after the executor stopped or leave queued candidates hanging.
      const pending = this.pendingApprovals.get(taskId);
      this.pendingApprovals.delete(taskId);
      const latest = this.get(id), current = latest.tasks.find(task => task.id === taskId);
      if (current?.runtimeApproval) { this.closeRuntimeApproval(current, "interrupted"); this.save(latest); }
      this.active.delete(taskId);
      pending?.resolve({ accepted: false, values: {} });
    });
  }
  private savedNativeUsage(id: string, taskId: string): unknown {
    const task = this.get(id).tasks.find(t => t.id === taskId);
    if (task && candidateTasks(task).length > 1) {
      const values = candidateTasks(task).map(child => this.savedNativeUsage(id, child.id));
      const records = values.filter((v): v is { input_tokens: number; cached_input_tokens: number; output_tokens: number } => !!v && typeof v === 'object' && ['input_tokens','cached_input_tokens','output_tokens'].every(k => Number.isSafeInteger((v as Record<string,unknown>)[k])));
      if (!records.length) return undefined;
      return { ...records.reduce((sum, r) => ({ input_tokens: sum.input_tokens + r.input_tokens, cached_input_tokens: sum.cached_input_tokens + r.cached_input_tokens, output_tokens: sum.output_tokens + r.output_tokens }), { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }), measuredCandidates: records.length, totalCandidates: values.length, incomplete: records.length !== values.length };
    }
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
      const delivery = await this.unity({ projectRoot: this.store.directory(id), object: { ...o, settings: t.settings }, versions: inputs, clipSettings: t.unityClipSettings, rigContract: t.unityRigContract, profile: t.targetProfile, blenderPath: this.store.settings.blenderPath, resources: this.options.resources, signal });
      w = this.get(id); if (signal.aborted) return;
      const priorIndex = w.deliveries.findIndex(d => d.id === delivery.id);
      if (priorIndex < 0) w.deliveries.push(delivery); else w.deliveries[priorIndex] = delivery;
      const current = w.tasks.find(x => x.id === taskId)!; current.deliveryId = delivery.id;
      current.status = delivery.status === "failed" || delivery.status === "conflict" ? "failed" : delivery.status === "imported" ? "review" : "running";
      current.message = delivery.errors.length ? delivery.errors.join(" · ") : delivery.status === "imported" ? "동일한 Unity 전달본을 재사용했습니다. 새 생성·재생은 없습니다." : "Unity 가져오기 요청을 저장했습니다. 연결된 Editor가 열리면 처리합니다. 재생은 실행하지 않습니다.";
      current.outputVersionIds = []; this.save(w); return;
    }
    const executor = graphicsProceduralTasks.has(t.taskId) ? this.options.procedural ?? executeGraphicsProcedural : t.taskId === "N01" ? this.options.motionSource ?? executeGraphicsMotionSource : graphicsAstraTasks.has(t.taskId) ? this.astra : graphicsVideoTasks.has(t.taskId) ? this.options.video! : this.native;
    const executions = candidateTasks(t);
    const executeCandidate = async (child: GraphicsTask, candidateIndex: number) => {
      signal.throwIfAborted();
      w = this.get(id);
      if (!t.derivativeRefreshRequested && w.tasks.find(x => x.id === taskId)!.completedExecutions?.includes(child.id)) {
        const existing = w.versions.filter(v => v.provenance.jobId === child.id);
        if (!existing.length) throw Error('완료 후보의 등록 기록이 없습니다. 재생성하지 않습니다.');
        for (const version of existing) for (const file of version.files) this.verified(id, file);
        return;
      }
      const result = await executor({ projectRoot: this.store.directory(id), workspacePath: this.store.file(id, "graphics/workspace.json"), object: { ...o, settings: child.settings, instruction: t.instruction }, task: child, inputs, blenderPath: this.store.settings.blenderPath, resources: this.options.resources, signal, recoveryOnly, refreshDerivatives: t.derivativeRefreshRequested,
        requestApproval: request => this.requestRuntimeApproval(id, taskId, child.id, signal, request),
        onProgress: message => { const latest = this.get(id), task = latest.tasks.find(x => x.id === taskId)!; if (task.status === "running" && !task.runtimeApproval) { task.message = `${executions.length > 1 ? `후보 ${candidateIndex + 1}/${executions.length} · ` : ''}${message}`; task.updatedAt = now(); this.save(latest); } } });
      if (signal.aborted) return;
      w = this.get(id); const current = w.tasks.find(x => x.id === taskId)!;
      const files = result.files.map(f => this.file(id, f.path, f.kind));
      const groups = result.candidates ?? (["I01", "I02", "I03", "I05", "I06", "I07", "I08"].includes(t.taskId)
        ? files.filter(f => image.test(f.path)).map(f => ({ files: [f], role: result.role, slot: result.slot, label: result.imageCandidates?.find(c => c.path === f.path)?.label ?? result.label, warnings: result.warnings }))
        : [{ files, role: result.role, slot: result.slot, label: result.label, warnings: result.warnings }]);
      if (!groups.length || groups.some(g => !g.files.length)) throw Error("등록할 원본 결과가 없습니다.");
      const versions = groups.map((group): AssetVersion => {
        const verified = group.files.map(f => this.file(id, f.path, f.kind));
        const contact = result.contact && ['main', 'contact-review'].includes(group.slot) ? structuredClone(result.contact) : undefined;
        if (contact) {
          validateContactReview(contact, verified.map(file => file.path));
          if (t.taskId !== 'M06' || t.settings.contactPhase !== contact.phase || t.settings.sourceVersionId !== contact.sourceVersionId ||
              t.settings.contactPartVersionIds !== JSON.stringify(contact.partVersionIds) ||
              contact.phase !== 'analyze' && contact.analysisVersionId !== t.settings.contactAnalysisVersionId ||
              contact.phase === 'reconstruct' && (t.settings.contactTopologyReconstructionConfirmed !== true || t.settings['lock.topology'] !== false))
            throw Error('접합 결과가 고정한 요청·원본·파트와 다릅니다. 기존 채택은 유지됩니다.');
        }
        return { id: uid(), objectId: o.id, role: group.role, slot: t.settings.partId && ['design','model','material'].includes(group.role) ? `part-${t.settings.partId}` : group.slot,
          label: `${group.label}${executions.length > 1 ? ` · 후보 ${candidateIndex + 1}` : ''}`, files: verified, createdAt: now(), sourceVersionIds: t.inputVersionIds,
          provenance: { type: t.localOnly ? "local" : graphicsVideoTasks.has(t.taskId) ? "runway" : "codex", jobId: child.id },
          preview: group.role === "motion-reference" ? verified.find(f => /\.(mp4|webm)$/i.test(f.path))?.path : verified.find(f => image.test(f.path))?.path, warnings: group.warnings, ...(contact ? { contact } : {}) };
      });
      if (t.settings.contactPhase && !versions.some(version => version.contact)) throw Error('접합 검토 결과가 누락됐습니다. 기존 원본·채택은 유지됩니다.');
      if (t.settings.contactPhase === 'reconstruct') {
        const reviews = versions.filter(version => version.contact);
        const expectedSlots = reviews[0]?.contact?.status === 'repaired' ? ['main', 'part-head', 'part-body', 'part-hair'] : ['contact-review'];
        if (reviews.length !== 1 || versions.length !== expectedSlots.length || new Set(versions.map(version => version.slot)).size !== expectedSlots.length ||
            versions.some(version => version.role !== 'model' || !expectedSlots.includes(version.slot)) ||
            reviews[0].slot !== (reviews[0].contact!.status === 'repaired' ? 'main' : 'contact-review'))
          throw Error('국소 면 보정의 전체·세 파트 또는 중단 진단이 완전하지 않습니다. 기존 결과와 채택은 유지됩니다.');
      }
      const fresh = t.derivativeRefreshRequested ? versions.filter(version => !w.versions.some(prior => prior.provenance.jobId === child.id && prior.slot === version.slot && JSON.stringify(prior.files) === JSON.stringify(version.files))) : versions;
      w.versions.push(...fresh);
      current.outputVersionIds = t.derivativeRefreshRequested ? [...fresh.map(v => v.id), ...current.outputVersionIds] : [...current.outputVersionIds, ...fresh.map(v => v.id)];
      current.completedExecutions = [...new Set([...(current.completedExecutions ?? []), child.id])];
      if (!current.runtimeApproval) current.message = `후보 ${candidateIndex + 1}/${executions.length} 원본 저장 완료. 나머지 후보 실패 시에도 이 결과는 유지됩니다.`;
      current.updatedAt = now(); current.usage = executions.length === 1 ? result.usage : this.savedNativeUsage(id, taskId);
      this.save(w);
    };
    // Separate immutable work folders and receipts allow independent candidates to overlap.
    // On failure, finish collecting already-started candidates, but do not start additional ones.
    let cursor = 0, failure: unknown;
    const concurrency = graphicsVideoTasks.has(t.taskId) ? 4 : 2;
    await Promise.all(Array.from({ length: Math.min(concurrency, executions.length) }, async () => {
      while (cursor < executions.length && failure === undefined && !signal.aborted) {
        const index = cursor++;
        try { await executeCandidate(executions[index], index); } catch (error) {
          // Any ambiguous paid submission must keep the whole batch blocked,
          // even when an ordinary sibling failure arrived first.
          if (failure === undefined || (error as { code?: string } | null)?.code === "submission_unknown") failure = error;
        }
      }
    }));
    signal.throwIfAborted();
    if (failure !== undefined) throw failure;
    w = this.get(id); const current = w.tasks.find(x => x.id === taskId)!;
    const contactReview = current.outputVersionIds.map(versionId => w.versions.find(version => version.id === versionId)).find(version => version?.contact)?.contact;
    current.status = "review";
    current.message = contactReview
      ? contactReview.status === 'blocked'
        ? '허용 영역에서 안전하게 진행할 수 없어 중단했습니다. 접합 검토에서 이유를 확인하세요. 기존 원본·채택은 유지됩니다.'
        : contactReview.phase === 'analyze'
          ? '수정 영역 제안을 저장했습니다. 색으로 표시한 범위를 확인한 뒤 이 영역만 보정을 선택하세요. 모델은 아직 변경하지 않았습니다.'
          : contactReview.phase === 'reconstruct'
            ? '목·헤어 국소 면 보정의 보호 영역 검사를 통과했습니다. 수정한 면의 UV는 아직 미완료입니다. 전후 비교에서 외형을 확인한 뒤 조립·파트를 함께 채택하세요. 기존 채택은 유지됩니다.'
            : '접합 보정의 원본 보존 검사를 통과했습니다. 전후 비교에서 외형을 확인한 뒤 조립·파트를 함께 채택하세요.'
      : t.derivativeRefreshRequested ? "저장된 분리 결과에서 미리보기를 확인했습니다. 기존 원본·채택 유지, GPT·유료 생성 없음." : "원본을 보존해 새 결과를 등록했습니다. 확인 후 채택하세요.";
    delete current.derivativeRefreshRequested; current.updatedAt = now(); this.save(w);
  }
  private refreshParts(id: string, taskId: string) {
    const w = this.get(id), t = w.tasks.find(t => t.id === taskId);
    if (!t || t.taskId !== "M07" || t.status !== "review" || !t.outputVersionIds.length || !t.completedExecutions?.includes(t.id)) throw Error("완료된 파츠 분리 결과만 갱신할 수 있습니다.");
    if (this.isActive(id) || this.options.legacyActive?.(id) || this.engine.isProjectActive(id)) throw Error("다른 제작이 실행 중입니다.");
    for (const versionId of [...t.inputVersionIds, ...t.outputVersionIds]) {
      const version = w.versions.find(v => v.id === versionId);
      if (!version) throw Error("기존 파츠 원본 등록이 없습니다.");
      for (const file of version.files) this.verified(id, file);
    }
    t.derivativeRefreshRequested = true; t.status = "running"; t.updatedAt = now();
    t.message = "저장된 분리 장면으로 미리보기를 갱신합니다. GPT·유료 생성 없음.";
    this.save(w); this.launch(id, taskId, true); return this.get(id);
  }
  private recoverContactProcedure(id: string, taskId: string) {
    const w = this.get(id), task = w.tasks.find(value => value.id === taskId);
    const firstRequest = task && !task.contactProcedureRecoveryRequested;
    if (!task || task.taskId !== 'M06' || task.settings.contactPhase !== 'reconstruct' ||
        task.settings.contactTopologyReconstructionConfirmed !== true || task.settings['lock.topology'] !== false ||
        !(firstRequest ? task.status === 'review' : ['failed', 'submission_unknown'].includes(task.status)) ||
        !task.completedExecutions?.includes(task.id))
      throw Error('완료된 접합 보정의 저장 전 Blender 호환성 오류만 로컬에서 복구할 수 있습니다. 새 GPT 작업은 시작하지 않습니다.');
    if (this.isActive(id) || this.options.legacyActive?.(id) || this.engine.isProjectActive(id)) throw Error('다른 제작이 실행 중입니다.');
    if (new Set(task.outputVersionIds).size !== task.outputVersionIds.length || task.outputVersionIds.length !== 1)
      throw Error('이미 보정 결과가 있거나 중단 진단이 불명확합니다. 보정 절차를 다시 실행하지 않습니다.');
    const outputs = task.outputVersionIds.map(versionId => w.versions.filter(version => version.id === versionId));
    const diagnostic = outputs[0]?.length === 1 ? outputs[0][0] : undefined;
    if (!diagnostic || diagnostic.objectId !== task.objectId || diagnostic.provenance.jobId !== task.id || diagnostic.slot !== 'contact-review' ||
        diagnostic.contact?.phase !== 'reconstruct' || diagnostic.contact.status !== 'blocked' ||
        diagnostic.contact.sourceVersionId !== task.settings.sourceVersionId || diagnostic.contact.analysisVersionId !== task.settings.contactAnalysisVersionId ||
        JSON.stringify(diagnostic.contact.partVersionIds) !== task.settings.contactPartVersionIds || JSON.stringify(diagnostic.sourceVersionIds) !== JSON.stringify(task.inputVersionIds))
      throw Error('이 작업의 정확한 중단 진단이 없습니다. 이전 결과를 유지합니다.');
    validateContactReview(diagnostic.contact, diagnostic.files.map(file => file.path));
    for (const versionId of [...task.inputVersionIds, ...task.outputVersionIds]) {
      const matches = w.versions.filter(version => version.id === versionId);
      if (matches.length !== 1 || matches[0].objectId !== task.objectId || !matches[0].files.length) throw Error('보정 절차의 고정 입력·출력 연결이 없습니다.');
      for (const file of matches[0].files) this.verified(id, file);
    }
    const work = `graphics/jobs/${task.id}/contact/work`, projectRoot = fs.realpathSync(this.store.directory(id));
    const readProof = (name: string) => {
      const file = this.store.file(id, `${work}/${name}`);
      if (!fs.statSync(file).isFile() || fs.statSync(file).size > 1_000_000 || !fs.realpathSync(file).startsWith(projectRoot + path.sep))
        throw Error('보정 절차 호환성 증거를 확인할 수 없습니다.');
      return fs.readFileSync(file, 'utf8');
    };
    const authorLog = readProof('author.log'), response = JSON.parse(readProof('result.json'));
    if (response.status !== 'needs_input' || !/attribute\s+["']loop_total["']\s+from\s+["']MeshPolygon["']\s+is\s+read-only/i.test(authorLog) ||
        firstRequest && fs.existsSync(this.store.file(id, `${work}/corrected.blend`)))
      throw Error('저장 전 loop_total 읽기 전용 오류가 확인되지 않았습니다. 새 보정은 실행하지 않습니다.');
    // The executor additionally verifies the exact authored script/hash and one-use local dispatch.
    task.contactProcedureRecoveryRequested = true; task.derivativeRefreshRequested = true;
    task.status = 'running'; task.updatedAt = now(); delete task.errorCode;
    task.message = '저장된 보정 절차의 Blender 호환성만 로컬에서 복구합니다. GPT 재호출·유료 생성 없음. 원본·기존 채택을 유지합니다.';
    this.save(w); this.launch(id, taskId, true); return this.get(id);
  }
  private preparePartSource(id: string, versionId: string) {
    const w = this.get(id), provider = w.versions.find(version => version.id === versionId);
    if (!provider || !requiresPartSourcePreparation(w, provider)) throw Error('로컬 작업 사본이 필요한 API 파트 원본이 아닙니다.');
    const task = w.tasks.find(value => value.outputVersionIds.includes(versionId));
    if (!task || !['review', 'failed', ...(task.partSourceRecoveryVersionId ? ['cancelled'] : [])].includes(task.status)) throw Error('완료된 API 파트만 준비할 수 있습니다.');
    if (this.isActive(id) || this.options.legacyActive?.(id) || this.engine.isProjectActive(id)) throw Error('다른 제작이 실행 중입니다.');
    const existing = w.versions.find(version => version.partSource?.providerVersionId === provider.id);
    if (existing) { for (const file of existing.files) this.verified(id, file); return w; }
    const source = provider.files.find(file => isGraphicsProductionFile(file) && /\.fbx$/i.test(file.path));
    if (!source) throw Error('파트 작업 사본에는 원본 FBX가 필요합니다.');
    for (const file of provider.files) this.verified(id, file);
    const controller = new AbortController(); this.active.set(task.id, { projectId: id, controller });
    task.partSourceRecoveryVersionId = provider.id; task.status = 'running'; task.updatedAt = now();
    task.message = '원본은 보존하고 안정적인 파트·메시 식별자를 가진 작업 사본을 로컬에서 준비합니다. 새 GPT·API 제출 없음.'; this.save(w);
    void (this.options.preparePartSource ?? prepareTripoPartSource)({ projectRoot: this.store.directory(id), source,
      objectId: provider.objectId, sourceVersionId: provider.id, slot: provider.slot,
      blenderPath: this.store.settings.blenderPath, resources: this.options.resources, signal: controller.signal,
      onProgress: message => {
        if (controller.signal.aborted) return;
        const current = this.get(id), running = current.tasks.find(value => value.id === task.id);
        if (running?.status === 'running') { running.message = message; running.updatedAt = now(); this.save(current); }
      },
    }).then(result => {
      controller.signal.throwIfAborted();
      const current = this.get(id), running = current.tasks.find(value => value.id === task.id)!;
      if (running.status !== 'running' || running.partSourceRecoveryVersionId !== provider.id) throw Error('파트 준비 상태가 변경됐습니다.');
      for (const file of provider.files) this.verified(id, file);
      const files = result.files.map(file => this.file(id, file.path, file.kind)), report = files.find(file => /\.json$/i.test(file.path));
      if (!report || !['.blend', '.fbx', '.glb'].every(extension => files.some(file => file.path.toLowerCase().endsWith(extension)))) throw Error('파트 작업 원본·미리보기·검사 기록이 없습니다.');
      const version: AssetVersion = { id: uid(), objectId: provider.objectId, role: provider.role, slot: provider.slot,
        label: `${provider.label} · 파트 작업 사본`, files, createdAt: now(), sourceVersionIds: [provider.id],
        provenance: { ...provider.provenance }, warnings: ['API 원본의 형태·UV·재질·위치를 보존한 작업 사본입니다. 파일 검사는 얼굴 형태나 접합 품질의 합격을 뜻하지 않습니다.'],
        partSource: { schemaVersion: 1, providerVersionId: provider.id, reportPath: report.path } };
      current.versions.push(version); running.outputVersionIds.push(version.id);
      running.status = 'review'; delete running.partSourceRecoveryVersionId; running.updatedAt = now();
      running.message = '파트 작업 사본 파일 검사 완료 · 외형 검토와 사용자 채택을 기다립니다.'; this.save(current);
    }).catch(error => {
      const current = this.get(id), running = current.tasks.find(value => value.id === task.id);
      if (running && running.status !== 'cancelled') { running.status = 'failed'; running.updatedAt = now();
        running.message = `파트 작업 사본 준비 보류 · ${error instanceof Error ? error.message : String(error)} · 원본 유지, 새 유료 제출 없음`; this.save(current); }
    }).finally(() => { this.active.delete(task.id); });
    return this.get(id);
  }
  private restorePartSpace(id: string, versionId: string) {
    const w = this.get(id), provider = w.versions.find(version => version.id === versionId);
    if (!provider || !requiresPartSpaceRestoration(w, provider)) throw Error('크기·위치 검사가 필요한 API 파트 결과가 아닙니다.');
    const task = w.tasks.find(task => task.outputVersionIds.includes(versionId));
    if (!task || !['review', 'failed', ...(task.partSpaceRecoveryVersionId ? ['cancelled'] : [])].includes(task.status)) throw Error('완료된 API 결과만 로컬에서 복원할 수 있습니다.');
    if (this.isActive(id) || this.options.legacyActive?.(id) || this.engine.isProjectActive(id)) throw Error('다른 제작이 실행 중입니다.');
    const existing = w.versions.find(version => version.partSpace?.providerVersionId === provider.id);
    if (existing) { for (const file of existing.files) this.verified(id, file); return w; }
    const source = w.versions.find(version => version.id === task.inputVersionIds[0]);
    if (!source || source.objectId !== provider.objectId || source.slot !== provider.slot || !provider.provenance.jobId) throw Error('API 파트의 고정 입력 연결이 없습니다.');
    const sourceFile = source.files.find(file => isGraphicsProductionFile(file) && /\.fbx$/i.test(file.path));
    const providerFile = provider.files.find(file => isGraphicsProductionFile(file) && /\.fbx$/i.test(file.path));
    if (!sourceFile || !providerFile) throw Error('크기·위치 복원에는 입력과 결과의 원본 FBX가 필요합니다.');
    for (const version of [source, provider]) for (const file of version.files) this.verified(id, file);
    const controller = new AbortController();
    this.active.set(task.id, { projectId: id, controller });
    task.partSpaceRecoveryVersionId = provider.id; task.status = 'running'; task.updatedAt = now();
    task.message = '저장된 파트의 원래 크기·위치를 복원하고 UV를 검사합니다. 새 GPT·API 제출 없음.';
    this.save(w);
    const restore = this.options.restorePartSpace ?? restoreTripoPartPreservation;
    void restore({ projectRoot: this.store.directory(id), source: sourceFile, provider: providerFile,
      sourceVersionId: source.id, providerJobId: provider.provenance.jobId, slot: provider.slot,
      blenderPath: this.store.settings.blenderPath, resources: this.options.resources, signal: controller.signal,
      onProgress: message => {
        if (controller.signal.aborted) return;
        const current = this.get(id), running = current.tasks.find(value => value.id === task.id);
        if (running?.status === 'running') { running.message = message; running.updatedAt = now(); this.save(current); }
      },
    }).then(result => {
      controller.signal.throwIfAborted();
      const current = this.get(id), running = current.tasks.find(value => value.id === task.id)!;
      if (running.status !== 'running' || running.partSpaceRecoveryVersionId !== provider.id) throw Error('복원 작업 상태가 변경됐습니다.');
      for (const version of [source, provider]) for (const file of version.files) this.verified(id, file);
      const files = result.files.map(file => this.file(id, file.path, file.kind));
      const report = files.find(file => /\.json$/i.test(file.path));
      if (!report || !files.some(file => /\.blend$/i.test(file.path)) || !files.some(file => /\.fbx$/i.test(file.path)) || !files.some(file => /\.glb$/i.test(file.path))) throw Error('복원한 원본·미리보기·검사 기록이 없습니다.');
      const version: AssetVersion = { id: uid(), objectId: provider.objectId, role: provider.role, slot: provider.slot,
        label: `${provider.label} · 원래 크기·위치`, files, createdAt: now(), sourceVersionIds: [provider.id, source.id],
        provenance: { ...provider.provenance }, warnings: ['API 원본은 별도 보존했습니다. UV·재질은 API 결과를 사용하고 조립 크기·위치와 파트 식별자를 복원했습니다.'],
        partSpace: { schemaVersion: 1, sourceVersionId: source.id, providerVersionId: provider.id, reportPath: report.path } };
      current.versions.push(version); running.outputVersionIds.push(version.id);
      running.status = 'review'; delete running.partSpaceRecoveryVersionId; running.updatedAt = now();
      running.message = 'UV 결과의 원래 크기·위치 복원 완료. 새 API·GPT 요청 없이 저장된 결과를 복구했습니다. 확인 후 채택하세요.';
      this.save(current);
    }).catch(error => {
      const current = this.get(id), running = current.tasks.find(value => value.id === task.id);
      if (running && running.status !== 'cancelled') { running.status = 'failed'; running.updatedAt = now();
        running.message = `파트 크기·위치 복원 보류 · ${error instanceof Error ? error.message : String(error)} · 기존 원본 유지, 새 유료 제출 없음`; this.save(current); }
    }).finally(() => { this.active.delete(task.id); });
    return this.get(id);
  }
  private planar(id:string,versionId:string,selection?:PlanarSelection,recovery?:GraphicsTask) {
    if(recovery&&recovery.settings.algorithmVersion!==CURRENT_PLANAR_ALGORITHM)throw Error('이전 평면 작업은 새 알고리즘으로 재실행하지 않습니다. 이미 저장된 완료 후보는 유지됩니다. 새 복구는 명시적으로 다시 검사하세요.');
    const w=this.get(id),source=w.versions.find(v=>v.id===versionId);
    if(!source || source.role!=='model')throw Error('검사할 정적 모델을 선택하세요.');
    const file=source.files.find(f=>isGraphicsProductionFile(f)&&/\.blend$/i.test(f.path))??source.files.find(f=>isGraphicsProductionFile(f)&&/\.fbx$/i.test(f.path));
    if(!file)throw Error('검사에는 BLEND 또는 FBX 원본이 필요합니다.');
    for(const f of source.files)this.verified(id,f);
    const sourceCompanions=planarCompanions(source.files);
    if(recovery && sourceCompanions.length && recovery.settings.sourceCompanionsJson!==JSON.stringify(sourceCompanions))throw Error('동반 이미지가 고정된 작업과 다릅니다. 명시적으로 다시 검사하세요.');
    const inspection=recovery?.planarInspection??(recovery&&selection?undefined:w.planarInspections?.[versionId]);
    if(recovery&&recovery.settings.sourceSha256!==file.sha256)throw Error('중단된 로컬 작업의 고정 원본이 변경됐습니다.');
    if(selection){if(sourceCompanions.length && (inspection?.sourceManifestVersion!==1 || JSON.stringify(inspection?.sourceCompanions??[])!==JSON.stringify(sourceCompanions)))throw Error('동반 이미지의 명시적 재검사가 필요합니다.');if(!inspection||inspection.sourceSha256!==file.sha256)throw Error('현재 원본의 경계 검사가 필요합니다.');validatePlanarSelection(inspection,selection);if(!inspection.reportFile)throw Error('저장된 경계 검사 파일이 없습니다.');this.verified(id,inspection.reportFile);const stored=JSON.parse(fs.readFileSync(this.store.file(id,inspection.reportFile.path),'utf8'));if(JSON.stringify(stored)!==JSON.stringify(Object.fromEntries(Object.entries(inspection).filter(([k])=>k!=='reportFile'))))throw Error('경계 검사 기록이 달라졌습니다.');}
    const frozen=selection?{versionId,inspectionId:selection.inspectionId,meshId:selection.meshId,selectedBoundaryIds:[...selection.selectedBoundaryIds],keptBoundaryIds:[...selection.keptBoundaryIds],materialPolicy:selection.materialPolicy}:undefined;
    const requestHash=hash(JSON.stringify({source:versionId,sha:file.sha256,...(sourceCompanions.length?{sourceCompanions,sourceManifestVersion:1}:{}),selection:frozen??null,inspectionReportSha256:inspection?.reportFile?.sha256??null,inspectionIdentity:inspection?.identity??null,algorithmVersion:inspection?.algorithmVersion??CURRENT_PLANAR_ALGORITHM}));
    const prior=w.tasks.find(t=>t.taskId==='LOCAL_PLANAR_REPAIR'&&t.requestHash===requestHash);
    if(prior&&!recovery)return w;
    if(this.isActive(id)||this.options.legacyActive?.(id)||this.engine.isProjectActive(id))throw Error('다른 제작이 실행 중입니다.');
    const task=(recovery?w.tasks.find(t=>t.id===recovery.id):undefined)??{id:uid(),objectId:source.objectId,taskId:selection?'LOCAL_PLANAR_REPAIR':'LOCAL_PLANAR_INSPECT',createdAt:now(),updatedAt:now(),status:'running' as const,inputVersionIds:[versionId],settings:{algorithmVersion:CURRENT_PLANAR_ALGORITHM,sourceSha256:file.sha256,...(sourceCompanions.length?{sourceCompanionsJson:JSON.stringify(sourceCompanions),sourceManifestVersion:1}:{})},instruction:'명시적으로 선택한 정적 평면 경계만 로컬 검사·보완',requestHash,outputVersionIds:[],backendJobIds:[],message:'로컬 검사 준비 · GPT 0 · 유료 제출 0',localOnly:true,...(frozen?{planarSelection:frozen,planarInspection:structuredClone(inspection!)}:{})};
    if(!recovery)w.tasks.push(task);task.status='running';task.updatedAt=now();this.save(w);
    const controller=new AbortController();this.active.set(task.id,{projectId:id,controller});
    void(this.options.planar??runGraphicsPlanar)({projectRoot:this.store.directory(id),source:file,...(sourceCompanions.length?{sourceCompanions}:{}),sourceVersionId:versionId,resources:this.options.resources,blenderPath:this.store.settings.blenderPath,signal:controller.signal,mode:selection?'repair':'inspect',inspectionAttempt:selection?undefined:task.id,selection:frozen,inspection:selection?inspection:undefined,recoveryOnly:!!recovery,onProgress:message=>{if(controller.signal.aborted)return;const current=this.get(id),t=current.tasks.find(t=>t.id===task.id);if(t?.status==='running'){t.message=message;t.updatedAt=now();this.save(current);}}}).then(result=>{
      controller.signal.throwIfAborted();const current=this.get(id),t=current.tasks.find(t=>t.id===task.id)!;if(t.status!=='running')throw Error('로컬 검사 상태가 변경됐습니다.');for(const f of source.files)this.verified(id,f);for(const f of result.files)this.verified(id,f);
      validatePlanarReport(result.report,{projectRoot:this.store.directory(id),source:file,...(sourceCompanions.length?{sourceCompanions}:{}),sourceVersionId:versionId,resources:this.options.resources,blenderPath:this.store.settings.blenderPath,signal:controller.signal,mode:selection?'repair':'inspect',selection:frozen},result.report.identity);const reportFile=result.files.find(f=>f.kind==='report');if(!reportFile||result.report.passed!==true||result.report.sourceVersionId!==versionId||result.report.sourceSha256!==file.sha256||result.report.localOnly!==true||result.report.modelTurns!==0||result.report.paidSubmissions!==0||JSON.stringify(JSON.parse(fs.readFileSync(this.store.file(id,reportFile.path),'utf8')))!==JSON.stringify(result.report))throw Error('고정된 로컬 결과 기록이 다릅니다.');
      if(!selection){current.planarInspections??={};current.planarInspections[versionId]={...result.report,reportFile} as PlanarInspection;t.message='경계 검사 완료 · 검사 기록은 채택할 모델이 아닙니다.';}
      else{if(!['.blend','.fbx','.glb'].every(ext=>result.files.some(f=>f.path.endsWith(ext))))throw Error('완전한 보완 파일이 없습니다.');const v:AssetVersion={id:uid(),objectId:source.objectId,role:source.role,slot:source.slot,label:source.label+' · 평면 경계 보완',files:result.files,createdAt:now(),sourceVersionIds:[versionId],provenance:{type:'local'},warnings:result.report.warnings??[],planarRepair:{schemaVersion:1,...frozen!,sourceSha256:file.sha256,identity:result.report.identity,algorithmVersion:CURRENT_PLANAR_ALGORITHM,reportPath:reportFile.path}};current.versions.push(v);t.outputVersionIds.push(v.id);t.message='선택한 경계 보완 완료 · 원본은 보존됩니다. 결과를 검토하고 채택하세요.';}
      t.status='review';t.updatedAt=now();this.save(current);
    }).catch(error=>{const current=this.get(id),t=current.tasks.find(t=>t.id===task.id);if(t&&t.status!=='cancelled'){t.status='failed';t.message='로컬 보완 보류 · '+(error instanceof Error?error.message:String(error));t.updatedAt=now();this.save(current);}}).finally(()=>this.active.delete(task.id));return this.get(id);
  }
  private repairSurface(id: string, versionId: string) {
    const w = this.get(id), provider = w.versions.find(version => version.id === versionId);
    const lineage = provider && surfaceRepairSources(w, provider);
    if (!provider || !lineage) throw Error('보완 원본과 연결된 저장 텍스처 결과를 선택하세요.');
    const task = w.tasks.find(task => task.taskId === 'T03' && task.objectId === provider.objectId && task.outputVersionIds.includes(versionId))!;
    if (!['review', 'failed', ...(task.surfaceRecoveryVersionId === provider.id ? ['cancelled'] : [])].includes(task.status)) throw Error('완료된 텍스처 결과만 복구할 수 있습니다.');
    if (this.isActive(id) || this.options.legacyActive?.(id) || this.engine.isProjectActive(id)) throw Error('다른 제작이 실행 중입니다.');
    const existing = w.versions.find(version => version.surfaceRepair?.providerVersionId === provider.id);
    if (existing) { for (const file of existing.files) this.verified(id, file); return w; }
    const { repair, original } = lineage;
    const versions = [provider, repair, original];
    const files = versions.map(version => version.files.find(file => isGraphicsProductionFile(file) && /\.fbx$/i.test(file.path)));
    if (files.some(file => !file)) throw Error('기존 재질 복구에는 텍스처·보완·보완 전 원본의 FBX가 필요합니다.');
    for (const version of versions) for (const file of version.files) this.verified(id, file);
    const controller = new AbortController();
    this.active.set(task.id, { projectId: id, controller });
    task.surfaceRecoveryVersionId = provider.id; task.status = 'running'; task.updatedAt = now();
    task.message = '저장된 금속·색상 무늬로 빈 면의 UV를 로컬에서 복구합니다. 추가 API 비용·제작 GPT 호출 없음.';
    this.save(w);
    void (this.options.repairSurface ?? repairGraphicsSurface)({
      projectRoot: this.store.directory(id), source: files[0]!, sourceVersionId: provider.id,
      repairSource: files[1]!, repairVersionId: repair.id, originalSource: files[2]!, originalVersionId: original.id,
      mode: 'reuse-planar-material', blenderPath: this.store.settings.blenderPath,
      resources: this.options.resources, signal: controller.signal,
      onProgress: message => {
        if (controller.signal.aborted) return;
        const current = this.get(id), running = current.tasks.find(value => value.id === task.id);
        if (running?.status === 'running' && running.surfaceRecoveryVersionId === provider.id) { running.message = message; running.updatedAt = now(); this.save(current); }
      },
    }).then(result => {
      controller.signal.throwIfAborted();
      const current = this.get(id), running = current.tasks.find(value => value.id === task.id)!;
      if (running.status !== 'running' || running.surfaceRecoveryVersionId !== provider.id) throw Error('재질 복구 상태가 변경됐습니다.');
      for (const version of versions) for (const file of version.files) this.verified(id, file);
      const report = result.report;
      if (report.passed !== true || report.sourceVersionId !== provider.id || report.sourceSha256 !== files[0]!.sha256 ||
          report.repairVersionId !== repair.id || report.repairSourceSha256 !== files[1]!.sha256 ||
          report.originalVersionId !== original.id || report.originalSourceSha256 !== files[2]!.sha256 ||
          report.localOnly !== true || report.modelTurns !== 0 || report.paidSubmissions !== 0 || !Array.isArray(report.warnings) ||
          report.uniqueUvLayout !== false || report.visualQualityVerified !== false ||
          ['staticOnly', 'appendOnlyAncestry', 'uniformCorrespondence', 'geometryPreserved', 'originalUVPreserved', 'onlyAddedDegenerateUVChanged', 'materialsAndImagesPreserved', 'allFacesHaveUV', 'fbxRoundTrip'].some(key => report.checks?.[key] !== true))
        throw Error('재질 복구의 고정 원본·검사 기록이 다릅니다.');
      for (const file of result.files) this.verified(id, file);
      const output = result.files.map(file => this.file(id, file.path, file.kind)), reportFile = output.find(file => /\.json$/i.test(file.path));
      if (!reportFile || !['.blend', '.fbx', '.glb'].every(extension => output.some(file => file.path.toLowerCase().endsWith(extension)))) throw Error('재질 복구 원본·미리보기·검사 기록이 없습니다.');
      if (reportFile.bytes > 16 * 1024 * 1024 || JSON.stringify(JSON.parse(fs.readFileSync(this.store.file(id, reportFile.path), 'utf8'))) !== JSON.stringify(report)) throw Error('저장된 재질 복구 검사 기록이 다릅니다.');
      const version: AssetVersion = { id: uid(), objectId: provider.objectId, role: provider.role, slot: provider.slot,
        label: `${provider.label} · 빈 면 재질 복구`, files: output, createdAt: now(), sourceVersionIds: versions.map(version => version.id),
        provenance: { type: 'local' }, warnings: report.warnings,
        surfaceRepair: { schemaVersion: 1, providerVersionId: provider.id, repairVersionId: repair.id, originalVersionId: original.id, reportPath: reportFile.path } };
      current.versions.push(version); running.outputVersionIds.push(version.id);
      running.status = 'review'; delete running.surfaceRecoveryVersionId; running.updatedAt = now();
      running.message = '기존 재질로 빈 면 UV 복구 완료 · 파일 보존 검사 통과. 공유한 무늬와 경계를 확인하고 수정본을 채택하세요. 추가 생성 비용 없음.';
      this.save(current);
    }).catch(error => {
      const current = this.get(id), running = current.tasks.find(value => value.id === task.id);
      if (running && running.status !== 'cancelled') { running.status = 'failed'; running.updatedAt = now();
        running.message = `기존 재질 복구 보류 · ${error instanceof Error ? error.message : String(error)} · 원본 유지, 새 유료 제출 없음`; this.save(current); }
    }).finally(() => this.active.delete(task.id));
    return this.get(id);
  }
  async recover(id: string, taskId: string) {
    const w = this.get(id), t = w.tasks.find(t => t.id === taskId);
    if (!t || !["failed", "submission_unknown", ...(t.taskId.startsWith("LOCAL_PLANAR_") ? ["cancelled"] : [])].includes(t.status)) throw Error("복구할 중단 작업이 없습니다.");
    if(t.taskId==='LOCAL_PLANAR_INSPECT')return this.planar(id,t.inputVersionIds[0],undefined,t);
    if (t.planarSelection) return this.planar(id,t.planarSelection.versionId,t.planarSelection,t);
    if (t.contactProcedureRecoveryRequested) return this.recoverContactProcedure(id, taskId);
    if (t.partSpaceRecoveryVersionId) return this.restorePartSpace(id, t.partSpaceRecoveryVersionId);
    if (t.partSourceRecoveryVersionId) return this.preparePartSource(id, t.partSourceRecoveryVersionId);
    if (t.surfaceRecoveryVersionId) return this.repairSurface(id, t.surfaceRecoveryVersionId);
    if (this.isActive(id) || this.options.legacyActive?.(id) || this.engine.isProjectActive(id)) throw Error("다른 제작이 실행 중입니다.");
    if (t.taskId === "X05" && !t.objectSnapshot?.accepted && !t.deliveryId) throw Error("이전 Unity 요청에 고정된 채택 기록이 없습니다. 새 전달 요청을 준비하세요. 원본은 보존됩니다.");
    if (t.quoteId) {
      const p = this.store.project(id), jobs = p.jobs.filter(j => j.quoteId === t.quoteId);
      if (!jobs.length || jobs.some(j => !j.remoteId)) throw Error("제출 확인이 없어 자동 재제출하지 않습니다. API 작업 ID를 확인하세요.");
      t.backendJobIds = jobs.map(j => j.id); t.status = "running"; this.save(w);
      for (const j of jobs) await this.engine.poll(id, j.id);
      this.sync(); return this.get(id);
    }
    let uploadRetry = false;
    if (!t.localOnly) {
      const readProof = (relative: string) => {
        try {
          const file = this.store.file(id, relative), root = fs.realpathSync(this.store.directory(id));
          if (!fs.statSync(file).isFile() || fs.statSync(file).size > 1_000_000 || !fs.realpathSync(file).startsWith(root + path.sep)) return undefined;
          return JSON.parse(fs.readFileSync(file, "utf8"));
        } catch { return undefined; }
      };
      const pending = candidateTasks(t).filter(child => !t.completedExecutions?.includes(child.id));
      const first = pending[0];
      if (graphicsVideoTasks.has(t.taskId)) {
        // Checking only the first child lets a later ambiguous submission enter
        // recovery and then be downgraded to an ordinary failed task.
        for (const child of pending) {
          const packet = readProof(`graphics/jobs/${child.id}/external-request.json`);
          const state = readProof(`graphics/video-journal/${t.objectId}/${child.id}-state.json`);
          const receipt = readProof(`graphics/jobs/${child.id}/external-result.json`);
          if (packet?.jobId !== child.id)
            throw Error("기존 영상의 원격 작업 ID 또는 저장 결과가 없습니다. 완료 후보는 유지하며 복구에서 첫 업로드·유료 제출을 시작하지 않습니다.");
          if (!receipt && (typeof state?.taskId !== "string" || !/^[\w-]{1,200}$/.test(state.taskId))) {
            if (child.status !== "failed" || child.message !== "Runway 원본 업로드 도구 실패: user rejected MCP tool call")
              throw Error("기존 영상의 원격 작업 ID 또는 저장 결과가 없습니다. 완료 후보는 유지하며 복구에서 첫 업로드·유료 제출을 시작하지 않습니다.");
            // The only exception is a proven pre-submission upload-permission rejection.
            // The explicit app recovery preserves the exact saved cost approval and
            // asks for the tool permission again; it is never an automatic retry.
            const object = { ...this.object(w, t.objectId), ...t.objectSnapshot };
            const inputs = t.inputVersionIds.map(versionId => w.versions.find(version => version.id === versionId)!);
            if (inputs.some(version => !version)) throw Error("고정 입력 버전이 없습니다.");
            prepareGraphicsVideoUploadRetry({ projectRoot: this.store.directory(id), object, task: child, inputs });
            uploadRetry = true;
          }
        }
      } else if (first) {
        const relative = graphicsAstraTasks.has(t.taskId) ? `graphics/jobs/${first.id}/astra/dispatch.json` : `graphics/jobs/${first.id}/dispatch.json`;
        if (readProof(relative)?.taskId !== first.id) throw Error("저장된 원본 생성 실행 기록이 없습니다. 완료 후보는 유지하며 복구에서 새 GPT 요청을 시작하지 않습니다.");
      }
    }
    // Executors independently verify saved results or the narrow one-use upload proof.
    t.status = "running"; t.updatedAt = now(); delete t.errorCode;
    t.message = uploadRetry ? "제출 전 업로드 거절을 확인했습니다. 도구 권한을 다시 확인하고 기존 승인 비용 범위에서 영상 1회를 진행합니다." : "기존 저장 결과와 로컬 완료 지점만 복구합니다.";
    this.save(w); this.launch(id, t.id, true); return this.get(id);
  }
  sync() {
    for (const w of this.list()) {
      let changed = false;
      const p = this.store.project(w.projectId);
      const restoreVersions: string[] = [];
      const prepareVersions: string[] = [];
      for (const t of w.tasks.filter(t => t.status === "running" && t.quoteId && !t.partSpaceRecoveryVersionId && !t.partSourceRecoveryVersionId && !t.surfaceRecoveryVersionId)) {
        const jobs = p.jobs.filter(j => j.quoteId === t.quoteId);
        if (!jobs.length) continue;
        if (jobs.some(j => ["queued", "submitting", "running"].includes(j.status))) continue;
        if (this.engine.isProjectActive(w.projectId)) continue;
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
                const original = inputs[index]!.files.find(file => isGraphicsProductionFile(file) && (["M01", "M02"].includes(t.taskId) || t.taskId === "T03" && index > 0 ? image : /\.(fbx|glb|obj|stl)$/i).test(file.path));
                if (!alias || !original || alias.file !== original.path || (alias.nativeFile ?? alias.file) !== original.path)
                  throw Error("API 업로드 원본과 고정한 입력 파일이 다릅니다.");
              }
              for (const a of this.engine.verifiedTripoAssets(w.projectId, j.id)) {
                const rels = [...new Set([a.nativeFile, a.file, ...(j.nativeFiles ?? [])].filter((r): r is string => typeof r === "string"))];
                const files = rels.map(rel => this.file(w.projectId, rel, a.kind));
                // Optional native FBX statistics. Legacy previews remain unmeasured;
                // never rebuild them or infer original polygon counts from a GLB.
                if (a.nativeFile && /\.fbx$/i.test(a.nativeFile) && /\.glb$/i.test(a.file)) {
                  const reportPath = a.file.replace(/\.glb$/i, ".report.json"), reportFile = this.store.file(w.projectId, reportPath);
                  if (fs.existsSync(reportFile) && fs.statSync(reportFile).size <= 1024 * 1024) {
                    try {
                      const reportAsset = this.file(w.projectId, reportPath, "report"), report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
                      const native = files.find(file => file.path === a.nativeFile!.replaceAll("\\", "/"));
                      if (report.schemaVersion === 1 && report.mode === "convert" && report.previewOnly === true &&
                          report.nativeSourceSha256 === native?.sha256 && [report.faces, report.triangles].every(value => Number.isSafeInteger(value) && value > 0) && report.triangles >= report.faces)
                        files.push(reportAsset);
                    } catch { /* Missing/invalid statistics must not alter an otherwise verified native result. */ }
                  }
                }
                const label = (findGraphicsTask(t.taskId)?.name ?? a.label) + (batchAssets.length > 1 ? ` · ${batchAssets.indexOf(a) + 1}` : "");
                const v: AssetVersion = { id: uid(), objectId: t.objectId, role: "model", slot: t.settings.partId ? `part-${t.settings.partId}` : "main", label, files, createdAt: now(), sourceVersionIds: t.inputVersionIds, provenance: { type: "tripo", jobId: j.id, remoteId: j.remoteId }, warnings: j.message ? [j.message] : [] };
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
        if (t.status === 'review') restoreVersions.push(...newVersions.filter(version => requiresPartSpaceRestoration(w, version)).map(version => version.id));
        if (t.status === 'review') prepareVersions.push(...newVersions.filter(version => requiresPartSourcePreparation(w, version)).map(version => version.id));
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
      if (prepareVersions.length === 1) {
        try { this.preparePartSource(w.projectId, prepareVersions[0]); }
        catch (error) {
          const current = this.get(w.projectId), task = current.tasks.find(task => task.outputVersionIds.includes(prepareVersions[0]));
          if (task) { task.status = 'failed'; task.partSourceRecoveryVersionId = prepareVersions[0];
            task.message = `파트 작업 사본 준비 필요 · ${error instanceof Error ? error.message : String(error)}`; this.save(current); }
        }
      }
      // Continue the approved task with local normalization only. Startup/review
      // browsing never transforms old results or replays a remote submission.
      if (restoreVersions.length === 1) {
        try { this.restorePartSpace(w.projectId, restoreVersions[0]); }
        catch (error) {
          const current = this.get(w.projectId), task = current.tasks.find(task => task.outputVersionIds.includes(restoreVersions[0]));
          if (task) { task.status = 'failed'; task.partSpaceRecoveryVersionId = restoreVersions[0];
            task.message = `파트 원래 크기·위치 검사 필요 · ${error instanceof Error ? error.message : String(error)}`; this.save(current); }
        }
      }
    }
  }
  private inspectLegacy(id: string): NonNullable<GraphicsWorkspace["legacyPreview"]> {
    const w = this.get(id), p = this.store.project(id);
    const versions: AssetVersion[] = [];
    for (const a of p.assets) {
      const versionId = `legacy-${a.id}`;
      if (w.versions.some(v => v.id === versionId) || a.id.startsWith("graphics-")) continue;
      try { const files = [...new Set([a.file, a.nativeFile].filter((v): v is string => !!v))].map(rel => this.file(id, rel, a.kind));
        if (files.length) versions.push({ id: versionId, objectId: "legacy", role: a.kind === "image" ? "design" : "model", slot: "main", label: a.label, files, createdAt: a.createdAt, sourceVersionIds: [], provenance: { type: "legacy", ...(a.jobId ? { jobId: a.jobId } : {}) }, warnings: [] });
      } catch { /* Missing originals remain in legacy history; do not invent copies. */ }
    }
    const roles: Record<string, GraphicsRole> = { concept: "design", separate: "design", model: "model", surface: "model", assembly: "model", rig: "rig", reference: "motion-reference", animation: "animation" };
    for (const bench of this.store.all<Workbench>("workbench").filter(b => b.projectId === id)) {
      for (const j of bench.jobs.filter(j => j.status === "review" && roles[j.step])) for (const c of j.candidates) {
        const versionId = `legacy-${j.id}-${c.id}`; if (w.versions.some(v => v.id === versionId)) continue;
        try { const files = c.artifacts.map(f => { this.verified(id, f); return { path: f.path, kind: f.kind, sha256: f.sha256, bytes: f.bytes }; });
          if (files.length) versions.push({ id: versionId, objectId: "legacy", role: roles[j.step], slot: j.step === "animation" ? j.slot : "main", label: c.label, files, createdAt: j.createdAt, sourceVersionIds: [], provenance: { type: "legacy", jobId: j.id }, warnings: ["기존 기록에서 가져온 결과입니다. 새 작업 공간에서는 채택을 다시 확인하세요."] });
        } catch { /* Invalid old artifacts stay visible in the original workbench only. */ }
      }
    }
    const objectName = w.objects.find(object => object.id === "legacy")?.name ?? `${p.name} · 기존 결과`;
    return { versions, objectName, fingerprint: hash(JSON.stringify({ projectId: id, objectName, versions })) };
  }
  private importLegacy(id: string, versionIds: string[], fingerprint: string) {
    if (!Array.isArray(versionIds) || !versionIds.length || versionIds.some(value => typeof value !== "string") || new Set(versionIds).size !== versionIds.length)
      throw Error("연결할 기존 자료를 선택하세요.");
    const preview = this.inspectLegacy(id);
    const selected = versionIds.map(versionId => preview.versions.find(version => version.id === versionId));
    if (fingerprint !== preview.fingerprint || selected.some(version => !version))
      throw Error("기존 자료가 변경됐습니다. 연결할 자료를 다시 확인하세요.");
    const w = this.get(id);
    if (!w.objects.some(object => object.id === "legacy"))
      w.objects.push({ id: "legacy", name: preview.objectName, kind: "prop", createdAt: now(), selectedTasks: [], instruction: "", settings: { count: 1 }, references: [], accepted: {} });
    w.versions.push(...selected as AssetVersion[]);
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
        if ((raw as { incomplete?: boolean }).incomplete) usage.missingWorkers++;
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
