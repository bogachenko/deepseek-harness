/** Bounded HTTP transport helpers and Model Gateway error normalization. */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { BuiltinLlmFailureCode, ProviderRequestId } from '@deepseek-ai/dsh-llm'

export interface ModelGatewayErrorDetails {
  readonly status?: number
  readonly requestId?: ProviderRequestId
  readonly providerRetryAfterMs?: number
  readonly cause?: unknown
}

/** Structured provider-neutral failure retaining safe HTTP metadata. */
export class ModelGatewayAdapterError extends HarnessError {
  readonly status: number | undefined
  readonly requestId: ProviderRequestId | undefined
  readonly providerRetryAfterMs: number | undefined

  constructor(message: string, code: BuiltinLlmFailureCode, details: ModelGatewayErrorDetails = {}) {
    super(message, code, details.cause === undefined ? undefined : { cause: details.cause })
    this.status = details.status
    this.requestId = details.requestId
    this.providerRetryAfterMs = details.providerRetryAfterMs
  }
}

export interface AbortScope {
  readonly signal: AbortSignal
  dispose(): void
}

/** Combine caller cancellation with a wall-clock deadline owned by this request. */
export function createAbortScope(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  timeoutMessage: string,
): AbortScope {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(parent?.reason ?? new Error('Request aborted'))
  if (parent?.aborted === true) onAbort()
  else parent?.addEventListener('abort', onAbort, { once: true })

  const timer = setTimeout(() => {
    controller.abort(new ModelGatewayAdapterError(timeoutMessage, 'TIMEOUT'))
  }, timeoutMs)

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onAbort)
    },
  }
}

/** Read a small JSON response without trusting Content-Length or collecting an unbounded body. */
export async function readJsonResponse(response: Response, maximumBytes: number): Promise<unknown> {
  if (response.body === null) throw new ModelGatewayAdapterError('Model Gateway returned an empty response body', 'MALFORMED_RESPONSE')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maximumBytes) {
        throw new ModelGatewayAdapterError('Model Gateway JSON response exceeded the permitted size', 'MALFORMED_RESPONSE')
      }
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    throw new ModelGatewayAdapterError('Model Gateway returned invalid JSON', 'MALFORMED_RESPONSE', { cause: error })
  }
}

/** Convert a bounded Gateway error envelope into the harness failure taxonomy. */
export async function parseGatewayError(response: Response): Promise<ModelGatewayAdapterError> {
  let envelope: unknown
  try {
    envelope = await readJsonResponse(response, 64 * 1024)
  } catch {
    envelope = undefined
  }
  const error = isRecord(envelope) && envelope.version === 1 && isRecord(envelope.error)
    ? envelope.error
    : undefined
  const gatewayCode = error !== undefined && typeof error.code === 'string' ? error.code : ''
  const message = error !== undefined && typeof error.message === 'string'
    ? error.message
    : 'Model Gateway request failed with HTTP ' + response.status
  const requestId = error !== undefined && typeof error.requestId === 'string' && error.requestId.length > 0
    ? error.requestId as ProviderRequestId
    : undefined
  const retryAfter = retryAfterMs(response.headers.get('retry-after'))
  return new ModelGatewayAdapterError(message, failureCode(gatewayCode, response.status), {
    status: response.status,
    ...(requestId === undefined ? {} : { requestId }),
    ...(retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter }),
  })
}

function failureCode(code: string, status: number): BuiltinLlmFailureCode {
  switch (code) {
    case 'UNAUTHENTICATED':
    case 'FORBIDDEN':
      return 'AUTH'
    case 'MODEL_NOT_FOUND':
    case 'MODEL_NOT_ALLOWED':
      return 'UNKNOWN_MODEL'
    case 'CAPABILITY_NOT_SUPPORTED':
      return 'UNSUPPORTED_CONTENT'
    case 'RATE_LIMITED':
      return 'RATE_LIMIT'
    case 'QUOTA_EXCEEDED':
      return 'QUOTA'
    case 'UPSTREAM_TIMEOUT':
      return 'TIMEOUT'
    case 'UPSTREAM_UNAVAILABLE':
      return 'TRANSPORT'
    case 'INVALID_REQUEST':
    case 'ATTACHMENT_INVALID':
    case 'ATTACHMENT_EXPIRED':
      return 'INVALID_REQUEST'
    default:
      if (status === 401 || status === 403) return 'AUTH'
      if (status === 404) return 'UNKNOWN_MODEL'
      if (status === 413 || status === 400 || status === 422) return 'INVALID_REQUEST'
      if (status === 429) return 'RATE_LIMIT'
      if (status === 504) return 'TIMEOUT'
      if (status === 503) return 'TRANSPORT'
      return 'SERVER'
  }
}

function retryAfterMs(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1_000
  const date = Date.parse(value)
  const delay = date - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
