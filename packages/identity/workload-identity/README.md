---
description: "Ed25519 workload-token library for issuing and verifying short-lived tenant-scoped DSH runtime identities."
kind: "package-library"
---

# @deepseek-ai/dsh-workload-identity

English | [中文](README.zh.md)

## Summary

The package issues short-lived Ed25519 workload tokens for tenant-scoped DSH runtimes. The Control Plane uses issueWorkloadToken, and Tool Gateway uses verifyWorkloadToken to authenticate each runtime. The library owns token format and claim validation, but not private-key storage, revocation, or resource-level authorization.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

Use this library when the trusted Control Plane must issue a short-lived identity for one tenant, agent, and runtime, and Tool Gateway must verify that identity before dispatching a business operation. It is a plain Node module, not a Cordis plugin or an installable profile layer.

### Entry point

The complete example below creates an ephemeral key pair for a local smoke test. In production, keep the private key in the Control Plane and provision only the public key to Tool Gateway.

```ts
import { generateKeyPairSync } from 'node:crypto'
import { issueWorkloadToken, verifyWorkloadToken } from '@deepseek-ai/dsh-workload-identity'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const identity = {
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  runtimeId: 'runtime-a',
  capabilities: ['crm.read'],
}
const token = issueWorkloadToken(identity, {
  privateKey,
  keyId: 'control-2026-01',
  issuer: 'https://control.example',
  audience: 'dsh-tool-gateway',
})
const verified = verifyWorkloadToken(token, {
  publicKeys: new Map([['control-2026-01', publicKey]]),
  issuer: 'https://control.example',
  audience: 'dsh-tool-gateway',
})
console.log(verified.tenantId)
```

Successful verification returns frozen claims. Invalid tokens raise WORKLOAD_TOKEN_INVALID; invalid server key or verifier configuration raises WORKLOAD_TOKEN_CONFIGURATION_INVALID.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design boundaries

The versioned envelope fixes Ed25519 rather than accepting an algorithm from the token. The key id is included in the signed input, so verification-key rotation can retain old public keys while new tokens use a new id. Payload parsing rejects unknown claims, duplicate or unsorted capabilities, non-canonical JSON, malformed identifiers, and lifetimes longer than 300 seconds.

The issuer and verifier are deliberately separate by key material: only the issuer receives a private key, while the verifier accepts public keys only. A token is a bearer credential and remains usable until expiry; this package does not store or revoke tokens.

### Source map

| File | Role |
|---|---|
| [src/index.ts](src/index.ts) | Plain library API: Ed25519 token issue/verify, claim validation, key-id selection, and stable error codes. |
| [tests/workload-identity.spec.ts](tests/workload-identity.spec.ts) | Exercises signatures, key rotation, issuer/audience, time bounds, capability validation, canonical payloads, and key separation. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read the architecture and threat model before wiring this library into a service.

- [Identity group map](../README.md) — the sibling packages and identity-family scope.
- [Security architecture](../../../docs/security/architecture.md) — the Control Plane, Runtime, Tool Gateway, and Execution Plane boundaries.
- [Threat model](../../../docs/security/threat-model.md) — the workload-identity and cross-tenant threats this package helps address.
- [Restricted DSH profile](../../../docs/security/restricted-profile.md) — the current model-facing capability restrictions.
- [Node.js crypto API](https://nodejs.org/api/crypto.html) — Ed25519 key objects, signing, and verification primitives.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package signs and verifies model-hidden workload credentials and registers no model-facing content.

#### KV Cache effect

None; workload identity is verified outside model requests and does not alter prompt tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- No revocation or replay store — a stolen bearer token can be reused until expiration; jti is an identifier, not a single-use guarantee. The platform must rotate runtime tokens and keep their lifetime bounded.
- No resource authorization — signed capabilities establish the runtime's granted capability set, but Tool Gateway must still authorize each operation and each tenant-owned resource.
- External key management — private-key storage, public-key distribution, key rotation cadence, and emergency key retirement belong to the Control Plane deployment and are not implemented by this library.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
