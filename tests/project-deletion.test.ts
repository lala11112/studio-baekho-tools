import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../engine/store";
import type { Project } from "../shared/types";

const wasm = path.resolve("node_modules/sql.js/dist/sql-wasm.wasm");
async function fixture(t: TestContext) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "partsmith-delete-"));
  const root = path.join(temporary, "data");
  const store = new Store(root);
  const stores = [store];
  await store.open(wasm);
  t.after(() => {
    for (const instance of stores) instance.db.close();
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const project = (id: string): Project => ({
    schemaVersion: 1,
    id,
    name: id,
    style: "test",
    height: 1.7,
    unityPath: path.join(temporary, "external-unity"),
    unityFolder: "Assets",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revision: 0,
    assets: [],
    parts: [],
    jobs: [],
    assemblies: [],
    builds: [],
    demo: false,
  });
  const own = store.save(project("delete-me"));
  const other = store.save(project("keep-me"));
  for (const p of [own, other]) {
    store.write(p.id, "assets/original.png", `asset:${p.id}`);
    for (const kind of ["quote", "workbench", "production"])
      store.put(kind, `${kind}-${p.id}`, {
        id: `${kind}-${p.id}`,
        projectId: p.id,
      });
    store.put("unity-request", p.id, { requestId: `request-${p.id}` });
  }
  const settings = { ...store.settings, tripoRegion: "china" as const };
  store.settings = settings;
  return {
    temporary,
    root,
    store,
    own,
    other,
    settings,
    trash: async (source: string) => {
      assert.equal(source, path.resolve(store.directory(own.id)));
      fs.renameSync(source, path.join(temporary, "recycled"));
    },
    reopen: async () => {
      const reopened = new Store(root);
      stores.push(reopened);
      await reopened.open(wasm);
      return reopened;
    },
  };
}
function assertRemoved(store: Store, id: string) {
  assert.equal(store.get("project", id), undefined);
  assert.equal(store.get("unity-request", id), undefined);
  assert.equal(store.get("project-deletion", id), undefined);
  for (const kind of ["quote", "workbench", "production"])
    assert.equal(store.get(kind, `${kind}-${id}`), undefined);
}
function assertRetained(store: Store, id: string) {
  assert.ok(store.get("project", id));
  assert.ok(store.get("unity-request", id));
  for (const kind of ["quote", "workbench", "production"])
    assert.ok(store.get(kind, `${kind}-${id}`));
}

test("project deletion recycles only its directory and removes only related records", async (t) => {
  const f = await fixture(t);
  const external = path.join(f.temporary, "imported-original.png");
  fs.writeFileSync(external, "external original");
  fs.mkdirSync(f.own.unityPath);
  fs.writeFileSync(path.join(f.own.unityPath, "scene.unity"), "Unity scene");
  f.store.put("unrelated", f.own.id, { preserve: true });
  assert.deepEqual(await f.store.deleteProject(f.own.id, f.trash), {
    deleted: true,
  });
  assertRemoved(f.store, f.own.id);
  assertRetained(f.store, f.other.id);
  assert.deepEqual(f.store.settings, f.settings);
  assert.equal(fs.readFileSync(external, "utf8"), "external original");
  assert.equal(
    fs.readFileSync(path.join(f.own.unityPath, "scene.unity"), "utf8"),
    "Unity scene",
  );
  assert.equal(
    fs.readFileSync(
      path.join(f.temporary, "recycled/assets/original.png"),
      "utf8",
    ),
    "asset:delete-me",
  );
  assert.equal(
    fs.readFileSync(f.store.file(f.other.id, "assets/original.png"), "utf8"),
    "asset:keep-me",
  );
  const reopened = await f.reopen();
  assertRemoved(reopened, f.own.id);
  assertRetained(reopened, f.other.id);
  assert.deepEqual(reopened.get("unrelated", f.own.id), { preserve: true });
});

test("failed recycle keeps files, project and related records and permits later work", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.store.deleteProject(f.own.id, async () => {
      throw new Error("recycle unavailable");
    }),
    /recycle unavailable/,
  );
  assertRetained(f.store, f.own.id);
  assert.equal(fs.existsSync(f.store.directory(f.own.id)), true);
  assert.equal(f.store.isProjectDeleting(f.own.id), false);
  assert.equal(f.store.get("project-deletion", f.own.id), undefined);
  f.store.save(f.own);
  assertRetained(await f.reopen(), f.own.id);
});

test("pending and completed deletion block duplicate deletion and stale writes", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = f.store.deleteProject(f.own.id, async (source) => {
    await gate;
    await f.trash(source);
  });
  assert.equal(f.store.isProjectDeleting(f.own.id), true);
  await assert.rejects(f.store.deleteProject(f.own.id, f.trash), /삭제 중/);
  const staleWrites = [
    () => f.store.save(f.own),
    () => f.store.write(f.own.id, "late.txt", "late"),
    () => f.store.put("project", f.own.id, f.own),
    () => f.store.put("unity-request", f.own.id, {}),
    ...["quote", "workbench", "production"].map(
      (kind) => () =>
        f.store.put(kind, `late-${kind}`, { projectId: f.own.id }),
    ),
  ];
  for (const write of staleWrites) assert.throws(write, /삭제 중/);
  f.store.write(f.other.id, "allowed.txt", "other project");
  f.store.settings = f.settings;
  release();
  await pending;
  for (const write of staleWrites) assert.throws(write, /삭제된 프로젝트/);
  assert.equal(fs.existsSync(f.store.directory(f.own.id)), false);
});

test("restart cancels a pre-move intent and preserves all existing project data", async (t) => {
  const f = await fixture(t);
  f.store.put("project-deletion", f.own.id, { projectId: f.own.id });
  const reopened = await f.reopen();
  assertRetained(reopened, f.own.id);
  assert.equal(reopened.get("project-deletion", f.own.id), undefined);
  assert.equal(reopened.isProjectDeleting(f.own.id), false);
  assert.equal(fs.existsSync(reopened.directory(f.own.id)), true);
});

test("restart finishes records after a completed move without another recycle request", async (t) => {
  const f = await fixture(t);
  f.store.put("project-deletion", f.own.id, { projectId: f.own.id });
  await f.trash(f.store.directory(f.own.id));
  const reopened = await f.reopen();
  assertRemoved(reopened, f.own.id);
  assertRetained(reopened, f.other.id);
  assert.equal(
    fs.existsSync(path.join(f.temporary, "recycled/project.json")),
    true,
  );
});

test("failed record flush after recycle restores records and retains a recoverable intent", async (t) => {
  const f = await fixture(t);
  const flush = f.store.flush.bind(f.store);
  let calls = 0;
  f.store.flush = () => {
    if (++calls === 2) throw new Error("disk full");
    flush();
  };
  await assert.rejects(f.store.deleteProject(f.own.id, f.trash), /disk full/);
  assertRetained(f.store, f.own.id);
  assert.equal(f.store.isProjectDeleting(f.own.id), true);
  assert.throws(() => f.store.save(f.own), /삭제 중/);
  f.store.flush = flush;
  const reopened = await f.reopen();
  assertRemoved(reopened, f.own.id);
  assertRetained(reopened, f.other.id);
});

for (const linked of ["target", "parent"] as const) {
  test(`project deletion rejects a ${linked} junction before calling recycle`, async (t) => {
    const f = await fixture(t);
    const link =
      linked === "target"
        ? f.store.directory(f.own.id)
        : path.join(f.root, "projects");
    const external = path.join(f.temporary, "linked-original");
    fs.renameSync(link, external);
    fs.symlinkSync(external, link, "junction");
    let calls = 0;
    await assert.rejects(
      f.store.deleteProject(f.own.id, async () => {
        calls++;
      }),
      /폴더 삭제 거부/,
    );
    assert.equal(calls, 0);
    assertRetained(f.store, f.own.id);
    assert.equal(fs.existsSync(external), true);
    assert.equal(f.store.get("project-deletion", f.own.id), undefined);
  });
}

test("invalid IDs never reach recycle and a missing folder only removes stale records", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const trash = async () => {
    calls++;
  };
  for (const id of ["", "..", "../outside", "a/b", "a\\b", "C:\\outside"])
    await assert.rejects(f.store.deleteProject(id, trash), /프로젝트 ID/);
  await assert.rejects(
    f.store.deleteProject("unknown-project", trash),
    /찾을 수 없습니다/,
  );
  fs.renameSync(
    f.store.directory(f.own.id),
    path.join(f.temporary, "already-moved"),
  );
  await f.store.deleteProject(f.own.id, trash);
  assert.equal(calls, 0);
  assertRemoved(f.store, f.own.id);
  assertRetained(f.store, f.other.id);
});
