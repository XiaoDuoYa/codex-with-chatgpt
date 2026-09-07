export const CONTROL_RESULT_TRANSPORTS = ["computer_use", "mailbox"] as const;

export type ControlResultTransport = (typeof CONTROL_RESULT_TRANSPORTS)[number];

/**
 * Temporary comparison mode: keep the mailbox implementation intact, but do
 * not expose or use its MCP callback tools in the production gateway.
 */
export const ACTIVE_CONTROL_RESULT_TRANSPORT: ControlResultTransport = "computer_use";
