import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getStateDir, readJsonIfExists, withFileLock, writeSecureJson } from "../config/paths.js";
import { resolveMachineIdentity } from "./identity.js";

const nameSchema = z.string().min(1).max(200).refine(
  (value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value),
);
const pluginUrlSchema = z.string().regex(/^https:\/\/chatgpt\.com\/plugins\/plugin_[A-Za-z0-9_-]+$/).refine(value => value.trim() === value);
const bindingSchema = z.object({
  schemaVersion: z.literal(1),
  machineId: z.string().regex(/^machine-[a-f0-9]{32}$/),
  tunnelId: z.string().regex(/^tunnel_[a-f0-9]{32}$/),
  associationId: z.string().regex(/^assoc-[a-f0-9]{32}$/),
  name: nameSchema,
  pluginUrl: pluginUrlSchema.optional(),
  updatedAt: z.string().datetime(),
}).strict();

export type MachineConnectorBinding = z.infer<typeof bindingSchema>;
export type ConnectorTarget = Omit<MachineConnectorBinding, "schemaVersion" | "updatedAt">;
export type ConnectorMachine = Pick<ConnectorTarget, "machineId" | "tunnelId" | "associationId">;
export type ConnectorBindingStatus = {
  status: "unconfigured" | "bound" | "stale";
  binding: MachineConnectorBinding | null;
};

export function machineConnectorFile(): string {
  return path.join(getStateDir(), "machine", "connector.json");
}

function readBinding(): MachineConnectorBinding | null {
  const file = machineConnectorFile();
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Machine connector binding must be a regular file");
  const parsed = bindingSchema.safeParse(readJsonIfExists<unknown>(file));
  if (!parsed.success) throw new Error("Machine connector binding is invalid");
  return parsed.data;
}

export function connectorMachine(config: Pick<ConnectorTarget, "tunnelId" | "associationId">): ConnectorMachine {
  return { machineId: resolveMachineIdentity().machineId, tunnelId: config.tunnelId, associationId: config.associationId };
}

export function machineConnectorStatus(machine: ConnectorMachine): ConnectorBindingStatus {
  const binding = readBinding();
  if (!binding) return { status: "unconfigured", binding: null };
  const matches = (["machineId", "tunnelId", "associationId"] as const).every(key => binding[key] === machine[key]);
  return { status: matches ? "bound" : "stale", binding };
}

export function requireMachineConnector(machine: ConnectorMachine): ConnectorTarget {
  const result = machineConnectorStatus(machine);
  if (result.status !== "bound" || !result.binding) {
    throw new Error(`Machine connector binding is ${result.status}; bind this device's exact ChatGPT app once with c2c machine connector set --name <exact-name> [--plugin-url <observed-url>]. Do not select another device's app.`);
  }
  const { schemaVersion: _version, updatedAt: _time, ...target } = result.binding;
  return target;
}

/** Local routing configuration, not proof of the remote app's Tunnel association. */
export function bindMachineConnector(machine: ConnectorMachine, input: { name: string; pluginUrl?: string }): MachineConnectorBinding {
  const file = machineConnectorFile();
  return withFileLock(path.join(path.dirname(file), "connector.lock"), () => {
    const previous = readBinding();
    // A name-only edit cannot silently move a known stable app to another device.
    const sameMachine = previous && (["machineId", "tunnelId", "associationId"] as const).every(key => previous[key] === machine[key]);
    const binding = bindingSchema.parse({
      schemaVersion: 1, ...machine, name: input.name,
      pluginUrl: input.pluginUrl ?? (sameMachine ? previous.pluginUrl : undefined),
      updatedAt: new Date().toISOString(),
    });
    writeSecureJson(file, binding);
    return binding;
  });
}
