---
description: "The identity package group: anonymous installation correlation ids and signed workload identities for tenant-scoped runtimes."
kind: "package-group"
---

# identity/ — shared identity

English | [中文](README.zh.md)

## Summary

The identity group contains two separate identity mechanisms. anonymous-user-id supplies a non-authenticating correlation id per harness home for telemetry, feedback, and provider records. workload-identity issues and verifies short-lived Ed25519 credentials that bind a tenant, agent, runtime, and server-granted capabilities. The anonymous id is not an authentication credential; workload-token signing keys belong only to the trusted Control Plane.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Use anonymous-user-id for installation-level correlation; use workload-identity when a trusted service must authenticate a tenant-scoped runtime.

| Package | Role |
|---|---|
| [anonymous-user-id](anonymous-user-id/README.md) | Gives one harness home a stable anonymous correlation id for telemetry, feedback, and DeepSeek provider records. |
| [workload-identity](workload-identity/README.md) | Issues and verifies short-lived Ed25519 identities scoped to one tenant, agent, runtime, and capability set. |

<a id="related-documentation"></a>
## Related documentation

- [Session telemetry subsystem](../../docs/subsystems/session-telemetry.md) — the telemetry feature that carries the anonymous installation id.
- [dsh-llm-deepseek](../llm/llm-deepseek/README.md) — the DeepSeek provider that carries the anonymous installation id on requests.
- [dsh-command-feedback](../feedback/command-feedback/README.md) — the feedback command that names the anonymous installation in its acknowledgement.

<a id="dev-note"></a>
## Dev Note

None.
