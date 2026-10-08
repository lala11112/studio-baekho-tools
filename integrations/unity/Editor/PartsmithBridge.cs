// PARTSMITH MANAGED BRIDGE v1 — generated assets only; never replaces existing user scenes/prefabs.
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using UnityEngine;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine.SceneManagement;
using UnityEngine.Rendering;

namespace Partsmith {
 [Serializable] public class ImportRequest { public int schemaVersion; public string projectId,requestId,source,textureDirectory,destination,resultPath; public int revision; public bool humanoid; }
 [Serializable] public class ImportResult { public string requestId,status,prefabPath,userPrefabPath,scenePath,unityVersion,pipeline,guid; public bool avatarValid,avatarHuman,playbackVerified,runtimePlayModeVerified; public int revision; public string[] clips,runtimeClips,runtimeMovingClips,warnings,errors; }
 [InitializeOnLoad] public static class PartsmithBridge {
  static double next; static bool busy;
  static string Root => Path.GetDirectoryName(Application.dataPath);
  static PartsmithBridge(){ EditorApplication.update+=Tick; }
  static void Tick(){if(busy||EditorApplication.isCompiling||EditorApplication.isUpdating||EditorApplication.isPlayingOrWillChangePlaymode||EditorApplication.timeSinceStartup<next)return;next=EditorApplication.timeSinceStartup+2;
   string folder=Path.Combine(Root,"Library/PartsmithInbox");if(!Directory.Exists(folder))return;
   foreach(string file in Directory.GetFiles(folder,"*.json")){busy=true;try{Process(file);}finally{busy=false;}break;}
  }
  [MenuItem("Tools/Partsmith/Process pending imports")] public static void ProcessPending(){next=0;Tick();}
  [MenuItem("Tools/Partsmith/Open latest test scene")]
  public static void OpenTestScene(){string path=EditorPrefs.GetString("Partsmith.LatestScene."+Root,"");if(!string.IsNullOrEmpty(path)&&File.Exists(path)&&EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo())EditorSceneManager.OpenScene(path);}
  [MenuItem("Tools/Partsmith/Play latest test scene")]
  public static void PlayTestScene(){OpenTestScene();string target=EditorPrefs.GetString("Partsmith.LatestScene."+Root,"");if(SceneManager.GetActiveScene().path==target)EditorApplication.isPlaying=true;}
  static void Folder(string p){Directory.CreateDirectory(Path.Combine(Root,p));}
  static void Process(string file){
   ImportRequest q=null;var warnings=new List<string>();var errors=new List<string>();var r=new ImportResult{status="failed",unityVersion=Application.unityVersion,clips=Array.Empty<string>()};
   try{
    q=JsonUtility.FromJson<ImportRequest>(File.ReadAllText(file));r.requestId=q.requestId;r.revision=q.revision;
    if(q.schemaVersion!=1||!Guid.TryParse(q.projectId,out _)||!Guid.TryParse(q.requestId,out _))throw new Exception("Unsupported request or invalid ID");
    var dest=Path.GetFullPath(Path.Combine(Root,q.destination));if(!q.destination.StartsWith("Assets/")||!dest.StartsWith(Path.GetFullPath(Application.dataPath)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)||!q.destination.EndsWith("/"+q.projectId))throw new Exception("Unsafe destination");
    var resultRoot=Path.GetFullPath(Path.Combine(Root,"Library/PartsmithResults"))+Path.DirectorySeparatorChar;
    if(!Path.GetFullPath(q.resultPath).StartsWith(resultRoot))throw new Exception("Unsafe result path");
    if(Path.GetExtension(q.source).ToLowerInvariant()!=".fbx"||!File.Exists(q.source))throw new Exception("FBX source missing");
    string generated=q.destination+"/Generated";Folder(generated);Folder(q.destination+"/User");
    string modelPath=generated+"/Character.fbx";File.Copy(q.source,Path.Combine(Root,modelPath),true);
    string texturePath=generated+"/Textures";Folder(texturePath);
    if(Directory.Exists(q.textureDirectory))foreach(string texture in Directory.GetFiles(q.textureDirectory,"*.png"))File.Copy(texture,Path.Combine(Root,texturePath,Path.GetFileName(texture)),true);
    AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
    var importer=(ModelImporter)AssetImporter.GetAtPath(modelPath);importer.globalScale=1;importer.useFileScale=true;importer.bakeAxisConversion=true;importer.importAnimation=true;importer.materialImportMode=ModelImporterMaterialImportMode.ImportStandard;
    importer.animationType=q.humanoid?ModelImporterAnimationType.Human:ModelImporterAnimationType.Generic;
    importer.avatarSetup=ModelImporterAvatarSetup.CreateFromThisModel;
    // A replaced mesh can retain the previous FBX's serialized rest skeleton in .meta.
    // Rebuild the managed avatar while retaining the asset GUID and external references.
    if(q.humanoid)importer.humanDescription=new HumanDescription{human=Array.Empty<HumanBone>(),skeleton=Array.Empty<SkeletonBone>(),upperArmTwist=.5f,lowerArmTwist=.5f,upperLegTwist=.5f,lowerLegTwist=.5f,armStretch=.05f,legStretch=.05f};
    importer.SaveAndReimport();
    var defaults=importer.defaultClipAnimations;foreach(var clip in defaults){clip.loopTime=true;clip.lockRootRotation=true;clip.lockRootHeightY=true;clip.lockRootPositionXZ=true;}if(defaults.Length>0){importer.clipAnimations=defaults;importer.SaveAndReimport();}
    // Export embedded materials/textures once, then update persistent URP materials in place.
    importer.ExtractTextures(texturePath);AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
    var model=AssetDatabase.LoadAssetAtPath<GameObject>(modelPath);
    var shader=Shader.Find("Universal Render Pipeline/Lit");r.pipeline=GraphicsSettings.currentRenderPipeline?GraphicsSettings.currentRenderPipeline.GetType().Name:"Built-in";
    if(!shader){shader=Shader.Find("Standard");warnings.Add("URP Lit not found; Standard fallback material.");}
    Folder(generated+"/Materials");
    foreach(var original in model.GetComponentsInChildren<Renderer>(true).SelectMany(x=>x.sharedMaterials).Where(x=>x).Distinct()){
     string name=string.Concat(original.name.Select(c=>char.IsLetterOrDigit(c)||c=='_'?c:'_'));string matPath=generated+"/Materials/"+name+".mat";
     var mat=AssetDatabase.LoadAssetAtPath<Material>(matPath);if(!mat){mat=new Material(shader);AssetDatabase.CreateAsset(mat,matPath);}else mat.shader=shader;
     Color color=original.HasProperty("_BaseColor")?original.GetColor("_BaseColor"):original.HasProperty("_Color")?original.color:Color.white;
     var tex=original.HasProperty("_BaseMap")?original.GetTexture("_BaseMap"):original.mainTexture;
     if(mat.HasProperty("_BaseColor"))mat.SetColor("_BaseColor",color);if(mat.HasProperty("_BaseMap")&&tex)mat.SetTexture("_BaseMap",tex);
     if(original.HasProperty("_BumpMap")&&original.GetTexture("_BumpMap")){mat.SetTexture("_BumpMap",original.GetTexture("_BumpMap"));mat.EnableKeyword("_NORMALMAP");}
     if(original.HasProperty("_MetallicGlossMap")&&original.GetTexture("_MetallicGlossMap")){mat.SetTexture("_MetallicGlossMap",original.GetTexture("_MetallicGlossMap"));mat.EnableKeyword("_METALLICSPECGLOSSMAP");}
     EditorUtility.SetDirty(mat);importer.AddRemap(new AssetImporter.SourceAssetIdentifier(original),mat);
    }
    importer.SaveAndReimport();model=AssetDatabase.LoadAssetAtPath<GameObject>(modelPath);
    var clips=AssetDatabase.LoadAllAssetsAtPath(modelPath).OfType<AnimationClip>().Where(x=>!x.name.StartsWith("__preview__")).ToArray();r.clips=clips.Select(x=>x.name).ToArray();
    var avatar=AssetDatabase.LoadAllAssetsAtPath(modelPath).OfType<Avatar>().FirstOrDefault();r.avatarValid=avatar&&avatar.isValid;r.avatarHuman=avatar&&avatar.isHuman;
    if(!r.avatarValid||!r.avatarHuman)warnings.Add("Human Avatar invalid or absent. Configure bones / T-pose in the model importer.");
    if(clips.Length==0)warnings.Add("No animation clips found.");
    string controllerPath=generated+"/Character.controller";var controller=AssetDatabase.LoadAssetAtPath<AnimatorController>(controllerPath)??AnimatorController.CreateAnimatorControllerAtPath(controllerPath);
    var sm=controller.layers[0].stateMachine;
    foreach(var old in sm.states.Where(s=>!clips.Any(c=>c.name==s.state.name)).ToArray())sm.RemoveState(old.state);
    foreach(var clip in clips){var state=sm.states.Select(s=>s.state).FirstOrDefault(s=>s.name==clip.name)??sm.AddState(clip.name);state.motion=clip;}
    if(sm.states.Length>0)sm.defaultState=sm.states.FirstOrDefault(s=>s.state.name.ToLower().Contains("idle")).state??sm.states[0].state;
    EditorUtility.SetDirty(controller);AssetDatabase.SaveAssets();
    var staging=EditorSceneManager.NewPreviewScene();
    try {
    var instance=(GameObject)PrefabUtility.InstantiatePrefab(model,staging);instance.name="Character";
    var animator=instance.GetComponent<Animator>()??instance.AddComponent<Animator>();animator.avatar=avatar;animator.runtimeAnimatorController=controller;animator.applyRootMotion=false;
    r.prefabPath=generated+"/Character.prefab";PrefabUtility.SaveAsPrefabAsset(instance,r.prefabPath);UnityEngine.Object.DestroyImmediate(instance);
    r.userPrefabPath=q.destination+"/User/Character.prefab";
    if(!File.Exists(r.userPrefabPath)){var variant=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(r.prefabPath),staging);PrefabUtility.SaveAsPrefabAsset(variant,r.userPrefabPath);UnityEngine.Object.DestroyImmediate(variant);}
    } finally { EditorSceneManager.ClosePreviewScene(staging); }
    r.guid=AssetDatabase.AssetPathToGUID(r.prefabPath);
    // Additive isolated scene: leave the user's active scene and unsaved edits intact.
    var previous=SceneManager.GetActiveScene();var scene=EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Additive);
    try{
     SceneManager.SetActiveScene(scene);var character=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(r.prefabPath),scene);
     var ground=GameObject.CreatePrimitive(PrimitiveType.Plane);ground.name="Preview Ground";ground.transform.localScale=Vector3.one*.35f;
     var light=new GameObject("Preview Light").AddComponent<Light>();light.type=LightType.Directional;light.intensity=2;light.transform.rotation=Quaternion.Euler(45,-30,0);
     var camera=new GameObject("Preview Camera").AddComponent<Camera>();camera.tag="MainCamera";camera.transform.position=new Vector3(2,1.6f,-3);camera.transform.LookAt(new Vector3(0,.9f,0));camera.backgroundColor=new Color(.055f,.07f,.065f);camera.clearFlags=CameraClearFlags.SolidColor;
     var testAnimator=character.GetComponent<Animator>();testAnimator.cullingMode=AnimatorCullingMode.AlwaysAnimate;
     if(clips.Length>0&&testAnimator.avatar&&testAnimator.avatar.isValid){testAnimator.Rebind();testAnimator.Update(0);testAnimator.Play(sm.defaultState.name,0,0);testAnimator.Update(.25f);r.playbackVerified=testAnimator.GetCurrentAnimatorStateInfo(0).normalizedTime>0;}
     r.scenePath=generated+"/CharacterTest.unity";EditorSceneManager.SaveScene(scene,r.scenePath);
    } finally {EditorSceneManager.CloseScene(scene,true);if(previous.IsValid())SceneManager.SetActiveScene(previous);}
    if(!r.playbackVerified)warnings.Add("Animator evaluation did not confirm playback; inspect the test scene.");
    EditorPrefs.SetString("Partsmith.LatestScene."+Root,r.scenePath);AssetDatabase.SaveAssets();
    warnings.Add("Visual review still required: joint deformation, surface seams, hair attachment, texture maps and orientation.");
    r.status=r.avatarValid&&r.avatarHuman&&r.playbackVerified?"complete_review_required":"correction_required";
   }catch(Exception e){errors.Add(e.Message);Debug.LogError("Partsmith import: "+e.Message);}
   r.warnings=warnings.ToArray();r.errors=errors.ToArray();
   // Never honor an unchecked result path, including on validation failure.
   string output=Path.Combine(Root,"Library/PartsmithResults",Path.GetFileNameWithoutExtension(file)+".json");Directory.CreateDirectory(Path.GetDirectoryName(output));File.WriteAllText(output,JsonUtility.ToJson(r,true));
   File.Move(file,file+".processed");
   if(errors.Count==0 && r.avatarValid && r.clips.Length>0)File.WriteAllText(Path.Combine(Root,"Library/PartsmithResults/verify-play.json"),output);
  }
 }
}
