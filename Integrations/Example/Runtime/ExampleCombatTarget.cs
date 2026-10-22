using System;
using UnityEngine;

namespace StudioBaekho.CombatLab.Example
{
    public sealed class ExampleCombatTarget : MonoBehaviour
    {
        public event Action<float> Damaged;
        private Vector3 _initialPosition;
        private Vector3 _restingPosition;

        private void Awake() { _initialPosition = _restingPosition = transform.position; }
        private void Update()
        {
            transform.position = Vector3.MoveTowards(transform.position, _restingPosition, Time.deltaTime * 1.5f);
        }

        public void ReceiveHit(float damage, float knockbackDistance)
        {
            // The invulnerable training target reports each actual received hit and returns to its start.
            transform.position += Vector3.right * knockbackDistance;
            Damaged?.Invoke(damage);
        }

        public void ResetPosition() { transform.position = _initialPosition; }
    }
}
