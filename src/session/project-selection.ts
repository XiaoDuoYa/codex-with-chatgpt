import { z } from "zod";
import { normalizeProjectUrl } from "./state.js";

export const projectSelectionSchema = z.object({
  source: z.enum(["created", "user-confirmed"]),
  projectUrl: z.string().url().max(4096),
  observedTitle: z.string().trim().min(1).max(200),
  observedAt: z.string().datetime(),
}).strict();

export type ProjectSelection = z.infer<typeof projectSelectionSchema>;

/** Host CUA evidence, not a browser probe or an assertion supplied by ChatGPT. */
export function validateProjectSelection(
  input: unknown,
  projectUrl: string,
  workspaceName: string,
  now = Date.now(),
): ProjectSelection {
  if (!input) throw new Error("First Project pairing requires observed creation or explicit user confirmation of its exact URL.");
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
