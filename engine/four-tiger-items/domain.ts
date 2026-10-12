import { randomUUID } from 'node:crypto';
import { confirmedRules, defaultPolicies, elements, itemPatchSchema, policySchema, projectSchema, statNames, FourTigerError, type EffectDraft, type Element, type ExportKind, type Grade, type ItemDraft, type ItemPatch, type ItemReview, type PolicyKey, type PolicyValues, type ReviewAction, type SainGeomItemProject, type SpPreview, type ValidationReport } from '../../shared/four-tiger-items';
import { defaultIconStyle, itemSeeds } from '../../shared/four-tiger-item-seed';

export const gradePrice=(grade:Grade):number=>confirmedRules.gradePrices[grade-1];
export function describeEffects(effects:EffectDraft[]):string {
  return effects.map(e=>`${e.trigger==='formSwitchSucceeded'?`전환 성공 후 ${e.durationSeconds}초 동안`:'보유 중'} ${e.targetForms==='all'?'모든 폼':e.targetForms.join('/')} ${statNames[e.stat]} ${e.amount>=0?'+':''}${Number((e.amount*(e.unit==='ratio'?100:1)).toFixed(4))}${e.unit==='ratio'?'%':e.unit==='SPPerSecond'?' SP/초':' SP'}`).join(', ');
}
export const blankReview=(now:string):ItemReview=>({state:'draft',dataRevision:null,iconVersion:null,policyRevision:null,note:'',updatedAt:now});
export function createInitialProject(input:{projectId:string;name:string;now:string}):SainGeomItemProject {
  const items:ItemDraft[]=itemSeeds.map(seed=>({candidateKey:randomUUID(),itemId:seed.itemId,name:seed.name,description:describeEffects(seed.effects),descriptionStale:false,element:seed.element,grade:seed.grade,purchasePrice:gradePrice(seed.grade),effects:structuredClone(seed.effects),unsupportedEffectNotes:'',synergyTags:[`ITEM_${seed.element.toUpperCase()}`],iconPrompt:seed.motif,iconKey:`icon.${seed.itemId}`,icons:[],selectedIconVersion:null,contentRevision:1,review:blankReview(input.now)}));
  return projectSchema.parse({schemaVersion:1,projectId:input.projectId,name:input.name,revision:0,createdAt:input.now,updatedAt:input.now,
    sourceRefs:[{repository:'lala11112/Four-Tiger-Sword',branch:'codex/system-design-2026-10-07',commit:'fe533a25a0df81eb317059ee18708229d63320ad',document:'docs/planning/2026-10-07-roguelike-direction.md',status:'confirmed'},{repository:'lala11112/Four-Tiger-Sword',branch:'codex/system-design-2026-10-07',commit:'fe533a25a0df81eb317059ee18708229d63320ad',document:'docs/planning/2026-10-07-initial-content-draft.md',status:'proposal'},{repository:'lala11112/studio-baekho-tools',branch:'integration/baekho-studio',commit:'5d0cb0f416184d4752ebe6667152cc74fdd0b697',document:'AGENTS.md',status:'implementation'}],
    items,ruleProfile:{confirmed:structuredClone(confirmedRules),proposed:{...defaultPolicies},revision:1,adoptions:{}},iconStyle:defaultIconStyle,jobs:[],reviewHistory:[],exports:[],
    synergyReferences:elements.map(element=>({id:`SYN_${element.toUpperCase()}_01`,items:items.filter(i=>i.element===element&&i.grade<=2).map(i=>({candidateKey:i.candidateKey,itemId:i.itemId,originalId:i.itemId}))})),
  });
}
export const validItemId=(value:string):boolean=>/^[A-Z][A-Z0-9_]{0,63}$/.test(value)&&!/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(value);
const allPoliciesAdopted=(p:SainGeomItemProject)=>Object.keys(p.ruleProfile.proposed).every(key=>p.ruleProfile.adoptions[key]?.revision===p.ruleProfile.revision);
export function validateProject(p:SainGeomItemProject,mode:ExportKind):ValidationReport {
  const issues:ValidationReport['issues']=[];
  const issue=(code:string,message:string,field:string,candidateKey:string|null=null,severity:'error'|'warning'='error')=>issues.push({code,message,field,candidateKey,severity});
  const parsed=projectSchema.safeParse(p);
  if(!parsed.success)issue('INVALID_SCHEMA','저장 데이터 구조를 확인하세요.','project');
  if(p.items.length!==20||new Set(p.items.map(i=>`${i.element}:${i.grade}`)).size!==20)issue('INCOMPLETE_SET','5오행 × 1~4등급, 총20개가 필요합니다.','items');
  const ids=new Set<string>();const keys=new Set<string>();
  for(const item of p.items) {
    const key=item.candidateKey;
    if(!validItemId(item.itemId)||ids.has(item.itemId.toUpperCase()))issue('INVALID_ID','ID는 영문 대문자/숫자/밑줄이며 중복·예약명을 사용할 수 없습니다.','itemId',key);
    ids.add(item.itemId.toUpperCase());
    if(keys.has(key))issue('DUPLICATE_CANDIDATE','항목 내부 식별자가 중복됩니다.','candidateKey',key);keys.add(key);
    if(!item.name.trim()||!item.description.trim()||!item.effects.length)issue('REQUIRED_CONTENT','이름·설명·효과가 필요합니다.','name',key);
    if(item.purchasePrice!==gradePrice(item.grade))issue('PRICE_MISMATCH','가격은 등급에서 계산됩니다.','purchasePrice',key);
    if(item.iconKey!==`icon.${item.itemId}`)issue('ICON_KEY_MISMATCH','아이콘 키가 현재 ID와 다릅니다.','iconKey',key);
    if(item.unsupportedEffectNotes.trim())issue('UNSUPPORTED_EFFECT','메모의 효과는 아직 지원되지 않습니다.','unsupportedEffectNotes',key);
    if(item.descriptionStale)issue('DESCRIPTION_STALE','수정된 효과에 맞게 설명을 재생성하거나 확인하세요.','description',key);
    const icon=item.icons.find(i=>i.versionId===item.selectedIconVersion);
    if(!icon)issue('ICON_MISSING','아이콘을 생성하고 선택하세요.','selectedIconVersion',key);
    else if(icon.contentRevision!==item.contentRevision)issue('ICON_STALE','수정 전 내용으로 만든 아이콘입니다. 재생성 후 검토하세요.','selectedIconVersion',key);
    if(item.review.state!=='adopted'||item.review.dataRevision!==item.contentRevision||item.review.iconVersion!==item.selectedIconVersion||item.review.policyRevision!==p.ruleProfile.revision)issue('ITEM_REVIEW_REQUIRED','현재 데이터와 아이콘을 검토·채택하세요.','review',key);
  }
  for(const ref of p.synergyReferences)for(const target of ref.items)if(p.items.find(i=>i.candidateKey===target.candidateKey)?.itemId!==target.itemId)issue('REFERENCE_STALE','변경된 ID의 시너지 참조를 명시적으로 갱신하세요.','itemId',target.candidateKey);
  if(!allPoliciesAdopted(p))issue('POLICY_REVIEW_REQUIRED','제안 정책을 검토·채택하세요.','ruleProfile');
  issue('SMALL_POOL','한 오행은 최대4개입니다. 5칸 미달·후보 없음은 정상 기획 경계입니다.','items',null,'warning');
  const blocking=issues.some(i=>i.severity==='error'&&(mode==='release'||i.code==='INVALID_SCHEMA'||i.code==='DUPLICATE_CANDIDATE'));
  return {projectId:p.projectId,revision:p.revision,mode,issues,canExport:!blocking};
}
function find(p:SainGeomItemProject,key:string):ItemDraft {const item=p.items.find(i=>i.candidateKey===key);if(!item)throw new FourTigerError('INVALID_INPUT','아이템을 찾을 수 없습니다.');return item;}
function history(p:SainGeomItemProject,item:ItemDraft|null,action:string,note:string,now:string) {p.reviewHistory.push({candidateKey:item?.candidateKey??null,action,note,at:now,contentRevision:item?.contentRevision??0,policyRevision:p.ruleProfile.revision});}
export function patchItem(project:SainGeomItemProject,key:string,patch:ItemPatch,now:string):SainGeomItemProject {
  const checked=itemPatchSchema.parse(patch),p=structuredClone(project),item=find(p,key);
  if(Object.keys(checked).length===0)return p;
  const effectsChanged=checked.effects!==undefined&&JSON.stringify(checked.effects)!==JSON.stringify(item.effects);
  Object.assign(item,checked);item.purchasePrice=gradePrice(item.grade);item.iconKey=`icon.${item.itemId}`;
  item.contentRevision++;item.review=blankReview(now);if(effectsChanged)item.descriptionStale=true;
  history(p,item,'edit','',now);return p;
}
export function acknowledgeDescription(project:SainGeomItemProject,key:string,regenerate:boolean,now:string):SainGeomItemProject {
  let p=structuredClone(project);let item=find(p,key);
  if(regenerate){p=patchItem(p,key,{description:describeEffects(item.effects)},now);item=find(p,key);}
  item.descriptionStale=false;history(p,item,'descriptionChecked','',now);return p;
}
export function reviewItem(project:SainGeomItemProject,key:string,action:ReviewAction,note:string,now:string):SainGeomItemProject {
  const p=structuredClone(project),item=find(p,key),icon=item.icons.find(v=>v.versionId===item.selectedIconVersion);
  if(action==='reset'||action==='hold'){item.review=blankReview(now);if(action==='hold')item.review.state='held';}
  else {
    if(action==='reviewData') {
      if(item.descriptionStale)throw new FourTigerError('REVIEW_REQUIRED','설명을 먼저 확인하세요.');
      const errors=validateProject(p,'release').issues.filter(i=>i.candidateKey===key&&i.severity==='error'&&!['ICON_MISSING','ICON_STALE','ITEM_REVIEW_REQUIRED'].includes(i.code));
      if(errors.length)throw new FourTigerError('REVIEW_REQUIRED',errors[0].message);
      item.review.dataRevision=item.contentRevision;
    }
    if(action==='reviewIcon') {
      if(!icon||icon.contentRevision!==item.contentRevision)throw new FourTigerError('REVIEW_REQUIRED','현재 내용의 아이콘을 생성하고 선택하세요.');
      item.review.iconVersion=icon.versionId;
      const job=p.jobs.find(j=>j.jobId===icon.jobId);if(job)job.status='reviewed';
    }
    const reviewed=item.review.dataRevision===item.contentRevision&&!!icon&&item.review.iconVersion===item.selectedIconVersion;
    item.review.state=reviewed?'reviewed':'draft';
    if(action==='adopt') {
      if(!reviewed)throw new FourTigerError('REVIEW_REQUIRED','데이터와 아이콘을 먼저 검토하세요.');
      if(!allPoliciesAdopted(p))throw new FourTigerError('REVIEW_REQUIRED','제안 정책을 먼저 채택하세요.');
      item.review.state='adopted';item.review.policyRevision=p.ruleProfile.revision;
    }
  }
  item.review.note=note;item.review.updatedAt=now;history(p,item,action,note,now);return p;
}
export function updatePolicies(project:SainGeomItemProject,patch:Partial<PolicyValues>,now:string):SainGeomItemProject {
  const p=structuredClone(project);p.ruleProfile.proposed=policySchema.parse({...p.ruleProfile.proposed,...policySchema.partial().strict().parse(patch)});
  p.ruleProfile.revision++;p.ruleProfile.adoptions={};for(const i of p.items)i.review=blankReview(now);history(p,null,'policyEdit','',now);return p;
}
export function adoptPolicies(project:SainGeomItemProject,keys:PolicyKey[],now:string):SainGeomItemProject {
  const p=structuredClone(project);for(const key of keys){if(!(key in p.ruleProfile.proposed))throw new FourTigerError('INVALID_INPUT','알 수 없는 정책입니다.');p.ruleProfile.adoptions[key]={revision:p.ruleProfile.revision,at:now};}history(p,null,'policyAdopt',keys.join(', '),now);return p;
}
export function updateIconStyle(project:SainGeomItemProject,style:string,now:string):SainGeomItemProject {
  const p=structuredClone(project);if(style.length>12000)throw new FourTigerError('INVALID_INPUT','화풍 설명이 너무 깁니다.');p.iconStyle=style;
  for(const item of p.items){item.contentRevision++;item.review=blankReview(now);}history(p,null,'iconStyleEdit','',now);return p;
}
export function repairReferenceIds(project:SainGeomItemProject,now:string):SainGeomItemProject {
  const p=structuredClone(project);for(const ref of p.synergyReferences)for(const target of ref.items)target.itemId=find(p,target.candidateKey).itemId;
  history(p,null,'referencesRepaired','',now);return p;
}
export function previewSp(project:SainGeomItemProject,form:Element,timedBuffs:boolean):SpPreview {
  const sum=(stat:EffectDraft['stat'])=>project.items.flatMap(i=>i.effects).filter(e=>e.stat===stat&&(e.trigger==='whileOwned'||timedBuffs)&&(e.targetForms==='all'||e.targetForms.includes(form))).reduce((n,e)=>n+e.amount,0);
  const p=project.ruleProfile.proposed;
  return {maxSp:Math.min(p.maxSpCap,100+sum('maxSp')),regenPerSecond:Math.min(p.regenCap,20+sum('spRegen')),dodgeCost:Math.max(p.minDodgeCost,20+sum('dodgeSpCost')),switchCost:Math.max(p.minSwitchCost,10+sum('switchSpCost')),proposal:true};
}
export function eligibleItemIds(project:SainGeomItemProject,ownedIds:string[],element:Element,grade?:Grade):string[] {return project.items.filter(i=>i.element===element&&(!grade||i.grade===grade)&&!ownedIds.includes(i.itemId)).map(i=>i.itemId);}
