# ADR-004: Ephemeral isolated code execution

- **Status:** Accepted
- **Date:** 2026-11-17
- **Related product decisions:** PD-006–PD-011

## Context

Advanced agents may need to execute code, but model-generated or user-supplied code is untrusted. It must not run inside DSH Runtime, Control Plane, Tool Gateway, or with access to host credentials and internal services. A permanent sandbox per agent would consume resources even while idle.

## Decision

1. Advanced code execution is requested through a narrow Execution Broker API/tool.
2. Execution Broker places work onto a job queue and creates a fresh isolated sandbox for each job.
3. The sandbox is destroyed after result/artifact collection or timeout.
4. The initial isolation backend is gVisor `runsc`, using Systrap where supported.
5. KVM is not a baseline requirement.
6. If the required isolation backend is unavailable, misconfigured, or cannot be verified, execution fails closed. There is no automatic fallback to ordinary `runc`/Docker isolation.
7. Sandboxes receive only explicitly supplied inputs; no host mounts, container-runtime sockets, credentials, ambient cloud identity, or Credential Broker socket.
8. Network egress is denied by default. Any later required access must pass through controlled egress policy; private, loopback, link-local, and metadata destinations are not directly reachable.
9. Apply non-root execution and CPU, memory, process, disk, output, and wall-clock limits.

## Consequences

- Sandbox resources are consumed while jobs execute, not continuously for every idle agent.
- Capacity planning must count gVisor overhead separately from application memory.
- The planning estimate of 64 MiB additional memory per active sandbox is an initial assumption, not a measured guarantee for our VPS.
- Before production, verify that each job actually runs under the intended gVisor platform and that fail-closed behavior works.

## Implementation status

The architecture choice is accepted. Production status requires a working Execution Broker, verified gVisor backend, lifecycle enforcement, resource/network controls, and adversarial regression tests.
