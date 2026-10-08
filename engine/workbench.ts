import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store, uid } from "./store";
import { inspectWorkbenchGlb } from "./glb-inspect";
import {
  blocksWorkbenchCheck,
  normalizeWorkbenchChecks,
} from "../shared/workbench-checks";
import {
  WORKBENCH_ROLES,
  WORKBENCH_STEPS,
  workbenchSlot,
  type Workbench,
  type WorkbenchAction,
  type WorkbenchApproval,
  type WorkbenchArtifact,
  type WorkbenchCandidate,
  type WorkbenchExecutionContext,
  type WorkbenchExecutor,
  type WorkbenchJob,
  type WorkbenchRequest,
  type WorkbenchRecovery,
  type WorkbenchResult,
  type WorkbenchSelection,
} from "../shared/workbench";

const now = () => new Date().toISOString();
const hash = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const json = <T>(file: string): T =>
  JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const equal = (a?: WorkbenchSelection, b?: WorkbenchSelection) =>
  a?.jobId === b?.jobId && a?.candidateId === b?.candidateId;
const external = (job: WorkbenchJob) =>
  ["concept", "model", "surface", "reference"].includes(job.step);
const safeRelative = (root: string, relative: string) => {
  if (!relative || path.isAbsolute(relative))
    throw new Error("산출물은 작업 폴더 안의 상대 경로여야 합니다.");
  const file = path.resolve(root, relative);
  if (!file.startsWith(path.resolve(root) + path.sep))
    throw new Error("작업 폴더 밖 파일 접근이 거부되었습니다.");
  const resolved = fs.realpathSync(file);
  if (!resolved.startsWith(fs.realpathSync(root) + path.sep))
    throw new Error("외부 파일 연결은 허용되지 않습니다.");
  if (!fs.statSync(resolved).isFile())
    throw new Error("산출물은 실제 파일이어야 합니다.");
  return resolved;
};

const MAX_RECOVERY_ATTEMPTS = 3;
const DEFAULT_RECOVERY_DELAYS_MS = [2000, 5000, 10000] as const;
const messageOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 4000);
const waitForRecovery = (milliseconds: number, signal: AbortSignal) =>
  new Promise<boolean>((resolve) => {
    if (signal.aborted) return resolve(false);
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      resolve(ready);
    };
    const aborted = () => finish(false);
    const timer = setTimeout(() => finish(true), milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
  });

/** Persistent user-driven workflow. Recovery only continues the current job, never another stage. */
export class WorkbenchEngine {
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private readonly recoveryDelaysMs: readonly number[];
  constructor(
    private store: Store,
    private executor: WorkbenchExecutor,
    options: { recoveryDelaysMs?: readonly number[] } = {},
  ) {
    const delays = options.recoveryDelaysMs ?? DEFAULT_RECOVERY_DELAYS_MS;
    if (
      delays.length !== MAX_RECOVERY_ATTEMPTS ||
      delays.some((value) => !Number.isFinite(value) || value < 0)
    )
      throw new Error("자동 복구 대기 시간은 0 이상인 세 값이어야 합니다.");
    this.recoveryDelaysMs = [...delays];
    for (const w of this.list()) {
      let changed = false;
      for (const j of w.jobs)
        if (j.status === "running") {
          j.status = external(j) ? "submission_unknown" : "failed";
          j.summary = external(j)
            ? "앱이 종료되어 제출 여부를 확인해야 합니다. 중복 생성하지 않습니다."
            : "앱 종료로 작업이 중단되었습니다. 기존 버전과 파일은 보존되었습니다.";
          j.updatedAt = now();
          if (j.recovery) {
            j.recovery.state = "blocked";
            j.recovery.reason = j.summary;
            delete j.recovery.nextAttemptAt;
          }
          changed = true;
        }
      if (changed || w.activeJobId) {
        delete w.activeJobId;
        this.save(w);
      }
    }
  }
  list(projectId?: string) {
    return this.store
      .all<Workbench>("workbench")
      .filter((w) => !projectId || w.projectId === projectId);
  }
  get(id: string) {
    const w = this.store.get<Workbench>("workbench", id);
    if (!w) throw new Error("에셋 작업실을 찾을 수 없습니다.");
    return w;
  }
  getForProject(projectId: string) {
    return this.list(projectId)[0];
  }
  create(projectId: string) {
    this.store.project(projectId);
    const existing = this.getForProject(projectId);
    if (existing) return existing;
    return this.save({
      schemaVersion: 1,
      id: uid(),
      projectId,
      createdAt: now(),
      updatedAt: now(),
      jobs: [],
      selections: {},
      message: "각 단계의 설정과 결과를 확인하면서 제작합니다.",
    });
  }
  private save(w: Workbench) {
    w.updatedAt = now();
    this.store.put("workbench", w.id, w);
    this.store.write(
      w.projectId,
      `workbench/${w.id}/workbench.json`,
      JSON.stringify(w, null, 2),
    );
    return w;
  }
  async probe() {
    return (
      this.executor.probe?.() ?? {
        available: false,
        message: "작업자 연결 상태를 확인할 수 없습니다.",
      }
    );
  }
  action(projectId: string, action: WorkbenchAction): Workbench {
    const w = this.getForProject(projectId) ?? this.create(projectId);
    switch (action.kind) {
      case "execute":
        return this.execute(w.id, action.request, action.approval);
      case "select":
        return this.select(w.id, action.jobId, action.candidateId);
      case "accept":
        return this.accept(w.id, action.jobId);
      case "revert":
        return this.revert(w.id, action.jobId, action.candidateId);
      case "cancel":
        return this.cancel(w.id);
      case "import-source":
        return this.importSource(w.id, action.assetId);
      case "retry-validation":
        return this.retryValidation(w.id, action.jobId);
      case "retry":
        return this.retry(w.id, action.jobId);
      case "inspect-saved":
        return this.inspectSaved(w.id, action.jobId);
      case "resolve-submission": {
        this.idle(w);
        if (action.confirmedNotSubmitted !== true)
          throw new Error("Studio에서 미제출을 확인해야 합니다.");
        const j = this.job(w, action.jobId);
        if (j.status !== "submission_unknown")
          throw new Error("제출 확인이 필요한 작업이 아닙니다.");
        if (this.executor.hasSubmission?.(j))
          throw new Error(
            "실제 제출 기록이 있습니다. 미제출로 해제할 수 없으며 기존 작업을 이어서 확인하세요.",
          );
        j.status = "cancelled";
        j.summary =
          "사용자가 외부 서비스에서 미제출 상태를 확인했습니다. 새 실행에는 새 승인이 필요합니다.";
        j.updatedAt = now();
        return this.save(w);
      }
      default:
        throw new Error("알 수 없는 작업실 명령입니다.");
    }
  }
  private idle(w: Workbench) {
    if (w.activeJobId || this.active.has(w.id))
      throw new Error("현재 작업이 끝나거나 중지된 뒤 변경할 수 있습니다.");
  }
  private workerIdle() {
    if (this.active.size)
      throw new Error(
        "다른 프로젝트에서 작업자가 실행 중입니다. 현재 작업이 끝나거나 중지된 뒤 실행하세요.",
      );
  }
  private job(w: Workbench, id: string) {
    const j = w.jobs.find((j) => j.id === id);
    if (!j) throw new Error("작업 버전을 찾을 수 없습니다.");
    return j;
  }
  private chosen(w: Workbench, slot: string) {
    const selected = w.selections[slot];
    if (!selected) throw new Error(`먼저 ${slot} 결과를 확인하고 채택하세요.`);
    const job = this.job(w, selected.jobId);
    const candidate = job.candidates.find((c) => c.id === selected.candidateId);
    if (job.status !== "review" || !candidate)
      throw new Error("선택한 결과 버전을 사용할 수 없습니다.");
    if (!this.current(w, job))
      throw new Error("입력이 바뀐 이전 결과입니다. 현재 입력으로 작업하세요.");
    this.verifyArtifacts(w, candidate.artifacts);
    return { job, candidate, selected };
  }
  private current(w: Workbench, job: WorkbenchJob) {
    return Object.entries(job.dependencies).every(([slot, selection]) =>
      equal(w.selections[slot], selection),
    );
  }
  private dependencySlots(w: Workbench, request: WorkbenchRequest) {
    switch (request.step) {
      case "concept":
        return [];
      case "separate":
        return ["concept"];
      case "model":
        return ["concept", "separate"];
      case "surface":
        return [
          "concept",
          "separate",
          ...WORKBENCH_ROLES.map((r) => `model:${r}`),
        ];
      case "assembly":
        return ["concept", "surface"];
      case "rig":
        return ["assembly"];
      case "reference":
        return ["concept", "rig"];
      case "animation":
        return ["rig", `reference:${request.motion}`];
      case "unity": {
        const clips = Object.keys(w.selections).filter((k) =>
          k.startsWith("animation:"),
        );
        if (!clips.length)
          throw new Error("먼저 3D 애니메이션 결과를 하나 이상 채택하세요.");
        return ["rig", ...clips];
      }
    }
  }
  private normalize(request: WorkbenchRequest): WorkbenchRequest {
    if (!request || !WORKBENCH_STEPS.some((s) => s.id === request.step))
      throw new Error("잘못된 제작 단계입니다.");
    if (typeof request.prompt !== "string" || request.prompt.length > 12000)
      throw new Error("작업 지시는 12,000자 이내로 작성하세요.");
    const r = structuredClone(request);
    r.prompt = r.prompt.trim();
    if (["concept", "assembly", "reference"].includes(r.step) && !r.prompt)
      throw new Error("원하는 결과를 지시문에 입력하세요.");
    if (r.step === "concept") {
      r.provider ??= "gpt";
      if (!["gpt", "tripo"].includes(r.provider))
        throw new Error("지원하지 않는 이미지 제공자입니다.");
    }
    if (r.step === "model") {
      if (!WORKBENCH_ROLES.includes(r.role!))
        throw new Error("모델링할 파츠를 선택하세요.");
      // Service-specific ranges must be observed in Studio by the executor, never invented here.
      if (
        r.polygonCount !== undefined &&
        (!Number.isSafeInteger(r.polygonCount) || r.polygonCount <= 0)
      )
        throw new Error("폴리곤 수는 양의 정수여야 합니다.");
    }
    if (["reference", "animation"].includes(r.step)) {
      r.motion = r.motion?.trim();
      if (!r.motion || r.motion.length > 100)
        throw new Error("동작 이름은 1~100자로 입력하세요.");
    }
    if (r.step === "reference") {
      r.fps ??= 12;
      r.duration ??= 2;
      r.loop ??= true;
      r.referenceFrameCount ??= 3;
      if (
        !Number.isInteger(r.referenceFrameCount) ||
        r.referenceFrameCount < 3 ||
        r.referenceFrameCount > 12
      )
        throw new Error("방향별 기준 동작 이미지는 3~12장으로 설정하세요.");
      if (
        !Number.isInteger(r.fps) ||
        r.fps < 1 ||
        r.fps > 60 ||
        !Number.isFinite(r.duration) ||
        r.duration < 0.1 ||
        r.duration > 30
      )
        throw new Error(
          "프레임 속도는 1~60 FPS, 길이는 0.1~30초 범위여야 합니다.",
        );
    }
    return r;
  }
  execute(id: string, request: WorkbenchRequest, approval?: WorkbenchApproval) {
    const w = this.get(id);
    this.idle(w);
    this.workerIdle();
    const r = this.normalize(request),
      slot = workbenchSlot(r);
    if (
      w.jobs.some((j) => j.slot === slot && j.status === "submission_unknown")
    )
      throw new Error(
        "이 단계의 이전 제출 여부를 먼저 확인하세요. 중복 생성하지 않습니다.",
      );
    if (
      w.jobs.some(
        (j) =>
          j.slot === slot &&
          j.status !== "review" &&
          this.executor.hasSubmission?.(j),
      )
    )
      throw new Error(
        "이미 제출된 미완료 작업이 있습니다. 새 요청 대신 기존 작업을 이어서 확인하세요.",
      );
    const accepted: WorkbenchApproval = structuredClone(
      approval ?? {
        accepted: false,
        studioCreditLimit: 0,
        imageCreditLimit: 0,
      },
    );
    if (
      typeof accepted.accepted !== "boolean" ||
      !Number.isSafeInteger(accepted.studioCreditLimit) ||
      accepted.studioCreditLimit < 0 ||
      !Number.isSafeInteger(accepted.imageCreditLimit) ||
      accepted.imageCreditLimit < 0
    )
      throw new Error("승인한 비용 한도는 0 이상의 정수여야 합니다.");
    if (
      ["concept", "model", "surface", "reference"].includes(r.step) &&
      !accepted.accepted
    )
      throw new Error("현재 단계의 생성 범위와 비용 한도를 확인해 주세요.");
    const dependencies: Record<string, WorkbenchSelection> = {};
    const inputs: WorkbenchArtifact[] = [];
    for (const dep of this.dependencySlots(w, r)) {
      const selected = this.chosen(w, dep);
      dependencies[dep] = selected.selected;
      inputs.push(...selected.candidate.artifacts);
    }
    if (r.baseJobId) {
      const base = this.job(w, r.baseJobId);
      if (
        base.step !== r.step ||
        base.status !== "review" ||
        !this.current(w, base)
      )
        throw new Error("수정 기준 버전이 현재 입력과 일치하지 않습니다.");
      if (base.candidates.length !== 1)
        throw new Error("하나의 결과 버전만 수정 기준으로 사용할 수 있습니다.");
      this.verifyArtifacts(w, base.candidates[0].artifacts);
      inputs.push(...base.candidates[0].artifacts);
    }
    if (r.step === "assembly" && r.objectIds?.length) {
      if (!r.baseJobId)
        throw new Error("오브젝트 수정에는 기준 조립 버전이 필요합니다.");
      const objects = this.job(w, r.baseJobId).candidates[0].objects ?? [];
      if (
        new Set(r.objectIds).size !== r.objectIds.length ||
        r.objectIds.some((id) => !objects.some((o) => o.id === id))
      )
        throw new Error("기준 버전에 존재하는 오브젝트를 선택하세요.");
    }
    if (r.step === "rig") {
      const objects = this.chosen(w, "assembly").candidate.objects ?? [];
      if (!objects.length)
        throw new Error("조립 결과의 오브젝트 목록을 먼저 확인해야 합니다.");
      r.rigTargets ??= objects.map((o) => ({
        objectId: o.id,
        extraBones: false,
      }));
      if (
        new Set(r.rigTargets.map((t) => t.objectId)).size !==
          r.rigTargets.length ||
        r.rigTargets.some(
          (t) =>
            typeof t.extraBones !== "boolean" ||
            !objects.some((o) => o.id === t.objectId),
        )
      )
        throw new Error("리깅 대상이 현재 조립 버전과 일치하지 않습니다.");
      // Omitted objects retain basic body binding; only explicit toggles authorize extra controls.
      r.rigTargets = objects.map(
        (o) =>
          r.rigTargets!.find((t) => t.objectId === o.id) ?? {
            objectId: o.id,
            extraBones: false,
          },
      );
      if (
        r.rigTargets.some(
          (t) =>
            t.extraBones && !objects.find((o) => o.id === t.objectId)!.separate,
        )
      )
        throw new Error(
          "추가 리깅할 영역이 몸체와 붙어 있습니다. 조립 단계에서 해당 영역을 먼저 식별·분리하세요.",
        );
    }
    const job: WorkbenchJob = {
      id: uid(),
      step: r.step,
      slot,
      request: r,
      status: "running",
      createdAt: now(),
      updatedAt: now(),
      summary: "선택한 단계만 실행합니다.",
      dependencies,
      approval: accepted,
      candidates: [],
      checks: [],
    };
    w.jobs.unshift(job);
    w.activeJobId = job.id;
    w.message = "현재 단계 작업 중입니다. 완료되면 결과 선택을 기다립니다.";
    this.save(w);
    const workspace = this.workspace(w, job);
    fs.mkdirSync(workspace, { recursive: true });
    const controller = new AbortController();
    const uniqueInputs = [...new Map(inputs.map((a) => [a.path, a])).values()];
    const promise = Promise.resolve().then(() =>
      this.perform(w.id, job.id, workspace, uniqueInputs, controller),
    );
    this.active.set(w.id, { controller, promise });
    return w;
  }
  private workspace(w: Workbench, job: WorkbenchJob) {
    return this.store.file(w.projectId, `workbench/${w.id}/jobs/${job.id}`);
  }
  private async perform(
    id: string,
    jobId: string,
    workspace: string,
    inputs: WorkbenchArtifact[],
    controller: AbortController,
  ) {
    let recovery: WorkbenchExecutionContext["recovery"];
    let recoveryAttempts = 0;
    let invocation = 0;
    try {
      const snapshot = structuredClone(this.get(id));
      const initialJob = structuredClone(this.job(snapshot, jobId));
      while (!controller.signal.aborted) {
        let w = this.get(id),
          job = this.job(w, jobId);
        if (job.status !== "running") return;
        // Inputs and spending scope stay identical throughout this entire job.
        this.verifyArtifacts(w, inputs);
        const token = ++invocation;
        let result: WorkbenchResult;
        try {
          const context: WorkbenchExecutionContext = {
            workbench: structuredClone(snapshot),
            job: {
              ...structuredClone(initialJob),
              summary: job.summary,
              validationPending: job.validationPending,
              recovery: structuredClone(job.recovery),
            },
            workspace,
            inputs: structuredClone(inputs),
            signal: controller.signal,
            onDraft: (draft) => {
              if (controller.signal.aborted || token !== invocation) return;
              const latest = this.get(id),
                current = this.job(latest, jobId);
              if (current.status !== "running" || current.step !== "separate")
                return;
              this.verifyArtifacts(latest, inputs);
              this.applyDraft(latest, current, draft);
              current.updatedAt = now();
              this.save(latest);
            },
            ...(recovery ? { recovery: structuredClone(recovery) } : {}),
          };
          const progress = (message: string) => {
            if (controller.signal.aborted || token !== invocation) return;
            const latest = this.get(id),
              current = this.job(latest, jobId);
            if (current.status !== "running") return;
            current.summary = String(message).slice(0, 4000);
            current.updatedAt = now();
            this.save(latest);
          };
          // Never turn a recovery into an unclassified execute() replay.
          result = recovery
            ? await this.executor.recover!(context, progress)
            : await this.executor.execute(context, progress);
        } finally {
          invocation++;
        }
        w = this.get(id);
        job = this.job(w, jobId);
        if (controller.signal.aborted || job.status !== "running") return;
        this.verifyArtifacts(w, inputs);
        let decision: WorkbenchRecovery | undefined;
        let failureStatus: WorkbenchJob["status"] = "needs_input";
        if (result.status === "completed") {
          fs.writeFileSync(
            path.join(workspace, ".worker-result.json"),
            JSON.stringify(result, null, 2),
          );
          job.validationPending = true;
          this.save(w);
          try {
            this.applyResult(w, job, result);
            if (recoveryAttempts)
              job.summary += ` 자동 복구 ${recoveryAttempts}회 후 완료했습니다. 결과를 확인해 주세요.`;
            delete job.recovery;
            job.updatedAt = now();
            delete w.activeJobId;
            w.message = job.summary;
            this.save(w);
            return;
          } catch (error) {
            decision = { kind: "repair", reason: messageOf(error) };
            failureStatus = "failed";
          }
        } else if (
          result.status === "needs_input" ||
          result.status === "submission_unknown"
        ) {
          failureStatus = result.status;
          decision =
            result.status === "submission_unknown"
              ? { kind: "blocked", reason: result.summary }
              : result.recovery;
          if (
            !decision ||
            !["retry", "repair", "blocked"].includes(decision.kind)
          )
            decision = { kind: "blocked", reason: result.summary };
          decision.reason = messageOf(decision.reason || result.summary);
        } else {
          throw new Error("작업자가 유효한 완료 상태를 반환하지 않았습니다.");
        }
        if (
          decision.kind === "blocked" ||
          !this.executor.recover ||
          recoveryAttempts >= MAX_RECOVERY_ATTEMPTS
        ) {
          const exhausted =
            decision.kind !== "blocked" &&
            !!this.executor.recover &&
            recoveryAttempts >= MAX_RECOVERY_ATTEMPTS;
          job.status = failureStatus;
          job.summary = exhausted
            ? `${decision.reason} 자동 복구 ${MAX_RECOVERY_ATTEMPTS}회 후에도 해결되지 않아 확인이 필요합니다.`
            : decision.reason;
          job.recovery = {
            attempt: recoveryAttempts,
            maxAttempts: MAX_RECOVERY_ATTEMPTS,
            state: exhausted ? "exhausted" : "blocked",
            reason: decision.reason,
          };
          job.updatedAt = now();
          delete w.activeJobId;
          w.message = job.summary;
          this.save(w);
          return;
        }
        recoveryAttempts++;
        const delay = this.recoveryDelaysMs[recoveryAttempts - 1];
        recovery = {
          attempt: recoveryAttempts,
          error: decision.reason,
          mode: decision.kind,
        };
        job.recovery = {
          attempt: recoveryAttempts,
          maxAttempts: MAX_RECOVERY_ATTEMPTS,
          state: "waiting",
          reason: decision.reason,
          nextAttemptAt: new Date(Date.now() + delay).toISOString(),
        };
        job.summary = `자동 복구 ${recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS} 대기 중: ${decision.reason}`;
        job.updatedAt = now();
        w.message = job.summary;
        this.save(w);
        if (!(await waitForRecovery(delay, controller.signal))) return;
        w = this.get(id);
        job = this.job(w, jobId);
        if (controller.signal.aborted || job.status !== "running") return;
        job.recovery!.state = "running";
        delete job.recovery!.nextAttemptAt;
        job.summary = `자동 복구 ${recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS} 진행 중: ${decision.reason}`;
        job.updatedAt = now();
        w.message = job.summary;
        this.save(w);
      }
    } catch (error) {
      const w = this.get(id),
        job = this.job(w, jobId);
      if (job.status === "running" && !controller.signal.aborted) {
        job.status = job.validationPending
          ? "failed"
          : external(job)
            ? "submission_unknown"
            : "failed";
        job.summary = `${messageOf(error)}${job.validationPending ? " 기존 결과를 다시 검사할 수 있으며 재생성하지 않습니다." : ""}`;
        job.recovery = {
          attempt: recoveryAttempts,
          maxAttempts: MAX_RECOVERY_ATTEMPTS,
          state: "blocked",
          reason: messageOf(error),
        };
        job.updatedAt = now();
      }
      delete w.activeJobId;
      w.message = job.summary;
      this.save(w);
    } finally {
      this.active.delete(id);
    }
  }
  private verifyArtifacts(w: Workbench, artifacts: WorkbenchArtifact[]) {
    for (const a of artifacts) {
      const file = safeRelative(this.store.directory(w.projectId), a.path);
      if (fs.statSync(file).size !== a.bytes || hash(file) !== a.sha256)
        throw new Error(
          "기준 산출물이 변경되었습니다. 보존된 파일을 복원한 뒤 다시 확인하세요.",
        );
    }
  }
  private applyResult(
    w: Workbench,
    job: WorkbenchJob,
    result: WorkbenchResult,
  ) {
    if (!this.current(w, job))
      throw new Error("완료된 작업의 기준 입력이 변경되었습니다.");
    const expected = ["concept", "model"].includes(job.step) ? 4 : 1;
    if (
      !Array.isArray(result.candidates) ||
      result.candidates.length !== expected
    )
      throw new Error(`이 단계에는 ${expected}개 결과 후보가 필요합니다.`);
    if (new Set(result.candidates.map((c) => c.id)).size !== expected)
      throw new Error("후보 ID가 중복되었습니다.");
    if (
      !Array.isArray(result.checks) ||
      result.checks.some((c) => blocksWorkbenchCheck(job.step, c))
    )
      throw new Error("통과하지 못한 검사가 있습니다. 결과를 확인해야 합니다.");
    const workspace = this.workspace(w, job);
    const candidates = this.registerCandidates(w, job, result.candidates);
    this.checkOutputs(job, candidates, result, workspace);
    job.candidates = candidates;
    job.checks = normalizeWorkbenchChecks(job.step, result.checks);
    delete job.draftCandidates;
    delete job.draftChecks;
    job.status = "review";
    job.validationPending = false;
    job.summary = result.summary || "결과를 확인하고 선택 또는 채택해 주세요.";
  }
  private registerCandidates(
    w: Workbench,
    job: WorkbenchJob,
    raw: WorkbenchResult["candidates"],
  ): WorkbenchCandidate[] {
    const workspace = this.workspace(w, job);
    return raw.map((c) => {
      if (
        !c.id ||
        !c.label ||
        !Array.isArray(c.artifacts) ||
        !c.artifacts.length
      )
        throw new Error("후보 산출물이 없습니다.");
      const artifacts: WorkbenchArtifact[] = c.artifacts.map((a) => {
        const file = safeRelative(workspace, a.path),
          bytes = fs.statSync(file).size;
        if (
          !bytes ||
          !["image", "model", "blend", "report", "frames", "export"].includes(
            a.kind,
          )
        )
          throw new Error("빈 파일 또는 알 수 없는 산출물입니다.");
        const relative = path
          .relative(this.store.directory(w.projectId), file)
          .split(path.sep)
          .join("/");
        this.verifyFormat(file, a.kind);
        return { ...a, path: relative, sha256: hash(file), bytes };
      });
      if (new Set(artifacts.map((a) => a.path)).size !== artifacts.length)
        throw new Error("같은 파일을 중복 등록할 수 없습니다.");
      return {
        id: c.id,
        label: c.label,
        artifacts,
        ...(c.objects ? { objects: c.objects } : {}),
      };
    });
  }
  private applyDraft(w: Workbench, job: WorkbenchJob, result: WorkbenchResult) {
    if (job.step !== "separate" || !this.current(w, job))
      throw new Error(
        "현재 파츠 분리 작업에만 중간 이미지를 표시할 수 있습니다.",
      );
    if (
      !Array.isArray(result.candidates) ||
      result.candidates.length !== 1 ||
      !Array.isArray(result.checks)
    )
      throw new Error("파츠 분리 중간 결과가 올바르지 않습니다.");
    if (result.checks.some((check) => blocksWorkbenchCheck(job.step, check)))
      throw new Error("중간 이미지에 통과하지 못한 파일 검사가 있습니다.");
    const candidates = this.registerCandidates(w, job, result.candidates);
    const artifacts = candidates[0].artifacts;
    const images = artifacts.filter((a) => a.kind === "image");
    if (
      !images.length ||
      images.length > 3 ||
      artifacts.some((a) => !["image", "report"].includes(a.kind)) ||
      images.some(
        (a) =>
          !WORKBENCH_ROLES.includes(a.role as (typeof WORKBENCH_ROLES)[number]),
      ) ||
      new Set(images.map((a) => a.role)).size !== images.length ||
      new Set(images.map((a) => a.sha256)).size !== images.length
    )
      throw new Error(
        "중간 결과에는 서로 다른 머리·머리카락·몸통 이미지와 보고서만 사용할 수 있습니다.",
      );
    job.draftCandidates = candidates;
    job.draftChecks = normalizeWorkbenchChecks(job.step, result.checks);
  }
  private verifyFormat(file: string, kind: WorkbenchArtifact["kind"]) {
    const data = fs.readFileSync(file),
      ext = path.extname(file).toLowerCase();
    if (
      kind === "image" &&
      !(
        data
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        (data[0] === 255 && data[1] === 216 && data[2] === 255) ||
        (data.toString("ascii", 0, 4) === "RIFF" &&
          data.toString("ascii", 8, 12) === "WEBP")
      )
    )
      throw new Error("유효한 PNG/JPEG/WebP 이미지가 아닙니다.");
    if (kind === "model" && ext === ".glb") {
      inspectWorkbenchGlb(data);
    }
    if (kind === "model" && ![".glb", ".fbx", ".obj", ".gltf"].includes(ext))
      throw new Error("지원하지 않는 모델 파일입니다.");
    if (kind === "blend" && data.toString("ascii", 0, 7) !== "BLENDER")
      throw new Error("유효한 Blender 원본 파일이 아닙니다.");
    if (
      kind === "frames" ||
      ((kind === "report" || kind === "export") && ext === ".json")
    )
      json(file);
  }
  private checkOutputs(
    job: WorkbenchJob,
    candidates: WorkbenchCandidate[],
    result: WorkbenchResult,
    workspace: string,
  ) {
    const has = (
      c: WorkbenchCandidate,
      kind: WorkbenchArtifact["kind"],
      role?: string,
    ) => c.artifacts.some((a) => a.kind === kind && (!role || a.role === role));
    const primary = job.step === "concept" ? "image" : "model";
    if (["concept", "model"].includes(job.step)) {
      if (candidates.some((c) => !has(c, primary)))
        throw new Error("각 후보에 실제 이미지 또는 모델이 필요합니다.");
      if (
        new Set(
          candidates.map(
            (c) => c.artifacts.find((a) => a.kind === primary)!.sha256,
          ),
        ).size !== 4
      )
        throw new Error(
          "서로 다른 후보 4개가 필요합니다. 같은 결과를 복제할 수 없습니다.",
        );
    }
    const c = candidates[0];
    if (
      ["model", "surface", "assembly", "rig", "animation"].includes(job.step)
    ) {
      for (const candidate of candidates) {
        const previews = candidate.artifacts.filter(
          (a) =>
            a.kind === "model" && path.extname(a.path).toLowerCase() === ".glb",
        );
        if (!previews.length)
          throw new Error(
            "원본 모델과 함께 검증 가능한 GLB 미리보기가 필요합니다.",
          );
        for (const preview of previews) {
          const relative = preview.path.split(`/jobs/${job.id}/`)[1];
          inspectWorkbenchGlb(
            fs.readFileSync(safeRelative(workspace, relative)),
            {
              uv: job.step === "surface",
              texture: job.step === "surface",
              rig: ["rig", "animation"].includes(job.step),
              animation: job.step === "animation",
            },
          );
        }
      }
    }
    if (
      job.step === "separate" &&
      (WORKBENCH_ROLES.some((role) => !has(c, "image", role)) ||
        c.artifacts.filter((a) => a.kind === "image").length !== 3)
    )
      throw new Error("머리·머리카락·몸통 분리 이미지가 모두 필요합니다.");
    if (
      job.step === "separate" &&
      new Set(
        WORKBENCH_ROLES.map(
          (r) =>
            c.artifacts.find((a) => a.kind === "image" && a.role === r)!.sha256,
        ),
      ).size !== 3
    )
      throw new Error("분리 결과는 서로 다른 파츠 이미지여야 합니다.");
    if (
      job.step === "surface" &&
      WORKBENCH_ROLES.some((role) => !has(c, "model", role))
    )
      throw new Error("선택한 세 파츠의 UV·텍스처 결과가 모두 필요합니다.");
    if (["assembly", "rig", "animation"].includes(job.step)) {
      if (
        !has(c, "blend") ||
        !c.artifacts.some(
          (a) => a.kind === "model" && a.path.endsWith(".glb"),
        ) ||
        !has(c, "image")
      )
        throw new Error(
          "Blender 원본·GLB 미리보기·검토 이미지가 모두 필요합니다.",
        );
      if (
        job.step === "assembly" &&
        (!c.objects?.length ||
          new Set(c.objects.map((o) => o.id)).size !== c.objects.length ||
          c.objects.some(
            (o) =>
              !o.id ||
              !o.name ||
              !["body", "clothing", "hair", "other"].includes(o.category) ||
              typeof o.separate !== "boolean",
          ))
      )
        throw new Error("안정적인 ID가 있는 오브젝트 목록이 필요합니다.");
    }
    if (job.step === "reference")
      this.validateFrames(job, result.candidates[0], workspace);
    if (job.step === "unity" && (!has(c, "export") || !has(c, "report")))
      throw new Error("Unity 내보내기 파일과 검증 보고서가 필요합니다.");
  }
  private validateFrames(
    job: WorkbenchJob,
    candidate: WorkbenchResult["candidates"][number],
    workspace: string,
  ) {
    const manifest = candidate.artifacts.find((a) => a.kind === "frames");
    if (!manifest)
      throw new Error("시간 정보가 있는 멀티뷰 프레임 명세가 필요합니다.");
    const doc = json<{
      schemaVersion: number;
      motion: string;
      fps: number;
      duration: number;
      camera: string;
      frames: { time: number; front: string; side: string; back: string }[];
    }>(safeRelative(workspace, manifest.path));
    if (
      doc.schemaVersion !== 1 ||
      doc.motion !== job.request.motion ||
      doc.fps !== job.request.fps ||
      doc.duration !== job.request.duration ||
      doc.camera !== "fixed" ||
      !Array.isArray(doc.frames) ||
      doc.frames.length !== job.request.referenceFrameCount
    )
      throw new Error("멀티뷰 동작 설정과 프레임 명세가 일치하지 않습니다.");
    if (
      Math.abs(doc.frames[0].time) > 0.000001 ||
      Math.abs(doc.frames.at(-1)!.time - doc.duration) > 0.000001
    )
      throw new Error(
        "멀티뷰 기준 이미지는 시작 0초와 종료 시점을 포함해야 합니다.",
      );
    let previous = -1;
    const phases = {
      front: new Set<string>(),
      side: new Set<string>(),
      back: new Set<string>(),
    };
    for (const frame of doc.frames) {
      if (
        !Number.isFinite(frame.time) ||
        frame.time < 0 ||
        frame.time <= previous ||
        frame.time > doc.duration
      )
        throw new Error(
          "프레임 시간은 길이 범위에서 순서대로 증가해야 합니다.",
        );
      previous = frame.time;
      for (const view of ["front", "side", "back"] as const) {
        const artifact = candidate.artifacts.find(
          (a) => a.kind === "image" && a.path === frame[view],
        );
        if (!artifact)
          throw new Error(
            "각 시점에 정면·측면·후면 이미지가 모두 등록되어야 합니다.",
          );
        phases[view].add(hash(safeRelative(workspace, artifact.path)));
      }
    }
    if (Object.values(phases).some((p) => p.size < 3))
      throw new Error(
        "정지 이미지 복제 대신 각 방향에서 세 개 이상의 서로 다른 동작 프레임이 필요합니다.",
      );
  }
  select(id: string, jobId: string, candidateId: string) {
    const w = this.get(id);
    this.idle(w);
    const job = this.job(w, jobId);
    if (job.status !== "review" || !this.current(w, job))
      throw new Error("현재 입력에 맞는 검토 완료 결과만 선택할 수 있습니다.");
    const candidate = job.candidates.find((c) => c.id === candidateId);
    if (!candidate) throw new Error("후보를 찾을 수 없습니다.");
    this.verifyArtifacts(w, candidate.artifacts);
    const changed = !equal(w.selections[job.slot], { jobId, candidateId });
    if (changed) {
      const dependsOn = (
        candidate: WorkbenchJob,
        seen = new Set<string>(),
      ): boolean => {
        if (seen.has(candidate.id)) return false;
        seen.add(candidate.id);
        return Object.entries(candidate.dependencies).some(
          ([slot, selection]) =>
            slot === job.slot || dependsOn(this.job(w, selection.jobId), seen),
        );
      };
      if (
        w.jobs.some(
          (pending) =>
            pending.status !== "review" &&
            this.executor.hasSubmission?.(pending) &&
            dependsOn(pending),
        )
      )
        throw new Error(
          "이미 제출된 작업을 이어서 확인한 뒤 기준 이미지를 바꾸세요. 기존 제출의 입력과 파일은 보존됩니다.",
        );
    }
    w.selections[job.slot] = { jobId, candidateId };
    if (changed) {
      let again = true;
      while (again) {
        again = false;
        for (const [slot, selection] of Object.entries(w.selections))
          if (!this.current(w, this.job(w, selection.jobId))) {
            delete w.selections[slot];
            again = true;
          }
      }
    }
    w.message =
      "선택한 버전을 채택했습니다. 다음 단계는 설정 후 직접 실행하세요.";
    return this.save(w);
  }
  accept(id: string, jobId: string) {
    const w = this.get(id),
      job = this.job(w, jobId);
    if (job.candidates.length !== 1)
      throw new Error("후보 중 하나를 직접 선택하세요.");
    return this.select(id, jobId, job.candidates[0].id);
  }
  revert(id: string, jobId: string, candidateId?: string) {
    const w = this.get(id),
      job = this.job(w, jobId);
    return candidateId
      ? this.select(id, jobId, candidateId)
      : this.accept(id, job.id);
  }
  retryValidation(id: string, jobId: string) {
    const w = this.get(id);
    this.idle(w);
    const job = this.job(w, jobId);
    if (!job.validationPending)
      throw new Error("기존 결과를 다시 검사할 수 있는 작업이 아닙니다.");
    for (const selection of Object.values(job.dependencies))
      this.verifyArtifacts(
        w,
        this.job(w, selection.jobId).candidates.find(
          (c) => c.id === selection.candidateId,
        )!.artifacts,
      );
    this.applyResult(
      w,
      job,
      json<WorkbenchResult>(
        path.join(this.workspace(w, job), ".worker-result.json"),
      ),
    );
    delete job.recovery;
    job.updatedAt = now();
    w.message =
      "기존 결과 검사가 완료되었습니다. 외부 생성 요청은 실행하지 않았습니다.";
    return this.save(w);
  }
  retry(id: string, jobId: string) {
    const w = this.get(id);
    this.idle(w);
    this.workerIdle();
    const job = this.job(w, jobId);
    if (
      !["failed", "needs_input", "submission_unknown", "cancelled"].includes(
        job.status,
      )
    )
      throw new Error("다시 확인할 중단 작업이 아닙니다.");
    if (job.validationPending)
      throw new Error(
        "작업자가 이미 완료했습니다. 기존 결과 다시 검사를 사용하세요.",
      );
    if (!this.current(w, job))
      throw new Error("기준 입력이 바뀌어 이 작업을 재개할 수 없습니다.");
    if (
      job.status === "submission_unknown" &&
      !this.executor.hasSubmission?.(job)
    )
      throw new Error(
        "제출 여부가 불명확합니다. 외부 서비스에서 미제출을 확인한 뒤 새 승인을 해주세요.",
      );
    const inputs: WorkbenchArtifact[] = [];
    for (const slot of Object.keys(job.dependencies))
      inputs.push(...this.chosen(w, slot).candidate.artifacts);
    if (job.request.baseJobId) {
      const base = this.job(w, job.request.baseJobId);
      if (
        !this.current(w, base) ||
        base.status !== "review" ||
        base.candidates.length !== 1
      )
        throw new Error("수정 기준 버전이 변경되었습니다.");
      this.verifyArtifacts(w, base.candidates[0].artifacts);
      inputs.push(...base.candidates[0].artifacts);
    }
    const workspace = this.workspace(w, job);
    if (!fs.existsSync(workspace))
      throw new Error("기존 작업 폴더가 없어 안전하게 재개할 수 없습니다.");
    job.status = "running";
    delete job.recovery;
    job.updatedAt = now();
    job.summary = "기존 제출·완료 기록을 확인하여 남은 작업만 처리합니다.";
    w.activeJobId = job.id;
    w.message = job.summary;
    this.save(w);
    const controller = new AbortController();
    const uniqueInputs = [...new Map(inputs.map((a) => [a.path, a])).values()];
    const promise = Promise.resolve().then(() =>
      this.perform(w.id, job.id, workspace, uniqueInputs, controller),
    );
    this.active.set(w.id, { controller, promise });
    return w;
  }
  /** Explicit user action: inspect saved bytes, without starting a production worker. */
  inspectSaved(id: string, jobId: string) {
    const w = this.get(id);
    this.idle(w);
    this.workerIdle();
    const job = this.job(w, jobId);
    if (
      job.step !== "separate" ||
      !["failed", "needs_input", "cancelled"].includes(job.status)
    )
      throw new Error(
        "중지된 파츠 분리 작업에서만 저장된 이미지를 확인할 수 있습니다.",
      );
    if (!this.executor.inspectSaved)
      throw new Error("저장된 이미지 확인 기능을 사용할 수 없습니다.");
    if (!this.current(w, job))
      throw new Error(
        "기준 이미지가 바뀌어 기존 분리 작업을 표시할 수 없습니다.",
      );
    const inputs = Object.keys(job.dependencies).flatMap(
      (slot) => this.chosen(w, slot).candidate.artifacts,
    );
    const uniqueInputs = [...new Map(inputs.map((a) => [a.path, a])).values()];
    const workspace = this.workspace(w, job);
    if (!fs.existsSync(workspace))
      throw new Error("저장된 작업 폴더가 없습니다.");
    const originalStatus = job.status;
    job.status = "running";
    job.summary =
      "저장된 파츠 이미지를 확인합니다. 새 이미지는 생성하지 않습니다.";
    delete job.recovery;
    job.updatedAt = now();
    w.activeJobId = job.id;
    this.save(w);
    const controller = new AbortController();
    const snapshot = structuredClone(w);
    const promise = Promise.resolve().then(async () => {
      try {
        this.verifyArtifacts(snapshot, uniqueInputs);
        const result = await this.executor.inspectSaved!({
          workbench: snapshot,
          job: structuredClone(job),
          workspace,
          inputs: structuredClone(uniqueInputs),
          signal: controller.signal,
        });
        const latest = this.get(id),
          current = this.job(latest, jobId);
        if (controller.signal.aborted || current.status !== "running") return;
        this.verifyArtifacts(latest, uniqueInputs);
        if (result.status === "completed") {
          this.applyResult(latest, current, result);
        } else {
          if (result.candidates.length)
            this.applyDraft(latest, current, result);
          current.status =
            originalStatus === "cancelled" ? "cancelled" : "needs_input";
          current.summary =
            result.summary ||
            "저장된 이미지를 확인했습니다. 남은 파츠는 직접 이어서 실행하세요.";
        }
        current.updatedAt = now();
        delete latest.activeJobId;
        latest.message = current.summary;
        this.save(latest);
      } catch (error) {
        const latest = this.get(id),
          current = this.job(latest, jobId);
        if (controller.signal.aborted || current.status !== "running") return;
        current.status = originalStatus;
        current.summary = `저장된 이미지 확인 실패: ${messageOf(error)}`;
        current.updatedAt = now();
        delete latest.activeJobId;
        latest.message = current.summary;
        this.save(latest);
      } finally {
        this.active.delete(id);
      }
    });
    this.active.set(id, { controller, promise });
    return w;
  }
  cancel(id: string) {
    const w = this.get(id);
    const active = this.active.get(id);
    if (w.activeJobId) {
      const j = this.job(w, w.activeJobId);
      j.status = external(j) ? "submission_unknown" : "cancelled";
      j.summary = external(j)
        ? "작업을 중지했습니다. 외부 서비스의 제출 여부를 먼저 확인하세요."
        : "작업을 중지했습니다. 기존 버전은 유지됩니다.";
      j.updatedAt = now();
      if (j.recovery) {
        j.recovery.state = "blocked";
        j.recovery.reason = j.summary;
        delete j.recovery.nextAttemptAt;
      }
    }
    active?.controller.abort();
    delete w.activeJobId;
    w.message = "현재 실행만 중지했습니다.";
    return this.save(w);
  }
  importSource(id: string, assetId: string) {
    const w = this.get(id);
    this.idle(w);
    const asset = this.store
      .project(w.projectId)
      .assets.find((a) => a.id === assetId && a.kind === "image");
    if (!asset) throw new Error("가져올 캐릭터 이미지를 선택하세요.");
    const source = safeRelative(this.store.directory(w.projectId), asset.file);
    this.verifyFormat(source, "image");
    const job: WorkbenchJob = {
      id: uid(),
      step: "concept",
      slot: "concept",
      request: { step: "concept", prompt: "사용자가 가져온 기준 이미지" },
      status: "review",
      createdAt: now(),
      updatedAt: now(),
      summary: "가져온 기준 이미지를 선택했습니다.",
      dependencies: {},
      approval: { accepted: false, studioCreditLimit: 0, imageCreditLimit: 0 },
      candidates: [],
      checks: [],
    };
    const relative = `workbench/${w.id}/jobs/${job.id}/reference${path.extname(source).toLowerCase()}`;
    this.store.write(w.projectId, relative, fs.readFileSync(source));
    job.candidates.push({
      id: uid(),
      label: asset.label,
      artifacts: [
        {
          path: relative,
          kind: "image",
          role: "front",
          sha256: hash(source),
          bytes: fs.statSync(source).size,
        },
      ],
    });
    w.jobs.unshift(job);
    this.save(w);
    return this.accept(id, job.id);
  }
  /** Host-only migration entrypoint: caller verifies the stored legacy run before passing paths. */
  importSeparation(
    id: string,
    input: {
      sourceSha256: string;
      artifacts: { file: string; role: "head" | "hair" | "body" }[];
    },
  ) {
    const w = this.get(id);
    this.idle(w);
    const concept = this.chosen(w, "concept");
    if (
      !concept.candidate.artifacts.some(
        (a) => a.kind === "image" && a.sha256 === input.sourceSha256,
      )
    )
      throw new Error(
        "기존 분리 작업의 원본과 현재 선택한 캐릭터 이미지가 다릅니다.",
      );
    if (
      input.artifacts.length !== 3 ||
      new Set(input.artifacts.map((a) => a.role)).size !== 3 ||
      input.artifacts.some((a) => !WORKBENCH_ROLES.includes(a.role))
    )
      throw new Error("검증된 머리·머리카락·몸통 이미지가 모두 필요합니다.");
    const job: WorkbenchJob = {
      id: uid(),
      step: "separate",
      slot: "separate",
      request: {
        step: "separate",
        prompt: "기존 완료 작업의 검증된 분리 이미지 복원",
      },
      status: "running",
      createdAt: now(),
      updatedAt: now(),
      summary: "기존 분리 결과를 가져왔습니다. 확인 후 채택하세요.",
      dependencies: { concept: concept.selected },
      approval: { accepted: false, studioCreditLimit: 0, imageCreditLimit: 0 },
      candidates: [],
      checks: [],
    };
    const workspace = this.workspace(w, job);
    fs.mkdirSync(workspace, { recursive: true });
    const artifacts = input.artifacts.map((a) => {
      this.verifyFormat(a.file, "image");
      const relative = `${a.role}${path.extname(a.file).toLowerCase()}`;
      fs.copyFileSync(a.file, path.join(workspace, relative));
      return { path: relative, kind: "image" as const, role: a.role };
    });
    this.applyResult(w, job, {
      status: "completed",
      summary: job.summary,
      candidates: [{ id: uid(), label: "복원한 파츠 분리", artifacts }],
      checks: [
        { name: "기존 생성 결과 재검증 · 새 외부 생성 없음", passed: true },
      ],
    });
    w.jobs.unshift(job);
    w.message = job.summary;
    return this.save(w);
  }
  /** Copy only manifested, hashed artifacts from a user-selected project backup. */
  restoreFromBackup(projectId: string, sourceDirectory: string) {
    this.store.project(projectId);
    const root = path.join(sourceDirectory, "workbench");
    if (!fs.existsSync(root)) return;
    const staged: {
      w: Workbench;
      files: { relative: string; bytes: Buffer }[];
    }[] = [];
    for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(dir.name)) continue;
      const relative = `workbench/${dir.name}/workbench.json`,
        manifest = path.join(sourceDirectory, relative);
      if (!fs.existsSync(manifest)) continue;
      const w = json<Workbench>(safeRelative(sourceDirectory, relative));
      if (
        w.schemaVersion !== 1 ||
        w.id !== dir.name ||
        !Array.isArray(w.jobs) ||
        !w.selections ||
        typeof w.selections !== "object"
      )
        throw new Error("잘못된 에셋 작업실 백업입니다.");
      const collision = this.store.get<Workbench>("workbench", w.id);
      if (collision && collision.projectId !== projectId)
        throw new Error("다른 프로젝트의 작업실 ID와 충돌합니다.");
      const files: { relative: string; bytes: Buffer }[] = [];
      if (new Set(w.jobs.map((j) => j.id)).size !== w.jobs.length)
        throw new Error("백업 작업 ID가 중복되었습니다.");
      for (const job of w.jobs) {
        if (!/^[a-zA-Z0-9_-]+$/.test(job.id) || !Array.isArray(job.candidates))
          throw new Error("잘못된 백업 작업입니다.");
        for (const c of [...job.candidates, ...(job.draftCandidates ?? [])])
          for (const artifact of c.artifacts) {
            if (!artifact.path.startsWith(`workbench/${w.id}/jobs/${job.id}/`))
              throw new Error("백업 산출물이 소유한 작업 폴더 밖에 있습니다.");
            const file = safeRelative(sourceDirectory, artifact.path);
            if (
              fs.statSync(file).size !== artifact.bytes ||
              hash(file) !== artifact.sha256
            )
              throw new Error("백업 산출물이 변경되었거나 손상되었습니다.");
            this.verifyFormat(file, artifact.kind);
            files.push({
              relative: artifact.path,
              bytes: fs.readFileSync(file),
            });
          }
        if (job.validationPending) {
          // Unregistered/invalid output paths are intentionally not copied from a backup.
          job.validationPending = false;
          job.summary +=
            " 검증 전 파일은 백업 복원에서 실행되지 않습니다. 원래 작업 폴더에서 다시 검사하세요.";
        }
        if (job.status === "running") {
          job.status = external(job) ? "submission_unknown" : "failed";
          job.summary =
            "백업 복원으로 중단된 작업입니다. 자동 재실행하지 않습니다.";
          if (job.recovery) {
            job.recovery.state = "blocked";
            job.recovery.reason = job.summary;
            delete job.recovery.nextAttemptAt;
          }
        }
      }
      w.projectId = projectId;
      delete w.activeJobId;
      for (const selection of Object.values(w.selections)) {
        const selected = w.jobs.find((j) => j.id === selection.jobId);
        if (
          !selected ||
          selected.status !== "review" ||
          !selected.candidates.some((c) => c.id === selection.candidateId)
        )
          throw new Error("백업 선택 버전이 손상되었습니다.");
      }
      staged.push({ w, files });
    }
    for (const { w, files } of staged) {
      for (const f of files) this.store.write(projectId, f.relative, f.bytes);
      this.save(w);
    }
  }
  /** Re-register exported project manifests. Paths remain relative; never trust backup absolute paths. */
  restore(projectId: string) {
    const root = this.store.file(projectId, "workbench");
    if (!fs.existsSync(root)) return;
    for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(dir.name)) continue;
      const manifest = path.join(root, dir.name, "workbench.json");
      if (!fs.existsSync(manifest)) continue;
      const w = json<Workbench>(manifest);
      if (w.schemaVersion !== 1 || w.id !== dir.name || !Array.isArray(w.jobs))
        throw new Error("잘못된 에셋 작업실 백업입니다.");
      w.projectId = projectId;
      delete w.activeJobId;
      for (const job of w.jobs) {
        if (job.status === "running") {
          job.status = external(job) ? "submission_unknown" : "failed";
          job.summary =
            "백업 복원으로 중단된 작업입니다. 자동 재실행하지 않습니다.";
          if (job.recovery) {
            job.recovery.state = "blocked";
            job.recovery.reason = job.summary;
            delete job.recovery.nextAttemptAt;
          }
        }
        for (const candidate of [
          ...job.candidates,
          ...(job.draftCandidates ?? []),
        ])
          this.verifyArtifacts(w, candidate.artifacts);
      }
      this.save(w);
    }
  }
  async wait(id: string) {
    await this.active.get(id)?.promise;
    return this.get(id);
  }
  shutdown() {
    for (const id of this.active.keys()) this.cancel(id);
    this.executor.shutdown?.();
  }
}
