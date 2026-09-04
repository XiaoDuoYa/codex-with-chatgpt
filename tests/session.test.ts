import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearChatPointer,
  commitSessionRoute,
  currentLocalSessionId,
  currentLocalSessionIdentity,
  mergeSession,
  normalizeChatUrl,
  normalizeProjectUrl,
  projectIdFromChatUrl,
  projectIdFromUrl,
  readSession,
  resolveConversation,
  resolveConversationRoute,
  retireSession,
  sessionFile,
  threadSessionFile,
  updateSession,
  type SavedSession,
} from "../src/session/state.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";

const PROJECT = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
const PROJECT_CHAT =
  "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_PROJECT = "https://chatgpt.com/g/g-p-other-project/project";
const SLUGGED_PROJECT =
  "https://chatgpt.com/g/g-p-6a97c355a5c88191a62d30cee1326a7d-cloudflare-llm-api/project";
const SLUGGED_PROJECT_CHAT =
  "https://chatgpt.com/g/g-p-6a97c355a5c88191a62d30cee1326a7d-cloudflare-llm-api/c/6a99248b-493c-83ec-868e-86dde7469950";
const CANONICAL_SLUGGED_PROJECT =
  "https://chatgpt.com/g/g-p-6a97c355a5c88191a62d30cee1326a7d/project";
const CANONICAL_SLUGGED_PROJECT_CHAT =
  "https://chatgpt.com/g/g-p-6a97c355a5c88191a62d30cee1326a7d/c/6a99248b-493c-83ec-868e-86dde7469950";

function writeSession(
  workspaceId: string,
  session: SavedSession,
  localSessionId = session.localSessionId ?? currentLocalSessionId()
): SavedSession {
  const { projectUrl, url, connectorName, conversationMode, savedAt: _savedAt, ...statePatch } = session;
  const effectiveProjectUrl = projectUrl ?? readSession(workspaceId, localSessionId)?.projectUrl;
  const candidate = {
    ...session,
    projectUrl: effectiveProjectUrl,
    conversationMode: effectiveProjectUrl ? "project" : conversationMode,
  };
  // Validate the complete candidate before committing its route so failed
  // state mutations cannot partially change the shared workspace record.
  mergeSession(null, candidate);
  let saved = effectiveProjectUrl
    ? commitSessionRoute(workspaceId, localSessionId, {
        projectUrl: effectiveProjectUrl,
        chatUrl: url,
        connectorName,
      })
    : null;
  if (Object.keys(statePatch).length > 0 || !saved) {
    saved = updateSession(workspaceId, localSessionId, {
      ...statePatch,
      localSessionId,
    });
  }
  return saved;
}

const SESSION_ENV_KEYS = [
  "C2C_LOCAL_SESSION_ID",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CODEX_APP_TOOLS_PIPE_PATH",
  "TERM_SESSION_ID",
  "WT_SESSION",
  "VSCODE_PID",
  "SHELL_PID",
] as const;

describe("currentLocalSessionId", () => {
  it("prefers explicit and Codex task identifiers before runtime fallbacks", () => {
    const previous = Object.fromEntries(SESSION_ENV_KEYS.map((key) => [key, process.env[key]]));
    try {
      process.env.C2C_LOCAL_SESSION_ID = "c2c-override";
      process.env.CODEX_THREAD_ID = "codex-thread";
      process.env.CODEX_SESSION_ID = "codex-session";
      expect(currentLocalSessionId("explicit-session")).toBe("explicit-session");
      expect(currentLocalSessionIdentity("explicit-session")).toEqual({
        id: "explicit-session",
        source: "explicit",
        stability: "durable",
      });
      expect(currentLocalSessionId()).toBe("c2c-override");

      delete process.env.C2C_LOCAL_SESSION_ID;
      expect(currentLocalSessionId()).toBe("codex-thread");
      delete process.env.CODEX_THREAD_ID;
      expect(currentLocalSessionId()).toBe("codex-session");
      delete process.env.CODEX_SESSION_ID;

      process.env.CODEX_APP_TOOLS_PIPE_PATH = "/tmp/codex-browser-use/runtime-a.sock";
      const runtime = currentLocalSessionIdentity();
      expect(runtime.source).toBe("codex-runtime");
      expect(runtime.stability).toBe("runtime");
      expect(currentLocalSessionId()).toBe(runtime.id);

      for (const key of SESSION_ENV_KEYS) delete process.env[key];
      process.env.SHELL_PID = "4242";
      const terminal = currentLocalSessionIdentity();
      expect(terminal.source).toBe("terminal-runtime");
      expect(terminal.stability).toBe("runtime");

      delete process.env.SHELL_PID;
      const temporary = currentLocalSessionIdentity();
      expect(temporary.source).toBe("process-temporary");
      expect(temporary.stability).toBe("process");
      expect(currentLocalSessionId()).toBe(temporary.id);
      expect(() => currentLocalSessionId("invalid:windows-id")).toThrow(/safe identifier/);
    } finally {
      for (const key of SESSION_ENV_KEYS) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("normalizeProjectUrl", () => {
  it("accepts the collection URL and strips extras", () => {
    expect(normalizeProjectUrl(`${PROJECT}/`)).toBe(PROJECT);
    expect(normalizeProjectUrl("https://www.chatgpt.com/g/g-p-abc123/project?foo=1")).toBe(
      "https://chatgpt.com/g/g-p-abc123/project"
    );
    expect(projectIdFromUrl(PROJECT)).toBe("g-p-6a94399430e08191860ab5364b7748b8");
    expect(normalizeProjectUrl(`${SLUGGED_PROJECT}?tab=sources`)).toBe(CANONICAL_SLUGGED_PROJECT);
    expect(projectIdFromUrl(SLUGGED_PROJECT)).toBe("g-p-6a97c355a5c88191a62d30cee1326a7d");
  });

  it("rejects a normal chat URL or a guessed name", () => {
    expect(normalizeProjectUrl("https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBeNull();
    expect(normalizeProjectUrl("https://chatgpt.com/")).toBeNull();
    expect(normalizeProjectUrl("https://example.com/g/g-p-abc/project")).toBeNull();
  });
});

describe("normalizeChatUrl", () => {
  it("normalizes Project conversation URLs", () => {
    expect(normalizeChatUrl(`${SLUGGED_PROJECT_CHAT}?model=auto`)).toBe(CANONICAL_SLUGGED_PROJECT_CHAT);
    expect(normalizeChatUrl(CANONICAL_SLUGGED_PROJECT_CHAT)).toBe(CANONICAL_SLUGGED_PROJECT_CHAT);
    expect(projectIdFromChatUrl(SLUGGED_PROJECT_CHAT)).toBe("g-p-6a97c355a5c88191a62d30cee1326a7d");
  });

  it("rejects non-conversation and untrusted URLs", () => {
    expect(normalizeChatUrl(PROJECT)).toBeNull();
    expect(normalizeChatUrl("https://www.chatgpt.com/c/direct-chat/?foo=1#latest")).toBeNull();
    expect(normalizeChatUrl("http://chatgpt.com/c/not-secure")).toBeNull();
    expect(normalizeChatUrl("https://example.com/c/not-chatgpt")).toBeNull();
  });
});

describe("resolveConversation", () => {
  it("treats a missing file as a new workspace (Project by default)", () => {
    const view = resolveConversation(null);
    expect(view.mode).toBe("project");
    expect(view.reason).toBe("new-workspace");
    expect(view.reuseSavedChat).toBe(false);
    expect(view.projectReady).toBe(false);
  });

  it("does not reuse a projectless direct chat", () => {
    const view = resolveConversation({
      url: "https://chatgpt.com/c/old-chat",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(view.mode).toBe("project");
    expect(view.reason).toBe("new-workspace");
    expect(view.reuseSavedChat).toBe(false);
    expect(view.chatUrl).toBeNull();
  });

  it("uses Project when a collection URL is stored", () => {
    const view = resolveConversation({
      conversationMode: "project",
      projectUrl: PROJECT,
      url: PROJECT_CHAT,
      connectorName: "Codex with ChatGPT · Demo",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(view.mode).toBe("project");
    expect(view.projectReady).toBe(true);
    expect(view.reuseSavedChat).toBe(true);
    expect(view.connectorName).toBe("Codex with ChatGPT · Demo");
  });

  it("routes slugged and id-only URLs to one stable Project conversation", () => {
    const view = resolveConversation({
      conversationMode: "project",
      projectUrl: SLUGGED_PROJECT,
      url: SLUGGED_PROJECT_CHAT,
      savedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(view.projectUrl).toBe(CANONICAL_SLUGGED_PROJECT);
    expect(view.chatUrl).toBe(CANONICAL_SLUGGED_PROJECT_CHAT);
    expect(resolveConversationRoute(view)).toEqual({
      action: "resume-chat",
      targetUrl: CANONICAL_SLUGGED_PROJECT_CHAT,
      expectedChatUrl: CANONICAL_SLUGGED_PROJECT_CHAT,
      controlReady: true,
    });
  });

  it("does not route a Project session to a chat saved for another Project", () => {
    const view = resolveConversation({
      conversationMode: "project",
      projectUrl: PROJECT,
      url: "https://chatgpt.com/g/g-p-other/c/wrong-project",
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(view.chatUrl).toBeNull();
    expect(view.reuseSavedChat).toBe(false);
    expect(resolveConversationRoute(view).action).toBe("create-project-chat");
    expect(resolveConversationRoute(view).targetUrl).toBe(PROJECT);
  });

  it("returns an explicit browser route for each conversation state", () => {
    const saved = resolveConversation({
      conversationMode: "project",
      projectUrl: PROJECT,
      url: PROJECT_CHAT,
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(resolveConversationRoute(saved)).toEqual({
      action: "resume-chat",
      targetUrl: PROJECT_CHAT,
      expectedChatUrl: PROJECT_CHAT,
      controlReady: true,
    });

    const freshThread = resolveConversation({
      conversationMode: "project",
      projectUrl: PROJECT,
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(resolveConversationRoute(freshThread)).toEqual({
      action: "create-project-chat",
      targetUrl: PROJECT,
      expectedChatUrl: null,
      controlReady: false,
    });
    expect(resolveConversationRoute(resolveConversation(null)).action).toBe("bind-project");
  });
});

describe("mergeSession", () => {
  it("keeps Project fields when only the chat URL is updated", () => {
    const next = mergeSession(
      {
        conversationMode: "project",
        projectUrl: PROJECT,
        connectorName: "Codex with ChatGPT · Demo",
        url: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/old",
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        url: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/new",
        taskId: "c2c_ab12",
        iteration: 1,
      }
    );
    expect(next.projectUrl).toBe(PROJECT);
    expect(next.conversationMode).toBe("project");
    expect(next.url).toBe("https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/new");
    expect(next.connectorName).toBe("Codex with ChatGPT · Demo");
    expect(next.taskId).toBe("c2c_ab12");
  });

  it("does not modify persisted state when correlation validation fails", () => {
    const dir = isolateStateDir();
    const workspaceId = "prewrite123";
    const localSessionId = "session-prewrite";
    try {
      const initial = writeSession(
        workspaceId,
        {
          localSessionId,
          conversationMode: "project",
          projectUrl: PROJECT,
          connectorName: "Codex with ChatGPT · Demo",
          url: PROJECT_CHAT,
          taskId: "c2c_valid",
          iteration: 2,
          checkpoint: {
            taskId: "c2c_valid",
            iteration: 2,
            protocolState: "EXECUTED_SENT",
            waitingFor: "GPT_REVIEW",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          savedAt: "2026-01-01T00:00:00.000Z",
        },
        localSessionId
      );
      const workspaceFile = sessionFile(workspaceId);
      const threadFile = threadSessionFile(workspaceId, localSessionId);
      const beforeWorkspace = fs.readFileSync(workspaceFile, "utf8");
      const beforeThread = fs.readFileSync(threadFile, "utf8");

      expect(() =>
        writeSession(workspaceId, { ...initial, connectorName: "must not persist", taskId: "bad/task" }, localSessionId)
      ).toThrow(/task id/);
      expect(() =>
        writeSession(workspaceId, { ...initial, connectorName: "must not persist", iteration: -1 }, localSessionId)
      ).toThrow(/iteration/);
      expect(() =>
        writeSession(
          workspaceId,
          {
            ...initial,
            connectorName: "must not persist",
            checkpoint: { ...initial.checkpoint!, taskId: "c2c_other" },
          },
          localSessionId
        )
      ).toThrow(/checkpoint task|correlation/);
      expect(() =>
        writeSession(
          workspaceId,
          { ...initial, connectorName: "must not persist", title: "invalid\ncontrol" },
          localSessionId
        )
      ).toThrow(/title/);

      expect(fs.readFileSync(workspaceFile, "utf8")).toBe(beforeWorkspace);
      expect(fs.readFileSync(threadFile, "utf8")).toBe(beforeThread);
    } finally {
      cleanup(dir);
      delete process.env.C2C_STATE_DIR;
    }
  });

  it("persists a resumable RESEARCH checkpoint", () => {
    const dir = isolateStateDir();
    try {
      const saved = writeSession(
        "research123",
        {
          localSessionId: "session-research",
          conversationMode: "project",
          projectUrl: PROJECT,
          url: PROJECT_CHAT,
          taskId: "c2c_research1",
          iteration: 0,
          checkpoint: {
            taskId: "c2c_research1",
            iteration: 0,
            protocolState: "RESEARCH_SENT",
            waitingFor: "GPT_RESEARCH",
            mailboxRequestId: "research-request",
            mailboxPhase: "RESEARCH",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          savedAt: "2026-01-01T00:00:00.000Z",
        },
        "session-research"
      );

      expect(saved.checkpoint).toMatchObject({
        protocolState: "RESEARCH_SENT",
        waitingFor: "GPT_RESEARCH",
        mailboxPhase: "RESEARCH",
      });
      expect(readSession("research123", "session-research")?.checkpoint).toEqual(saved.checkpoint);
    } finally {
      cleanup(dir);
      delete process.env.C2C_STATE_DIR;
    }
  });

  it("keeps separate chat URLs and checkpoints per local session", () => {
    const dir = isolateStateDir();
    const workspaceBase = {
      conversationMode: "project" as const,
      projectUrl: PROJECT,
      connectorName: "Codex with ChatGPT · Demo",
      savedAt: "2026-01-01T00:00:00.000Z",
    };
    try {
      writeSession(
        "parallel123",
        {
          ...workspaceBase,
          localSessionId: "session-a",
          url: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-a",
          taskId: "c2c_a001",
          iteration: 1,
          checkpoint: {
            taskId: "c2c_a001",
            iteration: 1,
            protocolState: "INIT",
            waitingFor: "GPT_PLAN",
            mailboxRequestId: "req-a",
            mailboxPhase: "PLAN",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        "session-a"
      );
      writeSession(
        "parallel123",
        {
          localSessionId: "session-b",
          url: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/chat-b",
          taskId: "c2c_b001",
          iteration: 2,
          savedAt: "2026-01-01T00:00:00.000Z",
        },
        "session-b"
      );

      const a = readSession("parallel123", "session-a");
      const b = readSession("parallel123", "session-b");
      expect(a?.projectUrl).toBe(PROJECT);
      expect(b?.projectUrl).toBe(PROJECT);
      expect(a?.url).toContain("chat-a");
      expect(b?.url).toContain("chat-b");
      expect(a?.checkpoint?.mailboxRequestId).toBe("req-a");
      expect(b?.checkpoint).toBeUndefined();
      expect(resolveConversation(a).reuseSavedChat).toBe(true);
      expect(resolveConversation(b).reuseSavedChat).toBe(true);

      const fresh = readSession("parallel123", "session-c");
      expect(fresh?.url).toBeUndefined();
      expect(resolveConversation(fresh).reuseSavedChat).toBe(false);
    } finally {
      cleanup(dir);
      delete process.env.C2C_STATE_DIR;
    }
  });

  it("merges each update from the latest shared workspace state", () => {
    const dir = isolateStateDir();
    try {
      commitSessionRoute("atomic123456", "session-a", {
        projectUrl: PROJECT,
        connectorName: "Codex with ChatGPT - Initial",
        chatUrl: `${PROJECT.slice(0, -"/project".length)}/c/chat-a`,
      });
      const staleSessionA = readSession("atomic123456", "session-a");
      expect(staleSessionA?.connectorName).toBe("Codex with ChatGPT - Initial");

      updateSession("atomic123456", "session-b", {
        taskId: "c2c_b001",
        iteration: 1,
      });
      updateSession("atomic123456", "session-a", {
        taskId: "c2c_a001",
        iteration: 2,
      });

      expect(readSession("atomic123456", "session-a")).toMatchObject({
        connectorName: "Codex with ChatGPT - Initial",
        taskId: "c2c_a001",
        iteration: 2,
      });
      expect(readSession("atomic123456", "session-b")).toMatchObject({
        connectorName: "Codex with ChatGPT - Initial",
        taskId: "c2c_b001",
        iteration: 1,
      });
      expect(() =>
        updateSession("atomic123456", "session-a", {
          localSessionId: "session-b",
          taskId: "c2c_wrong",
        })
      ).toThrow(/does not match/);
    } finally {
      cleanup(dir);
      delete process.env.C2C_STATE_DIR;
    }
  });

  it("does not allow a local session to replace its shared Project binding", () => {
    const dir = isolateStateDir();
    try {
      commitSessionRoute("shared-project", "session-a", {
        projectUrl: PROJECT,
        chatUrl: PROJECT_CHAT,
      });

      expect(() =>
        updateSession("shared-project", "session-b", {
          conversationMode: "project",
          projectUrl: OTHER_PROJECT,
        })
      ).toThrow(/surface commit/);

      expect(readSession("shared-project", "session-a")?.projectUrl).toBe(PROJECT);
      expect(readSession("shared-project", "session-b")?.projectUrl).toBe(PROJECT);
    } finally {
      cleanup(dir);
      delete process.env.C2C_STATE_DIR;
    }
  });

  it("does not let checkpoint route fields bypass the committed surface route", () => {
    const dir = isolateStateDir();
    try {
      commitSessionRoute("checkpoint-route", "session-a", {
        projectUrl: PROJECT,
        chatUrl: PROJECT_CHAT,
      });

      const updated = updateSession("checkpoint-route", "session-a", {
        taskId: "c2c_checkpoint_route",
        iteration: 0,
        checkpoint: {
          protocolState: "PLAN_RECEIVED",
          waitingFor: "GPT_REVIEW",
          chatUrl: OTHER_PROJECT.replace("/project", "/c/attempted-route"),
          projectUrl: OTHER_PROJECT,
        },
      });

      expect(updated.projectUrl).toBe(PROJECT);
      expect(updated.url).toBe(PROJECT_CHAT);
      expect(updated.checkpoint).toMatchObject({
        protocolState: "PLAN_RECEIVED",
        chatUrl: PROJECT_CHAT,
        projectUrl: PROJECT,
      });
    } finally {
      cleanup(dir);
      delete process.env.C2C_STATE_DIR;
    }
  });

  it("rejects an older surface commit from downgrading the saved route", () => {
    const dir = isolateStateDir();
    try {
      commitSessionRoute("surface-cas", "session-a", {
        projectUrl: PROJECT,
        chatUrl: `${PROJECT.slice(0, -"/project".length)}/c/chat-new`,
        surfaceGeneration: 2,
        surfaceTabId: "tab-new",
      });

      expect(() =>
        commitSessionRoute("surface-cas", "session-a", {
          projectUrl: PROJECT,
          chatUrl: `${PROJECT.slice(0, -"/project".length)}/c/chat-old`,
          surfaceGeneration: 1,
          surfaceTabId: "tab-old",
        })
      ).toThrow(/stale/);

      expect(readSession("surface-cas", "session-a")).toMatchObject({
        url: `${PROJECT.slice(0, -"/project".length)}/c/chat-new`,
        surfaceGeneration: 2,
        surfaceTabId: "tab-new",
      });
    } finally {
      cleanup(dir);
      delete process.env.C2C_STATE_DIR;
    }
  });

  it("does not let mergeSession replace an existing Project binding", () => {
    expect(() =>
      mergeSession(
        {
          conversationMode: "project",
          projectUrl: PROJECT,
          savedAt: "2026-01-01T00:00:00.000Z",
        },
        { projectUrl: OTHER_PROJECT }
      )
    ).toThrow(/already bound to a different ChatGPT Project/);
  });

  it("rejects thread state moved to another local session path", () => {
    const dir = isolateStateDir();
    try {
      writeSession(
        "session-swap",
        {
          localSessionId: "session-a",
          conversationMode: "project",
          projectUrl: PROJECT,
          url: `${PROJECT.slice(0, -"/project".length)}/c/chat-a`,
          savedAt: "2026-01-01T00:00:00.000Z",
        },
        "session-a"
      );
      writeSession(
        "session-swap",
        {
          localSessionId: "session-b",
          url: `${PROJECT.slice(0, -"/project".length)}/c/chat-b`,
          savedAt: "2026-01-01T00:00:00.000Z",
        },
        "session-b"
      );
      const aFile = threadSessionFile("session-swap", "session-a");
      const bFile = threadSessionFile("session-swap", "session-b");
      const a = fs.readFileSync(aFile, "utf8");
      fs.writeFileSync(aFile, fs.readFileSync(bFile, "utf8"));
      fs.writeFileSync(bFile, a);

      expect(() => readSession("session-swap", "session-a")).toThrow(/does not match its storage path/);
      expect(() => readSession("session-swap", "session-b")).toThrow(/does not match its storage path/);
    } finally {
      cleanup(dir);
      delete process.env.C2C_STATE_DIR;
    }
  });

  it("rejects workspace state moved to another workspace path", () => {
    const dir = isolateStateDir();
    try {
      writeSession("workspace-a", {
        conversationMode: "project",
        projectUrl: PROJECT,
        savedAt: "2026-01-01T00:00:00.000Z",
      });
      writeSession("workspace-b", {
        conversationMode: "project",
        projectUrl: PROJECT,
        savedAt: "2026-01-01T00:00:00.000Z",
      });
      fs.copyFileSync(sessionFile("workspace-a"), sessionFile("workspace-b"));

      expect(() => readSession("workspace-b")).toThrow(/does not match its storage path/);
    } finally {
      cleanup(dir);
      delete process.env.C2C_STATE_DIR;
    }
  });

  it("rejects malformed persisted state instead of routing from partial data", () => {
    const dir = isolateStateDir();
    try {
      writeSession("malformed-state", {
        conversationMode: "project",
        projectUrl: PROJECT,
        savedAt: "2026-01-01T00:00:00.000Z",
      });
      fs.writeFileSync(sessionFile("malformed-state"), "{");
      expect(() => readSession("malformed-state")).toThrow(/unreadable or malformed/);
    } finally {
      cleanup(dir);
      delete process.env.C2C_STATE_DIR;
    }
  });

  it("rejects every invalid persisted correlation and metadata field", () => {
    const dir = isolateStateDir();
    const workspaceId = "strict-state";
    const localSessionId = "strict-session";
    try {
      writeSession(
        workspaceId,
        {
          localSessionId,
          conversationMode: "project",
          projectUrl: PROJECT,
          connectorName: "Codex with ChatGPT · Strict",
          url: PROJECT_CHAT,
          title: "C2C Strict",
          taskId: "c2c_strict",
          iteration: 3,
          lastState: "EXECUTED",
          checkpoint: {
            taskId: "c2c_strict",
            iteration: 3,
            protocolState: "EXECUTED_SENT",
            waitingFor: "GPT_REVIEW",
            originalGoal: "verify persisted state",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          savedAt: "2026-01-01T00:00:00.000Z",
        },
        localSessionId
      );
      const workspacePath = sessionFile(workspaceId);
      const threadPath = threadSessionFile(workspaceId, localSessionId);
      const validWorkspace = JSON.parse(fs.readFileSync(workspacePath, "utf8")) as Record<string, unknown>;
      const validThread = JSON.parse(fs.readFileSync(threadPath, "utf8")) as Record<string, unknown>;

      const invalidThreadMutations: Array<(value: Record<string, unknown>) => void> = [
        (value) => { value.taskId = "../other"; },
        (value) => { value.iteration = 10_001; },
        (value) => { value.title = "invalid\ncontrol"; },
        (value) => { value.lastState = 42; },
        (value) => { value.savedAt = "2026-01-01"; },
        (value) => { value.unexpected = true; },
        (value) => {
          (value.checkpoint as Record<string, unknown>).originalGoal = "x".repeat(501);
        },
        (value) => {
          (value.checkpoint as Record<string, unknown>).chatUrl =
            "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/other";
        },
      ];
      for (const mutate of invalidThreadMutations) {
        const invalid = structuredClone(validThread);
        mutate(invalid);
        fs.writeFileSync(threadPath, JSON.stringify(invalid));
        expect(() => readSession(workspaceId, localSessionId)).toThrow();
      }
      fs.writeFileSync(threadPath, JSON.stringify(validThread));

      const invalidWorkspaceMutations: Array<(value: Record<string, unknown>) => void> = [
        (value) => { value.connectorName = "invalid\u0000name"; },
        (value) => { delete value.projectUrl; },
        (value) => { value.unexpected = true; },
      ];
      for (const mutate of invalidWorkspaceMutations) {
        const invalid = structuredClone(validWorkspace);
        mutate(invalid);
        fs.writeFileSync(workspacePath, JSON.stringify(invalid));
        expect(() => readSession(workspaceId, localSessionId)).toThrow();
      }
    } finally {
      cleanup(dir);
      delete process.env.C2C_STATE_DIR;
    }
  });

  it("writes and clears a checkpoint without dropping the chat URL", () => {
    const withCheckpoint = mergeSession(
      {
        conversationMode: "project",
        projectUrl: PROJECT,
        url: PROJECT_CHAT,
        taskId: "c2c_ab12",
        iteration: 7,
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        checkpoint: {
          protocolState: "EXECUTED_SENT",
          waitingFor: "GPT_REVIEW",
          originalGoal: "dark mode",
          nextExpectedStep: "wait for review",
        },
      }
    );
    expect(withCheckpoint.url).toBe(PROJECT_CHAT);
    expect(withCheckpoint.checkpoint?.protocolState).toBe("EXECUTED_SENT");
    expect(withCheckpoint.checkpoint?.waitingFor).toBe("GPT_REVIEW");
    expect(withCheckpoint.checkpoint?.taskId).toBe("c2c_ab12");
    const cleared = mergeSession(withCheckpoint, { clearCheckpoint: true });
    expect(cleared.checkpoint).toBeUndefined();
    expect(cleared.url).toBe(PROJECT_CHAT);
  });

  it("does not carry mailbox result metadata into a new request", () => {
    const previous = mergeSession(
      {
        conversationMode: "project",
        projectUrl: PROJECT,
        url: PROJECT_CHAT,
        taskId: "c2c_ab12",
        iteration: 1,
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        checkpoint: {
          protocolState: "PLAN_RECEIVED",
          waitingFor: "none",
          mailboxRequestId: "request-plan",
          mailboxPhase: "PLAN",
          mailboxResultId: "result-plan",
        },
      }
    );

    const nextRequest = mergeSession(previous, {
      iteration: 2,
      checkpoint: {
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        mailboxRequestId: "request-review",
        mailboxPhase: "REVIEW",
      },
    });
    expect(nextRequest.checkpoint?.mailboxRequestId).toBe("request-review");
    expect(nextRequest.checkpoint?.mailboxPhase).toBe("REVIEW");
    expect(nextRequest.checkpoint?.mailboxResultId).toBeUndefined();

    const browserFallback = mergeSession(nextRequest, {
      clearMailbox: true,
      checkpoint: {
        protocolState: "PLAN_RECEIVED",
        waitingFor: "none",
      },
    });
    expect(browserFallback.checkpoint?.mailboxRequestId).toBeUndefined();
    expect(browserFallback.checkpoint?.mailboxPhase).toBeUndefined();
    expect(browserFallback.checkpoint?.mailboxResultId).toBeUndefined();
  });

  it("requires complete mailbox correlation and clears it when the turn changes", () => {
    expect(() =>
      mergeSession(
        {
          conversationMode: "project",
          projectUrl: PROJECT,
          url: PROJECT_CHAT,
          taskId: "c2c_ab12",
          iteration: 0,
          savedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          checkpoint: {
            protocolState: "INIT",
            waitingFor: "GPT_PLAN",
            mailboxRequestId: "request-only",
          },
        }
      )
    ).toThrow(/request id and phase together/);

    const previous = mergeSession(
      {
        conversationMode: "project",
        projectUrl: PROJECT,
        url: PROJECT_CHAT,
        taskId: "c2c_ab12",
        iteration: 0,
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        checkpoint: {
          protocolState: "PLAN_RECEIVED",
          waitingFor: "none",
          mailboxRequestId: "plan-request",
          mailboxPhase: "PLAN",
          mailboxResultId: "plan-result",
        },
      }
    );
    const nextIteration = mergeSession(previous, {
      iteration: 1,
      checkpoint: { protocolState: "EXECUTED_LOCAL", waitingFor: "none" },
    });
    expect(nextIteration.checkpoint?.mailboxRequestId).toBeUndefined();
    expect(nextIteration.checkpoint?.mailboxPhase).toBeUndefined();
    expect(nextIteration.checkpoint?.mailboxResultId).toBeUndefined();
  });

  it("keeps an existing checkpoint when only the chat URL is updated", () => {
    const previous = mergeSession(
      {
        conversationMode: "project",
        projectUrl: PROJECT,
        url: PROJECT_CHAT,
        taskId: "c2c_ab12",
        iteration: 7,
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        checkpoint: {
          protocolState: "EXECUTED_SENT",
          waitingFor: "GPT_REVIEW",
          originalGoal: "dark mode",
        },
      }
    );
    const nextChat = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/new";
    const next = mergeSession(previous, { url: nextChat });
    expect(next.url).toBe(nextChat);
    expect(next.checkpoint?.protocolState).toBe("EXECUTED_SENT");
    expect(next.checkpoint?.originalGoal).toBe("dark mode");
    expect(next.checkpoint?.chatUrl).toBe(nextChat);
  });

  it("caps checkpoint text so it cannot become a log dump", () => {
    const next = mergeSession(
      {
        conversationMode: "project",
        projectUrl: PROJECT,
        url: PROJECT_CHAT,
        taskId: "c2c_ab12",
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        checkpoint: {
          protocolState: "PLAN_RECEIVED",
          originalGoal: "x".repeat(600),
        },
      }
    );
    expect(next.checkpoint?.originalGoal?.length).toBeLessThanOrEqual(501);
    expect(next.checkpoint?.originalGoal?.endsWith("…")).toBe(true);
  });

  it("leaves Project sessions without a checkpoint unchanged", () => {
    const next = mergeSession(
      {
        conversationMode: "project",
        projectUrl: PROJECT,
        url: PROJECT_CHAT,
        taskId: "c2c_aa01",
        iteration: 2,
        lastState: "EXECUTED",
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      { iteration: 3, lastState: "EXECUTED" }
    );
    expect(next.checkpoint).toBeUndefined();
    expect(next.taskId).toBe("c2c_aa01");
  });

  it("rejects a non-collection project URL", () => {
    expect(() =>
      mergeSession(null, {
        conversationMode: "project",
        projectUrl: "https://chatgpt.com/c/nope",
      })
    ).toThrow(/project URL/);
  });

  it("rejects an invalid chat URL or a chat from another Project", () => {
    expect(() =>
      mergeSession(null, {
        conversationMode: "project",
        projectUrl: PROJECT,
        url: "https://example.com/c/nope",
      })
    ).toThrow(/chat URL/);
    expect(() =>
      mergeSession(null, {
        conversationMode: "project",
        projectUrl: PROJECT,
        url: "https://chatgpt.com/g/g-p-other/c/wrong-project",
      })
    ).toThrow(/must belong/);
  });
});

describe("stable project session key", () => {
  it("keeps the Project and local chat mapping after a Git checkout moves", () => {
    const stateDir = isolateStateDir();
    const parent = makeTmpDir("session-project-move");
    const original = path.join(parent, "original");
    const moved = path.join(parent, "moved");
    fs.mkdirSync(original);
    try {
      makeGitRepo(original);
      const before = new Workspace(original);
      commitSessionRoute(before.projectId, "session-move", {
        projectUrl: PROJECT,
        chatUrl: PROJECT_CHAT,
        connectorName: "Codex with ChatGPT",
      });

      fs.renameSync(original, moved);
      const after = new Workspace(moved);
      expect(after.id).not.toBe(before.id);
      expect(after.projectId).toBe(before.projectId);
      expect(readSession(after.projectId, "session-move")).toMatchObject({
        conversationMode: "project",
        projectUrl: PROJECT,
        url: PROJECT_CHAT,
      });
    } finally {
      cleanup(parent);
      cleanup(stateDir);
      delete process.env.C2C_STATE_DIR;
    }
  });
});

describe("clearChatPointer", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("keeps the collection binding in Project mode", () => {
    const dir = makeTmpDir("session-clear");
    dirs.push(dir);
    process.env.C2C_STATE_DIR = dir;
    writeSession("abc123abc123", {
      conversationMode: "project",
      projectUrl: PROJECT,
      url: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/gone",
      connectorName: "Codex with ChatGPT · Demo",
      checkpoint: {
        taskId: "c2c_ab12",
        iteration: 4,
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        originalGoal: "dark mode",
        chatUrl: "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/c/gone",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      savedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(clearChatPointer("abc123abc123")).toEqual({ cleared: true, keptProject: true });
    const saved = readSession("abc123abc123");
    expect(saved?.projectUrl).toBe(PROJECT);
    expect(saved?.url).toBeUndefined();
    expect(saved?.checkpoint?.protocolState).toBe("EXECUTED_SENT");
    expect(saved?.checkpoint?.chatUrl).toBeUndefined();
  });

});

describe("retireSession", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("removes one checkout route while preserving the Project configuration", () => {
    const dir = isolateStateDir();
    dirs.push(dir);
    const project = writeSession("workspace-retire", {
      conversationMode: "project",
      projectUrl: PROJECT,
      url: PROJECT_CHAT,
      connectorName: "Codex with ChatGPT",
      taskId: "task-retire",
      iteration: 2,
      savedAt: "2026-01-01T00:00:00.000Z",
    }, "session-retire");
    writeSession("workspace-retire", {
      conversationMode: "project",
      projectUrl: PROJECT,
      url: `${PROJECT.slice(0, -"project".length)}c/bbbbbbbb-cccc-dddd-eeee-ffffffffffff`,
      savedAt: "2026-01-01T00:00:00.000Z",
    }, "session-keep");

    expect(project.url).toBe(PROJECT_CHAT);
    expect(retireSession("workspace-retire", "session-retire")).toBe(true);
    expect(retireSession("workspace-retire", "session-retire")).toBe(false);
    expect(fs.existsSync(threadSessionFile("workspace-retire", "session-retire"))).toBe(false);
    expect(readSession("workspace-retire", "session-retire")).toMatchObject({
      projectUrl: PROJECT,
      conversationMode: "project",
      connectorName: "Codex with ChatGPT",
    });
    expect(readSession("workspace-retire", "session-retire")?.url).toBeUndefined();
    expect(readSession("workspace-retire", "session-keep")?.url).toContain("bbbbbbbb");
    expect(fs.existsSync(sessionFile("workspace-retire"))).toBe(true);
  });
});
