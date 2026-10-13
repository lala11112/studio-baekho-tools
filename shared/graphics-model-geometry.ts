/** Geometry request limits shared by controls, preparation and API quotation.
 * P1/P2 use the app's 1,000-face floor; this is not the provider's minimum.
 * Reading saved settings never clamps or rewrites them.
 */
export type ModelGeometrySettings = Record<string, string | number | boolean>;
export const DEFAULT_MODEL_FACE_LIMIT = 5000;
export const DEFAULT_TRIPO_MODEL = 'P2-20260801';
export const tripoModelChoices = [
  { value: 'P2-20260801', label: 'Smart Mesh P2.0' },
  { value: 'P1-20260311', label: 'Smart Mesh P1.0' },
  { value: 'v3.1-20260211', label: 'Tripo v3.1' },
] as const;
export type ModelGeometryCapabilities = {
  route: 'tripo' | 'local' | 'astra'; label: string; model?: string;
  min: number; max: number; quadSupported: boolean;
  basis: 'provider-target' | 'local-ceiling' | 'authoring-target';
};
export function modelTopologyLabel(quad: unknown): string {
  return quad === true ? '쿼드' : quad === false ? '삼각형' : '미선택';
}
export function modelGeometryCapabilities(settings: ModelGeometrySettings, taskId?: string): ModelGeometryCapabilities {
  const route = taskId === 'M04' ? 'local' : taskId === 'M15' ? 'astra' : ['M01', 'M02', 'M03'].includes(taskId ?? '') ? 'tripo' : String(settings.modelMethod ?? 'tripo');
  if (route === 'local') return { route, label: 'Blender 프리셋', min: 100, max: 1000000, quadSupported: true, basis: 'local-ceiling' };
  if (route === 'astra') return { route, label: 'Blender + Astra', min: 100, max: 1000000, quadSupported: true, basis: 'authoring-target' };
  if (route !== 'tripo') throw Error('제작 방식을 선택하세요.');
  const model = String(settings.model ?? DEFAULT_TRIPO_MODEL);
  if (model === 'P2-20260801') return { route, model, label: 'Smart Mesh P2.0', min: 1000, max: settings.quad === false ? 50000 : 25000, quadSupported: true, basis: 'provider-target' };
  if (model === 'P1-20260311') return { route, model, label: 'Smart Mesh P1.0', min: 1000, max: 20000, quadSupported: false, basis: 'provider-target' };
  if (model === 'v3.1-20260211') return { route, model, label: 'Tripo v3.1', min: 500, max: 1000000, quadSupported: true, basis: 'provider-target' };
  throw Error('지원되는 Tripo 제작 모델을 선택하세요.');
}
/** Defaults apply only to absent keys, never an explicitly cleared or invalid saved value. */
export function modelGeometryDefaults(settings: ModelGeometrySettings, taskId?: string): ModelGeometrySettings {
  const capability = modelGeometryCapabilities(settings, taskId);
  return { ...settings, ...(capability.route === 'tripo' ? { model: settings.model ?? DEFAULT_TRIPO_MODEL } : {}),
    faceLimit: settings.faceLimit ?? DEFAULT_MODEL_FACE_LIMIT, quad: settings.quad ?? capability.quadSupported };
}
export function modelGeometryProblem(settings: ModelGeometrySettings, taskId?: string): string | undefined {
  let capability: ModelGeometryCapabilities;
  try { capability = modelGeometryCapabilities(settings, taskId); } catch (error) { return (error as Error).message; }
  const values = modelGeometryDefaults(settings, taskId);
  if (values.quad === '') return '메시 형태 선택이 필요합니다.';
  if (typeof values.quad !== 'boolean') return '메시 형태는 쿼드 또는 삼각형으로 선택하세요.';
  if (values.quad && !capability.quadSupported) return `${capability.label}는 삼각형 메시만 지원합니다. 삼각형을 선택하세요.`;
  if (values.faceLimit === '') return '목표 면 수 선택이 필요합니다.';
  if (typeof values.faceLimit !== 'number' || !Number.isInteger(values.faceLimit) || values.faceLimit < capability.min || values.faceLimit > capability.max)
    return `${capability.label} ${modelTopologyLabel(values.quad)} 목표 면 수는 ${capability.min.toLocaleString('en-US')}–${capability.max.toLocaleString('en-US')} 정수입니다. 저장된 값은 자동 변경하지 않았습니다.`;
  return undefined;
}
export function requireModelGeometry(settings: ModelGeometrySettings, taskId?: string): ModelGeometrySettings & { faceLimit: number; quad: boolean } {
  const problem = modelGeometryProblem(settings, taskId); if (problem) throw Error(problem);
  return modelGeometryDefaults(settings, taskId) as ModelGeometrySettings & { faceLimit: number; quad: boolean };
}
/** Only an explicit provider/topology click adjusts the current target. No load-time use. */
export function changeModelGeometry(settings: ModelGeometrySettings, change: ModelGeometrySettings): { patch: ModelGeometrySettings; notice?: string } {
  const next = { ...settings, ...change }, patch = { ...change }, notices: string[] = [];
  let capability: ModelGeometryCapabilities;
  try { capability = modelGeometryCapabilities(next); } catch { return { patch }; }
  if (change.model !== undefined && next.quad !== '' && !capability.quadSupported && next.quad !== false) {
    patch.quad = next.quad = false; notices.push(`${capability.label}는 삼각형만 지원해 메시 형태를 삼각형으로 바꿨습니다.`);
  }
  // Clearing a topology is preserved; incomplete input is never silently repaired.
  if (next.quad === '' || typeof next.faceLimit !== 'number' || !Number.isInteger(next.faceLimit)) return { patch, notice: notices.join(' ') || undefined };
  capability = modelGeometryCapabilities(next);
  const adjusted = Math.min(capability.max, Math.max(capability.min, next.faceLimit));
  if (adjusted !== next.faceLimit) {
    patch.faceLimit = adjusted;
    notices.push(`선택한 ${capability.label} ${modelTopologyLabel(next.quad)} 범위에 맞춰 목표 면 수를 ${next.faceLimit.toLocaleString('en-US')} → ${adjusted.toLocaleString('en-US')}면으로 조정했습니다.`);
  }
  return { patch, notice: notices.join(' ') || undefined };
}
