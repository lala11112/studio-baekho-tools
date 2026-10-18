import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AssetVersion,
  GraphicsAction,
  GraphicsWorkspace,
} from "../shared/graphics";
import type { PlanarMaterialPolicy } from "../shared/graphics-planar";
import { hasPersistedNativeMeterUnits } from "../shared/graphics-size-provenance";
import type { Project } from "../shared/types";
import { Viewport } from "./Viewport";
import { PlanarComparison } from "./PlanarComparison";
import {
  validatePlanarCandidateReport,
  currentPlanarInspection,
  planarBoundaryLabel,
  planarBoundaryCanRepair,
  planarBoundaryOverlay,
  planarSelectionConflict,
} from "./planar-review";
import "./graphics-planar.css";
const colors = ["#ffce62", "#63d9ff", "#ed9dff", "#91eea0", "#ffa18c"];
const requiredChecks = [
  "staticOnly",
  "appendOnly",
  "oldVerticesPreserved",
  "oldCustomAttributesPreserved",
  "oldCustomNormalsPreserved",
  "oldUVLayersPreserved",
  "otherMeshesPreserved",
  "materialsAndImagesPreserved",
  "intersectionValidation",
  "fbxRoundTrip",
  "glbRoundTrip",
];
function reasonLabel(reason: string) {
  if (
    /patch intersects existing surface|patch-patch|patches intersect/i.test(
      reason,
    )
  )
    return "새로 막을 면이 기존 표면이나 다른 복구 면과 겹쳐 복구를 멈췄습니다. 막을 영역을 바꾸거나 원래 열린 부분으로 유지하세요.";
  if (/branched|open boundary/.test(reason))
    return "경계가 갈라지거나 닫혀 있지 않아 자동으로 막을 수 없습니다.";
  if (/3 to 64|limit/.test(reason))
    return "이 경계의 크기는 현재 복구 범위를 벗어납니다.";
  if (/material|UV|texture|donor/.test(reason))
    return "기존 무늬를 안전하게 연결할 수 있는지 확인이 필요합니다.";
  if (/planar|coplanar|plane/.test(reason))
    return "평평한 면으로 안전하게 막을 수 없는 경계입니다.";
  if (/nested|intersection|overlap/.test(reason))
    return "다른 경계나 표면과 겹칠 수 있어 자동 복구하지 않습니다.";
  if (/winding/.test(reason))
    return "기존 면의 방향이 일관되지 않아 복구할 수 없습니다.";
  return "구조를 안전하게 복구할 수 있는지 추가 검토가 필요합니다.";
}
type SavedRepairReport = {
  uiVersionId: string;
  checks?: Record<string, boolean>;
  warnings?: string[];
  addedFaces?: number;
};
type Props = {
  project: Project;
  workspace: GraphicsWorkspace;
  source: AssetVersion;
  disabled: boolean;
  onAction: (action: GraphicsAction) => Promise<unknown>;
  onClose: () => void;
  onAccept: (version: AssetVersion) => void;
};
export function GraphicsPlanarReview({
  project,
  workspace,
  source,
  disabled,
  onAction,
  onClose,
  onAccept,
}: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  const report = workspace.planarInspections?.[source.id];
  const currentInspection = currentPlanarInspection(report);
  const [historicalResultId, setHistoricalResultId] = useState("");
  const draftKey = `partsmith.planar.${project.id}.${source.id}.${report?.reportFile?.sha256 ?? report?.inspectionId ?? "uninspected"}`;
  const [draft] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(draftKey) ?? "{}");
    } catch {
      return {};
    }
  });
  const [meshId, setMeshId] = useState<string>(draft.meshId ?? ""),
    [decisions, setDecisions] = useState<Record<string, "repair" | "keep">>(
      draft.decisions ?? {},
    ),
    [focus, setFocus] = useState(""),
    [policy, setPolicy] = useState<PlanarMaterialPolicy>(
      draft.policy === "reuse-existing-pattern"
        ? "reuse-existing-pattern"
        : "preserve",
    );
  useEffect(() => {
    if (report)
      try {
        localStorage.setItem(
          draftKey,
          JSON.stringify({ meshId, decisions, policy }),
        );
      } catch {}
  }, [draftKey, meshId, decisions, policy]);
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const [savedResult, setSavedResult] = useState<SavedRepairReport>(),
    [resultError, setResultError] = useState("");
  const mesh =
    report?.meshes.find((item) => item.meshId === meshId) ??
    (report?.meshes.length === 1 ? report.meshes[0] : undefined);
  const boundaries = mesh?.boundaries ?? [];
  const selected = boundaries.filter((b) => decisions[b.id] === "repair"),
    kept = boundaries.filter((b) => decisions[b.id] === "keep");
  const overlays = useMemo(
    () =>
      boundaries.map((b, i) =>
        planarBoundaryOverlay(b, colors[i % colors.length]),
      ),
    [mesh],
  );
  const savedCandidates = [...workspace.versions]
    .reverse()
    .filter((version) => version.planarRepair?.versionId === source.id);
  const result =
    savedCandidates.find((version) => version.id === historicalResultId) ??
    [...workspace.versions]
      .reverse()
      .find(
        (v) =>
          v.planarRepair?.versionId === source.id &&
          v.planarRepair.inspectionId === report?.inspectionId &&
          v.planarRepair.meshId === mesh?.meshId &&
          v.planarRepair.materialPolicy === policy &&
          JSON.stringify([...v.planarRepair.selectedBoundaryIds].sort()) ===
            JSON.stringify(selected.map((b) => b.id).sort()) &&
          JSON.stringify([...v.planarRepair.keptBoundaryIds].sort()) ===
            JSON.stringify(kept.map((b) => b.id).sort()) &&
          !!report?.reportFile?.sha256 &&
          workspace.tasks?.some(
            (t) =>
              t.outputVersionIds.includes(v.id) &&
              t.planarInspection?.reportFile?.sha256 ===
                report.reportFile?.sha256,
          ),
      );
  const resultTask =
    result &&
    workspace.tasks?.find((task) => task.outputVersionIds.includes(result.id));
  const resultInspection = resultTask?.planarInspection;
  const resultFocus =
    resultInspection?.meshes
      ?.find((item) => item.meshId === result?.planarRepair?.meshId)
      ?.boundaries.filter((boundary) =>
        result?.planarRepair?.selectedBoundaryIds.includes(boundary.id),
      )
      .map((boundary, index) =>
        planarBoundaryOverlay(boundary, colors[index % colors.length]),
      ) ?? [];
  const resultRequiredChecks =
    result?.planarRepair?.algorithmVersion === "planar-v2"
      ? [...requiredChecks, "keptBoundaryEdgesPreserved"]
      : requiredChecks;
  useEffect(() => {
    let cancelled = false;
    setSavedResult(undefined);
    setResultError("");
    const reportFile = result?.files.find(
      (file) =>
        file.kind === "report" && file.path === result.planarRepair?.reportPath,
    );
    if (result && !reportFile) {
      setResultError("이 복구본에 등록된 검사 보고서가 없습니다.");
      return;
    }
    if (result?.planarRepair?.reportPath && reportFile)
      void fetch(
        window.desktop.assetUrl(project.id, result.planarRepair.reportPath),
      )
        .then(async (response) => {
          if (!response.ok) throw Error("보고서를 읽지 못했습니다.");
          const bytes = await response.arrayBuffer();
          const digest = [
            ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          ]
            .map((value) => value.toString(16).padStart(2, "0"))
            .join("");
          if (
            bytes.byteLength !== reportFile.bytes ||
            digest !== reportFile.sha256
          )
            throw Error("등록된 검사 보고서의 파일 내용이 달라졌습니다.");
          const value = JSON.parse(new TextDecoder().decode(bytes));
          validatePlanarCandidateReport(value, result, source.id);
          return { ...value, uiVersionId: result.id };
        })
        .then((value) => {
          if (!cancelled) setSavedResult(value);
        })
        .catch((cause) => {
          if (!cancelled) setResultError(String(cause));
        });
    return () => {
      cancelled = true;
    };
  }, [project.id, result?.id]);
  const glb = source.files.find((f) => /\.glb$/i.test(f.path));
  const preview: Project = {
    ...project,
    assets: glb
      ? [
          {
            id: "planar-preview",
            file: glb.path,
            kind: "model",
            label: source.label,
            origin: "import",
            createdAt: source.createdAt,
          },
        ]
      : [],
    parts: [],
  };
  const lineage = new Set<string>();
  const visit = (id: string) => {
    if (lineage.has(id)) return;
    lineage.add(id);
    workspace.versions
      .find((v) => v.id === id)
      ?.sourceVersionIds?.forEach(visit);
  };
  source.sourceVersionIds?.forEach(visit);
  const owner = workspace.objects?.find((o) => o.id === source.objectId);
  const resultAccepted =
    !!result && Object.values(owner?.accepted ?? {}).includes(result.id);
  const exactReference = workspace.versions.find(
    (v) =>
      lineage.has(v.id) &&
      v.role === "design" &&
      v.files.some((f) => /\.(png|jpe?g|webp)$/i.test(f.path)),
  );
  const acceptedReference = workspace.versions.find(
    (v) =>
      v.id === owner?.accepted[`design:${source.slot}`] &&
      v.files.some((f) => /\.(png|jpe?g|webp)$/i.test(f.path)),
  );
  const reference = exactReference ?? acceptedReference;
  const image =
    reference?.preview ??
    reference?.files.find((f) => /\.(png|jpe?g|webp)$/i.test(f.path))?.path;
  const reuseAllowed =
    selected.length > 0 &&
    selected.every((b) => b.materialOptions.includes("reuse-existing-pattern"));
  const canRepair =
    currentInspection &&
    !!mesh &&
    selected.length > 0 &&
    selected.length + kept.length === boundaries.length &&
    selected.every(
      (b) => planarBoundaryCanRepair(b) && b.materialOptions.includes(policy),
    ) &&
    !planarSelectionConflict(
      boundaries,
      selected.map((boundary) => boundary.id),
    );
  const selectionConflict = planarSelectionConflict(
    boundaries,
    selected.map((boundary) => boundary.id),
  );
  const task = [...(workspace.tasks ?? [])]
    .reverse()
    .find(
      (t) =>
        ["LOCAL_PLANAR_INSPECT", "LOCAL_PLANAR_REPAIR"].includes(t.taskId) &&
        t.inputVersionIds.includes(source.id),
    );
  const running = task?.status === "running";
  const unchangedFailedSelection =
    !!task?.planarSelection &&
    ["failed", "cancelled", "submission_unknown"].includes(task.status) &&
    task.planarSelection.inspectionId === report?.inspectionId &&
    task.planarSelection.meshId === mesh?.meshId &&
    task.planarSelection.materialPolicy === policy &&
    JSON.stringify([...task.planarSelection.selectedBoundaryIds].sort()) ===
      JSON.stringify(selected.map((b) => b.id).sort()) &&
    JSON.stringify([...task.planarSelection.keptBoundaryIds].sort()) ===
      JSON.stringify(kept.map((b) => b.id).sort());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  async function perform(action: GraphicsAction) {
    setPending(true);
    setError("");
    try {
      await onAction(action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <section
      className="gs-planar"
      aria-label="빠진 면 검사와 복구"
      data-testid="graphics-planar-review"
    >
      <header>
        <div>
          <h3 ref={heading} tabIndex={-1}>
            빠진 면 검사
          </h3>
          <p>
            평평한 면의 빈 부분을 확인하고, 막을 경계와 열린 채 유지할 경계를
            직접 고르세요.
          </p>
        </div>
        <button onClick={onClose}>닫기</button>
      </header>
      <p className="gs-planar-source">
        정확한 원본: <strong>{source.label}</strong>
        <br />
        <code>{source.id}</code>
      </p>
      <div hidden={!error} role="alert">
        {error && (
          <>
            {reasonLabel(error)} 기존 원본은 유지됩니다.
            <details>
              <summary>검사 오류 기록</summary>
              {error}
            </details>
          </>
        )}
      </div>
      {running && (
        <p role="status" aria-live="polite">
          ◌{" "}
          {task?.taskId === "LOCAL_PLANAR_REPAIR"
            ? "선택한 부분 로컬 복구 중"
            : "원본 로컬 검사 중"}{" "}
          ·{" "}
          {Math.max(0, Math.floor((now - Date.parse(task!.createdAt)) / 1000))}
          초 경과 · GPT 0 · 유료 제출 0
        </p>
      )}
      {task &&
        ["failed", "cancelled", "submission_unknown"].includes(task.status) && (
          <div role="status">
            <p>
              {task.status === "cancelled"
                ? "로컬 작업을 중지했습니다."
                : reasonLabel(task.message)}{" "}
              기존 원본은 유지됩니다.
            </p>
            {unchangedFailedSelection && (
              <p>
                같은 선택은 다시 실행하지 않습니다. 경계의 용도를 바꾸거나
                원본을 다시 검사하세요.
              </p>
            )}
            <details>
              <summary>중단 기록</summary>
              <p>{task.message}</p>
            </details>
            {task.planarSelection && (
              <button
                disabled={disabled || pending || running}
                onClick={() =>
                  void perform({ kind: "recover", taskId: task.id })
                }
              >
                저장된 로컬 결과 확인
              </button>
            )}
          </div>
        )}
      {savedCandidates.length > 0 && (
        <details className="gs-planar-history">
          <summary>저장된 복구본 {savedCandidates.length}개</summary>
          <p>
            이전 검사로 만든 결과는 현재의 경계 선택과 별도로 확인할 수
            있습니다.
          </p>
          {savedCandidates.map((version) => (
            <button
              key={version.id}
              disabled={pending || running}
              onClick={() => setHistoricalResultId(version.id)}
            >
              {version.label} · {version.id.slice(0, 8)} 비교
            </button>
          ))}
          {historicalResultId && (
            <button onClick={() => setHistoricalResultId("")}>
              현재 검사로 돌아가기
            </button>
          )}
        </details>
      )}
      {report && !currentInspection && (
        <p role="status" className="gs-planar-inspection-update">
          이전 방식의 검사 기록입니다. 새 부분을 복구하려면 이 원본을 다시
          검사하세요. 저장된 복구본 확인·사용은 계속할 수 있습니다. 재검사는
          자동으로 실행하지 않습니다.
        </p>
      )}
      {!report ? (
        <div>
          <p>검사는 컴퓨터에서 실행하고 저장합니다. GPT 호출 0 · 유료 제출 0</p>
          <button
            disabled={disabled || pending}
            onClick={() =>
              void perform({ kind: "inspect-planar", versionId: source.id })
            }
          >
            {pending ? "로컬 검사 중…" : "이 원본의 빠진 면 검사"}
          </button>
        </div>
      ) : (
        <>
          <p role="status">
            저장된 검사 · {report.meshes.length}개 메시 · 원본 SHA{" "}
            {report.sourceSha256.slice(0, 12)} · 자동 선택 없음
          </p>
          <button
            disabled={disabled || pending || running}
            onClick={() =>
              void perform({ kind: "inspect-planar", versionId: source.id })
            }
          >
            이 원본 다시 검사
          </button>
          {result ? (
            <div className="gs-planar-result-layout">
              <PlanarComparison
                projectId={project.id}
                baseline={source}
                candidate={result}
                choices={[source]}
                onBaseline={() => {}}
                onClose={onClose}
                focusBoundaries={resultFocus}
              />
              <section
                className="gs-planar-result-guide"
                aria-label="복구 결과 확인"
              >
                <div className="gs-planar-result-body">
                  <h4>복구본 저장됨 · 사용자 외형 검토 대기</h4>
                  {historicalResultId && (
                    <p>
                      저장된 복구본 보기 · 현재 검사에서 선택한 부분을 새로
                      복구한 결과가 아닙니다.
                    </p>
                  )}
                  {result.planarRepair?.algorithmVersion === "planar-v1" && (
                    <p>이전 검사 기준으로 만든 복구본입니다.</p>
                  )}
                  <p>
                    구조·UV·재질 검사는 저장된 보고서에서 확인하세요. 무늬
                    늘어짐, 반복, 이음새와 면 방향은 직접 검토해야 합니다.
                  </p>
                  <dl className="gs-planar-checks">
                    {[
                      {
                        label: "구조 보존",
                        keys: [
                          "staticOnly",
                          "appendOnly",
                          "oldVerticesPreserved",
                          "oldCustomAttributesPreserved",
                          "oldCustomNormalsPreserved",
                          "otherMeshesPreserved",
                          "intersectionValidation",
                        ],
                      },
                      {
                        label: "UV",
                        keys: [
                          "oldUVLayersPreserved",
                          "fbxRoundTrip",
                          "glbRoundTrip",
                        ],
                      },
                      {
                        label: "재질·이미지",
                        keys: ["materialsAndImagesPreserved"],
                      },
                      ...(result?.planarRepair?.algorithmVersion === "planar-v2"
                        ? [
                            {
                              label: "열린 경계 유지",
                              keys: ["keptBoundaryEdgesPreserved"],
                            },
                          ]
                        : []),
                    ].map(({ label, keys }) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>
                          {savedResult
                            ? keys
                                .filter((key) =>
                                  resultRequiredChecks.includes(key),
                                )
                                .every(
                                  (key) => savedResult.checks?.[key] === true,
                                )
                              ? "검사 통과"
                              : "확인 필요"
                            : "저장 보고서 확인 중"}
                        </dd>
                      </div>
                    ))}
                    <div>
                      <dt>외형</dt>
                      <dd>사용자 검토 대기</dd>
                    </div>
                  </dl>
                  {resultError && (
                    <p role="alert">보고서 확인 불가 · {resultError}</p>
                  )}
                  <details>
                    <summary>검사 상세 기록</summary>
                    {savedResult?.warnings?.map((warning, i) => (
                      <p key={i}>{warning}</p>
                    ))}
                    <code>{result.planarRepair?.reportPath}</code>
                  </details>
                </div>
                <div className="gs-planar-result-actions">
                  <button
                    disabled={
                      disabled ||
                      pending ||
                      resultAccepted ||
                      !savedResult ||
                      savedResult.uiVersionId !== result.id ||
                      !savedResult.checks ||
                      resultRequiredChecks.some(
                        (key) => savedResult.checks?.[key] !== true,
                      )
                    }
                    onClick={() => onAccept(result)}
                  >
                    {resultAccepted ? "사용 중인 복구본" : "이 복구본 사용"}
                  </button>
                  <button onClick={onClose}>기존 결과 유지</button>
                </div>
              </section>
            </div>
          ) : (
            <>
              <div className="gs-planar-grid">
                <div className="gs-planar-visual">
                  <div className="gs-planar-canvas">
                    {glb ? (
                      <Viewport
                        project={preview}
                        previewId="planar-preview"
                        unitsKnown={hasPersistedNativeMeterUnits(source, workspace.tasks)}
                        boundaryOverlays={overlays}
                        focusedBoundaryId={focus}
                      />
                    ) : (
                      <p role="status">
                        이 원본은 GLB 미리보기가 없습니다. 화면으로 경계를
                        확인할 수 없어 복구를 진행할 수 없습니다.
                      </p>
                    )}
                  </div>
                  {image ? (
                    <figure>
                      <img
                        src={window.desktop.assetUrl(project.id, image)}
                        alt="빠진 면 검토용 참고 이미지"
                      />
                      <figcaption>
                        {exactReference
                          ? "이 원본 제작에 쓰인 참고 이미지"
                          : "현재 사용하는 같은 파트 이미지 · 원본 제작 이미지와 다를 수 있음"}
                      </figcaption>
                    </figure>
                  ) : (
                    <p>참고 이미지 없음 · 경계의 용도를 직접 확인하세요.</p>
                  )}
                </div>
                <aside
                  className="gs-planar-decisions"
                  aria-label="복구 영역 선택"
                >
                  <label>
                    검사할 메시
                    <select
                      value={mesh?.meshId ?? ""}
                      onChange={(e) => {
                        setMeshId(e.target.value);
                        setDecisions({});
                        setFocus("");
                        setPolicy("preserve");
                      }}
                    >
                      <option value="">메시를 선택하세요</option>
                      {report.meshes.map((m) => (
                        <option key={m.meshId} value={m.meshId}>
                          {m.name} · {m.boundaries.length}개 경계
                        </option>
                      ))}
                    </select>
                  </label>
                  {mesh && boundaries.length === 0 && (
                    <p role="status">
                      열린 경계가 없습니다. 이미 면이 막혀 있다면 복구 대상으로
                      다시 나오지 않습니다. 기존 면을 중복해서 추가하지
                      않습니다.
                    </p>
                  )}
                  {currentInspection && (
                    <p className="gs-planar-boundary-note">
                      이 원본에서 실제로 열린 경계만 표시합니다. 이미 막힌 큰
                      부분은 다시 나오지 않으며, 같은 면을 중복해서 추가하지
                      않습니다.
                    </p>
                  )}
                  <div className="gs-planar-boundaries">
                    {boundaries.map((b, i) => (
                      <fieldset key={b.id}>
                        <legend>
                          <span style={{ color: colors[i % colors.length] }}>
                            ●
                          </span>{" "}
                          영역 {b.number} · {planarBoundaryLabel(b)} ·{" "}
                          {planarBoundaryCanRepair(b)
                            ? "평면 복구 가능"
                            : "지원하지 않음 · 검토 필요"}
                        </legend>
                        {b.kind === "subcycle" && (
                          <p className="gs-planar-boundary-note">
                            갈라진 선에서 따로 찾은 닫힌 고리입니다. 남은 열린
                            선은 별도로 유지하며, 이 고리만 검사 후 복구합니다.
                          </p>
                        )}
                        {b.kind === "open-chain" && (
                          <p className="gs-planar-boundary-note">
                            고리로 닫히지 않은 선입니다. 자동으로 이어 막지
                            않으며 열린 채 유지하세요.
                          </p>
                        )}
                        <button disabled={!glb} onClick={() => setFocus(b.id)}>
                          영역 {b.number} 확대
                        </button>
                        {b.reasons.length > 0 && (
                          <>
                            <p>{reasonLabel(b.reasons[0])}</p>
                            <details>
                              <summary>자세한 검사 이유</summary>
                              {b.reasons.map((reason, index) => (
                                <p key={index}>{reason}</p>
                              ))}
                            </details>
                          </>
                        )}
                        <label>
                          <input
                            type="radio"
                            name={b.id}
                            checked={decisions[b.id] === "repair"}
                            disabled={
                              !currentInspection || !planarBoundaryCanRepair(b)
                            }
                            onChange={() =>
                              setDecisions((d) => ({ ...d, [b.id]: "repair" }))
                            }
                          />
                          막을 부분
                        </label>
                        <label>
                          <input
                            type="radio"
                            name={b.id}
                            checked={decisions[b.id] === "keep"}
                            onChange={() =>
                              setDecisions((d) => ({ ...d, [b.id]: "keep" }))
                            }
                          />
                          원래 열린 부분·유지
                        </label>
                      </fieldset>
                    ))}
                  </div>
                  <label>
                    새 면의 재질
                    <select
                      value={policy}
                      onChange={(e) =>
                        setPolicy(e.target.value as PlanarMaterialPolicy)
                      }
                    >
                      <option value="preserve">기존 텍스처 보존</option>
                      {reuseAllowed && (
                        <option value="reuse-existing-pattern">
                          기존 무늬 재사용 · 반복·늘어짐 가능
                        </option>
                      )}
                    </select>
                  </label>
                  <div
                    className="gs-planar-summary"
                    aria-label="복구 실행 요약"
                  >
                    <strong>실행 전 확인</strong>
                    {selectionConflict && (
                      <p role="alert">
                        선택한 고리가 같은 경계를 공유하거나 서로 겹칠 수
                        있습니다. 함께 막지 말고 한쪽을 유지로 바꾸세요.
                      </p>
                    )}
                    {!currentInspection && (
                      <p>새 복구는 원본을 다시 검사한 뒤 선택할 수 있습니다.</p>
                    )}
                    <p>
                      {source.label} · {source.id.slice(0, 8)}
                      <br />
                      메시: {mesh?.name ?? "선택 대기"}
                      <br />
                      막을 영역:{" "}
                      {selected.map((b) => b.number).join(", ") || "없음"} ·
                      유지: {kept.length}개<br />
                      추가 면 예상:{" "}
                      {selected.reduce(
                        (n, b) => n + (b.addedQuads ?? 0),
                        0,
                      )}{" "}
                      사각형 ·{" "}
                      {selected.reduce(
                        (n, b) => n + (b.addedFaces ?? 0) - (b.addedQuads ?? 0),
                        0,
                      )}{" "}
                      삼각형 (게임 표시{" "}
                      {selected.reduce(
                        (n, b) => n + (b.addedFaces ?? 0) + (b.addedQuads ?? 0),
                        0,
                      )}{" "}
                      삼각형)
                      <br />
                      재질:{" "}
                      {policy === "preserve"
                        ? "기존 텍스처 보존"
                        : "기존 무늬 재사용"}
                      <br />
                      GPT 호출 0 · 유료 제출 0
                    </p>
                    <p>
                      모든 경계의 용도를 정해야 실행할 수 있습니다. 회색 임시
                      면을 완성 결과로 사용하지 않습니다.
                    </p>
                    <button
                      disabled={
                        disabled ||
                        pending ||
                        running ||
                        !canRepair ||
                        !glb ||
                        unchangedFailedSelection
                      }
                      onClick={() =>
                        report &&
                        mesh &&
                        void perform({
                          kind: "repair-planar",
                          versionId: source.id,
                          inspectionId: report.inspectionId,
                          meshId: mesh.meshId,
                          selectedBoundaryIds: selected.map((b) => b.id),
                          keptBoundaryIds: kept.map((b) => b.id),
                          materialPolicy: policy,
                        })
                      }
                    >
                      {pending ? "로컬 복구 중…" : "선택한 부분 복구"}
                    </button>
                  </div>
                </aside>
              </div>
            </>
          )}
          {report.warnings?.map((warning, i) => (
            <p key={i} role="status">
              {warning}
            </p>
          ))}
        </>
      )}
    </section>
  );
}
