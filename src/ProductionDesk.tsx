import { useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  CircleAlert,
  Clock,
  FolderOpen,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  Upload,
  Workflow,
} from "lucide-react";
import type { Command, Project } from "../shared/types";
import type {
  ProductionConfig,
  ProductionProbe,
  ProductionRun,
  ProductionStage,
} from "../shared/production";
import { Viewport } from "./Viewport";

const runLabels: Record<string, string> = {
  ready: "실행 준비",
  running: "자동 제작 중",
  paused: "일시 정지",
  needs_input: "입력·연결 필요",
  completed: "검증 완료",
  cancelled: "중단됨",
  failed: "확인 필요",
};
const stageLabels: Record<string, string> = {
  pending: "대기",
  running: "작업 중",
  completed: "검증 통과",
  needs_input: "입력 필요",
  invalidated: "다시 작업 예정",
  cancelled: "중단",
  failed: "확인 필요",
};
const checkLabels: Record<string, string> = {
  three_semantic_parts: "머리·몸체·헤어 분리",
  transparent_masks: "투명 마스크 경계",
  source_identity_preserved: "원본 캐릭터 특징 보존",
  studio_result_downloaded: "Studio 실제 결과 다운로드",
  part_identity: "파츠 외형 일치",
  geometry_present: "실제 메시 존재",
  front_reference_match: "정면 원본과 비교",
  silhouette_and_back: "실루엣·뒷면 검사",
  mesh_integrity: "메시 구조 검사",
  uv_present: "UV 존재",
  uv_overlap_reviewed: "UV 겹침 검사",
  texture_files_present: "텍스처 파일 존재",
  material_consistency: "재질 일관성",
  no_missing_maps: "누락된 맵 없음",
  parts_aligned: "파츠 위치·비율 정렬",
  seams_reviewed: "접합부 검사",
  real_meshes_preserved: "실제 파츠 메시 사용",
  reference_identity: "원본 캐릭터와 비교",
  topology_and_seams: "토폴로지·접합부 검사",
  scale_and_orientation: "크기·방향 검사",
  final_topology_uv: "최종 형상에 맞는 UV",
  final_texture_complete: "최종 텍스처 완성",
  seam_color_consistency: "접합부 색상 일치",
  armature_and_weights: "뼈대·웨이트 검사",
  joint_deformation: "관절 변형 검사",
  hair_bound_to_head: "머리와 헤어 연결",
  same_character_identity: "동일 캐릭터 유지",
  requested_view: "요청한 시점",
  reference_quality: "참조 이미지 품질",
  actual_sequence_frames: "실제 동작 프레임 시퀀스",
  requested_motion_visible: "요청한 동작 확인",
  fixed_camera: "고정 카메라",
  timestamp_manifest: "프레임별 타이밍 기록",
  image_motion_analyzed: "이미지의 동작 분석",
  animation_baked: "실제 키프레임 저장",
  contact_and_timing_reviewed: "접지·타이밍 검사",
  multi_view_consistency: "방향별 외형 일치",
  view_time_alignment: "시점·시간 일치",
  synchronized_reference_manifest: "멀티뷰 프레임 대응 기록",
  humanoid_avatar_valid: "유효한 Humanoid Avatar",
  requested_clips_present: "요청한 애니메이션 존재",
  unity_playback_verified: "Unity 실제 재생 검사",
};
function stageIcon(stage: ProductionStage) {
  if (stage.status === "completed") return <CheckCircle2 size={18} />;
  if (stage.status === "running")
    return <LoaderCircle size={18} className="spin" />;
  if (["needs_input", "failed"].includes(stage.status))
    return <CircleAlert size={18} />;
  return <Circle size={18} />;
}
export function ProductionDesk({
  project: p,
  runs,
  run,
  busy,
}: {
  project: Project;
  runs: ProductionRun[];
  run: (c: Command, s?: string) => Promise<any>;
  busy: boolean;
}) {
  const images = p.assets.filter((a) => a.kind === "image");
  const previousConfig = runs.at(0)?.config;
  const [sourceId, setSourceId] = useState(
    previousConfig?.sourceId ?? p.selectedImageId ?? images.at(-1)?.id ?? "",
  );
  const [brief, setBrief] = useState(
    previousConfig?.brief ??
      "정면 이미지의 외형과 비율을 유지한 게임용 캐릭터. 머리·몸통·머리카락을 따로 제작한 뒤 자연스럽게 접합. 원본의 색상과 스타일 유지.",
  );
  const [motions, setMotions] = useState(
    previousConfig?.motions.join("\n") ?? "자연스럽게 대기하기\n앞으로 걷기",
  );
  const [iterations, setIterations] = useState(
    previousConfig?.maxIterations ?? 2,
  );
  const [studioCredits, setStudioCredits] = useState(
    previousConfig?.studioCreditLimit ?? 0,
  );
  const [selectedId, setSelectedId] = useState("");
  const [selectedStage, setSelectedStage] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [probe, setProbe] = useState<ProductionProbe>();
  const current = runs.find((r) => r.id === selectedId) ?? runs.at(0);
  const selected =
    current?.stages.find((s) => s.id === selectedStage) ??
    current?.stages.find((s) => s.id === current.activeStageId) ??
    current?.stages[0];
  const source = images.find((a) => a.id === sourceId);
  const finished =
    current?.stages.filter((s) => s.status === "completed").length ?? 0;
  const active = current?.status === "running";
  const artifactUrl = (file: string) =>
    window.desktop.assetUrl(
      p.id,
      `production/${current!.id}/${file.replaceAll("\\", "/")}`,
    );
  const config: ProductionConfig = {
    sourceId,
    brief,
    motions: motions
      .split("\n")
      .map((m) => m.trim())
      .filter(Boolean),
    maxIterations: iterations,
    studioCreditLimit: studioCredits,
    videoCreditLimit: 0,
    mode: "studio",
  };
  return (
    <main className="production-desk" data-testid="production-desk">
      <div className="production-intro">
        <div>
          <span className="eyebrow">CHARACTER PRODUCTION</span>
          <h2>이미지 한 장. 이어서 만드는 제작 흐름.</h2>
          <p>
            제작 기준을 정하면 Codex가 공정을 실행하고 결과를 검사합니다. 수정이
            필요한 파츠만 다시 작업합니다.
          </p>
        </div>
        <span className="badge green">
          <Workflow size={14} /> Studio · Codex · Blender · Unity
        </span>
      </div>
      <div className="production-layout">
        <aside className="production-setup" data-testid="production-config">
          <h3>이번 캐릭터의 제작 기준</h3>
          <label className="field">
            <span>정면 캐릭터 이미지</span>
            <select
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
            >
              <option value="">이미지 선택</option>
              {images.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          {source ? (
            <img
              className="production-source"
              src={window.desktop.assetUrl(p.id, source.file)}
              alt="제작 기준 정면 이미지"
            />
          ) : (
            <div className="production-source placeholder">
              <Upload size={24} />
              <span>정면 이미지 한 장으로 시작</span>
            </div>
          )}
          <button
            disabled={busy}
            onClick={async () => {
              const a = await run({
                type: "asset.import",
                id: p.id,
                kind: "image",
              });
              if (a?.id) setSourceId(a.id);
            }}
          >
            <Upload size={15} /> 정면 이미지 가져오기
          </button>
          <label className="field">
            <span>원하는 모습과 검수 기준</span>
            <textarea
              rows={5}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="보존할 특징, 비율, 접합 방식, 스타일, 폴리곤 예산…"
            />
          </label>
          <label className="field">
            <span>만들 동작 (한 줄에 하나)</span>
            <textarea
              rows={3}
              value={motions}
              onChange={(e) => setMotions(e.target.value)}
              placeholder="오른손을 들어 인사하기"
            />
          </label>
          <div className="production-motion-note">
            <span>정면 캐릭터</span>
            <ArrowRight size={13} />
            <span>멀티뷰 2D 동작 이미지</span>
            <ArrowRight size={13} />
            <span>Codex Astra · 3D 애니메이션</span>
          </div>
          <small className="production-view-note">
            정면·측면·후면의 같은 동작을 이미지 시퀀스로 만들고, 프레임과
            타이밍을 Astra가 읽어 리그 포즈·키프레임·보간을 제작합니다. 방향별
            외형과 타이밍이 맞지 않으면 다시 작업합니다.
          </small>
          <label className="field">
            <span>품질 보정 최대 시도 횟수</span>
            <select
              value={iterations}
              onChange={(e) => setIterations(Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}회 · 단계별 한도
                </option>
              ))}
            </select>
          </label>
          <details className="production-options">
            <summary>실행 한도 · 연결</summary>
            <label className="field">
              <span>이 제작의 Studio 크레딧 상한</span>
              <input
                data-testid="production-studio-limit"
                type="number"
                min={0}
                max={100000}
                step={1}
                value={studioCredits}
                onChange={(e) => setStudioCredits(Number(e.target.value))}
              />
              <small>
                0이면 크레딧 사용이 필요한 단계에서 멈춥니다. 재생성과
                후처리까지 이 한도에 포함합니다.
              </small>
            </label>
            <p className="production-view-note">
              2D 이미지 생성은 Codex의 이미지 생성 도구를 사용합니다. 3D 동작
              제작 모델은 Astra로 지정합니다. 계정의 도구·모델 접근이 불가능하면
              이유를 표시하고 멈춥니다. Codex 계정 사용량이 소모됩니다.
            </p>
            <div className="inline-actions">
              <button
                disabled={busy}
                onClick={() => run({ type: "studio.open" })}
              >
                Studio 브라우저 열기
              </button>
              <button
                disabled={busy}
                onClick={async () =>
                  setProbe(await run({ type: "production.probe" }))
                }
              >
                <RefreshCw size={14} /> 실행 환경 확인
              </button>
            </div>
            {probe && (
              <div className="production-probe">
                <p>
                  <b>Codex</b>{" "}
                  {probe.codex.authenticated
                    ? "로그인 확인"
                    : probe.codex.message}
                </p>
                <p>
                  <b>Studio</b>{" "}
                  {probe.capabilities.studio
                    ? "브라우저 도구 연결됨 · 사이트 로그인 별도"
                    : "브라우저 연결 필요"}
                </p>
                <p>
                  <b>동작 제작</b> Astra 지정 · 모델 접근과 이미지 생성은 실제
                  단계 실행으로 확인
                </p>
                <small>{probe.message}</small>
              </div>
            )}
          </details>
          <button
            className="primary full"
            data-testid="production-create"
            disabled={
              busy ||
              active ||
              !sourceId ||
              !brief.trim() ||
              !config.motions.length
            }
            onClick={async () => {
              const r = await run({
                type: "production.create",
                id: p.id,
                config,
              });
              if (r) {
                setSelectedId(r.id);
                setSelectedStage("");
                setAccepted(false);
              }
            }}
          >
            <Sparkles size={16} /> 제작 흐름 준비
          </button>
          <small className="production-muted">
            준비 단계에서는 생성하거나 크레딧을 사용하지 않습니다. 저장한 흐름과
            한도를 확인한 뒤 시작합니다.
          </small>
        </aside>
        <section className="production-work">
          {current ? (
            <>
              <div className="production-run-heading">
                <div>
                  <h3>제작 진행</h3>
                  <select
                    aria-label="제작 실행 기록"
                    value={current.id}
                    onChange={(e) => {
                      setSelectedId(e.target.value);
                      setSelectedStage("");
                      setAccepted(false);
                    }}
                  >
                    {runs.map((r) => (
                      <option key={r.id} value={r.id}>
                        {new Date(r.createdAt).toLocaleString("ko-KR")} ·{" "}
                        {runLabels[r.status]}
                      </option>
                    ))}
                  </select>
                </div>
                <span
                  className={`badge ${current.status === "completed" ? "green" : current.status === "needs_input" ? "amber" : "neutral"}`}
                  data-testid="production-status"
                >
                  {runLabels[current.status]}
                </span>
              </div>
              <p className="production-message" role="status">
                {current.message}
              </p>
              <div className="production-progress">
                <progress max={current.stages.length} value={finished} />
                <small>
                  {finished} / {current.stages.length} 공정 검증 완료
                </small>
              </div>
              {current.status === "ready" && (
                <div className="production-start">
                  <p>
                    <strong>{current.source.label}</strong> · Studio 최대{" "}
                    {current.config.studioCreditLimit.toLocaleString()} credits
                    · 단계별 최대 {current.config.maxIterations}회 · 3D 동작:
                    Astra
                  </p>
                  <p>{current.config.brief}</p>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={accepted}
                      onChange={(e) => setAccepted(e.target.checked)}
                    />
                    이 이미지와 지시를 Codex·제작 서비스에 전달하고, 표시된 한도
                    안에서 자동 제작과 보정을 실행합니다.
                  </label>
                  <button
                    className="primary"
                    data-testid="production-start"
                    disabled={busy || !accepted}
                    onClick={() =>
                      run({
                        type: "production.start",
                        runId: current.id,
                        budgetAccepted: accepted,
                      })
                    }
                  >
                    <Play size={15} /> 자동 제작 시작
                  </button>
                </div>
              )}
              <div className="production-run-actions">
                {active && (
                  <button
                    data-testid="production-pause"
                    disabled={busy}
                    onClick={() =>
                      run({ type: "production.pause", runId: current.id })
                    }
                  >
                    <Pause size={15} /> 일시 정지
                  </button>
                )}
                {["paused", "needs_input", "failed"].includes(
                  current.status,
                ) && (
                  <button
                    data-testid="production-resume"
                    disabled={busy}
                    onClick={() =>
                      run({ type: "production.resume", runId: current.id })
                    }
                  >
                    <Play size={15} /> 원인 해결 후 이어서 실행
                  </button>
                )}
                {!["completed", "cancelled"].includes(current.status) && (
                  <button
                    data-testid="production-cancel"
                    disabled={busy}
                    onClick={() =>
                      run({ type: "production.cancel", runId: current.id })
                    }
                  >
                    제작 중단
                  </button>
                )}
                <button
                  onClick={() =>
                    run({ type: "production.open", runId: current.id })
                  }
                >
                  <FolderOpen size={15} /> 결과·검사 기록
                </button>
              </div>
              <div className="production-stage-layout">
                <div
                  className="production-stages"
                  data-testid="production-stages"
                >
                  {current.stages.map((s, i) => (
                    <button
                      key={s.id}
                      className={`production-stage ${s.status} ${selected?.id === s.id ? "selected" : ""}`}
                      onClick={() => setSelectedStage(s.id)}
                    >
                      {stageIcon(s)}
                      <span>
                        <strong>
                          {String(i + 1).padStart(2, "0")} · {s.title}
                        </strong>
                        <small>
                          {stageLabels[s.status]}
                          {s.attempt > 0 ? ` · 시도 ${s.attempt}` : ""}
                          {s.artifacts.length
                            ? ` · 산출물 ${s.artifacts.length}`
                            : ""}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
                <div className="production-inspect">
                  {selected && (
                    <>
                      <div className="section-title">
                        <h3>{selected.title}</h3>
                        <span className="badge">
                          {stageLabels[selected.status]}
                        </span>
                      </div>
                      <p>
                        {selected.summary ||
                          "앞선 공정의 검증이 끝나면 Codex 작업자가 이어서 처리합니다."}
                      </p>
                      {selected.remoteAmbiguous && (
                        <div className="note amber">
                          <span>
                            원격 제출 여부를 확인해야 합니다. 자동 재생성을
                            멈추고 기존 작업을 확인합니다.
                          </span>
                        </div>
                      )}
                      <ul className="production-checks">
                        {selected.requiredChecks.map((check) => {
                          const result = selected.result?.checks.find(
                            (c) => c.name === check,
                          );
                          return (
                            <li key={check}>
                              {selected.status === "completed" &&
                              result?.passed ? (
                                <CheckCircle2 size={14} />
                              ) : (
                                <Circle size={14} />
                              )}
                              <span>{checkLabels[check] ?? check}</span>
                            </li>
                          );
                        })}
                      </ul>
                      {selected.artifacts.map((a) => (
                        <div className="production-artifact" key={a.path}>
                          {a.kind === "image" ? (
                            <img
                              src={artifactUrl(a.path)}
                              alt={`${a.role ?? selected.title} 검증 산출물`}
                            />
                          ) : a.kind === "video" ? (
                            <video
                              controls
                              preload="metadata"
                              src={artifactUrl(a.path)}
                            />
                          ) : a.kind === "model" && /\.glb$/i.test(a.path) ? (
                            <div className="production-model">
                              <Viewport
                                project={{
                                  ...p,
                                  assets: [
                                    {
                                      id: a.sha256,
                                      file: `production/${current.id}/${a.path}`,
                                      kind: "model",
                                      label: selected.title,
                                      origin: "import",
                                      createdAt: current.updatedAt,
                                    },
                                  ],
                                  parts: [],
                                }}
                                previewId={a.sha256}
                                animation
                              />
                            </div>
                          ) : null}
                          <small>
                            {a.role ?? a.kind} · {a.path}
                          </small>
                        </div>
                      ))}
                      {!selected.artifacts.length && (
                        <div className="production-awaiting">
                          <Clock size={25} />
                          <p>아직 검증된 산출물이 없습니다.</p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="production-empty">
              <Workflow size={44} strokeWidth={1} />
              <h3>반복 작업을 하나의 제작 흐름으로</h3>
              <p>
                정면 이미지와 원하는 모습을 정하면 공정별 입력과 검수 기준을
                연결합니다.
              </p>
              <ol>
                <li>
                  <b>파츠 준비</b>
                  <span>머리·몸통·머리카락 분리와 가려진 부위 보완</span>
                </li>
                <li>
                  <b>파츠 제작·보정</b>
                  <span>Studio 생성 → 결과 비교 → 필요한 파츠만 재작업</span>
                </li>
                <li>
                  <b>최종 캐릭터</b>
                  <span>Blender 접합·형상 수정 → UV·텍스처·리깅 검사</span>
                </li>
                <li>
                  <b>동작과 게임 출력</b>
                  <span>
                    멀티뷰 2D 이미지 → Astra 3D 애니메이션 → Unity 검증
                  </span>
                </li>
              </ol>
              <div className="note">
                <span>
                  실행에는 Codex 로그인, 이미지 생성 도구와 Astra 접근, Studio
                  로그인이 필요합니다. 연결되지 않은 단계는 필요한 조치를
                  표시하고 멈춥니다.
                </span>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
