import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const data = path.resolve(
  "artifacts/runtime",
  `workbench-package-${randomUUID()}`,
);
const executablePath = path.resolve("release/0.5.1/win-unpacked/Partsmith.exe");
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
  assert.equal(info.version, "0.5.1");
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
        chatgptLoginDetected: probe.codex.authenticated,
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
    "Packaged 0.5.1 app: UI, SQLite, guided workbench entry, Codex login probe passed; no generation.",
  );
} finally {
  await app.close();
}
