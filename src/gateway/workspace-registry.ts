import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { ensureDir, getStateDir, writeSecureJson } from "../config/paths.js";
import { C2C_ID_PATTERN } from "../control/result-schema.js";
import { TurnCapabilityBroker, type TurnLease } from "./turn-capability.js";
import { projectIdMetadataPath } from "../workspace/identity.js";
import { runGit } from "../workspace/git.js";
import { Workspace } from "../workspace/manager.js";

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
  | "WORKSPACE_STATUS_UNCERTAIN"
  | "INVALID_MEMBERSHIP_STATE";

export class WorkspaceRegistryError extends Error {
  constructor(
    readonly code: WorkspaceRegistryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WorkspaceRegistryError";
  }
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
  readonly projectMetadataFile: string | null;
  readonly fingerprint: RootFingerprint;
}

interface WorkspaceMembership {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly root: string;
  readonly projectMetadataFile: string | null;
  readonly fingerprint: RootFingerprint;
}

type WorkspaceMembershipStatus = "current" | "stale" | "uncertain";

const MACHINE_STATE_DIRECTORY = "machine-state";
const WORKSPACE_MEMBERSHIP_FILE = "workspace-membership.json";
const MAX_MEMBERSHIP_STATE_BYTES = 16 * 1024 * 1024;
const decimalBigIntSchema = z.string().regex(/^\d+$/);
const workspaceStorageIdSchema = z.string().regex(/^[a-f0-9]{12}$/);
const projectStorageIdSchema = z.string().regex(/^(?:git|path)-[a-f0-9]{32}$/);
const workspaceMembershipStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    pendingProjectRemovals: z.array(projectStorageIdSchema).optional().default([]),
    checkouts: z.array(
      z
        .object({
          workspaceId: workspaceStorageIdSchema,
          projectId: projectStorageIdSchema,
          root: z.string(),
          projectMetadataFile: z.string().nullable(),
          fingerprint: z
            .object({
              device: decimalBigIntSchema,
              inode: decimalBigIntSchema,
              birthtimeNs: decimalBigIntSchema,
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict();

function invalidMembershipState(message: string): WorkspaceRegistryError {
  return new WorkspaceRegistryError("INVALID_MEMBERSHIP_STATE", message);
}

function machineWorkspaceMembershipDirectory(): string {
  const root = path.resolve(getStateDir());
  ensureDir(root);
  const rootStat = fs.lstatSync(root);
  if (
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    fs.realpathSync.native(root) !== root
  ) {
    throw invalidMembershipState("machine state root must be a real directory");
  }
  try {
    fs.chmodSync(root, 0o700);
  } catch {
    // Best effort on filesystems without chmod semantics.
  }

  const directory = path.join(root, MACHINE_STATE_DIRECTORY);
  ensureDir(directory);
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(directory) !== directory) {
    throw invalidMembershipState("machine workspace membership directory must be a real directory");
  }
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best effort on filesystems without chmod semantics.
  }
  return directory;
}

export function machineWorkspaceMembershipFile(): string {
  return path.join(machineWorkspaceMembershipDirectory(), WORKSPACE_MEMBERSHIP_FILE);
}

function serializedMembershipState(
  memberships: ReadonlyMap<string, WorkspaceMembership>,
  pendingProjectRemovals: ReadonlySet<string> = new Set(),
) {
  const state: {
    schemaVersion: 1;
    checkouts: ReturnType<typeof serializedMembershipStateCheckouts>;
    pendingProjectRemovals?: string[];
  } = {
    schemaVersion: 1 as const,
    checkouts: serializedMembershipStateCheckouts(memberships),
  };
  const pending = [...pendingProjectRemovals].sort();
  if (pending.length > 0) state.pendingProjectRemovals = pending;
  return state;
}

function serializedMembershipStateCheckouts(memberships: ReadonlyMap<string, WorkspaceMembership>) {
  return [...memberships.values()]
      .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId))
      .map((membership) => ({
        workspaceId: membership.workspaceId,
        projectId: membership.projectId,
        root: membership.root,
        projectMetadataFile: membership.projectMetadataFile,
        fingerprint: {
          device: membership.fingerprint.device.toString(),
          inode: membership.fingerprint.inode.toString(),
          birthtimeNs: membership.fingerprint.birthtimeNs.toString(),
        },
      }));
}

interface LoadedMembershipState {
  memberships: Map<string, WorkspaceMembership>;
  pendingProjectRemovals: Set<string>;
}

function loadMemberships(file: string | undefined): LoadedMembershipState {
  if (!file || !fs.existsSync(file)) {
    return { memberships: new Map(), pendingProjectRemovals: new Set() };
  }
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_MEMBERSHIP_STATE_BYTES) {
      throw invalidMembershipState("machine workspace membership state is not a bounded regular file");
    }
    const parsed = workspaceMembershipStateSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    const memberships = new Map<string, WorkspaceMembership>();
    const pendingProjectRemovals = new Set(parsed.pendingProjectRemovals);
    if (pendingProjectRemovals.size !== parsed.pendingProjectRemovals.length) {
      throw invalidMembershipState("machine workspace membership contains duplicate pending project removals");
    }
    const fingerprints = new Set<string>();
    for (const value of parsed.checkouts) {
      const workspaceId = requireId(value.workspaceId, "workspaceId");
      const projectId = requireId(value.projectId, "projectId");
      if (
        value.root.length === 0 ||
        value.root.length > 4_096 ||
        value.root.includes("\0") ||
        !path.isAbsolute(value.root) ||
        path.normalize(value.root) !== value.root
      ) {
        throw invalidMembershipState("machine workspace membership root is invalid");
      }
      const derivedWorkspaceId = createHash("sha256").update(value.root).digest("hex").slice(0, 12);
      if (workspaceId !== derivedWorkspaceId) {
        throw invalidMembershipState("machine workspace membership id does not match its root");
      }
      const expectsGitMetadata = projectId.startsWith("git-");
      if (
        (expectsGitMetadata && value.projectMetadataFile === null) ||
        (!expectsGitMetadata && value.projectMetadataFile !== null) ||
        (value.projectMetadataFile !== null &&
          (value.projectMetadataFile.length === 0 ||
            value.projectMetadataFile.length > 4_096 ||
            value.projectMetadataFile.includes("\0") ||
            !path.isAbsolute(value.projectMetadataFile) ||
            path.normalize(value.projectMetadataFile) !== value.projectMetadataFile ||
            path.basename(value.projectMetadataFile) !== "c2c-project-id"))
      ) {
        throw invalidMembershipState("machine workspace membership project metadata is invalid");
      }
      if (memberships.has(workspaceId)) {
        throw invalidMembershipState("machine workspace membership contains a duplicate workspace id");
      }
      const fingerprint = {
        device: BigInt(value.fingerprint.device),
        inode: BigInt(value.fingerprint.inode),
        birthtimeNs: BigInt(value.fingerprint.birthtimeNs),
      };
      const fingerprintKey = `${fingerprint.device}:${fingerprint.inode}:${fingerprint.birthtimeNs}`;
      if (fingerprints.has(fingerprintKey)) {
        throw invalidMembershipState("machine workspace membership contains a duplicate checkout");
      }
      fingerprints.add(fingerprintKey);
      memberships.set(workspaceId, {
        workspaceId,
        projectId,
        root: value.root,
        projectMetadataFile: value.projectMetadataFile,
        fingerprint,
      });
    }
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Best effort on filesystems without chmod semantics.
    }
    return { memberships, pendingProjectRemovals };
  } catch (error) {
    if (
      error instanceof WorkspaceRegistryError &&
      error.code === "INVALID_MEMBERSHIP_STATE"
    ) {
      throw error;
    }
    throw invalidMembershipState("machine workspace membership state is malformed");
  }
}

export type WorkspaceRemovalCallback = (
  projectId: string,
  hasRemainingProjectCheckout: boolean,
) => void;

function requireId(
  value: unknown,
  label: "workspaceId" | "projectId" | "registrationId"
): string {
  if (
    typeof value !== "string" ||
    !C2C_ID_PATTERN.test(value)
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

function sameMembership(left: WorkspaceMembership, right: WorkspaceMembership): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.root === right.root &&
    left.projectMetadataFile === right.projectMetadataFile &&
    sameFingerprint(left.fingerprint, right.fingerprint)
  );
}

function pathIsDefinitelyMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function currentGitProjectMetadataPath(root: string): string | null | undefined {
  let probe;
  try {
    probe = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return undefined;
  }
  if (probe.ok && probe.stdout.trim() === "true") {
    try {
      return projectIdMetadataPath(root) ?? undefined;
    } catch {
      return undefined;
    }
  }
  if (!probe.ok && !/not a git repository|outside a repository/i.test(probe.stderr)) {
    return undefined;
  }
  return null;
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
  private readonly memberships: Map<string, WorkspaceMembership>;
  private readonly pendingProjectRemovals: Set<string>;

  constructor(
    private readonly broker: TurnCapabilityBroker,
    private readonly onRemoved?: WorkspaceRemovalCallback,
    private readonly membershipFile?: string,
  ) {
    const loaded = loadMemberships(membershipFile);
    this.memberships = loaded.memberships;
    this.pendingProjectRemovals = loaded.pendingProjectRemovals;
    this.drainPendingProjectRemovals();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Whether any live checkout for the stable project identity remains. */
  hasProject(projectId: string): boolean {
    const expectedProjectId = requireId(projectId, "projectId");
    this.pruneStaleEntries();
    return [...this.memberships.values()].some(
      (membership) => membership.projectId === expectedProjectId,
    );
  }

  /**
   * Register a canonical local checkout. Callers must be trusted local control
   * code; model-supplied paths must never be forwarded to this method.
   */
  register(rootInput: string): WorkspaceRegistration {
    const root = canonicalDirectory(rootInput);
    const fingerprint = rootFingerprint(root);
    const workspace = new Workspace(root);
    Object.freeze(workspace);
    const projectMetadataFile = workspace.projectId.startsWith("git-")
      ? projectIdMetadataPath(root)
      : null;
    if (workspace.projectId.startsWith("git-") && projectMetadataFile === null) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_STATUS_UNCERTAIN",
        "workspace Git project identity could not be revalidated",
      );
    }
    const membership: WorkspaceMembership = {
      workspaceId: workspace.id,
      projectId: workspace.projectId,
      root: workspace.root,
      projectMetadataFile,
      fingerprint,
    };
    this.reconcileMemberships(membership);
    const existing = [...this.entries.values()].find((entry) =>
      sameFingerprint(entry.fingerprint, fingerprint)
    );
    if (existing) return existing.registration;

    const collision = this.entries.get(workspace.id);
    if (collision) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_ID_COLLISION",
        "workspace id is already registered for a different root",
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
      projectMetadataFile,
      fingerprint,
    });
    return registration;
  }

  /**
   * Validate an owner-control-plane registration and return its immutable
   * record. The checkout is revalidated before the record is released so a
   * replaced root or changed project identity cannot be reused.
   */
  lookup(
    workspaceId: string,
    projectId: string,
    registrationId: string
  ): WorkspaceRegistration {
    return this.requireCurrentEntry(workspaceId, projectId, registrationId).registration;
  }

  /** Resolve a live, broker-issued lease without accepting a path or raw ids. */
  resolve(lease: TurnLease): Workspace {
    const verified = this.broker.validateLease(lease);
    return this.lookup(
      verified.binding.workspaceId,
      verified.binding.projectId,
      verified.binding.registrationId
    ).workspace;
  }

  /** Remove only the exact registered checkout incarnation. */
  unregister(workspaceId: string, projectId: string, registrationId: string): boolean {
    const id = requireId(workspaceId, "workspaceId");
    const expectedProjectId = requireId(projectId, "projectId");
    const expectedRegistrationId = requireId(registrationId, "registrationId");
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.assertEntryBinding(entry, expectedProjectId, expectedRegistrationId);
    this.removeEntries([entry]);
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
    const status = this.entryStatus(entry);
    if (status === "stale") {
      this.removeEntries([entry]);
      throw new WorkspaceRegistryError("WORKSPACE_STALE", "registered workspace root has changed");
    }
    if (status === "uncertain") {
      throw new WorkspaceRegistryError(
        "WORKSPACE_STATUS_UNCERTAIN",
        "registered workspace identity could not be revalidated",
      );
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

  private entryStatus(entry: WorkspaceEntry): WorkspaceMembershipStatus {
    return this.membershipStatus({
      workspaceId: entry.registration.workspaceId,
      projectId: entry.registration.projectId,
      root: entry.root,
      projectMetadataFile: entry.projectMetadataFile,
      fingerprint: entry.fingerprint,
    });
  }

  private membershipStatus(membership: WorkspaceMembership): WorkspaceMembershipStatus {
    let real: string;
    try {
      real = fs.realpathSync.native(membership.root);
    } catch (error) {
      return pathIsDefinitelyMissing(error) ? "stale" : "uncertain";
    }
    if (real !== membership.root) return "stale";
    try {
      if (!sameFingerprint(rootFingerprint(real), membership.fingerprint)) return "stale";
    } catch (error) {
      return pathIsDefinitelyMissing(error) ? "stale" : "uncertain";
    }

    // Re-resolve Git's common directory on every validation. A checkout can
    // change from non-Git to Git, or its .git file can be retargeted, without
    // changing the checkout directory's inode. In either case the old
    // registration must fail closed instead of inheriting a new project.
    const currentProjectMetadataFile = currentGitProjectMetadataPath(real);
    if (currentProjectMetadataFile === undefined) return "uncertain";
    if (currentProjectMetadataFile !== membership.projectMetadataFile) return "stale";
    if (membership.projectMetadataFile === null) return "current";
    let metadataStat: fs.Stats;
    try {
      metadataStat = fs.lstatSync(membership.projectMetadataFile);
    } catch (error) {
      return pathIsDefinitelyMissing(error) ? "stale" : "uncertain";
    }
    if (metadataStat.isSymbolicLink() || !metadataStat.isFile()) return "stale";
    try {
      if (fs.realpathSync.native(membership.projectMetadataFile) !== membership.projectMetadataFile) {
        return "stale";
      }
      const parsed = JSON.parse(fs.readFileSync(membership.projectMetadataFile, "utf8")) as unknown;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.keys(parsed).sort().join("\0") !== "projectId\0version"
      ) {
        return "stale";
      }
      const metadata = parsed as { version?: unknown; projectId?: unknown };
      return metadata.version === 1 && metadata.projectId === membership.projectId
        ? "current"
        : "stale";
    } catch (error) {
      if (error instanceof SyntaxError) return "stale";
      return pathIsDefinitelyMissing(error) ? "stale" : "uncertain";
    }
  }

  private pruneStaleEntries(): void {
    this.reconcileMemberships();
  }

  /**
   * Remove exact registrations and any stale registrations observed during the
   * same lifecycle operation. Capabilities are revoked before the callback,
   * and each affected project is notified only once after the final valid
   * checkout has been determined.
   */
  private removeEntries(entries: readonly WorkspaceEntry[]): void {
    this.reconcileMemberships(undefined, entries);
  }

  private reconcileMemberships(
    candidate?: WorkspaceMembership,
    explicitEntries: readonly WorkspaceEntry[] = [],
  ): void {
    const removedProjects = new Set<string>();
    const removedIds = new Set<string>();
    for (const entry of explicitEntries) {
      const workspaceId = entry.registration.workspaceId;
      const current = this.entries.get(workspaceId);
      if (current !== entry) continue;
      removedIds.add(workspaceId);
      removedProjects.add(entry.registration.projectId);
    }

    for (const [workspaceId, entry] of this.entries) {
      if (removedIds.has(workspaceId) || this.entryStatus(entry) !== "stale") continue;
      removedIds.add(workspaceId);
      removedProjects.add(entry.registration.projectId);
    }

    const nextMemberships = new Map(this.memberships);
    const membershipStatuses = new Map<string, WorkspaceMembershipStatus>();
    for (const [workspaceId, membership] of this.memberships) {
      const status = this.membershipStatus(membership);
      membershipStatuses.set(workspaceId, status);
      if (removedIds.has(workspaceId) || status === "stale") {
        nextMemberships.delete(workspaceId);
        removedIds.add(workspaceId);
        removedProjects.add(membership.projectId);
      }
    }

    if (candidate) {
      const collision = nextMemberships.get(candidate.workspaceId);
      if (collision && !sameMembership(collision, candidate)) {
        const pathWorkspacePromotedToGit =
          collision.root === candidate.root &&
          sameFingerprint(collision.fingerprint, candidate.fingerprint) &&
          collision.projectMetadataFile === null &&
          candidate.projectMetadataFile !== null;
        if (!pathWorkspacePromotedToGit) {
          const code = membershipStatuses.get(candidate.workspaceId) === "uncertain"
            ? "WORKSPACE_STATUS_UNCERTAIN"
            : "WORKSPACE_ID_COLLISION";
          throw new WorkspaceRegistryError(
            code,
            "workspace id is already persisted for a different project identity",
          );
        }
        nextMemberships.delete(candidate.workspaceId);
        removedIds.add(candidate.workspaceId);
        removedProjects.add(collision.projectId);
      }
      const fingerprintCollision = [...nextMemberships.values()].find(
        (membership) =>
          membership.workspaceId !== candidate.workspaceId &&
          sameFingerprint(membership.fingerprint, candidate.fingerprint),
      );
      if (fingerprintCollision) {
        throw new WorkspaceRegistryError(
          "WORKSPACE_ID_COLLISION",
          "checkout fingerprint is already persisted for a different workspace",
        );
      }
      nextMemberships.set(candidate.workspaceId, candidate);
    }

    const emptiedProjects = [...removedProjects].filter(
      (projectId) => ![...nextMemberships.values()].some(
        (membership) => membership.projectId === projectId,
      ),
    );

    // Keep cleanup intent in the same durable membership commit. The machine
    // surface is cleaned only after this commit succeeds; if the process dies
    // before cleanup, the pending project removal is replayed on restart.
    const nextPendingProjectRemovals = new Set(this.pendingProjectRemovals);
    for (const projectId of nextPendingProjectRemovals) {
      if ([...nextMemberships.values()].some((membership) => membership.projectId === projectId)) {
        nextPendingProjectRemovals.delete(projectId);
      }
    }
    for (const projectId of emptiedProjects) nextPendingProjectRemovals.add(projectId);

    if (removedIds.size === 0 && !candidate && nextPendingProjectRemovals.size === this.pendingProjectRemovals.size) {
      return;
    }
    this.commitMemberships(nextMemberships, nextPendingProjectRemovals);

    for (const workspaceId of removedIds) {
      const entry = this.entries.get(workspaceId);
      if (!entry) continue;
      this.entries.delete(workspaceId);
      this.broker.revokeRegistration(
        entry.registration.workspaceId,
        entry.registration.projectId,
        entry.registration.registrationId,
      );
    }
    this.drainPendingProjectRemovals();
  }

  private commitMemberships(
    next: Map<string, WorkspaceMembership>,
    pendingProjectRemovals: ReadonlySet<string> = this.pendingProjectRemovals,
  ): void {
    if (this.membershipFile) {
      writeSecureJson(this.membershipFile, serializedMembershipState(next, pendingProjectRemovals));
    }
    this.memberships.clear();
    for (const [workspaceId, membership] of next) {
      this.memberships.set(workspaceId, membership);
    }
    this.pendingProjectRemovals.clear();
    for (const projectId of pendingProjectRemovals) this.pendingProjectRemovals.add(projectId);
  }

  private drainPendingProjectRemovals(): void {
    if (!this.onRemoved || this.pendingProjectRemovals.size === 0) return;
    const nextPendingProjectRemovals = new Set(this.pendingProjectRemovals);
    for (const projectId of this.pendingProjectRemovals) {
      if ([...this.memberships.values()].some((membership) => membership.projectId === projectId)) {
        nextPendingProjectRemovals.delete(projectId);
        continue;
      }
      this.onRemoved(projectId, false);
      nextPendingProjectRemovals.delete(projectId);
    }
    if (nextPendingProjectRemovals.size !== this.pendingProjectRemovals.size) {
      this.commitMemberships(this.memberships, nextPendingProjectRemovals);
    }
  }
}
