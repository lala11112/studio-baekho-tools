import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveJourney, nextAfterAccept, journeySurfaceCapabilities, getJourneyReadiness } from '../shared/graphics-journey';
import { defaultCreation } from '../shared/graphics-creation';
import type { AssetVersion, GraphicsTask, GraphicsWorkspace } from '../shared/graphics';
import {stageForTask} from '../shared/graphics-creation';
import {findGraphicsTask,graphicsAstraTasks} from '../shared/graphics-catalog';

const version = (id: string, slot = 'main'): AssetVersion => ({ id, objectId: 'o', role: 'model', slot, label: id, createdAt: id, files: [], sourceVersionIds: [], provenance: { type: 'local' }, warnings: [] });
const task = (id: string, status: GraphicsTask['status'], outputVersionIds: string[] = []): GraphicsTask => ({ id, objectId: 'o', taskId: 'T03', createdAt: id, updatedAt: id, status, outputVersionIds, inputVersionIds: ['a'], settings: {}, instruction: '', requestHash: id, backendJobIds: [], message: '', localOnly: false });
const setup = () => {
  const draft = defaultCreation('prop');
  const workspace: GraphicsWorkspace = { schemaVersion: 1, id: 'w', projectId: 'p', revision: 1, objects: [{ id: 'o', name: 'Box', kind: 'prop', createdAt: '', selectedTasks: [], instruction: '', settings: {}, references: [], accepted: { 'model:main': 'a' } }], versions: [version('a'), version('b')], tasks: [], deliveries: [] };
  return { workspace, draft };
};
test('local planar repair resumes as a model review despite newer report-only inspection',()=>{
 const {workspace,draft}=setup();workspace.tasks=[{...task('1','review',['b']),taskId:'LOCAL_PLANAR_REPAIR',localOnly:true},{...task('2','review',[]),taskId:'LOCAL_PLANAR_INSPECT',localOnly:true}];
 const before=structuredClone(workspace),j=deriveJourney(workspace,'o',draft,{stage:'model'});
 assert.equal(j.task?.taskId,'LOCAL_PLANAR_REPAIR');assert.equal(j.review?.version.id,'b');assert(j.secondaryActions.some(a=>a.intent==='accept'));assert.equal(stageForTask('LOCAL_PLANAR_REPAIR'),'model');assert.equal(findGraphicsTask('LOCAL_PLANAR_REPAIR')?.executor,'local');assert.equal(graphicsAstraTasks.has('LOCAL_PLANAR_REPAIR'),false);assert.deepEqual(workspace,before);
 const inspection=deriveJourney(workspace,'o',draft,{stage:'model',taskId:'2',taskOverride:'LOCAL_PLANAR_INSPECT'});assert.equal(inspection.review,undefined);assert.equal(inspection.primaryAction.intent,'review');assert(!inspection.secondaryActions.some(a=>a.intent==='accept'));assert.equal(stageForTask('LOCAL_PLANAR_INSPECT'),'model');
});
test('adopted static planar repair continues to surface or reuses textured ancestry for Unity without generation',()=>{
 const {workspace,draft}=setup(),repair=workspace.versions[1];repair.sourceVersionIds=['a'];repair.planarRepair={schemaVersion:1,versionId:'a',inspectionId:'inspect1',meshId:'m1',selectedBoundaryIds:['b1'],keptBoundaryIds:[],materialPolicy:'preserve',sourceSha256:'f'.repeat(64),identity:'local',algorithmVersion:'planar-v1',reportPath:'report.json'};
 workspace.objects[0].accepted['model:main']='b';workspace.tasks=[{...task('1','review',['b']),taskId:'LOCAL_PLANAR_REPAIR',localOnly:true}];
 assert.equal(nextAfterAccept(workspace,'o',draft,repair).stage,'surface');workspace.tasks.push({...task('0','review',['a']),taskId:'T03'});assert.equal(nextAfterAccept(workspace,'o',draft,repair).stage,'unity');
 const guide=deriveJourney(workspace,'o',draft,{stage:'model'});assert.equal(guide.primaryAction.intent,'navigate');assert.equal(guide.primaryAction.target.stage,'unity');assert(!guide.secondaryActions.some(a=>a.intent==='prepare'));assert.equal(findGraphicsTask(guide.task!.taskId)?.executor,'local');
});
test('preview selection never changes accepted inputs or saved state; static route skips motion', () => {
  const {workspace,draft} = setup(), before = structuredClone({workspace,draft});
  const journey = deriveJourney(workspace,'o',draft,{stage:'surface',candidateVersionId:'b'});
  assert.equal(journey.acceptedInputs[0].versionId,'a');
  assert.equal(journey.review?.version.id,'b');
  assert.equal(journey.primaryAction.intent,'review');
  assert.equal(journey.secondaryActions[0].intent,'accept');
  assert.equal(journey.stages.find(s=>s.id==='rig')?.status,'skipped');
  assert.deepEqual({workspace,draft},before);
});
test('uncertain submission is inspection only, even with older review result', () => {
  const {workspace,draft} = setup(); workspace.tasks=[task('1','review',['b']),task('2','submission_unknown')];
  const journey=deriveJourney(workspace,'o',draft,{stage:'surface'});
  assert.equal(journey.primaryAction.intent,'review');
  assert.equal(journey.primaryAction.target.taskId,'2');
  assert.ok(!journey.secondaryActions.some(a=>['prepare','approve','recover','stop'].includes(a.intent)));
  assert.match(journey.primaryAction.reason,/다시 실행하지/);
});
test('cancelled latest attempt preserves completed predecessor review choice',()=>{
  const {workspace,draft}=setup(); workspace.tasks=[task('1','review',['b']),task('2','cancelled')];
  const j=deriveJourney(workspace,'o',draft,{stage:'surface'});
  assert.equal(j.task?.id,'2'); assert.equal(j.review?.version.id,'b'); assert.equal(j.primaryAction.intent,'review');
});
test('cost approval and running tool permission are distinguishable',()=>{
  const {workspace,draft}=setup(); workspace.tasks=[task('2','awaiting_approval')];
  let j=deriveJourney(workspace,'o',draft,{stage:'surface'}); assert.equal(j.primaryAction.intent,'approve'); assert.match(j.primaryAction.label,/비용/);
  workspace.tasks[0].status='running'; workspace.tasks[0].runtimeApproval={id:'approval',title:'Permission',requestedAt:'now',executionId:'run'} as GraphicsTask['runtimeApproval'];
  j=deriveJourney(workspace,'o',draft,{stage:'model'}); assert.equal(j.primaryAction.target.stage,'surface'); assert.match(j.primaryAction.label,/요청/);
});
test('blocked contact analysis cannot be adopted',()=>{
  const {workspace,draft}=setup(); workspace.versions[1].contact={schemaVersion:1,phase:'analyze',status:'blocked',sourceVersionId:'a',partVersionIds:[],reportPath:'report.json',views:[],warnings:[],allowedVertexCount:0};
  const j=deriveJourney(workspace,'o',draft,{stage:'assembly',candidateVersionId:'b'});
  assert.equal(j.review?.adoptable,false); assert.ok(!j.secondaryActions.some(a=>a.intent==='accept')); assert.equal(j.stages.find(s=>s.id==='assembly')?.status,'blocked');
});
test('part progress follows accepted lineage instead of latest unrelated surface task',()=>{
  const {workspace,draft}=setup(); draft.attributes.composition='parts'; draft.parts=[{id:'head',label:'Head',enabled:true,instruction:'',count:1,faceLimit:5000}];
  workspace.versions=[version('a','part-head'),version('b','part-head')]; workspace.objects[0].accepted={'model:part-head':'a'}; workspace.tasks=[task('1','review',['b'])];
  let j=deriveJourney(workspace,'o',draft,{stage:'surface',partId:'head'}); assert.equal(j.parts[0].surfaceVersionId,undefined);
  workspace.versions[0].sourceVersionIds=['b']; j=deriveJourney(workspace,'o',draft,{stage:'surface',partId:'head'}); assert.equal(j.parts[0].surfaceVersionId,'a');
});
test('delivery files do not prove Unity import; imported receipt does',()=>{
  const {workspace,draft}=setup(); workspace.deliveries=[{id:'d',objectId:'o',versionIds:['a'],profileFingerprint:'p',converterVersion:'1',createdAt:'now',destination:'out',status:'queued',files:[{path:'a.fbx',sha256:'x',bytes:1,kind:'fbx'}],warnings:[],errors:[],playbackVerified:false}];
  let j=deriveJourney(workspace,'o',draft,{stage:'unity'}); assert.equal(j.stages.find(s=>s.id==='unity')?.status,'missing'); assert.match(j.stages.find(s=>s.id==='unity')!.reason,/아직/);
  workspace.deliveries[0].status='imported'; j=deriveJourney(workspace,'o',draft,{stage:'unity'}); assert.equal(j.stages.find(s=>s.id==='unity')?.status,'complete');
});

test('file-only export ignores Unity receipts and unrelated accepted Unity output',()=>{
  const {workspace,draft}=setup();draft.stageSettings.unity!.values.deliveryMode='files';
  workspace.versions[0].files=[{path:'a.blend',kind:'blend',bytes:1,sha256:'a'.repeat(64)}];
  const unity={...version('old-unity'),role:'unity' as const};workspace.versions.push(unity);workspace.objects[0].accepted['unity:main']=unity.id;
  workspace.tasks=[{...task('old-x05','review',[unity.id]),taskId:'X05'}];
  workspace.deliveries=[{id:'old-receipt',objectId:'o',versionIds:['a'],profileFingerprint:'p',converterVersion:'1',createdAt:'now',destination:'out',status:'imported',files:[{path:'a.fbx',sha256:'x',bytes:1,kind:'fbx'}],warnings:[],errors:[],playbackVerified:false}];
  const before=structuredClone(workspace),j=deriveJourney(workspace,'o',draft,{stage:'unity',candidateVersionId:unity.id});
  assert.notEqual(j.stages.find(s=>s.id==='unity')?.status,'complete');assert.equal(j.delivery,undefined);assert.equal(j.review,undefined);assert.equal(j.task,undefined);
  assert.equal(j.primaryAction.intent,'prepare');assert.equal(j.primaryAction.target.taskId,'X04');assert.match(j.primaryAction.label,/내보내기/);
  assert.deepEqual(workspace,before);
  workspace.tasks.push({...task('active-x05','running'),taskId:'X05'});
  assert.equal(deriveJourney(workspace,'o',draft,{stage:'unity'}).task?.id,'active-x05');
});

test('file-only completed output requires exact frozen input/settings and reviews files without adoption',()=>{
  const {workspace,draft}=setup();draft.stageSettings.unity!.values.deliveryMode='files';
  for(const v of workspace.versions)v.files=[{path:v.id+'.blend',kind:'blend',bytes:1,sha256:'a'.repeat(64)}];
  const exported={...version('exported'),sourceVersionIds:['a'],provenance:{type:'local' as const,jobId:'export-task'},files:['blend','fbx','glb'].map(ext=>({path:'exported.'+ext,kind:ext,bytes:1,sha256:'b'.repeat(64)}))};workspace.versions.push(exported);
  workspace.tasks=[{...task('export-task','review',[exported.id]),taskId:'X04',settings:{exportFormat:'both',scale:1,pivot:'keep'}}];
  let j=deriveJourney(workspace,'o',draft,{stage:'unity'});
  assert.equal(j.stages.find(s=>s.id==='unity')?.status,'complete');assert.equal(j.review?.version.id,exported.id);assert.equal(j.review?.adoptable,false);
  assert.match(j.primaryAction.label,/내보낸 파일/);assert(!j.secondaryActions.some(a=>a.intent==='accept'));
  draft.stageSettings.unity!.values.exportFormat='glb';j=deriveJourney(workspace,'o',draft,{stage:'unity'});assert.notEqual(j.stages.find(s=>s.id==='unity')?.status,'complete');
  draft.stageSettings.unity!.values.exportFormat='both';workspace.objects[0].accepted['model:main']='b';j=deriveJourney(workspace,'o',draft,{stage:'unity'});assert.notEqual(j.stages.find(s=>s.id==='unity')?.status,'complete');
  workspace.objects[0].accepted['model:main']=exported.id;j=deriveJourney(workspace,'o',draft,{stage:'unity'});assert.equal(j.stages.find(s=>s.id==='unity')?.status,'complete');
});

test('auto-rig both completion accepts only the exact parent-bound diagnostic preview',()=>{
 const {workspace,draft}=setup();draft.stageSettings.unity!.values.deliveryMode='files';
 const source={...version('rig'),role:'rig' as const,files:['blend','fbx','glb'].map(ext=>({path:'source/asset.'+ext,kind:ext,bytes:120,sha256:ext.repeat(64).slice(0,64)})),autoRig:{schemaVersion:1,runId:'run',contract:{},reportFile:{},exportFbx:{}} as any};
 workspace.versions.push(source);workspace.objects[0].accepted['rig:main']=source.id;
 const derived={...version('copy'),role:'rig' as const,sourceVersionIds:[source.id],provenance:{type:'local' as const,jobId:'export-rig'},autoRig:{...source.autoRig,derivedFromVersionId:source.id},files:[...source.files.filter(f=>!f.path.endsWith('.glb')).map(f=>({...f,path:f.path.replace('source/','copy/')})),{...source.files[2],path:'copy/diagnostic.glb',kind:'preview'}]};
 workspace.versions.push(derived);workspace.tasks=[{...task('export-rig','review',[derived.id]),taskId:'X04',inputVersionIds:[source.id],settings:{exportFormat:'both',scale:1,pivot:'keep'}}];
 let j=deriveJourney(workspace,'o',draft,{stage:'unity'});assert.equal(j.stages.find(s=>s.id==='unity')?.status,'complete');
 derived.files[2].sha256='wrong';j=deriveJourney(workspace,'o',draft,{stage:'unity'});assert.notEqual(j.stages.find(s=>s.id==='unity')?.status,'complete');
 derived.files[2].sha256=source.files[2].sha256;derived.files[2].path='copy/arbitrary.glb';j=deriveJourney(workspace,'o',draft,{stage:'unity'});assert.notEqual(j.stages.find(s=>s.id==='unity')?.status,'complete');
});
test('UV acceptance leads to texture preparation, never marks full surface complete',()=>{
  const {workspace,draft}=setup(); workspace.tasks=[{...task('1','review',['a']),taskId:'T01'}];
  const j=deriveJourney(workspace,'o',draft,{stage:'surface'});
  assert.equal(j.primaryAction.intent,'navigate'); assert.equal(j.primaryAction.target.stage,'surface');
  assert.equal(j.stages.find(s=>s.id==='surface')?.status,'missing');
  assert.deepEqual(journeySurfaceCapabilities(workspace,workspace.versions[0]),{uvVersionId:'a'});
});
test('image model preparation and local/Astra routes require actual engine design input',()=>{
  const {workspace,draft}=setup(); workspace.objects[0].accepted={};
  let j=deriveJourney(workspace,'o',draft,{stage:'model'}); assert.equal(j.primaryAction.target.stage,'design'); assert.equal(j.readinessProblems.length,1);
  draft.stageSettings.model!.values.modelMethod='local';
  j=deriveJourney(workspace,'o',draft,{stage:'model'}); assert.equal(j.primaryAction.target.stage,'design');
  draft.stageSettings.model!.values.modelMethod='astra'; j=deriveJourney(workspace,'o',draft,{stage:'model'}); assert.equal(j.primaryAction.target.stage,'design');
});
test('imported model skips missing design and offers direct static delivery without retexture',()=>{
  const {workspace,draft}=setup(); workspace.versions[0].provenance.type='import';
  const j=deriveJourney(workspace,'o',draft,{stage:'surface'});
  assert.equal(j.stages.find(s=>s.id==='design')?.status,'skipped');
  assert.equal(j.suggestedNext?.stage,'surface');
  assert.ok(j.secondaryActions.some(a=>a.target.stage==='unity' && a.intent==='navigate'));
});
test('textured static result routes to Unity; rig and animation respect enabled controls',()=>{
  const {workspace,draft}=setup(); workspace.tasks=[task('1','review',['a'])];
  assert.equal(nextAfterAccept(workspace,'o',draft,workspace.versions[0]).stage,'unity');
  draft.stageSettings.rig!.values.enabled=true;
  assert.equal(nextAfterAccept(workspace,'o',draft,workspace.versions[0]).stage,'rig');
  const v={...version('rig'),role:'rig' as const};
  assert.equal(nextAfterAccept(workspace,'o',draft,v).stage,'unity');
  draft.stageSettings.animation!.values.enabled=true;
  assert.equal(nextAfterAccept(workspace,'o',draft,v).stage,'animation');
});
test('predecessor review never crosses active part and returns exact source IDs',()=>{
  const {workspace,draft}=setup(); workspace.versions=[version('a','part-head'),version('b','part-hair')]; workspace.objects[0].accepted={'model:part-head':'a'};
  workspace.tasks=[{...task('1','review',['b','a']),settings:{partId:'head'}},{...task('2','cancelled'),settings:{partId:'head'}}];
  const j=deriveJourney(workspace,'o',draft,{stage:'surface',partId:'head'});
  assert.equal(j.review?.version.id,'a'); assert.equal(j.acceptedInputs[0].versionId,'a');
});
test('shared readiness uses whole image for split generation and exact part model for texture',()=>{
  const {workspace,draft}=setup(); draft.attributes.composition='parts'; draft.attributes.compositionStrategy='whole-then-split'; draft.activePartId='head'; draft.parts=[{id:'head',label:'Head',enabled:true,instruction:'',count:1,faceLimit:5000}];
  const design={...version('image'),role:'design' as const}; workspace.versions.push(design,version('head','part-head')); workspace.objects[0].accepted={'design:main':'image','model:part-head':'head'};
  let r=getJourneyReadiness(workspace,'o',draft,{stage:'model',partId:'head'});
  assert.equal(r.inputs[0].versionId,'image'); assert.equal(r.problems.length,0);
  r=getJourneyReadiness(workspace,'o',draft,{stage:'surface',partId:'head'});
  assert.equal(r.inputs[0].versionId,'head'); assert.equal(r.problems[0].target.stage,'design');
  draft.stageSettings.surface!.values.textureReference='text';
  r=getJourneyReadiness(workspace,'o',draft,{stage:'surface',partId:'head'}); assert.equal(r.problems.length,0);
});
test('shared readiness rejects mismatched role or slot even when accepted key exists',()=>{
  const {workspace,draft}=setup(); workspace.objects[0].accepted['design:main']='a';
  const r=getJourneyReadiness(workspace,'o',draft,{stage:'model'});
  assert.equal(r.inputs[0].versionId,'a'); assert.equal(r.inputs[0].version,undefined); assert.equal(r.problems[0].target.stage,'design');
});
test('independent parts require their own image, not the whole or sibling image',()=>{
  const {workspace,draft}=setup(); draft.attributes.composition='parts'; draft.attributes.compositionStrategy='independent-parts'; draft.activePartId='head'; draft.parts=[{id:'head',label:'Head',enabled:true,instruction:'',count:1,faceLimit:5000}];
  workspace.versions.push({...version('image'),role:'design'}); workspace.objects[0].accepted={'design:main':'image'};
  let r=getJourneyReadiness(workspace,'o',draft,{stage:'model',partId:'head'}); assert.equal(r.problems[0].target.partId,'head');
  workspace.versions.push({...version('headimage','part-head'),role:'design'}); workspace.objects[0].accepted['design:part-head']='headimage';
  r=getJourneyReadiness(workspace,'o',draft,{stage:'model',partId:'head'}); assert.equal(r.problems.length,0); assert.equal(r.inputs[0].versionId,'headimage');
});
test('static rig choice enables motion stages and navigation without legacy enabled flags',()=>{
  const {workspace,draft}=setup(); draft.stageSettings.rig!.values.rigType='generic'; workspace.tasks=[task('1','review',['a'])];
  let j=deriveJourney(workspace,'o',draft,{stage:'surface'});
  assert.equal(nextAfterAccept(workspace,'o',draft,workspace.versions[0]).stage,'rig');
  assert.notEqual(j.stages.find(s=>s.id==='rig')?.status,'skipped');
  assert.notEqual(j.stages.find(s=>s.id==='animation')?.status,'skipped');
  assert.ok(!j.secondaryActions.some(a=>a.label==='Unity 전달 준비'));
  const rig={...version('rig'),role:'rig' as const};
  assert.equal(nextAfterAccept(workspace,'o',draft,rig).stage,'animation');
  draft.stageSettings.animation!.values.enabled=false;
  assert.equal(nextAfterAccept(workspace,'o',draft,rig).stage,'unity');
});
test('catalog task override uses its real inputs and avoids unrelated draft route blocks',()=>{
  const {workspace,draft}=setup(); workspace.objects[0].accepted={}; draft.stageSettings.model!.values.modelMethod='';
  let j=deriveJourney(workspace,'o',draft,{stage:'model',taskOverride:'M03'});
  assert.equal(j.inputReadiness.problems.length,0); assert.equal(j.primaryAction.intent,'prepare'); assert.equal(j.primaryAction.target.taskId,'M03');
  j=deriveJourney(workspace,'o',draft,{stage:'model',taskOverride:'M04'});
  assert.equal(j.inputReadiness.problems[0].target.stage,'design');
});
test('Unity input helper chooses rig and includes exact animation and separate material',()=>{
  const {workspace,draft}=setup(); workspace.versions.push({...version('rig'),role:'rig',sourceVersionIds:['a']},{...version('clip','Idle'),role:'animation',sourceVersionIds:['rig']},{...version('mat'),role:'material',sourceVersionIds:['a']});
  for (const v of workspace.versions) v.files = [{path:`${v.id}.blend`,kind:'blend',bytes:1,sha256:'f'.repeat(64)}];
  workspace.objects[0].accepted={'model:main':'a','rig:main':'rig','animation:Idle':'clip','material:main':'mat'};
  const r=getJourneyReadiness(workspace,'o',draft,{stage:'unity',taskOverride:'X05'});
  assert.deepEqual(r.inputs.map(i=>i.versionId),['rig','clip','mat']); assert.equal(r.problems.length,0);
});
test('assembly exact input helper uses matching accepted material and blocks stale material',()=>{
  const {workspace,draft}=setup(); draft.attributes.composition='parts'; draft.parts=['head','body'].map(id=>({id,label:id,enabled:true,instruction:'',count:1,faceLimit:5000}));
  workspace.versions=[version('head','part-head'),version('body','part-body'),{...version('mat','part-head'),role:'material',sourceVersionIds:['head']}];
  workspace.objects[0].accepted={'model:part-head':'head','model:part-body':'body','material:part-head':'mat'};
  let r=getJourneyReadiness(workspace,'o',draft,{stage:'assembly',taskOverride:'M08'});
  assert.deepEqual(r.inputs.map(i=>i.versionId),['mat','body']); assert.equal(r.problems.length,0);
  workspace.versions[2].sourceVersionIds=['old']; r=getJourneyReadiness(workspace,'o',draft,{stage:'assembly',taskOverride:'M08'});
  assert.match(r.problems[0].reason,/다른 형상/); assert.equal(r.problems[0].target.partId,'head');
});

test('completed separately accepted part materials guide to assembly and changing one model preserves other parts',()=>{
 const {workspace,draft}=setup();draft.attributes.composition='parts';draft.parts=[{id:'head',label:'Head',enabled:true,instruction:'',faceLimit:1000,count:1},{id:'body',label:'Body',enabled:true,instruction:'',faceLimit:1000,count:1}];
 const head=version('head-uv','part-head'),body=version('body-uv','part-body');
 const headMat={...version('head-material','part-head'),role:'material' as const,sourceVersionIds:[head.id]},bodyMat={...version('body-material','part-body'),role:'material' as const,sourceVersionIds:[body.id]};
 const headAdjusted={...headMat,id:'head-adjusted',sourceVersionIds:[headMat.id]};
 workspace.versions=[head,body,headMat,headAdjusted,bodyMat];workspace.objects[0].accepted={'model:part-head':head.id,'model:part-body':body.id,'material:part-head':headAdjusted.id,'material:part-body':bodyMat.id};
 workspace.tasks=[{...task('texture-head','review',[headMat.id]),taskId:'T03'},{...task('texture-body','review',[bodyMat.id]),taskId:'T03'}];
 const before=structuredClone(workspace);
 assert.deepEqual(getJourneyReadiness(workspace,'o',draft,{stage:'assembly',taskOverride:'M08'}).inputs.map(i=>i.versionId),[headAdjusted.id,bodyMat.id]);
 assert.deepEqual(nextAfterAccept(workspace,'o',draft,bodyMat),{stage:'assembly'});
 const j=deriveJourney(workspace,'o',draft,{stage:'surface',partId:'body',candidateVersionId:bodyMat.id});
 assert(j.parts.every(p=>p.status==='complete'));assert.equal(j.parts.find(p=>p.id==='head')?.textureVersionId,headMat.id);
 assert.deepEqual(workspace,before);
 const replacement=version('changed-head','part-head');workspace.versions.push(replacement);workspace.objects[0].accepted['model:part-head']=replacement.id;
 const changed=getJourneyReadiness(workspace,'o',draft,{stage:'assembly',taskOverride:'M08'});assert(changed.problems.some(p=>/다른 형상/.test(p.reason)));assert.equal(changed.inputs.find(i=>i.version?.slot==='part-body')?.versionId,bodyMat.id);
 assert.deepEqual(nextAfterAccept(workspace,'o',draft,bodyMat),{stage:'surface',partId:'head'});
 const stale=deriveJourney(workspace,'o',draft,{stage:'surface',partId:'body'});assert.equal(stale.parts.find(p=>p.id==='head')?.status,'blocked');assert.equal(stale.parts.find(p=>p.id==='body')?.status,'complete');assert.equal(stale.parts.find(p=>p.id==='head')?.textureVersionId,undefined);
});
test('part draft does not hide whole split-generation, assembly or rig results',()=>{
  const {workspace,draft}=setup(); draft.attributes.composition='parts'; draft.attributes.compositionStrategy='whole-then-split'; draft.activePartId='head'; draft.parts=[{id:'head',label:'Head',enabled:true,instruction:'',count:1,faceLimit:5000}];
  let j=deriveJourney(workspace,'o',draft,{stage:'model',partId:'head',taskOverride:'M01',candidateVersionId:'b'}); assert.equal(j.review?.version.id,'b');
  j=deriveJourney(workspace,'o',draft,{stage:'assembly',partId:'head',taskOverride:'M08',candidateVersionId:'b'}); assert.equal(j.review?.version.id,'b');
  workspace.versions.push({...version('rig'),role:'rig'});
  j=deriveJourney(workspace,'o',draft,{stage:'rig',partId:'head',candidateVersionId:'rig'}); assert.equal(j.review?.version.id,'rig');
});
test('Unity completion follows selected rig and all clips rather than demanding unused model input',()=>{
  const {workspace,draft}=setup(); workspace.versions.push({...version('rig'),role:'rig',sourceVersionIds:['a']},{...version('clip','Idle'),role:'animation',sourceVersionIds:['rig']});
  workspace.objects[0].accepted={'model:main':'a','rig:main':'rig','animation:Idle':'clip'};
  workspace.deliveries=[{id:'d',objectId:'o',versionIds:['rig','clip'],profileFingerprint:'p',converterVersion:'1',createdAt:'now',destination:'out',status:'imported',files:[],warnings:[],errors:[],playbackVerified:false}];
  let j=deriveJourney(workspace,'o',draft,{stage:'unity'}); assert.equal(j.stages.find(s=>s.id==='unity')?.status,'complete');
  workspace.deliveries[0].versionIds=['rig']; j=deriveJourney(workspace,'o',draft,{stage:'unity'}); assert.notEqual(j.stages.find(s=>s.id==='unity')?.status,'complete');
});
test('surface completion ignores a textured sibling only used as reference',()=>{
  const {workspace,draft}=setup(); workspace.versions[1].slot='part-hair'; workspace.versions[0].sourceVersionIds=['b']; workspace.tasks=[task('1','review',['b'])];
  const j=deriveJourney(workspace,'o',draft,{stage:'model'}); assert.equal(j.stages.find(s=>s.id==='surface')?.status,'missing');
});
test('motion reference adoption navigates to its exact clip',()=>{
  const {workspace,draft}=setup(); assert.deepEqual(nextAfterAccept(workspace,'o',draft,{...version('jump','Jump'),role:'motion-reference'}),{stage:'animation',clipName:'Jump'});
});
test('active task input display stays frozen when accepted inputs and draft change',()=>{
  const {workspace,draft}=setup(); workspace.tasks=[task('1','running')]; workspace.objects[0].accepted={'model:main':'b'};
  const j=deriveJourney(workspace,'o',draft,{stage:'unity'});
  assert.equal(j.acceptedInputs[0].versionId,'b'); assert.equal(j.inputReadiness.inputs[0].versionId,'a'); assert.equal(j.primaryAction.target.taskId,'1');
});
