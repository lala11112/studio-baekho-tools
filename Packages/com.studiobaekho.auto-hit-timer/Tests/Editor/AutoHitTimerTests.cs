using System;
using System.Linq;
using System.IO;
using System.Reflection;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace StudioBaekho.AutoHitTimer.Tests
{
    public class AutoHitTimerTests
    {
        [Test]
        public void CaptureTimesIncludeExactEndAndSortRefinementSamples()
        {
            var times = AutoHitTimerCapture.BuildTimes(1.01, 24, null);
            Assert.That(times.First(), Is.Zero);
            Assert.That(times.Last(), Is.EqualTo(1.01));
            Assert.That(times.Count, Is.EqualTo(26));
            CollectionAssert.AreEqual(new[] { 0.2, 0.7 }, AutoHitTimerCapture.BuildTimes(1, 60, new JArray(0.7, 0.2, 0.7)));
        }

        [Test]
        public void CaptureRejectsInvalidAndOversizedTimes()
        {
            Assert.Throws<AutoHitTimerException>(() => AutoHitTimerCapture.BuildTimes(1, 24, new JArray(-0.1)));
            Assert.Throws<AutoHitTimerException>(() => AutoHitTimerCapture.BuildTimes(1, 24, new JArray(2)));
            Assert.Throws<AutoHitTimerException>(() => AutoHitTimerCapture.BuildTimes(1000, 60, null));
            Assert.Throws<AutoHitTimerException>(() => AutoHitTimerCapture.BuildTimes(1, 60, new JArray()));
        }

        [Test]
        public void EnvelopeRejectsMismatchedIdsAndVersions()
        {
            var id = Guid.NewGuid().ToString("D");
            var envelope = new JObject { ["id"] = id, ["protocolVersion"] = 1, ["command"] = "status", ["payloadJson"] = "{}", ["expiresUtcMs"] = 9999999999999L };
            Assert.DoesNotThrow(() => AutoHitTimerBridge.ValidateEnvelope(envelope, id));
            Assert.Throws<AutoHitTimerException>(() => AutoHitTimerBridge.ValidateEnvelope(envelope, Guid.NewGuid().ToString("D")));
            envelope["protocolVersion"] = 2;
            Assert.Throws<AutoHitTimerException>(() => AutoHitTimerBridge.ValidateEnvelope(envelope, id));
        }

        sealed class CountingAdapter : IAutoHitTimerAdapter
        {
            public string Id => "tests-" + GetHashCode();
            public int Calls;
            public JObject Targets(string actorId) => new JObject();
            public JObject PreviewChange(JObject request) => new JObject();
            public JObject SaveStatus(JObject request) => new JObject { ["status"] = "missing" };
            public JObject Apply(JObject request) { Calls++; return new JObject { ["saved"] = true }; }
        }

        [Test]
        public void CompletedMailboxRequestReplaysReceiptWithoutRepeatingMutation()
        {
            var adapter = new CountingAdapter();
            AutoHitTimerAdapters.Register(adapter);
            var id = Guid.NewGuid().ToString("D");
            var readId = Guid.NewGuid().ToString("D");
            var request = new JObject { ["id"] = id, ["protocolVersion"] = 1, ["command"] = "apply", ["payloadJson"] = new JObject { ["adapterId"] = adapter.Id }.ToString(), ["expiresUtcMs"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 60000 };
            var path = Path.Combine(AutoHitTimerBridge.RootPath, "requests", id + ".json");
            var responsePath = Path.Combine(AutoHitTimerBridge.RootPath, "responses", id + ".json");
            var process = typeof(AutoHitTimerBridge).GetMethod("Process", BindingFlags.NonPublic | BindingFlags.Static);
            try
            {
                File.WriteAllText(path, request.ToString());
                process.Invoke(null, new object[] { path });
                Assert.That(adapter.Calls, Is.EqualTo(1));
                var original = File.ReadAllText(responsePath);
                File.Delete(responsePath);
                File.WriteAllText(path, request.ToString());
                process.Invoke(null, new object[] { path });
                Assert.That(adapter.Calls, Is.EqualTo(1));
                Assert.That(File.ReadAllText(responsePath), Is.EqualTo(original));
                request["id"] = readId;
                request["command"] = "saveStatus";
                var readPath = Path.Combine(AutoHitTimerBridge.RootPath, "requests", readId + ".json");
                File.WriteAllText(readPath, request.ToString());
                process.Invoke(null, new object[] { readPath });
                var recovered = JObject.Parse(File.ReadAllText(Path.Combine(AutoHitTimerBridge.RootPath, "responses", readId + ".json")));
                Assert.That((bool)recovered["ok"], Is.True);
                Assert.That((string)JObject.Parse((string)recovered["resultJson"])["status"], Is.EqualTo("missing"));
                Assert.That(adapter.Calls, Is.EqualTo(1), "status lookup must not apply a mutation");
            }
            finally
            {
                foreach (var requestId in new[] { id, readId })
                foreach (var subfolder in new[] { "requests", "processing", "responses", "receipts" })
                {
                    var file = Path.Combine(AutoHitTimerBridge.RootPath, subfolder, requestId + ".json");
                    if (File.Exists(file)) File.Delete(file);
                }
            }
        }

        [Test]
        public void StateCompatibilityRejectsTimeRemappingAndBlendTrees()
        {
            var state = new AnimatorState();
            var clip = new AnimationClip();
            try
            {
                state.motion = clip;
                Assert.That(AutoHitTimerAssets.StateReason(state, 0), Is.Null);
                state.speed = 1.5f;
                Assert.That(AutoHitTimerAssets.StateReason(state, 0), Is.Not.Null);
                state.speed = 1f;
                state.timeParameterActive = true;
                Assert.That(AutoHitTimerAssets.StateReason(state, 0), Is.Not.Null);
                state.timeParameterActive = false;
                state.cycleOffset = 0.2f;
                Assert.That(AutoHitTimerAssets.StateReason(state, 0), Is.Not.Null);
                state.cycleOffset = 0;
                Assert.That(AutoHitTimerAssets.StateReason(state, 1), Is.Not.Null);
                state.motion = null;
                Assert.That(AutoHitTimerAssets.StateReason(state, 0), Is.Not.Null);
            }
            finally { UnityEngine.Object.DestroyImmediate(state); UnityEngine.Object.DestroyImmediate(clip); }
        }

        [Test]
        public void AnimationSearchPagesCoverEveryClipOnceAndFinishAtAnExactPageBoundary()
        {
            var folder = CreateSearchFolder();
            try
            {
                // Asset creation order differs from display order, and two takes share a name.
                var last = CreateSearchClip(folder + "/z-last.anim", "Last");
                var first = CreateSearchClip(folder + "/a-first.anim", "First");
                var middle = CreateSearchClip(folder + "/m-takes.anim", "Main");
                var takes = new[] { SearchClip("Same take"), SearchClip("Same take"), SearchClip("Other take") };
                foreach (var take in takes) AssetDatabase.AddObjectToAsset(take, middle);
                AssetDatabase.AddObjectToAsset(SearchClip("__preview__Main"), middle);
                AssetDatabase.SaveAssets();
                var expected = new[] { first, middle, last }.Concat(takes).Select(clip => SearchRowKey(AutoHitTimerAssets.ClipRef(clip))).ToArray();
                var rows = new JArray();
                var offset = 0;
                for (var pageIndex = 0; pageIndex < 3; pageIndex++)
                {
                    var request = new JObject { ["query"] = folder, ["offset"] = offset, ["limit"] = 2 };
                    var page = AutoHitTimerAssets.Search(request);
                    Assert.That(page.ToString(), Is.EqualTo(AutoHitTimerAssets.Search(request).ToString()), "Page ordering must be stable.");
                    Assert.That(((JArray)page["clips"]).Count, Is.EqualTo(2));
                    foreach (var row in (JArray)page["clips"]) rows.Add(row.DeepClone());
                    Assert.That((bool)page["truncated"], Is.EqualTo(pageIndex < 2));
                    if (pageIndex < 2)
                    {
                        Assert.That((int)page["nextOffset"], Is.EqualTo(offset + 2));
                        offset = (int)page["nextOffset"];
                    }
                    else Assert.That(page["nextOffset"].Type, Is.EqualTo(JTokenType.Null));
                }
                CollectionAssert.AreEquivalent(expected, rows.Select(SearchRowKey));
                Assert.That(rows.Select(SearchRowKey).Distinct().Count(), Is.EqualTo(expected.Length));
                Assert.That((string)rows.First["path"], Is.EqualTo(folder + "/a-first.anim"));
                Assert.That((string)rows.Last["path"], Is.EqualTo(folder + "/z-last.anim"));
                var legacy = AutoHitTimerAssets.Search(new JObject { ["query"] = folder });
                CollectionAssert.AreEqual(rows.Select(SearchRowKey), ((JArray)legacy["clips"]).Select(SearchRowKey));
                Assert.That((bool)legacy["truncated"], Is.False);
                var beyond = AutoHitTimerAssets.Search(new JObject { ["query"] = folder, ["offset"] = 6, ["limit"] = 2 });
                Assert.That(((JArray)beyond["clips"]).Count, Is.Zero);
                Assert.That((bool)beyond["truncated"], Is.False);
                Assert.That(beyond["nextOffset"].Type, Is.EqualTo(JTokenType.Null));
            }
            finally { AssetDatabase.DeleteAsset(folder); }
        }

        [Test]
        public void AnimationSearchMatchesClipAndFileNamesIncludingSubclips()
        {
            var folder = CreateSearchFolder();
            try
            {
                var token = Path.GetFileName(folder);
                var root = CreateSearchClip(folder + "/SwordPack.anim", "Unrelated pose");
                var take = SearchClip(token + "_OverheadStrike");
                AssetDatabase.AddObjectToAsset(take, root);
                AssetDatabase.SaveAssets();
                var byName = AutoHitTimerAssets.Search(new JObject { ["query"] = (token + "_overheadstrike").ToLowerInvariant() });
                Assert.That(((JArray)byName["clips"]).Count, Is.EqualTo(1));
                Assert.That(SearchRowKey(byName["clips"][0]), Is.EqualTo(SearchRowKey(AutoHitTimerAssets.ClipRef(take))));
                var byFile = AutoHitTimerAssets.Search(new JObject { ["query"] = folder + "/swordpack.anim", ["limit"] = 1 });
                Assert.That(((JArray)byFile["clips"]).Count, Is.EqualTo(1));
                Assert.That((bool)byFile["truncated"], Is.True);
                var rest = AutoHitTimerAssets.Search(new JObject { ["query"] = folder + "/swordpack.anim", ["offset"] = (int)byFile["nextOffset"], ["limit"] = 3 });
                Assert.That(((JArray)rest["clips"]).Count, Is.EqualTo(1));
                Assert.That((bool)rest["truncated"], Is.False);
                Assert.That(rest["nextOffset"].Type, Is.EqualTo(JTokenType.Null));
            }
            finally { AssetDatabase.DeleteAsset(folder); }
        }

        [Test]
        public void AnimationSearchPreservesSharedClipStateNamesAndCompatibilityAcrossPages()
        {
            var folder = CreateSearchFolder();
            // Replace the test runner's untitled scene; it restores the user's setup afterward.
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            try
            {
                var token = Path.GetFileName(folder);
                var clip = CreateSearchClip(folder + "/motion.anim", token + "_SharedMotion");
                var controller = AnimatorController.CreateAnimatorControllerAtPath(folder + "/actor.controller");
                var machine = controller.layers[0].stateMachine;
                var quick = machine.AddState(token + "_QuickStab");
                quick.motion = clip;
                var overhead = machine.AddStateMachine("Attacks").AddState(token + "_OverheadStrike");
                overhead.motion = clip;
                overhead.speed = 1.5f;
                controller.AddLayer("UpperBody");
                controller.layers[1].stateMachine.AddState(token + "_Guard").motion = clip;
                var actor = new GameObject("Search actor").AddComponent<Animator>();
                SceneManager.MoveGameObjectToScene(actor.gameObject, scene);
                actor.runtimeAnimatorController = controller;
                AssetDatabase.SaveAssets();
                EditorSceneManager.SaveScene(scene, folder + "/search.unity");
                var actorId = GlobalObjectId.GetGlobalObjectIdSlow(actor).ToString();
                var all = AutoHitTimerAssets.Search(new JObject { ["query"] = folder, ["actorId"] = actorId });
                var rows = (JArray)all["clips"];
                Assert.That(rows.Count, Is.EqualTo(3), "Every state context is retained, without a duplicate asset-only row.");
                Assert.That(rows.Select(row => (string)row["stateName"]).Distinct().Count(), Is.EqualTo(3));
                Assert.That(rows.Select(row => (string)row["guid"] + ":" + (string)row["localId"]).Distinct().Count(), Is.EqualTo(1));
                Assert.That(rows.Count(row => (bool)row["compatible"]), Is.EqualTo(1));
                for (var index = 0; index < rows.Count; index++)
                {
                    var page = AutoHitTimerAssets.Search(new JObject { ["query"] = folder, ["actorId"] = actorId, ["offset"] = index, ["limit"] = 1 });
                    Assert.That(SearchRowKey(page["clips"][0]), Is.EqualTo(SearchRowKey(rows[index])));
                    Assert.That((bool)page["truncated"], Is.EqualTo(index < rows.Count - 1));
                }
                var byState = AutoHitTimerAssets.Search(new JObject { ["query"] = token + "_overheadstrike", ["actorId"] = actorId });
                Assert.That(((JArray)byState["clips"]).Count, Is.EqualTo(1));
                Assert.That((string)byState["clips"][0]["stateName"], Does.Contain(".Attacks."));
                Assert.That((bool)byState["clips"][0]["compatible"], Is.False);
                Assert.That((string)byState["clips"][0]["reason"], Is.EqualTo(AutoHitTimerAssets.StateReason(overhead, 0)));
            }
            finally
            {
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                AssetDatabase.DeleteAsset(folder);
            }
        }

        [TestCase("offset", "-1")]
        [TestCase("offset", "2147483648")]
        [TestCase("offset", "1.5")]
        [TestCase("offset", "\"1\"")]
        [TestCase("limit", "0")]
        [TestCase("limit", "1001")]
        [TestCase("limit", "true")]
        [TestCase("limit", "null")]
        public void AnimationSearchRejectsInvalidPageArguments(string name, string json)
        {
            Assert.Throws<AutoHitTimerException>(() => AutoHitTimerAssets.Search(new JObject { [name] = JToken.Parse(json) }));
        }

        static string CreateSearchFolder()
        {
            var name = "AutoHitTimerSearchTest_" + Guid.NewGuid().ToString("N");
            AssetDatabase.CreateFolder("Assets", name);
            return "Assets/" + name;
        }

        static AnimationClip SearchClip(string name)
        {
            var clip = new AnimationClip { name = name };
            clip.SetCurve("", typeof(Transform), "m_LocalPosition.x", AnimationCurve.Linear(0, 0, 1, 1));
            return clip;
        }

        static AnimationClip CreateSearchClip(string path, string name)
        {
            var clip = SearchClip(name);
            AssetDatabase.CreateAsset(clip, path);
            return clip;
        }

        static string SearchRowKey(JToken row) => (string)row["guid"] + ":" + (string)row["localId"] + ":" + (string)row["stateName"];

        [Test]
        public void RenderCloneDoesNotCopyGameScriptsOrPhysics()
        {
            var actor = new GameObject("Actor");
            GameObject clone = null;
            try
            {
                var animator = actor.AddComponent<Animator>();
                actor.AddComponent<BoxCollider>();
                actor.AddComponent<Rigidbody>();
                var child = GameObject.CreatePrimitive(PrimitiveType.Cube);
                child.transform.SetParent(actor.transform, false);
                clone = AutoHitTimerScene.CloneRenderHierarchy(animator, null, null);
                Assert.That(clone.GetComponentsInChildren<Collider>().Length, Is.Zero);
                Assert.That(clone.GetComponentsInChildren<Rigidbody>().Length, Is.Zero);
                Assert.That(clone.GetComponentsInChildren<MonoBehaviour>().Length, Is.Zero);
                Assert.That(clone.GetComponentsInChildren<MeshRenderer>().Length, Is.EqualTo(1));
                Assert.That(clone.GetComponent<Animator>().fireEvents, Is.False);
            }
            finally { if (clone) UnityEngine.Object.DestroyImmediate(clone); UnityEngine.Object.DestroyImmediate(actor); }
        }

        [Test, Category("Graphics")]
        public void SyntheticCaptureProducesTwoViewsAndUniqueBatchesWithoutDirtyingSource()
        {
            if (SystemInfo.graphicsDeviceType == UnityEngine.Rendering.GraphicsDeviceType.Null) Assert.Ignore("실제 렌더 검증에는 그래픽 장치가 필요합니다.");
            var folder = "Assets/AutoHitTimerTest_" + Guid.NewGuid().ToString("N");
            AssetDatabase.CreateFolder("Assets", Path.GetFileName(folder));
            // Unity Test Runner supplies an untitled temporary scene before EditMode tests.
            // Replace that scene; the runner restores the user's scene setup after the run.
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            AutoHitTimerCapture capture = null;
            try
            {
                var actor = new GameObject("Actor");
                SceneManager.MoveGameObjectToScene(actor, scene);
                var animator = actor.AddComponent<Animator>();
                var cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
                cube.name = "Weapon";
                cube.transform.SetParent(actor.transform, false);
                var clip = new AnimationClip();
                clip.SetCurve("Weapon", typeof(Transform), "m_LocalPosition.x", AnimationCurve.Linear(0, 0, 1, 1));
                AssetDatabase.CreateAsset(clip, folder + "/motion.anim");
                EditorSceneManager.SaveScene(scene, folder + "/preview.unity");
                var request = new JObject { ["actorId"] = GlobalObjectId.GetGlobalObjectIdSlow(animator).ToString(), ["clip"] = AutoHitTimerAssets.ClipRef(clip), ["fps"] = 24, ["times"] = new JArray(0, 1) };
                capture = new AutoHitTimerCapture(request);
                Assert.That(capture.Step(out _), Is.False);
                Assert.That(capture.Step(out var first), Is.True);
                capture.Dispose(); capture = null;
                var frames = (JArray)first["frames"];
                Assert.That(frames.Count, Is.EqualTo(2));
                Assert.That(File.ReadAllBytes((string)frames[0]["path"]), Is.Not.EqualTo(File.ReadAllBytes((string)frames[1]["path"])));
                var texture = new Texture2D(2, 2);
                try
                {
                    Assert.That(texture.LoadImage(File.ReadAllBytes((string)frames[0]["path"])), Is.True);
                    Assert.That(texture.width, Is.EqualTo(1024));
                    Assert.That(texture.height, Is.EqualTo(512));
                }
                finally { UnityEngine.Object.DestroyImmediate(texture); }
                request["fps"] = 60;
                request["times"] = new JArray(0);
                request["sessionId"] = first["sessionId"];
                capture = new AutoHitTimerCapture(request);
                Assert.That(capture.Step(out var second), Is.True);
                Assert.That((string)second["frames"][0]["id"], Is.Not.EqualTo((string)frames[0]["id"]));
                Assert.That(cube.transform.localPosition, Is.EqualTo(Vector3.zero));
                Assert.That(scene.isDirty, Is.False);
            }
            finally
            {
                capture?.Dispose();
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                AssetDatabase.DeleteAsset(folder);
            }
        }

        [Test, Category("Graphics")]
        public void ConsecutiveCapturesUpdateSkinnedPoseInBothViewsWithoutMovingSource()
        {
            if (SystemInfo.graphicsDeviceType == UnityEngine.Rendering.GraphicsDeviceType.Null) Assert.Ignore("실제 렌더 검증에는 그래픽 장치가 필요합니다.");
            var folder = "Assets/AutoHitTimerSkinTest_" + Guid.NewGuid().ToString("N");
            AssetDatabase.CreateFolder("Assets", Path.GetFileName(folder));
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            AutoHitTimerCapture capture = null;
            var images = new[] { new Texture2D(2, 2), new Texture2D(2, 2) };
            try
            {
                var actor = new GameObject("SkinnedActor");
                SceneManager.MoveGameObjectToScene(actor, scene);
                var animator = actor.AddComponent<Animator>();
                var lower = new GameObject("Lower").transform;
                lower.SetParent(actor.transform, false);
                var upper = new GameObject("Upper").transform;
                upper.SetParent(lower, false);
                upper.localPosition = Vector3.up;
                var skin = new GameObject("Skin").AddComponent<SkinnedMeshRenderer>();
                skin.transform.SetParent(actor.transform, false);
                var mesh = TwoBoneMesh(skin.transform, lower, upper);
                AssetDatabase.CreateAsset(mesh, folder + "/skin.asset");
                skin.sharedMesh = mesh;
                skin.bones = new[] { lower, upper };
                skin.rootBone = lower;
                skin.localBounds = new Bounds(new Vector3(0, 1, 0.5f), new Vector3(1, 3, 2));
                skin.sharedMaterial = AssetDatabase.GetBuiltinExtraResource<Material>("Default-Material.mat");
                skin.forceMatrixRecalculationPerRender = false;

                // Only bend the upper bone. Root movement must not make a frozen skin pass.
                var clip = new AnimationClip();
                clip.SetCurve("Lower/Upper", typeof(Transform), "m_LocalRotation.x", AnimationCurve.Linear(0, 0, 1, Mathf.Sin(Mathf.PI / 4)));
                clip.SetCurve("Lower/Upper", typeof(Transform), "m_LocalRotation.w", AnimationCurve.Linear(0, 1, 1, Mathf.Cos(Mathf.PI / 4)));
                AssetDatabase.CreateAsset(clip, folder + "/bend.anim");
                EditorSceneManager.SaveScene(scene, folder + "/preview.unity");
                var sourceBounds = skin.localBounds;
                var request = new JObject { ["actorId"] = GlobalObjectId.GetGlobalObjectIdSlow(animator).ToString(), ["clip"] = AutoHitTimerAssets.ClipRef(clip), ["fps"] = 24, ["times"] = new JArray(0, 1) };
                capture = new AutoHitTimerCapture(request);

                // No yield or editor frame between renders: skin matrices must refresh per render.
                Assert.That(capture.Step(out _), Is.False);
                Assert.That(capture.Step(out var result), Is.True);
                capture.Dispose(); capture = null;
                for (var i = 0; i < images.Length; i++)
                    Assert.That(images[i].LoadImage(File.ReadAllBytes((string)result["frames"][i]["path"])), Is.True);
                Assert.That(images[0].width, Is.EqualTo(1024));
                Assert.That(images[0].height, Is.EqualTo(512));
                Assert.That(images[1].width, Is.EqualTo(images[0].width));
                Assert.That(images[1].height, Is.EqualTo(images[0].height));
                var before = images[0].GetPixels32();
                var after = images[1].GetPixels32();
                var halfWidth = images[0].width / 2;
                for (var view = 0; view < 2; view++)
                {
                    var changed = 0;
                    for (var y = 0; y < images[0].height; y++)
                    for (var x = view * halfWidth; x < (view + 1) * halfWidth; x++)
                    {
                        var pixel = y * images[0].width + x;
                        if (!before[pixel].Equals(after[pixel])) changed++;
                    }
                    Assert.That(changed, Is.GreaterThan(100), "The skinned pose must change in view " + view + ".");
                }

                Assert.That(actor.transform.position, Is.EqualTo(Vector3.zero));
                Assert.That(actor.transform.rotation, Is.EqualTo(Quaternion.identity));
                Assert.That(lower.localPosition, Is.EqualTo(Vector3.zero));
                Assert.That(lower.localRotation, Is.EqualTo(Quaternion.identity));
                Assert.That(upper.localPosition, Is.EqualTo(Vector3.up));
                Assert.That(upper.localRotation, Is.EqualTo(Quaternion.identity));
                Assert.That(skin.sharedMesh, Is.SameAs(mesh));
                CollectionAssert.AreEqual(new[] { lower, upper }, skin.bones);
                Assert.That(skin.localBounds, Is.EqualTo(sourceBounds));
                Assert.That(skin.forceMatrixRecalculationPerRender, Is.False);
                Assert.That(scene.isDirty, Is.False);
            }
            finally
            {
                capture?.Dispose();
                foreach (var image in images) UnityEngine.Object.DestroyImmediate(image);
                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                AssetDatabase.DeleteAsset(folder);
            }
        }

        static Mesh TwoBoneMesh(Transform renderer, Transform lower, Transform upper)
        {
            var vertices = new Vector3[16];
            var weights = new BoneWeight[16];
            var corners = new[]
            {
                new Vector3(-0.25f, 0, -0.25f), new Vector3(0.25f, 0, -0.25f),
                new Vector3(0.25f, 1, -0.25f), new Vector3(-0.25f, 1, -0.25f),
                new Vector3(-0.25f, 0, 0.25f), new Vector3(0.25f, 0, 0.25f),
                new Vector3(0.25f, 1, 0.25f), new Vector3(-0.25f, 1, 0.25f)
            };
            var boxTriangles = new[] { 0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2 };
            for (var bone = 0; bone < 2; bone++)
            for (var vertex = 0; vertex < corners.Length; vertex++)
            {
                var index = bone * corners.Length + vertex;
                vertices[index] = corners[vertex] + Vector3.up * bone;
                weights[index] = new BoneWeight { boneIndex0 = bone, weight0 = 1 };
            }
            var mesh = new Mesh
            {
                name = "Two-bone skin regression",
                vertices = vertices,
                triangles = boxTriangles.Concat(boxTriangles.Select(index => index + 8)).ToArray(),
                boneWeights = weights,
                bindposes = new[] { lower.worldToLocalMatrix * renderer.localToWorldMatrix, upper.worldToLocalMatrix * renderer.localToWorldMatrix }
            };
            mesh.RecalculateNormals();
            mesh.RecalculateBounds();
            return mesh;
        }
    }
}
