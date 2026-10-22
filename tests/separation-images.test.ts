import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSeparationImages,
  type SeparationImage,
  type ImageBounds,
} from "../engine/separation-images";
import type { WorkbenchRole, WorkbenchView } from "../shared/workbench";

function rectangle(
  id: string,
  role: WorkbenchRole,
  view: WorkbenchView,
  width: number,
  height: number,
  bounds: ImageBounds,
  color = [220, 40, 20, 255],
): SeparationImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = bounds.y; y < bounds.y + bounds.height; y++)
    for (let x = bounds.x; x < bounds.x + bounds.width; x++)
      rgba.set(color, (y * width + x) * 4);
  return { id, role, view, width, height, rgba };
}
function opaqueBounds(image: SeparationImage, threshold = 128): ImageBounds {
  let left = image.width,
    top = image.height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++)
      if (image.rgba[(y * image.width + x) * 4 + 3] >= threshold) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
function pixel(image: SeparationImage, x: number, y: number) {
  return Array.from(
    image.rgba.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4),
  );
}

test("different source sizes become one common canvas with equal part silhouette height and center", () => {
  const sources = [
    rectangle("front", "head", "front", 120, 180, {
      x: 8,
      y: 55,
      width: 30,
      height: 60,
    }),
    rectangle("back", "head", "back", 300, 220, {
      x: 180,
      y: 20,
      width: 48,
      height: 120,
    }),
    rectangle("left", "head", "left", 100, 140, {
      x: 15,
      y: 40,
      width: 40,
      height: 80,
    }),
    rectangle("right", "head", "right", 240, 300, {
      x: 80,
      y: 35,
      width: 70,
      height: 140,
    }),
  ];
  const raw = sources.map((s) => new Uint8Array(s.rgba));
  const result = normalizeSeparationImages(sources, { canvasSize: 240 });
  assert.equal(result.status, "normalized");
  assert.equal(result.images.length, 4);
  for (const image of result.images) {
    assert.equal(image.width, 240);
    assert.equal(image.height, 240);
    assert.equal(image.transform.anchorId, "front");
    assert.equal(image.transform.targetBounds.height, 80);
    const actual = opaqueBounds(image);
    assert.ok(Math.abs(actual.height - 80) <= 1);
    assert.ok(Math.abs(actual.x + actual.width / 2 - 120) <= 0.5);
    assert.ok(Math.abs(actual.y + actual.height / 2 - 120) <= 0.5);
    const before = image.transform.sourceBounds;
    assert.ok(
      Math.abs(
        image.transform.targetBounds.width /
          image.transform.targetBounds.height -
          before.width / before.height,
      ) < 1e-10,
      "aspect ratio preserved",
    );
  }
  sources.forEach((source, i) =>
    assert.deepEqual(source.rgba, raw[i], "original pixels never modified"),
  );
  result.images[0].rgba.fill(0);
  assert.deepEqual(
    sources[0].rgba,
    raw[0],
    "derivative owns independent storage",
  );
});

test("default derivatives use a 2048 square canvas", () => {
  const input = rectangle("front", "body", "front", 100, 200, {
    x: 40,
    y: 80,
    width: 20,
    height: 40,
  });
  const result = normalizeSeparationImages([input]);
  assert.equal(result.images[0].width, 2048);
  assert.equal(result.images[0].height, 2048);
  assert.equal(result.images[0].rgba.byteLength, 2048 * 2048 * 4);
  assert.equal(result.groups[0].targetHeight, 409.6);
});

test("widest view reduces the entire group together without cropping or independent stretching", () => {
  const front = rectangle("front", "hair", "front", 100, 100, {
    x: 20,
    y: 10,
    width: 30,
    height: 80,
  });
  const side = rectangle("left", "hair", "left", 300, 100, {
    x: 20,
    y: 25,
    width: 240,
    height: 40,
  });
  const result = normalizeSeparationImages([front, side], {
    canvasSize: 200,
    paddingFraction: 0.1,
  });
  assert.ok(result.issues.some((i) => i.code === "fit_reduced"));
  assert.ok(
    Math.abs(
      result.images[0].transform.targetBounds.height -
        result.images[1].transform.targetBounds.height,
    ) < 1e-10,
  );
  assert.ok(
    Math.abs(result.images[1].transform.targetBounds.width - 160) < 1e-8,
  );
  for (const image of result.images) {
    const b = opaqueBounds(image);
    assert.ok(b.x >= 19 && b.x + b.width <= 181);
  }
});

test("asymmetry is preserved and transparent colored background cannot add a fringe", () => {
  const image = rectangle("front", "hair", "front", 40, 40, {
    x: 10,
    y: 10,
    width: 12,
    height: 20,
  });
  for (let y = 0; y < 40; y++)
    for (let x = 0; x < 40; x++) {
      const offset = (y * 40 + x) * 4;
      if (image.rgba[offset + 3] === 0) image.rgba[offset + 2] = 255;
      else if (x >= 16) image.rgba.set([20, 220, 40, 255], offset);
    }
  const out = normalizeSeparationImages([image], { canvasSize: 100 }).images[0];
  const left = pixel(out, 40, 50),
    right = pixel(out, 60, 50);
  assert.ok(left[0] > left[1], "red source-left remains left");
  assert.ok(right[1] > right[0], "green source-right remains right");
  for (let i = 0; i < out.rgba.length; i += 4)
    if (out.rgba[i + 3] > 0)
      assert.ok(
        out.rgba[i + 2] <= 40,
        "transparent blue pixels never contaminate visible edge",
      );
});

test("opaque or empty images are reported without inventing a crop or removing background", () => {
  const opaque = rectangle("opaque", "head", "front", 32, 32, {
    x: 0,
    y: 0,
    width: 32,
    height: 32,
  });
  const empty = {
    ...opaque,
    id: "empty",
    role: "hair" as const,
    rgba: new Uint8Array(32 * 32 * 4),
  };
  const result = normalizeSeparationImages([opaque, empty], { canvasSize: 64 });
  assert.equal(result.status, "needs_input");
  assert.equal(result.images.length, 0);
  assert.ok(result.issues.some((i) => i.code === "opaque_background"));
  assert.ok(result.issues.some((i) => i.code === "empty_foreground"));
  assert.equal(opaque.rgba[3], 255);
});

test("one invalid part does not block an independent valid part; a missing front is never guessed", () => {
  const left = rectangle("head-left", "head", "left", 100, 100, {
    x: 20,
    y: 20,
    width: 20,
    height: 30,
  });
  const body = rectangle("body-front", "body", "front", 100, 100, {
    x: 20,
    y: 20,
    width: 20,
    height: 40,
  });
  const result = normalizeSeparationImages([left, body], { canvasSize: 80 });
  assert.equal(result.status, "partial");
  assert.deepEqual(
    result.images.map((i) => i.id),
    ["body-front"],
  );
  assert.ok(
    result.issues.some(
      (i) => i.id === "head-left" && i.code === "missing_front",
    ),
  );
  assert.deepEqual(result.groups[0].missingViews, ["back", "left", "right"]);
});

test("adding another part or a fitting side view keeps unrelated derivatives identical", () => {
  const head = rectangle("head", "head", "front", 100, 100, {
    x: 20,
    y: 20,
    width: 20,
    height: 30,
  });
  const hair = rectangle("hair", "hair", "front", 100, 100, {
    x: 20,
    y: 20,
    width: 25,
    height: 40,
  });
  const old = normalizeSeparationImages([head, hair], { canvasSize: 100 });
  const side = rectangle("head-left", "head", "left", 100, 100, {
    x: 30,
    y: 35,
    width: 20,
    height: 50,
  });
  const next = normalizeSeparationImages([head, hair, side], {
    canvasSize: 100,
  });
  for (const original of old.images)
    assert.deepEqual(
      next.images.find((i) => i.id === original.id)?.rgba,
      original.rgba,
    );
});

test("ambiguous duplicate views and invalid dimensions are explicit input errors", () => {
  const front = rectangle("front", "head", "front", 100, 100, {
    x: 20,
    y: 20,
    width: 20,
    height: 30,
  });
  const duplicate = { ...front, id: "second-front" };
  const result = normalizeSeparationImages([front, duplicate], {
    canvasSize: 64,
  });
  assert.equal(result.images.length, 0);
  assert.ok(result.issues.some((i) => i.code === "duplicate_view"));
  const malformed = normalizeSeparationImages(
    [{ ...front, id: "bad", rgba: new Uint8Array(3) }],
    { canvasSize: 64 },
  );
  assert.equal(malformed.issues[0].code, "invalid_pixels");
  assert.throws(
    () => normalizeSeparationImages([front], { canvasSize: 9000 }),
    /canvas/,
  );
  assert.throws(
    () => normalizeSeparationImages([front], { paddingFraction: 0.5 }),
    /padding/,
  );
  assert.throws(
    () => normalizeSeparationImages([front], { alphaThreshold: 0 }),
    /Alpha/,
  );
});

test("a source that touches one border warns that normalization cannot restore clipped geometry", () => {
  const clipped = rectangle("front", "body", "front", 100, 100, {
    x: 0,
    y: 20,
    width: 20,
    height: 30,
  });
  const result = normalizeSeparationImages([clipped], { canvasSize: 100 });
  assert.equal(result.images.length, 1);
  assert.ok(
    result.issues.some(
      (i) => i.code === "clipped_source" && i.severity === "warning",
    ),
  );
});
