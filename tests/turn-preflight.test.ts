import { describe, expect, it } from "vitest";
import { assessPluginPreflight, type PluginPreflight } from "../src/session/turn-preflight.js";

const now = Date.now();
const turn = { workspaceId: "workspace-a", localSessionId: "session-a", taskId: "task-a", iteration: 0, phase: "PLAN", generation: 1, plugins: ["GitHub"] };
const surface = { tabId: "tab-a", generation: 1, chatUrl: "https://chatgpt.com/g/g-p-project-a/c/chat-a" };
function proof(): PluginPreflight {
  return {
    ...turn, ...surface, bootEpoch: "epoch-a", observedAt: new Date(now).toISOString(), chatgptAccount: "observed-account-key",
    requestedOperations: [{ plugin: "GitHub", tool: "read_repository" }],
    plugins: [{ id: "GitHub", availability: "available", usesGitHub: true,
      tools: [{ tool: "read_repository", availability: "available", effect: "read" }, { tool: "create_issue", availability: "available", effect: "write" }],
      githubActor: { id: "123", login: "expected-user", source: "authenticated-profile" } }],
    github: { repository: { host: "github.com", owner: "an-organization", name: "repo" }, expectedActor: { id: "123", login: "expected-user" } },
  };
}
const check = (p = proof(), time = now) => assessPluginPreflight({ ...turn, pluginPreflight: p }, surface, "epoch-a", time);

describe("plugin dispatch preflight", () => {
  it("bootstraps an unknown actor with only an observed own-profile operation", () => {
    const p = proof();
    p.phase = "RESEARCH";
    delete p.plugins[0].githubActor;
    delete p.github;
    delete p.requestedOperations;
    p.plugins[0].authenticatedProfileTool = "get_authenticated_user";
    const discovery = { ...turn, phase: "RESEARCH", pluginIntent: "identity-discovery" as const, scopes: ["c2c.result.write"], pluginPreflight: p };
    const policy = assessPluginPreflight(discovery, surface, "epoch-a", now);
    expect(policy).toEqual({ allowedPlugins: ["GitHub"], access: "authenticated-profile-only", repositoryAccess: "none", allowedOperations: [{ plugin: "GitHub", tool: "get_authenticated_user" }] });
    expect(() => assessPluginPreflight({ ...discovery, pluginIntent: "task" }, surface, "epoch-a", now)).toThrow(/unknown/);
    expect(() => assessPluginPreflight({ ...discovery, scopes: ["git.read"] }, surface, "epoch-a", now)).toThrow(/result-only/);
    expect(() => assessPluginPreflight({ ...discovery, plugins: [] }, surface, "epoch-a", now)).toThrow(/one plugin/);
    expect(() => assessPluginPreflight({ ...discovery, phase: "PLAN" }, surface, "epoch-a", now)).toThrow(/RESEARCH/);
    expect(() => assessPluginPreflight(discovery, surface, "another-epoch", now)).toThrow(/stale/);
    delete p.plugins[0].authenticatedProfileTool;
    expect(() => assessPluginPreflight(discovery, surface, "epoch-a", now)).toThrow(/own-profile tool/);
  });

  it("allows only requested read-only apps and does not equate organization owner with actor", () => {
    expect(check()).toMatchObject({ allowedPlugins: ["GitHub"], allowedOperations: [{ plugin: "GitHub", tool: "read_repository" }], access: "read-only", repository: { owner: "an-organization" } });
    expect(assessPluginPreflight({ ...turn, plugins: [] }, null, "epoch-a")).toEqual({ allowedPlugins: [], access: "read-only" });
  });
  it("supports exposed reads from non-GitHub apps without granting sibling writes", () => {
    const p = proof(); delete p.github;
    p.plugins = [{ id: "Docs", availability: "available", usesGitHub: false, tools: [
      { tool: "search_docs", availability: "available", effect: "read" },
      { tool: "publish_doc", availability: "available", effect: "write" },
    ] }];
    p.requestedOperations = [{ plugin: "Docs", tool: "search_docs" }];
    const assess = () => assessPluginPreflight({ ...turn, plugins: ["Docs"], pluginPreflight: p }, surface, "epoch-a", now);
    expect(assess()).toEqual({ allowedPlugins: ["Docs"], access: "read-only", allowedOperations: p.requestedOperations });
    p.requestedOperations[0].tool = "publish_doc";
    expect(assess).toThrow(/read-only tool/);
  });
  it("rejects app-wide, missing, duplicate, wildcard and unrequested tool grants", () => {
    const p = proof(); delete p.requestedOperations;
    expect(() => check(p)).toThrow(/requestedOperations/);
    const missing = proof(); delete missing.plugins[0].tools;
    expect(() => check(missing)).toThrow(/read-only tool/);
    const duplicate = proof(); duplicate.requestedOperations!.push(duplicate.requestedOperations![0]);
    expect(() => check(duplicate)).toThrow(/Duplicate requested/);
    const observed = proof(); observed.plugins[0].tools!.push(observed.plugins[0].tools![0]);
    expect(() => check(observed)).toThrow(/duplicate observed/);
    for (const tool of ["*", "read_*", "unknown_tool"]) {
      const wrong = proof(); wrong.requestedOperations![0].tool = tool;
      expect(() => check(wrong)).toThrow();
    }
    const other = proof(); other.requestedOperations!.push({ plugin: "Other", tool: "search" });
    expect(() => check(other)).toThrow(/read-only tool/);
  });
  it("requires every selected app to have a requested operation", () => {
    const p = proof(); p.plugins.push({ id: "Docs", availability: "available", usesGitHub: false });
    expect(() => assessPluginPreflight({ ...turn, plugins: ["GitHub", "Docs"], pluginPreflight: p }, surface, "epoch-a", now)).toThrow(/no requested operation/);
  });
  it.each(["unavailable", "work-only", "consent-required", "unknown"] as const)("rejects an individually %s tool in an available app", (availability) => {
    const p = proof(); p.plugins[0].tools![0].availability = availability;
    expect(() => check(p)).toThrow(/read-only tool/);
  });
  it.each(["write", "profile", "unknown"] as const)("does not grant a %s effect in ordinary tasks", (effect) => {
    const p = proof(); p.plugins[0].tools![0].effect = effect;
    expect(() => check(p)).toThrow(/read-only tool/);
  });
  it.each(["unavailable", "work-only", "consent-required", "unknown"] as const)("blocks %s before dispatch", (availability) => {
    const p = proof(); p.plugins[0].availability = availability;
    expect(() => check(p)).toThrow(/not available/);
  });
  it("blocks unknown and mismatched actors including GitHub-dependent bundles", () => {
    const p = proof(); delete p.plugins[0].githubActor;
    expect(() => check(p)).toThrow(/unknown/);
    const wrong = proof(); wrong.plugins[0].githubActor!.id = "456";
    expect(() => check(wrong)).toThrow(/account does not match/);
    const bundle = proof(); bundle.plugins[0].id = "Analytics"; delete bundle.plugins[0].githubActor;
    expect(() => assessPluginPreflight({ ...turn, plugins: ["Analytics"], pluginPreflight: bundle }, surface, "epoch-a", now)).toThrow(/unknown/);
  });
  it("rejects stale or cross-task/session/page evidence and unexpected plugin sets", () => {
    for (const field of ["workspaceId", "localSessionId", "taskId", "phase", "tabId", "bootEpoch"] as const) {
      const p = proof(); p[field] = "other";
      expect(() => check(p), field).toThrow();
    }
    const p = proof(); p.generation = 2; expect(() => check(p)).toThrow();
    expect(() => check(proof(), now + 300001)).toThrow(/stale/);
    expect(() => check(proof(), now - 1)).toThrow(/stale/);
    const extra = proof(); extra.plugins.push(extra.plugins[0]); expect(() => check(extra)).toThrow(/exactly/);
    const wrongChat = proof(); wrongChat.chatUrl = surface.chatUrl.replace("chat-a", "chat-b"); expect(() => check(wrongChat)).toThrow(/owned chat/);
  });
});
