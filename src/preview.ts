import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { GridMap } from './shared/types';
import { connectionPose, doorRotation, FLOOR_THICKNESS_RATIO } from './shared/map';

export interface PreviewState {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  zoom: number;
}
export interface PreviewOptions {
  selected?: { x: number; row: number } | null;
  onSelect?: (x: number, row: number) => void;
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
  const connections = map.connections.filter(connection => Number.isInteger(connection.x) && Number.isInteger(connection.row)
    && connection.x >= 0 && connection.row >= 0 && connection.x < map.width && connection.row < map.height
    && map.rows[connection.row][connection.x] === 'D' && [0, 90, 180, 270].includes(connection.direction)
    && Number.isFinite(connection.width) && connection.width > 0 && Number.isFinite(connection.height) && connection.height > 0);
  const connectionByCell = new Map(connections.map(connection => [`${connection.x}:${connection.row}`, connection]));
  renderer.domElement.setAttribute('aria-label', `높이와 계단을 편집할 수 있는 3D 맵. 셀 또는 연결문을 클릭해 선택하세요.${connections.length ? ` 외부 연결: ${connections.map(connection => `${connection.id} ${connection.label}`).join(', ')}.` : ''}`);
  const connectionKey = connections.length ? document.createElement('div') : null;
  if (connectionKey) {
    connectionKey.className = 'preview-connection-key';
    connectionKey.setAttribute('aria-hidden', 'true');
    connectionKey.textContent = `↗ 외부 연결 ${connections.length}개`;
    host.appendChild(connectionKey);
  }
  const span = Math.max(map.width, map.height) * cell;
  const elevations = map.elevations.flat();
  const minimum = Math.min(0, ...elevations);
  const maximum = Math.max(0, ...elevations, ...map.ramps.map(ramp => map.elevations[ramp.row][ramp.x] + ramp.rise),
    ...connections.map(connection => map.elevations[connection.row][connection.x] + connection.height + cell * 0.6));
  const verticalSpan = maximum - minimum;
  const extent = Math.max(span + (connections.length ? cell * 2 : 0), verticalSpan * 1.3, cell * 8);
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
    prop: material(0xb77756), connection: material(0x268d86), selectedConnection: material(0x2679dd),
    terrain: material(0xa4ad9d), stair: material(0xb69768),
  };
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  geometries.add(boxGeometry);
  const arrowShape = new THREE.Shape();
  arrowShape.moveTo(-cell * 0.16, 0);
  arrowShape.lineTo(0, cell * 0.34);
  arrowShape.lineTo(cell * 0.16, 0);
  arrowShape.closePath();
  const arrowGeometry = new THREE.ExtrudeGeometry(arrowShape, { depth: cell * 0.035, bevelEnabled: false });
  geometries.add(arrowGeometry);
  const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number,
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
  const labelTexture = (id: string, label: string, selected: boolean): THREE.CanvasTexture => {
    const canvas = document.createElement('canvas');
    canvas.width = 384; canvas.height = 136;
    const context = canvas.getContext('2d')!;
    const color = selected ? '#2679dd' : '#247e78';
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
  const ramps = new Map(map.ramps.map(ramp => [`${ramp.x}:${ramp.row}`, ramp]));
  const cellTops = new Map<string, number>();
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
      const supportHeight = y - groundY - cell * 0.12;
      if (supportHeight > cell * 0.04) {
        box(px, groundY + supportHeight / 2, pz, cell * 0.94, supportHeight, cell * 0.94, palette.terrain, index);
      }
      box(px, y - cell * FLOOR_THICKNESS_RATIO / 2, pz, cell * 0.96, cell * FLOOR_THICKNESS_RATIO, cell * 0.96, palette.floor, index);
      if (tile === '#') {
        top += cell * 0.95;
        box(px, y + cell * 0.475, pz, cell * 0.96, cell * 0.95, cell * 0.96, palette.wall, index);
      }
      if (tile === 'P') {
        top += cell * 0.6;
        box(px, y + cell * 0.26, pz, cell * 0.62, cell * 0.52, cell * 0.62, palette.prop, index);
        box(px, y + cell * 0.56, pz, cell * 0.7, cell * 0.08, cell * 0.7, palette.prop, index);
      }
      if (tile === 'D') {
        const connection = connectionByCell.get(`${x}:${row}`);
        if (connection) {
          const pose = connectionPose(map, connection);
          const port = new THREE.Group();
          port.name = `connection:${connection.id}`;
          port.position.copy(pose.position);
          port.rotation.y = THREE.MathUtils.degToRad(pose.rotation.y);
          scene.add(port);
          const selected = options.selected?.x === x && options.selected.row === row;
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
          pickable.push(arrow);
          port.add(arrow);
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
          top = y + connection.height + thickness;
        } else {
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
          scene.add(staircase);
          const count = Math.max(3, Math.min(16, Math.ceil(ramp.rise / (cell * 0.12))));
          for (let step = 0; step < count; step++) {
            const height = ramp.rise * (step + 1) / count;
            box(0, height / 2, -cell * 0.48 + (step + 0.5) * cell * 0.96 / count,
              cell * 0.88, height, cell * 0.96 / count, palette.stair, index, staircase);
          }
        }
      }
      cellTops.set(`${x}:${row}`, top);
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
    if (event.button === 0 && options.onSelect) down = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, moved: false };
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
      const cellIndex = hit.object.userData.cell as { x: number; row: number };
      options.onSelect?.(cellIndex.x, cellIndex.row);
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
    },
  };
}
