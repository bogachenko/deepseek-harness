# ADR-010: Model Gateway API, provider adapters, and Runtime authentication

- **Status:** Proposed for product-owner approval
- **Date:** 2026-11-17
- **Related product decision:** PD-027
- **Related ADRs:** ADR-002, ADR-003, ADR-008, ADR-009
- **Contract:** [Model Gateway API and Provider Adapter Contract](../architecture/model-gateway-contract.md)

## Context

PD-027 and ADR-009 approve a provider-independent Model Gateway as the production SaaS model egress boundary. The implementation needs a stable Runtime API, a provider adapter boundary, and service-specific workload authentication. The existing DSH LLM package already defines canonical request and streaming types in `packages/llm/llm/src/types.ts`.

## Proposed decision

1. Runtime-facing API preserves DSH `GenerateOptions` and `StreamChunk` semantics rather than introducing a parallel chat abstraction.
2. Runtime calls the Gateway over HTTPS using a short-lived Ed25519 workload token with exact audience `dsh-model-gateway` and required capability `model:invoke`.
3. Runtime requests a tenant-visible model alias. Provider ID, provider model ID, endpoint, and credential reference are resolved only from server-side Gateway/Control Plane configuration.
4. Model Gateway exposes versioned model discovery, generation streaming, and image upload endpoints as described in the linked contract.
5. Streaming uses a versioned SSE vocabulary aligned with DSH `StreamChunk`. Cancellation aborts upstream generation; retry after partial output is forbidden.
6. Provider adapters translate the canonical request/stream contract to provider-specific protocols. Provider credentials are resolved server-side and never exposed to Runtime or adapter logs.
7. Provider-specific options are not accepted as arbitrary Runtime payloads. Non-portable features require typed, capability-checked extensions.
8. Tool Gateway remains responsible for business tools; Execution Broker remains responsible for code execution. Model Gateway only performs model inference.
9. Production Runtime has no direct provider API egress or fallback. Standalone/development DSH profiles may continue to use direct adapters.
10. Image attachments use a Gateway-owned, tenant/runtime-scoped upload reference in version 1. Native file upload is deferred; current DSH file blocks remain projected to text handles.
11. The existing workload-token library's 300-second maximum is retained. Credential Broker relays Control-Plane-signed tokens; it does not possess or use the signing private key.
12. This ADR is proposed. Open implementation details in the linked contract must be resolved before production rollout; it does not claim implementation exists.

## Rationale

- DSH's current canonical request and stream types already represent messages, tools, reasoning, tool calls, usage, finish reasons, and replay metadata.
- A model alias prevents Runtime/model output from selecting arbitrary providers, endpoints, or credential references.
- Service-specific token audience prevents a Model Gateway token from being accepted by Tool Gateway.
- A separate image upload flow is necessary because DSH attachment references are local opaque IDs and cannot be dereferenced by a remote Gateway.
- Keeping tool and code execution outside Model Gateway prevents this service from becoming an over-privileged universal gateway.

## Required verification

- Token audience, signature, expiry, capability, and Runtime/tenant binding tests.
- Cross-tenant model alias and attachment access denial.
- Provider adapter conformance tests for text, image, tool calls, reasoning, streaming, usage, cancellation, and normalized errors.
- Credential redaction tests across Runtime payloads, errors, logs, traces, and artifacts.
- Quota/rate-limit and no-direct-provider-egress tests.
- Compatibility tests against the pinned DSH LLM API.
