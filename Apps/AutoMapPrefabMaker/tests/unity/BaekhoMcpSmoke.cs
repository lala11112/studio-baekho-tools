// Optional Unity MCP integration suite; run only in .local/unity-validation.
using System;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using MCPForUnity.Editor.Helpers;
using Newtonsoft.Json.Linq;
using StudioBaekho;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.AI;
using UnityEngine.SceneManagement;

public static class BaekhoMcpSmoke
{
    private const string Folder = "Assets/Baekho/Generated/McpValidation";
    private const string Input = Folder + "/Map.baekhomap.json";
    private static int assertions;
    private static string Root { get { return Path.GetFullPath(Path.Combine(Application.dataPath, "..")); } }
    private static string Result { get { return Path.Combine(Root, "..", "unity-mcp-result.json"); } }

    public static void Run()
    {
        Guarded(delegate
        {
            Directory.CreateDirectory(Folder);
            AssetDatabase.Refresh();
            Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var sentinel = new GameObject("UserSceneMustRemainUntouched");
            sentinel.transform.position = new Vector3(24, 4, -2);
            EditorSceneManager.SaveScene(scene, Folder + "/UserScene.unity");
            Scene dirtyScene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Additive);
            var dirtySentinel = new GameObject("UnsavedUserChange");
            SceneManager.MoveGameObjectToScene(dirtySentinel, dirtyScene);
            EditorSceneManager.MarkSceneDirty(dirtyScene);
            SceneManager.SetActiveScene(scene);

            var floor = GameObject.CreatePrimitive(PrimitiveType.Cube);
            SceneManager.MoveGameObjectToScene(floor, dirtyScene);
            string floorPath = Folder + "/Floor.prefab";
            PrefabUtility.SaveAsPrefabAsset(floor, floorPath);
            UnityEngine.Object.DestroyImmediate(floor);
            string guid = AssetDatabase.AssetPathToGUID(floorPath);
            WriteManifest("McpValidation", guid);
            AssetDatabase.Refresh();
            string requestId = Guid.NewGuid().ToString("D");
            string hash = Hash(Input);
            int previews = EditorSceneManager.previewSceneCount;
            int roots = scene.rootCount;
            int dirtyRoots = dirtyScene.rootCount;
            int files = OutputCount();
            JObject inFlight = null;
            JObject excluded = null;
            BaekhoMcpAdmissionProbe.Probe = delegate
            {
                inFlight = Call("status", requestId, hash);
                excluded = Call("build", Guid.NewGuid().ToString("D"), hash);
            };
            JObject completed;
            try { completed = Call("build", requestId, hash); }
            finally { BaekhoMcpAdmissionProbe.Probe = null; }
            Assert((string)completed["state"] == "completed", "build completes: " + completed);
            Assert(inFlight != null && (string)inFlight["state"] == "running", "running admission is persisted before asset writes");
            Assert(excluded != null && (string)excluded["state"] == "failed" &&
                ((string)excluded["message"]).Contains("already running"), "another build cannot interleave in this project");
            string prefabPath = (string)completed["prefabPath"];
            string navMeshPath = (string)completed["navMeshPath"];
            Assert(File.Exists(prefabPath) && File.Exists(navMeshPath), "prefab and NavMesh are saved");
            Assert(OutputCount() == files + 2, "one prefab and one NavMesh are generated");
            Assert(AssetDatabase.GetAssetPath(Selection.activeObject) == prefabPath, "Project selects output prefab");
            GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
            Assert(prefab != null && prefab.transform.Find("vegetation_tree").GetComponent<BaekhoMapFixture>().role == "vegetation",
                "vegetation placement and metadata survive MCP import");
            Assert(AssetDatabase.LoadAssetAtPath<NavMeshData>(navMeshPath) != null &&
                Array.IndexOf(AssetDatabase.GetDependencies(prefabPath), navMeshPath) >= 0, "prefab references persistent NavMesh");
            Assert(SceneManager.sceneCount == 2 && SceneManager.GetActiveScene() == scene && !scene.isDirty &&
                dirtyScene.isDirty && scene.rootCount == roots && dirtyScene.rootCount == dirtyRoots &&
                sentinel.transform.position == new Vector3(24, 4, -2) &&
                EditorSceneManager.previewSceneCount == previews, "clean and dirty user scenes remain unchanged");
            Assert(NavMesh.CalculateTriangulation().indices.Length == 0, "preview bake leaves no scene NavMesh behind");

            JObject duplicate = Call("build", requestId, hash);
            Assert((string)duplicate["prefabPath"] == prefabPath && OutputCount() == files + 2,
                "repeated request returns original output without rebuilding");
            JObject status = Call("status", requestId, hash);
            Assert(JToken.DeepEquals(status, completed), "status round-trips saved result");
            Assert((string)Call("build", requestId, new string('0', 64))["state"] == "failed" && OutputCount() == files + 2,
                "request ID with another hash is rejected");
            var wrongPath = Request("build", requestId, hash);
            wrongPath["manifestPath"] = "Assets/Baekho/Generated/Other/Map.baekhomap.json";
            Assert(State(wrongPath) == "failed", "request ID with another path is rejected");
            wrongPath["action"] = "status";
            Assert(State(wrongPath) == "unknown", "status identity path mismatch cannot resolve an uncertain build as failed");
            Assert((string)Call("status", requestId, new string('0', 64))["state"] == "unknown",
                "status identity hash mismatch remains unknown");
            Assert((string)Call("status", requestId, hash)["state"] == "completed", "identity mismatch preserves original receipt");

            string nextId = Guid.NewGuid().ToString("D");
            JObject next = Call("build", nextId, hash);
            Assert((string)next["state"] == "completed" && (string)next["prefabPath"] != prefabPath &&
                (string)next["navMeshPath"] != navMeshPath && File.Exists(prefabPath) && File.Exists(navMeshPath),
                "new explicit request saves a numbered version and preserves previous outputs");
            files = OutputCount();

            var wrongProject = Request("build", Guid.NewGuid().ToString("D"), hash);
            wrongProject["expectedProjectRoot"] = Path.Combine(Root, "OtherProject");
            Assert(State(wrongProject) == "failed" && OutputCount() == files, "wrong project is rejected without asset writes");
            string unknownId = Guid.NewGuid().ToString("D");
            Assert((string)Call("status", unknownId, hash)["state"] == "unknown" && !File.Exists(ReceiptPath(unknownId)),
                "status of an unknown request never creates a build or receipt");
            string corruptId = Guid.NewGuid().ToString("D");
            File.WriteAllText(ReceiptPath(corruptId), "{corrupt receipt", new UTF8Encoding(false));
            Assert((string)Call("status", corruptId, hash)["state"] == "unknown" && OutputCount() == files,
                "unreadable receipt status remains unknown and creates no output");
            Assert(File.ReadAllText(ReceiptPath(corruptId)) == "{corrupt receipt", "status preserves unreadable receipt for diagnosis");
            Assert((string)Call("build", Guid.NewGuid().ToString("D"), new string('0', 64))["state"] == "failed" && OutputCount() == files,
                "manifest hash mismatch cannot create output");
            foreach (string unsafePath in new[] { "../Map.baekhomap.json", "Assets/Baekho/Generated/../Map.baekhomap.json",
                "Assets/Baekho/Generated/McpValidation/../McpValidation/Map.baekhomap.json" })
            {
                var unsafeRequest = Request("build", Guid.NewGuid().ToString("D"), hash);
                unsafeRequest["manifestPath"] = unsafePath;
                Assert(State(unsafeRequest) == "failed", "manifest traversal is rejected: " + unsafePath);
            }

            string staleId = Guid.NewGuid().ToString("D");
            File.WriteAllText(ReceiptPath(staleId), new JObject
            {
                ["schemaVersion"] = 1, ["requestId"] = staleId, ["projectRoot"] = Root,
                ["manifestPath"] = Input, ["inputHash"] = hash, ["sessionId"] = "old-session",
                ["state"] = "running", ["message"] = "Interrupted"
            }.ToString(), new UTF8Encoding(false));
            Assert((string)Call("status", staleId, hash)["state"] == "unknown" &&
                (string)Call("build", staleId, hash)["state"] == "unknown" && OutputCount() == files,
                "interrupted receipt becomes unknown and cannot execute again");

            WriteManifest("BadGuid", new string('f', 32));
            string failureId = Guid.NewGuid().ToString("D");
            string failedHash = Hash(Input);
            Assert((string)Call("build", failureId, failedHash)["state"] == "failed" && OutputCount() == files,
                "invalid GUID fails with no partial prefab or NavMesh");
            Assert((string)Call("build", failureId, failedHash)["state"] == "failed" && OutputCount() == files,
                "failed admitted request cannot be restarted");

            WriteManifest("McpSaveFailure", guid);
            string failedOutput = AssetDatabase.GenerateUniqueAssetPath(Folder + "/McpSaveFailure.prefab");
            string failedNavMesh = AssetDatabase.GenerateUniqueAssetPath(Path.ChangeExtension(failedOutput, ".NavMesh.asset"));
            BaekhoMcpPersistenceFailure.Source = floorPath;
            BaekhoMcpPersistenceFailure.TargetPrefab = failedOutput;
            BaekhoMcpPersistenceFailure.TargetNavMesh = failedNavMesh;
            try
            {
                JObject failure = Call("build", Guid.NewGuid().ToString("D"), Hash(Input));
                Assert((string)failure["state"] == "failed" && BaekhoMcpPersistenceFailure.Triggered,
                    "post-bake save-race fixture is admitted and fails");
                Assert(!File.Exists(failedNavMesh) && !File.Exists(failedNavMesh + ".meta") &&
                    AssetDatabase.LoadAssetAtPath<NavMeshData>(failedNavMesh) == null,
                    "post-bake failure removes the partial generated navigation asset");
                Assert(File.Exists(failedOutput) && File.ReadAllText(failedOutput) == File.ReadAllText(floorPath),
                    "post-bake failure preserves the independently created prefab");
            }
            finally
            {
                BaekhoMcpPersistenceFailure.Source = null;
                BaekhoMcpPersistenceFailure.TargetPrefab = null;
                BaekhoMcpPersistenceFailure.TargetNavMesh = null;
            }

            WriteManifest("FreshDirectory", guid);
            string freshFolder = Folder + "/Fresh-" + Guid.NewGuid().ToString("N");
            Directory.CreateDirectory(freshFolder);
            string freshInput = freshFolder + "/Map.baekhomap.json";
            File.Copy(Input, freshInput);
            Assert(!AssetDatabase.IsValidFolder(freshFolder), "external delivery creates a directory unknown to AssetDatabase");
            var externalDelivery = Request("build", Guid.NewGuid().ToString("D"), Hash(freshInput));
            externalDelivery["manifestPath"] = freshInput;
            JObject delivered = Data(externalDelivery);
            Assert((string)delivered["state"] == "completed" &&
                AssetDatabase.LoadAssetAtPath<GameObject>((string)delivered["prefabPath"]) != null,
                "new external manifest directories import synchronously before building: " + delivered);

            File.WriteAllText(Result, new JObject { ["completed"] = completed, ["requestId"] = requestId,
                ["inputHash"] = hash, ["assertions"] = assertions }.ToString(), new UTF8Encoding(false));
            Debug.Log("BAEKHO_MCP_PASS " + assertions + " assertions");
        });
    }

    public static void RunReload()
    {
        Guarded(delegate
        {
            JObject result = JObject.Parse(File.ReadAllText(Result));
            JObject prior = (JObject)result["completed"];
            JObject status = Call("status", (string)result["requestId"], (string)result["inputHash"]);
            Assert(JToken.DeepEquals(status, prior), "completed receipt survives editor restart");
            string prefabPath = (string)status["prefabPath"];
            string navMeshPath = (string)status["navMeshPath"];
            GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
            NavMeshData navigation = AssetDatabase.LoadAssetAtPath<NavMeshData>(navMeshPath);
            Assert(prefab != null && navigation != null && navigation.sourceBounds.size.x > 2,
                "prefab and baked geometry reload from disk");
            Assert(Array.IndexOf(AssetDatabase.GetDependencies(prefabPath), navMeshPath) >= 0,
                "cold prefab reload keeps its NavMesh reference");
            int files = OutputCount();
            Assert((string)Call("build", (string)result["requestId"], (string)result["inputHash"])["prefabPath"] == prefabPath &&
                OutputCount() == files, "cold duplicate returns original output without rebuilding");
            Debug.Log("BAEKHO_MCP_RELOAD_PASS " + assertions + " assertions");
        });
    }

    private static JObject Request(string action, string id, string hash)
    {
        return new JObject { ["action"] = action, ["requestId"] = id, ["expectedProjectRoot"] = Root,
            ["manifestPath"] = Input, ["inputHash"] = hash };
    }
    private static JObject Call(string action, string id, string hash) { return Data(Request(action, id, hash)); }
    private static string State(JObject request) { return (string)Data(request)["state"]; }
    private static JObject Data(JObject request)
    {
        var response = BaekhoBuildMapTool.HandleCommand(request) as SuccessResponse;
        Assert(response != null, "tool uses standard Unity MCP SuccessResponse");
        return JObject.FromObject(response.Data);
    }
    private static string ReceiptPath(string id) { return Path.Combine(Root, "Library", "BaekhoMapForge", "requests", id + ".json"); }
    private static int OutputCount() { return Directory.GetFiles(Folder, "*.prefab").Length + Directory.GetFiles(Folder, "*.asset").Length; }
    private static string Hash(string path)
    {
        using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(File.ReadAllBytes(path))).Replace("-", "").ToLowerInvariant();
    }
    private static void WriteManifest(string name, string guid)
    {
        var origin = new JObject { ["x"] = 0, ["y"] = 0, ["z"] = 0 };
        var rotation = origin.DeepClone();
        File.WriteAllText(Input, new JObject
        {
            ["schemaVersion"] = 4, ["name"] = name, ["width"] = 6, ["height"] = 6, ["cellSize"] = 2,
            ["placements"] = new JArray
            {
                new JObject { ["id"] = "ground", ["role"] = "floor", ["prefabGuid"] = guid, ["position"] = origin,
                    ["rotation"] = rotation, ["scale"] = new JObject { ["x"] = 12, ["y"] = .2, ["z"] = 12 } },
                new JObject { ["id"] = "tree", ["role"] = "vegetation", ["prefabGuid"] = guid,
                    ["position"] = new JObject { ["x"] = 3, ["y"] = 0, ["z"] = 3 }, ["rotation"] = rotation.DeepClone(),
                    ["scale"] = new JObject { ["x"] = 1, ["y"] = 1, ["z"] = 1 }, ["surface"] = "pivot" }
            },
            ["connections"] = new JArray { new JObject { ["id"] = "entry", ["label"] = "Entry", ["kind"] = "door",
                ["width"] = 2, ["height"] = 3, ["position"] = new JObject { ["x"] = 0, ["y"] = 0, ["z"] = 6 },
                ["rotation"] = new JObject { ["x"] = 0, ["y"] = 0, ["z"] = 0 } } },
            ["markers"] = new JArray()
        }.ToString(), new UTF8Encoding(false));
    }
    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException("ASSERT FAILED: " + message);
        assertions++;
    }
    private static void Guarded(Action action)
    {
        try
        {
            if (!Application.dataPath.Replace('\\', '/').EndsWith("/.local/unity-validation/Assets", StringComparison.Ordinal))
                throw new InvalidOperationException("MCP smoke checks may only run in .local/unity-validation.");
            BaekhoMcpBatchIsolation.DetachServerShutdown();
            action();
        }
        catch (Exception exception) { Debug.LogException(exception); EditorApplication.Exit(1); }
    }
}

// Persists in this isolated project's Editor folder, so legacy regression
// entrypoints run safely after MCP smoke has installed the optional package.
[InitializeOnLoad]
public static class BaekhoMcpBatchIsolation
{
    static BaekhoMcpBatchIsolation()
    {
        if (Application.isBatchMode) DetachServerShutdown();
    }

    public static void DetachServerShutdown()
    {
        if (!Application.isBatchMode ||
            !Application.dataPath.Replace('\\', '/').EndsWith("/.local/unity-validation/Assets", StringComparison.Ordinal)) return;
        // The package quit hook attempts to stop a shared local HTTP server even
        // in batch mode. This validation project owns no transport or server.
        // Initialize the upstream class first so InitializeOnLoad ordering cannot
        // reattach its hook after this helper removes it. EditorPrefs stay intact.
        foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
        {
            Type cleanup = assembly.GetType("MCPForUnity.Editor.Services.McpEditorShutdownCleanup");
            if (cleanup == null) continue;
            RuntimeHelpers.RunClassConstructor(cleanup.TypeHandle);
            MethodInfo method = cleanup.GetMethod("OnEditorQuitting", BindingFlags.NonPublic | BindingFlags.Static);
            EventInfo quitting = typeof(EditorApplication).GetEvent("quitting", BindingFlags.Public | BindingFlags.Static);
            if (method != null && quitting != null)
                quitting.RemoveEventHandler(null, Delegate.CreateDelegate(quitting.EventHandlerType, method));
        }
    }
}

public sealed class BaekhoMcpAdmissionProbe : AssetModificationProcessor
{
    public static Action Probe;
    private static void OnWillCreateAsset(string assetPath)
    {
        Action probe = Probe;
        if (probe == null || !assetPath.StartsWith("Assets/Baekho/Generated/McpValidation/", StringComparison.Ordinal)) return;
        Probe = null;
        probe();
    }
}

public sealed class BaekhoMcpPersistenceFailure : AssetModificationProcessor
{
    public static string Source;
    public static string TargetPrefab;
    public static string TargetNavMesh;
    public static bool Triggered;
    private static void OnWillCreateAsset(string assetPath)
    {
        if (Source == null || Triggered) return;
        string path = assetPath.Replace('\\', '/');
        if (path != TargetNavMesh && path != TargetNavMesh + ".meta") return;
        File.Copy(Source, TargetPrefab, false);
        Triggered = true;
    }
}
