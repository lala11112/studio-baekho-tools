import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  protocol,
  shell,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { prepareSeparationImages } from "./separation-preview";
import { z } from "zod";
import { Store, uid } from "../engine/store";
import { Engine } from "../engine/engine";
import { ProductionEngine } from "../engine/production";
import { restoreProductionArchives } from "../engine/production-backup";
import { WorkbenchEngine } from "../engine/workbench";
import { CodexWorkbenchExecutor } from "../engine/workbench-executor";
import { parseJsonText, readJsonFile } from "../engine/json";
import { CodexWorker } from "../engine/codex-worker";
import { StudioBrowser } from "./studio-browser";
import { ChatGptBrowser } from "./chatgpt-browser";
import { Tripo } from "../engine/tripo";
import { LocalPipeline } from "../engine/local";
import { Vault } from "./vault";
import { catalog } from "../shared/catalog";
import type { Command, Project, Quote } from "../shared/types";
protocol.registerSchemesAsPrivileged([
  {
    scheme: "asset",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);
if (process.env.PARTSMITH_DATA)
  app.setPath("userData", path.resolve(process.env.PARTSMITH_DATA));
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
let win: BrowserWindow;
let store: Store;
let engine: Engine;
let production: ProductionEngine;
let workbench: WorkbenchEngine;
let studio: StudioBrowser;
let chatgpt: ChatGptBrowser;
let local: LocalPipeline;
let vault: Vault;
const projectCommands = new Map<string, number>();
const deletionDialogs = new Set<string>();
function commandProjectId(c: Command): string | undefined {
  if ("id" in c) return c.id;
  if (c.type === "generation.approve")
    return store.get<Quote>("quote", c.quoteId)?.projectId;
  if ("runId" in c) return production.get(c.runId).projectId;
}
function assertProjectIdle(id: string) {
  store.assertProjectAvailable(id);
  if (
    projectCommands.has(id) ||
    engine.isProjectActive(id) ||
    workbench.isProjectActive(id) ||
    production.isProjectActive(id)
  )
    throw new Error(
      "이 프로젝트의 작업이 실행 중입니다. 작업을 중지하고 종료될 때까지 기다린 뒤 삭제하세요.",
    );
}
async function dispatchTracked(c: Command) {
  const id = commandProjectId(c);
  if (!id || c.type === "project.delete") return dispatch(c);
  store.assertProjectAvailable(id);
  projectCommands.set(id, (projectCommands.get(id) ?? 0) + 1);
  try {
    return await dispatch(c);
  } finally {
    const count = (projectCommands.get(id) ?? 1) - 1;
    if (count) projectCommands.set(id, count);
    else projectCommands.delete(id);
  }
}
const finite = z.number().finite();
const vec = z.tuple([finite, finite, finite]);
const transform = z.object({
  position: vec,
  rotation: vec,
  scale: z.tuple([finite.positive(), finite.positive(), finite.positive()]),
});
const partPatch = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    role: z.enum(["body", "head", "hair", "other"]).optional(),
    prompt: z.string().max(6000).optional(),
    imageId: z.string().optional(),
    selectedId: z.string().optional(),
    locked: z.boolean().optional(),
    visible: z.boolean().optional(),
    occluded: z.boolean().optional(),
    transform: transform.optional(),
  })
  .strict();
const projectPatch = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    style: z.string().max(200).optional(),
    height: finite.min(0.1).max(10).optional(),
    unityPath: z.string().max(1024).optional(),
    unityFolder: z.string().max(150).optional(),
  })
  .strict();
async function dispatch(c: Command): Promise<unknown> {
  if (!c || typeof c.type !== "string") throw new Error("잘못된 명령");
  switch (c.type) {
    case "state":
      return {
        projects: store.projects(),
        settings: store.settings,
        key: vault.info(),
        catalog,
        dataDir: store.root,
        productionRuns: production.list(),
        workbenches: workbench.list(),
      };
    case "workbench.action":
      if (
        c.action.kind === "execute" &&
        c.action.request.executionMode !== "codex-session" &&
        ["concept", "separate"].includes(c.action.request.step) &&
        c.action.request.provider !== "tripo" &&
        (c.action.request.imageBackend ?? "chatgpt-web") === "chatgpt-web"
      ) {
        const status = await chatgpt.status();
        if (!status.ready)
          throw new Error(
            `ChatGPT 연결에서 먼저 웹 로그인을 확인하세요. ${status.reason} 아직 생성 작업을 시작하지 않았습니다.`,
          );
      }
      return workbench.action(c.id, c.action);
    case "workbench.probe":
      return workbench.probe();
    case "workbench.open":
      return shell.openPath(store.directory(c.id));
    case "workbench.recover-separation": {
      const run = production.get(c.runId);
      if (run.projectId !== c.id)
        throw new Error("현재 프로젝트의 분리 결과만 복구할 수 있습니다.");
      const stage = run.stages.find((item) => item.kind === "separate");
      if (
        !stage ||
        !Number.isSafeInteger(c.attempt) ||
        c.attempt < 1 ||
        c.attempt > stage.attempt
      )
        throw new Error("복구할 분리 시도가 없습니다.");
      const resultFile = path.join(
        run.workspace,
        `stages/${stage.id}/attempt-${c.attempt}/result.json`,
      );
      if (!fs.existsSync(resultFile))
        throw new Error(
          "해당 시도에는 완료 결과가 없습니다. 다른 시도를 선택하세요.",
        );
      const result = readJsonFile(resultFile);
      if (result.status !== "completed")
        throw new Error("완료된 분리 결과만 복구할 수 있습니다.");
      const verified = production.verifyArtifacts(
        run,
        { ...stage, attempt: c.attempt },
        result,
      );
      const session = workbench.getForProject(c.id) ?? workbench.create(c.id);
      return workbench.importSeparation(session.id, {
        sourceSha256: run.source.sha256,
        artifacts: verified
          .filter(
            (a) =>
              a.kind === "image" &&
              ["head", "hair", "body"].includes(a.role ?? ""),
          )
          .map((a) => ({
            file: path.join(run.workspace, a.path),
            role: a.role as "head" | "hair" | "body",
          })),
      });
    }
    case "production.create":
    case "production.start":
    case "production.resume":
      throw new Error(
        "이전 자동 제작은 기록으로 보관합니다. 에셋 제작실에서 단계를 선택해 실행하세요.",
      );
    case "production.pause":
      return production.pause(c.runId);
    case "production.cancel":
      return production.cancel(c.runId);
    case "production.open":
      return shell.openPath(production.get(c.runId).workspace);
    case "production.probe":
      return production.probe();
    case "studio.open":
      return studio.open(true);
    case "chatgpt.open":
      return chatgpt.open(true);
    case "chatgpt.status":
      return chatgpt.status();
    case "chatgpt.reconnect":
      return chatgpt.reconnect();
    case "studio.status":
      return studio.status();
    case "project.create":
      return engine.create(c.name, !!c.demo);
    case "project.delete": {
      if (deletionDialogs.has(c.id))
        throw new Error("이미 이 프로젝트의 삭제를 확인하고 있습니다.");
      assertProjectIdle(c.id);
      const project = store.project(c.id);
      deletionDialogs.add(c.id);
      try {
        const result = await dialog.showMessageBox(win, {
          type: "warning",
          title: "프로젝트 삭제",
          message: `“${project.name}” 프로젝트를 삭제할까요?`,
          detail:
            "프로젝트 목록과 제작 기록을 제거하고 앱에 저장된 이미지·모델·작업 파일을 Windows 휴지통으로 보냅니다.\n\n가져온 원본 파일, 내보낸 백업, Unity 프로젝트와 Tripo 웹사이트의 모델은 삭제하지 않습니다. 외부 서비스에서 진행 중인 작업을 취소하는 기능은 아닙니다.",
          buttons: ["취소", "프로젝트 삭제"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (result.response !== 1) return { deleted: false };
        assertProjectIdle(c.id);
        if (store.project(c.id).updatedAt !== project.updatedAt)
          throw new Error(
            "확인 중 프로젝트가 변경됐습니다. 내용을 확인한 뒤 다시 삭제하세요.",
          );
        await store.deleteProject(c.id, (directory) =>
          shell.trashItem(directory),
        );
        return { deleted: true };
      } finally {
        deletionDialogs.delete(c.id);
      }
    }
    case "project.update": {
      const p = store.project(c.id),
        patch = projectPatch.parse(c.patch);
      Object.assign(p, patch);
      return patch.height !== undefined ? engine.touch(p) : store.save(p);
    }
    case "project.export": {
      const p = store.project(c.id);
      const result = await dialog.showOpenDialog(win, {
        properties: ["openDirectory", "createDirectory"],
        title: "프로젝트 백업을 저장할 폴더",
      });
      if (result.canceled) return;
      const dest = path.join(result.filePaths[0], `Partsmith-${p.id}`);
      if (fs.existsSync(dest))
        throw new Error("같은 백업 폴더가 있습니다. 다른 위치를 선택하세요.");
      if (path.resolve(dest).startsWith(path.resolve(store.root) + path.sep))
        throw new Error("앱 데이터 폴더 밖을 선택하세요.");
      fs.cpSync(store.directory(p.id), dest, { recursive: true });
      return dest;
    }
    case "project.open": {
      const result = await dialog.showOpenDialog(win, {
        filters: [{ name: "Partsmith 프로젝트", extensions: ["json"] }],
        properties: ["openFile"],
      });
      if (result.canceled) return;
      const source = result.filePaths[0];
      if (fs.statSync(source).size > 10 * 1024 * 1024)
        throw new Error("프로젝트 파일이 너무 큽니다.");
      const p = parseJsonText(fs.readFileSync(source, "utf8")) as Project;
      if (
        p.schemaVersion !== 1 ||
        !Array.isArray(p.assets) ||
        !Array.isArray(p.parts) ||
        !Array.isArray(p.jobs) ||
        !Array.isArray(p.builds) ||
        !Array.isArray(p.assemblies)
      )
        throw new Error("지원하지 않는 프로젝트 형식");
      store.directory(p.id);
      projectPatch.parse({
        name: p.name,
        style: p.style,
        height: p.height,
        unityPath: p.unityPath,
        unityFolder: p.unityFolder,
      });
      for (const part of p.parts)
        partPatch.parse({ name: part.name, transform: part.transform });
      if (store.projects().some((x) => x.id === p.id))
        throw new Error(
          "이미 목록에 있는 프로젝트입니다. 목록에서 열어주세요.",
        );
      const base = path.dirname(source);
      const files = new Set(p.assets.map((a) => a.file));
      for (const asset of p.assets)
        if (asset.nativeFile) files.add(asset.nativeFile);
      for (const job of p.jobs)
        for (const file of job.nativeFiles ?? []) files.add(file);
      for (const b of p.builds) {
        files.add(b.glb);
        files.add(b.fbx);
        files.add(b.blend);
        files.add(b.report);
        const relativeTextures = path.join(path.dirname(b.fbx), "textures");
        store.file(p.id, relativeTextures);
        const textures = path.resolve(base, relativeTextures);
        if (textures.startsWith(base + path.sep) && fs.existsSync(textures))
          for (const name of fs.readdirSync(textures))
            if (/\.png$/i.test(name))
              files.add(path.join(relativeTextures, name));
      }
      for (const f of files) {
        store.file(p.id, f);
        const src = path.resolve(base, f);
        if (
          !src.startsWith(base + path.sep) ||
          !/\.(png|jpe?g|webp|glb|gltf|fbx|obj|stl|usdz|3mf|zip|blend|json)$/i.test(
            src,
          )
        )
          throw new Error("잘못된 에셋 경로");
        if (fs.existsSync(src)) {
          if (
            !fs.realpathSync(src).startsWith(fs.realpathSync(base) + path.sep)
          )
            throw new Error("백업 에셋이 프로젝트 밖 파일을 가리킵니다.");
          store.write(p.id, f, fs.readFileSync(src));
        }
      }
      for (const j of p.jobs)
        if (["submitting", "queued"].includes(j.status)) {
          j.status = "submission_unknown";
          j.message = "백업 복원 · 원격 제출 여부 확인 필요";
        }
      p.unity = undefined;
      restoreProductionArchives(store, p.id, base);
      store.save(p);
      workbench.restoreFromBackup(p.id, base);
      return p;
    }
    case "asset.import": {
      const result = await dialog.showOpenDialog(win, {
        properties: ["openFile"],
        filters: [
          {
            name: c.kind === "image" ? "이미지" : "GLB 모델",
            extensions:
              c.kind === "image" ? ["png", "jpg", "jpeg", "webp"] : ["glb"],
          },
        ],
      });
      if (result.canceled) return;
      return engine.importFile(c.id, result.filePaths[0], c.kind, c.partId);
    }
    case "image.select": {
      const p = store.project(c.id);
      if (!p.assets.some((a) => a.id === c.assetId && a.kind === "image"))
        throw new Error("이미지 없음");
      p.selectedImageId = c.assetId;
      return engine.touch(p);
    }
    case "part.add": {
      const p = store.project(c.id);
      p.parts.push(engine.part(z.string().trim().min(1).max(80).parse(c.name)));
      return engine.touch(p);
    }
    case "part.delete": {
      const p = store.project(c.id);
      if (p.parts.find((x) => x.id === c.partId)?.locked)
        throw new Error("고정을 해제하세요.");
      p.parts = p.parts.filter((x) => x.id !== c.partId);
      return engine.touch(p);
    }
    case "part.assign": {
      const p = store.project(c.id);
      const part = p.parts.find((x) => x.id === c.partId);
      const asset = p.assets.find(
        (a) =>
          a.id === c.assetId && a.kind === "model" && /\.glb$/i.test(a.file),
      );
      if (!part || !asset)
        throw new Error("파츠와 미리보기 가능한 GLB 모델을 선택하세요.");
      if (part.locked) throw new Error("파츠 고정을 해제하세요.");
      if (!part.candidates.includes(asset.id)) part.candidates.push(asset.id);
      part.selectedId = asset.id;
      return engine.touch(p);
    }
    case "part.update": {
      const p = store.project(c.id),
        part = p.parts.find((x) => x.id === c.partId);
      if (!part) throw new Error("파츠 없음");
      const patch = partPatch.parse(c.patch);
      if (
        part.locked &&
        Object.keys(patch).some((k) => !["locked", "visible"].includes(k))
      )
        throw new Error("파츠 고정을 해제하세요.");
      if (patch.selectedId && !part.candidates.includes(patch.selectedId))
        throw new Error("이 파츠의 후보가 아닙니다.");
      if (
        patch.imageId &&
        !p.assets.some((a) => a.id === patch.imageId && a.kind === "image")
      )
        throw new Error("이미지 없음");
      Object.assign(part, patch);
      return engine.touch(p);
    }
    case "part.crop": {
      const p = store.project(c.id),
        part = p.parts.find((x) => x.id === c.partId),
        a = p.assets.find((x) => x.id === c.sourceId && x.kind === "image");
      if (!a || !part || part.locked)
        throw new Error("입력 이미지·파츠·잠금 상태를 확인하세요.");
      const image = nativeImage.createFromPath(store.file(c.id, a.file));
      const size = image.getSize();
      const r = z
        .object({
          x: finite.min(0),
          y: finite.min(0),
          width: finite.positive(),
          height: finite.positive(),
        })
        .parse(c.rect);
      const rect = {
        x: Math.floor(r.x),
        y: Math.floor(r.y),
        width: Math.floor(r.width),
        height: Math.floor(r.height),
      };
      if (
        rect.width < 14 ||
        rect.height < 14 ||
        rect.x + rect.width > size.width ||
        rect.y + rect.height > size.height
      )
        throw new Error("이미지 안에서 14px 이상 영역을 선택하세요.");
      let cropped = image.crop(rect);
      if (c.polygon && c.polygon.length >= 3) {
        const poly = z
          .array(z.tuple([finite, finite]))
          .min(3)
          .max(200)
          .parse(c.polygon);
        const bitmap = cropped.toBitmap();
        for (let y = 0; y < rect.height; y++)
          for (let x = 0; x < rect.width; x++) {
            let inside = false;
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
              const [xi, yi] = poly[i],
                [xj, yj] = poly[j];
              if (
                yi > y + rect.y !== yj > y + rect.y &&
                x + rect.x < ((xj - xi) * (y + rect.y - yi)) / (yj - yi) + xi
              )
                inside = !inside;
            }
            if (!inside) bitmap[(y * rect.width + x) * 4 + 3] = 0;
          }
        cropped = nativeImage.createFromBitmap(bitmap, {
          width: rect.width,
          height: rect.height,
        });
      }
      const file = `assets/${uid()}.png`;
      store.write(c.id, file, cropped.toPNG());
      const asset = engine.asset(
        p,
        file,
        "image",
        `${part.name} · 수동 영역`,
        "crop",
        { parentId: a.id },
      );
      part.imageId = asset.id;
      part.occluded = true;
      engine.touch(p);
      return asset;
    }
    case "assembly.save": {
      const p = store.project(c.id);
      p.assemblies.push({
        id: uid(),
        name: c.name.slice(0, 100) || `조합 ${p.assemblies.length + 1}`,
        createdAt: new Date().toISOString(),
        parts: structuredClone(p.parts),
      });
      return store.save(p);
    }
    case "assembly.restore": {
      const p = store.project(c.id),
        a = p.assemblies.find((x) => x.id === c.assemblyId);
      if (!a) throw new Error("조합 없음");
      p.parts = structuredClone(a.parts);
      return engine.touch(p);
    }
    case "generation.quote":
      return engine.quote(c.id, c.request);
    case "generation.approve":
      return engine.approve(c.quoteId, c.unknownCostAccepted);
    case "job.poll":
      return engine.poll(c.id, c.jobId);
    case "job.cancel":
      return engine.cancel(c.id, c.jobId);
    case "job.reconcile":
      return engine.reconcile(c.id, c.jobId, c.remoteId);
    case "settings.update":
      if (
        c.settings.tripoRegion &&
        c.settings.tripoRegion !== store.settings.tripoRegion &&
        store
          .projects()
          .some((p) =>
            p.jobs.some((j) =>
              [
                "queued",
                "submitting",
                "running",
                "paused",
                "submission_unknown",
              ].includes(j.status),
            ),
          )
      )
        throw new Error(
          "진행 중이거나 제출 확인이 필요한 작업이 있어 연결 지역을 변경할 수 없습니다.",
        );
      store.settings = z
        .object({
          tripoRegion: z
            .enum(["international", "china"])
            .default("international"),
          blenderPath: z.string().max(1024),
          unityPath: z.string().max(1024),
          unityEditorPath: z.string().max(1024),
        })
        .strict()
        .parse(c.settings);
      return store.settings;
    case "settings.probe":
      return local.probe();
    case "key.save":
      return vault.save(c.key);
    case "key.delete":
      return vault.delete();
    case "key.check":
      return engine.tripo.balance();
    case "blender.build":
      return local.build(c.id, c.mode, c.assetId);
    case "blender.open": {
      const p = store.project(c.id),
        b = p.builds.find((x) => x.id === c.buildId);
      if (!b) throw new Error("Blender 파일 없음");
      const process = spawn(
        store.settings.blenderPath,
        [store.file(c.id, b.blend)],
        { detached: true, stdio: "ignore", windowsHide: true, shell: false },
      );
      process.on("error", () => {});
      process.unref();
      return true;
    }
    case "unity.install":
      return local.install(c.id);
    case "unity.import":
      return local.importUnity(c.id, c.buildId);
    case "unity.result":
      return local.result(c.id);
    case "folder.open":
      return shell.openPath(c.id ? store.directory(c.id) : store.root);
    default:
      throw new Error("허용되지 않은 명령");
  }
}
app.whenReady().then(async () => {
  const root = app.getPath("userData");
  store = new Store(root);
  await store.open(
    path.join(app.getAppPath(), "node_modules/sql.js/dist/sql-wasm.wasm"),
  );
  vault = new Vault(root);
  local = new LocalPipeline(
    store,
    app.isPackaged
      ? path.join(process.resourcesPath, "integrations")
      : path.join(app.getAppPath(), "integrations"),
  );
  engine = new Engine(
    store,
    new Tripo(
      () => vault.get(),
      fetch,
      () => store.settings.tripoRegion,
    ),
    (projectId, nativeRelative) =>
      local.previewModel(projectId, nativeRelative),
  );
  studio = new StudioBrowser();
  chatgpt = new ChatGptBrowser();
  const worker = new CodexWorker({
    connectionFactory: (context) =>
      context.imageBackend === "chatgpt-web"
        ? chatgpt.workerConnection(context)
        : studio.workerConnection(context),
    probeConnections: () => studio.probeConnections(),
    stageReceipt: (runId, stageId, attempt) => {
      const chatgptReceipt = chatgpt.stageReceipt(runId, stageId, attempt);
      return chatgptReceipt.submission || chatgptReceipt.downloads.length
        ? chatgptReceipt
        : studio.stageReceipt(runId, stageId, attempt);
    },
  });
  production = new ProductionEngine(store, worker);
  workbench = new WorkbenchEngine(
    store,
    new CodexWorkbenchExecutor(worker, {
      projectRoot: (id) => store.directory(id),
      blenderPath: () => store.settings.blenderPath,
      unityPath: (id) => store.project(id).unityPath,
      unityEditorPath: () => store.settings.unityEditorPath,
      checkpointRoot: path.join(root, "workbench-checkpoints"),
      resourcesPath: app.isPackaged
        ? path.join(process.resourcesPath, "integrations")
        : path.join(app.getAppPath(), "integrations"),
    }),
    { prepareSeparationImages },
  );
  protocol.handle("asset", async (request) => {
    try {
      const u = new URL(request.url);
      if (u.hostname !== "project") return new Response("", { status: 403 });
      const [id, ...parts] = u.pathname
        .slice(1)
        .split("/")
        .map(decodeURIComponent);
      const file = store.file(id, parts.join("/"));
      const p = store.project(id);
      const knownProductionArtifact = production
        .list(id)
        .some((run) =>
          run.stages.some((stage) =>
            stage.artifacts.some(
              (artifact) =>
                store.file(id, `production/${run.id}/${artifact.path}`) ===
                file,
            ),
          ),
        );
      const knownWorkbenchArtifact = workbench
        .list(id)
        .some((session) =>
          session.jobs.some((job) =>
            [...job.candidates, ...(job.draftCandidates ?? [])].some(
              (candidate) =>
                candidate.artifacts.some(
                  (artifact) =>
                    store.file(id, artifact.path) === file ||
                    (!!artifact.normalized &&
                      store.file(id, artifact.normalized.path) === file),
                ),
            ),
          ),
        );
      if (
        !p.assets.some((a) => store.file(id, a.file) === file) &&
        !knownProductionArtifact &&
        !knownWorkbenchArtifact
      )
        return new Response("", { status: 403 });
      if (
        !fs
          .realpathSync(file)
          .startsWith(fs.realpathSync(store.directory(id)) + path.sep)
      )
        return new Response("", { status: 403 });
      // Chromium's file fetch can reject valid Windows paths above MAX_PATH.
      // Node streams support those paths; retain the same allowlist and realpath checks.
      const mime: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".json": "application/json",
        ".gltf": "model/gltf+json",
        ".glb": "model/gltf-binary",
        ".txt": "text/plain; charset=utf-8",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
      };
      const bytes = fs.statSync(file).size;
      const stream = fs.createReadStream(file);
      await new Promise<void>((resolve, reject) => {
        stream.once("open", () => resolve());
        stream.once("error", reject);
      });
      return new Response(
        Readable.toWeb(stream) as ReadableStream<Uint8Array>,
        {
          headers: {
            "Content-Type":
              mime[path.extname(file).toLowerCase()] ??
              "application/octet-stream",
            "Content-Length": String(bytes),
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    } catch {
      return new Response("", { status: 404 });
    }
  });
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#101213",
    title: "Partsmith · 캐릭터 제작실",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_w, _p, cb) =>
    cb(false),
  );
  ipcMain.handle("partsmith:command", async (event, c) => {
    if (
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame
    )
      return { ok: false, error: "허용되지 않은 호출자" };
    try {
      return { ok: true, value: await dispatchTracked(c) };
    } catch (e) {
      const raw = e instanceof Error ? e.message : "작업 실패";
      return {
        ok: false,
        error: vault.get() ? raw.split(vault.get()).join("[REDACTED]") : raw,
      };
    }
  });
  if (process.env.PARTSMITH_DEV) await win.loadURL("http://127.0.0.1:5173");
  else await win.loadFile(path.join(__dirname, "../dist/index.html"));
  const timer = setInterval(() => void engine.pollActive(), 10000);
  win.on("closed", () => app.quit());
  app.on("before-quit", () => {
    clearInterval(timer);
    production.shutdown();
    workbench.shutdown();
    studio.close();
    chatgpt.close();
  });
});
app.on("second-instance", () => {
  win?.show();
  win?.focus();
});
app.on("window-all-closed", () => app.quit());
