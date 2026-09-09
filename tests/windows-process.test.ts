import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { makeTmpDir, cleanup, makeGitRepo, write } from "./helpers.js";

const spawnSyncCalls: { file: string; args: any[]; options: any }[] = [];
const spawnCalls: { file: string; args: any[]; options: any }[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (file: string, args: any, options: any) => {
      spawnSyncCalls.push({ file, args, options });
      return actual.spawnSync(file, args, options);
    },
    spawn: (file: string, args: any, options: any) => {
      spawnCalls.push({ file, args, options });
      return actual.spawn(file, args, options);
    },
  };
});

// Import modules under test after mock is established
import { runGit } from "../src/workspace/git.js";
import { findRipgrep, resetRipgrepCache, searchWorkspace } from "../src/workspace/search.js";
import { Workspace } from "../src/workspace/manager.js";
import { findBinary } from "../src/tunnel/detect.js";
import { ProcessCloudflaredAccount } from "../src/tunnel/named-provision.js";

describe("Windows background subprocess windowsHide: true (RED verification)", () => {
  let tmpDir: string;

  beforeEach(() => {
    spawnSyncCalls.length = 0;
    spawnCalls.length = 0;
    tmpDir = makeTmpDir("win-process-test");
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it("1. runGit in src/workspace/git.ts passes windowsHide: true", () => {
    makeGitRepo(tmpDir);
    spawnSyncCalls.length = 0;
    runGit(tmpDir, ["status", "--porcelain"]);
    const gitCall = spawnSyncCalls.find((c) => c.file === "git");
    expect(gitCall).toBeDefined();
    expect(gitCall?.options).toHaveProperty("windowsHide", true);
  });

  it("2. findRipgrep in src/workspace/search.ts passes windowsHide: true for candidate probe", () => {
    resetRipgrepCache();
    findRipgrep();
    const probeCall = spawnSyncCalls.find((c) => Array.isArray(c.args) && c.args[0] === "--version");
    expect(probeCall).toBeDefined();
    expect(probeCall?.options).toHaveProperty("windowsHide", true);
  });

  it("3. searchWithRipgrep in src/workspace/search.ts passes windowsHide: true for search process", async () => {
    process.env.C2C_RG_PATH = "fake-rg";
    resetRipgrepCache();
    write(tmpDir, "sample.txt", "hello windowsHide\n");
    const ws = new Workspace(tmpDir);
    spawnCalls.length = 0;
    try {
      await searchWorkspace(ws, { query: "hello" });
    } catch {
      // rg execution may fail with fake binary, but spawn was called
    } finally {
      delete process.env.C2C_RG_PATH;
      resetRipgrepCache();
    }
    const searchCall = spawnCalls.find((c) => c.file === "fake-rg");
    expect(searchCall).toBeDefined();
    expect(searchCall?.options).toHaveProperty("windowsHide", true);
  });

  it("4. findBinary in src/tunnel/detect.ts passes windowsHide: true for binary probe", () => {
    findBinary("cloudflared");
    const probeCall = spawnSyncCalls.find((c) => Array.isArray(c.args) && c.args[0] === "--version");
    expect(probeCall).toBeDefined();
    expect(probeCall?.options).toHaveProperty("windowsHide", true);
  });

  it("5. ProcessCloudflaredAccount.run in src/tunnel/named-provision.ts passes windowsHide: true", async () => {
    const account = new ProcessCloudflaredAccount("fake-cloudflared");
    try {
      await account.listTunnels();
    } catch {
      // Expected to fail execution, but spawnSync should record call
    }
    const provisionCall = spawnSyncCalls.find((c) => c.file === "fake-cloudflared");
    expect(provisionCall).toBeDefined();
    expect(provisionCall?.options).toHaveProperty("windowsHide", true);
  });

  it("6. src/cli/index.ts update-check runGit passes windowsHide: true", () => {
    const cliSource = fs.readFileSync(path.resolve("src/cli/index.ts"), "utf8");
    // Verify runGit under update-check in cli/index.ts includes windowsHide: true
    const updateCheckSection = cliSource.slice(cliSource.indexOf("// ---------------------------------------------------------------- update-check"));
    const runGitSnippet = updateCheckSection.slice(0, updateCheckSection.indexOf("program"));
    expect(runGitSnippet).toContain("windowsHide: true");
  });
});
