// Copied ONLY to the isolated planar verification Unity project.
using System;
using System.IO;
using System.Linq;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEditor;
using UnityEditor.SceneManagement;

public static class PlanarUnityCheck
{
    [Serializable] class Request { public string destination; public int expectedTriangles, expectedMeshes; public Vector3 expectedDimensions; public bool secondPass; }
    [Serializable] class Result { public bool passed, playMode, userComponentPreserved, sceneReferencePreserved; public int triangles, vertices, meshes, materials, invalidUVTriangles; public Vector3 dimensions; public string generatedGuid, userGuid, userToken, scenePath; public string[] renders; }
    static string Root => Directory.GetParent(Application.dataPath).FullName;
    static void Need(bool condition, string message) { if(!condition) throw new Exception(message); }
    public static void Run()
    {
        var absent=Partsmith.Graphics.PartsmithGraphicsBridge.ParseDeliveryRequest("{\"schemaVersion\":1,\"rigType\":\"generic\"}");Need(absent.rigContract==null,"Absent rig contract was synthesized");
        var textOnly=Partsmith.Graphics.PartsmithGraphicsBridge.ParseDeliveryRequest("{\"schemaVersion\":1,\"objectName\":\"{\\\"rigContract\\\":{}}\",\"rigType\":\"generic\"}");Need(textOnly.rigContract==null,"A property name inside a string became a contract");
        var nestedOnly=Partsmith.Graphics.PartsmithGraphicsBridge.ParseDeliveryRequest("{\"optimization\":{\"rigContract\":{}},\"rigType\":\"generic\"}");Need(nestedOnly.rigContract==null,"A nested property became a root contract");
        foreach(var partial in new[]{"{}","{\"rigType\":\"generic\"}","{\"schemaVersion\":1,\"rigType\":\"humanoid\"}"}){
            bool rejected=false;try{Partsmith.Graphics.PartsmithGraphicsBridge.ParseDeliveryRequest("{\"rigContract\":"+partial+"}");}catch(Exception){rejected=true;}Need(rejected,"Partial rig contract was accepted");
        }
        var valid=Partsmith.Graphics.PartsmithGraphicsBridge.ParseDeliveryRequest("{\"rigContract\":{\"schemaVersion\":1,\"versionId\":\"rig\",\"producerVersionId\":\"producer\",\"producerTaskId\":\"task\",\"rigType\":\"generic\",\"hairBinding\":\"head\",\"requiredParts\":[],\"humanBones\":[]}}");Need(valid.rigContract.rigType=="generic","Valid explicit rig contract changed");
        var q=JsonUtility.FromJson<Request>(File.ReadAllText(Path.Combine(Root,"Library/PlanarCheckRequest.json")));
        Need(!EditorApplication.isPlaying,"Do not enter Play Mode");
        Partsmith.Graphics.PartsmithGraphicsBridge.ProcessAllForBatch();
        AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
        string generated=q.destination+"/Generated/Asset.prefab",user=q.destination+"/User/Asset.prefab";
        var prefab=AssetDatabase.LoadAssetAtPath<GameObject>(generated);Need(prefab,"Generated prefab missing");
        string scenePath="Assets/PlanarReference.unity";
        if(!q.secondPass) {
            var editable=PrefabUtility.LoadPrefabContents(user);
            try { var marker=editable.GetComponent<PlanarUserMarker>();if(!marker)marker=editable.AddComponent<PlanarUserMarker>();marker.token="user-owned-planar-927";marker.amount=37;PrefabUtility.SaveAsPrefabAsset(editable,user); }
            finally { PrefabUtility.UnloadPrefabContents(editable); }
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);
            PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(user));
            EditorSceneManager.SaveScene(UnityEngine.SceneManagement.SceneManager.GetActiveScene(),scenePath);
        }
        EditorSceneManager.OpenScene(scenePath);
        var markerInScene=UnityEngine.Object.FindFirstObjectByType<PlanarUserMarker>();
        Need(markerInScene && markerInScene.token=="user-owned-planar-927" && markerInScene.amount==37,"User component lost after delivery");
        var model=markerInScene.gameObject;
        Need(PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(model)==user,"Scene no longer references the user prefab");
        var renderers=model.GetComponentsInChildren<Renderer>(true);Need(renderers.Length>0,"No renderer");
        var bounds=renderers[0].bounds;foreach(var r in renderers)bounds.Encapsulate(r.bounds);
        var result=new Result { playMode=false,generatedGuid=AssetDatabase.AssetPathToGUID(generated),userGuid=AssetDatabase.AssetPathToGUID(user),userToken=markerInScene.token,userComponentPreserved=true,sceneReferencePreserved=true,scenePath=scenePath,dimensions=bounds.size };
        foreach(var filter in model.GetComponentsInChildren<MeshFilter>(true)) {
            var mesh=filter.sharedMesh;Need(mesh,"Missing mesh");result.meshes++;result.vertices+=mesh.vertexCount;
            var uv=mesh.uv;Need(uv.Length==mesh.vertexCount,"Imported mesh missing UVs");
            var indices=mesh.triangles;result.triangles+=indices.Length/3;
            for(int i=0;i<indices.Length;i+=3){var a=uv[indices[i]];var b=uv[indices[i+1]];var c=uv[indices[i+2]];if(Math.Abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x))<=1e-12)result.invalidUVTriangles++;}
        }
        Need(result.invalidUVTriangles==0,"Imported triangles have degenerate UVs");
        Need(result.triangles==q.expectedTriangles,"Imported triangle count differs from the exact repaired GLB");
        Need(result.meshes==q.expectedMeshes,"Imported mesh count differs from the repaired GLB");
        for(int axis=0;axis<3;axis++)Need(Math.Abs(result.dimensions[axis]-q.expectedDimensions[axis])<=Math.Max(.001,q.expectedDimensions[axis]*.001),"Imported dimensions differ from exact delivery: axis "+axis);
        var materials=renderers.SelectMany(r=>r.sharedMaterials).Distinct().ToArray();result.materials=materials.Length;
        Need(materials.Length>0 && materials.All(m=>m && m.shader && m.shader.name=="Universal Render Pipeline/Lit"),"Material is missing or not URP Lit");
        var cameraObject=new GameObject("VerificationCamera");var camera=cameraObject.AddComponent<Camera>();camera.clearFlags=CameraClearFlags.SolidColor;camera.backgroundColor=new Color(.055f,.075f,.085f);camera.orthographic=true;camera.orthographicSize=bounds.size.magnitude*.55f;camera.nearClipPlane=.001f;camera.farClipPlane=Mathf.Max(20,bounds.size.magnitude*10);camera.enabled=false;
        cameraObject.AddComponent<UniversalAdditionalCameraData>();
        var lightObject=new GameObject("VerificationLight");var light=lightObject.AddComponent<Light>();light.type=LightType.Directional;light.intensity=2;lightObject.transform.rotation=Quaternion.Euler(35,-35,0);RenderSettings.ambientMode=AmbientMode.Flat;RenderSettings.ambientLight=new Color(.45f,.45f,.45f);
        var directions=new[]{new Vector3(1,.4f,1),Vector3.right,Vector3.back,Vector3.forward};
        var names=new[]{"oblique","x","minus-z","z"};string output=Path.Combine(Root,"PlanarEvidence");Directory.CreateDirectory(output);
        for(int i=0;i<names.Length;i++) {
            camera.transform.position=bounds.center+directions[i].normalized*bounds.size.magnitude*2;camera.transform.LookAt(bounds.center);
            var rt=new RenderTexture(1024,768,24,RenderTextureFormat.ARGB32);rt.Create();
            var request=new UniversalRenderPipeline.SingleCameraRequest { destination=rt };
            Need(RenderPipeline.SupportsRenderRequest(camera,request),"URP cannot render this audit camera");
            RenderPipeline.SubmitRenderRequest(camera,request);
            var previous=RenderTexture.active;RenderTexture.active=rt;var image=new Texture2D(1024,768,TextureFormat.RGB24,false);image.ReadPixels(new Rect(0,0,1024,768),0,0);image.Apply();
            File.WriteAllBytes(Path.Combine(output,(q.secondPass?"reimport-":"import-")+names[i]+".png"),image.EncodeToPNG());
            RenderTexture.active=previous;UnityEngine.Object.DestroyImmediate(image);rt.Release();UnityEngine.Object.DestroyImmediate(rt);
        }
        result.renders=names;result.passed=true;
        File.WriteAllText(Path.Combine(output,q.secondPass?"reimport.json":"import.json"),JsonUtility.ToJson(result,true));
    }
}
