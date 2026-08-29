import { findLiveBridge, type RuntimeState } from "../bridge/runtime.js";
import { appendExecutionRecord } from "../execution/records.js";
import { adminFetch, ensureBridge, type EnsureBridgeResult } from "../process/daemon.js";
import { detectTunnelBinaries } from "../tunnel/detect.js";
import { Workspace } from "../workspace/manager.js";
import type {
  C2CTransport,
  DoctorResult,
  PrepareTransportInput,
  PublishTransportInput,
  TransportDoctorInput,
  TransportReceipt,
  TransportStatus,
  TransportStatusInput,
} from "./types.js";

export interface McpAdminInfo {
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  port: number;
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null; provider: string };
  tokenCount: number;
  pairingActive: boolean;
  pid: number;
  startedAt: string;
}

interface TunnelStartResponse {
  url?: string;
  message?: string;
}

interface PairingResponse {
  code: string;
  expiresAt: number;
}

type EnsureBridgeFunction = (workspaceRoot: string, opts?: { port?: number }) => Promise<EnsureBridgeResult>;

export async function ensureMcpBridgeAndTunnel(
  workspaceRoot: string,
  opts: { tunnel: boolean },
  dependencies: { ensureBridge?: EnsureBridgeFunction } = {}
): Promise<{ runtime: RuntimeState; info: McpAdminInfo; mcpUrl: string | null }> {
  const bridgeEnsurer = dependencies.ensureBridge ?? ensureBridge;
  const { runtime } = await bridgeEnsurer(workspaceRoot);
  let info = await adminFetch<McpAdminInfo>(runtime, "GET", "/admin/info");
  let mcpUrl: string | null = info.publicUrl ? `${info.publicUrl}/mcp` : null;
  if (opts.tunnel && !info.publicUrl) {
    const binaries = detectTunnelBinaries();
    if (!binaries.cloudflared) {
      throw new Error(
        "NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared)."
      );
    }
    const result = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
    if (!result.url) throw new Error(result.message ?? "Tunnel start failed");
    info = await adminFetch<McpAdminInfo>(runtime, "GET", "/admin/info");
    mcpUrl = `${result.url}/mcp`;
  }
  return { runtime, info, mcpUrl };
}

export class McpTransport implements C2CTransport {
  readonly kind = "mcp" as const;

  constructor(private readonly dependencies: { ensureBridge?: EnsureBridgeFunction } = {}) {}

  async prepare(input: PrepareTransportInput): Promise<TransportReceipt> {
    const { runtime, info, mcpUrl } = await ensureMcpBridgeAndTunnel(
      input.workspaceRoot,
      { tunnel: input.tunnel ?? false },
      this.dependencies
    );
    const pairing = input.pairing
      ? await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing")
      : null;
    const resolvedUrl = mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`;
    return {
      ok: true,
      kind: this.kind,
      locator: { mcpUrl: resolvedUrl },
      workspaceId: info.workspaceId,
      workspaceName: info.workspaceName,
      mcpUrl: resolvedUrl,
      local: mcpUrl === null,
      pairingCode: pairing?.code,
      pairingExpiresAt: pairing?.expiresAt,
    };
  }

  async publish(input: PublishTransportInput): Promise<TransportReceipt> {
    const workspaceId = input.workspaceId ?? new Workspace(input.workspaceRoot).id;
    appendExecutionRecord(workspaceId, {
      taskId: input.taskId,
      iteration: input.iteration,
      changedFiles: input.changedFiles,
      tests: input.tests,
      exitStatus: input.exitStatus,
      timestamp: new Date().toISOString(),
      notes: input.notes,
    });
    return { ok: true, kind: this.kind, workspaceId };
  }

  async status(input: TransportStatusInput): Promise<TransportStatus> {
    const workspace = new Workspace(input.workspaceRoot);
    const runtime = await findLiveBridge(workspace.id);
    if (!runtime) return { ok: true, kind: this.kind, available: false, detail: "Bridge is not running." };
    const info = await adminFetch<McpAdminInfo>(runtime, "GET", "/admin/info");
    return { ok: true, kind: this.kind, available: true, info };
  }

  async doctor(input: TransportDoctorInput): Promise<DoctorResult> {
    const status = await this.status(input);
    return {
      ok: status.available,
      kind: this.kind,
      checks: { bridge: { ok: status.available, detail: status.detail } },
    };
  }
}
