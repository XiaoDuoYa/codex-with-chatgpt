import { Router, type Request, type Response, urlencoded, json } from "express";
import { randomBytes } from "node:crypto";
import {
  AuthStore,
  OAuthClientRegistrationError,
  SUPPORTED_SCOPES,
  filterScopes,
  isAllowedRedirectUri,
} from "./store.js";
import { PairingManager } from "../pairing/manager.js";
import type { Logger } from "../logger/index.js";
import { PRODUCT_NAME } from "../version.js";
import { escapeHtml, setAuthSecurityHeaders } from "./html.js";

export interface OAuthDeps {
  store: AuthStore;
  pairing: PairingManager;
  workspaceName: string;
  getBaseUrl: (req: Request) => string;
  logger: Logger;
}

interface PendingAuthRequest {
  id: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state?: string;
  codeChallenge: string;
  resource?: string;
  expiresAt: number;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function hasNonScalarValues(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => record[key] !== undefined && typeof record[key] !== "string");
}

function authorizationServerMetadata(base: string): Record<string, unknown> {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SUPPORTED_SCOPES],
  };
}

function protectedResourceMetadata(base: string): Record<string, unknown> {
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: PRODUCT_NAME,
  };
}

function pairingPage(opts: {
  requestId: string;
  workspaceName: string;
  scopes: string[];
  error?: string;
}): string {
  const scopeLabels: Record<string, string> = {
    "workspace.read": "Read files in this workspace",
    "workspace.search": "Search this workspace",
    "git.read": "Read git status and diffs",
    "execution.read": "Read Codex execution summaries",
    "c2c.result.write": "Report bounded progress and submit control results to local C2C state",
    offline_access: "Stay connected between sessions",
  };
  const scopeList = opts.scopes
    .map((scope) => `<li>${escapeHtml(scopeLabels[scope] ?? scope)}</li>`)
    .join("");
  const errorHtml = opts.error
    ? `<p class="error" role="alert">${escapeHtml(opts.error)}</p>`
    : "";
  const escapedProductName = escapeHtml(PRODUCT_NAME);
  const escapedWorkspaceName = escapeHtml(opts.workspaceName);
  const escapedRequestId = escapeHtml(opts.requestId);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapedProductName}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         display: flex; align-items: center; justify-content: center; min-height: 100vh;
         margin: 0; background: #f5f5f7; color: #1d1d1f; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } .card { background: #1c1c1e !important; } }
  .card { background: #fff; border-radius: 16px; padding: 40px; max-width: 420px; width: 90%;
          box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #86868b; font-size: 14px; margin: 0 0 20px; }
  ul { font-size: 13px; color: #6e6e73; padding-left: 18px; margin: 0 0 24px; }
  li { margin-bottom: 4px; }
  input[type=text] { width: 100%; box-sizing: border-box; font-size: 24px; letter-spacing: 4px;
          text-align: center; text-transform: uppercase; padding: 12px; border: 1.5px solid #d2d2d7;
          border-radius: 10px; font-family: ui-monospace, monospace; background: transparent; color: inherit; }
  input[type=text]:focus { outline: none; border-color: #0071e3; }
  button { width: 100%; margin-top: 16px; padding: 12px; font-size: 16px; border: 0; border-radius: 10px;
           background: #0071e3; color: #fff; cursor: pointer; }
  button:hover { background: #0077ed; }
  .error { color: #d70015; font-size: 13px; margin: 12px 0 0; }
  .hint { color: #86868b; font-size: 12px; margin-top: 16px; text-align: center; }
</style>
</head>
<body>
<div class="card">
  <h1>${escapedProductName}</h1>
  <p class="sub">ChatGPT is requesting access to workspace <strong>${escapedWorkspaceName}</strong>:</p>
  <ul>${scopeList}</ul>
  <form method="POST" action="authorize">
    <input type="hidden" name="request_id" value="${escapedRequestId}">
    <input type="text" name="pairing_code" id="pairing_code" placeholder="XXXX-XXXX"
           autocomplete="one-time-code" autofocus maxlength="9" required>
    ${errorHtml}
    <button type="submit">Connect</button>
  </form>
  <p class="hint">The pairing code was generated by Codex on this computer.<br>It expires in a few minutes.</p>
</div>
</body>
</html>`;
}

export function createOAuthRouter(deps: OAuthDeps): Router {
  const router = Router();
  const pendingRequests = new Map<string, PendingAuthRequest>();

  const prunePending = (): void => {
    const now = Date.now();
    for (const [id, request] of pendingRequests) {
      if (now > request.expiresAt) pendingRequests.delete(id);
    }
  };

  // ---- Discovery metadata -------------------------------------------------

  const asMetadataHandler = (req: Request, res: Response): void => {
    res.json(authorizationServerMetadata(deps.getBaseUrl(req)));
  };
  const prMetadataHandler = (req: Request, res: Response): void => {
    res.json(protectedResourceMetadata(deps.getBaseUrl(req)));
  };
  router.get("/.well-known/oauth-authorization-server", asMetadataHandler);
  router.get("/.well-known/oauth-authorization-server/mcp", asMetadataHandler);
  router.get("/.well-known/openid-configuration", asMetadataHandler);
  router.get("/.well-known/oauth-protected-resource", prMetadataHandler);
  router.get("/.well-known/oauth-protected-resource/mcp", prMetadataHandler);

  // ---- Dynamic Client Registration (RFC 7591) ------------------------------

  router.post("/oauth/register", json(), (req, res) => {
    const body = recordValue(req.body);
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (
      redirectUris.length === 0 ||
      !redirectUris.every((uri) => typeof uri === "string" && isAllowedRedirectUri(uri))
    ) {
      res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be https URLs (or http://localhost for development)",
      });
      return;
    }
    if (!deps.pairing.claimClientRegistration()) {
      res.status(429).json({
        error: "registration_unavailable",
        error_description: "Start a new local pairing session before registering a connector.",
      });
      return;
    }
    let client;
    try {
      client = deps.store.registerClient({
        clientName: typeof body.client_name === "string" ? body.client_name.slice(0, 200) : undefined,
        redirectUris: redirectUris as string[],
      });
    } catch (error) {
      if (error instanceof OAuthClientRegistrationError) {
        res.status(429).json({ error: error.code, error_description: error.message });
        return;
      }
      deps.logger.error(`OAuth client registration failed: ${error instanceof Error ? error.message : String(error)}`);
      res.status(500).json({ error: "server_error", error_description: "OAuth client registration failed." });
      return;
    }
    deps.logger.info(`Registered OAuth client ${client.clientId} (${client.clientName ?? "unnamed"})`);
    res.status(201).json({
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  // ---- Authorization endpoint ----------------------------------------------

  router.get("/oauth/authorize", (req, res) => {
    prunePending();
    const rawQuery = recordValue(req.query);
    const oauthQueryKeys = [
      "client_id",
      "redirect_uri",
      "response_type",
      "state",
      "code_challenge",
      "code_challenge_method",
      "scope",
      "resource",
    ] as const;
    if (hasNonScalarValues(rawQuery, oauthQueryKeys)) {
      setAuthSecurityHeaders(res);
      res.status(400).send("OAuth parameters must have one value each.");
      return;
    }
    const query = Object.fromEntries(
      oauthQueryKeys.map((key) => [key, stringValue(rawQuery, key)])
    ) as Record<(typeof oauthQueryKeys)[number], string | undefined>;
    const client = query.client_id ? deps.store.getClient(query.client_id) : undefined;
    if (!client) {
      setAuthSecurityHeaders(res);
      res.status(400).send("Unknown client. Please reconnect from ChatGPT.");
      return;
    }
    const redirectUri = query.redirect_uri;
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      setAuthSecurityHeaders(res);
      res.status(400).send("Invalid redirect_uri.");
      return;
    }
    const fail = (error: string, description: string): void => {
      const url = new URL(redirectUri);
      url.searchParams.set("error", error);
      url.searchParams.set("error_description", description);
      if (query.state) url.searchParams.set("state", query.state);
      res.redirect(url.toString());
    };
    if (query.response_type !== "code") {
      fail("unsupported_response_type", "Only response_type=code is supported");
      return;
    }
    if (!query.code_challenge || query.code_challenge_method !== "S256") {
      fail("invalid_request", "PKCE with S256 is required");
      return;
    }
    const scopes = filterScopes(query.scope);
    const requestedScopes = [...new Set((query.scope ?? "").split(/[\s+]+/).filter(Boolean))];
    if (requestedScopes.length > 0 && scopes.length !== requestedScopes.length) {
      fail("invalid_scope", "One or more requested scopes are not supported");
      return;
    }
    if (query.resource) {
      let requestedResource: string;
      try {
        requestedResource = new URL(query.resource).toString();
      } catch {
        fail("invalid_target", "The requested resource is invalid");
        return;
      }
      const expectedResource = new URL("/mcp", `${deps.getBaseUrl(req)}/`).toString();
      if (requestedResource !== expectedResource) {
        fail("invalid_target", "The requested resource is not served by this workspace");
        return;
      }
    }
    const request: PendingAuthRequest = {
      id: randomBytes(16).toString("hex"),
      clientId: client.clientId,
      redirectUri,
      scopes,
      state: query.state,
      codeChallenge: query.code_challenge,
      resource: query.resource,
      expiresAt: Date.now() + 10 * 60_000,
    };
    pendingRequests.set(request.id, request);
    setAuthSecurityHeaders(res);
    res
      .status(200)
      .type("html")
      .send(pairingPage({ requestId: request.id, workspaceName: deps.workspaceName, scopes }));
  });

  router.post("/oauth/authorize", urlencoded({ extended: false }), (req, res) => {
    prunePending();
    const body = recordValue(req.body);
    const requestId = stringValue(body, "request_id");
    const pairingCode = stringValue(body, "pairing_code");
    const request = requestId ? pendingRequests.get(requestId) : undefined;
    if (!request) {
      setAuthSecurityHeaders(res);
      res.status(400).send("This authorization request has expired. Please reconnect from ChatGPT.");
      return;
    }
    const verdict = deps.pairing.verify(pairingCode ?? "", req.ip);
    if (!verdict.ok) {
      const messages: Record<string, string> = {
        invalid: `Incorrect pairing code.${verdict.attemptsLeft !== undefined ? ` ${verdict.attemptsLeft} attempts left.` : ""}`,
        expired: "This pairing code has expired. Ask Codex to generate a new one.",
        too_many_attempts: "Too many incorrect attempts. Ask Codex to generate a new pairing code.",
        rate_limited: "Too many attempts. Please wait a minute and try again.",
        no_active_session: "No active pairing session. Ask Codex to generate a pairing code.",
      };
      deps.logger.warn(`Pairing verification failed: ${verdict.reason}`);
      setAuthSecurityHeaders(res);
      res
        .status(verdict.reason === "invalid" ? 401 : 410)
        .type("html")
        .send(
          pairingPage({
            requestId: request.id,
            workspaceName: deps.workspaceName,
            scopes: request.scopes,
            error: messages[verdict.reason] ?? "Verification failed.",
          })
        );
      return;
    }
    pendingRequests.delete(request.id);
    const code = deps.store.createAuthorizationCode({
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scopes: request.scopes,
      pairingSessionId: verdict.sessionId,
      resource: request.resource,
    });
    deps.logger.info(`Pairing verified; issued authorization code for client ${request.clientId}`);
    const url = new URL(request.redirectUri);
    url.searchParams.set("code", code);
    if (request.state) url.searchParams.set("state", request.state);
    res.redirect(url.toString());
  });

  // ---- Token endpoint --------------------------------------------------------

  router.post("/oauth/token", urlencoded({ extended: false }), json(), (req, res) => {
    const body = recordValue(req.body);
    const grantType = stringValue(body, "grant_type");

    if (grantType === "authorization_code") {
      const code = stringValue(body, "code");
      const codeVerifier = stringValue(body, "code_verifier");
      const clientId = stringValue(body, "client_id");
      const redirectUri = stringValue(body, "redirect_uri");
      if (!code || !codeVerifier || !clientId || !redirectUri) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const exchange = deps.store.exchangeAuthorizationCode({
        code,
        clientId,
        redirectUri,
        codeVerifier,
      });
      if (!exchange.ok) {
        if (exchange.reason === "pkce_mismatch") {
          deps.logger.warn("PKCE verification failed at token endpoint");
          res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
          return;
        }
        if (exchange.reason === "redirect_uri_mismatch") {
          res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
          return;
        }
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      const { record } = exchange;
      const tokens = deps.store.issueTokens({ clientId, scopes: record.scopes });
      deps.logger.info(`Issued access token for client ${clientId}`);
      res.json({
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken ?? undefined,
        scope: tokens.scopes.join(" "),
      });
      return;
    }

    if (grantType === "refresh_token") {
      const refreshToken = stringValue(body, "refresh_token");
      const clientId = stringValue(body, "client_id");
      if (!refreshToken || !clientId) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const result = deps.store.refresh(refreshToken, clientId);
      if (!result.ok) {
        res.status(400).json({ error: result.reason });
        return;
      }
      res.json({
        access_token: result.tokens.accessToken,
        token_type: "Bearer",
        expires_in: result.tokens.expiresIn,
        refresh_token: result.tokens.refreshToken ?? undefined,
        scope: result.tokens.scopes.join(" "),
      });
      return;
    }

    res.status(400).json({ error: "unsupported_grant_type" });
  });

  // ---- Revocation (RFC 7009) ---------------------------------------------------

  router.post("/oauth/revoke", urlencoded({ extended: false }), (req, res) => {
    const token = stringValue(recordValue(req.body), "token");
    if (token) deps.store.revokeToken(token);
    res.status(200).json({});
  });

  return router;
}
