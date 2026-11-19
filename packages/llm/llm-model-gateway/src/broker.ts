/** Runtime-side client for the local Credential Broker line protocol. */

import { createConnection } from 'node:net'
import { ModelGatewayAdapterError } from './transport.ts'

const AUDIENCE = 'dsh-model-gateway'
const REQUEST_TIMEOUT_MS = 5_000
const MAX_RESPONSE_BYTES = 16_384
const MAX_TOKEN_BYTES = 8_192
const TOKEN_LIFETIME_SECONDS = 300
const TOKEN_REFRESH_SKEW_MS = 60_000

interface CachedToken {
  readonly value: string
  readonly expiresAtMs: number
}

/**
 * Issues one newline-delimited request over the private Unix socket.
 * Tokens are cached only in this object's memory and never written to disk.
 */
export class CredentialBrokerClient {
  private cached: CachedToken | undefined
  private pending: Promise<CachedToken> | undefined

  constructor(private readonly socketPath: string) {}

  /** Return a currently usable token, refreshing it before its expiry. */
  async getToken(): Promise<string> {
    if (this.cached !== undefined && this.cached.expiresAtMs > Date.now() + TOKEN_REFRESH_SKEW_MS) {
      return this.cached.value
    }
    if (this.pending !== undefined) return (await this.pending).value

    const pending = this.requestToken()
    this.pending = pending
    try {
      const token = await pending
      if (token.expiresAtMs > Date.now() + TOKEN_REFRESH_SKEW_MS) this.cached = token
      return token.value
    } finally {
      if (this.pending === pending) this.pending = undefined
    }
  }

  /** Drop the in-memory token after an authentication rejection. */
  invalidate(): void {
    this.cached = undefined
  }

  private requestToken(): Promise<CachedToken> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath })
      let buffer = ''
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const finish = (error?: Error, token?: CachedToken): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        socket.removeAllListeners('connect')
        socket.removeAllListeners('data')
        socket.removeAllListeners('end')
        socket.removeAllListeners('error')
        socket.destroy()
        if (error !== undefined) reject(error)
        else if (token !== undefined) resolve(token)
        else reject(new ModelGatewayAdapterError('Credential Broker returned an empty response', 'TRANSPORT'))
      }

      timer = setTimeout(() => {
        finish(new ModelGatewayAdapterError('Credential Broker did not respond before the 5-second deadline', 'TIMEOUT'))
      }, REQUEST_TIMEOUT_MS)

      socket.once('connect', () => {
        socket.write(JSON.stringify({
          version: 1,
          operation: 'get_workload_token',
          audience: AUDIENCE,
        }) + '\n')
      })

      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        if (Buffer.byteLength(buffer, 'utf8') > MAX_RESPONSE_BYTES) {
          finish(new ModelGatewayAdapterError('Credential Broker response exceeded the permitted size', 'MALFORMED_RESPONSE'))
          return
        }
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline)
        if (buffer.slice(newline + 1).trim() !== '') {
          finish(new ModelGatewayAdapterError('Credential Broker returned more than one response line', 'MALFORMED_RESPONSE'))
          return
        }

        let value: unknown
        try {
          value = JSON.parse(line)
        } catch (error) {
          finish(new ModelGatewayAdapterError('Credential Broker returned invalid JSON', 'MALFORMED_RESPONSE', { cause: error }))
          return
        }

        if (!isRecord(value) || value.version !== 1) {
          finish(new ModelGatewayAdapterError('Credential Broker returned an unsupported response', 'MALFORMED_RESPONSE'))
          return
        }
        if (typeof value.error === 'string') {
          const code = value.error === 'FORBIDDEN' ? 'AUTH' : 'TRANSPORT'
          finish(new ModelGatewayAdapterError(
            value.error === 'FORBIDDEN'
              ? 'Credential Broker refused to issue a Model Gateway token'
              : 'Credential Broker could not issue a Model Gateway token',
            code,
          ))
          return
        }
        if (
          typeof value.token !== 'string' ||
          value.token.length === 0 ||
          Buffer.byteLength(value.token, 'utf8') > MAX_TOKEN_BYTES ||
          /[\r\n\t ]/.test(value.token) ||
          typeof value.expiresAt !== 'number' ||
          !Number.isSafeInteger(value.expiresAt)
        ) {
          finish(new ModelGatewayAdapterError('Credential Broker returned an invalid workload token', 'MALFORMED_RESPONSE'))
          return
        }

        const nowSeconds = Math.floor(Date.now() / 1_000)
        if (value.expiresAt <= nowSeconds || value.expiresAt > nowSeconds + TOKEN_LIFETIME_SECONDS) {
          finish(new ModelGatewayAdapterError('Credential Broker returned a token with an invalid lifetime', 'MALFORMED_RESPONSE'))
          return
        }
        finish(undefined, { value: value.token, expiresAtMs: value.expiresAt * 1_000 })
      })

      socket.once('end', () => {
        if (!settled) finish(new ModelGatewayAdapterError('Credential Broker closed the socket without a complete response', 'MALFORMED_RESPONSE'))
      })
      socket.once('error', () => {
        finish(new ModelGatewayAdapterError('Credential Broker socket is unavailable', 'TRANSPORT'))
      })
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
