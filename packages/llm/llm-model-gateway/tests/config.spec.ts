import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'

const base = {
  baseURL: 'https://gateway.internal',
  brokerSocketPath: '/run/dsh/runtime/10001/credential.sock',
  catalogCacheMs: 15_000,
  requestTimeoutMs: 180_000,
  streamIdleTimeoutMs: 90_000,
}

describe('Model Gateway configuration', () => {
  it('accepts only an HTTPS origin and an absolute local socket path', () => {
    expect(resolveConfig(base).baseURL).toBe('https://gateway.internal')
    expect(() => resolveConfig({ ...base, baseURL: 'http://gateway.internal' })).toThrow(/HTTPS origin/)
    expect(() => resolveConfig({ ...base, baseURL: 'https://gateway.internal/v1' })).toThrow(/HTTPS origin/)
    expect(() => resolveConfig({ ...base, brokerSocketPath: 'broker.sock' })).toThrow(/absolute Unix socket/)
  })
})
