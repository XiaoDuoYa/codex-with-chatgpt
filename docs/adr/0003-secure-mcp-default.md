# ADR 0003: Make Secure MCP Tunnel the default transport

- Status: Accepted
- Date: 2026-09-05

## Context

V1 publishes a loopback bridge through Cloudflare and protects it with C2C-managed OAuth/pairing. OpenAI documents Secure MCP Tunnel for connecting private or developer-machine MCP servers to supported OpenAI products without exposing the server to the public internet. Availability can depend on the account and workspace.

## Decision

V2 uses OpenAI Secure MCP Tunnel as its default transport and supervises the official client through a thin adapter. C2C does not implement the tunnel wire protocol. Cloudflare remains, if supported, only as an explicitly selected compatibility mode.

## Consequences

- Capability/entitlement and client-version checks occur before startup.
- Tunnel failures are typed and visible to the caller.
- Failure or unavailability never triggers an automatic Cloudflare downgrade.
- V1 loopback binding and authenticated access semantics remain required.

## Alternatives considered

- **Cloudflare remains default:** rejected for V2 because it retains public-endpoint and custom-auth operational complexity.
- **Custom tunnel protocol:** rejected because C2C should not own a security-sensitive wire protocol.

## Reference

- OpenAI Help Center, [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt-beta).

## PR-01 note

PR-01 does not change the V1 Cloudflare default; it only records the V2 target.
