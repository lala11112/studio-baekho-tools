import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveBgmMedia } from "../electron/bgm-media";

test("BGM media resolves an ID and supports seek ranges without arbitrary paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bgm-media-"));
  const file = path.join(root, "fixture.mp3");
  fs.writeFileSync(file, Buffer.from("ID3abcdefghijk"));
  const resolve = (id: string) => { assert.equal(id, "known-id"); return file; };
  try {
    const full = await serveBgmMedia(new Request("bgm-media://track/known-id"), resolve);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "audio/mpeg");
    assert.equal(await full.text(), "ID3abcdefghijk");
    const partial = await serveBgmMedia(new Request("bgm-media://track/known-id", { headers: { Range: "bytes=3-5" } }), resolve);
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), "bytes 3-5/14");
    assert.equal(await partial.text(), "abc");
    const suffix = await serveBgmMedia(new Request("bgm-media://track/known-id", { headers: { Range: "bytes=-3" } }), resolve);
    assert.equal(await suffix.text(), "ijk");
    assert.equal((await serveBgmMedia(new Request("bgm-media://track/known-id", { headers: { Range: "bytes=90-100" } }), resolve)).status, 416);
    assert.equal((await serveBgmMedia(new Request("bgm-media://other/known-id"), resolve)).status, 404);
    assert.equal((await serveBgmMedia(new Request("bgm-media://track/a/b"), resolve)).status, 404);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
