import { connectionCells } from './connections';
import { analyzeLevelDesign, compileLevelDesign, createObstacleEvaluator } from './level-design';
import { resolveFixtureBinding } from './light-bindings';
import { effectivePropComposition, getCompositionIssues } from './prop-composition';
import { connected, propFootprint, propOccupancy, propPosition, propValidationIssues, propWorldSize } from './props';
import type { AssetBinding, Cell, Direction, GenerationRegion, GenerationSettings, GridMap, PropComposition, PropInstance, ValidationIssue } from './types';
import { wallMountDependencies, wallMountIssues } from './wall-mounts';

const key = (c: Cell) => `${c.x},${c.row}`;
const inside = (c: Cell, r: GenerationRegion) => c.x >= r.x && c.row >= r.row && c.x < r.x + r.width && c.row < r.row + r.height;
const directions: Record<Direction, readonly [number, number]> = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] };
const roleOf = (p: PropInstance) => p.role ?? (p.blocksMovement ? 'prop' : 'decoration');
type Eligible = { binding: AssetBinding; composition: PropComposition };
type Member = { prop: PropInstance; asset: Eligible };
type Rect = { left: number; right: number; top: number; bottom: number };
const rect = (p: PropInstance): Rect => ({ left: p.x, right: Math.max(...p.cells.map(c => c.x)), top: p.row, bottom: Math.max(...p.cells.map(c => c.row)) });
const hash = (value: string, seed: number) => { let n = seed >>> 0; for (const c of value) n = Math.imul(n ^ c.charCodeAt(0), 16777619); return (n >>> 0) / 4294967296; };

/** Optional AI hints must not become entrance obstacles before the measured furnishing pass. */
export function clearGroupedPropHints(source: GridMap, region?: GenerationRegion): GridMap {
  const map = structuredClone(source), area = region ?? { x: 0, row: 0, width: source.width, height: source.height };
  const locks = new Set((map.lockedCells ?? []).map(key)), occupied = propOccupancy(map), rows = map.rows.map(r => [...r]);
  for (let row = area.row; row < area.row + area.height; row++) for (let x = area.x; x < area.x + area.width; x++) {
    const c = { x, row };
    if (rows[row]?.[x] === 'P' && !locks.has(key(c)) && !occupied.has(key(c)) && !map.assetOverrides.some(o => o.role === 'prop' && o.x === x && o.row === row)) rows[row][x] = '.';
  }
  map.rows = rows.map(r => r.join(''));
  return map;
}

/** Place small, meaningful sets without changing the geometry or any existing measured object. */
export function placeGroupedProps(source: GridMap, settings: GenerationSettings, bindings: AssetBinding[], region?: GenerationRegion, externalReserved: Cell[] = [], accept?: (map: GridMap) => boolean): { map: GridMap; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [], d = settings.designer;
  if (!d || !d.props && !d.decorations && !d.vegetation) return { map: structuredClone(source), issues };
  let map = clearGroupedPropHints(source, region);
  const area = region ?? { x: 0, row: 0, width: map.width, height: map.height }, seed = settings.seed ?? 0;
  const locks = new Set((map.lockedCells ?? []).map(key));
  const purpose = d.preset, theme = settings.levelDesign?.theme?.trim().toLowerCase();
  const activeRole = (role: AssetBinding['role']) => role === 'prop' ? d.props : role === 'decoration' ? d.decorations && (d.decorationDensity ?? d.fixtureDensity) > 0 : role === 'vegetation' ? d.vegetation && (d.vegetationDensity ?? d.fixtureDensity) > 0 : false;
  const candidates = bindings.filter(b => !b.wallMount && activeRole(b.role) && b.prop?.weight && b.prop.roomTypes.includes(purpose)
    && (!theme || !b.prop.tags.length || b.prop.tags.some(t => t.toLowerCase() === theme))).map(binding => ({ binding, composition: effectivePropComposition(binding) }));
  issues.push(...getCompositionIssues(bindings, settings));
  const eligible: Eligible[] = candidates.filter(c => ['equipment', 'storage', 'natural'].includes(c.composition.usage) && c.composition.family.trim() && c.binding.prop?.size && c.binding.prop.placement === 'floor' && (c.binding.role !== 'prop' || c.binding.prop.blocksMovement)).sort((a, b) => a.binding.id.localeCompare(b.binding.id));
  for (const c of candidates.filter(c => !c.binding.prop?.size)) issues.push({ severity: 'warning', code: 'prop-unmeasured', message: `${c.binding.label}: 원본 크기가 없어 군집 배치에서 제외했습니다.` });
  if (!eligible.length) {
    issues.push({ severity: 'warning', code: 'grouped-props-no-catalog', message: '크기와 용도가 확인된 바닥 소품 군집이 없습니다. 기존 실측 배치는 보존하고 자동 임시 소품 표시는 정리했습니다.' });
    return { map, issues };
  }
  const recipe = compileLevelDesign(settings), baseline = analyzeLevelDesign(map, settings);
  const reserved = new Map([...externalReserved, ...(map.lockedCells ?? []), ...baseline.reservedEntryCells, ...baseline.combatCells, ...baseline.routes.flat(),
    ...map.connections.flatMap(c => connectionCells(map, c)), ...(map.markers ?? []), ...(map.fixtures ?? []).filter(f => !f.wall && (f.anchor ?? 'floor') === 'floor'),
    ...(map.fixtures ?? []).filter(f => f.wall).flatMap(wallMountDependencies)].map(c => [key(c), c]));
  const fixtureVolumes: { x: number; y: number; z: number; width: number; height: number; depth: number }[] = [];
  // Existing fixtures reserve the full bounds of the same binding that export resolves.
  for (const fixture of map.fixtures ?? []) {
    if (fixture.wall) continue;
    const binding = resolveFixtureBinding(map, bindings, fixture);
    const angle = (fixture.direction + (binding?.rotationY ?? 0)) * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    const native = binding?.bounds?.size, size = binding && (propWorldSize(binding, fixture.direction) ?? (native ? {
      x: Math.abs(native.x * binding.scale.x * cos) + Math.abs(native.z * binding.scale.z * sin), y: native.y * binding.scale.y,
      z: Math.abs(native.x * binding.scale.x * sin) + Math.abs(native.z * binding.scale.z * cos),
    } : undefined));
    if (!binding || !size) continue;
    const [dx, dr] = fixture.anchor === 'wall' ? directions[fixture.direction] : [0, 0];
    const center = binding.bounds?.center, cx = (center?.x ?? 0) * binding.scale.x, cz = (center?.z ?? 0) * binding.scale.z;
    const x = fixture.x + dx / 2 + (fixture.offset.x + binding.offset.x + cos * cx + sin * cz) / map.cellSize;
    const row = fixture.row + dr / 2 - (fixture.offset.z + binding.offset.z - sin * cx + cos * cz) / map.cellSize;
    const base = map.elevations[fixture.row]?.[fixture.x] ?? 0;
    const anchorY = fixture.anchor === 'ceiling' ? map.ceilings?.find(c => c.x === fixture.x && c.row === fixture.row)?.undersideY ?? base
      : fixture.anchor === 'wall' ? base + (map.wallHeights?.find(c => c.x === fixture.x && c.row === fixture.row)?.height ?? 3) / 2 : base;
    fixtureVolumes.push({ x: (x - (map.width - 1) / 2) * map.cellSize, z: ((map.height - 1) / 2 - row) * map.cellSize,
      y: anchorY + fixture.offset.y + binding.offset.y + (center ? center.y * binding.scale.y : size.y / 2), width: size.x, height: size.y, depth: size.z });
    if ((fixture.anchor ?? 'floor') !== 'floor') continue;
    for (let r = Math.max(0, Math.floor(row - size.z / map.cellSize / 2 + .5)); r <= Math.min(map.height - 1, Math.ceil(row + size.z / map.cellSize / 2 - .5)); r++)
      for (let c = Math.max(0, Math.floor(x - size.x / map.cellSize / 2 + .5)); c <= Math.min(map.width - 1, Math.ceil(x + size.x / map.cellSize / 2 - .5)); c++) reserved.set(key({ x: c, row: r }), { x: c, row: r });
  }
  let floorCount = 0;
  for (let row = area.row; row < area.row + area.height; row++) for (let x = area.x; x < area.x + area.width; x++) if ('.P'.includes(map.rows[row]?.[x] ?? '_')) floorCount++;
  const floorArea = floorCount * map.cellSize ** 2, groupLimit = Math.max(1, Math.min(8, Math.round(Math.sqrt(floorArea) / 8)));
  const targetArea = floorArea * Math.min(30, Math.max(1, d.propCoverage ?? 12)) / 100;
  const targetDecorations = Math.ceil(floorCount * (d.decorationDensity ?? d.fixtureDensity) / 100), targetVegetation = Math.ceil(floorCount * (d.vegetationDensity ?? d.fixtureDensity) / 100);
  const localProps = () => (map.propInstances ?? []).filter(p => p.cells.some(c => inside(c, area)));
  const clippedArea = (p: PropInstance) => {
    const position = propPosition(map, p, bindings.find(b => b.id === p.bindingId));
    const left = (area.x - map.width / 2) * map.cellSize, right = (area.x + area.width - map.width / 2) * map.cellSize;
    const top = (map.height / 2 - area.row) * map.cellSize, bottom = (map.height / 2 - area.row - area.height) * map.cellSize;
    return Math.max(0, Math.min(right, position.x + p.size.x / 2) - Math.max(left, position.x - p.size.x / 2)) * Math.max(0, Math.min(top, position.z + p.size.z / 2) - Math.max(bottom, position.z - p.size.z / 2));
  };
  const propArea = () => localProps().filter(p => roleOf(p) === 'prop' && p.blocksMovement && (p.anchor ?? 'floor') === 'floor' && !['floorDetail', 'edge', 'excluded'].includes(effectivePropComposition(bindings.find(b => b.id === p.bindingId) ?? { label: '', prefabPath: '', role: 'prop' } as AssetBinding).usage)).reduce((n, p) => n + clippedArea(p), 0);
  const count = (role: 'decoration' | 'vegetation') => localProps().filter(p => roleOf(p) === role).length + (map.fixtures ?? []).filter(f => !f.wall && f.role === role && inside(f, area)).length;
  let usedArea = propArea(), decorations = count('decoration'), vegetation = count('vegetation');
  const needs = (role: AssetBinding['role']) => role === 'prop' ? d.props && usedArea + 1e-6 < targetArea : role === 'decoration' ? d.decorations && decorations < targetDecorations : role === 'vegetation' ? d.vegetation && vegetation < targetVegetation : false;
  const needsAny = () => eligible.some(c => needs(c.binding.role));
  const existingGroups = new Map<string, PropInstance[]>();
  for (const prop of map.propInstances ?? []) if (prop.groupId) existingGroups.set(prop.groupId, [...(existingGroups.get(prop.groupId) ?? []), prop]);
  let groupCount = [...existingGroups.values()].filter(members => members.length >= 2 && members.some(p => p.cells.some(c => inside(c, area)))).length;
  const usedIds = new Set((map.propInstances ?? []).flatMap(p => [p.id, ...(p.groupId ? [p.groupId] : [])]));
  let sequence = 0, failure = '';
  let currentOccupied = new Set<string>(), externalGap = new Set<string>();
  const roofs = new Map((map.ceilings ?? []).map(c => [key(c), c.undersideY])), forbiddenZones = new Set((map.zones ?? []).filter(z => ['reward', 'rest'].includes(z.kind)).map(key));
  const refreshOccupancy = () => {
    currentOccupied = new Set((map.propInstances ?? []).flatMap(p => p.cells.map(key))); externalGap = new Set(currentOccupied);
    for (const p of map.propInstances ?? []) for (const c of p.cells) for (let dr = -1; dr <= 1; dr++) for (let dx = -1; dx <= 1; dx++) externalGap.add(key({ x: c.x + dx, row: c.row + dr }));
  };
  const overlapsFixture = (prop: PropInstance, binding: AssetBinding) => {
    const p = propPosition(map, prop, binding);
    return fixtureVolumes.some(v => Math.abs(p.x - v.x) < (prop.size.x + v.width) / 2 - 1e-6 && Math.abs(p.z - v.z) < (prop.size.z + v.depth) / 2 - 1e-6
      && p.y < v.y + v.height / 2 - 1e-6 && p.y + prop.size.y > v.y - v.height / 2 + 1e-6);
  };
  const order = (assets: Eligible[], salt: string, pending: Member[] = []) => {
    const all = [...(map.propInstances ?? []), ...pending.map(m => m.prop)], ids = new Set(assets.map(a => a.binding.id));
    const count = all.filter(p => ids.has(p.bindingId)).length, total = assets.reduce((n, a) => n + a.binding.prop!.weight, 0) || 1;
    return assets.map(asset => ({ asset, deficit: asset.binding.prop!.weight / total * (count + 1) - all.filter(p => p.bindingId === asset.binding.id).length,
      tie: hash(`${salt}:${asset.binding.id}`, seed) })).sort((a, b) => b.deficit - a.deficit || a.tie - b.tie || a.asset.binding.id.localeCompare(b.asset.binding.id)).map(v => v.asset);
  };
  const construct = (asset: Eligible, origin: Cell, facing: Direction, members: Member[]): Member | undefined => {
    const binding = asset.binding, size = propWorldSize(binding, facing)!;
    if (size.x > area.width * map.cellSize || size.z > area.height * map.cellSize) return undefined;
    const cells = propFootprint(map, origin, size), base = map.elevations[origin.row]?.[origin.x], internal = new Set(members.flatMap(m => m.prop.cells.map(key)));
    if (!Number.isFinite(base) || cells.some(c => !inside(c, area) || map.rows[c.row]?.[c.x] !== '.' || locks.has(key(c)) || currentOccupied.has(key(c)) || externalGap.has(key(c)) || internal.has(key(c)) || reserved.has(key(c))
      || forbiddenZones.has(key(c)) || Math.abs(map.elevations[c.row][c.x] - base) > 1e-6 || (roofs.get(key(c)) ?? Infinity) - base < size.y + binding.offset.y)) return undefined;
    const width = Math.max(...cells.map(c => c.x)) - origin.x + 1, height = Math.max(...cells.map(c => c.row)) - origin.row + 1;
    if (Math.abs(binding.offset.x) > (width * map.cellSize - size.x) / 2 + 1e-6 || Math.abs(binding.offset.z) > (height * map.cellSize - size.z) / 2 + 1e-6 || binding.offset.y < -1e-6) return undefined;
    const member: Member = { asset, prop: { id: 'grouped-pending', bindingId: binding.id, role: binding.role as PropInstance['role'], ...origin, direction: facing,
      offset: { x: (width - 1) * map.cellSize / 2, y: 0, z: -(height - 1) * map.cellSize / 2 || 0 }, cells, size, blocksMovement: binding.prop!.blocksMovement, category: binding.prop!.category, anchor: 'floor', provenance: 'generated' } };
    return overlapsFixture(member.prop, binding) ? undefined : member;
  };
  const onWall = (member: Member, side: Direction) => {
    const r = rect(member.prop), [dx, dr] = directions[side];
    const back = member.prop.cells.filter(c => side === 0 ? c.row === r.top : side === 180 ? c.row === r.bottom : side === 90 ? c.x === r.right : c.x === r.left);
    return back.every(c => map.rows[c.row + dr]?.[c.x + dx] === '#');
  };
  const move = (member: Member, axis: 'x' | 'row', amount: number): number => {
    const p = member.prop, b = member.asset.binding, r = rect(p), dimension = axis === 'x' ? p.size.x : p.size.z;
    const cells = axis === 'x' ? r.right - r.left + 1 : r.bottom - r.top + 1, slack = Math.max(0, (cells * map.cellSize - dimension) / 2);
    const centered = axis === 'x' ? (cells - 1) * map.cellSize / 2 : -(cells - 1) * map.cellSize / 2;
    const current = axis === 'x' ? p.offset.x - centered + b.offset.x : -(p.offset.z - centered + b.offset.z);
    const delta = Math.min(slack, Math.max(-slack, current + amount)) - current;
    if (axis === 'x') p.offset.x += delta; else p.offset.z -= delta;
    return delta;
  };
  const tighten = (parent: Member, child: Member, side: Direction, moveParent: boolean) => {
    const [dx, dr] = directions[side], axis = dx ? 'x' : 'row', sign = dx || dr;
    const a = propPosition(map, parent.prop, parent.asset.binding), b = propPosition(map, child.prop, child.asset.binding);
    const distance = sign * (axis === 'x' ? b.x - a.x : a.z - b.z), extent = axis === 'x' ? (parent.prop.size.x + child.prop.size.x) / 2 : (parent.prop.size.z + child.prop.size.z) / 2;
    let excess = Math.max(0, distance - extent - Math.min(.2, map.cellSize * .1));
    excess -= Math.abs(move(child, axis, -sign * excess));
    if (moveParent) move(parent, axis, sign * excess);
  };
  const companionOrigins = (anchor: Member, asset: Eligible, facing: Direction, layout: 'wall' | 'island', members: Member[], salt: string): { c: Cell; side: Direction; parent: Member }[] => {
    const size = propWorldSize(asset.binding, facing)!, width = Math.max(1, Math.ceil(size.x / map.cellSize - 1e-8)), height = Math.max(1, Math.ceil(size.z / map.cellSize - 1e-8));
    const sides: Direction[] = layout === 'wall' ? facing === 0 || facing === 180 ? [90, 270] : [0, 180] : [0, 90, 180, 270];
    const ordered = sides.map(side => ({ side, tie: hash(`${salt}:${side}`, seed) })).sort((a, b) => a.tie - b.tie).map(v => v.side);
    return [anchor, ...members.slice(1)].flatMap(parent => {
      const r = rect(parent.prop);
      return ordered.flatMap(side => {
        const c = side === 90 ? { x: r.right + 1, row: r.top } : side === 270 ? { x: r.left - width, row: r.top } : side === 180 ? { x: r.left, row: r.bottom + 1 } : { x: r.left, row: r.top - height };
        if (layout === 'wall') {
          const a = rect(anchor.prop), back = ((facing + 180) % 360) as Direction;
          if (back === 180) c.row = a.bottom - height + 1;
          if (back === 90) c.x = a.right - width + 1;
        }
        return [{ c, side, parent }];
      });
    });
  };
  const addGroup = (): boolean => {
    refreshOccupancy();
    const anchors = order(eligible.filter(a => a.composition.member !== 'companion'), `anchor-${sequence}`), evaluate = recipe.combatRequired ? createObstacleEvaluator(map, settings) : undefined;
    for (const anchorAsset of anchors) {
      const compatible = order(eligible.filter(c => c.composition.family === anchorAsset.composition.family && c.composition.member !== 'anchor'), `companion-${sequence}`);
      if (!compatible.length || !needs(anchorAsset.binding.role) && !compatible.some(c => needs(c.binding.role))) continue;
      const layouts: ('wall' | 'island')[] = anchorAsset.composition.arrangement === 'either' ? ['wall', 'island'] : [anchorAsset.composition.arrangement];
      for (const layout of layouts) {
        const companions = compatible.filter(c => c.composition.arrangement === 'either' || c.composition.arrangement === layout);
        if (!companions.length) continue;
        const positions: { member: Member; facing: Direction; score: number }[] = [];
        for (let row = area.row; row < area.row + area.height; row++) for (let x = area.x; x < area.x + area.width; x++) for (const facing of [0, 90, 180, 270] as Direction[]) {
          const member = construct(anchorAsset, { x, row }, facing, []);
          if (!member || layout === 'wall' && !onWall(member, ((facing + 180) % 360) as Direction)) continue;
          const center = baseline.combatCenter ?? { x: (map.width - 1) / 2, row: (map.height - 1) / 2 };
          const range = Math.hypot(x - center.x, row - center.row), approach = recipe.dodgeDistance / map.cellSize + 2;
          const score = (layout === 'wall' ? 0 : -Math.abs(range - approach)) + hash(`${sequence}:${anchorAsset.binding.id}:${x},${row}:${facing}`, seed);
          positions.push({ member, facing, score });
        }
        positions.sort((a, b) => b.score - a.score);
        for (const position of positions) {
          const members = [structuredClone(position.member)], desired = 2 + Math.floor(hash(`${sequence}:members:${anchorAsset.binding.id}`, seed) * 3);
          for (let slot = 1; slot < desired; slot++) {
            let placed = false;
            for (const asset of order(companions, `companion-${sequence}-${slot}`, members)) {
              if (slot > 1 && !needs(asset.binding.role)) continue;
              for (const candidate of companionOrigins(members[0], asset, position.facing, layout, members, `${sequence}:${slot}`)) {
                const child = construct(asset, candidate.c, position.facing, members);
                if (!child || layout === 'wall' && !onWall(child, ((position.facing + 180) % 360) as Direction)) continue;
                tighten(candidate.parent, child, candidate.side, members.length === 1); members.push(child); placed = true; break;
              }
              if (placed) break;
            }
            if (!placed) break;
          }
          for (let length = members.length; length >= 2; length--) {
            const chosen = members.slice(0, length), blockers = chosen.filter(m => m.prop.blocksMovement).flatMap(m => m.prop.cells);
            if (chosen.some(m => overlapsFixture(m.prop, m.asset.binding))) continue;
            const tactic = blockers.length && evaluate ? evaluate(blockers) : undefined;
            if (layout === 'island' && blockers.length && evaluate && !tactic) continue;
            const trial = structuredClone(map), trialRows = trial.rows.map(r => [...r]);
            let groupId = `group_${sequence}_${position.member.prop.x}_${position.member.prop.row}`;
            for (let suffix = 1; usedIds.has(groupId); suffix++) groupId = `group_${sequence}_${position.member.prop.x}_${position.member.prop.row}_g${suffix}`;
            const placed = chosen.map((m, index) => {
              const p = structuredClone(m.prop); p.groupId = groupId; p.id = `${groupId}_${index}`;
              for (let suffix = 1; usedIds.has(p.id); suffix++) p.id = `${groupId}_${index}_p${suffix}`;
              for (const c of p.cells) if (p.blocksMovement) trialRows[c.row][c.x] = 'P';
              return p;
            });
            trial.rows = trialRows.map(r => r.join('')); trial.propInstances = [...(trial.propInstances ?? []), ...placed]; trial.version = 5;
            const errors = [...propValidationIssues(trial, bindings), ...analyzeLevelDesign(trial, settings).issues, ...wallMountIssues(trial, bindings)].filter(i => i.severity === 'error');
            if (errors.length) { failure = errors[0].message; continue; }
            if (!connected(trial)) { failure = '군집 배치 후 기존 바닥 동선이 나뉩니다.'; continue; }
            if (accept && !accept(trial)) { failure = '기존 배치의 보호 조건을 함께 유지할 수 없습니다.'; continue; }
            map = trial; sequence++; groupCount++; usedIds.add(groupId); placed.forEach(p => {
              usedIds.add(p.id);
              if (roleOf(p) === 'prop' && p.blocksMovement) usedArea += clippedArea(p);
              if (roleOf(p) === 'decoration') decorations++;
              if (roleOf(p) === 'vegetation') vegetation++;
            });
            for (const route of tactic?.routes ?? []) for (const c of route) reserved.set(key(c), c);
            return true;
          }
        }
      }
    }
    return false;
  };
  while (needsAny() && groupCount < groupLimit && (map.propInstances?.length ?? 0) < 3197) if (!addGroup()) break;
  if (needsAny()) issues.push({ severity: 'warning', code: 'grouped-props-unmet', message: groupCount >= groupLimit
    ? `군집 ${groupCount}묶음 / 사용 가능한 바닥 크기에 따른 상한 ${groupLimit}묶음에 도달했습니다. 바닥 점유율은 유연한 목표이며, 작은 소품을 추가로 흩어 놓지 않았습니다.`
    : `용도에 맞는 군집을 일부만 배치했습니다. 크기·군집 짝·벽면·간격·출입구·회피·통행을 함께 보존할 수 없어 남은 소품을 흩어 놓지 않았습니다.${failure ? ` ${failure}` : ''}` });
  return { map, issues };
}
