import { z } from "zod";
import { normalizeChatUrl, normalizeProjectUrl, projectIdFromChatUrl, projectIdFromUrl } from "./state.js";
import type { SurfaceBinding, SurfaceLease } from "./surface-ownership.js";

export const PAGE_STATES = [
  "ready", "archived", "unavailable", "missing", "auth-required",
  "consent-required", "loading", "generating", "unknown",
] as const;

export const pageObservationSchema = z.object({
  tabId: z.string().min(1),
  generation: z.number().int().positive().safe(),
  state: z.enum(PAGE_STATES),
  url: z.string().url().optional(),
}).strict();

export type PageObservation = z.infer<typeof pageObservationSchema>;

export interface PageRouteState {
  projectUrl: string | null;
  lease: SurfaceLease | null;
  binding: SurfaceBinding | null;
}

export type PageRecoveryAction =
  | "resume-chat" | "verify-candidate" | "reopen-chat" | "create-project-chat"
  | "bind-project" | "wait" | "user-action" | "inspect-page";

/** Browser observations come from the trusted host, never from a ChatGPT MCP call. */
export function assessPageHealth(surface: PageRouteState, input: PageObservation) {
  const observation = pageObservationSchema.parse(input);
  const owned = surface.lease ?? surface.binding;
  const generation = surface.lease?.generation ?? surface.binding?.lastGeneration;
  if (!owned || owned.tabId !== observation.tabId || generation !== observation.generation) {
    throw new Error("page observation does not match the current surface tab and generation");
  }
  const projectUrl = surface.projectUrl ?? owned.projectUrl;
  const chatUrl = surface.lease ? surface.lease.chatUrl : surface.binding?.chatUrl;
  const decision = (action: PageRecoveryAction, reason: string, targetUrl: string | null = null) => ({
    action,
    reason,
    targetUrl,
    controlReady: action === "resume-chat",
    tabId: observation.tabId,
    generation: observation.generation,
  });
  if (observation.state === "auth-required" || observation.state === "consent-required") {
    return decision("user-action", observation.state);
  }
  if (observation.state === "missing") {
    return decision(chatUrl ? "reopen-chat" : "create-project-chat", "tab-missing", chatUrl ?? projectUrl);
  }
  if (observation.state === "loading" || observation.state === "generating") {
    return decision("wait", observation.state);
  }
  if (!observation.url || observation.state === "unknown") {
    return decision("inspect-page", "page-state-unconfirmed");
  }
  // An unavailable page can redirect home. Only the stored Project selects the replacement.
  if (observation.state === "archived" || observation.state === "unavailable") {
    return decision(projectUrl ? "create-project-chat" : "bind-project", observation.state, projectUrl);
  }
  const observedChat = normalizeChatUrl(observation.url);
  const routeMatches = chatUrl
    ? observedChat === normalizeChatUrl(chatUrl)
    : normalizeProjectUrl(observation.url) === normalizeProjectUrl(projectUrl) ||
      (observedChat !== null && projectIdFromChatUrl(observedChat) === projectIdFromUrl(projectUrl));
  if (!routeMatches) {
    return decision(chatUrl ? "reopen-chat" : "create-project-chat", "url-mismatch", chatUrl ?? projectUrl);
  }
  const committed = surface.lease && surface.binding &&
    surface.lease.generation === surface.binding.lastGeneration &&
    surface.lease.tabId === surface.binding.tabId &&
    surface.lease.chatUrl === surface.binding.chatUrl;
  if (!committed) return decision("verify-candidate", "lease-or-boot-required", chatUrl ?? projectUrl);
  return decision("resume-chat", "ready", chatUrl ?? null);
}
