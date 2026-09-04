import path from "node:path";
import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import {
  ensureDir,
  getStateDir,
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

export type ConversationMode = "long-chat" | "project";

export type ConversationReason = "existing-long-chat" | "project" | "new-workspace";

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
  | "create-long-chat"
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
  checkpoint?: TaskCheckpoint;
}

export interface SessionPatch {
  localSessionId?: string;
  url?: string;
  title?: string;
  taskId?: string;
  iteration?: number;
  lastState?: string;
  conversationMode?: ConversationMode;
  projectUrl?: string;
  connectorName?: string;
  checkpoint?: Partial<TaskCheckpoint> & { protocolState?: ProtocolState };
  clearCheckpoint?: boolean;
  clearMailbox?: boolean;
}

export interface ConversationView {
  localSessionId: string;
  mode: ConversationMode;
  reason: ConversationReason;
  projectUrl: string | null;
  projectReady: boolean;
  chatUrl: string | null;
  connectorName: string | null;
  /** long-chat: Skill may goto chatUrl. project: only if this local Codex session already bound it. */
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
  return ensureDir(path.join(getStateDir(), "sessions", validatedWorkspaceId(workspaceId)));
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
  if (conversationMode !== undefined && conversationMode !== "long-chat" && conversationMode !== "project") {
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
      "savedAt",
    ],
    "local session state"
  );
  const url = optionalCanonicalChatUrl(value.url, "local session chat URL");
  const iteration = optionalIteration(value.iteration, "local session iteration");
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
  localSessionId = session.localSessionId ?? currentLocalSessionId()
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
  const conversationMode = session.conversationMode ?? previousWorkspace?.conversationMode;
  if (conversationMode !== undefined && conversationMode !== "long-chat" && conversationMode !== "project") {
    throw new Error("workspace session conversation mode is invalid");
  }
  const parsedCheckpoint = session.checkpoint ? parseStoredCheckpoint(session.checkpoint) : undefined;
  const rawProjectUrl = session.projectUrl ?? parsedCheckpoint?.projectUrl ?? previousWorkspace?.projectUrl;
  const projectUrl = rawProjectUrl ? (normalizeProjectUrl(rawProjectUrl) ?? undefined) : undefined;
  if (rawProjectUrl && !projectUrl) {
    throw new Error("project URL must look like https://chatgpt.com/g/g-p-.../project");
  }
  if (conversationMode === "project" && !projectUrl) {
    throw new Error("project mode requires a project URL");
  }
  const rawUrl = session.url ?? parsedCheckpoint?.chatUrl;
  const url = rawUrl ? (normalizeChatUrl(rawUrl) ?? undefined) : undefined;
  if (rawUrl && !url) {
    throw new Error("chat URL must identify a ChatGPT conversation");
  }
  assertProjectChatMatch(conversationMode, projectUrl, url);
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
    session.connectorName ?? previousWorkspace?.connectorName,
    "workspace connector name",
    SESSION_TEXT_LIMITS.connectorName
  );
  let checkpoint: TaskCheckpoint | undefined;
  if (parsedCheckpoint) {
    if (taskId !== parsedCheckpoint.taskId || iteration !== parsedCheckpoint.iteration) {
      throw new Error("checkpoint correlation does not match its local session state");
    }
    if (url && parsedCheckpoint.chatUrl && parsedCheckpoint.chatUrl !== url) {
      throw new Error("checkpoint chat URL does not match its local session state");
    }
    if (projectUrl && parsedCheckpoint.projectUrl && parsedCheckpoint.projectUrl !== projectUrl) {
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
    url || title || taskId || iteration !== undefined || lastState || checkpoint
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
  return withFileLock(sessionStateLockFile(resolvedWorkspaceId), () => {
    const saved = mergeSession(readSessionUnlocked(resolvedWorkspaceId, resolvedLocalSessionId), {
      ...patch,
      localSessionId: resolvedLocalSessionId,
    });
    return writeSessionUnlocked(resolvedWorkspaceId, saved, resolvedLocalSessionId);
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
    const direct = parsed.pathname.match(/^\/c\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/?$/);
    if (direct) return `https://chatgpt.com/c/${direct[1]}`;
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

function assertProjectChatMatch(
  mode: ConversationMode | undefined,
  projectUrl: string | undefined,
  chatUrl: string | undefined
): void {
  if (mode !== "project" || !projectUrl || !chatUrl) return;
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

  if (session.conversationMode === "long-chat") {
    return {
      localSessionId,
      mode: "long-chat",
      reason: "existing-long-chat",
      projectUrl: null,
      projectReady: false,
      chatUrl: normalizedChatUrl,
      connectorName: session.connectorName ?? null,
      reuseSavedChat: Boolean(normalizedChatUrl),
    };
  }

  if (session.conversationMode === "project" || projectReady) {
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
    mode: "long-chat",
    reason: "existing-long-chat",
    projectUrl: null,
    projectReady: false,
    chatUrl: normalizedChatUrl,
    connectorName: session.connectorName ?? null,
    reuseSavedChat: Boolean(normalizedChatUrl),
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
  if (conversation.mode === "project") {
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
  return {
    action: "create-long-chat",
    targetUrl: "https://chatgpt.com/",
    expectedChatUrl: null,
    controlReady: false,
  };
}

function capCheckpointText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (UNSAFE_MULTILINE.test(trimmed)) throw new Error("checkpoint text contains unsafe control characters");
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export function mergeSession(previous: SavedSession | null, patch: SessionPatch): SavedSession {
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
  if (conversationMode !== undefined && conversationMode !== "long-chat" && conversationMode !== "project") {
    throw new Error("conversation mode is invalid");
  }
  const rawProjectUrl = patch.projectUrl ?? previous?.projectUrl;
  const projectUrl = rawProjectUrl ? (normalizeProjectUrl(rawProjectUrl) ?? undefined) : undefined;
  if (rawProjectUrl && !projectUrl) {
    throw new Error("project URL must look like https://chatgpt.com/g/g-p-.../project");
  }

  if (conversationMode === "project" && !projectUrl && !previous?.projectUrl) {
    throw new Error("project mode requires --project-url");
  }

  const rawUrl = patch.url ?? previous?.url;
  const url = rawUrl ? (normalizeChatUrl(rawUrl) ?? undefined) : undefined;
  if (rawUrl && !url) {
    throw new Error("chat URL must identify a ChatGPT conversation");
  }
  assertProjectChatMatch(conversationMode, projectUrl, url);
  const hasChat = Boolean(url);
  const hasProject = Boolean(projectUrl);
  const hasTask = Boolean(taskId);
  const hasCheckpoint = Boolean(patch.checkpoint || patch.clearCheckpoint || previous?.checkpoint);
  if (!hasChat && !hasProject && conversationMode !== "long-chat" && !hasTask && !hasCheckpoint) {
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
      chatUrl: patch.checkpoint.chatUrl ?? previousCheckpoint?.chatUrl ?? url,
      projectUrl: patch.checkpoint.projectUrl ?? previousCheckpoint?.projectUrl ?? projectUrl,
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

  return {
    schemaVersion: 2,
    localSessionId,
    url,
    title,
    taskId,
    iteration,
    lastState,
    conversationMode: conversationMode === "project" && projectUrl ? "project" : conversationMode,
    projectUrl,
    connectorName,
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
