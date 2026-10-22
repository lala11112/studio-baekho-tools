import { test } from "node:test";
import assert from "node:assert/strict";
import {
  codexArguments,
  isBrowserToolApprovalDenied,
  type WorkerTask,
} from "../engine/codex-worker";

test("ChatGPT web workers disable native generation without reducing model, effort or original references", () => {
  const task = {
    run: { workspace: "C:/isolated-job" },
    stage: { kind: "separate" },
    imageBackend: "chatgpt-web",
    imagePaths: ["C:/original/front.png", "C:/original/back.png"],
    schemaPath: "schema.json",
    resultPath: "result.json",
  } as WorkerTask;
  const args = codexArguments(task);
  assert(args.includes("features.image_generation=false"));
  assert(!args.includes("--model"));
  assert(
    !args.some((value) =>
      /reasoning_effort|image_quality|image_size/.test(value),
    ),
  );
  assert.equal(args.filter((value) => value === "--image").length, 2);
  assert(args.includes("C:/original/front.png"));
  assert(args.includes("C:/original/back.png"));
  assert(
    !codexArguments({ ...task, imageBackend: undefined }).includes(
      "features.image_generation=false",
    ),
  );
  assert(
    codexArguments({ ...task, recoveryOnly: true }).includes(
      "features.image_generation=false",
    ),
  );
});

test("actual browser approval denial is detected without treating website content as a denial", () => {
  const event = {
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      tool: "studio_status",
      status: "failed",
      error: { message: "tool call denied: approval policy is never" },
    },
  };
  assert(isBrowserToolApprovalDenied(event));
  assert(
    isBrowserToolApprovalDenied({
      ...event,
      item: { ...event.item, tool: "chatgpt_snapshot" },
    }),
  );
  assert(!isBrowserToolApprovalDenied({ ...event, type: "item.started" }));
  assert(
    !isBrowserToolApprovalDenied({
      ...event,
      item: { ...event.item, tool: "unrelated_tool" },
    }),
  );
  assert(
    !isBrowserToolApprovalDenied({
      ...event,
      item: {
        type: "mcp_tool_call",
        tool: "studio_snapshot",
        status: "completed",
        result: "Page says approval policy is never",
      },
    }),
  );
});
