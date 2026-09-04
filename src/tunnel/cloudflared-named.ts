import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { findBinary } from "./detect.js";
import { bridgeHealth, type TunnelFetch } from "./cloudflared.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "./provider.js";

const CONNECTED_RE = /registered tunnel connection/i;
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const DEFAULT_START_TIMEOUT_MS = 45_000;
const MIN_START_TIMEOUT_MS = 5_000;
const MAX_START_TIMEOUT_MS = 120_000;
const START_REQUEST_BUFFER_MS = 5_000;
const HEALTH_CHECK_INTERVAL_MS = 250;

export function namedTunnelStartTimeoutMs(
  configured = process.env.C2C_NAMED_TUNNEL_START_TIMEOUT_MS
): number {
  if (!configured?.trim()) return DEFAULT_START_TIMEOUT_MS;
  const timeout = Number(configured);
  if (
    !Number.isFinite(timeout) ||
    timeout < MIN_START_TIMEOUT_MS ||
    timeout > MAX_START_TIMEOUT_MS
  ) {
    return DEFAULT_START_TIMEOUT_MS;
  }
  return Math.trunc(timeout);
}

export function namedTunnelStartRequestTimeoutMs(
  configured = process.env.C2C_NAMED_TUNNEL_START_TIMEOUT_MS
): number {
  return namedTunnelStartTimeoutMs(configured) + START_REQUEST_BUFFER_MS;
}

export interface CloudflaredNamedTunnelOptions {
  tunnelName: string;
  hostname: string;
  logger?: Logger;
  binaryOverride?: string;
  startTimeoutMs?: number;
  expectedWorkspaceId?: string;
  spawnImpl?: (
    command: string,
    args: string[],
    options: { stdio: ["ignore", "pipe", "pipe"]; windowsHide: true }
  ) => ChildProcess;
  fetchImpl?: TunnelFetch;
}

export function normalizeNamedTunnelHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME_RE.test(normalized)) {
    throw new Error(`Invalid named tunnel hostname: ${hostname}`);
  }
  return normalized;
}

/**
 * Locally-managed Cloudflare named tunnel.
 *
 * The tunnel object and its DNS route are provisioned once with cloudflared.
 * This provider only starts and monitors the connector process, so the public
 * URL remains stable across bridge restarts.
 */
export class CloudflaredNamedTunnel implements TunnelProvider {
  readonly name = "cloudflare-named";
  private readonly tunnelName: string;
  private readonly hostname: string;
  private readonly logger: Logger;
  private readonly binaryOverride?: string;
  private readonly startTimeoutMs: number;
  private readonly spawnImpl: NonNullable<CloudflaredNamedTunnelOptions["spawnImpl"]>;
  private readonly fetchImpl: TunnelFetch;
  private readonly expectedWorkspaceId?: string;
  private child: ChildProcess | null = null;
  private connected = false;
  private lastError: string | null = null;
  private starting: Promise<string> | null = null;
  private cancelStart: (() => void) | null = null;

  constructor(opts: CloudflaredNamedTunnelOptions) {
    const tunnelName = opts.tunnelName.trim();
    if (!tunnelName || tunnelName.length > 128) {
      throw new Error("Named tunnel name must be between 1 and 128 characters");
    }
    this.tunnelName = tunnelName;
    this.hostname = normalizeNamedTunnelHostname(opts.hostname);
    this.logger = opts.logger ?? nullLogger;
    this.binaryOverride = opts.binaryOverride;
    this.startTimeoutMs = opts.startTimeoutMs ?? namedTunnelStartTimeoutMs();
    this.spawnImpl = opts.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.expectedWorkspaceId = opts.expectedWorkspaceId;
  }

  private binary(): string | null {
    return this.binaryOverride ?? findBinary("cloudflared");
  }

  private publicUrl(): string {
    return `https://${this.hostname}`;
  }

  async start(localPort: number): Promise<string> {
    if (this.child && this.connected) return this.publicUrl();
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
          [
            "tunnel",
            "--no-autoupdate",
            "--url",
            `http://127.0.0.1:${localPort}`,
            "run",
            this.tunnelName,
          ],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
        );
      } catch (error) {
        reject(error);
        return;
      }
      this.child = child;
      this.connected = false;
      this.lastError = null;
      let settled = false;
      let cancel: (() => void) | null = null;
      let healthChecking = false;

      const isAlive = (): boolean => this.child === child;

      const stopChild = (): void => {
        try {
          child.kill("SIGTERM");
        } catch {
          // The process may have exited between the state check and kill().
        }
      };

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (cancel && this.cancelStart === cancel) this.cancelStart = null;
        fn();
      };

      const fail = (error: unknown): void => {
        finish(() => {
          stopChild();
          if (isAlive()) {
            this.child = null;
            this.connected = false;
          }
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      };

      cancel = (): void => fail(new Error("Named tunnel start stopped"));
      this.cancelStart = cancel;

      const ready = (): void => {
        if (!isAlive()) {
          fail(new Error("cloudflared exited before the public health endpoint became ready"));
          return;
        }
        this.connected = true;
        this.lastError = null;
        const url = this.publicUrl();
        this.logger.info(`Named tunnel established: ${url}`);
        finish(() => resolve(url));
      };

      const waitForHealth = async (): Promise<void> => {
        while (!settled) {
          if (!isAlive()) {
            fail(new Error("cloudflared exited before the public health endpoint became ready"));
            return;
          }
          try {
            const result = await bridgeHealth(this.fetchImpl, this.publicUrl(), this.expectedWorkspaceId);
            if (settled) return;
            if (result.ready) {
              ready();
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

      const timeout = setTimeout(() => {
        if (!this.connected) {
          this.lastError = "Named tunnel start timed out";
          fail(new Error(this.lastError ?? "Named tunnel start timed out"));
        }
      }, this.startTimeoutMs);

      const scan = (stream: NodeJS.ReadableStream): void => {
        const rl = readline.createInterface({ input: stream });
        rl.on("line", (line) => {
          if (CONNECTED_RE.test(line) && !this.connected && !healthChecking && isAlive()) {
            healthChecking = true;
            void waitForHealth().catch((error) => {
              this.logger.error(`Named tunnel health check failed: ${String(error)}`);
            });
          }
          if (/\b(error|failed|fatal)\b/i.test(line)) {
            this.lastError = line.slice(0, 400);
            this.logger.debug(`cloudflared: ${line.slice(0, 400)}`);
          }
        });
      };
      if (child.stdout) scan(child.stdout);
      if (child.stderr) scan(child.stderr);

      child.on("error", (error) => {
        if (isAlive()) {
          this.child = null;
          this.connected = false;
        }
        if (!settled) fail(error);
      });
      child.on("exit", (code) => {
        const wasStarting = !this.connected;
        this.logger.warn(`cloudflared named tunnel exited with code ${code}`);
        if (isAlive()) {
          this.child = null;
          this.connected = false;
        }
        if (wasStarting) {
          finish(() => {
            reject(
              new Error(
                `cloudflared exited (code ${code}) before establishing the named tunnel${
                  this.lastError ? `: ${this.lastError}` : ""
                }`
              )
            );
          });
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
    this.connected = false;
    this.lastError = null;
    await pending?.catch(() => undefined);
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    return {
      running: this.child !== null && this.connected,
      url: this.connected ? this.publicUrl() : null,
      provider: this.name,
      detail: this.lastError ?? undefined,
    };
  }

  getPublicUrl(): string | null {
    return this.connected ? this.publicUrl() : null;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    const bin = this.binary();
    const problems: string[] = [];
    if (!bin) problems.push("cloudflared binary not found");
    if (bin && !this.child) problems.push("named tunnel process not running");
    if (this.child && !this.connected) problems.push("named tunnel is not connected yet");
    return {
      provider: this.name,
      binaryFound: bin !== null,
      binaryPath: bin,
      running: this.child !== null && this.connected,
      url: this.connected ? this.publicUrl() : null,
      problems,
    };
  }
}
