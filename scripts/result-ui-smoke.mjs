import { _electron as electron } from "playwright";
import path from "node:path";
import assert from "node:assert/strict";
import fs from "node:fs";
const app = await electron.launch({
  executablePath: path.resolve("release/win-unpacked/Partsmith.exe"),
  env: {
    ...process.env,
    PARTSMITH_DATA: path.resolve("artifacts/runtime/electron-smoke"),
  },
});
const page = await app.firstWindow();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.waitForSelector(".project-card");
await page.locator(".project-card").first().click();
await page.getByRole("button", { name: "Unity로 보내기" }).click();
await page.getByText("임포트 완료 · 육안 검수 필요", { exact: true }).waitFor();
await page.screenshot({ path: "artifacts/screenshots/06-unity-result.png" });
await page.getByRole("button", { name: "리깅 · 애니메이션" }).click();
await page.waitForTimeout(1500);
await page.screenshot({ path: "artifacts/screenshots/07-final-rig.png" });
assert.deepEqual(errors, []);
await app.close();
fs.writeFileSync(
  "artifacts/result-ui-smoke.json",
  JSON.stringify({ passed: true, errors }, null, 2),
);
console.log("Packaged Unity result screen passed.");
