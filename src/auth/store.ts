import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export const SUPPORTED_SCOPES = [
  "workspace.read",
  "workspace.search",
  "git.read",
  "execution.read",
  "offline_access",
] as const;

export type Scope = (typeof SUPPORTED_SCOPES)[number];

export interface ClientRegistration {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: string;
}

export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  workspaceId: string;
  pairingSessionId: string;
  resource?: string;
  expiresAt: number;
}

export interface TokenRecord {
  hash: string;
  kind: "access" | "refresh";
  clientId: string;
  workspaceId: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

export interface PersistedAuthState {
  clients: ClientRegistration[];
  tokens: TokenRecord[];
}

export interface AuthStateMigrationResult {
  migrated: boolean;
  sourceFiles: string[];
  importedClients: number;
  importedTokens: number;
}

export type VerifyTokenResult =
  | { ok: true; record: TokenRecord }
  | { ok: false; reason: "unknown" | "expired" | "revoked" | "wrong_kind" };

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function authStoreFileFor(workspaceId: string): string {
  return path.join(ensureDir(path.join(getStateDir(), "auth")), `${workspaceId}.json`);
}

function migrationMarkerFileFor(targetFile: string): string {
  const parsed = path.parse(targetFile);
  return path.join(parsed.dir, `${parsed.name}.migration.json`);
}

interface AuthStateMigrationMarker {
  version: 1;
  migratedAt: string;
  sourceFiles: string[];
}

interface EndpointState {
  workspaceId?: unknown;
  publicUrl?: unknown;
  mcpUrl?: unknown;
}

function endpointUrl(endpoint: EndpointState | null): string | null {
  if (!endpoint) return null;
  if (typeof endpoint.mcpUrl === "string" && endpoint.mcpUrl.trim() !== "") return endpoint.mcpUrl;
  if (typeof endpoint.publicUrl === "string" && endpoint.publicUrl.trim() !== "") return `${endpoint.publicUrl}/mcp`;
  return null;
}

function legacyAuthCandidates(targetFile: string): string[] {
  const authDir = path.dirname(targetFile);
  let files: string[];
  try {
    files = fs
      .readdirSync(authDir)
      .filter((name) => name.endsWith(".json") && path.join(authDir, name) !== targetFile)
      .map((name) => path.join(authDir, name));
  } catch {
    return [];
  }

  // Prefer auth stores belonging to the same stable endpoint. This keeps an
  // upgrade from importing credentials for unrelated old connectors while
  // still finding the previous per-workspace store after a Gateway upgrade.
  const endpointDir = path.join(getStateDir(), "endpoints");
  const gatewayEndpoint = readJsonIfExists<EndpointState>(path.join(endpointDir, "gateway.json"));
  const gatewayUrl = endpointUrl(gatewayEndpoint);
  if (!gatewayUrl) return files;

  const matchingIds = new Set<string>();
  try {
    for (const name of fs.readdirSync(endpointDir)) {
      if (!name.endsWith(".json") || name === "gateway.json") continue;
      const endpoint = readJsonIfExists<EndpointState>(path.join(endpointDir, name));
      if (endpointUrl(endpoint) !== gatewayUrl) continue;
      const id = typeof endpoint?.workspaceId === "string" ? endpoint.workspaceId : path.basename(name, ".json");
      matchingIds.add(id);
    }
  } catch {
    // If endpoint state is unavailable, the caller can still recover by
    // considering all legacy auth files in this local state directory.
  }
  const linked = files.filter((file) => matchingIds.has(path.basename(file, ".json")));
  return linked.length > 0 ? linked : files;
}

/**
 * Import the previous per-workspace OAuth state into the shared Gateway.
 *
 * Only persisted hashes are copied; plaintext access/refresh tokens are never
 * reconstructed or logged. Imported records are rebound to `targetWorkspaceId`
 * so an existing ChatGPT authorization can keep using the stable connector.
 * A marker makes the upgrade one-shot, including after the user later revokes
 * all Gateway tokens.
 */
export function migrateLegacyAuthState(opts: {
  targetFile: string;
  targetWorkspaceId?: string;
}): AuthStateMigrationResult {
  const targetWorkspaceId = opts.targetWorkspaceId ?? "*";
  const markerFile = migrationMarkerFileFor(opts.targetFile);
  if (readJsonIfExists<AuthStateMigrationMarker>(markerFile)?.version === 1) {
    return { migrated: false, sourceFiles: [], importedClients: 0, importedTokens: 0 };
  }

  const target = readJsonIfExists<PersistedAuthState>(opts.targetFile);
  if ((target?.tokens ?? []).some((token) => !token.revoked && token.expiresAt > Date.now())) {
    // A Gateway that already has a live credential has either completed this
    // migration or was paired directly. Do not resurrect an old credential
    // after a later `unpair`.
    writeSecureJson(markerFile, {
      version: 1,
      migratedAt: new Date().toISOString(),
      sourceFiles: [],
    } satisfies AuthStateMigrationMarker);
    return { migrated: false, sourceFiles: [], importedClients: 0, importedTokens: 0 };
  }

  const sources = legacyAuthCandidates(opts.targetFile);
  const clients = new Map<string, ClientRegistration>();
  const tokens = new Map<string, TokenRecord>();
  for (const client of target?.clients ?? []) {
    if (client && typeof client.clientId === "string") clients.set(client.clientId, client);
  }
  for (const token of target?.tokens ?? []) {
    if (token && typeof token.hash === "string") tokens.set(token.hash, token);
  }

  const importedSources: string[] = [];
  let importedClientIds = new Set<string>();
  let importedTokenHashes = new Set<string>();
  for (const sourceFile of sources) {
    const source = readJsonIfExists<PersistedAuthState>(sourceFile);
    if (!source || !Array.isArray(source.tokens) || source.tokens.length === 0) continue;
    let importedFromSource = false;
    for (const client of source.clients ?? []) {
      if (client && typeof client.clientId === "string") {
        clients.set(client.clientId, client);
        importedClientIds.add(client.clientId);
        importedFromSource = true;
      }
    }
    for (const token of source.tokens) {
      if (
        !token ||
        typeof token.hash !== "string" ||
        (token.kind !== "access" && token.kind !== "refresh") ||
        token.revoked ||
        token.expiresAt <= Date.now()
      ) {
        continue;
      }
      tokens.set(token.hash, { ...token, workspaceId: targetWorkspaceId });
      importedTokenHashes.add(token.hash);
      importedFromSource = true;
    }
    if (importedFromSource) importedSources.push(sourceFile);
  }

  if (importedSources.length === 0) return { migrated: false, sourceFiles: [], importedClients: 0, importedTokens: 0 };

  writeSecureJson(opts.targetFile, { clients: [...clients.values()], tokens: [...tokens.values()] });
  writeSecureJson(markerFile, {
    version: 1,
    migratedAt: new Date().toISOString(),
    sourceFiles: importedSources,
  } satisfies AuthStateMigrationMarker);
  return {
    migrated: true,
    sourceFiles: importedSources,
    importedClients: [...importedClientIds].filter((id) => !(target?.clients ?? []).some((client) => client.clientId === id)).length,
    importedTokens: [...importedTokenHashes].filter((hash) => !(target?.tokens ?? []).some((token) => token.hash === hash)).length,
  };
}

function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Constant-time string comparison for equal-length inputs. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class AuthStore {
  private clients = new Map<string, ClientRegistration>();
  private tokens = new Map<string, TokenRecord>();
  private authCodes = new Map<string, AuthorizationCodeRecord>();
  private readonly file: string;

  constructor(
    readonly workspaceId: string,
    opts: { file?: string } = {}
  ) {
    this.file = opts.file ?? authStoreFileFor(workspaceId);
    this.load();
  }

  private load(): void {
    const data = readJsonIfExists<PersistedAuthState>(this.file);
    if (!data) return;
    const now = Date.now();
    for (const client of data.clients ?? []) this.clients.set(client.clientId, client);
    for (const token of data.tokens ?? []) {
      if (!token.revoked && token.expiresAt > now) this.tokens.set(token.hash, token);
    }
  }

  private save(): void {
    const now = Date.now();
    const state: PersistedAuthState = {
      clients: [...this.clients.values()],
      tokens: [...this.tokens.values()].filter((t) => !t.revoked && t.expiresAt > now),
    };
    writeSecureJson(this.file, state);
  }

  // ---- Dynamic Client Registration -------------------------------------

  registerClient(input: { clientName?: string; redirectUris: string[] }): ClientRegistration {
    const client: ClientRegistration = {
      clientId: `c2c_client_${randomBytes(12).toString("base64url")}`,
      clientName: input.clientName,
      redirectUris: input.redirectUris,
      createdAt: new Date().toISOString(),
    };
    this.clients.set(client.clientId, client);
    this.save();
    return client;
  }

  getClient(clientId: string): ClientRegistration | undefined {
    return this.clients.get(clientId);
  }

  // ---- Authorization codes ----------------------------------------------

  createAuthorizationCode(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    pairingSessionId: string;
    resource?: string;
  }): string {
    const code = newToken("c2c_ac");
    this.authCodes.set(code, {
      code,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      workspaceId: this.workspaceId,
      pairingSessionId: input.pairingSessionId,
      resource: input.resource,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });
    return code;
  }

  /** One-time consumption of an authorization code. */
  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | null {
    const record = this.authCodes.get(code);
    if (!record) return null;
    this.authCodes.delete(code);
    if (Date.now() > record.expiresAt) return null;
    return record;
  }

  // ---- Tokens -------------------------------------------------------------

  issueTokens(input: {
    clientId: string;
    scopes: string[];
    workspaceId?: string;
    accessTtlMs?: number;
  }): { accessToken: string; refreshToken: string | null; expiresIn: number; scopes: string[] } {
    const now = Date.now();
    const workspaceId = input.workspaceId ?? this.workspaceId;
    const accessTtl = input.accessTtlMs ?? ACCESS_TOKEN_TTL_MS;

    const accessToken = newToken("c2c_at");
    this.tokens.set(sha256hex(accessToken), {
      hash: sha256hex(accessToken),
      kind: "access",
      clientId: input.clientId,
      workspaceId,
      scopes: input.scopes,
      issuedAt: now,
      expiresAt: now + accessTtl,
      revoked: false,
    });

    let refreshToken: string | null = null;
    if (input.scopes.includes("offline_access")) {
      refreshToken = newToken("c2c_rt");
      this.tokens.set(sha256hex(refreshToken), {
        hash: sha256hex(refreshToken),
        kind: "refresh",
        clientId: input.clientId,
        workspaceId,
        scopes: input.scopes,
        issuedAt: now,
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
        revoked: false,
      });
    }
    this.save();
    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(accessTtl / 1000),
      scopes: input.scopes,
    };
  }

  verifyAccessToken(token: string): VerifyTokenResult {
    const record = this.tokens.get(sha256hex(token));
    if (!record) return { ok: false, reason: "unknown" };
    if (record.kind !== "access") return { ok: false, reason: "wrong_kind" };
    if (record.revoked) return { ok: false, reason: "revoked" };
    if (Date.now() > record.expiresAt) return { ok: false, reason: "expired" };
    return { ok: true, record };
  }

  /** Refresh-token rotation: old refresh token is revoked, a new pair is issued. */
  refresh(
    refreshToken: string,
    clientId: string
  ): { ok: true; tokens: ReturnType<AuthStore["issueTokens"]> } | { ok: false; reason: string } {
    const record = this.tokens.get(sha256hex(refreshToken));
    if (!record || record.kind !== "refresh") return { ok: false, reason: "invalid_grant" };
    if (record.revoked) return { ok: false, reason: "invalid_grant" };
    if (Date.now() > record.expiresAt) return { ok: false, reason: "invalid_grant" };
    if (record.clientId !== clientId) return { ok: false, reason: "invalid_client" };
    record.revoked = true;
    this.tokens.delete(record.hash);
    const tokens = this.issueTokens({
      clientId,
      scopes: record.scopes,
      workspaceId: record.workspaceId,
    });
    return { ok: true, tokens };
  }

  revokeToken(token: string): boolean {
    const record = this.tokens.get(sha256hex(token));
    if (!record) return false;
    record.revoked = true;
    this.tokens.delete(record.hash);
    this.save();
    return true;
  }

  /** Used by `c2c unpair`: revoke everything for this workspace. */
  revokeAll(): number {
    const count = this.tokens.size;
    this.tokens.clear();
    this.authCodes.clear();
    this.save();
    return count;
  }

  tokenCount(): number {
    return this.tokens.size;
  }

  static deleteStateFile(workspaceId: string): void {
    const file = path.join(getStateDir(), "auth", `${workspaceId}.json`);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
}

export function filterScopes(requested: string | undefined): string[] {
  if (!requested || requested.trim() === "") return [...SUPPORTED_SCOPES];
  const asked = requested.split(/[\s+]+/).filter(Boolean);
  const granted = asked.filter((scope) => (SUPPORTED_SCOPES as readonly string[]).includes(scope));
  return granted.length > 0 ? granted : [...SUPPORTED_SCOPES];
}
