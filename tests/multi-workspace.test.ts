import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { makeTmpDir, cleanup, write, isolateStateDir, pkceVerifierAndChallenge } from "./helpers.js";

/**
 * Multiple workspaces share ONE bridge host: parallel Codex sessions register
 * with the running host instead of spawning competing bridges, so a shared
 * public address (e.g. a named tunnel) can never split across processes.
 */
describe("multi-workspace host", () => {
  let rootA = makeTmpDir("host-ws-a");
  let rootB = makeTmpDir("host-ws-b");
  let bridge: Bridge | null = null;
  let base = "";
  let adminAuth = "";
  const REDIRECT_URI = "http://127.0.0.1:19998/callback";

  isolateStateDir();
  write(rootA, "from-a.txt", "workspace alpha\n");
  write(rootB, "from-b.txt", "workspace beta\n");

  afterAll(async () => {
    if (bridge) await bridge.close();
    cleanup(rootA);
    cleanup(rootB);
  });

  async function bootSecondWorkspace(): Promise<void> {
    if (bridge) return;
    bridge = await startBridge({
      workspaceRoot: rootA,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("host-auth"), "a.json"),
    });
    base = bridge.localBaseUrl();
    adminAuth = `Bearer ${bridge.adminToken}`;
    const response = await fetch(`${base}/admin/workspaces/register`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: adminAuth },
      body: JSON.stringify({ workspaceRoot: rootB }),
    });
    expect(response.status).toBe(200);
  }

  async function adminPairing(workspaceId: string): Promise<string> {
    const response = await fetch(`${base}/admin/pairing`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: adminAuth },
      body: JSON.stringify({ workspaceId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { code: string };
    return body.code;
  }

  async function registerClient(clientName: string): Promise<string> {
    const body = (await (
      await fetch(`${base}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: clientName, redirect_uris: [REDIRECT_URI] }),
      })
    ).json()) as { client_id: string };
    return body.client_id;
  }

  async function readMcp(
    token: string,
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { result?: { content?: { text?: string }[] } };
    return JSON.parse(payload.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
  }

  /** Run the full OAuth flow with the given pairing code; returns the access token. */
  async function oauthPair(code: string): Promise<string> {
    const clientId = await registerClient("Host-Test");
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("scope", "workspace.read offline_access");
    const page = await (await fetch(authorizeUrl)).text();
    const requestId = page.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
    expect(requestId).toBeTruthy();

    const authorizeResponse = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId!, pairing_code: code }),
      redirect: "manual",
    });
    expect(authorizeResponse.status).toBe(302);
    const authCode = new URL(authorizeResponse.headers.get("location")!).searchParams.get("code");
    expect(authCode).toBeTruthy();

    const tokenResponse = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode!,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    return ((await tokenResponse.json()) as { access_token: string }).access_token;
  }

  async function pairAndConnect(code: string, expectedFile: string, expectedContent: string): Promise<string> {
    const token = await oauthPair(code);
    const result = await readMcp(token, "read_file", { path: expectedFile });
    expect(result).toMatchObject({ content: expect.stringContaining(expectedContent) });
    return token;
  }

  it("registers a second workspace; membership is admin-only", async () => {
    await bootSecondWorkspace();
    expect(bridge!.workspaceIds().length).toBe(2);
    const health = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    expect(health).not.toHaveProperty("workspaceId");
    expect(health).not.toHaveProperty("workspaces");
    const info = (await (
      await fetch(`${base}/admin/info`, { headers: { authorization: adminAuth } })
    ).json()) as { workspaces: string[] };
    expect(info.workspaces.length).toBe(2);
  });

  it("dispatches each pairing/token to its own workspace", async () => {
    await bootSecondWorkspace();
    const idA = bridge!.workspace.id;
    const idB = bridge!.workspaceIds().find((id) => id !== idA)!;
    await pairAndConnect(await adminPairing(idA), "from-a.txt", "workspace alpha");
    await pairAndConnect(await adminPairing(idB), "from-b.txt", "workspace beta");
  });

  it("keeps pairing sessions isolated between workspaces", async () => {
    await bootSecondWorkspace();
    const idA = bridge!.workspace.id;
    const idB = bridge!.workspaceIds().find((id) => id !== idA)!;
    const codeA = await adminPairing(idA);
    const codeB = await adminPairing(idB);

    // A wrong code (as if aiming at another workspace) must fail without
    // destroying either workspace's live pairing session.
    const clientId = await registerClient("Iso-Test");
    const { challenge } = pkceVerifierAndChallenge();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("scope", "workspace.read");
    const page = await (await fetch(authorizeUrl)).text();
    const requestId = page.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
    expect(requestId).toBeTruthy();
    const wrong = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId!, pairing_code: "AAAA-AAAA" }),
      redirect: "manual",
    });
    expect(wrong.status).toBe(401);

    // Both original codes remain usable after the wrong attempt.
    await pairAndConnect(codeA, "from-a.txt", "workspace alpha");
    await pairAndConnect(codeB, "from-b.txt", "workspace beta");
  });

  it("re-registers an already hosted workspace idempotently", async () => {
    await bootSecondWorkspace();
    const response = await fetch(`${base}/admin/workspaces/register`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: adminAuth },
      body: JSON.stringify({ workspaceRoot: rootA }),
    });
    expect(response.status).toBe(200);
    expect(bridge!.workspaceIds().length).toBe(2);
  });

  it("rejects admin routes without the admin token", async () => {
    await bootSecondWorkspace();
    const response = await fetch(`${base}/admin/workspaces/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot: rootB }),
    });
    expect(response.status).toBe(404);
  });

  it("a token record stored in one workspace cannot act as another's credential", async () => {
    await bootSecondWorkspace();
    const idB = bridge!.workspaceIds().find((id) => id !== bridge!.workspace.id)!;
    // Forge: a record physically stored in A claiming to belong to B.
    const forged = bridge!.authStore.issueTokens({
      clientId: "forged",
      scopes: ["workspace.read", "offline_access"],
      workspaceId: idB,
    });
    const call = (token: string): Promise<Response> =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
    expect((await call(forged.accessToken)).status).toBe(403);

    // Its refresh token must not reach B's store either.
    const refresh = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: forged.refreshToken!,
        client_id: "forged",
      }),
    });
    expect(refresh.status).toBe(400);
  });

  it("stops serving an unregistered workspace", async () => {
    await bootSecondWorkspace();
    const idB = bridge!.workspaceIds().find((id) => id !== bridge!.workspace.id)!;
    const tokenB = await pairAndConnect(await adminPairing(idB), "from-b.txt", "workspace beta");

    const unregister = await fetch(`${base}/admin/workspaces/unregister`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: adminAuth },
      body: JSON.stringify({ workspaceId: idB }),
    });
    const result = (await unregister.json()) as { removed: boolean; hostStopped: boolean };
    expect(result).toMatchObject({ removed: true, hostStopped: false });

    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect([401, 403]).toContain(response.status);
  });
});
