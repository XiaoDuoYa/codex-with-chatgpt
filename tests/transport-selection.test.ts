import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { selectTransport, TransportSelectionError } from "../src/transport/select.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

describe("transport selection", () => {
  it("uses a one-task override without writing project config", () => {
    const root = makeTmpDir("transport-override");
    try {
      const selected = selectTransport({ projectDefault: "auto", taskOverride: "github", hasGitHubRemote: true });
      expect(selected).toBe("github");
      expect(fs.existsSync(path.join(root, ".c2c.json"))).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  it("respects explicit MCP and a Plus hint", () => {
    expect(selectTransport({ projectDefault: "mcp", hasGitHubRemote: true })).toBe("mcp");
    expect(selectTransport({ projectDefault: "auto", accountHint: "plus", hasGitHubRemote: true })).toBe("github");
    expect(selectTransport({ projectDefault: "auto", accountHint: "mcp", hasGitHubRemote: true })).toBe("mcp");
  });

  it("blocks GitHub selection when no GitHub remote exists", () => {
    expect(() => selectTransport({ projectDefault: "github", hasGitHubRemote: false })).toThrowError(TransportSelectionError);
    try {
      selectTransport({ projectDefault: "auto", accountHint: "plus", hasGitHubRemote: false });
    } catch (error) {
      expect((error as TransportSelectionError).code).toBe("GITHUB_REMOTE_REQUIRED");
    }
  });

  it("keeps old project config readable", () => {
    const root = makeTmpDir("old-project-config");
    try {
      write(root, ".c2c.json", JSON.stringify({ name: "Legacy", maxIterations: 7 }));
      const workspace = new Workspace(root);
      expect(workspace.projectConfig).toMatchObject({ name: "Legacy", maxIterations: 7 });
      expect(workspace.projectConfig.transport).toBeUndefined();
    } finally {
      cleanup(root);
    }
  });
});
