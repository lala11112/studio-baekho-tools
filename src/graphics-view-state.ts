import { creationStages, validateCreation, type CreationSpec, type CreationStage } from '../shared/graphics-creation';
import type { GraphicsObject } from '../shared/graphics';

export type GraphicsViewState = {
  schemaVersion: 1;
  stage: CreationStage;
  creation: CreationSpec;
  shownVersionId: string;
  taskOverride?: string;
  movementExpanded?: boolean;
};
const prefix = 'partsmith.guided-workspace.v1';
export function readGraphicsView(storage: Pick<Storage, 'getItem'>, projectId: string, object: GraphicsObject): GraphicsViewState | undefined {
  try {
    const value = JSON.parse(storage.getItem(`${prefix}:${projectId}:${object.id}`) ?? 'null') as GraphicsViewState | null;
    if (!value || value.schemaVersion !== 1 || !creationStages.some(stage => stage.id === value.stage)) return;
    validateCreation(value.creation, object.kind);
    if (typeof value.shownVersionId !== 'string' || (value.taskOverride !== undefined && typeof value.taskOverride !== 'string')) return;
    if (value.movementExpanded !== undefined && typeof value.movementExpanded !== 'boolean') return;
    return value;
  } catch { return; }
}
export function saveGraphicsView(storage: Pick<Storage, 'setItem'>, projectId: string, objectId: string, value: GraphicsViewState): boolean {
  try { storage.setItem(`${prefix}:${projectId}:${objectId}`, JSON.stringify(value)); storage.setItem(`${prefix}:${projectId}:last-object`, objectId); return true; }
  catch { return false; }
}
export function lastGraphicsObject(storage: Pick<Storage, 'getItem'>, projectId: string): string | undefined {
  try { return storage.getItem(`${prefix}:${projectId}:last-object`) ?? undefined; } catch { return; }
}
