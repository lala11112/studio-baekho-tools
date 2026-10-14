import { _electron as electron } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const runtime = path.resolve("artifacts/runtime", `bgm-shell-${Date.now()}`);
fs.mkdirSync(runtime, { recursive: true });
for (const mode of ["missing-key", "damaged-ledger"]) {
  const profile = path.join(runtime, mode);
  if (mode === "damaged-ledger") {
    fs.mkdirSync(path.join(profile, "bgm"), { recursive: true });
    fs.writeFileSync(path.join(profile, "bgm/ledger.json"), "{not valid JSON");
  }
  const app = await electron.launch({ executablePath: electronPath, args: ["."], env: { ...process.env, FAL_KEY: "", BAEKHO_DATA: profile } });
  const errors = [];
  try {
    const page = await app.firstWindow();
    page.on("pageerror", e => errors.push(e.message));
    await page.getByTestId("tool-bgm").click();
    await page.getByTestId("bgm-description").waitFor();
    if (mode === "missing-key") {
      const state = await page.evaluate(() => window.bgm.state());
      assert.equal(state.configured, false);
      await page.getByRole("button", { name: "평온", exact: true }).click();
      assert.equal(await page.getByRole("button", { name: "평온", exact: true }).getAttribute("aria-pressed"), "true");
      await page.getByTestId("bgm-description").fill("Keep this draft while switching tools.");
      assert.equal(await page.getByTestId("bgm-generate").isEnabled(), false);
    } else {
      await page.waitForFunction(() => !!document.querySelector('[role="alert"]'));
      assert.ok(await page.locator('[role="alert"]').innerText());
    }
    await page.getByTestId("nav-home").click();
    await page.getByTestId("tool-bgm").click();
    if (mode === "missing-key") {
      assert.equal(await page.getByTestId("bgm-description").inputValue(), "Keep this draft while switching tools.");
    }
    assert.deepEqual(errors, []);
    console.log(`${mode}: shell remains usable, no renderer errors or paid requests`);
  } finally { await app.close(); }
}
