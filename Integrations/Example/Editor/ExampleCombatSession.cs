using UnityEngine;

namespace StudioBaekho.CombatLab.Example
{
    public sealed class ExampleCombatSession : ICombatLabSession
    {
        private readonly ExampleCombatActor _actor;
        private readonly ExampleCombatTarget _target;
        private readonly ExampleActionData _original;
        private readonly ExampleActionData _copy;
        private readonly float _duration;
        private readonly float _startedAt;
        private readonly float _startedGameTime;
        private readonly Vector3 _targetPosition;
        private bool _disposed;
        public bool Complete { get; private set; }
        public CombatMetrics Metrics { get; } = new CombatMetrics();

        public ExampleCombatSession(ExperimentRequest request, CombatCandidate candidate, ExampleCombatActor actor)
        {
            _actor = actor;
            _target = actor.target;
            _targetPosition = _target.transform.position;
            _original = actor.actionData;
            _duration = request.durationSeconds;
            _startedAt = Time.realtimeSinceStartup;
            _startedGameTime = Time.time;
            _copy = ExampleCombatAdapter.CloneAndApply(ExampleCombatAdapter.Resolve(request.sourceGuid), candidate);
            _actor.actionData = _copy;
            _actor.ResetAttack();
            _target.Damaged += OnDamaged;
            Metrics.appliedValues.Add(new ParameterValue("damage", _copy.damage));
            Metrics.appliedValues.Add(new ParameterValue("attackInterval", _copy.attackInterval));
            Metrics.appliedValues.Add(new ParameterValue("knockbackDistance", _copy.knockbackDistance));
            Metrics.notes.Add("Example demo: a scripted actor attacks an invulnerable training target. Hits and damage are measured from its actual damage event. This is not your game's combat or an input integration.");
        }

        public void Tick(float unscaledDeltaTime)
        {
            if (_disposed || Complete) return;
            Metrics.elapsedSeconds = Time.realtimeSinceStartup - _startedAt;
            if (Metrics.elapsedSeconds >= _duration) { Complete = true; return; }
            if (_actor == null || _target == null || !_actor.isActiveAndEnabled || !_target.isActiveAndEnabled)
                throw new System.InvalidOperationException("예제 플레이어나 표적이 실험 중 비활성화되었습니다.");
            if (!_actor.RequestAttack()) return;
            Metrics.attackRequests++;
            Event("attack-request", "strike", 0f);
        }

        private void OnDamaged(float damage)
        {
            if (_disposed || Complete) return;
            Metrics.hits++;
            Metrics.damageDealt += damage;
            if (Metrics.firstHitSeconds < 0f) Metrics.firstHitSeconds = Time.realtimeSinceStartup - _startedAt;
            Event("hit", "ExampleCombatTarget.ReceiveHit", damage);
        }

        private void Event(string kind, string detail, float value) => Metrics.events.Add(new CombatEvent {
            realTime = Time.realtimeSinceStartup - _startedAt, gameTime = Time.time - _startedGameTime,
            kind = kind, detail = detail, value = value
        });

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            Complete = true;
            if (_target != null) { _target.Damaged -= OnDamaged; _target.transform.position = _targetPosition; }
            if (_actor != null) { _actor.ResetAttack(); _actor.actionData = _original; }
            if (_copy != null) Object.DestroyImmediate(_copy);
        }
    }
}
