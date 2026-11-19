# ADR-009: Provider-independent Model Gateway

- **Status:** Accepted
- **Date:** 2026-11-17
- **Related product decision:** PD-027
- **Related ADRs:** ADR-002, ADR-003, ADR-004, ADR-008

## Context

DSH Runtime currently composes model adapters and, in some profiles, resolves provider API credentials inside the Runtime process. This is incompatible with the SaaS security invariant that DSH Runtime must not hold long-lived provider credentials. The platform must support multiple model providers and self-hosted model endpoints; it must not be architecturally coupled to DeepSeek or any single provider.

The Model Gateway is a platform service boundary, not a provider-specific DeepSeek proxy and not a model-facing tool.

## Decision

1. Introduce a provider-independent Model Gateway as the single platform egress path from production DSH Runtime instances to model providers.
2. Model Gateway supports multiple provider adapters behind one stable Runtime-facing contract. Initial provider scope includes DeepSeek, OpenAI, Anthropic, Google Gemini, Qwen, Mistral, and self-hosted or third-party OpenAI-compatible / Anthropic-compatible endpoints. Additional providers must be addable through adapters without requiring provider-specific logic or secrets in DSH Runtime.
3. Model Gateway owns provider API credentials and provider-side authentication. Long-lived provider keys, OAuth refresh tokens, and equivalent provider secrets must never be provisioned to DSH Runtime, included in its environment, or returned through model responses, tool calls, errors, logs, traces, or artifacts.
4. DSH Runtime authenticates to Model Gateway using its short-lived tenant-scoped workload identity. Model Gateway verifies issuer, audience, expiry, runtime/tenant binding, and permitted model/provider policy before dispatch.
5. Model Gateway enforces tenant-scoped provider/model allowlists, request limits, rate limits, and usage accounting. Resource and spend controls are server-side; model output and Runtime-supplied tenant identifiers are not authorization sources.
6. Model Gateway owns provider-specific protocol translation, endpoint selection, model catalog mapping, streaming translation, and provider retry behavior behind a stable provider-neutral contract. Provider-specific wire details must not leak into the Runtime-facing contract unless explicitly represented as portable capability metadata.
7. Model Gateway returns only model output and safe normalized metadata needed by the Runtime. It does not execute model-requested tools or business operations. Tool execution remains behind the Tool Gateway; code execution remains behind the Execution Broker.
8. Local/self-hosted model endpoints are reached by Model Gateway under explicit deployment network policy. DSH Runtime does not gain arbitrary network access to provider endpoints as a fallback.
9. Development and standalone SDK profiles may retain direct provider adapters for local development, but they are not the production SaaS credential boundary and must be clearly distinguished from production deployment profiles.
10. The current repository decision does not claim that Model Gateway is implemented. Production readiness requires the service, provider adapters, credential storage, workload authentication, policy enforcement, audit/usage accounting, and negative security tests to exist.

## Consequences

- Provider API credentials are centralized outside tenant Runtime processes.
- New providers can be added without distributing provider secrets or changing the Agent Loop.
- The platform gains a central enforcement point for model access policy, quotas, and usage.
- Model Gateway becomes a critical trusted service and must be hardened, tenant-isolated, audited, and deployed with high availability appropriate to model traffic.
- Compromise of Model Gateway can expose provider credentials and model traffic; its credential access and network egress must therefore be narrowly scoped.
- Provider-specific features that cannot be normalized must be exposed as explicit, capability-checked extensions rather than silently coupled to one vendor.

## Implementation requirements

- Define a versioned provider-neutral request/response/streaming contract.
- Implement workload-token verification and derive tenant/runtime identity only from verified claims.
- Implement provider adapter interface and provider/model registry.
- Store provider credentials in a server-side secret/credential service; support rotation without Runtime redeployment.
- Enforce tenant/provider/model allowlists, quotas, rate limits, and per-request authorization.
- Record usage and security audit events without logging prompts or credentials by default; any content logging requires a separately approved privacy policy.
- Ensure provider credentials and refresh tokens never appear in Runtime-visible payloads, errors, traces, or artifacts.
- Add tests for cross-tenant isolation, invalid/expired tokens, unauthorized provider/model selection, quota enforcement, credential redaction, and adapter contract conformance.

## Implementation status

Accepted architecture decision only. The Model Gateway service and production credential path remain to be implemented and verified.
