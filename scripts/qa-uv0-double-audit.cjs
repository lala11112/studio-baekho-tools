// Offline only. No Blender launch, product edits, raw/log rewriting, or tolerance changes.
// Usage: node scripts/qa-uv0-double-audit.cjs [artifact-directory]
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto"),
  assert = require("assert/strict");
const dir = path.resolve(
    process.argv[2] ??
      "artifacts/runtime/qa-20261018-uv0-export-independent-v2",
  ),
  q = JSON.parse(fs.readFileSync(dir + "/raw-snapshots.json")),
  m = JSON.parse(fs.readFileSync(dir + "/manifest.json"));
const add = (a, b) => a.map((x, i) => x + b[i]),
  sub = (a, b) => a.map((x, i) => x - b[i]),
  mul = (a, s) => a.map((x) => x * s),
  dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0),
  cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  len = (a) => Math.sqrt(dot(a, a)),
  world = (row, p) =>
    row.world
      .slice(0, 3)
      .map((r) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + r[3]);
function tris(label, layer, name) {
  return Object.entries(q[label].objects)
    .filter(([n]) => !name || n === name)
    .flatMap(([n, o]) => {
      if (!o.polygons) return [];
      let base = 0;
      return o.polygons.flatMap((p) => {
        const ts = [];
        for (let i = 1; i < p.length - 1; i++) {
          let idx = [0, i, i + 1];
          ts.push({
            p: idx.map((j) => world(o, o.vertices[p[j]])),
            uv: idx.map((j) => o.uv[layer].values[base + j]),
          });
        }
        base += p.length;
        return ts;
      });
    });
}
const extent = Math.max(
    ...q.export.bounds.max.map((x, i) => x - q.export.bounds.min[i]),
  ),
  tol = Math.max(extent * 2e-6, 1e-7);
function closest(p, a, b, c) {
  const ab = sub(b, a),
    ac = sub(c, a),
    ap = sub(p, a),
    d1 = dot(ab, ap),
    d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return [1, 0, 0];
  const bp = sub(p, b),
    d3 = dot(ab, bp),
    d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return [0, 1, 0];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [1 - v, v, 0];
  }
  const cp = sub(p, c),
    d5 = dot(ab, cp),
    d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return [0, 0, 1];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const v = d2 / (d2 - d6);
    return [1 - v, 0, v];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const v = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [0, 1 - v, v];
  }
  const inv = 1 / (va + vb + vc),
    v = vb * inv,
    w = vc * inv;
  return [1 - v - w, v, w];
}
function compare(a, b, uv = true) {
  let maxWorld = 0,
    maxUV = 0,
    unmatched = [];
  for (const t of a) {
    const normal = cross(sub(t.p[1], t.p[0]), sub(t.p[2], t.p[0]));
    const points = t.p.map((p, i) => ({ p, uv: t.uv[i] }));
    points.push({
      p: mul(t.p.reduce(add), 1 / 3),
      uv: mul(t.uv.reduce(add), 1 / 3),
    });
    for (const sample of points) {
      let found = false,
        bestUV = Infinity,
        bestWorld = Infinity;
      for (const z of b) {
        const v0 = sub(z.p[1], z.p[0]),
          v1 = sub(z.p[2], z.p[0]),
          v2 = sub(sample.p, z.p[0]),
          n = cross(v0, v1);
        if (dot(normal, n) / (len(normal) * len(n)) < 0.99999) continue;
        const d00 = dot(v0, v0),
          d01 = dot(v0, v1),
          d11 = dot(v1, v1),
          den = d00 * d11 - d01 * d01;
        if (Math.abs(den) < 1e-20) continue;
        const [x, y, zv] = closest(sample.p, ...z.p);
        const pw = add(add(mul(z.p[0], x), mul(z.p[1], y)), mul(z.p[2], zv)),
          pu = add(add(mul(z.uv[0], x), mul(z.uv[1], y)), mul(z.uv[2], zv)),
          ew = len(sub(pw, sample.p)),
          eu = Math.max(...pu.map((v, i) => Math.abs(v - sample.uv[i])));
        if (ew > tol) continue;
        bestWorld = Math.min(bestWorld, ew);
        bestUV = Math.min(bestUV, eu);
        if (!uv || eu <= 2e-6) {
          maxWorld = Math.max(maxWorld, ew);
          maxUV = Math.max(maxUV, eu);
          found = true;
          break;
        }
      }
      if (!found) unmatched.push({ ...sample, bestWorld, bestUV });
    }
  }
  return {
    passed: !unmatched.length,
    maxWorld,
    maxUV,
    unmatchedCount: unmatched.length,
    firstUnmatched: unmatched[0],
  };
}

const transport = {};
for (const label of ["export_fbx", "export_glb", "glb_only"]) {
  assert.deepEqual(
    Object.keys(q[label].objects)
      .filter((name) => q[label].objects[name].type === "MESH")
      .sort(),
    Object.keys(q.export.objects)
      .filter((name) => q.export.objects[name].type === "MESH")
      .sort(),
    label + " mesh names/count differ",
  );
  const meshes = {};
  for (const name of Object.keys(q.export.objects)) {
    if (q.export.objects[name].type !== "MESH") continue;
    assert(q[label].objects[name], label + " missing " + name);
    const a = tris("export", 1, name),
      b = tris(label, 0, name),
      oldA = tris("export", 0, name),
      oldB = tris(label, 1, name);
    assert.equal(
      a.length,
      b.length,
      label + "/" + name + " triangle count differs",
    );
    assert.equal(
      q[label].objects[name].uv.length,
      q.export.objects[name].uv.length,
    );
    const forward = compare(a, b),
      reverse = compare(b, a),
      legacy = compare(oldA, oldB);
    assert(
      forward.passed && reverse.passed && legacy.passed,
      JSON.stringify({ label, name, forward, reverse, legacy }),
    );
    if (label === "export_fbx")
      assert.deepEqual(
        q[label].objects[name].uv.map((l) => l.name),
        ["Partsmith UV", "UVMap"],
      );
    meshes[name] = {
      forward,
      reverse,
      legacyUV1: legacy,
      triangleCounts: [a.length, b.length],
    };
  }
  transport[label] = {
    passed: true,
    meshes,
    maxWorld: Math.max(
      ...Object.values(meshes).flatMap((v) => [
        v.forward.maxWorld,
        v.reverse.maxWorld,
      ]),
    ),
    maxUV: Math.max(
      ...Object.values(meshes).flatMap((v) => [
        v.forward.maxUV,
        v.reverse.maxUV,
      ]),
    ),
    triangles: Object.values(q[label].objects).reduce(
      (n, o) => n + (o.triangles?.length || 0),
      0,
    ),
  };
}
const actualTriangles = {};
for (const label of ["export_fbx", "export_glb", "glb_only"]) {
  const meshes = {};
  for (const [name, o] of Object.entries(q.export.objects)) {
    if (o.type !== "MESH") continue;
    const forward = compare(o.triangles, q[label].objects[name].triangles),
      reverse = compare(q[label].objects[name].triangles, o.triangles);
    assert.equal(o.triangles.length, q[label].objects[name].triangles.length);
    assert(
      forward.passed && reverse.passed,
      JSON.stringify({ label, name, forward, reverse }),
    );
    meshes[name] = {
      forward,
      reverse,
      triangles: [o.triangles.length, q[label].objects[name].triangles.length],
    };
  }
  actualTriangles[label] = {
    passed: true,
    meshes,
    maxWorld: Math.max(
      ...Object.values(meshes).flatMap((v) => [
        v.forward.maxWorld,
        v.reverse.maxWorld,
      ]),
    ),
    maxUV: Math.max(
      ...Object.values(meshes).flatMap((v) => [
        v.forward.maxUV,
        v.reverse.maxUV,
      ]),
    ),
  };
}
const clean = (label) =>
  Object.fromEntries(
    Object.entries(q[label].objects).map(([k, v]) => [
      k,
      Object.fromEntries(Object.entries(v).filter(([k]) => k !== "triangles")),
    ]),
  );
assert.deepEqual(clean("material"), clean("export"));
assert.deepEqual(clean("material"), clean("glb_only_native"));
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4),
  expected = [1, linear(128 / 255), 0, 1];
for (const label of [
  "material",
  "export",
  "glb_only_native",
  "export_fbx",
  "export_glb",
  "glb_only",
])
  for (const o of Object.values(q[label].objects))
    for (const mat of o.materials || []) {
      assert.equal(mat.principled.length, 1);
      const s = mat.principled[0];
      assert(
        Math.max(...s["Base Color"].map((x, i) => Math.abs(x - expected[i]))) <
          2e-6,
      );
      for (const [k, v] of [
        ["Roughness", 0.2],
        ["Metallic", 0],
        ["Alpha", 1],
      ])
        assert(Math.abs(s[k] - v) < 2e-6);
      assert(
        Math.max(
          ...s["Emission Color"]
            .slice(0, 3)
            .map((v) => Math.abs(v * s["Emission Strength"])),
        ) < 2e-6,
      );
    }
const sha = (p) =>
  crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
for (const f of [...m.protectedFiles, ...m.entries])
  assert.equal(sha(f.path), f.sha256);
const report = {
  status: "PASS_DOUBLE_PRECISION_RAW_ANALYSIS",
  scope:
    "Offline independent double-precision per-mesh actual calc_loop_triangles world/UV0 pairing in both directions. Polygon-fan reconstruction separately checks retained UV1; no cross-object surface matching.",
  transport,
  actualCalcLoopTriangles: actualTriangles,
  tolerance: { world: tol, uv: 2e-6, changed: false },
  nativeChecks: {
    materialToBothNative: "EXACT geometry/TRS/UV/material",
    materialToGlbOnlyNative: "EXACT geometry/TRS/UV/material",
    specifiedShader: "PASS all native/FBX/GLB shader semantics",
    allUVSets:
      "PASS selected PartsmithUV -> UV0, original UVMap -> UV1; explicit layer names preserved by FBX, GLB coordinate sets preserve numerical correspondence",
  },
  sourcePreservation: {
    protectedFiles: m.protectedFiles.length,
    entries: m.entries.length,
    allShaExact: true,
    workspacePolicy:
      "Root v2 preflight verified all prior records deepEqual then froze current workspace SHA after two approved app exports.",
  },
  nativeAccounting: m.nativeAccounting ?? {
    rootProcesses: 2,
    preflightOnlyAborted: 1,
    readOnlyBatchWithSnapshots: 1,
    newProcessesInThisAnalysis: 0,
  },
  paid: 0,
  productionGPT: 0,
  arpAI: 0,
  productEdits: 0,
  limitations: [
    "Static untextured local chest and constant material; no character rig, hinge animation, Unity import or artistic quality acceptance.",
    "No raw snapshot or original Blender log is rewritten. Thin-triangle FP32 demonstration is illustrative, not bit-identical mathutils replay.",
  ],
};
fs.writeFileSync(dir + "/double-audit.json", JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      status: report.status,
      actualCalcLoopTriangles: Object.fromEntries(
        Object.entries(actualTriangles).map(([k, v]) => [
          k,
          { passed: v.passed, maxWorld: v.maxWorld, maxUV: v.maxUV },
        ]),
      ),
      summary: Object.fromEntries(
        Object.entries(transport).map(([k, v]) => [
          k,
          {
            passed: v.passed,
            maxWorld: v.maxWorld,
            maxUV: v.maxUV,
            triangles: v.triangles,
          },
        ]),
      ),
      sourcePreservation: report.sourcePreservation,
    },
    null,
    2,
  ),
);

{
  const source = q.export.objects["Chest band"].triangles[0],
    target = q.export_fbx.objects["Chest band"].triangles[0];
  const point = [0, 1, 2].map(
      (k) => source.p.reduce((n, p) => n + p[k], 0) / 3,
    ),
    expected = [0, 1].map((k) => source.uv.reduce((n, p) => n + p[k], 0) / 3);
  function bary(f) {
    const sub = (a, b) => a.map((x, i) => f(x - b[i])),
      dot = (a, b) => f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2])),
      a = target.p[0].map(f),
      v0 = sub(target.p[1].map(f), a),
      v1 = sub(target.p[2].map(f), a),
      v2 = sub(point.map(f), a),
      d00 = dot(v0, v0),
      d01 = dot(v0, v1),
      d11 = dot(v1, v1),
      d20 = dot(v2, v0),
      d21 = dot(v2, v1),
      den = f(f(d00 * d11) - f(d01 * d01)),
      y = f(f(f(d11 * d20) - f(d01 * d21)) / den),
      z = f(f(f(d00 * d21) - f(d01 * d20)) / den),
      x = f(f(1 - y) - z),
      uv = [0, 1].map(
        (k) => target.uv[0][k] * x + target.uv[1][k] * y + target.uv[2][k] * z,
      );
    return {
      denominator: den,
      barycentric: [x, y, z],
      uv,
      maxUVError: Math.max(...uv.map((x, i) => Math.abs(x - expected[i]))),
    };
  }
  const diagnosis = {
    object: "Chest band",
    triangleIndex: 0,
    sourcePoint: point,
    expectedUV: expected,
    targetUVs: target.uv,
    sourceUVs: source.uv,
    double: bary((x) => x),
    float32Emulation: bary(Math.fround),
    interpretation:
      "Exact matching source/FBX corner UVs. Float32 dot-product subtraction on this long thin triangle amplifies cancellation; double precision removes the artificial UV interpolation failure. Emulation is illustrative, not a claim of bit-identical mathutils execution.",
    worldTolerance: Math.max(
      (q.export.bounds.max[2] - q.export.bounds.min[2]) * 2e-6,
      1e-7,
    ),
    uvTolerance: 2e-6,
  };
  fs.writeFileSync(
    dir + "/thin-triangle-double-audit.json",
    JSON.stringify(diagnosis, null, 2),
  );
  report.diagnosis = diagnosis;
  fs.writeFileSync(dir + "/double-audit.json", JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      thinTriangle: diagnosis.object,
      doubleUVError: diagnosis.double.maxUVError,
      float32IllustrativeUVError: diagnosis.float32Emulation.maxUVError,
    }),
  );
}
