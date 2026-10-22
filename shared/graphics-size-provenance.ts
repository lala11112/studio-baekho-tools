import type { AssetVersion, GraphicsTask } from './graphics';
import { normalizePhysicalSize } from './graphics-size';

/** Native meter calibration belongs to this exact successful output, never a live draft. */
export function hasPersistedNativeMeterUnits(version: AssetVersion, tasks: readonly GraphicsTask[]): boolean {
  if (version.provenance?.type !== 'local' || !version.provenance.jobId) return false;
  const matching = tasks.filter(task => task.id === version.provenance.jobId);
  if (matching.length !== 1) return false;
  const task = matching[0];
  if (task.objectId !== version.objectId || task.status !== 'review' || !task.localOnly ||
      !['A05', 'X04'].includes(task.taskId) || !task.outputVersionIds.includes(version.id)) return false;
  try { return normalizePhysicalSize(task.settings.physicalSize).mode !== 'keep'; }
  catch { return false; }
}
