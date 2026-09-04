import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  C2C_ID_PATTERN,
} from "../control/result-schema.js";
import {
  ensureDir,
  getStateDir,
  getProjectDataDir,
  readJsonIfExists,
  withFileLock,
  writeSecureJson,
} from "../config/paths.js";
import {
  clearSessionRoute,
  reconcileSessionRoute,
  normalizeChatUrl,
  normalizeProjectUrl,
  projectIdFromChatUrl,
  projectIdFromUrl,
  retireSession,
  type SavedSession,
} from "./state.js";

const SURFACE_STATE_VERSION = 1;
const MACHINE_SURFACE_STATE_VERSION = 3;
const DEFAULT_LEASE_TTL_MS = 2 * 60 * 1000;
const PROCESS_EPOCH = `pid-${process.pid}-${randomBytes(16).toString("hex")}`;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type SurfaceOwnershipErrorCode =
  | "SURFACE_ALREADY_OWNED"
  | "SURFACE_BOUND_TO_ANOTHER_SESSION"
  | "SESSION_ALREADY_OWNED"
  | "PROJECT_BINDING_CONFLICT"
  | "STALE_SURFACE_GENERATION"
  | "LEASE_NOT_FOUND"
  | "INVALID_SURFACE_OWNERSHIP_STATE";

export class SurfaceOwnershipError extends Error {
  constructor(
    readonly code: SurfaceOwnershipErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SurfaceOwnershipError";
  }
}

/**
 * The browser/surface identity is deliberately separate from the ChatGPT
 * URLs. A URL can move or gain a display slug; a tab identity must not move
 * between local sessions.
 */
export interface SurfaceLease {
  projectId: string;
  localSessionId: string;
  browserId: string;
  surfaceId: string;
  tabId: string;
  projectUrl: string;
  /** Missing while the lease is a Project collection candidate. */
  chatUrl?: string;
  generation: number;
  leaseExpiresAt: string;
  ownerProcessEpoch: string;
  ownerPid: number;
  claimedAt: string;
  updatedAt: string;
}

export type SurfaceLeaseRef = Pick<
  SurfaceLease,
  | "projectId"
  | "localSessionId"
  | "browserId"
  | "surfaceId"
  | "tabId"
  | "generation"
  | "ownerProcessEpoch"
>;

export interface ClaimSurfaceOptions {
  projectId: string;
  localSessionId: string;
  browserId: string;
  surfaceId: string;
  tabId: string;
  projectUrl: string;
  /** Optional until ChatGPT creates the first conversation in the Project. */
  chatUrl?: string;
  /** Optional process identity for a daemon or a test simulating a restart. */
  ownerProcessEpoch?: string;
  /** Exact live lease being rotated. Required while this session still owns another page. */
  replaces?: SurfaceLeaseRef;
  leaseTtlMs?: number;
  now?: Date;
}

export interface RenewSurfaceOptions {
  lease: SurfaceLeaseRef;
  leaseTtlMs?: number;
  now?: Date;
}

export interface SurfaceBinding {
  readonly browserId: string;
  readonly surfaceId: string;
  readonly tabId: string;
  readonly projectId: string;
  readonly localSessionId: string;
  readonly lastGeneration: number;
  readonly projectUrl: string;
  readonly chatUrl: string;
  readonly boundAt: string;
  readonly updatedAt: string;
}

export interface CommitVerifiedSurfaceRouteOptions {
  lease: SurfaceLeaseRef;
  /** Checkout identity for the durable local session route. */
  workspaceId: string;
  chatUrl?: string;
  connectorName?: string;
  now?: Date;
}

export interface VerifiedSurfaceRouteCommit {
  binding: SurfaceBinding;
  session: SavedSession;
}

export interface RetireSurfaceSessionOptions {
  projectId: string;
  workspaceId: string;
  localSessionId: string;
}

export interface RetireSurfaceSessionResult {
  retired: boolean;
  removedLeases: number;
  removedBindings: number;
  removedSession: boolean;
}

export interface ReconcileSurfaceSessionRouteOptions {
  projectId: string;
  workspaceId: string;
  localSessionId: string;
}

interface SurfaceOwnershipState {
  schemaVersion: 1;
  leases: SurfaceLease[];
  bindings: SurfaceBinding[];
  generations: Record<string, number>;
}

/**
 * Cross-workspace ownership is kept in machine state. Project-local files
 * remain useful for routing and recovery, but they are never authoritative
 * for a URL or physical browser page that can be shared by workspaces.
 */
interface MachineSurfaceOwnershipState {
  schemaVersion: 3;
  initializedProjects: string[];
  /** Projects explicitly removed from the machine registry. */
  authoritativelyAbsentProjects?: string[];
  /** Stable local-project to ChatGPT Project association. */
  projectUrls: Record<string, string>;
  leases: SurfaceLease[];
  bindings: SurfaceBinding[];
  /** Next globally unique surface generation. It is never reused. */
  nextGeneration: number;
  /** Current generations for sessions that still have a lease or binding. */
  generations: Record<string, number>;
}

const MACHINE_SURFACE_STATE_DIRECTORY = "machine-state";
const MACHINE_SURFACE_STATE_FILE = "surface-ownership.json";
const MACHINE_SURFACE_LOCK_FILE = "surface-ownership.lock";
const MACHINE_SURFACE_LEGACY_SCHEMA_VERSIONS = new Set([1, 2]);
export const CHATGPT_BROWSER_ID = "iab" as const;
export const CHATGPT_SURFACE_ID = "chatgpt" as const;

function machineStateDirectory(): string {
  const root = path.resolve(getStateDir());
  ensureDir(root);
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      "machine state root must be a real directory",
    );
  }
  try {
    fs.chmodSync(root, 0o700);
  } catch {
    // Best effort on filesystems without chmod semantics.
  }
  const directory = path.join(root, MACHINE_SURFACE_STATE_DIRECTORY);
  ensureDir(directory);
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync.native(directory) !== directory) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      "machine surface state directory must be a real directory",
    );
  }
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best effort on filesystems without chmod semantics.
  }
  return directory;
}

export function machineSurfaceOwnershipFile(): string {
  return path.join(machineStateDirectory(), MACHINE_SURFACE_STATE_FILE);
}

function machineSurfaceOwnershipLockFile(): string {
  return path.join(machineStateDirectory(), MACHINE_SURFACE_LOCK_FILE);
}

function emptyMachineSurfaceOwnershipState(): MachineSurfaceOwnershipState {
  return {
    schemaVersion: MACHINE_SURFACE_STATE_VERSION,
    initializedProjects: [],
    projectUrls: {},
    leases: [],
    bindings: [],
    nextGeneration: 1,
    generations: {},
  };
}

function absentProjects(state: MachineSurfaceOwnershipState): string[] {
  return state.authoritativelyAbsentProjects ?? [];
}

function serializedMachineSurfaceState(state: MachineSurfaceOwnershipState): Record<string, unknown> {
  const serialized: Record<string, unknown> = { ...state };
  const absent = absentProjects(state);
  if (absent.length > 0) serialized.authoritativelyAbsentProjects = [...absent];
  else delete serialized.authoritativelyAbsentProjects;
  return serialized;
}

/**
 * Older machine indexes cannot be imported safely because their ownership
 * semantics predate the current generation and Project URL authority. Keep a
 * recoverable copy, then rebuild only this index; all old routes must be
 * claimed and verified again. Unknown versions never enter this path.
 */
function rebuildLegacyMachineSurfaceState(
  file: string,
  schemaVersion: number,
): MachineSurfaceOwnershipState {
  const backup = path.join(
    path.dirname(file),
    `${MACHINE_SURFACE_STATE_FILE}.legacy-v${schemaVersion}.${Date.now()}-${randomBytes(8).toString("hex")}.bak`,
  );
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  try {
    fs.chmodSync(backup, 0o600);
  } catch {
    // Best effort on filesystems without chmod semantics.
  }
  try {
    const state = emptyMachineSurfaceOwnershipState();
    writeSecureJson(file, state);
    return state;
  } catch (error) {
    // The original file remains in place when the atomic rebuild fails. The
    // backup is intentionally retained to aid recovery and diagnosis.
    throw error;
  }
}

function stateDirectory(projectId: string): string {
  return ensureDir(path.join(getProjectDataDir(safeId(projectId, "project id")), "surface-ownership"));
}

export function surfaceOwnershipFile(projectId: string): string {
  return path.join(stateDirectory(projectId), "state.json");
}

function surfaceOwnershipLockFile(projectId: string): string {
  return path.join(stateDirectory(projectId), "state.lock");
}

export function currentOwnerProcessEpoch(): string {
  return PROCESS_EPOCH;
}

function safeId(value: string, label: string): string {
  if (typeof value !== "string" || !C2C_ID_PATTERN.test(value)) {
    throw new SurfaceOwnershipError("INVALID_SURFACE_OWNERSHIP_STATE", `${label} must be a safe identifier`);
  }
  return value;
}

export function assertChatGPTSurfaceIdentity(browserId: string, surfaceId: string): void {
  if (browserId !== CHATGPT_BROWSER_ID || surfaceId !== CHATGPT_SURFACE_ID) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      `ChatGPT surface must use browserId '${CHATGPT_BROWSER_ID}' and surfaceId '${CHATGPT_SURFACE_ID}'`,
    );
  }
}

function safeEpoch(value: string): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 200 || !C2C_ID_PATTERN.test(value)) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      "owner process epoch must be a safe identifier"
    );
  }
  return value;
}

function canonicalProjectUrl(value: string): string {
  const normalized = normalizeProjectUrl(value);
  if (!normalized) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      "project URL must identify a ChatGPT Project"
    );
  }
  return normalized;
}

function canonicalChatUrl(value: string): string {
  const normalized = normalizeChatUrl(value);
  if (!normalized) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      "chat URL must identify a ChatGPT conversation"
    );
  }
  return normalized;
}

function timestamp(value: Date | string): string {
  const result = typeof value === "string" ? value : value.toISOString();
  if (!ISO_TIMESTAMP.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new SurfaceOwnershipError("INVALID_SURFACE_OWNERSHIP_STATE", "timestamp is invalid");
  }
  return result;
}

function nowDate(value?: Date): Date {
  const result = value ?? new Date();
  if (!(result instanceof Date) || !Number.isFinite(result.getTime())) {
    throw new SurfaceOwnershipError("INVALID_SURFACE_OWNERSHIP_STATE", "now must be a valid Date");
  }
  return result;
}

function leaseTtl(value: number | undefined): number {
  const result = value ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isInteger(result) || result < 1_000 || result > 24 * 60 * 60 * 1000) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      "lease TTL must be an integer between 1000ms and 24h"
    );
  }
  return result;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      `${label} contains unknown fields`
    );
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SurfaceOwnershipError("INVALID_SURFACE_OWNERSHIP_STATE", `${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function storedString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new SurfaceOwnershipError("INVALID_SURFACE_OWNERSHIP_STATE", `${label} is invalid`);
  }
  return value;
}

function storedGeneration(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new SurfaceOwnershipError("INVALID_SURFACE_OWNERSHIP_STATE", `${label} is invalid`);
  }
  return value as number;
}

function storedPid(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new SurfaceOwnershipError("INVALID_SURFACE_OWNERSHIP_STATE", "owner PID is invalid");
  }
  return value as number;
}

function parseLease(value: unknown): SurfaceLease {
  const raw = record(value, "surface lease");
  assertOnlyKeys(
    raw,
    [
      "projectId",
      "localSessionId",
      "browserId",
      "surfaceId",
      "tabId",
      "projectUrl",
      "chatUrl",
      "generation",
      "leaseExpiresAt",
      "ownerProcessEpoch",
      "ownerPid",
      "claimedAt",
      "updatedAt",
    ],
    "surface lease"
  );
  const projectId = safeId(storedString(raw.projectId, "lease project id"), "lease project id");
  const localSessionId = safeId(
    storedString(raw.localSessionId, "lease local session id"),
    "lease local session id"
  );
  const browserId = safeId(storedString(raw.browserId, "lease browser id"), "lease browser id");
  const surfaceId = safeId(storedString(raw.surfaceId, "lease surface id"), "lease surface id");
  assertChatGPTSurfaceIdentity(browserId, surfaceId);
  const tabId = safeId(storedString(raw.tabId, "lease tab id"), "lease tab id");
  const projectUrl = canonicalProjectUrl(storedString(raw.projectUrl, "lease project URL"));
  const chatUrl = raw.chatUrl === undefined
    ? undefined
    : canonicalChatUrl(storedString(raw.chatUrl, "lease chat URL"));
  const generation = storedGeneration(raw.generation, "lease generation");
  const leaseExpiresAt = timestamp(storedString(raw.leaseExpiresAt, "lease expiry"));
  const ownerProcessEpoch = safeEpoch(storedString(raw.ownerProcessEpoch, "owner process epoch"));
  const ownerPid = storedPid(raw.ownerPid);
  const claimedAt = timestamp(storedString(raw.claimedAt, "lease claimed timestamp"));
  const updatedAt = timestamp(storedString(raw.updatedAt, "lease updated timestamp"));
  if (Date.parse(leaseExpiresAt) <= Date.parse(claimedAt)) {
    throw new SurfaceOwnershipError("INVALID_SURFACE_OWNERSHIP_STATE", "lease expiry must follow claim time");
  }
  return {
    projectId,
    localSessionId,
    browserId,
    surfaceId,
    tabId,
    projectUrl,
    chatUrl,
    generation,
    leaseExpiresAt,
    ownerProcessEpoch,
    ownerPid,
    claimedAt,
    updatedAt,
  };
}

function parseBinding(value: unknown): SurfaceBinding {
  const raw = record(value, "surface binding");
  assertOnlyKeys(
    raw,
    [
      "browserId",
      "surfaceId",
      "tabId",
      "projectId",
      "localSessionId",
      "lastGeneration",
      "projectUrl",
      "chatUrl",
      "boundAt",
      "updatedAt",
    ],
    "surface binding"
  );
  const browserId = safeId(storedString(raw.browserId, "binding browser id"), "binding browser id");
  const surfaceId = safeId(storedString(raw.surfaceId, "binding surface id"), "binding surface id");
  assertChatGPTSurfaceIdentity(browserId, surfaceId);
  return {
    browserId,
    surfaceId,
    tabId: safeId(storedString(raw.tabId, "binding tab id"), "binding tab id"),
    projectId: safeId(storedString(raw.projectId, "binding project id"), "binding project id"),
    localSessionId: safeId(
      storedString(raw.localSessionId, "binding local session id"),
      "binding local session id"
    ),
    lastGeneration: storedGeneration(raw.lastGeneration, "binding generation"),
    projectUrl: canonicalProjectUrl(storedString(raw.projectUrl, "binding project URL")),
    chatUrl: canonicalChatUrl(storedString(raw.chatUrl, "binding chat URL")),
    boundAt: timestamp(storedString(raw.boundAt, "binding timestamp")),
    updatedAt: timestamp(storedString(raw.updatedAt, "binding update timestamp")),
  };
}

/**
 * Legacy machine indexes predate the single in-app-browser surface.  Keep
 * their parser separate from the v3 parser: an old index may contain a
 * surface identifier that was valid at the time, but it must still satisfy
 * the same strict record shape and ownership relationships before it is
 * quarantined.
 */
function parseLegacyLease(value: unknown): SurfaceLease {
  const raw = record(value, "legacy surface lease");
  assertOnlyKeys(
    raw,
    [
      "projectId",
      "localSessionId",
      "browserId",
      "surfaceId",
      "tabId",
      "projectUrl",
      "chatUrl",
      "generation",
      "leaseExpiresAt",
      "ownerProcessEpoch",
      "ownerPid",
      "claimedAt",
      "updatedAt",
    ],
    "legacy surface lease",
  );
  const projectId = safeId(storedString(raw.projectId, "legacy lease project id"), "legacy lease project id");
  const localSessionId = safeId(
    storedString(raw.localSessionId, "legacy lease local session id"),
    "legacy lease local session id",
  );
  const browserId = safeId(storedString(raw.browserId, "legacy lease browser id"), "legacy lease browser id");
  const surfaceId = safeId(storedString(raw.surfaceId, "legacy lease surface id"), "legacy lease surface id");
  const tabId = safeId(storedString(raw.tabId, "legacy lease tab id"), "legacy lease tab id");
  const projectUrl = canonicalProjectUrl(storedString(raw.projectUrl, "legacy lease project URL"));
  const chatUrl = raw.chatUrl === undefined
    ? undefined
    : canonicalChatUrl(storedString(raw.chatUrl, "legacy lease chat URL"));
  const generation = storedGeneration(raw.generation, "legacy lease generation");
  const leaseExpiresAt = timestamp(storedString(raw.leaseExpiresAt, "legacy lease expiry"));
  const ownerProcessEpoch = safeEpoch(storedString(raw.ownerProcessEpoch, "legacy owner process epoch"));
  const ownerPid = storedPid(raw.ownerPid);
  const claimedAt = timestamp(storedString(raw.claimedAt, "legacy lease claimed timestamp"));
  const updatedAt = timestamp(storedString(raw.updatedAt, "legacy lease updated timestamp"));
  if (Date.parse(leaseExpiresAt) <= Date.parse(claimedAt)) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      "legacy lease expiry must follow claim time",
    );
  }
  return {
    projectId,
    localSessionId,
    browserId,
    surfaceId,
    tabId,
    projectUrl,
    chatUrl,
    generation,
    leaseExpiresAt,
    ownerProcessEpoch,
    ownerPid,
    claimedAt,
    updatedAt,
  };
}

function parseLegacyBinding(value: unknown): SurfaceBinding {
  const raw = record(value, "legacy surface binding");
  assertOnlyKeys(
    raw,
    [
      "browserId",
      "surfaceId",
      "tabId",
      "projectId",
      "localSessionId",
      "lastGeneration",
      "projectUrl",
      "chatUrl",
      "boundAt",
      "updatedAt",
    ],
    "legacy surface binding",
  );
  return {
    browserId: safeId(storedString(raw.browserId, "legacy binding browser id"), "legacy binding browser id"),
    surfaceId: safeId(storedString(raw.surfaceId, "legacy binding surface id"), "legacy binding surface id"),
    tabId: safeId(storedString(raw.tabId, "legacy binding tab id"), "legacy binding tab id"),
    projectId: safeId(storedString(raw.projectId, "legacy binding project id"), "legacy binding project id"),
    localSessionId: safeId(
      storedString(raw.localSessionId, "legacy binding local session id"),
      "legacy binding local session id",
    ),
    lastGeneration: storedGeneration(raw.lastGeneration, "legacy binding generation"),
    projectUrl: canonicalProjectUrl(storedString(raw.projectUrl, "legacy binding project URL")),
    chatUrl: canonicalChatUrl(storedString(raw.chatUrl, "legacy binding chat URL")),
    boundAt: timestamp(storedString(raw.boundAt, "legacy binding timestamp")),
    updatedAt: timestamp(storedString(raw.updatedAt, "legacy binding update timestamp")),
  };
}

function assertChatBelongsToProject(projectUrl: string, chatUrl: string | undefined, label: string): void {
  if (chatUrl && projectIdFromChatUrl(chatUrl) !== projectIdFromUrl(projectUrl)) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      `${label} chat URL does not belong to its Project URL`,
    );
  }
}

function entryGeneration(entry: SurfaceLease | SurfaceBinding): number {
  return "generation" in entry ? entry.generation : entry.lastGeneration;
}

interface OwnershipRelationInput {
  leases: SurfaceLease[];
  bindings: SurfaceBinding[];
  generations: Record<string, number>;
  nextGeneration?: number;
  label: string;
}

/** Validate relationships shared by the legacy and v3 machine indexes. */
function assertOwnershipRelations(input: OwnershipRelationInput): void {
  const { leases, bindings, generations, nextGeneration, label } = input;
  const allEntries = [...leases, ...bindings];
  const pageOwners = new Map<string, string>();
  const chatOwners = new Map<string, string>();
  const sessionLeases = new Map<string, SurfaceLease>();
  const sessionBindings = new Map<string, SurfaceBinding>();
  let greatestStoredGeneration = 0;

  for (const entry of allEntries) {
    const owner = sessionKey(entry.projectId, entry.localSessionId);
    const page = pageKey(entry.browserId, entry.surfaceId, entry.tabId);
    const existingPageOwner = pageOwners.get(page);
    if (existingPageOwner !== undefined && existingPageOwner !== owner) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        `${label} maps one browser page to multiple sessions`,
      );
    }
    pageOwners.set(page, owner);

    if (entry.chatUrl !== undefined) {
      assertChatBelongsToProject(entry.projectUrl, entry.chatUrl, label);
      const existingChatOwner = chatOwners.get(entry.chatUrl);
      if (existingChatOwner !== undefined && existingChatOwner !== owner) {
        throw new SurfaceOwnershipError(
          "INVALID_SURFACE_OWNERSHIP_STATE",
          `${label} maps one ChatGPT chat to multiple sessions`,
        );
      }
      chatOwners.set(entry.chatUrl, owner);
    }

    const generation = entryGeneration(entry);
    greatestStoredGeneration = Math.max(greatestStoredGeneration, generation);
    if ("generation" in entry) {
      if (sessionLeases.has(owner)) {
        throw new SurfaceOwnershipError(
          "INVALID_SURFACE_OWNERSHIP_STATE",
          `${label} contains multiple leases for one session`,
        );
      }
      sessionLeases.set(owner, entry);
    } else {
      if (sessionBindings.has(owner)) {
        throw new SurfaceOwnershipError(
          "INVALID_SURFACE_OWNERSHIP_STATE",
          `${label} contains multiple bindings for one session`,
        );
      }
      sessionBindings.set(owner, entry);
    }
  }

  for (const [owner, generation] of Object.entries(generations)) {
    greatestStoredGeneration = Math.max(greatestStoredGeneration, generation);
    const lease = sessionLeases.get(owner);
    const binding = sessionBindings.get(owner);
    if (!lease && !binding) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        `${label} generation belongs to a session without an ownership record`,
      );
    }
    const expectedGeneration = Math.max(
      lease?.generation ?? 0,
      binding?.lastGeneration ?? 0,
    );
    if (generation !== expectedGeneration) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        `${label} generation does not match its ownership record`,
      );
    }
  }

  for (const owner of new Set([...sessionLeases.keys(), ...sessionBindings.keys()])) {
    if (generations[owner] === undefined) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        `${label} ownership record is missing its generation record`,
      );
    }
  }

  for (const [owner, lease] of sessionLeases) {
    const binding = sessionBindings.get(owner);
    if (binding) {
      if (lease.projectUrl !== binding.projectUrl || lease.projectId !== binding.projectId) {
        throw new SurfaceOwnershipError(
          "INVALID_SURFACE_OWNERSHIP_STATE",
          `${label} lease and binding disagree about their Project`,
        );
      }
      if (lease.generation < binding.lastGeneration) {
        throw new SurfaceOwnershipError(
          "INVALID_SURFACE_OWNERSHIP_STATE",
          `${label} lease is older than its persistent binding`,
        );
      }
      if (lease.generation === binding.lastGeneration &&
          (pageKey(lease.browserId, lease.surfaceId, lease.tabId) !==
            pageKey(binding.browserId, binding.surfaceId, binding.tabId) ||
            lease.chatUrl !== binding.chatUrl)) {
        throw new SurfaceOwnershipError(
          "INVALID_SURFACE_OWNERSHIP_STATE",
          `${label} lease and binding disagree at the same generation`,
        );
      }
    }
  }

  if (nextGeneration !== undefined && nextGeneration <= greatestStoredGeneration) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      `${label} next generation must strictly follow every stored generation`,
    );
  }
}

/**
 * Validate a legacy index before preserving it as evidence. Legacy entries
 * are never imported, but accepting an arbitrary object here would still
 * allow an attacker to make the gateway quarantine and replace a file that
 * was never a valid ownership index.
 */
function validateLegacyMachineSurfaceState(
  value: Record<string, unknown>,
  schemaVersion: number,
): void {
  assertOnlyKeys(
    value,
    ["schemaVersion", "initializedProjects", "leases", "bindings", "generations", "nextGeneration"],
    "legacy machine surface ownership state",
  );
  if (
    value.schemaVersion !== schemaVersion ||
    !Array.isArray(value.initializedProjects) ||
    !Array.isArray(value.leases) ||
    !Array.isArray(value.bindings) ||
    !value.generations ||
    typeof value.generations !== "object" ||
    Array.isArray(value.generations) ||
    (value.nextGeneration !== undefined &&
      (!Number.isSafeInteger(value.nextGeneration) || (value.nextGeneration as number) < 1))
  ) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      "legacy machine surface ownership state is malformed",
    );
  }

  const initializedProjects = value.initializedProjects.map((projectId) =>
    safeId(storedString(projectId, "legacy initialized project id"), "legacy initialized project id"),
  );
  if (new Set(initializedProjects).size !== initializedProjects.length) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      "legacy machine initialized project ids must be unique",
    );
  }

  const rawGenerations = record(value.generations, "legacy machine surface generations");
  const generations: Record<string, number> = {};
  for (const [key, generation] of Object.entries(rawGenerations)) {
    const keyParts = key.split("\u0000");
    if (keyParts.length !== 2 || !keyParts.every((part) => C2C_ID_PATTERN.test(part))) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        "legacy machine surface generation key is invalid",
      );
    }
    if (!initializedProjects.includes(keyParts[0]!)) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        "legacy machine surface generation belongs to an uninitialized project",
      );
    }
    generations[key] = storedGeneration(generation, "legacy machine surface generation");
  }

  const leases = value.leases.map(parseLegacyLease);
  const bindings = value.bindings.map(parseLegacyBinding);
  if ([...leases, ...bindings].some((entry) => !initializedProjects.includes(entry.projectId))) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      "legacy machine surface ownership entry belongs to an uninitialized project",
    );
  }
  const projectUrls = new Map<string, string>();
  const urlProjects = new Map<string, string>();
  for (const entry of [...leases, ...bindings]) {
    const existingUrl = projectUrls.get(entry.projectId);
    if (existingUrl !== undefined && existingUrl !== entry.projectUrl) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        "legacy machine surface ownership binds one local project to multiple Projects",
      );
    }
    const existingProject = urlProjects.get(entry.projectUrl);
    if (existingProject !== undefined && existingProject !== entry.projectId) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        "legacy machine surface ownership binds one Project to multiple local projects",
      );
    }
    projectUrls.set(entry.projectId, entry.projectUrl);
    urlProjects.set(entry.projectUrl, entry.projectId);
  }
  assertOwnershipRelations({
    leases,
    bindings,
    generations,
    nextGeneration: value.nextGeneration as number | undefined,
    label: "legacy machine surface ownership state",
  });
}

function readMachineState(): MachineSurfaceOwnershipState {
  const file = machineSurfaceOwnershipFile();
  const raw = readJsonIfExists<unknown>(file);
  if (raw === null) {
    if (fs.existsSync(file)) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        "machine surface ownership state is malformed",
      );
    }
    return emptyMachineSurfaceOwnershipState();
  }
  const value = record(raw, "machine surface ownership state");
  if (
    typeof value.schemaVersion === "number" &&
    MACHINE_SURFACE_LEGACY_SCHEMA_VERSIONS.has(value.schemaVersion)
  ) {
    validateLegacyMachineSurfaceState(value, value.schemaVersion);
    return rebuildLegacyMachineSurfaceState(file, value.schemaVersion);
  }
  assertOnlyKeys(
    value,
    [
      "schemaVersion",
      "initializedProjects",
      "authoritativelyAbsentProjects",
      "projectUrls",
      "leases",
      "bindings",
      "nextGeneration",
      "generations",
    ],
    "machine surface ownership state",
  );
  if (
    value.schemaVersion !== MACHINE_SURFACE_STATE_VERSION ||
    !Array.isArray(value.initializedProjects) ||
    (value.authoritativelyAbsentProjects !== undefined && !Array.isArray(value.authoritativelyAbsentProjects)) ||
    !value.projectUrls ||
    typeof value.projectUrls !== "object" ||
    Array.isArray(value.projectUrls) ||
    !Array.isArray(value.leases) ||
    !Array.isArray(value.bindings) ||
    !Number.isSafeInteger(value.nextGeneration) ||
    (value.nextGeneration as number) < 1 ||
    !value.generations ||
    typeof value.generations !== "object" ||
    Array.isArray(value.generations)
  ) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      "machine surface ownership state version is invalid",
    );
  }
  const rawGenerations = record(value.generations, "machine surface generations");
  const generations: Record<string, number> = {};
  for (const [key, generation] of Object.entries(rawGenerations)) {
    const keyParts = key.split("\u0000");
    if (keyParts.length !== 2 || !keyParts.every((part) => C2C_ID_PATTERN.test(part))) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        "machine surface generation key is invalid",
      );
    }
    generations[key] = storedGeneration(generation, "machine surface generation");
  }
  const rawProjectUrls = record(value.projectUrls, "machine project URLs");
  const projectUrls: Record<string, string> = {};
  for (const [projectId, projectUrl] of Object.entries(rawProjectUrls)) {
    const normalizedProjectId = safeId(projectId, "machine project URL project id");
    projectUrls[normalizedProjectId] = canonicalProjectUrl(
      storedString(projectUrl, "machine project URL"),
    );
  }
  const state: MachineSurfaceOwnershipState = {
    schemaVersion: MACHINE_SURFACE_STATE_VERSION,
    initializedProjects: value.initializedProjects.map((projectId) => safeId(
      storedString(projectId, "machine initialized project id"),
      "machine initialized project id",
    )),
    ...(value.authoritativelyAbsentProjects === undefined
      ? {}
      : {
          authoritativelyAbsentProjects: value.authoritativelyAbsentProjects.map((projectId) => safeId(
            storedString(projectId, "machine absent project id"),
            "machine absent project id",
          )),
        }),
    projectUrls,
    leases: value.leases.map(parseLease),
    bindings: value.bindings.map(parseBinding),
    nextGeneration: value.nextGeneration as number,
    generations,
  };
  if (new Set(state.initializedProjects).size !== state.initializedProjects.length) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      "machine initialized project ids must be unique",
    );
  }
  const absent = absentProjects(state);
  if (new Set(absent).size !== absent.length) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      "machine absent project ids must be unique",
    );
  }
  if (absent.some((projectId) => state.initializedProjects.includes(projectId))) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      "machine project cannot be both initialized and absent",
    );
  }
  if (Object.keys(state.projectUrls).some((projectId) => absent.includes(projectId))) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      "machine absent project cannot have a Project URL",
    );
  }
  if (Object.keys(state.projectUrls).some((projectId) => !state.initializedProjects.includes(projectId))) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      "machine project URL belongs to an uninitialized project",
    );
  }
  if ([...state.leases, ...state.bindings].some((entry) => !state.initializedProjects.includes(entry.projectId))) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      "machine surface ownership entry belongs to an uninitialized project",
    );
  }
  for (const key of Object.keys(state.generations)) {
    const [projectId] = key.split("\u0000");
    if (!state.initializedProjects.includes(projectId)) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        "machine surface generation belongs to an uninitialized project",
      );
    }
    if (![...state.leases, ...state.bindings].some(
      (entry) => sessionKey(entry.projectId, entry.localSessionId) === key,
    )) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        "machine surface generation belongs to a retired session",
      );
    }
  }
  assertMachineOwnershipConsistency(state);
  return state;
}

function assertMachineOwnershipConsistency(state: MachineSurfaceOwnershipState): void {
  const absent = absentProjects(state);
  if (absent.some((projectId) => state.initializedProjects.includes(projectId))) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      "machine project cannot be both initialized and absent",
    );
  }
  const projectToUrl = new Map<string, string>(Object.entries(state.projectUrls));
  const urlToProject = new Map<string, string>();
  for (const [projectId, projectUrl] of Object.entries(state.projectUrls)) {
    const existingProject = urlToProject.get(projectUrl);
    if (existingProject && existingProject !== projectId) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        "machine project URL is already bound to a different local project",
      );
    }
    urlToProject.set(projectUrl, projectId);
  }
  for (const entry of [...state.leases, ...state.bindings]) {
    if (absent.includes(entry.projectId)) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        "machine absent project cannot own a surface",
      );
    }
    const existingUrl = projectToUrl.get(entry.projectId);
    const isCandidateLease = "generation" in entry;
    if (existingUrl && existingUrl !== entry.projectUrl) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        "machine surface ownership entry does not match its Project binding",
      );
    }
    if (!existingUrl && !isCandidateLease) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        "machine surface binding is missing its Project mapping",
      );
    }
    const existingProject = urlToProject.get(entry.projectUrl);
    if (existingProject && existingProject !== entry.projectId) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        "machine surface ownership binds one ChatGPT Project to multiple local projects",
      );
    }
    projectToUrl.set(entry.projectId, entry.projectUrl);
    urlToProject.set(entry.projectUrl, entry.projectId);
  }
  assertOwnershipRelations({
    leases: state.leases,
    bindings: state.bindings,
    generations: state.generations,
    nextGeneration: state.nextGeneration,
    label: "machine surface ownership state",
  });
}

function readState(projectId: string): SurfaceOwnershipState {
  const expectedProjectId = safeId(projectId, "project id");
  const file = surfaceOwnershipFile(expectedProjectId);
  const raw = readJsonIfExists<unknown>(file);
  if (raw === null) {
    if (fs.existsSync(file)) {
      throw new SurfaceOwnershipError("INVALID_SURFACE_OWNERSHIP_STATE", "surface ownership state is malformed");
    }
    return { schemaVersion: SURFACE_STATE_VERSION, leases: [], bindings: [], generations: {} };
  }
  const value = record(raw, "surface ownership state");
  assertOnlyKeys(value, ["schemaVersion", "leases", "bindings", "generations"], "surface ownership state");
  if (value.schemaVersion !== SURFACE_STATE_VERSION || !Array.isArray(value.leases) || !Array.isArray(value.bindings)) {
    throw new SurfaceOwnershipError("INVALID_SURFACE_OWNERSHIP_STATE", "surface ownership state version is invalid");
  }
  const generations = record(value.generations, "surface generations");
  const parsedGenerations: Record<string, number> = {};
  for (const [key, generation] of Object.entries(generations)) {
    const keyParts = key.split("\u0000");
    if (keyParts.length !== 2 || !keyParts.every((part) => C2C_ID_PATTERN.test(part))) {
      throw new SurfaceOwnershipError("INVALID_SURFACE_OWNERSHIP_STATE", "surface generation key is invalid");
    }
    parsedGenerations[key] = storedGeneration(generation, "surface generation");
  }
  const state: SurfaceOwnershipState = {
    schemaVersion: SURFACE_STATE_VERSION,
    leases: value.leases.map(parseLease),
    bindings: value.bindings.map(parseBinding),
    generations: parsedGenerations,
  };
  if ([...state.leases, ...state.bindings].some((entry) => entry.projectId !== expectedProjectId)) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      "surface ownership state does not match its workspace storage"
    );
  }
  assertProjectBindingConsistency(state);
  return state;
}

function assertProjectBindingConsistency(state: SurfaceOwnershipState): void {
  const projectToUrl = new Map<string, string>();
  const urlToProject = new Map<string, string>();
  for (const entry of [...state.leases, ...state.bindings]) {
    const existingUrl = projectToUrl.get(entry.projectId);
    if (existingUrl && existingUrl !== entry.projectUrl) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        "surface ownership state binds one local project to multiple ChatGPT Projects"
      );
    }
    const existingProject = urlToProject.get(entry.projectUrl);
    if (existingProject && existingProject !== entry.projectId) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        "surface ownership state binds one ChatGPT Project to multiple local projects"
      );
    }
    projectToUrl.set(entry.projectId, entry.projectUrl);
    urlToProject.set(entry.projectUrl, entry.projectId);
  }
}

function assertRequestedProjectBinding(
  state: SurfaceOwnershipState,
  projectId: string,
  projectUrl: string
): void {
  for (const entry of [...state.leases, ...state.bindings]) {
    if (entry.projectId === projectId && entry.projectUrl !== projectUrl) {
      throw new SurfaceOwnershipError(
        "PROJECT_BINDING_CONFLICT",
        "local project is already bound to a different ChatGPT Project"
      );
    }
    if (entry.projectUrl === projectUrl && entry.projectId !== projectId) {
      throw new SurfaceOwnershipError(
        "PROJECT_BINDING_CONFLICT",
        "ChatGPT Project is already bound to a different local project"
      );
    }
  }
}

function pageKey(browserId: string, surfaceId: string, tabId: string): string {
  return `${browserId}\u0000${surfaceId}\u0000${tabId}`;
}

function sessionKey(projectId: string, localSessionId: string): string {
  return `${projectId}\u0000${localSessionId}`;
}

function latestSessionBinding(
  state: SurfaceOwnershipState,
  projectId: string,
  localSessionId: string
): SurfaceBinding | undefined {
  const key = sessionKey(projectId, localSessionId);
  return state.bindings
    .filter((entry) => sessionKey(entry.projectId, entry.localSessionId) === key)
    .sort((left, right) => right.lastGeneration - left.lastGeneration)[0];
}

function leaseMatchesPage(lease: SurfaceLease, browserId: string, surfaceId: string, tabId: string): boolean {
  return lease.browserId === browserId && lease.surfaceId === surfaceId && lease.tabId === tabId;
}

function leaseMatchesRequest(lease: SurfaceLease, request: ClaimSurfaceOptions, ownerProcessEpoch: string): boolean {
  return (
    lease.projectId === request.projectId &&
    lease.localSessionId === request.localSessionId &&
    lease.browserId === request.browserId &&
    lease.surfaceId === request.surfaceId &&
    lease.tabId === request.tabId &&
    lease.projectUrl === request.projectUrl &&
    lease.chatUrl === request.chatUrl &&
    lease.ownerProcessEpoch === ownerProcessEpoch
  );
}

function bindingMatchesRequest(binding: SurfaceBinding, request: ClaimSurfaceOptions): boolean {
  return (
    binding.projectId === request.projectId &&
    binding.localSessionId === request.localSessionId &&
    binding.browserId === request.browserId &&
    binding.surfaceId === request.surfaceId &&
    binding.tabId === request.tabId &&
    binding.projectUrl === request.projectUrl &&
    binding.chatUrl === request.chatUrl
  );
}

function bindingMatchesLeaseRef(binding: SurfaceBinding, ref: SurfaceLeaseRef): boolean {
  return (
    binding.projectId === ref.projectId &&
    binding.localSessionId === ref.localSessionId &&
    binding.browserId === ref.browserId &&
    binding.surfaceId === ref.surfaceId &&
    binding.tabId === ref.tabId &&
    binding.lastGeneration === ref.generation
  );
}

function sameLeaseRef(lease: SurfaceLease, ref: SurfaceLeaseRef): boolean {
  return (
    lease.projectId === ref.projectId &&
    lease.localSessionId === ref.localSessionId &&
    lease.browserId === ref.browserId &&
    lease.surfaceId === ref.surfaceId &&
    lease.tabId === ref.tabId &&
    lease.generation === ref.generation &&
    lease.ownerProcessEpoch === ref.ownerProcessEpoch
  );
}

function expired(lease: SurfaceLease, at: Date): boolean {
  return Date.parse(lease.leaseExpiresAt) <= at.getTime();
}

function reapExpired(state: SurfaceOwnershipState, at: Date): number {
  const before = state.leases.length;
  state.leases = state.leases.filter((lease) => !expired(lease, at));
  return before - state.leases.length;
}

function saveState(projectId: string, state: SurfaceOwnershipState): void {
  writeSecureJson(surfaceOwnershipFile(projectId), state);
}

function saveMachineState(state: MachineSurfaceOwnershipState): void {
  assertMachineOwnershipConsistency(state);
  writeSecureJson(machineSurfaceOwnershipFile(), serializedMachineSurfaceState(state));
}

function withSurfaceOwnershipLocks<T>(projectId: string, action: () => T): T {
  // Always acquire the machine lock before the project lock. This is the
  // lock order used by every operation that touches either ownership index.
  return withFileLock(machineSurfaceOwnershipLockFile(), () =>
    withFileLock(surfaceOwnershipLockFile(projectId), action),
  );
}

function withMachineSurfaceOwnershipLock<T>(action: () => T): T {
  return withFileLock(machineSurfaceOwnershipLockFile(), action);
}

function syncProjectIntoMachineState(
  machine: MachineSurfaceOwnershipState,
  project: SurfaceOwnershipState,
  projectId: string,
  options: { allowAbsentReinitialize?: boolean } = {},
): void {
  const absent = absentProjects(machine);
  if (absent.includes(projectId)) {
    if (!options.allowAbsentReinitialize) {
      // An explicit unregister is machine authority. Do not import a stale
      // checkout mirror until a new surface claim deliberately reinitializes
      // this project.
      project.leases = [];
      project.bindings = [];
      project.generations = {};
      assertMachineOwnershipConsistency(machine);
      return;
    }
    machine.authoritativelyAbsentProjects = absent.filter((id) => id !== projectId);
  }
  if (!machine.initializedProjects.includes(projectId)) {
    // The workspace mirror is untrusted at first sight. Start with an empty
    // machine authority and force every old route to be claimed and verified
    // again instead of importing pre-created leases or bindings.
    machine.initializedProjects.push(projectId);
    project.leases = [];
    project.bindings = [];
    project.generations = {};
  } else {
    // The machine index is authoritative after first initialization. A stale
    // or edited workspace mirror can never release another machine owner.
    project.leases = machine.leases
      .filter((lease) => lease.projectId === projectId)
      .map((lease) => ({ ...lease }));
    project.bindings = machine.bindings
      .filter((binding) => binding.projectId === projectId)
      .map((binding) => ({ ...binding }));
    project.generations = projectGenerationMirror(machine, projectId);
  }
  assertMachineOwnershipConsistency(machine);
}

function projectGenerationMirror(
  machine: MachineSurfaceOwnershipState,
  projectId: string,
): Record<string, number> {
  const activeSessions = new Set(
    [...machine.leases, ...machine.bindings]
      .filter((entry) => entry.projectId === projectId)
      .map((entry) => sessionKey(entry.projectId, entry.localSessionId)),
  );
  return Object.fromEntries(
    Object.entries(machine.generations).filter(
      ([key]) => key.startsWith(`${projectId}\u0000`) && activeSessions.has(key),
    ),
  );
}

function publishProjectIntoMachineState(
  machine: MachineSurfaceOwnershipState,
  project: SurfaceOwnershipState,
  projectId: string,
): void {
  if (absentProjects(machine).includes(projectId)) {
    // An unregistered project remains absent until a new claim explicitly
    // reinitializes it. Never publish a stale checkout mirror into authority.
    machine.leases = machine.leases.filter((lease) => lease.projectId !== projectId);
    machine.bindings = machine.bindings.filter((binding) => binding.projectId !== projectId);
    pruneMachineGenerations(machine);
    assertMachineOwnershipConsistency(machine);
    return;
  }
  if (!machine.initializedProjects.includes(projectId)) machine.initializedProjects.push(projectId);
  machine.leases = machine.leases.filter((lease) => lease.projectId !== projectId);
  machine.bindings = machine.bindings.filter((binding) => binding.projectId !== projectId);
  machine.leases.push(...project.leases.map((lease) => ({ ...lease })));
  machine.bindings.push(...project.bindings.map((binding) => ({ ...binding })));
  pruneMachineGenerations(machine);
  assertMachineOwnershipConsistency(machine);
}

function reapMachineExpiredLeases(machine: MachineSurfaceOwnershipState, at: Date): number {
  const before = machine.leases.length;
  machine.leases = machine.leases.filter((lease) => !expired(lease, at));
  pruneMachineGenerations(machine);
  return before - machine.leases.length;
}

function pruneMachineGenerations(machine: MachineSurfaceOwnershipState): void {
  const activeSessions = new Set(
    [...machine.leases, ...machine.bindings].map((entry) =>
      sessionKey(entry.projectId, entry.localSessionId),
    ),
  );
  machine.generations = Object.fromEntries(
    Object.entries(machine.generations).filter(([key]) => activeSessions.has(key)),
  );
}

function assertMachineRequestAvailable(
  machine: MachineSurfaceOwnershipState,
  projectId: string,
  projectUrl: string,
  browserId: string,
  surfaceId: string,
  tabId: string,
): void {
  const boundProjectUrl = machine.projectUrls[projectId];
  if (boundProjectUrl !== undefined && boundProjectUrl !== projectUrl) {
    throw new SurfaceOwnershipError(
      "PROJECT_BINDING_CONFLICT",
      "local project is already bound to a different ChatGPT Project",
    );
  }
  const boundProject = Object.entries(machine.projectUrls).find(
    ([otherProjectId, boundUrl]) => otherProjectId !== projectId && boundUrl === projectUrl,
  );
  if (boundProject) {
    throw new SurfaceOwnershipError(
      "PROJECT_BINDING_CONFLICT",
      "ChatGPT Project is already bound to a different local project",
    );
  }
  const requestedPage = pageKey(browserId, surfaceId, tabId);
  for (const entry of [...machine.leases, ...machine.bindings]) {
    if (entry.projectId === projectId) continue;
    if (entry.projectUrl === projectUrl) {
      throw new SurfaceOwnershipError(
        "PROJECT_BINDING_CONFLICT",
        "ChatGPT Project is already bound to a different local project",
      );
    }
    if (pageKey(entry.browserId, entry.surfaceId, entry.tabId) === requestedPage) {
      throw new SurfaceOwnershipError(
        machine.leases.includes(entry as SurfaceLease)
          ? "SURFACE_ALREADY_OWNED"
          : "SURFACE_BOUND_TO_ANOTHER_SESSION",
        "ChatGPT surface is already owned by another local project",
      );
    }
  }
}

function syncAndSave(
  projectId: string,
  project: SurfaceOwnershipState,
  machine: MachineSurfaceOwnershipState,
): void {
  // The project file is only a recovery mirror. Commit the protected machine
  // authority first; a failed mirror write is repaired on the next read.
  project.generations = projectGenerationMirror(machine, projectId);
  saveMachineState(machine);
  saveState(projectId, project);
}

function validateClaim(request: ClaimSurfaceOptions): {
  request: Omit<ClaimSurfaceOptions, "ownerProcessEpoch" | "leaseTtlMs" | "now" | "replaces"> & {
    ownerProcessEpoch: string;
    replaces?: SurfaceLeaseRef;
    leaseTtlMs: number;
    now: Date;
  };
} {
  const projectId = safeId(request.projectId, "project id");
  const localSessionId = safeId(request.localSessionId, "local session id");
  const browserId = safeId(request.browserId, "browser id");
  const surfaceId = safeId(request.surfaceId, "surface id");
  assertChatGPTSurfaceIdentity(browserId, surfaceId);
  const tabId = safeId(request.tabId, "tab id");
  const projectUrl = canonicalProjectUrl(request.projectUrl);
  const chatUrl = request.chatUrl === undefined ? undefined : canonicalChatUrl(request.chatUrl);
  if (chatUrl && projectIdFromChatUrl(chatUrl) !== projectIdFromUrl(projectUrl)) {
    throw new SurfaceOwnershipError(
      "INVALID_SURFACE_OWNERSHIP_STATE",
      "ChatGPT chat URL must belong to the configured Project"
    );
  }
  const ownerProcessEpoch = safeEpoch(request.ownerProcessEpoch ?? currentOwnerProcessEpoch());
  if (request.replaces) {
    safeId(request.replaces.projectId, "replacement project id");
    safeId(request.replaces.localSessionId, "replacement local session id");
    safeId(request.replaces.browserId, "replacement browser id");
    safeId(request.replaces.surfaceId, "replacement surface id");
    assertChatGPTSurfaceIdentity(request.replaces.browserId, request.replaces.surfaceId);
    safeId(request.replaces.tabId, "replacement tab id");
    safeEpoch(request.replaces.ownerProcessEpoch);
    if (!Number.isSafeInteger(request.replaces.generation) || request.replaces.generation < 1) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        "replacement generation is invalid"
      );
    }
  }
  return {
    request: {
      projectId,
      localSessionId,
      browserId,
      surfaceId,
      tabId,
      projectUrl,
      chatUrl,
      ownerProcessEpoch,
      replaces: request.replaces,
      leaseTtlMs: leaseTtl(request.leaseTtlMs),
      now: nowDate(request.now),
    },
  };
}

/**
 * Claim a temporary ChatGPT page lease for one local session.
 *
 * There is intentionally no global capacity check: every local session may
 * own a page. Durable routing is written only by commitSurface after the
 * candidate page has passed its workspace verification.
 */
export function claimSurface(options: ClaimSurfaceOptions): SurfaceLease {
  const { request } = validateClaim(options);
  return withSurfaceOwnershipLocks(request.projectId, () => {
    const state = readState(request.projectId);
    const machine = readMachineState();
    reapMachineExpiredLeases(machine, request.now);
    syncProjectIntoMachineState(machine, state, request.projectId, { allowAbsentReinitialize: true });
    reapExpired(state, request.now);
    assertRequestedProjectBinding(state, request.projectId, request.projectUrl);
    assertMachineRequestAvailable(
      machine,
      request.projectId,
      request.projectUrl,
      request.browserId,
      request.surfaceId,
      request.tabId,
    );
    const requestedPage = pageKey(request.browserId, request.surfaceId, request.tabId);
    const requestedSession = sessionKey(request.projectId, request.localSessionId);
    const activeForSession = state.leases.find(
      (lease) => sessionKey(lease.projectId, lease.localSessionId) === requestedSession
    );
    const activeForPage = state.leases.find((lease) => leaseMatchesPage(lease, request.browserId, request.surfaceId, request.tabId));
    if (activeForPage && activeForPage.localSessionId !== request.localSessionId) {
      throw new SurfaceOwnershipError(
        "SURFACE_ALREADY_OWNED",
        "ChatGPT surface is already owned by another local session"
      );
    }
    const activeForChat = request.chatUrl
      ? state.leases.find((lease) => lease.chatUrl === request.chatUrl)
      : undefined;
    if (activeForChat && activeForChat.localSessionId !== request.localSessionId) {
      throw new SurfaceOwnershipError(
        "SURFACE_ALREADY_OWNED",
        "ChatGPT chat is already owned by another local session"
      );
    }
    const binding = state.bindings.find(
      (entry) => pageKey(entry.browserId, entry.surfaceId, entry.tabId) === requestedPage
    );
    if (binding && (binding.localSessionId !== request.localSessionId || binding.projectId !== request.projectId)) {
      throw new SurfaceOwnershipError(
        "SURFACE_BOUND_TO_ANOTHER_SESSION",
        "ChatGPT tab cannot be reused by another local session"
      );
    }
    const boundForChat = request.chatUrl
      ? state.bindings.find((entry) => entry.chatUrl === request.chatUrl)
      : undefined;
    if (
      boundForChat &&
      (boundForChat.localSessionId !== request.localSessionId || boundForChat.projectId !== request.projectId)
    ) {
      throw new SurfaceOwnershipError(
        "SURFACE_BOUND_TO_ANOTHER_SESSION",
        "ChatGPT chat cannot be reused by another local session"
      );
    }
    const persistentSessionBinding = latestSessionBinding(
      state,
      request.projectId,
      request.localSessionId
    );
    if (activeForSession && leaseMatchesRequest(activeForSession, request, request.ownerProcessEpoch)) {
      syncAndSave(request.projectId, state, machine);
      return activeForSession;
    }
    if (activeForSession && (!request.replaces || !sameLeaseRef(activeForSession, request.replaces))) {
      throw new SurfaceOwnershipError(
        "SESSION_ALREADY_OWNED",
        "local session already owns another live ChatGPT surface"
      );
    }
    if (
      !activeForSession &&
      persistentSessionBinding &&
      !bindingMatchesRequest(persistentSessionBinding, request) &&
      (!request.replaces || !bindingMatchesLeaseRef(persistentSessionBinding, request.replaces))
    ) {
      throw new SurfaceOwnershipError(
        "SESSION_ALREADY_OWNED",
        "local session already has a persistent ChatGPT surface binding; explicit rotation is required"
      );
    }
    if (activeForSession) {
      state.leases = state.leases.filter((lease) => lease !== activeForSession);
    }
    if (machine.nextGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        "surface generation space is exhausted",
      );
    }
    const generationKey = requestedSession;
    const generation = machine.nextGeneration;
    machine.nextGeneration = generation + 1;
    machine.generations[generationKey] = generation;
    state.generations[generationKey] = generation;
    const claimedAt = timestamp(request.now);
    const leaseExpiresAt = timestamp(new Date(request.now.getTime() + request.leaseTtlMs));
    const lease: SurfaceLease = {
      projectId: request.projectId,
      localSessionId: request.localSessionId,
      browserId: request.browserId,
      surfaceId: request.surfaceId,
      tabId: request.tabId,
      projectUrl: request.projectUrl,
      chatUrl: request.chatUrl,
      generation,
      leaseExpiresAt,
      ownerProcessEpoch: request.ownerProcessEpoch,
      ownerPid: process.pid,
      claimedAt,
      updatedAt: claimedAt,
    };
    state.leases.push(lease);
    publishProjectIntoMachineState(machine, state, request.projectId);
    syncAndSave(request.projectId, state, machine);
    return lease;
  });
}

/**
 * Promote a verified candidate and its session route under one fixed lock
 * order (surface, then session). A newer surface generation cannot publish
 * between the ownership check and the route write.
 */
export function commitVerifiedSurfaceRoute(
  options: CommitVerifiedSurfaceRouteOptions,
): VerifiedSurfaceRouteCommit {
  const ref = options.lease;
  const observedChatUrl = options.chatUrl === undefined
    ? undefined
    : canonicalChatUrl(options.chatUrl);
  const at = nowDate(options.now);
  safeId(ref.projectId, "project id");
  safeId(options.workspaceId, "workspace id");
  safeId(ref.localSessionId, "local session id");
  safeId(ref.browserId, "browser id");
  safeId(ref.surfaceId, "surface id");
  assertChatGPTSurfaceIdentity(ref.browserId, ref.surfaceId);
  safeId(ref.tabId, "tab id");
  safeEpoch(ref.ownerProcessEpoch);
  if (!Number.isSafeInteger(ref.generation) || ref.generation < 1) {
    throw new SurfaceOwnershipError("INVALID_SURFACE_OWNERSHIP_STATE", "lease generation is invalid");
  }
  return withSurfaceOwnershipLocks(ref.projectId, () => {
    const state = readState(ref.projectId);
    const machine = readMachineState();
    const machineRemoved = reapMachineExpiredLeases(machine, at);
    syncProjectIntoMachineState(machine, state, ref.projectId);
    const removed = reapExpired(state, at);
    const current = state.leases.find((lease) => sameLeaseRef(lease, ref));
    if (!current) {
      if (removed > 0 || machineRemoved > 0) syncAndSave(ref.projectId, state, machine);
      throw new SurfaceOwnershipError(
        "LEASE_NOT_FOUND",
        "surface lease must still be owned when its verified route is committed"
      );
    }
    const chatUrl = observedChatUrl ?? current.chatUrl;
    if (!chatUrl) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        "candidate surface commit requires the observed ChatGPT chat URL",
      );
    }
    if (projectIdFromChatUrl(chatUrl) !== projectIdFromUrl(current.projectUrl)) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        "ChatGPT chat URL must belong to the configured Project",
      );
    }
    assertRequestedProjectBinding(state, current.projectId, current.projectUrl);
    assertMachineRequestAvailable(
      machine,
      current.projectId,
      current.projectUrl,
      current.browserId,
      current.surfaceId,
      current.tabId,
    );
    if (machine.projectUrls[ref.projectId] === undefined) {
      machine.projectUrls[ref.projectId] = current.projectUrl;
    }
    const requestedPage = pageKey(current.browserId, current.surfaceId, current.tabId);
    const existingBinding = state.bindings.find(
      (entry) => pageKey(entry.browserId, entry.surfaceId, entry.tabId) === requestedPage
    );
    if (
      existingBinding &&
      (existingBinding.projectId !== current.projectId ||
        existingBinding.localSessionId !== current.localSessionId)
    ) {
      throw new SurfaceOwnershipError(
        "SURFACE_BOUND_TO_ANOTHER_SESSION",
        "ChatGPT tab cannot be committed by another local session"
      );
    }
    const boundForChat = state.bindings.find((entry) => entry.chatUrl === chatUrl);
    if (
      boundForChat &&
      (boundForChat.projectId !== current.projectId ||
        boundForChat.localSessionId !== current.localSessionId)
    ) {
      throw new SurfaceOwnershipError(
        "SURFACE_BOUND_TO_ANOTHER_SESSION",
        "ChatGPT chat cannot be committed by another local session"
      );
    }
    const committedAt = timestamp(at);
    const currentSessionKey = sessionKey(current.projectId, current.localSessionId);
    const previousSessionBinding = latestSessionBinding(
      state,
      current.projectId,
      current.localSessionId,
    );
    const nextBinding: SurfaceBinding = {
      browserId: current.browserId,
      surfaceId: current.surfaceId,
      tabId: current.tabId,
      projectId: current.projectId,
      localSessionId: current.localSessionId,
      lastGeneration: current.generation,
      projectUrl: current.projectUrl,
      chatUrl,
      boundAt: existingBinding?.boundAt ?? previousSessionBinding?.boundAt ?? committedAt,
      updatedAt: committedAt,
    };
    // A session has exactly one durable route. Replacing it here also releases
    // the previous tab binding so another session can claim that page after
    // this verified generation becomes current.
    state.bindings = [
      ...state.bindings.filter(
        (entry) => sessionKey(entry.projectId, entry.localSessionId) !== currentSessionKey,
      ),
      nextBinding,
    ];
    state.leases = state.leases.map((lease) =>
      lease === current ? { ...lease, chatUrl, updatedAt: committedAt } : lease,
    );
    publishProjectIntoMachineState(machine, state, ref.projectId);
    // Publish machine authority before touching the checkout route. If the
    // route write fails, surfaceGet can replay this exact binding.
    saveMachineState(machine);
    const session = reconcileSessionRoute(options.workspaceId, current.localSessionId, {
      projectUrl: current.projectUrl,
      chatUrl,
      connectorName: options.connectorName,
      surfaceGeneration: current.generation,
      surfaceTabId: current.tabId,
    });
    if (!session) {
      throw new SurfaceOwnershipError(
        "INVALID_SURFACE_OWNERSHIP_STATE",
        "machine-owned surface route did not persist",
      );
    }
    saveState(ref.projectId, state);
    return { binding: { ...nextBinding }, session };
  });
}

/** Renew only the exact current owner and generation. */
export function renewSurface(options: RenewSurfaceOptions): SurfaceLease {
  const ttl = leaseTtl(options.leaseTtlMs);
  const at = nowDate(options.now);
  const ref = options.lease;
  safeId(ref.projectId, "project id");
  safeId(ref.localSessionId, "local session id");
  safeId(ref.browserId, "browser id");
  safeId(ref.surfaceId, "surface id");
  assertChatGPTSurfaceIdentity(ref.browserId, ref.surfaceId);
  safeId(ref.tabId, "tab id");
  safeEpoch(ref.ownerProcessEpoch);
  return withSurfaceOwnershipLocks(ref.projectId, () => {
    const state = readState(ref.projectId);
    const machine = readMachineState();
    const machineRemoved = reapMachineExpiredLeases(machine, at);
    syncProjectIntoMachineState(machine, state, ref.projectId);
    const removed = reapExpired(state, at);
    const current = state.leases.find((lease) => sameLeaseRef(lease, ref));
    if (!current) {
      if (removed > 0 || machineRemoved > 0) syncAndSave(ref.projectId, state, machine);
      throw new SurfaceOwnershipError("LEASE_NOT_FOUND", "surface lease is not owned by this process epoch");
    }
    const updatedAt = timestamp(at);
    const updated: SurfaceLease = {
      ...current,
      leaseExpiresAt: timestamp(new Date(at.getTime() + ttl)),
      updatedAt,
    };
    state.leases = state.leases.map((lease) => (lease === current ? updated : lease));
    publishProjectIntoMachineState(machine, state, ref.projectId);
    syncAndSave(ref.projectId, state, machine);
    return updated;
  });
}

/** Release only an exact owner; stale or mismatched releases are no-ops. */
export function releaseSurface(ref: SurfaceLeaseRef, now?: Date): boolean {
  const at = nowDate(now);
  safeId(ref.projectId, "project id");
  safeId(ref.localSessionId, "local session id");
  safeId(ref.browserId, "browser id");
  safeId(ref.surfaceId, "surface id");
  assertChatGPTSurfaceIdentity(ref.browserId, ref.surfaceId);
  safeId(ref.tabId, "tab id");
  safeEpoch(ref.ownerProcessEpoch);
  if (!Number.isSafeInteger(ref.generation) || ref.generation < 1) {
    throw new SurfaceOwnershipError("INVALID_SURFACE_OWNERSHIP_STATE", "lease generation is invalid");
  }
  return withSurfaceOwnershipLocks(ref.projectId, () => {
    const state = readState(ref.projectId);
    const machine = readMachineState();
    syncProjectIntoMachineState(machine, state, ref.projectId);
    // A stale release must not reap another generation that belongs to the
    // current owner. First locate the exact lease, then apply expiry cleanup.
    let index = state.leases.findIndex((lease) => sameLeaseRef(lease, ref));
    if (index >= 0) {
      // Only the exact lease being released is subject to expiry cleanup.
      // An old release must not reap a newer generation for this session.
      const current = state.leases[index];
      if (current && expired(current, at)) {
        reapMachineExpiredLeases(machine, at);
        reapExpired(state, at);
      }
      index = state.leases.findIndex((lease) => sameLeaseRef(lease, ref));
    }
    if (index < 0) {
      syncAndSave(ref.projectId, state, machine);
      return false;
    }
    state.leases.splice(index, 1);
    publishProjectIntoMachineState(machine, state, ref.projectId);
    syncAndSave(ref.projectId, state, machine);
    return true;
  });
}

/** List active leases and clean expired entries, including after a restart. */
export function listSurfaceLeases(projectId: string, now?: Date): SurfaceLease[] {
  const expectedProjectId = safeId(projectId, "project id");
  const at = nowDate(now);
  return withSurfaceOwnershipLocks(expectedProjectId, () => {
    const state = readState(expectedProjectId);
    const machine = readMachineState();
    const machineRemoved = reapMachineExpiredLeases(machine, at);
    syncProjectIntoMachineState(machine, state, expectedProjectId);
    const removed = reapExpired(state, at);
    syncAndSave(expectedProjectId, state, machine);
    return state.leases.map((lease) => ({ ...lease }));
  });
}

export function currentSurfaceLease(
  projectId: string,
  localSessionId: string,
  now?: Date
): SurfaceLease | null {
  const expectedProjectId = safeId(projectId, "project id");
  const expectedLocalSessionId = safeId(localSessionId, "local session id");
  return (
    listSurfaceLeases(expectedProjectId, now).find(
      (lease) =>
        lease.projectId === expectedProjectId && lease.localSessionId === expectedLocalSessionId
    ) ?? null
  );
}

/**
 * Return the latest durable page binding for a local session, even when its
 * lease has expired or was released. The returned object is detached from the
 * persisted state so callers cannot mutate ownership through this read API.
 */
export function currentSurfaceBinding(
  projectId: string,
  localSessionId: string
): SurfaceBinding | null {
  const expectedProjectId = safeId(projectId, "project id");
  const expectedLocalSessionId = safeId(localSessionId, "local session id");
  return withSurfaceOwnershipLocks(expectedProjectId, () => {
    const state = readState(expectedProjectId);
    const machine = readMachineState();
    syncProjectIntoMachineState(machine, state, expectedProjectId);
    syncAndSave(expectedProjectId, state, machine);
    const binding = latestSessionBinding(state, expectedProjectId, expectedLocalSessionId);
    return binding ? { ...binding } : null;
  });
}

/** Replay machine route authority into a checkout after a partial commit. */
export function reconcileSurfaceSessionRoute(
  options: ReconcileSurfaceSessionRouteOptions,
): SavedSession | null {
  const expectedProjectId = safeId(options.projectId, "project id");
  const workspaceId = safeId(options.workspaceId, "workspace id");
  const localSessionId = safeId(options.localSessionId, "local session id");
  return withSurfaceOwnershipLocks(expectedProjectId, () => {
    const state = readState(expectedProjectId);
    const machine = readMachineState();
    const at = nowDate();
    reapMachineExpiredLeases(machine, at);
    syncProjectIntoMachineState(machine, state, expectedProjectId);
    // A missing URL is meaningful: the machine may have explicitly
    // unregistered this project. Pass null so the checkout route clears the
    // old Project association instead of retaining or reviving it.
    const projectUrl = machine.projectUrls[expectedProjectId] ?? null;
    const binding = machine.bindings.find(
      (entry) =>
        entry.projectId === expectedProjectId && entry.localSessionId === localSessionId,
    );
    const session = binding
      ? reconcileSessionRoute(workspaceId, localSessionId, {
          projectUrl: binding.projectUrl,
          chatUrl: binding.chatUrl,
          surfaceGeneration: binding.lastGeneration,
          surfaceTabId: binding.tabId,
        })
      : clearSessionRoute(workspaceId, localSessionId, projectUrl);
    syncAndSave(expectedProjectId, state, machine);
    return session;
  });
}

/** Return the durable machine-owned ChatGPT Project URL for a local project. */
export function currentProjectUrl(projectId: string): string | null {
  const expectedProjectId = safeId(projectId, "project id");
  return withSurfaceOwnershipLocks(expectedProjectId, () => {
    const machine = readMachineState();
    return machine.projectUrls[expectedProjectId] ?? null;
  });
}

/** Verify that a control-plane turn belongs to the currently owned page. */
export function requireSurfaceGeneration(
  projectId: string,
  localSessionId: string,
  generation: number,
  now?: Date
): SurfaceLease {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new SurfaceOwnershipError(
      "STALE_SURFACE_GENERATION",
      "surface generation must identify a current owned ChatGPT page"
    );
  }
  const lease = currentSurfaceLease(projectId, localSessionId, now);
  if (!lease || lease.generation !== generation) {
    throw new SurfaceOwnershipError(
      "STALE_SURFACE_GENERATION",
      "turn request does not match the current ChatGPT page generation"
    );
  }
  return lease;
}

/** Explicit startup/restart recovery hook. */
export function reapExpiredSurfaceLeases(projectId: string, now?: Date): number {
  const expectedProjectId = safeId(projectId, "project id");
  const at = nowDate(now);
  return withSurfaceOwnershipLocks(expectedProjectId, () => {
    const state = readState(expectedProjectId);
    const machine = readMachineState();
    const machineRemoved = reapMachineExpiredLeases(machine, at);
    syncProjectIntoMachineState(machine, state, expectedProjectId);
    const removed = reapExpired(state, at);
    syncAndSave(expectedProjectId, state, machine);
    return Math.max(removed, machineRemoved);
  });
}

/**
 * Permanently retire one local session across the project ownership mirror,
 * machine authority, and checkout-specific session route. The machine
 * machine-wide generation allocator is deliberately retained while the
 * per-session generation entry is removed, so a later claim cannot match an
 * old lease ref from before retirement.
 */
export function retireSurfaceSession(
  options: RetireSurfaceSessionOptions,
): RetireSurfaceSessionResult {
  const expectedProjectId = safeId(options.projectId, "project id");
  const workspaceId = safeId(options.workspaceId, "workspace id");
  const localSessionId = safeId(options.localSessionId, "local session id");
  return withSurfaceOwnershipLocks(expectedProjectId, () => {
    const state = readState(expectedProjectId);
    const machine = readMachineState();
    syncProjectIntoMachineState(machine, state, expectedProjectId);

    const key = sessionKey(expectedProjectId, localSessionId);
    const removedLeases = machine.leases.filter(
      (lease) => sessionKey(lease.projectId, lease.localSessionId) === key,
    ).length;
    const removedBindings = machine.bindings.filter(
      (binding) => sessionKey(binding.projectId, binding.localSessionId) === key,
    ).length;
    const hadProjectGeneration = state.generations[key] !== undefined;
    machine.leases = machine.leases.filter(
      (lease) => sessionKey(lease.projectId, lease.localSessionId) !== key,
    );
    machine.bindings = machine.bindings.filter(
      (binding) => sessionKey(binding.projectId, binding.localSessionId) !== key,
    );
    delete machine.generations[key];
    state.leases = state.leases.filter(
      (lease) => sessionKey(lease.projectId, lease.localSessionId) !== key,
    );
    state.bindings = state.bindings.filter(
      (binding) => sessionKey(binding.projectId, binding.localSessionId) !== key,
    );
    delete state.generations[key];
    publishProjectIntoMachineState(machine, state, expectedProjectId);
    // The machine removal is authoritative. Retiring the checkout route is a
    // later step so surfaceGet can clear it if this step is interrupted.
    saveMachineState(machine);
    const removedSession = retireSession(workspaceId, localSessionId);
    saveState(expectedProjectId, state);

    return {
      retired: removedLeases > 0 || removedBindings > 0 || hadProjectGeneration || removedSession,
      removedLeases,
      removedBindings,
      removedSession,
    };
  });
}

/**
 * Retire all browser ownership for an unregistered local project. This is a
 * machine-authoritative operation and deliberately does not open the
 * project-local mirror: an unregistered checkout may no longer have a valid
 * project data directory after a gateway restart. The stale mirror is
 * repaired when a later registered access observes that the project is no
 * longer initialized, and can never republish its old entries.
 */
export function unregisterSurfaceOwnership(projectId: string): number {
  const expectedProjectId = safeId(projectId, "project id");
  return withMachineSurfaceOwnershipLock(() => {
    const machine = readMachineState();
    const removed =
      machine.leases.filter((lease) => lease.projectId === expectedProjectId).length +
      machine.bindings.filter((binding) => binding.projectId === expectedProjectId).length;
    const hadAuthority =
      removed > 0 ||
      machine.projectUrls[expectedProjectId] !== undefined ||
      machine.initializedProjects.includes(expectedProjectId) ||
      Object.keys(machine.generations).some((key) => key.startsWith(`${expectedProjectId}\u0000`));
    machine.leases = machine.leases.filter((lease) => lease.projectId !== expectedProjectId);
    machine.bindings = machine.bindings.filter((binding) => binding.projectId !== expectedProjectId);
    delete machine.projectUrls[expectedProjectId];
    machine.generations = Object.fromEntries(
      Object.entries(machine.generations).filter(([key]) => !key.startsWith(`${expectedProjectId}\u0000`)),
    );
    machine.initializedProjects = machine.initializedProjects.filter(
      (projectId) => projectId !== expectedProjectId,
    );
    const currentAbsentProjects = absentProjects(machine);
    if (!currentAbsentProjects.includes(expectedProjectId)) {
      machine.authoritativelyAbsentProjects = [...currentAbsentProjects, expectedProjectId].sort();
    }
    // Keep an explicit machine-level absence marker. Otherwise a later
    // reconcile can mistake the old checkout mirror for a fresh project and
    // resurrect its Project URL or session route.
    if (hadAuthority || !currentAbsentProjects.includes(expectedProjectId)) saveMachineState(machine);
    return removed;
  });
}
