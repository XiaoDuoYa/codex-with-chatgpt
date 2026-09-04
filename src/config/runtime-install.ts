import { randomUUID } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { getStateDir, withFileLock } from "./paths.js";
import { isolatedGitEnvironment } from "./git-environment.js";
import {
  collectSourceMetadata,
  computeContentDigest,
  readSourceMetadata,
  SOURCE_METADATA_FILENAME,
  writeSourceMetadata,
} from "../update/source-metadata.js";

/** Files that must be present in a deployed runtime before it can be published. */
export const RUNTIME_CRITICAL_FILES = [
  "package.json",
  "bin/c2c.js",
  "dist/cli/index.js",
  "skill/SKILL.md",
  "docs/architecture.md",
  SOURCE_METADATA_FILENAME,
] as const;

/** Source files copied before the production dependency install runs. */
export const RUNTIME_PACKAGE_INPUTS = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "bin",
  "dist",
  "skill",
  "docs",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
] as const;

/** Runtime content whose digest must still match before an installed tree is reused. */
export const RUNTIME_DEPLOYMENT_INPUTS = [
  ...RUNTIME_PACKAGE_INPUTS,
  "node_modules",
] as const;

/** Git-tracked inputs used to rebuild the runtime before it is deployed. */
export const RUNTIME_BUILD_INPUTS = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  ".npmrc",
  "src",
  "bin",
  "skill",
  "docs",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
] as const;

export const RUNTIME_INSTALL_LOCK_TIMEOUT_MS = 5 * 60_000;
export const RUNTIME_INSTALL_LOCK_STALE_MS = 10 * 60_000;
export const RUNTIME_INSTALL_TIMEOUT_MS = 5 * 60_000;
export const RUNTIME_BUILD_TIMEOUT_MS = 10 * 60_000;

export interface RuntimeCommandOptions {
  cwd: string;
  timeoutMs: number;
}

export interface RuntimeCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type RuntimeRunner = (
  command: string,
  args: string[],
  options: RuntimeCommandOptions,
) => RuntimeCommandResult;

export interface RuntimeInstallOptions {
  /** Checkout containing the already-built package. Defaults to this checkout. */
  checkoutRoot?: string;
  /** Machine state directory. Defaults to C2C_STATE_DIR or the platform default. */
  stateRoot?: string;
  /** Direct pnpm executable. Defaults to Corepack invoking the pinned pnpm. */
  pnpmPath?: string;
  /** Corepack executable used when pnpmPath is not supplied. */
  corepackPath?: string;
  /** Home directory used to resolve the machine launcher. */
  homeDir?: string;
  /** Test and packaging override for the current process entrypoint. */
  runningEntryPath?: string;
  timeoutMs?: number;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
  runner?: RuntimeRunner;
}

export interface RuntimeInstallResult {
  installed: true;
  changed: boolean;
  path: string;
  entryPath: string;
  sourceRoot: string;
  packageVersion: string;
  launcherPath: string;
  launcherChanged: boolean;
  commands: RuntimeCommandResult[];
}

export interface RuntimeInstallSnapshot {
  readonly stateRoot: string;
  readonly homeDir: string;
  readonly current: RuntimeCurrentSnapshot;
  readonly launcher: RuntimeLauncherSnapshot;
}

export type RuntimeCurrentSnapshot =
  | { readonly kind: "missing" }
  | { readonly kind: "symlink"; readonly target: string };

export type RuntimeLauncherSnapshot =
  | { readonly kind: "missing" }
  | { readonly kind: "symlink"; readonly target: string }
  | { readonly kind: "file"; readonly bytes: Buffer; readonly mode: number };

const INSTALLATION_DIRECTORY = "installation";
const CURRENT_LINK = "current";
const STAGE_PREFIX = ".stage-";
const BUILD_STAGE_PREFIX = ".build-";
const LOCK_DIRECTORY = "locks";
const LOCK_FILE = "runtime-install.lock";

const moduleCheckoutRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function runtimeInstallationPath(stateRoot: string = getStateDir()): string {
  return path.join(path.resolve(stateRoot), INSTALLATION_DIRECTORY);
}

export function runtimeCurrentPath(stateRoot: string = getStateDir()): string {
  return path.join(runtimeInstallationPath(stateRoot), CURRENT_LINK);
}

export function runtimeEntryPath(stateRoot: string = getStateDir()): string {
  return path.join(runtimeCurrentPath(stateRoot), "bin", "c2c.js");
}

export function runtimeSourceRoot(checkoutRoot?: string): string {
  return path.resolve(checkoutRoot ?? moduleCheckoutRoot);
}

function defaultRunner(command: string, args: string[], options: RuntimeCommandOptions): RuntimeCommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeoutMs,
    windowsHide: true,
  }) as SpawnSyncReturns<string>;
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: [typeof result.stderr === "string" ? result.stderr : "", result.error?.message ?? ""]
      .filter(Boolean)
      .join("\n"),
  };
}

function canonicalPath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function canonicalizeExistingParent(directory: string): string {
  const absolute = path.resolve(directory);
  const missing: string[] = [];
  let existing = absolute;
  for (;;) {
    try {
      fs.lstatSync(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
  return path.join(fs.realpathSync(existing), ...missing);
}

function ensurePrivateDirectory(directory: string): string {
  const absolute = canonicalizeExistingParent(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Runtime install path contains a symlink: ${current}`);
      if (!stat.isDirectory()) throw new Error(`Runtime install path is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      const created = fs.lstatSync(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error(`Runtime install path is unsafe: ${current}`);
      }
    }
  }
  try {
    fs.chmodSync(absolute, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOTSUP" && (error as NodeJS.ErrnoException).code !== "EPERM") {
      throw error;
    }
  }
  return absolute;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function lstatIfExists(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function removePath(file: string): void {
  fs.rmSync(file, { recursive: true, force: true });
}

function assertReplaceablePointer(file: string, label: string): void {
  const stat = lstatIfExists(file);
  if (!stat) return;
  if (!stat.isSymbolicLink() && !stat.isFile()) {
    throw new Error(`${label} must be a regular file or symbolic link: ${file}`);
  }
}

function removePointer(file: string, label: string): void {
  assertReplaceablePointer(file, label);
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function atomicReplaceSymlink(
  file: string,
  target: string,
  label: string,
  type?: fs.symlink.Type,
): void {
  const parent = path.dirname(file);
  const temporary = path.join(parent, `.${path.basename(file)}.rollback-${process.pid}-${randomUUID()}`);
  try {
    fs.symlinkSync(path.relative(parent, target), temporary, type);
    assertReplaceablePointer(file, label);
    fs.renameSync(temporary, file);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function atomicReplaceFile(file: string, bytes: Buffer, mode: number, label: string): void {
  const parent = path.dirname(file);
  const temporary = path.join(parent, `.${path.basename(file)}.rollback-${process.pid}-${randomUUID()}`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    assertReplaceablePointer(file, label);
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the publication failure.
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function copyTree(source: string, target: string): void {
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink()) throw new Error(`Runtime package input cannot be a symlink: ${source}`);
  if (sourceStat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(source)) {
      copyTree(path.join(source, entry), path.join(target, entry));
    }
    try {
      fs.chmodSync(target, sourceStat.mode & 0o777);
    } catch {
      // Best effort on filesystems without chmod semantics.
    }
    return;
  }
  if (!sourceStat.isFile()) throw new Error(`Runtime package input is not a regular file: ${source}`);
  fs.copyFileSync(source, target);
  try {
    fs.chmodSync(target, sourceStat.mode & 0o777);
  } catch {
    // Best effort on filesystems without chmod semantics.
  }
}

function copyPackageInputs(sourceRoot: string, stage: string): void {
  const sourceStat = lstatIfExists(sourceRoot);
  if (!sourceStat || !sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`Runtime package source is not a directory: ${sourceRoot}`);
  }
  for (const relative of RUNTIME_PACKAGE_INPUTS) {
    const source = path.join(sourceRoot, relative);
    const stat = lstatIfExists(source);
    if (!stat && relative === "pnpm-workspace.yaml") continue;
    if (!stat) throw new Error(`Runtime package source is missing: ${relative}`);
    copyTree(source, path.join(stage, relative));
  }
}

interface TrackedSourceEntry {
  relative: string;
  mode: string;
  object: string;
}

function trackedSourceEntries(sourceRoot: string, revision: string): TrackedSourceEntry[] {
  const result = spawnSync("git", ["ls-tree", "-r", "-z", "--full-tree", revision], {
    cwd: sourceRoot,
    encoding: "buffer",
    timeout: 8_000,
    env: isolatedGitEnvironment(),
  });
  if (result.status !== 0) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : "";
    throw new Error(`runtime source is not a Git checkout${detail ? `: ${detail}` : ""}`);
  }
  const output = Buffer.isBuffer(result.stdout)
    ? result.stdout.toString("utf8")
    : typeof result.stdout === "string"
      ? result.stdout
      : "";
  return output
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("\t");
      const metadata = separator >= 0 ? entry.slice(0, separator) : "";
      const relative = separator >= 0 ? entry.slice(separator + 1) : "";
      const [mode, type, object] = metadata.split(" ");
      if (
        type !== "blob" ||
        !["100644", "100755"].includes(mode ?? "") ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(object ?? "")
      ) {
        throw new Error(`Git tracked runtime source is not a regular blob: ${relative || entry}`);
      }
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
        throw new Error(`Git tracked source path is unsafe: ${relative}`);
      }
      return { relative, mode: mode ?? "", object: object! };
    });
}

/** Copy only Git-tracked source files; generated dist output is deliberately excluded. */
function copyTrackedSource(sourceRoot: string, buildStage: string, revision: string): void {
  const sourceStat = lstatIfExists(sourceRoot);
  if (!sourceStat || !sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`Runtime package source is not a directory: ${sourceRoot}`);
  }
  for (const { relative, mode, object } of trackedSourceEntries(sourceRoot, revision)) {
    if (relative === "dist" || relative.startsWith(`dist${path.sep}`) || relative.startsWith("dist/")) continue;
    const target = path.join(buildStage, relative);
    if (!isWithin(buildStage, target)) throw new Error(`Git tracked source path escapes build stage: ${relative}`);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const result = spawnSync("git", ["cat-file", "blob", object], {
      cwd: sourceRoot,
      encoding: "buffer",
      timeout: 8_000,
      maxBuffer: 256 * 1024 * 1024,
      env: isolatedGitEnvironment(),
    });
    if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
      throw new Error(`Unable to read Git-tracked runtime source: ${relative}`);
    }
    fs.writeFileSync(target, result.stdout);
    chmodCopiedPath(target, mode === "100755" ? 0o755 : 0o644);
  }
}

function validateBuildInputs(buildStage: string): void {
  for (const relative of RUNTIME_BUILD_INPUTS) {
    const file = path.join(buildStage, relative);
    const stat = lstatIfExists(file);
    if (!stat && (relative === "pnpm-workspace.yaml" || relative === ".npmrc")) continue;
    if (!stat || stat.isSymbolicLink()) throw new Error(`Runtime build source is missing or unsafe: ${relative}`);
    const expectedDirectory = ["src", "bin", "skill", "docs"].includes(relative);
    if (expectedDirectory ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`Runtime build source has the wrong type: ${relative}`);
    }
  }
}

function runtimePackageManager(options: RuntimeInstallOptions, args: string[]): { command: string; args: string[] } {
  const directPnpm = options.pnpmPath?.trim() || process.env.C2C_PNPM_PATH?.trim();
  const command = directPnpm || options.corepackPath?.trim() || process.env.C2C_COREPACK_PATH?.trim() || "corepack";
  return {
    command,
    args: directPnpm ? args : ["pnpm", ...args],
  };
}

function runRuntimeCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: RuntimeInstallOptions,
  commands: RuntimeCommandResult[],
  failureLabel: string,
): void {
  const result = (options.runner ?? defaultRunner)(command, args, { cwd, timeoutMs });
  commands.push(result);
  if (result.status !== 0) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    throw new Error(`${failureLabel}${detail ? `: ${detail}` : ` (status ${result.status})`}`);
  }
}

function buildRuntimeSource(
  sourceRoot: string,
  buildStage: string,
  revision: string,
  options: RuntimeInstallOptions,
  commands: RuntimeCommandResult[],
): void {
  copyTrackedSource(sourceRoot, buildStage, revision);
  validateBuildInputs(buildStage);
  const packageManager = runtimePackageManager(options, ["install", "--frozen-lockfile", "--ignore-scripts"]);
  runRuntimeCommand(
    packageManager.command,
    packageManager.args,
    buildStage,
    options.timeoutMs ?? RUNTIME_BUILD_TIMEOUT_MS,
    options,
    commands,
    "runtime build dependency install failed",
  );
  const build = runtimePackageManager(options, ["build"]);
  runRuntimeCommand(
    build.command,
    build.args,
    buildStage,
    options.timeoutMs ?? RUNTIME_BUILD_TIMEOUT_MS,
    options,
    commands,
    "runtime source build failed",
  );
}

function chmodCopiedPath(file: string, mode: number): void {
  try {
    fs.chmodSync(file, mode & 0o777);
  } catch {
    // Best effort on filesystems without chmod semantics.
  }
}

/**
 * Copy a checkout dependency tree while resolving pnpm's internal symlinks.
 *
 * A clean HOME has neither pnpm's metadata mirror nor its content-addressable
 * store, but a checkout that was just built already has the exact dependency
 * tree required by the compiled runtime. Keep the copy confined to that
 * checkout's node_modules directory so a malicious dependency link cannot
 * make the machine installation copy arbitrary files.
 */
function copyDereferencedTree(source: string, target: string, root: string, visiting = new Set<string>()): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    const resolved = canonicalPath(source);
    if (!isWithin(root, resolved)) {
      throw new Error(`Runtime dependency link points outside node_modules: ${source}`);
    }
    if (visiting.has(resolved)) {
      throw new Error(`Runtime dependency tree contains a symlink cycle: ${source}`);
    }
    visiting.add(resolved);
    try {
      copyDereferencedTree(resolved, target, root, visiting);
    } finally {
      visiting.delete(resolved);
    }
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(source)) {
      copyDereferencedTree(path.join(source, entry), path.join(target, entry), root, visiting);
    }
    chmodCopiedPath(target, stat.mode);
    return;
  }
  if (!stat.isFile()) throw new Error(`Runtime dependency is not a regular file: ${source}`);
  fs.copyFileSync(source, target);
  chmodCopiedPath(target, stat.mode);
}

function packageDependencyNames(sourceRoot: string): { required: string[]; optional: string[] } {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
  } catch (error) {
    throw new Error(`Runtime source has invalid package.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const manifest = packageJson as {
    dependencies?: Record<string, unknown>;
    optionalDependencies?: Record<string, unknown>;
  };
  const names = (value: Record<string, unknown> | undefined): string[] =>
    Object.keys(value ?? {}).filter((name) => name.trim() !== "").sort();
  const optional = names(manifest.optionalDependencies);
  const optionalSet = new Set(optional);
  return {
    required: names(manifest.dependencies).filter((name) => !optionalSet.has(name)),
    optional,
  };
}

/** Copy only the production dependency closure already materialized by pnpm. */
function bundleProductionDependencies(sourceRoot: string, stage: string): boolean {
  const sourceNodeModules = path.join(sourceRoot, "node_modules");
  const nodeModulesStat = lstatIfExists(sourceNodeModules);
  if (!nodeModulesStat || !nodeModulesStat.isDirectory() || nodeModulesStat.isSymbolicLink()) return false;

  const { required, optional } = packageDependencyNames(sourceRoot);
  const sourceRootCanonical = canonicalPath(sourceNodeModules);
  const available = (name: string): boolean => {
    const dependency = path.join(sourceNodeModules, name);
    const stat = lstatIfExists(dependency);
    return stat !== null && (stat.isDirectory() || stat.isFile() || stat.isSymbolicLink());
  };
  if (required.some((name) => !available(name))) return false;

  const targetNodeModules = path.join(stage, "node_modules");
  fs.mkdirSync(targetNodeModules, { recursive: true, mode: 0o700 });
  for (const name of [...required, ...optional.filter(available)]) {
    copyDereferencedTree(
      path.join(sourceNodeModules, name),
      path.join(targetNodeModules, name),
      sourceRootCanonical,
    );
  }
  return true;
}

function validateRuntimeTree(root: string): { packageVersion: string } {
  const stat = lstatIfExists(root);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Runtime deployment is not a private directory: ${root}`);
  }
  for (const relative of RUNTIME_CRITICAL_FILES) {
    const file = path.join(root, relative);
    const fileStat = lstatIfExists(file);
    if (!fileStat || !fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error(`Runtime deployment is missing critical file: ${relative}`);
    }
  }
  const metadata = readSourceMetadata(root);
  if (!metadata) throw new Error("Runtime deployment has no current content digest");
  const observedDigest = computeContentDigest(root, RUNTIME_DEPLOYMENT_INPUTS);
  if (observedDigest !== metadata.contentDigest) {
    throw new Error("Runtime deployment content digest does not match installed files");
  }
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch (error) {
    throw new Error(`Runtime deployment has invalid package.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const version = (packageJson as { version?: unknown })?.version;
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error("Runtime deployment package.json has no version");
  }
  return { packageVersion: version };
}

function currentTarget(current: string, installation: string): string | null {
  const stat = lstatIfExists(current);
  if (!stat) return null;
  if (stat.isSymbolicLink()) {
    const target = path.resolve(path.dirname(current), fs.readlinkSync(current));
    if (!isWithin(installation, target)) {
      throw new Error(`Runtime current link points outside the installation: ${target}`);
    }
    const targetStat = lstatIfExists(target);
    if (!targetStat || !targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw new Error(`Runtime current link target is not a deployment: ${target}`);
    }
    return target;
  }
  if (stat.isDirectory()) return current;
  throw new Error(`Runtime current path is not a directory or link: ${current}`);
}

function stagePath(installation: string): string {
  return path.join(installation, `${STAGE_PREFIX}${process.pid}-${Date.now()}-${randomUUID()}`);
}

function buildStagePath(installation: string): string {
  return path.join(installation, `${BUILD_STAGE_PREFIX}${process.pid}-${Date.now()}-${randomUUID()}`);
}

function installProductionDependencies(
  sourceRoot: string,
  stage: string,
  options: RuntimeInstallOptions,
  commands: RuntimeCommandResult[],
): void {
  const timeoutMs = options.timeoutMs ?? RUNTIME_INSTALL_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("runtime install timeout must be a positive integer");
  if (bundleProductionDependencies(sourceRoot, stage)) {
    commands.push({
      status: 0,
      stdout: "production dependencies copied from checkout node_modules",
      stderr: "",
    });
    return;
  }
  const packageManager = runtimePackageManager(options, [
    "install",
    "--prod",
    "--offline",
    "--frozen-lockfile",
    "--ignore-scripts",
  ]);
  runRuntimeCommand(
    packageManager.command,
    packageManager.args,
    stage,
    timeoutMs,
    options,
    commands,
    "production dependency install failed",
  );
}

function publishStage(stage: string, current: string, installation: string): void {
  const previous = currentTarget(current, installation);
  const currentStat = lstatIfExists(current);
  const next = path.join(installation, `.current-${process.pid}-${randomUUID()}`);
  const backup = path.join(installation, `.current-backup-${process.pid}-${randomUUID()}`);
  let movedDirectory = false;
  let published = false;
  try {
    fs.symlinkSync(path.relative(installation, stage), next, "dir");
    if (currentStat?.isDirectory() && !currentStat.isSymbolicLink()) {
      fs.renameSync(current, backup);
      movedDirectory = true;
    }
    fs.renameSync(next, current);
    published = true;
  } catch (error) {
    removePath(next);
    if (published) removePath(current);
    if (movedDirectory && lstatIfExists(backup)) {
      fs.renameSync(backup, current);
    } else if (previous && !lstatIfExists(current)) {
      fs.symlinkSync(path.relative(installation, previous), current, "dir");
    }
    throw error;
  }

  // Keep the previous release directory. A process started before this
  // publication may still resolve modules from that directory, and it also
  // gives a later repair command a known rollback target.
}

export function runtimeLauncherPath(homeDir: string = os.homedir()): string {
  return path.join(path.resolve(homeDir), ".local", "bin", "c2c");
}

function ensureLauncherDirectory(directory: string): void {
  const absolute = canonicalizeExistingParent(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = lstatIfExists(current);
    if (stat?.isSymbolicLink()) throw new Error(`Runtime launcher directory contains a symlink: ${current}`);
    if (stat && !stat.isDirectory()) throw new Error(`Runtime launcher path is not a directory: ${current}`);
    if (!stat) fs.mkdirSync(current, { mode: 0o700 });
  }
}

function managedLauncherTarget(
  target: string,
  stateRoot: string,
  sourceRoot: string,
): boolean {
  const resolvedTarget = canonicalPath(target);
  const installation = canonicalPath(runtimeInstallationPath(stateRoot));
  const currentEntry = canonicalPath(runtimeEntryPath(stateRoot));
  const sourceEntry = canonicalPath(path.join(sourceRoot, "bin", "c2c.js"));
  if (resolvedTarget === currentEntry || resolvedTarget === sourceEntry) return true;
  const relative = path.relative(installation, resolvedTarget);
  return relative.endsWith(path.join("bin", "c2c.js")) && isWithin(installation, resolvedTarget);
}

function ensureRuntimeLauncher(
  stateRoot: string,
  sourceRoot: string,
  homeDir: string,
): { path: string; changed: boolean } {
  const launcher = runtimeLauncherPath(homeDir);
  ensureLauncherDirectory(path.dirname(launcher));
  const desired = runtimeEntryPath(stateRoot);
  const existing = lstatIfExists(launcher);
  if (existing && !existing.isSymbolicLink()) {
    throw new Error(`Runtime launcher path is already occupied by an unmanaged file: ${launcher}`);
  }
  if (existing) {
    const target = path.resolve(path.dirname(launcher), fs.readlinkSync(launcher));
    if (!managedLauncherTarget(target, stateRoot, sourceRoot)) {
      throw new Error(`Runtime launcher is an unmanaged symlink: ${launcher} -> ${target}`);
    }
    if (canonicalPath(target) === canonicalPath(desired)) return { path: launcher, changed: false };
  }

  const next = `${launcher}.next-${process.pid}-${randomUUID()}`;
  try {
    fs.symlinkSync(path.relative(path.dirname(launcher), desired), next);
    const latest = lstatIfExists(launcher);
    if (latest) {
      if (!latest.isSymbolicLink()) {
        throw new Error(`Runtime launcher path became occupied by an unmanaged file: ${launcher}`);
      }
      const latestTarget = path.resolve(path.dirname(launcher), fs.readlinkSync(launcher));
      if (!managedLauncherTarget(latestTarget, stateRoot, sourceRoot)) {
        throw new Error(`Runtime launcher became an unmanaged symlink: ${launcher} -> ${latestTarget}`);
      }
    }
    fs.renameSync(next, launcher);
    return { path: launcher, changed: true };
  } finally {
    removePath(next);
  }
}

function snapshotCurrentPointer(current: string, installation: string): RuntimeCurrentSnapshot {
  const stat = lstatIfExists(current);
  if (!stat) return { kind: "missing" };
  if (!stat.isSymbolicLink()) {
    throw new Error("Runtime current path must be a managed symlink for transactional setup");
  }
  const target = path.resolve(path.dirname(current), fs.readlinkSync(current));
  if (!isWithin(installation, target)) {
    throw new Error(`Runtime current link points outside the installation: ${target}`);
  }
  const targetStat = lstatIfExists(target);
  if (!targetStat || !targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new Error(`Runtime current link target is not a deployment: ${target}`);
  }
  return { kind: "symlink", target };
}

function snapshotLauncherPointer(launcher: string): RuntimeLauncherSnapshot {
  const stat = lstatIfExists(launcher);
  if (!stat) return { kind: "missing" };
  if (stat.isSymbolicLink()) {
    return {
      kind: "symlink",
      target: path.resolve(path.dirname(launcher), fs.readlinkSync(launcher)),
    };
  }
  if (!stat.isFile()) throw new Error(`Runtime launcher is not a regular file or symlink: ${launcher}`);
  return { kind: "file", bytes: fs.readFileSync(launcher), mode: stat.mode & 0o777 };
}

function restoreCurrentPointer(
  current: string,
  installation: string,
  snapshot: RuntimeCurrentSnapshot,
): void {
  if (snapshot.kind !== "symlink") {
    removePointer(current, "Runtime current pointer");
    return;
  }
  if (!isWithin(installation, snapshot.target)) {
    throw new Error(`Runtime rollback target points outside the installation: ${snapshot.target}`);
  }
  const targetStat = lstatIfExists(snapshot.target);
  if (!targetStat || !targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new Error(`Runtime rollback target is not a deployment: ${snapshot.target}`);
  }
  atomicReplaceSymlink(current, snapshot.target, "Runtime current pointer", "dir");
}

function restoreLauncherPointer(launcher: string, snapshot: RuntimeLauncherSnapshot): void {
  ensureLauncherDirectory(path.dirname(launcher));
  if (snapshot.kind === "missing") {
    removePointer(launcher, "Runtime launcher pointer");
    return;
  }
  if (snapshot.kind === "symlink") {
    atomicReplaceSymlink(launcher, snapshot.target, "Runtime launcher pointer");
    return;
  }
  atomicReplaceFile(launcher, snapshot.bytes, snapshot.mode, "Runtime launcher pointer");
}

/** Capture the runtime and global launcher pointers before a multi-step setup. */
export function snapshotRuntimeInstallation(options: RuntimeInstallOptions = {}): RuntimeInstallSnapshot {
  const stateRoot = path.resolve(options.stateRoot ?? getStateDir());
  const installation = runtimeInstallationPath(stateRoot);
  const current = runtimeCurrentPath(stateRoot);
  const homeDir = path.resolve(options.homeDir ?? process.env.HOME ?? os.homedir());
  const launcher = runtimeLauncherPath(homeDir);
  const lockFile = path.join(ensurePrivateDirectory(path.join(stateRoot, LOCK_DIRECTORY)), LOCK_FILE);
  return withFileLock(lockFile, () => ({
    stateRoot,
    homeDir,
    current: snapshotCurrentPointer(current, installation),
    launcher: snapshotLauncherPointer(launcher),
  }), {
    timeoutMs: options.lockTimeoutMs ?? RUNTIME_INSTALL_LOCK_TIMEOUT_MS,
    staleMs: options.lockStaleMs ?? RUNTIME_INSTALL_LOCK_STALE_MS,
  });
}

/** Restore the pointers captured by snapshotRuntimeInstallation. */
export function restoreRuntimeInstallation(snapshot: RuntimeInstallSnapshot): void {
  const stateRoot = path.resolve(snapshot.stateRoot);
  const installation = runtimeInstallationPath(stateRoot);
  const current = runtimeCurrentPath(stateRoot);
  const launcher = runtimeLauncherPath(snapshot.homeDir);
  const lockFile = path.join(ensurePrivateDirectory(path.join(stateRoot, LOCK_DIRECTORY)), LOCK_FILE);
  withFileLock(lockFile, () => {
    restoreCurrentPointer(current, installation, snapshot.current);
    restoreLauncherPointer(launcher, snapshot.launcher);
  }, {
    timeoutMs: RUNTIME_INSTALL_LOCK_TIMEOUT_MS,
    staleMs: RUNTIME_INSTALL_LOCK_STALE_MS,
  });
}

function processRunningFromCurrent(currentTargetPath: string, entryPath: string): boolean {
  const actualTarget = canonicalPath(currentTargetPath);
  if (isWithin(actualTarget, canonicalPath(moduleCheckoutRoot))) return true;
  if (!entryPath.trim()) return false;
  return isWithin(actualTarget, canonicalPath(entryPath));
}

/**
 * Publish the current checkout as the single machine runtime. The `current`
 * link is the stable public path; release directories are private staging
 * paths and are only made visible after deployment validation succeeds.
 */
export function installRuntime(options: RuntimeInstallOptions = {}): RuntimeInstallResult {
  const stateRoot = ensurePrivateDirectory(options.stateRoot ?? getStateDir());
  const installation = ensurePrivateDirectory(path.join(stateRoot, INSTALLATION_DIRECTORY));
  const current = runtimeCurrentPath(stateRoot);
  const sourceRoot = runtimeSourceRoot(options.checkoutRoot);
  const lockFile = path.join(ensurePrivateDirectory(path.join(stateRoot, LOCK_DIRECTORY)), LOCK_FILE);
  const commands: RuntimeCommandResult[] = [];

  return withFileLock(
    lockFile,
    () => {
      const existingTarget = currentTarget(current, installation);
      if (
        existingTarget &&
        processRunningFromCurrent(current, options.runningEntryPath ?? process.argv[1] ?? "")
      ) {
        try {
          const currentPackage = validateRuntimeTree(existingTarget);
          const launcher = ensureRuntimeLauncher(
            stateRoot,
            sourceRoot,
            path.resolve(options.homeDir ?? process.env.HOME ?? os.homedir()),
          );
          return {
            installed: true,
            changed: false,
            path: current,
            entryPath: runtimeEntryPath(stateRoot),
            sourceRoot,
            packageVersion: currentPackage.packageVersion,
            launcherPath: launcher.path,
            launcherChanged: launcher.changed,
            commands,
          };
        } catch {
          // A running path is not proof that the installed bytes are intact.
          // Rebuild from the clean pinned source below.
        }
      }

      const stage = stagePath(installation);
      const buildStage = buildStagePath(installation);
      // Resolve and validate the source before copying any package input. A
      // dirty checkout must never be published with only its HEAD recorded.
      // The package is rebuilt from Git-tracked files so ignored dist output
      // in the checkout cannot become a trusted runtime artifact.
      const sourceIdentity = collectSourceMetadata(sourceRoot);
      if (!sourceIdentity.revision) {
        throw new Error("runtime source must be a clean Git checkout");
      }
      const homeDir = path.resolve(options.homeDir ?? process.env.HOME ?? os.homedir());
      const previousCurrent = snapshotCurrentPointer(current, installation);
      const launcherPath = runtimeLauncherPath(homeDir);
      const previousLauncher = snapshotLauncherPointer(launcherPath);
      let published = false;
      try {
        ensurePrivateDirectory(buildStage);
        buildRuntimeSource(sourceRoot, buildStage, sourceIdentity.revision, options, commands);
        const packageContentDigest = computeContentDigest(buildStage, RUNTIME_PACKAGE_INPUTS);
        ensurePrivateDirectory(stage);
        copyPackageInputs(buildStage, stage);
        const stagedContentDigest = computeContentDigest(stage, RUNTIME_PACKAGE_INPUTS);
        if (stagedContentDigest !== packageContentDigest) {
          throw new Error("runtime package content changed while creating the deployment");
        }
        installProductionDependencies(buildStage, stage, options, commands);
        writeSourceMetadata(stage, {
          ...sourceIdentity,
          contentDigest: computeContentDigest(stage, RUNTIME_DEPLOYMENT_INPUTS),
        });
        const stagedPackage = validateRuntimeTree(stage);
        publishStage(stage, current, installation);
        published = true;
        removePath(buildStage);
        let launcher: { path: string; changed: boolean };
        try {
          launcher = ensureRuntimeLauncher(stateRoot, sourceRoot, homeDir);
        } catch (error) {
          let rollbackError: unknown;
          try {
            restoreCurrentPointer(current, installation, previousCurrent);
          } catch (restoreError) {
            rollbackError = restoreError;
          }
          try {
            restoreLauncherPointer(launcherPath, previousLauncher);
          } catch (restoreError) {
            rollbackError ??= restoreError;
          }
          if (!rollbackError) removePath(stage);
          if (rollbackError) {
            const original = error instanceof Error ? error.message : String(error);
            const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            throw new Error(`${original}; runtime install rollback failed: ${rollback}`);
          }
          throw error;
        }
        return {
          installed: true,
          changed: true,
          path: current,
          entryPath: runtimeEntryPath(stateRoot),
          sourceRoot,
          packageVersion: stagedPackage.packageVersion,
          launcherPath: launcher.path,
          launcherChanged: launcher.changed,
          commands,
        };
      } catch (error) {
        if (!published) removePath(stage);
        removePath(buildStage);
        throw error;
      }
    },
    {
      timeoutMs: options.lockTimeoutMs ?? RUNTIME_INSTALL_LOCK_TIMEOUT_MS,
      staleMs: options.lockStaleMs ?? RUNTIME_INSTALL_LOCK_STALE_MS,
    },
  );
}
