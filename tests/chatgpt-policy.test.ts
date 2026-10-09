import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ChatGptLedger,
  CHATGPT_TOOLS,
  isChatGptUrl,
  isChatGptAuthUrl,
  validateOriginalImage,
  downloadChatControl,
  submitChatControl,
} from "../electron/chatgpt-policy";
const fixture = () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "partsmith-chatgpt-policy-"),
  );
  const workspace = path.join(directory, "workspace");
  fs.mkdirSync(workspace);
  const image = path.join(workspace, "reference.png");
  fs.writeFileSync(
    image,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1cAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const context = {
    runId: "run",
    stageId: "head-multiview",
    workspace,
    attempt: 1,
    webPrompt: "Create four separate head images",
    referencePaths: [image],
  };
  return { directory, workspace, image, context };
};
test("ChatGPT navigation permits only home and exact conversations; auth origins remain separate", () => {
  assert(isChatGptUrl("https://chatgpt.com/"));
  assert(isChatGptUrl("https://chatgpt.com/c/123-abc"));
  for (const url of [
    "https://chatgpt.com.evil.test/",
    "https://x@chatgpt.com/",
    "https://chatgpt.com/settings",
    "https://chatgpt.com/share/abc",
    "http://chatgpt.com/",
    "javascript:alert(1)",
    "https://chatgpt.com:9999/",
  ])
    assert(!isChatGptUrl(url), url);
  assert(isChatGptAuthUrl("https://auth.openai.com/log-in"));
  assert(isChatGptAuthUrl("https://accounts.google.com/"));
  assert(!isChatGptAuthUrl("https://auth.openai.com.evil.test/"));
  assert(!isChatGptAuthUrl("https://user@accounts.google.com/"));
});
test("One durable submission survives retries, crashes and changed attempt numbers", () => {
  const f = fixture(),
    ledger = new ChatGptLedger(f.directory, f.context);
  ledger.reserve();
  assert.equal(
    JSON.parse(fs.readFileSync(ledger.file, "utf8")).submission.state,
    "reserved",
  );
  assert.throws(() => ledger.reserve(), /already submitted/);
  assert.throws(
    () =>
      new ChatGptLedger(f.directory, { ...f.context, attempt: 2 }).reserve(),
    /already submitted/,
  );
  const recovery = new ChatGptLedger(f.directory, {
    ...f.context,
    recoveryOnly: true,
  });
  assert.throws(() => recovery.assertCanPrepare(), /recovery-only/);
  recovery.observeConversation("https://chatgpt.com/c/frozen-1");
  assert.equal(recovery.summary().submission?.state, "observed");
  assert.throws(
    () => recovery.observeConversation("https://chatgpt.com/c/other"),
    /Another/,
  );
});
test("Recovery without a journal cannot generate or upload, and frozen prompt cannot change", () => {
  const f = fixture();
  assert.throws(
    () =>
      new ChatGptLedger(f.directory, {
        ...f.context,
        recoveryOnly: true,
      }).reserve(),
    /recovery-only/,
  );
  const ledger = new ChatGptLedger(f.directory, f.context);
  ledger.reserve();
  assert.throws(
    () =>
      new ChatGptLedger(f.directory, {
        ...f.context,
        webPrompt: "New request",
      }),
    /frozen prompt/,
  );
});
test("Upload references remain within workspace and their bytes cannot change after approval", () => {
  const f = fixture(),
    outside = path.join(f.directory, "outside.png");
  fs.copyFileSync(f.image, outside);
  assert.throws(
    () =>
      new ChatGptLedger(f.directory, {
        ...f.context,
        referencePaths: [outside],
      }),
    /escapes/,
  );
  const ledger = new ChatGptLedger(f.directory, f.context);
  fs.appendFileSync(f.image, "changed");
  assert.throws(() => ledger.reserve(), /frozen reference changed/);
});
test("Image integrity rejects HTML disguises and records original bytes without edits", () => {
  const f = fixture(),
    original = fs.readFileSync(f.image),
    checked = validateOriginalImage(f.image);
  assert.equal(checked.bytes, original.length);
  assert.match(checked.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(fs.readFileSync(f.image), original);
  fs.writeFileSync(f.image, "<html>Unauthorized</html>");
  assert.throws(() => validateOriginalImage(f.image), /bytes do not match/);
});
test("Download receipt is scoped to submitted stage and survives recovery unchanged", () => {
  const f = fixture(),
    ledger = new ChatGptLedger(f.directory, f.context);
  const record = {
    id: "original",
    runId: "run",
    stageId: "head-multiview",
    attempt: 1,
    file: f.image,
    state: "downloading",
    sourcePage: "https://chatgpt.com/c/chat",
    imageLabel: "생성된 이미지 1",
    imageId: "image-1",
  };
  assert.throws(() => ledger.addDownload(record), /submitted stage/);
  ledger.reserve();
  ledger.addDownload(record);
  ledger.updateDownload("original", {
    state: "completed",
    ...validateOriginalImage(f.image),
  });
  const recovered = new ChatGptLedger(f.directory, {
    ...f.context,
    attempt: 3,
    recoveryOnly: true,
  });
  assert.equal(recovered.summary().downloads[0].state, "completed");
  assert.equal(recovered.summary().downloads[0].imageLabel, "생성된 이미지 1");
  assert.throws(
    () => ledger.addDownload({ ...record, stageId: "other" }),
    /submitted stage/,
  );
});
test("Tool schemas expose no arbitrary prompt, URL, script, selector or upload path", () => {
  for (const tool of CHATGPT_TOOLS) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const key of Object.keys(tool.inputSchema.properties))
      assert(
        ![
          "text",
          "prompt",
          "url",
          "script",
          "selector",
          "file",
          "path",
          "view",
        ].includes(key),
        `${tool.name}: ${key}`,
      );
  }
  assert(downloadChatControl.test("다운로드"));
  assert(submitChatControl.test("프롬프트 보내기"));
  assert(!downloadChatControl.test("Regenerate and download"));
  assert(!submitChatControl.test("Try again"));
});
