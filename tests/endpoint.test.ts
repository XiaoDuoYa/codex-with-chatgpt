import { describe, it, expect } from "vitest";
import {
  commitConnectorBinding,
  connectorAction,
  connectorNameFor,
  DEFAULT_CONNECTOR_NAME,
  mcpUrlFromPublic,
  normalizePublicUrl,
  observeWorkspaceEndpoint,
  previewWorkspaceEndpoint,
  readLastEndpoint,
  reclaimUserMessage,
} from "../src/config/endpoint.js";
import { cleanup, isolateStateDir } from "./helpers.js";

describe("connectorAction", () => {
  it("creates on the first successful URL", () => {
    expect(connectorAction(null, "https://a.trycloudflare.com/mcp")).toBe("create");
  });

  it("is a no-op when the URL is unchanged", () => {
    expect(connectorAction("https://a.trycloudflare.com/mcp", "https://a.trycloudflare.com/mcp/")).toBe("none");
  });

  it("updates when the old address was reclaimed", () => {
    expect(connectorAction("https://old.trycloudflare.com/mcp", "https://new.trycloudflare.com/mcp")).toBe("update");
    expect(reclaimUserMessage("Codex with ChatGPT")).toContain("删除");
    expect(reclaimUserMessage("Codex with ChatGPT")).not.toContain("Reconnect");
    expect(reclaimUserMessage("Codex with ChatGPT")).toContain("旧 ChatGPT 会话");
  });

  it("does nothing without a next URL", () => {
    expect(connectorAction("https://a.trycloudflare.com/mcp", null)).toBe("none");
  });
});

describe("connectorNameFor", () => {
  it("keeps a stored name for the same workspace", () => {
    expect(
      connectorNameFor({
        workspaceName: "EchoMind",
        workspaceId: "abc123abc123",
        previousName: "Codex with ChatGPT",
        hadEndpointBefore: true,
      })
    ).toBe(DEFAULT_CONNECTOR_NAME);
  });

  it("keeps the legacy title when this workspace was used before the name field existed", () => {
    expect(
      connectorNameFor({
        workspaceName: "EchoMind",
        workspaceId: "abc123abc123",
        hadEndpointBefore: true,
      })
    ).toBe(DEFAULT_CONNECTOR_NAME);
  });

  it("gives a new workspace its own connector title", () => {
    expect(
      connectorNameFor({
        workspaceName: "Landing",
        workspaceId: "def456def456",
        hadEndpointBefore: false,
      })
    ).toBe("Codex with ChatGPT · Landing");
  });
});

describe("mcpUrlFromPublic", () => {
  it("appends /mcp and folds case/slash variants", () => {
    expect(mcpUrlFromPublic("https://A.trycloudflare.com/")).toBe("https://a.trycloudflare.com/mcp");
    expect(mcpUrlFromPublic("https://a.trycloudflare.com/mcp")).toBe("https://a.trycloudflare.com/mcp");
    expect(normalizePublicUrl("https://A.trycloudflare.com/")).toBe("https://a.trycloudflare.com");
  });
});
describe("endpoint identity lifecycle", () => {
  it("keeps URL observation separate from an explicit connector commit", () => {
    const previousStateDir = process.env.C2C_STATE_DIR;
    const stateDir = isolateStateDir();
    const workspaceId = "endpoint-lifecycle";
    try {
      const first = observeWorkspaceEndpoint({
        workspaceId,
        workspaceName: "Endpoint",
        port: 1234,
        publicUrl: "https://old.example.test",
        mcpUrl: "https://old.example.test/mcp",
      });
      expect(first.connectorBound).toBeNull();
      expect(first.pendingRepair?.generation).toBe(1);

      const preview = previewWorkspaceEndpoint({
        workspaceId,
        workspaceName: "Endpoint",
        port: 1234,
        publicUrl: "https://new.example.test",
        mcpUrl: "https://new.example.test/mcp",
        previous: first,
      });
      expect(preview.pendingRepair?.generation).toBe(2);
      expect(preview.pendingRepair?.observed.mcpUrl).toBe("https://new.example.test/mcp");
      expect(readLastEndpoint(workspaceId)?.pendingRepair?.observed.mcpUrl).toBe("https://old.example.test/mcp");

      const committed = commitConnectorBinding({
        state: first,
        generation: first.pendingRepair!.generation,
        fingerprint: first.pendingRepair!.fingerprint,
      });
      expect(committed.connectorBound?.mcpUrl).toBe("https://old.example.test/mcp");
      expect(committed.pendingRepair).toBeNull();

      const changed = observeWorkspaceEndpoint({
        workspaceId,
        workspaceName: "Endpoint",
        port: 1234,
        publicUrl: "https://new.example.test",
        mcpUrl: "https://new.example.test/mcp",
        previous: committed,
      });
      expect(changed.connectorBound?.mcpUrl).toBe("https://old.example.test/mcp");
      expect(changed.pendingRepair?.generation).toBe(2);
      expect(() =>
        commitConnectorBinding({
          state: changed,
          generation: 1,
          fingerprint: first.pendingRepair!.fingerprint,
        })
      ).toThrow("C2C_CONNECTOR_BINDING_MISMATCH");
    } finally {
      cleanup(stateDir);
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });

  it("clears a pending replacement when the observed URL returns to the bound connector", () => {
    const previousStateDir = process.env.C2C_STATE_DIR;
    const stateDir = isolateStateDir();
    const workspaceId = "endpoint-reversion";
    try {
      const initial = observeWorkspaceEndpoint({
        workspaceId,
        workspaceName: "Endpoint",
        port: 1234,
        publicUrl: "https://old.example.test",
        mcpUrl: "https://old.example.test/mcp",
      });
      const initialPending = initial.pendingRepair!;
      const bound = commitConnectorBinding({
        state: initial,
        generation: initialPending.generation,
        fingerprint: initialPending.fingerprint,
      });
      const changed = observeWorkspaceEndpoint({
        workspaceId,
        workspaceName: "Endpoint",
        port: 1234,
        publicUrl: "https://new.example.test",
        mcpUrl: "https://new.example.test/mcp",
        previous: bound,
      });
      expect(changed.pendingRepair?.generation).toBe(initialPending.generation + 1);

      const restored = observeWorkspaceEndpoint({
        workspaceId,
        workspaceName: "Endpoint",
        port: 1234,
        publicUrl: "https://old.example.test",
        mcpUrl: "https://old.example.test/mcp",
        previous: changed,
      });

      expect(restored.pendingRepair).toBeNull();
      expect(restored.connectorBound?.generation).toBe(bound.connectorBound?.generation);
      expect(restored.connectorBound?.fingerprint).toBe(bound.connectorBound?.fingerprint);
      expect(readLastEndpoint(workspaceId)?.pendingRepair).toBeNull();
    } finally {
      cleanup(stateDir);
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });
});
