import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../engine/store";
import { restoreProductionArchives } from "../engine/production-backup";
import type { ProductionRun } from "../shared/production";

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "partsmith-backup-"));
  const store = new Store(path.join(root, "restored"));
  await store.open(path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"));
  const backup = path.join(root, "backup"),
    dir = path.join(backup, "production", "run-one");
  fs.mkdirSync(path.join(dir, "inputs"), { recursive: true });
  const bytes = Buffer.from("mock image"),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(path.join(dir, "inputs/front.png"), bytes);
  const run = {
    schemaVersion: 1,
    id: "run-one",
    projectId: "project-one",
    projectRevision: 0,
    workspace: "C:/old-machine/production/run-one",
    approvedAt: "2026-10-08",
    status: "running",
    createdAt: "2026-10-08",
    updatedAt: "2026-10-08",
    config: {
      sourceId: "front",
      brief: "MOCK TEST",
      motions: ["wave"],
      maxIterations: 2,
      studioCreditLimit: 100,
      videoCreditLimit: 0,
      mode: "studio",
    },
    source: { path: "inputs/front.png", sha256, label: "front" },
    stages: [
      {
        id: "separate",
        kind: "separate",
        title: "separate",
        dependsOn: [],
        status: "running",
        attempt: 1,
        charged: false,
        requiredChecks: [],
        artifacts: [],
      },
    ],
  };
  const save = () =>
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run));
  save();
  return { store, backup, dir, run, save, bytes };
}
test("production backup restores verified files as a non-executable archive and rebases paths", async () => {
  const f = await fixture();
  const report = Buffer.from("# Completed MOCK TEST evidence");
  fs.writeFileSync(path.join(f.dir, "review.md"), report);
  const withReport = {
    ...f.run,
    stages: [
      {
        ...f.run.stages[0],
        status: "completed",
        artifacts: [
          {
            path: "review.md",
            kind: "report",
            sha256: createHash("sha256").update(report).digest("hex"),
            bytes: report.length,
            stageId: "separate",
          },
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(f.dir, "run.json"), JSON.stringify(withReport));
  restoreProductionArchives(f.store, "project-one", f.backup);
  const run = f.store.get<ProductionRun>("production", "run-one")!;
  assert.equal(run.status, "cancelled");
  assert.equal(run.approvedAt, undefined);
  assert.equal(run.stages[0].status, "completed");
  assert.deepEqual(
    fs.readFileSync(path.join(run.workspace, "review.md")),
    report,
  );
  assert.equal(
    run.workspace,
    f.store.file("project-one", "production/run-one"),
  );
  assert.deepEqual(
    fs.readFileSync(path.join(run.workspace, "inputs/front.png")),
    f.bytes,
  );
  assert.throws(
    () => restoreProductionArchives(f.store, "project-one", f.backup),
    /중복/,
  );
});
test("production backup rejects changed evidence and paths outside the archived run", async () => {
  const f = await fixture();
  fs.writeFileSync(path.join(f.dir, "inputs/front.png"), "changed");
  assert.throws(
    () => restoreProductionArchives(f.store, "project-one", f.backup),
    /해시/,
  );
  assert.equal(f.store.get("production", "run-one"), undefined);
  f.run.source.path = "../outside.png";
  f.save();
  assert.throws(
    () => restoreProductionArchives(f.store, "project-one", f.backup),
    /경로/,
  );
});
