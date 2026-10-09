using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace StudioBaekho.AutoHitTimer.FourTigerSword
{
    // No NUnit/asmdef dependency: this integration lives beside Assembly-CSharp in the game's Editor folder.
    // Run in an isolated validation project: -executeMethod StudioBaekho.AutoHitTimer.FourTigerSword.FourTigerAutoHitTimerRegression.Run
    public static class FourTigerAutoHitTimerRegression
    {
        [MenuItem("Tools/Studio Baekho/Auto Hit Timer/Run Adapter Regression")]
        public static void Run()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode) throw new InvalidOperationException("편집 모드에서 실행하세요.");
            Mapping();
            AssetTransactions();
            Debug.Log("[Auto Hit Timer] Four Tiger adapter regression PASS: mapping, inheritance, time guards, support matrix, stale checks, duplicate apply, copy, registration, Undo.");
        }

        private static void Mapping()
        {
            var action = new WeaponActionData { Damage = 27, PoiseDamage = 31, Duration = 1, HitStartTime = 0.1f, HitDuration = 0.2f };
            action.Feedback.HitStop.OverrideHitStop = true;
            action.Feedback.HitStop.HitStopDuration = 0.17f;
            var single = FourTigerHitMapping.Map(action, Windows(0.2f, 0.4f, 0), 1);
            Assert(single.HitEvents.Count == 0 && Near(single.HitStartTime, 0.2f) && Near(single.HitDuration, 0.2f), "legacy single-hit mapping");
            Assert(Near(single.Damage, 27) && Near(single.Feedback.HitStop.HitStopDuration, 0.17f), "action balance and feedback preservation");
            Assert(Near(action.HitStartTime, 0.1f), "mapping must not mutate input");
            var multi = FourTigerHitMapping.Map(action, new JArray(Window(0.2f, 0.3f, 0), Window(0.5f, 0.6f, -1)), 1);
            Assert(multi.HitEvents.Count == 2 && multi.HitEvents.All(h => h.Damage == 0 && h.PoiseDamage == 0), "new events inherit damage and poise");
            Assert(multi.HitEvents.All(h => !h.OverrideHitStop && !h.OverrideHitVFX && !h.OverrideKnockbackForce), "new event overrides disabled");
            Assert(Near(FourTigerHitMapping.DamageSum(multi), 54), "added hit damage preview");
            multi.HitEvents[1].Damage = 99;
            multi.HitEvents[1].OverrideHitStop = true;
            multi.HitEvents[1].HitStopDuration = 0.25f;
            var survivor = FourTigerHitMapping.Map(multi, Windows(0.4f, 0.7f, 1), 1);
            Assert(survivor.HitEvents.Count == 1 && survivor.HitEvents[0].Damage == 99 && survivor.HitEvents[0].OverrideHitStop,
                "reducing multi-hit must preserve selected event overrides");
            Assert(Near(survivor.HitEvents[0].HitStopDuration, 0.25f), "mapped hit feedback preservation");
            var none = FourTigerHitMapping.Map(multi, new JArray(), 1);
            Assert(none.HitEvents.Count == 0 && none.HitDuration == 0 && FourTigerHitMapping.DamageSum(none) == 0, "zero hits disables legacy fallback");
            Throws(() => FourTigerHitMapping.Map(action, Windows(-0.1f, 0.2f, 0), 1), "negative start rejected");
            Throws(() => FourTigerHitMapping.Map(action, Windows(0.1f, 1.1f, 0), 1), "beyond clip rejected");
            Throws(() => FourTigerHitMapping.Map(action, new JArray(Window(0.2f, 0.3f, 0), Window(0.4f, 0.5f, 0)), 1), "duplicate old mapping rejected");
            Throws(() => FourTigerHitMapping.Map(action, new JArray(Window(0.5f, 0.6f, 0), Window(0.1f, 0.2f, -1)), 1), "unsorted windows rejected");
            Throws(() => FourTigerHitMapping.ApplyTimeOverrides(action, new JArray(new JObject { ["path"] = "Balance.Damage", ["value"] = 0 })), "time override whitelist");
            Assert(FourTigerHitMapping.InvalidTimes(action, 0.1f).Count > 0, "short clip template time guard");
            FourTigerHitMapping.ApplyTimeOverrides(action, new JArray(new JObject { ["path"] = "Execution.ComboTransitionTime", ["value"] = 0.8 }));
            Assert(Near(action.ComboTransitionTime, 0.8f), "time override applies");
            var fire = ScriptableObject.CreateInstance<FireFormActionDataSO>();
            var iron = ScriptableObject.CreateInstance<IronFormActionDataSO>();
            var water = ScriptableObject.CreateInstance<WaterFormActionDataSO>();
            try
            {
                Assert(FourTigerHitMapping.UnsupportedReason(fire, "skill") == null && FourTigerHitMapping.UnsupportedReason(fire, "ultimate") != null, "fire support matrix");
                Assert(FourTigerHitMapping.UnsupportedReason(iron, "ultimate") == null, "iron ultimate support");
                Assert(FourTigerHitMapping.UnsupportedReason(water, "combo") == null && FourTigerHitMapping.UnsupportedReason(water, "heavy") != null, "water special exclusion");
            }
            finally { UnityEngine.Object.DestroyImmediate(fire); UnityEngine.Object.DestroyImmediate(iron); UnityEngine.Object.DestroyImmediate(water); }
        }

        private static void AssetTransactions()
        {
            var previousScene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
            if (string.IsNullOrEmpty(previousScene.path))
                throw new InvalidOperationException("검증 프로젝트의 시작 씬을 저장한 뒤 회귀 검사를 실행하세요. 기존 미저장 씬은 자동으로 저장하거나 폐기하지 않습니다.");
            string folder = "Assets/__AutoHitTimerRegression_" + Guid.NewGuid().ToString("N");
            AssetDatabase.CreateFolder("Assets", folder.Substring("Assets/".Length));
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Additive);
            try
            {
                var clip = new AnimationClip { name = "RegressionAttack", frameRate = 60 };
                clip.SetCurve("", typeof(Transform), "localPosition.x", AnimationCurve.Linear(0, 0, 1, 1));
                AssetDatabase.CreateAsset(clip, folder + "/Attack.anim");
                var controller = AnimatorController.CreateAnimatorControllerAtPath(folder + "/Actor.controller");
                var state = controller.layers[0].stateMachine.AddState("Attack");
                state.motion = clip;
                var go = new GameObject("Auto Hit Timer regression actor");
                UnityEngine.SceneManagement.SceneManager.MoveGameObjectToScene(go, scene);
                var animator = go.AddComponent<Animator>();
                animator.runtimeAnimatorController = controller;
                var source = ScriptableObject.CreateInstance<FireFormActionDataSO>();
                source.name = "Regression Fire";
                source.ComboSteps = new List<WeaponActionData> { new WeaponActionData { AnimationName = "Attack", Duration = 1, Damage = 23 } };
                AssetDatabase.CreateAsset(source, folder + "/Form.asset");
                AssetDatabase.SaveAssets();
                EditorSceneManager.SaveScene(scene, folder + "/Actor.unity");
                string actorId = GlobalObjectId.GetGlobalObjectIdSlow(animator).ToString();
                var adapter = new FourTigerAutoHitTimerAdapter();
                var request = new JObject { ["actorId"] = actorId, ["sourceGuid"] = AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(source)),
                    ["actionPath"] = "Actions.ComboSteps.Array.data[0]", ["mode"] = "update", ["clip"] = AutoHitTimerAssets.ClipRef(clip),
                    ["windows"] = Windows(0.25f, 0.45f, 0), ["copy"] = false };
                var preview = adapter.PreviewChange(request);
                Assert((bool)preview["canApply"], "existing action preview");
                Assert((string)adapter.SaveStatus(new JObject { ["changeId"] = preview["changeId"] })["status"] == "preview", "save status before mutation");
                Assert((string)adapter.SaveStatus(new JObject { ["changeId"] = Guid.NewGuid().ToString("N") })["status"] == "missing", "missing save status");
                source.ComboSteps[0].Damage = 24;
                Throws(() => adapter.Apply(new JObject { ["changeId"] = preview["changeId"] }), "stale SO rejected");
                source.ComboSteps[0].Damage = 23;
                preview = adapter.PreviewChange(request);
                var result = adapter.Apply(new JObject { ["changeId"] = preview["changeId"] });
                Assert(Near(source.ComboSteps[0].HitStartTime, 0.25f) && source.ComboSteps[0].Damage == 23, "apply changes only timing");
                var repeated = adapter.Apply(new JObject { ["changeId"] = preview["changeId"] });
                Assert(JToken.DeepEquals(result, repeated) && source.ComboSteps.Count == 1, "duplicate apply returns previous result");
                var saveStatus = adapter.SaveStatus(new JObject { ["changeId"] = preview["changeId"] });
                Assert((string)saveStatus["status"] == "complete" && JToken.DeepEquals(result, saveStatus["result"]), "durable completed result can be recovered without mutation");
                Undo.PerformUndo();
                Assert(Near(source.ComboSteps[0].HitStartTime, 0.1f), "Undo restores original hit timing");
                AssetDatabase.SaveAssetIfDirty(source);

                request["mode"] = "register";
                request["group"] = "combo";
                request["templatePath"] = "Actions.ComboSteps.Array.data[0]";
                request["stateName"] = "Attack";
                request["copy"] = true;
                request["outputFolder"] = folder + "/New/Nested";
                preview = adapter.PreviewChange(request);
                Assert((bool)preview["canApply"] && (string)preview["proposedStateName"] == "Attack_2", "registration preview creates unique name");
                Assert((int)preview["hitCountBefore"] == 0, "append preview counts no previous destination hits");
                result = adapter.Apply(new JObject { ["changeId"] = preview["changeId"] });
                var assets = (JArray)result["assets"];
                var copiedSource = AssetDatabase.LoadAssetAtPath<FireFormActionDataSO>((string)assets[0]["path"]);
                var copiedController = AssetDatabase.LoadAssetAtPath<AnimatorController>((string)assets[1]["path"]);
                Assert(copiedSource.ComboSteps.Count == 2 && source.ComboSteps.Count == 1, "copy registration preserves original SO");
                Assert(controller.layers[0].stateMachine.states.Length == 1 && copiedController.layers[0].stateMachine.states.Length == 2, "copy registration preserves original controller");
                Assert(copiedSource.ComboSteps[1].AnimationName == "Attack_2" && Near(copiedSource.ComboSteps[1].Duration, clip.length), "new action state and duration");
                Assert(copiedController.layers[0].stateMachine.states.Any(s => s.state.name == "Attack_2" && s.state.motion == clip), "new controller state clip");
                Assert(JToken.DeepEquals(result, adapter.Apply(new JObject { ["changeId"] = preview["changeId"] })), "duplicate registration does not append again");

                request["outputFolder"] = folder + "/Rollback/Nested";
                preview = adapter.PreviewChange(request);
                FourTigerAutoHitTimerAdapter.BeforePersistForTests = () => { throw new IOException("Injected persistence failure"); };
                try { Throws(() => adapter.Apply(new JObject { ["changeId"] = preview["changeId"] }), "save failure rolls back"); }
                finally { FourTigerAutoHitTimerAdapter.BeforePersistForTests = null; }
                Assert((string)adapter.SaveStatus(new JObject { ["changeId"] = preview["changeId"] })["status"] == "rolled-back", "durable rollback status");
                Assert(!AssetDatabase.IsValidFolder(folder + "/Rollback"), "failed copy removes created assets and empty folders");
                Assert(source.ComboSteps.Count == 1 && controller.layers[0].stateMachine.states.Length == 1, "failed registration preserves original assets");

                request["mode"] = "update";
                request["copy"] = false;
                state.speed = 2;
                preview = adapter.PreviewChange(request);
                Assert(!(bool)preview["canApply"], "non-unit state speed blocked");
                state.speed = 1;
                state.cycleOffset = 0.3f;
                Assert(!(bool)adapter.PreviewChange(request)["canApply"], "state cycle offset blocked");
                state.cycleOffset = 0;
                source.ComboSteps.Add(FourTigerHitMapping.Clone(source.ComboSteps[0]));
                Assert(!(bool)adapter.PreviewChange(request)["canApply"], "consecutive same-state steps blocked");
            }
            finally
            {
                FourTigerAutoHitTimerAdapter.BeforePersistForTests = null;
                EditorSceneManager.CloseScene(scene, true);
                if (previousScene.IsValid() && previousScene.isLoaded) UnityEngine.SceneManagement.SceneManager.SetActiveScene(previousScene);
                AssetDatabase.DeleteAsset(folder);
            }
        }

        private static JObject Window(float start, float end, int index) => new JObject { ["start"] = start, ["end"] = end, ["sourceIndex"] = index };
        private static JArray Windows(float start, float end, int index) => new JArray(Window(start, end, index));
        private static bool Near(float a, float b) => Mathf.Abs(a - b) < 0.0001f;
        private static void Assert(bool condition, string label) { if (!condition) throw new Exception("Auto Hit Timer regression failed: " + label); }
        private static void Throws(Action action, string label)
        {
            try { action(); } catch (ArgumentException) { return; } catch (InvalidOperationException) { return; }
            throw new Exception("Auto Hit Timer regression expected rejection: " + label);
        }
    }
}
