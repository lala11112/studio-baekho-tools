import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ChromeJobLedger,
  type ChromePacket,
} from "../engine/chrome-job-ledger";

test("Chrome paid journal freezes phase, source and cost; recovery cannot resubmit", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "partsmith-ledger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "host.json"),
    source = "11111111-1111-1111-1111-111111111111",
    uv = "22222222-2222-2222-2222-222222222222",
    tex = "33333333-3333-3333-3333-333333333333";
  const url = (id: string) =>
    `https://studio.tripo3d.ai/ko/workspace/${id===tex ? "texture" : "smart-uv"}/rabbit-${id}`;
  const packet: ChromePacket = {
    jobId: "job-1",
    request: {
      step: "surface",
      prompt: "rabbit",
      externalSurface: {
        observedUvCost: 20,
        observedTextureCost: 20,
        textureResolution: "4K",
        removeLighting: false,
      },
    },
    approval: { accepted: true, studioCreditLimit: 40, imageCreditLimit: 0 },
    sourceStudioModel: { modelId: source, url: url(source) },
  };
  let ledger = new ChromeJobLedger(file, packet, "hash-1");
  const begin = {
    phase: "uv",
    sourceModelId: source,
    observedCost: 20,
    url: url(source),
  };
  assert.throws(() => ledger.begin({ ...begin, phase: "texture" }), /Smart UV/);
  assert.throws(
    () => ledger.begin({ ...begin, observedCost: 21 }),
    /승인한 범위/,
  );
  assert.throws(
    () => ledger.begin({ ...begin, sourceModelId: uv }),
    /승인한 범위/,
  );
  assert.throws(
    () => ledger.begin({ ...begin, url: "https://evil.example/" }),
    /승인한 범위/,
  );
  assert.equal(ledger.read().entries.length, 0);
  assert.throws(()=>ledger.begin({...begin,url:url(source)+"?token=secret"}),/승인한 범위/);
  assert.throws(()=>ledger.begin({...begin,url:url(source).replace("smart-uv","unobserved-route")}),/승인한 범위/);
  ledger.begin(begin);
  ledger = new ChromeJobLedger(file, packet, "hash-1");
  assert.throws(() => ledger.begin(begin), /이미 예약/);
  assert.throws(() => new ChromeJobLedger(file, packet, "hash-2"), /일치하지/);
  assert.throws(() => ledger.verify({}), /기록이 부족/);
  ledger.complete({ phase: "uv", resultId: uv, url: url(uv) });
  assert.throws(() => ledger.begin(begin), /이미 예약/);
  assert.throws(
    () =>
      ledger.begin({
        phase: "texture",
        sourceModelId: source,
        observedCost: 20,
        url: url(source),
      }),
    /승인한 범위/,
  );
  ledger.begin({
    phase: "texture",
    sourceModelId: uv,
    observedCost: 20,
    url: url(uv),
  });
  ledger.complete({ phase: "texture", resultId: tex, url: url(tex) });
  assert.throws(
    () => ledger.complete({ phase: "uv", resultId: tex, url: url(tex) }),
    /바꿀 수/,
  );
  const receipt = {
    surface: {
      sourceModelId: source,
      uv: {
        sourceModelId: source,
        modelId: uv,
        url: url(uv),
        creditCost: 20,
        fbxPath: "uv.fbx",
      },
      texture: {
        sourceModelId: uv,
        modelId: tex,
        url: url(tex),
        creditCost: 20,
        fbxPath: "texture.fbx",
        texturePaths: ["color.png"],
        resolution: "4K" as const,
        removeLighting: false,
      },
    },
  };
  ledger.verify(receipt);
  receipt.surface.texture.creditCost = 19;
  assert.throws(() => ledger.verify(receipt), /호스트 제출 기록/);
  assert.equal(
    ledger.read().entries.reduce((n, e) => n + e.cost, 0),
    40,
  );
});
