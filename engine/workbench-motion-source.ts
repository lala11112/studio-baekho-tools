import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import type {WorkbenchExecutionContext, WorkbenchResult} from "../shared/workbench";

const hash=(file:string)=>createHash("sha256").update(fs.readFileSync(file)).digest("hex");
/** Deterministic photographs of the accepted rig. Never dispatches an AI worker. */
export async function prepareMotionSource(ctx:WorkbenchExecutionContext, services:{
  projectRoot:string; resources:string; blender:string;
  runBlender:(exe:string,args:string[],signal:AbortSignal)=>Promise<void>;
}, progress:(message:string)=>void):Promise<WorkbenchResult>{
  const root=fs.realpathSync(services.projectRoot),ref=ctx.job.dependencies.rig;
  const candidate=ctx.workbench.jobs.find(j=>j.id===ref?.jobId)?.candidates.find(c=>c.id===ref?.candidateId);
  const artifact=candidate?.artifacts.find(a=>a.kind==="blend");
  if(!artifact || !ctx.inputs.some(a=>a.path===artifact.path&&a.sha256===artifact.sha256))throw Error("채택한 리깅 Blender 원본이 필요합니다.");
  const source=fs.realpathSync(path.resolve(root,artifact.path));
  if(!source.startsWith(root+path.sep)||hash(source)!==artifact.sha256)throw Error("리깅 원본의 경로·해시가 달라졌습니다.");
  const folder=path.join(ctx.workspace,"outputs","motion-source"),axis=ctx.job.request.motionSourceAxis??"X";
  fs.mkdirSync(folder,{recursive:true});
  const files=["left.png","right.png","render.json"],checkpoint=path.join(folder,"checkpoint.json");
  let cached=false;
  if(fs.existsSync(checkpoint)){
    const prior=JSON.parse(fs.readFileSync(checkpoint,"utf8"));
    cached=prior.sourceHash===artifact.sha256&&prior.axis===axis&&files.every(f=>fs.existsSync(path.join(folder,f))&&hash(path.join(folder,f))===prior.hashes?.[f]);
  }
  ctx.signal.throwIfAborted();
  if(!cached){
    progress("채택한 리깅 모델의 양쪽 측면을 Blender로 촬영합니다. GPT 호출·서비스 과금 없음.");
    await services.runBlender(services.blender,["--background","--factory-startup","--disable-autoexec","--python",path.join(services.resources,"blender","motion_source.py"),"--",source,folder,axis],ctx.signal);
    if(hash(source)!==artifact.sha256)throw Error("촬영 중 원본이 변경됐습니다.");
    const report=JSON.parse(fs.readFileSync(path.join(folder,"render.json"),"utf8"));
    if(!report.fullBodyInFrame||report.axis!==axis||report.missingImages?.length)throw Error("측면 촬영의 전신 구도·텍스처를 확인하세요.");
    fs.writeFileSync(checkpoint,JSON.stringify({sourceHash:artifact.sha256,axis,hashes:Object.fromEntries(files.map(f=>[f,hash(path.join(folder,f))]))}));
  }
  return {status:"completed",summary:"측면 이미지 준비 완료 · 귀·발과 방향을 확인한 뒤 사용할 이미지를 채택하세요. 아직 동작 영상을 생성하지 않았습니다.",
    candidates:[{id:"model-sides",label:"채택한 모델의 측면",artifacts:[
      ...(["left","right"] as const).map(view=>({path:`outputs/motion-source/${view}.png`,kind:"image" as const,role:"motion-source",view})),
      {path:"outputs/motion-source/render.json",kind:"report"},
      {path:"outputs/motion-source/checkpoint.json",kind:"report"},
    ]}],checks:[{name:"local_full_body_render",passed:true,detail:"채택한 리그 원본 보존 · 두 측면 전신 촬영 · AI 생성 없음"}]};
}
