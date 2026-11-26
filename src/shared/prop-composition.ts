import type { AssetBinding, GenerationSettings, PropComposition, ValidationIssue } from './types';
import { effectivePropBehavior, propSemanticName } from './prop-behavior';

/** A conservative name suggestion; an explicit catalog choice always takes precedence. */
export function suggestPropComposition(binding: AssetBinding): PropComposition {
  const name = propSemanticName(binding), behavior = effectivePropBehavior(binding);
  const result = (usage: PropComposition['usage'], family: string, member: PropComposition['member'] = 'either', arrangement: PropComposition['arrangement'] = 'either'): PropComposition => {
    return { usage, family, member, arrangement };
  };
  if (binding.role === 'railing' || /\b(?:railing|handrail|rail|fence|balustrade)\b|난간|울타리|펜스/.test(name)) return result('edge', 'edge', 'companion', 'wall');
  if (/\b(?:floor|ground)\s*(?:panel|plate|detail|grate|tile)|\b(?:floorplate|grating|hatch)\b|바닥\s*(?:판|패널|장식|타일)|철판/.test(name)) return result('floorDetail', 'floor-detail', 'companion');
  if (/\b(?:crate|box|chest|barrel|cask|container|cabinet|shelf|locker|rack|bin)\b|상자|궤짝|드럼|통(?:\s|$)|선반|책장|캐비닛|보관함/.test(name)) return result('storage', 'storage', 'either', 'island');
  if (/\b(?:rock|boulder|stone|tree|stump|plant|bush|grass|flower|mushroom|log)\b|바위|돌(?:\s|$)|나무|식물|식생|화분|덤불|잔디|꽃|버섯/.test(name)) return result('natural', 'natural', 'either', 'island');
  if (behavior === 'seat') return result('equipment', 'workstation', 'companion');
  if (behavior === 'workSurface') return result('equipment', 'workstation', 'anchor', 'wall');
  if (behavior === 'surfaceAccessory') return result('equipment', 'workstation', 'companion', 'wall');
  if (behavior === 'floorEquipment') {
    const family = /\b(?:console|terminal)\b|콘솔|단말/.test(name) ? 'control-station'
      : /\bgenerator\b|발전기/.test(name) ? 'power' : /\bengine\b/.test(name) ? 'engine' : 'workshop';
    return result('equipment', family, 'either', 'wall');
  }
  return result('unknown', 'unknown');
}

/** Explicit app choices override Unity memberships; each membership remains a separate compatible set. */
export function effectivePropCompositions(binding: AssetBinding): PropComposition[] {
  if (binding.prop?.composition) return [structuredClone(binding.prop.composition)];
  if (binding.prop?.unitySets?.length) return [...binding.prop.unitySets].sort((a, b) => a.guid.localeCompare(b.guid)).map(set => ({
    usage: set.usage, family: `unity-set:${set.guid}`, member: ['seat', 'surfaceAccessory'].includes(effectivePropBehavior(binding)) ? 'companion' : 'either', arrangement: set.arrangement,
  }));
  return [suggestPropComposition(binding)];
}

export function effectivePropComposition(binding: AssetBinding): PropComposition {
  return effectivePropCompositions(binding)[0];
}

/** Read-only diagnostics are also available before the user generates or rearranges anything. */
export function getCompositionIssues(bindings: AssetBinding[], settings: GenerationSettings): ValidationIssue[] {
  const d = settings.designer;
  if (!d) return [];
  const theme = settings.levelDesign?.theme?.trim().toLowerCase();
  const relevant = bindings.filter(b => !b.wallMount && (b.role === 'prop' ? d.props : b.role === 'decoration' ? d.decorations : b.role === 'vegetation' ? d.vegetation : false)
    && b.prop?.roomTypes.includes(d.preset) && (!theme || !b.prop.tags.length || b.prop.tags.some(t => t.toLowerCase() === theme)))
    .map(binding => ({ binding, composition: effectivePropComposition(binding) })).sort((a, b) => a.binding.id.localeCompare(b.binding.id));
  const issues: ValidationIssue[] = [];
  const warn = (matches: typeof relevant, code: string, message: string) => {
    if (matches.length) issues.push({ severity: 'warning', code, message: `${message} (${matches.slice(0, 4).map(c => c.binding.label).join(', ')}${matches.length > 4 ? ' 외' : ''})` });
  };
  const active = relevant.filter(c => c.binding.prop!.weight > 0);
  warn(active.filter(c => effectivePropBehavior(c.binding) === 'surfaceAccessory'), 'grouped-props-support-required', '받침이 필요한 화면·키보드 등은 바닥에 자동 배치하지 않습니다. 자립형 설비라면 소품 기능을 바닥 설비로 지정해 주세요.');
  warn(active.filter(c => effectivePropBehavior(c.binding) === 'seat' && !active.some(a => effectivePropBehavior(a.binding) === 'workSurface'
    && effectivePropCompositions(a.binding).some(ac => effectivePropCompositions(c.binding).some(cc => ac.usage === cc.usage && ac.family === cc.family)))),
  'grouped-props-partner-required', '의자와 함께 사용할 같은 계열의 책상·탁자가 없어 자동 배치에서 제외합니다.');
  warn(active.filter(c => effectivePropBehavior(c.binding) === 'workSurface' && !active.some(a => effectivePropBehavior(a.binding) === 'seat'
    && effectivePropCompositions(a.binding).some(ac => effectivePropCompositions(c.binding).some(cc => ac.usage === cc.usage && ac.family === cc.family)))),
  'grouped-props-partner-required', '책상·탁자와 함께 사용할 같은 계열의 의자가 없어 작업 공간을 자동 배치하지 않습니다.');
  warn(active.filter(c => c.composition.usage === 'unknown'), 'grouped-props-unknown', '용도가 불명확한 에셋은 자동 군집에서 제외됩니다. 소품의 용도·군집 분류를 지정해 주세요.');
  warn(active.filter(c => c.composition.usage === 'edge'), 'grouped-props-edge', '난간·울타리는 일반 소품 군집에서 제외됩니다. 난간 역할로 등록해 절벽·다리 가장자리 배치를 사용하세요.');
  warn(active.filter(c => c.composition.usage === 'floorDetail'), 'grouped-props-floor-detail', '바닥 패널·판은 장애물 군집과 점유율에서 제외됩니다. 바닥 타일 또는 통행 차단을 끈 별도 장식으로 사용하세요.');
  warn(relevant.filter(c => c.composition.usage === 'excluded'), 'grouped-props-excluded', '사용자가 자동 군집 배치에서 제외한 에셋입니다.');
  warn(active.filter(c => ['equipment', 'storage', 'natural'].includes(c.composition.usage) && c.binding.prop!.placement !== 'floor'), 'grouped-props-wrong-placement', '군집 배치는 바닥 소품에 적용됩니다. 벽·천장 에셋은 해당 부착 배치를 사용하거나 배치 위치를 확인해 주세요.');
  warn(active.filter(c => c.binding.role === 'prop' && !c.binding.prop!.blocksMovement), 'grouped-props-nonblocking-prop', '통행을 막지 않는 소품은 장애물 예산에서 제외됩니다. 장식 역할로 등록하면 군집의 보조 소품으로 사용할 수 있습니다.');
  return issues;
}
