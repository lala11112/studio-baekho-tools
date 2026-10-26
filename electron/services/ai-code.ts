import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AssetRef, AttackDefinition, CompilerInfo, FieldSchema, PreviewShape, Values } from '../../src/shared/types';

const execute = promisify(execFile);
export const hash = (value: string|Buffer): string => createHash('sha256').update(value).digest('hex');
export const object = (value: unknown): Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
export interface GeneratedSource { className: string; source: string; }
export interface GeneratedAttack {
  status: 'implemented'|'configured_existing'|'needs_core_changes'; summary: string; name: string; description: string;
  typeName: string; files: GeneratedSource[]; defaults: Values; preview: {shapes:PreviewShape[]}; previewSupported: boolean;
  existingTypeId?:string; existingValues?:Values;
}
export interface AttackDescriptor { version: 1; attackId: string; typeId: string; name: string; description: string; defaults: Values; preview: {shapes:PreviewShape[]}; previewSupported: boolean; }
export interface Journal {
  version: 1; attackId: string; projectRoot: string; typeId: string; state: 'installing'|'installed'|'completed'|'rolled_back'|'recovery_required';
  targetDirectory: string; files: {path:string;hash:string}[]; createdAt: string; summary: string; diagnostic?: string;
}
export async function atomicWrite(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), {recursive:true});
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary,text,{encoding:'utf8',flag:'wx'});
  try { await rename(temporary,file); } catch(error) { await unlink(temporary).catch(()=>undefined); throw error; }
}
export function childOf(root:string,target:string): boolean {
  const relative=path.relative(path.resolve(root),path.resolve(target));
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export async function assertNoLinks(root:string,target:string): Promise<void> {
  if (!childOf(root,target)) throw new Error('프로젝트 밖의 생성 경로는 사용할 수 없습니다.');
  if ((await lstat(root)).isSymbolicLink()) throw new Error('연결 경로 대신 실제 Unity 프로젝트 폴더를 선택해 주세요.');
  let current=root;
  for(const segment of path.relative(root,target).split(path.sep)) {
    current=path.join(current,segment);
    const info=await lstat(current).catch(()=>null);
    if(info?.isSymbolicLink()) throw new Error('생성 경로에 링크가 있어 파일을 설치할 수 없습니다.');
  }
}
function simpleJson(value:unknown,depth=0): boolean {
  if(depth>12) return false;
  if(value===null||typeof value==='boolean'||typeof value==='string') return typeof value!=='string'||value.length<20000;
  if(typeof value==='number') return Number.isFinite(value);
  if(Array.isArray(value)) return value.length<512&&value.every(v=>simpleJson(v,depth+1));
  if(typeof value==='object') return Object.entries(value as object).length<256&&Object.entries(value as object).every(([key,item])=>!['__proto__','constructor','prototype','$type'].includes(key)&&simpleJson(item,depth+1));
  return false;
}
function identifier(value:unknown): value is string {return typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value);}
export function sourceTokens(source:string):string {
  // Remove comments/literals before examining executable C# tokens. Raw strings are not C# 9.
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|@"(?:""|[^"])*"|\$?"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,' ');
}
export function validateCode(files:GeneratedSource[], namespace:string, typeName:string):void {
  if(files.length<2||files.length>12||!identifier(typeName)) throw new Error('공격 데이터와 실행 클래스를 포함한 올바른 생성 코드가 필요합니다.');
  const names=new Set<string>(); let total=0;
  for(const file of files) {
    if(!identifier(file.className)||names.has(file.className)||typeof file.source!=='string'||file.source.length<30||file.source.length>150000) throw new Error('생성 클래스 이름이나 코드 크기가 올바르지 않습니다.');
    names.add(file.className);total+=file.source.length;
    const code=sourceTokens(file.source);
    if(!new RegExp(`\\bnamespace\\s+${namespace.replace(/\./g,'\\.')}\\s*\\{`).test(code)) throw new Error('생성 코드는 지정된 전용 namespace를 사용해야 합니다.');
    if((code.match(/\bnamespace\b/g)??[]).length!==1||/\\u[0-9a-f]{4}|\\U[0-9a-f]{8}/i.test(code))throw new Error('생성 코드는 하나의 전용 namespace와 일반 식별자를 사용해야 합니다.');
    if(!new RegExp(`\\bclass\\s+${file.className}\\b`).test(code)) throw new Error('파일 이름과 클래스 이름이 일치하지 않습니다.');
    if(/\b(?:ISerializationCallbackReceiver|OnBeforeSerialize|OnAfterDeserialize|OnValidate)\b/.test(code)
      ||(file.className===typeName||/\bclass\s+\w+\s*:\s*MonsterSkillData\b/.test(code))&&/\b(?:Awake|OnEnable|OnDisable|OnDestroy|Reset)\s*\(/.test(code))throw new Error(`${file.className}: 데이터 SO의 자동 생명주기 또는 직렬화 콜백은 사용할 수 없습니다.`);
    if(/\b(UnityEditor|ExecuteAlways|ExecuteInEditMode|InitializeOnLoad|InitializeOnLoadMethod|RuntimeInitializeOnLoadMethod|ModuleInitializer|DllImport|LibraryImport|unsafe|dynamic|Process|AppDomain|Assembly|Activator|Reflection|Marshal|File|Directory|WebClient|HttpClient|TcpClient|UdpClient|Socket|Thread|Task)\b/.test(code)
      ||/\bSystem\s*\.\s*(IO|Net|Diagnostics|Reflection|Runtime\s*\.\s*InteropServices)\b/.test(code)
      ||/\bApplication\s*\.\s*(Quit|OpenURL|dataPath|persistentDataPath)\b/.test(code)
      ||/\bstatic\s+(?:[\w.<>,\[\]?]+\s+)+\w+\s*=/.test(code)
      ||/\bstatic\s+(?:[\w.<>,\[\]?]+\s+)+\w+\s*\{/.test(code)
      ||/\bstatic\s+\w+\s*\(/.test(code)
      ||/^\s*#\s*(?:r|load|pragma)/m.test(code)) throw new Error(`${file.className}: 자동 초기화·파일·프로세스·네트워크 접근 코드는 공격 확장에 사용할 수 없습니다.`);
  }
  if(total>500000) throw new Error('생성 코드가 허용 크기를 초과했습니다.');
  if(!names.has(typeName))throw new Error('공격 SO 클래스 이름과 일치하는 소스 파일이 필요합니다.');
  const joined=files.map(f=>sourceTokens(f.source)).join('\n');
  if(!new RegExp(`\\bclass\\s+${typeName}\\s*:\\s*MonsterSkillData\\b`).test(joined)||!/:\s*EnemyAction\b/.test(joined)
    ||!['CreateAction','base.Enter','base.Update','base.Exit','IsFinished'].every(token=>joined.includes(token))) throw new Error('기존 MonsterSkillData / EnemyAction 수명주기를 구현해야 합니다.');
}
export function parseGeneratedAttack(raw:unknown,namespace:string):GeneratedAttack {
  const data=object(raw);
  if(!['implemented','configured_existing','needs_core_changes'].includes(data.status)||typeof data.summary!=='string'||data.summary.length<1||data.summary.length>10000) throw new Error('AI 공격 결과 형식이 올바르지 않습니다.');
  if(data.status==='needs_core_changes') return {status:data.status,summary:data.summary,name:'',description:'',typeName:'',files:[],defaults:{},preview:{shapes:[]},previewSupported:false};
  if(data.status==='configured_existing'){
    if(typeof data.existingTypeId!=='string'||!data.existingTypeId||data.existingTypeId.length>300||!Array.isArray(data.files)||data.files.length!==0)throw new Error('기존 공격 구성 결과는 카탈로그 타입과 설정만 포함해야 합니다.');
    let values:unknown;try{values=JSON.parse(data.existingValuesJson);}catch{throw new Error('기존 공격 설정 JSON이 올바르지 않습니다.');}
    if(!values||Array.isArray(values)||typeof values!=='object'||!simpleJson(values))throw new Error('기존 공격 설정에 지원하지 않는 값이 있습니다.');
    return {status:data.status,summary:data.summary,name:'',description:'',typeName:'',files:[],defaults:{},preview:{shapes:[]},previewSupported:false,existingTypeId:data.existingTypeId,existingValues:values as Values};
  }
  if(typeof data.name!=='string'||!data.name.trim()||data.name.length>100||typeof data.description!=='string'||data.description.length>4000||!Array.isArray(data.files)) throw new Error('공격 이름·설명·코드가 올바르지 않습니다.');
  const files=data.files.map((f:unknown)=>{const value=object(f);return {className:value.className,source:value.source};});
  validateCode(files,namespace,data.typeName);
  let defaults:unknown,preview:unknown;
  try{defaults=JSON.parse(data.defaultsJson);preview=JSON.parse(data.previewJson);}catch{throw new Error('공격 기본값 또는 미리보기 JSON을 읽을 수 없습니다.');}
  if(!simpleJson(defaults)||!simpleJson(preview)||Array.isArray(defaults)||!defaults||typeof defaults!=='object') throw new Error('공격 기본값에 지원하지 않는 값이 있습니다.');
  const shapes=object(preview).shapes;
  if(!Array.isArray(shapes)||shapes.length>64) throw new Error('미리보기 도형 목록이 올바르지 않습니다.');
  for(const shape of shapes) {
    const s=object(shape);
    if(!['sphere','box','capsule','path'].includes(s.shape)||!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<s.start||s.end>3600) throw new Error('미리보기 도형 또는 시간 범위가 올바르지 않습니다.');
    for(const field of ['offset','size']) if(s[field]!==undefined&&(!Array.isArray(s[field])||s[field].length!==3||!s[field].every((n:unknown)=>typeof n==='number'&&Number.isFinite(n))))throw new Error('미리보기 벡터가 올바르지 않습니다.');
    for(const field of ['radius','height']) if(s[field]!==undefined&&(!Number.isFinite(s[field])||s[field]<=0))throw new Error('미리보기 크기가 올바르지 않습니다.');
    if(s.points!==undefined&&(!Array.isArray(s.points)||s.points.length>256||!s.points.every((p:unknown)=>Array.isArray(p)&&p.length===3&&p.every(n=>typeof n==='number'&&Number.isFinite(n)))))throw new Error('미리보기 궤적이 올바르지 않습니다.');
  }
  return {status:data.status,summary:data.summary,name:data.name.trim(),description:data.description,typeName:data.typeName,files,defaults:defaults as Values,preview:{shapes},previewSupported:data.previewSupported===true};
}
/** Only serialized fields exposed by the connected catalog can be changed by AI. */
export function configureExistingAttack(definition:AttackDefinition,patch:Values,assets:AssetRef[]):Values{
  return configureValues(definition.fields,definition.defaults,patch,assets,'attack.values');
}
/** Validate an AI patch against the exact serialized fields exposed by the project. */
export function configureValues(schema:FieldSchema[],defaults:Values,patch:Values,assets:AssetRef[],location='values'):Values{
  const refs=new Map(assets.map(asset=>[`${asset.guid}:${asset.localId}`,asset]));
  function remember(value:unknown):void{if(!value||typeof value!=='object')return;const entry=object(value);if(typeof entry.guid==='string'&&typeof entry.localId==='string')refs.set(`${entry.guid}:${entry.localId}`,entry as AssetRef);else for(const item of Object.values(value))remember(item);}
  remember(defaults);
  function valueFor(schema:FieldSchema,value:any,previous:any,location:string):any{
    if(schema.type==='unsupported'){if(JSON.stringify(value)!==JSON.stringify(previous))throw new Error(`${location}: 지원하지 않는 필드는 수정할 수 없습니다.`);return previous;}
    if(schema.type==='number'||schema.type==='integer'){
      if(typeof value!=='number'||!Number.isFinite(value)||schema.type==='integer'&&!Number.isSafeInteger(value)||schema.min!==undefined&&value<schema.min||schema.max!==undefined&&value>schema.max)throw new Error(`${location}: 숫자 범위가 올바르지 않습니다.`);return value;
    }
    if(schema.type==='boolean'){if(typeof value!=='boolean')throw new Error(`${location}: 참/거짓 값이 필요합니다.`);return value;}
    if(schema.type==='string'){if(typeof value!=='string'||value.length>20000)throw new Error(`${location}: 문자열이 올바르지 않습니다.`);return value;}
    if(schema.type==='enum'){if(!schema.options?.some(option=>option.value===value))throw new Error(`${location}: 열거형 값이 올바르지 않습니다.`);return value;}
    if(['vector2','vector3','color'].includes(schema.type)){const count=schema.type==='vector2'?2:schema.type==='color'?4:3;if(!Array.isArray(value)||value.length!==count||!value.every(n=>typeof n==='number'&&Number.isFinite(n)))throw new Error(`${location}: 벡터 값이 올바르지 않습니다.`);return [...value];}
    if(schema.type==='asset'){
      if(value===null)return null;const asset=object(value),known=refs.get(`${asset.guid}:${asset.localId}`);if(!known)throw new Error(`${location}: 프로젝트 카탈로그에 없는 에셋입니다.`);return {...known};
    }
    if(schema.type==='object')return merge(schema.children??[],object(previous),value,location);
    if(schema.type==='array'){
      if(!Array.isArray(value)||value.length>256)throw new Error(`${location}: 배열이 올바르지 않습니다.`);
      return value.map((item,index)=>schema.element?valueFor(schema.element,item,previous?.[index]??previous?.[0],`${location}.${index}`):merge(schema.children??[],object(previous?.[index]??previous?.[0]),item,`${location}.${index}`));
    }
    throw new Error(`${location}: 지원하지 않는 필드 형식입니다.`);
  }
  function merge(schema:FieldSchema[],defaults:Values,input:unknown,location:string):Values{
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error(`${location}: 설정 객체가 필요합니다.`);
    const result=JSON.parse(JSON.stringify(defaults)),fields=new Map(schema.map(field=>[field.path,field]));
    for(const [key,value] of Object.entries(input)){
      const field=fields.get(key);if(!field||['__proto__','constructor','prototype','m_Script'].includes(key))throw new Error(`${location}.${key}: 허용되지 않은 설정 필드입니다.`);
      result[key]=valueFor(field,value,defaults[key],`${location}.${key}`);
    }
    return result;
  }
  return merge(schema,defaults,patch,location);
}
export async function compileCandidate(directory:string,files:GeneratedSource[],info:CompilerInfo,signal?:AbortSignal):Promise<void> {
  if(info.hasErrors)throw new Error('프로젝트의 기존 컴파일 오류를 먼저 해결해 주세요.');
  if(!info.references?.length||info.references.some(ref=>typeof ref!=='string'||!path.isAbsolute(ref)||/["\r\n]/.test(ref)))throw new Error('Unity 컴파일 참조 정보를 확인하지 못했습니다.');
  const editorRoot=path.extname(info.editorPath).toLowerCase()==='.exe'?path.dirname(info.editorPath):info.editorPath;
  const dataRoot=path.basename(editorRoot).toLowerCase()==='data'?editorRoot:path.join(editorRoot,'Data');
  const runtime=path.join(dataRoot,'NetCoreRuntime',process.platform==='win32'?'dotnet.exe':'dotnet');
  const compiler=path.join(dataRoot,'DotNetSdkRoslyn','csc.dll');
  if(!(await lstat(runtime).catch(()=>null))?.isFile()||!(await lstat(compiler).catch(()=>null))?.isFile())throw new Error('Unity의 C# 사전 컴파일러를 찾지 못했습니다.');
  await mkdir(directory,{recursive:true});
  for(const file of files)await writeFile(path.join(directory,`${file.className}.cs`),file.source,'utf8');
  const lang=/^\d+(?:\.\d+)?$/.test(info.languageVersion)?info.languageVersion:'9.0';
  const output=path.join(directory,'Candidate.dll');
  const argumentsList=['-nologo','-target:library','-noconfig','-nostdlib+',`-langversion:${lang}`,`-out:"${output}"`,...info.references.map(ref=>`-r:"${ref}"`),...(info.defines?.length?[`-define:${info.defines.filter(v=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)).join(';')}`]:[]),...files.map(f=>`"${path.join(directory,`${f.className}.cs`)}"`)];
  await writeFile(path.join(directory,'candidate.rsp'),argumentsList.join('\n'),'utf8');
  try{await execute(runtime,[compiler,`@${path.join(directory,'candidate.rsp')}`],{cwd:directory,windowsHide:true,timeout:90000,maxBuffer:1024*1024,signal});}
  catch(error){const result=error as Error&{stdout?:string;stderr?:string};throw new Error(`C# 사전 컴파일 실패:\n${(result.stdout||result.stderr||result.message).slice(0,24000)}`);}
}
export async function writeJournal(directory:string,journal:Journal):Promise<void>{await atomicWrite(path.join(directory,'journal.json'),JSON.stringify(journal,null,2));}
function validateJournalPaths(journal:Journal):void {
  const expected=path.join(journal.projectRoot,'Assets','_Project','Scripts','Enemy','Generated',journal.attackId);
  if(journal.version!==1||!/^a[0-9a-f]{32}$/.test(journal.attackId)||path.resolve(expected)!==path.resolve(journal.targetDirectory)
    ||!Array.isArray(journal.files)||journal.files.length<2||journal.files.length>13)throw new Error('복구 작업 경로가 일치하지 않습니다.');
  const seen=new Set<string>();
  for(const file of journal.files){
    if(typeof file.path!=='string'||path.dirname(file.path)!==journal.targetDirectory||!/^(?:[A-Za-z][A-Za-z0-9_]*\.cs|Attack\.enemyattack\.json)$/.test(path.basename(file.path))
      ||!/^[a-f0-9]{64}$/.test(file.hash)||seen.has(file.path.toLowerCase()))throw new Error('복구 파일 경로가 올바르지 않습니다.');
    seen.add(file.path.toLowerCase());
  }
}
async function optionalOwnedBytes(file:string):Promise<Buffer|null>{
  try{return await readFile(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}
/** A journal may precede the atomic directory publication. Missing files are definitive local evidence. */
export async function candidatePublicationState(journal:Journal):Promise<'absent'|'partial'|'complete'|'modified'>{
  validateJournalPaths(journal);await assertNoLinks(journal.projectRoot,journal.targetDirectory);
  let present=0;
  for(const file of journal.files){
    if((await lstat(file.path).catch(()=>null))?.isSymbolicLink())throw new Error('복구 파일에 링크가 있어 보존했습니다.');
    const bytes=await optionalOwnedBytes(file.path);if(bytes){present++;if(hash(bytes)!==file.hash)return 'modified';}
  }
  return present===0?'absent':present===journal.files.length?'complete':'partial';
}
export async function installCandidate(projectRoot:string,stageDirectory:string,attackId:string,attack:GeneratedAttack):Promise<Journal> {
  if(!/^a[0-9a-f]{32}$/.test(attackId))throw new Error('공격 작업 ID가 올바르지 않습니다.');
  const targetDirectory=path.join(projectRoot,'Assets','_Project','Scripts','Enemy','Generated',attackId);
  await assertNoLinks(projectRoot,targetDirectory);
  if(await lstat(targetDirectory).catch(()=>null))throw new Error('같은 공격 작업 경로가 이미 있습니다. 상태를 복구한 뒤 다시 시도해 주세요.');
  const typeId=`Baekho.Generated.${attackId}.${attack.typeName}`;
  const descriptor:AttackDescriptor={version:1,attackId,typeId,name:attack.name,description:attack.description,defaults:attack.defaults,preview:attack.preview,previewSupported:attack.previewSupported};
  const entries=[...attack.files.map(f=>({path:path.join(targetDirectory,`${f.className}.cs`),text:f.source})),{path:path.join(targetDirectory,'Attack.enemyattack.json'),text:JSON.stringify(descriptor,null,2)}];
  const journal:Journal={version:1,attackId,projectRoot,typeId,state:'installing',targetDirectory,files:entries.map(f=>({path:f.path,hash:hash(f.text)})),createdAt:new Date().toISOString(),summary:attack.summary};
  await writeJournal(stageDirectory,journal); // Written before the first Assets mutation.
  const readyDirectory=path.join(stageDirectory,'InstallReady');
  await assertNoLinks(projectRoot,readyDirectory);
  await mkdir(readyDirectory,{recursive:true});
  for(const entry of entries)await writeFile(path.join(readyDirectory,path.basename(entry.path)),entry.text,{encoding:'utf8',flag:'wx'});
  await mkdir(path.dirname(targetDirectory),{recursive:true});
  // One directory rename publishes the complete source group to AssetDatabase at once.
  await rename(readyDirectory,targetDirectory);
  journal.state='installed';await writeJournal(stageDirectory,journal);return journal;
}
export async function rollbackCandidate(journal:Journal,stageDirectory:string):Promise<void> {
  validateJournalPaths(journal);
  await assertNoLinks(journal.projectRoot,journal.targetDirectory);
  for(const file of journal.files) {
    if(path.dirname(file.path)!==journal.targetDirectory||!/^(?:[A-Za-z][A-Za-z0-9_]*\.cs|Attack\.enemyattack\.json)$/.test(path.basename(file.path)))throw new Error('복구 파일 경로가 올바르지 않습니다.');
    if((await lstat(file.path).catch(()=>null))?.isSymbolicLink()||(await lstat(`${file.path}.meta`).catch(()=>null))?.isSymbolicLink())throw new Error('복구 파일에 링크가 있어 보존했습니다.');
    const existing=await optionalOwnedBytes(file.path);
    if(existing&&hash(existing)!==file.hash){journal.state='recovery_required';journal.diagnostic='사용자가 수정한 생성 파일을 보존했습니다.';await writeJournal(stageDirectory,journal);throw new Error(journal.diagnostic);}
  }
  for(const file of journal.files) {
    const existing=await optionalOwnedBytes(file.path);
    if(existing) {await unlink(file.path);await unlink(`${file.path}.meta`).catch(()=>undefined);}
  }
  // Only remove an empty, exact per-request folder. Never recursively delete Unity assets.
  if((await readdir(journal.targetDirectory).catch(()=>[])).length===0){await rmdir(journal.targetDirectory).catch(()=>undefined);await unlink(`${journal.targetDirectory}.meta`).catch(()=>undefined);}
  journal.state='rolled_back';await writeJournal(stageDirectory,journal);
}
