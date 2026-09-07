import { describe, expect, it } from "vitest";
import { browserTabIdSchema } from "../src/session/browser-tab-id.js";
import { c2cIdSchema, validateBrowserTabId, validateControlId } from "../src/control/result-schema.js";

describe("browser provider locators", () => {
  it.each(["2", "tab-old", "fc6c0073-5fb5-4a4e-81f7-307535575b6a", "browser-use:fc6c0073-5fb5-4a4e-81f7-307535575b6a"])("preserves %s exactly", (id) => {
    expect(browserTabIdSchema.parse(id)).toBe(id);
    expect(validateBrowserTabId(id)).toBe(id);
  });
  it.each(["", " browser-use:abc", "browser-use:abc ", "browser-use:", "browser-use:../abc", "browser-use:abc/def", "browser-use:abc\\def", "browser-use:abc\u0000def", "browser-use:abc\ndef", "browser-use:abc\n", "2\r\n", "browser-use:" + "a".repeat(256)])("rejects malformed locator %j", (id) => {
    expect(browserTabIdSchema.safeParse(id).success).toBe(false);
    expect(() => validateBrowserTabId(id)).toThrow();
  });
  it("does not expand path-safe request or session IDs", () => {
    expect(c2cIdSchema.safeParse("browser-use:abc").success).toBe(false);
    expect(() => validateControlId("browser-use:abc")).toThrow();
  });
});
