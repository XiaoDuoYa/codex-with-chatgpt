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
  used: boolean;
}

export interface PairingVerifyOk {
  ok: true;
  sessionId: string;
}

export interface PairingVerifyFail {
  ok: false;
  reason: "invalid" | "expired" | "too_many_attempts" | "rate_limited" | "no_active_session";
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
  ipRateLimit?: number;
  ipRateWindowMs?: number;
}

export class PairingManager {
  private sessions = new Map<string, PairingSession>();
  private ipHits = new Map<string, { count: number; resetAt: number }>();
  private readonly ttlMs: number;
  private readonly ipRateLimit: number;
  private readonly ipRateWindowMs: number;

  constructor(
    private readonly workspaceId: string,
    opts: PairingManagerOptions = {}
  ) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
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

  /**
   * Non-mutating lookup: does this code belong to one of MY active sessions?
   * The multi-workspace host uses it to route a code to its workspace WITHOUT
   * burning attempts or IP rate budget on unrelated workspaces.
   */
  match(codeInput: string): { sessionId: string } | null {
    const normalized = normalizePairingCode(codeInput);
    const inputHash = hashCode(normalized);
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.used) continue;
      if (now > session.expiresAt) {
        this.sessions.delete(id);
        continue;
      }
      if (timingSafeEqual(inputHash, session.codeHash)) {
        return { sessionId: session.id };
      }
    }
    return null;
  }

  /** Delete lapsed sessions; returns true when any were removed. */
  private sweepExpired(): boolean {
    const now = Date.now();
    let sawExpired = false;
    for (const [id, session] of this.sessions) {
      if (!session.used && now > session.expiresAt) {
        this.sessions.delete(id);
        sawExpired = true;
      }
    }
    return sawExpired;
  }

  verify(codeInput: string, ip?: string): PairingVerifyResult {
    if (!this.checkIpRate(ip)) {
      return { ok: false, reason: "rate_limited" };
    }
    const hadExpired = this.sweepExpired();
    const matched = this.match(codeInput);
    if (!matched) {
      // Distinguish "never had a code" from "had one that lapsed" for UX;
      // wrong-but-plausible codes are punished at the host level instead.
      return this.hasActiveSession()
        ? { ok: false, reason: "invalid" }
        : hadExpired
          ? { ok: false, reason: "expired" }
          : { ok: false, reason: "no_active_session" };
    }
    // One-time use: destroy immediately.
    this.sessions.delete(matched.sessionId);
    return { ok: true, sessionId: matched.sessionId };
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
