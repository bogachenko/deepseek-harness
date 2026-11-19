import { generateKeyPairSync, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  issueWorkloadToken,
  verifyWorkloadToken,
  WorkloadIdentityError,
  WORKLOAD_TOKEN_MAX_LIFETIME_SECONDS,
} from '../src/index.ts'

const ISSUER = 'https://control.example.test'
const AUDIENCE = 'dsh-tool-gateway'
const KEY_ID = 'control-2026-01'
const NOW = 1_800_000_000

const signingKeys = generateKeyPairSync('ed25519')
const otherKeys = generateKeyPairSync('ed25519')
const publicKeys = new Map<string, string | KeyObject>([[KEY_ID, signingKeys.publicKey.export({
  format: 'pem',
  type: 'spki',
}).toString()]])

const identity = {
  tenantId: 'tenant_123',
  agentId: 'agent_456',
  runtimeId: 'runtime_789',
  capabilities: ['crm.read', 'email.send'],
} as const

function issue(overrides: Partial<Parameters<typeof issueWorkloadToken>[1]> = {}): string {
  return issueWorkloadToken(identity, {
    privateKey: signingKeys.privateKey,
    keyId: KEY_ID,
    issuer: ISSUER,
    audience: AUDIENCE,
    nowSeconds: NOW,
    ...overrides,
  })
}

function verify(token: string, overrides: Partial<Parameters<typeof verifyWorkloadToken>[1]> = {}) {
  return verifyWorkloadToken(token, {
    publicKeys,
    issuer: ISSUER,
    audience: AUDIENCE,
    nowSeconds: NOW,
    ...overrides,
  })
}

function signedPayload(payload: Record<string, unknown>, privateKey = signingKeys.privateKey): string {
  const segment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const input = 'dsh-wid-v1.' + KEY_ID + '.' + segment
  const signature = sign(null, Buffer.from(input, 'utf8'), privateKey).toString('base64url')
  return input + '.' + signature
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    iss: ISSUER,
    aud: AUDIENCE,
    tenantId: identity.tenantId,
    agentId: identity.agentId,
    runtimeId: identity.runtimeId,
    capabilities: ['crm.read', 'email.send'],
    jti: '550e8400-e29b-41d4-a716-446655440000',
    iat: NOW,
    exp: NOW + WORKLOAD_TOKEN_MAX_LIFETIME_SECONDS,
    ...overrides,
  }
}

function expectInvalid(operation: () => unknown): void {
  let caught: unknown
  try {
    operation()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(WorkloadIdentityError)
  expect(caught).toMatchObject({ code: 'WORKLOAD_TOKEN_INVALID' })
}

describe('workload identity tokens', () => {
  it('issues and verifies a short-lived tenant, agent, and runtime identity', () => {
    const token = issue()
    const verified = verify(token)
    expect(verified).toMatchObject({
      v: 1,
      iss: ISSUER,
      aud: AUDIENCE,
      tenantId: identity.tenantId,
      agentId: identity.agentId,
      runtimeId: identity.runtimeId,
      capabilities: ['crm.read', 'email.send'],
      iat: NOW,
      exp: NOW + WORKLOAD_TOKEN_MAX_LIFETIME_SECONDS,
      keyId: KEY_ID,
    })
    expect(verified.jti).toMatch(/^[0-9a-f-]{36}$/i)
    expect(Object.isFrozen(verified)).toBe(true)
    expect(Object.isFrozen(verified.capabilities)).toBe(true)
  })

  it('sorts capabilities and does not retain the caller-owned array', () => {
    const capabilities = ['email.send', 'crm.read']
    const token = issueWorkloadToken({ ...identity, capabilities }, {
      privateKey: signingKeys.privateKey,
      keyId: KEY_ID,
      issuer: ISSUER,
      audience: AUDIENCE,
      nowSeconds: NOW,
    })
    capabilities.push('platform.admin')
    expect(verify(token).capabilities).toEqual(['crm.read', 'email.send'])
  })

  it('accepts a retiring public key by key id and rejects an unknown key id', () => {
    const token = issue({ keyId: 'retiring-key', privateKey: otherKeys.privateKey })
    const retiringKeys = new Map(publicKeys)
    retiringKeys.set('retiring-key', otherKeys.publicKey)
    expect(verifyWorkloadToken(token, {
      publicKeys: retiringKeys,
      issuer: ISSUER,
      audience: AUDIENCE,
      nowSeconds: NOW,
    }).keyId).toBe('retiring-key')
    expectInvalid(() => verify(token))
  })

  it('rejects a token signed by a different private key', () => {
    const token = issue({ privateKey: otherKeys.privateKey })
    expectInvalid(() => verify(token))
  })

  it('rejects a modified signature and malformed compact token', () => {
    const token = issue()
    const signature = token.split('.')[3] ?? ''
    const modified = token.slice(0, -1) + (signature.endsWith('A') ? 'B' : 'A')
    expectInvalid(() => verify(modified))
    expectInvalid(() => verify('dsh-wid-v1.only-two-parts'))
    expectInvalid(() => verify(token + '.extra'))
  })

  it('rejects the wrong issuer and audience', () => {
    const token = issue()
    expectInvalid(() => verify(token, { issuer: 'https://other.example.test' }))
    expectInvalid(() => verify(token, { audience: 'another-service' }))
  })

  it('rejects expired and not-yet-valid tokens', () => {
    const token = issue()
    expectInvalid(() => verify(token, { nowSeconds: NOW + WORKLOAD_TOKEN_MAX_LIFETIME_SECONDS + 31 }))
    expectInvalid(() => verify(token, { nowSeconds: NOW - 31 }))
  })

  it('rejects a signed token whose lifetime exceeds the platform maximum', () => {
    expectInvalid(() => verify(signedPayload(payload({
      exp: NOW + WORKLOAD_TOKEN_MAX_LIFETIME_SECONDS + 1,
    }))))
  })

  it('rejects duplicate, unsorted, malformed, or excessive capability claims', () => {
    expectInvalid(() => verify(signedPayload(payload({ capabilities: ['crm.read', 'crm.read'] }))))
    expectInvalid(() => verify(signedPayload(payload({ capabilities: ['email.send', 'crm.read'] }))))
    expectInvalid(() => verify(signedPayload(payload({ capabilities: ['Platform.Admin'] }))))
    const excessive = Array.from({ length: 65 }, (_, index) => 'tool.' + String(index).padStart(3, '0'))
    expectInvalid(() => verify(signedPayload(payload({ capabilities: excessive }))))
  })

  it('rejects unknown claims and non-canonical JSON even with a valid signature', () => {
    expectInvalid(() => verify(signedPayload(payload({ admin: true }))))
    const nonCanonical = JSON.stringify(payload()).replace('"v":1,', '"v": 1,')
    const segment = Buffer.from(nonCanonical, 'utf8').toString('base64url')
    const input = 'dsh-wid-v1.' + KEY_ID + '.' + segment
    const signature = sign(null, Buffer.from(input, 'utf8'), signingKeys.privateKey).toString('base64url')
    expectInvalid(() => verify(input + '.' + signature))
  })

  it('rejects identities that would produce an oversized token', () => {
    const longCapabilities = Array.from(
      { length: 64 },
      (_, index) => 'tool.' + String(index).padStart(3, '0') + 'x'.repeat(120),
    )
    expect(() => issueWorkloadToken({ ...identity, capabilities: longCapabilities }, {
      privateKey: signingKeys.privateKey,
      keyId: KEY_ID,
      issuer: ISSUER,
      audience: AUDIENCE,
      nowSeconds: NOW,
    })).toThrowError(WorkloadIdentityError)
  })

  it('rejects invalid identity values and duplicate capabilities at issuance', () => {
    expect(() => issueWorkloadToken({ ...identity, tenantId: '../other-tenant' }, {
      privateKey: signingKeys.privateKey,
      keyId: KEY_ID,
      issuer: ISSUER,
      audience: AUDIENCE,
      nowSeconds: NOW,
    })).toThrowError(WorkloadIdentityError)
    expect(() => issueWorkloadToken({ ...identity, capabilities: ['crm.read', 'crm.read'] }, {
      privateKey: signingKeys.privateKey,
      keyId: KEY_ID,
      issuer: ISSUER,
      audience: AUDIENCE,
      nowSeconds: NOW,
    })).toThrowError(WorkloadIdentityError)
  })

  it('rejects non-Ed25519 keys and invalid verifier configuration', () => {
    expect(() => issue({ privateKey: otherKeys.publicKey })).toThrowError(WorkloadIdentityError)
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    expect(() => issue({ privateKey: rsa.privateKey })).toThrowError(WorkloadIdentityError)
    expect(() => verify(issue(), {
      publicKeys: new Map([[KEY_ID, signingKeys.privateKey]]),
    })).toThrowError(WorkloadIdentityError)
    const privatePem = signingKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    expect(() => verify(issue(), {
      publicKeys: new Map([[KEY_ID, privatePem]]),
    })).toThrowError(WorkloadIdentityError)
    expect(() => verifyWorkloadToken(issue(), {
      publicKeys: new Map(),
      issuer: ISSUER,
      audience: AUDIENCE,
      clockToleranceSeconds: 61,
    })).toThrowError(WorkloadIdentityError)
  })
})
