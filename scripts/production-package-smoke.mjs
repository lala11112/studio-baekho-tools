import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const data = path.resolve("artifacts/runtime", `production-package-${randomUUID()}`);
const executablePath = path.resolve("release/0.3.0/win-unpacked/Partsmith.exe");
const app = await electron.launch({ executablePath, env: { ...process.env, PARTSMITH_DATA: data } });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.waitForSelector(".home");
  const info = await app.evaluate(({ app }) => ({ isPackaged: app.isPackaged, version: app.getVersion() }));
  assert.equal(info.version, "0.3.0"); assert(info.isPackaged);
  const state = await page.evaluate(() => window.desktop.call({ type: "state" }));
  assert.equal(state.key.configured, false); assert.deepEqual(state.productionRuns, []);
  await page.getByRole("button", { name: "새 프로젝트", exact: true }).first().click();
  await page.locator(".modal input[type=text],.modal input:not([type])").first().fill("패키지 자동 제작 연결 확인");
  await page.getByRole("button", { name: "프로젝트 만들기", exact: true }).click();
  await page.getByTestId("production-desk").waitFor();
  assert(await page.getByText("Codex Astra · 3D 애니메이션", { exact: true }).isVisible());
  const probe = await page.evaluate(() => window.desktop.call({ type: "production.probe" }));
  assert(probe.codex.available); assert(probe.codex.authenticated);
  assert.equal((await page.evaluate(() => window.desktop.call({ type: "state" }))).productionRuns.length, 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "artifacts/screenshots/production-package.png" });
  fs.writeFileSync("artifacts/production-package-smoke.json", JSON.stringify({ passed: true, ...info, isolatedStore: true, productionDefaultScreen: true, cliAvailable: probe.codex.available, chatgptLoginDetected: probe.codex.authenticated, workerInferenceCalls: 0, paidRequests: 0, actualProductionVerified: false, errors }, null, 2));
  console.log("Packaged 0.3.0 app: UI, SQLite, production entry, Codex login probe passed; no generation.");
} finally { await app.close(); }
