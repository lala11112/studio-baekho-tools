import type { WorkbenchRole, WorkbenchView } from "../shared/workbench";

/** Decoded, straight-alpha RGBA pixels. The caller owns image decoding/PNG encoding. */
export type SeparationImage = {
  id: string;
  role: WorkbenchRole;
  view: WorkbenchView;
  width: number;
  height: number;
  rgba: Uint8Array;
};
export type ImageBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type SeparationNormalizationIssue = {
  id: string;
  role: WorkbenchRole;
  code:
    | "invalid_pixels"
    | "duplicate_view"
    | "missing_front"
    | "missing_views"
    | "empty_foreground"
    | "opaque_background"
    | "clipped_source"
    | "fit_reduced";
  severity: "warning" | "needs_input";
  message: string;
};
export type SeparationNormalizationOptions = {
  canvasSize?: number;
  paddingFraction?: number;
  alphaThreshold?: number;
};
export type NormalizedSeparationImage = SeparationImage & {
  transform: {
    version: 1;
    anchorId: string;
    sourceWidth: number;
    sourceHeight: number;
    sourceBounds: ImageBounds;
    targetBounds: ImageBounds;
    scale: number;
    offsetX: number;
    offsetY: number;
  };
};
export type SeparationNormalization = {
  status: "normalized" | "partial" | "needs_input";
  images: NormalizedSeparationImage[];
  issues: SeparationNormalizationIssue[];
  groups: {
    role: WorkbenchRole;
    anchorId: string;
    targetHeight: number;
    missingViews: WorkbenchView[];
  }[];
};

const roles: WorkbenchRole[] = ["head", "hair", "body"];
const views: WorkbenchView[] = ["front", "back", "left", "right"];
type Measured = {
  source: SeparationImage;
  bounds: ImageBounds;
  support: ImageBounds;
};

/**
 * Normalize derivatives only: inputs are never modified and no files are read/written.
 * All views of one part share a front-anchored silhouette height and centered bounds.
 * A transparent canvas is required; an opaque background is never guessed or removed.
 */
export function normalizeSeparationImages(
  sources: SeparationImage[],
  options: SeparationNormalizationOptions = {},
): SeparationNormalization {
  const size = options.canvasSize ?? 2048;
  const padding = options.paddingFraction ?? 0.08;
  const threshold = options.alphaThreshold ?? 16;
  if (!Number.isSafeInteger(size) || size < 16 || size > 4096)
    throw new Error("Normalization canvas must be 16–4096 pixels square");
  if (!Number.isFinite(padding) || padding < 0 || padding >= 0.45)
    throw new Error("Normalization padding must be between 0 and 0.45");
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > 254)
    throw new Error("Alpha threshold must be an integer from 1 to 254");
  const images: NormalizedSeparationImage[] = [],
    issues: SeparationNormalizationIssue[] = [],
    groups: SeparationNormalization["groups"] = [];
  const measured: Measured[] = [];
  const seenIds = new Set<string>();
  for (const source of sources) {
    const issue = (
      code: SeparationNormalizationIssue["code"],
      message: string,
      severity: SeparationNormalizationIssue["severity"] = "needs_input",
    ) =>
      issues.push({
        id: source.id,
        role: source.role,
        code,
        message,
        severity,
      });
    if (
      !source.id ||
      seenIds.has(source.id) ||
      !roles.includes(source.role) ||
      !views.includes(source.view) ||
      !Number.isSafeInteger(source.width) ||
      !Number.isSafeInteger(source.height) ||
      source.width < 1 ||
      source.height < 1 ||
      source.width > 16384 ||
      source.height > 16384 ||
      source.width * source.height > 64 * 1024 * 1024 ||
      !(source.rgba instanceof Uint8Array) ||
      source.rgba.byteLength !== source.width * source.height * 4
    ) {
      issue(
        "invalid_pixels",
        "이미지 픽셀 크기나 식별자가 올바르지 않아 정렬하지 않았습니다.",
      );
      continue;
    }
    seenIds.add(source.id);
    let minX = source.width,
      minY = source.height,
      maxX = -1,
      maxY = -1;
    let supportMinX = source.width,
      supportMinY = source.height,
      supportMaxX = -1,
      supportMaxY = -1;
    let clearPixels = 0,
      clearBorder = 0,
      borderPixels = 0;
    for (let y = 0; y < source.height; y++)
      for (let x = 0; x < source.width; x++) {
        const alpha = source.rgba[(y * source.width + x) * 4 + 3];
        const border =
          x === 0 ||
          y === 0 ||
          x === source.width - 1 ||
          y === source.height - 1;
        if (border) borderPixels++;
        if (alpha <= Math.min(8, threshold - 1)) {
          clearPixels++;
          if (border) clearBorder++;
        }
        if (alpha > 0) {
          supportMinX = Math.min(supportMinX, x);
          supportMaxX = Math.max(supportMaxX, x);
          supportMinY = Math.min(supportMinY, y);
          supportMaxY = Math.max(supportMaxY, y);
        }
        if (alpha >= threshold) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    if (maxX < minX || maxY < minY) {
      issue(
        "empty_foreground",
        "투명 배경에서 파츠를 식별할 수 없어 정렬하지 않았습니다.",
      );
      continue;
    }
    if (
      clearPixels / (source.width * source.height) < 0.01 ||
      !borderPixels ||
      clearBorder / borderPixels < 0.5
    ) {
      issue(
        "opaque_background",
        "배경이 불투명하거나 파츠와 구분하기 어렵습니다. 원본을 유지하며, 투명 배경 이미지를 준비한 뒤 크기와 중심을 맞출 수 있습니다.",
      );
      continue;
    }
    const bounds = {
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    };
    const support = {
      x: supportMinX,
      y: supportMinY,
      width: supportMaxX - supportMinX + 1,
      height: supportMaxY - supportMinY + 1,
    };
    if (
      minX === 0 ||
      minY === 0 ||
      maxX === source.width - 1 ||
      maxY === source.height - 1
    )
      issue(
        "clipped_source",
        "파츠가 원본 이미지 가장자리에 닿아 있습니다. 중심과 크기는 맞추지만 잘린 부분을 복원하지는 않습니다.",
        "warning",
      );
    measured.push({ source, bounds, support });
  }
  for (const role of roles) {
    const partSources = sources.filter((s) => s.role === role);
    if (!partSources.length) continue;
    const part = measured.filter((s) => s.source.role === role);
    const duplicates = views.filter(
      (view) => partSources.filter((s) => s.view === view).length > 1,
    );
    if (duplicates.length) {
      for (const source of partSources)
        issues.push({
          id: source.id,
          role,
          code: "duplicate_view",
          severity: "needs_input",
          message:
            "같은 파츠·방향의 원본이 여러 장입니다. 기준 버전을 하나 선택한 뒤 정렬하세요.",
        });
      continue;
    }
    const front = part.find((s) => s.source.view === "front");
    if (!front) {
      for (const { source } of part)
        issues.push({
          id: source.id,
          role,
          code: "missing_front",
          severity: "needs_input",
          message:
            "이 파츠의 유효한 정면 이미지가 없어 다른 방향의 크기를 임의로 정하지 않았습니다.",
        });
      continue;
    }
    const usable = size * (1 - 2 * padding);
    // Preserve the front's vertical occupancy on the common canvas, then fit the
    // widest available view as one group. Independent per-view fitting is forbidden.
    const frontHeight = (size * front.bounds.height) / front.source.height;
    const widestRatio = Math.max(
      ...part.map((s) => s.bounds.width / s.bounds.height),
    );
    const targetHeight = Math.max(
      1,
      Math.min(frontHeight, usable, usable / widestRatio),
    );
    if (targetHeight + 0.001 < frontHeight)
      issues.push({
        id: front.source.id,
        role,
        code: "fit_reduced",
        severity: "warning",
        message:
          "가장 넓은 방향도 잘리지 않도록 이 파츠의 모든 방향을 같은 비율로 조금 줄였습니다.",
      });
    const missingViews = views.filter(
      (v) => !part.some((p) => p.source.view === v),
    );
    groups.push({
      role,
      anchorId: front.source.id,
      targetHeight,
      missingViews,
    });
    if (missingViews.length)
      issues.push({
        id: front.source.id,
        role,
        code: "missing_views",
        severity: "warning",
        message:
          "현재 저장된 방향만 정렬했습니다. 나머지 방향이 추가되면 같은 정면 기준으로 다시 맞춥니다.",
      });
    for (const image of part) {
      const scale = targetHeight / image.bounds.height;
      const offsetX =
        size / 2 - (image.bounds.x + image.bounds.width / 2) * scale;
      const offsetY =
        size / 2 - (image.bounds.y + image.bounds.height / 2) * scale;
      const rgba = resample(image, size, scale, offsetX, offsetY);
      images.push({
        id: image.source.id,
        role,
        view: image.source.view,
        width: size,
        height: size,
        rgba,
        transform: {
          version: 1,
          anchorId: front.source.id,
          sourceWidth: image.source.width,
          sourceHeight: image.source.height,
          sourceBounds: { ...image.bounds },
          targetBounds: {
            x: size / 2 - (image.bounds.width * scale) / 2,
            y: size / 2 - targetHeight / 2,
            width: image.bounds.width * scale,
            height: targetHeight,
          },
          scale,
          offsetX,
          offsetY,
        },
      });
    }
  }
  return {
    status:
      images.length === sources.length && images.length > 0
        ? "normalized"
        : images.length
          ? "partial"
          : "needs_input",
    images,
    issues,
    groups,
  };
}

/** Bilinear filtering in premultiplied-alpha space prevents dark/colored transparent fringes. */
function resample(
  image: Measured,
  size: number,
  scale: number,
  offsetX: number,
  offsetY: number,
) {
  const output = new Uint8Array(size * size * 4),
    source = image.source;
  const left = Math.max(0, Math.floor(offsetX + (image.support.x - 1) * scale));
  const top = Math.max(0, Math.floor(offsetY + (image.support.y - 1) * scale));
  const right = Math.min(
    size,
    Math.ceil(offsetX + (image.support.x + image.support.width + 1) * scale),
  );
  const bottom = Math.min(
    size,
    Math.ceil(offsetY + (image.support.y + image.support.height + 1) * scale),
  );
  for (let y = top; y < bottom; y++) {
    const sy = (y + 0.5 - offsetY) / scale - 0.5,
      y0 = Math.floor(sy),
      fy = sy - y0;
    for (let x = left; x < right; x++) {
      const sx = (x + 0.5 - offsetX) / scale - 0.5,
        x0 = Math.floor(sx),
        fx = sx - x0;
      let alpha = 0,
        red = 0,
        green = 0,
        blue = 0;
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const px = x0 + dx,
            py = y0 + dy;
          if (px < 0 || py < 0 || px >= source.width || py >= source.height)
            continue;
          const index = (py * source.width + px) * 4;
          const weightedAlpha =
            (source.rgba[index + 3] / 255) *
            (dx ? fx : 1 - fx) *
            (dy ? fy : 1 - fy);
          alpha += weightedAlpha;
          red += source.rgba[index] * weightedAlpha;
          green += source.rgba[index + 1] * weightedAlpha;
          blue += source.rgba[index + 2] * weightedAlpha;
        }
      if (alpha <= 0) continue;
      const out = (y * size + x) * 4;
      output[out] = Math.round(red / alpha);
      output[out + 1] = Math.round(green / alpha);
      output[out + 2] = Math.round(blue / alpha);
      output[out + 3] = Math.round(alpha * 255);
    }
  }
  return output;
}
