import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendExecutionRecord } from "./records.js";
import { saveExecutionOutput } from "./output.js";
import type { Workspace } from "../workspace/manager.js";

export const AGT_WORKSPACE_ROOT = "/Users/maccow/Projects/Armed-Gal-Tactical-lab-godot";
export const CODEX_EXECUTABLE = "/Applications/ChatGPT.app/Contents/Resources/codex";
export const PROBE_FILE = "codex_staging_probe.txt";
export const PROBE_MARKER = "STAGING_CODEX_EDIT_OK";

const MAX_CAPTURE_BYTES = 256 * 1024;
const PROBE_TIMEOUT_MS = 5 * 60_000;
const FIXED_PROMPT = [
  "Inspect this staging workspace.",
  `Do not modify any existing file. Create exactly one new file named ${PROBE_FILE} containing exactly ${PROBE_MARKER} followed by a newline.`,
  `Read ${PROBE_FILE} back, then run exactly this harmless local validation: test \"$(cat ${PROBE_FILE})\" = \"${PROBE_MARKER}\".`,
  "Do not use git, do not make any network request, do not commit, and do not push.",
].join(" ");

export type ProbeResult = { taskId: string; exitStatus: "ok" | "failed"; exitCode: number | null; verified: boolean; outputId: number };
type ProcessResult = { exitCode: number | null; output: string };

export interface CodexProbeDeps {
  /** Test seam only. Production always uses the fixed AGT root. */
  expectedWorkspaceRoot?: string;
  /** Test seam only. Must be a private temporary parent directory. */
  tempParent?: string;
  /** Test seam only. Production launches the fixed Codex executable. */
  runProcess?: (cwd: string) => Promise<ProcessResult>;
}

function excludedName(name: string): boolean {
  const lower = name.toLowerCase();
  return name === ".git" || name === ".godot" || name === ".cursor" || name === ".DS_Store" ||
    name === "build" || name === "dist" || name === "node_modules" || /^\.env(?:\.|$)/i.test(name) ||
    /(credential|secret)/i.test(name) || /^(id_rsa|id_ed25519|known_hosts)$/i.test(name) ||
    /\.(pem|key|p12|pfx)$/i.test(name) || /^\.p\d+[a-z_]*\.png$/i.test(name) || lower.endsWith(".cache");
}

function copyStaging(source: string, parent?: string): string {
  const stageRoot = fs.mkdtempSync(path.join(parent ?? os.tmpdir(), "c2c-codex-probe-"));
  const workspace = path.join(stageRoot, "workspace");
  try {
    fs.cpSync(source, workspace, { recursive: true, filter: (src) => !excludedName(path.basename(src)) && !fs.lstatSync(src).isSymbolicLink() });
    return workspace;
  } catch (error) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

function stagingHasNoGit(cwd: string): boolean {
  if (fs.existsSync(path.join(cwd, ".git"))) return false;
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd, encoding: "utf8", timeout: 3000, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  return !result.error && (result.status !== 0 || result.stdout.trim() !== "true");
}

function cappedAppend(existing: string, chunk: Buffer | string): string {
  if (Buffer.byteLength(existing, "utf8") >= MAX_CAPTURE_BYTES) return existing;
  const available = MAX_CAPTURE_BYTES - Buffer.byteLength(existing, "utf8");
  return existing + Buffer.from(chunk).subarray(0, available).toString("utf8");
}

function launchFixedCodex(cwd: string): Promise<ProcessResult> {
  const args = ["--strict-config", "-s", "workspace-write", "-a", "never", "-c", 'approval_policy="never"', "exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "-C", cwd, FIXED_PROMPT];
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.SSH_AUTH_SOCK; delete env.GH_TOKEN; delete env.GITHUB_TOKEN; delete env.GIT_ASKPASS;
    env.GIT_CONFIG_GLOBAL = "/dev/null"; env.GIT_CONFIG_NOSYSTEM = "1"; env.GIT_TERMINAL_PROMPT = "0";
    const child = spawn(CODEX_EXECUTABLE, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), PROBE_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => { output = cappedAppend(output, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { output = cappedAppend(output, chunk); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ exitCode: code, output }); });
  });
}

function verifyProbe(cwd: string): boolean {
  const file = path.join(cwd, PROBE_FILE);
  try { return fs.lstatSync(file).isFile() && fs.readFileSync(file, "utf8") === `${PROBE_MARKER}\n`; } catch { return false; }
}

export async function runCodexProbe(workspace: Workspace, deps: CodexProbeDeps = {}): Promise<ProbeResult> {
  const expectedRoot = fs.realpathSync.native(deps.expectedWorkspaceRoot ?? AGT_WORKSPACE_ROOT);
  if (workspace.root !== expectedRoot) throw new Error("CODEX_PROBE_WORKSPACE_DENIED: codex_probe is available only for the Armed Gal Tactical Lab workspace.");
  const taskId = `codex_probe_${randomBytes(8).toString("hex")}`;
  let stage = ""; let output = ""; let exitCode: number | null = null; let verified = false;
  try {
    stage = copyStaging(workspace.root, deps.tempParent);
    if (!stagingHasNoGit(stage)) throw new Error("CODEX_PROBE_STAGING_GIT_PRESENT");
    const result = await (deps.runProcess ?? launchFixedCodex)(stage);
    output = result.output; exitCode = result.exitCode; verified = result.exitCode === 0 && verifyProbe(stage);
  } catch (error) {
    output = cappedAppend(output, error instanceof Error ? error.message : String(error));
  } finally {
    if (stage) fs.rmSync(path.dirname(stage), { recursive: true, force: true });
  }
  const saved = saveExecutionOutput(workspace.id, { command: "codex_probe (isolated staging only)", raw: output, exitCode, taskId, iteration: 1 });
  const exitStatus = verified ? "ok" : "failed";
  appendExecutionRecord(workspace.id, {
    taskId, iteration: 1, changedFiles: verified ? [PROBE_FILE] : 0,
    tests: verified ? "staging probe marker validation passed" : "staging probe marker validation failed", exitStatus,
    timestamp: new Date().toISOString(), notes: "Isolated temporary staging probe; no live workspace files were applied.", outputId: saved.id, outputAvailable: saved.allowed,
  });
  return { taskId, exitStatus, exitCode, verified, outputId: saved.id };
}
