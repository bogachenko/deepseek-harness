# ADR-007: Separate Linux identity for DSH Runtime and Agent Process

- **Status:** Superseded by ADR-008 (2026-11-17)
- **Date:** 2026-11-17
- **Related product decisions:** PD-022, PD-023, PD-024, PD-025
- **Related ADRs:** ADR-002, ADR-003, ADR-005, ADR-006

## Context

A tenant-scoped DSH Runtime must obtain short-lived workload tokens through its own Credential Broker Unix Domain Socket. If the untrusted Agent Process runs under the same Linux UID as DSH Runtime, it can potentially access resources owned by that UID, including the Runtime's broker socket. This would defeat the intended secret boundary even if environment variables are filtered and credentials are not mounted as files.

## Decision

1. DSH Runtime and untrusted Agent Process must run under different Linux UIDs.
2. Each tenant-scoped DSH Runtime retains its own dedicated Linux UID, as approved in PD-022.
3. All Agent Processes belonging to the same Tenant use one separate, tenant-scoped Agent UID, distinct from that Tenant's DSH Runtime UID.
4. Different Tenants must have different Agent UIDs. An Agent UID must never be shared across Tenant boundaries.
5. Agent Process runs under the tenant's Agent UID and has no permission to connect to that Tenant Runtime's Credential Broker socket.
6. The per-Runtime Broker socket is accessible only to the corresponding DSH Runtime identity and the narrowly scoped provisioning/Broker service identities required to manage and serve it.
7. Agent Process receives neither the Broker socket nor workload tokens, signing keys, integration credentials, or access to Credential Broker APIs.
8. Runtime-to-Agent communication, tool invocation, and workspace access use narrowly scoped IPC/interfaces and explicit filesystem permissions; they do not require sharing the Runtime UID with Agent Process.
9. Tenant and Runtime identity are derived and enforced by trusted server-side state. Caller-provided tenantId, agentId, or runtimeId values are not authoritative.
10. The boundary fails closed if Agent UID can access the Broker socket or any credential-bearing resource.

## Consequences

- Runtime launch orchestration must provision two distinct identities per Tenant: one for DSH Runtime and one for all Agent Processes belonging to that Tenant.
- Filesystem ownership/ACLs and IPC permissions must allow Agent work without granting access to Runtime credentials.
- Because Agent Processes of the same Tenant share one UID, Linux UID permissions alone do not isolate those agents from one another. If per-agent isolation is required, it must be provided by additional boundaries (for example, separate namespaces, mount/workspace restrictions, or per-job sandboxing) without changing the approved one-Agent-UID-per-Tenant decision.
- Tests must prove that Agent UID cannot connect to the Broker socket, read Runtime memory/files, inspect Runtime environment, or access another Tenant's resources.
- This decision does not require a per-agent VM. UID separation itself has negligible resource overhead; actual process/runtime memory costs must be measured.

## Implementation status

This ADR records the accepted identity allocation and security boundary. It does not claim that DSH currently launches Agent Process under the tenant-scoped Agent UID. Implementation and negative integration tests are still required.

## Open implementation detail

The use of systemd socket activation/socket units as the provisioning mechanism remains a candidate implementation, not a separately approved product decision. Verify compatibility with per-Runtime socket ownership and the Broker activation model before adopting it.


## Supersession note

The product owner selected the simpler in-process DSH Agent model. DSH Agent Loop remains inside DSH Runtime; no separate Agent Worker, Agent UID, or Agent↔Runtime IPC is introduced. The requirements in this ADR for a separate Agent UID and process boundary are superseded by ADR-008. Runtime UID separation between tenants remains in force under PD-022.
