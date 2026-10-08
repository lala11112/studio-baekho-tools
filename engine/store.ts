import initSqlJs, { type Database } from "sql.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Project, Quote, Settings } from "../shared/types";
export class Store {
  db!: Database;
  constructor(public root: string) {}
  async open(wasmPath: string) {
    fs.mkdirSync(this.root, { recursive: true });
    const SQL = await initSqlJs({ locateFile: () => wasmPath });
    const file = path.join(this.root, "workbench.db");
    this.db = new SQL.Database(
      fs.existsSync(file) ? fs.readFileSync(file) : undefined,
    );
    this.db.run(
      "CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id))",
    );
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
    const file = this.file(id, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + ".tmp", data);
    fs.renameSync(file + ".tmp", file);
    return file;
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
