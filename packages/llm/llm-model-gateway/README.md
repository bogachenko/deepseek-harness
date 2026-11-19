---
description: "Provider-neutral Model Gateway adapter authenticated by the local Credential Broker."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-model-gateway

## Summary

Registers the model-gateway provider route. All model catalog, image upload, and generation traffic goes to the configured HTTPS Model Gateway. The adapter obtains a short-lived dsh-model-gateway Workload Token from the local Credential Broker over its private Unix-domain socket. It does not read provider API keys, access the Control Plane directly, or fall back to a direct provider adapter.

## Configuration

The SaaS Restricted Profile supplies the two deployment-owned connection settings:

| Field | Required | Meaning |
|---|---|---|
| baseURL | yes | HTTPS origin of Model Gateway; path, query, fragment, and embedded credentials are rejected. |
| brokerSocketPath | yes | Absolute local Unix-domain socket path of Credential Broker. |
| catalogCacheMs | no | In-memory catalog cache lifetime; defaults to 15 seconds. |
| requestTimeoutMs | no | HTTP operation and generation deadline; defaults to 180 seconds. |
| streamIdleTimeoutMs | no | Maximum SSE idle interval; defaults to 90 seconds. |

The deployment must set DSH_MODEL_GATEWAY_URL and DSH_CREDENTIAL_BROKER_SOCKET. Missing settings prevent the Restricted Profile from starting. The broker request is fixed to protocol version 1, operation get_workload_token, and audience dsh-model-gateway. The socket path is deployment-provisioned; Runtime does not infer it from a tenant or caller-supplied identity.

## Security boundary

- Workload tokens are held only in process memory and refreshed before expiry. The Broker remains authoritative for token issuance and UID binding.
- Every HTTP request includes the DSH attribution User-Agent, uses HTTPS, rejects redirects, and carries the bearer token only in the Authorization header.
- The adapter sends model aliases, not provider model identifiers or provider credentials.
- Images are read from the Runtime attachment store and uploaded as raw bytes to /v1/attachments/images; only Gateway attachment IDs enter generation requests. The version-one response is validated for exact fields, verified media type, byte length, dimensions, and canonical ISO 8601 UTC expiry.
- Files are projected to model-facing text by DSH before serialization. The adapter refuses a file block that reaches the transport boundary and never sends a Runtime filesystem path.
- HTTP and SSE responses are bounded and validated. There is no direct-provider fallback or automatic retry after a generation request.

## Model Experience

The adapter exposes the tenant-filtered catalog returned by Model Gateway, including context capacity, output limit, modalities, and supported reasoning efforts. The DSH request and stream vocabularies are translated where the Gateway contract supports them. Provider replay metadata is carried as an opaque envelope.

## Known Limitations and Deferred Work

- The Runtime must be provisioned with the local Credential Broker socket and DSH_MODEL_GATEWAY_URL before this plugin can load.
- TLS trust for a private Gateway certificate is provided by the Runtime's operating-system trust store or Node.js trust configuration; this plugin does not install certificates.
- Model Gateway controls provider routing, provider credentials, image object storage, authorization, and billing. This adapter does not bypass those controls.

## Dev Note

The adapter's unit tests exercise the Broker line protocol, token caching, Gateway request translation, attribution headers, image indirection, and SSE terminal handling.
