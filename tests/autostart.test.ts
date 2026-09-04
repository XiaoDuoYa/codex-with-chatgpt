import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { spawnSync } from "node:child_process";
import {
  AUTOSTART_LABEL,
  buildAutostartConfig,
  disableAutostart,
  enableAutostart,
  normalizeAutostartIntervalSeconds,
  renderLaunchAgentPlist,
  autostartStatus,
} from "../src/config/autostart.js";
import { runtimeEntryPath } from "../src/config/runtime-install.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];
const previousStateDir = process.env.C2C_STATE_DIR;

function executablePaths(home: string): { c2cBinPath: string; nodePath: string } {
  const nodePath = write(path.join(home, "bin"), "node", "#!/bin/sh\n");
  const c2cBinPath = write(path.join(home, "checkout", "bin"), "c2c.js", "#!/usr/bin/env node\n");
  fs.chmodSync(nodePath, 0o755);
  fs.chmodSync(c2cBinPath, 0o755);
  return { nodePath, c2cBinPath };
}

function machineConfig(stateDir: string, homeDir: string) {
  return buildAutostartConfig({
    stateDir,
    homeDir,
    ...executablePaths(homeDir),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) cleanup(dirs.pop()!);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

describe("machine autostart LaunchAgent", () => {
  it("defaults to the fixed machine runtime instead of the source checkout", () => {
    const stateDir = makeTmpDir("autostart-fixed-runtime-state");
    const home = makeTmpDir("autostart-fixed-runtime-home");
    dirs.push(stateDir, home);

    const config = buildAutostartConfig({ stateDir, homeDir: home, nodePath: "/node" });

    expect(config.c2cBinPath).toBe(runtimeEntryPath(stateDir));
    expect(config.programArguments[1]).toBe(runtimeEntryPath(stateDir));
    expect(config.c2cBinPath).not.toContain(`${path.sep}src${path.sep}`);
  });

  it("uses one fixed machine label and invokes the quiet machine wake-up", () => {
    const stateDir = isolateStateDir();
    const home = makeTmpDir("autostart-home");
    dirs.push(stateDir, home);
    const config = buildAutostartConfig({
      stateDir,
      c2cBinPath: "/checkout/bin/c2c.js",
      nodePath: "/node",
      homeDir: home,
      intervalSeconds: "300",
      env: {
        PATH: "/custom/bin:/usr/bin",
        HOME: "/ignored/home",
        C2C_STATE_DIR: stateDir,
        C2C_CLOUDFLARED_PATH: "/tmp/cloudflared",
        C2C_TUNNEL_ID: "tunnel_ignored",
      },
    });
    const plist = renderLaunchAgentPlist(config);

    expect(config.label).toBe(AUTOSTART_LABEL);
    expect(config.stateDir).toBe(stateDir);
    expect(config.programArguments).toEqual([
      "/node",
      "/checkout/bin/c2c.js",
      "autostart",
      "run",
      "--quiet",
    ]);
    expect(config.environment).toEqual({
      HOME: home,
      PATH: [
        "/custom/bin",
        "/usr/bin",
        path.join(home, ".local", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].join(path.delimiter),
      C2C_STATE_DIR: stateDir,
    });
    expect(plist).toContain(`<string>${AUTOSTART_LABEL}</string>`);
    expect(plist).toContain("<integer>300</integer>");
    expect(plist).toContain(`<string>${stateDir}</string>`);
    expect(plist).not.toContain("<string>-w</string>");
    expect(plist).not.toContain("CLOUDFLARED");
    expect(plist).not.toContain("cloudflared");
    expect(plist).not.toContain("tunnel run");
  });

  it("does not derive any LaunchAgent identity from a workspace", () => {
    const stateDir = makeTmpDir("autostart-state");
    const home = makeTmpDir("autostart-home");
    dirs.push(stateDir, home);
    const first = buildAutostartConfig({ stateDir, homeDir: home, ...executablePaths(home) });
    const second = buildAutostartConfig({ stateDir, homeDir: home, ...executablePaths(home) });

    expect(second.label).toBe(first.label);
    expect(second.plistPath).toBe(first.plistPath);
    expect(second.stdoutPath).toBe(first.stdoutPath);
    expect(second.programArguments).toEqual(first.programArguments);
  });

  it("requires a bounded launch interval", () => {
    expect(normalizeAutostartIntervalSeconds()).toBe(60);
    expect(normalizeAutostartIntervalSeconds("300")).toBe(300);
    expect(() => normalizeAutostartIntervalSeconds("1")).toThrow(/interval/);
    expect(() => normalizeAutostartIntervalSeconds("60.5")).toThrow(/interval/);
    expect(() => normalizeAutostartIntervalSeconds("abc")).toThrow(/interval/);
  });

  it("uses the label fallback before enabling a LaunchAgent", () => {
    const stateDir = isolateStateDir();
    const home = makeTmpDir("autostart-enable-home");
    dirs.push(stateDir, home);
    const config = machineConfig(stateDir, home);
    const responses = [
      { status: 1, stdout: "", stderr: "service is not loaded" },
      { status: 5, stdout: "", stderr: "Boot-out failed: Input/output error" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ];
    const spawnSyncImpl = vi.fn(() => responses.shift()!) as unknown as typeof spawnSync;

    const result = enableAutostart(config, { platform: "darwin", uid: 501, spawnSyncImpl });

    expect(result.commands).toHaveLength(5);
    expect(spawnSyncImpl).toHaveBeenNthCalledWith(
      3,
      "launchctl",
      ["bootout", `gui/501/${config.label}`],
      { encoding: "utf8" },
    );
    expect(fs.existsSync(config.plistPath)).toBe(true);
  });

  it("refuses to replace a loaded machine label when its managed plist is missing", () => {
    const stateDir = isolateStateDir();
    const home = makeTmpDir("autostart-loaded-without-plist-home");
    dirs.push(stateDir, home);
    const config = machineConfig(stateDir, home);
    const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: "loaded", stderr: "" })) as unknown as typeof spawnSync;

    expect(() => enableAutostart(config, { platform: "darwin", uid: 501, spawnSyncImpl })).toThrow(
      /loaded without its managed plist/,
    );
    expect(spawnSyncImpl).toHaveBeenCalledTimes(1);
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "launchctl",
      ["print", `gui/501/${config.label}`],
      { encoding: "utf8" },
    );
    expect(fs.existsSync(config.plistPath)).toBe(false);
  });

  it("fails closed when the existing label state cannot be inspected", () => {
    const stateDir = isolateStateDir();
    const home = makeTmpDir("autostart-print-failure-home");
    dirs.push(stateDir, home);
    const config = machineConfig(stateDir, home);
    const spawnSyncImpl = vi.fn(() => ({
      status: 5,
      stdout: "",
      stderr: "Input/output error",
    })) as unknown as typeof spawnSync;

    expect(() => enableAutostart(config, { platform: "darwin", uid: 501, spawnSyncImpl })).toThrow(
      /could not inspect/,
    );
    expect(spawnSyncImpl).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(config.plistPath)).toBe(false);
  });

  it("restores the previous LaunchAgent when both enable bootout forms fail", () => {
    const stateDir = isolateStateDir();
    const home = makeTmpDir("autostart-enable-fail-home");
    dirs.push(stateDir, home);
    const config = machineConfig(stateDir, home);
    fs.mkdirSync(path.dirname(config.plistPath), { recursive: true });
    fs.writeFileSync(config.plistPath, "existing plist");
    const responses = [
      { status: 1, stdout: "", stderr: "service is not loaded" },
      { status: 5, stdout: "", stderr: "Boot-out failed: Input/output error" },
      { status: 5, stdout: "", stderr: "Boot-out failed: Input/output error" },
      { status: 0, stdout: "", stderr: "" },
    ];
    const spawnSyncImpl = vi.fn(() => responses.shift()!) as unknown as typeof spawnSync;

    expect(() => enableAutostart(config, { platform: "darwin", uid: 501, spawnSyncImpl })).toThrow(
      /bootout failed/,
    );
    expect(spawnSyncImpl).toHaveBeenCalledTimes(4);
    expect(fs.readFileSync(config.plistPath, "utf8")).toBe("existing plist");
  });

  it("restores the previous LaunchAgent when writing the replacement plist fails", () => {
    const stateDir = isolateStateDir();
    const home = makeTmpDir("autostart-write-rollback-home");
    dirs.push(stateDir, home);
    const config = machineConfig(stateDir, home);
    fs.mkdirSync(path.dirname(config.plistPath), { recursive: true });
    fs.writeFileSync(config.plistPath, "previous plist");
    const responses = [
      { status: 1, stdout: "", stderr: "service is not loaded" },
      { status: 0, stdout: "", stderr: "" },
    ];
    const spawnSyncImpl = vi.fn(() => responses.shift()!) as unknown as typeof spawnSync;
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("simulated plist write failure");
    });

    expect(() => enableAutostart(config, { platform: "darwin", uid: 501, spawnSyncImpl })).toThrow(
      /simulated plist write failure/,
    );
    expect(fs.readFileSync(config.plistPath, "utf8")).toBe("previous plist");
    expect(spawnSyncImpl).toHaveBeenCalledTimes(2);
  });

  it("restores the previous LaunchAgent when bootstrap fails", () => {
    const stateDir = isolateStateDir();
    const home = makeTmpDir("autostart-bootstrap-rollback-home");
    dirs.push(stateDir, home);
    const config = machineConfig(stateDir, home);
    fs.mkdirSync(path.dirname(config.plistPath), { recursive: true });
    fs.writeFileSync(config.plistPath, "previous plist");
    const responses = [
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 5, stdout: "", stderr: "bootstrap rejected" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ];
    const spawnSyncImpl = vi.fn(() => responses.shift()!) as unknown as typeof spawnSync;

    expect(() => enableAutostart(config, { platform: "darwin", uid: 501, spawnSyncImpl })).toThrow(
      /bootstrap rejected/,
    );
    expect(fs.readFileSync(config.plistPath, "utf8")).toBe("previous plist");
    expect(spawnSyncImpl).toHaveBeenCalledTimes(6);
  });

  it("unloads the replacement and restores the previous LaunchAgent when kickstart fails", () => {
    const stateDir = isolateStateDir();
    const home = makeTmpDir("autostart-kickstart-rollback-home");
    dirs.push(stateDir, home);
    const config = machineConfig(stateDir, home);
    fs.mkdirSync(path.dirname(config.plistPath), { recursive: true });
    fs.writeFileSync(config.plistPath, "previous plist");
    const responses = [
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 5, stdout: "", stderr: "kickstart rejected" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ];
    const spawnSyncImpl = vi.fn(() => responses.shift()!) as unknown as typeof spawnSync;

    expect(() => enableAutostart(config, { platform: "darwin", uid: 501, spawnSyncImpl })).toThrow(
      /kickstart rejected/,
    );
    expect(fs.readFileSync(config.plistPath, "utf8")).toBe("previous plist");
    expect(spawnSyncImpl).toHaveBeenCalledTimes(7);
    });

  it("does not reload a previously unloaded LaunchAgent during rollback", () => {
    const stateDir = isolateStateDir();
    const home = makeTmpDir("autostart-unloaded-rollback-home");
    dirs.push(stateDir, home);
    const config = machineConfig(stateDir, home);
    fs.mkdirSync(path.dirname(config.plistPath), { recursive: true });
    fs.writeFileSync(config.plistPath, "previous plist");
    const responses = [
      { status: 1, stdout: "", stderr: "service is not loaded" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 5, stdout: "", stderr: "kickstart rejected" },
      { status: 0, stdout: "", stderr: "" },
    ];
    const spawnSyncImpl = vi.fn(() => responses.shift()!) as unknown as typeof spawnSync;

    expect(() => enableAutostart(config, { platform: "darwin", uid: 501, spawnSyncImpl })).toThrow(
      /kickstart rejected/,
    );
    expect(fs.readFileSync(config.plistPath, "utf8")).toBe("previous plist");
    expect(spawnSyncImpl).toHaveBeenCalledTimes(5);
    expect(
      spawnSyncImpl.mock.calls.filter(([, args]) =>
        Array.isArray(args) && args[0] === "bootstrap" && args[1] === "gui/501",
      ),
    ).toHaveLength(1);
  });

  it("validates executables before unloading an existing LaunchAgent", () => {
    const stateDir = isolateStateDir();
    const home = makeTmpDir("autostart-invalid-executable-home");
    dirs.push(stateDir, home);
    const config = buildAutostartConfig({
      stateDir,
      nodePath: path.join(home, "missing-node"),
      c2cBinPath: path.join(home, "missing-c2c"),
      homeDir: home,
    });
    fs.mkdirSync(path.dirname(config.plistPath), { recursive: true });
    fs.writeFileSync(config.plistPath, "previous plist");
    const spawnSyncImpl = vi.fn() as unknown as typeof spawnSync;

    expect(() => enableAutostart(config, { platform: "darwin", uid: 501, spawnSyncImpl })).toThrow(
      /Node executable is missing or not executable/,
    );
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(fs.readFileSync(config.plistPath, "utf8")).toBe("previous plist");
  });

  it("rejects a symlinked LaunchAgent parent before launchctl or writes", () => {
    const stateDir = isolateStateDir();
    const home = makeTmpDir("autostart-symlink-parent-home");
    const outside = makeTmpDir("autostart-symlink-parent-target");
    dirs.push(stateDir, home, outside);
    const config = machineConfig(stateDir, home);
    fs.mkdirSync(path.join(home, "Library"), { recursive: true });
    fs.symlinkSync(outside, path.join(home, "Library", "LaunchAgents"), "dir");
    const spawnSyncImpl = vi.fn() as unknown as typeof spawnSync;

    expect(() => enableAutostart(config, { platform: "darwin", uid: 501, spawnSyncImpl })).toThrow(
      /LaunchAgent parent directory.*symbolic links/,
    );
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(() => autostartStatus(config, { platform: "darwin", uid: 501, spawnSyncImpl })).toThrow(
      /LaunchAgent parent directory.*symbolic links/,
    );
  });

  it("rejects a symlinked LaunchAgent target before status trust or replacement", () => {
    const stateDir = isolateStateDir();
    const home = makeTmpDir("autostart-symlink-target-home");
    const outside = makeTmpDir("autostart-symlink-target-target");
    dirs.push(stateDir, home, outside);
    const config = machineConfig(stateDir, home);
    fs.mkdirSync(path.dirname(config.plistPath), { recursive: true });
    const outsideFile = path.join(outside, "outside.plist");
    fs.writeFileSync(outsideFile, "must remain unchanged");
    fs.symlinkSync(outsideFile, config.plistPath);
    const spawnSyncImpl = vi.fn() as unknown as typeof spawnSync;

    expect(() => enableAutostart(config, { platform: "darwin", uid: 501, spawnSyncImpl })).toThrow(
      /LaunchAgent plist must not be a symbolic link/,
    );
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("must remain unchanged");
    expect(() => autostartStatus(config, { platform: "darwin", uid: 501, spawnSyncImpl })).toThrow(
      /LaunchAgent plist must not be a symbolic link/,
    );
  });

  it("keeps the plist when both disable bootout forms fail", () => {
    const stateDir = isolateStateDir();
    const home = makeTmpDir("autostart-disable-fail-home");
    dirs.push(stateDir, home);
    const config = machineConfig(stateDir, home);
    fs.mkdirSync(path.dirname(config.plistPath), { recursive: true });
    fs.writeFileSync(config.plistPath, "existing plist");
    const spawnSyncImpl = vi.fn(() => ({
      status: 5,
      stdout: "",
      stderr: "Boot-out failed: Input/output error",
    })) as unknown as typeof spawnSync;

    expect(() => disableAutostart(config, { platform: "darwin", uid: 501, spawnSyncImpl })).toThrow(
      /bootout failed/,
    );
    expect(spawnSyncImpl).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(config.plistPath, "utf8")).toBe("existing plist");
  });

  it("unloads the fixed label when its plist is already missing", () => {
    const stateDir = isolateStateDir();
    const home = makeTmpDir("autostart-disable-missing-plist-home");
    dirs.push(stateDir, home);
    const config = machineConfig(stateDir, home);
    const responses = [
      { status: 1, stdout: "", stderr: "No such file" },
      { status: 0, stdout: "", stderr: "" },
    ];
    const spawnSyncImpl = vi.fn(() => responses.shift()!) as unknown as typeof spawnSync;

    const result = disableAutostart(config, { platform: "darwin", uid: 501, spawnSyncImpl });

    expect(result.commands).toHaveLength(2);
    expect(spawnSyncImpl).toHaveBeenNthCalledWith(
      2,
      "launchctl",
      ["bootout", `gui/501/${config.label}`],
      { encoding: "utf8" },
    );
    expect(fs.existsSync(config.plistPath)).toBe(false);
  });

  it("reports unsupported platforms without invoking launchctl", () => {
    const stateDir = makeTmpDir("autostart-status-state");
    const home = makeTmpDir("autostart-status-home");
    dirs.push(stateDir, home);
    const config = machineConfig(stateDir, home);
    fs.mkdirSync(path.dirname(config.plistPath), { recursive: true });
    fs.writeFileSync(config.plistPath, "plist");
    const spawnSyncImpl = vi.fn() as unknown as typeof spawnSync;

    expect(autostartStatus(config, { platform: "linux", spawnSyncImpl })).toEqual({
      config,
      enabled: true,
      loaded: null,
      detail: "unsupported platform",
    });
    expect(spawnSyncImpl).not.toHaveBeenCalled();
  });
});
