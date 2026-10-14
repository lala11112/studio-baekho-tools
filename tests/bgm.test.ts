import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BgmService, buildBgmPrompt } from "../engine/bgm";
import { BGM_GENRES, BGM_MOODS, type BgmInput } from "../shared/bgm";

const key = "test-secret-not-a-real-key";
const queue = "https://queue.fal.run/fal-ai/lyria3";
const input: BgmInput = { genres: [BGM_GENRES[0]], moods: [BGM_MOODS[0]], description: "  Piano and strings.  " };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const mp3 = Buffer.alloc(834);
mp3.set([0xff, 0xfb, 0x90, 0x00], 0);
mp3.set([0xff, 0xfb, 0x90, 0x00], 417);
type Call = { url: string; init?: RequestInit };
type Handler = (call: Call, count: number) => Response | Promise<Response>;
function setup(t: TestContext, handler?: Handler, budgetUsd?: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgm-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls: Call[] = [];
  const fakeFetch = (async (url, init) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler ? handler(call, calls.length) : json({ request_id: `req-${calls.length}`, status: "IN_QUEUE" });
  }) as typeof fetch;
  const service = new BgmService({ root, getKey: () => key, fetch: fakeFetch, budgetUsd });
  return { root, calls, service, fakeFetch };
}

test("BGM prompts preserve choices and request instrumental background music", () => {
  const prompt = buildBgmPrompt(input);
  assert.ok(prompt.includes(input.genres[0]));
  assert.ok(prompt.includes(input.moods[0]));
  assert.ok(prompt.includes("Piano and strings."));
  assert.match(prompt, /instrumental/i);
  assert.match(prompt, /no vocals/i);
  assert.ok(prompt.length <= 5000);
});

test("BGM rejects malformed or empty input before reserving budget", async (t) => {
  const s = setup(t);
  for (const bad of [null, {}, { ...input, genres: ["invented"] }, { ...input, moods: [BGM_MOODS[0], BGM_MOODS[0]] }, { ...input, description: "x".repeat(5000) }, { ...input, description: "hello\u0000" }, { genres: [], moods: [], description: " " }]) {
    await assert.rejects(s.service.generate(bad as BgmInput));
  }
  assert.equal(s.calls.length, 0);
  assert.equal(s.service.state().totalReservedUsd, 0);
});

test("BGM submits exactly three prompt-only requests after durable reservation", async (t) => {
  let s: ReturnType<typeof setup>;
  s = setup(t, (call, count) => {
    const disk = JSON.parse(fs.readFileSync(path.join(s.root, "ledger.json"), "utf8"));
    assert.equal(disk.candidates.length, 3);
    assert.equal(disk.totalReservedUsd, 0.12);
    assert.equal(call.url, queue);
    assert.equal(call.init?.method, "POST");
    assert.equal(new Headers(call.init?.headers).get("authorization"), `Key ${key}`);
    assert.deepEqual(JSON.parse(String(call.init?.body)), { prompt: buildBgmPrompt(input), enable_safety_checker: true });
    return json({ request_id: `req-${count}`, status: "IN_QUEUE" });
  });
  const state = await s.service.generate(input);
  assert.equal(s.calls.length, 3);
  assert.equal(state.totalReservedUsd, 0.12);
  assert.equal(state.budgetUsd, 4.99);
  assert.deepEqual(state.candidates.map((c) => c.status), ["queued", "queued", "queued"]);
  assert.deepEqual(state.candidates.map((c) => c.requestId), ["req-1", "req-2", "req-3"]);
  assert.equal(JSON.stringify(state).includes(key), false);
  assert.equal(fs.readFileSync(path.join(s.root, "ledger.json"), "utf8").includes(key), false);
});

test("BGM coalesces concurrent double-clicks into one three-candidate batch", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const s = setup(t, async (_call, count) => { await gate; return json({ request_id: `req-${count}` }); });
  const a = s.service.generate(input);
  const b = s.service.generate(input);
  assert.equal(s.service.state().totalReservedUsd, 0.12);
  release();
  assert.deepEqual(await a, await b);
  assert.equal(s.calls.length, 3);
});

test("BGM isolates rejected submissions and conservatively retains all reservations", async (t) => {
  const s = setup(t, (_call, count) => count === 2 ? json({ detail: key }, 422) : json({ request_id: `req-${count}` }), 0.12);
  const state = await s.service.generate(input);
  assert.deepEqual(state.candidates.map((c) => c.status), ["queued", "failed", "queued"]);
  assert.equal(state.totalReservedUsd, 0.12);
  assert.equal(JSON.stringify(state).includes(key), false);
  await assert.rejects(s.service.generate(input), /budget/i);
  await assert.rejects(s.service.retry(state.candidates[1].id), /budget/i);
  assert.equal(s.calls.length, 3);
});

test("BGM never retries an unknown submit outcome", async (t) => {
  const s = setup(t, (_call, count) => { if (count === 2) throw new Error(`network ${key}`); return json({ request_id: `req-${count}` }); });
  const state = await s.service.generate(input);
  assert.equal(state.candidates[1].status, "uncertain");
  assert.equal(JSON.stringify(state).includes(key), false);
  await assert.rejects(s.service.retry(state.candidates[1].id), /failed/i);
  await s.service.refresh(state.candidates[1].id);
  const reopened = new BgmService({ root: s.root, getKey: () => key, fetch: s.fakeFetch });
  assert.equal(reopened.state().candidates[1].status, "uncertain");
  assert.equal(s.calls.length, 3);
});

test("BGM malformed request IDs cannot be polled or retried", async (t) => {
  const s = setup(t, (_call, count) => json({ request_id: count === 2 ? "../../private" : `req-${count}` }));
  const state = await s.service.generate(input);
  assert.equal(state.candidates[1].status, "uncertain");
  assert.equal(state.candidates[1].requestId, undefined);
  await s.service.refresh(state.candidates[1].id);
  await assert.rejects(s.service.retry(state.candidates[1].id));
  assert.equal(s.calls.length, 3);
});

test("BGM rejects unsafe returned queue URLs and preserves the accepted request ID", async (t) => {
  const s = setup(t, (_call, count) => json({ request_id: `req-${count}`, status_url: "https://evil.example/steal-key" }));
  const state = await s.service.generate(input);
  assert.equal(state.candidates[0].requestId, "req-1");
  assert.equal(state.candidates[0].status, "uncertain");
  await assert.rejects(s.service.retry(state.candidates[0].id));
  assert.equal(s.calls.length, 3);
  assert.equal(fs.readFileSync(path.join(s.root, "ledger.json"), "utf8").includes("evil.example"), false);
});

test("BGM restart only polls original IDs and makes durable local previews", async (t) => {
  const s = setup(t, (call, count) => {
    if (call.init?.method === "POST") return json({ request_id: `req-${count}`, status_url: `${queue}/requests/req-${count}/status`, response_url: `${queue}/requests/req-${count}` });
    if (call.url.endsWith("/status")) return json({ status: "COMPLETED" });
    if (call.url.includes("/requests/")) return json({ audio: { url: "https://v3.fal.media/files/music.mp3" } });
    assert.equal(new Headers(call.init?.headers).has("authorization"), false);
    assert.equal(call.init?.redirect, "error");
    return new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
  });
  const state = await s.service.generate(input);
  const reopened = new BgmService({ root: s.root, getKey: () => key, fetch: s.fakeFetch });
  assert.equal(s.calls.length, 3);
  const ready = await reopened.refresh(state.candidates[0].id);
  assert.equal(ready.candidates[0].status, "ready");
  assert.equal(ready.candidates[0].previewUrl, `bgm-media://track/${state.candidates[0].id}`);
  assert.deepEqual(fs.readFileSync(reopened.localFile(state.candidates[0].id)), mp3);
  assert.equal(reopened.select(state.candidates[0].id).selectedId, state.candidates[0].id);
  assert.throws(() => reopened.localFile("../../secret"));
  assert.throws(() => reopened.localFile(state.candidates[1].id));
  const noKey = new BgmService({ root: s.root, getKey: () => undefined, fetch: s.fakeFetch });
  assert.equal(noKey.state().selectedId, state.candidates[0].id);
  assert.deepEqual(fs.readFileSync(noKey.localFile(state.candidates[0].id)), mp3);
  assert.equal(s.calls.filter((c) => c.init?.method === "POST").length, 3);
  assert.equal(JSON.stringify(ready).includes("https://"), false);
});

test("BGM accepts string audio results and retries downloads without resubmitting", async (t) => {
  let downloads = 0;
  const s = setup(t, (call, count) => {
    if (call.init?.method === "POST") return json({ request_id: `req-${count}` });
    if (call.url.endsWith("/status")) return json({ status: "COMPLETED" });
    if (call.url.includes("/requests/")) return json({ audio: "https://v3b.fal.media/files/music.mp3" });
    downloads++;
    return downloads === 1 ? new Response("temporary", { status: 503 }) : new Response(mp3);
  });
  const first = (await s.service.generate(input)).candidates[0];
  assert.equal((await s.service.refresh(first.id)).candidates[0].status, "download-pending");
  const restarted = new BgmService({ root: s.root, getKey: () => key, fetch: s.fakeFetch });
  assert.equal((await restarted.refresh(first.id)).candidates[0].status, "ready");
  assert.equal(s.calls.filter((c) => c.init?.method === "POST").length, 3);
});

test("BGM explicit retry appends one candidate without changing its originals", async (t) => {
  const s = setup(t, (_call, count) => count === 2 ? json({}, 400) : json({ request_id: `req-${count}` }));
  const before = await s.service.generate(input);
  assert.equal((before.candidates[1] as { canRetry?: boolean }).canRetry, true);
  const [a, b] = await Promise.all([s.service.retry(before.candidates[1].id), s.service.retry(before.candidates[1].id)]);
  assert.deepEqual(a, b);
  assert.equal(a.candidates.length, 4);
  const withoutEligibility = ({ canRetry: _canRetry, ...candidate }: typeof before.candidates[number]) => candidate;
  assert.deepEqual(a.candidates.slice(0, 3).map(withoutEligibility), before.candidates.map(withoutEligibility));
  assert.equal(a.totalReservedUsd, 0.16);
  assert.equal(s.calls.length, 4);
  await assert.rejects(s.service.retry(before.candidates[0].id));
  await assert.rejects(s.service.retry(before.candidates[1].id));
  assert.equal((s.service.state().candidates[1] as { canRetry?: boolean }).canRetry, false);
});

test("BGM restart marks an interrupted submitting record uncertain without network", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const s = setup(t, async (_call, count) => { await gate; return json({ request_id: `req-${count}` }); });
  const running = s.service.generate(input);
  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), "bgm-restart-"));
  t.after(() => fs.rmSync(snapshot, { recursive: true, force: true }));
  fs.cpSync(s.root, snapshot, { recursive: true });
  const restart = new BgmService({ root: snapshot, getKey: () => key, fetch: s.fakeFetch });
  assert.equal(restart.state().totalReservedUsd, 0.12);
  assert.ok(restart.state().candidates.every((c) => c.status === "uncertain"));
  assert.equal(s.calls.length, 1);
  release();
  await running;
});

test("BGM invalid media URLs never trigger an off-host download", async (t) => {
  const urls = ["http://v3.fal.media/a.mp3", "https://fal.media.evil.test/a.mp3", "https://127.0.0.1/a.mp3", "https://user:password@v3.fal.media/a.mp3", "https://v3.fal.media:8443/a.mp3", "file:///secret.mp3"];
  for (const url of urls) {
    const s = setup(t, (call, count) => {
      if (call.init?.method === "POST") return json({ request_id: `req-${count}` });
      if (call.url.endsWith("/status")) return json({ status: "COMPLETED" });
      return json({ audio: { url } });
    });
    const id = (await s.service.generate(input)).candidates[0].id;
    assert.equal((await s.service.refresh(id)).candidates[0].status, "download-pending");
    assert.equal(s.calls.length, 5);
    assert.throws(() => s.service.localFile(id));
  }
});

test("BGM rejects non-MP3 and oversized media without creating a ready file", async (t) => {
  for (const response of [new Response("<html>not music</html>"), new Response("ID3just text"), new Response(mp3, { headers: { "content-length": String(21 * 1024 * 1024) } })]) {
    const s = setup(t, (call, count) => {
      if (call.init?.method === "POST") return json({ request_id: `req-${count}` });
      if (call.url.endsWith("/status")) return json({ status: "COMPLETED" });
      if (call.url.includes("/requests/")) return json({ audio: "https://fal.media/files/a.mp3" });
      return response;
    });
    const id = (await s.service.generate(input)).candidates[0].id;
    assert.equal((await s.service.refresh(id)).candidates[0].status, "download-pending");
    assert.throws(() => s.service.localFile(id));
  }
});

test("BGM fails closed on corrupt ledger and does not create requests without credentials", async (t) => {
  const s = setup(t);
  fs.writeFileSync(path.join(s.root, "ledger.json"), "{bad");
  assert.throws(() => new BgmService({ root: s.root, getKey: () => key, fetch: s.fakeFetch }), /ledger|storage/i);
  fs.unlinkSync(path.join(s.root, "ledger.json"));
  const noKey = new BgmService({ root: s.root, getKey: () => undefined, fetch: s.fakeFetch });
  assert.equal(noKey.state().configured, false);
  await assert.rejects(noKey.generate(input), /FAL_KEY|credential/i);
  assert.equal(noKey.state().totalReservedUsd, 0);
  assert.equal(s.calls.length, 0);
});

test("BGM journals recover request IDs after an interrupted ledger update", async (t) => {
  let beforeAcceptance = "";
  let s: ReturnType<typeof setup>;
  s = setup(t, (_call, count) => {
    if (count === 1) beforeAcceptance = fs.readFileSync(path.join(s.root, "ledger.json"), "utf8");
    return json({ request_id: `req-${count}` });
  });
  await s.service.generate(input);
  fs.writeFileSync(path.join(s.root, "ledger.json"), beforeAcceptance);
  const restart = new BgmService({ root: s.root, getKey: () => key, fetch: s.fakeFetch });
  assert.deepEqual(restart.state().candidates.map((c) => c.requestId), ["req-1", "req-2", "req-3"]);
  assert.equal(restart.state().totalReservedUsd, 0.12);
  assert.equal(s.calls.length, 3);
});

test("BGM halts remaining submissions when accepted ID checkpoint cannot update ledger", async (t) => {
  const rename = fs.renameSync;
  let s: ReturnType<typeof setup>;
  s = setup(t, (_call, count) => {
    t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
      if (String(destination) === path.join(s.root, "ledger.json")) throw new Error("disk unavailable");
      return rename(source, destination);
    });
    return json({ request_id: `req-${count}` });
  });
  await assert.rejects(s.service.generate(input), /storage/i);
  assert.equal(s.calls.length, 1);
  t.mock.restoreAll();
  const restart = new BgmService({ root: s.root, getKey: () => key, fetch: s.fakeFetch });
  assert.equal(restart.state().candidates[0].requestId, "req-1");
  assert.equal(restart.state().candidates[0].status, "queued");
  assert.deepEqual(restart.state().candidates.slice(1).map((c) => c.status), ["uncertain", "uncertain"]);
  assert.equal(restart.state().totalReservedUsd, 0.12);
  assert.equal(s.calls.length, 1);
});

test("BGM transient status errors keep the same request, confirmed terminal errors allow explicit retry", async (t) => {
  let terminal = false;
  const s = setup(t, (call, count) => {
    if (call.init?.method === "POST") return json({ request_id: `req-${count}` });
    return terminal ? json({ status: "COMPLETED", error: key }) : json({ detail: key }, 500);
  });
  const id = (await s.service.generate(input)).candidates[0].id;
  const transient = await s.service.refresh(id);
  assert.equal(transient.candidates[0].status, "queued");
  assert.equal(transient.candidates[0].requestId, "req-1");
  await assert.rejects(s.service.retry(id));
  terminal = true;
  const failed = await s.service.refresh(id);
  assert.equal(failed.candidates[0].status, "failed");
  assert.equal(JSON.stringify(failed).includes(key), false);
  const retried = await s.service.retry(id);
  assert.equal(retried.candidates.length, 4);
  assert.equal(retried.candidates[3].status, "queued");
});

test("BGM refresh recovers a missing ready local MP3 without a new generation", async (t) => {
  const s = setup(t, (call, count) => {
    if (call.init?.method === "POST") return json({ request_id: `req-${count}` });
    if (call.url.endsWith("/status")) return json({ status: "COMPLETED" });
    if (call.url.includes("/requests/")) return json({ audio: "https://v3.fal.media/a.mp3" });
    return new Response(mp3);
  });
  const id = (await s.service.generate(input)).candidates[0].id;
  await s.service.refresh(id);
  fs.unlinkSync(s.service.localFile(id));
  assert.equal((await s.service.refresh(id)).candidates[0].status, "ready");
  assert.deepEqual(fs.readFileSync(s.service.localFile(id)), mp3);
  assert.equal(s.calls.filter((c) => c.init?.method === "POST").length, 3);
});

test("BGM rejected requests give actionable Korean errors without provider text", async (t) => {
  for (const [status, text] of [[401, "인증"], [402, "잔액"], [422, "프롬프트"], [429, "제한"]] as const) {
    const s = setup(t, () => json({ detail: key }, status));
    const result = await s.service.generate(input);
    assert.ok(result.candidates[0].error?.includes(text));
    assert.equal(JSON.stringify(result).includes(key), false);
  }
});

test("BGM restart recovers a saved MP3 when the ready checkpoint was interrupted", async (t) => {
  const s = setup(t);
  const id = (await s.service.generate(input)).candidates[0].id;
  // The download was atomically saved immediately before the process stopped.
  fs.writeFileSync(path.join(s.root, "media", `${id}.mp3`), mp3);
  const restart = new BgmService({ root: s.root, getKey: () => undefined, fetch: s.fakeFetch });
  assert.equal(restart.state().candidates[0].status, "ready");
  assert.deepEqual(fs.readFileSync(restart.localFile(id)), mp3);
  assert.equal(s.calls.length, 3);
});
