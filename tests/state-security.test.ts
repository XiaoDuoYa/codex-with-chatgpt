import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startBridge } from "../src/bridge/server.js";
import { readRuntimeState, runtimeFile } from "../src/bridge/runtime.js";
import { AuthStore } from "../src/auth/store.js";
import { Workspace } from "../src/workspace/manager.js";
import { acquireWorkspaceBridgeLock, workspaceStateFile } from "../src/workspace/local-state.js";
import { makeTmpDir, cleanup, makeGitRepo, git, isolateStateDir } from "./helpers.js";

describe("workspace-isolated security state", () => {
  it("keeps runtime credentials out of shared state and prevents duplicate bridges", async () => {
    const sharedState = isolateStateDir();
    const root = makeTmpDir("state-ws");
    makeGitRepo(root);
    const bridge = await startBridge({ workspaceRoot: root, port: 0 });
    try {
      const runtimePath = runtimeFile(bridge.workspace.root);
      const runtimeText = fs.readFileSync(runtimePath, "utf8");
      expect(runtimeText).not.toContain("c2c_admin_");
      expect(readRuntimeState(bridge.workspace.root)?.adminToken).toBeUndefined();
      expect(fs.readFileSync(workspaceStateFile(bridge.workspace.root, "admin-token"), "utf8")).toBe(bridge.adminToken);
      expect(fs.existsSync(path.join(sharedState, "runtime", `${bridge.workspace.id}.json`))).toBe(false);
      expect(() => bridge.workspace.resolve(".c2c-local/admin-token")).toThrow(/ACCESS_DENIED/);
      expect(git(root, "status", "--porcelain")).toBe("");

      await expect(startBridge({ workspaceRoot: root, port: 0 })).rejects.toThrow(/already active/);
    } finally {
      await bridge.close();
      cleanup(root);
    }
  });

  it("migrates the previous auth file into the selected workspace once", () => {
    const sharedState = isolateStateDir();
    const root = makeTmpDir("state-migrate");
    const workspace = new Workspace(root);
    const legacy = path.join(sharedState, "auth", `${workspace.id}.json`);
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({
      clients: [{
        clientId: "c2c_client_existing",
        clientName: "ChatGPT",
        redirectUris: ["https://chatgpt.com/connector/oauth/existing"],
        createdAt: new Date().toISOString(),
      }],
      tokens: [],
    }));

    const store = new AuthStore(workspace.id, { workspaceRoot: workspace.root });
    expect(store.getClient("c2c_client_existing")?.clientName).toBe("ChatGPT");
    expect(fs.existsSync(workspaceStateFile(workspace.root, "auth.json"))).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    cleanup(root);
  });

  it("recovers an old lock even when its PID has been reused", () => {
    const root = makeTmpDir("state-stale-lock");
    const lockFile = workspaceStateFile(root, "bridge.lock");
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: process.pid,
      instanceId: "stale-instance",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    }));
    const release = acquireWorkspaceBridgeLock(root, "fresh-instance");
    const current = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { instanceId: string };
    expect(current.instanceId).toBe("fresh-instance");
    release();
    expect(fs.existsSync(lockFile)).toBe(false);
    cleanup(root);
  });
});
