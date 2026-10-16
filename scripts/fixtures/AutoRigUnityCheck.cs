// Isolated actual app-produced ARP FBX delivery. Never enter Play Mode.
using System;
using System.IO;
using System.Linq;
using UnityEngine;
using UnityEditor;
using UnityEditor.SceneManagement;

public static class AutoRigUnityCheck
{
 [Serializable] class Binding { public string humanName,boneName; }
 [Serializable] class Request { public string destination; public bool secondPass; public Binding[] mapping; public Vector3 expectedDimensions; }
 [Serializable] class Result { public bool passed,playMode,avatarValid,avatarHuman,exactMapping,userComponentPreserved,sceneReferencePreserved; public string generatedGuid,userGuid,sourceGuid; public int renderers,vertices,triangles,weightedVertices,invalidWeights; public float maximumWeightSumError; public Vector3 dimensions; public Binding[] actualMapping; }
 static string Root => Directory.GetParent(Application.dataPath).FullName;
 static void Need(bool value,string message){if(!value)throw new Exception(message);}
 public static void Run(){
  Need(!EditorApplication.isPlaying,"Play Mode forbidden");
  var q=JsonUtility.FromJson<Request>(File.ReadAllText(Path.Combine(Root,"Library/AutoRigCheckRequest.json")));
  Partsmith.Graphics.PartsmithGraphicsBridge.ProcessAllForBatch();AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
  string generated=q.destination+"/Generated/Asset.prefab",user=q.destination+"/User/Asset.prefab",scene="Assets/AutoRigReference.unity";
  Need(AssetDatabase.LoadAssetAtPath<GameObject>(generated),"Generated prefab absent");
  if(!q.secondPass){
   var editable=PrefabUtility.LoadPrefabContents(user);
   try{var mark=editable.GetComponent<AutoRigUserMarker>();if(!mark)mark=editable.AddComponent<AutoRigUserMarker>();mark.token="arp-user-owned-keep";mark.amount=37;PrefabUtility.SaveAsPrefabAsset(editable,user);}finally{PrefabUtility.UnloadPrefabContents(editable);}
   EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(user));EditorSceneManager.SaveScene(UnityEngine.SceneManagement.SceneManager.GetActiveScene(),scene);
  }
  EditorSceneManager.OpenScene(scene);var marker=UnityEngine.Object.FindFirstObjectByType<AutoRigUserMarker>();
  Need(marker&&marker.token=="arp-user-owned-keep"&&marker.amount==37,"User component lost");
  Need(PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(marker.gameObject)==user,"Scene prefab reference lost");
  var model=marker.gameObject;var animator=model.GetComponentInChildren<Animator>(true);Need(animator&&animator.avatar,"Avatar missing");
  var result=new Result{playMode=false,avatarValid=animator.avatar.isValid,avatarHuman=animator.avatar.isHuman,generatedGuid=AssetDatabase.AssetPathToGUID(generated),userGuid=AssetDatabase.AssetPathToGUID(user),userComponentPreserved=true,sceneReferencePreserved=true};
  Need(result.avatarValid&&result.avatarHuman,"Avatar invalid/nonhuman");
  result.actualMapping=q.mapping.Select(b=>{var t=animator.GetBoneTransform((HumanBodyBones)Enum.Parse(typeof(HumanBodyBones),b.humanName));return new Binding{humanName=b.humanName,boneName=t?t.name:null};}).ToArray();
  result.exactMapping=result.actualMapping.Zip(q.mapping,(a,b)=>a.boneName==b.boneName&&a.humanName==b.humanName).All(v=>v);Need(result.exactMapping,"Avatar bone mapping differs");
  bool first=true;var bounds=new Bounds();
  foreach(var skin in model.GetComponentsInChildren<SkinnedMeshRenderer>(true)){
   var mesh=skin.sharedMesh;Need(mesh,"Skin mesh missing");result.renderers++;result.vertices+=mesh.vertexCount;result.triangles+=mesh.triangles.Length/3;
   var per=mesh.GetBonesPerVertex();var weights=mesh.GetAllBoneWeights();int offset=0;
   try{foreach(var count in per){float sum=0;bool bad=false;for(int i=0;i<count;i++){var w=weights[offset++];sum+=w.weight;if(float.IsNaN(w.weight)||float.IsInfinity(w.weight)||w.weight<0||w.boneIndex<0||w.boneIndex>=skin.bones.Length||!skin.bones[w.boneIndex])bad=true;}if(sum>0)result.weightedVertices++;float error=Math.Abs(sum-1);result.maximumWeightSumError=Math.Max(result.maximumWeightSumError,error);if(bad||error>.001f)result.invalidWeights++;}}finally{per.Dispose();weights.Dispose();}
   var baked=new Mesh();skin.BakeMesh(baked);foreach(var vertex in baked.vertices){var point=skin.transform.TransformPoint(vertex);if(first){bounds=new Bounds(point,Vector3.zero);first=false;}else bounds.Encapsulate(point);}UnityEngine.Object.DestroyImmediate(baked);
  }
  Need(result.renderers>0&&result.vertices==result.weightedVertices&&result.invalidWeights==0,"Unweighted/invalid skin vertices");
  result.dimensions=bounds.size;for(int axis=0;axis<3;axis++)Need(Math.Abs(result.dimensions[axis]-q.expectedDimensions[axis])<=Math.Max(.001f,q.expectedDimensions[axis]*.001f),"Rest dimensions changed axis "+axis);
  result.passed=true;var output=Path.Combine(Root,"AutoRigEvidence");Directory.CreateDirectory(output);File.WriteAllText(Path.Combine(output,q.secondPass?"reimport.json":"import.json"),JsonUtility.ToJson(result,true));
 }
}
