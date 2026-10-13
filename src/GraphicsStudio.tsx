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
} from "../shared/graphics";
import { graphicsLegacyUnlinkProblem, requiresPartSourcePreparation, requiresPartSpaceRestoration } from "../shared/graphics";
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
import { HeadComparison } from './HeadComparison';
import { CreationOptions } from "./CreationOptions";
import { CreationSubjectChooser } from './CreationSubjectChooser';
import { GraphicsStoragePanel } from './GraphicsStoragePanel';
import { modelProductionGeometry, modelProductionLabel } from '../shared/graphics-provenance';
import { creationForSubject, creationSubjects, creationCompositionStrategy } from '../shared/graphics-creation';
import { normalizePhysicalSize, physicalSizeSummary, type PhysicalSize } from '../shared/graphics-size';
import { GraphicsSizePanel } from './GraphicsSizePanel';
import type { ModelMeasurement, MeshSelection } from './viewport-inspection';
import {
  creationStages,
  creationTaskId,
  creationSettings,
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

type Props = {
  project: Project;
  workspace: GraphicsWorkspace | undefined;
  busy: boolean;
  onAction: (action: GraphicsAction) => Promise<unknown>;
  onOpenSettings?: () => void;
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
}: {
  project: Project;
  version?: AssetVersion;
  physicalSize?: PhysicalSize;
  onBounds?: (bounds: ModelMeasurement) => void;
  onMeshSelect?: (selection: MeshSelection | null) => void;
  nativePolygonCount?: number;
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
  const glb = version.files.find((file) => /\.glb$/i.test(file.path));
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
        ...project.assets,
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
        animation={version.role === "animation"}
        physicalSize={physicalSize}
        onBounds={onBounds}
        onMeshSelect={onMeshSelect}
        nativePolygonCount={nativePolygonCount}
        nativeVersionId={version.id}
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
}: Props) {
  const [objectId, setObjectId] = useState("");
  const [newName, setNewName] = useState("");
  const [newSubject, setNewSubject] = useState("");
  const [newObjectOpen, setNewObjectOpen] = useState(false);
  const [newObjectError, setNewObjectError] = useState("");
  const [focusNewObject, setFocusNewObject] = useState(false);
  const newObjectDialog = useRef<HTMLDialogElement>(null);
  const newObjectTrigger = useRef<HTMLElement | null>(null);
  const newObjectNameFocus = useRef(false);
  const createSubmitting = useRef(false);
  const previousObjectIds = useRef<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [catalogTab, setCatalogTab] = useState<
    "all" | "recommended" | "selected"
  >("all");
  const [stage, setStage] = useState<CreationStage>("design");
  const [creation, setCreation] = useState<CreationSpec>(() =>
    defaultCreation("prop"),
  );
  const [taskOverride, setTaskId] = useState<string>();
  const taskId = taskOverride ?? creationTaskId(creation, stage);
  const [shownVersionId, setShownVersionId] = useState("");
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
    const producer = model && objectTasks.find(task => task.outputVersionIds.includes(model.id));
    const modelStatus = !model ? '모델 미채택' : producer?.taskId === 'T03' ? '텍스처 채택' : producer?.taskId === 'T01' || producer?.taskId === 'T02' ? 'UV 채택' : '모델 채택';
    return [part.id, `${design ? '참조 채택' : '참조 미채택'} · ${modelStatus}`];
  }));
  const mediaGroups = candidateGroups(versions, objectTasks);
  const latestMediaGroup = ["design", "animation"].includes(stage)
    ? mediaGroups
        .filter(
          (group) => group.kind === (stage === "animation" ? "video" : "image"),
        )
        .at(-1)
    : undefined;
  const shownVersion =
    versions.find((version) => version.id === shownVersionId) ??
    latestMediaGroup?.candidates[0].version ??
    versions.find((version) => object && acceptedVersion(object, version)) ??
    versions.at(-1);
  const needsPartSpaceRestoration = Boolean(workspace && shownVersion && requiresPartSpaceRestoration(workspace, shownVersion));
  const needsPartSourcePreparation = Boolean(workspace && shownVersion && requiresPartSourcePreparation(workspace, shownVersion));
  const needsPartPreparation = needsPartSpaceRestoration || needsPartSourcePreparation;
  const shownAssembly = shownVersion?.role === 'model' && shownVersion.slot === 'main'
    ? objectTasks.find(task => task.taskId === 'M08' && task.outputVersionIds.includes(shownVersion.id) && task.outputVersionIds.length > 1) : undefined;
  const assemblyParts = shownAssembly?.outputVersionIds.map(id => versions.find(version => version.id === id)).filter((version): version is AssetVersion => !!version && version.role === 'model' && version.slot.startsWith('part-'));
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
  const latestTaskByOperation = new Map<string, GraphicsTask>();
  const latestResultByOperation = new Map<string, GraphicsTask>();
  for (const task of [...objectTasks].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  )) {
    const operation = `${task.taskId}:${task.settings.clipName ?? ""}:${task.settings.partId ?? ""}`;
    latestTaskByOperation.set(operation, task);
    // A later cancelled/failed request must not hide an already registered result.
    if (task.status === 'review' && task.outputVersionIds.some(id => versions.some(version => version.id === id))) latestResultByOperation.set(operation, task);
  }
  const visibleTasks = [...new Map([...latestTaskByOperation.values(), ...latestResultByOperation.values()].map(task => [task.id, task])).values()]
    .filter(
      (task) =>
        task.taskId === taskId ||
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
    setShownVersionId([...results].reverse().find(version => version.partSpace || version.partSource)?.id ?? results[0]?.id ?? '');
    document.querySelector('.gs-result')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function adoptVersion(version: AssetVersion) {
    if (version.slot === 'part-head' && acceptedHeadId && acceptedHeadId !== version.id) setHeadBaselineId(acceptedHeadId);
    void run({ kind: 'accept', objectId: version.objectId, versionId: version.id }, shownAssembly && version.id === shownVersion?.id ? '이 조립 전체와 같은 작업의 파트를 함께 채택했습니다. 다음 작업은 직접 실행하세요.' : `${roles[version.role]} / ${version.slot}에 채택했습니다. 다음 작업은 직접 실행하세요.`);
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
    setCreation(object ? effectiveCreation(object) : defaultCreation("prop"));
    setStage("design");
    setTaskId(undefined);
    setShownVersionId("");
    setHeadComparisonOpen(false);
    setHeadBaselineId('');
    setFocusedImage(undefined);
    setReferenceId("");
    setError("");
    setNotice("");
    setImportRole("design");
  }, [object?.id]);
  useEffect(() => {
    if (!focusNewObject || !object || previousObjectIds.current.has(object.id)) return;
    setFocusNewObject(false);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.gs-creation-stages button')?.focus());
  }, [object?.id, focusNewObject]);
  useEffect(() => {
    if (!waiting.length) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [waiting.length]);
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
    setStage(next);
    setTaskId(undefined);
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
      selectionProblem
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

  return (
    <section className="graphics-studio" data-testid="graphics-studio">
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
            <button onClick={onOpenSettings}>
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
              {creationStages.map((item, index) => (
                <button
                  type="button"
                  key={item.id}
                  aria-current={stage === item.id ? "step" : undefined}
                  onClick={() => changeStage(item.id)}
                >
                  <span>{index + 1}</span>
                  {item.label}
                </button>
              ))}
            </nav>
            <div className="gs-execution-card">
            <div className="gs-creation-execute" aria-label="현재 단계 실행">
              <div>
                <strong>{activeTask.name}</strong>
                <small role={selectionProblem ? "status" : undefined}>
                  {selectionProblem ||
                    (activeTask.status === "planned"
                      ? activeTask.reason
                      : active
                        ? "기존 작업의 승인 또는 결과를 확인하세요."
                      : completedUvTask ? '완료된 UV 결과가 있습니다. 결과 보기는 새 제작이나 과금을 시작하지 않습니다.'
                      : activeTask.executor === "local"
                          ? "로컬 처리 · GPT 요청 없이 준비"
                          : "실행 전 입력과 비용을 앱에서 확인합니다.")}
                </small>
              </div>
              {completedUvTask && <button className="gs-primary" data-testid="graphics-open-completed-result" onClick={() => showTaskResult(completedUvTask)}>완료 · 결과 보기</button>}
              <button
                className={completedUvTask ? undefined : "gs-primary"}
                data-testid="graphics-prepare"
                disabled={
                  disabled ||
                  !sizeInputsValid ||
                  Boolean(
                    multiviewProblem || modelProblem || selectionProblem,
                  ) ||
                  activeTask.status === "planned" ||
                  active ||
                  (stage === "rig" && settings.rigType === "none") ||
                  ["sprite", "ui", "vfx"].includes(object.kind)
                }
                onClick={() => void prepare()}
              >
                {pending ? "요청 확인 중…" : prepareLabel}
              </button>
            </div>
            <div className="gs-execution-summary" aria-label="실행 설정 요약">
              <span><b>대상</b> {creationSubjects.find(item => item.id === creation.subject)?.label ?? object.name}</span>
              <span><b>도구·모델</b> {activeTask.executor === 'tripo' && stage !== 'model' ? `Tripo API · ${activeTask.name}` : activeTask.executor === 'tripo' ? `Tripo · ${catalog.model.find(model => model.id === String(settings.model ?? 'P2-20260801'))?.label ?? settings.model}` : activeTask.executor === 'astra' ? 'Blender + Astra' : activeTask.executor === 'local' ? '로컬 처리' : activeTask.executor === 'runway' ? 'Runway' : activeTask.executor === 'codex-image' ? 'Codex 이미지' : '설정 확인'}</span>
              <span><b>후보</b> {String(settings.count ?? 1)}개</span>
              {stage === 'model' && <span><b>목표 면 수</b> {Number(settings.faceLimit ?? 5000).toLocaleString()}</span>}
              {taskId === 'M09' && <span><b>보완 원본</b> {versions.find(version => version.id === settings.sourceVersionId)?.label ?? '미리보기에서 선택 필요'}</span>}
              {taskId === 'M05' && settings.editSourceMode === 'candidate' && <span><b>보정 원본</b> {versions.find(version => version.id === settings.sourceVersionId)?.label ?? '미리보기에서 선택 필요'}</span>}
              {taskId === 'M09' && <span><b>추가 상한</b> {String(settings.repairMaxAddedFaces ?? 1500)}면 · {String(settings.repairMaxAddedVertices ?? 1000)}정점</span>}
              <span><b>목표 크기</b> {physicalSizeSummary(creation.physicalSize)}</span>
              <span><b>예상 비용</b> {activeTask.executor === 'local' ? '무료 · GPT 0회' : '준비 후 비용 카드 확인'}</span>
            </div>
            </div>

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
                        {findGraphicsTask(task.taskId)?.name ?? task.taskId} ·{" "}
                        {task.runtimeApproval && task.status === "running"
                          ? "사용자 확인 대기"
                          : task.partSourceRecoveryVersionId && task.status === 'running' ? '로컬 파트 작업 원본 준비 중'
                          : task.partSourceRecoveryVersionId && task.status === 'cancelled' ? '로컬 원본 준비 중지'
                          : task.partSpaceRecoveryVersionId && task.status === 'running' ? '로컬 크기·위치 복원 중'
                          : task.partSpaceRecoveryVersionId && task.status === 'cancelled' ? '로컬 복원 중지'
                          : task.status === 'review' && task.outputVersionIds.length ? '완료 · 결과 확인'
                          : task.status === 'cancelled' && task.paidApproval ? '추적 중지 · 원격 상태 확인 필요'
                          : taskStatuses[task.status]}
                      </strong>
                      <p>{task.message || "작업 상태를 확인하고 있습니다."}</p>
                      {task.status === 'cancelled' && task.paidApproval && !task.partSpaceRecoveryVersionId && !task.partSourceRecoveryVersionId && <p className="gs-warning">유료 실행이 승인된 요청입니다. 추적 중지는 원격 처리나 과금 취소를 뜻하지 않습니다. 이전에 완료된 결과는 별도로 유지됩니다.</p>}
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
                          {task.partSourceRecoveryVersionId ? '저장된 파트 작업 원본 준비 · 무료' : task.partSpaceRecoveryVersionId ? '저장된 파트 크기·위치 복원 · 무료' : recoveryLabel(task)}
                        </button>
                      )}
                      {task.status === "running" && (
                        <button
                          disabled={disabled}
                          onClick={() =>
                            void run({ kind: "cancel", taskId: task.id })
                          }
                        >
                          {task.partSourceRecoveryVersionId ? '로컬 원본 준비 중지' : task.partSpaceRecoveryVersionId ? '로컬 복원 중지' : '추적 중지'}
                        </button>
                      )}
                      {task.status === "review" && task.outputVersionIds.some(id => versions.some(version => version.id === id)) && (
                        <button
                          onClick={() => showTaskResult(task)}
                        >
                          완료 · 결과 보기
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
            {error && (
              <div role="alert" className="gs-alert gs-alert-error">
                <strong>요청을 완료하지 못했습니다.</strong>
                <p>{error}</p>
                <span>기존 원본과 채택 결과는 유지됩니다.</span>
              </div>
            )}
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
                    onClick={() =>
                      document
                        .getElementById("gs-reference-version")
                        ?.scrollIntoView({
                          behavior: "smooth",
                          block: "center",
                        })
                    }
                  >
                    참고 원본 연결
                  </button>
                </div>
              )}
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
                        className="gs-primary"
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

              <div className="gs-work-layout">
                <section className="gs-result">
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
                                {media.kind === 'image' && <button className="gs-primary gs-candidate-adopt" data-testid={`graphics-accept-image-${version.id}`} disabled={disabled || accepted}
                                  onClick={() => { setShownVersionId(version.id); adoptVersion(version); }}>
                                  {accepted ? '채택한 이미지' : '이 이미지 채택'}
                                </button>}
                              </article>
                            );
                          },
                        )}
                      </div>
                    </section>
                  )}
                  {shownVersion && ['model', 'material'].includes(shownVersion.role) && <div className="gs-preview-actions" data-testid="graphics-preview-actions">
                    <strong>{shownVersion.label}</strong>
                    <div>
                      <button className="gs-primary" data-testid="graphics-accept-preview" disabled={disabled || needsPartPreparation || shownAcceptanceComplete} onClick={() => adoptVersion(shownVersion)}>
                        {shownAcceptanceComplete ? shownAssembly ? '현재 채택한 조립·파트' : '현재 채택한 모델' : needsPartSpaceRestoration ? '크기·위치 복원 후 채택' : needsPartSourcePreparation ? '작업 원본 준비 후 채택' : shownAssembly ? '이 조립과 파트 채택' : '이 모델 채택'}
                      </button>
                      {headCandidate && headBaseline && !headComparisonOpen && <button data-testid="graphics-compare-heads" onClick={() => { setHeadBaselineId(headBaseline.id); setHeadComparisonOpen(true); setMeshSelection(null); }}>
                        {headBaseline.id === acceptedHeadId ? '채택 머리와 나란히 비교' : '머리 버전 나란히 비교'}
                      </button>}
                    </div>
                    <small>{shownAssembly ? '같은 조립 작업의 전체 모델과 배치된 파트를 함께 채택합니다. 이후 파트 UV도 이 배치를 사용하며, 이전 원본은 유지됩니다.' : '채택은 다음 작업의 원본만 바꾸며, 제작을 실행하지 않습니다.'}</small>
                  </div>}
                  {shownVersion && needsPartSourcePreparation && <div className="gs-result-notes" aria-label="파트 작업 원본 준비 필요" data-testid="graphics-part-source-warning">
                    <strong>채택 전 파트 작업 원본 준비 필요</strong>
                    <p>외부에서 생성한 파트의 작업 원본이 아직 준비되지 않았습니다. 무료로 로컬 작업 사본을 준비한 뒤 결과를 확인하고 채택하세요. 외형을 자동으로 판단하거나 다시 생성하지 않으며, 외부 원본 파일은 그대로 보관합니다.</p>
                    <button data-testid="graphics-prepare-part-source" disabled={disabled || active}
                      onClick={() => void run({ kind: 'prepare-part-source', versionId: shownVersion.id }, '파트 작업 원본 준비를 요청했습니다. 새 제작 없이 로컬에서 준비하며, 완료되면 결과 보기를 눌러 주세요.')}>
                      파트 작업 원본 준비 · 무료
                    </button>
                  </div>}
                  <div className={`gs-preview${headComparisonOpen && headCandidate && headBaseline ? ' gs-preview-comparison' : ''}`} data-testid="graphics-preview">
                    {headComparisonOpen && headCandidate && headBaseline
                      ? <HeadComparison projectId={project.id} baseline={headBaseline} candidate={headCandidate} choices={headVersions} acceptedId={acceptedHeadId} onBaseline={setHeadBaselineId} onClose={() => setHeadComparisonOpen(false)} />
                      : <VersionPreview project={project} version={shownVersion} physicalSize={shownVersion?.slot.startsWith("part-") ? undefined : creation.physicalSize} onBounds={setModelBounds} onMeshSelect={setMeshSelection} nativePolygonCount={nativeMeasurement?.versionId === shownVersion?.id ? nativeMeasurement?.faces : undefined} />}
                  </div>
                  {meshSelection && shownVersion && <div className="gs-mesh-correction">
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
                    <div className="gs-version-detail">
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
                      {["model", "rig", "animation"].includes(shownVersion.role) && <p className="gs-model-provenance">제작 원본: {modelProductionLabel(shownVersion, versions, objectTasks)}<br />{modelProductionGeometry(shownVersion, versions, objectTasks)} · 실제 결과 면수와 다를 수 있습니다.</p>}
                      {shownVersion.role === "model" && (
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
                      {['model', 'material'].includes(shownVersion.role) && <div className="gs-result-notes" aria-label="결과 추가 보정">
                        <button disabled={disabled || active || needsPartPreparation} onClick={() => chooseRevisionSource(shownVersion)}>이 결과 더 보정</button>
                        <small>현재 보는 결과의 형태를 이어서 수정합니다. 채택 전 후보도 지정할 수 있으며, 원본과 채택 상태는 유지됩니다.</small>
                      </div>}
                      {['model', 'material'].includes(shownVersion.role) && shownVersion.slot.startsWith('part-') && <div className="gs-result-notes" aria-label="파트 빠진 면 보완">
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
                      <button
                        data-testid="graphics-accept-version"
                        aria-label={shownAssembly ? '상세 결과에서 조립과 파트 함께 채택' : undefined}
                        disabled={
                          disabled || needsPartPreparation || shownAcceptanceComplete
                        }
                        onClick={() => adoptVersion(shownVersion)}
                      >
                        {shownAcceptanceComplete
                          ? "현재 채택 버전"
                          : needsPartSpaceRestoration ? '크기·위치 복원 후 채택'
                          : needsPartSourcePreparation ? '작업 원본 준비 후 채택'
                          : shownAssembly ? '이 조립과 파트 채택'
                          : `${roles[shownVersion.role]} / ${shownVersion.slot}에 채택`}
                      </button>
                    </div>
                  )}
                  <div className="gs-version-list" aria-label="전체 버전">
                    {[...versions].reverse().map((version) => (
                      <button
                        key={version.id}
                        aria-pressed={shownVersion?.id === version.id}
                        data-testid={`graphics-version-${version.id}`}
                        className={
                          shownVersion?.id === version.id ? "is-active" : ""
                        }
                        onClick={() => setShownVersionId(version.id)}
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
                  </div>
                </section>

                <section className="gs-instruction">
                  {["model", "unity"].includes(stage) && <GraphicsSizePanel key={object.id} value={creation.physicalSize} bounds={!shownVersion?.slot.startsWith("part-") && shownVersion?.files.some(file => /\.glb$/i.test(file.path)) ? modelBounds : undefined} restricted={object.kind === "character" || Boolean(modelBounds?.hasSkin || modelBounds?.hasMorph || modelBounds?.hasAnimation)} disabled={disabled || active} onValidityChange={setSizeInputsValid} onChange={physicalSize => setCreation(current => ({ ...current, physicalSize }))} onSave={() => void run({ kind: "update-object", objectId: object.id, patch: { creation } }, "크기 설정을 저장했습니다. 새 생성은 없습니다.")} onApply={creation.attributes.composition !== "parts" && (object.accepted["model:main"] || object.accepted["rig:main"]) ? () => void prepareSizeCopy() : undefined} />}
                  <CreationOptions
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
                            <option value="both">FBX + GLB</option>
                            <option value="fbx">FBX</option>
                            <option value="glb">GLB</option>
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
              </div>

              <section className="gs-references">
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
              </section>
            </>
          )}

          <div className="gs-bottom-grid">
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
          </div>
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
