import type { AssetBinding, LocalBounds, Vec3, WallConnector, WallMountDefinition, WallPlaceholderKind } from './types';

export const WALL_PLACEHOLDER_KINDS: readonly WallPlaceholderKind[] = ['wallLight', 'doorLight', 'wallPanel', 'vent', 'pipeStraight', 'pipeInnerCorner', 'pipeOuterCorner', 'pipeEndCap', 'pipeElbow', 'pipeTee'];
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const box = (center: Vec3, size: Vec3): LocalBounds => ({ center, size });
const socket = (x: number, z: number, dx: number, dz: number): WallConnector => ({ position: v(x, 0, z), direction: v(dx, 0, dz) });
const LABELS: Record<WallPlaceholderKind, string> = { wallLight: '임시 벽 조명', doorLight: '임시 문 위 조명', wallPanel: '임시 벽 패널', vent: '임시 환기구', pipeStraight: '임시 직선 배관', pipeInnerCorner: '임시 배관 안쪽 코너', pipeOuterCorner: '임시 배관 바깥쪽 코너', pipeEndCap: '임시 배관 끝마감', pipeElbow: '임시 가로·세로 엘보', pipeTee: '임시 T자 분기관' };
export function wallPlaceholderLabel(kind: WallPlaceholderKind): string { return LABELS[kind]; }

/** Internal measured planning geometry. These bindings are never registered or saved in a project. */
export function placeholderWallBinding(kind: WallPlaceholderKind): AssetBinding {
  const single = !kind.startsWith('pipe');
  let bounds = box(v(0, 0, .12), v(.4, .5, .24));
  const wallMount: WallMountDefinition = { kind: 'single', family: '', sites: ['wall'], heightMode: 'top', height: 1, spacing: 2.5, probability: 100, doorSide: 'both', mounts: [socket(0, 0, 0, 1)], sockets: [], collisionBoxes: [] };
  if (kind === 'doorLight') { bounds = box(v(0, 0, .1), v(.8, .2, .2)); wallMount.sites = ['doorTop']; wallMount.heightMode = 'floor'; wallMount.height = .25; }
  if (kind === 'wallPanel') { bounds = box(v(0, 0, .06), v(.8, .7, .12)); wallMount.heightMode = 'center'; wallMount.height = -.2; }
  if (kind === 'vent') { bounds = box(v(0, 0, .08), v(.7, .4, .16)); wallMount.height = .8; }
  if (!single) {
    wallMount.family = 'baekho-placeholder-pipe-v1'; wallMount.height = .35; wallMount.spacing = 0.05;
    if (kind === 'pipeStraight') { bounds = box(v(0, 0, .1), v(1, .1, .2)); wallMount.kind = 'straight'; wallMount.sockets = [socket(-.5, .1, -1, 0), socket(.5, .1, 1, 0)]; }
    if (kind === 'pipeInnerCorner') {
      bounds = box(v(-.25, 0, .25), v(.5, .1, .5)); wallMount.kind = 'innerCorner'; wallMount.mounts = [socket(-.3, 0, 0, 1), socket(0, .3, -1, 0)]; wallMount.sockets = [socket(-.5, .1, -1, 0), socket(-.1, .5, 0, 1)];
      wallMount.collisionBoxes = [box(v(-.3, 0, .1), v(.4, .1, .2)), box(v(-.1, 0, .3), v(.2, .1, .4))];
    }
    if (kind === 'pipeOuterCorner') {
      bounds = box(v(-.15, 0, -.15), v(.7, .1, .7)); wallMount.kind = 'outerCorner'; wallMount.mounts = [socket(-.3, 0, 0, 1), socket(0, -.3, 1, 0)]; wallMount.sockets = [socket(-.5, .1, -1, 0), socket(.1, -.5, 0, -1)];
      wallMount.collisionBoxes = [box(v(-.2, 0, .1), v(.6, .1, .2)), box(v(.1, 0, -.2), v(.2, .1, .6))];
    }
    if (kind === 'pipeEndCap') { bounds = box(v(.05, 0, 0), v(.1, .1, .2)); wallMount.kind = 'endCap'; wallMount.mounts = []; wallMount.sockets = [socket(0, 0, -1, 0)]; }
    if (kind === 'pipeElbow') {
      bounds = box(v(-.225, -.225, .1), v(.55, .55, .2)); wallMount.kind = 'elbow';
      wallMount.sockets = [socket(-.5, .1, -1, 0), { position: v(0, -.5, .1), direction: v(0, -1, 0) }];
      wallMount.collisionBoxes = [box(v(-.25, 0, .1), v(.5, .1, .2)), box(v(0, -.25, .1), v(.1, .5, .2))];
    }
    if (kind === 'pipeTee') {
      bounds = box(v(0, -.225, .1), v(1, .55, .2)); wallMount.kind = 'tee';
      wallMount.sockets = [socket(-.5, .1, -1, 0), socket(.5, .1, 1, 0), { position: v(0, -.5, .1), direction: v(0, -1, 0) }];
      wallMount.collisionBoxes = [box(v(-.25, 0, .1), v(.5, .1, .2)), box(v(.25, 0, .1), v(.5, .1, .2)), box(v(0, -.25, .1), v(.1, .5, .2))];
    }
  }
  return { id: `wm-placeholder-${kind}`, label: LABELS[kind], role: kind === 'wallLight' || kind === 'doorLight' ? 'light' : 'decoration', prefabGuid: '', prefabPath: '', scale: v(1, 1, 1), offset: v(0, 0, 0), rotationY: 0, bounds, wallMount };
}
