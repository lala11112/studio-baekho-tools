import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { AssetBinding, Cell, FixtureRole, GridMap, Vec3 } from './shared/types';
import { connectionAt, connectionPose, doorRotation, FLOOR_THICKNESS_RATIO, resolveBinding } from './shared/map';
import { fixturePosition, markerPosition } from './shared/features';
import type { ModuleTransform, RegionRect } from './shared/editing';
import { propPosition } from './shared/props';
import type { LevelDesignReport } from './shared/level-design';
import { floorSlabBounds, resolvedStructureFill, resolvedCliffFace } from './shared/structures';
import { placeholderWallBinding, wallPlaceholderLabel } from './shared/wall-placeholders';
import { wallBaseClosure } from './shared/wall-geometry';

export interface PreviewState {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  zoom: number;
}
export interface PreviewOptions {
  selected?: { x: number; row: number } | null;
  onSelect?: (x: number, row: number) => void;
  onFixtureSelect?: (id: string) => void;
  onMarkerSelect?: (id: string) => void;
  onPropSelect?: (id: string) => void;
  selectedFixture?: string | null;
  selectedMarker?: string | null;
  selectedProp?: string | null;
  region?: RegionRect | null;
  showCeilings?: boolean;
  showDeadzone?: boolean;
  bindings?: AssetBinding[];
  designReport?: LevelDesignReport;
  showConnectionLabels?: boolean;
  showFixtures?: boolean;
  showMarkers?: boolean;
  showCharacter?: boolean;
  characterHeight?: number;
  comparison?: { map: GridMap; transform: ModuleTransform; bindings?: AssetBinding[] };
  state?: PreviewState;
}
export interface PreviewHandle { dispose: () => void; getState: () => PreviewState }

/** Blockout geometry uses the same world meters and Y-up coordinates as the Unity export. */
export function mountPreview(host: HTMLElement, map: GridMap, options: PreviewOptions = {}): PreviewHandle {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0xe9ece6);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const cell = map.cellSize;
  const validConnections = (source: GridMap) => source.connections.filter(connection => Number.isInteger(connection.x) && Number.isInteger(connection.row)
    && connection.x >= 0 && connection.row >= 0 && connection.x < source.width && connection.row < source.height
    && source.rows[connection.row][connection.x] === 'D' && [0, 90, 180, 270].includes(connection.direction)
    && Number.isFinite(connection.width) && connection.width > 0 && Number.isFinite(connection.height) && connection.height > 0);
  const connections = validConnections(map);
  renderer.domElement.setAttribute('aria-label', `높이와 계단을 편집할 수 있는 3D 맵. 셀 또는 연결문을 클릭해 선택하세요.${connections.length ? ` 외부 연결: ${connections.map(connection => `${connection.id} ${connection.label}`).join(', ')}.` : ''}`);
  const connectionKey = connections.length ? document.createElement('div') : null;
  if (connectionKey) {
    connectionKey.className = 'preview-connection-key';
    connectionKey.setAttribute('aria-hidden', 'true');
    connectionKey.textContent = `↗ 외부 연결 ${connections.length}개`;
    host.appendChild(connectionKey);
  }
  const explicitPropCells = new Set((map.propInstances ?? []).flatMap(prop => prop.cells).map(c => `${c.x}:${c.row}`));
  const unmeasuredCount = map.rows.reduce((total, row, z) => total + [...row].filter((tile, x) => tile === 'P' && !explicitPropCells.has(`${x}:${z}`)).length, 0);
  const selectedProp = map.propInstances?.find(prop => options.selectedProp === prop.id
    || !!options.selected && prop.cells.some(c => c.x === options.selected!.x && c.row === options.selected!.row));
  const selectedUnmeasured = !!options.selected && map.rows[options.selected.row]?.[options.selected.x] === 'P'
    && !explicitPropCells.has(`${options.selected.x}:${options.selected.row}`);
  const selectedWall = map.fixtures?.find(fixture => fixture.id === options.selectedFixture && fixture.wall);
  const propKey = !selectedWall && (selectedProp || unmeasuredCount) ? document.createElement('div') : null;
  const meters = (value: number) => String(Number(value.toFixed(3)));
  if (propKey) {
    propKey.className = 'preview-prop-key';
    propKey.setAttribute('role', 'status');
    const line = (text: string, title = false) => {
      const element = document.createElement(title ? 'strong' : 'span'); element.textContent = text; propKey.appendChild(element);
    };
    if (selectedProp) {
      propKey.dataset.previewPropSelection = 'measured';
      line(options.bindings?.find(binding => binding.id === selectedProp.bindingId)?.label ?? selectedProp.bindingId, true);
      line(`측정 크기 · X ${meters(selectedProp.size.x)} × Y ${meters(selectedProp.size.y)} × Z ${meters(selectedProp.size.z)} m`);
      line('사용자 배율·회전을 반영한 외곽 박스');
    } else if (selectedUnmeasured) {
      const binding = resolveBinding(map, options.bindings ?? [], options.selected!.x, options.selected!.row, 'prop');
      propKey.dataset.previewPropSelection = 'unmeasured';
      line(binding?.label ?? '선택한 소품', true);
      line('크기 미확정 · 임시 표시');
      line('에셋에서 원본 크기를 등록하면 실제 치수로 배치합니다.');
    }
    if (unmeasuredCount) {
      propKey.dataset.previewPropUnmeasured = String(unmeasuredCount);
      line(`크기 미확정 · 임시 표시 ${unmeasuredCount}개`);
    }
    host.appendChild(propKey);
  }
  const wallKey = selectedWall ? document.createElement('div') : null;
  if (wallKey && selectedWall?.wall) {
    const wall = selectedWall.wall, binding = options.bindings?.find(item => item.id === selectedWall.bindingId);
    wallKey.className = 'preview-prop-key'; wallKey.dataset.previewWallSelection = selectedWall.id; wallKey.setAttribute('role', 'status');
    const title = document.createElement('strong'); title.textContent = wall.placeholder ? wallPlaceholderLabel(wall.placeholder) : binding?.label ?? '벽 부착물'; wallKey.appendChild(title);
    const vertical = wall.sockets.some(socket => Math.abs(socket.direction.y) > .9), horizontal = wall.sockets.some(socket => Math.hypot(socket.direction.x, socket.direction.z) > .9);
    const detail = document.createElement('span'); detail.textContent = `${wall.placeholder ? '임시' : '측정'} 충돌 상자 ${wall.bounds.length}개 · 설치 높이 Y ${meters(wall.position.y)}m${wall.runId ? ' · 연결 구간' : ''}${vertical && horizontal ? ' · 가로·세로 연결' : vertical ? ' · 세로 부품' : ''}`; wallKey.appendChild(detail);
    const note = document.createElement('span'); note.textContent = wall.placeholder ? '배치 확인용 형상 · 선택한 부착물에서 실제 프리팹으로 교체하세요.' : '프리팹 배율·피벗·연결점을 반영한 설치 형상'; wallKey.appendChild(note); host.appendChild(wallKey);
  }
  const span = Math.max(map.width, map.height) * cell;
  const elevations = map.elevations.flat();
  const minimum = Math.min(0, ...elevations, ...(map.cliffs ?? []).map(cliff => map.elevations[cliff.row][cliff.x] - cliff.depth),
    ...(map.pitBottoms ?? []).map(bottom => bottom.y - bottom.thickness), ...(map.structureFills ?? []).map(fill => fill.position.y - fill.size.y / 2));
  const maximum = Math.max(0, ...elevations, ...map.ramps.map(ramp => map.elevations[ramp.row][ramp.x] + ramp.rise),
    ...(map.ceilings ?? []).map(ceiling => ceiling.undersideY + cell * FLOOR_THICKNESS_RATIO),
    ...(map.wallHeights ?? []).map(wall => map.elevations[wall.row][wall.x] + wall.height),
    ...connections.map(connection => map.elevations[connection.row][connection.x] + connection.height + cell * 0.6),
    ...(map.structureFills ?? []).map(fill => fill.position.y + fill.size.y / 2),
    ...(map.propInstances ?? []).map(prop => propPosition(map,prop,options.bindings?.find(b=>b.id===prop.bindingId)).y + prop.size.y),
    ...(map.fixtures ?? []).flatMap(fixture => fixture.wall?.bounds.map(bounds => bounds.center.y + bounds.size.y / 2) ?? []));
  const verticalSpan = maximum - minimum;
  const comparison = options.comparison;
  const comparisonSpan = comparison ? Math.max(comparison.map.width, comparison.map.height) * comparison.map.cellSize
    + Math.max(Math.abs(comparison.transform.position.x), Math.abs(comparison.transform.position.z), Math.abs(comparison.transform.position.y)) * 2 : 0;
  const extent = Math.max(span + (connections.length ? cell * 2 : 0), comparisonSpan, verticalSpan * 1.3, cell * 8);
  const groundY = minimum - cell * 0.2;
  const focusY = minimum + verticalSpan / 2;
  const camera = new THREE.OrthographicCamera(-extent, extent, extent, -extent, 0.01, extent * 20);
  camera.position.set(extent * 1.05, focusY + extent * 0.9, -extent * 1.15);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, focusY, 0);
  controls.enableDamping = true;
  controls.minZoom = 0.3;
  controls.maxZoom = 12;
  controls.maxPolarAngle = Math.PI / 2.02;
  if (options.state) {
    camera.position.copy(options.state.position);
    controls.target.copy(options.state.target);
    camera.zoom = options.state.zoom;
  }
  controls.update();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6a7461, 2.7));
  const sun = new THREE.DirectionalLight(0xffffff, 3.3);
  sun.position.set(-extent, focusY + extent * 2, -extent);
  sun.target.position.set(0, focusY, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, far: extent * 8 });
  sun.shadow.normalBias = cell * 0.025;
  scene.add(sun, sun.target);

  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const pickable: THREE.Object3D[] = [];
  const connectionLabels: THREE.Sprite[] = [];
  const material = (color: number): THREE.MeshStandardMaterial => {
    const result = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
    materials.add(result);
    return result;
  };
  const palette = {
    floor: material(0xd6d4c8), wall: material(0x667166), door: material(0xcb9f53),
    prop: material(0xb77756), unmeasured: material(0xc08c39), connection: material(0x268d86), selectedConnection: material(0x2679dd),
    terrain: material(0xa4ad9d), stair: material(0xb69768),
    bridge: material(0x8d7254), ceiling: material(0xc2b995), cliff: material(0x817967),
    fixture: material(0x8d6b53), vegetation: material(0x589b59), water: material(0x4d9fbd), hazard: material(0xd57b3b),
    light: material(0xf9cf6c), character: material(0x3979c9),
    lightHousing: material(0x596365), lightSurface: material(0xfff8e7), selectedLightSurface: material(0x86c2ff),
    deadzone: material(0xd74a60),
  };
  palette.deadzone.transparent = true; palette.deadzone.opacity = .28; palette.deadzone.depthWrite = false;
  palette.unmeasured.transparent = true; palette.unmeasured.opacity = .42;
  palette.lightSurface.emissive.set(0xffefc4); palette.lightSurface.emissiveIntensity = 1.2;
  palette.selectedLightSurface.emissive.set(0x469bff); palette.selectedLightSurface.emissiveIntensity = 0.8;
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  geometries.add(boxGeometry);
  const arrowShape = new THREE.Shape();
  arrowShape.moveTo(-cell * 0.16, 0);
  arrowShape.lineTo(0, cell * 0.34);
  arrowShape.lineTo(cell * 0.16, 0);
  arrowShape.closePath();
  const arrowGeometry = new THREE.ExtrudeGeometry(arrowShape, { depth: cell * 0.035, bevelEnabled: false });
  geometries.add(arrowGeometry);
  const addBox = (x: number, y: number, z: number, sx: number, sy: number, sz: number,
    mat: THREE.Material, cellIndex?: { x: number; row: number }, parent: THREE.Object3D = scene): THREE.Mesh => {
    const mesh = new THREE.Mesh(boxGeometry, mat);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (cellIndex) { mesh.userData.cell = cellIndex; pickable.push(mesh); }
    parent.add(mesh);
    return mesh;
  };
  const labelTexture = (id: string, label: string, selected: boolean, accent = '#247e78'): THREE.CanvasTexture => {
    const canvas = document.createElement('canvas');
    canvas.width = 384; canvas.height = 136;
    const context = canvas.getContext('2d')!;
    const color = selected ? '#2679dd' : accent;
    context.fillStyle = '#fbfdf7';
    context.beginPath(); context.roundRect(2, 2, 380, 132, 14); context.fill();
    context.strokeStyle = color; context.lineWidth = 3; context.stroke();
    context.fillStyle = color; context.fillRect(16, 24, 4, 88);
    context.textBaseline = 'middle';
    const text = (value: string, y: number, font: string) => {
      context.font = font;
      let visible = value;
      while (visible.length > 1 && context.measureText(visible).width > 324) visible = visible.slice(0, -1);
      if (visible !== value) visible = `${visible.slice(0, -1)}…`;
      context.fillText(visible, 32, y);
    };
    context.fillStyle = color;
    text(id, 44, '700 36px "Segoe UI", "Malgun Gothic", sans-serif');
    context.fillStyle = '#36443e';
    text(label || '외부 연결', 96, '28px "Segoe UI", "Malgun Gothic", sans-serif');
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    textures.add(texture);
    return texture;
  };
  const cellTops = new Map<string, number>();
  const propMaterials = new Map<string, THREE.Material>();
  const drawMap = (map: GridMap, parent: THREE.Object3D, interactive: boolean, bindings: AssetBinding[] = []) => {
  const cell = map.cellSize;
  const localGround = Math.min(0, ...map.elevations.flat()) - cell * 0.2;
  const connectionByCell = new Map(validConnections(map).map(connection => [`${connection.x}:${connection.row}`, connection]));
  const ramps = new Map(map.ramps.map(ramp => [`${ramp.x}:${ramp.row}`, ramp]));
  const explicitPropCells = new Set((map.propInstances ?? []).flatMap(p=>p.cells).map(c=>`${c.x}:${c.row}`));
  const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number,
    mat: THREE.Material, cellIndex?: { x: number; row: number }, target: THREE.Object3D = parent) =>
    addBox(x, y, z, sx, sy, sz, mat, interactive ? cellIndex : undefined, target);
  for (let row = 0; row < map.height; row++) {
    for (let x = 0; x < map.width; x++) {
      const tile = map.rows[row]?.[x];
      if (!tile || tile === '_') continue;
      const px = (x - (map.width - 1) / 2) * cell;
      const pz = ((map.height - 1) / 2 - row) * cell;
      const y = map.elevations[row][x];
      const index = { x, row };
      let top = y;
      // Supports visualize cliffs; the exported geometry comes from the user's mapped prefabs.
      const supportHeight = y - localGround - cell * 0.12;
      if (map.version !== 5 && tile !== 'B' && supportHeight > cell * 0.04) {
        box(px, localGround + supportHeight / 2, pz, cell * 0.94, supportHeight, cell * 0.94, palette.terrain, index);
      }
      const slab = floorSlabBounds(map,index,bindings);
      if(slab)box(px+slab.offset.x,slab.top-slab.thickness/2,pz+slab.offset.z,cell*.96,slab.thickness,cell*.96,palette.floor,index);
      else if(tile==='B')box(px,y-cell*FLOOR_THICKNESS_RATIO/2,pz,cell*.96,cell*FLOOR_THICKNESS_RATIO,cell*.96,palette.bridge,index);
      if (tile === 'B') {
        const direction = map.bridges?.find(bridge => bridge.x === x && bridge.row === row)?.direction ?? 0;
        const horizontal = direction === 90 || direction === 270;
        for (let plank = -3; plank <= 3; plank++) box(px + (horizontal ? plank * cell * 0.13 : 0), y + cell * 0.012,
          pz + (horizontal ? 0 : plank * cell * 0.13), horizontal ? cell * 0.1 : cell * 0.95, cell * 0.024,
          horizontal ? cell * 0.95 : cell * 0.1, palette.stair, index);
      }
      if (tile === '#') {
        const binding = resolveBinding(map, bindings, x, row, 'wall'), offset = binding?.offset ?? { x: 0, y: 0, z: 0 };
        const wallHeight = map.wallHeights?.find(wall => wall.x === x && wall.row === row)?.height
          ?? (binding?.bounds ? binding.bounds.size.y * binding.scale.y : undefined) ?? map.structureSettings?.defaultWallHeight ?? cell * 0.95;
        top += wallHeight + offset.y;
        box(px + offset.x, y + offset.y + wallHeight / 2, pz + offset.z, cell * 0.96, wallHeight, cell * 0.96, palette.wall, index);
        const closure = wallBaseClosure(map, index, bindings);
        if (closure) box(px + (binding?.offset.x ?? 0), closure.bottom + closure.height / 2, pz + (binding?.offset.z ?? 0),
          cell * .96, closure.height, cell * .96, palette.wall, index);
      }
      if (tile === 'P' && !explicitPropCells.has(`${x}:${row}`)) {
        top += cell * 0.6;
        const proxy = box(px, y + cell * 0.3, pz, cell * 0.7, cell * 0.6, cell * 0.7, palette.unmeasured, index);
        proxy.name = `unmeasured-prop:${x}:${row}`;
      }
      if (tile === 'D') {
        const connection = connectionByCell.get(`${x}:${row}`);
        if (connection) {
          const pose = connectionPose(map, connection);
          const port = new THREE.Group();
          port.name = `connection:${connection.id}`;
          port.position.copy(pose.position);
          port.rotation.y = THREE.MathUtils.degToRad(pose.rotation.y);
          parent.add(port);
          const selected = interactive && !!options.selected && connectionAt(map, options.selected.x, options.selected.row)?.id === connection.id;
          const frameMaterial = selected ? palette.selectedConnection : palette.connection;
          const thickness = Math.min(cell * 0.1, connection.width * 0.16, connection.height * 0.12);
          const depth = cell * 0.14;
          for (const side of [-1, 1]) {
            box(side * (connection.width + thickness) / 2, connection.height / 2, 0,
              thickness, connection.height, depth, frameMaterial, index, port);
          }
          box(0, connection.height + thickness / 2, 0, connection.width + thickness * 2,
            thickness, depth, frameMaterial, index, port);
          box(0, cell * 0.012, 0, connection.width, cell * 0.024, depth, frameMaterial, index, port);
          box(0, cell * 0.105, cell * 0.39, cell * 0.07, cell * 0.045, cell * 0.5, frameMaterial, index, port);
          const arrow = new THREE.Mesh(arrowGeometry, frameMaterial);
          arrow.position.set(0, cell * 0.13, cell * 0.62);
          arrow.rotation.x = Math.PI / 2;
          arrow.userData.cell = index;
          if (interactive) pickable.push(arrow);
          port.add(arrow);
          if (interactive && options.showConnectionLabels !== false) {
          const labelMaterial = new THREE.SpriteMaterial({ map: labelTexture(connection.id, connection.label, selected),
            transparent: true, depthTest: false, depthWrite: false });
          materials.add(labelMaterial);
          const label = new THREE.Sprite(labelMaterial);
          label.name = `connection-label:${connection.id}`;
          label.position.set(0, connection.height + thickness + cell * 0.12, cell * 0.08);
          label.center.set(0.5, 0);
          label.renderOrder = 110;
          label.userData.cell = index;
          connectionLabels.push(label);
          port.add(label);
          }
          top = y + connection.height + thickness;
        } else if (!connectionAt(map, x, row)) {
          top += cell;
          const horizontal = doorRotation(map, row, x) === 90;
          for (const side of [-cell * 0.37, cell * 0.37]) {
            box(px + (horizontal ? 0 : side), y + cell * 0.475, pz + (horizontal ? side : 0),
              cell * 0.18, cell * 0.95, cell * 0.18, palette.door, index);
          }
          box(px, y + cell * 0.93, pz, cell * (horizontal ? 0.18 : 0.93), cell * 0.14,
            cell * (horizontal ? 0.93 : 0.18), palette.door, index);
        }
      }
      if (tile === 'R') {
        const ramp = ramps.get(`${x}:${row}`);
        if (ramp) {
          top = y + ramp.rise;
          const staircase = new THREE.Group();
          staircase.position.set(px, y, pz);
          staircase.rotation.y = THREE.MathUtils.degToRad(ramp.direction);
          parent.add(staircase);
          if (ramp.kind === 'slope') {
            const half = cell * 0.48, wide = cell * 0.44;
            const geometry = new THREE.BufferGeometry();
            const vertices = new Float32Array([
              -wide, 0, -half, wide, 0, -half, wide, ramp.rise, half,
              -wide, 0, -half, wide, ramp.rise, half, -wide, ramp.rise, half,
              -wide, 0, -half, -wide, ramp.rise, half, -wide, 0, half,
              wide, 0, -half, wide, 0, half, wide, ramp.rise, half,
              -wide, 0, half, -wide, ramp.rise, half, wide, ramp.rise, half,
              -wide, 0, half, wide, ramp.rise, half, wide, 0, half,
            ]);
            for (let triangle = 0; triangle < vertices.length; triangle += 9) for (let axis = 0; axis < 3; axis++) {
              const second = vertices[triangle + 3 + axis];
              vertices[triangle + 3 + axis] = vertices[triangle + 6 + axis]; vertices[triangle + 6 + axis] = second;
            }
            geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
            geometry.computeVertexNormals(); geometries.add(geometry);
            const slope = new THREE.Mesh(geometry, palette.stair);
            slope.castShadow = true; slope.receiveShadow = true; slope.userData.cell = index;
            if (interactive) pickable.push(slope);
            staircase.add(slope);
          } else {
          const count = Math.max(3, Math.min(16, Math.ceil(ramp.rise / (cell * 0.12))));
          for (let step = 0; step < count; step++) {
            const height = ramp.rise * (step + 1) / count;
            box(0, height / 2, -cell * 0.48 + (step + 0.5) * cell * 0.96 / count,
              cell * 0.88, height, cell * 0.96 / count, palette.stair, index, staircase);
          }
          }
        }
      }
      if (interactive) cellTops.set(`${x}:${row}`, top);
    }
  }
  for (const cliff of map.cliffs ?? []) {
    if (map.structureFills?.some(fill => fill.purpose === 'pitSide' && fill.x === cliff.x && fill.row === cliff.row && fill.direction === cliff.direction)) continue;
    const geometry=resolvedCliffFace(map,cliff,bindings);if(!geometry)continue;
    const face = new THREE.Group();
    face.position.set(geometry.position.x,geometry.position.y,geometry.position.z);
    face.rotation.y = THREE.MathUtils.degToRad(cliff.direction);
    parent.add(face);
    box(0,0,0,geometry.size.x,geometry.size.y,geometry.size.z,palette.cliff,cliff,face);
  }
  for (const fill of map.structureFills ?? []) {
    const geometry=resolvedStructureFill(map,fill,bindings);if(!geometry)continue;
    // Apply the same visual cell inset as ordinary walls.
    const inset = fill.purpose === 'doorTop' ? .96 : 1;
    const mesh = box(geometry.position.x,geometry.position.y,geometry.position.z,geometry.size.x*inset,geometry.size.y,geometry.size.z*inset,
      fill.role === 'cliff' ? palette.cliff : palette.wall,fill);
    mesh.name = `structure:${fill.id}`;
    if (interactive) cellTops.set(`${fill.x}:${fill.row}`,Math.max(cellTops.get(`${fill.x}:${fill.row}`)??-Infinity,geometry.position.y+geometry.size.y/2));
  }
  for (const bottom of map.pitBottoms ?? []) {
    if (bottom.kind === 'deadzone' && options.showDeadzone === false) continue;
    const mesh = box((bottom.x-(map.width-1)/2)*cell,bottom.y-bottom.thickness/2,((map.height-1)/2-bottom.row)*cell,
      cell,bottom.thickness,cell,bottom.kind==='deadzone'?palette.deadzone:palette.floor,bottom);
    mesh.name = `pit-bottom:${bottom.kind}:${bottom.x}:${bottom.row}`;
    if (bottom.kind==='deadzone') { mesh.castShadow=false;mesh.receiveShadow=false; }
  }
  if (options.showCeilings) for (const ceiling of map.ceilings ?? []) {
    box((ceiling.x - (map.width - 1) / 2) * cell, ceiling.undersideY + cell * FLOOR_THICKNESS_RATIO / 2,
      ((map.height - 1) / 2 - ceiling.row) * cell, cell * 0.96, cell * FLOOR_THICKNESS_RATIO, cell * 0.96, palette.ceiling, ceiling);
  }
  const icons: Record<FixtureRole, string> = { light: '빛', railing: '난간', column: '기둥', arch: '아치', water: '물', hazard: '위험', trap: '함정',
    gate: '문', switch: '스위치', secretDoor: '비밀문', rest: '휴식', merchant: '상인', altar: '제단', decoration: '장식', vegetation: '식생' };
  const addIcon = (id: string, label: string, position: Vec3, selected: boolean, userData: Record<string, unknown>, scale = 0.6, accent?: string) => {
    const labelMaterial = new THREE.SpriteMaterial({ map: labelTexture(label, id, selected, accent), transparent: true, depthTest: true });
    materials.add(labelMaterial);
    const sprite = new THREE.Sprite(labelMaterial);
    sprite.position.copy(position); sprite.scale.set(cell * scale, cell * scale * 136 / 384, 1);
    sprite.userData = userData;
    if (interactive) pickable.push(sprite);
    parent.add(sprite);
  };
  if (interactive && selectedUnmeasured) {
    const selected = options.selected!;
    addIcon('크기 미확정 · 임시 표시', '', { x: (selected.x - (map.width - 1) / 2) * cell,
      y: map.elevations[selected.row][selected.x] + cell * .8, z: ((map.height - 1) / 2 - selected.row) * cell },
      true, { cell: selected }, 1.6, '#a7752c');
  }
  for (const prop of map.propInstances ?? []) {
    const binding=bindings.find(b=>b.id===prop.bindingId),position=propPosition(map,prop,binding);
    const role=prop.role??binding?.role??'prop',isVegetation=role==='vegetation',roleLabel=isVegetation?'식생':role==='decoration'?'장식':'소품';
    const selected=interactive&&(options.selectedProp===prop.id||!!options.selected&&prop.cells.some(c=>c.x===options.selected!.x&&c.row===options.selected!.row));
    if(!propMaterials.has(prop.category)) {
      let hash=0;for(const c of prop.category)hash=(Math.imul(hash,31)+c.charCodeAt(0))>>>0;
      const color=new THREE.Color().setHSL((hash%360)/360,.28,.52);
      propMaterials.set(prop.category,material(color.getHex()));
    }
    const mesh=box(position.x,position.y+prop.size.y/2,position.z,prop.size.x,prop.size.y,prop.size.z,
      selected?palette.selectedConnection:isVegetation?palette.vegetation:propMaterials.get(prop.category)!,prop);
    mesh.name=`prop:${prop.id}`;mesh.userData.propId=prop.id;
    if(interactive)for(const c of prop.cells)cellTops.set(`${c.x}:${c.row}`,position.y+prop.size.y);
    // Large catalogs use selection labels to avoid thousands of canvas textures.
    if(selected||(map.propInstances?.length??0)<=40) addIcon(`${roleLabel} · ${prop.category} · ${meters(prop.size.x)} × ${meters(prop.size.y)} × ${meters(prop.size.z)}m`,
      binding?.label??prop.bindingId,{...position,y:position.y+prop.size.y+cell*.18},selected,{propId:prop.id,cell:{x:prop.x,row:prop.row}},selected?1.5:1.1,isVegetation?'#35773b':'#8a5a3e');
  }
  if (options.showFixtures !== false) for (const fixture of map.fixtures ?? []) {
    if (fixture.wall) {
      const wall = fixture.wall, selected = interactive && options.selectedFixture === fixture.id;
      const binding = bindings.find(item => item.id === fixture.bindingId), mat = selected ? palette.selectedConnection : fixture.role === 'light' ? palette.light : palette.fixture;
      const temporaryBinding = wall.placeholder ? placeholderWallBinding(wall.placeholder) : undefined;
      const temporaryBoxes = temporaryBinding?.wallMount?.collisionBoxes.length ? temporaryBinding.wallMount.collisionBoxes : temporaryBinding?.bounds ? [temporaryBinding.bounds] : [];
      for (const [index, bounds] of wall.bounds.entries()) {
        const pick = (mesh: THREE.Mesh) => { mesh.name = `wall-fixture:${fixture.id}`; mesh.userData.fixtureId = fixture.id; if (interactive) pickable.push(mesh); };
        if (!wall.placeholder) {
          pick(box(bounds.center.x, bounds.center.y, bounds.center.z, bounds.size.x, bounds.size.y, bounds.size.z, mat));
          continue;
        }
        const local = temporaryBoxes[index];
        if (!local) { pick(box(bounds.center.x, bounds.center.y, bounds.center.z, bounds.size.x, bounds.size.y, bounds.size.z, mat)); continue; }
        const root = new THREE.Group(); root.position.copy(wall.position); root.rotation.set(0, THREE.MathUtils.degToRad(wall.rotationY), THREE.MathUtils.degToRad(wall.rotationZ ?? 0), 'YXZ'); parent.add(root);
        const group = new THREE.Group(); group.position.copy(local.center); root.add(group);
        const width = local.size.x, height = local.size.y, depth = local.size.z;
        const part = (x: number, y: number, z: number, sx: number, sy: number, sz: number, material: THREE.Material) => pick(box(x, y, z, sx, sy, sz, material, undefined, group));
        const housing = selected ? palette.selectedConnection : palette.lightHousing;
        if (wall.placeholder.startsWith('pipe')) {
          // Native compound boxes describe intersecting pipe arms, including elbow turns and tee branches.
          const values = [width, height, depth], axis = wall.placeholder === 'pipeEndCap' ? 0 : values.indexOf(Math.max(...values));
          const others = values.filter((_, index) => index !== axis), radius = Math.min(...others) / 2;
          const geometry = new THREE.CylinderGeometry(radius, radius, values[axis], 12); geometries.add(geometry);
          const pipe = new THREE.Mesh(geometry, mat);
          if (axis === 0) pipe.rotation.z = Math.PI / 2; else if (axis === 2) pipe.rotation.x = Math.PI / 2;
          pipe.castShadow = true; pipe.receiveShadow = true; group.add(pipe); pick(pipe);
        } else if (wall.placeholder === 'wallLight' || wall.placeholder === 'doorLight') {
          part(0, 0, -depth * .1, width, height, depth * .8, housing);
          part(0, 0, depth * .35, width * .78, height * .65, depth * .3, selected ? palette.selectedLightSurface : palette.lightSurface);
        } else if (wall.placeholder === 'vent') {
          part(0, 0, -depth * .15, width, height, depth * .7, housing);
          for (let slat = -2; slat <= 2; slat++) part(0, height * slat * .15, depth * .32, width * .84, height * .075, depth * .3, mat);
        } else {
          part(0, 0, -depth * .1, width, height, depth * .8, housing);
          part(0, 0, depth * .35, width * .84, height * .82, depth * .3, mat);
        }
        if (selected || (map.fixtures?.length ?? 0) <= 60) {
          const edges = new THREE.EdgesGeometry(boxGeometry); geometries.add(edges);
          const frameMaterial = new THREE.LineDashedMaterial({ color: selected ? 0x1667cd : 0xa7752c, dashSize: .06, gapSize: .04 }); materials.add(frameMaterial);
          const frame = new THREE.LineSegments(edges, frameMaterial); frame.position.copy(bounds.center); frame.scale.set(bounds.size.x, bounds.size.y, bounds.size.z); frame.computeLineDistances(); frame.name = `wall-placeholder-frame:${fixture.id}`; parent.add(frame);
        }
      }
      if (wall.sockets.length && (selected || (map.fixtures?.length ?? 0) <= 100)) {
        const lineMat = new THREE.LineBasicMaterial({ color: selected ? 0x1667cd : 0x299b8b, depthTest: !selected }); materials.add(lineMat);
        for (const socket of wall.sockets) {
          const length = Math.min(cell * .2, .3);
          const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(socket.position.x, socket.position.y, socket.position.z), new THREE.Vector3(socket.position.x + socket.direction.x * length, socket.position.y + socket.direction.y * length, socket.position.z + socket.direction.z * length)]);
          geometries.add(geometry); const line = new THREE.Line(geometry, lineMat); line.name = `wall-socket:${fixture.id}`; line.renderOrder = selected ? 99 : 0; parent.add(line);
        }
      }
      const top = Math.max(wall.position.y, ...wall.bounds.map(bounds => bounds.center.y + bounds.size.y / 2));
      if (selected || (map.fixtures?.length ?? 0) <= (wall.placeholder ? 20 : 60)) addIcon(wall.placeholder ? wallPlaceholderLabel(wall.placeholder) : binding?.label ?? (fixture.role === 'light' ? '✦ 벽 조명' : '벽 부착물'), wall.placeholder ? '배치 확인 · 실제 프리팹으로 교체 가능' : wall.runId ? '연결 부품' : wall.doorId ? '문 부착물' : '벽 부착물', { ...wall.position, y: top + cell * .13 }, selected, { fixtureId: fixture.id }, selected ? 1.2 : .85, wall.placeholder ? '#a7752c' : fixture.role === 'light' ? '#a77323' : undefined);
      continue;
    }
    const position = fixturePosition(map, fixture);
    const group = new THREE.Group(); group.name = `fixture:${fixture.id}`;
    group.position.copy(position); group.rotation.y = THREE.MathUtils.degToRad(fixture.direction); parent.add(group);
    const selected = interactive && options.selectedFixture === fixture.id;
    const mat = selected ? palette.selectedConnection : fixture.role === 'light' ? palette.light : fixture.role === 'water' ? palette.water
      : fixture.role === 'hazard' || fixture.role === 'trap' ? palette.hazard : fixture.role === 'vegetation' ? palette.vegetation : palette.fixture;
    const part = (x: number, y: number, z: number, sx: number, sy: number, sz: number, partMaterial: THREE.Material = mat) => {
      const mesh = box(x, y, z, sx, sy, sz, partMaterial, undefined, group);
      mesh.userData.fixtureId = fixture.id;
      if (interactive) pickable.push(mesh);
    };
    let iconHeight = cell * 0.72;
    if (fixture.role === 'water' || fixture.role === 'hazard' || fixture.role === 'trap') {
      part(0, cell * 0.025, 0, cell * 0.84, cell * 0.05, cell * 0.84); iconHeight = cell * 0.22;
    } else if (fixture.role === 'railing') {
      for (const side of [-1, 1]) part(side * cell * 0.4, cell * 0.28, 0, cell * 0.06, cell * 0.56, cell * 0.06);
      part(0, cell * 0.5, 0, cell * 0.88, cell * 0.07, cell * 0.07);
    } else if (fixture.role === 'arch' || fixture.role === 'gate' || fixture.role === 'secretDoor') {
      for (const side of [-1, 1]) part(side * cell * 0.38, cell * 0.56, 0, cell * 0.15, cell * 1.12, cell * 0.17);
      part(0, cell * 1.05, 0, cell * 0.92, cell * 0.18, cell * 0.17); iconHeight = cell * 1.3;
      if (fixture.role !== 'arch') part(0, cell * 0.5, 0, cell * 0.6, cell * 0.95, cell * 0.08);
    } else if (fixture.role === 'column') {
      part(0, cell * 0.65, 0, cell * 0.3, cell * 1.3, cell * 0.3); iconHeight = cell * 1.5;
    } else if (fixture.role === 'light') {
      const housing = selected ? palette.selectedConnection : palette.lightHousing;
      const surface = selected ? palette.selectedLightSurface : palette.lightSurface;
      if (fixture.anchor === 'ceiling') {
        // The fixture root is the ceiling underside. Fluorescent strips face down into the room.
        part(0, -cell * 0.025, 0, cell * 0.76, cell * 0.05, cell * 0.25, housing);
        for (const side of [-1, 1]) part(0, -cell * 0.062, side * cell * 0.065,
          cell * 0.66, cell * 0.024, cell * 0.055, surface);
        iconHeight = cell * 0.18;
      } else if (fixture.anchor === 'wall') {
        // Local +Z follows fixture.direction, placing the luminous face in front of the wall.
        part(0, 0, cell * 0.027, cell * 0.55, cell * 0.37, cell * 0.054, housing);
        part(0, 0, cell * 0.06, cell * 0.47, cell * 0.29, cell * 0.014, surface);
        iconHeight = cell * 0.3;
      } else {
        part(0, 0, 0, cell * 0.18, cell * 0.26, cell * 0.18); iconHeight = cell * 0.3;
      }
    } else {
      part(0, cell * 0.22, 0, cell * 0.45, cell * 0.44, cell * 0.45);
    }
    const icon = fixture.role === 'light' ? fixture.anchor === 'ceiling' ? '✦ 천장 조명' : fixture.anchor === 'wall' ? '✦ 벽 조명' : '✦ 조명' : icons[fixture.role];
    addIcon(fixture.id, icon, { ...position, y: position.y + iconHeight }, selected, { fixtureId: fixture.id }, 0.6,
      fixture.role === 'light' ? '#a77323' : fixture.role === 'vegetation' ? '#35773b' : undefined);
  }
  if (options.showMarkers !== false) for (const marker of map.markers ?? []) {
    const position = markerPosition(map, marker);
    addIcon(marker.id, `${{ enemy: '적', reward: '보상', event: '이벤트' }[marker.kind]} · ${marker.label}`,
      { ...position, y: position.y + cell * 0.85 }, interactive && options.selectedMarker === marker.id, { markerId: marker.id }, 0.95);
  }
  };
  drawMap(map, scene, true,options.bindings);
  const designLegend = options.designReport ? document.createElement('div') : null;
  if (options.designReport) {
    const report=options.designReport;
    const overlay=(cells:Cell[],color:number,order:number)=>{
      const unique=[...new Map(cells.filter(c=>c.x>=0&&c.row>=0&&c.x<map.width&&c.row<map.height).map(c=>[`${c.x}:${c.row}`,c])).values()];
      if(!unique.length)return;
      const mat=new THREE.MeshBasicMaterial({color,transparent:true,opacity:.4,depthWrite:false,depthTest:false});materials.add(mat);
      const mesh=new THREE.InstancedMesh(boxGeometry,mat,unique.length),matrix=new THREE.Matrix4();
      unique.forEach((c,i)=>{
        const ramp=map.ramps.find(r=>r.x===c.x&&r.row===c.row);
        matrix.compose(new THREE.Vector3((c.x-(map.width-1)/2)*cell,map.elevations[c.row][c.x]+(ramp?.rise??0)/2+cell*.025,((map.height-1)/2-c.row)*cell),new THREE.Quaternion(),new THREE.Vector3(cell*.9,cell*.02,cell*.9));mesh.setMatrixAt(i,matrix);
      });mesh.renderOrder=order;mesh.name=`design-overlay:${order}`;scene.add(mesh);
    };
    overlay(report.reservedEntryCells,0x3b8ddb,30);overlay(report.combatCells,0x2dac87,31);overlay(report.hazardCells,0xed952c,32);
    overlay(report.issues.flatMap(i=>i.cells??[]),0xd74057,34);
    const lineMat=new THREE.LineBasicMaterial({color:0x8460bd,depthTest:false});materials.add(lineMat);
    const choiceMat=new THREE.LineBasicMaterial({color:0x007c85,depthTest:false});materials.add(choiceMat);
    const choices=report.obstacleChoices??[];
    const routes=[...report.routes.map(route=>({route,choice:false})),...choices.flatMap(choice=>choice.routes.map(route=>({route,choice:true})))];
    for(const {route,choice} of routes)if(route.length>1){
      const geometry=new THREE.BufferGeometry().setFromPoints(route.map(c=>new THREE.Vector3((c.x-(map.width-1)/2)*cell,map.elevations[c.row][c.x]+cell*.08,((map.height-1)/2-c.row)*cell)));
      geometries.add(geometry);const line=new THREE.Line(geometry,choice?choiceMat:lineMat);line.renderOrder=choice?36:35;line.name=choice?'design-obstacle-route':'design-route';scene.add(line);
    }
    if(designLegend){designLegend.className='preview-design-key';designLegend.style.cssText='position:absolute;left:12px;bottom:50px;padding:8px 10px;background:rgba(255,255,255,.94);border-radius:8px;font-size:11px;pointer-events:none;max-width:calc(100% - 24px)';designLegend.textContent=`${report.recipe.label} · 파랑 진입 / 초록 회피 / 보라 경로 / 청록 소품 우회 ${choices.length} / 주황 위험 / 빨강 문제 · 통행 ${report.walkableArea.toFixed(1)}m²`;host.appendChild(designLegend);}
  }
  if (comparison) {
    const group = new THREE.Group(); group.name = 'comparison-module';
    group.position.copy(comparison.transform.position); group.rotation.y = THREE.MathUtils.degToRad(comparison.transform.rotationY);
    scene.add(group); drawMap(comparison.map, group, false,comparison.bindings);
  }
  if (options.showCharacter) {
    const point = options.selected && map.rows[options.selected.row]?.[options.selected.x] !== '_' ? options.selected
      : map.rows.flatMap((row, rowIndex) => [...row].map((tile, x) => ({ tile, x, row: rowIndex }))).find(point => '.DRB'.includes(point.tile));
    if (point) {
      const height = Math.max(0.2, Math.min(10, options.characterHeight ?? map.headroom ?? 1.8)), radius = Math.min(height * 0.18, cell * 0.3);
      const geometry = new THREE.CapsuleGeometry(radius, Math.max(0, height - radius * 2), 8, 12); geometries.add(geometry);
      const capsule = new THREE.Mesh(geometry, palette.character);
      capsule.position.set((point.x - (map.width - 1) / 2) * cell, map.elevations[point.row][point.x] + height / 2, ((map.height - 1) / 2 - point.row) * cell);
      capsule.castShadow = true; scene.add(capsule);
    }
  }
  const grid = new THREE.GridHelper(span + cell * 6, Math.max(map.width, map.height) + 6, 0xb3bfaf, 0xd0d8cb);
  grid.position.y = groundY - cell * 0.005;
  geometries.add(grid.geometry);
  for (const entry of Array.isArray(grid.material) ? grid.material : [grid.material]) materials.add(entry);
  scene.add(grid);

  const selected = options.selected;
  if (selected && selected.x >= 0 && selected.row >= 0 && selected.x < map.width && selected.row < map.height) {
    const y = map.rows[selected.row][selected.x] === '_' ? 0 : map.elevations[selected.row][selected.x];
    const top = cellTops.get(`${selected.x}:${selected.row}`) ?? y;
    const height = Math.max(cell * 0.1, top - y + cell * 0.08);
    const geometry = new THREE.EdgesGeometry(boxGeometry);
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x2679dd, depthTest: false, transparent: true });
    geometries.add(geometry);
    materials.add(lineMaterial);
    const outline = new THREE.LineSegments(geometry, lineMaterial);
    outline.position.set((selected.x - (map.width - 1) / 2) * cell, y + height / 2,
      ((map.height - 1) / 2 - selected.row) * cell);
    outline.scale.set(cell, height, cell);
    outline.renderOrder = 100;
    scene.add(outline);
  }
  if (options.region) {
    const region = options.region;
    const geometry = new THREE.EdgesGeometry(boxGeometry);
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0xd68c27, depthTest: false, transparent: true });
    geometries.add(geometry); materials.add(lineMaterial);
    const outline = new THREE.LineSegments(geometry, lineMaterial);
    outline.position.set((region.x + (region.width - 1) / 2 - (map.width - 1) / 2) * cell, minimum + cell * 0.035,
      ((map.height - 1) / 2 - region.row - (region.height - 1) / 2) * cell);
    outline.scale.set(region.width * cell, cell * 0.07, region.height * cell); outline.renderOrder = 101;
    scene.add(outline);
  }

  // Camera-oriented axis widget keeps Unity's Y-up visible during orbit.
  const axesScene = new THREE.Scene();
  const axesCamera = new THREE.OrthographicCamera(-1.9, 1.9, 1.9, -1.9, 0.1, 20);
  const axes = new THREE.AxesHelper(1.25);
  geometries.add(axes.geometry);
  for (const entry of Array.isArray(axes.material) ? axes.material : [axes.material]) materials.add(entry);
  axesScene.add(axes);
  for (const [label, position, color] of [
    ['X', new THREE.Vector3(1.55, 0, 0), '#d34e40'],
    ['Y', new THREE.Vector3(0, 1.55, 0), '#42814b'],
    ['Z', new THREE.Vector3(0, 0, 1.55), '#397abd'],
  ] as const) {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const context = canvas.getContext('2d')!;
    context.font = 'bold 42px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
    context.fillStyle = color; context.fillText(label, 32, 34);
    const texture = new THREE.CanvasTexture(canvas);
    textures.add(texture);
    const labelMaterial = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    materials.add(labelMaterial);
    const sprite = new THREE.Sprite(labelMaterial);
    sprite.position.copy(position);
    sprite.scale.setScalar(0.65);
    axesScene.add(sprite);
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let down: { x: number; y: number; pointerId: number; moved: boolean } | null = null;
  const pointerDown = (event: PointerEvent) => {
    if (event.button === 0 && (options.onSelect || options.onFixtureSelect || options.onMarkerSelect || options.onPropSelect)) down = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, moved: false };
  };
  const pointerMove = (event: PointerEvent) => {
    if (down && event.pointerId === down.pointerId && Math.hypot(event.clientX - down.x, event.clientY - down.y) >= 5) down.moved = true;
  };
  const pointerUp = (event: PointerEvent) => {
    if (!down || event.pointerId !== down.pointerId) return;
    const click = !down.moved && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 5;
    down = null;
    if (!click) return;
    const bounds = renderer.domElement.getBoundingClientRect();
    pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    camera.updateMatrixWorld();
    scene.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, camera);
    // Labels are drawn above geometry, so their click target follows that same visual priority.
    const hit = raycaster.intersectObjects(connectionLabels, false)[0] ?? raycaster.intersectObjects(pickable, false)[0];
    if (hit) {
      if (hit.object.userData.fixtureId) { options.onFixtureSelect?.(hit.object.userData.fixtureId as string); return; }
      if (hit.object.userData.markerId) { options.onMarkerSelect?.(hit.object.userData.markerId as string); return; }
      if (hit.object.userData.propId) {
        const prop=map.propInstances?.find(p=>p.id===hit.object.userData.propId);
        if(options.onPropSelect)options.onPropSelect(hit.object.userData.propId as string);
        else if(prop){const x=Math.floor(hit.point.x/cell+map.width/2),row=Math.floor(map.height/2-hit.point.z/cell);const chosen=prop.cells.find(c=>c.x===x&&c.row===row)??prop;options.onSelect?.(chosen.x,chosen.row);}
        return;
      }
      const cellIndex = hit.object.userData.cell as { x: number; row: number } | undefined;
      if (cellIndex) options.onSelect?.(cellIndex.x, cellIndex.row);
      return;
    }
    const intersection = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!intersection) return;
    const x = Math.floor(intersection.x / cell + map.width / 2);
    const row = Math.floor(map.height / 2 - intersection.z / cell);
    if (x >= 0 && row >= 0 && x < map.width && row < map.height) options.onSelect?.(x, row);
  };
  const pointerCancel = () => { down = null; };
  renderer.domElement.addEventListener('pointerdown', pointerDown);
  renderer.domElement.addEventListener('pointermove', pointerMove);
  renderer.domElement.addEventListener('pointerup', pointerUp);
  renderer.domElement.addEventListener('pointercancel', pointerCancel);

  let width = 1, height = 1;
  const resize = () => {
    width = Math.max(1, host.clientWidth); height = Math.max(1, host.clientHeight);
    const aspect = width / height, size = extent * 0.64;
    camera.left = -size * aspect; camera.right = size * aspect;
    camera.top = size; camera.bottom = -size;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  let frame = 0;
  const animate = () => {
    controls.update();
    // Keep connection IDs readable at every map size and zoom level.
    const worldPerPixel = (camera.top - camera.bottom) / (height * camera.zoom);
    const labelWidth = Math.max(132, Math.min(168, width * 0.24));
    for (const label of connectionLabels) label.scale.set(labelWidth * worldPerPixel, labelWidth * 136 / 384 * worldPerPixel, 1);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, width, height);
    renderer.render(scene, camera);
    renderer.clearDepth();
    const widget = Math.min(108, width / 4, height / 3);
    renderer.setViewport(8, 8, widget, widget);
    renderer.setScissor(8, 8, widget, widget);
    renderer.setScissorTest(true);
    axesCamera.position.copy(camera.position).sub(controls.target).normalize().multiplyScalar(5);
    axesCamera.up.copy(camera.up);
    axesCamera.lookAt(0, 0, 0);
    renderer.autoClear = false;
    renderer.render(axesScene, axesCamera);
    renderer.autoClear = true;
    renderer.setScissorTest(false);
    frame = requestAnimationFrame(animate);
  };
  animate();
  return {
    getState: () => ({
      position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
      zoom: camera.zoom,
    }),
    dispose: () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('pointermove', pointerMove);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      renderer.domElement.removeEventListener('pointercancel', pointerCancel);
      controls.dispose();
      geometries.forEach(geometry => geometry.dispose());
      materials.forEach(entry => entry.dispose());
      textures.forEach(texture => texture.dispose());
      sun.shadow.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      connectionKey?.remove();
      propKey?.remove();
      wallKey?.remove();
      designLegend?.remove();
    },
  };
}
