import { _electron as electron } from "playwright";
import path from "node:path";
import assert from "node:assert/strict";
import fs from "node:fs";
const app = await electron.launch({
  executablePath: path.resolve("release/win-unpacked/Partsmith.exe"),
  env: {
    ...process.env,
    PARTSMITH_DATA: path.resolve("artifacts/runtime/package-smoke"),
  },
});
const page = await app.firstWindow();
await page.waitForSelector(".home");
const s = await page.evaluate(() => window.desktop.call({ type: "state" }));
assert.equal(s.key.configured, false);
const info = await app.evaluate(({ app }) => ({
  isPackaged: app.isPackaged,
  version: app.getVersion(),
}));
assert(info.isPackaged);
const p = await page.evaluate(() =>
  window.desktop.call({
    type: "project.create",
    name: "패키지 로컬 처리 검증",
    demo: true,
  }),
);
const build = await page.evaluate(
  (id) => window.desktop.call({ type: "blender.build", id, mode: "demo-rig" }),
  p.id,
);
assert(build.hasRig);
assert.deepEqual(build.clips.sort(), ["Idle", "Walk"]);
await page.screenshot({ path: "artifacts/screenshots/packaged-home.png" });
await app.close();
fs.writeFileSync(
  "artifacts/package-smoke.json",
  JSON.stringify(
    { passed: true, packagedBlenderResources: true, ...info },
    null,
    2,
  ),
);
console.log("Packaged Windows app smoke passed.");
