using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace StudioBaekho.CombatLab.Example
{
    public static class ExampleSceneSetup
    {
        [MenuItem("Tools/Baekho/Combat Lab Example/Create Demo Scene")]
        public static void CreateDemoScene()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode) throw new System.InvalidOperationException("편집 모드에서 예제 씬을 만드세요.");
            if (!EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo()) return;
            // Changing scenes can unload assets without a scene reference. Create the SO afterwards.
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            const string folder = "Assets/CombatLabExampleData";
            if (!AssetDatabase.IsValidFolder(folder)) AssetDatabase.CreateFolder("Assets", "CombatLabExampleData");
            var data = ScriptableObject.CreateInstance<ExampleActionData>();
            data.name = "Example Strike";
            AssetDatabase.CreateAsset(data, AssetDatabase.GenerateUniqueAssetPath(folder + "/Example Strike.asset"));
            AssetDatabase.SaveAssetIfDirty(data);
            var cameraObject = new GameObject("Main Camera");
            cameraObject.tag = "MainCamera";
            var camera = cameraObject.AddComponent<Camera>();
            camera.transform.position = new Vector3(0.5f, 6f, -10f);
            camera.transform.LookAt(new Vector3(0.5f, 0.5f, 0f));
            camera.orthographic = true;
            camera.orthographicSize = 4f;
            camera.backgroundColor = new Color(0.13f, 0.17f, 0.22f);
            camera.clearFlags = CameraClearFlags.SolidColor;
            cameraObject.AddComponent<AudioListener>();
            var light = new GameObject("Directional Light").AddComponent<Light>();
            light.type = LightType.Directional;
            light.transform.rotation = Quaternion.Euler(45f, -30f, 0f);
            var floor = GameObject.CreatePrimitive(PrimitiveType.Cube);
            floor.name = "Training Floor";
            floor.transform.position = new Vector3(0f, -0.2f, 0f);
            floor.transform.localScale = new Vector3(12f, 0.2f, 5f);
            var player = GameObject.CreatePrimitive(PrimitiveType.Capsule);
            player.name = "Example Player";
            player.transform.position = new Vector3(-1f, 1f, 0f);
            var actor = player.AddComponent<ExampleCombatActor>();
            actor.actionData = data;
            var targetObject = GameObject.CreatePrimitive(PrimitiveType.Cube);
            targetObject.name = "Example Training Target";
            targetObject.transform.position = new Vector3(1f, 1f, 0f);
            targetObject.transform.localScale = new Vector3(0.8f, 1.5f, 0.8f);
            actor.target = targetObject.AddComponent<ExampleCombatTarget>();
            var weapon = GameObject.CreatePrimitive(PrimitiveType.Cube);
            weapon.name = "Example Weapon";
            weapon.transform.SetParent(player.transform, false);
            weapon.transform.localPosition = new Vector3(0.6f, 0.1f, 0f);
            weapon.transform.localScale = new Vector3(0.8f, 0.15f, 0.15f);
            actor.weapon = weapon.transform;
            string path = AssetDatabase.GenerateUniqueAssetPath(folder + "/Combat Lab Example.unity");
            if (!EditorSceneManager.SaveScene(scene, path)) throw new System.IO.IOException("예제 씬 저장에 실패했습니다.");
            Selection.activeGameObject = player;
            Debug.Log("Combat Lab example ready: " + path + ". Select the Example adapter in Baekho Studio.");
        }
    }
}
