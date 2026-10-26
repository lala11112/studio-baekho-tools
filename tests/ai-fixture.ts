export function candidate(ns='Baekho.Generated.a0123456789abcdef0123456789abcdef'){return {
  status:'implemented',summary:'전방에 한 번 타격합니다.',name:'시험 공격',description:'검증용 단타 공격',typeName:'TestAttackSO',
  files:[{className:'TestAttackSO',source:`using UnityEngine; namespace ${ns} { public class TestAttackSO : MonsterSkillData { public float damage = 1f; public override EnemyAction CreateAction(Enemy enemy) { return new TestAction(this,enemy); } } }`},
    {className:'TestAction',source:`namespace ${ns} { public class TestAction : EnemyAction { public TestAction(MonsterSkillData data, Enemy enemy) : base(data,enemy) {} public override void Enter() { base.Enter(); } public override void Update() { base.Update(); IsFinished = true; } public override void Exit() { base.Exit(); } } }` }],
  defaultsJson:JSON.stringify({animName:'Attack_Test',damage:1,attackSpeed:1}),previewJson:JSON.stringify({shapes:[{shape:'sphere',start:0.2,end:0.4,radius:1,offset:[0,0,1]}]}),previewSupported:true
};}
