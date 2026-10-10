import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { extractFile } from "@electron/asar";

const require = createRequire(import.meta.url);
const { installIntegration } = require("../Apps/AutoHitTimer/src/install.cjs");
const root = process.cwd();
const resources = path.join(root, "release/win-unpacked/resources");
const kit = path.join(resources, "auto-hit-timer-kit");
const digest = value => createHash("sha256").update(value).digest("hex");
for (const file of ["Apps/AutoHitTimer/src/main.cjs", "Apps/AutoHitTimer/src/install.cjs", "Apps/AutoHitTimer/renderer/app.js", "Apps/AutoHitTimer/renderer/embedded.css", "dist-electron/main.cjs"]) {
  assert.equal(digest(extractFile(path.join(resources, "app.asar"), path.normalize(file))), digest(fs.readFileSync(path.join(root, file))), `packaged source matches current checkout: ${file}`);
}
const fixture = path.join(root, "artifacts/integration-runtime", `hit-kit-${Date.now()}`);
fs.mkdirSync(path.join(fixture, "Assets"), { recursive: true });
fs.mkdirSync(path.join(fixture, "ProjectSettings"), { recursive: true });
const sentinel = "// Isolated installer fixture; never compiled as a game.\n";
fs.writeFileSync(path.join(fixture, "Assets/WeaponActionDataSO.cs"), sentinel);
fs.writeFileSync(path.join(fixture, "ProjectSettings/ProjectVersion.txt"), "m_EditorVersion: 6000.3.10f1\n");
const result = installIntegration(fixture, kit);
assert.ok(result.message.includes("설치 요청"));
assert.equal(fs.readFileSync(path.join(fixture, "Assets/WeaponActionDataSO.cs"), "utf8"), sentinel);
for (const file of ["AutoHitTimerIntegration/Package/package.json", "AutoHitTimerIntegration/Adapter/FourTigerAutoHitTimerAdapter.cs", "Assets/StudioBaekho/AutoHitTimerBootstrap/Editor/AutoHitTimerInstaller.cs", "Library/AutoHitTimerInstall.json"]) assert.ok(fs.existsSync(path.join(fixture, file)), file);
const report = { ok: true, date: new Date().toISOString(), checks: ["packaged app and current source hashes match", "Unity package, adapter and installer assets included", "installer copies kit into isolated fixture", "existing fixture source preserved"], actualUnityCompilation: false, actualGameModified: false };
fs.writeFileSync(path.join(root, "artifacts/hit-timer-kit-smoke.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
