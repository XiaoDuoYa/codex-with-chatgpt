import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { findBinary } from "../src/tunnel/detect.js";
import {
  CloudflaredQuickTunnel,
  parseQuickTunnelUrl,
  quickTunnelHealthCheckTimeoutMs,
  quickTunnelStartTimeoutMs,
  type CloudflaredQuickTunnelOptions,
} from "../src/tunnel/cloudflared.js";
import {
  CloudflaredNamedTunnel,
  namedTunnelStartRequestTimeoutMs,
  namedTunnelStartTimeoutMs,
  normalizeNamedTunnelHostname,
} from "../src/tunnel/cloudflared-named.js";
import { hostnameSlug, parseZoneInput, suggestedNamedHostname } from "../src/tunnel/hostname.js";
import {
  chooseQuickTunnel,
  isBenignRouteError,
  parseCreatedTunnel,
  parseTunnelList,
  provisionNamedTunnel,
  type CloudflaredAccount,
} from "../src/tunnel/named-provision.js";
import { isNamedTunnelReady, needsTunnelChoice, readTunnelState } from "../src/tunnel/state.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const stateDirs: string[] = [];
const previousStateDir = process.env.C2C_STATE_DIR;
const previousCloudflaredPath = process.env.C2C_CLOUDFLARED_PATH;
const QUICK_URL = "https://random-words-here-1234.trycloudflare.com";
type FetchImpl = NonNullable<CloudflaredQuickTunnelOptions["fetchImpl"]>;

class FakeCloudflaredProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

function setupTunnel(fetchImpl: FetchImpl, startTimeoutMs = 1_000, expectedWorkspaceId?: string) {
  const child = new FakeCloudflaredProcess();
  const spawnImpl = vi.fn(() => child as unknown as ChildProcess);
  const tunnel = new CloudflaredQuickTunnel(undefined, "cloudflared", {
    spawnImpl,
    fetchImpl,
    startTimeoutMs,
    expectedWorkspaceId,
  });
  return { child, spawnImpl, tunnel };
}

function announceUrl(child: FakeCloudflaredProcess): void {
  child.stderr.write(`INF ${QUICK_URL}\n`);
}

function healthResponse(workspaceId?: string): Response {
  return new Response(JSON.stringify({ service: "c2c-bridge", status: "ok", workspaceId }), { status: 200 });
}

afterEach(() => {
  while (stateDirs.length) cleanup(stateDirs.pop()!);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
  if (previousCloudflaredPath === undefined) delete process.env.C2C_CLOUDFLARED_PATH;
  else process.env.C2C_CLOUDFLARED_PATH = previousCloudflaredPath;
});

describe("findBinary", () => {
  it("uses C2C_CLOUDFLARED_PATH for an accessible cloudflared executable", () => {
    const dir = makeTmpDir("cloudflared-path");
    stateDirs.push(dir);
    const filename = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
    const configured = write(dir, filename, "placeholder");
    if (process.platform !== "win32") fs.chmodSync(configured, 0o755);
    process.env.C2C_CLOUDFLARED_PATH = configured;
    expect(findBinary("cloudflared")).toBe(configured);
  });
});

describe("parseQuickTunnelUrl", () => {
  it("extracts the URL from cloudflared banner output", () => {
    const line =
      "2026-08-28T10:00:00Z INF |  https://random-words-here-1234.trycloudflare.com                              |";
    expect(parseQuickTunnelUrl(line)).toBe(QUICK_URL);
  });

  it("ignores unrelated lines and non-Quick-Tunnel hosts", () => {
    expect(parseQuickTunnelUrl("INF Starting tunnel connection")).toBeNull();
    expect(parseQuickTunnelUrl("visit https://www.cloudflare.com for docs")).toBeNull();
    expect(parseQuickTunnelUrl("https://evil.example.com/trycloudflare.com")).toBeNull();
  });

  it("rejects Cloudflare's API host", () => {
    expect(parseQuickTunnelUrl("INF https://api.trycloudflare.com")).toBeNull();
  });
});

describe("quickTunnelStartTimeoutMs", () => {
  it("accepts a bounded C2C-specific timeout", () => {
    expect(quickTunnelStartTimeoutMs("85000")).toBe(85_000);
  });

  it("falls back for invalid or excessive values", () => {
    expect(quickTunnelStartTimeoutMs("invalid")).toBe(45_000);
    expect(quickTunnelStartTimeoutMs("120000")).toBe(45_000);
  });
});

describe("quickTunnelHealthCheckTimeoutMs", () => {
  it("accepts a bounded C2C-specific timeout", () => {
    expect(quickTunnelHealthCheckTimeoutMs("15000")).toBe(15_000);
  });

  it("falls back for invalid or excessive values", () => {
    expect(quickTunnelHealthCheckTimeoutMs("invalid")).toBe(5_000);
    expect(quickTunnelHealthCheckTimeoutMs("60000")).toBe(5_000);
  });
});

describe("CloudflaredQuickTunnel", () => {
  it("resolves only after the public health endpoint identifies the bridge", async () => {
    const fetchImpl = vi.fn(async () => healthResponse());
    const { child, spawnImpl, tunnel } = setupTunnel(fetchImpl);
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).resolves.toBe(QUICK_URL);
    expect(spawnImpl).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "--url", "http://127.0.0.1:3333", "--no-autoupdate"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    expect(fetchImpl).toHaveBeenCalledWith(`${QUICK_URL}/health`, {
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(tunnel.status()).toMatchObject({ running: true, url: QUICK_URL });
    await tunnel.stop();
  });

  it("keeps consuming cloudflared errors after the tunnel is ready", async () => {
    const { child, tunnel } = setupTunnel(async () => healthResponse());
    const starting = tunnel.start(3333);
    announceUrl(child);
    await expect(starting).resolves.toBe(QUICK_URL);

    child.stderr.write("ERR runtime connection error\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(tunnel.status().detail).toBe("ERR runtime connection error");
    await tunnel.stop();
  });

  it("does not accept an HTTP 200 response from another service", async () => {
    const { child, tunnel } = setupTunnel(
      async () =>
        new Response(JSON.stringify({ service: "cloudflare", status: "ok" }), { status: 200 }),
      20
    );
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).rejects.toThrow(/timed out/i);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("does not accept a healthy bridge for another workspace", async () => {
    const { child, tunnel } = setupTunnel(async () => healthResponse("workspace-b"), 20, "workspace-a");
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).rejects.toThrow(/timed out/i);
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("does not spawn twice or resolve a stopped pending start", async () => {
    const { child, spawnImpl, tunnel } = setupTunnel(() => new Promise<Response>(() => {}));
    const starting = tunnel.start(3333);
    announceUrl(child);
    await new Promise((resolve) => setImmediate(resolve));

    const concurrent = tunnel.start(3333);
    await tunnel.stop();
    await expect(starting).rejects.toThrow(/stopped/i);
    await expect(concurrent).rejects.toThrow(/stopped/i);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("starts a fresh quick tunnel when restart interrupts an in-flight start", async () => {
    const firstChild = new FakeCloudflaredProcess();
    const secondChild = new FakeCloudflaredProcess();
    const spawnImpl = vi
      .fn()
      .mockReturnValueOnce(firstChild as unknown as ChildProcess)
      .mockReturnValueOnce(secondChild as unknown as ChildProcess);
    const tunnel = new CloudflaredQuickTunnel(undefined, "cloudflared", {
      spawnImpl,
      fetchImpl: async () => healthResponse(),
      startTimeoutMs: 1_000,
    });

    const first = tunnel.start(3333);
    const firstRejected = expect(first).rejects.toThrow(/stopped/i);
    const restarted = tunnel.restart(4444);
    await firstRejected;
    await new Promise((resolve) => setImmediate(resolve));
    announceUrl(secondChild);

    await expect(restarted).resolves.toBe(QUICK_URL);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(firstChild.kill).toHaveBeenCalledWith("SIGTERM");
    await tunnel.stop();
  });

  it("does not resolve if cloudflared exits while the health probe is in flight", async () => {
    let resolveFetch!: (response: Response) => void;
    const { child, tunnel } = setupTunnel(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve))
    );
    const starting = tunnel.start(3333);
    announceUrl(child);
    await new Promise((resolve) => setImmediate(resolve));

    child.exitCode = 1;
    child.emit("exit", 1, null);
    resolveFetch(healthResponse());
    await expect(starting).rejects.toThrow(/exited/i);
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("rejects when spawning reports an asynchronous error", async () => {
    const { child, tunnel } = setupTunnel(async () => new Response(null));
    const starting = tunnel.start(3333);
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("error", new Error("spawn cloudflared ENOENT"));

    await expect(starting).rejects.toThrow(/ENOENT/i);
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("retries a non-ready health response before resolving", async () => {
    let calls = 0;
    const cancelBody = vi.fn(async () => undefined);
    const { child, tunnel } = setupTunnel(async () => {
      calls += 1;
      return calls === 1
        ? ({ ok: false, status: 503, body: { cancel: cancelBody } } as unknown as Response)
        : healthResponse();
    });
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).resolves.toBe(QUICK_URL);
    expect(calls).toBe(2);
    expect(cancelBody).toHaveBeenCalledTimes(1);
    await tunnel.stop();
  });
});

describe("normalizeNamedTunnelHostname", () => {
  it("normalizes a valid hostname", () => {
    expect(normalizeNamedTunnelHostname("Dev.GetRemi.xyz.")).toBe("dev.getremi.xyz");
  });

  it("rejects URLs and invalid hostnames", () => {
    expect(() => normalizeNamedTunnelHostname("https://dev.getremi.xyz")).toThrow(/invalid/i);
    expect(() => normalizeNamedTunnelHostname("localhost")).toThrow(/invalid/i);
  });
});

describe("namedTunnelStartTimeoutMs", () => {
  it("accepts a bounded C2C-specific timeout", () => {
    expect(namedTunnelStartTimeoutMs("90000")).toBe(90_000);
  });

  it("falls back for invalid or excessive values", () => {
    expect(namedTunnelStartTimeoutMs("invalid")).toBe(45_000);
    expect(namedTunnelStartTimeoutMs("120001")).toBe(45_000);
  });

  it("keeps the admin request alive beyond the tunnel startup timeout", () => {
    expect(namedTunnelStartRequestTimeoutMs("90000")).toBe(95_000);
    expect(namedTunnelStartRequestTimeoutMs("120000")).toBe(125_000);
  });
});

describe("CloudflaredNamedTunnel", () => {
  it("reuses an in-flight named tunnel start", async () => {
    const child = new FakeCloudflaredProcess();
    const spawnImpl = vi.fn(() => child as unknown as ChildProcess);
    const fetchImpl = vi.fn(async () => healthResponse());
    const tunnel = new CloudflaredNamedTunnel({
      tunnelName: "c2c-test",
      hostname: "c2c.example.com",
      binaryOverride: "cloudflared",
      startTimeoutMs: 1_000,
      spawnImpl,
      fetchImpl,
    });

    const first = tunnel.start(4444);
    const second = tunnel.start(4444);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    child.stderr.write("ERR edge discovery failed\n");
    child.stderr.write("INF Registered tunnel connection\n");

    await expect(first).resolves.toBe("https://c2c.example.com");
    await expect(second).resolves.toBe("https://c2c.example.com");
    expect(fetchImpl).toHaveBeenCalledWith("https://c2c.example.com/health", {
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(tunnel.status()).toMatchObject({ running: true, url: "https://c2c.example.com" });
    expect(tunnel.status().detail).toBeUndefined();
    await tunnel.stop();
  });

  it("waits through a public 503 before marking a named tunnel ready", async () => {
    const child = new FakeCloudflaredProcess();
    const spawnImpl = vi.fn(() => child as unknown as ChildProcess);
    let calls = 0;
    const tunnel = new CloudflaredNamedTunnel({
      tunnelName: "c2c-test",
      hostname: "c2c.example.com",
      binaryOverride: "cloudflared",
      startTimeoutMs: 1_000,
      spawnImpl,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? new Response(JSON.stringify({ status: "starting" }), { status: 503 })
          : healthResponse();
      },
    });

    const starting = tunnel.start(4444);
    child.stderr.write("INF Registered tunnel connection\n");

    await expect(starting).resolves.toBe("https://c2c.example.com");
    expect(calls).toBe(2);
    expect(tunnel.status()).toMatchObject({ running: true, url: "https://c2c.example.com" });
    await tunnel.stop();
  });

  it("starts a fresh named tunnel when restart interrupts an in-flight start", async () => {
    const firstChild = new FakeCloudflaredProcess();
    const secondChild = new FakeCloudflaredProcess();
    const spawnImpl = vi
      .fn()
      .mockReturnValueOnce(firstChild as unknown as ChildProcess)
      .mockReturnValueOnce(secondChild as unknown as ChildProcess);
    const tunnel = new CloudflaredNamedTunnel({
      tunnelName: "c2c-test",
      hostname: "c2c.example.com",
      binaryOverride: "cloudflared",
      startTimeoutMs: 1_000,
      spawnImpl,
      fetchImpl: async () => healthResponse(),
    });

    const first = tunnel.start(3333);
    const firstRejected = expect(first).rejects.toThrow(/stopped/i);
    const restarted = tunnel.restart(4444);
    await firstRejected;
    await new Promise((resolve) => setImmediate(resolve));
    secondChild.stderr.write("INF Registered tunnel connection\n");

    await expect(restarted).resolves.toBe("https://c2c.example.com");
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(firstChild.kill).toHaveBeenCalledWith("SIGTERM");
    await tunnel.stop();
  });
});

describe("named hostname helpers", () => {
  it("builds a stable c2c-<project>.<zone> hostname", () => {
    expect(suggestedNamedHostname("Example.COM", "My App", "abcdef123456")).toBe("c2c-my-app.example.com");
  });

  it("falls back to the workspace id when the name is not ASCII", () => {
    expect(hostnameSlug("回声", "abcdef123456")).toBe("c2c-ws-abcdef12");
  });

  it("parses a typed domain", () => {
    expect(parseZoneInput("https://Example.com/")).toBe("example.com");
    expect(parseZoneInput("not a domain")).toBeNull();
  });
});

describe("cloudflared output parsers", () => {
  it("reads a tunnel list table", () => {
    const output = `
ID                                   NAME          CREATED
11111111-1111-1111-1111-111111111111 c2c-abc123    2026-08-30
`;
    expect(parseTunnelList(output)).toEqual([
      { id: "11111111-1111-1111-1111-111111111111", name: "c2c-abc123" },
    ]);
  });

  it("reads created-tunnel output", () => {
    expect(
      parseCreatedTunnel(
        "Created tunnel c2c-abc with id 22222222-2222-2222-2222-222222222222",
        "c2c-abc"
      )
    ).toEqual({ id: "22222222-2222-2222-2222-222222222222", name: "c2c-abc" });
  });

  it("treats an existing DNS route as success", () => {
    expect(isBenignRouteError("Failed to add route: record already exists")).toBe(true);
  });
});

describe("tunnel preference state", () => {
  it("asks once, then remembers a quick choice", () => {
    stateDirs.push(isolateStateDir());
    const unset = readTunnelState("ws1");
    expect(needsTunnelChoice(unset)).toBe(true);
    const saved = chooseQuickTunnel("ws1");
    expect(saved.preference).toBe("quick");
    expect(needsTunnelChoice(readTunnelState("ws1"))).toBe(false);
    expect(isNamedTunnelReady(saved)).toBe(false);
  });

  it("provisions a named hostname through the account adapter and stores it outside the project", () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async (name) => ({ id: "33333333-3333-3333-3333-333333333333", name }),
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "abcdef123456",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(false);
      expect(result.state.preference).toBe("named");
      expect(result.state.hostname).toBe("c2c-demo.example.com");
      expect(result.state.tunnelName).toBe("c2c-abcdef123456");
      expect(isNamedTunnelReady(readTunnelState("abcdef123456"))).toBe(true);
    });
  });

  it("falls back to a temporary address when named provisioning fails", () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async () => {
        throw new Error("no zone");
      },
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "ws2",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(true);
      expect(result.state.preference).toBe("quick");
      expect(result.userMessage).toMatch(/临时地址/);
    });
  });
});
