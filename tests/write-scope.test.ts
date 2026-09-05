import { describe, expect, it } from "vitest";
import { filterScopes } from "../src/auth/store.js";


describe("write scope opt-in", () => {
  it("does not grant plan.write when the client omits scopes", () => {
    expect(filterScopes(undefined)).not.toContain("plan.write");
    expect(filterScopes("")).not.toContain("plan.write");
  });

  it("grants plan.write only when requested explicitly", () => {
    expect(filterScopes("workspace.read plan.write")).toEqual(["workspace.read", "plan.write"]);
  });

  it("does not silently rewrite a request containing unsupported scopes", () => {
    expect(filterScopes("plan.write unknown.scope")).toEqual([]);
    expect(filterScopes("unknown.scope")).toEqual([]);
  });
});
