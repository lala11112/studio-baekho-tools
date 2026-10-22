// Unity Pipeline run_script, entry FourTigerSessionRegression.Run, in fresh Play Mode.
// This synchronous integration check installs and disposes a session without advancing game frames.
// It checks ownership and restoration; automated movement/hit/video need the separate playback smoke.
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using StudioBaekho.CombatLab;
using StudioBaekho.CombatLab.FourTigerSword;
using UnityEditor;
using UnityEngine;
using UnityEngine.InputSystem;
using Object = UnityEngine.Object;

public static class FourTigerSessionRegression
{
    private const BindingFlags Hidden = BindingFlags.Instance | BindingFlags.NonPublic;

    public static string Run()
    {
        if (!Application.isPlaying) throw new InvalidOperationException("Run FourTigerSessionRegression in freshly entered Play Mode.");
        int checks = 0;
        Action<bool, string> check = (passed, message) =>
        {
            if (!passed) throw new InvalidOperationException("FourTigerSessionRegression: " + message);
            checks++;
        };

        PlayerController player = null;
        foreach (var item in Object.FindObjectsByType<PlayerController>(FindObjectsSortMode.None))
        {
            if (!item.isActiveAndEnabled) continue;
            check(player == null, "Expected exactly one active player.");
            player = item;
        }
        check(player != null && player.Input != null && player.FormManager != null, "Expected initialized player and input.");
        check(player.StateMachine.CurrentState is PlayerIdleState || player.StateMachine.CurrentState is PlayerRunState,
            "Expected player idle/running before the integration check.");
        var sourceField = typeof(PlayerController).GetField("_WaterFormActionData", Hidden);
        var hitStopField = typeof(PlayerController).GetField("_hitStopDuration", Hidden);
        var formsField = typeof(FormManager).GetField("_registeredForms", Hidden);
        check(sourceField != null && hitStopField != null && formsField != null, "Game field contract changed.");
        var source = sourceField.GetValue(player) as WaterFormActionDataSO;
        check(source != null && EditorUtility.IsPersistent(source), "Player must reference its original persistent Water source.");
        string guid = AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(source));
        var originalForm = player.FormManager.CurrentForm;
        var registered = formsField.GetValue(player.FormManager) as HashSet<IForm>;
        check(registered != null, "Registered form collection is unavailable.");
        var originalForms = new HashSet<IForm>(registered);
        float originalHitStop = (float)hitStopField.GetValue(player);
        float originalTimeScale = Time.timeScale;
        bool originalRunInBackground = Application.runInBackground;
        var originalRandom = UnityEngine.Random.state;
        bool originalInputEnabled = player.Input.enabled;
        var originalInputSettings = InputSystem.settings;
        string originalSettingsJson = EditorJsonUtility.ToJson(originalInputSettings);

        var references = new Dictionary<FieldInfo, InputActionReference>();
        var actionStates = new Dictionary<InputAction, bool>();
        foreach (var field in typeof(PlayerInputHandler).GetFields(Hidden))
        {
            if (field.FieldType != typeof(InputActionReference)) continue;
            var reference = field.GetValue(player.Input) as InputActionReference;
            references.Add(field, reference);
            if (reference?.action == null) continue;
            actionStates[reference.action] = reference.action.enabled;
            var look = reference.action.actionMap?.asset?.FindAction("Look");
            if (look != null) actionStates[look] = look.enabled;
        }
        var deviceIds = Devices();
        var assetGuids = PersistentTuningAssets();
        var originalAssetJson = new Dictionary<Object, string> { { source, EditorJsonUtility.ToJson(source) } };
        var originalAssetFiles = new Dictionary<string, byte[]>();
        CaptureFile(source, originalAssetFiles);
        CaptureFile(originalInputSettings, originalAssetFiles);
        foreach (var reference in references.Values)
        {
            var asset = reference?.action?.actionMap?.asset;
            if (asset == null || originalAssetJson.ContainsKey(asset)) continue;
            originalAssetJson.Add(asset, EditorJsonUtility.ToJson(asset));
            CaptureFile(asset, originalAssetFiles);
        }
        foreach (var step in source.ComboSteps)
        {
            if (step.CameraProfile == null || originalAssetJson.ContainsKey(step.CameraProfile)) continue;
            originalAssetJson.Add(step.CameraProfile, EditorJsonUtility.ToJson(step.CameraProfile));
            CaptureFile(step.CameraProfile, originalAssetFiles);
        }

        var adapter = new FourTigerCombatAdapter();
        var candidate = new CombatCandidate { id = "restoration-check", label = "Restoration integration check" };
        foreach (var spec in adapter.Describe(guid))
        {
            // Non-baseline values ensure cloning/restoration are exercised rather than no-op values.
            float value = spec.id == FourTigerCombatAdapter.KnockbackId ? 0.5f
                : spec.id == FourTigerCombatAdapter.CameraId ? 1.5f
                : Mathf.Approximately(originalHitStop, 0.12f) ? 0.09f : 0.12f;
            candidate.values.Add(new ParameterValue(spec.id, value));
        }
        var request = new ExperimentRequest { adapterId = adapter.Id, sourceGuid = guid,
            durationSeconds = 2f, recordVideo = false, candidates = new List<CombatCandidate> { candidate } };
        ICombatLabSession session = null;
        Object[] owned = null;
        try
        {
            adapter.Validate(request);
            session = adapter.Begin(request, candidate);
            check(player.FormManager.CurrentForm is WaterForm && player.FormManager.CurrentForm != originalForm,
                "Session did not install its own Water form.");
            check(registered.Count == originalForms.Count + 1, "Session must register exactly one temporary form.");
            check(Devices().Count == deviceIds.Count + 2, "Session must create exactly two virtual input devices.");
            check(InputSystem.settings != originalInputSettings && !EditorUtility.IsPersistent(InputSystem.settings),
                "Session must install an isolated temporary InputSettings object.");
            check(InputSystem.settings.backgroundBehavior == InputSettings.BackgroundBehavior.IgnoreFocus &&
                InputSystem.settings.editorInputBehaviorInPlayMode == InputSettings.EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView,
                "Virtual input must keep updating when the desktop app has focus.");
            check(EditorJsonUtility.ToJson(originalInputSettings) == originalSettingsJson,
                "Session changed the original InputSettings object.");
            check(Mathf.Approximately((float)hitStopField.GetValue(player), originalHitStop),
                "Selected-action hit stop must not change player defaults or parries.");
            check(session.Metrics.appliedValues.Exists(value => value.id == "runtime.combo.0.hitStopDurationEffective"
                && Mathf.Approximately(value.value, FourTigerCombatAdapter.ReadHitStop(candidate, -1f))),
                "Selected-action hit stop override was not installed and recorded.");
            foreach (var item in references)
            {
                if (item.Value?.action == null) continue;
                var current = item.Key.GetValue(player.Input) as InputActionReference;
                check(current != null && current != item.Value && current.action != item.Value.action,
                    "Input reference was not isolated: " + item.Key.Name);
                check(!EditorUtility.IsPersistent(current) && !EditorUtility.IsPersistent(current.action.actionMap.asset),
                    "Temporary input objects became persistent assets.");
            }
            var ownedField = typeof(FourTigerCombatSession).GetField("_owned", Hidden);
            var ownedList = ownedField?.GetValue(session) as List<Object>;
            check(ownedList != null && ownedList.Count >= 3, "Expected owned action/input clones.");
            owned = ownedList.ToArray();
            foreach (var item in owned) check(item != null && !EditorUtility.IsPersistent(item), "Owned object is null or persistent.");
            session.Tick(0f);
            check(session.Metrics.appliedValues.Exists(value => value.id == "runtime.player.hitStopDuration"),
                "Resolved runtime settings were not recorded.");
            check(session.Metrics.appliedValues.Exists(value => value.id == "runtime.enemy.startCount" && value.value > 0),
                "Initial enemy count was not recorded.");
        }
        finally
        {
            session?.Dispose();
        }

        check(player.FormManager.CurrentForm == originalForm, "Original form was not restored.");
        check(registered.SetEquals(originalForms), "Temporary form leaked or original registered forms changed.");
        check(player.Input.enabled == originalInputEnabled, "Input handler enabled state changed.");
        foreach (var item in references)
            check((InputActionReference)item.Key.GetValue(player.Input) == item.Value, "Input reference identity changed: " + item.Key.Name);
        foreach (var item in actionStates)
            check(item.Key.enabled == item.Value, "Input action enabled state changed: " + item.Key.name);
        check(Devices().SetEquals(deviceIds), "Virtual device leaked or an original device was removed.");
        check(Mathf.Approximately((float)hitStopField.GetValue(player), originalHitStop), "Original hit stop duration was not restored.");
        check(Mathf.Approximately(Time.timeScale, originalTimeScale), "Time scale was not restored.");
        check(Application.runInBackground == originalRunInBackground, "Run-in-background setting was not restored.");
        check(InputSystem.settings == originalInputSettings, "Original InputSettings identity was not restored.");
        check(EditorJsonUtility.ToJson(originalInputSettings) == originalSettingsJson, "Original InputSettings values were changed.");
        check(UnityEngine.Random.state.Equals(originalRandom), "Random state was not restored.");
        foreach (var item in originalAssetJson)
            check(EditorJsonUtility.ToJson(item.Key) == item.Value, "An original tuning asset was changed in memory: " + item.Key.name);
        foreach (var item in originalAssetFiles)
            check(EqualBytes(File.ReadAllBytes(item.Key), item.Value), "An original tuning asset file was changed: " + item.Key);
        check(PersistentTuningAssets().SetEquals(assetGuids), "Session created or removed a persistent tuning asset.");
        foreach (var item in owned) check(item == null, "Owned runtime object survived Dispose.");
        check(!session.Metrics.notes.Exists(note => note.StartsWith("Cleanup warning:", StringComparison.Ordinal)), "Session reported a cleanup failure.");
        // Dispose must also be safe when called more than once by cancel/error shutdown paths.
        session.Dispose();
        check(Devices().SetEquals(deviceIds) && registered.SetEquals(originalForms), "Second Dispose changed restored state.");
        return "FourTigerSessionRegression: " + checks + " checks passed. Runtime isolation, source immutability, input/form/settings restoration and clone/device cleanup verified. No player frames were advanced; this does not validate movement, combat hits or recording.";
    }

    private static HashSet<int> Devices()
    {
        var ids = new HashSet<int>();
        foreach (var device in InputSystem.devices) ids.Add(device.deviceId);
        return ids;
    }

    private static HashSet<string> PersistentTuningAssets()
    {
        var ids = new HashSet<string>(AssetDatabase.FindAssets("t:WaterFormActionDataSO"));
        ids.UnionWith(AssetDatabase.FindAssets("t:AttackCameraProfile"));
        ids.UnionWith(AssetDatabase.FindAssets("t:CombatLabPreset"));
        return ids;
    }

    private static void CaptureFile(Object asset, Dictionary<string, byte[]> files)
    {
        string path = AssetDatabase.GetAssetPath(asset);
        if (string.IsNullOrEmpty(path)) return;
        path = Path.GetFullPath(Path.Combine(Application.dataPath, "..", path));
        if (File.Exists(path) && !files.ContainsKey(path)) files.Add(path, File.ReadAllBytes(path));
    }

    private static bool EqualBytes(byte[] left, byte[] right)
    {
        if (left.Length != right.Length) return false;
        for (int i = 0; i < left.Length; i++) if (left[i] != right[i]) return false;
        return true;
    }
}
