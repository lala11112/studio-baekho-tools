import type { GraphicsFile } from './graphics';

export type ExternalRigOperation = 'prepare' | 'inspect-return' | 'import-return';
export type RigHandoffState = 'preparing' | 'awaiting-external' | 'inspecting' | 'review' | 'blocked' | 'failed' | 'cancelled';
export type ExternalRigCheck = { id: string; passed: boolean; message?: string };
export type ExternalRigReport = {
  schemaVersion: 1; operation: ExternalRigOperation; status: 'complete' | 'blocked';
  sourceSha256: string; requestSha256: string;
  files: { role: string; path: string; sha256: string }[];
  checks: ExternalRigCheck[];
  error?: string;
  scene?: unknown; correspondence?: unknown; contract?: unknown;
};
/** Durable local workflow record. External application operation always remains manual. */
export type RigHandoff = {
  schemaVersion: 1; handoffId: string; sourceVersionId: string; sourceSha256: string;
  operation: ExternalRigOperation; state: RigHandoffState; updatedAt: string;
  requestSha256?: string; reportPath?: string; reportSha256?: string;
  files: GraphicsFile[]; error?: string;
};
export type ExternalRigProvenance = {
  schemaVersion: 1; handoffId: string; sourceVersionId: string; sourceSha256: string;
  reportPath: string; reportSha256: string; returnedFbxSha256?: string;
  contract?: unknown;
};

export type ExternalRigWorkspaceHandoff = {
 id: string; objectId: string; sourceVersionId: string; source: GraphicsFile; requiredParts: string[];
 state: RigHandoffState; operation: ExternalRigOperation; createdAt: string; updatedAt: string;
 preparation?: RigHandoff; inspection?: RigHandoff; imported?: RigHandoff;
 sourceToReturnedMatrix?: number[][]; returnedFbx?: GraphicsFile; candidateVersionId?: string; error?: string;
 humanBones?: import('./graphics-rig').HumanBoneBinding[]; fingers?: boolean;
};
export type ExternalRigAction =
 | { kind: 'prepare-external-rig'; objectId: string; versionId: string }
 | { kind: 'inspect-external-rig'; objectId: string; handoffId: string; returnedPath: string; sourceToReturnedMatrix?: number[][] }
 | { kind: 'import-external-rig'; objectId: string; handoffId: string; humanBones: import('./graphics-rig').HumanBoneBinding[]; fingers: boolean }
 | { kind: 'recover-external-rig' | 'cancel-external-rig'; objectId: string; handoffId: string };
