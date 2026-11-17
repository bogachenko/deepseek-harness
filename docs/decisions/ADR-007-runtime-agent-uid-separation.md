# ADR-007: Separate Linux identity for DSH Runtime and Agent Process

- **Status:** Accepted
- **Date:** 2026-11-17
- **Related product decisions:** PD-022, PD-023, PD-024
- **Related ADRs:** ADR-002, ADR-003, ADR-005, ADR-006

## Context

A tenant-scoped DSH Runtime must obtain short-lived workload tokens through its own Credential Broker Unix Domain Socket. If the untrusted Agent Process runs under the same Linux UID as DSH Runtime, it can potentially access resources owned by that UID, including the Runtime's broker socket. This would defeat the intended secret boundary even if environment variables are filtered and credentials are not mounted as files.

## Decision

1. DSH Runtime and its untrusted Agent Process must run under different Linux UIDs.
2. Each tenant-scoped DSH Runtime retains its own dedicated Linux UID, as approved in PD-022.
3. Agent Process runs under a separate, unprivileged Linux identity that does not have permission to connect to the Runtime's Credential Broker socket.
4. The per-Runtime Broker socket is accessible only to the corresponding DSH Runtime identity (and the narrowly scoped provisioning/Broker service identities required to manage and serve it).
5. Agent Process receives neither the Broker socket nor workload tokens, signing keys, integration credentials, or access to Credential Broker APIs.
6. Runtime-to-Agent communication, tool invocation, and workspace access must use narrowly scoped IPC/interfaces and explicit filesystem permissions; they must not require sharing the Runtime UID with the Agent Process.
7. Tenant and Runtime identity must be derived and enforced by trusted server-side state. Caller-provided tenantId, agentId, or runtimeId values are not authoritative.
8. The boundary must fail closed if the Agent Process UID can access the Broker socket or any credential-bearing resource.

## Consequences

- Runtime launch orchestration must support a distinct UID for the Agent Process and controlled access to only the required workspace and IPC endpoints.
- Filesystem ownership/ACLs and IPC permissions must be designed so that the Agent can perform its assigned work without gaining Runtime credentials.
- Tests must prove that the Agent Process cannot connect to the Broker socket, read Runtime memory/files, inspect Runtime environment, or access another tenant's resources.
- This decision adds no per-agent VM requirement. UID separation is an OS identity boundary; actual process/runtime memory costs must be measured, but a UID itself has negligible resource overhead.
- The exact Agent UID allocation strategy (per agent, per tenant with isolated process boundaries, or a safe UID pool) is an implementation detail and must be validated against the required isolation model before coding. The accepted invariant is that Agent Process UID differs from its DSH Runtime UID and cannot access Runtime credentials.

## Implementation status

This ADR records the accepted security boundary. It does not claim that DSH currently launches Agent Process under a distinct UID. Implementation and negative integration tests are still required.

## Open implementation detail

The use of systemd socket activation/socket units as the provisioning mechanism is a candidate implementation, not a separately approved product decision. Verify compatibility with the required per-Runtime socket ownership and Broker activation model before adopting it.
