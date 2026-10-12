// Copy alongside BaekhoMapImporter.cs in an ISOLATED validation project's Assets/Editor.
// Run with -batchmode -nographics -executeMethod BaekhoImporterSmoke.Run -quit.
using System;
using System.IO;
using System.Text;
using StudioBaekho;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

public static class BaekhoImporterSmoke
{
    private const string Folder = "Assets/BaekhoValidation";
    private static int assertions;

    [Serializable] private sealed class AppManifest
    {
        public int schemaVersion;
        public float cellSize;
        public AppPlacement[] placements;
        public AppConnection[] connections;
    }
    [Serializable] private sealed class AppConnection
    {
        public string id;
        public string label;
        public string kind;
        public float width;
        public float height;
        public Vector3 position;
        public Vector3 rotation;
    }
    [Serializable] private sealed class AppPlacement
    {
        public string id;
        public string role;
        public string prefabGuid;
        public Vector3 position;
        public Vector3 rotation;
        public Vector3 scale;
    }

    // End-to-end entry: input must be emitted by the real JS createExportBundle pipeline.
    public static void RunAppExport()
    {
        try
        {
            if (!Application.dataPath.Replace('\\', '/').EndsWith("/.local/unity-validation/Assets", StringComparison.Ordinal))
                throw new InvalidOperationException("Integration tests may only run in .local/unity-validation.");
            const string input = Folder + "/app-generated.baekhomap.json";
            var manifest = JsonUtility.FromJson<AppManifest>(File.ReadAllText(input));
            int previews = EditorSceneManager.previewSceneCount;
            Scene active = SceneManager.GetActiveScene();
            bool dirty = active.isDirty;
            int roots = active.rootCount;
            string output = BaekhoMapImporter.BuildFromPath(input);
            GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(output);
            Assert(prefab != null && prefab.transform.childCount == manifest.placements.Length + (manifest.schemaVersion >= 2 ? 1 : 0),
                "every JS placement becomes one prefab child alongside an optional Connections group");
            foreach (AppPlacement placement in manifest.placements)
            {
                Transform child = prefab.transform.Find(placement.role + "_" + placement.id);
                Assert(child != null, "JS placement name: " + placement.id);
                bool surfaceAligned = manifest.schemaVersion == 3 && placement.role != "stair";
                Assert(Mathf.Abs(child.localPosition.x - placement.position.x) < 0.0001f &&
                    Mathf.Abs(child.localPosition.z - placement.position.z) < 0.0001f &&
                    Mathf.Abs(child.localScale.x - placement.scale.x) < 0.0001f &&
                    Mathf.Abs(child.localScale.z - placement.scale.z) < 0.0001f &&
                    Quaternion.Angle(child.localRotation, Quaternion.Euler(placement.rotation)) < 0.01f,
                    "JS horizontal transforms and rotation: " + placement.id);
                if (surfaceAligned)
                {
                    Bounds bounds = GeometryBounds(child);
                    Assert(Mathf.Abs((placement.role == "floor" ? bounds.max.y : bounds.min.y) - placement.position.y) < 0.001f,
                        "JS geometry meets intended surface: " + placement.id);
                    if (placement.role == "floor" && bounds.size.y > 0)
                        Assert(Mathf.Abs(bounds.size.y - manifest.cellSize * 0.12f * placement.scale.y) < 0.001f,
                            "JS floor has calibrated thin geometry: " + placement.id);
                    else Assert(child.localScale.y == placement.scale.y, "JS object height is preserved: " + placement.id);
                }
                else Assert(child.localPosition.y == placement.position.y && child.localScale.y == placement.scale.y,
                    "JS legacy and stair vertical transforms: " + placement.id);
                if (!string.IsNullOrEmpty(placement.prefabGuid))
                    Assert(AssetDatabase.AssetPathToGUID(PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(child.gameObject)) == placement.prefabGuid,
                        "JS source GUID remains nested: " + placement.id);
            }
            Transform highFloor = prefab.transform.Find("floor_floor-10-12");
            Assert(highFloor != null && highFloor.localPosition.x == 5 && highFloor.localPosition.z == -9 &&
                Mathf.Abs((manifest.schemaVersion == 3 ? GeometryBounds(highFloor).max.y : highFloor.localPosition.y) - 2) < 0.001f,
                "demo raised floor at x10 row12 has surface Y2");
            foreach (string id in new[] { "stair-11-10", "stair-8-13" })
            {
                Transform stairs = prefab.transform.Find("stair_" + id);
                Assert(stairs != null && stairs.localPosition.y == 0 && stairs.localScale.y == 2,
                    "JS rise2/nativeRise1 sets stair Y scale2 rather than supplied arbitrary scale9");
                Assert(Mathf.Abs(stairs.Find("Step3").TransformPoint(0, 0.5f, 0).y - 2) < 0.001f,
                    "exported stair geometry meets raised landing at Y2");
            }
            Assert(Quaternion.Angle(prefab.transform.Find("stair_stair-11-10").localRotation, Quaternion.Euler(0, 180, 0)) < 0.01f &&
                Quaternion.Angle(prefab.transform.Find("stair_stair-8-13").localRotation, Quaternion.Euler(0, 90, 0)) < 0.01f,
                "both demo staircase ascent directions survive export");
            if (manifest.schemaVersion == 1)
                Assert(prefab.transform.Find("spawn_spawn-2-2").localPosition.y == 0 &&
                    prefab.transform.Find("exit_exit-13-13").localPosition.y == 2, "JS legacy spawn and exit retain separate elevations");
            else
            {
                Assert(manifest.connections != null && manifest.connections.Length > 0 &&
                    prefab.GetComponentsInChildren<BaekhoMapConnection>().Length == manifest.connections.Length,
                    "every exported JS connection has a saved runtime socket component");
                foreach (AppConnection connection in manifest.connections)
                {
                    Transform socket = prefab.transform.Find("Connections/" + connection.id);
                    BaekhoMapConnection metadata = socket == null ? null : socket.GetComponent<BaekhoMapConnection>();
                    Assert(metadata != null && metadata.id == connection.id && metadata.label == connection.label && metadata.kind == connection.kind &&
                        metadata.width == connection.width && metadata.height == connection.height, "JS socket metadata: " + connection.id);
                    Assert(Vector3.Distance(socket.localPosition, connection.position) < 0.0001f && socket.localScale == Vector3.one &&
                        Vector3.Distance(socket.forward, Quaternion.Euler(connection.rotation) * Vector3.forward) < 0.0001f,
                        "JS socket edge position, floor height and outward direction: " + connection.id);
                }
                Assert(prefab.transform.Find("spawn_spawn-2-2") == null && prefab.transform.Find("exit_exit-13-13") == null,
                    "schema2/3 contain sockets instead of legacy markers");
            }
            Assert(active == SceneManager.GetActiveScene() && active.isDirty == dirty && active.rootCount == roots &&
                EditorSceneManager.previewSceneCount == previews, "JS import preserves active scene and closes preview");
            string report = "PASS Unity " + Application.unityVersion + " — real JS bundle to native prefab: " +
                manifest.placements.Length + " placements, " + (manifest.connections == null ? 0 : manifest.connections.Length) +
                " connections, " + assertions + " assertions. Raised floor surface Y2, thin aligned floors, calibrated stairs at 90/180 degrees reach Y2, all GUIDs preserved. Output: " + output;
            File.WriteAllText(Path.GetFullPath("../unity-app-export-result.txt"), report, new UTF8Encoding(false));
            Debug.Log("BAEKHO_APP_EXPORT_PASS " + report);
        }
        catch (Exception exception)
        {
            Debug.LogException(exception);
            EditorApplication.Exit(1);
        }
    }

    public static void Run()
    {
        try
        {
            if (!Application.dataPath.Replace('\\', '/').EndsWith("/.local/unity-validation/Assets", StringComparison.Ordinal))
                throw new InvalidOperationException("Smoke tests may only run in .local/unity-validation.");
            if (!AssetDatabase.IsValidFolder(Folder)) AssetDatabase.CreateFolder("Assets", "BaekhoValidation");
            Scene baseline = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var sentinel = new GameObject("UserSceneSentinel");
            sentinel.transform.position = new Vector3(7, 8, 9);

            string innerPath = AssetDatabase.GenerateUniqueAssetPath(Folder + "/Nested.prefab");
            var inner = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            PrefabUtility.SaveAsPrefabAsset(inner, innerPath);
            UnityEngine.Object.DestroyImmediate(inner);
            string sourcePath = AssetDatabase.GenerateUniqueAssetPath(Folder + "/Floor.prefab");
            var source = GameObject.CreatePrimitive(PrimitiveType.Cube);
            source.name = "SourceFloor";
            source.transform.position = new Vector3(15, 3, 25);
            source.transform.rotation = Quaternion.Euler(5, 15, 25);
            source.transform.localScale = new Vector3(2, 3, 4);
            var nested = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(innerPath), baseline);
            nested.name = "NestedSource";
            nested.transform.SetParent(source.transform, false);
            nested.transform.localPosition = new Vector3(0.2f, 0.5f, 0.3f);
            PrefabUtility.SaveAsPrefabAsset(source, sourcePath);
            UnityEngine.Object.DestroyImmediate(source);
            string guid = AssetDatabase.AssetPathToGUID(sourcePath);
            string stairPath = AssetDatabase.GenerateUniqueAssetPath(Folder + "/Stair.prefab");
            var stairSource = new GameObject("SourceStair");
            for (int step = 0; step < 4; step++)
            {
                var tread = GameObject.CreatePrimitive(PrimitiveType.Cube);
                tread.name = "Step" + step;
                tread.transform.SetParent(stairSource.transform, false);
                tread.transform.localPosition = new Vector3(0, (step + 1) / 8f, -0.5f + (step + 0.5f) / 4f);
                tread.transform.localScale = new Vector3(1, (step + 1) / 4f, 0.25f);
            }
            PrefabUtility.SaveAsPrefabAsset(stairSource, stairPath);
            UnityEngine.Object.DestroyImmediate(stairSource);
            string stairGuid = AssetDatabase.AssetPathToGUID(stairPath);
            string[] surfaceGuids = CreateSurfaceFixtures();
            EditorSceneManager.SaveScene(baseline, Folder + "/Baseline.unity");
            int rootCount = baseline.rootCount;
            int previewCount = EditorSceneManager.previewSceneCount;
            string valid = "{\"schemaVersion\":1,\"name\":\"검증 맵\",\"width\":4,\"height\":3,\"cellSize\":2," +
                "\"placements\":[" + Placement("floor-1", "floor", guid, "{\"x\":4,\"y\":1,\"z\":6}", "{\"x\":0,\"y\":90,\"z\":0}", "{\"x\":1,\"y\":0.5,\"z\":2}") + "," +
                Placement("stair-1", "stair", stairGuid, "{\"x\":2,\"y\":2,\"z\":4}", "{\"x\":0,\"y\":90,\"z\":0}", "{\"x\":2,\"y\":3,\"z\":2}") + "," +
                Placement("spawn-1", "spawn", "", "{\"x\":4,\"y\":1,\"z\":6}") + "," +
                Placement("exit-1", "exit", "", "{\"x\":4,\"y\":5,\"z\":6}") + "]}";
            string input = Folder + "/sample.baekhomap.json";
            Write(input, valid);
            string output = BaekhoMapImporter.BuildFromPath(input);
            Assert(File.Exists(output), "prefab exists");
            Assert(!baseline.isDirty && SceneManager.GetActiveScene() == baseline && baseline.rootCount == rootCount,
                "current scene remains clean and unchanged");
            Assert(EditorSceneManager.previewSceneCount == previewCount, "preview scene is closed");
            Assert(sentinel.transform.position == new Vector3(7, 8, 9), "user object transform remains unchanged");
            GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(output);
            Assert(prefab.transform.childCount == 4, "all four placements saved");
            Assert(prefab.transform.localPosition == Vector3.zero && prefab.transform.localScale == Vector3.one &&
                prefab.transform.localRotation == Quaternion.identity, "root transform is identity");
            Transform floor = prefab.transform.Find("floor_floor-1");
            Assert(floor != null, "stable placement name saved");
            Assert(PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(floor.gameObject) == sourcePath,
                "original prefab connection preserved");
            Assert(floor.localPosition == new Vector3(4, 1, 6) && floor.localScale == new Vector3(1, 0.5f, 2) &&
                Quaternion.Angle(floor.localRotation, Quaternion.Euler(0, 90, 0)) < 0.01f, "root placement overrides original transforms");
            Assert(floor.GetComponent<BoxCollider>() != null && floor.GetComponent<MeshRenderer>() != null,
                "original components preserved");
            Assert(PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(floor.GetChild(0).gameObject) == innerPath,
                "nested source prefab connection preserved");
            Assert(floor.GetChild(0).localPosition == new Vector3(0.2f, 0.5f, 0.3f), "nested source transform preserved");
            Transform stairs = prefab.transform.Find("stair_stair-1");
            Assert(stairs != null && PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(stairs.gameObject) == stairPath,
                "stair role retains its prefab source");
            Assert(stairs.localPosition == new Vector3(2, 2, 4) && stairs.localScale == new Vector3(2, 3, 2),
                "stair base elevation and rise scale are retained");
            Assert(Quaternion.Angle(stairs.localRotation, Quaternion.Euler(0, 90, 0)) < 0.01f,
                "stair ascent direction is rotated around Unity Y");
            Transform upperTread = stairs.Find("Step3");
            Assert(Mathf.Abs(upperTread.TransformPoint(0, 0.5f, 0).y - 5) < 0.001f,
                "actual stair geometry reaches base plus rise at world Y 5");
            Assert(prefab.transform.Find("spawn_spawn-1").GetComponents<Component>().Length == 1 &&
                prefab.transform.Find("exit_exit-1").GetComponents<Component>().Length == 1, "spawn and exit are empty transform markers");
            Assert(prefab.transform.Find("spawn_spawn-1").localPosition.y == 1 &&
                prefab.transform.Find("exit_exit-1").localPosition.y == 5, "markers preserve distinct floor elevations");
            string oldGuid = AssetDatabase.AssetPathToGUID(output);
            string output2 = BaekhoMapImporter.BuildFromPath(input);
            Assert(output != output2 && AssetDatabase.AssetPathToGUID(output) == oldGuid, "repeat import does not overwrite");

            Reject(input, valid.Replace("\"schemaVersion\":1", "\"schemaVersion\":2"), "schema version");
            Reject(input, valid.Replace("\"width\":4", "\"width\":0"), "dimensions");
            Reject(input, valid.Replace("\"width\":4", "\"width\":4.5"), "fractional dimensions");
            Reject(input, valid.Replace("검증 맵", "../escape"), "unsafe map name");
            Reject(input, valid.Replace(guid, "00000000000000000000000000000000"), "missing prefab");
            Reject(input, valid.Replace("spawn-1", "floor-1"), "duplicate IDs");
            Reject(input, valid.Replace("\"role\":\"floor\"", "\"role\":\"enemy\""), "unknown roles");
            Reject(input, valid.Replace("\"y\":0.5", "\"y\":0"), "zero scale");
            Reject(input, valid.Replace("\"y\":0.5", "\"y\":-1"), "negative scale");
            Reject(input, valid.Replace("\"x\":4", "\"x\":1e999"), "infinite coordinate");
            Reject(input, valid.Replace("\"x\":4,", ""), "missing vector scalar");
            Reject(input, valid.Replace("\"position\":{\"x\":4,\"y\":1,\"z\":6},", ""), "missing position");
            Reject(input, valid.Replace("\"position\":{\"x\":4,\"y\":1,\"z\":6}", "\"position\":null"), "null position");
            Reject(input, valid.Replace("\"width\":4", "\"width\":4,\"width\":5"), "duplicate JSON fields");
            Reject(input, valid + " trailing", "invalid trailing data");
            Reject(input, valid.Replace("\"x\":4", "\"x\":\"4\""), "string instead of number");
            TestConnections(input, guid, baseline, rootCount, previewCount);
            TestSurfacePlacement(input, surfaceGuids, stairGuid, baseline, rootCount, previewCount);
            Assert(!baseline.isDirty && baseline.rootCount == rootCount && EditorSceneManager.previewSceneCount == previewCount,
                "all failures leave scene and preview state unchanged");
            Write(input, valid);
            string report = "PASS Unity " + Application.unityVersion + " — " + assertions + " assertions; schema1/2 exact-transform compatibility, schema3 thin floors and surface-aligned objects across pivots/nested geometry, collider fallback, planes, unchanged stairs/sockets, strict validation and clean active scene.";
            File.WriteAllText(Path.GetFullPath("../unity-validation-result.txt"), report, new UTF8Encoding(false));
            Debug.Log("BAEKHO_SMOKE_PASS " + report);
        }
        catch (Exception exception)
        {
            Debug.LogException(exception);
            EditorApplication.Exit(1);
        }
    }

    private static void TestConnections(string input, string guid, Scene baseline, int rootCount, int previewCount)
    {
        string placements = Placement("floor-1", "floor", guid) + "," +
            Placement("door-1", "door", guid, "{\"x\":4,\"y\":2,\"z\":0}", "{\"x\":0,\"y\":90,\"z\":0}");
        string[] sockets = {
            Connection("north", "북쪽 문", "{\"x\":1,\"y\":0,\"z\":3}", 0),
            Connection("east", "동쪽 문", "{\"x\":4,\"y\":2,\"z\":0}", 90),
            Connection("south", "남쪽 문", "{\"x\":-1,\"y\":4,\"z\":-3}", 180),
            Connection("west", "서쪽 문", "{\"x\":-4,\"y\":-1,\"z\":0}", 270)
        };
        // Put connections before schemaVersion: strict validation must not depend on key order.
        string prefix = "{\"connections\":[";
        string suffix = "],\"schemaVersion\":2,\"name\":\"연결 방\",\"width\":4,\"height\":3,\"cellSize\":2,\"placements\":[" + placements + "]}";
        string valid = prefix + string.Join(",", sockets) + suffix;
        Write(input, valid);
        string output = BaekhoMapImporter.BuildFromPath(input);
        AssetDatabase.ImportAsset(output, ImportAssetOptions.ForceUpdate);
        GameObject loaded = PrefabUtility.LoadPrefabContents(output);
        try
        {
            Transform group = loaded.transform.Find("Connections");
            Assert(group != null && group.childCount == 4 && loaded.transform.childCount == 3,
                "schema2 creates one Connections group alongside the two placements");
            Assert(group.localPosition == Vector3.zero && group.localRotation == Quaternion.identity && group.localScale == Vector3.one,
                "connection coordinates use an identity parent");
            var positions = new[] { new Vector3(1, 0, 3), new Vector3(4, 2, 0), new Vector3(-1, 4, -3), new Vector3(-4, -1, 0) };
            var forward = new[] { Vector3.forward, Vector3.right, Vector3.back, Vector3.left };
            var ids = new[] { "north", "east", "south", "west" };
            var labels = new[] { "북쪽 문", "동쪽 문", "남쪽 문", "서쪽 문" };
            Assert(loaded.GetComponentsInChildren<BaekhoMapConnection>().Length == 4,
                "all saved sockets retain runtime components after loading prefab contents");
            for (int index = 0; index < ids.Length; index++)
            {
                Transform socket = group.Find(ids[index]);
                BaekhoMapConnection metadata = socket == null ? null : socket.GetComponent<BaekhoMapConnection>();
                Assert(metadata != null && metadata.id == ids[index] && metadata.label == labels[index] && metadata.kind == "door_main" &&
                    metadata.width == 1.5f && metadata.height == 2.5f, "serialized metadata retained: " + ids[index]);
                Assert(socket.localPosition == positions[index] && socket.localScale == Vector3.one &&
                    Vector3.Distance(socket.forward, forward[index]) < 0.0001f, "floor edge position and outward forward retained: " + ids[index]);
                Assert(MonoScript.FromMonoBehaviour(metadata) != null, "runtime script reference retained: " + ids[index]);
            }
            Assert(PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(loaded.transform.Find("door_door-1").gameObject) ==
                AssetDatabase.GUIDToAssetPath(guid), "schema2 door keeps original prefab link");
            // Rotating/placing the assembled room must transform its connection basis normally.
            loaded.transform.SetPositionAndRotation(new Vector3(10, 5, 20), Quaternion.Euler(0, 90, 0));
            Assert(Vector3.Distance(group.Find("north").forward, Vector3.right) < 0.0001f &&
                Vector3.Distance(group.Find("north").position, new Vector3(13, 5, 19)) < 0.0001f,
                "socket world position and forward follow the room instance transform");
        }
        finally { PrefabUtility.UnloadPrefabContents(loaded); }
        Assert(!baseline.isDirty && baseline.rootCount == rootCount && EditorSceneManager.previewSceneCount == previewCount,
            "socket creation and prefab reload preserve the user scene");
        string output2 = BaekhoMapImporter.BuildFromPath(input);
        Assert(output2 != output && AssetDatabase.LoadAssetAtPath<GameObject>(output).GetComponentsInChildren<BaekhoMapConnection>().Length == 4,
            "repeated schema2 import preserves the original socket prefab");

        Reject(input, prefix + suffix, "empty connections");
        Reject(input, valid.Replace("\"schemaVersion\":2", "\"schemaVersion\":1"), "schema1 unexpected connections");
        Reject(input, valid.Replace("\"role\":\"floor\"", "\"role\":\"spawn\""), "schema2 legacy marker role");
        Reject(input, prefix + sockets[0] + "," + sockets[0] + suffix, "duplicate connection IDs");
        Reject(input, valid.Replace("\"id\":\"north\"", "\"id\":\"../north\""), "unsafe connection ID");
        Reject(input, valid.Replace("\"id\":\"north\"", "\"id\":\"" + new string('a', 81) + "\""), "long connection ID");
        Reject(input, valid.Replace("북쪽 문", ""), "empty connection label");
        Reject(input, valid.Replace("북쪽 문", "북쪽\\n문"), "control in connection label");
        Reject(input, valid.Replace("북쪽 문", new string('a', 81)), "long connection label");
        Reject(input, valid.Replace("door_main", "door/main"), "unsafe connection kind");
        Reject(input, valid.Replace("door_main", new string('a', 41)), "long connection kind");
        Reject(input, valid.Replace("\"width\":1.5", "\"width\":0.24"), "narrow connection");
        Reject(input, valid.Replace("\"width\":1.5", "\"width\":3"), "connection wider than cell");
        Reject(input, valid.Replace("\"cellSize\":2", "\"cellSize\":20").Replace("\"width\":1.5", "\"width\":11"), "connection wider than maximum");
        Reject(input, valid.Replace("\"height\":2.5", "\"height\":0.24"), "short connection");
        Reject(input, valid.Replace("\"height\":2.5", "\"height\":21"), "tall connection");
        Reject(input, valid.Replace("\"height\":2.5,", ""), "missing connection height");
        Reject(input, valid.Replace("\"height\":2.5", "\"height\":\"2.5\""), "string connection height");
        Reject(input, valid.Replace("\"x\":1,\"y\":0,\"z\":3", "\"x\":1000001,\"y\":0,\"z\":3"), "connection out of coordinate bounds");
        Reject(input, valid.Replace("\"x\":1,\"y\":0,\"z\":3", "\"x\":1e999,\"y\":0,\"z\":3"), "infinite connection coordinate");
        Reject(input, valid.Replace("\"x\":1,\"y\":0,\"z\":3", "\"y\":0,\"z\":3"), "missing connection coordinate");
        Reject(input, valid.Replace("\"x\":0,\"y\":270,\"z\":0", "\"x\":0,\"y\":45,\"z\":0"), "non-cardinal connection rotation");
        Reject(input, valid.Replace("\"x\":0,\"y\":270,\"z\":0", "\"x\":1,\"y\":270,\"z\":0"), "tilted connection rotation");
        Reject(input, valid.Replace("\"label\":\"북쪽 문\"", "\"label\":\"북쪽 문\",\"label\":\"duplicate\""), "duplicate connection field");
        Reject(input, valid.Replace("\"label\":\"북쪽 문\"", "\"label\":\"북쪽 문\",\"extra\":0"), "unknown connection field");
        var tooMany = new StringBuilder(prefix);
        for (int index = 0; index <= 1600; index++)
        {
            if (index != 0) tooMany.Append(',');
            tooMany.Append(Connection("socket-" + index, "Door", "{\"x\":0,\"y\":0,\"z\":0}", 0));
        }
        tooMany.Append(suffix);
        Reject(input, tooMany.ToString(), "more than 1600 connections");
    }

    private static string[] CreateSurfaceFixtures()
    {
        var result = new string[8];
        for (int index = 0; index < result.Length; index++)
        {
            GameObject root;
            if (index == 0) root = GameObject.CreatePrimitive(PrimitiveType.Cube);
            else if (index == 5) root = GameObject.CreatePrimitive(PrimitiveType.Plane);
            else root = new GameObject();
            root.name = "SurfaceFixture" + index;
            if (index == 1 || index == 2 || index == 7)
            {
                GameObject cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
                cube.transform.SetParent(root.transform, false);
                cube.transform.localPosition = new Vector3(0, index == 1 ? 0.5f : index == 2 ? -0.5f : 0, 0);
                if (index == 7) cube.transform.localScale = new Vector3(1, 0.000000001f, 1);
            }
            if (index == 3)
            {
                var group = new GameObject("NestedGroup");
                group.transform.SetParent(root.transform, false);
                group.transform.localPosition = new Vector3(0, 2, 0);
                group.transform.localScale = new Vector3(2, 3, 0.5f);
                group.transform.localRotation = Quaternion.Euler(0, 0, 90);
                GameObject cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
                cube.name = "NestedGeometry";
                cube.transform.SetParent(group.transform, false);
                cube.transform.localPosition = new Vector3(0, 0.5f, 0);
                cube.transform.localScale = new Vector3(2, 0.5f, 3);
                GameObject lower = GameObject.CreatePrimitive(PrimitiveType.Cube);
                lower.transform.SetParent(root.transform, false);
                lower.transform.localPosition = new Vector3(0, -1, 0);
                GameObject disabled = GameObject.CreatePrimitive(PrimitiveType.Cube);
                disabled.name = "DisabledDecoration";
                disabled.transform.SetParent(root.transform, false);
                disabled.transform.localPosition = new Vector3(0, 100, 0);
                disabled.GetComponent<MeshRenderer>().enabled = false;
                GameObject inactive = GameObject.CreatePrimitive(PrimitiveType.Cube);
                inactive.name = "InactiveDecoration";
                inactive.transform.SetParent(root.transform, false);
                inactive.transform.localPosition = new Vector3(0, 200, 0);
                inactive.SetActive(false);
                var effect = new GameObject("ParticleEffect", typeof(ParticleSystem));
                effect.transform.SetParent(root.transform, false);
                effect.transform.localPosition = new Vector3(0, 300, 0);
                effect.GetComponent<ParticleSystem>().Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
            }
            if (index == 4)
            {
                BoxCollider box = root.AddComponent<BoxCollider>();
                box.center = new Vector3(0, 3, 0);
                box.size = new Vector3(2, 4, 2);
                var trigger = new GameObject("TriggerVolume");
                trigger.transform.SetParent(root.transform, false);
                BoxCollider extra = trigger.AddComponent<BoxCollider>();
                extra.center = new Vector3(0, -100, 0);
                extra.isTrigger = true;
            }
            string path = AssetDatabase.GenerateUniqueAssetPath(Folder + "/Surface" + index + ".prefab");
            PrefabUtility.SaveAsPrefabAsset(root, path);
            UnityEngine.Object.DestroyImmediate(root);
            result[index] = AssetDatabase.AssetPathToGUID(path);
        }
        return result;
    }

    private static void TestSurfacePlacement(string input, string[] guids, string stairGuid, Scene baseline, int rootCount, int previewCount)
    {
        string[] entries = {
            Placement("center", "floor", guids[0], "{\"x\":-10,\"y\":0,\"z\":0}", scale: "{\"x\":2,\"y\":1,\"z\":3}"),
            Placement("center", "wall", guids[0], "{\"x\":-8,\"y\":0,\"z\":0}", scale: "{\"x\":1,\"y\":3,\"z\":1}"),
            Placement("bottom", "floor", guids[1], "{\"x\":-6,\"y\":2.75,\"z\":1}", scale: "{\"x\":1,\"y\":0.5,\"z\":1}"),
            Placement("top", "floor", guids[2], "{\"x\":-4,\"y\":2,\"z\":0}"),
            Placement("nested", "floor", guids[3], "{\"x\":-2,\"y\":-3,\"z\":0}"),
            Placement("bottom", "prop", guids[1], "{\"x\":0,\"y\":2.75,\"z\":1}"),
            Placement("top", "door", guids[2], "{\"x\":2,\"y\":2.75,\"z\":1}", "{\"x\":0,\"y\":90,\"z\":0}"),
            Placement("nested", "wall", guids[3], "{\"x\":4,\"y\":-3,\"z\":0}"),
            Placement("collider", "floor", guids[4], "{\"x\":6,\"y\":4,\"z\":0}"),
            Placement("collider", "prop", guids[4], "{\"x\":8,\"y\":4,\"z\":0}"),
            Placement("plane", "floor", guids[5], "{\"x\":10,\"y\":2,\"z\":0}"),
            Placement("stairs", "stair", stairGuid, "{\"x\":12,\"y\":2,\"z\":0}", "{\"x\":0,\"y\":180,\"z\":0}", "{\"x\":1,\"y\":3,\"z\":1}")
        };
        // Placement IDs are globally unique, even when roles differ.
        for (int index = 0; index < entries.Length; index++)
            entries[index] = entries[index].Replace("\"id\":\"", "\"id\":\"" + index + "-");
        string valid = SurfaceManifest(string.Join(",", entries));
        Write(input, valid);
        string output = BaekhoMapImporter.BuildFromPath(input);
        GameObject loaded = PrefabUtility.LoadPrefabContents(output);
        try
        {
            Assert(loaded.transform.childCount == entries.Length + 1, "schema3 placements and sockets saved");
            string[] names = { "floor_0-center", "wall_1-center", "floor_2-bottom", "floor_3-top", "floor_4-nested",
                "prop_5-bottom", "door_6-top", "wall_7-nested", "floor_8-collider", "prop_9-collider", "floor_10-plane" };
            float[] surfaces = { 0, 0, 2.75f, 2, -3, 2.75f, 2.75f, -3, 4, 4, 2 };
            for (int index = 0; index < names.Length; index++)
            {
                Transform item = loaded.transform.Find(names[index]);
                Bounds geometry = GeometryBounds(item);
                bool floor = names[index].StartsWith("floor", StringComparison.Ordinal);
                Assert(Mathf.Abs((floor ? geometry.max.y : geometry.min.y) - surfaces[index]) < 0.001f,
                    "geometry aligns to surface including custom Y offsets: " + names[index]);
                if (floor && index != 10)
                    Assert(Mathf.Abs(geometry.size.y - (index == 2 ? 0.12f : 0.24f)) < 0.001f,
                        "thin total floor thickness across pivots and nested geometry: " + names[index]);
                Assert(PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(item.gameObject) != output,
                    "source prefab link preserved: " + names[index]);
            }
            Transform centered = loaded.transform.Find("floor_0-center");
            Assert(centered.localScale == new Vector3(2, 0.24f, 3) && Mathf.Abs(centered.localPosition.y + 0.12f) < 0.001f,
                "centered floor shrinks Y and moves below surface while retaining XZ scale");
            Assert(loaded.transform.Find("prop_5-bottom").localPosition == new Vector3(0, 2.75f, 1),
                "bottom pivot already on surface needs no shift; XZ/Y user offset remains intact");
            Assert(loaded.transform.Find("floor_3-top").localPosition.y == 2,
                "top pivot floor already on surface needs no shift");
            Assert(loaded.transform.Find("floor_10-plane").localScale == Vector3.one &&
                GeometryBounds(loaded.transform.Find("floor_10-plane")).size.y < 0.000001f, "zero-thickness plane remains planar");
            Transform stair = loaded.transform.Find("stair_11-stairs");
            Assert(stair.localPosition == new Vector3(12, 2, 0) && stair.localScale == new Vector3(1, 3, 1) &&
                Mathf.Abs(stair.Find("Step3").TransformPoint(0, 0.5f, 0).y - 5) < 0.001f,
                "schema3 stair keeps original low-base pivot and calibrated rise");
            Transform socket = loaded.transform.Find("Connections/east");
            Assert(socket.localPosition == new Vector3(2, 2, 1) && Vector3.Distance(socket.forward, Vector3.right) < 0.0001f &&
                socket.localScale == Vector3.one, "schema3 connection stays at raw surface without door offset or alignment shift");
        }
        finally { PrefabUtility.UnloadPrefabContents(loaded); }
        Reject(input, SurfaceManifest(Placement("empty", "floor", guids[6])), "unmeasurable floor");
        Reject(input, SurfaceManifest(Placement("empty", "wall", guids[6])), "unmeasurable object");
        Reject(input, SurfaceManifest(Placement("tiny", "floor", guids[7])), "derived floor scale overflow");
        Reject(input, SurfaceManifest(Placement("tiny", "floor", guids[0], scale: "{\"x\":1,\"y\":1.401298464e-45,\"z\":1}")), "derived floor scale underflow");
        Reject(input, SurfaceManifest(Placement("edge", "floor", guids[0], "{\"x\":0,\"y\":-1000000,\"z\":0}")), "derived aligned position overflow");
        Reject(input, SurfaceManifest(Placement("tilt", "floor", guids[0], rotation: "{\"x\":10,\"y\":0,\"z\":0}")), "tilted floor");
        Reject(input, valid.Replace("\"role\":\"floor\"", "\"role\":\"spawn\""), "schema3 legacy marker role");
        Reject(input, valid.Replace("\"schemaVersion\":3", "\"schemaVersion\":4"), "unsupported future schema");
        Reject(input, valid.Replace("\"cellSize\":2", "\"cellSize\":\"2\""), "schema3 string scalar");
        Assert(!baseline.isDirty && baseline.rootCount == rootCount && EditorSceneManager.previewSceneCount == previewCount,
            "schema3 success and bounds failures preserve active scene and close all previews");
    }

    private static string SurfaceManifest(string placements)
    {
        return "{\"schemaVersion\":3,\"name\":\"표면 정렬\",\"width\":16,\"height\":8,\"cellSize\":2,\"placements\":[" + placements +
            "],\"connections\":[" + Connection("east", "동쪽 문", "{\"x\":2,\"y\":2,\"z\":1}", 90) + "]}";
    }

    // Check actual fixture vertices independently of the importer's mesh-box projection.
    private static Bounds GeometryBounds(Transform root)
    {
        bool found = false;
        Bounds result = new Bounds();
        foreach (MeshFilter filter in root.GetComponentsInChildren<MeshFilter>(true))
        {
            MeshRenderer renderer = filter.GetComponent<MeshRenderer>();
            if (renderer == null || !renderer.enabled || filter.sharedMesh == null || !ActiveWithin(filter.transform, root)) continue;
            foreach (Vector3 vertex in filter.sharedMesh.vertices)
            {
                Vector3 point = filter.transform.TransformPoint(vertex);
                if (!found) { result = new Bounds(point, Vector3.zero); found = true; }
                else result.Encapsulate(point);
            }
        }
        if (!found)
            foreach (BoxCollider box in root.GetComponentsInChildren<BoxCollider>(true))
            {
                if (!box.enabled || box.isTrigger || !ActiveWithin(box.transform, root)) continue;
                for (int corner = 0; corner < 8; corner++)
                {
                    Vector3 point = box.transform.TransformPoint(box.center + Vector3.Scale(box.size / 2,
                        new Vector3((corner & 1) == 0 ? -1 : 1, (corner & 2) == 0 ? -1 : 1, (corner & 4) == 0 ? -1 : 1)));
                    if (!found) { result = new Bounds(point, Vector3.zero); found = true; }
                    else result.Encapsulate(point);
                }
            }
        Assert(found, "measurable fixture geometry: " + root.name);
        return result;
    }

    private static bool ActiveWithin(Transform item, Transform root)
    {
        for (Transform current = item; current != null; current = current.parent)
        {
            if (!current.gameObject.activeSelf) return false;
            if (current == root) return true;
        }
        return false;
    }

    private static string Connection(string id, string label, string position, int yaw)
    {
        return "{\"id\":\"" + id + "\",\"label\":\"" + label + "\",\"kind\":\"door_main\",\"width\":1.5,\"height\":2.5," +
            "\"position\":" + position + ",\"rotation\":{\"x\":0,\"y\":" + yaw + ",\"z\":0}}";
    }

    private static string Placement(string id, string role, string guid,
        string position = "{\"x\":0,\"y\":0,\"z\":0}", string rotation = "{\"x\":0,\"y\":0,\"z\":0}",
        string scale = "{\"x\":1,\"y\":1,\"z\":1}")
    {
        return "{\"id\":\"" + id + "\",\"role\":\"" + role + "\",\"prefabGuid\":\"" + guid +
            "\",\"position\":" + position + ",\"rotation\":" + rotation + ",\"scale\":" + scale + "}";
    }

    private static void Write(string path, string json) { File.WriteAllText(path, json, new UTF8Encoding(false)); }
    private static void Assert(bool pass, string message)
    {
        if (!pass) throw new InvalidOperationException("ASSERT FAILED: " + message);
        assertions++;
    }

    private static void Reject(string path, string json, string label)
    {
        int before = Directory.GetFiles(Folder, "*.prefab").Length;
        Write(path, json);
        bool rejected = false;
        try { BaekhoMapImporter.BuildFromPath(path); }
        catch (InvalidDataException) { rejected = true; }
        Assert(rejected && Directory.GetFiles(Folder, "*.prefab").Length == before, "reject " + label + " without saving");
    }
}
