/** Isolated actual-app planar candidate → Unity import/redelivery verification. No production writes, no Play Mode. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { inspectUnityDelivery } from "../engine/graphics-unity";
import type { AssetVersion, UnityDelivery } from "../shared/graphics";
const repo = process.cwd(),
  runtime = path.resolve("artifacts/runtime"),
  fixture = JSON.parse(
    fs.readFileSync(
      process.env.PARTSMITH_PLANAR_FIXTURE ??
        path.join(runtime, "graphics-planar-fixture.json"),
      "utf8",
    ),
  );
const evidencePrefix =
  process.env.PARTSMITH_PLANAR_EVIDENCE ?? "graphics-planar";
assert(/^[a-z0-9-]+$/.test(evidencePrefix));
const appPath = path.join(runtime, `${evidencePrefix}-app.json`),
  evidencePath = path.join(runtime, `${evidencePrefix}-unity.json`);
const mode = process.argv[2] ?? "all";
assert(["first", "redeliver", "all"].includes(mode), "Use first|redeliver|all");
const sha = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const read = (file: string) =>
  JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const inside = (base: string, file: string) => {
  const rel = path.relative(base, file);
  assert(
    rel &&
      rel !== ".." &&
      !rel.startsWith(".." + path.sep) &&
      !path.isAbsolute(rel),
    "Path escaped isolated fixture",
  );
  return file;
};
const root = fs.realpathSync(fixture.root),
  unity = fs.realpathSync(fixture.unity);
inside(fs.realpathSync(os.tmpdir()), root);
assert(path.basename(root).startsWith("ps-planar-chest-"));
inside(root, unity);
inside(root, fs.realpathSync(fixture.profile));
async function ready() {
  const end = Date.now() + 300000;
  while (Date.now() < end) {
    if (fs.existsSync(appPath)) {
      const app = read(appPath);
      if (app.candidate && app.delivery) return app;
    }
    if (!process.argv.includes("--wait"))
      throw Error(
        "Actual app candidate/delivery not ready. Run after root app delivery, or pass --wait.",
      );
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error("Timed out waiting for exact app candidate/delivery");
}
async function command(args: string[], log: string) {
  const binary = path.join(
    process.env.LOCALAPPDATA!,
    "Unity",
    "bin",
    "unity.exe",
  );
  assert(fs.existsSync(binary), "Unity CLI not installed");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: repo,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stream = fs.createWriteStream(log);
    let tail = "";
    child.stdout.on("data", (v) => {
      stream.write(v);
      tail = (tail + v).slice(-4000);
    });
    child.stderr.on("data", (v) => {
      stream.write(v);
      tail = (tail + v).slice(-4000);
    });
    child.on("error", (e) => {
      stream.end();
      reject(e);
    });
    child.on("close", (code) => {
      stream.end();
      let noInstances = false;
      if (args[0] === "status" && code === 6)
        try {
          const result = JSON.parse(tail);
          noInstances =
            result.data?.count === 0 &&
            result.data?.instances?.length === 0 &&
            result.errors?.every((e: any) => e.code === "STATUS_NO_INSTANCES");
        } catch {}
      code === 0 || noInstances
        ? resolve()
        : reject(Error("Unity CLI failed " + code + ": " + tail));
    });
  });
}
const evidence: any = fs.existsSync(evidencePath)
  ? read(evidencePath)
  : { fixture, paidSubmissions: 0, productionGPT: 0, playMode: false };
function save() {
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
}
try {
  const app = await ready(),
    candidate = app.candidate as AssetVersion,
    delivery = app.delivery as UnityDelivery;
  assert.equal(
    app.acceptedVersionId,
    candidate.id,
    "Actual app must explicitly adopt exact candidate first",
  );
  assert(candidate.planarRepair);
  assert.deepEqual(delivery.versionIds, [candidate.id]);
  assert.equal(delivery.objectId, fixture.objectId);
  assert(
    /^Assets\/PartsmithGraphics\/[A-Za-z0-9_-]+$/.test(delivery.destination),
  );
  const projectRoot = inside(
    root,
    path.join(fixture.profile, "projects", fixture.projectId),
  );
  for (const file of candidate.files) {
    const full = inside(projectRoot, path.resolve(projectRoot, file.path));
    assert.equal(sha(full), file.sha256);
    assert.equal(fs.statSync(full).size, file.bytes);
  }
  const glb = candidate.files.find((f) => /\.glb$/i.test(f.path))!;
  assert(glb);
  const bytes = fs.readFileSync(path.join(projectRoot, glb.path));
  assert.equal(bytes.toString("ascii", 0, 4), "glTF");
  const doc = JSON.parse(
    bytes.toString("utf8", 20, 20 + bytes.readUInt32LE(12)).trim(),
  );
  const nodes = doc.nodes.filter((n: any) => Number.isInteger(n.mesh));
  const expectedMeshes = nodes.length;
  const expectedTriangles = nodes.reduce(
    (n: number, node: any) =>
      n +
      doc.meshes[node.mesh].primitives.reduce((count: number, p: any) => {
        assert((p.mode ?? 4) === 4, "Expected triangle primitive");
        return (
          count + doc.accessors[p.indices ?? p.attributes.POSITION].count / 3
        );
      }, 0),
    0,
  );
  const staged = inside(
    unity,
    path.join(unity, "Library", "PartsmithGraphicsStaging", delivery.id),
  );
  const requestPath = inside(unity, path.join(staged, "request.json")),
    queue = read(requestPath);
  assert.equal(queue.requestId, delivery.id);
  assert.equal(queue.objectId, fixture.objectId);
  assert.equal(queue.destination, delivery.destination);
  for (const source of queue.sources)
    assert(
      candidate.files.some((f) => f.sha256 === source.sha256),
      "Delivery must contain exact candidate source only",
    );
  const physical = read(inside(unity, path.join(staged, "physical-size.json")));
  const expectedDimensions = physical.dimensionsMeters;
  assert(
    expectedDimensions &&
      ["x", "y", "z"].every(
        (k) =>
          Number.isFinite(expectedDimensions[k]) && expectedDimensions[k] > 0,
      ),
  );
  await command(
    ["status", "--format", "json"],
    path.join(runtime, `${evidencePrefix}-unity-status.log`),
  );
  // status output is retained; refuse a live instance for this exact isolated project before batch editing.
  const statusText = fs.readFileSync(
    path.join(runtime, `${evidencePrefix}-unity-status.log`),
    "utf8",
  );
  assert(
    !statusText
      .replaceAll("\\\\", "\\")
      .toLowerCase()
      .includes(unity.toLowerCase()),
    "Isolated Unity is live; use its live Editor instead of batch",
  );
  const editorDir = inside(unity, path.join(unity, "Assets", "Editor"));
  fs.mkdirSync(editorDir, { recursive: true });
  fs.copyFileSync(
    path.join(repo, "scripts", "fixtures", "PlanarUnityCheck.cs"),
    path.join(editorDir, "PlanarUnityCheck.cs"),
  );
  fs.copyFileSync(
    path.join(repo, "scripts", "fixtures", "PlanarUserMarker.cs"),
    inside(unity, path.join(unity, "Assets", "PlanarUserMarker.cs")),
  );
  const execute = async (secondPass: boolean) => {
    const label = secondPass ? "reimport" : "import";
    fs.writeFileSync(
      inside(unity, path.join(unity, "Library", "PlanarCheckRequest.json")),
      JSON.stringify({
        destination: delivery.destination,
        expectedTriangles,
        expectedMeshes,
        expectedDimensions,
        secondPass,
      }),
    );
    await command(
      [
        "run",
        unity,
        "--format",
        "json",
        "--timeout",
        "300",
        "--",
        "-executeMethod",
        "PlanarUnityCheck.Run",
        "-logFile",
        path.join(runtime, evidencePrefix + "-unity-" + label + "-editor.log"),
      ],
      path.join(runtime, evidencePrefix + "-unity-" + label + "-cli.log"),
    );
    const result = read(
      inside(unity, path.join(unity, "PlanarEvidence", label + ".json")),
    );
    assert.equal(result.passed, true);
    assert.equal(result.playMode, false);
    assert.equal(result.triangles, expectedTriangles);
    assert.equal(result.meshes, expectedMeshes);
    assert.equal(result.invalidUVTriangles, 0);
    assert(result.materials > 0);
    assert(result.userComponentPreserved && result.sceneReferencePreserved);
    const receipt = inspectUnityDelivery(unity, delivery);
    assert.equal(receipt.status, "imported", JSON.stringify(receipt.errors));
    assert.deepEqual(receipt.versionIds, [candidate.id]);
    return { result, receipt };
  };
  evidence.candidateVersionId = candidate.id;
  evidence.deliveryId = delivery.id;
  evidence.expectedTriangles = expectedTriangles;
  evidence.expectedMeshes = expectedMeshes;
  evidence.expectedDimensions = expectedDimensions;
  if (mode === "first" || mode === "all") {
    evidence.first = await execute(false);
    save();
  }
  if (mode === "redeliver" || mode === "all") {
    assert(evidence.first?.result?.passed, "First pass evidence required");
    const user = inside(
        unity,
        path.join(unity, delivery.destination, "User", "Asset.prefab"),
      ),
      scene = inside(
        unity,
        path.join(unity, "Assets", "PlanarReference.unity"),
      );
    const before = {
      user: sha(user),
      userMeta: sha(user + ".meta"),
      scene: sha(scene),
      sceneMeta: sha(scene + ".meta"),
    };
    // Force the exact previously staged local request through the real bridge again; no generation or converter replay.
    for (const f of queue.files) {
      assert.equal(sha(inside(staged, path.resolve(f.source))), f.sha256);
    }
    const inbox = inside(
      unity,
      path.join(
        unity,
        "Library",
        "PartsmithGraphicsInbox",
        delivery.id + ".json",
      ),
    );
    fs.mkdirSync(path.dirname(inbox), { recursive: true });
    assert(!fs.existsSync(inbox), "Do not overwrite an active inbox request");
    const receiptFile = inside(
        unity,
        path.join(
          unity,
          "Library",
          "PartsmithGraphicsResults",
          delivery.id + ".json",
        ),
      ),
      receiptBefore = fs.statSync(receiptFile).mtimeMs;
    fs.writeFileSync(inbox, JSON.stringify(queue), { flag: "wx" });
    evidence.reimport = await execute(true);
    assert(!fs.existsSync(inbox), "Bridge did not consume repeated request");
    assert(
      fs.statSync(receiptFile).mtimeMs > receiptBefore,
      "Bridge did not publish a fresh import receipt",
    );
    assert.equal(
      evidence.reimport.result.generatedGuid,
      evidence.first.result.generatedGuid,
    );
    assert.equal(
      evidence.reimport.result.userGuid,
      evidence.first.result.userGuid,
    );
    assert.equal(
      evidence.reimport.result.userToken,
      evidence.first.result.userToken,
    );
    assert.deepEqual(
      {
        user: sha(user),
        userMeta: sha(user + ".meta"),
        scene: sha(scene),
        sceneMeta: sha(scene + ".meta"),
      },
      before,
    );
    evidence.preservedUserFiles = before;
    save();
  }
  for (const f of fixture.sourceFiles)
    assert.equal(
      sha(inside(projectRoot, path.join(projectRoot, f.path))),
      f.sha256,
    );
  evidence.passed = true;
  evidence.renderFiles = [];
  for (const phase of ["import", "reimport"])
    for (const name of ["oblique", "x", "minus-x", "minus-z", "z"]) {
      const from = inside(
        unity,
        path.join(unity, "PlanarEvidence", phase + "-" + name + ".png"),
      );
      if (fs.existsSync(from)) {
        const to = path.join(
          runtime,
          evidencePrefix + "-unity-" + phase + "-" + name + ".png",
        );
        fs.copyFileSync(from, to);
        evidence.renderFiles.push({
          path: to,
          sha256: sha(to),
          bytes: fs.statSync(to).size,
        });
      }
    }
  if (evidence.failure) {
    evidence.priorFailures = [
      ...(evidence.priorFailures ?? []),
      evidence.failure,
    ];
    delete evidence.failure;
  }
  evidence.completedAt = new Date().toISOString();
  save();
  console.log(
    JSON.stringify({
      passed: true,
      candidate: candidate.id,
      triangles: expectedTriangles,
      meshes: expectedMeshes,
      redelivered: !!evidence.reimport,
    }),
  );
} catch (error) {
  evidence.failure = { message: String(error), at: new Date().toISOString() };
  save();
  throw error;
}
