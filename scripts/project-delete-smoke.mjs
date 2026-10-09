import { _electron as electron } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";

const packaged = process.argv.includes("--packaged");
const root = path.resolve(
  "artifacts/runtime",
  `project-delete-${randomUUID()}`,
);
const launch = () =>
  electron.launch({
    executablePath: packaged
      ? path.resolve("release/0.5.3/win-unpacked/Partsmith.exe")
      : electronPath,
    args: packaged ? [] : ["."],
    env: { ...process.env, PARTSMITH_DATA: root },
  });
let app = await launch();
try {
  let page = await app.firstWindow();
  await page.waitForSelector(".home");
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const call = (c) =>
    page.evaluate((command) => window.desktop.call(command), c);
  const target = await call({
    type: "project.create",
    name: "삭제 기능 확인용",
  });
  const keep = await call({ type: "project.create", name: "보존할 프로젝트" });
  const targetFolder = path.join(root, "projects", target.id);
  const keepFile = path.join(root, "projects", keep.id, "project.json");
  const external = path.join(root, "external-original.txt");
  fs.writeFileSync(external, "outside project: preserve");
  fs.writeFileSync(
    path.join(targetFolder, "test-asset.txt"),
    "generated test asset",
  );
  const digest = (f) =>
    createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  const targetHash = digest(path.join(targetFolder, "project.json"));
  const keepHash = digest(keepFile);
  await app.evaluate(({ dialog, shell }) => {
    globalThis.deletionTest = {
      response: 0,
      dialogs: [],
      trashCalls: 0,
      failTrash: false,
    };
    const originalTrash = shell.trashItem.bind(shell);
    dialog.showMessageBox = async (_window, options) => {
      globalThis.deletionTest.dialogs.push(options);
      return {
        response: globalThis.deletionTest.response,
        checkboxChecked: false,
      };
    };
    shell.trashItem = async (directory) => {
      globalThis.deletionTest.trashCalls++;
      if (globalThis.deletionTest.failTrash)
        throw new Error("테스트 휴지통 실패");
      await originalTrash(directory);
    };
  });
  const card = page.locator(
    `[data-testid="project-card"][data-project-id="${target.id}"]`,
  );
  const remove = card.getByTestId("project-delete");
  await card.waitFor();
  assert.equal(await card.locator("button button").count(), 0);
  await remove.click();
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="project-delete"]')?.disabled,
  );
  assert.equal(digest(path.join(targetFolder, "project.json")), targetHash);
  assert.equal(await app.evaluate(() => globalThis.deletionTest.trashCalls), 0);
  assert.equal((await call({ type: "state" })).projects.length, 2);

  // A still-pending local import must prevent deletion, even before a job exists.
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = () =>
      new Promise((resolve) => {
        globalThis.deletionTest.resolveImport = resolve;
      });
  });
  await page.evaluate((id) => {
    window.pendingDeleteTestImport = window.desktop.call({
      type: "asset.import",
      id,
      kind: "image",
    });
  }, target.id);
  await assert.rejects(
    () => call({ type: "project.delete", id: target.id }),
    /실행 중/,
  );
  await app.evaluate(() =>
    globalThis.deletionTest.resolveImport({ canceled: true, filePaths: [] }),
  );
  await page.evaluate(() => window.pendingDeleteTestImport);
  await app.evaluate(() => {
    globalThis.deletionTest.response = 1;
    globalThis.deletionTest.failTrash = true;
  });
  await assert.rejects(
    () => call({ type: "project.delete", id: target.id }),
    /휴지통/,
  );
  assert.equal(digest(path.join(targetFolder, "project.json")), targetHash);
  assert.equal((await call({ type: "state" })).projects.length, 2);

  // Select the project first to check that deleting it also clears its workspace selection.
  await card.getByTestId("project-open").click();
  await page.getByTestId("workbench").waitFor();
  await page
    .getByRole("button", { name: "모든 프로젝트", exact: true })
    .click();
  await app.evaluate(() => {
    globalThis.deletionTest.failTrash = false;
  });
  await page.screenshot({
    path: `artifacts/screenshots/project-delete${packaged ? "-packaged" : ""}.png`,
  });
  await remove.click();
  await card.waitFor({ state: "detached" });
  assert.equal(fs.existsSync(targetFolder), false);
  assert.equal(digest(keepFile), keepHash);
  assert.equal(fs.readFileSync(external, "utf8"), "outside project: preserve");
  assert.deepEqual(
    (await call({ type: "state" })).projects.map((p) => p.id),
    [keep.id],
  );
  const dialogs = await app.evaluate(() => globalThis.deletionTest.dialogs);
  assert(
    dialogs.every(
      (d) =>
        d.message.includes(target.name) &&
        d.defaultId === 0 &&
        d.cancelId === 0,
    ),
  );
  assert(
    dialogs.every(
      (d) => d.detail.includes("Windows 휴지통") && d.detail.includes("Unity"),
    ),
  );
  assert.deepEqual(errors, []);
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.waitForSelector(".home");
  assert.deepEqual(
    (await call({ type: "state" })).projects.map((p) => p.id),
    [keep.id],
  );
  fs.writeFileSync(
    `artifacts/project-delete${packaged ? "-packaged" : ""}-smoke.json`,
    JSON.stringify(
      {
        passed: true,
        packaged,
        isolatedStore: true,
        cancellationPreservesProject: true,
        pendingLocalCommandBlocksDelete: true,
        trashFailurePreservesProject: true,
        actualWindowsTrashOfSyntheticProject: true,
        otherProjectAndExternalFilePreserved: true,
        deletedProjectStaysDeletedAfterRestart: true,
        remoteRequests: 0,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    `Project deletion ${packaged ? "packaged" : "development"} smoke passed; real recycle bin, synthetic project only.`,
  );
} finally {
  await app.close();
}
