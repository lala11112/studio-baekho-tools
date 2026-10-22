// Isolated real-Editor checks for v2 catalog metadata and pivot-exact wall fixture imports.
// Copy into .local/unity-validation/Assets/Editor and run BaekhoWallMountSmoke.Run.
using System;
using System.Collections.Generic;
using System.IO;
using StudioBaekho;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

public static class BaekhoWallMountSmoke
{
    private const string Folder = "Assets/BaekhoWallValidation";
    private static int assertions;
    [Serializable] private sealed class Catalog { public int version; public Entry[] assets; }
    [Serializable] private sealed class LocalBounds { public Vector3 center; public Vector3 size; }
    [Serializable] private sealed class Connector { public Vector3 position; public Vector3 direction; }
    [Serializable] private sealed class WallMount
    {
        public string kind; public string family; public string[] sites; public string heightMode;
        public float height; public float spacing; public float probability; public string doorSide;
        public Connector[] mounts; public Connector[] sockets; public LocalBounds[] collisionBoxes;
    }
    [Serializable] private sealed class Entry { public string guid; public Vector3 size; public LocalBounds bounds; public WallMount wallMount; }
    [Serializable] private sealed class GeneratedCases { public GeneratedCase[] cases; }
    [Serializable] private sealed class GeneratedCase { public string manifest; public GeometryCheck[] checks; public Vector3[] clearPoints; }
    [Serializable] private sealed class GeometryCheck
    {
        public string objectName; public bool checkGeometry; public bool checkGeometryRange; public float minY; public float maxY;
        public bool checkPivot; public Vector3 position; public bool nativeScale;
        public bool checkSockets; public float socketMin; public float socketMax;
    }

    public static void Run()
    {
        try
        {
            if (!Application.dataPath.Replace('\\', '/').EndsWith("/.local/unity-validation/Assets", StringComparison.Ordinal))
                throw new InvalidOperationException("Wall tests may only run in .local/unity-validation.");
            if (!AssetDatabase.IsValidFolder(Folder)) AssetDatabase.CreateFolder("Assets", "BaekhoWallValidation");
            Scene active = SceneManager.GetActiveScene(); int roots = active.rootCount; bool dirty = active.isDirty;
            int previews = EditorSceneManager.previewSceneCount;
            Scene preview = EditorSceneManager.NewPreviewScene();
            var guids = new List<string>();
            var paths = new List<string>();
            try
            {
                paths.Add(Save(Straight(preview, 1), "Pipe1"));
                paths.Add(Save(Straight(preview, 2), "Pipe2"));
                paths.Add(Save(Corner(preview, false), "Inner"));
                paths.Add(Save(Corner(preview, true), "Outer"));
                paths.Add(Save(Cap(preview), "Cap"));
                paths.Add(Save(Light(preview), "DoorLight"));
                GameObject legacy = Root(preview, "Legacy");
                AddBox(legacy, new Vector3(-2, 1, 3), new Vector3(1, 2, 3));
                paths.Add(Save(legacy, "Legacy"));
                paths.Add(Save(CornerLight(preview), "CornerLight"));
                paths.Add(Save(Junction(preview, false), "Elbow"));
                paths.Add(Save(Junction(preview, true), "Tee"));
                var terrainGuids = new List<string>();
                foreach (string name in new[] { "TerrainFloor", "TerrainWall", "TerrainDoor" })
                {
                    GameObject terrain = Root(preview, name);
                    AddBox(terrain, new Vector3(0, .5f, 0), Vector3.one);
                    terrainGuids.Add(AssetDatabase.AssetPathToGUID(Save(terrain, name)));
                }
                File.WriteAllText(Path.GetFullPath("../wall-terrain-validation.json"),
                    "{\"floor\":\"" + terrainGuids[0] + "\",\"wall\":\"" + terrainGuids[1] + "\",\"door\":\"" + terrainGuids[2] + "\"}");
                foreach (string path in paths) guids.Add(AssetDatabase.AssetPathToGUID(path));
                var originals = new List<string>();
                foreach (string path in paths) originals.Add(File.ReadAllText(path));
                string output = Path.GetFullPath("../wall-catalog-validation.json");
                Assert(BaekhoPropCatalog.ExportToPath(output, guids.ToArray()) == 10, "exports exactly the ten selected wall and legacy prefabs");
                string json = File.ReadAllText(output);
                var catalog = JsonUtility.FromJson<Catalog>(json);
                Assert(catalog.version == 2 && catalog.assets.Length == 10, "catalog uses version 2 with all entries");
                Assert((int)BaekhoWallModule.ModuleKind.EndCap == 4 && (int)BaekhoWallModule.ModuleKind.Elbow == 5 && (int)BaekhoWallModule.ModuleKind.Tee == 6,
                    "new junction enum values preserve existing serialized kinds");
                Entry pipe = catalog.assets[0];
                Near(pipe.bounds.center, new Vector3(2.5f, .25f, -1.2f), "arbitrary source pivot retained in bounds centre");
                Near(pipe.size, new Vector3(1, .1f, .1f), "legacy size field retained at native root scale one");
                Assert(pipe.wallMount.kind == "straight" && pipe.wallMount.family == "FactoryPipe100" && pipe.wallMount.heightMode == "top" && pipe.wallMount.height == .5f,
                    "kind, family and height exported with application enum strings");
                Near(pipe.wallMount.mounts[0].position, new Vector3(2.5f, .25f, -1.3f), "mount uses root-local position");
                Near(pipe.wallMount.mounts[0].direction, Vector3.forward, "mount blue axis points into room");
                Near(pipe.wallMount.sockets[0].direction, Vector3.left, "left socket faces out along wall");
                Near(pipe.wallMount.sockets[1].direction, Vector3.right, "right socket faces out along wall");
                Assert(Mathf.Abs(Vector3.Distance(pipe.wallMount.sockets[0].position, pipe.wallMount.sockets[1].position) - 1) < .001f,
                    "one-metre connection length uses socket distance");
                Assert(Mathf.Abs(Vector3.Distance(catalog.assets[1].wallMount.sockets[0].position, catalog.assets[1].wallMount.sockets[1].position) - 2) < .001f,
                    "two-metre variant retains native length");
                Assert(catalog.assets[2].wallMount.kind == "innerCorner" && catalog.assets[3].wallMount.kind == "outerCorner" &&
                    catalog.assets[2].wallMount.mounts.Length == 2 && catalog.assets[2].wallMount.collisionBoxes.Length == 2,
                    "both corner types have two wall normals and compound collision boxes");
                Assert(catalog.assets[4].wallMount.kind == "endCap" && catalog.assets[4].wallMount.mounts.Length == 0 && catalog.assets[4].wallMount.sockets.Length == 1,
                    "symmetric cap supports either end without a mount normal");
                Assert(catalog.assets[5].wallMount.kind == "single" && catalog.assets[5].wallMount.sites[0] == "doorTop" && catalog.assets[5].wallMount.sockets.Length == 0,
                    "light-only door fixture exports explicit occupancy without requiring geometry");
                // A genuinely missing optional field keeps v2 ordinary props compatible.
                int legacyStart = json.IndexOf(guids[6], StringComparison.Ordinal), cornerStart = json.IndexOf(guids[7], StringComparison.Ordinal);
                string legacyEntry = json.Substring(legacyStart, cornerStart - legacyStart);
                Assert(legacyEntry.IndexOf("wallMount", StringComparison.Ordinal) < 0, "ordinary selected prefab omits optional wallMount metadata");
                Near(catalog.assets[6].bounds.center, new Vector3(-2, 1, 3), "ordinary v2 props gain root-local bounds centre");
                Assert(catalog.assets[7].wallMount.kind == "single" && catalog.assets[7].wallMount.sites[0] == "corner" &&
                    catalog.assets[7].wallMount.mounts.Length == 2 && catalog.assets[7].wallMount.sockets.Length == 0,
                    "single corner fixture has two wall mounts and no pipe sockets");
                Entry elbow = catalog.assets[8], tee = catalog.assets[9];
                Assert(elbow.wallMount.kind == "elbow" && elbow.wallMount.mounts.Length == 1 && elbow.wallMount.sockets.Length == 2 && elbow.wallMount.collisionBoxes.Length == 2,
                    "flat-wall elbow exports horizontal and vertical arms with two occupancy boxes");
                Assert(tee.wallMount.kind == "tee" && tee.wallMount.mounts.Length == 1 && tee.wallMount.sockets.Length == 3 && tee.wallMount.collisionBoxes.Length == 3,
                    "flat-wall tee exports three arms and three occupancy boxes");
                Near(elbow.wallMount.mounts[0].position, JunctionOffset(false), "elbow retains arbitrary root-local mount pivot");
                Near(tee.wallMount.mounts[0].position, JunctionOffset(true), "tee retains arbitrary root-local mount pivot");
                Near(elbow.wallMount.sockets[1].direction, Vector3.down, "elbow vertical socket exports its native down direction");
                Near(tee.wallMount.sockets[2].direction, Vector3.down, "tee third socket exports its native down direction");
                Near(elbow.wallMount.sockets[0].position, JunctionOffset(false) + new Vector3(-.5f, 0, .1f), "off-pivot elbow socket retains one-metre footprint");
                Near(tee.wallMount.sockets[1].position, JunctionOffset(true) + new Vector3(.5f, 0, .1f), "off-pivot tee socket retains one-metre footprint");
                for (int index = 0; index < paths.Count; index++) Assert(File.ReadAllText(paths[index]) == originals[index], "catalog did not modify source prefab " + paths[index]);

                TestPivotImport(guids[0], guids[5], guids[8], guids[9], elbow.bounds, tee.bounds);
                TestInvalidModules(preview, output);
            }
            finally { EditorSceneManager.ClosePreviewScene(preview); }
            Assert(SceneManager.GetActiveScene() == active && active.rootCount == roots && active.isDirty == dirty && EditorSceneManager.previewSceneCount == previews,
                "success and failures preserve the user's active scene and close all previews");
            string result = "BAEKHO_WALL_MOUNT_PASS " + assertions + " assertions";
            File.WriteAllText(Path.GetFullPath("../wall-validation-result.txt"), result);
            Debug.Log(result);
            EditorApplication.Exit(0);
        }
        catch (Exception exception) { Debug.LogException(exception); EditorApplication.Exit(1); }
    }

    // Second pass consumes real manifests generated by the application's TypeScript exporter.
    public static void RunGeneratedManifest()
    {
        try
        {
            if (!Application.dataPath.Replace('\\', '/').EndsWith("/.local/unity-validation/Assets", StringComparison.Ordinal))
                throw new InvalidOperationException("Wall tests may only run in .local/unity-validation.");
            var input = JsonUtility.FromJson<GeneratedCases>(File.ReadAllText(Path.GetFullPath("../wall-generated-expectations.json")));
            Assert(input != null && input.cases != null && input.cases.Length >= 7, "app generated fixed, random, vertical and four doorway scenarios");
            foreach (GeneratedCase scenario in input.cases)
            {
                AssetDatabase.ImportAsset(scenario.manifest);
                string path = BaekhoMapImporter.BuildFromPath(scenario.manifest, false);
                GameObject built = PrefabUtility.LoadPrefabContents(path);
                try
                {
                    foreach (GeometryCheck check in scenario.checks)
                    {
                        Transform child = built.transform.Find(check.objectName);
                        Assert(child != null, "actual app placement exists: " + check.objectName);
                        if (check.checkPivot) Near(child.localPosition, check.position, "configured height preserves the exported native pivot: " + check.objectName);
                        if (check.nativeScale) Near(child.localScale, Vector3.one, "configured height preserves native module scale: " + check.objectName);
                        if (check.checkGeometry)
                        {
                            Bounds render = GeometryBounds(child, false), collision = GeometryBounds(child, true);
                            Assert(Mathf.Abs(render.min.y - check.minY) < .001f && Mathf.Abs(render.max.y - check.maxY) < .001f,
                                "rendered wall span reaches the door floor and preserves its authored top: " + check.objectName);
                            Assert(Mathf.Abs(collision.min.y - check.minY) < .001f && Mathf.Abs(collision.max.y - check.maxY) < .001f,
                                "physical wall collider matches the closed vertical span: " + check.objectName);
                        }
                        if (check.checkGeometryRange)
                        {
                            foreach (bool collider in new[] { false, true })
                            {
                                Bounds bounds = GeometryBounds(child, collider);
                                Assert(bounds.min.y >= check.minY - .001f && bounds.max.y <= check.maxY + .001f,
                                    "complete actual vertical pipe geometry and caps fit the configured range: " + check.objectName);
                            }
                        }
                        if (check.checkSockets)
                        {
                            var module = child.GetComponent<BaekhoWallModule>();
                            Assert(module != null && module.sockets.Length > 0, "configured generated pipe retains native socket metadata: " + check.objectName);
                            foreach (Transform socket in module.sockets)
                                Assert(socket.position.y >= check.socketMin - .001f && socket.position.y <= check.socketMax + .001f,
                                    "actual imported pipe sockets honor the configured height/range: " + check.objectName);
                        }
                    }
                    foreach (Vector3 point in scenario.clearPoints ?? new Vector3[0])
                        foreach (Transform child in built.transform)
                            if (child.name.StartsWith("wall_", StringComparison.Ordinal))
                                Assert(!GeometryBounds(child, true).Contains(point), "wall closure leaves the connection doorway clear: " + scenario.manifest);
                }
                finally { PrefabUtility.UnloadPrefabContents(built); }
            }
            string result = "BAEKHO_WALL_GENERATED_PASS " + assertions + " assertions, " + input.cases.Length + " real app manifests";
            File.WriteAllText(Path.GetFullPath("../wall-generated-validation-result.txt"), result);
            Debug.Log(result); EditorApplication.Exit(0);
        }
        catch (Exception exception) { Debug.LogException(exception); EditorApplication.Exit(1); }
    }

    private static Bounds GeometryBounds(Transform root, bool colliders)
    {
        Bounds result = new Bounds(); bool first = true;
        if (!colliders)
        {
            foreach (Renderer renderer in root.GetComponentsInChildren<Renderer>())
            {
                if (first) { result = renderer.bounds; first = false; } else result.Encapsulate(renderer.bounds);
            }
        }
        else
        {
            foreach (BoxCollider collider in root.GetComponentsInChildren<BoxCollider>())
                for (int corner = 0; corner < 8; corner++)
                {
                    Vector3 point = collider.transform.TransformPoint(collider.center + Vector3.Scale(collider.size * .5f,
                        new Vector3((corner & 1) == 0 ? -1 : 1, (corner & 2) == 0 ? -1 : 1, (corner & 4) == 0 ? -1 : 1)));
                    if (first) { result = new Bounds(point, Vector3.zero); first = false; } else result.Encapsulate(point);
                }
        }
        Assert(!first, "imported geometry has measurable " + (colliders ? "colliders" : "renderers") + ": " + root.name);
        return result;
    }

    private static void TestPivotImport(string pipeGuid, string lightGuid, string elbowGuid, string teeGuid, LocalBounds elbowBounds, LocalBounds teeBounds)
    {
        string input = Folder + "/wall.baekhomap.json";
        File.WriteAllText(input, "{\"schemaVersion\":5,\"name\":\"WallPivot\",\"width\":4,\"height\":4,\"cellSize\":2," +
            "\"connections\":[{\"id\":\"door\",\"label\":\"Door\",\"kind\":\"door\",\"width\":2,\"height\":2,\"position\":{\"x\":0,\"y\":0,\"z\":4},\"rotation\":{\"x\":0,\"y\":0,\"z\":0}}],\"markers\":[],\"placements\":[" +
            Placement("pipe", "decoration", pipeGuid, 90) + "," + Placement("lamp", "light", lightGuid, 270) + "," +
            Placement("vertical0", "decoration", pipeGuid, 0, 90) + "," + Placement("vertical90", "decoration", pipeGuid, 90, 90) + "," +
            Placement("vertical180", "decoration", pipeGuid, 180, 270) + "," + Placement("vertical270", "decoration", pipeGuid, 270, 270) + "," +
            Placement("elbow", "decoration", elbowGuid, 90, 90) + "," + Placement("tee", "decoration", teeGuid, 270, 270) + "]}");
        AssetDatabase.ImportAsset(input);
        string output = BaekhoMapImporter.BuildFromPath(input, false);
        GameObject built = PrefabUtility.LoadPrefabContents(output);
        try
        {
            Transform pipe = built.transform.Find("decoration_pipe");
            Near(pipe.localPosition, new Vector3(4, 2, 3), "wall import preserves final root pivot exactly");
            Near(pipe.localScale, Vector3.one, "wall import preserves native fixed scale");
            var module = pipe.GetComponent<BaekhoWallModule>();
            Vector3 expected = new Vector3(4, 2, 3) + Quaternion.Euler(0, 90, 0) * new Vector3(2, .25f, -1.2f);
            Near(module.sockets[0].position, expected, "imported off-pivot socket matches calculated transformed root-local connector");
            var light = built.transform.Find("light_lamp").GetComponentInChildren<Light>();
            Assert(light != null && light.type == LightType.Spot && Mathf.Abs(light.intensity - 4.7f) < .001f && Mathf.Abs(light.range - 7) < .001f && light.shadows == LightShadows.Soft,
                "source light type, intensity, range and shadows preserved");
            Near(new Vector3(light.color.r, light.color.g, light.color.b), new Vector3(.25f, .5f, .75f), "source light colour preserved");
            Assert(PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(pipe.gameObject) == AssetDatabase.GUIDToAssetPath(pipeGuid), "wall import retains nested source prefab reference");
            foreach (int yaw in new[] { 0, 90, 180, 270 })
            {
                int roll = yaw < 180 ? 90 : 270;
                Transform vertical = built.transform.Find("decoration_vertical" + yaw);
                var verticalModule = vertical.GetComponent<BaekhoWallModule>();
                Near(vertical.localPosition, new Vector3(4, 2, 3), "vertical pipe keeps native pivot at yaw " + yaw);
                Near(vertical.localScale, Vector3.one, "vertical pipe keeps native scale at yaw " + yaw);
                Quaternion rotation = Quaternion.Euler(0, yaw, roll);
                Near(verticalModule.sockets[0].position, new Vector3(4, 2, 3) + rotation * new Vector3(2, .25f, -1.2f), "vertical socket position matches local roll then world yaw " + yaw);
                Near(verticalModule.sockets[0].forward, rotation * Vector3.left, "vertical socket faces up/down at yaw " + yaw);
                Near(verticalModule.mounts[0].forward, rotation * Vector3.forward, "rolled pipe still faces the wall normal at yaw " + yaw);
                Assert(PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(vertical.gameObject) == AssetDatabase.GUIDToAssetPath(pipeGuid), "vertical pipe retains source prefab reference at yaw " + yaw);
            }
            TestJunctionImport(built.transform.Find("decoration_elbow"), false, elbowGuid, elbowBounds, 90, 90);
            TestJunctionImport(built.transform.Find("decoration_tee"), true, teeGuid, teeBounds, 270, 270);
        }
        finally { PrefabUtility.UnloadPrefabContents(built); }
    }

    private static void TestJunctionImport(Transform imported, bool tee, string guid, LocalBounds nativeBounds, int yaw, int roll)
    {
        string label = tee ? "tee" : "elbow";
        Vector3 pivot = new Vector3(4, 2, 3), offset = JunctionOffset(tee);
        Quaternion rotation = Quaternion.Euler(0, yaw, roll);
        Near(imported.localPosition, pivot, label + " retains final native root pivot");
        Near(imported.localScale, Vector3.one, label + " retains fixed native scale");
        var module = imported.GetComponent<BaekhoWallModule>();
        Near(module.mounts[0].position, pivot + rotation * offset, label + " off-pivot mount follows roll then yaw");
        Near(module.mounts[0].forward, rotation * Vector3.forward, label + " mount still faces its wall");
        Vector3[] ends = tee ? new[] { new Vector3(-.5f, 0, .1f), new Vector3(.5f, 0, .1f), new Vector3(0, -.5f, .1f) } : new[] { new Vector3(-.5f, 0, .1f), new Vector3(0, -.5f, .1f) };
        Vector3[] directions = tee ? new[] { Vector3.left, Vector3.right, Vector3.down } : new[] { Vector3.left, Vector3.down };
        for (int index = 0; index < ends.Length; index++)
        {
            Near(module.sockets[index].position, pivot + rotation * (offset + ends[index]), label + " socket position " + index);
            Near(module.sockets[index].forward, rotation * directions[index], label + " socket direction " + index);
        }
        Bounds expected = new Bounds(); bool first = true;
        for (int corner = 0; corner < 8; corner++)
        {
            Vector3 point = pivot + rotation * (nativeBounds.center + Vector3.Scale(nativeBounds.size * .5f,
                new Vector3((corner & 1) == 0 ? -1 : 1, (corner & 2) == 0 ? -1 : 1, (corner & 4) == 0 ? -1 : 1)));
            if (first) { expected = new Bounds(point, Vector3.zero); first = false; } else expected.Encapsulate(point);
        }
        Bounds actual = new Bounds(); first = true;
        foreach (Renderer renderer in imported.GetComponentsInChildren<Renderer>()) { if (first) { actual = renderer.bounds; first = false; } else actual.Encapsulate(renderer.bounds); }
        Near(actual.center, expected.center, label + " measured native bounds centre follows actual imported transform");
        Near(actual.size, expected.size, label + " measured native bounds size follows actual imported transform");
        Assert(PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(imported.gameObject) == AssetDatabase.GUIDToAssetPath(guid), label + " keeps nested source prefab reference");
    }

    private static string Placement(string id, string role, string guid, int yaw, int roll = 0)
    {
        return "{\"id\":\"" + id + "\",\"role\":\"" + role + "\",\"prefabGuid\":\"" + guid +
            "\",\"surface\":\"pivot\",\"position\":{\"x\":4,\"y\":2,\"z\":3},\"rotation\":{\"x\":0,\"y\":" + yaw + ",\"z\":" + roll + "},\"scale\":{\"x\":1,\"y\":1,\"z\":1}}";
    }

    private static void TestInvalidModules(Scene scene, string output)
    {
        GameObject invalid = Straight(scene, 1);
        invalid.GetComponent<BaekhoWallModule>().sockets[1].localRotation = Quaternion.Euler(0, 45, 0);
        Reject(invalid, "Diagonal", output, "rejects diagonal socket direction");
        invalid = Straight(scene, 1); invalid.GetComponent<BaekhoWallModule>().family = "";
        Reject(invalid, "NoFamily", output, "rejects connected module without family");
        invalid = Straight(scene, 1); invalid.GetComponent<BaekhoWallModule>().sockets = new Transform[0];
        Reject(invalid, "NoSockets", output, "rejects missing straight sockets");
        invalid = Straight(scene, 1); invalid.GetComponent<BaekhoWallModule>().height = float.NaN;
        Reject(invalid, "NotFinite", output, "rejects non-finite wall metadata");
        invalid = Corner(scene, false); invalid.GetComponent<BaekhoWallModule>().collisionBoxes = new Bounds[0];
        Reject(invalid, "NoCompoundBoxes", output, "rejects corner reserving its whole empty interior");
        invalid = Straight(scene, 1); invalid.GetComponent<BaekhoWallModule>().collisionBoxes = new[] { new Bounds(Vector3.zero, new Vector3(1, 0, 1)) };
        Reject(invalid, "FlatBox", output, "rejects zero-size occupancy boxes");
        invalid = CornerLight(scene); invalid.GetComponent<BaekhoWallModule>().mounts = new[] { invalid.GetComponent<BaekhoWallModule>().mounts[0] };
        Reject(invalid, "OneCornerMount", output, "rejects single corner fixture without a second support mount");
        invalid = Junction(scene, true); invalid.GetComponent<BaekhoWallModule>().sockets[2].localRotation = Quaternion.LookRotation(Vector3.left);
        Reject(invalid, "DuplicateTee", output, "rejects duplicate Tee socket direction");
        invalid = Junction(scene, true); invalid.GetComponent<BaekhoWallModule>().sockets[2].localRotation = Quaternion.LookRotation(new Vector3(1, -1, 0));
        Reject(invalid, "DiagonalTee", output, "rejects nonorthogonal Tee socket direction");
        invalid = Junction(scene, true); invalid.GetComponent<BaekhoWallModule>().sockets[2].localPosition += Vector3.forward * .1f;
        Reject(invalid, "OffPlaneTee", output, "rejects Tee sockets outside the common wall plane");
        invalid = Junction(scene, false); invalid.GetComponent<BaekhoWallModule>().sockets[0].localPosition += Vector3.right;
        Reject(invalid, "InwardElbow", output, "rejects elbow arm pointing inward toward the common hub");
        invalid = Junction(scene, true); var teeModule = invalid.GetComponent<BaekhoWallModule>(); teeModule.collisionBoxes = new[] { teeModule.collisionBoxes[0], teeModule.collisionBoxes[1] };
        Reject(invalid, "ShortTeeBoxes", output, "rejects Tee without a box for each of its three arms");
        invalid = Junction(scene, false); invalid.GetComponent<BaekhoWallModule>().collisionBoxes = new[] { invalid.GetComponent<BaekhoWallModule>().collisionBoxes[0] };
        Reject(invalid, "ShortElbowBoxes", output, "rejects elbow without separate arm occupancy boxes");
        invalid = Straight(scene, 1); invalid.GetComponent<BaekhoWallModule>().sockets[1].localRotation = Quaternion.LookRotation(Vector3.up, Vector3.forward);
        Reject(invalid, "VerticalNativeStraight", output, "preserves horizontal source socket rules for existing straight modules");
    }

    private static void Reject(GameObject instance, string name, string output, string label)
    {
        string path = Save(instance, name); string original = File.ReadAllText(output); bool rejected = false;
        try { BaekhoPropCatalog.ExportToPath(output, new[] { AssetDatabase.AssetPathToGUID(path) }); }
        catch (InvalidDataException) { rejected = true; }
        Assert(rejected && File.ReadAllText(output) == original, label + " without replacing existing catalog");
    }

    private static GameObject Root(Scene scene, string name)
    {
        var root = new GameObject(name); SceneManager.MoveGameObjectToScene(root, scene); return root;
    }

    private static GameObject Straight(Scene scene, float length)
    {
        GameObject root = Root(scene, "Straight");
        AddBox(root, new Vector3(2.5f, .25f, -1.2f), new Vector3(length, .1f, .1f));
        BaekhoWallModule module = root.AddComponent<BaekhoWallModule>();
        module.kind = BaekhoWallModule.ModuleKind.Straight; module.family = "FactoryPipe100";
        module.heightMode = BaekhoWallModule.HeightMode.Top; module.height = .5f;
        module.mounts = new[] { Marker(root, "Mount", new Vector3(2.5f, .25f, -1.3f), 0) };
        module.sockets = new[] { Marker(root, "Left", new Vector3(2.5f - length / 2, .25f, -1.2f), 270), Marker(root, "Right", new Vector3(2.5f + length / 2, .25f, -1.2f), 90) };
        return root;
    }

    private static GameObject Corner(Scene scene, bool outer)
    {
        GameObject root = Root(scene, "Corner");
        Vector3 second = outer ? new Vector3(-.1f, 0, -.25f) : new Vector3(.1f, 0, .25f);
        AddBox(root, new Vector3(.25f, 0, .1f), new Vector3(.5f, .1f, .1f));
        AddBox(root, second, new Vector3(.1f, .1f, .5f));
        BaekhoWallModule module = root.AddComponent<BaekhoWallModule>();
        module.kind = outer ? BaekhoWallModule.ModuleKind.OuterCorner : BaekhoWallModule.ModuleKind.InnerCorner;
        module.family = "FactoryPipe100";
        module.heightMode = BaekhoWallModule.HeightMode.Top; module.height = .5f;
        module.mounts = new[] { Marker(root, "MountA", new Vector3(.25f, 0, 0), 0), Marker(root, "MountB", outer ? new Vector3(0, 0, -.25f) : new Vector3(0, 0, .25f), outer ? 270 : 90) };
        module.sockets = new[] { Marker(root, "SocketA", new Vector3(.5f, 0, .1f), 90), Marker(root, "SocketB", outer ? new Vector3(-.1f, 0, -.5f) : new Vector3(.1f, 0, .5f), outer ? 180 : 0) };
        module.collisionBoxes = new[] { new Bounds(new Vector3(.25f, 0, .1f), new Vector3(.5f, .1f, .1f)), new Bounds(second, new Vector3(.1f, .1f, .5f)) };
        return root;
    }

    private static GameObject Cap(Scene scene)
    {
        GameObject root = Root(scene, "Cap"); AddBox(root, Vector3.zero, Vector3.one * .1f);
        BaekhoWallModule module = root.AddComponent<BaekhoWallModule>(); module.kind = BaekhoWallModule.ModuleKind.EndCap; module.family = "FactoryPipe100";
        module.sockets = new[] { Marker(root, "Socket", new Vector3(.05f, 0, 0), 90) }; return root;
    }

    private static GameObject Light(Scene scene)
    {
        GameObject root = Root(scene, "Light"); BaekhoWallModule module = root.AddComponent<BaekhoWallModule>();
        module.sites = new[] { BaekhoWallModule.InstallSite.DoorTop };
        module.mounts = new[] { Marker(root, "Mount", new Vector3(0, 0, -.1f), 0) };
        module.collisionBoxes = new[] { new Bounds(Vector3.zero, new Vector3(.4f, .2f, .2f)) };
        var light = root.AddComponent<Light>(); light.type = LightType.Spot; light.intensity = 4.7f; light.range = 7;
        light.color = new Color(.25f, .5f, .75f); light.shadows = LightShadows.Soft; return root;
    }

    private static GameObject CornerLight(Scene scene)
    {
        GameObject root = Root(scene, "CornerLight"); AddBox(root, new Vector3(.15f, 0, .15f), Vector3.one * .2f);
        var module = root.AddComponent<BaekhoWallModule>(); module.sites = new[] { BaekhoWallModule.InstallSite.Corner };
        module.heightMode = BaekhoWallModule.HeightMode.Top; module.height = .5f;
        module.mounts = new[] { Marker(root, "MountA", new Vector3(.15f, 0, 0), 0), Marker(root, "MountB", new Vector3(0, 0, .15f), 90) };
        return root;
    }

    private static Vector3 JunctionOffset(bool tee) { return tee ? new Vector3(-1.5f, .75f, 2) : new Vector3(2.5f, .25f, -1.3f); }

    private static GameObject Junction(Scene scene, bool tee)
    {
        GameObject root = Root(scene, tee ? "Tee" : "Elbow"); Vector3 offset = JunctionOffset(tee);
        var boxes = new List<Bounds> { new Bounds(offset + new Vector3(-.25f, 0, .1f), new Vector3(.5f, .1f, .1f)) };
        if (tee) boxes.Add(new Bounds(offset + new Vector3(.25f, 0, .1f), new Vector3(.5f, .1f, .1f)));
        boxes.Add(new Bounds(offset + new Vector3(0, -.25f, .1f), new Vector3(.1f, .5f, .1f)));
        foreach (Bounds box in boxes) AddBox(root, box.center, box.size);
        var module = root.AddComponent<BaekhoWallModule>();
        module.kind = tee ? BaekhoWallModule.ModuleKind.Tee : BaekhoWallModule.ModuleKind.Elbow;
        module.family = "FactoryPipe100"; module.heightMode = BaekhoWallModule.HeightMode.Top; module.height = .5f;
        module.mounts = new[] { Marker(root, "Mount", offset, 0) };
        var sockets = new List<Transform> { Marker(root, "Left", offset + new Vector3(-.5f, 0, .1f), 270) };
        if (tee) sockets.Add(Marker(root, "Right", offset + new Vector3(.5f, 0, .1f), 90));
        Transform down = Marker(root, "Down", offset + new Vector3(0, -.5f, .1f), 0);
        down.localRotation = Quaternion.LookRotation(Vector3.down, Vector3.forward); sockets.Add(down);
        module.sockets = sockets.ToArray(); module.collisionBoxes = boxes.ToArray();
        return root;
    }

    private static Transform Marker(GameObject root, string name, Vector3 position, float yaw)
    {
        var marker = new GameObject(name); marker.transform.SetParent(root.transform, false);
        marker.transform.localPosition = position; marker.transform.localRotation = Quaternion.Euler(0, yaw, 0); return marker.transform;
    }

    private static void AddBox(GameObject root, Vector3 center, Vector3 size)
    {
        var box = GameObject.CreatePrimitive(PrimitiveType.Cube); box.transform.SetParent(root.transform, false);
        box.transform.localPosition = center; box.transform.localScale = size;
    }

    private static string Save(GameObject root, string name)
    {
        string path = Folder + "/" + name + ".prefab"; PrefabUtility.SaveAsPrefabAsset(root, path); UnityEngine.Object.DestroyImmediate(root); return path;
    }
    private static void Near(Vector3 actual, Vector3 expected, string label) { Assert((actual - expected).magnitude < .001f, label + ": " + actual + " expected " + expected); }
    private static void Assert(bool condition, string label) { assertions++; if (!condition) throw new InvalidOperationException(label); }
}
