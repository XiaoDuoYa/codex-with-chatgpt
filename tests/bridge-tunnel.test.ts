import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "../src/tunnel/provider.js";
import { cleanup, makeTmpDir } from "./helpers.js";

class AuditedTunnel implements TunnelProvider {
  readonly name = "audited";
  startCalls = 0;
  stopCalls = 0;
  maxConcurrentOperations = 0;
  private concurrentOperations = 0;
  private url: string | null = null;
  private releaseFirstStart: (() => void) | null = null;
  private readonly firstStartGate: Promise<void> | null;

  constructor(
    holdFirstStart = false,
    private readonly failingStarts = new Set<number>()
  ) {
    this.firstStartGate = holdFirstStart
      ? new Promise<void>((resolve) => {
          this.releaseFirstStart = resolve;
        })
      : null;
  }

  release(): void {
    this.releaseFirstStart?.();
    this.releaseFirstStart = null;
  }

  private begin(): void {
    this.concurrentOperations += 1;
    this.maxConcurrentOperations = Math.max(this.maxConcurrentOperations, this.concurrentOperations);
  }

  private end(): void {
    this.concurrentOperations -= 1;
  }

  async start(): Promise<string> {
    this.begin();
    const call = ++this.startCalls;
    try {
      if (call === 1 && this.firstStartGate) await this.firstStartGate;
      if (this.failingStarts.has(call)) throw new Error(`start ${call} failed`);
      this.url = `https://tunnel-${call}.example.com`;
      return this.url;
    } finally {
      this.end();
    }
  }

  async stop(): Promise<void> {
    this.begin();
    try {
      this.stopCalls += 1;
      this.url = null;
    } finally {
      this.end();
    }
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    return { running: this.url !== null, url: this.url, provider: this.name };
  }

  getPublicUrl(): string | null {
    return this.url;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    return {
      provider: this.name,
      binaryFound: true,
      binaryPath: "/fake/cloudflared",
      running: this.url !== null,
      url: this.url,
      problems: [],
    };
  }
}

const roots: string[] = [];
const bridges: Bridge[] = [];

afterEach(async () => {
  while (bridges.length) await bridges.pop()!.close();
  while (roots.length) cleanup(roots.pop()!);
});

async function makeBridge(tunnel: TunnelProvider): Promise<Bridge> {
  const root = makeTmpDir("bridge-tunnel");
  const auth = makeTmpDir("bridge-tunnel-auth");
  roots.push(root, auth);
  const bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(auth, "auth.json"),
    tunnelProvider: tunnel,
  });
  bridges.push(bridge);
  return bridge;
}

async function adminRequest(bridge: Bridge, route: string, method = "POST"): Promise<Response> {
  return fetch(`${bridge.localBaseUrl()}${route}`, {
    method,
    headers: { authorization: `Bearer ${bridge.adminToken}` },
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("bridge tunnel lifecycle", () => {
  it("serializes concurrent start and restart requests", async () => {
    const tunnel = new AuditedTunnel(true);
    const bridge = await makeBridge(tunnel);

    const starting = adminRequest(bridge, "/admin/tunnel/start");
    await waitUntil(() => tunnel.startCalls === 1);
    const restarting = adminRequest(bridge, "/admin/tunnel/restart");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const callsBeforeRelease = tunnel.startCalls;

    tunnel.release();
    const [startResponse, restartResponse] = await Promise.all([starting, restarting]);
    expect(callsBeforeRelease).toBe(1);
    expect(startResponse.status).toBe(200);
    expect(restartResponse.status).toBe(200);
    expect(tunnel.startCalls).toBe(2);
    expect(tunnel.stopCalls).toBe(1);
    expect(tunnel.maxConcurrentOperations).toBe(1);
    expect(bridge.getPublicBaseUrl()).toBe("https://tunnel-2.example.com");
  });

  it("clears the public URL when a restart fails", async () => {
    const tunnel = new AuditedTunnel(false, new Set([2]));
    const bridge = await makeBridge(tunnel);

    expect((await adminRequest(bridge, "/admin/tunnel/start")).status).toBe(200);
    expect(bridge.getPublicBaseUrl()).toBe("https://tunnel-1.example.com");

    const restart = await adminRequest(bridge, "/admin/tunnel/restart");
    expect(restart.status).toBe(500);
    expect(bridge.getPublicBaseUrl()).toBeNull();

    const info = (await (await adminRequest(bridge, "/admin/info", "GET")).json()) as {
      publicUrl: string | null;
      tunnel: TunnelStatus;
    };
    expect(info.publicUrl).toBeNull();
    expect(info.tunnel).toMatchObject({ running: false, url: null });
  });

  it("waits for one serialized shutdown and rejects new tunnel work while closing", async () => {
    const tunnel = new AuditedTunnel(true);
    const bridge = await makeBridge(tunnel);

    const starting = adminRequest(bridge, "/admin/tunnel/start");
    await waitUntil(() => tunnel.startCalls === 1);
    let secondCloseResolved = false;
    const firstClose = bridge.close();
    const secondClose = bridge.close().then(() => {
      secondCloseResolved = true;
    });
    const rejectedStart = await adminRequest(bridge, "/admin/tunnel/start");
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(rejectedStart.status).toBe(503);
    expect(secondCloseResolved).toBe(false);
    expect(tunnel.startCalls).toBe(1);

    tunnel.release();
    expect((await starting).status).toBe(200);
    await Promise.all([firstClose, secondClose]);
    expect(tunnel.stopCalls).toBe(1);
    expect(tunnel.maxConcurrentOperations).toBe(1);
    expect(bridge.getPublicBaseUrl()).toBeNull();
  });
});
