import { describe, expect, it } from "vitest";
import { parseC2CMessage } from "../src/protocol/parser.js";

describe("parseC2CMessage", () => {
  it("parses a PLAN surrounded by prose and code fences", () => {
    const result = parseC2CMessage(`Before
\`\`\`text
[C2C]
STATE: PLAN
TASK_ID: c2c_a1b2c3d4
ITERATION: 1

ACTIONS:
1. Change parser.

TESTS:
Run protocol tests.

SUCCESS_CRITERIA:
Round trip passes.
\`\`\`
After`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toMatchObject({
      protocolVersion: 1,
      state: "PLAN",
      taskId: "c2c_a1b2c3d4",
      iteration: 1,
    });
    expect(result.message.sections.ACTIONS).toContain("Change parser");
    expect(result.diagnostics.map((item) => item.code)).toContain("PROTOCOL_VERSION_INFERRED");
  });

  it("normalizes CRLF and header casing", () => {
    const result = parseC2CMessage(
      "[C2C]\r\nstate: plan\r\ntask_id: c2c_0123abcd\r\niteration: 2\r\nprotocol_version: 1\r\n\r\nactions:\r\nEdit.\r\n\r\ntests:\r\nRun.\r\n\r\nsuccess_criteria:\r\nPass."
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.sections).toMatchObject({ ACTIONS: "Edit.", TESTS: "Run.", SUCCESS_CRITERIA: "Pass." });
  });

  it("retains unknown sections with a warning", () => {
    const result = parseC2CMessage(`[C2C]
STATE: PLAN
TASK_ID: c2c_0123abcd
ITERATION: 1

ACTIONS: Edit.
TESTS: Run.
SUCCESS_CRITERIA: Pass.
NOTES: Preserve this note.`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.sections.NOTES).toBe("Preserve this note.");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "UNKNOWN_SECTION", severity: "warning" }));
  });

  it("accepts a complete block without the C2C marker and warns", () => {
    const result = parseC2CMessage(`STATE: DONE
TASK_ID: c2c_deadbeef
ITERATION: 3

SUMMARY:
All checks pass.`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.state).toBe("DONE");
    expect(result.diagnostics.map((item) => item.code)).toContain("C2C_MARKER_MISSING");
  });

  it("returns diagnostics instead of throwing for missing state", () => {
    const result = parseC2CMessage("ChatGPT says the work is done.");
    expect(result).toMatchObject({ ok: false });
    expect(result.diagnostics.map((item) => item.code)).toContain("STATE_MISSING");
  });

  it("rejects malformed headers with diagnostics", () => {
    const result = parseC2CMessage(`[C2C]
STATE: PLAN
TASK_ID: not-a-task
ITERATION: first`);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["TASK_ID_INVALID", "ITERATION_INVALID"])
    );
  });

  it("parses DONE and BLOCKED messages", () => {
    const done = parseC2CMessage(`[C2C]
STATE: DONE
TASK_ID: c2c_deadbeef
ITERATION: 4
SUMMARY: Accepted.`);
    const blocked = parseC2CMessage(`[C2C]
STATE: BLOCKED
TASK_ID: c2c_deadbeef
ITERATION: 4
REASON: Missing upstream access.
NEEDS: Repository permission.`);

    expect(done.ok && done.message.sections.SUMMARY).toBe("Accepted.");
    expect(blocked.ok && blocked.message.sections).toMatchObject({
      REASON: "Missing upstream access.",
      NEEDS: "Repository permission.",
    });
  });
});
