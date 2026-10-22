import { test } from "node:test";
import assert from "node:assert/strict";
import { fitStudioBounds } from "../electron/studio-bounds";

test("native workspace follows the actual content area after resize", () => {
  assert.deepEqual(fitStudioBounds({ x: 220.3, y: 96.6, width: 1400, height: 1000 }, 1180, 760), { x: 220, y: 97, width: 960, height: 663 });
});
test("native workspace rejects malformed geometry instead of throwing in native code", () => {
  for (const value of [null, {}, { x: 0, y: 0, width: NaN, height: 1 }, { x: 0, y: 0, width: 2, height: Infinity }, { x: 0, y: 0, width: 0, height: 1 }]) assert.throws(() => fitStudioBounds(value, 1180, 760));
});
test("native workspace never extends outside a minimized or shrinking host", () => {
  assert.deepEqual(fitStudioBounds({ x: 220, y: 100, width: 1, height: 1 }, 100, 80), { x: 99, y: 79, width: 1, height: 1 });
});
