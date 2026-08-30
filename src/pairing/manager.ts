import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * PairingCode: a short-lived, one-time, local verification credential shown
 * on the authorization page. This is NOT an OAuth Authorization Code.
 */
export interface PairingSession {
  id: string;
  codeHash: Buffer;
  workspaceId: string;
  createdAt: number;
  expiresAt: number;
  attemptsLeft: number;
  used: boolean;
}

export interface PairingVerifyOk {
  ok: true;
  sessionId: string;
}

export interface PairingVerifyFail {
  ok: false;
  reason: "invalid" | "expired" | "too_many_attempts" | "rate_limited" | "no_active_session";
  attemptsLeft?: number;
}

export type PairingVerifyResult = PairingVerifyOk | PairingVerifyFail;

// No ambiguous characters (I, L, O, 0, 1).
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateCode(length = 8): string {
  const chars: string[] = [];
  while (chars.length < length) {
    const bytes = randomBytes(length * 2);
    for (const byte of bytes) {
      // rejection sampling for uniformity
      if (byte < Math.floor(256 / ALPHABET.length) * ALPHABET.length) {
        chars.push(ALPHABET[byte % ALPHABET.length]);
        if (chars.length === length) break;
      }
    }
  }
  return chars.join("");
}

function hashCode(code: string): Buffer {
  return createHash("sha256").update(code).digest();
}

export function formatPairingCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z2-9]/g, "");
}

export interface PairingManagerOptions {
  ttlMs?: number;
  maxAttempts?: number;
  ipRateLimit?: number;
  ipRateWindowMs?: number;
}

export class PairingManager {
  private sessions = new Map<string, PairingSession>();
  private ipHits = new Map<string, { count: number; resetAt: number }>();
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly ipRateLimit: number;
  private readonly ipRateWindowMs: number;

  constructor(
    private readonly workspaceId: string,
    opts: PairingManagerOptions = {}
  ) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.ipRateLimit = opts.ipRateLimit ?? 10;
    this.ipRateWindowMs = opts.ipRateWindowMs ?? 60_000;
  }

  /** Create a new pairing session. Invalidates previous sessions (one active at a time). */
  create(): { sessionId: string; code: string; expiresAt: number } {
    this.sessions.clear();
    const raw = generateCode();
    const session: PairingSession = {
      id: randomBytes(16).toString("hex"),
      codeHash: hashCode(raw),
      workspaceId: this.workspaceId,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
      attemptsLeft: this.maxAttempts,
      used: false,
    };
    this.sessions.set(session.id, session);
    return { sessionId: session.id, code: formatPairingCode(raw), expiresAt: session.expiresAt };
  }

  private checkIpRate(ip: string | undefined): boolean {
    if (!ip) return true;
    const now = Date.now();
    const entry = this.ipHits.get(ip);
    if (!entry || now > entry.resetAt) {
      this.ipHits.set(ip, { count: 1, resetAt: now + this.ipRateWindowMs });
      return true;
    }
    entry.count++;
    return entry.count <= this.ipRateLimit;
  }

  verify(
    codeInput: string,
    ip?: string,
    opts: { consumeFailure?: boolean } = {}
  ): PairingVerifyResult {
    if (!this.checkIpRate(ip)) {
      return { ok: false, reason: "rate_limited" };
    }
    const normalized = normalizePairingCode(codeInput);
    const inputHash = hashCode(normalized);
    const now = Date.now();

    const active = [...this.sessions.values()].filter((s) => !s.used);
    if (active.length === 0) return { ok: false, reason: "no_active_session" };

    for (const session of active) {
      if (now > session.expiresAt) {
        this.sessions.delete(session.id);
        return { ok: false, reason: "expired" };
      }
      if (session.attemptsLeft <= 0) {
        this.sessions.delete(session.id);
        return { ok: false, reason: "too_many_attempts" };
      }
      const match = timingSafeEqual(inputHash, session.codeHash);
      if (match) {
        // one-time use: destroy immediately
        session.used = true;
        this.sessions.delete(session.id);
        return { ok: true, sessionId: session.id };
      }
      if (opts.consumeFailure === false) {
        return { ok: false, reason: "invalid" };
      }
      session.attemptsLeft--;
      if (session.attemptsLeft <= 0) {
        this.sessions.delete(session.id);
        return { ok: false, reason: "too_many_attempts" };
      }
      return { ok: false, reason: "invalid", attemptsLeft: session.attemptsLeft };
    }
    return { ok: false, reason: "no_active_session" };
  }

  hasActiveSession(): boolean {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (!session.used && now <= session.expiresAt) return true;
    }
    return false;
  }

  invalidateAll(): void {
    this.sessions.clear();
  }
}
