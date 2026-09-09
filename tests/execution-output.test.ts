import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeExecutionOutput, MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from "../src/execution/sanitize.js";
import { listExecutionOutputs, readExecutionOutput, saveExecutionOutput } from "../src/execution/output.js";
import { cleanup, isolateStateDir } from "./helpers.js";

describe("sanitizeExecutionOutput", () => {
  it("redacts bearer tokens and pairing-code shaped strings", () => {
    const result = sanitizeExecutionOutput(
      "Authorization: Bearer c2c_at_abcdefghijklmnopqrstuv\ncode ABCD-EFGH failed"
    );
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.text).not.toMatch(/c2c_at_/);
      expect(result.text).toContain("[REDACTED]");
      expect(result.text).not.toContain("ABCD-EFGH");
    }
  });

  it("rejects private keys entirely", () => {
    const result = sanitizeExecutionOutput("oops\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("private_key");
  });

  it("rejects PGP private key blocks", () => {
    const result = sanitizeExecutionOutput("-----BEGIN PGP PRIVATE KEY BLOCK-----\nversion\n-----END PGP PRIVATE KEY BLOCK-----");
    expect(result.allowed).toBe(false);
  });

  it("redacts home paths", () => {
    const result = sanitizeExecutionOutput("wrote /Users/alice/proj/src/a.ts");
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.text).not.toContain("/Users/alice");
      expect(result.text).toContain("/Users/[user]");
    }
  });

  it("truncates giant logs", () => {
    const raw = Array.from({ length: MAX_OUTPUT_LINES + 50 }, (_, i) => `line ${i}`).join("\n");
    const result = sanitizeExecutionOutput(raw);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.truncated).toBe(true);
      expect(result.text.split("\n").length).toBeLessThanOrEqual(MAX_OUTPUT_LINES + 2);
    }
  });

  it("keeps the truncation marker inside the byte limit", () => {
    const result = sanitizeExecutionOutput("界".repeat(MAX_OUTPUT_BYTES));
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    }
  });
});

describe("execution output store", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("stores readable output and hides restricted bodies", () => {
    dirs.push(isolateStateDir());
    const okItem = saveExecutionOutput("ws1", {
      command: "pnpm test",
      raw: "2 failed\nAssertionError: expected 1 to be 2",
      exitCode: 1,
      localSessionId: "session-a",
      taskId: "c2c_aa",
      iteration: 3,
    });
    expect(okItem.allowed).toBe(true);
    const listed = listExecutionOutputs("ws1");
    expect(listed.some((item) => item.id === okItem.id && item.allowed)).toBe(true);
    const read = readExecutionOutput("ws1", okItem.id);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.text).toContain("AssertionError");

    const blocked = saveExecutionOutput("ws1", {
      command: "cat key",
      raw: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
      exitCode: 0,
      localSessionId: "session-a",
      taskId: "c2c_aa",
      iteration: 3,
    });
    expect(blocked.allowed).toBe(false);
    const denied = readExecutionOutput("ws1", blocked.id);
    expect(denied).toEqual({ ok: false, error: "OUTPUT_RESTRICTED" });
  });

  it("redacts token-shaped text in the stored command", () => {
    dirs.push(isolateStateDir());
    const item = saveExecutionOutput("ws1", {
      command: "curl -H Bearer c2c_at_abcdefghijklmnopqrstuv",
      raw: "ok",
      exitCode: 0,
      localSessionId: "session-a",
      taskId: "c2c_aa",
      iteration: 1,
    });
    expect(item.command).not.toMatch(/c2c_at_/);
    expect(item.command).toContain("[REDACTED]");
  });

  it("filters output metadata by the exact local session, task, and iteration", () => {
    dirs.push(isolateStateDir());
    const expected = saveExecutionOutput("ws1", {
      command: "pnpm test",
      raw: "expected output",
      localSessionId: "session-a",
      taskId: "c2c_expected",
      iteration: 2,
    });
    saveExecutionOutput("ws1", {
      command: "pnpm test",
      raw: "other output",
      localSessionId: "session-b",
      taskId: "c2c_other",
      iteration: 2,
    });

    expect(
      listExecutionOutputs("ws1", 20, {
        localSessionId: "session-a",
        taskId: "c2c_expected",
        iteration: 2,
      }).map((item) => item.id)
    ).toEqual([expected.id]);
  });

  it("rejects swapped output bodies and indexes", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const first = saveExecutionOutput("ws1", {
      command: "pnpm test",
      raw: "first output",
      localSessionId: "session-a",
      taskId: "c2c_expected",
      iteration: 1,
    });
    const second = saveExecutionOutput("ws1", {
      command: "pnpm test",
      raw: "second output",
      localSessionId: "session-a",
      taskId: "c2c_expected",
      iteration: 2,
    });
    const bodyDir = path.join(stateDir, "workspace-data", "ws1", "execution-outputs", "bodies");
    const firstBody = path.join(bodyDir, `${first.id}.txt`);
    const secondBody = path.join(bodyDir, `${second.id}.txt`);
    const originalFirst = fs.readFileSync(firstBody);
    fs.copyFileSync(secondBody, firstBody);
    fs.writeFileSync(secondBody, originalFirst);

    expect(readExecutionOutput("ws1", first.id)).toEqual({ ok: false, error: "OUTPUT_INTEGRITY_ERROR" });
    expect(readExecutionOutput("ws1", second.id)).toEqual({ ok: false, error: "OUTPUT_INTEGRITY_ERROR" });

    saveExecutionOutput("ws2", {
      command: "pnpm test",
      raw: "workspace two",
      localSessionId: "session-a",
      taskId: "c2c_expected",
      iteration: 1,
    });
    fs.copyFileSync(
      path.join(stateDir, "workspace-data", "ws1", "execution-outputs", "index.json"),
      path.join(stateDir, "workspace-data", "ws2", "execution-outputs", "index.json")
    );
    expect(() => listExecutionOutputs("ws2")).toThrow(/does not match its workspace/);
  });

  it("rejects malformed, duplicate, unordered, and incomplete index metadata", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    saveExecutionOutput("ws1", {
      command: "pnpm test",
      raw: "first",
      exitCode: 0,
      localSessionId: "session-a",
      taskId: "c2c_expected",
      iteration: 1,
    });
    saveExecutionOutput("ws1", {
      command: "pnpm build",
      raw: "second",
      exitCode: 0,
      localSessionId: "session-a",
      taskId: "c2c_expected",
      iteration: 1,
    });
    const indexPath = path.join(stateDir, "workspace-data", "ws1", "execution-outputs", "index.json");
    const valid = JSON.parse(fs.readFileSync(indexPath, "utf8")) as {
      nextId: number;
      items: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
    const mutations: Array<(index: typeof valid) => void> = [
      (index) => { index.nextId = 99; },
      (index) => { index.items[1]!.id = index.items[0]!.id; },
      (index) => { index.items.reverse(); },
      (index) => { index.items[0]!.command = 42; },
      (index) => { index.items[0]!.exitCode = 999; },
      (index) => { index.items[0]!.timestamp = "yesterday"; },
      (index) => { index.items[0]!.localSessionId = "../session"; },
      (index) => { index.items[0]!.taskId = "bad/task"; },
      (index) => { index.items[0]!.iteration = 10_001; },
      (index) => { index.items[0]!.allowed = false; },
      (index) => { index.items[0]!.truncated = "yes"; },
      (index) => { index.items[0]!.sizeBytes = -1; },
      (index) => { index.items[0]!.contentHash = "invalid"; },
      (index) => { index.items[0]!.workspaceId = "ws2"; },
      (index) => { index.items[0]!.unexpected = true; },
      (index) => { index.unexpected = true; },
    ];

    for (const mutate of mutations) {
      const invalid = structuredClone(valid);
      mutate(invalid);
      fs.writeFileSync(indexPath, JSON.stringify(invalid));
      expect(() => listExecutionOutputs("ws1")).toThrow();
    }
  });

  it("rejects invalid correlation before creating an index", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    expect(() =>
      saveExecutionOutput("ws1", {
        command: "pnpm test",
        raw: "ok",
        localSessionId: "session-a",
        taskId: "bad/task",
        iteration: 1,
      })
    ).toThrow();
    expect(
      fs.existsSync(path.join(stateDir, "workspace-data", "ws1", "execution-outputs", "index.json"))
    ).toBe(false);
  });
});
