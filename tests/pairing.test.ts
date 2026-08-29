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

  it("wrong codes stay non-destructive; the real code still works", () => {
    const manager = new PairingManager("ws1");
    const { code } = manager.create();
    expect(manager.verify("AAAA-AAAA")).toMatchObject({ ok: false, reason: "invalid" });
    expect(manager.verify("BBBB-BBBB")).toMatchObject({ ok: false, reason: "invalid" });
    // Wrong guesses no longer burn the session's attempts (the host applies
    // its own rate limiter); the genuine code remains usable.
    expect(manager.verify(code).ok).toBe(true);
  });

  it("match() identifies a code without consuming it", () => {
    const manager = new PairingManager("ws1");
    const { code } = manager.create();
    expect(manager.match(code.toLowerCase().replace("-", ""))).toMatchObject({ sessionId: expect.any(String) });
    expect(manager.match("AAAA-AAAA")).toBeNull();
    // still usable after any number of match() calls
    expect(manager.verify(code).ok).toBe(true);
  });

  it("expires codes after the TTL", () => {
    vi.useFakeTimers();
    const manager = new PairingManager("ws1", { ttlMs: 2 * 60_000 });
    const { code } = manager.create();
    vi.advanceTimersByTime(2 * 60_000 + 1000);
    expect(manager.verify(code)).toMatchObject({ ok: false, reason: "expired" });
  });

  it("rate limits per IP", () => {
    const manager = new PairingManager("ws1", { ipRateLimit: 3 });
    manager.create();
    manager.verify("AAAA-AAAA", "1.2.3.4");
    manager.verify("AAAA-AAAA", "1.2.3.4");
    manager.verify("AAAA-AAAA", "1.2.3.4");
    expect(manager.verify("AAAA-AAAA", "1.2.3.4")).toMatchObject({ ok: false, reason: "rate_limited" });
    // other IPs unaffected
    expect(manager.verify("AAAA-AAAA", "5.6.7.8").reason).not.toBe("rate_limited");
  });

  it("invalidates previous sessions when creating a new one", () => {
    const manager = new PairingManager("ws1");
    const first = manager.create();
    manager.create();
    expect(manager.verify(first.code).ok).toBe(false);
  });

  it("normalizes input", () => {
    expect(normalizePairingCode(" ab2-cd3 e ")).toBe("AB2CD3E");
    expect(formatPairingCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });
});
