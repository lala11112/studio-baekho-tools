import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProductionRun } from "../shared/production";
import type { Store } from "./store";

function hashFile(file: string) {
  const hash = createHash("sha256"),
    fd = fs.openSync(file, "r"),
    chunk = Buffer.alloc(1024 * 1024);
  try {
    let count: number;
    while ((count = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0)
      hash.update(chunk.subarray(0, count));
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

const safeId = z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/);
const artifactSchema = z.object({
  path: z.string(),
  kind: z.enum(["image", "model", "video", "report"]),
  role: z.string().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
  stageId: safeId,
});
const runSchema = z.object({
  schemaVersion: z.literal(1),
  id: safeId,
  projectId: safeId,
  projectRevision: z.number().int().nonnegative(),
  config: z.object({
    sourceId: z.string(),
    brief: z.string().max(6000),
    motions: z.array(z.string()).max(8),
    maxIterations: z.number().int().min(1).max(5),
    studioCreditLimit: z.number().int().min(0).max(100000),
    videoCreditLimit: z.number().int().min(0).max(100000),
    mode: z.literal("studio"),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
  source: z.object({
    path: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    label: z.string(),
  }),
  stages: z
    .array(
      z.object({
        id: safeId,
        kind: z.enum([
          "separate",
          "generate",
          "review",
          "uv",
          "texture",
          "assemble",
          "assembly-review",
          "final-uv",
          "final-texture",
          "rig",
          "view-reference",
          "animation-reference",
          "motion-transfer",
          "unity",
        ]),
        title: z.string(),
        role: z.string().optional(),
        motion: z.string().optional(),
        dependsOn: z.array(safeId),
        status: z.enum([
          "pending",
          "running",
          "completed",
          "needs_input",
          "invalidated",
          "cancelled",
          "failed",
        ]),
        attempt: z.number().int().nonnegative(),
        charged: z.boolean(),
        requiredChecks: z.array(z.string()),
        summary: z.string().optional(),
        artifacts: z.array(artifactSchema).max(100),
      }),
    )
    .max(100),
});

/** Imported runs are evidence archives. Remote approvals and live host journals are never recreated from an editable backup. */
export function restoreProductionArchives(
  store: Store,
  projectId: string,
  backupFolder: string,
) {
  const folder = path.join(backupFolder, "production");
  if (!fs.existsSync(folder)) return;
  const backupRoot = fs.realpathSync(backupFolder);
  const realFolder = fs.realpathSync(folder);
  if (!realFolder.startsWith(backupRoot + path.sep))
    throw Error("자동 제작 백업 경로가 프로젝트 밖입니다.");
  const imports: {
    run: ProductionRun;
    files: { relative: string; source: string; sha256: string }[];
  }[] = [];
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    safeId.parse(entry.name);
    const sourceRoot = fs.realpathSync(path.join(folder, entry.name));
    if (!sourceRoot.startsWith(realFolder + path.sep))
      throw Error("잘못된 제작 백업 폴더");
    const resolve = (relative: string) => {
      const file = path.resolve(sourceRoot, relative);
      if (
        path.isAbsolute(relative) ||
        !file.startsWith(sourceRoot + path.sep) ||
        !fs.realpathSync(file).startsWith(sourceRoot + path.sep)
      )
        throw Error("백업 파일 경로 이탈");
      if (
        !/\.(json|md|txt|html|png|jpe?g|webp|glb|fbx|blend|mp4|mov|webm)$/i.test(
          file,
        ) ||
        !fs.statSync(file).isFile() ||
        fs.statSync(file).size > 512 * 1024 * 1024
      )
        throw Error("지원하지 않는 제작 백업 파일");
      return file;
    };
    if (fs.statSync(path.join(sourceRoot, "run.json")).size > 5 * 1024 * 1024)
      throw Error("제작 기록이 너무 큽니다.");
    const saved = runSchema.parse(
      JSON.parse(fs.readFileSync(resolve("run.json"), "utf8")),
    );
    if (
      saved.id !== entry.name ||
      saved.projectId !== projectId ||
      store.get("production", saved.id)
    )
      throw Error("제작 백업 ID 불일치 또는 중복");
    const files = new Map<string, { source: string; sha256: string }>();
    for (const item of [
      saved.source,
      ...saved.stages.flatMap((stage) => stage.artifacts),
    ]) {
      const source = resolve(item.path);
      if (hashFile(source) !== item.sha256)
        throw Error("제작 백업 산출물 해시 불일치");
      files.set(item.path, { source, sha256: item.sha256 });
    }
    const run: ProductionRun = {
      ...saved,
      workspace: store.file(projectId, `production/${saved.id}`),
      status: "cancelled",
      message:
        "백업에서 보관용으로 복원했습니다. 원격 실행 승인은 복원하지 않습니다. 산출물을 확인하고 새 제작 계획을 준비하세요.",
      stages: saved.stages.map((stage) => ({
        ...stage,
        status: stage.status === "completed" ? "completed" : "cancelled",
      })),
    };
    imports.push({
      run,
      files: [...files].map(([relative, file]) => ({ relative, ...file })),
    });
  }
  for (const { run, files } of imports) {
    for (const file of files) {
      const destination = store.file(
        projectId,
        `production/${run.id}/${file.relative}`,
      );
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(file.source, destination + ".tmp");
      if (hashFile(destination + ".tmp") !== file.sha256)
        throw Error("복사 중 백업 산출물이 변경됐습니다.");
      fs.renameSync(destination + ".tmp", destination);
    }
    store.write(
      projectId,
      `production/${run.id}/run.json`,
      JSON.stringify(run, null, 2),
    );
    store.put("production", run.id, run);
  }
}
