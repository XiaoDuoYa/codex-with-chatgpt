import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBridge } from "../bridge/server.js";
import { findLiveBridge, probeBridge, readRuntimeState, type RuntimeState } from "../bridge/runtime.js";
import {
 adminFetch,
 ensureBridge,
 ensureBridgeWithinLifecycleLock,
 stopBridge,
 stopBridgeWithinLifecycleLock,
 withBridgeLifecycle,
} from "../process/daemon.js";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { appendExecutionRecord } from "../execution/records.js";
import { detectTunnelBinaries } from "../tunnel/detect.js";
import {
  chooseQuickTunnel,
  hasCloudflaredCert,
  ProcessCloudflaredAccount,
  provisionNamedTunnel,
} from "../tunnel/named-provision.js";
import { parseZoneInput, suggestedNamedHostname } from "../tunnel/hostname.js";
import {
  isNamedTunnelReady,
  NAMED_LOGIN_PROMPT,
  NAMED_REPAIR_MESSAGE,
  needsTunnelChoice,
  readTunnelState,
  TUNNEL_CHOICE_PROMPT,
} from "../tunnel/state.js";
import { Logger } from "../logger/index.js";
import { getStateDir, writeSecureJson } from "../config/paths.js";
import {
  acquireSessionLock,
  assertSessionLock,
  DEFAULT_SESSION_LOCK_LEASE_MS,
  readSessionLock,
  refreshSessionLock,
  releaseSessionLock,
  sessionLockBusyMessage,
  type WorkspaceLockInfo,
} from "../session/lock.js";
import { ensureSandboxAllowlist, getCodexConfigPath, isStateDirAllowlisted } from "../config/sandbox-allow.js";
import {
  CHATGPT_CREATE_CONNECTOR_URL,
  CHATGPT_DEVELOPER_MODE_URL,
  CHATGPT_PLUGINS_URL,
  commitConnectorBinding,
  connectorNameFor,
  mcpUrlFromPublic,
  normalizePublicUrl,
  observeWorkspaceEndpoint,
  previewWorkspaceEndpoint,
  readLastEndpoint,
  reclaimUserMessage,
  type LastEndpoint,
} from "../config/endpoint.js";
import { PRODUCT_NAME, VERSION } from "../version.js";

function requireSessionLock(workspaceId: string, token?: string): WorkspaceLockInfo {
  if (!token?.trim()) {
    throw new Error("C2C_SESSION_LOCK_REQUIRED: acquire the workspace session lock first");
  }
  return assertSessionLock(workspaceId, token.trim());
}

const program = new Command();

const say = (msg: string): void => {
  process.stdout.write(msg + "\n");
};
const check = (msg: string): void => say(`✓ ${msg}`);
const cross = (msg: string): void => say(`✗ ${msg}`);

function resolveWorkspace(option?: string): string {
  return path.resolve(option ?? process.cwd());
}
function persistWorkspaceEndpoint(opts: {
  workspaceId: string;
  workspaceName: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string | null;
  previous?: LastEndpoint | null;
  beforeWrite?: () => void;
}): LastEndpoint {
  opts.beforeWrite?.();
  return observeWorkspaceEndpoint({
    workspaceId: opts.workspaceId,
    workspaceName: opts.workspaceName,
    port: opts.port,
    publicUrl: opts.publicUrl,
    mcpUrl: opts.mcpUrl,
    previous: opts.previous,
  });
}

function endpointConnectorName(state: LastEndpoint | null, workspace: Workspace): string {
  return (
    state?.pendingRepair?.connectorName ??
    state?.connectorBound?.connectorName ??
    connectorNameFor({
      workspaceName: workspace.name,
      workspaceId: workspace.id,
      hadEndpointBefore: Boolean(state),
    })
  );
}

function endpointRepairAction(state: LastEndpoint | null): "none" | "create" | "update" {
  if (!state?.pendingRepair) return "none";
  return state.pendingRepair.reason === "first_setup" || state.pendingRepair.reason === "legacy_state"
    ? "create"
    : "update";
}

function tunnelChoicePayload(workspace: Workspace, zoneHint?: string): Record<string, unknown> {
  const state = readTunnelState(workspace.id);
  const zone = parseZoneInput(zoneHint ?? "") ?? state.zone ?? null;
  return {
    ok: true,
    needsChoice: needsTunnelChoice(state),
    preference: state.preference,
    loggedIn: hasCloudflaredCert(),
    namedReady: isNamedTunnelReady(state),
    zone,
    hostname: state.hostname ?? null,
    suggestedHostname: zone ? suggestedNamedHostname(zone, workspace.name, workspace.id) : null,
    userPrompt: needsTunnelChoice(state) ? TUNNEL_CHOICE_PROMPT : undefined,
    loginPrompt: NAMED_LOGIN_PROMPT,
    fallbackReason: state.fallbackReason,
  };
}

function trySandboxAllow():
  | { ok: true; added: boolean; alreadyAllowed: boolean; stateDir: string; configPath: string }
  | { ok: false; added: false; alreadyAllowed: false; error: string } {
  try {
    const result = ensureSandboxAllowlist();
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, added: false, alreadyAllowed: false, error: (error as Error).message };
  }
}

interface TunnelStartResponse {
  url?: string;
  error?: string;
  message?: string;
}

interface PairingResponse {
  code: string;
  expiresAt: number;
  reused: boolean;
}

interface AdminInfo {
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  port: number;
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null; provider: string };
  tokenCount: number;
  clients?: Array<{
    clientId: string;
    clientName?: string;
    redirectUris: string[];
    createdAt: string;
    registrationFingerprint: string;
    activeTokenCount: number;
  }>;
  pairingActive: boolean;
  pid: number;
  startedAt: string;
}

type EnsureBridgeFn = (workspaceRoot: string) => Promise<{ runtime: RuntimeState; spawned: boolean }>;

async function ensureBridgeAndTunnel(
 workspaceRoot: string,
 opts: { tunnel: boolean },
 ensure: EnsureBridgeFn = ensureBridge
): Promise<{ runtime: RuntimeState; info: AdminInfo; mcpUrl: string | null }> {
 const { runtime } = await ensure(workspaceRoot);
 let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
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
  info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
  mcpUrl = `${result.url}/mcp`;
 }
 return { runtime, info, mcpUrl };
}

program
  .name("c2c")
  .description(`${PRODUCT_NAME} — ChatGPT thinks. Codex works.`)
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: true });

// ---------------------------------------------------------------- serve (internal)

program
  .command("serve", { hidden: true })
  .description("Run the bridge in the foreground (internal)")
  .requiredOption("--workspace <path>")
  .option("--port <port>", "preferred port")
  .action(async (opts: { workspace: string; port?: string }) => {
    const logger = new Logger({ name: "bridge", console: true });
    const bridge = await startBridge({
      workspaceRoot: resolveWorkspace(opts.workspace),
      port: opts.port ? parseInt(opts.port, 10) : undefined,
      logger,
    });
    const shutdown = (): void => {
      void bridge.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    say(`bridge ready on ${bridge.localBaseUrl()} (workspace ${bridge.workspace.name})`);
  });

// ---------------------------------------------------------------- start

program
  .command("start")
  .description("Start (or reuse) the bridge for this workspace")
  .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
  .option("--tunnel", "also establish the secure public connection", false)
  .option("--json", "machine-readable output", false)
  .option("--lock-token <token>", "workspace session lock token")
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean; lockToken?: string }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const workspace = new Workspace(root);
      requireSessionLock(workspace.id, opts.lockToken);
      const { runtime, info, mcpUrl, endpoint } = await withBridgeLifecycle(root, async () => {
        requireSessionLock(workspace.id, opts.lockToken);
        const ensured = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel }, ensureBridgeWithinLifecycleLock);
        requireSessionLock(workspace.id, opts.lockToken);
        const endpoint = persistWorkspaceEndpoint({
          workspaceId: ensured.info.workspaceId,
          workspaceName: ensured.info.workspaceName,
          port: ensured.runtime.port,
          publicUrl: ensured.info.publicUrl,
          mcpUrl: ensured.mcpUrl,
          beforeWrite: () => requireSessionLock(workspace.id, opts.lockToken),
        });
        return { ...ensured, endpoint };
      });
      const connectorName = endpointConnectorName(endpoint, workspace);
      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            port: runtime.port,
            workspaceId: info.workspaceId,
            mcpUrl,
            connectorName,
            endpoint: {
              generation: endpoint.connectorBound?.generation ?? endpoint.pendingRepair?.generation ?? null,
              fingerprint: endpoint.connectorBound?.fingerprint ?? endpoint.pendingRepair?.fingerprint ?? null,
              bound: Boolean(endpoint.connectorBound),
              repair: endpointRepairAction(endpoint),
            },
          })
        );
        return;
      }
      check(`当前项目已识别（${info.workspaceName}）`);
      check("Workspace Bridge 已启动");
      if (mcpUrl) check("安全连接已建立");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- setup

program
  .command("setup")
  .description("First-time setup: bridge + secure connection + pairing code")
  .option("-w, --workspace <path>")
  .option("--no-tunnel", "local-only setup (development)")
  .option("--json", "machine-readable output", false)
  .option("--lock-token <token>", "workspace session lock token")
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean; lockToken?: string }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const workspace = new Workspace(root);
      requireSessionLock(workspace.id, opts.lockToken);
      if (!opts.json) {
        say(PRODUCT_NAME);
        say("");
        say("正在连接 ChatGPT…");
        say("");
      }
      const { sandbox, runtime, info, mcpUrl, endpoint, connectorName, pairingResult, pairingReused, tunnelState } = await withBridgeLifecycle(
        root,
        async () => {
          requireSessionLock(workspace.id, opts.lockToken);
          const sandbox = trySandboxAllow();
          requireSessionLock(workspace.id, opts.lockToken);
          const ensured = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel }, ensureBridgeWithinLifecycleLock);
          requireSessionLock(workspace.id, opts.lockToken);
          const endpoint = persistWorkspaceEndpoint({
            workspaceId: ensured.info.workspaceId,
            workspaceName: ensured.info.workspaceName,
            port: ensured.runtime.port,
            publicUrl: ensured.info.publicUrl,
            mcpUrl: ensured.mcpUrl,
            beforeWrite: () => requireSessionLock(workspace.id, opts.lockToken),
          });
          const connectorName = endpointConnectorName(endpoint, workspace);
          const pairingReused = ensured.info.pairingActive;
          requireSessionLock(workspace.id, opts.lockToken);
          const pairingResult = await adminFetch<PairingResponse>(ensured.runtime, "POST", "/admin/pairing");
          const tunnelState = readTunnelState(ensured.info.workspaceId);
          return { ...ensured, sandbox, endpoint, connectorName, pairingResult, pairingReused, tunnelState };
        }
      );
      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            connectorName,
            mcpUrl: mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`,
            local: mcpUrl === null,
            pairingCode: pairingResult.code,
            pairingExpiresAt: pairingResult.expiresAt,
            pairingReused,
            endpoint: {
              generation: endpoint.pendingRepair?.generation ?? endpoint.connectorBound?.generation ?? null,
              fingerprint: endpoint.pendingRepair?.fingerprint ?? endpoint.connectorBound?.fingerprint ?? null,
              bound: Boolean(endpoint.connectorBound),
              repair: endpointRepairAction(endpoint),
            },
            sandbox,
            tunnel: {
              mode: isNamedTunnelReady(tunnelState) ? "named" : "quick",
              hostname: tunnelState.hostname ?? null,
              fallback: Boolean(tunnelState.fallbackReason),
            },
          })
        );
        return;
      }
      check(`当前项目已识别（${info.workspaceName}）`);
      check("Workspace Bridge 已启动");
      if (mcpUrl) check("安全连接已建立");
      say("");
      say(`连接地址：${mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`}`);
      say(`配对码：${pairingResult.code}（${Math.round((pairingResult.expiresAt - Date.now()) / 60000)} 分钟内有效）`);
      say("");
      say("下一步：在 ChatGPT 的连接器设置中添加以上地址（OAuth），并在授权页输入配对码。");
      say("如果你在使用 Codex Skill，这一步会自动完成。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- stop / restart

program
  .command("stop")
  .description("Stop the bridge for this workspace")
  .option("-w, --workspace <path>")
  .option("--lock-token <token>", "workspace session lock token")
  .action(async (opts: { workspace?: string; lockToken?: string }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      requireSessionLock(workspace.id, opts.lockToken);
      const stopped = await stopBridge(workspace.root);
      if (stopped) check("Bridge 已停止");
      else say("没有正在运行的 Bridge。");
    } catch (error) {
      handleCliError(error, false);
    }
  });

program
  .command("restart")
  .description("Restart the bridge for this workspace")
  .option("-w, --workspace <path>")
  .option("--tunnel", "re-establish the secure public connection", false)
  .option("--lock-token <token>", "workspace session lock token")
  .action(async (opts: { workspace?: string; tunnel: boolean; lockToken?: string }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const workspace = new Workspace(root);
      requireSessionLock(workspace.id, opts.lockToken);
      const result = await withBridgeLifecycle(root, async () => {
        requireSessionLock(workspace.id, opts.lockToken);
        await stopBridgeWithinLifecycleLock(root);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const ensured = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel }, ensureBridgeWithinLifecycleLock);
        requireSessionLock(workspace.id, opts.lockToken);
        return ensured;
      });
      check(`Bridge 已重启（${result.info.workspaceName}）`);
      if (result.mcpUrl) check(`安全连接已建立`);
    } catch (error) {
      handleCliError(error, false);
    }
  });


// ---------------------------------------------------------------- status

program
  .command("status")
  .description("Show bridge status for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const sessionLock = readSessionLock(workspace.id);
    const runtime = await findLiveBridge(workspace.id);
    if (!runtime) {
      if (opts.json) say(JSON.stringify({ ok: false, running: false, sessionLock }));
      else say("Bridge 未运行。使用 `c2c start` 启动。");
      return;
    }
    const info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    if (opts.json) {
      say(JSON.stringify({ ok: true, running: true, ...info, sessionLock }));
      return;
    }
    say(PRODUCT_NAME);
    say("");
    check(`Workspace：${info.workspaceName}`);
    check(`Bridge：运行中（端口 ${info.port}）`);
    if (info.tunnel.running && info.tunnel.url) check(`安全连接：${info.tunnel.url}/mcp`);
    else say("· 安全连接：未启用（本地模式）");
    say(`· 已授权连接：${info.tokenCount > 0 ? "是" : "否"}`);
  });

// ---------------------------------------------------------------- doctor

program
  .command("doctor")
  .description("Diagnose and auto-repair the connection")
  .option("-w, --workspace <path>")
  .option("--no-fix", "diagnose only, do not repair")
  .option("--json", "machine-readable output", false)
  .option("--lock-token <token>", "workspace session lock token")
  .action(async (opts: { workspace?: string; fix: boolean; json: boolean; lockToken?: string }) => {
    const root = resolveWorkspace(opts.workspace);
    if (opts.fix) {
      try {
        requireSessionLock(new Workspace(root).id, opts.lockToken);
      } catch (error) {
        handleCliError(error, opts.json);
        return;
      }
    }
    const report: Record<string, { ok: boolean; detail?: string }> = {};
    const results: string[] = [];

    // Node
    const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
    report.node = { ok: nodeMajor >= 20, detail: `v${process.versions.node}` };

    // Codex sandbox writable_roots (so later chats do not need elevation)
    if (opts.fix) {
      const sandbox = trySandboxAllow();
      if (sandbox.ok) {
        report.sandbox = { ok: true, detail: sandbox.alreadyAllowed ? "已在白名单" : "已写入白名单" };
        if (sandbox.added) results.push("已将本地设置目录加入 Codex 沙箱白名单");
      } else {
        report.sandbox = { ok: false, detail: sandbox.error };
      }
    } else {
      try {
        const configPath = getCodexConfigPath();
        const allowed =
          fs.existsSync(configPath) && isStateDirAllowlisted(fs.readFileSync(configPath, "utf8"), getStateDir());
        report.sandbox = allowed ? { ok: true, detail: "已在白名单" } : { ok: false, detail: "未在白名单" };
      } catch (error) {
        report.sandbox = { ok: false, detail: (error as Error).message };
      }
    }

    // Workspace
    let workspace: Workspace | null = null;
    try {
      workspace = new Workspace(root);
      report.workspace = { ok: true, detail: workspace.name };
    } catch (error) {
      report.workspace = { ok: false, detail: (error as Error).message };
    }

    // Bridge
    let runtime: RuntimeState | null = null;
    if (workspace) {
      runtime = await findLiveBridge(workspace.id);
      if (!runtime && opts.fix) {
        try {
          requireSessionLock(workspace.id, opts.lockToken);
          runtime = (await ensureBridge(root)).runtime;
          requireSessionLock(workspace.id, opts.lockToken);
          results.push("已自动启动 Bridge");
        } catch (error) {
          report.bridge = { ok: false, detail: (error as Error).message };
        }
      }
      if (runtime) report.bridge = { ok: true, detail: `端口 ${runtime.port}` };
      else report.bridge = report.bridge ?? { ok: false, detail: "未运行" };
    }

    // MCP local reachability (401 without token means MCP + auth both work)
    if (runtime) {
      try {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
        });
        report.mcp = { ok: response.status === 401, detail: `未授权请求返回 ${response.status}` };
        report.oauth = { ok: response.status === 401 };
      } catch (error) {
        report.mcp = { ok: false, detail: (error as Error).message };
      }
    }

    // Tunnel + remote reachability. If this workspace once had a public URL,
    // a full quit reclaims it — restore a tunnel and tell the Skill to update
    // the existing ChatGPT connector (never treat that as "local mode").
    // A saved endpoint is only an observation until `connector commit` binds
    // the connector identity. Reading it never confirms a URL change.
    let endpointState = workspace ? readLastEndpoint(workspace.id) : null;
    const connectorName = workspace ? endpointConnectorName(endpointState, workspace) : "Codex with ChatGPT";
    const tunnelState = workspace ? readTunnelState(workspace.id) : null;
    const namedReady = tunnelState ? isNamedTunnelReady(tunnelState) : false;
    let namedRepair: { needed: boolean; userMessage?: string } = { needed: false };
    let chatgptRepair: {
      needed: boolean;
      status: "none" | "pending" | "blocked";
      reason?: string;
      connectorAction: "none" | "create" | "update";
      connectorName: string;
      userMessage?: string;
      mcpUrl: string | null;
      previousMcpUrl: string | null;
      generation?: number;
      fingerprint?: string;
      pairingCode?: string;
      pairingExpiresAt?: number;
      pairingReused: boolean;
      pages: {
        developerMode: string;
        plugins: string;
        createConnector: string;
      };
    } = {
      needed: false,
      status: "none",
      connectorAction: endpointRepairAction(endpointState),
      connectorName,
      mcpUrl: endpointState?.observed.mcpUrl ?? null,
      previousMcpUrl: endpointState?.connectorBound?.mcpUrl ?? null,
      generation: endpointState?.pendingRepair?.generation,
      fingerprint: endpointState?.pendingRepair?.fingerprint,
      pairingReused: false,
      pages: {
        developerMode: CHATGPT_DEVELOPER_MODE_URL,
        plugins: CHATGPT_PLUGINS_URL,
        createConnector: CHATGPT_CREATE_CONNECTOR_URL,
      },
    };

    if (runtime && workspace) {
      let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
      if (namedReady && opts.fix && info.tunnel.provider !== "cloudflare-named") {
        requireSessionLock(workspace.id, opts.lockToken);
        await stopBridge(root);
        await new Promise((resolve) => setTimeout(resolve, 400));
        try {
          requireSessionLock(workspace.id, opts.lockToken);
          runtime = (await ensureBridge(root)).runtime;
          requireSessionLock(workspace.id, opts.lockToken);
          info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
          results.push("已切换到固定域名连接");
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }
      const expectedPublic =
        Boolean(
          endpointState?.observed.publicUrl ||
            endpointState?.connectorBound?.publicUrl ||
            endpointState?.pendingRepair?.observed.publicUrl
        ) || namedReady;
      let currentUrl = info.publicUrl ?? info.tunnel.url;
      let healthy = false;
      if (currentUrl) {
        try {
          const response = await fetch(`${currentUrl}/health`, { signal: AbortSignal.timeout(8000) });
          healthy = response.ok;
        } catch {
          healthy = false;
        }
      }

      if ((!currentUrl || !healthy) && opts.fix && (expectedPublic || info.tunnel.running)) {
        try {
          const binaries = detectTunnelBinaries();
          if (!binaries.cloudflared) {
            report.tunnel = { ok: false, detail: "NEED_CLOUDFLARED" };
          } else {
            requireSessionLock(workspace.id, opts.lockToken);
            const started = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
            if (started.url) {
              requireSessionLock(workspace.id, opts.lockToken);
              const previousUrl =
                endpointState?.connectorBound?.publicUrl ??
                endpointState?.observed.publicUrl ??
                endpointState?.pendingRepair?.observed.publicUrl;
              currentUrl = started.url;
              healthy = true;
              info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
              const sameAddress =
                previousUrl && normalizePublicUrl(previousUrl) === normalizePublicUrl(started.url);
              results.push(sameAddress ? "已重新建立安全连接" : "已重新建立安全连接（地址已更换）");
            }
          }
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }

      if (currentUrl && healthy) {
        report.tunnel = { ok: true, detail: currentUrl };
        const nextMcp = mcpUrlFromPublic(currentUrl);
        const preview = previewWorkspaceEndpoint({
          workspaceId: info.workspaceId,
          workspaceName: info.workspaceName,
          port: runtime.port,
          publicUrl: currentUrl,
          mcpUrl: nextMcp,
          previous: endpointState,
        });
        if (opts.fix && nextMcp) {
          endpointState = persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: currentUrl,
            mcpUrl: nextMcp,
            previous: endpointState,
            beforeWrite: () => requireSessionLock(workspace.id, opts.lockToken),
          });
        } else {
          endpointState = preview;
        }
        const action = endpointRepairAction(endpointState);
        const boundName = endpointConnectorName(endpointState, workspace);
        chatgptRepair = {
          ...chatgptRepair,
          needed: action !== "none",
          status: action === "none" ? "none" : "pending",
          reason: endpointState.pendingRepair?.reason,
          connectorAction: action,
          connectorName: boundName,
          userMessage: action === "none" ? undefined : reclaimUserMessage(boundName),
          mcpUrl: nextMcp,
          previousMcpUrl: endpointState.connectorBound?.mcpUrl ?? null,
          generation: endpointState.pendingRepair?.generation,
          fingerprint: endpointState.pendingRepair?.fingerprint,
        };
        if (action !== "none" && opts.fix) {
          try {
            requireSessionLock(workspace.id, opts.lockToken);
            const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
            chatgptRepair.pairingCode = pairing.code;
            chatgptRepair.pairingExpiresAt = pairing.expiresAt;
            chatgptRepair.pairingReused = pairing.reused;
            results.push(
              pairing.reused
                ? `连接器修复仍待完成（generation ${endpointState.pendingRepair?.generation}），复用现有配对码`
                : `已生成新的配对码，需要更新「${boundName}」`
            );
          } catch (error) {
            report.oauth = { ok: false, detail: (error as Error).message };
            chatgptRepair.status = "blocked";
          }
        }
      } else if (namedReady) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "NAMED_TUNNEL_DOWN" };
        namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
      } else if (expectedPublic) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "安全连接未恢复" };
        chatgptRepair = {
          ...chatgptRepair,
          needed: true,
          status: "pending",
          reason: "address_reclaimed",
          connectorAction: "update",
          connectorName,
          userMessage: reclaimUserMessage(connectorName),
          mcpUrl: null,
        };
      } else if (!currentUrl) {
        report.tunnel = { ok: true, detail: "未启用（本地模式）" };
      } else {
        report.tunnel = { ok: false, detail: "公网地址无法访问" };
      }
    } else if (
      namedReady ||
      endpointState?.observed.publicUrl ||
      endpointState?.connectorBound?.publicUrl ||
      endpointState?.pendingRepair?.observed.publicUrl
    ) {
      report.tunnel = { ok: false, detail: namedReady ? "NAMED_TUNNEL_DOWN" : "安全连接未运行" };
      if (namedReady) {
        namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
      } else {
        chatgptRepair = {
          ...chatgptRepair,
          needed: true,
          status: "pending",
          reason: "address_reclaimed",
          connectorAction: "update",
          connectorName,
          userMessage: reclaimUserMessage(connectorName),
          mcpUrl: null,
        };
      }
    }

    const reportFailed = Object.values(report).some((value) => !value.ok);
    const hasPendingRepair = chatgptRepair.needed || namedRepair.needed;
    const status: "ok" | "pending" | "blocked" =
      chatgptRepair.status === "blocked"
        ? "blocked"
        : hasPendingRepair && !opts.fix
          ? "pending"
          : reportFailed
            ? "blocked"
            : hasPendingRepair
              ? "pending"
              : "ok";
    // Preserve the historical no-fix exit-0 diagnostic mode, but never report
    // pending as `ok` in JSON. Repair mode remains non-zero until committed.
    const exitCode = status === "blocked" || (status === "pending" && opts.fix) ? 1 : 0;
    if (opts.json) {
      say(JSON.stringify({ ok: status === "ok", status, exitCode, report, repairs: results, chatgptRepair, namedRepair }));
      if (exitCode) process.exitCode = exitCode;
      return;
    }
    say(`${PRODUCT_NAME} Doctor`);
    say("");
    const labels: Record<string, string> = {
      node: "Node.js",
      sandbox: "Sandbox",
      workspace: "Workspace",
      bridge: "Bridge",
      mcp: "MCP",
      oauth: "OAuth",
      tunnel: "Tunnel",
    };
    let allOk = true;
    for (const [key, value] of Object.entries(report)) {
      const label = labels[key] ?? key;
      if (value.ok) check(`${label}${value.detail ? `（${value.detail}）` : ""}`);
      else {
        cross(`${label}${value.detail ? `：${value.detail}` : ""}`);
        allOk = false;
      }
    }
    for (const repair of results) say(`· ${repair}`);
    say("");
    if (namedRepair.needed && namedRepair.userMessage) {
      say(namedRepair.userMessage);
      say("");
    }

    if (chatgptRepair.needed && chatgptRepair.userMessage) {
      say(chatgptRepair.userMessage);
      if (chatgptRepair.mcpUrl) say(`新的连接地址：${chatgptRepair.mcpUrl}`);
      if (chatgptRepair.pairingCode) say(`配对码：${chatgptRepair.pairingCode}`);
      say("");
    }
    say(
      allOk && !chatgptRepair.needed && !namedRepair.needed
        ? "Everything looks good."
        : chatgptRepair.needed
          ? "本地已就绪，还需要在 ChatGPT 删除并重新添加该连接。"
          : namedRepair.needed
            ? "固定域名还没连上，需要先登录 Cloudflare。"
            : "仍有问题未解决，可尝试 `c2c restart --tunnel`。"
    );
    if (exitCode) process.exitCode = exitCode;
  });

// ---------------------------------------------------------------- connector lifecycle

const connector = program.command("connector").description("Commit the connector identity after ChatGPT recreation");

connector
  .command("commit")
  .description("Commit the connector and save the verified new ChatGPT conversation atomically")
  .option("-w, --workspace <path>")
  .requiredOption("--generation <n>", "generation printed by `c2c doctor --json`")
  .requiredOption("--fingerprint <fingerprint>", "fingerprint printed by `c2c doctor --json`")
  .requiredOption("--url <url>", "new conversation URL after workspace_info succeeds")
  .option("--title <title>")
  .option("--task <id>")
  .option("--iteration <n>")
  .option("--state <state>", "last protocol state, e.g. EXECUTED")
  .option("--lock-token <token>", "workspace session lock token")
  .option("--json", "machine-readable output", false)
  .action(
    (opts: {
      workspace?: string;
      generation: string;
      fingerprint: string;
      url: string;
      title?: string;
      task?: string;
      iteration?: string;
      state?: string;
      lockToken?: string;
      json: boolean;
    }) => {
      try {
        const workspace = new Workspace(resolveWorkspace(opts.workspace));
        requireSessionLock(workspace.id, opts.lockToken);
        const state = readLastEndpoint(workspace.id);
        const pending = state?.pendingRepair;
        if (!state || !pending) {
          throw new Error("C2C_CONNECTOR_REPAIR_NOT_PENDING: run `c2c doctor` first");
        }
        const generation = Number(opts.generation);
        const fingerprint = opts.fingerprint.trim();
        if (pending.generation !== generation || pending.fingerprint !== fingerprint) {
          throw new Error("C2C_CONNECTOR_BINDING_MISMATCH: generation or fingerprint is not the current repair");
        }
        if (
          !pending.observed.mcpUrl ||
          normalizePublicUrl(pending.observed.mcpUrl) !== normalizePublicUrl(state.observed.mcpUrl ?? "")
        ) {
          throw new Error("C2C_CONNECTOR_ENDPOINT_CHANGED: run doctor again before committing the connector");
        }
        const file = sessionFile(workspace.id);
        const previousSession = readSavedSession(file);
        const saved: SavedSession = {
          url: opts.url,
          title: opts.title ?? previousSession?.title,
          taskId: opts.task ?? previousSession?.taskId,
          iteration: opts.iteration ? parseInt(opts.iteration, 10) : previousSession?.iteration,
          lastState: opts.state ?? previousSession?.lastState,
          generation,
          fingerprint,
          connectorName: pending.connectorName,
          mcpUrl: pending.observed.mcpUrl,
          savedAt: new Date().toISOString(),
        };
        // Write the session first. If interrupted here, the endpoint remains
        // pending and this session is explicitly unusable until commit finishes.
        writeSecureJson(file, saved);
        let committed: LastEndpoint;
        try {
          committed = commitConnectorBinding({ state, generation, fingerprint });
        } catch (error) {
          if (previousSession) writeSecureJson(file, previousSession);
          throw error;
        }
        const binding = committed.connectorBound;
        if (!binding) throw new Error("C2C_CONNECTOR_COMMIT_FAILED: connector binding was not written");
        const result = {
          ok: true,
          committed: true,
          sessionUsable: true,
          workspaceId: workspace.id,
          connectorName: binding.connectorName,
          generation: binding.generation,
          fingerprint: binding.fingerprint,
          mcpUrl: binding.mcpUrl,
          session: saved,
        };
        if (opts.json) say(JSON.stringify(result));
        else check(`已提交连接器并记录新会话（generation ${binding.generation}）`);
      } catch (error) {
        handleCliError(error, opts.json);
      }
    }
  );

connector
  .command("status")
  .description("Show observed and connector-bound endpoint generations")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const state = readLastEndpoint(workspace.id);
      const result = {
        ok: true,
        workspaceId: workspace.id,
        observed: state?.observed ?? null,
        connectorBound: state?.connectorBound ?? null,
        pendingRepair: state?.pendingRepair ?? null,
        repair: endpointRepairAction(state),
      };
      if (opts.json) say(JSON.stringify(result));
      else if (!state) say("尚未记录连接器状态。");
      else say(`连接器状态：${result.repair === "none" ? "已提交" : `待${result.repair}（generation ${state.pendingRepair?.generation}）`}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });
// ---------------------------------------------------------------- pair / unpair

program
  .command("pair")
  .description("Generate a fresh pairing code")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .option("--lock-token <token>", "workspace session lock token")
  .action(async (opts: { workspace?: string; json: boolean; lockToken?: string }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      requireSessionLock(workspace.id, opts.lockToken);
      const { runtime } = await ensureBridge(workspace.root);
      requireSessionLock(workspace.id, opts.lockToken);
      const info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
      if (info.pairingActive) {
        throw new Error(
          "C2C_PAIRING_ALREADY_ACTIVE: a pairing code is already active; wait for it to expire before requesting another"
        );
      }
      const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      if (opts.json) say(JSON.stringify({ ok: true, pairingCode: pairing.code, expiresAt: pairing.expiresAt }));
      else {
        say(`配对码：${pairing.code}`);
        say(`（${Math.round((pairing.expiresAt - Date.now()) / 60000)} 分钟内有效，仅可使用一次）`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("unpair")
  .description("Revoke ChatGPT's access to this workspace immediately")
  .option("-w, --workspace <path>")
  .option("--lock-token <token>", "workspace session lock token")
  .action(async (opts: { workspace?: string; lockToken?: string }) => {
    try {
      const root = resolveWorkspace(opts.workspace);
      const workspace = new Workspace(root);
      requireSessionLock(workspace.id, opts.lockToken);
      const runtime = await findLiveBridge(workspace.id);
      if (runtime) {
        requireSessionLock(workspace.id, opts.lockToken);
        await adminFetch(runtime, "POST", "/admin/revoke-all");
      } else {
        // bridge not running: revoke directly in the persisted store
        requireSessionLock(workspace.id, opts.lockToken);
        new AuthStore(workspace.id).revokeAll();
      }
      check("已断开 ChatGPT 对当前项目的访问（所有令牌已吊销）");
    } catch (error) {
      handleCliError(error, false);
    }
  });


// ---------------------------------------------------------------- logs / workspace / record

program
  .command("logs")
  .description("Show recent bridge logs")
  .option("-w, --workspace <path>")
  .option("-n, --lines <n>", "number of lines", "50")
  .option("--verbose", "include debug detail", false)
  .action((opts: { workspace?: string; lines: string; verbose: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const candidates = [
      path.join(getStateDir(), "logs", "bridge.log"),
      path.join(getStateDir(), "logs", `bridge-${workspace.id}.out.log`),
    ];
    let shown = false;
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      const filtered = opts.verbose ? lines : lines.filter((line) => !line.includes(" DEBUG "));
      say(filtered.slice(-parseInt(opts.lines, 10)).join("\n"));
      shown = true;
    }
    if (!shown) say("暂无日志。");
  });

program
  .command("workspace")
  .description("Show workspace identity and project info")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const project = workspace.detectProject();
    const data = { workspaceId: workspace.id, name: workspace.name, root: workspace.root, ...project };
    if (opts.json) say(JSON.stringify(data));
    else {
      say(`Workspace：${data.name}（${data.workspaceId}）`);
      say(`类型：${data.projectType}  语言：${data.languages.join(", ") || "-"}`);
      say(`路径：${data.root}`);
    }
  });

// ---------------------------------------------------------------- sandbox-allow (Codex writable_roots, macOS + Windows)

program
  .command("sandbox-allow")
  .description("Add the local settings directory to the Codex sandbox allowlist")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const result = trySandboxAllow();
    if (opts.json) {
      say(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      cross(`无法写入 Codex 沙箱白名单：${result.error}`);
      process.exitCode = 1;
      return;
    }
    if (result.alreadyAllowed) check("沙箱白名单已就绪，后续对话无需再提权");
    else check("已将本地设置目录加入 Codex 沙箱白名单（后续对话无需再提权）");
  });

// ---------------------------------------------------------------- update-check (once per local day)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function runGit(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 8000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
}

program
  .command("update-check")
  .description("Check GitHub for a newer version (real check at most once per local day)")
  .option("--force", "check even if already checked today", false)
  .option("--json", "machine-readable output", false)
  .action((opts: { force: boolean; json: boolean }) => {
    const file = path.join(getStateDir(), "update-check.json");
    const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local tz
    let last: { date?: string; updateAvailable?: boolean } = {};
    try {
      last = JSON.parse(fs.readFileSync(file, "utf8")) as typeof last;
    } catch {
      /* first run */
    }

    const emit = (data: {
      checked: boolean;
      updateAvailable: boolean;
      localCommit?: string;
      remoteCommit?: string;
      note?: string;
    }): void => {
      if (opts.json) say(JSON.stringify({ ok: true, version: VERSION, ...data }));
      else if (data.updateAvailable) say(`发现新版本（本地 ${data.localCommit?.slice(0, 7)} → 远端 ${data.remoteCommit?.slice(0, 7)}）。`);
      else say(data.note ?? "已是最新版本。");
    };

    if (!opts.force && last.date === today) {
      emit({ checked: false, updateAvailable: last.updateAvailable ?? false, note: "今天已检查过更新。" });
      return;
    }

    const local = runGit(["rev-parse", "HEAD"]);
    const remote = runGit(["ls-remote", "origin", "HEAD"]);
    if (!local.ok || !remote.ok || !remote.stdout) {
      // Offline or not a git checkout: skip quietly and retry tomorrow-ish (do not
      // record the date so a transient failure does not suppress the daily check).
      emit({ checked: false, updateAvailable: false, note: "无法检查更新（离线或非 git 安装），已跳过。" });
      return;
    }
    const remoteCommit = remote.stdout.split(/\s/)[0];
    const updateAvailable = remoteCommit !== local.stdout;
    fs.mkdirSync(getStateDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ date: today, updateAvailable, remoteCommit }), { mode: 0o600 });
    emit({ checked: true, updateAvailable, localCommit: local.stdout, remoteCommit });
  });

// ---------------------------------------------------------------- session (ChatGPT conversation memory)

interface SavedSession {
  url: string;
  title?: string;
  taskId?: string;
  iteration?: number;
  lastState?: string;
  /** Connector identity at the time the conversation was saved. */
  generation?: number;
  fingerprint?: string;
  connectorName?: string;
  mcpUrl?: string;
  savedAt: string;
}

function readSavedSession(file: string): SavedSession | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as SavedSession;
  } catch {
    return null;
  }
}

function sessionBindingStatus(
  saved: SavedSession | null,
  endpoint: LastEndpoint | null
): { usable: boolean; reason?: string } {
  if (!saved) return { usable: false, reason: "missing" };
  if (!Number.isInteger(saved.generation) || !saved.fingerprint) {
    return { usable: false, reason: "legacy_session_unbound" };
  }
  if (!endpoint?.connectorBound) return { usable: false, reason: "connector_unbound" };
  if (
    endpoint.connectorBound.generation !== saved.generation ||
    endpoint.connectorBound.fingerprint !== saved.fingerprint
  ) {
    return { usable: false, reason: "connector_generation_mismatch" };
  }
  return { usable: true };
}

function sessionFile(workspaceId: string): string {
  const dir = path.join(getStateDir(), "sessions");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${workspaceId}.json`);
}

const session = program
  .command("session")
  .description("Remember and reuse the ChatGPT conversation for this workspace");

const sessionLock = session.command("lock").description("Serialize C2C browser sessions for this workspace");

sessionLock
  .command("acquire")
  .description("Acquire the workspace C2C session lease")
  .option("-w, --workspace <path>")
  .option("--task <id>", "task identifier shown to other sessions")
  .option("--lease-ms <ms>", "lease duration", String(DEFAULT_SESSION_LOCK_LEASE_MS))
  .option("--wait-ms <ms>", "maximum wait for another session to release the lease", "0")
  .option("--poll-ms <ms>", "busy-lock polling interval", "100")
  .option("--json", "machine-readable output", false)
  .action(
    async (opts: {
      workspace?: string;
      task?: string;
      leaseMs: string;
      waitMs: string;
      pollMs: string;
      json: boolean;
    }) => {
      try {
        const workspace = new Workspace(resolveWorkspace(opts.workspace));
        const result = await acquireSessionLock(workspace.id, {
          taskId: opts.task,
          leaseMs: Number(opts.leaseMs),
          waitMs: Number(opts.waitMs),
          pollMs: Number(opts.pollMs),
          // The CLI process exits after acquire; keep the caller/agent PID as owner.
          pid: process.ppid,
        });
        if (!result.acquired) {
          const message = sessionLockBusyMessage(result);
          if (opts.json) say(JSON.stringify({ ok: false, acquired: false, error: "busy", message, lock: result.info }));
          else cross(message);
          process.exitCode = 2;
          return;
        }
        if (opts.json) {
          say(JSON.stringify({ ok: true, acquired: true, recovered: result.recovered, token: result.handle.token, lock: result.handle.info }));
        } else {
          check("C2Cセッション排他を取得しました");
          say(`ロックトークン：${result.handle.token}`);
        }
      } catch (error) {
        handleCliError(error, opts.json);
      }
    }
  );

sessionLock
  .command("status")
  .description("Show the workspace C2C session lease")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const lock = readSessionLock(workspace.id);
    if (opts.json) say(JSON.stringify({ ok: true, lock }));
    else if (!lock.held) say("C2Cセッション排他は未取得です。");
    else {
      const info = lock.info;
      if (info) say(`C2Cセッション排他：${lock.expired ? "期限切れ" : "取得中"}（task ${info.taskId ?? "unknown"}）`);
      else say("C2Cセッション排他：取得中（所有者情報を読み取れません）。");
    }
  });

sessionLock
  .command("refresh")
  .description("Refresh the workspace C2C session lease")
  .option("-w, --workspace <path>")
  .requiredOption("--token <token>")
  .option("--lease-ms <ms>", "lease duration", String(DEFAULT_SESSION_LOCK_LEASE_MS))
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; token: string; leaseMs: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const lock = refreshSessionLock(workspace.id, opts.token, Number(opts.leaseMs));
      if (opts.json) say(JSON.stringify({ ok: true, lock }));
      else check("C2Cセッション排他を更新しました");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

sessionLock
  .command("release")
  .description("Release the workspace C2C session lease")
  .option("-w, --workspace <path>")
  .requiredOption("--token <token>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; token: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      releaseSessionLock(workspace.id, opts.token);
      if (opts.json) say(JSON.stringify({ ok: true, released: true }));
      else check("C2Cセッション排他を解放しました");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

session
  .command("get", { isDefault: true })
  .description("Show the saved ChatGPT conversation for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const file = sessionFile(workspace.id);
    const saved = readSavedSession(file);
    const binding = sessionBindingStatus(saved, readLastEndpoint(workspace.id));
    if (opts.json) {
      say(JSON.stringify({ ok: true, usable: binding.usable, reason: binding.reason ?? null, session: saved }));
    } else if (!saved) {
      say("尚未记录 ChatGPT 会话。");
    } else {
      say(`会话：${saved.title ?? "(untitled)"}`);
      say(`地址：${saved.url}`);
      if (saved.taskId) say(`任务：${saved.taskId}（第 ${saved.iteration ?? 0} 轮，${saved.lastState ?? "?"}）`);
      if (!binding.usable) say(`状态：不可复用（${binding.reason}）。请在当前连接器上新建会话并重新保存。`);
    }
  });

session
  .command("set")
  .description("Save the ChatGPT conversation to reuse in later tasks")
  .option("-w, --workspace <path>")
  .requiredOption("--url <url>", "conversation URL as shown in the browser address bar")
  .option("--title <title>")
  .option("--task <id>")
  .option("--iteration <n>")
  .option("--state <state>", "last protocol state, e.g. EXECUTED")
.requiredOption("--generation <n>", "connector generation from `c2c connector commit`")
.requiredOption("--fingerprint <fingerprint>", "connector fingerprint from `c2c connector commit`")
  .option("--lock-token <token>", "workspace session lock token")
  .option("--json", "machine-readable output", false)
  .action(
    (opts: {
      workspace?: string;
      url: string;
      title?: string;
      task?: string;
      iteration?: string;
      state?: string;
      generation?: string;
      fingerprint?: string;
      lockToken?: string;
      json: boolean;
    }) => {
      try {
        const workspace = new Workspace(resolveWorkspace(opts.workspace));
        requireSessionLock(workspace.id, opts.lockToken);
        const endpoint = readLastEndpoint(workspace.id);
        if (!endpoint?.connectorBound) {
          throw new Error("C2C_SESSION_CONNECTOR_UNBOUND: run `c2c connector commit` before saving a session");
        }
        if (!opts.generation || !opts.fingerprint) {
          throw new Error("C2C_SESSION_BINDING_REQUIRED: --generation and --fingerprint are required");
        }
        const generation = Number(opts.generation);
        if (!Number.isSafeInteger(generation) || generation !== endpoint.connectorBound.generation) {
          throw new Error("C2C_SESSION_BINDING_MISMATCH: generation is not the current connector binding");
        }
        if (opts.fingerprint.trim() !== endpoint.connectorBound.fingerprint) {
          throw new Error("C2C_SESSION_BINDING_MISMATCH: fingerprint is not the current connector binding");
        }
        const file = sessionFile(workspace.id);
        const previous = readSavedSession(file);
        const saved: SavedSession = {
          url: opts.url,
          title: opts.title ?? previous?.title,
          taskId: opts.task ?? previous?.taskId,
          iteration: opts.iteration ? parseInt(opts.iteration, 10) : previous?.iteration,
          lastState: opts.state ?? previous?.lastState,
          generation,
          fingerprint: endpoint.connectorBound.fingerprint,
          connectorName: endpoint.connectorBound.connectorName,
          mcpUrl: endpoint.connectorBound.mcpUrl ?? undefined,
          savedAt: new Date().toISOString(),
        };
        writeSecureJson(file, saved);
        if (opts.json) say(JSON.stringify({ ok: true, usable: true, session: saved }));
        else check("已记录 ChatGPT 会话，后续任务将复用");
      } catch (error) {
        handleCliError(error, opts.json);
      }
    }
  );

session
  .command("clear")
  .description("Forget the saved conversation (a new chat will be created next time)")
  .option("-w, --workspace <path>")
  .option("--lock-token <token>", "workspace session lock token")
  .action((opts: { workspace?: string; lockToken?: string }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    requireSessionLock(workspace.id, opts.lockToken);
    fs.rmSync(sessionFile(workspace.id), { force: true });
    check("已清除会话记录，下次任务将新建 ChatGPT 会话");
  });

program
  .command("record", { hidden: true })
  .description("Record a Codex execution summary (used by the Skill)")
  .option("-w, --workspace <path>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>")
  .requiredOption("--lock-token <token>", "workspace session lock token")
  .option("--changed-files <filesOrCount>", "comma-separated files or a count", "0")
  .option("--tests <summary>", "e.g. '27 passed'")
  .option("--exit-status <status>", "ok | failed | blocked", "ok")
  .option("--notes <text>")
  .action(
    (opts: {
      workspace?: string;
      task: string;
      iteration: string;
      lockToken: string;
      changedFiles: string;
      tests?: string;
      exitStatus: string;
      notes?: string;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      requireSessionLock(workspace.id, opts.lockToken);
      const changed = /^\d+$/.test(opts.changedFiles)
        ? parseInt(opts.changedFiles, 10)
        : opts.changedFiles.split(",").map((file) => file.trim()).filter(Boolean);
      appendExecutionRecord(workspace.id, {
        taskId: opts.task,
        iteration: parseInt(opts.iteration, 10),
        changedFiles: changed,
        tests: opts.tests ?? null,
        exitStatus: opts.exitStatus,
        timestamp: new Date().toISOString(),
        notes: opts.notes,
      });
      check("已记录执行摘要");
    }
  );

const tunnelCmd = program.command("tunnel").description("Choose or inspect the public connection for this workspace");

tunnelCmd
  .command("status", { isDefault: true })
  .description("Show whether this workspace still needs a one-time connection choice")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "optional domain, used to preview the stable hostname")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; zone?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const payload = tunnelChoicePayload(workspace, opts.zone);
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (payload.needsChoice) say(TUNNEL_CHOICE_PROMPT);
      else if (payload.namedReady) check(`固定域名：${payload.hostname}`);
      else say("当前使用临时地址。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("choose")
  .description("Remember quick vs named, and provision a named hostname when asked")
  .requiredOption("--mode <mode>", "quick or named")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "Cloudflare domain for a named hostname")
  .option("--hostname <hostname>", "override the default c2c-<project>.<zone>")
  .option("--json", "machine-readable output", false)
  .option("--lock-token <token>", "workspace session lock token")
  .action(
    async (opts: {
      mode: string;
      workspace?: string;
      zone?: string;
      hostname?: string;
      json: boolean;
      lockToken?: string;
    }) => {
      const root = resolveWorkspace(opts.workspace);
      try {
        const workspace = new Workspace(root);
        requireSessionLock(workspace.id, opts.lockToken);
        const mode = opts.mode.trim().toLowerCase();
        const previous = readTunnelState(workspace.id);
        if (mode === "quick") {
          requireSessionLock(workspace.id, opts.lockToken);
          const state = chooseQuickTunnel(workspace.id);
          if (await findLiveBridge(workspace.id)) {
            if (previous.preference === "named") {
              requireSessionLock(workspace.id, opts.lockToken);
              await stopBridge(root);
            }
          }
          const payload = { ...tunnelChoicePayload(workspace), state };
          if (opts.json) say(JSON.stringify(payload));
          else check("已选用临时地址");
          return;
        }
        if (mode !== "named") {
          throw new Error("mode must be quick or named");
        }
        const zone = parseZoneInput(opts.zone ?? "");
        if (!zone) {
          const payload = {
            ok: false,
            need: "zone",
            userMessage: "请告诉我已经加在 Cloudflare 上的域名，例如 example.com",
            loginPrompt: NAMED_LOGIN_PROMPT,
          };
          if (opts.json) {
            say(JSON.stringify(payload));
            return;
          }
          say(payload.userMessage);
          return;
        }
        requireSessionLock(workspace.id, opts.lockToken);
        if (!opts.json) say(NAMED_LOGIN_PROMPT);
        const result = await provisionNamedTunnel({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          zone,
          hostname: opts.hostname,
          beforeStateWrite: () => requireSessionLock(workspace.id, opts.lockToken),
        });
        requireSessionLock(workspace.id, opts.lockToken);
        if (await findLiveBridge(workspace.id)) {
          requireSessionLock(workspace.id, opts.lockToken);
          await stopBridge(root);
        }
        const payload = {
          ...tunnelChoicePayload(workspace),
          ok: true,
          fallback: result.fallback,
          userMessage: result.userMessage,
          error: result.error,
          state: result.state,
        };
        if (opts.json) {
          say(JSON.stringify(payload));
          return;
        }
        if (result.fallback) say(result.userMessage ?? "");
        else check(`固定域名已就绪：${result.state.hostname}`);
      } catch (error) {
        handleCliError(error, opts.json);
      }
    }
  );

tunnelCmd
  .command("login")
  .description("Open the Cloudflare login window used by a named hostname")
  .option("-w, --workspace <path>")
  .option("--lock-token <token>", "workspace session lock token")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; lockToken?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      requireSessionLock(workspace.id, opts.lockToken);
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const account = new ProcessCloudflaredAccount();
      await account.login();
      requireSessionLock(workspace.id, opts.lockToken);
      const payload = { ok: true, loggedIn: hasCloudflaredCert() };
      if (opts.json) say(JSON.stringify(payload));
      else check("Cloudflare 已登录");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

function handleCliError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    say(JSON.stringify({ ok: false, error: message }));
  } else if (message.startsWith("NEED_CLOUDFLARED")) {
    say("需要你完成一步：");
    say("");
    say("尚未安装安全连接组件 cloudflared。");
    say("macOS 用户可运行：brew install cloudflared");
    say("完成后再试一次即可。");
  } else {
    cross(message);
  }
  process.exitCode = 1;
}

program.parseAsync(process.argv).catch((error: Error) => {
  cross(error.message);
  process.exit(1);
});
