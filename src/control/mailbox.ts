import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  advanceControlPageObservation,
  controlHostFailureSchema,
  controlHostObservedResultSchema,
  controlTerminalObservationSchema,
  controlWaitPolicy,
  CONTROL_PAGE_CHECK_INTERVAL_MS,
  parseControlPageObservation,
  type ControlHostFailure,
  type ControlHostObservedResult,
  type ControlPageObservation,
  type ControlPageObservationState,
  type ControlTerminalObservation,
} from "./wait-policy.js";
import {
  ensureDir,
  getStateDir,
  readJsonIfExists,
  withFileLock,
  writeSecureJson,
  writeSecureJsonExclusive,
} from "../config/paths.js";
import {
  allowedKindsForPhase,
  canonicalJson,
  ControlMailboxError,
  MAX_C2C_ITERATION,
  type ControlPhase,
  type ControlProgressEnvelope,
  type ControlProgressReceipt,
  type ControlResultCorrelation,
  type ControlResultEnvelope,
  type ControlResultReceipt,
  type ControlResultRequest,
  parseControlResultSubmission,
  parseSubmitControlResultInput,
  parseStoredSubmitControlResultInput,
  parseReportControlProgressInput,
  type ReportControlProgressInput,
  sha256Hex,
  type SubmitControlResultInput,
  validateControlId,
  validateBrowserTabId,
  validateLocalSessionId,
} from "./result-schema.js";

const REQUEST_TTL_MS = 30 * 60 * 1000;
const MIN_REQUEST_TTL_MS = 1_000;
const MAX_REQUEST_TTL_MS = 60 * 60_000;
const RETAIN_TERMINAL_MS = 7 * 24 * 60 * 60 * 1000;

export type ControlRequestStatus =
  | "pending"
  | "received"
  | "acknowledged"
  | "expired"
  | "cancelled"
  | "not_found";

export interface OpenControlResultRequestInput extends ControlResultCorrelation {
  localSessionId: string;
  surfaceGeneration?: number;
  surfaceTabId?: string;
  ttlMs?: number;
}

export interface ControlStatus {
  requestId: string;
  status: ControlRequestStatus;
  request: ControlResultRequest | null;
  result: ControlResultEnvelope | null;
  progress: ControlProgressEnvelope | null;
  hostFailure?: ControlHostFailure;
  hostObservedResult?: ControlHostObservedResult;
  pageObservation?: ControlPageObservationState;
}

/**
 * Resolve the machine-owned mailbox root.
 *
 * Control results are security-sensitive coordination state. They must not be
 * stored below a checkout or any other workspace-writable directory: a local
 * process in that workspace could otherwise forge a request, result, or
 * terminal marker. The machine gateway is the production owner of this path.
 */
export function getControlMailboxDir(workspaceId: string): string {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  return ensureDir(path.join(getStateDir(), "control-mailbox", resolvedWorkspaceId));
}

function workspaceDir(workspaceId: string): string {
  return getControlMailboxDir(workspaceId);
}

function requestsDir(workspaceId: string): string {
  return ensureDir(path.join(workspaceDir(workspaceId), "requests"));
}

function resultsDir(workspaceId: string): string {
  return ensureDir(path.join(workspaceDir(workspaceId), "results"));
}

function progressDir(workspaceId: string): string {
  return ensureDir(path.join(workspaceDir(workspaceId), "progress"));
}

function observationsDir(workspaceId: string): string {
  return ensureDir(path.join(workspaceDir(workspaceId), "observations"));
}

function acksDir(workspaceId: string): string {
  return ensureDir(path.join(workspaceDir(workspaceId), "acks"));
}

function cancelledDir(workspaceId: string): string {
  return ensureDir(path.join(workspaceDir(workspaceId), "cancelled"));
}

function activeDir(workspaceId: string): string {
  return ensureDir(path.join(workspaceDir(workspaceId), "active"));
}

function locksDir(workspaceId: string): string {
  return ensureDir(path.join(workspaceDir(workspaceId), "locks"));
}

function requestFile(workspaceId: string, requestId: string): string {
  return path.join(requestsDir(workspaceId), `${validateControlId(requestId, "request id")}.json`);
}

function renewalFile(workspaceId: string, requestId: string): string {
  return path.join(ensureDir(path.join(workspaceDir(workspaceId), "renewals")), `${validateControlId(requestId, "request id")}.json`);
}

function resultFile(workspaceId: string, requestId: string): string {
  return path.join(resultsDir(workspaceId), `${validateControlId(requestId, "request id")}.json`);
}

function progressFile(workspaceId: string, requestId: string): string {
  return path.join(progressDir(workspaceId), `${validateControlId(requestId, "request id")}.json`);
}

function observationFile(workspaceId: string, requestId: string): string {
  return path.join(observationsDir(workspaceId), `${validateControlId(requestId, "request id")}.json`);
}

function ackFile(workspaceId: string, requestId: string): string {
  return path.join(acksDir(workspaceId), `${validateControlId(requestId, "request id")}.json`);
}

function cancelledFile(workspaceId: string, requestId: string): string {
  return path.join(cancelledDir(workspaceId), `${validateControlId(requestId, "request id")}.json`);
}

function activeFile(workspaceId: string, localSessionId: string): string {
  return path.join(activeDir(workspaceId), `${validateLocalSessionId(localSessionId)}.json`);
}

function requestLockFile(workspaceId: string, requestId: string): string {
  return path.join(locksDir(workspaceId), `${validateControlId(requestId, "request id")}.lock`);
}

function sessionLifecycleLockFile(workspaceId: string, localSessionId: string): string {
  return path.join(
    ensureDir(path.join(locksDir(workspaceId), "sessions")),
    `${validateLocalSessionId(localSessionId)}.lock`
  );
}

function pruneLockFile(workspaceId: string): string {
  return path.join(locksDir(workspaceId), "prune.lock");
}

function integrityError(message: string): never {
  throw new ControlMailboxError("MAILBOX_INTEGRITY_ERROR", message);
}

function readStoredJson(file: string, label: string): unknown | null {
  const value = readJsonIfExists<unknown>(file);
  if (value === null && fs.existsSync(file)) {
    integrityError(`${label} is unreadable or malformed`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function storedId(value: unknown, label: string, validate = validateControlId): string {
  if (typeof value !== "string") integrityError(`${label} is missing`);
  try {
    const normalized = validate(value, label);
    if (normalized !== value) integrityError(`${label} is not canonical`);
    return normalized;
  } catch (error) {
    if (error instanceof ControlMailboxError && error.code === "MAILBOX_INTEGRITY_ERROR") throw error;
    return integrityError(`${label} is invalid`);
  }
}

type TerminalMarkerKind = "acknowledged" | "cancelled";

function terminalMarkerFile(
  workspaceId: string,
  requestId: string,
  kind: TerminalMarkerKind
): string {
  return kind === "acknowledged"
    ? ackFile(workspaceId, requestId)
    : cancelledFile(workspaceId, requestId);
}

function terminalMarkerTimestampField(kind: TerminalMarkerKind): "acknowledgedAt" | "cancelledAt" {
  return kind === "acknowledged" ? "acknowledgedAt" : "cancelledAt";
}

function parseStoredHostFailure(
  value: unknown,
  requestId: string,
): ControlHostFailure | null {
  const current = controlHostFailureSchema.safeParse(value);
  if (current.success) return current.data;
  if (!isRecord(value) || value.state !== "blocked") return null;

  // Older terminal records predate ordered response observations. Normalize
  // them only for retained terminal-state reads; the synthetic identity never
  // participates in routing, renewal, or BOOT authorization.
  const legacy = controlHostFailureSchema.safeParse({
    ...value,
    state: "final",
    responseId: `legacy-${requestId}`,
    observationSequence: 1,
  });
  return legacy.success ? legacy.data : null;
}

function readTerminalMarker(
  workspaceId: string,
  request: ControlResultRequest,
  kind: TerminalMarkerKind
): { timestamp: string; hostFailure?: ControlHostFailure; hostObservedResult?: ControlHostObservedResult } | null {
  const value = readStoredJson(
    terminalMarkerFile(workspaceId, request.requestId, kind),
    `${kind} request marker`
  );
  if (value === null) return null;
  const timestampField = terminalMarkerTimestampField(kind);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !hasExactKeys(value, [
      "schemaVersion",
      "requestId",
      "workspaceId",
      "localSessionId",
      "taskId",
      "iteration",
      "phase",
      timestampField,
      ...(kind === "cancelled" && value.hostFailure !== undefined ? ["hostFailure"] : []),
      ...(kind === "cancelled" && value.hostObservedResult !== undefined ? ["hostObservedResult"] : []),
    ])
  ) {
    integrityError(`${kind} request marker schema is invalid`);
  }
  const timestamp = value[timestampField];
  if (
    storedId(value.requestId, `${kind} marker request id`) !== request.requestId ||
    storedId(value.workspaceId, `${kind} marker workspace id`) !== workspaceId ||
    storedId(value.localSessionId, `${kind} marker local session id`) !== request.localSessionId ||
    storedId(value.taskId, `${kind} marker task id`) !== request.taskId ||
    value.iteration !== request.iteration ||
    value.phase !== request.phase ||
    !isCanonicalTimestamp(timestamp)
  ) {
    integrityError(`${kind} request marker does not match the exact control request`);
  }
  let hostFailure: ControlHostFailure | undefined;
  if (value.hostFailure !== undefined) {
    const parsed = parseStoredHostFailure(value.hostFailure, request.requestId);
    if (!parsed || parsed.responseToRequestId !== request.requestId) {
      integrityError("cancelled request observation is invalid");
    }
    hostFailure = parsed;
  }
  let hostObservedResult: ControlHostObservedResult | undefined;
  if (value.hostObservedResult !== undefined) {
    const parsed = controlHostObservedResultSchema.safeParse(value.hostObservedResult);
    if (
      !parsed.success ||
      (hostFailure !== undefined && parsed.data.observedAt !== hostFailure.observedAt) ||
      !request.allowedKinds.includes(parsed.data.result.kind)
    ) {
      integrityError("cancelled request host-observed result is invalid");
    }
    hostObservedResult = parsed.data;
  }
  return {
    timestamp,
    ...(hostFailure ? { hostFailure } : {}),
    ...(hostObservedResult ? { hostObservedResult } : {}),
  };
}

function writeTerminalMarker(
  workspaceId: string,
  request: ControlResultRequest,
  kind: TerminalMarkerKind,
  hostFailure?: ControlHostFailure,
  hostObservedResult?: ControlHostObservedResult,
): void {
  const timestampField = terminalMarkerTimestampField(kind);
  const marker = {
    schemaVersion: 1,
    requestId: request.requestId,
    workspaceId,
    localSessionId: request.localSessionId,
    taskId: request.taskId,
    iteration: request.iteration,
    phase: request.phase,
    [timestampField]: new Date().toISOString(),
    ...(hostFailure ? { hostFailure } : {}),
    ...(hostObservedResult ? { hostObservedResult } : {}),
  };
  const file = terminalMarkerFile(workspaceId, request.requestId, kind);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      writeSecureJsonExclusive(file, marker);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (readTerminalMarker(workspaceId, request, kind) !== null) return;
    }
  }
  throw new ControlMailboxError(
    "MAILBOX_INTEGRITY_ERROR",
    `${kind} request marker changed concurrently; retry`
  );
}

function normalizeCorrelation(correlation: ControlResultCorrelation): ControlResultCorrelation {
  const taskId = validateControlId(correlation.taskId, "task id");
  if (
    !Number.isInteger(correlation.iteration) ||
    correlation.iteration < 0 ||
    correlation.iteration > MAX_C2C_ITERATION
  ) {
    throw new ControlMailboxError("INVALID_RESULT", "iteration must be an integer between 0 and 10000");
  }
  if (!(["BOOT", "RESEARCH", "PLAN", "REVIEW"] as const).includes(correlation.phase)) {
    throw new ControlMailboxError("INVALID_RESULT", "phase must be BOOT, RESEARCH, PLAN, or REVIEW");
  }
  return { taskId, iteration: correlation.iteration, phase: correlation.phase };
}

function parseStoredRequest(
  value: unknown,
  workspaceId: string,
  requestId: string
): ControlResultRequest {
  const legacyKeys = [
    "schemaVersion",
    "requestId",
    "workspaceId",
    "localSessionId",
    "taskId",
    "iteration",
    "phase",
    "allowedKinds",
    "createdAt",
    "expiresAt",
  ] as const;
  const transitionalKeys = [...legacyKeys, "surfaceGeneration"] as const;
  const currentKeys = [...transitionalKeys, "surfaceTabId"] as const;
  const legacy = isRecord(value) && value.schemaVersion === 1 && hasExactKeys(value, legacyKeys);
  const transitional = isRecord(value) && value.schemaVersion === 1 && hasExactKeys(value, transitionalKeys);
  const current = isRecord(value) && value.schemaVersion === 2 && hasExactKeys(value, currentKeys);
  if (
    !isRecord(value) ||
    (!legacy && !transitional && !current)
  ) {
    integrityError("stored request schema is invalid");
  }
  const storedRequestId = storedId(value.requestId, "stored request id");
  const storedWorkspaceId = storedId(value.workspaceId, "stored workspace id");
  const localSessionId = storedId(value.localSessionId, "stored local session id");
  const taskId = storedId(value.taskId, "stored task id");
  const iteration = value.iteration;
  const phase = value.phase;
  if (
    !Number.isInteger(iteration) ||
    (iteration as number) < 0 ||
    (iteration as number) > MAX_C2C_ITERATION
  ) {
    integrityError("stored request iteration is invalid");
  }
  if (
    phase !== "BOOT" &&
    phase !== "RESEARCH" &&
    phase !== "PLAN" &&
    phase !== "REVIEW"
  ) {
    integrityError("stored request phase is invalid");
  }
  const surfaceGeneration = legacy ? null : value.surfaceGeneration;
  const surfaceTabId = current ? value.surfaceTabId : null;
  if (
    surfaceGeneration !== null &&
    (!Number.isSafeInteger(surfaceGeneration) || (surfaceGeneration as number) < 1)
  ) {
    integrityError("stored request surface generation is invalid");
  }
  if (surfaceTabId !== null) {
    storedId(surfaceTabId, "stored request surface tab id", validateBrowserTabId);
  }
  if ((surfaceGeneration === null) !== (surfaceTabId === null) && current) {
    integrityError("stored request surface identity is incomplete");
  }
  const expectedKinds = allowedKindsForPhase(phase);
  if (!Array.isArray(value.allowedKinds) || canonicalJson(value.allowedKinds) !== canonicalJson(expectedKinds)) {
    integrityError("stored request allowed kinds do not match its phase");
  }
  if (
    !isCanonicalTimestamp(value.createdAt) ||
    !isCanonicalTimestamp(value.expiresAt) ||
    Date.parse(value.expiresAt) <= Date.parse(value.createdAt)
  ) {
    integrityError("stored request timestamps are invalid");
  }
  if (storedRequestId !== requestId || storedWorkspaceId !== workspaceId) {
    integrityError("stored request does not match its mailbox path");
  }
  return {
    schemaVersion: 2,
    requestId: storedRequestId,
    workspaceId: storedWorkspaceId,
    localSessionId,
    taskId,
    iteration: iteration as number,
    phase,
    allowedKinds: expectedKinds,
    surfaceGeneration: surfaceGeneration as number | null,
    surfaceTabId: surfaceTabId as string | null,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

function readRequest(workspaceId: string, requestId: string): ControlResultRequest | null {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  const resolvedRequestId = validateControlId(requestId, "request id");
  const value = readStoredJson(requestFile(resolvedWorkspaceId, resolvedRequestId), "stored request");
  return value === null ? null : applyRequestRenewal(parseStoredRequest(value, resolvedWorkspaceId, resolvedRequestId));
}

// A single atomic renewal record extends both immutable request copies without a two-file update.
function applyRequestRenewal(request: ControlResultRequest): ControlResultRequest {
  const value = readStoredJson(renewalFile(request.workspaceId, request.requestId), "request renewal");
  if (value === null) return request;
  if (!isRecord(value) || !hasExactKeys(value, ["request", "expiresAt"])) {
    integrityError("request renewal schema is invalid");
  }
  const original = parseStoredRequest(value.request, request.workspaceId, request.requestId);
  if (
    canonicalJson(original) !== canonicalJson(request) ||
    !isCanonicalTimestamp(value.expiresAt) || Date.parse(value.expiresAt) < Date.parse(request.expiresAt)
  ) integrityError("request renewal does not match the original request");
  return { ...request, expiresAt: value.expiresAt };
}

function ensureRequestFile(workspaceId: string, request: ControlResultRequest): void {
  try {
    writeSecureJsonExclusive(requestFile(workspaceId, request.requestId), request);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readRequest(workspaceId, request.requestId);
    if (!existing || canonicalJson(existing) !== canonicalJson(request)) {
      integrityError("stored request conflicts with the active request pointer");
    }
  }
}

function readActiveRequest(workspaceId: string, localSessionId: string): ControlResultRequest | null {
  const value = readStoredJson(activeFile(workspaceId, localSessionId), "active request pointer");
  if (value === null) return null;
  if (!isRecord(value)) integrityError("active request pointer schema is invalid");
  const requestId = storedId(value.requestId, "active pointer request id");
  const request = parseStoredRequest(value, workspaceId, requestId);
  if (request.localSessionId !== localSessionId) {
    integrityError("active request pointer belongs to another local session");
  }
  return applyRequestRenewal(request);
}

function claimActiveRequest(workspaceId: string, request: ControlResultRequest): boolean {
  try {
    writeSecureJsonExclusive(activeFile(workspaceId, request.localSessionId), request);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function clearActiveRequest(workspaceId: string, localSessionId: string, requestId: string): void {
  if (readActiveRequest(workspaceId, localSessionId)?.requestId === requestId) {
    fs.rmSync(activeFile(workspaceId, localSessionId), { force: true });
  }
}

function readResult(workspaceId: string, request: ControlResultRequest): ControlResultEnvelope | null {
  const value = readStoredJson(resultFile(workspaceId, request.requestId), "stored result");
  if (value === null) return null;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !hasExactKeys(value, [
      "schemaVersion",
      "requestId",
      "workspaceId",
      "localSessionId",
      "taskId",
      "iteration",
      "phase",
      "kind",
      "payload",
      "receivedAt",
      "payloadHash",
      "resultId",
    ])
  ) {
    integrityError("stored result schema is invalid");
  }

  let submitted: SubmitControlResultInput;
  try {
    submitted = parseStoredSubmitControlResultInput({
      requestId: value.requestId,
      localSessionId: value.localSessionId,
      taskId: value.taskId,
      iteration: value.iteration,
      phase: value.phase,
      kind: value.kind,
      payload: value.payload,
    });
  } catch {
    return integrityError("stored result payload or correlation fields are invalid");
  }

  const localSessionId = storedId(value.localSessionId, "stored result local session id");
  const storedWorkspaceId = storedId(value.workspaceId, "stored result workspace id");
  if (
    submitted.requestId !== request.requestId ||
    storedWorkspaceId !== workspaceId ||
    localSessionId !== request.localSessionId ||
    submitted.localSessionId !== request.localSessionId ||
    submitted.taskId !== request.taskId ||
    submitted.iteration !== request.iteration ||
    submitted.phase !== request.phase ||
    !request.allowedKinds.includes(submitted.kind)
  ) {
    integrityError("stored result does not match the exact control request");
  }
  if (!isCanonicalTimestamp(value.receivedAt)) {
    integrityError("stored result timestamp is invalid");
  }
  const payloadHash = sha256Hex(canonicalJson(submitted));
  if (value.payloadHash !== payloadHash || value.resultId !== payloadHash.slice(0, 24)) {
    integrityError("stored result integrity hash does not match its content");
  }

  return {
    schemaVersion: 1,
    requestId: request.requestId,
    workspaceId: storedWorkspaceId,
    localSessionId,
    taskId: submitted.taskId,
    iteration: submitted.iteration,
    phase: submitted.phase,
    kind: submitted.kind,
    payload: submitted.payload,
    receivedAt: value.receivedAt,
    payloadHash,
    resultId: payloadHash.slice(0, 24),
  };
}

const CONTROL_PROGRESS_RANK = {
  SEARCHING: 0,
  READING_CODE: 1,
  SYNTHESIZING: 2,
} as const;

function readProgress(
  workspaceId: string,
  request: ControlResultRequest
): ControlProgressEnvelope | null {
  const value = readStoredJson(progressFile(workspaceId, request.requestId), "stored progress");
  if (value === null) return null;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !hasExactKeys(value, [
      "schemaVersion",
      "requestId",
      "workspaceId",
      "localSessionId",
      "taskId",
      "iteration",
      "phase",
      "status",
      "message",
      "reportedAt",
      "progressHash",
      "progressId",
    ])
  ) {
    integrityError("stored progress schema is invalid");
  }

  let reported: ReportControlProgressInput;
  try {
    reported = parseReportControlProgressInput({
      requestId: value.requestId,
      localSessionId: value.localSessionId,
      taskId: value.taskId,
      iteration: value.iteration,
      phase: value.phase,
      status: value.status,
      ...(value.message === null ? {} : { message: value.message }),
    });
  } catch {
    return integrityError("stored progress payload or correlation fields are invalid");
  }

  const localSessionId = storedId(value.localSessionId, "stored progress local session id");
  const storedWorkspaceId = storedId(value.workspaceId, "stored progress workspace id");
  if (
    reported.requestId !== request.requestId ||
    storedWorkspaceId !== workspaceId ||
    localSessionId !== request.localSessionId ||
    reported.localSessionId !== request.localSessionId ||
    reported.taskId !== request.taskId ||
    reported.iteration !== request.iteration ||
    reported.phase !== request.phase
  ) {
    integrityError("stored progress does not match the exact control request");
  }
  if (!isCanonicalTimestamp(value.reportedAt)) {
    integrityError("stored progress timestamp is invalid");
  }
  const progressHash = sha256Hex(canonicalJson(reported));
  if (value.progressHash !== progressHash || value.progressId !== progressHash.slice(0, 24)) {
    integrityError("stored progress integrity hash does not match its content");
  }

  return {
    schemaVersion: 1,
    requestId: request.requestId,
    workspaceId: storedWorkspaceId,
    localSessionId,
    taskId: reported.taskId,
    iteration: reported.iteration,
    phase: reported.phase,
    status: reported.status,
    message: reported.message ?? null,
    reportedAt: value.reportedAt,
    progressHash,
    progressId: progressHash.slice(0, 24),
  };
}

function readPageObservation(
  workspaceId: string,
  request: ControlResultRequest,
): ControlPageObservationState | null {
  const value = readStoredJson(
    observationFile(workspaceId, request.requestId),
    "stored page observation",
  );
  if (value === null) return null;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !hasExactKeys(value, [
      "schemaVersion",
      "requestId",
      "workspaceId",
      "localSessionId",
      "latest",
      "lastDefinitive",
      "observationHash",
    ])
  ) {
    integrityError("stored page observation schema is invalid");
  }
  const requestId = storedId(value.requestId, "stored page observation request id");
  const storedWorkspaceId = storedId(value.workspaceId, "stored page observation workspace id");
  const localSessionId = storedId(value.localSessionId, "stored page observation local session id");
  if (
    requestId !== request.requestId ||
    storedWorkspaceId !== workspaceId ||
    localSessionId !== request.localSessionId
  ) {
    integrityError("stored page observation does not match the exact control request");
  }
  let latest: ControlPageObservation;
  let lastDefinitive: ControlPageObservationState["lastDefinitive"];
  try {
    latest = parseControlPageObservation(value.latest);
    lastDefinitive = value.lastDefinitive === null
      ? null
      : parseControlPageObservation(value.lastDefinitive) as ControlPageObservationState["lastDefinitive"];
  } catch {
    return integrityError("stored page observation payload is invalid");
  }
  if (
    latest.responseToRequestId !== request.requestId ||
    (lastDefinitive !== null && lastDefinitive.responseToRequestId !== request.requestId) ||
    (latest.state !== "unknown" && canonicalJson(latest) !== canonicalJson(lastDefinitive))
  ) {
    integrityError("stored page observation lifecycle is invalid");
  }
  const state = { latest, lastDefinitive };
  const observationHash = sha256Hex(canonicalJson(state));
  if (value.observationHash !== observationHash) {
    integrityError("stored page observation integrity hash does not match its content");
  }
  return state;
}

function writePageObservation(
  workspaceId: string,
  request: ControlResultRequest,
  state: ControlPageObservationState,
): void {
  writeSecureJson(observationFile(workspaceId, request.requestId), {
    schemaVersion: 1,
    requestId: request.requestId,
    workspaceId,
    localSessionId: request.localSessionId,
    ...state,
    observationHash: sha256Hex(canonicalJson(state)),
  });
}

function isExpired(request: ControlResultRequest, now = Date.now()): boolean {
  return now > Date.parse(request.expiresAt);
}

function readTerminalState(
  workspaceId: string,
  request: ControlResultRequest
): {
  kind: TerminalMarkerKind;
  timestamp: string;
  hostFailure?: ControlHostFailure;
  hostObservedResult?: ControlHostObservedResult;
} | null {
  const acknowledgedAt = readTerminalMarker(workspaceId, request, "acknowledged");
  const cancelledAt = readTerminalMarker(workspaceId, request, "cancelled");
  if (acknowledgedAt && cancelledAt) {
    integrityError("control result request has conflicting terminal markers");
  }
  if (acknowledgedAt) return { kind: "acknowledged", ...acknowledgedAt };
  if (cancelledAt) return { kind: "cancelled", ...cancelledAt };
  return null;
}

function isUnfinished(workspaceId: string, request: ControlResultRequest): boolean {
  if (readTerminalState(workspaceId, request) !== null) return false;
  return readResult(workspaceId, request) !== null || !isExpired(request);
}

function listRequests(workspaceId: string): ControlResultRequest[] {
  const dir = requestsDir(workspaceId);
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readRequest(workspaceId, name.slice(0, -".json".length)))
    .filter((request): request is ControlResultRequest => Boolean(request));
}

function matchesCorrelation(request: ControlResultRequest, expected: ControlResultCorrelation): boolean {
  return (
    request.taskId === expected.taskId &&
    request.iteration === expected.iteration &&
    request.phase === expected.phase
  );
}

function assertCorrelation(request: ControlResultRequest, expected: ControlResultCorrelation): void {
  const normalized = normalizeCorrelation(expected);
  if (!matchesCorrelation(request, normalized)) {
    throw new ControlMailboxError(
      "MAILBOX_CORRELATION_MISMATCH",
      "control result request does not match the expected task, iteration, and phase"
    );
  }
}

function turnInProgress(request: ControlResultRequest): never {
  throw new ControlMailboxError(
    "MAILBOX_TURN_IN_PROGRESS",
    `local session already has unfinished request ${request.requestId} ` +
      `(${request.taskId}/${request.iteration}/${request.phase}); resume or cancel it before asking another question`
  );
}

export function openControlResultRequest(
  workspaceId: string,
  input: OpenControlResultRequestInput
): ControlResultRequest {
  return openControlResultRequestWithStatus(workspaceId, input).request;
}

export interface OpenControlResultRequestStatus {
  request: ControlResultRequest;
  created: boolean;
}

/** Open a request and report whether this call created it or recovered it. */
export function openControlResultRequestWithStatus(
  workspaceId: string,
  input: OpenControlResultRequestInput
): OpenControlResultRequestStatus {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  const localSessionId = validateLocalSessionId(input.localSessionId);
  const correlation = normalizeCorrelation(input);
  const ttlMs = input.ttlMs ?? REQUEST_TTL_MS;
  if (
    input.surfaceGeneration !== undefined &&
    (!Number.isSafeInteger(input.surfaceGeneration) || input.surfaceGeneration < 1)
  ) {
    throw new ControlMailboxError("INVALID_RESULT", "surface generation must be a positive safe integer");
  }
  const surfaceTabId = input.surfaceTabId === undefined
    ? null
    : validateBrowserTabId(input.surfaceTabId, "surface tab id");
  if ((input.surfaceGeneration === undefined) !== (surfaceTabId === null)) {
    throw new ControlMailboxError(
      "INVALID_RESULT",
      "surface generation and surface tab id must be supplied together",
    );
  }
  if (!Number.isInteger(ttlMs) || ttlMs < MIN_REQUEST_TTL_MS || ttlMs > MAX_REQUEST_TTL_MS) {
    throw new ControlMailboxError(
      "INVALID_RESULT",
      `request lifetime must be an integer between ${MIN_REQUEST_TTL_MS} and ${MAX_REQUEST_TTL_MS} milliseconds`
    );
  }
  return withFileLock(sessionLifecycleLockFile(resolvedWorkspaceId, localSessionId), () => {
    const activeRequest = readActiveRequest(resolvedWorkspaceId, localSessionId);
    if (activeRequest) {
      const unfinished = withFileLock(
        requestLockFile(resolvedWorkspaceId, activeRequest.requestId),
        () => isUnfinished(resolvedWorkspaceId, activeRequest),
      );
      if (unfinished) {
        if (!matchesCorrelation(activeRequest, correlation)) turnInProgress(activeRequest);
        ensureRequestFile(resolvedWorkspaceId, activeRequest);
        return { request: activeRequest, created: false };
      }
      clearActiveRequest(resolvedWorkspaceId, localSessionId, activeRequest.requestId);
    }

    const now = Date.now();
    const request: ControlResultRequest = {
      schemaVersion: 2,
      requestId: randomBytes(24).toString("hex"),
      workspaceId: resolvedWorkspaceId,
      localSessionId,
      taskId: correlation.taskId,
      iteration: correlation.iteration,
      phase: correlation.phase,
      allowedKinds: allowedKindsForPhase(correlation.phase),
      surfaceGeneration: input.surfaceGeneration ?? null,
      surfaceTabId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    if (!claimActiveRequest(resolvedWorkspaceId, request)) {
      integrityError("local session active request changed while its lifecycle lock was held");
    }
    try {
      ensureRequestFile(resolvedWorkspaceId, request);
      return { request, created: true };
    } catch (error) {
      clearActiveRequest(resolvedWorkspaceId, localSessionId, request.requestId);
      throw error;
    }
  });
}

export function submitControlResult(workspaceId: string, input: unknown): ControlResultReceipt {
  const parsed = parseSubmitControlResultInput(input);
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  const payloadHash = sha256Hex(canonicalJson(parsed));
  return withFileLock(requestLockFile(resolvedWorkspaceId, parsed.requestId), () => {
    const request = readRequest(resolvedWorkspaceId, parsed.requestId);
    if (!request) {
      throw new ControlMailboxError("MAILBOX_REQUEST_NOT_FOUND", "control result request was not found");
    }
    if (
      request.taskId !== parsed.taskId ||
      request.localSessionId !== parsed.localSessionId ||
      request.iteration !== parsed.iteration ||
      request.phase !== parsed.phase
    ) {
      throw new ControlMailboxError(
        "MAILBOX_CORRELATION_MISMATCH",
        "control result does not match the pending question"
      );
    }
    if (!request.allowedKinds.includes(parsed.kind)) {
      throw new ControlMailboxError("MAILBOX_KIND_NOT_ALLOWED", `${parsed.kind} is not allowed for ${request.phase}`);
    }

    const terminal = readTerminalState(resolvedWorkspaceId, request);
    const existing = readResult(resolvedWorkspaceId, request);
    if (terminal?.kind === "cancelled") {
      if (existing) integrityError("cancelled control result request unexpectedly contains a result");
      throw new ControlMailboxError("MAILBOX_REQUEST_CANCELLED", "control result request was cancelled");
    }
    if (terminal?.kind === "acknowledged" && !existing) {
      integrityError("acknowledged control result request has no result");
    }
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new ControlMailboxError("RESULT_ALREADY_SUBMITTED", "a different result was already submitted");
      }
      return {
        accepted: true,
        requestId: existing.requestId,
        localSessionId: existing.localSessionId,
        resultId: existing.resultId,
        phase: existing.phase,
        kind: existing.kind,
        receivedAt: existing.receivedAt,
        idempotentReplay: true,
      };
    }
    if (isExpired(request)) {
      throw new ControlMailboxError("MAILBOX_REQUEST_EXPIRED", "control result request has expired");
    }

    const envelope: ControlResultEnvelope = {
      schemaVersion: 1,
      requestId: request.requestId,
      workspaceId: resolvedWorkspaceId,
      localSessionId: request.localSessionId,
      taskId: parsed.taskId,
      iteration: parsed.iteration,
      phase: parsed.phase,
      kind: parsed.kind,
      payload: parsed.payload,
      receivedAt: new Date().toISOString(),
      payloadHash,
      resultId: payloadHash.slice(0, 24),
    };

    try {
      writeSecureJsonExclusive(resultFile(resolvedWorkspaceId, request.requestId), envelope);
      return {
        accepted: true,
        requestId: request.requestId,
        localSessionId: request.localSessionId,
        resultId: envelope.resultId,
        phase: envelope.phase,
        kind: envelope.kind,
        receivedAt: envelope.receivedAt,
        idempotentReplay: false,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const concurrent = readResult(resolvedWorkspaceId, request);
      if (concurrent?.payloadHash === payloadHash) {
        return {
          accepted: true,
          requestId: concurrent.requestId,
          localSessionId: concurrent.localSessionId,
          resultId: concurrent.resultId,
          phase: concurrent.phase,
          kind: concurrent.kind,
          receivedAt: concurrent.receivedAt,
          idempotentReplay: true,
        };
      }
      throw new ControlMailboxError("RESULT_ALREADY_SUBMITTED", "a different result was already submitted");
    }
  });
}

export function reportControlProgress(workspaceId: string, input: unknown): ControlProgressReceipt {
  const parsed = parseReportControlProgressInput(input);
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  const progressHash = sha256Hex(canonicalJson(parsed));
  return withFileLock(requestLockFile(resolvedWorkspaceId, parsed.requestId), () => {
    const request = readRequest(resolvedWorkspaceId, parsed.requestId);
    if (!request) {
      throw new ControlMailboxError("MAILBOX_REQUEST_NOT_FOUND", "control result request was not found");
    }
    if (
      request.taskId !== parsed.taskId ||
      request.localSessionId !== parsed.localSessionId ||
      request.iteration !== parsed.iteration ||
      request.phase !== parsed.phase
    ) {
      throw new ControlMailboxError(
        "MAILBOX_CORRELATION_MISMATCH",
        "control progress does not match the pending question"
      );
    }

    const terminal = readTerminalState(resolvedWorkspaceId, request);
    const result = readResult(resolvedWorkspaceId, request);
    if (request.phase === "BOOT") {
      throw new ControlMailboxError(
        "MAILBOX_PROGRESS_NOT_ALLOWED",
        "BOOT verification does not accept progress updates",
      );
    }
    if (terminal || result) {
      throw new ControlMailboxError(
        "MAILBOX_PROGRESS_NOT_ALLOWED",
        "control progress is accepted only while the request is pending"
      );
    }
    if (isExpired(request)) {
      throw new ControlMailboxError("MAILBOX_REQUEST_EXPIRED", "control result request has expired");
    }

    const existing = readProgress(resolvedWorkspaceId, request);
    if (existing) {
      if (existing.progressHash === progressHash) {
        return {
          accepted: true,
          requestId: existing.requestId,
          localSessionId: existing.localSessionId,
          progressId: existing.progressId,
          phase: existing.phase,
          status: existing.status,
          reportedAt: existing.reportedAt,
          idempotentReplay: true,
        };
      }
      if (CONTROL_PROGRESS_RANK[parsed.status] <= CONTROL_PROGRESS_RANK[existing.status]) {
        throw new ControlMailboxError(
          "MAILBOX_PROGRESS_OUT_OF_ORDER",
          `control progress cannot move from ${existing.status} to ${parsed.status}`
        );
      }
    }

    const envelope: ControlProgressEnvelope = {
      schemaVersion: 1,
      requestId: request.requestId,
      workspaceId: resolvedWorkspaceId,
      localSessionId: request.localSessionId,
      taskId: request.taskId,
      iteration: request.iteration,
      phase: request.phase,
      status: parsed.status,
      message: parsed.message ?? null,
      reportedAt: new Date().toISOString(),
      progressHash,
      progressId: progressHash.slice(0, 24),
    };
    writeSecureJson(progressFile(resolvedWorkspaceId, request.requestId), envelope);
    return {
      accepted: true,
      requestId: envelope.requestId,
      localSessionId: envelope.localSessionId,
      progressId: envelope.progressId,
      phase: envelope.phase,
      status: envelope.status,
      reportedAt: envelope.reportedAt,
      idempotentReplay: false,
    };
  });
}

/** Locate recovery work even when the checkout checkpoint was never written. */
export function getActiveControlResultStatus(workspaceId: string, localSessionId: string): ControlStatus | null {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  const resolvedLocalSessionId = validateLocalSessionId(localSessionId);
  return withFileLock(sessionLifecycleLockFile(resolvedWorkspaceId, resolvedLocalSessionId), () => {
    const request = readActiveRequest(resolvedWorkspaceId, resolvedLocalSessionId);
    return request ? getControlResultStatus(
      resolvedWorkspaceId, request.requestId, resolvedLocalSessionId, request,
    ) : null;
  });
}

export function getControlResultStatus(
  workspaceId: string,
  requestId: string,
  localSessionId: string,
  expected: ControlResultCorrelation
): ControlStatus {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  const resolvedRequestId = validateControlId(requestId, "request id");
  const resolvedLocalSessionId = validateLocalSessionId(localSessionId);
  const request = readRequest(resolvedWorkspaceId, resolvedRequestId);
  if (!request) {
    return { requestId: resolvedRequestId, status: "not_found", request: null, result: null, progress: null };
  }
  if (request.localSessionId !== resolvedLocalSessionId) {
    throw new ControlMailboxError("MAILBOX_SESSION_MISMATCH", "control result request belongs to another local session");
  }
  assertCorrelation(request, expected);
  const result = readResult(resolvedWorkspaceId, request);
  const progress = readProgress(resolvedWorkspaceId, request);
  const pageObservation = readPageObservation(resolvedWorkspaceId, request);
  const observed = pageObservation ? { pageObservation } : {};
  const terminal = readTerminalState(resolvedWorkspaceId, request);
  if (terminal?.kind === "acknowledged") {
    if (!result) integrityError("acknowledged control result request has no result");
    return { requestId: resolvedRequestId, status: "acknowledged", request, result, progress, ...observed };
  }
  if (terminal?.kind === "cancelled") {
    if (result) integrityError("cancelled control result request unexpectedly contains a result");
    return { requestId: resolvedRequestId, status: "cancelled", request, result: null, progress, ...observed,
      ...(terminal.hostFailure ? { hostFailure: terminal.hostFailure } : {}),
      ...(terminal.hostObservedResult ? { hostObservedResult: terminal.hostObservedResult } : {}) };
  }
  if (result) return { requestId: resolvedRequestId, status: "received", request, result, progress, ...observed };
  if (isExpired(request)) {
    return { requestId: resolvedRequestId, status: "expired", request, result: null, progress, ...observed };
  }
  return { requestId: resolvedRequestId, status: "pending", request, result: null, progress, ...observed };
}

/** Require an authoritative successful BOOT result for one exact candidate generation. */
export function requireBootControlResult(
  workspaceId: string,
  requestId: string,
  localSessionId: string,
  surfaceGeneration: number,
  surfaceTabId: string,
): ControlStatus {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  const resolvedRequestId = validateControlId(requestId, "request id");
  const resolvedLocalSessionId = validateLocalSessionId(localSessionId);
  const request = readRequest(resolvedWorkspaceId, resolvedRequestId);
  if (!request) {
    throw new ControlMailboxError("MAILBOX_REQUEST_NOT_FOUND", "BOOT result request was not found");
  }
  if (
    request.localSessionId !== resolvedLocalSessionId ||
    request.phase !== "BOOT" ||
    request.surfaceGeneration !== surfaceGeneration ||
    request.surfaceTabId !== validateBrowserTabId(surfaceTabId, "surface tab id")
  ) {
    throw new ControlMailboxError(
      "MAILBOX_CORRELATION_MISMATCH",
      "BOOT result does not match this candidate surface generation",
    );
  }
  const expected = { taskId: request.taskId, iteration: request.iteration, phase: request.phase };
  const status = getControlResultStatus(
    resolvedWorkspaceId,
    resolvedRequestId,
    resolvedLocalSessionId,
    expected,
  );
  const mailboxBoot = (status.status === "received" || status.status === "acknowledged") &&
    status.result?.kind === "BOOT";
  const computerUseBoot = status.status === "cancelled" &&
    status.hostFailure === undefined &&
    status.hostObservedResult?.result.kind === "BOOT";
  if (!mailboxBoot && !computerUseBoot) {
    throw new ControlMailboxError(
      "MAILBOX_RESULT_NOT_READY",
      "surface commit requires a successful BOOT result from the active result transport",
    );
  }
  return status;
}

export async function waitForControlResult(
  workspaceId: string,
  requestId: string,
  timeoutMs: number,
  localSessionId: string,
  expected: ControlResultCorrelation,
  signal?: AbortSignal,
): Promise<ControlStatus> {
  const throwIfAborted = (): void => {
    if (signal?.aborted) {
      throw signal.reason ?? Object.assign(new Error("control result wait aborted"), { name: "AbortError" });
    }
  };
  const waitForPoll = (delayMs: number): Promise<void> => {
    throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        signal?.removeEventListener("abort", onAbort);
      };
      const onTimer = (): void => {
        cleanup();
        resolve();
      };
      const onAbort = (): void => {
        cleanup();
        reject(signal?.reason ?? Object.assign(new Error("control result wait aborted"), { name: "AbortError" }));
      };
      timer = setTimeout(onTimer, delayMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  };
  let deadline: number | undefined;
  for (;;) {
    throwIfAborted();
    const status = getControlResultStatus(workspaceId, requestId, localSessionId, expected);
    if (status.status !== "pending") return status;
    deadline ??= Date.now() + Math.min(CONTROL_PAGE_CHECK_INTERVAL_MS, Math.max(0, timeoutMs), controlWaitPolicy(status).checkPageAfterMs);
    const remaining = Math.min(deadline, Date.parse(status.request!.expiresAt)) - Date.now();
    if (remaining <= 0) return status;
    await waitForPoll(Math.min(250, remaining));
  }
}

export function acknowledgeControlResult(
  workspaceId: string,
  requestId: string,
  localSessionId: string,
  expected: ControlResultCorrelation
): ControlStatus {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  const resolvedRequestId = validateControlId(requestId, "request id");
  const resolvedLocalSessionId = validateLocalSessionId(localSessionId);
  return withFileLock(sessionLifecycleLockFile(resolvedWorkspaceId, resolvedLocalSessionId), () =>
    withFileLock(requestLockFile(resolvedWorkspaceId, resolvedRequestId), () => {
      const status = getControlResultStatus(
        resolvedWorkspaceId,
        resolvedRequestId,
        resolvedLocalSessionId,
        expected
      );
      if (status.status === "not_found") {
        throw new ControlMailboxError("MAILBOX_REQUEST_NOT_FOUND", "control result request was not found");
      }
      if (status.status === "acknowledged") {
        clearActiveRequest(resolvedWorkspaceId, status.request!.localSessionId, resolvedRequestId);
        return getControlResultStatus(
          resolvedWorkspaceId,
          resolvedRequestId,
          resolvedLocalSessionId,
          expected,
        );
      }
      if (status.status !== "received") {
        throw new ControlMailboxError("MAILBOX_RESULT_NOT_READY", "control result cannot be acknowledged before receipt");
      }
      writeTerminalMarker(resolvedWorkspaceId, status.request!, "acknowledged");
      clearActiveRequest(resolvedWorkspaceId, status.request!.localSessionId, resolvedRequestId);
      return getControlResultStatus(
        resolvedWorkspaceId,
        resolvedRequestId,
        resolvedLocalSessionId,
        expected
      );
    })
  );
}

export function cancelControlResultRequest(
  workspaceId: string,
  requestId: string,
  localSessionId: string,
  expected: ControlResultCorrelation
): ControlStatus {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  const resolvedRequestId = validateControlId(requestId, "request id");
  const resolvedLocalSessionId = validateLocalSessionId(localSessionId);
  return withFileLock(sessionLifecycleLockFile(resolvedWorkspaceId, resolvedLocalSessionId), () =>
    withFileLock(requestLockFile(resolvedWorkspaceId, resolvedRequestId), () => {
      const status = getControlResultStatus(
        resolvedWorkspaceId,
        resolvedRequestId,
        resolvedLocalSessionId,
        expected
      );
      if (status.status === "not_found") {
        throw new ControlMailboxError("MAILBOX_REQUEST_NOT_FOUND", "control result request was not found");
      }
      if (status.status === "cancelled") {
        clearActiveRequest(resolvedWorkspaceId, status.request!.localSessionId, resolvedRequestId);
        return getControlResultStatus(
          resolvedWorkspaceId,
          resolvedRequestId,
          resolvedLocalSessionId,
          expected,
        );
      }
      if (status.status !== "pending") {
        throw new ControlMailboxError("MAILBOX_REQUEST_NOT_PENDING", "only a pending control result request can be cancelled");
      }
      writeTerminalMarker(resolvedWorkspaceId, status.request!, "cancelled");
      clearActiveRequest(resolvedWorkspaceId, status.request!.localSessionId, resolvedRequestId);
      return getControlResultStatus(
        resolvedWorkspaceId,
        resolvedRequestId,
        resolvedLocalSessionId,
        expected
      );
    })
  );
}

function terminalObservationRecords(observation: ControlTerminalObservation): {
  failure?: ControlHostFailure;
  hostObservedResult?: ControlHostObservedResult;
} {
  const terminalResultInput = observation.state === "final"
    ? observation.terminalResult
    : undefined;
  const isComputerUseResult = observation.state === "final" && "delivery" in observation;
  const failureInput = observation.state === "final"
    ? (({ terminalResult: _terminalResult, ...failure }) => failure)(observation)
    : observation;
  const failure = isComputerUseResult ? undefined : controlHostFailureSchema.parse(failureInput);
  const hostObservedResult = terminalResultInput
    ? controlHostObservedResultSchema.parse({
        provenance: "host_observed",
        observedAt: observation.observedAt,
        result: parseControlResultSubmission(terminalResultInput),
      })
    : undefined;
  return { failure, ...(hostObservedResult ? { hostObservedResult } : {}) };
}

/**
 * Persist one exact page lifecycle event and apply its mailbox effect under the
 * same request/session locks used by receipt, acknowledgement, and cancellation.
 */
export function observeControlResultRequest(
  workspaceId: string,
  requestId: string,
  localSessionId: string,
  expected: ControlResultCorrelation,
  observation: ControlPageObservation,
  renewAuthorization?: () => string,
): ControlStatus {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  const resolvedRequestId = validateControlId(requestId, "request id");
  const resolvedLocalSessionId = validateLocalSessionId(localSessionId);
  const parsed = parseControlPageObservation(observation);
  if (parsed.responseToRequestId !== resolvedRequestId) {
    throw new ControlMailboxError("MAILBOX_CORRELATION_MISMATCH", "page observation belongs to another response");
  }
  return withFileLock(sessionLifecycleLockFile(resolvedWorkspaceId, resolvedLocalSessionId), () =>
    withFileLock(requestLockFile(resolvedWorkspaceId, resolvedRequestId), () => {
      const status = getControlResultStatus(
        resolvedWorkspaceId,
        resolvedRequestId,
        resolvedLocalSessionId,
        expected,
      );
      if (status.status === "cancelled") {
        if (!status.hostFailure && !status.hostObservedResult) {
          clearActiveRequest(resolvedWorkspaceId, resolvedLocalSessionId, resolvedRequestId);
          return getControlResultStatus(
            resolvedWorkspaceId,
            resolvedRequestId,
            resolvedLocalSessionId,
            expected,
          );
        }
        const replay = advanceControlPageObservation(status.pageObservation ?? null, parsed);
        if (!replay.terminal) {
          throw new ControlMailboxError(
            "MAILBOX_CORRELATION_MISMATCH",
            "cancelled request can only replay its exact terminal observation",
          );
        }
        const records = terminalObservationRecords(replay.terminal);
        if (
          canonicalJson(records.failure) !== canonicalJson(status.hostFailure) ||
          canonicalJson(records.hostObservedResult ?? null) !== canonicalJson(status.hostObservedResult ?? null)
        ) {
          throw new ControlMailboxError(
            "MAILBOX_CORRELATION_MISMATCH",
            "terminal observation does not match the cancelled request",
          );
        }
        if (!replay.idempotentReplay) {
          writePageObservation(resolvedWorkspaceId, status.request!, replay.state);
        }
        clearActiveRequest(resolvedWorkspaceId, resolvedLocalSessionId, resolvedRequestId);
        return getControlResultStatus(
          resolvedWorkspaceId,
          resolvedRequestId,
          resolvedLocalSessionId,
          expected,
        );
      }
      if (status.status !== "pending") return status;
      const advanced = advanceControlPageObservation(status.pageObservation ?? null, parsed);
      if (advanced.idempotentReplay) return status;

      if (parsed.state === "generating") {
        if (!renewAuthorization) {
          throw new ControlMailboxError("INVALID_RESULT", "generating observation requires live authorization renewal");
        }
        const expiresAt = renewAuthorization();
        const expiry = Date.parse(expiresAt);
        if (!isCanonicalTimestamp(expiresAt) || expiry <= Date.now() || expiry > Date.now() + MAX_REQUEST_TTL_MS) {
          throw new ControlMailboxError("INVALID_RESULT", "invalid request renewal lifetime");
        }
        if (expiry > Date.parse(status.request!.expiresAt)) {
          const original = parseStoredRequest(
            readStoredJson(requestFile(resolvedWorkspaceId, resolvedRequestId), "stored request"),
            resolvedWorkspaceId,
            resolvedRequestId,
          );
          writeSecureJson(renewalFile(resolvedWorkspaceId, resolvedRequestId), { request: original, expiresAt });
        }
        writePageObservation(resolvedWorkspaceId, status.request!, advanced.state);
        return getControlResultStatus(
          resolvedWorkspaceId,
          resolvedRequestId,
          resolvedLocalSessionId,
          expected,
        );
      }

      if (!advanced.terminal) {
        writePageObservation(resolvedWorkspaceId, status.request!, advanced.state);
        return getControlResultStatus(
          resolvedWorkspaceId,
          resolvedRequestId,
          resolvedLocalSessionId,
          expected,
        );
      }

      const { failure, hostObservedResult } = terminalObservationRecords(advanced.terminal);
      if (hostObservedResult && !status.request!.allowedKinds.includes(hostObservedResult.result.kind)) {
        throw new ControlMailboxError(
          "MAILBOX_KIND_NOT_ALLOWED",
          `${hostObservedResult.result.kind} is not allowed for ${status.request!.phase}`,
        );
      }
      writeTerminalMarker(
        resolvedWorkspaceId,
        status.request!,
        "cancelled",
        failure,
        hostObservedResult,
      );
      writePageObservation(resolvedWorkspaceId, status.request!, advanced.state);
      clearActiveRequest(resolvedWorkspaceId, resolvedLocalSessionId, resolvedRequestId);
      return getControlResultStatus(
        resolvedWorkspaceId,
        resolvedRequestId,
        resolvedLocalSessionId,
        expected,
      );
    }),
  );
}

/** Host observations cancel pending work, never manufacture an MCP result. Receipt wins under the request lock. */
export function recordControlHostFailure(
  workspaceId: string,
  requestId: string,
  localSessionId: string,
  expected: ControlResultCorrelation,
  observation: ControlTerminalObservation,
): ControlStatus {
  const parsed = controlTerminalObservationSchema.safeParse(observation);
  if (!parsed.success) throw new ControlMailboxError("INVALID_RESULT", "invalid host failure observation");
  if (parsed.data.state === "final" && "delivery" in parsed.data) {
    throw new ControlMailboxError("INVALID_RESULT", "computer use results are not host failures");
  }
  const terminalResultInput = parsed.data.state === "final"
    ? parsed.data.terminalResult
    : undefined;
  const failureInput = parsed.data.state === "final"
    ? (({ terminalResult: _terminalResult, ...failure }) => failure)(parsed.data)
    : parsed.data;
  const terminalResult = terminalResultInput
    ? parseControlResultSubmission(terminalResultInput)
    : undefined;
  const failure = controlHostFailureSchema.parse(failureInput);
  if (failure.responseToRequestId !== requestId) {
    throw new ControlMailboxError("MAILBOX_CORRELATION_MISMATCH", "observation belongs to another response");
  }
  return withFileLock(sessionLifecycleLockFile(workspaceId, localSessionId), () =>
    withFileLock(requestLockFile(workspaceId, requestId), () => {
      const status = getControlResultStatus(workspaceId, requestId, localSessionId, expected);
      if (status.status !== "pending") return status;
      if (terminalResult && !status.request!.allowedKinds.includes(terminalResult.kind)) {
        throw new ControlMailboxError(
          "MAILBOX_KIND_NOT_ALLOWED",
          `${terminalResult.kind} is not allowed for ${status.request!.phase}`,
        );
      }
      const hostObservedResult = terminalResult ? controlHostObservedResultSchema.parse({
        provenance: "host_observed",
        observedAt: failure.observedAt,
        result: terminalResult,
      }) : undefined;
      writeTerminalMarker(workspaceId, status.request!, "cancelled", failure, hostObservedResult);
      clearActiveRequest(workspaceId, localSessionId, requestId);
      return getControlResultStatus(workspaceId, requestId, localSessionId, expected);
    }),
  );
}

/** Extend only pending work under the same locks used by receipts and cancellation. */
export function renewControlResultRequest(
  workspaceId: string,
  requestId: string,
  localSessionId: string,
  expected: ControlResultCorrelation,
  renewAuthorization: () => string,
): ControlStatus {
  return withFileLock(sessionLifecycleLockFile(workspaceId, localSessionId), () =>
    withFileLock(requestLockFile(workspaceId, requestId), () => {
      const status = getControlResultStatus(workspaceId, requestId, localSessionId, expected);
      if (status.status !== "pending") return status;
      const expiresAt = renewAuthorization();
      const expiry = Date.parse(expiresAt);
      if (!isCanonicalTimestamp(expiresAt) || expiry <= Date.now() || expiry > Date.now() + MAX_REQUEST_TTL_MS) {
        throw new ControlMailboxError("INVALID_RESULT", "invalid request renewal lifetime");
      }
      if (expiry > Date.parse(status.request!.expiresAt)) {
        const original = parseStoredRequest(readStoredJson(requestFile(workspaceId, requestId), "stored request"), workspaceId, requestId);
        writeSecureJson(renewalFile(workspaceId, requestId), { request: original, expiresAt });
      }
      return getControlResultStatus(workspaceId, requestId, localSessionId, expected);
    }),
  );
}

export interface RetireControlResultSessionSummary {
  localSessionId: string;
  pendingCancelled: number;
  receivedAcknowledged: number;
  activeRequestCleared: boolean;
}

/**
 * Retire every mailbox request owned by one local session. The session
 * lifecycle lock is acquired before each request lock, matching open,
 * acknowledge, and cancel operations. Received results are acknowledged as
 * discarded so a later session can open a fresh request without consuming the
 * old result; expired and already-terminal requests only lose the active
 * pointer.
 */
export function retireControlResultSession(
  workspaceId: string,
  localSessionId: string,
): RetireControlResultSessionSummary {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  const resolvedLocalSessionId = validateLocalSessionId(localSessionId);
  return withFileLock(sessionLifecycleLockFile(resolvedWorkspaceId, resolvedLocalSessionId), () => {
    let pendingCancelled = 0;
    let receivedAcknowledged = 0;

    for (const listedRequest of listRequests(resolvedWorkspaceId)) {
      if (listedRequest.localSessionId !== resolvedLocalSessionId) continue;
      withFileLock(requestLockFile(resolvedWorkspaceId, listedRequest.requestId), () => {
        const request = readRequest(resolvedWorkspaceId, listedRequest.requestId);
        if (!request || request.localSessionId !== resolvedLocalSessionId) return;
        const status = getControlResultStatus(
          resolvedWorkspaceId,
          request.requestId,
          resolvedLocalSessionId,
          {
            taskId: request.taskId,
            iteration: request.iteration,
            phase: request.phase,
          },
        );
        if (status.status === "pending") {
          writeTerminalMarker(resolvedWorkspaceId, request, "cancelled");
          pendingCancelled += 1;
        } else if (status.status === "received") {
          writeTerminalMarker(resolvedWorkspaceId, request, "acknowledged");
          receivedAcknowledged += 1;
        }
      });
    }

    const activeRequestCleared = readActiveRequest(resolvedWorkspaceId, resolvedLocalSessionId) !== null;
    if (activeRequestCleared) {
      const activeRequest = readActiveRequest(resolvedWorkspaceId, resolvedLocalSessionId);
      if (activeRequest) clearActiveRequest(resolvedWorkspaceId, resolvedLocalSessionId, activeRequest.requestId);
    }
    return {
      localSessionId: resolvedLocalSessionId,
      pendingCancelled,
      receivedAcknowledged,
      activeRequestCleared,
    };
  });
}

function pruneControlMailboxUnlocked(resolvedWorkspaceId: string, now: number): number {
  let removed = 0;
  for (const listedRequest of listRequests(resolvedWorkspaceId)) {
    removed += withFileLock(
      sessionLifecycleLockFile(resolvedWorkspaceId, listedRequest.localSessionId),
      () =>
        withFileLock(requestLockFile(resolvedWorkspaceId, listedRequest.requestId), () => {
          const request = readRequest(resolvedWorkspaceId, listedRequest.requestId);
          if (!request) return 0;
          const terminal = readTerminalState(resolvedWorkspaceId, request);
          // Request TTL limits submission; a delivered result belongs to the consumer until ack.
          if (!terminal && readResult(resolvedWorkspaceId, request)) return 0;
          const expiredAt = isExpired(request, now) ? Date.parse(request.expiresAt) : null;
          const terminalAt = terminal ? Date.parse(terminal.timestamp) : expiredAt;
          if (
            terminalAt === null ||
            !Number.isFinite(terminalAt) ||
            now - terminalAt <= RETAIN_TERMINAL_MS
          ) {
            return 0;
          }
          clearActiveRequest(resolvedWorkspaceId, request.localSessionId, request.requestId);
          for (const file of [
            requestFile(resolvedWorkspaceId, request.requestId),
            resultFile(resolvedWorkspaceId, request.requestId),
            progressFile(resolvedWorkspaceId, request.requestId),
            observationFile(resolvedWorkspaceId, request.requestId),
            ackFile(resolvedWorkspaceId, request.requestId),
            cancelledFile(resolvedWorkspaceId, request.requestId),
            renewalFile(resolvedWorkspaceId, request.requestId),
          ]) {
            fs.rmSync(file, { force: true });
          }
          return 1;
        })
    );
  }
  return removed;
}

export function pruneControlMailbox(workspaceId: string, now = Date.now()): number {
  const resolvedWorkspaceId = validateControlId(workspaceId, "workspace id");
  return withFileLock(pruneLockFile(resolvedWorkspaceId), () =>
    pruneControlMailboxUnlocked(resolvedWorkspaceId, now)
  );
}
