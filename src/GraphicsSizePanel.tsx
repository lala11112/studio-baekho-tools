import { useEffect, useLayoutEffect, useState } from 'react';
import { normalizePhysicalSize, physicalSizeTransform, type PhysicalSize } from '../shared/graphics-size';
import type { ModelMeasurement } from './viewport-inspection';
const axes = ['x', 'y', 'z'] as const;
const labels = { x: '가로 X', y: '높이 Y', z: '깊이 Z' };
export function GraphicsSizePanel({ value, bounds, restricted, disabled, onChange, onSave, onApply, onValidityChange }: {
  value?: PhysicalSize; bounds?: ModelMeasurement; restricted: boolean; disabled: boolean;
  onChange: (value: PhysicalSize) => void; onSave: () => void; onApply?: () => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const size = normalizePhysicalSize(value);
  const [draft, setDraft] = useState(() => ({ uniform: String(size.lengthMeters), x: String(size.dimensionsMeters.x), y: String(size.dimensionsMeters.y), z: String(size.dimensionsMeters.z) }));
  useEffect(() => setDraft(current => ({ ...current, uniform: String(size.lengthMeters) })), [size.lengthMeters]);
  useEffect(() => setDraft(current => ({ ...current, x: String(size.dimensionsMeters.x) })), [size.dimensionsMeters.x]);
  useEffect(() => setDraft(current => ({ ...current, y: String(size.dimensionsMeters.y) })), [size.dimensionsMeters.y]);
  useEffect(() => setDraft(current => ({ ...current, z: String(size.dimensionsMeters.z) })), [size.dimensionsMeters.z]);
  const parse = (text: string): number | undefined => {
    if (!/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) return;
    const n = Number(text);
    return Number.isFinite(n) && n >= .000001 && n <= 1000000 ? n : undefined;
  };
  const activeKeys = size.mode === 'uniform' ? ['uniform'] as const : size.mode === 'axes' ? axes : [];
  const invalid = activeKeys.some(key => parse(draft[key]) === undefined);
  // Keep the shared execution/save controls in sync before an invalid draft is painted.
  useLayoutEffect(() => { onValidityChange?.(!invalid); }, [invalid, onValidityChange]);
  useLayoutEffect(() => () => { onValidityChange?.(true); }, [onValidityChange]);
  let dimensions: Record<string, number> | undefined, problem = '';
  if (bounds) try {
    dimensions = physicalSizeTransform({ min: { x: bounds.min[0], y: bounds.min[1], z: bounds.min[2] }, max: { x: bounds.max[0], y: bounds.max[1], z: bounds.max[2] } }, size, restricted).dimensions;
  } catch (error) { problem = error instanceof Error ? error.message : String(error); }
  const patch = (values: Partial<PhysicalSize>) => onChange({ ...size, ...values });
  const length = (key: keyof typeof draft, text: string, change: (v: number) => void) => {
    setDraft(current => ({ ...current, [key]: text }));
    const n = parse(text); if (n !== undefined) change(n);
  };
  return <fieldset className="gs-size-panel" disabled={disabled}>
    <legend>실제 크기 · Unity 미터</legend>
    <label>크기 맞춤<select aria-label="실제 크기 모드" value={size.mode} onChange={event => patch({ mode: event.target.value as PhysicalSize['mode'] })}>
      <option value="keep">원본 크기 유지</option><option value="uniform">비율 유지 · 한 축 기준</option><option value="axes" disabled={restricted}>축별 조절 · 정적 오브젝트</option>
    </select></label>
    {size.mode === 'uniform' && <div className="gs-size-fields"><label>기준 축<select aria-label="크기 기준 축" value={size.axis} onChange={event => patch({ axis: event.target.value as PhysicalSize['axis'] })}>{axes.map(axis => <option key={axis} value={axis}>{labels[axis]}</option>)}</select></label>
      <label>기준 길이 (m)<input aria-label="기준 길이 미터" type="text" inputMode="decimal" aria-invalid={parse(draft.uniform) === undefined} value={draft.uniform} onChange={event => length('uniform', event.target.value, lengthMeters => patch({ lengthMeters }))} /></label></div>}
    {size.mode === 'axes' && <div className="gs-size-fields">{axes.map(axis => <label key={axis}>{labels[axis]} (m)<input aria-label={`${labels[axis]} 미터`} type="text" inputMode="decimal" aria-invalid={parse(draft[axis]) === undefined} value={draft[axis]} onChange={event => length(axis, event.target.value, n => patch({ dimensionsMeters: { ...size.dimensionsMeters, [axis]: n } }))} /></label>)}</div>}
    <label>피벗<select aria-label="크기 피벗" value={size.pivot} onChange={event => patch({ pivot: event.target.value as PhysicalSize['pivot'] })}><option value="keep">원본 유지</option><option value="bottom-center">바닥 중심</option><option value="center">중앙</option></select></label>
    {bounds ? <p>기본 자세 측정: {bounds.size.map(n => Number(n.toFixed(4))).join(' × ')} (원본 좌표)<br />{size.mode === 'keep' ? '단위 미확정 자료는 기준 길이를 지정해 미터 크기를 맞추세요.' : dimensions && `맞춤 미리보기: ${axes.map(axis => Number(dimensions![axis].toFixed(4))).join(' × ')} m`}</p> : <p>모델 생성·가져오기 후 기본 자세 치수를 측정합니다. 생성 서비스의 원본 단위를 미터로 가정하지 않습니다.</p>}
    {problem && <p role="alert">{problem}</p>}
    {invalid && <p role="alert">길이를 0.000001–1,000,000 미터 사이의 양수로 입력하세요. 잘못된 입력을 고치기 전에는 저장하거나 실행하지 않습니다.</p>}
    {restricted && <p>리그·스킨·동작·셰이프 키가 있는 결과는 비율 유지 크기 변경만 가능합니다.</p>}
    <p>미리보기와 Unity 전달은 이 목표로 맞춥니다. Blender 보정·리깅에 맞춘 크기를 사용하려면 아래 크기 맞춤 사본을 실행·채택하세요. 원본은 유지합니다.</p>
    <p>여러 파츠는 조립한 전체 크기를 기준으로 맞춥니다. 이 설정은 모델·Unity 단계에서 공유합니다.</p>
    <div className="gs-size-actions"><button type="button" disabled={invalid || !!problem} onClick={onSave}>크기 설정 저장 · 생성 없음</button>{onApply && <button type="button" disabled={invalid || !!problem} onClick={onApply}>크기 맞춤 사본 준비 · 무료</button>}</div>
  </fieldset>;
}
