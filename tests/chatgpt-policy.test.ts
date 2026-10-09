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
  isChatGptPopupUrl,
  isChatGptSignInRequest,
  chatGptDiagnosticLocation,
  isGoogleEmbeddedBrowserRejection,
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
test("Human authentication popups allow exact blank and trusted destinations without broadening worker navigation", () => {
  for (const url of [
    "about:blank",
    "https://accounts.google.com/v3/signin/identifier",
    "https://auth.openai.com/log-in",
    "https://chatgpt.com/auth/callback?code=private",
  ])
    assert(isChatGptPopupUrl(url), url);
  for (const url of [
    "about:blank#payload",
    "data:text/html,login",
    "javascript:alert(1)",
    "https://accounts.google.com.evil.test/",
    "http://accounts.google.com/",
    "https://accounts.google.com:9999/",
    "https://secret@auth.openai.com/",
  ])
    assert(!isChatGptPopupUrl(url), url);
  assert(!isChatGptUrl("about:blank"));
  assert(!isChatGptUrl("https://chatgpt.com/auth/callback?code=private"));
});
test("Observed ChatGPT provider login route is human-auth-only and exact", () => {
  for (const url of [
    "https://chatgpt.com/auth/login_with",
    "https://chatgpt.com/auth/login_with?provider=google&state=private#private",
  ]) {
    assert(isChatGptAuthUrl(url), url);
    assert(isChatGptPopupUrl(url), url);
    assert(!isChatGptUrl(url), url);
  }
  for (const url of [
    "https://chatgpt.com/auth/login_with/",
    "https://chatgpt.com/auth/login_with/extra",
    "https://chatgpt.com/auth/login_with_extra",
    "https://chatgpt.com/auth/login_with.evil",
    "https://chatgpt.com/auth/unobserved",
    "https://chatgpt.com.evil.test/auth/login_with",
    "http://chatgpt.com/auth/login_with",
    "https://secret@chatgpt.com/auth/login_with",
    "https://chatgpt.com:9999/auth/login_with",
  ]) {
    assert(!isChatGptAuthUrl(url), url);
    assert(!isChatGptPopupUrl(url), url);
    assert(!isChatGptUrl(url), url);
  }
});
test("Sign-in request diagnostics exclude session checks, unrelated routes and unsafe origins", () => {
  for (const url of [
    "https://chatgpt.com/api/auth/signin",
    "https://chatgpt.com/api/auth/signin/google?state=private#private",
  ]) {
    assert(isChatGptSignInRequest(url), url);
    assert(!isChatGptUrl(url), url);
    assert(!isChatGptAuthUrl(url), url);
  }
  for (const url of [
    "https://chatgpt.com/api/auth/session",
    "https://chatgpt.com/api/auth/signin_extra",
    "https://chatgpt.com/api/auth/signin/google/extra",
    "https://chatgpt.com/api/unrelated",
    "https://chatgpt.com.evil.test/api/auth/signin/google",
    "https://auth.openai.com/api/auth/signin/google",
    "http://chatgpt.com/api/auth/signin/google",
    "https://secret@chatgpt.com/api/auth/signin/google",
    "https://chatgpt.com:9999/api/auth/signin/google",
  ])
    assert(!isChatGptSignInRequest(url), url);
});
test("Login diagnostics retain public route segments but redact credentials, opaque paths, query and fragment", () => {
  assert.deepEqual(
    chatGptDiagnosticLocation(
      "https://chatgpt.com/auth/login_with?provider=google&state=private#private",
    ),
    { host: "chatgpt.com", path: "/auth/login_with" },
  );
  assert.deepEqual(
    chatGptDiagnosticLocation(
      "https://name:password@auth.openai.com/auth/callback/private-token-123?code=secret&email=person@example.com#access_token=other",
    ),
    {
      host: "auth.openai.com",
      path: "/auth/callback/[redacted]",
    },
  );
  assert.deepEqual(
    chatGptDiagnosticLocation(
      "https://accounts.google.com/v3/signin/identifier?continue=secret",
    ),
    {
      host: "accounts.google.com",
      path: "/v3/signin/identifier",
    },
  );
  assert.deepEqual(
    chatGptDiagnosticLocation("https://auth.openai.com/auth/%73ecret/callback"),
    {
      host: "auth.openai.com",
      path: "/auth/[redacted]/callback",
    },
  );
  assert.deepEqual(chatGptDiagnosticLocation("about:blank"), {
    path: "about:blank",
  });
  assert.deepEqual(chatGptDiagnosticLocation("javascript:secret"), {});
});
test("Only the explicit trusted Google embedded-browser rejection is classified from an auth URL", () => {
  assert(
    isGoogleEmbeddedBrowserRejection(
      "https://accounts.google.com/o/oauth2/error?error=disallowed_useragent&token=secret",
    ),
  );
  for (const url of [
    "https://accounts.google.com/?error=access_denied",
    "https://accounts.google.com/?note=disallowed_useragent",
    "https://evil.test/?error=disallowed_useragent",
    "https://user@accounts.google.com/?error=disallowed_useragent",
  ])
    assert(!isGoogleEmbeddedBrowserRejection(url), url);
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
