import { z } from "zod";
import { normalizeProjectUrl } from "./state.js";

export const projectSelectionSchema = z.object({
  source: z.enum(["created", "user-confirmed"]),
  projectUrl: z.string().url().max(4096),
  observedTitle: z.string().trim().min(1).max(200),
  observedAt: z.string().datetime(),
}).strict();

export type ProjectSelection = z.infer<typeof projectSelectionSchema>;

interface PairingSurface {
  projectUrl: string | null;
  lease: { projectUrl: string; chatUrl?: string } | null;
  binding: { projectUrl: string; chatUrl: string } | null;
  control?: { status: string } | null;
}

/** Read-only host guidance. A suggested action is not creation/BOOT evidence. */
export function planProjectPairing(surface: PairingSurface, requestedProjectUrl?: string) {
  const requested = requestedProjectUrl === undefined ? null : normalizeProjectUrl(requestedProjectUrl);
  if (requestedProjectUrl !== undefined && !requested) throw new Error("Requested Project URL is invalid.");
  const existing = surface.projectUrl ?? surface.lease?.projectUrl ?? surface.binding?.projectUrl ?? null;
  if (requested && existing && requested !== normalizeProjectUrl(existing)) {
    throw new Error("Requested Project differs from the saved route; migrate that binding explicitly first.");
  }
  const projectUrl = existing ?? requested;
  // A candidate owns the next route even when an older committed chat exists.
  const chatUrl = surface.lease ? surface.lease.chatUrl ?? null : surface.binding?.chatUrl ?? null;
  if (surface.control?.status === "pending" || surface.control?.status === "received") {
    return { action: "resume-control" as const, projectUrl, chatUrl, selectionSource: null };
  }
  if (surface.lease || surface.binding) {
    return { action: "inspect-owned-page" as const, projectUrl, chatUrl, selectionSource: null };
  }
  if (existing) return { action: "create-project-chat" as const, projectUrl, chatUrl: null, selectionSource: null };
  if (requested) return { action: "use-requested-project" as const, projectUrl, chatUrl: null, selectionSource: "user-confirmed" as const };
  return { action: "create-project" as const, projectUrl: null, chatUrl: null, selectionSource: "created" as const };
}

/** Host CUA evidence, not a browser probe or an assertion supplied by ChatGPT. */
export function validateProjectSelection(
  input: unknown,
  projectUrl: string,
  workspaceName: string,
  now = Date.now(),
): ProjectSelection {
  if (!input) throw new Error("First Project pairing needs creation evidence: create this workspace's Project under the existing task authorization, or use an exact Project URL already selected by the user. Record the observed result before claiming.");
  const selection = projectSelectionSchema.parse(input);
  const url = normalizeProjectUrl(selection.projectUrl);
  if (!url || url !== normalizeProjectUrl(projectUrl)) {
    throw new Error("Project selection evidence does not match the requested Project URL.");
  }
  const age = now - Date.parse(selection.observedAt);
  if (age < 0 || age > 5 * 60_000) throw new Error("Project selection evidence is stale; observe the candidate again.");
  if (selection.source === "created" && selection.observedTitle !== workspaceName) {
    throw new Error("Created Project title does not match this workspace; do not adopt another Project.");
  }
  return { ...selection, projectUrl: url };
}
