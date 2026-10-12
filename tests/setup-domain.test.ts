import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chooseQuickTunnel, ProcessCloudflaredAccount, provisionNamedTunnel, type CloudflaredAccount } from "../src/tunnel/named-provision.js";
import { readTunnelState, requiresTunnelRestart, writeTunnelState } from "../src/tunnel/state.js";
import { setupNamedDomain, verifyNamedEndpoint } from "../src/tunnel/setup-domain.js";
import { SERVICE_NAME } from "../src/version.js";
import { cleanup, isolateStateDir } from "./helpers.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawnSync: vi.fn(),
}));

const dirs: string[] = [];
const previousStateDir = process.env.C2C_STATE_DIR;
afterEach(() => {
  vi.resetAllMocks();
  dirs.splice(0).forEach(cleanup);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

const tunnelId = "11111111-1111-4111-8111-111111111111";
function account(): CloudflaredAccount {
  return {
    hasCert: () => true,
    login: vi.fn(),
    listTunnels: async () => [],
    createTunnel: async (name) => ({ id: tunnelId, name }),
    routeDns: vi.fn(),
  };
}

describe("explicit setup domain", () => {
  it("accepts --domain and rejects --no-tunnel before side effects", async () => {
    const { spawnSync: actualSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const result = actualSpawn(process.execPath, ["--import", "tsx", "src/cli/index.ts", "setup", "--domain", "sinojelly.kdns.fr", "--no-tunnel", "--json"], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toMatch(/unknown option/);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: expect.stringContaining("--no-tunnel") });
  });

  it("prepares an exact hostname without persisting or fabricating its zone", async () => {
    dirs.push(isolateStateDir());
    const adapter = account();
    const result = await provisionNamedTunnel({ workspaceId: "ws", workspaceName: "studyos", hostname: "SinoJelly.kdns.fr.", account: adapter, strict: true, persist: false } as any);
    expect(result.state.hostname).toBe("sinojelly.kdns.fr");
    expect(result.state.zone).toBeUndefined();
    expect(adapter.routeDns).toHaveBeenCalledWith(tunnelId, "sinojelly.kdns.fr");
    expect(readTunnelState("ws").preference).toBe("unset");
  });

  it("preserves the previous choice and throws when explicit provisioning fails", async () => {
    dirs.push(isolateStateDir());
    const before = chooseQuickTunnel("ws");
    const adapter = account();
    adapter.routeDns = async () => { throw new Error("DNS_RECORD_CONFLICT"); };
    await expect(provisionNamedTunnel({ workspaceId: "ws", workspaceName: "studyos", hostname: "sinojelly.kdns.fr", account: adapter, strict: true, persist: false } as any)).rejects.toThrow("DNS_RECORD_CONFLICT");
    expect(readTunnelState("ws")).toEqual(before);
  });

  it("does not suppress an existing DNS record error", async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: "", stderr: "record already exists" } as any);
    await expect(new ProcessCloudflaredAccount("cloudflared").routeDns(tunnelId, "sinojelly.kdns.fr")).rejects.toThrow("already exists");
  });

  it("does not mistake a UUID in a failed create command for success", async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: "[]", stderr: "" } as any)
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: `failed creating ${tunnelId}` } as any);
    await expect(new ProcessCloudflaredAccount("cloudflared").createTunnel("c2c-ws")).rejects.toThrow("failed creating");
  });
});

describe("named endpoint verification and commit", () => {
  it("rejects a healthy response belonging to another workspace", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ service: SERVICE_NAME, status: "ok", workspaceId: "other" })));
    await expect(verifyNamedEndpoint("sinojelly.kdns.fr", "ws", fetchImpl, 1)).rejects.toThrow("PUBLIC_ENDPOINT_MISMATCH");
    expect(fetchImpl).toHaveBeenCalledWith("https://sinojelly.kdns.fr/health", expect.objectContaining({ redirect: "error" }));
  });

  it("rejects unavailable public endpoints", async () => {
    await expect(verifyNamedEndpoint("sinojelly.kdns.fr", "ws", async () => new Response("bad gateway", { status: 502 }), 1)).rejects.toThrow("PUBLIC_ENDPOINT_UNREACHABLE");
  });

  it("keeps the previous state until verification and restores a previous live bridge on failure", async () => {
    dirs.push(isolateStateDir());
    const before = chooseQuickTunnel("ws");
    const candidate = { workspaceId: "ws", preference: "named" as const, tunnelId, tunnelName: "c2c-ws", hostname: "sinojelly.kdns.fr" };
    const stop = vi.fn(async () => {});
    const connect = vi.fn(async () => ({ mcpUrl: "https://sinojelly.kdns.fr/mcp" }));
    await expect(setupNamedDomain({ id: "ws", name: "studyos", root: "workspace" }, candidate.hostname, connect, {
      observe: async () => ({ state: "healthy", runtime: {} as any }),
      provision: async () => ({ ok: true, state: candidate, fallback: false }),
      stop,
      verify: async () => { expect(readTunnelState("ws")).toEqual(before); throw new Error("PUBLIC_ENDPOINT_UNREACHABLE"); },
    })).rejects.toThrow("PUBLIC_ENDPOINT_UNREACHABLE");
    expect(stop).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenNthCalledWith(1, candidate);
    expect(connect).toHaveBeenNthCalledWith(2, before);
    expect(readTunnelState("ws")).toEqual(before);
  });

  it("commits the candidate only after verifying the matching public URL", async () => {
    dirs.push(isolateStateDir());
    const candidate = { workspaceId: "ws", preference: "named" as const, tunnelId, tunnelName: "c2c-ws", hostname: "sinojelly.kdns.fr" };
    const verify = vi.fn(async () => { expect(readTunnelState("ws").preference).toBe("unset"); });
    await setupNamedDomain({ id: "ws", name: "studyos", root: "workspace" }, candidate.hostname, async () => ({ mcpUrl: "https://sinojelly.kdns.fr/mcp" }), {
      observe: async () => ({ state: "stopped", runtime: null, reason: "runtime_missing" }),
      provision: async () => ({ ok: true, state: candidate, fallback: false }),
      verify,
    });
    expect(verify).toHaveBeenCalledWith(candidate.hostname, "ws");
    expect(readTunnelState("ws")).toEqual(candidate);
  });

  it("reuses a saved matching hostname without calling the Cloudflare management API", async () => {
    dirs.push(isolateStateDir());
    const saved = writeTunnelState({ workspaceId: "ws", preference: "named", tunnelId, tunnelName: "c2c-ws", hostname: "wealthsail.sinojelly.kdns.fr" });
    const provision = vi.fn(async () => { throw new Error("Cloudflare API returned EOF"); });
    const stop = vi.fn(async () => {});
    const verify = vi.fn(async () => {});
    const connection = await setupNamedDomain({ id: "ws", name: "WealthSail", root: "workspace" }, saved.hostname!, async () => ({ mcpUrl: "https://wealthsail.sinojelly.kdns.fr/mcp" }), {
      observe: async () => ({ state: "healthy", runtime: {} as any }),
      provision, stop, verify,
    });
    expect(connection.mcpUrl).toBe("https://wealthsail.sinojelly.kdns.fr/mcp");
    expect(provision).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledWith(saved.hostname, "ws");
    expect(readTunnelState("ws")).toEqual(saved);
  });
});

describe("reuse a running Bridge", () => {
  it("restarts a quick Bridge when this workspace has a saved named hostname", () => {
    const state = { workspaceId: "ws", preference: "named" as const, tunnelName: "c2c-ws", hostname: "wealthsail.sinojelly.kdns.fr" };
    expect(requiresTunnelRestart(state, "cloudflare-quick", "https://random.trycloudflare.com")).toBe(true);
    expect(requiresTunnelRestart(state, "cloudflare-named", "https://other.sinojelly.kdns.fr")).toBe(true);
    expect(requiresTunnelRestart(state, "cloudflare-named", "https://wealthsail.sinojelly.kdns.fr")).toBe(false);
  });

  it("restarts a named Bridge after the workspace selects a quick tunnel", () => {
    expect(requiresTunnelRestart({ workspaceId: "ws", preference: "quick" }, "cloudflare-named", "https://wealthsail.sinojelly.kdns.fr")).toBe(true);
  });
});
