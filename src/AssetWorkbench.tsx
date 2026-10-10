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
import type { ChatGptStatus, Command, Project } from "../shared/types";
import type {
  Workbench,
  WorkbenchAction,
  WorkbenchArtifact,
  WorkbenchCandidate,
  WorkbenchJob,
  WorkbenchRequest,
  WorkbenchRole,
  WorkbenchModelRole,
  WorkbenchStep,
  WorkbenchView,
} from "../shared/workbench";
import {
  WORKBENCH_VIEWS,
  WORKBENCH_MAX_GENERATION_COUNT,
  workbenchSeparationViews,
} from "../shared/workbench";
import type { ProductionRun } from "../shared/production";
import { workbenchWarningMessages } from "../shared/workbench-checks";
import { Viewport } from "./Viewport";
import "./workbench.css";

const pages = [
  { id: "concept", title: "이미지", detail: "개수 설정 · 결과 선택" },
  { id: "parts", title: "모델링", detail: "바로 제작 · 선택적 분리" },
  { id: "surface", title: "UV · 텍스처", detail: "선택한 모델" },
  { id: "assembly", title: "조립 · 수정", detail: "Blender + Astra" },
  { id: "rig", title: "리깅", detail: "오브젝트별 설정" },
  { id: "motion", title: "애니메이션", detail: "2D 확인 → 3D" },
  { id: "unity", title: "Unity", detail: "내보내기 · 검사" },
] as const;
type Page = (typeof pages)[number]["id"];
const roles: WorkbenchRole[] = ["head", "hair", "body"];
const roleLabels = {
  head: "머리",
  hair: "머리카락",
  body: "몸통",
  whole: "전체 캐릭터",
};
const viewLabels: Record<WorkbenchView, string> = {
  front: "정면",
  back: "후면",
  left: "왼쪽",
  right: "오른쪽",
};
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
const chatGptStateLabels: Record<ChatGptStatus["state"], string> = {
  closed: "연결 안 됨",
  loading: "페이지 로딩 중",
  login_required: "로그인 대기",
  ready: "연결 준비됨",
  failed: "연결 실패",
};

function SourceImageSize({
  projectId,
  image,
}: {
  projectId: string;
  image: WorkbenchArtifact;
}) {
  const [size, setSize] = useState("원본 크기 확인 중");
  useEffect(() => {
    setSize("원본 크기 확인 중");
    const original = new Image();
    original.onload = () =>
      setSize(`원본 ${original.naturalWidth} × ${original.naturalHeight}`);
    original.onerror = () => setSize("원본 크기 확인 불가");
    original.src = window.desktop.assetUrl(projectId, image.path);
    return () => {
      original.onload = null;
      original.onerror = null;
    };
  }, [projectId, image.path, image.sha256]);
  return (
    <small className="wb-image-size" data-testid="workbench-native-image-size">
      {size}
      {image.normalized ? " · 표시 2048 × 2048 정렬" : " · 크기 맞춤 전"}
    </small>
  );
}

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
  const [modelInput, setModelInput] = useState<"whole" | "parts">(() =>
    localStorage.getItem(`partsmith.workbench.modelInput.${p.id}`) === "parts"
      ? "parts"
      : "whole",
  );
  const [partMode, setPartMode] = useState<"separate" | "model">("model");
  const [conceptCount, setConceptCount] = useState(
    w?.jobs.find((j) => j.step === "concept")?.request.generationCount ?? 4,
  );
  const [separationCount, setSeparationCount] = useState(1);
  const [modelCount, setModelCount] = useState(1);
  const [separationMode, setSeparationMode] = useState<"single" | "multiview">(
    "single",
  );
  const [separationViews, setSeparationViews] = useState<WorkbenchView[]>([
    ...WORKBENCH_VIEWS,
  ]);
  const [newSeparation, setNewSeparation] = useState(false);
  const [baseSeparationCandidateId, setBaseSeparationCandidateId] =
    useState("");
  const [motionMode, setMotionMode] = useState<"reference" | "animation">(
    "reference",
  );
  const [role, setRole] = useState<WorkbenchRole>("head");
  const [separationRole, setSeparationRole] = useState<WorkbenchRole | "all">(
    "all",
  );
  const [separationView, setSeparationView] = useState<WorkbenchView | "all">(
    "all",
  );
  const [surfaceRole, setSurfaceRole] = useState<WorkbenchRole | "all">("all");
  const [provider, setProvider] = useState<"gpt" | "tripo">(
    w?.jobs.find((j) => j.step === "concept")?.request.provider ?? "gpt",
  );
  const [imageBackend, setImageBackend] = useState<"chatgpt-web" | "codex">(
    w?.jobs.find(
      (j) => ["concept", "separate"].includes(j.step) && j.request.imageBackend,
    )?.request.imageBackend ?? "chatgpt-web",
  );
  const [externalConcept, setExternalConcept] = useState(true);
  const [externalReply, setExternalReply] = useState("");
  const [runtimeValues, setRuntimeValues] = useState<{id:string;values:Record<string,string>}>({id:"",values:{}});
  const [externalModel, setExternalModel] = useState(!!w?.jobs.find(j => j.step === "model")?.request.externalModel);
  const savedSurface = w?.jobs.find(j => j.request.externalSurface)?.request.externalSurface;
  const [externalSurface, setExternalSurface] = useState(!!savedSurface || externalModel);
  const [observedUvCost, setObservedUvCost] = useState(savedSurface?.observedUvCost ?? 0);
  const [observedTextureCost, setObservedTextureCost] = useState(savedSurface?.observedTextureCost ?? 0);
  const [textureResolution, setTextureResolution] = useState<"2K" | "4K" | "8K">(savedSurface?.textureResolution ?? "8K");
  const [removeLighting, setRemoveLighting] = useState(savedSurface?.removeLighting ?? false);
  const [studioTopology, setStudioTopology] = useState<"quad" | "triangle">("quad");
  const [observedModelCost, setObservedModelCost] = useState(0);
  const [turnaround, setTurnaround] = useState(w?.jobs[0]?.request.conceptMode === "turnaround");
  const [turnaroundPrompt, setTurnaroundPrompt] = useState("채택한 캐릭터를 그대로 유지한 정면·후면·캐릭터의 왼쪽 측면·오른쪽 측면 독립 원본 4장을 한 요청으로 생성하세요. 시트·콜라주·크롭·복제·좌우 반전은 금지합니다. 동일한 중립 자세, 체형·귀·꼬리·색상, 같은 캔버스·확대 비율·중심·발 높이, 전체 몸이 잘리지 않는 직교 시점, 단색 배경을 사용하세요. 각 이미지의 방향은 이미지 밖에서 명시하세요.");
  const [chatGptStatus, setChatGptStatus] = useState<ChatGptStatus>();
  const [chatGptConnecting, setChatGptConnecting] = useState(false);
  const [chatGptWatch, setChatGptWatch] = useState(0);
  const chatGptRequest = useRef(0);
  const chatGptMounted = useRef(true);
  // Connection checks are read-only and must not lock workbench actions or
  // resume a worker. Sequence IDs discard replies from older checks.
  async function checkChatGpt(
    type: "chatgpt.open" | "chatgpt.status" | "chatgpt.reconnect",
  ) {
    const request = ++chatGptRequest.current;
    setChatGptConnecting(true);
    try {
      const status = await window.desktop.call<ChatGptStatus>({ type });
      if (chatGptMounted.current && request === chatGptRequest.current) {
        setChatGptStatus(status);
        setChatGptWatch(Date.now());
      }
    } catch {
      if (chatGptMounted.current && request === chatGptRequest.current)
        setChatGptStatus({
          available: true,
          ready: false,
          state: "failed",
          canReconnect: true,
          reason: "연결 상태를 확인하지 못했습니다. 다시 연결해 주세요.",
          diagnostic: { code: "CONNECTION_CHECK_FAILED" },
        });
    } finally {
      if (chatGptMounted.current && request === chatGptRequest.current)
        setChatGptConnecting(false);
    }
  }
  useEffect(() => {
    chatGptMounted.current = true;
    void checkChatGpt("chatgpt.status");
    return () => {
      chatGptMounted.current = false;
      chatGptRequest.current++;
    };
  }, []);
  const watchChatGpt =
    chatGptStatus?.opened === true &&
    ["loading", "login_required", "failed"].includes(chatGptStatus.state);
  useEffect(() => {
    if (!watchChatGpt || !chatGptWatch || chatGptConnecting) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const request = chatGptRequest.current;
    const poll = async () => {
      if (stopped || Date.now() - chatGptWatch >= 10 * 60 * 1000) return;
      try {
        const status = await window.desktop.call<ChatGptStatus>({
          type: "chatgpt.status",
        });
        if (stopped || request !== chatGptRequest.current) return;
        setChatGptStatus(status);
        if (!status.opened || status.state === "ready") return;
      } catch {
        // A background IPC failure does not erase the last concrete diagnosis.
        return;
      }
      timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 2500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [watchChatGpt, chatGptWatch, chatGptConnecting]);
  const [prompt, setPrompt] = useState(
    w?.jobs.find((j) => j.step === "concept")?.request.prompt ?? "",
  );
  const [separationPrompt, setSeparationPrompt] = useState(
    "원본 캐릭터의 외형을 유지하고 머리, 머리카락, 몸통으로 분리해 주세요. 몸통에는 의상을 포함해 주세요.",
  );
  const [modelPrompt, setModelPrompt] = useState("");
  const [modelEditScope, setModelEditScope] = useState<"all" | "part">("all");
  const [modelEditTarget, setModelEditTarget] = useState("");
  const [surfacePrompt, setSurfacePrompt] = useState(
    "원본 캐릭터 이미지와 색상, 스타일을 맞춰 주세요.",
  );
  const [editPrompt, setEditPrompt] = useState("");
  const [rigPrompt, setRigPrompt] = useState("");
  const [unityPrompt, setUnityPrompt] = useState("");
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
  const [rotatingCandidates, setRotatingCandidates] = useState<string[]>([]);
  const [objectIds, setObjectIds] = useState<string[]>([]);
  const [extraRigIds, setExtraRigIds] = useState<string[]>(
    w?.jobs
      .find((j) => j.step === "rig")
      ?.request.rigTargets?.filter((t) => t.extraBones)
      .map((t) => t.objectId) ?? [],
  );
  const [rigProfile, setRigProfile] = useState<"automatic" | "quadruped">(
    w?.jobs.find(j => j.step === "rig")?.request.rigProfile ?? "automatic",
  );
  const [rigEars, setRigEars] = useState(w?.jobs.find(j => j.step === "rig")?.request.rigControls?.ears ?? false);
  const [rigTail, setRigTail] = useState(w?.jobs.find(j => j.step === "rig")?.request.rigControls?.tail ?? false);
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
  useEffect(() => {
    setModelEditScope("all");
    setModelEditTarget("");
  }, [role, modelInput]);
  useEffect(() => {
    localStorage.setItem(`partsmith.workbench.modelInput.${p.id}`, modelInput);
    setViewJobId("");
    setSurfaceRole("all");
  }, [modelInput, p.id]);
  useEffect(
    () => setApproved(false),
    [
      page,
      partMode,
      motionMode,
      provider,
      imageBackend,
      modelInput,
      conceptCount,
      separationCount,
      modelCount,
      separationMode,
      separationViews,
      newSeparation,
      baseSeparationCandidateId,
      prompt,
      separationPrompt,
      modelPrompt,
      modelEditScope,
      modelEditTarget,
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
      separationRole,
      separationView,
      surfaceRole,
      viewJobId,
    ],
  );

  const jobs = w?.jobs ?? [];
  const currentInputs = (job?: WorkbenchJob) =>
    !!job &&
    Object.entries(job.dependencies).every(([key, value]) => {
      const current = w?.selections[key];
      if (
        current?.jobId === value.jobId &&
        current.candidateId === value.candidateId
      )
        return true;
      if (job.step !== "model" || key !== "separate" || !current) return false;
      const images = (selection: { jobId: string; candidateId: string }) =>
        jobs
          .find((j) => j.id === selection.jobId)
          ?.candidates.find((c) => c.id === selection.candidateId)
          ?.artifacts.filter(
            (a) => a.kind === "image" && a.role === job.request.role,
          )
          .map((a) => `${a.view ?? "front"}:${a.sha256}`)
          .sort() ?? [];
      const previous = images(value),
        next = images(current);
      return (
        previous.length > 0 && JSON.stringify(previous) === JSON.stringify(next)
      );
    });
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
  const separationImagesReady = (
    artifacts: WorkbenchArtifact[] = [],
    views: WorkbenchView[] = [...WORKBENCH_VIEWS],
  ) =>
    roles.every((r) =>
      views.every((v) =>
        artifacts.some(
          (a) =>
            a.kind === "image" && a.role === r && (a.view ?? "front") === v,
        ),
      ),
    );
  const separationReady =
    !!separated &&
    currentInputs(separated.job) &&
    separationImagesReady(
      separated.candidate.artifacts,
      workbenchSeparationViews(separated.job.request),
    );
  const canViewModels =
    modelInput === "whole"
      ? !!concept
      : separationReady ||
        jobs.some(
          (j) =>
            j.step === "model" &&
            j.request.role !== "whole" &&
            j.request.modelInput !== "whole" &&
            j.status === "review" &&
            currentInputs(j),
        );
  const modelRoles: WorkbenchModelRole[] =
    modelInput === "whole" ? ["whole"] : roles;
  const modelRole: WorkbenchModelRole = modelInput === "whole" ? "whole" : role;
  const allModels = modelRoles.every((r) => {
    const selected = selection(`model:${r}`);
    return !!selected && currentInputs(selected.job);
  });
  const surface = selection("surface");
  const surfaceForRoute =
    surface &&
    (surface.job.request.modelInput ??
      (surface.job.dependencies["model:whole"] ? "whole" : "parts")) ===
      modelInput &&
    currentInputs(surface.job)
      ? surface
      : undefined;
  const assembly = selection("assembly");
  const rig = selection("rig");
  const reference = selection(`reference:${motion.trim()}`);
  const selectedSource = concept?.candidate.artifacts.find(
    (a) => a.kind === "image",
  );
  const wholeReference = selection("whole-reference");
  const ready: Record<Page, boolean> = {
    concept: true,
    parts: !!concept,
    surface: allModels,
    assembly: !!surfaceForRoute,
    rig: !!assembly,
    motion: !!rig,
    unity:
      !!rig &&
      Object.keys(w?.selections ?? {}).some((k) => k.startsWith("animation:")),
  };
  const reasons: Record<Page, string> = {
    concept: "",
    parts: "먼저 사용할 전체 이미지를 선택하세요.",
    surface:
      modelInput === "whole"
        ? "사용할 전체 캐릭터 모델을 선택하세요."
        : "머리·머리카락·몸통의 모델을 각각 선택하세요.",
    assembly: "먼저 UV·텍스처 결과를 채택하세요.",
    rig: "먼저 조립된 모델의 버전을 채택하세요.",
    motion: "먼저 리깅 결과를 채택하세요.",
    unity: "먼저 리깅과 3D 애니메이션 결과를 채택하세요.",
  };
  const step: WorkbenchStep =
    page === "parts"
      ? modelInput === "whole"
        ? "model"
        : partMode
      : page === "motion"
        ? motionMode
        : page;
  const slot =
    step === "concept" && turnaround ? "whole-reference" : step === "model"
      ? `model:${modelRole}`
      : ["reference", "animation"].includes(step)
        ? `${step}:${motion.trim()}`
        : step;
  const stageJobs = jobs.filter((j) => j.slot === slot);
  const latestJob = stageJobs[0];
  const viewing = stageJobs.find((j) => j.id === viewJobId) ?? latestJob;
  const viewingCurrent = currentInputs(viewing);
  const editBase =
    viewing?.status === "review" && viewingCurrent ? viewing : undefined;
  const separationBase =
    step === "separate"
      ? [viewing, ...stageJobs].find(
          (j) =>
            j &&
            j.status !== "running" &&
            currentInputs(j) &&
            [...j.candidates, ...(j.draftCandidates ?? [])].some((c) =>
              c.artifacts.some(
                (a) =>
                  a.kind === "image" && roles.includes(a.role as WorkbenchRole),
              ),
            ),
        )
      : undefined;
  const separationCandidates = separationBase
    ? separationBase.candidates.length
      ? separationBase.candidates
      : (separationBase.draftCandidates ?? [])
    : [];
  const baseSeparationCandidate =
    separationCandidates.find((c) => c.id === baseSeparationCandidateId) ??
    separationCandidates.find(
      (c) =>
        separated?.job.id === separationBase?.id &&
        separated?.candidate.id === c.id,
    ) ??
    separationCandidates[0];
  const correctionBase = !newSeparation ? separationBase : undefined;
  const requestedSeparationViews = correctionBase
    ? workbenchSeparationViews(correctionBase.request)
    : separationMode === "single"
      ? ["front" as const]
      : separationViews;
  const baseSeparationImages =
    correctionBase && baseSeparationCandidate
      ? baseSeparationCandidate.artifacts.filter(
          (a) => a.kind === "image" && roles.includes(a.role as WorkbenchRole),
        )
      : [];
  const presentSeparationPairs = new Set(
    baseSeparationImages.map((a) => `${a.role}:${a.view ?? "front"}`),
  );
  const missingSeparationCount = roles.reduce(
    (sum, r) =>
      sum +
      requestedSeparationViews.filter(
        (v) => !presentSeparationPairs.has(`${r}:${v}`),
      ).length,
    0,
  );
  const rerollSeparationCount = correctionBase
    ? (separationRole === "all" ? 3 : 1) *
      (separationView === "all" ? requestedSeparationViews.length : 1) *
      separationCount
    : 3 * requestedSeparationViews.length * separationCount;
  const chosenModel = selection(`model:${modelRole}`);
  const modelEditBase =
    editBase?.candidates.length === 1
      ? editBase
      : chosenModel && currentInputs(chosenModel.job)
        ? chosenModel.job
        : undefined;
  const modelBaseCandidate =
    modelEditBase?.candidates.find(
      (c) =>
        chosenModel?.job.id === modelEditBase.id &&
        c.id === chosenModel.candidate.id,
    ) ??
    (modelEditBase?.candidates.length === 1
      ? modelEditBase.candidates[0]
      : undefined);
  const surfaceHistoryAvailable =
    step === "surface" &&
    stageJobs.some(
      (j) =>
        j.status === "review" &&
        j.candidates.length === 1 &&
        (j.request.modelInput ??
          (j.dependencies["model:whole"] ? "whole" : "parts")) === modelInput,
    );
  const surfaceEditBase =
    step === "surface"
      ? [viewing, surface?.job, ...stageJobs].find(
          (j) =>
            j?.step === "surface" &&
            (j.request.modelInput ??
              (j.dependencies["model:whole"] ? "whole" : "parts")) ===
              modelInput &&
            j.status === "review" &&
            j.candidates.length === 1 &&
            (currentInputs(j) ||
              (surfaceRole !== "all" &&
                Object.entries(j.dependencies).every(
                  ([slot, selection]) =>
                    slot === `model:${surfaceRole}` ||
                    slot === "separate" ||
                    (w?.selections[slot]?.jobId === selection.jobId &&
                      w.selections[slot]?.candidateId ===
                        selection.candidateId),
                ))),
        )
      : undefined;
  const candidate =
    viewing?.candidates.find(
      (c) => step === "separate" && c.id === baseSeparationCandidateId,
    ) ??
    viewing?.candidates.find(
      (c) =>
        selection(slot)?.job.id === viewing.id &&
        selection(slot)?.candidate.id === c.id,
    ) ??
    viewing?.candidates[0];
  const draftImages =
    step === "separate" && !viewing?.candidates.length
      ? (viewing?.draftCandidates ?? []).flatMap((c) =>
          c.artifacts.filter((a) => a.kind === "image"),
        )
      : [];
  const visualWarnings = viewing
    ? workbenchWarningMessages(
        viewing.step,
        draftImages.length ? (viewing.draftChecks ?? []) : viewing.checks,
      )
    : [];
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
  const recovery = currentStatus?.recovery;
  const usesAppChrome = Boolean(currentStatus?.externalExecution?.worker) ||
    (page === "concept" && externalConcept) ||
    (page === "parts" && modelInput === "whole" && externalModel) ||
    (page === "surface" && modelInput === "whole" && externalSurface);
  const submissionService =
    currentStatus?.request.imageBackend === "chatgpt-web"
      ? "ChatGPT"
      : currentStatus &&
          (["model", "surface"].includes(currentStatus.step) ||
            currentStatus.request.provider === "tripo")
        ? "Tripo"
        : "생성 서비스";
  const recoveryAt = recovery?.nextAttemptAt
    ? Date.parse(recovery.nextAttemptAt)
    : NaN;
  const recoveryDelay = Number.isFinite(recoveryAt)
    ? Math.max(0, Math.ceil((recoveryAt - now) / 1000))
    : undefined;
  const elapsed = active
    ? Math.max(0, Math.floor((now - Date.parse(active.externalExecution?.worker?.startedAt ?? active.createdAt)) / 1000))
    : 0;

  async function action(a: WorkbenchAction, message?: string) {
    return run({ type: "workbench.action", id: p.id, action: a }, message);
  }
  async function execute(request: WorkbenchRequest) {
    setViewJobId("");
    setCompareId("");
    await action({
      kind: "execute",
      request:
        ["concept", "separate"].includes(request.step) &&
        request.provider !== "tripo"
          ? { ...request, imageBackend,
              executionMode: request.step === "concept" && externalConcept ? "codex-app" : "worker" }
          : request.step === "model" && externalModel && request.modelInput === "whole" && !request.baseJobId
            ? { ...request, executionMode: "codex-app", externalModel: {
                model: "P2.0", topology: studioTopology, observedCreditCost: observedModelCost } }
            : request.step === "surface" && externalSurface && request.modelInput === "whole" && !request.baseJobId
              ? { ...request, executionMode: "codex-app", externalSurface: {
                  observedUvCost, observedTextureCost, textureResolution, removeLighting } }
            : request,
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
  const url = (a: WorkbenchArtifact) =>
    window.desktop.assetUrl(p.id, a.normalized?.path ?? a.path);
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
  function separationGallery(
    images: WorkbenchArtifact[],
    draft = false,
    candidateId?: string,
  ) {
    const galleryViews = viewing
      ? workbenchSeparationViews(viewing.request)
      : requestedSeparationViews;
    const count = new Set(
      images
        .filter((a) => roles.includes(a.role as WorkbenchRole))
        .map((a) => `${a.role}:${a.view ?? "front"}`),
    ).size;
    return (
      <div
        className="wb-separation-matrix"
        data-testid="workbench-separation-views"
      >
        <div data-testid={draft ? "workbench-draft-photos" : undefined}>
          <p className="wb-draft-caption">
            파츠별 {galleryViews.length}방향 이미지 · {count}/
            {3 * galleryViews.length}장 준비됨
          </p>
          <p className="wb-muted">
            머리·머리카락·몸통의{" "}
            {galleryViews.map((v) => viewLabels[v]).join(", ")} 이미지를
            확인하세요. 저장된 사진은 유지하면서 없는 방향만 채우거나, 특정
            사진에 수정 지시를 내릴 수 있습니다.
          </p>
          <p className="wb-muted">
            2048×2048 캔버스 · 같은 파츠의 정면 기준 높이와 중심을 맞춥니다.
            원본 비율과 파일은 보존하며, 맞춘 사진을 Tripo에 전달합니다. 2048
            크기 맞춤은 원본에 없는 세부 묘사를 복원하지 않습니다.
          </p>
          {viewing && !locked && images.length > 0 && (
            <button
              data-testid="workbench-normalize-images"
              onClick={() =>
                action(
                  { kind: "normalize-images", jobId: viewing.id },
                  "저장된 사진의 크기와 중심을 맞췄습니다. 새 이미지 생성은 없습니다.",
                )
              }
            >
              <RefreshCw size={14} /> 저장된 사진 크기·중심 맞추기
            </button>
          )}
          {roles.map((r) => (
            <section
              className="wb-separation-role"
              key={r}
              data-testid={`workbench-draft-${r}`}
            >
              <h3>{roleLabels[r]}</h3>
              <div
                className={`wb-four-views wb-view-count-${galleryViews.length}`}
              >
                {galleryViews.map((v) => {
                  const image = images.find(
                    (a) => a.role === r && (a.view ?? "front") === v,
                  );
                  return (
                    <div
                      className={`wb-view-card ${image ? "ready" : "missing"}`}
                      key={v}
                      data-testid={`workbench-separation-${r}-${v}`}
                    >
                      {image ? (
                        <img
                          src={url(image)}
                          alt={`${roleLabels[r]} ${viewLabels[v]} 분리 이미지`}
                        />
                      ) : (
                        <div className="wb-draft-missing">
                          <ImagePlus size={22} />
                          <span>아직 없음</span>
                        </div>
                      )}
                      <div className="wb-view-caption">
                        <strong>{viewLabels[v]}</strong>
                        <button
                          disabled={locked || !viewingCurrent}
                          data-testid={`workbench-edit-${r}-${v}`}
                          onClick={() => {
                            setNewSeparation(false);
                            if (candidateId)
                              setBaseSeparationCandidateId(candidateId);
                            setSeparationRole(r);
                            setSeparationView(v);
                          }}
                        >
                          {image ? "수정" : "선택"}
                        </button>
                      </div>
                      {image && (
                        <SourceImageSize projectId={p.id} image={image} />
                      )}
                      {image?.normalizationIssue && (
                        <p className="wb-image-issue">
                          {image.normalizationIssue}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
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
        {step === "separate" ? (
          separationGallery(images, false, c?.id)
        ) : step === "reference" &&
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
              <div className="wb-frames">
                {images.map((a, i) => (
                  <div key={a.path}>
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
  function singleModelGallery(c: WorkbenchCandidate) {
    const img = c.artifacts.find((a) => a.kind === "image");
    const previewKey = `${viewing?.id}/${c.id}`;
    const rotating = rotatingCandidates.includes(previewKey);
    return (
      <div className="wb-single-model" data-testid="workbench-single-model">
        {rotating || !img ? (
          modelView(c)
        ) : (
          <img
            className="wb-single-model-photo"
            src={url(img)}
            alt={`${c.label} 모델 검토 사진`}
          />
        )}
        {img && modelArtifact(c) && (
          <button
            className="wb-preview-toggle"
            data-testid="workbench-preview3d-single"
            onClick={() =>
              setRotatingCandidates((ids) =>
                rotating
                  ? ids.filter((id) => id !== previewKey)
                  : [...ids, previewKey],
              )
            }
          >
            {rotating ? "사진으로 확인" : "3D로 돌려보기"}
          </button>
        )}
      </div>
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
            {step === "concept" && turnaround ? "전체 캐릭터 4방향 독립 이미지 1세트" : step === "concept"
              ? `이미지 후보 ${conceptCount}장`
              : step === "separate"
                ? `머리·머리카락·몸통 × ${requestedSeparationViews.length}방향 × ${separationCount}세트. ${correctionBase ? `현재 선택 범위 ${rerollSeparationCount}장 수정 또는 누락 ${missingSeparationCount}장만 생성합니다.` : `총 ${rerollSeparationCount}장 생성합니다.`}`
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
  function launch(
    label: string,
    request: WorkbenchRequest,
    disabled = false,
    testId?: string,
  ) {
    return (
      <button
        className="primary"
        data-testid={testId ?? `workbench-execute-${step}`}
        disabled={
          locked ||
          disabled ||
          (request.generationCount !== undefined &&
            (!Number.isInteger(request.generationCount) ||
              request.generationCount < 1 ||
              request.generationCount > WORKBENCH_MAX_GENERATION_COUNT)) ||
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
          disabled={
            locked ||
            viewingAccepted ||
            !viewingCurrent ||
            (step === "separate" &&
              !separationImagesReady(
                candidate?.artifacts,
                workbenchSeparationViews(viewing.request),
              ))
          }
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
  function imageConnectionHelp() {
    if (page === "concept" && externalConcept) return <p className="wb-note">
      실행 버튼을 누르면 앱의 Codex 작업자가 연결된 Chrome에서 이미지를 만들고 원본을 가져옵니다.
      Chrome에서 ChatGPT 로그인을 유지하세요. 진행 상황과 필요한 확인은 이 앱에 표시됩니다.
    </p>;
    return (
      <p className="wb-note" data-testid="workbench-image-backend-help">
        {imageBackend === "chatgpt-web"
          ? "본인 계정의 ChatGPT 웹 채팅에서 생성하고 원본을 가져옵니다. 위의 ChatGPT 연결에서 로그인하세요. Codex 로그인과는 별도이며, 웹 화면의 모델 설정을 유지합니다."
          : "기존 Codex 로그인으로 내장 이미지 도구를 실행합니다. ChatGPT 웹 채팅과는 다른 경로이며, 설정된 모델과 추론 수준을 유지합니다."}
      </p>
    );
  }
  function countInput(
    label: string,
    value: number,
    onChange: (value: number) => void,
    testId: string,
  ) {
    return (
      <label className="field">
        <span>{label}</span>
        <input
          data-testid={testId}
          type="number"
          min={1}
          max={WORKBENCH_MAX_GENERATION_COUNT}
          step={1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <small>
          1–{WORKBENCH_MAX_GENERATION_COUNT}개 · 앱의 요청 범위입니다. 서비스가
          지원하는 실제 개수와 비용을 확인하며 임의로 바꾸지 않습니다.
        </small>
      </label>
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
        {!usesAppChrome && <div className="wb-connections">
          <button
            data-testid="workbench-chatgpt-open"
            disabled={busy || chatGptConnecting}
            onClick={() => void checkChatGpt("chatgpt.open")}
          >
            ChatGPT 연결
          </button>
          <button
            data-testid="workbench-chatgpt-status"
            disabled={busy || chatGptConnecting}
            onClick={() => void checkChatGpt("chatgpt.status")}
          >
            ChatGPT 상태 확인
          </button>
          {chatGptStatus?.canReconnect && (
            <button
              data-testid="workbench-chatgpt-reconnect"
              disabled={busy || chatGptConnecting}
              onClick={() => void checkChatGpt("chatgpt.reconnect")}
            >
              <RefreshCw size={13} />
              ChatGPT 다시 연결
            </button>
          )}
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
        </div>}
      </div>
      {probe && <p className="wb-note">{probe}</p>}
      {chatGptStatus && !usesAppChrome && (
        <div
          className={`wb-note${chatGptStatus.state === "failed" ? " warning" : ""}`}
          data-testid="workbench-chatgpt-connection-status"
          data-state={chatGptStatus.state}
          role="status"
          aria-live="polite"
        >
          ChatGPT 웹 · {chatGptStateLabels[chatGptStatus.state]} —{" "}
          {chatGptStatus.reason}
          {chatGptStatus.diagnostic && (
            <small
              className="wb-connection-diagnostic"
              data-testid="workbench-chatgpt-diagnostic"
            >
              진단: {chatGptStatus.diagnostic.code}
              {chatGptStatus.diagnostic.host &&
                ` · ${chatGptStatus.diagnostic.host}`}
              {chatGptStatus.diagnostic.path &&
                ` ${chatGptStatus.diagnostic.path}`}
            </small>
          )}
        </div>
      )}
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
              {currentStatus.externalExecution ? currentStatus.status === "running" ? "Codex · Chrome 작업 중" : "Codex 실행 · 확인 필요" : statuses[currentStatus.status]}
              {active
                ? ` · ${Math.floor(elapsed / 60)}분 ${elapsed % 60}초`
                : ""}
            </strong>
            <p>
              {currentStatus.summary ||
                "작업자가 현재 단계의 결과를 준비하고 있습니다."}
            </p>
            {currentStatus.externalExecution && <div>
              <p>작업 ID: {currentStatus.id}</p>
              <p>현재 단계의 승인한 설정으로 Codex가 Chrome 작업을 실행하고 결과를 이 앱으로 가져옵니다.</p>
              {currentStatus.externalExecution.worker?.question && <p data-testid="workbench-codex-question">{currentStatus.externalExecution.worker.question}</p>}
              {currentStatus.externalExecution.worker?.approval && (()=>{
                const approval=currentStatus.externalExecution!.worker!.approval!;
                const values=runtimeValues.id===approval.id ? runtimeValues.values : {};
                const change=(id:string,value:string)=>setRuntimeValues({id:approval.id,values:{...values,[id]:value}});
                return <div className="wb-recovery" data-testid="workbench-codex-approval">
                  <strong>{approval.title}</strong>
                  <p style={{whiteSpace:"pre-wrap"}}>{approval.detail}</p>
                  {approval.fields.map(field=><label className="field" key={field.id}>
                    <span>{field.label}{field.required ? " (필수)" : ""}</span>
                    {field.options ? <select aria-label={field.label} value={values[field.id] ?? ""} onChange={e=>change(field.id,e.target.value)}>
                      <option value="">선택하세요</option>{field.options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
                    </select> : <input aria-label={field.label} value={values[field.id] ?? ""} maxLength={12000} onChange={e=>change(field.id,e.target.value)} />}
                  </label>)}
                  <button data-testid="workbench-codex-approve" disabled={busy || approval.fields.some(f=>f.required && !values[f.id])}
                    onClick={()=>void action({kind:"external-approval",jobId:currentStatus.id,approvalId:approval.id,answer:{accepted:true,values}})}>선택한 내용으로 계속</button>
                  <button data-testid="workbench-codex-decline" disabled={busy}
                    onClick={()=>void action({kind:"external-approval",jobId:currentStatus.id,approvalId:approval.id,answer:{accepted:false,values:{}}})}>허용하지 않음</button>
                </div>;
              })()}
              {currentStatus.externalExecution.worker && currentStatus.status !== "running" && <label className="field">
                <span>확인 답변 · 현재 작업에 대한 지시</span>
                <textarea data-testid="workbench-codex-reply" value={externalReply} maxLength={6000}
                  onChange={e=>setExternalReply(e.target.value)} placeholder="예: Chrome에서 로그인을 완료했습니다. 기존 결과를 이어서 확인해 주세요." />
              </label>}
              <button data-testid="workbench-codex-run" disabled={locked || !["needs_input","submission_unknown"].includes(currentStatus.status) ||
                (currentStatus.externalExecution.state === "reserved" && !currentStatus.externalExecution.worker) ||
                ((currentStatus.externalExecution.worker?.attempt ?? 0) >= 3 && !externalReply.trim())}
                onClick={()=>{void action({kind:"external-run",jobId:currentStatus.id,reply:externalReply || undefined,
                  continueOnce:(currentStatus.externalExecution!.worker?.attempt ?? 0) >= 3});setExternalReply("");}}>
                {(currentStatus.externalExecution.worker?.attempt ?? 0) >= 3 ? "작성한 지시로 기존 작업 1회 이어서 확인" : currentStatus.externalExecution.worker ? "답변하고 기존 작업 이어서 확인" : "Codex로 실행"}
              </button>
              {(currentStatus.externalExecution.worker?.attempt ?? 0) >= 3 && <p>기본 3회 실행이 끝났습니다. 해결한 문제와 이어서 할 내용을 작성하면 기존 제출·비용 기록을 보존해 한 번만 실행합니다. 완료된 생성은 반복하지 않습니다.</p>}
              <button onClick={() => void run({ type: "workbench.open", id: p.id })}>작업 폴더 열기</button>
              <button data-testid="workbench-external-receive"
                disabled={currentStatus.externalExecution.state !== "reserved" || locked}
                onClick={() => void action({kind: "external-receive", jobId: currentStatus.id})}>저장된 결과 다시 확인</button>
              <button disabled={currentStatus.status !== "needs_input" || locked}
                onClick={() => void action({kind: "external-cancel", jobId: currentStatus.id})}>외부 작업 추적 중지</button>
            </div>}
            {recovery && (
              <div
                className={`wb-recovery ${recovery.state}`}
                data-testid="workbench-recovery"
              >
                <div className="wb-recovery-heading">
                  <RefreshCw
                    size={13}
                    className={recovery.state === "running" ? "spin" : ""}
                  />
                  <strong>
                    {recovery.state === "blocked"
                      ? "사용자 확인 필요"
                      : recovery.state === "exhausted"
                        ? `자동 복구 ${recovery.attempt}/${recovery.maxAttempts}회 후 중지`
                        : `자동 복구 ${recovery.attempt}/${recovery.maxAttempts}`}
                  </strong>
                  {recovery.state === "waiting" && (
                    <span
                      data-testid="workbench-recovery-countdown"
                      aria-live="off"
                    >
                      {recoveryDelay === undefined
                        ? "다시 확인할 준비 중"
                        : recoveryDelay > 0
                          ? `${recoveryDelay}초 후 다시 확인`
                          : "다시 확인하는 중…"}
                    </span>
                  )}
                  {recovery.state === "running" && (
                    <span>원인 확인 · 복구 중</span>
                  )}
                </div>
                <p>{recovery.reason}</p>
                <small>
                  {recovery.state === "blocked"
                    ? "안내된 확인을 마치면 기존 작업을 이어서 확인할 수 있습니다."
                    : recovery.state === "exhausted"
                      ? "기존 결과와 오류 기록을 보존했습니다. 원인을 확인한 뒤 기존 작업을 다시 확인할 수 있습니다."
                      : "현재 단계의 설정과 기존 결과를 유지하며 복구합니다. 완료 후 결과를 직접 확인해 주세요."}
                </small>
              </div>
            )}
            <small>
              마지막 활동{" "}
              {new Date(currentStatus.updatedAt).toLocaleTimeString("ko-KR")}
            </small>
            {currentStatus.status === "submission_unknown" && (
              <p>
                중복 생성을 피하려면 {submissionService}에서 기존 제출을 먼저
                확인해 주세요. 제출 여부를 모르는 상태에서는 재생성하지
                않습니다.
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
          {!active && currentStatus.status === "submission_unknown" && (
            <button
              data-testid="workbench-resolve-submission"
              disabled={locked}
              onClick={async () => {
                if (
                  !window.confirm(
                    `${submissionService} 화면에서 이 작업이 실제로 제출되지 않았음을 확인했나요?\n\n이미 생성 중이거나 결과가 있으면 취소하고 기존 작업을 이어서 확인하세요. 미제출을 확인하면 이 기록을 종료하고 새 실행을 허용합니다. 이 버튼은 생성을 시작하지 않습니다. 앱에 실제 제출 기록이 있으면 해제할 수 없습니다.`,
                  )
                )
                  return;
                await action(
                  {
                    kind: "resolve-submission",
                    jobId: currentStatus.id,
                    confirmedNotSubmitted: true,
                  },
                  "미제출 확인을 기록했습니다. 설정을 확인한 뒤 새 작업을 직접 실행하세요.",
                );
              }}
            >
              {submissionService}에서 미제출 확인 · 새 실행 허용
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
                {currentStatus.step === "separate"
                  ? "저장된 파츠를 재사용해 이어서 만들기"
                  : "기존 작업 이어서 확인"}
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
                  원하는 수만큼 이미지를 만들고 모델링에 사용할 하나를 고릅니다.
                </p>
                <label className="field">
                  <span>이미지 생성 도구</span>
                  <select
                    data-testid="workbench-provider"
                    value={provider === "tripo" ? "tripo" : imageBackend}
                    onChange={(e) => {
                      if (e.target.value === "tripo") setProvider("tripo");
                      else {
                        setProvider("gpt");
                        setImageBackend(
                          e.target.value as "chatgpt-web" | "codex",
                        );
                      }
                    }}
                  >
                    <option value="chatgpt-web">GPT · ChatGPT 웹</option>
                    <option value="codex">GPT · Codex 내장</option>
                    <option value="tripo">Tripo</option>
                  </select>
                </label>
                {provider === "gpt" && <label className="wb-note">
                  <input type="checkbox" data-testid="workbench-external-concept"
                    checked={externalConcept} onChange={e => { setExternalConcept(e.target.checked); setApproved(false); }} />
                  앱의 Codex로 Chrome에서 실행 · 컨셉 이미지
                </label>}
                {provider === "gpt" && imageConnectionHelp()}
                {!turnaround && countInput(
                  "생성할 이미지 수",
                  conceptCount,
                  setConceptCount,
                  "workbench-concept-count",
                )}
                {!turnaround && <label className="field">
                  <span>캐릭터 이미지 프롬프트</span>
                  <textarea
                    data-testid="workbench-concept-prompt"
                    rows={7}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="정면 전신 캐릭터, 원하는 외형·의상·스타일…"
                  />
                </label>}
                {concept && externalConcept && provider === "gpt" && <label className="field">
                  <span>이미지 작업</span>
                  <select data-testid="workbench-concept-mode" value={turnaround ? "turnaround" : "design"}
                    onChange={e => { setTurnaround(e.target.value === "turnaround"); setApproved(false); setViewJobId(""); }}>
                    <option value="design">초기 디자인 후보</option>
                    <option value="turnaround">채택한 디자인의 전체 4방향 · 분리 안 함</option>
                  </select>
                </label>}
                {turnaround && <label className="field"><span>전체 4방향 지시문 · 정면/후면/좌/우 1세트</span>
                  <textarea data-testid="workbench-turnaround-prompt" value={turnaroundPrompt} onChange={e => setTurnaroundPrompt(e.target.value)} />
                </label>}
                {approvalBox()}
                {launch(
                  turnaround ? "전체 4방향 원본 만들기" : `이미지 후보 ${conceptCount}장 만들기`,
                  {
                    step: "concept",
                    provider,
                    prompt: turnaround ? turnaroundPrompt : prompt,
                    generationCount: turnaround ? 1 : conceptCount,
                    conceptMode: turnaround ? "turnaround" : "design",
                  },
                  turnaround ? !turnaroundPrompt.trim() || !concept || !externalConcept || provider !== "gpt" : !prompt.trim(),
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
                  <span>모델링 방법</span>
                  <select
                    data-testid="workbench-model-input"
                    value={modelInput}
                    disabled={locked}
                    onChange={(e) => {
                      const next = e.target.value as "whole" | "parts";
                      setModelInput(next);
                      setPartMode(next === "whole" ? "model" : "separate");
                      setViewJobId("");
                    }}
                  >
                    <option value="whole">바로 모델링 · 분리 안 함</option>
                    <option value="parts">파츠로 분리한 뒤 모델링</option>
                  </select>
                  <small>
                    전체 이미지로 바로 만들거나, 머리·머리카락·몸통을 나누어
                    만들 수 있습니다. 경로를 바꿔도 기존 결과는 보존됩니다.
                  </small>
                </label>
                {modelInput === "whole" && externalModel && wholeReference ? (
                  <div className="wb-whole-views" data-testid="workbench-model-input-views">
                    {wholeReference.candidate.artifacts.filter(a => a.kind === "image").map(a =>
                      <figure key={a.path}><img src={url(a)} alt={`모델 입력 ${a.view}`} /><figcaption>{viewLabels[a.view!]}</figcaption></figure>)}
                  </div>
                ) : selectedSource && (
                  <img
                    className="wb-selected-source"
                    src={url(selectedSource)}
                    alt="선택한 전체 캐릭터"
                  />
                )}
                {modelInput === "parts" && partMode === "separate" ? (
                  <>
                    {separationBase && (
                      <label className="field">
                        <span>이번 이미지 작업</span>
                        <select
                          data-testid="workbench-separation-operation"
                          value={newSeparation ? "new" : "correct"}
                          onChange={(e) => {
                            setNewSeparation(e.target.value === "new");
                            setSeparationRole("all");
                            setSeparationView("all");
                          }}
                        >
                          <option value="correct">
                            기존 세트 수정 · 없는 사진 채우기
                          </option>
                          <option value="new">새 분리 이미지 세트 생성</option>
                        </select>
                      </label>
                    )}
                    {correctionBase && separationCandidates.length > 1 && (
                      <label className="field">
                        <span>수정 기준 이미지 세트</span>
                        <select
                          data-testid="workbench-separation-base"
                          value={baseSeparationCandidate?.id ?? ""}
                          onChange={(e) =>
                            setBaseSeparationCandidateId(e.target.value)
                          }
                        >
                          {separationCandidates.map((c, i) => (
                            <option value={c.id} key={c.id}>
                              {c.label || `세트 ${i + 1}`}
                              {separated?.candidate.id === c.id
                                ? " · 채택됨"
                                : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label className="field">
                      <span>분리 이미지 방향</span>
                      <select
                        data-testid="workbench-separation-mode"
                        disabled={!!correctionBase}
                        value={
                          correctionBase
                            ? requestedSeparationViews.length === 1
                              ? "single"
                              : "multiview"
                            : separationMode
                        }
                        onChange={(e) =>
                          setSeparationMode(
                            e.target.value as "single" | "multiview",
                          )
                        }
                      >
                        <option value="single">분할만 · 파츠별 정면 1장</option>
                        <option value="multiview">멀티뷰 · 방향 선택</option>
                      </select>
                    </label>
                    {(correctionBase
                      ? requestedSeparationViews.length > 1
                      : separationMode === "multiview") && (
                      <div
                        className="wb-view-options"
                        data-testid="workbench-separation-view-options"
                      >
                        {WORKBENCH_VIEWS.map((v) => (
                          <label className="wb-checkbox" key={v}>
                            <input
                              type="checkbox"
                              data-testid={`workbench-view-${v}`}
                              checked={requestedSeparationViews.includes(v)}
                              disabled={!!correctionBase || v === "front"}
                              onChange={(e) =>
                                setSeparationViews((previous) =>
                                  WORKBENCH_VIEWS.filter(
                                    (direction) =>
                                      direction === "front" ||
                                      (direction === v
                                        ? e.target.checked
                                        : previous.includes(direction)),
                                  ),
                                )
                              }
                            />
                            {viewLabels[v]}
                            {v === "front" ? " · 필수" : ""}
                          </label>
                        ))}
                      </div>
                    )}
                    {correctionBase && (
                      <small className="wb-muted">
                        기존 세트의 방향을 유지합니다. 방향 구성을 바꾸려면 새
                        분리 이미지 세트를 선택하세요.
                      </small>
                    )}
                    {countInput(
                      "생성할 이미지 세트 수",
                      separationCount,
                      setSeparationCount,
                      "workbench-separation-count",
                    )}
                    <p
                      className="wb-note"
                      data-testid="workbench-separation-total"
                    >
                      한 세트 = 3개 파츠 × {requestedSeparationViews.length}방향
                      = {3 * requestedSeparationViews.length}장.{" "}
                      {separationCount}세트 중 사용할 한 세트를 선택합니다.
                    </p>
                    <label className="field">
                      <span>이미지 생성 도구</span>
                      <select
                        data-testid="workbench-separation-backend"
                        value={imageBackend}
                        onChange={(e) =>
                          setImageBackend(
                            e.target.value as "chatgpt-web" | "codex",
                          )
                        }
                      >
                        <option value="chatgpt-web">GPT · ChatGPT 웹</option>
                        <option value="codex">GPT · Codex 내장</option>
                      </select>
                    </label>
                    {imageConnectionHelp()}
                    <p data-testid="workbench-separation-batch-help">
                      파츠마다{" "}
                      {imageBackend === "chatgpt-web"
                        ? "ChatGPT 웹 채팅"
                        : "GPT(Codex 내장)"}
                      에 선택한 방향을 요청하고 방향별 독립 원본 이미지를
                      받습니다. 사진을 확인하고 한 세트를 채택한 뒤 모델을
                      만듭니다.
                    </p>
                    <div className="wb-pair">
                      <label className="field">
                        <span>수정할 파츠</span>
                        <select
                          data-testid="workbench-separate-role"
                          value={correctionBase ? separationRole : "all"}
                          disabled={!correctionBase}
                          onChange={(e) =>
                            setSeparationRole(
                              e.target.value as WorkbenchRole | "all",
                            )
                          }
                        >
                          <option value="all">모든 파츠</option>
                          {roles.map((r) => (
                            <option value={r} key={r}>
                              {roleLabels[r]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>수정할 방향</span>
                        <select
                          data-testid="workbench-separate-view"
                          value={correctionBase ? separationView : "all"}
                          disabled={!correctionBase}
                          onChange={(e) =>
                            setSeparationView(
                              e.target.value as WorkbenchView | "all",
                            )
                          }
                        >
                          <option value="all">모든 방향</option>
                          {requestedSeparationViews.map((v) => (
                            <option value={v} key={v}>
                              {viewLabels[v]}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
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
                    {correctionBase && missingSeparationCount > 0 && (
                      <>
                        <div
                          className="wb-note"
                          data-testid="workbench-reuse-scope"
                        >
                          기존 {presentSeparationPairs.size}장은 유지합니다.
                          없는 {missingSeparationCount}장만 같은 파츠끼리 요청해{" "}
                          추가합니다.
                        </div>
                        {launch(
                          `기존 사진 유지 · 없는 ${missingSeparationCount}장만 채우기`,
                          {
                            step: "separate",
                            prompt: separationPrompt,
                            provider: "gpt",
                            separationStrategy: "part-multiview-v1",
                            views: requestedSeparationViews,
                            separationMode:
                              requestedSeparationViews.length === 1
                                ? "single"
                                : "multiview",
                            generationCount: 1,
                            baseJobId: correctionBase.id,
                            baseCandidateId: baseSeparationCandidate?.id,
                            reuseExisting: true,
                          },
                          false,
                          "workbench-fill-missing",
                        )}
                      </>
                    )}
                    {launch(
                      correctionBase
                        ? `선택한 ${rerollSeparationCount}장 수정 · 리롤`
                        : `분리 이미지 ${separationCount}세트 만들기 · 총 ${rerollSeparationCount}장`,
                      {
                        step: "separate",
                        prompt: separationPrompt,
                        provider: "gpt",
                        separationStrategy: "part-multiview-v1",
                        baseJobId: correctionBase?.id,
                        baseCandidateId: correctionBase
                          ? baseSeparationCandidate?.id
                          : undefined,
                        generationCount: separationCount,
                        views: requestedSeparationViews,
                        separationMode:
                          requestedSeparationViews.length === 1
                            ? "single"
                            : "multiview",
                        role:
                          correctionBase && separationRole !== "all"
                            ? separationRole
                            : undefined,
                        view:
                          correctionBase && separationView !== "all"
                            ? separationView
                            : undefined,
                        reuseExisting: false,
                      },
                    )}
                    {correctionBase && (
                      <small className="wb-muted">
                        한 파츠의 한 방향만 선택하면 한 장만 리롤합니다. 여러
                        방향은 같은 파츠끼리 요청해 독립 이미지로 만듭니다. 다른
                        파츠·방향의 사진은 그대로 사용합니다. 결과는 새 버전에
                        저장됩니다.
                      </small>
                    )}
                  </>
                ) : (
                  <>
                    {modelInput === "whole" && !modelEditBase && <>
                      <label className="wb-check">
                        <input type="checkbox" data-testid="workbench-external-model" checked={externalModel}
                          onChange={e => setExternalModel(e.target.checked)} />
                        현재 Codex 대화에서 Chrome의 Tripo 실행
                      </label>
                      {externalModel && <>
                        <small>채택한 전체 4방향 원본을 P2.0에 전달합니다. 이 버튼은 작업 명세만 저장합니다.
                          Codex가 Chrome의 방향·개수·면 수·비용을 확인하고 승인한 범위에서 한 번 제출합니다.</small>
                        <label className="field"><span>Tripo에서 확인한 토폴로지</span>
                          <select data-testid="workbench-studio-topology" value={studioTopology}
                            onChange={e => setStudioTopology(e.target.value as "quad" | "triangle")}>
                            <option value="quad">쿼드</option><option value="triangle">삼각형</option>
                          </select></label>
                        <label className="field"><span>현재 화면의 생성 비용 (크레딧)</span>
                          <input data-testid="workbench-observed-model-cost" type="number" min={0} step={1}
                            value={observedModelCost} onChange={e => setObservedModelCost(Number(e.target.value))} />
                        </label>
                      </>}
                    </>}
                    <label className="field">
                      <span>이번에 생성할 모델</span>
                      <select
                        data-testid="workbench-model-role"
                        value={modelRole}
                        disabled={modelInput === "whole"}
                        onChange={(e) => {
                          setRole(e.target.value as WorkbenchRole);
                          setViewJobId("");
                        }}
                      >
                        {modelRoles.map((r) => (
                          <option key={r} value={r}>
                            {roleLabels[r]}
                            {selection(`model:${r}`) ? " · 선택 완료" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    {!modelEditBase &&
                      countInput(
                        "Tripo 모델 생성 개수",
                        modelCount,
                        setModelCount,
                        "workbench-model-count",
                      )}
                    <label className="field">
                      <span>
                        {modelEditBase
                          ? "기준 버전의 폴리곤 설정"
                          : "폴리곤 수"}
                      </span>
                      <input
                        data-testid="workbench-polygon-count"
                        disabled={!!modelEditBase}
                        type="number"
                        min={1}
                        step={1000}
                        value={
                          modelEditBase
                            ? (modelEditBase.request.polygonCount ?? "")
                            : polygonCount
                        }
                        placeholder="Tripo 기본값"
                        onChange={(e) =>
                          setPolygonCount(Number(e.target.value))
                        }
                      />
                      <small>
                        {modelEditBase
                          ? "기존 모델을 재생성합니다. 폴리곤 설정을 바꾸기 위한 새 생성은 실행하지 않습니다."
                          : "Tripo에서 허용하는 범위를 확인합니다. 범위를 벗어나면 설정값을 임의로 바꾸지 않고 알려드립니다."}
                      </small>
                    </label>
                    {modelEditBase && (
                      <>
                        <label className="field">
                          <span>기존 모델 수정 범위</span>
                          <select
                            data-testid="workbench-model-edit-scope"
                            value={modelEditScope}
                            onChange={(e) =>
                              setModelEditScope(
                                e.target.value as "all" | "part",
                              )
                            }
                          >
                            <option value="all">전체 선택 · 전체 리롤</option>
                            <option value="part">
                              부분 선택 · 부분 재생성
                            </option>
                          </select>
                        </label>
                        {modelEditScope === "part" && (
                          <label className="field">
                            <span>수정할 영역</span>
                            <input
                              data-testid="workbench-model-edit-target"
                              value={modelEditTarget}
                              onChange={(e) =>
                                setModelEditTarget(e.target.value)
                              }
                              placeholder="예: 뒷머리 아래쪽, 오른쪽 소매 끝"
                            />
                            <small>
                              선택할 영역을 구체적으로 적어 주세요. 다른 부분은
                              유지합니다.
                            </small>
                          </label>
                        )}
                      </>
                    )}
                    <label className="field">
                      <span>
                        {modelEditBase ? "재생성 지시" : "모델 생성 지시"}
                      </span>
                      <textarea
                        data-testid="workbench-model-prompt"
                        placeholder="예: 뒷머리 볼륨을 줄여 주세요"
                        rows={4}
                        value={modelPrompt}
                        onChange={(e) => setModelPrompt(e.target.value)}
                      />
                    </label>
                    <div className="wb-note">
                      {modelEditBase
                        ? "기존 모델 · Tripo 부분 재생성 기능"
                        : `Smart Mesh P2 · 모델 ${modelCount}개`}
                      <br />
                      {modelEditBase
                        ? "사용 가능 횟수는 Tripo 화면에서 확인합니다. 횟수를 소진하면 멈춥니다. 이전 버전은 보존됩니다."
                        : `${modelInput === "whole" ? externalModel ? "채택한 전체 4방향 원본" : "선택한 전체 이미지" : "채택한 파츠 이미지"}로 Tripo의 생성 개수 기능을 사용합니다. 화면에서 지원하지 않는 개수는 실행 전에 알려드립니다.`}
                    </div>
                    <small className="wb-muted">
                      {modelEditBase
                        ? "기존 모델의 재생성 기능을 사용합니다. 사용할 수 없으면 멈추고 안내하며 새 모델 생성으로 바꾸지 않습니다."
                        : "처음 모델을 생성합니다. 생성 화면이 프롬프트를 지원하지 않으면 먼저 이미지에서 수정할 수 있도록 안내합니다."}
                    </small>
                    {approvalBox()}
                    {launch(
                      `${roleLabels[modelRole]} 모델 ${modelEditBase ? (modelEditScope === "all" ? "전체 리롤" : "부분 재생성") : `${modelCount}개 만들기`}`,
                      {
                        step: "model",
                        role: modelRole,
                        modelInput,
                        generationCount: modelEditBase ? 1 : modelCount,
                        polygonCount: modelEditBase
                          ? modelEditBase.request.polygonCount
                          : polygonCount,
                        prompt: modelPrompt,
                        baseJobId: modelEditBase?.id,
                        baseCandidateId: modelBaseCandidate?.id,
                        modelEditScope: modelEditBase
                          ? modelEditScope
                          : undefined,
                        modelEditTarget:
                          modelEditBase && modelEditScope === "part"
                            ? modelEditTarget.trim()
                            : undefined,
                      },
                      (!modelEditBase &&
                        (modelInput === "whole"
                          ? !concept
                          : !separationReady)) ||
                        (!modelEditBase &&
                          (!Number.isFinite(polygonCount) ||
                            polygonCount < 1)) ||
                        (!!modelEditBase &&
                          modelEditScope === "part" &&
                          !modelEditTarget.trim()),
                    )}
                  </>
                )}
              </>
            )}
            {page === "surface" && (
              <>
                <p>
                  선택한{" "}
                  {modelInput === "whole"
                    ? "전체 캐릭터 모델"
                    : "머리·머리카락·몸통"}
                  에 Smart UV와 텍스처를 적용합니다.
                </p>
                {modelInput === "whole" && !surfaceEditBase && <>
                  <label className="wb-check">
                    <input type="checkbox" data-testid="workbench-external-surface" checked={externalSurface}
                      onChange={e => setExternalSurface(e.target.checked)} />
                    앱의 Codex로 Chrome의 UV·텍스처 실행
                  </label>
                  {externalSurface && <>
                    <small>채택한 Tripo 모델에 Smart UV, 텍스처를 순서대로 적용할 작업 명세를 저장합니다.
                      앱이 Codex를 실행하고 각 원본과 비용을 보존합니다. 결과가 돌아오면 직접 채택하세요.</small>
                    <label className="field"><span>화면에서 확인한 Smart UV 비용</span>
                      <input data-testid="workbench-observed-uv-cost" type="number" min={0} step={1}
                        value={observedUvCost} onChange={e => setObservedUvCost(Number(e.target.value))} /></label>
                    <label className="field"><span>화면에서 확인한 텍스처 비용</span>
                      <input data-testid="workbench-observed-texture-cost" type="number" min={0} step={1}
                        value={observedTextureCost} onChange={e => setObservedTextureCost(Number(e.target.value))} /></label>
                    <label className="field"><span>텍스처 해상도</span>
                      <select data-testid="workbench-texture-resolution" value={textureResolution}
                        onChange={e => setTextureResolution(e.target.value as "2K" | "4K" | "8K")}>
                        <option>2K</option><option>4K</option><option>8K</option>
                      </select></label>
                    <label className="wb-check"><input data-testid="workbench-remove-lighting" type="checkbox"
                      checked={removeLighting} onChange={e => setRemoveLighting(e.target.checked)} />조명 제거</label>
                    <small>현재 확인한 합계: {observedUvCost + observedTextureCost}크레딧</small>
                  </>}
                </>}
                {selectedSource && (
                  <img
                    className="wb-selected-source"
                    src={url(selectedSource)}
                    alt="색상과 스타일 기준 이미지"
                  />
                )}
                <label className="field">
                  <span>수정할 파츠</span>
                  <select
                    data-testid="workbench-surface-role"
                    value={surfaceHistoryAvailable ? surfaceRole : "all"}
                    disabled={
                      !surfaceHistoryAvailable || modelInput === "whole"
                    }
                    onChange={(e) =>
                      setSurfaceRole(e.target.value as WorkbenchRole | "all")
                    }
                  >
                    <option value="all">
                      {modelInput === "whole"
                        ? "전체 캐릭터"
                        : "머리·머리카락·몸통 전체"}
                    </option>
                    {modelInput === "parts" &&
                      roles.map((r) => (
                        <option key={r} value={r}>
                          {roleLabels[r]}만 수정
                        </option>
                      ))}
                  </select>
                  {surfaceEditBase && (
                    <small>선택하지 않은 파츠의 UV·텍스처는 유지합니다.</small>
                  )}
                  {surfaceHistoryAvailable &&
                    surfaceRole !== "all" &&
                    !surfaceEditBase && (
                      <small className="wb-note warning">
                        이 파츠만 수정하려면 나머지 파츠의 모델이 같은 기준
                        버전이어야 합니다. 다른 파츠도 바뀌었다면 전체 작업을
                        선택하세요.
                      </small>
                    )}
                </label>
                <label className="field">
                  <span>텍스처 지시</span>
                  <textarea
                    data-testid="workbench-surface-prompt"
                    rows={5}
                    value={surfacePrompt}
                    onChange={(e) => setSurfacePrompt(e.target.value)}
                  />
                </label>
                {approvalBox()}
                {launch(
                  surfaceEditBase
                    ? "선택한 UV · 텍스처 수정 · 리롤"
                    : "Smart UV + 텍스처 작업",
                  {
                    step: "surface",
                    modelInput,
                    prompt: surfacePrompt,
                    baseJobId: surfaceEditBase?.id,
                    role:
                      surfaceEditBase && surfaceRole !== "all"
                        ? surfaceRole
                        : undefined,
                  },
                  surfaceHistoryAvailable &&
                    surfaceRole !== "all" &&
                    !surfaceEditBase,
                )}
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
                <label className="field">
                  <span>몸체 체형</span>
                  <select data-testid="workbench-rig-profile" value={rigProfile} onChange={e => setRigProfile(e.target.value as typeof rigProfile)}>
                    <option value="automatic">원본 체형에 맞춤</option>
                    <option value="quadruped">네 발 동물 · Unity Generic</option>
                  </select>
                </label>
                <div className="wb-object-list">
                  <label className="wb-object"><input data-testid="workbench-rig-ears" type="checkbox" role="switch" checked={rigEars} onChange={e => setRigEars(e.target.checked)} /><span>귀 제어<small>왼쪽·오른쪽 귀를 각각 움직이는 뼈와 웨이트</small></span></label>
                  <label className="wb-object"><input data-testid="workbench-rig-tail" type="checkbox" role="switch" checked={rigTail} onChange={e => setRigTail(e.target.checked)} /><span>꼬리 제어<small>몸체에 붙어 있는 꼬리도 별도로 움직이기</small></span></label>
                </div>
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
                  editBase ? "리깅 수정 · 리롤" : "Blender + Astra로 리깅",
                  {
                    step: "rig",
                    rigProfile,
                    rigControls: { ears: rigEars, tail: rigTail },
                    prompt:
                      rigPrompt.trim() ||
                      "Unity 게임용 기본 몸체 리깅과 선택한 오브젝트의 추가 뼈 및 웨이트를 만들고 변형을 검사해 주세요.",
                    baseJobId: editBase?.id ?? rig?.job.id,
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
                      editBase
                        ? "멀티뷰 동작 이미지 수정 · 리롤"
                        : "멀티뷰 동작 이미지 한 세트 생성",
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
                      editBase
                        ? "Astra로 3D 동작 수정 · 리롤"
                        : "이미지를 보고 Astra로 3D 동작 제작",
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
                <label className="field">
                  <span>내보내기·수정 지시</span>
                  <textarea
                    data-testid="workbench-unity-prompt"
                    rows={4}
                    value={unityPrompt}
                    onChange={(e) => setUnityPrompt(e.target.value)}
                    placeholder="예: 인사 동작의 클립 이름을 Wave로 정리해 주세요."
                  />
                </label>
                {launch(
                  editBase
                    ? "내보내기 수정 · 다시 검사"
                    : "Unity로 내보내고 검사",
                  {
                    step: "unity",
                    prompt:
                      unityPrompt.trim() ||
                      "채택한 리깅 모델과 모든 애니메이션을 설정된 Unity 프로젝트로 내보내고 Avatar, 클립 및 재생을 검사해 주세요.",
                    baseJobId: editBase?.id,
                  },
                )}
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
            {page === "parts" && modelInput === "parts" && (
              <div className="wb-substeps">
                <button
                  data-testid="workbench-tab-separate"
                  className={partMode === "separate" ? "active" : ""}
                  onClick={() => {
                    setPartMode("separate");
                    setViewJobId("");
                  }}
                >
                  분리 이미지 확인{separated && <Check size={12} />}
                </button>
                <button
                  data-testid="workbench-tab-model"
                  disabled={!canViewModels}
                  className={partMode === "model" ? "active" : ""}
                  onClick={() => {
                    setPartMode("model");
                    setViewJobId("");
                  }}
                >
                  파츠별 모델 제작 · 수정
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
                {step === "surface" && surfaceEditBase?.id === viewing.id
                  ? "선택한 파츠의 모델이 바뀐 이전 UV·텍스처 버전입니다. 해당 파츠를 현재 모델에 맞춰 수정하고, 나머지 파츠의 결과는 유지합니다."
                  : "앞 단계의 선택이 바뀌기 전 결과입니다. 기록은 보존되어 있지만 현재 결과로 채택하거나 수정 기준으로 사용할 수 없습니다."}
              </p>
            )}
            {step === "separate" &&
              viewing &&
              viewing.status !== "running" &&
              viewing.status !== "review" && (
                <div className="wb-saved-photos">
                  <button
                    data-testid="workbench-inspect-saved"
                    disabled={locked || !viewingCurrent}
                    onClick={() =>
                      action(
                        { kind: "inspect-saved", jobId: viewing.id },
                        "저장된 사진을 확인합니다. 새 이미지는 생성하지 않습니다.",
                      )
                    }
                  >
                    <ImagePlus size={15} /> 저장된 사진 보기
                  </button>
                  <small>
                    이미 만들어진 사진만 불러옵니다. 생성 요청은 보내지
                    않습니다.
                  </small>
                </div>
              )}
            {visualWarnings.length > 0 && (
              <div
                className="wb-note warning wb-visual-warnings"
                data-testid="workbench-visual-warnings"
              >
                <strong>사진을 보고 확인해 주세요</strong>
                <p>
                  외형에 관한 참고 사항입니다. 사진을 검토한 뒤 수정하거나
                  채택할 수 있습니다.
                </p>
                <ul>
                  {visualWarnings.map((warning, i) => (
                    <li key={`${warning}-${i}`}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
            {viewing?.candidates.length ? (
              <>
                {step === "concept" ||
                ((step === "model" || step === "separate") &&
                  viewing.candidates.length > 1) ? (
                  <div
                    className={`wb-candidates ${step === "separate" || viewing.request.conceptMode === "turnaround" ? "wb-candidate-sets" : ""}`}
                  >
                    {viewing.candidates.map((c, i) => {
                      const selected =
                        selectedHere?.job.id === viewing.id &&
                        selectedHere.candidate.id === c.id;
                      const img = c.artifacts.find((a) => a.kind === "image");
                      const previewKey = `${viewing.id}/${c.id}`;
                      const rotating = rotatingCandidates.includes(previewKey);
                      return (
                        <article
                          className={`wb-candidate ${selected ? "selected" : ""}`}
                          key={c.id}
                          data-testid={`workbench-candidate-${i}`}
                        >
                          {viewing.request.conceptMode === "turnaround" ? <div className="wb-whole-views">
                            {c.artifacts.filter(a => a.kind === "image").map(a => <figure key={a.path}>
                              <img src={url(a)} alt={`전체 ${a.view ? viewLabels[a.view] : ""}`} /><figcaption>{a.view ? viewLabels[a.view] : ""}</figcaption>
                            </figure>)}
                          </div> : step === "separate"
                            ? separationGallery(
                                c.artifacts.filter((a) => a.kind === "image"),
                                false,
                                c.id,
                              )
                            : step === "model" && (rotating || !img)
                              ? modelView(c)
                              : img && <img src={url(img)} alt={c.label} />}
                          {step === "model" && img && modelArtifact(c) && (
                            <button
                              data-testid={`workbench-preview3d-${i}`}
                              className="wb-preview-toggle"
                              onClick={() =>
                                setRotatingCandidates((ids) =>
                                  rotating
                                    ? ids.filter((id) => id !== previewKey)
                                    : [...ids, previewKey],
                                )
                              }
                            >
                              {rotating ? "사진으로 비교" : "3D로 돌려보기"}
                            </button>
                          )}
                          <div className="wb-candidate-footer">
                            <strong>{c.label || `후보 ${i + 1}`}</strong>
                            <button
                              data-testid={`workbench-select-${i}`}
                              className={selected ? "primary" : ""}
                              disabled={
                                locked ||
                                viewing.status !== "review" ||
                                !viewingCurrent ||
                                (step === "separate" &&
                                  !separationImagesReady(
                                    c.artifacts,
                                    workbenchSeparationViews(viewing.request),
                                  )) ||
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
                    {step === "model" && candidate
                      ? singleModelGallery(candidate)
                      : resultGallery(candidate)}
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
            ) : draftImages.length > 0 ? (
              separationGallery(draftImages, true)
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
                    ? `설정한 후보 ${conceptCount}장을 비교해 하나를 선택하거나 기존 이미지를 가져올 수 있습니다.`
                    : step === "separate"
                      ? `머리·머리카락·몸통의 ${requestedSeparationViews.map((v) => viewLabels[v]).join("·")} 이미지를 확인합니다. 저장된 이미지를 유지하고 빠진 방향만 추가할 수 있습니다.`
                      : step === "rig"
                        ? "채택한 조립 모델의 실제 오브젝트를 기준으로 추가 리깅을 설정합니다."
                        : "아직 검토할 결과가 없습니다. 왼쪽에서 설정하고 실행하면 결과가 여기에 표시됩니다."}
                </p>
              </div>
            )}
            {page === "concept" && nextButton("parts")}
            {page === "parts" &&
              modelInput === "parts" &&
              partMode === "separate" && (
                <div className="wb-next">
                  <p>
                    {separationReady
                      ? "분리 결과를 채택했습니다. 파츠별 모델 설정을 시작하세요."
                      : "설정한 파츠 이미지를 확인하고 사용할 세트를 채택하세요."}
                  </p>
                  <button
                    className="primary"
                    disabled={locked || !canViewModels}
                    onClick={() => {
                      setPartMode("model");
                      setViewJobId("");
                    }}
                  >
                    파츠 모델 제작으로
                    <ArrowRight size={15} />
                  </button>
                </div>
              )}
            {page === "parts" &&
              (modelInput === "whole" || partMode === "model") && (
                <>
                  <div className="wb-inline-actions" style={{ marginTop: 18 }}>
                    {modelRoles.map((r) => (
                      <button
                        className={modelRole === r ? "primary" : ""}
                        key={r}
                        onClick={() => {
                          if (r !== "whole") setRole(r);
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
                      {step !== "concept" &&
                        j.candidates.length === 1 &&
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
                            setModelInput("parts");
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
