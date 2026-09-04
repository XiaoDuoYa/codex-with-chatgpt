import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { TurnCapabilityBroker, type TurnLease } from "./turn-capability.js";
import { resolveProjectId } from "../workspace/identity.js";
import { Workspace } from "../workspace/manager.js";

const DEFAULT_MAX_WORKSPACES = 64;

export type WorkspaceRegistryErrorCode =
  | "INVALID_ROOT"
  | "INVALID_WORKSPACE_ID"
  | "INVALID_PROJECT_ID"
  | "INVALID_REGISTRATION_ID"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_STALE"
  | "PROJECT_ID_MISMATCH"
  | "REGISTRATION_ID_MISMATCH"
  | "WORKSPACE_ID_COLLISION"
  | "WORKSPACE_CAPACITY_EXCEEDED";

export class WorkspaceRegistryError extends Error {
  constructor(
    readonly code: WorkspaceRegistryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WorkspaceRegistryError";
  }
}

export interface WorkspaceRegistryOptions {
  maxWorkspaces?: number;
}

export interface WorkspaceRegistration {
  readonly workspace: Workspace;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly registrationId: string;
}

interface RootFingerprint {
  readonly device: bigint;
  readonly inode: bigint;
  readonly birthtimeNs: bigint;
}

interface WorkspaceEntry {
  readonly registration: WorkspaceRegistration;
  readonly root: string;
  readonly fingerprint: RootFingerprint;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkspaceRegistryError(
      "WORKSPACE_CAPACITY_EXCEEDED",
      "maxWorkspaces must be a positive safe integer"
    );
  }
  return value;
}

function requireId(
  value: unknown,
  label: "workspaceId" | "projectId" | "registrationId"
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    const code =
      label === "workspaceId"
        ? "INVALID_WORKSPACE_ID"
        : label === "projectId"
          ? "INVALID_PROJECT_ID"
          : "INVALID_REGISTRATION_ID";
    throw new WorkspaceRegistryError(code, `${label} is invalid`);
  }
  return value;
}

function canonicalDirectory(root: string): string {
  if (typeof root !== "string" || root.includes("\0")) {
    throw new WorkspaceRegistryError("INVALID_ROOT", "workspace root is invalid");
  }
  try {
    const real = fs.realpathSync.native(path.resolve(root));
    if (!fs.statSync(real).isDirectory()) {
      throw new WorkspaceRegistryError("INVALID_ROOT", "workspace root is not a directory");
    }
    return real;
  } catch (error) {
    if (error instanceof WorkspaceRegistryError) throw error;
    throw new WorkspaceRegistryError("INVALID_ROOT", "workspace root does not exist");
  }
}

function rootFingerprint(root: string): RootFingerprint {
  const stat = fs.statSync(root, { bigint: true });
  return {
    device: stat.dev,
    inode: stat.ino,
    birthtimeNs: stat.birthtimeNs,
  };
}

function sameFingerprint(left: RootFingerprint, right: RootFingerprint): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function newRegistrationId(): string {
  return `registration-${randomBytes(16).toString("hex")}`;
}

/**
 * Machine-local index of workspaces explicitly registered by the trusted
 * gateway control plane. Data-plane resolution always requires a live lease
 * issued by this registry's broker instance.
 */
export class WorkspaceRegistry {
  private readonly entries = new Map<string, WorkspaceEntry>();
  private readonly maxWorkspaces: number;

  constructor(
    private readonly broker: TurnCapabilityBroker,
    options: WorkspaceRegistryOptions = {}
  ) {
    this.maxWorkspaces = positiveLimit(options.maxWorkspaces, DEFAULT_MAX_WORKSPACES);
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Register a canonical local checkout. Callers must be trusted local control
   * code; model-supplied paths must never be forwarded to this method.
   */
  register(rootInput: string): WorkspaceRegistration {
    const root = canonicalDirectory(rootInput);
    const fingerprint = rootFingerprint(root);
    this.pruneStaleEntries();
    const existing = [...this.entries.values()].find((entry) =>
      sameFingerprint(entry.fingerprint, fingerprint)
    );
    if (existing) return existing.registration;
    if (this.entries.size >= this.maxWorkspaces) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_CAPACITY_EXCEEDED",
        "workspace registry capacity has been reached"
      );
    }

    const workspace = new Workspace(root);
    Object.freeze(workspace);
    const collision = this.entries.get(workspace.id);
    if (collision) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_ID_COLLISION",
        "workspace id is already registered for a different root"
      );
    }
    const registration = Object.freeze({
      workspace,
      workspaceId: workspace.id,
      projectId: workspace.projectId,
      registrationId: newRegistrationId(),
    });
    this.entries.set(workspace.id, {
      registration,
      root: workspace.root,
      fingerprint,
    });
    return registration;
  }

  /** Resolve a live, broker-issued lease without accepting a path or raw ids. */
  resolve(lease: TurnLease): Workspace {
    const verified = this.broker.validateLease(lease);
    const entry = this.requireCurrentEntry(
      verified.binding.workspaceId,
      verified.binding.projectId,
      verified.binding.registrationId
    );
    return entry.registration.workspace;
  }

  /** Remove only the exact registered checkout incarnation. */
  unregister(workspaceId: string, projectId: string, registrationId: string): boolean {
    const id = requireId(workspaceId, "workspaceId");
    const expectedProjectId = requireId(projectId, "projectId");
    const expectedRegistrationId = requireId(registrationId, "registrationId");
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.assertEntryBinding(entry, expectedProjectId, expectedRegistrationId);
    this.entries.delete(id);
    return true;
  }

  private requireCurrentEntry(
    workspaceId: string,
    projectId: string,
    registrationId: string
  ): WorkspaceEntry {
    const id = requireId(workspaceId, "workspaceId");
    const expectedProjectId = requireId(projectId, "projectId");
    const expectedRegistrationId = requireId(registrationId, "registrationId");
    const entry = this.entries.get(id);
    if (!entry) {
      throw new WorkspaceRegistryError("WORKSPACE_NOT_FOUND", "workspace is not registered");
    }
    if (!this.isCurrent(entry)) {
      this.entries.delete(id);
      throw new WorkspaceRegistryError("WORKSPACE_STALE", "registered workspace root has changed");
    }
    this.assertEntryBinding(entry, expectedProjectId, expectedRegistrationId);
    return entry;
  }

  private assertEntryBinding(
    entry: WorkspaceEntry,
    expectedProjectId: string,
    expectedRegistrationId: string
  ): void {
    if (entry.registration.projectId !== expectedProjectId) {
      throw new WorkspaceRegistryError(
        "PROJECT_ID_MISMATCH",
        "workspace project identity does not match the registered checkout"
      );
    }
    if (entry.registration.registrationId !== expectedRegistrationId) {
      throw new WorkspaceRegistryError(
        "REGISTRATION_ID_MISMATCH",
        "workspace registration identity does not match the current checkout incarnation"
      );
    }
  }

  private isCurrent(entry: WorkspaceEntry): boolean {
    try {
      const real = fs.realpathSync.native(entry.root);
      return (
        real === entry.root &&
        sameFingerprint(rootFingerprint(real), entry.fingerprint) &&
        resolveProjectId(real) === entry.registration.projectId
      );
    } catch {
      return false;
    }
  }

  private pruneStaleEntries(): void {
    for (const [workspaceId, entry] of this.entries) {
      if (!this.isCurrent(entry)) this.entries.delete(workspaceId);
    }
  }
}
