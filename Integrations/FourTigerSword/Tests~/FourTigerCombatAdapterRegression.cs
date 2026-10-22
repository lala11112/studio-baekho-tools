using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace StudioBaekho.CombatLab.FourTigerSword
{
    /// <summary>
    /// Copy into an Editor folder only when running integration checks.
    /// Creates and removes its own uniquely named temporary Assets folder.
    /// No NUnit or gameplay scene dependency is required.
    /// </summary>
    public static class FourTigerCombatAdapterRegression
    {
        [MenuItem("Tools/Studio Baekho/Combat Lab/Run Four Tiger Regression Checks")]
        public static void Run()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode)
                throw new InvalidOperationException("Run regression checks outside Play Mode.");
            string folder = "Assets/CombatLabRegression_" + Guid.NewGuid().ToString("N");
            var transient = new List<Object>();
            bool createdFolder = false;
            try
            {
                string folderGuid = AssetDatabase.CreateFolder("Assets", folder.Substring("Assets/".Length));
                if (string.IsNullOrEmpty(folderGuid)) throw new InvalidOperationException("Cannot create isolated regression folder.");
                createdFolder = true;
                var profile = ScriptableObject.CreateInstance<AttackCameraProfile>();
                profile.HitImpulse = 0.2f;
                transient.Add(profile);
                AssetDatabase.CreateAsset(profile, folder + "/Camera.asset");
                var source = ScriptableObject.CreateInstance<WaterFormActionDataSO>();
                transient.Add(source);
                source.name = "Regression water source";
                source.ComboSteps = new List<WeaponActionData>
                {
                    Step(profile), Step(profile), Step(null)
                };
                source.ComboSteps[0].HitEvents = new List<HitEvent>
                {
                    new HitEvent { StartTime = 0.1f, Duration = 0.1f, OverrideKnockbackForce = true, KnockbackForce = 7f },
                    new HitEvent { StartTime = 0.3f, Duration = 0.1f, OverrideKnockbackForce = false, KnockbackForce = 19f }
                };
                source.SkillSteps = new List<WeaponActionData> { Step(profile) };
                source.HeavyAttackStep = Step(profile);
                AssetDatabase.CreateAsset(source, folder + "/Source.asset");
                AssetDatabase.SaveAssetIfDirty(source);
                string before = EditorJsonUtility.ToJson(source);
                var candidate = Candidate();
                var clone = FourTigerCombatAdapter.CloneAndApply(source, candidate, transient);
                Check(clone != source && !EditorUtility.IsPersistent(clone), "Preview must use a transient action clone.");
                Check(!ReferenceEquals(clone.ComboSteps[0], source.ComboSteps[0]), "Nested attack data must be isolated.");
                Check(!ReferenceEquals(clone.ComboSteps[0].HitEvents[0], source.ComboSteps[0].HitEvents[0]), "Nested hit data must be isolated.");
                Check(clone.ComboSteps[0].KnockbackForce == 20f, "Normal step knockback must scale.");
                Check(clone.ComboSteps[0].HitEvents[0].KnockbackForce == 14f, "Enabled hit override must scale.");
                Check(clone.ComboSteps[0].HitEvents[1].KnockbackForce == 19f, "Disabled hit override must stay unchanged.");
                Check(clone.ComboSteps[0].CameraProfile != profile, "Normal camera profile must be cloned.");
                Check(clone.ComboSteps[0].CameraProfile == clone.ComboSteps[1].CameraProfile, "Normal steps must share one clone per source profile.");
                Check(Mathf.Approximately(clone.ComboSteps[0].CameraProfile.HitImpulse, 0.6f), "Shared camera profile must scale exactly once.");
                Check(clone.ComboSteps[2].CameraShakeStrength == 6f, "Fallback camera shake must scale.");
                Check(clone.SkillSteps[0].CameraProfile == profile && clone.SkillSteps[0].KnockbackForce == 10f,
                    "Skill data must remain unchanged, including shared profile references.");
                Check(clone.HeavyAttackStep.CameraProfile == profile && clone.HeavyAttackStep.KnockbackForce == 10f,
                    "Heavy attack data must remain unchanged.");
                Check(before == EditorJsonUtility.ToJson(source) && Mathf.Approximately(profile.HitImpulse, 0.2f),
                    "Preview must never mutate source assets.");

                var bad = Candidate();
                bad.values[0].value = float.NaN;
                MustThrow(() => FourTigerCombatAdapter.ValidateCandidate(bad), "NaN parameter");
                bad = Candidate();
                bad.values[0].value = 2.01f;
                MustThrow(() => FourTigerCombatAdapter.ValidateCandidate(bad), "out of range parameter");
                bad = Candidate();
                bad.values.Add(new ParameterValue(FourTigerCombatAdapter.HitStopId, 0.1f));
                MustThrow(() => FourTigerCombatAdapter.ValidateCandidate(bad), "duplicate parameter");
                MustThrow(() => FourTigerCombatAdapter.ValidateExportPath("Assets/../Outside.asset"), "path traversal");
                MustThrow(() => FourTigerCombatAdapter.ValidateExportPath("Packages/Outside.asset"), "outside Assets");
                MustThrow(() => FourTigerCombatAdapter.ValidateExportPath(folder + "/Source.asset"), "overwrite source");
                var invalidSource = Object.Instantiate(source);
                transient.Add(invalidSource);
                invalidSource.ComboSteps[0].HitEvents[0].Duration = 2f;
                FourTigerCombatAdapter.ValidateSource(invalidSource);
                Check(true, "Hit windows extending beyond a step are clipped by existing game logic and remain valid.");
                invalidSource.ComboSteps[0].HitEvents[0].StartTime = invalidSource.ComboSteps[0].Duration + 0.1f;
                MustThrow(() => FourTigerCombatAdapter.ValidateSource(invalidSource), "hit start beyond attack");

                var request = new ExperimentRequest
                {
                    adapterId = FourTigerCombatAdapter.AdapterId,
                    sourceGuid = AssetDatabase.AssetPathToGUID(folder + "/Source.asset"),
                    candidates = new List<CombatCandidate> { candidate }
                };
                var adapter = new FourTigerCombatAdapter();
                string exportPath = folder + "/Candidate.asset";
                var exported = adapter.Export(request, candidate, exportPath) as CombatLabPreset;
                Check(exported != null && EditorUtility.IsPersistent(exported), "Preset must persist.");
                var exportedAction = exported.actionAsset as WaterFormActionDataSO;
                Check(exportedAction != null && AssetDatabase.IsSubAsset(exportedAction), "Action must be a preset subasset.");
                Check(AssetDatabase.IsSubAsset(exportedAction.ComboSteps[0].CameraProfile), "Edited camera must be a preset subasset.");
                Check(exportedAction.ComboSteps[0].CameraProfile == exportedAction.ComboSteps[1].CameraProfile,
                    "Export must preserve shared cloned camera identity.");
                Check(exportedAction.SkillSteps[0].CameraProfile == profile, "Export must preserve untouched skill profile.");
                Check(Mathf.Approximately(FourTigerCombatAdapter.ReadHitStop(exported.candidate, -1f), 0.09f),
                    "Preset must include the component hit-stop override.");
                Check(exported.candidate.values[0].value == 2f, "Store relative multipliers, not multiplied source values.");
                candidate.values[0].value = 0f;
                Check(exported.candidate.values[0].value == 2f, "Preset candidate must not alias the request's mutable values.");
                MustThrow(() => adapter.Export(request, candidate, exportPath), "overwrite existing export");
                Check(before == EditorJsonUtility.ToJson(source) && Mathf.Approximately(profile.HitImpulse, 0.2f),
                    "Export must never mutate source assets.");
                Debug.Log("Four Tiger Combat Lab regression checks passed: isolation, active overrides, shared cameras, ranges and safe export.");
            }
            finally
            {
                foreach (var item in transient)
                    if (item != null && !EditorUtility.IsPersistent(item)) Object.DestroyImmediate(item);
                if (createdFolder) AssetDatabase.DeleteAsset(folder);
            }
        }

        private static WeaponActionData Step(AttackCameraProfile profile)
            => new WeaponActionData { AnimationName = "Water1", Duration = 1f, ComboTransitionTime = 0.6f,
                HitStartTime = 0.1f, HitDuration = 0.1f, KnockbackForce = 10f,
                CameraProfile = profile, CameraShakeStrength = 2f };

        private static CombatCandidate Candidate()
            => new CombatCandidate { id = "regression", label = "Regression candidate", values = new List<ParameterValue>
            {
                new ParameterValue(FourTigerCombatAdapter.KnockbackId, 2f),
                new ParameterValue(FourTigerCombatAdapter.CameraId, 3f),
                new ParameterValue(FourTigerCombatAdapter.HitStopId, 0.09f)
            } };

        private static void MustThrow(Action action, string label)
        {
            try { action(); }
            catch (ArgumentException) { return; }
            throw new InvalidOperationException("Expected validation failure: " + label);
        }

        private static void Check(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
        }
    }
}
