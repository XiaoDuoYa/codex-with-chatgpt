import type { Quota } from "./quota.js";

export interface Route {
  mode: "codex" | "chatgpt";
  reason: "quota_healthy" | "quota_below_threshold" | "quota_limit_reached" | "ordinary_usage_not_allowed" | "quota_unavailable";
  remainingPercent: number | null;
  thresholdPercent: number;
  error?: string;
}

export function chooseRoute(quota: Quota, thresholdPercent: number): Route {
  let reason: Route["reason"] = "quota_healthy";
  if (!quota.available) reason = "quota_unavailable";
  else if (quota.ordinaryUsageAllowed === false) reason = "ordinary_usage_not_allowed";
  else if (quota.rateLimitReachedType !== null) reason = "quota_limit_reached";
  else if (quota.effectiveRemainingPercent !== null && quota.effectiveRemainingPercent <= thresholdPercent) {
    reason = "quota_below_threshold";
  }
  return {
    mode: reason === "quota_healthy" || reason === "quota_unavailable" ? "codex" : "chatgpt",
    reason,
    remainingPercent: quota.effectiveRemainingPercent,
    thresholdPercent,
    ...(quota.error ? { error: quota.error } : {}),
  };
}

export function routeHookOutput(route: Route): object {
  const workflow = route.mode === "chatgpt"
    ? "For coding work in this turn, use the codex-with-chatgpt skill for planning and review; Codex owns execution. Follow the skill's connection setup and task checkpoints."
    : "For coding work in this turn, use native Codex planning, execution, and review.";
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: [
        `C2C quota routing for this turn: ${route.mode} (${route.reason}; remaining ${route.remainingPercent ?? "unknown"}%; threshold ${route.thresholdPercent}%).`,
        workflow,
        "The user's explicit workflow preference takes precedence. This automatic choice applies only to this turn and supersedes earlier automatic quota choices. For an in-progress C2C task, retain completed work and its checkpoint when continuing. Handle non-coding requests normally.",
      ].join("\n"),
    },
  };
}
