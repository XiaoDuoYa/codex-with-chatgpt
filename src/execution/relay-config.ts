import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../config/paths.js";

export interface RelayConfig {
  enabled: boolean;
}

export function getExecutionRelayConfigPath(): string {
  return path.join(getStateDir(), "relay.json");
}

export function isExecutionRelayEnabled(): boolean {
  const configFile = getExecutionRelayConfigPath();
  try {
    if (!fs.existsSync(configFile)) {
      return false;
    }
    const raw = fs.readFileSync(configFile, "utf8");
    const data = JSON.parse(raw);
    return Boolean(data?.enabled);
  } catch {
    return false;
  }
}

export function setExecutionRelayEnabled(enabled: boolean): void {
  const configFile = getExecutionRelayConfigPath();
  const dir = path.dirname(configFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const data: RelayConfig = { enabled };
  fs.writeFileSync(configFile, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
}
