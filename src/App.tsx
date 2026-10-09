import { useCallback, useEffect, useState, type ReactNode } from "react";
import { version as appVersion } from "../package.json";
import {
  Box,
  Boxes,
  Check,
  ChevronRight,
  CircleHelp,
  Clock,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  ImagePlus,
  Layers3,
  Link,
  LoaderCircle,
  Lock,
  Plus,
  RefreshCw,
  Scissors,
  Settings,
  ShieldCheck,
  Sparkles,
  Unplug,
  Unlock,
  Upload,
  X,
  Workflow,
  Play,
  Trash2,
  ArrowUpRight,
  Save,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import type {
  AppState,
  Asset,
  Command,
  Generation,
  Job,
  Part,
  Project,
  Quote,
  Settings as SettingsType,
} from "../shared/types";
import { Viewport } from "./Viewport";
import { CropEditor } from "./CropEditor";
import { AssetWorkbench } from "./AssetWorkbench";
import { catalog } from "../shared/catalog";
import {
  TripoStudio,
  RequestOptions,
  operationLabels,
  canPreview,
} from "./TripoStudio";
const steps = [
  ["workbench", "단계별 에셋 제작", Workflow],
  ["studio", "Tripo 작업실", Sparkles],
  ["image", "이미지 스튜디오", ImagePlus],
  ["parts", "파츠 준비", Scissors],
  ["assembly", "조립 작업실", Boxes],
  ["rig", "리깅 · 애니메이션", Workflow],
  ["unity", "Unity로 보내기", Box],
] as const;
const labels: Record<string, string> = {
  queued: "대기",
  submitting: "제출 중",
  running: "진행 중",
  success: "완료",
  failed: "실패",
  submission_unknown: "제출 확인 필요",
  paused: "추적 중지",
  cancelled: "원격 취소",
  cancelled_local: "제출 전 취소",
};
function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Empty({
  icon: Icon = Box,
  title,
  children,
}: {
  icon?: typeof Box;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={28} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function AssetImage({ p, a }: { p: Project; a?: Asset }) {
  return a ? (
    <img
      className="asset-image"
      src={window.desktop.assetUrl(p.id, a.file)}
      alt={a.label}
    />
  ) : (
    <div className="asset-placeholder">
      <ImagePlus size={24} />
    </div>
  );
}
export function App() {
  const [state, setState] = useState<AppState>(),
    [id, setId] = useState(""),
    [tab, setTab] = useState("home"),
    [partId, setPartId] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [quote, setQuote] = useState<Quote>(),
    [accepted, setAccepted] = useState(false),
    [create, setCreate] = useState(false),
    [name, setName] = useState("새 캐릭터 01"),
    [demo, setDemo] = useState(false);
  const [prompt, setPrompt] = useState(""),
    [model, setModel] = useState(catalog.image[0].id),
    [size, setSize] = useState("2K"),
    [count, setCount] = useState(1),
    [edit, setEdit] = useState(false),
    [model3d, setModel3d] = useState(catalog.model[0].id),
    [preview, setPreview] = useState(""),
    [remoteId, setRemoteId] = useState("");
  const refresh = useCallback(async () => {
    if (window.desktop)
      setState(await window.desktop.call<AppState>({ type: "state" }));
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [refresh]);
  const p = state?.projects.find((p) => p.id === id),
    part = p?.parts.find((x) => x.id === partId) ?? p?.parts[0];
  async function run<T = any>(
    c: Command,
    success?: string,
  ): Promise<T | undefined> {
    setError("");
    setBusy(true);
    try {
      const result = await window.desktop.call<T>(c);
      await refresh();
      if (success) setMessage(success);
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : "작업 실패");
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  function open(p: Project) {
    setId(p.id);
    setPartId(p.parts[0]?.id ?? "");
    setTab(p.demo ? "assembly" : "workbench");
    setPreview("");
  }
  async function deleteProject(project: Project) {
    const result = await run<{ deleted: boolean }>({
      type: "project.delete",
      id: project.id,
    });
    if (!result?.deleted) return;
    if (id === project.id) {
      setId("");
      setPartId("");
      setTab("home");
      setPreview("");
      setRemoteId("");
    }
    if (id === project.id || quote?.projectId === project.id) {
      setQuote(undefined);
      setAccepted(false);
    }
    setMessage(`“${project.name}” 프로젝트를 삭제했습니다.`);
  }
  async function request(r: Generation) {
    if (!p) return;
    const q = await run<Quote>({
      type: "generation.quote",
      id: p.id,
      request: r,
    });
    if (q) {
      setAccepted(false);
      setQuote(q);
    }
  }
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(""), 5000);
    return () => clearTimeout(t);
  }, [message]);
  useEffect(() => {
    if (tab !== "unity" || !id) return;
    const t = setInterval(() => {
      void window.desktop
        .call({ type: "unity.result", id })
        .then(refresh)
        .catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [tab, id, refresh]);
  if (!window.desktop)
    return (
      <div className="standalone">
        <h1>Partsmith</h1>
        <p>로컬 기능은 Electron 앱에서 실행됩니다.</p>
        <code>npm run dev</code>
      </div>
    );
  if (!state)
    return (
      <div className="standalone">
        <LoaderCircle className="spin" />
        <p>제작실을 여는 중…</p>
      </div>
    );
  const selectedImage = p?.assets.find((a) => a.id === p.selectedImageId);
  const latest = p?.builds.at(-1);
  const currentBuild = latest && latest.revision === p?.revision;
  const patchPart = (patch: Partial<Part>) =>
    p &&
    part &&
    void run({ type: "part.update", id: p.id, partId: part.id, patch });
  const headerTitle =
    tab === "home"
      ? "프로젝트"
      : tab === "settings"
        ? "연결 설정"
        : (steps.find((s) => s[0] === tab)?.[1] ?? "제작실");
  return (
    <div className="app">
      <aside className="sidebar">
        <button className="brand" onClick={() => setTab("home")}>
          <div className="brand-mark">
            <Boxes size={24} />
          </div>
          <span>
            partsmith<small>CHARACTER WORKBENCH</small>
          </span>
        </button>
        <div className="workspace-label">
          개인 작업 공간 <Badge>LOCAL</Badge>
        </div>
        <button
          className={`nav ${tab === "home" ? "selected" : ""}`}
          onClick={() => setTab("home")}
        >
          <Folder size={18} /> 모든 프로젝트
        </button>
        <div className="nav-label">에셋 제작</div>
        <button
          disabled={!p}
          onClick={() => setTab("workbench")}
          className={`nav ${tab === "workbench" ? "selected" : ""}`}
        >
          <Workflow size={18} />
          <span>단계별 에셋 제작</span>
        </button>
        <details
          className="manual-tools"
          key={p?.id}
          open={p?.demo || undefined}
        >
          <summary>수동 도구 · 문제 해결</summary>
          {steps.slice(1).map(([key, label, Icon], i) => (
            <button
              key={key}
              disabled={!p}
              onClick={() => setTab(key)}
              className={`nav ${tab === key ? "selected" : ""}`}
            >
              <Icon size={18} />
              <span>{label}</span>
              <small>0{i + 1}</small>
            </button>
          ))}
        </details>
        <div className="sidebar-bottom">
          <div className="local-note">
            <ShieldCheck size={18} />
            <div>
              내 컴퓨터에 저장<small>키는 프로젝트와 별도 보관</small>
            </div>
          </div>
          <button
            className={`nav ${tab === "settings" ? "selected" : ""}`}
            onClick={() => setTab("settings")}
          >
            <Settings size={18} /> 연결 설정
            <span
              className={`connection-dot ${state.key.configured ? "online" : ""}`}
            />
          </button>
          <div className="version">
            PROTOTYPE <span>v{appVersion}</span>
          </div>
        </div>
      </aside>
      <div className="app-body">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>작업 공간</span>
            <ChevronRight size={13} />
            <button onClick={() => setTab("home")}>
              {p?.name ?? "프로젝트"}
            </button>
            {p && (
              <>
                <ChevronRight size={13} />
                <span>{headerTitle}</span>
              </>
            )}
          </div>
          <div className="top-actions">
            <span className="saved">
              <span className="status-dot" /> 로컬 자동 저장
            </span>
            <button
              title="프로젝트 폴더 열기"
              onClick={() => run({ type: "folder.open", id: p?.id })}
            >
              <FolderOpen size={17} />
            </button>
            <button className="avatar" onClick={() => setTab("settings")}>
              M
            </button>
          </div>
        </header>
        {error && (
          <div role="alert" className="banner error">
            <AlertTriangle size={17} />
            <span>{error}</span>
            <button onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {message && (
          <div role="status" className="toast">
            <CheckCircle2 size={17} />
            {message}
          </div>
        )}
        {busy && (
          <div className="busy">
            <LoaderCircle className="spin" size={14} /> 작업 처리 중
          </div>
        )}
        {tab === "home" && (
          <main className="home page">
            <div className="page-heading">
              <div>
                <div className="eyebrow">YOUR CREATIVE WORKSPACE</div>
                <h1>아이디어에서, 플레이 가능한 캐릭터로.</h1>
                <p>이미지를 고르고, 파츠를 다듬고, 동작을 완성하세요.</p>
              </div>
              <button className="primary" onClick={() => setCreate(true)}>
                <Plus size={17} /> 새 프로젝트
              </button>
            </div>
            <div className="hero-card">
              <div>
                <Badge tone="green">CHARACTER WORKBENCH</Badge>
                <h2>
                  원하는 모습을 고르고.
                  <br />
                  단계마다 내 손으로.
                </h2>
                <p>
                  이미지와 모델 후보를 비교하고, 필요한 곳을 명령으로
                  수정하세요.
                  <br />
                  설정 · 실행 · 선택 · 수정. 다음 단계는 준비됐을 때.
                </p>
                <button
                  onClick={() => {
                    setDemo(true);
                    setName("마네킹 연결 테스트");
                    setCreate(true);
                  }}
                >
                  로컬 데모로 시작 <ArrowUpRight size={17} />
                </button>
              </div>
              <div className="hero-graphic">
                <div className="orbit orbit-one" />
                <div className="orbit orbit-two" />
                <Boxes size={112} strokeWidth={0.75} />
                <span className="float-label l1">01 / BODY</span>
                <span className="float-label l2">02 / HEAD</span>
                <span className="float-label l3">03 / HAIR</span>
              </div>
              <div className="hero-flow">
                이미지 <ChevronRight /> 파츠 <ChevronRight /> 조립{" "}
                <ChevronRight /> Unity
              </div>
            </div>
            <div className="section-title">
              <h2>
                내 프로젝트 <small>{state.projects.length}</small>
              </h2>
              <button
                onClick={async () => {
                  const p = await run<Project>({ type: "project.open" });
                  if (p) open(p);
                }}
              >
                <FolderOpen size={16} /> 프로젝트 열기
              </button>
            </div>
            <div className="project-grid">
              {state.projects.map((project) => {
                const running =
                  project.jobs.some((job) =>
                    ["queued", "submitting", "running"].includes(job.status),
                  ) ||
                  state.workbenches?.some(
                    (workbench) =>
                      workbench.projectId === project.id &&
                      workbench.jobs.some((job) => job.status === "running"),
                  ) ||
                  state.productionRuns?.some(
                    (production) =>
                      production.projectId === project.id &&
                      (production.status === "running" ||
                        production.stages.some(
                          (stage) => stage.status === "running",
                        )),
                  );
                return (
                  <article
                    className="project-card"
                    key={project.id}
                    data-testid="project-card"
                    data-project-id={project.id}
                  >
                    <button
                      type="button"
                      className="project-open"
                      data-testid="project-open"
                      data-project-id={project.id}
                      aria-label={`${project.name} 프로젝트 열기`}
                      onClick={() => open(project)}
                    >
                      <div className="project-cover">
                        {project.selectedImageId ? (
                          <AssetImage
                            p={project}
                            a={project.assets.find(
                              (a) => a.id === project.selectedImageId,
                            )}
                          />
                        ) : (
                          <Boxes size={52} strokeWidth={1} />
                        )}
                        <Badge tone={project.demo ? "amber" : "neutral"}>
                          {project.demo ? "데모 프로젝트" : "개인 프로젝트"}
                        </Badge>
                      </div>
                      <div className="project-meta">
                        <h3>{project.name}</h3>
                        <p>
                          {project.parts.length}개 파츠 ·{" "}
                          {project.assets.length}개 에셋
                        </p>
                        <small>
                          {new Date(project.updatedAt).toLocaleDateString(
                            "ko-KR",
                          )}{" "}
                          <ChevronRight size={15} />
                        </small>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="project-delete"
                      data-testid="project-delete"
                      data-project-id={project.id}
                      aria-label={`${project.name} 프로젝트 삭제`}
                      title={
                        running
                          ? "프로젝트 작업이 진행 중이라 삭제할 수 없습니다."
                          : busy
                            ? "작업 처리 후 삭제할 수 있습니다."
                            : "프로젝트 삭제"
                      }
                      disabled={busy || Boolean(running)}
                      onClick={() => void deleteProject(project)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </article>
                );
              })}
              <button className="new-project" onClick={() => setCreate(true)}>
                <Plus size={28} />
                <span>새로운 캐릭터 만들기</span>
                <small>몸체 · 머리 · 헤어부터 시작</small>
              </button>
            </div>
            <div className="footnote">
              <CircleHelp size={16} /> 이미지 생성 도구 · Tripo Studio · Blender
              + Astra를 단계별로 연결합니다. 사용자가 결과를 채택한 뒤 다음
              작업을 실행합니다.
            </div>
          </main>
        )}
        {p && tab !== "home" && tab !== "settings" && (
          <>
            <div className="stage-heading">
              <div>
                <span className="eyebrow">
                  {String(steps.findIndex((s) => s[0] === tab) + 1).padStart(
                    2,
                    "0",
                  )}{" "}
                  / CHARACTER PIPELINE
                </span>
                <h1>
                  {headerTitle}
                  {p.demo && <Badge tone="amber">데모</Badge>}
                </h1>
              </div>
              <div className="stage-actions">
                <Badge>{p.style}</Badge>
                <button
                  title="프로젝트 백업"
                  onClick={() =>
                    run(
                      { type: "project.export", id: p.id },
                      "프로젝트 백업을 저장했습니다.",
                    )
                  }
                >
                  <Download size={16} />
                </button>
                {tab === "assembly" && (
                  <button
                    className="primary"
                    onClick={() =>
                      run(
                        {
                          type: "assembly.save",
                          id: p.id,
                          name: `조합 ${p.assemblies.length + 1}`,
                        },
                        "파츠 조합을 저장했습니다.",
                      )
                    }
                  >
                    <Save size={15} /> 조합 저장
                  </button>
                )}
              </div>
            </div>
            {tab === "workbench" && (
              <AssetWorkbench
                key={p.id}
                project={p}
                workbench={(state.workbenches ?? []).find(
                  (w) => w.projectId === p.id,
                )}
                legacyRuns={(state.productionRuns ?? []).filter(
                  (r) => r.projectId === p.id,
                )}
                run={run}
                busy={busy}
              />
            )}
            {tab === "studio" && (
              <TripoStudio
                key={p.id}
                project={p}
                request={request}
                run={run}
                busy={busy}
                navigate={setTab}
              />
            )}
            {tab === "image" && (
              <main className="image-layout">
                <section className="image-main">
                  <div className="image-display">
                    {selectedImage ? (
                      <AssetImage p={p} a={selectedImage} />
                    ) : (
                      <Empty
                        icon={ImagePlus}
                        title="첫 번째 레퍼런스를 만들어 보세요"
                      >
                        프롬프트로 생성하거나 이미지를 가져올 수 있습니다.
                      </Empty>
                    )}
                    {selectedImage && (
                      <Badge>
                        {selectedImage.origin === "tripo"
                          ? "Tripo 생성"
                          : selectedImage.origin === "demo"
                            ? "데모"
                            : "로컬 이미지"}{" "}
                        · {selectedImage.label}
                      </Badge>
                    )}
                  </div>
                  <div className="candidate-heading">
                    <h3>
                      이미지 후보와 수정 이력{" "}
                      <small>
                        {
                          p.assets.filter(
                            (a) => a.kind === "image" && a.origin !== "crop",
                          ).length
                        }
                      </small>
                    </h3>
                    <button
                      onClick={() =>
                        run({ type: "asset.import", id: p.id, kind: "image" })
                      }
                    >
                      <Upload size={14} /> 가져오기
                    </button>
                  </div>
                  <div className="image-candidates">
                    {p.assets
                      .filter((a) => a.kind === "image" && a.origin !== "crop")
                      .map((a) => (
                        <button
                          key={a.id}
                          className={`image-card ${a.id === p.selectedImageId ? "active" : ""}`}
                          onClick={() =>
                            run({
                              type: "image.select",
                              id: p.id,
                              assetId: a.id,
                            })
                          }
                        >
                          <AssetImage p={p} a={a} />
                          <span>
                            {a.parentId ? "수정본" : "원본"} · {a.label}
                          </span>
                          {a.id === p.selectedImageId && <Check size={16} />}
                        </button>
                      ))}
                  </div>
                </section>
                <aside className="inspector wide">
                  <div className="panel-heading">
                    <Sparkles size={17} />
                    <h3>이미지 만들기</h3>
                  </div>
                  <div className="segmented fill">
                    <button
                      className={!edit ? "active" : ""}
                      onClick={() => setEdit(false)}
                    >
                      새 이미지
                    </button>
                    <button
                      className={edit ? "active" : ""}
                      onClick={() => setEdit(true)}
                      disabled={!selectedImage}
                    >
                      선택 이미지 수정
                    </button>
                  </div>
                  <Field label={edit ? "수정 프롬프트" : "캐릭터 프롬프트"}>
                    <textarea
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder="예: 짧은 민트색 머리의 탐험가, 정면 T 포즈, 단색 배경, 스타일라이즈드 3D 게임 캐릭터"
                      rows={7}
                    />
                  </Field>
                  <Field
                    label="이미지 모델"
                    hint="공식 문서 등재 · 계정 접근 여부 미검증"
                  >
                    <select
                      value={model}
                      onChange={(e) => {
                        setModel(e.target.value);
                        setSize(
                          catalog.image.find((m) => m.id === e.target.value)!
                            .sizes[0],
                        );
                      }}
                    >
                      {catalog.image.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="two-col">
                    <Field label="해상도">
                      <select
                        value={size}
                        onChange={(e) => setSize(e.target.value)}
                      >
                        {catalog.image
                          .find((m) => m.id === model)!
                          .sizes.map((s) => (
                            <option key={s}>{s}</option>
                          ))}
                      </select>
                    </Field>
                    {!edit && (
                      <Field label="후보 수">
                        <select
                          value={count}
                          onChange={(e) => setCount(+e.target.value)}
                        >
                          {[1, 2, 3, 4].map((c) => (
                            <option key={c} value={c}>
                              {c}개
                            </option>
                          ))}
                        </select>
                      </Field>
                    )}
                  </div>
                  <div className="note">
                    <ShieldCheck size={16} />
                    <span>
                      생성 전 입력과 비용 확인 화면이 열립니다. 자동 유료
                      재시도는 없습니다.
                    </span>
                  </div>
                  <button
                    className="primary full"
                    disabled={
                      busy || !prompt.trim() || (edit && !selectedImage)
                    }
                    onClick={() =>
                      request({
                        kind: edit ? "edit" : "image",
                        prompt,
                        model,
                        size,
                        count: edit ? 1 : count,
                        sourceId: edit ? selectedImage?.id : undefined,
                      })
                    }
                  >
                    <Sparkles size={16} /> 생성 요청 검토
                  </button>
                  <button
                    className="full"
                    disabled={!selectedImage}
                    onClick={() => setTab("parts")}
                  >
                    선택 이미지를 파츠로 준비 <ChevronRight size={16} />
                  </button>
                  <div className="inspector-footer">
                    <Badge tone={state.key.configured ? "green" : "amber"}>
                      {state.key.configured ? "API 키 설정됨" : "API 연결 필요"}
                    </Badge>
                    <button onClick={() => setTab("settings")}>
                      연결 설정 <ArrowUpRight size={13} />
                    </button>
                  </div>
                </aside>
              </main>
            )}
            {(tab === "parts" || tab === "assembly") && (
              <main className="workbench">
                <aside className="parts-panel">
                  <div className="panel-heading">
                    <h3>파츠</h3>
                    <span>{p.parts.length}</span>
                    <button
                      title="파츠 추가"
                      onClick={() =>
                        run({
                          type: "part.add",
                          id: p.id,
                          name: `추가 파츠 ${p.parts.length + 1}`,
                        })
                      }
                    >
                      <Plus size={15} />
                    </button>
                  </div>
                  <div className="parts-list">
                    {p.parts.map((item, i) => (
                      <button
                        key={item.id}
                        onClick={() => {
                          setPartId(item.id);
                          setPreview("");
                        }}
                        className={`part-card ${item.id === part?.id ? "active" : ""}`}
                      >
                        <div className="part-icon">
                          {item.imageId ? (
                            <AssetImage
                              p={p}
                              a={p.assets.find((a) => a.id === item.imageId)}
                            />
                          ) : (
                            <Box size={21} />
                          )}
                        </div>
                        <div>
                          <strong>{item.name}</strong>
                          <small>
                            {item.selectedId
                              ? "모델 선택됨"
                              : item.imageId
                                ? "이미지 준비됨"
                                : "이미지 준비 필요"}
                          </small>
                        </div>
                        <span>
                          {item.locked ? (
                            <Lock size={12} />
                          ) : (
                            String(i + 1).padStart(2, "0")
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="panel-bottom">
                    <div className="mini-title">전체 레퍼런스</div>
                    <div className="reference-mini">
                      <AssetImage p={p} a={selectedImage} />
                    </div>
                    <p>전체 이미지는 외형·비율 참고용으로 유지됩니다.</p>
                    <button className="full" onClick={() => setTab("image")}>
                      레퍼런스 변경 <ChevronRight size={14} />
                    </button>
                  </div>
                </aside>
                <div className="workspace-center">
                  {tab === "parts" ? (
                    selectedImage && part ? (
                      <CropEditor
                        key={selectedImage.id}
                        project={p}
                        asset={selectedImage}
                        onSave={(rect, polygon) =>
                          run(
                            {
                              type: "part.crop",
                              id: p.id,
                              partId: part.id,
                              sourceId: selectedImage.id,
                              rect,
                              polygon,
                            },
                            "파츠 이미지를 저장했습니다.",
                          )
                        }
                      />
                    ) : (
                      <Empty icon={Scissors} title="전체 레퍼런스가 필요합니다">
                        이미지 스튜디오에서 이미지를 생성하거나 가져오세요.
                      </Empty>
                    )
                  ) : (
                    <Viewport
                      project={p}
                      selectedPart={part?.id}
                      previewId={preview || undefined}
                      onSelect={setPartId}
                      onTransform={(partId, transform) =>
                        run({
                          type: "part.update",
                          id: p.id,
                          partId,
                          patch: { transform },
                        })
                      }
                    />
                  )}
                  <div className="candidate-tray">
                    <div className="candidate-heading">
                      <h3>
                        {part?.name ?? "파츠"} 후보{" "}
                        <small>{part?.candidates.length ?? 0}</small>
                      </h3>
                      <button
                        disabled={!part}
                        onClick={() =>
                          run({
                            type: "asset.import",
                            id: p.id,
                            kind: "model",
                            partId: part?.id,
                          })
                        }
                      >
                        <Upload size={14} /> GLB 가져오기
                      </button>
                    </div>
                    <div className="model-candidates">
                      {part?.candidates.map((aid, i) => (
                        <div
                          className={`model-card ${part.selectedId === aid ? "active" : ""}`}
                          key={aid}
                        >
                          <button
                            className="model-thumbnail"
                            onClick={() => setPreview(aid)}
                          >
                            <Box size={27} />
                            <span>GLB</span>
                          </button>
                          <strong>후보 {String(i + 1).padStart(2, "0")}</strong>
                          <small>
                            {p.assets.find((a) => a.id === aid)?.origin ===
                            "tripo"
                              ? "Tripo 생성"
                              : "가져온 모델"}
                          </small>
                          <button
                            disabled={part.locked}
                            onClick={() => {
                              patchPart({ selectedId: aid });
                              setPreview("");
                            }}
                          >
                            {part.selectedId === aid ? (
                              <>
                                <Check size={12} /> 선택됨
                              </>
                            ) : (
                              "이 후보 선택"
                            )}
                          </button>
                        </div>
                      ))}
                      {!part?.candidates.length && (
                        <div className="tray-empty">
                          <Box size={24} />
                          <span>
                            아직 생성한 후보가 없습니다.
                            <small>
                              파츠 이미지를 준비한 뒤 3D 생성을 시작하세요.
                            </small>
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <aside className="inspector">
                  {part && (
                    <>
                      <div className="panel-heading">
                        <h3>파츠 속성</h3>
                        <div className="inline-actions">
                          <button
                            title={part.locked ? "고정 해제" : "파츠 고정"}
                            onClick={() => patchPart({ locked: !part.locked })}
                          >
                            {part.locked ? (
                              <Lock size={15} />
                            ) : (
                              <Unlock size={15} />
                            )}
                          </button>
                          <button
                            title="파츠 표시 전환"
                            onClick={() =>
                              patchPart({ visible: !part.visible })
                            }
                          >
                            {part.visible ? (
                              <Eye size={15} />
                            ) : (
                              <EyeOff size={15} />
                            )}
                          </button>
                        </div>
                      </div>
                      <Field label="파츠 이름">
                        <input
                          key={part.id + "name"}
                          defaultValue={part.name}
                          disabled={part.locked}
                          onBlur={(e) =>
                            e.target.value !== part.name &&
                            patchPart({ name: e.target.value })
                          }
                        />
                      </Field>
                      <div className="part-reference">
                        <AssetImage
                          p={p}
                          a={p.assets.find((a) => a.id === part.imageId)}
                        />
                        {part.imageId && <Badge>파츠 입력</Badge>}
                      </div>
                      <button
                        className="full subtle"
                        disabled={part.locked}
                        onClick={() =>
                          run({
                            type: "asset.import",
                            id: p.id,
                            kind: "image",
                            partId: part.id,
                          })
                        }
                      >
                        <Upload size={14} /> 파츠 이미지 가져오기
                      </button>
                      <Field
                        label="파츠 프롬프트 / 작업 메모"
                        hint="3D API는 이미지 기반입니다. 외형 수정은 이미지 단계에서 적용하세요."
                      >
                        <textarea
                          key={part.id + "prompt"}
                          defaultValue={part.prompt}
                          onBlur={(e) =>
                            e.target.value !== part.prompt &&
                            patchPart({ prompt: e.target.value })
                          }
                          placeholder="숨겨진 뒷면, 접합 위치, 원하는 외형…"
                          rows={2}
                        />
                      </Field>
                      {tab === "parts" ? (
                        <>
                          <label className="checkbox">
                            <input
                              type="checkbox"
                              checked={part.occluded}
                              onChange={(e) =>
                                patchPart({ occluded: e.target.checked })
                              }
                            />{" "}
                            가려진 영역 복원 필요
                          </label>
                          <div className="note amber">
                            <AlertTriangle size={16} />
                            <span>
                              수동 영역 선택·마스크를 지원합니다. 자동 분할과
                              가려진 면 복원은 미구현이며, 잘라내기는 3D 복원이
                              아닙니다.
                            </span>
                          </div>
                          <button
                            className="primary full"
                            onClick={() => setTab("assembly")}
                          >
                            조립 작업실로 <ChevronRight size={16} />
                          </button>
                        </>
                      ) : (
                        <>
                          <div className="divider" />
                          <div className="mini-title">
                            변환 <span>위치 m · 회전 °</span>
                          </div>
                          {(["position", "rotation", "scale"] as const).map(
                            (key, i) => (
                              <div className="transform-row" key={key}>
                                <span>{["위치", "회전", "크기"][i]}</span>
                                {part.transform[key].map((v, axis) => (
                                  <label key={axis}>
                                    <span className={`axis-${axis}`}>
                                      {["X", "Y", "Z"][axis]}
                                    </span>
                                    <input
                                      key={part.id + key + axis + v}
                                      type="number"
                                      defaultValue={Number(v.toFixed(3))}
                                      step={key === "rotation" ? 5 : 0.01}
                                      disabled={part.locked}
                                      onBlur={(e) => {
                                        const value = +e.target.value;
                                        if (value === v) return;
                                        const values = [
                                          ...part.transform[key],
                                        ] as [number, number, number];
                                        values[axis] = value;
                                        patchPart({
                                          transform: {
                                            ...part.transform,
                                            [key]: values,
                                          },
                                        });
                                      }}
                                    />
                                  </label>
                                ))}
                              </div>
                            ),
                          )}
                          <button
                            className="full subtle"
                            onClick={() => {
                              setPreview("");
                              patchPart({
                                transform: {
                                  position: [
                                    0,
                                    part.role === "body"
                                      ? 0
                                      : p.height *
                                        (part.role === "head" ? 0.84 : 0.96),
                                    0,
                                  ],
                                  rotation: [0, 0, 0],
                                  scale: [1, 1, 1],
                                },
                              });
                            }}
                            disabled={part.locked}
                          >
                            역할 기준점에 배치
                          </button>
                          <Field label="3D 모델">
                            <select
                              value={model3d}
                              onChange={(e) => setModel3d(e.target.value)}
                            >
                              {catalog.model.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.label}
                                </option>
                              ))}
                            </select>
                          </Field>
                          <div className="two-col">
                            <div className="generation-detail">
                              모델 1개<small>프롬프트로 수정·리롤</small>
                            </div>
                            <div className="generation-detail">
                              20k faces<small>PBR · standard</small>
                            </div>
                          </div>
                          <button
                            className="primary full"
                            disabled={!part.imageId || part.locked || busy}
                            onClick={() =>
                              request({
                                kind: "model",
                                prompt: part.prompt,
                                model: model3d,
                                faceLimit: 20000,
                                count: 1,
                                partId: part.id,
                              })
                            }
                          >
                            <Sparkles size={15} /> 이 파츠 생성 검토
                          </button>
                        </>
                      )}
                      <button
                        className="danger-link"
                        disabled={part.locked}
                        onClick={() =>
                          run({
                            type: "part.delete",
                            id: p.id,
                            partId: part.id,
                          })
                        }
                      >
                        <Trash2 size={12} /> 파츠 삭제
                      </button>
                    </>
                  )}
                </aside>
              </main>
            )}
            {tab === "assembly" && (
              <div className="assembly-bar">
                <span>
                  <Layers3 size={15} /> 저장한 조합
                </span>
                {p.assemblies.map((a) => (
                  <button
                    key={a.id}
                    onClick={() =>
                      run(
                        {
                          type: "assembly.restore",
                          id: p.id,
                          assemblyId: a.id,
                        },
                        "저장한 조합을 불러왔습니다.",
                      )
                    }
                  >
                    {a.name}
                  </button>
                ))}
                <div className="spacer" />
                <button
                  disabled={busy}
                  onClick={() =>
                    run(
                      { type: "blender.build", id: p.id, mode: "assemble" },
                      "Blender 조립 출력 완료. 표면 접합과 리깅은 별도 검수가 필요합니다.",
                    )
                  }
                >
                  <Box size={15} /> Blender로 조립
                </button>
                <button onClick={() => setTab("rig")}>
                  리깅 검수 <ChevronRight size={14} />
                </button>
              </div>
            )}
            {tab === "rig" && (
              <main className="rig-layout">
                <div className="rig-main">
                  <Viewport
                    project={p}
                    previewId={preview || latest?.id}
                    animation
                  />
                  <div className="rig-cautions">
                    <h3>변형을 확인하세요</h3>
                    <div>
                      <span>
                        01 <b>어깨 · 팔꿈치</b> 관절 변형
                      </span>
                      <span>
                        02 <b>목 · 허리</b> 접합부 틈
                      </span>
                      <span>
                        03 <b>헤어 · 소품</b> 뼈대 이탈
                      </span>
                    </div>
                  </div>
                </div>
                <aside className="inspector wide">
                  <div className="panel-heading">
                    <h3>리깅 파이프라인</h3>
                    <Badge tone={currentBuild ? "green" : "amber"}>
                      {currentBuild ? "현재 버전" : "출력 필요"}
                    </Badge>
                  </div>
                  <Field label="검수할 모델">
                    <select
                      value={preview || latest?.id || ""}
                      onChange={(e) => setPreview(e.target.value)}
                    >
                      <option value="">모델 선택</option>
                      {p.assets.filter(canPreview).map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {p.demo && (
                    <>
                      <div className="note amber">
                        <AlertTriangle size={17} />
                        <span>
                          데모는 절차적으로 만든 마네킹과 기본 동작입니다. AI
                          생성·상용 리깅 품질을 검증하지 않습니다.
                        </span>
                      </div>
                      <button
                        className="primary full"
                        disabled={busy}
                        onClick={async () => {
                          const result = await run(
                            {
                              type: "blender.build",
                              id: p.id,
                              mode: "demo-rig",
                            },
                            "데모 마네킹·Idle·Walk 출력 완료",
                          );
                          if (result) setPreview(result.id);
                        }}
                      >
                        <Play size={16} /> 로컬 데모 리깅 실행
                      </button>
                    </>
                  )}
                  <div className="numbered-step">
                    <span>1</span>
                    <div>
                      <h4>최종 메시 적합성</h4>
                      <p>조립 버전과 입력 모델에 검사 결과를 연결합니다.</p>
                      <button
                        disabled={!preview && !latest}
                        onClick={() =>
                          request({
                            kind: "rig-check",
                            prompt: "",
                            model: "rig-check",
                            count: 1,
                            sourceId: preview || latest?.id,
                          })
                        }
                      >
                        Tripo 검사 요청 검토
                      </button>
                    </div>
                  </div>
                  <div className="numbered-step">
                    <span>2</span>
                    <div>
                      <h4>인간형 자동 리깅</h4>
                      <p>Mixamo 뼈대 명명 · humanoid v1</p>
                      <button
                        disabled={!preview && !latest}
                        onClick={() =>
                          request({
                            kind: "rig",
                            prompt: "",
                            model: "v1.0-20240301",
                            count: 1,
                            sourceId: preview || latest?.id,
                          })
                        }
                      >
                        Tripo 리깅 요청 검토
                      </button>
                    </div>
                  </div>
                  <div className="numbered-step">
                    <span>3</span>
                    <div>
                      <h4>기본 동작 적용</h4>
                      <div className="inline-actions">
                        {["idle", "walk"].map((anim) => (
                          <button
                            key={anim}
                            onClick={() =>
                              request({
                                kind: "animate",
                                prompt: "",
                                model: "v1.0-20240301",
                                count: 1,
                                sourceTaskId: p.jobs
                                  .filter(
                                    (j) =>
                                      j.kind === "rig" &&
                                      j.status === "success",
                                  )
                                  .at(-1)?.remoteId,
                                animation: `preset:biped:${anim}`,
                              })
                            }
                          >
                            {anim === "idle" ? "대기" : "걷기"} 요청 검토
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <button
                    className="full"
                    disabled={!preview}
                    onClick={() =>
                      run(
                        {
                          type: "blender.build",
                          id: p.id,
                          mode: "convert",
                          assetId: preview,
                        },
                        "FBX·GLB 변환 완료",
                      )
                    }
                  >
                    검수 모델을 Unity용 FBX로 변환
                  </button>
                  {latest && (
                    <button
                      className="full"
                      onClick={() =>
                        run({
                          type: "blender.open",
                          id: p.id,
                          buildId: latest.id,
                        })
                      }
                    >
                      <ExternalLink size={15} /> Blender에서 수동 보정
                    </button>
                  )}
                  <div className="note">
                    <CircleHelp size={16} />
                    <span>
                      메시·UV를 수정하면 텍스처를 다시 검수하세요. 수정한 GLB를
                      가져와 새 후보로 등록할 수 있습니다.
                    </span>
                  </div>
                </aside>
              </main>
            )}
            {tab === "unity" && (
              <main className="page unity-page">
                <div className="unity-top">
                  <div>
                    <div className="eyebrow">READY FOR YOUR GAME</div>
                    <h2>제작실에서 게임으로.</h2>
                    <p>
                      Avatar, 재질, 애니메이션과 Prefab을 한 번에 연결합니다.
                    </p>
                  </div>
                  <Box size={72} strokeWidth={0.7} />
                </div>
                <div className="unity-columns">
                  <section className="surface">
                    <h3>임포트 설정</h3>
                    <Field label="대상 Unity 프로젝트">
                      <input
                        defaultValue={p.unityPath}
                        onBlur={(e) =>
                          run({
                            type: "project.update",
                            id: p.id,
                            patch: { unityPath: e.target.value },
                          })
                        }
                      />
                    </Field>
                    <Field label="Assets 하위 생성 폴더">
                      <input
                        defaultValue={p.unityFolder}
                        onBlur={(e) =>
                          run({
                            type: "project.update",
                            id: p.id,
                            patch: { unityFolder: e.target.value },
                          })
                        }
                      />
                    </Field>
                    <div className="two-col">
                      <Field label="목표 키 (m)">
                        <input
                          type="number"
                          min="0.1"
                          max="10"
                          step="0.1"
                          defaultValue={p.height}
                          onBlur={(e) =>
                            +e.target.value !== p.height &&
                            run({
                              type: "project.update",
                              id: p.id,
                              patch: { height: +e.target.value },
                            })
                          }
                        />
                      </Field>
                      <Field label="제작 스타일">
                        <input
                          defaultValue={p.style}
                          onBlur={(e) =>
                            run({
                              type: "project.update",
                              id: p.id,
                              patch: { style: e.target.value },
                            })
                          }
                        />
                      </Field>
                    </div>
                    <div className="note">
                      <ShieldCheck size={17} />
                      <span>
                        Generated는 앱이 관리하고 User/Character.prefab은 사용자
                        편집용입니다. 기존 씬은 보존됩니다.
                      </span>
                    </div>
                    <button
                      className="full"
                      onClick={() =>
                        run(
                          { type: "unity.install", id: p.id },
                          "Unity Editor 브리지를 설치했습니다. Unity에서 컴파일을 기다려 주세요.",
                        )
                      }
                    >
                      <Link size={16} /> Unity 브리지 설치
                    </button>
                    <button
                      className="primary full"
                      disabled={!currentBuild || busy}
                      onClick={() =>
                        latest &&
                        run(
                          {
                            type: "unity.import",
                            id: p.id,
                            buildId: latest.id,
                          },
                          "임포트 요청을 보냈습니다. 열려 있는 Unity 프로젝트에서 처리됩니다.",
                        )
                      }
                    >
                      <Box size={16} /> Unity에 임포트
                    </button>
                    {!currentBuild && (
                      <small className="warning-text">
                        현재 파츠 버전의 Blender 출력이 필요합니다.
                      </small>
                    )}
                  </section>
                  <section className="surface result-panel">
                    <div className="section-title">
                      <h3>검증 결과</h3>
                      <button
                        onClick={() => run({ type: "unity.result", id: p.id })}
                      >
                        <RefreshCw size={15} />
                      </button>
                    </div>
                    {p.unity ? (
                      <>
                        <Badge
                          tone={
                            p.unity.errors.length
                              ? "red"
                              : p.unity.runtimePlayModeVerified ||
                                  p.unity.playbackVerified
                                ? "green"
                                : "amber"
                          }
                        >
                          {p.unity.status === "complete_review_required"
                            ? "임포트 완료 · 육안 검수 필요"
                            : p.unity.status === "failed"
                              ? "임포트 실패"
                              : "보정 필요"}
                        </Badge>
                        {[
                          [
                            "Humanoid Avatar",
                            p.unity.avatarValid && p.unity.avatarHuman,
                          ],
                          [
                            "Play Mode 동작 재생",
                            p.unity.runtimePlayModeVerified,
                          ],
                          ["현재 조립 버전", p.unity.revision === p.revision],
                          ["기본 애니메이션", p.unity.clips.length > 0],
                        ].map(([label, ok]) => (
                          <div className="check-row" key={String(label)}>
                            {ok ? (
                              <CheckCircle2 size={19} />
                            ) : (
                              <AlertTriangle size={19} />
                            )}
                            <span>{label}</span>
                            <Badge tone={ok ? "green" : "amber"}>
                              {ok ? "확인" : "보정 필요"}
                            </Badge>
                          </div>
                        ))}
                        <Field label="생성 Prefab">
                          <code>{p.unity.prefabPath}</code>
                        </Field>
                        <Field label="테스트 씬">
                          <code>{p.unity.scenePath}</code>
                        </Field>
                        <div className="result-warnings">
                          {p.unity.errors.map((w, i) => (
                            <p className="warning-text" key={"e" + i}>
                              {w}
                            </p>
                          ))}
                          {p.unity.warnings.map((w, i) => (
                            <p key={i}>{w}</p>
                          ))}
                        </div>
                        <small>
                          Unity Tools → Partsmith → Play latest test scene에서
                          직접 확인하세요.
                        </small>
                      </>
                    ) : (
                      <Empty icon={Box} title="아직 임포트 결과가 없습니다">
                        브리지를 설치하고 출력물을 보내면 실제 Unity 검사 결과가
                        표시됩니다.
                      </Empty>
                    )}
                  </section>
                </div>
              </main>
            )}
            {tab !== "workbench" && (
              <JobPanel
                p={p}
                run={run}
                remoteId={remoteId}
                setRemoteId={setRemoteId}
              />
            )}
          </>
        )}
        {tab === "settings" && <SettingsPanel state={state} run={run} />}
        <footer className="statusbar">
          <span>
            <span className="status-dot" /> 로컬 엔진 준비됨
          </span>
          <span>
            {tab === "workbench"
              ? "단계별 선택 · Blender + Astra"
              : state.key.configured
                ? "Tripo API 키 설정됨 · 모델 접근 미검증"
                : "Tripo API 미연결"}{" "}
            <i />{" "}
            {p
              ? `${p.parts.length} PARTS · REV ${p.revision}`
              : "개인용 제작 도구"}
          </span>
        </footer>
      </div>
      {create && (
        <div className="modal-backdrop">
          <section role="dialog" aria-modal="true" className="modal">
            <div className="section-title">
              <h2>새 프로젝트</h2>
              <button onClick={() => setCreate(false)}>
                <X size={20} />
              </button>
            </div>
            <Field label="프로젝트 이름">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={demo}
                onChange={(e) => setDemo(e.target.checked)}
              />{" "}
              로컬 데모 테스트 프로젝트
            </label>
            <p>
              몸체·머리·헤어 파츠로 시작합니다. 구성은 자유롭게 바꿀 수
              있습니다.
            </p>
            <button
              className="primary full"
              disabled={busy || !name.trim()}
              onClick={async () => {
                const p = await run<Project>({
                  type: "project.create",
                  name,
                  demo,
                });
                if (p) {
                  setCreate(false);
                  open(p);
                  if (demo) setTab("rig");
                }
              }}
            >
              프로젝트 만들기 <ChevronRight size={17} />
            </button>
          </section>
        </div>
      )}
      {quote && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true">
            <div className="section-title">
              <h2>
                {quote.request.kind === "rig-check"
                  ? "무료 검사 요청 검토"
                  : "유료 요청 검토"}
              </h2>
              <button onClick={() => setQuote(undefined)}>
                <X size={20} />
              </button>
            </div>
            <Badge tone="amber">Tripo API · 계정 접근 미검증</Badge>
            <dl className="quote-details">
              <dt>단계</dt>
              <dd>
                {operationLabels[quote.request.kind] ?? quote.request.kind}
              </dd>
              <dt>모델</dt>
              <dd>{quote.request.model}</dd>
              <dt>후보 수</dt>
              <dd>
                {quote.request.count}개 · 최대 {quote.request.count}회 제출
              </dd>
              <dt>해상도</dt>
              <dd>{quote.request.size ?? "해당 없음"}</dd>
              <dt>입력</dt>
              <dd>{quote.inputSummary}</dd>
              <dt>예상 비용</dt>
              <dd className="warning-text">
                {quote.estimatedCredits === 0
                  ? "0 credits · 무료 검사"
                  : "계정별 비용 확인 불가 · 승인 시 과금될 수 있습니다"}
              </dd>
            </dl>
            <RequestOptions request={quote.request} />
            <div className="note amber">
              <AlertTriangle size={18} />
              <span>
                입력 파일과 프롬프트가 Tripo로 전송됩니다. API 크레딧은 Studio
                구독과 별도이며, 원격 취소는 보장되지 않습니다.
              </span>
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />{" "}
              {quote.estimatedCredits === 0
                ? "입력 모델 전송에 동의하며 무료 검사를 실행합니다."
                : "비용이 미확인임을 이해하며 표시된 요청만 실행합니다."}
            </label>
            <button
              className="primary full"
              disabled={!accepted || !state.key.configured || busy}
              onClick={async () => {
                const jobs = await run({
                  type: "generation.approve",
                  quoteId: quote.id,
                  unknownCostAccepted: accepted,
                });
                if (jobs) setQuote(undefined);
              }}
            >
              승인하고 {quote.request.count}개 요청
            </button>
            {!state.key.configured && (
              <p className="warning-text">
                연결 설정에서 API 키를 먼저 입력하세요.
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
function JobPanel({
  p,
  run,
  remoteId,
  setRemoteId,
}: {
  p: Project;
  run: (c: Command, s?: string) => Promise<any>;
  remoteId: string;
  setRemoteId: (s: string) => void;
}) {
  return (
    <details className="jobs">
      <summary>
        <Clock size={14} />
        <strong>작업 기록</strong>
        <span>
          {
            p.jobs.filter((j) =>
              ["running", "queued", "submitting"].includes(j.status),
            ).length
          }
          개 진행 중
        </span>
        <small>총 {p.jobs.length}개</small>
      </summary>
      <div className="jobs-list">
        {p.jobs.length === 0 ? (
          <p>요청한 작업이 없습니다. 모의 성공 결과를 표시하지 않습니다.</p>
        ) : (
          p.jobs.toReversed().map((j: Job) => (
            <div className="job" key={j.id}>
              <div>
                <Badge
                  tone={
                    j.status === "success"
                      ? "green"
                      : ["failed", "submission_unknown"].includes(j.status)
                        ? "amber"
                        : "neutral"
                  }
                >
                  {labels[j.status]}
                </Badge>
                <strong>
                  {operationLabels[j.kind] ?? j.kind} · {j.request.model}
                </strong>
                <small>{j.remoteId ?? j.id}</small>
                <p>{j.message}</p>
                {j.credits !== undefined && (
                  <small>실제 사용량 {j.credits} credits</small>
                )}
              </div>
              <progress max="100" value={j.progress} />
              <div className="job-actions">
                {j.remoteId && j.status !== "success" && (
                  <button
                    onClick={() =>
                      run({ type: "job.poll", id: p.id, jobId: j.id })
                    }
                  >
                    기존 작업 조회
                  </button>
                )}
                {["running", "queued", "submitting"].includes(j.status) && (
                  <button
                    onClick={() =>
                      run({ type: "job.cancel", id: p.id, jobId: j.id })
                    }
                  >
                    추적/대기 중지
                  </button>
                )}
                {j.status === "submission_unknown" && (
                  <>
                    <input
                      placeholder="task_… 기존 원격 ID"
                      value={remoteId}
                      onChange={(e) => setRemoteId(e.target.value)}
                    />
                    <button
                      onClick={() =>
                        run({
                          type: "job.reconcile",
                          id: p.id,
                          jobId: j.id,
                          remoteId,
                        })
                      }
                    >
                      연결
                    </button>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </details>
  );
}
function SettingsPanel({
  state,
  run,
}: {
  state: AppState;
  run: (c: Command, s?: string) => Promise<any>;
}) {
  const [key, setKey] = useState(""),
    [settings, setSettings] = useState<SettingsType>(state.settings),
    [balance, setBalance] = useState<any>(),
    [probe, setProbe] = useState<any>();
  return (
    <main className="page settings-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">CONNECTED, ON YOUR TERMS</div>
          <h1>도구를 연결하세요.</h1>
          <p>제작 파일은 로컬에, API 키는 운영체제 보안 저장소에 보관합니다.</p>
        </div>
        <ShieldCheck size={38} strokeWidth={1} />
      </div>
      <div className="settings-grid">
        <section className="surface">
          <div className="section-title">
            <h2>
              <Sparkles size={21} /> Tripo API
            </h2>
            <Badge tone={state.key.configured ? "green" : "amber"}>
              {state.key.configured ? "키 설정됨" : "미연결"}
            </Badge>
          </div>
          <Field
            label="Tripo 연결 지역"
            hint="API 키를 발급한 계정의 지역과 같아야 합니다."
          >
            <select
              aria-label="Tripo 연결 지역"
              value={settings.tripoRegion}
              onChange={async (e) => {
                const tripoRegion = e.target
                  .value as SettingsType["tripoRegion"];
                const saved = await run({
                  type: "settings.update",
                  settings: { ...state.settings, tripoRegion },
                });
                if (saved) {
                  setSettings({ ...settings, tripoRegion });
                  setBalance(undefined);
                }
              }}
            >
              <option value="international">국제 · openapi.tripo3d.ai</option>
              <option value="china">중국 · openapi.tripo3d.com</option>
            </select>
          </Field>
          <Field
            label="API 키"
            hint="API Key 값을 입력하세요. Client ID는 인증에 사용할 수 없습니다."
          >
            <input
              aria-label="Tripo API 키"
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={
                state.key.configured
                  ? "••••••••••••••••••••"
                  : "Tripo API 키 입력"
              }
            />
          </Field>
          <div className="inline-actions">
            <button
              className="primary"
              disabled={!key}
              onClick={async () => {
                const r = await run(
                  { type: "key.save", key },
                  "API 키를 저장했습니다.",
                );
                if (r) setKey("");
              }}
            >
              <Lock size={15} />{" "}
              {state.key.configured ? "키 교체" : "안전하게 저장"}
            </button>
            <button
              disabled={!state.key.configured}
              onClick={async () => {
                setBalance(undefined);
                const b = await run({ type: "key.check" });
                if (b) setBalance(b);
              }}
            >
              <Link size={15} /> 연결 확인
            </button>
            <button
              title="키 삭제"
              disabled={!state.key.configured}
              onClick={async () => {
                await run({ type: "key.delete" }, "저장한 키를 삭제했습니다.");
                setBalance(undefined);
              }}
            >
              <Trash2 size={15} />
            </button>
          </div>
          <div className="key-info">
            <ShieldCheck size={17} />
            {state.key.storage === "none"
              ? "저장된 키 없음"
              : state.key.storage}
          </div>
          {balance && (
            <div className="balance">
              <small>API 사용 가능 크레딧</small>
              <strong>
                {balance.balance ?? "미확인"} <span>credits</span>
              </strong>
              <small>예약 크레딧 {balance.frozen ?? "미확인"}</small>
            </div>
          )}
          <div className="note amber">
            <CircleHelp size={16} />
            <span>
              Studio 구독과 API 크레딧은 별도입니다. 잔액 조회 성공이 모든 모델
              사용 가능을 의미하지 않습니다.
            </span>
          </div>
          <p className="muted">{catalog.note}</p>
        </section>
        <section className="surface">
          <div className="section-title">
            <h2>
              <Link size={21} /> 로컬 도구
            </h2>
            <Badge>WINDOWS</Badge>
          </div>
          {(
            [
              ["blenderPath", "Blender 실행 파일"],
              ["unityPath", "기본 Unity 프로젝트"],
              ["unityEditorPath", "Unity Editor 실행 파일"],
            ] as const
          ).map(([k, label]) => (
            <Field key={k} label={label}>
              <input
                value={settings[k]}
                onChange={(e) =>
                  setSettings({ ...settings, [k]: e.target.value })
                }
              />
            </Field>
          ))}
          <div className="inline-actions">
            <button
              className="primary"
              onClick={() =>
                run(
                  { type: "settings.update", settings },
                  "로컬 경로를 저장했습니다.",
                )
              }
            >
              <Save size={15} /> 경로 저장
            </button>
            <button
              onClick={async () => {
                await run({ type: "settings.update", settings });
                const p = await run({ type: "settings.probe" });
                if (p) setProbe(p);
              }}
            >
              <RefreshCw size={15} /> 환경 확인
            </button>
          </div>
          {probe && (
            <div className="probe">
              <p>
                Blender <b>{probe.blenderVersion}</b>
              </p>
              <p>
                Unity <b>{probe.unityVersion.split("\n")[0]}</b>
              </p>
              <p>
                URP <b>{probe.urp}</b>
              </p>
            </div>
          )}
          <div className="note">
            <Unplug size={16} />
            <span>
              Blender는 로컬 Python으로, Unity는 Editor 브리지로 연결합니다.
              사용자 추가 MCP는 필요하지 않습니다.
            </span>
          </div>
        </section>
        <section className="surface storage">
          <h3>프로젝트 저장소</h3>
          <code>{state.dataDir}</code>
          <button onClick={() => run({ type: "folder.open" })}>
            <FolderOpen size={16} /> 폴더 열기
          </button>
          <p>SQLite + 로컬 에셋 · 저장 형식 v1 · 제작 엔진 계약 v1</p>
        </section>
      </div>
    </main>
  );
}
