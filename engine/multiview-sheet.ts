import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import type { WorkbenchView } from "../shared/workbench";

export type MultiviewSheetRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MultiviewSheet = {
  width: number;
  height: number;
  images: {
    view: WorkbenchView;
    png: Buffer;
    width: number;
    height: number;
    region: MultiviewSheetRegion;
  }[];
};

export class MultiviewSheetError extends Error {
  constructor(
    readonly code:
      | "invalid_views"
      | "invalid_png"
      | "image_too_large"
      | "unsupported_png"
      | "invalid_layout"
      | "empty_view"
      | "opaque_view"
      | "clipped_view"
      | "unexpected_view"
      | "duplicate_view",
    message: string,
  ) {
    super(`멀티뷰 사진 분할 중단: ${message} 저장된 원본을 확인해 주세요.`);
    this.name = "MultiviewSheetError";
  }
}

const VIEW_ORDER: WorkbenchView[] = ["front", "back", "left", "right"];
const VIEW_LABEL: Record<WorkbenchView, string> = {
  front: "정면",
  back: "후면",
  left: "캐릭터 왼쪽",
  right: "캐릭터 오른쪽",
};
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_EDGE = 8192;
const MAX_PIXELS = 16 * 1024 * 1024;
const FOREGROUND_ALPHA = 16;
const SOLID_BORDER_ALPHA = 128;
const MAX_SOFT_STRAY_PIXELS = 2;

/**
 * Decode once and crop a fixed 2×2 sheet: front/back above left/right. Left/right
 * refer to the character, and are never inferred, mirrored, resized or painted.
 * Only requested cells are returned; every other cell must be transparent.
 * Cell borders must be transparent, except at most two stray pixels with alpha
 * 1–127. Those pixels are retained verbatim, not removed. An alpha >=128 border
 * pixel, or more soft border pixels, blocks a potentially destructive crop.
 * This is a local preparation failure, never permission to regenerate a sheet.
 */
export function splitMultiviewSheet(
  bytes: Buffer,
  views: WorkbenchView[],
): MultiviewSheet {
  if (
    !Array.isArray(views) ||
    views.length === 0 ||
    views.length > 4 ||
    views.some((view) => !VIEW_ORDER.includes(view)) ||
    new Set(views).size !== views.length
  )
    throw new MultiviewSheetError(
      "invalid_views",
      "요청 방향은 정면·후면·왼쪽·오른쪽 중 중복 없이 1~4개여야 합니다.",
    );

  // Guard the compressed bytes and IHDR before pngjs allocates/inflates pixels.
  const { width, height } = inspectHeader(bytes);
  let decoded: PNG;
  try {
    decoded = PNG.sync.read(bytes, { checkCRC: true });
  } catch {
    throw new MultiviewSheetError(
      "invalid_png",
      "PNG 데이터를 읽을 수 없거나 파일이 손상되었습니다.",
    );
  }
  if (
    decoded.width !== width ||
    decoded.height !== height ||
    decoded.data.length !== width * height * 4
  )
    throw new MultiviewSheetError(
      "invalid_png",
      "PNG 헤더와 실제 픽셀 크기가 일치하지 않습니다.",
    );

  const cellWidth = width / 2;
  const cellHeight = height / 2;
  const requested = new Set(views);
  const images: MultiviewSheet["images"] = [];
  const fingerprints = new Map<string, WorkbenchView>();
  for (const [index, view] of VIEW_ORDER.entries()) {
    const region = {
      x: (index % 2) * cellWidth,
      y: Math.floor(index / 2) * cellHeight,
      width: cellWidth,
      height: cellHeight,
    };
    const data = Buffer.alloc(cellWidth * cellHeight * 4);
    for (let y = 0; y < cellHeight; y++) {
      const start = ((region.y + y) * width + region.x) * 4;
      decoded.data.copy(data, y * cellWidth * 4, start, start + cellWidth * 4);
    }
    const observation = measureCell(data, cellWidth, cellHeight);
    if (!requested.has(view)) {
      if (
        observation.foreground > 0 ||
        observation.nonzero > MAX_SOFT_STRAY_PIXELS
      )
        throw new MultiviewSheetError(
          "unexpected_view",
          `요청하지 않은 ${VIEW_LABEL[view]} 칸에 내용이 있습니다. 기존 사진을 보존하려면 해당 칸이 투명해야 합니다.`,
        );
      continue;
    }
    if (!observation.foreground)
      throw new MultiviewSheetError(
        "empty_view",
        `${VIEW_LABEL[view]} 칸이 비어 있거나 유효한 파츠가 없습니다.`,
      );
    if (!observation.transparent)
      throw new MultiviewSheetError(
        "opaque_view",
        `${VIEW_LABEL[view]} 칸에 투명 배경이 없습니다. 배경을 임의로 지우지 않았습니다.`,
      );
    if (
      observation.hardBorder > 0 ||
      observation.softBorder > MAX_SOFT_STRAY_PIXELS
    )
      throw new MultiviewSheetError(
        "clipped_view",
        `${VIEW_LABEL[view]} 파츠가 칸 경계에 닿아 잘릴 수 있습니다. 2×2 배치와 각 칸의 투명 여백을 확인해야 합니다.`,
      );

    // Invisible RGB values must not disguise copied views. Output RGBA still
    // retains every original sample, including the invisible RGB values.
    const comparable = Buffer.from(data);
    for (let offset = 0; offset < comparable.length; offset += 4)
      if (comparable[offset + 3] === 0) comparable.fill(0, offset, offset + 3);
    const fingerprint = createHash("sha256").update(comparable).digest("hex");
    const duplicate = fingerprints.get(fingerprint);
    if (duplicate)
      throw new MultiviewSheetError(
        "duplicate_view",
        `${VIEW_LABEL[duplicate]}과 ${VIEW_LABEL[view]} 칸의 픽셀이 같습니다. 다른 방향을 복사본으로 대신할 수 없습니다.`,
      );
    fingerprints.set(fingerprint, view);
    const png = new PNG({ width: cellWidth, height: cellHeight });
    png.data = data;
    png.gamma = decoded.gamma;
    images.push({
      view,
      png: PNG.sync.write(png, { colorType: 6, inputColorType: 6 }),
      width: cellWidth,
      height: cellHeight,
      region,
    });
  }
  return { width, height, images };
}

function inspectHeader(bytes: Buffer): { width: number; height: number } {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33)
    throw new MultiviewSheetError("invalid_png", "올바른 PNG 파일이 아닙니다.");
  if (bytes.length > MAX_BYTES)
    throw new MultiviewSheetError(
      "image_too_large",
      "PNG 파일이 64 MiB 제한을 초과합니다.",
    );
  if (
    !bytes.subarray(0, 8).equals(SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new MultiviewSheetError("invalid_png", "올바른 PNG 헤더가 없습니다.");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS)
    throw new MultiviewSheetError(
      "image_too_large",
      "사진은 한 변 8192픽셀, 전체 16,777,216픽셀 이하여야 합니다.",
    );
  if (width < 8 || height < 8 || width % 2 !== 0 || height % 2 !== 0)
    throw new MultiviewSheetError(
      "invalid_layout",
      "2×2 사진은 가로·세로가 각각 8픽셀 이상인 짝수여야 합니다.",
    );
  // pngjs uses unbounded zlib.inflateSync for interlaced PNGs. Reject that
  // variant before decode, and avoid silently reducing 16-bit source samples.
  if (bytes[24] !== 8 || bytes[28] !== 0)
    throw new MultiviewSheetError(
      "unsupported_png",
      "8비트 비인터레이스 PNG가 필요합니다. 저장된 원본의 형식을 확인해야 합니다.",
    );
  let offset = 8;
  let chunks = 0;
  let sawData = false;
  let sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (end > bytes.length || ++chunks > 4096)
      throw new MultiviewSheetError(
        "invalid_png",
        "PNG 청크가 손상되었습니다.",
      );
    if (type === "IHDR" && offset !== 8)
      throw new MultiviewSheetError(
        "invalid_png",
        "PNG 헤더가 중복되었습니다.",
      );
    if (["acTL", "fcTL", "fdAT"].includes(type))
      throw new MultiviewSheetError(
        "unsupported_png",
        "움직이는 PNG 대신 정적인 2×2 사진이 필요합니다.",
      );
    if (type === "IDAT") sawData = true;
    if (type === "IEND") {
      sawEnd = length === 0 && end === bytes.length;
      break;
    }
    offset = end;
  }
  if (!sawData || !sawEnd)
    throw new MultiviewSheetError(
      "invalid_png",
      "PNG 픽셀 데이터 또는 파일 끝이 올바르지 않습니다.",
    );
  return { width, height };
}

function measureCell(data: Buffer, width: number, height: number) {
  let foreground = 0;
  let transparent = 0;
  let nonzero = 0;
  let hardBorder = 0;
  let softBorder = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha === 0) transparent++;
      else nonzero++;
      if (alpha >= FOREGROUND_ALPHA) foreground++;
      if (x !== 0 && x !== width - 1 && y !== 0 && y !== height - 1) continue;
      if (alpha >= SOLID_BORDER_ALPHA) hardBorder++;
      else if (alpha > 0) softBorder++;
    }
  return { foreground, transparent, nonzero, hardBorder, softBorder };
}
