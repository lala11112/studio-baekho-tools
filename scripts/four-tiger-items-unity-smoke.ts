import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
function option(name: string) {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1]) throw new Error(`Missing ${name}`);
  return path.resolve(args[i + 1]);
}
const unity = option("--unity"),
  source = option("--package"),
  project = option("--project");
await fs.access(unity);
await fs.access(path.join(source, "saingeom-items.v1.json"));
// Never reuse a game project or overwrite any existing directory, even an empty one.
await fs.mkdir(project, { recursive: false });
await fs.mkdir(path.join(project, "Assets", "Editor"), { recursive: true });
await fs.mkdir(path.join(project, "Packages"));
await fs.mkdir(path.join(project, "ProjectSettings"));
await fs.writeFile(
  path.join(project, "Packages", "manifest.json"),
  '{"dependencies":{}}\n',
);
await fs.writeFile(
  path.join(project, "ProjectSettings", "ProjectVersion.txt"),
  "m_EditorVersion: 6000.3.10f1\n",
);
await fs.cp(source, path.join(project, "Assets", "SainGeomPackage"), {
  recursive: true,
  errorOnExist: true,
  force: false,
});
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await fs.copyFile(
  path.join(repo, "tests", "unity", "FourTigerItemPackageImportCheck.cs"),
  path.join(project, "Assets", "Editor", "FourTigerItemPackageImportCheck.cs"),
);
const log = path.join(project, "unity-import.log");
const code = await new Promise<number | null>((resolve, reject) => {
  const child = spawn(
    unity,
    [
      "-batchmode",
      "-nographics",
      "-projectPath",
      project,
      "-executeMethod",
      "FourTigerItemPackageImportCheck.Run",
      "-logFile",
      log,
    ],
    { shell: false, windowsHide: true, stdio: "ignore" },
  );
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error(`Unity timed out; inspect ${log}`));
  }, 300000);
  child.once("error", (e) => {
    clearTimeout(timer);
    reject(e);
  });
  child.once("exit", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});
const report = JSON.parse(
  await fs.readFile(path.join(project, "unity-import-report.json"), "utf8"),
);
console.log(JSON.stringify({ code, project, report }, null, 2));
assert.equal(code, 0, "Unity import failed");
assert.equal(report.jsonImported, true);
assert.equal(report.textureCount, 20);
assert.equal(report.spriteCount, 20);
assert.deepEqual(report.errors, []);
