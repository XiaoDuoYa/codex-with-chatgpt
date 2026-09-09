import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { Workspace } from "../workspace/manager.js";

/**
 * A workspace lease is created by the local Codex process when it starts work
 * in a directory. The public MCP endpoint can only resolve leased workspaces;
 * it never accepts a filesystem path from a remote caller.
 */
export interface WorkspaceLease {
  workspaceId: string;
  workspaceRoot: string;
  workspaceName: string;
  attachedAt: string;
  lastSeenAt: string;
  expiresAt: number;
}

interface PersistedRegistry {
  leases: WorkspaceLease[];
  activeWorkspaceId?: string;
}

export class GatewayWorkspaceError extends Error {
  constructor(
    public code:
      | "WORKSPACE_NOT_ATTACHED"
      | "NO_ACTIVE_WORKSPACE"
      | "WORKSPACE_EXPIRED"
      | "WORKSPACE_NOT_ACTIVE",
    message: string
  ) {
    super(message);
    this.name = "GatewayWorkspaceError";
  }
}

const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

function registryFile(): string {
  return path.join(ensureDir(path.join(getStateDir(), "gateway")), "workspaces.json");
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * In-memory workspace map with an automatically refreshed, short-lived lease.
 * Persisting the lease is useful for diagnostics and process handoff, but
 * expired leases are discarded on load so a restart never grants stale access.
 */
export class WorkspaceRegistry {
  private readonly leases = new Map<string, WorkspaceLease>();
  private readonly workspaces = new Map<string, Workspace>();
  private activeWorkspaceId: string | null = null;
  private readonly file: string;
  private readonly leaseTtlMs: number;

  constructor(opts: { file?: string; leaseTtlMs?: number } = {}) {
    this.file = opts.file ?? registryFile();
    this.leaseTtlMs = Math.max(60_000, opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
    this.load();
  }

  private load(): void {
    const state = readJsonIfExists<PersistedRegistry>(this.file);
    if (!state) return;
    const now = Date.now();
    for (const lease of state.leases ?? []) {
      if (!lease || typeof lease.workspaceId !== "string" || lease.expiresAt <= now) continue;
      // Do not eagerly instantiate or trust a persisted path. A local attach
      // refreshes the lease and validates the root before it becomes usable.
      this.leases.set(lease.workspaceId, lease);
    }
    if (state.activeWorkspaceId && this.leases.has(state.activeWorkspaceId)) {
      this.activeWorkspaceId = state.activeWorkspaceId;
    }
    this.prune(false);
  }

  private save(): void {
    this.prune(false);
    const state: PersistedRegistry = {
      leases: [...this.leases.values()],
      activeWorkspaceId: this.activeWorkspaceId ?? undefined,
    };
    writeSecureJson(this.file, state);
  }

  private prune(save = true): void {
    const now = Date.now();
    let changed = false;
    for (const [id, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        this.leases.delete(id);
        this.workspaces.delete(id);
        changed = true;
      }
    }
    if (this.activeWorkspaceId && !this.leases.has(this.activeWorkspaceId)) {
      this.activeWorkspaceId = null;
      changed = true;
    }
    if (changed && save) this.save();
  }

  /** Attach or refresh the workspace selected by the local Codex process. */
  attach(rootInput: string): { workspace: Workspace; lease: WorkspaceLease; created: boolean } {
    const workspace = new Workspace(rootInput);
    const previous = this.leases.get(workspace.id);
    const now = Date.now();
    const lease: WorkspaceLease = {
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      workspaceName: workspace.name,
      attachedAt: previous?.attachedAt ?? nowIso(),
      lastSeenAt: nowIso(),
      expiresAt: now + this.leaseTtlMs,
    };
    this.leases.set(workspace.id, lease);
    this.workspaces.set(workspace.id, workspace);
    this.activeWorkspaceId = workspace.id;
    this.save();
    return { workspace, lease, created: !previous };
  }

  /** Refresh a lease only after the root has been attached locally. */
  touch(workspaceId: string): Workspace {
    const workspace = this.resolve(workspaceId);
    const lease = this.leases.get(workspaceId);
    if (lease) {
      lease.lastSeenAt = nowIso();
      lease.expiresAt = Date.now() + this.leaseTtlMs;
      this.save();
    }
    return workspace;
  }

  resolve(workspaceId?: string): Workspace {
    this.prune();
    const requestedId = workspaceId?.trim();
    const id = requestedId || this.activeWorkspaceId;
    if (!id) throw new GatewayWorkspaceError("NO_ACTIVE_WORKSPACE", "No active workspace is attached.");
    const lease = this.leases.get(id);
    if (!lease) {
      throw new GatewayWorkspaceError("WORKSPACE_NOT_ATTACHED", "The requested workspace is not attached.");
    }
    if (requestedId && requestedId !== this.activeWorkspaceId) {
      throw new GatewayWorkspaceError(
        "WORKSPACE_NOT_ACTIVE",
        "The requested workspace is attached but not active; attach or activate it locally first."
      );
    }
    if (lease.expiresAt <= Date.now()) {
      this.leases.delete(id);
      this.workspaces.delete(id);
      if (this.activeWorkspaceId === id) this.activeWorkspaceId = null;
      this.save();
      throw new GatewayWorkspaceError("WORKSPACE_EXPIRED", "The workspace lease has expired; attach it again.");
    }
    const workspace = this.workspaces.get(id);
    if (!workspace) {
      throw new GatewayWorkspaceError("WORKSPACE_NOT_ATTACHED", "The workspace must be re-attached after the Gateway restarted.");
    }
    // An MCP call is proof that the local context is still in use. Refresh the
    // lease so long-running reviews do not expire midway through a task.
    lease.lastSeenAt = nowIso();
    lease.expiresAt = Date.now() + this.leaseTtlMs;
    this.save();
    return workspace;
  }

  setActive(workspaceId: string): Workspace {
    this.prune();
    const lease = this.leases.get(workspaceId);
    const workspace = lease ? this.workspaces.get(workspaceId) : undefined;
    if (!lease || !workspace) {
      throw new GatewayWorkspaceError("WORKSPACE_NOT_ATTACHED", "The requested workspace is not attached.");
    }
    this.activeWorkspaceId = workspaceId;
    lease.lastSeenAt = nowIso();
    lease.expiresAt = Date.now() + this.leaseTtlMs;
    this.save();
    return workspace;
  }

  active(): Workspace {
    return this.resolve();
  }

  list(): WorkspaceLease[] {
    this.prune();
    return [...this.leases.values()].map((lease) => ({ ...lease }));
  }

  getActiveId(): string | null {
    this.prune();
    return this.activeWorkspaceId;
  }

  detach(workspaceId: string): boolean {
    const existed = this.leases.delete(workspaceId);
    this.workspaces.delete(workspaceId);
    if (this.activeWorkspaceId === workspaceId) {
      const next = [...this.leases.keys()].at(-1) ?? null;
      this.activeWorkspaceId = next;
    }
    if (existed) this.save();
    return existed;
  }
}

export function gatewayRegistryFile(): string {
  return registryFile();
}
