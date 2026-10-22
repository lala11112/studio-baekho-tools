import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import {
  MultiviewSheetError,
  splitMultiviewSheet,
} from "../engine/multiview-sheet";
import type { WorkbenchView } from "../shared/workbench";

const views: WorkbenchView[] = ["front", "back", "left", "right"];
const colors = [
  [220, 30, 40, 255],
  [30, 180, 40, 255],
  [30, 40, 220, 255],
  [240, 180, 10, 255],
];

function fixture(included: WorkbenchView[] = views, width = 24, height = 16) {
  const png = new PNG({ width, height });
  png.data.fill(0);
  for (const view of included) {
    const index = views.indexOf(view);
    const originX = (index % 2) * (width / 2);
    const originY = Math.floor(index / 2) * (height / 2);
    // Deliberately asymmetric L-shapes: cropping must not mirror or repaint.
    for (let y = 2; y < height / 2 - 2; y++)
      for (let x = 2; x < width / 2 - 2; x++)
        if (x === 2 || y === height / 2 - 3)
          setPixel(png, originX + x, originY + y, colors[index]);
  }
  return png;
}

function setPixel(png: PNG, x: number, y: number, pixel: number[]) {
  png.data.set(pixel, (y * png.width + x) * 4);
}

function pixel(png: PNG, x: number, y: number) {
  const offset = (y * png.width + x) * 4;
  return [...png.data.subarray(offset, offset + 4)];
}

function encode(png: PNG) {
  return PNG.sync.write(png, { colorType: 6, inputColorType: 6 });
}

function rejects(
  bytes: Buffer,
  code: MultiviewSheetError["code"],
  selected = views,
) {
  assert.throws(
    () => splitMultiviewSheet(bytes, selected),
    (error) => {
      assert.ok(error instanceof MultiviewSheetError);
      assert.equal(error.code, code);
      assert.match(error.message, /저장된 원본/);
      return true;
    },
  );
}

test("fixed 2x2 crops preserve exact RGBA, asymmetric left/right and source bytes", () => {
  const source = fixture();
  source.gamma = 0.45455;
  setPixel(source, 5, 3, [201, 77, 9, 64]);
  setPixel(source, 1, 1, [45, 100, 230, 0]);
  const bytes = encode(source);
  const before = Buffer.from(bytes);
  const result = splitMultiviewSheet(bytes, views);
  assert.deepEqual(
    { width: result.width, height: result.height },
    { width: 24, height: 16 },
  );
  assert.deepEqual(
    result.images.map((image) => image.view),
    views,
  );
  for (const [index, image] of result.images.entries()) {
    const expectedRegion = {
      x: (index % 2) * 12,
      y: Math.floor(index / 2) * 8,
      width: 12,
      height: 8,
    };
    assert.deepEqual(image.region, expectedRegion);
    assert.equal(image.width, 12);
    assert.equal(image.height, 8);
    const crop = PNG.sync.read(image.png);
    assert.equal(crop.gamma, source.gamma);
    for (let y = 0; y < crop.height; y++)
      for (let x = 0; x < crop.width; x++)
        assert.deepEqual(
          pixel(crop, x, y),
          pixel(source, x + image.region.x, y + image.region.y),
        );
    assert.deepEqual(pixel(crop, 2, 2), colors[index]);
    assert.equal(pixel(crop, 9, 2)[3], 0, "no horizontal mirroring");
  }
  assert.deepEqual(bytes, before, "the source encoded PNG is immutable");
  assert.deepEqual(
    pixel(PNG.sync.read(result.images[0].png), 1, 1),
    [45, 100, 230, 0],
  );
});

test("a missing-only subset keeps fixed cells and returns only requested views in canonical order", () => {
  const subset: WorkbenchView[] = ["right", "back", "left"];
  const result = splitMultiviewSheet(encode(fixture(subset)), subset);
  assert.deepEqual(
    result.images.map((image) => image.view),
    ["back", "left", "right"],
  );
  assert.deepEqual(result.images[0].region, {
    x: 12,
    y: 0,
    width: 12,
    height: 8,
  });
  assert.deepEqual(result.images[2].region, {
    x: 12,
    y: 8,
    width: 12,
    height: 8,
  });
  const one = splitMultiviewSheet(encode(fixture(["left"])), ["left"]);
  assert.equal(one.images.length, 1);
  assert.deepEqual(one.images[0].region, { x: 0, y: 8, width: 12, height: 8 });
});

test("unrequested cell content cannot replace preserved existing views", () => {
  rejects(encode(fixture()), "unexpected_view", ["back", "left", "right"]);
  const soft = fixture(["left"]);
  setPixel(soft, 2, 2, [200, 30, 20, 15]);
  setPixel(soft, 5, 4, [30, 220, 20, 1]);
  assert.equal(splitMultiviewSheet(encode(soft), ["left"]).images.length, 1);
  setPixel(soft, 6, 4, [30, 220, 20, 1]);
  rejects(encode(soft), "unexpected_view", ["left"]);
});

test("missing cells and faint noise cannot be accepted as a required direction", () => {
  rejects(encode(fixture(["front", "back", "left"])), "empty_view");
  const faint = fixture(["front", "back", "left"]);
  setPixel(faint, 16, 12, [30, 220, 20, 15]);
  rejects(encode(faint), "empty_view");
});

test("solid backgrounds are rejected without alpha removal", () => {
  const opaque = fixture();
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 12; x++) setPixel(opaque, x, y, [250, 250, 250, 255]);
  rejects(encode(opaque), "opaque_view");
});

test("a part crossing either center cut is blocked before any image is returned", () => {
  const vertical = fixture();
  for (let x = 10; x < 14; x++) setPixel(vertical, x, 4, [230, 20, 40, 255]);
  rejects(encode(vertical), "clipped_view");
  const horizontal = fixture();
  for (let y = 6; y < 10; y++) setPixel(horizontal, 4, y, [230, 20, 40, 255]);
  rejects(encode(horizontal), "clipped_view");
});

test("up to two soft alpha border strays are retained, but a connected soft border is blocked", () => {
  const soft = fixture();
  setPixel(soft, 11, 3, [14, 56, 198, 127]);
  setPixel(soft, 11, 5, [204, 76, 118, 1]);
  const output = splitMultiviewSheet(encode(soft), views);
  assert.deepEqual(
    pixel(PNG.sync.read(output.images[0].png), 11, 3),
    [14, 56, 198, 127],
  );
  assert.deepEqual(
    pixel(PNG.sync.read(output.images[0].png), 11, 5),
    [204, 76, 118, 1],
  );
  setPixel(soft, 11, 4, [14, 56, 198, 127]);
  rejects(encode(soft), "clipped_view");
  setPixel(soft, 11, 4, [14, 56, 198, 0]);
  setPixel(soft, 11, 3, [14, 56, 198, 128]);
  rejects(encode(soft), "clipped_view");
});

test("identical direction pixels fail even if invisible RGB differs", () => {
  const duplicate = fixture();
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 12; x++)
      setPixel(duplicate, 12 + x, y, pixel(duplicate, x, y));
  rejects(encode(duplicate), "duplicate_view");
  setPixel(duplicate, 13, 1, [220, 44, 176, 0]);
  rejects(encode(duplicate), "duplicate_view");
});

test("invalid requested views and duplicates fail before decode", () => {
  rejects(Buffer.alloc(0), "invalid_views", []);
  rejects(Buffer.alloc(0), "invalid_views", ["front", "front"]);
  rejects(Buffer.alloc(0), "invalid_views", ["side" as WorkbenchView]);
  rejects(Buffer.alloc(0), "invalid_views", [...views, "front"]);
});

test("malformed, truncated and CRC-corrupted PNG data is rejected", () => {
  rejects(Buffer.from("not a PNG"), "invalid_png");
  const valid = encode(fixture());
  rejects(valid.subarray(0, valid.length - 5), "invalid_png");
  const badCRC = Buffer.from(valid);
  badCRC[29] ^= 1;
  rejects(badCRC, "invalid_png");
  rejects(Buffer.concat([valid, Buffer.from("trailing data")]), "invalid_png");
});

test("odd or tiny canvases cannot be split into four lossless equal cells", () => {
  const valid = encode(fixture());
  for (const [width, height] of [
    [23, 16],
    [24, 15],
    [0, 16],
    [6, 6],
  ]) {
    const changed = Buffer.from(valid);
    changed.writeUInt32BE(width, 16);
    changed.writeUInt32BE(height, 20);
    rejects(changed, "invalid_layout");
  }
});

test("hostile dimensions and oversized compressed files are rejected before PNG decode", () => {
  const valid = encode(fixture());
  for (const [width, height] of [
    [8194, 16],
    [16, 8194],
    [8192, 4096],
    [0xffffffff, 0xffffffff],
  ]) {
    const changed = Buffer.from(valid);
    changed.writeUInt32BE(width, 16);
    changed.writeUInt32BE(height, 20);
    rejects(changed, "image_too_large");
  }
  rejects(Buffer.alloc(64 * 1024 * 1024 + 1), "image_too_large");
});

test("interlaced and 16-bit PNGs require an explicit local conversion rather than unsafe decoding", () => {
  const valid = encode(fixture());
  const interlaced = Buffer.from(valid);
  interlaced[28] = 1;
  rejects(interlaced, "unsupported_png");
  const deep = Buffer.from(valid);
  deep[24] = 16;
  rejects(deep, "unsupported_png");
});

test("second IHDR cannot bypass the pre-decode allocation guard and animated PNG is rejected", () => {
  const valid = encode(fixture());
  rejects(
    Buffer.concat([valid.subarray(0, 33), valid.subarray(8)]),
    "invalid_png",
  );
  const animationChunk = Buffer.alloc(20);
  animationChunk.writeUInt32BE(8, 0);
  animationChunk.write("acTL", 4, "ascii");
  rejects(
    Buffer.concat([valid.subarray(0, 33), animationChunk, valid.subarray(33)]),
    "unsupported_png",
  );
});
