import { app, nativeImage } from "electron";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import { prepareSeparationImages } from "../electron/separation-preview";
import { CodexWorkbenchExecutor } from "../engine/workbench-executor";
import type { ProductionWorker } from "../engine/codex-worker";
import type {
  Workbench,
  WorkbenchArtifact,
  WorkbenchView,
} from "../shared/workbench";

// Electron host + real PNG codec; only synthetic files and copied existing photos
// are written under artifacts/runtime. Existing project/checkpoint data is read-only.
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const read = <T>(file: string): T =>
  JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const sha = (file: string) => hash(fs.readFileSync(file));
const decode = (file: string) => {
  const bytes = fs.readFileSync(file);
  return PNG.sync.read(
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? bytes
      : nativeImage.createFromBuffer(bytes).toPNG(),
  );
};
const bounds = (png: PNG) => {
  let left = png.width,
    top = png.height,
    right = -1,
    bottom = -1,
    transparent = 0;
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const alpha = png.data[(y * png.width + x) * 4 + 3];
      if (alpha === 0) transparent++;
      if (alpha >= 128) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  return {
    x: left,
    y: top,
    width: right - left + 1,
    height: bottom - top + 1,
    transparentPixels: transparent,
  };
};
function writeFixture(
  projectRoot: string,
  workspace: string,
  view: WorkbenchView,
  width: number,
  height: number,
  rect: { x: number; y: number; width: number; height: number },
): WorkbenchArtifact {
  const image = new PNG({ width, height });
  image.data.fill(0);
  for (let y = rect.y; y < rect.y + rect.height; y++)
    for (let x = rect.x; x < rect.x + rect.width; x++)
      image.data.set(
        x < rect.x + rect.width / 2 ? [220, 50, 25, 255] : [25, 180, 90, 255],
        (y * width + x) * 4,
      );
  const file = path.join(workspace, `${view}.png`),
    bytes = PNG.sync.write(image);
  fs.writeFileSync(file, bytes);
  return {
    path: path.relative(projectRoot, file).split(path.sep).join("/"),
    kind: "image",
    role: "head",
    view,
    sha256: hash(bytes),
    bytes: bytes.length,
  };
}
async function main() {
  const repo = process.cwd();
  const root = path.join(
    repo,
    "artifacts/runtime/separation-normalization-smoke",
    randomUUID(),
  );
  const reportFile = path.join(
    repo,
    "artifacts/separation-normalization-smoke.json",
  );
  const userProjects = path.join(
    process.env.APPDATA ?? "",
    "partsmith",
    "projects",
  );
  const checkpointRoot = path.join(
    process.env.APPDATA ?? "",
    "partsmith",
    "workbench-checkpoints",
  );
  fs.mkdirSync(root, { recursive: true });
  app.setPath("userData", path.join(root, "electron-user-data"));
  await app.whenReady();
  const checks: string[] = [];
  let workerCalls = 0;
  try {
    const fixtureRoot = path.join(root, "synthetic-project"),
      workspace = path.join(fixtureRoot, "workbench/fixture/jobs/fixture");
    fs.mkdirSync(workspace, { recursive: true });
    const artifacts = [
      writeFixture(fixtureRoot, workspace, "front", 120, 180, {
        x: 8,
        y: 55,
        width: 30,
        height: 60,
      }),
      writeFixture(fixtureRoot, workspace, "back", 300, 220, {
        x: 180,
        y: 20,
        width: 48,
        height: 120,
      }),
      writeFixture(fixtureRoot, workspace, "left", 100, 140, {
        x: 15,
        y: 40,
        width: 40,
        height: 80,
      }),
      writeFixture(fixtureRoot, workspace, "right", 240, 300, {
        x: 80,
        y: 35,
        width: 70,
        height: 140,
      }),
    ];
    const normalized = prepareSeparationImages(
      artifacts,
      workspace,
      fixtureRoot,
    );
    const measured = normalized.map((a) => {
      assert(a.normalized, `${a.view}: normalized output missing`);
      const bytes = fs.readFileSync(path.join(fixtureRoot, a.normalized.path)),
        png = PNG.sync.read(bytes),
        box = bounds(png);
      assert.equal(png.width, 2048);
      assert.equal(png.height, 2048);
      assert.equal(hash(bytes), a.normalized.sha256);
      assert.equal(a.normalized.sourceSha256, a.sha256);
      assert.equal(a.normalized.anchorSha256, artifacts[0].sha256);
      assert.ok(Math.abs(box.y + box.height / 2 - 1024) <= 0.5);
      assert.ok(Math.abs(box.x + box.width / 2 - 1024) <= 0.5);
      const expectedHeight = (2048 * 60) / 180;
      assert.ok(Math.abs(box.height - expectedHeight) <= 1);
      const left = (1024 * 2048 + Math.floor(box.x + box.width * 0.25)) * 4,
        right = (1024 * 2048 + Math.floor(box.x + box.width * 0.75)) * 4;
      assert.ok(png.data[left] > png.data[left + 1]);
      assert.ok(png.data[right + 1] > png.data[right]);
      return {
        view: a.view,
        width: png.width,
        height: png.height,
        silhouette: box,
      };
    });
    checks.push(
      "PNG service produces common 2048 canvas and same-part silhouette height/center from four differently sized source canvases",
    );
    checks.push(
      "Real encoded PNG derivatives preserve left/right colors and raw/anchor SHA lineage",
    );
    const mtimes = normalized.map(
      (a) =>
        fs.statSync(path.join(fixtureRoot, a.normalized!.path), {
          bigint: true,
        }).mtimeNs,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    const cached = prepareSeparationImages(artifacts, workspace, fixtureRoot);
    assert.deepEqual(
      JSON.parse(JSON.stringify(cached)),
      JSON.parse(JSON.stringify(normalized)),
    );
    cached.forEach((a, i) =>
      assert.equal(
        fs.statSync(path.join(fixtureRoot, a.normalized!.path), {
          bigint: true,
        }).mtimeNs,
        mtimes[i],
      ),
    );
    artifacts.forEach((a) =>
      assert.equal(sha(path.join(fixtureRoot, a.path)), a.sha256),
    );
    assert(
      artifacts.every((a) => !a.normalized),
      "caller-owned raw artifact metadata is unchanged",
    );
    checks.push(
      "Second service call uses cached files without rewriting; input artifact metadata and raw source bytes stay unchanged",
    );
    const opaqueWorkspace = path.join(
      fixtureRoot,
      "workbench/opaque/jobs/opaque",
    );
    fs.mkdirSync(opaqueWorkspace, { recursive: true });
    const opaque = writeFixture(fixtureRoot, opaqueWorkspace, "front", 32, 32, {
      x: 0,
      y: 0,
      width: 32,
      height: 32,
    });
    opaque.role = "body";
    const opaquePath = path.join(fixtureRoot, opaque.path);
    const ambiguous = prepareSeparationImages(
      [opaque],
      opaqueWorkspace,
      fixtureRoot,
    )[0];
    assert(!ambiguous.normalized);
    assert(ambiguous.normalizationIssue);
    assert.equal(sha(opaquePath), opaque.sha256);
    checks.push(
      "Opaque background remains raw and receives an explicit normalization issue instead of a guessed crop",
    );

    let actual: Record<string, unknown> = { found: false };
    let sourceWorkbench: Workbench | undefined,
      manifestFile: string | undefined,
      originalProjectRoot: string | undefined;
    const inspectJobId = process.env.PARTSMITH_INSPECT_JOB_ID;
    if (inspectJobId && fs.existsSync(userProjects))
      for (const project of fs.readdirSync(userProjects, {
        withFileTypes: true,
      })) {
        if (!project.isDirectory()) continue;
        const projectRoot = path.join(userProjects, project.name),
          workbenchRoot = path.join(projectRoot, "workbench");
        if (!fs.existsSync(workbenchRoot)) continue;
        for (const dir of fs.readdirSync(workbenchRoot, {
          withFileTypes: true,
        })) {
          if (!dir.isDirectory()) continue;
          const file = path.join(workbenchRoot, dir.name, "workbench.json");
          if (!fs.existsSync(file)) continue;
          const w = read<Workbench>(file);
          if (w.jobs.some((j) => j.id === inspectJobId)) {
            sourceWorkbench = w;
            manifestFile = file;
            originalProjectRoot = projectRoot;
            break;
          }
        }
        if (sourceWorkbench) break;
      }
    if (sourceWorkbench && manifestFile && originalProjectRoot) {
      const job = sourceWorkbench.jobs.find((j) => j.id === inspectJobId)!;
      assert.notEqual(
        job.status,
        "running",
        "Read-only inspection is restricted to the stopped user job",
      );
      const manifestHash = sha(manifestFile),
        sourceWorkspace = path.join(
          originalProjectRoot,
          `workbench/${sourceWorkbench.id}/jobs/${job.id}`,
        );
      const worker = {
        run: async () => {
          workerCalls++;
          throw Error("Smoke test prohibits worker execution");
        },
        probe: async () => {
          workerCalls++;
          throw Error("Smoke test prohibits worker probing");
        },
        stageReceipt: () => {
          workerCalls++;
          throw Error("Smoke test prohibits remote service access");
        },
      } as unknown as ProductionWorker;
      const executor = new CodexWorkbenchExecutor(worker, {
        projectRoot: () => originalProjectRoot!,
        checkpointRoot,
        blenderPath: () => "",
        unityPath: () => undefined,
        unityEditorPath: () => "",
        resourcesPath: path.join(repo, "integrations"),
      });
      const saved = await executor.inspectSaved({
        workbench: sourceWorkbench,
        job,
        workspace: sourceWorkspace,
        inputs: [],
        signal: new AbortController().signal,
      });
      const rawImages = saved.candidates
        .flatMap((c) => c.artifacts)
        .filter((a) => a.kind === "image");
      const copyRoot = path.join(root, "copied-project"),
        copyWorkspace = path.join(copyRoot, "workbench/copied/jobs/copied");
      fs.mkdirSync(copyWorkspace, { recursive: true });
      const sources: { file: string; sha256: string }[] = [];
      const copies = rawImages.map((a, i) => {
        const file = path.resolve(sourceWorkspace, a.path);
        assert(file.startsWith(sourceWorkspace + path.sep));
        const bytes = fs.readFileSync(file),
          sha256 = hash(bytes);
        sources.push({ file, sha256 });
        const dest = path.join(
          copyWorkspace,
          `${i}-${a.role}-${a.view ?? "front"}${path.extname(a.path)}`,
        );
        fs.writeFileSync(dest, bytes);
        return {
          ...a,
          path: path.relative(copyRoot, dest).split(path.sep).join("/"),
          sha256,
          bytes: bytes.length,
        } as WorkbenchArtifact;
      });
      const actualPrepared = prepareSeparationImages(
        copies,
        copyWorkspace,
        copyRoot,
      );
      const details = actualPrepared.map((a) => {
        const original = decode(path.join(copyRoot, a.path));
        const normalized = a.normalized
          ? PNG.sync.read(
              fs.readFileSync(path.join(copyRoot, a.normalized.path)),
            )
          : undefined;
        return {
          role: a.role,
          view: a.view ?? "front",
          sourceDimensions: [original.width, original.height],
          normalizedDimensions: normalized
            ? [normalized.width, normalized.height]
            : undefined,
          sourceSilhouette: bounds(original),
          normalizedSilhouette: normalized ? bounds(normalized) : undefined,
          normalizationIssue: a.normalizationIssue
            ? "Transparency or source alignment needs review"
            : undefined,
        };
      });
      sources.forEach((s) => assert.equal(sha(s.file), s.sha256));
      copies.forEach((a) =>
        assert.equal(sha(path.join(copyRoot, a.path)), a.sha256),
      );
      assert.equal(sha(manifestFile), manifestHash);
      assert.equal(workerCalls, 0);
      actual = {
        found: true,
        storedStatus: job.status,
        inspectionStatus: saved.status,
        recoveredImageCount: rawImages.length,
        normalizedImageCount: actualPrepared.filter((a) => a.normalized).length,
        warningCount: saved.checks.filter((c) => !c.passed).length,
        rawHashesUnchanged: true,
        manifestUnchanged: true,
        workerCalls,
        images: details,
      };
      checks.push(
        "Stopped real saved job inspected read-only; generated photos copied to test workspace and normalized with zero worker/generation calls",
      );
    }
    fs.writeFileSync(
      reportFile,
      JSON.stringify(
        {
          passed: true,
          checks,
          synthetic: measured,
          actual,
          workerCalls,
          realGenerationCalls: 0,
          realPaidCalls: 0,
          userDataWritten: false,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        passed: true,
        checks: checks.length,
        actualFound: actual.found,
        recoveredImageCount: actual.recoveredImageCount,
        normalizedImageCount: actual.normalizedImageCount,
        workerCalls,
      }),
    );
  } catch (error) {
    fs.writeFileSync(
      reportFile,
      JSON.stringify(
        {
          passed: false,
          checks,
          error: error instanceof Error ? error.message : String(error),
          workerCalls,
          realGenerationCalls: 0,
          realPaidCalls: 0,
          userDataWritten: false,
        },
        null,
        2,
      ),
    );
    console.error(error);
    process.exitCode = 1;
  } finally {
    app.exit(Number(process.exitCode ?? 0));
  }
}
main().catch((error) => {
  console.error(error);
  app.exit(1);
});
