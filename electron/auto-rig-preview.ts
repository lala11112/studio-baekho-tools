import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {GraphicsFile, GraphicsWorkspace} from '../shared/graphics';
import {inspectSavedGraphicsAutoRig} from '../engine/graphics-auto-rig';

const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
/** Only a completed, exact-source inspection's verified GLB may supplement version assets. */
export function autoRigInspectionPreviewAllowed(projectRoot:string, workspace:GraphicsWorkspace, requested:string):boolean{
 try{
  const root=fs.realpathSync(projectRoot),wanted=path.resolve(requested);
  const safe=(relative:string)=>{
   if(path.isAbsolute(relative))throw Error('Absolute inspection path');
   const full=path.resolve(root,relative),rel=path.relative(root,full);
   if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('Inspection path escaped');
   let at=root;for(const part of rel.split(path.sep)){at=path.join(at,part);if(fs.lstatSync(at).isSymbolicLink())throw Error('Linked inspection path');}
   if(!fs.realpathSync(full).startsWith(root+path.sep))throw Error('Resolved inspection path escaped');return full;
  };
  const verify=(file:GraphicsFile)=>{const full=safe(file.path),stat=fs.statSync(full);if(!stat.isFile()||stat.size!==file.bytes||hash(fs.readFileSync(full))!==file.sha256)throw Error('Inspection bytes changed');return full;};
  for(const run of workspace.autoRigRuns??[]){
   if(run.operation!=='inspect'||run.state!=='review'||!run.reportFile||!run.inspection||!/^[a-zA-Z0-9_-]{1,100}$/.test(run.id))continue;
   const glbs=run.files.filter(file=>/\.glb$/i.test(file.path));if(glbs.length!==1||path.resolve(root,glbs[0].path)!==wanted)continue;
   const version=workspace.versions.find(v=>v.id===run.sourceVersionId&&v.objectId===run.objectId&&v.role==='rig');
   if(!version?.files.some(file=>JSON.stringify(file)===JSON.stringify(run.source)))return false;
   const fingerprint=hash(JSON.stringify({objectId:run.objectId,sourceVersionId:run.sourceVersionId,source:run.source,operation:run.operation,settings:run.settings,repairs:run.repairs,inspectionRunId:run.inspectionRunId,toolSha256:run.toolSha256,...(run.partPolicy?{partPolicy:run.partPolicy}:{}),...(run.toolDependencies?{toolDependencies:run.toolDependencies}:{})}));
   if(run.requestHash!==fingerprint)return false;
   verify(run.source);verify(run.reportFile);for(const file of run.files)verify(file);
   const folder=path.join('graphics','auto-rig',run.id);
   for(const name of ['dispatch.json','request.json','worker.py','source.blend','output/run-report.json'])safe(path.join(folder,name));
   const request=JSON.parse(fs.readFileSync(safe(path.join(folder,'request.json')),'utf8'));
   if(request.sourceBlend!==path.join(root,folder,'source.blend')||request.sourceSha256!==run.source.sha256||request.operation!=='inspect'||request.fingers!==run.settings.fingers||JSON.stringify(request.repairs)!==JSON.stringify(run.repairs)||request.sourceToRigMatrix!==undefined||JSON.stringify(request.partPolicy)!==JSON.stringify(run.partPolicy)||JSON.stringify(request.workerResources)!==JSON.stringify(run.toolDependencies))return false;
   const saved=inspectSavedGraphicsAutoRig(path.join(root,folder));
   if(run.toolSha256!==undefined&&saved.toolSha256!==run.toolSha256)return false;
   if(saved.reportPath!==verify(run.reportFile)||saved.glbPath!==wanted||JSON.stringify(saved.report.inspection)!==JSON.stringify(run.inspection))return false;
   const checks=run.inspection.checks,required=['sourceHashBound','geometryAndUV','outsideWeights','attributes','materials','images','skeleton','exportedBoneNames'];
   return Array.isArray(checks)&&checks.every(check=>check.passed===true)&&required.every(id=>checks.some(check=>check.id===id&&check.passed===true));
  }
  return false;
 }catch{return false;}
}
