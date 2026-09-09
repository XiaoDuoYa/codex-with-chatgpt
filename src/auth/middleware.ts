import type { NextFunction, Request, Response } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AuthStore } from "./store.js";
import type { Logger } from "../logger/index.js";

export interface BearerAuthDeps {
  store: AuthStore;
  workspaceId: string;
  getBaseUrl: (req: Request) => string;
  logger: Logger;
}

/**
 * Bearer-token guard for /mcp.
 * - missing/invalid/expired token  -> 401 (+ WWW-Authenticate with resource metadata)
 * - valid token for another workspace -> 403
 *
 * A Gateway passes `workspaceId: "*"`. In that mode the token is a global
 * Gateway credential and the selected workspace is checked by the MCP
 * resolver against the locally attached workspace leases.
 */
export function bearerAuth(deps: BearerAuthDeps) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const challenge = (error: string, description: string): string =>
      `Bearer realm="c2c", error="${error}", error_description="${description}", ` +
      `resource_metadata="${deps.getBaseUrl(req)}/.well-known/oauth-protected-resource/mcp"`;

    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith("bearer ")) {
      res
        .status(401)
        .set("WWW-Authenticate", challenge("invalid_token", "Missing bearer token"))
        .json({ error: "unauthorized", error_description: "Authentication required" });
      return;
    }
    const token = header.slice(7).trim();
    const verdict = deps.store.verifyAccessToken(token);
    if (!verdict.ok) {
      deps.logger.warn(`Rejected MCP request: token ${verdict.reason}`);
      res
        .status(401)
        .set("WWW-Authenticate", challenge("invalid_token", `Token ${verdict.reason}`))
        .json({ error: "unauthorized", error_description: `Token ${verdict.reason}` });
      return;
    }
    const workspaceMatches =
      deps.workspaceId === "*"
        ? verdict.record.workspaceId === "*"
        : verdict.record.workspaceId === deps.workspaceId;
    if (!workspaceMatches) {
      deps.logger.warn("Rejected MCP request: token bound to a different workspace");
      res.status(403).json({
        error: "forbidden",
        error_description: "This token is not authorized for the connected workspace",
      });
      return;
    }
    const authInfo: AuthInfo = {
      token,
      clientId: verdict.record.clientId,
      scopes: verdict.record.scopes,
      expiresAt: Math.floor(verdict.record.expiresAt / 1000),
    };
    (req as Request & { auth?: AuthInfo }).auth = authInfo;
    next();
  };
}
