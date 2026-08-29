import { C2CMessageSchema, C2CStateSchema, TaskIdSchema, type C2CMessage } from "./types.js";

export type ProtocolDiagnostic = {
  code: string;
  severity: "warning" | "error";
  message: string;
};

export type ParseResult =
  | { ok: true; message: C2CMessage; diagnostics: ProtocolDiagnostic[] }
  | { ok: false; diagnostics: ProtocolDiagnostic[] };

const HEADER_NAMES = new Set(["STATE", "TASK_ID", "ITERATION", "PROTOCOL_VERSION"]);
const KNOWN_SECTIONS = new Set([
  "GOAL",
  "RATIONALE",
  "ACTIONS",
  "TESTS",
  "SUCCESS_CRITERIA",
  "SUMMARY",
  "REASON",
  "NEEDS",
]);

export function parseC2CMessage(text: string): ParseResult {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const stateLine = lines.findIndex((line) => /^\s*state\s*:/i.test(line));
  const diagnostics: ProtocolDiagnostic[] = [];

  if (stateLine === -1) {
    return {
      ok: false,
      diagnostics: [error("STATE_MISSING", "No STATE header was found in the imported message.")],
    };
  }

  if (!lines.slice(0, stateLine + 1).some((line) => /^\s*\[c2c\]\s*$/i.test(line))) {
    diagnostics.push(warning("C2C_MARKER_MISSING", "The [C2C] marker is missing; parsed the recognizable header block."));
  }

  const headers = new Map<string, string>();
  const sectionLines = new Map<string, string[]>();
  let activeSection: string | null = null;

  for (let index = stateLine; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) break;

    const field = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (field) {
      const name = field[1].toUpperCase();
      const value = field[2].trim();
      if (HEADER_NAMES.has(name) && activeSection === null) {
        headers.set(name, value);
        continue;
      }
      activeSection = name;
      sectionLines.set(name, value ? [value] : []);
      if (!KNOWN_SECTIONS.has(name)) {
        diagnostics.push(warning("UNKNOWN_SECTION", `Unknown section ${name} was retained.`));
      }
      continue;
    }

    if (activeSection !== null) sectionLines.get(activeSection)?.push(line);
  }

  const stateValue = headers.get("STATE")?.toUpperCase();
  const stateResult = C2CStateSchema.safeParse(stateValue);
  if (!stateResult.success) diagnostics.push(error("STATE_INVALID", `Unsupported STATE value: ${stateValue ?? ""}`));

  const taskId = headers.get("TASK_ID");
  if (!taskId) diagnostics.push(error("TASK_ID_MISSING", "TASK_ID is required."));
  else if (!TaskIdSchema.safeParse(taskId).success) diagnostics.push(error("TASK_ID_INVALID", "TASK_ID must match c2c_ followed by 8 lowercase hexadecimal characters."));

  const iterationText = headers.get("ITERATION");
  const iteration = iterationText !== undefined && /^\d+$/.test(iterationText) ? Number(iterationText) : Number.NaN;
  if (iterationText === undefined) diagnostics.push(error("ITERATION_MISSING", "ITERATION is required."));
  else if (!Number.isSafeInteger(iteration)) diagnostics.push(error("ITERATION_INVALID", "ITERATION must be a non-negative integer."));

  const versionText = headers.get("PROTOCOL_VERSION");
  let protocolVersion = Number.NaN;
  if (versionText === undefined) {
    protocolVersion = 1;
    diagnostics.push(warning("PROTOCOL_VERSION_INFERRED", "PROTOCOL_VERSION was omitted and version 1 was inferred."));
  } else if (versionText === "1") {
    protocolVersion = 1;
  } else {
    diagnostics.push(error("PROTOCOL_VERSION_UNSUPPORTED", `Unsupported protocol version: ${versionText}`));
  }

  if (diagnostics.some((item) => item.severity === "error")) return { ok: false, diagnostics };

  const sections = Object.fromEntries(
    [...sectionLines].map(([name, valueLines]) => [name, valueLines.join("\n").trim()])
  );
  const parsed = C2CMessageSchema.safeParse({
    protocolVersion,
    taskId,
    iteration,
    state: stateResult.success ? stateResult.data : stateValue,
    sections,
  });
  if (!parsed.success) {
    diagnostics.push(error("MESSAGE_INVALID", parsed.error.issues.map((issue) => issue.message).join("; ")));
    return { ok: false, diagnostics };
  }

  return { ok: true, message: parsed.data, diagnostics };
}

function warning(code: string, message: string): ProtocolDiagnostic {
  return { code, severity: "warning", message };
}

function error(code: string, message: string): ProtocolDiagnostic {
  return { code, severity: "error", message };
}
