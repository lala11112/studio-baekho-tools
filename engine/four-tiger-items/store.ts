import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FourTigerError, projectSchema, type SainGeomItemProject, type ProjectSummary } from '../../shared/four-tiger-items';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isWithin(root:string,file:string):boolean {const rel=path.relative(root,file);return rel!==''&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);}
export class FourTigerItemStore {
  readonly root:string;
  private operations=new Map<string,Promise<unknown>>();
  constructor(root:string){this.root=path.resolve(root);}
  directory(projectId:string):string {if(!uuid.test(projectId))throw new FourTigerError('PATH_REJECTED','잘못된 묶음 식별자입니다.');return path.join(this.root,projectId);}
  async ensureDirectory(projectId:string,relative:string):Promise<string>{
    if(path.isAbsolute(relative)||relative.includes('\\')||relative.includes(':')||relative.split('/').some(x=>!x||x==='.'||x==='..'))throw new FourTigerError('PATH_REJECTED','허용되지 않은 저장 경로입니다.');
    let current=this.directory(projectId);
    for(const segment of ['',...relative.split('/')]){if(segment)current=path.join(current,segment);try{const info=await fs.lstat(current);if(info.isSymbolicLink()||!info.isDirectory())throw new FourTigerError('PATH_REJECTED','외부 연결 경로에는 저장할 수 없습니다.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await fs.mkdir(current);}}
    return current;
  }
  async resolveFile(projectId:string,relative:string):Promise<string> {
    if(!relative||path.isAbsolute(relative)||relative.includes('\\')||relative.split('/').some(p=>p==='..'||p==='.'||!p)||relative.includes(':'))throw new FourTigerError('PATH_REJECTED','허용되지 않은 파일 경로입니다.');
    const dir=this.directory(projectId),file=path.resolve(dir,relative);
    if(!isWithin(dir,file))throw new FourTigerError('PATH_REJECTED','묶음 밖의 파일입니다.');
    const [rootReal,dirReal,fileReal]=await Promise.all([fs.realpath(this.root),fs.realpath(dir),fs.realpath(file)]);
    if(!isWithin(rootReal,dirReal)||!isWithin(dirReal,fileReal))throw new FourTigerError('PATH_REJECTED','연결된 외부 경로를 읽을 수 없습니다.');
    return fileReal;
  }
  private async serial<T>(projectId:string,action:()=>Promise<T>):Promise<T>{
    this.directory(projectId);const previous=this.operations.get(projectId)??Promise.resolve();
    const current=previous.catch(()=>{}).then(action);this.operations.set(projectId,current);
    try{return await current;}finally{if(this.operations.get(projectId)===current)this.operations.delete(projectId);}
  }
  private parse(bytes:string):SainGeomItemProject {
    try {const raw=JSON.parse(bytes);if(raw?.schemaVersion!==1)throw new FourTigerError('UNSUPPORTED_SCHEMA','지원하지 않는 데이터 버전입니다. 파일을 보존했습니다.');return projectSchema.parse(raw);}
    catch(error){if(error instanceof FourTigerError)throw error;throw new FourTigerError('CORRUPT_PROJECT','저장 파일이 손상됐습니다. 이전 정상본 복구를 선택하세요.');}
  }
  async read(projectId:string):Promise<SainGeomItemProject> {
    const file=await this.resolveFile(projectId,'draft.json');const p=this.parse(await fs.readFile(file,'utf8'));
    if(p.projectId!==projectId)throw new FourTigerError('CORRUPT_PROJECT','묶음 식별자가 일치하지 않습니다. 복구가 필요합니다.');return p;
  }
  private async write(project:SainGeomItemProject,previous:SainGeomItemProject|null):Promise<void>{
    const dir=this.directory(project.projectId);await fs.mkdir(dir,{recursive:true});
    const rootReal=await fs.realpath(this.root),dirReal=await fs.realpath(dir);
    if(!isWithin(rootReal,dirReal))throw new FourTigerError('PATH_REJECTED','저장 경로가 묶음 밖으로 연결되어 있습니다.');
    const token=randomUUID(),temp=path.join(dir,`draft-${token}.tmp`),backupTemp=path.join(dir,`previous-${token}.tmp`);
    try {
      await fs.writeFile(temp,JSON.stringify(project,null,2),'utf8');
      const handle=await fs.open(temp,'r+');try{await handle.sync();}finally{await handle.close();}
      if(previous){await fs.writeFile(backupTemp,JSON.stringify(previous,null,2),'utf8');await fs.rename(backupTemp,path.join(dir,'previous.json'));}
      await fs.rename(temp,path.join(dir,'draft.json'));
    }catch(error){throw new FourTigerError('IO_ERROR',`저장하지 못했습니다. 이전 파일은 보존됩니다. ${error instanceof Error?(error as NodeJS.ErrnoException).code??'IO_ERROR':'IO_ERROR'}`);}
    finally{await Promise.all([fs.rm(temp,{force:true}),fs.rm(backupTemp,{force:true})].map(p=>p.catch(()=>{})));}
  }
  async create(project:SainGeomItemProject):Promise<SainGeomItemProject>{
    return this.serial(project.projectId,async()=>{
      const parsed=projectSchema.parse(project),dir=this.directory(parsed.projectId);
      try{await fs.access(dir);throw new FourTigerError('INVALID_INPUT','이미 존재하는 묶음입니다.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const next={...parsed,revision:1};await this.write(next,null);return next;
    });
  }
  async update(projectId:string,expectedRevision:number,change:(current:SainGeomItemProject)=>SainGeomItemProject):Promise<SainGeomItemProject>{
    return this.serial(projectId,async()=>{
      const current=await this.read(projectId);
      if(current.revision!==expectedRevision)throw new FourTigerError('REVISION_CONFLICT','다른 작업이 먼저 저장됐습니다. 입력은 유지하고 최신 내용을 다시 불러오세요.');
      const changed=change(structuredClone(current));
      if(changed.projectId!==projectId)throw new FourTigerError('INVALID_INPUT','묶음 식별자는 변경할 수 없습니다.');
      const next=projectSchema.parse({...changed,revision:current.revision+1,updatedAt:new Date().toISOString()});await this.write(next,current);return next;
    });
  }
  async restorePrevious(projectId:string):Promise<SainGeomItemProject>{
    return this.serial(projectId,async()=>{
      const backup=await this.resolveFile(projectId,'previous.json');const previous=this.parse(await fs.readFile(backup,'utf8'));
      if(previous.projectId!==projectId)throw new FourTigerError('CORRUPT_PROJECT','복구 파일 식별자가 다릅니다.');
      const current=await this.read(projectId).catch(()=>null);
      const next={...previous,revision:Math.max(previous.revision,current?.revision??0)+1,updatedAt:new Date().toISOString()};
      await this.write(next,current);return next;
    });
  }
  async list():Promise<ProjectSummary[]>{
    let entries:string[];try{entries=await fs.readdir(this.root);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
    const result:ProjectSummary[]=[];
    for(const projectId of entries.filter(name=>uuid.test(name))){
      try {const p=await this.read(projectId);result.push({projectId,name:p.name,revision:p.revision,updatedAt:p.updatedAt,total:p.items.length,validatedIcons:p.items.filter(i=>i.icons.length>0).length,adopted:p.items.filter(i=>i.review.state==='adopted').length,pendingJobs:p.jobs.filter(j=>['queued','running','generated'].includes(j.status)).length,failedJobs:p.jobs.filter(j=>['failed','unknown','interrupted'].includes(j.status)).length,exports:p.exports,readError:null});}
      catch(error){result.push({projectId,name:'복구가 필요한 묶음',revision:0,updatedAt:'',total:0,validatedIcons:0,adopted:0,pendingJobs:0,failedJobs:0,exports:[],readError:error instanceof Error?error.message:'복구가 필요합니다.'});}
    }
    return result.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  }
}
