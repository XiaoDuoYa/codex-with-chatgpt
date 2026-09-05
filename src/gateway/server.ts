import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import type { Readable, Writable } from "node:stream";
import express, { type NextFunction, type Request, type Response } from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { projectSelectionSchema } from "../session/project-selection.js";
import { pluginIdsSchema, pluginIntentSchema, pluginPreflightSchema } from "../session/turn-preflight.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "../config/paths.js";
import { CONTROL_PHASES, c2cIdSchema } from "../control/result-schema.js";
import { parseControlPageObservation } from "../control/wait-policy.js";
import { Logger, nullLogger } from "../logger/index.js";
import { createMcpServer } from "../mcp/server.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { requireCurrentTurnSurface } from "./machine-gateway.js";
import { resolveMachineIdentity, type MachineIdentity } from "./identity.js";
import {
  MachineGateway,
  type MachineSurfaceIdentity,
  type MachineGatewayOptions,
  type TurnCancellationBinding,
} from "./machine-gateway.js";
import { machineWorkspaceMembershipFile } from "./workspace-registry.js";
import {
  CHATGPT_BROWSER_ID,
  CHATGPT_SURFACE_ID,
  type SurfaceLeaseRef,
} from "../session/surface-ownership.js";
import {
  acquireMachineLifetime,
  clearMachineRuntime,
  machineRuntimeSchema,
  readMachineRuntime,
  writeMachineRuntime,
  type MachineRuntimeState,
} from "./runtime.js";

const TURN_SCOPES = [
  "workspace.read",
  "workspace.search",
  "git.read",
  "execution.read",
  "c2c.result.write",
] as const;

const registerWorkspaceSchema = z.object({ root: z.string().min(1).max(4_096) }).strict();
const registrationIdentitySchema = z
  .object({
    workspaceId: c2cIdSchema,
    projectId: c2cIdSchema,
    registrationId: c2cIdSchema,
  })
  .strict();
const issueTurnSchema = registrationIdentitySchema
  .extend({
    localSessionId: c2cIdSchema,
    taskId: c2cIdSchema,
    iteration: z.number().int().min(0).max(10_000),
    phase: z.enum(["BOOT", ...CONTROL_PHASES]),
    requestId: c2cIdSchema.optional(),
    scopes: z.array(z.enum(TURN_SCOPES)).min(1).max(TURN_SCOPES.length),
    modelId: z.string().min(1).max(128).optional(),
    effort: z.string().min(1).max(128).optional(),
    compactionEpoch: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
    ttlMs: z.number().int().min(1_000).max(60 * 60_000).optional(),
    plugins: pluginIdsSchema.optional(),
    pluginIntent: pluginIntentSchema.optional(),
    pluginPreflight: pluginPreflightSchema.optional(),
  })
  .strict();
const cancellationBindingSchema = z
  .object({
    workspaceId: c2cIdSchema,
    projectId: c2cIdSchema,
    localSessionId: c2cIdSchema,
    taskId: c2cIdSchema,
    iteration: z.number().int().min(0).max(10_000),
    phase: z.enum(["BOOT", ...CONTROL_PHASES]),
    requestId: c2cIdSchema.optional(),
  })
  .strict();
const contextSchema = z
  .object({
    contextId: z.string().regex(/^c2c_ctx_[A-Za-z0-9_-]{43}$/),
    expected: cancellationBindingSchema.optional(),
  })
  .strict();
const revokeRequestSchema = cancellationBindingSchema
  .extend({ requestId: c2cIdSchema })
  .strict();
const surfaceIdentitySchema = registrationIdentitySchema
  .extend({ localSessionId: c2cIdSchema })
  .strict();
const surfaceLeaseRefSchema = z
  .object({
    projectId: c2cIdSchema,
    localSessionId: c2cIdSchema,
    browserId: z.literal(CHATGPT_BROWSER_ID),
    surfaceId: z.literal(CHATGPT_SURFACE_ID),
    tabId: c2cIdSchema,
    generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    ownerProcessEpoch: c2cIdSchema,
  })
  .strict();
const surfaceClaimSchema = surfaceIdentitySchema
  .extend({
    browserId: z.literal(CHATGPT_BROWSER_ID),
    surfaceId: z.literal(CHATGPT_SURFACE_ID),
    tabId: c2cIdSchema,
    projectUrl: z.string().min(1).max(4_096),
    projectSelection: projectSelectionSchema.optional(),
    chatUrl: z.string().min(1).max(4_096).optional(),
    ownerProcessEpoch: c2cIdSchema.optional(),
    replaces: surfaceLeaseRefSchema.optional(),
    leaseTtlMs: z.number().int().min(1_000).max(24 * 60 * 60_000).optional(),
  })
  .strict();
const surfaceCommitSchema = surfaceIdentitySchema
  .extend({
    lease: surfaceLeaseRefSchema,
    chatUrl: z.string().min(1).max(4_096).optional(),
    connectorName: z.string().min(1).max(256).optional(),
  })
  .strict();
const surfaceRenewSchema = surfaceIdentitySchema
  .extend({
    lease: surfaceLeaseRefSchema,
    leaseTtlMs: z.number().int().min(1_000).max(24 * 60 * 60_000).optional(),
  })
  .strict();
const surfaceReleaseSchema = surfaceIdentitySchema
  .extend({ lease: surfaceLeaseRefSchema })
  .strict();
const mailboxCorrelationSchema = z
  .object({
    requestId: c2cIdSchema,
    localSessionId: c2cIdSchema,
    taskId: c2cIdSchema,
    iteration: z.number().int().min(0).max(10_000),
    phase: z.enum(CONTROL_PHASES),
  })
  .strict();
const mailboxIdentitySchema = surfaceIdentitySchema;
const mailboxOpenSchema = mailboxIdentitySchema
  .omit({ localSessionId: true })
  .extend({
    localSessionId: c2cIdSchema,
    taskId: c2cIdSchema,
    iteration: z.number().int().min(0).max(10_000),
    phase: z.enum(CONTROL_PHASES),
    ttlMs: z.number().int().min(1_000).max(60 * 60_000).optional(),
  })
  .strict();
const mailboxLookupSchema = mailboxIdentitySchema
  .omit({ localSessionId: true })
  .extend(mailboxCorrelationSchema.shape)
  .strict();
const mailboxWaitSchema = mailboxLookupSchema.extend({
  timeoutMs: z.number().int().min(0).max(86_400_000),
}).strict();
const mailboxObserveSchema = mailboxLookupSchema.extend({ observation: z.unknown() }).strict();

export interface MachineGatewayServerOptions extends MachineGatewayOptions {
  host?: string;
  port?: number;
  logger?: Logger;
  persistRuntime?: boolean;
  connectStdio?: boolean;
  exitOnShutdown?: boolean;
  associationId?: string;
  associationNonce?: string;
  /** Test seams for the tunnel-owned stdio transport and its input stream. */
  stdioInput?: Readable;
  stdioOutput?: Writable;
  stdioTransport?: Transport;
}

export interface MachineGatewayServer {
  readonly gateway: MachineGateway;
  readonly identity: MachineIdentity;
  readonly runtime: MachineRuntimeState;
  readonly host: string;
  readonly port: number;
  localBaseUrl(): string;
  close(): Promise<void>;
}

function listen(
  app: express.Express,
  host: string,
  preferredPort: number
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(preferredPort, host);
    server.once("listening", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : preferredPort });
    });
    server.once("error", (error: NodeJS.ErrnoException) => reject(error));
  });
}

function isLoopbackRequest(req: Request): boolean {
  const remote = req.socket.remoteAddress ?? "";
  return (
    (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1") &&
    !req.headers["cf-connecting-ip"] &&
    !req.headers["x-forwarded-for"] &&
    !req.headers.forwarded
  );
}

function secretsEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function errorResponse(error: unknown): { status: number; body: { error: string; message: string } } {
  if (error instanceof z.ZodError) {
    return { status: 400, body: { error: "invalid_request", message: "Control request failed validation." } };
  }
  const code =
    error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "control_failed";
  return {
    status:
      code === "SESSION_CAPACITY_REACHED"
        ? 429
        : code.includes("NOT_FOUND")
          ? 404
          : code.includes("MISMATCH")
            ? 409
            : 400,
    body: { error: code.toLowerCase(), message: error instanceof Error ? error.message : String(error) },
  };
}

export async function startMachineGatewayServer(
  options: MachineGatewayServerOptions = {}
): Promise<MachineGatewayServer> {
  const {
    broker,
    host = DEFAULT_HOST,
    port: preferredPort = DEFAULT_PORT,
    logger = nullLogger,
    persistRuntime = true,
    connectStdio = false,
    exitOnShutdown = false,
    associationId = `assoc-${randomBytes(16).toString("hex")}`,
    associationNonce = randomBytes(32).toString("base64url"),
  } = options;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The machine control server only binds to a loopback address.");
  }

  const gateway = new MachineGateway({
    broker,
    surfaceValidator: requireCurrentTurnSurface,
    workspaceMembershipFile: machineWorkspaceMembershipFile(),
  });
  const identity = resolveMachineIdentity();
  const adminToken = `c2c_admin_${randomBytes(24).toString("base64url")}`;
  const startedAt = new Date().toISOString();
  const lifetimeRelease = persistRuntime
    ? acquireMachineLifetime({
        machineId: identity.machineId,
        bootEpoch: gateway.stats().bootEpoch,
        pid: process.pid,
        startedAt,
      })
    : null;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.get("/health", (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      machineId: identity.machineId,
      associationId,
      bootEpoch: gateway.stats().bootEpoch,
      status: "ok",
    });
  });

  const adminGuard = (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!isLoopbackRequest(req) || !secretsEqual(token, adminToken)) {
      res.status(404).end();
      return;
    }
    next();
  };

  let closing = false;
  let closePromise: Promise<void> | null = null;
  let mcpServer: ReturnType<typeof createMcpServer> | null = null;
  let detachStdioLifecycle: (() => void) | null = null;
  let boundPort = preferredPort;
  const pendingMailboxWaits = new Set<{
    controller: AbortController;
    response: Response;
  }>();

  app.get("/admin/info", adminGuard, (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      machineId: identity.machineId,
      pid: process.pid,
      port: boundPort,
      startedAt,
      ...gateway.stats(),
    });
  });

  app.post("/admin/workspaces/register", adminGuard, (req, res) => {
    try {
      const input = registerWorkspaceSchema.parse(req.body);
      const registration = gateway.registerWorkspace(input.root);
      res.json({
        workspaceId: registration.workspaceId,
        projectId: registration.projectId,
        registrationId: registration.registrationId,
        workspaceName: registration.workspace.name,
      });
    } catch (error) {
      const response = errorResponse(error);
      res.status(response.status).json(response.body);
    }
  });

  app.post("/admin/workspaces/unregister", adminGuard, (req, res) => {
    try {
      const input = registrationIdentitySchema.parse(req.body);
      res.json({ unregistered: gateway.unregisterWorkspace(input.workspaceId, input.projectId, input.registrationId) });
    } catch (error) {
      const response = errorResponse(error);
      res.status(response.status).json(response.body);
    }
  });

  app.post("/admin/surfaces/get", adminGuard, (req, res) => {
    try {
      const input = surfaceIdentitySchema.parse(req.body);
      const surface = gateway.surfaceGet(input as MachineSurfaceIdentity);
      res.json(surface);
    } catch (error) {
      const response = errorResponse(error);
      res.status(response.status).json(response.body);
    }
  });

  app.post("/admin/surfaces/claim", adminGuard, (req, res) => {
    try {
      const input = surfaceClaimSchema.parse(req.body);
      const { workspaceId, projectId, registrationId, localSessionId, ...surfaceInput } = input;
      const lease = gateway.surfaceClaim(
        { workspaceId, projectId, registrationId, localSessionId },
        surfaceInput,
      );
      res.json({ lease });
    } catch (error) {
      const response = errorResponse(error);
      res.status(response.status).json(response.body);
    }
  });

  app.post("/admin/surfaces/commit", adminGuard, (req, res) => {
    try {
      const input = surfaceCommitSchema.parse(req.body);
      const { workspaceId, projectId, registrationId, localSessionId, lease, ...options } = input;
      const committed = gateway.surfaceCommit(
        { workspaceId, projectId, registrationId, localSessionId },
        lease as SurfaceLeaseRef,
        options,
      );
      res.json(committed);
    } catch (error) {
      const response = errorResponse(error);
      res.status(response.status).json(response.body);
    }
  });

  app.post("/admin/surfaces/renew", adminGuard, (req, res) => {
    try {
      const input = surfaceRenewSchema.parse(req.body);
      const { workspaceId, projectId, registrationId, localSessionId, lease, leaseTtlMs } = input;
      const renewed = gateway.surfaceRenew(
        { workspaceId, projectId, registrationId, localSessionId },
        lease as SurfaceLeaseRef,
        leaseTtlMs,
      );
      res.json({ lease: renewed });
    } catch (error) {
      const response = errorResponse(error);
      res.status(response.status).json(response.body);
    }
  });

  app.post("/admin/surfaces/release", adminGuard, (req, res) => {
    try {
      const input = surfaceReleaseSchema.parse(req.body);
      const { workspaceId, projectId, registrationId, localSessionId, lease } = input;
      const released = gateway.surfaceRelease(
        { workspaceId, projectId, registrationId, localSessionId },
        lease as SurfaceLeaseRef,
      );
      res.json({ released });
    } catch (error) {
      const response = errorResponse(error);
      res.status(response.status).json(response.body);
    }
  });

  app.post("/admin/surfaces/retire", adminGuard, (req, res) => {
    try {
      const input = surfaceIdentitySchema.parse(req.body);
      res.json(gateway.surfaceRetire(input as MachineSurfaceIdentity));
    } catch (error) {
      const response = errorResponse(error);
      res.status(response.status).json(response.body);
    }
  });

  app.post("/admin/mailbox/open", adminGuard, (req, res) => {
    try {
      const input = mailboxOpenSchema.parse(req.body);
      const { workspaceId, projectId, registrationId, localSessionId, taskId, iteration, phase, ttlMs } = input;
      const opened = gateway.openControlResultRequest(
        { workspaceId, projectId, registrationId, localSessionId },
        { taskId, iteration, phase, ...(ttlMs === undefined ? {} : { ttlMs }) },
      );
      res.json(opened);
    } catch (error) {
      const response = errorResponse(error);
      res.status(response.status).json(response.body);
    }
  });

  app.post("/admin/mailbox/status", adminGuard, (req, res) => {
    try {
      const input = mailboxLookupSchema.parse(req.body);
      const { workspaceId, projectId, registrationId, localSessionId, requestId, taskId, iteration, phase } = input;
      res.json(gateway.getControlResultStatus(
        { workspaceId, projectId, registrationId, localSessionId },
        requestId,
        { taskId, iteration, phase },
      ));
    } catch (error) {
      const response = errorResponse(error);
      res.status(response.status).json(response.body);
    }
  });

  app.post("/admin/mailbox/wait", adminGuard, async (req, res) => {
    const controller = new AbortController();
    const pendingWait = { controller, response: res };
    const abortWait = (): void => controller.abort();
    const cleanupWait = (): void => {
      pendingMailboxWaits.delete(pendingWait);
      req.off("aborted", abortWait);
      res.off("close", cleanupOnClose);
      res.off("finish", cleanupWait);
    };
    const cleanupOnClose = (): void => {
      abortWait();
      cleanupWait();
    };
    pendingMailboxWaits.add(pendingWait);
    req.once("aborted", abortWait);
    res.once("close", cleanupOnClose);
    res.once("finish", cleanupWait);
    try {
      const input = mailboxWaitSchema.parse(req.body);
      const { workspaceId, projectId, registrationId, localSessionId, requestId, taskId, iteration, phase, timeoutMs } = input;
      const status = await gateway.waitForControlResult(
        { workspaceId, projectId, registrationId, localSessionId },
        requestId,
        timeoutMs,
        { taskId, iteration, phase },
        controller.signal,
      );
      if (!controller.signal.aborted && !closing && !res.destroyed && !res.writableEnded) {
        res.json(status);
      }
    } catch (error) {
      if (!controller.signal.aborted && !closing && !res.destroyed && !res.writableEnded) {
        const response = errorResponse(error);
        res.status(response.status).json(response.body);
      }
    } finally {
      cleanupWait();
    }
  });

  app.post("/admin/mailbox/observe", adminGuard, (req, res) => {
    try {
      const input = mailboxObserveSchema.parse(req.body);
      const { workspaceId, projectId, registrationId, localSessionId, requestId, taskId, iteration, phase, observation } = input;
      res.json(gateway.observeControlPage(
        { workspaceId, projectId, registrationId, localSessionId }, requestId,
        { taskId, iteration, phase }, parseControlPageObservation(observation),
      ));
    } catch (error) {
      const response = errorResponse(error);
      res.status(response.status).json(response.body);
    }
  });

  app.post("/admin/mailbox/ack", adminGuard, (req, res) => {
    try {
      const input = mailboxLookupSchema.parse(req.body);
      const { workspaceId, projectId, registrationId, localSessionId, requestId, taskId, iteration, phase } = input;
      res.json(gateway.acknowledgeControlResult(
        { workspaceId, projectId, registrationId, localSessionId },
        requestId,
        { taskId, iteration, phase },
      ));
    } catch (error) {
      const response = errorResponse(error);
      res.status(response.status).json(response.body);
    }
  });

  app.post("/admin/mailbox/cancel", adminGuard, (req, res) => {
    try {
      const input = mailboxLookupSchema.parse(req.body);
      const { workspaceId, projectId, registrationId, localSessionId, requestId, taskId, iteration, phase } = input;
      res.json(gateway.cancelControlResultRequest(
        { workspaceId, projectId, registrationId, localSessionId },
        requestId,
        { taskId, iteration, phase },
      ));
    } catch (error) {
      const response = errorResponse(error);
      res.status(response.status).json(response.body);
    }
  });

  app.post("/admin/turns/issue", adminGuard, (req, res) => {
    try {
      const input = issueTurnSchema.parse(req.body);
      requireCurrentTurnSurface(input);
      res.json(gateway.issueTurn(input));
    } catch (error) {
      const response = errorResponse(error);
      res.status(response.status).json(response.body);
    }
  });

  app.post("/admin/turns/cancel", adminGuard, (req, res) => {
    try {
      const input = contextSchema.parse(req.body);
      gateway.cancelTurn(input.contextId, input.expected as TurnCancellationBinding | undefined);
      res.json({ cancelled: true });
    } catch (error) {
      const response = errorResponse(error);
      res.status(response.status).json(response.body);
    }
  });

  app.post("/admin/turns/revoke-request", adminGuard, (req, res) => {
    try {
      const input = revokeRequestSchema.parse(req.body);
      const revoked = gateway.revokeRequest(input);
      res.json({ revoked });
    } catch (error) {
      const response = errorResponse(error);
      res.status(response.status).json(response.body);
    }
  });

  let listener: { server: Server; port: number };
  try {
    listener = await listen(app, host, preferredPort);
  } catch (error) {
    lifetimeRelease?.();
    throw error;
  }
  const { server, port } = listener;
  boundPort = port;
  const runtime: MachineRuntimeState = {
    service: SERVICE_NAME,
    version: VERSION,
    machineId: identity.machineId,
    associationId,
    associationNonce,
    bootEpoch: gateway.stats().bootEpoch,
    pid: process.pid,
    port,
    adminToken,
    startedAt,
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    for (const pendingWait of pendingMailboxWaits) {
      pendingWait.controller.abort();
      if (!pendingWait.response.destroyed && !pendingWait.response.writableEnded) {
        pendingWait.response.destroy();
      }
    }
    pendingMailboxWaits.clear();
    closePromise = (async () => {
      try {
        detachStdioLifecycle?.();
        detachStdioLifecycle = null;
        await mcpServer?.close().catch(() => undefined);
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        if (persistRuntime) {
          let current: MachineRuntimeState | null = null;
          try {
            current = readMachineRuntime();
          } catch {
            // A malformed or foreign runtime record is never removed here.
          }
          if (
            current &&
            current.machineId === runtime.machineId &&
            current.bootEpoch === runtime.bootEpoch &&
            current.pid === runtime.pid
          ) {
            clearMachineRuntime();
          }
        }
        logger.info("Machine gateway stopped");
      } finally {
        lifetimeRelease?.();
      }
    })();
    return closePromise;
  };

  try {
    machineRuntimeSchema.parse(runtime);
    if (persistRuntime) writeMachineRuntime(runtime);
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }

  app.post("/admin/shutdown", adminGuard, (_req, res) => {
    if (closing) {
      res.status(503).json({ error: "gateway_shutting_down", message: "Machine gateway is shutting down." });
      return;
    }
    res.json({ shuttingDown: true });
    setTimeout(() => {
      void close().finally(() => {
        if (exitOnShutdown) process.exit(0);
      });
    }, 20);
  });

  if (connectStdio) {
    try {
      mcpServer = createMcpServer({ gateway, logger });
      const stdioInput = options.stdioInput ?? process.stdin;
      const stdioTransport = options.stdioTransport ?? new StdioServerTransport(
        stdioInput,
        options.stdioOutput ?? process.stdout,
      );
      const closeOnStdioEnd = (): void => {
        void close();
      };
      stdioInput.once("end", closeOnStdioEnd);
      stdioInput.once("close", closeOnStdioEnd);
      detachStdioLifecycle = () => {
        stdioInput.off("end", closeOnStdioEnd);
        stdioInput.off("close", closeOnStdioEnd);
      };
      await mcpServer.connect(stdioTransport);
      // Protocol.connect installs its own callbacks and intentionally
      // replaces callbacks set by callers. Install the lifecycle hook after
      // connect, then let close()'s `closing` guard prevent recursion when the
      // server closes the transport itself.
      const previousOnClose = stdioTransport.onclose;
      stdioTransport.onclose = () => {
        previousOnClose?.();
        if (!closing) void close();
      };
    } catch (error) {
      await close().catch(() => undefined);
      throw error;
    }
  }

  logger.info(`Machine gateway listening on ${host}:${port}`);
  return {
    gateway,
    identity,
    runtime,
    host,
    port,
    localBaseUrl: () => `http://${host}:${port}`,
    close,
  };
}

export { TURN_SCOPES };
