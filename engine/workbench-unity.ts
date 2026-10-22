import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type {
  WorkbenchExecutionContext,
  WorkbenchResult,
} from "../shared/workbench";

const hash = (p: string) =>
  createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const write = (p: string, v: unknown) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + ".tmp", JSON.stringify(v, null, 2));
  fs.renameSync(p + ".tmp", p);
};
const read = (p: string) =>
  JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
const blocked = (summary: string): WorkbenchResult => ({
  status: "needs_input",
  summary,
  candidates: [],
  checks: [],
  recovery: { kind: "blocked", reason: summary },
});
type Services = {
  projectRoot: string;
  unityPath: string;
  editor: string;
  blender: string;
  resources: string;
  checkpoint: string;
  runBlender: (
    exe: string,
    args: string[],
    signal: AbortSignal,
  ) => Promise<void>;
  waitMs?: number;
  onQueued?: (q: any) => void;
};

export function validateUnityPlayback(report: any, request: any) {
  if (
    report.requestId !== request.requestId ||
    report.rigType !== request.rigType ||
    report.revision !== request.revision ||
    !report.avatarValid ||
    (request.rigType === "humanoid" && !report.avatarHuman) ||
    !Array.isArray(report.errors) ||
    report.errors.length ||
    report.runtimePlayModeVerified !== true
  )
    throw Error(
      "Unity의 실제 리그·Play Mode 재생 확인이 아직 완료되지 않았습니다.",
    );
  if (report.clips?.length !== request.expectedClips.length)
    throw Error("Unity 클립 개수가 채택한 목록과 다릅니다.");
  for (const clip of request.expectedClips) {
    if (Boolean(report.loopClips?.includes(clip.name)) !== Boolean(clip.loop))
      throw Error(`Unity 반복 설정이 다릅니다: ${clip.name}`);
    if (
      !report.clips?.includes(clip.name) ||
      !report.runtimeClips?.includes(clip.name) ||
      !report.runtimeMovingClips?.includes(clip.name)
    )
      throw Error(
        `Unity에서 실제 뼈 움직임을 확인하지 못한 클립: ${clip.name}`,
      );
  }
}

/** Local export/import/polling only. No Codex worker, paid service or authored motion. */
export async function executeWorkbenchUnity(
  ctx: WorkbenchExecutionContext,
  s: Services,
  progress: (m: string) => void,
): Promise<WorkbenchResult> {
  const { workspace, signal } = ctx;
  signal.throwIfAborted();
  if (
    !s.unityPath ||
    !fs.existsSync(path.join(s.unityPath, "ProjectSettings/ProjectVersion.txt"))
  )
    return blocked(
      "연결 설정에서 실제 Unity 프로젝트를 지정하세요. 기존 결과는 보존됩니다.",
    );
  const root = fs.realpathSync(s.projectRoot),
    inputs = ctx.inputs.map((a) => {
      const file = path.resolve(root, a.path);
      if (
        !file.startsWith(root + path.sep) ||
        !fs.realpathSync(file).startsWith(root + path.sep) ||
        hash(file) !== a.sha256
      )
        throw Error("채택한 Unity 입력의 경로 또는 원본이 변경됐습니다.");
      return { ...a, file };
    });
  const selected = (slot: string) => {
    const ref = ctx.job.dependencies[slot];
    const j = ctx.workbench.jobs.find((j) => j.id === ref?.jobId);
    const c = j?.candidates.find((c) => c.id === ref?.candidateId);
    const blends = c?.artifacts.filter((a) => a.kind === "blend");
    if (!j || blends?.length !== 1)
      throw Error(`채택한 ${slot}의 편집 가능한 blend 한 개가 필요합니다.`);
    return {
      job: j,
      file: inputs.find((i) => i.path === blends[0].path)!.file,
    };
  };
  const rig = selected("rig"),
    clips = Object.keys(ctx.job.dependencies)
      .filter((k) => k.startsWith("animation:"))
      .map((k) => {
        const c = selected(k);
        return {
          name: c.job.request.motion!,
          path: c.file,
          fps: c.job.request.fps!,
          loop: c.job.request.loop ?? false,
        };
      });
  if (
    !clips.length ||
    new Set(clips.map((c) => c.name)).size !== clips.length ||
    clips.some((c) => !c.name || c.fps !== clips[0].fps)
  )
    throw Error(
      "클립 이름과 프레임 속도를 확인하세요. 서로 다른 속도를 자동 변환하지 않습니다.",
    );
  const identity = createHash("sha256")
    .update(
      JSON.stringify({
        request: ctx.job.request,
        dependencies: ctx.job.dependencies,
        inputs: ctx.inputs,
      }),
    )
    .digest("hex"); // host-frozen local job request
  const rigType = ctx.job.request.unityRigType ?? "generic";
  let checkpoint: any = fs.existsSync(s.checkpoint)
    ? read(s.checkpoint)
    : undefined;
  if (
    checkpoint &&
    (checkpoint.jobId !== ctx.job.id ||
      checkpoint.identity !== identity ||
      checkpoint.unityPath !== s.unityPath)
  )
    throw Error("Unity 작업 기록이 현재 입력과 다릅니다.");
  const out = path.join(workspace, "unity-export");
  if (!checkpoint) {
    progress("앱에서 채택한 리그와 모든 클립을 내보냅니다 · GPT 호출 없음");
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ps-unity-"));
    try {
      fs.copyFileSync(rig.file, path.join(temp, "rig.blend"));
      const shortClips = clips.map((c, i) => {
        const file = path.join(temp, `clip-${i}.blend`);
        fs.copyFileSync(c.path, file);
        return { ...c, path: file };
      });
      const spec = path.join(temp, "request.json");
      write(spec, {
        rig: path.join(temp, "rig.blend"),
        clips: shortClips,
        fps: clips[0].fps,
      });
      await s.runBlender(
        s.blender,
        [
          "--background",
          "--factory-startup",
          "--disable-autoexec",
          "--python-exit-code",
          "1",
          "--python",
          path.join(s.resources, "blender/unity_export.py"),
          "--",
          spec,
        ],
        signal,
      );
      signal.throwIfAborted();
      fs.cpSync(path.join(temp, "export"), out, { recursive: true });
    } finally {
      if (path.dirname(fs.realpathSync(temp)) !== fs.realpathSync(os.tmpdir()))
        throw Error("임시 경로가 잘못됐습니다.");
      fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
    }
    const inventory = (dir: string): string[] =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((e) =>
          e.isDirectory()
            ? inventory(path.join(dir, e.name))
            : [path.join(dir, e.name)],
        );
    checkpoint = {
      jobId: ctx.job.id,
      identity,
      unityPath: s.unityPath,
      files: inventory(out).map((file) => ({
        path: path.relative(workspace, file),
        sha256: hash(file),
      })),
      queued: false,
    };
    write(s.checkpoint, checkpoint);
  }
  for (const a of inputs)
    if (hash(a.file) !== a.sha256)
      throw Error("내보내기 중 채택한 원본이 변경됐습니다.");
  for (const f of checkpoint.files) {
    const file = path.resolve(workspace, f.path);
    if (
      !file.startsWith(path.resolve(workspace) + path.sep) ||
      !fs
        .realpathSync(file)
        .startsWith(fs.realpathSync(workspace) + path.sep) ||
      hash(file) !== f.sha256
    )
      throw Error("저장된 Unity 내보내기 파일이 변경됐습니다.");
  }
  const bridge = path.join(s.unityPath, "Assets/PartsmithBridge/Editor");
  fs.mkdirSync(bridge, { recursive: true });
  for (const name of ["PartsmithBridge.cs", "PartsmithPlayModeCheck.cs"]) {
    const dest = path.join(bridge, name),
      content = fs.readFileSync(path.join(s.resources, "unity/Editor", name));
    if (
      fs.existsSync(dest) &&
      !fs.readFileSync(dest, "utf8").includes("PARTSMITH MANAGED BRIDGE")
    )
      throw Error("동일 이름의 사용자 Unity 스크립트는 덮어쓰지 않습니다.");
    if (!fs.existsSync(dest) || !fs.readFileSync(dest).equals(content))
      fs.writeFileSync(dest, content);
  }
  const resultPath = path.join(
      s.unityPath,
      "Library/PartsmithResults",
      ctx.job.id + ".json",
    ),
    inbox = path.join(
      s.unityPath,
      "Library/PartsmithInbox",
      ctx.job.id + ".json",
    );
  const request = {
    schemaVersion: 2,
    requestId: ctx.job.id,
    projectId: ctx.workbench.projectId,
    revision: 0,
    source: path.join(out, "character.fbx"),
    textureDirectory: path.join(out, "textures"),
    destination: `Assets/PartsmithWorkbench/${ctx.job.id}/${ctx.workbench.projectId}`,
    resultPath,
    rigType,
    humanoid: rigType === "humanoid",
    expectedClips: clips.map((c) => ({ name: c.name, loop: c.loop })),
  };
  const cancel = () => {
    for (const file of [
      inbox,
      path.join(s.unityPath, "Library/PartsmithResults/verify-play.json"),
    ]) {
      if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, "utf8");
        if (
          file === inbox
            ? read(file).requestId === ctx.job.id
            : text.trim() === resultPath
        )
          fs.unlinkSync(file);
      }
    }
    checkpoint.cancelled = true;
    write(s.checkpoint, checkpoint);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (checkpoint.cancelled && !fs.existsSync(resultPath))
      return blocked(
        "취소된 Unity 요청입니다. 저장된 내보내기는 보존하며 자동 재시작하지 않습니다.",
      );
    if (!checkpoint.queued) {
      signal.throwIfAborted();
      if (
        fs.existsSync(inbox) ||
        fs.existsSync(inbox + ".processed") ||
        fs.existsSync(resultPath)
      )
        throw Error("기존 Unity 요청이 있습니다. 중복 전송하지 않습니다.");
      write(inbox, request);
      checkpoint.queued = true;
      write(s.checkpoint, checkpoint);
      s.onQueued?.(request);
    } else if (
      !fs.existsSync(inbox) &&
      !fs.existsSync(inbox + ".processed") &&
      !fs.existsSync(resultPath)
    )
      return blocked(
        "기존 Unity 요청 파일이 사라졌습니다. 자동 재전송하지 않습니다.",
      );
    if (
      !fs.existsSync(path.join(s.unityPath, "Temp/UnityLockfile")) &&
      !s.onQueued &&
      !fs.existsSync(resultPath)
    ) {
      if (!s.editor || !fs.existsSync(s.editor))
        return blocked(
          "Unity 요청은 보존됐습니다. 연결 설정에서 Unity 실행 파일을 지정한 뒤 기존 작업을 이어서 확인하세요.",
        );
      const child = spawn(s.editor, ["-projectPath", s.unityPath], {
        windowsHide: true,
        detached: true,
        stdio: "ignore",
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    }
    progress(
      "Unity에서 가져오기·실제 Play Mode 재생을 확인합니다 · GPT 호출 없음",
    );
    let dirtyRetryAt = 0;
    if (
      fs.existsSync(resultPath) &&
      read(resultPath).warnings?.some((w: string) =>
        w.includes("unsaved changes"),
      )
    ) {
      const trigger = path.join(
        s.unityPath,
        "Library/PartsmithResults/verify-play.json",
      );
      if (!fs.existsSync(trigger)) {
        fs.writeFileSync(trigger, resultPath);
        dirtyRetryAt = Date.now() + 4000;
      }
    }
    const end = Date.now() + (s.waitMs ?? 180000);
    do {
      signal.throwIfAborted();
      if (fs.existsSync(resultPath)) {
        const report = read(resultPath);
        if (report.requestId !== request.requestId)
          return blocked("Unity 결과의 작업 ID가 일치하지 않습니다.");
        if (report.errors?.length)
          return blocked("Unity 가져오기 실패: " + report.errors.join(" · "));
        if (
          report.runtimePlayModeVerified &&
          fs.existsSync(
            path.join(
              s.unityPath,
              "Library/PartsmithResults",
              ctx.job.id + ".png",
            ),
          )
        ) {
          validateUnityPlayback(report, request);
          const reportOut = path.join(out, "unity-result.json");
          write(reportOut, report);
          const paths = checkpoint.files.map((f: any) => f.path),
            artifacts = paths.map((p: string) => ({
              path: p.replaceAll("\\", "/"),
              kind: (p.endsWith(".blend")
                ? "blend"
                : /\.(png|jpg|jpeg)$/i.test(p)
                  ? "image"
                  : p.endsWith(".json")
                    ? "report"
                    : "export") as any,
            }));
          artifacts.push({
            path: path.relative(workspace, reportOut).replaceAll("\\", "/"),
            kind: "report",
          });
          const screenshot = path.join(
            s.unityPath,
            "Library/PartsmithResults",
            ctx.job.id + ".png",
          );
          if (fs.existsSync(screenshot)) {
            fs.copyFileSync(screenshot, path.join(out, "unity-play.png"));
            artifacts.push({
              path: "unity-export/unity-play.png",
              kind: "image",
            });
          }
          return {
            status: "completed",
            summary: `Unity ${rigType} 실제 재생 확인 · ${clips.map((c) => c.name).join(", ")}. 변형·접지·재질은 검토 화면에서 최종 확인하세요.`,
            candidates: [
              { id: "unity-export", label: "Unity 재생 검토", artifacts },
            ],
            checks: [
              {
                name: "unity_actual_playback",
                passed: true,
                detail: "Unity가 보고한 모든 채택 클립의 실제 뼈 움직임 확인.",
              },
              {
                name: "unity_visual_review",
                passed: false,
                severity: "warning",
                detail:
                  "재질·관통·발 접지는 실제 재생 화면의 최종 사용자 검토가 필요합니다.",
              },
            ],
          };
        }
        if (
          Date.now() > dirtyRetryAt &&
          report.warnings?.some((w: string) => w.includes("unsaved changes"))
        )
          return blocked(
            "Unity에 저장하지 않은 씬이 있어 재생 검사를 기다립니다. 씬을 저장한 뒤 앱에서 기존 작업을 이어서 확인하세요.",
          );
      }
      await new Promise((r) => setTimeout(r, 250));
    } while (Date.now() < end);
    return blocked(
      "Unity 처리 대기 중입니다. 실행 중인 프로젝트와 오류를 확인한 뒤 앱에서 기존 작업을 이어서 확인하세요. 내보낸 파일·요청은 재사용합니다.",
    );
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
