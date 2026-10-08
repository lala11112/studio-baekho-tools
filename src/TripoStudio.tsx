import { useState, type ReactNode } from "react";
import {
  Box,
  Scissors,
  Grid3X3,
  Layers,
  Paintbrush,
  Workflow,
  Upload,
  Sparkles,
  FolderOpen,
} from "lucide-react";
import type { Asset, Command, Generation, Project } from "../shared/types";
import { catalog } from "../shared/catalog";
import { Viewport } from "./Viewport";

export const operationLabels: Record<string, string> = {
  image: "이미지 생성",
  edit: "이미지 편집",
  model: "모델 생성",
  segment: "메시 분할",
  smartsegment: "스마트 분할",
  complete: "분할 부위 보완",
  retopology: "리토폴로지",
  "uv-pack": "Tripo UV 패킹",
  texture: "텍스처",
  convert: "형식 변환",
  "rig-check": "리깅 적합성 검사",
  rig: "자동 리깅",
  animate: "애니메이션",
};
const tabs = [
  ["model", "모델 생성", Box],
  ["segment", "분할", Scissors],
  ["retopology", "리토폴로지", Grid3X3],
  ["uv-pack", "Smart UV", Layers],
  ["texture", "텍스처", Paintbrush],
  ["rig", "리깅", Workflow],
] as const;
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="checkbox">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
export function canPreview(a: Asset) {
  return a.kind === "model" && /\.glb$/i.test(a.file);
}

export function TripoStudio({
  project: p,
  request,
  run,
  busy,
  navigate,
}: {
  project: Project;
  request: (r: Generation) => void;
  run: (c: Command, s?: string) => Promise<any>;
  busy: boolean;
  navigate: (tab: string) => void;
}) {
  const [tab, setTab] = useState<(typeof tabs)[number][0]>("model");
  const [mode, setMode] =
    useState<NonNullable<Generation["inputMode"]>>("image");
  const [model, setModel] = useState(catalog.model[0].id);
  const [source, setSource] = useState("");
  const [views, setViews] = useState(["", "", "", ""]);
  const [inputModel, setInputModel] = useState("");
  const [selected, setSelected] = useState("");
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(1);
  const [face, setFace] = useState("12000");
  const [quad, setQuad] = useState(false);
  const [texture, setTexture] = useState(true);
  const [pbr, setPbr] = useState(true);
  const [uv, setUv] = useState(true);
  const [quality, setQuality] =
    useState<Generation["textureQuality"]>("standard");
  const [textureModel, setTextureModel] = useState(catalog.texture[0].id);
  const [segmentMode, setSegmentMode] = useState<
    "segment" | "smartsegment" | "complete"
  >("segment");
  const [segmentModel, setSegmentModel] = useState(catalog.segment[0].id);
  const [granularity, setGranularity] =
    useState<Generation["segmentationGranularity"]>("balanced");
  const [connectivity, setConnectivity] = useState(true);
  const [smartGranularity, setSmartGranularity] =
    useState<Generation["smartGranularity"]>("medium");
  const [segType, setSegType] = useState<Generation["segType"]>("model");
  const [completion, setCompletion] =
    useState<Generation["completionMode"]>("quick_cap");
  const [segmentTask, setSegmentTask] = useState("");
  const [partNames, setPartNames] = useState("");
  const [retopoModel, setRetopoModel] = useState(catalog.retopology[0].id);
  const [retopoFace, setRetopoFace] = useState("5000");
  const [retopoQuad, setRetopoQuad] = useState(false);
  const [bake, setBake] = useState(true);
  const [textureSize, setTextureSize] = useState(2048);
  const [textureRef, setTextureRef] = useState("");
  const [rigTask, setRigTask] = useState("");
  const [animation, setAnimation] = useState(catalog.animation[0].id);
  const [assignPart, setAssignPart] = useState(p.parts[0]?.id ?? "");
  const [format, setFormat] = useState<Generation["format"]>("FBX");
  const images = p.assets.filter((a) => a.kind === "image");
  const models = p.assets.filter(canPreview);
  const modelId = inputModel || models.at(-1)?.id || "";
  const imageId = source || p.selectedImageId || images.at(-1)?.id || "";
  const shown = p.assets.find((a) => a.id === selected) ?? models.at(-1);
  const segmentJobs = p.jobs.filter(
    (j) =>
      ["segment", "smartsegment"].includes(j.kind) &&
      j.status === "success" &&
      j.remoteId,
  );
  const rigJobs = p.jobs.filter(
    (j) =>
      j.kind === "rig" &&
      j.status === "success" &&
      j.remoteId &&
      j.revision === p.revision,
  );
  const activeSegment = segmentTask || segmentJobs.at(-1)?.remoteId || "";
  const segmentOutput = segmentJobs.find(
    (j) => j.remoteId === activeSegment,
  )?.output;
  const partInfo =
    segmentOutput?.part_names ?? segmentOutput?.parts ?? segmentOutput?.prompt;
  const partInfoText = partInfo
    ? (typeof partInfo === "string"
        ? partInfo
        : JSON.stringify(partInfo)
      ).slice(0, 2000)
    : "";
  const activeRig = rigTask || rigJobs.at(-1)?.remoteId || "";
  const passedRig = p.jobs.some(
    (j) =>
      j.kind === "rig-check" &&
      j.status === "success" &&
      j.request.sourceId === modelId &&
      j.revision === p.revision &&
      j.output?.riggable === true,
  );
  const isP2 = model.startsWith("P2");
  const isP = model.startsWith("P");
  const names = partNames
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  function selectImage(value: string, change: (id: string) => void) {
    return (
      <select value={value} onChange={(e) => change(e.target.value)}>
        <option value="">이미지 선택</option>
        {images.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
    );
  }
  const imageInput = (
    <>
      <Field label="입력 이미지">{selectImage(imageId, setSource)}</Field>
      {images.find((a) => a.id === imageId) && (
        <img
          className="studio-reference"
          alt="Tripo에 보낼 입력 이미지"
          src={window.desktop.assetUrl(
            p.id,
            images.find((a) => a.id === imageId)!.file,
          )}
        />
      )}
      <button
        className="full"
        disabled={busy}
        onClick={async () => {
          const a = await run({
            type: "asset.import",
            id: p.id,
            kind: "image",
          });
          if (a?.id) setSource(a.id);
        }}
      >
        <Upload size={15} /> 이미지 가져오기
      </button>
      <small>PNG · JPG · WebP / 20MB 이하</small>
    </>
  );
  function send(kind: Generation["kind"], options: Partial<Generation> = {}) {
    request({
      kind,
      model: "",
      prompt: "",
      count: 1,
      sourceId: modelId,
      ...options,
    });
  }
  function submit() {
    if (tab === "model")
      request({
        kind: "model",
        model,
        prompt: mode === "text" ? prompt : "",
        count,
        inputMode: mode,
        ...(mode === "image"
          ? { sourceId: imageId }
          : mode === "multiview"
            ? { sourceIds: views }
            : {}),
        ...(face ? { faceLimit: Number(face) } : {}),
        ...(isP2 ? { quad } : {}),
        texture,
        pbr: texture && pbr,
        ...(isP ? { exportUv: uv } : {}),
        ...(texture
          ? { textureQuality: quality, textureVersion: textureModel }
          : {}),
      });
    else if (tab === "segment") {
      if (segmentMode === "segment")
        send("segment", {
          model: segmentModel,
          ...(segmentModel.startsWith("v2")
            ? {
                segmentationGranularity: granularity,
                splitByConnectivity: connectivity,
              }
            : {}),
        });
      else if (segmentMode === "smartsegment")
        send("smartsegment", {
          model: "smartsegment",
          sourceId: segType === "image" ? imageId : modelId,
          segType,
          smartGranularity,
          prompt,
        });
      else
        send("complete", {
          model: "v1.0-20250506",
          sourceId: undefined,
          sourceTaskId: activeSegment,
          completionMode: completion,
          partNames: names,
        });
    } else if (tab === "retopology")
      send("retopology", {
        model: retopoModel,
        ...(retopoFace ? { faceLimit: Number(retopoFace) } : {}),
        quad: retopoQuad,
        ...(retopoModel === "v2.0" ? { bake, partNames: names } : {}),
      });
    else if (tab === "uv-pack")
      send("uv-pack", { model: "convert", format: "GLTF", textureSize, bake });
    else if (tab === "texture")
      send("texture", {
        model: textureModel,
        prompt: textureRef ? "" : prompt,
        ...(textureRef ? { sourceIds: [textureRef] } : {}),
        textureQuality: quality,
        pbr,
        partNames: names,
      });
  }
  const qualityField = (
    <Field label="텍스처 품질">
      <select
        value={quality}
        onChange={(e) =>
          setQuality(e.target.value as Generation["textureQuality"])
        }
      >
        <option value="standard">표준</option>
        <option value="detailed">고화질</option>
        <option value="extreme">최고 화질</option>
      </select>
    </Field>
  );
  const textureModelField = (
    <Field label="텍스처 AI 모델">
      <select
        value={textureModel}
        onChange={(e) => setTextureModel(e.target.value)}
      >
        {catalog.texture.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </Field>
  );
  const partsField = (
    <Field label="대상 파트 이름 (선택)">
      <input
        value={partNames}
        onChange={(e) => setPartNames(e.target.value)}
        placeholder="분할 결과의 이름, 쉼표로 구분"
      />
    </Field>
  );
  return (
    <main className="studio">
      <nav className="studio-tabs" aria-label="Tripo 기능">
        {tabs.map(([id, title, Icon]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            <Icon size={17} />
            {title}
          </button>
        ))}
      </nav>
      <div className="studio-layout">
        <aside className="studio-controls">
          <div className="panel-heading">
            <h3>{tabs.find((t) => t[0] === tab)?.[1]}</h3>
            <span className="badge green">Tripo API</span>
          </div>
          {tab !== "model" &&
            !(
              tab === "segment" &&
              (segmentMode === "complete" ||
                (segmentMode === "smartsegment" && segType === "image"))
            ) && (
              <>
                <Field label="처리할 모델">
                  <select
                    value={modelId}
                    onChange={(e) => {
                      setInputModel(e.target.value);
                      setSelected(e.target.value);
                    }}
                  >
                    <option value="">모델 선택</option>
                    {models.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <button
                  className="full"
                  disabled={busy}
                  onClick={async () => {
                    const a = await run({
                      type: "asset.import",
                      id: p.id,
                      kind: "model",
                    });
                    if (a?.id) {
                      setInputModel(a.id);
                      setSelected(a.id);
                    }
                  }}
                >
                  <Upload size={15} /> GLB 가져오기
                </button>
              </>
            )}
          {tab === "model" && (
            <>
              <Field label="AI 모델">
                <select
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                    setQuad(false);
                  }}
                >
                  {catalog.model.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="note">
                <span>
                  {isP2
                    ? "P2 Preview · 공식 v3 API 문서에 등재되어 있습니다. 이 계정의 생성 권한과 실제 동작은 미검증입니다."
                    : "공식 문서 기준 모델입니다. 계정별 생성 가능 여부는 요청 응답으로 확인합니다."}
                </span>
              </div>
              <Field label="입력 방식">
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as typeof mode)}
                >
                  <option value="image">이미지 → 3D</option>
                  <option value="text">텍스트 → 3D</option>
                  <option value="multiview">멀티뷰 → 3D</option>
                </select>
              </Field>
              {mode === "image" && imageInput}
              {mode === "text" && (
                <Field label="모델 설명">
                  <textarea
                    rows={4}
                    maxLength={1024}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="만들 캐릭터의 외형, 자세, 스타일을 입력하세요."
                  />
                </Field>
              )}
              {mode === "multiview" && (
                <>
                  {["정면 (필수)", "왼쪽", "뒷면", "오른쪽"].map((name, i) => (
                    <Field key={name} label={name}>
                      {selectImage(views[i], (v) =>
                        setViews((prev) =>
                          prev.map((x, n) => (n === i ? v : x)),
                        ),
                      )}
                    </Field>
                  ))}
                  <small>정면을 포함해 2~4개 뷰가 필요합니다.</small>
                  <button
                    className="full"
                    disabled={busy}
                    onClick={() =>
                      run({ type: "asset.import", id: p.id, kind: "image" })
                    }
                  >
                    <Upload size={15} /> 이미지 추가
                  </button>
                </>
              )}
              <div className="studio-divider" />
              {isP2 && (
                <Field label="토폴로지">
                  <select
                    value={quad ? "quad" : "triangle"}
                    onChange={(e) => setQuad(e.target.value === "quad")}
                  >
                    <option value="triangle">삼각면</option>
                    <option value="quad">사각면 · FBX 원본</option>
                  </select>
                </Field>
              )}
              <Field label="폴리곤 목표 수">
                <input
                  type="number"
                  min={isP2 ? 48 : isP ? 50 : 500}
                  max={isP2 ? (quad ? 25000 : 50000) : isP ? 20000 : 1000000}
                  step="1"
                  value={face}
                  onChange={(e) => setFace(e.target.value)}
                  placeholder="비워 두면 자동"
                />
              </Field>
              {quad && (
                <small>
                  FBX 원본을 보존하며 Blender로 미리보기 GLB를 만듭니다.
                </small>
              )}
              {isP && (
                <Toggle label="생성 시 UV 전개" checked={uv} onChange={setUv} />
              )}
              <Toggle
                label="텍스처 생성"
                checked={texture}
                onChange={setTexture}
              />
              {texture && (
                <>
                  <Toggle label="PBR 재질" checked={pbr} onChange={setPbr} />
                  {qualityField}
                  {textureModelField}
                </>
              )}
              <Field label="생성 개수">
                <select
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                >
                  {[1, 2, 4].map((n) => (
                    <option key={n} value={n}>
                      {n}개 · 요청 {n}회
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
          {tab === "segment" && (
            <>
              <Field label="분할 작업">
                <select
                  value={segmentMode}
                  onChange={(e) =>
                    setSegmentMode(e.target.value as typeof segmentMode)
                  }
                >
                  <option value="segment">메시 분할</option>
                  <option value="smartsegment">스마트 분할</option>
                  <option value="complete">분할 부위 보완</option>
                </select>
              </Field>
              {segmentMode === "segment" && (
                <>
                  <Field label="분할 AI 모델">
                    <select
                      value={segmentModel}
                      onChange={(e) => setSegmentModel(e.target.value)}
                    >
                      {catalog.segment.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {segmentModel.startsWith("v2") && (
                    <>
                      <Field label="분할 세밀도">
                        <select
                          value={granularity}
                          onChange={(e) =>
                            setGranularity(e.target.value as typeof granularity)
                          }
                        >
                          <option value="simple">간단히</option>
                          <option value="balanced">균형</option>
                          <option value="detailed">세밀하게</option>
                        </select>
                      </Field>
                      <Toggle
                        label="떨어진 메시를 개별 파트로 분리"
                        checked={connectivity}
                        onChange={setConnectivity}
                      />
                    </>
                  )}
                </>
              )}
              {segmentMode === "smartsegment" && (
                <>
                  <Field label="스마트 분할 입력">
                    <select
                      value={segType}
                      onChange={(e) =>
                        setSegType(e.target.value as typeof segType)
                      }
                    >
                      <option value="model">모델</option>
                      <option value="image">이미지에서 생성 후 분할</option>
                    </select>
                  </Field>
                  {segType === "image" && imageInput}
                  <Field label="스마트 분할 세밀도">
                    <select
                      value={smartGranularity}
                      onChange={(e) =>
                        setSmartGranularity(
                          e.target.value as typeof smartGranularity,
                        )
                      }
                    >
                      <option value="coarse">크게</option>
                      <option value="medium">중간</option>
                      <option value="fine">작게</option>
                    </select>
                  </Field>
                  <Field label="분할 힌트 (선택)">
                    <textarea
                      rows={3}
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder="head, hair, body"
                    />
                  </Field>
                </>
              )}
              {segmentMode === "complete" && (
                <>
                  <Field label="완료된 분할 작업">
                    <select
                      value={activeSegment}
                      onChange={(e) => setSegmentTask(e.target.value)}
                    >
                      <option value="">분할 작업 선택</option>
                      {segmentJobs.map((j) => (
                        <option key={j.id} value={j.remoteId}>
                          {operationLabels[j.kind]} · {j.remoteId}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="보완 방식">
                    <select
                      value={completion}
                      onChange={(e) =>
                        setCompletion(e.target.value as typeof completion)
                      }
                    >
                      <option value="quick_cap">
                        열린 면 닫기 · Quick Cap
                      </option>
                      <option value="ai_completion">AI 형태 보완</option>
                    </select>
                  </Field>
                  {partsField}
                  {partInfoText && (
                    <div className="note">
                      <span>Tripo 분할 정보: {partInfoText}</span>
                    </div>
                  )}
                  <small>
                    이 프로젝트에서 완료한 Tripo 분할 결과를 입력으로
                    사용합니다.
                  </small>
                </>
              )}
            </>
          )}
          {tab === "retopology" && (
            <>
              <Field label="리토폴로지 AI 모델">
                <select
                  value={retopoModel}
                  onChange={(e) => setRetopoModel(e.target.value)}
                >
                  {catalog.retopology.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="리토폴로지 목표 폴리곤">
                <input
                  type="number"
                  min={500}
                  max={
                    retopoModel === "v2.0"
                      ? retopoQuad
                        ? 10000
                        : 20000
                      : retopoQuad
                        ? 150000
                        : 1000000
                  }
                  value={retopoFace}
                  onChange={(e) => setRetopoFace(e.target.value)}
                  placeholder="v2는 비워 두면 자동"
                />
              </Field>
              <Toggle
                label="사각면 요청"
                checked={retopoQuad}
                onChange={setRetopoQuad}
              />
              {retopoModel === "v2.0" && (
                <>
                  <Toggle
                    label="기존 텍스처 베이크"
                    checked={bake}
                    onChange={setBake}
                  />
                  {partsField}
                </>
              )}
              <small>목표 면 수와 최종 결과는 다를 수 있습니다.</small>
            </>
          )}
          {tab === "uv-pack" && (
            <>
              <div className="note amber">
                <span>
                  공개 API로 확인된 범위는 Tripo의 UV 패킹입니다. 웹 Studio의
                  Smart UV 전체 기능과 같다고 보장하지 않습니다.
                </span>
              </div>
              <Field label="텍스처 크기">
                <select
                  value={textureSize}
                  onChange={(e) => setTextureSize(Number(e.target.value))}
                >
                  {[1024, 2048, 4096].map((n) => (
                    <option key={n} value={n}>
                      {n} × {n}
                    </option>
                  ))}
                </select>
              </Field>
              <Toggle label="텍스처 베이크" checked={bake} onChange={setBake} />
              <small>Tripo에서 UV를 패킹한 새 모델을 가져옵니다.</small>
            </>
          )}
          {tab === "texture" && (
            <>
              {textureModelField}
              {qualityField}
              <Toggle label="PBR 재질" checked={pbr} onChange={setPbr} />
              <Field label="텍스처 참조 이미지 (선택)">
                {selectImage(textureRef, setTextureRef)}
              </Field>
              {!textureRef && (
                <Field label="텍스처 설명 (선택)">
                  <textarea
                    rows={4}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="색상, 재질, 표면 스타일"
                  />
                </Field>
              )}
              {partsField}
            </>
          )}
          {tab === "rig" ? (
            <div className="studio-rig">
              <p>Tripo 인간형 자동 리깅 · Mixamo 뼈대</p>
              <button
                disabled={busy || !modelId}
                onClick={() => send("rig-check", { model: "rig-check" })}
              >
                1. 무료 적합성 검사 검토
              </button>
              <button
                disabled={busy || !passedRig}
                onClick={() =>
                  send("rig", { model: catalog.rig[0].id, rigType: "biped" })
                }
              >
                2. 자동 리깅 요청 검토
              </button>
              <small>
                {passedRig
                  ? "선택한 모델의 적합성 검사를 통과했습니다."
                  : "현재 모델의 적합성 검사 통과 후 리깅할 수 있습니다."}
              </small>
              <Field label="완료된 리깅 작업">
                <select
                  value={activeRig}
                  onChange={(e) => setRigTask(e.target.value)}
                >
                  <option value="">리깅 작업 선택</option>
                  {rigJobs.map((j) => (
                    <option key={j.id} value={j.remoteId}>
                      {j.remoteId}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="애니메이션">
                <select
                  value={animation}
                  onChange={(e) => setAnimation(e.target.value)}
                >
                  {catalog.animation.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </Field>
              <button
                disabled={busy || !activeRig}
                onClick={() =>
                  send("animate", {
                    model: catalog.rig[0].id,
                    sourceId: undefined,
                    sourceTaskId: activeRig,
                    animation,
                  })
                }
              >
                3. 애니메이션 요청 검토
              </button>
              <button onClick={() => navigate("rig")}>
                리깅 검수 · Unity용 변환
              </button>
            </div>
          ) : (
            <button
              className="primary full studio-submit"
              disabled={busy}
              onClick={submit}
            >
              <Sparkles size={16} /> Tripo 요청 검토
              {tab === "model" ? ` · ${count}개` : ""}
            </button>
          )}
          <p className="studio-explainer">
            입력 → Tripo 처리 → 앱으로 다운로드
            <br />
            비용과 입력을 확인한 뒤 승인하면 제출됩니다.
          </p>
        </aside>
        <section className="studio-results">
          <div className="studio-preview">
            {shown && canPreview(shown) ? (
              <Viewport project={p} previewId={shown.id} animation />
            ) : shown?.kind === "image" ? (
              <img
                className="studio-result-image"
                alt={shown.label}
                src={window.desktop.assetUrl(p.id, shown.file)}
              />
            ) : (
              <div className="empty">
                <Box size={44} strokeWidth={1} />
                <h3>
                  {shown
                    ? "원본 파일이 저장되었습니다"
                    : "Tripo에서 만든 결과를 이곳에서 확인하세요"}
                </h3>
                <p>
                  {shown
                    ? `${shown.format?.toUpperCase() ?? "해당 형식"}은 내장 미리보기를 지원하지 않습니다. 프로젝트 폴더에서 열 수 있습니다.`
                    : "모델을 생성하거나 GLB를 가져와 후처리를 시작하세요."}
                </p>
                <button
                  onClick={() =>
                    run({ type: "asset.import", id: p.id, kind: "model" })
                  }
                >
                  <Upload size={15} /> GLB 가져오기
                </button>
              </div>
            )}
          </div>
          <div className="studio-result-heading">
            <div>
              <strong>{shown?.label ?? "결과 보관함"}</strong>
              <small>
                {shown
                  ? `${shown.origin === "tripo" ? "Tripo 결과" : shown.origin === "demo" ? "로컬 데모" : "로컬 파일"}${shown.nativeFile && shown.nativeFile !== shown.file && canPreview(shown) ? ` · 원본 ${shown.format?.toUpperCase()} 보존 / GLB 미리보기` : ""}`
                  : "생성 결과와 입력 파일이 프로젝트에 보관됩니다."}
              </small>
            </div>
            <button
              title="결과 폴더 열기"
              onClick={() => run({ type: "folder.open", id: p.id })}
            >
              <FolderOpen size={16} />
            </button>
          </div>
          <div className="studio-assets">
            {p.assets.toReversed().map((a) => (
              <button
                key={a.id}
                className={`studio-asset ${shown?.id === a.id ? "selected" : ""}`}
                onClick={() => setSelected(a.id)}
              >
                {a.kind === "image" ? (
                  <img alt="" src={window.desktop.assetUrl(p.id, a.file)} />
                ) : (
                  <Box size={26} />
                )}
                <span>
                  {a.label}
                  <small>
                    {a.kind === "image"
                      ? "이미지"
                      : (a.format?.toUpperCase() ?? "GLB")}{" "}
                    ·{" "}
                    {a.origin === "tripo"
                      ? "Tripo"
                      : a.origin === "demo"
                        ? "데모"
                        : "로컬"}
                  </small>
                </span>
              </button>
            ))}
          </div>
          {shown && canPreview(shown) && (
            <div className="studio-result-actions">
              <button
                onClick={() => {
                  setInputModel(shown.id);
                  setTab("segment");
                }}
              >
                이 결과 후처리
              </button>
              <select
                aria-label="결과를 사용할 파츠"
                value={assignPart}
                onChange={(e) => setAssignPart(e.target.value)}
              >
                {p.parts.map((part) => (
                  <option key={part.id} value={part.id}>
                    {part.name}
                    {part.locked ? " (고정됨)" : ""}
                  </option>
                ))}
              </select>
              <button
                disabled={
                  !assignPart ||
                  p.parts.find((part) => part.id === assignPart)?.locked ||
                  busy
                }
                onClick={() =>
                  run(
                    {
                      type: "part.assign",
                      id: p.id,
                      partId: assignPart,
                      assetId: shown.id,
                    },
                    "파츠에 모델을 적용했습니다.",
                  )
                }
              >
                파츠에 적용
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  run(
                    {
                      type: "blender.build",
                      id: p.id,
                      mode: "convert",
                      assetId: shown.id,
                    },
                    "Unity용 FBX·GLB 출력 완료",
                  )
                }
              >
                Unity용 출력
              </button>
            </div>
          )}
          {shown && canPreview(shown) && (
            <details className="studio-export">
              <summary>Tripo에서 파일 형식 변환</summary>
              <div className="inline-actions">
                <select
                  aria-label="Tripo 출력 형식"
                  value={format}
                  onChange={(e) =>
                    setFormat(e.target.value as Generation["format"])
                  }
                >
                  {["GLTF", "FBX", "OBJ", "STL", "USDZ", "3MF"].map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <button
                  disabled={busy}
                  onClick={() =>
                    send("convert", {
                      model: "convert",
                      sourceId: shown.id,
                      format,
                      bake: true,
                      textureSize: 2048,
                    })
                  }
                >
                  변환 요청 검토
                </button>
              </div>
            </details>
          )}
        </section>
      </div>
    </main>
  );
}

export function RequestOptions({ request: r }: { request: Generation }) {
  const items: [string, string][] = [];
  if (r.inputMode)
    items.push([
      "입력 방식",
      { image: "이미지", text: "텍스트", multiview: "멀티뷰" }[r.inputMode],
    ]);
  if (r.faceLimit !== undefined)
    items.push(["폴리곤 목표", r.faceLimit.toLocaleString()]);
  if (r.quad !== undefined)
    items.push(["토폴로지", r.quad ? "사각면" : "삼각면"]);
  if (r.texture !== undefined)
    items.push(["텍스처 생성", r.texture ? "사용" : "해제"]);
  if (r.pbr !== undefined) items.push(["PBR", r.pbr ? "사용" : "해제"]);
  if (r.exportUv !== undefined)
    items.push(["UV 전개", r.exportUv ? "사용" : "해제"]);
  if (r.textureQuality) items.push(["텍스처 품질", r.textureQuality]);
  if (r.textureVersion) items.push(["텍스처 모델", r.textureVersion]);
  if (r.segmentationGranularity || r.smartGranularity)
    items.push([
      "분할 세밀도",
      r.segmentationGranularity ?? r.smartGranularity!,
    ]);
  if (r.splitByConnectivity !== undefined)
    items.push(["연결요소 분리", r.splitByConnectivity ? "사용" : "해제"]);
  if (r.completionMode)
    items.push([
      "보완 방식",
      r.completionMode === "quick_cap" ? "열린 면 닫기" : "AI 보완",
    ]);
  if (r.partNames?.length) items.push(["대상 파트", r.partNames.join(", ")]);
  if (r.bake !== undefined)
    items.push(["텍스처 베이크", r.bake ? "사용" : "해제"]);
  if (r.textureSize) items.push(["텍스처 크기", `${r.textureSize}px`]);
  if (r.format) items.push(["출력 형식", r.format]);
  if (r.animation) items.push(["애니메이션", r.animation]);
  if (r.prompt)
    items.push([
      r.kind === "model" && r.inputMode !== "text"
        ? "파츠 메모 (전송 안 함)"
        : "프롬프트",
      r.prompt,
    ]);
  return items.length ? (
    <details className="request-options" open>
      <summary>요청 옵션</summary>
      <dl>
        {items.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  ) : null;
}
