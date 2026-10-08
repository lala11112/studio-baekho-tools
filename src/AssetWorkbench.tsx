import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  CircleAlert,
  Clock,
  FolderOpen,
  ImagePlus,
  Layers3,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Play,
  Pause,
  Sparkles,
  Square,
  Upload,
} from "lucide-react";
import type { Command, Project } from "../shared/types";
import type {
  Workbench,
  WorkbenchAction,
  WorkbenchArtifact,
  WorkbenchCandidate,
  WorkbenchJob,
  WorkbenchRequest,
  WorkbenchRole,
  WorkbenchStep,
} from "../shared/workbench";
import type { ProductionRun } from "../shared/production";
import { Viewport } from "./Viewport";
import "./workbench.css";

const pages = [
  { id: "concept", title: "이미지", detail: "4장 중 선택" },
  { id: "parts", title: "파츠 모델", detail: "분리 · 4개씩 선택" },
  { id: "surface", title: "UV · 텍스처", detail: "선택한 파츠" },
  { id: "assembly", title: "조립 · 수정", detail: "Blender + Astra" },
  { id: "rig", title: "리깅", detail: "오브젝트별 설정" },
  { id: "motion", title: "애니메이션", detail: "2D 확인 → 3D" },
  { id: "unity", title: "Unity", detail: "내보내기 · 검사" },
] as const;
type Page = (typeof pages)[number]["id"];
const roles: WorkbenchRole[] = ["head", "hair", "body"];
const roleLabels = { head: "머리", hair: "머리카락", body: "몸통" };
const categoryLabels = {
  body: "몸체 · 기본 연결",
  clothing: "옷",
  hair: "머리카락",
  other: "기타 오브젝트",
};
const statuses: Record<string, string> = {
  running: "작업 중",
  review: "결과 확인",
  needs_input: "입력·연결 필요",
  submission_unknown: "제출 확인 필요",
  failed: "작업 실패",
  cancelled: "중단됨",
};

type ReferenceFrame = {
  time: number;
  front: string;
  side: string;
  back: string;
};
function FrameSequence({
  projectId,
  candidate,
}: {
  projectId: string;
  candidate: WorkbenchCandidate;
}) {
  const manifest = candidate.artifacts.find((a) => a.kind === "frames");
  const [frames, setFrames] = useState<ReferenceFrame[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setIndex(0);
    setPlaying(false);
    setFrames([]);
    setError("");
    if (!manifest) return;
    const controller = new AbortController();
    fetch(window.desktop.assetUrl(projectId, manifest.path), {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("동작 프레임의 타이밍 정보를 열지 못했습니다.");
        const doc = JSON.parse((await response.text()).replace(/^\uFEFF/, ""));
        if (!Array.isArray(doc.frames) || !doc.frames.length)
          throw new Error("확인할 동작 프레임이 없습니다.");
        if (!controller.signal.aborted) setFrames(doc.frames);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "동작 이미지 읽기 실패");
      });
    return () => controller.abort();
  }, [projectId, manifest?.path, manifest?.sha256]);
  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const current = frames[index];
    const next = frames[index + 1];
    const delay = next ? Math.max(16, (next.time - current.time) * 1000) : 500;
    const timer = setTimeout(
      () => setIndex((i) => (i + 1) % frames.length),
      delay,
    );
    return () => clearTimeout(timer);
  }, [playing, index, frames]);
  const prefix =
    manifest?.path.match(/^(workbench\/[^/]+\/jobs\/[^/]+\/)/)?.[1] ?? "";
  const frame = frames[index];
  const names = { front: "정면", side: "측면", back: "후면" };
  return (
    <div className="wb-sequence" data-testid="workbench-sequence">
      {error ? (
        <p className="wb-note warning">{error}</p>
      ) : !frame ? (
        <p className="wb-muted">동작 프레임을 여는 중…</p>
      ) : (
        <>
          <div className="wb-sequence-controls">
            <button
              aria-label={playing ? "참조 동작 멈추기" : "참조 동작 재생"}
              onClick={() => setPlaying((v) => !v)}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <input
              aria-label="참조 동작 시점"
              type="range"
              min={0}
              max={frames.length - 1}
              value={index}
              onChange={(e) => {
                setPlaying(false);
                setIndex(Number(e.target.value));
              }}
            />
            <span>
              {frame.time.toFixed(2)}초 · {index + 1}/{frames.length}
            </span>
          </div>
          <div className="wb-frames">
            {(["front", "side", "back"] as const).map((view) => {
              const file = frame[view]?.replaceAll("\\", "/");
              const image = candidate.artifacts.find(
                (a) =>
                  a.kind === "image" &&
                  (a.path === file || a.path === prefix + file),
              );
              return (
                <div key={view}>
                  <h3>{names[view]}</h3>
                  {image ? (
                    <img
                      src={window.desktop.assetUrl(projectId, image.path)}
                      alt={`${names[view]} ${frame.time.toFixed(2)}초 동작`}
                    />
                  ) : (
                    <div className="wb-note warning">
                      등록된 이미지가 없습니다.
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="wb-muted">
            세 방향이 같은 시점으로 재생됩니다. 외형·동작·접지가 맞는지 확인한
            뒤 채택하세요.
          </p>
        </>
      )}
    </div>
  );
}

export function AssetWorkbench({
  project: p,
  workbench: w,
  legacyRuns = [],
  run,
  busy,
}: {
  project: Project;
  workbench?: Workbench;
  legacyRuns?: ProductionRun[];
  run: (c: Command, s?: string) => Promise<any>;
  busy: boolean;
}) {
  const scrollHost = useRef<HTMLElement>(null);
  const [page, setPage] = useState<Page>(() => {
    const saved = localStorage.getItem(`partsmith.workbench.page.${p.id}`);
    return pages.some((x) => x.id === saved) ? (saved as Page) : "concept";
  });
  const [partMode, setPartMode] = useState<"separate" | "model">("separate");
  const [motionMode, setMotionMode] = useState<"reference" | "animation">(
    "reference",
  );
  const [role, setRole] = useState<WorkbenchRole>("head");
  const [provider, setProvider] = useState<"gpt" | "tripo">(
    w?.jobs.find((j) => j.step === "concept")?.request.provider ?? "gpt",
  );
  const [prompt, setPrompt] = useState(
    w?.jobs.find((j) => j.step === "concept")?.request.prompt ?? "",
  );
  const [separationPrompt, setSeparationPrompt] = useState(
    "원본 캐릭터의 외형을 유지하고 머리, 머리카락, 몸통을 분리해 주세요. 몸통에는 의상을 포함해 주세요.",
  );
  const [modelPrompt, setModelPrompt] = useState(
    "선택한 파츠 이미지의 비율과 실루엣을 유지해 주세요.",
  );
  const [surfacePrompt, setSurfacePrompt] = useState(
    "원본 캐릭터 이미지와 색상, 스타일을 맞춰 주세요.",
  );
  const [editPrompt, setEditPrompt] = useState("");
  const [rigPrompt, setRigPrompt] = useState("");
  const [motion, setMotion] = useState(
    w?.jobs.find((j) => j.step === "reference" || j.step === "animation")
      ?.request.motion ?? "오른손을 들어 인사하기",
  );
  const [motionPrompt, setMotionPrompt] = useState("");
  const [duration, setDuration] = useState(
    w?.jobs.find((j) => j.step === "reference")?.request.duration ?? 2,
  );
  const [fps, setFps] = useState(
    w?.jobs.find((j) => j.step === "reference")?.request.fps ?? 12,
  );
  const [referenceFrameCount, setReferenceFrameCount] = useState(
    w?.jobs.find((j) => j.step === "reference")?.request.referenceFrameCount ??
      3,
  );
  const [loop, setLoop] = useState(
    w?.jobs.find((j) => j.step === "reference")?.request.loop ?? false,
  );
  const [polygonCount, setPolygonCount] = useState(10000);
  const [studioLimit, setStudioLimit] = useState(0);
  const [approved, setApproved] = useState(false);
  const [viewJobId, setViewJobId] = useState("");
  const [compareId, setCompareId] = useState("");
  const [objectIds, setObjectIds] = useState<string[]>([]);
  const [extraRigIds, setExtraRigIds] = useState<string[]>(
    w?.jobs
      .find((j) => j.step === "rig")
      ?.request.rigTargets?.filter((t) => t.extraBones)
      .map((t) => t.objectId) ?? [],
  );
  const [recoveryAttempts, setRecoveryAttempts] = useState<
    Record<string, number>
  >({});
  const [probe, setProbe] = useState<string>("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    localStorage.setItem(`partsmith.workbench.page.${p.id}`, page);
    setViewJobId("");
    setCompareId("");
    scrollHost.current?.scrollTo({ top: 0 });
  }, [page, p.id]);
  useEffect(
    () => setApproved(false),
    [
      page,
      partMode,
      motionMode,
      provider,
      prompt,
      separationPrompt,
      modelPrompt,
      surfacePrompt,
      motion,
      motionPrompt,
      duration,
      fps,
      referenceFrameCount,
      loop,
      studioLimit,
      polygonCount,
      role,
    ],
  );

  const jobs = w?.jobs ?? [];
  const currentInputs = (job?: WorkbenchJob) =>
    !!job &&
    Object.entries(job.dependencies).every(
      ([key, value]) =>
        w?.selections[key]?.jobId === value.jobId &&
        w.selections[key]?.candidateId === value.candidateId,
    );
  const active =
    jobs.find((j) => j.id === w?.activeJobId && j.status === "running") ??
    jobs.find((j) => j.status === "running");
  const locked = busy || !!active;
  const selection = (slot: string) => {
    const s = w?.selections[slot];
    const job = jobs.find((j) => j.id === s?.jobId);
    const candidate = job?.candidates.find((c) => c.id === s?.candidateId);
    return candidate && job ? { job, candidate } : undefined;
  };
  const concept = selection("concept");
  const separated = selection("separate");
  const allModels = roles.every((r) => !!selection(`model:${r}`));
  const surface = selection("surface");
  const assembly = selection("assembly");
  const rig = selection("rig");
  const reference = selection(`reference:${motion.trim()}`);
  const selectedSource = concept?.candidate.artifacts.find(
    (a) => a.kind === "image",
  );
  const ready: Record<Page, boolean> = {
    concept: true,
    parts: !!concept,
    surface: allModels,
    assembly: !!surface,
    rig: !!assembly,
    motion: !!rig,
    unity:
      !!rig &&
      Object.keys(w?.selections ?? {}).some((k) => k.startsWith("animation:")),
  };
  const reasons: Record<Page, string> = {
    concept: "",
    parts: "먼저 사용할 전체 이미지를 선택하세요.",
    surface: "머리·머리카락·몸통의 모델을 각각 하나씩 선택하세요.",
    assembly: "먼저 UV·텍스처 결과를 채택하세요.",
    rig: "먼저 조립된 모델의 버전을 채택하세요.",
    motion: "먼저 리깅 결과를 채택하세요.",
    unity: "먼저 리깅과 3D 애니메이션 결과를 채택하세요.",
  };
  const step: WorkbenchStep =
    page === "parts" ? partMode : page === "motion" ? motionMode : page;
  const slot =
    step === "model"
      ? `model:${role}`
      : ["reference", "animation"].includes(step)
        ? `${step}:${motion.trim()}`
        : step;
  const stageJobs = jobs.filter((j) => j.slot === slot);
  const latestJob = stageJobs[0];
  const viewing = stageJobs.find((j) => j.id === viewJobId) ?? latestJob;
  const viewingCurrent = currentInputs(viewing);
  const editBase =
    viewing?.status === "review" && viewingCurrent ? viewing : undefined;
  const candidate = viewing?.candidates[0];
  const selectedHere = selection(slot);
  const viewingAccepted = !!viewing && selectedHere?.job.id === viewing.id;
  const sourceObjects =
    (page === "rig"
      ? assembly?.candidate
      : (editBase?.candidates[0] ?? assembly?.candidate)
    )?.objects ?? [];
  const paid = [
    "concept",
    "separate",
    "model",
    "surface",
    "reference",
  ].includes(step);
  const usesStudio =
    step === "model" ||
    step === "surface" ||
    (step === "concept" && provider === "tripo");
  const currentStatus =
    active ??
    (latestJob && latestJob.status !== "review" ? latestJob : undefined);
  const elapsed = active
    ? Math.max(0, Math.floor((now - Date.parse(active.createdAt)) / 1000))
    : 0;

  async function action(a: WorkbenchAction, message?: string) {
    return run({ type: "workbench.action", id: p.id, action: a }, message);
  }
  async function execute(request: WorkbenchRequest) {
    setViewJobId("");
    setCompareId("");
    await action({
      kind: "execute",
      request,
      approval: {
        accepted: paid ? approved : true,
        studioCreditLimit: usesStudio ? studioLimit : 0,
        imageCreditLimit: 0,
      },
    });
    setApproved(false);
  }
  function go(next: Page) {
    if (ready[next]) setPage(next);
  }
  const url = (a: WorkbenchArtifact) => window.desktop.assetUrl(p.id, a.path);
  const modelArtifact = (c?: WorkbenchCandidate) =>
    c?.artifacts.find((a) => a.kind === "model" && /\.glb$/i.test(a.path));
  function modelView(c?: WorkbenchCandidate, animated = false) {
    const a = modelArtifact(c);
    if (!a)
      return (
        <div className="wb-empty">
          <Layers3 size={30} />
          <p>아직 확인할 3D 결과가 없습니다.</p>
        </div>
      );
    return (
      <div className="wb-model">
        <Viewport
          key={a.path}
          project={{
            ...p,
            assets: [
              {
                id: a.sha256,
                file: a.path,
                kind: "model",
                label: c?.label ?? "모델",
                origin: "blender",
                createdAt: w?.updatedAt ?? p.updatedAt,
              },
            ],
            parts: [],
          }}
          previewId={a.sha256}
          animation={animated}
        />
      </div>
    );
  }
  function resultGallery(c?: WorkbenchCandidate) {
    const images = c?.artifacts.filter((a) => a.kind === "image") ?? [];
    const models =
      c?.artifacts.filter(
        (a) => a.kind === "model" && /\.glb$/i.test(a.path),
      ) ?? [];
    return (
      <>
        {step === "reference" &&
        c?.artifacts.some((a) => a.kind === "frames") ? (
          <FrameSequence projectId={p.id} candidate={c} />
        ) : (
          <>
            {models.length > 1 ? (
              <div className="wb-parts">
                {models.map((a) => (
                  <div className="wb-part" key={a.path}>
                    {modelView({
                      id: a.sha256,
                      label: a.role ?? "파츠",
                      artifacts: [a],
                    })}
                    <h3>
                      {roleLabels[a.role as WorkbenchRole] ??
                        a.role ??
                        "파츠 모델"}
                    </h3>
                  </div>
                ))}
              </div>
            ) : (
              modelArtifact(c) &&
              modelView(c, step === "rig" || step === "animation")
            )}
            {images.length > 0 && (
              <div className={step === "separate" ? "wb-parts" : "wb-frames"}>
                {images.map((a, i) => (
                  <div
                    className={step === "separate" ? "wb-part" : ""}
                    key={a.path}
                  >
                    <img
                      src={url(a)}
                      alt={`${a.role ?? c?.label ?? "결과"} ${i + 1}`}
                    />
                    <div className="wb-frame-caption">
                      {a.role
                        ? (roleLabels[a.role as WorkbenchRole] ?? a.role)
                        : `검토 이미지 ${i + 1}`}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </>
    );
  }
  function approvalBox() {
    return (
      <div className="wb-budget">
        {usesStudio ? (
          <>
            <label className="field">
              <span>이번 실행의 Studio 크레딧 한도</span>
              <input
                data-testid="workbench-credit-limit"
                type="number"
                min={0}
                step={1}
                value={studioLimit}
                onChange={(e) => setStudioLimit(Number(e.target.value))}
              />
            </label>
            <small>
              실제 서비스의 비용을 확인하고 한도 안에서만 실행합니다. 0이면 유료
              생성은 진행하지 않습니다.
            </small>
          </>
        ) : (
          <small>
            기존 ChatGPT 계정의 사용량을 사용합니다.
            <br />
            {step === "concept"
              ? "이미지 후보 4장"
              : step === "separate"
                ? "머리·머리카락·몸통 분리 이미지 3장"
                : `정면·측면·후면 각 ${referenceFrameCount}장, 총 ${referenceFrameCount * 3}장 · ${duration}초 동작의 주요 시점`}
          </small>
        )}
        <label className="wb-checkbox">
          <input
            data-testid="workbench-approve"
            type="checkbox"
            checked={approved}
            onChange={(e) => setApproved(e.target.checked)}
          />
          {usesStudio
            ? "현재 설정과 이미지를 Tripo에 전달하고, 이 한도 안에서 이번 작업을 실행합니다."
            : "현재 설정과 이미지를 GPT에 전달하고, 표시된 범위의 이미지 생성을 실행합니다."}
        </label>
      </div>
    );
  }
  function launch(label: string, request: WorkbenchRequest, disabled = false) {
    return (
      <button
        className="primary"
        data-testid={`workbench-execute-${step}`}
        disabled={
          locked ||
          disabled ||
          (paid && !approved) ||
          stageJobs.some((j) => j.status === "submission_unknown")
        }
        onClick={() => execute(request)}
      >
        <Sparkles size={15} />
        {label}
      </button>
    );
  }
  function acceptResult() {
    return (
      viewing &&
      viewing.status === "review" && (
        <button
          className={viewingAccepted ? "" : "primary"}
          data-testid={`workbench-accept-${step}`}
          disabled={locked || viewingAccepted || !viewingCurrent}
          onClick={() =>
            action(
              { kind: "accept", jobId: viewing.id },
              "이 결과를 채택했습니다. 다음 단계는 직접 선택해 주세요.",
            )
          }
        >
          <Check size={15} />
          {viewingAccepted ? "채택한 결과" : "이 결과 채택"}
        </button>
      )
    );
  }
  function nextButton(next: Page, label?: string) {
    return (
      <div className="wb-next">
        <p>
          {ready[next]
            ? "현재 단계에서 계속 수정하거나, 준비되면 다음 단계로 이동하세요."
            : reasons[next]}
        </p>
        <button
          data-testid={`workbench-next-${next}`}
          className="primary"
          disabled={locked || !ready[next]}
          onClick={() => go(next)}
        >
          {label ?? `${pages.find((x) => x.id === next)?.title} 단계로`}
          <ArrowRight size={15} />
        </button>
      </div>
    );
  }
  return (
    <main ref={scrollHost} className="asset-workbench" data-testid="workbench">
      <div className="wb-intro">
        <p>
          단계마다 설정하고, 결과를 골라 완성하세요.
          <br />
          선택하거나 탭을 옮겨도 다음 작업은 자동으로 시작하지 않습니다.
        </p>
        <div className="wb-connections">
          <button onClick={() => run({ type: "studio.open" })}>
            Tripo 연결
          </button>
          <button
            disabled={busy}
            onClick={async () => {
              const r = await run({ type: "workbench.probe" });
              if (r)
                setProbe(
                  typeof r.message === "string"
                    ? r.message
                    : "연결 상태를 확인했습니다. 실행 시 필요한 연결을 다시 확인합니다.",
                );
            }}
          >
            <RefreshCw size={13} />
            연결 확인
          </button>
        </div>
      </div>
      {probe && <p className="wb-note">{probe}</p>}
      <nav className="wb-steps" aria-label="에셋 제작 단계">
        {pages.map((s, i) => (
          <button
            key={s.id}
            data-testid={`workbench-step-${s.id}`}
            className={page === s.id ? "active" : ""}
            disabled={!ready[s.id]}
            title={ready[s.id] ? s.title : reasons[s.id]}
            onClick={() => go(s.id)}
          >
            <span className="wb-step-index">{i + 1}</span>
            <span>
              <strong>{s.title}</strong>
              <small>{s.detail}</small>
            </span>
          </button>
        ))}
      </nav>
      {currentStatus && (
        <div
          className={`wb-status ${currentStatus.status === "running" ? "" : "error"}`}
          data-testid="workbench-status"
          role="status"
        >
          {currentStatus.status === "running" ? (
            <LoaderCircle className="spin" size={20} />
          ) : (
            <CircleAlert size={20} />
          )}
          <div>
            <strong>
              {statuses[currentStatus.status]}
              {active
                ? ` · ${Math.floor(elapsed / 60)}분 ${elapsed % 60}초`
                : ""}
            </strong>
            <p>
              {currentStatus.summary ||
                "작업자가 현재 단계의 결과를 준비하고 있습니다."}
            </p>
            <small>
              마지막 활동{" "}
              {new Date(currentStatus.updatedAt).toLocaleTimeString("ko-KR")}
            </small>
            {currentStatus.status === "submission_unknown" && (
              <p>
                중복 결제를 피하려면 Tripo에서 기존 제출을 먼저 확인해 주세요.
                제출 여부를 모르는 상태에서는 재생성하지 않습니다.
              </p>
            )}
          </div>
          {active && (
            <button
              data-testid="workbench-cancel"
              disabled={busy}
              onClick={() => action({ kind: "cancel" })}
            >
              <Square size={12} />
              중단
            </button>
          )}
          {currentStatus.validationPending && (
            <button
              data-testid="workbench-revalidate"
              disabled={locked}
              onClick={() =>
                action({ kind: "retry-validation", jobId: currentStatus.id })
              }
            >
              <RefreshCw size={13} />
              기존 결과 다시 검사
            </button>
          )}
          {!active &&
            !currentStatus.validationPending &&
            currentInputs(currentStatus) && (
              <button
                data-testid="workbench-retry"
                disabled={locked}
                onClick={() =>
                  action({ kind: "retry", jobId: currentStatus.id })
                }
              >
                <RefreshCw size={13} />
                기존 작업 이어서 확인
              </button>
            )}
        </div>
      )}
      {!ready[page] ? (
        <div className="wb-empty">
          <CircleAlert size={30} />
          <h3>앞 단계의 선택이 필요합니다.</h3>
          <p>{reasons[page]}</p>
          <button onClick={() => setPage("concept")}>이미지 단계 보기</button>
        </div>
      ) : (
        <div className="wb-layout">
          <aside className="wb-controls" data-testid="workbench-controls">
            <h2>{pages.find((s) => s.id === page)?.title}</h2>
            {page === "concept" && (
              <>
                <p>
                  연결된 이미지 생성 도구에서 후보 4장을 만들고 하나를 고릅니다.
                </p>
                <label className="field">
                  <span>이미지 생성 도구</span>
                  <select
                    data-testid="workbench-provider"
                    value={provider}
                    onChange={(e) =>
                      setProvider(e.target.value as "gpt" | "tripo")
                    }
                  >
                    <option value="gpt">GPT</option>
                    <option value="tripo">Tripo</option>
                  </select>
                </label>
                <label className="field">
                  <span>캐릭터 이미지 프롬프트</span>
                  <textarea
                    data-testid="workbench-concept-prompt"
                    rows={7}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="정면 전신 캐릭터, 원하는 외형·의상·스타일…"
                  />
                </label>
                {approvalBox()}
                {launch(
                  "이미지 후보 4장 만들기",
                  { step: "concept", provider, prompt },
                  !prompt.trim(),
                )}
                <hr />
                <button
                  disabled={locked}
                  onClick={async () => {
                    const a = await run({
                      type: "asset.import",
                      id: p.id,
                      kind: "image",
                    });
                    if (a?.id)
                      await action({ kind: "import-source", assetId: a.id });
                  }}
                >
                  <Upload size={15} />
                  기존 이미지 가져오기
                </button>
                {p.assets.some((a) => a.kind === "image") && (
                  <label className="field">
                    <span>프로젝트의 이미지 사용</span>
                    <select
                      data-testid="workbench-import-source"
                      value=""
                      disabled={locked}
                      onChange={(e) => {
                        if (e.target.value)
                          void action({
                            kind: "import-source",
                            assetId: e.target.value,
                          });
                      }}
                    >
                      <option value="">저장된 이미지 선택…</option>
                      {p.assets
                        .filter((a) => a.kind === "image")
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.label}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
              </>
            )}
            {page === "parts" && (
              <>
                <label className="field">
                  <span>파츠 템플릿</span>
                  <select value="human" disabled>
                    <option value="human">인간 · 머리 / 머리카락 / 몸통</option>
                  </select>
                </label>
                {selectedSource && (
                  <img
                    className="wb-selected-source"
                    src={url(selectedSource)}
                    alt="선택한 전체 캐릭터"
                  />
                )}
                {partMode === "separate" ? (
                  <>
                    <p>분리 이미지를 확인하고 수정한 뒤 모델을 만듭니다.</p>
                    <label className="field">
                      <span>분리·수정 지시</span>
                      <textarea
                        data-testid="workbench-separate-prompt"
                        rows={5}
                        value={separationPrompt}
                        onChange={(e) => setSeparationPrompt(e.target.value)}
                      />
                    </label>
                    {approvalBox()}
                    {launch(
                      latestJob
                        ? "분리 이미지 수정하기"
                        : "파츠 이미지 분리하기",
                      {
                        step: "separate",
                        prompt: separationPrompt,
                        provider: "gpt",
                        baseJobId: editBase?.id,
                      },
                    )}
                  </>
                ) : (
                  <>
                    <label className="field">
                      <span>이번에 생성할 파츠</span>
                      <select
                        data-testid="workbench-model-role"
                        value={role}
                        onChange={(e) => {
                          setRole(e.target.value as WorkbenchRole);
                          setViewJobId("");
                        }}
                      >
                        {roles.map((r) => (
                          <option key={r} value={r}>
                            {roleLabels[r]}
                            {selection(`model:${r}`) ? " · 선택 완료" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>폴리곤 수</span>
                      <input
                        data-testid="workbench-polygon-count"
                        type="number"
                        min={1}
                        step={1000}
                        value={polygonCount}
                        onChange={(e) =>
                          setPolygonCount(Number(e.target.value))
                        }
                      />
                      <small>
                        Tripo에서 허용하는 범위를 확인합니다. 범위를 벗어나면
                        설정값을 임의로 바꾸지 않고 알려드립니다.
                      </small>
                    </label>
                    <label className="field">
                      <span>모델 생성 지시</span>
                      <textarea
                        rows={4}
                        value={modelPrompt}
                        onChange={(e) => setModelPrompt(e.target.value)}
                      />
                    </label>
                    <div className="wb-note">
                      Smart Mesh P2 · 후보 4개
                      <br />
                      현재 선택한 파츠만 생성합니다.
                    </div>
                    {approvalBox()}
                    {launch(
                      `${roleLabels[role]} 모델 후보 4개 만들기`,
                      {
                        step: "model",
                        role,
                        polygonCount,
                        prompt: modelPrompt,
                      },
                      !separated ||
                        !Number.isFinite(polygonCount) ||
                        polygonCount < 1,
                    )}
                  </>
                )}
              </>
            )}
            {page === "surface" && (
              <>
                <p>
                  선택한 머리·머리카락·몸통에 Smart UV와 텍스처를 적용합니다.
                </p>
                {selectedSource && (
                  <img
                    className="wb-selected-source"
                    src={url(selectedSource)}
                    alt="색상과 스타일 기준 이미지"
                  />
                )}
                <label className="field">
                  <span>텍스처 지시</span>
                  <textarea
                    rows={5}
                    value={surfacePrompt}
                    onChange={(e) => setSurfacePrompt(e.target.value)}
                  />
                </label>
                {approvalBox()}
                {launch("Smart UV + 텍스처 작업", {
                  step: "surface",
                  prompt: surfacePrompt,
                })}
              </>
            )}
            {page === "assembly" && (
              <>
                <p>
                  Blender + Astra가 원본의 비율과 실루엣에 맞춰 조립합니다.
                  명령을 더하며 계속 수정할 수 있습니다.
                </p>
                {selectedSource && (
                  <img
                    className="wb-selected-source"
                    src={url(selectedSource)}
                    alt="조립 기준 전체 이미지"
                  />
                )}
                <h3>수정할 오브젝트</h3>
                <div className="wb-object-list" data-testid="workbench-objects">
                  {sourceObjects.length ? (
                    sourceObjects.map((o) => (
                      <label className="wb-object" key={o.id}>
                        <input
                          type="checkbox"
                          checked={objectIds.includes(o.id)}
                          onChange={(e) =>
                            setObjectIds((ids) =>
                              e.target.checked
                                ? [...ids, o.id]
                                : ids.filter((id) => id !== o.id),
                            )
                          }
                        />
                        <span>
                          {o.name}
                          <small>{categoryLabels[o.category]}</small>
                        </span>
                      </label>
                    ))
                  ) : (
                    <p>조립 결과에서 확인된 오브젝트가 여기에 표시됩니다.</p>
                  )}
                </div>
                <small className="wb-muted">
                  선택하지 않으면 모델 전체에 대한 지시로 전달합니다.
                </small>
                <label className="field">
                  <span>조립·수정 명령</span>
                  <textarea
                    data-testid="workbench-assembly-prompt"
                    rows={5}
                    value={editPrompt}
                    onChange={(e) => setEditPrompt(e.target.value)}
                    placeholder="머리를 조금 줄여 줘. 앞머리는 유지하고 뒷머리만 수정해 줘."
                  />
                </label>
                {launch(
                  candidate ? "Astra에 수정 요청" : "Blender + Astra로 조립",
                  {
                    step: "assembly",
                    prompt:
                      editPrompt.trim() ||
                      "원본 전체 이미지의 비율, 실루엣, 외형에 맞춰 선택한 파츠를 Unity 게임용 캐릭터로 조립하고 다듬어 주세요.",
                    baseJobId: editBase?.id ?? assembly?.job.id,
                    objectIds: objectIds.filter((id) =>
                      sourceObjects.some((o) => o.id === id),
                    ),
                  },
                )}
                <div className="wb-note">
                  수정은 새 버전으로 저장됩니다. 결과를 비교하고 채택하거나 이전
                  버전으로 되돌릴 수 있습니다.
                </div>
              </>
            )}
            {page === "rig" && (
              <>
                <p>몸체의 기본 리깅과 함께, 별도로 움직일 오브젝트를 켭니다.</p>
                <div className="wb-note">
                  몸체 리깅 · 항상 사용
                  <br />
                  Blender + Astra
                </div>
                <h3>추가 뼈 · 웨이트</h3>
                <div
                  className="wb-object-list"
                  data-testid="workbench-rig-targets"
                >
                  {sourceObjects.map((o) => (
                    <label className="wb-object" key={o.id}>
                      <input
                        role="switch"
                        type="checkbox"
                        aria-label={`${o.name} 추가 리깅`}
                        disabled={o.category === "body" || !o.separate}
                        checked={extraRigIds.includes(o.id)}
                        onChange={(e) =>
                          setExtraRigIds((ids) =>
                            e.target.checked
                              ? [...ids, o.id]
                              : ids.filter((id) => id !== o.id),
                          )
                        }
                      />
                      <span>
                        {o.name}
                        <small>
                          {categoryLabels[o.category]}
                          {!o.separate ? " · 먼저 영역 분리 필요" : ""}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
                <p>
                  켜기: 추가 뼈와 웨이트로 별도 움직임
                  <br />
                  끄기: 추가 뼈 없이 몸체를 따라가는 기본 연결
                </p>
                {sourceObjects.some(
                  (o) => !o.separate && o.category !== "body",
                ) && (
                  <div className="wb-note warning">
                    붙어 있는 옷이나 머리카락은 조립 단계에서 대상 영역을 분리한
                    뒤 추가 리깅을 켜 주세요.
                  </div>
                )}
                <label className="field">
                  <span>리깅 추가 지시</span>
                  <textarea
                    data-testid="workbench-rig-prompt"
                    rows={4}
                    value={rigPrompt}
                    onChange={(e) => setRigPrompt(e.target.value)}
                    placeholder="치마가 다리 움직임을 방해하지 않게, 긴 머리카락은 세 구간으로…"
                  />
                </label>
                {launch(
                  "Blender + Astra로 리깅",
                  {
                    step: "rig",
                    prompt:
                      rigPrompt.trim() ||
                      "Unity 게임용 기본 몸체 리깅과 선택한 오브젝트의 추가 뼈 및 웨이트를 만들고 변형을 검사해 주세요.",
                    rigTargets: sourceObjects.map((o) => ({
                      objectId: o.id,
                      extraBones:
                        o.category !== "body" &&
                        o.separate &&
                        extraRigIds.includes(o.id),
                    })),
                  },
                  !sourceObjects.length,
                )}
              </>
            )}
            {page === "motion" && (
              <>
                <p>
                  동작별로 정면·측면·후면 이미지 한 세트를 확인한 뒤 3D
                  애니메이션을 만듭니다.
                </p>
                <label className="field">
                  <span>동작 이름</span>
                  <input
                    data-testid="workbench-motion-name"
                    value={motion}
                    onChange={(e) => {
                      setMotion(e.target.value);
                      setViewJobId("");
                    }}
                    placeholder="오른손으로 인사하기"
                  />
                </label>
                <div className="wb-pair">
                  <label className="field">
                    <span>길이 (초)</span>
                    <input
                      type="number"
                      min={0.5}
                      max={30}
                      step={0.5}
                      disabled={motionMode === "animation"}
                      value={
                        motionMode === "animation"
                          ? (reference?.job.request.duration ?? duration)
                          : duration
                      }
                      onChange={(e) => setDuration(Number(e.target.value))}
                    />
                  </label>
                  <label className="field">
                    <span>3D 출력 프레임 속도</span>
                    <input
                      type="number"
                      min={1}
                      max={30}
                      disabled={motionMode === "animation"}
                      value={
                        motionMode === "animation"
                          ? (reference?.job.request.fps ?? fps)
                          : fps
                      }
                      onChange={(e) => setFps(Number(e.target.value))}
                    />
                  </label>
                </div>
                <label className="field">
                  <span>방향별 동작 참조 프레임 수</span>
                  <input
                    data-testid="workbench-reference-count"
                    type="number"
                    min={3}
                    max={12}
                    step={1}
                    disabled={motionMode === "animation"}
                    value={
                      motionMode === "animation"
                        ? (reference?.job.request.referenceFrameCount ??
                          referenceFrameCount)
                        : referenceFrameCount
                    }
                    onChange={(e) =>
                      setReferenceFrameCount(Number(e.target.value))
                    }
                  />
                  <small>
                    동작의 시작·중간·끝을 같은 시점에서 비교하는 주요 포즈
                    이미지입니다. 전체 FPS만큼의 2D 영상을 생성하는 설정은
                    아닙니다.
                  </small>
                </label>
                <label className="wb-checkbox">
                  <input
                    type="checkbox"
                    disabled={motionMode === "animation"}
                    checked={
                      motionMode === "animation"
                        ? (reference?.job.request.loop ?? loop)
                        : loop
                    }
                    onChange={(e) => setLoop(e.target.checked)}
                  />
                  반복 재생 가능한 동작
                </label>
                <label className="field">
                  <span>동작·수정 지시</span>
                  <textarea
                    data-testid="workbench-motion-prompt"
                    rows={5}
                    value={motionPrompt}
                    onChange={(e) => setMotionPrompt(e.target.value)}
                    placeholder="오른손을 천천히 들고 두 번 흔든 뒤 원래 자세로 돌아오기…"
                  />
                </label>
                {motionMode === "reference" ? (
                  <>
                    {approvalBox()}
                    {launch(
                      "멀티뷰 동작 이미지 한 세트 생성",
                      {
                        step: "reference",
                        prompt: motionPrompt.trim() || motion,
                        provider: "gpt",
                        motion,
                        duration,
                        fps,
                        referenceFrameCount,
                        loop,
                        baseJobId: editBase?.id,
                      },
                      !motion.trim(),
                    )}
                  </>
                ) : (
                  <>
                    {launch(
                      "이미지를 보고 Astra로 3D 동작 제작",
                      {
                        step: "animation",
                        prompt: motionPrompt.trim() || motion,
                        motion,
                        duration: reference?.job.request.duration,
                        fps: reference?.job.request.fps,
                        referenceFrameCount:
                          reference?.job.request.referenceFrameCount,
                        loop: reference?.job.request.loop,
                        baseJobId: editBase?.id,
                      },
                      !reference || !motion.trim(),
                    )}
                    <div className="wb-note">
                      채택한 멀티뷰 이미지와 타이밍을 기준으로 Astra가
                      Blender에서 포즈와 키프레임을 만듭니다.
                    </div>
                  </>
                )}
              </>
            )}
            {page === "unity" && (
              <>
                <p>
                  채택한 리깅 모델과 애니메이션을 Unity 프로젝트로 내보내고
                  검사합니다.
                </p>
                <label className="field">
                  <span>Unity 프로젝트</span>
                  <input
                    value={p.unityPath}
                    readOnly
                    placeholder="수동 도구 → Unity로 보내기에서 프로젝트 연결"
                  />
                </label>
                <div className="wb-note">
                  내보내기 결과와 실제 Unity 검사 결과를 구분해 표시합니다.
                </div>
                {launch("Unity로 내보내고 검사", {
                  step: "unity",
                  prompt:
                    "채택한 리깅 모델과 모든 애니메이션을 설정된 Unity 프로젝트로 내보내고 Avatar, 클립 및 재생을 검사해 주세요.",
                })}
              </>
            )}
          </aside>
          <section className="wb-results" data-testid="workbench-results">
            <div className="wb-result-title">
              <h2>
                {page === "concept"
                  ? "마음에 드는 이미지를 고르세요"
                  : page === "assembly"
                    ? "모델을 보며 계속 수정하세요"
                    : "결과 확인"}
              </h2>
              <span>{viewing ? statuses[viewing.status] : "실행 전"}</span>
            </div>
            {page === "parts" && (
              <div className="wb-substeps">
                <button
                  data-testid="workbench-tab-separate"
                  className={partMode === "separate" ? "active" : ""}
                  onClick={() => {
                    setPartMode("separate");
                    setViewJobId("");
                  }}
                >
                  ① 분리 이미지 확인{separated && <Check size={12} />}
                </button>
                <button
                  data-testid="workbench-tab-model"
                  disabled={!separated}
                  className={partMode === "model" ? "active" : ""}
                  onClick={() => {
                    setPartMode("model");
                    setViewJobId("");
                  }}
                >
                  ② 파츠별 모델 선택
                </button>
              </div>
            )}
            {page === "motion" && (
              <div className="wb-substeps">
                <button
                  className={motionMode === "reference" ? "active" : ""}
                  data-testid="workbench-tab-reference"
                  onClick={() => {
                    setMotionMode("reference");
                    setViewJobId("");
                  }}
                >
                  ① 멀티뷰 이미지 확인
                </button>
                <button
                  disabled={!reference}
                  className={motionMode === "animation" ? "active" : ""}
                  data-testid="workbench-tab-animation"
                  onClick={() => {
                    setMotionMode("animation");
                    setViewJobId("");
                  }}
                >
                  ② Astra 3D 애니메이션
                </button>
              </div>
            )}
            {viewing?.status === "review" && (
              <p className="wb-muted" style={{ marginBottom: 15 }}>
                {viewing.summary}
              </p>
            )}
            {viewing && !viewingCurrent && (
              <p className="wb-note warning">
                앞 단계의 선택이 바뀌기 전 결과입니다. 기록은 보존되어 있지만
                현재 결과로 채택하거나 수정 기준으로 사용할 수 없습니다.
              </p>
            )}
            {viewing?.candidates.length ? (
              <>
                {["concept", "model"].includes(step) ? (
                  <div className="wb-candidates">
                    {viewing.candidates.map((c, i) => {
                      const selected =
                        selectedHere?.job.id === viewing.id &&
                        selectedHere.candidate.id === c.id;
                      const img = c.artifacts.find((a) => a.kind === "image");
                      return (
                        <article
                          className={`wb-candidate ${selected ? "selected" : ""}`}
                          key={c.id}
                          data-testid={`workbench-candidate-${i}`}
                        >
                          {step === "model"
                            ? modelView(c)
                            : img && <img src={url(img)} alt={c.label} />}
                          <div className="wb-candidate-footer">
                            <strong>{c.label || `후보 ${i + 1}`}</strong>
                            <button
                              data-testid={`workbench-select-${i}`}
                              className={selected ? "primary" : ""}
                              disabled={
                                locked ||
                                viewing.status !== "review" ||
                                !viewingCurrent ||
                                selected
                              }
                              onClick={() =>
                                action(
                                  {
                                    kind: "select",
                                    jobId: viewing.id,
                                    candidateId: c.id,
                                  },
                                  "사용할 결과를 선택했습니다.",
                                )
                              }
                            >
                              {selected ? (
                                <>
                                  <Check size={13} />
                                  선택됨
                                </>
                              ) : (
                                "이 결과 선택"
                              )}
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <>
                    {resultGallery(candidate)}
                    {!candidate?.artifacts.some(
                      (a) => a.kind === "image" || a.kind === "model",
                    ) && <div className="wb-note">{viewing.summary}</div>}
                    <div
                      className="wb-inline-actions"
                      style={{ marginTop: 16 }}
                    >
                      {acceptResult()}
                    </div>
                  </>
                )}
                {compareId && (
                  <div className="wb-comparison">
                    <div>
                      <h3>이전 버전</h3>
                      {modelView(
                        stageJobs.find((j) => j.id === compareId)
                          ?.candidates[0],
                      )}
                    </div>
                    <div>
                      <h3>현재 보고 있는 버전</h3>
                      {modelView(candidate)}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="wb-empty">
                {active?.slot === slot ? (
                  <LoaderCircle className="spin" size={34} />
                ) : (
                  <ImagePlus size={34} />
                )}
                <h3>
                  {active?.slot === slot
                    ? "결과를 준비하고 있습니다"
                    : "설정한 뒤 이 단계를 실행하세요"}
                </h3>
                <p>
                  {step === "concept"
                    ? "후보 4장을 비교해 하나를 선택하거나 기존 이미지를 가져올 수 있습니다."
                    : step === "separate"
                      ? "머리·머리카락·몸통의 분리 이미지를 먼저 확인합니다. 모델 생성은 분리 결과를 채택한 뒤 직접 실행합니다."
                      : step === "rig"
                        ? "채택한 조립 모델의 실제 오브젝트를 기준으로 추가 리깅을 설정합니다."
                        : "아직 검토할 결과가 없습니다. 왼쪽에서 설정하고 실행하면 결과가 여기에 표시됩니다."}
                </p>
              </div>
            )}
            {page === "concept" && nextButton("parts")}
            {page === "parts" && partMode === "separate" && (
              <div className="wb-next">
                <p>
                  {separated
                    ? "분리 결과를 채택했습니다. 파츠별 모델 설정을 시작하세요."
                    : "세 파츠를 확인하고 결과를 채택하세요."}
                </p>
                <button
                  className="primary"
                  disabled={locked || !separated}
                  onClick={() => {
                    setPartMode("model");
                    setViewJobId("");
                  }}
                >
                  모델 후보 만들기
                  <ArrowRight size={15} />
                </button>
              </div>
            )}
            {page === "parts" && partMode === "model" && (
              <>
                <div className="wb-inline-actions" style={{ marginTop: 18 }}>
                  {roles.map((r) => (
                    <button
                      className={role === r ? "primary" : ""}
                      key={r}
                      onClick={() => {
                        setRole(r);
                        setViewJobId("");
                      }}
                    >
                      {roleLabels[r]}{" "}
                      {selection(`model:${r}`) ? (
                        <CheckCircle2 size={13} />
                      ) : (
                        <Clock size={13} />
                      )}
                    </button>
                  ))}
                </div>
                {nextButton("surface")}
              </>
            )}
            {page === "surface" && nextButton("assembly")}
            {page === "assembly" && nextButton("rig", "조립 완료 · 리깅으로")}
            {page === "rig" && nextButton("motion")}
            {page === "motion" && motionMode === "reference" && (
              <div className="wb-next">
                <p>
                  같은 시점의 정면·측면·후면 동작이 일치하는지 확인하고
                  채택하세요.
                </p>
                <button
                  className="primary"
                  disabled={locked || !reference}
                  onClick={() => {
                    setMotionMode("animation");
                    setViewJobId("");
                  }}
                >
                  3D 동작 제작으로
                  <ArrowRight size={15} />
                </button>
              </div>
            )}
            {page === "motion" &&
              motionMode === "animation" &&
              nextButton("unity")}
            {stageJobs.length > 0 && (
              <div className="wb-history" data-testid="workbench-history">
                <h3>이번 단계의 기록 · {stageJobs.length}개</h3>
                {stageJobs.map((j, i) => (
                  <div className="wb-history-row" key={j.id}>
                    <div>
                      <strong>
                        {new Date(j.createdAt).toLocaleString("ko-KR")} ·{" "}
                        {statuses[j.status]}
                        {selectedHere?.job.id === j.id ? " · 채택됨" : ""}
                      </strong>
                      <p>{j.request.prompt || j.summary}</p>
                    </div>
                    <div className="wb-history-actions">
                      <button
                        disabled={j.id === viewing?.id}
                        onClick={() => setViewJobId(j.id)}
                      >
                        보기
                      </button>
                      {step === "assembly" &&
                        j.status === "review" &&
                        j.id !== viewing?.id && (
                          <button onClick={() => setCompareId(j.id)}>
                            비교
                          </button>
                        )}
                      {!["concept", "model"].includes(step) &&
                        j.status === "review" &&
                        selectedHere?.job.id !== j.id &&
                        currentInputs(j) && (
                          <button
                            disabled={locked}
                            onClick={async () => {
                              await action(
                                { kind: "revert", jobId: j.id },
                                "이 버전을 복원했습니다. 뒤 단계의 결과는 다시 확인해야 합니다.",
                              );
                              setViewJobId(j.id);
                            }}
                          >
                            <RotateCcw size={11} />
                            복원
                          </button>
                        )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
      {legacyRuns.length > 0 && (
        <details className="wb-legacy">
          <summary>이전 자동 제작 기록 · {legacyRuns.length}개</summary>
          <p>
            이전 실행의 결과와 오류 기록입니다. 새 작업은 위의 단계별 제작실에서
            시작하세요.
          </p>
          <p>
            예전 1단계에 저장된 결과가 있다면 새로 생성하지 않고 복구할 수
            있습니다. 먼저 당시와 같은 전체 이미지를 선택해 주세요.
          </p>
          {legacyRuns.map((r) => {
            const separation = r.stages.find((s) => s.kind === "separate");
            const attemptCount = separation?.attempt ?? 0;
            return (
              <div key={r.id} className="wb-legacy-row">
                <span>
                  {new Date(r.createdAt).toLocaleString("ko-KR")} ·{" "}
                  {r.message || r.status}
                </span>
                <div className="wb-inline-actions">
                  {attemptCount > 0 && (
                    <>
                      <select
                        aria-label="복구할 분리 시도"
                        style={{ width: 100 }}
                        value={recoveryAttempts[r.id] ?? 1}
                        onChange={(e) =>
                          setRecoveryAttempts((v) => ({
                            ...v,
                            [r.id]: Number(e.target.value),
                          }))
                        }
                      >
                        {Array.from({ length: attemptCount }, (_, i) => (
                          <option value={i + 1} key={i}>
                            시도 {i + 1}
                          </option>
                        ))}
                      </select>
                      <button
                        data-testid="workbench-recover-separation"
                        disabled={locked || !concept}
                        onClick={async () => {
                          const result = await run(
                            {
                              type: "workbench.recover-separation",
                              id: p.id,
                              runId: r.id,
                              attempt: recoveryAttempts[r.id] ?? 1,
                            },
                            "기존 분리 결과를 복구했습니다. 이미지를 확인하고 채택해 주세요.",
                          );
                          if (result) {
                            setPage("parts");
                            setPartMode("separate");
                            setViewJobId("");
                          }
                        }}
                      >
                        <RotateCcw size={12} />
                        기존 분리 결과 복구
                      </button>
                    </>
                  )}
                  <button
                    onClick={() =>
                      run({ type: "production.open", runId: r.id })
                    }
                  >
                    <FolderOpen size={12} />
                    기록 폴더
                  </button>
                </div>
              </div>
            );
          })}
        </details>
      )}
    </main>
  );
}
