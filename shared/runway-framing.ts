/** Deterministic background extension. Original pixels are copied 1:1, never cropped/resized. */
export function runwayFrameLayout(width: number, height: number, loop: boolean) {
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 8192)) throw Error("측면 이미지 크기를 확인하세요.");
  const fill = loop ? 0.75 : 0.60;
  const unit = Math.ceil(Math.max(height / fill / 9, width / 0.80 / 16));
  const outputWidth = unit * 16, outputHeight = unit * 9;
  if (outputWidth * outputHeight > 48_000_000) throw Error("여백을 포함한 이미지가 너무 큽니다.");
  return { version: "full-body-v1" as const, ratio: "16:9" as const, width: outputWidth, height: outputHeight,
    sourceWidth: width, sourceHeight: height, x: Math.floor((outputWidth - width) / 2),
    y: loop ? Math.floor((outputHeight - height) / 2) : Math.floor(outputHeight - height - outputHeight * 0.10) };
}
export function renderRunwayFrame(pixels: Uint8Array | Uint8ClampedArray, layout: ReturnType<typeof runwayFrameLayout>) {
  const { width, height, sourceWidth: sw, sourceHeight: sh, x, y } = layout;
  if (pixels.length !== sw * sh * 4) throw Error("측면 이미지 픽셀 수가 다릅니다.");
  const output = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const sy = Math.max(0, Math.min(sh - 1, row - y));
    for (let col = 0; col < width; col++) {
      const sx = Math.max(0, Math.min(sw - 1, col - x)), from = (sy * sw + sx) * 4, to = (row * width + col) * 4;
      output[to] = pixels[from]; output[to + 1] = pixels[from + 1]; output[to + 2] = pixels[from + 2]; output[to + 3] = pixels[from + 3];
    }
  }
  return output;
}
export const RUNWAY_FULL_BODY_PROMPT = "Locked wide side-view camera. Preserve the input image's full-body framing and background margins throughout. Both ear tips, the tail and all four feet stay visible inside the frame at every moment, including the jump apex and landing. Keep the same character scale; no camera zoom, crop, pan or rotation.";
