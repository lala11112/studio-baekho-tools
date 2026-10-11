/** Continuous native AI videos. Display synchronization is not a claim of pose consistency. */
export const MOTION_VIDEO_VIEWS = ["front", "side", "back"] as const;
export type MotionVideoView = (typeof MOTION_VIDEO_VIEWS)[number];
export function motionServiceUrl(text: string) {
  const url = new URL(text);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
      !url.hostname.includes(".") || /^[\d.]+$/.test(url.hostname) || url.hostname.endsWith(".localhost"))
    throw Error("인증 정보나 쿼리가 없는 영상 서비스의 HTTPS 주소를 입력하세요.");
  return url;
}
export type MotionVideoSources = Record<MotionVideoView, {
  path: string;
  startTime: number;
}>;
export type MotionVideoManifest = {
  schemaVersion: 1;
  source: "video-ai";
  motion: string;
  duration: number;
  fps: number;
  camera: "fixed";
  videos: MotionVideoSources;
  /** Frames are decoded from the native videos, never independently generated poses. */
  frames: { time: number; front: string; side: string; back: string }[];
};

export function validateVideoSources(value: unknown): asserts value is MotionVideoSources {
  if (!value || typeof value !== "object") throw Error("세 방향의 동작 영상이 필요합니다.");
  const sources = value as MotionVideoSources;
  if (Object.keys(sources).length !== 3 || MOTION_VIDEO_VIEWS.some(view => {
    const clip = sources[view];
    return !clip || typeof clip.path !== "string" || !clip.path ||
      !Number.isFinite(clip.startTime) || clip.startTime < 0;
  }) || new Set(MOTION_VIDEO_VIEWS.map(view => sources[view].path)).size !== 3)
    throw Error("정면·측면·후면의 서로 다른 원본과 유효한 시작 시점이 필요합니다.");
}
