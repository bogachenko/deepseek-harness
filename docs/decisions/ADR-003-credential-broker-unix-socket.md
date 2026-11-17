# ADR-003: Credential Broker over Unix Domain Socket

- **Status:** Accepted
- **Date:** 2026-11-17
- **Related product decisions:** PD-015–PD-018

## Context

DSH Runtime needs a secure way to obtain and refresh short-lived workload tokens without mounting credential files into the agent environment or persisting tokens to disk. A protected file may be useful for local development, but it is not the production mechanism.

## Decision

1. Implement Credential Broker as a separate service.
2. Use a Unix Domain Socket as the production Runtime-to-Broker transport.
3. Authenticate each Runtime independently at the OS/service boundary; do not trust tenantId or agentId supplied by the caller without server-side verification.
4. Broker obtains or requests signed workload tokens from the Control Plane; the Ed25519 private key remains exclusively in the Control Plane.
5. Runtime requests and refreshes tokens through the socket and keeps the active token in memory.
6. Runtime uses the short-lived token over HTTPS Bearer authentication to call Tool Gateway.
7. gVisor job sandboxes must not receive the socket or token.
8. A protected file is allowed only as a local-development fallback, not as the production design.

## Consequences

- Socket ownership, permissions, peer credentials, and Runtime identity mapping are security-critical.
- A separate socket or equivalent OS-enforced access boundary is required per Runtime.
- Unix socket access alone does not establish tenant authorization; Broker and downstream services must verify the Runtime identity and claims.
- Integration credentials remain server-side and are used by Tool Gateway for a specific authorized operation.

## Implementation status

The transport choice is accepted. Production readiness requires the Broker service, socket API, Runtime authentication, token refresh, revocation/expiry behavior, and cross-tenant integration tests.
