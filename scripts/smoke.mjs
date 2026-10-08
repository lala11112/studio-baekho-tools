import { _electron as electron } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd();
const data = path.join(root, "artifacts/runtime/electron-smoke");
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync("artifacts/screenshots", { recursive: true });
const errors = [];
let app = await electron.launch({
  executablePath: electronPath,
  args: ["."],
  env: { ...process.env, PARTSMITH_DATA: data },
});
let page = await app.firstWindow();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.waitForSelector(".home");
await page.screenshot({ path: "artifacts/screenshots/01-projects.png" });
const isolation = await page.evaluate(() => ({
  node: typeof window.require,
  process: typeof window.process,
  api: typeof window.desktop.call,
}));
assert.deepEqual(isolation, {
  node: "undefined",
  process: "undefined",
  api: "function",
});
await page.getByRole("button", { name: "새 프로젝트", exact: true }).click();
await page.getByRole("dialog").getByRole("textbox").fill("자동 검증 · 데모");
await page.getByRole("checkbox").check();
await page.getByRole("button", { name: "프로젝트 만들기" }).click();
await page.getByRole("button", { name: "로컬 데모 리깅 실행" }).click();
await page.waitForFunction(
  async () => {
    const s = await window.desktop.call({ type: "state" });
    return s.projects[0]?.builds.length > 0;
  },
  null,
  { timeout: 120000 },
);
await page.waitForSelector(".playback", { timeout: 30000 });
const result = await page.evaluate(async () => {
  const s = await window.desktop.call({ type: "state" });
  const p = s.projects[0];
  return { id: p.id, build: p.builds.at(-1), assets: p.assets };
});
assert.equal(result.build.hasRig, true);
assert.deepEqual(result.build.clips, ["Idle", "Walk"]);
await page.locator(".playback select").selectOption({ label: "Walk" });
await page.screenshot({ path: "artifacts/screenshots/02-rig.png" });
await page.getByRole("button", { name: "조립 작업실" }).click();
await page.waitForSelector(".workbench");
await page.screenshot({ path: "artifacts/screenshots/03-workbench.png" });
await page.getByRole("button", { name: "이미지 스튜디오" }).click();
await page.waitForSelector(".image-layout");
await page.screenshot({ path: "artifacts/screenshots/04-image.png" });
await page
  .getByRole("button", { name: "연결 설정", exact: true })
  .first()
  .click();
await page.getByRole("button", { name: "환경 확인", exact: true }).click();
await page.waitForSelector(".probe");
await page.screenshot({ path: "artifacts/screenshots/05-settings.png" });
const probe = await page.locator(".probe").innerText();
assert.match(probe, /Blender 5.0.0/);
assert.match(probe, /6000.3.21f1/);
await app.close();
app = await electron.launch({
  executablePath: electronPath,
  args: ["."],
  env: { ...process.env, PARTSMITH_DATA: data },
});
page = await app.firstWindow();
await page.waitForSelector(".home");
const restored = await page.evaluate(async () => {
  const s = await window.desktop.call({ type: "state" });
  return s.projects.find((p) => p.id === s.projects[0].id);
});
assert.equal(restored.id, result.id);
assert.equal(restored.builds.at(-1).id, result.build.id);
fs.writeFileSync(
  "artifacts/electron-smoke.json",
  JSON.stringify(
    {
      passed: true,
      isolation,
      projectId: result.id,
      buildId: result.build.id,
      probe,
      restartRecovered: true,
      errors,
    },
    null,
    2,
  ),
);
await app.close();
assert.deepEqual(errors, []);
console.log(
  "Electron smoke passed: UI, isolation, Blender build, GLB playback, persistence.",
);
