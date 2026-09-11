import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { PROBE_FILE, PROBE_MARKER, runCodexProbe } from "../src/execution/codex-probe.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()!); });

describe("codex staging probe", () => {
  it("uses a non-Git staging copy, excludes sensitive/cache data, and never applies to live", async () => {
    isolateStateDir();
    const live = makeTmpDir("probe-live");
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-probe-stage-test-"));
    dirs.push(live, parent);
    makeGitRepo(live);
    write(live, "scripts/live.gd", "extends Node\n");
    write(live, ".env", "TOKEN=secret\n");
    write(live, ".godot/cache.bin", "cache\n");
    write(live, ".cursor/state.json", "cache\n");
    write(live, "private.pem", "private\n");
    write(live, ".p1a_preview.png", "render\n");
    const workspace = new Workspace(live);
    let stage = "";
    const result = await runCodexProbe(workspace, {
      expectedWorkspaceRoot: live,
      tempParent: parent,
      runProcess: async (cwd) => {
        stage = cwd;
        expect(fs.existsSync(path.join(cwd, ".git"))).toBe(false);
        expect(fs.existsSync(path.join(cwd, ".env"))).toBe(false);
        expect(fs.existsSync(path.join(cwd, ".godot"))).toBe(false);
        expect(fs.existsSync(path.join(cwd, ".cursor"))).toBe(false);
        expect(fs.existsSync(path.join(cwd, "private.pem"))).toBe(false);
        expect(fs.existsSync(path.join(cwd, ".p1a_preview.png"))).toBe(false);
        expect(fs.readFileSync(path.join(cwd, "scripts/live.gd"), "utf8")).toBe("extends Node\n");
        fs.writeFileSync(path.join(cwd, PROBE_FILE), `${PROBE_MARKER}\n`);
        return { exitCode: 0, output: "probe validation passed" };
      },
    });
    expect(result.exitStatus).toBe("ok");
    expect(result.verified).toBe(true);
    expect(fs.existsSync(path.join(live, PROBE_FILE))).toBe(false);
    expect(fs.existsSync(stage)).toBe(false);
  });

  it("fails closed before staging when the workspace is not the fixed root", async () => {
    const live = makeTmpDir("probe-denied");
    dirs.push(live);
    makeGitRepo(live);
    const workspace = new Workspace(live);
    const other = makeTmpDir("other-root");
    dirs.push(other);
    await expect(runCodexProbe(workspace, { expectedWorkspaceRoot: other })).rejects.toThrow(
      "CODEX_PROBE_WORKSPACE_DENIED"
    );
    expect(fs.existsSync(path.join(live, PROBE_FILE))).toBe(false);
  });
});
