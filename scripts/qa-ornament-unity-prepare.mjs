/** Read-only preparation. Does not launch Unity, install QA, import, or edit project assets. */
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const output=path.resolve(process.argv[2]??'artifacts/runtime/qa-20261018-ornament-unity-independent');
const project='C:/Users/김민준/AppData/Local/Temp/ps-auto-rig-start-AKe48j/UnityButtons';
const sourceRoot='C:/Users/김민준/AppData/Local/Temp/ps-parts-keep-DHeBDM/profile/projects/4d67883e-f2d8-4e05-a038-d0f3c7d979a7';
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const workspacePath=path.join(sourceRoot,'graphics/workspace.json'),workspace=JSON.parse(fs.readFileSync(workspacePath));
const app=JSON.parse(fs.readFileSync('artifacts/runtime/qa-20261018-multipart-ornament-app/correction-after-preview-fix.json'));
const fbxHash='b01e583a88cfa91cdcbab7102e012470468963f6ac5d81e29e9be9c903addedd';
const candidates=workspace.versions.filter(v=>v.autoRig?.exportFbx.sha256===fbxHash);assert.equal(candidates.length,1);const candidate=candidates[0];
const run=workspace.autoRigRuns.find(r=>r.id===candidate.autoRig.runId);assert.equal(run.state,'review');assert.equal(run.operation,'repair');
assert.equal(run.id,'85777673-01a7-4e72-b0b7-b07fdeb5feff');assert.equal(run.repairs.length,4);
const files=candidate.files.map(file=>{const absolute=path.join(sourceRoot,file.path);assert.equal(hash(absolute),file.sha256);return {...file,absolute};});
const proposed=JSON.parse(fs.readFileSync('artifacts/runtime/qa-20261018-multipart-ornament-app/proposed-selection.json'));
assert.deepEqual(run.repairs,proposed.repairs.map(({vertexIndices,...r})=>r));
const sourceCandidate=workspace.versions.find(v=>v.id===run.sourceVersionId);assert.equal(sourceCandidate.id,proposed.candidateVersionId);
const baseline={};
function scan(folder){for(const entry of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);assert(!entry.isSymbolicLink());if(entry.isDirectory())scan(file);else baseline[path.relative(project,file).replaceAll('\\','/')]={sha256:hash(file),bytes:fs.statSync(file).size};}}
for(const folder of ['Assets','Packages','ProjectSettings'])scan(path.join(project,folder));
const qaSource=path.join(project,'Assets/PartsmithQaMultipart20261018/Editor/QaMultipartLive20261018.cs');
const outputReport=path.join(output,'live.json').replaceAll('\\','/');
const template=fs.readFileSync(qaSource,'utf8').replaceAll('QaMultipartLive20261018','QaOrnamentCorrected20261018').replace(/const string Output="[^"]+";/,'const string Output='+JSON.stringify(outputReport)+';');
assert(template.includes(outputReport));
const spec={schemaVersion:1,stage:'PREPARED_ONLY_NOT_EXECUTED',project,sourceRoot,candidateId:candidate.id,runId:run.id,sourceCandidateId:sourceCandidate.id,sourceFiles:files,sourceOriginalFiles:sourceCandidate.files,workspaceShaAtPreparation:hash(workspacePath),exactFbxSha256:fbxHash,partPolicy:candidate.autoRig.partPolicy,humanBones:candidate.autoRig.contract.humanBones,repairs:proposed.repairs,expectedSelectedVertices:72,expectedDestination:'Assets/PartsmithGraphics/parts-copy',baseline,
 checks:['Receipt must name exact candidate/target and imported state; no automatic retry.','Delivered Asset.fbx SHA must equal frozen corrected native FBX.','Avatar valid/human and exact52 mapping; exactly3 expected skins/part identities.','All render rows weighted/finite/normalized; UV0 finite and nondegenerate at existing1e-12 area threshold.','Rest matching within existing1e-5 source units; coordinate mapping [x,z,y] as previous actual proof, no new axis search.','Match all72 native selected indices through exact position AND part/mesh identity; reject ambiguous differently weighted matches. Removed thumb names must have zero positive influence on every corresponding Unity render row.','Hair all rows head.x1 within existing1e-6; report actual importer pruning/mass/weight deltas separately, never exact weight claim.','Original protected files outside approved Generated asset replacement exact; Generated meta GUID/user prefab/scene refs preserved.','QualitySettings exact (restore only verified startup reserialize with root authorization); Play false; no retarget/full posed equivalence claim.'],
 execution:{unityLaunched:false,projectWrites:false,requiresRootReceiptAndPermission:true,newQaRelativePath:'Assets/PartsmithQaOrnamentCorrected20261018/Editor/QaOrnamentCorrected20261018.cs',qaScriptSha256:createHash('sha256').update(template).digest('hex')},previousEvidence:'artifacts/runtime/qa-20261018-parts-rig-unity-independent',appEvidence:'artifacts/runtime/qa-20261018-multipart-ornament-app/correction-after-preview-fix.json'};
fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'QaOrnamentCorrected20261018.cs'),template,{flag:'wx'});fs.writeFileSync(path.join(output,'spec.json'),JSON.stringify(spec,null,2),{flag:'wx'});
assert.equal(hash(workspacePath),spec.workspaceShaAtPreparation);console.log(JSON.stringify({stage:spec.stage,candidateId:candidate.id,protectedFiles:Object.keys(baseline).length,expectedSelectedVertices:72,output}));
