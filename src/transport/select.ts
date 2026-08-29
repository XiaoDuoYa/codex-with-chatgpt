import type { TransportKind } from "./types.js";

export type TransportPreference = "auto" | TransportKind;

export class TransportSelectionError extends Error {
  constructor(
    public readonly code: "GITHUB_REMOTE_REQUIRED" | "TRANSPORT_CHOICE_REQUIRED",
    message: string
  ) {
    super(message);
    this.name = "TransportSelectionError";
  }
}

export function selectTransport(input: {
  projectDefault?: TransportPreference;
  taskOverride?: TransportPreference;
  accountHint?: "plus" | "mcp";
  hasGitHubRemote: boolean;
}): TransportKind {
  const preference = input.taskOverride ?? input.projectDefault ?? "auto";
  let selected: TransportKind | null = preference === "auto" ? null : preference;
  if (!selected && input.accountHint === "plus") selected = "github";
  if (!selected && input.accountHint === "mcp") selected = "mcp";
  if (!selected) {
    throw new TransportSelectionError(
      "TRANSPORT_CHOICE_REQUIRED",
      "Choose MCP or GitHub explicitly; auto mode does not guess ChatGPT account capabilities."
    );
  }
  if (selected === "github" && !input.hasGitHubRemote) {
    throw new TransportSelectionError(
      "GITHUB_REMOTE_REQUIRED",
      "GitHub transport requires an existing GitHub remote."
    );
  }
  return selected;
}
