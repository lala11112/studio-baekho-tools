import { useEffect, useRef, useState } from "react";
import type { WorkbenchCandidate } from "../shared/workbench";
import { motionVideoViews, validateVideoSources, type MotionVideoManifest, type MotionVideoView } from "../shared/motion-video";

const labels = { front: "정면", side: "측면", back: "후면" };

export function MotionVideoReview({ projectId, candidate }: { projectId: string; candidate: WorkbenchCandidate }) {
  const manifest = candidate.artifacts.find(a => a.kind === "frames");
  const [doc, setDoc] = useState<MotionVideoManifest>();
  const [error, setError] = useState("");
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState<MotionVideoView[]>([]);
  const videos = useRef<Partial<Record<MotionVideoView, HTMLVideoElement>>>({});
  const playAttempt = useRef(0);
  const views = motionVideoViews(doc?.mode);
  const prefix = manifest?.path.match(/^(.*\/jobs\/[^/]+\/)/)?.[1] ?? "";
  const registeredVideo = (relative: string) => candidate.artifacts.find(a =>
    a.kind === "video" && (a.path === relative || a.path === prefix + relative));
  const stop = () => {
    playAttempt.current++;
    Object.values(videos.current).forEach(video => video.pause());
    setPlaying(false);
  };
  useEffect(() => {
    const controller = new AbortController();
    stop(); setDoc(undefined); setError(""); setReady([]); setTime(0);
    if (manifest) fetch(window.desktop.assetUrl(projectId, manifest.path), { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw Error("동작 영상 명세를 열지 못했습니다.");
        const value = JSON.parse((await response.text()).replace(/^\uFEFF/, ""));
        validateVideoSources(value.videos, value.mode);
        if (value.source !== "video-ai" || !Number.isFinite(value.duration) || value.duration <= 0 ||
            motionVideoViews(value.mode).some(view => !registeredVideo(value.videos[view]!.path)))
          throw Error("등록된 동작 영상 원본과 명세가 일치하지 않습니다.");
        if (!controller.signal.aborted) setDoc(value);
      }).catch(e => { if (!controller.signal.aborted) setError(String(e.message ?? e)); });
    return () => { controller.abort(); playAttempt.current++; Object.values(videos.current).forEach(video => video.pause()); };
  }, [projectId, manifest?.path, manifest?.sha256]);
  useEffect(() => {
    if (!playing || !doc) return;
    let id: number;
    const tick = () => {
      const masterView = motionVideoViews(doc.mode)[0];
      const master = videos.current[masterView];
      if (!master) return;
      const t = master.currentTime - doc.videos[masterView]!.startTime;
      setTime(Math.max(0, Math.min(t, doc.duration)));
      if (t >= doc.duration - 0.015 || master.ended) {
        if (doc.loop && doc.mode === "side") { master.currentTime = doc.videos.side!.startTime; void master.play().catch(() => stop()); setTime(0); id = requestAnimationFrame(tick); return; }
        stop(); return;
      }
      for (const view of motionVideoViews(doc.mode).slice(1)) {
        const video = videos.current[view];
        if (video && Math.abs(video.currentTime - doc.videos[view]!.startTime - t) > 0.08)
          video.currentTime = doc.videos[view]!.startTime + t;
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, doc]);
  const seek = (t: number) => {
    stop(); setTime(t);
    if (doc) for (const view of views) {
      const video = videos.current[view];
      if (video) video.currentTime = doc.videos[view]!.startTime + t;
    }
  };
  const toggle = async () => {
    if (playing) { stop(); return; }
    if (doc && time >= doc.duration - 0.02) seek(0);
    const attempt = ++playAttempt.current;
    try {
      await Promise.all(views.map(view => videos.current[view]!.play()));
      if (attempt === playAttempt.current) setPlaying(true);
      else Object.values(videos.current).forEach(video => video.pause());
    } catch { stop(); setError("영상을 재생하지 못했습니다. 파일 형식과 원본을 확인하세요."); }
  };
  return <section className="wb-sequence" data-testid="workbench-video-review">
    {error && <p role="alert" className="wb-note warning">{error}</p>}
    {doc && <>
      <div className="wb-sequence-controls">
        <button onClick={toggle} disabled={ready.length !== views.length || !!error} aria-label={playing ? "동작 영상 멈추기" : doc.mode === "side" ? "측면 동작 재생" : "동작 영상 함께 재생"}>{playing ? "일시 정지" : doc.mode === "side" ? "측면 재생" : "세 방향 재생"}</button>
        <input type="range" aria-label="동작 영상 시점" min={0} max={doc.duration} step={1 / doc.fps}
          value={time} disabled={ready.length !== views.length || !!error} onChange={e => seek(Number(e.target.value))} />
        <span>{time.toFixed(2)} / {doc.duration}초</span>
      </div>
      <div className="wb-frames">{views.map(view => <div key={view}>
        <h3>{labels[view]}</h3>
        <video ref={element => { if (element) videos.current[view] = element; else delete videos.current[view]; }}
          aria-label={`${labels[view]} 동작 원본`} muted playsInline preload="auto" style={{ width: "100%", maxHeight: 440 }}
          src={window.desktop.assetUrl(projectId, registeredVideo(doc.videos[view]!.path)!.path)}
          onLoadedMetadata={e => {
            const video = e.currentTarget;
            if (!Number.isFinite(video.duration) || video.duration + 0.05 < doc.videos[view]!.startTime + doc.duration || !video.videoWidth) {
              stop(); setError(`${labels[view]} 원본 길이 또는 영상 트랙을 확인하세요.`); return;
            }
            video.currentTime = doc.videos[view]!.startTime;
            setReady(previous => [...new Set([...previous, view])]);
          }} onError={() => { stop(); setError(`${labels[view]} 원본 영상을 열지 못했습니다.`); }} />
      </div>)}</div>
      <p className="wb-muted">{doc.mode === "side" ? "측면 연속 동작입니다. 토끼 외형·발 접지·점프 착지·반복 연결을 확인한 뒤 채택하세요. 다른 방향의 동작을 검증한 결과는 아닙니다." : "같은 시간으로 함께 재생합니다. 자세·발 접지·도약과 착지 시점이 일치하는지 직접 확인한 뒤 채택하세요. 함께 재생된다는 것만으로 동작 일치가 검증된 것은 아닙니다."}</p>
    </>}
  </section>;
}
