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
    }
}
