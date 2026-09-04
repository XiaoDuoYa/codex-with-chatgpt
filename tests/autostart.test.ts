import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { spawnSync } from "node:child_process";
import {
  buildAutostartConfig,
  disableAutostart,
  enableAutostart,
  launchdLabelPart,
  normalizeAutostartIntervalSeconds,
  renderLaunchAgentPlist,
} from "../src/config/autostart.js";
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

afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

describe("autostart LaunchAgent", () => {
  it("runs C2C autostart instead of a cloudflared tunnel process", () => {
    dirs.push(isolateStateDir());
    const workspace = makeTmpDir("autostart-workspace");
    const home = makeTmpDir("autostart-home");
    dirs.push(workspace, home);
    write(workspace, ".c2c.json", JSON.stringify({ name: "Demo Workspace" }));
    const wrappedCloudflared = write(path.join(home, ".local", "bin"), "c2c-cloudflared", "#!/bin/sh\n");
    fs.chmodSync(wrappedCloudflared, 0o755);

    const config = buildAutostartConfig({
      workspaceRoot: workspace,
      c2cBinPath: "/checkout/bin/c2c.js",
      nodePath: "/node",
      homeDir: home,
      env: {
        PATH: "/usr/bin",
        C2C_NAMED_TUNNEL_START_TIMEOUT_MS: "90000",
      },
    });
    const plist = renderLaunchAgentPlist(config);

    expect(config.label).toBe(`dev.codex-with-chatgpt.demo-workspace-${config.workspaceId}`);
    expect(config.programArguments).toEqual([
      "/node",
      "/checkout/bin/c2c.js",
      "autostart",
      "run",
      "-w",
      workspace,
      "--quiet",
    ]);
    expect(config.environment.C2C_CLOUDFLARED_PATH).toBe(wrappedCloudflared);
    expect(config.environment.C2C_NAMED_TUNNEL_START_TIMEOUT_MS).toBe("90000");
    expect(plist).toContain("<key>StartInterval</key>");
    expect(plist).toContain("<integer>60</integer>");
    expect(plist).not.toContain("<key>KeepAlive</key>");
    expect(plist).not.toContain("keep-workspace-running.zsh");
    expect(plist).not.toContain("tunnel run");
  });

  it("sanitizes labels and falls back to the workspace id", () => {
    expect(launchdLabelPart("Wallet Rail", "abc123abc123")).toBe("wallet-rail-abc123abc123");
    expect(launchdLabelPart("钱包", "abc123abc123")).toBe("ws-abc123abc123");
    expect(launchdLabelPart("Wallet Rail", "def456def456")).not.toBe(
      launchdLabelPart("Wallet Rail", "abc123abc123")
    );
  });

  it("requires a bounded launch interval", () => {
    expect(normalizeAutostartIntervalSeconds()).toBe(60);
    expect(normalizeAutostartIntervalSeconds("300")).toBe(300);
    expect(() => normalizeAutostartIntervalSeconds("1")).toThrow(/interval/);
    expect(() => normalizeAutostartIntervalSeconds("60.5")).toThrow(/interval/);
    expect(() => normalizeAutostartIntervalSeconds("abc")).toThrow(/interval/);
  });

  it("uses the label fallback before enabling a LaunchAgent", () => {
    dirs.push(isolateStateDir());
    const workspace = makeTmpDir("autostart-enable-workspace");
    const home = makeTmpDir("autostart-enable-home");
    dirs.push(workspace, home);
    write(workspace, ".c2c.json", JSON.stringify({ name: "Enable Workspace" }));
    const executables = executablePaths(home);
    const config = buildAutostartConfig({
      workspaceRoot: workspace,
      ...executables,
      homeDir: home,
    });
    const responses = [
      { status: 5, stdout: "", stderr: "Boot-out failed: Input/output error" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ];
    const spawnSyncImpl = vi.fn(() => responses.shift()!) as unknown as typeof spawnSync;

    const result = enableAutostart(config, { platform: "darwin", uid: 501, spawnSyncImpl });

    expect(result.commands).toHaveLength(4);
    expect(spawnSyncImpl).toHaveBeenNthCalledWith(
      2,
      "launchctl",
      ["bootout", `gui/501/${config.label}`],
      { encoding: "utf8" }
    );
    expect(fs.existsSync(config.plistPath)).toBe(true);
  });

  it("restores the previous LaunchAgent when both enable bootout forms fail", () => {
    dirs.push(isolateStateDir());
    const workspace = makeTmpDir("autostart-enable-fail-workspace");
    const home = makeTmpDir("autostart-enable-fail-home");
    dirs.push(workspace, home);
    write(workspace, ".c2c.json", JSON.stringify({ name: "Enable Fail Workspace" }));
    const executables = executablePaths(home);
    const config = buildAutostartConfig({
      workspaceRoot: workspace,
      ...executables,
      homeDir: home,
    });
    fs.mkdirSync(path.dirname(config.plistPath), { recursive: true });
    fs.writeFileSync(config.plistPath, "existing plist");
    const responses = [
      { status: 5, stdout: "", stderr: "Boot-out failed: Input/output error" },
      { status: 5, stdout: "", stderr: "Boot-out failed: Input/output error" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ];
    const spawnSyncImpl = vi.fn(() => responses.shift()!) as unknown as typeof spawnSync;

    expect(() => enableAutostart(config, { platform: "darwin", uid: 501, spawnSyncImpl })).toThrow(
      /bootout failed/
    );
    expect(spawnSyncImpl).toHaveBeenCalledTimes(5);
    expect(fs.readFileSync(config.plistPath, "utf8")).toBe("existing plist");
  });

  it("restores the previous LaunchAgent when writing the replacement plist fails", () => {
    dirs.push(isolateStateDir());
    const workspace = makeTmpDir("autostart-write-rollback-workspace");
    const home = makeTmpDir("autostart-write-rollback-home");
    dirs.push(workspace, home);
    const config = buildAutostartConfig({ workspaceRoot: workspace, ...executablePaths(home), homeDir: home });
    fs.mkdirSync(path.dirname(config.plistPath), { recursive: true });
    fs.writeFileSync(config.plistPath, "previous plist");
    const responses = [
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ];
    const spawnSyncImpl = vi.fn(() => responses.shift()!) as unknown as typeof spawnSync;
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("simulated plist write failure");
    });

    expect(() => enableAutostart(config, { platform: "darwin", uid: 501, spawnSyncImpl })).toThrow(
      /simulated plist write failure/
    );
    expect(fs.readFileSync(config.plistPath, "utf8")).toBe("previous plist");
    expect(spawnSyncImpl).toHaveBeenCalledTimes(3);
  });

  it("restores the previous LaunchAgent when bootstrap fails", () => {
    dirs.push(isolateStateDir());
    const workspace = makeTmpDir("autostart-bootstrap-rollback-workspace");
    const home = makeTmpDir("autostart-bootstrap-rollback-home");
    dirs.push(workspace, home);
    const config = buildAutostartConfig({ workspaceRoot: workspace, ...executablePaths(home), homeDir: home });
    fs.mkdirSync(path.dirname(config.plistPath), { recursive: true });
    fs.writeFileSync(config.plistPath, "previous plist");
    const responses = [
      { status: 0, stdout: "", stderr: "" },
      { status: 5, stdout: "", stderr: "bootstrap rejected" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ];
    const spawnSyncImpl = vi.fn(() => responses.shift()!) as unknown as typeof spawnSync;

    expect(() => enableAutostart(config, { platform: "darwin", uid: 501, spawnSyncImpl })).toThrow(
      /bootstrap rejected/
    );
    expect(fs.readFileSync(config.plistPath, "utf8")).toBe("previous plist");
    expect(spawnSyncImpl).toHaveBeenCalledTimes(5);
  });

  it("unloads the replacement and restores the previous LaunchAgent when kickstart fails", () => {
    dirs.push(isolateStateDir());
    const workspace = makeTmpDir("autostart-kickstart-rollback-workspace");
    const home = makeTmpDir("autostart-kickstart-rollback-home");
    dirs.push(workspace, home);
    const config = buildAutostartConfig({ workspaceRoot: workspace, ...executablePaths(home), homeDir: home });
    fs.mkdirSync(path.dirname(config.plistPath), { recursive: true });
    fs.writeFileSync(config.plistPath, "previous plist");
    const responses = [
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 5, stdout: "", stderr: "kickstart rejected" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ];
    const spawnSyncImpl = vi.fn(() => responses.shift()!) as unknown as typeof spawnSync;

    expect(() => enableAutostart(config, { platform: "darwin", uid: 501, spawnSyncImpl })).toThrow(
      /kickstart rejected/
    );
    expect(fs.readFileSync(config.plistPath, "utf8")).toBe("previous plist");
    expect(spawnSyncImpl).toHaveBeenCalledTimes(6);
  });

  it("validates executables before unloading an existing LaunchAgent", () => {
    dirs.push(isolateStateDir());
    const workspace = makeTmpDir("autostart-invalid-executable-workspace");
    const home = makeTmpDir("autostart-invalid-executable-home");
    dirs.push(workspace, home);
    const config = buildAutostartConfig({
      workspaceRoot: workspace,
      nodePath: path.join(home, "missing-node"),
      c2cBinPath: path.join(home, "missing-c2c"),
      homeDir: home,
    });
    fs.mkdirSync(path.dirname(config.plistPath), { recursive: true });
    fs.writeFileSync(config.plistPath, "previous plist");
    const spawnSyncImpl = vi.fn() as unknown as typeof spawnSync;

    expect(() => enableAutostart(config, { platform: "darwin", uid: 501, spawnSyncImpl })).toThrow(
      /Node executable is missing or not executable/
    );
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(fs.readFileSync(config.plistPath, "utf8")).toBe("previous plist");
  });

  it("keeps the plist when both disable bootout forms fail", () => {
    dirs.push(isolateStateDir());
    const workspace = makeTmpDir("autostart-disable-fail-workspace");
    const home = makeTmpDir("autostart-disable-fail-home");
    dirs.push(workspace, home);
    write(workspace, ".c2c.json", JSON.stringify({ name: "Disable Fail Workspace" }));
    const config = buildAutostartConfig({
      workspaceRoot: workspace,
      c2cBinPath: "/checkout/bin/c2c.js",
      nodePath: "/node",
      homeDir: home,
    });
    fs.mkdirSync(path.dirname(config.plistPath), { recursive: true });
    fs.writeFileSync(config.plistPath, "existing plist");
    const spawnSyncImpl = vi.fn(() => ({
      status: 5,
      stdout: "",
      stderr: "Boot-out failed: Input/output error",
    })) as unknown as typeof spawnSync;

    expect(() => disableAutostart(config, { platform: "darwin", uid: 501, spawnSyncImpl })).toThrow(
      /bootout failed/
    );
    expect(spawnSyncImpl).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(config.plistPath, "utf8")).toBe("existing plist");
  });
});
