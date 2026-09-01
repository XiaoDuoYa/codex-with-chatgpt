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
  /** Stable DCR input fingerprint. Older state derives this lazily. */
  registrationFingerprint?: string;
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

interface PersistedAuthState {
  clients: ClientRegistration[];
  tokens: TokenRecord[];
}

export type VerifyTokenResult =
  | { ok: true; record: TokenRecord }
  | { ok: false; reason: "unknown" | "expired" | "revoked" | "wrong_kind" };

export interface ClientSummary {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: string;
  registrationFingerprint: string;
  activeTokenCount: number;
}

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const AUTH_STORE_LOCK_TIMEOUT_MS = 10_000;
const AUTH_STORE_LOCK_STALE_MS = 30_000;
const AUTH_STORE_LOCK_POLL_MS = 20;

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

/**
 * DCR registrations are identified by their semantic inputs rather than by
 * an incidental request. Redirect URI order is not identity, so it is sorted.
 */
export function registrationFingerprint(input: { clientName?: string; redirectUris: string[] }): string {
  const canonical = JSON.stringify({
    clientName: input.clientName?.trim() ?? null,
    redirectUris: [...new Set(input.redirectUris)].sort(),
  });
  return sha256hex(canonical).slice(0, 32);
}

function sleepSynchronously(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeLockDirectory(lockDir: string): void {
  try {
    fs.unlinkSync(path.join(lockDir, "owner.json"));
  } catch {
    // The owner file may not have been published before a crashed writer.
  }
  try {
    fs.rmdirSync(lockDir);
  } catch {
    // Another writer may already have reclaimed or released it.
  }
}

export class AuthStore {
  private clients = new Map<string, ClientRegistration>();
  private tokens = new Map<string, TokenRecord>();
  private authCodes = new Map<string, AuthorizationCodeRecord>();
  private readonly file: string;
  private loadedMtimeMs: number | null = null;

  constructor(
    readonly workspaceId: string,
    opts: { file?: string } = {}
  ) {
    this.file =
      opts.file ?? path.join(ensureDir(path.join(getStateDir(), "auth")), `${workspaceId}.json`);
    this.load();
  }

  private load(): void {
    this.clients.clear();
    this.tokens.clear();
    const data = readJsonIfExists<PersistedAuthState>(this.file);
    try {
      this.loadedMtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      this.loadedMtimeMs = null;
    }
    if (!data) return;
    const now = Date.now();
    for (const client of data.clients ?? []) {
      if (typeof client.clientId === "string" && Array.isArray(client.redirectUris)) {
        this.clients.set(client.clientId, client);
      }
    }
    for (const token of data.tokens ?? []) {
      if (!token.revoked && token.expiresAt > now) this.tokens.set(token.hash, token);
    }
    this.normalizeDuplicateClients();
  }

  /**
   * Older stores can contain several DCR records for one semantic
   * registration. Keep one deterministic canonical client and retire tokens
   * belonging to every duplicate rather than silently rebinding them.
   */
  private normalizeDuplicateClients(): void {
    const groups = new Map<string, ClientRegistration[]>();
    for (const client of this.clients.values()) {
      const fingerprint = this.clientFingerprint(client);
      const group = groups.get(fingerprint) ?? [];
      group.push(client);
      groups.set(fingerprint, group);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const activeTokens = (clientId: string): number =>
        [...this.tokens.values()].filter(
          (token) => token.clientId === clientId && !token.revoked && token.expiresAt > Date.now()
        ).length;
      const canonical = group.reduce((current, candidate) => {
        const currentTokens = activeTokens(current.clientId);
        const candidateTokens = activeTokens(candidate.clientId);
        if (candidateTokens !== currentTokens) return candidateTokens > currentTokens ? candidate : current;
        if (candidate.createdAt !== current.createdAt) {
          return candidate.createdAt > current.createdAt ? candidate : current;
        }
        return candidate.clientId < current.clientId ? candidate : current;
      });
      for (const duplicate of group) {
        if (duplicate.clientId === canonical.clientId) continue;
        this.clients.delete(duplicate.clientId);
        for (const [hash, token] of this.tokens) {
          if (token.clientId === duplicate.clientId) this.tokens.delete(hash);
        }
      }
    }
  }

  private reloadIfChanged(): void {
    let mtimeMs: number | null = null;
    try {
      mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      // Missing state is a valid empty store.
    }
    if (mtimeMs !== this.loadedMtimeMs) this.load();
  }

  private saveUnlocked(): void {
    const now = Date.now();
    const state: PersistedAuthState = {
      clients: [...this.clients.values()],
      tokens: [...this.tokens.values()].filter((t) => !t.revoked && t.expiresAt > now),
    };
    writeSecureJson(this.file, state);
    try {
      this.loadedMtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      this.loadedMtimeMs = null;
    }
  }

  /**
   * File-level mkdir locking plus a fresh read before every mutation prevents
   * two bridge processes from replacing each other's client/token records.
   */
  private mutate<T>(action: () => T): T {
    const lockDir = `${this.file}.lock`;
    ensureDir(path.dirname(this.file));
    const deadline = Date.now() + AUTH_STORE_LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        fs.mkdirSync(lockDir, { mode: 0o700 });
        writeSecureJson(path.join(lockDir, "owner.json"), {
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let stale = false;
        try {
          stale = Date.now() - fs.statSync(lockDir).mtimeMs > AUTH_STORE_LOCK_STALE_MS;
        } catch {
          stale = true;
        }
        if (stale) {
          removeLockDirectory(lockDir);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error("C2C_AUTH_STORE_BUSY: another bridge is updating OAuth state");
        }
        sleepSynchronously(AUTH_STORE_LOCK_POLL_MS);
      }
    }
    try {
      this.load();
      const result = action();
      this.saveUnlocked();
      return result;
    } finally {
      removeLockDirectory(lockDir);
    }
  }

  private clientFingerprint(client: ClientRegistration): string {
    return (
      client.registrationFingerprint ??
      registrationFingerprint({ clientName: client.clientName, redirectUris: client.redirectUris })
    );
  }

  // ---- Dynamic Client Registration -------------------------------------

  registerClient(input: { clientName?: string; redirectUris: string[] }): ClientRegistration {
    return this.mutate(() => {
      const fingerprint = registrationFingerprint(input);
      const existing = [...this.clients.values()].find((client) => this.clientFingerprint(client) === fingerprint);
      if (existing) {
        if (!existing.registrationFingerprint) existing.registrationFingerprint = fingerprint;
        return existing;
      }
      const client: ClientRegistration = {
        clientId: `c2c_client_${randomBytes(12).toString("base64url")}`,
        clientName: input.clientName,
        redirectUris: [...input.redirectUris],
        createdAt: new Date().toISOString(),
        registrationFingerprint: fingerprint,
      };
      this.clients.set(client.clientId, client);
      return client;
    });
  }

  getClient(clientId: string): ClientRegistration | undefined {
    this.reloadIfChanged();
    return this.clients.get(clientId);
  }

  listClientSummaries(): ClientSummary[] {
    this.reloadIfChanged();
    const now = Date.now();
    return [...this.clients.values()].map((client) => ({
      clientId: client.clientId,
      clientName: client.clientName,
      redirectUris: [...client.redirectUris],
      createdAt: client.createdAt,
      registrationFingerprint: this.clientFingerprint(client),
      activeTokenCount: [...this.tokens.values()].filter(
        (token) => token.clientId === client.clientId && !token.revoked && token.expiresAt > now
      ).length,
    }));
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

  private issueTokensUnlocked(input: {
    clientId: string;
    scopes: string[];
    workspaceId?: string;
    accessTtlMs?: number;
  }): { accessToken: string; refreshToken: string | null; expiresIn: number; scopes: string[] } {
    const now = Date.now();
    const workspaceId = input.workspaceId ?? this.workspaceId;
    const accessTtl = input.accessTtlMs ?? ACCESS_TOKEN_TTL_MS;

    const accessToken = newToken("c2c_at");
    const accessHash = sha256hex(accessToken);
    this.tokens.set(accessHash, {
      hash: accessHash,
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
      const refreshHash = sha256hex(refreshToken);
      this.tokens.set(refreshHash, {
        hash: refreshHash,
        kind: "refresh",
        clientId: input.clientId,
        workspaceId,
        scopes: input.scopes,
        issuedAt: now,
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
        revoked: false,
      });
    }
    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(accessTtl / 1000),
      scopes: input.scopes,
    };
  }

  issueTokens(input: {
    clientId: string;
    scopes: string[];
    workspaceId?: string;
    accessTtlMs?: number;
  }): { accessToken: string; refreshToken: string | null; expiresIn: number; scopes: string[] } {
    return this.mutate(() => this.issueTokensUnlocked(input));
  }

  verifyAccessToken(token: string): VerifyTokenResult {
    this.reloadIfChanged();
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
    return this.mutate(() => {
      const record = this.tokens.get(sha256hex(refreshToken));
      if (!record || record.kind !== "refresh") return { ok: false, reason: "invalid_grant" };
      if (record.revoked) return { ok: false, reason: "invalid_grant" };
      if (Date.now() > record.expiresAt) return { ok: false, reason: "invalid_grant" };
      if (record.clientId !== clientId) return { ok: false, reason: "invalid_client" };
      record.revoked = true;
      this.tokens.delete(record.hash);
      return { ok: true, tokens: this.issueTokensUnlocked({ clientId, scopes: record.scopes, workspaceId: record.workspaceId }) };
    });
  }

  revokeToken(token: string): boolean {
    return this.mutate(() => {
      const record = this.tokens.get(sha256hex(token));
      if (!record) return false;
      record.revoked = true;
      this.tokens.delete(record.hash);
      return true;
    });
  }

  /** Used by `c2c unpair`: revoke tokens and retire all DCR clients. */
  revokeAll(): number {
    return this.mutate(() => {
      const count = this.tokens.size;
      this.tokens.clear();
      this.clients.clear();
      this.authCodes.clear();
      return count;
    });
  }

  /** Explicitly retire one stale DCR registration and all of its tokens. */
  retireClient(clientId: string): { removed: boolean; revoked: number } {
    return this.mutate(() => {
      const removed = this.clients.delete(clientId);
      let revoked = 0;
      for (const [hash, token] of this.tokens) {
        if (token.clientId !== clientId) continue;
        this.tokens.delete(hash);
        revoked++;
      }
      return { removed, revoked };
    });
  }

  tokenCount(clientId?: string): number {
    this.reloadIfChanged();
    const now = Date.now();
    return [...this.tokens.values()].filter(
      (token) => (clientId === undefined || token.clientId === clientId) && !token.revoked && token.expiresAt > now
    ).length;
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
  const requestedSet = new Set(requested.split(/\s+/).filter(Boolean));
  return SUPPORTED_SCOPES.filter((scope) => requestedSet.has(scope));
}
