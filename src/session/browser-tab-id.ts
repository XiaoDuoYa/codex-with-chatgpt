import { z } from "zod";

// Browser locators are opaque provider identities, not C2C IDs or file names.
// Preserve legacy locators and namespaced provider IDs (e.g. browser-use:UUID)
// exactly; never trim, strip the namespace, or substitute a task-local index.
export const browserTabIdSchema = z.string().max(256).regex(
  /^(?:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}|[A-Za-z0-9][A-Za-z0-9_.-]*(?::[A-Za-z0-9][A-Za-z0-9_.-]*)+)(?![\s\S])/,
);

export function isBrowserTabId(value: unknown): value is string {
  return browserTabIdSchema.safeParse(value).success;
}
