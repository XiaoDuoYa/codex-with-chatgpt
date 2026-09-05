import {
  allowedKindsForPhase,
  type ControlPhase,
  type ControlResultKind,
  type SubmitControlResultInput,
} from "./result-schema.js";

/** Prompt scaffolds, not results or proof that a page can call these tools. */
export function controlResultContract(phase: ControlPhase) {
  const examples = {
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
  } satisfies Record<ControlResultKind, SubmitControlResultInput["payload"]>;

  return {
    phase,
    requiredTools: ["submit_control_result"],
    instructions: [
      "Use the Codex with ChatGPT connector in this exact message. Check that submit_control_result is callable now, not merely mentioned in history, before doing research or analysis.",
      "When get_control_result_status is callable, check this context_id, requestId, localSessionId, taskId, iteration and phase first and proceed only for the exact pending request. Its absence alone does not block submission; Codex owns mailbox status and acknowledgment.",
      "Submit with those same correlation fields, kind and its matching payload. Replace every example placeholder with observed facts; examples are not evidence.",
      "For RESEARCH, sources contains only external HTTP(S) URLs actually consulted, each with title, url, publishedDate (YYYY-MM-DD or null) and keyEvidence. Use sources: [] for local-only work and cite relative files/lines in conclusions. Never fabricate URLs or use workspace:/ or file:// as sources.",
      "If tools are unavailable or a platform approval/safety check blocks a call, stop this turn and report the observed failure; do not bypass it, switch apps or claim successful delivery. Submit BLOCKED only when that same tool is available and permitted.",
      "Only the local mailbox received/acknowledged state proves delivery. A visible answer or successful read is not a receipt.",
    ],
    examples: allowedKindsForPhase(phase).map((kind) => ({ kind, payload: examples[kind] })),
  };
}
