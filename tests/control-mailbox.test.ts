import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  acknowledgeControlResult,
  cancelControlResultRequest,
  getControlResultStatus,
  openControlResultRequest,
  pruneControlMailbox,
  reportControlProgress,
  submitControlResult,
  waitForControlResult,
} from "../src/control/mailbox.js";
import { writeSecureJsonExclusive } from "../src/config/paths.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const WORKSPACE_A = "workspaceaaa";
const WORKSPACE_B = "workspacebbb";

let stateDir: string;
const execFileAsync = promisify(execFile);

function correlation(iteration = 0, phase: "RESEARCH" | "PLAN" | "REVIEW" = "PLAN") {
  return { taskId: "c2c_plan", iteration, phase } as const;
}

function researchInput(requestId: string, overrides: Record<string, unknown> = {}) {
  return {
    requestId,
    localSessionId: "session-research",
    taskId: "c2c_plan",
    iteration: 0,
    phase: "RESEARCH",
    kind: "RESEARCH",
    payload: {
      question: "What does the current structured output contract require?",
      summary: "Current vendor guidance requires an explicit output schema.",
      conclusions: ["Every successful tool result should match its declared output schema."],
      sources: [
        {
          title: "Vendor documentation",
          url: "https://example.com/docs/structured-output",
          publishedDate: "2026-08-31",
          keyEvidence: "The response contract requires structuredContent to match outputSchema.",
        },
      ],
      openQuestions: [],
    },
    ...overrides,
  };
}

function planInput(requestId: string, overrides: Record<string, unknown> = {}) {
  return {
    requestId,
    localSessionId: "session-a",
    taskId: "c2c_plan",
    iteration: 0,
    phase: "PLAN",
    kind: "PLAN",
    payload: {
      goal: "Add a local result mailbox",
      rationale: "Local reads are faster and less brittle than browser parsing.",
      actions: [{ file: "src/control/mailbox.ts", change: "submit structured results", why: "avoid DOM scraping" }],
      tests: ["pnpm test"],
      successCriteria: ["Codex can read the PLAN locally"],
    },
    ...overrides,
  };
}

beforeEach(() => {
  stateDir = isolateStateDir();
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup(stateDir);
  delete process.env.C2C_STATE_DIR;
});

describe("control result mailbox", () => {
  it("opens a request and accepts one structured result", () => {
    const request = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      taskId: "c2c_plan",
      iteration: 0,
      phase: "PLAN",
    });

    expect(request.requestId).toMatch(/^[a-f0-9]{48}$/);
    expect(request.allowedKinds).toEqual(["PLAN", "BLOCKED"]);

    const receipt = submitControlResult(WORKSPACE_A, planInput(request.requestId));
    expect(receipt.accepted).toBe(true);
    expect(receipt.idempotentReplay).toBe(false);

    const reopenedBeforeAck = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      taskId: "c2c_plan",
      iteration: 0,
      phase: "PLAN",
    });
    expect(reopenedBeforeAck.requestId).toBe(request.requestId);

    const status = getControlResultStatus(WORKSPACE_A, request.requestId, "session-a", correlation());
    expect(status.status).toBe("received");
    expect(status.result?.kind).toBe("PLAN");
    expect(status.result?.phase).toBe("PLAN");
    expect(status.result?.localSessionId).toBe("session-a");
  });

  it("makes identical retries idempotent and rejects conflicting retries", () => {
    const request = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      taskId: "c2c_plan",
      iteration: 0,
      phase: "PLAN",
    });
    const first = submitControlResult(WORKSPACE_A, planInput(request.requestId));
    const replay = submitControlResult(WORKSPACE_A, planInput(request.requestId));
    expect(replay.resultId).toBe(first.resultId);
    expect(replay.idempotentReplay).toBe(true);

    expect(() =>
      submitControlResult(
        WORKSPACE_A,
        planInput(request.requestId, {
          payload: {
            goal: "Different",
            rationale: "Different retry should not overwrite.",
            actions: [{ change: "do something else", why: "conflicting retry" }],
            tests: [],
            successCriteria: ["conflict rejected"],
          },
        })
      )
    ).toThrow(/different result was already submitted/);
  });

  it("rejects stale, cancelled, mismatched and cross-workspace submissions", () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const expired = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      taskId: "c2c_plan",
      iteration: 0,
      phase: "PLAN",
      ttlMs: 1_000,
    });
    clock.mockReturnValue(now + 1_001);
    expect(() => submitControlResult(WORKSPACE_A, planInput(expired.requestId))).toThrow(/expired/);
    clock.mockRestore();

    const cancelled = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-b",
      taskId: "c2c_plan",
      iteration: 1,
      phase: "PLAN",
    });
    cancelControlResultRequest(WORKSPACE_A, cancelled.requestId, "session-b", correlation(1));
    expect(getControlResultStatus(WORKSPACE_A, cancelled.requestId, "session-b", correlation(1)).status).toBe(
      "cancelled"
    );
    expect(() =>
      submitControlResult(
        WORKSPACE_A,
        planInput(cancelled.requestId, { localSessionId: "session-b", iteration: 1 })
      )
    ).toThrow(/cancelled/);

    const request = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-c",
      taskId: "c2c_plan",
      iteration: 2,
      phase: "PLAN",
    });
    expect(() =>
      submitControlResult(WORKSPACE_A, planInput(request.requestId, { taskId: "c2c_other", iteration: 2 }))
    ).toThrow(/does not match/);
    expect(() => submitControlResult(WORKSPACE_B, planInput(request.requestId, { iteration: 2 }))).toThrow(/not found/);
  });

  it("enforces phase correlation and payload safety", () => {
    const plan = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      taskId: "c2c_plan",
      iteration: 0,
      phase: "PLAN",
    });
    expect(() =>
      submitControlResult(WORKSPACE_A, {
        requestId: plan.requestId,
        localSessionId: "session-a",
        taskId: "c2c_plan",
        iteration: 0,
        phase: "PLAN",
        kind: "DONE",
        payload: { summary: "done", verification: ["ok"] },
      })
    ).toThrow(/invalid|expected/i);
    expect(() =>
      submitControlResult(WORKSPACE_A, {
        requestId: plan.requestId,
        localSessionId: "session-a",
        taskId: "c2c_plan",
        iteration: 0,
        phase: "REVIEW",
        kind: "BLOCKED",
        payload: { reason: "wrong turn", needs: ["use the matching phase"] },
      })
    ).toThrow(/pending question/);
    expect(() =>
      submitControlResult(
        WORKSPACE_A,
        planInput(plan.requestId, {
          payload: {
            ...planInput(plan.requestId).payload,
            research: { summary: "obsolete inline research", sources: [] },
          },
        })
      )
    ).toThrow(/unrecognized key/i);

    const unsafe = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-unsafe",
      taskId: "c2c_plan",
      iteration: 1,
      phase: "PLAN",
    });
    expect(() =>
      submitControlResult(
        WORKSPACE_A,
        planInput(unsafe.requestId, {
          localSessionId: "session-unsafe",
          iteration: 1,
          payload: {
            goal: "unsafe",
            rationale: "private key blocks should not be stored",
            actions: [
              {
                file: "/tmp/evil",
                change: "-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----",
                why: "unsafe",
              },
            ],
            tests: [],
            successCriteria: ["rejected"],
          },
        })
      )
    ).toThrow(/file hints|private key/);
    expect(() =>
      submitControlResult(
        WORKSPACE_A,
        planInput(unsafe.requestId, {
          localSessionId: "session-unsafe",
          iteration: 1,
          payload: {
            goal: "unsafe path",
            rationale: "path control characters should not be stored",
            actions: [{ file: "src/line\nbreak.ts", change: "reject it", why: "unsafe file hint" }],
            tests: [],
            successCriteria: ["rejected"],
          },
        })
      )
    ).toThrow(/file hints/);

    const credential = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-credential",
      taskId: "c2c_plan",
      iteration: 2,
      phase: "PLAN",
    });
    expect(() =>
      submitControlResult(
        WORKSPACE_A,
        planInput(credential.requestId, {
          localSessionId: "session-credential",
          iteration: 2,
          payload: {
            goal: "reject credentials",
            rationale: "access_token=c2c_at_abcdefghijklmnopqrstuvwxyz",
            actions: [{ change: "reject the payload", why: "credentials do not belong in advisory results" }],
            tests: [],
            successCriteria: ["credential is rejected"],
          },
        })
      )
    ).toThrow(/suspected credentials/);

    const oversized = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-oversized",
      taskId: "c2c_plan",
      iteration: 3,
      phase: "PLAN",
    });
    expect(() =>
      submitControlResult(
        WORKSPACE_A,
        planInput(oversized.requestId, {
          localSessionId: "session-oversized",
          iteration: 3,
          payload: {
            goal: "reject oversized results",
            rationale: "x".repeat(4_000),
            actions: Array.from({ length: 20 }, (_, index) => ({
              file: `src/file-${index}.ts`,
              change: "x".repeat(1_000),
              why: "y".repeat(1_000),
            })),
            tests: [],
            successCriteria: ["rejected"],
          },
        })
      )
    ).toThrow(/exceeds 32768 bytes/);
  });

  it("stores a standalone RESEARCH result with dated sources", () => {
    const request = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-research",
      ...correlation(0, "RESEARCH"),
    });
    expect(request.allowedKinds).toEqual(["RESEARCH", "BLOCKED"]);
    submitControlResult(WORKSPACE_A, researchInput(request.requestId));
    const status = getControlResultStatus(
      WORKSPACE_A,
      request.requestId,
      "session-research",
      correlation(0, "RESEARCH")
    );
    expect(status.result?.payload).toMatchObject({
      sources: [
        {
          url: "https://example.com/docs/structured-output",
          publishedDate: "2026-08-31",
        },
      ],
    });

    const unsafe = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-research-unsafe",
      ...correlation(1, "RESEARCH"),
    });
    expect(() =>
      submitControlResult(
        WORKSPACE_A,
        researchInput(unsafe.requestId, {
          localSessionId: "session-research-unsafe",
          iteration: 1,
          payload: {
            question: "Can a secret-bearing URL be stored?",
            summary: "Unsafe source",
            conclusions: ["It must be rejected."],
            sources: [
              {
                title: "Private link",
                url: "https://example.com/docs?access_token=c2c_at_abcdefghijklmnopqrstuvwxyz",
                publishedDate: null,
                keyEvidence: "The URL contains a credential.",
              },
            ],
            openQuestions: [],
          },
        })
      )
    ).toThrow(/unsafe/);

    const invalidDate = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-research-date",
      ...correlation(2, "RESEARCH"),
    });
    expect(() =>
      submitControlResult(
        WORKSPACE_A,
        researchInput(invalidDate.requestId, {
          localSessionId: "session-research-date",
          iteration: 2,
          payload: {
            ...researchInput(invalidDate.requestId).payload,
            sources: [
              {
                title: "Invalid date",
                url: "https://example.com/current",
                publishedDate: "2026-02-30",
                keyEvidence: "Impossible calendar date.",
              },
            ],
          },
        })
      )
    ).toThrow(/real calendar date/);
  });

  it("reports bounded monotonic progress for the exact pending question", () => {
    const expected = correlation(0, "RESEARCH");
    const request = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-research",
      ...expected,
    });
    const searching = {
      requestId: request.requestId,
      localSessionId: request.localSessionId,
      taskId: request.taskId,
      iteration: request.iteration,
      phase: request.phase,
      status: "SEARCHING",
      message: "Checking current vendor documentation.",
    } as const;

    const first = reportControlProgress(WORKSPACE_A, searching);
    expect(first.idempotentReplay).toBe(false);
    expect(first.status).toBe("SEARCHING");
    expect(reportControlProgress(WORKSPACE_A, searching)).toMatchObject({
      progressId: first.progressId,
      idempotentReplay: true,
    });
    expect(() =>
      reportControlProgress(WORKSPACE_A, { ...searching, message: "A different value for the same state." })
    ).toThrow(/cannot move/);
    expect(
      getControlResultStatus(WORKSPACE_A, request.requestId, "session-research", expected).progress
    ).toMatchObject({
      status: "SEARCHING",
      message: "Checking current vendor documentation.",
    });

    reportControlProgress(WORKSPACE_A, { ...searching, status: "READING_CODE", message: "Comparing the code." });
    expect(() =>
      reportControlProgress(WORKSPACE_A, { ...searching, status: "SEARCHING", message: "Search again." })
    ).toThrow(/cannot move/);
    reportControlProgress(WORKSPACE_A, { ...searching, status: "SYNTHESIZING", message: "Preparing citations." });

    submitControlResult(WORKSPACE_A, researchInput(request.requestId));
    const received = getControlResultStatus(
      WORKSPACE_A,
      request.requestId,
      "session-research",
      expected
    );
    expect(received.status).toBe("received");
    expect(received.progress?.status).toBe("SYNTHESIZING");
    expect(() => reportControlProgress(WORKSPACE_A, searching)).toThrow(/only while the request is pending/);
  });

  it("rejects mismatched, unsafe, and modified progress records", () => {
    const expected = correlation();
    const request = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-progress",
      ...expected,
    });
    const progress = {
      requestId: request.requestId,
      localSessionId: request.localSessionId,
      taskId: request.taskId,
      iteration: request.iteration,
      phase: request.phase,
      status: "READING_CODE",
      message: "Reading the relevant symbols.",
    } as const;

    expect(() => reportControlProgress(WORKSPACE_A, { ...progress, localSessionId: "other-session" })).toThrow(
      /pending question/
    );
    expect(() =>
      reportControlProgress(WORKSPACE_A, {
        ...progress,
        message: "access_token=c2c_at_abcdefghijklmnopqrstuvwxyz",
      })
    ).toThrow(/suspected credentials/);
    reportControlProgress(WORKSPACE_A, progress);

    const progressPath = path.join(
      stateDir,
      "control-mailbox",
      WORKSPACE_A,
      "progress",
      `${request.requestId}.json`
    );
    const stored = JSON.parse(fs.readFileSync(progressPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(progressPath, JSON.stringify({ ...stored, message: "tampered" }));
    expect(() =>
      getControlResultStatus(WORKSPACE_A, request.requestId, "session-progress", expected)
    ).toThrow(/integrity hash/);
  });

  it("acknowledges without deleting the result and enforces active request quota", () => {
    const request = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      taskId: "c2c_plan",
      iteration: 0,
      phase: "PLAN",
    });
    submitControlResult(WORKSPACE_A, planInput(request.requestId));
    const acked = acknowledgeControlResult(WORKSPACE_A, request.requestId, "session-a", correlation());
    expect(acked.status).toBe("acknowledged");
    expect(acked.result?.kind).toBe("PLAN");

    for (let i = 0; i < 8; i++) {
      openControlResultRequest(WORKSPACE_A, {
        localSessionId: `quota-${i}`,
        taskId: `c2c_q${i}`,
        iteration: 0,
        phase: "PLAN",
      });
    }
    expect(() =>
      openControlResultRequest(WORKSPACE_A, {
        localSessionId: "quota-over",
        taskId: "c2c_over",
        iteration: 0,
        phase: "PLAN",
      })
    ).toThrow(/too many active/);
  });

  it("retries a terminal marker if a concurrent entry disappears after EEXIST", () => {
    const request = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      ...correlation(),
    });
    submitControlResult(WORKSPACE_A, planInput(request.requestId));
    const originalLink = fs.linkSync.bind(fs);
    let injectedRace = false;
    vi.spyOn(fs, "linkSync").mockImplementation((existingPath, newPath) => {
      if (!injectedRace && newPath.toString().includes(`${path.sep}acks${path.sep}`)) {
        injectedRace = true;
        throw Object.assign(new Error("entry disappeared"), { code: "EEXIST" });
      }
      return originalLink(existingPath, newPath);
    });

    const status = acknowledgeControlResult(WORKSPACE_A, request.requestId, "session-a", correlation());

    expect(injectedRace).toBe(true);
    expect(status.status).toBe("acknowledged");
  });

  it("waits locally for a submitted result", async () => {
    const request = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      taskId: "c2c_plan",
      iteration: 0,
      phase: "PLAN",
    });
    setTimeout(() => submitControlResult(WORKSPACE_A, planInput(request.requestId)), 10);
    const status = await waitForControlResult(WORKSPACE_A, request.requestId, 1000, "session-a", correlation());
    expect(status.status).toBe("received");
    expect(status.result?.kind).toBe("PLAN");
  });

  it("keeps request lifecycle actions scoped to the owning local session", () => {
    const request = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      taskId: "c2c_plan",
      iteration: 0,
      phase: "PLAN",
    });

    expect(() => getControlResultStatus(WORKSPACE_A, request.requestId, "session-b", correlation())).toThrow(
      /another local session/
    );
    expect(() => getControlResultStatus(WORKSPACE_A, request.requestId, "session-a", correlation(1))).toThrow(
      /expected task, iteration, and phase/
    );
    expect(() => acknowledgeControlResult(WORKSPACE_A, request.requestId, "session-a", correlation())).toThrow(
      /before receipt/
    );
    expect(() => getControlResultStatus(WORKSPACE_A, "../../outside", "session-a", correlation())).toThrow(
      /safe identifier/
    );

    const cancelled = cancelControlResultRequest(WORKSPACE_A, request.requestId, "session-a", correlation());
    expect(cancelled.status).toBe("cancelled");
    expect(cancelControlResultRequest(WORKSPACE_A, request.requestId, "session-a", correlation()).status).toBe(
      "cancelled"
    );
  });

  it("prunes old terminal requests", () => {
    const request = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      taskId: "c2c_plan",
      iteration: 0,
      phase: "PLAN",
    });
    reportControlProgress(WORKSPACE_A, {
      requestId: request.requestId,
      localSessionId: request.localSessionId,
      taskId: request.taskId,
      iteration: request.iteration,
      phase: request.phase,
      status: "READING_CODE",
    });
    submitControlResult(WORKSPACE_A, planInput(request.requestId));
    acknowledgeControlResult(WORKSPACE_A, request.requestId, "session-a", correlation());

    const eightDaysLater = Date.now() + 8 * 24 * 60 * 60 * 1000;
    expect(pruneControlMailbox(WORKSPACE_A, eightDaysLater)).toBe(1);
    expect(getControlResultStatus(WORKSPACE_A, request.requestId, "session-a", correlation()).status).toBe(
      "not_found"
    );
    expect(
      fs.existsSync(
        path.join(stateDir, "control-mailbox", WORKSPACE_A, "progress", `${request.requestId}.json`)
      )
    ).toBe(false);
  });

  it("allows only one unanswered question per local session", () => {
    const first = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      ...correlation(0),
    });
    const requestFile = path.join(
      stateDir,
      "control-mailbox",
      WORKSPACE_A,
      "requests",
      `${first.requestId}.json`
    );
    fs.rmSync(requestFile);
    expect(openControlResultRequest(WORKSPACE_A, { localSessionId: "session-a", ...correlation(0) })).toEqual(first);
    expect(fs.existsSync(requestFile)).toBe(true);
    expect(() =>
      openControlResultRequest(WORKSPACE_A, {
        localSessionId: "session-a",
        ...correlation(1),
      })
    ).toThrow(/unfinished request .*PLAN/);

    const parallel = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-b",
      ...correlation(1),
    });
    expect(parallel.requestId).not.toBe(first.requestId);

    cancelControlResultRequest(WORKSPACE_A, first.requestId, "session-a", correlation(0));
    const next = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      ...correlation(1),
    });
    expect(next.requestId).not.toBe(first.requestId);
  });

  it("never treats an earlier answer as the next question's result", () => {
    const expected = correlation();
    const first = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      ...expected,
    });
    submitControlResult(WORKSPACE_A, planInput(first.requestId));
    acknowledgeControlResult(WORKSPACE_A, first.requestId, "session-a", expected);

    const second = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      ...expected,
    });
    expect(second.requestId).not.toBe(first.requestId);
    const beforeSecondAnswer = getControlResultStatus(
      WORKSPACE_A,
      second.requestId,
      "session-a",
      expected
    );
    expect(beforeSecondAnswer.status).toBe("pending");
    expect(beforeSecondAnswer.result).toBeNull();

    expect(() =>
      submitControlResult(
        WORKSPACE_A,
        planInput(first.requestId, {
          payload: {
            goal: "Answer intended for the second question",
            rationale: "An old request id must never redirect a new answer.",
            actions: [{ change: "reject this submission", why: "the first request is already complete" }],
            tests: [],
            successCriteria: ["the second request stays pending"],
          },
        })
      )
    ).toThrow(/different result was already submitted/);
    expect(
      getControlResultStatus(WORKSPACE_A, second.requestId, "session-a", expected)
    ).toMatchObject({ status: "pending", result: null });
  });

  it("rejects swapped or modified local result files", () => {
    const first = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      ...correlation(0),
    });
    submitControlResult(WORKSPACE_A, planInput(first.requestId));
    acknowledgeControlResult(WORKSPACE_A, first.requestId, "session-a", correlation(0));

    const second = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      ...correlation(1),
    });
    submitControlResult(WORKSPACE_A, planInput(second.requestId, { iteration: 1 }));

    const resultDir = path.join(stateDir, "control-mailbox", WORKSPACE_A, "results");
    const firstFile = path.join(resultDir, `${first.requestId}.json`);
    const secondFile = path.join(resultDir, `${second.requestId}.json`);
    const originalSecond = fs.readFileSync(secondFile, "utf8");

    fs.copyFileSync(firstFile, secondFile);
    expect(() => getControlResultStatus(WORKSPACE_A, second.requestId, "session-a", correlation(1))).toThrow(
      /does not match the exact control request/
    );

    const modified = JSON.parse(originalSecond) as { payload: { goal: string } };
    modified.payload.goal = "answer from a different question";
    fs.writeFileSync(secondFile, JSON.stringify(modified));
    expect(() => getControlResultStatus(WORKSPACE_A, second.requestId, "session-a", correlation(1))).toThrow(
      /integrity hash/
    );
  });

  it("rejects terminal markers copied from another question", () => {
    const first = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      ...correlation(0),
    });
    submitControlResult(WORKSPACE_A, planInput(first.requestId));
    acknowledgeControlResult(WORKSPACE_A, first.requestId, "session-a", correlation(0));

    const second = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      ...correlation(1),
    });
    submitControlResult(WORKSPACE_A, planInput(second.requestId, { iteration: 1 }));

    const ackDir = path.join(stateDir, "control-mailbox", WORKSPACE_A, "acks");
    fs.copyFileSync(
      path.join(ackDir, `${first.requestId}.json`),
      path.join(ackDir, `${second.requestId}.json`)
    );
    expect(() => getControlResultStatus(WORKSPACE_A, second.requestId, "session-a", correlation(1))).toThrow(
      /marker does not match the exact control request/
    );
  });

  it("rejects unknown fields, non-canonical timestamps, and conflicting terminal markers", () => {
    const request = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      ...correlation(),
    });
    const requestPath = path.join(
      stateDir,
      "control-mailbox",
      WORKSPACE_A,
      "requests",
      `${request.requestId}.json`
    );
    const originalRequest = JSON.parse(fs.readFileSync(requestPath, "utf8")) as Record<string, unknown>;

    fs.writeFileSync(requestPath, JSON.stringify({ ...originalRequest, injected: true }));
    expect(() => getControlResultStatus(WORKSPACE_A, request.requestId, "session-a", correlation())).toThrow(
      /request schema/
    );

    fs.writeFileSync(
      requestPath,
      JSON.stringify({ ...originalRequest, createdAt: new Date(originalRequest.createdAt as string).toUTCString() })
    );
    expect(() => getControlResultStatus(WORKSPACE_A, request.requestId, "session-a", correlation())).toThrow(
      /timestamps/
    );

    fs.writeFileSync(requestPath, JSON.stringify(originalRequest));
    submitControlResult(WORKSPACE_A, planInput(request.requestId));
    acknowledgeControlResult(WORKSPACE_A, request.requestId, "session-a", correlation());
    writeSecureJsonExclusive(
      path.join(stateDir, "control-mailbox", WORKSPACE_A, "cancelled", `${request.requestId}.json`),
      {
        schemaVersion: 1,
        requestId: request.requestId,
        workspaceId: WORKSPACE_A,
        localSessionId: request.localSessionId,
        taskId: request.taskId,
        iteration: request.iteration,
        phase: request.phase,
        cancelledAt: new Date().toISOString(),
      }
    );
    expect(() => getControlResultStatus(WORKSPACE_A, request.requestId, "session-a", correlation())).toThrow(
      /conflicting terminal markers/
    );
  });

  it("strictly validates stored result and terminal marker schemas", () => {
    const resultRequest = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-result",
      ...correlation(),
    });
    submitControlResult(
      WORKSPACE_A,
      planInput(resultRequest.requestId, { localSessionId: "session-result" })
    );
    const resultPath = path.join(
      stateDir,
      "control-mailbox",
      WORKSPACE_A,
      "results",
      `${resultRequest.requestId}.json`
    );
    const storedResult = JSON.parse(fs.readFileSync(resultPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(resultPath, JSON.stringify({ ...storedResult, injected: true }));
    expect(() =>
      getControlResultStatus(WORKSPACE_A, resultRequest.requestId, "session-result", correlation())
    ).toThrow(/result schema/);

    const markerRequest = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-marker",
      ...correlation(1),
    });
    cancelControlResultRequest(
      WORKSPACE_A,
      markerRequest.requestId,
      "session-marker",
      correlation(1)
    );
    const markerPath = path.join(
      stateDir,
      "control-mailbox",
      WORKSPACE_A,
      "cancelled",
      `${markerRequest.requestId}.json`
    );
    const storedMarker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        ...storedMarker,
        cancelledAt: new Date(storedMarker.cancelledAt as string).toUTCString(),
      })
    );
    expect(() =>
      getControlResultStatus(WORKSPACE_A, markerRequest.requestId, "session-marker", correlation(1))
    ).toThrow(/marker does not match/);
  });

  it("serializes submission and cancellation across processes", async () => {
    const request = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      ...correlation(),
    });
    const moduleUrl = pathToFileURL(path.resolve("src/control/mailbox.ts")).href;
    const sharedPrelude = `
      import { submitControlResult, cancelControlResultRequest } from ${JSON.stringify(moduleUrl)};
      const print = (value) => process.stdout.write(JSON.stringify(value));
    `;
    const submitScript = `${sharedPrelude}
      try {
        const value = submitControlResult(${JSON.stringify(WORKSPACE_A)}, ${JSON.stringify(planInput(request.requestId))});
        print({ ok: true, resultId: value.resultId });
      } catch (error) {
        print({ ok: false, code: error.code });
      }
    `;
    const cancelScript = `${sharedPrelude}
      try {
        const value = cancelControlResultRequest(
          ${JSON.stringify(WORKSPACE_A)},
          ${JSON.stringify(request.requestId)},
          "session-a",
          ${JSON.stringify(correlation())}
        );
        print({ ok: true, status: value.status });
      } catch (error) {
        print({ ok: false, code: error.code });
      }
    `;
    const run = (script: string) =>
      execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: path.resolve("."),
        env: { ...process.env, C2C_STATE_DIR: stateDir },
      });

    const [submitted, cancelled] = await Promise.all([run(submitScript), run(cancelScript)]);
    const submitOutcome = JSON.parse(submitted.stdout) as { ok: boolean; code?: string };
    const cancelOutcome = JSON.parse(cancelled.stdout) as { ok: boolean; code?: string };
    expect([submitOutcome.ok, cancelOutcome.ok].filter(Boolean)).toHaveLength(1);

    const status = getControlResultStatus(WORKSPACE_A, request.requestId, "session-a", correlation());
    expect(["received", "cancelled"]).toContain(status.status);
    if (status.status === "received") {
      expect(submitOutcome.ok).toBe(true);
      expect(cancelOutcome).toEqual({ ok: false, code: "MAILBOX_REQUEST_NOT_PENDING" });
    } else {
      expect(cancelOutcome.ok).toBe(true);
      expect(submitOutcome).toEqual({ ok: false, code: "MAILBOX_REQUEST_CANCELLED" });
    }
  });

  it("finishes acknowledgement before another process opens the next question", async () => {
    const request = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      ...correlation(0),
    });
    submitControlResult(WORKSPACE_A, planInput(request.requestId));
    const moduleUrl = pathToFileURL(path.resolve("src/control/mailbox.ts")).href;
    const barrier = path.join(stateDir, "acknowledgement-paused");
    const acknowledgeScript = `
      import fs from "node:fs";
      import path from "node:path";
      const originalLinkSync = fs.linkSync.bind(fs);
      fs.linkSync = (source, target) => {
        if (target.toString().includes(path.sep + "acks" + path.sep)) {
          fs.writeFileSync(${JSON.stringify(barrier)}, "ready");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        }
        return originalLinkSync(source, target);
      };
      const { acknowledgeControlResult } = await import(${JSON.stringify(moduleUrl)});
      try {
        const value = acknowledgeControlResult(
          ${JSON.stringify(WORKSPACE_A)},
          ${JSON.stringify(request.requestId)},
          "session-a",
          ${JSON.stringify(correlation(0))}
        );
        process.stdout.write(JSON.stringify({ ok: true, status: value.status }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
      }
    `;
    const openScript = `
      import fs from "node:fs";
      while (!fs.existsSync(${JSON.stringify(barrier)})) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const { openControlResultRequest } = await import(${JSON.stringify(moduleUrl)});
      try {
        const value = openControlResultRequest(${JSON.stringify(WORKSPACE_A)}, {
          localSessionId: "session-a",
          taskId: "c2c_plan",
          iteration: 1,
          phase: "PLAN"
        });
        process.stdout.write(JSON.stringify({ ok: true, requestId: value.requestId }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
      }
    `;
    const run = (script: string) =>
      execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: path.resolve("."),
        env: { ...process.env, C2C_STATE_DIR: stateDir },
      });

    const [acknowledged, opened] = await Promise.all([run(acknowledgeScript), run(openScript)]);
    const acknowledgeOutcome = JSON.parse(acknowledged.stdout) as { ok: boolean; status?: string };
    const openOutcome = JSON.parse(opened.stdout) as { ok: boolean; requestId?: string; message?: string };
    expect(acknowledgeOutcome).toEqual({ ok: true, status: "acknowledged" });
    expect(openOutcome.ok, openOutcome.message).toBe(true);
    expect(openOutcome.requestId).not.toBe(request.requestId);
  }, 60_000);

  it("serializes progress with submission and cancellation across processes", async () => {
    const moduleUrl = pathToFileURL(path.resolve("src/control/mailbox.ts")).href;
    const run = (script: string) =>
      execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: path.resolve("."),
        env: { ...process.env, C2C_STATE_DIR: stateDir },
      });
    const progressScript = (requestId: string, localSessionId: string, iteration: number) => `
      const { reportControlProgress } = await import(${JSON.stringify(moduleUrl)});
      try {
        reportControlProgress(${JSON.stringify(WORKSPACE_A)}, {
          requestId: ${JSON.stringify(requestId)},
          localSessionId: ${JSON.stringify(localSessionId)},
          taskId: "c2c_plan",
          iteration: ${iteration},
          phase: "PLAN",
          status: "SEARCHING"
        });
        process.stdout.write(JSON.stringify({ ok: true }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error.code }));
      }
    `;

    const submittedRequest = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-a",
      ...correlation(0),
    });
    const submitScript = `
      const { submitControlResult } = await import(${JSON.stringify(moduleUrl)});
      try {
        submitControlResult(${JSON.stringify(WORKSPACE_A)}, ${JSON.stringify(planInput(submittedRequest.requestId))});
        process.stdout.write(JSON.stringify({ ok: true }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error.code }));
      }
    `;
    const [progressedWithSubmit, submitted] = await Promise.all([
      run(progressScript(submittedRequest.requestId, "session-a", 0)),
      run(submitScript),
    ]);
    expect(JSON.parse(submitted.stdout)).toEqual({ ok: true });
    expect([true, "MAILBOX_PROGRESS_NOT_ALLOWED"]).toContain(
      (JSON.parse(progressedWithSubmit.stdout) as { ok: boolean; code?: string }).ok ||
        (JSON.parse(progressedWithSubmit.stdout) as { code?: string }).code
    );
    expect(
      getControlResultStatus(WORKSPACE_A, submittedRequest.requestId, "session-a", correlation(0)).status
    ).toBe("received");

    const cancelledRequest = openControlResultRequest(WORKSPACE_A, {
      localSessionId: "session-b",
      ...correlation(1),
    });
    const cancelScript = `
      const { cancelControlResultRequest } = await import(${JSON.stringify(moduleUrl)});
      try {
        cancelControlResultRequest(
          ${JSON.stringify(WORKSPACE_A)},
          ${JSON.stringify(cancelledRequest.requestId)},
          "session-b",
          ${JSON.stringify(correlation(1))}
        );
        process.stdout.write(JSON.stringify({ ok: true }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error.code }));
      }
    `;
    const [progressedWithCancel, cancelled] = await Promise.all([
      run(progressScript(cancelledRequest.requestId, "session-b", 1)),
      run(cancelScript),
    ]);
    expect(JSON.parse(cancelled.stdout)).toEqual({ ok: true });
    expect([true, "MAILBOX_PROGRESS_NOT_ALLOWED"]).toContain(
      (JSON.parse(progressedWithCancel.stdout) as { ok: boolean; code?: string }).ok ||
        (JSON.parse(progressedWithCancel.stdout) as { code?: string }).code
    );
    expect(
      getControlResultStatus(WORKSPACE_A, cancelledRequest.requestId, "session-b", correlation(1)).status
    ).toBe("cancelled");
  }, 60_000);

  it("publishes exclusive JSON without replacing the winning value", () => {
    const file = path.join(stateDir, "exclusive", "result.json");
    writeSecureJsonExclusive(file, { answer: "first" });

    expect(() => writeSecureJsonExclusive(file, { answer: "second" })).toThrow();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ answer: "first" });
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
