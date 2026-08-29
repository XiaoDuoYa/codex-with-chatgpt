import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export interface ClientRegistration {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: string;
}

interface PersistedClients {
  clients: ClientRegistration[];
}

/**
 * Host-level OAuth dynamic-client registry.
 *
 * A connector client (e.g. ChatGPT) registers once and may then pair with any
 * workspace on this machine, so clients live in one host-wide file instead of
 * per-workspace auth stores. Legacy per-workspace stores that still carry a
 * `clients` array are imported on first construction so existing connectors
 * keep working after the upgrade.
 */
export class ClientRegistry {
  private clients = new Map<string, ClientRegistration>();
  private readonly file: string;

  constructor(opts: { file?: string } = {}) {
    this.file =
      opts.file ?? path.join(ensureDir(path.join(getStateDir(), "auth")), "clients.json");
    this.load();
    this.importLegacyStores();
  }

  private load(): void {
    const data = readJsonIfExists<PersistedClients>(this.file);
    if (!data) return;
    for (const client of data.clients ?? []) this.clients.set(client.clientId, client);
  }

  /**
   * One-time merge of clients found in per-workspace auth store files
   * (pre-multi-workspace layout: auth/<workspaceId>.json with a clients array).
   */
  private importLegacyStores(): void {
    const dir = path.join(getStateDir(), "auth");
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return;
    }
    let changed = false;
    for (const name of files) {
      if (name === "clients.json" || !name.endsWith(".json")) continue;
      const data = readJsonIfExists<PersistedClients>(path.join(dir, name));
      for (const client of data?.clients ?? []) {
        if (!this.clients.has(client.clientId)) {
          this.clients.set(client.clientId, client);
          changed = true;
        }
      }
    }
    if (changed) this.save();
  }

  private save(): void {
    writeSecureJson(this.file, { clients: [...this.clients.values()] } satisfies PersistedClients);
  }

  registerClient(input: { clientName?: string; redirectUris: string[] }): ClientRegistration {
    const client: ClientRegistration = {
      clientId: `c2c_client_${randomBytes(12).toString("base64url")}`,
      clientName: input.clientName,
      redirectUris: input.redirectUris,
      createdAt: new Date().toISOString(),
    };
    this.clients.set(client.clientId, client);
    this.save();
    return client;
  }

  getClient(clientId: string): ClientRegistration | undefined {
    return this.clients.get(clientId);
  }
}
