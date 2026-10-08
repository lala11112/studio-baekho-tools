import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Store, uid } from "./store";
import type { BuildResult, Project, UnityResult } from "../shared/types";
export function runProcess(
  exe: string,
  args: string[],
  timeout = 600000,
): Promise<string> {
  if (!fs.existsSync(exe) || path.extname(exe).toLowerCase() !== ".exe")
    throw new Error("설정의 실행 파일 경로를 확인하세요.");
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { windowsHide: true, shell: false });
    let output = "";
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error("로컬 처리 시간 초과"));
    }, timeout);
    p.stdout.on("data", (d) => {
      output = (output + d.toString()).slice(-30000);
    });
    p.stderr.on("data", (d) => {
      output = (output + d.toString()).slice(-30000);
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(output)
        : reject(new Error(`처리 실패 (${code}): ${output.slice(-2500)}`));
    });
  });
}
export class LocalPipeline {
  private busy = new Set<string>();
  constructor(
    private store: Store,
    private resources: string,
  ) {}
  async probe() {
    const s = this.store.settings;
    const read = (f: string) =>
      fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
    return {
      blenderExists: fs.existsSync(s.blenderPath),
      blenderVersion: fs.existsSync(s.blenderPath)
        ? (await runProcess(s.blenderPath, ["--version"], 30000)).split("\n")[0]
        : "없음",
      unityEditorExists: fs.existsSync(s.unityEditorPath),
      unityVersion: read(
        path.join(s.unityPath, "ProjectSettings/ProjectVersion.txt"),
      ),
      urp: (() => {
        try {
          return (
            JSON.parse(read(path.join(s.unityPath, "Packages/manifest.json")))
              .dependencies?.["com.unity.render-pipelines.universal"] ??
            "미확인"
          );
        } catch {
          return "미확인";
        }
      })(),
    };
  }
  async build(
    id: string,
    mode: "assemble" | "demo-rig" | "convert",
    assetId?: string,
  ) {
    if (this.busy.has(id))
      throw new Error("이 프로젝트를 Blender에서 처리 중입니다.");
    const p = this.store.project(id);
    if (mode === "demo-rig" && !p.demo)
      throw new Error(
        "샘플 리깅은 데모 프로젝트에서만 실행할 수 있습니다. 실제 캐릭터는 Tripo 또는 Blender에서 보정하세요.",
      );
    const parts = p.parts
      .filter((x) => x.visible)
      .map((x) => ({
        ...x,
        file: this.store.file(
          id,
          p.assets.find((a) => a.id === x.selectedId)?.file ?? "missing.glb",
        ),
      }));
    if (mode === "assemble" && parts.some((x) => !fs.existsSync(x.file)))
      throw new Error("표시 중인 모든 파츠의 모델을 선택하세요.");
    const selected = p.assets.find((x) => x.id === assetId);
    if (mode === "convert" && (!selected || selected.kind !== "model"))
      throw new Error("변환할 모델을 선택하세요.");
    const buildId = uid();
    const out = this.store.file(id, `builds/${buildId}/character`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const manifest = {
      schemaVersion: 1,
      projectId: id,
      mode,
      height: p.height,
      parts,
      source: selected ? this.store.file(id, selected.file) : undefined,
      output: out,
    };
    const input = this.store.write(
      id,
      `builds/${buildId}/input.json`,
      JSON.stringify(manifest),
    );
    this.busy.add(id);
    try {
      const log = await runProcess(this.store.settings.blenderPath, [
        "--background",
        "--factory-startup",
        "--python",
        path.join(this.resources, "blender/pipeline.py"),
        "--",
        input,
      ]);
      this.store.write(id, `builds/${buildId}/blender.log`, log);
      const report = JSON.parse(fs.readFileSync(out + ".report.json", "utf8"));
      const result: BuildResult = {
        id: buildId,
        revision: p.revision,
        mode,
        glb: `builds/${buildId}/character.glb`,
        fbx: `builds/${buildId}/character.fbx`,
        blend: `builds/${buildId}/character.blend`,
        report: `builds/${buildId}/character.report.json`,
        warnings: report.warnings,
        hasRig: report.hasRig,
        clips: report.clips,
      };
      const current = this.store.project(id);
      current.builds.push(result);
      current.assets.push({
        id: buildId,
        file: result.glb,
        kind: "model",
        label:
          mode === "demo-rig"
            ? "데모 · 리깅된 마네킹"
            : mode === "convert"
              ? "변환한 캐릭터"
              : "조립된 캐릭터",
        origin: mode === "demo-rig" ? "demo" : "blender",
        createdAt: new Date().toISOString(),
        parentId: assetId,
      });
      this.store.save(current);
      return result;
    } finally {
      this.busy.delete(id);
    }
  }
  validateUnity(p: Project) {
    if (
      !fs.existsSync(
        path.join(p.unityPath, "ProjectSettings/ProjectVersion.txt"),
      )
    )
      throw new Error("Unity 프로젝트 폴더가 아닙니다.");
    if (
      !/^[A-Za-z][A-Za-z0-9_/-]*$/.test(p.unityFolder) ||
      p.unityFolder.includes("..")
    )
      throw new Error("Assets 하위 출력 폴더는 영문·숫자·밑줄을 사용하세요.");
  }
  install(id: string) {
    const p = this.store.project(id);
    this.validateUnity(p);
    const src = path.join(this.resources, "unity/Editor");
    const dest = path.join(p.unityPath, "Assets/PartsmithBridge/Editor");
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (name.endsWith(".cs")) {
        const target = path.join(dest, name);
        if (
          fs.existsSync(target) &&
          !fs.readFileSync(target, "utf8").includes("PARTSMITH MANAGED BRIDGE")
        )
          throw new Error(
            "기존 사용자 파일이 있어 덮어쓰지 않습니다: " + target,
          );
        const content = fs.readFileSync(path.join(src, name));
        if (!fs.existsSync(target) || !fs.readFileSync(target).equals(content))
          fs.writeFileSync(target, content);
      }
    }
    return {
      path: dest,
      message: "Editor 브리지 설치 완료. Unity의 스크립트 컴파일이 필요합니다.",
    };
  }
  importUnity(id: string, buildId: string) {
    const p = this.store.project(id);
    this.validateUnity(p);
    const b = p.builds.find((x) => x.id === buildId);
    if (!b) throw new Error("Blender 출력이 없습니다.");
    if (b.revision !== p.revision)
      throw new Error("파츠가 바뀌었습니다. Blender 출력을 다시 만드세요.");
    this.install(id);
    const requestId = uid();
    const resultPath = path.join(
      p.unityPath,
      "Library/PartsmithResults",
      requestId + ".json",
    );
    const inbox = path.join(p.unityPath, "Library/PartsmithInbox");
    fs.mkdirSync(inbox, { recursive: true });
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    const manifest = {
      schemaVersion: 1,
      projectId: p.id,
      requestId,
      source: this.store.file(id, b.fbx),
      textureDirectory: path.join(
        path.dirname(this.store.file(id, b.fbx)),
        "textures",
      ),
      destination: `Assets/${p.unityFolder}/${p.id}`,
      revision: p.revision,
      resultPath,
      humanoid: b.hasRig,
    };
    const file = path.join(inbox, requestId + ".json");
    fs.writeFileSync(file + ".tmp", JSON.stringify(manifest));
    fs.renameSync(file + ".tmp", file);
    this.store.put("unity-request", id, {
      requestId,
      resultPath,
      revision: p.revision,
    });
    return {
      requestId,
      status: "queued",
      message:
        "Unity Editor가 요청을 처리하면 결과가 표시됩니다. 프로젝트가 닫혀 있으면 열어주세요.",
    };
  }
  result(id: string) {
    const request = this.store.get<{
      requestId: string;
      resultPath: string;
      revision: number;
    }>("unity-request", id);
    if (!request) return undefined;
    if (!fs.existsSync(request.resultPath))
      return { status: "queued", requestId: request.requestId };
    const r = JSON.parse(
      fs.readFileSync(request.resultPath, "utf8"),
    ) as UnityResult;
    r.revision = request.revision;
    const p = this.store.project(id);
    p.unity = r;
    this.store.save(p);
    return r;
  }
}
