import { describe, it, expect, vi, afterEach } from "vitest";
import { PairingManager, formatPairingCode, normalizePairingCode } from "../src/pairing/manager.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("PairingManager", () => {
  it("generates codes in XXXX-XXXX format without ambiguous characters", () => {
    const manager = new PairingManager("ws1");
    for (let i = 0; i < 20; i++) {
      const { code } = manager.create();
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      expect(code).not.toMatch(/[ILO01]/);
    }
  });

  it("accepts the correct code exactly once", () => {
    const manager = new PairingManager("ws1");
    const { code } = manager.create();
    const first = manager.verify(code);
    expect(first.ok).toBe(true);
    const second = manager.verify(code);
    expect(second.ok).toBe(false);
  });

  it("is forgiving about dashes and case", () => {
    const manager = new PairingManager("ws1");
    const { code } = manager.create();
    const sloppy = code.replace("-", " ").toLowerCase();
    expect(manager.verify(sloppy).ok).toBe(true);
  });

  it("rejects wrong codes and limits attempts", () => {
    const manager = new PairingManager("ws1", { maxAttempts: 3 });
    manager.create();
    expect(manager.verify("AAAA-AAAA")).toMatchObject({ ok: false, reason: "invalid", attemptsLeft: 2 });
    expect(manager.verify("BBBB-BBBB")).toMatchObject({ ok: false, reason: "invalid", attemptsLeft: 1 });
    expect(manager.verify("CCCC-CCCC")).toMatchObject({ ok: false, reason: "too_many_attempts" });
    // session destroyed after brute-force limit
    expect(manager.verify("DDDD-DDDD")).toMatchObject({ ok: false, reason: "no_active_session" });
  });

  it("expires codes after the TTL", () => {
    vi.useFakeTimers();
    const manager = new PairingManager("ws1", { ttlMs: 2 * 60_000 });
    const { code } = manager.create();
    vi.advanceTimersByTime(2 * 60_000 + 1000);
    expect(manager.verify(code)).toMatchObject({ ok: false, reason: "expired" });
  });

  it("rate limits per IP", () => {
    const manager = new PairingManager("ws1", { ipRateLimit: 3, maxAttempts: 100 });
    manager.create();
    manager.verify("AAAA-AAAA", "1.2.3.4");
    manager.verify("AAAA-AAAA", "1.2.3.4");
    manager.verify("AAAA-AAAA", "1.2.3.4");
    expect(manager.verify("AAAA-AAAA", "1.2.3.4")).toMatchObject({ ok: false, reason: "rate_limited" });
    // other IPs unaffected
    expect(manager.verify("AAAA-AAAA", "5.6.7.8").reason).not.toBe("rate_limited");
  });

  it("keeps previous sessions active and exposes the newest active session", () => {
    const manager = new PairingManager("ws1");
    const first = manager.create();
    const second = manager.create();

    expect(manager.getActiveSessionId()).toBe(second.sessionId);
    expect(manager.verifyForSession(first.sessionId, first.code)).toMatchObject({
      ok: true,
      sessionId: first.sessionId,
    });
    expect(manager.verifyForSession(second.sessionId, second.code)).toMatchObject({
      ok: true,
      sessionId: second.sessionId,
    });
  });

  it("limits a code mismatch to the requested session", () => {
    const manager = new PairingManager("ws1");
    const first = manager.create();
    const second = manager.create();

    expect(manager.verifyForSession(second.sessionId, first.code)).toMatchObject({
      ok: false,
      reason: "invalid",
      attemptsLeft: 4,
    });
    expect(manager.verifyForSession(first.sessionId, first.code)).toMatchObject({
      ok: true,
      sessionId: first.sessionId,
    });
    expect(manager.verifyForSession(second.sessionId, second.code)).toMatchObject({
      ok: true,
      sessionId: second.sessionId,
    });
  });

  it("normalizes input", () => {
    expect(normalizePairingCode(" ab2-cd3 e ")).toBe("AB2CD3E");
    expect(formatPairingCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });
});
