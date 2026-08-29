import type { NextFunction, Request, Response } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AuthStore, TokenRecord } from "./store.js";
import type { Logger } from "../logger/index.js";

export interface BearerAuthEntry {
  workspaceId: string;
  store: AuthStore;
}

export interface BearerAuthDeps {
  /** Live workspace entries; workspaces can join the host at runtime. */
  entries: () => BearerAuthEntry[];
  getBaseUrl: (req: Request) => string;
  logger: Logger;
}

/**
 * Bearer-token guard for /mcp on a multi-workspace host.
 * - missing/invalid/expired token  -> 401 (+ WWW-Authenticate with resource metadata)
 * - a record whose workspaceId does not equal its owning store's workspace
 *   (or names a workspace this host does not serve) -> 403
 * On success the owning workspace id is attached so the route can dispatch
 * to that workspace's MCP handler.
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
    let owner: BearerAuthEntry | null = null;
    let record: TokenRecord | null = null;
    for (const entry of deps.entries()) {
      const verdict = entry.store.verifyAccessToken(token);
      if (!verdict.ok) continue;
      if (verdict.record.workspaceId !== entry.workspaceId) {
        // A record physically stored in one workspace must never act as
        // another workspace's credential, even if it claims that workspaceId.
        deps.logger.warn("Rejected MCP request: token workspaceId does not match its owning store");
        res.status(403).json({
          error: "forbidden",
          error_description: "This token is not authorized for the connected workspace",
        });
        return;
      }
      owner = entry;
      record = verdict.record;
      break;
    }
    if (!owner || !record) {
      deps.logger.warn("Rejected MCP request: token unknown, expired or revoked");
      res
        .status(401)
        .set("WWW-Authenticate", challenge("invalid_token", "Token unknown"))
        .json({ error: "unauthorized", error_description: "Token unknown" });
      return;
    }
    const authInfo: AuthInfo = {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
    };
    (req as Request & { auth?: AuthInfo }).auth = authInfo;
    (req as Request & { c2cWorkspaceId?: string }).c2cWorkspaceId = owner.workspaceId;
    next();
  };
}
