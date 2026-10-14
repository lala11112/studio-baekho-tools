import { _electron as electron } from "playwright";
import electronPath from "electron";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Paid submission is opt-in and protected by a durable, single-run marker.
// Default invocation only inspects an existing isolated test profile.
const generate = process.argv.includes("--generate");
const root = path.resolve("artifacts/runtime/bgm-live-2026-10-14");
const profile = path.join(root, "profile");
const marker = path.join(root, "paid-intent.json");
fs.mkdirSync(root, { recursive: true });
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
let app;
const errors = [];
async function launch(withKey = true) {
  app = await electron.launch({ executablePath: electronPath, args: ["."], env: { ...process.env, FAL_KEY: withKey ? process.env.FAL_KEY : "", BAEKHO_DATA: profile, PARTSMITH_DATA: profile } });
  const page = await app.firstWindow();
  page.on("pageerror", error => errors.push(error.message));
  await page.getByTestId("tool-bgm").click();
  await page.getByTestId("bgm-description").waitFor();
  return page;
}
async function exportTrack(page, id, file) {
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, file);
  await page.getByTestId(`bgm-select-${id}`).click();
  await page.getByTestId("bgm-export").click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="bgm-export"]')?.disabled);
  assert.ok(fs.existsSync(file), "MP3 export must create a file");
}
try {
  let page = await launch();
  let state = await page.evaluate(() => window.bgm.state());
  if (!generate) assert.ok(state.candidates.length, "No saved verification profile; paid generation requires explicit --generate");
  if (generate) {
    assert.equal(state.candidates.length, 0, "Never submit again into a populated live profile");
    assert.ok(state.configured, "Existing FAL_KEY is required");
    assert.ok(!fs.existsSync(marker), "Paid intent exists; inspect existing requests instead of replaying");
    assert.equal(state.model, "fal-ai/lyria3");
    assert.equal(state.priceUsd, 0.04);
    assert.ok(state.totalReservedUsd + 3 * state.priceUsd < 5);
    await page.getByRole("button", { name: "오케스트라", exact: true }).click();
    await page.getByRole("button", { name: "국악 퓨전", exact: true }).click();
    await page.getByRole("button", { name: "신비", exact: true }).click();
    await page.getByTestId("bgm-description").fill("사인검 게임의 고요한 달빛 사찰 탐험 BGM. 가야금과 대금, 부드러운 현악기, 80 BPM. 대화와 효과음을 가리지 않는 섬세하고 신비로운 분위기. 보컬과 노랫말 없이 악기로만 연주.");
    json(marker, { model: state.model, count: 3, unitPriceUsd: state.priceUsd, estimatedUsd: 0.12, approvedCeilingExclusiveUsd: 5, createdAt: new Date().toISOString() });
    await page.getByTestId("bgm-generate").click();
  }
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    state = await page.evaluate(() => window.bgm.state());
    json(path.join(root, "state.json"), state);
    if (state.candidates.length && state.candidates.every(c => ["ready", "failed", "uncertain"].includes(c.status))) break;
    await page.waitForTimeout(2500);
  }
  console.log(JSON.stringify({ model: state.model, reservedUsd: state.totalReservedUsd, candidates: state.candidates.map(c => ({ id: c.id, status: c.status, requestId: c.requestId, error: c.error })) }));
  assert.equal(state.candidates.length, 3);
  assert.equal(state.totalReservedUsd, 0.12);
  assert.ok(state.candidates.every(c => c.status === "ready"), "All three live candidates must be locally ready");
  const selected = state.candidates[0];
  const media = [];
  for (const candidate of state.candidates) {
    const playback = await page.locator(`audio[src="${candidate.previewUrl}"]`).evaluate(async audio => {
    audio.muted = true;
    await audio.play();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Playback did not advance")), 10000);
      const check = () => { if (audio.currentTime > 0.1) { clearTimeout(timer); audio.removeEventListener("timeupdate", check); resolve(); } };
      audio.addEventListener("timeupdate", check); check();
    });
    audio.pause();
    return { duration: audio.duration, currentTime: audio.currentTime, readyState: audio.readyState };
  });
    assert.ok(playback.duration >= 29 && playback.duration <= 31, "Expected approximately 30-second audio");
    media.push({ id: candidate.id, ...playback });
  }
  await page.locator(".bgm-workshop").evaluate(element => element.scrollTo(0, 0));
  await page.screenshot({ path: path.join(root, "bgm-workshop.png"), fullPage: true });
  const firstExport = path.join(root, "selected-bgm.mp3");
  await exportTrack(page, selected.id, firstExport);
  await app.close(); app = undefined;
  page = await launch(false);
  const restored = await page.evaluate(() => window.bgm.state());
  assert.equal(restored.candidates.length, 3);
  assert.equal(restored.selectedId, selected.id);
  assert.equal(restored.totalReservedUsd, 0.12);
  assert.equal(restored.configured, false, "Local export must work without fal credentials");
  const secondExport = path.join(root, "selected-bgm-after-restart.mp3");
  await exportTrack(page, selected.id, secondExport);
  assert.equal(digest(firstExport), digest(secondExport));
  assert.deepEqual(errors, []);
  const evidence = { checkedAt: new Date().toISOString(), model: state.model, requestIds: state.candidates.map(c => c.requestId), generatedCount: 3, estimatedUsd: 0.12, billingConfirmed: false, media, exportedBytes: fs.statSync(firstExport).size, exportSha256: digest(firstExport), restartExportMatches: true, exportedWithoutCredentials: true, pageErrors: errors };
  json(path.join(root, "verification.json"), evidence);
  console.log(JSON.stringify(evidence));
} finally { if (app) await app.close(); }
