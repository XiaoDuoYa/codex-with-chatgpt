import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import path from "node:path";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { makeTmpDir, cleanup, write, isolateStateDir, pkceVerifierAndChallenge } from "./helpers.js";

let root: string;
let bridge: Bridge;
let base: string;

const REDIRECT_URI = "https://chatgpt.com/connector/oauth/test-callback";

beforeAll(async () => {
  isolateStateDir();
  root = makeTmpDir("oauth-ws");
  write(root, "hello.txt", "hello oauth\n");
  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("auth"), "store.json"),
  });
  base = bridge.localBaseUrl();
});

afterAll(async () => {
  await bridge.close();
  cleanup(root);
});

async function registerClient(): Promise<string> {
  bridge.pairing.create();
  const response = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT-Test", redirect_uris: [REDIRECT_URI] }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

async function authorizeWithPairing(
  clientId: string,
  challenge: string,
  pairingCode: string,
  state = "st-123"
): Promise<{ code: string | null; location: string | null; page?: string; status?: number }> {
  const authorizeUrl = new URL(`${base}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set(
    "scope",
    "workspace.read workspace.search git.read execution.read c2c.result.write offline_access"
  );

  const pageResponse = await fetch(authorizeUrl, { redirect: "manual" });
  const html = await pageResponse.text();
  const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
  if (!requestId) return { code: null, location: null, page: html, status: pageResponse.status };

  const postResponse = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId, pairing_code: pairingCode }),
    redirect: "manual",
  });
  if (postResponse.status !== 302) {
    return { code: null, location: null, page: await postResponse.text(), status: postResponse.status };
  }
  const location = postResponse.headers.get("location");
  const code = location ? new URL(location).searchParams.get("code") : null;
  return { code, location, status: postResponse.status };
}

async function exchangeToken(
  clientId: string,
  code: string,
  verifier: string,
  redirectUri = REDIRECT_URI
): Promise<{ status: number; body: Record<string, string> }> {
  const response = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

describe("discovery metadata", () => {
  it("serves protected resource metadata", async () => {
    const response = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
    };
    expect(body.resource).toContain("/mcp");
    expect(body.authorization_servers.length).toBe(1);
    expect(body.scopes_supported).toContain("c2c.result.write");
  });

  it("serves authorization server metadata with PKCE S256", async () => {
    const response = await fetch(`${base}/.well-known/oauth-authorization-server`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(body.registration_endpoint).toContain("/oauth/register");
    expect(body.scopes_supported).toEqual(expect.arrayContaining(["c2c.result.write"]));
  });
});

describe("authorization + token flow", () => {
  it("completes the full pairing + PKCE flow and calls MCP", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code, location } = await authorizeWithPairing(clientId, challenge, pairing.code);
    expect(code).toBeTruthy();
    expect(location).toContain("state=st-123");

    const token = await exchangeToken(clientId, code!, verifier);
    expect(token.status).toBe(200);
    expect(token.body.access_token).toMatch(/^c2c_at_/);
    expect(token.body.refresh_token).toMatch(/^c2c_rt_/);
    expect(token.body.token_type).toBe("Bearer");
    expect(token.body.scope).toContain("c2c.result.write");

    const adminResponse = await fetch(`${base}/admin/info`, {
      headers: { authorization: `Bearer ${bridge.adminToken}` },
    });
    expect(adminResponse.status).toBe(200);
    expect(await adminResponse.json()).toMatchObject({
      authorization: {
        activeClientCount: 1,
        connectorClientCount: 1,
        connectorActiveTokenCount: 2,
        resultWriteAuthorized: true,
      },
    });

    // authorized MCP request
    const mcpResponse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.body.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(mcpResponse.status).toBe(200);
  });

  it("rejects a wrong pairing code", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    bridge.pairing.create();
    const result = await authorizeWithPairing(clientId, challenge, "AAAA-AAAA");
    expect(result.code).toBeNull();
    expect(result.status).toBe(401);
    expect(result.page).toContain("Incorrect pairing code");
  });

  it("escapes the workspace name in the pairing page", async () => {
    const xssWorkspaceRoot = makeTmpDir("oauth-html");
    write(xssWorkspaceRoot, ".c2c.json", JSON.stringify({ name: "<script>alert('xss')</script>" }));
    const xssBridge = await startBridge({
      workspaceRoot: xssWorkspaceRoot,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth-html"), "store.json"),
    });

    try {
      const xssBase = xssBridge.localBaseUrl();
      xssBridge.pairing.create();
      const registration = await fetch(`${xssBase}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "HTML-Test", redirect_uris: [REDIRECT_URI] }),
      });
      expect(registration.status).toBe(201);
      const client = (await registration.json()) as { client_id: string };
      const { challenge } = pkceVerifierAndChallenge();

      const authorizeUrl = new URL(`${xssBase}/oauth/authorize`);
      authorizeUrl.searchParams.set("client_id", client.client_id);
      authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const response = await fetch(authorizeUrl, { redirect: "manual" });
      expect(response.status).toBe(200);
      const html = await response.text();

      expect(html).not.toContain("<script>alert('xss')</script>");
      expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    } finally {
      await xssBridge.close();
      cleanup(xssWorkspaceRoot);
    }
  });

  it("sets browser security headers on the pairing page", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; base-uri 'none'; frame-ancestors 'none'"
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("shows the bounded result-write consent label when requested", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("scope", "c2c.result.write");

    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Report bounded progress and submit control results to local C2C state");
  });

  it("rejects unknown scopes instead of expanding them to all permissions", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("scope", "unknown.scope");

    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toContain("error=invalid_scope");
    expect(location).not.toContain("c2c.result.write");
  });

  it("rejects duplicate scalar parameters and a foreign resource audience", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const duplicateUrl = new URL(`${base}/oauth/authorize`);
    duplicateUrl.searchParams.append("client_id", clientId);
    duplicateUrl.searchParams.append("client_id", clientId);
    duplicateUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    duplicateUrl.searchParams.set("response_type", "code");
    duplicateUrl.searchParams.set("code_challenge", challenge);
    duplicateUrl.searchParams.set("code_challenge_method", "S256");
    expect((await fetch(duplicateUrl, { redirect: "manual" })).status).toBe(400);

    const resourceUrl = new URL(`${base}/oauth/authorize`);
    resourceUrl.searchParams.set("client_id", clientId);
    resourceUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    resourceUrl.searchParams.set("response_type", "code");
    resourceUrl.searchParams.set("code_challenge", challenge);
    resourceUrl.searchParams.set("code_challenge_method", "S256");
    resourceUrl.searchParams.set("resource", "https://other.example.com/mcp");
    const resourceResponse = await fetch(resourceUrl, { redirect: "manual" });
    expect(resourceResponse.status).toBe(302);
    expect(resourceResponse.headers.get("location")).toContain("error=invalid_target");
  });

  it("requires redirect_uri during authorization-code exchange", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const response = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        code_verifier: verifier,
        client_id: clientId,
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("does not consume an authorization code when PKCE verification fails", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const rejected = await exchangeToken(clientId, code!, "wrong-verifier-wrong-verifier-wrong");
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("invalid_grant");

    const accepted = await exchangeToken(clientId, code!, verifier);
    expect(accepted.status).toBe(200);
  });

  it("does not consume an authorization code when redirect_uri verification fails", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const rejected = await exchangeToken(clientId, code!, verifier, "http://127.0.0.1:19999/other");
    expect(rejected.status).toBe(400);
    expect(rejected.body).toMatchObject({ error: "invalid_grant", error_description: "redirect_uri mismatch" });

    const accepted = await exchangeToken(clientId, code!, verifier);
    expect(accepted.status).toBe(200);
  });

  it("does not consume an authorization code when client verification fails", async () => {
    const clientId = await registerClient();
    const otherClientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const rejected = await exchangeToken(otherClientId, code!, verifier);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe("invalid_grant");

    const accepted = await exchangeToken(clientId, code!, verifier);
    expect(accepted.status).toBe(200);
  });

  it("authorization codes are one-time", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const first = await exchangeToken(clientId, code!, verifier);
    expect(first.status).toBe(200);
    const second = await exchangeToken(clientId, code!, verifier);
    expect(second.status).toBe(400);
  });

  it("requires PKCE at the authorization endpoint", async () => {
    const clientId = await registerClient();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("error=invalid_request");
  });

  it("rejects registration with unsafe redirect uris", async () => {
    for (const redirectUri of [
      "http://evil.example.com/cb",
      "https://user:password@example.com/cb",
      "https://example.com/cb#fragment",
    ]) {
      const response = await fetch(`${base}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      });
      expect(response.status).toBe(400);
    }
  });

  it("rejects valid anonymous registration outside a local pairing window", async () => {
    const isolatedRoot = makeTmpDir("oauth-no-pairing-ws");
    const isolatedAuthRoot = makeTmpDir("oauth-no-pairing-auth");
    const isolatedBridge = await startBridge({
      workspaceRoot: isolatedRoot,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(isolatedAuthRoot, "store.json"),
    });
    try {
      const response = await fetch(`${isolatedBridge.localBaseUrl()}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Untrusted", redirect_uris: [REDIRECT_URI] }),
      });
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ error: "registration_unavailable" });
    } finally {
      await isolatedBridge.close();
      cleanup(isolatedRoot);
      cleanup(isolatedAuthRoot);
    }
  });
});

describe("token enforcement on /mcp", () => {
  const mcpCall = (token?: string): Promise<Response> =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

  it("401 without a token, with resource metadata pointer", async () => {
    const response = await mcpCall();
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("401 with an invalid token", async () => {
    const response = await mcpCall("c2c_at_totally-invalid");
    expect(response.status).toBe(401);
  });

  it("401 with an expired token", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const expired = bridge.authStore.issueTokens({
        clientId: "test",
        scopes: ["workspace.read"],
        accessTtlMs: 1_000,
      });
      clock.mockReturnValue(now + 1_001);
      const response = await mcpCall(expired.accessToken);
      expect(response.status).toBe(401);
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects a token issued by another workspace bridge", async () => {
    const foreignRoot = makeTmpDir("oauth-foreign-ws");
    const foreignAuthRoot = makeTmpDir("oauth-foreign-auth");
    const foreignBridge = await startBridge({
      workspaceRoot: foreignRoot,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(foreignAuthRoot, "store.json"),
    });
    try {
      const foreign = foreignBridge.authStore.issueTokens({
        clientId: "test",
        scopes: ["workspace.read"],
      });
      const response = await mcpCall(foreign.accessToken);
      expect(response.status).toBe(401);
    } finally {
      await foreignBridge.close();
      cleanup(foreignRoot);
      cleanup(foreignAuthRoot);
    }
  });

  it("401 after revocation", async () => {
    const tokens = bridge.authStore.issueTokens({ clientId: "test", scopes: ["workspace.read"] });
    expect((await mcpCall(tokens.accessToken)).status).toBe(200);
    bridge.authStore.revokeToken(tokens.accessToken);
    expect((await mcpCall(tokens.accessToken)).status).toBe(401);
  });
});

describe("refresh token rotation", () => {
  it("rotates refresh tokens and invalidates the old one", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const initial = await exchangeToken(clientId, code!, verifier);

    const refresh = async (refreshToken: string): Promise<{ status: number; body: Record<string, string> }> => {
      const response = await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, string> };
    };

    const rotated = await refresh(initial.body.refresh_token);
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(initial.body.refresh_token);
    expect(rotated.body.scope).toContain("c2c.result.write");

    const replayed = await refresh(initial.body.refresh_token);
    expect(replayed.status).toBe(400);
  });
});
