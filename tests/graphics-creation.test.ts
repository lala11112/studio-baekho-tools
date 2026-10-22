import test from "node:test";
import assert from "node:assert/strict";
import type { GraphicsKind, GraphicsObject } from "../shared/graphics";
import {
  compileCreation,
  creationSettings,
  creationTaskId,
  defaultCreation,
  effectiveCreation,
  humanParts,
  validateCreation,
  type CreationSpec,
} from "../shared/graphics-creation";

function object(kind: GraphicsKind = "prop"): GraphicsObject {
  return {
    id: "fixture",
    name: "Fixture",
    kind,
    createdAt: "2026-10-13",
    selectedTasks: [],
    instruction: "",
    settings: {},
    references: [],
    accepted: {},
    creation: defaultCreation(kind),
  };
}

test("image/model/texture counts and instructions remain independent when switching creation stages", () => {
  const o = object(),
    c = o.creation!;
  c.stageSettings.design!.values.count = 4;
  c.stageSettings.design!.instruction = "정면 이미지 요청";
  c.stageSettings.model!.values.count = 2;
  c.stageSettings.model!.values.faceLimit = 5000;
  c.stageSettings.model!.instruction = "모델 지시";
  c.stageSettings.surface!.values.count = 3;
  c.stageSettings.surface!.values.textureSize = 8192;
  c.stageSettings.surface!.instruction = "녹슨 금속 텍스처";
  const before = structuredClone(o);
  const design = compileCreation(o, "I01"),
    model = compileCreation(o, "M01"),
    surface = compileCreation(o, "T03");
  assert.equal(design.settings.count, 4);
  assert.equal(model.settings.count, 2);
  assert.equal(surface.settings.count, 3);
  assert.equal(model.settings.faceLimit, 5000);
  assert.equal(surface.settings.textureSize, 8192);
  assert.match(design.instruction, /정면 이미지 요청/);
  assert.doesNotMatch(design.instruction, /모델 지시|녹슨 금속/);
  assert.match(model.instruction, /모델 지시/);
  assert.doesNotMatch(model.instruction, /정면 이미지 요청|녹슨 금속/);
  assert.match(surface.instruction, /녹슨 금속/);
  assert.doesNotMatch(surface.instruction, /정면 이미지 요청|모델 지시/);
  assert.equal(design.settings.textureSize, undefined);
  assert.equal(surface.settings.faceLimit, undefined);
  assert.deepEqual(o, before);
});

test("selecting the human three-part recipe does not turn first I01/I02 designs into head-only images", () => {
  const o = object("character"),
    c = o.creation!;
  c.attributes.composition = "parts";
  c.parts = humanParts();
  c.activePartId = "head";
  c.stageSettings.design!.values.count = 2;
  c.parts[0].count = 4;
  for (const taskId of ["I01", "I02"]) {
    const result = compileCreation(o, taskId);
    assert.equal(result.settings.partId, undefined);
    assert.equal(result.settings.partLabel, undefined);
    assert.doesNotMatch(
      result.instruction,
      /제작 대상 파츠만|다른 파츠는 생성하지/,
    );
    assert.equal(result.settings.count, 2);
    assert.equal(result.settings.direction, "front");
    assert.equal(result.settings.pose, "a");
    assert.equal(result.settings.multiview, false);
    assert.deepEqual(
      JSON.parse(String(result.settings.requestedParts)).map(
        (part: { id: string }) => part.id,
      ),
      ["head", "body", "hair"],
    );
  }
});

test("I08 targets the selected part while model count and polygon budget use that part's own settings", () => {
  const o = object("character"),
    c = o.creation!;
  c.attributes.composition = "parts";
  c.parts = humanParts();
  c.activePartId = "body";
  c.parts[1].instruction = "긴 코트를 포함한 몸통";
  c.parts[1].faceLimit = 12000;
  c.parts[1].count = 2;
  c.stageSettings.design!.values.count = 3;
  c.stageSettings.model!.values.count = 4;
  const image = compileCreation(o, "I08"),
    model = compileCreation(o, "M01"),
    texture = compileCreation(o, "T03");
  assert.equal(image.settings.partId, "body");
  assert.equal(image.settings.count, 3);
  assert.match(image.instruction, /제작 대상 파츠만: 몸통/);
  assert.match(image.instruction, /긴 코트를/);
  assert.equal(model.settings.partId, "body");
  assert.equal(model.settings.count, 2);
  assert.equal(model.settings.faceLimit, 12000);
  assert.equal(texture.settings.partId, "body");
  assert.equal(texture.settings.count, 1);
  assert.equal(compileCreation(o, "M08").settings.partId, undefined);
});

test("animation and Unity choices survive saved-spec round trips without leaking into other stages", () => {
  const o = object("character"),
    c = o.creation!;
  Object.assign(c.stageSettings.animation!.values, {
    clipName: "토끼 점프 | v2.0",
    motionPreset: "jump",
    duration: 3.25,
    fps: 60,
    loop: false,
    rootMotion: true,
    animationMode: "reference",
    motionSourcePath: "original/side.png",
  });
  c.stageSettings.animation!.instruction = "착지 후 귀가 한 번 흔들림";
  Object.assign(c.stageSettings.unity!.values, {
    collider: "convex",
    lodEnabled: true,
    lodRatio: 0.4,
    deliveryTextureSize: 2048,
    deliveryCompression: "normal",
    scale: 1.2,
  });
  const saved = JSON.parse(JSON.stringify(o)) as GraphicsObject;
  assert.equal(creationTaskId(saved.creation!, "animation"), "N04");
  const animation = compileCreation(saved, "N04"),
    unity = compileCreation(saved, "X05");
  assert.equal(animation.settings.clipName, "토끼 점프 | v2.0");
  assert.equal(animation.settings.fps, 60);
  assert.equal(animation.settings.duration, 3.25);
  assert.match(animation.instruction, /동작: jump, 이동 동작, 단발/);
  assert.match(animation.instruction, /착지 후 귀/);
  assert.equal(unity.settings.collider, "convex");
  assert.equal(unity.settings.lodRatio, 0.4);
  assert.equal(unity.settings.deliveryTextureSize, 2048);
  assert.equal(unity.settings.clipName, undefined);
  assert.equal(animation.settings.deliveryCompression, undefined);
  assert.deepEqual(
    creationSettings(saved, "unity"),
    c.stageSettings.unity!.values,
  );
});

test("creation validation rejects malformed counts, nonfinite settings and unavailable part identities", () => {
  const check = (change: (c: CreationSpec) => void, error: RegExp) => {
    const c = defaultCreation("character");
    change(c);
    assert.throws(() => validateCreation(c, "character"), error);
  };
  for (const count of [0, -1, 1.5, 5])
    check((c) => {
      c.stageSettings.design!.values.count = count;
    }, /후보 수/);
  check((c) => {
    c.subject = "rock";
  }, /대상 종류/);
  check((c) => {
    c.locks = ["invented-lock"];
  }, /잠금/);
  check((c) => {
    c.stageSettings.model!.values.faceLimit = Number.NaN;
  }, /옵션 값/);
  check((c) => {
    c.parts = humanParts();
    c.parts.push({ ...c.parts[0] });
  }, /파츠/);
  check((c) => {
    c.parts = humanParts();
    c.parts[0].enabled = false;
    c.activePartId = "head";
  }, /현재 파츠/);
  check((c) => {
    c.activePartId = "missing";
  }, /현재 파츠/);
  check((c) => {
    c.parts = [{ ...humanParts()[0], id: "../../escape" }];
  }, /파츠/);
  check((c) => {
    c.instruction = "가".repeat(12001);
  }, /12,000/);
});

test("legacy migration reads settings without rewriting accepted results or the original object", () => {
  const o = object("weapon");
  delete o.creation;
  o.instruction = "원래 대검 외형";
  o.settings = {
    count: 3,
    faceLimit: 7500,
    textureSize: 8192,
    clipName: "검 꺼내기",
    motionSourcePath: "saved/side.png",
    leftVersionId: "left-original",
    rigHair: true,
  };
  o.accepted = {
    "design:main": "original",
    "animation:검 꺼내기": "old-motion",
  };
  o.references = [{ versionId: "character", role: "style" }];
  const before = structuredClone(o),
    c = effectiveCreation(o);
  assert.equal(c.instruction, "원래 대검 외형");
  assert.equal(c.stageSettings.design!.values.count, 3);
  assert.equal(c.stageSettings.model!.values.count, 3);
  assert.equal(c.stageSettings.surface!.values.count, 1);
  assert.equal(c.stageSettings.surface!.values.textureSize, 8192);
  assert.equal(c.stageSettings.model!.values.leftVersionId, "left-original");
  assert.equal(
    c.stageSettings.animation!.values.motionSourcePath,
    "saved/side.png",
  );
  assert.equal(c.stageSettings.rig!.values.rigHair, true);
  assert.deepEqual(o, before);
  c.stageSettings.model!.values.count = 1;
  c.instruction = "new";
  assert.deepEqual(o, before);
});

test("custom descriptions and fixed features compile from saved choices without mutating the spec", () => {
  const o = object();
  const c = o.creation!;
  c.subject = "rock";
  c.attributes.surface = "rugged";
  c.attributes["custom.top"] = "윗면만 평평하게";
  c.locks = ["color", "topology"];
  const before = structuredClone(c),
    result = compileCreation(o, "M05");
  assert.equal(result.settings["attr.surface"], "rugged");
  assert.equal(result.settings["lock.color"], true);
  assert.match(result.instruction, /울퉁불퉁/);
  assert.match(result.instruction, /윗면만 평평하게/);
  assert.match(result.instruction, /유지할 특징: 색, 메시 구조/);
  result.spec.attributes.surface = "smooth";
  assert.deepEqual(o.creation, before);
});
