import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FourTigerError, type ExportKind, type ExportReceipt } from '../../shared/four-tiger-items';
import { validateProject, validItemId } from './domain';
import { FourTigerItemStore, isWithin } from './store';
import { inspectPng, sha256 } from './icons';

export async function exportItemPackage(input:{store:FourTigerItemStore;projectId:string;expectedRevision:number;kind:ExportKind;exportRoot:string}):Promise<ExportReceipt>{
  const {store,projectId,expectedRevision,kind}=input;
  const project=await store.read(projectId);
  if(project.revision!==expectedRevision)throw new FourTigerError('REVISION_CONFLICT','검사 후 내용이 변경됐습니다. 최신 묶음을 확인하세요.');
  const report=validateProject(project,kind);
  if(!report.canExport)throw new FourTigerError('REVIEW_REQUIRED','현재 데이터·아이콘·정책 검토와 규칙 오류를 확인하세요.');
  const base=store.directory(projectId),exportRoot=path.resolve(input.exportRoot);
  if(!isWithin(base,exportRoot))throw new FourTigerError('PATH_REJECTED','묶음 안의 새 출력 폴더만 사용할 수 있습니다.');
  const parent=await store.ensureDirectory(projectId,path.relative(base,exportRoot).split(path.sep).join('/'));
  const exportId=randomUUID(),createdAt=new Date().toISOString(),name=`${projectId}-r${project.revision}-${exportId}`,staging=path.join(parent,`.staging-${exportId}`),directory=path.join(parent,name);
  await fs.mkdir(staging);await fs.mkdir(path.join(staging,'icons'));
  const files:ExportReceipt['files']=[],iconPaths=new Map<string,string>();
  const write=async(relative:string,bytes:Buffer|string)=>{await fs.writeFile(path.join(staging,relative),bytes,{flag:'wx'});files.push({path:relative,sha256:sha256(bytes)});};
  // All fields and files come from the same frozen snapshot, even during live editing.
  for(const item of project.items){
    const icon=item.icons.find(i=>i.versionId===item.selectedIconVersion);if(!icon)continue;
    await inspectPng(await store.resolveFile(projectId,icon.sourcePath),icon.sourceSha256);
    const thumbnail=await inspectPng(await store.resolveFile(projectId,icon.thumbnailPath),icon.thumbnailSha256);
    if(thumbnail.png.width!==256||thumbnail.png.height!==256)throw new FourTigerError('INVALID_PNG','출력 아이콘은 256×256이어야 합니다.');
    if(kind==='release'&&!validItemId(item.itemId))throw new FourTigerError('INVALID_INPUT','출력 ID를 확인하세요.');
    const relative=`icons/${kind==='release'?item.itemId:item.candidateKey}.png`;await write(relative,thumbnail.bytes);iconPaths.set(item.candidateKey,relative);
  }
  const catalog={schemaVersion:1,contentStatus:kind==='release'?'adopted':'draft',projectId,contentRevision:project.revision,sourceRefs:project.sourceRefs,ruleProfile:project.ruleProfile,
    items:project.items.map(item=>{const icon=item.icons.find(v=>v.versionId===item.selectedIconVersion);return {candidateKey:item.candidateKey,itemId:item.itemId,name:item.name,description:item.description,descriptionStale:item.descriptionStale,element:item.element,grade:item.grade,purchasePrice:item.purchasePrice,effects:item.effects,synergyTags:item.synergyTags,unsupportedEffectNotes:item.unsupportedEffectNotes,contentRevision:item.contentRevision,review:item.review,iconPath:iconPaths.get(item.candidateKey)??null,icon:icon?{versionId:icon.versionId,sourceContentRevision:icon.contentRevision,sourceSha256:icon.sourceSha256,thumbnailSha256:icon.thumbnailSha256,tool:icon.tool,observedModel:icon.observedModel,createdAt:icon.createdAt}:null};}),
    synergyReferences:project.synergyReferences,
  };
  await write('saingeom-items.v1.json',JSON.stringify(catalog,null,2));
  await write('validation-report.json',JSON.stringify(report,null,2));
  await write('README.md',`# 사인검 아이템 ${kind==='release'?'채택본':'검토용 초안'}\n\n콘텐츠 상태: ${catalog.contentStatus}. revision ${project.revision}.\n\nJSON/PNG는 새 Unity 폴더에 복사하여 TextAsset/Texture로 반입할 수 있습니다. PNG는 Sprite (2D and UI), Single로 설정하세요. 기존 Assets를 덮어쓰지 마세요.\n\n아이템 런타임 적용은 미연결입니다. 이 패키지는 ItemDefinition/SO/Importer/전투효과 실행기를 포함하지 않습니다. JSON의 metal은 문자열이며 기존 enum 정수가 아닙니다. 비율 0.08은 8%입니다.\n\n개별 효과·수치·정책·아트는 제안입니다. 생성과 파일 검증은 사용자 채택을 대신하지 않습니다. 초안 묶음에는 미채택 정책이나 누락 아이콘이 있을 수 있으며 validation-report.json을 함께 확인하세요.\n`);
  const manifest={schemaVersion:1,exportId,kind,projectId,contentRevision:project.revision,policyRevision:project.ruleProfile.revision,createdAt,sourceRefs:project.sourceRefs,icons:project.items.map(i=>({itemId:i.itemId,iconPath:iconPaths.get(i.candidateKey)??null})),files:[...files]};
  await write('manifest.json',JSON.stringify(manifest,null,2));
  for(const file of files)if(sha256(await fs.readFile(path.join(staging,file.path)))!==file.sha256)throw new FourTigerError('IO_ERROR','출력 파일 검증에 실패했습니다.');
  await fs.rename(staging,directory);
  const receipt:ExportReceipt={exportId,kind,projectId,revision:project.revision,directory,files,createdAt};
  // Recording export history never overwrites a concurrent content edit.
  for(let attempt=0;attempt<8;attempt++){
    const latest=await store.read(projectId);
    try{await store.update(projectId,latest.revision,p=>{p.exports.push({exportId,kind,revision:project.revision,relativeDirectory:path.relative(base,directory).split(path.sep).join('/'),createdAt});return p;});return receipt;}
    catch(error){if(!(error instanceof FourTigerError)||error.code!=='REVISION_CONFLICT')throw error;}
  }
  throw new FourTigerError('REVISION_CONFLICT','파일은 완성됐지만 출력 이력을 저장하지 못했습니다. 출력 폴더를 확인하세요.');
}
