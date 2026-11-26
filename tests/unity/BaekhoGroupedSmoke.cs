// Isolated integration fixture only. Synthetic prefabs; never opens or modifies the user's game project.
using System;
using System.Collections.Generic;
using System.IO;
using StudioBaekho;
using Unity.AI.Navigation;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.AI;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

public static class BaekhoGroupedSmoke
{
    private const string Folder = "Assets/GroupedValidation";
    private static int assertions;
    private static int routeSamples;
    private static float minimumPhysicalClearance;
    [Serializable] private sealed class Catalog { public Entry[] assets; }
    [Serializable] private sealed class Entry { public string id; public string path; public string guid; public Vector3 size; }
    [Serializable] private sealed class Manifest { public Placement[] placements; }
    [Serializable] private sealed class Placement { public string id; public string role; public string prefabGuid; public Vector3 position; public Vector3 rotation; public Vector3 scale; public bool centerXZ; }
    [Serializable] private sealed class Expected { public int groups; public int moved; public Prop[] props; public Vector3 combatCenter; public Vector3 entry; public float floorHalfX; public float floorHalfZ; }
    [Serializable] private sealed class Prop { public string id; public string groupId; public Vector3 size; }
    [Serializable] private sealed class NavigationResult { public int routes; public int groups; public float minimumRouteMetres; public float maximumRouteMetres; public float agentRadius; public float agentHeight; public float voxelSize; public int propGuards; public int quarterMetreSamples; public float minimumPhysicalClearance; public Vector3 combatCenter; }
    [Serializable] private sealed class RouteFailure { public string label; public Vector3 from; public Vector3 to; public Vector3[] corners; public int segment; public int sample; public Vector3 point; public bool nearSample; public Vector3 nearPoint; public float nearDistance; public bool segmentBlocked; public Vector3 blockedPoint; }
    [Serializable] private sealed class LowStepResult { public bool baseline; public float stepHeight; public float climb; public float agentRadius; public bool lowCrossed; public bool tallBlocked; public int lowGuards; public int tallGuards; }

    private static string Output { get { return Path.GetFullPath("../grouped-unity-validation"); } }
    private static void Guard()
    {
        Assert(Application.dataPath.Replace('\\', '/').EndsWith("/.local/unity-validation/Assets", StringComparison.Ordinal), "Only the repository validation project may run this fixture");
        Directory.CreateDirectory(Output); Directory.CreateDirectory(Folder);
    }

    public static void Prepare()
    {
        try
        {
            Guard();
            Scene preview = EditorSceneManager.NewPreviewScene();
            try
            {
                var entries = new List<Entry>();
                Material steel = MaterialAsset("Steel", new Color(.25f, .32f, .39f));
                Material blue = MaterialAsset("Console", new Color(.08f, .49f, .65f));
                Material orange = MaterialAsset("Cargo", new Color(.76f, .39f, .12f));
                Material floor = MaterialAsset("Floor", new Color(.52f, .56f, .57f));
                Material wall = MaterialAsset("Wall", new Color(.28f, .33f, .37f));
                Material screen = MaterialAsset("Screen", new Color(.12f, .85f, .96f));
                screen.EnableKeyword("_EMISSION"); screen.SetColor("_EmissionColor", new Color(.12f, .6f, .8f)); EditorUtility.SetDirty(screen);
                entries.Add(SaveBox(preview, "floor", Vector3.one, floor, Vector3.zero));
                entries.Add(SaveBox(preview, "wall", Vector3.one, wall, Vector3.zero));
                entries.Add(SaveBox(preview, "door", Vector3.one, steel, Vector3.zero));
                GameObject console = Root(preview, "console");
                Vector3 pivot = new Vector3(.37f, 0, -.23f);
                Box(console, pivot + new Vector3(0, .35f, 0), new Vector3(1.6f, .7f, 1.2f), blue);
                Box(console, pivot + new Vector3(0, .9f, -.4f), new Vector3(1.6f, .4f, .4f), steel);
                Box(console, pivot + new Vector3(0, .9f, -.185f), new Vector3(1.3f, .26f, .02f), screen);
                BoxCollider interaction = console.AddComponent<BoxCollider>(); interaction.center = Vector3.up; interaction.size = Vector3.one * 100; interaction.isTrigger = true;
                entries.Add(Save(console, "console"));
                GameObject generator = Root(preview, "generator");
                Box(generator, pivot + new Vector3(0, .75f, 0), new Vector3(2, 1.5f, 1.5f), steel);
                for (int index = 0; index < 4; index++) Box(generator, pivot + new Vector3(-.65f + index * .43f, 1.1f, .755f), new Vector3(.22f, .3f, .01f), screen);
                entries.Add(Save(generator, "generator"));
                entries.Add(SaveBox(preview, "crate", new Vector3(1.1f, 1.1f, 1.1f), orange, pivot));
                AssetDatabase.SaveAssets(); AssetDatabase.Refresh();
                File.WriteAllText(Path.Combine(Output, "native-catalog.json"), JsonUtility.ToJson(new Catalog { assets = entries.ToArray() }, true));
            }
            finally { EditorSceneManager.ClosePreviewScene(preview); }
            Debug.Log("BAEKHO_GROUPED_PREPARE_PASS"); EditorApplication.Exit(0);
        }
        catch (Exception error) { Debug.LogException(error); EditorApplication.Exit(1); }
    }

    public static void Run()
    {
        try
        {
            Guard();
            Assert(SystemInfo.graphicsDeviceType != GraphicsDeviceType.Null, "A real graphics device is required for character-eye render validation");
            int previews = EditorSceneManager.previewSceneCount;
            Scene active = SceneManager.GetActiveScene(); int roots = active.rootCount; bool dirty = active.isDirty;
            VerifyAndRender("before"); VerifyAndRender("after");
            Assert(SceneManager.GetActiveScene() == active && active.rootCount == roots && active.isDirty == dirty && EditorSceneManager.previewSceneCount == previews, "Imports and renders leave the validation scene unchanged and close all preview scenes");
            string result = "BAEKHO_GROUPED_UNITY_PASS " + assertions + " assertions; synthetic prefabs; camera eye 1.7m; " + SystemInfo.graphicsDeviceType;
            File.WriteAllText(Path.Combine(Output, "unity-result.txt"), result); Debug.Log(result); EditorApplication.Exit(0);
        }
        catch (Exception error) { Debug.LogException(error); EditorApplication.Exit(1); }
    }

    public static void RunLowStepBaseline() { RunLowSteps(true); }
    public static void RunLowStepGuarded() { RunLowSteps(false); }
    private static void RunLowSteps(bool baseline)
    {
        try
        {
            Guard(); Scene active = SceneManager.GetActiveScene(); int roots = active.rootCount, previews = EditorSceneManager.previewSceneCount; bool dirty = active.isDirty;
            NavMeshBuildSettings agent = NavMesh.GetSettingsByIndex(0);
            Assert(agent.agentClimb > .05f, "The existing selected agent supports a nonzero low step");
            float height = agent.agentClimb * .5f;
            Scene preview = EditorSceneManager.NewPreviewScene(); string floor, low, tall;
            try
            {
                Material material = MaterialAsset("StepValidation", Color.gray);
                floor = SaveBox(preview, "step-floor", new Vector3(12, .12f, 4), material, Vector3.zero).guid;
                low = SaveStep(preview, "low-step", new Vector3(2, height, 4), material);
                tall = SaveStep(preview, "tall-step", new Vector3(2, agent.agentClimb + .6f, 4), material);
            }
            finally { EditorSceneManager.ClosePreviewScene(preview); }
            var result = new LowStepResult { baseline = baseline, stepHeight = height, climb = agent.agentClimb, agentRadius = agent.agentRadius };
            foreach (bool lowBody in new[] { true, false })
            {
                string label = (baseline ? "baseline-" : "guarded-") + (lowBody ? "low" : "tall");
                string input = Folder + "/" + label + "-step.baekhomap.json";
                File.WriteAllText(input, "{\"schemaVersion\":5,\"name\":\"" + label + "\",\"width\":6,\"height\":2,\"cellSize\":2,\"markers\":[],\"connections\":[{\"id\":\"entry\",\"label\":\"Entry\",\"kind\":\"door\",\"width\":2,\"height\":3,\"position\":{\"x\":-6,\"y\":0,\"z\":0},\"rotation\":{\"x\":0,\"y\":270,\"z\":0}}],\"placements\":[" +
                    StepPlacement("floor", "floor", floor, "top") + "," + StepPlacement("prop-instance-step", "prop", lowBody ? low : tall, "bottom") + "]}");
                string output = BaekhoMapImporter.BuildFromPath(input, true, agent.agentTypeID);
                GameObject model = PrefabUtility.LoadPrefabContents(output);
                try
                {
                    NavMeshSurface surface = model.GetComponent<NavMeshSurface>(); Assert(surface != null && surface.navMeshData != null, "Focused native step case baked navigation");
                    Assert(surface.agentTypeID == agent.agentTypeID && Mathf.Abs(surface.GetBuildSettings().agentRadius - agent.agentRadius) < .00001f, "Step compatibility keeps requested agent type and radius");
                    Transform body = model.transform.Find("prop_prop-instance-step"); var guards = body.GetComponents<NavMeshModifierVolume>();
                    if (lowBody) result.lowGuards = guards.Length; else result.tallGuards = guards.Length;
                    if (!baseline)
                    {
                        Assert(lowBody ? guards.Length == 0 : guards.Length == 1, "Only a non-stepable solid body receives a generated navigation guard");
                        foreach (NavMeshModifierVolume volume in guards)
                        {
                            Assert(volume.size.x < 5 && volume.size.z < 5, "A 100m interaction trigger never inflates the solid step footprint");
                            Assert(volume.AffectsAgentType(agent.agentTypeID) && !volume.AffectsAgentType(agent.agentTypeID + 12345), "Step guards affect only the chosen agent type");
                        }
                    }
                    NavMeshDataInstance instance = NavMesh.AddNavMeshData(surface.navMeshData);
                    try
                    {
                        var filter = new NavMeshQueryFilter { agentTypeID = agent.agentTypeID, areaMask = NavMesh.AllAreas }; NavMeshHit start = default(NavMeshHit), finish = default(NavMeshHit);
                        Assert(NavMesh.SamplePosition(new Vector3(-4, 0, 0), out start, .2f, filter) && NavMesh.SamplePosition(new Vector3(4, 0, 0), out finish, .2f, filter), "Both sides of the native runway are walkable");
                        var path = new NavMeshPath(); bool complete = NavMesh.CalculatePath(start.position, finish.position, filter, path) && path.status == NavMeshPathStatus.PathComplete;
                        if (lowBody)
                        {
                            result.lowCrossed = complete; Assert(complete, "Native low body remains traversable across a runway with no route around it");
                            NavMeshHit onStep; Assert(NavMesh.SamplePosition(new Vector3(0, height, 0), out onStep, .12f, filter) && Mathf.Abs(onStep.position.y - height) < .12f, "Crossing uses the actual low body top");
                        }
                        else
                        {
                            result.tallBlocked = !complete; Assert(!complete, "A solid body above agentClimb still blocks the entire runway");
                            if (!baseline)
                            {
                                NavMeshHit near; Assert(NavMesh.SamplePosition(new Vector3(-1.7f, 0, 0), out near, .15f, filter), "Tall-body approach has native walkable ground");
                                Bounds bounds = BoundsOf(body.gameObject); Assert(bounds.min.x - near.position.x >= agent.agentRadius - .001f, "Tall-body approach retains full native character clearance");
                            }
                        }
                    }
                    finally { instance.Remove(); }
                }
                finally { PrefabUtility.UnloadPrefabContents(model); }
            }
            Assert(active == SceneManager.GetActiveScene() && active.rootCount == roots && active.isDirty == dirty && EditorSceneManager.previewSceneCount == previews, "Focused step checks preserve scene state");
            File.WriteAllText(Path.Combine(Output, baseline ? "low-step-baseline.json" : "low-step-guarded.json"), JsonUtility.ToJson(result, true));
            Debug.Log("BAEKHO_LOW_STEP_PASS " + assertions + " assertions; baseline=" + baseline); EditorApplication.Exit(0);
        }
        catch (Exception error) { Debug.LogException(error); EditorApplication.Exit(1); }
    }
    private static string SaveStep(Scene preview, string name, Vector3 size, Material material)
    {
        GameObject root = Root(preview, name); Box(root, Vector3.up * size.y / 2, size, material);
        BoxCollider interaction = root.AddComponent<BoxCollider>(); interaction.isTrigger = true; interaction.size = Vector3.one * 100;
        return Save(root, name).guid;
    }
    private static string StepPlacement(string id, string role, string guid, string surface)
    {
        return "{\"id\":\"" + id + "\",\"role\":\"" + role + "\",\"prefabGuid\":\"" + guid + "\",\"surface\":\"" + surface + "\"," + (role == "prop" ? "\"centerXZ\":true," : "") + "\"position\":{\"x\":0,\"y\":0,\"z\":0},\"rotation\":{\"x\":0,\"y\":0,\"z\":0},\"scale\":{\"x\":1,\"y\":1,\"z\":1}}";
    }

    private static void VerifyAndRender(string phase)
    {
        string input = Folder + "/" + phase + ".baekhomap.json";
        Manifest manifest = JsonUtility.FromJson<Manifest>(File.ReadAllText(input));
        Expected expected = JsonUtility.FromJson<Expected>(File.ReadAllText(Path.Combine(Output, phase + "-expected.json")));
        string prefabPath = BaekhoMapImporter.BuildFromPath(input, phase == "after");
        GameObject loaded = PrefabUtility.LoadPrefabContents(prefabPath);
        try
        {
            foreach (Prop prop in expected.props)
            {
                Placement placement = Array.Find(manifest.placements, item => item.id == "prop-instance-" + prop.id);
                Assert(placement != null && placement.centerXZ, phase + " exports measured prop " + prop.id);
                Transform instance = loaded.transform.Find(placement.role + "_" + placement.id);
                Assert(instance != null, phase + " imports measured prop " + prop.id);
                Near(instance.localScale, placement.scale, phase + " native scale " + prop.id);
                Assert(Quaternion.Angle(instance.localRotation, Quaternion.Euler(placement.rotation)) < .001f, phase + " native rotation " + prop.id);
                Bounds bounds = BoundsOf(instance.gameObject);
                Near(bounds.size, prop.size, phase + " world bounds " + prop.id);
                Near(new Vector3(bounds.center.x, bounds.min.y, bounds.center.z), placement.position, phase + " bottom-center world placement " + prop.id);
                Assert(PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(instance.gameObject) == AssetDatabase.GUIDToAssetPath(placement.prefabGuid), phase + " preserves native prefab reference " + prop.id);
            }
            if (phase == "after") VerifyNavigation(loaded, manifest, expected);
        }
        finally { PrefabUtility.UnloadPrefabContents(loaded); }
        Scene preview = EditorSceneManager.NewPreviewScene();
        try
        {
            GameObject model = PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath), preview) as GameObject;
            Assert(model != null, phase + " render model");
            RenderTexture target = new RenderTexture(1440, 900, 24) { antiAliasing = 4 };
            GameObject cameraObject = Root(preview, "Character eye 1.7m");
            Camera camera = cameraObject.AddComponent<Camera>(); camera.scene = preview;
            camera.transform.position = new Vector3(-11, 1.7f, -11.5f);
            camera.transform.rotation = Quaternion.LookRotation(new Vector3(3, .7f, 5) - camera.transform.position);
            camera.fieldOfView = 68; camera.nearClipPlane = .05f; camera.farClipPlane = 100;
            camera.backgroundColor = new Color(.13f, .17f, .22f); camera.clearFlags = CameraClearFlags.SolidColor;
            camera.targetTexture = target; camera.allowHDR = false;
            GameObject lightObject = Root(preview, "Validation daylight");
            Light light = lightObject.AddComponent<Light>(); light.type = LightType.Directional; light.intensity = .8f;
            light.transform.rotation = Quaternion.Euler(45, -25, 0); light.shadows = LightShadows.Soft;
            RenderSettings.ambientMode = AmbientMode.Flat; RenderSettings.ambientLight = new Color(.3f, .32f, .35f); RenderSettings.fog = false;
            GameObject labelObject = Root(preview, "Synthetic validation caption");
            labelObject.transform.SetParent(camera.transform, false); labelObject.transform.localPosition = new Vector3(-.93f, .58f, 1);
            TextMesh label = labelObject.AddComponent<TextMesh>(); label.text = "SYNTHETIC PREFABS | " + phase.ToUpperInvariant() + " | EYE HEIGHT 1.7m";
            label.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf"); label.fontSize = 64; label.characterSize = .008f; label.color = Color.white;
            labelObject.GetComponent<MeshRenderer>().sharedMaterial = label.font.material;
            RenderTexture previous = RenderTexture.active;
            Texture2D image = new Texture2D(target.width, target.height, TextureFormat.RGB24, false);
            try
            {
                camera.Render(); RenderTexture.active = target; image.ReadPixels(new Rect(0, 0, target.width, target.height), 0, 0); image.Apply();
                Color a = image.GetPixel(target.width / 2, target.height / 2), b = image.GetPixel(target.width / 2, target.height / 6);
                Assert(Mathf.Abs(a.grayscale - b.grayscale) > .005f, phase + " render contains scene geometry rather than a blank frame");
                byte[] png = image.EncodeToPNG(); Assert(png.Length > 20000, phase + " valid rendered PNG");
                File.WriteAllBytes(Path.Combine(Output, phase + "-synthetic-eye.png"), png);
            }
            finally { RenderTexture.active = previous; camera.targetTexture = null; target.Release(); UnityEngine.Object.DestroyImmediate(target); UnityEngine.Object.DestroyImmediate(image); }
        }
        finally { EditorSceneManager.ClosePreviewScene(preview); }
    }

    private static void VerifyNavigation(GameObject model, Manifest manifest, Expected expected)
    {
        NavMeshSurface surface = model.GetComponent<NavMeshSurface>();
        Assert(surface != null && surface.navMeshData != null, "Actual imported after-map has baked AI Navigation data");
        NavMeshBuildSettings settings = surface.GetBuildSettings();
        Assert(settings.agentRadius >= .4f && settings.agentHeight >= 1.7f, "Navigation uses a character-sized agent");
        Assert(surface.overrideVoxelSize && surface.voxelSize <= settings.agentRadius / 6 + .00001f, "Native navigation uses explicit agent-relative fine voxel resolution");
        Assert(model.GetComponentsInChildren<NavMeshModifierVolume>().Length >= expected.props.Length, "Every solid measured prop has a conservative native navigation footprint guard");
        foreach (NavMeshModifierVolume guard in model.GetComponentsInChildren<NavMeshModifierVolume>())
        {
            Assert(guard.AffectsAgentType(surface.agentTypeID) && !guard.AffectsAgentType(surface.agentTypeID + 12345), "Generated footprint guards affect only the selected native agent type");
            Assert(guard.size.x < 5 && guard.size.z < 5, "Huge interaction triggers never inflate a solid prop's navigation guard");
        }
        routeSamples = 0; minimumPhysicalClearance = float.PositiveInfinity;
        NavMeshDataInstance instance = NavMesh.AddNavMeshData(surface.navMeshData);
        Assert(instance.valid, "Baked navigation is registered for native Unity path queries");
        try
        {
            var filter = new NavMeshQueryFilter { agentTypeID = surface.agentTypeID, areaMask = NavMesh.AllAreas };
            NavMeshHit entry, center;
            Assert(NavMesh.SamplePosition(expected.entry, out entry, .5f, filter), "Actual entry approach has a walkable navigation surface at " + expected.entry);
            Assert(NavMesh.SamplePosition(expected.combatCenter, out center, .5f, filter), "Analyzed combat center has a walkable navigation surface at " + expected.combatCenter);
            var floors = new List<Bounds>(); var obstacles = new List<Bounds>();
            foreach (Transform child in model.transform) foreach (BoxCollider collider in child.GetComponentsInChildren<BoxCollider>())
            {
                if (!collider.enabled || collider.isTrigger) continue;
                if (child.name.StartsWith("floor_", StringComparison.Ordinal)) floors.Add(ColliderBounds(collider));
                else if (child.name.StartsWith("prop_", StringComparison.Ordinal) || child.name.StartsWith("wall_", StringComparison.Ordinal)) obstacles.Add(ColliderBounds(collider));
            }
            Assert(floors.Count > 0 && obstacles.Count > 0, "Native geometry supplies floor support and character-clearance checks");
            var routes = new List<float>();
            routes.Add(AssertRoute(entry.position, center.position, filter, "Entry to combat center", floors, obstacles, settings));
            var approached = new HashSet<string>();
            foreach (Prop prop in expected.props)
            {
                Placement placement = Array.Find(manifest.placements, item => item.id == "prop-instance-" + prop.id);
                var candidates = new[] {
                    placement.position + Vector3.right * (prop.size.x / 2 + 1), placement.position + Vector3.left * (prop.size.x / 2 + 1),
                    placement.position + Vector3.forward * (prop.size.z / 2 + 1), placement.position + Vector3.back * (prop.size.z / 2 + 1) };
                foreach (Vector3 point in candidates)
                {
                    // Only actual floor samples count: avoid wall tops, prop tops and points inside other members.
                    NavMeshHit target;
                    if (Mathf.Abs(point.x) > expected.floorHalfX || Mathf.Abs(point.z) > expected.floorHalfZ || !NavMesh.SamplePosition(point, out target, .25f, filter) || Mathf.Abs(target.position.y) > .1f) continue;
                    if (Vector3.Distance(center.position, target.position) < 3) continue;
                    routes.Add(AssertRoute(center.position, target.position, filter, "Combat center to usable floor beside " + prop.id, floors, obstacles, settings));
                    if (!string.IsNullOrEmpty(prop.groupId)) approached.Add(prop.groupId);
                }
            }
            Assert(approached.Count == expected.groups, "Every semantic group has an accessible floor approach in the actual imported Unity geometry");
            Assert(routes.Count >= expected.groups * 2 + 1, "Navigation tests multiple nontrivial floor destinations around groups");
            float minimum = float.PositiveInfinity, maximum = 0;
            foreach (float length in routes) { minimum = Mathf.Min(minimum, length); maximum = Mathf.Max(maximum, length); }
            File.WriteAllText(Path.Combine(Output, "navigation-result.json"), JsonUtility.ToJson(new NavigationResult { routes = routes.Count, groups = approached.Count,
                minimumRouteMetres = minimum, maximumRouteMetres = maximum, agentRadius = settings.agentRadius, agentHeight = settings.agentHeight,
                voxelSize = surface.voxelSize, propGuards = model.GetComponentsInChildren<NavMeshModifierVolume>().Length, quarterMetreSamples = routeSamples, minimumPhysicalClearance = minimumPhysicalClearance, combatCenter = expected.combatCenter }, true));
            Debug.Log("BAEKHO_GROUPED_NAVIGATION_PASS " + routes.Count + " complete routes across " + approached.Count + " groups");
        }
        finally { instance.Remove(); }
    }

    private static float AssertRoute(Vector3 from, Vector3 to, NavMeshQueryFilter filter, string label, List<Bounds> floors, List<Bounds> obstacles, NavMeshBuildSettings settings)
    {
        var path = new NavMeshPath();
        Assert(NavMesh.CalculatePath(from, to, filter, path) && path.status == NavMeshPathStatus.PathComplete, label + " has a complete native NavMesh route");
        Assert(path.corners.Length >= 2, label + " contains a nontrivial route");
        float distance = 0;
        for (int index = 1; index < path.corners.Length; index++)
        {
            Vector3 start = path.corners[index - 1], end = path.corners[index]; float length = Vector3.Distance(start, end);
            // Returned polygon corners lie exactly on edges; sampling avoids Raycast's endpoint precision ambiguity.
            int samples = Math.Max(1, Mathf.CeilToInt(length / .25f));
            for (int sample = 0; sample <= samples; sample++)
            {
                Vector3 point = Vector3.Lerp(start, end, sample / (float)samples); NavMeshHit floor;
                // Path corners use polygon heights; native detail-triangle heights can vary between them.
                // Keep the original 7.5cm planar tolerance, then independently require real flat floor and body clearance.
                bool sampled = NavMesh.SamplePosition(point, out floor, settings.agentClimb + .1f, filter);
                bool planar = sampled && new Vector2(point.x - floor.position.x, point.z - floor.position.z).magnitude <= .075f;
                bool grounded = floors.Exists(bounds => point.x >= bounds.min.x - .001f && point.x <= bounds.max.x + .001f && point.z >= bounds.min.z - .001f && point.z <= bounds.max.z + .001f && Mathf.Abs(bounds.max.y) < .02f);
                bool clear = true;
                routeSamples++;
                foreach (Bounds obstacle in obstacles)
                {
                    if (obstacle.max.y <= .001f || obstacle.min.y >= settings.agentHeight - .001f) continue;
                    float dx = Mathf.Max(obstacle.min.x - point.x, 0, point.x - obstacle.max.x), dz = Mathf.Max(obstacle.min.z - point.z, 0, point.z - obstacle.max.z);
                    minimumPhysicalClearance = Mathf.Min(minimumPhysicalClearance, Mathf.Sqrt(dx * dx + dz * dz));
                    if (dx * dx + dz * dz < (settings.agentRadius - .001f) * (settings.agentRadius - .001f)) { clear = false; break; }
                }
                bool valid = Mathf.Abs(point.y) < .2f && planar && grounded && clear && Mathf.Abs(floor.position.y) <= settings.agentClimb + .001f;
                if (!valid)
                {
                    NavMeshHit near, blocked; bool found = NavMesh.SamplePosition(point, out near, 1, filter), hits = NavMesh.Raycast(start, end, out blocked, filter);
                    var failure = new RouteFailure { label = label, from = from, to = to, corners = path.corners, segment = index, sample = sample, point = point, nearSample = found, nearPoint = near.position, nearDistance = found ? Vector3.Distance(point, near.position) : -1, segmentBlocked = hits, blockedPoint = blocked.position };
                    string diagnostic = JsonUtility.ToJson(failure, true); File.WriteAllText(Path.Combine(Output, "navigation-failure.json"), diagnostic); Debug.LogError(diagnostic);
                }
                Assert(valid, label + " quarter-metre sample " + sample + "/" + samples + " at " + point.ToString("F5") + " has planar route/floor/body clearance " + planar + "/" + grounded + "/" + clear + "; segment " + index + " " + start.ToString("F5") + " -> " + end.ToString("F5"));
            }
            distance += length;
        }
        Assert(distance > 3, label + " spans more than three metres"); return distance;
    }

    private static Bounds ColliderBounds(BoxCollider collider)
    {
        Bounds bounds = new Bounds(collider.transform.TransformPoint(collider.center), Vector3.zero);
        for (int corner = 0; corner < 8; corner++) bounds.Encapsulate(collider.transform.TransformPoint(collider.center + Vector3.Scale(collider.size * .5f,
            new Vector3((corner & 1) == 0 ? -1 : 1, (corner & 2) == 0 ? -1 : 1, (corner & 4) == 0 ? -1 : 1))));
        return bounds;
    }

    private static GameObject Root(Scene scene, string name) { var root = new GameObject(name); SceneManager.MoveGameObjectToScene(root, scene); return root; }
    private static Material MaterialAsset(string name, Color color)
    {
        string path = Folder + "/" + name + ".mat";
        Material material = AssetDatabase.LoadAssetAtPath<Material>(path);
        if (material == null) { material = new Material(Shader.Find("Standard")); AssetDatabase.CreateAsset(material, path); }
        material.color = color; material.SetFloat("_Glossiness", .18f); return material;
    }
    private static void Box(GameObject parent, Vector3 center, Vector3 size, Material material)
    {
        GameObject box = GameObject.CreatePrimitive(PrimitiveType.Cube); box.transform.SetParent(parent.transform, false);
        box.transform.localPosition = center; box.transform.localScale = size; box.GetComponent<Renderer>().sharedMaterial = material;
    }
    private static Entry SaveBox(Scene scene, string name, Vector3 size, Material material, Vector3 pivot)
    {
        GameObject root = Root(scene, name); Box(root, pivot + Vector3.up * size.y / 2, size, material); return Save(root, name);
    }
    private static Entry Save(GameObject root, string name)
    {
        string path = Folder + "/" + name + ".prefab"; Vector3 size = BoundsOf(root).size;
        PrefabUtility.SaveAsPrefabAsset(root, path); UnityEngine.Object.DestroyImmediate(root);
        return new Entry { id = name, path = path, guid = AssetDatabase.AssetPathToGUID(path), size = size };
    }
    private static Bounds BoundsOf(GameObject root)
    {
        Renderer[] renderers = root.GetComponentsInChildren<Renderer>(); Assert(renderers.Length > 0, root.name + " has measured geometry");
        Bounds bounds = renderers[0].bounds; for (int index = 1; index < renderers.Length; index++) bounds.Encapsulate(renderers[index].bounds); return bounds;
    }
    private static void Near(Vector3 actual, Vector3 expected, string message) { Assert((actual - expected).magnitude < .002f, message + ": " + actual + " expected " + expected); }
    private static void Assert(bool condition, string message) { assertions++; if (!condition) throw new InvalidOperationException(message); }
}
