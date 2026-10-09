import type { Project } from "../shared/types";
import type { Workbench } from "../shared/workbench";
import { WORKBENCH_STEPS } from "../shared/workbench";
import type { ProductionRun } from "../shared/production";
import type { StudioEntry, StudioSummary } from "../shared/studio";

export interface CombatSummary {
  projectName: string;
  projectPath: string;
  connection: { connected?: boolean; running?: boolean; error?: string; status?: string };
  generating: boolean;
  runs: { id: string; startedUtc: string; status: string; candidateCount: number; completedCount: number; actionId: string }[];
}
export interface SummaryInput {
  version: string;
  projects: Project[];
  workbenches: Workbench[];
  productionRuns: ProductionRun[];
  combat: CombatSummary;
  storage: StudioSummary["storage"];
  warnings?: string[];
}

const states: Record<string, [string, StudioEntry["tone"]]> = {
  ready: ["준비됨", "neutral"], queued: ["대기 중", "active"], submitting: ["제출 중", "active"],
  running: ["진행 중", "active"], review: ["검토 대기", "review"], needs_input: ["입력 필요", "review"],
  submission_unknown: ["제출 확인 필요", "review"], success: ["처리 완료", "success"], completed: ["실행 완료", "success"],
  failed: ["실패", "error"], cancelled: ["중지됨", "neutral"], cancelled_local: ["제출 전 취소", "neutral"],
  paused: ["일시 중지", "neutral"], incomplete: ["미완료", "review"], "no-hits": ["명중 없음", "review"],
};
const state = (key: string) => { const [status, tone] = states[key] ?? ["상태 확인 필요", "neutral"]; return { status, tone }; };
const time = (date: string) => Date.parse(date) || 0;
const recent = (items: StudioEntry[]) => items.sort((a, b) => time(b.updatedAt) - time(a.updatedAt) || a.id.localeCompare(b.id));
const stepLabel = (step: string) => WORKBENCH_STEPS.find(item => item.id === step)?.title ?? step;
const kindLabel: Record<string, string> = { image: "이미지 생성", edit: "이미지 수정", model: "모델 생성", rig: "리깅", animate: "애니메이션", texture: "텍스처", "uv-pack": "UV 정리", convert: "모델 변환", retopology: "리토폴로지", segment: "파츠 분리", smartsegment: "파츠 분리", complete: "파츠 완성", "rig-check": "리깅 검사" };

/** A projection of existing records only; never starts work or mutates a tool's data. */
export function buildStudioSummary(input: SummaryInput): StudioSummary {
  const projects: StudioEntry[] = [], runs: StudioEntry[] = [], results: StudioEntry[] = [];
  for (const p of input.projects) {
    const benches = input.workbenches.filter(w => w.projectId === p.id);
    const latest = [p.updatedAt, ...benches.map(w => w.updatedAt)].sort((a, b) => time(b) - time(a))[0];
    const base = { tool: "modeling" as const, projectName: p.name, target: { tool: "modeling" as const, projectId: p.id, tab: p.demo ? "assembly" : "workbench" } };
    projects.push({ ...base, id: `modeling:${p.id}`, title: p.name, detail: p.demo ? "로컬 데모 프로젝트" : "3D 제작 프로젝트", status: "이어서 작업", tone: "neutral", updatedAt: latest });
    for (const work of benches) {
      for (const job of work.jobs) {
        const target = { ...base.target, tab: "workbench" };
        runs.push({ ...base, target, id: `modeling:${p.id}:${job.id}`, title: stepLabel(job.step), detail: job.summary || "단계별 제작 작업", ...state(job.status), updatedAt: job.updatedAt });
        for (const candidate of job.candidates) {
          if (!candidate.artifacts.length) continue;
          const selected = Object.values(work.selections).some(s => s.jobId === job.id && s.candidateId === candidate.id);
          results.push({ ...base, target, id: `modeling:${p.id}:${job.id}:${candidate.id}`, title: candidate.label || stepLabel(job.step), detail: `${stepLabel(job.step)} · 파일 ${candidate.artifacts.length}개`, status: selected ? "채택됨" : "검토 대기", tone: selected ? "success" : "review", updatedAt: job.updatedAt });
        }
        for (const draft of job.draftCandidates ?? []) {
          if (!draft.artifacts.length || job.candidates.some(c => c.id === draft.id)) continue;
          results.push({ ...base, target, id: `modeling:${p.id}:${job.id}:draft:${draft.id}`, title: draft.label || "준비 중인 결과", detail: `${stepLabel(job.step)} · 준비된 파일 ${draft.artifacts.length}개`, status: "일부 준비", tone: "review", updatedAt: job.updatedAt });
        }
      }
    }
    for (const job of p.jobs) {
      runs.push({ ...base, target: { ...base.target, tab: "studio" }, id: `modeling:${p.id}:manual:${job.id}`, title: kindLabel[job.kind] ?? "수동 제작 작업", detail: job.message || "고급 수동 도구", ...state(job.status), updatedAt: job.createdAt });
    }
    for (const asset of p.assets) {
      results.push({ ...base, target: { ...base.target, tab: asset.kind === "image" ? "image" : "studio" }, id: `modeling:${p.id}:asset:${asset.id}`, title: asset.label || (asset.kind === "image" ? "이미지" : "3D 모델"), detail: `${asset.kind === "image" ? "이미지" : "3D 모델"}${asset.origin === "demo" ? " · 로컬 데모" : ""}`, status: "저장됨", tone: "neutral", updatedAt: asset.createdAt });
    }
    for (const build of p.builds) {
      results.push({ ...base, target: { ...base.target, tab: build.hasRig ? "rig" : "assembly" }, id: `modeling:${p.id}:build:${build.id}`, title: build.hasRig ? "리깅 · 애니메이션 출력" : "조립 모델 출력", detail: p.demo ? "로컬 데모 · GLB / FBX / Blender" : "GLB / FBX / Blender", status: build.warnings.length ? "주의사항 확인" : "출력 저장됨", tone: build.warnings.length ? "review" : "neutral", updatedAt: p.updatedAt });
    }
    for (const old of input.productionRuns.filter(r => r.projectId === p.id)) {
      runs.push({ ...base, target: { ...base.target, tab: "workbench" }, id: `modeling:${p.id}:legacy:${old.id}`, title: "이전 자동 제작 기록", detail: old.message || "기록 조회 · 자동 재시작하지 않음", ...state(old.status), updatedAt: old.updatedAt });
    }
  }
  const c = input.combat;
  if (c.projectPath) {
    projects.push({ id: `combat:${c.projectPath}`, tool: "combat", title: c.projectName, projectName: c.projectName, detail: "Unity 타격감 실험 프로젝트", status: c.connection.connected ? "Unity 연결됨" : "Unity 연결 필요", tone: c.connection.connected ? "success" : "neutral", updatedAt: c.runs[0]?.startedUtc ?? "", target: { tool: "combat", projectPath: c.projectPath, tab: "setup" } });
  }
  for (const run of c.runs) {
    const entry: StudioEntry = { id: `combat:${run.id}`, tool: "combat", title: run.actionId ? `${run.actionId} 실험` : "타격감 실험", projectName: c.projectName, detail: `후보 ${run.candidateCount}개 · 실행 종료 ${run.completedCount}개`, ...state(run.status), updatedAt: run.startedUtc, target: { tool: "combat", projectPath: c.projectPath, runId: run.id, tab: "compare" } };
    runs.push(entry);
    results.push({ ...entry, id: `combat:report:${run.id}`, detail: `${entry.detail} · 비교 보고서` });
  }
  return { version: input.version, projects: recent(projects), runs: recent(runs), results: recent(results), combat: { projectName: c.projectName, projectPath: c.projectPath, connected: !!c.connection.connected, running: !!c.connection.running, generating: c.generating, error: c.connection.error ?? "" }, storage: { ...input.storage }, warnings: [...(input.warnings ?? [])] };
}
