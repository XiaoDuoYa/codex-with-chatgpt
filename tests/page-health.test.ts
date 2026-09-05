import { describe, expect, it } from "vitest";
import { assessPageHealth, type PageObservation } from "../src/session/page-health.js";
import type { SurfaceBinding, SurfaceLease } from "../src/session/surface-ownership.js";

const projectUrl = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
const chatUrl = projectUrl.replace("/project", "/c/chat-a");
const lease: SurfaceLease = {
  projectId: "project-a", localSessionId: "session-a", browserId: "iab", surfaceId: "chatgpt",
  tabId: "tab-a", projectUrl, chatUrl, generation: 7, ownerProcessEpoch: "owner-a", ownerPid: 1,
  claimedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
};
const binding: SurfaceBinding = {
  projectId: lease.projectId, localSessionId: lease.localSessionId, browserId: "iab", surfaceId: "chatgpt",
  tabId: lease.tabId, projectUrl, chatUrl, lastGeneration: lease.generation,
  boundAt: lease.claimedAt, updatedAt: lease.updatedAt,
};
const surface = { projectUrl, lease, binding };
const observation: PageObservation = { tabId: "tab-a", generation: 7, state: "ready", url: chatUrl };

describe("host page recovery decisions", () => {
  it("treats a reachable archived chat as unsendable and uses the stored Project", () => {
    expect(assessPageHealth(surface, { ...observation, state: "archived" })).toMatchObject({
      action: "create-project-chat", targetUrl: projectUrl, controlReady: false, tabAction: "navigate-owned",
    });
    expect(assessPageHealth(surface, { ...observation, state: "unavailable", url: "https://chatgpt.com/" })).toMatchObject({
      action: "reopen-chat", targetUrl: chatUrl, tabAction: "create",
    });
  });

  it("reopens the saved chat for a closed or navigated-away tab", () => {
    for (const probe of [
      { ...observation, state: "missing" as const, url: undefined },
      { ...observation, url: "https://chatgpt.com/" },
      { ...observation, url: chatUrl.replace("chat-a", "chat-b") },
    ]) {
      expect(assessPageHealth(surface, probe)).toMatchObject({
        action: "reopen-chat", targetUrl: chatUrl, controlReady: false, tabAction: "create",
      });
    }
  });

  it("reuses a confirmed unavailable chat tab but never navigates an unrelated or unverified page", () => {
    expect(assessPageHealth(surface, { ...observation, state: "unavailable" }).tabAction).toBe("navigate-owned");
    expect(assessPageHealth(surface, { ...observation, state: "archived", url: chatUrl.replace("chat-a", "other") })).toMatchObject({
      action: "reopen-chat", tabAction: "create", targetUrl: chatUrl,
    });
    expect(assessPageHealth({ ...surface, binding: null, lease: { ...lease, chatUrl: undefined } }, {
      ...observation, state: "unavailable", url: projectUrl,
    })).toMatchObject({ action: "inspect-page", tabAction: "inspect" });
    expect(assessPageHealth({ ...surface, lease: null }, observation)).toMatchObject({
      action: "verify-candidate", tabAction: "keep",
    });
    for (const state of ["ready", "loading", "generating", "auth-required", "consent-required"] as const) {
      expect(assessPageHealth(surface, { ...observation, state }).tabAction).toBe("keep");
    }
  });

  it("does not turn transient, authentication or ambiguous states into replacement", () => {
    for (const state of ["auth-required", "consent-required"] as const) {
      expect(assessPageHealth(surface, { ...observation, state, url: "https://chatgpt.com/" }).action).toBe("user-action");
    }
    for (const state of ["loading", "generating"] as const) {
      expect(assessPageHealth(surface, { ...observation, state, url: undefined }).action).toBe("wait");
    }
    expect(assessPageHealth(surface, { ...observation, state: "unknown" }).action).toBe("inspect-page");
    expect(assessPageHealth(surface, { ...observation, url: undefined }).action).toBe("inspect-page");
    expect(() => assessPageHealth({ projectUrl: null, lease: null, binding: null }, observation)).toThrow(/current surface/);
  });

  it("rejects observations from another page or an older generation", () => {
    expect(() => assessPageHealth(surface, { ...observation, tabId: "tab-b", state: "archived" })).toThrow(/tab and generation/);
    expect(() => assessPageHealth(surface, { ...observation, generation: 6 })).toThrow(/tab and generation/);
  });

  it("accepts a slug-normalized ready route only after lease and BOOT commit", () => {
    expect(assessPageHealth(surface, {
      ...observation, url: chatUrl.replace("/c/", "-workspace-name/c/"),
    }).controlReady).toBe(true);
    expect(assessPageHealth({ ...surface, lease: null }, observation).controlReady).toBe(false);
    expect(assessPageHealth({ ...surface, binding: { ...binding, lastGeneration: 6 } }, observation).action).toBe("verify-candidate");
    expect(assessPageHealth({ projectUrl: null, binding: null, lease: { ...lease, chatUrl: undefined } }, {
      ...observation, url: projectUrl,
    }).action).toBe("verify-candidate");
    expect(assessPageHealth({ projectUrl, binding: null, lease: { ...lease, chatUrl: undefined } }, observation).action).toBe("verify-candidate");
  });
});
