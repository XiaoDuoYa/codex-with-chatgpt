export const TUNNEL_PROTOCOLS = ["auto", "quic", "http2"] as const;
export type TunnelProtocol = (typeof TUNNEL_PROTOCOLS)[number];

export function resolveTunnelProtocol(env: NodeJS.Dict<string> = process.env): TunnelProtocol | null {
  const raw = env.C2C_TUNNEL_PROTOCOL?.trim();
  if (!raw) return null;
  const value = raw.toLowerCase();
  if ((TUNNEL_PROTOCOLS as readonly string[]).includes(value)) return value as TunnelProtocol;
  throw new Error(`C2C_TUNNEL_PROTOCOL must be one of ${TUNNEL_PROTOCOLS.join(", ")}`);
}

export function tunnelProtocolArgs(protocol: TunnelProtocol | null = resolveTunnelProtocol()): string[] {
  return protocol ? ["--protocol", protocol] : [];
}
