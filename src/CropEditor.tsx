import { useRef, useState } from "react";
import type { Asset, Project } from "../shared/types";
export function CropEditor({
  project,
  asset,
  onSave,
}: {
  project: Project;
  asset: Asset;
  onSave: (
    rect: { x: number; y: number; width: number; height: number },
    polygon?: [number, number][],
  ) => void;
}) {
  const img = useRef<HTMLImageElement>(null);
  const [start, setStart] = useState<[number, number] | null>(null),
    [end, setEnd] = useState<[number, number] | null>(null),
    [points, setPoints] = useState<[number, number][]>([]),
    [mask, setMask] = useState(false);
  function point(e: React.PointerEvent): [number, number] {
    const r = img.current!.getBoundingClientRect();
    return [
      Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    ];
  }
  const bounds =
    mask && points.length
      ? {
          x: Math.min(...points.map((x) => x[0])),
          y: Math.min(...points.map((x) => x[1])),
          right: Math.max(...points.map((x) => x[0])),
          bottom: Math.max(...points.map((x) => x[1])),
        }
      : start && end
        ? {
            x: Math.min(start[0], end[0]),
            y: Math.min(start[1], end[1]),
            right: Math.max(start[0], end[0]),
            bottom: Math.max(start[1], end[1]),
          }
        : null;
  function save() {
    if (!img.current || !bounds) return;
    const w = img.current.naturalWidth,
      h = img.current.naturalHeight;
    onSave(
      {
        x: bounds.x * w,
        y: bounds.y * h,
        width: (bounds.right - bounds.x) * w,
        height: (bounds.bottom - bounds.y) * h,
      },
      mask ? points.map((p) => [p[0] * w, p[1] * h]) : undefined,
    );
  }
  return (
    <div className="crop-editor">
      <div className="toolbar">
        <button
          className={!mask ? "active" : ""}
          onClick={() => {
            setMask(false);
            setPoints([]);
          }}
        >
          사각형 잘라내기
        </button>
        <button
          className={mask ? "active" : ""}
          onClick={() => {
            setMask(true);
            setPoints([]);
          }}
        >
          다각형 마스크
        </button>
        <button
          onClick={() => {
            setStart(null);
            setEnd(null);
            setPoints([]);
          }}
        >
          초기화
        </button>
      </div>
      <div className="crop-stage">
        <div
          className="crop-image"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            if (mask) setPoints([...points, point(e)]);
            else {
              setStart(point(e));
              setEnd(point(e));
            }
          }}
          onPointerMove={(e) => {
            if (!mask && e.buttons === 1 && start) setEnd(point(e));
          }}
        >
          <img
            draggable={false}
            ref={img}
            src={window.desktop.assetUrl(project.id, asset.file)}
          />
          <svg viewBox="0 0 100 100" preserveAspectRatio="none">
            {bounds && !mask && (
              <rect
                x={bounds.x * 100}
                y={bounds.y * 100}
                width={(bounds.right - bounds.x) * 100}
                height={(bounds.bottom - bounds.y) * 100}
              />
            )}{" "}
            {mask && points.length > 0 && (
              <polygon
                points={points
                  .map((p) => `${p[0] * 100},${p[1] * 100}`)
                  .join(" ")}
              />
            )}
          </svg>
        </div>
      </div>
      <div className="toolbar">
        <small>
          {mask
            ? "클릭으로 윤곽점을 지정합니다. 내부만 남기고 투명 처리합니다."
            : "드래그해 파츠 영역을 선택합니다."}
        </small>
        <button
          className="primary"
          onClick={save}
          disabled={!bounds || (mask && points.length < 3)}
        >
          파츠 이미지 저장
        </button>
      </div>
    </div>
  );
}
