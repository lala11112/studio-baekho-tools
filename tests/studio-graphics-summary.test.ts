import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStudioSummary, type SummaryInput } from "../engine/studio-summary";
import type { AssetVersion, GraphicsTask, GraphicsWorkspace } from "../shared/graphics";

const createdAt = "2026-10-10T00:00:00Z";
const updatedAt = "2026-10-14T03:00:00Z";
const task = (patch: Partial<GraphicsTask> = {}): GraphicsTask => ({
  id: "head-uv", objectId: "human", taskId: "T01", createdAt, updatedAt,
  status: "awaiting_approval", inputVersionIds: [], settings: {}, instruction: "",
  requestHash: "hash", outputVersionIds: [], backendJobIds: [],
  message: "Review the frozen UV cost", localOnly: false, ...patch,
});
const version = (patch: Partial<AssetVersion> = {}): AssetVersion => ({
  id: "head", objectId: "human", role: "model", slot: "part-head", label: "Independent head",
  files: [{ path: "head.fbx", kind: "model", bytes: 10, sha256: "hash" }],
  createdAt: updatedAt, sourceVersionIds: [], provenance: { type: "codex" }, warnings: [], ...patch,
});
const workspace = (): GraphicsWorkspace => ({
  schemaVersion: 1, id: "hero", projectId: "hero", revision: 4,
  objects: [{ id: "human", name: "Human", kind: "character", createdAt,
    selectedTasks: [], instruction: "", settings: {}, references: [], accepted: { "model:part-head": "head" } }],
  tasks: [], versions: [], deliveries: [],
});
const input = (graphicsWorkspaces: GraphicsWorkspace[] = []): SummaryInput & { graphicsWorkspaces: GraphicsWorkspace[] } => ({
  version: "0.8.1", graphicsWorkspaces,
  projects: [{ schemaVersion: 1, id: "hero", name: "Hero", style: "", height: 1.8,
    unityPath: "", unityFolder: "", createdAt, updatedAt: createdAt, revision: 1,
    assets: [], parts: [], jobs: [], assemblies: [], builds: [], demo: false }],
  workbenches: [], productionRuns: [],
  combat: { projectName: "", projectPath: "", connection: {}, generating: false, runs: [] },
  storage: { modeling: "data", combat: "data/combat-lab" },
});

test("project continuation opens current graphics workflow while demos retain assembly", () => {
  const data = input();
  assert.deepEqual(buildStudioSummary(data).projects[0].target, { tool: "modeling", projectId: "hero", tab: "graphics" });
  data.projects[0].demo = true;
  assert.equal(buildStudioSummary(data).projects[0].target.tab, "assembly");
});

test("pending graphics cost and permission approvals appear as review without inventing results", () => {
  const graphics = workspace();
  graphics.tasks = [task(), task({ id: "assembly", taskId: "M08", status: "running", runtimeApproval: {
    id: "permission", title: "Review tool access", detail: "Approve local tool access", fields: [],
    requestedAt: updatedAt, executionId: "execution",
  } })];
  const summary = buildStudioSummary(input([graphics]));
  assert.equal(summary.runs.length, 2);
  assert.ok(summary.runs.every(entry => entry.tone === "review"));
  assert.deepEqual(summary.results, []);
  assert.equal(summary.projects[0].updatedAt, updatedAt);
  assert.ok(summary.runs.every(entry => entry.target.tab === "graphics" && entry.target.projectId === "hero"));
});

test("graphics summaries preserve live, ambiguous, failed and cancelled task distinctions", () => {
  const graphics = workspace();
  graphics.tasks = [task({ id: "live", status: "running" }), task({ id: "unknown", status: "submission_unknown" }),
    task({ id: "failed", status: "failed" }), task({ id: "cancelled", status: "cancelled" })];
  const summary = buildStudioSummary(input([graphics]));
  for (const [id, tone] of [["live", "active"], ["unknown", "review"], ["failed", "error"], ["cancelled", "neutral"]]) {
    assert.equal(summary.runs.find(entry => entry.id.endsWith(`:${id}`))?.tone, tone);
  }
});

test("only the owning object's adopted graphics version is successful and analysis stays review-only", () => {
  const graphics = workspace();
  graphics.versions = [version(), version({ id: "candidate", label: "Candidate" }),
    version({ id: "analysis", label: "Blocked contact analysis", contact: { schemaVersion: 1, phase: "analyze", status: "blocked",
      sourceVersionId: "head", partVersionIds: ["head", "body", "hair"], reportPath: "report.json", views: [], warnings: [], allowedVertexCount: 0 } }),
    version({ id: "orphan", objectId: "missing", label: "Missing object" }), version({ id: "empty", files: [] })];
  graphics.objects[0].accepted.staleAnalysis = "analysis";
  graphics.objects[0].accepted.staleForeign = "orphan";
  const data = input([graphics]);
  const before = JSON.stringify(data);
  const summary = buildStudioSummary(data);
  assert.equal(summary.results.find(entry => entry.title === "Independent head")?.tone, "success");
  assert.equal(summary.results.find(entry => entry.title === "Candidate")?.tone, "review");
  assert.equal(summary.results.find(entry => entry.title === "Blocked contact analysis")?.tone, "review");
  assert.equal(summary.results.find(entry => entry.title === "Missing object")?.tone, "review");
  assert.equal(summary.results.length, 4);
  assert.equal(JSON.stringify(data), before);
});

test("Unity import is not presented as verified playback and foreign workspaces do not leak", () => {
  const graphics = workspace();
  graphics.deliveries = [{ id: "delivery", objectId: "human", versionIds: ["head"], profileFingerprint: "profile", converterVersion: "1",
    createdAt: updatedAt, destination: "Assets/Hero", status: "imported", files: [], warnings: [], errors: [], playbackVerified: false }];
  const foreign = { ...workspace(), id: "other", projectId: "other", tasks: [task({ id: "foreign" })] };
  let summary = buildStudioSummary(input([graphics, foreign]));
  assert.equal(summary.runs.length, 0);
  assert.equal(summary.results.length, 1);
  assert.equal(summary.results[0].tone, "review");
  assert.match(summary.results[0].status, /미검증/);
  graphics.deliveries[0].playbackVerified = true;
  summary = buildStudioSummary(input([graphics]));
  assert.equal(summary.results[0].tone, "success");
});

test("a recovered contact main supersedes its saved blocked message without hiding the original result", () => {
  const graphics = workspace();
  const blocked = version({ id: "blocked", slot: "main", label: "Original diagnosis", provenance: { type: "codex", jobId: "contact" },
    contact: { schemaVersion: 1, phase: "reconstruct", status: "blocked", sourceVersionId: "source", partVersionIds: ["head", "body", "hair"],
      reportPath: "blocked.json", views: [], warnings: [], allowedVertexCount: 0 } });
  const repaired = version({ id: "repaired", slot: "main", provenance: { type: "codex", jobId: "contact" },
    contact: { ...blocked.contact!, status: "repaired", reportPath: "repaired.json", allowedVertexCount: 10 } });
  const unrelated = version({ ...blocked, id: "unrelated", provenance: { type: "codex", jobId: "other-job" } });
  graphics.versions = [blocked, repaired, unrelated];
  graphics.tasks = [task({ id: "contact", taskId: "M06", settings: { contactPhase: "reconstruct" }, status: "review",
    outputVersionIds: ["blocked", "repaired", "unrelated"], message: "Saved failure: reconstruction blocked" })];
  const summary = buildStudioSummary(input([graphics]));
  assert.equal(summary.runs[0].tone, "review");
  assert.match(summary.runs[0].status, /보정 후보/);
  assert.doesNotMatch(summary.runs[0].detail, /Saved failure|blocked/);
  assert.match(summary.results.find(entry => entry.title === "Original diagnosis")!.status, /중단/);
});

test("assembly acceptance remains incomplete when the object has adopted a different part", () => {
  const graphics = workspace();
  graphics.versions = [version({ id: "main", label: "Assembly", slot: "main", provenance: { type: "local", jobId: "assembly" } }),
    version(), version({ id: "body", slot: "part-body" }), version({ id: "hair", slot: "part-hair" })];
  graphics.objects[0].accepted = { "model:main": "main", "model:part-head": "new-head", "model:part-body": "body", "model:part-hair": "hair" };
  graphics.tasks = [task({ id: "assembly", taskId: "M08", status: "review", outputVersionIds: ["main", "head", "body", "hair"] })];
  let result = buildStudioSummary(input([graphics])).results.find(entry => entry.title === "Assembly")!;
  assert.equal(result.tone, "review");
  graphics.objects[0].accepted["model:part-head"] = "head";
  result = buildStudioSummary(input([graphics])).results.find(entry => entry.title === "Assembly")!;
  assert.equal(result.tone, "success");
});

test("cancelling tracking after paid approval retains a remote-state review warning", () => {
  const graphics = workspace();
  graphics.tasks = [task({ status: "cancelled", paidApproval: { requestHash: "hash", provider: "Tripo API", credits: 20, approvedAt: createdAt } })];
  const result = buildStudioSummary(input([graphics])).runs[0];
  assert.equal(result.tone, "review");
  assert.match(result.status, /원격 상태 확인/);
});
