import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { ClientRegistry } from "../auth/clients.js";
import { createOAuthRouter, type WorkspaceEntryView } from "../auth/oauth.js";
import { bearerAuth } from "../auth/middleware.js";
import { PairingManager } from "../pairing/manager.js";
import { createMcpServer } from "../mcp/server.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import type { TunnelProvider } from "../tunnel/provider.js";
import { CloudflaredQuickTunnel } from "../tunnel/cloudflared.js";
import { Logger, nullLogger } from "../logger/index.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import {
  writeRuntimeState,
  clearRuntimeState,
  writeHostState,
  clearHostState,
  type RuntimeState,
  type HostState,
} from "./runtime.js";

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
  /** Reserved for future token-TTL tuning; accepted for API compatibility. */
  accessTokenTtlMs?: number;
  /**
   * Called once the host has fully closed, through ANY shutdown path
   * (signal, admin shutdown, last workspace unregistered). The serve command
   * releases the host lock here so a normal stop can never strand it.
   */
  onShutdown?: () => void;
}

export interface WorkspaceSummary {
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
}

export interface Bridge {
  /** Primary (first) workspace — single-workspace compatibility alias. */
  workspace: Workspace;
  port: number;
  host: string;
  adminToken: string;
  /** Primary workspace's auth store — single-workspace compatibility alias. */
  authStore: AuthStore;
  /** Primary workspace's pairing manager — single-workspace compatibility alias. */
  pairing: PairingManager;
  tunnel: TunnelProvider;
  getPublicBaseUrl(): string | null;
  localBaseUrl(): string;
  /** Register another workspace with this host (idempotent). */
  addWorkspace(workspaceRoot: string): WorkspaceSummary;
  /** Remove a workspace; returns false when it was not hosted. */
  removeWorkspace(workspaceId: string): boolean;
  workspaceIds(): string[];
  close(): Promise<void>;
}

/**
 * Listen on the preferred port; on EADDRINUSE fall back to an ephemeral port.
 * Only reached for foreign-process conflicts: concurrent c2c sessions join the
 * running host instead of starting a second one.
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

interface WorkspaceEntry extends WorkspaceEntryView {
  workspace: Workspace;
  mcpHandler: (req: Request, res: Response) => Promise<void>;
}

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const logger = opts.logger ?? nullLogger;
  const host = opts.host ?? DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The bridge only binds to loopback addresses. Public exposure goes through the tunnel.");
  }

  const tunnel: TunnelProvider = opts.tunnelProvider ?? new CloudflaredQuickTunnel(logger);
  const adminToken = `c2c_admin_${randomBytes(24).toString("base64url")}`;
  /** Random per-process identity; adopters use it to validate host records. */
  const instanceId = randomBytes(8).toString("hex");
  const clients = new ClientRegistry();

  const entries = new Map<string, WorkspaceEntry>();
  let primaryId: string | null = null;

  const addWorkspaceEntry = (workspaceRoot: string, authStoreFile?: string): WorkspaceEntry => {
    const workspace = new Workspace(workspaceRoot);
    const existing = entries.get(workspace.id);
    if (existing) return existing;
    const entry: WorkspaceEntry = {
      workspace,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      store: new AuthStore(workspace.id, { file: authStoreFile }),
      pairing: new PairingManager(workspace.id, { ttlMs: opts.pairingTtlMs }),
      mcpHandler: null as unknown as WorkspaceEntry["mcpHandler"],
    };
    entry.mcpHandler = createMcpHttpHandler(
      () => createMcpServer({ workspace: entry.workspace, logger }),
      logger
    );
    entries.set(workspace.id, entry);
    if (!primaryId) primaryId = workspace.id;
    persistRuntime();
    return entry;
  };

  const primary = (): WorkspaceEntry => {
    const entry = primaryId ? entries.get(primaryId) : null;
    if (!entry) throw new Error("No workspace is registered with this bridge");
    return entry;
  };

  const entryFor = (workspaceId: string | undefined): WorkspaceEntry | null => {
    if (!workspaceId) return entries.size > 0 ? primary() : null;
    return entries.get(workspaceId) ?? null;
  };

  let publicBaseUrl: string | null = null;

  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  const getBaseUrl = (req: Request): string => {
    if (publicBaseUrl) return publicBaseUrl;
    const proto = req.protocol;
    const hostHeader = req.get("host") ?? `${host}:${port}`;
    return `${proto}://${hostHeader}`;
  };

  // ---- Health (public but minimal) ---------------------------------------

  // Public but minimal: deliberately no workspace enumeration. Workspace
  // membership is available only through the authenticated admin API.
  app.get("/health", (_req, res) => {
    res.json({ service: SERVICE_NAME, version: VERSION, status: "ok" });
  });

  // ---- OAuth + discovery (workspace is selected by the pairing code) -------

  app.use(
    createOAuthRouter({
      clients,
      entries: () => [...entries.values()],
      getBaseUrl,
      logger,
    })
  );

  // ---- MCP endpoint (bearer-protected, dispatched by the token's workspace) --

  const mcpGuard = bearerAuth({
    entries: () => [...entries.values()].map((entry) => ({ workspaceId: entry.workspaceId, store: entry.store })),
    getBaseUrl,
    logger,
  });
  app.all(
    "/mcp",
    express.json({ limit: "8mb" }),
    mcpGuard,
    (req: Request, res: Response) => {
      const entry = entries.get((req as Request & { c2cWorkspaceId?: string }).c2cWorkspaceId ?? "");
      if (!entry) {
        res.status(403).json({
          error: "forbidden",
          error_description: "This token is not authorized for the connected workspace",
        });
        return;
      }
      void entry.mcpHandler(req, res);
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

  const notFound = (res: Response): void => {
    res.status(404).json({ error: "unknown_workspace", message: "Workspace is not hosted here" });
  };

  app.get("/admin/info", adminGuard, (req, res) => {
    const entry = entryFor(req.query.workspace as string | undefined);
    if (!entry) {
      notFound(res);
      return;
    }
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      instance: instanceId,
      workspaceId: entry.workspaceId,
      workspaceName: entry.workspaceName,
      workspaceRoot: entry.workspace.root,
      workspaces: [...entries.keys()],
      port,
      publicUrl: publicBaseUrl,
      tunnel: tunnel.status(),
      tokenCount: entry.store.tokenCount(),
      pairingActive: entry.pairing.hasActiveSession(),
      pid: process.pid,
      startedAt,
    });
  });

  app.post("/admin/workspaces/register", adminGuard, express.json(), (req, res) => {
    const body = req.body as { workspaceRoot?: string };
    if (!body.workspaceRoot) {
      res.status(400).json({ error: "bad_request", message: "workspaceRoot is required" });
      return;
    }
    try {
      const entry = addWorkspaceEntry(body.workspaceRoot);
      res.json({
        workspaceId: entry.workspaceId,
        workspaceName: entry.workspaceName,
        port,
        publicUrl: publicBaseUrl,
      });
    } catch (error) {
      res.status(400).json({ error: "bad_workspace", message: (error as Error).message });
    }
  });

  app.post("/admin/workspaces/unregister", adminGuard, express.json(), (req, res) => {
    const body = req.body as { workspaceId?: string };
    const entry = body.workspaceId ? entries.get(body.workspaceId) : null;
    if (!entry) {
      notFound(res);
      return;
    }
    entries.delete(entry.workspaceId);
    if (primaryId === entry.workspaceId) primaryId = entries.keys().next().value ?? null;
    clearRuntimeState(entry.workspaceId);
    persistRuntime();
    const hostStopped = entries.size === 0;
    logger.info(`Workspace ${entry.workspaceName} unregistered (hostStopped=${hostStopped})`);
    res.json({ removed: true, hostStopped });
    if (hostStopped) {
      setTimeout(() => {
        void shutdown().then(() => process.exit(0));
      }, 100);
    }
  });

  app.post("/admin/pairing", adminGuard, express.json(), (req, res) => {
    const entry = entryFor((req.body as { workspaceId?: string } | undefined)?.workspaceId);
    if (!entry) {
      notFound(res);
      return;
    }
    const session = entry.pairing.create();
    logger.info(`Created pairing session for workspace ${entry.workspaceName}`);
    res.json({ code: session.code, expiresAt: session.expiresAt });
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
        logger.error(`Tunnel start failed: ${error.message}`);
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

  app.post("/admin/revoke-all", adminGuard, express.json(), (req, res) => {
    const entry = entryFor((req.body as { workspaceId?: string } | undefined)?.workspaceId);
    if (!entry) {
      notFound(res);
      return;
    }
    const count = entry.store.revokeAll();
    entry.pairing.invalidateAll();
    logger.info(`Revoked all tokens (${count}) for workspace ${entry.workspaceName}`);
    res.json({ revoked: count });
  });

  app.post("/admin/shutdown", adminGuard, (_req, res) => {
    res.json({ shuttingDown: true });
    setTimeout(() => {
      void shutdown().then(() => process.exit(0));
    }, 100);
  });

  const { server, port } = await listen(app, host, opts.port ?? DEFAULT_PORT);
  const startedAt = new Date().toISOString();

  const runtimeFor = (entry: WorkspaceEntry): RuntimeState => ({
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId: entry.workspaceId,
    workspaceRoot: entry.workspace.root,
    pid: process.pid,
    port,
    adminToken,
    publicUrl: publicBaseUrl,
    startedAt,
  });

  const persistRuntime = (): void => {
    if (opts.persistRuntime === false) return;
    for (const entry of entries.values()) writeRuntimeState(runtimeFor(entry));
    const hostState: HostState = {
      service: SERVICE_NAME,
      version: VERSION,
      instance: instanceId,
      pid: process.pid,
      port,
      adminToken,
      publicUrl: publicBaseUrl,
      startedAt,
      workspaces: [...entries.keys()],
    };
    writeHostState(hostState);
  };

  // The first workspace comes from the serve command; secondary workspaces
  // register through the admin API at runtime.
  addWorkspaceEntry(opts.workspaceRoot, opts.authStoreFile);
  const p = primary();
  logger.info(
    `Bridge listening on ${host}:${port} for workspace ${p.workspace.name} (${p.workspaceId})`
  );
  persistRuntime();

  // Promise-idempotent: concurrent shutdown callers (signal racing c2c stop,
  // or a last-unregister racing a signal) must all await the SAME cleanup —
  // including the onShutdown lock release — rather than one exiting early.
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        await tunnel.stop().catch(() => undefined);
        // Ordering contract: the listening socket must STOP ACCEPTING before
        // the machine lock is released — otherwise a new serve can acquire
        // the free lock while this process is still the bound host and fall
        // back to an ephemeral port (two hosts).
        (server as unknown as { closeIdleConnections?(): void }).closeIdleConnections?.();
        const closeSettled = new Promise<void>((resolve) => server.close(() => resolve()));
        // Parked keep-alive sockets (CLI fetch pools, ChatGPT) can hold
        // server.close() open indefinitely, so bound the graceful drain —
        // but only after close() has been initiated.
        const closedGracefully = await Promise.race([
          closeSettled.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_500).unref()),
        ]);
        if (opts.persistRuntime !== false) {
          for (const entry of entries.values()) clearRuntimeState(entry.workspaceId);
          clearHostState();
        }
        try {
          opts.onShutdown?.();
        } catch {
          // ignore — shutdown must complete
        }
        logger.info("Bridge stopped");
        if (!closedGracefully) {
          (server as unknown as { closeAllConnections?(): void }).closeAllConnections?.();
          await closeSettled;
        }
      })();
    }
    return shutdownPromise;
  };

  return {
    get workspace() {
      return primary().workspace;
    },
    port,
    host,
    adminToken,
    get authStore() {
      return primary().store;
    },
    get pairing() {
      return primary().pairing;
    },
    get tunnel(): TunnelProvider {
      return tunnel;
    },
    getPublicBaseUrl: () => publicBaseUrl,
    localBaseUrl: () => `http://${host}:${port}`,
    addWorkspace: (workspaceRoot: string) => {
      const entry = addWorkspaceEntry(workspaceRoot);
      return {
        workspaceId: entry.workspaceId,
        workspaceName: entry.workspaceName,
        workspaceRoot: entry.workspace.root,
      };
    },
    removeWorkspace: (workspaceId: string): boolean => {
      const entry = entries.get(workspaceId);
      if (!entry) return false;
      entries.delete(workspaceId);
      if (primaryId === workspaceId) primaryId = entries.keys().next().value ?? null;
      clearRuntimeState(workspaceId);
      persistRuntime();
      return true;
    },
    workspaceIds: () => [...entries.keys()],
    close: shutdown,
  };
}
