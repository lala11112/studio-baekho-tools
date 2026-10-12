import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { createInitialProject } from "../engine/four-tiger-items/domain";
import * as shared from "../shared/four-tiger-items";

// Executes the actual TSX with deterministic hooks and delayed API promises.
// Browser interaction is separately covered by four-tiger-items-smoke.mjs.
function harness(
  file: string,
  name: string,
  api: any,
  seed: any[] = [],
  effects = false,
) {
  let index = 0,
    pending: (() => void)[] = [];
  const states = seed,
    oldDeps: any[] = [],
    cleanup: any[] = [],
    timers = new Map<number, () => void>();
  const hooks = {
    useState(init: any) {
      const n = index++;
      if (!(n in states))
        states[n] = typeof init === "function" ? init() : init;
      return [
        states[n],
        (x: any) => {
          states[n] = typeof x === "function" ? x(states[n]) : x;
        },
      ];
    },
    useRef(init: any) {
      const n = index++;
      return states[n] ?? (states[n] = { current: init });
    },
    useEffect(fn: any, deps: any[]) {
      const n = index++;
      if (
        effects &&
        (!oldDeps[n] || deps.some((x, i) => x !== oldDeps[n][i]))
      ) {
        pending.push(() => {
          cleanup[n]?.();
          cleanup[n] = fn();
        });
        oldDeps[n] = deps;
      }
    },
  };
  const jsx = (type: any, props: any) => ({ type, props }),
    mod = { exports: {} } as any;
  const source = transformSync(fs.readFileSync(file, "utf8"), {
    loader: "tsx",
    format: "cjs",
    jsx: "automatic",
  }).code;
  const require = (id: string) =>
    id === "react"
      ? hooks
      : id === "react/jsx-runtime"
        ? { jsx, jsxs: jsx }
        : id.endsWith(".css")
          ? {}
          : id.includes("FourTigerItemEditor")
            ? { FourTigerItemEditor: "Editor", ItemIcon: "Icon" }
            : id.includes("four-tiger-item-seed")
              ? { itemSeeds: [] }
              : shared;
  vm.runInNewContext(source, {
    module: mod,
    exports: mod.exports,
    require,
    window: { fourTigerItems: api },
    setInterval: (f: () => void) => {
      const id = timers.size + 1;
      timers.set(id, f);
      return id;
    },
    clearInterval: (id: number) => timers.delete(id),
    structuredClone,
    console,
  });
  return {
    states,
    render(props: any) {
      index = 0;
      const tree = mod.exports[name](props);
      const jobs = pending;
      pending = [];
      jobs.forEach((f) => f());
      return tree;
    },
    tick() {
      for (const f of timers.values()) f();
    },
  };
}
const flat = (node: any): any[] =>
  !node || typeof node !== "object"
    ? []
    : Array.isArray(node)
      ? node.flatMap(flat)
      : [node, ...flat(node.props?.children)];
const find = (tree: any, key: string, value: string) => {
  const node = flat(tree).find((x) => x.props?.[key] === value);
  assert.ok(node, `Missing ${key}=${value}`);
  return node.props;
};
const flush = async () => {
  for (let i = 0; i < 18; i++) await Promise.resolve();
};
function project() {
  const p = createInitialProject({
    projectId: "11111111-1111-4111-8111-111111111111",
    name: "A",
    now: "2026-10-12T00:00:00.000Z",
  });
  p.revision = 1;
  return p;
}
function seed(p: any) {
  const states: any[] = [];
  states[1] = p;
  states[2] = p.items[0].candidateKey;
  states[18] = { ...p.ruleProfile.proposed };
  return states;
}
const rootProps = { active: false, navigation: { key: 0 } };

test("changed but unsaved policies cannot adopt the different stored values", () => {
  const p = project(),
    states = seed(p);
  states[18].maxSpCap = 180;
  const h = harness("src/FourTigerItems.tsx", "FourTigerItems", {}, states);
  const tree = h.render(rootProps);
  assert.equal(find(tree, "data-testid", "adopt-policies").disabled, true);
});

test("restart with durable running work leaves explicit recovery reachable", () => {
  const p = project();
  p.jobs.push({ status: "running" } as any);
  const h = harness("src/FourTigerItems.tsx", "FourTigerItems", {}, seed(p));
  const tree = h.render(rootProps);
  assert.equal(find(tree, "children", "기존 결과 복구").disabled, false);
});

test("a pending save preserves newer edits instead of clearing dirty state", async () => {
  const p = project();
  let release!: (v: boolean) => void, submitted: any;
  const h = harness(
    "src/FourTigerItemEditor.tsx",
    "FourTigerItemEditor",
    {},
    [],
    true,
  );
  let props = {
    project: p,
    item: p.items[0],
    busy: false,
    act: async () => true,
    save: (patch: any) => {
      submitted = patch;
      return new Promise<boolean>((r) => {
        release = r;
      });
    },
  };
  h.render(props);
  let tree = h.render(props);
  find(tree, "aria-label", "아이템 이름").onChange({
    target: { value: "First" },
  });
  tree = h.render(props);
  find(tree, "data-testid", "save-item").onClick();
  props = { ...props, busy: true };
  tree = h.render(props);
  find(tree, "aria-label", "아이템 이름").onChange({
    target: { value: "Second" },
  });
  h.render(props);
  props = { ...props, busy: false, item: { ...p.items[0], ...submitted } };
  release(true);
  await flush();
  h.render(props);
  tree = h.render(props);
  assert.equal(submitted.name, "First");
  assert.equal(find(tree, "aria-label", "아이템 이름").value, "Second");
  assert.equal(h.states[1], true);
});

test("late mutation of project A cannot replace newly opened project B", async () => {
  const p = project(),
    b = structuredClone(p);
  b.projectId = "22222222-2222-4222-8222-222222222222";
  b.name = "B";
  b.items[0].candidateKey = "33333333-3333-4333-8333-333333333333";
  let finish!: (value: any) => void;
  const api = {
    list: async () => [],
    read: async ({ projectId }: any) => (projectId === b.projectId ? b : p),
    reviewItems: () =>
      new Promise((r) => {
        finish = r;
      }),
  };
  const h = harness("src/FourTigerItems.tsx", "FourTigerItems", api, seed(p));
  let tree = h.render(rootProps);
  find(tree, "children", "선택 데이터 검토 완료").onClick();
  tree = h.render(rootProps);
  find(tree, "aria-label", "초안 묶음").onChange({
    target: { value: b.projectId },
  });
  await flush();
  assert.equal(h.states[1].name, "B");
  finish(p);
  await flush();
  assert.equal(h.states[1].name, "B");
  assert.ok(h.states[1].items.some((i: any) => i.candidateKey === h.states[2]));
});

test("out-of-order project loads cannot replace the last requested project", async () => {
  const p = project(),
    b = structuredClone(p);
  b.projectId = "22222222-2222-4222-8222-222222222222";
  b.name = "B";
  let release!: (v: any) => void;
  const api = {
    list: async () => [],
    read: ({ projectId }: any) =>
      projectId === p.projectId
        ? new Promise((r) => {
            release = r;
          })
        : Promise.resolve(b),
  };
  const h = harness("src/FourTigerItems.tsx", "FourTigerItems", api, seed(p));
  let tree = h.render(rootProps);
  find(tree, "aria-label", "초안 묶음").onChange({
    target: { value: p.projectId },
  });
  tree = h.render(rootProps);
  find(tree, "aria-label", "초안 묶음").onChange({
    target: { value: b.projectId },
  });
  await flush();
  release(p);
  await flush();
  assert.equal(h.states[1].name, "B");
});

test("a delayed polling response cannot roll back a saved project revision", async () => {
  const p = project();
  p.jobs.push({ status: "running" } as any);
  let release!: (v: any) => void;
  const api = {
    list: async () => [],
    validate: async () => ({ issues: [] }),
    read: () =>
      new Promise((r) => {
        release = r;
      }),
    reviewItems: async () => ({ ...p, revision: 3 }),
  };
  const h = harness(
    "src/FourTigerItems.tsx",
    "FourTigerItems",
    api,
    seed(p),
    true,
  );
  let tree = h.render({ ...rootProps, active: true });
  h.tick();
  find(tree, "children", "선택 데이터 검토 완료").onClick();
  await flush();
  assert.equal(h.states[1].revision, 3);
  release(p);
  await flush();
  assert.equal(h.states[1].revision, 3);
});

test("hiding a project opened from the dashboard does not reload and reset its selected item", async () => {
  const p = project();
  let reads = 0;
  const api = {
    list: async () => [],
    validate: async () => ({ issues: [] }),
    read: async () => {
      reads++;
      return p;
    },
  };
  const h = harness(
      "src/FourTigerItems.tsx",
      "FourTigerItems",
      api,
      seed(p),
      true,
    ),
    props = { active: true, navigation: { key: 1, projectId: p.projectId } };
  h.render(props);
  await flush();
  h.states[2] = p.items[3].candidateKey;
  h.render({ ...props, active: false });
  await flush();
  assert.equal(reads, 1);
  assert.equal(h.states[2], p.items[3].candidateKey);
});

test("an unsaved visible item cannot be bulk adopted or exported as if those edits were saved", () => {
  const p = project(),
    states = seed(p);
  states[19] = true;
  states[11] = {
    projectId: p.projectId,
    revision: p.revision,
    issues: [],
    canExport: true,
  };
  const h = harness("src/FourTigerItems.tsx", "FourTigerItems", {}, states),
    tree = h.render(rootProps);
  assert.equal(find(tree, "data-testid", "adopt-items").disabled, true);
  assert.equal(find(tree, "data-testid", "export-release").disabled, true);
});
