import { describe, expect, it } from "vitest";
import { redact } from "../src/logger/index.js";


describe("plan authorization redaction", () => {
  it("redacts one-time plan capabilities from log text", () => {
    const capability = `c2c_plan_${"A".repeat(43)}`;
    const output = redact(`authorization=${capability}`);
    expect(output).not.toContain(capability);
    expect(output).toContain("[REDACTED]");
  });
});
