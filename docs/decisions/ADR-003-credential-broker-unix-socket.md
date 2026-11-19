# ADR-003: Credential Broker over Unix Domain Socket

- **Status:** Accepted
- **Date:** 2026-11-17
- **Related product decisions:** PD-015–PD-018

## Context

DSH Runtime needs a secure way to obtain and refresh short-lived workload tokens without mounting credential files into the agent environment or persisting tokens to disk. A protected file may be useful for local development, but it is not the production mechanism.

## Decision

1. Implement Credential Broker as a separate, unprivileged service whose only responsibility is short-lived Workload Identity Token acquisition and relay.
2. Use a Unix Domain Socket as the production Runtime-to-Broker transport, with a separate socket and OS-enforced access boundary per Runtime.
3. Authenticate each Runtime using OS peer credentials and map the socket to a registered Runtime identity. Never trust caller-supplied tenantId, agentId, or runtimeId.
4. Authenticate Broker to Control Plane over host-authenticated mTLS. Control Plane validates the active Host/Runtime binding and derives tenantId, agentId, runtimeId, and permitted capabilities from server-side registration and Runtime policy before signing a token.
5. Keep the Ed25519 private signing key exclusively in Control Plane. Broker never signs, re-signs, broadens, or modifies token claims.
6. Broker accepts only the fixed service audiences `dsh-model-gateway` and `dsh-tool-gateway`; it does not accept caller-supplied capability sets or arbitrary audiences.
7. Runtime obtains separate short-lived tokens for Model Gateway and Tool Gateway through the socket, keeps active tokens in memory, and calls each Gateway over HTTPS Bearer authentication with its exact audience.
8. Credential Broker never stores, retrieves, or serves provider credentials, integration credentials, OAuth refresh tokens, or other business secrets.
9. gVisor job sandboxes must not receive the socket or workload tokens.
10. A protected file is allowed only as a local-development fallback, not as the production design.

## Consequences

- Socket ownership, permissions, peer credentials, and Runtime identity mapping are security-critical.
- Host mTLS authentication and Control Plane validation of the active Host/Runtime binding are security-critical.
- The Broker audience allowlist is fixed; Control Plane, not Broker or Runtime, determines the capabilities in each signed token.
- Unix socket access alone does not establish tenant authorization; Model Gateway and Tool Gateway must independently verify the token signature, issuer, exact audience, expiry, and required capabilities.
- Credential Broker has no access to provider or integration credentials. Model Gateway and Tool Gateway use their respective server-side credential paths for authorized operations.

## Implementation status

The transport choice is accepted. Production readiness requires the Broker service, socket API, Runtime authentication, token refresh, revocation/expiry behavior, and cross-tenant integration tests.
