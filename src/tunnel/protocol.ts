/** Transport protocols accepted by cloudflared's `--protocol` flag. */
export const TUNNEL_PROTOCOLS = ["auto", "quic", "http2"] as const;
export type TunnelProtocol = (typeof TUNNEL_PROTOCOLS)[number];

/**
 * Read the transport protocol override from `C2C_TUNNEL_PROTOCOL`.
 *
 * Unset or empty keeps cloudflared's own default (QUIC). Networks that drop
 * idle UDP flows (corporate firewalls, some NATs) keep terminating QUIC
 * connections with "no recent network activity"; `http2` runs the tunnel over
 * TCP instead. An unknown value fails loudly rather than silently falling back.
 */
export function resolveTunnelProtocol(env: NodeJS.ProcessEnv = process.env): TunnelProtocol | null {
  const raw = env.C2C_TUNNEL_PROTOCOL?.trim().toLowerCase();
  if (!raw) return null;
  if (!TUNNEL_PROTOCOLS.includes(raw as TunnelProtocol)) {
    throw new Error(
      `C2C_TUNNEL_PROTOCOL must be one of ${TUNNEL_PROTOCOLS.join(", ")} (got "${raw}")`
    );
  }
  return raw as TunnelProtocol;
}

/** Extra cloudflared arguments for the chosen protocol; empty keeps cloudflared's default. */
export function tunnelProtocolArgs(protocol: TunnelProtocol | null | undefined): string[] {
  return protocol ? ["--protocol", protocol] : [];
}
