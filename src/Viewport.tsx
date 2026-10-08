import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
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
};
export function Viewport({
  project,
  selectedPart,
  previewId,
  onSelect,
  onTransform,
  animation,
}: Props) {
  const host = useRef<HTMLDivElement>(null),
    api = useRef<any>(null);
  const [error, setError] = useState(""),
    [clips, setClips] = useState<string[]>([]),
    [clip, setClip] = useState(""),
    [playing, setPlaying] = useState(true),
    [explode, setExplode] = useState(false),
    [mode, setMode] = useState<"translate" | "rotate" | "scale">("translate");
  const callbacks = useRef({ onSelect, onTransform });
  callbacks.current = { onSelect, onTransform };
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
    const scene = new THREE.Scene();
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
    const loader = new GLTFLoader();
    setError("");
    setClips([]);
    const allClips: string[] = [];
    for (const [i, s] of sources.entries()) {
      if (!s.asset) continue;
      loader.load(
        window.desktop.assetUrl(project.id, s.asset.file),
        (gltf) => {
          if (dead) {
            gltf.scene.traverse((o: any) => {
              o.geometry?.dispose();
            });
            return;
          }
          const group = new THREE.Group();
          group.userData.partId = s.id;
          group.add(gltf.scene);
          scene.add(group);
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
        },
        undefined,
        () =>
          setError(
            "모델을 읽지 못했습니다. 자체 포함 GLB와 압축 형식을 확인하세요.",
          ),
      );
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
      if (controls.dragging || previewId) return;
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(
        new THREE.Vector2(
          ((event.clientX - r.left) / r.width) * 2 - 1,
          (-(event.clientY - r.top) / r.height) * 2 + 1,
        ),
        camera,
      );
      const hits = ray.intersectObjects([...objects.values()], true);
      if (hits[0]) callbacks.current.onSelect?.(hits[0].object.userData.partId);
    };
    renderer.domElement.addEventListener("dblclick", down);
    const resize = new ResizeObserver(() => {
      if (!host.current) return;
      const { clientWidth: w, clientHeight: h } = host.current;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    resize.observe(host.current);
    const clock = new THREE.Clock();
    api.current = { camera, orbit, controls, actions, mixers, objects, scene };
    controls.setMode(mode);
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const dt = clock.getDelta();
      if (api.current?.playing !== false) mixers.forEach((m) => m.update(dt));
      orbit.update();
      renderer.render(scene, camera);
    };
    tick();
    return () => {
      dead = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      orbit.dispose();
      controls.dispose();
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
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [signature, project.id, selectedPart, previewId, explode, animation]);
  useEffect(() => {
    if (api.current) api.current.playing = playing;
  }, [playing]);
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
    api.current?.camera.position.set(x, y, z);
    api.current?.orbit.target.set(0, 0.85, 0);
    api.current?.orbit.update();
  }
  return (
    <div className="viewport">
      <div className="canvas" ref={host} />
      <div className="viewport-top">
        <span className="viewport-label">
          <span className="status-dot" />{" "}
          {previewId ? "모델 검수" : "조립 미리보기"}{" "}
          <small> PERSPECTIVE</small>
        </span>
        <div className="segmented">
          <button onClick={() => view(0, 1, 4.6)}>정면</button>
          <button onClick={() => view(4.6, 1, 0)}>측면</button>
          <button onClick={() => view(0, 1, -4.6)}>후면</button>
          <button title="시점 초기화" onClick={() => view(3, 2.2, 4.7)}>
            <RotateCcw size={14} />
          </button>
        </div>
      </div>
      <div className="viewport-tools">
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
      </div>
      {!sources.some((s) => s.asset) && (
        <div className="guide-label">
          조립 가이드 <span>생성 결과가 아닙니다</span>
        </div>
      )}
      {error && <div className="viewport-error">{error}</div>}
      <div className="viewport-bottom">
        <span>드래그 회전 · 휠 확대 · 더블클릭 파츠 선택</span>
        <span>Y ↑ · m</span>
      </div>
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
