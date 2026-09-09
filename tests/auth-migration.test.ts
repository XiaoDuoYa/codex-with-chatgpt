import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AuthStore,
  migrateLegacyAuthState,
  type PersistedAuthState,
} from "../src/auth/store.js";
import { readJsonIfExists } from "../src/config/paths.js";
import { isolateStateDir } from "./helpers.js";

describe("legacy OAuth state migration", () => {
  it("imports matching workspace credentials as global Gateway credentials", () => {
    const state = isolateStateDir();
    const authDir = path.join(state, "auth");
    const endpointDir = path.join(state, "endpoints");
    fs.mkdirSync(authDir, { recursive: true });
    fs.mkdirSync(endpointDir, { recursive: true });

    const legacyFile = path.join(authDir, "legacy-workspace.json");
    const legacy = new AuthStore("legacy-workspace", { file: legacyFile });
    const client = legacy.registerClient({
      clientName: "ChatGPT",
      redirectUris: ["https://chatgpt.com/connector/oauth/test"],
    });
    const issued = legacy.issueTokens({
      clientId: client.clientId,
      scopes: ["workspace.read", "offline_access"],
      accessTtlMs: 60_000,
    });
    const raw = readJsonIfExists<PersistedAuthState>(legacyFile);
    if (!raw) throw new Error("legacy auth state was not written");
    raw.tokens.push({
      hash: "expired-hash",
      kind: "access",
      clientId: client.clientId,
      workspaceId: "legacy-workspace",
      scopes: ["workspace.read"],
      issuedAt: Date.now() - 120_000,
      expiresAt: Date.now() - 60_000,
      revoked: false,
    });
    fs.writeFileSync(legacyFile, JSON.stringify(raw));

    fs.writeFileSync(
      path.join(endpointDir, "gateway.json"),
      JSON.stringify({ workspaceId: "gateway", mcpUrl: "https://example.test/mcp" })
    );
    fs.writeFileSync(
      path.join(endpointDir, "legacy-workspace.json"),
      JSON.stringify({ workspaceId: "legacy-workspace", mcpUrl: "https://example.test/mcp" })
    );
    fs.writeFileSync(
      path.join(endpointDir, "unrelated.json"),
      JSON.stringify({ workspaceId: "unrelated", mcpUrl: "https://other.test/mcp" })
    );
    fs.writeFileSync(
      path.join(authDir, "unrelated.json"),
      JSON.stringify({ clients: [], tokens: [{ ...raw.tokens[0], hash: "unrelated-hash" }] })
    );

    const targetFile = path.join(authDir, "gateway.json");
    const result = migrateLegacyAuthState({ targetFile });
    expect(result.migrated).toBe(true);
    expect(result.importedTokens).toBe(2);
    expect(result.importedClients).toBe(1);

    const gateway = new AuthStore("gateway", { file: targetFile });
    expect(gateway.tokenCount()).toBe(2);
    expect(gateway.verifyAccessToken(issued.accessToken)).toMatchObject({
      ok: true,
      record: { workspaceId: "*" },
    });

    const repeated = migrateLegacyAuthState({ targetFile });
    expect(repeated.migrated).toBe(false);
    expect(gateway.tokenCount()).toBe(2);
  });
});
