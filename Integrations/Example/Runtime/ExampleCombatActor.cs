using UnityEngine;

namespace StudioBaekho.CombatLab.Example
{
    public sealed class ExampleCombatActor : MonoBehaviour
    {
        public ExampleActionData actionData;
        public ExampleCombatTarget target;
        public Transform weapon;
        private float _nextAttackAt;
        private float _strikeAt = -1f;
        private float _animationStarted = -10f;
        private Vector3 _weaponRestPosition;

        private void Awake()
        {
            if (weapon != null) _weaponRestPosition = weapon.localPosition;
        }

        // Connect this request to the real game's input/controller when adapting the sample.
        public bool RequestAttack()
        {
            if (!isActiveAndEnabled || actionData == null || target == null || !target.isActiveAndEnabled || Time.time < _nextAttackAt) return false;
            _nextAttackAt = Time.time + actionData.attackInterval;
            _strikeAt = Time.time + 0.1f;
            _animationStarted = Time.time;
            return true;
        }

        private void Update()
        {
            if (weapon != null)
            {
                float phase = Mathf.Clamp01((Time.time - _animationStarted) / 0.25f);
                weapon.localPosition = _weaponRestPosition + Vector3.right * Mathf.Sin(phase * Mathf.PI);
            }
            if (_strikeAt < 0f || Time.time < _strikeAt) return;
            _strikeAt = -1f;
            if (actionData != null && target != null && target.isActiveAndEnabled && Vector3.Distance(transform.position, target.transform.position) <= 3.5f)
                target.ReceiveHit(actionData.damage, actionData.knockbackDistance);
        }

        public void ResetAttack()
        {
            _nextAttackAt = 0f;
            _strikeAt = -1f;
            _animationStarted = -10f;
            if (weapon != null) weapon.localPosition = _weaponRestPosition;
        }
    }
}
