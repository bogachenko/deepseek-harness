/** Static connection settings for the tenant-scoped Model Gateway route. */

import { isAbsolute } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Plugin configuration. Endpoint and broker socket are deployment-owned facts. */
export interface Config {
  /** HTTPS origin of Model Gateway; no path, query, fragment, or embedded credentials. */
  baseURL: string
  /** Absolute local Unix-domain socket path exposed by Credential Broker. */
  brokerSocketPath: string
  /** In-memory model-catalog cache lifetime. */
  catalogCacheMs: number
  /** Maximum wall-clock duration of one HTTP operation or generation. */
  requestTimeoutMs: number
  /** Maximum time the SSE stream may remain idle between frames. */
  streamIdleTimeoutMs: number
}

export const Config = z.object({
  baseURL: z.string(),
  brokerSocketPath: z.string(),
  catalogCacheMs: z.number().min(0).default(15_000),
  requestTimeoutMs: z.number().min(1_000).default(180_000),
  streamIdleTimeoutMs: z.number().min(1_000).default(90_000),
})

/** Validated, detached connection settings used by one adapter instance. */
export interface ResolvedConfig {
  readonly baseURL: string
  readonly brokerSocketPath: string
  readonly catalogCacheMs: number
  readonly requestTimeoutMs: number
  readonly streamIdleTimeoutMs: number
}

/** Validate the endpoint and socket before registering the provider route. */
export function resolveConfig(config: Config): ResolvedConfig {
  let endpoint: URL
  try {
    endpoint = new URL(config.baseURL)
  } catch (error) {
    throw new Error('llm-model-gateway: baseURL must be a valid HTTPS origin', { cause: error })
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.pathname !== '/' ||
    endpoint.search !== '' ||
    endpoint.hash !== ''
  ) {
    throw new Error('llm-model-gateway: baseURL must be an HTTPS origin without credentials, path, query, or fragment')
  }
  if (
    !isAbsolute(config.brokerSocketPath) ||
    config.brokerSocketPath.includes('\0') ||
    Buffer.byteLength(config.brokerSocketPath) > 107
  ) {
    throw new Error('llm-model-gateway: brokerSocketPath must be an absolute Unix socket path no longer than 107 bytes')
  }
  return {
    baseURL: endpoint.origin,
    brokerSocketPath: config.brokerSocketPath,
    catalogCacheMs: config.catalogCacheMs,
    requestTimeoutMs: config.requestTimeoutMs,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
  }
}
