import path from "node:path";
import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import {
  ensureDir,
  getWorkspaceDataDir,
  readJsonIfExists,
  withFileLock,
  writeSecureJson,
} from "../config/paths.js";
import {
  C2C_ID_PATTERN,
  CONTROL_PHASES,
  MAX_C2C_ITERATION,
  type ControlPhase,
} from "../control/result-schema.js";

export type ConversationMode = "project";

export type ConversationReason = "project" | "new-workspace";

export type LocalSessionIdentitySource =
  | "explicit"
  | "c2c-environment"
  | "codex-thread"
  | "codex-session"
  | "codex-runtime"
  | "terminal-runtime"
  | "process-temporary";

export type LocalSessionStability = "durable" | "runtime" | "process";

export interface LocalSessionIdentity {
  id: string;
  source: LocalSessionIdentitySource;
  stability: LocalSessionStability;
}

export type ConversationRouteAction =
  | "resume-chat"
  | "create-project-chat"
  | "bind-project";

export interface ConversationRoute {
  action: ConversationRouteAction;
  targetUrl: string | null;
  expectedChatUrl: string | null;
  controlReady: boolean;
}

export type ProtocolState =
  | "RESEARCH_SENT"
  | "RESEARCH_RECEIVED"
  | "INIT"
  | "PLAN_RECEIVED"
  | "EXECUTING"
  | "EXECUTED_LOCAL"
  | "EXECUTED_SENT"
  | "DONE"
  | "BLOCKED";

export type WaitingFor = "none" | "GPT_RESEARCH" | "GPT_PLAN" | "GPT_REVIEW" | "USER";

export const PROTOCOL_STATES: readonly ProtocolState[] = [
  "RESEARCH_SENT",
  "RESEARCH_RECEIVED",
  "INIT",
  "PLAN_RECEIVED",
  "EXECUTING",
  "EXECUTED_LOCAL",
  "EXECUTED_SENT",
  "DONE",
  "BLOCKED",
];

export const WAITING_FOR: readonly WaitingFor[] = [
  "none",
  "GPT_RESEARCH",
  "GPT_PLAN",
  "GPT_REVIEW",
  "USER",
];

export interface TaskCheckpoint {
  taskId: string;
  iteration: number;
  protocolState: ProtocolState;
  waitingFor: WaitingFor;
  originalGoal?: string;
  completedSubtasks?: string;
  knownIssues?: string;
  nextExpectedStep?: string;
  chatUrl?: string;
  projectUrl?: string;
  mailboxRequestId?: string;
  mailboxPhase?: ControlPhase;
  mailboxResultId?: string;
  updatedAt: string;
}

export interface SavedSession {
  schemaVersion?: 2;
  localSessionId?: string;
  url?: string;
  title?: string;
  taskId?: string;
  iteration?: number;
  lastState?: string;
  savedAt: string;
  conversationMode?: ConversationMode;
  projectUrl?: string;
  connectorName?: string;
  /** Surface generation/tab that verified and persisted this route. */
  surfaceGeneration?: number;
  surfaceTabId?: string;
  checkpoint?: TaskCheckpoint;
}

export interface SessionPatch {
  localSessionId?: string;
  title?: string;
  taskId?: string;
  iteration?: number;
  lastState?: string;
  checkpoint?: Partial<TaskCheckpoint> & { protocolState?: ProtocolState };
  clearCheckpoint?: boolean;
  clearMailbox?: boolean;
}

/** Route-bearing merge input. It is intentionally not accepted by updateSession. */
interface RouteSessionPatch extends SessionPatch {
  url?: string;
  conversationMode?: ConversationMode;
  projectUrl?: string;
  connectorName?: string;
  surfaceGeneration?: number;
  surfaceTabId?: string;
}

/**
 * A verified browser surface is the only source allowed to persist routing.
 * Keep this separate from SessionPatch so ordinary checkpoint updates cannot
 * accidentally become a route write.
 */
export interface SessionRouteCommit {
  projectUrl: string;
  chatUrl?: string;
  connectorName?: string;
  surfaceGeneration?: number;
  surfaceTabId?: string;
}

/**
 * Route data replayed from the protected machine surface authority. A missing
 * chat URL means that the local session route must be cleared while retaining
 * the machine-owned Project association.
 */
export interface SessionRouteAuthority {
  /** `null` is an explicit machine-authoritative Project unregister. */
  projectUrl: string | null;
  chatUrl?: string;
  surfaceGeneration?: number;
  surfaceTabId?: string;
  connectorName?: string;
}

export interface ConversationView {
  localSessionId: string;
  mode: ConversationMode;
  reason: ConversationReason;
  projectUrl: string | null;
  projectReady: boolean;
  chatUrl: string | null;
  connectorName: string | null;
  /** Only the exact Project chat bound to this local Codex session may be reused. */
  reuseSavedChat: boolean;
}

interface WorkspaceSession {
  schemaVersion: 2;
  workspaceId: string;
  conversationMode?: ConversationMode;
  projectUrl?: string;
  connectorName?: string;
  savedAt: string;
}

interface ThreadSession {
  schemaVersion: 2;
  workspaceId: string;
  localSessionId: string;
  url?: string;
  title?: string;
  taskId?: string;
  iteration?: number;
  lastState?: string;
  checkpoint?: TaskCheckpoint;
  surfaceGeneration?: number;
  surfaceTabId?: string;
  savedAt: string;
}

const PROCESS_TEMPORARY_SESSION_ID = `temporary-${randomBytes(16).toString("hex")}`;
const UNSAFE_SINGLE_LINE = /[\u0000-\u001f\u007f]/;
const UNSAFE_MULTILINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SESSION_TEXT_LIMITS = {
  title: 200,
  connectorName: 200,
  lastState: 64,
} as const;
const CHECKPOINT_LIMITS = {
  originalGoal: 500,
  completedSubtasks: 800,
  knownIssues: 800,
  nextExpectedStep: 400,
} as const;

function validatedLocalSessionId(value: string): string {
  const normalized = value.trim();
  if (!C2C_ID_PATTERN.test(normalized)) {
    throw new Error("local session id must be a safe identifier");
  }
  return normalized;
}

function validatedWorkspaceId(value: string): string {
  const normalized = value.trim();
  if (!C2C_ID_PATTERN.test(normalized)) {
    throw new Error("workspace id must be a safe identifier");
  }
  return normalized;
}

function nonEmptyEnvironmentValue(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function derivedRuntimeId(kind: "codex" | "terminal", value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${kind}-runtime-${digest}`;
}

export function currentLocalSessionIdentity(explicit?: string): LocalSessionIdentity {
  if (explicit !== undefined) {
    return { id: validatedLocalSessionId(explicit), source: "explicit", stability: "durable" };
  }

  const c2cEnvironment = nonEmptyEnvironmentValue("C2C_LOCAL_SESSION_ID");
  if (c2cEnvironment) {
    return {
      id: validatedLocalSessionId(c2cEnvironment),
      source: "c2c-environment",
      stability: "durable",
    };
  }

  const codexThread = nonEmptyEnvironmentValue("CODEX_THREAD_ID");
  if (codexThread) {
    return { id: validatedLocalSessionId(codexThread), source: "codex-thread", stability: "durable" };
  }

  const codexSession = nonEmptyEnvironmentValue("CODEX_SESSION_ID");
  if (codexSession) {
    return { id: validatedLocalSessionId(codexSession), source: "codex-session", stability: "durable" };
  }

  const codexRuntime = nonEmptyEnvironmentValue("CODEX_APP_TOOLS_PIPE_PATH");
  if (codexRuntime) {
    return {
      id: derivedRuntimeId("codex", codexRuntime),
      source: "codex-runtime",
      stability: "runtime",
    };
  }

  const terminalRuntime =
    nonEmptyEnvironmentValue("TERM_SESSION_ID") ??
    nonEmptyEnvironmentValue("WT_SESSION") ??
    nonEmptyEnvironmentValue("VSCODE_PID") ??
    nonEmptyEnvironmentValue("SHELL_PID");
  if (terminalRuntime) {
    return {
      id: derivedRuntimeId("terminal", terminalRuntime),
      source: "terminal-runtime",
      stability: "runtime",
    };
  }

  return {
    id: PROCESS_TEMPORARY_SESSION_ID,
    source: "process-temporary",
    stability: "process",
  };
}

export function currentLocalSessionId(explicit?: string): string {
  return currentLocalSessionIdentity(explicit).id;
}

function sessionDir(workspaceId: string): string {
  const resolvedWorkspaceId = validatedWorkspaceId(workspaceId);
  return ensureDir(path.join(getWorkspaceDataDir(resolvedWorkspaceId), "sessions"));
}

function sessionStateLockFile(workspaceId: string): string {
  return path.join(sessionDir(workspaceId), "state.lock");
}

export function sessionFile(workspaceId: string): string {
  return path.join(sessionDir(workspaceId), "workspace.json");
}

export function threadSessionFile(workspaceId: string, localSessionId = currentLocalSessionId()): string {
  return path.join(sessionDir(workspaceId), "threads", `${currentLocalSessionId(localSessionId)}.json`);
}

function readSessionJson(file: string, label: string): unknown | null {
  const value = readJsonIfExists<unknown>(file);
  if (value === null && fs.existsSync(file)) {
    throw new Error(`${label} is unreadable or malformed`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  return value;
}

function optionalStoredText(
  value: unknown,
  label: string,
  maxLength: number,
  multiline = false
): string | undefined {
  const raw = optionalString(value, label);
  if (raw === undefined) return undefined;
  if (
    !raw ||
    raw.trim() !== raw ||
    raw.length > maxLength ||
    (multiline ? UNSAFE_MULTILINE : UNSAFE_SINGLE_LINE).test(raw)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return raw;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error(`${label} contains unknown fields`);
  }
}

function storedTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function optionalCanonicalChatUrl(value: unknown, label: string): string | undefined {
  const raw = optionalString(value, label);
  if (raw === undefined) return undefined;
  if (raw.trim() !== raw) throw new Error(`${label} is invalid or non-canonical`);
  const normalized = normalizeChatUrl(raw);
  if (!normalized) throw new Error(`${label} is invalid or non-canonical`);
  return normalized;
}

function optionalCanonicalProjectUrl(value: unknown, label: string): string | undefined {
  const raw = optionalString(value, label);
  if (raw === undefined) return undefined;
  if (raw.trim() !== raw) throw new Error(`${label} is invalid or non-canonical`);
  const normalized = normalizeProjectUrl(raw);
  if (!normalized) throw new Error(`${label} is invalid or non-canonical`);
  return normalized;
}

function optionalSafeId(value: unknown, label: string): string | undefined {
  const raw = optionalString(value, label);
  if (raw === undefined) return undefined;
  const normalized = raw.trim();
  if (normalized !== raw || !C2C_ID_PATTERN.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function optionalIteration(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_C2C_ITERATION) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function optionalSurfaceGeneration(value: unknown, label: string): number | undefined {
  const result = optionalIteration(value, label);
  if (result !== undefined && result < 1) throw new Error(`${label} is invalid`);
  return result;
}

function parseStoredCheckpoint(value: unknown): TaskCheckpoint | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("local session checkpoint is invalid");
  assertOnlyKeys(
    value,
    [
      "taskId",
      "iteration",
      "protocolState",
      "waitingFor",
      "originalGoal",
      "completedSubtasks",
      "knownIssues",
      "nextExpectedStep",
      "chatUrl",
      "projectUrl",
      "mailboxRequestId",
      "mailboxPhase",
      "mailboxResultId",
      "updatedAt",
    ],
    "local session checkpoint"
  );
  const taskId = optionalSafeId(value.taskId, "checkpoint task id");
  if (!taskId) throw new Error("checkpoint task id is invalid");
  const iteration = optionalIteration(value.iteration, "checkpoint iteration");
  if (iteration === undefined) throw new Error("checkpoint iteration is invalid");
  const protocolState = value.protocolState;
  if (typeof protocolState !== "string" || !PROTOCOL_STATES.includes(protocolState as ProtocolState)) {
    throw new Error("checkpoint protocol state is invalid");
  }
  const waitingFor = value.waitingFor;
  if (typeof waitingFor !== "string" || !WAITING_FOR.includes(waitingFor as WaitingFor)) {
    throw new Error("checkpoint waiting state is invalid");
  }
  const mailboxRequestId = optionalSafeId(value.mailboxRequestId, "checkpoint mailbox request id");
  const mailboxPhase = value.mailboxPhase;
  if (
    mailboxPhase !== undefined &&
    (typeof mailboxPhase !== "string" || !CONTROL_PHASES.includes(mailboxPhase as ControlPhase))
  ) {
    throw new Error("checkpoint mailbox phase is invalid");
  }
  const mailboxResultId = optionalSafeId(value.mailboxResultId, "checkpoint mailbox result id");
  if (Boolean(mailboxRequestId) !== Boolean(mailboxPhase) || (mailboxResultId && !mailboxRequestId)) {
    throw new Error("checkpoint mailbox correlation is incomplete");
  }
  return {
    taskId,
    iteration,
    protocolState: protocolState as ProtocolState,
    waitingFor: waitingFor as WaitingFor,
    originalGoal: optionalStoredText(
      value.originalGoal,
      "checkpoint goal",
      CHECKPOINT_LIMITS.originalGoal,
      true
    ),
    completedSubtasks: optionalStoredText(
      value.completedSubtasks,
      "checkpoint completed subtasks",
      CHECKPOINT_LIMITS.completedSubtasks,
      true
    ),
    knownIssues: optionalStoredText(
      value.knownIssues,
      "checkpoint known issues",
      CHECKPOINT_LIMITS.knownIssues,
      true
    ),
    nextExpectedStep: optionalStoredText(
      value.nextExpectedStep,
      "checkpoint next step",
      CHECKPOINT_LIMITS.nextExpectedStep,
      true
    ),
    chatUrl: optionalCanonicalChatUrl(value.chatUrl, "checkpoint chat URL"),
    projectUrl: optionalCanonicalProjectUrl(value.projectUrl, "checkpoint project URL"),
    mailboxRequestId,
    mailboxPhase: mailboxPhase as ControlPhase | undefined,
    mailboxResultId,
    updatedAt: storedTimestamp(value.updatedAt, "checkpoint timestamp"),
  };
}

function readWorkspaceSession(workspaceId: string): WorkspaceSession | null {
  const resolvedWorkspaceId = validatedWorkspaceId(workspaceId);
  const value = readSessionJson(sessionFile(resolvedWorkspaceId), "workspace session state");
  if (value === null) return null;
  if (!isRecord(value) || value.schemaVersion !== 2 || value.workspaceId !== resolvedWorkspaceId) {
    throw new Error("workspace session state does not match its storage path");
  }
  assertOnlyKeys(
    value,
    ["schemaVersion", "workspaceId", "conversationMode", "projectUrl", "connectorName", "savedAt"],
    "workspace session state"
  );
  const conversationMode = value.conversationMode;
  if (conversationMode !== undefined && conversationMode !== "project") {
    throw new Error("workspace session conversation mode is invalid");
  }
  const projectUrl = optionalCanonicalProjectUrl(value.projectUrl, "workspace session project URL");
  if (conversationMode === "project" && !projectUrl) {
    throw new Error("workspace session project mode requires a project URL");
  }
  return {
    schemaVersion: 2,
    workspaceId: resolvedWorkspaceId,
    conversationMode,
    projectUrl,
    connectorName: optionalStoredText(
      value.connectorName,
      "workspace session connector name",
      SESSION_TEXT_LIMITS.connectorName
    ),
    savedAt: storedTimestamp(value.savedAt, "workspace session timestamp"),
  };
}

function readThreadSession(workspaceId: string, localSessionId: string): ThreadSession | null {
  const resolvedWorkspaceId = validatedWorkspaceId(workspaceId);
  const resolvedLocalSessionId = validatedLocalSessionId(localSessionId);
  const value = readSessionJson(
    threadSessionFile(resolvedWorkspaceId, resolvedLocalSessionId),
    "local session state"
  );
  if (value === null) return null;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    value.workspaceId !== resolvedWorkspaceId ||
    value.localSessionId !== resolvedLocalSessionId
  ) {
    throw new Error("local session state does not match its storage path");
  }
  assertOnlyKeys(
    value,
    [
      "schemaVersion",
      "workspaceId",
      "localSessionId",
      "url",
      "title",
      "taskId",
      "iteration",
      "lastState",
      "checkpoint",
      "surfaceGeneration",
      "surfaceTabId",
      "savedAt",
    ],
    "local session state"
  );
  const url = optionalCanonicalChatUrl(value.url, "local session chat URL");
  const iteration = optionalIteration(value.iteration, "local session iteration");
  const surfaceGeneration = optionalSurfaceGeneration(value.surfaceGeneration, "surface generation");
  const surfaceTabId = optionalSafeId(value.surfaceTabId, "surface tab id");
  if ((surfaceGeneration === undefined) !== (surfaceTabId === undefined)) {
    throw new Error("surface route requires generation and tab id together");
  }
  return {
    schemaVersion: 2,
    workspaceId: resolvedWorkspaceId,
    localSessionId: resolvedLocalSessionId,
    url,
    title: optionalStoredText(value.title, "local session title", SESSION_TEXT_LIMITS.title),
    taskId: optionalSafeId(value.taskId, "local session task id"),
    iteration,
    lastState: optionalStoredText(value.lastState, "local session state", SESSION_TEXT_LIMITS.lastState),
    checkpoint: parseStoredCheckpoint(value.checkpoint),
    surfaceGeneration,
    surfaceTabId,
    savedAt: storedTimestamp(value.savedAt, "local session timestamp"),
  };
}

function readSessionUnlocked(workspaceId: string, localSessionId: string): SavedSession | null {
  const resolvedLocalSessionId = currentLocalSessionId(localSessionId);
  const workspace = readWorkspaceSession(workspaceId);
  const thread = readThreadSession(workspaceId, resolvedLocalSessionId);
  if (!workspace && !thread) return null;
  if (thread?.checkpoint) {
    if (thread.checkpoint.taskId !== thread.taskId) {
      throw new Error("checkpoint task does not match its local session state");
    }
    if (thread.checkpoint.iteration !== thread.iteration) {
      throw new Error("checkpoint iteration does not match its local session state");
    }
    if (thread.checkpoint.chatUrl !== thread.url) {
      throw new Error("checkpoint chat URL does not match its local session state");
    }
    if (thread.checkpoint.projectUrl !== workspace?.projectUrl) {
      throw new Error("checkpoint Project URL does not match its workspace state");
    }
  }
  return {
    schemaVersion: 2,
    localSessionId: resolvedLocalSessionId,
    url: thread?.url,
    title: thread?.title,
    taskId: thread?.taskId,
    iteration: thread?.iteration,
    lastState: thread?.lastState,
    conversationMode: workspace?.conversationMode,
    projectUrl: workspace?.projectUrl,
    connectorName: workspace?.connectorName,
    surfaceGeneration: thread?.surfaceGeneration,
    surfaceTabId: thread?.surfaceTabId,
    checkpoint: thread?.checkpoint,
    savedAt: thread?.savedAt ?? workspace?.savedAt ?? new Date().toISOString(),
  };
}

export function readSession(workspaceId: string, localSessionId = currentLocalSessionId()): SavedSession | null {
  const resolvedWorkspaceId = validatedWorkspaceId(workspaceId);
  const resolvedLocalSessionId = currentLocalSessionId(localSessionId);
  return withFileLock(sessionStateLockFile(resolvedWorkspaceId), () =>
    readSessionUnlocked(resolvedWorkspaceId, resolvedLocalSessionId)
  );
}

function writeSessionUnlocked(
  workspaceId: string,
  session: SavedSession,
  localSessionId = session.localSessionId ?? currentLocalSessionId(),
  options: { allowProjectRebind?: boolean; clearProjectBinding?: boolean } = {},
): SavedSession {
  const resolvedWorkspaceId = validatedWorkspaceId(workspaceId);
  const resolvedLocalSessionId = currentLocalSessionId(localSessionId);
  if (
    session.localSessionId !== undefined &&
    validatedLocalSessionId(session.localSessionId) !== resolvedLocalSessionId
  ) {
    throw new Error("local session state does not match its storage path");
  }
  const savedAt = storedTimestamp(session.savedAt ?? new Date().toISOString(), "local session timestamp");
  const previousWorkspace = readWorkspaceSession(workspaceId);
  const conversationMode = options.clearProjectBinding
    ? undefined
    : session.conversationMode ?? previousWorkspace?.conversationMode;
  if (conversationMode !== undefined && conversationMode !== "project") {
    throw new Error("workspace session conversation mode is invalid");
  }
  const parsedCheckpoint = session.checkpoint ? parseStoredCheckpoint(session.checkpoint) : undefined;
  const rawProjectUrl = options.clearProjectBinding
    ? undefined
    : session.projectUrl ?? previousWorkspace?.projectUrl;
  const projectUrl = rawProjectUrl ? (normalizeProjectUrl(rawProjectUrl) ?? undefined) : undefined;
  if (rawProjectUrl && !projectUrl) {
    throw new Error("project URL must look like https://chatgpt.com/g/g-p-.../project");
  }
  if (
    !options.allowProjectRebind &&
    previousWorkspace?.projectUrl &&
    projectUrl &&
    previousWorkspace.projectUrl !== projectUrl
  ) {
    throw new Error("workspace is already bound to a different ChatGPT Project");
  }
  if (conversationMode === "project" && !projectUrl) {
    throw new Error("project mode requires a project URL");
  }
  const rawUrl = session.url;
  const url = rawUrl ? (normalizeChatUrl(rawUrl) ?? undefined) : undefined;
  if (rawUrl && !url) {
    throw new Error("chat URL must identify a ChatGPT conversation");
  }
  assertProjectChatMatch(projectUrl, url);
  const taskId = optionalSafeId(session.taskId ?? parsedCheckpoint?.taskId, "local session task id");
  const iteration = optionalIteration(
    session.iteration ?? parsedCheckpoint?.iteration,
    "local session iteration"
  );
  const title = optionalStoredText(session.title, "local session title", SESSION_TEXT_LIMITS.title);
  const lastState = optionalStoredText(
    session.lastState,
    "local session state",
    SESSION_TEXT_LIMITS.lastState
  );
  const connectorName = optionalStoredText(
    options.clearProjectBinding
      ? undefined
      : session.connectorName ?? previousWorkspace?.connectorName,
    "workspace connector name",
    SESSION_TEXT_LIMITS.connectorName
  );
  const surfaceGeneration = optionalSurfaceGeneration(session.surfaceGeneration, "surface generation");
  const surfaceTabId = optionalSafeId(session.surfaceTabId, "surface tab id");
  if ((surfaceGeneration === undefined) !== (surfaceTabId === undefined)) {
    throw new Error("surface route requires generation and tab id together");
  }
  let checkpoint: TaskCheckpoint | undefined;
  if (parsedCheckpoint) {
    if (taskId !== parsedCheckpoint.taskId || iteration !== parsedCheckpoint.iteration) {
      throw new Error("checkpoint correlation does not match its local session state");
    }
    if (url && parsedCheckpoint.chatUrl && parsedCheckpoint.chatUrl !== url) {
      throw new Error("checkpoint chat URL does not match its local session state");
    }
    if (
      !options.allowProjectRebind &&
      projectUrl &&
      parsedCheckpoint.projectUrl &&
      parsedCheckpoint.projectUrl !== projectUrl
    ) {
      throw new Error("checkpoint Project URL does not match its workspace state");
    }
    checkpoint = {
      ...parsedCheckpoint,
      chatUrl: url,
      projectUrl,
    };
  }

  writeSecureJson(sessionFile(workspaceId), {
    schemaVersion: 2,
    workspaceId: resolvedWorkspaceId,
    conversationMode,
    projectUrl,
    connectorName,
    savedAt,
  } satisfies WorkspaceSession);

  const hasThreadState = Boolean(
    url || title || taskId || iteration !== undefined || lastState || checkpoint ||
      surfaceGeneration !== undefined || surfaceTabId !== undefined
  );
  if (hasThreadState) {
    writeSecureJson(threadSessionFile(workspaceId, resolvedLocalSessionId), {
      schemaVersion: 2,
      workspaceId: resolvedWorkspaceId,
      localSessionId: resolvedLocalSessionId,
      url,
      title,
      taskId,
      iteration,
      lastState,
      checkpoint,
      surfaceGeneration,
      surfaceTabId,
      savedAt,
    } satisfies ThreadSession);
  }
  return readSessionUnlocked(workspaceId, resolvedLocalSessionId) ?? {
    ...session,
    localSessionId: resolvedLocalSessionId,
    savedAt,
  };
}

/** Atomically merge and persist workspace and local-session state. */
export function updateSession(
  workspaceId: string,
  localSessionId: string,
  patch: SessionPatch
): SavedSession {
  const resolvedWorkspaceId = validatedWorkspaceId(workspaceId);
  const resolvedLocalSessionId = currentLocalSessionId(localSessionId);
  if (
    patch.localSessionId !== undefined &&
    validatedLocalSessionId(patch.localSessionId) !== resolvedLocalSessionId
  ) {
    throw new Error("local session patch does not match its storage path");
  }
  const routePatch = patch as SessionPatch & Partial<Omit<RouteSessionPatch, keyof SessionPatch>>;
  if (
    routePatch.url !== undefined ||
    routePatch.projectUrl !== undefined ||
    routePatch.connectorName !== undefined ||
    routePatch.conversationMode !== undefined ||
    routePatch.surfaceGeneration !== undefined ||
    routePatch.surfaceTabId !== undefined
  ) {
    throw new Error("session route can only be persisted by surface commit");
  }
  return withFileLock(sessionStateLockFile(resolvedWorkspaceId), () => {
    const saved = mergeSession(readSessionUnlocked(resolvedWorkspaceId, resolvedLocalSessionId), {
      ...patch,
      localSessionId: resolvedLocalSessionId,
    });
    return writeSessionUnlocked(resolvedWorkspaceId, saved, resolvedLocalSessionId);
  });
}

/** Persist a route only after the corresponding surface lease was verified. */
export function commitSessionRoute(
  workspaceId: string,
  localSessionId: string,
  route: SessionRouteCommit
): SavedSession {
  const resolvedWorkspaceId = validatedWorkspaceId(workspaceId);
  const resolvedLocalSessionId = currentLocalSessionId(localSessionId);
  const projectUrl = normalizeProjectUrl(route.projectUrl) ?? undefined;
  if (!projectUrl) {
    throw new Error("project URL must look like https://chatgpt.com/g/g-p-.../project");
  }
  const url = route.chatUrl === undefined ? undefined : normalizeChatUrl(route.chatUrl) ?? undefined;
  if (route.chatUrl !== undefined && !url) {
    throw new Error("chat URL must identify a ChatGPT conversation");
  }
  assertProjectChatMatch(projectUrl, url);
  const surfaceGeneration = route.surfaceGeneration === undefined
    ? undefined
    : optionalSurfaceGeneration(route.surfaceGeneration, "surface generation");
  const surfaceTabId = route.surfaceTabId === undefined
    ? undefined
    : optionalSafeId(route.surfaceTabId, "surface tab id");
  if ((surfaceGeneration === undefined) !== (surfaceTabId === undefined)) {
    throw new Error("surface route requires generation and tab id together");
  }
  return withFileLock(sessionStateLockFile(resolvedWorkspaceId), () => {
    const previous = readSessionUnlocked(resolvedWorkspaceId, resolvedLocalSessionId);
    const previousGeneration = previous?.surfaceGeneration;
    if (previousGeneration !== undefined) {
      if (surfaceGeneration === undefined) {
        throw new Error("surface route identity is required to update a committed route");
      }
      if (surfaceGeneration < previousGeneration) {
        throw new Error("surface route commit is stale");
      }
      if (surfaceGeneration === previousGeneration && previous?.surfaceTabId !== surfaceTabId) {
        throw new Error("surface route commit does not match the current tab");
      }
    }
    const saved = mergeSession(previous, {
      localSessionId: resolvedLocalSessionId,
      url,
      projectUrl,
      conversationMode: "project",
      connectorName: route.connectorName,
      surfaceGeneration,
      surfaceTabId,
    });
    return writeSessionUnlocked(resolvedWorkspaceId, saved, resolvedLocalSessionId);
  });
}

/**
 * Reconcile the checkout route from machine authority after a partial commit.
 * This intentionally bypasses the normal route CAS checks: the input is
 * already the protected machine binding, so an older or edited workspace
 * mirror must be replaced by that binding rather than winning the write.
 */
export function reconcileSessionRoute(
  workspaceId: string,
  localSessionId: string,
  authority: SessionRouteAuthority,
): SavedSession | null {
  const resolvedWorkspaceId = validatedWorkspaceId(workspaceId);
  const resolvedLocalSessionId = currentLocalSessionId(localSessionId);
  if (authority.projectUrl === null) {
    return clearSessionRoute(resolvedWorkspaceId, resolvedLocalSessionId, null);
  }
  const projectUrl = normalizeProjectUrl(authority.projectUrl);
  if (!projectUrl) {
    throw new Error("project URL must identify a ChatGPT Project");
  }
  const chatUrl = authority.chatUrl === undefined
    ? undefined
    : normalizeChatUrl(authority.chatUrl) ?? undefined;
  if (authority.chatUrl !== undefined && !chatUrl) {
    throw new Error("chat URL must identify a ChatGPT conversation");
  }
  assertProjectChatMatch(projectUrl, chatUrl ?? undefined);
  const surfaceGeneration = optionalSurfaceGeneration(authority.surfaceGeneration, "surface generation");
  const surfaceTabId = optionalSafeId(authority.surfaceTabId, "surface tab id");
  if ((surfaceGeneration === undefined) !== (surfaceTabId === undefined)) {
    throw new Error("surface route requires generation and tab id together");
  }
  return withFileLock(sessionStateLockFile(resolvedWorkspaceId), () => {
    const previous = readSessionUnlocked(resolvedWorkspaceId, resolvedLocalSessionId);
    const previousCheckpoint = previous?.checkpoint
      ? { ...previous.checkpoint, chatUrl, projectUrl }
      : undefined;
    const routeMatchesAuthority = Boolean(
      previous &&
      previous.projectUrl === projectUrl &&
      previous.url === chatUrl &&
      previous.surfaceGeneration === surfaceGeneration &&
      previous.surfaceTabId === surfaceTabId &&
      previous.checkpoint?.chatUrl === chatUrl &&
      previous.checkpoint?.projectUrl === projectUrl
    );
    if (routeMatchesAuthority) return previous;
    return writeSessionUnlocked(
      resolvedWorkspaceId,
      {
        ...(previous ?? {}),
        localSessionId: resolvedLocalSessionId,
        url: chatUrl,
        projectUrl,
        conversationMode: "project",
        connectorName: authority.connectorName ?? previous?.connectorName,
        surfaceGeneration,
        surfaceTabId,
        checkpoint: previousCheckpoint,
        savedAt: new Date().toISOString(),
      },
      resolvedLocalSessionId,
      { allowProjectRebind: true },
    );
  });
}

export function normalizeProjectUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (!isSecureChatGptUrl(parsed)) return null;
    const match = parsed.pathname.match(/^\/g\/(g-p-[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*)\/project\/?$/);
    if (!match) return null;
    return `https://chatgpt.com/g/${canonicalProjectId(match[1])}/project`;
  } catch {
    return null;
  }
}

export function normalizeChatUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (!isSecureChatGptUrl(parsed)) return null;
    const project = parsed.pathname.match(
      /^\/g\/(g-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\/c\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/?$/
    );
    if (project) return `https://chatgpt.com/g/${canonicalProjectId(project[1])}/c/${project[2]}`;
    return null;
  } catch {
    return null;
  }
}

function isSecureChatGptUrl(parsed: URL): boolean {
  return (
    parsed.protocol === "https:" &&
    !parsed.username &&
    !parsed.password &&
    !parsed.port &&
    (parsed.hostname === "chatgpt.com" || parsed.hostname === "www.chatgpt.com")
  );
}

function canonicalProjectId(segment: string): string {
  return segment.match(/^(g-p-[a-fA-F0-9]{32})(?:-|$)/)?.[1] ?? segment;
}

export function projectIdFromUrl(url: string): string | null {
  const normalized = normalizeProjectUrl(url);
  if (!normalized) return null;
  const segment = normalized.match(/\/g\/(g-p-[^/]+)\/project/)?.[1];
  if (!segment) return null;
  return canonicalProjectId(segment);
}

export function projectIdFromChatUrl(url: string): string | null {
  const normalized = normalizeChatUrl(url);
  if (!normalized) return null;
  const segment = normalized.match(/\/g\/(g-p-[^/]+)\/c\//)?.[1];
  return segment ? canonicalProjectId(segment) : null;
}

function assertProjectChatMatch(projectUrl: string | undefined, chatUrl: string | undefined): void {
  if (!chatUrl) return;
  if (!projectUrl) {
    throw new Error("chat URL requires a configured ChatGPT Project");
  }
  if (projectIdFromChatUrl(chatUrl) !== projectIdFromUrl(projectUrl)) {
    throw new Error("project chat URL must belong to the configured ChatGPT Project");
  }
}

export function resolveConversation(session: SavedSession | null): ConversationView {
  const localSessionId = currentLocalSessionId(session?.localSessionId);
  if (!session) {
    return {
      localSessionId,
      mode: "project",
      reason: "new-workspace",
      projectUrl: null,
      projectReady: false,
      chatUrl: null,
      connectorName: null,
      reuseSavedChat: false,
    };
  }

  const projectUrl = session.projectUrl ? normalizeProjectUrl(session.projectUrl) : null;
  const normalizedChatUrl = session.url ? normalizeChatUrl(session.url) : null;
  const projectReady = Boolean(projectUrl);

  if (projectReady) {
    const chatUrl =
      normalizedChatUrl && projectUrl && projectIdFromChatUrl(normalizedChatUrl) === projectIdFromUrl(projectUrl)
        ? normalizedChatUrl
        : null;
    return {
      localSessionId,
      mode: "project",
      reason: "project",
      projectUrl,
      projectReady,
      chatUrl,
      connectorName: session.connectorName ?? null,
      reuseSavedChat: Boolean(chatUrl),
    };
  }

  return {
    localSessionId,
    mode: "project",
    reason: "new-workspace",
    projectUrl: null,
    projectReady: false,
    chatUrl: null,
    connectorName: session.connectorName ?? null,
    reuseSavedChat: false,
  };
}

export function resolveConversationRoute(conversation: ConversationView): ConversationRoute {
  if (conversation.reuseSavedChat && conversation.chatUrl) {
    return {
      action: "resume-chat",
      targetUrl: conversation.chatUrl,
      expectedChatUrl: conversation.chatUrl,
      controlReady: true,
    };
  }
  if (conversation.projectUrl) {
    return {
      action: "create-project-chat",
      targetUrl: conversation.projectUrl,
      expectedChatUrl: null,
      controlReady: false,
    };
  }
  return { action: "bind-project", targetUrl: null, expectedChatUrl: null, controlReady: false };
}

function capCheckpointText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (UNSAFE_MULTILINE.test(trimmed)) throw new Error("checkpoint text contains unsafe control characters");
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export function mergeSession(previous: SavedSession | null, patch: RouteSessionPatch): SavedSession {
  const previousCheckpoint = previous?.checkpoint
    ? parseStoredCheckpoint(previous.checkpoint)
    : undefined;
  const previousTaskId = optionalSafeId(previous?.taskId, "previous task id");
  const previousIteration = optionalIteration(previous?.iteration, "previous iteration");
  const patchTaskId = optionalSafeId(patch.taskId, "task id");
  const checkpointTaskId = optionalSafeId(patch.checkpoint?.taskId, "checkpoint task id");
  if (patchTaskId && checkpointTaskId && patchTaskId !== checkpointTaskId) {
    throw new Error("checkpoint task does not match the requested task");
  }
  const taskId = checkpointTaskId ?? patchTaskId ?? previousTaskId;
  const patchIteration = optionalIteration(patch.iteration, "iteration");
  const checkpointIteration = optionalIteration(patch.checkpoint?.iteration, "checkpoint iteration");
  if (
    patchIteration !== undefined &&
    checkpointIteration !== undefined &&
    patchIteration !== checkpointIteration
  ) {
    throw new Error("checkpoint iteration does not match the requested iteration");
  }
  let iteration = checkpointIteration ?? patchIteration ?? previousIteration;
  if (
    previousCheckpoint &&
    !patch.checkpoint &&
    !patch.clearCheckpoint &&
    ((patchTaskId !== undefined && patchTaskId !== previousCheckpoint.taskId) ||
      (patchIteration !== undefined && patchIteration !== previousCheckpoint.iteration))
  ) {
    throw new Error("changing checkpoint correlation requires --protocol-state or --clear-checkpoint");
  }
  const conversationMode = patch.conversationMode ?? previous?.conversationMode;
  if (conversationMode !== undefined && conversationMode !== "project") {
    throw new Error("conversation mode is invalid");
  }
  const rawProjectUrl = patch.projectUrl ?? previous?.projectUrl;
  const projectUrl = rawProjectUrl ? (normalizeProjectUrl(rawProjectUrl) ?? undefined) : undefined;
  if (rawProjectUrl && !projectUrl) {
    throw new Error("project URL must look like https://chatgpt.com/g/g-p-.../project");
  }
  if (previous?.projectUrl && projectUrl) {
    const previousProjectUrl = normalizeProjectUrl(previous.projectUrl);
    if (!previousProjectUrl) {
      throw new Error("previous session contains an invalid ChatGPT Project URL");
    }
    if (previousProjectUrl !== projectUrl) {
      throw new Error("local session is already bound to a different ChatGPT Project");
    }
  }

  if (conversationMode === "project" && !projectUrl && !previous?.projectUrl) {
    throw new Error("project mode requires --project-url");
  }

  const rawUrl = patch.url ?? previous?.url;
  const url = rawUrl ? (normalizeChatUrl(rawUrl) ?? undefined) : undefined;
  if (rawUrl && !url) {
    throw new Error("chat URL must identify a ChatGPT conversation");
  }
  assertProjectChatMatch(projectUrl, url);
  const hasChat = Boolean(url);
  const hasProject = Boolean(projectUrl);
  const hasTask = Boolean(taskId);
  const hasCheckpoint = Boolean(patch.checkpoint || patch.clearCheckpoint || previous?.checkpoint);
  if (!hasChat && !hasProject && !hasTask && !hasCheckpoint) {
    throw new Error("nothing to save: pass --url, --project-url, or --mode");
  }

  let checkpoint = previousCheckpoint;
  if (patch.clearCheckpoint) {
    checkpoint = undefined;
  } else if (patch.checkpoint) {
    const clearMailbox = patch.clearMailbox === true;
    const requestedMailboxRequestId = optionalSafeId(
      patch.checkpoint.mailboxRequestId,
      "checkpoint mailbox request id"
    );
    const requestedMailboxResultId = optionalSafeId(
      patch.checkpoint.mailboxResultId,
      "checkpoint mailbox result id"
    );
    const requestedMailboxPhase = patch.checkpoint.mailboxPhase;
    if (
      requestedMailboxPhase !== undefined &&
      !CONTROL_PHASES.includes(requestedMailboxPhase)
    ) {
      throw new Error("checkpoint mailbox phase is invalid");
    }
    const mailboxRequestChanged =
      requestedMailboxRequestId !== undefined &&
      requestedMailboxRequestId !== previousCheckpoint?.mailboxRequestId;
    const checkpointTask = taskId ?? previousCheckpoint?.taskId;
    const checkpointTurn = iteration ?? previousCheckpoint?.iteration ?? 0;
    iteration = checkpointTurn;
    const protocolState = patch.checkpoint.protocolState ?? previousCheckpoint?.protocolState;
    if (!checkpointTask || !protocolState) {
      throw new Error("checkpoint requires task id and protocol state");
    }
    if (!PROTOCOL_STATES.includes(protocolState)) {
      throw new Error(`protocol-state must be one of ${PROTOCOL_STATES.join(", ")}`);
    }
    const waitingFor = patch.checkpoint.waitingFor ?? previousCheckpoint?.waitingFor ?? "none";
    if (!WAITING_FOR.includes(waitingFor)) {
      throw new Error(`waiting-for must be one of ${WAITING_FOR.join(", ")}`);
    }
    const mailboxCorrelationChanged =
      checkpointTask !== previousCheckpoint?.taskId || checkpointTurn !== previousCheckpoint?.iteration;
    const mailboxRequestId = clearMailbox
      ? undefined
      : requestedMailboxRequestId ??
        (mailboxCorrelationChanged ? undefined : previousCheckpoint?.mailboxRequestId);
    const mailboxPhase = clearMailbox
      ? undefined
      : requestedMailboxPhase ?? (mailboxCorrelationChanged ? undefined : previousCheckpoint?.mailboxPhase);
    const mailboxResultId = clearMailbox
      ? undefined
      : requestedMailboxResultId ??
        (mailboxRequestChanged || mailboxCorrelationChanged ? undefined : previousCheckpoint?.mailboxResultId);
    if (Boolean(mailboxRequestId) !== Boolean(mailboxPhase) || (mailboxResultId && !mailboxRequestId)) {
      throw new Error("mailbox checkpoint requires request id and phase together");
    }
    checkpoint = {
      taskId: checkpointTask,
      iteration: checkpointTurn,
      protocolState,
      waitingFor,
      originalGoal: capCheckpointText(
        patch.checkpoint.originalGoal ?? previousCheckpoint?.originalGoal,
        CHECKPOINT_LIMITS.originalGoal
      ),
      completedSubtasks: capCheckpointText(
        patch.checkpoint.completedSubtasks ?? previousCheckpoint?.completedSubtasks,
        CHECKPOINT_LIMITS.completedSubtasks
      ),
      knownIssues: capCheckpointText(
        patch.checkpoint.knownIssues ?? previousCheckpoint?.knownIssues,
        CHECKPOINT_LIMITS.knownIssues
      ),
      nextExpectedStep: capCheckpointText(
        patch.checkpoint.nextExpectedStep ?? previousCheckpoint?.nextExpectedStep,
        CHECKPOINT_LIMITS.nextExpectedStep
      ),
      // Checkpoints describe task progress. Their route fields are a legacy
      // mirror and must never be allowed to create or change a session route.
      chatUrl: url,
      projectUrl,
      mailboxRequestId,
      mailboxPhase,
      mailboxResultId,
      updatedAt: new Date().toISOString(),
    };
  } else if (checkpoint && (patch.url !== undefined || patch.projectUrl !== undefined)) {
    checkpoint = {
      ...checkpoint,
      chatUrl: patch.url !== undefined ? url : checkpoint.chatUrl,
      projectUrl: patch.projectUrl !== undefined ? projectUrl : checkpoint.projectUrl,
      updatedAt: new Date().toISOString(),
    };
  }

  if (checkpoint) {
    const validatedCheckpoint = parseStoredCheckpoint(checkpoint);
    if (!validatedCheckpoint) throw new Error("checkpoint is invalid");
    checkpoint = validatedCheckpoint;
    if (
      checkpoint.taskId !== taskId ||
      checkpoint.iteration !== iteration ||
      checkpoint.chatUrl !== url ||
      checkpoint.projectUrl !== projectUrl
    ) {
      throw new Error("checkpoint correlation does not match the merged session state");
    }
  }

  const localSessionId = currentLocalSessionId(patch.localSessionId ?? previous?.localSessionId);
  const title = optionalStoredText(
    patch.title ?? previous?.title,
    "local session title",
    SESSION_TEXT_LIMITS.title
  );
  const lastState = optionalStoredText(
    patch.lastState ?? previous?.lastState,
    "local session state",
    SESSION_TEXT_LIMITS.lastState
  );
  const connectorName = optionalStoredText(
    patch.connectorName ?? previous?.connectorName,
    "workspace connector name",
    SESSION_TEXT_LIMITS.connectorName
  );
  const surfaceGeneration = optionalSurfaceGeneration(
    patch.surfaceGeneration ?? previous?.surfaceGeneration,
    "surface generation",
  );
  const surfaceTabId = optionalSafeId(
    patch.surfaceTabId ?? previous?.surfaceTabId,
    "surface tab id",
  );
  if ((surfaceGeneration === undefined) !== (surfaceTabId === undefined)) {
    throw new Error("surface route requires generation and tab id together");
  }

  return {
    schemaVersion: 2,
    localSessionId,
    url,
    title,
    taskId,
    iteration,
    lastState,
    conversationMode: projectUrl ? "project" : undefined,
    projectUrl,
    connectorName,
    surfaceGeneration,
    surfaceTabId,
    checkpoint,
    savedAt: new Date().toISOString(),
  };
}

/** Drop the current chat pointer. Keep Project binding so the collection stays. */
export function clearChatPointer(
  workspaceId: string,
  localSessionId = currentLocalSessionId()
): { cleared: boolean; keptProject: boolean } {
  const resolvedWorkspaceId = validatedWorkspaceId(workspaceId);
  const resolvedLocalSessionId = currentLocalSessionId(localSessionId);
  return withFileLock(sessionStateLockFile(resolvedWorkspaceId), () => {
    const previous = readSessionUnlocked(resolvedWorkspaceId, resolvedLocalSessionId);
    if (!previous) return { cleared: false, keptProject: false };
    const view = resolveConversation(previous);
    const threadFile = threadSessionFile(resolvedWorkspaceId, view.localSessionId);
    const hadChat = Boolean(previous.url);
    const shouldKeepThread = Boolean(
      previous.taskId || previous.iteration !== undefined || previous.lastState || previous.checkpoint
    );
    if (shouldKeepThread) {
      writeSessionUnlocked(
        resolvedWorkspaceId,
        {
          ...previous,
          url: undefined,
          title: undefined,
          surfaceGeneration: undefined,
          surfaceTabId: undefined,
          checkpoint: previous.checkpoint
            ? { ...previous.checkpoint, chatUrl: undefined }
            : undefined,
          savedAt: new Date().toISOString(),
        },
        view.localSessionId
      );
    } else {
      fs.rmSync(threadFile, { force: true });
    }
    if (view.mode === "project" && view.projectUrl) {
      return { cleared: hadChat, keptProject: true };
    }
    if (!shouldKeepThread) {
      const workspace = readWorkspaceSession(resolvedWorkspaceId);
      const hasSharedConfiguration = Boolean(
        workspace?.conversationMode || workspace?.projectUrl || workspace?.connectorName
      );
      if (!hasSharedConfiguration) fs.rmSync(sessionFile(resolvedWorkspaceId), { force: true });
    }
    return { cleared: hadChat, keptProject: false };
  });
}

/** Clear a route during machine-authority reconciliation and keep Project/task state. */
export function clearSessionRoute(
  workspaceId: string,
  localSessionId = currentLocalSessionId(),
  projectUrl?: string | null,
): SavedSession | null {
  const resolvedWorkspaceId = validatedWorkspaceId(workspaceId);
  const resolvedLocalSessionId = currentLocalSessionId(localSessionId);
  const clearProjectBinding = projectUrl === null;
  const normalizedProjectUrl = projectUrl === undefined
    ? undefined
    : clearProjectBinding
      ? undefined
      : normalizeProjectUrl(projectUrl) ?? undefined;
  if (projectUrl !== undefined && !normalizedProjectUrl) {
    if (!clearProjectBinding) {
      throw new Error("project URL must identify a ChatGPT Project");
    }
  }
  return withFileLock(sessionStateLockFile(resolvedWorkspaceId), () => {
    const previous = readSessionUnlocked(resolvedWorkspaceId, resolvedLocalSessionId);
    if (!previous) return null;
    const view = resolveConversation(previous);
    const threadFile = threadSessionFile(resolvedWorkspaceId, view.localSessionId);
    const shouldKeepThread = Boolean(
      previous.taskId || previous.iteration !== undefined || previous.lastState || previous.checkpoint
    );
    if (shouldKeepThread) {
      writeSessionUnlocked(
        resolvedWorkspaceId,
        {
          ...previous,
          url: undefined,
          title: undefined,
          conversationMode: clearProjectBinding ? undefined : previous.conversationMode,
          projectUrl: clearProjectBinding ? undefined : normalizedProjectUrl ?? previous.projectUrl,
          connectorName: clearProjectBinding ? undefined : previous.connectorName,
          surfaceGeneration: undefined,
          surfaceTabId: undefined,
          checkpoint: previous.checkpoint
            ? {
                ...previous.checkpoint,
                chatUrl: undefined,
                projectUrl: clearProjectBinding
                  ? undefined
                  : normalizedProjectUrl ?? previous.checkpoint.projectUrl,
              }
            : undefined,
          savedAt: new Date().toISOString(),
        },
        view.localSessionId,
        {
          allowProjectRebind: clearProjectBinding || normalizedProjectUrl !== undefined,
          clearProjectBinding,
        },
      );
    } else {
      fs.rmSync(threadFile, { force: true });
      if (clearProjectBinding) {
        fs.rmSync(sessionFile(resolvedWorkspaceId), { force: true });
      } else if (normalizedProjectUrl !== undefined) {
        writeSessionUnlocked(
          resolvedWorkspaceId,
          {
            ...previous,
            url: undefined,
            title: undefined,
            projectUrl: normalizedProjectUrl,
            conversationMode: "project",
            surfaceGeneration: undefined,
            surfaceTabId: undefined,
            checkpoint: undefined,
            savedAt: new Date().toISOString(),
          },
          view.localSessionId,
          { allowProjectRebind: true },
        );
      }
    }
    return readSessionUnlocked(resolvedWorkspaceId, resolvedLocalSessionId);
  });
}

/** Permanently remove one local session's checkout-specific route and state. */
export function retireSession(
  workspaceId: string,
  localSessionId = currentLocalSessionId()
): boolean {
  const resolvedWorkspaceId = validatedWorkspaceId(workspaceId);
  const resolvedLocalSessionId = currentLocalSessionId(localSessionId);
  return withFileLock(sessionStateLockFile(resolvedWorkspaceId), () => {
    const file = threadSessionFile(resolvedWorkspaceId, resolvedLocalSessionId);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file);
    return true;
  });
}
