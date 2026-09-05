import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { zipSync } from "fflate";

vi.mock("../src/tunnel/openai-secure-hashes.js", () => {
  const assets = [
    "tunnel-client-v0.0.14-darwin-amd64.zip",
    "tunnel-client-v0.0.14-darwin-arm64.zip",
    "tunnel-client-v0.0.14-linux-amd64.zip",
    "tunnel-client-v0.0.14-linux-arm64.zip",
    "tunnel-client-v0.0.14-windows-amd64.zip",
    "tunnel-client-v0.0.14-windows-arm64.zip",
  ];
  return {
    OPENAI_TUNNEL_ARCHIVE_SHA256: Object.freeze(Object.fromEntries(
      assets.map((asset) => [asset, "8c75b978a6908d59aa3310d5380ced453ffa39734d3dcb44b9216b3c40651568"]),
    )),
    OPENAI_TUNNEL_BINARY_SHA256: Object.freeze(Object.fromEntries(
      assets.map((asset) => [asset, "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a"]),
    )),
  };
});

import {
  OPENAI_TUNNEL_ARCHIVE_SHA256,
  OPENAI_TUNNEL_BINARY_SHA256,
  OPENAI_TUNNEL_CLIENT_VERSION,
  OPENAI_TUNNEL_RELEASE_BASE,
  connectOpenAiTunnel,
  createOpenAiTunnelConfig,
  doctorOpenAiTunnel,
  installOpenAiRuntimeKey,
  installOpenAiRuntimeKeyBytes,
  installOpenAiTunnelClient,
  minimalTunnelEnvironment,
  openAiTunnelRuntimeStatusView,
  openAiTunnelBinaryPath,
  openAiTunnelManifestPath,
  openAiTunnelPlatformAsset,
  parseOpenAiTunnelStatus,
  openAiTunnelStatusMatchesConfig,
  readOpenAiTunnelConfig,
  statusOpenAiTunnel,
  stopOpenAiTunnel,
  type TunnelCommandResult,
  writeOpenAiTunnelConfig,
} from "../src/tunnel/openai-secure.js";
import { verifyAndExtractOpenAiTunnelArchive } from "../src/tunnel/openai-secure-integrity.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const stateRoots: string[] = [];

afterEach(() => {
  while (stateRoots.length) cleanup(stateRoots.pop()!);
});

function makeStateRoot(): string {
  const root = makeTmpDir("openai-tunnel");
  fs.chmodSync(root, 0o700);
  stateRoots.push(root);
  return root;
}

function result(stdout = "", status = 0, stderr = ""): TunnelCommandResult {
  return { status, stdout, stderr };
}

function response(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes, { status });
}

const FIXTURE_MTIME = new Date("1980-01-01T00:00:00Z");

function matchingFixtureArchive(): Uint8Array {
  return zipSync({
    "release/tunnel-client": [new Uint8Array([1, 2, 3, 4]), { mtime: FIXTURE_MTIME }],
  });
}

function prepareManagedRelease(
  stateRoot: string,
  config: ReturnType<typeof createOpenAiTunnelConfig>,
): void {
  const releaseDir = path.dirname(config.binaryPath);
  const root = path.join(stateRoot, "openai-tunnel");
  for (const directory of [root, path.join(root, "bin"), path.join(root, "bin", "releases"), releaseDir]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.chmodSync(directory, 0o700);
  }
  fs.writeFileSync(config.binaryPath, new Uint8Array([1, 2, 3, 4]), { mode: 0o700 });
  fs.chmodSync(config.binaryPath, 0o700);
  const asset = openAiTunnelPlatformAsset(process.platform, process.arch);
  const pointerFile = path.join(root, "bin", "current.json");
  fs.writeFileSync(pointerFile, JSON.stringify({
    version: 1,
    asset,
    archiveSha256: OPENAI_TUNNEL_ARCHIVE_SHA256[asset],
    releaseDir: path.basename(releaseDir),
  }), { mode: 0o600 });
  fs.chmodSync(pointerFile, 0o600);
  const manifestFile = path.join(releaseDir, "tunnel-client-manifest.json");
  fs.writeFileSync(manifestFile, JSON.stringify({
    version: 1,
    tunnelClientVersion: OPENAI_TUNNEL_CLIENT_VERSION,
    asset,
    archiveSha256: OPENAI_TUNNEL_ARCHIVE_SHA256[asset],
    binarySha256: OPENAI_TUNNEL_BINARY_SHA256[asset],
  }), { mode: 0o600 });
  fs.chmodSync(manifestFile, 0o600);
}

describe("OpenAI tunnel release installation", () => {
  it("downloads, verifies, selectively unzips, and checks the pinned version", async () => {
    const stateRoot = makeStateRoot();
    const asset = openAiTunnelPlatformAsset("linux", "x64");
    const archive = matchingFixtureArchive();
    const checksum = createHash("sha256").update(archive).digest("hex");
    const fetchImpl = vi.fn(async () => response(archive));
    const runner = vi.fn(() => result(`${OPENAI_TUNNEL_CLIENT_VERSION}+test-build`));

    const installed = await installOpenAiTunnelClient({
      stateRoot,
      platform: "linux",
      arch: "x64",
      fetchImpl,
      runner,
    });

    expect(installed).toBe(openAiTunnelBinaryPath(stateRoot, "linux", "x64"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(`${OPENAI_TUNNEL_RELEASE_BASE}/${asset}`, expect.any(Object));
    expect(runner).toHaveBeenCalledWith(expect.stringContaining("/releases/"), ["--version"], expect.any(Object));
    expect(fs.statSync(installed).mode & 0o777).toBe(0o700);
  });

  it("rejects an archive that does not match the pinned checksum before writing the binary", async () => {
    const stateRoot = makeStateRoot();
    const archive = zipSync({ "tunnel-client": new Uint8Array([5]) });
    const fetchImpl = vi.fn(async () => response(archive));

    await expect(installOpenAiTunnelClient({ stateRoot, platform: "linux", arch: "x64", fetchImpl })).rejects.toThrow(/checksum mismatch/i);
    expect(fs.existsSync(openAiTunnelBinaryPath(stateRoot, "linux"))).toBe(false);
  });

  it("cancels an oversized streamed download even with missing or false content length", async () => {
    for (const contentLength of [undefined, "1"]) {
      const stateRoot = makeStateRoot();
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(50 * 1024 * 1024));
          controller.enqueue(new Uint8Array(50 * 1024 * 1024));
          controller.enqueue(new Uint8Array(2));
        },
        cancel() {
          cancelled = true;
        },
      });
      const headers = contentLength === undefined ? undefined : { "content-length": contentLength };
      const fetchImpl = vi.fn(async () => new Response(stream, headers === undefined ? undefined : { headers }));

      await expect(installOpenAiTunnelClient({
        stateRoot,
        platform: "linux",
        arch: "x64",
        fetchImpl,
      })).rejects.toThrow(/unexpectedly large/i);
      expect(cancelled).toBe(true);
    }
  });

  it("preserves an existing public binary when a replacement download fails", async () => {
    const stateRoot = makeStateRoot();
    const executable = openAiTunnelBinaryPath(stateRoot, "linux", "x64");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.chmodSync(path.join(stateRoot, "openai-tunnel"), 0o700);
    fs.chmodSync(path.join(stateRoot, "openai-tunnel", "bin"), 0o700);
    fs.chmodSync(path.join(stateRoot, "openai-tunnel", "bin", "releases"), 0o700);
    fs.chmodSync(path.dirname(executable), 0o700);
    fs.writeFileSync(executable, "previous-binary", { mode: 0o700 });
    fs.chmodSync(executable, 0o700);
    const archive = zipSync({ "tunnel-client": new Uint8Array([5]) });
    const fetchImpl = vi.fn(async () => response(archive));

    await expect(installOpenAiTunnelClient({ stateRoot, platform: "linux", arch: "x64", fetchImpl })).rejects.toThrow(/integrity/i);
    expect(fs.readFileSync(executable, "utf8")).toBe("previous-binary");
    expect(fs.existsSync(openAiTunnelManifestPath(stateRoot))).toBe(false);
  });

  it("serializes concurrent release checks and publishes one shared installation", async () => {
    const stateRoot = makeStateRoot();
    const asset = openAiTunnelPlatformAsset("linux", "x64");
    const archive = matchingFixtureArchive();
    const checksum = createHash("sha256").update(archive).digest("hex");
    let fetchCalls = 0;
    const fetchImpl = vi.fn(async () => {
      fetchCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return response(archive);
    });
    const runner = vi.fn(() => result(`${OPENAI_TUNNEL_CLIENT_VERSION}+test-build`));

    const [first, second] = await Promise.all([
      installOpenAiTunnelClient({
        stateRoot,
        platform: "linux",
        arch: "x64",
        fetchImpl,
        runner,
      }),
      installOpenAiTunnelClient({
        stateRoot,
        platform: "linux",
        arch: "x64",
        fetchImpl,
        runner,
      }),
    ]);

    expect(first).toBe(second);
    expect(fetchCalls).toBe(1);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(openAiTunnelManifestPath(stateRoot))).toBe(true);
  });

  it("does not publish a release when the binary reports a different version", async () => {
    const stateRoot = makeStateRoot();
    const archive = matchingFixtureArchive();
    const fetchImpl = vi.fn(async () => response(archive));
    await expect(installOpenAiTunnelClient({
      stateRoot,
      platform: "linux",
      arch: "x64",
      fetchImpl,
      runner: vi.fn(() => result("0.0.13")),
    })).rejects.toThrow(/did not report version/i);
    expect(fs.existsSync(openAiTunnelManifestPath(stateRoot))).toBe(false);
    expect(fs.existsSync(openAiTunnelBinaryPath(stateRoot, "linux", "x64"))).toBe(false);
  });

  it("recovers a prepared release after current pointer publication fails", async () => {
    const stateRoot = makeStateRoot();
    const archive = matchingFixtureArchive();
    const fetchImpl = vi.fn(async () => response(archive));
    const runner = vi.fn(() => result(`${OPENAI_TUNNEL_CLIENT_VERSION}+test-build`));
    const originalRenameSync = fs.renameSync;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (String(destination).endsWith(`${path.sep}current.json`)) {
        throw new Error("simulated current pointer publication failure");
      }
      return originalRenameSync(source, destination);
    });

    await expect(installOpenAiTunnelClient({
      stateRoot,
      platform: "linux",
      arch: "x64",
      fetchImpl,
      runner,
    })).rejects.toThrow(/current pointer publication failure/i);
    renameSpy.mockRestore();

    const installed = await installOpenAiTunnelClient({
      stateRoot,
      platform: "linux",
      arch: "x64",
      fetchImpl,
      runner,
    });
    expect(fs.existsSync(installed)).toBe(true);
    expect(fs.existsSync(openAiTunnelManifestPath(stateRoot))).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a ZIP with duplicate target binary entries", async () => {
    const stateRoot = makeStateRoot();
    const archive = zipSync({
      "one/tunnel-client": new Uint8Array([1]),
      "two/tunnel-client": new Uint8Array([2]),
    });
    const checksum = createHash("sha256").update(archive).digest("hex");

    expect(() => verifyAndExtractOpenAiTunnelArchive(
      archive,
      checksum,
      "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
      "tunnel-client",
    )).toThrow(/duplicate/i);
  });

  it("rejects a ZIP bomb before allocating an oversized target entry", async () => {
    const stateRoot = makeStateRoot();
    const archive = zipSync({ "tunnel-client": new Uint8Array(64 * 1024 * 1024 + 1) });
    const checksum = createHash("sha256").update(archive).digest("hex");

    expect(() => verifyAndExtractOpenAiTunnelArchive(
      archive,
      checksum,
      "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
      "tunnel-client",
    )).toThrow(/unexpectedly large/i);
  });

  it("rejects a stored entry whose extracted bytes exceed the final size limit", async () => {
    const stateRoot = makeStateRoot();
    const archive = Buffer.from(zipSync({
      "tunnel-client": [new Uint8Array(64 * 1024 * 1024 + 1), { level: 0 }],
    }));
    const centralHeader = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    const centralOffset = archive.lastIndexOf(centralHeader);
    expect(centralOffset).toBeGreaterThanOrEqual(0);
    archive.writeUInt32LE(1, centralOffset + 24);
    const checksum = createHash("sha256").update(archive).digest("hex");

    expect(() => verifyAndExtractOpenAiTunnelArchive(
      archive,
      checksum,
      "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
      "tunnel-client",
    )).toThrow(/unexpectedly large/i);
  });
});

describe("OpenAI tunnel runtime lifecycle", () => {
  it("parses the pinned 0.0.14 runtime identity fields", () => {
    const config = createOpenAiTunnelConfig({
      stateRoot: makeStateRoot(),
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    });
    const targetValue = `\"${process.execPath}\" \"${config.binaryPath}\" serve-machine`;
    const status = parseOpenAiTunnelStatus(JSON.stringify({
      alias: config.alias,
      tunnel_id: config.tunnelId,
      profile_path: `${config.profileDir}/${config.profileName}.yaml`,
      process_running: true,
      healthy: true,
      ready: true,
      runtime_state: "ready",
      process: {
        profile_path: `${config.profileDir}/${config.profileName}.yaml`,
        tunnel_id: config.tunnelId,
        target_kind: "command",
        target_value: targetValue,
        pid: 42,
      },
    }));

    expect(status).toMatchObject({
      ok: true,
      alias: config.alias,
      tunnelId: config.tunnelId,
      processTunnelId: config.tunnelId,
      profilePath: `${config.profileDir}/${config.profileName}.yaml`,
      processProfilePath: `${config.profileDir}/${config.profileName}.yaml`,
      targetKind: "command",
      targetValue,
      pid: 42,
    });
    expect(openAiTunnelStatusMatchesConfig(config, status, targetValue, 42)).toBe(true);
    expect(openAiTunnelStatusMatchesConfig(config, { ...status, pid: undefined }, targetValue, 42)).toBe(true);
    expect(openAiTunnelStatusMatchesConfig(config, { ...status, pid: 43 }, targetValue, 42)).toBe(false);
    expect(openAiTunnelStatusMatchesConfig(config, { ...status, targetValue: "different" }, targetValue, 42)).toBe(false);
    expect(openAiTunnelRuntimeStatusView({
      ...status,
      targetValue: `${targetValue} --association-nonce ${config.associationNonce}`,
    })).not.toHaveProperty(
      "targetValue",
    );
  });

  it("persists and reloads the tunnel association without exposing its nonce in diagnostics", () => {
    const stateRoot = makeStateRoot();
    const config = createOpenAiTunnelConfig({
      stateRoot,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      associationId: `assoc-${"a".repeat(32)}`,
      associationNonce: "z".repeat(43),
    });
    writeOpenAiTunnelConfig(config, stateRoot);
    expect(readOpenAiTunnelConfig(stateRoot)).toEqual(config);

    const status = parseOpenAiTunnelStatus(
      JSON.stringify({
        process_running: false,
        healthy: false,
        ready: false,
        error: `association ${config.associationNonce} is not active`,
      }),
      0,
      config.associationNonce,
    );
    expect(status.detail).not.toContain(config.associationNonce);
    expect(status.detail).toContain("[redacted-association]");

    const binaryPath = config.binaryPath;
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, "binary", { mode: 0o700 });
    fs.chmodSync(binaryPath, 0o700);
    const doctor = doctorOpenAiTunnel(config, {
      runner: vi.fn(() => result(`unexpected ${config.associationNonce}`, 1)),
    });
    const doctorJson = JSON.stringify(doctor);
    expect(doctorJson).not.toContain(config.associationNonce);
  });

  it("passes only a file reference for the runtime key and requires all readiness flags", () => {
    const stateRoot = makeStateRoot();
    const source = write(stateRoot, "runtime-key.txt", "rk_secret_value_that_must_not_be_passed\n");
    const keyFile = installOpenAiRuntimeKey(source, `${stateRoot}/machine-key`);
    const config = createOpenAiTunnelConfig({
      stateRoot,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: keyFile,
    });
    prepareManagedRelease(stateRoot, config);
    const runner = vi.fn((_command, args: string[]) => {
      if (args[0] === "runtimes" && args[1] === "connect") {
        return result(JSON.stringify({ process_running: true, healthy: true, ready: true }));
      }
      return result();
    });

    const connected = connectOpenAiTunnel(config, "node /private/mcp-server.js", { runner });
    expect(connected.ok).toBe(true);
    const args = runner.mock.calls[0][1] as string[];
    expect(args).toContain("--runtime-api-key");
    expect(args).toContain(`file:${keyFile}`);
    expect(args.join(" ")).not.toContain("rk_secret_value_that_must_not_be_passed");

    const notReady = statusOpenAiTunnel(config, {
      runner: vi.fn(() => result(JSON.stringify({ process_running: true, healthy: true, ready: false }), 0, "diagnostic on stderr")),
    });
    expect(notReady.ok).toBe(false);
    expect(notReady.processRunning && notReady.healthy && notReady.ready).toBe(false);

    const readyWithDiagnostics = statusOpenAiTunnel(config, {
      runner: vi.fn(() => result(JSON.stringify({ process_running: true, healthy: true, ready: true }), 0, "diagnostic on stderr")),
    });
    expect(readyWithDiagnostics.ok).toBe(true);
  });

  it("runs the tunnel client with a minimal environment", () => {
    const stateRoot = makeStateRoot();
    const keyFile = write(stateRoot, "key", "runtime-key");
    fs.chmodSync(keyFile, 0o600);
    const config = createOpenAiTunnelConfig({
      stateRoot,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: keyFile,
    });
    prepareManagedRelease(stateRoot, config);
    const previousApiKey = process.env.OPENAI_API_KEY;
    const previousToken = process.env.GITHUB_TOKEN;
    const previousProxy = process.env.HTTPS_PROXY;
    process.env.OPENAI_API_KEY = "sk-sensitive-test-value";
    process.env.GITHUB_TOKEN = "gh-sensitive-test-value";
    process.env.HTTPS_PROXY = "https://proxy.example.test";
    try {
      const runner = vi.fn((_command, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        expect(options.env).toEqual(expect.objectContaining({
          HOME: expect.any(String),
          PATH: expect.any(String),
          TMPDIR: expect.any(String),
          C2C_STATE_DIR: stateRoot,
          HTTPS_PROXY: "https://proxy.example.test",
        }));
        expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
        expect(options.env).not.toHaveProperty("GITHUB_TOKEN");
        expect(options.env).toMatchObject({
          C2C_ASSOCIATION_ID: config.associationId,
          C2C_ASSOCIATION_NONCE: config.associationNonce,
        });
        return result(JSON.stringify({ process_running: true, healthy: true, ready: true }));
      });

      connectOpenAiTunnel(config, "node server.js", { runner });
      expect(minimalTunnelEnvironment(stateRoot)).not.toHaveProperty("OPENAI_API_KEY");
    } finally {
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
      if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousToken;
      if (previousProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previousProxy;
    }
  });

  it("turns authorization failures into actionable, secret-free errors", () => {
    const stateRoot = makeStateRoot();
    const keyFile = write(stateRoot, "key", "rk_secret_value_that_must_not_be_logged");
    fs.chmodSync(keyFile, 0o600);
    const config = createOpenAiTunnelConfig({
      stateRoot,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: keyFile,
    });
    prepareManagedRelease(stateRoot, config);

    expect(() => connectOpenAiTunnel(config, "node server.js", {
      runner: vi.fn(() => result("remote response 403 forbidden; rk_secret_value_that_must_not_be_logged", 1)),
    })).toThrow(/Tunnels Read \+ Use/);
    const status = statusOpenAiTunnel(config, {
      runner: vi.fn(() => result("401 unauthorized", 1)),
    });
    expect(status.detail).toMatch(/runtime key/i);
    expect(status.detail).not.toContain("rk_secret_value");
  });

  it("never invokes a runner for a symlinked tunnel binary", () => {
    if (process.platform === "win32") return;
    const stateRoot = makeStateRoot();
    const config = createOpenAiTunnelConfig({
      stateRoot,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    });
    prepareManagedRelease(stateRoot, config);
    const outside = write(stateRoot, "outside-tunnel-client", "not the release");
    fs.unlinkSync(config.binaryPath);
    fs.symlinkSync(outside, config.binaryPath);
    const runner = vi.fn(() => result(JSON.stringify({ process_running: true, healthy: true, ready: true })));

    const status = statusOpenAiTunnel(config, { runner });
    expect(status.ok).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects a symlinked config file before parsing or replacing machine state", () => {
    if (process.platform === "win32") return;
    const stateRoot = makeStateRoot();
    const config = createOpenAiTunnelConfig({
      stateRoot,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    });
    writeOpenAiTunnelConfig(config, stateRoot);
    const configFile = path.join(stateRoot, "openai-tunnel", "config.json");
    const outside = write(stateRoot, "outside-config.json", "{}");
    fs.unlinkSync(configFile);
    fs.symlinkSync(outside, configFile);

    expect(() => readOpenAiTunnelConfig(stateRoot)).toThrow(/symbolic link/i);
    expect(fs.readFileSync(outside, "utf8")).toBe("{}");
  });

  it("does not rewrite permissions on ancestors outside the machine state root", () => {
    if (process.platform === "win32") return;
    const parent = makeTmpDir("openai-tunnel-permission-boundary");
    const stateRoot = path.join(parent, "state");
    stateRoots.push(parent);
    fs.chmodSync(parent, 0o755);
    fs.mkdirSync(stateRoot, { mode: 0o700 });
    const config = createOpenAiTunnelConfig({
      stateRoot,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    });

    writeOpenAiTunnelConfig(config, stateRoot);

    expect(fs.statSync(parent).mode & 0o777).toBe(0o755);
    expect(fs.statSync(stateRoot).mode & 0o777).toBe(0o700);
  });

  it("rejects a symlinked machine-state child directory before writing configuration", () => {
    if (process.platform === "win32") return;
    const stateRoot = makeStateRoot();
    const config = createOpenAiTunnelConfig({
      stateRoot,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    });
    const tunnelRoot = path.join(stateRoot, "openai-tunnel");
    const outside = path.join(stateRoot, "outside-tunnel-state");
    fs.rmSync(tunnelRoot, { recursive: true, force: true });
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.chmodSync(outside, 0o700);
    fs.symlinkSync(outside, tunnelRoot, "dir");

    expect(() => writeOpenAiTunnelConfig(config, stateRoot)).toThrow(/symbolic link|unsafe/i);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("rejects a symlinked runtime-key target without modifying its referent", () => {
    if (process.platform === "win32") return;
    const stateRoot = makeStateRoot();
    const destination = path.join(stateRoot, "openai-tunnel", "secrets", "runtime.key");
    const outside = write(stateRoot, "outside-runtime.key", "unchanged");
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(stateRoot, "openai-tunnel"), 0o700);
    fs.chmodSync(path.dirname(destination), 0o700);
    fs.symlinkSync(outside, destination);

    expect(() => installOpenAiRuntimeKeyBytes("replacement", destination)).toThrow(/symbolic link/i);
    expect(fs.readFileSync(outside, "utf8")).toBe("unchanged");
  });

  it("rejects a symlinked profile directory before invoking the tunnel client", () => {
    if (process.platform === "win32") return;
    const stateRoot = makeStateRoot();
    const config = createOpenAiTunnelConfig({
      stateRoot,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    });
    prepareManagedRelease(stateRoot, config);
    installOpenAiRuntimeKeyBytes("runtime-key", config.runtimeKeyFile);
    const outside = path.join(stateRoot, "outside-profile");
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.chmodSync(outside, 0o700);
    fs.symlinkSync(outside, config.profileDir, "dir");
    const runner = vi.fn(() => result(JSON.stringify({ process_running: true, healthy: true, ready: true })));

    expect(() => connectOpenAiTunnel(config, "node server.js", { runner })).toThrow(/symbolic link/i);
    expect(runner).not.toHaveBeenCalled();
  });

  it("reports binary, key, and runtime readiness through doctor", () => {
    const stateRoot = makeStateRoot();
    const keyFile = write(stateRoot, "key", "runtime-key");
    fs.chmodSync(keyFile, 0o600);
    const config = createOpenAiTunnelConfig({
      stateRoot,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: keyFile,
    });
    prepareManagedRelease(stateRoot, config);
    const asset = openAiTunnelPlatformAsset(process.platform, process.arch);
    const manifestFile = openAiTunnelManifestPath(stateRoot);
    const writeManifest = (archiveSha256: string, binarySha256: string) => {
      fs.writeFileSync(manifestFile, JSON.stringify({
        version: 1,
        tunnelClientVersion: OPENAI_TUNNEL_CLIENT_VERSION,
        asset,
        archiveSha256,
        binarySha256,
      }), { mode: 0o600 });
      fs.chmodSync(manifestFile, 0o600);
    };
    const binarySha256 = OPENAI_TUNNEL_BINARY_SHA256[asset];
    writeManifest(OPENAI_TUNNEL_ARCHIVE_SHA256[asset], binarySha256);
    const runner = vi.fn((_command, args: string[]) => args[0] === "--version"
      ? result(`${OPENAI_TUNNEL_CLIENT_VERSION}+test-build`)
      : result(JSON.stringify({ process_running: true, healthy: true, ready: true })));

    const report = doctorOpenAiTunnel(config, { runner });
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual(["config", "binary", "runtime-key", "runtime"]);

    writeManifest("0".repeat(64), binarySha256);
    const tamperedManifest = doctorOpenAiTunnel(config, { runner });
    expect(tamperedManifest.ok).toBe(false);
    expect(tamperedManifest.checks.find((check) => check.id === "binary")?.message).toMatch(/integrity/i);

    writeManifest(OPENAI_TUNNEL_ARCHIVE_SHA256[asset], binarySha256);
    fs.writeFileSync(config.binaryPath, "tampered");
    const tamperedBinary = doctorOpenAiTunnel(config, { runner });
    expect(tamperedBinary.ok).toBe(false);
    expect(tamperedBinary.checks.find((check) => check.id === "binary")?.message).toMatch(/integrity/i);

    writeManifest(OPENAI_TUNNEL_ARCHIVE_SHA256[asset], createHash("sha256").update("tampered").digest("hex"));
    const replacedPair = doctorOpenAiTunnel(config, { runner });
    expect(replacedPair.ok).toBe(false);
    expect(replacedPair.checks.find((check) => check.id === "binary")?.message).toMatch(/integrity/i);

    fs.writeFileSync(config.binaryPath, new Uint8Array([1, 2, 3, 4]), { mode: 0o700 });
    fs.chmodSync(config.binaryPath, 0o700);
    writeManifest(OPENAI_TUNNEL_ARCHIVE_SHA256[asset], binarySha256);
    const stopped = stopOpenAiTunnel(config, { runner: vi.fn(() => result("not running", 1)) });
    expect(stopped.stopped).toBe(true);
  });
});
