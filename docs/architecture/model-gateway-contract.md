# Model Gateway API and Provider Adapter Contract

- **Status:** Approved by product owner
- **Date:** 2026-11-18
- **Related decisions:** PD-027, PD-037, PD-038, PD-039, PD-040, PD-041
- **Related ADR:** ADR-009
- **DSH compatibility reference:** `packages/llm/llm/src/types.ts`

## 1. Design goals

- Preserve the semantics of the existing DSH LLM API rather than inventing a second conversation model.
- Keep provider credentials and provider-specific protocols outside DSH Runtime.
- Expose one stable, versioned API to DSH Runtime.
- Allow provider adapters to evolve independently.
- Make model selection, tenant authorization, limits, and billing server-side decisions.
- Keep Model Gateway separate from Tool Gateway and Execution Broker.

## 2. Runtime-facing API

All endpoints are HTTPS-only and require a valid workload token. API version is in the path.

### 2.1 List models

`GET /v1/models`

Returns only models available to the authenticated tenant/runtime under current policy.

Example response:

```json
{
  "version": 1,
  "models": [
    {
      "id": "fast",
      "name": "Fast",
      "inputModalities": ["text", "image"],
      "contextWindow": 64000,
      "maxOutputTokens": 8192,
      "reasoningEfforts": ["low", "medium", "high"],
      "supportsTools": true,
      "supportsStreaming": true
    }
  ]
}
```

The public model `id` is a global platform model alias, not a provider model ID. The platform maintains one central catalog; tenant policy only controls which catalog aliases are enabled for each Tenant. The Gateway maps an alias to a provider, provider model, endpoint, and capability descriptor using server-side configuration. Runtime cannot submit provider base URLs, provider IDs, API keys, credential references, or arbitrary provider options. Tenant-specific aliases and arbitrary tenant-defined endpoints are not part of version 1.

### 2.2 Generate

`POST /v1/generate`

Content type: `application/json`  
Accept: `text/event-stream`

Request schema, version 1:

```json
{
  "version": 1,
  "model": "fast",
  "messages": [],
  "system": "Optional one-shot system prompt",
  "tools": [],
  "toolHistory": null,
  "parameters": {
    "temperature": 0.2,
    "maxTokens": 4096,
    "stop": [],
    "reasoningEffort": "medium"
  },
  "purpose": "conversation",
  "sessionId": "opaque-session-id"
}
```

Mapping to DSH `GenerateOptions`:
- `model`: tenant-visible model alias; replaces provider-specific `provider + model` selection.
- `messages`: DSH `RequestMessage[]`, with content blocks validated against the versioned schema.
- `system`, `tools`, `toolHistory`: preserve DSH semantics.
- `parameters.temperature/maxTokens/stop/reasoningEffort`: map to DSH generation parameters.
- `purpose` and `sessionId`: optional, non-authoritative request metadata.
- `signal`: not serialized; HTTP request cancellation controls the provider request.
- `provider`, provider base URL, credential references, raw API keys, and arbitrary provider-specific options are not accepted.

Messages preserve DSH roles and content semantics, including text, reasoning, image, file, tool-call, tool-addition, and tool-removal blocks where supported by the selected model. Provider adapters must explicitly declare unsupported capabilities; the Gateway must reject unsupported input rather than silently dropping it.

The Gateway strips DSH-internal identifiers and source metadata not needed for provider translation. Provider replay state is treated as opaque, bounded, tenant-scoped data; it must never contain credentials. Gateway controls the actual provider and model route.

### 2.3 Streaming response

The response is Server-Sent Events. Each `data:` frame contains one versioned DSH-compatible stream chunk:

```text
data: {"version":1,"type":"block-start","index":0,"blockType":"text"}

data: {"version":1,"type":"text-delta","index":0,"text":"Hello"}

data: {"version":1,"type":"block-end","index":0,"block":{"type":"text","text":"Hello"}}

data: {"version":1,"type":"usage","usage":{"inputTokens":12,"outputTokens":4,"totalTokens":16}}

data: {"version":1,"type":"finish","reason":{"kind":"stop"}}
```

The stream vocabulary follows DSH `StreamChunk`: `block-start`, `text-delta`, `reasoning-delta`, `tool-call-delta`, `block-end`, `usage`, and terminal `finish`. Usage, when available, is emitted before finish. No chunks follow finish.

If the connection is cancelled, the Gateway aborts the upstream provider request. Automatic retry is allowed only before any response chunk has been emitted; after partial output, the Gateway must not silently replay the generation.

### 2.4 Image attachments

DSH attachment references point to Runtime-local storage and are not usable by a remote Gateway. Version 1 therefore uses a separate upload flow:

`POST /v1/attachments/images`

- Authenticated with the same Model Gateway workload token.
- Body contains raw image bytes, not a local filesystem path or local attachment ID.
- Content type and byte length are validated against tenant policy.
- Response contains an opaque `attachmentId`, verified media type, byte length, dimensions, and expiry.
- Generate requests refer to the uploaded image by this Gateway attachment ID.
- Attachments are scoped to tenant and Runtime from verified token claims, expire automatically, and cannot be fetched by another tenant/runtime.
- Image bytes are stored in a separate S3-compatible object store, never on the Runtime or Gateway local filesystem as durable storage. Gateway object keys are generated server-side and include the verified tenant/runtime scope; buckets remain private.
- Object metadata records verified media type, byte length, tenant/runtime binding, and expiry. Every read checks scope and expiry before returning bytes to a provider adapter.
- S3 endpoint, region, bucket, and service credentials are deployment configuration. Runtime never receives an S3 credential, object key, or public object URL.
- DSH Runtime may cache the Gateway attachment ID in memory for the attachment lifetime. No provider credential or bearer token is embedded in the attachment reference.

File blocks retain the current DSH projection to deterministic text handles in version 1. Native remote file upload is deferred until a provider-neutral file contract is separately designed.

## 3. Error contract

Non-streaming failures use a stable JSON envelope:

```json
{
  "version": 1,
  "error": {
    "code": "MODEL_NOT_ALLOWED",
    "message": "The requested model is not available.",
    "retryable": false,
    "requestId": "opaque-request-id"
  }
}
```

Initial stable codes:
- `UNAUTHENTICATED`
- `FORBIDDEN`
- `INVALID_REQUEST`
- `MODEL_NOT_FOUND`
- `MODEL_NOT_ALLOWED`
- `CAPABILITY_NOT_SUPPORTED`
- `RATE_LIMITED`
- `QUOTA_EXCEEDED`
- `ATTACHMENT_INVALID`
- `ATTACHMENT_EXPIRED`
- `UPSTREAM_UNAVAILABLE`
- `UPSTREAM_TIMEOUT`
- `UPSTREAM_ERROR`
- `PROVIDER_CREDENTIAL_UNAVAILABLE`
- `BILLING_CONFIGURATION_MISSING`
- `INTERNAL_ERROR`

Messages must be safe and provider-neutral. Never return raw upstream response bodies, provider credential details, internal endpoints, or stack traces. Include `Retry-After` only when a safe retry delay is known.

## 4. Runtime authentication

Use the existing `@deepseek-ai/dsh-workload-identity` Ed25519 token format.

- Exact audience: `dsh-model-gateway`.
- Required capability: `model:invoke`.
- Optional capability for model discovery: `model:catalog:read`.
- Optional capability for image upload: `model:attachment:write`.
- Token lifetime: at most 300 seconds, matching the existing library limit.
- Private signing key remains exclusively in Control Plane.
- Credential Broker does not sign tokens; it obtains/relays a Control-Plane-signed token for the exact audience and Runtime identity.
- Runtime keeps the bearer token in memory only and refreshes it before expiry through its authenticated Broker channel.
- Gateway verifies signature, key id, issuer, exact audience, expiry, and required capability on every request.
- Gateway derives tenantId, agentId, and runtimeId only from verified claims. Request body values cannot override identity.
- Gateway also checks server-side Runtime status and tenant model policy; a valid signature alone does not grant access to an arbitrary model.
- Tokens are never placed in URLs, request bodies, model prompts, tool arguments/results, logs, traces, or artifacts.

The current token library does not implement revocation or replay prevention. Until a separate revocation mechanism is implemented, the short token lifetime, Runtime status check, and rate limits are required mitigations. The `jti` claim is not a single-use guarantee.

## 5. Provider adapter interface

The Gateway owns a provider adapter registry. Initial adapters cover OpenAI-compatible chat-completions endpoints (DeepSeek, OpenAI, Qwen, Mistral, and compatible/self-hosted endpoints), Anthropic Messages, and Google Gemini streaming generation. Adapters receive only a server-resolved route and a request-scoped credential handle/value from the Gateway's credential service; this interface is internal and never exposed to Runtime. Provider-specific SDK/protocol details remain behind the adapter boundary.

Conceptual TypeScript contract:

```ts
interface ModelProviderAdapter {
  readonly id: string

  discoverModels?(options: {
    signal: AbortSignal
  }): Promise<readonly ProviderModelDescriptor[]>

  describeModel(
    providerModelId: string,
    signal: AbortSignal,
  ): Promise<ProviderModelCapabilities>

  generate(
    request: CanonicalModelRequest,
    context: {
      providerModelId: string
      credential: ProviderCredential
      signal: AbortSignal
      requestId: string
    },
  ): AsyncIterable<ProviderStreamEvent>
}
```

Adapter responsibilities:
- Translate canonical messages, tools, generation parameters, images, and streaming events to/from the provider protocol.
- Declare model capabilities and limits (modalities, tools, reasoning, context window, output limit, streaming, system/tool update semantics).
- Normalize provider usage, finish reasons, and failures into DSH-compatible vocabulary.
- Honor cancellation and bounded timeouts.
- Never log credentials or full sensitive request content.
- Never perform tenant authorization or choose a tenant; the Gateway does that before invoking the adapter.

The Gateway's internal credential handle must not be serializable, logged, cached in model/session data, or returned to the Runtime. Both platform-managed provider credentials and Tenant-owned BYOK credentials are supported. Server-side Tenant/model policy selects `platform`, `tenant`, or `tenant_preferred` credential mode; fallback from BYOK to a platform key occurs only when `tenant_preferred` is explicitly configured. Control Plane stores credentials encrypted at rest and returns them only to authenticated Gateway instances over the internal service API. Gateway resolves credentials per request (or through a tightly controlled short-lived in-memory cache), clears request-scoped references after use, and supports rotation without Runtime restart.

Provider-specific options are not passed through from Runtime. Any non-portable feature is exposed as a typed, capability-checked extension configured server-side and documented per adapter.

## 6. Server-side routing and policy

- Runtime requests a global platform model alias such as `fast`, not a provider ID, raw provider model ID, or base URL.
- The central catalog maps each alias to provider, adapter, provider model, endpoint, supported modalities/capabilities, and platform-side credential reference.
- Tenant policy is an allowlist over the central catalog. It also selects the credential source for each allowed model and may narrow the model's configured limits; it cannot change the provider route or endpoint.
- Runtime-supplied tenant/provider/credential/endpoint fields are rejected; tenant identity is derived only from verified workload claims.
- The Control Plane remains the persistent system of record. Gateway instances use authenticated, versioned Control Plane APIs for catalog, Tenant policy, credential resolution, authorization, and usage settlement; Gateway instances do not connect directly to PostgreSQL.
- Model Gateway does not execute tools. Tool calls are returned as model output and are executed only by the DSH/Tool Gateway path.
- Model Gateway does not execute code; Execution Broker remains the only code-execution boundary.

## 7. Operational and privacy requirements

- Meter input/output/cache/reasoning tokens when provider data is available; mark unavailable fields as unknown rather than guessing. Reasoning tokens are a subset of output tokens unless a provider's authoritative usage contract states otherwise.
- Record provider, provider model, tenant, runtime, request ID, latency, status, usage, provider cost when known, and customer charge when rated in server-side metering/audit records.
- Enforce tenant-scoped request/token quotas, per-minute rate limits, concurrent-request limits, and hard spend limits before dispatch. Use atomic reservations so concurrent requests cannot bypass spend limits; settle reservations against authoritative provider usage after completion.
- Use configurable billing plans and model rate cards. Rates are stored as integer micro-USD per million tokens (plus explicit image rates where applicable); do not hard-code prices. A model without an active rate card is not available for billable requests.
- Unknown usage fields remain unknown. If authoritative usage is unavailable, record an unrated usage event and do not fabricate a token count or charge.
- The initial billing capability is a usage ledger and configurable rating/invoice basis; automatic payment collection is not implied until a payment provider is separately selected.
- Record provider, provider model, tenant, runtime, request ID, latency, status, and usage in server-side metering/audit records.
- Do not log prompts, completions, image bytes, credentials, or bearer tokens by default.
- Enforce request body, message count, tool schema, attachment size, stream duration, concurrency, and tenant spend limits.
- Apply bounded connect/first-byte/idle/total timeouts.
- Provider retries must respect idempotency and must not duplicate a partially streamed response.
- No direct-provider network fallback from production Runtime.

## 8. Compatibility and rollout

1. Add a Gateway-backed DSH LLM adapter registered as one provider route (for example, `model-gateway`).
2. Preserve the DSH `GenerateOptions` and `StreamChunk` semantics at the Runtime boundary.
3. Keep direct provider adapters only in standalone/development profiles.
4. Migrate the production SaaS profile to the Gateway adapter and remove provider API credentials from its environment/configuration.
5. Store image attachments in the separate S3-compatible object store and keep object access private and tenant/runtime-scoped.
6. Deploy Gateway independently from Control Plane and scale stateless Gateway instances horizontally; persistent policy, credential, and billing state stays behind Control Plane APIs.
7. Deny Runtime egress to provider endpoints at the network layer.
8. Add contract, adapter-conformance, auth, quota, cancellation, streaming, attachment, and cross-tenant tests before enabling production traffic.

## 9. Open items requiring separate product/configuration decisions

- Exact customer billing plans, price values, billing period/anchor, taxes, invoice presentation, and payment collection provider. The implementation must keep rate cards configurable and must not invent rates.
- Concrete S3-compatible vendor, endpoint, bucket lifecycle policy, and operational retention settings; the Gateway contract is vendor-neutral.
- OAuth account linking and refresh-token rotation for providers that use user-delegated authentication. Version 1 supports platform-managed API keys and Tenant BYOK API keys.
- Full native file upload contract (not part of version 1).
- Additional provider-specific capabilities that cannot be represented by the portable contract; each requires a typed, capability-checked extension.
