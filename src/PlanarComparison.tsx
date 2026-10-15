import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { AssetVersion } from "../shared/graphics";
import { frameModelBounds, loadedModelBounds } from "./viewport-framing";
import {
  headComparisonScene,
  headComparisonViewportSize,
  renderHeadComparison,
} from "./head-comparison";
import "./head-comparison.css";

type Props = {
  projectId: string;
  baseline: AssetVersion;
  candidate: AssetVersion;
  choices: AssetVersion[];
  acceptedId?: string;
  onBaseline: (id: string) => void;
  onClose: () => void;
  focusBoundaries?: { id: string; number: number; points: number[][] }[];
};
type DisplayMesh = {
  mesh: THREE.Mesh;
  original: THREE.Material | THREE.Material[];
  solid: THREE.Material | THREE.Material[];
};

function disposeModel(root: THREE.Object3D) {
  const materials = new Set<THREE.Material>(),
    geometries = new Set<THREE.BufferGeometry>(),
    textures = new Set<THREE.Texture>();
  root.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      geometries.add(node.geometry);
      for (const material of Array.isArray(node.material)
        ? node.material
        : [node.material])
        materials.add(material);
    }
  });
  for (const material of materials) {
    for (const value of Object.values(material))
      if (value instanceof THREE.Texture) textures.add(value);
    material.dispose();
  }
  for (const geometry of geometries) geometry.dispose();
  for (const texture of textures) texture.dispose();
}

export function PlanarComparison({
  projectId,
  baseline,
  candidate,
  choices,
  acceptedId,
  onBaseline,
  onClose,
  focusBoundaries = [],
}: Props) {
  const host = useRef<HTMLDivElement>(null),
    api = useRef<{
      fit: (direction: THREE.Vector3) => void;
      appearance: (solid: boolean) => void;
      focus: (points?: number[][]) => void;
    } | null>(null);
  const [solid, setSolid] = useState(false),
    solidRef = useRef(solid);
  solidRef.current = solid;
  const [ready, setReady] = useState(false),
    [error, setError] = useState("");
  const [display, setDisplay] = useState<{ height: number; scale: number }[]>(
    [],
  );
  const [reviewed, setReviewed] = useState<Record<string, boolean>>({});
  const baselineFile = baseline.files.find((file) =>
    /\.glb$/i.test(file.path),
  )?.path;
  const candidateFile = candidate.files.find((file) =>
    /\.glb$/i.test(file.path),
  )?.path;
  useEffect(() => setReviewed({}), [baseline.id, candidate.id]);
  useEffect(() => {
    if (!host.current) return;
    setReady(false);
    setError("");
    setDisplay([]);
    if (!baselineFile || !candidateFile) {
      setError("두 모델 모두 GLB 미리보기가 있어야 비교할 수 있습니다.");
      return;
    }
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setError(
        "3D 가속을 사용할 수 없어 같은 시점 비교를 표시하지 못했습니다.",
      );
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.85;
    const room = new RoomEnvironment(),
      pmrem = new THREE.PMREMGenerator(renderer),
      environment = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    const scenes: [THREE.Scene, THREE.Scene] = [
      headComparisonScene(environment.texture),
      headComparisonScene(environment.texture),
    ];
    const camera = new THREE.PerspectiveCamera(35, 1, 0.001, 100);
    camera.position.set(0, 0, 3);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    const element = host.current;
    element.appendChild(renderer.domElement);
    let dead = false,
      frame = 0,
      width = 0,
      height = 0;
    const models: THREE.Object3D[] = [],
      meshes: DisplayMesh[] = [],
      commonBounds = new THREE.Box3();
    let focusedBounds: THREE.Box3 | undefined;
    const appearance = (useSolid: boolean) => {
      for (const item of meshes)
        item.mesh.material = useSolid ? item.solid : item.original;
    };
    const fit = (direction: THREE.Vector3) => {
      const view = headComparisonViewportSize(width, height);
      if (!view) return;
      camera.aspect = view.aspect;
      const framed = frameModelBounds(
        camera,
        focusedBounds ?? commonBounds,
        direction,
        focusedBounds ? 1.8 : 1.2,
      );
      if (framed) {
        orbit.target.copy(framed.center);
        orbit.minDistance = framed.minDistance;
        orbit.maxDistance = framed.maxDistance;
        orbit.update();
      }
    };
    const resize = () => {
      width = Math.floor(element.clientWidth);
      height = Math.floor(element.clientHeight);
      if (width < 3 || height < 1) return;
      renderer.setSize(width, height);
      fit(camera.position.clone().sub(orbit.target));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    api.current = {
      fit,
      appearance,
      focus: (points) => {
        focusedBounds = points?.length
          ? new THREE.Box3().setFromPoints(
              points.map(
                (point) => new THREE.Vector3(point[0], point[1], point[2]),
              ),
            )
          : undefined;
        fit(camera.position.clone().sub(orbit.target));
      },
    };
    const loader = new GLTFLoader();
    void Promise.all(
      [baselineFile, candidateFile].map(async (file, index) => {
        const gltf = await loader.loadAsync(
          window.desktop.assetUrl(projectId, file),
        );
        if (dead) {
          disposeModel(gltf.scene);
          return undefined;
        }
        const root = gltf.scene;
        models.push(root);
        const transform = {
          scale: 1,
          translation: new THREE.Vector3(),
          height: loadedModelBounds([root]).getSize(new THREE.Vector3()).y,
        };
        const parent = new THREE.Group();
        parent.scale.setScalar(transform.scale);
        parent.position.copy(transform.translation);
        parent.add(root);
        scenes[index].add(parent);
        root.traverse((node) => {
          // Imported lights must not change the shared comparison lighting.
          if (node instanceof THREE.Light) node.visible = false;
          if (!(node instanceof THREE.Mesh)) return;
          const originals = Array.isArray(node.material)
            ? node.material
            : [node.material];
          const neutral = originals.map(
            (material) =>
              new THREE.MeshStandardMaterial({
                color: "#c8d0cf",
                roughness: 0.75,
                metalness: 0,
                side: material.side,
              }),
          );
          meshes.push({
            mesh: node,
            original: node.material,
            solid: Array.isArray(node.material) ? neutral : neutral[0],
          });
        });
        commonBounds.union(loadedModelBounds([root]));
        return { height: transform.height, scale: transform.scale };
      }),
    )
      .then((values) => {
        if (dead || values.some((value) => !value)) return;
        appearance(solidRef.current);
        fit(new THREE.Vector3(1, 0, 0));
        setDisplay(values as { height: number; scale: number }[]);
        setReady(true);
      })
      .catch((cause) => {
        if (!dead)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    const tick = () => {
      if (dead) return;
      orbit.update();
      renderHeadComparison(renderer, scenes, camera, width, height);
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      dead = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      orbit.dispose();
      api.current = null;
      for (const item of meshes) {
        item.mesh.material = item.original;
        for (const material of Array.isArray(item.solid)
          ? item.solid
          : [item.solid])
          material.dispose();
      }
      models.forEach(disposeModel);
      environment.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [projectId, baselineFile, candidateFile]);
  useEffect(() => api.current?.appearance(solid), [solid]);
  return (
    <section
      className="gs-head-comparison"
      aria-label="모델 같은 시점 비교"
      data-testid="graphics-head-comparison"
    >
      <header>
        <strong>복구 전후 나란히 비교</strong>
        <button onClick={onClose}>단일 보기로 돌아가기</button>
      </header>
      <p className="gs-fine">
        복구 전후의 원래 크기와 위치를 그대로 표시합니다. 같은
        카메라·조명·배율로 회전과 확대가 함께 움직입니다.
      </p>
      <div className="head-comparison-columns">
        <label>
          복구 전 원본
          <select
            aria-label="모델 비교 기준 버전"
            value={baseline.id}
            disabled
            onChange={(event) => onBaseline(event.target.value)}
          >
            {choices
              .filter((version) => version.id !== candidate.id)
              .map((version) => (
                <option key={version.id} value={version.id}>
                  {version.label}
                  {version.id === acceptedId ? " · 현재 채택" : ""} ·{" "}
                  {version.id.slice(0, 8)}
                </option>
              ))}
          </select>
        </label>
        <div>
          <strong>복구 후 후보</strong>
          <span>
            {candidate.label} · {candidate.id.slice(0, 8)}
          </span>
        </div>
      </div>
      <div
        className="head-comparison-controls"
        role="group"
        aria-label="함께 보는 시점과 표면"
      >
        <button disabled={!ready} onClick={() => api.current?.focus()}>
          전체 보기
        </button>
        {focusBoundaries.map((boundary) => (
          <button
            key={boundary.id}
            disabled={!ready}
            onClick={() => api.current?.focus(boundary.points)}
          >
            복구 영역 {boundary.number} 확대
          </button>
        ))}
        {(
          [
            ["+X 방향", 1, 0, 0],
            ["+Z 방향", 0, 0, 1],
            ["−Z 방향", 0, 0, -1],
            ["−X 방향", -1, 0, 0],
            ["사선", 4.7, 1.35, 3],
          ] as const
        ).map(([label, x, y, z]) => (
          <button
            key={label}
            disabled={!ready}
            onClick={() => api.current?.fit(new THREE.Vector3(x, y, z))}
          >
            {label}
          </button>
        ))}
        <button aria-pressed={solid} onClick={() => setSolid(true)}>
          단색 형태
        </button>
        <button aria-pressed={!solid} onClick={() => setSolid(false)}>
          원본 재질
        </button>
      </div>
      <div
        className="head-comparison-canvas"
        ref={host}
        data-testid="graphics-head-comparison-canvas"
        data-ready={ready}
        aria-label="두 모델의 공통 카메라 미리보기"
      />
      {!ready && !error && (
        <p role="status">
          두 모델의 표시 크기와 공통 시점을 준비하고 있습니다.
        </p>
      )}
      {error && <p role="alert">비교 미리보기를 열지 못했습니다. {error}</p>}
      <div className="head-comparison-columns">
        {[baseline, candidate].map((version, index) => (
          <div
            key={version.id}
            data-testid={`head-comparison-status-${version.id}`}
          >
            <span>
              파일 검사:{" "}
              {version.files.some((file) => file.kind === "report")
                ? "검사 기록 있음"
                : "검사 기록 미확인"}
            </span>
            <span>
              외형 검토:{" "}
              {reviewed[version.id]
                ? "이 화면에서 검토 표시함"
                : "사용자 검토 대기"}
            </span>
            <span>
              채택: {version.id === acceptedId ? "현재 채택 버전" : "미채택"}
            </span>
            {display[index] && (
              <small>
                비교 표시 배율 ×{Number(display[index].scale.toPrecision(5))} ·
                원래 크기 유지
              </small>
            )}
            <label>
              <input
                type="checkbox"
                checked={!!reviewed[version.id]}
                onChange={(event) =>
                  setReviewed((current) => ({
                    ...current,
                    [version.id]: event.target.checked,
                  }))
                }
              />
              {index === 0 ? "기준" : "후보"} 외형 검토 표시
            </label>
          </div>
        ))}
      </div>
      <p className="gs-fine">
        파일 검사 기록과 외형의 자연스러움은 별개입니다. 검토 표시는 이 비교
        화면에만 적용되며 채택하지 않습니다. 복구한 면의 무늬, 이음새와 방향을
        여러 시점에서 직접 확인하세요. 원본 좌표와 배율을 그대로 사용합니다.
      </p>
    </section>
  );
}
