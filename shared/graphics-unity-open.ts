import type { GraphicsWorkspace } from './graphics';

/** Opening a queued import is bound to its approved request, never mutable project defaults. */
export function queuedUnityOpenTarget(workspace: GraphicsWorkspace, projectId: string, objectId: string, taskId: string, deliveryId: string) {
  if(workspace.projectId!==projectId||!workspace.objects.some(o=>o.id===objectId))return;
  const tasks=workspace.tasks.filter(t=>t.id===taskId&&t.objectId===objectId&&t.taskId==='X05'&&t.status==='running'&&t.deliveryId===deliveryId);
  const deliveries=workspace.deliveries.filter(d=>d.id===deliveryId&&d.objectId===objectId&&d.status==='queued');
  if(tasks.length!==1||deliveries.length!==1)return;
  const task=tasks[0],delivery=deliveries[0],target=task.targetProfile;
  if(!target?.projectPath||!target.unityVersion||!target.fingerprint||target.fingerprint!==delivery.profileFingerprint||delivery.errors.length||delivery.approvedTaskId&&delivery.approvedTaskId!==task.id)return;
  if(!task.inputVersionIds.length||new Set(task.inputVersionIds).size!==task.inputVersionIds.length||JSON.stringify([...task.inputVersionIds].sort())!==JSON.stringify([...delivery.versionIds].sort()))return;
  if(task.inputVersionIds.some(id=>workspace.versions.filter(v=>v.id===id&&v.objectId===objectId).length!==1))return;
  return {task,delivery,target};
}
