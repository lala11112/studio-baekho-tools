import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {NativeDownloadCollector} from "./native-download";
import type {ChromePacket} from "./chrome-job-ledger";

/** Host builds receipt from recorded original downloads; the worker only labels images. */
export function collectImageResult(workspace:string, packet:ChromePacket, requestHash:string,
  conversationUrl:string, downloads:NativeDownloadCollector,
  images:{ticketId:string;view?:string}[]) {
  if(packet.request.step!=="concept") throw Error("이미지 작업에서만 사용할 수 있습니다.");
  const turnaround=packet.request.conceptMode==="turnaround";
  const views=["front","back","left","right"];
  const count=turnaround?4:(packet.request.generationCount??4);
  if(!Array.isArray(images)||images.length!==count || new Set(images.map(i=>i.ticketId)).size!==count ||
    (turnaround ? views.some(v=>images.filter(i=>i.view===v).length!==1) : images.some(i=>i.view)))
    throw Error("요청한 이미지 개수·방향·고유 다운로드 기록이 필요합니다.");
  const files=images.map(i=>{
    const record=downloads.status().collected.find(d=>d.id===i.ticketId);
    if(!record || record.phase!=="images" || record.pageUrl!==conversationUrl) throw Error("현재 대화의 원본 다운로드가 아닙니다.");
    return downloads.collect(i.ticketId) as {path:string;sha256:string};
  });
  if(new Set(files.map(f=>f.sha256)).size!==count) throw Error("동일한 원본을 여러 이미지로 등록할 수 없습니다.");
  const artifacts=files.map((f,i)=>({path:f.path,kind:"image",...(turnaround?{role:"whole",view:images[i].view}:{})}));
  const result={jobId:packet.jobId,requestHash,conversationUrl,
    files:files.map(f=>({path:f.path,sha256:f.sha256})),
    result:{status:"completed",summary:"원본 이미지 수집 완료 · 외형과 방향을 확인한 뒤 채택하세요.",
      candidates:turnaround?[{id:"views",label:"4방향 원본",artifacts}]:artifacts.map((a,i)=>({id:`image-${i+1}`,label:`이미지 ${i+1}`,artifacts:[a]})),
      checks:[{name:"native_download_integrity",passed:true,detail:"현재 작업의 원본 다운로드·개수·고유 파일 해시 확인. 외형 품질은 사용자 검토가 필요합니다."}]}};
  const file=path.join(workspace,"external-result.json"),tmp=file+".tmp";
  fs.writeFileSync(tmp,JSON.stringify(result,null,2));fs.renameSync(tmp,file);
  return {status:"completed",file:"external-result.json",imageCount:count,
    receiptSha256:createHash("sha256").update(fs.readFileSync(file)).digest("hex")};
}
