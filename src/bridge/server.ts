import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { bearerAuth } from "../auth/middleware.js";
import { PairingManager } from "../pairing/manager.js";
import { createMcpServer } from "../mcp/server.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { CloudflaredQuickTunnel } from "../tunnel/cloudflared.js";
import { CloudflaredNamedTunnel } from "../tunnel/cloudflared-named.js";
import type { TunnelProvider } from "../tunnel/provider.js";
import { namedTunnelBinding, readTunnelState } from "../tunnel/state.js";
import { Logger, nullLogger } from "../logger/index.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { writeRuntimeState, clearRuntimeState, type RuntimeState } from "./runtime.js";

function tunnelForWorkspace(workspaceId: string, logger: Logger): TunnelProvider {
  const binding = namedTunnelBinding(readTunnelState(workspaceId));
  if (binding) {
    return new CloudflaredNamedTunnel({
      tunnelName: binding.tunnelName,
      hostname: binding.hostname,
      expectedWorkspaceId: workspaceId,
      logger,
    });
  }
  return new CloudflaredQuickTunnel(logger, undefined, { expectedWorkspaceId: workspaceId });
}

export interface BridgeOptions {
  workspaceRoot: string;
  port?: number;
  host?: string;
  logger?: Logger;
  tunnelProvider?: TunnelProvider;
  /** Persist runtime state file (disable in tests). */
  persistRuntime?: boolean;
  authStoreFile?: string;
  pairingTtlMs?: number;
  accessTokenTtlMs?: number;
}

export interface Bridge {
  workspace: Workspace;
  port: number;
  host: string;
  adminToken: string;
  authStore: AuthStore;
  pairing: PairingManager;
  tunnel: TunnelProvider;
  getPublicBaseUrl(): string | null;
  localBaseUrl(): string;
  close(): Promise<void>;
}

/**
 * Listen on the preferred port; on EADDRINUSE fall back to an ephemeral port.
 */
function listen(app: express.Express, host: string, preferredPort: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean): void => {
      const server = app.listen(port, host);
      server.once("listening", () => {
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        resolve({ server, port: actual });
      });
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && allowFallback) {
          tryListen(0, false);
        } else {
          reject(error);
        }
      });
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
}

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const logger = opts.logger ?? nullLogger;
  const workspace = new Workspace(opts.workspaceRoot);
  const host = opts.host ?? DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The bridge only binds to loopback addresses. Public exposure goes through the tunnel.");
  }

  const authStore = new AuthStore(workspace.id, { file: opts.authStoreFile });
  const pairing = new PairingManager(workspace.id, { ttlMs: opts.pairingTtlMs });
  const tunnel = opts.tunnelProvider ?? tunnelForWorkspace(workspace.id, logger);
  const adminToken = `c2c_admin_${randomBytes(24).toString("base64url")}`;

  let publicBaseUrl: string | null = null;
  let persistRuntime: () => void = () => undefined;
  let tunnelOperationTail: Promise<void> = Promise.resolve();
  let closing = false;

  const syncPublicBaseUrl = (): string | null => {
    const providerUrl = tunnel.getPublicUrl();
    if (providerUrl !== publicBaseUrl) {
      publicBaseUrl = providerUrl;
      persistRuntime();
    }
    return publicBaseUrl;
  };

  const enqueueTunnelOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tunnelOperationTail.then(operation, operation);
    tunnelOperationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  const startManagedTunnel = (restart: boolean): Promise<string> =>
    enqueueTunnelOperation(async () => {
      if (restart) {
        publicBaseUrl = null;
        persistRuntime();
        await tunnel.stop();
      }
      try {
        const url = await tunnel.start(port);
        publicBaseUrl = url;
        persistRuntime();
        return url;
      } catch (error) {
        publicBaseUrl = tunnel.getPublicUrl();
        persistRuntime();
        throw error;
      }
    });

  const stopManagedTunnel = (): Promise<void> =>
    enqueueTunnelOperation(async () => {
      try {
        await tunnel.stop();
      } finally {
        publicBaseUrl = null;
        persistRuntime();
      }
    });

  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  const getBaseUrl = (req: Request): string => {
    const activePublicBaseUrl = syncPublicBaseUrl();
    if (activePublicBaseUrl) return activePublicBaseUrl;
    const proto = req.protocol;
    const hostHeader = req.get("host") ?? `${host}:${port}`;
    return `${proto}://${hostHeader}`;
  };

  // ---- Health (public but minimal) ---------------------------------------

  app.get("/health", (_req, res) => {
    res.json({ service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, status: "ok" });
  });

  // ---- OAuth + discovery ---------------------------------------------------

  app.use(
    createOAuthRouter({
      store: authStore,
      pairing,
      workspaceName: workspace.name,
      getBaseUrl,
      logger,
    })
  );

  // ---- MCP endpoint (bearer-protected) --------------------------------------

  const mcpHandler = createMcpHttpHandler(() => createMcpServer({ workspace, logger }), logger);
  app.all(
    "/mcp",
    express.json({ limit: "8mb" }),
    bearerAuth({ store: authStore, workspaceId: workspace.id, getBaseUrl, logger }),
    (req: Request, res: Response) => {
      void mcpHandler(req, res);
    }
  );

  // ---- Admin API (loopback + admin token only; used by the CLI/Skill) --------

  const adminGuard = (req: Request, res: Response, next: NextFunction): void => {
    // Defense in depth: reject anything that arrived through a proxy/tunnel.
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const viaProxy = Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
    const header = req.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!isLoopback || viaProxy || token !== adminToken) {
      res.status(404).end(); // do not advertise the admin surface
      return;
    }
    next();
  };

  const rejectWhileClosing = (res: Response): boolean => {
    if (!closing) return false;
    res.status(503).json({ error: "bridge_shutting_down", message: "Bridge is shutting down." });
    return true;
  };

  app.post("/admin/pairing", adminGuard, (_req, res) => {
    const session = pairing.create();
    logger.info("Created pairing session");
    res.json({ code: session.code, expiresAt: session.expiresAt });
  });

  app.get("/admin/info", adminGuard, (_req, res) => {
    const activePublicBaseUrl = syncPublicBaseUrl();
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceRoot: workspace.root,
      port,
      publicUrl: activePublicBaseUrl,
      tunnel: tunnel.status(),
      tokenCount: authStore.tokenCount(),
      authorization: authStore.authorizationStatus(),
      pairingActive: pairing.hasActiveSession(),
      pid: process.pid,
      startedAt,
    });
  });

  app.post("/admin/tunnel/start", adminGuard, (_req, res) => {
    if (rejectWhileClosing(res)) return;
    startManagedTunnel(false)
      .then((url) => {
        res.json({ url });
      })
      .catch((error: Error) => {
        logger.error(`Tunnel start failed: ${error.message}`);
        res.status(500).json({ error: "tunnel_failed", message: error.message });
      });
  });

  app.post("/admin/tunnel/restart", adminGuard, (_req, res) => {
    if (rejectWhileClosing(res)) return;
    startManagedTunnel(true)
      .then((url) => {
        res.json({ url });
      })
      .catch((error: Error) => {
        logger.error(`Tunnel restart failed: ${error.message}`);
        res.status(500).json({ error: "tunnel_failed", message: error.message });
      });
  });

  app.post("/admin/tunnel/stop", adminGuard, (_req, res) => {
    if (rejectWhileClosing(res)) return;
    void stopManagedTunnel()
      .then(() => {
        res.json({ stopped: true });
      })
      .catch((error: Error) => {
        logger.error(`Tunnel stop failed: ${error.message}`);
        res.status(500).json({ error: "tunnel_failed", message: error.message });
      });
  });

  app.post("/admin/revoke-all", adminGuard, (_req, res) => {
    const count = authStore.revokeAll();
    pairing.invalidateAll();
    logger.info(`Revoked all tokens (${count})`);
    res.json({ revoked: count });
  });

  app.post("/admin/shutdown", adminGuard, (_req, res) => {
    if (rejectWhileClosing(res)) return;
    closing = true;
    res.json({ shuttingDown: true });
    setTimeout(() => {
      void shutdown()
        .then(() => process.exit(0))
        .catch((error) => logger.error(`Bridge shutdown failed: ${String(error)}`));
    }, 100);
  });

  const { server, port } = await listen(app, host, opts.port ?? DEFAULT_PORT);
  const startedAt = new Date().toISOString();
  logger.info(`Bridge listening on ${host}:${port} for workspace ${workspace.name} (${workspace.id})`);

  persistRuntime = (): void => {
    if (opts.persistRuntime === false) return;
    const state: RuntimeState = {
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      pid: process.pid,
      port,
      adminToken,
      publicUrl: publicBaseUrl,
      startedAt,
    };
    writeRuntimeState(state);
  };
  persistRuntime();

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    shutdownPromise = (async () => {
      await stopManagedTunnel().catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (opts.persistRuntime !== false) clearRuntimeState(workspace.id);
      logger.info("Bridge stopped");
    })();
    return shutdownPromise;
  };

  return {
    workspace,
    port,
    host,
    adminToken,
    authStore,
    pairing,
    tunnel,
    getPublicBaseUrl: syncPublicBaseUrl,
    localBaseUrl: () => `http://${host}:${port}`,
    close: shutdown,
  };
}
