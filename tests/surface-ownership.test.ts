import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, isolateStateDir } from "./helpers.js";
import {
  claimSurface,
  commitVerifiedSurfaceRoute,
  currentOwnerProcessEpoch,
  currentProjectUrl,
  currentSurfaceBinding,
  currentSurfaceLease,
  listSurfaceLeases,
  reapExpiredSurfaceLeases,
  releaseSurface,
  renewSurface,
  retireSurfaceSession,
  machineSurfaceOwnershipFile,
  surfaceOwnershipFile,
  SurfaceOwnershipError,
  unregisterSurfaceOwnership,
} from "../src/session/surface-ownership.js";

const PROJECT_URL = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
const CHAT_URL = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-main";
const OTHER_PROJECT_URL = "https://chatgpt.com/g/g-p-other-project/project";
const OTHER_CHAT_URL = "https://chatgpt.com/g/g-p-other-project/c/chat-other";
const START = new Date("2026-01-01T00:00:00.000Z");

const dirs: string[] = [];

function stateDir(): string {
  const dir = isolateStateDir();
  dirs.push(dir);
  return dir;
}

function claimOnly(localSessionId: string, tabId: string, overrides: Partial<Parameters<typeof claimSurface>[0]> = {}) {
  return claimSurface({
    projectId: "project-alpha",
    localSessionId,
    browserId: "iab",
    surfaceId: "chatgpt",
    tabId,
    projectUrl: PROJECT_URL,
    chatUrl: CHAT_URL,
    ownerProcessEpoch: "owner-epoch-test",
    now: START,
    leaseTtlMs: 60_000,
    ...overrides,
  });
}

function claim(localSessionId: string, tabId: string, overrides: Partial<Parameters<typeof claimSurface>[0]> = {}) {
  const lease = claimOnly(localSessionId, tabId, overrides);
  commitVerifiedSurfaceRoute({
    lease,
    workspaceId: overrides.projectId ?? "workspace-alpha",
    connectorName: "Codex with ChatGPT",
    now: overrides.now ?? START,
  });
  return lease;
}

afterEach(() => {
  for (const dir of dirs) cleanup(dir);
  dirs.length = 0;
  delete process.env.C2C_STATE_DIR;
});

describe("persistent ChatGPT surface ownership", () => {
  it("does not persist an unverified candidate page", () => {
    stateDir();
    const candidate = claimOnly("session-a", "tab-a");

    expect(currentSurfaceBinding("project-alpha", "session-a")).toBeNull();
    expect(currentProjectUrl("project-alpha")).toBeNull();
    expect(releaseSurface(candidate, START)).toBe(true);
    expect(currentSurfaceBinding("project-alpha", "session-a")).toBeNull();
    expect(currentProjectUrl("project-alpha")).toBeNull();

    const verified = claimOnly("session-a", "tab-a");
    expect(commitVerifiedSurfaceRoute({
      lease: verified,
      workspaceId: "workspace-alpha",
      connectorName: "Codex with ChatGPT",
      now: START,
    }).binding).toMatchObject({
      tabId: "tab-a",
      chatUrl: CHAT_URL,
      lastGeneration: 2,
    });
    expect(currentSurfaceBinding("project-alpha", "session-a")?.chatUrl).toBe(CHAT_URL);
  });

  it("accepts only the in-app ChatGPT surface identity", () => {
    stateDir();

    expect(() => claimOnly("session-invalid-browser", "tab-invalid-browser", {
      browserId: "chrome",
    })).toThrowError(/browserId 'iab'.*surfaceId 'chatgpt'/);
    expect(() => claimOnly("session-invalid-surface", "tab-invalid-surface", {
      surfaceId: "custom-surface",
    })).toThrowError(/browserId 'iab'.*surfaceId 'chatgpt'/);
  });

  it("allows a Project-only candidate and promotes its observed chat URL at commit", () => {
    stateDir();
    const candidate = claimOnly("session-project-candidate", "tab-candidate", { chatUrl: undefined });

    expect(candidate.chatUrl).toBeUndefined();
    expect(currentSurfaceBinding("project-alpha", "session-project-candidate")).toBeNull();

    const committed = commitVerifiedSurfaceRoute({
      lease: candidate,
      workspaceId: "workspace-alpha",
      chatUrl: CHAT_URL,
      connectorName: "Codex with ChatGPT",
      now: START,
    });
    const binding = committed.binding;
    expect(binding).toMatchObject({
      projectUrl: PROJECT_URL,
      chatUrl: CHAT_URL,
      tabId: "tab-candidate",
      lastGeneration: 1,
    });
    expect(committed.session).toMatchObject({
      url: CHAT_URL,
      projectUrl: PROJECT_URL,
      surfaceGeneration: 1,
      surfaceTabId: "tab-candidate",
    });
    expect(currentSurfaceLease("project-alpha", "session-project-candidate", START)?.chatUrl).toBe(CHAT_URL);
  });

  it("cannot publish an older route after a newer page generation is claimed", () => {
    stateDir();
    const first = claimOnly("session-cas", "tab-old");
    const newer = claimOnly("session-cas", "tab-new", { replaces: first });

    expect(() => commitVerifiedSurfaceRoute({
      lease: first,
      workspaceId: "workspace-alpha",
      connectorName: "Codex with ChatGPT",
      now: START,
    })).toThrowError(expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "LEASE_NOT_FOUND" }));

    const committed = commitVerifiedSurfaceRoute({
      lease: newer,
      workspaceId: "workspace-alpha",
      connectorName: "Codex with ChatGPT",
      now: START,
    });
    expect(committed.binding).toMatchObject({ tabId: "tab-new", lastGeneration: 2 });
    expect(committed.session).toMatchObject({ surfaceTabId: "tab-new", surfaceGeneration: 2 });
  });

  it("rejects committing a candidate without an observed chat URL", () => {
    stateDir();
    const candidate = claimOnly("session-project-candidate", "tab-candidate", { chatUrl: undefined });

    expect(() => commitVerifiedSurfaceRoute({
      lease: candidate,
      workspaceId: "workspace-alpha",
      connectorName: "Codex with ChatGPT",
      now: START,
    })).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({
        code: "INVALID_SURFACE_OWNERSHIP_STATE",
      }),
    );
  });

  it("is idempotent when a session re-enters the same page", () => {
    stateDir();
    const first = claim("session-a", "tab-a");
    const second = claim("session-a", "tab-a");

    expect(second).toEqual(first);
    expect(first.generation).toBe(1);
    expect(listSurfaceLeases("project-alpha", START)).toEqual([first]);
    expect(fs.statSync(surfaceOwnershipFile("project-alpha")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(machineSurfaceOwnershipFile()).mode & 0o777).toBe(0o600);
  });

  it("rotates generation for a changed page and revokes the previous lease", () => {
    stateDir();
    const first = claim("session-a", "tab-a");
    const rotated = claim("session-a", "tab-b", {
      chatUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-next",
      replaces: first,
    });

    expect(rotated.generation).toBe(2);
    expect(releaseSurface(first)).toBe(false);
    expect(listSurfaceLeases("project-alpha", START)).toEqual([rotated]);
    expect(currentSurfaceBinding("project-alpha", "session-a")).toMatchObject({
      tabId: "tab-b",
      lastGeneration: 2,
      chatUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-next",
    });

    const reclaimed = claim("session-b", "tab-a");
    expect(reclaimed.tabId).toBe("tab-a");
    expect(currentSurfaceBinding("project-alpha", "session-a")?.tabId).toBe("tab-b");
    expect(currentSurfaceBinding("project-alpha", "session-b")).toMatchObject({
      tabId: "tab-a",
      chatUrl: CHAT_URL,
    });
  });

  it("rejects a delayed old generation after the replacement route is committed", () => {
    stateDir();
    const first = claim("session-a", "tab-old");
    const rotated = claim("session-a", "tab-new", {
      chatUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-next",
      replaces: first,
    });

    const committed = commitVerifiedSurfaceRoute({
      lease: rotated,
      workspaceId: "workspace-alpha",
      connectorName: "Codex with ChatGPT",
      now: START,
    });
    expect(committed.session).toMatchObject({
      surfaceGeneration: rotated.generation,
      surfaceTabId: "tab-new",
      url: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-next",
    });

    expect(() => commitVerifiedSurfaceRoute({
      lease: first,
      workspaceId: "workspace-alpha",
      connectorName: "Codex with ChatGPT",
      now: START,
    })).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "LEASE_NOT_FOUND" }),
    );
    expect(currentSurfaceBinding("project-alpha", "session-a")).toMatchObject({
      tabId: "tab-new",
      lastGeneration: rotated.generation,
    });
  });

  it("requires the exact live lease before rotating a session-owned page", () => {
    stateDir();
    const owner = claim("session-a", "tab-a");

    expect(() =>
      claim("session-a", "tab-b", {
        ownerProcessEpoch: "delayed-owner-epoch",
      })
    ).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "SESSION_ALREADY_OWNED" })
    );
    expect(() =>
      claim("session-a", "tab-b", {
        replaces: { ...owner, generation: owner.generation + 1 },
      })
    ).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "SESSION_ALREADY_OWNED" })
    );
    expect(listSurfaceLeases("project-alpha", START)).toEqual([owner]);
  });

  it("rejects a second session from an active tab and only releases the exact owner", () => {
    stateDir();
    const owner = claim("session-a", "tab-a");

    expect(() => claim("session-b", "tab-a")).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "SURFACE_ALREADY_OWNED" })
    );
    expect(
      releaseSurface({
        ...owner,
        ownerProcessEpoch: "different-owner-epoch",
      })
    ).toBe(false);
    expect(listSurfaceLeases("project-alpha", START)).toEqual([owner]);
    expect(releaseSurface(owner, START)).toBe(true);
    expect(listSurfaceLeases("project-alpha", START)).toEqual([]);
  });

  it("rejects a different session from the same chat even through another tab", () => {
    stateDir();
    claim("session-a", "tab-a");

    expect(() => claim("session-b", "tab-b")).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "SURFACE_ALREADY_OWNED" })
    );
  });

  it("keeps each local project's ChatGPT Project binding stable", () => {
    stateDir();
    claim("session-a", "tab-a");

    expect(() => claim("session-b", "tab-b", {
      projectId: "project-beta",
      chatUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-b",
    })).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "PROJECT_BINDING_CONFLICT" })
    );

    const otherLocalProject = claim("session-b", "tab-b", {
      projectId: "project-beta",
      projectUrl: OTHER_PROJECT_URL,
      chatUrl: OTHER_CHAT_URL,
    });
    expect(otherLocalProject.projectId).toBe("project-beta");

    expect(() =>
      claim("session-b", "tab-b", {
        projectUrl: OTHER_PROJECT_URL,
        chatUrl: OTHER_CHAT_URL,
      })
    ).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "PROJECT_BINDING_CONFLICT" })
    );
  });

  it("rejects a normalized Project URL claimed by another local project", () => {
    stateDir();
    claim("session-a", "tab-a");

    expect(() => claim("session-b", "tab-b", {
      projectId: "project-beta",
      projectUrl: `${PROJECT_URL}?utm_source=ignored`,
      chatUrl: CHAT_URL,
    })).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "PROJECT_BINDING_CONFLICT" }),
    );
  });

  it("does not let a workspace mirror release the machine-owned Project", () => {
    stateDir();
    claim("session-a", "tab-a");

    const file = surfaceOwnershipFile("project-alpha");
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...state, leases: [], bindings: [] }));

    expect(() => claim("session-b", "tab-b", {
      projectId: "project-beta",
      projectUrl: PROJECT_URL,
      chatUrl: CHAT_URL,
    })).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "PROJECT_BINDING_CONFLICT" }),
    );
  });

  it("does not import a pre-created workspace mirror into a new machine authority", () => {
    stateDir();
    claim("session-a", "tab-a");

    // Simulate a machine-state reset while the old workspace mirror remains.
    fs.rmSync(machineSurfaceOwnershipFile(), { force: true });

    const replacement = claimOnly("session-b", "tab-a", {
      projectId: "project-beta",
      projectUrl: PROJECT_URL,
      chatUrl: CHAT_URL,
    });
    expect(replacement.projectId).toBe("project-beta");
    expect(replacement.generation).toBe(1);
    expect(currentSurfaceBinding("project-alpha", "session-a")).toBeNull();
  });

  it("keeps a physical page reserved across projects until replacement or unregister", () => {
    stateDir();
    const first = claim("session-a", "tab-a");
    expect(releaseSurface(first, START)).toBe(true);

    expect(() => claim("session-b", "tab-a", {
      projectId: "project-beta",
      projectUrl: OTHER_PROJECT_URL,
      chatUrl: OTHER_CHAT_URL,
    })).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "SURFACE_BOUND_TO_ANOTHER_SESSION" }),
    );

    const replacement = claim("session-a", "tab-b", {
      projectUrl: PROJECT_URL,
      chatUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-replacement",
      replaces: first,
    });
    expect(replacement.generation).toBe(2);
    expect(claim("session-b", "tab-a", {
      projectId: "project-beta",
      projectUrl: OTHER_PROJECT_URL,
      chatUrl: OTHER_CHAT_URL,
    }).tabId).toBe("tab-a");

    expect(unregisterSurfaceOwnership("project-beta")).toBe(2);
    const machine = JSON.parse(fs.readFileSync(machineSurfaceOwnershipFile(), "utf8")) as {
      initializedProjects: string[];
      generations: Record<string, number>;
    };
    expect(machine.initializedProjects).not.toContain("project-beta");
    expect(Object.keys(machine.generations).some((key) => key.startsWith("project-beta\u0000"))).toBe(false);
    expect(claim("session-c", "tab-c", {
      projectId: "project-beta",
      projectUrl: OTHER_PROJECT_URL,
      chatUrl: OTHER_CHAT_URL,
    }).projectId).toBe("project-beta");
  });

  it("allows independent sessions to use the same Project binding", () => {
    stateDir();
    const first = claim("session-a", "tab-a");
    const second = claim("session-b", "tab-b", {
      chatUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-b",
    });

    expect(first.projectId).toBe(second.projectId);
    expect(first.projectUrl).toBe(second.projectUrl);
    expect(listSurfaceLeases("project-alpha", START)).toHaveLength(2);
  });

  it("retains the machine Project URL after session retirement until project unregister", () => {
    stateDir();
    claim("session-retain-url", "tab-retain-url");

    expect(currentProjectUrl("project-alpha")).toBe(PROJECT_URL);
    expect(retireSurfaceSession({
      projectId: "project-alpha",
      workspaceId: "workspace-alpha",
      localSessionId: "session-retain-url",
    }).retired).toBe(true);
    expect(currentProjectUrl("project-alpha")).toBe(PROJECT_URL);
    expect(JSON.parse(fs.readFileSync(machineSurfaceOwnershipFile(), "utf8"))).toMatchObject({
      projectUrls: { "project-alpha": PROJECT_URL },
    });

    expect(() => claim("session-other-project", "tab-other-project", {
      projectId: "project-beta",
      projectUrl: `${PROJECT_URL}?utm_source=ignored`,
      chatUrl: CHAT_URL,
    })).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "PROJECT_BINDING_CONFLICT" }),
    );

    expect(unregisterSurfaceOwnership("project-alpha")).toBe(0);
    expect(currentProjectUrl("project-alpha")).toBeNull();
    expect(claim("session-other-project", "tab-other-project", {
      projectId: "project-beta",
      projectUrl: PROJECT_URL,
      chatUrl: CHAT_URL,
    }).projectId).toBe("project-beta");
  });

  it("unregisters machine ownership after a fresh process restart without project registration", () => {
    const home = isolateStateDir();
    const stateRoot = process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "codex-with-chatgpt")
      : process.platform === "win32"
        ? path.join(home, "AppData", "Local", "codex-with-chatgpt")
        : path.join(home, ".local", "state", "codex-with-chatgpt");
    dirs.push(home);
    process.env.C2C_STATE_DIR = stateRoot;
    claim("session-fresh-process", "tab-fresh-process");
    const mirrorFile = surfaceOwnershipFile("project-alpha");
    const machineFile = machineSurfaceOwnershipFile();
    expect(JSON.parse(fs.readFileSync(mirrorFile, "utf8")).bindings).toHaveLength(1);

    const childEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete childEnv.C2C_STATE_DIR;
    childEnv.XDG_STATE_HOME = path.join(home, ".local", "state");
    childEnv.LOCALAPPDATA = path.join(home, "AppData", "Local");
    const moduleUrl = pathToFileURL(path.resolve("src/session/surface-ownership.ts")).href;
    const script = [
      `const ownership = await import(${JSON.stringify(moduleUrl)});`,
      `const removed = ownership.unregisterSurfaceOwnership("project-alpha");`,
      `process.stdout.write(JSON.stringify({ removed }));`,
    ].join("\n");
    const first = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", "--input-type=module", "--eval", script],
      { cwd: path.resolve("."), env: childEnv, encoding: "utf8" },
    );
    if (first.status !== 0) throw new Error(first.stderr || `fresh unregister exited with ${first.status}`);
    expect(JSON.parse(first.stdout)).toEqual({ removed: 2 });

    const machineAfterFirst = JSON.parse(fs.readFileSync(machineFile, "utf8"));
    expect(machineAfterFirst.initializedProjects).not.toContain("project-alpha");
    expect(machineAfterFirst.projectUrls["project-alpha"]).toBeUndefined();
    expect(machineAfterFirst.leases).toHaveLength(0);
    expect(machineAfterFirst.bindings).toHaveLength(0);
    // The unregistered operation never needs to touch a missing checkout
    // mirror. A subsequent registered read repairs that stale mirror.
    expect(JSON.parse(fs.readFileSync(mirrorFile, "utf8")).bindings).toHaveLength(1);

    const second = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", "--input-type=module", "--eval", script],
      { cwd: path.resolve("."), env: childEnv, encoding: "utf8" },
    );
    if (second.status !== 0) throw new Error(second.stderr || `second unregister exited with ${second.status}`);
    expect(JSON.parse(second.stdout)).toEqual({ removed: 0 });

    expect(currentSurfaceBinding("project-alpha", "session-fresh-process")).toBeNull();
    expect(JSON.parse(fs.readFileSync(mirrorFile, "utf8"))).toMatchObject({
      leases: [],
      bindings: [],
      generations: {},
    });
  });

  it("rejects machine Project URL mappings that are not unique", () => {
    stateDir();
    claim("session-map-validation", "tab-map-validation");

    const file = machineSurfaceOwnershipFile();
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as {
      initializedProjects: string[];
      projectUrls: Record<string, string>;
    };
    state.initializedProjects.push("project-beta");
    state.projectUrls["project-beta"] = PROJECT_URL;
    fs.writeFileSync(file, JSON.stringify(state));

    expect(() => currentProjectUrl("project-alpha")).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "INVALID_SURFACE_OWNERSHIP_STATE" }),
    );
  });

  it("rejects a machine generation allocator that can reuse an active generation", () => {
    stateDir();
    claim("session-generation-validation", "tab-generation-validation");

    const file = machineSurfaceOwnershipFile();
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as { nextGeneration: number };
    state.nextGeneration = 1;
    fs.writeFileSync(file, JSON.stringify(state));

    expect(() => currentProjectUrl("project-alpha")).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "INVALID_SURFACE_OWNERSHIP_STATE" }),
    );
  });

  it.each([
    "duplicate page owner",
    "duplicate chat owner",
    "duplicate session lease",
    "chat outside Project",
    "lease and binding disagree",
    "record generation reaches allocator",
  ])("fails closed on a tampered v3 machine index: %s", (kind) => {
    stateDir();
    const first = claim("session-tampered-v3", "tab-tampered-v3");
    const second = claim("session-tampered-v3-second", "tab-tampered-v3-second", {
      chatUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-tampered-v3-second",
    });
    const file = machineSurfaceOwnershipFile();
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as {
      leases: Array<Record<string, unknown>>;
      bindings: Array<Record<string, unknown>>;
      generations: Record<string, number>;
      nextGeneration: number;
    };
    if (kind === "duplicate page owner") {
      state.bindings[1]!.tabId = state.bindings[0]!.tabId;
      state.leases[1]!.tabId = state.leases[0]!.tabId;
    } else if (kind === "duplicate chat owner") {
      state.bindings[1]!.chatUrl = state.bindings[0]!.chatUrl;
      state.leases[1]!.chatUrl = state.leases[0]!.chatUrl;
    } else if (kind === "duplicate session lease") {
      state.leases.push({ ...state.leases[0] });
    } else if (kind === "chat outside Project") {
      state.leases[0]!.chatUrl = OTHER_CHAT_URL;
    } else if (kind === "lease and binding disagree") {
      state.leases[0]!.tabId = "different-tab-at-same-generation";
    } else {
      state.leases[0]!.generation = state.nextGeneration;
    }
    fs.writeFileSync(file, JSON.stringify(state));

    expect(() => currentProjectUrl("project-alpha")).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "INVALID_SURFACE_OWNERSHIP_STATE" }),
    );
    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
  });

  it.each([1, 2])(
    "quarantines known legacy machine schema v%d and rebuilds a clean v3 index",
    (schemaVersion) => {
      stateDir();
      const file = machineSurfaceOwnershipFile();
      const legacy = {
        schemaVersion,
        initializedProjects: ["project-alpha"],
        leases: [],
        bindings: [],
        generations: {},
      };
      fs.writeFileSync(file, JSON.stringify(legacy));

      expect(currentProjectUrl("project-alpha")).toBeNull();
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
        schemaVersion: 3,
        initializedProjects: [],
        projectUrls: {},
        leases: [],
        bindings: [],
        nextGeneration: 1,
        generations: {},
      });

      const backups = fs.readdirSync(path.dirname(file)).filter((name) =>
        name.startsWith(`surface-ownership.json.legacy-v${schemaVersion}.`),
      );
      expect(backups).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(path.join(path.dirname(file), backups[0]!), "utf8"))).toEqual(legacy);

      expect(claim("session-after-legacy-rebuild", "tab-after-legacy-rebuild").generation).toBe(1);
    },
  );

  it("validates a complete legacy index before quarantining it", () => {
    stateDir();
    claim("session-legacy-entry", "tab-legacy-entry");
    const file = machineSurfaceOwnershipFile();
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const legacy = {
      schemaVersion: 2,
      initializedProjects: current.initializedProjects,
      leases: current.leases,
      bindings: current.bindings,
      generations: current.generations,
    };
    fs.writeFileSync(file, JSON.stringify(legacy));

    expect(currentProjectUrl("project-alpha")).toBeNull();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ schemaVersion: 3 });
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".legacy-v2.")).length).toBe(1);
  });

  it("recovers a valid legacy index with its historical non-IAB surface identity", () => {
    stateDir();
    claim("session-legacy-non-iab", "tab-legacy-non-iab");
    const file = machineSurfaceOwnershipFile();
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as {
      initializedProjects: string[];
      leases: Array<Record<string, unknown>>;
      bindings: Array<Record<string, unknown>>;
      generations: Record<string, number>;
    };
    for (const entry of [...current.leases, ...current.bindings]) {
      entry.browserId = "chrome";
      entry.surfaceId = "legacy-chatgpt";
    }
    const legacy = {
      schemaVersion: 1,
      initializedProjects: current.initializedProjects,
      leases: current.leases,
      bindings: current.bindings,
      generations: current.generations,
    };
    fs.writeFileSync(file, JSON.stringify(legacy));

    expect(currentProjectUrl("project-alpha")).toBeNull();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      schemaVersion: 3,
      leases: [],
      bindings: [],
    });
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".legacy-v1.")).length).toBe(1);
  });

  it.each([
    "duplicate page ownership",
    "duplicate chat ownership",
    "duplicate session binding",
    "chat outside Project",
  ])("fails closed on a legacy ownership invariant: %s", (kind) => {
    stateDir();
    claim("session-legacy-invariant-a", "tab-legacy-invariant-a");
    claim("session-legacy-invariant-b", "tab-legacy-invariant-b", {
      chatUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-legacy-invariant-b",
    });
    const file = machineSurfaceOwnershipFile();
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as {
      initializedProjects: string[];
      leases: Array<Record<string, unknown>>;
      bindings: Array<Record<string, unknown>>;
      generations: Record<string, number>;
    };
    if (kind === "duplicate page ownership") {
      current.leases[1]!.tabId = current.leases[0]!.tabId;
      current.bindings[1]!.tabId = current.bindings[0]!.tabId;
    } else if (kind === "duplicate chat ownership") {
      current.leases[1]!.chatUrl = current.leases[0]!.chatUrl;
      current.bindings[1]!.chatUrl = current.bindings[0]!.chatUrl;
    } else if (kind === "duplicate session binding") {
      current.bindings.push({ ...current.bindings[0] });
    } else {
      current.leases[0]!.chatUrl = OTHER_CHAT_URL;
    }
    const legacy = {
      schemaVersion: 2,
      initializedProjects: current.initializedProjects,
      leases: current.leases,
      bindings: current.bindings,
      generations: current.generations,
    };
    const serialized = JSON.stringify(legacy);
    fs.writeFileSync(file, serialized);

    expect(() => currentProjectUrl("project-alpha")).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "INVALID_SURFACE_OWNERSHIP_STATE" }),
    );
    expect(fs.readFileSync(file, "utf8")).toBe(serialized);
    expect(fs.readdirSync(path.dirname(file)).some((name) => name.includes(".legacy-v2."))).toBe(false);
  });

  it.each([
    { schemaVersion: 1, initializedProjects: [], leases: [], bindings: [] },
    {
      schemaVersion: 1,
      initializedProjects: ["project-alpha"],
      leases: [{ damaged: true }],
      bindings: [],
      generations: {},
    },
    {
      schemaVersion: 2,
      initializedProjects: ["project-alpha"],
      leases: [],
      bindings: [],
      generations: {},
      unexpected: true,
    },
  ])("fails closed on malformed legacy machine state %#", (malformed) => {
    stateDir();
    const file = machineSurfaceOwnershipFile();
    const serialized = JSON.stringify(malformed);
    fs.writeFileSync(file, serialized);

    expect(() => currentProjectUrl("project-alpha")).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "INVALID_SURFACE_OWNERSHIP_STATE" }),
    );
    expect(fs.readFileSync(file, "utf8")).toBe(serialized);
    expect(fs.readdirSync(path.dirname(file)).some((name) => name.includes(".legacy-v"))).toBe(false);
  });

  it("fails closed on an unknown machine schema without replacing or quarantining it", () => {
    stateDir();
    const file = machineSurfaceOwnershipFile();
    const unknown = { schemaVersion: 99, future: "do-not-discard" };
    fs.writeFileSync(file, JSON.stringify(unknown));

    expect(() => currentProjectUrl("project-alpha")).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "INVALID_SURFACE_OWNERSHIP_STATE" }),
    );
    expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify(unknown));
    expect(fs.readdirSync(path.dirname(file)).some((name) => name.includes(".legacy-v99."))).toBe(false);
  });

  it("fails closed on corrupted machine JSON without deleting the evidence", () => {
    stateDir();
    const file = machineSurfaceOwnershipFile();
    const corrupted = "{\"schemaVersion\":1";
    fs.writeFileSync(file, corrupted);

    expect(() => currentProjectUrl("project-alpha")).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "INVALID_SURFACE_OWNERSHIP_STATE" }),
    );
    expect(fs.readFileSync(file, "utf8")).toBe(corrupted);
    expect(fs.readdirSync(path.dirname(file)).some((name) => name.includes(".legacy-v1."))).toBe(false);
  });

  it("rejects persisted bindings that disagree about the Project mapping", () => {
    stateDir();
    claim("session-a", "tab-a");

    const state = JSON.parse(fs.readFileSync(surfaceOwnershipFile("project-alpha"), "utf8")) as {
      bindings: Array<{ projectId: string }>;
    };
    state.bindings[0].projectId = "project-beta";
    fs.writeFileSync(surfaceOwnershipFile("project-alpha"), JSON.stringify(state));

    expect(() => listSurfaceLeases("project-alpha", START)).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "INVALID_SURFACE_OWNERSHIP_STATE" })
    );
  });

  it("rejects direct chats and chats belonging to another ChatGPT Project", () => {
    stateDir();
    expect(() => claim("session-a", "tab-a", { chatUrl: "https://chatgpt.com/c/direct-chat" })).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "INVALID_SURFACE_OWNERSHIP_STATE" })
    );
    expect(() =>
      claim("session-a", "tab-a", {
        chatUrl: "https://chatgpt.com/g/g-p-11111111111111111111111111111111/c/other-chat",
      })
    ).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "INVALID_SURFACE_OWNERSHIP_STATE" })
    );
  });

  it("allows more than five independent sessions without a capacity gate or queue", () => {
    stateDir();
    const leases = Array.from({ length: 8 }, (_, index) =>
      claim(`session-${index + 1}`, `tab-${index + 1}`, {
        chatUrl: `https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-${index + 1}`,
      })
    );

    expect(leases).toHaveLength(8);
    expect(new Set(leases.map((lease) => lease.localSessionId)).size).toBe(8);
    expect(listSurfaceLeases("project-alpha", START)).toHaveLength(8);
  });

  it("reclaims expired leases on restart while preserving tab binding and generation", () => {
    stateDir();
    const first = claim("session-a", "tab-a", {
      ownerProcessEpoch: "owner-epoch-before-restart",
      leaseTtlMs: 1_000,
    });
    const afterExpiry = new Date(START.getTime() + 1_001);

    expect(reapExpiredSurfaceLeases("project-alpha", afterExpiry)).toBe(1);
    expect(listSurfaceLeases("project-alpha", afterExpiry)).toEqual([]);
    expect(currentSurfaceBinding("project-alpha", "session-a")).toMatchObject({
      tabId: "tab-a",
      lastGeneration: 1,
      chatUrl: CHAT_URL,
    });
    const afterRestart = claim("session-a", "tab-a", {
      ownerProcessEpoch: "owner-epoch-after-restart",
      now: afterExpiry,
    });

    expect(afterRestart.generation).toBe(2);
    expect(afterRestart.ownerProcessEpoch).toBe("owner-epoch-after-restart");
    expect(first.generation).toBe(1);
    expect(releaseSurface(afterRestart, afterExpiry)).toBe(true);
    expect(() => claim("session-b", "tab-a", { now: afterExpiry })).toThrowError(
      expect.objectContaining<Partial<SurfaceOwnershipError>>({
        code: "SURFACE_BOUND_TO_ANOTHER_SESSION",
      })
    );
  });

  it("requires explicit rotation after releasing a persistent session binding", () => {
    stateDir();
    const first = claim("session-a", "tab-a");
    expect(releaseSurface(first, START)).toBe(true);

    expect(() =>
      claim("session-a", "tab-b", {
        chatUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-next",
      })
    ).toThrowError(expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "SESSION_ALREADY_OWNED" }));

    const rotated = claim("session-a", "tab-b", {
      chatUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-next",
      replaces: first,
    });
    expect(rotated.generation).toBe(2);
  });

  it("returns the latest persistent binding after its lease is released", () => {
    stateDir();
    const first = claim("session-a", "tab-a");
    expect(releaseSurface(first, START)).toBe(true);

    const binding = currentSurfaceBinding("project-alpha", "session-a");
    expect(binding).toMatchObject({
      projectId: "project-alpha",
      localSessionId: "session-a",
      browserId: "iab",
      surfaceId: "chatgpt",
      tabId: "tab-a",
      lastGeneration: 1,
      chatUrl: CHAT_URL,
    });

    (binding as { tabId: string }).tabId = "mutated-tab";
    expect(currentSurfaceBinding("project-alpha", "session-a")?.tabId).toBe("tab-a");
  });

  it("retires one session without allowing an old lease ref to match a re-claim", () => {
    stateDir();
    const first = claim("session-retire", "tab-retire", {
      ownerProcessEpoch: "owner-epoch-retire",
    });

    expect(retireSurfaceSession({
      projectId: "project-alpha",
      workspaceId: "workspace-alpha",
      localSessionId: "session-retire",
    })).toMatchObject({
      retired: true,
      removedLeases: 1,
      removedBindings: 1,
      removedSession: true,
    });
    expect(currentSurfaceLease("project-alpha", "session-retire", START)).toBeNull();
    expect(currentSurfaceBinding("project-alpha", "session-retire")).toBeNull();

    const mirror = JSON.parse(fs.readFileSync(surfaceOwnershipFile("project-alpha"), "utf8")) as {
      generations: Record<string, number>;
    };
    expect(mirror.generations["project-alpha\u0000session-retire"]).toBeUndefined();
    const machine = JSON.parse(fs.readFileSync(machineSurfaceOwnershipFile(), "utf8")) as {
      generations: Record<string, number>;
    };
    expect(machine.generations["project-alpha\u0000session-retire"]).toBeUndefined();
    expect(machine.nextGeneration).toBe(2);

    const replacement = claim("session-retire", "tab-replacement", {
      ownerProcessEpoch: "owner-epoch-retire",
    });
    expect(replacement.generation).toBe(2);
    expect(JSON.parse(fs.readFileSync(machineSurfaceOwnershipFile(), "utf8"))).toMatchObject({
      nextGeneration: 3,
      generations: { "project-alpha\u0000session-retire": 2 },
    });
    expect(releaseSurface(first, START)).toBe(false);
    expect(currentSurfaceLease("project-alpha", "session-retire", START)?.tabId).toBe("tab-replacement");
  });

  it("keeps generation state bounded after retiring many sessions", () => {
    stateDir();
    for (let index = 0; index < 24; index++) {
      const localSessionId = `session-retire-${index}`;
      const lease = claim(localSessionId, `tab-retire-${index}`);
      expect(retireSurfaceSession({
        projectId: "project-alpha",
        workspaceId: "workspace-alpha",
        localSessionId,
      }).retired).toBe(true);
      expect(releaseSurface(lease, START)).toBe(false);
    }

    const machine = JSON.parse(fs.readFileSync(machineSurfaceOwnershipFile(), "utf8")) as {
      initializedProjects: string[];
      nextGeneration: number;
      generations: Record<string, number>;
    };
    expect(machine.initializedProjects).toEqual(["project-alpha"]);
    expect(machine.nextGeneration).toBe(25);
    expect(machine.generations).toEqual({});
  });

  it("keeps generation monotonic when the workspace mirror is edited after release", () => {
    stateDir();
    const first = claim("session-a", "tab-a");
    expect(releaseSurface(first, START)).toBe(true);

    const file = surfaceOwnershipFile("project-alpha");
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as {
      generations: Record<string, number>;
    };
    state.generations["project-alpha\u0000session-a"] = 999;
    fs.writeFileSync(file, JSON.stringify(state));

    const next = claimOnly("session-a", "tab-b", {
      chatUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-next",
      replaces: first,
    });
    expect(next.generation).toBe(2);
    expect(JSON.parse(fs.readFileSync(machineSurfaceOwnershipFile(), "utf8"))).toMatchObject({
      generations: { "project-alpha\u0000session-a": 2 },
    });
  });

  it("requires explicit rotation after a lease expires", () => {
    stateDir();
    const first = claim("session-a", "tab-a", { leaseTtlMs: 1_000 });
    const afterExpiry = new Date(START.getTime() + 1_001);

    expect(reapExpiredSurfaceLeases("project-alpha", afterExpiry)).toBe(1);
    expect(() =>
      claim("session-a", "tab-b", {
        chatUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-next",
        now: afterExpiry,
      })
    ).toThrowError(expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "SESSION_ALREADY_OWNED" }));

    const rotated = claim("session-a", "tab-b", {
      chatUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-next",
      replaces: first,
      now: afterExpiry,
    });
    expect(rotated.generation).toBe(2);
  });

  it("renews only the current generation and process epoch", () => {
    stateDir();
    const owner = claim("session-a", "tab-a");
    const renewed = renewSurface({
      lease: owner,
      now: new Date(START.getTime() + 10_000),
      leaseTtlMs: 60_000,
    });

    expect(renewed.generation).toBe(owner.generation);
    expect(Date.parse(renewed.leaseExpiresAt)).toBe(Date.parse("2026-01-01T00:01:10.000Z"));
    expect(() =>
      renewSurface({
        lease: { ...owner, ownerProcessEpoch: currentOwnerProcessEpoch() },
        now: new Date(START.getTime() + 10_000),
      })
    ).toThrowError(expect.objectContaining<Partial<SurfaceOwnershipError>>({ code: "LEASE_NOT_FOUND" }));
  });
});
