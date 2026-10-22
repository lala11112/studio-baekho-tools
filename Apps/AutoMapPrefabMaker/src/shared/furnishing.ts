import { DEFAULT_DESIGNER, fixturePosition, parseGenerationSettings } from './features';
import { connectionCells } from './connections';
import { analyzeLevelDesign, DEFAULT_LEVEL_DESIGN } from './level-design';
import { parseBindings, validateMap } from './map';
import { getPropCoverageReport, placeAdditionalBalancedProps, placeProps, propValidationIssues, propWorldSize, type PropCoverageReport } from './props';
import type { AssetBinding, Cell, GenerationSettings, GridMap, PropInstance, ValidationIssue } from './types';
import { wallMountIssues } from './wall-mounts';
import { placeGroupedProps } from './grouped-props';
import { protectedPropIds } from './prop-groups';
import { resolveFixtureBinding } from './light-bindings';

export interface FurnishingOptions { props: boolean; decorations: boolean }
export interface RearrangementOptions extends FurnishingOptions { includeUnknown?: boolean }
export interface RearrangementResult extends FurnishingResult { movedProps: number; removedProps: number; preservedProps: number; groupCount: number }
export interface FurnishingResult {
  map: GridMap;
  issues: ValidationIssue[];
  addedProps: number;
  addedDecorations: number;
  usedBindingIds: string[];
  unchanged: boolean;
  coverage: PropCoverageReport;
  decorationTarget: number;
  decorationCount: number;
  convertedPropPlaceholders: number;
  convertedDecorationPlaceholders: number;
}
const key = (c: Cell) => `${c.x},${c.row}`;
const role = (p: PropInstance) => p.role ?? (p.blocksMovement ? 'prop' : 'decoration');
const warning = (code: string, message: string): ValidationIssue => ({ severity: 'warning', code, message });
const decorationCount = (map: GridMap) => (map.propInstances ?? []).filter(p => role(p) === 'decoration').length + (map.fixtures ?? []).filter(f => !f.wall&&f.role === 'decoration').length;
function measuredFixtureCells(map: GridMap, bindings: AssetBinding[]): Cell[] {
  const result = new Map<string, Cell>();
  for (const fixture of map.fixtures ?? []) {
    if(fixture.wall)continue;
    const binding = resolveFixtureBinding(map, bindings, fixture), size = binding && propWorldSize(binding, fixture.direction);
    if (!binding || !size) continue;
    const origin = fixturePosition(map, fixture);
    const x = (origin.x + binding.offset.x) / map.cellSize + (map.width - 1) / 2, row = (map.height - 1) / 2 - (origin.z + binding.offset.z) / map.cellSize;
    const halfWidth = size.x / map.cellSize / 2, halfDepth = size.z / map.cellSize / 2;
    for (let r = Math.max(0, Math.floor(row - halfDepth + .5)); r <= Math.min(map.height - 1, Math.ceil(row + halfDepth - .5)); r++)
      for (let c = Math.max(0, Math.floor(x - halfWidth + .5)); c <= Math.min(map.width - 1, Math.ceil(x + halfWidth - .5)); c++) result.set(key({ x: c, row: r }), { x: c, row: r });
  }
  return [...result.values()];
}

/** Local, additive furnishing. Existing geography and authored content are never regenerated. */
export function furnishExistingMap(source: GridMap, settings: GenerationSettings, bindings: AssetBinding[], options: FurnishingOptions): FurnishingResult {
  if (settings.designer?.propLayout === 'grouped') return furnishGroupedMap(source, settings, bindings, options, false);
  const issues: ValidationIssue[] = [], originalIds = new Set((source.propInstances ?? []).map(p => p.id));
  // Existing terrain is evaluated for circulation, without asking it to acquire a new design pattern.
  let placementSettings: GenerationSettings = { ...structuredClone(settings), width: source.width, height: source.height, cellSize: source.cellSize, maxStepHeight: source.maxStepHeight,
    connectionCount: source.connections.length, designer: { ...DEFAULT_DESIGNER, ...settings.designer, props: options.props, decorations: false, vegetation: false, propLayout: 'balanced' },
    levelDesign: { ...DEFAULT_LEVEL_DESIGN, ...settings.levelDesign, pattern: 'openArena' } };
  let catalog: AssetBinding[] = [], map = structuredClone(source), target = decorationCount(source);
  let preservedPattern: GenerationSettings | undefined;
  const safetyErrors = (candidate: GridMap) => [...propValidationIssues(candidate, catalog), ...wallMountIssues(candidate,catalog), ...analyzeLevelDesign(candidate, placementSettings).issues,
    ...(preservedPattern ? analyzeLevelDesign(candidate, preservedPattern).issues.map(i => ['raised-approaches', 'flanking-routes'].includes(i.code ?? '') ? { ...i, severity: 'error' as const } : i) : [])].filter(i => i.severity === 'error');
  const finish = (): FurnishingResult => {
    const added = (map.propInstances ?? []).filter(p => !originalIds.has(p.id));
    // Copy only the permitted occupancy changes and new measured instances back onto the original.
    const result = structuredClone(source);
    if (added.length) { result.version = 5; result.rows = [...map.rows]; result.propInstances = structuredClone(map.propInstances); if (source.fixtures !== undefined) result.fixtures = structuredClone(map.fixtures ?? []); }
    const occupied = new Set((result.propInstances ?? []).flatMap(p => p.cells.map(key)));
    let convertedProps = 0, remainingProps = 0;
    for (let row = 0; row < source.height; row++) for (let x = 0; x < source.width; x++) if (source.rows[row][x] === 'P' && !(source.propInstances ?? []).some(p => p.cells.some(c => c.x === x && c.row === row))) {
      if (result.rows[row][x] !== 'P' || occupied.has(key({ x, row }))) convertedProps++; else remainingProps++;
    }
    const remainingFixtureIds = new Set((result.fixtures ?? []).map(f => f.id));
    const convertedDecorations = (source.fixtures ?? []).filter(f => f.role === 'decoration' && !remainingFixtureIds.has(f.id)).length;
    const remainingDecorations = (result.fixtures ?? []).filter(f => f.role === 'decoration' && !f.bindingId).length;
    if ((options.props || options.decorations) && remainingProps) issues.push(warning('furnishing-proxy-preserved', `실측 인스턴스로 전환하지 못한 기존 P 표시 ${remainingProps}칸을 보존했습니다. 잠금·직접 지정·크기·배치 조건을 확인하세요. 이 표시는 실측 소품이 아닙니다.`));
    if (options.decorations && remainingDecorations) issues.push(warning('furnishing-decoration-proxy-preserved', `실측 소품으로 전환하지 못한 기존 미지정 장식 ${remainingDecorations}개를 보존했습니다. 크기·배치 조건을 확인하세요.`));
    return { map: result, issues, addedProps: added.filter(p => role(p) === 'prop').length, addedDecorations: added.filter(p => role(p) === 'decoration').length,
      usedBindingIds: [...new Set(added.map(p => p.bindingId))].sort(), unchanged: !added.length, coverage: getPropCoverageReport(result, placementSettings, catalog),
      decorationTarget: target, decorationCount: decorationCount(result), convertedPropPlaceholders: convertedProps, convertedDecorationPlaceholders: convertedDecorations };
  };
  if (!options.props && !options.decorations) return finish();
  try {
    placementSettings = parseGenerationSettings(placementSettings);
    catalog = parseBindings(bindings);
    const sourceErrors = validateMap(source, catalog).filter(i => i.severity === 'error');
    if (sourceErrors.length) {
      issues.push(warning('furnishing-invalid-map', `기존 맵을 보존했습니다. 먼저 기존 오류를 확인해 주세요: ${sourceErrors.slice(0, 3).map(i => i.message).join(' ')}`));
      return finish();
    }
    const baseline = analyzeLevelDesign(source, placementSettings), baselineErrors = baseline.issues.filter(i => i.severity === 'error');
    if (baselineErrors.length) {
      issues.push(warning('furnishing-existing-circulation', `기존 동선·회피 공간을 보존하기 위해 배치하지 않았습니다: ${baselineErrors.slice(0, 3).map(i => i.message).join(' ')}`));
      return finish();
    }
    if (settings.levelDesign) {
      try {
        const original = { ...placementSettings, designer: { ...placementSettings.designer!, ...settings.designer }, levelDesign: structuredClone(settings.levelDesign) };
        const analysis = analyzeLevelDesign(source, original);
        if (!analysis.issues.some(i => i.severity === 'error' || ['raised-approaches', 'flanking-routes'].includes(i.code ?? ''))) preservedPattern = original;
      } catch { /* An absent or already-unsatisfied optional pattern is not imposed on existing terrain. */ }
    }
    const fixtureFootprints = measuredFixtureCells(source, catalog);
    const reserved = [...baseline.reservedEntryCells, ...baseline.combatCells, ...baseline.routes.flat(), ...baseline.obstacleChoices.flatMap(c => c.routes.flat()), ...fixtureFootprints,
      ...(source.fixtures ?? []).filter(f=>!f.wall), ...(source.markers ?? [])];
    const purpose = placementSettings.designer!.preset, theme = placementSettings.levelDesign?.theme?.trim().toLowerCase();
    const eligible = catalog.filter(b => !b.wallMount&&(options.props && b.role === 'prop' || options.decorations && b.role === 'decoration') && b.prop?.weight && b.prop.roomTypes.includes(purpose)
      && (!theme || !b.prop.tags.length || b.prop.tags.some(tag => tag.toLowerCase() === theme)));
    for (const binding of eligible.filter(b => !b.prop?.size)) issues.push(warning('prop-unmeasured', `${binding.label}: 원본 크기 정보가 없어 자동 배치에서 제외했습니다. Unity 크기 정보를 가져오거나 XYZ 치수를 입력해 주세요.`));
    const measured = eligible.filter(b => b.prop?.size);
    if (options.props) {
      const propBindings = measured.filter(b => b.role === 'prop' && b.prop!.blocksMovement && b.prop!.placement === 'floor');
      if (!propBindings.length) issues.push(warning('furnishing-no-props', '현재 방 용도·테마에 맞는 크기가 측정된 바닥 장애 소품이 없습니다. 기존 지형과 배치를 유지했습니다.'));
      else {
        const placed = placeAdditionalBalancedProps(map, placementSettings, catalog, reserved, candidate => !safetyErrors(candidate).length);
        const errors = safetyErrors(placed.map);
        if (errors.length) issues.push(warning('furnishing-prop-fit', `새 장애 소품을 추가하면 기존 통행 조건을 유지할 수 없어 원래 배치를 보존했습니다: ${errors.slice(0, 3).map(i => i.message).join(' ')}`));
        else {
          // Clearing raw intentions alone is not a successful furnishing operation.
          if ((placed.map.propInstances ?? []).some(p => !originalIds.has(p.id))) map = placed.map;
          issues.push(...placed.issues);
        }
      }
    }
    if (options.decorations) {
      const doors = source.connections.flatMap(c => connectionCells(source, c));
      let floors = 0;
      for (let row = 0; row < source.height; row++) for (let x = 0; x < source.width; x++) if ('.P'.includes(source.rows[row][x]) && !doors.some(d => Math.abs(d.x - x) + Math.abs(d.row - row) <= 1)) floors++;
      target = floors ? Math.max(1, Math.ceil(floors * (placementSettings.designer!.decorationDensity ?? placementSettings.designer!.fixtureDensity) / 100)) : 0;
      const decorationBindings = measured.filter(b => b.role === 'decoration');
      if (!decorationBindings.length) issues.push(warning('furnishing-no-decorations', '현재 방 용도·테마에 맞는 크기가 측정된 장식이 없습니다. 장식 크기와 배치 조건을 확인해 주세요.'));
      else {
        const locks = new Set((source.lockedCells ?? []).map(key));
        const pending = (source.fixtures ?? []).filter(f => f.role === 'decoration' && !f.bindingId && !locks.has(key(f)));
        const pendingIds = new Set(pending.map(f => f.id));
        const report = analyzeLevelDesign(map, placementSettings);
        const protectedCells = new Set([...baseline.reservedEntryCells, ...baseline.combatCells, ...baseline.routes.flat(), ...baseline.obstacleChoices.flatMap(c => c.routes.flat()),
          ...(source.fixtures ?? []).filter(f => !f.wall&&!pendingIds.has(f.id)), ...fixtureFootprints, ...(source.markers ?? []), ...report.routes.flat(), ...report.obstacleChoices.flatMap(c => c.routes.flat()), ...(source.lockedCells ?? [])].map(key));
        const usedFixtureIds = new Set((source.fixtures ?? []).map(f => f.id));
        let sequence = 0, pendingIndex = 0, decorationFailure = '';
        while (pendingIndex < pending.length || decorationCount(map) < target) {
          const replacement = pending[pendingIndex++];
          const baseMap = replacement ? { ...map, fixtures: (map.fixtures ?? []).filter(f => f.id !== replacement.id) } : map;
          const occupied = new Set((map.propInstances ?? []).flatMap(p => p.cells.map(key)));
          const dressing = [...(map.fixtures ?? []).filter(f => !f.wall&&(f.role === 'decoration' || f.role === 'vegetation')), ...(map.propInstances ?? []).filter(p => role(p) === 'decoration' || role(p) === 'vegetation').flatMap(p => p.cells)];
          const origins: { c: Cell; score: number }[] = [];
          for (let row = 0; row < map.height; row++) for (let x = 0; x < map.width; x++) {
            const c = { x, row }, k = key(c); if (map.rows[row][x] !== '.' || occupied.has(k) || protectedCells.has(k)) continue;
            const spacing = dressing.length ? Math.min(...dressing.map(p => Math.hypot(p.x - x, p.row - row))) * 4 : 0;
            let hash = (Math.imul(x + 1, 73856093) ^ Math.imul(row + 1, 19349663) ^ Math.imul(settings.seed ?? 0, 83492791)) >>> 0;
            hash = Math.imul(hash ^ hash >>> 16, 2246822507) >>> 0;
            origins.push({ c, score: (replacement && c.x === replacement.x && c.row === replacement.row ? 1e6 : 0) + spacing + ((hash ^ hash >>> 13) >>> 0) / 4294967296 });
          }
          origins.sort((a, b) => b.score - a.score || a.c.row - b.c.row || a.c.x - b.c.x);
          let placed = false;
          let fixtureId = `furnish-decoration-${sequence++}`;
          while (usedFixtureIds.has(fixtureId)) fixtureId = `furnish-decoration-${sequence++}`;
          for (const { c } of origins) {
            const trial = structuredClone(baseMap);
            trial.fixtures = [...(trial.fixtures ?? []), { id: fixtureId, role: 'decoration', ...c, direction: 0, offset: { x: 0, y: 0, z: 0 } }];
            try {
              const candidate = placeProps(trial, placementSettings, catalog, undefined, [...protectedCells].map(k => { const [x, row] = k.split(',').map(Number); return { x, row }; }),
                { onlyRole: 'decoration', onlyFixtureId: fixtureId, varyGeneratedDecorations: true, skipProps: true, preserveCrossing: true }).map;
              const errors = safetyErrors(candidate);
              if (errors.length) { decorationFailure = errors[0].message; continue; }
              map = candidate; placed = true; break;
            } catch (error) { decorationFailure = error instanceof Error ? error.message : String(error); }
          }
          if (!placed && !replacement) break;
        }
        if (decorationCount(map) < target) issues.push(warning('furnishing-decoration-unmet', `장식 ${decorationCount(map)}개 / 목표 ${target}개: 실제 크기·천장·잠금·기존 배치·출입구·회피·경로를 함께 보존할 수 있는 공간이 부족해 가능한 배치만 유지했습니다.${decorationFailure ? ` ${decorationFailure}` : ''}`));
      }
    }
  } catch (error) {
    map = structuredClone(source);
    issues.push(warning('furnishing-failed', `기존 맵을 보존했습니다: ${error instanceof Error ? error.message : String(error)}`));
  }
  return finish();
}

/** Explicit rearrangement changes only eligible furniture and its occupancy, in one detached transaction. */
export function rearrangeMapProps(source: GridMap, settings: GenerationSettings, bindings: AssetBinding[], options: RearrangementOptions): RearrangementResult {
  return furnishGroupedMap(source, settings, bindings, options, true);
}

function furnishGroupedMap(source: GridMap, settings: GenerationSettings, bindings: AssetBinding[], options: RearrangementOptions, rearrange: boolean): RearrangementResult {
  const issues: ValidationIssue[] = [], before = source.propInstances ?? [];
  let catalog: AssetBinding[] = [], result = structuredClone(source), movedProps = 0, removedProps = 0, preservedProps = before.length;
  let added: PropInstance[] = [];
  let config: GenerationSettings = { ...structuredClone(settings), width: source.width, height: source.height, cellSize: source.cellSize,
    maxStepHeight: source.maxStepHeight, connectionCount: source.connections.length,
    designer: { ...DEFAULT_DESIGNER, ...settings.designer, props: options.props, decorations: options.decorations, vegetation: false, propLayout: 'grouped' },
    levelDesign: { ...DEFAULT_LEVEL_DESIGN, ...settings.levelDesign, pattern: 'openArena' } };
  const finish = (): RearrangementResult => {
    const unchanged = JSON.stringify(result) === JSON.stringify(source), occupied = new Set((result.propInstances ?? []).flatMap(p => p.cells.map(key)));
    let convertedPropPlaceholders = 0;
    for (let row = 0; row < source.height; row++) for (let x = 0; x < source.width; x++) if (source.rows[row][x] === 'P' && !before.some(p => p.cells.some(c => c.x === x && c.row === row))
      && (result.rows[row][x] !== 'P' || occupied.has(key({ x, row })))) convertedPropPlaceholders++;
    return { map: result, issues, unchanged, addedProps: added.filter(p => role(p) === 'prop').length, addedDecorations: added.filter(p => role(p) === 'decoration').length,
      usedBindingIds: [...new Set((result.propInstances ?? []).filter(p => p.provenance === 'generated').map(p => p.bindingId))].sort(),
      coverage: getPropCoverageReport(result, config, catalog), decorationTarget: decorationCount(result), decorationCount: decorationCount(result),
      convertedPropPlaceholders, convertedDecorationPlaceholders: 0, movedProps, removedProps, preservedProps,
      groupCount: new Set((result.propInstances ?? []).flatMap(p => p.groupId ? [p.groupId] : [])).size };
  };
  if (!options.props && !options.decorations) return finish();
  try {
    catalog = parseBindings(bindings); config = parseGenerationSettings(config);
    const sourceErrors = validateMap(source, catalog).filter(i => i.severity === 'error');
    if (sourceErrors.length) {
      issues.push(warning('furnishing-invalid-map', `기존 맵을 보존했습니다. 먼저 기존 오류를 확인하세요: ${sourceErrors.slice(0, 3).map(i => i.message).join(' ')}`));
      return finish();
    }
    const selected = (p: PropInstance) => role(p) === 'prop' ? options.props : role(p) === 'decoration' ? options.decorations : false;
    const protectedIds = protectedPropIds(source);
    for (const p of before) if (!rearrange || !selected(p) || p.provenance !== 'generated' && !options.includeUnknown) protectedIds.add(p.id);
    const protectedGroups = new Set(before.filter(p => protectedIds.has(p.id) && p.groupId).map(p => p.groupId));
    for (const p of before) if (p.groupId && protectedGroups.has(p.groupId)) protectedIds.add(p.id);
    const movable = before.filter(p => !protectedIds.has(p.id)), retained = before.filter(p => protectedIds.has(p.id));
    const candidate = structuredClone(source), rows = candidate.rows.map(r => [...r]);
    candidate.propInstances = structuredClone(retained);
    for (const p of movable) for (const c of p.cells) if (rows[c.row][c.x] === 'P') rows[c.row][c.x] = '.';
    candidate.rows = rows.map(r => r.join(''));
    // Unmeasured legacy P cells have no provenance. Only an explicit inclusion may rearrange them.
    const temporaryLocks = new Map((source.lockedCells ?? []).map(c => [key(c), c]));
    if (rearrange && !options.includeUnknown || !options.props) for (let row = 0; row < source.height; row++) for (let x = 0; x < source.width; x++) {
      if (candidate.rows[row][x] === 'P' && !retained.some(p => p.cells.some(c => c.x === x && c.row === row))) temporaryLocks.set(key({ x, row }), { x, row });
    }
    candidate.lockedCells = [...temporaryLocks.values()];
    const baseline = analyzeLevelDesign(candidate, config), baselineErrors = baseline.issues.filter(i => i.severity === 'error');
    if (baselineErrors.length) {
      issues.push(warning('furnishing-existing-circulation', `고정 배치의 통행·회피 공간을 확보할 수 없어 기존 맵을 보존했습니다: ${baselineErrors.slice(0, 3).map(i => i.message).join(' ')}`));
      return finish();
    }
    // Keep an already-satisfied tactical pattern; do not demand a new terrain shape from an existing room.
    const original = { ...config, levelDesign: settings.levelDesign ? structuredClone(settings.levelDesign) : config.levelDesign };
    const originalIssues = analyzeLevelDesign(source, original).issues;
    const preservePattern = !originalIssues.some(i => i.severity === 'error' || ['raised-approaches','flanking-routes'].includes(i.code ?? ''));
    const safe = (map: GridMap) => ![...validateMap(map, catalog), ...analyzeLevelDesign(map, config).issues,
      ...(preservePattern ? analyzeLevelDesign(map, original).issues.map(i => ['raised-approaches','flanking-routes'].includes(i.code ?? '') ? { ...i, severity: 'error' as const } : i) : [])].some(i => i.severity === 'error');
    const placed = placeGroupedProps(candidate, config, catalog, undefined, measuredFixtureCells(candidate, catalog), safe);
    issues.push(...placed.issues);
    if (!safe(placed.map)) {
      issues.push(warning('furnishing-grouped-fit', '묶음 배치 후 기존 동선 조건을 유지할 수 없어 변경을 적용하지 않았습니다.'));
      return finish();
    }
    const remaining = [...movable], usedIds = new Set(retained.map(p => p.id));
    const generated = (placed.map.propInstances ?? []).filter(p => !protectedIds.has(p.id));
    for (const p of generated) {
      let index = remaining.findIndex(old => old.id === p.id && old.bindingId === p.bindingId && role(old) === role(p));
      if (index < 0) index = remaining.findIndex(old => old.bindingId === p.bindingId && role(old) === role(p));
      if (index >= 0) {
        const old = remaining.splice(index, 1)[0]; p.id = old.id;
        const pose = (v: PropInstance) => JSON.stringify([v.x,v.row,v.direction,v.offset,v.cells]);
        if (pose(old) !== pose(p)) movedProps++;
      } else {
        const stem = p.id; let suffix = 1;
        while (usedIds.has(p.id) || before.some(old => old.id === p.id)) p.id = `${stem.slice(0, 65)}_${suffix++}`;
        added.push(p);
      }
      usedIds.add(p.id);
    }
    removedProps = remaining.length; preservedProps = retained.length;
    // No metadata or terrain from the temporary planner escapes this allowlist.
    result = structuredClone(source); result.rows = [...placed.map.rows];
    if ((placed.map.propInstances?.length ?? 0) || source.propInstances !== undefined) result.propInstances = structuredClone(placed.map.propInstances ?? []);
    if (generated.length) result.version = 5;
    if (!safe(result)) throw new Error('최종 소품 저장 상태가 통행·점유 검사를 통과하지 못했습니다.');
    const unknown = before.filter(p => selected(p) && !p.provenance && !p.authored && !p.id.startsWith('prop_manual_'));
    if (rearrange && !options.includeUnknown && unknown.length) issues.push(warning('furnishing-unknown-preserved', `생성 출처가 없는 기존 소품 ${unknown.length}개를 고정했습니다. 필요하면 출처 불명 소품 포함을 선택하세요.`));
    if (removedProps) issues.push(warning('furnishing-rearranged-removed', `기존 자동 소품 ${removedProps}개는 용도·짝·공간 조건에 맞지 않아 정리했습니다. 되돌리기로 원래 배치를 복원할 수 있습니다.`));
  } catch (error) {
    result = structuredClone(source); added = []; movedProps = 0; removedProps = 0; preservedProps = before.length;
    issues.push(warning('furnishing-failed', `기존 맵을 보존했습니다: ${error instanceof Error ? error.message : String(error)}`));
  }
  return finish();
}
