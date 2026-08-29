import { IgnoreRules } from "../workspace/ignore.js";

export type PublishChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted" | "ignored";

export interface PublishChange {
  path: string;
  status: PublishChangeStatus;
  originalPath?: string;
}

export type PublishSetValidation =
  | { ok: true; paths: string[] }
  | {
      ok: false;
      code: "PROTECTED_BRANCH" | "CONFLICTED_FILES" | "UNRELATED_DIRTY_FILES" | "SENSITIVE_FILE_BLOCKED";
      message: string;
      paths: string[];
    };

export function validatePublishSet(
  workspaceRoot: string,
  inputChanges: PublishChange[],
  options: { declaredPaths?: string[]; branch?: string } = {}
): PublishSetValidation {
  if (options.branch === "main" || options.branch === "master") {
    return blocked("PROTECTED_BRANCH", `Publication is not allowed on ${options.branch}.`, []);
  }

  const changes = inputChanges
    .filter((change) => change.status !== "ignored")
    .map((change) => ({ ...change, path: normalizePath(change.path), originalPath: normalizeOptional(change.originalPath) }));
  const conflicts = changes.filter((change) => change.status === "conflicted").map((change) => change.path);
  if (conflicts.length > 0) {
    return blocked("CONFLICTED_FILES", "Resolve conflicted files before publication.", conflicts);
  }

  const declared = new Set((options.declaredPaths ?? changes.map((change) => change.path)).map(normalizePath));
  const unrelated = changes.filter((change) => !declared.has(change.path)).map((change) => change.path);
  if (unrelated.length > 0) {
    return blocked("UNRELATED_DIRTY_FILES", "The working tree contains changes outside the declared publish set.", unrelated);
  }

  const ignore = new IgnoreRules(workspaceRoot);
  const sensitive: string[] = [];
  for (const change of changes) {
    if (change.status === "deleted") continue;
    if (ignore.isSensitive(change.path)) sensitive.push(change.path);
    if (change.status === "renamed" && change.originalPath && ignore.isSensitive(change.originalPath)) {
      sensitive.push(change.originalPath);
    }
  }
  if (sensitive.length > 0) {
    return blocked("SENSITIVE_FILE_BLOCKED", "Sensitive paths cannot be included in an automatic GitHub publication.", [...new Set(sensitive)]);
  }

  return { ok: true, paths: [...new Set(changes.map((change) => change.path))] };
}

function blocked(
  code: Extract<PublishSetValidation, { ok: false }>["code"],
  message: string,
  paths: string[]
): Extract<PublishSetValidation, { ok: false }> {
  return { ok: false, code, message, paths };
}

function normalizePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeOptional(input: string | undefined): string | undefined {
  return input === undefined ? undefined : normalizePath(input);
}
