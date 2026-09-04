import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export const SUPPORTED_SCOPES = [
  "workspace.read",
  "workspace.search",
  "git.read",
  "execution.read",
  "c2c.result.write",
  "offline_access",
] as const;

export type Scope = (typeof SUPPORTED_SCOPES)[number];

const safeAuthIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/);
const canonicalTimestampSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
  "timestamp must be canonical ISO-8601"
);
const scopesSchema = z
  .array(z.enum(SUPPORTED_SCOPES))
  .min(1)
  .max(SUPPORTED_SCOPES.length)
  .refine((scopes) => new Set(scopes).size === scopes.length, "scopes must be unique");

export function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.hash) return false;
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
}

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

export type AuthorizationCodeExchangeResult =
  | { ok: true; record: AuthorizationCodeRecord }
  | {
      ok: false;
      reason: "unknown_or_expired" | "client_mismatch" | "redirect_uri_mismatch" | "pkce_mismatch";
    };

export interface AuthorizationStatus {
  activeTokenCount: number;
  activeClientCount: number;
  connectorClientCount: number;
  connectorActiveTokenCount: number;
  grantedScopes: Scope[];
  resultWriteAuthorized: boolean;
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

interface PersistedAuthState {
  clients: ClientRegistration[];
  tokens: TokenRecord[];
}

const clientRegistrationSchema = z
  .object({
    clientId: safeAuthIdSchema,
    clientName: z.string().max(200).optional(),
    redirectUris: z.array(z.string().max(2048).refine(isAllowedRedirectUri)).min(1).max(16),
    createdAt: canonicalTimestampSchema,
  })
  .strict();

const tokenRecordSchema = z
  .object({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(["access", "refresh"]),
    clientId: safeAuthIdSchema,
    workspaceId: safeAuthIdSchema,
    scopes: scopesSchema,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    revoked: z.boolean(),
  })
  .strict()
  .superRefine((token, ctx) => {
    if (token.expiresAt <= token.issuedAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "token expiry must follow issuance" });
    }
    if (token.kind === "refresh" && !token.scopes.includes("offline_access")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "refresh token requires offline_access" });
    }
  });

const persistedAuthStateSchema = z
  .object({
    clients: z.array(clientRegistrationSchema).max(100),
    tokens: z.array(tokenRecordSchema).max(1000),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (new Set(state.clients.map((client) => client.clientId)).size !== state.clients.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "client ids must be unique" });
    }
    if (new Set(state.tokens.map((token) => token.hash)).size !== state.tokens.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "token hashes must be unique" });
    }
  });

export type VerifyTokenResult =
  | { ok: true; record: TokenRecord }
  | { ok: false; reason: "unknown" | "expired" | "revoked" | "wrong_kind" };

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_REGISTERED_CLIENTS = 100;
const MAX_PENDING_CLIENTS = 20;
const PENDING_CLIENT_TTL_MS = 10 * 60 * 1000;
const MAX_PERSISTED_TOKENS = 1000;

export class OAuthClientRegistrationError extends Error {
  readonly code = "registration_limit_reached";

  constructor(message = "OAuth client registration is temporarily unavailable") {
    super(message);
    this.name = "OAuthClientRegistrationError";
  }
}

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

  readonly workspaceId: string;

  constructor(workspaceId: string, opts: { file?: string } = {}) {
    const parsedWorkspaceId = safeAuthIdSchema.safeParse(workspaceId);
    if (!parsedWorkspaceId.success) throw new Error("OAuth workspace id is invalid");
    this.workspaceId = parsedWorkspaceId.data;
    this.file =
      opts.file ?? path.join(ensureDir(path.join(getStateDir(), "auth")), `${this.workspaceId}.json`);
    this.load();
  }

  private load(): void {
    const raw = readJsonIfExists<unknown>(this.file);
    if (raw === null) {
      if (fs.existsSync(this.file)) throw new Error("Stored OAuth state is unreadable or malformed");
      return;
    }
    const parsed = persistedAuthStateSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Stored OAuth state failed validation");
    const data: PersistedAuthState = parsed.data;
    if (data.tokens.some((token) => token.workspaceId !== this.workspaceId)) {
      throw new Error("Stored OAuth state belongs to a different workspace");
    }
    const now = Date.now();
    for (const client of data.clients) this.clients.set(client.clientId, client);
    for (const token of data.tokens) {
      if (!token.revoked && token.expiresAt > now) this.tokens.set(token.hash, token);
    }
  }

  private save(): void {
    const now = Date.now();
    const state = persistedAuthStateSchema.parse({
      clients: [...this.clients.values()],
      tokens: [...this.tokens.values()].filter((t) => !t.revoked && t.expiresAt > now),
    }) satisfies PersistedAuthState;
    writeSecureJson(this.file, state);
  }

  // ---- Dynamic Client Registration -------------------------------------

  private registrationClientSets(now: number): {
    retained: ClientRegistration[];
    referencedClientIds: Set<string>;
  } {
    for (const [code, record] of this.authCodes) {
      if (record.expiresAt <= now) this.authCodes.delete(code);
    }
    const referencedClientIds = new Set<string>();
    for (const token of this.tokens.values()) {
      if (!token.revoked && token.expiresAt > now) referencedClientIds.add(token.clientId);
    }
    for (const code of this.authCodes.values()) referencedClientIds.add(code.clientId);

    const retained = [...this.clients.values()].filter((client) => {
      if (referencedClientIds.has(client.clientId)) return true;
      return now - Date.parse(client.createdAt) <= PENDING_CLIENT_TTL_MS;
    });
    return { retained, referencedClientIds };
  }

  registerClient(input: { clientName?: string; redirectUris: string[] }): ClientRegistration {
    const now = Date.now();
    const client = clientRegistrationSchema.parse({
      clientId: `c2c_client_${randomBytes(12).toString("base64url")}`,
      clientName: input.clientName,
      redirectUris: [...input.redirectUris],
      createdAt: new Date(now).toISOString(),
    }) satisfies ClientRegistration;

    const { retained, referencedClientIds } = this.registrationClientSets(now);
    const pendingCount = retained.filter((entry) => !referencedClientIds.has(entry.clientId)).length;
    if (retained.length >= MAX_REGISTERED_CLIENTS || pendingCount >= MAX_PENDING_CLIENTS) {
      throw new OAuthClientRegistrationError();
    }

    const previousClients = this.clients;
    this.clients = new Map(retained.map((entry) => [entry.clientId, entry]));
    this.clients.set(client.clientId, client);
    try {
      this.save();
    } catch (error) {
      this.clients = previousClients;
      throw error;
    }
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

  /** Validate every binding before atomically consuming a one-time authorization code. */
  exchangeAuthorizationCode(input: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
  }): AuthorizationCodeExchangeResult {
    const record = this.authCodes.get(input.code);
    if (!record) return { ok: false, reason: "unknown_or_expired" };
    if (Date.now() > record.expiresAt) {
      this.authCodes.delete(input.code);
      return { ok: false, reason: "unknown_or_expired" };
    }
    if (record.clientId !== input.clientId) return { ok: false, reason: "client_mismatch" };
    if (record.redirectUri !== input.redirectUri) {
      return { ok: false, reason: "redirect_uri_mismatch" };
    }
    if (!safeEqual(base64UrlSha256(input.codeVerifier), record.codeChallenge)) {
      return { ok: false, reason: "pkce_mismatch" };
    }
    this.authCodes.delete(input.code);
    return { ok: true, record };
  }

  // ---- Tokens -------------------------------------------------------------

  issueTokens(input: {
    clientId: string;
    scopes: string[];
    accessTtlMs?: number;
  }): { accessToken: string; refreshToken: string | null; expiresIn: number; scopes: string[] } {
    const now = Date.now();
    const accessTtl = input.accessTtlMs ?? ACCESS_TOKEN_TTL_MS;
    const scopes = scopesSchema.parse([...new Set(input.scopes)]);
    if (!safeAuthIdSchema.safeParse(input.clientId).success) throw new Error("OAuth client id is invalid");
    if (!Number.isInteger(accessTtl) || accessTtl <= 0 || !Number.isSafeInteger(now + accessTtl)) {
      throw new Error("OAuth access token lifetime is invalid");
    }

    const accessToken = newToken("c2c_at");
    const accessHash = sha256hex(accessToken);
    const nextTokens = new Map(
      [...this.tokens].filter(([, token]) => !token.revoked && token.expiresAt > now)
    );
    nextTokens.set(accessHash, {
      hash: accessHash,
      kind: "access",
      clientId: input.clientId,
      workspaceId: this.workspaceId,
      scopes: [...scopes],
      issuedAt: now,
      expiresAt: now + accessTtl,
      revoked: false,
    });

    let refreshToken: string | null = null;
    if (scopes.includes("offline_access")) {
      refreshToken = newToken("c2c_rt");
      const refreshHash = sha256hex(refreshToken);
      nextTokens.set(refreshHash, {
        hash: refreshHash,
        kind: "refresh",
        clientId: input.clientId,
        workspaceId: this.workspaceId,
        scopes: [...scopes],
        issuedAt: now,
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
        revoked: false,
      });
    }
    if (nextTokens.size > MAX_PERSISTED_TOKENS) {
      throw new Error("OAuth token capacity reached");
    }
    const previousTokens = this.tokens;
    this.tokens = nextTokens;
    try {
      this.save();
    } catch (error) {
      this.tokens = previousTokens;
      throw error;
    }
    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(accessTtl / 1000),
      scopes: [...scopes],
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
    const previousTokens = this.tokens;
    this.tokens = new Map(this.tokens);
    this.tokens.delete(record.hash);
    try {
      const tokens = this.issueTokens({
        clientId,
        scopes: record.scopes,
      });
      return { ok: true, tokens };
    } catch (error) {
      this.tokens = previousTokens;
      throw error;
    }
  }

  revokeToken(token: string): boolean {
    const record = this.tokens.get(sha256hex(token));
    if (!record) return false;
    const previousTokens = this.tokens;
    this.tokens = new Map(this.tokens);
    this.tokens.delete(record.hash);
    try {
      this.save();
    } catch (error) {
      this.tokens = previousTokens;
      throw error;
    }
    return true;
  }

  /** Used by `c2c unpair`: revoke everything for this workspace. */
  revokeAll(): number {
    const count = this.tokens.size;
    const previousTokens = this.tokens;
    const previousCodes = this.authCodes;
    this.tokens = new Map();
    this.authCodes = new Map();
    try {
      this.save();
    } catch (error) {
      this.tokens = previousTokens;
      this.authCodes = previousCodes;
      throw error;
    }
    return count;
  }

  tokenCount(): number {
    return this.authorizationStatus().activeTokenCount;
  }

  authorizationStatus(): AuthorizationStatus {
    const now = Date.now();
    const active = [...this.tokens.values()].filter((token) => !token.revoked && token.expiresAt > now);
    const connectorClients = [...this.clients.values()]
      .filter((client) =>
        client.redirectUris.some((redirectUri) => {
          const parsed = new URL(redirectUri);
          return parsed.hostname === "chatgpt.com" && parsed.pathname.startsWith("/connector/oauth/");
        })
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const latestTokenByClient = new Map<string, number>();
    for (const token of active) {
      latestTokenByClient.set(token.clientId, Math.max(latestTokenByClient.get(token.clientId) ?? 0, token.issuedAt));
    }
    const currentConnector = connectorClients
      .filter((client) => latestTokenByClient.has(client.clientId))
      .sort(
        (a, b) =>
          (latestTokenByClient.get(a.clientId) ?? 0) - (latestTokenByClient.get(b.clientId) ?? 0) ||
          a.createdAt.localeCompare(b.createdAt)
      )
      .at(-1);
    const connectorTokens = currentConnector
      ? active.filter((token) => token.clientId === currentConnector.clientId)
      : [];
    const granted = new Set(connectorTokens.flatMap((token) => token.scopes));
    return {
      activeTokenCount: active.length,
      activeClientCount: new Set(active.map((token) => token.clientId)).size,
      connectorClientCount: connectorClients.length,
      connectorActiveTokenCount: connectorTokens.length,
      grantedScopes: SUPPORTED_SCOPES.filter((scope) => granted.has(scope)),
      resultWriteAuthorized: connectorTokens.some((token) => token.scopes.includes("c2c.result.write")),
    };
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
  return [...new Set(asked)].filter((scope) => (SUPPORTED_SCOPES as readonly string[]).includes(scope));
}
