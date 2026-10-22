// Isolated real-Editor checks. Copy to .local/unity-validation/Assets/Editor and run BaekhoAssetCatalogSmoke.Run.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using MCPForUnity.Editor.Helpers;
using Newtonsoft.Json.Linq;
using StudioBaekho;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

public static class BaekhoAssetCatalogSmoke
{
    private const string Folder = "Assets/BaekhoAssetCatalogValidation";
    private static int assertions;
    private static readonly string Root = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));

    public static void Run()
    {
        try
        {
            if (!Application.dataPath.Replace('\\', '/').EndsWith("/.local/unity-validation/Assets", StringComparison.Ordinal))
                throw new InvalidOperationException("Asset catalog smoke checks may only run in .local/unity-validation.");
            if (AssetDatabase.IsValidFolder(Folder)) AssetDatabase.DeleteAsset(Folder);
            AssetDatabase.CreateFolder("Assets", "BaekhoAssetCatalogValidation");
            var roleGuids = new Dictionary<string, string>();
            var paths = new List<string>();
            Scene setup = EditorSceneManager.NewPreviewScene();
            try
            {
                foreach (BaekhoMapAsset.AssetRole role in Enum.GetValues(typeof(BaekhoMapAsset.AssetRole)))
                {
                    if (role == BaekhoMapAsset.AssetRole.Unspecified) continue;
                    GameObject source = Box(setup, role.ToString());
                    BaekhoMapAsset tag = source.AddComponent<BaekhoMapAsset>();
                    tag.role = role;
                    if (role == BaekhoMapAsset.AssetRole.Prop)
                    {
                        tag.label = "소품 \"이름\" \\ 테스트";
                        tag.useInitialScale = true; tag.initialScale = new Vector3(2, 3, 4);
                        tag.useInitialOffset = true; tag.initialOffset = new Vector3(.5f, -.2f, .8f);
                        tag.useInitialRotation = true; tag.initialRotationY = 90;
                    }
                    if (role == BaekhoMapAsset.AssetRole.Stair) tag.stairNativeRise = 2.5f;
                    if (role == BaekhoMapAsset.AssetRole.Light) tag.lightAnchor = BaekhoMapAsset.LightAnchor.Wall;
                    string path = Save(source, role.ToString());
                    paths.Add(path);
                    roleGuids.Add(LowerFirst(role.ToString()), AssetDatabase.AssetPathToGUID(path));
                }
                paths.Add(Save(Box(setup, "Unmarked"), "Unmarked"));
                paths.Add(Save(Box(setup, "NeverMarked"), "NeverMarked"));
                GameObject childOnly = Box(setup, "ChildOnly");
                var child = new GameObject("Nested tag"); child.transform.SetParent(childOnly.transform, false);
                child.AddComponent<BaekhoMapAsset>().role = BaekhoMapAsset.AssetRole.Wall;
                paths.Add(Save(childOnly, "ChildOnly"));
                AddCase(setup, paths, "Disabled", tag => { tag.role = BaekhoMapAsset.AssetRole.Wall; tag.importEnabled = false; });
                AddCase(setup, paths, "Unspecified", tag => { });
                AddCase(setup, paths, "InvalidScale", tag => { tag.role = BaekhoMapAsset.AssetRole.Wall; tag.useInitialScale = true; tag.initialScale = new Vector3(1, -1, 1); });
                AddCase(setup, paths, "InvalidRole", tag => { tag.role = (BaekhoMapAsset.AssetRole)999; });
                AddCase(setup, paths, "InvalidRise", tag => { tag.role = BaekhoMapAsset.AssetRole.Stair; tag.stairNativeRise = 0; });
                AddCase(setup, paths, "InvalidLabel", tag => { tag.role = BaekhoMapAsset.AssetRole.Prop; tag.label = new string('x', 81); });
                var empty = new GameObject("Unmeasurable"); SceneManager.MoveGameObjectToScene(empty, setup);
                empty.AddComponent<BaekhoMapAsset>().role = BaekhoMapAsset.AssetRole.Light;
                paths.Add(Save(empty, "Unmeasurable"));

                GameObject wallLight = new GameObject("WallLight"); SceneManager.MoveGameObjectToScene(wallLight, setup);
                wallLight.AddComponent<BaekhoMapAsset>().role = BaekhoMapAsset.AssetRole.Light;
                BaekhoWallModule wall = wallLight.AddComponent<BaekhoWallModule>();
                var mount = new GameObject("Mount"); mount.transform.SetParent(wallLight.transform, false);
                wall.mounts = new[] { mount.transform };
                wall.collisionBoxes = new[] { new Bounds(new Vector3(0, .5f, .1f), new Vector3(.2f, 1, .2f)) };
                paths.Add(Save(wallLight, "WallLight"));

                GameObject basePrefab = AssetDatabase.LoadAssetAtPath<GameObject>(AssetDatabase.GUIDToAssetPath(roleGuids["prop"]));
                GameObject inherited = PrefabUtility.InstantiatePrefab(basePrefab, setup) as GameObject;
                paths.Add(Save(inherited, "InheritedVariant"));
                GameObject overridden = PrefabUtility.InstantiatePrefab(basePrefab, setup) as GameObject;
                var overriddenTag = overridden.GetComponent<BaekhoMapAsset>();
                overriddenTag.role = BaekhoMapAsset.AssetRole.Decoration; overriddenTag.label = "Variant override";
                PrefabUtility.RecordPrefabInstancePropertyModifications(overriddenTag);
                paths.Add(Save(overridden, "OverrideVariant"));

                // The menu refuses folders before processing even a valid prefab in the same selection.
                UnityEngine.Object folder = AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(Folder);
                GameObject unmarked = AssetDatabase.LoadAssetAtPath<GameObject>(Folder + "/Unmarked.prefab");
                int previews = EditorSceneManager.previewSceneCount;
                bool rejected = false;
                try { BaekhoMapAssetEditor.AddToSelectedPrefabs(new UnityEngine.Object[] { unmarked, folder }); }
                catch (InvalidOperationException) { rejected = true; }
                Assert(rejected && unmarked.GetComponent<BaekhoMapAsset>() == null && EditorSceneManager.previewSceneCount == previews,
                    "folder selection rejected before modifying explicitly selected prefabs");
                Assert(BaekhoMapAssetEditor.AddToSelectedPrefabs(new UnityEngine.Object[] { unmarked }) == 1,
                    "menu adds registration to selected prefab root");
                unmarked = AssetDatabase.LoadAssetAtPath<GameObject>(Folder + "/Unmarked.prefab");
                Assert(unmarked.GetComponent<BaekhoMapAsset>().role == BaekhoMapAsset.AssetRole.Unspecified,
                    "new metadata defaults to unspecified");
                Assert(BaekhoMapAssetEditor.AddToSelectedPrefabs(new UnityEngine.Object[] { unmarked }) == 0,
                    "menu preserves existing registration");
            }
            finally { EditorSceneManager.ClosePreviewScene(setup); }

            string movedGuid = roleGuids["floor"];
            string oldPath = AssetDatabase.GUIDToAssetPath(movedGuid);
            Assert(string.IsNullOrEmpty(AssetDatabase.MoveAsset(oldPath, Folder + "/MovedFloor.prefab")), "floor prefab moved for stable GUID test");
            paths[paths.IndexOf(oldPath)] = Folder + "/MovedFloor.prefab";
            var sourceHashes = paths.ToDictionary(path => path, Hash);
            UnityEditor.Editor inspector = UnityEditor.Editor.CreateEditor(new UnityEngine.Object[]
            {
                AssetDatabase.LoadAssetAtPath<GameObject>(AssetDatabase.GUIDToAssetPath(roleGuids["floor"])).GetComponent<BaekhoMapAsset>(),
                AssetDatabase.LoadAssetAtPath<GameObject>(AssetDatabase.GUIDToAssetPath(roleGuids["wall"])).GetComponent<BaekhoMapAsset>()
            }, typeof(BaekhoMapAssetEditor));
            try
            {
                Assert(inspector.targets.Length == 2 && inspector.serializedObject.FindProperty("role").hasMultipleDifferentValues &&
                    inspector.CreateInspectorGUI().childCount > 0, "UI Toolkit inspector supports multiple prefab targets and mixed role values");
            }
            finally { UnityEngine.Object.DestroyImmediate(inspector); }
            string[] assetPaths = AssetDatabase.GetAllAssetPaths();
            Scene active = SceneManager.GetActiveScene();
            bool dirty = active.isDirty;
            string hierarchy = Hierarchy(active);
            int sceneCount = SceneManager.sceneCount;
            int previewCount = EditorSceneManager.previewSceneCount;

            JObject first = ReadTool(Root);
            JObject second = ReadTool(Root);
            Assert(JToken.DeepEquals(first, second), "repeat catalog reads are deterministic");
            Assert((string)first["format"] == "baekho-asset-catalog" && (int)first["version"] == 1, "separate versioned catalog format");
            var entries = ((JArray)first["assets"]).Children<JObject>().Where(item => ((string)item["path"]).StartsWith(Folder + "/", StringComparison.Ordinal)).ToArray();
            var skipped = ((JArray)first["skipped"]).Children<JObject>().Where(item => ((string)item["path"]).StartsWith(Folder + "/", StringComparison.Ordinal)).ToArray();
            Assert(entries.Length == roleGuids.Count + 3, "every supported role, two variants and light-only wall module are imported");
            foreach (var pair in roleGuids) Assert(entries.Any(item => (string)item["guid"] == pair.Value && (string)item["role"] == pair.Key), "exports role " + pair.Key);
            string[] sorted = ((JArray)first["assets"]).Select(item => (string)item["guid"]).ToArray();
            Assert(sorted.SequenceEqual(sorted.OrderBy(value => value, StringComparer.Ordinal)), "catalog ordered by GUID");
            Assert(!entries.Any(item => ((string)item["path"]).EndsWith("/ChildOnly.prefab", StringComparison.Ordinal)), "child-only marker ignored");
            Assert(!entries.Any(item => ((string)item["path"]).EndsWith("/NeverMarked.prefab", StringComparison.Ordinal)) &&
                !skipped.Any(item => ((string)item["path"]).EndsWith("/NeverMarked.prefab", StringComparison.Ordinal)), "unmarked prefab ignored without noisy diagnostics");
            foreach (string name in new[] { "Disabled", "Unspecified", "Unmarked", "InvalidScale", "InvalidRole", "InvalidRise", "InvalidLabel", "Unmeasurable" })
                Assert(skipped.Any(item => (string)item["path"] == Folder + "/" + name + ".prefab" && !string.IsNullOrEmpty((string)item["reason"])), name + " excluded with reason");

            JObject prop = entries.First(item => (string)item["guid"] == roleGuids["prop"]);
            Assert((string)prop["label"] == "소품 \"이름\" \\ 테스트" && (float)prop["rotationY"] == 90, "optional label escapes and rotation exported");
            Near(prop["size"], new Vector3(1, 2, 3), "source root scale is normalized for measurement");
            Near(prop["bounds"]["center"], new Vector3(2, 1, -3), "pivot offset remains root-local");
            Near(prop["scale"], new Vector3(2, 3, 4), "optional initial scale exported independently of source transform");
            Near(prop["offset"], new Vector3(.5f, -.2f, .8f), "optional initial offset exported");
            JObject floor = entries.First(item => (string)item["guid"] == movedGuid);
            Assert((string)floor["path"] == Folder + "/MovedFloor.prefab" && floor["scale"] == null && floor["offset"] == null && floor["rotationY"] == null,
                "moved GUID uses current path and absent optional settings remain absent");
            Assert((float)entries.First(item => (string)item["role"] == "stair")["stairNativeRise"] == 2.5f &&
                (float)entries.First(item => (string)item["role"] == "slope")["stairNativeRise"] == 1, "native rise override and default exported");
            Assert((string)entries.First(item => (string)item["guid"] == roleGuids["light"])["lightAnchor"] == "wall", "light install surface exported");
            JObject inheritedEntry = entries.First(item => (string)item["path"] == Folder + "/InheritedVariant.prefab");
            JObject overrideEntry = entries.First(item => (string)item["path"] == Folder + "/OverrideVariant.prefab");
            Assert((string)inheritedEntry["role"] == "prop" && (string)inheritedEntry["label"] == (string)prop["label"], "variant effective inherited metadata read");
            Assert((string)overrideEntry["role"] == "decoration" && (string)overrideEntry["label"] == "Variant override", "variant metadata overrides read");
            JObject wallLightEntry = entries.First(item => (string)item["path"] == Folder + "/WallLight.prefab");
            Assert(wallLightEntry["wallMount"] != null && ((JArray)wallLightEntry["wallMount"]["mounts"]).Count == 1, "existing wall connector metadata reused");
            Near(wallLightEntry["size"], new Vector3(.2f, 1, .2f), "light-only occupancy boxes supply bounds");

            object wrongRoot = BaekhoGetAssetCatalogTool.HandleCommand(new JObject { ["expectedProjectRoot"] = Path.Combine(Root, "AnotherProject") });
            Assert(wrongRoot is ErrorResponse, "wrong project rejects catalog read");
            Assert(BaekhoGetAssetCatalogTool.HandleCommand(new JObject()) is ErrorResponse, "missing project identity rejected");
            Assert(BaekhoGetAssetCatalogTool.HandleCommand(new JObject { ["expectedProjectRoot"] = 42 }) is ErrorResponse, "invalid project identity rejected");
            foreach (var pair in sourceHashes) Assert(Hash(pair.Key) == pair.Value, "source prefab bytes unchanged: " + pair.Key);
            Assert(AssetDatabase.GetAllAssetPaths().SequenceEqual(assetPaths), "catalog read creates no project assets");
            Assert(SceneManager.GetActiveScene() == active && active.isDirty == dirty && Hierarchy(active) == hierarchy && SceneManager.sceneCount == sceneCount,
                "active scene, dirty state and hierarchy unchanged");
            Assert(EditorSceneManager.previewSceneCount == previewCount, "all isolated measurement previews closed");

            string local = Path.GetFullPath(Path.Combine(Root, ".."));
            File.WriteAllText(Path.Combine(local, "unity-asset-catalog.json"), first.ToString(), new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(local, "unity-asset-catalog-result.json"), new JObject
            {
                ["assertions"] = assertions, ["roles"] = roleGuids.Count, ["assets"] = entries.Length, ["skipped"] = skipped.Length,
                ["sourcePrefabsUnchanged"] = true, ["openScenesUnchanged"] = true
            }.ToString(), new UTF8Encoding(false));
            Debug.Log("BAEKHO_ASSET_CATALOG_PASS " + assertions + " assertions");
        }
        catch (Exception exception) { Debug.LogException(exception); EditorApplication.Exit(1); }
    }

    private static JObject ReadTool(string projectRoot)
    {
        var response = BaekhoGetAssetCatalogTool.HandleCommand(new JObject { ["expectedProjectRoot"] = projectRoot }) as SuccessResponse;
        Assert(response != null, "native tool returns standard SuccessResponse");
        return response.Data as JObject ?? JObject.FromObject(response.Data);
    }
    private static GameObject Box(Scene preview, string name)
    {
        var source = new GameObject(name); SceneManager.MoveGameObjectToScene(source, preview);
        source.transform.position = new Vector3(10, 20, 30);
        source.transform.rotation = Quaternion.Euler(0, 45, 0);
        source.transform.localScale = new Vector3(3, 4, 5);
        BoxCollider collider = source.AddComponent<BoxCollider>();
        collider.center = new Vector3(2, 1, -3); collider.size = new Vector3(1, 2, 3);
        return source;
    }
    private static void AddCase(Scene scene, List<string> paths, string name, Action<BaekhoMapAsset> configure)
    {
        GameObject source = Box(scene, name);
        configure(source.AddComponent<BaekhoMapAsset>());
        paths.Add(Save(source, name));
    }
    private static string Save(GameObject source, string name)
    {
        string path = Folder + "/" + name + ".prefab";
        Assert(PrefabUtility.SaveAsPrefabAsset(source, path) != null, "fixture prefab saved: " + name);
        UnityEngine.Object.DestroyImmediate(source);
        return path;
    }
    private static string Hierarchy(Scene scene)
    {
        return string.Join("|", scene.GetRootGameObjects().SelectMany(root => root.GetComponentsInChildren<Transform>(true)).Select(transform =>
            transform.GetInstanceID() + ":" + (transform.parent == null ? 0 : transform.parent.GetInstanceID()) + ":" + transform.name).ToArray());
    }
    private static string Hash(string path)
    {
        using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(File.ReadAllBytes(path)));
    }
    private static string LowerFirst(string value) { return char.ToLowerInvariant(value[0]) + value.Substring(1); }
    private static void Near(JToken value, Vector3 expected, string message)
    {
        Vector3 actual = new Vector3((float)value["x"], (float)value["y"], (float)value["z"]);
        Assert((actual - expected).magnitude < .0001f, message + ": " + actual);
    }
    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException("ASSERT FAILED: " + message);
        assertions++;
    }
}
