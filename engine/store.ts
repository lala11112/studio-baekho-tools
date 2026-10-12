import initSqlJs, { type Database } from "sql.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Project, Quote, Settings } from "../shared/types";
export class Store {
  db!: Database;
  private createDatabase!: (data?: Uint8Array) => Database;
  private deletingProjects = new Set<string>();
  private deletedProjects = new Set<string>();
  constructor(public root: string) {}
  async open(wasmPath: string) {
    fs.mkdirSync(this.root, { recursive: true });
    const SQL = await initSqlJs({ locateFile: () => wasmPath });
    this.createDatabase = (data) => new SQL.Database(data);
    const file = path.join(this.root, "workbench.db");
    this.db = new SQL.Database(
      fs.existsSync(file) ? fs.readFileSync(file) : undefined,
    );
    this.db.run(
      "CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id))",
    );
    this.recoverProjectDeletions();
    for (const p of this.projects()) {
      let changed = false;
      for (const j of p.jobs) {
        if (j.status === "submitting") {
          j.status = j.remoteId ? "running" : "submission_unknown";
          j.message = "앱 종료 후 복구. 자동 재제출하지 않습니다.";
          changed = true;
        } else if (j.status === "queued") {
          j.status = "cancelled_local";
          j.message = "앱 종료로 미제출 후보 중지. 새 승인이 필요합니다.";
          changed = true;
        }
      }
      if (changed) this.save(p);
    }
  }
  get<T>(kind: string, id: string): T | undefined {
    const s = this.db.prepare("SELECT json FROM records WHERE kind=? AND id=?");
    try {
      s.bind([kind, id]);
      return s.step() ? JSON.parse(s.getAsObject().json as string) : undefined;
    } finally {
      s.free();
    }
  }
  all<T>(kind: string): T[] {
    const s = this.db.prepare(
      "SELECT json FROM records WHERE kind=? ORDER BY rowid DESC",
    );
    const out: T[] = [];
    try {
      s.bind([kind]);
      while (s.step()) out.push(JSON.parse(s.getAsObject().json as string));
      return out;
    } finally {
      s.free();
    }
  }
  put(kind: string, id: string, value: unknown) {
    if (kind === "project" || kind === "unity-request")
      this.assertProjectAvailable(id);
    else if (["quote", "workbench", "production", "graphics"].includes(kind)) {
      const projectId = (value as { projectId?: string } | null)?.projectId;
      if (projectId) this.assertProjectAvailable(projectId);
    }
    this.db.run("INSERT OR REPLACE INTO records VALUES (?,?,?)", [
      kind,
      id,
      JSON.stringify(value),
    ]);
    this.flush();
  }
  flush() {
    const dest = path.join(this.root, "workbench.db");
    fs.writeFileSync(dest + ".tmp", this.db.export());
    fs.renameSync(dest + ".tmp", dest);
  }
  projects() {
    return this.all<Project>("project");
  }
  project(id: string) {
    const p = this.get<Project>("project", id);
    if (!p) throw new Error("프로젝트를 찾을 수 없습니다.");
    return p;
  }
  save(p: Project) {
    this.assertProjectAvailable(p.id);
    p.updatedAt = new Date().toISOString();
    this.put("project", p.id, p);
    this.write(p.id, "project.json", JSON.stringify(p, null, 2));
    return p;
  }
  directory(id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("잘못된 프로젝트 ID");
    return path.join(this.root, "projects", id);
  }
  file(id: string, relative: string) {
    const root = this.directory(id);
    const resolved = path.resolve(root, relative);
    if (!resolved.startsWith(root + path.sep))
      throw new Error("프로젝트 밖 파일 접근 거부");
    return resolved;
  }
  write(id: string, relative: string, data: string | Uint8Array) {
    this.assertProjectAvailable(id);
    const file = this.file(id, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + ".tmp", data);
    fs.renameSync(file + ".tmp", file);
    return file;
  }
  isProjectDeleting(id: string) {
    return (
      this.deletingProjects.has(id) || Boolean(this.get("project-deletion", id))
    );
  }
  assertProjectAvailable(id: string) {
    this.directory(id);
    if (this.isProjectDeleting(id))
      throw new Error("프로젝트를 삭제 중입니다. 작업을 시작할 수 없습니다.");
    if (this.deletedProjects.has(id))
      throw new Error("이미 삭제된 프로젝트입니다.");
  }
  /** Commit records together; a failed atomic file replacement restores memory too. */
  private persistTransaction(change: () => void) {
    const before = this.db.export();
    try {
      this.db.run("BEGIN TRANSACTION");
      change();
      this.db.run("COMMIT");
      this.flush();
    } catch (error) {
      this.db.close();
      this.db = this.createDatabase(before);
      throw error;
    }
  }
  /** Reject junctions/symlinks in every parent, including a dangling target link. */
  private deletionDirectory(id: string): string | undefined {
    const target = path.resolve(this.directory(id));
    const projects = path.resolve(this.root, "projects");
    if (path.dirname(target) !== projects)
      throw new Error("프로젝트 밖 폴더 삭제 거부");
    const volume = path.parse(target).root;
    let current = volume;
    for (const segment of path.relative(volume, target).split(path.sep)) {
      current = path.join(current, segment);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        path.relative(current, fs.realpathSync(current)) !== ""
      )
        throw new Error("연결된 폴더 또는 프로젝트 밖 폴더 삭제 거부");
    }
    return target;
  }
  private removeProjectRecords(id: string) {
    const related: [string, string][] = [];
    const statement = this.db.prepare(
      "SELECT kind,id,json FROM records WHERE kind IN ('quote','workbench','production','graphics')",
    );
    try {
      while (statement.step()) {
        const row = statement.getAsObject();
        if (JSON.parse(row.json as string).projectId === id)
          related.push([row.kind as string, row.id as string]);
      }
    } finally {
      statement.free();
    }
    this.persistTransaction(() => {
      for (const [kind, recordId] of related)
        this.db.run("DELETE FROM records WHERE kind=? AND id=?", [
          kind,
          recordId,
        ]);
      for (const kind of ["project", "unity-request", "project-deletion"])
        this.db.run("DELETE FROM records WHERE kind=? AND id=?", [kind, id]);
    });
    this.deletedProjects.add(id);
  }
  private cancelDeletionIntent(id: string) {
    this.persistTransaction(() => {
      this.db.run(
        "DELETE FROM records WHERE kind='project-deletion' AND id=?",
        [id],
      );
    });
  }
  private recoverProjectDeletions() {
    for (const intent of this.all<{ projectId: string }>("project-deletion")) {
      const id = intent.projectId;
      if (this.deletionDirectory(id)) this.cancelDeletionIntent(id);
      else this.removeProjectRecords(id);
      this.deletingProjects.delete(id);
    }
  }
  async deleteProject(
    id: string,
    trash: (absolutePath: string) => Promise<void>,
  ) {
    this.assertProjectAvailable(id);
    this.project(id);
    this.deletionDirectory(id);
    this.deletingProjects.add(id);
    try {
      this.persistTransaction(() => {
        this.db.run("INSERT INTO records VALUES ('project-deletion',?,?)", [
          id,
          JSON.stringify({
            projectId: id,
            createdAt: new Date().toISOString(),
          }),
        ]);
      });
      const directory = this.deletionDirectory(id);
      if (directory) {
        await trash(directory);
        if (this.deletionDirectory(id))
          throw new Error("프로젝트 폴더의 휴지통 이동을 확인하지 못했습니다.");
      }
      this.removeProjectRecords(id);
      return { deleted: true };
    } catch (error) {
      // A missing source is ambiguous after a failed move/flush: keep the durable
      // intent so restart only reconciles records and never repeats the move.
      if (this.get("project-deletion", id) && this.deletionDirectory(id))
        this.cancelDeletionIntent(id);
      throw error;
    } finally {
      if (!this.get("project-deletion", id)) this.deletingProjects.delete(id);
    }
  }
  quote(q: Quote) {
    this.put("quote", q.id, q);
  }
  get settings(): Settings {
    return {
      tripoRegion: "international",
      blenderPath:
        "C:\\Program Files\\Blender Foundation\\Blender 5.0\\blender.exe",
      unityPath: "C:\\Unity\\3D Tool Test",
      unityEditorPath:
        "C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.21f1\\Editor\\Unity.exe",
      ...this.get<Settings>("settings", "local"),
    };
  }
  set settings(s: Settings) {
    this.put("settings", "local", s);
  }
}
export const uid = () => randomUUID();
