# Model Gateway API and Provider Adapter Contract

- **Status:** Approved by product owner
- **Date:** 2026-11-17
- **Related decision:** PD-027
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

The public model `id` is a platform model alias, not a provider model ID. The Gateway maps it to a provider and provider model using server-side configuration. Runtime cannot submit provider base URLs, provider IDs, API keys, or arbitrary provider options.

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
- Runtime keeps the bearer token in memory only and refreshes it before expiry through its authenticated Broker channel. Model Gateway uses a separate service-authentication token for its Control Plane channel; it does not receive Host mTLS private keys.
- Gateway verifies signature, key id, issuer, exact audience, expiry, and required capability on every request.
- Gateway forwards the original workload token only in the Authorization header to authenticated Control Plane APIs; it is never copied into a URL or request body.
- Control Plane independently verifies the same token, checks the required capability and active Runtime status, and derives tenantId, agentId, and runtimeId only from verified claims. Identity fields in internal request bodies are not accepted. Request body values cannot override identity.
- Gateway also checks server-side Runtime status and tenant model policy; a valid signature alone does not grant access to an arbitrary model.
- Tokens are never placed in URLs, request bodies, model prompts, tool arguments/results, logs, traces, or artifacts.

The current token library does not implement revocation or replay prevention. Until a separate revocation mechanism is implemented, the short token lifetime, Runtime status check, and rate limits are required mitigations. The `jti` claim is not a single-use guarantee.

## 5. Provider adapter interface

The Gateway owns a provider adapter registry. Adapters receive only a server-resolved route and a request-scoped credential handle/value from the Gateway's credential service; this interface is internal and never exposed to Runtime.

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

The Gateway's internal credential handle must not be serializable, logged, cached in model/session data, or returned to the Runtime. Resolve credentials per request (or through a tightly controlled short-lived in-memory cache) and support rotation without Runtime restart.

Provider-specific options are not passed through from Runtime. Any non-portable feature is exposed as a typed, capability-checked extension configured server-side and documented per adapter.

## 6. Server-side routing and policy

- Runtime requests a tenant-visible model alias such as `fast`, not a provider ID, raw provider model ID, or base URL.
- Control Plane/Gateway configuration maps the alias to provider, provider model, credential reference, endpoint, and policy.
- Tenant policy determines which aliases are available, request/token budgets, rate limits, and spend limits.
- Runtime-supplied tenant/provider/credential/endpoint fields are ignored or rejected; they are never authoritative.
- Model Gateway does not execute tools. Tool calls are returned as model output and are executed only by the DSH/Tool Gateway path.
- Model Gateway does not execute code; Execution Broker remains the only code-execution boundary.

## 7. Operational and privacy requirements

- Meter input/output/cache/reasoning tokens when provider data is available; mark unavailable fields as unknown rather than guessing.
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
5. Deny Runtime egress to provider endpoints at the network layer.
6. Add contract, adapter-conformance, auth, quota, cancellation, streaming, attachment, and cross-tenant tests before enabling production traffic.

## 9. Open items requiring implementation design

- Exact attachment storage backend and cleanup lifecycle.
- Whether provider/model aliases are globally managed or tenant-overridable within an approved catalog.
- Exact quota dimensions and billing/pricing source of truth.
- Whether Model Gateway is deployed as one process per VPS or independently scaled service.
- OAuth account linking and refresh-token rotation flows for providers that use user-delegated auth.
- Full native file upload contract (not part of version 1).
