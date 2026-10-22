import { test } from "node:test";
import assert from "node:assert/strict";
import { renderRunwayFrame, runwayFrameLayout } from "../shared/runway-framing";

test("idle and jump retain every asymmetric original pixel with no scaling/crop and greater jump headroom", () => {
  const w = 37, h = 41, source = Uint8Array.from({ length: w * h * 4 }, (_, i) => (i * 17 + 11) % 256);
  const idle = runwayFrameLayout(w, h, true), jump = runwayFrameLayout(w, h, false);
  assert(jump.y / jump.height > idle.y / idle.height);
  for (const frame of [idle, jump]) {
    assert.equal(frame.width / frame.height, 16 / 9); assert(frame.x > 0 && frame.y > 0);
    assert(frame.height - frame.y - h >= frame.height * .09);
    const result = renderRunwayFrame(source, frame);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const input = (y * w + x) * 4, output = ((y + frame.y) * frame.width + x + frame.x) * 4;
      assert.deepEqual([...result.slice(output, output + 4)], [...source.slice(input, input + 4)]);
    }
  }
});

test("oversized or invalid framing fails before allocation", () => {
  assert.throws(() => runwayFrameLayout(8192, 8192, false), /너무 큽/);
  assert.throws(() => runwayFrameLayout(0, 42, true));
  assert.throws(() => runwayFrameLayout(1.5, 42, true));
});
