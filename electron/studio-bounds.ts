import type { StudioBounds } from "../shared/studio";

export function fitStudioBounds(input: unknown, width: number, height: number): StudioBounds {
  if (!input || typeof input !== "object") throw new Error("작업 영역을 확인할 수 없습니다.");
  const b = input as StudioBounds;
  if (![b.x, b.y, b.width, b.height].every(n => typeof n === "number" && Number.isFinite(n)) || b.width < 1 || b.height < 1)
    throw new Error("작업 영역 크기가 올바르지 않습니다.");
  const x = Math.max(0, Math.min(Math.round(b.x), Math.max(0, width - 1)));
  const y = Math.max(0, Math.min(Math.round(b.y), Math.max(0, height - 1)));
  return { x, y, width: Math.max(1, Math.min(Math.round(b.width), width - x)), height: Math.max(1, Math.min(Math.round(b.height), height - y)) };
}
