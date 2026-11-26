import { DEFAULT_DESIGNER } from './features';
import { DEFAULT_LEVEL_DESIGN, compileLevelDesign } from './level-design';
import type { GenerationSettings, RoomPresetId, RoomPurpose } from './types';
import { NEW_WALL_SETTINGS } from './wall-mounts';

export interface RoomPreset { id: RoomPresetId; label: string; purpose: RoomPurpose; min: number; max: number; enemies: number; rewards: number; connections: number }
export const ROOM_PRESETS: Record<RoomPresetId, RoomPreset> = {
  small: { id: 'small', label: '소형 전투방', purpose: 'battle', min: 10, max: 12, enemies: 4, rewards: 1, connections: 2 },
  medium: { id: 'medium', label: '중형 전투방', purpose: 'battle', min: 14, max: 18, enemies: 6, rewards: 2, connections: 4 },
  large: { id: 'large', label: '대형 전투방', purpose: 'battle', min: 22, max: 26, enemies: 10, rewards: 3, connections: 4 },
  boss: { id: 'boss', label: '보스방', purpose: 'boss', min: 22, max: 26, enemies: 1, rewards: 1, connections: 1 },
  start: { id: 'start', label: '시작방', purpose: 'start', min: 8, max: 10, enemies: 0, rewards: 0, connections: 1 },
  reward: { id: 'reward', label: '보상방', purpose: 'reward', min: 8, max: 10, enemies: 0, rewards: 4, connections: 1 },
  shop: { id: 'shop', label: '상점방', purpose: 'shop', min: 10, max: 12, enemies: 0, rewards: 0, connections: 1 },
};

/** Stable PRNG shared by dimensions, recipes and local placement. No global random state. */
export function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => { value += 0x6D2B79F5; let t = value; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/** Changes only the next request. Existing map and binding transforms are never inputs. */
export function applyRoomPreset(settings: GenerationSettings, id: RoomPresetId): GenerationSettings {
  const preset = ROOM_PRESETS[id];
  if (!preset) throw new Error('지원하지 않는 방 규격입니다.');
  const safe = !['battle', 'boss'].includes(preset.purpose);
  return { ...structuredClone(settings), roomPreset: id, sizeMode: 'preset', sizeResolved: false,
    width: (preset.min + preset.max) / 2, height: (preset.min + preset.max) / 2, cellSize: 2, connectionCount: preset.connections,
    levelDesign: { ...DEFAULT_LEVEL_DESIGN },
    designer: { ...DEFAULT_DESIGNER, propLayout: settings.designer ? settings.designer.propLayout ?? 'legacy' : 'grouped', propCoverage: settings.designer?.propCoverage ?? 12,
      ...(settings.designer?.wallMounts?{wallMounts:structuredClone(settings.designer.wallMounts)}:!settings.designer?{wallMounts:{...structuredClone(NEW_WALL_SETTINGS),enabled:true}}:{}),
      teleports: settings.designer?.teleports ?? false, teleportCount: settings.designer?.teleportCount ?? 1,
      preset: preset.purpose, structureFill: true, pitBottomKind: 'deadzone', gapRole: 'wall',
      enemies: preset.enemies > 0, enemyCount: Math.max(1, preset.enemies), rewards: preset.rewards > 0, rewardCount: Math.max(1, preset.rewards),
      elevation: !safe, props: !safe, hazards: false, traps: false, cliffs: false, rests: false, merchants: preset.purpose === 'shop', altars: false },
  };
}

export function setCustomRoomSize(settings: GenerationSettings, changes: Partial<Pick<GenerationSettings, 'width' | 'height' | 'cellSize'>>): GenerationSettings {
  return { ...structuredClone(settings), ...changes, sizeMode: 'custom', sizeResolved: false };
}

/** Resolve once before either AI phase. Retries must use the returned request unchanged. */
export function resolveGenerationSettings(settings: GenerationSettings, candidateIndex = 0): GenerationSettings {
  const result = structuredClone(settings);
  if (!result.roomPreset && !result.levelDesign && result.sizeMode === undefined) return result;
  if (result.sizeResolved && candidateIndex === 0) return result;
  const baseSeed = result.seed ?? crypto.getRandomValues(new Uint32Array(1))[0];
  result.seed = (baseSeed + Math.imul(candidateIndex, 0x9E3779B9)) >>> 0;
  if (result.sizeMode === 'preset' && result.roomPreset) {
    const preset = ROOM_PRESETS[result.roomPreset], random = seededRandom(result.seed);
    const pick = () => preset.min + Math.floor(random() * ((preset.max - preset.min) / 2 + 1)) * 2;
    result.width = pick(); result.height = pick();
  }
  if (result.levelDesign) result.levelDesign.pattern = compileLevelDesign(result).pattern;
  result.sizeResolved = true;
  return result;
}
