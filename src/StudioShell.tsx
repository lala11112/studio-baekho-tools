import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Box,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  FolderOpen,
  Grid2X2,
  House,
  Layers3,
  LoaderCircle,
  Play,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
  Swords,
  X,
} from "lucide-react";
import { App } from "./App";
import { FourTigerItems } from './FourTigerItems';
import type {
  StudioBounds,
  StudioEntry,
  StudioNativeTool,
  StudioPage,
  StudioSummary,
  StudioTarget,
  StudioTool,
} from "../shared/studio";

const pages = [
  { id: "home", label: "홈", icon: House },
  { id: "tools", label: "도구", icon: Grid2X2 },
  { id: "runs", label: "실행", icon: Play },
  { id: "results", label: "결과", icon: Layers3 },
  { id: "settings", label: "설정", icon: Settings2 },
] as const;
const pageCopy: Record<StudioPage, { title: string; subtitle: string }> = {
  home: {
    title: "작업 공간",
    subtitle: "아이디어를 만들고, 움직임을 다듬는 곳",
  },
  tools: { title: "도구", subtitle: "지금 필요한 작업을 선택하세요." },
  runs: {
    title: "실행",
    subtitle: "진행 상황을 확인하고 원래 작업으로 돌아가세요.",
  },
  results: {
    title: "결과",
    subtitle: "만들어진 결과를 원래 도구에서 확인하세요.",
  },
  settings: {
    title: "설정",
    subtitle: "도구 연결과 작업이 저장되는 위치를 확인하세요.",
  },
};
const toolNames: Record<StudioTool, string> = {
  modeling: "3D 모델링",
  combat: "타격감 찾기",
  "hit-timing": "타격 타이밍",
  "four-tiger-items": "사인검 아이템",
};
const toolOrder = ["modeling", "combat", "hit-timing", "four-tiger-items"] as const;
const toolCopy: Record<
  StudioTool,
  {
    category: string;
    description: string;
    flow: string;
    input: string;
    output: string;
  }
> = {
  'four-tiger-items': {category:'ITEM WORKSHOP',description:'20개 아이템과 아이콘을 만들고 검토.',flow:'초안 → 아이콘·편집 → 채택·출력',input:'입력: 사인검 기획·효과·아이콘 요청',output:'결과: 검토한 아이템 JSON·PNG'},
  modeling: {
    category: "ASSET CREATION",
    description: "아이디어에서 게임에 쓸 3D 에셋까지.",
    flow: "이미지 → 모델링 → Unity",
    input: "입력: 콘셉트·참고 이미지",
    output: "결과: 3D 모델·리깅·애니메이션",
  },
  combat: {
    category: "GAME FEEL",
    description: "직접 보고 비교하며, 원하는 손맛으로.",
    flow: "수치 제안 → 실행·비교 → 설정 저장",
    input: "입력: Unity 프로젝트·실험 조건",
    output: "결과: 비교 영상·선택한 타격감 설정",
  },
  "hit-timing": {
    category: "HIT TIMING",
    description: "애니메이션의 공격 판정 구간을 제안하고 검토.",
    flow: "프레임 촬영 → AI 제안 → 구간 검토",
    input: "입력: Unity 프로젝트·공격 애니메이션",
    output: "결과: 타이밍 제안·검토한 구간 설정",
  },
};
const toneNames: Record<StudioEntry["tone"], string> = {
  neutral: "대기·준비",
  active: "진행 중",
  review: "확인 필요",
  success: "완료",
  error: "오류",
};
type ModelingNavigation = {
  key: number;
  projectId?: string;
  tab?: string;
  create?: boolean;
};

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function dateLabel(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "날짜 정보 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function ToolIcon({ tool, size = 19 }: { tool: StudioTool; size?: number }) {
  return tool === "modeling" ? (
    <Box size={size} aria-hidden="true" />
  ) : tool === "hit-timing" ? (
    <Clock3 size={size} aria-hidden="true" />
  ) : (
    <Swords size={size} aria-hidden="true" />
  );
}

function ExperimentalBadge() {
  return <span className="bkh-experimental-badge">개발 중</span>;
}

function TigerMark() {
  return (
    <svg className="bkh-mark" viewBox="0 0 40 40" aria-hidden="true">
      <path
        d="M7 10 13 6 20 10 27 6 33 10 31 26 25 33H15L9 26Z"
        fill="currentColor"
      />
      <path
        d="m12 16 5 2-1 3-5-2m17-3-5 2 1 3 5-2M17 25h6l-3 4Z"
        fill="#242523"
      />
      <path
        d="m17 10 3 6 3-6M8 23l5 1M32 23l-5 1"
        stroke="#242523"
        strokeWidth="2.2"
      />
    </svg>
  );
}

function ToolArt({ tool }: { tool: StudioTool }) {
  if(tool==='four-tiger-items')return <div className="bkh-tool-art" aria-hidden="true" style={{display:'grid',placeItems:'center',color:'#6d8268'}}><Layers3 size={88} strokeWidth={1}/></div>;
  if (tool === "hit-timing")
    return (
      <div className="bkh-tool-art bkh-tool-art-hit-timing" aria-hidden="true">
        <svg viewBox="0 0 230 170">
          <ellipse
            cx="121"
            cy="143"
            rx="67"
            ry="10"
            fill="#bdcbd0"
            opacity=".22"
          />
          <circle
            cx="121"
            cy="73"
            r="47"
            fill="#f5f8f7"
            stroke="#91a5aa"
            strokeWidth="1.5"
          />
          <path
            d="M121 34a39 39 0 0 1 37 51"
            fill="none"
            stroke="#b6cbcd"
            strokeWidth="8"
            strokeLinecap="round"
          />
          <path
            d="M121 45v28l22 12"
            fill="none"
            stroke="#718f95"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <circle cx="121" cy="73" r="4" fill="#718f95" />
          <path d="M46 122h150" stroke="#95aaaf" strokeWidth="1.5" />
          <path
            d="M55 116v12m19-12v12m19-12v12m19-12v12m19-12v12m19-12v12m19-12v12m19-12v12"
            stroke="#a7b9bc"
            strokeWidth="1.2"
          />
          <rect
            x="92"
            y="113"
            width="60"
            height="18"
            rx="4"
            fill="#bfd3d3"
            stroke="#86a3a7"
          />
          <path d="M114 105v32" stroke="#c86c4f" strokeWidth="2.5" />
          <path d="m109 102 5 6 5-6" fill="#c86c4f" />
          <path
            d="M59 57h9m-4-4v9m112-27h8m-4-4v8"
            stroke="#adc0c2"
            strokeWidth="1.4"
          />
        </svg>
      </div>
    );
  if (tool === "modeling")
    return (
      <div className="bkh-tool-art bkh-tool-art-modeling" aria-hidden="true">
        <svg viewBox="0 0 230 170">
          <path d="m34 121 82-47 82 47-82 47Z" fill="#d7d9cd" opacity=".28" />
          <path
            d="m76 49 43-25 43 25-43 25Z"
            fill="#fcfcf5"
            stroke="#a1a68b"
            strokeWidth="1.4"
          />
          <path
            d="m76 49 43 25v52l-43-25Z"
            fill="#dfe3d1"
            stroke="#a1a68b"
            strokeWidth="1.4"
          />
          <path
            d="m119 74 43-25v52l-43 25Z"
            fill="#bcc4a6"
            stroke="#8d9873"
            strokeWidth="1.4"
          />
          <path
            d="m53 97 26-15 26 15-26 15Z"
            fill="#fafbf3"
            stroke="#a1a68b"
            strokeWidth="1.2"
          />
          <path
            d="m53 97 26 15v31l-26-15Z"
            fill="#dfe3d1"
            stroke="#a1a68b"
            strokeWidth="1.2"
          />
          <path
            d="m79 112 26-15v31l-26 15Z"
            fill="#bec6a9"
            stroke="#8d9873"
            strokeWidth="1.2"
          />
          <path
            d="m149 118 19-11 19 11-19 11Z"
            fill="#e98768"
            stroke="#b85d43"
            strokeWidth="1.1"
          />
          <path
            d="m149 118 19 11v22l-19-11Z"
            fill="#d9684a"
            stroke="#b85d43"
            strokeWidth="1.1"
          />
          <path
            d="m168 129 19-11v22l-19 11Z"
            fill="#b74d33"
            stroke="#a04630"
            strokeWidth="1.1"
          />
          <path
            d="M42 52h10m-5-5v10M182 48h8m-4-4v8"
            stroke="#9ba18c"
            strokeWidth="1.4"
          />
          <circle cx="53" cy="72" r="2" fill="#c4c9b6" />
          <circle cx="192" cy="91" r="2" fill="#c4c9b6" />
        </svg>
      </div>
    );
  return (
    <div className="bkh-tool-art bkh-tool-art-combat" aria-hidden="true">
      <svg viewBox="0 0 230 170">
        <ellipse
          cx="115"
          cy="134"
          rx="68"
          ry="15"
          fill="#dba88b"
          opacity=".15"
        />
        <path
          d="M55 115A70 70 0 0 1 139 32"
          fill="none"
          stroke="#ead1bd"
          strokeWidth="9"
          strokeLinecap="round"
        />
        <path
          d="M70 113A51 51 0 0 1 136 51"
          fill="none"
          stroke="#ddaf90"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <path
          d="m89 105 61-71 12-1-1 14-61 68Z"
          fill="#fbfaf5"
          stroke="#8c7968"
          strokeWidth="1.5"
        />
        <path d="m95 110 60-70" stroke="#cbbbaa" strokeWidth="2" />
        <path
          d="m84 103 18 15m-15-12-20 24 8 7 21-24"
          fill="#c46c4d"
          stroke="#83523e"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="m156 91 7-15 2 13 15-2-11 8 10 10-15-4-6 13 1-15-13-4Z"
          fill="#d36744"
        />
        <path
          d="m187 69 7-5m-12 62 6 5M66 43l-4-6"
          stroke="#caa68a"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

function ToolCards({
  open,
  disabled,
  detailed = false,
}: {
  open: (target: StudioTarget) => void;
  disabled: boolean;
  detailed?: boolean;
}) {
  return (
    <div
      className={`bkh-tool-grid${detailed ? " bkh-tool-grid-detailed" : ""}`}
    >
      {toolOrder.map((tool) => (
        <button
          key={tool}
          data-testid={`tool-${tool}`}
          className={`bkh-tool-card bkh-tool-card-${tool}`}
          onClick={() => open({ tool })}
          disabled={disabled}
        >
          <div className="bkh-tool-card-top">
            <span className="bkh-tool-category">{toolCopy[tool].category}</span>
            <ArrowUpRight size={19} />
          </div>
          <ToolArt tool={tool} />
          <div className="bkh-tool-card-copy">
            <span className="bkh-tool-card-icon">
              <ToolIcon tool={tool} />
            </span>
            <div className="bkh-tool-title-row">
              <h3 className="bkh-tool-name">{toolNames[tool]}</h3>
              {tool === "hit-timing" && <ExperimentalBadge />}
            </div>
            <p className="bkh-tool-description">{toolCopy[tool].description}</p>
          </div>
          <div className="bkh-tool-card-footer">
            <span>{toolCopy[tool].flow}</span>
            <span className="bkh-tool-open">
              도구 열기 <ArrowRight size={16} />
            </span>
          </div>
          {detailed && (
            <div className="bkh-tool-requirements">
              <span>{toolCopy[tool].input}</span>
              <span>{toolCopy[tool].output}</span>
            </div>
          )}
        </button>
      ))}
    </div>
  );
}

function EmptyState({
  title,
  detail,
  action,
  onAction,
  kind = "work",
}: {
  title: string;
  detail: string;
  action?: string;
  onAction?: () => void;
  kind?: "work" | "filter" | "error";
}) {
  const Icon =
    kind === "error"
      ? CircleAlert
      : kind === "filter"
        ? SlidersHorizontal
        : FolderOpen;
  return (
    <div className="bkh-empty">
      <span className="bkh-empty-icon">
        <Icon size={25} strokeWidth={1.5} />
      </span>
      <h3 className="bkh-empty-title">{title}</h3>
      <p className="bkh-empty-copy">{detail}</p>
      {action && onAction && (
        <button className="bkh-button bkh-button-secondary" onClick={onAction}>
          {action}
          <ArrowRight size={15} />
        </button>
      )}
    </div>
  );
}

function EntryList({
  entries,
  open,
  context,
}: {
  entries: StudioEntry[];
  open: (target: StudioTarget) => void;
  context: "projects" | "runs" | "results";
}) {
  return (
    <div className="bkh-entry-list">
      <div className="bkh-list-heading" aria-hidden="true">
        <span>
          {context === "projects"
            ? "프로젝트"
            : context === "runs"
              ? "실행 기록"
              : "결과"}
        </span>
        <span>상태</span>
        <span>최근 변경</span>
        <span />
      </div>
      {entries.map((entry) => (
        <button
          key={`${entry.tool}:${entry.id}`}
          className="bkh-entry"
          onClick={() => open(entry.target)}
          aria-label={`${entry.title}, ${toolNames[entry.tool]}${entry.tool === "hit-timing" ? ", 개발 중" : ""}, ${entry.status}, 열기`}
        >
          <span className="bkh-entry-main">
            <span className={`bkh-entry-icon bkh-entry-icon-${entry.tool}`}>
              <ToolIcon tool={entry.tool} />
            </span>
            <span className="bkh-entry-copy">
              <span className="bkh-entry-title">
                {entry.title}
                {entry.tool === "hit-timing" && <ExperimentalBadge />}
              </span>
              <span className="bkh-entry-detail">
                {toolNames[entry.tool]}
                {entry.projectName && entry.projectName !== entry.title
                  ? ` · ${entry.projectName}`
                  : ""}
                {entry.detail ? ` · ${entry.detail}` : ""}
              </span>
            </span>
          </span>
          <span className={`bkh-status bkh-status-${entry.tone}`}>
            <span className="bkh-status-dot" />
            {entry.status}
          </span>
          <span className="bkh-entry-date">{dateLabel(entry.updatedAt)}</span>
          <ChevronRight className="bkh-entry-chevron" size={17} />
        </button>
      ))}
    </div>
  );
}

export function StudioShell() {
  const bridge = typeof window.studio !== "undefined";
  const [page, setPage] = useState<StudioPage>("home");
  const [activeTool, setActiveTool] = useState<StudioTool | null>(null);
  const [summary, setSummary] = useState<StudioSummary | null>(null);
  const [summaryError, setSummaryError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState("");
  const [choosingProject, setChoosingProject] =
    useState<StudioNativeTool | null>(null);
  const [modelingMounted, setModelingMounted] = useState(false);
  const [itemsMounted,setItemsMounted]=useState(false);
  const [itemsNavigation,setItemsNavigation]=useState<{key:number;projectId?:string}>({key:0});
  const [modelingNavigation, setModelingNavigation] =
    useState<ModelingNavigation>({ key: 0, tab: "home" });
  const [nativeNavigation, setNativeNavigation] = useState<{
    key: number;
    target: StudioTarget;
  }>({ key: 0, target: { tool: "combat" } });
  const [nativeError, setNativeError] = useState("");
  const [toolFilter, setToolFilter] = useState<"all" | StudioTool>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | StudioEntry["tone"]>(
    "all",
  );
  const nativeContainer = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const request = useRef<Promise<void> | null>(null);
  const nativeEpoch = useRef(0);
  const nativeTool =
    activeTool === 'combat' || activeTool === 'hit-timing' ? activeTool : null;

  const refresh = useCallback((): Promise<void> => {
    if (!bridge) return Promise.resolve();
    if (request.current) return request.current;
    setRefreshing(true);
    request.current = window.studio
      .summary()
      .then((value) => {
        if (!alive.current) return;
        setSummary(value);
        setSummaryError("");
      })
      .catch((error: unknown) => {
        if (alive.current) setSummaryError(errorText(error));
      })
      .finally(() => {
        request.current = null;
        if (alive.current) setRefreshing(false);
      });
    return request.current;
  }, [bridge]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 3000);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const hideNativeTools = useCallback(() => {
    nativeEpoch.current += 1;
    if (bridge)
      void window.studio.hideTools().catch((error: unknown) => {
        if (alive.current)
          setActionError(`도구 화면을 숨기지 못했습니다. ${errorText(error)}`);
      });
  }, [bridge]);

  const navigate = useCallback(
    (destination: StudioPage) => {
      hideNativeTools();
      setActiveTool(null);
      setPage(destination);
      setActionError("");
      void refresh();
    },
    [hideNativeTools, refresh],
  );

  const open = useCallback(
    (target: StudioTarget) => {
      if (!bridge) return;
      setActionError("");
      // Issue hide before changing React state so rapid native-to-native switches
      // cannot leave the previous view over the newly selected workspace.
      hideNativeTools();
      if (target.tool === "modeling") {
        setModelingMounted(true);
        if (target.projectId || target.tab || target.create) {
          setModelingNavigation((previous) => ({
            key: previous.key + 1,
            projectId: target.projectId,
            tab: target.tab,
            create: target.create,
          }));
        }
      } else if(target.tool==='four-tiger-items') {
        setItemsMounted(true);
        setItemsNavigation(previous=>({key:previous.key+1,projectId:target.projectId}));
      } else {
        setNativeError("");
        setNativeNavigation((previous) => ({ key: previous.key + 1, target }));
      }
      setActiveTool(target.tool);
    },
    [bridge, hideNativeTools],
  );

  useEffect(() => {
    if (!nativeTool || !bridge || !nativeContainer.current) return;
    const container = nativeContainer.current;
    const epoch = ++nativeEpoch.current;
    let disposed = false;
    let frame = 0;
    let shown = false;
    let showing = false;
    let lastBounds = "";
    const bounds = (): StudioBounds => {
      const rect = container.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      };
    };
    const fail = (error: unknown) => {
      if (disposed || nativeEpoch.current !== epoch) return;
      setNativeError(errorText(error));
      void window.studio.hideTools().catch(() => {});
    };
    const sync = () => {
      if (disposed || nativeEpoch.current !== epoch) return;
      const next = bounds();
      const key = JSON.stringify(next);
      if (!shown && !showing) {
        showing = true;
        lastBounds = key;
        void window.studio
          .showTool(nativeTool, next, nativeNavigation.target)
          .then(() => {
            if (disposed || nativeEpoch.current !== epoch) return;
            shown = true;
            showing = false;
            sync();
          })
          .catch(fail);
      } else if (shown && key !== lastBounds) {
        lastBounds = key;
        void window.studio.resizeTool(nativeTool, next).catch(fail);
      }
    };
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(sync);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      // The native view is retained by the host; only its visibility changes.
      void window.studio.hideTools().catch(() => {});
    };
  }, [nativeTool, nativeNavigation, bridge]);

  const chooseProject = async (tool: StudioNativeTool) => {
    if (!bridge || choosingProject) return;
    setChoosingProject(tool);
    setActionError("");
    try {
      if (tool === "combat") await window.studio.chooseCombatProject();
      else await window.studio.chooseHitTimerProject();
      await refresh();
    } catch (error) {
      if (alive.current) setActionError(errorText(error));
    } finally {
      if (alive.current) setChoosingProject(null);
    }
  };

  const listEntries = summary
    ? page === "results"
      ? summary.results
      : summary.runs
    : [];
  const filteredEntries = listEntries.filter(
    (entry) =>
      (toolFilter === "all" || entry.tool === toolFilter) &&
      (statusFilter === "all" || entry.tone === statusFilter),
  );
  const activeCount =
    summary?.runs.filter((entry) => entry.tone === "active").length ?? 0;
  const copy = activeTool
    ? {
        title: toolNames[activeTool],
        subtitle:
          activeTool === 'four-tiger-items' ? '아이템 초안 · 아이콘 제작 · 검토와 데이터 출력' : activeTool === "modeling"
            ? "이미지부터 모델링, 리깅, Unity 연결까지"
            : activeTool === "hit-timing"
              ? summary?.hitTimer.projectName
                ? `Unity 프로젝트 · ${summary.hitTimer.projectName}`
                : "애니메이션의 공격 판정 구간을 제안하고 검토"
              : summary?.combat.projectName
                ? `Unity 프로젝트 · ${summary.combat.projectName}`
                : "Unity 프로젝트를 연결하고 원하는 타격감을 찾아보세요.",
      }
    : pageCopy[page];

  return (
    <div className="bkh-shell">
      <aside className="bkh-sidebar" aria-label="백호툴 공통 탐색">
        <button
          className="bkh-brand"
          onClick={() => navigate("home")}
          aria-label="백호툴 홈"
        >
          <TigerMark />
          <span className="bkh-brand-copy">
            <strong>백호툴</strong>
            <span>BAEKHO STUDIO</span>
          </span>
        </button>
        <div className="bkh-sidebar-rule" />
        <p className="bkh-nav-label">WORKSPACE</p>
        <nav className="bkh-nav">
          {pages.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              data-testid={`nav-${id}`}
              className={`bkh-nav-item${(activeTool ? id === "tools" : page === id) ? " bkh-nav-item-active" : ""}`}
              onClick={() => navigate(id)}
              aria-label={label}
              aria-current={
                (activeTool ? id === "tools" : page === id) ? "page" : undefined
              }
            >
              <Icon size={19} strokeWidth={1.7} />
              <span>{label}</span>
              {id === "runs" && activeCount > 0 && (
                <span
                  className="bkh-nav-count"
                  aria-label={`${activeCount}개 진행 중`}
                >
                  {activeCount}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="bkh-sidebar-bottom">
          {activeTool && (
            <div className="bkh-current-tool">
              <span className="bkh-current-dot" />
              <span>
                {toolNames[activeTool]} 사용 중
                {activeTool === "hit-timing" && <ExperimentalBadge />}
              </span>
            </div>
          )}
          <div className="bkh-local-label">
            <span
              className={`bkh-connection-dot${bridge ? " bkh-connection-dot-ready" : ""}`}
            />
            {bridge ? "내 컴퓨터의 작업 공간" : "데스크톱 연결 없음"}
          </div>
          <span className="bkh-version">
            백호 스튜디오{summary?.version ? ` · ${summary.version}` : ""}
          </span>
        </div>
      </aside>

      <div className="bkh-main">
        <header className="bkh-header">
          <div className="bkh-header-copy">
            <div className="bkh-breadcrumb">
              백호 스튜디오 <ChevronRight size={12} />{" "}
              {activeTool
                ? "도구"
                : pages.find((item) => item.id === page)?.label}
            </div>
            <div className="bkh-tool-title-row">
              <h1 className="bkh-page-title">{copy.title}</h1>
              {activeTool === "hit-timing" && <ExperimentalBadge />}
            </div>
            <p className="bkh-page-subtitle">{copy.subtitle}</p>
          </div>
          <div className="bkh-header-actions">
            {activeTool ? (
              <>
                <button
                  className="bkh-button bkh-button-quiet"
                  onClick={() => navigate("tools")}
                >
                  <ArrowLeft size={16} />
                  모든 도구
                </button>
                <label className="bkh-select-label bkh-tool-switcher">
                  <ToolIcon tool={activeTool} size={16} />
                  <span className="bkh-sr-only">도구 전환</span>
                  <select
                    className="bkh-select"
                    value={activeTool}
                    onChange={(event) =>
                      open({ tool: event.target.value as StudioTool })
                    }
                  >
                    {toolOrder.map((tool) => (
                      <option key={tool} value={tool}>
                        {toolNames[tool]}
                        {tool === "hit-timing" ? " · 개발 중" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <button
                className="bkh-refresh"
                onClick={() => {
                  void refresh();
                }}
                disabled={!bridge || refreshing}
                aria-label="작업 목록 새로고침"
                title="작업 목록 새로고침"
              >
                <RefreshCw size={17} className={refreshing ? "bkh-spin" : ""} />
              </button>
            )}
          </div>
        </header>

        {activeTool === "hit-timing" && (
          <div className="bkh-experimental-notice">
            <CircleAlert size={17} />
            <p>
              AI 시각 분석으로 공격 구간을 제안합니다. 실제 충돌 판정·타수
              정확도는 검증되지 않아 직접 검토가 필요합니다.
            </p>
          </div>
        )}

        {(summaryError || actionError) && (
          <div className="bkh-alert" role="alert">
            <CircleAlert size={18} />
            <div className="bkh-alert-copy">
              <strong>
                {actionError
                  ? "작업을 완료하지 못했어요."
                  : summary
                    ? "최신 상태를 불러오지 못했어요. 마지막으로 확인한 내용을 표시합니다."
                    : "작업 목록을 불러오지 못했어요."}
              </strong>
              <span>{actionError || summaryError}</span>
            </div>
            {actionError ? (
              <button
                className="bkh-alert-button"
                onClick={() => setActionError("")}
                aria-label="오류 안내 닫기"
              >
                <X size={16} />
              </button>
            ) : (
              <button
                className="bkh-alert-button"
                disabled={refreshing}
                onClick={() => {
                  void refresh();
                }}
              >
                다시 시도
              </button>
            )}
          </div>
        )}

        {!bridge ? (
          <main className="bkh-content">
            <div className="bkh-desktop-needed">
              <span className="bkh-empty-icon">
                <Box size={28} strokeWidth={1.5} />
              </span>
              <h2 className="bkh-section-title">
                백호툴 데스크톱 앱에서 열어주세요.
              </h2>
              <p className="bkh-empty-copy">
                로컬 프로젝트와 제작 도구는 데스크톱 앱에 연결되어 있습니다.
                <br />
                앱을 실행하면 저장된 작업을 이어갈 수 있어요.
              </p>
            </div>
          </main>
        ) : (
          <>
            {!activeTool && (
              <main className="bkh-content" id="bkh-content">
                {(page === "home" || page === "tools") && (
                  <>
                    <section className="bkh-welcome">
                      <div>
                        <p className="bkh-eyebrow">
                          {page === "home"
                            ? "작은 아이디어, 다음 장면으로"
                            : "함께 쓰는 제작 도구"}
                        </p>
                        <h2 className="bkh-welcome-title">
                          {page === "home"
                            ? "어떤 작업을 시작할까요?"
                            : "만들고, 움직이고, 다듬으세요."}
                        </h2>
                        <p className="bkh-welcome-description">
                          {page === "home"
                            ? "필요한 도구를 열거나, 하던 작업을 이어가세요."
                            : "각 도구의 작업은 화면을 오가도 그대로 유지됩니다."}
                        </p>
                      </div>
                      <span className="bkh-workspace-stamp" aria-hidden="true">
                        白虎<span>CREATIVE WORKSPACE</span>
                      </span>
                    </section>
                    <ToolCards
                      open={open}
                      disabled={!bridge}
                      detailed={page === "tools"}
                    />
                    {page === "home" && (
                      <section className="bkh-recent">
                        <div className="bkh-section-heading">
                          <div>
                            <h2 className="bkh-section-title">
                              이어서 작업하기
                            </h2>
                            <p className="bkh-section-description">
                              최근 변경한 프로젝트를 바로 열어보세요.
                            </p>
                          </div>
                          <button
                            className="bkh-text-button"
                            onClick={() => navigate("runs")}
                          >
                            실행 기록 <ArrowRight size={15} />
                          </button>
                        </div>
                        {!summary && !summaryError ? (
                          <div className="bkh-loading" role="status">
                            <LoaderCircle className="bkh-spin" size={20} />
                            저장된 작업을 불러오고 있어요.
                          </div>
                        ) : summary?.projects.length ? (
                          <EntryList
                            entries={summary.projects.slice(0, 6)}
                            open={open}
                            context="projects"
                          />
                        ) : summaryError && !summary ? (
                          <EmptyState
                            kind="error"
                            title="저장된 작업을 확인할 수 없어요."
                            detail="연결 상태를 확인한 뒤 다시 불러와 주세요."
                            action="다시 불러오기"
                            onAction={() => {
                              void refresh();
                            }}
                          />
                        ) : (
                          <EmptyState
                            title="첫 프로젝트를 시작해 보세요."
                            detail="프로젝트를 만들면 이곳에서 바로 이어갈 수 있어요."
                            action="모델링 프로젝트 만들기"
                            onAction={() =>
                              open({ tool: "modeling", create: true })
                            }
                          />
                        )}
                      </section>
                    )}
                    {page === "tools" && (
                      <div className="bkh-help-note">
                        <CheckCircle2 size={17} />
                        <span>
                          도구를 열면 작업 화면으로 이동합니다. 생성과 실행은 각
                          도구에서 직접 시작하세요.
                        </span>
                      </div>
                    )}
                  </>
                )}

                {(page === "runs" || page === "results") && (
                  <section className="bkh-records">
                    <div className="bkh-records-top">
                      <div className="bkh-filter-tabs" aria-label="도구 필터">
                        {(["all", ...toolOrder] as const).map((tool) => (
                          <button
                            key={tool}
                            className={`bkh-filter-tab${toolFilter === tool ? " bkh-filter-tab-active" : ""}`}
                            aria-pressed={toolFilter === tool}
                            onClick={() => setToolFilter(tool)}
                          >
                            {tool === "all" ? "모든 도구" : toolNames[tool]}
                            {tool === "hit-timing" && <ExperimentalBadge />}
                          </button>
                        ))}
                      </div>
                      <label className="bkh-select-label">
                        <SlidersHorizontal size={15} />
                        <span className="bkh-sr-only">상태 필터</span>
                        <select
                          className="bkh-select"
                          value={statusFilter}
                          onChange={(event) =>
                            setStatusFilter(
                              event.target.value as typeof statusFilter,
                            )
                          }
                        >
                          <option value="all">모든 상태</option>
                          {Object.entries(toneNames).map(([tone, name]) => (
                            <option key={tone} value={tone}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    {!summary && !summaryError ? (
                      <div className="bkh-loading" role="status">
                        <LoaderCircle className="bkh-spin" size={20} />
                        {page === "runs" ? "실행 기록" : "결과"}을 불러오고
                        있어요.
                      </div>
                    ) : filteredEntries.length ? (
                      <EntryList
                        entries={filteredEntries}
                        open={open}
                        context={page}
                      />
                    ) : summaryError && !summary ? (
                      <EmptyState
                        kind="error"
                        title="목록을 불러오지 못했어요."
                        detail="다시 불러오기를 눌러 연결 상태를 확인해 주세요."
                        action="다시 불러오기"
                        onAction={() => {
                          void refresh();
                        }}
                      />
                    ) : listEntries.length ? (
                      <EmptyState
                        kind="filter"
                        title="조건에 맞는 작업이 없어요."
                        detail="도구나 상태 필터를 바꾸면 다른 작업을 볼 수 있어요."
                        action="필터 초기화"
                        onAction={() => {
                          setToolFilter("all");
                          setStatusFilter("all");
                        }}
                      />
                    ) : (
                      <EmptyState
                        title={
                          page === "runs"
                            ? "아직 실행한 작업이 없어요."
                            : "아직 만들어진 결과가 없어요."
                        }
                        detail={
                          page === "runs"
                            ? "도구에서 작업을 실행하면 진행 상황과 기록이 여기에 표시됩니다."
                            : "각 도구에서 만든 결과를 이곳에서 다시 찾을 수 있어요."
                        }
                        action="도구 둘러보기"
                        onAction={() => navigate("tools")}
                      />
                    )}
                    {filteredEntries.length > 0 && (
                      <p className="bkh-records-note">
                        <Clock3 size={14} />
                        작업 상태는 자동으로 갱신됩니다. 항목을 누르면 해당
                        도구에서 상세 내용을 볼 수 있어요.
                      </p>
                    )}
                  </section>
                )}

                {page === "settings" && (
                  <div className="bkh-settings">
                    <section className="bkh-settings-section">
                      <div className="bkh-section-heading">
                        <div>
                          <h2 className="bkh-section-title">도구 연결</h2>
                          <p className="bkh-section-description">
                            각 도구에 필요한 연결을 설정하세요.
                          </p>
                        </div>
                      </div>
                      <div className="bkh-setting-row">
                        <span className="bkh-entry-icon bkh-entry-icon-modeling">
                          <Box size={21} />
                        </span>
                        <div className="bkh-setting-copy">
                          <h3 className="bkh-setting-title">3D 모델링</h3>
                          <p className="bkh-setting-description">
                            AI 서비스, Blender, Unity 연결과 생성 옵션을
                            관리합니다.
                          </p>
                        </div>
                        <button
                          className="bkh-button bkh-button-secondary"
                          onClick={() =>
                            open({ tool: "modeling", tab: "settings" })
                          }
                        >
                          연결 설정
                          <ArrowUpRight size={15} />
                        </button>
                      </div>
                      <div className="bkh-setting-row">
                        <span className="bkh-entry-icon bkh-entry-icon-combat">
                          <Swords size={21} />
                        </span>
                        <div className="bkh-setting-copy">
                          <h3 className="bkh-setting-title">타격감 찾기</h3>
                          <p className="bkh-setting-description">
                            {summary?.combat.projectName
                              ? `연결할 프로젝트: ${summary.combat.projectName}`
                              : "실험할 Unity 프로젝트 폴더를 선택하세요."}
                          </p>
                          {summary?.combat.projectPath && (
                            <span className="bkh-path">
                              {summary.combat.projectPath}
                            </span>
                          )}
                          <span
                            className={`bkh-inline-status${summary?.combat.connected ? " bkh-inline-status-ready" : ""}`}
                          >
                            {summary?.combat.connected ? (
                              <Check size={13} />
                            ) : (
                              <span className="bkh-small-dot" />
                            )}
                            {summary?.combat.connected
                              ? "Unity 연결됨"
                              : "Unity 연결 대기"}
                          </span>
                        </div>
                        <div className="bkh-setting-actions">
                          <button
                            className="bkh-button bkh-button-secondary"
                            disabled={choosingProject !== null}
                            onClick={() => {
                              void chooseProject("combat");
                            }}
                          >
                            {choosingProject === "combat" ? (
                              <LoaderCircle className="bkh-spin" size={15} />
                            ) : (
                              <FolderOpen size={15} />
                            )}
                            프로젝트 선택
                          </button>
                          <button
                            className="bkh-text-button"
                            onClick={() =>
                              open({ tool: "combat", tab: "setup" })
                            }
                          >
                            Unity 연결 설정
                            <ArrowUpRight size={14} />
                          </button>
                        </div>
                      </div>
                      <div className="bkh-setting-row">
                        <span className="bkh-entry-icon bkh-entry-icon-hit-timing">
                          <Clock3 size={21} />
                        </span>
                        <div className="bkh-setting-copy">
                          <h3 className="bkh-setting-title">
                            타격 타이밍 <ExperimentalBadge />
                          </h3>
                          <p className="bkh-setting-description">
                            {summary?.hitTimer.projectName
                              ? `연결할 프로젝트: ${summary.hitTimer.projectName}`
                              : "공격 애니메이션을 검토할 Unity 프로젝트 폴더를 선택하세요."}
                          </p>
                          {summary?.hitTimer.projectPath && (
                            <span className="bkh-path">
                              {summary.hitTimer.projectPath}
                            </span>
                          )}
                          <span
                            className={`bkh-inline-status${summary?.hitTimer.connected ? " bkh-inline-status-ready" : ""}`}
                          >
                            {summary?.hitTimer.connected ? (
                              <Check size={13} />
                            ) : (
                              <span className="bkh-small-dot" />
                            )}
                            {summary?.hitTimer.connected
                              ? "Unity 연결됨"
                              : "Unity 연결 대기"}
                          </span>
                        </div>
                        <div className="bkh-setting-actions">
                          <button
                            className="bkh-button bkh-button-secondary"
                            disabled={choosingProject !== null}
                            onClick={() => {
                              void chooseProject("hit-timing");
                            }}
                          >
                            {choosingProject === "hit-timing" ? (
                              <LoaderCircle className="bkh-spin" size={15} />
                            ) : (
                              <FolderOpen size={15} />
                            )}
                            프로젝트 선택
                          </button>
                          <button
                            className="bkh-text-button"
                            onClick={() => open({ tool: "hit-timing" })}
                          >
                            도구 열기
                            <ArrowUpRight size={14} />
                          </button>
                        </div>
                      </div>
                    </section>
                    <section className="bkh-settings-section">
                      <div className="bkh-section-heading">
                        <div>
                          <h2 className="bkh-section-title">저장 위치</h2>
                          <p className="bkh-section-description">
                            도구마다 작업 데이터를 각자의 위치에 보관합니다.
                          </p>
                        </div>
                      </div>
                      <div className="bkh-storage-row">
                        <span className="bkh-storage-label">
                          <Box size={16} />
                          3D 모델링
                        </span>
                        <code className="bkh-storage-path">
                          {summary?.storage.modeling ||
                            (summaryError
                              ? "저장 위치를 확인하지 못했습니다."
                              : "불러오는 중…")}
                        </code>
                      </div>
                      <div className="bkh-storage-row">
                        <span className="bkh-storage-label">
                          <Swords size={16} />
                          타격감 찾기
                        </span>
                        <code className="bkh-storage-path">
                          {summary?.storage.combat ||
                            (summaryError
                              ? "저장 위치를 확인하지 못했습니다."
                              : "불러오는 중…")}
                        </code>
                      </div>
                      <div className="bkh-storage-row">
                        <span className="bkh-storage-label">
                          <Clock3 size={16} />
                          타격 타이밍
                          <ExperimentalBadge />
                        </span>
                        <code className="bkh-storage-path">
                          {summary?.storage.hitTimer ||
                            (summaryError
                              ? "저장 위치를 확인하지 못했습니다."
                              : "불러오는 중…")}
                        </code>
                      </div>
                    </section>
                    <section className="bkh-storage-row"><span className="bkh-storage-label">사인검 아이템</span><code className="bkh-storage-path">{summary?.storage.fourTigerItems||'불러오는 중…'}</code></section>
                    {summary?.combat.error && (
                      <div className="bkh-setting-warning">
                        <CircleAlert size={17} />
                        <span>{summary.combat.error}</span>
                      </div>
                    )}
                    {summary?.hitTimer.error && (
                      <div className="bkh-setting-warning">
                        <CircleAlert size={17} />
                        <span>타격 타이밍: {summary.hitTimer.error}</span>
                      </div>
                    )}
                    {!!summary?.warnings.length && (
                      <section className="bkh-settings-section">
                        <h2 className="bkh-section-title">
                          확인이 필요한 항목
                        </h2>
                        {summary.warnings.map((warning, index) => (
                          <div className="bkh-setting-warning" key={index}>
                            <CircleAlert size={17} />
                            <span>{warning}</span>
                          </div>
                        ))}
                      </section>
                    )}
                  </div>
                )}
              </main>
            )}

            {modelingMounted && (
              <div
                data-testid="workspace-modeling"
                className="bkh-modeling"
                style={{ display: activeTool === "modeling" ? "flex" : "none" }}
                aria-hidden={activeTool !== "modeling"}
              >
                <App embedded navigation={modelingNavigation} />
              </div>
            )}
            {itemsMounted && <div className="bkh-modeling" style={{display:activeTool==='four-tiger-items'?'block':'none'}} aria-hidden={activeTool!=='four-tiger-items'}><FourTigerItems active={activeTool==='four-tiger-items'} navigation={itemsNavigation}/></div>}
            {nativeTool && (
              <div
                data-testid={`workspace-${nativeTool}`}
                className="bkh-native"
                ref={nativeContainer}
              >
                {nativeError ? (
                  <EmptyState
                    kind="error"
                    title={`${toolNames[nativeTool]} 도구를 열지 못했어요.`}
                    detail={nativeError}
                    action="다시 열기"
                    onAction={() => open(nativeNavigation.target)}
                  />
                ) : (
                  <div className="bkh-loading" role="status">
                    <LoaderCircle className="bkh-spin" size={22} />
                    {toolNames[nativeTool]} 작업 공간을 열고 있어요.
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
