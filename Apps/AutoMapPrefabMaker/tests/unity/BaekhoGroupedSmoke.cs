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
    [Serializable] private sealed class Catalog { public Entry[] assets; }
    [Serializable] private sealed class Entry { public string id; public string path; public string guid; public Vector3 size; }
    [Serializable] private sealed class Manifest { public Placement[] placements; }
    [Serializable] private sealed class Placement { public string id; public string role; public string prefabGuid; public Vector3 position; public Vector3 rotation; public Vector3 scale; public bool centerXZ; }
    [Serializable] private sealed class Expected { public int groups; public int moved; public Prop[] props; }
    [Serializable] private sealed class Prop { public string id; public string groupId; public Vector3 size; }
    [Serializable] private sealed class NavigationResult { public int routes; public int groups; public float minimumRouteMetres; public float maximumRouteMetres; public float agentRadius; public float agentHeight; }

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
        NavMeshDataInstance instance = NavMesh.AddNavMeshData(surface.navMeshData);
        Assert(instance.valid, "Baked navigation is registered for native Unity path queries");
        try
        {
            var filter = new NavMeshQueryFilter { agentTypeID = surface.agentTypeID, areaMask = NavMesh.AllAreas };
            NavMeshHit entry, center;
            Assert(NavMesh.SamplePosition(new Vector3(1, 0, 16.5f), out entry, .5f, filter), "Entry approach has a walkable navigation surface");
            Assert(NavMesh.SamplePosition(Vector3.zero, out center, .5f, filter), "Combat center has a walkable navigation surface");
            var routes = new List<float>();
            routes.Add(AssertRoute(entry.position, center.position, filter, "Entry to combat center"));
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
                    if (Mathf.Abs(point.x) > 21 || Mathf.Abs(point.z) > 17 || !NavMesh.SamplePosition(point, out target, .25f, filter) || Mathf.Abs(target.position.y) > .1f) continue;
                    if (Vector3.Distance(center.position, target.position) < 3) continue;
                    routes.Add(AssertRoute(center.position, target.position, filter, "Combat center to usable floor beside " + prop.id));
                    if (!string.IsNullOrEmpty(prop.groupId)) approached.Add(prop.groupId);
                }
            }
            Assert(approached.Count == expected.groups, "Every semantic group has an accessible floor approach in the actual imported Unity geometry");
            Assert(routes.Count >= expected.groups * 2 + 1, "Navigation tests multiple nontrivial floor destinations around groups");
            float minimum = float.PositiveInfinity, maximum = 0;
            foreach (float length in routes) { minimum = Mathf.Min(minimum, length); maximum = Mathf.Max(maximum, length); }
            File.WriteAllText(Path.Combine(Output, "navigation-result.json"), JsonUtility.ToJson(new NavigationResult { routes = routes.Count, groups = approached.Count,
                minimumRouteMetres = minimum, maximumRouteMetres = maximum, agentRadius = settings.agentRadius, agentHeight = settings.agentHeight }, true));
            Debug.Log("BAEKHO_GROUPED_NAVIGATION_PASS " + routes.Count + " complete routes across " + approached.Count + " groups");
        }
        finally { instance.Remove(); }
    }

    private static float AssertRoute(Vector3 from, Vector3 to, NavMeshQueryFilter filter, string label)
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
                Assert(Mathf.Abs(point.y) < .2f && NavMesh.SamplePosition(point, out floor, .075f, filter), label + " every quarter-metre route sample stays on walkable ground");
            }
            distance += length;
        }
        Assert(distance > 3, label + " spans more than three metres"); return distance;
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
