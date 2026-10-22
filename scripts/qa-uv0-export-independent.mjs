/** Read-only independent native audit of the two exact app-produced UV0 exports. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const original=read('artifacts/runtime/qa-20261018-local-chest-chain-independent/manifest.json');
const app=read('artifacts/runtime/qa-20261018-uv0-export-app/report.json');
assert(app.glb&&app.both,'Both explicit app exports must finish before native inspection');
assert.equal(app.glb.task.status,'review');assert.equal(app.both.task.status,'review');
for(const run of [app.glb,app.both])assert.deepEqual(run.task.inputVersionIds,[app.sourceVersionId]);
// The first audit stopped before opening a model: its old whole-workspace hash
// necessarily changed after the two explicit app exports. Preserve that failure.
const output=path.resolve(process.argv[2]??'artifacts/runtime/qa-20261018-uv0-export-independent-v2');
assert(!fs.existsSync(output),'Preserve the earlier audit; do not automatically repeat native work');
fs.mkdirSync(output,{recursive:true});
const entry=(run,ext,label)=>{const file=run.files.find(f=>f.path.endsWith('.'+ext));assert(file);assert.equal(sha(file.absolute),file.sha256);return{label,path:file.absolute,sha256:file.sha256};};
const extra=[entry(app.both,'blend','export'),entry(app.both,'fbx','export_fbx'),entry(app.both,'glb','export_glb'),entry(app.glb,'blend','glb_only_native'),entry(app.glb,'glb','glb_only')];
const workspacePath=path.join(app.profile,'projects',app.projectId,'graphics/workspace.json');
const workspace=read(workspacePath);
for(const key of ['objects','versions','tasks','deliveries','planarInspections']){
 const old=app.originalWorkspace[key];if(!old)continue;
 if(Array.isArray(old))for(const row of old)assert.deepEqual(workspace[key].find(item=>item.id===row.id),row);
 else for(const [id,row] of Object.entries(old))assert.deepEqual(workspace[key][id],row);
}
const protectedFiles=original.protectedFiles.map(file=>path.resolve(file.path)===path.resolve(workspacePath)
 ? {...file,sha256:sha(workspacePath),reason:'Current workspace snapshot after explicitly created exports; all prior records independently checked above.'}:file);
const q={...original,output,snapshotOnly:true,nativeAccounting:{rootProcesses:1,preflightOnlyAborted:0,readOnlyBatchWithSnapshots:1,newProcessesInThisAnalysis:0},entries:[...original.entries.filter(x=>['candidate1','candidate2','uv','material'].includes(x.label)),...extra],
 protectedFiles:[...protectedFiles,...extra],extraNativeExports:['glb_only_native'],exportLabels:['export_fbx','export_glb','glb_only'],
 lineage:{prior:original.lineage,source:app.sourceVersionId,both:app.both.result.id,glb:app.glb.result.id},
 limitations:['Read-only static geometry/UV/material export check. No Unity import, rig, animation or user appearance acceptance.']};
const manifest=path.join(output,'manifest.json');fs.writeFileSync(manifest,JSON.stringify(q,null,2));
const blender='C:/Program Files/Blender Foundation/Blender 5.0/blender.exe';
const r=spawnSync(blender,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',path.resolve('scripts/qa-static-box-independent.py'),'--',manifest],{windowsHide:true,encoding:'utf8',timeout:120000,maxBuffer:4000000});
fs.writeFileSync(path.join(output,'blender.log'),r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);
const analysis=spawnSync(process.execPath,['scripts/qa-uv0-double-audit.cjs',output],{encoding:'utf8',timeout:30000,maxBuffer:4000000});
fs.writeFileSync(path.join(output,'analysis.log'),analysis.stdout+analysis.stderr);assert.equal(analysis.status,0,analysis.stdout+analysis.stderr);
const result=read(path.join(output,'double-audit.json'));assert.equal(result.status,'PASS_DOUBLE_PRECISION_RAW_ANALYSIS');
for(const file of q.protectedFiles)assert.equal(sha(file.path),file.sha256);
const compact={status:result.status,checks:result.nativeChecks,tolerance:result.tolerance,transport:result.transport,lineage:q.lineage,protectedFiles:q.protectedFiles.length,allSHAExact:true,paidSubmissions:0,productionGPT:0,arpAI:0,nativeRuns:1};
fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(compact,null,2));console.log(JSON.stringify(compact));
