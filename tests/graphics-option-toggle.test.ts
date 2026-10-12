import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../engine/store";
import { Engine } from "../engine/engine";
import { GraphicsEngine } from "../engine/graphics";
import type { Tripo } from "../engine/tripo";
import type { GraphicsObject } from "../shared/graphics";
import {
  compileCreation,
  creationSelectionProblem,
  creationSettings,
  creationTaskId,
  defaultCreation,
  effectiveCreation,
  toggleCreationChoice,
  validateCreation,
  type CreationStage,
} from "../shared/graphics-creation";

const object = (): GraphicsObject => ({
  id: "target",
  name: "Toggle fixture",
  kind: "prop",
  createdAt: "",
  selectedTasks: [],
  instruction: "",
  settings: {},
  references: [],
  accepted: {},
  creation: defaultCreation("prop"),
});

test("cleared optional choices persist without default prompt or frozen settings restoration", () => {
  const source = object(),
    spec = source.creation!;
  spec.attributes.style = toggleCreationChoice(
    spec.attributes.style,
    "stylized",
  );
  spec.attributes.mood = toggleCreationChoice("cute", "cute");
  for (const key of [
    "direction",
    "framing",
    "pose",
    "background",
    "perspective",
    "margin",
  ])
    spec.stageSettings.design!.values[key] = "";
  spec.stageSettings.animation!.values.motionPreset = "";
  spec.stageSettings.animation!.instruction = "상체를 천천히 기울임";
  const saved = JSON.parse(JSON.stringify(source)) as GraphicsObject;
  assert.equal(
    validateCreation(saved.creation!, saved.kind).attributes.style,
    "",
  );
  assert.equal(effectiveCreation(saved).attributes.style, "");
  assert.equal(creationSettings(saved, "design").direction, "");
  const image = compileCreation(saved, "I01");
  assert.equal(image.settings["attr.style"], undefined);
  assert.equal(image.settings["attr.mood"], undefined);
  assert.equal(image.settings.direction, undefined);
  assert.doesNotMatch(
    image.instruction,
    /스타일화|귀여움|direction:|framing:|pose:|background:|perspective:|margin:/,
  );
  const animation = compileCreation(saved, "N05");
  assert.equal(animation.settings.motionPreset, undefined);
  assert.doesNotMatch(animation.instruction, /idle|동작:/);
  assert.match(animation.instruction, /상체를 천천히 기울임/);
  assert.equal(toggleCreationChoice("", "stylized"), "stylized");
  assert.equal(toggleCreationChoice("stylized", "anime"), "anime");
  assert.equal(toggleCreationChoice(10000, "10000"), "");
});

test("explicitly cleared required choices can be saved but fail before request compilation", async (t) => {
  const cases: [CreationStage, string, string, string?][] = [
    ["design", "designMode", "I01"],
    ["model", "modelMethod", "M01"],
    ["model", "inputMode", "M01"],
    ["model", "faceLimit", "M01"],
    ["surface", "surfaceOperation", "T03"],
    ["surface", "textureMode", "T03"],
    ["surface", "textureReference", "T03"],
    ["surface", "uvMode", "T02", "uv"],
    ["assembly", "assemblyMode", "M05"],
    ["rig", "rigType", "R02"],
    ["animation", "animationMode", "N05"],
    ["unity", "deliveryMode", "X05"],
    ["unity", "collider", "X05"],
    ["unity", "deliveryCompression", "X05"],
  ];
  for (const [stage, key, taskId, mode] of cases)
    await t.test(`${stage}/${key}`, () => {
      const value = object();
      if (mode)
        value.creation!.stageSettings[stage]!.values.surfaceOperation = mode;
      value.creation!.stageSettings[stage]!.values[key] = "";
      assert.doesNotThrow(() => validateCreation(value.creation!, value.kind));
      assert.match(creationSelectionProblem(value.creation!, stage)!, /선택/);
      assert.throws(() => compileCreation(value, taskId), /선택/);
    });
  const value = object();
  value.creation!.attributes.composition = "";
  assert.throws(() => compileCreation(value, "I01"), /모델 구성/);
  value.creation!.stageSettings.design!.values.designMode = "";
  assert.equal(
    creationTaskId(value.creation!, "design"),
    "",
    "clearing a route must not select the default task",
  );
  assert.equal(creationTaskId(defaultCreation("prop"), "design"), "I01");
});

test("saved deselections survive Store restart and incomplete preparation creates no task or service request", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "graphics-option-toggle-"),
  );
  const wasm = path.resolve("node_modules/sql.js/dist/sql-wasm.wasm");
  let store = new Store(root);
  await store.open(wasm);
  let calls = 0;
  const forbidden = async () => {
    calls++;
    throw Error("No native or API execution is authorized in this test");
  };
  const tripo = {
    balance: forbidden,
    upload: forbidden,
    submit: forbidden,
    task: forbidden,
    download: forbidden,
  } as unknown as Tripo;
  let engine = new Engine(store, tripo);
  const project = engine.create("Option toggle persistence");
  let graphics = new GraphicsEngine(store, engine, {
    resources: path.resolve("integrations"),
    native: forbidden,
  });
  t.after(() => {
    graphics.shutdown();
    store.db.close();
    const actual = fs.realpathSync(root);
    assert.equal(path.dirname(actual), fs.realpathSync(os.tmpdir()));
    assert(path.basename(actual).startsWith("graphics-option-toggle-"));
    fs.rmSync(actual, { recursive: true, force: true });
  });
  const created = await graphics.action(project.id, {
    kind: "create-object",
    name: "Stone",
    objectKind: "prop",
  });
  const objectId = created.objects[0].id,
    creation = defaultCreation("prop");
  creation.attributes.style = "";
  creation.stageSettings.design!.values.direction = "";
  creation.stageSettings.design!.values.designMode = "";
  creation.stageSettings.model!.values.faceLimit = "";
  await graphics.action(project.id, {
    kind: "update-object",
    objectId,
    patch: { creation },
  });
  const before = graphics.get(project.id);
  await assert.rejects(
    graphics.action(project.id, { kind: "prepare", objectId, taskId: "I01" }),
    /이미지 제작 방식/,
  );
  assert.deepEqual(graphics.get(project.id), before);
  assert.equal(calls, 0);
  graphics.shutdown();
  store.db.close();
  store = new Store(root);
  await store.open(wasm);
  engine = new Engine(store, tripo);
  graphics = new GraphicsEngine(store, engine, {
    resources: path.resolve("integrations"),
    native: forbidden,
  });
  assert.deepEqual(graphics.get(project.id), before);
  assert.equal(
    creationSettings(graphics.get(project.id).objects[0], "model").faceLimit,
    "",
  );
  await assert.rejects(
    graphics.action(project.id, { kind: "prepare", objectId, taskId: "M01" }),
    /목표 면 수/,
  );
  assert.equal(graphics.get(project.id).tasks.length, 0);
  creation.stageSettings.design!.values.designMode = "new";
  await graphics.action(project.id, {
    kind: "update-object",
    objectId,
    patch: { creation },
  });
  const prepared = await graphics.action(project.id, {
    kind: "prepare",
    objectId,
    taskId: "I01",
  });
  assert.equal(prepared.tasks.length, 1);
  assert.equal(prepared.tasks[0].status, "awaiting_approval");
  assert.equal(prepared.tasks[0].settings.direction, undefined);
  assert.equal(prepared.tasks[0].settings["attr.style"], undefined);
  assert.doesNotMatch(prepared.tasks[0].instruction, /스타일화|direction:/);
  assert.equal(
    prepared.objects[0].creation!.stageSettings.design!.values.direction,
    "",
  );
  assert.equal(calls, 0);
});
