import { useEffect, useState } from "react";
import {
  elements,
  elementNames,
  previewSp,
  type Element,
  type ExportReceipt,
  type ProjectSummary,
  type SainGeomItemProject,
  type ValidationReport,
  type PolicyValues,
  type PolicyKey,
} from "../shared/four-tiger-items";
import { FourTigerItemEditor, ItemIcon } from "./FourTigerItemEditor";
import "./four-tiger-items.css";
const reviewNames = {
  draft: "초안",
  reviewed: "검토됨",
  adopted: "채택",
  held: "보류",
};
const policyNames: Record<PolicyKey, string> = {
  maxSpCap: "최대 SP 상한",
  regenCap: "재생/초 상한",
  minDodgeCost: "회피 비용 하한",
  minSwitchCost: "전환 비용 하한",
  stacking: "서로 다른 소스 가산",
  sourceStackLimit: "소스당 최대 중첩",
  timedRefresh: "시간 버프 재발동 갱신",
  removeOnItemLoss: "소지 해제 시 제거",
  refillOnMaxIncrease: "최대치 증가 시 현재 자원 지급",
  clampOnMaxDecrease: "최대치 감소 시 초과 자원 제한",
};
export function FourTigerItems({
  active,
  navigation,
}: {
  active: boolean;
  navigation: { key: number; projectId?: string };
}) {
  const api = window.fourTigerItems;
  const [projects, setProjects] = useState<ProjectSummary[]>([]),
    [project, setProject] = useState<SainGeomItemProject | null>(null),
    [selected, setSelected] = useState(""),
    [marked, setMarked] = useState<string[]>([]),
    [filter, setFilter] = useState("all"),
    [grade, setGrade] = useState("all"),
    [state, setState] = useState("all"),
    [table, setTable] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [report, setReport] = useState<ValidationReport | null>(null),
    [receipt, setReceipt] = useState<ExportReceipt | null>(null),
    [confirm, setConfirm] = useState(false),
    [restoreId, setRestoreId] = useState<string | null>(null),
    [previewForm, setPreviewForm] = useState<Element>("wood"),
    [previewTimed, setPreviewTimed] = useState(false),
    [style, setStyle] = useState(""),
    [policies, setPolicies] = useState<PolicyValues | null>(null);
  const refreshList = () => api.list().then(setProjects);
  const load = async (id: string) => {
    const p = await api.read({ projectId: id });
    setProject(p);
    setSelected(p.items[0]?.candidateKey ?? "");
    setMarked([]);
    setStyle(p.iconStyle);
    setPolicies({ ...p.ruleProfile.proposed });
    setError("");
    setReceipt(null);
  };
  useEffect(() => {
    if (active) void refreshList().catch((e) => setError(e.message));
    if (navigation.projectId)
      void load(navigation.projectId).catch((e) => setError(e.message));
  }, [active, navigation.key]);
  useEffect(() => {
    if (!project) return;
    let live = true;
    void api
      .validate({ projectId: project.projectId, mode: "release" })
      .then((r) => {
        if (live) setReport(r);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [project?.projectId, project?.revision]);
  const running = project?.jobs.some((j) =>
    ["queued", "running", "generated"].includes(j.status),
  );
  useEffect(() => {
    if (!active || !running || !project) return;
    const id = project.projectId;
    let live = true;
    const timer = setInterval(() => {
      void api
        .read({ projectId: id })
        .then((p) => {
          if (live) setProject(p);
        })
        .catch((e) => setError(e.message));
    }, 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active, running, project?.projectId]);
  async function act(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      const result = await fn();
      if (result && typeof result === "object" && "items" in result)
        setProject(result as SainGeomItemProject);
      else if (project)
        setProject(await api.read({ projectId: project.projectId }));
      await refreshList();
      setNotice("저장됨");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (project)
        void api
          .read({ projectId: project.projectId })
          .then(setProject)
          .catch(() => {});
      return false;
    } finally {
      setBusy(false);
    }
  }
  const create = () =>
    act(async () => {
      const p = await api.create({
        name: `사인검 초안 ${new Date().toLocaleDateString("ko-KR")}`,
      });
      setSelected(p.items[0].candidateKey);
      setStyle(p.iconStyle);
      setPolicies({ ...p.ruleProfile.proposed });
      setMarked([]);
      setReceipt(null);
      return p;
    });
  const item = project?.items.find((i) => i.candidateKey === selected),
    input = project
      ? { projectId: project.projectId, expectedRevision: project.revision }
      : null;
  const selection = marked.length ? marked : item ? [item.candidateKey] : [];
  const preview = project
    ? previewSp(project, previewForm, previewTimed)
    : null;
  const visible =
    project?.items.filter(
      (i) =>
        (filter === "all" || i.element === filter) &&
        (grade === "all" || i.grade === Number(grade)) &&
        (state === "all" || i.review.state === state),
    ) ?? [];
  return (
    <section
      className="four-tiger-items"
      data-testid="workspace-four-tiger-items"
    >
      <header className="fti-header">
        <div>
          <small>FOUR TIGER SWORD · ITEM WORKSHOP</small>
          <h1>사인검 아이템</h1>
          <p>
            20개 초안과 아이콘을 만들고, 검토한 내용을 게임 데이터로 준비하세요.
          </p>
        </div>
        <button
          className="fti-primary"
          data-testid="create-items"
          disabled={busy}
          onClick={() => void create()}
        >
          20개 초안 만들기
        </button>
      </header>
      <div className="fti-rule-strip">
        <strong>가격·구성 확정</strong>
        <span>목·화·토·금·수 × 4등급 · 20 / 40 / 80 / 160 G</span>
        <span>개별 효과·상한·아트는 검토할 제안입니다.</span>
      </div>
      <div className="fti-toolbar">
        <label>
          초안 묶음
          <select
            aria-label="초안 묶음"
            value={project?.projectId ?? ""}
            onChange={(e) =>
              void load(e.target.value).catch((e) => setError(e.message))
            }
          >
            <option value="">묶음을 선택하세요</option>
            {projects.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.name}
                {p.readError ? " · 복구 필요" : ""}
              </option>
            ))}
          </select>
        </label>
        <span role="status">{busy ? "저장 중…" : notice}</span>
        {project && (
          <span data-testid="item-counts">
            아이콘 {project.items.filter((i) => i.icons.length).length}/20 ·
            채택{" "}
            {project.items.filter((i) => i.review.state === "adopted").length}
            /20 · r{project.revision}
          </span>
        )}
      </div>
      {error && (
        <div className="fti-error" role="alert">
          {error}
        </div>
      )}
      {projects
        .filter((p) => p.readError)
        .map((p) => (
          <div className="fti-warning" key={p.projectId}>
            {p.name} · {p.readError}{" "}
            <button disabled={busy} onClick={() => setRestoreId(p.projectId)}>
              이전 정상본 복구
            </button>
          </div>
        ))}
      {!project ? (
        <div className="fti-empty">
          <h2>사인검의 첫 아이템 묶음</h2>
          <p>
            지정된 기획의 20개 제안을 불러옵니다. 생성만으로 채택되지는
            않습니다.
          </p>
          <p className="fti-muted">
            기획: codex/system-design-2026-10-07 · fe533a25
          </p>
        </div>
      ) : (
        <>
          <div className="fti-toolbar">
            <button
              disabled={busy || running}
              onClick={() =>
                void act(() =>
                  api.generateIcons({
                    ...input!,
                    candidateKeys: project.items
                      .filter((i) => !i.icons.length)
                      .map((i) => i.candidateKey),
                  }),
                )
              }
            >
              누락 아이콘 생성
            </button>
            <button
              disabled={busy || !running}
              onClick={() =>
                void act(() =>
                  api.cancelPending({ projectId: project.projectId }),
                )
              }
            >
              남은 작업 취소
            </button>
            <button
              disabled={busy || running}
              onClick={() =>
                void act(() => api.reconcile({ projectId: project.projectId }))
              }
            >
              기존 결과 복구
            </button>
            <button disabled={busy} onClick={() => setTable((v) => !v)}>
              {table ? "카드로 보기" : "목록으로 보기"}
            </button>
            <span className="fti-muted">
              내장 이미지 도구 · 한 번에 1개씩 생성
            </span>
          </div>
          <div className="fti-workspace">
            <main className="fti-catalog">
              <div className="fti-filters">
                <select
                  aria-label="오행 필터"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">모든 오행</option>
                  {elements.map((e) => (
                    <option key={e} value={e}>
                      {elementNames[e]}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="등급 필터"
                  value={grade}
                  onChange={(e) => setGrade(e.target.value)}
                >
                  <option value="all">모든 등급</option>
                  {[1, 2, 3, 4].map((g) => (
                    <option key={g}>{g}</option>
                  ))}
                </select>
                <select
                  aria-label="상태 필터"
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                >
                  <option value="all">모든 상태</option>
                  {Object.entries(reviewNames).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => setMarked(visible.map((i) => i.candidateKey))}
                >
                  보이는 항목 선택
                </button>
                <button onClick={() => setMarked([])}>선택 해제</button>
              </div>
              <div className={`fti-cards ${table ? "fti-table" : ""}`}>
                {visible.map((i) => (
                  <article
                    className={`fti-card ${selected === i.candidateKey ? "selected" : ""}`}
                    key={i.candidateKey}
                    data-testid={`item-${i.itemId}`}
                    style={
                      {
                        "--element": (
                          {
                            wood: "#649276",
                            fire: "#be6653",
                            earth: "#aa8a4e",
                            metal: "#809096",
                            water: "#548ea9",
                          } as Record<Element, string>
                        )[i.element],
                      } as React.CSSProperties
                    }
                  >
                    <input
                      type="checkbox"
                      aria-label={`${i.name} 묶음 선택`}
                      checked={marked.includes(i.candidateKey)}
                      onChange={(e) =>
                        setMarked((keys) =>
                          e.target.checked
                            ? [...keys, i.candidateKey]
                            : keys.filter((k) => k !== i.candidateKey),
                        )
                      }
                    />
                    <button
                      className="fti-card-open"
                      onClick={() => setSelected(i.candidateKey)}
                    >
                      <ItemIcon projectId={project.projectId} item={i} />
                      <div>
                        <small>
                          {elementNames[i.element]} · {i.grade}등급 ·{" "}
                          {i.purchasePrice} G
                        </small>
                        <h3>{i.name || "이름 없음"}</h3>
                        <code>{i.itemId}</code>
                        <p>{i.description}</p>
                        <span className={`fti-badge ${i.review.state}`}>
                          {reviewNames[i.review.state]}
                        </span>
                      </div>
                    </button>
                  </article>
                ))}
              </div>
              <div className="fti-toolbar">
                <span>{selection.length}개 선택</span>
                <button
                  disabled={busy || !selection.length}
                  onClick={() =>
                    void act(() =>
                      api.reviewItems({
                        ...input!,
                        candidateKeys: selection,
                        action: "reviewData",
                        note: "선택 데이터 검토",
                      }),
                    )
                  }
                >
                  선택 데이터 검토 완료
                </button>
                <button
                  disabled={busy || !selection.length}
                  onClick={() =>
                    void act(() =>
                      api.reviewItems({
                        ...input!,
                        candidateKeys: selection,
                        action: "reviewIcon",
                        note: "선택 아이콘 검토",
                      }),
                    )
                  }
                >
                  선택 아이콘 검토 완료
                </button>
                <button
                  data-testid="adopt-items"
                  disabled={busy || !selection.length}
                  onClick={() => setConfirm(true)}
                >
                  선택 항목 채택
                </button>
                <button
                  disabled={busy || !selection.length}
                  onClick={() =>
                    void act(() =>
                      api.reviewItems({
                        ...input!,
                        candidateKeys: selection,
                        action: "hold",
                        note: "",
                      }),
                    )
                  }
                >
                  보류
                </button>
              </div>
              <details className="fti-panel">
                <summary>
                  공통 제안 정책 ·{" "}
                  {Object.keys(project.ruleProfile.adoptions).length}/10 채택
                </summary>
                <p>상한·하한과 합산·중첩은 확정 기획과 구분되는 제안입니다.</p>
                {policies &&
                  (Object.keys(policyNames) as PolicyKey[]).map((key) => (
                    <label className="fti-policy" key={key}>
                      <span>{policyNames[key]}</span>
                      {[
                        "maxSpCap",
                        "regenCap",
                        "minDodgeCost",
                        "minSwitchCost",
                      ].includes(key) ? (
                        <input
                          type="number"
                          value={String(policies[key])}
                          onChange={(e) =>
                            setPolicies((p) =>
                              p ? { ...p, [key]: Number(e.target.value) } : p,
                            )
                          }
                        />
                      ) : (
                        <strong>{String(policies[key])}</strong>
                      )}
                    </label>
                  ))}
                <div className="fti-row">
                  <button
                    disabled={busy}
                    onClick={() =>
                      policies &&
                      void act(() =>
                        api.updatePolicies({ ...input!, patch: policies }),
                      )
                    }
                  >
                    정책 수정 저장
                  </button>
                  <button
                    data-testid="adopt-policies"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        api.adoptPolicies({
                          ...input!,
                          keys: Object.keys(policyNames) as PolicyKey[],
                        }),
                      )
                    }
                  >
                    위 제안 정책을 확인하고 채택
                  </button>
                </div>
              </details>
              <details className="fti-panel">
                <summary>공통 아이콘 화풍</summary>
                <textarea
                  rows={5}
                  value={style}
                  onChange={(e) => setStyle(e.target.value)}
                />
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(() => api.updateIconStyle({ ...input!, style }))
                  }
                >
                  화풍 저장 · 다시 검토
                </button>
              </details>
              <details className="fti-panel">
                <summary>
                  규칙 검사 · 오류{" "}
                  {report?.issues.filter((i) => i.severity === "error")
                    .length ?? 0}
                  개
                </summary>
                <p>
                  기본 SP100 · 재생20/초 · 지연1초 · 회피20 · 전환10 · 쿨타임2초
                </p>
                <div className="fti-row">
                  <label>
                    제안 산술 미리보기
                    <select
                      aria-label="미리보기 폼"
                      value={previewForm}
                      onChange={(e) =>
                        setPreviewForm(e.target.value as Element)
                      }
                    >
                      {elements.map((el) => (
                        <option key={el} value={el}>
                          {elementNames[el]} 폼
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    전환 버프
                    <select
                      aria-label="미리보기 버프"
                      value={String(previewTimed)}
                      onChange={(e) =>
                        setPreviewTimed(e.target.value === "true")
                      }
                    >
                      <option value="false">꺼짐</option>
                      <option value="true">모두 활성</option>
                    </select>
                  </label>
                </div>
                {preview && (
                  <p data-testid="sp-preview">
                    20개를 모두 소지한 가정 · 최대 SP {preview.maxSp} · 재생{" "}
                    {preview.regenPerSecond}/초 · 회피 {preview.dodgeCost} ·
                    전환 {preview.switchCost}. 게임 적용값이 아닌 제안
                    계산입니다.
                  </p>
                )}
                <button
                  disabled={busy}
                  onClick={() => void act(() => api.repairReferenceIds(input!))}
                >
                  변경 ID의 참조 갱신
                </button>
                {report?.issues.map((issue, n) => (
                  <button
                    className="fti-issue"
                    key={n}
                    onClick={() => {
                      if (issue.candidateKey) setSelected(issue.candidateKey);
                    }}
                  >
                    {issue.severity === "error" ? "확인" : "참고"} ·{" "}
                    {issue.message}
                  </button>
                ))}
              </details>
              <div className="fti-panel fti-export">
                <h3>파일로 내보내기</h3>
                <p>
                  JSON + PNG + 파일 검사 기록. 실제 게임의 전투 효과 연결은 별도
                  작업입니다.
                </p>
                <div className="fti-row">
                  <button
                    data-testid="export-draft"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        setReceipt(
                          await api.exportPackage({ ...input!, kind: "draft" }),
                        );
                      })
                    }
                  >
                    초안 묶음 보관
                  </button>
                  <button
                    data-testid="export-release"
                    className="fti-primary"
                    disabled={
                      busy ||
                      !report?.canExport ||
                      report.revision !== project.revision
                    }
                    onClick={() =>
                      void act(async () => {
                        setReceipt(
                          await api.exportPackage({
                            ...input!,
                            kind: "release",
                          }),
                        );
                      })
                    }
                  >
                    채택본 Unity 데이터 출력
                  </button>
                </div>
                {!report?.canExport && (
                  <p className="fti-muted">
                    현재 데이터·아이콘·정책 채택과 20개 구성을 확인하면 채택본을
                    출력할 수 있습니다.
                  </p>
                )}
                {receipt && (
                  <p data-testid="export-result">
                    {receipt.kind === "draft" ? "초안" : "채택본"} 저장 완료 ·{" "}
                    {receipt.files.length}개 파일
                    <br />
                    <code>{receipt.directory}</code>
                  </p>
                )}
              </div>
            </main>
            {item && (
              <FourTigerItemEditor
                project={project}
                item={item}
                busy={busy}
                act={act}
                save={(patch) =>
                  act(() =>
                    api.patchItem({
                      ...input!,
                      candidateKey: item.candidateKey,
                      patch,
                    }),
                  )
                }
              />
            )}
          </div>
        </>
      )}
      {confirm && project && (
        <div
          className="fti-modal"
          role="dialog"
          aria-modal="true"
          aria-label="아이템 채택 확인"
        >
          <div>
            <h2>선택한 {selection.length}개를 채택할까요?</h2>
            <p>
              {project.items
                .filter((i) => selection.includes(i.candidateKey))
                .map((i) => i.name)
                .join(" · ")}
            </p>
            <p>
              현재 데이터와 선택 아이콘을 각각 검토하고 공통 제안 정책을 채택한
              항목만 반영됩니다.
            </p>
            <button onClick={() => setConfirm(false)}>돌아가기</button>
            <button
              className="fti-primary"
              data-testid="confirm-adopt"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api.reviewItems({
                    ...input!,
                    candidateKeys: selection,
                    action: "adopt",
                    note: "채택 확인 화면에서 명시 채택",
                  }),
                ).then((ok) => {
                  if (ok) setConfirm(false);
                })
              }
            >
              선택 항목 채택 확정
            </button>
          </div>
        </div>
      )}
      {restoreId && (
        <div
          className="fti-modal"
          role="dialog"
          aria-modal="true"
          aria-label="이전 정상본 복구 확인"
        >
          <div>
            <h2>이전 정상 저장본을 복구할까요?</h2>
            <p>
              현재 읽을 수 없는 파일을 보관한 뒤 이전 정상본으로 돌아갑니다.
              마지막 정상 저장 이후의 수정은 포함되지 않을 수 있습니다.
            </p>
            <button onClick={() => setRestoreId(null)}>돌아가기</button>
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const p = await api.restorePrevious({ projectId: restoreId });
                  setSelected(p.items[0]?.candidateKey ?? "");
                  setStyle(p.iconStyle);
                  setPolicies({ ...p.ruleProfile.proposed });
                  setMarked([]);
                  setReceipt(null);
                  return p;
                }).then((ok) => {
                  if (ok) setRestoreId(null);
                })
              }
            >
              정상본 복구
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
