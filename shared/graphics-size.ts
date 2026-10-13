/** Unity axes: X width, Y height, Z depth. This contract never implies provider output units. */
export type PhysicalSize = { mode: "keep" | "uniform" | "axes"; axis: "x" | "y" | "z"; lengthMeters: number; dimensionsMeters: { x: number; y: number; z: number }; pivot: "keep" | "bottom-center" | "center" };
export type SizeVector = { x: number; y: number; z: number };
export const defaultPhysicalSize = (): PhysicalSize => ({ mode: "keep", axis: "y", lengthMeters: 1, dimensionsMeters: { x: 1, y: 1, z: 1 }, pivot: "keep" });
export function normalizePhysicalSize(value: unknown): PhysicalSize {
  if (value === undefined || value === null || value === "") return defaultPhysicalSize();
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { throw Error("실제 크기 설정 형식이 잘못됐습니다."); } }
  if (typeof value !== "object" || !value || Array.isArray(value)) throw Error("실제 크기 설정이 잘못됐습니다.");
  const v = value as Partial<PhysicalSize>, d = defaultPhysicalSize();
  const mode = v.mode ?? d.mode, axis = v.axis ?? d.axis, pivot = v.pivot ?? d.pivot;
  const lengthMeters = v.lengthMeters ?? d.lengthMeters, dimensionsMeters = { ...d.dimensionsMeters, ...v.dimensionsMeters };
  if (!["keep", "uniform", "axes"].includes(mode) || !["x", "y", "z"].includes(axis) || !["keep", "bottom-center", "center"].includes(pivot)) throw Error("크기 모드·기준 축·피벗 선택을 확인하세요.");
  if ([lengthMeters, ...Object.values(dimensionsMeters)].some(n => typeof n !== "number" || !Number.isFinite(n) || n < .000001 || n > 1000000)) throw Error("실제 길이는 0.000001–1,000,000 미터 사이의 양수여야 합니다.");
  return { mode, axis, lengthMeters, dimensionsMeters, pivot };
}
export function physicalSizeSummary(value: unknown): string {
  const s = normalizePhysicalSize(value);
  return s.mode === "keep" ? "원본 크기 유지" : s.mode === "uniform" ? `${({x:"가로",y:"높이",z:"깊이"})[s.axis]} ${s.lengthMeters}m · 비율 유지` : `${s.dimensionsMeters.x} × ${s.dimensionsMeters.y} × ${s.dimensionsMeters.z}m`;
}
export function physicalSizeTransform(bounds: { min: SizeVector; max: SizeVector }, value: unknown, restricted = false) {
  const settings = normalizePhysicalSize(value), axes = ["x", "y", "z"] as const;
  const dimensions = Object.fromEntries(axes.map(axis => [axis, bounds.max[axis] - bounds.min[axis]])) as SizeVector;
  if (axes.some(axis => !Number.isFinite(dimensions[axis]) || dimensions[axis] < 0)) throw Error("유효한 모델 치수를 측정하지 못했습니다.");
  if (settings.mode === "axes" && restricted) throw Error("리그·스킨·애니메이션·셰이프 키는 비율 유지 크기 변경만 지원합니다.");
  const factors: SizeVector = { x: 1, y: 1, z: 1 };
  if (settings.mode === "uniform") {
    if (dimensions[settings.axis] < 1e-9) throw Error("선택한 기준 축의 원본 길이가 0입니다.");
    const factor = settings.lengthMeters / dimensions[settings.axis];
    factors.x = factors.y = factors.z = factor;
  } else if (settings.mode === "axes") {
    for (const axis of axes) { if (dimensions[axis] < 1e-9) throw Error("평면·길이 0인 축은 축별 크기를 맞출 수 없습니다."); factors[axis] = settings.dimensionsMeters[axis] / dimensions[axis]; }
  }
  const anchor: SizeVector = { x: 0, y: 0, z: 0 };
  if (settings.pivot !== "keep") {
    for (const axis of axes) anchor[axis] = (bounds.min[axis] + bounds.max[axis]) / 2;
    if (settings.pivot === "bottom-center") anchor.y = bounds.min.y;
  }
  const actual = Object.fromEntries(axes.map(axis => [axis, dimensions[axis] * factors[axis]])) as SizeVector;
  return { settings, factors, anchor, dimensions: actual };
}
