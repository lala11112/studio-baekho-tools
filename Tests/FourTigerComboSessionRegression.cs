// Run each entry through Unity Pipeline run_script in fresh Play Mode.
// Run: an active target moves out of range after the first attack starts.
// RunWithoutTargets: all targets disappear after the first attack starts.
// RunIsolated: normal-3 remains a single isolated attack under the same range fixture.
// These advance real game frames and use the session's virtual input/state machine.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using StudioBaekho.CombatLab;
using StudioBaekho.CombatLab.FourTigerSword;
using UnityEditor;
using UnityEngine;
using UnityEngine.AI;
using Object = UnityEngine.Object;

public static class FourTigerComboSessionRegression
{
    public static Task<string> Run() => RunScenario(false, false);
    public static Task<string> RunWithoutTargets() => RunScenario(false, true);
    public static Task<string> RunIsolated() => RunScenario(true, false);

    private static async Task<string> RunScenario(bool isolated, bool removeTargets)
    {
        Check(Application.isPlaying, "Run each scenario in freshly entered Play Mode.");
        var player = Object.FindObjectsByType<PlayerController>(FindObjectsSortMode.None)
            .Single(item => item.isActiveAndEnabled);
        var adapter = new FourTigerCombatAdapter();
        var discovered = adapter.DiscoverSources().First(item =>
            FourTigerCombatAdapter.ResolveSource(item.guid) is WaterFormActionDataSO);
        var source = FourTigerCombatAdapter.ResolveSource(discovered.guid);
        Check(source.Actions.ComboSteps.Count >= 3, "The Water fixture requires at least three normal attacks.");
        string sourceJson = EditorJsonUtility.ToJson(source);
        string actionId = isolated ? "normal-3" : "normal-combo";
        var candidate = new CombatCandidate { id = "combo-input-regression", label = actionId };
        foreach (var spec in adapter.Describe(discovered.guid, actionId))
            candidate.values.Add(new ParameterValue(spec.id, spec.baseline));
        var request = new ExperimentRequest {
            adapterId = adapter.Id, sourceGuid = discovered.guid, actionId = actionId,
            durationSeconds = 30f, recordVideo = false,
            candidates = new List<CombatCandidate> { candidate }
        };
        var fixtures = Object.FindObjectsByType<Enemy>(FindObjectsSortMode.None)
            .Where(item => item.isActiveAndEnabled && item.EnemyStat != null && item.EnemyStat.CurrentHp > 0f)
            .Select(item => new EnemyFixture(item)).ToArray();
        Check(fixtures.Length > 0, "A living scene enemy is required.");
        var originalForm = player.FormManager.CurrentForm;
        var originalPosition = player.transform.position;
        var originalRotation = player.transform.rotation;
        FourTigerCombatSession session = null;
        bool displaced = false;
        bool completedAttack = false;
        int lastFrame = -1;
        try
        {
            session = new FourTigerCombatSession(request, candidate);
            double deadline = Time.realtimeSinceStartupAsDouble + 25d;
            while (Time.realtimeSinceStartupAsDouble < deadline && !session.Complete)
            {
                await Task.Delay(10);
                Check(Application.isPlaying && player != null, "Play Mode ended during the regression.");
                if (lastFrame == Time.frameCount) continue;
                lastFrame = Time.frameCount;
                session.Tick(Time.unscaledDeltaTime);
                var executed = session.Metrics.events.Where(item => item.kind == "action-executed").ToArray();
                if (!displaced && executed.Length > 0)
                {
                    Check((int)executed[0].value == (isolated ? 3 : 1), "The first selected attack must execute before targets move.");
                    foreach (var fixture in fixtures) fixture.Displace(player.transform.position, removeTargets);
                    displaced = true;
                }
                if (!displaced) continue;
                // Keep active enemies outside the start radius while their original AI remains enabled.
                foreach (var fixture in fixtures) fixture.KeepAway(removeTargets);
                if (!removeTargets)
                    Check(fixtures.All(item => item.Enemy != null && item.Enemy.isActiveAndEnabled
                        && Vector3.Distance(item.Enemy.transform.position, player.transform.position) > 20f),
                        "The range fixture must keep living targets active and far away.");

                if (player.StateMachine.CurrentState is PlayerIdleState || player.StateMachine.CurrentState is PlayerRunState)
                {
                    completedAttack = true;
                    break;
                }
            }
            Check(displaced, "No first attack was observed before the timeout.");
            Check(completedAttack, "The selected attack did not finish before the timeout.");
            var stages = session.Metrics.events.Where(item => item.kind == "action-executed")
                .Select(item => (int)item.value).ToArray();
            int[] expected = isolated ? new[] { 3 } : Enumerable.Range(1, source.Actions.ComboSteps.Count).ToArray();
            Check(stages.SequenceEqual(expected), "Expected stages " + string.Join(",", expected)
                + "; observed " + string.Join(",", stages) + ".");
            Check(session.Metrics.attackRequests == expected.Length,
                "Each configured stage needs one input; the final or isolated step must not leave extra buffered taps.");
            Check(EditorJsonUtility.ToJson(source) == sourceJson, "The persistent source changed during playback.");
            return "FourTigerComboSessionRegression: " + actionId + "; "
                + (removeTargets ? "targets removed" : "targets moved out of range")
                + "; stages " + string.Join(",", stages) + "; " + session.Metrics.attackRequests
                + " virtual input requests; original source unchanged.";
        }
        finally
        {
            session?.Dispose();
            foreach (var fixture in fixtures) fixture.Restore();
            if (player != null)
            {
                bool controllerEnabled = player.Controller.enabled;
                player.Controller.enabled = false;
                player.transform.SetPositionAndRotation(originalPosition, originalRotation);
                player.Controller.enabled = controllerEnabled;
            }
            Check(player == null || player.FormManager.CurrentForm == originalForm, "The original player form was not restored.");
            Check(EditorJsonUtility.ToJson(source) == sourceJson, "The persistent source changed after disposal.");
            Check(session == null || !session.Metrics.notes.Any(item => item.StartsWith("Cleanup warning:", StringComparison.Ordinal)),
                "Session cleanup reported a warning.");
        }
    }

    private static void Check(bool passed, string message)
    {
        if (!passed) throw new InvalidOperationException("FourTigerComboSessionRegression: " + message);
    }

    private sealed class EnemyFixture
    {
        public readonly Enemy Enemy;
        private readonly NavMeshAgent _agent;
        private readonly Animator _animator;
        private readonly Vector3 _position;
        private readonly Quaternion _rotation;
        private readonly bool _active;
        private readonly bool _updatePosition;
        private readonly bool _updateRotation;
        private readonly bool _rootMotion;
        private Vector3 _farPosition;
        private bool _changed;

        public EnemyFixture(Enemy enemy)
        {
            Enemy = enemy;
            _position = enemy.transform.position;
            _rotation = enemy.transform.rotation;
            _active = enemy.gameObject.activeSelf;
            _agent = enemy.GetComponent<NavMeshAgent>();
            _animator = enemy.GetComponentInChildren<Animator>();
            _updatePosition = _agent != null && _agent.updatePosition;
            _updateRotation = _agent != null && _agent.updateRotation;
            _rootMotion = _animator != null && _animator.applyRootMotion;
        }

        public void Displace(Vector3 playerPosition, bool remove)
        {
            _changed = true;
            _farPosition = playerPosition + Vector3.right * 80f;
            if (remove) Enemy.gameObject.SetActive(false);
            else
            {
                // Keep the agent's navigation state valid while moving only the visible target.
                if (_agent != null) { _agent.updatePosition = false; _agent.updateRotation = false; }
                if (_animator != null) _animator.applyRootMotion = false;
                Enemy.transform.position = _farPosition;
            }
        }

        public void KeepAway(bool remove)
        {
            if (!remove && Enemy != null) Enemy.transform.position = _farPosition;
        }

        public void Restore()
        {
            if (!_changed || Enemy == null) return;
            Enemy.transform.SetPositionAndRotation(_position, _rotation);
            Enemy.gameObject.SetActive(_active);
            if (_agent != null)
            {
                if (_agent.enabled && _agent.isOnNavMesh) _agent.Warp(_position);
                _agent.updatePosition = _updatePosition;
                _agent.updateRotation = _updateRotation;
            }
            if (_animator != null) _animator.applyRootMotion = _rootMotion;
        }
    }
}
