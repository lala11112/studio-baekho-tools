import test from "node:test";
import assert from "node:assert/strict";
import { getGraphicsCompatibility } from "../shared/graphics-lineage";
import type { AssetVersion, GraphicsObject, GraphicsRole } from "../shared/graphics";

const version = (id: string, role: GraphicsRole, sourceVersionIds: string[] = [], digest = id.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)): AssetVersion => ({
  id, objectId: "object", role, slot: role === "animation" ? id : "main", label: id,
  files: [{ path: id + (role === "design" || role === "material" ? ".png" : role === "model" ? ".fbx" : ".blend"), sha256: digest, bytes: 10, kind: "fixture" }],
  createdAt: "2026-10-12T00:00:00Z", sourceVersionIds, provenance: { type: sourceVersionIds.length ? "local" : "import" }, warnings: [],
});
const object = (accepted: Record<string, string>): GraphicsObject => ({ id: "object", name: "Test", kind: "prop", createdAt: "2026-10-12T00:00:00Z", selectedTasks: [], instruction: "", settings: {}, references: [], accepted });

test("imported static models need neither design ancestry nor an automatically forced rig", () => {
  const versions = [version("model", "model"), version("new design", "design")];
  assert.deepEqual(getGraphicsCompatibility(object({ "model:main": "model", "design:main": "new design" }), versions), []);
});

test("new model with an old rig requires review; explicitly adopting the prior model clears it", () => {
  const versions = [version("old model", "model"), version("new model", "model"), version("rig", "rig", ["old model"]), version("Idle", "animation", ["rig"])];
  const current = object({ "model:main": "new model", "rig:main": "rig", "animation:Idle": "Idle" });
  const before = structuredClone({ current, versions });
  const issues = getGraphicsCompatibility(current, versions);
  assert.equal(issues.length, 1); assert.match(issues[0], /다른 모델 버전/); assert.match(issues[0], /호환성/);
  assert.deepEqual({ current, versions }, before);
  assert.deepEqual(getGraphicsCompatibility(object({ ...current.accepted, "model:main": "old model" }), versions), []);
});

test("rig and clip revisions resolve nearest ancestors; only stale selected clips are flagged", () => {
  const versions = [version("model", "model"), version("rig old", "rig", ["model"], "a".repeat(64)), version("rig new", "rig", ["rig old"], "b".repeat(64)), version("Idle old", "animation", ["rig old"]), version("Idle revised", "animation", ["Idle old"]), version("Jump", "animation", ["rig new"])];
  const current = object({ "model:main": "model", "rig:main": "rig new", "animation:Idle": "Idle revised", "animation:Jump": "Jump" });
  const issues = getGraphicsCompatibility(current, versions);
  assert.equal(issues.length, 1); assert.match(issues[0], /Idle revised/); assert.doesNotMatch(issues[0], /Jump/);
});

test("matching an older model ancestor does not bypass the nearest model actually used by the rig", () => {
  const versions = [version("old model", "model"), version("new model", "model", ["old model"]), version("rig", "rig", ["new model"])];
  assert.equal(getGraphicsCompatibility(object({ "model:main": "old model", "rig:main": "rig" }), versions).length, 1);
});

test("material/design acceptance alone and exact native bytes do not invalidate skeleton provenance", () => {
  const versions = [version("model old", "model", [], "a".repeat(64)), version("model recolored", "model", ["model old"], "a".repeat(64)), version("rig", "rig", ["model old"]), version("material", "material", ["model old"]), version("design", "design")];
  versions[1].files.push({ path: "new-color.png", sha256: "f".repeat(64), bytes: 8, kind: "image" });
  const current = object({ "model:main": "model recolored", "rig:main": "rig", "material:main": "material", "design:main": "design" });
  assert.deepEqual(getGraphicsCompatibility(current, versions), []);
});

test("missing or cyclic active provenance is a review requirement rather than a quality failure", () => {
  const versions = [version("model", "model"), version("rig", "rig", ["revision"]), version("revision", "rig", ["rig"]), version("Idle", "animation", ["missing"]), version("imported rig", "rig")];
  const current = object({ "model:main": "model", "rig:main": "rig", "animation:Idle": "Idle" });
  const issues = getGraphicsCompatibility(current, versions);
  assert.equal(issues.length, 2); assert.ok(issues.every(issue => issue.includes("확인"))); assert.ok(issues.every(issue => !issue.includes("품질 실패")));
  assert.deepEqual(getGraphicsCompatibility(object({ "rig:main": "imported rig" }), versions), []);
  assert.equal(getGraphicsCompatibility(object({ "model:main": "model", "rig:main": "imported rig" }), versions).length, 1);
});

test("appearance references from other objects are not model/skeleton ancestry", () => {
  const external = { ...version("reference model", "model"), objectId: "another object" };
  const versions = [version("model", "model"), external, version("design", "design", ["reference model"]), version("rig", "rig", ["model", "design", "reference model"])];
  assert.deepEqual(getGraphicsCompatibility(object({ "model:main": "model", "rig:main": "rig" }), versions), []);
});
