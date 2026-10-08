import { describe, expect, it, vi } from "vitest";
import { upstreamUpdateAvailable } from "../src/cli/update-check.js";

describe("upstream update check", () => {
  it("does not prompt for an equal commit", () => {
    const isAncestor = vi.fn();
    expect(upstreamUpdateAvailable("same", "same", isAncestor)).toBe(false);
    expect(isAncestor).not.toHaveBeenCalled();
  });

  it("does not prompt when local commits are ahead of the remote", () => {
    const isAncestor = vi.fn(() => true);
    expect(upstreamUpdateAvailable("local-new", "remote-old", isAncestor)).toBe(false);
    expect(isAncestor).toHaveBeenCalledWith("remote-old", "local-new");
  });

  it("prompts when upstream has commits not in the local checkout", () => {
    expect(upstreamUpdateAvailable("local-old", "remote-new", () => false)).toBe(true);
    expect(upstreamUpdateAvailable("local-diverged", "remote-diverged", () => false)).toBe(true);
  });
});
