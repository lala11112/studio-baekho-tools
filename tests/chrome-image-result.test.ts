import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {PNG} from "pngjs";
import {NativeDownloadCollector} from "../engine/native-download";
import {collectImageResult} from "../engine/chrome-image-result";

test("image collection persists pending/native originals and builds exact-count host receipts",t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"image-collect-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dir=path.join(root,"downloads"),job=path.join(root,"job"),state=path.join(root,"host/state.json"),url="https://chatgpt.com/c/test";
 fs.mkdirSync(dir);fs.mkdirSync(job);
 let collector=new NativeDownloadCollector(dir,job,"image",state);
 const ids:string[]=[];
 for(let i=0;i<4;i++){
   const ticket=collector.prepare("images",url);ids.push(ticket.id);
   collector=new NativeDownloadCollector(dir,job,"image",state);assert.equal(collector.status().pending!.id,ticket.id);
   assert.equal(collector.collect(ticket.id).status,"pending");
   const png=new PNG({width:2,height:2});png.data.fill(100+i);
   fs.writeFileSync(path.join(dir,`${i}.png`),PNG.sync.write(png));
   const r=collector.collect(ticket.id);assert.equal(r.status,"collected");
   collector=new NativeDownloadCollector(dir,job,"image",state);assert.deepEqual(collector.collect(ticket.id),r);
 }
 const packet:any={jobId:"test",request:{step:"concept",conceptMode:"turnaround",generationCount:1}};
 const images=ids.map((ticketId,i)=>({ticketId,view:["front","back","left","right"][i]}));
 assert.throws(()=>collectImageResult(job,packet,"hash",url,collector,images.slice(1)),/개수/);
 assert.throws(()=>collectImageResult(job,packet,"hash",url,collector,images.map(i=>({...i,view:"front"}))),/방향/);
 assert.throws(()=>collectImageResult(job,packet,"hash","https://chatgpt.com/c/other",collector,images),/대화/);
 const result=collectImageResult(job,packet,"hash",url,collector,images);assert.equal(result.imageCount,4);
 const receipt=JSON.parse(fs.readFileSync(path.join(job,"external-result.json"),"utf8"));assert.equal(receipt.result.candidates.length,1);assert.equal(receipt.files.length,4);
 const record=collector.status().collected[0];fs.appendFileSync(path.join(job,record.path),"tamper");assert.throws(()=>collector.collect(ids[0]),/변경/);
});
