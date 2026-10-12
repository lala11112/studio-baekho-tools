import type { GenerationSettings, ProjectFile } from '../../src/shared/types';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export function validateSettings(value: unknown): GenerationSettings {
  if (!value || typeof value !== 'object') throw new Error('생성 설정이 올바르지 않습니다.');
  const settings = value as Record<string, unknown>;
  if (typeof settings.prompt !== 'string' || !settings.prompt.trim() || settings.prompt.length > 6000) {
    throw new Error('맵 설명은 1~6,000자로 입력해 주세요.');
  }
  for (const key of ['width', 'height'] as const) {
    if (!Number.isInteger(settings[key]) || Number(settings[key]) < 8 || Number(settings[key]) > 40) {
      throw new Error('가로와 세로는 8~40 사이의 정수여야 합니다.');
    }
  }
  if (typeof settings.cellSize !== 'number' || !Number.isFinite(settings.cellSize) || settings.cellSize < 0.25 || settings.cellSize > 10) {
    throw new Error('한 칸의 크기는 0.25~10m 사이여야 합니다.');
  }
  if (typeof settings.elevationStep !== 'number' || !Number.isFinite(settings.elevationStep) || settings.elevationStep < 0.25 || settings.elevationStep > 10) {
    throw new Error('높이 단계는 0.25~10m 사이여야 합니다.');
  }
  if (typeof settings.maxStepHeight !== 'number' || !Number.isFinite(settings.maxStepHeight) || settings.maxStepHeight < 0.05 || settings.maxStepHeight > 1) {
    throw new Error('캐릭터가 바로 오를 수 있는 단차는 0.05~1m 사이여야 합니다.');
  }
  if (typeof settings.codexModel !== 'string' || (settings.codexModel !== '' && !MODEL_ID.test(settings.codexModel))) throw new Error('Codex 모델 ID를 확인해 주세요.');
  if (!Number.isInteger(settings.connectionCount) || Number(settings.connectionCount) < 1 || Number(settings.connectionCount) > 16) throw new Error('연결문 수는 1~16 사이의 정수여야 합니다.');
  return {
    prompt: settings.prompt.trim(), width: settings.width as number, height: settings.height as number,
    cellSize: settings.cellSize, elevationStep: settings.elevationStep, maxStepHeight: settings.maxStepHeight,
    codexModel: settings.codexModel, connectionCount: settings.connectionCount as number,
  };
}

export function decodePngDataUrl(value: unknown): Buffer {
  const prefix = 'data:image/png;base64,';
  if (typeof value !== 'string' || !value.startsWith(prefix) || value.length > prefix.length + Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
    throw new Error('설계도는 20MB 이하의 PNG 이미지여야 합니다.');
  }
  const encoded = value.slice(prefix.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('PNG 이미지의 인코딩이 올바르지 않습니다.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 24 || bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('올바른 PNG 설계도가 아닙니다.');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 33554432) throw new Error('설계도 해상도가 너무 크거나 잘못되었습니다.');
  return bytes;
}

/** Explicitly copy public fields; API keys and unknown project properties never reach disk. */
export function publicProject(project: ProjectFile): ProjectFile {
  const result: ProjectFile = {
    formatVersion: 1,
    map: {
      version: 3, name: project.map.name, width: project.map.width, height: project.map.height,
      cellSize: project.map.cellSize, rows: [...project.map.rows],
      elevations: project.map.elevations.map(row => [...row]),
      ramps: project.map.ramps.map(ramp => ({ x: ramp.x, row: ramp.row, direction: ramp.direction, rise: ramp.rise })),
      maxStepHeight: project.map.maxStepHeight,
      connections: project.map.connections.map(connection => ({ id: connection.id, label: connection.label, x: connection.x, row: connection.row,
        direction: connection.direction, width: connection.width, height: connection.height, kind: connection.kind })),
      assetOverrides: project.map.assetOverrides.map(override => ({ x: override.x, row: override.row, role: override.role, bindingId: override.bindingId })),
    },
    settings: validateSettings(project.settings),
    bindings: project.bindings.map(binding => ({
      id: binding.id, label: binding.label, role: binding.role, prefabGuid: binding.prefabGuid, prefabPath: binding.prefabPath,
      scale: { x: binding.scale.x, y: binding.scale.y, z: binding.scale.z },
      offset: { x: binding.offset.x, y: binding.offset.y, z: binding.offset.z }, rotationY: binding.rotationY,
      ...(binding.stairNativeRise === undefined ? {} : { stairNativeRise: binding.stairNativeRise }),
    })),
  };
  if (project.blueprintDataUrl !== undefined) {
    decodePngDataUrl(project.blueprintDataUrl);
    result.blueprintDataUrl = project.blueprintDataUrl;
  }
  return result;
}
