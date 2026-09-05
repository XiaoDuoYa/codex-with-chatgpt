import { afterEach, describe, expect, it } from "vitest";
import { validateProjectSelection } from "../src/session/project-selection.js";
import { MachineGateway } from "../src/gateway/machine-gateway.js";
import { cleanup, isolateStateDir, makeTmpDir, projectSelection } from "./helpers.js";

const url = "https://chatgpt.com/g/g-p-test-project/project";
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(cleanup); delete process.env.C2C_STATE_DIR; });

describe("first Project provenance", () => {
  it("rejects missing, wrong-name, mismatched-URL and stale observations", () => {
    const evidence = { ...projectSelection(url), source: "created", observedTitle: "quant-insight" };
    expect(() => validateProjectSelection(undefined, url, "quant-insight")).toThrow(/First Project/);
    expect(() => validateProjectSelection(evidence, url, "another-workspace")).toThrow(/title/);
    expect(() => validateProjectSelection(evidence, "https://chatgpt.com/g/g-p-other/project", "quant-insight")).toThrow(/URL/);
    expect(() => validateProjectSelection(evidence, url, "quant-insight", Date.parse(evidence.observedAt) + 300001)).toThrow(/stale/);
    expect(validateProjectSelection(evidence, url, "quant-insight").source).toBe("created");
    expect(validateProjectSelection(projectSelection(url), url, "different-display-name").source).toBe("user-confirmed");
  });

  it("blocks unregistered unrelated Projects before BOOT and keeps candidate evidence through restart", () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("quant-insight"); dirs.push(root);
    const gateway = new MachineGateway();
    const registration = gateway.registerWorkspace(root);
    const identity = { ...registration, localSessionId: "session-new" };
    const input = { browserId: "iab", surfaceId: "chatgpt", tabId: "tab-new", projectUrl: url, leaseTtlMs: 60000 };
    expect(() => gateway.surfaceClaim(identity, input)).toThrow(/First Project/);
    expect(gateway.surfaceGet(identity)).toMatchObject({ lease: null, projectUrl: null });
    const candidate = gateway.surfaceClaim(identity, { ...input, projectSelection: projectSelection(url) });
    const restarted = new MachineGateway();
    const resumed = { ...restarted.registerWorkspace(root), localSessionId: identity.localSessionId };
    expect(restarted.surfaceGet(resumed).lease?.projectSelection?.source).toBe("user-confirmed");
    restarted.surfaceCommit(resumed, candidate, { chatUrl: url.replace("/project", "/c/chat-a") });
    expect(restarted.surfaceGet(resumed).projectUrl).toBe(url);
    expect(() => restarted.surfaceCommit(resumed, candidate, { chatUrl: url.replace("/project", "/c/chat-b") })).toThrow(/fresh generation/);
    expect(restarted.surfaceGet(resumed).binding?.chatUrl).toContain("chat-a");
    const turn = {
      workspaceId: resumed.workspaceId, projectId: resumed.projectId, registrationId: resumed.registrationId,
      localSessionId: resumed.localSessionId, taskId: "plugin-task", iteration: 0, phase: "PLAN",
      generation: candidate.generation, compactionEpoch: 0, scopes: ["workspace.read"], plugins: ["GitHub"],
    };
    expect(() => restarted.issueTurn(turn)).toThrow();
    expect(restarted.stats().capabilityCount).toBe(0);
    const other = makeTmpDir("other-workspace"); dirs.push(other);
    const otherIdentity = { ...restarted.registerWorkspace(other), localSessionId: "session-other" };
    expect(() => restarted.surfaceClaim(otherIdentity, { ...input, tabId: "tab-other", projectSelection: projectSelection(url) })).toThrow(/different local project/);
  });
});
