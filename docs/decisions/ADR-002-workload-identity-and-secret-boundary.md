# ADR-002: Workload identity and secret boundary

- **Status:** Accepted
- **Date:** 2026-11-17
- **Related product decisions:** PD-013, PD-014, PD-016, PD-017, PD-018

## Context

The DSH agent process must not be able to read credentials belonging to the Control Plane or integrations. Moving `.credentials.yaml` to another directory is insufficient if the agent and the controller run under the same Linux identity and the file remains readable to that identity.

Environment-variable filtering does not protect secrets stored in files. The security boundary must be based on process identities, OS permissions, service boundaries, and server-side authorization.

## Decision

1. The agent process has no direct access to Secrets Manager, Credential API, Control Plane databases, or long-lived integration credentials.
2. Control Plane and agent/runtime processes use separated system identities and permissions.
3. Use Ed25519 for workload-token signatures.
4. The Ed25519 private signing key exists only in the Control Plane.
5. Credential Broker does not hold the signing private key.
6. A workload token is bound to tenant, agent, runtime, and capabilities.
7. A token has a maximum lifetime of 300 seconds and is held in DSH Runtime memory, not persisted to disk.
8. Tenant and agent identifiers supplied in request arguments are not trusted; identity is derived from authenticated server-side context.
9. Each Runtime has a distinct identity when accessing Credential Broker.
10. gVisor execution jobs receive no access to broker sockets, workload tokens, or Control Plane secrets.

## Consequences

- Credential access is mediated by platform services, never by model-visible files or environment variables.
- Workload-token validation must check signature and relevant claims, including issuer, audience, expiry, and key identifier/rotation policy.
- OS-level isolation and service authorization are both required; neither Unix socket path secrecy nor file permissions alone are sufficient.
- Tests must prove that a compromised agent cannot read platform secrets or impersonate another tenant/runtime.

## Implementation status

This ADR defines the required boundary. Treat implementation as complete only after code review and negative integration tests demonstrate the invariants.
