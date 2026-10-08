import { test } from "node:test";
import assert from "node:assert/strict";
import { codexArguments, type WorkerTask } from "../engine/codex-worker";

test("repair workers cannot invoke builtin image generation; normal workers keep it available", () => {
  const task = {
    run: { workspace: "C:/isolated-job" },
    stage: { kind: "separate" },
    imagePaths: [],
    schemaPath: "schema.json",
    resultPath: "result.json",
  } as unknown as WorkerTask;
  assert(!codexArguments(task).includes("features.image_generation=false"));
  const repair = codexArguments({
    ...task,
    recoveryOnly: true,
    requestedModel: "gpt-6-astra",
  });
  assert(repair.includes("features.image_generation=false"));
  assert.equal(repair[repair.indexOf("--model") + 1], "gpt-6-astra");
  assert(
    !repair.some((value) =>
      /apps=false|browser_use=false|view_image=false/.test(value),
    ),
  );
});
