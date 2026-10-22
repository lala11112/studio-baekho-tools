import type { AssetBinding, GenerationSettings, PropComposition, ValidationIssue } from './types';

/** A conservative name suggestion; an explicit catalog choice always takes precedence. */
export function suggestPropComposition(binding: AssetBinding): PropComposition {
  const name = `${binding.label} ${binding.prefabPath.split('/').pop() ?? ''} ${binding.prop?.category ?? ''}`.replace(/([a-z])([A-Z0-9])/g, '$1 $2').toLowerCase().replace(/[_\-.]+/g, ' ');
  const result = (usage: PropComposition['usage'], family: string, member: PropComposition['member'] = 'either', arrangement: PropComposition['arrangement'] = 'either'): PropComposition => {
    const size = binding.prop?.size ?? binding.bounds?.size;
    if (size && member === 'companion' && ['equipment', 'storage', 'natural'].includes(usage)) {
      const width = Math.abs(size.x * binding.scale.x), height = Math.abs(size.y * binding.scale.y), depth = Math.abs(size.z * binding.scale.z);
      // Size refines a known object's group role; geometry alone never supplies a semantic purpose.
      // A large accessory can anchor a set, without disqualifying small generic assets from doing so.
      if ([width, height, depth].every(n => Number.isFinite(n) && n > 0) && Math.max(width, depth, height) >= 2) member = 'either';
    }
    return { usage, family, member, arrangement };
  };
  if (binding.role === 'railing' || /\b(?:railing|handrail|rail|fence|balustrade)\b|난간|울타리|펜스/.test(name)) return result('edge', 'edge', 'companion', 'wall');
  if (/\b(?:floor|ground)\s*(?:panel|plate|detail|grate|tile)|\b(?:floorplate|grating|hatch)\b|바닥\s*(?:판|패널|장식|타일)|철판/.test(name)) return result('floorDetail', 'floor-detail', 'companion');
  if (/\b(?:crate|box|chest|barrel|cask|container|cabinet|shelf|locker|rack|bin)\b|상자|궤짝|드럼|통(?:\s|$)|선반|책장|캐비닛|보관함/.test(name)) return result('storage', 'storage', 'either', 'island');
  if (/\b(?:rock|boulder|stone|tree|stump|plant|bush|grass|flower|mushroom|log)\b|바위|돌(?:\s|$)|나무|식물|식생|화분|덤불|잔디|꽃|버섯/.test(name)) return result('natural', 'natural', 'either', 'island');
  if (/\b(?:console|terminal|computer|monitor|machine|machinery|generator|engine|workbench|desk|table|chair|stool|keyboard)\b|콘솔|단말|컴퓨터|모니터|기계|발전기|작업대|책상|탁자|의자|가구/.test(name)) {
    const companion = /\b(?:monitor|chair|stool|keyboard)\b|모니터|의자/.test(name);
    return result('equipment', 'equipment', companion ? 'companion' : 'either', 'wall');
  }
  return result('unknown', 'unknown');
}

export function effectivePropComposition(binding: AssetBinding): PropComposition {
  return structuredClone(binding.prop?.composition ?? suggestPropComposition(binding));
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
  warn(active.filter(c => c.composition.usage === 'unknown'), 'grouped-props-unknown', '용도가 불명확한 에셋은 자동 군집에서 제외됩니다. 소품의 용도·군집 분류를 지정해 주세요.');
  warn(active.filter(c => c.composition.usage === 'edge'), 'grouped-props-edge', '난간·울타리는 일반 소품 군집에서 제외됩니다. 난간 역할로 등록해 절벽·다리 가장자리 배치를 사용하세요.');
  warn(active.filter(c => c.composition.usage === 'floorDetail'), 'grouped-props-floor-detail', '바닥 패널·판은 장애물 군집과 점유율에서 제외됩니다. 바닥 타일 또는 통행 차단을 끈 별도 장식으로 사용하세요.');
  warn(relevant.filter(c => c.composition.usage === 'excluded'), 'grouped-props-excluded', '사용자가 자동 군집 배치에서 제외한 에셋입니다.');
  warn(active.filter(c => ['equipment', 'storage', 'natural'].includes(c.composition.usage) && c.binding.prop!.placement !== 'floor'), 'grouped-props-wrong-placement', '군집 배치는 바닥 소품에 적용됩니다. 벽·천장 에셋은 해당 부착 배치를 사용하거나 배치 위치를 확인해 주세요.');
  warn(active.filter(c => c.binding.role === 'prop' && !c.binding.prop!.blocksMovement), 'grouped-props-nonblocking-prop', '통행을 막지 않는 소품은 장애물 예산에서 제외됩니다. 장식 역할로 등록하면 군집의 보조 소품으로 사용할 수 있습니다.');
  return issues;
}
