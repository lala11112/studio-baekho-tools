import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const data = path.resolve(
  "artifacts/runtime",
  `workbench-package-${randomUUID()}`,
);
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const executablePath = path.resolve(
  `release/${version}/win-unpacked/Partsmith.exe`,
);
const app = await electron.launch({
  executablePath,
  env: { ...process.env, PARTSMITH_DATA: data },
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".home");
  const info = await app.evaluate(({ app }) => ({
    isPackaged: app.isPackaged,
    version: app.getVersion(),
  }));
  assert.equal(info.version, version);
  assert(info.isPackaged);
  const state = await page.evaluate(() =>
    window.desktop.call({ type: "state" }),
  );
  assert.equal(state.key.configured, false);
  assert.deepEqual(state.productionRuns, []);
  await page
    .getByRole("button", { name: "새 프로젝트", exact: true })
    .first()
    .click();
  await page
    .locator(".modal input[type=text],.modal input:not([type])")
    .first()
    .fill("패키지 단계별 제작 연결 확인");
  await page
    .getByRole("button", { name: "프로젝트 만들기", exact: true })
    .click();
  await page.getByTestId("workbench").waitFor();
  assert(await page.getByTestId("workbench-provider").isVisible());
  assert.equal(
    await page.getByTestId("workbench-provider").inputValue(),
    "chatgpt-web",
  );
  assert(await page.getByTestId("workbench-chatgpt-open").isVisible());
  const webStatus = await page.evaluate(() =>
    window.desktop.call({ type: "chatgpt.status" }),
  );
  assert.equal(webStatus.available, true);
  assert.equal(webStatus.state, "closed");
  assert.equal(webStatus.opened, false);
  assert.equal(webStatus.canReconnect, true);
  assert(await page.getByTestId("workbench-chatgpt-reconnect").isVisible());
  assert.equal(
    webStatus.ready,
    false,
    "The isolated package profile is not logged in",
  );
  const projectId = (
    await page.evaluate(() => window.desktop.call({ type: "state" }))
  ).projects[0].id;
  await assert.rejects(
    () =>
      page.evaluate(
        (id) =>
          window.desktop.call({
            type: "workbench.action",
            id,
            action: {
              kind: "execute",
              request: {
                step: "concept",
                provider: "gpt",
                imageBackend: "chatgpt-web",
                prompt: "PACKAGE TEST — must not submit",
              },
              approval: {
                accepted: true,
                studioCreditLimit: 0,
                imageCreditLimit: 0,
              },
            },
          }),
        projectId,
      ),
    /먼저 웹 로그인을 확인/,
  );
  assert.equal(
    (
      await page.evaluate(() => window.desktop.call({ type: "state" }))
    ).workbenches.reduce(
      (count, workbench) => count + workbench.jobs.length,
      0,
    ),
    0,
  );
  const probe = await page.evaluate(() =>
    window.desktop.call({ type: "workbench.probe" }),
  );
  assert(probe.codex.available);
  assert(probe.codex.authenticated);
  assert.equal(
    (await page.evaluate(() => window.desktop.call({ type: "state" })))
      .productionRuns.length,
    0,
  );
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: "artifacts/screenshots/workbench-package.png",
  });
  fs.writeFileSync(
    "artifacts/workbench-package-smoke.json",
    JSON.stringify(
      {
        passed: true,
        ...info,
        isolatedStore: true,
        workbenchDefaultScreen: true,
        cliAvailable: probe.codex.available,
        codexLoginDetected: probe.codex.authenticated,
        chatgptWebDefault: true,
        chatgptWebReady: webStatus.ready,
        chatgptConnectionState: webStatus.state,
        explicitReconnectAvailable: webStatus.canReconnect,
        loginPreflightCreatedJobs: 0,
        workerInferenceCalls: 0,
        paidRequests: 0,
        actualProductionVerified: false,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    `Packaged ${version} app: UI, SQLite, guided workbench entry, Codex login probe passed; no generation.`,
  );
} finally {
  await app.close();
}
