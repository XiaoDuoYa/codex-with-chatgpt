import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { getStateDir, withFileLockAsync } from "../config/paths.js";
import { OPENAI_TUNNEL_ARCHIVE_SHA256, OPENAI_TUNNEL_BINARY_SHA256 } from "./openai-secure-hashes.js";
import { verifyAndExtractOpenAiTunnelArchive } from "./openai-secure-integrity.js";

export { OPENAI_TUNNEL_ARCHIVE_SHA256, OPENAI_TUNNEL_BINARY_SHA256 } from "./openai-secure-hashes.js";

export const OPENAI_TUNNEL_CLIENT_VERSION = "0.0.14";
export const OPENAI_TUNNEL_RELEASE_BASE =
  `https://github.com/openai/tunnel-client/releases/download/v${OPENAI_TUNNEL_CLIENT_VERSION}`;
export const OPENAI_TUNNEL_ALIAS = "codex-with-chatgpt";
export const OPENAI_CONNECTOR_NAME = "Codex with ChatGPT";
export const OPENAI_TUNNEL_READY_TIMEOUT_MS = 120_000;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_RUNTIME_KEY_BYTES = 64 * 1024;
const OPENAI_TUNNEL_RELEASES_DIR = "releases";
const OPENAI_TUNNEL_CURRENT_POINTER = "current.json";
const OPENAI_TUNNEL_MANIFEST_FILENAME = "tunnel-client-manifest.json";

const tunnelIdSchema = z.string().regex(/^tunnel_[a-f0-9]{32}$/);
const safeNameSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);

export interface OpenAiTunnelConfig {
  version: 1;
  tunnelId: string;
  associationId: string;
  associationNonce: string;
  runtimeKeyFile: string;
  binaryPath: string;
  alias: string;
  profileName: string;
  profileDir: string;
}

interface TunnelCurrentPointer {
  version: 1;
  asset: string;
  archiveSha256: string;
  releaseDir: string;
}

const tunnelCurrentPointerSchema = z.object({
  version: z.literal(1),
  asset: z.string().regex(/^tunnel-client-v0\.0\.14-(?:darwin|linux|windows)-(?:amd64|arm64)\.zip$/),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  releaseDir: z.string().regex(/^[A-Za-z0-9._-]+$/),
}).strict();

const tunnelConfigSchema = z
  .object({
    version: z.literal(1),
    tunnelId: tunnelIdSchema,
    associationId: z.string().regex(/^assoc-[a-f0-9]{32}$/),
    associationNonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    runtimeKeyFile: z.string().min(1).max(4_096),
    binaryPath: z.string().min(1).max(4_096),
    alias: safeNameSchema,
    profileName: safeNameSchema,
    profileDir: z.string().min(1).max(4_096),
  })
  .strict();

export interface TunnelCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface TunnelCommandOptions {
  timeoutMs: number;
  /** The tunnel client must never inherit the caller's credential environment. */
  env?: NodeJS.ProcessEnv;
}

export type TunnelRunner = (
  command: string,
  args: string[],
  options: TunnelCommandOptions,
) => TunnelCommandResult;

export type TunnelFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenAiTunnelDependencies {
  fetchImpl?: TunnelFetch;
  runner?: TunnelRunner;
}

export interface OpenAiTunnelInstallOptions extends OpenAiTunnelDependencies {
  /** Test and packaging override. Defaults to the machine state directory. */
  stateRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  downloadTimeoutMs?: number;
}

const TUNNEL_INSTALL_LOCK_TIMEOUT_MS = 5 * 60_000;
const TUNNEL_INSTALL_LOCK_STALE_MS = 10 * 60_000;

export interface OpenAiTunnelRuntimeStatus {
  ok: boolean;
  processRunning: boolean;
  healthy: boolean;
  ready: boolean;
  state?: string;
  alias?: string;
  tunnelId?: string;
  processTunnelId?: string;
  profilePath?: string;
  processProfilePath?: string;
  targetKind?: string;
  targetValue?: string;
  pid?: number;
  detail: string;
}

/** Public status deliberately omits the command, which contains the nonce. */
export type OpenAiTunnelRuntimeStatusView = Omit<OpenAiTunnelRuntimeStatus, "targetValue">;

export interface OpenAiTunnelStopResult {
  stopped: boolean;
  detail: string;
}

export type OpenAiTunnelCheckStatus = "ok" | "error";

export interface OpenAiTunnelDoctorCheck {
  id: string;
  status: OpenAiTunnelCheckStatus;
  message: string;
  detail?: string;
}

export interface OpenAiTunnelDoctorReport {
  ok: boolean;
  checks: OpenAiTunnelDoctorCheck[];
}

interface TunnelInstallManifest {
  version: 1;
  tunnelClientVersion: string;
  asset: string;
  archiveSha256: string;
  binarySha256: string;
}

function privateDirectory(
  dir: string,
  stateRoot: string,
  platform = process.platform,
): string {
  const absolute = path.resolve(dir);
  const boundary = path.resolve(stateRoot);
  ensurePrivateDirectoryTree(boundary, platform, true);
  ensurePrivateDirectoryTree(absolute, platform, true, boundary);
  return absolute;
}

function ownerMatches(stat: fs.Stats, platform = process.platform): boolean {
  const getuid = process.getuid;
  return platform === "win32" || getuid === undefined || stat.uid === getuid();
}

function lstatIfExists(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertDirectoryEntry(directory: string, platform = process.platform): fs.Stats {
  const stat = lstatIfExists(directory);
  if (!stat) throw new Error(`OpenAI tunnel private directory is missing: ${directory}`);
  if (stat.isSymbolicLink()) throw new Error(`OpenAI tunnel private directory must not be a symbolic link: ${directory}`);
  if (!stat.isDirectory()) throw new Error(`OpenAI tunnel private path is not a directory: ${directory}`);
  if (!ownerMatches(stat, platform)) throw new Error(`OpenAI tunnel private directory has an unexpected owner: ${directory}`);
  if (platform !== "win32" && (stat.mode & 0o777) !== 0o700) {
    throw new Error(`OpenAI tunnel private directory has unsafe permissions: ${directory}`);
  }
  try {
    if (fs.realpathSync.native(directory) !== path.resolve(directory)) {
      throw new Error(`OpenAI tunnel private directory resolves through a symbolic link: ${directory}`);
    }
  } catch (error) {
    if (error instanceof Error && /symbolic link|private directory resolves/.test(error.message)) throw error;
    throw new Error(`OpenAI tunnel private directory cannot be resolved: ${directory}`);
  }
  return stat;
}

/** Create or validate only the machine-owned part of the state path. */
function ensurePrivateDirectoryTree(
  directory: string,
  platform = process.platform,
  create = false,
  boundaryRoot?: string,
): boolean {
  const absolute = path.resolve(directory);
  const boundary = path.resolve(boundaryRoot ?? absolute);
  const relative = path.relative(boundary, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("OpenAI tunnel private path escapes the machine state directory");
  }

  if (boundaryRoot === undefined) {
    const root = path.parse(boundary).root;
    let current = root;
    let created = false;
    for (const segment of path.relative(root, boundary).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let stat = lstatIfExists(current);
      if (!stat) {
        if (!create) return false;
        fs.mkdirSync(current, { mode: 0o700 });
        stat = lstatIfExists(current);
        created = true;
      }
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`OpenAI tunnel private directory is unsafe: ${current}`);
      }
      if (fs.realpathSync.native(current) !== current) {
        throw new Error(`OpenAI tunnel private directory resolves through a symbolic link: ${current}`);
      }
      // Existing ancestors are outside this component's ownership boundary.
      // Validate their type but never rewrite their permissions.
      if (current === boundary || created) {
        if (!ownerMatches(stat, platform)) {
          throw new Error(`OpenAI tunnel private directory has an unexpected owner: ${current}`);
        }
        if (create && platform !== "win32" && (stat.mode & 0o777) !== 0o700) {
          fs.chmodSync(current, 0o700);
        }
      }
    }
    assertDirectoryEntry(boundary, platform);
  } else {
    if (!ensurePrivateDirectoryTree(boundary, platform, false)) return false;
  }

  let current = boundary;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat = lstatIfExists(current);
    if (!stat) {
      if (!create) return false;
      fs.mkdirSync(current, { mode: 0o700 });
      stat = lstatIfExists(current);
    }
    if (!stat) return false;
    if (create && platform !== "win32" && ownerMatches(stat) && (stat.mode & 0o777) !== 0o700) {
      fs.chmodSync(current, 0o700);
    }
    assertDirectoryEntry(current, platform);
  }
  if (relative === "") assertDirectoryEntry(boundary, platform);
  return true;
}

function stateRootForConfig(config: Pick<OpenAiTunnelConfig, "profileDir">): string {
  return tunnelStateRoot(config.profileDir);
}

function assertPrivateFileTarget(
  file: string,
  mode: 0o600 | 0o700,
  stateRoot: string,
  platform = process.platform,
  allowMissing = false,
): fs.Stats | null {
  const absolute = path.resolve(file);
  const parent = path.dirname(absolute);
  if (!ensurePrivateDirectoryTree(parent, platform, false, stateRoot)) {
    if (allowMissing && !lstatIfExists(parent)) return null;
    throw new Error(`OpenAI tunnel private file parent is missing or unsafe: ${parent}`);
  }
  const stat = lstatIfExists(absolute);
  if (!stat) {
    if (allowMissing) return null;
    throw new Error(`OpenAI tunnel private file is missing: ${absolute}`);
  }
  if (stat.isSymbolicLink()) throw new Error(`OpenAI tunnel private file must not be a symbolic link: ${absolute}`);
  if (!stat.isFile()) throw new Error(`OpenAI tunnel private path is not a regular file: ${absolute}`);
  if (!ownerMatches(stat, platform)) throw new Error(`OpenAI tunnel private file has an unexpected owner: ${absolute}`);
  if (platform !== "win32" && (stat.mode & 0o777) !== mode) {
    throw new Error(`OpenAI tunnel private file has unsafe permissions: ${absolute}`);
  }
  return stat;
}

function readPrivateBytes(
  file: string,
  mode: 0o600 | 0o700,
  stateRoot: string,
  maxBytes = Number.MAX_SAFE_INTEGER,
  platform = process.platform,
): Buffer {
  const before = assertPrivateFileTarget(file, mode, stateRoot, platform);
  if (!before) throw new Error(`OpenAI tunnel private file is missing: ${path.resolve(file)}`);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const fd = fs.openSync(path.resolve(file), fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(fd);
    if (
      opened.isSymbolicLink() || !opened.isFile() || !ownerMatches(opened, platform) ||
      (platform !== "win32" && (opened.mode & 0o777) !== mode) ||
      opened.dev !== before.dev || opened.ino !== before.ino
    ) {
      throw new Error("OpenAI tunnel private file changed during validation");
    }
    if (!Number.isSafeInteger(opened.size) || opened.size < 0 || opened.size > maxBytes) {
      throw new Error("OpenAI tunnel private file is empty or unexpectedly large");
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error("OpenAI tunnel private file changed during read");
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function readPrivateJsonIfExists<T>(file: string, stateRoot: string): T | null {
  const stat = assertPrivateFileTarget(file, 0o600, stateRoot, process.platform, true);
  if (!stat) return null;
  try {
    return JSON.parse(readPrivateBytes(file, 0o600, stateRoot).toString("utf8")) as T;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function absolutePath(value: string): boolean {
  return process.platform === "win32" ? path.win32.isAbsolute(value) : path.isAbsolute(value);
}

function validateConfig(config: OpenAiTunnelConfig): OpenAiTunnelConfig {
  const parsed = tunnelConfigSchema.safeParse(config);
  if (!parsed.success) throw new Error("OpenAI tunnel configuration is invalid");
  if (![parsed.data.runtimeKeyFile, parsed.data.binaryPath, parsed.data.profileDir].every(absolutePath)) {
    throw new Error("OpenAI tunnel configuration paths must be absolute");
  }
  const stateRoot = tunnelStateRoot(parsed.data.profileDir);
  if (path.resolve(parsed.data.profileDir) !== path.resolve(openAiTunnelProfileDir(stateRoot))) {
    throw new Error("OpenAI tunnel profile directory is not machine-owned");
  }
  const runtimeKeyRelative = path.relative(stateRoot, path.resolve(parsed.data.runtimeKeyFile));
  if (!runtimeKeyRelative || runtimeKeyRelative.startsWith("..") || path.isAbsolute(runtimeKeyRelative)) {
    throw new Error("OpenAI tunnel runtime key file is not machine-owned");
  }
  const releasesRoot = path.join(openAiTunnelRoot(stateRoot), "bin", OPENAI_TUNNEL_RELEASES_DIR);
  const relativeBinaryDir = path.relative(releasesRoot, path.dirname(path.resolve(parsed.data.binaryPath)));
  if (!relativeBinaryDir || relativeBinaryDir.startsWith("..") || path.isAbsolute(relativeBinaryDir)) {
    throw new Error("OpenAI tunnel managed binary path is invalid");
  }
  managedTunnelReleaseForBinary(parsed.data.profileDir, parsed.data.binaryPath);
  return parsed.data;
}

export function openAiTunnelRoot(stateRoot = getStateDir()): string {
  return path.join(path.resolve(stateRoot), "openai-tunnel");
}

export function openAiTunnelConfigFile(stateRoot = getStateDir()): string {
  return path.join(openAiTunnelRoot(stateRoot), "config.json");
}

function tunnelReleaseDirName(asset: string, archiveHash: string): string {
  return `${asset.slice(0, -4)}-${archiveHash.slice(0, 16)}`;
}

function tunnelReleaseDir(stateRoot: string, asset: string, archiveHash: string): string {
  return path.join(openAiTunnelRoot(stateRoot), "bin", OPENAI_TUNNEL_RELEASES_DIR, tunnelReleaseDirName(asset, archiveHash));
}

function tunnelCurrentPointerPath(stateRoot: string): string {
  return path.join(openAiTunnelRoot(stateRoot), "bin", OPENAI_TUNNEL_CURRENT_POINTER);
}

function readCurrentPointer(stateRoot: string): TunnelCurrentPointer | null {
  const pointerFile = tunnelCurrentPointerPath(stateRoot);
  ensurePrivateDirectoryTree(stateRoot, process.platform, true);
  if (!ensurePrivateDirectoryTree(openAiTunnelRoot(stateRoot), process.platform, false, stateRoot)) return null;
  const raw = readPrivateJsonIfExists<unknown>(pointerFile, stateRoot);
  if (raw === null) {
    if (lstatIfExists(pointerFile)) throw new Error("OpenAI tunnel current pointer is unreadable or invalid");
    return null;
  }
  const parsed = tunnelCurrentPointerSchema.safeParse(raw);
  if (!parsed.success) throw new Error("OpenAI tunnel current pointer is invalid");
  const expectedArchiveHash = OPENAI_TUNNEL_ARCHIVE_SHA256[parsed.data.asset];
  if (!expectedArchiveHash || parsed.data.archiveSha256 !== expectedArchiveHash || parsed.data.releaseDir !== tunnelReleaseDirName(parsed.data.asset, expectedArchiveHash)) {
    throw new Error("OpenAI tunnel current pointer failed integrity validation");
  }
  return parsed.data;
}

function currentAssetFor(stateRoot: string, platform: NodeJS.Platform, arch: string): { asset: string; archiveSha256: string } {
  const asset = platformAsset(platform, arch);
  return { asset, archiveSha256: OPENAI_TUNNEL_ARCHIVE_SHA256[asset] };
}

export function openAiTunnelBinaryPath(
  stateRoot = getStateDir(),
  platform = process.platform,
  arch = process.arch,
): string {
  const root = path.resolve(stateRoot);
  const { asset, archiveSha256 } = currentAssetFor(root, platform, arch);
  const pointer = readCurrentPointer(root);
  const releaseDir = pointer?.asset === asset
    ? path.join(openAiTunnelRoot(root), "bin", OPENAI_TUNNEL_RELEASES_DIR, pointer.releaseDir)
    : tunnelReleaseDir(root, asset, archiveSha256);
  return path.join(releaseDir, platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
}

export function openAiTunnelManifestPath(stateRoot = getStateDir()): string {
  const root = path.resolve(stateRoot);
  const { asset, archiveSha256 } = currentAssetFor(root, process.platform, process.arch);
  const pointer = readCurrentPointer(root);
  if (pointer) return path.join(openAiTunnelRoot(root), "bin", OPENAI_TUNNEL_RELEASES_DIR, pointer.releaseDir, OPENAI_TUNNEL_MANIFEST_FILENAME);
  return path.join(tunnelReleaseDir(root, asset, archiveSha256), OPENAI_TUNNEL_MANIFEST_FILENAME);
}

interface ManagedTunnelRelease {
  asset: string;
  archiveSha256: string;
  binarySha256: string;
  releaseDir: string;
  binaryPath: string;
  manifestPath: string;
}

function managedTunnelReleaseForBinary(profileDir: string, binaryPath: string): ManagedTunnelRelease | null {
  const stateRoot = tunnelStateRoot(profileDir);
  const releasesRoot = path.join(openAiTunnelRoot(stateRoot), "bin", OPENAI_TUNNEL_RELEASES_DIR);
  const relativeDir = path.relative(releasesRoot, path.dirname(path.resolve(binaryPath)));
  if (!relativeDir || relativeDir.startsWith("..") || path.isAbsolute(relativeDir) || relativeDir.includes(path.sep)) {
    throw new Error("OpenAI tunnel managed binary path is invalid");
  }
  for (const [asset, archiveSha256] of Object.entries(OPENAI_TUNNEL_ARCHIVE_SHA256)) {
    const binaryName = asset.includes("-windows-") ? "tunnel-client.exe" : "tunnel-client";
    if (relativeDir !== tunnelReleaseDirName(asset, archiveSha256) || path.basename(binaryPath) !== binaryName) continue;
    return {
      asset,
      archiveSha256,
      binarySha256: expectedBinarySha256(asset),
      releaseDir: relativeDir,
      binaryPath: path.resolve(binaryPath),
      manifestPath: path.join(path.dirname(path.resolve(binaryPath)), OPENAI_TUNNEL_MANIFEST_FILENAME),
    };
  }
  throw new Error("OpenAI tunnel managed binary path is invalid");
}

export function openAiTunnelRuntimeKeyPath(stateRoot = getStateDir()): string {
  return path.join(openAiTunnelRoot(stateRoot), "secrets", "runtime.key");
}

export function openAiTunnelProfileDir(stateRoot = getStateDir()): string {
  return path.join(openAiTunnelRoot(stateRoot), "profiles");
}

export function createOpenAiTunnelConfig(options: {
  tunnelId: string;
  stateRoot?: string;
  associationId?: string;
  associationNonce?: string;
  runtimeKeyFile?: string;
  binaryPath?: string;
  alias?: string;
  profileName?: string;
  profileDir?: string;
}): OpenAiTunnelConfig {
  const stateRoot = options.stateRoot ?? getStateDir();
  return validateConfig({
    version: 1,
    tunnelId: options.tunnelId,
    associationId: options.associationId ?? `assoc-${randomUUID().replaceAll("-", "")}`,
    associationNonce: options.associationNonce ?? randomBytes(32).toString("base64url"),
    runtimeKeyFile: options.runtimeKeyFile ?? openAiTunnelRuntimeKeyPath(stateRoot),
    binaryPath: options.binaryPath ?? openAiTunnelBinaryPath(stateRoot),
    alias: options.alias ?? OPENAI_TUNNEL_ALIAS,
    profileName: options.profileName ?? OPENAI_TUNNEL_ALIAS,
    profileDir: options.profileDir ?? openAiTunnelProfileDir(stateRoot),
  });
}

export function writeOpenAiTunnelConfig(config: OpenAiTunnelConfig, stateRoot = getStateDir()): void {
  const parsed = validateConfig(config);
  const root = path.resolve(stateRoot);
  if (stateRootForConfig(parsed) !== root) {
    throw new Error("OpenAI tunnel configuration does not belong to this machine state root");
  }
  const file = openAiTunnelConfigFile(root);
  privateDirectory(path.dirname(file), root);
  assertPrivateFileTarget(file, 0o600, root, process.platform, true);
  atomicPrivateFile(file, Buffer.from(JSON.stringify(parsed, null, 2)), 0o600, process.platform, root);
}

export function readOpenAiTunnelConfig(stateRoot = getStateDir()): OpenAiTunnelConfig | null {
  const file = openAiTunnelConfigFile(stateRoot);
  if (!ensurePrivateDirectoryTree(openAiTunnelRoot(stateRoot), process.platform, false, stateRoot)) return null;
  const raw = readPrivateJsonIfExists<unknown>(file, stateRoot);
  if (raw === null) {
    if (lstatIfExists(file)) throw new Error("OpenAI tunnel configuration is unreadable or invalid");
    return null;
  }
  return validateConfig(raw as OpenAiTunnelConfig);
}

function stateRootForPrivateTarget(file: string): string {
  const absolute = path.resolve(file);
  const marker = `${path.sep}openai-tunnel${path.sep}`;
  const markerIndex = absolute.lastIndexOf(marker);
  return markerIndex >= 0 ? absolute.slice(0, markerIndex) : path.dirname(absolute);
}

function atomicPrivateFile(
  file: string,
  bytes: Uint8Array,
  mode: 0o600 | 0o700,
  platform = process.platform,
  stateRoot = stateRootForPrivateTarget(file),
): void {
  ensurePrivateDirectoryTree(path.dirname(file), platform, true, stateRoot);
  const parent = path.resolve(path.dirname(file));
  const parentBefore = assertDirectoryEntry(parent, platform);
  const temporary = path.join(parent, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    if (platform !== "win32") fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    const staged = fs.fstatSync(fd);
    if (!staged.isFile() || !ownerMatches(staged, platform)) {
      throw new Error("OpenAI tunnel private temporary file is unsafe");
    }
    fs.closeSync(fd);
    fd = null;
    ensurePrivateDirectoryTree(parent, platform, false, stateRoot);
    const parentAfter = assertDirectoryEntry(parent, platform);
    if (parentBefore.dev !== parentAfter.dev || parentBefore.ino !== parentAfter.ino) {
      throw new Error("OpenAI tunnel private file parent changed during publication");
    }
    const existing = lstatIfExists(file);
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new Error(`OpenAI tunnel private file target is unsafe: ${path.resolve(file)}`);
    }
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the publication failure.
      }
    }
    fs.rmSync(temporary, { force: true });
  }
}

function writePrivateJson(
  file: string,
  value: unknown,
  stateRoot: string,
  platform = process.platform,
): void {
  atomicPrivateFile(
    file,
    Buffer.from(JSON.stringify(value, null, 2)),
    0o600,
    platform,
    stateRoot,
  );
}

/** Copy a runtime key into machine-owned storage without exposing its value. */
export function installOpenAiRuntimeKey(sourceFile: string, destination = openAiTunnelRuntimeKeyPath()): string {
  const source = path.resolve(sourceFile);
  const sourceStat = lstatIfExists(source);
  if (!sourceStat || sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error("OpenAI tunnel runtime key source must be a regular file");
  }
  const bytes = fs.readFileSync(source);
  const normalized = Buffer.from(bytes.toString("utf8").trim());
  if (normalized.byteLength === 0 || normalized.byteLength > MAX_RUNTIME_KEY_BYTES) {
    throw new Error("OpenAI tunnel runtime key is empty or unexpectedly large");
  }
  const target = path.resolve(destination);
  const stateRoot = stateRootForPrivateTarget(target);
  ensurePrivateDirectoryTree(path.dirname(target), process.platform, true, stateRoot);
  assertPrivateFileTarget(target, 0o600, stateRoot, process.platform, true);
  atomicPrivateFile(target, normalized, 0o600, process.platform, stateRoot);
  return target;
}

export function installOpenAiRuntimeKeyBytes(
  key: Uint8Array | string,
  destination = openAiTunnelRuntimeKeyPath(),
): string {
  const normalized = typeof key === "string"
    ? Buffer.from(key.trim())
    : Buffer.from(key);
  if (normalized.byteLength === 0 || normalized.byteLength > MAX_RUNTIME_KEY_BYTES) {
    throw new Error("OpenAI tunnel runtime key is empty or unexpectedly large");
  }
  const target = path.resolve(destination);
  const stateRoot = stateRootForPrivateTarget(target);
  ensurePrivateDirectoryTree(path.dirname(target), process.platform, true, stateRoot);
  assertPrivateFileTarget(target, 0o600, stateRoot, process.platform, true);
  atomicPrivateFile(target, normalized, 0o600, process.platform, stateRoot);
  return target;
}

function platformAsset(platform: NodeJS.Platform, arch: string): string {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : null;
  const normalizedArch = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : null;
  if (!os || !normalizedArch) throw new Error(`OpenAI tunnel has no pinned build for ${platform}/${arch}`);
  return `tunnel-client-v${OPENAI_TUNNEL_CLIENT_VERSION}-${os}-${normalizedArch}.zip`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectedArchiveSha256(asset: string): string {
  const pinned = OPENAI_TUNNEL_ARCHIVE_SHA256[asset];
  if (!pinned) throw new Error(`OpenAI tunnel has no pinned archive checksum for ${asset}`);
  return pinned;
}

function expectedBinarySha256(asset: string): string {
  const pinned = OPENAI_TUNNEL_BINARY_SHA256[asset];
  if (!pinned) throw new Error(`OpenAI tunnel has no pinned binary checksum for ${asset}`);
  return pinned;
}

function safeTunnelDetail(value: unknown, secrets: readonly string[] = []): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  let sanitized = text
    .replace(/tunnel_[a-f0-9]{32}/gi, "[tunnel-id]")
    .replace(/\b(?:sk|rk|key)[_-][A-Za-z0-9_-]{12,}\b/gi, "[redacted-key]")
    .replace(/((?:runtime[-_])?api[-_]?key\s*[:=]\s*["']?)[^\s,"']+/gi, "$1[redacted-key]")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .slice(0, 2_000);
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join("[redacted-association]");
  }
  return sanitized;
}

export function sanitizeOpenAiTunnelOutput(value: unknown): string {
  return safeTunnelDetail(value);
}

const TUNNEL_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
] as const;

function tunnelStateRoot(profileDir: string): string {
  return path.dirname(path.dirname(path.resolve(profileDir)));
}

/**
 * Keep the managed tunnel process independent from ambient API keys and
 * session credentials. Proxy and CA settings remain available because they
 * affect transport, not authentication to the tunnel control plane.
 */
export function minimalTunnelEnvironment(stateRoot?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of TUNNEL_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.HOME ??= os.homedir();
  env.PATH ??= process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/local/bin:/usr/bin:/bin";
  const temporaryDirectory = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? os.tmpdir();
  env.TMPDIR ??= temporaryDirectory;
  if (process.platform === "win32") {
    env.TEMP ??= temporaryDirectory;
    env.TMP ??= temporaryDirectory;
  }
  if (stateRoot) env.C2C_STATE_DIR = path.resolve(stateRoot);
  return env;
}

function managedTunnelEnvironment(config: OpenAiTunnelConfig): NodeJS.ProcessEnv {
  const env = minimalTunnelEnvironment(tunnelStateRoot(config.profileDir));
  // These values are inherited only by the tunnel-owned child. They never
  // appear in its command line or in ambient process credentials.
  env.C2C_ASSOCIATION_ID = config.associationId;
  env.C2C_ASSOCIATION_NONCE = config.associationNonce;
  return env;
}

function defaultRunner(command: string, args: string[], options: TunnelCommandOptions): TunnelCommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeoutMs,
    windowsHide: true,
    env: options.env,
  });
  return {
    status: result.status ?? -1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: [typeof result.stderr === "string" ? result.stderr : "", result.error?.message ?? ""].filter(Boolean).join("\n"),
  };
}

function commandOutput(result: TunnelCommandResult): string {
  // JSON mode writes the machine-readable payload to stdout and diagnostics to
  // stderr. Parse stdout alone when it exists; callers separately scan both.
  return result.stdout.trim() || result.stderr.trim();
}

function tunnelClientReportsVersion(output: string): boolean {
  const match = output.trim().match(
    /^(\d+\.\d+\.\d+)(?:\+[0-9A-Za-z.-]+)?(?:\s+\(git sha:\s+[0-9a-f]{40}\))?$/i,
  );
  return match?.[1] === OPENAI_TUNNEL_CLIENT_VERSION;
}

function allCommandOutput(result: TunnelCommandResult): string {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}

function authFailure(output: string): { code: "UNAUTHORIZED" | "FORBIDDEN"; message: string } | null {
  if (/\b401\b|\bunauthori[sz]ed\b/i.test(output)) {
    return {
      code: "UNAUTHORIZED",
      message: "OpenAI tunnel authorization failed (401). Verify the runtime key and tunnel ID, then retry; the key principal needs Tunnels Read + Use.",
    };
  }
  if (/\b403\b|\bforbidden\b|\bpermission denied\b/i.test(output)) {
    return {
      code: "FORBIDDEN",
      message: "OpenAI tunnel permission was denied (403). Grant the runtime key principal Tunnels Read + Use for this tunnel, then retry.",
    };
  }
  return null;
}

export class OpenAiTunnelError extends Error {
  readonly code: "UNAUTHORIZED" | "FORBIDDEN" | "COMMAND_FAILED" | "NOT_READY";

  constructor(code: OpenAiTunnelError["code"], message: string) {
    super(message);
    this.name = "OpenAiTunnelError";
    this.code = code;
  }
}

export function parseOpenAiTunnelStatus(
  output: string,
  exitStatus = 0,
  associationNonce?: string,
): OpenAiTunnelRuntimeStatus {
  const auth = authFailure(output);
  if (auth) {
    return {
      ok: false,
      processRunning: false,
      healthy: false,
      ready: false,
      detail: auth.message,
    };
  }
  if (exitStatus !== 0) {
    return {
      ok: false,
      processRunning: false,
      healthy: false,
      ready: false,
      detail: safeTunnelDetail(output || `tunnel-client exited with status ${exitStatus}`, associationNonce ? [associationNonce] : []),
    };
  }
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const processInfo = parsed.process && typeof parsed.process === "object"
      ? parsed.process as Record<string, unknown>
      : null;
    const processRunning = parsed.process_running === true;
    const healthy = parsed.healthy === true;
    const ready = parsed.ready === true;
    const state = typeof parsed.runtime_state === "string"
      ? parsed.runtime_state
      : typeof parsed.status === "string" ? parsed.status : undefined;
    const detail = processRunning && healthy && ready
      ? "process_running=true healthy=true ready=true"
      : safeTunnelDetail([
          `process_running=${processRunning}`,
          `healthy=${healthy}`,
          `ready=${ready}`,
          ...(state ? [`state=${state}`] : []),
          ...(typeof parsed.error === "string" ? [parsed.error] : []),
          ...(typeof parsed.remote_error === "string" ? [parsed.remote_error] : []),
        ].join("; "), associationNonce ? [associationNonce] : []);
    const alias = typeof parsed.alias === "string" ? parsed.alias : undefined;
    const tunnelId = typeof parsed.tunnel_id === "string"
      ? parsed.tunnel_id
      : typeof processInfo?.tunnel_id === "string" ? processInfo.tunnel_id : undefined;
    const processTunnelId = typeof processInfo?.tunnel_id === "string" ? processInfo.tunnel_id : undefined;
    const profilePath = typeof parsed.profile_path === "string"
      ? parsed.profile_path
      : typeof processInfo?.profile_path === "string" ? processInfo.profile_path : undefined;
    const processProfilePath = typeof processInfo?.profile_path === "string" ? processInfo.profile_path : undefined;
    const targetKind = typeof processInfo?.target_kind === "string" ? processInfo.target_kind : undefined;
    const targetValue = typeof processInfo?.target_value === "string" ? processInfo.target_value : undefined;
    const rawPid = processInfo?.pid ?? parsed.pid;
    const pid = typeof rawPid === "number" && Number.isSafeInteger(rawPid) && rawPid > 0 ? rawPid : undefined;
    return {
      ok: processRunning && healthy && ready,
      processRunning,
      healthy,
      ready,
      ...(state ? { state } : {}),
      ...(alias ? { alias } : {}),
      ...(tunnelId ? { tunnelId } : {}),
      ...(processTunnelId ? { processTunnelId } : {}),
      ...(profilePath ? { profilePath } : {}),
      ...(processProfilePath ? { processProfilePath } : {}),
      ...(targetKind ? { targetKind } : {}),
      ...(targetValue ? { targetValue } : {}),
      ...(pid ? { pid } : {}),
      detail,
    };
  } catch {
    return {
      ok: false,
      processRunning: false,
      healthy: false,
      ready: false,
      detail: `tunnel-client returned non-JSON status: ${safeTunnelDetail(output, associationNonce ? [associationNonce] : [])}`,
    };
  }
}

function requireRuntimeKey(config: OpenAiTunnelConfig): void {
  const stateRoot = stateRootForConfig(config);
  const key = readPrivateBytes(config.runtimeKeyFile, 0o600, stateRoot, MAX_RUNTIME_KEY_BYTES);
  if (key.byteLength === 0 || key.byteLength > MAX_RUNTIME_KEY_BYTES) {
    throw new Error("OpenAI tunnel runtime key file is empty or unexpectedly large");
  }
}

function mcpCommandValue(mcpCommand: string): string {
  const value = mcpCommand.trim();
  if (!value || /[\r\n]/.test(value) || value.length > 16_384) {
    throw new Error("OpenAI tunnel MCP command must be a non-empty single-line value");
  }
  return value;
}

function connectArgs(config: OpenAiTunnelConfig, mcpCommand: string): string[] {
  return [
    "runtimes", "connect",
    "--alias", config.alias,
    "--profile", config.profileName,
    "--profile-dir", config.profileDir,
    "--tunnel-client-bin", config.binaryPath,
    "--tunnel-id", config.tunnelId,
    "--runtime-api-key", `file:${config.runtimeKeyFile}`,
    "--mcp-command", mcpCommandValue(mcpCommand),
    "--json",
  ];
}

export function connectOpenAiTunnel(
  config: OpenAiTunnelConfig,
  mcpCommand: string,
  dependencies: OpenAiTunnelDependencies = {},
): OpenAiTunnelRuntimeStatus {
  const parsed = validateConfig(config);
  verifyManagedTunnelBinary(parsed);
  requireRuntimeKey(parsed);
  ensurePrivateDirectoryTree(parsed.profileDir, process.platform, true, stateRootForConfig(parsed));
  const runner = dependencies.runner ?? defaultRunner;
  const result = runner(parsed.binaryPath, connectArgs(parsed, mcpCommand), {
    timeoutMs: OPENAI_TUNNEL_READY_TIMEOUT_MS,
    env: managedTunnelEnvironment(parsed),
  });
  const output = commandOutput(result);
  const diagnostics = allCommandOutput(result);
  const auth = authFailure(diagnostics);
  if (auth) throw new OpenAiTunnelError(auth.code, auth.message);
  const status = parseOpenAiTunnelStatus(output, result.status, parsed.associationNonce);
  if (!status.ok) throw new OpenAiTunnelError("NOT_READY", `OpenAI tunnel runtime is not ready: ${status.detail}`);
  return status;
}

export function statusOpenAiTunnel(
  config: OpenAiTunnelConfig,
  dependencies: OpenAiTunnelDependencies = {},
): OpenAiTunnelRuntimeStatus {
  const parsed = validateConfig(config);
  const runner = dependencies.runner ?? defaultRunner;
  try {
    verifyManagedTunnelBinary(parsed);
  } catch (error) {
    return { ok: false, processRunning: false, healthy: false, ready: false, detail: safeTunnelDetail(error instanceof Error ? error.message : error) };
  }
  const result = runner(parsed.binaryPath, ["runtimes", "status", parsed.alias, "--json"], {
    timeoutMs: 10_000,
    env: minimalTunnelEnvironment(tunnelStateRoot(parsed.profileDir)),
  });
  const diagnostics = allCommandOutput(result);
  const auth = authFailure(diagnostics);
  if (auth) return { ok: false, processRunning: false, healthy: false, ready: false, detail: auth.message };
  return parseOpenAiTunnelStatus(commandOutput(result), result.status, parsed.associationNonce);
}

/** Remove the stdio command from user-facing status payloads. */
export function openAiTunnelRuntimeStatusView(
  status: OpenAiTunnelRuntimeStatus | null,
): OpenAiTunnelRuntimeStatusView | null {
  if (!status) return null;
  const { targetValue: _targetValue, ...view } = status;
  return view;
}

/**
 * Match the managed runtime identity independently from readiness. A stopped
 * or degraded process can still be safely stopped when its identity is exact.
 * When both the gateway record and Tunnel status expose a PID, it is part of
 * that proof. The pinned 0.0.14 client may omit the status PID.
 */
export function openAiTunnelIdentityMatchesConfig(
  config: OpenAiTunnelConfig,
  status: OpenAiTunnelRuntimeStatus,
  expectedMcpCommand: string,
  expectedPid?: number,
): boolean {
  const expectedProfilePath = path.join(config.profileDir, `${config.profileName}.yaml`);
  return (
    status.alias === config.alias &&
    status.tunnelId === config.tunnelId &&
    status.processTunnelId === config.tunnelId &&
    status.profilePath === expectedProfilePath &&
    status.processProfilePath === expectedProfilePath &&
    status.targetKind === "command" &&
    status.targetValue === expectedMcpCommand &&
    (expectedPid === undefined || status.pid === undefined || status.pid === expectedPid)
  );
}

/**
 * The 0.0.14 status payload is the only supported proof of the managed
 * runtime's local identity. A healthy flag alone is insufficient because an
 * alias may be stale or point at a different stdio command.
 */
export function openAiTunnelStatusMatchesConfig(
  config: OpenAiTunnelConfig,
  status: OpenAiTunnelRuntimeStatus,
  expectedMcpCommand: string,
  expectedPid?: number,
): boolean {
  return status.ok && openAiTunnelIdentityMatchesConfig(config, status, expectedMcpCommand, expectedPid);
}

export function stopOpenAiTunnel(
  config: OpenAiTunnelConfig,
  dependencies: OpenAiTunnelDependencies = {},
): OpenAiTunnelStopResult {
  const parsed = validateConfig(config);
  verifyManagedTunnelBinary(parsed);
  const runner = dependencies.runner ?? defaultRunner;
  const result = runner(parsed.binaryPath, ["runtimes", "stop", parsed.alias, "--json"], {
    timeoutMs: 15_000,
    env: minimalTunnelEnvironment(tunnelStateRoot(parsed.profileDir)),
  });
  const output = commandOutput(result);
  const diagnostics = allCommandOutput(result);
  const auth = authFailure(diagnostics);
  if (auth) throw new OpenAiTunnelError(auth.code, auth.message);
  if (result.status !== 0 && !/not found|not running|unknown alias|alias[^\r\n]{0,160}is not known/i.test(diagnostics)) {
    throw new OpenAiTunnelError(
      "COMMAND_FAILED",
      `Failed to stop OpenAI tunnel runtime: ${safeTunnelDetail(diagnostics, [parsed.associationNonce])}`
    );
  }
  return { stopped: true, detail: safeTunnelDetail(diagnostics || "stopped", [parsed.associationNonce]) };
}

export function doctorOpenAiTunnel(
  config: OpenAiTunnelConfig,
  dependencies: OpenAiTunnelDependencies = {},
): OpenAiTunnelDoctorReport {
  const checks: OpenAiTunnelDoctorCheck[] = [];
  let parsed: OpenAiTunnelConfig;
  try {
    parsed = validateConfig(config);
    checks.push({ id: "config", status: "ok", message: "Machine tunnel configuration is valid" });
  } catch (error) {
    checks.push({ id: "config", status: "error", message: "Machine tunnel configuration is invalid", detail: safeTunnelDetail(error instanceof Error ? error.message : error) });
    return { ok: false, checks };
  }

  const stateRoot = tunnelStateRoot(parsed.profileDir);
  try {
    verifyManagedTunnelBinary(parsed);
    checks.push({ id: "binary", status: "ok", message: `Pinned OpenAI tunnel-client ${OPENAI_TUNNEL_CLIENT_VERSION} is installed` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({
      id: "binary",
      status: "error",
      message: /missing/.test(message) ? "Pinned OpenAI tunnel-client binary is missing" : "OpenAI tunnel-client manifest or binary integrity validation failed",
      detail: safeTunnelDetail(message),
    });
  }

  try {
    const key = readPrivateBytes(parsed.runtimeKeyFile, 0o600, stateRoot, MAX_RUNTIME_KEY_BYTES);
    checks.push(key.byteLength > 0
      ? { id: "runtime-key", status: "ok", message: "OpenAI tunnel runtime key is stored privately" }
      : { id: "runtime-key", status: "error", message: "OpenAI tunnel runtime key file is empty or unexpectedly large" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({
      id: "runtime-key",
      status: "error",
      message: /missing/.test(message) ? "OpenAI tunnel runtime key file is missing" : "OpenAI tunnel runtime key file cannot be read",
      detail: safeTunnelDetail(message),
    });
  }

  if (checks.every((check) => check.status === "ok")) {
    const status = statusOpenAiTunnel(parsed, dependencies);
    checks.push(status.ok
      ? { id: "runtime", status: "ok", message: "OpenAI tunnel runtime is running, healthy, and ready" }
      : { id: "runtime", status: "error", message: "OpenAI tunnel runtime is not ready", detail: status.detail });
  }
  return { ok: checks.every((check) => check.status === "ok"), checks };
}

async function fetchBytes(fetchImpl: TunnelFetch, url: string, timeoutMs: number): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let abortedForSize = false;
  try {
    const response = await fetchImpl(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok) {
      const auth = authFailure(String(response.status));
      if (auth) throw new OpenAiTunnelError(auth.code, auth.message);
      throw new Error(`OpenAI tunnel download failed (${response.status})`);
    }
    const declaredLength = response.headers.get("content-length");
    const length = declaredLength === null ? undefined : Number(declaredLength);
    if (length !== undefined && Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) {
      abortedForSize = true;
      try {
        await response.body?.cancel();
      } finally {
        controller.abort();
      }
      throw new Error("OpenAI tunnel download is unexpectedly large");
    }
    if (!response.body) throw new Error("OpenAI tunnel download has no response body");

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        if (!chunk || chunk.byteLength === 0) continue;
        total += chunk.byteLength;
        if (total > MAX_DOWNLOAD_BYTES) {
          abortedForSize = true;
          try {
            await reader.cancel("OpenAI tunnel download is unexpectedly large");
          } finally {
            controller.abort();
          }
          throw new Error("OpenAI tunnel download is unexpectedly large");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    if (error instanceof OpenAiTunnelError) throw error;
    if (abortedForSize) throw new Error("OpenAI tunnel download is unexpectedly large");
    if (controller.signal.aborted) throw new Error(`OpenAI tunnel download timed out after ${timeoutMs}ms`);
    const message = error instanceof Error ? error.message : String(error);
    const auth = authFailure(message);
    if (auth) throw new OpenAiTunnelError(auth.code, auth.message);
    throw new Error(`OpenAI tunnel download failed: ${safeTunnelDetail(message)}`);
  } finally {
    clearTimeout(timer);
  }
}

function manifestValid(
  manifest: unknown,
  executable: string,
  manifestFile: string,
  asset: string,
  expectedArchiveHash: string,
  expectedBinaryHash: string,
  stateRoot: string,
  platform = process.platform,
): boolean {
  const parsed = z.object({
    version: z.literal(1),
    tunnelClientVersion: z.literal(OPENAI_TUNNEL_CLIENT_VERSION),
    asset: z.literal(asset),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
    binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().safeParse(manifest);
  if (!parsed.success) return false;
  const releaseDir = path.dirname(executable);
  const expectedReleaseDir = tunnelReleaseDir(stateRoot, asset, expectedArchiveHash);
  if (path.resolve(releaseDir) !== path.resolve(expectedReleaseDir)) return false;
  try {
    if (
      !ensurePrivateDirectoryTree(path.join(openAiTunnelRoot(stateRoot), "bin", OPENAI_TUNNEL_RELEASES_DIR), platform, false, stateRoot) ||
      !ensurePrivateDirectoryTree(releaseDir, platform, false, stateRoot)
    ) return false;
    assertPrivateFileTarget(executable, 0o700, stateRoot, platform);
    assertPrivateFileTarget(manifestFile, 0o600, stateRoot, platform);
  } catch {
    return false;
  }
  if (parsed.data.archiveSha256 !== expectedArchiveHash) return false;
  if (parsed.data.binarySha256 !== expectedBinaryHash) return false;
  try {
    return sha256(new Uint8Array(readPrivateBytes(executable, 0o700, stateRoot, MAX_DOWNLOAD_BYTES, platform))) === parsed.data.binarySha256;
  } catch {
    return false;
  }
}

function verifyManagedTunnelBinary(config: OpenAiTunnelConfig): ManagedTunnelRelease {
  const parsed = validateConfig(config);
  const stateRoot = stateRootForConfig(parsed);
  const release = managedTunnelReleaseForBinary(parsed.profileDir, parsed.binaryPath);
  if (!release) throw new Error("OpenAI tunnel managed binary path is invalid");
  if (release.asset !== platformAsset(process.platform, process.arch)) {
    throw new Error("OpenAI tunnel managed binary is not built for this platform");
  }
  const pointer = readCurrentPointer(stateRoot);
  if (!pointer || pointer.asset !== release.asset || pointer.archiveSha256 !== release.archiveSha256 || pointer.releaseDir !== release.releaseDir) {
    throw new Error("OpenAI tunnel current release pointer is missing or invalid");
  }
  const manifest = readPrivateJsonIfExists<unknown>(release.manifestPath, stateRoot);
  if (!manifestValid(
    manifest,
    release.binaryPath,
    release.manifestPath,
    release.asset,
    release.archiveSha256,
    release.binarySha256,
    stateRoot,
    process.platform,
  )) {
    throw new Error("OpenAI tunnel-client manifest or binary integrity validation failed");
  }
  return release;
}

function verifyManagedExecutableVersion(
  executable: string,
  runner: TunnelRunner,
  stateRoot: string,
  expectedBinaryHash: string,
  platform = process.platform,
): boolean {
  // This helper is called only after the path, manifest, owner, mode and hash
  // have been checked. Revalidate the inode after the command to detect a
  // replacement while the child was starting.
  const before = assertPrivateFileTarget(executable, 0o700, stateRoot, platform);
  if (!before) return false;
  if (sha256(new Uint8Array(readPrivateBytes(executable, 0o700, stateRoot, MAX_DOWNLOAD_BYTES, platform))) !== expectedBinaryHash) {
    return false;
  }
  const version = runner(executable, ["--version"], {
    timeoutMs: 10_000,
    env: minimalTunnelEnvironment(stateRoot),
  });
  const after = assertPrivateFileTarget(executable, 0o700, stateRoot, platform);
  if (before.dev !== after?.dev || before.ino !== after?.ino) return false;
  try {
    return sha256(new Uint8Array(readPrivateBytes(executable, 0o700, stateRoot, MAX_DOWNLOAD_BYTES, platform))) === expectedBinaryHash &&
      version.status === 0 && tunnelClientReportsVersion(commandOutput(version));
  } catch {
    return false;
  }
}

/** Download and install the pinned official OpenAI tunnel-client release. */
export async function installOpenAiTunnelClient(options: OpenAiTunnelInstallOptions = {}): Promise<string> {
  const stateRoot = path.resolve(options.stateRoot ?? getStateDir());
  ensurePrivateDirectoryTree(stateRoot, options.platform ?? process.platform, true);
  const lockDirectory = path.join(stateRoot, "locks");
  ensurePrivateDirectoryTree(lockDirectory, options.platform ?? process.platform, true, stateRoot);
  const lockFile = path.join(lockDirectory, "openai-tunnel-install.lock");
  return withFileLockAsync(lockFile, async () => {
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    const asset = platformAsset(platform, arch);
    const expectedArchiveHash = expectedArchiveSha256(asset);
    const expectedBinaryHash = expectedBinarySha256(asset);
    const expectedName = platform === "win32" ? "tunnel-client.exe" : "tunnel-client";
    const releaseDir = tunnelReleaseDir(stateRoot, asset, expectedArchiveHash);
    const executable = path.join(releaseDir, expectedName);
    const manifestFile = path.join(releaseDir, OPENAI_TUNNEL_MANIFEST_FILENAME);
    const runner = options.runner ?? defaultRunner;
    privateDirectory(openAiTunnelRoot(stateRoot), stateRoot, platform);
    privateDirectory(path.dirname(releaseDir), stateRoot, platform);
    const pointer = readCurrentPointer(stateRoot);
    const pointerReleaseDir = pointer?.asset === asset
      ? path.join(openAiTunnelRoot(stateRoot), "bin", OPENAI_TUNNEL_RELEASES_DIR, pointer.releaseDir)
      : null;
    if (pointerReleaseDir) {
      const pointerExecutable = path.join(pointerReleaseDir, expectedName);
      const pointerManifest = path.join(pointerReleaseDir, OPENAI_TUNNEL_MANIFEST_FILENAME);
      if (manifestValid(
        readPrivateJsonIfExists<unknown>(pointerManifest, stateRoot),
        pointerExecutable,
        pointerManifest,
        asset,
        expectedArchiveHash,
        expectedBinaryHash,
        stateRoot,
        platform,
      ) && verifyManagedExecutableVersion(pointerExecutable, runner, stateRoot, expectedBinaryHash, platform)) return pointerExecutable;
      throw new Error("Existing OpenAI tunnel-client failed integrity validation");
    }

    if (fs.existsSync(releaseDir) || fs.existsSync(executable) || fs.existsSync(manifestFile)) {
      if (manifestValid(
        readPrivateJsonIfExists<unknown>(manifestFile, stateRoot),
        executable,
        manifestFile,
        asset,
        expectedArchiveHash,
        expectedBinaryHash,
        stateRoot,
        platform,
      ) && verifyManagedExecutableVersion(executable, runner, stateRoot, expectedBinaryHash, platform)) {
        writePrivateJson(tunnelCurrentPointerPath(stateRoot), {
          version: 1,
          asset,
          archiveSha256: expectedArchiveHash,
          releaseDir: tunnelReleaseDirName(asset, expectedArchiveHash),
        } satisfies TunnelCurrentPointer, stateRoot, platform);
        return executable;
      }
      throw new Error("Existing OpenAI tunnel-client release failed integrity validation");
    }

    const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    const timeoutMs = options.downloadTimeoutMs ?? OPENAI_TUNNEL_READY_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("OpenAI tunnel download timeout must be a positive integer");
    const archive = await fetchBytes(fetchImpl, `${OPENAI_TUNNEL_RELEASE_BASE}/${asset}`, timeoutMs);
    const binary = verifyAndExtractOpenAiTunnelArchive(
      archive,
      expectedArchiveHash,
      expectedBinaryHash,
      expectedName,
    );
    const stagedRelease = path.join(
      path.dirname(releaseDir),
      `.${path.basename(releaseDir)}.install-${process.pid}-${randomUUID()}`,
    );
    const stagedExecutable = path.join(stagedRelease, expectedName);
    const stagedManifest = path.join(stagedRelease, OPENAI_TUNNEL_MANIFEST_FILENAME);
    try {
      privateDirectory(stagedRelease, stateRoot, platform);
      atomicPrivateFile(stagedExecutable, binary, 0o700, platform);
      const manifest: TunnelInstallManifest = {
        version: 1,
        tunnelClientVersion: OPENAI_TUNNEL_CLIENT_VERSION,
        asset,
        archiveSha256: expectedArchiveHash,
        binarySha256: expectedBinaryHash,
      };
      writePrivateJson(stagedManifest, manifest, stateRoot, platform);

      // Publish the complete release directory first. The pointer is the only
      // mutable public record, so a failed pointer write leaves the old release
      // usable and a later invocation can reconcile this prepared directory.
      let publishedByThisCall = false;
      if (fs.existsSync(releaseDir)) {
        if (!manifestValid(
          readPrivateJsonIfExists<unknown>(manifestFile, stateRoot),
          executable,
          manifestFile,
          asset,
          expectedArchiveHash,
          expectedBinaryHash,
          stateRoot,
          platform,
        )) {
          throw new Error("Existing OpenAI tunnel-client release failed integrity validation");
        }
        fs.rmSync(stagedRelease, { recursive: true, force: true });
      } else {
        fs.renameSync(stagedRelease, releaseDir);
        publishedByThisCall = true;
      }
      if (!manifestValid(
        readPrivateJsonIfExists<unknown>(manifestFile, stateRoot),
        executable,
        manifestFile,
        asset,
        expectedArchiveHash,
        expectedBinaryHash,
        stateRoot,
        platform,
      ) || !verifyManagedExecutableVersion(executable, runner, stateRoot, expectedBinaryHash, platform)) {
        if (publishedByThisCall) fs.rmSync(releaseDir, { recursive: true, force: true });
        throw new Error(`Installed OpenAI tunnel-client did not report version ${OPENAI_TUNNEL_CLIENT_VERSION}`);
      }
      writePrivateJson(tunnelCurrentPointerPath(stateRoot), {
        version: 1,
        asset,
        archiveSha256: expectedArchiveHash,
        releaseDir: tunnelReleaseDirName(asset, expectedArchiveHash),
      } satisfies TunnelCurrentPointer, stateRoot, platform);
      return executable;
    } catch (error) {
      // Only this invocation's private staging directory is cleaned up. A
      // published release is intentionally never rolled back here.
      fs.rmSync(stagedRelease, { recursive: true, force: true });
      throw error;
    }
  }, {
    timeoutMs: TUNNEL_INSTALL_LOCK_TIMEOUT_MS,
    staleMs: TUNNEL_INSTALL_LOCK_STALE_MS,
  });
}

export { platformAsset as openAiTunnelPlatformAsset };
