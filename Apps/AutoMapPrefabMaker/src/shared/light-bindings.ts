import type { AssetBinding, GridMap, MapFixture } from './types';

/** Untyped light bindings remain compatible with older projects and manual placements. */
export function fixtureBindings(bindings: AssetBinding[], fixture: Pick<MapFixture, 'role' | 'anchor' | 'wall'>): AssetBinding[] {
  return bindings.filter(binding => binding.role === fixture.role && (fixture.wall ? !!binding.wallMount : !binding.wallMount) && (fixture.wall || binding.role !== 'light' || !binding.lightAnchor || binding.lightAnchor === fixture.anchor));
}

export function resolveFixtureBinding(map: Pick<GridMap, 'width'>, bindings: AssetBinding[], fixture: MapFixture): AssetBinding | undefined {
  if (fixture.wall?.placeholder) return undefined;
  const compatible = fixtureBindings(bindings, fixture);
  if (fixture.bindingId) return compatible.find(binding => binding.id === fixture.bindingId);
  const dedicated = fixture.role === 'light' ? compatible.filter(binding => binding.lightAnchor === fixture.anchor && !!binding.lightAnchor) : [];
  const candidates = dedicated.length ? dedicated : compatible;
  return candidates[(fixture.row * map.width + fixture.x) % candidates.length];
}
