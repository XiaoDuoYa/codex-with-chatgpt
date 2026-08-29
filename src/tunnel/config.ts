import fs from "node:fs";
import path from "node:path";
import { getStateDir, writeSecureJson } from "../config/paths.js";
import { CloudflaredQuickTunnel } from "./cloudflared.js";
import { CloudflaredNamedTunnel, parseNamedTunnelConfig, type NamedTunnelConfig } from "./named.js";
import type { TunnelProvider } from "./provider.js";
import type { Logger } from "../logger/index.js";

/**
 * Tunnel selection is stored in <stateDir>/tunnel.json. Present + valid means
 * a user-owned fixed address (named tunnel); absent means the rotating Quick
 * Tunnel. The file is written by `c2c tunnel named` and read by every bridge
 * start, so the fixed domain survives updates and reboots.
 */
export function tunnelConfigFile(): string {
  return path.join(getStateDir(), "tunnel.json");
}

export type TunnelConfigResult =
  | { status: "absent" }
  | { status: "ok"; config: NamedTunnelConfig }
  | { status: "malformed" };

/**
 * A malformed tunnel.json is a configuration error, not a silent fallback:
 * the user asked for a fixed address and must learn when it cannot be used.
 */
export function readTunnelConfig(): TunnelConfigResult {
  let text: string;
  try {
    text = fs.readFileSync(tunnelConfigFile(), "utf8");
  } catch {
    return { status: "absent" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: "malformed" };
  }
  const config = parseNamedTunnelConfig(raw);
  return config ? { status: "ok", config } : { status: "malformed" };
}

export function readNamedTunnelConfig(): NamedTunnelConfig | null {
  const result = readTunnelConfig();
  return result.status === "ok" ? result.config : null;
}

export function writeTunnelConfig(config: NamedTunnelConfig): void {
  writeSecureJson(tunnelConfigFile(), config);
}

export function clearTunnelConfig(): void {
  try {
    fs.rmSync(tunnelConfigFile(), { force: true });
  } catch {
    // ignore
  }
}

/**
 * Placeholder used when the configured provider could not be constructed
 * (e.g. malformed tunnel.json). Starting it always fails with the original
 * configuration error, so no stale provider object can be resurrected.
 */
export class UnconfiguredTunnelProvider implements TunnelProvider {
  readonly name = "unconfigured";
  constructor(private readonly error: Error) {}
  async start(): Promise<string> {
    throw this.error;
  }
  async stop(): Promise<void> {}
  async restart(): Promise<string> {
    throw this.error;
  }
  status() {
    return { running: false as const, url: null, provider: this.name, detail: this.error.message };
  }
  getPublicUrl(): string | null {
    return null;
  }
  async doctor() {
    return {
      provider: this.name,
      binaryFound: false,
      binaryPath: null,
      running: false,
      url: null,
      problems: [this.error.message],
    };
  }
}

/** The provider every bridge host should use, based on the stored config. */
export function defaultTunnelProvider(logger: Logger): TunnelProvider {
  const result = readTunnelConfig();
  if (result.status === "ok") return new CloudflaredNamedTunnel(result.config, logger);
  if (result.status === "malformed") {
    throw new Error(
      `tunnel.json in the state directory is not a valid named-tunnel config; ` +
        `fix or remove it (${tunnelConfigFile()}), or run \`c2c tunnel named\` again.`
    );
  }
  return new CloudflaredQuickTunnel(logger);
}
