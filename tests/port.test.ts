import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { probeBridge } from "../src/bridge/runtime.js";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.C2C_STATE_DIR;
  stateDir = isolateStateDir();
});

afterEach(() => {
  cleanup(stateDir);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

describe("port collision handling", () => {
  it("falls back to a free port when the preferred one is taken", async () => {
    const rootA = makeTmpDir("port-a");
    const rootB = makeTmpDir("port-b");
    const authA = makeTmpDir("auth");
    const authB = makeTmpDir("auth");
    write(rootA, "a.txt", "a");
    write(rootB, "b.txt", "b");
    const preferred = 47000 + Math.floor(Math.random() * 1000);
    let bridgeA: Bridge | undefined;
    let bridgeB: Bridge | undefined;

    try {
      bridgeA = await startBridge({
        workspaceRoot: rootA,
        port: preferred,
        persistRuntime: false,
        authStoreFile: path.join(authA, "a.json"),
      });
      bridgeB = await startBridge({
        workspaceRoot: rootB,
        port: preferred,
        persistRuntime: false,
        authStoreFile: path.join(authB, "b.json"),
      });

      expect(bridgeA.port).toBe(preferred);
      expect(bridgeB.port).not.toBe(preferred);
      expect(bridgeB.port).toBeGreaterThan(0);

      // health identifies each bridge's workspace, so callers can detect reuse
      const healthA = await probeBridge(bridgeA.port);
      const healthB = await probeBridge(bridgeB.port);
      expect(healthA?.workspaceId).toBe(bridgeA.workspace.id);
      expect(healthB?.workspaceId).toBe(bridgeB.workspace.id);
      expect(healthA?.workspaceId).not.toBe(healthB?.workspaceId);
    } finally {
      try {
        if (bridgeB) await bridgeB.close();
      } finally {
        try {
          if (bridgeA) await bridgeA.close();
        } finally {
          cleanup(rootA);
          cleanup(rootB);
          cleanup(authA);
          cleanup(authB);
        }
      }
    }
  });

  it("refuses to bind non-loopback hosts", async () => {
    const root = makeTmpDir("port-c");
    write(root, "c.txt", "c");
    try {
      await expect(
        startBridge({ workspaceRoot: root, host: "0.0.0.0", persistRuntime: false })
      ).rejects.toThrow(/loopback/);
    } finally {
      cleanup(root);
    }
  });
});
