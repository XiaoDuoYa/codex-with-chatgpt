import { z } from "zod";
import { c2cIdSchema } from "../control/result-schema.js";
import { normalizeChatUrl } from "./state.js";

const text = z.string().trim().min(1).max(200);
const toolName = text.refine((value) => !/[\s*?\u0000-\u001f\u007f]/.test(value), "Use an exact tool identifier, not a wildcard.");
const operationSchema = z.object({ plugin: text, tool: toolName }).strict();
export const pluginIdsSchema = z.array(text).max(32);
export const pluginIntentSchema = z.enum(["task", "identity-discovery"]);
export const repositoryTargetSchema = z.object({ host: text, owner: text, name: text }).strict();
export const pluginPreflightSchema = z.object({
  workspaceId: c2cIdSchema, localSessionId: c2cIdSchema, taskId: c2cIdSchema,
  iteration: z.number().int().nonnegative(), phase: text,
  tabId: c2cIdSchema, generation: z.number().int().positive().safe(), chatUrl: z.string().url(),
  bootEpoch: text, observedAt: z.string().datetime(),
  // Account/workspace key observed by the host; a nickname is not a provider identity.
  chatgptAccount: text,
  requestedOperations: z.array(operationSchema).min(1).max(128).optional(),
  plugins: z.array(z.object({
    id: text,
    availability: z.enum(["available", "unavailable", "work-only", "consent-required", "unknown"]),
    // Include underlying apps: a bundle using GitHub needs the same GitHub check.
    usesGitHub: z.boolean(),
    tools: z.array(z.object({
      tool: toolName,
      availability: z.enum(["available", "unavailable", "work-only", "consent-required", "unknown"]),
      effect: z.enum(["read", "profile", "write", "unknown"]),
    }).strict()).max(64).optional(),
    authenticatedProfileTool: toolName.optional(),
    githubActor: z.object({ login: text, id: z.string().regex(/^[1-9]\d*$/), source: z.literal("authenticated-profile") }).strict().optional(),
  }).strict()).max(32),
  github: z.object({
    repository: repositoryTargetSchema,
    expectedActor: z.object({ login: text, id: z.string().regex(/^[1-9]\d*$/) }).strict(),
  }).strict().optional(),
}).strict();

export type PluginPreflight = z.infer<typeof pluginPreflightSchema>;
export interface PluginTurn {
  workspaceId: string; localSessionId: string; taskId: string; iteration: number; phase: string;
  generation: number; plugins?: string[]; pluginPreflight?: PluginPreflight;
  pluginIntent?: z.infer<typeof pluginIntentSchema>; scopes?: readonly string[];
}

/** A dispatch gate for host observations, not a sandbox for independent app transports. */
export function assessPluginPreflight(
  turn: PluginTurn,
  surface: { tabId: string; chatUrl?: string; generation: number } | null,
  bootEpoch: string,
  now = Date.now(),
) {
  const requested = pluginIdsSchema.parse(turn.plugins ?? []);
  const intent = pluginIntentSchema.parse(turn.pluginIntent ?? "task");
  if (intent === "identity-discovery" && (turn.phase !== "RESEARCH" || requested.length !== 1 ||
      turn.scopes?.some((scope) => scope !== "c2c.result.write"))) {
    throw new Error("Identity discovery requires one plugin, RESEARCH and result-only C2C scopes.");
  }
  if (new Set(requested).size !== requested.length) throw new Error("Duplicate requested plugins.");
  if (requested.length === 0) {
    if (turn.pluginPreflight) throw new Error("Plugin observations require an explicit plugin selection.");
    return { allowedPlugins: [], access: "read-only" as const };
  }
  const proof = pluginPreflightSchema.parse(turn.pluginPreflight);
  for (const key of ["workspaceId", "localSessionId", "taskId", "iteration", "phase", "generation"] as const) {
    if (proof[key] !== turn[key]) throw new Error(`Plugin preflight ${key} does not match this turn.`);
  }
  const age = now - Date.parse(proof.observedAt);
  if (age < 0 || age > 5 * 60_000 || proof.bootEpoch !== bootEpoch) throw new Error("Plugin preflight is stale; inspect this session again.");
  if (!surface || surface.tabId !== proof.tabId || surface.generation !== proof.generation ||
      !surface.chatUrl || !normalizeChatUrl(proof.chatUrl) || normalizeChatUrl(surface.chatUrl) !== normalizeChatUrl(proof.chatUrl)) {
    throw new Error("Plugin preflight does not match the exact owned chat.");
  }
  if (new Set(proof.plugins.map((plugin) => plugin.id)).size !== proof.plugins.length ||
      proof.plugins.length !== requested.length) throw new Error("Plugin observations must match the requested set exactly.");
  if (intent === "identity-discovery" && proof.requestedOperations) {
    throw new Error("Identity discovery selects only authenticatedProfileTool, not business operations.");
  }
  for (const id of requested) {
    const plugin = proof.plugins.find((entry) => entry.id === id);
    if (!plugin || plugin.availability !== "available") throw new Error(`Plugin ${id} is not available in this Project chat; do not switch modes or accounts.`);
    if (plugin.usesGitHub || /github/i.test(id)) {
      if (intent === "identity-discovery") {
        if (!plugin.authenticatedProfileTool) throw new Error("Identity discovery requires an observed authenticated own-profile tool.");
        return {
          allowedPlugins: requested,
          access: "authenticated-profile-only" as const,
          allowedOperations: [{ plugin: id, tool: plugin.authenticatedProfileTool }],
          repositoryAccess: "none" as const,
        };
      }
      const expected = proof.github?.expectedActor;
      const actor = plugin.githubActor;
      if (!expected || !actor) throw new Error("GitHub plugin identity is unknown; only authenticated own-profile discovery is allowed.");
      if (actor.id !== expected.id || actor.login.toLowerCase() !== expected.login.toLowerCase()) {
        throw new Error("GitHub plugin account does not match the expected local GitHub account.");
      }
    } else if (intent === "identity-discovery") {
      throw new Error("Identity discovery is only supported for a GitHub-dependent plugin.");
    }
  }
  const operations = proof.requestedOperations;
  if (!operations?.length) throw new Error("Plugin tasks require explicit requestedOperations; an app name is not a tool grant.");
  const operationKeys = operations.map(({ plugin, tool }) => JSON.stringify([plugin, tool]));
  if (new Set(operationKeys).size !== operations.length) throw new Error("Duplicate requested plugin operations.");
  for (const plugin of proof.plugins) {
    if (!operations.some((operation) => operation.plugin === plugin.id)) {
      throw new Error(`Plugin ${plugin.id} has no requested operation.`);
    }
    const names = plugin.tools?.map(({ tool }) => tool) ?? [];
    if (new Set(names).size !== names.length) throw new Error(`Plugin ${plugin.id} has duplicate observed tools.`);
  }
  for (const operation of operations) {
    const plugin = proof.plugins.find(({ id }) => id === operation.plugin);
    const tool = plugin?.tools?.find(({ tool }) => tool === operation.tool);
    if (!plugin || !tool || tool.availability !== "available" || tool.effect !== "read") {
      throw new Error(`Plugin operation ${operation.plugin}/${operation.tool} is not an observed available read-only tool in this Project chat.`);
    }
  }
  return {
    allowedPlugins: requested, allowedOperations: operations, access: "read-only" as const,
    ...(proof.github ? { repository: proof.github.repository } : {}),
  };
}
