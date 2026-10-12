import { useEffect, useState } from "react";
import {
  elementNames,
  elements,
  stats,
  statNames,
  type EffectDraft,
  type ItemDraft,
  type ItemPatch,
  type SainGeomItemProject,
} from "../shared/four-tiger-items";
import { itemSeeds } from "../shared/four-tiger-item-seed";
export function ItemIcon({
  projectId,
  item,
  size = 64,
}: {
  projectId: string;
  item: ItemDraft;
  size?: number;
}) {
  const [url, setUrl] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setUrl("");
    setError("");
    if (item.selectedIconVersion)
      void window.fourTigerItems
        .readIcon({
          projectId,
          candidateKey: item.candidateKey,
          versionId: item.selectedIconVersion,
        })
        .then((url) => {
          if (alive) setUrl(url);
        })
        .catch(() => {
          if (alive) setError("파일 확인 필요");
        });
    return () => {
      alive = false;
    };
  }, [projectId, item.candidateKey, item.selectedIconVersion]);
  return (
    <div className="fti-icon" style={{ width: size, height: size }}>
      {url ? (
        <img src={url} alt={`${item.name} 아이콘`} width={size} height={size} />
      ) : (
        <span>{error || "미생성"}</span>
      )}
    </div>
  );
}
type Props = {
  project: SainGeomItemProject;
  item: ItemDraft;
  busy: boolean;
  save: (patch: ItemPatch) => Promise<boolean>;
  act: (fn: () => Promise<unknown>) => Promise<boolean>;
};
export function FourTigerItemEditor({ project, item, busy, save, act }: Props) {
  const [draft, setDraft] = useState<ItemDraft>(item),
    [dirty, setDirty] = useState(false),
    [light, setLight] = useState(false);
  useEffect(() => {
    setDraft(item);
    setDirty(false);
  }, [item.candidateKey]);
  useEffect(() => {
    if (!dirty) setDraft(item);
  }, [item, dirty]);
  const api = window.fourTigerItems,
    revisionInput = {
      projectId: project.projectId,
      expectedRevision: project.revision,
    },
    input = { ...revisionInput, candidateKey: item.candidateKey };
  const edit = (patch: ItemPatch) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };
  const effect = (n: number, patch: Partial<EffectDraft>) =>
    edit({
      effects: draft.effects.map((e, i) => (i === n ? { ...e, ...patch } : e)),
    });
  const seed =
    itemSeeds.find(
      (s) =>
        s.itemId ===
        project.synergyReferences
          .flatMap((s) => s.items)
          .find((r) => r.candidateKey === item.candidateKey)?.originalId,
    ) ||
    itemSeeds.find((s) => s.element === item.element && s.grade === item.grade);
  const commit = async () => {
    const {
      name,
      itemId,
      description,
      element,
      grade,
      effects,
      unsupportedEffectNotes,
      synergyTags,
      iconPrompt,
    } = draft;
    if (
      await save({
        name,
        itemId,
        description,
        element,
        grade,
        effects,
        unsupportedEffectNotes,
        synergyTags,
        iconPrompt,
      })
    )
      setDirty(false);
  };
  return (
    <aside className="fti-editor" data-testid="item-editor">
      <div className="fti-section-title">
        <div>
          <small>아이템 편집 · 제안</small>
          <h2>{item.name || "이름 없음"}</h2>
        </div>
        <span>{dirty ? "저장 전 수정" : "저장됨"}</span>
      </div>
      <label>
        이름
        <input
          aria-label="아이템 이름"
          value={draft.name}
          onChange={(e) => edit({ name: e.target.value })}
        />
      </label>
      <label>
        ID
        <input
          aria-label="아이템 ID"
          value={draft.itemId}
          onChange={(e) => edit({ itemId: e.target.value })}
        />
      </label>
      <div className="fti-row">
        <label>
          오행
          <select
            value={draft.element}
            onChange={(e) =>
              edit({ element: e.target.value as ItemDraft["element"] })
            }
          >
            {elements.map((e) => (
              <option key={e} value={e}>
                {elementNames[e]}
              </option>
            ))}
          </select>
        </label>
        <label>
          등급
          <select
            aria-label="아이템 등급"
            value={draft.grade}
            onChange={(e) =>
              edit({ grade: Number(e.target.value) as ItemDraft["grade"] })
            }
          >
            {[1, 2, 3, 4].map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </label>
        <label>
          구매가
          <output data-testid="item-price">
            {[20, 40, 80, 160][draft.grade - 1]} G
          </output>
        </label>
      </div>
      <h3>효과 · 수치 검토 대기</h3>
      {draft.effects.map((e, n) => (
        <fieldset key={n} className="fti-effect">
          <legend>효과 {n + 1}</legend>
          <div className="fti-row">
            <select
              aria-label={`효과 ${n + 1} 종류`}
              value={e.stat}
              onChange={(ev) => {
                const stat = ev.target.value as EffectDraft["stat"],
                  ratio = ["maxHp", "normalDamage", "switchDamage"].includes(
                    stat,
                  );
                effect(n, {
                  stat,
                  unit: ratio
                    ? "ratio"
                    : stat === "spRegen"
                      ? "SPPerSecond"
                      : "SP",
                  operation: ratio ? "addRatio" : "add",
                });
              }}
            >
              {stats.map((s) => (
                <option key={s} value={s}>
                  {statNames[s]}
                </option>
              ))}
            </select>
            <label>
              {e.unit === "ratio"
                ? "%"
                : e.unit === "SPPerSecond"
                  ? "SP/초"
                  : "SP"}
              <input
                type="number"
                step="any"
                aria-label={`효과 ${n + 1} 값`}
                value={Number(
                  (e.amount * (e.unit === "ratio" ? 100 : 1)).toFixed(5),
                )}
                onChange={(ev) =>
                  effect(n, {
                    amount:
                      Number(ev.target.value) / (e.unit === "ratio" ? 100 : 1),
                  })
                }
              />
            </label>
          </div>
          <div className="fti-row">
            <select
              aria-label={`효과 ${n + 1} 발동`}
              value={e.trigger}
              onChange={(ev) =>
                effect(n, {
                  trigger: ev.target.value as EffectDraft["trigger"],
                  durationSeconds: ev.target.value === "whileOwned" ? null : 3,
                })
              }
            >
              <option value="whileOwned">보유 중</option>
              <option value="formSwitchSucceeded">전환 성공 후</option>
            </select>
            {e.trigger === "formSwitchSucceeded" && (
              <label>
                지속 초
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={e.durationSeconds ?? 3}
                  onChange={(ev) =>
                    effect(n, { durationSeconds: Number(ev.target.value) })
                  }
                />
              </label>
            )}
          </div>
          <label>
            적용 폼
            <select
              aria-label={`효과 ${n + 1} 적용 범위`}
              value={e.targetForms === "all" ? "all" : "selected"}
              onChange={(ev) =>
                effect(n, {
                  targetForms:
                    ev.target.value === "all" ? "all" : [item.element],
                })
              }
            >
              <option value="all">모든 폼</option>
              <option value="selected">선택한 폼</option>
            </select>
          </label>
          {e.targetForms !== "all" && (
            <div className="fti-form-checks">
              {elements.map((el) => (
                <label key={el}>
                  <input
                    type="checkbox"
                    aria-label={`효과 ${n + 1} ${elementNames[el]} 폼`}
                    checked={e.targetForms.includes(el)}
                    onChange={(ev) => {
                      const forms =
                        e.targetForms === "all" ? [] : e.targetForms;
                      effect(n, {
                        targetForms: ev.target.checked
                          ? [...forms, el]
                          : forms.filter((f) => f !== el),
                      });
                    }}
                  />
                  {elementNames[el]}
                </label>
              ))}
            </div>
          )}
          <button
            className="fti-quiet"
            onClick={() =>
              edit({ effects: draft.effects.filter((_, i) => i !== n) })
            }
          >
            효과 삭제
          </button>
        </fieldset>
      ))}
      <button
        onClick={() =>
          edit({
            effects: [
              ...draft.effects,
              {
                stat: "maxSp",
                operation: "add",
                unit: "SP",
                amount: 1,
                trigger: "whileOwned",
                targetForms: "all",
                durationSeconds: null,
                stackLimit: 1,
                refreshPolicy: "refresh",
                removeOnItemLoss: true,
              },
            ],
          })
        }
      >
        효과 추가
      </button>
      <label>
        설명
        <textarea
          aria-label="아이템 설명"
          rows={3}
          value={draft.description}
          onChange={(e) => edit({ description: e.target.value })}
        />
      </label>
      {item.descriptionStale && (
        <div className="fti-warning">효과 변경 후 설명 확인이 필요합니다.</div>
      )}
      <div className="fti-row">
        <button
          disabled={busy || dirty}
          onClick={() =>
            void act(() =>
              api.acknowledgeDescription({ ...input, regenerate: true }),
            )
          }
        >
          효과로 설명 만들기
        </button>
        <button
          disabled={busy || dirty}
          onClick={() =>
            void act(() =>
              api.acknowledgeDescription({ ...input, regenerate: false }),
            )
          }
        >
          설명 확인 완료
        </button>
      </div>
      <label>
        태그
        <input
          value={draft.synergyTags.join(", ")}
          onChange={(e) =>
            edit({
              synergyTags: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
      <label>
        미지원 효과 메모
        <textarea
          rows={2}
          value={draft.unsupportedEffectNotes}
          onChange={(e) => edit({ unsupportedEffectNotes: e.target.value })}
        />
      </label>
      <label>
        아이콘 모티프·요청
        <textarea
          aria-label="아이콘 요청"
          rows={3}
          value={draft.iconPrompt}
          onChange={(e) => edit({ iconPrompt: e.target.value })}
        />
      </label>
      <button
        className="fti-primary"
        data-testid="save-item"
        disabled={busy || !dirty}
        onClick={() => void commit()}
      >
        변경 저장
      </button>
      {dirty && (
        <p className="fti-muted">저장한 다음 검토하거나 생성할 수 있습니다.</p>
      )}
      <h3>아이콘 · 직접 확인</h3>
      <div className={`fti-previews ${light ? "light" : ""}`}>
        <ItemIcon projectId={project.projectId} item={item} size={64} />
        <ItemIcon projectId={project.projectId} item={item} size={128} />
      </div>
      <details>
        <summary>256px 원래 출력 크기 보기</summary>
        <div className={`fti-previews ${light ? "light" : ""}`}>
          <ItemIcon projectId={project.projectId} item={item} size={256} />
        </div>
      </details>
      <button onClick={() => setLight((v) => !v)}>
        {light ? "어두운" : "밝은"} 배경으로 보기
      </button>
      <label>
        아이콘 버전
        <select
          aria-label="아이콘 버전"
          value={item.selectedIconVersion ?? ""}
          onChange={(e) =>
            void act(() =>
              api.selectIcon({ ...input, versionId: e.target.value }),
            )
          }
          disabled={busy || dirty}
        >
          <option value="" disabled>
            선택 없음
          </option>
          {item.icons.map((v, n) => (
            <option key={v.versionId} value={v.versionId}>
              {n + 1}번째 · 내용 r{v.contentRevision} · {v.width}×{v.height}
            </option>
          ))}
        </select>
      </label>
      <button
        data-testid="generate-one"
        disabled={
          busy ||
          dirty ||
          project.jobs.some(
            (j) =>
              j.candidateKey === item.candidateKey &&
              ["running", "queued", "unknown", "generated"].includes(j.status),
          )
        }
        onClick={() =>
          void act(() =>
            api.generateIcons({
              ...revisionInput,
              candidateKeys: [item.candidateKey],
            }),
          )
        }
      >
        {item.icons.length ? "새 버전 생성" : "이 아이콘 생성"}
      </button>
      {project.jobs
        .filter((j) => j.candidateKey === item.candidateKey)
        .slice(-2)
        .map((j) => (
          <p className="fti-muted" key={j.jobId}>
            {j.status}
            {j.error ? ` · ${j.error}` : ""}
          </p>
        ))}
      <h3>검토 기록</h3>
      <p className="fti-muted">
        데이터{" "}
        {item.review.dataRevision === item.contentRevision
          ? "확인됨"
          : "미확인"}{" "}
        · 아이콘{" "}
        {item.review.iconContentRevision === item.contentRevision
          ? "확인됨"
          : "미확인"}
      </p>
      <div className="fti-row">
        <button
          data-testid="review-data"
          disabled={busy || dirty}
          onClick={() =>
            void act(() =>
              api.reviewItems({
                ...revisionInput,
                candidateKeys: [item.candidateKey],
                action: "reviewData",
                note: "",
              }),
            )
          }
        >
          데이터 검토 완료
        </button>
        <button
          data-testid="review-icon"
          disabled={busy || dirty || !item.selectedIconVersion}
          onClick={() =>
            void act(() =>
              api.reviewItems({
                ...revisionInput,
                candidateKeys: [item.candidateKey],
                action: "reviewIcon",
                note: "",
              }),
            )
          }
        >
          아이콘 검토 완료
        </button>
      </div>
      <details>
        <summary>원문 제안과 변경점</summary>
        <p>
          {seed?.name} ·{" "}
          {seed?.effects
            .map(
              (e) =>
                `${statNames[e.stat]} ${e.unit === "ratio" ? `${e.amount * 100}%` : e.amount}`,
            )
            .join(", ")}
        </p>
        <p>
          현재 내용 r{item.contentRevision}. 저장 이력{" "}
          {
            project.reviewHistory.filter(
              (h) => h.candidateKey === item.candidateKey,
            ).length
          }
          건.
        </p>
      </details>
    </aside>
  );
}
