import { useEffect, useRef, useState } from "react";
import { renderRunwayFrame, runwayFrameLayout } from "../shared/runway-framing";

export function RunwayFramePreview({ src, loop, onReady }: { src?: string; loop: boolean; onReady: (ready: boolean) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null), [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false; onReady(false); setError("");
    if (!src) return;
    const image = new Image(); image.crossOrigin = "anonymous";
    image.onload = () => {
      if (cancelled || !canvas.current) return;
      try {
        const source = document.createElement("canvas"); source.width = image.naturalWidth; source.height = image.naturalHeight;
        const context = source.getContext("2d")!; context.drawImage(image, 0, 0);
        const layout = runwayFrameLayout(source.width, source.height, loop);
        const pixels = renderRunwayFrame(context.getImageData(0, 0, source.width, source.height).data, layout);
        canvas.current.width = layout.width; canvas.current.height = layout.height;
        canvas.current.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(pixels), layout.width, layout.height), 0, 0);
        onReady(true);
      } catch { setError("전신 구도 미리보기를 준비하지 못했습니다. 측면 원본을 확인하세요."); }
    };
    image.onerror = () => { if (!cancelled) setError("측면 원본을 불러오지 못했습니다."); };
    image.src = src;
    return () => { cancelled = true; };
  }, [src, loop, onReady]);
  return <div data-testid="runway-frame-preview"><p>실제 업로드 구도 · 16:9 · {loop ? "전신 여백" : "점프 상단 여백"}</p>
    <canvas ref={canvas} aria-label="Runway 전신 입력 미리보기" style={{ width: "100%", maxHeight: 320, objectFit: "contain" }} />
    {error && <p role="alert">{error}</p>}
    <small>원본을 자르거나 축소하지 않고 가장자리 배경을 연장합니다. 귀·발과 배경 경계를 확인하세요. 생성 결과의 전신 유지 여부는 다시 검토해야 합니다.</small>
  </div>;
}
