import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AuthStore } from "../src/auth/store.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const dirs: string[] = [];

function authFile(): string {
  const dir = makeTmpDir("auth-store");
  dirs.push(dir);
  return path.join(dir, "auth.json");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) cleanup(dir);
});

describe("AuthStore persistence", () => {
  it("reloads validated clients and preserves scopes across refresh rotation", () => {
    const file = authFile();
    const first = new AuthStore("workspaceaaa", { file });
    const client = first.registerClient({
      clientName: "ChatGPT",
      redirectUris: ["https://chatgpt.com/connector/oauth/current"],
    });
    const initial = first.issueTokens({
      clientId: client.clientId,
      scopes: ["workspace.read", "c2c.result.write", "offline_access"],
    });

    const reloaded = new AuthStore("workspaceaaa", { file });
    expect(reloaded.getClient(client.clientId)).toEqual(client);
    expect(reloaded.verifyAccessToken(initial.accessToken)).toMatchObject({
      ok: true,
      record: { scopes: ["workspace.read", "c2c.result.write", "offline_access"] },
    });
    expect(reloaded.authorizationStatus()).toMatchObject({
      activeTokenCount: 2,
      activeClientCount: 1,
      connectorClientCount: 1,
      connectorActiveTokenCount: 2,
      grantedScopes: ["workspace.read", "c2c.result.write", "offline_access"],
      resultWriteAuthorized: true,
    });

    const rotated = reloaded.refresh(initial.refreshToken!, client.clientId);
    expect(rotated).toMatchObject({
      ok: true,
      tokens: { scopes: ["workspace.read", "c2c.result.write", "offline_access"] },
    });
  });

  it("uses only the newest ChatGPT connector grant for readiness", () => {
    const store = new AuthStore("workspaceaaa", { file: authFile() });
    const previous = store.registerClient({
      clientName: "ChatGPT",
      redirectUris: ["https://chatgpt.com/connector/oauth/previous"],
    });
    store.issueTokens({
      clientId: previous.clientId,
      scopes: ["workspace.read", "c2c.result.write", "offline_access"],
    });
    const current = store.registerClient({
      clientName: "ChatGPT",
      redirectUris: ["https://chatgpt.com/connector/oauth/current"],
    });
    store.issueTokens({
      clientId: current.clientId,
      scopes: ["workspace.read", "offline_access"],
    });
    store.issueTokens({
      clientId: "c2c_client_local_probe",
      scopes: ["workspace.read", "c2c.result.write", "offline_access"],
    });

    expect(store.authorizationStatus()).toMatchObject({
      activeTokenCount: 6,
      activeClientCount: 3,
      connectorClientCount: 2,
      connectorActiveTokenCount: 2,
      grantedScopes: ["workspace.read", "offline_access"],
      resultWriteAuthorized: false,
    });
  });

  it("ignores an untrusted newer registration when selecting the active ChatGPT grant", () => {
    const store = new AuthStore("workspaceaaa", { file: authFile() });
    const previous = store.registerClient({
      clientName: "ChatGPT",
      redirectUris: ["https://chatgpt.com/connector/oauth/previous"],
    });
    store.issueTokens({
      clientId: previous.clientId,
      scopes: ["workspace.read", "c2c.result.write", "offline_access"],
    });
    store.registerClient({
      clientName: "ChatGPT",
      redirectUris: ["https://chatgpt.com/connector/oauth/current"],
    });

    expect(store.authorizationStatus()).toMatchObject({
      connectorClientCount: 2,
      connectorActiveTokenCount: 2,
      grantedScopes: ["workspace.read", "c2c.result.write", "offline_access"],
      resultWriteAuthorized: true,
    });
  });

  it("rejects excess pending clients without polluting persisted state", () => {
    const file = authFile();
    const store = new AuthStore("workspaceaaa", { file });
    for (let index = 0; index < 20; index++) {
      store.registerClient({ redirectUris: [`https://example.com/oauth/${index}`] });
    }

    expect(() =>
      store.registerClient({ redirectUris: ["https://example.com/oauth/overflow"] })
    ).toThrow(/temporarily unavailable/);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")) as { clients: unknown[] };
    expect(persisted.clients).toHaveLength(20);
  });

  it("checks token capacity before changing in-memory or persisted state", () => {
    const file = authFile();
    const now = Date.now();
    const tokens = Array.from({ length: 999 }, (_, index) => ({
      hash: index.toString(16).padStart(64, "0"),
      kind: "access" as const,
      clientId: "c2c_client_existing",
      workspaceId: "workspaceaaa",
      scopes: ["workspace.read"],
      issuedAt: now,
      expiresAt: now + 60_000,
      revoked: false,
    }));
    fs.writeFileSync(file, JSON.stringify({ clients: [], tokens }));
    const store = new AuthStore("workspaceaaa", { file });

    expect(() =>
      store.issueTokens({
        clientId: "c2c_client_overflow",
        scopes: ["workspace.read", "offline_access"],
      })
    ).toThrow(/token capacity/);
    expect(store.authorizationStatus().activeTokenCount).toBe(999);
    expect((JSON.parse(fs.readFileSync(file, "utf8")) as { tokens: unknown[] }).tokens).toHaveLength(999);
  });

  it("restores token and refresh state when persistence fails", () => {
    const file = authFile();
    const store = new AuthStore("workspaceaaa", { file });
    const client = store.registerClient({ redirectUris: ["https://chatgpt.com/connector/oauth/current"] });
    const initial = store.issueTokens({
      clientId: client.clientId,
      scopes: ["workspace.read", "offline_access"],
    });
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("simulated persistence failure");
    });

    expect(() => store.refresh(initial.refreshToken!, client.clientId)).toThrow(/persistence failure/);
    expect(store.authorizationStatus().activeTokenCount).toBe(2);
    vi.restoreAllMocks();
    expect(store.refresh(initial.refreshToken!, client.clientId)).toMatchObject({ ok: true });
  });

  it.each([
    ["malformed JSON", () => "{"],
    [
      "unknown top-level fields",
      () => JSON.stringify({ clients: [], tokens: [], injected: true }),
    ],
    [
      "unsafe redirect URIs",
      () =>
        JSON.stringify({
          clients: [
            {
              clientId: "c2c_client_test",
              redirectUris: ["http://evil.example.com/callback"],
              createdAt: new Date().toISOString(),
            },
          ],
          tokens: [],
        }),
    ],
  ])("rejects %s", (_label, state) => {
    const file = authFile();
    fs.writeFileSync(file, state());
    expect(() => new AuthStore("workspaceaaa", { file })).toThrow(/OAuth state/);
  });

  it("rejects invalid direct registrations and token inputs before persisting them", () => {
    const file = authFile();
    const store = new AuthStore("workspaceaaa", { file });
    expect(() =>
      store.registerClient({ redirectUris: ["http://evil.example.com/callback"] })
    ).toThrow();
    expect(() =>
      store.issueTokens({ clientId: "c2c_client_test", scopes: ["unknown.scope"] })
    ).toThrow();
    expect(() =>
      store.issueTokens({ clientId: "c2c_client_test", scopes: ["workspace.read"], accessTtlMs: -1 })
    ).toThrow(/lifetime/);
    expect(fs.existsSync(file)).toBe(false);
  });
});
