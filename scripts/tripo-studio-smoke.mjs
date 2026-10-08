import { _electron as electron } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import initSqlJs from "sql.js";

// Real Electron/IPC/SQLite smoke. Only review quotes: never approve or submit.
const root = process.cwd();
const packaged = Boolean(process.env.PARTSMITH_EXE);
const suffix = packaged ? "packaged" : "development";
const data = path.join(
  root,
  "artifacts/runtime/tripo-studio-smoke",
  `${suffix}-${randomUUID()}`,
);
const shots = path.join(root, "artifacts/screenshots");
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
const SQL = await initSqlJs({
  locateFile: () => path.join(root, "node_modules/sql.js/dist/sql-wasm.wasm"),
});
const errors = [],
  checks = [],
  quotes = [];
let app, page;
const launch = async (directory) => {
  app = await electron.launch({
    executablePath: process.env.PARTSMITH_EXE
      ? path.resolve(process.env.PARTSMITH_EXE)
      : electronPath,
    ...(packaged ? {} : { args: ["."] }),
    env: { ...process.env, PARTSMITH_DATA: directory },
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.waitForSelector(".home");
};
const call = (command) =>
  page.evaluate((command) => window.desktop.call(command), command);
const picker = (file) =>
  app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, file);
const stateProject = async (id) =>
  (await call({ type: "state" })).projects.find((p) => p.id === id);
const field = (name) =>
  page.locator(
    `[aria-label=${JSON.stringify(name)}], label.field:has(> span:text-is(${JSON.stringify(name)})) :is(select,input,textarea)`,
  );
const tab = (name) =>
  page
    .getByRole("navigation", { name: "Tripo 기능" })
    .getByRole("button", { name, exact: true })
    .click();
const lastQuote = () => {
  const db = new SQL.Database(fs.readFileSync(path.join(data, "workbench.db")));
  try {
    return JSON.parse(
      db.exec(
        "SELECT json FROM records WHERE kind='quote' ORDER BY rowid DESC LIMIT 1",
      )[0].values[0][0],
    );
  } finally {
    db.close();
  }
};
const review = async (expected, button = page.locator(".studio-submit")) => {
  await button.click();
  const modal = page.getByRole("dialog");
  await modal.waitFor();
  const q = lastQuote();
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(q.request[key], value, `${key} in reviewed request`);
  assert.equal(q.consumed, false);
  assert.equal(
    await modal.locator("button.primary").isDisabled(),
    true,
    "No key: execution must remain disabled",
  );
  quotes.push({
    kind: q.request.kind,
    request: q.request,
    consumed: q.consumed,
  });
  await modal.locator(".section-title button").click();
  await modal.waitFor({ state: "hidden" });
  return q;
};

try {
  await launch(data);
  const info = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    isPackaged: app.isPackaged,
  }));
  assert.equal(info.version, "0.2.0");
  assert.equal(info.isPackaged, packaged);
  assert.equal((await call({ type: "state" })).key.configured, false);
  assert.deepEqual(
    await page.evaluate(() => ({
      node: typeof window.require,
      process: typeof window.process,
    })),
    { node: "undefined", process: "undefined" },
  );
  await page.getByRole("button", { name: "새 프로젝트", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("textbox")
    .fill("Tripo 작업실 UI 검증");
  await page.getByRole("button", { name: "프로젝트 만들기" }).click();
  await page.waitForSelector(".studio");
  let p = (await call({ type: "state" })).projects[0];
  const projectId = p.id;
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#aecab7";
    ctx.fillRect(0, 0, 512, 512);
    ctx.fillStyle = "#34423b";
    ctx.fillRect(176, 96, 160, 340);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const imageIds = [];
  for (const name of ["front", "back"]) {
    const file = path.join(data, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(png, "base64"));
    await picker(file);
    await page
      .getByRole("button", { name: "이미지 가져오기", exact: true })
      .click();
    await page.waitForFunction(
      async ({ id, count }) =>
        (await window.desktop.call({ type: "state" })).projects.find(
          (p) => p.id === id,
        ).assets.length === count,
      { id: projectId, count: imageIds.length + 1 },
    );
    p = await stateProject(projectId);
    imageIds.push(p.assets.at(-1).id);
  }
  await field("AI 모델").evaluate((el) => {
    if (el.value !== "P2-20260801") throw new Error("P2 must be the default");
  });
  await field("토폴로지").selectOption("quad");
  await field("생성 개수").selectOption("4");
  await review({
    kind: "model",
    model: "P2-20260801",
    inputMode: "image",
    quad: true,
    count: 4,
    faceLimit: 12000,
    exportUv: true,
    texture: true,
    pbr: true,
    textureQuality: "standard",
    textureVersion: "v3.5-20260815",
  });
  await page.screenshot({
    path: path.join(shots, `tripo-${suffix}-model.png`),
  });
  await field("입력 방식").selectOption("text");
  await field("모델 설명").fill("Stylized game character, T pose");
  await review({
    kind: "model",
    inputMode: "text",
    prompt: "Stylized game character, T pose",
    sourceId: undefined,
  });
  await field("입력 방식").selectOption("multiview");
  await field("정면 (필수)").selectOption(imageIds[0]);
  await field("뒷면").selectOption(imageIds[1]);
  await review({
    inputMode: "multiview",
    sourceIds: [imageIds[0], "", imageIds[1], ""],
  });
  await field("AI 모델").selectOption("v3.1-20260211");
  await review({
    model: "v3.1-20260211",
    exportUv: undefined,
    quad: undefined,
  });
  checks.push(
    "P2 default, image/text/multiview quotes, count4, quad and HD option separation",
  );

  assert(
    fs.existsSync(path.join(root, "artifacts/fbx-preview-smoke.json")),
    "Missing local fixture: run npx tsx scripts/fbx-preview-smoke.ts first",
  );
  const previewEvidence = JSON.parse(
    fs.readFileSync(
      path.join(root, "artifacts/fbx-preview-smoke.json"),
      "utf8",
    ),
  );
  const fixtureRoot = path.join(
    root,
    "artifacts/runtime/fbx-preview-smoke/projects",
    previewEvidence.projectId,
  );
  const fixtureGlb = path.join(fixtureRoot, previewEvidence.preview);
  const fixtureFbx = path.join(fixtureRoot, "assets/native-demo.fbx");
  assert(
    fs.existsSync(fixtureGlb) && fs.existsSync(fixtureFbx),
    "Missing local fixture files: run npx tsx scripts/fbx-preview-smoke.ts first",
  );
  await tab("분할");
  await picker(fixtureGlb);
  await page
    .locator(".studio-controls")
    .getByRole("button", { name: "GLB 가져오기", exact: true })
    .click();
  await page.waitForSelector(".playback");
  await page
    .locator(".playback select")
    .selectOption({ label: "CharacterRig|Walk" });
  p = await stateProject(projectId);
  const model = p.assets.find((a) => a.kind === "model");
  assert(model);
  assert.equal(await page.locator(".studio-preview canvas").count(), 1);
  checks.push("Actual local FBX-derived GLB rendered with Idle/Walk clips");
  await review({
    kind: "segment",
    model: "v2.0-20260430",
    sourceId: model.id,
    segmentationGranularity: "balanced",
    splitByConnectivity: true,
  });
  await field("분할 작업").selectOption("smartsegment");
  await field("분할 힌트 (선택)").fill("head, hair, body");
  await review({
    kind: "smartsegment",
    segType: "model",
    sourceId: model.id,
    prompt: "head, hair, body",
    smartGranularity: "medium",
  });
  await field("스마트 분할 입력").selectOption("image");
  await review({
    kind: "smartsegment",
    segType: "image",
    sourceId: imageIds[1],
  });
  await field("분할 작업").selectOption("complete");
  await page.locator(".studio-submit").click();
  await page
    .getByRole("alert")
    .filter({ hasText: "성공한 Tripo 분할" })
    .waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  checks.push(
    "Segmentation and Smart Segmentation quotes; completion requires real prior task",
  );

  await tab("리토폴로지");
  await field("리토폴로지 목표 폴리곤").fill("6000");
  await review({
    kind: "retopology",
    model: "v2.0",
    faceLimit: 6000,
    bake: true,
    quad: false,
  });
  await field("리토폴로지 AI 모델").selectOption("v1.0");
  await review({ kind: "retopology", model: "v1.0", bake: undefined });
  await tab("Smart UV");
  await field("텍스처 크기").selectOption("4096");
  await review({
    kind: "uv-pack",
    format: "GLTF",
    textureSize: 4096,
    bake: true,
  });
  await page.screenshot({ path: path.join(shots, `tripo-${suffix}-uv.png`) });
  await tab("텍스처");
  await field("텍스처 설명 (선택)").fill("Painted leather, green cloth");
  await review({
    kind: "texture",
    model: "v3.5-20260815",
    prompt: "Painted leather, green cloth",
    pbr: true,
    textureQuality: "standard",
  });
  await field("텍스처 참조 이미지 (선택)").selectOption(imageIds[0]);
  await review({ kind: "texture", prompt: "", sourceIds: [imageIds[0]] });
  await tab("리깅");
  await review(
    { kind: "rig-check", sourceId: model.id },
    page.getByRole("button", { name: "1. 무료 적합성 검사 검토" }),
  );
  assert.equal(
    await page
      .getByRole("button", { name: "2. 자동 리깅 요청 검토" })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "3. 애니메이션 요청 검토" })
      .isDisabled(),
    true,
  );
  checks.push(
    "Retopology v1/v2, Tripo UV pack, texture text/reference, free rig-check quotes; paid rig and animation gated",
  );

  await page.getByText("Tripo에서 파일 형식 변환", { exact: true }).click();
  await field("Tripo 출력 형식").selectOption("FBX");
  await review(
    { kind: "convert", format: "FBX", sourceId: model.id },
    page.getByRole("button", { name: "변환 요청 검토", exact: true }),
  );
  await page.getByRole("button", { name: "파츠에 적용", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "파츠에 모델" }).waitFor();
  p = await stateProject(projectId);
  assert.equal(p.parts[0].selectedId, model.id);
  await call({
    type: "part.update",
    id: projectId,
    partId: p.parts[0].id,
    patch: { locked: true },
  });
  await assert.rejects(
    call({
      type: "part.assign",
      id: projectId,
      partId: p.parts[0].id,
      assetId: model.id,
    }),
    /고정/,
  );
  await page.reload();
  await page.waitForSelector(".home");
  await page
    .getByRole("button")
    .filter({
      has: page.getByRole("heading", {
        name: "Tripo 작업실 UI 검증",
        exact: true,
      }),
    })
    .click();
  await page.waitForSelector(".studio");
  assert.equal(
    await page
      .getByRole("button", { name: "파츠에 적용", exact: true })
      .isDisabled(),
    true,
  );
  checks.push(
    "Part assignment changes selected model; locked part blocked in IPC and UI",
  );
  p = await stateProject(projectId);
  assert.equal(p.jobs.length, 0);
  assert.equal((await call({ type: "state" })).key.configured, false);

  // Exercise nativeFile restoration using a clearly local fixture backup.
  const backup = path.join(data, "fixture-backup");
  fs.mkdirSync(backup);
  fs.cpSync(path.join(data, "projects", projectId), backup, {
    recursive: true,
  });
  p.assets.find((a) => a.id === model.id).nativeFile =
    "assets/native-fixture.fbx";
  p.assets.find((a) => a.id === model.id).format = "fbx";
  fs.copyFileSync(fixtureFbx, path.join(backup, "assets/native-fixture.fbx"));
  fs.writeFileSync(path.join(backup, "project.json"), JSON.stringify(p));
  await app.close();
  app = undefined;
  const reopened = path.join(data, "restored");
  await launch(reopened);
  await picker(path.join(backup, "project.json"));
  await call({ type: "project.open" });
  const restored = await stateProject(projectId);
  const native = restored.assets.find((a) => a.id === model.id).nativeFile;
  const hash = (file) =>
    createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  assert.equal(
    hash(path.join(reopened, "projects", projectId, native)),
    hash(fixtureFbx),
  );
  await page.reload();
  await page.waitForSelector(".home");
  await page
    .getByRole("button")
    .filter({
      has: page.getByRole("heading", {
        name: "Tripo 작업실 UI 검증",
        exact: true,
      }),
    })
    .click();
  await page.waitForSelector(".playback");
  await page.screenshot({
    path: path.join(shots, `tripo-${suffix}-native-restored.png`),
  });
  checks.push(
    "Backup restoration retains native FBX SHA and loads derived GLB preview",
  );
  assert.equal(restored.jobs.length, 0);
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(root, `artifacts/tripo-studio-smoke-${suffix}.json`),
    JSON.stringify(
      {
        passed: true,
        ...info,
        checks,
        quoteCount: quotes.length,
        quotes,
        approvals: 0,
        generatedJobs: 0,
        keyConfigured: false,
        paidRequests: 0,
        fixture: "local Blender demo only; no Tripo output",
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    `Tripo Studio ${suffix} UI smoke passed (${quotes.length} unsubmitted quotes).`,
  );
} catch (error) {
  if (page && !page.isClosed())
    await page
      .screenshot({ path: path.join(shots, `tripo-${suffix}-failure.png`) })
      .catch(() => {});
  fs.writeFileSync(
    path.join(root, `artifacts/tripo-studio-smoke-${suffix}.json`),
    JSON.stringify(
      { passed: false, checks, quotes, errors, failure: String(error) },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (app) await app.close();
}
