import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { skeletonOverlay } from "./skeleton-overlay";
import { loadedModelBounds, frameModelBounds } from "./viewport-framing";
import { meshEntries, gltfMeshIdentities, inspectMeshes, showMeshAppearance, syncMeshWire, disposeMeshInspection,
  measurementGuides, disposeGuides, formatLength, type MeshEntry, type MeshSelection,
  type ModelMeasurement, type PreviewTransform } from "./viewport-inspection";
import { physicalSizeTransform, type PhysicalSize } from "../shared/graphics-size";
import "./viewport-inspection.css";
import { createNativeEdgeViews, syncNativeEdgeView, disposeNativeEdgeView, nativeCounts, type NativeEdgeView } from './native-topology-view';
import type { NativeTopologyResult } from '../shared/native-topology';
import {
  RotateCcw,
  Move,
  Rotate3D,
  Maximize,
  Pause,
  Play,
  Layers3,
} from "lucide-react";
import type { Project, Transform } from "../shared/types";
type Props = {
  project: Project;
  selectedPart?: string;
  previewId?: string;
  onSelect?: (id: string) => void;
  onTransform?: (id: string, t: Transform) => void;
  animation?: boolean;
  onMeshSelect?: (selection: MeshSelection | null) => void;
  onBounds?: (measurement: ModelMeasurement) => void;
  previewTransform?: PreviewTransform;
  physicalSize?: PhysicalSize;
  unitsKnown?: boolean;
  nativePolygonCount?: number;
  nativeVersionId?: string;
};
export function Viewport({
  project,
  selectedPart,
  previewId,
  onSelect,
  onTransform,
  animation,
  onMeshSelect, onBounds, previewTransform, physicalSize, unitsKnown = false, nativePolygonCount, nativeVersionId,
}: Props) {
  const host = useRef<HTMLDivElement>(null),
    api = useRef<any>(null);
  const [error, setError] = useState(""),
    [clips, setClips] = useState<string[]>([]),
    [clip, setClip] = useState(""),
    [playing, setPlaying] = useState(true),
    [explode, setExplode] = useState(false),
    [showSkeleton, setShowSkeleton] = useState(true),
    [boneCount, setBoneCount] = useState(0),
    [mode, setMode] = useState<"translate" | "rotate" | "scale">("translate");
  const [meshList, setMeshList] = useState<MeshEntry[]>([]);
  const [selectedMesh, setSelectedMesh] = useState("");
  const [hiddenMeshes, setHiddenMeshes] = useState<string[]>([]);
  const [solid, setSolid] = useState(false), [wire, setWire] = useState(false), [guides, setGuides] = useState(false);
  const [hasAnimation, setHasAnimation] = useState(false);
  const [wireMode, setWireMode] = useState<'game' | 'native'>('game');
  const [topology, setTopology] = useState<NativeTopologyResult>();
  const [topologyLoading, setTopologyLoading] = useState(false), [topologyError, setTopologyError] = useState('');
  const [nativeLoaded, setNativeLoaded] = useState(false);
  const topologyIdentity = useRef(''); topologyIdentity.current = `${project.id}:${nativeVersionId ?? ''}`;
  useEffect(() => { setTopology(undefined); setTopologyLoading(false); setTopologyError(''); setNativeLoaded(false); setWireMode('game'); }, [project.id, nativeVersionId]);
  async function originalEdges() {
    setWire(true);
    if (topology?.status === 'ready') { setWireMode('native'); return; }
    if (!nativeVersionId || topologyLoading) return;
    const identity = topologyIdentity.current;
    setTopologyLoading(true); setTopologyError('');
    try {
      const result = await window.desktop.call({ type: 'graphics.topology', id: project.id, versionId: nativeVersionId }) as NativeTopologyResult;
      if (topologyIdentity.current !== identity) return;
      setTopology(result); setWireMode(result.status === 'ready' ? 'native' : 'game');
    } catch (error) { if (topologyIdentity.current === identity) setTopologyError(error instanceof Error ? error.message : String(error)); }
    finally { if (topologyIdentity.current === identity) setTopologyLoading(false); }
  }
  const callbacks = useRef({ onSelect, onTransform, onMeshSelect, onBounds });
  callbacks.current = { onSelect, onTransform, onMeshSelect, onBounds };
  const baseline = inspectMeshes(meshList);
  let effectiveTransform = previewTransform, sizeError = "";
  if (physicalSize && baseline.measurement) {
    try {
      const t = physicalSizeTransform({ min: baseline.bounds.min, max: baseline.bounds.max }, physicalSize,
        baseline.measurement.hasSkin || baseline.measurement.hasMorph || hasAnimation);
      effectiveTransform = { scale: [t.factors.x, t.factors.y, t.factors.z],
        translation: [-t.anchor.x * t.factors.x, -t.anchor.y * t.factors.y, -t.anchor.z * t.factors.z] };
    } catch (error) { sizeError = error instanceof Error ? error.message : String(error); }
  }
  const calibrated = unitsKnown || (!!physicalSize && physicalSize.mode !== "keep" && !sizeError);
  const appearance = useRef({ solid, wire, wireMode, selectedMesh, hiddenMeshes, guides, previewTransform: effectiveTransform, unitsKnown: calibrated });
  appearance.current = { solid, wire, wireMode, selectedMesh, hiddenMeshes, guides, previewTransform: effectiveTransform, unitsKnown: calibrated };
  const inspected = inspectMeshes(meshList, effectiveTransform);
  const selectedStats = inspectMeshes(meshList.filter(entry => entry.id === selectedMesh), effectiveTransform);
  function selectMesh(id: string) {
    setSelectedMesh(id);
    const entry = meshList.find(item => item.id === id);
    callbacks.current.onMeshSelect?.(entry ? { id: entry.id, name: entry.name, sourceId: entry.sourceId, sourceName: entry.sourceName } : null);
  }
  const skeletonVisible = useRef(showSkeleton);
  skeletonVisible.current = showSkeleton;
  const sources = previewId
    ? [
        {
          id: previewId,
          asset: project.assets.find((a) => a.id === previewId),
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
          visible: true,
        },
      ]
    : project.parts
        .filter((p) => p.visible)
        .map((p) => ({
          id: p.id,
          asset: project.assets.find((a) => a.id === p.selectedId),
          transform: p.transform,
          visible: p.visible,
        }));
  const signature = JSON.stringify(sources);
  useEffect(() => {
    if (!host.current) return;
    let dead = false,
      frame = 0;
    const mixers: THREE.AnimationMixer[] = [];
    const actions: THREE.AnimationAction[] = [];
    const skeletons: NonNullable<ReturnType<typeof skeletonOverlay>>[] = [];
    setBoneCount(0);
    setMeshList([]); setSelectedMesh(""); setHiddenMeshes([]); setHasAnimation(false);
    callbacks.current.onMeshSelect?.(null);
    const entries: MeshEntry[] = [];
    const nativeViews: NativeEdgeView[] = [];
    setNativeLoaded(false);
    const previewRoot = new THREE.Group();
    let measures: THREE.Group | undefined;
    let hasAnyAnimation = false;
    const scene = new THREE.Scene();
    scene.add(previewRoot);
    scene.background = new THREE.Color("#151a1b");
    scene.fog = new THREE.Fog("#151a1b", 9, 22);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setError("3D 가속을 사용할 수 없습니다. 그래픽 드라이버를 확인하세요.");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    const room = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(room, 0.04);
    scene.environment = environment.texture;
    room.dispose();
    pmrem.dispose();
    host.current.appendChild(renderer.domElement);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    camera.position.set(3, 2.2, 4.7);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(0, 0.85, 0);
    orbit.enableDamping = true;
    orbit.minDistance = 0.2;
    orbit.maxDistance = 15;
    orbit.update();
    scene.add(new THREE.HemisphereLight(0xdce8df, 0x3d4844, 2));
    const key = new THREE.DirectionalLight(0xffebd4, 3);
    key.position.set(3, 5, 3);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x8fbcff, 2);
    fill.position.set(-3, 3, -2);
    scene.add(fill);
    const grid = new THREE.GridHelper(10, 50, 0x53615d, 0x293331);
    scene.add(grid);
    const platform = new THREE.Mesh(
      new THREE.CylinderGeometry(0.62, 0.67, 0.035, 80),
      new THREE.MeshStandardMaterial({ color: 0x27332e, roughness: 0.9 }),
    );
    platform.position.y = -0.027;
    scene.add(platform);
    const axes = new THREE.AxesHelper(0.25);
    axes.position.set(-0.8, 0.01, 0.6);
    scene.add(axes);
    const objects = new Map<string, THREE.Group>();
    const applyInspection = () => {
      const state = appearance.current;
      for (const entry of entries) {
        showMeshAppearance(entry, state.solid, state.selectedMesh === entry.id);
        entry.mesh.visible = entry.originallyVisible && !state.hiddenMeshes.includes(entry.id);
      }
    };
    const applyPreview = () => {
      const state = appearance.current, transform = state.previewTransform;
      previewRoot.scale.fromArray(transform?.scale ?? [1, 1, 1]);
      previewRoot.position.fromArray(transform?.translation ?? [0, 0, 0]);
      previewRoot.updateWorldMatrix(true, true);
      if (measures) disposeGuides(measures);
      measures = measurementGuides(inspectMeshes(entries, transform).bounds, state.unitsKnown);
      measures.visible = state.guides;
      scene.add(measures);
      grid.visible = entries.length === 0;
      axes.visible = entries.length === 0;
    };
    const fitModels = (direction = camera.position.clone().sub(orbit.target)) => {
      const bounds = loadedModelBounds(objects.values());
      const framingBounds = bounds.clone();
      if (appearance.current.guides && appearance.current.unitsKnown && entries.length) {
        const rest = inspectMeshes(entries, appearance.current.previewTransform).bounds;
        const margin = rest.getSize(new THREE.Vector3()).length() * 0.12;
        // A true 1 m bar can exceed a tiny object. Include both endpoints rather
        // than silently clipping the scale reference at the edge of the canvas.
        framingBounds.expandByPoint(new THREE.Vector3(rest.min.x + 1, rest.min.y, rest.max.z + margin * 2));
      }
      const framing = frameModelBounds(camera, framingBounds, direction);
      if (!framing) return false;
      if (previewId) {
        // Imported origins may lie halfway through the asset. Move only the
        // preview guides; keep all source transforms and coordinates intact.
        platform.visible = false;
        grid.position.y = bounds.min.y - Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.003, 1e-6);
        axes.position.y = grid.position.y;
      }
      orbit.target.copy(framing.center);
      orbit.minDistance = framing.minDistance;
      orbit.maxDistance = framing.maxDistance;
      if (scene.fog instanceof THREE.Fog) {
        scene.fog.near = framing.fogNear;
        scene.fog.far = framing.fogFar;
      }
      orbit.update();
      return true;
    };
    const controls = new TransformControls(camera, renderer.domElement);
    scene.add(controls.getHelper());
    controls.addEventListener("dragging-changed", (e) => {
      orbit.enabled = !e.value;
    });
    controls.addEventListener("mouseUp", () => {
      const obj = controls.object;
      if (!obj) return;
      callbacks.current.onTransform?.(obj.userData.partId, {
        position: obj.position.toArray() as [number, number, number],
        rotation: [...obj.rotation.toArray().slice(0, 3)].map((v) =>
          THREE.MathUtils.radToDeg(v as number),
        ) as [number, number, number],
        scale: obj.scale.toArray() as [number, number, number],
      });
    });
    const manager = new THREE.LoadingManager();
    manager.onError = () => {
      if (!dead) setError("모델 또는 텍스처를 읽지 못했습니다. 원본 파일과 앱의 리소스 접근 설정을 확인하세요.");
    };
    const loader = new GLTFLoader(manager);
    setError("");
    setClips([]);
    const allClips: string[] = [];
    for (const [i, s] of sources.entries()) {
      if (!s.asset) continue;
      const loaded = (gltf: import('three/addons/loaders/GLTFLoader.js').GLTF) => {
          if (dead) {
            gltf.scene.traverse((o: any) => {
              o.geometry?.dispose();
            });
            return;
          }
          const group = new THREE.Group();
          group.userData.partId = s.id;
          group.add(gltf.scene);
          // Bounds are captured in the source rest pose, before preview-only sizing.
          previewRoot.scale.set(1, 1, 1); previewRoot.position.set(0, 0, 0);
          previewRoot.add(group);
          group.position.fromArray(s.transform.position);
          group.rotation.set(
            ...(s.transform.rotation.map((x) =>
              THREE.MathUtils.degToRad(x),
            ) as [number, number, number]),
          );
          group.scale.fromArray(s.transform.scale);
          if (explode && !previewId) group.position.x += (i - 1) * 0.65;
          group.traverse((o) => (o.userData.partId = s.id));
          objects.set(s.id, group);
          const added = meshEntries(group, s.id, gltfMeshIdentities(gltf.scene, gltf.parser));
          entries.push(...added);
          added.forEach(entry => scene.add(entry.wire));
          if (topology?.status === 'ready' && previewId) {
            try {
              const views = createNativeEdgeViews(added, gltf.parser, topology.map);
              nativeViews.push(...views); views.forEach(view => scene.add(view.lines)); setNativeLoaded(true);
            } catch (error) { setTopologyError(error instanceof Error ? error.message : String(error)); setWireMode('game'); }
          }
          hasAnyAnimation ||= gltf.animations.length > 0;
          setHasAnimation(hasAnyAnimation);
          setMeshList([...entries]);
          const measurement = inspectMeshes(entries).measurement;
          if (measurement) callbacks.current.onBounds?.({ ...measurement, hasAnimation: hasAnyAnimation });
          applyInspection(); applyPreview();
          fitModels();
          const skeleton = skeletonOverlay(gltf.scene);
          if (skeleton) {
            skeleton.overlay.visible = skeletonVisible.current;
            skeletons.push(skeleton); scene.add(skeleton.overlay);
            setBoneCount(skeletons.reduce((sum, item) => sum + item.count, 0));
          }
          if (s.id === selectedPart && !previewId) {
            scene.add(new THREE.BoxHelper(group, 0xaee6bf));
            if (!project.parts.find((p) => p.id === s.id)?.locked && !explode)
              controls.attach(group);
          }
          if (gltf.animations.length) {
            const mixer = new THREE.AnimationMixer(gltf.scene);
            mixers.push(mixer);
            for (const c of gltf.animations) {
              const a = mixer.clipAction(c);
              actions.push(a);
              allClips.push(c.name);
            }
            setClips([...new Set(allClips)]);
            if (animation) {
              const selected =
                gltf.animations.find((c) => c.name === clip) ??
                gltf.animations[0];
              mixer.clipAction(selected).play();
            }
          }
        };
      const failed = () => {
        if (dead) return;
        if (topology?.status === 'ready') {
          setTopologyError('원본 면 미리보기를 불러오지 못했습니다.'); setTopology(undefined); setWireMode('game');
        } else setError("모델을 읽지 못했습니다. 자체 포함 GLB와 압축 형식을 확인하세요.");
      };
      if (topology?.status === 'ready' && previewId) {
        const url = window.desktop.assetUrl(project.id, topology.preview.path);
        void fetch(url).then(async response => {
          if (!response.ok) throw Error('원본 면 미리보기에 접근하지 못했습니다.');
          const data = await response.arrayBuffer();
          const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(value => value.toString(16).padStart(2, '0')).join('');
          if (digest !== topology.preview.sha256 || digest !== topology.map.previewSha256) throw Error('원본 면 미리보기 해시가 달라 표시하지 않았습니다.');
          if (!dead) loader.parse(data, '', loaded, failed);
        }).catch(error => { if (!dead) { setTopologyError(error instanceof Error ? error.message : String(error)); setTopology(undefined); setWireMode('game'); } });
      } else loader.load(window.desktop.assetUrl(project.id, s.asset.file), loaded, undefined, failed);
    }
    if (!sources.some((s) => s.asset)) {
      // Visible alignment guide, never presented as a generated candidate.
      const mat = new THREE.MeshStandardMaterial({
        color: 0x667f71,
        transparent: true,
        opacity: 0.22,
        wireframe: true,
      });
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.2, 0.53, 6, 14),
        mat,
      );
      body.position.y = 1.04;
      scene.add(body);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 18, 14), mat);
      head.position.y = 1.62;
      scene.add(head);
      for (const s of [-1, 1]) {
        const leg = new THREE.Mesh(
          new THREE.CapsuleGeometry(0.075, 0.65, 6, 10),
          mat,
        );
        leg.position.set(s * 0.13, 0.43, 0);
        scene.add(leg);
        const arm = new THREE.Mesh(
          new THREE.CapsuleGeometry(0.06, 0.53, 6, 10),
          mat,
        );
        arm.rotation.z = s * 0.45;
        arm.position.set(s * 0.37, 1.12, 0);
        scene.add(arm);
      }
    }
    const ray = new THREE.Raycaster();
    const down = (event: MouseEvent) => {
      if (controls.dragging) return;
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(
        new THREE.Vector2(
          ((event.clientX - r.left) / r.width) * 2 - 1,
          (-(event.clientY - r.top) / r.height) * 2 + 1,
        ),
        camera,
      );
      const hits = ray.intersectObjects([...objects.values()], true);
      const hit = hits.find(hit => entries.some(entry => entry.mesh === hit.object && entry.mesh.visible));
      if (hit) {
        const entry = entries.find(item => item.mesh === hit.object)!;
        setSelectedMesh(entry.id);
        callbacks.current.onMeshSelect?.({ id: entry.id, name: entry.name, sourceId: entry.sourceId, sourceName: entry.sourceName });
        if (!previewId) callbacks.current.onSelect?.(entry.assetId);
      }
    };
    renderer.domElement.addEventListener("dblclick", down);
    const resize = new ResizeObserver(() => {
      if (!host.current) return;
      const { clientWidth: w, clientHeight: h } = host.current;
      if (w <= 0 || h <= 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      fitModels();
    });
    resize.observe(host.current);
    const clock = new THREE.Clock();
    api.current = { camera, orbit, controls, actions, mixers, objects, scene, skeletons, fitModels,
      applyInspection, applyPreview, entries, playing };
    controls.setMode(mode);
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const dt = clock.getDelta();
      if (api.current?.playing !== false) mixers.forEach((m) => m.update(dt));
      skeletons.forEach(s => { if (s.overlay.visible) s.update(); });
      orbit.update();
      scene.updateMatrixWorld(true);
      entries.forEach(entry => syncMeshWire(entry, appearance.current.wire && appearance.current.wireMode === 'game'));
      nativeViews.forEach(view => syncNativeEdgeView(view, appearance.current.wire && appearance.current.wireMode === 'native'));
      renderer.render(scene, camera);
    };
    tick();
    return () => {
      dead = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      orbit.dispose();
      controls.dispose();
      renderer.domElement.removeEventListener("dblclick", down);
      entries.forEach(disposeMeshInspection);
      nativeViews.forEach(disposeNativeEdgeView);
      if (measures) disposeGuides(measures);
      scene.traverse((o: any) => {
        o.geometry?.dispose();
        const materials = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of materials)
          if (m) {
            for (const v of Object.values(m))
              if (v instanceof THREE.Texture) v.dispose();
            m.dispose();
          }
      });
      environment.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [signature, project.id, selectedPart, previewId, explode, animation, topology?.status === 'ready' ? topology.preview.sha256 : '']);
  useEffect(() => { api.current?.applyInspection(); }, [solid, selectedMesh, hiddenMeshes]);
  const transformSignature = JSON.stringify(effectiveTransform);
  useEffect(() => { api.current?.applyPreview(); api.current?.fitModels(); }, [transformSignature, calibrated]);
  useEffect(() => { api.current?.applyPreview(); api.current?.fitModels(); }, [guides]);
  useEffect(() => {
    if (api.current) api.current.playing = playing;
  }, [playing]);
  useEffect(() => {
    api.current?.skeletons.forEach((s: NonNullable<ReturnType<typeof skeletonOverlay>>) => { s.overlay.visible = showSkeleton; });
  }, [showSkeleton]);
  useEffect(() => {
    api.current?.controls.setMode(mode);
  }, [mode]);
  useEffect(() => {
    const a = api.current?.actions as THREE.AnimationAction[] | undefined;
    if (a && clip) {
      a.forEach((x) => x.stop());
      a.filter((x) => x.getClip().name === clip).forEach((x) =>
        x.reset().play(),
      );
    }
  }, [clip]);
  function view(x: number, y: number, z: number) {
    const current = api.current;
    if (!current || current.fitModels(new THREE.Vector3(x, y, z))) return;
    current.orbit.target.set(0, 0.85, 0);
    current.camera.position.copy(current.orbit.target).add(new THREE.Vector3(x, y, z).normalize().multiplyScalar(5.7));
    current.orbit.update();
  }
  const counts = topology?.status === 'ready' && nativeLoaded ? nativeCounts(topology.map) : undefined;
  const selectedCounts = topology?.status === 'ready' && nativeLoaded ? nativeCounts(topology.map, selectedMesh, meshList) : undefined;
  const unavailable = topology?.status === 'unavailable' ? topology.reason : topologyError;
  return (
    <div className="viewport inspection-viewport" data-bone-count={boneCount} data-skeleton-visible={boneCount > 0 && showSkeleton}
      data-mesh-count={meshList.length} data-wire-visible={wire} data-wire-mode={wireMode} data-display-mode={solid ? "solid" : "material"}>
      <div className="viewport-top">
        <span className="viewport-label">
          <span className="status-dot" />{" "}
          {previewId ? "모델 검수" : "조립 미리보기"}{" "}
          <small> PERSPECTIVE</small>
        </span>
        <div className="segmented">
          {boneCount > 0 && <button data-testid="viewport-skeleton-toggle" aria-pressed={showSkeleton} onClick={() => setShowSkeleton(!showSkeleton)} title="실제 리그의 뼈와 관절 표시">뼈대 {showSkeleton ? "ON" : "OFF"} · {boneCount}</button>}
          <button onClick={() => view(0, 0, 1)}>정면</button>
          <button onClick={() => view(1, 0, 0)}>측면</button>
          <button onClick={() => view(0, 0, -1)}>후면</button>
          <button title="시점 초기화" onClick={() => view(3, 1.35, 4.7)}>
            <RotateCcw size={14} />
          </button>
        </div>
      </div>
      {meshList.length > 0 && <div className="inspection-toolbar">
        <button aria-pressed={!solid} onClick={() => setSolid(false)}>재질 보기</button>
        <button aria-pressed={solid} onClick={() => setSolid(true)}>단색 보기</button>
        <button data-testid="viewport-wire-toggle" aria-pressed={wire} onClick={() => setWire(!wire)}>메시 선 {wire ? "ON" : "OFF"}</button>
        <button data-testid="viewport-native-topology" aria-pressed={wireMode === 'native'} disabled={!nativeVersionId || topologyLoading || topology?.status === 'unavailable' || !!topologyError} onClick={() => void originalEdges()}>원본 면 선</button>
        <button data-testid="viewport-game-topology" aria-pressed={wireMode === 'game'} onClick={() => { setWireMode('game'); setWire(true); }}>게임용 삼각형 선</button>
        <button aria-pressed={guides} onClick={() => setGuides(!guides)}>치수·기준자 {guides ? "ON" : "OFF"}</button>
      </div>}
      {(topologyLoading || unavailable || topology?.status === 'ready') && <div className="topology-status" data-testid="viewport-topology-status" data-state={topologyLoading ? 'loading' : unavailable ? 'unavailable' : nativeLoaded ? 'ready' : 'loading'} role="status">
        {topologyLoading ? '원본 면 검사 중 · 로컬 처리 · 추가 생성 비용 없음' : unavailable ? `${unavailable} 게임용 삼각형 선을 표시합니다.` : counts ? `원본 면: 사각형 ${counts.quads.toLocaleString()} · 삼각형 ${counts.triangles.toLocaleString()} · 다각형 ${counts.ngons.toLocaleString()}` : '원본 면 미리보기 불러오는 중'}
      </div>}
      <div className="inspection-canvas-wrap"><div className="canvas" ref={host} />
      {!previewId && !!onTransform && <div className="viewport-tools">
        {(
          [
            ["translate", Move],
            ["rotate", Rotate3D],
            ["scale", Maximize],
          ] as const
        ).map(([m, I]) => (
          <button
            key={m}
            title={m}
            className={mode === m ? "active" : ""}
            onClick={() => setMode(m)}
          >
            <I size={17} />
          </button>
        ))}
        <button
          title="분리 보기"
          className={explode ? "active" : ""}
          onClick={() => setExplode(!explode)}
        >
          <Layers3 size={17} />
        </button>
      </div>}
      {!sources.some((s) => s.asset) && (
        <div className="guide-label">
          조립 가이드 <span>생성 결과가 아닙니다</span>
        </div>
      )}
      {(error || sizeError) && <div className="viewport-error">{error || sizeError}</div>}
      </div>
      <div className="viewport-bottom">
        <span>
          {previewId
            ? "드래그 회전 · 휠 확대"
            : "드래그 회전 · 휠 확대 · 더블클릭 파츠 선택"}
        </span>
        <span>Y ↑ · {calibrated ? "m" : "원본 단위 · 미터 미확인"}</span>
      </div>
      {meshList.length > 0 && <details className="mesh-inspector">
        <summary>메시·부품 검사 · {meshList.length}개 · {inspected.triangles.toLocaleString()} 삼각형</summary>
        <p>{counts ? '원본 면 선은 원본의 실제 변을 표시하며, 게임용 삼각형 선에는 면 내부의 대각선도 표시됩니다.' : '현재 GLB 삼각형 메시 기준입니다. 원본 면 선을 선택하면 원본 면 정보를 로컬에서 검사합니다.'} 기본 자세에서 측정하며, 한 메시를 임의의 신체 부위로 나누지 않습니다.</p>
        <div className="mesh-statistics" data-testid="viewport-total-stats">
          <strong>전체</strong>{counts && <span>원본 정점 {counts.vertices.toLocaleString()}</span>}<span>{counts ? 'GLB ' : ''}정점 {inspected.vertices.toLocaleString()}</span><span>삼각형 {inspected.triangles.toLocaleString()}</span>
          <span>원본 면 {(counts?.polygons ?? nativePolygonCount)?.toLocaleString() ?? "미확인"}</span><span>재질 {inspected.materials}</span>
          <span>{inspected.measurement?.size.map((value, index) => `${["X", "Y", "Z"][index]} ${formatLength(value, calibrated)}`).join(" · ")}</span>
        </div>
        {selectedMesh && <div className="mesh-statistics" data-testid="viewport-selected-stats"><strong>선택 부품</strong>
          {selectedCounts && <span>원본 정점 {selectedCounts.vertices.toLocaleString()}</span>}<span>{selectedCounts ? 'GLB ' : ''}정점 {selectedStats.vertices.toLocaleString()}</span><span>삼각형 {selectedStats.triangles.toLocaleString()}</span>
          <span>원본 면 {selectedCounts?.polygons.toLocaleString() ?? '미확인'}{selectedCounts ? ` · 사각 ${selectedCounts.quads} · 삼각 ${selectedCounts.triangles} · 다각 ${selectedCounts.ngons}` : ''}</span><span>재질 {selectedStats.materials}</span>
          <span>{selectedStats.measurement?.size.map((value, index) => `${["X", "Y", "Z"][index]} ${formatLength(value, calibrated)}`).join(" · ")}</span>
        </div>}
        <div className="mesh-list" role="list" aria-label="실제 메시 목록">{meshList.map(entry => <div role="listitem" key={entry.id}>
          <button aria-pressed={selectedMesh === entry.id} onClick={() => selectMesh(selectedMesh === entry.id ? "" : entry.id)} title={entry.sourceName}>{entry.name}</button>
          <button aria-label={`${entry.name} ${hiddenMeshes.includes(entry.id) ? "표시" : "숨기기"}`} onClick={() => setHiddenMeshes(hidden => hidden.includes(entry.id) ? hidden.filter(id => id !== entry.id) : [...hidden, entry.id])}>{hiddenMeshes.includes(entry.id) ? "표시" : "숨김"}</button>
          <button aria-label={`${entry.name} 단독 보기`} onClick={() => { selectMesh(entry.id); setHiddenMeshes(meshList.filter(item => item.id !== entry.id).map(item => item.id)); }}>단독</button>
        </div>)}</div>
        <button onClick={() => { setHiddenMeshes([]); selectMesh(""); }}>전체 복원</button>
        {!calibrated && <p>실제 미터 크기는 미확인입니다. 크기 설정에서 기준 길이를 지정하세요.</p>}
        {onMeshSelect && selectedMesh && <p>선택 메시를 보정 지시의 대상으로 전달합니다. 선 보기·숨김은 저장된 원본을 바꾸지 않습니다.</p>}
      </details>}
      {animation && clips.length > 0 && (
        <div className="playback">
          <button onClick={() => setPlaying(!playing)}>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <select
            value={clip || clips[0]}
            onChange={(e) => setClip(e.target.value)}
          >
            {clips.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <span>기본 동작 · 반복 재생</span>
        </div>
      )}
    </div>
  );
}
