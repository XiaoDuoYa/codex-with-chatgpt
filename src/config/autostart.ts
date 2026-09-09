import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { getStateDir } from "./paths.js";
import { runtimeEntryPath } from "./runtime-install.js";

/** The single LaunchAgent supervising the machine-scoped gateway. */
export const AUTOSTART_LABEL = "dev.codex-with-chatgpt.machine";
export const DEFAULT_AUTOSTART_INTERVAL_SECONDS = 60;
const MIN_AUTOSTART_INTERVAL_SECONDS = 30;
const MAX_AUTOSTART_INTERVAL_SECONDS = 86_400;

/**
 * Keep launchd's environment deliberately small. The tunnel configuration is
 * stored below C2C_STATE_DIR, so arbitrary shell state must not leak into the
 * long-lived machine process.
 */
const AUTOSTART_ENV_KEYS = ["C2C_STATE_DIR"] as const;

export interface AutostartConfig {
  stateDir: string;
  label: string;
  plistPath: string;
  stdoutPath: string;
  stderrPath: string;
  c2cBinPath: string;
  nodePath: string;
  intervalSeconds: number;
  programArguments: string[];
  environment: Record<string, string>;
}

export interface BuildAutostartConfigOptions {
  intervalSeconds?: number | string;
  c2cBinPath?: string;
  nodePath?: string;
  homeDir?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface AutostartCommandResult {
  command: string;
  args: string[];
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface LaunchctlOptions {
  platform?: NodeJS.Platform;
  uid?: number;
  spawnSyncImpl?: typeof spawnSync;
}

export interface AutostartInstallResult {
  config: AutostartConfig;
  commands: AutostartCommandResult[];
}

export interface AutostartStatus {
  config: AutostartConfig;
  enabled: boolean;
  loaded: boolean | null;
  detail?: string;
}

export function c2cBinPath(stateRoot: string = getStateDir()): string {
  return runtimeEntryPath(stateRoot);
}

export function normalizeAutostartIntervalSeconds(value?: number | string): number {
  if (value === undefined || value === null || value === "") return DEFAULT_AUTOSTART_INTERVAL_SECONDS;
  const parsed = typeof value === "number" ? value : Number(value);
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < MIN_AUTOSTART_INTERVAL_SECONDS ||
    parsed > MAX_AUTOSTART_INTERVAL_SECONDS
  ) {
    throw new Error(
      `interval must be between ${MIN_AUTOSTART_INTERVAL_SECONDS} and ${MAX_AUTOSTART_INTERVAL_SECONDS} seconds`,
    );
  }
  return parsed;
}

function defaultPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  const seen = new Set<string>();
  const parts = [
    ...(env.PATH?.split(path.delimiter) ?? []),
    path.join(homeDir, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return parts
    .filter((part) => {
      if (!part || seen.has(part)) return false;
      seen.add(part);
      return true;
    })
    .join(path.delimiter);
}

function configuredStateDir(options: BuildAutostartConfigOptions): string {
  const value = options.stateDir?.trim() || options.env?.C2C_STATE_DIR?.trim();
  return path.resolve(value || getStateDir());
}

function autostartEnvironment(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  stateDir: string,
): Record<string, string> {
  const result: Record<string, string> = {
    HOME: homeDir,
    PATH: defaultPath(env, homeDir),
    C2C_STATE_DIR: stateDir,
  };
  for (const key of AUTOSTART_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value && key !== "C2C_STATE_DIR" && !result[key]) result[key] = value;
  }
  return result;
}

/** Build the one machine-wide LaunchAgent configuration. */
export function buildAutostartConfig(opts: BuildAutostartConfigOptions = {}): AutostartConfig {
  const env = opts.env ?? process.env;
  const homeDir = path.resolve(opts.homeDir ?? env.HOME ?? os.homedir());
  const stateDir = configuredStateDir(opts);
  const logDir = path.join(stateDir, "logs");
  const intervalSeconds = normalizeAutostartIntervalSeconds(opts.intervalSeconds);
  const c2cEntry = path.resolve(opts.c2cBinPath ?? runtimeEntryPath(stateDir));
  const nodePath = path.resolve(opts.nodePath ?? process.execPath);
  return {
    stateDir,
    label: AUTOSTART_LABEL,
    plistPath: path.join(homeDir, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`),
    stdoutPath: path.join(logDir, "autostart-machine.log"),
    stderrPath: path.join(logDir, "autostart-machine.error.log"),
    c2cBinPath: c2cEntry,
    nodePath,
    intervalSeconds,
    programArguments: [nodePath, c2cEntry, "autostart", "run", "--quiet"],
    environment: autostartEnvironment(env, homeDir, stateDir),
  };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function stringArray(values: string[]): string {
  return values.map((value) => `    <string>${xmlEscape(value)}</string>`).join("\n");
}

function environmentDict(values: Record<string, string>): string {
  return Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join("\n");
}

export function renderLaunchAgentPlist(config: AutostartConfig): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(config.label)}</string>
  <key>ProgramArguments</key>
  <array>
${stringArray(config.programArguments)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environmentDict(config.environment)}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${config.intervalSeconds}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(config.stateDir)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(config.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(config.stderrPath)}</string>
</dict>
</plist>
`;
}

function writeLaunchAgentPlist(config: AutostartConfig): void {
  const parent = path.dirname(path.resolve(config.plistPath));
  ensureSecureDirectoryTree(parent, "LaunchAgent parent directory");
  assertSecureLaunchAgentTarget(config.plistPath);
  ensureSecureDirectoryTree(path.dirname(config.stdoutPath), "LaunchAgent stdout parent directory");
  ensureSecureDirectoryTree(path.dirname(config.stderrPath), "LaunchAgent stderr parent directory");
  writeAtomicLaunchAgentFile(config.plistPath, renderLaunchAgentPlist(config), 0o644);
}

function writeAtomicLaunchAgentFile(file: string, contents: string | Buffer, mode: number): void {
  const absolute = path.resolve(file);
  const parent = path.dirname(absolute);
  ensureSecureDirectoryTree(parent, "LaunchAgent parent directory");
  assertSecureLaunchAgentTarget(absolute);
  const temporary = path.join(
    parent,
    `.${path.basename(absolute)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    // Recheck immediately before publication so a replaced target or parent
    // cannot be followed by the atomic rename.
    ensureSecureDirectoryTree(parent, "LaunchAgent parent directory");
    assertSecureLaunchAgentTarget(absolute);
    fs.renameSync(temporary, absolute);
    fs.chmodSync(absolute, mode);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // preserve the original write error
      }
    }
    throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

interface LaunchAgentSnapshot {
  contents: Buffer;
  mode: number;
}

function lstatIfExists(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Ensure every existing path component is a real directory, creating only real directories. */
function ensureSecureDirectoryTree(directory: string, label: string): void {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat = lstatIfExists(current);
    if (!stat) {
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stat = lstatIfExists(current);
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${label} must not contain symbolic links or non-directories: ${current}`);
    }
    if (fs.realpathSync.native(current) !== current) {
      throw new Error(`${label} must not traverse symbolic links: ${current}`);
    }
  }
}

function verifySecureDirectoryTree(directory: string, label: string): void {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = lstatIfExists(current);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${label} must not contain symbolic links or non-directories: ${current}`);
    }
    if (fs.realpathSync.native(current) !== current) {
      throw new Error(`${label} must not traverse symbolic links: ${current}`);
    }
  }
}

function assertSecureLaunchAgentTarget(file: string): void {
  const absolute = path.resolve(file);
  verifySecureDirectoryTree(path.dirname(absolute), "LaunchAgent parent directory");
  const stat = lstatIfExists(absolute);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new Error(`LaunchAgent plist must not be a symbolic link: ${absolute}`);
  }
  if (!stat.isFile()) {
    throw new Error(`LaunchAgent plist must be a regular file: ${absolute}`);
  }
}

function readLaunchAgentSnapshot(file: string): LaunchAgentSnapshot | null {
  assertSecureLaunchAgentTarget(file);
  try {
    const stat = fs.lstatSync(file);
    return { contents: fs.readFileSync(file), mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function restoreLaunchAgentSnapshot(file: string, snapshot: LaunchAgentSnapshot | null): void {
  assertSecureLaunchAgentTarget(file);
  if (!snapshot) {
    fs.rmSync(file, { force: true });
    return;
  }
  writeAtomicLaunchAgentFile(file, snapshot.contents, snapshot.mode);
}

function validateAutostartExecutables(config: AutostartConfig): void {
  for (const [label, file] of [
    ["Node executable", config.nodePath],
    ["C2C entrypoint", config.c2cBinPath],
  ] as const) {
    try {
      if (!fs.statSync(file).isFile()) throw new Error("not a regular file");
      fs.accessSync(file, fs.constants.F_OK | fs.constants.X_OK);
    } catch {
      throw new Error(`${label} is missing or not executable: ${file}`);
    }
  }
}

function ensureDarwin(platform = process.platform): void {
  if (platform !== "darwin") {
    throw new Error("autostart is currently supported on macOS LaunchAgents only");
  }
}

function launchdDomain(uid = process.getuid?.() ?? Number(process.env.UID) ?? 0): string {
  return `gui/${uid}`;
}

function runLaunchctl(args: string[], opts: LaunchctlOptions): AutostartCommandResult {
  const run = opts.spawnSyncImpl ?? spawnSync;
  const result = run("launchctl", args, { encoding: "utf8" }) as SpawnSyncReturns<string>;
  return {
    command: "launchctl",
    args,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function commandFailed(result: AutostartCommandResult): boolean {
  return result.status !== 0;
}

function bootoutIsIgnorable(result: AutostartCommandResult): boolean {
  return /could not find|not found|No such (?:process|file)|service is not loaded/i.test(
    `${result.stderr}\n${result.stdout}`,
  );
}

function bootoutLaunchAgent(
  config: AutostartConfig,
  opts: LaunchctlOptions,
  commands: AutostartCommandResult[],
): void {
  const domain = launchdDomain(opts.uid);
  const bootout = runLaunchctl(["bootout", domain, config.plistPath], opts);
  commands.push(bootout);
  if (!commandFailed(bootout)) return;

  // A missing plist does not prove that the fixed machine label is unloaded.
  // launchd can keep a job alive after its source plist has been removed.
  const labelBootout = runLaunchctl(["bootout", `${domain}/${config.label}`], opts);
  commands.push(labelBootout);
  if (!commandFailed(labelBootout) || bootoutIsIgnorable(labelBootout)) return;
  throw new Error(
    `launchctl bootout failed: ${labelBootout.stderr || labelBootout.stdout || labelBootout.status}`,
  );
}

function snapshotLaunchAgentLoaded(
  config: AutostartConfig,
  opts: LaunchctlOptions,
  commands: AutostartCommandResult[],
): boolean {
  const result = runLaunchctl(["print", `${launchdDomain(opts.uid)}/${config.label}`], opts);
  commands.push(result);
  if (result.status === 0) return true;
  if (bootoutIsIgnorable(result)) return false;
  throw new Error(
    `launchctl could not inspect ${config.label}: ${result.stderr || result.stdout || result.status}`,
  );
}

export function enableAutostart(
  config: AutostartConfig,
  opts: LaunchctlOptions = {},
): AutostartInstallResult {
  ensureDarwin(opts.platform);
  validateAutostartExecutables(config);
  assertSecureLaunchAgentTarget(config.plistPath);
  const commands: AutostartCommandResult[] = [];
  const domain = launchdDomain(opts.uid);
  const previous = readLaunchAgentSnapshot(config.plistPath);
  const previousLoaded = snapshotLaunchAgentLoaded(config, opts, commands);
  if (!previous && previousLoaded) {
    throw new Error(
      `LaunchAgent ${config.label} is loaded without its managed plist; disable it before enabling`,
    );
  }

  let oldBootoutCompleted = false;
  let bootstrapAttempted = false;
  try {
    bootoutLaunchAgent(config, opts, commands);
    oldBootoutCompleted = true;
    writeLaunchAgentPlist(config);
    bootstrapAttempted = true;
    const bootstrap = runLaunchctl(["bootstrap", domain, config.plistPath], opts);
    commands.push(bootstrap);
    if (commandFailed(bootstrap)) {
      throw new Error(`launchctl bootstrap failed: ${bootstrap.stderr || bootstrap.stdout || bootstrap.status}`);
    }
    const kickstart = runLaunchctl(["kickstart", "-k", `${domain}/${config.label}`], opts);
    commands.push(kickstart);
    if (commandFailed(kickstart)) {
      throw new Error(`launchctl kickstart failed: ${kickstart.stderr || kickstart.stdout || kickstart.status}`);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (bootstrapAttempted || !oldBootoutCompleted) {
      try {
        bootoutLaunchAgent(config, opts, commands);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    try {
      restoreLaunchAgentSnapshot(config.plistPath, previous);
      if (previous && previousLoaded) {
        const bootstrap = runLaunchctl(["bootstrap", domain, config.plistPath], opts);
        commands.push(bootstrap);
        if (commandFailed(bootstrap)) {
          throw new Error(`restore bootstrap failed: ${bootstrap.stderr || bootstrap.stdout || bootstrap.status}`);
        }
        const kickstart = runLaunchctl(["kickstart", "-k", `${domain}/${config.label}`], opts);
        commands.push(kickstart);
        if (commandFailed(kickstart)) {
          throw new Error(`restore kickstart failed: ${kickstart.stderr || kickstart.stdout || kickstart.status}`);
        }
      }
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
    }
    const reason = error instanceof Error ? error.message : String(error);
    const rollback = rollbackErrors.length > 0 ? `; rollback failed: ${rollbackErrors.join("; ")}` : "";
    throw new Error(`${reason}${rollback}`);
  }
  return { config, commands };
}

export function disableAutostart(
  config: AutostartConfig,
  opts: LaunchctlOptions = {},
): AutostartInstallResult {
  ensureDarwin(opts.platform);
  assertSecureLaunchAgentTarget(config.plistPath);
  const commands: AutostartCommandResult[] = [];
  bootoutLaunchAgent(config, opts, commands);
  fs.rmSync(config.plistPath, { force: true });
  return { config, commands };
}

export function autostartStatus(
  config: AutostartConfig,
  opts: LaunchctlOptions = {},
): AutostartStatus {
  assertSecureLaunchAgentTarget(config.plistPath);
  const enabled = lstatIfExists(config.plistPath) !== null;
  if ((opts.platform ?? process.platform) !== "darwin") {
    return { config, enabled, loaded: null, detail: "unsupported platform" };
  }
  const loaded = runLaunchctl(["print", `${launchdDomain(opts.uid)}/${config.label}`], opts);
  return {
    config,
    enabled,
    loaded: loaded.status === 0,
    detail: loaded.status === 0 ? undefined : (loaded.stderr || loaded.stdout || "").trim() || undefined,
  };
}
