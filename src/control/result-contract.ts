import {
  allowedKindsForPhase,
  type ControlPhase,
  type ControlResultKind,
  type ControlResultRequest,
  type ControlResultSubmission,
} from "./result-schema.js";
import { ACTIVE_CONTROL_RESULT_TRANSPORT } from "./result-transport.js";

/** Prompt scaffolds, not results or proof that a page can call these tools. */
export function controlResultContract(phase: ControlPhase) {
  const examples = {
    BOOT: {},
    RESEARCH: {
      question: "<the requested question>",
      summary: "<concise answer based on observed evidence>",
      conclusions: ["<conclusion; cite the relative file and lines or external evidence>"],
      sources: [],
      openQuestions: [],
    },
    PLAN: {
      goal: "<requested outcome>",
      rationale: "<evidence-based reasoning>",
      actions: [{ change: "<proposed change>", why: "<reason>" }],
      tests: [],
      successCriteria: ["<observable acceptance criterion>"],
    },
    REVIEW: {
      summary: "<review conclusion>",
      findings: [{ severity: "medium", issue: "<actionable defect>", recommendation: "<correction>" }],
      actions: [{ change: "<proposed correction>", why: "<reason>" }],
      tests: [],
      successCriteria: ["<observable acceptance criterion>"],
    },
    DONE: {
      summary: "<verified outcome>",
      verification: ["<check actually performed and its result>"],
      remainingRisks: [],
    },
    BLOCKED: {
      reason: "<observed blocker, without guessing its cause>",
      needs: ["<specific missing input or required user action>"],
    },
  } satisfies Record<ControlResultKind, ControlResultSubmission["payload"]>;

  return {
    phase,
    resultTransport: ACTIVE_CONTROL_RESULT_TRANSPORT,
    requiredTools: phase === "BOOT"
      ? ["workspace_info", "read_file"]
      : [],
    instructions: [
      "Use the Codex with ChatGPT connector in this exact message only for the read-only tools needed by the task.",
      "THIS EXACT MESSAGE OVERRIDES any earlier C2C mailbox or callback delivery directions in this conversation. Result transport is COMPUTER_USE_ONLY for comparison.",
      "The absence of get_control_result_status, report_control_progress, and submit_control_result is expected and is not a blocker. Never ask Codex to restore them, never report their absence as BLOCKED, and never claim or wait for a mailbox receipt. Do not call C2C result status, progress, or submission tools; mailbox callbacks are intentionally disabled. The final marker in this page response is the delivery.",
      "Replace every payload placeholder with observed facts; examples are scaffolds, not evidence.",
      "FINAL DELIVERY IS REQUIRED FOR FAILURE TOO: if you refuse the business request, cannot complete it, lack information, or a business read fails, return kind BLOCKED with payload {reason, needs} in the required final marker. Do this in the same final page reply; do not wait for the user to interrupt, send another message, or ask you to report failure. Keep the reason short and safe, without prohibited content or guessed causes.",
      "Elapsed time alone is not failure. Codex can renew this request's live authorization while observing your ongoing work; do not ask the user to interrupt or send a continuation just because the task takes a long time. Respect any actual expired or revoked authorization. For BLOCKED, needs describes the next steps, which may simply be to end the failed attempt and preserve completed work; user confirmation is not required just to record failure.",
      "For RESEARCH, sources contains only external HTTP(S) URLs actually consulted, each with title, url, publishedDate (YYYY-MM-DD or null) and keyEvidence. Use sources: [] for local-only work and cite relative files/lines in conclusions. Never fabricate URLs or use workspace:/ or file:// as sources.",
      "If a read tool is unavailable or a platform approval/safety check blocks it, stop this turn and return a schema-valid BLOCKED result in the required final marker; do not bypass it, switch apps, or claim the read succeeded.",
      "The host accepts the result only after Computer Use verifies this exact response, tab, chat, generation, request ID, and schema. A visible answer from another response is not delivery.",
      ...(phase === "BOOT" ? [
        "For BOOT, call workspace_info and read one bounded hello-style top-level file. Return kind BOOT with payload {} after both reads succeed even though mailbox callback tools are absent. Only failure of a required read-only identity check may produce BLOCKED. Do not copy workspace identity into the payload; the gateway derives it from this capability.",
      ] : []),
    ],
    examples: allowedKindsForPhase(phase).map((kind) => ({ kind, payload: examples[kind] })),
  };
}

/** Exact per-request delivery instructions to append to the task, without host rewriting. */
export function controlDeliveryPrompt(request: ControlResultRequest, contextId: string): string {
  const contract = controlResultContract(request.phase);
  return [
    "[C2C]",
    `RESULT_REQUEST_ID: ${request.requestId}`,
    `CONTEXT_ID: ${contextId}`,
    `LOCAL_SESSION_ID: ${request.localSessionId}`,
    `TASK_ID: ${request.taskId}`,
    `ITERATION: ${request.iteration}`,
    `RESULT_PHASE: ${request.phase}`,
    "RESULT_TRANSPORT: COMPUTER_USE_ONLY",
    "MAILBOX_CALLBACKS: DISABLED_EXPECTED",
    "",
    "Use this context_id for every read-only C2C MCP call. Codex owns edits and execution.",
    ...contract.instructions,
    `End this exact response with the marker C2C_HOST_OBSERVED_RESULT, pair it to RESULT_REQUEST_ID ${request.requestId}, and place exactly one schema-valid allowed {kind,payload} JSON object after the marker. Computer Use reads this exact bound response as the only active result transport. Do not include raw logs, source, diffs, credentials or error excerpts in the marker payload.`,
    "Phase-specific payload scaffolds (replace placeholders with actual findings; never submit examples verbatim):",
    JSON.stringify(contract.examples),
  ].join("\n");
}
