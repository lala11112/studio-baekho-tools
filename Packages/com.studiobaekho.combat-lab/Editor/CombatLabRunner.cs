using System;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace StudioBaekho.CombatLab
{
    [InitializeOnLoad]
    public static class CombatLabRunner
    {
        private const string StateKey = "Baekho.CombatLab.Run.v1";
        private const string LastKey = "Baekho.CombatLab.LastReport";
        [Serializable] private sealed class RunState
        {
            public ExperimentRequest request;
            public string directory;
            public string phase;
            public int candidateIndex;
            public bool cancelled;
            public double phaseStarted;
            public float originalTimeScale;
            public bool originalRunInBackground;
            public int originalCaptureFramerate;
            public float originalCaptureDeltaTime;
        }
        private static RunState state;
        private static ExperimentReport report;
        private static ICombatLabSession session;
        private static CombatLabRecording recording;
        private static double lastTick;
        private static int lastFrame = -1;
        private static float videoTimeOffset;
        private static bool ending;

        static CombatLabRunner()
        {
            var saved = SessionState.GetString(StateKey, "");
            if (!string.IsNullOrEmpty(saved))
            {
                try
                {
                    state = JsonUtility.FromJson<RunState>(saved);
                    report = JsonUtility.FromJson<ExperimentReport>(File.ReadAllText(Path.Combine(state.directory, "report.json")));
                }
                catch (Exception e) { Debug.LogException(e); state = null; SessionState.EraseString(StateKey); }
            }
            EditorApplication.playModeStateChanged += OnPlayMode;
            EditorApplication.update += Update;
            AssemblyReloadEvents.beforeAssemblyReload += BeforeReload;
            EditorApplication.quitting += OnQuit;
        }

        public static bool IsRunning => state != null;
        public static string LastDirectory => SessionState.GetString(LastKey, "");
        public static string Status => state == null ? "대기 중" : $"{state.candidateIndex + 1}/{state.request.candidates.Count} · {state.phase}";
        public static string StatusJson() => JsonUtility.ToJson(new StatusData {
            running = IsRunning, status = Status, directory = state?.directory ?? LastDirectory
        });
        [Serializable] private sealed class StatusData { public bool running; public string status; public string directory; }

        public static string Start(ExperimentRequest request)
        {
            if (state != null || EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isCompiling)
                throw new InvalidOperationException("편집 모드에서 다른 실행이 끝난 뒤 시작하세요.");
            if (EditorSettings.enterPlayModeOptionsEnabled && EditorSettings.enterPlayModeOptions != EnterPlayModeOptions.None)
                throw new InvalidOperationException("후보마다 상태를 초기화하려면 Enter Play Mode의 Reload Domain과 Reload Scene을 모두 켜세요.");
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                if (scene.isDirty || string.IsNullOrEmpty(scene.path))
                    throw new InvalidOperationException("열린 씬을 저장한 뒤 실행하세요. 도구는 씬을 자동 저장하지 않습니다.");
            }
            CombatLab.Validate(request);
            // Freeze the request. Editor fields and external callers may keep mutating their copy.
            request = JsonUtility.FromJson<ExperimentRequest>(JsonUtility.ToJson(request));
            string id = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            string directory = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "CombatLabResults", id));
            Directory.CreateDirectory(directory);
            report = new ExperimentReport {
                runId = id, adapterId = request.adapterId, sourceGuid = request.sourceGuid, actionId = request.actionId,
                sourceDependencyHash = SourceHash(request.sourceGuid), unityVersion = Application.unityVersion,
                scenePath = SceneManager.GetActiveScene().path, seed = request.seed, startedUtc = DateTime.UtcNow.ToString("O")
            };
            report.notes.Add("규칙 기반 플레이 정책. 후보별 새 Play Mode. 동일 시드는 물리/프레임/적 AI의 완전한 재현을 보장하지 않습니다.");
            report.notes.Add(request.generation != null && !string.IsNullOrEmpty(request.generation.provider)
                ? "AI가 생성한 후보를 실행합니다. 후보 생성 정보는 request.json에 저장됩니다. 설명은 예상 효과이며 실제 타격감은 영상을 보고 판단하세요."
                : "JSON 입력 후보를 실행합니다. 자동 플레이는 규칙 기반 정책입니다.");
            File.WriteAllText(Path.Combine(directory, "request.json"), JsonUtility.ToJson(request, true));
            File.WriteAllText(Path.Combine(directory, "source-snapshot.json"), EditorJsonUtility.ToJson(
                AssetDatabase.LoadMainAssetAtPath(AssetDatabase.GUIDToAssetPath(request.sourceGuid)), true));
            File.WriteAllText(Path.Combine(directory, "scene-dependency-hash.txt"), AssetDatabase.GetAssetDependencyHash(report.scenePath).ToString());
            state = new RunState { request = request, directory = directory,
                originalTimeScale = Time.timeScale, originalRunInBackground = Application.runInBackground,
                originalCaptureFramerate = Time.captureFramerate, originalCaptureDeltaTime = Time.captureDeltaTime };
            SessionState.SetString(LastKey, directory);
            try { SaveReport(); EnterNext(); }
            catch
            {
                RestoreGlobals(); state = null; SessionState.EraseString(StateKey); throw;
            }
            return directory;
        }

        private static string SourceHash(string guid) => AssetDatabase.GetAssetDependencyHash(AssetDatabase.GUIDToAssetPath(guid)).ToString();
        private static void Persist() { if (state != null) SessionState.SetString(StateKey, JsonUtility.ToJson(state)); }
        private static void SaveReport() { if (state != null && report != null) CombatLabReport.Write(state.directory, report); }
        private static void SetPhase(string phase) { state.phase = phase; state.phaseStarted = EditorApplication.timeSinceStartup; Persist(); }

        private static void EnterNext()
        {
            if (state.cancelled || state.candidateIndex >= state.request.candidates.Count) { Finish(); return; }
            if (SourceHash(state.request.sourceGuid) != report.sourceDependencyHash)
            {
                report.notes.Add("원본 설정이 실행 중 변경되어 남은 후보를 중단했습니다."); Finish(); return;
            }
            if (state.request.recordVideo && !EditorApplication.ExecuteMenuItem("Window/General/Game"))
                throw new InvalidOperationException("Game View를 열지 못했습니다. Unity에서 Game View를 연 뒤 다시 실행하세요.");
            SetPhase("entering");
            EditorApplication.EnterPlaymode();
        }

        private static void OnPlayMode(PlayModeStateChange change)
        {
            if (state == null) return;
            if (change == PlayModeStateChange.EnteredPlayMode && state.phase == "entering")
            {
                UnityEngine.Random.InitState(state.request.seed);
                Time.timeScale = 1f;
                Application.runInBackground = true;
                SetPhase("warming");
            }
            else if (change == PlayModeStateChange.ExitingPlayMode)
            {
                if (state.phase != "exiting") { state.cancelled = true; EndCandidate("cancelled", "사용자가 Play Mode를 종료했습니다."); }
                Cleanup();
            }
            else if (change == PlayModeStateChange.EnteredEditMode)
            {
                RestoreGlobals();
                if (state.phase == "exiting") { state.candidateIndex++; SetPhase("between"); }
                else { state.cancelled = true; Finish(); }
            }
        }

        private static void Update()
        {
            if (state == null || ending) return;
            try
            {
                double now = EditorApplication.timeSinceStartup;
                if (EditorApplication.isPaused) { Cancel(); return; }
                if (state.phase == "entering" && now - state.phaseStarted > 120)
                    throw new TimeoutException("Play Mode 진입 시간 초과.");
                if (state.phase == "warming" && now - state.phaseStarted >= 1.5 && !EditorApplication.isCompiling)
                {
                    if (state.cancelled) { EndCandidate("cancelled", "실행 취소"); return; }
                    var candidate = state.request.candidates[state.candidateIndex];
                    double sessionStarted = Time.realtimeSinceStartupAsDouble;
                    session = CombatLab.Adapter(state.request.adapterId).Begin(state.request, candidate);
                    videoTimeOffset = 0f;
                    if (state.request.recordVideo)
                    {
                        recording = new CombatLabRecording();
                        recording.Start(Path.Combine(state.directory, candidate.id));
                        videoTimeOffset = (float)(sessionStarted - (Time.realtimeSinceStartupAsDouble - recording.TimelineSeconds));
                    }
                    lastTick = now; lastFrame = -1;
                    SetPhase("running");
                }
                else if (state.phase == "running")
                {
                    if (session == null) throw new InvalidOperationException("실험 중 스크립트가 다시 로드되었습니다. 실행을 중단합니다.");
                    if (recording != null && !string.IsNullOrEmpty(recording.Error))
                        throw new InvalidOperationException("녹화 실패: " + recording.Error);
                    if (Time.frameCount != lastFrame)
                    {
                        session.Tick((float)(now - lastTick)); lastTick = now; lastFrame = Time.frameCount;
                    }
                    if (state.cancelled) EndCandidate("cancelled", "실행 취소");
                    else if (session.Complete || now - state.phaseStarted >= state.request.durationSeconds)
                    {
                        // Let the session validate its final observation even if the editor's
                        // wall-clock deadline arrives between two rendered game frames.
                        session.Tick(0f);
                        EndCandidate(session.Metrics.hits > 0 ? "completed" : "no-hits", "");
                    }
                    else if (now - lastTick > 15) throw new TimeoutException("게임 프레임이 진행되지 않습니다.");
                }
                else if (state.phase == "between" && !EditorApplication.isPlayingOrWillChangePlaymode && now - state.phaseStarted > 0.5)
                    EnterNext();
                else if (state.phase == "exiting" && !EditorApplication.isPlayingOrWillChangePlaymode)
                {
                    RestoreGlobals(); state.candidateIndex++; SetPhase("between");
                }
            }
            catch (Exception e)
            {
                Debug.LogException(e);
                state.cancelled = true;
                EndCandidate("failed", e.Message);
            }
        }

        private static void EndCandidate(string status, string error)
        {
            if (state == null || ending || state.phase == "exiting") return;
            ending = true;
            try
            {
                var result = new CandidateResult { candidate = state.request.candidates[state.candidateIndex],
                    metrics = session?.Metrics ?? new CombatMetrics(), status = status, error = error,
                    videoPath = recording?.OutputPath ?? "", videoTimeOffsetSeconds = videoTimeOffset };
                try { recording?.Stop(); }
                catch (Exception e) { result.status = "failed"; result.error += " 녹화: " + e.Message; state.cancelled = true; }
                if (recording != null)
                {
                    foreach (var warning in recording.Warnings) result.metrics.notes.Add(warning);
                    if (!string.IsNullOrEmpty(recording.Error))
                    { result.status = "failed"; result.error += " 녹화: " + recording.Error; state.cancelled = true; }
                }
                if (result.metrics.hits == 0) result.metrics.notes.Add("명중이 관측되지 않았습니다. 이 실행으로 타격감을 비교하지 마세요.");
                report.results.Add(result);
                SaveReport();
            }
            catch (Exception e)
            {
                state.cancelled = true;
                report.notes.Add("결과 파일 저장 중 오류가 발생하여 남은 후보를 중단했습니다: " + e.Message);
                Debug.LogError("[Combat Lab] 결과 저장 실패: " + e.Message);
            }
            finally
            {
                Cleanup(); SetPhase("exiting");
                if (EditorApplication.isPlayingOrWillChangePlaymode) EditorApplication.ExitPlaymode();
                ending = false;
            }
        }

        private static void Cleanup()
        {
            try { recording?.Dispose(); } catch (Exception e) { Debug.LogException(e); }
            recording = null;
            try { session?.Dispose(); } catch (Exception e) { Debug.LogException(e); }
            session = null;
            RestoreGlobals();
        }
        private static void RestoreGlobals()
        {
            if (state == null) return;
            Time.timeScale = state.originalTimeScale;
            Application.runInBackground = state.originalRunInBackground;
            Time.captureFramerate = state.originalCaptureFramerate;
            Time.captureDeltaTime = state.originalCaptureDeltaTime;
        }
        public static void Cancel()
        {
            if (state == null) return;
            state.cancelled = true; Persist();
            if (state.phase == "running" || state.phase == "warming") EndCandidate("cancelled", "실행 취소");
            else if (!EditorApplication.isPlayingOrWillChangePlaymode) Finish();
        }
        private static void Finish()
        {
            try { Cleanup(); SaveReport(); }
            finally { state = null; SessionState.EraseString(StateKey); }
        }
        private static void BeforeReload()
        {
            if (state != null && state.phase == "running")
            {
                state.cancelled = true;
                EndCandidate("interrupted", "실행 중 스크립트 재컴파일");
            }
        }
        private static void OnQuit()
        {
            if (state == null) return;
            state.cancelled = true;
            EndCandidate("interrupted", "Unity 종료");
            Finish();
        }
    }
}
