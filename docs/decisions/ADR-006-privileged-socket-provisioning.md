# ADR-006: Privileged Unix socket provisioning and unprivileged Credential Broker

- **Status:** Accepted
- **Date:** 2026-11-17
- **Related product decisions:** PD-015, PD-022, PD-023
- **Related ADRs:** ADR-002, ADR-003, ADR-005

## Context

Each tenant Runtime must access a shared Credential Broker through its own Unix Domain Socket. Runtime identities are separated by Linux UID. The Broker must not run with root privileges, and the platform must avoid introducing a large privileged service with broad responsibilities.

## Decision

1. A dedicated, narrowly scoped privileged system component is responsible for creating per-Runtime Unix Domain Sockets and assigning their ownership and permissions.
2. This provisioning component performs only the operations required to create/remove socket endpoints and set their owner/group/mode. It does not issue workload tokens, access integration credentials, sign tokens, or make tenant authorization decisions.
3. Credential Broker runs as a separate unprivileged Linux user and does not run as root.
4. DSH Runtime connects only to the socket provisioned for its own Linux UID/runtime identity.
5. Broker maps the authenticated socket/peer identity to the tenant and runtime using server-controlled configuration/state. Caller-supplied tenantId, agentId, or runtimeId are not authoritative.
6. Provisioning and Broker APIs fail closed: unknown Runtime, UID mismatch, incorrect socket ownership/mode, missing mapping, or provisioning failure prevents token issuance.
7. The privileged component exposes no general-purpose shell, arbitrary path, arbitrary chown, or arbitrary command interface to Runtime or Broker.
8. Lifecycle operations (create, rotate/recreate, revoke, remove) are authenticated and audited. Socket paths are not treated as secrets; security depends on OS ownership, permissions, and identity checks.

## Consequences

- The privileged component has a very small trusted computing base and should be implemented as a minimal service/helper with a narrow request schema.
- Credential Broker remains unprivileged even though it serves multiple tenants.
- Deployment must define who may call the provisioning component and how that caller is authenticated.
- The exact implementation mechanism (e.g. system service with a restricted local IPC interface versus a tightly constrained helper) is an implementation detail to be selected during design review; it must preserve the restrictions above.
- Automated tests must verify socket owner/group/mode, cross-tenant connection denial, unauthorized provisioning denial, Broker non-root execution, and fail-closed behavior.

## Implementation status

This is an accepted architecture decision, not a claim that the provisioning component or Broker is implemented. Production readiness requires implementation, privilege-boundary tests, and deployment verification.
