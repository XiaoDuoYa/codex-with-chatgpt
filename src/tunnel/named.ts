import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { findBinary } from "./detect.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "./provider.js";

/**
 * Named Cloudflare Tunnel provider: a user-owned hostname that never changes,
 * unlike Quick Tunnels whose URL rotates on every start.
 *
 * Enabled by placing tunnel.json in the state dir:
 *
 *   {
 *     "mode": "cloudflare-named",
 *     "publicUrl": "https://c2c.example.com",
 *     "tunnelName": "My-Laptop",
 *     "credentialsFile": "C:\\...\\tunnel\\my-laptop.json"
 *   }
 *
 * tunnelId may be given instead of tunnelName. The credentials file holds the
 * tunnel secret, so it must stay owner-only and inside the state dir.
 */
export interface NamedTunnelConfig {
  mode: "cloudflare-named";
  publicUrl: string;
  tunnelName?: string;
  tunnelId?: string;
  credentialsFile: string;
}

export function parseNamedTunnelConfig(value: unknown): NamedTunnelConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.mode !== "cloudflare-named") return null;
  if (typeof v.publicUrl !== "string" || v.publicUrl.trim() === "") return null;
  if (typeof v.credentialsFile !== "string" || v.credentialsFile.trim() === "") return null;
  const hasName = typeof v.tunnelName === "string" && v.tunnelName.trim() !== "";
  const hasId = typeof v.tunnelId === "string" && v.tunnelId.trim() !== "";
  if (!hasName && !hasId) return null;
  return {
    mode: "cloudflare-named",
    publicUrl: v.publicUrl.trim().replace(/\/+$/, ""),
    tunnelName: hasName ? (v.tunnelName as string).trim() : undefined,
    tunnelId: hasId ? (v.tunnelId as string).trim() : undefined,
    credentialsFile: (v.credentialsFile as string).trim(),
  };
}

export class CloudflaredNamedTunnel implements TunnelProvider {
  readonly name = "cloudflare-named";
  private child: ChildProcess | null = null;
  private registered = false;
  private lastError: string | null = null;

  constructor(
    private readonly config: NamedTunnelConfig,
    private readonly logger: Logger = nullLogger,
    private readonly binaryOverride?: string
  ) {}

  private binary(): string | null {
    return this.binaryOverride ?? findBinary("cloudflared");
  }

  private target(): string {
    return this.config.tunnelName ?? this.config.tunnelId ?? "";
  }

  async start(localPort: number): Promise<string> {
    if (this.child && this.registered) return this.config.publicUrl;
    const bin = this.binary();
    if (!bin) {
      throw new Error(
        "cloudflared is not installed. Install it (e.g. `brew install cloudflared`) and retry."
      );
    }
    if (!fs.existsSync(this.config.credentialsFile)) {
      throw new Error(
        `Tunnel credentials file not found: ${this.config.credentialsFile}`
      );
    }
    return new Promise<string>((resolve, reject) => {
      const child = spawn(
        bin,
        [
          "tunnel",
          "--no-autoupdate",
          "run",
          "--credentials-file", this.config.credentialsFile,
          "--url", `http://127.0.0.1:${localPort}`,
          this.target(),
        ],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
      );
      this.child = child;
      this.registered = false;
      this.lastError = null;

      const timeout = setTimeout(() => {
        if (!this.registered) {
          this.logger.error("Named tunnel did not register within 45s");
          child.kill("SIGTERM");
          reject(new Error("Named tunnel start timed out"));
        }
      }, 45_000);

      const scan = (stream: NodeJS.ReadableStream): void => {
        const rl = readline.createInterface({ input: stream });
        rl.on("line", (line) => {
          if (/Registered tunnel connection/i.test(line) && !this.registered) {
            this.registered = true;
            clearTimeout(timeout);
            this.logger.info(`Named tunnel registered: ${this.config.publicUrl}`);
            resolve(this.config.publicUrl);
          }
          if (/error|fail/i.test(line)) {
            this.lastError = line.slice(0, 400);
            this.logger.debug(`cloudflared: ${line.slice(0, 400)}`);
          }
        });
      };
      if (child.stdout) scan(child.stdout);
      if (child.stderr) scan(child.stderr);

      child.on("error", (error) => {
        clearTimeout(timeout);
        this.child = null;
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        const wasStarting = !this.registered;
        this.logger.warn(`cloudflared exited with code ${code}`);
        this.child = null;
        this.registered = false;
        if (wasStarting) {
          reject(new Error(`cloudflared exited (code ${code}) before registering${this.lastError ? `: ${this.lastError}` : ""}`));
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
    this.registered = false;
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    return {
      running: this.child !== null && this.registered,
      url: this.child !== null ? this.config.publicUrl : null,
      provider: this.name,
      detail: this.lastError ?? undefined,
    };
  }

  getPublicUrl(): string | null {
    return this.child !== null ? this.config.publicUrl : null;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    const bin = this.binary();
    const problems: string[] = [];
    if (!bin) problems.push("cloudflared binary not found");
    if (!fs.existsSync(this.config.credentialsFile)) {
      problems.push(`credentials file not found: ${this.config.credentialsFile}`);
    }
    if (bin && !this.child) problems.push("tunnel process not running");
    if (this.child && !this.registered) problems.push("tunnel running but not registered yet");
    return {
      provider: this.name,
      binaryFound: bin !== null,
      binaryPath: bin,
      running: this.child !== null,
      url: this.child !== null ? this.config.publicUrl : null,
      problems,
    };
  }
}
