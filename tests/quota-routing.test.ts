import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { summarizeQuota } from "../src/routing/quota.js";
import { chooseRoute, routeHookOutput } from "../src/routing/route.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const window = (usedPercent: number, windowDurationMins = 300) => ({ usedPercent, windowDurationMins, resetsAt: 1_900_000_000 });
const snapshot = (usedPercent: number) => ({ limitId: "codex", primary: window(usedPercent), secondary: null, rateLimitReachedType: null });

describe("quota routing", () => {
  it("uses the tightest window in the codex bucket, independently of other buckets", () => {
    const quota = summarizeQuota({
      rateLimits: snapshot(99),
      rateLimitsByLimitId: {
        codex: { ...snapshot(12), secondary: window(84, 10080) },
        reserve: { ...snapshot(100), limitId: "reserve" },
      },
    });
    expect(quota.effectiveRemainingPercent).toBe(16);
    expect(quota.windows.map((entry) => entry.durationMinutes)).toEqual([300, 10080]);
    expect(chooseRoute(quota, 20).mode).toBe("chatgpt");
  });

  it("supports a weekly primary window and the single-bucket response", () => {
    const quota = summarizeQuota({ rateLimits: { ...snapshot(58), primary: window(58, 10080) } });
    expect(quota.windows).toHaveLength(1);
    expect(quota.effectiveRemainingPercent).toBe(42);
    expect(chooseRoute(quota, 20)).toMatchObject({ mode: "codex", reason: "quota_healthy" });
  });

  it.each([[79, "codex"], [80, "chatgpt"], [81, "chatgpt"]])("routes %s percent used at the inclusive threshold", (used, mode) => {
    expect(chooseRoute(summarizeQuota({ rateLimits: snapshot(Number(used)) }), 20).mode).toBe(mode);
  });

  it("honors a reached limit even with healthy or missing percentage windows", () => {
    for (const primary of [window(10), null]) {
      const quota = summarizeQuota({ rateLimits: { ...snapshot(10), primary, rateLimitReachedType: "rate_limit_reached" } });
      expect(chooseRoute(quota, 20)).toMatchObject({ mode: "chatgpt", reason: "quota_limit_reached" });
    }
  });

  it("honors an explicit ordinary-usage denial before percentages", () => {
    for (const primary of [window(10), null]) {
      const quota = summarizeQuota({ ordinaryUsageAllowed: false, rateLimits: { ...snapshot(10), primary } });
      expect(chooseRoute(quota, 20)).toMatchObject({ mode: "chatgpt", reason: "ordinary_usage_not_allowed" });
    }
    expect(summarizeQuota({ rateLimits: snapshot(10) }).ordinaryUsageAllowed).toBeNull();
  });

  it("treats an explicit unknown permission as unavailable rather than recovered", () => {
    expect(() => summarizeQuota({ ordinaryUsageAllowed: null, rateLimits: snapshot(10) }))
      .toThrow("ordinary-usage permission is unavailable");
  });

  it.each([
    { rateLimits: null },
    { rateLimits: { ...snapshot(10), primary: null } },
    { rateLimits: { ...snapshot(10), primary: { ...window(10), usedPercent: null } } },
    { rateLimits: { ...snapshot(10), limitId: "reserve" } },
  ])("rejects unavailable, malformed, and unrelated quota", (response) => {
    expect(() => summarizeQuota(response)).toThrow();
  });

  it("clamps remaining percentages to 0–100", () => {
    expect(summarizeQuota({ rateLimits: snapshot(110) }).effectiveRemainingPercent).toBe(0);
    expect(summarizeQuota({ rateLimits: snapshot(-2) }).effectiveRemainingPercent).toBe(100);
  });

  it("selects native Codex again after a fresh healthy read", () => {
    const low = chooseRoute(summarizeQuota({ rateLimits: snapshot(90) }), 20);
    const healthy = chooseRoute(summarizeQuota({ rateLimits: snapshot(10) }), 20);
    expect(low.mode).toBe("chatgpt");
    expect(healthy.mode).toBe("codex");
    expect(routeHookOutput(healthy)).toMatchObject({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: expect.stringContaining("native Codex") },
    });
  });
});

describe("quota CLI and app-server transport", () => {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli/index.ts");
  let root: string;
  beforeAll(() => {
    root = makeTmpDir("quota-rpc");
    // Node acts as the Codex executable and loads this app-server fixture.
    write(root, "app-server", `
import fs from "node:fs";
import { createInterface } from "node:readline";
fs.writeFileSync("child.pid", String(process.pid));
const lines = createInterface({ input: process.stdin });
let initialized = false;
lines.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync("requests.jsonl", line + "\\n");
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
  } else if (message.method === "initialized") {
    initialized = true;
  } else if (message.method === "account/rateLimits/read" && initialized) {
    const mode = process.env.C2C_TEST_RPC_MODE;
    if (mode === "hang") return;
    if (mode === "exit") process.exit(3);
    if (mode === "invalid") { process.stdout.write("null\\n"); return; }
    if (mode === "error") {
      process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32000, message: "Sign in with ChatGPT to read quota." } }) + "\\n");
      return;
    }
    process.stdout.write(JSON.stringify({ method: "account/rateLimits/updated", params: {} }) + "\\n");
    const response = JSON.stringify({ id: message.id, result: JSON.parse(process.env.C2C_TEST_QUOTA) }) + "\\n";
    process.stdout.write(response.slice(0, 10));
    setImmediate(() => process.stdout.write(response.slice(10)));
  } else process.exit(4);
});
`);
  });
  afterAll(() => cleanup(root));

  function run(command: string, args: string[] = [], mode = "ok", response: unknown = { rateLimits: snapshot(85) }) {
    return spawnSync(process.execPath, ["--import", "tsx", cli, command, "--codex-bin", process.execPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: "Implement a feature" }),
      env: { ...process.env, C2C_TEST_RPC_MODE: mode, C2C_TEST_QUOTA: JSON.stringify(response) },
    });
  }

  it("performs the handshake, ignores notifications, and reads split response chunks", () => {
    const result = run("quota", ["--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ available: true, effectiveRemainingPercent: 15 });
    const methods = fs.readFileSync(path.join(root, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line).method);
    expect(methods).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
  });

  it("emits a valid low-quota hook payload", () => {
    const result = run("route", ["--hook", "--threshold", "20"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: expect.stringContaining("codex-with-chatgpt skill"),
    } });
  });

  it.each(["error", "invalid", "exit"])("keeps routing usable after an app-server %s", (mode) => {
    const result = run("route", ["--json"], mode);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: "codex", reason: "quota_unavailable", remainingPercent: null });
  });

  it("reports an unavailable quota as an unsuccessful diagnostic", () => {
    const result = run("quota", ["--json"], "ok", { rateLimits: null });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).available).toBe(false);
  });

  it("bounds a stalled quota read and reaps its subprocess", () => {
    const result = run("route", ["--json"], "hang");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: "codex", reason: "quota_unavailable", error: "Codex quota read timed out." });
    const pid = Number(fs.readFileSync(path.join(root, "child.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("rejects a threshold outside 0–100", () => {
    const result = run("route", ["--threshold", "101", "--json"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("threshold must be a number from 0 to 100");
  });
});
