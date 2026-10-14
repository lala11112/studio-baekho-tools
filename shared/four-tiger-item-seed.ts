import type { EffectDraft, Element, Grade } from './four-tiger-items';

type Seed={itemId:string;name:string;element:Element;grade:Grade;effects:EffectDraft[];motif:string};
const effect=(stat:EffectDraft['stat'],amount:number,timed=false):EffectDraft=>({stat,amount,operation:['maxHp','normalDamage','switchDamage'].includes(stat)?'addRatio':'add',unit:['maxHp','normalDamage','switchDamage'].includes(stat)?'ratio':stat==='spRegen'?'SPPerSecond':'SP',trigger:timed?'formSwitchSucceeded':'whileOwned',targetForms:'all',durationSeconds:timed?3:null,stackLimit:1,refreshPolicy:'refresh',removeOnItemLoss:true});
const row=(element:Element,grade:Grade,name:string,motif:string,...effects:EffectDraft[]):Seed=>({itemId:`IT_${element.toUpperCase()}_0${grade}`,element,grade,name,motif,effects});
export const itemSeeds:Seed[]=[
  row('wood',1,'새싹 부적','작은 부적에서 돋은 두 잎 새싹',effect('maxSp',10)),
  row('wood',2,'숨결 매듭','중앙 매듭 사이를 통과하는 한 줄기 숨결',effect('spRegen',3)),
  row('wood',3,'깊은 뿌리','아래로 길게 갈라지는 굵은 뿌리',effect('maxSp',20),effect('normalDamage',.08)),
  row('wood',4,'다시 피는 가지','꺾인 가지 끝에서 다시 벌어지는 새순',effect('spRegen',8,true)),
  row('fire',1,'불씨 장식','불씨 하나를 품은 매달림 장식',effect('normalDamage',.08)),
  row('fire',2,'붉은 인장','불꽃 문양을 새긴 붉은 인장 면과 손잡이',effect('switchDamage',.12)),
  row('fire',3,'타오르는 매듭','매듭 틈에서 피어오르는 불길',effect('normalDamage',.18)),
  row('fire',4,'이어지는 불꽃','끊기지 않는 곡선으로 이어진 두 불꽃',effect('normalDamage',.3,true)),
  row('earth',1,'흙빛 부적','지층 무늬가 겹친 납작한 부적',effect('maxHp',.08)),
  row('earth',2,'가벼운 디딤','작은 디딤돌 위를 스치는 한 발자국',effect('dodgeSpCost',-2)),
  row('earth',3,'단단한 매듭','단단한 돌 하나를 감싼 두꺼운 매듭',effect('maxHp',.18)),
  row('earth',4,'움직이는 산','옆으로 이동하는 산봉우리와 짧은 지면 흔적',effect('dodgeSpCost',-4,true)),
  row('metal',1,'빛나는 조각','면이 드러나는 은색 금속 파편 하나와 빛점',effect('switchDamage',.08)),
  row('metal',2,'맞물린 고리','서로 맞물려 연결된 두 금속 고리',effect('switchSpCost',-1)),
  row('metal',3,'정련된 인장','정교한 은빛 금속 인장과 선명한 각인',effect('switchDamage',.2)),
  row('metal',4,'오색 연결고리','하나의 원을 이루는 다섯 연결고리와 오행 색',effect('normalDamage',.15),effect('switchDamage',.25)),
  row('water',1,'물방울 장식','물방울 모양의 작은 매달림 장식',effect('spRegen',2)),
  row('water',2,'깊은 물병','깊은 푸른 수면이 보이는 목이 좁은 물병',effect('maxSp',15)),
  row('water',3,'흐르는 매듭','흐르는 물줄기가 고리와 매듭을 이루는 형상',effect('dodgeSpCost',-3),effect('switchSpCost',-1)),
  row('water',4,'끊임없는 물결','하나의 원으로 되돌아가는 연속 파도',effect('spRegen',5),effect('switchSpCost',-2)),
];
export const defaultIconStyle='사인검: 한국 전통 문양과 어두운 도시 판타지가 만나는 회화형 퇴마 장신구. 정교하되 작은 크기에서 읽히는 단순하고 서로 다른 실루엣. 단일 물체, 정사각 투명 PNG, 중앙 배치와 사방 10% 여백. 글자·숫자·UI 테두리·등급 프레임 없음. 목=녹색, 화=붉은색, 토=황토색, 금=흰색/은색, 수=푸른색. 색만으로 구분하지 않고 재질과 모티프를 강조.';
