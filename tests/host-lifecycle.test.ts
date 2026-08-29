import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { existsSync } from "node:fs";
import { startBridge } from "../src/bridge/server.js";
import {
  readHostState,
  writeHostState,
  clearHostState,
  probeBridge,
  SERVICE_NAME,
} from "../src/bridge/runtime.js";
import { acquireHostLock, ensureBridge, stopBridge } from "../src/process/daemon.js";
import { ClientRegistry } from "../src/auth/clients.js";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";

function stateDirRuntime(): string {
  return path.join(process.env.C2C_STATE_DIR!, "runtime");
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    resolve(typeof addr === "object" && addr ? addr.port : 0);
  }));
}

/** A pre-upgrade single-workspace bridge: /health carries workspaceId. */
function startFakeLegacyBridge(opts: { shutdownAuthorized?: boolean } = {}): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? "";
      if (url.startsWith("/health")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ service: SERVICE_NAME, version: "0.1.0", workspaceId: "legacyws0000", status: "ok" }));
        return;
      }
      if (url.startsWith("/admin/") && opts.shutdownAuthorized) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ shuttingDown: true }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
    });
    listen(server).then((port) => resolve({ server, port }));
  });
}

describe("host lifecycle hardening", () => {
  describe("ClientRegistry legacy migration", () => {
    it("imports clients from per-workspace auth store files", () => {
      const stateDir = isolateStateDir();
      const legacyStore = {
        clients: [
          {
            clientId: "c2c_client_legacy123",
            clientName: "ChatGPT",
            redirectUris: ["https://chatgpt.com/connector/oauth/abc"],
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        tokens: [],
      };
      write(path.join(stateDir, "auth"), "abcdef123456.json", JSON.stringify(legacyStore));
      const registry = new ClientRegistry();
      const client = registry.getClient("c2c_client_legacy123");
      expect(client?.clientName).toBe("ChatGPT");
    });
  });
});

describe("concurrent sessions converge on one host", () => {
  let rootA: string;
  let rootB: string;

  /**
   * Tests must not touch the machine's real default port, and on Windows a
   * hard-coded random port can land in an excluded range (EACCES). Ask the
   * OS for a currently-bindable port instead.
   */
  function testPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => (port ? resolve(port) : reject(new Error("no port available"))));
      });
    });
  }

  afterAll(async () => {
    if (rootA) await stopBridge(rootA);
    if (rootB) await stopBridge(rootB);
    if (rootA) cleanup(rootA);
    if (rootB) cleanup(rootB);
    clearHostState();
  });

  it(
    "two parallel ensureBridge calls share one process, and stopping one keeps the other",
    async () => {
      isolateStateDir();
      rootA = makeTmpDir("conv-a");
      rootB = makeTmpDir("conv-b");
      write(rootA, "a.txt", "a\n");
      write(rootB, "b.txt", "b\n");

      const port = await testPort();
      const [resultA, resultB] = await Promise.all([
        ensureBridge(rootA, { port }),
        ensureBridge(rootB, { port }),
      ]);
      expect(resultA.runtime.port).toBe(resultB.runtime.port);
      expect(resultA.runtime.adminToken).toBe(resultB.runtime.adminToken);

      const host = readHostState();
      expect(host).not.toBeNull();
      expect(host!.workspaces.sort()).toEqual([resultA.runtime.workspaceId, resultB.runtime.workspaceId].sort());
      expect(await probeBridge(resultA.runtime.port)).not.toBeNull();

      // Stopping A unregisters it; B must keep serving.
      expect(await stopBridge(rootA)).toBe(true);
      expect(await probeBridge(resultB.runtime.port)).not.toBeNull();
      const hostAfterA = readHostState();
      expect(hostAfterA!.workspaces).toEqual([resultB.runtime.workspaceId]);

      // Stopping the last workspace takes the host down. Shutdown is async
      // (the unregister response races the daemon exit), so poll.
      expect(await stopBridge(rootB)).toBe(true);
      const shutdownDeadline = Date.now() + 15_000;
      while (readHostState() && Date.now() < shutdownDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(readHostState()).toBeNull();

      // Ordering invariant (checked on a fresh stop): the machine lock is
      // never released while the HTTP listener is still accepting
      // connections. Stop A again on a re-registered host and sample both
      // signals tightly through the whole shutdown window.
      expect(await ensureBridge(rootA, { port }).then((r) => r.runtime.port)).toBe(port);
      expect(await stopBridge(rootA)).toBe(true);
      const seen: Array<{ lock: boolean; port: boolean }> = [];
      const sampleDeadline = Date.now() + 15_000;
      for (;;) {
        const lockGone = !existsSync(path.join(stateDirRuntime(), "host.lock"));
        const portAlive = (await probeBridge(port, 300)) !== null;
        seen.push({ lock: lockGone, port: portAlive });
        if (lockGone && !portAlive) break;
        if (Date.now() > sampleDeadline) break;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      const badOrder = seen.some((s) => s.lock && s.port);
      expect(badOrder).toBe(false);
    },
    60_000
  );

  it("a lock held by a live process never yields a second host", async () => {
    isolateStateDir();
    const root = makeTmpDir("conv-lock");
    write(root, "d.txt", "d\n");
    // Simulate a slow starter: the lock exists with a live holder (this test
    // process) and no host ever becomes reachable.
    const { acquireHostLock } = await import("../src/process/daemon.js");
    const held = acquireHostLock();
    expect(held).not.toBeNull();
    try {
      await expect(ensureBridge(root, { port: await testPort() })).rejects.toThrow(/20s|exited with code/);
      // No second host may have appeared.
      expect(readHostState()).toBeNull();
    } finally {
      held!.release();
      cleanup(root);
      clearHostState();
    }
  }, 60_000);

  it("a live shared host with a well-formed but WRONG host.json is reconstructed, never killed", async () => {
    isolateStateDir();
    const rootA = makeTmpDir("conv-mig-a");
    const rootB = makeTmpDir("conv-mig-b");
    write(rootA, "a.txt", "a\n");
    write(rootB, "b.txt", "b\n");
    const port = await testPort();
    try {
      const first = await ensureBridge(rootA, { port });
      const hostBefore = readHostState();
      expect(hostBefore).not.toBeNull();
      // Forge a well-formed record pointing at the live host with the wrong
      // instance nonce and a wrong admin token (worst-case stale record).
      const forged = {
        ...hostBefore!,
        instance: "forged-instance",
        adminToken: "c2c_admin_forged",
      };
      write(stateDirRuntime(), "host.json", JSON.stringify(forged));
      const second = await ensureBridge(rootB, { port });
      // The SAME process must still be serving; no second host anywhere.
      expect(second.runtime.port).toBe(first.runtime.port);
      expect(second.runtime.pid).toBe(first.runtime.pid);
      const hostAfter = readHostState();
      expect(hostAfter!.instance).toBe(hostBefore!.instance);
      expect(hostAfter!.adminToken).toBe(hostBefore!.adminToken);
      expect(hostAfter!.workspaces.sort()).toEqual(
        [first.runtime.workspaceId, second.runtime.workspaceId].sort()
      );
    } finally {
      await stopBridge(rootA);
      await stopBridge(rootB);
      cleanup(rootA);
      cleanup(rootB);
      clearHostState();
    }
  }, 60_000);

  it("re-acquiring in the same process fails and preserves the first generation", async () => {
    isolateStateDir();
    const first = acquireHostLock();
    expect(first).not.toBeNull();
    const fsmod = await import("node:fs");
    try {
      expect(acquireHostLock()).toBeNull();
      const holder = JSON.parse(
        fsmod.readFileSync(path.join(stateDirRuntime(), "host.lock"), "utf8")
      ) as { identity?: string };
      expect(holder.identity).toBe(first!.identity);
    } finally {
      first!.release();
      clearHostState();
    }
  });

  it("a dead-PID lock is never auto-recovered (fully fail-closed)", async () => {
    isolateStateDir();
    const fsmod = await import("node:fs");
    const deadLock = JSON.stringify({ pid: 999999999, identity: "deadgen", startedAt: new Date().toISOString() });
    write(stateDirRuntime(), "host.lock", deadLock);
    try {
      expect(acquireHostLock()).toBeNull();
      const text = fsmod.readFileSync(path.join(stateDirRuntime(), "host.lock"), "utf8");
      expect(text).toBe(deadLock);
    } finally {
      fsmod.rmSync(path.join(stateDirRuntime(), "host.lock"), { force: true });
      clearHostState();
    }
  });

  it("concurrent close awaits one shutdown; onShutdown runs exactly once", async () => {
    isolateStateDir();
    const root = makeTmpDir("concurrent-close");
    write(root, "e.txt", "e\n");
    let onShutdownCalls = 0;
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      onShutdown: () => {
        onShutdownCalls++;
      },
    });
    try {
      let secondResolvedAt = 0;
      let onShutdownAt = 0;
      const first = bridge.close().then(() => {
        onShutdownAt = Date.now();
      });
      const second = bridge.close().then(() => {
        secondResolvedAt = Date.now();
      });
      await Promise.all([first, second]);
      expect(onShutdownCalls).toBe(1);
      // The shared promise means the second caller also waited for cleanup.
      expect(secondResolvedAt).toBeGreaterThanOrEqual(onShutdownAt);
    } finally {
      cleanup(root);
      clearHostState();
    }
  });

  it("a partial/unreadable host.lock is never auto-removed", async () => {
    isolateStateDir();
    const partial = "{ truncated";
    write(stateDirRuntime(), "host.lock", partial);
    const fsmod = await import("node:fs");
    try {
      expect(acquireHostLock()).toBeNull();
      // The unknown lock file must survive untouched.
      const text = fsmod.readFileSync(path.join(stateDirRuntime(), "host.lock"), "utf8");
      expect(text).toBe(partial);
    } finally {
      fsmod.rmSync(path.join(stateDirRuntime(), "host.lock"), { force: true });
      clearHostState();
    }
  });

  it("a legacy responder with no usable record fails closed: no second host", async () => {
    isolateStateDir();
    const { server, port } = await startFakeLegacyBridge();
    const root = makeTmpDir("conv-legacy-norec");
    write(root, "x.txt", "x\n");
    try {
      await expect(ensureBridge(root, { port })).rejects.toThrow(/pre-upgrade|Refusing/);
      expect(readHostState()).toBeNull();
    } finally {
      server.close();
      cleanup(root);
      clearHostState();
    }
  }, 30_000);

  it("a legacy responder that refuses to stop fails closed: no second host", async () => {
    isolateStateDir();
    const { server, port } = await startFakeLegacyBridge();
    const root = makeTmpDir("conv-legacy-stuck");
    write(root, "x.txt", "x\n");
    // A runtime record on that port whose token cannot authenticate and whose
    // PID does not exist: shutdown fails, SIGTERM fails.
    write(stateDirRuntime(), "deadbeef0000.json", JSON.stringify({
      service: SERVICE_NAME,
      version: "0.1.0",
      workspaceId: "deadbeef0000",
      workspaceRoot: "C:\\nowhere",
      pid: 999999999,
      port,
      adminToken: "c2c_admin_wrong",
      publicUrl: null,
      startedAt: new Date().toISOString(),
    }));
    try {
      await expect(ensureBridge(root, { port })).rejects.toThrow(/still occupies|Refusing/);
      expect(readHostState()).toBeNull();
      // The legacy responder itself must still be alive (nothing killed it).
      expect(await probeBridge(port)).not.toBeNull();
    } finally {
      server.close();
      cleanup(root);
      clearHostState();
    }
  }, 30_000);

  it("a stale host record self-heals on the next ensureBridge", async () => {
    isolateStateDir();
    const root = makeTmpDir("conv-stale");
    write(root, "c.txt", "c\n");
    writeHostState({
      service: "c2c-bridge",
      version: "0.1.0",
      instance: "deadbeef",
      pid: 999999,
      port: 1, // nothing answers here
      adminToken: "c2c_admin_stale",
      publicUrl: null,
      startedAt: new Date().toISOString(),
      workspaces: [],
    });
    const port = await testPort();
    try {
      const { runtime } = await ensureBridge(root, { port });
      expect(runtime.port).toBe(port);
      const host = readHostState();
      expect(host!.port).toBe(runtime.port);
      expect(host!.instance).not.toBe("deadbeef");
    } finally {
      await stopBridge(root);
      cleanup(root);
    }
  }, 60_000);
});
