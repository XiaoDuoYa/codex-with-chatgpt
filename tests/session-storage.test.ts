import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { cleanup, makeGitRepo, makeTmpDir } from "./helpers.js";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const sourceUrl = (file: string) => pathToFileURL(path.join(sourceRoot, file)).href;
const projectUrl = "https://chatgpt.com/g/g-p-storage/project";
const chatUrl = "https://chatgpt.com/g/g-p-storage/c/one";

describe("cross-process repository session storage", () => {
  it("merges CLI checkpoints and tunnel-child routes into the same repository file", () => {
    const root = makeTmpDir("session-storage-repo");
    const stateRoot = makeTmpDir("session-storage-machine");
    try {
      makeGitRepo(root);
      const run = (tunnel: boolean, action: string) => {
        const env = { ...process.env };
        delete env.C2C_STATE_DIR;
        const result = spawnSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", `
          import { Workspace } from ${JSON.stringify(sourceUrl("workspace/manager.ts"))};
          import { getWorkspaceDataDir, getProjectDataDir } from ${JSON.stringify(sourceUrl("config/paths.ts"))};
          import { updateSession, commitSessionRoute, readSession, threadSessionFile } from ${JSON.stringify(sourceUrl("session/state.ts"))};
          import { minimalTunnelEnvironment } from ${JSON.stringify(sourceUrl("tunnel/openai-secure.ts"))};
          ${tunnel ? `process.env.C2C_STATE_DIR = minimalTunnelEnvironment(${JSON.stringify(stateRoot)}).C2C_STATE_DIR;` : ""}
          const ws = new Workspace(${JSON.stringify(root)});
          ${action}
          console.log(JSON.stringify({ file: threadSessionFile(ws.id, "local-one"),
            projectDir: getProjectDataDir(ws.projectId), workspaceDir: getWorkspaceDataDir(ws.id),
            session: readSession(ws.id, "local-one") }));
        `], { cwd: fileURLToPath(new URL("..", import.meta.url)), env, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout);
      };
      const local = run(false, `updateSession(ws.id, "local-one", { checkpoint: {
        taskId: "recovery", iteration: 2, originalGoal: "preserve progress", protocolState: "PLAN_RECEIVED",
        waitingFor: "none", mailboxRequestId: "review-request", mailboxPhase: "PLAN",
        mailboxResultId: "received-result", updatedAt: new Date().toISOString()
      }});`);
      const machine = run(true, `commitSessionRoute(ws.id, "local-one", {
        projectUrl: ${JSON.stringify(projectUrl)}, chatUrl: ${JSON.stringify(chatUrl)},
        surfaceGeneration: 1, surfaceTabId: "owned-tab"
      });`);
      expect(machine.file).toBe(local.file);
      expect(machine.workspaceDir).toBe(path.join(root, ".git", "codex-with-chatgpt", "workspaces", path.basename(machine.workspaceDir)));
      expect(machine.projectDir).toBe(path.join(root, ".git", "codex-with-chatgpt"));
      expect(machine.session.checkpoint.mailboxResultId).toBe("received-result");
      const resumed = run(false, 'updateSession(ws.id, "local-one", { title: "resumed" });');
      expect(resumed.session).toMatchObject({ url: chatUrl, title: "resumed", surfaceTabId: "owned-tab" });
      expect(run(true, "").session).toEqual(resumed.session);
      expect(fs.existsSync(path.join(stateRoot, "workspace-data"))).toBe(false);
    } finally {
      cleanup(root);
      cleanup(stateRoot);
    }
  });
});
