/** Published Runway rate, checked 2026-10-11. This is an estimate, not a live quote. */
export const RUNWAY_RATE = { model: "gen-4.5", resolution: "1080p", creditsPerSecond: 12,
  source: "https://runway.com/pricing", checkedAt: "2026-10-11" } as const;
export function runwayEstimate(duration: number) {
  if (!Number.isInteger(duration) || duration < 2 || duration > 10) throw Error("Runway 영상 길이는 2~10초 정수로 설정하세요.");
  return duration * RUNWAY_RATE.creditsPerSecond;
}
