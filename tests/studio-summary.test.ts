import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStudioSummary, type HitTimerSummary } from "../engine/studio-summary";
import type { Project } from "../shared/types";
import type { Workbench } from "../shared/workbench";

const project: Project = { schemaVersion: 1, id: "hero", name: "백호 캐릭터", style: "", height: 1.8, unityPath: "", unityFolder: "", createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z", revision: 1, assets: [], parts: [], jobs: [], assemblies: [], builds: [], demo: false };
const combat = { projectPath: "C:/game", projectName: "게임", connection: { connected: false, running: false }, generating: false, runs: [] };
const input = () => ({ version: "0.7.0", projects: [structuredClone(project)], workbenches: [] as Workbench[], productionRuns: [], combat: structuredClone(combat), storage: { modeling: "data", combat: "data/combat-lab" } });

test("empty storage produces no fabricated work or successful results", () => {
  const summary = buildStudioSummary({ ...input(), projects: [], combat: { ...combat, projectPath: "", projectName: "" } });
  assert.deepEqual(summary.projects, []);
  assert.deepEqual(summary.runs, []);
  assert.deepEqual(summary.results, []);
  assert.equal(summary.combat.connected, false);
});

test("guided review and partial drafts do not imply acceptance or completion", () => {
  const data = input();
  data.workbenches = [{ schemaVersion: 1, id: "work", projectId: "hero", createdAt: project.createdAt, updatedAt: "2026-10-09T00:00:00Z", message: "", selections: {}, jobs: [{ id: "job", step: "separate", slot: "separate", request: { step: "separate", prompt: "" }, status: "needs_input", createdAt: project.createdAt, updatedAt: "2026-10-09T00:00:00Z", summary: "사진을 확인하세요", dependencies: {}, approval: { accepted: true, studioCreditLimit: 0, imageCreditLimit: 0 }, checks: [], candidates: [], draftCandidates: [{ id: "draft", label: "머리 정면", artifacts: [{ path: "head.png", kind: "image", sha256: "x", bytes: 12 }] }] }] }];
  const summary = buildStudioSummary(data);
  assert.equal(summary.runs[0].status, "입력 필요");
  assert.equal(summary.results[0].status, "일부 준비");
  assert.notEqual(summary.results[0].tone, "success");
  assert.equal(summary.projects.find(p => p.tool === "modeling")?.updatedAt, "2026-10-09T00:00:00Z");
  assert.deepEqual(summary.results[0].target, { tool: "modeling", projectId: "hero", tab: "workbench" });
});

test("selected guided candidates are distinguished from unselected candidates", () => {
  const data = input();
  data.workbenches = [{ schemaVersion: 1, id: "work", projectId: "hero", createdAt: project.createdAt, updatedAt: project.updatedAt, message: "", selections: { concept: { jobId: "job", candidateId: "a" } }, jobs: [{ id: "job", step: "concept", slot: "concept", request: { step: "concept", prompt: "" }, status: "review", createdAt: project.createdAt, updatedAt: project.updatedAt, summary: "", dependencies: {}, approval: { accepted: true, studioCreditLimit: 0, imageCreditLimit: 0 }, checks: [], candidates: [{ id: "a", label: "A", artifacts: [{ path: "a.png", kind: "image", sha256: "x", bytes: 1 }] }, { id: "b", label: "B", artifacts: [{ path: "b.png", kind: "image", sha256: "y", bytes: 1 }] }] }] }];
  const summary = buildStudioSummary(data);
  assert.equal(summary.results.find(x => x.title === "A")?.status, "채택됨");
  assert.equal(summary.results.find(x => x.title === "B")?.status, "검토 대기");
});

test("combat failure and no-hit reports remain inspectable without claiming completion", () => {
  const summary = buildStudioSummary({ ...input(), combat: { ...combat, runs: [{ id: "failed", startedUtc: "2026-10-09T00:00:00Z", status: "failed", actionId: "skill", candidateCount: 4, completedCount: 1 }, { id: "no-hit", startedUtc: "2026-10-08T00:00:00Z", status: "no-hits", actionId: "normal-combo", candidateCount: 2, completedCount: 2 }] } });
  assert.equal(summary.results.length, 2);
  assert.equal(summary.results[0].status, "실패");
  assert.equal(summary.results[1].status, "명중 없음");
  assert.deepEqual(summary.results[0].target, { tool: "combat", projectPath: "C:/game", runId: "failed", tab: "compare" });
});

test("summary never mutates source records or leaks settings/credential fields", () => {
  const data = input();
  const before = JSON.stringify(data);
  const summary = buildStudioSummary(data);
  assert.equal(JSON.stringify(data), before);
  assert.equal("key" in summary, false);
  assert.equal("settings" in summary, false);
});

test("unknown statuses stay unknown and cannot be shown as success", () => {
  const summary = buildStudioSummary({ ...input(), combat: { ...combat, runs: [{ id: "future", status: "future-state", startedUtc: "", candidateCount: 0, completedCount: 0, actionId: "" }] } });
  assert.equal(summary.runs[0].status, "상태 확인 필요");
  assert.equal(summary.runs[0].tone, "neutral");
});

const hitJob = (patch: Partial<HitTimerSummary["jobs"][number]> = {}): HitTimerSummary["jobs"][number] => ({ id: "job1", clipName: "베기", status: "draft", analysisStatus: "", reviewed: false, pendingSave: false, hitCount: 0, frameCount: 0, savedAssetCount: 0, createdUtc: "2026-10-10T00:00:00Z", error: "", ...patch });
const withHit = (jobs: HitTimerSummary["jobs"]) => ({ ...input(), hitTimer: { projectName: "사인검", projectPath: "C:/sword", connected: false, busy: false, error: "", jobs } });
test("AutoHitTimer unfinished analysis and human review never imply saved output", () => {
  const s = buildStudioSummary(withHit([hitJob(), hitJob({ id: "u", status: "review", analysisStatus: "uncertain", frameCount: 10 }), hitJob({ id: "n", status: "review", analysisStatus: "no-hit" }), hitJob({ id: "r", status: "review", analysisStatus: "hits", reviewed: true, hitCount: 2 })]));
  const hitResults = s.results.filter(r => r.tool === "hit-timing");
  assert.equal(hitResults.length, 3);
  assert.ok(hitResults.every(r => r.tone === "review"));
  assert.equal(s.runs.find(r => r.id.endsWith(":job1"))?.status, "분석 전");
  assert.equal(s.hitTimer.experimental, true);
});
test("pending AutoHitTimer save takes precedence over saved labels and does not point to apply", () => {
  const source = withHit([hitJob({ status: "saved", savedAssetCount: 1, pendingSave: true })]);
  const before = JSON.stringify(source);
  const result = buildStudioSummary(source).results.find(r => r.tool === "hit-timing")!;
  assert.equal(result.status, "저장 결과 확인 중");
  assert.equal(result.tone, "review");
  assert.deepEqual(result.target, { tool: "hit-timing", projectPath: "C:/sword", jobId: "job1", tab: "hits" });
  assert.equal(JSON.stringify(source), before);
});
test("only recorded AutoHitTimer saved assets appear as saved and keep exact job/project identity", () => {
  const result = buildStudioSummary(withHit([hitJob({ status: "saved", savedAssetCount: 2, savedUtc: "2026-10-10T02:00:00Z" })])).results.find(r => r.tool === "hit-timing")!;
  assert.equal(result.status, "저장됨");
  assert.equal(result.tone, "success");
  assert.deepEqual(result.target, { tool: "hit-timing", projectPath: "C:/sword", jobId: "job1", tab: "save" });
});
test("interrupted disk checkpoints are shown as needing verification rather than live analysis", () => {
  const result = buildStudioSummary(withHit([hitJob({ status: "interrupted", frameCount: 4 })]));
  assert.equal(result.runs.find(r => r.tool === "hit-timing")?.status, "이전 실행 확인 필요");
  assert.equal(result.runs.find(r => r.tool === "hit-timing")?.tone, "review");
  assert.equal(result.hitTimer.busy, false);
});
