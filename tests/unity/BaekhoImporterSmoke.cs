// Copy alongside BaekhoMapImporter.cs in an ISOLATED validation project's Assets/Editor.
// Run with -batchmode -nographics -executeMethod BaekhoImporterSmoke.Run -quit.
using System;
using System.Collections.Generic;
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

    [Serializable] private sealed class BoundsCatalog { public int version; public BoundsCatalogEntry[] assets; }
    [Serializable] private sealed class BoundsCatalogEntry { public string guid; public Vector3 size; }

    [Serializable] private sealed class AppManifest
    {
        public int schemaVersion;
        public float cellSize;
        public AppPlacement[] placements;
        public AppConnection[] connections;
        public AppMarker[] markers;
    }
    [Serializable] private sealed class AppMarker
    {
        public string id;
        public string label;
        public string kind;
        public string contentKey;
        public Vector3 position;
        public Vector3 rotation;
        public AppMarkerClearance clearance;
    }
    [Serializable] private sealed class AppMarkerClearance { public float radius; public float height; }
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
        public string surface;
        public float fitHeight;
        public float fitWidth;
        public Vector3 fitSize;
        public bool centerXZ;
        public string linkedId;
    }

    // End-to-end entry: input must be emitted by the real JS createExportBundle pipeline.
    public static void RunAppExport()
    {
        VerifyAppExport(true);
    }

    public static void RunFeatureExport()
    {
        VerifyAppExport(false);
    }

    private static void VerifyAppExport(bool checkDemo)
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
            Assert(prefab != null && prefab.transform.childCount == manifest.placements.Length + (manifest.schemaVersion >= 2 ? 1 : 0) +
                (manifest.schemaVersion >= 4 ? 1 : 0),
                "every JS placement becomes one prefab child alongside an optional Connections group");
            foreach (AppPlacement placement in manifest.placements)
            {
                Transform child = prefab.transform.Find(placement.role + "_" + placement.id);
                Assert(child != null, "JS placement name: " + placement.id);
                if (placement.fitSize != Vector3.zero)
                {
                    Bounds bounds = GeometryBounds(child);
                    Assert((bounds.size - placement.fitSize).magnitude < .001f && (bounds.center - placement.position).magnitude < .001f,
                        "JS v5 fill dimensions and measured center: " + placement.id);
                    Assert(AssetDatabase.AssetPathToGUID(PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(child.gameObject)) == placement.prefabGuid,
                        "JS fitted structure keeps source GUID: " + placement.id);
                    continue;
                }
                if (placement.centerXZ)
                {
                    Bounds bounds = GeometryBounds(child, true);
                    Assert(Mathf.Abs(bounds.center.x - placement.position.x) < .001f && Mathf.Abs(bounds.center.z - placement.position.z) < .001f && Mathf.Abs(bounds.min.y - placement.position.y) < .001f,
                        "JS measured prop centers complete renderer/collider envelope: " + placement.id);
                    Assert(child.localScale == placement.scale, "JS measured prop preserves authored scale: " + placement.id);
                    Assert(AssetDatabase.AssetPathToGUID(PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(child.gameObject)) == placement.prefabGuid,
                        "JS measured prop keeps original prefab reference: " + placement.id);
                    continue;
                }
                if (manifest.schemaVersion >= 4 && (placement.role == "stair" || placement.role == "slope") && placement.surface == "bottom")
                {
                    Bounds bounds = GeometryBounds(child);
                    Assert(Mathf.Abs(bounds.min.y - placement.position.y) < .001f && Mathf.Abs(bounds.center.x - placement.position.x) < .001f && Mathf.Abs(bounds.center.z - placement.position.z) < .001f,
                        "JS stairs meet bottom-center anchor: " + placement.id);
                    Assert(child.localScale == placement.scale && Quaternion.Angle(child.localRotation, Quaternion.Euler(placement.rotation)) < .01f,
                        "JS stairs preserve calibrated rise and authored rotation: " + placement.id);
                    Assert(AssetDatabase.AssetPathToGUID(PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(child.gameObject)) == placement.prefabGuid,
                        "JS stairs preserve source GUID: " + placement.id);
                    continue;
                }
                bool surfaceAligned = manifest.schemaVersion >= 3 && placement.role != "stair" && placement.role != "slope" &&
                    placement.surface != "pivot" && (placement.role != "light" || !string.IsNullOrEmpty(placement.surface));
                Assert((placement.fitWidth > 0 || (Mathf.Abs(child.localPosition.x - placement.position.x) < 0.0001f &&
                    Mathf.Abs(child.localPosition.z - placement.position.z) < 0.0001f &&
                    Mathf.Abs(child.localScale.x - placement.scale.x) < 0.0001f)) &&
                    Mathf.Abs(child.localScale.z - placement.scale.z) < 0.0001f &&
                    Quaternion.Angle(child.localRotation, Quaternion.Euler(placement.rotation)) < 0.01f,
                    "JS horizontal transforms and rotation: " + placement.id);
                if (surfaceAligned)
                {
                    Bounds bounds = GeometryBounds(child);
                    if (placement.fitWidth > 0)
                    {
                        bool widthX = Mathf.RoundToInt(placement.rotation.y) % 180 == 0;
                        Assert(Mathf.Abs((widthX ? bounds.size.x : bounds.size.z) - placement.fitWidth) < 0.001f &&
                            Mathf.Abs((widthX ? bounds.center.x - placement.position.x : bounds.center.z - placement.position.z)) < 0.001f,
                            "JS wide door geometry width and center match its opening: " + placement.id);
                    }
                    bool top = placement.surface == "top" || (string.IsNullOrEmpty(placement.surface) &&
                        (placement.role == "floor" || placement.role == "bridge"));
                    Assert(Mathf.Abs((top ? bounds.max.y : bounds.min.y) - placement.position.y) < 0.001f,
                        "JS geometry meets intended surface: " + placement.id);
                    if (placement.fitHeight > 0)
                        Assert(Mathf.Abs(bounds.size.y - placement.fitHeight) < 0.001f,
                            "JS fitted vertical height: " + placement.id);
                    else if ((placement.role == "floor" || placement.role == "ceiling") && bounds.size.y > 0)
                        Assert(Mathf.Abs(bounds.size.y - manifest.cellSize * 0.12f * placement.scale.y) < 0.001f,
                            "JS floor has calibrated thin geometry: " + placement.id);
                    else Assert(child.localScale.y == placement.scale.y, "JS object height is preserved: " + placement.id);
                }
                else Assert(child.localPosition.y == placement.position.y && child.localScale.y == placement.scale.y,
                    "JS legacy and stair vertical transforms: " + placement.id);
                if (!string.IsNullOrEmpty(placement.prefabGuid))
                    Assert(AssetDatabase.AssetPathToGUID(PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(child.gameObject)) == placement.prefabGuid,
                        "JS source GUID remains nested: " + placement.id);
                if (manifest.schemaVersion >= 4 && child.GetComponent<BaekhoMapFixture>() != null)
                {
                    var fixture = child.GetComponent<BaekhoMapFixture>();
                    Assert(fixture.id == placement.id && fixture.role == placement.role &&
                        fixture.linkedId == (placement.linkedId ?? ""), "JS fixture metadata and links preserved: " + placement.id);
                }
            }
            int terrainContacts = 0;
            foreach (AppPlacement placement in manifest.placements)
            {
                bool fill = placement.id.StartsWith("fill-heightGap-") || placement.id.StartsWith("fill-pitSide-");
                bool cliff = placement.id.StartsWith("cliff-");
                if (!fill && !cliff) continue;
                string[] parts = placement.id.Split('-');
                int start = fill ? 2 : 1;
                Transform floor = prefab.transform.Find("floor_floor-" + parts[start] + "-" + parts[start + 1]);
                if (floor == null) continue;
                Transform face = prefab.transform.Find(placement.role + "_" + placement.id);
                Assert(Mathf.Abs(GeometryBounds(face).max.y - GeometryBounds(floor).min.y) < .001f,
                    "independent native face top touches actual calibrated floor underside without overlap or gap: " + placement.id);
                terrainContacts++;
            }
            if (manifest.schemaVersion >= 4) Assert(terrainContacts > 0, "app integration exercised native floor-to-support contact");
            if (checkDemo)
            {
            Transform highFloor = prefab.transform.Find("floor_floor-10-12");
            Assert(highFloor != null && highFloor.localPosition.x == 5 && highFloor.localPosition.z == -9 &&
                Mathf.Abs((manifest.schemaVersion >= 3 ? GeometryBounds(highFloor).max.y : highFloor.localPosition.y) - 2) < 0.001f,
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
            }
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
            if (manifest.schemaVersion >= 4)
            {
                Assert(prefab.GetComponentsInChildren<BaekhoGameplayMarker>().Length == manifest.markers.Length,
                    "every JS gameplay marker is saved");
                foreach (AppMarker marker in manifest.markers)
                {
                    Transform child = prefab.transform.Find("GameplayMarkers/" + marker.id);
                    var metadata = child.GetComponent<BaekhoGameplayMarker>();
                    Assert(child.localPosition == marker.position && child.localScale == Vector3.one &&
                        Quaternion.Angle(child.localRotation, Quaternion.Euler(marker.rotation)) < 0.01f &&
                        metadata.id == marker.id && metadata.label == marker.label && metadata.kind == marker.kind &&
                        metadata.contentKey == marker.contentKey && child.GetComponents<Component>().Length == 2 &&
                        metadata.clearanceRadius == (marker.clearance == null ? 0 : marker.clearance.radius) &&
                        metadata.clearanceHeight == (marker.clearance == null ? 0 : marker.clearance.height),
                        "JS marker metadata and transform preserved without game logic: " + marker.id);
                }
            }
            Assert(active == SceneManager.GetActiveScene() && active.isDirty == dirty && active.rootCount == roots &&
                EditorSceneManager.previewSceneCount == previews, "JS import preserves active scene and closes preview");
            string report = "PASS Unity " + Application.unityVersion + " — real JS bundle to native prefab: " +
                manifest.placements.Length + " placements, " + (manifest.connections == null ? 0 : manifest.connections.Length) +
                " connections, " + (manifest.markers == null ? 0 : manifest.markers.Length) + " markers, " + assertions +
                " assertions. Surface alignment, height fitting, pivot transforms, metadata and nested source GUIDs preserved. Output: " + output;
            File.WriteAllText(Path.GetFullPath("../unity-app-export-result.txt"), report, new UTF8Encoding(false));
            Debug.Log("BAEKHO_APP_EXPORT_PASS " + report);
        }
        catch (Exception exception)
        {
            Debug.LogException(exception);
            EditorApplication.Exit(1);
        }
    }

    public static void RunTeleportMarkers()
    {
        try
        {
            if (!Application.dataPath.Replace('\\', '/').EndsWith("/.local/unity-validation/Assets", StringComparison.Ordinal))
                throw new InvalidOperationException("Smoke tests may only run in .local/unity-validation.");
            if (!AssetDatabase.IsValidFolder(Folder)) AssetDatabase.CreateFolder("Assets", "BaekhoValidation");
            Scene baseline = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            string floorPath = AssetDatabase.GenerateUniqueAssetPath(Folder + "/TeleportFloor.prefab");
            var floor = GameObject.CreatePrimitive(PrimitiveType.Cube);
            PrefabUtility.SaveAsPrefabAsset(floor, floorPath);
            UnityEngine.Object.DestroyImmediate(floor);
            EditorSceneManager.SaveScene(baseline, Folder + "/TeleportBaseline.unity");
            int rootCount = baseline.rootCount, previewCount = EditorSceneManager.previewSceneCount;
            TestTeleportClearance(Folder + "/teleport-validation.baekhomap.json", AssetDatabase.AssetPathToGUID(floorPath));
            Assert(!baseline.isDirty && baseline.rootCount == rootCount && EditorSceneManager.previewSceneCount == previewCount,
                "teleport imports and failures leave the active scene and preview count unchanged");
            string report = "PASS Unity " + Application.unityVersion + " — " + assertions +
                " teleport assertions; metadata, floor pose, legacy marker defaults, strict clearance validation and scene isolation.";
            File.WriteAllText(Path.GetFullPath("../unity-teleport-result.txt"), report, new UTF8Encoding(false));
            Debug.Log("BAEKHO_TELEPORT_PASS " + report);
        }
        catch (Exception exception)
        {
            Debug.LogException(exception);
            EditorApplication.Exit(1);
        }
    }

    public static void Run()
    {
        // Tiny geometry/validation fixtures opt out of baking; BaekhoNavMeshSmoke covers navigation.
        // The real application export entry points above retain the default automatic bake.
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
            string lightGuid = CreateLightFixture();
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
            string output = BaekhoMapImporter.BuildFromPath(input, false);
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
            string output2 = BaekhoMapImporter.BuildFromPath(input, false);
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
            TestV4Placement(input, surfaceGuids, stairGuid, lightGuid, baseline, rootCount, previewCount);
            TestWideDoors(input, surfaceGuids, baseline, rootCount, previewCount);
            TestV5Structures(input, surfaceGuids, stairGuid, baseline, rootCount, previewCount);
            TestSelectedPropCatalog(surfaceGuids[1], baseline, rootCount, previewCount);
            Assert(!baseline.isDirty && baseline.rootCount == rootCount && EditorSceneManager.previewSceneCount == previewCount,
                "all failures leave scene and preview state unchanged");
            Write(input, valid);
            string report = "PASS Unity " + Application.unityVersion + " — " + assertions + " assertions; schema1/2 exact-transform compatibility, schema3 surface alignment, schema4 ceiling/bridge/cliff/wall fit/slope/light/fixtures/markers/wide-door fitting, nested prefabs, exact selected prefab catalog export, strict validation, no overwrite and clean active scene.";
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
        string output = BaekhoMapImporter.BuildFromPath(input, false);
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
        string output2 = BaekhoMapImporter.BuildFromPath(input, false);
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
        string output = BaekhoMapImporter.BuildFromPath(input, false);
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
        Reject(input, valid.Replace("\"schemaVersion\":3", "\"schemaVersion\":5"), "unsupported future schema");
        Reject(input, valid.Replace("\"cellSize\":2", "\"cellSize\":\"2\""), "schema3 string scalar");
        Assert(!baseline.isDirty && baseline.rootCount == rootCount && EditorSceneManager.previewSceneCount == previewCount,
            "schema3 success and bounds failures preserve active scene and close all previews");
    }

    private static string CreateLightFixture()
    {
        string path = AssetDatabase.GenerateUniqueAssetPath(Folder + "/LightOnly.prefab");
        var root = new GameObject("AuthoredLight");
        var light = root.AddComponent<Light>();
        light.type = LightType.Spot;
        light.intensity = 3.25f;
        light.range = 17;
        light.spotAngle = 42;
        light.color = new Color(0.2f, 0.4f, 0.8f);
        light.shadows = LightShadows.Soft;
        PrefabUtility.SaveAsPrefabAsset(root, path);
        UnityEngine.Object.DestroyImmediate(root);
        return AssetDatabase.AssetPathToGUID(path);
    }

    private static void TestV4Placement(string input, string[] guids, string stairGuid, string lightGuid,
        Scene baseline, int rootCount, int previewCount)
    {
        string[] fixtures = { "railing", "column", "arch", "water", "hazard", "trap", "gate", "switch",
            "secretDoor", "rest", "merchant", "altar", "decoration", "vegetation" };
        var entries = new System.Collections.Generic.List<string>
        {
            V4Placement("floor", "floor", guids[0], 2, "top", scaleY: 0.5f),
            V4Placement("ceiling", "ceiling", guids[3], 5, "bottom", scaleY: 2),
            V4Placement("bridge", "bridge", guids[0], 3, "top", scaleY: 0.4f),
            V4Placement("cliff", "cliff", guids[3], -4, "bottom", fitHeight: 6),
            V4Placement("wall", "wall", guids[0], 1, "bottom", fitHeight: 4.5f),
            V4Placement("legacy-wall", "wall", guids[0], 1, "bottom", scaleY: 3),
            V4Placement("slope", "slope", stairGuid, 2, "pivot", scaleY: 3),
            V4Placement("light", "light", lightGuid, 7, "pivot"),
            V4Placement("empty-pivot", "prop", guids[6], 9, "pivot"),
            Placement("default-ceiling", "ceiling", guids[0], "{\"x\":0,\"y\":6,\"z\":0}"),
            Placement("default-light", "light", lightGuid, "{\"x\":0,\"y\":8,\"z\":0}")
        };
        foreach (string role in fixtures)
        {
            string fixture = V4Placement(role, role, guids[0], 2, "pivot");
            if (role == "switch") fixture = fixture.Substring(0, fixture.Length - 1) + ",\"linkedId\":\"gate\"}";
            entries.Add(fixture);
        }
        string marker = Marker("enemy-1", "enemy", "units/guard");
        string teleport = Marker("teleport-1", "teleport", "", "{\"radius\":0.4,\"height\":2}");
        string valid = FeatureManifest(string.Join(",", entries), marker + "," + Marker("reward-1", "reward", "") + "," + Marker("event-1", "event", "events/entry") + "," + teleport);
        Write(input, valid);
        string output = BaekhoMapImporter.BuildFromPath(input, false);
        GameObject loaded = PrefabUtility.LoadPrefabContents(output);
        try
        {
            Assert(loaded.transform.childCount == entries.Count + 2, "v4 placements plus Connections and GameplayMarkers groups");
            string[] aligned = { "floor_floor", "ceiling_ceiling", "bridge_bridge", "cliff_cliff", "wall_wall", "wall_legacy-wall", "ceiling_default-ceiling" };
            float[] surfaces = { 2, 5, 3, -4, 1, 1, 6 };
            float[] heights = { 0.12f, 0.48f, 0.4f, 6, 4.5f, 3, 0.24f };
            for (int i = 0; i < aligned.Length; i++)
            {
                Transform child = loaded.transform.Find(aligned[i]);
                Bounds bounds = GeometryBounds(child);
                bool top = i == 0 || i == 2;
                Assert(Mathf.Abs((top ? bounds.max.y : bounds.min.y) - surfaces[i]) < 0.001f &&
                    Mathf.Abs(bounds.size.y - heights[i]) < 0.001f, "v4 measured surface and thickness/height: " + aligned[i]);
                Assert(PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(child.gameObject) != output,
                    "v4 original nested prefab reference: " + aligned[i]);
            }
            Transform slope = loaded.transform.Find("slope_slope");
            Assert(slope.localPosition.y == 2 && slope.localScale.y == 3 &&
                Mathf.Abs(slope.Find("Step3").TransformPoint(0, 0.5f, 0).y - 5) < 0.001f,
                "slope preserves low pivot and calibrated rise");
            foreach (string id in new[] { "light_light", "light_default-light" })
            {
                Transform child = loaded.transform.Find(id);
                Light light = child.GetComponent<Light>();
                Assert(child.localPosition.y == (id == "light_light" ? 7 : 8) && light.type == LightType.Spot &&
                    light.intensity == 3.25f && light.range == 17 && light.spotAngle == 42 &&
                    light.color == new Color(0.2f, 0.4f, 0.8f) && light.shadows == LightShadows.Soft &&
                    child.GetComponents<Component>().Length == 3 && child.GetComponent<BaekhoMapFixture>() != null,
                    "Light-only authored prefab settings preserved, with fixture metadata: " + id);
            }
            Assert(loaded.transform.Find("prop_empty-pivot").localPosition.y == 9, "pivot accepts geometry-free prefab");
            foreach (string role in fixtures)
            {
                Transform child = loaded.transform.Find(role + "_" + role);
                var fixture = child.GetComponent<BaekhoMapFixture>();
                Assert(child.localPosition.y == 2 && fixture.id == role && fixture.role == role &&
                    fixture.linkedId == (role == "switch" ? "gate" : ""),
                    "fixture role preserves explicit pivot and optional link metadata: " + role);
            }
            Assert(loaded.GetComponentsInChildren<BaekhoGameplayMarker>().Length == 4, "four marker kinds saved");
            foreach (string kind in new[] { "enemy", "reward", "event", "teleport" })
            {
                Transform child = loaded.transform.Find("GameplayMarkers/" + kind + "-1");
                BaekhoGameplayMarker data = child.GetComponent<BaekhoGameplayMarker>();
                Assert(child.localPosition == new Vector3(3, 2, 1) && child.localScale == Vector3.one &&
                    Quaternion.Angle(child.localRotation, Quaternion.Euler(0, 90, 0)) < 0.01f &&
                    child.GetComponents<Component>().Length == 2 && data.id == kind + "-1" &&
                    data.label == "게임 표식" && data.kind == kind &&
                    data.contentKey == (kind == "enemy" ? "units/guard" : kind == "event" ? "events/entry" : "") &&
                    data.clearanceRadius == (kind == "teleport" ? .4f : 0) &&
                    data.clearanceHeight == (kind == "teleport" ? 2 : 0),
                    "gameplay marker is metadata with raw position and rotation: " + kind);
            }
            Assert(loaded.transform.Find("Connections/east").GetComponent<BaekhoMapConnection>() != null,
                "v4 connection runtime component remains available");
        }
        finally { PrefabUtility.UnloadPrefabContents(loaded); }
        Write(input, valid);
        string repeat = BaekhoMapImporter.BuildFromPath(input, false);
        Assert(output != repeat && File.Exists(output), "v4 repeated import creates a new prefab");
        Write(input, FeatureManifest(V4Placement("floor", "floor", guids[0], 0, "top")));
        string emptyMarkers = BaekhoMapImporter.BuildFromPath(input, false);
        Assert(AssetDatabase.LoadAssetAtPath<GameObject>(emptyMarkers).transform.Find("GameplayMarkers").childCount == 0,
            "v4 empty marker array creates an empty metadata group");
        Reject(input, FeatureManifest(V4Placement("cliff", "cliff", guids[5], -4, "bottom", fitHeight: 6)), "zero-height cliff cannot be fitted");
        Reject(input, valid.Replace("\"surface\":\"top\"", "\"surface\":\"invalid\""), "unknown v4 surface");
        Reject(input, valid.Replace("\"fitHeight\":6", "\"fitHeight\":0"), "zero fit height");
        Reject(input, valid.Replace("\"fitHeight\":6", "\"fitHeight\":-2"), "negative fit height");
        Reject(input, valid.Replace("\"fitHeight\":6", "\"fitHeight\":\"6\""), "fit height is numeric");
        Reject(input, FeatureManifest(V4Placement("cliff", "cliff", guids[0], -4, "pivot", fitHeight: 6)), "fit height cannot use pivot");
        Reject(input, FeatureManifest(V4Placement("prop", "prop", guids[0], 0, "bottom", fitHeight: 6)), "fit height requires wall or cliff");
        Reject(input, FeatureManifest(V4Placement("light", "light", lightGuid, 7, "bottom")), "unmeasurable light requires pivot");
        Reject(input, FeatureManifest(V4Placement("light", "light", "", 7, "pivot")), "light must reference a prefab");
        Reject(input, FeatureManifest(V4Placement("floor", "floor", guids[0], 0, "top"), marker + "," + marker), "duplicate marker ids");
        Reject(input, valid.Replace("\"kind\":\"enemy\"", "\"kind\":\"spawn\""), "invalid gameplay marker kind");
        TestTeleportClearance(input, guids[0]);
        Reject(input, valid.Replace("\"linkedId\":\"gate\"", "\"linkedId\":\"missing-gate\""), "fixture link target must exist");
        Reject(input, valid.Replace("\"linkedId\":\"gate\"", "\"linkedId\":\"switch\""), "fixture cannot link to itself");
        Reject(input, valid.Replace("\"linkedId\":\"gate\"", "\"linkedId\":null"), "fixture link must be string");
        Reject(input, valid.Replace("\"contentKey\":\"units/guard\",", ""), "missing marker content key");
        Reject(input, valid.Replace("\"contentKey\":\"units/guard\"", "\"contentKey\":null"), "null marker content key");
        Reject(input, valid.Replace("\"contentKey\":\"units/guard\"", "\"contentKey\":\"bad\\nkey\""), "marker content key control character");
        Reject(input, valid.Replace("\"schemaVersion\":4", "\"schemaVersion\":3"), "v3 rejects v4 fields");
        Reject(input, SurfaceManifest(V4Placement("floor", "floor", guids[0], 0, "top")), "v3 rejects optional surface even without markers");
        Reject(input, FeatureManifest(Placement("floor", "floor", guids[0])).Replace(",\"markers\":[]", ""), "v4 requires markers array");
        Assert(!baseline.isDirty && baseline.rootCount == rootCount && EditorSceneManager.previewSceneCount == previewCount,
            "v4 success and failure preserve current scene and close isolated previews");
    }

    private static void TestTeleportClearance(string input, string floorGuid)
    {
        string teleport = Marker("teleport-1", "teleport", "", "{\"radius\":0.4,\"height\":2}");
        string teleportManifest = FeatureManifest(V4Placement("floor", "floor", floorGuid, 2, "top"), teleport);
        Write(input, FeatureManifest(V4Placement("floor", "floor", floorGuid, 2, "top"), teleport + "," + Marker("enemy-1", "enemy", "")));
        string positive = BaekhoMapImporter.BuildFromPath(input, false);
        GameObject loaded = PrefabUtility.LoadPrefabContents(positive);
        try
        {
            var landing = loaded.transform.Find("GameplayMarkers/teleport-1").GetComponent<BaekhoGameplayMarker>();
            Assert(landing.kind == "teleport" && landing.clearanceRadius == .4f && landing.clearanceHeight == 2 &&
                landing.transform.localPosition == new Vector3(3, 2, 1) && landing.transform.localScale == Vector3.one &&
                Quaternion.Angle(landing.transform.localRotation, Quaternion.Euler(0, 90, 0)) < .01f &&
                landing.GetComponents<Component>().Length == 2, "teleport floor pose and body clearance survive prefab serialization without game logic");
            var enemy = loaded.transform.Find("GameplayMarkers/enemy-1").GetComponent<BaekhoGameplayMarker>();
            Assert(enemy.clearanceRadius == 0 && enemy.clearanceHeight == 0, "legacy markers retain empty clearance defaults");
        }
        finally { PrefabUtility.UnloadPrefabContents(loaded); }
        Reject(input, teleportManifest.Replace(",\"clearance\":{\"radius\":0.4,\"height\":2}", ""), "teleport requires clearance metadata");
        Reject(input, teleportManifest.Replace("{\"radius\":0.4,\"height\":2}", "null"), "teleport clearance cannot be null");
        Reject(input, teleportManifest.Replace("\"radius\":0.4", "\"radius\":0.09"), "teleport radius below minimum");
        Reject(input, teleportManifest.Replace("\"radius\":0.4", "\"radius\":5.01"), "teleport radius above maximum");
        Reject(input, teleportManifest.Replace("\"height\":2}", "\"height\":0.24}"), "teleport height below minimum");
        Reject(input, teleportManifest.Replace("\"height\":2}", "\"height\":20.01}"), "teleport height above maximum");
        Reject(input, teleportManifest.Replace("\"radius\":0.4,", ""), "teleport clearance requires radius");
        Reject(input, teleportManifest.Replace(",\"height\":2}", "}"), "teleport clearance requires height");
        Reject(input, teleportManifest.Replace("\"radius\":0.4", "\"radius\":\"0.4\""), "teleport clearance radius is numeric");
        Reject(input, teleportManifest.Replace("\"radius\":0.4", "\"radius\":0.4,\"radius\":0.4"), "teleport clearance rejects duplicate dimension");
        Reject(input, teleportManifest.Replace("\"radius\":0.4", "\"radius\":0.4,\"depth\":1"), "teleport clearance rejects unknown dimension");
        Reject(input, teleportManifest.Replace("\"kind\":\"teleport\"", "\"kind\":\"event\""), "ordinary markers cannot contain teleport clearance");
        foreach (string clearance in new[] { "{\"radius\":0.1,\"height\":0.25}", "{\"radius\":5,\"height\":20}" })
        {
            Write(input, teleportManifest.Replace("{\"radius\":0.4,\"height\":2}", clearance));
            string boundary = BaekhoMapImporter.BuildFromPath(input, false);
            Assert(AssetDatabase.LoadAssetAtPath<GameObject>(boundary).GetComponentsInChildren<BaekhoGameplayMarker>().Length == 1,
                "teleport clearance inclusive bounds accepted: " + clearance);
        }
    }

    private static void TestWideDoors(string input, string[] guids, Scene baseline, int rootCount, int previewCount)
    {
        var entries = new System.Collections.Generic.List<string>();
        foreach (int yaw in new[] { 0, 90, 180, 270 })
        {
            string entry = Placement("wide-" + yaw, "door", guids[3], "{\"x\":10,\"y\":2,\"z\":1}",
                "{\"x\":0,\"y\":" + yaw + ",\"z\":0}", "{\"x\":9,\"y\":2,\"z\":0.3}");
            entries.Add(entry.Substring(0, entry.Length - 1) + ",\"surface\":\"bottom\",\"fitWidth\":5.5}");
        }
        string valid = FeatureManifest(string.Join(",", entries)).Replace("\"width\":1.5", "\"width\":5.5");
        Write(input, valid);
        string output = BaekhoMapImporter.BuildFromPath(input, false);
        GameObject loaded = PrefabUtility.LoadPrefabContents(output);
        try
        {
            foreach (int yaw in new[] { 0, 90, 180, 270 })
            {
                Transform child = loaded.transform.Find("door_wide-" + yaw);
                Bounds bounds = GeometryBounds(child);
                bool acrossX = yaw % 180 == 0;
                Assert(Mathf.Abs((acrossX ? bounds.size.x : bounds.size.z) - 5.5f) < 0.001f &&
                    Mathf.Abs((acrossX ? bounds.center.x - 10 : bounds.center.z - 1)) < 0.001f && Mathf.Abs(bounds.min.y - 2) < 0.001f,
                    "wide door fits and centers nested off-axis geometry in direction " + yaw);
                Assert(child.localScale.y == 2 && child.localScale.z == 0.3f &&
                    PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(child.gameObject) != output,
                    "wide door preserves Y/Z scales and source reference in direction " + yaw);
            }
            Assert(loaded.transform.Find("Connections/east").GetComponent<BaekhoMapConnection>().width == 5.5f,
                "v4 connection width may exceed cellSize and keeps raw metadata");
        }
        finally { PrefabUtility.UnloadPrefabContents(loaded); }
        Reject(input, valid.Replace("\"fitWidth\":5.5", "\"fitWidth\":0"), "zero door fitted width");
        Reject(input, valid.Replace("\"fitWidth\":5.5", "\"fitWidth\":40.01"), "door fitted width above maximum");
        Reject(input, valid.Replace("\"role\":\"door\"", "\"role\":\"prop\""), "fitted width requires door role");
        Reject(input, valid.Replace("\"surface\":\"bottom\"", "\"surface\":\"pivot\""), "fitted door requires bottom alignment");
        Reject(input, valid.Replace("\"width\":5.5", "\"width\":40.01"), "v4 connection width above maximum");
        Reject(input, valid.Replace("\"schemaVersion\":4", "\"schemaVersion\":3"), "old schema refuses width fitting");
        Assert(!baseline.isDirty && baseline.rootCount == rootCount && EditorSceneManager.previewSceneCount == previewCount,
            "wide-door imports preserve active scene and close previews");
    }

    private static void TestV5Structures(string input, string[] guids, string stairGuid, Scene baseline, int rootCount, int previewCount)
    {
        string zonePath = AssetDatabase.GenerateUniqueAssetPath(Folder + "/TriggerZone.prefab");
        var zone = new GameObject("AuthoredDeadzone");
        var child = new GameObject("OffCenterTrigger"); child.transform.SetParent(zone.transform, false);
        child.transform.localPosition = new Vector3(3, -2, 5);
        var box = child.AddComponent<BoxCollider>(); box.isTrigger = true; box.size = new Vector3(2, 4, 6);
        box.center = new Vector3(1, .5f, -1);
        var body = zone.AddComponent<Rigidbody>(); body.isKinematic = true; body.useGravity = false;
        PrefabUtility.SaveAsPrefabAsset(zone, zonePath);
        UnityEngine.Object.DestroyImmediate(zone);
        string zoneGuid = AssetDatabase.AssetPathToGUID(zonePath);
        string measuredPath = AssetDatabase.GenerateUniqueAssetPath(Folder + "/MeasuredProp.prefab");
        var measuredRoot = new GameObject("OffCenterMeasuredProp");
        var visual = GameObject.CreatePrimitive(PrimitiveType.Cube); visual.transform.SetParent(measuredRoot.transform, false);
        visual.transform.localPosition = new Vector3(3, 2, -4); visual.transform.localScale = new Vector3(2, 2, 2);
        var interaction = measuredRoot.AddComponent<BoxCollider>(); interaction.isTrigger = true;
        interaction.center = new Vector3(7, 1, 2); interaction.size = new Vector3(2, 4, 6);
        Vector3 nativePropSize = GeometryBounds(measuredRoot.transform, true).size;
        PrefabUtility.SaveAsPrefabAsset(measuredRoot, measuredPath); UnityEngine.Object.DestroyImmediate(measuredRoot);
        string measuredGuid = AssetDatabase.AssetPathToGUID(measuredPath);
        string centeredStairPath = AssetDatabase.GenerateUniqueAssetPath(Folder + "/CenteredStair.prefab");
        var centeredStairRoot = new GameObject("CenteredPivotStair");
        var nestedSteps = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(AssetDatabase.GUIDToAssetPath(stairGuid)));
        nestedSteps.transform.SetParent(centeredStairRoot.transform, false);
        nestedSteps.transform.localPosition = new Vector3(2, -.5f, -3);
        var stairTrigger = centeredStairRoot.AddComponent<BoxCollider>(); stairTrigger.isTrigger = true;
        stairTrigger.center = new Vector3(100, -100, 100); stairTrigger.size = new Vector3(80, 80, 80);
        PrefabUtility.SaveAsPrefabAsset(centeredStairRoot, centeredStairPath); UnityEngine.Object.DestroyImmediate(centeredStairRoot);
        string centeredStairGuid = AssetDatabase.AssetPathToGUID(centeredStairPath);
        // Creating the fixture above legitimately touched the isolated baseline; reset test baseline.
        EditorSceneManager.SaveScene(baseline, Folder + "/Baseline.unity");
        Func<string, string, string, int, string> entry = (id, role, guid, yaw) =>
        {
            string json = Placement(id, role, guid, "{\"x\":10,\"y\":-4,\"z\":7}", "{\"x\":0,\"y\":" + yaw + ",\"z\":0}", "{\"x\":9,\"y\":8,\"z\":7}");
            return json.Substring(0, json.Length - 1) + ",\"surface\":\"pivot\",\"fitSize\":{\"x\":5,\"y\":1,\"z\":3}}";
        };
        string prop = Placement("measured", "prop", measuredGuid, "{\"x\":10,\"y\":2,\"z\":7}", "{\"x\":0,\"y\":90,\"z\":0}", "{\"x\":2,\"y\":1.5,\"z\":0.5}");
        prop = prop.Substring(0, prop.Length - 1) + ",\"surface\":\"bottom\",\"centerXZ\":true}";
        string decoration = prop.Replace("\"id\":\"measured\"", "\"id\":\"measured-decoration\"").Replace("\"role\":\"prop\"", "\"role\":\"decoration\"");
        string vegetation = prop.Replace("\"id\":\"measured\"", "\"id\":\"measured-vegetation\"").Replace("\"role\":\"prop\"", "\"role\":\"vegetation\"");
        string valid = FeatureManifest(entry("solid", "wall", guids[3], 90) + "," + entry("trigger", "deadzone", zoneGuid, 0) + "," + prop + "," + decoration + "," + vegetation).Replace("\"schemaVersion\":4", "\"schemaVersion\":5");
        Write(input, valid);
        string output = BaekhoMapImporter.BuildFromPath(input, false);
        GameObject loaded = PrefabUtility.LoadPrefabContents(output);
        try
        {
            Transform solid = loaded.transform.Find("wall_solid"); Bounds actual = GeometryBounds(solid);
            Assert((actual.size - new Vector3(3, 1, 5)).magnitude < .001f && (actual.center - new Vector3(10, -4, 7)).magnitude < .001f,
                "v5 atomically fits three dimensions and centers off-axis nested geometry before yaw");
            Transform trigger = loaded.transform.Find("deadzone_trigger"); BoxCollider collider = trigger.GetComponentInChildren<BoxCollider>();
            Vector3 center = collider.transform.TransformPoint(collider.center);
            Vector3 size = Vector3.Scale(collider.size, collider.transform.lossyScale);
            Assert((center - new Vector3(10, -4, 7)).magnitude < .001f && (size - new Vector3(5, 1, 3)).magnitude < .001f,
                "v5 collider-only trigger deadzone is sized and centered on all axes");
            Assert(collider.isTrigger && trigger.GetComponent<Rigidbody>().isKinematic && !trigger.GetComponent<Rigidbody>().useGravity &&
                trigger.GetComponents<Component>().Length == 2 && collider.GetComponents<Component>().Length == 2,
                "deadzone preserves authored components and gameplay behavior without adding components");
            Assert(PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(trigger.gameObject) == zonePath,
                "deadzone keeps original nested prefab reference");
            Vector3 expectedSize = new Vector3(nativePropSize.z * .5f, nativePropSize.y * 1.5f, nativePropSize.x * 2);
            foreach (string name in new[] { "prop_measured", "decoration_measured-decoration", "vegetation_measured-vegetation" })
            {
                Transform placedProp = loaded.transform.Find(name); Bounds propBounds = GeometryBounds(placedProp, true);
                Assert((propBounds.size - expectedSize).magnitude < .001f && Mathf.Abs(propBounds.center.x - 10) < .001f && Mathf.Abs(propBounds.center.z - 7) < .001f && Mathf.Abs(propBounds.min.y - 2) < .001f,
                    "v5 measured placement centers renderer+trigger union and aligns envelope bottom with off-center pivots: " + name);
                Assert(placedProp.localScale == new Vector3(2, 1.5f, .5f) && placedProp.GetComponent<BoxCollider>().isTrigger &&
                    PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(placedProp.gameObject) == measuredPath,
                    "measured placement retains original size, trigger and prefab references: " + name);
            }
        }
        finally { PrefabUtility.UnloadPrefabContents(loaded); }
        Reject(input, valid.Replace("\"schemaVersion\":5", "\"schemaVersion\":4"), "v4 rejects fitSize");
        Reject(input, valid.Replace("\"x\":5,\"y\":1,\"z\":3", "\"x\":0,\"y\":1,\"z\":3"), "fitSize requires positive axes");
        Reject(input, valid.Replace("\"surface\":\"pivot\"", "\"surface\":\"bottom\""), "fitSize has center semantics only");
        Reject(input, valid.Replace("\"role\":\"wall\"", "\"role\":\"prop\""), "auto fitting cannot silently resize props");
        Reject(input, valid.Replace("\"fitSize\":", "\"fitHeight\":2,\"fitSize\":"), "size fit cannot mix height fitting");
        Reject(input, valid.Replace(zoneGuid, guids[6]), "deadzone must have a measurable collider");
        Reject(input, valid.Replace(guids[3], guids[5]), "flat source cannot be fit to solid XYZ extent");
        Reject(input, valid.Replace("\"centerXZ\":true", "\"centerXZ\":false"), "centerXZ cannot be explicitly false");
        Reject(input, valid.Replace("\"centerXZ\":true", "\"centerXZ\":1"), "centerXZ must be boolean");
        Reject(input, valid.Replace("\"role\":\"prop\"", "\"role\":\"wall\""), "centerXZ is restricted to measured props, decorations and vegetation");
        Reject(input, valid.Replace("\"surface\":\"bottom\"", "\"surface\":\"pivot\""), "centerXZ requires bottom surface");
        Reject(input, valid.Replace("\"centerXZ\":true", "\"centerXZ\":true,\"fitHeight\":2"), "centerXZ cannot resize measured props");
        string bottomStair = Placement("bottom-stair", "stair", centeredStairGuid, "{\"x\":4,\"y\":3,\"z\":5}", "{\"x\":0,\"y\":90,\"z\":0}", "{\"x\":2,\"y\":2,\"z\":2}");
        bottomStair = bottomStair.Substring(0, bottomStair.Length - 1) + ",\"surface\":\"bottom\"}";
        string pivotStair = bottomStair.Replace("bottom-stair", "old-pivot-stair").Replace("\"surface\":\"bottom\"", "\"surface\":\"pivot\"");
        string slope = bottomStair.Replace("bottom-stair", "bottom-slope").Replace("\"role\":\"stair\"", "\"role\":\"slope\"");
        Write(input, FeatureManifest(bottomStair + "," + pivotStair + "," + slope));
        string stairOutput = BaekhoMapImporter.BuildFromPath(input, false); GameObject stairs = PrefabUtility.LoadPrefabContents(stairOutput);
        try
        {
            foreach (string name in new[] { "stair_bottom-stair", "slope_bottom-slope" })
            {
                Transform placed = stairs.transform.Find(name); Bounds bounds = GeometryBounds(placed);
                Assert(Mathf.Abs(bounds.min.y - 3) < .001f && Mathf.Abs(bounds.max.y - 5) < .001f && Mathf.Abs(bounds.center.x - 4) < .001f && Mathf.Abs(bounds.center.z - 5) < .001f,
                    "bottom-centered stair/slope aligns support base and calibrated high landing despite centered/off-axis pivots: " + name);
                Assert(placed.localScale == new Vector3(2, 2, 2) && placed.GetComponent<BoxCollider>().isTrigger && PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(placed.GetChild(0).gameObject) == AssetDatabase.GUIDToAssetPath(stairGuid),
                    "stairs preserve calibrated rise, nested source and unrelated interaction trigger: " + name);
            }
            Assert(stairs.transform.Find("stair_old-pivot-stair").localPosition == new Vector3(4, 3, 5), "old explicit pivot stair import remains unchanged");
        }
        finally { PrefabUtility.UnloadPrefabContents(stairs); }
        Reject(input, FeatureManifest(bottomStair.Replace("\"x\":0,\"y\":90", "\"x\":10,\"y\":90")), "bottom stair does not accept X/Z tilt");
        string catalog = Path.GetFullPath("../prop-catalog-validation.json");
        int count = BaekhoPropCatalog.ExportToPath(catalog, new[] { zoneGuid, guids[0], zoneGuid, guids[6], measuredGuid });
        string data = File.ReadAllText(catalog);
        Assert(count == 3 && data.Contains(zoneGuid) && data.Contains(guids[0]) && !data.Contains(guids[6]) && data.Contains(measuredGuid),
            "bounds export includes collider-only triggers, deduplicates ids and skips unmeasurable prefabs");
        Assert(!baseline.isDirty && baseline.rootCount == rootCount && EditorSceneManager.previewSceneCount == previewCount,
            "v5 and catalog export preserve active scene and close isolated previews");
    }

    private static void TestSelectedPropCatalog(string sourceGuid, Scene baseline, int rootCount, int previewCount)
    {
        string folder = AssetDatabase.GenerateUniqueAssetPath(Folder + "/SelectedCatalog");
        AssetDatabase.CreateFolder(Folder, Path.GetFileName(folder));
        AssetDatabase.CreateFolder(folder, "UnselectedNested");
        string nestedFolder = folder + "/UnselectedNested";
        var selected = new UnityEngine.Object[11];
        var expected = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var unselected = new List<string>();
        UnityEngine.Object[] previousSelection = Selection.objects;
        Scene preview = EditorSceneManager.NewPreviewScene();
        try
        {
            for (int index = 0; index < 14; index++)
            {
                string path = (index < 11 ? folder : nestedFolder) + "/Prop" + index + ".prefab";
                Assert(AssetDatabase.CopyAsset(AssetDatabase.GUIDToAssetPath(sourceGuid), path), "creates isolated catalog fixture: " + path);
                GameObject asset = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                string guid = AssetDatabase.AssetPathToGUID(path);
                if (index < 11) { selected[index] = asset; expected.Add(guid); }
                else unselected.Add(guid);
            }
            Assert(AssetDatabase.FindAssets("t:Prefab", new[] { Folder }).Length > 11,
                "catalog regression has additional project and nested folder prefabs beyond eleven selected assets");
            Selection.objects = selected;
            string[] resolved = BaekhoPropCatalog.ResolveSelectedPrefabGuids(Selection.objects);
            Assert(resolved.Length == 11 && expected.SetEquals(resolved),
                "Project selection resolves exactly the eleven selected prefab assets");
            string[] sorted = (string[])resolved.Clone(); Array.Sort(sorted, StringComparer.Ordinal);
            Assert(string.Join(",", resolved) == string.Join(",", sorted), "selected catalog GUID order is deterministic");
            var reversedWithDuplicates = new List<UnityEngine.Object>(selected); reversedWithDuplicates.Reverse();
            reversedWithDuplicates.Add(selected[0]); reversedWithDuplicates.Add(selected[10]);
            Assert(string.Join(",", BaekhoPropCatalog.ResolveSelectedPrefabGuids(reversedWithDuplicates.ToArray())) == string.Join(",", resolved),
                "reordered and duplicate prefab selections keep the same exact catalog");
            string output = Path.GetFullPath("../prop-catalog-selected-validation.json");
            int count = BaekhoPropCatalog.ExportToPath(output, resolved);
            var catalog = JsonUtility.FromJson<BoundsCatalog>(File.ReadAllText(output));
            var actual = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (BoundsCatalogEntry entry in catalog.assets)
            {
                actual.Add(entry.guid);
                Assert(entry.size == Vector3.one,
                    "selected catalog preserves each measured prefab size: " + entry.guid);
            }
            Assert(count == 11 && catalog.version == 2 && catalog.assets.Length == 11 && expected.SetEquals(actual),
                "exported JSON contains exactly eleven selected GUIDs with no other project prefabs");
            foreach (string guid in unselected) Assert(!actual.Contains(guid), "nested unselected prefab is absent from catalog: " + guid);

            UnityEngine.Object folderAsset = AssetDatabase.LoadMainAssetAtPath(folder);
            UnityEngine.Object nestedFolderAsset = AssetDatabase.LoadMainAssetAtPath(nestedFolder);
            var sceneInstance = (GameObject)PrefabUtility.InstantiatePrefab((GameObject)selected[0], preview);
            string unrelatedPath = folder + "/Unrelated.txt";
            Write(unrelatedPath, "not a prefab");
            AssetDatabase.ImportAsset(unrelatedPath);
            UnityEngine.Object unrelated = AssetDatabase.LoadAssetAtPath<TextAsset>(unrelatedPath);
            Assert(unrelated != null, "non-prefab catalog selection fixture is an actual imported text asset");
            RejectPropSelection(null, "null selection");
            RejectPropSelection(new UnityEngine.Object[0], "empty selection");
            RejectPropSelection(new UnityEngine.Object[] { null }, "missing selected object");
            RejectPropSelection(new[] { folderAsset }, "folder selection does not recursively export");
            RejectPropSelection(new[] { nestedFolderAsset }, "nested folder selection does not recursively export");
            RejectPropSelection(new UnityEngine.Object[] { sceneInstance }, "scene prefab instance does not export its source or all project assets");
            RejectPropSelection(new[] { unrelated }, "unrelated asset does not trigger project export");
            RejectPropSelection(new[] { selected[0], folderAsset }, "mixed prefab and folder selection is rejected explicitly");
            RejectPropSelection(new[] { selected[0], unrelated }, "mixed prefab and unrelated asset selection is rejected explicitly");
            RejectPropSelection(new UnityEngine.Object[] { ((GameObject)selected[0]).transform.GetChild(0).gameObject },
                "nested prefab child cannot stand in for an explicitly selected root prefab asset");
            UnityEngine.Object.DestroyImmediate(sceneInstance);
        }
        finally
        {
            Selection.objects = previousSelection;
            EditorSceneManager.ClosePreviewScene(preview);
        }
        Assert(!baseline.isDirty && baseline.rootCount == rootCount && SceneManager.GetActiveScene() == baseline &&
            EditorSceneManager.previewSceneCount == previewCount, "selected catalog resolution and export preserve scene and close preview");
    }

    private static void RejectPropSelection(UnityEngine.Object[] selection, string label)
    {
        bool rejected = false;
        try { BaekhoPropCatalog.ResolveSelectedPrefabGuids(selection); }
        catch (InvalidOperationException exception) { rejected = exception.Message.Contains("Project") && exception.Message.Contains(".prefab"); }
        Assert(rejected, label + " gives instructions to select prefab assets in Project");
    }

    private static string Marker(string id, string kind, string contentKey, string clearance = null)
    {
        return "{\"id\":\"" + id + "\",\"label\":\"게임 표식\",\"kind\":\"" + kind + "\",\"contentKey\":\"" + contentKey +
            "\",\"position\":{\"x\":3,\"y\":2,\"z\":1},\"rotation\":{\"x\":0,\"y\":90,\"z\":0}" +
            (clearance == null ? "" : ",\"clearance\":" + clearance) + "}";
    }

    private static string V4Placement(string id, string role, string guid, float y, string surface, float scaleY = 1, float fitHeight = 0)
    {
        var culture = System.Globalization.CultureInfo.InvariantCulture;
        string entry = Placement(id, role, guid, "{\"x\":0,\"y\":" + y.ToString(culture) + ",\"z\":0}",
            scale: "{\"x\":1,\"y\":" + scaleY.ToString(culture) + ",\"z\":1}");
        return entry.Substring(0, entry.Length - 1) + ",\"surface\":\"" + surface + "\"" +
            (fitHeight == 0 ? "" : ",\"fitHeight\":" + fitHeight.ToString(culture)) + "}";
    }

    private static string FeatureManifest(string placements, string markers = "")
    {
        string entry = SurfaceManifest(placements).Replace("\"schemaVersion\":3", "\"schemaVersion\":4");
        return entry.Substring(0, entry.Length - 1) + ",\"markers\":[" + markers + "]}";
    }

    private static string SurfaceManifest(string placements)
    {
        return "{\"schemaVersion\":3,\"name\":\"표면 정렬\",\"width\":16,\"height\":8,\"cellSize\":2,\"placements\":[" + placements +
            "],\"connections\":[" + Connection("east", "동쪽 문", "{\"x\":2,\"y\":2,\"z\":1}", 90) + "]}";
    }

    // Check actual fixture vertices independently of the importer's mesh-box projection.
    private static Bounds GeometryBounds(Transform root, bool unionTriggers = false)
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
        if (!found || unionTriggers)
            foreach (BoxCollider box in root.GetComponentsInChildren<BoxCollider>(true))
            {
                if (!box.enabled || (!unionTriggers && box.isTrigger) || !ActiveWithin(box.transform, root)) continue;
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
        try { BaekhoMapImporter.BuildFromPath(path, false); }
        catch (InvalidDataException) { rejected = true; }
        Assert(rejected && Directory.GetFiles(Folder, "*.prefab").Length == before, "reject " + label + " without saving");
    }
}
