import fs from "node:fs";
import path from "node:path";
const root=path.join(process.env.APPDATA,"partsmith");
const wb="1839dc9e-c05b-459b-b985-6ceca49fac76",jobId="18e8e770-ad5c-4f7e-9cfc-ad310bbdf3d1";
const dir=path.join(root,"projects/26122336-8a7c-48b5-b15f-fa193ca157fd/workbench",wb);
const w=JSON.parse(fs.readFileSync(path.join(dir,"workbench.json"),"utf8"));
const j=w.jobs.find(j=>j.id===jobId);
console.log(JSON.stringify({status:j.status,summary:j.summary,external:j.externalExecution,selected:w.selections.surface}));
const journal=path.join(root,"workbench-chrome-journals",wb,jobId+".json");
if(fs.existsSync(journal))console.log(fs.readFileSync(journal,"utf8"));
const attempt=j.externalExecution?.worker?.attempt??1;
const appLog=path.join(dir,"jobs",jobId,`app-worker-${attempt}`,"app-server-events.jsonl");
if(fs.existsSync(appLog))console.log(fs.readFileSync(appLog,"utf8").trim().split('\n').slice(-6).join('\n'));
const log=path.join(dir,"jobs",jobId,`app-worker-${attempt}`,"codex-events.jsonl");
if(fs.existsSync(log)) {
 const events=fs.readFileSync(log,"utf8").trim().split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return []}});
 for(const e of events.filter(e=>e.type==='item.completed'||e.type==='turn.failed'||e.type==='error').slice(-6))
 console.log(JSON.stringify({type:e.type,tool:e.item?.tool,item:e.item?.type,status:e.item?.status,message:e.item?.type==='agent_message'?e.item.text?.slice(0,800):e.error?.message}));
}
