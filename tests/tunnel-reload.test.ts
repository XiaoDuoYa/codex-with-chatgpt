import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import { startBridge } from "../src/bridge/server.js";
import { clearTunnelConfig, writeTunnelConfig } from "../src/tunnel/config.js";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";

/**
 * Tunnel provider selection and live reload: tunnel.json is authoritative,
 * a failed start/reload leaves truthful state, and a later start can never
 * resurrect a previous provider.
 */
  describe("tunnel reload", () => {
    it("swaps the running provider to the configured one without restarting", async () => {
      const stateDir = isolateStateDir();
      const root = makeTmpDir("reload-ws");
      write(root, "hello.txt", "hello\n");
      const creds = makeTmpDir("reload-creds");
      const credsFile = write(creds, "tunnel-creds.json", "{\"a\":\"b\"}");
      writeTunnelConfig({
        mode: "cloudflare-named",
        publicUrl: "https://c2c.example.com",
        tunnelName: "test-laptop",
        credentialsFile: credsFile,
      });
      const bridge = await startBridge({
        workspaceRoot: root,
        port: 0,
        persistRuntime: false,
        tunnelProvider: {
          name: "fake-initial",
          start: async () => "https://fake.initial",
          stop: async () => undefined,
          restart: async () => "https://fake.initial",
          status: () => ({ running: false, url: null, provider: "fake-initial" }),
          getPublicUrl: () => null,
          doctor: async () => ({
            provider: "fake-initial",
            binaryFound: true,
            binaryPath: null,
            running: false,
            url: null,
            problems: [],
          }),
        },
      });
      try {
        const auth = { authorization: `Bearer ${bridge.adminToken}`, "content-type": "application/json" };
        const infoBefore = (await (
          await fetch(`${bridge.localBaseUrl()}/admin/info`, { headers: auth })
        ).json()) as { tunnel: { provider: string } };
        expect(infoBefore.tunnel.provider).toBe("fake-initial");

        const reload = await fetch(`${bridge.localBaseUrl()}/admin/tunnel/reload`, {
          method: "POST",
          headers: auth,
        });
        expect(reload.status).toBe(200);

        const infoAfter = (await (
          await fetch(`${bridge.localBaseUrl()}/admin/info`, { headers: auth })
        ).json()) as { tunnel: { provider: string } };
        expect(infoAfter.tunnel.provider).toBe("cloudflare-named");
      } finally {
        await bridge.close();
        cleanup(root);
        cleanup(creds);
        void stateDir;
      }
    });

    it("malformed tunnel.json installs the unconfigured provider and reports it", async () => {
      const stateDir = isolateStateDir();
      const root = makeTmpDir("reload-malformed-ws");
      write(root, "hello.txt", "hello\n");
      const bridge = await startBridge({
        workspaceRoot: root,
        port: 0,
        persistRuntime: false,
        tunnelProvider: {
          name: "fake-initial",
          start: async () => "https://fake.initial",
          stop: async () => undefined,
          restart: async () => "https://fake.initial",
          status: () => ({ running: false, url: null, provider: "fake-initial" }),
          getPublicUrl: () => null,
          doctor: async () => ({
            provider: "fake-initial",
            binaryFound: true,
            binaryPath: null,
            running: false,
            url: null,
            problems: [],
          }),
        },
      });
      try {
        const auth = { authorization: `Bearer ${bridge.adminToken}`, "content-type": "application/json" };
        write(stateDir, "tunnel.json", "{ malformed json");
        const reload = await fetch(`${bridge.localBaseUrl()}/admin/tunnel/reload`, {
          method: "POST",
          headers: auth,
        });
        expect(reload.status).toBe(500);
        const info = (await (
          await fetch(`${bridge.localBaseUrl()}/admin/info`, { headers: auth })
        ).json()) as { tunnel: { provider: string; running: boolean } };
        expect(info.tunnel.provider).toBe("unconfigured");
        expect(info.tunnel.running).toBe(false);
        // start attempts surface the same configuration error (500).
        const start = await fetch(`${bridge.localBaseUrl()}/admin/tunnel/start`, {
          method: "POST",
          headers: auth,
        });
        expect(start.status).toBe(500);
      } finally {
        await bridge.close();
        cleanup(root);
        clearTunnelConfig();
        void stateDir;
      }
    });

    it("a failed reload leaves no stale public URL and keeps the state truthful", async () => {
      const stateDir = isolateStateDir();
      const root = makeTmpDir("reload-fail-ws");
      write(root, "hello.txt", "hello\n");
      const bridge = await startBridge({
        workspaceRoot: root,
        port: 0,
        persistRuntime: false,
        tunnelProvider: {
          name: "fake-initial",
          start: async () => "https://fake.initial",
          stop: async () => undefined,
          restart: async () => "https://fake.initial",
          status: () => ({ running: false, url: null, provider: "fake-initial" }),
          getPublicUrl: () => null,
          doctor: async () => ({
            provider: "fake-initial",
            binaryFound: true,
            binaryPath: null,
            running: false,
            url: null,
            problems: [],
          }),
        },
      });
      try {
        const auth = { authorization: `Bearer ${bridge.adminToken}`, "content-type": "application/json" };
        // Bring the fake tunnel up so the reload has a live URL to replace.
        await fetch(`${bridge.localBaseUrl()}/admin/tunnel/start`, { method: "POST", headers: auth });
        // Configure a named tunnel whose replacement cannot possibly start
        // (credentials file does not exist).
        writeTunnelConfig({
          mode: "cloudflare-named",
          publicUrl: "https://c2c.example.com",
          tunnelName: "broken",
          credentialsFile: path.join(stateDir, "missing-creds.json"),
        });
        const reload = await fetch(`${bridge.localBaseUrl()}/admin/tunnel/reload`, {
          method: "POST",
          headers: auth,
        });
        expect(reload.status).toBe(500);

        const info = (await (
          await fetch(`${bridge.localBaseUrl()}/admin/info`, { headers: auth })
        ).json()) as { publicUrl: string | null; tunnel: { running: boolean; provider: string } };
        expect(info.publicUrl).toBeNull(); // no stale old URL advertised
        expect(info.tunnel.running).toBe(false);

        // A later /admin/tunnel/start must not resurrect the old provider or
        // its URL — it re-instantiates from the (broken) current config.
        const start = await fetch(`${bridge.localBaseUrl()}/admin/tunnel/start`, {
          method: "POST",
          headers: auth,
        });
        expect(start.status).toBe(500);
        const infoAfterStart = (await (
          await fetch(`${bridge.localBaseUrl()}/admin/info`, { headers: auth })
        ).json()) as { publicUrl: string | null; tunnel: { running: boolean; url: string | null } };
        expect(infoAfterStart.publicUrl).not.toBe("https://fake.initial");
        expect(infoAfterStart.publicUrl).toBeNull();
        expect(infoAfterStart.tunnel.running).toBe(false);
      } finally {
        await bridge.close();
        cleanup(root);
        clearTunnelConfig();
        void stateDir;
      }
    });
  });
