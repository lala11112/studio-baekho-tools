import type { AssetVersion, GraphicsTask, GraphicsWorkspace } from './graphics';
import { requiresPartSourcePreparation, requiresPartSpaceRestoration } from './graphics';
import { creationPartForTask, creationStages, creationTaskId, creationSelectionProblem, isBiologicalSubject, stageForTask, type CreationSpec, type CreationStage } from './graphics-creation';
import { getGraphicsCompatibility } from './graphics-lineage';
import { graphicsAstraTasks } from './graphics-catalog';
import { graphicsInputSupportProblem } from './graphics-input-support';

export type JourneyFocus = { stage: CreationStage; partId?: string; clipName?: string; candidateVersionId?: string; taskId?: string; taskOverride?: string };
export type JourneyTarget = JourneyAction['target'];
export type JourneyStatus = 'ready' | 'missing' | 'review' | 'running' | 'approval' | 'blocked' | 'skipped' | 'complete';
export type JourneyAction = { intent: 'navigate' | 'review' | 'accept' | 'prepare' | 'approve' | 'recover' | 'stop'; label: string; reason: string; target: { stage: CreationStage; partId?: string; clipName?: string; versionId?: string; taskId?: string } };
export type JourneyStage = { id: CreationStage; label: string; status: JourneyStatus; optional: boolean; reason: string };
export type JourneyAcceptedInput = { key: string; versionId: string; version?: AssetVersion };
export type JourneyReadiness = { inputs: JourneyAcceptedInput[]; problems: { reason: string; target: JourneyTarget }[] };
export type JourneyPart = { id: string; label: string; modelVersionId?: string; designVersionId?: string; surfaceVersionId?: string; uvVersionId?: string; textureVersionId?: string; status: JourneyStatus; reason: string };
export type GraphicsJourney = {
  stages: JourneyStage[]; acceptedInputs: JourneyAcceptedInput[]; parts: JourneyPart[];
  task?: GraphicsTask; review?: { version: AssetVersion; accepted: boolean; adoptable: boolean; reason: string };
  primaryAction: JourneyAction; secondaryActions: JourneyAction[]; compatibilityIssues: string[];
  delivery?: GraphicsWorkspace['deliveries'][number];
  suggestedNext?: JourneyTarget; readinessProblems: { reason: string; target: JourneyTarget }[]; inputReadiness: JourneyReadiness;
};

/** Shared read-only prerequisites for the guided route. Native/file checks remain coordinator-owned. */
export function getJourneyReadiness(workspace: GraphicsWorkspace, objectId: string, draft: CreationSpec, focus: JourneyFocus): JourneyReadiness {
  const object=workspace.objects.find(o=>o.id===objectId), taskId=focus.taskOverride || creationTaskId(draft,focus.stage);
  if(taskId==='LOCAL_PLANAR_INSPECT'||taskId==='LOCAL_PLANAR_REPAIR') {
    const task=workspace.tasks.find(t=>t.objectId===objectId&&t.id===focus.taskId&&t.taskId===taskId);
    const sourceId=task?.inputVersionIds[0]??task?.planarSelection?.versionId;
    const source=workspace.versions.find(v=>v.objectId===objectId&&v.id===sourceId);
    return {inputs:source?[{key:`model:${source.slot}`,versionId:source.id,version:source}]:[],problems:source?[]:[{reason:'고정된 모델의 경계 검사 화면에서 진행하세요.',target:{stage:'model'}}]};
  }
  const part=creationPartForTask({...draft,activePartId:focus.partId ?? draft.activePartId},taskId);
  const slot=part ? `part-${part.id}` : 'main';
  const problems: JourneyReadiness['problems']=[], inputs: JourneyAcceptedInput[]=[];
  const target=(stage: CreationStage): JourneyTarget=>({stage,partId:part?.id,clipName:focus.clipName});
  const requireInput=(role: string, inputSlot: string, stage: CreationStage, reason: string, optional=false)=>{
    const key=`${role}:${inputSlot}`, versionId=object?.accepted[key];
    const version=workspace.versions.find(v=>v.id===versionId && v.objectId===objectId && v.role===role && v.slot===inputSlot);
    if(versionId) inputs.push({key,versionId,version});
    if(!version && !optional) problems.push({reason,target:target(stage)});
  };
  const selectionProblem=!focus.taskOverride || focus.taskOverride===creationTaskId(draft,focus.stage) ? creationSelectionProblem(draft,focus.stage) : undefined;
  if(selectionProblem) problems.push({reason:selectionProblem,target:target(focus.stage)});
  if(!object) problems.push({reason:'오브젝트를 선택하세요.',target:target('design')});
  const explicitInput=(id: unknown, stage: CreationStage, reason: string, imageOnly=false, roles?: string[], requiredSlot?: string)=>{
    const version=workspace.versions.find(v=>v.id===id && v.objectId===objectId && (!roles || roles.includes(v.role)) && (!requiredSlot || v.slot===requiredSlot));
    if(version && (!imageOnly || version.files.some(f=>/\.(png|jpe?g|webp)$/i.test(f.path)))) inputs.push({key:`${version.role}:${version.slot}`,versionId:version.id,version});
    else problems.push({reason,target:target(stage)});
  };
  if(focus.stage==='design') {
    if(taskId==='I08') requireInput('design','main','design','전체 디자인을 먼저 채택하세요.');
    else if(['I03','I05','I07'].includes(taskId)) requireInput('design',slot,'design','사용할 이미지를 먼저 채택하세요.');
    else if(['I01','I02','I06'].includes(taskId)) {
      const refs=object?.references.map(r=>workspace.versions.find(v=>v.id===r.versionId)).filter((v):v is AssetVersion=>!!v) ?? [];
      for(const version of refs) inputs.push({key:`reference:${version.id}`,versionId:version.id,version});
      if(taskId!=='I01' && !refs.length) problems.push({reason:'참고 자료를 먼저 연결하세요.',target:target('design')});
    }
  } else if(focus.stage==='model') {
    const values=draft.stageSettings.model?.values;
    if(taskId!=='M03' && taskId!=='M02') requireInput('design',slot,'design','사용할 이미지 버전을 먼저 채택하세요.');
    if(taskId==='M02' || taskId==='M15' && values?.inputMode==='multiview') {
      const ids=['front','left','back','right'].map(direction=>values?.[`${direction}VersionId`]);
      for(const [i,id] of ids.entries()) explicitInput(id,'design',`${['front','left','back','right'][i]} 방향 원본을 지정하세요.`,true,['design'],slot);
      if(new Set(ids).size!==4) problems.push({reason:'멀티뷰는 네 방향의 서로 다른 원본이 필요합니다.',target:target('design')});
    }
  } else if(focus.stage==='surface') {
    requireInput('model',slot,'model','UV·재질에 사용할 모델을 먼저 채택하세요.');
    if(taskId==='T03' && draft.stageSettings.surface?.values.textureReference!=='text') requireInput('design',slot,'design','이 파트의 디자인을 채택하거나 설명만 사용을 선택하세요.',!part);
  } else if(focus.stage==='assembly') {
    if(taskId==='M08') {
      const parts=draft.parts.filter(p=>p.enabled);
      if(parts.length<2) problems.push({reason:'조립할 파트를 두 개 이상 설정하세요.',target:target('model')});
      for(const p of parts) {
        requireInput('model',`part-${p.id}`,'model',`${p.label} 모델을 먼저 채택하세요.`);
        const selected=inputs.find(i=>i.key===`model:part-${p.id}`), model=selected?.version;
        const material=workspace.versions.find(v=>v.id===object?.accepted[`material:part-${p.id}`] && v.objectId===objectId && v.role==='material' && v.slot===`part-${p.id}`);
        const descends=(v:AssetVersion,id:string,materialOnly:boolean,seen=new Set<string>()):boolean=>{
          if(v.id===id) return true;
          if(seen.has(v.id) || v.objectId!==objectId || v.slot!==`part-${p.id}` || !['model','material'].includes(v.role) || materialOnly && v.role==='model') return false;
          seen.add(v.id); return v.sourceVersionIds.some(sourceId=>{const s=workspace.versions.find(v=>v.id===sourceId);return !!s && descends(s,id,materialOnly,seen);});
        };
        if(model && material && !descends(model,material.id,false)) {
          if(descends(material,model.id,true) && selected) Object.assign(selected,{key:`material:part-${p.id}`,versionId:material.id,version:material});
          else problems.push({reason:`${p.label}의 채택 재질이 현재 모델과 다른 형상을 참조합니다.`,target:{stage:'surface',partId:p.id}});
        }
      }
      requireInput('design','main','design','전체 디자인을 확인하세요.',true);
    } else if(taskId==='M09' || taskId==='M05' && draft.stageSettings.assembly?.values.editSourceMode==='candidate') explicitInput(draft.stageSettings.assembly?.values.sourceVersionId,'assembly','수정할 모델 후보를 결과 화면에서 선택하세요.',false,['model','material'],part ? slot : undefined);
    else requireInput('model',slot,'model','사용할 모델을 먼저 채택하세요.');
  } else if(focus.stage==='rig') requireInput(taskId==='R03'?'rig':'model','main',taskId==='R03'?'rig':'model','사용할 모델 또는 리그를 먼저 채택하세요.');
  else if(focus.stage==='unity') {
    const base=['rig','model','design'].find(role=>workspace.versions.some(v=>v.id===object?.accepted[`${role}:main`] && v.role===role && v.objectId===objectId));
    if(base) requireInput(base,'main','model','사용할 자료를 먼저 채택하세요.');
    else problems.push({reason:'가져온 자료를 채택한 뒤 실행하세요.',target:target('model')});
    if(taskId==='X05' && object) {
      for(const key of Object.keys(object.accepted).filter(key=>key.startsWith('animation:'))) requireInput('animation',key.slice(10),'animation','채택한 동작 원본을 확인하세요.');
      requireInput('material','main','surface','채택한 재질 원본을 확인하세요.',true);
    }
  }
  else if(focus.stage==='animation') {
    if(['N04','N05'].includes(taskId)) requireInput('rig','main','rig','사용할 리그를 먼저 채택하세요.');
    if(taskId==='N06') requireInput('animation',focus.clipName ?? String(draft.stageSettings.animation?.values.clipName ?? 'Idle'),'animation','수정할 애니메이션을 먼저 채택하세요.');
    if(taskId==='N04') requireInput('motion-reference',focus.clipName ?? String(draft.stageSettings.animation?.values.clipName ?? 'Idle'),'animation','이 동작의 참조 영상을 먼저 채택하세요.');
    if(taskId==='N01') {
      const rig=workspace.versions.find(v=>v.id===object?.accepted['rig:main'] && v.role==='rig');
      requireInput(rig?'rig':'model','main',rig?'rig':'model','측면을 렌더할 모델 또는 리그를 먼저 채택하세요.');
    }
    if(taskId==='N02') explicitInput(draft.stageSettings.animation?.values.motionSourceVersionId,'animation','동작 영상에 사용할 원본 이미지를 선택하세요.',true);
  }
  const formatProblem = inputs.length ? graphicsInputSupportProblem(taskId, inputs.flatMap(input => input.version ? [input.version] : []), object?.kind) : undefined;
  if (formatProblem) problems.push({ reason: formatProblem, target: target(focus.stage) });
  if(['animation','unity'].includes(focus.stage) && object) for(const reason of getGraphicsCompatibility(object,workspace.versions)) problems.push({reason,target:target(focus.stage)});
  if(['I05','I07','M15'].includes(taskId) || graphicsAstraTasks.has(taskId) && !['M08','M15'].includes(taskId)) {
    for(const ref of object?.references ?? []) {
      const version=workspace.versions.find(v=>v.id===ref.versionId);
      if(version && (['I05','I07','M15'].includes(taskId) || version.role!=='motion-reference')) inputs.push({key:`reference:${version.id}`,versionId:version.id,version});
    }
  }
  return {inputs:[...new Map(inputs.map(input=>[input.versionId,input])).values()],problems};
}

export function journeyMotionEnabled(draft: CreationSpec, stage: 'rig' | 'animation'): boolean {
  const flag=draft.stageSettings[stage]?.values.enabled;
  if(typeof flag==='boolean') return flag;
  const rigType=draft.stageSettings.rig?.values.rigType;
  return isBiologicalSubject(draft.subject) || typeof rigType==='string' && rigType!=='' && rigType!=='none';
}

/** Capabilities belong to the accepted branch, never the newest unrelated task. */
export function journeySurfaceCapabilities(workspace: GraphicsWorkspace, version: AssetVersion): { uvVersionId?: string; textureVersionId?: string } {
  const result: { uvVersionId?: string; textureVersionId?: string } = {}, seen = new Set<string>();
  const visit = (v: AssetVersion) => {
    if (seen.has(v.id)) return;
    seen.add(v.id);
    const producer = workspace.tasks.find(t => t.objectId === v.objectId && t.outputVersionIds.includes(v.id));
    if (producer && ['T01','T02'].includes(producer.taskId)) result.uvVersionId ??= v.id;
    if (producer && ['T03','T05'].includes(producer.taskId)) result.textureVersionId ??= v.id;
    for (const id of v.sourceVersionIds) { const source = workspace.versions.find(s => s.id === id && s.objectId === v.objectId && s.slot === v.slot); if (source) visit(source); }
  };
  visit(version); return result;
}

/** A navigation suggestion only; calling this never accepts a result or modifies the draft. */
export function nextAfterAccept(workspace: GraphicsWorkspace, objectId: string, draft: CreationSpec, version: AssetVersion): JourneyTarget {
  const partId = version.slot.startsWith('part-') ? version.slot.slice(5) : undefined;
  const enabled = (stage: 'rig' | 'animation') => journeyMotionEnabled(draft,stage);
  if (version.role === 'design') return {stage:'model',partId};
  if (version.role === 'motion-reference') return {stage:'animation',clipName:version.slot};
  if (version.role === 'animation') return {stage:'unity'};
  if (version.role === 'rig') return {stage:enabled('animation') ? 'animation' : 'unity'};
  if (['model','material'].includes(version.role)) {
    const surface = journeySurfaceCapabilities(workspace,version);
    if (!surface.textureVersionId) return {stage:'surface',partId};
    if (draft.attributes.composition === 'parts' && partId) {
      const object=workspace.objects.find(o=>o.id===objectId);
      const next=draft.parts.filter(p=>p.enabled && p.id!==partId).find(p=>{
        const id=object?.accepted[`model:part-${p.id}`];
        const model=workspace.versions.find(v=>v.id===id);
        return !model || !journeySurfaceCapabilities(workspace,model).textureVersionId;
      });
      if(next) return {stage:object?.accepted[`model:part-${next.id}`]?'surface':'model',partId:next.id};
      return {stage:'assembly'};
    }
    return {stage:enabled('rig')?'rig':'unity'};
  }
  return {stage:'unity'};
}

/** Guidance only. The coordinator remains the authority for validation, preparation and atomic adoption. */
export function deriveJourney(workspace: GraphicsWorkspace, objectId: string, draft: CreationSpec, focus: JourneyFocus): GraphicsJourney {
  if(draft.attributes.composition==='parts') {
    const part=creationPartForTask({...draft,activePartId:focus.partId ?? draft.activePartId},focus.taskOverride || creationTaskId(draft,focus.stage));
    focus={...focus,partId:part?.id};
  }
  const object = workspace.objects.find(item => item.id === objectId);
  const versions = workspace.versions.filter(item => item.objectId === objectId);
  const byId = new Map(versions.map(item => [item.id, item]));
  const acceptedInputs = Object.entries(object?.accepted ?? {}).map(([key, versionId]) => ({ key, versionId, version: byId.get(versionId) }));
  const accepted = (key: string) => {
    const version=acceptedInputs.find(item => item.key === key)?.version, separator=key.indexOf(':');
    return version?.role===key.slice(0,separator) && version.slot===key.slice(separator+1) ? version : undefined;
  };
  const tasks = workspace.tasks.filter(item => item.objectId === objectId);
  const newest = (items: GraphicsTask[]) => [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.updatedAt.localeCompare(a.updatedAt))[0];
  const scoped = tasks.filter(item => (item.taskId!=='LOCAL_PLANAR_INSPECT'||focus.taskOverride==='LOCAL_PLANAR_INSPECT'||focus.taskId===item.id) && stageForTask(item.taskId) === focus.stage && (!focus.taskOverride || item.taskId===focus.taskOverride) && (!focus.partId || item.settings.partId === focus.partId || item.inputVersionIds.some(id=>byId.get(id)?.slot===`part-${focus.partId}`)) && (!focus.clipName || item.settings.clipName === focus.clipName));
  const task = (focus.taskId ? tasks.find(item => item.id === focus.taskId) : undefined) ?? newest(scoped);
  const active = newest(tasks.filter(item => ['running', 'awaiting_approval', 'submission_unknown'].includes(item.status)));
  const selectedTask = active ?? task;
  const matchesPart = (v: AssetVersion | undefined): v is AssetVersion => !!v && (!focus.partId || v.slot === `part-${focus.partId}`) &&
    (focus.stage === 'design' ? v.role === 'design' : ['model','surface','assembly'].includes(focus.stage) ? ['model','material'].includes(v.role) : focus.stage === 'animation' ? ['animation','motion-reference'].includes(v.role) : focus.stage === 'rig' ? v.role === 'rig' : v.role === 'unity');
  const candidate = task?.taskId==='LOCAL_PLANAR_INSPECT'?undefined:focus.candidateVersionId ? [byId.get(focus.candidateVersionId)].find(matchesPart) :
    (task?.outputVersionIds.map(id => byId.get(id)).find(matchesPart) ??
      newest(scoped.filter(item => item.status === 'review'))?.outputVersionIds.map(id => byId.get(id)).find(matchesPart));
  const compatibilityIssues = object ? getGraphicsCompatibility(object, workspace.versions) : ['오브젝트를 선택하세요.'];
  const descendsFromSurface = (version: AssetVersion): boolean => !!journeySurfaceCapabilities(workspace,version).textureVersionId;
  const parts: JourneyPart[] = draft.attributes.composition === 'parts' ? draft.parts.filter(p => p.enabled).map(p => {
    const model = accepted(`model:part-${p.id}`), design = accepted(`design:part-${p.id}`);
    const material = accepted(`material:part-${p.id}`);
    const surface = (material && model && material.sourceVersionIds.includes(model.id) && descendsFromSurface(material) ? material : undefined) ?? (model && descendsFromSurface(model) ? model : undefined);
    const capabilities = model ? journeySurfaceCapabilities(workspace,model) : {};
    return { id: p.id, label: p.label, modelVersionId: model?.id, designVersionId: design?.id, surfaceVersionId: surface?.id, ...capabilities,
      status: !model ? 'missing' : surface ? 'complete' : 'ready', reason: !model ? '채택한 파트 모델이 필요합니다.' : surface ? '채택한 파트의 재질 작업 이력이 있습니다.' : '채택한 파트로 UV·재질을 준비할 수 있습니다.' };
  }) : [];
  const model = accepted('model:main'), rig = accepted('rig:main');
  const delivery = [...workspace.deliveries].filter(item => item.objectId === objectId).sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0];
  const deliveryInputs=getJourneyReadiness(workspace,objectId,draft,{stage:'unity',taskOverride:'X05'}).inputs;
  const enabled = (stage: 'rig' | 'animation') => draft.stageSettings[stage]?.values.enabled ?? (journeyMotionEnabled(draft,stage) ||
    !!accepted(stage === 'rig' ? 'rig:main' : `animation:${focus.clipName ?? 'Idle'}`));
  const stages: JourneyStage[] = creationStages.map(stage => {
    const optional = ['rig', 'animation', 'assembly'].includes(stage.id);
    const done = stage.id === 'design' ? !!accepted('design:main') || !!parts.length && parts.every(p => p.designVersionId) :
      stage.id === 'model' ? !!model || !!parts.length && parts.every(p => p.modelVersionId) :
      stage.id === 'surface' ? !!parts.length ? parts.every(p => p.surfaceVersionId) : !!model && (descendsFromSurface(model) || !!accepted('material:main') && accepted('material:main')!.sourceVersionIds.includes(model.id) && descendsFromSurface(accepted('material:main')!)) :
      stage.id === 'assembly' ? tasks.some(t => t.taskId === 'M08' && t.outputVersionIds.includes(model?.id ?? '')) :
      stage.id === 'rig' ? !!rig : stage.id === 'animation' ? !!accepted(`animation:${focus.clipName ?? 'Idle'}`) : delivery?.status === 'imported' && !!deliveryInputs.length && deliveryInputs.every(input=>!!input.version && delivery.versionIds.includes(input.versionId)) && (!workspace.target || workspace.target.fingerprint === delivery.profileFingerprint);
    const skipped = (stage.id === 'rig' || stage.id === 'animation') && !enabled(stage.id) || stage.id === 'design' && !accepted('design:main') && !!model;
    return { ...stage, optional, status: skipped ? 'skipped' : done ? 'complete' : 'missing', reason: skipped ? '정적 오브젝트는 생략할 수 있습니다.' : done ? '채택한 결과가 있습니다.' : stage.id === 'unity' && delivery?.files.length ? '파일이 준비되었습니다. Unity 가져오기 완료는 아직 확인되지 않았습니다.' : '이 단계의 결과를 준비하세요.' };
  });
  const target = { stage: focus.stage, partId: focus.partId, clipName: focus.clipName };
  const action = (intent: JourneyAction['intent'], label: string, reason: string, extra: Partial<JourneyAction['target']> = {}): JourneyAction => ({ intent, label, reason, target: { ...target, ...extra } });
  let primaryAction = action('prepare', '이 단계 준비', '실행 전에 입력과 예상 비용을 확인합니다.');
  const secondaryActions: JourneyAction[] = [];
  let review: GraphicsJourney['review'];
  if (candidate) {
    const isAccepted = acceptedInputs.some(item => item.versionId === candidate.id);
    const needsRestore = requiresPartSpaceRestoration(workspace, candidate) || requiresPartSourcePreparation(workspace, candidate);
    const adoptable = !candidate.contact || candidate.contact.status === 'repaired';
    review = { version: candidate, accepted: isAccepted, adoptable: adoptable && !needsRestore, reason: needsRestore ? '원본 좌표·편집용 파일 복원이 먼저 필요합니다.' : !adoptable ? '접합 진단은 채택할 모델이 아닙니다.' : isAccepted ? '현재 채택한 결과입니다.' : '결과를 확인한 후 채택하세요.' };
    primaryAction = isAccepted ? action('navigate', '다음 단계 보기', review.reason, nextAfterAccept(workspace,objectId,draft,candidate)) :
      needsRestore ? action('recover', '원본 기준으로 복원', review.reason, { versionId: candidate.id }) :
      action('review', '결과 확인', review.reason, { versionId: candidate.id });
    if (review.adoptable && !isAccepted) secondaryActions.push(action('accept', candidate.contact ? '조립과 파트 채택' : '이 결과 채택', '확인한 결과만 명시적으로 채택합니다.', { versionId: candidate.id }));
  }
  const readiness=getJourneyReadiness(workspace,objectId,draft,focus);
  if (!candidate && readiness.problems.length) primaryAction=action('navigate','입력 확인',readiness.problems[0].reason,readiness.problems[0].target);
  if (selectedTask && ['running', 'awaiting_approval', 'submission_unknown'].includes(selectedTask.status)) {
    secondaryActions.length = 0;
    const stage = stageForTask(selectedTask.taskId), extra = { stage, taskId: selectedTask.id };
    if (selectedTask.status === 'submission_unknown') primaryAction = action('review', '제출 상태 확인', '제출 여부가 불확실합니다. 같은 작업을 다시 실행하지 마세요.', extra);
    else if (selectedTask.runtimeApproval) primaryAction = action('approve', '실행 중 요청 확인', '작업 도구의 권한·질문에 답변이 필요합니다.', extra);
    else if (selectedTask.status === 'awaiting_approval') primaryAction = action('approve', '입력과 비용 확인', '준비된 작업의 정확한 입력과 비용을 확인한 후 실행을 승인하세요.', extra);
    else primaryAction = selectedTask.taskId === 'LOCAL_PLANAR_INSPECT'
      ? action('review', '검사 진행 상황', '모델의 열린 부분을 로컬에서 검사합니다. 추가 서비스 비용·제작용 GPT 사용은 없습니다.', extra)
      : selectedTask.taskId === 'X05'
      ? workspace.deliveries.some(delivery => delivery.id === selectedTask.deliveryId && delivery.objectId === objectId && delivery.status === 'queued')
        ? action('review', 'Unity 가져오기 대기', '전달 파일은 준비됐습니다. 연결된 Unity Editor가 요청을 처리하면 결과를 표시합니다. Play Mode는 실행하지 않습니다.', extra)
        : action('review', 'Unity 전달 준비 상황', '선택한 원본을 검사하고 Unity 전달 파일을 준비합니다.', extra)
      : action('review', '진행 상황 보기', '현재 작업이 진행 중입니다.', extra);
    if (selectedTask.status !== 'submission_unknown') secondaryActions.push(action('stop', '작업 중단', '현재 작업의 중단을 요청합니다.', extra));
    const row = stages.find(s => s.id === stage)!;
    row.status = selectedTask.status === 'submission_unknown' ? 'blocked' : selectedTask.runtimeApproval || selectedTask.status === 'awaiting_approval' ? 'approval' : 'running'; row.reason = primaryAction.reason;
  } else if(task?.taskId==='LOCAL_PLANAR_INSPECT') {
    primaryAction=action('review','경계 검사 기록 확인','검사는 채택할 모델을 만들지 않습니다. 원본 모델의 경계 검사 화면에서 결과를 확인하세요.',{stage:'model',taskId:task.id});
    secondaryActions.length=0;
  } else if (task && ['failed', 'cancelled'].includes(task.status) && !candidate) primaryAction = action('review', '작업 기록 확인', '실패·취소 기록을 확인하세요. 자동으로 다시 실행하지 않습니다.', { taskId: task.id });
  if (review && !active) { const row = stages.find(s => s.id === focus.stage)!; if (!review.accepted) { row.status = review.adoptable ? 'review' : 'blocked'; row.reason = review.reason; } }
  if (!active && !candidate && primaryAction.intent === 'prepare') primaryAction.target.taskId = focus.taskOverride || creationTaskId(draft, focus.stage);
  const readinessProblems = readiness.problems;
  const nextPart = parts.find(p => !p.modelVersionId || !p.surfaceVersionId);
  const suggestedNext: JourneyTarget = candidate ? nextAfterAccept(workspace,objectId,draft,candidate) : nextPart ? { stage: nextPart.modelVersionId ? 'surface' : 'model', partId: nextPart.id } : model ? nextAfterAccept(workspace,objectId,draft,model) : {stage:accepted('design:main')?'model':'design'};
  if (!active && model && !enabled('rig') && !compatibilityIssues.length && focus.stage !== 'unity') secondaryActions.push(action('navigate','Unity 전달 준비','채택한 모델을 그대로 전달할 수 있습니다.',{stage:'unity',partId:undefined,versionId:undefined}));
  const inputReadiness:JourneyReadiness=active ? {inputs:active.inputVersionIds.map(versionId=>{
    const version=workspace.versions.find(v=>v.id===versionId);
    return {key:version?`${version.role}:${version.slot}`:`task-input:${versionId}`,versionId,version};
  }),problems:[]} : readiness;
  return { stages, acceptedInputs, parts, task: selectedTask, review, primaryAction, secondaryActions, compatibilityIssues, delivery, suggestedNext, readinessProblems, inputReadiness };
}
