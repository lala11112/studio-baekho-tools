import './style.css';
import type {AssetEntry,AssetRef,AttackConfig,Catalog,Connection,EnemyBlueprint,FieldSchema,ValidationIssue,AiStatus,AiProvider,AnimationInfo,AiConceptResult,ModelAnalysis,MonsterKind,BossPhaseConfig} from './shared/types';
import {emptyBlueprint,localIssues,defaultMoveBlend,moveBlendActive,defaultBossPhase,normalizeBlueprint} from './shared/blueprint';

const themeStorageKey = 'baekho.enemyForge.theme';
type Theme = 'light' | 'dark';

function savedTheme(): Theme {
  try {
    return localStorage.getItem(themeStorageKey) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function themePicker() {
  const dark = document.documentElement.dataset.theme === 'dark';
  return `<fieldset class="theme-picker">
    <legend class="visually-hidden">화면 테마</legend>
    <label><input type="radio" name="theme" value="light" ${dark ? '' : 'checked'}><span><i aria-hidden="true">☼</i>일반 모드</span></label>
    <label><input type="radio" name="theme" value="dark" ${dark ? 'checked' : ''}><span><i aria-hidden="true">☾</i>야간 모드</span></label>
  </fieldset>`;
}

document.documentElement.dataset.theme = savedTheme();

const api=window.forge;
let kind:MonsterKind='normal',initialized=false,blueprint=emptyBlueprint(),catalog:Catalog|null=null,connection:Connection|null=null;
let tab='appearance',busy=false,dirty=false,message='Unity 프로젝트에 연결해 제작을 시작하세요.',issues:ValidationIssue[]=[],selectedAttack='',aiStatus:AiStatus|null=null,aiPrompt='',aiModel='',lastOutput='';
const aiProvider=():AiProvider=>aiStatus?.provider??'codex';
const aiEngineField=()=>`<label class="field"><span>AI 엔진</span><select id="ai-provider" ${busy?'disabled':''}><option value="codex" ${aiProvider()==='codex'?'selected':''}>Codex (ChatGPT)</option><option value="claude" ${aiProvider()==='claude'?'selected':''}>Claude Code</option></select></label>`;
async function switchProvider(provider:AiProvider){try{aiModel='';aiStatus=await api.aiSetProvider(provider);}catch(e){setMessage(e instanceof Error?e.message:String(e));}renderInspector();setBusy(busy);}
let session='',sessionRevision=0,frameRevision=0,frameBusy=false,previewDirty=true,sequence=0,previewImage='',previewWarning='',previewState='Idle',playing=false,loop=true,time=0,speed=1,yaw=25,pitch=12,zoom=1,showHitboxes=true,lastTick=0,lastRequest=0;
let animationInfo:AnimationInfo|null=null,animationInfoKey='',animationInfoRevision=0,conceptPrompt='',conceptResult:AiConceptResult|null=null;
let moveParameters=[0,0],placementKey='',placementRevision=0,placementWarning='',placementTimer:ReturnType<typeof setTimeout>|undefined;
const log:string[]=[];
interface DraftState {
  blueprint:EnemyBlueprint;catalog:Catalog|null;initialized:boolean;tab:string;dirty:boolean;message:string;issues:ValidationIssue[];selectedAttack:string;
  aiPrompt:string;conceptPrompt:string;conceptResult:AiConceptResult|null;lastOutput:string;log:string[];
  previewState:string;time:number;speed:number;loop:boolean;yaw:number;pitch:number;zoom:number;showHitboxes:boolean;moveParameters:number[];
}
const drafts:Partial<Record<MonsterKind,DraftState>>={};
function stashDraft(){drafts[kind]={blueprint,catalog,initialized,tab,dirty,message,issues,selectedAttack,aiPrompt,conceptPrompt,conceptResult,lastOutput,log:[...log],previewState,time,speed,loop,yaw,pitch,zoom,showHitboxes,moveParameters:[...moveParameters]};}
function restoreDraft(next:MonsterKind){
  kind=next;const draft=drafts[next];
  blueprint=draft?.blueprint??emptyBlueprint(next);catalog=draft?.catalog??null;initialized=draft?.initialized??false;tab=draft?.tab??'appearance';dirty=draft?.dirty??false;
  message=draft?.message??'Unity 프로젝트에 연결해 제작을 시작하세요.';issues=draft?.issues??[];selectedAttack=draft?.selectedAttack??'';aiPrompt=draft?.aiPrompt??'';conceptPrompt=draft?.conceptPrompt??'';conceptResult=draft?.conceptResult??null;lastOutput=draft?.lastOutput??'';log.splice(0,log.length,...(draft?.log??[]));
  previewState=draft?.previewState??'Idle';time=draft?.time??0;speed=draft?.speed??1;loop=draft?.loop??true;yaw=draft?.yaw??25;pitch=draft?.pitch??12;zoom=draft?.zoom??1;showHitboxes=draft?.showHitboxes??true;moveParameters=[...(draft?.moveParameters??[0,0])];
  animationInfo=null;animationInfoKey='';placementKey='';placementWarning='';
}
function hasDirtyDraft(){return dirty||Object.entries(drafts).some(([draftKind,draft])=>draftKind!==kind&&draft?.dirty);}
async function leaveDraft(){
  clearTimeout(placementTimer);placementRevision++;animationInfoRevision++;sessionRevision++;frameRevision++;frameBusy=false;playing=false;
  searchSequence++;clearTimeout(searchTimer);assetCallback=null;document.querySelector<HTMLDialogElement>('#asset-dialog')?.close();
  const prior=session;session='';clearPreview();if(prior)await api.previewClose(prior).catch(()=>{});
}
async function switchKind(next:MonsterKind){
  if(next===kind)return;stashDraft();await leaveDraft();restoreDraft(next);render();
  if(connection){const heldTime=time;await loadCatalog();time=heldTime;previewDirty=true;}
}
const fieldHandlers=new Map<string,(v:string)=>void>();let fieldIndex=0;
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
const same=(a:AssetRef|null|undefined,b:AssetRef|null|undefined)=>!!a&&!!b&&a.guid===b.guid&&a.localId===b.localId;
const tabs=[['appearance','외형','◇'],['stats','능력치','▤'],['movement','이동·감지','◎'],['attacks','공격','↗'],['animation','애니메이션','▷'],['concept','AI 몬스터 컨셉','✧'],['ai','AI 공격 제작','✳']];
function visibleTabs(){return kind==='boss'?[...tabs.slice(0,4),['phases','페이즈·패턴','▥'],['boss-combat','전투·보상','♜'],...tabs.slice(4)]:tabs;}
const labels:Record<string,string>={elementType:'속성',maxHp:'최대 체력',baseAtk:'공격력',baseDef:'방어력',criticalChance:'치명타 확률',criticalDamage:'치명타 배율',combatRange:'전투 진입 거리',combatExitRange:'전투 이탈 거리',attackCooldown:'공통 공격 대기',staggerResistLevel:'경직 등급',knockbackMoveTime:'넉백 이동 시간',knockbackMaxDistance:'최대 넉백 거리',animName:'애니메이터 상태명',engageRange:'공격 선택 거리',executeRange:'공격 실행 거리',minimumRange:'최소 거리',preferredRange:'선호 거리',weight:'선택 가중치',cooldown:'재사용 대기',repeatWeightMultiplier:'연속 사용 가중치',attackSpeed:'공격 속도',isParryable:'패링 가능',telegraphDuration:'예고 시간',damage:'공격력 배율',knockbackForce:'넉백 힘',hitStartTime:'판정 시작',hitDuration:'판정 지속',attackDuration:'전체 공격 시간',hitBoxShape:'판정 모양',hitBoxOffset:'판정 위치',hitBoxRadius:'판정 반경',hitBoxSize:'판정 크기',hitBoxHeight:'판정 높이',SwingAudio:'공격 소리',HitAudio:'타격 소리',LandingAudio:'착지 소리',Clip:'오디오',Accent:'보조 오디오',Volume:'음량',AccentVolume:'보조 음량',PitchRange:'피치 범위',_range:'감지 거리',_halfAngle:'시야 반각',_proximityRange:'근접 감지 거리',_heightOffset:'감지 높이',_visibilityMask:'시야 장애물 마스크',_rayCount:'시야 표시선 수',_targetMemoryDuration:'목표 기억 시간',HurtDuration:'피격 지속',GroggyDuration:'그로기 지속',RootDuration:'속박 지속',ApproachTimeout:'접근 제한 시간',ApproachStuckTimeout:'정체 판단 시간',FailedAttackRetryDelay:'실패 후 재시도',m_Speed:'이동 속도',m_Acceleration:'가속도',m_AngularSpeed:'회전 속도',m_Radius:'반경',m_Height:'높이',m_BaseOffset:'높이 보정',m_StoppingDistance:'정지 거리',m_Center:'중심',_maxPoise:'최대 강인도',_poiseRegen:'강인도 재생',_breakDuration:'강인도 파괴 시간',_delay:'사망 후 대기',_duration:'사망 처리 시간',useHpRatio:'체력 비율 조건',hpRatioThreshold:'발동 체력 비율',hpThreshold:'발동 체력',explosionDelay:'폭발 대기',explosionRadius:'폭발 반경',explosionOffset:'폭발 위치',warningEffectPrefab:'경고 효과',explosionEffectPrefab:'폭발 효과',hits:'연속 타격',startupTime:'준비 시간',dashDuration:'돌진 시간',dashSpeed:'돌진 속도',recoveryTime:'후딜레이',jumpHeight:'점프 높이',jumpDuration:'비행 시간',slamRadius:'착지 반경'};
const componentLabels:Record<string,string>={Enemy:'행동·반응',NavMeshAgent:'이동',FanVisionSensor:'감지',SphereCollider:'몸체 충돌',CapsuleCollider:'몸체 충돌',PoiseHandler:'강인도',EnemyDeathFade:'사망 처리'};
function setMessage(text:string){message=text;const el=document.querySelector('#status-text');if(el)el.textContent=text;}
function changed(){if(blueprint.kind==='boss'&&blueprint.boss)blueprint.stats.maxHp=Math.max(1,Math.round(blueprint.boss.phases.reduce((sum,phase)=>sum+phase.phaseMaxHp,0)));dirty=true;previewDirty=true;issues=[];updateTop();renderIssues();schedulePlacement();}
function updateTop(){document.querySelector('#dirty')!.textContent=dirty?'수정됨':'저장됨';document.querySelector('#enemy-title')!.textContent=blueprint.name;}
function control(handler:(v:string)=>void){const id=`f${++fieldIndex}`;fieldHandlers.set(id,handler);return id;}
function assetButton(value:AssetRef|null|undefined,handler:(a:AssetRef|null)=>void,kinds:string[]){const id=control(()=>chooseAsset(kinds,value??null,handler));return `<button class="asset-input" data-asset="${id}" title="${esc(value?.path??'프로젝트 에셋 선택')}"><span class="asset-symbol">◇</span><span>${esc(value?.name??'에셋 선택')}</span><span class="muted">↗</span></button>`;}
function kindsFor(type?:string){if(/AnimationClip/.test(type??''))return ['AnimationClip'];if(/AnimatorController|RuntimeAnimatorController/.test(type??''))return ['AnimatorController'];if(/AudioClip/.test(type??''))return ['AudioClip'];if(/Material/.test(type??''))return ['Material'];if(/GameObject|Transform/.test(type??''))return ['Model','GameObject'];return [];}
function field(schema:FieldSchema,value:any,set:(v:any)=>void):string{
  const label=labels[schema.path]??schema.label??schema.path, tip=schema.tooltip??schema.path;
  const wrap=(html:string)=>`<label class="field" title="${esc(tip)}"><span>${esc(label)}${schema.percent?' <small>%</small>':''}</span>${html}</label>`;
  if(schema.type==='asset')return wrap(assetButton(value,a=>{set(a);changed();renderInspector();},kindsFor(schema.assetType)));
  if(schema.type==='object'){return `<details class="subgroup"><summary>${esc(label)}</summary>${(schema.children??[]).map(c=>field(c,value?.[c.path],v=>{const next={...(value??{})};next[c.path]=v;set(next);value=next;})).join('')}</details>`;}
  if(schema.type==='array'){
    const items=Array.isArray(value)?value:[];const add=control(()=>{const children=schema.children??[];set([...items,schema.element?defaultValue(schema.element):children.length?Object.fromEntries(children.map(c=>[c.path,defaultValue(c)])):0]);changed();renderInspector();});
    return `<details class="subgroup" open><summary>${esc(label)} <span class="count">${items.length}</span></summary>${items.map((item,index)=>{const remove=control(()=>{set(items.filter((_,i)=>i!==index));changed();renderInspector();});return `<div class="array-item"><div class="row between"><small>항목 ${index+1}</small><button class="icon-button danger" data-asset="${remove}" title="항목 삭제">×</button></div>${(schema.element?[schema.element]:schema.children?.length?schema.children:[{path:'value',label:'값',type:'number'} as FieldSchema]).map(c=>field(c,schema.element?item:typeof item==='object'?item?.[c.path]:item,v=>{const next=clone(items);if(!schema.element&&typeof item==='object'&&item!==null)next[index][c.path]=v;else next[index]=v;items[index]=next[index];set(next);})).join('')}</div>`;}).join('')}<button class="secondary small" data-asset="${add}">+ 항목 추가</button></details>`;
  }
  if(['vector2','vector3','color'].includes(schema.type)){
    const axes=schema.type==='vector2'?['x','y']:schema.type==='color'?['r','g','b','a']:['x','y','z'];
    return wrap(`<div class="vector">${axes.map((axis,i)=>{const id=control(raw=>{const next=Array.isArray(value)?[...value]:{...value};if(Array.isArray(next))next[i]=Number(raw);else next[axis]=Number(raw);value=next;set(next);changed();});return `<label><small>${axis.toUpperCase()}</small><input type="number" step="0.1" data-field="${id}" value="${esc(Array.isArray(value)?value[i]:value?.[axis]??0)}"></label>`;}).join('')}</div>`);
  }
  const id=control(raw=>{let v:any=raw;if(schema.type==='number'||schema.type==='integer'){v=Number(raw)/(schema.percent?100:1);if(!Number.isFinite(v))return;if(schema.type==='integer')v=Math.round(v);}if(schema.type==='boolean')v=raw==='true';if(schema.type==='enum')v=Number(raw);set(v);changed();});
  if(schema.type==='boolean')return `<label class="toggle-field" title="${esc(tip)}"><span>${esc(label)}</span><input type="checkbox" data-field="${id}" ${value?'checked':''}><i></i></label>`;
  if(schema.type==='enum')return wrap(`<select data-field="${id}">${(schema.options??[]).map(o=>`<option value="${o.value}" ${value===o.value?'selected':''}>${esc(o.label)}</option>`).join('')}</select>`);
  if(schema.type==='unsupported')return wrap(`<span class="muted">지원하지 않는 필드</span>`);
  const numeric=schema.type==='number'||schema.type==='integer';return wrap(`<input ${numeric?'type="number" step="'+(schema.type==='integer'?'1':'any')+'"':'type="text"'} data-field="${id}" value="${esc(numeric&&schema.percent?Number(value??0)*100:value??'')}" ${schema.min!==undefined?`min="${schema.min*(schema.percent?100:1)}"`:''} ${schema.max!==undefined?`max="${schema.max*(schema.percent?100:1)}"`:''}>`);
}
function defaultValue(f:FieldSchema):any{if(f.type==='asset')return null;if(f.type==='object')return Object.fromEntries((f.children??[]).map(c=>[c.path,defaultValue(c)]));if(f.type==='array')return [];if(f.type==='boolean')return false;if(f.type==='string')return '';if(f.type==='vector3')return[0,0,0];if(f.type==='vector2')return[0,0];if(f.type==='color')return[1,1,1,1];return f.min??0;}
function vec(label:string,value:number[],set:(n:number[])=>void){return field({path:label,label,type:'vector3'},value,set);}
function fields(schemas:FieldSchema[],values:any){return schemas.map(f=>field(f,values[f.path],v=>values[f.path]=v)).join('');}
function attacks(){return [...blueprint.attacks,...(blueprint.selfDestruct?[blueprint.selfDestruct]:[])];}
function chosenAttack(){return attacks().find(a=>a.id===selectedAttack)??null;}
function attackName(a:AttackConfig){return catalog?.attacks.find(d=>d.typeId===a.typeId)?.name??a.typeId;}
function modelKey(){return JSON.stringify([connection?.projectRoot,blueprint.model,blueprint.template,blueprint.modelTransform]);}
function applyAutomaticPositions(result:ModelAnalysis){
  if(!result.bounds)return;let applied=false;
  for(const [kind,key]of [['hpBar','hpBarPosition'],['vfx','vfxPosition']] as const)if(blueprint.anchors?.[kind]==='auto'&&JSON.stringify(blueprint[key])!==JSON.stringify(result[key])){blueprint[key]=[...result[key]];applied=true;}
  if(applied)changed();
}
function schedulePlacement(force=false){
  if(!connection||!blueprint.model||(!force&&placementKey===modelKey())||!Object.values(blueprint.anchors??{}).includes('auto'))return;
  if(force)placementKey='';
  clearTimeout(placementTimer);const revision=++placementRevision,key=modelKey(),snapshot=clone(blueprint);
  placementTimer=setTimeout(()=>{void api.analyzeModel(snapshot).then(result=>{
    if(revision!==placementRevision||key!==modelKey())return;
    placementKey=result.bounds?key:'';placementWarning=result.warnings.join(' ');
    applyAutomaticPositions(result);
    if(tab==='appearance'){renderInspector();setBusy(busy);}
  }).catch(error=>{if(revision!==placementRevision)return;placementKey='';placementWarning=error.message;if(tab==='appearance'){renderInspector();setBusy(busy);}});},200);
}
async function settlePlacement(){
  if(!connection||!blueprint.model||placementKey===modelKey()||!Object.values(blueprint.anchors??{}).includes('auto'))return;
  // Save/build must use the latest geometry even when the model-edit debounce has not fired yet.
  clearTimeout(placementTimer);const revision=++placementRevision,key=modelKey();
  try{
    const result=await api.analyzeModel(clone(blueprint));if(revision!==placementRevision||key!==modelKey())return;
    placementKey=result.bounds?key:'';placementWarning=result.warnings.join(' ');
    applyAutomaticPositions(result);
  }catch(error){if(revision!==placementRevision)return;placementKey='';placementWarning=(error as Error).message;}
  finally{if(revision===placementRevision&&tab==='appearance'){renderInspector();setBusy(busy);}}
}
function anchorControls(kind:'hpBar'|'vfx',label:string){
  const mode=blueprint.anchors?.[kind]??'manual',key=kind==='hpBar'?'hpBarPosition':'vfxPosition';
  const id=control(value=>{blueprint.anchors??={hpBar:'manual',vfx:'manual'};blueprint.anchors[kind]=value as 'auto'|'manual';changed();if(value==='auto')schedulePlacement(true);});
  return `<label class="field"><span>${label} 위치 모드</span><select data-field="${id}" data-anchor-mode="${kind}"><option value="auto" ${mode==='auto'?'selected':''}>자동 배치</option><option value="manual" ${mode==='manual'?'selected':''}>수동 위치</option></select></label>${vec(label,blueprint[key],v=>{blueprint[key]=v;blueprint.anchors??={hpBar:'manual',vfx:'manual'};blueprint.anchors[kind]='manual';const select=document.querySelector<HTMLSelectElement>(`[data-anchor-mode="${kind}"]`);if(select)select.value='manual';})}`;
}
async function refreshAnimationInfo(){
  const controller=blueprint.animation.controller,key=JSON.stringify([connection?.projectRoot,controller]);if(!connection||key===animationInfoKey)return;
  const revision=++animationInfoRevision;animationInfoKey=key;animationInfo=null;
  if(!controller){animationInfo={parameters:[{name:'DirX',type:'Float'},{name:'DirY',type:'Float'}],move:null,warnings:[]};return;}
  try{const info=await api.animationInfo(controller);if(revision!==animationInfoRevision||key!==JSON.stringify([connection?.projectRoot,blueprint.animation.controller]))return;animationInfo=info;}
  catch(error){if(revision!==animationInfoRevision)return;animationInfo={parameters:[],move:null,warnings:[(error as Error).message]};animationInfoKey='';}
  if(tab==='animation'){renderInspector();setBusy(busy);}
}
function enableBlend(){
  const move=animationInfo?.move?clone(animationInfo.move):defaultMoveBlend(Number(blueprint.components.NavMeshAgent?.m_Speed));
  if(!animationInfo?.move){move.children[0].clip=blueprint.animation.states.Idle??null;move.children[1].clip=blueprint.animation.states.Move??null;}
  move.overrideController=blueprint.animation.mode==='controller';blueprint.animation.move=move;moveParameters=[0,0];changed();renderInspector();updatePreviewControls();
}
function moveEditor(){
  const move=blueprint.animation.move,controller=blueprint.animation.mode==='controller',preserve=controller&&!move?.overrideController;
  const override=control(value=>{if(!blueprint.animation.move)enableBlend();blueprint.animation.move!.overrideController=value==='true';changed();renderInspector();updatePreviewControls();});
  const enable=control(()=>enableBlend());
  let html=`<div class="section-line">Move · 방향 2D</div>${controller?`<label class="toggle-field"><span>복제본의 Move 트리 재정의</span><input type="checkbox" data-field="${override}" ${!preserve?'checked':''}><i></i></label>`:''}`;
  if(preserve)return html+'<p class="hint">원본 컨트롤러의 Move를 유지합니다. 재정의를 켜면 아래에서 설정한 2D 트리를 복제본에 적용합니다.</p>';
  if(!move)return html+`<p class="hint">이 설계는 기존 단일 Move 클립을 사용합니다.</p><button class="secondary" data-asset="${enable}">방향 2D 블렌드 트리로 전환</button>`;
  const parameters=[...new Set(['DirX','DirY',...(animationInfo?.parameters.filter(p=>p.type.toLowerCase()==='float').map(p=>p.name)??[])])];
  html+='<p class="hint">방향마다 클립 하나를 지정하세요. X는 좌우, Y는 전후 이동속도(m/s)입니다. (0, 0)은 정지 클립입니다.</p>';
  html+=`<datalist id="move-parameters">${parameters.map(p=>`<option value="${esc(p)}"></option>`).join('')}</datalist>`;
  for(const [key,label] of [['parameterX','X 파라미터'],['parameterY','Y 파라미터']] as const){const id=control(value=>{move[key]=value;changed();});html+=`<label class="field"><span>${label}</span><input data-field="${id}" data-move-param="${key}" list="move-parameters" value="${esc(move[key])}" placeholder="Float 선택 / 새 이름"></label>`;}
  html+=move.children.map((child,index)=>{
    const remove=control(()=>{move.children.splice(index,1);changed();renderInspector();updatePreviewControls();});
    return `<div class="blend-child" data-blend-child="${index}"><div class="row between"><strong>방향 ${index+1}</strong><button class="icon-button danger" data-asset="${remove}" title="방향 삭제">×</button></div>${assetButton(child.clip,a=>{child.clip=a;changed();renderInspector();previewState='Move';time=0;updatePreviewControls();},['AnimationClip'])}${field({path:'position',label:'방향 좌표',type:'vector2'},child.position,v=>{child.position=v;updateMovePreview();})}${field({path:'timeScale',label:'재생 배속',type:'number',min:.01},child.timeScale,v=>child.timeScale=v)}</div>`;
  }).join('');
  const add=control(()=>{move.children.push({clip:null,position:[1,1],timeScale:1});changed();renderInspector();updatePreviewControls();});
  return html+`<button class="secondary small" data-asset="${add}" ${move.children.length>=32?'disabled':''}>+ 방향 클립 추가</button>${(animationInfo?.warnings??[]).map(w=>`<p class="hint">${esc(w)}</p>`).join('')}`;
}
function updateMovePreview(){
  const area=document.querySelector('#move-preview');if(!area)return;
  if(previewState!=='Move'||!moveBlendActive(blueprint)){area.innerHTML='';return;}
  const move=blueprint.animation.move!,extent=Math.max(1,...move.children.flatMap(c=>c.position.map(Math.abs)));
  area.innerHTML=`<div class="move-preview"><div class="move-pad" id="move-pad" role="group" aria-label="이동 방향 조절">${move.children.map(c=>`<span class="move-point" title="${esc(c.clip?.name??'미지정')}" style="left:${50+c.position[0]/extent*44}%;top:${50-c.position[1]/extent*44}%"></span>`).join('')}<i id="move-cursor" style="left:${50+moveParameters[0]/extent*44}%;top:${50-moveParameters[1]/extent*44}%"></i></div><div class="grow">${['X','Y'].map((axis,i)=>`<label class="move-axis"><span>${axis} · ${esc(i?move.parameterY:move.parameterX)}</span><input aria-label="Move ${axis}" id="move-preview-${i}" type="range" min="${-extent}" max="${extent}" step="0.01" value="${moveParameters[i]}"><output id="move-value-${i}">${moveParameters[i].toFixed(2)}</output></label>`).join('')}<button class="text-button" data-action="move-center">정지 (0, 0)</button></div></div>`;
  const pad=document.querySelector<HTMLElement>('#move-pad')!;let pressed=false;
  const drag=(event:PointerEvent)=>{const rect=pad.getBoundingClientRect();moveParameters=[Math.max(-extent,Math.min(extent,(event.clientX-rect.left-rect.width/2)/(rect.width*.44)*extent)),Math.max(-extent,Math.min(extent,(rect.height/2-event.clientY+rect.top)/(rect.height*.44)*extent))];syncMovePreview(extent);};
  pad.onpointerdown=event=>{pressed=true;pad.setPointerCapture(event.pointerId);drag(event);};pad.onpointermove=event=>{if(pressed)drag(event);};pad.onpointerup=()=>pressed=false;pad.onpointercancel=()=>pressed=false;
}
function syncMovePreview(extent?:number){
  const range=extent??Math.max(1,...(blueprint.animation.move?.children.flatMap(c=>c.position.map(Math.abs))??[]));previewDirty=true;
  for(let i=0;i<2;i++){const input=document.querySelector<HTMLInputElement>(`#move-preview-${i}`),output=document.querySelector(`#move-value-${i}`);if(input)input.value=String(moveParameters[i]);if(output)output.textContent=moveParameters[i].toFixed(2);}
  const cursor=document.querySelector<HTMLElement>('#move-cursor');if(cursor){cursor.style.left=`${50+moveParameters[0]/range*44}%`;cursor.style.top=`${50-moveParameters[1]/range*44}%`;}
}
function conceptEditor(){return `<p class="eyebrow">MONSTER CONCEPT</p><h2 class="ai-heading">컨셉으로 만드는<br>몬스터<span>✧</span></h2><p class="hint">${kind==='boss'?'능력치·이동·감지·공격과 보스 페이즈·패턴·전투 설정을 컨셉에 맞게 구성합니다.':'능력치·이동·감지·공격을 컨셉에 맞게 다시 구성합니다.'} 기존 공격으로 표현할 수 없는 동작은 새 공격으로 구현합니다.</p><div class="connection-card"><span class="dot ${aiStatus?.state==='ready'?'online':''}"></span><span>${esc(aiStatus?.message??'AI 연결을 확인하세요.')}</span><button class="text-button" data-action="ai-status">확인</button></div>${aiEngineField()}<div class="row"><button class="secondary small" data-action="ai-login">${aiProvider()==='claude'?'Claude 로그인':'ChatGPT 로그인'}</button><button class="secondary small" data-action="ai-select">실행 파일 선택</button></div><label class="field prompt-field"><span>몬스터의 컨셉</span><textarea id="concept-prompt" rows="7" maxlength="12000" placeholder="느리지만 단단한 바위 수호자. 좁은 시야를 가지며 가까이 온 적에게 강하게 내려찍고, 멀리 있는 적에게 바위를 던져 공격한다.">${esc(conceptPrompt)}</textarea></label><label class="field"><span>${aiProvider()==='claude'?'Claude':'Codex'} 모델</span><select id="ai-model"><option value="">사용자 기본 모델</option>${(aiStatus?.models??[]).map(m=>`<option value="${esc(m.id)}" ${m.id===aiModel?'selected':''}>${esc(m.name)}</option>`).join('')}</select></label><div class="row"><button class="primary grow" data-action="ai-concept">✧ 컨셉으로 자동 구성</button><button class="secondary" data-action="ai-cancel" ${!busy?'disabled':''}>취소</button></div><p class="hint">이름·모델·연결된 애니메이션과 수동 표시 위치를 유지합니다. 이동·감지는 현재 게임의 행동 설정을 사용합니다. 완성 후 설정을 수정하고 프리팹 생성을 누르세요.</p>${conceptResult?`<section class="concept-result"><h3>구성 결과</h3><p>${esc(conceptResult.summary)}</p>${conceptResult.reasons.map(r=>`<p>• ${esc(r)}</p>`).join('')}${conceptResult.warnings.map(w=>`<div class="issue"><p>${esc(w)}</p></div>`).join('')}</section>`:''}<div id="ai-log" class="log">${log.map(l=>`<div>${esc(l)}</div>`).join('')}</div>`;}
function choice(label:string,value:string,options:{value:string;label:string}[],set:(value:string)=>void){
  const id=control(raw=>{set(raw);changed();renderInspector();});
  return `<label class="field"><span>${esc(label)}</span><select data-field="${id}">${options.map(option=>`<option value="${esc(option.value)}" ${option.value===value?'selected':''}>${esc(option.label)}</option>`).join('')}</select></label>`;
}
function numberField(label:string,value:number,set:(value:number)=>void,min=0,max?:number){return field({path:label,label,type:'number',min,max},value,set);}
function editButton(label:string,handler:()=>void,disabled=false,extra=''){const id=control(handler);return `<button class="secondary small ${extra}" data-asset="${id}" ${disabled?'disabled':''}>${esc(label)}</button>`;}
function bossPhasesEditor(){
  const boss=blueprint.boss!;
  return `<p class="eyebrow">BOSS PHASES</p><p class="hint">페이즈는 목록 순서대로 진행합니다. HP를 모두 소진하면 쓰러지고, 무적 상태에서 자동으로 회복한 뒤 다음 페이즈를 시작합니다. 플레이어는 계속 움직일 수 있습니다. 총 HP는 페이즈 HP의 합계입니다. 공격 목록은 ‘공격’에서 먼저 구성하세요.</p>${boss.phases.map((phase,index)=>{
    const move=(offset:number)=>{[boss.phases[index],boss.phases[index+offset]]=[boss.phases[index+offset],boss.phases[index]];changed();renderInspector();};
    const remove=()=>{boss.phases.splice(index,1);changed();renderInspector();};
    const skills=phase.skillIds===null?'':`<div class="phase-skills">${blueprint.attacks.map(attack=>{const id=control(raw=>{phase.skillIds=raw==='true'?[...new Set([...(phase.skillIds??[]),attack.id])]:(phase.skillIds??[]).filter(value=>value!==attack.id);changed();});return `<label class="inline-check"><input type="checkbox" data-field="${id}" ${(phase.skillIds??[]).includes(attack.id)?'checked':''}>${esc(attackName(attack))} · ${esc(attack.values.animName)}</label>`;}).join('')||'<p class="hint">공격을 먼저 추가하세요.</p>'}${phase.skillIds.filter(id=>!blueprint.attacks.some(attack=>attack.id===id)).map(id=>`<p class="hint danger">연결이 끊긴 공격: ${esc(id)}</p>`).join('')}</div>`;
    return `<section class="phase-card" data-phase-index="${index}"><div class="row between"><strong>페이즈 ${index+1}</strong><div class="row">${editButton('↑',()=>move(-1),index===0)}${editButton('↓',()=>move(1),index===boss.phases.length-1)}${editButton('삭제',remove,boss.phases.length===1,'danger')}</div></div>${field({path:'phaseId',label:'페이즈 ID',type:'string'},phase.phaseId,value=>phase.phaseId=value)}${numberField('페이즈 HP',phase.phaseMaxHp,value=>phase.phaseMaxHp=value,.01)}${numberField('공격력 배율',phase.atkMultiplier,value=>phase.atkMultiplier=value)}${numberField('방어력 배율',phase.defMultiplier,value=>phase.defMultiplier=value)}${choice('페이즈 공격 목록',phase.skillIds===null?'inherit':'selected',[{value:'inherit',label:index===0?'기본 공격 목록 사용':'이전 페이즈 목록 유지'},{value:'selected',label:'공격 직접 선택'}],value=>phase.skillIds=value==='inherit'?null:blueprint.attacks.map(attack=>attack.id))}${skills}${choice('공격 패턴',phase.pattern.mode,[{value:'weighted',label:'가중치로 공격 선택'},{value:'sequence',label:'순서대로 실행'}],value=>phase.pattern.mode=value as 'weighted'|'sequence')}${phase.pattern.mode==='sequence'?sequenceEditor(phase):''}<details class="group" data-phase-details="${esc(phase.phaseId)}"><summary>보호막·BGM·메모</summary>${choice('페이즈 보호막',phase.shield===null?'keep':phase.shield===0?'remove':'replace',[{value:'keep',label:'현재 보호막 유지'},{value:'remove',label:'보호막 제거'},{value:'replace',label:'새 보호막 적용'}],value=>phase.shield=value==='keep'?null:value==='remove'?0:Math.max(1,boss.initialShield))}${phase.shield!==null&&phase.shield>0?numberField('보호막 수치',phase.shield,value=>phase.shield=value,1):''}${choice('페이즈 BGM',phase.music.mode,[{value:'keep',label:'현재 음악 유지'},{value:'play',label:'음악 재생'},{value:'stop',label:'음악 정지'}],value=>phase.music.mode=value as 'keep'|'play'|'stop')}${phase.music.mode==='play'?`<label class="field"><span>BGM 클립</span>${assetButton(phase.music.clip,value=>{phase.music.clip=value;changed();renderInspector();},['AudioClip'])}</label>${numberField('BGM 음량',phase.music.volume,value=>phase.music.volume=value,0,1)}`:''}${phase.music.mode!=='keep'?numberField('BGM 전환 시간',phase.music.fadeSeconds,value=>phase.music.fadeSeconds=value):''}${field({path:'note',label:'페이즈 메모',type:'string'},phase.note,value=>phase.note=value)}</details></section>`;
  }).join('')}${editButton('+ 페이즈 추가',()=>{const phase=defaultBossPhase(boss.phases.length);phase.phaseId=`phase_${crypto.randomUUID().slice(0,8)}`;boss.phases.push(phase);changed();renderInspector();},boss.phases.length>=16)}`;
}
function sequenceEditor(phase:BossPhaseConfig){
  const pattern=phase.pattern;
  return `<div class="sequence-editor">${field({path:'loop',label:'패턴 반복',type:'boolean'},pattern.loop,value=>pattern.loop=value)}${pattern.steps.map((step,index)=>{
    const move=(offset:number)=>{[pattern.steps[index],pattern.steps[index+offset]]=[pattern.steps[index+offset],pattern.steps[index]];changed();renderInspector();};
    const attacks=blueprint.attacks.map(attack=>({value:attack.id,label:`${attackName(attack)} · ${attack.values.animName}`}));
    return `<div class="sequence-step" data-step-index="${index}"><div class="row between"><strong>단계 ${index+1}</strong><div class="row">${editButton('↑',()=>move(-1),index===0)}${editButton('↓',()=>move(1),index===pattern.steps.length-1)}${editButton('×',()=>{pattern.steps.splice(index,1);changed();renderInspector();},false,'danger')}</div></div>${choice('단계 종류',step.kind,[{value:'attack',label:'공격'},{value:'wait',label:'대기'}],value=>step.kind=value as 'attack'|'wait')}${step.kind==='attack'?choice('실행할 공격',step.attackId??'',[{value:'',label:'공격 선택'},...attacks],value=>step.attackId=value||null):numberField('대기 시간',step.waitSeconds,value=>step.waitSeconds=value)}</div>`;
  }).join('')}<div class="row">${editButton('+ 공격 단계',()=>{pattern.steps.push({kind:'attack',attackId:blueprint.attacks[0]?.id??null,waitSeconds:0});changed();renderInspector();},pattern.steps.length>=64)}${editButton('+ 대기 단계',()=>{pattern.steps.push({kind:'wait',attackId:null,waitSeconds:1});changed();renderInspector();},pattern.steps.length>=64)}</div></div>`;
}
function bossCombatEditor(){
  const boss=blueprint.boss!,elements=catalog!.statsFields.find(schema=>schema.path==='elementType')?.options??[];
  const elementField=(label:string,value:number,set:(value:number)=>void)=>field({path:label,label,type:'enum',options:elements},value,set);
  return `<p class="eyebrow">BOSS COMBAT & REWARDS</p>${field({path:'enableWeakness',label:'약점 속성 사용',type:'boolean'},boss.enableWeakness,value=>boss.enableWeakness=value)}${elementField('약점 속성',boss.weaknessElement,value=>boss.weaknessElement=value)}${numberField('약점 피해 배율',boss.weakDamageMult,value=>boss.weakDamageMult=value)}${field({path:'enableResistance',label:'저항 속성 사용',type:'boolean'},boss.enableResistance,value=>boss.enableResistance=value)}${elementField('저항 속성',boss.resistElement,value=>boss.resistElement=value)}${numberField('저항 피해 배율',boss.resistDamageMult,value=>boss.resistDamageMult=value)}${numberField('그로기 피해 배율',boss.groggyDamageMult,value=>boss.groggyDamageMult=value)}${numberField('초기 보호막',boss.initialShield,value=>boss.initialShield=value)}<div class="section-line">페이즈 전환</div><p class="hint">기본 전환 시간은 총 3초입니다. 전환 중 보스는 무적입니다.</p>${numberField('쓰러지는 시간 (초)',boss.phaseDownSeconds,value=>boss.phaseDownSeconds=value,.01)}${numberField('다운 대기 시간 (초)',boss.phaseHoldSeconds,value=>boss.phaseHoldSeconds=value,0)}${numberField('일어나는 시간 (초)',boss.phaseReviveSeconds,value=>boss.phaseReviveSeconds=value,.01)}<div class="section-line">상태이상 면역</div><div class="phase-skills">${(catalog!.boss?.immunities??[]).map(immunity=>{const id=control(raw=>{boss.statusImmunityList=raw==='true'?[...new Set([...boss.statusImmunityList,immunity.id])]:boss.statusImmunityList.filter(value=>value!==immunity.id);changed();});return `<label class="inline-check"><input type="checkbox" data-field="${id}" ${boss.statusImmunityList.includes(immunity.id)?'checked':''}>${esc(immunity.label)}</label>`;}).join('')||'<p class="hint">지원하는 상태이상 목록이 없습니다.</p>'}</div><div class="section-line">처치 보상</div>${field({path:'rewardGold',label:'보상 골드',type:'integer',min:0},boss.reward.gold,value=>boss.reward.gold=value)}<p class="hint">현재 아이템 카탈로그에서 보상을 중복 없이 선택하세요.</p>${boss.reward.items.map((item,index)=>`<div class="row reward-item"><span class="grow">${esc(item.name)}</span>${editButton('삭제',()=>{boss.reward.items.splice(index,1);changed();renderInspector();},false,'danger')}</div>`).join('')}<div class="row"><select id="reward-item"><option value="">보상 아이템 선택</option>${(catalog!.boss?.items??[]).map((item,index)=>`<option value="${index}">${esc(item.name)}</option>`).join('')}</select>${editButton('+ 아이템 추가',()=>{const value=document.querySelector<HTMLSelectElement>('#reward-item')!.value;if(value==='')return;const item=catalog?.boss?.items[Number(value)];if(item){if(boss.reward.items.some(existing=>same(existing,item))){setMessage('이미 보상에 포함된 아이템입니다.');return;}boss.reward.items.push(clone(item));changed();renderInspector();}},boss.reward.items.length>=64)}</div>`;
}
function renderInspector(){
  const el=document.querySelector('#inspector-body');if(!el)return;const expanded=[...el.querySelectorAll<HTMLDetailsElement>('details[data-phase-details][open]')].map(detail=>detail.dataset.phaseDetails);fieldHandlers.clear();fieldIndex=0;
  document.querySelector('#inspector-heading')!.textContent=visibleTabs().find(t=>t[0]===tab)?.[1]??'';
  if(!catalog&&!['ai','concept'].includes(tab)){el.innerHTML='<div class="empty-note"><span class="large-symbol">↗</span><h3>프로젝트를 연결하세요</h3><p>열려 있는 Unity에서 Drone 구조와 사용 가능한 에셋을 읽어옵니다.</p><button class="primary" data-action="connect">Unity 연결</button><button class="secondary" data-action="install">연동 설치 / 갱신</button></div>';return;}
  if(tab==='appearance')el.innerHTML=`<p class="eyebrow">IDENTITY</p>${field({path:'name',label:'적 이름',type:'string'},blueprint.name,v=>blueprint.name=v)}<label class="field"><span>모델</span>${assetButton(blueprint.model,a=>{if(!same(a,blueprint.model)){blueprint.model=a;blueprint.animation={mode:'clips',controller:null,states:{Idle:null,Move:null,Groggy:null,...Object.fromEntries(attacks().map(a=>[a.values.animName,null]))},move:defaultMoveBlend(Number(blueprint.components.NavMeshAgent?.m_Speed))};animationInfo=null;animationInfoKey='';changed();void resetPreview();renderInspector();updatePreviewControls();}},['Model','GameObject'])}</label><p class="hint">새 모델을 선택하면 뼈대에 맞는 애니메이션을 다시 지정합니다.</p><div class="section-line">모델 배치</div>${vec('위치',blueprint.modelTransform.position,v=>blueprint.modelTransform.position=v)}${vec('회전',blueprint.modelTransform.rotation,v=>blueprint.modelTransform.rotation=v)}${vec('크기',blueprint.modelTransform.scale,v=>blueprint.modelTransform.scale=v)}<div class="section-line">표시 위치</div>${anchorControls('hpBar','체력바')}${anchorControls('vfx','피격 효과')}<button class="text-button" data-action="reposition">자동 위치 다시 계산 ↗</button><p class="hint">초록 막대는 체력바, 하늘색 십자는 피격 위치입니다. 좌표를 직접 바꾸면 수동으로 전환됩니다. ${esc(placementWarning)}</p>${Object.entries(catalog!.componentFields).filter(([k])=>/Collider|DeathFade/.test(k)).map(([k,s])=>`<details class="group" open><summary>${esc(componentLabels[k]??k)}</summary>${fields(s,blueprint.components[k]??={})}</details>`).join('')}`;
  if(tab==='stats')el.innerHTML=`<p class="eyebrow">ATTRIBUTES</p><p class="hint">치명 확률은 백분율로 표시됩니다. 공격 피해는 공격력 × 공격별 배율로 계산합니다.</p>${blueprint.kind==='boss'?`<p class="hint">총 HP: ${blueprint.stats.maxHp} · 페이즈 HP 합계로 자동 계산됩니다.</p>`:''}${fields(catalog!.statsFields.filter(schema=>blueprint.kind!=='boss'||schema.path!=='maxHp'),blueprint.stats)}${Object.entries(catalog!.componentFields).filter(([k])=>/Poise/.test(k)).map(([k,s])=>`<details class="group" open><summary>${esc(componentLabels[k]??k)}</summary>${fields(s,blueprint.components[k]??={})}</details>`).join('')}`;
  if(tab==='movement')el.innerHTML=`<p class="eyebrow">BEHAVIOR</p><p class="hint">현재 게임의 추적·접근·공격 선택 규칙을 사용합니다.</p>${Object.entries(catalog!.componentFields).filter(([k])=>!/Collider|DeathFade|Poise/.test(k)).map(([k,s])=>`<details class="group" open><summary>${esc(componentLabels[k]??k)}</summary>${fields(s,blueprint.components[k]??={})}</details>`).join('')}`;
  if(tab==='attacks'){
    const current=chosenAttack();const definition=catalog!.attacks.find(d=>d.typeId===current?.typeId);
    el.innerHTML=`<p class="eyebrow">ATTACK LOADOUT</p><div class="attack-list">${attacks().map(a=>`<button class="attack-row ${a.id===selectedAttack?'selected':''}" data-attack="${esc(a.id)}"><span>${a===blueprint.selfDestruct?'◉':'↗'}</span><strong>${esc(attackName(a))}</strong><small>${esc(a.values.animName)}</small></button>`).join('')||'<p class="hint">공격을 추가해 전투 방식을 구성하세요.</p>'}</div><div class="row"><select id="add-attack-type">${catalog!.attacks.filter(d=>kind!=='boss'||d.category!=='selfDestruct').map(d=>`<option value="${esc(d.typeId)}">${esc(d.name)}${d.generated?' · AI':''}</option>`).join('')}</select><button class="secondary" data-action="add-attack">추가</button></div>${current&&definition?`<div class="section-line row between"><span>${esc(definition.name)}</span><button class="text-button danger" data-action="remove-attack">삭제</button></div><p class="hint">${esc(definition.description)}</p>${fields(definition.fields,current.values)}<p class="hint">상태명과 동일한 애니메이션을 ‘애니메이션’ 탭에서 연결하세요.</p>`:''}`;
  }
  if(tab==='animation'){
    const states=new Set(['Idle','Move','Groggy','Hit','Die',...(kind==='boss'?['PhaseDown','PhaseRevive']:[]),...attacks().map(a=>String(a.values.animName)).filter(Boolean),...Object.keys(blueprint.animation.states)]);
    el.innerHTML=`<p class="eyebrow">ANIMATION MAPPING</p><div class="segmented"><button data-mode="clips" class="${blueprint.animation.mode==='clips'?'active':''}">클립 자동 구성</button><button data-mode="controller" class="${blueprint.animation.mode==='controller'?'active':''}">기존 컨트롤러</button></div>${blueprint.animation.mode==='controller'?`<label class="field"><span>Animator Controller</span>${assetButton(blueprint.animation.controller,a=>{blueprint.animation.controller=a;if(blueprint.animation.move)blueprint.animation.move.overrideController=false;animationInfo=null;animationInfoKey='';changed();renderInspector();updatePreviewControls();void refreshAnimationInfo();},['AnimatorController'])}</label><p class="hint">선택한 컨트롤러를 복제합니다. 아래 클립은 없는 상태를 보완하는 데 사용합니다.</p>`:'<p class="hint">Idle · Move · Groggy와 사용하는 공격 상태를 지정하세요. 여러 페이즈의 보스는 PhaseDown · PhaseRevive도 필요합니다. Hit · Die는 선택 사항입니다.</p>'}${[...states].filter(name=>name!=='Move'||!blueprint.animation.move).map(name=>`<label class="field animation-field"><span><b>${esc(name)}</b><small>${['Hit','Die'].includes(name)?'선택':'상태'}</small></span>${assetButton(blueprint.animation.states[name],a=>{blueprint.animation.states[name]=a;changed();renderInspector();previewState=name;time=0;previewDirty=true;updatePreviewControls();},['AnimationClip'])}</label>`).join('')}${moveEditor()}`;
  }
  if(tab==='phases')el.innerHTML=bossPhasesEditor();
  if(tab==='boss-combat')el.innerHTML=bossCombatEditor();
  if(tab==='concept')el.innerHTML=conceptEditor();
  if(tab==='ai')el.innerHTML=`<p class="eyebrow">BUILD A NEW ATTACK</p><h2 class="ai-heading">공격을 말로<br>설계하세요<span>✳</span></h2><p class="hint">기존 공격 설정으로 가능한 요청은 바로 구성합니다. 새 동작이 필요하면 코드를 구현하고 검증해 목록에 추가합니다.</p><div class="connection-card"><span class="dot ${aiStatus?.state==='ready'?'online':''}"></span><span>${esc(aiStatus?.message??'AI 연결을 확인하세요.')}</span><button class="text-button" data-action="ai-status">확인</button></div>${aiEngineField()}<div class="row"><button class="secondary small" data-action="ai-login">${aiProvider()==='claude'?'Claude 로그인':'ChatGPT 로그인'}</button><button class="secondary small" data-action="ai-select">실행 파일 선택</button></div><label class="field prompt-field"><span>어떤 공격을 만들까요?</span><textarea id="ai-prompt" rows="7" placeholder="1초 동안 준비한 뒤 플레이어를 향해 탄환 3발을 발사해줘. 탄환은 벽에 닿으면 사라지고, 패링되면 공격을 중단해줘.">${esc(aiPrompt)}</textarea></label><label class="field"><span>${aiProvider()==='claude'?'Claude':'Codex'} 모델</span><select id="ai-model"><option value="">사용자 기본 모델</option>${(aiStatus?.models??[]).map(m=>`<option value="${esc(m.id)}" ${m.id===aiModel?'selected':''}>${esc(m.name)}</option>`).join('')}</select></label><div class="row"><button class="primary grow" data-action="ai-generate" ${busy?'disabled':''}>✳ 공격 구현 및 등록</button><button class="secondary" data-action="ai-cancel" ${!busy?'disabled':''}>취소</button></div><p class="hint">새 공격 코드만 추가합니다. 기존 핵심 코드의 변경이 필요한 요청은 이유를 안내합니다. 모델·애니메이션·효과는 프로젝트 에셋을 사용합니다.</p><div id="ai-log" class="log">${log.map(l=>`<div>${esc(l)}</div>`).join('')}</div>`;
  el.querySelectorAll<HTMLDetailsElement>('details[data-phase-details]').forEach(detail=>detail.open=expanded.includes(detail.dataset.phaseDetails));
}
function render(){
  document.querySelector('#app')!.innerHTML=`<header class="topbar"><div class="brand"><div class="brand-icon">白</div><div><b>BAEKHO</b><span>ENEMY FORGE</span></div><span class="version">1.2</span></div><div class="project-status"><span class="dot ${connection?'online':''}"></span><span title="${esc(connection?.projectName??'프로젝트 연결 안 됨')}">${esc(connection?.projectName??'프로젝트 연결 안 됨')}</span></div><div class="toolbar"><button data-action="choose-project">프로젝트 선택</button><button data-action="connect">${connection?'다시 연결':'Unity 연결'}</button><button data-action="install">연동 설치</button><i></i><button data-action="open">열기</button><button data-action="save">저장</button></div>${themePicker()}</header><main class="workspace"><aside class="sidebar"><div class="workspace-label">ENEMY WORKSPACE</div><h1 id="enemy-title">${esc(blueprint.name)}</h1><span id="dirty" class="badge">${dirty?'수정됨':'저장됨'}</span><nav>${visibleTabs().map(([id,label,icon])=>`<button class="nav-item ${tab===id?'active':''}" data-tab="${id}"><span>${icon}</span>${label}${id==='ai'?'<i>NEW</i>':''}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="mini-title">TEMPLATE</div><strong>${esc(blueprint.template?.name??(kind==='boss'?'ConfiguredBoss':'Drone'))}</strong><p>프로젝트의 적 구조를 바탕으로<br>새로운 적을 구성합니다.</p><button class="text-button" data-action="reset">템플릿부터 새로 만들기 ↗</button></div></aside><section class="stage"><div class="stage-heading"><div><span class="eyebrow">LIVE PREVIEW</span><h2>모델과 공격 확인</h2></div><span class="stage-label">UNITY RENDER</span></div><div id="viewport" class="viewport"><div class="viewport-grid"></div><img id="preview-image" alt="Unity 모델 미리보기" ${previewImage?`src="${previewImage}"`: 'hidden'}><div id="preview-empty" class="preview-empty" ${previewImage?'hidden':''}><div class="empty-emblem">◇</div><h3>적을 만들 준비가 되었습니다</h3><p>Unity 연결 후 모델을 확인하세요.</p><button class="secondary" data-action="preview">미리보기 시작</button></div><div class="viewport-corner">PERSPECTIVE <span>·</span> 512 × 512</div><div class="orbit-hint">드래그 회전 · 휠 확대</div><button class="reset-camera" data-action="reset-camera" title="카메라 초기화">⌖</button></div><div class="playback"><div class="row"><button class="play-button" data-action="play" title="재생 / 일시정지">${playing?'Ⅱ':'▶'}</button><select id="preview-clip" aria-label="미리보기 애니메이션"></select><select id="preview-speed" aria-label="재생 배속"><option value="0.5" ${speed===.5?'selected':''}>0.5×</option><option value="1" ${speed===1?'selected':''}>1×</option><option value="2" ${speed===2?'selected':''}>2×</option></select><label class="inline-check"><input id="preview-loop" type="checkbox" ${loop?'checked':''}>반복</label><label class="inline-check"><input id="hitboxes" type="checkbox" ${showHitboxes?'checked':''}>판정 범위</label></div><div class="timeline-row"><input id="timeline" aria-label="클립 시간" type="range" min="0" max="3" step="0.01" value="${time}"><output id="time-label">0.00 / 3.00s</output></div><p id="preview-warning" class="hint">${esc(previewWarning||'클립 기준 시간 · 반복 재생 · 실제 전투 시뮬레이션은 포함하지 않습니다.')}</p></div><div class="results"><div class="row between"><h3>생성 전 확인</h3><button class="text-button" data-action="validate">검증 실행 ↗</button></div><div id="issues"></div></div><footer class="stage-footer"><span id="status-text" role="status">${esc(message)}</span><button class="primary" data-action="build">프리팹 생성 <span>↗</span></button></footer></section><section class="inspector"><div class="inspector-top"><h2 id="inspector-heading"></h2><span>설정</span></div><div id="inspector-body"></div></section></main><dialog id="asset-dialog"><div class="row between"><div><span class="eyebrow">PROJECT ASSETS</span><h2>에셋 선택</h2></div><button class="icon-button" data-action="close-assets">×</button></div><input id="asset-search" placeholder="이름 또는 경로 검색" autocomplete="off"><div id="asset-results"></div><div class="row between"><small id="asset-count"></small><button class="secondary" id="clear-asset">연결 해제</button></div></dialog>`;
  document.querySelector('.topbar')!.insertAdjacentHTML('afterend',`<div class="monster-tabs" role="tablist" aria-label="몬스터 종류"><button role="tab" aria-selected="${kind==='normal'}" data-kind="normal" class="${kind==='normal'?'active':''}">일반 몬스터${kind!=='normal'&&drafts.normal?.dirty?' <small>●</small>':''}</button><button role="tab" aria-selected="${kind==='boss'}" data-kind="boss" class="${kind==='boss'?'active':''}">보스 몬스터${kind!=='boss'&&drafts.boss?.dirty?' <small>●</small>':''}</button><span>각 탭의 설계는 따로 유지됩니다.</span></div>`);
  const playback=document.querySelector('.playback');if(playback){const area=document.createElement('div');area.id='move-preview';playback.append(area);}
  renderInspector();renderIssues();updatePreviewControls();bindViewport();setBusy(busy);document.querySelector('#preview-warning')!.textContent=previewText(previewWarning);
}
function renderIssues(){const el=document.querySelector('#issues');if(!el)return;const all=[...(catalog?.warnings??[]).map(message=>({severity:'warning' as const,path:'template',message})),...issues];el.innerHTML=all.length?all.map(i=>`<div class="issue ${i.severity}"><span>${i.severity==='error'?'!':'△'}</span><p>${esc(i.message)}</p></div>`).join(''):'<p class="hint">필수 에셋, 애니메이션 상태와 데이터 연결을 검사한 뒤 생성합니다.</p>';}
function setBusy(value:boolean){busy=value;document.body.classList.toggle('busy',value);document.querySelectorAll<HTMLButtonElement>('[data-kind],[data-action="build"],[data-action="validate"],[data-action="connect"],[data-action="install"],[data-action="reset"],[data-action="open"],[data-action="choose-project"],[data-action="save"]').forEach(b=>b.disabled=value);document.querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLSelectElement>('#inspector-body input,#inspector-body textarea,#inspector-body select,#inspector-body button').forEach(control=>{if(value&&!control.disabled){control.disabled=true;control.dataset.busyDisabled='true';}else if(!value&&control.dataset.busyDisabled){control.disabled=false;delete control.dataset.busyDisabled;}});document.querySelectorAll<HTMLButtonElement>('[data-action="ai-generate"],[data-action="ai-concept"]').forEach(button=>button.disabled=value);const cancel=document.querySelector<HTMLButtonElement>('[data-action="ai-cancel"]');if(cancel)cancel.disabled=!value;}
async function run(fn:()=>Promise<void>){if(busy)return;setBusy(true);try{await fn();}catch(e){setMessage((e as Error).message);issues=[{severity:'error',path:'operation',message:(e as Error).message}];renderIssues();}finally{setBusy(false);}}
async function loadCatalog(reset=false){catalog=await api.catalog(kind);if((catalog.template.kind??'normal')!==kind)throw new Error('선택한 몬스터 종류를 지원하지 않는 Unity 연동입니다. 연동 설치로 갱신하세요.');if(reset||!initialized){blueprint=normalizeBlueprint(clone(catalog.template));blueprint.name=kind==='boss'?'Boss_New':'Drone_New';initialized=true;selectedAttack=blueprint.attacks[0]?.id??'';dirty=false;placementKey='';conceptResult=null;}animationInfoKey='';render();schedulePlacement();if(tab==='animation')void refreshAnimationInfo();await resetPreview();}
function updatePlayButton(){const button=document.querySelector<HTMLButtonElement>('[data-action="play"]');if(button)button.textContent=playing?'Ⅱ':'▶';}
function previewText(warning=''){return (warning||(previewState==='Move'&&moveBlendActive(blueprint)?'방향 2D 블렌드 미리보기 · X/Y로 이동 방향을 조절하세요.':'클립 기준 시간 · 실제 전투 시뮬레이션은 포함하지 않습니다.'))+(blueprint.animation.mode==='controller'&&!moveBlendActive(blueprint)?' 기존 컨트롤러 모드의 미리보기는 지정한 보완 클립을 독립적으로 샘플링합니다. 컨트롤러 상태·전환·Blend Tree는 실행하지 않습니다.':'');}
function clearPreview(warning=''){
  previewImage='';previewWarning=warning;
  const image=document.querySelector<HTMLImageElement>('#preview-image');if(image){image.hidden=true;image.removeAttribute('src');}
  const empty=document.querySelector<HTMLElement>('#preview-empty');if(empty)empty.hidden=false;
  const label=document.querySelector('#preview-warning');if(label)label.textContent=previewText(warning);
  updatePlayButton();
}
async function resetPreview(autoplay=false){
  const revision=++sessionRevision;const prior=session;session='';frameRevision++;frameBusy=false;playing=false;time=0;clearPreview('미리보기를 준비하고 있습니다…');
  if(prior)await api.previewClose(prior).catch(()=>{});
  if(revision!==sessionRevision)return;
  if(!connection||!blueprint.model){clearPreview('Unity에 연결하고 모델을 선택한 후 미리보기를 시작하세요.');return;}
  try{const result=await api.previewOpen(blueprint);if(revision!==sessionRevision){await api.previewClose(result.sessionId);return;}session=result.sessionId;previewDirty=true;playing=autoplay;updatePlayButton();}
  catch(e){if(revision===sessionRevision)clearPreview((e as Error).message);}
}
function previewClip(){return previewState==='Move'&&moveBlendActive(blueprint)?null:blueprint.animation.states[previewState]??null;}
function previewDuration(){if(previewState==='Move'&&moveBlendActive(blueprint))return Math.max(.1,...blueprint.animation.move!.children.map(child=>(catalog?.assets.find(a=>same(a,child.clip))?.duration??(child.clip as AssetEntry)?.duration??3)/Math.max(.01,child.timeScale)));const clip=previewClip(),entry=catalog?.assets.find(a=>same(a,clip)),a=chosenAttack(),definition=catalog?.attacks.find(d=>d.typeId===a?.typeId),values=a?.values??{};return Math.max(0.1,entry?.duration??(clip as AssetEntry)?.duration??3,Number(values.attackDuration??0),Number(values.explosionDelay??0)*Number(values.attackSpeed??1),Number(values.startupTime??0)+Number(values.dashDuration??values.jumpDuration??0)+Number(values.recoveryTime??0),...(definition?.preview?.shapes??[]).map(s=>Number.isFinite(s.end)?s.end:0));}
function updatePreviewControls(){const select=document.querySelector<HTMLSelectElement>('#preview-clip');if(!select)return;const keys=Object.keys(blueprint.animation.states).filter(k=>blueprint.animation.states[k]||k==='Move'&&moveBlendActive(blueprint));if(moveBlendActive(blueprint)&&!keys.includes('Move'))keys.push('Move');if(!keys.includes(previewState))previewState=keys[0]??'Idle';select.innerHTML=keys.length?keys.map(k=>`<option value="${esc(k)}" ${previewState===k?'selected':''}>${esc(k)}</option>`).join(''):'<option>클립을 지정하세요</option>';updateMovePreview();}
function bindViewport(){let pointer:number|null=null,px=0,py=0;const v=document.querySelector<HTMLElement>('#viewport')!;v.addEventListener('pointerdown',e=>{if((e.target as HTMLElement).closest('button'))return;pointer=e.pointerId;px=e.clientX;py=e.clientY;v.setPointerCapture(e.pointerId);});v.addEventListener('pointermove',e=>{if(pointer!==e.pointerId)return;yaw+=(e.clientX-px)*0.4;pitch=Math.max(-75,Math.min(75,pitch+(e.clientY-py)*0.3));px=e.clientX;py=e.clientY;previewDirty=true;});v.addEventListener('pointerup',()=>pointer=null);v.addEventListener('wheel',e=>{e.preventDefault();zoom=Math.max(0.25,Math.min(5,zoom*Math.exp(e.deltaY*0.001)));previewDirty=true;},{passive:false});}
async function frame(t:number){
  const elapsed=lastTick?Math.min((t-lastTick)/1000,0.1):0;lastTick=t;
  if(playing&&session&&!busy){const duration=previewDuration(),next=time+elapsed*speed*Number(chosenAttack()?.values.attackSpeed??1);time=loop?next%duration:Math.min(next,duration);if(!loop&&time>=duration){playing=false;updatePlayButton();}previewDirty=true;}
  const timeline=document.querySelector<HTMLInputElement>('#timeline');if(timeline){timeline.max=String(previewDuration());timeline.value=String(time);document.querySelector('#time-label')!.textContent=`${time.toFixed(2)} / ${previewDuration().toFixed(2)}s`;}
  if(session&&!frameBusy&&((previewDirty&&!busy)||t-lastRequest>=15000)&&t-lastRequest>=1000/12){
    frameBusy=true;previewDirty=false;lastRequest=t;const current=session,seq=++sequence,requestRevision=++frameRevision;
    void api.previewFrame({sessionId:current,sequence:seq,time,yaw,pitch,zoom,clip:previewClip(),blueprint,attackId:selectedAttack||null,showHitboxes,state:previewState,moveParameters}).then(result=>{if(session!==current||result.sequence!==sequence)return;previewImage=result.dataUrl;const img=document.querySelector<HTMLImageElement>('#preview-image')!;img.src=previewImage;img.hidden=false;document.querySelector<HTMLElement>('#preview-empty')!.hidden=true;previewWarning=result.warning??'';document.querySelector('#preview-warning')!.textContent=previewText(previewWarning);}).catch(e=>{if(session!==current||seq!==sequence)return;playing=false;session='';clearPreview((e as Error).message+' 미리보기 시작을 누르면 다시 연결합니다.');}).finally(()=>{if(frameRevision===requestRevision)frameBusy=false;});
  }requestAnimationFrame(frame);
}
let assetCallback:((a:AssetRef|null)=>void)|null=null,assetChoices:AssetEntry[]=[],assetSelected:AssetRef|null=null,assetKinds:string[]=[],searchSequence=0,searchTimer:ReturnType<typeof setTimeout>|undefined;
function chooseAsset(kinds:string[],selected:AssetRef|null,callback:(a:AssetRef|null)=>void){assetCallback=callback;assetSelected=selected;assetKinds=kinds;assetChoices=(catalog?.assets??[]).filter(a=>!kinds.length||kinds.includes(a.kind??''));const dlg=document.querySelector<HTMLDialogElement>('#asset-dialog')!;document.querySelector<HTMLInputElement>('#asset-search')!.value='';renderAssetResults('');dlg.showModal();document.querySelector<HTMLInputElement>('#asset-search')!.focus();searchAssets('');}
function searchAssets(query:string){const seq=++searchSequence;clearTimeout(searchTimer);searchTimer=setTimeout(()=>{if(!api.searchAssets)return;void api.searchAssets(query,assetKinds).then(result=>{if(seq!==searchSequence||!document.querySelector<HTMLDialogElement>('#asset-dialog')!.open)return;assetChoices=result.assets;renderAssetResults('');document.querySelector('#asset-count')!.textContent=`프로젝트 전체 ${result.total}개${result.truncated?' · 검색어를 추가해 범위를 좁혀주세요.':''}`;}).catch(()=>{/* Keep the already loaded project assets when disconnected. */});},250);}
function renderAssetResults(query:string){const q=query.toLowerCase(),filtered=assetChoices.filter(a=>(a.name+' '+a.path).toLowerCase().includes(q));document.querySelector('#asset-results')!.innerHTML=filtered.slice(0,150).map(a=>`<button class="asset-result ${same(a,assetSelected)?'selected':''}" data-asset-index="${assetChoices.indexOf(a)}"><span class="asset-symbol">${a.kind==='AnimationClip'?'▷':'◇'}</span><span><b>${esc(a.name)}</b><small>${esc(a.path)}${a.rig?' · '+esc(a.rig):''}</small></span><i>${esc(a.kind)}</i></button>`).join('')||'<p class="empty-note">일치하는 에셋이 없습니다.</p>';document.querySelector('#asset-count')!.textContent=`${filtered.length}개 에셋${filtered.length>150?' · 상위 150개 표시, 검색으로 좁혀주세요.':''}`;}
function addAttack(typeId:string,initialValues?:AttackConfig['values'],replaceSelfDestruct=false){const def=catalog?.attacks.find(d=>d.typeId===typeId);if(!def)return;if(kind==='boss'&&def.category==='selfDestruct'){setMessage('보스는 일반 몬스터의 자폭 슬롯을 사용하지 않습니다.');return;}const attack:AttackConfig={id:crypto.randomUUID(),typeId,values:clone(initialValues??def.defaults)};if(def.category==='selfDestruct'){if(blueprint.selfDestruct){if(!replaceSelfDestruct){setMessage('자폭 공격은 하나만 연결할 수 있습니다.');return;}attack.id=blueprint.selfDestruct.id;}blueprint.selfDestruct=attack;}else blueprint.attacks.push(attack);if(!attack.values.animName)attack.values.animName='Attack_'+(blueprint.attacks.length);selectedAttack=attack.id;changed();renderInspector();updatePreviewControls();}
document.addEventListener('input',e=>{const target=e.target as HTMLInputElement;if(target.id==='asset-search'){renderAssetResults(target.value);searchAssets(target.value);return;}if(target.id==='timeline'){time=Number(target.value);playing=false;updatePlayButton();previewDirty=true;return;}if(target.id.startsWith('move-preview-')){moveParameters[Number(target.id.slice(-1))]=Number(target.value);syncMovePreview();return;}if(busy)return;if(target.id==='ai-prompt'){aiPrompt=target.value;return;}if(target.id==='concept-prompt'){conceptPrompt=target.value;return;}if(target.tagName!=='SELECT'&&target.dataset.field)fieldHandlers.get(target.dataset.field)?.(target.type==='checkbox'?String(target.checked):target.value);});
document.addEventListener('change',e=>{
  const t=e.target as HTMLInputElement | HTMLSelectElement;
  if (t.name === 'theme' && (t.value === 'dark' || t.value === 'light')) {
    document.documentElement.dataset.theme = t.value;
    try {
      localStorage.setItem(themeStorageKey, t.value);
    } catch {
      // The selection still applies for this session if storage is unavailable.
    }
    return;
  }
  if(!busy&&t.tagName==='SELECT'&&t.dataset.field)fieldHandlers.get(t.dataset.field)?.(t.value);if(t.id==='preview-clip'){previewState=t.value;time=0;selectedAttack=attacks().find(a=>a.values.animName===previewState)?.id??'';previewDirty=true;updateMovePreview();}if(t.id==='preview-speed')speed=Number(t.value);if(t.id==='preview-loop')loop=(t as unknown as HTMLInputElement).checked;if(t.id==='hitboxes'){showHitboxes=(t as unknown as HTMLInputElement).checked;previewDirty=true;}if(!busy&&t.id==='ai-model')aiModel=t.value;if(!busy&&t.id==='ai-provider')void switchProvider(t.value as AiProvider);});
document.addEventListener('click',e=>{
  const target=(e.target as HTMLElement).closest<HTMLElement>('button,[data-tab]');if(!target)return;
  if(target.dataset.kind){if(!busy)void run(()=>switchKind(target.dataset.kind as MonsterKind));return;}
  if(target.dataset.tab){tab=target.dataset.tab;document.querySelectorAll('[data-tab]').forEach(t=>t.classList.toggle('active',(t as HTMLElement).dataset.tab===tab));renderInspector();setBusy(busy);if(tab==='animation')void refreshAnimationInfo();if(['ai','concept'].includes(tab)&&!aiStatus)void api.aiStatus().then(s=>{aiStatus=s;if(['ai','concept'].includes(tab)){renderInspector();setBusy(busy);}}).catch(e=>setMessage(e.message));return;}
  if(busy&&(target.dataset.asset||target.dataset.assetIndex||target.dataset.attack||target.dataset.mode||['clear-asset'].includes(target.id)))return;
  if(target.dataset.asset){fieldHandlers.get(target.dataset.asset)?.('');return;}
  if(target.dataset.assetIndex){const asset=assetChoices[Number(target.dataset.assetIndex)];document.querySelector<HTMLDialogElement>('#asset-dialog')!.close();assetCallback?.(asset);return;}
  if(target.id==='clear-asset'){document.querySelector<HTMLDialogElement>('#asset-dialog')!.close();assetCallback?.(null);return;}
  if(target.dataset.attack){selectedAttack=target.dataset.attack;const attack=chosenAttack();if(attack)previewState=attack.values.animName;time=0;previewDirty=true;renderInspector();updatePreviewControls();return;}
  if(target.dataset.mode){blueprint.animation.mode=target.dataset.mode as 'clips'|'controller';changed();renderInspector();updatePreviewControls();void refreshAnimationInfo();return;}
  const action=target.dataset.action;
  if(action==='close-assets')return document.querySelector<HTMLDialogElement>('#asset-dialog')!.close();
  if(action==='ai-cancel'){void api.aiCancel();return;}
  if(action==='play'){if(!session){void resetPreview(true);return;}if(time>=previewDuration())time=0;playing=!playing;updatePlayButton();previewDirty=true;return;}
  if(action==='reset-camera'){yaw=25;pitch=12;zoom=1;previewDirty=true;return;}
  if(action==='move-center'){moveParameters=[0,0];syncMovePreview();return;}
  if(busy)return;
  if(action==='reposition'){schedulePlacement(true);return;}
  if(action==='add-attack'){addAttack(document.querySelector<HTMLSelectElement>('#add-attack-type')!.value);return;}
  if(action==='remove-attack'){if(blueprint.boss?.phases.some(phase=>phase.skillIds?.includes(selectedAttack)||phase.pattern.steps.some(step=>step.kind==='attack'&&step.attackId===selectedAttack))){setMessage('페이즈나 패턴에서 사용하는 공격입니다. 해당 연결을 해제한 뒤 삭제하세요.');return;}if(blueprint.selfDestruct?.id===selectedAttack)blueprint.selfDestruct=null;else blueprint.attacks=blueprint.attacks.filter(a=>a.id!==selectedAttack);selectedAttack=blueprint.attacks[0]?.id??'';changed();renderInspector();return;}
  if(action==='preview'){void resetPreview();return;}
  void run(async()=>{
    if(((action==='reset'&&dirty)||(action==='choose-project'&&hasDirtyDraft()))&&!window.confirm(action==='choose-project'?'일반·보스 탭에 저장하지 않은 변경 사항이 있습니다. 변경 사항을 버리고 계속할까요?':'저장하지 않은 변경 사항이 있습니다. 변경 사항을 버리고 계속할까요?'))return;
    if(action==='connect'){setMessage('Unity 프로젝트를 확인하고 있습니다…');connection=await api.connect();await loadCatalog();setMessage(`${connection.projectName}에 연결되었습니다.`);}
    if(action==='choose-project'){const selected=await api.chooseProject();if(selected){const nextConnection=await api.connect();await leaveDraft();delete drafts.normal;delete drafts.boss;restoreDraft(kind);connection=nextConnection;await loadCatalog(true);setMessage('프로젝트를 변경했습니다.');}}
    if(action==='install'){connection=await api.connect();setMessage('Unity 연동 설치 및 컴파일 중…');await api.installBridge(connection.projectRoot);await loadCatalog();setMessage('Unity 연동이 준비되었습니다.');}
    if(action==='save'){await settlePlacement();const file=await api.save(blueprint);if(file){dirty=false;updateTop();setMessage(`저장됨: ${file}${placementWarning?' · 자동 배치 확인 필요: '+placementWarning:''}`);}}
    if(action==='open'){const document=await api.open();if(document){const b=normalizeBlueprint(document),next=b.kind??'normal',targetDirty=next===kind?dirty:drafts[next]?.dirty;if(targetDirty&&!window.confirm(`${next==='boss'?'보스':'일반'} 몬스터 탭에 저장하지 않은 변경 사항이 있습니다. 변경 사항을 버리고 계속할까요?`))return;const nextCatalog=connection?await api.catalog(next):null;if(next!==kind)stashDraft();await leaveDraft();restoreDraft(next);catalog=nextCatalog;blueprint=b;initialized=true;placementKey=modelKey();placementWarning='';conceptResult=null;animationInfoKey='';dirty=false;issues=[];selectedAttack=b.attacks[0]?.id??'';render();await resetPreview();setMessage(`${next==='boss'?'보스':'일반'} 몬스터 설계를 불러왔습니다.`);}}
    if(action==='reset'){if(catalog){await leaveDraft();blueprint=normalizeBlueprint(clone(catalog.template));blueprint.name=kind==='boss'?'Boss_New':'Drone_New';initialized=true;selectedAttack=blueprint.attacks[0]?.id??'';dirty=false;issues=[];placementKey='';conceptResult=null;animationInfoKey='';render();schedulePlacement();await resetPreview();}}
    if(action==='validate'||action==='build'){
      await settlePlacement();
      issues=localIssues(blueprint);if(issues.some(i=>i.severity==='error')){renderIssues();setMessage('필수 설정을 먼저 확인하세요.');return;}
      setMessage('Unity에서 에셋과 설정을 검증하고 있습니다…');const v=await api.validate(blueprint);issues=[...v.issues,...(placementWarning?[{severity:'warning' as const,path:'placement',message:placementWarning}]:[])];renderIssues();if(!v.valid){setMessage('검증 오류를 해결한 후 생성하세요.');return;}
      if(action==='validate'){setMessage('검증을 통과했습니다. 프리팹을 생성할 수 있습니다.');return;}
      setMessage('프리팹과 전용 데이터를 생성하고 있습니다…');const result=await api.build(blueprint);if(result.state!=='completed')throw new Error(result.error??'생성이 완료되지 않았습니다.');lastOutput=result.prefabPath??'';setMessage(`생성 완료 · ${lastOutput}`);if(lastOutput){const p=document.createElement('button');p.className='text-button';p.textContent='생성 폴더 열기 ↗';p.onclick=()=>void api.reveal(lastOutput);document.querySelector('#issues')!.append(p);}
    }
    if(action==='ai-status'){aiStatus=await api.aiStatus();renderInspector();}
    if(action==='ai-login'){await api.aiLogin();setMessage(aiProvider()==='claude'?'열린 창에서 Claude 로그인을 마친 뒤 연결 확인을 눌러주세요.':'브라우저에서 로그인 후 연결 확인을 눌러주세요.');}
    if(action==='ai-select'){aiStatus=await api.aiSelectExecutable();renderInspector();}
    if(action==='ai-concept'){
      if(!conceptPrompt.trim())throw new Error('몬스터의 컨셉을 설명해 주세요.');if(!connection||!catalog)throw new Error('Unity 프로젝트에 먼저 연결하세요.');
      clearTimeout(placementTimer);placementRevision++;setMessage('AI가 몬스터의 컨셉을 분석하고 있습니다…');
      try{
        const result=await api.aiGenerateConcept({prompt:conceptPrompt.trim(),blueprint:clone(blueprint),model:aiModel||undefined});
        // Catalog refresh can fail after successful code registration; retain the complete returned design.
        blueprint=result.blueprint;conceptResult=result;placementKey=modelKey();selectedAttack=blueprint.attacks[0]?.id??'';changed();
        try{catalog=await api.catalog(kind);}catch(error){result.warnings.push(`공격 목록 갱신 필요: ${(error as Error).message}`);}
        issues=localIssues(blueprint);render();setMessage(`컨셉 구성 완료 · ${result.summary}`);await resetPreview();
      }catch(error){try{catalog=await api.catalog(kind);}catch{/* Preserve the current design when reconnecting. */}renderInspector();throw error;}
    }
    if(action==='ai-generate'){if(!aiPrompt.trim())throw new Error('만들 공격을 설명해 주세요.');setMessage('AI가 공격 코드를 분석하고 있습니다…');const result=await api.aiGenerate({prompt:aiPrompt.trim(),blueprint,model:aiModel||undefined});catalog=await api.catalog(kind);addAttack(result.typeId,result.configuredExisting?result.existingValues:undefined,result.configuredExisting===true);tab='attacks';render();setMessage(`${result.configuredExisting?'기존 공격 설정 적용 완료':'새 공격 등록 완료'} · ${result.summary}`);await resetPreview();}
  });
});
api?.onProgress(p=>{log.push(`${p.stage} · ${p.message}`);if(log.length>40)log.shift();setMessage(p.message);const el=document.querySelector('#ai-log');if(el){el.innerHTML=log.map(l=>`<div>${esc(l)}</div>`).join('');el.scrollTop=el.scrollHeight;}});
window.addEventListener('beforeunload',()=>{if(session)void api.previewClose(session);});
render();requestAnimationFrame(frame);
