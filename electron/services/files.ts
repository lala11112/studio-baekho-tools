import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,rename,mkdir,lstat,realpath,readdir} from 'node:fs/promises';
import path from 'node:path';
export const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
export async function atomicWrite(file:string,data:string|Buffer){await mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${randomUUID()}.tmp`;await writeFile(tmp,data);await rename(tmp,file);}
export async function optionalRead(file:string){try{return await readFile(file,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
export async function projectFile(rootPath:string,relative:string,create=false):Promise<string>{
  const root=await realpath(rootPath), target=path.resolve(root,relative), rel=path.relative(root,target);
  if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw new Error('프로젝트 밖의 경로입니다.');
  let cursor=root;const parts=rel.split(path.sep);
  for(let i=0;i<parts.length;i++){
    cursor=path.join(cursor,parts[i]);let stat=await lstat(cursor).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return null;throw e;});
    if(!stat&&create&&i<parts.length-1){await mkdir(cursor);stat=await lstat(cursor);}
    if(stat?.isSymbolicLink())throw new Error(`연결된 경로를 사용할 수 없습니다: ${relative}`);
    if(stat&&i<parts.length-1&&!stat.isDirectory())throw new Error('폴더 경로가 올바르지 않습니다.');
  }return target;
}
export async function verifyProject(root:string){await readFile(await projectFile(root,'ProjectSettings/ProjectVersion.txt'));await lstat(await projectFile(root,'Assets'));}
export async function installIntegration(root:string,resourceRoot:string){
  await verifyProject(root);
  const recordPath=await projectFile(root,'Library/BaekhoEnemyForge/installation.json');
  const previous=JSON.parse(await optionalRead(recordPath)??'{"files":{}}') as {files:Record<string,string>;previous?:Record<string,string>};
  const names: {directory:string;name:string}[]=[];
  for(const directory of ['Runtime','Editor']){
    const entries=await readdir(path.join(resourceRoot,directory)).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT'&&directory==='Runtime')return [];throw error;});
    names.push(...entries.filter(name=>/^BaekhoEnemyForge\w*\.cs$/.test(name)).map(name=>({directory,name})));
  }
  if(!names.some(entry=>entry.directory==='Editor'))throw new Error('앱에 Unity 연동 파일이 없습니다.');
  const writes=[];
  for(const {directory,name} of names){
    const relative=`Assets/Baekho/EnemyForge/${directory}/${name}`,file=await projectFile(root,relative),data=await readFile(path.join(resourceRoot,directory,name),'utf8'),existing=await optionalRead(file);
    if(existing!==null&&existing!==data&&previous.files[relative]!==hash(existing)&&previous.previous?.[relative]!==hash(existing))throw new Error(`사용자가 변경한 연동 파일을 보존했습니다: ${relative}`);
    writes.push({relative,file,data,hash:hash(data),changed:existing!==data});
  }
  // Record ownership before installation so interrupted writes can be reconciled on retry.
  await atomicWrite(await projectFile(root,'Library/BaekhoEnemyForge/installation.json',true),JSON.stringify({version:1,files:Object.fromEntries(writes.map(w=>[w.relative,w.hash])),previous:previous.files},null,2));
  for(const w of writes)if(w.changed)await atomicWrite(await projectFile(root,w.relative,true),w.data);
}
