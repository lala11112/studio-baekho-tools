import fs from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { randomUUID } from 'node:crypto';
import { FourTigerItemStore } from '../../engine/four-tiger-items/store';
import { createInitialProject, adoptPolicies, reviewItem } from '../../engine/four-tiger-items/domain';
import { sha256 } from '../../engine/four-tiger-items/icons';
import type { PolicyKey } from '../../shared/four-tiger-items';
export async function writeTestPng(file:string,mode:'valid'|'opaque'|'empty',color=64,size=32):Promise<void>{
  const png=new PNG({width:size,height:size});
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){const n=(y*size+x)*4;png.data[n]=color;png.data[n+1]=130;png.data[n+2]=200;png.data[n+3]=mode==='empty'?0:mode==='opaque'?255:x>size/8&&x<size*7/8&&y>size/8&&y<size*7/8?255:0;}
  await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,PNG.sync.write(png));
}
export async function createReviewedFixture(root:string){
  const store=new FourTigerItemStore(root),now=new Date().toISOString();let p=await store.create(createInitialProject({projectId:randomUUID(),name:'TEST FIXTURE ONLY',now}));
  for(const [n,item] of p.items.entries()){
    const relative=`icons/${item.candidateKey}/fixture.png`;const file=path.join(store.directory(p.projectId),relative);await writeTestPng(file,'valid',n+1,256);const hash=sha256(await fs.readFile(file));
    item.icons.push({versionId:`fixture-${n}`,jobId:`fixture-${n}`,contentRevision:item.contentRevision,promptHash:sha256('TEST FIXTURE'),sourcePath:relative,thumbnailPath:relative,sourceSha256:hash,thumbnailSha256:hash,width:256,height:256,hasAlpha:true,prompt:'TEST FIXTURE NOT AI',tool:'imagegen',observedModel:null,createdAt:now});item.selectedIconVersion=`fixture-${n}`;
  }
  p=adoptPolicies(p,Object.keys(p.ruleProfile.proposed) as PolicyKey[],now);
  for(const item of p.items){p=reviewItem(p,item.candidateKey,'reviewData','fixture',now);p=reviewItem(p,item.candidateKey,'reviewIcon','fixture',now);p=reviewItem(p,item.candidateKey,'adopt','fixture',now);}
  const project=await store.update(p.projectId,p.revision,()=>p);return {store,project};
}
