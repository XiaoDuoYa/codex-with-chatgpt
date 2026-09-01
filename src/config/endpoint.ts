import { createHash } from "node:crypto";
import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "./paths.js";

export const CHATGPT_DEVELOPER_MODE_URL = "https://chatgpt.com/#settings/Security";
export const CHATGPT_PLUGINS_URL = "https://chatgpt.com/plugins";
export const CHATGPT_CREATE_CONNECTOR_URL =
  "https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins";

export const DEFAULT_CONNECTOR_NAME = "Codex with ChatGPT";
export const ENDPOINT_STATE_VERSION = 2;

export interface EndpointObservation {
  port: number;
  publicUrl: string | null;
  mcpUrl: string | null;
}

export interface ConnectorBinding extends EndpointObservation {
  connectorName: string;
  generation: number;
  fingerprint: string;
  boundAt: string;
}

export type ConnectorRepairReason = "first_setup" | "address_changed" | "legacy_state";

export interface PendingConnectorRepair {
  connectorName: string;
  generation: number;
  fingerprint: string;
  observed: EndpointObservation;
  previous: ConnectorBinding | null;
  reason: ConnectorRepairReason;
  createdAt: string;
}

/**
 * Endpoint state deliberately separates what the bridge currently observes
 * from the endpoint that the ChatGPT connector was explicitly bound to.
 * `connectorBound` is advanced only by `connector commit`.
 */
export interface LastEndpoint {
  version: typeof ENDPOINT_STATE_VERSION;
  workspaceId: string;
  observed: EndpointObservation;
  connectorBound: ConnectorBinding | null;
  pendingRepair: PendingConnectorRepair | null;
  migratedFromLegacy?: boolean;
  savedAt: string;
}

interface LegacyEndpoint {
  workspaceId: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string | null;
  connectorName?: string;
  savedAt?: string;
}

export function endpointFile(workspaceId: string): string {
  return path.join(getStateDir(), "endpoints", `${workspaceId}.json`);
}

function validObservation(value: unknown): value is EndpointObservation {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<EndpointObservation>;
  return (
    typeof row.port === "number" &&
    Number.isFinite(row.port) &&
    (typeof row.publicUrl === "string" || row.publicUrl === null) &&
    (typeof row.mcpUrl === "string" || row.mcpUrl === null)
  );
}

function validBinding(value: unknown): value is ConnectorBinding {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<ConnectorBinding>;
  return (
    validObservation(value) &&
    typeof row.connectorName === "string" &&
    typeof row.generation === "number" &&
    Number.isInteger(row.generation) &&
    row.generation > 0 &&
    typeof row.fingerprint === "string" &&
    row.fingerprint.length > 0 &&
    typeof row.boundAt === "string"
  );
}

function validPending(value: unknown): value is PendingConnectorRepair {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<PendingConnectorRepair>;
  return (
    validObservation(row.observed) &&
    (row.previous === null || validBinding(row.previous)) &&
    typeof row.connectorName === "string" &&
    typeof row.generation === "number" &&
    Number.isInteger(row.generation) &&
    row.generation > 0 &&
    typeof row.fingerprint === "string" &&
    row.fingerprint.length > 0 &&
    (row.reason === "first_setup" || row.reason === "address_changed" || row.reason === "legacy_state") &&
    typeof row.createdAt === "string"
  );
}

function validState(value: unknown, workspaceId: string): value is LastEndpoint {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<LastEndpoint>;
  return (
    row.version === ENDPOINT_STATE_VERSION &&
    row.workspaceId === workspaceId &&
    validObservation(row.observed) &&
    (row.connectorBound === null || validBinding(row.connectorBound)) &&
    (row.pendingRepair === null || validPending(row.pendingRepair)) &&
    typeof row.savedAt === "string"
  );
}

function legacyState(value: unknown, workspaceId: string): LegacyEndpoint | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<LegacyEndpoint>;
  if (
    row.workspaceId !== workspaceId ||
    !validObservation({ port: row.port, publicUrl: row.publicUrl, mcpUrl: row.mcpUrl })
  ) {
    return null;
  }
  return {
    workspaceId,
    port: row.port as number,
    publicUrl: row.publicUrl as string | null,
    mcpUrl: row.mcpUrl as string | null,
    connectorName: typeof row.connectorName === "string" ? row.connectorName : undefined,
    savedAt: typeof row.savedAt === "string" ? row.savedAt : undefined,
  };
}

function endpointIdentity(
  workspaceId: string,
  connectorName: string,
  generation: number,
  mcpUrl: string | null
): string {
  return createHash("sha256")
    .update(`${workspaceId}\0${connectorName}\0${generation}\0${normalizePublicUrl(mcpUrl ?? "")}`)
    .digest("hex")
    .slice(0, 32);
}

export function connectorBindingFingerprint(binding: {
  workspaceId: string;
  connectorName: string;
  generation: number;
  mcpUrl: string | null;
}): string {
  return endpointIdentity(binding.workspaceId, binding.connectorName, binding.generation, binding.mcpUrl);
}

function bindingName(state: LastEndpoint | null, workspaceName: string, workspaceId: string): string {
  return connectorNameFor({
    workspaceName,
    workspaceId,
    previousName:
      state?.connectorBound?.connectorName ??
      state?.pendingRepair?.connectorName ??
      null,
    hadEndpointBefore: Boolean(state),
  });
}

function legacyToState(legacy: LegacyEndpoint): LastEndpoint {
  const observed: EndpointObservation = {
    port: legacy.port,
    publicUrl: legacy.publicUrl,
    mcpUrl: legacy.mcpUrl,
  };
  const name = legacy.connectorName?.trim() || DEFAULT_CONNECTOR_NAME;
  const pending =
    observed.mcpUrl === null
      ? null
      : {
          connectorName: name,
          generation: 1,
          fingerprint: endpointIdentity(legacy.workspaceId, name, 1, observed.mcpUrl),
          observed,
          previous: null,
          reason: "legacy_state" as const,
          createdAt: legacy.savedAt ?? new Date(0).toISOString(),
        };
  return {
    version: ENDPOINT_STATE_VERSION,
    workspaceId: legacy.workspaceId,
    observed,
    connectorBound: null,
    pendingRepair: pending,
    migratedFromLegacy: true,
    savedAt: legacy.savedAt ?? new Date(0).toISOString(),
  };
}

/**
 * Read and normalize endpoint state without writing. Legacy state is treated
 * as unbound, so an old saved conversation cannot become valid by accident.
 */
export function readLastEndpoint(workspaceId: string): LastEndpoint | null {
  const raw = readJsonIfExists<unknown>(endpointFile(workspaceId));
  if (validState(raw, workspaceId)) return raw;
  const legacy = legacyState(raw, workspaceId);
  return legacy ? legacyToState(legacy) : null;
}

export function writeLastEndpoint(state: Omit<LastEndpoint, "savedAt">): LastEndpoint;
export function writeLastEndpoint(legacy: LegacyEndpoint): LastEndpoint;
export function writeLastEndpoint(input: Omit<LastEndpoint, "savedAt"> | LegacyEndpoint): LastEndpoint {
  const state =
    "observed" in input
      ? ({ ...input, savedAt: new Date().toISOString() } satisfies LastEndpoint)
      : { ...legacyToState(input), savedAt: new Date().toISOString() };
  writeSecureJson(endpointFile(state.workspaceId), state);
  return state;
}

export interface ObserveEndpointOptions {
  workspaceId: string;
  workspaceName: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string | null;
  previous?: LastEndpoint | null;
}

export function previewWorkspaceEndpoint(opts: ObserveEndpointOptions): LastEndpoint {
  const previous = opts.previous ?? readLastEndpoint(opts.workspaceId);
  const observed: EndpointObservation = {
    port: opts.port,
    publicUrl: opts.publicUrl,
    mcpUrl: opts.mcpUrl,
  };
  const name = bindingName(previous, opts.workspaceName, opts.workspaceId);
  const sameAsPending = previous?.pendingRepair
    ? normalizePublicUrl(previous.pendingRepair.observed.mcpUrl ?? "") === normalizePublicUrl(opts.mcpUrl ?? "")
    : false;
  const sameAsBound = previous?.connectorBound
    ? normalizePublicUrl(previous.connectorBound.mcpUrl ?? "") === normalizePublicUrl(opts.mcpUrl ?? "")
    : false;

  let pending = previous?.pendingRepair ?? null;
  if (sameAsBound) {
    // A transient address change can resolve back to the committed connector.
    // There is no replacement to authorize in that case.
    pending = null;
  } else if (opts.mcpUrl && !sameAsPending) {
    const generation =
      Math.max(previous?.connectorBound?.generation ?? 0, previous?.pendingRepair?.generation ?? 0) + 1;
    pending = {
      connectorName: name,
      generation,
      fingerprint: endpointIdentity(opts.workspaceId, name, generation, opts.mcpUrl),
      observed,
      previous: previous?.connectorBound ?? null,
      reason: previous?.connectorBound || previous?.pendingRepair ? "address_changed" : "first_setup",
      createdAt: new Date().toISOString(),
    };
  } else if (pending && sameAsPending) {
    pending = { ...pending, observed };
  }

  return {
    version: ENDPOINT_STATE_VERSION,
    workspaceId: opts.workspaceId,
    observed,
    connectorBound: previous?.connectorBound ?? null,
    pendingRepair: pending,
    migratedFromLegacy: previous?.migratedFromLegacy,
    savedAt: previous?.savedAt ?? new Date(0).toISOString(),
  };
}

export function observeWorkspaceEndpoint(opts: ObserveEndpointOptions): LastEndpoint {
  const next = previewWorkspaceEndpoint(opts);
  return writeLastEndpoint(next);
}

export function commitConnectorBinding(opts: {
  state: LastEndpoint;
  generation: number;
  fingerprint: string;
}): LastEndpoint {
  const pending = opts.state.pendingRepair;
  if (!pending) throw new Error("C2C_CONNECTOR_REPAIR_NOT_PENDING: doctor has no connector replacement to commit");
  if (pending.generation !== opts.generation || pending.fingerprint !== opts.fingerprint) {
    throw new Error("C2C_CONNECTOR_BINDING_MISMATCH: generation or fingerprint is not the current repair");
  }
  if (
    !pending.observed.mcpUrl ||
    normalizePublicUrl(pending.observed.mcpUrl) !== normalizePublicUrl(opts.state.observed.mcpUrl ?? "")
  ) {
    throw new Error("C2C_CONNECTOR_ENDPOINT_CHANGED: run doctor again before committing the connector");
  }
  const boundAt = new Date().toISOString();
  const connectorBound: ConnectorBinding = {
    ...pending.observed,
    connectorName: pending.connectorName,
    generation: pending.generation,
    fingerprint: pending.fingerprint,
    boundAt,
  };
  return writeLastEndpoint({
    ...opts.state,
    connectorBound,
    pendingRepair: null,
    migratedFromLegacy: undefined,
  });
}

export function normalizePublicUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

export function mcpUrlFromPublic(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null;
  const base = normalizePublicUrl(publicUrl).replace(/\/mcp$/, "");
  return `${base}/mcp`;
}

/** Kept for callers that compare arbitrary endpoint URLs. */
export function connectorAction(
  previousMcpUrl: string | null | undefined,
  nextMcpUrl: string | null | undefined
): "none" | "create" | "update" {
  if (!nextMcpUrl) return "none";
  if (!previousMcpUrl) return "create";
  return normalizePublicUrl(previousMcpUrl) === normalizePublicUrl(nextMcpUrl) ? "none" : "update";
}

export function sanitizeConnectorLabel(name: string, workspaceId: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}._\- ]+/gu, "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 40) || workspaceId.slice(0, 6);
}

/**
 * Same workspace keeps one connector title forever.
 * A workspace already recorded without a title stays on the original
 * "Codex with ChatGPT" name. A new workspace gets a distinct title.
 */
export function connectorNameFor(opts: {
  workspaceName: string;
  workspaceId: string;
  previousName?: string | null;
  hadEndpointBefore: boolean;
}): string {
  if (opts.previousName?.trim()) return opts.previousName.trim();
  if (opts.hadEndpointBefore) return DEFAULT_CONNECTOR_NAME;
  return `${DEFAULT_CONNECTOR_NAME} · ${sanitizeConnectorLabel(opts.workspaceName, opts.workspaceId)}`;
}

export function reclaimUserMessage(connectorName: string): string {
  return `当前项目的安全连接地址已经失效。我会删除「${connectorName}」再按新地址加回去，其它项目的连接不动。由于重建会生成新的连接器身份，旧 ChatGPT 会话不能继续复用；请在新连接器上新建会话并重新保存会话地址。请稍等。`;
}
