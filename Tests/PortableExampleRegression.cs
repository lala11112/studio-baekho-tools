// Copy only into a clean verification project's Assets/Editor, with the Example
// integration installed. Launch Unity in batch mode WITHOUT -quit, using
// -executeMethod PortableExampleRegression.Run. The check exits the Editor itself.
using System;
using System.IO;
using System.Linq;
using StudioBaekho.CombatLab;
using StudioBaekho.CombatLab.Example;
using UnityEditor;
using UnityEngine;

[InitializeOnLoad]
public static class PortableExampleRegression
{
    private const string Key = "CombatLab.PortableVerification";

    static PortableExampleRegression() { EditorApplication.update += Poll; }

    public static void Run()
    {
        try
        {
            Check(!Application.isPlaying, "Verification starts in Edit Mode.");
            Check(CombatLab.Adapters().Count == 1 && CombatLab.Adapters()[0].Id == ExampleCombatAdapter.AdapterId,
                "Only the independent example adapter is installed.");
            ExampleSceneSetup.CreateDemoScene();
            var adapter = new ExampleCombatAdapter();
            var actor = UnityEngine.Object.FindFirstObjectByType<ExampleCombatActor>();
            Check(actor != null && actor.actionData != null && actor.target != null, "Created scene has live actor/data/target references.");
            var source = adapter.DiscoverSources().Single(s => AssetDatabase.GUIDToAssetPath(s.guid) == AssetDatabase.GetAssetPath(actor.actionData));
            Check(adapter.DiscoverActions(source.guid).Single().id == "strike", "Custom action ID is discovered.");
            var request = CombatLab.CreateComparison(adapter.Id, source.guid, "strike");
            request.candidates = request.candidates.Take(2).ToList();
            request.durationSeconds = 3f;
            request.recordVideo = false;
            CombatLab.Validate(request);
            var original = AssetDatabase.LoadAssetAtPath<ExampleActionData>(AssetDatabase.GUIDToAssetPath(source.guid));
            string before = EditorJsonUtility.ToJson(original);
            const string exportPath = "Assets/CombatLabExampleData/Export Verification.asset";
            var exported = CombatLab.Export(request, request.candidates[1].id, exportPath) as ExampleActionData;
            Check(exported != null && exported != original && EditorUtility.IsPersistent(exported), "Export is a separate runtime SO.");
            Check(Mathf.Approximately(exported.damage, request.candidates[1].values.Single(v => v.id == "damage").value), "Export retains candidate damage.");
            Check(EditorJsonUtility.ToJson(original) == before, "Export preserves the original source.");
            AssetDatabase.DeleteAsset(exportPath);
            SessionState.SetString(Key + ".source", source.guid);
            SessionState.SetString(Key + ".before", before);
            SessionState.SetString(Key + ".started", DateTime.UtcNow.ToString("O"));
            SessionState.SetString(Key, CombatLabRunner.Start(request));
        }
        catch (Exception error) { Finish(false, error.ToString()); }
    }

    private static void Poll()
    {
        string directory = SessionState.GetString(Key, "");
        if (string.IsNullOrEmpty(directory)) return;
        try
        {
            if ((DateTime.UtcNow - DateTime.Parse(SessionState.GetString(Key + ".started", ""), null,
                System.Globalization.DateTimeStyles.RoundtripKind)).TotalSeconds > 180)
                throw new TimeoutException("Portable example run did not finish within 180 seconds.");
            if (CombatLabRunner.IsRunning || EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isCompiling) return;
            var report = JsonUtility.FromJson<ExperimentReport>(File.ReadAllText(Path.Combine(directory, "report.json")));
            Check(report.results.Count == 2, "Both candidates produced a report.");
            foreach (var result in report.results)
            {
                Check(result.status == "completed" && result.metrics.hits > 0, "Each candidate produces actual damage events: " + result.error);
                Check(result.metrics.appliedValues.Count == 3, "All candidate values are recorded.");
                Check(result.metrics.events.Any(e => e.kind == "hit"), "Damage is observed through the target event.");
            }
            var original = AssetDatabase.LoadAssetAtPath<ExampleActionData>(AssetDatabase.GUIDToAssetPath(SessionState.GetString(Key + ".source", "")));
            Check(EditorJsonUtility.ToJson(original) == SessionState.GetString(Key + ".before", ""), "Play Mode preserves the source asset.");
            Check(!UnityEngine.SceneManagement.SceneManager.GetActiveScene().isDirty, "The demo scene stays saved after playback.");
            Finish(true, "Independent Unity project: compile, discovery, custom action, export, two fresh Play Mode candidates, damage events, original preservation passed. Report: " + directory);
        }
        catch (Exception error) { Finish(false, error.ToString()); }
    }

    private static void Check(bool condition, string detail)
    {
        if (!condition) throw new InvalidOperationException(detail);
    }

    [Serializable] private sealed class Result { public bool passed; public string detail; }

    private static void Finish(bool passed, string detail)
    {
        SessionState.EraseString(Key);
        File.WriteAllText(Path.Combine(Application.dataPath, "..", "verification.json"),
            JsonUtility.ToJson(new Result { passed = passed, detail = detail }, true));
        EditorApplication.Exit(passed ? 0 : 1);
    }
}
