import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  CircleAlert,
  Download,
  FolderOpen,
  Headphones,
  LoaderCircle,
  Music2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import {
  BGM_GENRES,
  BGM_MOODS,
  BGM_PRICE_CHECKED,
  BGM_PRICE_USD,
  type BgmState,
  type BgmStatus,
} from "../shared/bgm";

const statusNames: Record<BgmStatus, string> = {
  submitting: "요청 전송 중",
  queued: "생성 대기 중",
  generating: "음악 생성 중",
  "download-pending": "로컬 저장 대기",
  ready: "미리듣기 준비 완료",
  failed: "생성 실패",
  uncertain: "제출 결과 확인 필요",
};
const pollingStatuses: BgmStatus[] = [
  "submitting",
  "queued",
  "generating",
  "download-pending",
];
const dollars = (value: number) => `USD ${value.toFixed(2)}`;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("ko-KR", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date)
    : "저장된 작업";
}

export function BgmWorkshop({ active = true }: { active?: boolean }) {
  const bridge = typeof window.bgm !== "undefined";
  const [state, setState] = useState<BgmState | null>(null);
  const [genres, setGenres] = useState<string[]>([]);
  const [moods, setMoods] = useState<string[]>([]);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [needsReconcile, setNeedsReconcile] = useState(true);
  const [exportNotice, setExportNotice] = useState<{
    text: string;
    path?: string;
  } | null>(null);
  const [audioErrors, setAudioErrors] = useState<Record<string, boolean>>({});
  const [audioVersions, setAudioVersions] = useState<Record<string, number>>(
    {},
  );
  const alive = useRef(true);
  const locked = useRef(false);
  const latest = useRef<BgmState | null>(null);
  const pollIndex = useRef(0);
  const root = useRef<HTMLElement>(null);

  // Every bridge operation shares one gate, including background status checks.
  // Paid calls are reachable only through explicit button handlers below.
  const runState = useCallback(
    async (kind: string, action: () => Promise<BgmState>) => {
      if (!bridge || locked.current) return;
      locked.current = true;
      setBusy(kind);
      if (kind !== "poll") setError("");
      try {
        const next = await action();
        latest.current = next;
        if (alive.current) {
          setState(next);
          setNeedsReconcile(false);
          setError("");
        }
      } catch (cause) {
        // An IPC rejection is not proof a paid submission failed. Re-read the
        // durable ledger before permitting another paid operation.
        if (kind === "generate" || kind.startsWith("retry:")) {
          if (alive.current) setNeedsReconcile(true);
          try {
            const next = await window.bgm.state();
            latest.current = next;
            if (alive.current) {
              setState(next);
              setNeedsReconcile(false);
            }
          } catch {
            /* Keep paid actions blocked until a successful state read. */
          }
        }
        if (alive.current) setError(errorText(cause));
      } finally {
        locked.current = false;
        if (alive.current) setBusy("");
      }
    },
    [bridge],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active || !bridge) return;
    void runState("load", () => window.bgm.state());
    const timer = window.setInterval(() => {
      if (locked.current) return;
      const candidates =
        latest.current?.candidates.filter(
          (candidate) =>
            candidate.requestId && pollingStatuses.includes(candidate.status),
        ) ?? [];
      if (!candidates.length) return;
      const candidate = candidates[pollIndex.current++ % candidates.length];
      void runState("poll", () => window.bgm.refresh(candidate.id));
    }, 3000);
    return () => window.clearInterval(timer);
  }, [active, bridge, runState]);

  useEffect(() => {
    if (!active)
      root.current?.querySelectorAll("audio").forEach((audio) => audio.pause());
  }, [active]);

  const price = state?.priceUsd ?? BGM_PRICE_USD;
  const batchCost = price * 3;
  const reserved = state?.totalReservedUsd ?? 0;
  const remaining = Math.max(0, (state?.budgetUsd ?? 0) - reserved);
  const hasInput =
    genres.length > 0 || moods.length > 0 || description.trim().length > 0;
  const hasPendingSubmission = state?.candidates.some(
    (candidate) => candidate.status === "submitting",
  );
  const canPay = Boolean(
    state?.configured && !busy && !needsReconcile && !hasPendingSubmission,
  );
  const canGenerate = canPay && hasInput && remaining + 0.000001 >= batchCost;
  const selected = state?.candidates.find(
    (candidate) =>
      candidate.id === state.selectedId &&
      candidate.status === "ready" &&
      candidate.previewUrl,
  );
  const batches = new Map<string, NonNullable<BgmState["candidates"]>>();
  for (const candidate of state?.candidates ?? []) {
    const batch = batches.get(candidate.batchId) ?? [];
    batch.push(candidate);
    batches.set(candidate.batchId, batch);
  }
  const orderedBatches = [...batches.entries()].sort((a, b) =>
    b[1][0].createdAt.localeCompare(a[1][0].createdAt),
  );

  const toggle = (
    value: string,
    values: string[],
    update: (next: string[]) => void,
  ) => {
    update(
      values.includes(value)
        ? values.filter((item) => item !== value)
        : [...values, value],
    );
  };

  const exportSelected = async () => {
    if (!bridge || locked.current || !selected) return;
    locked.current = true;
    setBusy("export");
    setError("");
    setExportNotice(null);
    try {
      const result = await window.bgm.export(selected.id);
      if (alive.current)
        setExportNotice(
          result.canceled
            ? {
                text: "내보내기를 취소했어요. 원본 MP3는 앱에 보관되어 있습니다.",
              }
            : { text: "MP3를 내보냈어요.", path: result.path },
        );
    } catch (cause) {
      if (alive.current) setError(errorText(cause));
    } finally {
      locked.current = false;
      if (alive.current) setBusy("");
    }
  };

  if (!bridge)
    return (
      <section className="bgm-workshop bgm-unavailable">
        <CircleAlert size={30} />
        <h2>BGM 연결을 사용할 수 없어요.</h2>
        <p>업데이트된 백호툴 데스크톱 앱에서 다시 열어주세요.</p>
      </section>
    );

  return (
    <main className="bgm-workshop" ref={root} aria-label="BGM 작업실">
      <div className="bgm-intro">
        <div>
          <span className="bgm-eyebrow">A SOUND FOR YOUR SCENE</span>
          <h2>어떤 장면이 들리나요?</h2>
          <p>
            분위기를 고르고, 세 가지 음악을 비교해 마음에 드는 한 곡을
            골라보세요.
          </p>
        </div>
        <div className="bgm-model-tag">
          <Music2 size={16} /> Google Lyria 3 <span>약 30초 · MP3</span>
        </div>
      </div>

      {error && (
        <div className="bgm-notice bgm-notice-error" role="alert">
          <CircleAlert size={18} />
          <div>
            <strong>작업 상태를 확인해 주세요.</strong>
            <p>{error}</p>
          </div>
        </div>
      )}
      {exportNotice && (
        <div className="bgm-notice" role="status">
          <CheckCircle2 size={18} />
          <div>
            {exportNotice.text}
            {exportNotice.path && (
              <code className="bgm-path">{exportNotice.path}</code>
            )}
          </div>
        </div>
      )}

      <div className="bgm-layout">
        <section className="bgm-compose" aria-labelledby="bgm-compose-title">
          <div className="bgm-section-heading">
            <span className="bgm-step">01</span>
            <h3 id="bgm-compose-title">음악의 방향</h3>
          </div>
          <fieldset className="bgm-options" disabled={busy === "generate"}>
            <legend>
              장르 <span>여러 개 선택할 수 있어요</span>
            </legend>
            <div className="bgm-pills">
              {BGM_GENRES.map((genre) => (
                <button
                  type="button"
                  key={genre}
                  aria-pressed={genres.includes(genre)}
                  className={`bgm-pill${genres.includes(genre) ? " bgm-pill-selected" : ""}`}
                  onClick={() => toggle(genre, genres, setGenres)}
                >
                  {genre}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="bgm-options" disabled={busy === "generate"}>
            <legend>
              감정 <span>함께 담고 싶은 분위기</span>
            </legend>
            <div className="bgm-pills">
              {BGM_MOODS.map((mood) => (
                <button
                  type="button"
                  key={mood}
                  aria-pressed={moods.includes(mood)}
                  className={`bgm-pill${moods.includes(mood) ? " bgm-pill-selected" : ""}`}
                  onClick={() => toggle(mood, moods, setMoods)}
                >
                  {mood}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="bgm-description-field">
            <label htmlFor="bgm-description">
              장면 설명 <span>선택 사항</span>
            </label>
            <textarea
              id="bgm-description"
              data-testid="bgm-description"
              rows={4}
              maxLength={4000}
              value={description}
              disabled={busy === "generate"}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="예: 달빛 아래 대나무 숲을 걷는 장면. 잔잔한 가야금과 낮은 현악기, 느린 리듬으로 신비롭게."
              aria-describedby="bgm-description-help"
            />
            <div className="bgm-field-help" id="bgm-description-help">
              <span>장면·악기·빠르기를 자유롭게 적어주세요.</span>
              <span>{description.length.toLocaleString()} / 4,000</span>
            </div>
          </div>
          <div className="bgm-format">
            <span>기본 생성</span>
            <strong>
              후보 3개 <span>×</span> 각 약 30초
            </strong>
            <span>보컬 없는 배경음악을 요청합니다.</span>
          </div>

          <div className="bgm-cost" aria-label="예상 생성 비용">
            <div className="bgm-cost-heading">
              <span>이번 생성 예상 비용</span>
              <strong>{dollars(batchCost)}</strong>
            </div>
            <p>오디오 1개 {dollars(price)} × 3개</p>
            <div className="bgm-budget">
              <span>누적 예약 예상액</span>
              <strong>
                {dollars(reserved)} /{" "}
                {state ? dollars(state.budgetUsd) : "불러오는 중"}
              </strong>
            </div>
            <p className="bgm-price-note">
              공식 단가 확인: {state?.priceCheckedAt ?? BGM_PRICE_CHECKED}
              <br />
              예약 예상액은 실제 청구액이 아닙니다. 실제 청구액은 fal 최종 결제
              내역에서 확인하세요.
            </p>
          </div>

          <button
            type="button"
            className="bgm-generate"
            data-testid="bgm-generate"
            disabled={!canGenerate}
            onClick={() => {
              if (!canGenerate) return;
              setExportNotice(null);
              void runState("generate", () =>
                window.bgm.generate({
                  genres,
                  moods,
                  description: description.trim(),
                }),
              );
            }}
          >
            {busy === "generate" ? (
              <LoaderCircle size={18} className="bkh-spin" />
            ) : (
              <Sparkles size={18} />
            )}
            {busy === "generate"
              ? "후보 3개 요청 중…"
              : `후보 3개 만들기 · ${dollars(batchCost)}`}
          </button>
          <p className="bgm-generate-help">
            {!state
              ? "저장된 상태를 불러오고 있어요."
              : !state.configured
                ? "fal 연결을 확인하면 생성할 수 있어요."
                : needsReconcile
                  ? "최신 상태를 다시 불러온 뒤 생성할 수 있어요."
                  : hasPendingSubmission
                    ? "전송 중인 요청을 먼저 확인하고 있어요."
                    : remaining + 0.000001 < batchCost
                      ? "남은 요청 예산이 부족합니다. 기존 후보는 계속 확인할 수 있어요."
                      : !hasInput
                        ? "장르·감정을 고르거나 장면을 설명해주세요."
                        : "버튼을 누르면 유료 생성 요청 3개를 제출합니다."}
          </p>

          <div
            className={`bgm-connection${state?.configured ? " bgm-connection-ready" : ""}`}
          >
            {state?.configured ? (
              <CheckCircle2 size={16} />
            ) : (
              <CircleAlert size={16} />
            )}
            <div>
              <strong>
                {state
                  ? state.configured
                    ? "fal 연결 준비 완료"
                    : "fal 인증 설정이 필요해요"
                  : "fal 연결 확인 중"}
              </strong>
              <p>
                {state?.configured
                  ? "앱의 보안 연결을 사용합니다. 키는 이 화면에 전달되지 않습니다."
                  : "앱 실행 환경의 FAL_KEY 또는 기존 암호화된 fal 인증을 설정한 뒤 상태를 다시 불러오세요."}
              </p>
            </div>
          </div>
          <button
            className="bgm-text-button"
            type="button"
            disabled={Boolean(busy)}
            onClick={() => {
              void runState("load", () => window.bgm.state());
            }}
          >
            <RefreshCw
              size={14}
              className={busy === "load" ? "bkh-spin" : ""}
            />
            연결·저장 상태 다시 불러오기
          </button>
        </section>

        <section className="bgm-results" aria-labelledby="bgm-results-title">
          <div className="bgm-results-heading">
            <div className="bgm-section-heading">
              <span className="bgm-step">02</span>
              <h3 id="bgm-results-title">듣고, 비교하고, 선택하기</h3>
            </div>
            <span>{state?.candidates.length ?? 0}개 후보</span>
          </div>
          {!state?.candidates.length ? (
            <div className="bgm-empty">
              <div className="bgm-empty-art">
                <Headphones size={42} strokeWidth={1.2} />
              </div>
              <h4>
                {busy === "generate"
                  ? "세 가지 음악을 요청하고 있어요."
                  : "아직 조용한 작업실이에요."}
              </h4>
              <p>
                {busy === "generate"
                  ? "요청 결과가 저장되면 각 후보의 진행 상황이 여기에 표시됩니다."
                  : "음악의 방향을 정해 첫 후보를 만들어보세요. 완성된 음악은 여기에서 바로 들을 수 있어요."}
              </p>
              <div className="bgm-empty-spec">
                <span>01 · 생성</span>
                <span>02 · 미리듣기</span>
                <span>03 · MP3 저장</span>
              </div>
            </div>
          ) : (
            <div className="bgm-batches">
              {orderedBatches.map(([batchId, candidates]) => (
                <section
                  key={batchId}
                  className="bgm-batch"
                  aria-label={`${dateLabel(candidates[0].createdAt)} 생성 후보`}
                >
                  <div className="bgm-batch-heading">
                    <span>{dateLabel(candidates[0].createdAt)}</span>
                    <span>{candidates.length}개 후보</span>
                  </div>
                  <div className="bgm-candidates">
                    {[...candidates]
                      .sort((a, b) => a.index - b.index)
                      .map((candidate) => {
                        const ready =
                          candidate.status === "ready" &&
                          Boolean(candidate.previewUrl);
                        const isSelected = selected?.id === candidate.id;
                        const pending = pollingStatuses.includes(
                          candidate.status,
                        );
                        return (
                          <article
                            key={candidate.id}
                            data-testid={`bgm-candidate-${candidate.id}`}
                            data-status={candidate.status}
                            className={`bgm-candidate${isSelected ? " bgm-candidate-selected" : ""}`}
                          >
                            <div className="bgm-candidate-heading">
                              <span className="bgm-track-icon">
                                <Music2 size={20} />
                              </span>
                              <div>
                                <h4>후보 {candidate.index}</h4>
                                <span>약 30초 · MP3</span>
                              </div>
                              <span
                                className={`bgm-status bgm-status-${candidate.status}`}
                                role="status"
                              >
                                {pending && (
                                  <LoaderCircle
                                    size={12}
                                    className="bkh-spin"
                                  />
                                )}
                                {ready && <Check size={12} />}
                                {statusNames[candidate.status]}
                              </span>
                            </div>
                            {ready && (
                              <audio
                                key={`${candidate.id}:${audioVersions[candidate.id] ?? 0}`}
                                controls
                                preload="metadata"
                                src={candidate.previewUrl}
                                aria-label={`후보 ${candidate.index} 미리듣기`}
                                onError={() =>
                                  setAudioErrors((previous) => ({
                                    ...previous,
                                    [candidate.id]: true,
                                  }))
                                }
                                onPlay={(event) => {
                                  const current = event.currentTarget;
                                  root.current
                                    ?.querySelectorAll("audio")
                                    .forEach((audio) => {
                                      if (audio !== current) audio.pause();
                                    });
                                }}
                              />
                            )}
                            {audioErrors[candidate.id] && (
                              <p className="bgm-candidate-error" role="alert">
                                미리듣기를 재생하지 못했어요. MP3 내보내기로
                                저장된 파일을 확인해 주세요.
                              </p>
                            )}
                            {pending && (
                              <p className="bgm-candidate-note">
                                {candidate.status === "download-pending"
                                  ? "생성된 MP3를 이 컴퓨터에 저장하고 있어요. 같은 요청을 다시 확인하며 추가 생성 비용은 없습니다."
                                  : "요청한 음악을 준비하고 있어요. 이 화면을 나갔다 돌아와도 작업 기록은 유지됩니다."}
                              </p>
                            )}
                            {candidate.status === "uncertain" && (
                              <p className="bgm-candidate-note">
                                제출 여부가 불확실합니다. 중복 과금을 막기 위해
                                이 후보의 재시도는 제공하지 않습니다. 요청
                                기록을 먼저 확인해 주세요.
                              </p>
                            )}
                            {candidate.status === "failed" && (
                              <p className="bgm-candidate-note">
                                이 후보의 생성이 실패했습니다. 다시 만들기는 새
                                유료 요청이며 기존 후보는 보존됩니다.
                              </p>
                            )}
                            {candidate.error && (
                              <p className="bgm-candidate-error">
                                {candidate.error}
                              </p>
                            )}
                            <div className="bgm-candidate-meta">
                              <span>
                                예약 예상 {dollars(candidate.estimatedCostUsd)}
                              </span>
                              <span title={candidate.requestId}>
                                요청 ID:{" "}
                                {candidate.requestId ?? "아직 확인되지 않음"}
                              </span>
                            </div>
                            <details className="bgm-prompt">
                              <summary>요청한 음악 설명</summary>
                              <p>{candidate.prompt}</p>
                            </details>
                            <div className="bgm-candidate-actions">
                              {ready && (
                                <button
                                  type="button"
                                  data-testid={`bgm-select-${candidate.id}`}
                                  className={`bgm-select${isSelected ? " bgm-select-active" : ""}`}
                                  aria-pressed={isSelected}
                                  disabled={Boolean(busy)}
                                  onClick={() => {
                                    setExportNotice(null);
                                    void runState(
                                      `select:${candidate.id}`,
                                      () => window.bgm.select(candidate.id),
                                    );
                                  }}
                                >
                                  <Check size={15} />
                                  {isSelected ? "선택한 음악" : "이 음악 선택"}
                                </button>
                              )}
                              {candidate.status === "failed" && candidate.canRetry && (
                                <button
                                  type="button"
                                  data-testid={`bgm-retry-${candidate.id}`}
                                  className="bgm-retry"
                                  disabled={
                                    !canPay || remaining + 0.000001 < price
                                  }
                                  onClick={() => {
                                    void runState(`retry:${candidate.id}`, () =>
                                      window.bgm.retry(candidate.id),
                                    );
                                  }}
                                >
                                  <RefreshCw size={14} />
                                  다시 만들기 · {dollars(price)}
                                </button>
                              )}
                              {(pending ||
                                candidate.status === "uncertain" ||
                                (ready && audioErrors[candidate.id])) &&
                                candidate.requestId && (
                                  <button
                                    type="button"
                                    data-testid={`bgm-refresh-${candidate.id}`}
                                    className="bgm-text-button"
                                    disabled={Boolean(busy)}
                                    onClick={() => {
                                      void runState(
                                        `refresh:${candidate.id}`,
                                        async () => {
                                          const next = await window.bgm.refresh(
                                            candidate.id,
                                          );
                                          if (
                                            alive.current &&
                                            next.candidates.some(
                                              (item) =>
                                                item.id === candidate.id &&
                                                item.status === "ready",
                                            )
                                          ) {
                                            setAudioErrors((previous) => ({
                                              ...previous,
                                              [candidate.id]: false,
                                            }));
                                            setAudioVersions((previous) => ({
                                              ...previous,
                                              [candidate.id]:
                                                (previous[candidate.id] ?? 0) +
                                                1,
                                            }));
                                          }
                                          return next;
                                        },
                                      );
                                    }}
                                  >
                                    <RefreshCw size={14} />
                                    {ready && audioErrors[candidate.id]
                                      ? "로컬 파일 다시 받기 · 추가 비용 없음"
                                      : candidate.status === "download-pending"
                                        ? "저장 다시 확인 · 추가 비용 없음"
                                        : "상태 확인 · 추가 비용 없음"}
                                  </button>
                                )}
                            </div>
                          </article>
                        );
                      })}
                  </div>
                </section>
              ))}
            </div>
          )}
          <div className="bgm-export-bar">
            <div>
              <strong>
                {selected
                  ? "선택한 음악을 가져가세요."
                  : "마음에 드는 음악을 선택하세요."}
              </strong>
              <p>완료된 후보를 고르면 MP3 파일로 내보낼 수 있어요.</p>
            </div>
            <button
              type="button"
              className="bgm-export"
              data-testid="bgm-export"
              disabled={!selected || Boolean(busy)}
              onClick={() => {
                void exportSelected();
              }}
            >
              {busy === "export" ? (
                <LoaderCircle size={16} className="bkh-spin" />
              ) : (
                <Download size={16} />
              )}
              선택한 MP3 내보내기
            </button>
          </div>
          <div className="bgm-storage">
            <FolderOpen size={16} />
            <div>
              <strong>음악과 작업 기록은 이 컴퓨터에 보관됩니다.</strong>
              <p>
                앱을 다시 열어도 저장한 음악을 미리듣고 내보낼 수 있어요. 다시
                열기만으로 새 음악을 생성하지 않습니다.
              </p>
              {state?.storageRoot && (
                <code className="bgm-path">{state.storageRoot}</code>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
