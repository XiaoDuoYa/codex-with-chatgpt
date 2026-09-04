import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { observeMachineRuntime } from "../src/gateway/runtime.js";
import {
  OPENAI_TUNNEL_ARCHIVE_SHA256,
  OPENAI_TUNNEL_BINARY_SHA256,
  OPENAI_TUNNEL_CLIENT_VERSION,
  createOpenAiTunnelConfig,
  openAiTunnelPlatformAsset,
  writeOpenAiTunnelConfig,
} from "../src/tunnel/openai-secure.js";
import { machineMcpCommand } from "../src/process/machine-daemon.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Temp dirs live inside the repo (.tooling/test-tmp) so tests also run in
 * sandboxed environments where the system temp dir is not writable.
 */
export function makeTmpDir(name: string): string {
  const dir = path.join(projectRoot, ".tooling", "test-tmp", `${name}-${randomBytes(4).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

export function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

export function write(dir: string, rel: string, content: string): string {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "c2c-test",
  GIT_AUTHOR_EMAIL: "test@c2c.local",
  GIT_COMMITTER_NAME: "c2c-test",
  GIT_COMMITTER_EMAIL: "test@c2c.local",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

export function git(dir: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

export function makeGitRepo(dir: string): void {
  git(dir, "init", "-b", "main");
  write(dir, "hello.txt", "Hello from Codex with ChatGPT!\n");
  write(dir, "src/index.ts", "export const answer = 42;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial commit");
}

/** Point the persistent state dir at an isolated temp location. */
export function isolateStateDir(): string {
  const dir = makeTmpDir("state");
  process.env.C2C_STATE_DIR = dir;
  return dir;
}

/**
 * Start a loopback gateway with a deterministic fake tunnel status command.
 * CLI tests use this to model the already-owned child of a healthy tunnel
 * without contacting OpenAI or starting a second broker process.
 */
export interface ManagedMachineFixture {
  child: ChildProcess;
  environment: NodeJS.ProcessEnv;
  close(): Promise<void>;
}

export async function startManagedMachineFixture(stateDir: string): Promise<ManagedMachineFixture> {
  const config = createOpenAiTunnelConfig({
    tunnelId: `tunnel_${"1".repeat(32)}`,
    stateRoot: stateDir,
  });
  const profilePath = path.join(config.profileDir, `${config.profileName}.yaml`);
  const status = JSON.stringify({
    alias: config.alias,
    tunnel_id: config.tunnelId,
    profile_path: profilePath,
    process_running: true,
    healthy: true,
    ready: true,
    runtime_state: "ready",
    pid: 0,
    process: {
      profile_path: profilePath,
      tunnel_id: config.tunnelId,
      target_kind: "command",
      target_value: machineMcpCommand(config),
    },
  });
  const binary = [
    "#!/bin/sh",
    `pid=$(sed -n 's/.*"pid": *\\([0-9][0-9]*\\).*/\\1/p' "$C2C_STATE_DIR/runtime/machine.json")`,
    `printf '%s\\n' '${status}' | sed "s/\\\"pid\\\":0/\\\"pid\\\":\${pid:-0}/"`,
    "",
  ].join("\n");
  const asset = openAiTunnelPlatformAsset(process.platform, process.arch);
  const binarySha256 = createHash("sha256").update(binary).digest("hex");
  const releaseDir = path.dirname(config.binaryPath);
  const tunnelRoot = path.join(stateDir, "openai-tunnel");
  for (const directory of [
    tunnelRoot,
    path.join(tunnelRoot, "bin"),
    path.join(tunnelRoot, "bin", "releases"),
    releaseDir,
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  fs.writeFileSync(config.binaryPath, binary, { mode: 0o700 });
  fs.chmodSync(config.binaryPath, 0o700);
  const release = {
    version: 1,
    asset,
    archiveSha256: OPENAI_TUNNEL_ARCHIVE_SHA256[asset],
    releaseDir: path.basename(releaseDir),
  } as const;
  fs.writeFileSync(path.join(tunnelRoot, "bin", "current.json"), JSON.stringify(release), { mode: 0o600 });
  fs.writeFileSync(path.join(releaseDir, "tunnel-client-manifest.json"), JSON.stringify({
    version: 1,
    tunnelClientVersion: OPENAI_TUNNEL_CLIENT_VERSION,
    asset,
    archiveSha256: release.archiveSha256,
    binarySha256,
  }), { mode: 0o600 });
  writeOpenAiTunnelConfig(config, stateDir);

  const loader = pathToFileURL(path.join(projectRoot, "tests", "fixtures", "openai-tunnel-hashes-loader.mjs")).href;
  const environment: NodeJS.ProcessEnv = {
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--experimental-loader=${loader}`].filter(Boolean).join(" "),
    NODE_NO_WARNINGS: "1",
    C2C_TEST_TUNNEL_HASHES_JSON: JSON.stringify({
      archive: OPENAI_TUNNEL_ARCHIVE_SHA256,
      binary: { ...OPENAI_TUNNEL_BINARY_SHA256, [asset]: binarySha256 },
    }),
  };

  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      path.join(projectRoot, "src", "cli", "index.ts"),
      "serve-machine",
      "--stdio",
      "--port",
      "0",
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...environment,
        C2C_STATE_DIR: stateDir,
        C2C_ASSOCIATION_ID: config.associationId,
        C2C_ASSOCIATION_NONCE: config.associationNonce,
      },
      stdio: ["pipe", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_096);
  });

  const deadline = Date.now() + 10_000;
  for (;;) {
    const observation = await observeMachineRuntime();
    if (observation.state === "healthy") break;
    if (child.exitCode !== null) {
      throw new Error(`managed machine fixture exited (${child.exitCode}): ${stderr}`);
    }
    if (Date.now() >= deadline) {
      child.kill("SIGTERM");
      throw new Error(`managed machine fixture did not become healthy: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return {
    child,
    environment,
    async close(): Promise<void> {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await exited;
    },
  };
}

export function pkceVerifierAndChallenge(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
