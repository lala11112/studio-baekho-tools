import type { GenerationRegion, GenerationSettings, ProjectFile } from '../../src/shared/types';
import { parseGenerationSettings } from '../../src/shared/features';
import { parseBindings } from '../../src/shared/map';
import { parseMapConcept } from '../../src/shared/concepts';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const validateSettings = parseGenerationSettings;

/** Region is request context, independent of saved generation preferences. */
export function validateGenerationRegion(value: unknown, settings: GenerationSettings): GenerationRegion | undefined {
  if(value===undefined)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('재생성 영역이 올바르지 않습니다.');
  const r=value as Record<string,unknown>;
  if(Object.keys(r).some(key=>!['x','row','width','height'].includes(key))||![r.x,r.row,r.width,r.height].every(n=>typeof n==='number'&&Number.isInteger(n))||Number(r.x)<0||Number(r.row)<0||Number(r.width)<1||Number(r.height)<1||Number(r.x)+Number(r.width)>settings.width||Number(r.row)+Number(r.height)>settings.height)throw new Error('재생성 영역은 생성 맵 내부의 정수 좌표여야 합니다.');
  return{x:Number(r.x),row:Number(r.row),width:Number(r.width),height:Number(r.height)};
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
      version: project.map.version===5?5:4, name: project.map.name, width: project.map.width, height: project.map.height,
      cellSize: project.map.cellSize, rows: [...project.map.rows],
      elevations: project.map.elevations.map(row => [...row]),
      ramps: project.map.ramps.map(ramp => ({ x: ramp.x, row: ramp.row, direction: ramp.direction, rise: ramp.rise, ...(ramp.kind ? {kind:ramp.kind} : {}) })),
      maxStepHeight: project.map.maxStepHeight,
      connections: project.map.connections.map(connection => ({ id: connection.id, label: connection.label, x: connection.x, row: connection.row,
        direction: connection.direction, width: connection.width, height: connection.height, kind: connection.kind })),
      assetOverrides: project.map.assetOverrides.map(override => ({ x: override.x, row: override.row, role: override.role, bindingId: override.bindingId })),
      ceilings:(project.map.ceilings??[]).map(c=>({x:c.x,row:c.row,undersideY:c.undersideY,...(c.heightMode?{heightMode:c.heightMode}:{})})),
      wallHeights:(project.map.wallHeights??[]).map(w=>({x:w.x,row:w.row,height:w.height,...(w.heightMode?{heightMode:w.heightMode}:{})})),
      bridges:(project.map.bridges??[]).map(b=>({x:b.x,row:b.row,direction:b.direction})),
      cliffs:(project.map.cliffs??[]).map(c=>({x:c.x,row:c.row,direction:c.direction,depth:c.depth})),
      fixtures:(project.map.fixtures??[]).map(f=>({id:f.id,role:f.role,x:f.x,row:f.row,direction:f.direction,offset:{x:f.offset.x,y:f.offset.y,z:f.offset.z},...(f.anchor?{anchor:f.anchor}:{}),...(f.bindingId?{bindingId:f.bindingId}:{}),...(f.linkedId?{linkedId:f.linkedId}:{}),...(f.wall?{wall:structuredClone(f.wall)}:{})})),
      markers:(project.map.markers??[]).map(m=>({id:m.id,label:m.label,kind:m.kind,contentKey:m.contentKey,x:m.x,row:m.row,direction:m.direction,offset:{x:m.offset.x,y:m.offset.y,z:m.offset.z},...(m.clearance?{clearance:{radius:m.clearance.radius,height:m.clearance.height}}:{})})),
      lockedCells:(project.map.lockedCells??[]).map(c=>({x:c.x,row:c.row})), zones:(project.map.zones??[]).map(z=>({x:z.x,row:z.row,kind:z.kind})),
      ...(project.map.headroom===undefined?{}:{headroom:project.map.headroom}),
      ...(project.map.structureSettings?{structureSettings:structuredClone(project.map.structureSettings)}:{}),
      ...(project.map.pitBottoms?{pitBottoms:structuredClone(project.map.pitBottoms)}:{}),
      ...(project.map.structureFills?{structureFills:structuredClone(project.map.structureFills)}:{}),
      ...(project.map.propInstances?{propInstances:structuredClone(project.map.propInstances)}:{}),
    },
    settings: validateSettings(project.settings),
    bindings: project.bindings.map(binding => ({
      id: binding.id, label: binding.label, role: binding.role, prefabGuid: binding.prefabGuid, prefabPath: binding.prefabPath,
      scale: { x: binding.scale.x, y: binding.scale.y, z: binding.scale.z },
      offset: { x: binding.offset.x, y: binding.offset.y, z: binding.offset.z }, rotationY: binding.rotationY,
      ...(binding.stairNativeRise === undefined ? {} : { stairNativeRise: binding.stairNativeRise }),
      ...(binding.lightAnchor === undefined ? {} : { lightAnchor: binding.lightAnchor }),
      ...(binding.prop===undefined?{}:{prop:structuredClone(binding.prop)}),
      ...(binding.bounds===undefined?{}:{bounds:structuredClone(binding.bounds)}),
      ...(binding.wallMount===undefined?{}:{wallMount:structuredClone(binding.wallMount)}),
    })),
  };
  if (project.blueprintDataUrl !== undefined) {
    decodePngDataUrl(project.blueprintDataUrl);
    result.blueprintDataUrl = project.blueprintDataUrl;
  }
  if(project.concept!==undefined)result.concept=parseMapConcept(project.concept);
  if(project.generationDraft!==undefined){
    const draft=project.generationDraft;
    decodePngDataUrl(draft.imageDataUrl);
    result.generationDraft={imageDataUrl:draft.imageDataUrl,settings:validateSettings(draft.settings),
      ...(draft.region?{region:{x:draft.region.x,row:draft.region.row,width:draft.region.width,height:draft.region.height}}:{}),
      ...(draft.concept===undefined?{}:{concept:parseMapConcept(draft.concept)}),
      ...(draft.preferences===undefined?{}:{preferences:validateSettings(draft.preferences)}),
    };
  }
  if(project.generationDraft?.catalog!==undefined)result.generationDraft!.catalog=parseBindings(project.generationDraft.catalog);
  return result;
}
