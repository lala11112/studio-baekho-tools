import type { AssetBinding, PropInstance } from './types';

export const normalizePropYaw = (yaw: number): number => ((yaw % 360) + 360) % 360;

/** Instance yaw excludes the prefab's existing binding correction. */
export const propYaw = (instance: Pick<PropInstance, 'direction' | 'yawOffset'>): number => instance.direction + (instance.yawOffset ?? 0);

/** Preserve the raw sum for legacy exports, including negative binding corrections. */
export const propRootYaw = (instance: Pick<PropInstance, 'direction' | 'yawOffset'>, binding: AssetBinding): number => propYaw(instance) + binding.rotationY;

const nativeFrontYaw = (binding: AssetBinding): number => {
  const angle=binding.prop!.frontYaw!*Math.PI/180;
  return Math.atan2(Math.sign(binding.scale.x)*Math.sin(angle),Math.sign(binding.scale.z)*Math.cos(angle))*180/Math.PI;
};

export const propFrontYaw = (instance: Pick<PropInstance, 'direction' | 'yawOffset'>, binding: AssetBinding): number =>
  normalizePropYaw(propRootYaw(instance, binding) + (binding.prop?.frontYaw === undefined ? -binding.rotationY : nativeFrontYaw(binding)));

/** Offset that makes the visual front agree with the instance's cardinal heading. */
export const propFacingOffset = (binding: AssetBinding): number => binding.prop?.frontYaw === undefined ? 0 : -binding.rotationY - nativeFrontYaw(binding);
