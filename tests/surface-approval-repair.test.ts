import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {ChromeJobLedger} from '../engine/chrome-job-ledger';import {ChromeWorkbenchRunner} from '../electron/chrome-workbench-runner';
test('host repairs only a UV approval reserved after a failed tool, retaining immutable audit history',async()=>{
 for(const mode of ['late','delivered','failed-after','completed','missing'] as const){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ps-approval-')),workspace=path.join(root,'job');fs.mkdirSync(path.join(workspace,'app-worker-1'),{recursive:true});
  const id='11111111-1111-1111-1111-111111111111',url=`https://studio.tripo3d.ai/ko/workspace/smart-uv/rabbit-${id}`,packet:any={jobId:'job',request:{step:'surface',prompt:'',executionMode:'codex-app',externalSurface:{costApproval:'in-app',textureResolution:'4K',removeLighting:false,observedUvCost:0,observedTextureCost:0}},approval:{accepted:true,studioCreditLimit:0,imageCreditLimit:0},sourceStudioModel:{modelId:id,url}};
  fs.writeFileSync(path.join(workspace,'external-request.json'),JSON.stringify(packet));
  const file=path.join(root,'journals/bench/job.json'),ledger=new ChromeJobLedger(file,packet,'hash');await ledger.approveSurface({phase:'uv',sourceModelId:id,url,observedCost:20,textureResolution:'4K',removeLighting:false},async()=>true,()=>false);
  const reserved=ledger.read().entries[0],time=Date.parse(reserved.reservedAt);if(mode==='completed')ledger.complete({phase:'uv',resultId:id,url});
  const event={at:new Date(time+(mode==='failed-after'?100:-100)).toISOString(),event:'tool.completed',tool:'studio_surface_begin',status:mode==='delivered'?'completed':'failed'};
  fs.writeFileSync(path.join(workspace,'app-worker-1/app-server-events.jsonl'),mode==='missing'?'':JSON.stringify(event)+'\n');
  const ctx:any={workspace,workbench:{id:'bench',projectId:'project'},job:{id:'job',request:packet.request,status:'submission_unknown',step:'surface',externalExecution:{requestHash:'hash',worker:{attempt:1,startedAt:new Date(time-1000).toISOString()}}},signal:new AbortController().signal};
  const runner=new ChromeWorkbenchRunner({journalRoot:path.join(root,'journals'),bridgePath:'unused',projectRoot:()=>root,blenderPath:()=>'',downloadsPath:path.join(root,'downloads')});
  try{
   if(mode==='late'){runner.repairApproval(ctx);const repaired=new ChromeJobLedger(file,packet,'hash').read();assert.equal(repaired.entries.length,0);assert.equal(repaired.undeliveredApprovals?.[0].entry.cost,20);assert.equal(repaired.undeliveredApprovals?.[0].entry.reservedAt,reserved.reservedAt);assert.throws(()=>runner.repairApproval(ctx));}
   else {assert.throws(()=>runner.repairApproval(ctx),mode);assert.equal(new ChromeJobLedger(file,packet,'hash').read().entries.length,1);}
  }finally{fs.rmSync(root,{recursive:true,force:true});}
 }
});
