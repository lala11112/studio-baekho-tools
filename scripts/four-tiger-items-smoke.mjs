import { _electron as electron } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const live = process.argv.includes("--live");
const state = live
  ? JSON.parse(fs.readFileSync(".local/four-tiger-live-state.json", "utf8"))
  : null;
const root = path.resolve(
  `artifacts/integration-runtime/items-${live ? "live-" : ""}${Date.now()}`,
);
if (state) {
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(
    path.join(state.dataRoot, "four-tiger-items"),
    path.join(root, "four-tiger-items"),
    { recursive: true, errorOnExist: true },
  );
}
const env = { ...process.env, BAEKHO_DATA: root, PARTSMITH_DATA: root };
delete env.ELECTRON_RUN_AS_NODE;
let fixtureId = null;
if (!live) {
  const seed = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import {createReviewedFixture} from './tests/fixtures/four-tiger-items.ts'; const f=await createReviewedFixture(${JSON.stringify(path.join(root, "four-tiger-items"))}); console.log(f.project.projectId);`,
    ],
    { encoding: "utf8", windowsHide: true, shell: false, env },
  );
  assert.equal(seed.status, 0, seed.stderr);
  fixtureId = seed.stdout.trim();
}
const artifact = path.resolve("artifacts/integration-runtime/item-smoke");
fs.mkdirSync(artifact, { recursive: true });
const app = await electron.launch({
  executablePath: electronPath,
  args: ["."],
  env,
  timeout: 45000,
});
const errors = [];
const checks = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByTestId("tool-four-tiger-items").click();
  await page.getByTestId("workspace-four-tiger-items").waitFor();
  if (state)
    await page
      .getByLabel("초안 묶음", { exact: true })
      .selectOption(state.projectId);
  else {
    await page.getByTestId("create-items").click();
    await page.getByTestId("item-IT_WOOD_01").waitFor();
    assert.equal(await page.locator(".fti-card").count(), 20);
    await page.getByLabel("초안 묶음", { exact: true }).selectOption(fixtureId);
  }
  await page.getByTestId("item-IT_WOOD_01").waitFor();
  assert.equal(await page.locator(".fti-card").count(), 20);
  checks.push("20 proposal cards visible");
  const name = page.getByLabel("아이템 이름", { exact: true });
  await name.fill("새싹 부적 · 흐름 검증");
  await page.getByTestId("save-item").click();
  await page.waitForFunction(
    () =>
      document.querySelector(".fti-section-title h2")?.textContent ===
      "새싹 부적 · 흐름 검증",
  );
  checks.push("edited name saved");
  await page.getByTestId("nav-home").click();
  await page.getByTestId("tool-four-tiger-items").click();
  assert.equal(await name.inputValue(), "새싹 부적 · 흐름 검증");
  checks.push("navigation retains item edit");
  const selectedId = await page
    .getByLabel("초안 묶음", { exact: true })
    .inputValue();
  async function waitProject(predicate) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const current = await page.evaluate(
        (id) => window.fourTigerItems.read({ projectId: id }),
        selectedId,
      );
      if (predicate(current)) return current;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Saved item state did not reach expected value");
  }
  if (!live) {
    await page.getByLabel("아이템 등급", { exact: true }).selectOption("2");
    assert.equal(await page.getByTestId("item-price").textContent(), "40 G");
    await page.getByLabel("아이템 등급", { exact: true }).selectOption("1");
    await page
      .getByLabel("효과 1 종류", { exact: true })
      .selectOption("normalDamage");
    await page.getByLabel("효과 1 값", { exact: true }).fill("8");
    await page
      .getByLabel("효과 1 적용 범위", { exact: true })
      .selectOption("selected");
    await page.getByLabel("효과 1 화 폼", { exact: true }).check();
    await page.getByTestId("save-item").click();
    const edited = await waitProject(
      (p) =>
        p.items[0].effects[0].amount === 0.08 &&
        Array.isArray(p.items[0].effects[0].targetForms),
    );
    assert.deepEqual(edited.items[0].effects[0].targetForms, ["wood", "fire"]);
    assert.equal(edited.items[0].descriptionStale, true);
    checks.push(
      "8% stores as 0.08, grade price derives, multiple form scopes persist",
    );
    await page.getByLabel("효과 1 종류", { exact: true }).selectOption("maxSp");
    await page.getByLabel("효과 1 값", { exact: true }).fill("10");
    await page
      .getByLabel("효과 1 적용 범위", { exact: true })
      .selectOption("all");
    await page.getByTestId("save-item").click();
    await waitProject((p) => p.items[0].effects[0].amount === 10);
    await page
      .getByRole("button", { name: "효과로 설명 만들기", exact: true })
      .click();
    await waitProject((p) => !p.items[0].descriptionStale);
    await page.getByText(/규칙 검사 · 오류/).click();
    assert.match(
      await page.getByTestId("sp-preview").textContent(),
      /최대 SP 145 · 재생 30\/초 · 회피 15 · 전환 6/,
    );
    await page
      .getByLabel("미리보기 버프", { exact: true })
      .selectOption("true");
    assert.match(
      await page.getByTestId("sp-preview").textContent(),
      /재생 38\/초 · 회피 11/,
    );
    checks.push("description review and proposed SP arithmetic visible");
  }
  const p = await page.evaluate(
    (id) => window.fourTigerItems.read({ projectId: id }),
    selectedId,
  );
  assert.equal(p.items[0].review.state, "draft");
  if (p.items[0].selectedIconVersion) {
    await page.getByTestId("review-data").click();
    await page.waitForFunction(() =>
      document.body.textContent.includes("데이터 확인됨"),
    );
    await page.getByTestId("review-icon").click();
    await page.getByText(/공통 제안 정책 ·/).click();
    await page.getByTestId("adopt-policies").click();
    await page.getByTestId("adopt-items").click();
    await page.getByTestId("confirm-adopt").click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    checks.push(
      `${live ? "actual" : "fixture"} icon and edited data explicitly reviewed and adopted in isolated smoke copy`,
    );
  }
  await page.getByTestId("export-draft").click();
  await page.getByTestId("export-result").waitFor();
  checks.push("draft JSON/PNG package written");
  if (!live) {
    await page.getByTestId("export-release").click();
    await page
      .getByTestId("export-result")
      .filter({ hasText: "채택본 저장 완료" })
      .waitFor();
    checks.push("all-reviewed fixture release exported");
  }
  await page.locator(".four-tiger-items").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.locator(".fti-editor").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({
    path: path.join(artifact, live ? "live-items.png" : "fixture-items.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  const iconEvidence = p.items.flatMap((i) =>
    i.icons.map((v) => ({
      candidateKey: i.candidateKey,
      itemId: i.itemId,
      contentRevision: v.contentRevision,
      jobId: v.jobId,
      promptHash: v.promptHash,
      sourceSha256: v.sourceSha256,
      thumbnailSha256: v.thumbnailSha256,
      width: v.width,
      height: v.height,
      hasAlpha: v.hasAlpha,
      sourcePath: v.sourcePath,
      thumbnailPath: v.thumbnailPath,
    })),
  );
  if (live)
    assert.ok(
      iconEvidence.length > 0 &&
        iconEvidence.every(
          (v) => v.hasAlpha && v.sourceSha256 && v.thumbnailSha256,
        ),
    );
  fs.writeFileSync(
    path.join(artifact, live ? "live-ui.json" : "fixture-ui.json"),
    JSON.stringify(
      {
        checks,
        errors,
        mockProvider: !live,
        iconEvidence,
        liveImageCount: live
          ? p.items.reduce((n, i) => n + i.icons.length, 0)
          : 0,
        root,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks, errors, root }));
} finally {
  await app.close();
}
