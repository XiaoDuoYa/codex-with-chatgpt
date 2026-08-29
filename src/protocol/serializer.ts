import { C2CMessageSchema, type C2CMessage } from "./types.js";

const SECTION_ORDER = [
  "GOAL",
  "RATIONALE",
  "ACTIONS",
  "TESTS",
  "SUCCESS_CRITERIA",
  "SUMMARY",
  "REASON",
  "NEEDS",
];

export function serializeC2CMessage(input: C2CMessage): string {
  const message = C2CMessageSchema.parse(input);
  const known = SECTION_ORDER.filter((name) => Object.hasOwn(message.sections, name));
  const unknown = Object.keys(message.sections)
    .filter((name) => !SECTION_ORDER.includes(name))
    .sort();
  const sections = [...known, ...unknown].map((name) => `${name}:\n${message.sections[name].trim()}`);
  const headers = [
    "[C2C]",
    `PROTOCOL_VERSION: ${message.protocolVersion}`,
    `STATE: ${message.state}`,
    `TASK_ID: ${message.taskId}`,
    `ITERATION: ${message.iteration}`,
  ];
  return `${headers.join("\n")}${sections.length > 0 ? `\n\n${sections.join("\n\n")}` : ""}\n`;
}
