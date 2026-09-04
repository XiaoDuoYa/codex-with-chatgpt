import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { SERVICE_NAME } from "../version.js";
import { findBinary } from "./detect.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "./provider.js";

const QUICK_TUNNEL_URL_RE = /https:\/\/[^\s|]+/gi;
const QUICK_TUNNEL_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.trycloudflare\.com$/i;
const HEALTH_CHECK_INTERVAL_MS = 250;
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 5_000;
const DEFAULT_START_TIMEOUT_MS = 45_000;
const MAX_START_TIMEOUT_MS = 90_000;

export type TunnelFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function boundedTimeoutMs(
  configured: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (!configured?.trim()) return fallback;
  const timeout = Number(configured);
  if (!Number.isFinite(timeout) || timeout < min || timeout > max) return fallback;
  return Math.trunc(timeout);
}

export function quickTunnelStartTimeoutMs(
  configured = process.env.C2C_QUICK_TUNNEL_START_TIMEOUT_MS
): number {
  return boundedTimeoutMs(configured, DEFAULT_START_TIMEOUT_MS, 5_000, MAX_START_TIMEOUT_MS);
}

export function quickTunnelHealthCheckTimeoutMs(
  configured = process.env.C2C_TUNNEL_HEALTH_CHECK_TIMEOUT_MS
): number {
  return boundedTimeoutMs(configured, DEFAULT_HEALTH_CHECK_TIMEOUT_MS, 1_000, 30_000);
}

function isBridgeHealth(payload: unknown, expectedWorkspaceId?: string): boolean {
  if (!payload || typeof payload !== "object") return false;
  const health = payload as Record<string, unknown>;
  return (
    health.service === SERVICE_NAME &&
    health.status === "ok" &&
    (expectedWorkspaceId === undefined || health.workspaceId === expectedWorkspaceId)
  );
}

export async function bridgeHealth(
  fetchImpl: TunnelFetch,
  publicUrl: string,
  expectedWorkspaceId?: string
): Promise<{ ready: boolean; detail: string }> {
  const response = await fetchImpl(new URL("/health", publicUrl).toString(), {
    redirect: "error",
    signal: AbortSignal.timeout(quickTunnelHealthCheckTimeoutMs()),
  });
  if (!response) return { ready: false, detail: "Health check did not run" };
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { ready: false, detail: `Health check returned HTTP ${response.status}` };
  }
  return {
    ready: isBridgeHealth(await response.json().catch(() => null), expectedWorkspaceId),
    detail: `Health check did not identify ${SERVICE_NAME}`,
  };
}

/** Extract a Quick Tunnel public URL from a cloudflared log line. */
export function parseQuickTunnelUrl(line: string): string | null {
  for (const match of line.matchAll(QUICK_TUNNEL_URL_RE)) {
    try {
      const url = new URL(match[0]);
      if (url.protocol !== "https:" || !QUICK_TUNNEL_HOST_RE.test(url.hostname)) continue;
      if (url.hostname.toLowerCase() === "api.trycloudflare.com") continue;
      return url.origin;
    } catch {
      // Ignore malformed URLs embedded in log output.
    }
  }
  return null;
}

export interface CloudflaredQuickTunnelOptions {
  startTimeoutMs?: number;
  expectedWorkspaceId?: string;
  spawnImpl?: (
    command: string,
    args: string[],
    options: { stdio: ["ignore", "pipe", "pipe"]; windowsHide: true }
  ) => ChildProcess;
  fetchImpl?: TunnelFetch;
}

/**
 * Cloudflare Quick Tunnel provider.
 * Quick Tunnels need no account/login; the URL changes on every start,
 * which the bridge and the Skill handle by reconfiguring automatically.
 */
export class CloudflaredQuickTunnel implements TunnelProvider {
  readonly name = "cloudflare-quick";
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private lastError: string | null = null;
  private readonly startTimeoutMs: number;
  private readonly spawnImpl: NonNullable<CloudflaredQuickTunnelOptions["spawnImpl"]>;
  private readonly fetchImpl: NonNullable<CloudflaredQuickTunnelOptions["fetchImpl"]>;
  private readonly expectedWorkspaceId?: string;
  private starting: Promise<string> | null = null;
  private cancelStart: (() => void) | null = null;

  constructor(
    private readonly logger: Logger = nullLogger,
    private readonly binaryOverride?: string,
    options: CloudflaredQuickTunnelOptions = {}
  ) {
    this.startTimeoutMs = options.startTimeoutMs ?? quickTunnelStartTimeoutMs();
    this.spawnImpl = options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.expectedWorkspaceId = options.expectedWorkspaceId;
  }

  private binary(): string | null {
    return this.binaryOverride ?? findBinary("cloudflared");
  }

  async start(localPort: number): Promise<string> {
    if (this.child && this.url) return this.url;
    if (this.starting) return this.starting;
    const starting = this.startProcess(localPort);
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  private startProcess(localPort: number): Promise<string> {
    const bin = this.binary();
    if (!bin) {
      return Promise.reject(
        new Error(
          "cloudflared is not installed. Install it (e.g. `brew install cloudflared`) and retry."
        )
      );
    }

    return new Promise<string>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawnImpl(
          bin,
          ["tunnel", "--url", `http://127.0.0.1:${localPort}`, "--no-autoupdate"],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
        );
      } catch (error) {
        reject(error);
        return;
      }
      this.child = child;
      this.url = null;
      this.lastError = null;
      let settled = false;
      let candidateUrl: string | null = null;
      let cancel: (() => void) | null = null;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const closeReaders = (): void => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      };

      const isAlive = (): boolean => this.child === child;

      const stopChild = (): void => {
        try {
          child.kill("SIGTERM");
        } catch {
          // The process may have exited between the state check and kill().
        }
      };

      const finish = (callback: () => void, closeOutput = true): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (closeOutput) closeReaders();
        if (cancel && this.cancelStart === cancel) this.cancelStart = null;
        callback();
      };

      const fail = (error: unknown): void => {
        finish(() => {
          stopChild();
          if (this.child === child) {
            this.child = null;
            this.url = null;
          }
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      };

      cancel = () => fail(new Error("Tunnel start stopped"));
      this.cancelStart = cancel;

      const ready = (url: string): void => {
        if (!isAlive()) {
          fail(new Error("cloudflared exited before the public health endpoint became ready"));
          return;
        }
        finish(
          () => {
            this.url = url;
            this.lastError = null;
            this.logger.info(`Quick tunnel established: ${url}`);
            resolve(url);
          },
          false
        );
      };

      const waitForHealth = async (): Promise<void> => {
        const publicUrl = candidateUrl;
        if (!publicUrl) return;
        while (!settled) {
          if (!isAlive()) {
            fail(new Error("cloudflared exited before the public health endpoint became ready"));
            return;
          }

          try {
            const result = await bridgeHealth(this.fetchImpl, publicUrl, this.expectedWorkspaceId);
            if (settled) return;
            if (result.ready) {
              ready(publicUrl);
              return;
            }
            this.lastError = result.detail;
          } catch (error) {
            if (settled) return;
            this.lastError = error instanceof Error ? error.message : String(error);
          }
          if (settled) return;
          await new Promise((resolveWait) => setTimeout(resolveWait, HEALTH_CHECK_INTERVAL_MS));
        }
      };

      timeout = setTimeout(() => {
        if (!settled) {
          this.logger.error(`Quick tunnel did not become ready within ${this.startTimeoutMs}ms`);
          fail(new Error("Tunnel start timed out"));
        }
      }, this.startTimeoutMs);

      const scan = (stream: NodeJS.ReadableStream): void => {
        const rl = readline.createInterface({ input: stream });
        rl.on("line", (line) => {
          const url = parseQuickTunnelUrl(line);
          if (url && !candidateUrl) {
            candidateUrl = url;
            void waitForHealth().catch((error) => {
              this.logger.error(`Quick tunnel health check failed: ${String(error)}`);
            });
          }
          if (/\b(?:ERR|error|failed|fatal)\b/i.test(line)) {
            this.lastError = line.slice(0, 400);
            this.logger.debug(`cloudflared: ${line.slice(0, 400)}`);
          }
        });
      };
      if (child.stdout) scan(child.stdout);
      if (child.stderr) scan(child.stderr);

      child.on("error", (error) => {
        closeReaders();
        if (this.child === child) {
          this.child = null;
          this.url = null;
        }
        if (!settled) fail(error);
      });
      child.on("exit", (code) => {
        closeReaders();
        if (this.child === child) {
          this.child = null;
          this.url = null;
          this.lastError = `cloudflared exited (code ${code})`;
        }
        this.logger.warn(`cloudflared exited with code ${code}`);
        if (!settled) {
          fail(
            new Error(
              `cloudflared exited (code ${code}) before establishing a tunnel${this.lastError ? `: ${this.lastError}` : ""}`
            )
          );
        }
      });
    });
  }

  async stop(): Promise<void> {
    const pending = this.starting;
    this.starting = null;
    this.cancelStart?.();
    this.cancelStart = null;
    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // The process may have exited between the state check and kill().
      }
      this.child = null;
    }
    this.url = null;
    this.lastError = null;
    await pending?.catch(() => undefined);
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    return {
      running: this.child !== null && this.url !== null,
      url: this.url,
      provider: this.name,
      detail: this.lastError ?? undefined,
    };
  }

  getPublicUrl(): string | null {
    return this.url;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    const bin = this.binary();
    const problems: string[] = [];
    if (!bin) problems.push("cloudflared binary not found");
    if (bin && !this.child) problems.push("tunnel process not running");
    if (this.child && !this.url) problems.push("tunnel running but no public URL yet");
    return {
      provider: this.name,
      binaryFound: bin !== null,
      binaryPath: bin,
      running: this.child !== null,
      url: this.url,
      problems,
    };
  }
}
