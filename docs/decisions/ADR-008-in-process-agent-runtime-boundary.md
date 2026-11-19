# ADR-008: In-process DSH Agent and Runtime trust boundary

- **Status:** Accepted
- **Date:** 2026-11-17
- **Related product decisions:** PD-026
- **Supersedes:** The separate Agent UID and Agent/Runtime IPC model described by ADR-007
- **Related ADRs:** ADR-002, ADR-003, ADR-004, ADR-005, ADR-006

## Context

The DSH Agent Loop is implemented inside the DSH Runtime process. Introducing a separate Agent Worker would require a substantial execution-model change and is not selected. The product decision is to keep the Agent inside the existing DSH Runtime.

An in-process Agent Loop is not a separate Linux process or OS security principal. It cannot be isolated from Runtime memory, environment, or filesystem by assigning it a different UID. The Runtime process therefore remains part of the trusted computing base.

## Decision

1. Keep DSH Agent and Agent Loop inside the DSH Runtime process. Do not introduce a separate Agent Worker or Agent↔Runtime IPC service.
2. DSH Runtime runs under the tenant-scoped Runtime Linux UID defined by PD-022.
3. Do not allocate a separate Agent UID. The Agent Loop shares the Runtime process identity because it is in-process.
4. Keep Credential Broker separate and unprivileged; its per-Runtime Unix socket is accessed by the DSH Runtime service. Broker handles only short-lived workload-token acquisition and relay, not provider or integration credentials.
5. Keep audience-specific workload tokens inside trusted Runtime-side code paths. DSH Runtime receives no long-lived provider or integration credentials. Never place bearer tokens or secrets in model prompts, tool arguments, tool results, user-visible errors, logs, traces, or artifacts.
6. Runtime calls Model Gateway for model inference using a short-lived token with exact audience `dsh-model-gateway`. Agent/model requests business operations only through the Runtime's explicit tool interfaces; Runtime calls Tool Gateway using a separate short-lived token with exact audience `dsh-tool-gateway`. Neither bearer token is returned to the Agent Loop or exposed as a tool parameter/result.
7. Do not execute arbitrary model-generated code, third-party plugin code, or other untrusted code inside the DSH Runtime process. Advanced code execution remains external through Execution Broker and an ephemeral isolated job sandbox, as defined by ADR-004.
8. Restricted profile continues to prohibit Local Shell and arbitrary in-Runtime code execution.
9. Treat in-process plugins and extensions as trusted code with Runtime-level privileges. They require an explicit allowlist, code review, and dependency control; they are not a security boundary.
10. A compromise or arbitrary code execution inside the DSH Runtime process is considered a Runtime compromise. The architecture does not claim that Linux UID separation can protect Runtime memory or credentials from code executing inside that same process.

## Security consequences and limitations

- This choice is simpler and preserves DSH's current execution model.
- OS-level UID separation still isolates the DSH Runtime from other tenant Runtime processes and from external execution jobs, but it does not separate the in-process Agent Loop from its Runtime.
- Prompt injection must not be able to invoke arbitrary filesystem, shell, process, or network capabilities. Only explicitly registered tools are exposed.
- Credential safety depends on keeping secret-bearing operations in trusted Runtime code and never exposing secret values through Agent-visible interfaces.
- Any vulnerability allowing arbitrary code execution in the Runtime process can expose its in-memory short-lived workload tokens and data accessible to that process. This is an accepted residual risk of the selected simpler architecture and must be mitigated through minimal dependencies, restricted plugins, process hardening, patching, and monitoring. Provider and integration credentials remain outside the Runtime.
- Negative tests must verify that tool schemas/results/logs/prompts never contain bearer tokens or provider/integration credentials; Model Gateway and Tool Gateway accept only their own exact-audience tokens and required capabilities; Runtime obtains tokens only through its authenticated per-Runtime Broker socket; arbitrary shell/code execution is unavailable in Restricted; Advanced jobs cannot access Runtime sockets or tokens.

## Implementation status

This ADR records the accepted execution model and trust boundary. It does not claim that the Runtime credential path, Tool Gateway, plugin restrictions, or all negative tests are already implemented.
