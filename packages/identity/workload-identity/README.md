---
description: "Issue and verify short-lived Ed25519 workload identities for tenant-scoped DSH runtimes."
kind: "package-library"
---

# @deepseek-ai/dsh-workload-identity

English | [中文](README.zh.md)

## Summary

This package issues and verifies short-lived Ed25519-signed identities for tenant-scoped agent runtimes. The Control Plane signs tokens with a private key; Tool Gateway verifies them with public keys. DSH Runtime only presents the short-lived bearer token to its intended private service audience. The private key must never be provisioned to an agent runtime.

## Table of Contents

- [Use this package](#use-this-package)
- [Token contract](#token-contract)
- [API](#api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
<a id="use-this-package"></a>
## Use this package

The trusted Control Plane calls issueWorkloadToken after authenticating the platform request and resolving the tenant, agent, runtime, and granted capabilities from server-side state. It delivers the resulting bearer token only to the intended runtime or service audience. Tool Gateway calls verifyWorkloadToken with its trusted public-key set and exact issuer and audience. DSH Runtime only presents the bearer token to that private gateway endpoint.

Never derive tenant identity or capabilities from model-generated arguments. Never place the signing private key in DSH Runtime, a sandbox, a prompt, a tool result, or a log. Treat the token as a bearer credential and do not persist or disclose it unnecessarily.

<a id="token-contract"></a>
## Token contract

The compact token has four dot-separated segments: dsh-wid-v1, key id, base64url payload, and Ed25519 signature. The fixed format version selects Ed25519; there is no token-controlled algorithm field. The key id is part of the signed input and selects one trusted public key, allowing old verification keys to remain available during rotation.

The signed payload contains the version, issuer, audience, tenant id, agent id, runtime id, sorted capabilities, unique token id, issuance time, and expiration time. Unknown claims, duplicate or unsorted capabilities, non-canonical JSON, malformed base64url, and invalid identifiers are rejected. A token can carry at most 64 capabilities.

Issuance defaults to a 300-second lifetime and cannot exceed that limit. Verification requires an exact issuer and audience match and allows at most 60 seconds of configured clock tolerance; the default is 30 seconds. Successful verification returns a frozen identity and frozen capability list.

<a id="api"></a>
## API

issueWorkloadToken accepts a server-resolved WorkloadIdentity and signing options containing an Ed25519 private key, key id, issuer, audience, and optional lifetime. It returns a compact bearer token.

verifyWorkloadToken accepts a token and verification options containing a map of trusted public keys, expected issuer, expected audience, and optional clock settings. It returns VerifiedWorkloadIdentity. Token-validation failures share WORKLOAD_TOKEN_INVALID; invalid server key or verifier configuration uses WORKLOAD_TOKEN_CONFIGURATION_INVALID.

<a id="model-experience"></a>
## Model Experience

None, as this package signs and verifies model-hidden workload credentials and registers no model-facing content.

#### KV Cache effect

None; workload identity is verified outside model requests and does not alter prompt tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- No revocation list — a stolen bearer token can be used until its short expiration time; the platform must rotate runtime tokens and keep their lifetime bounded.
- No resource authorization — signed capabilities establish the runtime's granted capability set, but Tool Gateway must still authorize each operation and each tenant-owned resource.
- External key management — private-key storage, public-key distribution, key rotation cadence, and emergency key retirement belong to the Control Plane deployment and are not implemented by this library.

<a id="dev-note"></a>
## Dev Note

None.
