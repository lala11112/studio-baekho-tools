// Run with Unity Pipeline run_script in fresh Play Mode, entry FourTigerActionSessionRegression.Run.
// This checks per-action setup and exact cleanup. Real input execution is checked by the playback smoke.
using System;
using System.Collections.Generic;
using System.Reflection;
using StudioBaekho.CombatLab;
using StudioBaekho.CombatLab.FourTigerSword;
using UnityEditor;
using UnityEngine;
using UnityEngine.InputSystem;
using Object = UnityEngine.Object;

public static class FourTigerActionSessionRegression
{
    private const BindingFlags Hidden = BindingFlags.Instance | BindingFlags.NonPublic;

    public static string Run()
    {
        if (!Application.isPlaying) throw new InvalidOperationException("Run in fresh Play Mode.");
        int checks = 0, scenarios = 0;
        Action<bool, string> check = (passed, message) => {
            if (!passed) throw new InvalidOperationException("FourTigerActionSessionRegression: " + message);
            checks++;
        };
        var player = Object.FindFirstObjectByType<PlayerController>();
        check(player != null && player.isActiveAndEnabled && player.StatManager != null, "Initialized player required.");
        var adapter = new FourTigerCombatAdapter();
        var originalForm = player.FormManager.CurrentForm;
        var originalSettings = InputSystem.settings;
        var formsField = typeof(FormManager).GetField("_registeredForms", Hidden);
        var forms = formsField.GetValue(player.FormManager) as HashSet<IForm>;
        var originalForms = new HashSet<IForm>(forms);
        int originalDevices = InputSystem.devices.Count;
        var spField = typeof(PlayerStatManager).GetField("_currentSp", Hidden);
        var regenField = typeof(PlayerStatManager).GetField("_spRegenTimer", Hidden);
        var gaugeField = typeof(PlayerStatManager).GetField("_currentUltimateGauge", Hidden);
        float originalSp = player.StatManager.CurrentSp;
        float originalRegen = (float)regenField.GetValue(player.StatManager);
        float originalGauge = player.StatManager.CurrentUltimateGauge;
        float fixtureSp = Mathf.Min(17f, player.StatManager.MaxSp * 0.25f);
        float fixtureGauge = player.StatManager.MaxUltimateGauge * 0.25f;
        float originalAtk = player.StatManager.GetStat(StatType.ST_ATK);
        float originalSpeed = player.StatManager.GetStat(StatType.ST_ATK_SPD);
        var hitStopField = typeof(PlayerController).GetField("_hitStopDuration", Hidden);
        float originalHitStop = (float)hitStopField.GetValue(player);
        var references = new Dictionary<FieldInfo, InputActionReference>();
        foreach (var field in typeof(PlayerInputHandler).GetFields(Hidden))
            if (field.FieldType == typeof(InputActionReference)) references[field] = (InputActionReference)field.GetValue(player.Input);
        try
        {
            // Deliberately non-full values verify scenario fixture restoration instead of a no-op.
            spField.SetValue(player.StatManager, fixtureSp);
            regenField.SetValue(player.StatManager, 1.25f);
            gaugeField.SetValue(player.StatManager, fixtureGauge);
            foreach (var discovered in adapter.DiscoverSources())
            {
                var source = FourTigerCombatAdapter.ResolveSource(discovered.guid);
                string sourceJson = EditorJsonUtility.ToJson(source);
                foreach (var action in adapter.DiscoverActions(discovered.guid))
                {
                    if (!action.available) continue;
                    var candidate = new CombatCandidate { id = "session-action-check", label = action.label };
                    foreach (var spec in adapter.Describe(discovered.guid, action.id))
                        candidate.values.Add(new ParameterValue(spec.id, spec.baseline));
                    var request = new ExperimentRequest { adapterId = adapter.Id, sourceGuid = discovered.guid,
                        actionId = action.id, durationSeconds = 5f, recordVideo = false,
                        candidates = new List<CombatCandidate> { candidate } };
                    FourTigerCombatSession session = null;
                    try
                    {
                        session = new FourTigerCombatSession(request, candidate);
                        var data = typeof(FourTigerCombatSession).GetField("_data", Hidden).GetValue(session) as WeaponActionDataSO;
                        check(data != null && data != source && !EditorUtility.IsPersistent(data), action.id + " source clone ownership");
                        check(data.GetType() == source.GetType(), action.id + " clone type");
                        check(player.FormManager.CurrentForm.GetType() == FourTigerCombatAdapter.CreateForm(source).GetType(), action.id + " actual form factory");
                        check(InputSystem.devices.Count == originalDevices + 2, action.id + " virtual devices");
                        check(InputSystem.settings != originalSettings, action.id + " isolated input settings");
                        check(Mathf.Approximately((float)hitStopField.GetValue(player), originalHitStop), action.id + " player hit stop unchanged");
                        var hitStopCandidate = candidate.values.Find(value => value.id == FourTigerCombatAdapter.HitStopId);
                        if (hitStopCandidate != null)
                        {
                            var durations = session.Metrics.appliedValues.FindAll(value => value.id.EndsWith(".hitStopDurationEffective", StringComparison.Ordinal));
                            check(durations.Count > 0 && durations.TrueForAll(value => Mathf.Approximately(value.value, hitStopCandidate.value)),
                                action.id + " selected effective hit stop recorded");
                        }
                        string specialMetric = action.id == "skill" && data is WoodFormActionDataSO ? "SkillRadius"
                            : action.id != "ultimate" ? null : data is WaterFormActionDataSO ? "AreaRadius"
                            : data is FireFormActionDataSO ? "FireUltimateDamageDealtBonusPercent"
                            : data is EarthFormActionDataSO ? "UltimateShieldAmount" : data is WoodFormActionDataSO ? "UltimateRadius" : null;
                        if (specialMetric != null)
                            check(session.Metrics.appliedValues.Exists(value => value.id == "runtime.action." + specialMetric), action.id + " grouped form snapshot recorded");
                        if (action.id == "ultimate" && data is WaterFormActionDataSO)
                            check(session.Metrics.appliedValues.Exists(value => value.id == "runtime.ultimate.0.hit.9.hitStopDurationEffective"), "Water tenth hit inheritance recorded");
                        if (action.id.StartsWith("normal-", StringComparison.Ordinal) && action.id != "normal-combo")
                        {
                            int index = int.Parse(action.id.Substring(7)) - 1;
                            check(data.ComboSteps.Count == 1, action.id + " isolated step count");
                            check(data.ComboSteps[0].AnimationName == source.ComboSteps[index].AnimationName, action.id + " isolated animation");
                        }
                        if (action.id == "skill")
                        {
                            check(Mathf.Approximately(player.StatManager.CurrentSp, player.StatManager.MaxSp), "SP fixture is full");
                            check(player.FormManager.CurrentForm.CanSkill, "Skill ready after setup");
                            check(HasBinding(player, "_skillAction", "<Keyboard>/e"), "E virtual binding");
                            player.StatManager.TryConsumeSp(1f);
                        }
                        if (action.id == "ultimate")
                        {
                            check(player.StatManager.IsUltimateGaugeReady, "Ultimate fixture is full");
                            check(player.FormManager.CurrentForm.CanUltimate, "Ultimate ready after setup");
                            check(HasBinding(player, "_ultimateAction", "<Keyboard>/r"), "R virtual binding");
                            player.StatManager.ConsumeAllUltimateGauge();
                        }
                        if (action.id == "heavy")
                        {
                            check(player.FormManager.CurrentForm is WaterForm water && water.HeavyAttackCharges == 3 && water.CanHeavyAttack,
                                "Water heavy fixture must start with three real charges");
                        }
                        check(EditorJsonUtility.ToJson(source) == sourceJson, action.id + " original data unchanged during setup");
                    }
                    finally { session?.Dispose(); }
                    scenarios++;
                    check(player.FormManager.CurrentForm == originalForm && forms.SetEquals(originalForms), action.id + " form restoration");
                    check(InputSystem.devices.Count == originalDevices && InputSystem.settings == originalSettings, action.id + " input cleanup");
                    check(Mathf.Approximately(player.StatManager.CurrentSp, fixtureSp) && Mathf.Approximately((float)regenField.GetValue(player.StatManager), 1.25f), action.id + " SP + regeneration restoration");
                    check(Mathf.Approximately(player.StatManager.CurrentUltimateGauge, fixtureGauge), action.id + " ultimate gauge restoration");
                    check(Mathf.Approximately(player.StatManager.GetStat(StatType.ST_ATK), originalAtk)
                        && Mathf.Approximately(player.StatManager.GetStat(StatType.ST_ATK_SPD), originalSpeed), action.id + " no modifier leakage");
                    foreach (var item in references) check(ReferenceEquals(item.Key.GetValue(player.Input), item.Value), action.id + " original reference " + item.Key.Name);
                    check(EditorJsonUtility.ToJson(source) == sourceJson, action.id + " original data unchanged after disposal");
                    check(!session.Metrics.notes.Exists(note => note.StartsWith("Cleanup warning:", StringComparison.Ordinal)), action.id + " no cleanup warning");
                }
            }
        }
        finally
        {
            spField.SetValue(player.StatManager, originalSp);
            regenField.SetValue(player.StatManager, originalRegen);
            gaugeField.SetValue(player.StatManager, originalGauge);
            player.StatManager.AddSp(0f);
            player.StatManager.AddUltimateGauge(0f);
            spField.SetValue(player.StatManager, originalSp);
            gaugeField.SetValue(player.StatManager, originalGauge);
        }
        return "FourTigerActionSessionRegression: " + checks + " checks passed across " + scenarios + " action scenarios; isolated normal steps, action bindings, resource fixtures and cleanup verified. Playback execution is verified separately.";
    }

    private static bool HasBinding(PlayerController player, string fieldName, string path)
    {
        var reference = (InputActionReference)typeof(PlayerInputHandler).GetField(fieldName, Hidden).GetValue(player.Input);
        foreach (var binding in reference.action.bindings) if (binding.effectivePath == path) return true;
        return false;
    }
}
