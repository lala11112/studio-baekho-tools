import { z } from "zod";

export const elements = ["wood", "fire", "earth", "metal", "water"] as const;
export const elementNames: Record<Element, string> = {
  wood: "목",
  fire: "화",
  earth: "토",
  metal: "금",
  water: "수",
};
export type Element = (typeof elements)[number];
export type Grade = 1 | 2 | 3 | 4;
export type ExportKind = "draft" | "release";
const text = z.string().max(12000);
const id = z.string().uuid();
const timestamp = z.string().datetime();
const finite = z.number().finite();
export const stats = [
  "maxHp",
  "maxSp",
  "spRegen",
  "normalDamage",
  "switchDamage",
  "dodgeSpCost",
  "switchSpCost",
] as const;
export const statNames: Record<EffectDraft["stat"], string> = {
  maxHp: "최대 HP",
  maxSp: "최대 SP",
  spRegen: "SP 재생",
  normalDamage: "일반 공격 피해",
  switchDamage: "전환 강화 스킬 피해",
  dodgeSpCost: "회피 SP 비용",
  switchSpCost: "전환 SP 비용",
};
export const effectSchema = z
  .object({
    stat: z.enum(stats),
    operation: z.enum(["addRatio", "add"]),
    amount: finite,
    unit: z.enum(["ratio", "SP", "SPPerSecond"]),
    trigger: z.enum(["whileOwned", "formSwitchSucceeded"]),
    targetForms: z.union([
      z.literal("all"),
      z
        .array(z.enum(elements))
        .min(1)
        .max(5)
        .refine((a) => new Set(a).size === a.length),
    ]),
    durationSeconds: finite.positive().nullable(),
    stackLimit: z.literal(1),
    refreshPolicy: z.literal("refresh"),
    removeOnItemLoss: z.literal(true),
  })
  .strict()
  .superRefine((e, ctx) => {
    const ratio = ["maxHp", "normalDamage", "switchDamage"].includes(e.stat);
    if (
      e.unit !==
        (ratio ? "ratio" : e.stat === "spRegen" ? "SPPerSecond" : "SP") ||
      e.operation !== (ratio ? "addRatio" : "add")
    )
      ctx.addIssue({
        code: "custom",
        message: "효과 단위와 연산이 일치하지 않습니다.",
      });
    if ((e.trigger === "whileOwned") !== (e.durationSeconds === null))
      ctx.addIssue({
        code: "custom",
        message:
          "보유 효과는 지속시간 없음, 성공 전환 효과는 양수 지속시간이 필요합니다.",
      });
  });
export type EffectDraft = z.infer<typeof effectSchema>;
export const policySchema = z
  .object({
    maxSpCap: finite.positive(),
    regenCap: finite.positive(),
    minDodgeCost: finite.nonnegative(),
    minSwitchCost: finite.nonnegative(),
    stacking: z.literal("additiveBySource"),
    sourceStackLimit: z.literal(1),
    timedRefresh: z.literal("refresh"),
    removeOnItemLoss: z.literal(true),
    refillOnMaxIncrease: z.literal(false),
    clampOnMaxDecrease: z.literal(true),
  })
  .strict();
export type PolicyValues = z.infer<typeof policySchema>;
export type PolicyKey = keyof PolicyValues;
export const defaultPolicies: PolicyValues = {
  maxSpCap: 200,
  regenCap: 40,
  minDodgeCost: 8,
  minSwitchCost: 4,
  stacking: "additiveBySource",
  sourceStackLimit: 1,
  timedRefresh: "refresh",
  removeOnItemLoss: true,
  refillOnMaxIncrease: false,
  clampOnMaxDecrease: true,
};
export const confirmedRules = {
  itemCount: 20,
  gradePrices: [20, 40, 80, 160],
  maxOwnedPerId: 1,
  baseMaxSp: 100,
  baseRegen: 20,
  regenDelaySeconds: 1,
  dodgeCost: 20,
  switchCost: 10,
  switchCooldownSeconds: 2,
} as const;
const confirmedSchema = z
  .object({
    itemCount: z.literal(20),
    gradePrices: z.tuple([
      z.literal(20),
      z.literal(40),
      z.literal(80),
      z.literal(160),
    ]),
    maxOwnedPerId: z.literal(1),
    baseMaxSp: z.literal(100),
    baseRegen: z.literal(20),
    regenDelaySeconds: z.literal(1),
    dodgeCost: z.literal(20),
    switchCost: z.literal(10),
    switchCooldownSeconds: z.literal(2),
  })
  .strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const iconVersionSchema = z
  .object({
    versionId: z.string().min(1),
    jobId: z.string().min(1),
    contentRevision: z.number().int().positive(),
    promptHash: hash,
    sourcePath: text,
    thumbnailPath: text,
    sourceSha256: hash,
    thumbnailSha256: hash,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    hasAlpha: z.literal(true),
    prompt: text,
    tool: z.literal("imagegen"),
    observedModel: text.nullable(),
    createdAt: timestamp,
  })
  .strict();
export type IconVersion = z.infer<typeof iconVersionSchema>;
export const reviewActions = [
  "reviewData",
  "reviewIcon",
  "adopt",
  "hold",
  "reset",
] as const;
export type ReviewAction = (typeof reviewActions)[number];
const reviewSchema = z
  .object({
    state: z.enum(["draft", "reviewed", "adopted", "held"]),
    dataRevision: z.number().int().nullable(),
    iconVersion: text.nullable(),
    iconContentRevision: z.number().int().nullable(),
    policyRevision: z.number().int().nullable(),
    note: text,
    updatedAt: timestamp,
  })
  .strict();
export type ItemReview = z.infer<typeof reviewSchema>;
const editableShape = {
  itemId: z.string().max(64),
  name: z.string().max(200),
  description: text,
  element: z.enum(elements),
  grade: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  effects: z.array(effectSchema).max(20),
  unsupportedEffectNotes: text,
  synergyTags: z.array(z.string().max(100)).max(20),
  iconPrompt: text,
};
export const itemPatchSchema = z.object(editableShape).partial().strict();
export type ItemPatch = z.infer<typeof itemPatchSchema>;
export const itemSchema = z
  .object({
    ...editableShape,
    candidateKey: id,
    purchasePrice: z.number().int(),
    descriptionStale: z.boolean(),
    iconKey: text,
    icons: z.array(iconVersionSchema).max(500),
    selectedIconVersion: text.nullable(),
    contentRevision: z.number().int().positive(),
    review: reviewSchema,
  })
  .strict();
export type ItemDraft = z.infer<typeof itemSchema>;
export const jobSchema = z
  .object({
    jobId: id,
    candidateKey: id,
    contentRevision: z.number().int().positive(),
    prompt: text,
    promptHash: hash,
    status: z.enum([
      "queued",
      "running",
      "generated",
      "validated",
      "reviewed",
      "failed",
      "interrupted",
      "unknown",
      "cancelled",
    ]),
    attempt: z.number().int().positive(),
    resultPath: text.nullable(),
    error: text.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export type GenerationJob = z.infer<typeof jobSchema>;
export const projectSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: id,
    name: z.string().max(200),
    revision: z.number().int().nonnegative(),
    createdAt: timestamp,
    updatedAt: timestamp,
    sourceRefs: z.array(
      z
        .object({
          repository: text,
          branch: text,
          commit: hash.or(z.string().regex(/^[a-f0-9]{40}$/)),
          document: text,
          status: z.enum(["confirmed", "proposal", "implementation"]),
        })
        .strict(),
    ),
    items: z.array(itemSchema).max(100),
    ruleProfile: z
      .object({
        confirmed: confirmedSchema,
        proposed: policySchema,
        revision: z.number().int().positive(),
        adoptions: z.record(
          z.string(),
          z.object({ revision: z.number().int(), at: timestamp }).strict(),
        ),
      })
      .strict(),
    iconStyle: text,
    jobs: z.array(jobSchema).max(10000),
    reviewHistory: z.array(
      z
        .object({
          candidateKey: id.nullable(),
          action: text,
          at: timestamp,
          note: text,
          contentRevision: z.number().int(),
          policyRevision: z.number().int(),
        })
        .strict(),
    ),
    synergyReferences: z.array(
      z
        .object({
          id: text,
          items: z.array(
            z
              .object({ candidateKey: id, itemId: text, originalId: text })
              .strict(),
          ),
        })
        .strict(),
    ),
    exports: z.array(
      z
        .object({
          exportId: id,
          kind: z.enum(["draft", "release"]),
          revision: z.number().int(),
          relativeDirectory: text,
          createdAt: timestamp,
        })
        .strict(),
    ),
  })
  .strict();
export type SainGeomItemProject = z.infer<typeof projectSchema>;
export type ValidationIssue = {
  code: string;
  severity: "error" | "warning";
  candidateKey: string | null;
  field: string;
  message: string;
};
export type ValidationReport = {
  projectId: string;
  revision: number;
  mode: ExportKind;
  issues: ValidationIssue[];
  canExport: boolean;
};
export type SpPreview = {
  maxSp: number;
  regenPerSecond: number;
  dodgeCost: number;
  switchCost: number;
  proposal: true;
};
export function previewSp(
  project: SainGeomItemProject,
  form: Element,
  timedBuffs: boolean,
): SpPreview {
  const sum = (stat: EffectDraft["stat"]) =>
    project.items
      .flatMap((i) => i.effects)
      .filter(
        (e) =>
          e.stat === stat &&
          (e.trigger === "whileOwned" || timedBuffs) &&
          (e.targetForms === "all" || e.targetForms.includes(form)),
      )
      .reduce((n, e) => n + e.amount, 0);
  const p = project.ruleProfile.proposed;
  return {
    maxSp: Math.min(p.maxSpCap, 100 + sum("maxSp")),
    regenPerSecond: Math.min(p.regenCap, 20 + sum("spRegen")),
    dodgeCost: Math.max(p.minDodgeCost, 20 + sum("dodgeSpCost")),
    switchCost: Math.max(p.minSwitchCost, 10 + sum("switchSpCost")),
    proposal: true,
  };
}
export type ExportReceipt = {
  exportId: string;
  kind: ExportKind;
  projectId: string;
  revision: number;
  directory: string;
  files: { path: string; sha256: string }[];
  createdAt: string;
};
export type ProjectSummary = {
  projectId: string;
  name: string;
  revision: number;
  updatedAt: string;
  total: number;
  validatedIcons: number;
  adopted: number;
  pendingJobs: number;
  failedJobs: number;
  exports: SainGeomItemProject["exports"];
  readError: string | null;
};
export class FourTigerError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "FourTigerError";
  }
}
export type ProjectInput = { projectId: string };
export type RevisionInput = ProjectInput & { expectedRevision: number };
export type ProbeResult = {
  available: boolean;
  authenticated: boolean;
  message: string;
};
export interface FourTigerItemsApi {
  list(): Promise<ProjectSummary[]>;
  create(input: { name: string }): Promise<SainGeomItemProject>;
  read(input: ProjectInput): Promise<SainGeomItemProject>;
  patchItem(
    input: RevisionInput & { candidateKey: string; patch: ItemPatch },
  ): Promise<SainGeomItemProject>;
  reviewItems(
    input: RevisionInput & {
      candidateKeys: string[];
      action: ReviewAction;
      note: string;
    },
  ): Promise<SainGeomItemProject>;
  updatePolicies(
    input: RevisionInput & { patch: Partial<PolicyValues> },
  ): Promise<SainGeomItemProject>;
  adoptPolicies(
    input: RevisionInput & { keys: PolicyKey[] },
  ): Promise<SainGeomItemProject>;
  acknowledgeDescription(
    input: RevisionInput & { candidateKey: string; regenerate: boolean },
  ): Promise<SainGeomItemProject>;
  repairReferenceIds(input: RevisionInput): Promise<SainGeomItemProject>;
  updateIconStyle(
    input: RevisionInput & { style: string },
  ): Promise<SainGeomItemProject>;
  generateIcons(
    input: RevisionInput & { candidateKeys: string[] },
  ): Promise<SainGeomItemProject>;
  cancelPending(input: ProjectInput): Promise<SainGeomItemProject>;
  reconcile(input: ProjectInput): Promise<SainGeomItemProject>;
  selectIcon(
    input: RevisionInput & { candidateKey: string; versionId: string },
  ): Promise<SainGeomItemProject>;
  readIcon(
    input: ProjectInput & { candidateKey: string; versionId: string },
  ): Promise<string>;
  validate(
    input: ProjectInput & { mode: ExportKind },
  ): Promise<ValidationReport>;
  exportPackage(
    input: RevisionInput & { kind: ExportKind },
  ): Promise<ExportReceipt>;
  probe(): Promise<ProbeResult>;
  restorePrevious(input: ProjectInput): Promise<SainGeomItemProject>;
}
declare global {
  interface Window {
    fourTigerItems: FourTigerItemsApi;
  }
}
