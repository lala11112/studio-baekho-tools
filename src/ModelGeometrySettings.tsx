import { useId, useState } from 'react';
import { DEFAULT_MODEL_FACE_LIMIT, DEFAULT_TRIPO_MODEL, modelGeometryCapabilities, modelGeometryDefaults, modelGeometryProblem, tripoModelChoices, type ModelGeometryCapabilities, type ModelGeometrySettings as Values } from '../shared/graphics-model-geometry';
import './model-geometry-settings.css';

export function ModelGeometrySettings({ settings, disabled, partLabel, onChange }: {
  settings: Values; disabled: boolean; partLabel?: string;
  onChange: (change: Values, adjustToSelection: boolean) => string | undefined;
}) {
  const id = useId(), [notice, setNotice] = useState<string>();
  let capabilities: ModelGeometryCapabilities | undefined, values = settings;
  try { capabilities = modelGeometryCapabilities(settings); values = modelGeometryDefaults(settings); } catch { /* Show the invalid saved choice, never change it on load. */ }
  const problem = modelGeometryProblem(settings);
  const min = capabilities?.min ?? 1000, max = capabilities?.max ?? 25000;
  const quad = values.quad, faces = values.faceLimit ?? DEFAULT_MODEL_FACE_LIMIT;
  const selected = (change: Values) => setNotice(onChange(change, true));
  const setFaces = (value: string) => { setNotice(undefined); onChange({ faceLimit: value === '' ? '' : Number(value) }, false); };
  return <section className="gs-model-geometry" data-testid="model-geometry-settings" aria-label="모델 면 수와 메시 형태">
    {(settings.modelMethod ?? 'tripo') === 'tripo' && <label>모델 제작 모델
      <select aria-label="모델 제작 모델" value={String(settings.model ?? DEFAULT_TRIPO_MODEL)} disabled={disabled} onChange={event => selected({ model: event.target.value })}>
        <option value="">선택하세요</option>
        {!tripoModelChoices.some(model => model.value === settings.model) && settings.model && <option value={String(settings.model)}>{String(settings.model)} · 지원 확인 필요</option>}
        {tripoModelChoices.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}
      </select>
    </label>}
    <fieldset className="gs-choice"><legend>메시 형태{quad === '' && <small> · 미선택</small>}</legend>
      <div>{[[true, '쿼드'], [false, '삼각형']].map(([value, label]) => <button type="button" key={String(value)} aria-pressed={quad === value}
        disabled={disabled || value === true && capabilities?.quadSupported === false}
        onClick={() => selected({ quad: quad === value ? '' : value as boolean })}>{label}</button>)}</div>
    </fieldset>
    {capabilities?.quadSupported === false && <p className="gs-fine">{capabilities.label}는 삼각형 메시만 지원합니다.</p>}
    {partLabel && <p className="gs-fine">현재 파트: {partLabel} · 면 수는 이 파트에만 적용됩니다.</p>}
    <div className="gs-face-inputs"><label htmlFor={id}>목표 면 수</label>
      <input id={id} data-testid="model-face-count" type="number" min={min} max={max} step={1} value={faces as string | number}
        disabled={disabled || !capabilities} aria-invalid={!!problem} aria-describedby={`${id}-help`} onChange={event => setFaces(event.target.value)} />
      <input data-testid="model-face-slider" type="range" aria-label="목표 면 수 슬라이더" min={min} max={max} step={100}
        value={typeof faces === 'number' ? Math.max(min, Math.min(max, faces)) : min}
        disabled={disabled || !capabilities || faces === ''} aria-valuetext={faces === '' ? '미입력' : `${faces}면`} onChange={event => setFaces(event.target.value)} />
    </div>
    <p id={`${id}-help`} className="gs-fine">{min.toLocaleString()}–{max.toLocaleString()}면 · 슬라이더 100면씩, 숫자는 정수 직접 입력.
      {capabilities?.basis === 'local-ceiling' ? ' 로컬 프리셋의 면 수 상한이며, 형상은 더 적은 면으로 만들어질 수 있습니다.' : capabilities?.basis === 'authoring-target' ? ' Astra 작업의 입력 범위와 제작 목표입니다. 정확한 면 수·쿼드 구성의 달성은 보장하지 않으며 결과를 확인합니다.' : ' 생성 목표와 실제 원본 면 수, Unity 삼각형 수는 다를 수 있습니다.'}
    </p>
    {problem && <p className="gs-geometry-problem" role="alert">{problem}</p>}
    {notice && <p className="gs-geometry-notice" role="status">{notice}</p>}
  </section>;
}
