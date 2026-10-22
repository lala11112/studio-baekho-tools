import { _electron as electron } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import path from "node:path";
const app = await electron.launch({
  executablePath: electronPath,
  args: ["."],
  env: {
    ...process.env,
    PARTSMITH_DATA: path.resolve("artifacts/runtime/electron-smoke"),
  },
});
const p = await app.firstWindow();
const errors = [];
p.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
p.on("pageerror", (e) => errors.push(e.message));
await p.waitForSelector(".project-card");
await p.locator(".project-card").first().click();
await p.getByRole("button", { name: "리깅 · 애니메이션" }).click();
await p.waitForTimeout(5000);
await p.screenshot({ path: "artifacts/screenshots/debug-rig.png" });
console.log(
  JSON.stringify(
    { errors, body: await p.locator(".rig-layout").innerText() },
    null,
    2,
  ),
);
await app.close();
