import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import type { TunnelProvider, TunnelStatus, TunnelDoctorReport } from "../src/tunnel/provider.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ControlledTunnel implements TunnelProvider {
  readonly name = "controlled";
  readonly startGate = deferred();
  readonly startEntered = deferred();
  readonly stopGate = deferred();
  readonly stopEntered = deferred();
  readonly events: string[] = [];
  startCalls = 0;
  stopCalls = 0;
  active = 0;
  maxActive = 0;
  private running = false;
  private url: string | null = null;

  private enter(operation: string): void {
    this.events.push(`${operation}-enter`);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
  }

  private leave(operation: string): void {
    this.events.push(`${operation}-exit`);
    this.active -= 1;
  }

  async start(_localPort: number): Promise<string> {
    this.startCalls += 1;
    this.enter("start");
    this.startEntered.resolve();
    await this.startGate.promise;
    this.running = true;
    this.url = "https://controlled.example.test";
    this.leave("start");
    return this.url;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.enter("stop");
    this.stopEntered.resolve();
    await this.stopGate.promise;
    this.running = false;
    this.url = null;
    this.leave("stop");
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    return { running: this.running, url: this.url, provider: this.name };
  }

  getPublicUrl(): string | null {
    return this.url;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    return {
      provider: this.name,
      binaryFound: true,
      binaryPath: "/controlled",
      running: this.running,
      url: this.url,
      problems: [],
    };
  }
}

async function postAdmin(bridge: Bridge, route: string): Promise<Response> {
  return fetch(`${bridge.localBaseUrl()}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.adminToken}` },
  });
}

describe("bridge tunnel serialization", () => {
  let root: string;
  let stateDir: string;
  let previousStateDir: string | undefined;
  let bridge: Bridge | undefined;

  beforeEach(() => {
    previousStateDir = process.env.C2C_STATE_DIR;
    stateDir = isolateStateDir();
    root = makeTmpDir("bridge-tunnel");
    write(root, "README.txt", "controlled tunnel test\n");
  });

  afterEach(async () => {
    try {
      if (bridge) {
        await bridge.close();
        bridge = undefined;
      }
    } finally {
      cleanup(root);
      cleanup(stateDir);
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });

  it("serializes concurrent tunnel starts and reuses the first URL", async () => {
    const tunnel = new ControlledTunnel();
    bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false, tunnelProvider: tunnel });

    const first = postAdmin(bridge, "/admin/tunnel/start");
    await tunnel.startEntered.promise;
    const second = postAdmin(bridge, "/admin/tunnel/start");
    tunnel.startGate.resolve();

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(await firstResponse.json()).toEqual({ url: "https://controlled.example.test" });
    expect(await secondResponse.json()).toEqual({ url: "https://controlled.example.test" });
    expect(tunnel.startCalls).toBe(1);
    expect(tunnel.maxActive).toBe(1);

    tunnel.stopGate.resolve();
  });

  it("waits for an in-flight tunnel operation before closing the bridge", async () => {
    const tunnel = new ControlledTunnel();
    bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false, tunnelProvider: tunnel });

    const startRequest = postAdmin(bridge, "/admin/tunnel/start");
    await tunnel.startEntered.promise;
    const closePromise = bridge.close();
    expect(bridge.close()).toBe(closePromise);
    expect(tunnel.stopCalls).toBe(0);

    tunnel.startGate.resolve();
    const startResponse = await startRequest;
    expect(startResponse.status).toBe(200);
    await tunnel.stopEntered.promise;
    tunnel.stopGate.resolve();
    await closePromise;

    expect(tunnel.events).toEqual(["start-enter", "start-exit", "stop-enter", "stop-exit"]);
    expect(tunnel.maxActive).toBe(1);
  });
});
