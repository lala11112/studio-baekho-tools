// Copy alongside the importer into the isolated .local/unity-validation project.
// This suite uses reflection so missing-package diagnostics can be tested before installation.
using System;
using System.IO;
using System.Reflection;
using System.Text;
using StudioBaekho;
using UnityEditor;
using UnityEditor.PackageManager;
using UnityEditor.PackageManager.Requests;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.AI;
using UnityEngine.SceneManagement;

public static class BaekhoNavMeshSmoke
{
    private const string Folder = "Assets/BaekhoNavMeshValidation";
    private static int assertions;
    private static AddRequest install;
    private static double installDeadline;

    public static void InstallNavigation()
    {
        RequireIsolatedProject();
        install = Client.Add("com.unity.ai.navigation");
        installDeadline = EditorApplication.timeSinceStartup + 300;
        EditorApplication.update += PollInstall;
    }

    private static void PollInstall()
    {
        if (!install.IsCompleted && EditorApplication.timeSinceStartup < installDeadline) return;
        EditorApplication.update -= PollInstall;
        if (install.IsCompleted && install.Status == StatusCode.Success)
        {
            Debug.Log("BAEKHO_NAVMESH_PACKAGE_PASS " + install.Result.name + "@" + install.Result.version);
            EditorApplication.Exit(0);
        }
        else
        {
            Debug.LogError("AI Navigation package installation failed: " +
                (install.IsCompleted ? install.Error.message : "timeout"));
            EditorApplication.Exit(1);
        }
    }

    public static void RunMissingPackage()
    {
        Guarded(delegate
        {
            Assert(SurfaceType() == null, "missing-package test has no AI Navigation assembly");
            EnsureFolder();
            string input = WriteManifest("MissingPackage", "", false);
            int files = GeneratedFileCount();
            bool rejected = false;
            try { BaekhoMapImporter.BuildFromPath(input); }
            catch (InvalidOperationException error) { rejected = error.Message.Contains("com.unity.ai.navigation"); }
            Assert(rejected, "missing package has actionable installation guidance");
            Assert(GeneratedFileCount() == files, "missing package does not leave generated assets");
            string output = BaekhoMapImporter.BuildFromPath(input, false);
            Assert(AssetDatabase.LoadAssetAtPath<GameObject>(output) != null,
                "explicit bake-off works without AI Navigation installed");
            Debug.Log("BAEKHO_NAVMESH_MISSING_PASS " + assertions + " assertions");
        });
    }

    public static void Run()
    {
        Guarded(delegate
        {
            EnsureFolder();
            Type surfaceType = SurfaceType();
            Assert(surfaceType != null, "AI Navigation package installed");
            Scene baseline = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var sentinel = GameObject.CreatePrimitive(PrimitiveType.Cube);
            sentinel.name = "UserSceneGeometryMustNotBake";
            sentinel.transform.position = new Vector3(50, -.1f, 0);
            sentinel.transform.localScale = new Vector3(12, .2f, 12);

            var source = GameObject.CreatePrimitive(PrimitiveType.Cube);
            source.name = "RendererOnlyFloor";
            UnityEngine.Object.DestroyImmediate(source.GetComponent<Collider>());
            var sourceSurface = (Behaviour)source.AddComponent(surfaceType);
            sourceSurface.enabled = true;
            string sourcePath = AssetDatabase.GenerateUniqueAssetPath(Folder + "/RendererOnlyFloor.prefab");
            PrefabUtility.SaveAsPrefabAsset(source, sourcePath);
            UnityEngine.Object.DestroyImmediate(source);
            string input = WriteManifest("Baked Navigation", AssetDatabase.AssetPathToGUID(sourcePath), true);
            EditorSceneManager.SaveScene(baseline, Folder + "/Baseline.unity");
            int roots = baseline.rootCount;
            int previews = EditorSceneManager.previewSceneCount;
            int beforeTriangles = NavMesh.CalculateTriangulation().indices.Length;

            string output = BaekhoMapImporter.BuildFromPath(input);
            AssertSceneUnchanged(baseline, roots, previews, sentinel);
            Assert(NavMesh.CalculateTriangulation().indices.Length == beforeTriangles,
                "bake preview leaves no registered navigation data behind");
            GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(output);
            Component surface = prefab.GetComponent(surfaceType);
            Assert(surface != null && ((Behaviour)surface).enabled, "default build adds an enabled root NavMeshSurface");
            Assert(Property(surface, "collectObjects").ToString() == "Children", "surface collects only generated children");
            Assert(Property(surface, "useGeometry").ToString() == "RenderMeshes", "render-only prefab geometry is collected");
            Assert((int)Property(surface, "agentTypeID") == NavMesh.GetSettingsByIndex(0).agentTypeID,
                "default bake uses the first configured Navigation agent type");
            NavMeshData data = (NavMeshData)Property(surface, "navMeshData");
            string dataPath = AssetDatabase.GetAssetPath(data);
            Assert(data != null && dataPath.StartsWith(Folder + "/", StringComparison.Ordinal) &&
                dataPath.EndsWith(".asset", StringComparison.Ordinal) && File.Exists(dataPath), "NavMeshData is persisted beside its prefab");
            Assert(Array.IndexOf(AssetDatabase.GetDependencies(output), dataPath) >= 0,
                "saved prefab has an asset dependency on its NavMeshData");
            Transform child = prefab.transform.Find("floor_ground");
            Assert(child != null && !((Behaviour)child.GetComponent(surfaceType)).enabled,
                "nested source surface is disabled on generated instance to prevent duplicate data");
            Assert(((Behaviour)AssetDatabase.LoadAssetAtPath<GameObject>(sourcePath).GetComponent(surfaceType)).enabled,
                "original source prefab surface remains enabled");
            Assert(PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(child.gameObject) == sourcePath,
                "navigation setup preserves source prefab connection");
            CheckNativeNavigation(data);

            string originalGuid = AssetDatabase.AssetPathToGUID(output);
            string dataGuid = AssetDatabase.AssetPathToGUID(dataPath);
            string repeated = BaekhoMapImporter.BuildFromPath(input);
            Component repeatedSurface = AssetDatabase.LoadAssetAtPath<GameObject>(repeated).GetComponent(surfaceType);
            string repeatedData = AssetDatabase.GetAssetPath((NavMeshData)Property(repeatedSurface, "navMeshData"));
            Assert(repeated != output && repeatedData != dataPath &&
                AssetDatabase.AssetPathToGUID(output) == originalGuid && AssetDatabase.AssetPathToGUID(dataPath) == dataGuid,
                "repeated build creates distinct prefab and data without overwriting either asset");

            int files = GeneratedFileCount();
            bool rejected = false;
            try { BaekhoMapImporter.BuildFromPath(input, true, int.MaxValue); }
            catch (Exception error) { rejected = error is ArgumentException || error is InvalidOperationException || error is InvalidDataException; }
            Assert(rejected && GeneratedFileCount() == files, "invalid agent type leaves no partial prefab or data");
            AssertSceneUnchanged(baseline, roots, previews, sentinel);
            CheckPersistenceRollback(AssetDatabase.AssetPathToGUID(sourcePath), sourcePath);
            AssertSceneUnchanged(baseline, roots, previews, sentinel);

            int dataFiles = Directory.GetFiles(Folder, "*.asset").Length;
            string withoutBake = BaekhoMapImporter.BuildFromPath(input, false);
            Assert(AssetDatabase.LoadAssetAtPath<GameObject>(withoutBake).GetComponent(surfaceType) == null &&
                Directory.GetFiles(Folder, "*.asset").Length == dataFiles,
                "bake-off builds legacy prefab without root surface or extra data asset");
            AssertSceneUnchanged(baseline, roots, previews, sentinel);

            NavMeshBuildSettings custom = NavMesh.CreateSettings();
            try
            {
                string customOutput = BaekhoMapImporter.BuildFromPath(input, true, custom.agentTypeID);
                Component customSurface = AssetDatabase.LoadAssetAtPath<GameObject>(customOutput).GetComponent(surfaceType);
                Assert((int)Property(customSurface, "agentTypeID") == custom.agentTypeID,
                    "explicit agent type is saved on the surface");
                NavMeshDataInstance customData = NavMesh.AddNavMeshData((NavMeshData)Property(customSurface, "navMeshData"));
                try
                {
                    var filter = new NavMeshQueryFilter { agentTypeID = custom.agentTypeID, areaMask = NavMesh.AllAreas };
                    Assert(NavMesh.SamplePosition(Vector3.zero, out var customHit, .5f, filter),
                        "baked data is queryable using the explicit agent type");
                }
                finally { customData.Remove(); }
            }
            finally { NavMesh.RemoveSettings(custom.agentTypeID); }

            string emptyInput = WriteManifest("Empty Geometry", "", false);
            string emptyResult;
            files = GeneratedFileCount();
            try
            {
                string emptyOutput = BaekhoMapImporter.BuildFromPath(emptyInput);
                Component emptySurface = AssetDatabase.LoadAssetAtPath<GameObject>(emptyOutput).GetComponent(surfaceType);
                NavMeshDataInstance emptyData = NavMesh.AddNavMeshData((NavMeshData)Property(emptySurface, "navMeshData"));
                try
                {
                    int triangles = NavMesh.CalculateTriangulation().indices.Length / 3;
                    Assert(triangles == 0, "geometry-free manifest does not bake unrelated scene geometry");
                    emptyResult = "Geometry-free input saves empty data (0 triangles).";
                }
                finally { emptyData.Remove(); }
            }
            catch (InvalidOperationException)
            {
                Assert(GeneratedFileCount() == files, "rejected empty bake leaves no generated assets");
                emptyResult = "Geometry-free input rejected without partial assets.";
            }
            AssertSceneUnchanged(baseline, roots, previews, sentinel);

            File.WriteAllText(Path.GetFullPath("../unity-navmesh-prefab-path.txt"), output, new UTF8Encoding(false));
            string report = "PASS Unity " + Application.unityVersion + " — " + assertions +
                " NavMesh assertions: automatic bake, renderer geometry, saved data, native pathfinding, scene isolation, " +
                "nested surfaces, repeat builds, invalid agent cleanup, post-bake save rollback, optional bake-off and custom agent type. " + emptyResult;
            File.WriteAllText(Path.GetFullPath("../unity-navmesh-result.txt"), report, new UTF8Encoding(false));
            Debug.Log("BAEKHO_NAVMESH_PASS " + report);
        });
    }

    public static void RunReload()
    {
        Guarded(delegate
        {
            string output = File.ReadAllText(Path.GetFullPath("../unity-navmesh-prefab-path.txt"));
            Type surfaceType = SurfaceType();
            GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(output);
            Assert(prefab != null, "generated prefab survives an Editor restart");
            NavMeshData data = (NavMeshData)Property(prefab.GetComponent(surfaceType), "navMeshData");
            Assert(data != null && AssetDatabase.Contains(data), "saved NavMeshData reference survives an Editor restart");
            CheckNativeNavigation(data);
            Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab, scene);
            try
            {
                instance.SetActive(false);
                instance.transform.SetPositionAndRotation(new Vector3(20, 0, 30), Quaternion.Euler(0, 90, 0));
                instance.SetActive(true);
                Vector3 start = instance.transform.TransformPoint(new Vector3(-4, 0, 0));
                Vector3 end = instance.transform.TransformPoint(new Vector3(4, 0, 0));
                Assert(NavMesh.SamplePosition(start, out var a, .5f, NavMesh.AllAreas) &&
                    NavMesh.SamplePosition(end, out var b, .5f, NavMesh.AllAreas),
                    "placed prefab automatically registers data at translated and rotated transform");
                var path = new NavMeshPath();
                Assert(NavMesh.CalculatePath(start, end, NavMesh.AllAreas, path) && path.status == NavMeshPathStatus.PathComplete,
                    "placed prefab supports complete native pathfinding after restart");
                Assert(!NavMesh.SamplePosition(Vector3.zero, out var unused, .5f, NavMesh.AllAreas),
                    "placed prefab does not retain an extra NavMesh at its old origin");
            }
            finally { UnityEngine.Object.DestroyImmediate(instance); }
            Assert(NavMesh.CalculateTriangulation().indices.Length == 0, "destroying placed prefab unregisters its data");
            string report = "PASS cold Editor reload — " + assertions + " saved-data and transformed prefab assertions.";
            File.AppendAllText(Path.GetFullPath("../unity-navmesh-result.txt"), Environment.NewLine + report, new UTF8Encoding(false));
            Debug.Log("BAEKHO_NAVMESH_RELOAD_PASS " + report);
        });
    }

    private static void CheckNativeNavigation(NavMeshData data)
    {
        NavMeshDataInstance instance = NavMesh.AddNavMeshData(data);
        try
        {
            Assert(instance.valid && NavMesh.CalculateTriangulation().indices.Length > 0, "saved asset contains real walkable triangles");
            Assert(NavMesh.SamplePosition(new Vector3(-4, 0, 0), out var start, .5f, NavMesh.AllAreas) &&
                NavMesh.SamplePosition(new Vector3(4, 0, 0), out var end, .5f, NavMesh.AllAreas),
                "render-only floor is walkable on both sides");
            var path = new NavMeshPath();
            Assert(NavMesh.CalculatePath(new Vector3(-4, 0, 0), new Vector3(4, 0, 0), NavMesh.AllAreas, path) &&
                path.status == NavMeshPathStatus.PathComplete, "saved asset supports a complete path");
            Assert(!NavMesh.SamplePosition(new Vector3(50, 0, 0), out var outside, 1, NavMesh.AllAreas),
                "user scene geometry was not included in generated map bake");
        }
        finally { instance.Remove(); }
    }

    private static void CheckPersistenceRollback(string guid, string sourcePath)
    {
        string name = "Rollback Sentinel " + Guid.NewGuid().ToString("N");
        string input = WriteManifest(name, guid, true);
        string output = Folder + "/" + name + ".prefab";
        string dataPath = Folder + "/" + name + ".NavMesh.asset";
        BaekhoNavMeshPersistenceFailure.TargetDataPath = dataPath;
        BaekhoNavMeshPersistenceFailure.TargetPrefabPath = output;
        BaekhoNavMeshPersistenceFailure.SourcePrefabPath = sourcePath;
        bool rejected = false;
        try
        {
            try { BaekhoMapImporter.BuildFromPath(input); }
            catch (IOException) { rejected = true; }
            Assert(BaekhoNavMeshPersistenceFailure.Triggered && rejected,
                "save-race fixture rejects prefab persistence after navigation asset creation");
            Assert(!File.Exists(dataPath) && !File.Exists(dataPath + ".meta") &&
                AssetDatabase.LoadAssetAtPath<NavMeshData>(dataPath) == null,
                "post-bake prefab save failure rolls back the generated navigation asset");
            Assert(File.Exists(output) && File.ReadAllText(output) == File.ReadAllText(sourcePath),
                "post-bake save failure preserves an independently created prefab at the output path");
            Assert(NavMesh.CalculateTriangulation().indices.Length == 0,
                "post-bake save failure unregisters preview navigation data");
        }
        finally
        {
            BaekhoNavMeshPersistenceFailure.TargetDataPath = null;
            BaekhoNavMeshPersistenceFailure.TargetPrefabPath = null;
            BaekhoNavMeshPersistenceFailure.SourcePrefabPath = null;
            BaekhoNavMeshPersistenceFailure.Triggered = false;
        }
    }

    private static void AssertSceneUnchanged(Scene baseline, int roots, int previews, GameObject sentinel)
    {
        Assert(SceneManager.GetActiveScene() == baseline && !baseline.isDirty && baseline.rootCount == roots &&
            EditorSceneManager.previewSceneCount == previews && sentinel.transform.position == new Vector3(50, -.1f, 0),
            "active scene, dirty state, roots, sentinel transform and preview count remain unchanged");
    }

    private static string WriteManifest(string name, string guid, bool geometry)
    {
        string path = Folder + "/sample.baekhomap.json";
        string placement = "{\"id\":\"ground\",\"role\":\"" + (geometry ? "floor" : "spawn") + "\",\"prefabGuid\":\"" + guid +
            "\",\"position\":{\"x\":0,\"y\":-0.1,\"z\":0},\"rotation\":{\"x\":0,\"y\":0,\"z\":0}," +
            "\"scale\":{\"x\":12,\"y\":0.2,\"z\":12}}";
        File.WriteAllText(path, "{\"schemaVersion\":1,\"name\":\"" + name + "\",\"width\":6,\"height\":6,\"cellSize\":2," +
            "\"placements\":[" + placement + "]}", new UTF8Encoding(false));
        return path;
    }

    private static Type SurfaceType()
    {
        foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
        {
            Type type = assembly.GetType("Unity.AI.Navigation.NavMeshSurface");
            if (type != null) return type;
        }
        return null;
    }

    private static object Property(Component component, string name) { return component.GetType().GetProperty(name).GetValue(component); }
    private static int GeneratedFileCount() { return Directory.GetFiles(Folder, "*.prefab").Length + Directory.GetFiles(Folder, "*.asset").Length; }
    private static void EnsureFolder() { if (!AssetDatabase.IsValidFolder(Folder)) AssetDatabase.CreateFolder("Assets", "BaekhoNavMeshValidation"); }
    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException("ASSERT FAILED: " + message);
        assertions++;
    }
    private static void RequireIsolatedProject()
    {
        if (!Application.dataPath.Replace('\\', '/').EndsWith("/.local/unity-validation/Assets", StringComparison.Ordinal))
            throw new InvalidOperationException("Navigation tests may only run in .local/unity-validation.");
    }
    private static void Guarded(Action test)
    {
        try { RequireIsolatedProject(); test(); }
        catch (Exception error) { Debug.LogException(error); EditorApplication.Exit(1); }
    }
}

// Simulates another process winning the prefab path between data persistence and prefab saving.
public sealed class BaekhoNavMeshPersistenceFailure : AssetModificationProcessor
{
    public static string TargetDataPath;
    public static string TargetPrefabPath;
    public static string SourcePrefabPath;
    public static bool Triggered;

    private static void OnWillCreateAsset(string assetPath)
    {
        if (TargetDataPath == null || Triggered) return;
        string normalized = assetPath.Replace('\\', '/');
        if (normalized != TargetDataPath && normalized != TargetDataPath + ".meta") return;
        File.Copy(SourcePrefabPath, TargetPrefabPath, false);
        Triggered = true;
    }
}
