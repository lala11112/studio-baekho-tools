import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
const fix = JSON.parse(
    fs.readFileSync("artifacts/runtime/graphics-planar-fixture.json", "utf8"),
  ),
  root = fs.realpathSync(fix.root),
  unity = fs.realpathSync(fix.unity);
assert(
  path.dirname(root) === fs.realpathSync(os.tmpdir()) &&
    path.basename(root).startsWith("ps-planar-chest-") &&
    path.dirname(unity) === root,
);
const editor = path.join(unity, "Assets/Editor"),
  installed = path.join(
    unity,
    "Assets/PartsmithGraphicsBridge/Editor/PartsmithGraphicsBridge.cs",
  ),
  original = fs.readFileSync(installed),
  sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const inbox = path.join(unity, "Library/PartsmithGraphicsInbox"),
  snapshot = () =>
    Object.fromEntries(
      fs
        .readdirSync(inbox)
        .map((n) => [n, sha(fs.readFileSync(path.join(inbox, n)))]),
    );
const before = snapshot();
const disable = (s: string) =>
  s
    .replace("[InitializeOnLoad] public static class", "public static class")
    .replace(
      "static PartsmithGraphicsBridge(){EditorApplication.update+=Tick;}",
      "static PartsmithGraphicsBridge(){}",
    );
try {
  fs.writeFileSync(installed, disable(original.toString()));
  fs.mkdirSync(editor, { recursive: true });
  fs.writeFileSync(
    path.join(editor, "PlanarParserCandidate.cs"),
    disable(
      fs.readFileSync(
        "integrations/unity/Editor/PartsmithGraphicsBridge.cs",
        "utf8",
      ),
    )
      .replace(
        "namespace Partsmith.Graphics {",
        "namespace Partsmith.PlanarParserCandidate {",
      )
      .replace('[MenuItem("Tools/Partsmith/Process graphics imports")]', ""),
  );
  fs.copyFileSync(
    "scripts/fixtures/PlanarParseCheck.cs",
    path.join(editor, "PlanarParseCheck.cs"),
  );
  fs.mkdirSync(path.join(unity, "PlanarEvidence"), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      path.join(process.env.LOCALAPPDATA!, "Unity/bin/unity.exe"),
      [
        "run",
        unity,
        "--format",
        "json",
        "--timeout",
        "180",
        "--",
        "-executeMethod",
        "PlanarParseCheck.Run",
        "-logFile",
        path.resolve("artifacts/runtime/graphics-planar-parse-editor.log"),
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let tail = "";
    child.stdout.on("data", (b) => (tail = (tail + b).slice(-4000)));
    child.stderr.on("data", (b) => (tail = (tail + b).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(Error(tail))));
  });
  const result = JSON.parse(
    fs.readFileSync(path.join(unity, "PlanarEvidence/parser.json"), "utf8"),
  );
  assert(result.passed);
  assert.deepEqual(snapshot(), before);
  fs.writeFileSync(
    "artifacts/runtime/graphics-planar-parse.json",
    JSON.stringify(
      {
        ...result,
        sourceSha256: sha(
          fs.readFileSync(
            "integrations/unity/Editor/PartsmithGraphicsBridge.cs",
          ),
        ),
        installedRestoredSha256: sha(original),
        inboxUnchanged: true,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(result));
} finally {
  fs.writeFileSync(installed, original);
  assert.equal(sha(fs.readFileSync(installed)), sha(original));
  assert.deepEqual(snapshot(), before);
  for (const name of ["PlanarParserCandidate.cs", "PlanarParseCheck.cs"]) {
    const target = path.join(editor, name);
    if (fs.existsSync(target)) fs.unlinkSync(target);
    if (fs.existsSync(target + ".meta")) fs.unlinkSync(target + ".meta");
  }
}
