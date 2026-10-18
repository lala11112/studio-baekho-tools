import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Box,
  ChevronRight,
  Check,
  Download,
  FilePlus2,
  FolderOpen,
  FolderInput,
  Layers3,
  Search,
  Settings2,
  MoreHorizontal,
  History,
  ListChecks,
  LoaderCircle,
  X,
} from "lucide-react";
import type { Project } from "../shared/types";
import type {
  AssetVersion,
  GraphicsAction,
  GraphicsKind,
  GraphicsObject,
  GraphicsRole,
  GraphicsTask,
  GraphicsWorkspace,
  GraphicsFile,
} from "../shared/graphics";
import { graphicsLegacyUnlinkProblem, importedModelSourceProblem, requiresPartSourcePreparation, requiresPartSpaceRestoration, surfaceRepairSources } from "../shared/graphics";
import { queuedUnityOpenTarget } from '../shared/graphics-unity-open';
import {
  filterGraphicsTasks,
  findGraphicsTask,
  graphicsCatalog,
  graphicsApprovalState,
  graphicsMultiviewProblem,
  recommendedGraphicsTasks,
  graphicsAstraTasks,
  graphicsTripoReserved,
} from "../shared/graphics-catalog";
import { catalog } from "../shared/catalog";
import { Viewport } from "./Viewport";
import { GraphicsPlanarReview } from './GraphicsPlanarReview';
import { GraphicsAutoRig, type AutoRigView } from './GraphicsAutoRig';
import { inspectedRigPreview, autoRigPresentation, rigInspectionForCandidate } from './graphics-auto-rig-preview';
import { HeadComparison } from './HeadComparison';
import { GraphicsContactReview } from './GraphicsContactReview';
import { CreationOptions } from "./CreationOptions";
import { CreationSubjectChooser } from './CreationSubjectChooser';
import { GraphicsStoragePanel } from './GraphicsStoragePanel';
import { modelProductionGeometry, modelProductionLabel } from '../shared/graphics-provenance';
import { creationForSubject, creationSubjects, creationCompositionStrategy } from '../shared/graphics-creation';
import { normalizePhysicalSize, physicalSizeSummary, type PhysicalSize } from '../shared/graphics-size';
import { GraphicsSizePanel } from './GraphicsSizePanel';
import type { ModelMeasurement, MeshSelection } from './viewport-inspection';
import type { RigRegion } from './viewport-rig-region';
import {
  creationStages,
  creationTaskId,
  creationPartForTask,
  creationSettings,
  stageForTask,
  creationSelectionProblem,
  defaultCreation,
  effectiveCreation,
  summarizeCreation,
  selectMissingSurfaceRepair,
  selectModelRevision,
  changeCreationAssemblyMode,
  type CreationSpec,
  type CreationStage,
} from "../shared/graphics-creation";
import "./graphics-studio.css";
import "./graphics-guide.css";
import { deriveJourney, nextAfterAccept, journeySurfaceCapabilities, type JourneyAction, type JourneyTarget } from '../shared/graphics-journey';
import { lastGraphicsObject, readGraphicsView, saveGraphicsView } from './graphics-view-state';

type Props = {
  project: Project;
  workspace: GraphicsWorkspace | undefined;
  busy: boolean;
  onAction: (action: GraphicsAction) => Promise<unknown>;
  onOpenSettings?: (provider?: 'tripo' | 'fal' | 'openai') => void;
  entryIntent?: { id: number; kind: 'new' | 'import' | 'resume' };
  onEntryHandled?: () => void;
  onExportProject?: () => void;
};
const usesModelMultiview = (
  taskId: string,
  settings: GraphicsTask["settings"],
) =>
  taskId === "M02" || (taskId === "M15" && settings.inputMode === "multiview");
const recoveryLabel = (task: GraphicsTask) =>
  task.taskId === "N02" &&
  task.message === "Runway 원본 업로드 도구 실패: user rejected MCP tool call"
    ? "업로드 권한 다시 확인 · 승인한 비용으로 계속"
    : "기존 작업 이어서 확인";
const kinds: Record<GraphicsKind, string> = {
  character: "캐릭터",
  weapon: "무기",
  prop: "소품",
  environment: "환경",
  sprite: "2D 스프라이트",
  ui: "UI",
  vfx: "VFX",
};
const roles: Record<GraphicsRole, string> = {
  design: "디자인",
  model: "모델",
  material: "재질",
  rig: "리그",
  "motion-reference": "동작 참고",
  animation: "애니메이션",
  unity: "Unity",
};
const referenceRoles: Record<
  GraphicsObject["references"][number]["role"],
  string
> = { appearance: "외형", style: "스타일", motion: "동작", dimensions: "치수" };
const statusLabels = {
  ready: "사용 가능",
  unverified: "실제 검증 전",
  planned: "미구현",
};
const provenanceLabels: Record<AssetVersion["provenance"]["type"], string> = {
  import: "가져온 원본",
  legacy: "기존 프로젝트 자료",
  local: "로컬 처리 결과",
  codex: "Codex 제작 결과",
  tripo: "Tripo API 결과",
  runway: "Runway 영상 결과",
};
const availabilityCounts = {
  ready: graphicsCatalog.filter((task) => task.status === "ready").length,
  unverified: graphicsCatalog.filter((task) => task.status === "unverified")
    .length,
  planned: graphicsCatalog.filter((task) => task.status === "planned").length,
};
const isImagePath = (file: string) => /\.(png|jpe?g|webp|gif)$/i.test(file);
const directions = [
  ["front", "정면"],
  ["left", "왼쪽"],
  ["back", "후면"],
  ["right", "오른쪽"],
] as const;
const taskStatuses: Record<GraphicsTask["status"], string> = {
  awaiting_approval: "실행 승인 대기",
  running: "진행 중",
  review: "결과 검토",
  failed: "실패",
  cancelled: "취소됨",
  submission_unknown: "제출 상태 확인 필요",
};
const fileName = (file: string) => file.split(/[\\/]/).at(-1) ?? file;
const stamp = (value: string) => new Date(value).toLocaleString("ko-KR");
const acceptedVersion = (object: GraphicsObject, version: AssetVersion) =>
  Object.values(object.accepted).includes(version.id);

/** Presentation only: execution still validates the exact accepted model and native UVs. */
function pendingSurfaceUvVersions(source: AssetVersion | undefined, versions: AssetVersion[], tasks: GraphicsTask[]): AssetVersion[] {
  if (!source) return [];
  const related = versions.filter(version => version.objectId === source.objectId && version.slot === source.slot && version.role === 'model');
  const byId = new Map(related.map(version => [version.id, version]));
  const followsSource = (version: AssetVersion, seen = new Set<string>()): boolean => {
    if (seen.has(version.id)) return false;
    seen.add(version.id);
    return version.sourceVersionIds.some(id => id === source.id || !!byId.get(id) && followsSource(byId.get(id)!, seen));
  };
  return related.filter(version => version.id !== source.id && followsSource(version) && tasks.some(task =>
    task.objectId === source.objectId && ['T01', 'T02'].includes(task.taskId) && task.status === 'review' &&
    task.outputVersionIds.includes(version.id)) && !related.some(derivative => derivative.partSpace?.providerVersionId === version.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function modelFaceTarget(
  version: AssetVersion,
  versions: AssetVersion[],
  tasks: GraphicsTask[],
): { label: string; inherited: boolean } {
  const seen = new Set<string>();
  let frontier = [version],
    inherited = false;
  while (frontier.length) {
    const values = new Set<number>();
    const next: AssetVersion[] = [];
    for (const item of frontier) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      for (const task of tasks) {
        const limit = task.settings.faceLimit;
        if (
          task.objectId === version.objectId &&
          task.outputVersionIds.includes(item.id) &&
          typeof limit === "number" &&
          Number.isSafeInteger(limit) &&
          limit > 0
        )
          values.add(limit);
      }
      for (const id of item.sourceVersionIds) {
        const source = versions.find(
          (candidate) =>
            candidate.id === id && candidate.objectId === version.objectId,
        );
        if (source && !seen.has(id)) next.push(source);
      }
    }
    if (values.size)
      return {
        label:
          values.size === 1
            ? [...values][0].toLocaleString("ko-KR")
            : "원본별 상이",
        inherited,
      };
    frontier = next;
    inherited = true;
  }
  return { label: "미설정", inherited: false };
}

function ModelStatistics({
  projectId,
  version,
  versions,
  tasks,
  onMeasure,
}: {
  projectId: string;
  version: AssetVersion;
  versions: AssetVersion[];
  tasks: GraphicsTask[];
  onMeasure?: (measurement: { versionId: string; faces?: number }) => void;
}) {
  const measureCallback = useRef(onMeasure);
  measureCallback.current = onMeasure;
  const report = version.files.find(
    (file) => file.kind === "report" && /\.report\.json$/i.test(file.path),
  );
  const nativeHash = version.files.find((file) =>
    /\.fbx$/i.test(file.path),
  )?.sha256;
  const reportPath = report?.path,
    reportHash = report?.sha256;
  const requestKey = [
    projectId,
    version.id,
    reportPath,
    reportHash,
    nativeHash,
  ].join("\n");
  const [measurement, setMeasurement] = useState<{
    key: string;
    faces?: number;
    triangles?: number;
    complete: boolean;
  }>();
  useEffect(() => {
    measureCallback.current?.({ versionId: version.id });
    if (!reportPath || !nativeHash) return;
    const controller = new AbortController();
    let active = true;
    setMeasurement({ key: requestKey, complete: false });
    void fetch(window.desktop.assetUrl(projectId, reportPath), {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Model statistics unavailable");
        const value: unknown = await response.json();
        const data = value as Record<string, unknown> | null;
        if (
          !data ||
          data.nativeSourceSha256 !== nativeHash ||
          typeof data.faces !== "number" ||
          !Number.isSafeInteger(data.faces) ||
          data.faces <= 0 ||
          typeof data.triangles !== "number" ||
          !Number.isSafeInteger(data.triangles) ||
          data.triangles < data.faces
        )
          throw new Error("Model statistics do not match the original");
        if (active) {
          setMeasurement({
            key: requestKey,
            complete: true,
            faces: data.faces,
            triangles: data.triangles,
          });
          measureCallback.current?.({ versionId: version.id, faces: data.faces as number });
        }
      })
      .catch(() => {
        if (active) setMeasurement({ key: requestKey, complete: true });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [projectId, reportPath, reportHash, nativeHash, requestKey]);
  const current = measurement?.key === requestKey ? measurement : undefined;
  const loading = !!reportPath && !!nativeHash && !current?.complete;
  const target = modelFaceTarget(version, versions, tasks);
  const measured = (value?: number) =>
    value?.toLocaleString("ko-KR") ?? (loading ? "확인 중" : "미측정");
  return (
    <section
      className="gs-model-statistics"
      aria-label="모델 면수"
      data-testid="graphics-model-statistics"
    >
      <dl>
        <div>
          <dt>목표 면수{target.inherited ? " (원본)" : ""}</dt>
          <dd data-testid="graphics-target-faces">{target.label}</dd>
        </div>
        <div>
          <dt>실제 면수</dt>
          <dd data-testid="graphics-measured-faces">
            {measured(current?.faces)}
          </dd>
        </div>
        <div>
          <dt>삼각형 환산수</dt>
          <dd data-testid="graphics-measured-triangles">
            {measured(current?.triangles)}
          </dd>
        </div>
      </dl>
      <p>원본 FBX 기준 · Unity 임포트 후 실측값과 다를 수 있습니다.</p>
    </section>
  );
}

function VersionPreview({
  project,
  version,
  physicalSize,
  onBounds,
  onMeshSelect,
  nativePolygonCount,
  rigRegion, onRigRegionStatus,
  previewFile,
}: {
  project: Project;
  version?: AssetVersion;
  physicalSize?: PhysicalSize;
  onBounds?: (bounds: ModelMeasurement) => void;
  onMeshSelect?: (selection: MeshSelection | null) => void;
  nativePolygonCount?: number;
  rigRegion?: RigRegion;
  onRigRegionStatus?: (status: { ready: boolean; message: string }) => void;
  previewFile?: GraphicsFile;
}) {
  const [mediaError, setMediaError] = useState(false);
  useEffect(() => setMediaError(false), [version?.id]);
  if (!version)
    return (
      <div className="gs-preview-empty">
        <Box size={48} strokeWidth={1} />
        <h3>자료에서 시작하세요</h3>
        <p>
          원하는 특징을 선택해 이미지를 만들거나
          <br />
          이미 가진 이미지와 모델을 가져오세요.
        </p>
      </div>
    );
  const sourceProblem = importedModelSourceProblem(version);
  if (sourceProblem) return <div className="gs-preview-empty" data-testid="graphics-ambiguous-import-preview"><Box size={40} strokeWidth={1} /><h3>사용할 원본을 먼저 구분해 주세요</h3><p>{sourceProblem}</p></div>;
  const glb = previewFile ?? version.files.find((file) => /\.glb$/i.test(file.path));
  const motionSources =
    version.role === "design" && version.slot === "motion-source"
      ? version.files.filter((file) => isImagePath(file.path))
      : [];
  if (motionSources.length > 1)
    return (
      <div
        className="gs-motion-source-preview"
        data-testid="graphics-motion-source-comparison"
        aria-label="측면 원본 비교"
      >
        {motionSources.map((file) => {
          const name = fileName(file.path);
          const label = /^left\./i.test(name)
            ? "왼쪽 측면"
            : /^right\./i.test(name)
              ? "오른쪽 측면"
              : name;
          return (
            <figure key={file.path}>
              <img
                src={window.desktop.assetUrl(project.id, file.path)}
                alt={label}
              />
              <figcaption>{label}</figcaption>
            </figure>
          );
        })}
      </div>
    );
  const media =
    version.preview ??
    version.files.find((file) =>
      /\.(png|jpe?g|webp|gif|mp4|webm)$/i.test(file.path),
    )?.path;
  if (glb) {
    const id = `graphics-${version.id}`;
    const previewProject: Project = {
      ...project,
      assets: [
        // UV/texture inputs register `graphics-${version.id}` as a native FBX.
        // This preview must resolve only its selected GLB, not the backend input
        // with the same id. Keep the persisted production asset list untouched.
        {
          id,
          file: glb.path,
          kind: "model",
          label: version.label,
          origin: "import",
          createdAt: version.createdAt,
        },
      ],
      parts: [],
    };
    return (
      <Viewport
        project={previewProject}
        previewId={id}
        animation={version.role === "animation" || version.role === "rig"}
        physicalSize={physicalSize}
        onBounds={onBounds}
        onMeshSelect={onMeshSelect}
        nativePolygonCount={nativePolygonCount}
        nativeVersionId={version.id}
        rigRegion={rigRegion}
        onRigRegionStatus={onRigRegionStatus}
        previewNotice={previewFile ? '원본 보존 검사 미리보기 · 채택·내보내기 원본은 유지됩니다.' : undefined}
      />
    );
  }
  if (media && !mediaError && /\.(mp4|webm)$/i.test(media))
    return (
      <video
        className="gs-media"
        aria-label={version.label}
        controls
        src={window.desktop.assetUrl(project.id, media)}
        onError={() => setMediaError(true)}
      />
    );
  if (media && !mediaError && /\.(png|jpe?g|webp|gif)$/i.test(media))
    return (
      <img
        className="gs-media"
        alt={version.label}
        src={window.desktop.assetUrl(project.id, media)}
        onError={() => setMediaError(true)}
      />
    );
  return (
    <div className="gs-preview-empty">
      <Layers3 size={40} />
      <h3>{version.label}</h3>
      <p>
        {mediaError
          ? "미리보기를 불러오지 못했습니다. 저장된 원본은 유지됩니다."
          : version.provenance.type === 'import' && version.files.some(file => /\.(fbx|blend|obj|stl)$/i.test(file.path))
          ? "가져온 원본을 화면에서 확인하려면 아래에서 로컬 미리보기를 준비하세요."
          : "이 형식은 화면 미리보기를 지원하지 않습니다."}
      </p>
      <span>
        {version.files.map((file) => fileName(file.path)).join(" · ")}
      </span>
    </div>
  );
}

type CandidateMedia = { path: string; kind: "image" | "video" };
type CandidateGroup = {
  id: string;
  createdAt: string;
  label: string;
  kind: CandidateMedia["kind"];
  candidates: { version: AssetVersion; media: CandidateMedia }[];
};
function candidateMedia(version: AssetVersion): CandidateMedia | undefined {
  // A motion-source version is one accepted bundle with separate left/right inputs.
  // Show its files together in the detail preview, not as a one-image candidate.
  if (
    version.role === "design" &&
    version.slot === "motion-source" &&
    version.files.filter((file) => isImagePath(file.path)).length > 1
  )
    return undefined;
  const kind =
    version.role === "design"
      ? "image"
      : version.role === "motion-reference"
        ? "video"
        : undefined;
  const file =
    kind &&
    version.files.find((file) =>
      kind === "image"
        ? isImagePath(file.path)
        : /\.(mp4|webm)$/i.test(file.path),
    );
  return file && kind ? { path: file.path, kind } : undefined;
}
function candidateGroups(
  versions: AssetVersion[],
  tasks: GraphicsTask[],
): CandidateGroup[] {
  const groups: CandidateGroup[] = [],
    grouped = new Set<string>();
  for (const task of tasks) {
    const candidates = task.outputVersionIds.flatMap((id) => {
      const version = versions.find((version) => version.id === id),
        media = version && candidateMedia(version);
      return version && media && !grouped.has(id) ? [{ version, media }] : [];
    });
    for (const kind of ["image", "video"] as const) {
      const matching = candidates.filter(
        (candidate) => candidate.media.kind === kind,
      );
      if (!matching.length) continue;
      matching.forEach((candidate) => grouped.add(candidate.version.id));
      groups.push({
        id: `task:${task.id}:${kind}`,
        createdAt: task.createdAt,
        label: `${task.taskId} · ${stamp(task.createdAt)} · 작업 ${task.id.slice(0, 8)}`,
        kind,
        candidates: matching,
      });
    }
  }
  for (const version of versions) {
    const media = candidateMedia(version);
    if (!media || grouped.has(version.id)) continue;
    const jobId = version.provenance.jobId,
      id = jobId ? `job:${jobId}:${media.kind}` : `version:${version.id}`;
    const group = groups.find((group) => group.id === id);
    if (group) group.candidates.push({ version, media });
    else
      groups.push({
        id,
        createdAt: version.createdAt,
        label: `${jobId ? "이전 작업 " + jobId.slice(0, 8) : "가져온 원본 " + version.id.slice(0, 8)} · ${stamp(version.createdAt)}`,
        kind: media.kind,
        candidates: [{ version, media }],
      });
  }
  return groups.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function RuntimeApprovalCard({
  task,
  disabled,
  onAnswer,
}: {
  task: GraphicsTask;
  disabled: boolean;
  onAnswer: (answer: {
    accepted: boolean;
    values: Record<string, string>;
  }) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const approval = task.runtimeApproval;
  if (!approval || task.status !== "running") return null;
  const ready = approval.fields.every(
    (field) => !field.required || values[field.id]?.trim(),
  );
  return (
    <div
      className="gs-runtime-approval"
      data-testid={`graphics-runtime-approval-${task.id}`}
    >
      <strong>사용자 확인 필요 · {approval.title}</strong>
      <p>{approval.detail}</p>
      <small>
        도구 실행에 필요한 확인입니다. 생성 비용 승인은 별도로 유지됩니다.
      </small>
      {approval.fields.map((field) => (
        <label key={field.id}>
          {field.label}
          {field.required ? " (필수)" : ""}
          {field.options ? (
            <select
              aria-label={field.label}
              required={field.required}
              value={values[field.id] ?? ""}
              onChange={(event) =>
                setValues({ ...values, [field.id]: event.target.value })
              }
              disabled={disabled}
            >
              <option value="">선택하세요</option>
              {field.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              aria-label={field.label}
              required={field.required}
              value={values[field.id] ?? ""}
              disabled={disabled}
              onChange={(event) =>
                setValues({ ...values, [field.id]: event.target.value })
              }
            />
          )}
        </label>
      ))}
      <div className="gs-runtime-actions">
        <button
          className="gs-primary"
          disabled={disabled || !ready}
          onClick={() => onAnswer({ accepted: true, values })}
        >
          확인하고 계속
        </button>
        <button
          disabled={disabled}
          onClick={() => onAnswer({ accepted: false, values: {} })}
        >
          허용하지 않음
        </button>
      </div>
    </div>
  );
}

export function GraphicsStudio({
  project,
  workspace,
  busy,
  onAction,
  onOpenSettings,
  onExportProject,
  entryIntent,
  onEntryHandled,
}: Props) {
  const [objectId, setObjectId] = useState(() => lastGraphicsObject(localStorage, project.id) ?? "");
  const [helpOpen, setHelpOpen] = useState(false);
  const [legacyRig, setLegacyRig] = useState(false);
  const [rigRegion, setRigRegion] = useState<(RigRegion & { versionId: string }) | undefined>(undefined);
  const [rigRegionReady, setRigRegionReady] = useState(false);
  const [autoRigFooterHost, setAutoRigFooterHost] = useState<HTMLDivElement | null>(null);
  const autoRigSeenCandidate = useRef('');
  const [editOpen, setEditOpen] = useState(false);
  const [planarSourceId, setPlanarSourceId] = useState('');
  const [movementExpanded, setMovementExpanded] = useState(false);
  const [draftSaved, setDraftSaved] = useState(true);
  const hydratedView = useRef('');
  const consumedEntry = useRef<number | undefined>(undefined);
  const importAfterCreate = useRef(false);
  const [newName, setNewName] = useState("");
  const [newSubject, setNewSubject] = useState("");
  const [newObjectOpen, setNewObjectOpen] = useState(false);
  const [newObjectError, setNewObjectError] = useState("");
  const [focusNewObject, setFocusNewObject] = useState(false);
  const newObjectDialog = useRef<HTMLDialogElement>(null);
  const newObjectTrigger = useRef<HTMLElement | null>(null);
  const newObjectNameFocus = useRef(false);
  const createSubmitting = useRef(false);
  const unityTargetDialog = useRef<HTMLDialogElement>(null);
  const [unityTargetOpen, setUnityTargetOpen] = useState(false);
  const [unityTargetDraft, setUnityTargetDraft] = useState('');
  const [unityTargetError, setUnityTargetError] = useState('');
  const previousObjectIds = useRef<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [catalogTab, setCatalogTab] = useState<
    "all" | "recommended" | "selected"
  >("all");
  const [stage, setStage] = useState<CreationStage>("design");
  const currentImportView = useRef('');
  currentImportView.current = `${project.id}:${objectId}:${stage}`;
  const [creation, setCreation] = useState<CreationSpec>(() =>
    defaultCreation("prop"),
  );
  const [taskOverride, setTaskId] = useState<string>();
  const taskId = taskOverride ?? creationTaskId(creation, stage);
  const [shownVersionId, setShownVersionId] = useState("");
  const [importedChoiceIds, setImportedChoiceIds] = useState<string[]>([]);
  useEffect(() => setImportedChoiceIds([]), [project.id, objectId]);
  const [headComparisonOpen, setHeadComparisonOpen] = useState(false);
  const [headBaselineId, setHeadBaselineId] = useState('');
  const [focusedImage, setFocusedImage] = useState<{
    path: string;
    label: string;
  }>();
  const imageDialog = useRef<HTMLDialogElement>(null);
  const [auxiliary, setAuxiliary] = useState<"history" | "support" | "storage">();
  const [meshSelection, setMeshSelection] = useState<MeshSelection | null>(null);
  const [modelBounds, setModelBounds] = useState<ModelMeasurement>();
  const [sizeInputsValid, setSizeInputsValid] = useState(true);
  const [nativeMeasurement, setNativeMeasurement] = useState<{versionId: string; faces?: number}>();
  const auxiliaryDialog = useRef<HTMLDialogElement>(null);
  const [legacyPreview, setLegacyPreview] =
    useState<GraphicsWorkspace["legacyPreview"]>();
  const [legacySelection, setLegacySelection] = useState<string[]>([]);
  const [unlinkObjectId, setUnlinkObjectId] = useState<string>();
  const legacyDialog = useRef<HTMLDialogElement>(null);
  const unlinkObject = workspace?.objects.find(
    (item) => item.id === unlinkObjectId,
  );
  const unlinkProblem =
    workspace && unlinkObjectId
      ? graphicsLegacyUnlinkProblem(workspace, unlinkObjectId)
      : undefined;
  useEffect(() => {
    if ((legacyPreview || unlinkObject) && !legacyDialog.current?.open)
      legacyDialog.current?.showModal();
  }, [legacyPreview, unlinkObject]);
  useEffect(() => {
    setLegacyPreview(undefined);
    setLegacySelection([]);
    setUnlinkObjectId(undefined);
    setNewObjectOpen(false);
    setNewObjectError("");
    setNewName("");
    setNewSubject("");
    setFocusNewObject(false);
  }, [project.id]);
  useEffect(() => {
    if (!newObjectOpen || !newObjectDialog.current) return;
    const dialog = newObjectDialog.current;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>(newObjectNameFocus.current ? '#gs-object-name' : '.gs-subject-groups button')?.focus();
  }, [newObjectOpen]);
  useEffect(() => {
    if (auxiliary && !auxiliaryDialog.current?.open)
      auxiliaryDialog.current?.showModal();
  }, [auxiliary]);
  useEffect(() => {
    if (focusedImage && !imageDialog.current?.open)
      imageDialog.current?.showModal();
  }, [focusedImage]);
  const [importRole, setImportRole] = useState<GraphicsRole>("model");
  const [referenceId, setReferenceId] = useState("");
  const [referenceRole, setReferenceRole] =
    useState<GraphicsObject["references"][number]["role"]>("appearance");
  const [pending, setPending] = useState(false);
  const unityOpening = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [clock, setClock] = useState(Date.now());
  const [budget, setBudget] = useState(300);
  const [clipNameDraft, setClipNameDraft] = useState("");
  const disabled = busy || pending;
  const object = workspace?.objects.find((item) => item.id === objectId);
  const settings = object
    ? creationSettings({ ...object, creation }, stage)
    : (creation.stageSettings[stage]?.values ?? {});
  const instruction = creation.stageSettings[stage]?.instruction ?? "";
  const selectionProblem = creationSelectionProblem(creation, stage);
  const versions =
    workspace?.versions.filter((version) => version.objectId === objectId) ??
    [];
  const objectTasks =
    workspace?.tasks.filter((task) => task.objectId === objectId) ?? [];
  const partStatus = Object.fromEntries(creation.parts.filter(part => part.enabled).map(part => {
    const design = versions.find(version => version.id === object?.accepted[`design:part-${part.id}`]);
    const model = versions.find(version => version.id === object?.accepted[`model:part-${part.id}`]);
    const capabilities = model && workspace ? journeySurfaceCapabilities(workspace, model) : {};
    const modelStatus = !model ? '모델 선택 필요' : capabilities.textureVersionId ? '텍스처 사용 중' : capabilities.uvVersionId ? 'UV 사용 중' : '모델 사용 중';
    return [part.id, `${design ? '참조 채택' : '참조 미채택'} · ${modelStatus}`];
  }));
  const previewPart = creationPartForTask(creation, taskId);
  const previewSlot = previewPart ? `part-${previewPart.id}` : 'main';
  const mediaGroups = candidateGroups(versions, objectTasks);
  const latestMediaGroup = ["design", "animation"].includes(stage)
    ? mediaGroups.map(group => ({...group, candidates: group.candidates.filter(({version}) => stage === 'animation' ? version.slot === String(settings.clipName ?? 'Idle') : version.slot === previewSlot)}))
        .filter(group => group.kind === (stage === 'animation' ? 'video' : 'image') && group.candidates.length).at(-1)
    : undefined;
  const stageRoles: Record<CreationStage, GraphicsRole[]> = { design: ['design'], model: ['model'], surface: ['material', 'model'], assembly: ['model'], rig: ['rig', 'model'], animation: ['animation', 'motion-reference', 'rig'], unity: ['unity', 'animation', 'rig', 'model'] };
  const stageVersions = versions.filter(version => stageRoles[stage].includes(version.role) && (version.slot === previewSlot || stage === 'animation' && version.slot === String(settings.clipName ?? 'Idle')));
  const shownVersion =
    versions.find((version) => version.id === shownVersionId) ??
    latestMediaGroup?.candidates[0].version ??
    [...stageVersions].reverse().find((version) => object && acceptedVersion(object, version)) ??
    stageVersions.at(-1);
  const needsPartSpaceRestoration = Boolean(workspace && shownVersion && requiresPartSpaceRestoration(workspace, shownVersion));
  const needsPartSourcePreparation = Boolean(workspace && shownVersion && requiresPartSourcePreparation(workspace, shownVersion));
  const shownImportProblem = shownVersion && importedModelSourceProblem(shownVersion);
  const needsPartPreparation = needsPartSpaceRestoration || needsPartSourcePreparation;
  const shownContact = shownVersion?.contact;
  const contactReviewActive = Boolean(shownContact && stage === 'assembly');
  const shownContactTask = shownContact && shownVersion
    ? objectTasks.find(task => task.id === shownVersion.provenance.jobId && task.taskId === 'M06' && task.outputVersionIds.includes(shownVersion.id)) : undefined;
  const contactProcedureRecoveryAvailable = Boolean(shownContactTask?.status === 'review' &&
    shownContactTask.settings.contactPhase === 'reconstruct' && !shownContactTask.contactProcedureRecoveryRequested &&
    !shownContactTask.outputVersionIds.some(id => versions.some(version => version.id === id && version.contact?.phase === 'reconstruct' && version.contact.status === 'repaired')));
  const contactVersionForTask = (task: GraphicsTask) => {
    const results = task.outputVersionIds.map(id => versions.find(version => version.id === id)).filter((version): version is AssetVersion =>
      Boolean(version?.contact && version.provenance.jobId === task.id && version.contact.phase === task.settings.contactPhase));
    // A saved failure remains inspectable after local recovery, but is not the task's current result.
    return [...results].reverse().find(version => version.slot === 'main' && version.contact?.status === 'repaired') ?? results.at(-1);
  };
  const contactResultForTask = (task: GraphicsTask) => contactVersionForTask(task)?.contact;
  const contactPartProducer = shownVersion?.slot.startsWith('part-')
    ? objectTasks.find(task => task.taskId === 'M06' && ['repair', 'reconstruct'].includes(String(task.settings.contactPhase)) && task.outputVersionIds.includes(shownVersion.id)) : undefined;
  const contactPartMain = contactPartProducer?.outputVersionIds.map(id => versions.find(version => version.id === id)).find(version => version?.slot === 'main' && version.contact && ['repair', 'reconstruct'].includes(version.contact.phase));
  const shownAssembly = shownVersion?.role === 'model' && shownVersion.slot === 'main'
    ? objectTasks.find(task => (task.taskId === 'M08' || task.taskId === 'M06' && ['repair', 'reconstruct'].includes(String(task.settings.contactPhase))) && task.outputVersionIds.includes(shownVersion.id) && task.outputVersionIds.length > 1) : undefined;
  const assemblyParts = shownAssembly?.outputVersionIds.map(id => versions.find(version => version.id === id)).filter((version): version is AssetVersion => !!version && version.role === 'model' && version.slot.startsWith('part-'));
  const canInspectContact = shownAssembly?.taskId === 'M08' && ['part-head', 'part-body', 'part-hair'].every(slot => assemblyParts?.some(version => version.slot === slot));
  const shownAcceptanceComplete = Boolean(object && shownVersion && acceptedVersion(object, shownVersion) && (!shownAssembly || assemblyParts?.length && assemblyParts.every(version => object.accepted[`model:${version.slot}`] === version.id)));
  const headVersions = versions.filter(version => version.slot === 'part-head' && ['model', 'material'].includes(version.role) && version.files.some(file => /\.glb$/i.test(file.path)));
  const headCandidate = headVersions.find(version => version.id === shownVersion?.id);
  const acceptedHeadId = object?.accepted['model:part-head'] ?? object?.accepted['material:part-head'];
  const headBaseline = headVersions.find(version => version.id === headBaselineId && version.id !== headCandidate?.id)
    ?? headVersions.find(version => version.id === acceptedHeadId && version.id !== headCandidate?.id)
    ?? [...headVersions].reverse().find(version => version.id !== headCandidate?.id);
  useEffect(() => { setMeshSelection(null); setModelBounds(undefined); }, [shownVersion?.id, objectId]);
  const comparisonGroup = shownVersionId
    ? mediaGroups.find((group) =>
        group.candidates.some(
          (candidate) => candidate.version.id === shownVersionId,
        ),
      )
    : latestMediaGroup;
  const comparisonLabel =
    comparisonGroup?.kind === "video" ? "동작 영상" : "이미지";
  const activeTask = findGraphicsTask(taskId) ?? {
    id: taskId,
    name: selectionProblem ? "제작 옵션 선택" : "제작 연결 확인 필요",
    inputs: "설정 확인",
    output: "실행 연결 준비 중",
    executor: "none" as const,
    status: "planned" as const,
    reason: "이 설정에 맞는 실행 연결이 아직 없습니다.",
  };
  const motionTask = ["N02", "N04", "N05", "N06"].includes(taskId);
  const multipleOutputs = [
    "I01",
    "I02",
    "I03",
    "I05",
    "I06",
    "I07",
    "I08",
    "M01",
    "M02",
    "M03",
    "M04",
    "M15",
    "T03",
    "N02",
    "N04",
    "N05",
    "N06",
  ].includes(taskId);
  const imageVersions =
    workspace?.versions.filter((version) =>
      version.files.some((file) => /\.(png|jpe?g|webp)$/i.test(file.path)),
    ) ?? [];
  const texturePart =
    creation.attributes.composition === "parts"
      ? creation.parts.find(
          (part) => part.id === creation.activePartId && part.enabled,
        )
      : undefined;
  const surfaceSlot = texturePart ? `part-${texturePart.id}` : 'main';
  const surfaceModel = versions.find(version => version.id === object?.accepted[`model:${surfaceSlot}`] && version.role === 'model' && version.slot === surfaceSlot);
  const pendingSurfaceUvs = pendingSurfaceUvVersions(surfaceModel, versions, objectTasks);
  const shownMissingSurfaceResult = shownVersion && objectTasks.some(task => task.taskId === 'M09' && task.outputVersionIds.includes(shownVersion.id));
  const shownSurfaceRepairSources = workspace && shownVersion ? surfaceRepairSources(workspace, shownVersion) : undefined;
  const shownSurfaceRepairResult = shownSurfaceRepairSources && versions.find(version => version.surfaceRepair?.providerVersionId === shownVersion?.id);
  const textureDesignId =
    object?.accepted[
      texturePart ? `design:part-${texturePart.id}` : "design:main"
    ];
  const textureDesign = versions.find(
    (version) => version.id === textureDesignId && version.role === "design",
  );
  const textureReferenceImage = textureDesign?.files.find((file) =>
    /\.(png|jpe?g|webp)$/i.test(file.path),
  );
  const videoSources = imageVersions.filter(
    (version) =>
      version.objectId === objectId &&
      version.files.some((file) => /\.png$/i.test(file.path)) &&
      Object.values(object?.accepted ?? {}).includes(version.id),
  );
  const multiviewProblem = usesModelMultiview(taskId, settings)
    ? graphicsMultiviewProblem(settings, imageVersions)
    : undefined;
  const modelProblem =
    stage === "model" &&
    settings.modelMethod !== "local" &&
    settings.modelMethod !== "astra" &&
    settings.model === "P1-20260311" &&
    settings.quad !== false
      ? "Smart Mesh P1은 쿼드 출력을 지원하지 않습니다. 삼각형을 선택하거나 제작 모델을 바꾸세요."
      : undefined;
  const recommended = object
    ? recommendedGraphicsTasks(object.kind, versions)
    : [];
  const filteredTasks = filterGraphicsTasks(
    query,
    catalogTab === "recommended"
      ? recommended
      : catalogTab === "selected"
        ? (object?.selectedTasks ?? [])
        : undefined,
  );
  const waiting = objectTasks.filter(
    (task) => task.status === "awaiting_approval",
  );
  const active = objectTasks.some(
    (task) =>
      task.status === "running" ||
      task.status === "submission_unknown" ||
      task.status === "awaiting_approval",
  );
  const unityTargetPath = workspace?.target?.projectPath || project.unityPath || '';
  const unityTargetLocked = disabled || !!workspace?.tasks.some(task => ['running','awaiting_approval','submission_unknown'].includes(task.status)) || !!workspace?.deliveries.some(delivery => delivery.status === 'queued');
  useEffect(() => {
    if (unityTargetOpen) unityTargetDialog.current?.showModal();
    else unityTargetDialog.current?.close();
  }, [unityTargetOpen]);
  function openUnityTarget() {
    if (unityTargetLocked) return;
    setUnityTargetDraft(unityTargetPath); setUnityTargetError(''); setUnityTargetOpen(true);
  }
  async function saveUnityTarget(event: FormEvent) {
    event.preventDefault();
    if (unityTargetLocked || !unityTargetDraft.trim()) return;
    setPending(true); setUnityTargetError('');
    try {
      await onAction({kind:'set-unity-target',projectPath:unityTargetDraft.trim()});
      setUnityTargetOpen(false);
      setNotice('현재 프로젝트의 Unity 전달 대상을 변경했습니다. 생성이나 Unity 실행은 시작하지 않았습니다.');
    } catch (cause) { setUnityTargetError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  }
  const latestTaskByOperation = new Map<string, GraphicsTask>();
  const latestResultByOperation = new Map<string, GraphicsTask>();
  for (const task of [...objectTasks].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  )) {
    const operation = `${task.taskId}:${task.settings.clipName ?? ""}:${task.settings.partId ?? ""}${task.settings.contactPhase ? `:contact:${task.settings.contactPhase}:${task.settings.sourceVersionId ?? ''}` : ''}`;
    latestTaskByOperation.set(operation, task);
    // A later cancelled/failed request must not hide an already registered result.
    if (task.status === 'review' && task.outputVersionIds.some(id => versions.some(version => version.id === id))) latestResultByOperation.set(operation, task);
  }
  const isShownContactContinuation = (task: GraphicsTask) => Boolean(contactReviewActive && shownVersion &&
    task.taskId === 'M06' && ['repair', 'reconstruct'].includes(String(task.settings.contactPhase)) &&
    task.settings.contactAnalysisVersionId === shownVersion.id);
  const contactContinuations = new Map<string, GraphicsTask>();
  for (const task of [...objectTasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (isShownContactContinuation(task)) contactContinuations.set(String(task.settings.contactPhase), task);
  }
  const visibleTasks = [...new Map([...latestTaskByOperation.values(), ...latestResultByOperation.values(), ...contactContinuations.values(), ...objectTasks.filter(task => task.surfaceRecoveryVersionId), ...(contactReviewActive && shownContactTask ? [shownContactTask] : [])].map(task => [task.id, task])).values()]
    .filter(
      (task) =>
        (contactReviewActive ? task.id === shownContactTask?.id || isShownContactContinuation(task) : task.taskId === taskId) || task.surfaceRecoveryVersionId ||
        ["running", "submission_unknown", "awaiting_approval"].includes(
          task.status,
        ),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const completedUvTask = taskId === 'T01' ? latestResultByOperation.get(`T01::${texturePart?.id ?? ''}`) : undefined;
  const prepareLabel = selectionProblem
    ? "제작 옵션을 선택하세요"
    : activeTask.status === "planned"
      ? "실행 연결 준비 중"
      : completedUvTask ? '새 UV 작업 · 비용 확인'
      : taskId === "N01"
        ? "측면 이미지 만들기 · 입력 확인"
        : taskId === "N02"
          ? "동작 영상 생성 · 비용 확인"
          : activeTask.executor === "codex-image"
            ? "이미지 생성 · 입력 확인"
            : ["N04", "N05", "N06"].includes(taskId)
              ? "3D 애니메이션 제작 · 입력 확인"
              : `${activeTask.name} · ${activeTask.executor === "local" ? "입력 확인" : "비용 확인"}`;

  function showTaskResult(task: GraphicsTask) {
    const results = task.outputVersionIds.map(id => versions.find(version => version.id === id)).filter((version): version is AssetVersion => !!version);
    const contactResult = task.settings.contactPhase ? contactVersionForTask(task) : undefined;
    const result = contactResult ?? [...results].reverse().find(version => version.surfaceRepair || version.partSpace || version.partSource) ?? results[0];
    if (result) showVersion(result);
    revealResult();
  }

  function revealResult() {
    requestAnimationFrame(() => {
      // Scroll the workspace itself; scrollIntoView can also move hidden shell
      // ancestors and leave the preview and sticky guide beneath the stage bar.
      for (const selector of ['.gs-main', '.gs-workspace', '.graphics-studio', '.app-body']) {
        document.querySelector<HTMLElement>(selector)?.scrollTo({ top: 0, behavior: 'instant' });
      }
    });
  }

  function showVersion(version: AssetVersion) {
    setShownVersionId(version.id);
    revealResult();
    setHeadComparisonOpen(false);
    if (version.contact || objectTasks.some(task => task.taskId === 'M06' && task.settings.contactPhase && task.outputVersionIds.includes(version.id))) {
      setStage('assembly'); setTaskId('M06');
    } else {
      const producer = objectTasks.find(task => task.outputVersionIds.includes(version.id));
      setStage(producer ? stageForTask(producer.taskId) : version.role === 'design' ? 'design' : version.role === 'material' ? 'surface' : version.role === 'rig' ? 'rig' : version.role === 'animation' || version.role === 'motion-reference' ? 'animation' : version.role === 'unity' ? 'unity' : 'model');
      setTaskId(undefined);
    }
    if (version.slot.startsWith('part-')) setCreation(current => current.parts.some(part => part.enabled && `part-${part.id}` === version.slot) ? { ...current, activePartId: version.slot.slice(5) } : current);
  }

  async function adoptVersion(version: AssetVersion) {
    const problem = importedModelSourceProblem(version);
    if (problem) { setError(problem); return; }
    if (version.contact?.phase === 'analyze' || version.contact?.status === 'blocked') return;
    if (version.slot.startsWith('part-') && objectTasks.some(task => task.taskId === 'M06' && ['repair', 'reconstruct'].includes(String(task.settings.contactPhase)) && task.outputVersionIds.includes(version.id))) return;
    if (version.slot === 'part-head' && acceptedHeadId && acceptedHeadId !== version.id) setHeadBaselineId(acceptedHeadId);
    const target = workspace ? nextAfterAccept(workspace, objectId, creation, version) : undefined;
    const ok = await run({ kind: 'accept', objectId: version.objectId, versionId: version.id }, '이 결과를 사용할 원본으로 저장했습니다. 다음 설정을 확인하세요. 새 제작은 시작하지 않았습니다.');
    if (ok && target) {
      navigateGuide(target);
      const producer = objectTasks.find(task => task.outputVersionIds.includes(version.id));
      if (producer && ['T01', 'T02'].includes(producer.taskId)) settingForStage('surface', 'surfaceOperation', 'texture');
      if (version.role === 'motion-reference') settingForStage('animation', 'animationMode', 'reference');
    }
  }

  async function prepareContact(source: AssetVersion, phase: 'analyze' | 'repair' | 'reconstruct') {
    if (disabled || active) return;
    const prepared = await run({ kind: 'prepare-contact', versionId: source.id, phase }, `${phase === 'analyze' ? '접합 영역 분석' : phase === 'reconstruct' ? '목·헤어 구조 보정' : '허용 영역 보정'}의 입력·사용량 카드를 준비했습니다. 기존 결과와 채택 상태는 유지됩니다.`);
    if (prepared) { setStage('assembly'); setTaskId('M06'); setHeadComparisonOpen(false); }
  }

  function chooseRepairSource(source: AssetVersion, mesh?: MeshSelection) {
    if (disabled || active) return;
    try {
      setCreation(selectMissingSurfaceRepair(creation, source, mesh));
      setStage('assembly'); setTaskId(undefined); setError('');
      setNotice(`${source.label}을 빠진 면 보완 원본으로 지정했습니다. 보완할 위치와 추가 상한을 확인한 뒤 실행을 준비하세요.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function chooseRevisionSource(source: AssetVersion) {
    if (disabled || active) return;
    try {
      setCreation(selectModelRevision(creation, source));
      setStage('assembly'); setTaskId(undefined); setError('');
      setNotice(`${source.label}을 추가 보정 원본으로 지정했습니다. 다듬을 위치와 유지할 부분을 적은 뒤 실행을 준비하세요. 채택 상태는 유지됩니다.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function showUvPreparation(source: AssetVersion) {
    if (disabled || active) return;
    setCreation(current => ({
      ...current,
      ...(source.slot.startsWith('part-') && current.parts.some(part => part.enabled && `part-${part.id}` === source.slot) ? { activePartId: source.slot.slice(5) } : {}),
      stageSettings: { ...current.stageSettings, surface: {
        instruction: current.stageSettings.surface?.instruction ?? '',
        values: { ...current.stageSettings.surface?.values, surfaceOperation: 'uv', uvMode: 'local' },
      } },
    }));
    setStage('surface'); setTaskId(undefined); setError('');
    setNotice('로컬 UV 준비 설정으로 이동했습니다. 실행 원본에는 채택한 모델을 사용합니다. 보완 결과가 아직 미채택이면 먼저 이 모델 채택을 누르세요. UV 생성과 채택은 각각 직접 진행합니다.');
  }

  function showAuxiliary(view: "history" | "support" | "storage") {
    setAuxiliary(view);
    document
      .querySelector<HTMLDetailsElement>(".gs-aux-menu")
      ?.removeAttribute("open");
  }

  useEffect(() => {
    if (!workspace?.objects.some((item) => item.id === objectId))
      setObjectId(workspace?.objects.at(-1)?.id ?? "");
  }, [workspace?.objects, objectId]);
  useEffect(() => {
    if (workspace?.tripoBudget) setBudget(workspace.tripoBudget.limit);
  }, [workspace?.tripoBudget?.limit]);
  useEffect(() => {
    const saved = object ? readGraphicsView(localStorage, project.id, object) : undefined;
    setCreation(saved?.creation ?? (object ? effectiveCreation(object) : defaultCreation("prop")));
    setStage(saved?.stage ?? "design"); setTaskId(saved?.taskOverride); setShownVersionId(saved?.shownVersionId ?? "");
    setMovementExpanded(saved?.movementExpanded ?? false);
    setHeadComparisonOpen(false); setHeadBaselineId(''); setFocusedImage(undefined);
    setReferenceId(""); setError(""); setNotice(""); setImportRole("design"); setEditOpen(false);
    hydratedView.current = '';
    const id = window.setTimeout(() => { hydratedView.current = `${project.id}:${object?.id ?? ''}`; setDraftSaved(true); }, 0);
    return () => window.clearTimeout(id);
  }, [project.id, object?.id]);
  useEffect(() => {
    if (!object || hydratedView.current !== `${project.id}:${object.id}`) return;
    setDraftSaved(saveGraphicsView(localStorage, project.id, object.id, { schemaVersion: 1, stage, creation, shownVersionId, taskOverride, movementExpanded }));
  }, [project.id, object?.id, creation, stage, shownVersionId, taskOverride, movementExpanded]);
  useEffect(() => {
    if (!entryIntent || consumedEntry.current === entryIntent.id) return;
    if (entryIntent.kind === 'resume') {
      if (!workspace) return;
      const attention = [...workspace.tasks].reverse().find(task => ['awaiting_approval','running','submission_unknown'].includes(task.status))
        ?? [...workspace.tasks].reverse().find(task => task.status === 'failed' || task.status === 'review' && task.outputVersionIds.some(id => !Object.values(workspace.objects.find(row => row.id === task.objectId)?.accepted ?? {}).includes(id)));
      if (attention && attention.objectId !== object?.id && workspace.objects.some(row => row.id === attention.objectId)) { setObjectId(attention.objectId); return; }
      if (workspace.objects.length && !object) return;
    }
    consumedEntry.current = entryIntent.id;
    onEntryHandled?.();
    if (entryIntent.kind === 'new') openNewObject();
    if (entryIntent.kind === 'resume' && object) {
      const attention = [...objectTasks].reverse().find(task => ['awaiting_approval','running','submission_unknown'].includes(task.status))
        ?? [...objectTasks].reverse().find(task => ['review','failed'].includes(task.status) && task.outputVersionIds.some(id => !Object.values(object.accepted).includes(id)));
      if (attention) window.setTimeout(() => {
        setStage(stageForTask(attention.taskId)); setTaskId(attention.taskId);
        if (attention.outputVersionIds.some(id => versions.some(version => version.id === id))) showTaskResult(attention);
        if (typeof attention.settings.partId === 'string') setCreation(current => ({...current,activePartId: String(attention.settings.partId)}));
      }, 0);
    }
    if (entryIntent.kind === 'import') {
      if (!object) { importAfterCreate.current = true; openNewObject(); }
      else { setImportRole('model'); window.setTimeout(openImportPanel, 0); }
    }
  }, [entryIntent?.id, workspace, object?.id]);
  useEffect(() => {
    if (!focusNewObject || !object || previousObjectIds.current.has(object.id)) return;
    setFocusNewObject(false);
    if (importAfterCreate.current) { importAfterCreate.current = false; setImportRole('model'); window.setTimeout(openImportPanel, 50); return; }
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.gs-creation-stages button')?.focus());
  }, [object?.id, focusNewObject]);
  useEffect(() => {
    if (!waiting.length && !objectTasks.some(task => task.status === 'running')) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [waiting.length, objectTasks.some(task => task.status === 'running')]);
  useEffect(() => {
    setClipNameDraft(
      String(creation.stageSettings.animation?.values.clipName ?? ""),
    );
  }, [objectId, creation.stageSettings.animation?.values.clipName]);

  async function run(action: GraphicsAction, success?: string) {
    if (disabled) return false;
    setPending(true);
    setError("");
    setNotice("");
    try {
      await onAction(action);
      if (success) setNotice(success);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setPending(false);
    }
  }
  async function inspectLegacy() {
    if (disabled) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const result = (await onAction({
        kind: "inspect-legacy",
      })) as GraphicsWorkspace;
      if (!result?.legacyPreview)
        throw Error("기존 자료 목록을 확인하지 못했습니다.");
      setLegacySelection([]);
      setLegacyPreview(result.legacyPreview);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }
  function closeLegacyDialog() {
    if (pending) return;
    setLegacyPreview(undefined);
    setUnlinkObjectId(undefined);
  }
  function setting(key: string, value: string | number | boolean) {
    if (key === "clipName") {
      setClipName(String(value));
      return;
    }
    setCreation((current) => ({
      ...current,
      stageSettings: {
        ...current.stageSettings,
        [stage]: {
          instruction: current.stageSettings[stage]?.instruction ?? "",
          values: {
            ...(object
              ? creationSettings({ ...object, creation: current }, stage)
              : {}),
            ...current.stageSettings[stage]?.values,
            [key]: value,
            ...(stage === 'rig' && key === 'rigType' ? { enabled: value !== 'none' && value !== '' } : {}),
          },
        },
      },
    }));
    setTaskId(undefined);
  }
  function setClipName(name: string) {
    setCreation((current) => {
      const existing =
        current.stageSettings.animation ??
        defaultCreation(object?.kind ?? "prop").stageSettings.animation!;
      const previous = String(existing.values.clipName ?? "");
      if (name === previous) return current;
      const saved = {
        ...current.clipSettings,
        ...(previous.trim() ? { [previous]: structuredClone(existing) } : {}),
      };
      const next = saved[name]
        ? structuredClone(saved[name])
        : {
            instruction: "",
            values: {
              ...defaultCreation(object?.kind ?? "prop").stageSettings
                .animation!.values,
              animationMode: existing.values.animationMode ?? "text",
            },
          };
      next.values.clipName = name;
      return {
        ...current,
        clipSettings: saved,
        stageSettings: { ...current.stageSettings, animation: next },
      };
    });
    setTaskId(undefined);
  }
  function setInstruction(value: string) {
    setCreation((current) => ({
      ...current,
      stageSettings: {
        ...current.stageSettings,
        [stage]: {
          instruction: value,
          values: current.stageSettings[stage]?.values ?? {},
        },
      },
    }));
  }
  function changeCreation(next: CreationSpec) {
    if (next.subject !== creation.subject && versions.length > 0) {
      setNewSubject(next.subject);
      setNewName(creationSubjects.find(item => item.id === next.subject)?.label ?? '새 오브젝트');
      openNewObject(undefined, true);
      setNotice('기존 원본과 기록을 유지합니다. 새 오브젝트의 이름과 대상을 확인한 뒤 만들기를 누르세요.');
      return;
    }
    setCreation(next);
    setTaskId(undefined);
  }
  function changeStage(next: CreationStage) {
    revealResult();
    setStage(next);
    setTaskId(undefined);
    setShownVersionId('');
    setEditOpen(false);
    setImportRole(
      next === "design"
        ? "design"
        : next === "rig"
          ? "rig"
          : next === "animation"
            ? "motion-reference"
            : "model",
    );
  }
  async function openProjectFolder() {
    if (disabled) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const message = await window.desktop.call<string>({
        type: "folder.open",
        id: project.id,
      });
      if (message) throw Error(message);
      setNotice(
        "프로젝트 폴더를 열었습니다. 표시된 저장 경로에서 원본과 결과 파일을 찾을 수 있습니다.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }
  async function copyFileLocation(file: string) {
    if (disabled) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const { dataDir } = await window.desktop.call<{ dataDir: string }>({
        type: "state",
      });
      const separator = dataDir.includes("\\") ? "\\" : "/";
      const location = [
        dataDir.replace(/[\\/]+$/, ""),
        "projects",
        project.id,
        ...file.split(/[\\/]/),
      ].join(separator);
      await navigator.clipboard.writeText(location);
      setNotice("이 파일의 전체 저장 경로를 복사했습니다.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }
  async function prepare() {
    if (
      !object ||
      disabled ||
      !sizeInputsValid ||
      (active && !["A01", "A02", "A03"].includes(activeTask.id)) ||
      activeTask.status === "planned" ||
      multiviewProblem ||
      modelProblem ||
      selectionProblem ||
      !!journey?.inputReadiness.problems.length
    )
      return;
    if (activeTask.id === "A01") return importSource();
    if (activeTask.id === "A02") {
      document.getElementById("gs-object-name")?.focus();
      return;
    }
    if (activeTask.id === "A03") {
      document.getElementById("gs-reference-version")?.focus();
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      await onAction({
        kind: "update-object",
        objectId: object.id,
        patch: { creation },
      });
      await onAction({
        kind: "prepare",
        objectId: object.id,
        taskId: activeTask.id,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }
  async function prepareSizeCopy() {
    if (!object || disabled || active || !sizeInputsValid) return;
    setPending(true); setError('');
    try {
      await onAction({ kind: 'update-object', objectId: object.id, patch: { creation } });
      await onAction({ kind: 'prepare', objectId: object.id, taskId: 'A05' });
      setTaskId('A05');
      setNotice('채택한 원본의 크기 맞춤 사본을 준비했습니다. 무료 로컬 실행 카드를 확인하세요.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  }
  async function importSource() {
    if (!object || disabled) return;
    const startedView = currentImportView.current;
    const existingIds = new Set(workspace?.versions.map(version => version.id));
    setPending(true);
    setError("");
    setNotice("");
    try {
      await onAction({
        kind: "update-object",
        objectId: object.id,
        patch: { creation },
      });
      const result = await onAction({
        kind: "import",
        objectId: object.id,
        role: importRole,
        ...(["animation", "motion-reference"].includes(importRole)
          ? {
              clipName: String(
                creation.stageSettings.animation?.values.clipName ?? "",
              ),
            }
          : {}),
      });
      const importedWorkspace = result as GraphicsWorkspace | undefined;
      const imported = importedWorkspace?.projectId === project.id
        ? importedWorkspace.versions.filter(version => !existingIds.has(version.id) && version.objectId === object.id && version.role === importRole && version.provenance.type === 'import')
        : [];
      // Only this explicit import may navigate. Cancelled pickers and results for
      // an object the user has left never steal the current preview or focus.
      if (imported.length && currentImportView.current === startedView) {
        setImportedChoiceIds(imported.filter(version => ['model', 'material', 'rig'].includes(version.role)).map(version => version.id));
        showVersion(imported[0]);
        setNotice(`${imported.length}개 원본을 가져왔습니다. 결과를 확인하고 ‘이 결과 사용’을 눌러 주세요. 아직 사용할 결과로 확정하지 않았습니다.`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }
  function openNewObject(trigger?: HTMLElement, focusName = false) {
    if (disabled || createSubmitting.current) return;
    newObjectTrigger.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    newObjectNameFocus.current = focusName;
    setNewObjectError("");
    setNewObjectOpen(true);
  }
  function closeNewObject() {
    if (createSubmitting.current) return;
    newObjectDialog.current?.close();
    setNewObjectOpen(false);
    requestAnimationFrame(() => { if (newObjectTrigger.current?.isConnected) newObjectTrigger.current.focus(); });
  }
  async function createObject(event: FormEvent) {
    event.preventDefault();
    const subject = creationSubjects.find(item => item.id === newSubject);
    if (!newName.trim() || !subject || disabled || createSubmitting.current) return;
    createSubmitting.current = true;
    setPending(true);
    setNewObjectError("");
    previousObjectIds.current = new Set(workspace?.objects.map(item => item.id));
    try {
      const result = await onAction({
        kind: "create-object",
        name: newName.trim(),
        objectKind: subject.kind,
        creation: creationForSubject(subject.id),
      });
      const created = (result as GraphicsWorkspace | undefined)?.objects?.find(item => !previousObjectIds.current.has(item.id));
      setNewName("");
      setNewSubject("");
      newObjectDialog.current?.close();
      setNewObjectOpen(false);
      setObjectId(created?.id ?? "");
      setStage("design");
      setFocusNewObject(true);
    } catch (cause) {
      setNewObjectError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      createSubmitting.current = false;
      setPending(false);
    }
  }

  useEffect(() => {
    const main = document.querySelector<HTMLElement>('.gs-main');
    const studio = document.querySelector<HTMLElement>('.graphics-studio');
    const footer = document.querySelector<HTMLElement>('.gs-guide-footer');
    if (!main || !studio || !footer) return;
    const measure = () => {
      studio.style.setProperty('--guide-height', `${Math.max(240, main.clientHeight - 32)}px`);
      studio.style.setProperty('--guide-footer-height', `${footer.getBoundingClientRect().height}px`);
    };
    const observer = new ResizeObserver(measure); observer.observe(main); observer.observe(footer); measure();
    return () => observer.disconnect();
  }, [object?.id]);

  function openImportPanel() {
    const panel = document.querySelector<HTMLDetailsElement>('.gs-import-details');
    if (panel) { panel.open = true; panel.scrollIntoView({ block: 'center' }); panel.querySelector<HTMLElement>('select,button')?.focus(); }
  }
  function openSingleSourceImport() {
    setImportRole(shownVersion?.role === 'material' || shownVersion?.role === 'rig' ? shownVersion.role : 'model');
    setNotice('사용할 3D 원본 하나와 필요한 동반 이미지를 가져오세요. 기존 파일과 사용 기록은 유지됩니다.');
    openImportPanel();
  }
  function settingForStage(targetStage: CreationStage, key: string, value: string | number | boolean) {
    setCreation(current => ({ ...current, stageSettings: { ...current.stageSettings, [targetStage]: { instruction: current.stageSettings[targetStage]?.instruction ?? '', values: { ...current.stageSettings[targetStage]?.values, [key]: value } } } }));
  }
  function navigateGuide(target: JourneyTarget) {
    changeStage(target.stage);
    if (target.partId) setCreation(current => ({ ...current, activePartId: target.partId }));
    if (target.clipName) setClipName(target.clipName);
    if (target.versionId) setShownVersionId(target.versionId);
    window.setTimeout(() => document.querySelector<HTMLElement>('.gs-guide-heading')?.focus(), 0);
  }
  const shownProducer = shownVersion && objectTasks.find(task => task.outputVersionIds.includes(shownVersion.id));
  const relevantPreview = shownVersion && (shownVersionId || (shownProducer ? stageForTask(shownProducer.taskId) === stage : stageRoles[stage][0] === shownVersion.role)) ? shownVersion.id : undefined;
  const journey = workspace && object ? deriveJourney(workspace, object.id, creation, { stage, partId: texturePart?.id, taskOverride, clipName: stage === 'animation' ? String(settings.clipName ?? 'Idle') : undefined, candidateVersionId: relevantPreview }) : undefined;
  const guideTask = journey?.task;
  const unityOperationTaskId = guideTask && ['running', 'awaiting_approval', 'submission_unknown'].includes(guideTask.status) && ['X04', 'X05'].includes(guideTask.taskId) ? guideTask.taskId : taskId;
  const fileExport = stage === 'unity' && unityOperationTaskId === 'X04';
  const autoRigFileExport = fileExport && Boolean(journey?.inputReadiness.inputs.some(input => input.version?.role === 'rig' && input.version.autoRig));
  const queuedUnityOpen = stage==='unity'&&!fileExport&&workspace&&object&&guideTask?.deliveryId ? queuedUnityOpenTarget(workspace,project.id,object.id,guideTask.id,guideTask.deliveryId) : undefined;
  const waitingForUnity = !!queuedUnityOpen;
  const shownUnityDelivery = queuedUnityOpen?.delivery ?? journey?.delivery;
  const deliveryCurrent = stage === 'unity' && !fileExport && journey?.stages.find(item => item.id === 'unity')?.status === 'complete';
  const currentDeliveryMessage = deliveryCurrent && journey?.delivery?.status === 'imported'
    ? [...objectTasks].reverse().find(task => task.taskId === 'X05' && task.status === 'review' && task.deliveryId === journey.delivery!.id && task.objectId === object?.id && task.objectId === journey.delivery!.objectId && JSON.stringify([...task.inputVersionIds].sort()) === JSON.stringify([...journey.delivery!.versionIds].sort()))?.message
    : undefined;
  const reviewVersion = journey?.review?.version;
  const reviewIsShown = Boolean(reviewVersion && shownVersion?.id === reviewVersion.id);
  const adoptableReview = Boolean(journey?.review?.adoptable && !journey.review.accepted && reviewIsShown && !contactPartProducer && !shownImportProblem);
  const readyProblem = activeTask.status === 'planned' ? activeTask.reason || '아직 개발 중인 작업입니다.' : selectionProblem || multiviewProblem || modelProblem || (!sizeInputsValid ? '실제 크기 입력을 확인하세요.' : '');
  const guideAction: JourneyAction | undefined = journey && !active && adoptableReview
    ? { intent: 'accept', label: `${reviewVersion?.role === 'design' ? '이 이미지' : reviewVersion?.role === 'animation' ? '이 동작' : shownAssembly ? '이 조립과 파트' : '이 결과'} 사용 · 다음 설정`, reason: shownAssembly ? '전체 조립과 같은 작업의 파트를 함께 사용합니다. 새 제작은 시작하지 않습니다.' : '선택한 결과를 다음 작업의 원본으로 저장합니다. 새 제작은 시작하지 않습니다.', target: { stage, versionId: reviewVersion!.id } }
    : journey?.primaryAction;
  const guideTitles: Record<string, string> = { design: '어떤 모습으로 만들까요?', model: '3D 모델을 만들어요', surface: '표면과 색을 완성해요', assembly: '모양과 연결을 확인해요', rig: '움직일 뼈대를 준비해요', animation: '동작을 만들어요', unity: fileExport ? 'FBX · GLB 파일로 내보내요' : 'Unity로 가져와요' };
  const guideState = pending ? '요청을 처리하고 있어요' : guideTask?.runtimeApproval && guideTask.status === 'running' ? '작업 중 확인이 필요해요' : guideTask?.status === 'awaiting_approval' ? '입력과 비용을 확인하세요' : guideTask?.status === 'running' ? guideTask.taskId === 'LOCAL_PLANAR_INSPECT' ? '모델을 검사하고 있어요' : guideTask.taskId === 'X05' ? waitingForUnity ? 'Unity 가져오기를 기다리고 있어요' : 'Unity 전달 파일을 준비하고 있어요' : guideTask.taskId === 'X04' ? '내보낼 파일을 준비하고 있어요' : '제작이 진행 중이에요' : guideTask?.status === 'submission_unknown' ? '기존 제출을 먼저 확인하세요' : adoptableReview ? '마음에 드는 결과를 사용하세요' : guideTitles[stage];
  const prepareDisabled = disabled || !!journey?.inputReadiness.problems.length || !sizeInputsValid || !!(selectionProblem || multiviewProblem || modelProblem) || active || activeTask.status === 'planned' || (stage === 'rig' && settings.rigType === 'none') || Boolean(object && ['sprite', 'ui', 'vfx'].includes(object.kind));
  function handleGuide(action: JourneyAction) {
    const version = versions.find(item => item.id === action.target.versionId);
    const task = objectTasks.find(item => item.id === action.target.taskId);
    if (action.intent === 'accept' && version) return void adoptVersion(version);
    if (action.intent === 'prepare') return void prepare();
    if (action.intent === 'navigate') {
      navigateGuide(action.target);
      if (action.target.stage === 'surface' && journey?.review?.accepted && objectTasks.some(task => ['T01', 'T02'].includes(task.taskId) && task.outputVersionIds.includes(journey.review!.version.id))) settingForStage('surface', 'surfaceOperation', 'texture');
      if (action.target.stage === stage) window.setTimeout(() => document.querySelector<HTMLElement>('.gs-instruction button, .gs-instruction input')?.focus(), 0);
      return;
    }
    if (action.intent === 'recover' && version) {
      if (workspace && requiresPartSpaceRestoration(workspace, version)) return void run({ kind: 'restore-part-space', versionId: version.id });
      if (workspace && requiresPartSourcePreparation(workspace, version)) return void run({ kind: 'prepare-part-source', versionId: version.id });
    }
    if (action.intent === 'approve' && task) {
      if (task.runtimeApproval) { document.querySelector<HTMLElement>(`[data-testid="graphics-current-task-${task.id}"] input, [data-testid="graphics-current-task-${task.id}"] button`)?.focus(); return; }
      if (graphicsApprovalState(task, clock) !== 'blocked') return void run({ kind: 'approve', taskId: task.id });
    }
    if (action.intent === 'review') {
      if (version) return showVersion(version);
      if (task?.outputVersionIds.length && task.status === 'review') return showTaskResult(task);
      const panel = task && document.querySelector<HTMLElement>(`[data-testid="graphics-current-task-${task.id}"]`);
      if (panel) { panel.scrollIntoView({ block: 'center' }); return; }
      return showAuxiliary('history');
    }
  }
  const actionLabel = guideTask?.status === 'awaiting_approval' && guideAction?.intent === 'approve'
    ? graphicsApprovalState(guideTask, clock) === 'refresh' ? '견적 다시 확인' : guideTask.localOnly ? '무료 로컬 작업 실행' : guideTask.cost?.provider === 'Codex' ? 'Codex 사용량으로 실행' : guideTask.cost?.credits != null ? `${guideTask.cost.credits.toLocaleString()}크레딧으로 생성` : '비용 확인 필요'
    : guideAction?.intent === 'prepare' ? prepareLabel : guideAction?.label ?? '현재 설정을 확인하세요';
  const guideHeading = <div className="gs-guide-heading" tabIndex={-1}>
    <div className="gs-guide-kicker"><span>지금 할 일</span><button type="button" aria-expanded={helpOpen} onClick={() => setHelpOpen(value => !value)}>도움말</button></div>
    <h2>{shownImportProblem && !active ? '사용할 원본을 하나씩 구분해 주세요' : deliveryCurrent && !active ? 'Unity 가져오기를 확인했어요' : guideState}</h2>
    <p>{(!active && shownImportProblem) || (active || adoptableReview ? guideAction?.reason : readyProblem || guideAction?.reason) || '주요 조건을 선택하고 입력과 비용을 확인하세요.'}</p>
    {guideTask?.status === 'running' && <p role="status"><LoaderCircle size={14} className="gs-spin" /> {Math.max(0, Math.floor((clock - new Date(guideTask.createdAt).getTime()) / 60000))}분 전 요청 · 마지막 갱신 {stamp(guideTask.updatedAt)}</p>}
    <small role="status">{draftSaved ? '설정 초안 자동 저장 · 생성은 실행 버튼에서 시작' : '이 기기에 초안을 저장하지 못했습니다. 설정 저장을 이용하세요.'}</small>
    {helpOpen && <div className="gs-inline-help"><strong>이 화면은 이렇게 사용하세요</strong><ol><li>왼쪽 결과는 클릭해서 비교합니다.</li><li>마음에 들면 ‘이 결과 사용’을 누릅니다.</li><li>오른쪽 설정과 비용을 확인하고 실행합니다.</li></ol><p>UV는 모델 표면에 무늬를 배치하는 좌표입니다. 리깅은 움직임을 위한 뼈대입니다. 정적 소품은 움직임 단계를 건너뛸 수 있습니다.</p><button onClick={() => onOpenSettings?.(activeTask.executor === 'tripo' ? 'tripo' : undefined)}>필요한 연결 설정</button></div>}
  </div>;
  const exactInputs = journey?.inputReadiness.inputs ?? [];
  const guideInputs = <div className="gs-guide-inputs" aria-label="실제 사용할 원본">
    <strong>{waiting.length ? '준비된 요청의 원본은 위 비용 카드에 고정돼 있습니다' : active ? '진행 중인 요청의 고정 원본' : '실제 사용할 원본'}</strong>
    {!waiting.length && (exactInputs.length ? exactInputs.map(input => <button key={`${input.key}:${input.versionId}`} onClick={() => { if (input.version) { setShownVersionId(input.version.id); revealResult(); } }}><Check size={13} /><span>{input.version?.label ?? '원본 확인 필요'}<small>{roles[input.version?.role ?? 'model']} · 현재 사용 중</small></span></button>) : <p>{stage === 'design' ? '새 디자인을 준비합니다. 참고 자료는 아래에서 연결할 수 있습니다.' : '이 단계에 사용할 결과를 먼저 선택해 주세요.'}</p>)}
    {journey && journey.parts.length > 0 && <details><summary>파트별 준비 상태 · {journey.parts.length}개</summary>{journey.parts.map(part => <button key={part.id} aria-pressed={creation.activePartId === part.id} onClick={() => { setCreation(current => ({ ...current, activePartId: part.id })); setShownVersionId(''); }}><span>{part.label}<small>{part.reason}</small></span></button>)}</details>}
  </div>;
  async function openUnity(queued=false) {
    if(pending||unityOpening.current||queued&&!queuedUnityOpen)return;
    unityOpening.current=true;
    setPending(true); setError('');
    try { setNotice(String(await window.desktop.call({type:'unity.open',id:project.id,...(queued&&queuedUnityOpen?{deliveryId:queuedUnityOpen.delivery.id,taskId:queuedUnityOpen.task.id,objectId:queuedUnityOpen.task.objectId}:{})}))); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { unityOpening.current=false;setPending(false); }
  }
  const guideFooter = <footer className="gs-guide-footer">
    {queuedUnityOpen ? <button type="button" className="gs-primary" data-testid="graphics-guide-primary" data-unity-open-delivery={queuedUnityOpen.delivery.id} disabled={pending} onClick={() => void openUnity(true)}>{pending?'Unity 여는 중…':'Unity 열고 가져오기'}</button> : shownImportProblem && !active ? <button type="button" className="gs-primary" data-testid="graphics-guide-primary" disabled={disabled} onClick={openSingleSourceImport}>사용할 모델 다시 가져오기</button> : deliveryCurrent && !active ? <button type="button" className="gs-primary" data-testid="graphics-guide-primary" disabled={disabled} onClick={() => void openUnity()}>Unity에서 확인</button> : guideAction && <button type="button" className="gs-primary" data-testid="graphics-guide-primary" disabled={disabled || guideAction.intent === 'prepare' && prepareDisabled || guideTask?.status === 'awaiting_approval' && graphicsApprovalState(guideTask, clock) === 'blocked'} onClick={() => handleGuide(guideAction)}>{pending ? <><LoaderCircle size={15} className="gs-spin" /> 요청 처리 중…</> : actionLabel}</button>}
    <div className="gs-guide-secondary">
      {(guideAction?.intent !== 'prepare' || deliveryCurrent) && !active && !shownContact && !contactPartProducer && <button data-testid="graphics-prepare" disabled={prepareDisabled} onClick={() => void prepare()}>{deliveryCurrent ? 'Unity 전달 다시 준비' : `새 ${stage === 'design' ? '이미지' : stage === 'model' ? '모델' : '작업'} 준비`}</button>}
      {journey?.secondaryActions.filter(action => action.intent === 'navigate').map(action => <button key={action.label} onClick={() => handleGuide(action)}>{action.label}</button>)}
      <button type="button" onClick={openImportPanel}>기존 자료 가져오기</button>
    </div>
    <small>{guideTask?.status === 'awaiting_approval' ? '위 카드의 고정된 요청만 실행합니다.' : '화면 이동·후보 비교만으로 생성하거나 과금하지 않습니다.'}</small>
  </footer>;
  const autoRigRuns = workspace?.autoRigRuns?.filter(item => item.objectId === objectId) ?? [];
  const autoRigRun = autoRigRuns.find(item=>item.state==='running') ?? autoRigRuns.at(-1);
  const autoRigLatestResultRun = [...autoRigRuns].reverse().find(item => item.candidateVersionId);
  // History selection is the edit/adoption target. Never use an unseen latest result.
  const autoRigCandidate = shownVersion?.role === 'rig' ? shownVersion : undefined;
  const autoRigResultRun = [...autoRigRuns].reverse().find(item => item.candidateVersionId === autoRigCandidate?.id);
  const autoRigInspectionRun = rigInspectionForCandidate(autoRigCandidate,autoRigRuns);
  const autoRigInspectedPreview = inspectedRigPreview(autoRigCandidate,autoRigInspectionRun);
  const autoRigInspection = autoRigInspectedPreview ? autoRigInspectionRun?.inspection : autoRigResultRun?.inspection;
  const autoRigView: AutoRigView = {
    ready: workspace?.autoRigReadiness?.available === true && creation.subject === 'human',
    checked: !!workspace?.autoRigReadiness,
    readiness: workspace?.autoRigReadiness ? [workspace.autoRigReadiness.message, [workspace.autoRigReadiness.blenderVersion && `Blender ${workspace.autoRigReadiness.blenderVersion}`, workspace.autoRigReadiness.addonVersion && `Auto-Rig Pro ${workspace.autoRigReadiness.addonVersion}`, workspace.autoRigReadiness.aiVersion && `AI ${workspace.autoRigReadiness.aiVersion}`].filter(Boolean).join(' · ')].filter(Boolean) : [],
    running: autoRigRuns.some(item => item.state === 'running'),
    state: autoRigRun ? ({ running: '로컬 작업 진행 중', review: '저장된 결과 검토', blocked: '확인이 필요합니다', failed: '작업을 완료하지 못했습니다', cancelled: '작업 중단됨' })[autoRigRun.state] : undefined,
    progress: autoRigRun?.message, error: autoRigRun?.error,
    sourceLabel: versions.find(version => version.id === autoRigRun?.sourceVersionId)?.label,
    sourceSha256: autoRigRun?.source.sha256, runId: autoRigRun?.id,
    recoverable: !!autoRigRun && ['failed', 'blocked'].includes(autoRigRun.state),
    candidate: autoRigCandidate, adopted: !!autoRigCandidate && object?.accepted[`rig:${autoRigCandidate.slot}`] === autoRigCandidate.id,
    videos: (autoRigResultRun?.files ?? []).filter(file => /\.(mp4|webm)$/i.test(file.path)).map(file => ({ label: /before|after|compar/i.test(file.path) ? '수정 전후 · 같은 동작 비교' : '팔·손가락·양쪽 무릎 동작 검토', url: window.desktop.assetUrl(project.id, file.path) })),
    checks: (autoRigInspection?.checks ?? []).map(check => ({ label: autoRigPresentation(check.message ?? check.id), passed: check.passed })),
    warnings: [...new Set([...(creation.subject !== 'human' ? ['자동 리깅은 현재 사람 형태의 전체 모델만 지원합니다. 다른 형태는 기타 도구를 선택하세요.'] : []), ...(autoRigInspection?.warnings ?? []).map(autoRigPresentation)])],
    poses: autoRigInspection?.poses?.map(pose=>({...pose,label:autoRigPresentation(pose.label),warning:pose.warning?autoRigPresentation(pose.warning):undefined})),
    bones: autoRigInspection?.boneNames ?? [], islands: autoRigInspection?.islands ?? [],
    correctionAvailable: !!autoRigInspectedPreview && !!autoRigCandidate,
    highlightReady: rigRegionReady && rigRegion?.versionId === autoRigCandidate?.id && shownVersion?.id === autoRigCandidate?.id,
    hasMotionPreview: !!autoRigInspectedPreview || !!autoRigCandidate?.files.some(file=>/\.glb$/i.test(file.path)),
    inspectionId: autoRigInspectionRun?.id,
  };
  const useAutoRig = stage === 'rig' && !legacyRig;
  useEffect(()=>{
    const key=`${objectId}:${autoRigLatestResultRun?.id ?? ''}`;
    const previous=autoRigSeenCandidate.current;
    autoRigSeenCandidate.current=key;
    const newResult=previous.startsWith(`${objectId}:`) && previous!==key;
    if(stage==='rig' && (newResult || !shownVersionId) && autoRigLatestResultRun?.objectId===objectId && autoRigLatestResultRun.candidateVersionId) setShownVersionId(autoRigLatestResultRun.candidateVersionId);
  },[objectId,stage,autoRigLatestResultRun?.id]);
  const autoRigPanel = object && <GraphicsAutoRig key={object.id} object={object} versions={versions} view={autoRigView} disabled={disabled || active}
    previewVersionId={shownVersion?.id}
    footerHost={autoRigFooterHost}
    onCheck={async () => { await run({ kind: 'probe-auto-rig' }); }}
    onRun={async draft => { if(shownVersion?.id!==draft.versionId){setNotice('실행 원본 3D 보기로 선택한 원본을 확인한 뒤 리깅하세요.');return;}const front = { '+X': 'pos-x', '-X': 'neg-x', '+Y': 'pos-y', '-Y': 'neg-y' } as const; await run({ kind: 'start-auto-rig', objectId: object.id, versionId: draft.versionId, frontAxis: front[draft.frontAxis], fingers: draft.fingers }); }}
    onCancel={async () => { const running = autoRigRuns.find(item => item.state === 'running'); if (running) { try { await onAction({ kind: 'cancel-auto-rig', objectId: object.id, runId: running.id }); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } } }}
    onRecover={async () => { if (autoRigRun) await run({ kind: 'recover-auto-rig', objectId: object.id, runId: autoRigRun.id }); }}
    onInspect={async () => { if (autoRigCandidate) await run({ kind: 'inspect-auto-rig', objectId: object.id, versionId: autoRigCandidate.id }); }}
    onCorrect={async repair => { if (autoRigCandidate && autoRigInspectionRun && autoRigInspectedPreview && rigRegionReady && rigRegion?.versionId===autoRigCandidate.id && rigRegion.mesh===repair.mesh && rigRegion.islandId===repair.islandId) await run({ kind: 'repair-auto-rig', objectId: object.id, versionId: autoRigCandidate.id, inspectionRunId: autoRigInspectionRun.id, repairs: [repair] }); }}
    onShow={version => { setShownVersionId(version.id); revealResult(); }}
    onAdopt={async () => { if (autoRigCandidate && await run({ kind: 'accept', objectId: object.id, versionId: autoRigCandidate.id }, '이 리그를 사용할 원본으로 저장했습니다.')) changeStage('unity'); }}
    onUnity={() => changeStage('unity')}
    onRegion={island => { setRigRegionReady(false); if(island?.vertexIndices && autoRigCandidate) { setShownVersionId(autoRigCandidate.id);setRigRegion({mesh:island.mesh,islandId:island.islandId,vertexIndices:island.vertexIndices,versionId:autoRigCandidate.id}); } else setRigRegion(undefined); }} />;
  const currentJobs = (<>
            {visibleTasks.length > 0 && (
              <div className="gs-current-jobs" aria-label="현재 작업 상태">
                {visibleTasks.map((task) => (
                  <div
                    className={`gs-current-job gs-job-${task.status}`}
                    key={task.id}
                    data-testid={`graphics-current-task-${task.id}`}
                    aria-busy={
                      task.status === "running" && !task.runtimeApproval
                    }
                    role={
                      ["failed", "submission_unknown"].includes(task.status)
                        ? "alert"
                        : "status"
                    }
                  >
                    <div className="gs-current-job-copy">
                      <strong>
                        {task.status === "running" && !task.runtimeApproval && (
                          <LoaderCircle
                            className="gs-progress-spinner"
                            size={14}
                            aria-label="작업 진행 중"
                          />
                        )}
                        {task.settings.clipName
                          ? `${task.settings.clipName} · `
                          : task.settings.partLabel || task.settings.partId ? `${task.settings.partLabel ?? task.settings.partId} · ` : ""}
                        {task.surfaceRecoveryVersionId ? '빈 면 UV 복구' : task.settings.contactPhase ? task.settings.contactPhase === 'analyze' ? '목·헤어 접합 영역 분석' : task.settings.contactPhase === 'reconstruct' ? '목·헤어 구조 보정' : '목·헤어 접합 보정' : findGraphicsTask(task.taskId)?.name ?? task.taskId} ·{" "}
                        {task.runtimeApproval && task.status === "running"
                          ? "사용자 확인 대기"
                          : task.surfaceRecoveryVersionId && task.status === 'running' ? '로컬 빈 면 UV 복구 중'
                          : task.surfaceRecoveryVersionId && task.status === 'cancelled' ? '로컬 빈 면 UV 복구 중지'
                          : task.surfaceRecoveryVersionId && task.status === 'failed' ? '로컬 빈 면 UV 복구 실패'
                          : task.partSourceRecoveryVersionId && task.status === 'running' ? '로컬 파트 작업 원본 준비 중'
                          : task.partSourceRecoveryVersionId && task.status === 'cancelled' ? '로컬 원본 준비 중지'
                          : task.partSpaceRecoveryVersionId && task.status === 'running' ? '로컬 크기·위치 복원 중'
                          : task.partSpaceRecoveryVersionId && task.status === 'cancelled' ? '로컬 복원 중지'
                          : task.status === 'review' && contactResultForTask(task)?.status === 'blocked' ? task.settings.contactPhase === 'analyze' ? '영역 분석 완료 · 보정 불가' : '보정 중단 · 범위 제한'
                          : task.status === 'review' && task.settings.contactPhase === 'analyze' && task.outputVersionIds.length ? '분석 완료 · 영역 검토'
                          : task.status === 'review' && task.outputVersionIds.length ? '완료 · 결과 확인'
                          : task.status === 'cancelled' && task.paidApproval && !task.surfaceRecoveryVersionId ? '추적 중지 · 원격 상태 확인 필요'
                          : taskStatuses[task.status]}
                      </strong>
                      <p>{contactResultForTask(task)?.status === 'blocked' ? contactResultForTask(task)?.warnings[0] || '보호 영역과 수정 범위를 확정하지 못해 중단했습니다. 기존 조립·파트와 채택 상태는 유지됩니다.' : task.status === 'review' && contactResultForTask(task)?.status === 'repaired' ? '수정 후보의 보존 검사를 통과했습니다. 외형은 전후 비교에서 검토한 뒤 채택하세요. 이전 중단 진단과 원본은 유지됩니다.' : task.status === 'review' && task.settings.contactPhase === 'analyze' ? '분석한 수정 영역을 먼저 확인하세요. 이 결과는 모델 채택 대상이 아닙니다.' : task.message || "작업 상태를 확인하고 있습니다."}</p>
                      {task.status === 'cancelled' && task.paidApproval && !task.partSpaceRecoveryVersionId && !task.partSourceRecoveryVersionId && !task.surfaceRecoveryVersionId && <p className="gs-warning">유료 실행이 승인된 요청입니다. 추적 중지는 원격 처리나 과금 취소를 뜻하지 않습니다. 이전에 완료된 결과는 별도로 유지됩니다.</p>}
                      {task.errorCode && <code>{task.errorCode}</code>}
                      {task.runtimeApproval && task.status === "running" && (
                        <RuntimeApprovalCard
                          key={task.runtimeApproval.id}
                          task={task}
                          disabled={disabled}
                          onAnswer={(answer) =>
                            void run({
                              kind: "runtime-approval",
                              taskId: task.id,
                              approvalId: task.runtimeApproval!.id,
                              answer,
                            })
                          }
                        />
                      )}
                    </div>
                    <div className="gs-current-job-actions">
                      {task.status === "awaiting_approval" && (
                        <button
                          onClick={() =>
                            document
                              .querySelector(
                                `[data-testid="graphics-cost-${task.id}"]`,
                              )
                              ?.scrollIntoView({
                                block: "start",
                                behavior: "smooth",
                              })
                          }
                        >
                          비용·입력 확인
                        </button>
                      )}
                      {["failed", "submission_unknown"].includes(
                        task.status,
                      ) && (
                        <button
                          disabled={disabled}
                          data-testid={`graphics-recover-${task.id}`}
                          onClick={() =>
                            void run({ kind: "recover", taskId: task.id })
                          }
                        >
                          {task.surfaceRecoveryVersionId ? '저장된 빈 면 UV 복구 · 무료' : task.partSourceRecoveryVersionId ? '저장된 파트 작업 원본 준비 · 무료' : task.partSpaceRecoveryVersionId ? '저장된 파트 크기·위치 복원 · 무료' : recoveryLabel(task)}
                        </button>
                      )}
                      {task.status === "running" && (
                        <button
                          disabled={disabled}
                          onClick={() =>
                            void run({ kind: "cancel", taskId: task.id })
                          }
                        >
                          {task.surfaceRecoveryVersionId ? '로컬 빈 면 UV 복구 중지' : task.partSourceRecoveryVersionId ? '로컬 원본 준비 중지' : task.partSpaceRecoveryVersionId ? '로컬 복원 중지' : '추적 중지'}
                        </button>
                      )}
                      {task.status === "review" && task.outputVersionIds.some(id => versions.some(version => version.id === id)) && (
                        <button
                          className={isShownContactContinuation(task) ? 'gs-primary' : undefined}
                          data-testid={`graphics-task-result-${task.id}`}
                          onClick={() => showTaskResult(task)}
                        >
                          {isShownContactContinuation(task) ? contactResultForTask(task)?.status === 'blocked' ? '중단 이유 보기' : '새 보정 결과 보기' : '완료 · 결과 보기'}
                        </button>
                      )}
                      {task.status === "review" && task.taskId === "M07" && (
                        <button disabled={disabled} data-testid={`graphics-refresh-parts-${task.id}`}
                          onClick={() => void run({ kind: "refresh-parts", taskId: task.id })}>
                          파츠 미리보기 갱신 · 생성 없음
                        </button>
                      )}
                      <button onClick={() => showAuxiliary("history")}>
                        기록
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
  </>);
  const approvalCards = (<>
              {waiting.map((task) => {
                const approval = graphicsApprovalState(task, clock);
                const nativeUsage =
                  task.cost?.provider === "Codex" &&
                  ["codex-image", "astra"].includes(
                    findGraphicsTask(task.taskId)?.executor ?? "",
                  );
                const expired =
                  task.cost?.expiresAt !== undefined &&
                  task.cost.expiresAt <= clock;
                return (
                  <div
                    className="gs-cost"
                    key={task.id}
                    data-testid={`graphics-cost-${task.id}`}
                  >
                    <div>
                      <span className="gs-eyebrow">실행 전 요청 확인</span>
                      <h3>
                        {findGraphicsTask(task.taskId)?.name ?? task.taskId}
                      </h3>
                      <p>
                        {task.cost?.provider ?? "제공자 확인 필요"} ·{" "}
                        {task.cost?.credits == null
                          ? nativeUsage
                            ? "Codex 계정 사용량"
                            : "비용 확인 필요"
                          : `${task.cost.credits.toLocaleString()} 크레딧`}
                      </p>
                      <p>{task.cost?.basis ?? task.message}</p>
                      {task.objectSnapshot && (
                        <p className="gs-fine">
                          고정 대상: {task.objectSnapshot.name} ·{" "}
                          {kinds[task.objectSnapshot.kind]}
                        </p>
                      )}
                      {task.targetProfile && (
                        <p className="gs-fine">
                          고정 Unity 대상: {task.targetProfile.projectPath} ·
                          Unity {task.targetProfile.unityVersion} ·{" "}
                          {task.targetProfile.pipeline.toUpperCase()}
                        </p>
                      )}
                      <p className="gs-frozen-instruction">
                        {task.instruction || "추가 지시 없음"}
                      </p>
                      <div
                        className="gs-frozen-inputs"
                        aria-label="고정된 입력 버전"
                      >
                        {task.inputVersionIds.map((versionId, inputIndex) => {
                          const input = workspace?.versions.find(
                            (version) => version.id === versionId,
                          );
                          const inputFile =
                            task.taskId === "N02"
                              ? input?.files.find(
                                  (file) =>
                                    file.path ===
                                    task.settings.motionSourcePath,
                                )
                              : (input?.files.find((file) =>
                                  /\.(png|jpe?g|webp)$/i.test(file.path),
                                ) ?? input?.files[0]);
                          const imagePath =
                            inputFile &&
                            /\.(png|jpe?g|webp)$/i.test(inputFile.path)
                              ? inputFile.path
                              : undefined;
                          const direction = usesModelMultiview(
                            task.taskId,
                            task.settings,
                          )
                            ? directions.find(
                                ([value]) =>
                                  task.settings[`${value}VersionId`] ===
                                  versionId,
                              )?.[1]
                            : task.taskId === "N02"
                              ? task.settings.motionSourceView === "right"
                                ? "오른쪽"
                                : "왼쪽"
                              : undefined;
                          return (
                            <div
                              className="gs-frozen-input"
                              key={`${versionId}-${inputIndex}`}
                            >
                              {imagePath ? (
                                <img
                                  alt={`${direction ? direction + " · " : ""}${input?.label ?? "고정 입력"}`}
                                  src={window.desktop.assetUrl(
                                    project.id,
                                    imagePath,
                                  )}
                                />
                              ) : (
                                <Box size={23} />
                              )}
                              <span>
                                <strong>
                                  {direction ? `${direction} · ` : ""}
                                  {input?.label ??
                                    "입력 버전을 찾을 수 없습니다."}
                                </strong>
                                <small>
                                  {input
                                    ? `${roles[input.role]} / ${input.slot}`
                                    : versionId}
                                </small>
                                {task.objectSnapshot?.references.some(
                                  (reference) =>
                                    reference.versionId === versionId,
                                ) && (
                                  <small>
                                    참고 역할:{" "}
                                    {task.objectSnapshot.references
                                      .filter(
                                        (reference) =>
                                          reference.versionId === versionId,
                                      )
                                      .map(
                                        (reference) =>
                                          referenceRoles[reference.role],
                                      )
                                      .join(" · ")}
                                  </small>
                                )}
                                <code>{inputFile?.sha256}</code>
                              </span>
                            </div>
                          );
                        })}
                      </div>
                      {task.cost?.expiresAt && (
                        <small>
                          {expired
                            ? "견적 유효 시간이 지났습니다."
                            : `유효 시간: ${new Date(task.cost.expiresAt).toLocaleString("ko-KR")}`}
                        </small>
                      )}
                      <details>
                        <summary>고정된 요청 확인</summary>
                        <p>{task.instruction || "추가 지시 없음"}</p>
                        <p>
                          입력 {task.inputVersionIds.length}개 · 요청{" "}
                          {task.requestHash}
                        </p>
                        <pre>{JSON.stringify(task.settings, null, 2)}</pre>
                      </details>
                    </div>
                    <div className="gs-cost-actions">
                      <button
                        className="gs-secondary"
                        data-testid={`graphics-approve-${task.id}`}
                        disabled={disabled || approval === "blocked"}
                        onClick={() =>
                          void run({ kind: "approve", taskId: task.id })
                        }
                      >
                        {approval === "refresh"
                          ? "견적 다시 확인"
                          : nativeUsage
                            ? "Codex 사용량으로 실행"
                            : task.localOnly
                              ? "로컬 작업 실행"
                              : "이 비용으로 실행"}
                      </button>
                      <button
                        disabled={disabled}
                        onClick={() =>
                          void run({ kind: "cancel", taskId: task.id })
                        }
                      >
                        취소
                      </button>
                    </div>
                  </div>
                );
              })}

  </>);
  const executionSummary = object && (<>
            <div className="gs-execution-summary" aria-label="실행 설정 요약">
              <span><b>대상</b> {creationSubjects.find(item => item.id === creation.subject)?.label ?? object.name}</span>
              <span><b>도구·모델</b> {activeTask.executor === 'tripo' && stage !== 'model' ? `Tripo API · ${activeTask.name}` : activeTask.executor === 'tripo' ? `Tripo · ${catalog.model.find(model => model.id === String(settings.model ?? 'P2-20260801'))?.label ?? settings.model}` : activeTask.executor === 'astra' ? 'Blender + Astra' : activeTask.executor === 'local' ? '로컬 처리' : activeTask.executor === 'runway' ? 'Runway' : activeTask.executor === 'codex-image' ? 'Codex 이미지' : '설정 확인'}</span>
              <span><b>후보</b> {String(settings.count ?? 1)}개</span>
              {stage === 'model' && <span><b>목표 면 수</b> {Number(settings.faceLimit ?? 5000).toLocaleString()}</span>}
              {taskId === 'M09' && <span><b>보완 원본</b> {versions.find(version => version.id === settings.sourceVersionId)?.label ?? '미리보기에서 선택 필요'}</span>}
              {taskId === 'M05' && settings.editSourceMode === 'candidate' && <span><b>보정 원본</b> {versions.find(version => version.id === settings.sourceVersionId)?.label ?? '미리보기에서 선택 필요'}</span>}
              {taskId === 'M09' && <span><b>추가 상한</b> {String(settings.repairMaxAddedFaces ?? 1500)}면 · {String(settings.repairMaxAddedVertices ?? 1000)}정점</span>}
              {stage === 'surface' && <span><b>실행할 모델</b> {surfaceModel?.label ?? '모델 채택 필요'}{texturePart ? ` · ${texturePart.label}` : ''}</span>}
              <span><b>목표 크기</b> {physicalSizeSummary(creation.physicalSize)}</span>
              <span><b>예상 비용</b> {activeTask.executor === 'local' ? '무료 · GPT 0회' : '준비 후 비용 카드 확인'}</span>
            </div>  </>);
  const optionsSummary = object && (<>
              <section
                className="gs-current-options"
                aria-label="현재 제작 옵션"
              >
                <details>
                  <summary>
                    <strong>{object.name}</strong> · 선택한 특징
                  </summary>
                  <p>{summarizeCreation(creation).join(" · ")}</p>
                  <small>
                    옵션 변경과 단계 이동은 생성하지 않습니다. 이미지를 채택한
                    뒤 모델을 제작하세요.
                  </small>
                </details>
                <button
                  type="button"
                  disabled={disabled || !sizeInputsValid}
                  onClick={() =>
                    void run(
                      {
                        kind: "update-object",
                        objectId: object.id,
                        patch: { creation },
                      },
                      "현재 제작 옵션을 저장했습니다.",
                    )
                  }
                >
                  옵션 저장
                </button>
              </section>
  </>);
  return (
    <section className={`graphics-studio${planarSourceId ? ' gs-planar-open' : ''}`} data-testid="graphics-studio">
      <header className="gs-header">
        <div>
          <h1>Unity 오브젝트 제작실</h1>
          <p title={`${project.name} · ${object?.name ?? '새 오브젝트'}`}>{object?.name ?? project.name}</p>
        </div>
        <div className="gs-header-actions">
          <details className="gs-aux-menu">
            <summary aria-label="보조 메뉴">
              <MoreHorizontal size={16} />
              <span>더 보기</span>
            </summary>
            <div>
              <button
                disabled={!object}
                onClick={() => showAuxiliary("history")}
              >
                <History size={14} /> 작업 기록 {objectTasks.length}개
              </button>
              <button onClick={() => showAuxiliary("support")}>
                <ListChecks size={14} /> 기능 지원 현황
              </button>
              <button onClick={() => showAuxiliary('storage')}>저장 공간 현황</button>
            </div>
          </details>
          {onExportProject && (
            <button
              aria-label="프로젝트 백업"
              title="프로젝트 백업"
              disabled={disabled}
              onClick={onExportProject}
            >
              <Download size={14} />
            </button>
          )}
          {onOpenSettings && (
            <button onClick={() => onOpenSettings()}>
              <Settings2 size={15} /> 연결 설정
            </button>
          )}
        </div>
      </header>
      <aside className="gs-objects" aria-label="오브젝트 목록">
        <div className="gs-new-object-action">
          <button type="button" className="gs-primary" data-testid="graphics-new-object" disabled={disabled} onClick={event => openNewObject(event.currentTarget)}>
            <FilePlus2 size={17} /> 새 오브젝트
          </button>
        </div>
        <div className="gs-section-title">
          <h2>오브젝트</h2>
          <span>{workspace?.objects.length ?? 0}</span>
        </div>
        <div className="gs-object-list">
          {workspace?.objects.map((item) => (
            <button
              key={item.id}
              className={`gs-object ${objectId === item.id ? "is-active" : ""}`}
              aria-pressed={objectId === item.id}
              data-testid={`graphics-object-${item.id}`}
              onClick={() => setObjectId(item.id)}
            >
              <Box size={18} />
              <span>
                <strong>{item.name}</strong>
                <small>
                  {kinds[item.kind]} ·{" "}
                  {
                    workspace.versions.filter(
                      (version) => version.objectId === item.id,
                    ).length
                  }
                  개 버전
                </small>
              </span>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
        {object?.id === "legacy" && (
          <button
            className="gs-legacy"
            data-testid="graphics-unlink-legacy"
            disabled={disabled}
            onClick={() => {
              setError("");
              setUnlinkObjectId(object.id);
            }}
          >
            <X size={15} /> 선택한 오브젝트 연결 해제
          </button>
        )}
        <button
          className="gs-legacy"
          disabled={disabled}
          onClick={() => void inspectLegacy()}
        >
          <FolderInput size={15} /> 기존 프로젝트 자료 연결
        </button>
      </aside>

      <div className="gs-workspace">
        {object && (
          <section
            className="gs-command-area"
            aria-label="제작 실행과 현재 상태"
          >
            <nav className="gs-creation-stages" aria-label="제작 단계">
              {(journey?.stages ?? creationStages.map(item => ({ ...item, status: 'missing', optional: false, reason: '' }))).filter(item => !['rig', 'animation'].includes(item.id) || item.status !== 'skipped' || movementExpanded).map((item, index) => (
                <button
                  type="button"
                  key={item.id}
                  aria-current={stage === item.id ? "step" : undefined}
                  aria-label={`${creationStages.findIndex(row => row.id === item.id) + 1} ${item.label}`}
                  aria-description={item.reason}
                  onClick={() => changeStage(item.id)}
                >
                  <span>{creationStages.findIndex(row => row.id === item.id) + 1}</span>
                  {item.label}<small>{({complete:'사용 중',review:'결과 확인',running:'진행 중',approval:'확인 필요',blocked:'확인 필요',skipped:'선택 사항',ready:'준비됨',missing:''} as Record<string,string>)[item.status]}</small>
                </button>
              ))}
            </nav>
            {journey?.stages.some(item => item.status === 'skipped') && <button className="gs-motion-toggle" type="button" aria-expanded={movementExpanded} onClick={() => setMovementExpanded(value => !value)}>{movementExpanded ? '움직임 단계 접기' : '움직임 추가 · 선택 사항'}</button>}

          </section>
        )}
        <main className="gs-main">
          {!object && error && (
            <div role="alert" className="gs-alert gs-alert-error">
              <strong>작업을 완료하지 못했습니다.</strong>
              <p>{error}</p>
              <span>기존 원본과 채택 결과는 유지됩니다.</span>
            </div>
          )}
          {notice && auxiliary !== "support" && (
            <div role="status" className="gs-notice">
              {notice}
            </div>
          )}
          {!object ? (
            <div className="gs-empty">
              <Box size={54} strokeWidth={1} />
              <h2>무엇을 만들까요?</h2>
              <p>
                새 오브젝트에서 만들 대상을 고른 뒤 모양과 특징을 설정하세요.
                <br />
                이미 모델이 있다면 이미지 생성 없이 바로 작업할 수 있습니다.
              </p>
              <button type="button" className="gs-primary" data-testid="graphics-empty-new-object" disabled={disabled} onClick={event => openNewObject(event.currentTarget)}><FilePlus2 size={18} /> 첫 오브젝트 만들기</button>
            </div>
          ) : (
            <>
              <div className="gs-work-layout">
                <section className="gs-result">
              {stage === "design" && (
                <div className="gs-reference-strip">
                  <div>
                    <strong>
                      참고 이미지 {object.references.length}개 연결됨
                    </strong>
                    <small>
                      외형·스타일 참고로 사용하며 원본을 덮어쓰지 않습니다.
                    </small>
                  </div>
                  {object.references.map((reference) => {
                    const version = workspace?.versions.find(
                      (item) => item.id === reference.versionId,
                    );
                    const file = version?.files.find((item) =>
                      isImagePath(item.path),
                    );
                    return file ? (
                      <img
                        className="gs-reference-thumb"
                        key={`${reference.versionId}-${reference.role}`}
                        alt={version?.label ?? "참고 원본"}
                        src={window.desktop.assetUrl(project.id, file.path)}
                      />
                    ) : null;
                  })}
                  <button
                    type="button"
                    onClick={() => {
                      const panel = document.querySelector<HTMLDetailsElement>('.gs-references-disclosure');
                      if (panel) panel.open = true;
                      document.getElementById('gs-reference-version')?.focus();
                    }}
                  >
                    참고 원본 연결
                  </button>
                </div>
              )}

                  <div className="gs-section-title">
                    <h2>자료와 결과</h2>
                    <span>{versions.length}개 버전</span>
                  </div>
                  {comparisonGroup && (
                    <section
                      className="gs-candidate-comparison"
                      aria-label={`${comparisonLabel} 후보 비교`}
                      data-testid="graphics-candidate-comparison"
                      data-batch-id={comparisonGroup.id}
                    >
                      <div className="gs-candidate-heading">
                        <h3>
                          {comparisonLabel} 후보{" "}
                          {comparisonGroup.candidates.length}개 함께 보기
                        </h3>
                        <small>같은 제작 작업의 결과</small>
                      </div>
                      <label>
                        제작 작업
                        <select
                          aria-label="비교할 제작 작업"
                          value={comparisonGroup.id}
                          onChange={(event) => {
                            const group = mediaGroups.find(
                              (group) => group.id === event.target.value,
                            );
                            if (group)
                              setShownVersionId(group.candidates[0].version.id);
                          }}
                        >
                          {mediaGroups
                            .filter(
                              (group) => group.kind === comparisonGroup.kind,
                            )
                            .map((group) => (
                              <option value={group.id} key={group.id}>
                                {group.label} · {group.candidates.length}개
                              </option>
                            ))}
                        </select>
                      </label>
                      <p className="gs-fine">
                        {comparisonGroup.kind === 'image' ? '각 후보 바로 아래 채택 버튼으로 확정하세요.' : '미리보기를 고른 뒤 상세 결과의 채택 버튼으로 확정하세요.'} 채택은 제작을 실행하지 않습니다.
                        다른 제작 작업의 결과는 섞이지 않습니다.
                      </p>
                      <div
                        className={`gs-candidate-grid${comparisonGroup.candidates.length === 1 ? " is-single" : ""}`}
                      >
                        {comparisonGroup.candidates.map(
                          ({ version, media }, index) => {
                            const selected = shownVersion?.id === version.id,
                              accepted = acceptedVersion(object, version);
                            const label = `후보 ${index + 1} · ${version.label}`;
                            return (
                              <article
                                className={`gs-candidate-card${selected ? " is-selected" : ""}`}
                                key={version.id}
                                data-testid={`graphics-candidate-${version.id}`}
                              >
                                {media.kind === "image" ? (
                                  <button
                                    className="gs-candidate-image"
                                    aria-label={`${label} 미리보기 선택`}
                                    aria-pressed={selected}
                                    onClick={() =>
                                      setShownVersionId(version.id)
                                    }
                                  >
                                    <img
                                      alt={label}
                                      src={window.desktop.assetUrl(
                                        project.id,
                                        media.path,
                                      )}
                                      loading="lazy"
                                      decoding="async"
                                    />
                                  </button>
                                ) : (
                                  <video
                                    className="gs-candidate-video"
                                    aria-label={`${label} 원본 영상`}
                                    controls
                                    playsInline
                                    preload="metadata"
                                    src={window.desktop.assetUrl(
                                      project.id,
                                      media.path,
                                    )}
                                  />
                                )}
                                <button
                                  className="gs-candidate-select"
                                  aria-label={`${label} 상세 미리보기`}
                                  aria-pressed={selected}
                                  onClick={() => setShownVersionId(version.id)}
                                >
                                  <strong>{label}</strong>
                                  <span>
                                    {selected ? "미리보기 선택됨" : "미리보기"}
                                    {accepted && (
                                      <>
                                        <Check size={12} aria-hidden="true" />
                                        채택됨
                                      </>
                                    )}
                                  </span>
                                </button>
                                {media.kind === 'image' && <button className="gs-candidate-adopt" data-testid={`graphics-accept-image-${version.id}`} disabled={disabled || accepted}
                                  onClick={() => { setShownVersionId(version.id); adoptVersion(version); }}>
                                  {accepted ? '현재 사용하는 이미지' : '이 이미지 사용 · 다음 설정'}
                                </button>}
                              </article>
                            );
                          },
                        )}
                      </div>
                    </section>
                  )}
                  {versions.filter(version => importedChoiceIds.includes(version.id)).length > 1 && <section className="gs-preview-actions" aria-label="이번에 가져온 모델 후보" data-testid="graphics-import-candidates"><strong>가져온 모델을 하나씩 확인하세요</strong><div>{versions.filter(version => importedChoiceIds.includes(version.id)).map((version, index) => <button key={version.id} type="button" aria-pressed={shownVersion?.id === version.id} onClick={() => showVersion(version)}>{index + 1}. {version.label}{shownVersion?.id === version.id ? ' · 미리보기 중' : ''}</button>)}</div><small>각 파일은 별도 후보입니다. 미리본 뒤 ‘이 결과 사용’으로 하나를 선택하세요.</small></section>}
                  {shownVersion && <div className="gs-preview-caption" data-testid="graphics-preview-context">
                    <div><strong>{acceptedVersion(object, shownVersion) ? '현재 사용하는 결과' : '미리보는 후보 · 아직 사용하지 않음'}</strong><small>{shownVersion.label}</small></div>
                    <button type="button" aria-expanded={editOpen} disabled={disabled || active || !!shownImportProblem} onClick={() => setEditOpen(value => !value)}>수정하기</button>
                    <small>미리보기 선택은 다음 작업의 원본을 바꾸지 않습니다.</small>
                  </div>}
                  {shownImportProblem && <section className="gs-result-notes" role="status" data-testid="graphics-import-source-warning"><strong>여러 모델이 하나의 결과에 들어 있습니다</strong><p>{shownImportProblem}</p><p>기존 파일과 사용 기록은 보존했습니다. 다시 가져온 후보에서 사용할 모델을 골라 주세요.</p><button type="button" disabled={disabled || active} onClick={openSingleSourceImport}>사용할 모델 다시 가져오기</button></section>}
                  {editOpen && shownVersion && !shownImportProblem && <div className="gs-edit-menu" aria-label="결과 수정 방법">
                    <p><b>수정 원본:</b> {shownVersion.label} · 수정본은 별도로 저장됩니다.</p>
                    {shownVersion.role === 'design' && <button disabled={!acceptedVersion(object, shownVersion)} onClick={() => { changeStage('design'); settingForStage('design', 'designMode', 'revision'); setNotice('현재 사용하는 이미지를 수정합니다. 바꿀 부분과 유지할 부분을 추가 지시에 적어 주세요.'); }}>이미지 수정</button>}
                    {['model', 'material'].includes(shownVersion.role) && <>
                      <button disabled={needsPartPreparation || !!shownContact || !!contactPartProducer} onClick={() => chooseRevisionSource(shownVersion)}>형태·비율 보정</button>
                      <button disabled={needsPartPreparation || !!shownContact || !!contactPartProducer} onClick={() => { setPlanarSourceId(shownVersion.planarRepair?.versionId ?? shownVersion.id); setEditOpen(false); requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid=graphics-planar-review]')?.scrollIntoView({ block: 'start', behavior: 'auto' })); }}>빠진 면 검사</button>
                      <button disabled={!acceptedVersion(object, shownVersion)} onClick={() => { changeStage('surface'); settingForStage('surface', 'surfaceOperation', 'texture'); }}>재질·텍스처 변경</button>
                      <button disabled={!acceptedVersion(object, shownVersion)} onClick={() => { changeStage('model'); window.setTimeout(() => document.querySelector('.gs-size-panel')?.scrollIntoView({block:'center'}), 0); }}>실제 크기 변경</button>
                    </>}
                    {!acceptedVersion(object, shownVersion) && <small>이미지·재질·크기 변경은 먼저 이 결과 사용으로 원본을 확정하세요. 형태 보정과 빠진 면 보완은 지정한 후보를 직접 사용합니다.</small>}
                    {['rig', 'animation', 'unity', 'motion-reference'].includes(shownVersion.role) && <p>이 결과의 수정 범위는 해당 단계 설정에서 확인하세요. 메시 수정은 원본 모델에서 진행합니다.</p>}
                  </div>}
                  {planarSourceId && workspace && versions.find(version => version.id === planarSourceId) && <GraphicsPlanarReview key={planarSourceId + ':' + (workspace.planarInspections?.[planarSourceId]?.reportFile?.sha256 ?? workspace.planarInspections?.[planarSourceId]?.inspectionId ?? '')} project={project} workspace={workspace} source={versions.find(version => version.id === planarSourceId)!} disabled={disabled || active} onAction={onAction} onClose={() => setPlanarSourceId('')} onAccept={version => { void adoptVersion(version); setPlanarSourceId(''); }} />}
                  {shownVersion && shownContact ? <GraphicsContactReview key={shownVersion.id} projectId={project.id} version={shownVersion} disabled={disabled || active} accepted={shownAcceptanceComplete} sourceAvailable={versions.some(version => version.id === shownContact.sourceVersionId)}
                    procedureRecoveryAvailable={contactProcedureRecoveryAvailable}
                    onPrepareRepair={() => void prepareContact(shownVersion, 'repair')}
                    onPrepareReconstruct={() => void prepareContact(shownVersion, 'reconstruct')}
                    onRecoverProcedure={() => { if (shownContactTask) void run({ kind: 'recover-contact-procedure', taskId: shownContactTask.id }, '저장된 보정 절차의 로컬 호환 복구를 요청했습니다. 추가 GPT 호출 없이 같은 작업의 결과를 확인합니다.'); }}
                    onKeepSource={() => { const source = versions.find(version => version.id === shownContact.sourceVersionId); if (source) showVersion(source); setNotice('기존 조립 결과로 돌아왔습니다. 채택 상태와 파일은 변경하지 않았습니다.'); }}
                    onAccept={() => adoptVersion(shownVersion)} onImage={(path, label) => setFocusedImage({ path, label })} /> : <div className={`gs-preview${headComparisonOpen && headCandidate && headBaseline ? ' gs-preview-comparison' : ''}`} data-testid="graphics-preview">
                    {headComparisonOpen && headCandidate && headBaseline && !shownImportProblem
                      ? <HeadComparison projectId={project.id} baseline={headBaseline} candidate={headCandidate} choices={headVersions} acceptedId={acceptedHeadId} onBaseline={setHeadBaselineId} onClose={() => setHeadComparisonOpen(false)} />
                      : <VersionPreview project={project} version={shownVersion} physicalSize={shownVersion?.slot.startsWith("part-") ? undefined : creation.physicalSize} onBounds={setModelBounds} onMeshSelect={setMeshSelection} nativePolygonCount={nativeMeasurement?.versionId === shownVersion?.id ? nativeMeasurement?.faces : undefined} previewFile={stage==='rig' && shownVersion?.id===autoRigCandidate?.id ? autoRigInspectedPreview : undefined} rigRegion={stage==='rig' && rigRegion?.versionId===shownVersion?.id ? rigRegion : undefined} onRigRegionStatus={status=>setRigRegionReady(status.ready)} />}
                  </div>}
                  {shownVersion?.provenance.type === 'import' && shownVersion.files.filter(file => /\.(fbx|blend|obj|stl)$/i.test(file.path)).length === 1 && !shownVersion.files.some(file => /\.glb$/i.test(file.path)) && <section className="gs-result-notes" aria-label="가져온 모델 미리보기">
                    <strong>가져온 모델을 화면에서 확인하세요</strong>
                    <p>Blender로 미리보기 사본을 준비합니다. 원본 파일과 현재 사용하는 결과는 그대로 유지합니다.</p>
                    <button type="button" className="gs-primary" data-testid="graphics-prepare-import-preview" disabled={disabled || active} onClick={() => void run({ kind: 'prepare-import-preview', objectId: object.id, versionId: shownVersion.id }, '미리보기 준비가 끝났습니다. 원본과 채택 상태는 유지됩니다.')}>
                      {pending ? <><LoaderCircle size={15} className="gs-spin" /> 미리보기 준비 중…</> : '미리보기 준비 · 무료'}
                    </button>
                    <small>추가 서비스 비용 없음 · 제작용 GPT 사용 없음</small>
                  </section>}
                  {shownVersion && !shownContact && !contactPartProducer && ['model', 'material'].includes(shownVersion.role) && <div className="gs-preview-actions" data-testid="graphics-preview-actions">
                    <strong>{shownVersion.label}</strong>
                    <div>
                      <button className="gs-adopt-secondary" data-testid="graphics-accept-preview" disabled={disabled || needsPartPreparation || shownAcceptanceComplete || !!shownImportProblem} onClick={() => adoptVersion(shownVersion)}>
                        {shownAcceptanceComplete ? shownAssembly ? '현재 채택한 조립·파트' : '현재 채택한 모델' : needsPartSpaceRestoration ? '크기·위치 복원 후 채택' : needsPartSourcePreparation ? '작업 원본 준비 후 채택' : shownAssembly ? '이 조립과 파트 채택' : '이 모델 채택'}
                      </button>
                      {headCandidate && headBaseline && !headComparisonOpen && <button data-testid="graphics-compare-heads" onClick={() => { setHeadBaselineId(headBaseline.id); setHeadComparisonOpen(true); setMeshSelection(null); }}>
                        {headBaseline.id === acceptedHeadId ? '채택 머리와 나란히 비교' : '머리 버전 나란히 비교'}
                      </button>}
                    </div>
                    <small>{shownAssembly ? '같은 조립 작업의 전체 모델과 배치된 파트를 함께 채택합니다. 이후 파트 UV도 이 배치를 사용하며, 이전 원본은 유지됩니다.' : '채택은 다음 작업의 원본만 바꾸며, 제작을 실행하지 않습니다.'}</small>
                  </div>}
                  {shownVersion && shownSurfaceRepairSources && <section className="gs-result-notes" aria-label="빈 면의 UV 복구" data-testid="graphics-surface-repair">
                    <strong>보완한 면에 무늬가 빠져 있나요?</strong>
                    <p>기존 같은 재질 면의 무늬를 재사용해 새 면의 UV만 복구합니다. 기존 이미지 맵과 원본은 유지하고 별도 수정본을 만듭니다.</p>
                    {shownSurfaceRepairResult
                      ? <button type="button" className="gs-primary" data-testid="graphics-surface-repair-result" disabled={disabled || active} onClick={() => showVersion(shownSurfaceRepairResult)}>복구한 결과 보기</button>
                      : <button type="button" className="gs-primary" data-testid="graphics-repair-surface-uv" disabled={disabled || active} onClick={() => void run({ kind: 'repair-surface-uv', versionId: shownVersion.id }, '빈 면의 UV 복구를 시작했습니다. 진행 상태를 확인하고 완료 후 복구한 결과를 비교해 직접 채택하세요. 기존 채택은 유지됩니다.')}>
                        기존 재질로 빈 면 복구 · 무료
                      </button>}
                    <small>추가 API 비용·GPT 호출 없음. 무늬 공유·늘어짐·경계 차이는 결과를 보고 확인하세요. 자동으로 채택하지 않습니다.</small>
                  </section>}
                  {shownVersion?.surfaceRepair && <p className="gs-fine" data-testid="graphics-surface-repair-complete">기존 재질을 재사용한 빈 면 UV 복구본입니다. 원본 텍스처 이미지는 유지됐습니다. 새 면의 무늬와 경계를 확인한 뒤 채택하세요.</p>}
                  {shownVersion && shownMissingSurfaceResult && <section className="gs-result-notes" aria-label="보완한 면의 UV 준비" data-testid="graphics-repair-uv-warning">
                    <strong>새로 보완한 면은 UV를 확인해야 합니다</strong>
                    <p>면을 추가해도 새 면의 UV와 텍스처가 자동으로 완성되지는 않습니다. 이 보완 결과를 채택한 뒤 UV 생성 → UV 결과 채택 → 텍스처 생성 순서로 진행하세요.</p>
                    <button type="button" disabled={disabled || active} onClick={() => showUvPreparation(shownVersion)}>UV 준비로 이동</button>
                    <small>무료 로컬 UV 설정으로 이동합니다. 이동만으로 생성하거나 채택하지 않습니다.</small>
                  </section>}
                  {contactPartProducer && <section className="gs-contact-entry" aria-label="접합 보정 파트 채택 안내">
                    <div><strong>이 파트는 수정한 조립과 함께 채택합니다</strong><p>목·헤어 접합의 배치를 유지하도록 전체 비교에서 조립·파트를 한 번에 채택하세요.</p></div>
                    <button type="button" className="gs-primary" data-testid="graphics-contact-part-review" disabled={!contactPartMain} onClick={() => showVersion(contactPartMain!)}>수정한 조립 비교로 돌아가기</button>
                  </section>}
                  {shownVersion && canInspectContact && !shownContact && <section className="gs-contact-entry" aria-label="목·헤어 접합 확인">
                    <div><strong>목 연결부와 헤어 안쪽을 확인하세요</strong><p>현재 조립 후보를 그대로 검사합니다. 먼저 채택하거나 조립을 다시 실행하지 않습니다.</p></div>
                    <button type="button" className="gs-primary" data-testid="graphics-contact-analyze" disabled={disabled || active} onClick={() => void prepareContact(shownVersion, 'analyze')}>목·헤어 접합 확인</button>
                    <small>영역 분석 최대 1회 + 확인한 영역 보정 최대 1회 · GPT 사용량 발생 · 추가 Tripo·fal 비용 없음. 새 모델·UV·텍스처·리깅은 실행하지 않습니다.</small>
                  </section>}
                  {shownVersion && needsPartSourcePreparation && <div className="gs-result-notes" aria-label="파트 작업 원본 준비 필요" data-testid="graphics-part-source-warning">
                    <strong>채택 전 파트 작업 원본 준비 필요</strong>
                    <p>외부에서 생성한 파트의 작업 원본이 아직 준비되지 않았습니다. 무료로 로컬 작업 사본을 준비한 뒤 결과를 확인하고 채택하세요. 외형을 자동으로 판단하거나 다시 생성하지 않으며, 외부 원본 파일은 그대로 보관합니다.</p>
                    <button data-testid="graphics-prepare-part-source" disabled={disabled || active}
                      onClick={() => void run({ kind: 'prepare-part-source', versionId: shownVersion.id }, '파트 작업 원본 준비를 요청했습니다. 새 제작 없이 로컬에서 준비하며, 완료되면 결과 보기를 눌러 주세요.')}>
                      파트 작업 원본 준비 · 무료
                    </button>
                  </div>}
                  {meshSelection && shownVersion && !shownContact && !contactPartProducer && <div className="gs-mesh-correction">
                    <strong>선택 부품: {meshSelection.name}</strong>
                    <p>위치·형태만 보정하며 다른 메시와 원본 구조를 보존합니다. 재생성·재토폴로지는 별도 작업입니다.</p>
                    <button disabled={disabled || active || needsPartPreparation || shownVersion.role !== 'model' || !acceptedVersion(object, shownVersion) || (!meshSelection.sourceId && !meshSelection.sourceName)} onClick={() => {
                      const sourceName = meshSelection.sourceName;
                      setCreation(current => {
                        const next = changeCreationAssemblyMode(current, 'partial');
                        Object.assign(next.stageSettings.assembly!.values, { editMeshIds: JSON.stringify(meshSelection.sourceId ? [meshSelection.sourceId] : []), editMeshNames: JSON.stringify(meshSelection.sourceId ? [] : [sourceName]), meshSelectionVersionId: shownVersion.id });
                        return next;
                      });
                      setStage('assembly'); setTaskId(undefined);
                      setNotice('선택 부품을 수정 대상으로 지정했습니다. 수정할 내용을 적고 실행을 준비하세요.');
                    }}>선택 부품 보정하기</button>
                    <button disabled={disabled || active || needsPartPreparation || !['model', 'material'].includes(shownVersion.role) || Boolean(modelBounds?.hasSkin || modelBounds?.hasMorph || modelBounds?.hasAnimation) || (!meshSelection.sourceId && !meshSelection.sourceName)}
                      onClick={() => chooseRepairSource(shownVersion, meshSelection)}>선택 부품 빠진 면 보완</button>
                    {!meshSelection.sourceId && !meshSelection.sourceName && <small>원본 메시 연결 미확인 · 안전하게 대응되는 이름 또는 ID가 필요합니다.</small>}
                    {meshSelection.sourceName && <small>보정 범위: 원본 메시 {meshSelection.sourceName} 전체. 재질별로 나뉜 미리보기 조각도 같은 원본 메시를 대상으로 합니다.</small>}
                    {(shownVersion.role !== 'model' || !acceptedVersion(object, shownVersion)) && <small>채택한 모델에서 선택하세요. 리그·동작 결과의 직접 메시 보정은 지원하지 않습니다.</small>}
                  </div>}
                  {shownVersion && (
                    <details className="gs-version-detail"><summary>결과 검사 · 원본 파일 · 상세 작업</summary>
                      <div>
                        <strong>{shownVersion.label}</strong>
                        <span className="gs-tag">
                          {roles[shownVersion.role]} / {shownVersion.slot}
                        </span>
                        {acceptedVersion(object, shownVersion) && (
                          <span className="gs-tag gs-ready">
                            <Check size={12} /> 채택됨
                          </span>
                        )}
                      </div>
                      <p>
                        {stamp(shownVersion.createdAt)} ·{" "}
                        {provenanceLabels[shownVersion.provenance.type]} · 저장
                        파일 {shownVersion.files.length}개
                      </p>
                      {shownContact?.phase !== 'analyze' && ["model", "rig", "animation"].includes(shownVersion.role) && <p className="gs-model-provenance">제작 원본: {modelProductionLabel(shownVersion, versions, objectTasks)}<br />{modelProductionGeometry(shownVersion, versions, objectTasks)} · 실제 결과 면수와 다를 수 있습니다.</p>}
                      {shownVersion.role === "model" && shownContact?.phase !== 'analyze' && (
                        <ModelStatistics
                          projectId={project.id}
                          version={shownVersion}
                          versions={versions}
                          tasks={objectTasks}
                          onMeasure={setNativeMeasurement}
                        />
                      )}
                      {shownVersion.warnings.length > 0 && <div className="gs-result-notes" aria-label="결과 검토 사항">
                        <strong>검토할 사항</strong>
                        <ul>{shownVersion.warnings.map((warning, index) => <li className="gs-warning" key={index}>{warning}</li>)}</ul>
                      </div>}
                      {needsPartSpaceRestoration && <div className="gs-result-notes" aria-label="파트 크기·위치 확인 필요" data-testid="graphics-part-space-warning">
                        <strong>채택 전 원래 크기·위치 확인 필요</strong>
                        <p>외부 UV·텍스처 결과가 원래 파트의 크기와 위치를 유지했는지 아직 확인하지 않았습니다. 무료 복원을 거친 새 결과를 확인한 뒤 채택하세요. 외부 원본 파일은 그대로 보관합니다.</p>
                        <button data-testid="graphics-restore-part-space" disabled={disabled || active}
                          onClick={() => void run({ kind: 'restore-part-space', versionId: shownVersion.id }, '원래 크기·위치 복원을 요청했습니다. 새 제작 없이 로컬에서 확인하며, 완료되면 결과 보기를 눌러 주세요.')}>
                          원래 크기·위치 복원 · 무료
                        </button>
                      </div>}
                      {shownVersion.partSpace && <p className="gs-fine" data-testid="graphics-part-space-restored">원래 파트의 크기·위치 복원 결과입니다. 외부 원본은 별도 버전으로 보관됩니다.</p>}
                      {shownVersion.partSource && <p className="gs-fine" data-testid="graphics-part-source-prepared">로컬 파트 작업 사본입니다. 외부 원본은 별도 버전으로 보관되며, 외형 검토와 채택은 직접 진행하세요.</p>}
                      {!shownContact && !contactPartProducer && !shownImportProblem && ['model', 'material'].includes(shownVersion.role) && <div className="gs-result-notes" aria-label="결과 추가 보정">
                        <button disabled={disabled || active || needsPartPreparation} onClick={() => chooseRevisionSource(shownVersion)}>이 결과 더 보정</button>
                        <small>현재 보는 결과의 형태를 이어서 수정합니다. 채택 전 후보도 지정할 수 있으며, 원본과 채택 상태는 유지됩니다.</small>
                      </div>}
                      {!contactPartProducer && ['model', 'material'].includes(shownVersion.role) && shownVersion.slot.startsWith('part-') && <div className="gs-result-notes" aria-label="파트 빠진 면 보완">
                        <p>분리된 파트에 두피·뒤통수처럼 빠진 면이 있으면, 이 원본의 기존 면을 보존하면서 보완할 수 있습니다. UV·텍스처는 보완 결과를 채택한 다음 준비하세요.</p>
                        <button disabled={disabled || active || needsPartPreparation || Boolean(modelBounds?.hasSkin || modelBounds?.hasMorph || modelBounds?.hasAnimation)}
                          onClick={() => chooseRepairSource(shownVersion)}>이 파트 빠진 면 보완</button>
                        <small>원본과 채택 상태는 유지됩니다. 단일 메시 파트만 바로 지정할 수 있으며, 여러 메시가 있으면 위 미리보기에서 보완할 메시를 선택하세요.</small>
                      </div>}
                      <div className="gs-file-actions">
                        <button
                          disabled={disabled}
                          onClick={() => void openProjectFolder()}
                        >
                          <FolderOpen size={14} /> 프로젝트 폴더 열기
                        </button>
                        {shownVersion.files.some((file) =>
                          isImagePath(file.path),
                        ) && (
                          <button
                            onClick={() => {
                              const file = shownVersion.files.find((item) =>
                                isImagePath(item.path),
                              )!;
                              setFocusedImage({
                                path: file.path,
                                label: fileName(file.path),
                              });
                            }}
                          >
                            이미지 크게 보기
                          </button>
                        )}
                      </div>
                      <p className="gs-fine">
                        원본과 결과는 이미 프로젝트 폴더에 저장되어 있습니다.
                        아래 파일에서 위치를 확인하고 복사할 수 있습니다.
                      </p>
                      <details
                        key={shownVersion.id}
                        open={shownVersion.files.length <= 2}
                      >
                        <summary>
                          원본·결과 파일과 저장 위치 (
                          {shownVersion.files.length})
                        </summary>
                        {shownVersion.files.map((file) => (
                          <div className="gs-file" key={file.path}>
                            <strong>{fileName(file.path)}</strong>
                            <code className="gs-file-path">{file.path}</code>
                            <span>
                              {file.bytes.toLocaleString()} bytes · {file.kind}
                            </span>
                            <div className="gs-file-actions">
                              <button
                                disabled={disabled}
                                onClick={() => void copyFileLocation(file.path)}
                              >
                                저장 경로 복사
                              </button>
                              {isImagePath(file.path) && (
                                <button
                                  onClick={() =>
                                    setFocusedImage({
                                      path: file.path,
                                      label: fileName(file.path),
                                    })
                                  }
                                >
                                  이미지 보기
                                </button>
                              )}
                            </div>
                            <details className="gs-file-hash">
                              <summary>SHA-256 확인</summary>
                              <code>{file.sha256}</code>
                            </details>
                          </div>
                        ))}
                        <p>
                          입력 버전:{" "}
                          {shownVersion.sourceVersionIds.join(", ") ||
                            "가져온 원본"}
                        </p>
                        {shownVersion.provenance.jobId && (
                          <p>작업: {shownVersion.provenance.jobId}</p>
                        )}
                      </details>
                      {!shownContact && !contactPartProducer && <button
                        data-testid="graphics-accept-version"
                        aria-label={shownAssembly ? '상세 결과에서 조립과 파트 함께 채택' : undefined}
                        disabled={
                          disabled || needsPartPreparation || shownAcceptanceComplete || !!shownImportProblem
                        }
                        onClick={() => adoptVersion(shownVersion)}
                      >
                        {shownAcceptanceComplete
                          ? "현재 채택 버전"
                          : needsPartSpaceRestoration ? '크기·위치 복원 후 채택'
                          : needsPartSourcePreparation ? '작업 원본 준비 후 채택'
                          : shownAssembly ? '이 조립과 파트 채택'
                          : `${roles[shownVersion.role]} / ${shownVersion.slot}에 채택`}
                      </button>}
                    </details>
                  )}
                  <details className="gs-version-history"><summary>이전 결과 · {versions.length}개</summary><div className="gs-version-list" aria-label="전체 버전">
                    {[...versions].reverse().map((version) => (
                      <button
                        key={version.id}
                        aria-pressed={shownVersion?.id === version.id}
                        data-testid={`graphics-version-${version.id}`}
                        className={
                          shownVersion?.id === version.id ? "is-active" : ""
                        }
                        onClick={() => showVersion(version)}
                      >
                        <span>
                          <strong>{version.label}</strong>
                          <small>
                            {roles[version.role]} / {version.slot} ·{" "}
                            {stamp(version.createdAt)}
                          </small>
                        </span>
                        {acceptedVersion(object, version) && (
                          <Check size={15} aria-label="채택됨" />
                        )}
                      </button>
                    ))}
                  </div></details>
                </section>

                <aside className="gs-guide" aria-label="현재 작업 안내" data-testid="graphics-guide">
                  {useAutoRig ? <div className="gs-guide-heading"><h2>{autoRigView.running ? '로컬 리깅 작업 진행 중' : autoRigView.candidate ? autoRigRun?.operation==='repair' ? '보정 결과를 확인하세요' : '움직임과 보정할 부위를 확인하세요' : '자동 리깅으로 움직임을 준비해요'}</h2><p>{autoRigView.candidate ? '중앙에서 검사용 동작을 재생하고, 마음에 들면 이 리그를 사용하세요.' : '전체 모델과 앞 방향을 확인하고 로컬 작업을 시작하세요.'}</p></div> : guideHeading}
                  <div className="gs-guide-scroll">
                  {stage === 'unity' && !fileExport && <section className="gs-guide-inputs" aria-label="현재 Unity 프로젝트">
                      <strong>현재 Unity 프로젝트</strong>
                      <p data-testid="graphics-unity-target-path">{unityTargetPath || '아직 선택하지 않았습니다. 프로젝트를 선택해 주세요.'}</p>
                      <button type="button" data-testid="graphics-change-unity-target" disabled={unityTargetLocked} onClick={openUnityTarget}>프로젝트 변경</button>
                      <small>{unityTargetLocked ? '진행 중이거나 승인·확인을 기다리는 작업과 전달을 완료하거나 취소한 뒤 변경하세요.' : '이 제작 프로젝트의 전달 대상입니다. 앱 기본 경로를 바꿔도 이 대상은 바뀌지 않습니다.'}</small>
                    </section>}
                    {error && <div role="alert" className="gs-alert gs-alert-error"><strong>요청을 완료하지 못했습니다.</strong><p>{error}</p><span>기존 원본과 사용하는 결과는 유지됩니다.</span></div>}
                    {stage === 'rig' && <div className="gs-file-actions" aria-label="리깅 방법"><button type="button" aria-pressed={!legacyRig} onClick={() => setLegacyRig(false)}>자동 리깅 · 권장</button><button type="button" aria-pressed={legacyRig} onClick={() => setLegacyRig(true)}>기타 도구 · Blender + Astra</button></div>}
                    {useAutoRig ? autoRigPanel : <>
                    {approvalCards}
                    {active || journey?.task?.status === 'failed' || journey?.task?.status === 'submission_unknown' ? currentJobs : <details className="gs-recent-status"><summary>최근 작업 상태와 복구</summary>{currentJobs}</details>}
                    {guideInputs}
                    {stage === 'unity' && !fileExport && shownUnityDelivery && <section className="gs-guide-inputs" aria-label="Unity 전달 확인">
                      <strong>{queuedUnityOpen ? '현재 요청 · Unity 가져오기 대기' : deliveryCurrent ? '현재 결과 가져오기 완료' : '이전 전달 기록 · 현재 원본과 다시 확인 필요'}</strong>
                      {currentDeliveryMessage && <p className="gs-fine" data-testid="graphics-unity-delivery-message">{currentDeliveryMessage}</p>}
                      <p>{shownUnityDelivery.prefabPath ?? shownUnityDelivery.destination}</p>
                      {queuedUnityOpen&&<p data-testid="graphics-unity-queued-target">{queuedUnityOpen.target.projectPath}</p>}
                      <p>{shownUnityDelivery.playbackVerified ? '재생 검사 기록 있음' : 'Play Mode 재생 검사는 별도입니다.'}</p>
                      <small>{shownUnityDelivery.status === 'imported' ? 'Unity에서 확인된 가져오기 기록' : '파일 준비와 Unity 가져오기 완료는 다릅니다.'}</small>
                    </section>}
                    <section className="gs-instruction" aria-label="현재 작업 설정">
                  {["model", "unity"].includes(stage) && <GraphicsSizePanel key={object.id} value={creation.physicalSize} bounds={!shownVersion?.slot.startsWith("part-") && shownVersion?.files.some(file => /\.glb$/i.test(file.path)) ? modelBounds : undefined} restricted={object.kind === "character" || Boolean(modelBounds?.hasSkin || modelBounds?.hasMorph || modelBounds?.hasAnimation)} disabled={disabled || active} onValidityChange={setSizeInputsValid} onChange={physicalSize => setCreation(current => ({ ...current, physicalSize }))} onSave={() => void run({ kind: "update-object", objectId: object.id, patch: { creation } }, "크기 설정을 저장했습니다. 새 생성은 없습니다.")} onApply={creation.attributes.composition !== "parts" && (object.accepted["model:main"] || object.accepted["rig:main"]) ? () => void prepareSizeCopy() : undefined} />}
                  {stage === 'surface' && <section className="gs-result-notes" aria-label="재질 작업의 원본과 UV" data-testid="graphics-surface-input">
                    <strong>이번 작업에 사용할 채택 모델</strong>
                    <p data-testid="graphics-surface-input-model" data-version-id={surfaceModel?.id ?? ''}>{surfaceModel?.label ?? '모델을 먼저 채택하세요.'}{texturePart ? ` · ${texturePart.label}` : ''}</p>
                    <small>미리보기에서 결과를 보기만 해서는 실행 원본이 바뀌지 않습니다.</small>
                    {pendingSurfaceUvs.length > 0 && <div data-testid="graphics-pending-uv-results">
                      <strong>현재 모델로 만든 UV 결과가 아직 채택되지 않았습니다</strong>
                      <p>UV 결과를 확인하고 ‘이 모델 채택’을 눌러야 다음 텍스처 요청에 그 UV가 사용됩니다.</p>
                      {pendingSurfaceUvs.map(version => <div className="gs-file-actions" key={version.id}>
                        <span>{version.label}</span>
                        <button type="button" data-testid={`graphics-view-pending-uv-${version.id}`} onClick={() => showVersion(version)}>이 UV 결과 보기</button>
                      </div>)}
                    </div>}
                    <p>새 면을 추가했거나 UV가 없는 모델은 <b>UV 생성 → 결과 채택 → 텍스처 생성</b> 순서로 진행하세요.</p>
                    {settings.surfaceOperation !== 'uv' && <small>현재 선택은 텍스처·재질 작업입니다. UV를 새로 만들려면 아래 ‘UV 준비’를 선택해 먼저 실행하세요. 텍스처 실행이 UV 준비를 대신 실행하지 않습니다.</small>}
                  </section>}
                  <CreationOptions
                    taskId={unityOperationTaskId}
                    autoRigFileExport={autoRigFileExport}
                    kind={object.kind}
                    spec={creation}
                    stage={stage}
                    settings={settings}
                    partStatus={partStatus}
                    disabled={disabled}
                    onChange={changeCreation}
                    onSetting={setting}
                  />
                  {taskId === "T03" && (
                    <div
                      className="gs-reference-strip"
                      data-testid="graphics-texture-reference"
                    >
                      {settings.textureReference !== "text" &&
                        textureReferenceImage && (
                          <img
                            className="gs-reference-thumb"
                            src={window.desktop.assetUrl(
                              project.id,
                              textureReferenceImage.path,
                            )}
                            alt={`텍스처 참조 · ${textureDesign!.label}`}
                            data-version-id={textureDesign!.id}
                          />
                        )}
                      <div>
                        <strong>다음 텍스처 요청의 참조</strong>
                        {settings.textureReference === "text" ? (
                          <span className="gs-fine">
                            설명만 전송합니다. 채택 이미지는 텍스처 생성에
                            사용하지 않습니다.
                          </span>
                        ) : textureReferenceImage ? (
                          <>
                            <span>
                              {textureDesign!.label}
                              {texturePart ? ` · ${texturePart.label}` : ""}
                            </span>
                            <span className="gs-fine">
                              이 이미지의 색과 무늬를 참고합니다. Tripo API는
                              이미지와 설명 중 하나만 받으므로 이미지만
                              전송하며, 추가 지시는 작업 기록에 보존합니다.
                            </span>
                          </>
                        ) : (
                          <span className="gs-fine">
                            {texturePart
                              ? `${texturePart.label} 파츠에`
                              : "현재 오브젝트에"}{" "}
                            채택한 디자인 이미지가 없습니다.
                            {texturePart ? ' 파츠 참조를 채택하거나 입력을 설명만 사용으로 변경하세요. 전체 이미지를 대신 사용하지 않습니다.' : ' 설명만 전송합니다. 이미지의 색과 무늬를 참고하려면 디자인을 먼저 채택하세요.'}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="gs-section-title">
                    <h3>이번 단계 설정</h3>
                    <span className={`gs-tag gs-${activeTask.status}`}>
                      {statusLabels[activeTask.status]}
                    </span>
                  </div>
                  <details className="gs-execution-detail">
                    <summary>사용할 제작 기능과 지원 범위</summary>
                    <div className="gs-task-heading">
                      <span>{activeTask.id}</span>
                      <h3>{activeTask.name}</h3>
                    </div>
                    <p className="gs-muted">입력: {activeTask.inputs}</p>
                    <p className="gs-muted">확인할 결과: {activeTask.output}</p>
                    {activeTask.reason && (
                      <p className="gs-capability-reason">
                        {activeTask.reason}
                      </p>
                    )}
                  </details>
                  <details className="gs-import-details">
                    <summary>이미 가진 이미지 · 모델 · 동작 가져오기</summary>
                    <label htmlFor="gs-import-role">가져올 자료의 역할</label>
                    <div className="gs-import-row">
                      <select
                        id="gs-import-role"
                        value={importRole}
                        onChange={(event) =>
                          setImportRole(event.target.value as GraphicsRole)
                        }
                      >
                        {Object.entries(roles).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <button
                        data-testid="graphics-import"
                        disabled={disabled}
                        onClick={() => void importSource()}
                      >
                        <FolderInput size={14} /> 파일 가져오기
                      </button>
                    </div>
                    {['model', 'material', 'rig', 'unity'].includes(importRole) && <p className="gs-fine" data-testid="graphics-import-model-help">3D 파일은 하나씩 별도 후보로 가져옵니다. 모델과 함께 쓸 이미지·MTL 파일은 같은 폴더에서 선택하세요. 여러 모델을 자동으로 조립하거나 사용하지 않습니다.</p>}
                    {["animation", "motion-reference"].includes(importRole) && (
                      <label>
                        {importRole === "animation"
                          ? "가져올 원본의 Action 이름"
                          : "영상이 참조할 클립 이름"}
                        <input
                          aria-label={
                            importRole === "animation"
                              ? "가져올 Action 이름"
                              : "영상 참조 클립 이름"
                          }
                          placeholder="Rabbit_Idle"
                          value={clipNameDraft}
                          onChange={(event) =>
                            setClipNameDraft(event.target.value)
                          }
                          onBlur={(event) => setClipName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter")
                              event.currentTarget.blur();
                          }}
                        />
                        <span className="gs-fine">
                          {importRole === "animation"
                            ? "편집 가능한 .blend 원본의 정확한 Action 이름을 적으세요. 이 이름의 클립으로 보관하며, 수정 전에 실제 Action 존재를 검사합니다."
                            : "실제 영상 원본을 이 클립의 동작 참조로 보관합니다. 가져온 뒤 내용을 확인하고 채택해야 3D 동작에 사용합니다."}
                        </span>
                      </label>
                    )}
                  </details>
                  <label htmlFor="gs-instruction">
                    이 단계 추가 지시 · 선택지에 없는 내용
                  </label>
                  <textarea
                    id="gs-instruction"
                    rows={4}
                    placeholder={
                      object.kind === "weapon"
                        ? "예: 연결한 캐릭터의 문양과 색을 살린 대검. 캐릭터 원본은 유지."
                        : "바꿀 부분과 유지할 부분을 적어 주세요."
                    }
                    value={instruction}
                    onChange={(event) => setInstruction(event.target.value)}
                    maxLength={12000}
                  />
                  {taskId === "I06" && (
                    <label>
                      장비 결과
                      <select
                        aria-label="장비 결과"
                        value={String(settings.equipmentOutput ?? "standalone")}
                        onChange={(event) =>
                          setting("equipmentOutput", event.target.value)
                        }
                      >
                        <option value="standalone">장비만 독립 이미지로</option>
                        <option value="worn">
                          캐릭터가 착용한 참고 이미지로
                        </option>
                      </select>
                      <span className="gs-fine">
                        외형 참고를 연결하세요. 참고 캐릭터는 보존되고 결과는
                        현재 오브젝트에 저장됩니다.
                      </span>
                    </label>
                  )}
                  {taskId === "I07" && (
                    <div className="gs-multiview">
                      <h3>생성할 방향</h3>
                      <div className="gs-settings-grid">
                        {[
                          ["viewFront", "정면"],
                          ["viewBack", "후면"],
                          ["viewLeft", "좌측"],
                          ["viewRight", "우측"],
                        ].map(([key, label]) => (
                          <label key={key}>
                            <input
                              type="checkbox"
                              checked={settings[key] !== false}
                              onChange={(event) =>
                                setting(key, event.target.checked)
                              }
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                      <p className="gs-fine">
                        방향별 독립 원본을 한 요청으로 만듭니다. 후보 개수는
                        방향마다 적용되며, 출력은 직접 확인한 뒤 모델링 입력에
                        지정하세요.
                      </p>
                    </div>
                  )}
                  {motionTask && (
                    <div className="gs-multiview">
                      <h3>동작과 참조</h3>
                      <label>
                        기존 클립 설정 불러오기
                        <select
                          aria-label="기존 클립 설정"
                          value={String(settings.clipName ?? "")}
                          onChange={(event) => setClipName(event.target.value)}
                        >
                          {[
                            ...new Set([
                              String(settings.clipName ?? ""),
                              ...Object.keys(creation.clipSettings ?? {}),
                              ...versions
                                .filter((version) =>
                                  ["animation", "motion-reference"].includes(
                                    version.role,
                                  ),
                                )
                                .map((version) => version.slot),
                            ]),
                          ]
                            .filter(Boolean)
                            .map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                        </select>
                      </label>
                      <p className="gs-fine">
                        클립을 바꾸면 해당 클립의 설정을 불러옵니다. 원본·채택
                        결과는 바뀌지 않으며, 새 이름을 입력하면 새 클립 설정을
                        시작합니다.
                      </p>
                      <div className="gs-settings-grid">
                        <label>
                          클립 이름
                          <input
                            aria-label="클립 이름"
                            value={clipNameDraft}
                            placeholder="Rabbit_Idle"
                            onChange={(event) =>
                              setClipNameDraft(event.target.value)
                            }
                            onBlur={(event) => setClipName(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter")
                                event.currentTarget.blur();
                            }}
                          />
                        </label>
                        <label>
                          길이 (초)
                          <input
                            aria-label="동작 길이"
                            type="number"
                            min={1}
                            max={taskId === "N02" ? 10 : 30}
                            value={String(settings.duration ?? 2)}
                            onChange={(event) =>
                              setting("duration", Number(event.target.value))
                            }
                          />
                        </label>
                        <label>
                          3D 프레임 속도
                          <select
                            aria-label="3D 프레임 속도"
                            value={String(settings.fps ?? 30)}
                            onChange={(event) =>
                              setting("fps", Number(event.target.value))
                            }
                          >
                            {[24, 30, 60].map((fps) => (
                              <option key={fps} value={fps}>
                                {fps} fps
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={settings.loop === true}
                            onChange={(event) =>
                              setting("loop", event.target.checked)
                            }
                          />
                          반복 동작
                        </label>
                      </div>
                      {taskId === "N02" && (
                        <>
                          <label>
                            영상 입력 원본
                            <select
                              aria-label="영상 입력 원본"
                              value={String(
                                settings.motionSourceVersionId ?? "",
                              )}
                              onChange={(event) => {
                                setting(
                                  "motionSourceVersionId",
                                  event.target.value,
                                );
                                const v = videoSources.find(
                                  (v) => v.id === event.target.value,
                                );
                                setting(
                                  "motionSourcePath",
                                  v?.files.find((f) => /\.png$/i.test(f.path))
                                    ?.path ?? "",
                                );
                              }}
                            >
                              <option value="">채택한 측면 PNG 선택</option>
                              {videoSources.map((v) => (
                                <option key={v.id} value={v.id}>
                                  {v.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            측면 방향
                            <select
                              aria-label="영상 측면 방향"
                              value={String(
                                settings.motionSourceView ?? "left",
                              )}
                              onChange={(event) =>
                                setting("motionSourceView", event.target.value)
                              }
                            >
                              <option value="left">왼쪽</option>
                              <option value="right">오른쪽</option>
                            </select>
                          </label>
                          <label>
                            사용할 이미지 파일
                            <select
                              aria-label="영상 원본 파일"
                              value={String(settings.motionSourcePath ?? "")}
                              onChange={(event) =>
                                setting("motionSourcePath", event.target.value)
                              }
                            >
                              <option value="">이미지 파일 선택</option>
                              {videoSources
                                .find(
                                  (v) =>
                                    v.id === settings.motionSourceVersionId,
                                )
                                ?.files.filter((f) => /\.png$/i.test(f.path))
                                .map((f) => (
                                  <option key={f.path} value={f.path}>
                                    {fileName(f.path)}
                                  </option>
                                ))}
                            </select>
                          </label>
                          <p className="gs-fine">
                            Runway · 720p · 16:9 전신 여백. 기존 이미지와 실제
                            생성 영상은 따로 보존합니다. 생성 전 예상 비용을
                            확인하고 실행하세요.
                          </p>
                        </>
                      )}
                      <p className="gs-fine">
                        클립별로 채택합니다. 영상 참조를 채택한 뒤 같은 클립
                        이름으로 ‘참조 기반 3D 동작’을 실행하세요. 기존 동작
                        수정은 채택한 애니메이션과 원래 참조를 이어 사용합니다.
                      </p>
                    </div>
                  )}
                  {taskId === "N01" && (
                    <label>
                      모델의 좌우 축
                      <select
                        aria-label="모델 좌우 축"
                        value={String(settings.motionSourceAxis ?? "X")}
                        onChange={(event) =>
                          setting("motionSourceAxis", event.target.value)
                        }
                      >
                        <option value="X">X축 기준 좌·우</option>
                        <option value="Y">Y축 기준 좌·우</option>
                      </select>
                      <span className="gs-fine">
                        2048px 전신 렌더 2장을 만들고 직접 선택합니다. 기존
                        디자인 원본을 교체하지 않습니다.
                      </span>
                    </label>
                  )}
                  {["R01", "R02", "R03"].includes(taskId) && (
                    <div className="gs-multiview">
                      <h3>리깅할 부위</h3>
                      <p className="gs-fine">
                        몸통과 팔다리는 기본으로 처리합니다. 필요한 보조 부위만
                        추가하세요.
                      </p>
                      <div className="gs-settings-grid">
                        {[
                          ["rigEars", "귀"],
                          ["rigTail", "꼬리"],
                          ["rigHair", "머리카락"],
                          ["rigClothing", "옷"],
                          ["rigWings", "날개"],
                          ["rigAccessories", "장비·소품"],
                        ].map(([key, label]) => (
                          <label key={key}>
                            <input
                              type="checkbox"
                              checked={settings[key] === true}
                              onChange={(event) =>
                                setting(key, event.target.checked)
                              }
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  {graphicsAstraTasks.has(taskId) && (
                    <p className="gs-fine">
                      Blender + Astra가 채택한 원본을 새 버전으로 수정합니다.
                      결과를 채택하기 전까지 이전 버전이 유지됩니다.
                    </p>
                  )}
                  {usesModelMultiview(activeTask.id, settings) && (
                    <div className="gs-multiview">
                      <h3>네 방향의 실제 입력</h3>
                      <p className="gs-fine">
                        각 이미지의 실제 방향을 직접 지정합니다. 좌우를 자동으로
                        교환하지 않습니다.
                      </p>
                      <div className="gs-settings-grid">
                        {directions.map(([value, label]) => (
                          <label key={value}>
                            {label} 원본
                            <select
                              aria-label={`${label} 원본`}
                              value={String(
                                settings[`${value}VersionId`] ?? "",
                              )}
                              onChange={(event) =>
                                setting(`${value}VersionId`, event.target.value)
                              }
                            >
                              <option value="">이미지 선택</option>
                              {imageVersions.map((version) => (
                                <option value={version.id} key={version.id}>
                                  {
                                    workspace?.objects.find(
                                      (item) => item.id === version.objectId,
                                    )?.name
                                  }{" "}
                                  / {version.label}
                                </option>
                              ))}
                            </select>
                          </label>
                        ))}
                      </div>
                      {multiviewProblem && (
                        <p className="gs-warning">{multiviewProblem}</p>
                      )}
                    </div>
                  )}
                  <div className="gs-settings-grid">
                    {multipleOutputs &&
                      !(
                        stage === "model" &&
                        creationCompositionStrategy(creation) === "independent-parts"
                      ) && (
                        <label>
                          {taskId === "I07" ? "방향별 후보 개수" : "후보 개수"}
                          <input
                            aria-label="후보 개수"
                            type="number"
                            min={1}
                            max={4}
                            disabled={!multipleOutputs}
                            value={String(
                              multipleOutputs ? (settings.count ?? 1) : 1,
                            )}
                            onChange={(event) =>
                              setting("count", Number(event.target.value))
                            }
                          />
                        </label>
                      )}
                    {stage === "surface" &&
                      settings.surfaceOperation !== "uv" && (
                        <label>
                          텍스처 목표 품질
                          <select
                            aria-label="텍스처 해상도"
                            value={String(settings.textureSize ?? 4096)}
                            onChange={(event) =>
                              setting("textureSize", Number(event.target.value))
                            }
                          >
                            {settings.textureSize !== undefined &&
                              ![2048, 4096, 8192].includes(
                                Number(settings.textureSize),
                              ) && (
                                <option value={String(settings.textureSize)}>
                                  {String(settings.textureSize)}px · 저장된 설정
                                  (현재 API 미지원)
                                </option>
                              )}
                            {[2048, 4096, 8192].map((size) => (
                              <option key={size} value={size}>
                                {size === 2048
                                  ? "Standard · 2K 목표"
                                  : size === 4096
                                    ? "Detailed · 4K 목표"
                                    : "Extreme · 8K"}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    {stage === "unity" && (
                      <>
                        <label>
                          출력 형식
                          <select
                            aria-label="출력 형식"
                            value={String(settings.exportFormat ?? "both")}
                            onChange={(event) =>
                              setting("exportFormat", event.target.value)
                            }
                          >
                            <option value="both">{autoRigFileExport ? 'FBX + 변형 검사용 GLB' : 'FBX + GLB'}</option>
                            <option value="fbx">FBX</option>
                            <option value="glb" disabled={autoRigFileExport}>{autoRigFileExport ? 'GLB만 · 자동 리그는 지원하지 않음' : 'GLB'}</option>
                          </select>
                        </label>
                      </>
                    )}
                  </div>
                  {activeTask.id === "T03" && (
                    <p className="gs-fine">
                      API 품질 설정을 사용하며 반환된 원본의 실제 픽셀 크기는
                      결과에서 확인합니다. 요청 크기로 강제 확대하지 않습니다.
                    </p>
                  )}
                  <details className="gs-multiview">
                    <summary>Tripo API 누적 승인 한도</summary>
                    <p>
                      이 프로젝트 승인 누적{" "}
                      {workspace ? graphicsTripoReserved(workspace) : 0} /{" "}
                      {workspace?.tripoBudget?.limit ?? "미설정"} 크레딧
                    </p>
                    <label>
                      한도 (API 크레딧)
                      <input
                        aria-label="Tripo API 한도"
                        type="number"
                        min={0}
                        max={100000}
                        value={budget}
                        onChange={(event) =>
                          setBudget(Number(event.target.value))
                        }
                      />
                    </label>
                    <button
                      disabled={disabled}
                      onClick={() =>
                        void run(
                          { kind: "set-tripo-budget", credits: budget },
                          "Tripo 승인 한도를 저장했습니다.",
                        )
                      }
                    >
                      한도 저장
                    </button>
                    <p className="gs-fine">
                      한도 설정만으로 생성하지 않습니다. 실행 시 비용을 별도로
                      확인하며, 중단·불명확한 제출 비용도 한도에 남겨 중복
                      결제를 방지합니다. 실제 청구 잔액과 구분됩니다.
                    </p>
                  </details>
                  {modelProblem && (
                    <p role="alert" className="gs-warning">
                      {modelProblem}
                    </p>
                  )}
                  {["M01", "M02", "M03"].includes(activeTask.id) && (
                    <p className="gs-warning">
                      선택한 모델·입력·후보 개수에 맞는 API 견적을 실행 전에
                      확인합니다. Studio 구독과 별도이며 이 화면의 선택만으로
                      과금하지 않습니다.
                    </p>
                  )}
                  <p className="gs-fine">
                    이미지 제작은 기존 Codex 모델·추론 설정을 유지합니다. 요청
                    설정은 지원과 입력을 확인한 후 고정됩니다. 가져온 원본의
                    해상도와 품질 설정은 자동으로 낮추지 않습니다.
                  </p>
                  {active && (
                    <p className="gs-warning">
                      진행 중이거나 확인이 필요한 작업이 있습니다. 위 실행
                      영역이나 더 보기의 작업 기록을 확인하세요.
                    </p>
                  )}
                    </section>
                    <details className="gs-request-summary"><summary>선택한 조건과 실행 정보</summary>{executionSummary}</details>
                    <details className="gs-request-summary"><summary>제작 설정 저장</summary>{optionsSummary}</details>
                    </>}
                  </div>
                  {useAutoRig ? <footer className="gs-guide-footer"><div className="gs-auto-rig-primary" ref={setAutoRigFooterHost} /><small>Auto-Rig Pro · 로컬 작업 · 채택과 Unity 내보내기는 직접 실행</small><button type="button" onClick={openImportPanel}>기존 모델·리그 가져오기</button></footer> : guideFooter}
                </aside>
              </div>

              <details className="gs-references-disclosure"><summary>참고 자료 연결 · 다른 결과의 외형과 스타일 사용</summary><section className="gs-references">
                <div className="gs-section-title">
                  <h2>참고 자료 연결</h2>
                  <span>대상 원본 유지</span>
                </div>
                <div className="gs-reference-form">
                  <label>
                    참고 버전
                    <select
                      id="gs-reference-version"
                      data-testid="graphics-reference-version"
                      value={referenceId}
                      onChange={(event) => setReferenceId(event.target.value)}
                    >
                      <option value="">버전을 선택하세요</option>
                      {workspace?.versions.map((version) => (
                        <option key={version.id} value={version.id}>
                          {
                            workspace.objects.find(
                              (item) => item.id === version.objectId,
                            )?.name
                          }{" "}
                          / {version.label} · {roles[version.role]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    참고 역할
                    <select
                      aria-label="참고 역할"
                      value={referenceRole}
                      onChange={(event) =>
                        setReferenceRole(
                          event.target
                            .value as GraphicsObject["references"][number]["role"],
                        )
                      }
                    >
                      {Object.entries(referenceRoles).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    disabled={
                      disabled ||
                      !referenceId ||
                      object.references.some(
                        (reference) =>
                          reference.versionId === referenceId &&
                          reference.role === referenceRole,
                      )
                    }
                    onClick={() =>
                      void run({
                        kind: "update-object",
                        objectId: object.id,
                        patch: {
                          references: [
                            ...object.references,
                            { versionId: referenceId, role: referenceRole },
                          ],
                        },
                      })
                    }
                  >
                    참고 연결
                  </button>
                </div>
                {object.references.length === 0 && (
                  <p className="gs-muted">
                    다른 오브젝트의 자료도 외형·스타일·동작·치수 참고로 연결할
                    수 있습니다.
                  </p>
                )}
                <div className="gs-reference-list">
                  {object.references.map((reference) => {
                    const version = workspace?.versions.find(
                      (item) => item.id === reference.versionId,
                    );
                    return (
                      <div key={`${reference.versionId}-${reference.role}`}>
                        {version?.files.find((file) =>
                          isImagePath(file.path),
                        ) && (
                          <img
                            className="gs-reference-thumb"
                            alt={`${version.label} 참고 원본`}
                            src={window.desktop.assetUrl(
                              project.id,
                              version.files.find((file) =>
                                isImagePath(file.path),
                              )!.path,
                            )}
                          />
                        )}
                        <span>
                          <strong>
                            {version?.label ?? "찾을 수 없는 버전"}
                          </strong>
                          <small>
                            {referenceRoles[reference.role]} ·{" "}
                            {
                              workspace?.objects.find(
                                (item) => item.id === version?.objectId,
                              )?.name
                            }
                          </small>
                        </span>
                        <button
                          disabled={disabled}
                          aria-label={`${version?.label ?? reference.versionId} 참고 연결 해제`}
                          onClick={() =>
                            void run({
                              kind: "update-object",
                              objectId: object.id,
                              patch: {
                                references: object.references.filter(
                                  (item) => item !== reference,
                                ),
                              },
                            })
                          }
                        >
                          해제
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section></details>
            </>
          )}

          <details className="gs-diagnostics-disclosure"><summary>연결 진단 · Unity 상태 · 사용량</summary><div className="gs-bottom-grid">
            <section className="gs-target">
              <div className="gs-section-title">
                <h2>연결 상태</h2>
                <button
                  disabled={disabled}
                  onClick={() => void run({ kind: "probe-connections" })}
                >
                  연결 진단
                </button>
              </div>
              <p className="gs-fine">
                도구·경로·연결 메타데이터만 확인합니다. 진단은 GPT 또는 생성
                요청을 만들지 않습니다.
              </p>
              <p className="gs-fine">
                연결 확인은 생성 성공을 뜻하지 않습니다. Tripo API 크레딧과
                Studio 구독 잔액은 별도입니다. 각 기능의 실제 지원 범위는 지원
                현황에서 확인하세요.
              </p>
              {workspace?.connections?.map((connection) => (
                <div className="gs-connection" key={connection.name}>
                  <div>
                    <strong>{connection.name}</strong>
                    <span
                      className={`gs-tag ${connection.available ? "gs-ready" : "gs-unverified"}`}
                    >
                      {connection.available ? "메타데이터 확인" : "확인 필요"}
                    </span>
                  </div>
                  <p className="gs-muted">{connection.message}</p>
                  <small>{stamp(connection.checkedAt)}</small>
                </div>
              ))}
              <div className="gs-section-title">
                <h2>Unity 대상</h2>
                <button
                  disabled={disabled}
                  onClick={() => void run({ kind: "inspect-target" })}
                >
                  프로젝트 검사
                </button>
              </div>
              <p className="gs-fine">현재 제작 프로젝트의 전달 대상: {unityTargetPath || '선택 전'}. Unity 전달 단계의 ‘프로젝트 변경’에서 저장하세요. 연결 설정의 기본 경로는 현재 프로젝트 대상을 바꾸지 않습니다.</p>
              {workspace?.target ? (
                <>
                  <strong>{workspace.target.projectPath}</strong>
                  <p>
                    Unity {workspace.target.unityVersion} ·{" "}
                    {workspace.target.pipeline.toUpperCase()} · PC
                  </p>
                  <small>검사 {stamp(workspace.target.inspectedAt)}</small>
                  {workspace.target.warnings.map((warning, index) => (
                    <p className="gs-warning" key={index}>
                      {warning}
                    </p>
                  ))}
                  <details>
                    <summary>
                      설치 패키지{" "}
                      {Object.keys(workspace.target.packages).length}개
                    </summary>
                    {Object.entries(workspace.target.packages).map(
                      ([name, version]) => (
                        <p key={name}>
                          {name} · {version}
                        </p>
                      ),
                    )}
                  </details>
                </>
              ) : (
                <p className="gs-muted">
                  연결 설정의 Unity 프로젝트를 검사하면 버전·렌더
                  파이프라인·패키지를 확인합니다.
                </p>
              )}
              {workspace?.deliveries
                .filter((delivery) => delivery.objectId === objectId)
                .map((delivery) => (
                  <div className="gs-delivery" key={delivery.id}>
                    <strong>
                      {delivery.status === "imported"
                        ? "에셋 가져오기 완료"
                        : delivery.status === "failed"
                          ? "가져오기 실패"
                          : delivery.status === "conflict"
                            ? "파일 충돌 확인 필요"
                            : "가져오기 대기"}
                    </strong>
                    <p>{delivery.destination}</p>
                    <p>
                      {delivery.playbackVerified
                        ? "실제 재생 확인됨"
                        : "실제 재생은 확인되지 않았습니다."}
                    </p>
                    {[...delivery.warnings, ...delivery.errors].map(
                      (message, index) => (
                        <p className="gs-warning" key={index}>
                          {message}
                        </p>
                      ),
                    )}
                  </div>
                ))}
            </section>
            <section className="gs-usage">
              <div className="gs-section-title">
                <h2>실행 사용량</h2>
                <button
                  disabled={disabled}
                  onClick={() => void run({ kind: "audit-usage" })}
                >
                  사용량 확인
                </button>
              </div>
              {workspace?.usage ? (
                <>
                  <div className="gs-usage-values">
                    <span>
                      입력{" "}
                      <strong>
                        {workspace.usage.inputTokens.toLocaleString()}
                      </strong>
                    </span>
                    <span>
                      캐시 입력{" "}
                      <strong>
                        {workspace.usage.cachedInputTokens.toLocaleString()}
                      </strong>
                    </span>
                    <span>
                      비캐시 입력{" "}
                      <strong>
                        {workspace.usage.uncachedInputTokens.toLocaleString()}
                      </strong>
                    </span>
                    <span>
                      출력{" "}
                      <strong>
                        {workspace.usage.outputTokens.toLocaleString()}
                      </strong>
                    </span>
                  </div>
                  <p className="gs-fine">
                    확인한 작업 {workspace.usage.sampledJobs}개 · 측정된 실행{" "}
                    {workspace.usage.measuredWorkers}개 · 측정 누락{" "}
                    {workspace.usage.missingWorkers}개 · 로컬 실행{" "}
                    {workspace.usage.localExecutions}개
                  </p>
                  {workspace.usage.findings.map((finding, index) => (
                    <p
                      className={
                        finding.severity === "warning"
                          ? "gs-warning"
                          : "gs-muted"
                      }
                      key={index}
                    >
                      {finding.message}
                    </p>
                  ))}
                </>
              ) : (
                <p className="gs-muted">
                  저장된 실제 실행 기록에서 토큰과 로컬 실행을 집계합니다. 계정
                  잔여 한도나 추정 절감률을 뜻하지 않습니다.
                </p>
              )}
            </section>
          </div></details>
        </main>
      </div>
      {(legacyPreview || unlinkObject) && (
        <dialog
          ref={legacyDialog}
          className="gs-aux-dialog gs-legacy-dialog"
          aria-label={
            legacyPreview ? "연결할 기존 자료 선택" : "기존 오브젝트 연결 해제"
          }
          onCancel={(event) => {
            event.preventDefault();
            closeLegacyDialog();
          }}
        >
          <header>
            <h2>
              {legacyPreview
                ? "연결할 기존 자료 선택"
                : "기존 오브젝트 연결 해제"}
            </h2>
            <button autoFocus disabled={pending} onClick={closeLegacyDialog}>
              <X size={15} /> 취소
            </button>
          </header>
          <div className="gs-aux-body">

            {error && (
              <p className="gs-error" role="alert">
                {error}
              </p>
            )}
            {legacyPreview ? (
              <>
                <p>
                  현재 프로젝트 ‘{project.name}’에 저장된 기존 자료입니다.
                  선택한 자료를 ‘{legacyPreview.objectName}’ 오브젝트에
                  연결합니다.
                </p>
                <p className="gs-muted">
                  원본 파일은 그대로 보관하며, 연결 후 사용할 버전을 직접 채택할
                  수 있습니다.
                </p>
                {!legacyPreview.versions.length && (
                  <p>
                    새로 연결할 수 있는 자료가 없습니다. 이미 연결했거나 원본
                    파일을 확인할 수 없는 자료는 제외됩니다.
                  </p>
                )}
                <div className="gs-legacy-candidates">
                  {legacyPreview.versions.map((version) => {
                    const thumbnail = version.files.find((file) =>
                      /\.(png|jpe?g|webp)$/i.test(file.path),
                    );
                    return (
                      <label className="gs-legacy-candidate" key={version.id}>
                        <input
                          type="checkbox"
                          aria-label={`${version.label} 연결`}
                          disabled={disabled}
                          checked={legacySelection.includes(version.id)}
                          onChange={(event) =>
                            setLegacySelection((current) =>
                              event.target.checked
                                ? [...current, version.id]
                                : current.filter((id) => id !== version.id),
                            )
                          }
                        />
                        {thumbnail && (
                          <img
                            alt={version.label}
                            src={window.desktop.assetUrl(
                              project.id,
                              thumbnail.path,
                            )}
                          />
                        )}
                        <span>
                          <strong>{version.label}</strong>
                          <small>
                            {roles[version.role]} · {version.files.length}개
                            파일 · {stamp(version.createdAt)}
                          </small>
                          {version.files.map((file) => (
                            <small className="gs-file-path" key={file.path}>
                              {file.path}
                            </small>
                          ))}
                        </span>
                      </label>
                    );
                  })}
                </div>
                <button
                  className="gs-primary"
                  data-testid="graphics-confirm-legacy-link"
                  disabled={disabled || !legacySelection.length}
                  onClick={async () => {
                    if (
                      await run(
                        {
                          kind: "import-legacy",
                          versionIds: legacySelection,
                          fingerprint: legacyPreview.fingerprint,
                        },
                        "선택한 기존 자료를 연결했습니다.",
                      )
                    )
                      setLegacyPreview(undefined);
                  }}
                >
                  선택한 {legacySelection.length}개 자료 연결
                </button>
              </>
            ) : (
              unlinkObject && (
                <>
                  <strong>{unlinkObject.name}</strong>
                  <p>
                    이 오브젝트와 연결된{" "}
                    {workspace?.versions.filter(
                      (version) => version.objectId === unlinkObject.id,
                    ).length ?? 0}
                    개 버전을 현재 제작실 목록에서 제거합니다.
                  </p>
                  <p>
                    원본 파일과 기존 프로젝트의 작업 기록은 보관됩니다. 필요하면
                    기존 프로젝트 자료 연결에서 다시 선택할 수 있습니다.
                  </p>
                  {unlinkProblem && (
                    <p className="gs-warning" role="alert">
                      {unlinkProblem}
                    </p>
                  )}
                  <button
                    data-testid="graphics-confirm-legacy-unlink"
                    disabled={disabled || !!unlinkProblem}
                    onClick={async () => {
                      if (
                        await run(
                          { kind: "unlink-legacy", objectId: unlinkObject.id },
                          "기존 오브젝트의 연결을 해제했습니다. 원본 자료는 보관됩니다.",
                        )
                      )
                        setUnlinkObjectId(undefined);
                    }}
                  >
                    이 오브젝트 연결 해제
                  </button>
                </>
              )
            )}
          </div>
        </dialog>
      )}
      {auxiliary && (
        <dialog
          ref={auxiliaryDialog}
          className="gs-aux-dialog"
          aria-label={auxiliary === "storage" ? "저장 공간 현황" : auxiliary === "history" ? "작업 기록" : "기능 지원 현황"}
          onCancel={(event) => {
            event.preventDefault();
            setAuxiliary(undefined);
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) setAuxiliary(undefined);
          }}
        >
          <header>
            <h2>{auxiliary === "storage" ? "저장 공간 현황" : auxiliary === "history" ? "작업 기록" : "기능 지원 현황"}</h2>
            <button
              autoFocus
              aria-label="보조 화면 닫기"
              onClick={() => setAuxiliary(undefined)}
            >
              <X size={15} /> 닫기
            </button>
          </header>
          <div className="gs-aux-body">
            {auxiliary === "storage" && <GraphicsStoragePanel onAction={onAction} />}
            {auxiliary === "support" && notice && (
              <p className="gs-notice" role="status">
                {notice}
              </p>
            )}
            {auxiliary === "support" && (
              <section className="gs-catalog">
                <div className="gs-section-title">
                  <h2>제작 기능 지원 현황</h2>
                  <span>
                    {filteredTasks.length} / {graphicsCatalog.length}
                  </span>
                </div>
                <div className="gs-availability" aria-label="작업 지원 범위">
                  <span>
                    <b className="gs-tag gs-ready">
                      사용 가능 {availabilityCounts.ready}
                    </b>{" "}
                    표시된 로컬 지원 범위 검증
                  </span>
                  <span>
                    <b className="gs-tag gs-unverified">
                      실제 검증 전 {availabilityCounts.unverified}
                    </b>{" "}
                    실행 경로 연결 · 실제 생성 품질 미검증
                  </span>
                  <span>
                    <b className="gs-tag gs-planned">
                      미구현 {availabilityCounts.planned}
                    </b>{" "}
                    실행 불가 · 후속 구현 범위
                  </span>
                </div>
                <div className="gs-catalog-tools">
                  <div
                    className="gs-tabs"
                    role="tablist"
                    aria-label="작업 목록"
                  >
                    {(
                      [
                        ["all", "전체"],
                        ["recommended", "추천"],
                        ["selected", "선택한 작업"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        role="tab"
                        key={value}
                        aria-selected={catalogTab === value}
                        onClick={() => setCatalogTab(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <label className="gs-search">
                    <Search size={15} />
                    <input
                      aria-label="작업 검색"
                      placeholder="이름, ID, 필요한 입력 검색"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </label>
                </div>
                <p className="gs-fine">
                  제작은 위의 특징 선택과 단계별 버튼으로 진행합니다. 이 목록은
                  내부 기능의 실제 지원 상태를 보여줍니다. 2D·UI·VFX 제작은 후속
                  범위입니다.
                </p>
                <div className="gs-task-list" data-testid="graphics-task-list">
                  {filteredTasks.map((task) => (
                    <div
                      key={task.id}
                      className={`gs-task-row ${task.id === taskId ? "is-active" : ""}`}
                      data-task-id={task.id}
                    >
                      <button
                        className="gs-task-open"
                        onClick={() =>
                          setNotice(
                            `${task.name}: ${task.reason ?? task.output}`,
                          )
                        }
                      >
                        <span className="gs-task-id">{task.id}</span>
                        <span>
                          <strong>{task.name}</strong>
                          <small>
                            {task.group} · {task.inputs}
                          </small>
                        </span>
                      </button>
                      <span className={`gs-tag gs-${task.status}`}>
                        {statusLabels[task.status]}
                      </span>
                    </div>
                  ))}
                </div>
                {filteredTasks.length === 0 && (
                  <p className="gs-muted">조건에 맞는 작업이 없습니다.</p>
                )}
              </section>
            )}

            {auxiliary === "history" && object && (
              <section className="gs-history">
                <div className="gs-section-title">
                  <h2>작업 이력</h2>
                  <span>{objectTasks.length}</span>
                </div>
                {objectTasks.length === 0 && (
                  <p className="gs-muted">
                    아직 실행한 작업이 없습니다. 가져온 원본은 위 버전 목록에
                    보관됩니다.
                  </p>
                )}
                {[...objectTasks].reverse().map((task) => (
                  <details
                    key={task.id}
                    open={
                      task.status === "failed" ||
                      task.status === "submission_unknown"
                    }
                  >
                    <summary>
                      <span>
                        <strong>
                          {task.taskId} {findGraphicsTask(task.taskId)?.name}
                        </strong>
                        <small>
                          {stamp(task.createdAt)} ·{" "}
                          {task.localOnly ? "로컬 실행" : "외부 실행"}
                        </small>
                      </span>
                      <span
                        className={`gs-tag ${task.status === "failed" || task.status === "submission_unknown" ? "gs-warning" : ""}`}
                      >
                        {taskStatuses[task.status]}
                      </span>
                    </summary>
                    <p>{task.message}</p>
                    {task.errorCode && <code>{task.errorCode}</code>}
                    <p>
                      입력 {task.inputVersionIds.length}개 · 결과{" "}
                      {task.outputVersionIds.length}개 · 요청 {task.requestHash}
                    </p>
                    {task.instruction && <p>{task.instruction}</p>}
                    <p>실행 작업: {task.backendJobIds.join(", ") || "없음"}</p>
                    {task.runtimeApprovalHistory?.map((entry, index) => (
                      <p key={`${entry.id}-${index}`}>
                        도구 확인: {entry.title} ·{" "}
                        {
                          (
                            {
                              accepted: "허용",
                              declined: "거절",
                              cancelled: "취소",
                              interrupted: "중단",
                            } as const
                          )[entry.decision]
                        }{" "}
                        · {stamp(entry.answeredAt)}
                      </p>
                    ))}
                    {task.cost && (
                      <p>
                        기록된 비용: {task.cost.credits ?? "미확인"} 크레딧 ·{" "}
                        {task.cost.basis}
                      </p>
                    )}
                    {["failed", "submission_unknown"].includes(task.status) && (
                      <button
                        disabled={disabled}
                        onClick={() =>
                          void run({ kind: "recover", taskId: task.id })
                        }
                      >
                        {recoveryLabel(task)}
                      </button>
                    )}
                    {task.status === "running" && (
                      <button
                        disabled={disabled}
                        onClick={() =>
                          void run({ kind: "cancel", taskId: task.id })
                        }
                      >
                        추적 중지
                      </button>
                    )}
                  </details>
                ))}
              </section>
            )}
          </div>
        </dialog>
      )}
      {newObjectOpen && (
        <dialog ref={newObjectDialog} className="gs-new-object-dialog" data-testid="graphics-create-dialog" aria-labelledby="gs-new-object-title" aria-describedby="gs-new-object-description"
          onCancel={event => { event.preventDefault(); closeNewObject(); }}>
          <form onSubmit={createObject} aria-busy={pending}>
            <header>
              <div><h2 id="gs-new-object-title">새 오브젝트 만들기</h2><p id="gs-new-object-description">만들 대상을 고르고 이름을 붙이세요. 모양과 참조는 다음 이미지 단계에서 설정합니다.</p></div>
              <button type="button" aria-label="새 오브젝트 닫기" disabled={pending} onClick={closeNewObject}><X size={20} /></button>
            </header>
            <div className="gs-new-object-body">
              <CreationSubjectChooser variant="cards" value={newSubject} disabled={disabled} onChange={id => {
                setNewSubject(id);
                if (!newName || newName === creationSubjects.find(item => item.id === newSubject)?.label) setNewName(creationSubjects.find(item => item.id === id)?.label ?? '');
              }} />
              <div className="gs-new-object-name"><label htmlFor="gs-object-name">3. 이름</label><input id="gs-object-name" aria-label="이름" placeholder="예: 기사 대검" value={newName} disabled={disabled} onChange={event => setNewName(event.target.value)} maxLength={100} /></div>
            </div>
            <footer>
              <div><p>{newSubject ? `선택: ${creationSubjects.find(item => item.id === newSubject)?.label}` : '만들 대상을 선택하세요.'} · 이미지나 모델은 아직 생성하지 않습니다.</p>{newObjectError && <p role="alert" className="gs-error">{newObjectError}</p>}</div>
              <div className="gs-new-object-buttons"><button type="button" disabled={pending} onClick={closeNewObject}>취소</button><button type="submit" className="gs-primary" disabled={disabled || !newName.trim() || !newSubject}>{pending ? <><LoaderCircle size={16} className="gs-spin" /> 만드는 중…</> : <><FilePlus2 size={16} /> 오브젝트 만들기</>}</button></div>
            </footer>
          </form>
        </dialog>
      )}
      <dialog ref={unityTargetDialog} className="gs-unity-target-dialog" aria-label="Unity 프로젝트 변경" onCancel={event=>{event.preventDefault();if(!pending)setUnityTargetOpen(false);}}>
        <form onSubmit={event=>void saveUnityTarget(event)}>
          <header><h2>Unity 프로젝트 변경</h2><button type="button" aria-label="Unity 프로젝트 변경 닫기" disabled={pending} onClick={()=>setUnityTargetOpen(false)}><X size={18}/></button></header>
          <p>Assets, Packages, ProjectSettings가 있는 Unity 프로젝트 폴더를 입력하세요. 저장하면 폴더 정보를 검사하고 이 제작 프로젝트의 전달 대상으로 설정합니다.</p>
          <label htmlFor="gs-unity-target-path">새 Unity 프로젝트 경로</label>
          <input id="gs-unity-target-path" autoFocus value={unityTargetDraft} disabled={unityTargetLocked} onChange={event=>setUnityTargetDraft(event.target.value)} />
          <small>저장 전까지 현재 대상은 유지됩니다. 파일 전달·생성·Play는 시작하지 않습니다.</small>
          {unityTargetError && <p role="alert" className="gs-error">{unityTargetError}</p>}
          <footer><button type="button" disabled={pending} onClick={()=>setUnityTargetOpen(false)}>취소</button><button type="submit" className="gs-primary" disabled={unityTargetLocked || !unityTargetDraft.trim()}>{pending ? '대상 확인 중…' : '검사하고 저장'}</button></footer>
        </form>
      </dialog>
      {focusedImage && (
        <dialog
          ref={imageDialog}
          className="gs-image-overlay"
          aria-label={`${focusedImage.label} 원본 이미지`}
          onClick={(event) => {
            if (event.target === event.currentTarget)
              setFocusedImage(undefined);
          }}
          onCancel={(event) => {
            event.preventDefault();
            setFocusedImage(undefined);
          }}
        >
          <div className="gs-image-dialog">
            <header>
              <span>
                <strong>{focusedImage.label}</strong>
                <small>저장된 원본 이미지 · 화면에 맞춰 표시</small>
              </span>
              <button autoFocus onClick={() => setFocusedImage(undefined)}>
                이미지 닫기
              </button>
            </header>
            <img
              alt={focusedImage.label}
              src={window.desktop.assetUrl(project.id, focusedImage.path)}
            />
            <code>{focusedImage.path}</code>
          </div>
        </dialog>
      )}
    </section>
  );
}
