import type { EnemyBlueprint, MoveBlendTree, ValidationIssue } from './types';
export function defaultMoveBlend(speed=1):MoveBlendTree {
  const extent=Number.isFinite(speed)&&speed>0?speed:1;
  return {type:'blend2d',parameterX:'DirX',parameterY:'DirY',overrideController:false,children:[[0,0],[0,extent],[0,-extent],[extent,0],[-extent,0]].map(position=>({clip:null,position,timeScale:1}))};
}
export function moveBlendActive(b:EnemyBlueprint):boolean {return !!b.animation.move&&(b.animation.mode==='clips'||b.animation.move.overrideController);}
export function emptyBlueprint(): EnemyBlueprint {
  return {version:1,name:'NewEnemy',template:null,model:null,modelTransform:{position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]},stats:{},components:{},animation:{mode:'clips',controller:null,states:{Idle:null,Move:null,Groggy:null},move:defaultMoveBlend()},attacks:[],selfDestruct:null,hpBarPosition:[0,3,0],vfxPosition:[0,1,0],anchors:{hpBar:'auto',vfx:'auto'}};
}
export function validateBlueprint(value: unknown): asserts value is EnemyBlueprint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('적 설계 문서가 아닙니다.');
  const b = value as EnemyBlueprint;
  if (b.version !== 1) throw new Error('지원하지 않는 설계 문서 버전입니다.');
  if (typeof b.name !== 'string' || b.name!==b.name.trim() || !/^[\p{L}\p{N}_ -]{1,64}$/u.test(b.name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(b.name)) throw new Error('적 이름은 1~64자의 문자·숫자·공백·밑줄·하이픈을 사용하세요.');
  if (!b.animation || !['clips','controller'].includes(b.animation.mode) || !record(b.animation.states) || !record(b.stats) || !record(b.components) || !Array.isArray(b.attacks)) throw new Error('설계 문서 구조가 올바르지 않습니다.');
  const attacks = [...b.attacks, ...(b.selfDestruct ? [b.selfDestruct] : [])];
  if (attacks.length > 64 || attacks.some(a=>!a || typeof a.id!=='string' || typeof a.typeId!=='string' || !record(a.values)) || new Set(attacks.map(a=>a.id)).size!==attacks.length) throw new Error('공격 목록이 올바르지 않습니다.');
  for (const vector of [b.modelTransform?.position,b.modelTransform?.rotation,b.modelTransform?.scale,b.hpBarPosition,b.vfxPosition]) if (!Array.isArray(vector)||vector.length!==3||vector.some(n=>!Number.isFinite(n))) throw new Error('위치·회전·크기에는 유한한 숫자 3개가 필요합니다.');
  if (b.modelTransform.scale.some(n=>n<=0)) throw new Error('모델 크기는 0보다 커야 합니다.');
  if(b.anchors&&(!record(b.anchors)||!['auto','manual'].includes(b.anchors.hpBar)||!['auto','manual'].includes(b.anchors.vfx)))throw new Error('표시 위치의 자동·수동 설정이 올바르지 않습니다.');
  if(b.animation.move!==undefined){
    const move=b.animation.move;
    if(!record(move)||move.type!=='blend2d'||typeof move.parameterX!=='string'||typeof move.parameterY!=='string'||typeof move.overrideController!=='boolean'||!Array.isArray(move.children)||move.children.length>32)throw new Error('Move 방향 블렌드 트리 구조가 올바르지 않습니다.');
    for(const child of move.children)if(!child||!Array.isArray(child.position)||child.position.length!==2||child.position.some(n=>!Number.isFinite(n))||!Number.isFinite(child.timeScale)||(child.clip!==null&&!record(child.clip)))throw new Error('Move 클립의 좌표·재생 배속이 올바르지 않습니다.');
  }
  walk(b,0);
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
  if(!b.model)issues.push({severity:'error',path:'model',message:'모델을 선택하세요.'});
  if(!b.attacks.length)issues.push({severity:'warning',path:'attacks',message:'일반 공격이 없는 적입니다.'});
  const names=[...b.attacks,...(b.selfDestruct?[b.selfDestruct]:[])].map(a=>String(a.values.animName??''));
  if(b.animation.mode==='clips')for(const name of new Set(['Idle','Move','Groggy',...names]))if(name&&!(name==='Move'&&moveBlendActive(b))&&!b.animation.states[name])issues.push({severity:'error',path:`animation.states.${name}`,message:`${name} 상태에 애니메이션 클립을 지정하세요.`});
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
