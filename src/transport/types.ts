import type { TaskSnapshot } from "../protocol/types.js";

export type TransportKind = "mcp" | "github";

export interface TransportDescriptor {
  kind: TransportKind;
  locator: Record<string, string>;
  capabilities: {
    directRead: boolean;
    requiresManualRelay: boolean;
  };
}

export interface PrepareTransportInput {
  workspaceRoot: string;
  tunnel?: boolean;
  pairing?: boolean;
  snapshot?: TaskSnapshot;
}

export interface PublishTransportInput {
  workspaceRoot: string;
  workspaceId?: string;
  snapshot?: TaskSnapshot;
  taskId: string;
  iteration: number;
  changedFiles: string[];
  tests: string | null;
  exitStatus: string;
  notes?: string;
}

export interface TransportStatusInput {
  workspaceRoot: string;
}

export interface TransportDoctorInput {
  workspaceRoot: string;
}

export interface TransportReceipt {
  ok: boolean;
  kind: TransportKind;
  locator?: Record<string, string>;
  [key: string]: unknown;
}

export interface TransportStatus {
  ok: boolean;
  kind: TransportKind;
  available: boolean;
  detail?: string;
  [key: string]: unknown;
}

export interface DoctorResult {
  ok: boolean;
  kind: TransportKind;
  checks: Record<string, { ok: boolean; detail?: string }>;
}

export interface C2CTransport {
  readonly kind: TransportKind;
  prepare(input: PrepareTransportInput): Promise<TransportReceipt>;
  publish(input: PublishTransportInput): Promise<TransportReceipt>;
  status(input: TransportStatusInput): Promise<TransportStatus>;
  doctor(input: TransportDoctorInput): Promise<DoctorResult>;
}
