import { catalog } from './catalog';
import type { AssetVersion, GraphicsTask } from './graphics';

/** Resolve the generation task from immutable ancestry, not today's form selection. */
export function modelProductionLabel(version: AssetVersion, versions: AssetVersion[], tasks: GraphicsTask[]): string {
  const seen = new Set<string>();
  let frontier = [version];
  while (frontier.length) {
    const labels = new Set<string>();
    const next: AssetVersion[] = [];
    for (const item of frontier) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const task = tasks.find(task => task.objectId === version.objectId && task.outputVersionIds.includes(item.id));
      if (task && ['M01', 'M02', 'M03', 'M04', 'M15'].includes(task.taskId)) {
        const id = String(task.settings.model ?? '');
        labels.add(['M01', 'M02', 'M03'].includes(task.taskId)
          ? `Tripo ${catalog.model.find(model => model.id === id)?.label ?? '모델 미확인'}${id ? ` · ${id}` : ''}`
          : task.taskId === 'M04' ? 'Blender 프리셋' : 'Blender + Astra');
      }
      next.push(...item.sourceVersionIds.flatMap(id => versions.filter(source => source.id === id && source.objectId === version.objectId)));
    }
    if (labels.size) return [...labels].join(' / ');
    frontier = next;
  }
  return '제작 모델 미확인 · 가져온 자료 또는 이전 기록';
}
