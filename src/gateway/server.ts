import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Workspace } from "../workspace/manager.js";
import { WorkspaceRegistry } from "./registry.js";
import { GATEWAY_ID, clearGatewayRuntimeState, writeGatewayRuntimeState, type GatewayRuntimeState } from "./runtime.js";
import { AuthStore, authStoreFileFor, migrateLegacyAuthState } from "../auth/store.js";
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

function tunnelForGateway(logger: Logger): TunnelProvider {
  const binding = namedTunnelBinding(readTunnelState(GATEWAY_ID));
  if (binding) {
    return new CloudflaredNamedTunnel({
      tunnelName: binding.tunnelName,
      hostname: binding.hostname,
      logger,
    });
  }
  return new CloudflaredQuickTunnel(logger);
}

export interface GatewayOptions {
  workspaceRoot: string;
  port?: number;
  host?: string;
  logger?: Logger;
  tunnelProvider?: TunnelProvider;
  persistRuntime?: boolean;
  authStoreFile?: string;
  registryFile?: string;
  leaseTtlMs?: number;
  pairingTtlMs?: number;
  accessTokenTtlMs?: number;
}

export interface Gateway {
  registry: WorkspaceRegistry;
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
        if (error.code === "EADDRINUSE" && allowFallback) tryListen(0, false);
        else reject(error);
      });
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
}

export async function startGateway(opts: GatewayOptions): Promise<Gateway> {
  const logger = opts.logger ?? nullLogger;
  const host = opts.host ?? DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The Gateway only binds to loopback addresses. Public exposure goes through the tunnel.");
  }

  const registry = new WorkspaceRegistry({ file: opts.registryFile, leaseTtlMs: opts.leaseTtlMs });
  const active = registry.attach(opts.workspaceRoot).workspace;
  const authStoreFile = opts.authStoreFile ?? authStoreFileFor(GATEWAY_ID);
  const migration = opts.authStoreFile
    ? null
    : migrateLegacyAuthState({ targetFile: authStoreFile, targetWorkspaceId: "*" });
  if (migration?.migrated) {
    logger.info(
      `Migrated ${migration.importedTokens} OAuth token records from ${migration.sourceFiles.length} legacy workspace store(s)`
    );
  }
  const authStore = new AuthStore(GATEWAY_ID, { file: authStoreFile });
  const pairing = new PairingManager(GATEWAY_ID, { ttlMs: opts.pairingTtlMs });
  const tunnel = opts.tunnelProvider ?? tunnelForGateway(logger);
  const adminToken = `c2c_admin_${randomBytes(24).toString("base64url")}`;
  let publicBaseUrl: string | null = null;
  let port = 0;
  const startedAt = new Date().toISOString();

  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  const getBaseUrl = (req: Request): string => {
    if (publicBaseUrl) return publicBaseUrl;
    const proto = req.protocol;
    const hostHeader = req.get("host") ?? `${host}:${port}`;
    return `${proto}://${hostHeader}`;
  };

  app.get("/health", (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      gatewayId: GATEWAY_ID,
      workspaceId: registry.getActiveId(),
      status: "ok",
    });
  });

  app.use(
    createOAuthRouter({
      store: authStore,
      pairing,
      workspaceName: () => {
        try {
          return registry.active().name;
        } catch {
          return "active workspace";
        }
      },
      tokenWorkspaceId: "*",
      getBaseUrl,
      logger,
    })
  );

  const mcpHandler = createMcpHttpHandler(
    () => createMcpServer({ workspace: active, resolveWorkspace: (workspaceId) => registry.resolve(workspaceId), logger }),
    logger
  );
  app.all(
    "/mcp",
    express.json({ limit: "8mb" }),
    bearerAuth({ store: authStore, workspaceId: "*", getBaseUrl, logger }),
    (req: Request, res: Response) => {
      void mcpHandler(req, res);
    }
  );

  const adminGuard = (req: Request, res: Response, next: NextFunction): void => {
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const viaProxy = Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
    const header = req.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!isLoopback || viaProxy || token !== adminToken) {
      res.status(404).end();
      return;
    }
    next();
  };

  app.post("/admin/attach", adminGuard, (req, res) => {
    const root = req.body && typeof req.body.workspaceRoot === "string" ? req.body.workspaceRoot : "";
    if (!root.trim()) {
      res.status(400).json({ error: "workspace_root_required" });
      return;
    }
    try {
      const result = registry.attach(root);
      logger.info(`Attached workspace ${result.workspace.name} (${result.workspace.id})`);
      res.json({
        attached: true,
        created: result.created,
        workspaceId: result.workspace.id,
        workspaceName: result.workspace.name,
        workspaceRoot: result.workspace.root,
        leaseExpiresAt: result.lease.expiresAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: "invalid_workspace", message });
    }
  });

  app.post("/admin/activate", adminGuard, (req, res) => {
    const id = req.body && typeof req.body.workspaceId === "string" ? req.body.workspaceId : "";
    try {
      const workspace = registry.setActive(id);
      res.json({ active: true, workspaceId: workspace.id, workspaceName: workspace.name });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(404).json({ error: "workspace_not_attached", message });
    }
  });

  app.post("/admin/detach", adminGuard, (req, res) => {
    const id = req.body && typeof req.body.workspaceId === "string" ? req.body.workspaceId : "";
    res.json({ detached: registry.detach(id), workspaceId: id });
  });

  app.post("/admin/pairing", adminGuard, (_req, res) => {
    const session = pairing.create();
    logger.info("Created Gateway pairing session");
    res.json({ code: session.code, expiresAt: session.expiresAt });
  });

  app.get("/admin/info", adminGuard, (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      gatewayId: GATEWAY_ID,
      workspaceId: registry.getActiveId(),
      workspaceName: (() => {
        try {
          return registry.active().name;
        } catch {
          return null;
        }
      })(),
      workspaces: registry.list(),
      port,
      publicUrl: publicBaseUrl,
      tunnel: tunnel.status(),
      tokenCount: authStore.tokenCount(),
      pairingActive: pairing.hasActiveSession(),
      pid: process.pid,
      startedAt,
    });
  });

  app.post("/admin/tunnel/start", adminGuard, (_req, res) => {
    tunnel
      .start(port)
      .then((url) => {
        publicBaseUrl = url;
        persistRuntime();
        res.json({ url });
      })
      .catch((error: Error) => {
        logger.error(`Gateway tunnel start failed: ${error.message}`);
        res.status(500).json({ error: "tunnel_failed", message: error.message });
      });
  });

  app.post("/admin/tunnel/stop", adminGuard, (_req, res) => {
    void tunnel.stop().then(() => {
      publicBaseUrl = null;
      persistRuntime();
      res.json({ stopped: true });
    });
  });

  app.post("/admin/revoke-all", adminGuard, (_req, res) => {
    const count = authStore.revokeAll();
    pairing.invalidateAll();
    res.json({ revoked: count });
  });

  let closed = false;
  const { server, port: actualPort } = await listen(app, host, opts.port ?? DEFAULT_PORT);
  port = actualPort;

  const persistRuntime = (): void => {
    if (opts.persistRuntime === false) return;
    const state: GatewayRuntimeState = {
      service: SERVICE_NAME,
      version: VERSION,
      gatewayId: GATEWAY_ID,
      pid: process.pid,
      port,
      adminToken,
      publicUrl: publicBaseUrl,
      startedAt,
    };
    writeGatewayRuntimeState(state);
  };
  persistRuntime();

  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await tunnel.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (opts.persistRuntime !== false) clearGatewayRuntimeState();
    logger.info("Gateway stopped");
  };

  app.post("/admin/shutdown", adminGuard, (_req, res) => {
    res.json({ shuttingDown: true });
    setTimeout(() => void shutdown().then(() => process.exit(0)), 100);
  });

  logger.info(`Gateway listening on ${host}:${port}; active workspace ${active.name} (${active.id})`);
  return {
    registry,
    port,
    host,
    adminToken,
    authStore,
    pairing,
    tunnel,
    getPublicBaseUrl: () => publicBaseUrl,
    localBaseUrl: () => `http://${host}:${port}`,
    close: shutdown,
  };
}
