import type { AssetBinding, GridMap, WallPlaceholderKind } from './types';
import { editWallMount } from './wall-mounts';
import { WALL_PLACEHOLDER_KINDS, wallPlaceholderLabel } from './wall-placeholders';

export function countWallPlaceholders(map: GridMap, kind: WallPlaceholderKind): number {
  return (map.fixtures ?? []).filter(fixture => fixture.wall?.placeholder === kind).length;
}

/** Commit the returned map once so the entire replacement shares one undo entry. */
export function replaceWallPlaceholders(source: GridMap, kind: WallPlaceholderKind, bindingId: string, bindings: AssetBinding[]): { map: GridMap; replaced: number } {
  if (!WALL_PLACEHOLDER_KINDS.includes(kind)) throw new Error('일괄 교체할 임시 벽 부착물 종류를 확인해 주세요.');
  const targets = (source.fixtures ?? []).filter(fixture => fixture.wall?.placeholder === kind).map(fixture => fixture.id);
  let map = structuredClone(source);
  for (const [index, fixtureId] of targets.entries()) {
    try {
      map = editWallMount(map, fixtureId, { bindingId }, bindings);
      if (map.fixtures?.find(fixture => fixture.id === fixtureId)?.wall?.placeholder === kind) throw new Error('교체할 실제 벽 프리팹을 선택해 주세요.');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${wallPlaceholderLabel(kind)} ${targets.length}개 일괄 교체의 ${index + 1}번째 항목(${fixtureId})을 교체할 수 없습니다. ${reason} 전체 변경을 취소하고 기존 배치를 유지했습니다.`);
    }
  }
  return { map, replaced: targets.length };
}
