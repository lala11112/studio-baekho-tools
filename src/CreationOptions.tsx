import type { GraphicsKind } from "../shared/graphics";
import {
  creationOptions,
  creationSubjects,
  creationLocks,
  humanParts,
  type CreationSpec,
  type CreationStage,
} from "../shared/graphics-creation";

type Value = string | number | boolean;
type Props = {
  kind: GraphicsKind;
  spec: CreationSpec;
  stage: CreationStage;
  settings: Record<string, Value>;
  disabled: boolean;
  onChange: (next: CreationSpec) => void;
  onSetting: (key: string, value: Value) => void;
};
const stageQuestions: Record<CreationStage, string> = {
  design: "어떤 모습으로 만들까요?",
  model: "어떤 모델로 만들까요?",
  surface: "어떤 표면과 색을 입힐까요?",
  assembly: "파츠를 어떻게 완성할까요?",
  rig: "어떻게 움직일 수 있게 할까요?",
  animation: "어떤 동작을 만들까요?",
  unity: "Unity에 어떻게 전달할까요?",
};
function Choices({
  label,
  value,
  values,
  onChange,
  disabled,
}: {
  label: string;
  value: Value | undefined;
  values: [string, string][];
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="gs-choice">
      <legend>{label}</legend>
      <div>
        {values.map(([key, text]) => (
          <button
            type="button"
            key={key}
            aria-pressed={String(value) === key}
            disabled={disabled}
            onClick={() => onChange(key)}
          >
            {text}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
export function CreationOptions({
  kind,
  spec,
  stage,
  settings,
  disabled,
  onChange,
  onSetting,
}: Props) {
  const attr = (key: string, value: Value) =>
    onChange({ ...spec, attributes: { ...spec.attributes, [key]: value } });
  const options = creationOptions.filter(
    (option) => !option.subjects || option.subjects.includes(spec.subject),
  );
  const choice = (
    label: string,
    key: string,
    fallback: string,
    values: [string, string][],
  ) => (
    <Choices
      label={label}
      value={settings[key] ?? fallback}
      values={values}
      onChange={(value) => onSetting(key, value)}
      disabled={disabled}
    />
  );
  const attributeOptions = (advanced: boolean) =>
    options
      .filter((option) => Boolean(option.advanced) === advanced)
      .map((option) => (
        <Choices
          key={option.id}
          label={option.label}
          value={spec.attributes[option.id]}
          values={option.values.map((item) => [String(item.value), item.label])}
          onChange={(value) => {
            const original = option.values.find(
              (item) => String(item.value) === value,
            );
            attr(option.id, original?.value ?? value);
          }}
          disabled={disabled}
        />
      ));
  return (
    <div
      className="gs-creation-options"
      data-testid="graphics-creation-options"
    >
      <h2>{stageQuestions[stage]}</h2>
      {stage === "design" && (
        <>
          <label>
            만들 대상
            <select
              aria-label="만들 대상"
              value={spec.subject}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...spec, subject: event.target.value })
              }
            >
              {creationSubjects
                .filter((subject) => subject.kind === kind)
                .map((subject) => (
                  <option value={subject.id} key={subject.id}>
                    {subject.label}
                  </option>
                ))}
            </select>
          </label>
          {attributeOptions(false)}
          <label>
            목록에 없는 특징 · 전체 외형 설명
            <textarea
              aria-label="전체 외형 설명"
              rows={3}
              placeholder="예: 윗면은 평평하고 아래쪽만 거친 바위"
              value={spec.instruction}
              maxLength={12000}
              onChange={(event) =>
                onChange({ ...spec, instruction: event.target.value })
              }
            />
          </label>
          {choice("이미지 제작 방식", "designMode", "new", [
            ["new", "새 이미지"],
            ["reference", "참고 이미지 활용"],
            ["revision", "채택 이미지 수정"],
            ["variation", "디자인 변형"],
            ["equipment", "참조 캐릭터 장비"],
            ["multiview", "멀티뷰"],
            ["parts", "파트별 이미지"],
          ])}
          <Choices
            label="완성 모델 구성"
            value={spec.attributes.composition ?? "whole"}
            values={[
              ["whole", "하나의 모델"],
              ["parts", "파트별 제작"],
            ]}
            onChange={(value) => attr("composition", value)}
            disabled={disabled}
          />
          <details>
            <summary>세부 외형 · 구도 옵션</summary>
            {attributeOptions(true)}
            {choice("방향", "direction", "front", [
              ["front", "정면"],
              ["back", "후면"],
              ["left", "왼쪽"],
              ["right", "오른쪽"],
              ["diagonal", "대각선"],
              ["top", "위"],
              ["bottom", "아래"],
            ])}
            {choice("구도", "framing", "full", [
              ["full", "전체"],
              ["upper", "상반신"],
              ["face", "얼굴"],
              ["part", "지정 부위"],
            ])}
            {choice(
              "자세",
              "pose",
              spec.subject === "human" ? "a" : "natural",
              [
                ["natural", "기본 자세"],
                ["a", "A 포즈"],
                ["t", "T 포즈"],
                ["custom", "직접 지시"],
              ],
            )}
            {choice("배경", "background", "solid", [
              ["solid", "단색"],
              ["transparent", "투명"],
              ["custom", "직접 지시"],
            ])}
            {choice("원근", "perspective", "orthographic", [
              ["orthographic", "모델링 참고용"],
              ["natural", "자연스러운 원근"],
            ])}
            {choice("여백", "margin", "full", [
              ["full", "전체가 보이도록"],
              ["motion", "동작을 위한 넓은 여백"],
            ])}
          </details>
          <details>
            <summary>수정할 때 유지할 특징</summary>
            <p className="gs-fine">
              선택한 특징을 수정 요청에 함께 전달합니다. 결과에서도 유지되었는지
              확인한 뒤 채택하세요.
            </p>
            <div className="gs-lock-options">
              {creationLocks.map((option) => (
                <label key={option.id}>
                  <input
                    type="checkbox"
                    checked={spec.locks.includes(option.id)}
                    onChange={(event) =>
                      onChange({
                        ...spec,
                        locks: event.target.checked
                          ? [...new Set([...spec.locks, option.id])]
                          : spec.locks.filter((id) => id !== option.id),
                      })
                    }
                  />
                  {option.label} 유지
                </label>
              ))}
            </div>
          </details>
        </>
      )}
      {stage === "model" && (
        <>
          {spec.attributes.composition !== "parts" && (
            <Choices
              label="모델 밀도 빠른 설정"
              value={String(settings.faceLimit ?? 10000)}
              values={[
                ["5000", "낮게 · 5,000면"],
                ["10000", "보통 · 10,000면"],
                ["50000", "높게 · 50,000면"],
              ]}
              onChange={(value) => onSetting("faceLimit", Number(value))}
              disabled={disabled}
            />
          )}
          {choice("제작 방식", "modelMethod", "tripo", [
            ["tripo", "Tripo AI 모델"],
            ["local", "규칙형 로컬 모델"],
            ["astra", "Blender + Astra"],
          ])}
          {settings.modelMethod !== "local" &&
            choice("모델에 사용할 이미지", "inputMode", "image", [
              ["image", "채택 이미지 한 장"],
              ["multiview", "네 방향 원본"],
            ])}
          <p className="gs-fine">
            표현 스타일과 실제 면 수는 따로 설정합니다. 목표 면 수와 생성된 실제
            면 수를 비교합니다.
          </p>
          <Choices
            label="모델 구성"
            value={spec.attributes.composition ?? "whole"}
            values={[
              ["whole", "하나의 모델"],
              ["parts", "파트별 제작"],
            ]}
            onChange={(value) => attr("composition", value)}
            disabled={disabled}
          />
        </>
      )}
      {(stage === "design" || stage === "model") &&
        spec.subject === "human" && (
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              onChange({
                ...spec,
                attributes: { ...spec.attributes, composition: "parts" },
                parts: humanParts().map((part) => ({
                  ...part,
                  ...spec.parts.find((item) => item.id === part.id),
                  enabled: true,
                })),
                activePartId: "head",
              })
            }
          >
            인간 3파트 설정 · 머리 / 몸통 / 머리카락
          </button>
        )}
      {(stage === "design" || stage === "model" || stage === "surface") &&
        spec.attributes.composition === "parts" && (
          <div className="gs-parts">
            <h3>제작할 파트</h3>
            <p className="gs-fine">
              파트마다 이미지를 확인하고 모델을 제작합니다. 각 파트의 기존
              결과는 보존합니다.
            </p>
            {spec.parts.map((part) => (
              <div className="gs-part" key={part.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={part.enabled}
                    onChange={(event) =>
                      onChange({
                        ...spec,
                        activePartId:
                          !event.target.checked && spec.activePartId === part.id
                            ? spec.parts.find(
                                (item) => item.id !== part.id && item.enabled,
                              )?.id
                            : spec.activePartId,
                        parts: spec.parts.map((item) =>
                          item.id === part.id
                            ? { ...item, enabled: event.target.checked }
                            : item,
                        ),
                      })
                    }
                  />
                  {part.label}
                </label>
                <button
                  type="button"
                  aria-pressed={spec.activePartId === part.id}
                  disabled={!part.enabled}
                  onClick={() => onChange({ ...spec, activePartId: part.id })}
                >
                  {spec.activePartId === part.id ? "현재 파트" : "이 파트 설정"}
                </button>
                {spec.activePartId === part.id && (
                  <>
                    <label>
                      파트 이름
                      <input
                        value={part.label}
                        maxLength={60}
                        onChange={(event) =>
                          onChange({
                            ...spec,
                            parts: spec.parts.map((item) =>
                              item.id === part.id
                                ? { ...item, label: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label>
                      이 파트 추가 지시
                      <textarea
                        rows={2}
                        value={part.instruction}
                        onChange={(event) =>
                          onChange({
                            ...spec,
                            parts: spec.parts.map((item) =>
                              item.id === part.id
                                ? { ...item, instruction: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                    {stage === "model" && (
                      <div className="gs-settings-grid">
                        <label>
                          파트 목표 면 수
                          <input
                            type="number"
                            min={100}
                            step={100}
                            value={part.faceLimit}
                            onChange={(event) =>
                              onChange({
                                ...spec,
                                parts: spec.parts.map((item) =>
                                  item.id === part.id
                                    ? {
                                        ...item,
                                        faceLimit: Number(event.target.value),
                                      }
                                    : item,
                                ),
                              })
                            }
                          />
                        </label>
                        <label>
                          파트 모델 후보 수
                          <input
                            type="number"
                            min={1}
                            max={4}
                            value={part.count}
                            onChange={(event) =>
                              onChange({
                                ...spec,
                                parts: spec.parts.map((item) =>
                                  item.id === part.id
                                    ? {
                                        ...item,
                                        count: Number(event.target.value),
                                      }
                                    : item,
                                ),
                              })
                            }
                          />
                        </label>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
            <button
              type="button"
              disabled={disabled || spec.parts.length >= 12}
              onClick={() => {
                const id = `part-${Date.now().toString(36)}`;
                onChange({
                  ...spec,
                  parts: [
                    ...spec.parts,
                    {
                      id,
                      label: `추가 파트 ${spec.parts.length + 1}`,
                      enabled: true,
                      instruction: "",
                      faceLimit: 5000,
                      count: 1,
                    },
                  ],
                  activePartId: id,
                });
              }}
            >
              파트 추가
            </button>
          </div>
        )}
      {stage === "surface" && (
        <>
          {choice("이번에 할 작업", "surfaceOperation", "texture", [
            ["uv", "UV 준비"],
            ["texture", "텍스처 · 재질"],
          ])}
          {settings.surfaceOperation === "uv"
            ? choice("UV 방식", "uvMode", "keep", [
                ["keep", "기존 UV 유지"],
                ["local", "로컬 UV"],
                ["tripo", "Tripo Smart UV"],
              ])
            : choice("표면 제작 방식", "textureMode", "tripo", [
                ["tripo", "AI 텍스처"],
                ["local", "로컬 기본 재질"],
              ])}
          {settings.surfaceOperation !== "uv" &&
            settings.textureMode !== "local" &&
            choice("텍스처 참조", "textureReference", "auto", [
              ["auto", "채택 이미지 사용"],
              ["text", "설명만 사용"],
            ])}
          <p className="gs-fine">
            {settings.textureMode === "local"
              ? "로컬 기본 재질은 선택한 수치 그대로 1개를 만듭니다. 동일한 설정의 복제 후보는 만들지 않습니다."
              : "텍스처 후보 수는 스타일 대안의 수입니다. 색상·노멀 등 텍스처 맵 개수와는 다릅니다."}
          </p>
          {settings.surfaceOperation !== "uv" &&
            settings.textureMode === "local" && (
              <div className="gs-settings-grid">
                <label>
                  기본 색
                  <input
                    aria-label="기본 색"
                    type="color"
                    value={String(settings.color ?? "#808080")}
                    onChange={(event) => onSetting("color", event.target.value)}
                  />
                </label>
                {[
                  ["roughness", "거칠기", 0.65],
                  ["metallic", "금속성", 0],
                  ["emission", "발광", 0],
                  ["opacity", "불투명도", 1],
                ].map(([key, label, fallback]) => (
                  <label key={String(key)}>
                    {label}
                    <input
                      aria-label={String(label)}
                      type="number"
                      min={0}
                      max={key === "emission" ? 10 : 1}
                      step={0.05}
                      value={Number(settings[String(key)] ?? fallback)}
                      onChange={(event) =>
                        onSetting(String(key), Number(event.target.value))
                      }
                    />
                  </label>
                ))}
              </div>
            )}
        </>
      )}
      {stage === "assembly" && (
        <>
          {choice("이번에 할 작업", "assemblyMode", "correct", [
            ["correct", "전체 비율·모양 수정"],
            ["assemble", "채택 파트 조립"],
            ["separate", "모델 파트 분리"],
            ["partial", "지정 메시만 수정"],
          ])}
          <p>
            채택한 파트를 전체 외형 참고에 맞춰 조립하거나, 기존 모델의 비율과
            모양을 수정합니다. 수정하지 않아도 되는 단일 모델은 리깅 또는 Unity
            단계로 이동할 수 있습니다.
          </p>
          {settings.assemblyMode === "partial" && (
            <details>
              <summary>수정할 메시 ID · 고급</summary>
              <label>
                원본 보고서의 메시 ID 목록
                <textarea
                  rows={2}
                  placeholder={'["mesh-id"]'}
                  value={String(settings.editMeshIds ?? "")}
                  onChange={(event) =>
                    onSetting("editMeshIds", event.target.value)
                  }
                />
              </label>
              <p className="gs-fine">
                원본에서 확인한 ID만 입력합니다. 목록 밖의 메시는 보존 검사하며,
                이름을 추측해서 입력하지 마세요.
              </p>
            </details>
          )}
        </>
      )}
      {stage === "rig" && (
        <>
          {choice("Unity 리그 종류", "rigType", "generic", [
            ["none", "리깅 안 함"],
            ["humanoid", "Humanoid · 사람형"],
            ["generic", "Generic · 동물/기타"],
            ["existing", "기존 뼈대 웨이트 보정"],
          ])}
          <p className="gs-fine">
            사람형은 Unity Humanoid 매핑을 검사합니다. 동물과 보조 부위는 실제
            뼈대와 변형을 확인합니다. 정적인 오브젝트는 이 단계를 건너뛸 수
            있습니다.
          </p>
        </>
      )}
      {stage === "animation" && (
        <>
          {choice("이번에 만들 결과", "animationMode", "source", [
            ["source", "측면 참고 이미지"],
            ["video", "AI 동작 영상"],
            ["reference", "채택 영상으로 3D 동작"],
            ["text", "지시로 3D 동작"],
            ["revision", "기존 클립 수정"],
          ])}
          {choice("동작 프리셋", "motionPreset", "idle", [
            ["idle", "대기"],
            ["walk", "걷기"],
            ["run", "달리기"],
            ["jump", "점프"],
            ["attack", "공격"],
            ["custom", "직접 작성"],
          ])}
          <label>
            <input
              type="checkbox"
              checked={settings.rootMotion === true}
              onChange={(event) =>
                onSetting("rootMotion", event.target.checked)
              }
            />
            이동 동작 · 끄면 제자리
          </label>
          <p className="gs-fine">
            영상은 직접 확인하고 채택한 뒤 3D 제작에 사용합니다. 선택만으로
            영상이나 3D 동작을 생성하지 않습니다.
          </p>
        </>
      )}
      {stage === "unity" && (
        <>
          {choice("전달 방식", "deliveryMode", "unity", [
            ["unity", "Unity 프로젝트 전달"],
            ["files", "FBX · GLB 파일 내보내기"],
          ])}
          <p>
            {settings.deliveryMode === "files"
              ? "채택한 결과를 로컬 FBX · GLB 파일로 내보냅니다. 원본은 유지하며 Unity 프로젝트 임포트는 실행하지 않습니다."
              : "채택한 모델·재질·리그·클립을 연결된 Unity 프로젝트에 전달합니다. 기존 원본은 유지하며, 기본 동작은 임포트입니다."}
          </p>
          {choice("충돌체", "collider", "none", [
            ["none", "추가 안 함"],
            ["box", "상자"],
            ["mesh", "메시"],
            ["convex", "볼록 메시"],
          ])}
          <label>
            <input
              type="checkbox"
              checked={settings.lodEnabled === true}
              onChange={(event) =>
                onSetting("lodEnabled", event.target.checked)
              }
            />
            정적 모델 LOD 생성
          </label>
          {settings.lodEnabled === true && (
            <label>
              LOD 면 비율
              <input
                type="number"
                min={0.05}
                max={0.95}
                step={0.05}
                value={Number(settings.lodRatio ?? 0.5)}
                onChange={(event) =>
                  onSetting("lodRatio", Number(event.target.value))
                }
              />
            </label>
          )}
          <details>
            <summary>Unity 전달본 최적화</summary>
            <label>
              전달본 텍스처 크기
              <select
                value={String(settings.deliveryTextureSize ?? 0)}
                onChange={(event) =>
                  onSetting("deliveryTextureSize", Number(event.target.value))
                }
              >
                {[
                  [0, "원본 유지"],
                  [512, "512"],
                  [1024, "1K"],
                  [2048, "2K"],
                  [4096, "4K"],
                ].map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {choice("전달본 압축", "deliveryCompression", "none", [
              ["none", "압축 안 함"],
              ["normal", "일반 압축"],
            ])}
            <p className="gs-fine">
              원본은 그대로 두고 Unity 전달본에만 적용합니다.
            </p>
          </details>
        </>
      )}
    </div>
  );
}
