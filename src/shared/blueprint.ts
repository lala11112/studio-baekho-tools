import type { BossConfig, BossPhaseConfig, EnemyBlueprint, MonsterKind, MoveBlendTree, ValidationIssue } from './types';
export const BOSS_IMMUNITIES=['Bind','Slow','Airborne','Silence','Vulnerability','DefenseReduction','WeakPointExposed','WaterDelayedDamage'];
export function defaultBossPhase(index=0):BossPhaseConfig {
  return {phaseId:`phase_${index+1}`,phaseMaxHp:1000,atkMultiplier:1,defMultiplier:1,skillIds:null,pattern:{mode:'weighted',loop:true,steps:[]},shield:null,music:{mode:'keep',clip:null,volume:1,fadeSeconds:.5},note:''};
}
export function defaultBossConfig():BossConfig {
  return {enableWeakness:false,weaknessElement:0,weakDamageMult:1.5,enableResistance:false,resistElement:0,resistDamageMult:.5,groggyDamageMult:1.5,statusImmunityList:[],initialShield:0,phaseDownSeconds:1,phaseHoldSeconds:.5,phaseReviveSeconds:1.5,phases:[defaultBossPhase()],reward:{gold:50,items:[]}};
}
export function normalizeBlueprint(value:unknown):EnemyBlueprint {
  if(!record(value))throw new Error('적 설계 문서가 아닙니다.');
  walk(value,0);
  const b=JSON.parse(JSON.stringify(value)) as EnemyBlueprint;
  if(b.kind==='boss'&&b.version===2){
    const phases=(b.boss as any)?.phases,total=b.stats?.maxHp;
    if(!Array.isArray(phases)||!phases.length||!Number.isFinite(total)||total<=0)throw new Error('기존 보스의 총 HP와 페이즈가 필요합니다.');
    phases.forEach((phase:any,i:number)=>{
      const current=phase?.triggerHpPercent,next=i+1<phases.length?phases[i+1]?.triggerHpPercent:0;
      if(!Number.isFinite(current)||!Number.isFinite(next)||(i===0&&current!==100)||current<=next||current>100||next<0)throw new Error('기존 페이즈 HP 조건은 100%부터 엄격한 내림차순이어야 합니다.');
      phase.phaseMaxHp=total*(current-next)/100;
    });
    Object.assign(b.boss!,{phaseDownSeconds:1,phaseHoldSeconds:.5,phaseReviveSeconds:1.5});
    b.version=3;
  }
  if(b.kind==='boss'&&b.version===3&&Array.isArray(b.boss?.phases)){
    for(const phase of b.boss.phases)if(record(phase))delete phase.triggerHpPercent;
    if(record(b.stats))b.stats.maxHp=Math.max(1,Math.round(b.boss.phases.reduce((sum,phase)=>sum+phase.phaseMaxHp,0)));
  }
  validateBlueprint(b);
  b.version=3;b.kind=b.kind??'normal';if(b.animation.move==null)delete b.animation.move;return b;
}
export function defaultMoveBlend(speed=1):MoveBlendTree {
  const extent=Number.isFinite(speed)&&speed>0?speed:1;
  return {type:'blend2d',parameterX:'DirX',parameterY:'DirY',overrideController:false,children:[[0,0],[0,extent],[0,-extent],[extent,0],[-extent,0]].map(position=>({clip:null,position,timeScale:1}))};
}
export function moveBlendActive(b:EnemyBlueprint):boolean {return !!b.animation.move&&(b.animation.mode==='clips'||b.animation.move.overrideController);}
export function emptyBlueprint(kind:MonsterKind='normal'): EnemyBlueprint {
  return {version:3,kind,...(kind==='boss'?{boss:defaultBossConfig()}:{}),name:kind==='boss'?'NewBoss':'NewEnemy',template:null,model:null,modelTransform:{position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]},stats:kind==='boss'?{maxHp:1000}:{},components:{},animation:{mode:'clips',controller:null,states:{Idle:null,Move:null,Groggy:null,...(kind==='boss'?{PhaseDown:null,PhaseRevive:null}:{})},move:defaultMoveBlend()},attacks:[],selfDestruct:null,hpBarPosition:[0,3,0],vfxPosition:[0,1,0],anchors:{hpBar:'auto',vfx:'auto'}};
}
export function validateBlueprint(value: unknown): asserts value is EnemyBlueprint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('적 설계 문서가 아닙니다.');
  const b = value as EnemyBlueprint;
  if (b.version !== 1 && b.version !== 2 && b.version !== 3) throw new Error('지원하지 않는 설계 문서 버전입니다.');
  if(b.kind==='boss'&&b.version!==3||b.version===1&&b.boss)throw new Error('보스 설계는 버전 3 문서가 필요합니다. 기존 문서는 열기로 변환하세요.');
  if(b.version===1&&b.kind&&b.kind!=='normal')throw new Error('버전 1 문서는 일반 몬스터만 지원합니다.');
  if(b.version>=2&&!['normal','boss'].includes(b.kind!))throw new Error('일반/보스 설계 종류가 필요합니다.');
  if(b.kind!=='boss'&&b.boss)throw new Error('일반 몬스터 문서에 보스 설정을 넣을 수 없습니다.');
  if (typeof b.name !== 'string' || b.name!==b.name.trim() || !/^[\p{L}\p{N}_ -]{1,64}$/u.test(b.name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(b.name)) throw new Error('적 이름은 1~64자의 문자·숫자·공백·밑줄·하이픈을 사용하세요.');
  if (!b.animation || !['clips','controller'].includes(b.animation.mode) || !record(b.animation.states) || !record(b.stats) || !record(b.components) || !Array.isArray(b.attacks)) throw new Error('설계 문서 구조가 올바르지 않습니다.');
  const attacks = [...b.attacks, ...(b.selfDestruct ? [b.selfDestruct] : [])];
  if (attacks.length > 64 || attacks.some(a=>!a || typeof a.id!=='string' || typeof a.typeId!=='string' || !record(a.values)) || new Set(attacks.map(a=>a.id)).size!==attacks.length) throw new Error('공격 목록이 올바르지 않습니다.');
  for (const vector of [b.modelTransform?.position,b.modelTransform?.rotation,b.modelTransform?.scale,b.hpBarPosition,b.vfxPosition]) if (!Array.isArray(vector)||vector.length!==3||vector.some(n=>!Number.isFinite(n))) throw new Error('위치·회전·크기에는 유한한 숫자 3개가 필요합니다.');
  if (b.modelTransform.scale.some(n=>n<=0)) throw new Error('모델 크기는 0보다 커야 합니다.');
  if(b.anchors&&(!record(b.anchors)||!['auto','manual'].includes(b.anchors.hpBar)||!['auto','manual'].includes(b.anchors.vfx)))throw new Error('표시 위치의 자동·수동 설정이 올바르지 않습니다.');
  if(b.animation.move!=null){
    const move=b.animation.move;
    if(!record(move)||move.type!=='blend2d'||typeof move.parameterX!=='string'||typeof move.parameterY!=='string'||typeof move.overrideController!=='boolean'||!Array.isArray(move.children)||move.children.length>32)throw new Error('Move 방향 블렌드 트리 구조가 올바르지 않습니다.');
    for(const child of move.children)if(!child||!Array.isArray(child.position)||child.position.length!==2||child.position.some(n=>!Number.isFinite(n))||!Number.isFinite(child.timeScale)||(child.clip!==null&&!record(child.clip)))throw new Error('Move 클립의 좌표·재생 배속이 올바르지 않습니다.');
  }
  walk(b,0);
  if(b.kind==='boss')validateBossStructure(b);
}
function validateBossStructure(b:EnemyBlueprint):void {
  const c=b.boss;
  if(!c||!record(c)||!Array.isArray(c.phases)||c.phases.length<1||c.phases.length>16||!record(c.reward)||!Array.isArray(c.reward.items)||c.reward.items.length>64)throw new Error('보스 페이즈·보상 구조가 올바르지 않습니다.');
  if(b.selfDestruct)throw new Error('보스는 일반 몬스터 자동 자폭을 지원하지 않습니다.');
  for(const key of ['enableWeakness','enableResistance'] as const)if(typeof c[key]!=='boolean')throw new Error('약점·저항 사용 여부가 필요합니다.');
  for(const key of ['weaknessElement','resistElement'] as const)if(!Number.isInteger(c[key]))throw new Error('속성 선택이 올바르지 않습니다.');
  for(const key of ['weakDamageMult','resistDamageMult','groggyDamageMult','initialShield'] as const)if(!Number.isFinite(c[key])||c[key]<0)throw new Error('보스 배율·보호막은 0 이상의 숫자여야 합니다.');
  for(const key of ['phaseDownSeconds','phaseHoldSeconds','phaseReviveSeconds'] as const)if(!Number.isFinite(c[key])||c[key]<(key==='phaseHoldSeconds'?0:.01))throw new Error('다운·회복 시간은 0보다 커야 하며 대기 시간은 0 이상이어야 합니다.');
  if(!Array.isArray(c.statusImmunityList)||new Set(c.statusImmunityList).size!==c.statusImmunityList.length||c.statusImmunityList.some(id=>!BOSS_IMMUNITIES.includes(id)))throw new Error('지원하지 않거나 중복된 상태이상 면역입니다.');
  if(!Number.isSafeInteger(c.reward.gold)||c.reward.gold<0||c.reward.gold>2147483647||c.reward.items.some(ref=>!validAsset(ref))||new Set(c.reward.items.map(ref=>ref.guid+':'+ref.localId)).size!==c.reward.items.length)throw new Error('골드·아이템 보상이 올바르지 않습니다.');
  const phaseIds=new Set<string>();
  for(const p of c.phases){
    if(!p||typeof p.phaseId!=='string'||!p.phaseId.trim()||p.phaseId.length>80||phaseIds.has(p.phaseId)||typeof p.note!=='string'||p.note.length>4000)throw new Error('페이즈 ID·메모가 올바르지 않습니다.');phaseIds.add(p.phaseId);
    if(![p.phaseMaxHp,p.atkMultiplier,p.defMultiplier].every(Number.isFinite)||Math.fround(p.phaseMaxHp)<=0||p.atkMultiplier<0||p.defMultiplier<0||p.shield!==null&&(!Number.isFinite(p.shield)||p.shield<0))throw new Error('페이즈 HP는 0보다 커야 하며 배율·보호막은 0 이상이어야 합니다.');
    if(p.skillIds!==null&&(!Array.isArray(p.skillIds)||p.skillIds.length>32||p.skillIds.some(id=>typeof id!=='string')||new Set(p.skillIds).size!==p.skillIds.length))throw new Error('페이즈 공격 목록이 올바르지 않습니다.');
    if(!p.pattern||!['weighted','sequence'].includes(p.pattern.mode)||typeof p.pattern.loop!=='boolean'||!Array.isArray(p.pattern.steps)||p.pattern.steps.length>128||p.pattern.steps.some(step=>!step||!['attack','wait'].includes(step.kind)||step.attackId!==null&&typeof step.attackId!=='string'||!Number.isFinite(step.waitSeconds)||step.waitSeconds<0))throw new Error('공격 순서·대기 단계가 올바르지 않습니다.');
    if(!p.music||!['keep','play','stop'].includes(p.music.mode)||!Number.isFinite(p.music.volume)||p.music.volume<0||p.music.volume>1||!Number.isFinite(p.music.fadeSeconds)||p.music.fadeSeconds<0||p.music.clip!==null&&!validAsset(p.music.clip))throw new Error('페이즈 BGM 설정이 올바르지 않습니다.');
  }
  const total=c.phases.reduce((sum,p)=>sum+p.phaseMaxHp,0);
  if(!Number.isFinite(total)||total>2147483647)throw new Error('총 보스 HP가 정수 요약의 지원 범위를 벗어났습니다.');
}
function validAsset(ref:unknown):boolean {return record(ref)&&typeof ref.guid==='string'&&/^[a-f\d]{32}$/i.test(ref.guid)&&typeof ref.localId==='string'&&/^-?\d+$/.test(ref.localId);}
export function bossIssues(b:EnemyBlueprint):ValidationIssue[] {
  if(b.kind!=='boss'||!b.boss)return [];
  const c=b.boss,issues:ValidationIssue[]=[],error=(path:string,message:string)=>issues.push({severity:'error',path:'boss.'+path,message});
  if(c.enableWeakness&&c.enableResistance&&c.weaknessElement===c.resistElement)error('weaknessElement','같은 속성을 약점과 저항으로 지정할 수 없습니다.');
  const attackById=new Map(b.attacks.map(a=>[a.id,a]));let active=b.attacks.map(a=>a.id);
  c.phases.forEach((p,i)=>{
    const path=`phases.${i}`;
    if(!Number.isFinite(p.phaseMaxHp)||p.phaseMaxHp<=0)error(path+'.phaseMaxHp','페이즈 HP는 0보다 커야 합니다.');
    if(p.skillIds!==null)active=p.skillIds;
    for(const id of active)if(!attackById.has(id))error(path+'.skillIds','삭제되었거나 없는 공격을 참조합니다.');
    if(p.pattern.mode==='weighted'&&!active.some(id=>Number(attackById.get(id)?.values.weight??1)>0))error(path+'.skillIds','가중치 선택에는 가중치가 양수인 공격이 필요합니다.');
    if(p.pattern.mode==='sequence'){
      if(!p.pattern.steps.some(step=>step.kind==='attack'))error(path+'.pattern.steps','순차 패턴에는 공격 단계가 하나 이상 필요합니다.');
      p.pattern.steps.forEach((step,j)=>{if(step.kind==='attack'&&(!step.attackId||!attackById.has(step.attackId)))error(path+`.pattern.steps.${j}.attackId`,'공격 단계에 유효한 공격을 선택하세요.');});
    }
    if(p.music.mode==='play'&&!p.music.clip)error(path+'.music.clip','재생할 BGM 클립을 선택하세요.');
  });return issues;
}
function record(v:unknown):v is Record<string,unknown> {return !!v&&typeof v==='object'&&!Array.isArray(v);}
function walk(v:unknown,depth:number):void {
  if(depth>24)throw new Error('설계 문서의 중첩이 너무 깊습니다.');
  if(typeof v==='number'&&!Number.isFinite(v))throw new Error('유효하지 않은 숫자입니다.');
  if(v&&typeof v==='object')for(const [k,item] of Object.entries(v)) {if(['__proto__','constructor','prototype'].includes(k))throw new Error('허용되지 않는 속성입니다.');walk(item,depth+1);}
}
export function localIssues(b:EnemyBlueprint):ValidationIssue[] {
  const issues:ValidationIssue[]=[];
  try{validateBlueprint(b);}catch(e){return [{severity:'error',path:'blueprint',message:String((e as Error).message)}];}
  issues.push(...bossIssues(b));
  if(!b.model)issues.push({severity:'error',path:'model',message:'모델을 선택하세요.'});
  if(!b.attacks.length)issues.push({severity:'warning',path:'attacks',message:'일반 공격이 없는 적입니다.'});
  const names=[...b.attacks,...(b.selfDestruct?[b.selfDestruct]:[])].map(a=>String(a.values.animName??''));
  const phaseStates=b.kind==='boss'&&b.boss!.phases.length>1?['PhaseDown','PhaseRevive']:[];
  if(b.animation.mode==='clips')for(const name of new Set(['Idle','Move','Groggy',...phaseStates,...names]))if(name&&!(name==='Move'&&moveBlendActive(b))&&!b.animation.states[name])issues.push({severity:'error',path:`animation.states.${name}`,message:`${name} 상태에 애니메이션 클립을 지정하세요.`});
  if(moveBlendActive(b)){
    const move=b.animation.move!,issue=(path:string,message:string)=>issues.push({severity:'error',path:`animation.move.${path}`,message});
    for(const key of ['parameterX','parameterY'] as const)if(!move[key].trim()||move[key]!==move[key].trim()||move[key].length>64||/[\x00-\x1f\x7f-\x9f]/.test(move[key]))issue(key,'파라미터에는 공백으로 시작·끝나지 않는 1~64자 이름을 지정하세요.');
    if(move.parameterX===move.parameterY)issue('parameterY','X와 Y에는 서로 다른 Float 파라미터를 지정하세요.');
    if(move.parameterX==='DirY'||move.parameterY==='DirX')issue('parameterX','DirX는 좌우, DirY는 전후 이동용으로 예약되어 있습니다.');
    if(move.children.length<2)issue('children','방향 블렌드 트리에 클립을 2개 이상 지정하세요.');
    move.children.forEach((child,i)=>{
      if(!child.clip)issue(`children.${i}.clip`,`${i+1}번 Move 클립을 지정하세요.`);
      if(child.timeScale<=0)issue(`children.${i}.timeScale`,'Move 재생 배속은 0보다 커야 합니다.');
      for(let j=0;j<i;j++){
        const a=child.position,c=move.children[j].position,la=Math.hypot(...a),lc=Math.hypot(...c);
        if(Math.hypot(a[0]-c[0],a[1]-c[1])<1e-4||(la>1e-4&&lc>1e-4&&Math.abs((a[0]*c[1]-a[1]*c[0])/(la*lc))<1e-4&&(a[0]*c[0]+a[1]*c[1])>0))issue(`children.${i}.position`,'같은 방향에는 클립 하나만 지정할 수 있습니다.');
      }
    });
  }
  return issues;
}
