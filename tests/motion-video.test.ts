import { test } from "node:test";
import assert from "node:assert/strict";
import { byteRange } from "../engine/byte-range";
import { validateVideoSources } from "../shared/motion-video";

test("native video seeking handles explicit, open and suffix ranges without accepting invalid ranges", () => {
  assert.equal(byteRange(null, 100), undefined);
  assert.deepEqual(byteRange("bytes=5-12", 100), { start: 5, end: 12 });
  assert.deepEqual(byteRange("bytes=50-", 100), { start: 50, end: 99 });
  assert.deepEqual(byteRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(byteRange("bytes=5-500", 100), { start: 5, end: 99 });
  for (const header of ["bytes=100-", "bytes=20-10", "bytes=0-1,4-5", "bytes=-", "bytes=-0", "bytes=9007199254740992-"])
    assert.throws(() => byteRange(header, 100));
});

test("continuous motion requires three distinct view originals and valid trim starts", () => {
  const sources = { front: { path: "front.mp4", startTime: 0 }, side: { path: "side.mp4", startTime: 0.5 }, back: { path: "back.mp4", startTime: 0 } };
  validateVideoSources(sources);
  assert.throws(() => validateVideoSources({ ...sources, back: sources.front }));
  assert.throws(() => validateVideoSources({ ...sources, side: { path: "side.mp4", startTime: -1 } }));
  assert.throws(() => validateVideoSources({ front: sources.front }));
});
