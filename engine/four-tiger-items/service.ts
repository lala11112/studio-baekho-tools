import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  FourTigerError,
  itemPatchSchema,
  policySchema,
  reviewActions,
  type FourTigerItemsApi,
  type SainGeomItemProject,
} from "../../shared/four-tiger-items";
import * as domain from "./domain";
import { FourTigerItemStore } from "./store";
import { FourTigerIconQueue } from "./icons";
import { exportItemPackage } from "./export";
import type { FourTigerIconRunner } from "./icon-runner";
type Input<K extends keyof FourTigerItemsApi> = Parameters<
  FourTigerItemsApi[K]
>[0];
export class FourTigerItemsService implements FourTigerItemsApi {
  readonly store: FourTigerItemStore;
  readonly queue: FourTigerIconQueue;
  constructor(
    root: string,
    private runner: FourTigerIconRunner,
  ) {
    this.store = new FourTigerItemStore(path.join(root, "four-tiger-items"));
    this.queue = new FourTigerIconQueue(this.store, runner);
  }
  list() {
    return this.store.list();
  }
  create(input: Input<"create">) {
    return this.store.create(
      domain.createInitialProject({
        projectId: randomUUID(),
        name: input.name,
        now: new Date().toISOString(),
      }),
    );
  }
  read(input: Input<"read">) {
    return this.store.read(input.projectId);
  }
  patchItem(input: Input<"patchItem">) {
    return this.store.update(input.projectId, input.expectedRevision, (p) =>
      domain.patchItem(
        p,
        input.candidateKey,
        input.patch,
        new Date().toISOString(),
      ),
    );
  }
  async reviewItems(input: Input<"reviewItems">) {
    if (input.action === "reviewIcon" || input.action === "adopt") {
      const p = await this.store.read(input.projectId);
      for (const key of input.candidateKeys) {
        const item = p.items.find((i) => i.candidateKey === key);
        if (!item?.selectedIconVersion)
          throw new FourTigerError(
            "REVIEW_REQUIRED",
            "선택한 아이콘이 필요합니다.",
          );
        await this.queue.readIcon(
          input.projectId,
          key,
          item.selectedIconVersion,
        );
      }
    }
    return this.store.update(input.projectId, input.expectedRevision, (p) =>
      input.candidateKeys.reduce(
        (current, key) =>
          domain.reviewItem(
            current,
            key,
            input.action,
            input.note,
            new Date().toISOString(),
          ),
        p,
      ),
    );
  }
  updatePolicies(input: Input<"updatePolicies">) {
    return this.store.update(input.projectId, input.expectedRevision, (p) =>
      domain.updatePolicies(p, input.patch, new Date().toISOString()),
    );
  }
  adoptPolicies(input: Input<"adoptPolicies">) {
    return this.store.update(input.projectId, input.expectedRevision, (p) =>
      domain.adoptPolicies(p, input.keys, new Date().toISOString()),
    );
  }
  acknowledgeDescription(input: Input<"acknowledgeDescription">) {
    return this.store.update(input.projectId, input.expectedRevision, (p) =>
      domain.acknowledgeDescription(
        p,
        input.candidateKey,
        input.regenerate,
        new Date().toISOString(),
      ),
    );
  }
  repairReferenceIds(input: Input<"repairReferenceIds">) {
    return this.store.update(input.projectId, input.expectedRevision, (p) =>
      domain.repairReferenceIds(p, new Date().toISOString()),
    );
  }
  updateIconStyle(input: Input<"updateIconStyle">) {
    return this.store.update(input.projectId, input.expectedRevision, (p) =>
      domain.updateIconStyle(p, input.style, new Date().toISOString()),
    );
  }
  generateIcons(input: Input<"generateIcons">) {
    return this.queue.enqueue(
      input.projectId,
      input.expectedRevision,
      input.candidateKeys,
    );
  }
  cancelPending(input: Input<"cancelPending">) {
    return this.queue.cancelPending(input.projectId);
  }
  reconcile(input: Input<"reconcile">) {
    return this.queue.reconcile(input.projectId);
  }
  abandonUnknown(input: Input<"abandonUnknown">) {
    return this.queue.abandonUnknown(
      input.projectId,
      input.expectedRevision,
      input.jobId,
    );
  }
  selectIcon(input: Input<"selectIcon">) {
    return this.queue.selectIcon(
      input.projectId,
      input.expectedRevision,
      input.candidateKey,
      input.versionId,
    );
  }
  readIcon(input: Input<"readIcon">) {
    return this.queue.readIcon(
      input.projectId,
      input.candidateKey,
      input.versionId,
    );
  }
  async validate(input: Input<"validate">) {
    return domain.validateProject(
      await this.store.read(input.projectId),
      input.mode,
    );
  }
  exportPackage(input: Input<"exportPackage">) {
    return exportItemPackage({
      ...input,
      store: this.store,
      exportRoot: path.join(
        this.store.directory(input.projectId),
        input.kind === "draft" ? "review-bundle" : "exports",
      ),
    });
  }
  probe() {
    return this.runner.probe();
  }
  restorePrevious(input: Input<"restorePrevious">) {
    return this.store.restorePrevious(input.projectId);
  }
  hasActiveWork() {
    return this.queue.hasActiveWork();
  }
  shutdown() {
    return this.queue.shutdown();
  }
}
const project = { projectId: z.string().uuid() },
  revision = { ...project, expectedRevision: z.number().int().nonnegative() },
  candidateKey = z.string().uuid();
const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
export const fourTigerMethodSchemas = {
  list: z.undefined(),
  create: object({ name: z.string().trim().min(1).max(200) }),
  read: object(project),
  patchItem: object({ ...revision, candidateKey, patch: itemPatchSchema }),
  reviewItems: object({
    ...revision,
    candidateKeys: z.array(candidateKey).min(1).max(20),
    action: z.enum(reviewActions),
    note: z.string().max(12000),
  }),
  updatePolicies: object({
    ...revision,
    patch: policySchema.partial().strict(),
  }),
  adoptPolicies: object({
    ...revision,
    keys: z
      .array(
        z.enum(
          Object.keys(policySchema.shape) as [
            keyof typeof policySchema.shape,
            ...(keyof typeof policySchema.shape)[],
          ],
        ),
      )
      .min(1)
      .max(10),
  }),
  acknowledgeDescription: object({
    ...revision,
    candidateKey,
    regenerate: z.boolean(),
  }),
  repairReferenceIds: object(revision),
  updateIconStyle: object({ ...revision, style: z.string().min(1).max(6000) }),
  generateIcons: object({
    ...revision,
    candidateKeys: z.array(candidateKey).min(1).max(20),
  }),
  cancelPending: object(project),
  reconcile: object(project),
  abandonUnknown: object({ ...revision, jobId: z.string().uuid() }),
  selectIcon: object({
    ...revision,
    candidateKey,
    versionId: z.string().min(1).max(200),
  }),
  readIcon: object({
    ...project,
    candidateKey,
    versionId: z.string().min(1).max(200),
  }),
  validate: object({ ...project, mode: z.enum(["draft", "release"]) }),
  exportPackage: object({ ...revision, kind: z.enum(["draft", "release"]) }),
  probe: z.undefined(),
  restorePrevious: object(project),
} satisfies Record<keyof FourTigerItemsApi, z.ZodType>;
export async function executeFourTigerCall(
  service: FourTigerItemsService,
  method: string,
  input: unknown,
  trusted: boolean,
): Promise<unknown> {
  if (!trusted)
    throw new FourTigerError(
      "UNTRUSTED_SENDER",
      "이 요청은 허용되지 않습니다.",
    );
  if (
    !Object.hasOwn(fourTigerMethodSchemas, method) ||
    JSON.stringify(input ?? null).length > 256000
  )
    throw new FourTigerError("INVALID_INPUT", "올바르지 않은 요청입니다.");
  const key = method as keyof FourTigerItemsApi,
    parsed = fourTigerMethodSchemas[key].safeParse(input);
  if (!parsed.success)
    throw new FourTigerError(
      "INVALID_INPUT",
      "입력값과 필수 항목을 확인하세요.",
    );
  return (
    service[key] as (input: unknown) => Promise<SainGeomItemProject>
  ).call(service, parsed.data);
}
