import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import electron from "electron";
import { PNG } from "pngjs";
import { normalizeSeparationImages } from "../engine/separation-images";
import { WORKBENCH_ROLES, type WorkbenchArtifact } from "../shared/workbench";

const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const prepared = new Map<string, WorkbenchArtifact[]>();

function safeFolder(
  workspace: string,
  folder: string,
  create = false,
): boolean {
  const root = path.resolve(workspace),
    relative = path.relative(root, folder);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw Error("사진 정렬 폴더가 작업 폴더 밖입니다.");
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory()))
      throw Error("사진 정렬 폴더의 연결 경로를 거부했습니다.");
    if (!stat) {
      if (!create) return false;
      fs.mkdirSync(current);
    }
  }
  return true;
}

function safeOutput(workspace: string, file: string, sources: Set<string>) {
  if (!safeFolder(workspace, path.dirname(file)))
    throw Error("사진 정렬 폴더가 없습니다.");
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (
    stat &&
    (stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink > 1 ||
      sources.has(fs.realpathSync(file)))
  )
    throw Error("사진 정렬 출력의 원본·연결 파일 접근을 거부했습니다.");
}

function writeDerivative(
  workspace: string,
  file: string,
  bytes: Uint8Array | string,
  sources: Set<string>,
) {
  safeOutput(workspace, file, sources);
  const temporary = path.join(
    path.dirname(file),
    `.partsmith-${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    safeOutput(workspace, file, sources);
    // Replacement never writes through an existing file inode (including hard links).
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** Local display/upload derivatives; the generated originals are never overwritten. */
export function prepareSeparationImages(
  artifacts: WorkbenchArtifact[],
  workspace: string,
  projectRoot: string,
): WorkbenchArtifact[] {
  const output = artifacts.map((a) => {
    const { normalized: _normalized, normalizationIssue: _issue, ...raw } = a;
    return raw as WorkbenchArtifact;
  });
  const sourcePaths = new Set<string>();
  for (const artifact of output.filter((a) => a.kind === "image")) {
    const source = fs.realpathSync(path.resolve(projectRoot, artifact.path));
    if (!source.startsWith(fs.realpathSync(workspace) + path.sep))
      throw Error("현재 작업 폴더 밖 사진입니다.");
    if (digest(fs.readFileSync(source)) !== artifact.sha256)
      throw Error("사진 원본이 변경됐습니다.");
    sourcePaths.add(source);
  }
  for (const role of WORKBENCH_ROLES) {
    const images = output.filter((a) => a.kind === "image" && a.role === role);
    if (!images.length) continue;
    const groupKey = digest(
      JSON.stringify([
        "separation-normalization-v1",
        images.map((a) => [a.view ?? "front", a.sha256]).sort(),
      ]),
    );
    const folder = path.join(workspace, "normalized", groupKey.slice(0, 20));
    const folderExists = safeFolder(workspace, folder);
    const cacheKey =
      workspace + groupKey + digest(JSON.stringify(images.map((a) => a.path)));
    const cached = prepared.get(cacheKey);
    if (
      cached &&
      folderExists &&
      cached.every((a) => {
        if (!a.normalized || a.normalizationIssue) return false;
        const file = path.join(projectRoot, a.normalized.path);
        safeOutput(workspace, file, sourcePaths);
        return (
          fs.existsSync(file) &&
          digest(fs.readFileSync(file)) === a.normalized.sha256
        );
      })
    ) {
      for (const a of images) {
        const prior = cached.find(
          (b) => b.path === a.path && b.sha256 === a.sha256,
        );
        if (prior)
          Object.assign(a, {
            normalized: prior.normalized,
            normalizationIssue: prior.normalizationIssue,
          });
      }
      continue;
    }
    const decoded = images.flatMap((a) => {
      try {
        const source = path.resolve(projectRoot, a.path);
        if (
          !fs
            .realpathSync(source)
            .startsWith(fs.realpathSync(workspace) + path.sep)
        )
          throw Error("현재 작업 폴더 밖 사진입니다.");
        const bytes = fs.readFileSync(source);
        if (digest(bytes) !== a.sha256)
          throw Error("사진 원본이 변경됐습니다.");
        // PNGJS provides explicit straight-alpha RGBA, independent of platform bitmap layouts.
        const png = bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          ? bytes
          : electron.nativeImage.createFromBuffer(bytes).toPNG();
        const image = PNG.sync.read(png, { skipRescale: false });
        return [
          {
            id: a.path,
            role,
            view: a.view ?? ("front" as const),
            width: image.width,
            height: image.height,
            rgba: image.data,
          },
        ];
      } catch (error) {
        a.normalizationIssue = `사진 크기 맞춤 실패: ${error instanceof Error ? error.message : String(error)}`;
        return [];
      }
    });
    const normalized = normalizeSeparationImages(decoded);
    safeFolder(workspace, folder, true);
    for (const image of normalized.images) {
      const artifact = images.find((a) => a.path === image.id)!;
      const anchor = images.find((a) => a.path === image.transform.anchorId)!;
      const file = path.join(folder, `${role}-${image.view}.png`);
      const png = new PNG({ width: image.width, height: image.height });
      png.data = Buffer.from(image.rgba);
      const bytes = PNG.sync.write(png);
      writeDerivative(workspace, file, bytes, sourcePaths);
      artifact.normalized = {
        path: path.relative(projectRoot, file).split(path.sep).join("/"),
        sha256: digest(bytes),
        bytes: bytes.length,
        width: image.width,
        height: image.height,
        sourceSha256: artifact.sha256,
        anchorSha256: anchor.sha256,
      };
    }
    for (const issue of normalized.issues.filter(
      (i) => i.severity === "needs_input",
    )) {
      const a = images.find((a) => a.path === issue.id);
      if (a) a.normalizationIssue = issue.message;
    }
    writeDerivative(
      workspace,
      path.join(folder, "alignment.json"),
      JSON.stringify(
        {
          version: 1,
          canvas: 2048,
          groups: normalized.groups,
          issues: normalized.issues,
          images: normalized.images.map(({ rgba: _rgba, ...image }) => image),
        },
        null,
        2,
      ),
      sourcePaths,
    );
    prepared.set(cacheKey, structuredClone(images));
    if (prepared.size > 48) prepared.delete(prepared.keys().next().value!);
  }
  return output;
}
