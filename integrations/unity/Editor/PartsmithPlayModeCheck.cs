// PARTSMITH MANAGED BRIDGE v1 — actual Play Mode verification; preserves scene setup.
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using UnityEngine;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine.SceneManagement;
using UnityEngine.Rendering;
namespace Partsmith {
 [InitializeOnLoad] public static class PartsmithPlayModeCheck {
  static string Root => Path.GetDirectoryName(Application.dataPath);
  static double started; static int index=-1; static bool finishing;
  static readonly List<string> verified=new List<string>();
  static readonly List<string> moving=new List<string>();
  static Transform[] bones; static Quaternion[] pose; static Vector3[] positions; static bool currentMoved;
  static PartsmithPlayModeCheck(){EditorApplication.update+=Tick;EditorApplication.playModeStateChanged+=Changed;}
  static void Changed(PlayModeStateChange state){
   if(state==PlayModeStateChange.EnteredPlayMode){started=EditorApplication.timeSinceStartup;index=-1;finishing=false;verified.Clear();moving.Clear();}
   if(state==PlayModeStateChange.EnteredEditMode&&SessionState.GetBool("Partsmith.Check.Active",false)){
    EditorSceneManager.playModeStartScene=AssetDatabase.LoadAssetAtPath<SceneAsset>(SessionState.GetString("Partsmith.Check.Previous",""));
    SessionState.SetBool("Partsmith.Check.Active",false);finishing=false;
   }
  }
  static void Tick(){
   if(EditorApplication.isCompiling||EditorApplication.isUpdating)return;
   if(SessionState.GetBool("Partsmith.Check.Active",false)){
    if(EditorApplication.isPlaying){Application.runInBackground=true;EditorApplication.QueuePlayerLoopUpdate();}
    if(!EditorApplication.isPlaying||finishing||EditorApplication.timeSinceStartup-started<.35)return;
    string file=SessionState.GetString("Partsmith.Check.Result","");
    try{
     var report=JsonUtility.FromJson<ImportResult>(File.ReadAllText(file));
     var animator=UnityEngine.Object.FindObjectsByType<Animator>(FindObjectsSortMode.None).FirstOrDefault(a=>a.runtimeAnimatorController);
     if(animator && index>=0 && animator.isActiveAndEnabled){
      if(bones!=null&&bones.Where((b,i)=>Quaternion.Angle(b.localRotation,pose[i])>.01f||Vector3.Distance(b.localPosition,positions[i])>.0001f).Any())currentMoved=true;
      var activeClip=animator.runtimeAnimatorController.animationClips.FirstOrDefault(c=>c.name==report.clips[index]);
      if(EditorApplication.timeSinceStartup-started<Math.Max(.35,activeClip?activeClip.length*2:.35))return;
      var state=animator.GetCurrentAnimatorStateInfo(0);if(state.IsName(report.clips[index])&&state.normalizedTime>0)verified.Add(report.clips[index]);if(currentMoved)moving.Add(report.clips[index]);}
     index++;
     if(animator&&index<report.clips.Length){animator.Play(report.clips[index],0,0);animator.Update(0);bones=animator.GetComponentsInChildren<SkinnedMeshRenderer>().SelectMany(r=>r.bones).Where(b=>b).Distinct().ToArray();pose=bones.Select(b=>b.localRotation).ToArray();positions=bones.Select(b=>b.localPosition).ToArray();currentMoved=false;started=EditorApplication.timeSinceStartup;return;}
     report.runtimeClips=verified.ToArray();report.runtimeMovingClips=moving.ToArray();report.runtimePlayModeVerified=report.clips.Length>0&&verified.Count==report.clips.Length;
     if(report.runtimePlayModeVerified){report.warnings=report.warnings.Where(w=>!w.StartsWith("Animator evaluation did not")).ToArray();if(report.avatarValid&&(report.rigType=="generic"||report.avatarHuman)&&report.errors.Length==0&&moving.Count==report.clips.Length)report.status="complete_review_required";}
     else report.warnings=report.warnings.Concat(new[]{"Actual Play Mode did not advance every animation state."}).ToArray();
     File.WriteAllText(file,JsonUtility.ToJson(report,true));Capture(Path.ChangeExtension(file,".png"));
    }catch(Exception e){Debug.LogError("Partsmith Play check: "+e.Message);}
    finishing=true;EditorApplication.isPlaying=false;return;
   }
   if(EditorApplication.isPlayingOrWillChangePlaymode)return;
   string trigger=Path.Combine(Root,"Library/PartsmithResults/verify-play.json");if(!File.Exists(trigger))return;
   string result=File.ReadAllText(trigger).Trim();File.Delete(trigger);
   string allowed=Path.GetFullPath(Path.Combine(Root,"Library/PartsmithResults"))+Path.DirectorySeparatorChar;
   if(!Path.GetFullPath(result).StartsWith(allowed,StringComparison.OrdinalIgnoreCase))return;
   var r=JsonUtility.FromJson<ImportResult>(File.ReadAllText(result));
   if(Enumerable.Range(0,SceneManager.sceneCount).Any(i=>SceneManager.GetSceneAt(i).isDirty)){
    r.warnings=r.warnings.Concat(new[]{"Actual Play Mode check skipped: an open user scene has unsaved changes. Save it, then reimport."}).ToArray();File.WriteAllText(result,JsonUtility.ToJson(r,true));return;
   }
   var scene=AssetDatabase.LoadAssetAtPath<SceneAsset>(r.scenePath);if(!scene)return;
   SessionState.SetString("Partsmith.Check.Result",result);SessionState.SetString("Partsmith.Check.Previous",AssetDatabase.GetAssetPath(EditorSceneManager.playModeStartScene));
   SessionState.SetBool("Partsmith.Check.Active",true);EditorSceneManager.playModeStartScene=scene;EditorApplication.isPlaying=true;
  }
  static void Capture(string file){
   var camera=Camera.main;if(!camera)return;
   var rt=new RenderTexture(1000,800,24);var previous=RenderTexture.active;Texture2D tex=null;
   try{
    if(GraphicsSettings.currentRenderPipeline){var request=new RenderPipeline.StandardRequest{destination=rt};RenderPipeline.SubmitRenderRequest(camera,request);}
    else {camera.targetTexture=rt;camera.Render();camera.targetTexture=null;}
    RenderTexture.active=rt;tex=new Texture2D(1000,800,TextureFormat.RGB24,false);tex.ReadPixels(new Rect(0,0,1000,800),0,0);tex.Apply();File.WriteAllBytes(file,tex.EncodeToPNG());
   }finally{RenderTexture.active=previous;if(tex)UnityEngine.Object.DestroyImmediate(tex);rt.Release();UnityEngine.Object.DestroyImmediate(rt);}
  }
 }
}
