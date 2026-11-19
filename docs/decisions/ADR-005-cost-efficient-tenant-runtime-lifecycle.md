# ADR-005: Cost-efficient tenant runtime lifecycle

- **Status:** Accepted
- **Date:** 2026-11-17
- **Related product decision:** PD-022

## Context

The platform must provide strong tenant isolation while remaining economical to operate on ordinary Linux VPS infrastructure. Per-tenant isolation must not automatically imply a dedicated Credential Broker, a permanently running execution sandbox, or a virtual machine for every customer.

## Decision

1. Each tenant-scoped DSH Runtime runs under its own Linux UID.
2. Each Runtime has its own Unix Domain Socket endpoint/permission boundary when accessing the shared Credential Broker.
3. Run one shared Credential Broker per server/host deployment rather than one Broker per tenant.
4. Start tenant Runtime processes on demand (Lazy Startup).
5. Stop idle Runtime processes after a configurable inactivity period (Idle Shutdown).
6. Apply per-Runtime CPU and RAM quotas.
7. Do not combine untrusted tenants into one DSH Runtime to reduce resource consumption.
8. Do not create a permanently running gVisor sandbox for every agent. Advanced code execution remains job-based and ephemeral, as defined in ADR-004.
9. Determine idle timeout and concrete CPU/RAM limits from measurements on the target VPS; these numeric values are not yet approved.

## Security requirements

- Broker must authenticate the connecting Runtime using OS-enforced peer identity and verify the mapping from UID/socket to tenant and runtime server-side.
- Do not trust tenantId, agentId, or runtimeId supplied as arbitrary request fields without binding them to the authenticated Runtime.
- A Runtime must not be able to access another Runtime's socket.
- Broker failure, missing peer credentials, invalid mapping, or permission ambiguity must fail closed.
- Runtime lifecycle management must not weaken tenant isolation or expose credentials during startup/shutdown.

## Cost implications

- Linux UIDs and Unix sockets have negligible resource overhead compared with additional long-running processes or virtual machines.
- A shared Broker avoids multiplying Broker processes by tenant count.
- Lazy Startup and Idle Shutdown reduce idle memory/CPU consumption, at the cost of startup latency.
- CPU/RAM quotas bound resource consumption per tenant.
- Actual capacity and cost per tenant must be established with measurements; no fixed tenant-per-VPS capacity is implied by this ADR.

## Implementation status

This ADR records the accepted target architecture. It does not assert that the Broker, UID/socket provisioning, lazy lifecycle, idle shutdown, or quotas are implemented. These require code, integration tests, and VPS measurements.
