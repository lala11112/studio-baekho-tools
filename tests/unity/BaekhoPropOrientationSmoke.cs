// Isolated synthetic fixtures for native prop facing, free yaw, and workstation relationships.
using System;
using System.Collections.Generic;
using System.IO;
using StudioBaekho;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

public static class BaekhoPropOrientationSmoke
{
    private const string Folder = "Assets/PropOrientationValidation";
    private static int assertions;
    [Serializable] private sealed class Catalog { public Entry[] assets; }
    [Serializable] private sealed class Entry { public string id; public string path; public string guid; public Vector3 size; public float nativeFrontYaw; }
    [Serializable] private sealed class Manifest { public Placement[] placements; }
    [Serializable] private sealed class Placement { public string id; public string role; public string prefabGuid; public Vector3 position; public Vector3 rotation; public Vector3 scale; public bool centerXZ; }
    [Serializable] private sealed class Expected { public Prop[] props; }
    [Serializable] private sealed class Prop { public string id; public string behavior; public string partnerId; public Vector3 size; public Vector3 front; public bool checkFront; }
    private static string Output { get { return Path.GetFullPath("../prop-orientation-unity-validation"); } }

    private static void Guard()
    {
        Assert(Application.dataPath.Replace('\\', '/').EndsWith("/.local/unity-validation/Assets", StringComparison.Ordinal), "Only the isolated repository validation project is allowed");
        Directory.CreateDirectory(Output); Directory.CreateDirectory(Folder);
    }

    public static void Prepare()
    {
        try
        {
            Guard(); Scene scene = EditorSceneManager.NewPreviewScene();
            try
            {
                Material steel = MaterialAsset("Steel", new Color(.25f, .32f, .39f));
                Material blue = MaterialAsset("Blue", new Color(.08f, .49f, .65f));
                Material orange = MaterialAsset("Cargo", new Color(.76f, .39f, .12f));
                Material floor = MaterialAsset("Floor", new Color(.52f, .56f, .57f));
                Material screen = MaterialAsset("Screen", new Color(.12f, .85f, .96f));
                screen.EnableKeyword("_EMISSION"); screen.SetColor("_EmissionColor", new Color(.12f, .6f, .8f)); EditorUtility.SetDirty(screen);
                var entries = new List<Entry>();
                foreach (string id in new[] { "floor", "wall", "door" })
                {
                    GameObject root = Root(scene, id); Box(root, Vector3.up * .5f, Vector3.one, floor); entries.Add(Save(root, id, 0));
                }
                foreach (bool reversed in new[] { false, true })
                {
                    string id = reversed ? "ReversedConsole" : "Console";
                    GameObject root = Root(scene, id), model = new GameObject("Model"); model.transform.SetParent(root.transform, false);
                    model.transform.localRotation = Quaternion.Euler(0, reversed ? 180 : 0, 0);
                    Vector3 pivot = new Vector3(.37f, 0, -.23f);
                    Box(model, pivot + new Vector3(0, .35f, 0), new Vector3(1.4f, .7f, 1), blue);
                    Box(model, pivot + new Vector3(0, .9f, -.3f), new Vector3(1.4f, .4f, .35f), steel);
                    Box(model, pivot + new Vector3(0, .9f, -.115f), new Vector3(1.1f, .26f, .02f), screen);
                    Front(root, reversed ? 180 : 0); entries.Add(Save(root, id, reversed ? 180 : 0));
                }
                {
                    GameObject root = Root(scene, "Desk");
                    Box(root, new Vector3(0, .85f, 0), new Vector3(1.6f, .12f, 1), orange);
                    foreach (float x in new[] { -.65f, .65f }) foreach (float z in new[] { -.35f, .35f }) Box(root, new Vector3(x, .4f, z), new Vector3(.12f, .8f, .12f), steel);
                    Front(root, 0); entries.Add(Save(root, "Desk", 0));
                }
                {
                    GameObject root = Root(scene, "Chair");
                    Box(root, new Vector3(0, .45f, 0), new Vector3(.6f, .1f, .6f), blue);
                    Box(root, new Vector3(0, .7f, -.25f), new Vector3(.6f, .5f, .1f), blue);
                    foreach (float x in new[] { -.22f, .22f }) foreach (float z in new[] { -.22f, .22f }) Box(root, new Vector3(x, .2f, z), new Vector3(.07f, .4f, .07f), steel);
                    Front(root, 0); entries.Add(Save(root, "Chair", 0));
                }
                {
                    GameObject root = Root(scene, "Crate"); Box(root, Vector3.up * .55f, new Vector3(.9f, 1.1f, 1.3f), orange); entries.Add(Save(root, "Crate", 0));
                }
                {
                    GameObject root = Root(scene, "Monitor"); Box(root, Vector3.up * .3f, new Vector3(.6f, .6f, .2f), screen); Front(root, 0); entries.Add(Save(root, "Monitor", 0));
                }
                AssetDatabase.SaveAssets(); AssetDatabase.Refresh();
                File.WriteAllText(Path.Combine(Output, "native-catalog.json"), JsonUtility.ToJson(new Catalog { assets = entries.ToArray() }, true));
            }
            finally { EditorSceneManager.ClosePreviewScene(scene); }
            Debug.Log("BAEKHO_PROP_ORIENTATION_PREPARE_PASS"); EditorApplication.Exit(0);
        }
        catch (Exception error) { Debug.LogException(error); EditorApplication.Exit(1); }
    }

    public static void Run()
    {
        try
        {
            Guard(); Assert(SystemInfo.graphicsDeviceType != GraphicsDeviceType.Null, "Native camera output requires a real graphics device");
            Scene active = SceneManager.GetActiveScene(); int roots = active.rootCount, previews = EditorSceneManager.previewSceneCount; bool dirty = active.isDirty;
            VerifyAndRender("before"); VerifyAndRender("after");
            Assert(active == SceneManager.GetActiveScene() && roots == active.rootCount && dirty == active.isDirty && previews == EditorSceneManager.previewSceneCount, "Validation preserves the active scene and closes preview scenes");
            string result = "BAEKHO_PROP_ORIENTATION_UNITY_PASS " + assertions + " assertions; synthetic native prefabs; " + SystemInfo.graphicsDeviceType;
            File.WriteAllText(Path.Combine(Output, "unity-result.txt"), result); Debug.Log(result); EditorApplication.Exit(0);
        }
        catch (Exception error) { Debug.LogException(error); EditorApplication.Exit(1); }
    }

    private static void VerifyAndRender(string phase)
    {
        string input = Folder + "/" + phase + ".baekhomap.json";
        Manifest manifest = JsonUtility.FromJson<Manifest>(File.ReadAllText(input));
        Expected expected = JsonUtility.FromJson<Expected>(File.ReadAllText(Path.Combine(Output, phase + "-expected.json")));
        string prefabPath = BaekhoMapImporter.BuildFromPath(input, false);
        GameObject loaded = PrefabUtility.LoadPrefabContents(prefabPath);
        try
        {
            int seats = 0, calibrated = 0, freeYaw = 0;
            foreach (Prop prop in expected.props)
            {
                Placement placement = Array.Find(manifest.placements, item => item.id == "prop-instance-" + prop.id);
                Assert(placement != null && placement.centerXZ, phase + " exports measured prop " + prop.id);
                Transform instance = loaded.transform.Find(placement.role + "_" + placement.id);
                Assert(instance != null, phase + " imports prop " + prop.id);
                Assert(Quaternion.Angle(instance.localRotation, Quaternion.Euler(placement.rotation)) < .001f, phase + " preserves native yaw " + prop.id);
                Near(instance.localScale, placement.scale, phase + " preserves native scale " + prop.id);
                Bounds bounds = BoundsOf(instance.gameObject); Near(bounds.size, prop.size, phase + " rotated native bounds " + prop.id);
                Near(new Vector3(bounds.center.x, bounds.min.y, bounds.center.z), placement.position, phase + " bottom-center placement " + prop.id);
                if (Mathf.Abs(Mathf.DeltaAngle(placement.rotation.y, Mathf.Round(placement.rotation.y / 90) * 90)) > .01f) freeYaw++;
                if (!prop.checkFront) continue;
                Transform marker = instance.Find("UseFront"); Assert(marker != null, "Native functional fixture supplies an independent front marker");
                Assert(Vector3.Dot(marker.forward, prop.front.normalized) > .999f, "Native functional front agrees with the generated use direction " + prop.id);
                if (placement.prefabGuid == AssetDatabase.AssetPathToGUID(Folder + "/ReversedConsole.prefab")) calibrated++;
                if (prop.behavior == "seat")
                {
                    Transform partner = loaded.transform.Find("prop_prop-instance-" + prop.partnerId); Assert(partner != null, "Seat has a native work-surface partner");
                    Vector3 towards = BoundsOf(partner.gameObject).center - bounds.center; towards.y = 0;
                    Assert(Vector3.Dot(marker.forward, towards.normalized) > .98f, "Native chair faces its actual work surface"); seats++;
                }
            }
            if (phase == "after")
            {
                Assert(seats > 0, "Generated native result contains a complete desk-chair workstation");
                Assert(calibrated > 0, "Generated native result checks an oppositely authored front with nonzero asset correction");
                Assert(freeYaw > 0, "Imported result contains non-cardinal native yaw");
            }
        }
        finally { PrefabUtility.UnloadPrefabContents(loaded); }
        Scene preview = EditorSceneManager.NewPreviewScene();
        try
        {
            GameObject model = PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath), preview) as GameObject;
            Assert(model != null, "Native comparison model loads");
            GameObject cameraObject = Root(preview, "Character eye 1.7m"); Camera camera = cameraObject.AddComponent<Camera>(); camera.scene = preview;
            camera.transform.position = new Vector3(-12, 1.7f, -12); camera.transform.rotation = Quaternion.LookRotation(new Vector3(5, .8f, 7) - camera.transform.position);
            camera.fieldOfView = 70; camera.nearClipPlane = .05f; camera.farClipPlane = 100; camera.backgroundColor = new Color(.13f, .17f, .22f); camera.clearFlags = CameraClearFlags.SolidColor;
            RenderTexture target = new RenderTexture(1440, 900, 24) { antiAliasing = 4 }; camera.targetTexture = target; camera.allowHDR = false;
            GameObject lightObject = Root(preview, "Validation daylight"); Light light = lightObject.AddComponent<Light>(); light.type = LightType.Directional; light.intensity = .9f; light.transform.rotation = Quaternion.Euler(45, -25, 0);
            RenderSettings.ambientMode = AmbientMode.Flat; RenderSettings.ambientLight = new Color(.35f, .37f, .4f); RenderSettings.fog = false;
            RenderTexture previous = RenderTexture.active; Texture2D image = new Texture2D(target.width, target.height, TextureFormat.RGB24, false);
            try
            {
                camera.Render(); RenderTexture.active = target; image.ReadPixels(new Rect(0, 0, target.width, target.height), 0, 0); image.Apply();
                byte[] png = image.EncodeToPNG(); Assert(png.Length > 20000, "Character-eye native render contains scene geometry"); File.WriteAllBytes(Path.Combine(Output, phase + "-synthetic-eye.png"), png);
                if (phase == "after")
                {
                    Prop workstation = Array.Find(expected.props, prop => prop.behavior == "workSurface");
                    if (workstation != null) RenderDetail(camera, model, workstation.id, image, target, "after-workstation-detail.png");
                    Placement reversed = Array.Find(manifest.placements, placement => placement.prefabGuid == AssetDatabase.AssetPathToGUID(Folder + "/ReversedConsole.prefab"));
                    if (reversed != null) RenderDetail(camera, model, reversed.id.Substring("prop-instance-".Length), image, target, "after-reversed-console-detail.png");
                }
            }
            finally { RenderTexture.active = previous; camera.targetTexture = null; target.Release(); UnityEngine.Object.DestroyImmediate(target); UnityEngine.Object.DestroyImmediate(image); }
        }
        finally { EditorSceneManager.ClosePreviewScene(preview); }
    }

    private static void RenderDetail(Camera camera, GameObject model, string propId, Texture2D image, RenderTexture target, string filename)
    {
        Transform prop = model.transform.Find("prop_prop-instance-" + propId); Assert(prop != null, "Detailed native evidence finds its prop");
        Bounds bounds = BoundsOf(prop.gameObject); Transform front = prop.Find("UseFront"); Assert(front != null, "Detailed native evidence has a real front marker");
        Vector3 position = bounds.center + front.forward * 4 + front.right * 2; position.y = bounds.min.y + 1.7f;
        camera.transform.position = position; camera.transform.rotation = Quaternion.LookRotation(bounds.center + Vector3.up * .15f - position);
        camera.Render(); RenderTexture.active = target; image.ReadPixels(new Rect(0, 0, target.width, target.height), 0, 0); image.Apply();
        byte[] png = image.EncodeToPNG(); Assert(png.Length > 20000, "Detailed native evidence contains geometry"); File.WriteAllBytes(Path.Combine(Output, filename), png);
    }

    private static GameObject Root(Scene scene, string name) { GameObject root = new GameObject(name); SceneManager.MoveGameObjectToScene(root, scene); return root; }
    private static void Front(GameObject root, float yaw) { GameObject marker = new GameObject("UseFront"); marker.transform.SetParent(root.transform, false); marker.transform.localRotation = Quaternion.Euler(0, yaw, 0); }
    private static Material MaterialAsset(string name, Color color)
    {
        string path = Folder + "/" + name + ".mat"; Material material = AssetDatabase.LoadAssetAtPath<Material>(path);
        if (material == null) { material = new Material(Shader.Find("Standard")); AssetDatabase.CreateAsset(material, path); }
        material.color = color; material.SetFloat("_Glossiness", .18f); return material;
    }
    private static void Box(GameObject root, Vector3 center, Vector3 size, Material material)
    {
        GameObject box = GameObject.CreatePrimitive(PrimitiveType.Cube); box.transform.SetParent(root.transform, false); box.transform.localPosition = center; box.transform.localScale = size; box.GetComponent<Renderer>().sharedMaterial = material;
    }
    private static Entry Save(GameObject root, string id, float front)
    {
        string path = Folder + "/" + id + ".prefab"; Vector3 size = BoundsOf(root).size; PrefabUtility.SaveAsPrefabAsset(root, path); UnityEngine.Object.DestroyImmediate(root);
        return new Entry { id = id, path = path, guid = AssetDatabase.AssetPathToGUID(path), size = size, nativeFrontYaw = front };
    }
    private static Bounds BoundsOf(GameObject root)
    {
        Renderer[] renderers = root.GetComponentsInChildren<Renderer>(); Assert(renderers.Length > 0, root.name + " has native geometry"); Bounds bounds = renderers[0].bounds;
        for (int index = 1; index < renderers.Length; index++) bounds.Encapsulate(renderers[index].bounds); return bounds;
    }
    private static void Near(Vector3 actual, Vector3 expected, string message) { Assert((actual - expected).magnitude < .003f, message + ": " + actual + " expected " + expected); }
    private static void Assert(bool condition, string message) { assertions++; if (!condition) throw new InvalidOperationException(message); }
}
