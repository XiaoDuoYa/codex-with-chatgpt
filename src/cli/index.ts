import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge } from "../bridge/server.js";
import { findBridgeObservation, findLiveBridge, type RuntimeState } from "../bridge/runtime.js";
import { adminFetch, ensureBridge, stopBridge } from "../process/daemon.js";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { detectTunnelBinaries } from "../tunnel/detect.js";
import { bridgeHealth } from "../tunnel/cloudflared.js";
import { namedTunnelStartRequestTimeoutMs } from "../tunnel/cloudflared-named.js";
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
import { getStateDir } from "../config/paths.js";
import {
  autostartStatus,
  buildAutostartConfig,
  disableAutostart,
  enableAutostart,
} from "../config/autostart.js";
import { ensureSandboxAllowlist, getCodexConfigPath, isStateDirAllowlisted } from "../config/sandbox-allow.js";
import { mergeUiPrefs, readUiPrefs, SETUP_MODES, type SetupMode } from "../config/ui-prefs.js";
import {
  CHATGPT_CREATE_CONNECTOR_URL,
  CHATGPT_DEVELOPER_MODE_URL,
  CHATGPT_PLUGINS_URL,
  connectorAction,
  connectorNameFor,
  mcpUrlFromPublic,
  normalizePublicUrl,
  readLastEndpoint,
  reclaimUserMessage,
  writeLastEndpoint,
  type LastEndpoint,
} from "../config/endpoint.js";
import { PRODUCT_NAME, VERSION } from "../version.js";
import {
  clearChatPointer,
  currentLocalSessionId,
  currentLocalSessionIdentity,
  readSession,
  resolveConversation,
  resolveConversationRoute,
  updateSession,
  PROTOCOL_STATES,
  WAITING_FOR,
  type ConversationMode,
  type ProtocolState,
  type WaitingFor,
} from "../session/state.js";
import {
  appendExecutionRecord,
  parseExecutionExitStatus,
  validateExecutionRecordInput,
} from "../execution/records.js";
import { saveExecutionOutput } from "../execution/output.js";
import {
  acknowledgeControlResult,
  cancelControlResultRequest,
  getControlResultStatus,
  openControlResultRequest,
  waitForControlResult,
} from "../control/mailbox.js";
import {
  CONTROL_PHASES,
  ControlMailboxError,
  MAX_C2C_ITERATION,
  validateControlId,
  type ControlPhase,
  type ControlResultCorrelation,
} from "../control/result-schema.js";
import { checkGitUpdate } from "../update/check.js";

const program = new Command();

const say = (msg: string): void => {
  process.stdout.write(msg + "\n");
};
const check = (msg: string): void => say(`✓ ${msg}`);
const cross = (msg: string): void => say(`✗ ${msg}`);

function resolveWorkspace(option?: string): string {
  return path.resolve(option ?? process.cwd());
}

/** Local harness output only. Never pasted into ChatGPT. */
const MAX_RECORD_OUTPUT_READ = 256 * 1024;

function readCappedUtf8(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function parseControlPhase(value: string): ControlPhase {
  const phase = value.trim().toUpperCase();
  if (!CONTROL_PHASES.includes(phase as ControlPhase)) {
    throw new Error(`phase must be one of ${CONTROL_PHASES.join(", ")}`);
  }
  return phase as ControlPhase;
}

function parseIntegerOption(value: string, label: string, min: number, max: number): number {
  const normalized = value.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseControlIteration(value: string): number {
  return parseIntegerOption(value, "iteration", 0, MAX_C2C_ITERATION);
}

function parseControlCorrelation(opts: {
  task: string;
  iteration: string;
  phase: string;
}): ControlResultCorrelation {
  return {
    taskId: opts.task,
    iteration: parseControlIteration(opts.iteration),
    phase: parseControlPhase(opts.phase),
  };
}

function resolveLocalSession(option?: string): string {
  return currentLocalSessionId(option);
}

function persistWorkspaceEndpoint(opts: {
  workspaceId: string;
  workspaceName: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string;
  previous?: LastEndpoint | null;
}): string {
  const previous = opts.previous ?? readLastEndpoint(opts.workspaceId);
  const connectorName = connectorNameFor({
    workspaceName: opts.workspaceName,
    workspaceId: opts.workspaceId,
    previousName: previous?.connectorName,
    hadEndpointBefore: Boolean(previous),
  });
  writeLastEndpoint({
    workspaceId: opts.workspaceId,
    port: opts.port,
    publicUrl: opts.publicUrl,
    mcpUrl: opts.mcpUrl,
    connectorName,
  });
  return connectorName;
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
}

interface AdminInfo {
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  port: number;
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null; provider: string };
  tokenCount: number;
  authorization?: {
    activeTokenCount: number;
    activeClientCount: number;
    connectorClientCount: number;
    connectorActiveTokenCount: number;
    grantedScopes: string[];
    resultWriteAuthorized: boolean;
  };
  pairingActive: boolean;
  pid: number;
  startedAt: string;
}

async function requestTunnelUrl(runtime: RuntimeState, opts: { restart?: boolean } = {}): Promise<string> {
  const result = await adminFetch<TunnelStartResponse>(
    runtime,
    "POST",
    opts.restart ? "/admin/tunnel/restart" : "/admin/tunnel/start",
    namedTunnelStartRequestTimeoutMs()
  );
  if (!result.url) throw new Error(result.message ?? "Tunnel start failed");
  return result.url;
}

async function publicHealthOk(publicUrl: string, workspaceId: string): Promise<boolean> {
  try {
    return (await bridgeHealth(fetch, publicUrl, workspaceId)).ready;
  } catch {
    return false;
  }
}

async function ensureBridgeAndTunnel(
  workspaceRoot: string,
  opts: { tunnel: boolean }
): Promise<{ runtime: RuntimeState; info: AdminInfo; mcpUrl: string | null }> {
  const { runtime } = await ensureBridge(workspaceRoot);
  let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
  let mcpUrl: string | null = info.publicUrl ? `${info.publicUrl}/mcp` : null;
  if (opts.tunnel && !info.publicUrl) {
    const binaries = detectTunnelBinaries();
    if (!binaries.cloudflared) {
      throw new Error(
        "NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared)."
      );
    }
    const url = await requestTunnelUrl(runtime);
    info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    mcpUrl = `${url}/mcp`;
  }
  return { runtime, info, mcpUrl };
}

async function runAutostartOnce(workspaceRoot: string): Promise<Record<string, unknown>> {
  const sandbox = trySandboxAllow();
  const { runtime, info: ensuredInfo, mcpUrl: ensuredMcpUrl } = await ensureBridgeAndTunnel(workspaceRoot, {
    tunnel: true,
  });
  let info = ensuredInfo;
  let mcpUrl = ensuredMcpUrl;
  let publicHealthy: boolean | null = null;
  let tunnelRestarted = false;

  if (info.publicUrl) {
    publicHealthy = await publicHealthOk(info.publicUrl, info.workspaceId);
    if (!publicHealthy) {
      const url = await requestTunnelUrl(runtime, { restart: true });
      tunnelRestarted = true;
      info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
      mcpUrl = `${url}/mcp`;
      publicHealthy = await publicHealthOk(url, info.workspaceId);
      if (!publicHealthy) {
        throw new Error(`Public health check failed: ${url}/health`);
      }
    }
  }

  const connectorName = mcpUrl
    ? persistWorkspaceEndpoint({
        workspaceId: info.workspaceId,
        workspaceName: info.workspaceName,
        port: runtime.port,
        publicUrl: info.publicUrl,
        mcpUrl,
      })
    : readLastEndpoint(info.workspaceId)?.connectorName;

  return {
    ok: true,
    workspaceId: info.workspaceId,
    workspaceName: info.workspaceName,
    workspaceRoot: info.workspaceRoot,
    port: runtime.port,
    publicUrl: info.publicUrl,
    mcpUrl,
    connectorName,
    tunnel: info.tunnel,
    publicHealthy,
    tunnelRestarted,
    sandbox,
  };
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
      port: opts.port ? parseIntegerOption(opts.port, "port", 0, 65_535) : undefined,
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
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : readLastEndpoint(info.workspaceId)?.connectorName;
      if (opts.json) {
        say(JSON.stringify({ ok: true, port: runtime.port, workspaceId: info.workspaceId, mcpUrl, connectorName }));
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
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      if (!opts.json) {
        say(PRODUCT_NAME);
        say("");
        say("正在连接 ChatGPT…");
        say("");
      }
      const sandbox = trySandboxAllow();
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : connectorNameFor({
            workspaceName: info.workspaceName,
            workspaceId: info.workspaceId,
            previousName: readLastEndpoint(info.workspaceId)?.connectorName,
            hadEndpointBefore: Boolean(readLastEndpoint(info.workspaceId)),
          });
      const pairingResult = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      const tunnelState = readTunnelState(info.workspaceId);
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
  .action(async (opts: { workspace?: string }) => {
    const stopped = await stopBridge(resolveWorkspace(opts.workspace));
    if (stopped) check("Bridge 已停止");
    else say("没有正在运行的 Bridge。");
  });

program
  .command("restart")
  .description("Restart the bridge for this workspace")
  .option("-w, --workspace <path>")
  .option("--tunnel", "re-establish the secure public connection", false)
  .action(async (opts: { workspace?: string; tunnel: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    await stopBridge(root);
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const { info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      check(`Bridge 已重启（${info.workspaceName}）`);
      if (mcpUrl) check(`安全连接已建立`);
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
    const observation = await findBridgeObservation(workspace.id);
    if (observation.state === "unknown") {
      if (opts.json) {
        say(JSON.stringify({ ok: false, running: null, state: "unknown", reason: observation.reason }));
      } else {
        cross(`Bridge 状态无法确认（${observation.reason}），未将其视为未运行。`);
      }
      return;
    }
    if (observation.state === "stopped") {
      if (opts.json) say(JSON.stringify({ ok: false, running: false }));
      else say("Bridge 未运行。使用 `c2c start` 启动。");
      return;
    }
    const runtime = observation.runtime;
    const info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    if (opts.json) {
      say(JSON.stringify({ ok: true, running: true, ...info }));
      return;
    }
    say(PRODUCT_NAME);
    say("");
    check(`Workspace：${info.workspaceName}`);
    check(`Bridge：运行中（端口 ${info.port}）`);
    if (info.tunnel.running && info.tunnel.url) check(`安全连接：${info.tunnel.url}/mcp`);
    else say("· 安全连接：未启用（本地模式）");
    say(`· 已授权连接：${info.authorization?.resultWriteAuthorized === true ? "是" : "否"}`);
  });

// ---------------------------------------------------------------- doctor

program
  .command("doctor")
  .description("Diagnose and auto-repair the connection")
  .option("-w, --workspace <path>")
  .option("--no-fix", "diagnose only, do not repair")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; fix: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
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
    let bridgeUnknown = false;
    if (workspace) {
      const observation = await findBridgeObservation(workspace.id);
      if (observation.state === "healthy") {
        runtime = observation.runtime;
      } else if (observation.state === "unknown") {
        bridgeUnknown = true;
        report.bridge = { ok: false, detail: `状态无法确认（${observation.reason}），未自动修复` };
      } else if (opts.fix) {
        try {
          runtime = (await ensureBridge(root)).runtime;
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
    const lastEndpoint = workspace ? readLastEndpoint(workspace.id) : null;
    const connectorName = workspace
      ? connectorNameFor({
          workspaceName: workspace.name,
          workspaceId: workspace.id,
          previousName: lastEndpoint?.connectorName,
          hadEndpointBefore: Boolean(lastEndpoint),
        })
      : "Codex with ChatGPT";
    const tunnelState = workspace ? readTunnelState(workspace.id) : null;
    const namedReady = tunnelState ? isNamedTunnelReady(tunnelState) : false;
    let namedRepair: { needed: boolean; userMessage?: string } = { needed: false };
    let chatgptRepair: {
      needed: boolean;
      reason?: string;
      connectorAction: "none" | "create" | "update";
      connectorName: string;
      userMessage?: string;
      mcpUrl: string | null;
      previousMcpUrl: string | null;
      pairingCode?: string;
      pairingExpiresAt?: number;
      pages: {
        developerMode: string;
        plugins: string;
        createConnector: string;
      };
    } = {
      needed: false,
      connectorAction: "none",
      connectorName,
      mcpUrl: lastEndpoint?.mcpUrl ?? null,
      previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
      pages: {
        developerMode: CHATGPT_DEVELOPER_MODE_URL,
        plugins: CHATGPT_PLUGINS_URL,
        createConnector: CHATGPT_CREATE_CONNECTOR_URL,
      },
    };

    if (runtime) {
      let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
      if (namedReady && opts.fix && info.tunnel.provider !== "cloudflare-named") {
        await stopBridge(root);
        await new Promise((resolve) => setTimeout(resolve, 400));
        try {
          runtime = (await ensureBridge(root)).runtime;
          info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
          results.push("已切换到固定域名连接");
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }
      const expectedPublic = Boolean(lastEndpoint?.publicUrl) || namedReady;
      let currentUrl = info.publicUrl ?? info.tunnel.url;
      let healthy = false;
      if (currentUrl) {
        healthy = await publicHealthOk(currentUrl, info.workspaceId);
      }

      if ((!currentUrl || !healthy) && opts.fix && (expectedPublic || info.tunnel.running)) {
        try {
          const binaries = detectTunnelBinaries();
          if (!binaries.cloudflared) {
            report.tunnel = { ok: false, detail: "NEED_CLOUDFLARED" };
          } else {
            const forceRestart = Boolean(currentUrl && !healthy);
            const startedUrl = await requestTunnelUrl(runtime, { restart: forceRestart });
            if (startedUrl) {
              const previousUrl = lastEndpoint?.publicUrl;
              currentUrl = startedUrl;
              info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
              healthy = await publicHealthOk(startedUrl, info.workspaceId);
              const sameAddress =
                previousUrl && normalizePublicUrl(previousUrl) === normalizePublicUrl(startedUrl);
              if (healthy) {
                results.push(sameAddress ? "已重新建立安全连接" : "已重新建立安全连接（地址已更换）");
              } else {
                report.tunnel = { ok: false, detail: "公网地址无法访问" };
              }
            }
          }
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }

      if (currentUrl && healthy) {
        report.tunnel = { ok: true, detail: currentUrl };
        const nextMcp = mcpUrlFromPublic(currentUrl);
        const action = connectorAction(lastEndpoint?.mcpUrl, nextMcp);
        const boundName = nextMcp
          ? persistWorkspaceEndpoint({
              workspaceId: info.workspaceId,
              workspaceName: info.workspaceName,
              port: runtime.port,
              publicUrl: currentUrl,
              mcpUrl: nextMcp,
              previous: lastEndpoint,
            })
          : connectorName;
        chatgptRepair = {
          ...chatgptRepair,
          needed: action === "update",
          reason: action === "update" ? "address_reclaimed" : undefined,
          connectorAction: action,
          connectorName: boundName,
          userMessage: action === "update" ? reclaimUserMessage(boundName) : undefined,
          mcpUrl: nextMcp,
          previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
        };
        if (action === "update") {
          try {
            const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
            chatgptRepair.pairingCode = pairing.code;
            chatgptRepair.pairingExpiresAt = pairing.expiresAt;
            results.push(`已生成新的配对码，需要更新「${boundName}」`);
          } catch (error) {
            report.oauth = { ok: false, detail: (error as Error).message };
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

      const missingResultWriteAuthorization = info.authorization?.resultWriteAuthorized !== true;
      if (missingResultWriteAuthorization) {
        const authorizationDetail =
          !info.authorization || info.authorization.connectorClientCount === 0
            ? "ChatGPT 连接尚未注册"
            : info.authorization.connectorActiveTokenCount === 0
              ? "ChatGPT 连接尚未完成授权"
              : "现有 ChatGPT 授权缺少结果回写权限";
        report.oauth = { ok: false, detail: authorizationDetail };
        if (!chatgptRepair.needed && currentUrl && healthy) {
          const nextMcp = mcpUrlFromPublic(currentUrl);
          const connectorExists = (info.authorization?.connectorClientCount ?? 0) > 0;
          chatgptRepair = {
            ...chatgptRepair,
            needed: true,
            reason: connectorExists ? "missing_result_write_scope" : "missing_authorization",
            connectorAction: connectorExists ? "update" : "create",
            userMessage: connectorExists
              ? `「${chatgptRepair.connectorName}」需要重新授权结果回写能力，请在 ChatGPT 删除并重新添加该连接。`
              : `请在 ChatGPT 添加「${chatgptRepair.connectorName}」并完成授权。`,
            mcpUrl: nextMcp,
            previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
          };
          try {
            const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
            chatgptRepair.pairingCode = pairing.code;
            chatgptRepair.pairingExpiresAt = pairing.expiresAt;
            results.push(
              connectorExists
                ? `已生成新的配对码，需要重新授权「${chatgptRepair.connectorName}」`
                : `已生成配对码，需要添加并授权「${chatgptRepair.connectorName}」`
            );
          } catch (error) {
            report.oauth = { ok: false, detail: (error as Error).message };
          }
        }
      }
    } else if (bridgeUnknown) {
      report.tunnel = report.tunnel ?? { ok: false, detail: "Bridge 状态无法确认，未执行连接器修复" };
    } else if (namedReady) {
      report.tunnel = { ok: false, detail: "NAMED_TUNNEL_DOWN" };
      namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
    } else if (lastEndpoint?.publicUrl) {
      report.tunnel = { ok: false, detail: "安全连接未运行" };
      chatgptRepair = {
        ...chatgptRepair,
        needed: true,
        reason: "address_reclaimed",
        connectorAction: "update",
        connectorName,
        userMessage: reclaimUserMessage(connectorName),
      };
    }

    if (opts.json) {
      say(JSON.stringify({ report, repairs: results, chatgptRepair, namedRepair }));
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
    if (!allOk || namedRepair.needed) process.exitCode = 1;
  });

// ---------------------------------------------------------------- pair / unpair

program
  .command("pair")
  .description("Generate a fresh pairing code")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    try {
      const { runtime } = await ensureBridge(resolveWorkspace(opts.workspace));
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
  .action(async (opts: { workspace?: string }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const runtime = await findLiveBridge(workspace.id);
    if (runtime) {
      await adminFetch(runtime, "POST", "/admin/revoke-all");
    } else {
      // bridge not running: revoke directly in the persisted store
      new AuthStore(workspace.id).revokeAll();
    }
    check("已断开 ChatGPT 对当前项目的访问（所有令牌已吊销）");
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
      say(filtered.slice(-parseIntegerOption(opts.lines, "lines", 1, 10_000)).join("\n"));
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

// ---------------------------------------------------------------- autostart (macOS LaunchAgent wakes C2C, C2C owns bridge/tunnel)

const autostartCmd = program
  .command("autostart")
  .description("Manage login autostart for a workspace bridge and secure connection");

autostartCmd
  .command("enable")
  .description("Enable macOS autostart for this workspace")
  .option("-w, --workspace <path>")
  .option("--interval <seconds>", "repair interval in seconds", "60")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; interval: string; json: boolean }) => {
    try {
      const config = buildAutostartConfig({
        workspaceRoot: resolveWorkspace(opts.workspace),
        intervalSeconds: Number(opts.interval),
      });
      const result = enableAutostart(config);
      const status = autostartStatus(config);
      const payload = {
        ok: true,
        enabled: true,
        loaded: status.loaded,
        label: config.label,
        plistPath: config.plistPath,
        intervalSeconds: config.intervalSeconds,
        workspaceId: config.workspaceId,
        workspaceName: config.workspaceName,
        workspaceRoot: config.workspaceRoot,
        c2cBinPath: config.c2cBinPath,
        programArguments: config.programArguments,
        commands: result.commands,
      };
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      check(`自启已启用（${config.workspaceName}）`);
      say(`· ${config.label}`);
      say(`· 每 ${config.intervalSeconds} 秒唤醒 C2C 检查一次`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

autostartCmd
  .command("disable")
  .description("Disable macOS autostart for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    try {
      const config = buildAutostartConfig({ workspaceRoot: resolveWorkspace(opts.workspace) });
      const result = disableAutostart(config);
      const payload = {
        ok: true,
        enabled: false,
        label: config.label,
        plistPath: config.plistPath,
        workspaceId: config.workspaceId,
        workspaceName: config.workspaceName,
        workspaceRoot: config.workspaceRoot,
        commands: result.commands,
      };
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      check(`自启已关闭（${config.workspaceName}）`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

autostartCmd
  .command("status", { isDefault: true })
  .description("Show macOS autostart status for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    try {
      const config = buildAutostartConfig({ workspaceRoot: resolveWorkspace(opts.workspace) });
      const status = autostartStatus(config);
      const payload = {
        ok: true,
        enabled: status.enabled,
        loaded: status.loaded,
        detail: status.detail,
        label: config.label,
        plistPath: config.plistPath,
        intervalSeconds: config.intervalSeconds,
        workspaceId: config.workspaceId,
        workspaceName: config.workspaceName,
        workspaceRoot: config.workspaceRoot,
        c2cBinPath: config.c2cBinPath,
        programArguments: config.programArguments,
      };
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      say(`自启：${status.enabled ? "已启用" : "未启用"}`);
      say(`LaunchAgent：${status.loaded === null ? "不支持" : status.loaded ? "已加载" : "未加载"}`);
      say(`Label：${config.label}`);
      if (status.detail) say(`Detail：${status.detail}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

autostartCmd
  .command("run", { hidden: true })
  .description("Wake C2C once for launchd (internal)")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .option("--quiet", "suppress successful output", false)
  .action(async (opts: { workspace?: string; json: boolean; quiet: boolean }) => {
    try {
      const payload = await runAutostartOnce(resolveWorkspace(opts.workspace));
      if (opts.quiet) return;
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      check(`C2C 已唤醒（${payload.workspaceName}）`);
    } catch (error) {
      if (opts.quiet) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
        return;
      }
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- update-check (once per local day)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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

    const update = checkGitUpdate(repoRoot);
    if (!update) {
      // Offline or not a git checkout: skip quietly and retry tomorrow-ish (do not
      // record the date so a transient failure does not suppress the daily check).
      emit({ checked: false, updateAvailable: false, note: "无法检查更新（离线或非 git 安装），已跳过。" });
      return;
    }
    fs.mkdirSync(getStateDir(), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ date: today, updateAvailable: update.updateAvailable, remoteCommit: update.remoteCommit }),
      { mode: 0o600 }
    );
    emit({ checked: true, ...update });
  });

// ---------------------------------------------------------------- session (ChatGPT conversation / Project memory)

const session = program
  .command("session")
  .description("Remember the ChatGPT Project and conversation for this workspace");

session
  .command("get", { isDefault: true })
  .description("Show the saved ChatGPT conversation / Project for this workspace")
  .option("-w, --workspace <path>")
  .option("--local-session <id>", "local Codex session id (automatically detected when omitted)")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; localSession?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const sessionIdentity = currentLocalSessionIdentity(opts.localSession);
    const localSessionId = sessionIdentity.id;
    const saved = readSession(workspace.id, localSessionId);
    const conversation = resolveConversation(saved);
    const route = resolveConversationRoute(conversation);
    if (opts.json) {
      say(JSON.stringify({ ok: true, sessionIdentity, session: saved, conversation, route, resultTransport: workspace.resultTransport }));
    }
    else if (!saved) {
      say("尚未记录 ChatGPT 会话。新仓库默认使用 Project 合集。");
    } else {
      say(`本地会话：${conversation.localSessionId}`);
      say(`模式：${conversation.mode === "project" ? "Project 合集" : "长对话"}`);
      if (conversation.projectUrl) say(`合集：${conversation.projectUrl}`);
      if (saved.title) say(`会话：${saved.title}`);
      if (saved.url) say(`对话：${saved.url}`);
      if (saved.connectorName) say(`连接器：${saved.connectorName}`);
      if (saved.taskId) say(`任务：${saved.taskId}（第 ${saved.iteration ?? 0} 轮，${saved.lastState ?? "?"}）`);
      if (saved.checkpoint) {
        say(
          `存档：${saved.checkpoint.protocolState} / 等待 ${saved.checkpoint.waitingFor}（第 ${saved.checkpoint.iteration} 轮）`
        );
      }
    }
  });

session
  .command("set")
  .description("Save the ChatGPT Project and/or conversation for this workspace")
  .option("-w, --workspace <path>")
  .option("--url <url>", "ChatGPT conversation URL from the address bar")
  .option("--title <title>")
  .option("--task <id>")
  .option("--iteration <n>")
  .option("--state <state>", "last protocol state, e.g. EXECUTED")
  .option("--mode <mode>", "long-chat or project")
  .option("--project-url <url>", "ChatGPT Project collection URL (…/g/g-p-…/project)")
  .option("--connector-name <name>", "exact connector title for this workspace")
  .option("--protocol-state <state>", "checkpoint protocol state, e.g. EXECUTED_SENT")
  .option("--waiting-for <who>", "none | GPT_RESEARCH | GPT_PLAN | GPT_REVIEW | USER")
  .option("--goal <text>", "original task goal for resume / HANDOFF")
  .option("--completed-subtasks <text>")
  .option("--known-issues <text>")
  .option("--next-step <text>")
  .option("--clear-checkpoint", "drop the active checkpoint (task DONE)", false)
  .option("--local-session <id>", "local Codex session id (automatically detected when omitted)")
  .option("--mailbox-request <id>", "active control mailbox request id for checkpoint resume")
  .option("--mailbox-phase <phase>", "RESEARCH, PLAN, or REVIEW")
  .option("--mailbox-result <id>", "received control mailbox result id")
  .option("--clear-mailbox", "drop mailbox metadata after a browser fallback", false)
  .action(
    (opts: {
      workspace?: string;
      url?: string;
      title?: string;
      task?: string;
      iteration?: string;
      state?: string;
      mode?: string;
      projectUrl?: string;
      connectorName?: string;
      protocolState?: string;
      waitingFor?: string;
      goal?: string;
      completedSubtasks?: string;
      knownIssues?: string;
      nextStep?: string;
      clearCheckpoint: boolean;
      localSession?: string;
      mailboxRequest?: string;
      mailboxPhase?: string;
      mailboxResult?: string;
      clearMailbox: boolean;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const localSessionId = resolveLocalSession(opts.localSession);
      const modeRaw = opts.mode?.trim().toLowerCase();
      if (modeRaw && modeRaw !== "long-chat" && modeRaw !== "project") {
        throw new Error("mode must be long-chat or project");
      }
      const protocolRaw = opts.protocolState?.trim().toUpperCase();
      if (protocolRaw && !PROTOCOL_STATES.includes(protocolRaw as ProtocolState)) {
        throw new Error(`protocol-state must be one of ${PROTOCOL_STATES.join(", ")}`);
      }
      const waitingRaw = opts.waitingFor?.trim();
      const waitingNorm = waitingRaw
        ? waitingRaw.toLowerCase() === "none"
          ? "none"
          : waitingRaw.toUpperCase()
        : undefined;
      if (waitingNorm && !WAITING_FOR.includes(waitingNorm as WaitingFor)) {
        throw new Error(`waiting-for must be one of ${WAITING_FOR.join(", ")}`);
      }
      if (opts.clearMailbox && (opts.mailboxRequest || opts.mailboxPhase || opts.mailboxResult)) {
        throw new Error("clear-mailbox cannot be combined with mailbox metadata");
      }
      if ((opts.clearMailbox || opts.mailboxRequest || opts.mailboxPhase || opts.mailboxResult) && !protocolRaw) {
        throw new Error("mailbox checkpoint options require --protocol-state");
      }
      const taskId = opts.task ? validateControlId(opts.task, "task id") : undefined;
      const iteration =
        opts.iteration !== undefined ? parseControlIteration(opts.iteration) : undefined;
      const mailboxRequestId = opts.mailboxRequest
        ? validateControlId(opts.mailboxRequest, "mailbox request id")
        : undefined;
      const mailboxResultId = opts.mailboxResult
        ? validateControlId(opts.mailboxResult, "mailbox result id")
        : undefined;
      const saved = updateSession(workspace.id, localSessionId, {
        localSessionId,
        url: opts.url,
        title: opts.title,
        taskId,
        iteration,
        lastState: opts.state,
        conversationMode: modeRaw as ConversationMode | undefined,
        projectUrl: opts.projectUrl,
        connectorName: opts.connectorName,
        clearCheckpoint: opts.clearCheckpoint,
        clearMailbox: opts.clearMailbox,
        checkpoint: protocolRaw
          ? {
              protocolState: protocolRaw as ProtocolState,
              waitingFor: (waitingNorm as WaitingFor | undefined) ?? undefined,
              originalGoal: opts.goal,
              completedSubtasks: opts.completedSubtasks,
              knownIssues: opts.knownIssues,
              nextExpectedStep: opts.nextStep,
              mailboxRequestId,
              mailboxPhase: opts.mailboxPhase ? parseControlPhase(opts.mailboxPhase) : undefined,
              mailboxResultId,
            }
          : undefined,
      });
      if (saved.projectUrl && saved.conversationMode === "project") {
        check("已记录 ChatGPT 合集，后续从合集页新开或复用对话");
      } else {
        check("已记录 ChatGPT 会话，后续任务将复用");
      }
    }
  );

session
  .command("clear")
  .description("Forget the current ChatGPT chat (Project binding is kept)")
  .option("-w, --workspace <path>")
  .option("--local-session <id>", "local Codex session id (automatically detected when omitted)")
  .action((opts: { workspace?: string; localSession?: string }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const result = clearChatPointer(workspace.id, resolveLocalSession(opts.localSession));
    if (!result.cleared) say("尚未记录 ChatGPT 会话。");
    else if (result.keptProject) check("已清除当前对话，合集绑定仍保留");
    else check("已清除会话记录，下次任务将新建 ChatGPT 会话");
  });

// ---------------------------------------------------------------- control result mailbox

const controlCmd = program
  .command("control")
  .description("Manage structured C2C control result handoff for this workspace");

controlCmd
  .command("open")
  .description("Open a one-shot request for ChatGPT to submit a structured control result")
  .option("-w, --workspace <path>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>")
  .requiredOption("--phase <phase>", "RESEARCH, PLAN, or REVIEW")
  .option("--local-session <id>", "local Codex session id (automatically detected when omitted)")
  .option("--ttl-ms <ms>", "request lifetime in milliseconds")
  .option("--json", "machine-readable output", false)
  .action(
    (opts: {
      workspace?: string;
      task: string;
      iteration: string;
      phase: string;
      localSession?: string;
      ttlMs?: string;
      json: boolean;
    }) => {
      try {
        const workspace = new Workspace(resolveWorkspace(opts.workspace));
        const correlation = parseControlCorrelation(opts);
        const request = openControlResultRequest(workspace.id, {
          localSessionId: resolveLocalSession(opts.localSession),
          ...correlation,
          ttlMs: opts.ttlMs
            ? parseIntegerOption(opts.ttlMs, "ttl-ms", 1_000, 86_400_000)
            : undefined,
        });
        const payload = { ok: true, request };
        if (opts.json) {
          say(JSON.stringify(payload));
          return;
        }
        check(`已打开 ${request.phase} 结果请求`);
        say(`RESULT_REQUEST_ID: ${request.requestId}`);
      } catch (error) {
        handleCliError(error, opts.json);
      }
    }
  );

controlCmd
  .command("status")
  .description("Show the status of a structured control result request")
  .option("-w, --workspace <path>")
  .requiredOption("--request <id>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>")
  .requiredOption("--phase <phase>", "RESEARCH, PLAN, or REVIEW")
  .option("--local-session <id>", "local Codex session id (automatically detected when omitted)")
  .option("--json", "machine-readable output", false)
  .action((opts: {
    workspace?: string;
    request: string;
    task: string;
    iteration: string;
    phase: string;
    localSession?: string;
    json: boolean;
  }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const status = getControlResultStatus(
        workspace.id,
        opts.request,
        resolveLocalSession(opts.localSession),
        parseControlCorrelation(opts)
      );
      const payload = { ok: status.status !== "not_found", ...status };
      if (opts.json) {
        say(JSON.stringify(payload));
        if (status.status === "not_found") process.exitCode = 1;
        return;
      }
      say(`状态：${status.status}`);
      if (status.progress) say(`进度：${status.progress.status}`);
      if (status.result) say(`结果：${status.result.kind} ${status.result.resultId}`);
      if (status.status === "not_found") process.exitCode = 1;
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

controlCmd
  .command("wait")
  .description("Wait locally for ChatGPT to submit a structured control result")
  .option("-w, --workspace <path>")
  .requiredOption("--request <id>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>")
  .requiredOption("--phase <phase>", "RESEARCH, PLAN, or REVIEW")
  .option("--local-session <id>", "local Codex session id (automatically detected when omitted)")
  .option("--timeout-ms <ms>", "wait timeout in milliseconds", "300000")
  .option("--json", "machine-readable output", false)
  .action(async (opts: {
    workspace?: string;
    request: string;
    task: string;
    iteration: string;
    phase: string;
    localSession?: string;
    timeoutMs: string;
    json: boolean;
  }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const timeoutMs = parseIntegerOption(opts.timeoutMs, "timeout-ms", 0, 86_400_000);
      const status = await waitForControlResult(
        workspace.id,
        opts.request,
        timeoutMs,
        resolveLocalSession(opts.localSession),
        parseControlCorrelation(opts)
      );
      const received = status.status === "received" || status.status === "acknowledged";
      const payload = { ok: received, ...status };
      if (opts.json) {
        say(JSON.stringify(payload));
        if (!received) process.exitCode = 1;
        return;
      }
      say(`状态：${status.status}`);
      if (status.progress) say(`进度：${status.progress.status}`);
      if (status.result) say(JSON.stringify(status.result, null, 2));
      if (!received) process.exitCode = 1;
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

controlCmd
  .command("ack")
  .description("Acknowledge a received structured control result")
  .option("-w, --workspace <path>")
  .requiredOption("--request <id>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>")
  .requiredOption("--phase <phase>", "RESEARCH, PLAN, or REVIEW")
  .option("--local-session <id>", "local Codex session id (automatically detected when omitted)")
  .option("--json", "machine-readable output", false)
  .action((opts: {
    workspace?: string;
    request: string;
    task: string;
    iteration: string;
    phase: string;
    localSession?: string;
    json: boolean;
  }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const status = acknowledgeControlResult(
        workspace.id,
        opts.request,
        resolveLocalSession(opts.localSession),
        parseControlCorrelation(opts)
      );
      const payload = { ok: true, ...status };
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      check("已确认 control result");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

controlCmd
  .command("cancel")
  .description("Cancel a pending structured control result request")
  .option("-w, --workspace <path>")
  .requiredOption("--request <id>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>")
  .requiredOption("--phase <phase>", "RESEARCH, PLAN, or REVIEW")
  .option("--local-session <id>", "local Codex session id (automatically detected when omitted)")
  .option("--json", "machine-readable output", false)
  .action((opts: {
    workspace?: string;
    request: string;
    task: string;
    iteration: string;
    phase: string;
    localSession?: string;
    json: boolean;
  }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const status = cancelControlResultRequest(
        workspace.id,
        opts.request,
        resolveLocalSession(opts.localSession),
        parseControlCorrelation(opts)
      );
      const payload = { ok: true, ...status };
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      check("已取消 control result request");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

const prefsCmd = program
  .command("prefs")
  .description("Remember ChatGPT developer mode and setup choice for this machine");

prefsCmd
  .command("get", { isDefault: true })
  .description("Show remembered ChatGPT setup choices (not per workspace)")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const prefs = readUiPrefs();
    if (opts.json) {
      say(JSON.stringify({ ok: true, ...prefs }));
      return;
    }
    say(prefs.developerModeEnabled ? "开发人员模式：已记住已开启" : "开发人员模式：尚未记住");
    if (prefs.setupMode === "auto") say("配置方式：AI 自动化配置（预览版）");
    else if (prefs.setupMode === "manual") say("配置方式：手动教学配置");
    else say("配置方式：尚未选择");
  });

prefsCmd
  .command("set")
  .description("Save a ChatGPT setup choice for this machine")
  .option("--developer-mode", "remember that ChatGPT developer mode is on", false)
  .option("--setup-mode <mode>", "auto (preview) or manual")
  .option("--json", "machine-readable output", false)
  .action((opts: { developerMode: boolean; setupMode?: string; json: boolean }) => {
    try {
      const modeRaw = opts.setupMode?.trim().toLowerCase();
      if (modeRaw && !SETUP_MODES.includes(modeRaw as SetupMode)) {
        throw new Error(`setup-mode must be one of ${SETUP_MODES.join(", ")}`);
      }
      if (!opts.developerMode && !modeRaw) {
        throw new Error("nothing to save: pass --developer-mode and/or --setup-mode");
      }
      const prefs = mergeUiPrefs({
        developerModeEnabled: opts.developerMode ? true : undefined,
        setupMode: modeRaw as SetupMode | undefined,
      });
      if (opts.json) {
        say(JSON.stringify({ ok: true, ...prefs }));
        return;
      }
      if (opts.developerMode) check("已记住开发人员模式已开启");
      if (modeRaw === "auto") check("已记住配置方式：AI 自动化配置（预览版）");
      if (modeRaw === "manual") check("已记住配置方式：手动教学配置");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("record", { hidden: true })
  .description("Record a Codex execution summary (used by the Skill)")
  .option("-w, --workspace <path>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>")
  .option("--changed-files <filesOrCount>", "comma-separated files or a count", "0")
  .option("--tests <summary>", "e.g. '27 passed'")
  .option("--exit-status <status>", "ok | failed | blocked", "ok")
  .option("--notes <text>")
  .option("--command <text>", "command whose output may be offered to ChatGPT")
  .option("--output <text>", "command output (prefer --output-file for long logs)")
  .option("--output-file <path>", "read command output from a local file")
  .option("--exit-code <n>", "numeric exit code of that command")
  .option("--local-session <id>", "local Codex session id (automatically detected when omitted)")
  .action(
    (opts: {
      workspace?: string;
      task: string;
      iteration: string;
      changedFiles: string;
      tests?: string;
      exitStatus: string;
      notes?: string;
      command?: string;
      output?: string;
      outputFile?: string;
      exitCode?: string;
      localSession?: string;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const localSessionId = resolveLocalSession(opts.localSession);
      const taskId = validateControlId(opts.task, "task id");
      const iteration = parseControlIteration(opts.iteration);
      const changed = /^(0|[1-9][0-9]*)$/.test(opts.changedFiles)
        ? parseIntegerOption(opts.changedFiles, "changed-files count", 0, 1_000_000)
        : opts.changedFiles.split(",").map((file) => file.trim()).filter(Boolean);
      const baseRecord = validateExecutionRecordInput(workspace.id, {
        localSessionId,
        taskId,
        iteration,
        changedFiles: changed,
        tests: opts.tests ?? null,
        exitStatus: parseExecutionExitStatus(opts.exitStatus),
        timestamp: new Date().toISOString(),
        notes: opts.notes,
        outputAvailable: false,
      });
      let outputId: number | undefined;
      let outputAvailable = false;
      const rawOutput =
        opts.outputFile !== undefined
          ? readCappedUtf8(path.resolve(opts.outputFile), MAX_RECORD_OUTPUT_READ)
          : opts.output;
      if ((opts.command === undefined) !== (rawOutput === undefined)) {
        throw new Error("command and output/output-file must be provided together");
      }
      if (opts.exitCode !== undefined && opts.command === undefined) {
        throw new Error("exit-code requires command and output/output-file");
      }
      if (opts.command && rawOutput !== undefined) {
        const savedOutput = saveExecutionOutput(workspace.id, {
          command: opts.command,
          raw: rawOutput,
          exitCode:
            opts.exitCode !== undefined
              ? parseIntegerOption(opts.exitCode, "exit-code", 0, 255)
              : null,
          localSessionId,
          taskId,
          iteration,
        });
        outputId = savedOutput.id;
        outputAvailable = savedOutput.allowed;
      }
      appendExecutionRecord(workspace.id, {
        ...baseRecord,
        outputId,
        outputAvailable,
      });
      if (outputId !== undefined && !outputAvailable) check("已记录执行摘要（输出未对 ChatGPT 开放）");
      else if (outputId !== undefined) check("已记录执行摘要与输出");
      else check("已记录执行摘要");
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
  .action(async (opts: { mode: string; workspace?: string; zone?: string; hostname?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const workspace = new Workspace(root);
      const mode = opts.mode.trim().toLowerCase();
      const previous = readTunnelState(workspace.id);
      if (mode === "quick") {
        const state = chooseQuickTunnel(workspace.id);
        if (await findLiveBridge(workspace.id)) {
          if (previous.preference === "named") await stopBridge(root);
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
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const result = await provisionNamedTunnel({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        zone,
        hostname: opts.hostname,
      });
      if (await findLiveBridge(workspace.id)) await stopBridge(root);
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
  });

tunnelCmd
  .command("login")
  .description("Open the Cloudflare login window used by a named hostname")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    try {
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const account = new ProcessCloudflaredAccount();
      await account.login();
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
    const code = error instanceof ControlMailboxError ? error.code : undefined;
    say(JSON.stringify({ ok: false, error: message, code }));
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
