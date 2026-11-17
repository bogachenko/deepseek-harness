import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createWorkloadIdentityToolGuard,
  isVerifiedWorkloadIdentity,
  issueWorkloadToken,
  verifyWorkloadToken,
} from '../src/index.ts'
import type {
  WorkloadIdentity,
  WorkloadIdentityBinding,
  WorkloadIdentityToolGuardOptions,
} from '../src/index.ts'

const ISSUER = 'https://control.example.test'
const AUDIENCE = 'dsh-tool-gateway'
const KEY_ID = 'control-2026-01'
const NOW = 1_800_000_000
const keys = generateKeyPairSync('ed25519')
const publicKeys = new Map([[KEY_ID, keys.publicKey]])

const claims: WorkloadIdentity = {
  tenantId: 'tenant_123',
  agentId: 'agent_456',
  runtimeId: 'runtime_789',
  capabilities: ['crm.read'],
}

function verifiedIdentity(
  identity: WorkloadIdentity = claims,
  issuer = ISSUER,
  audience = AUDIENCE,
) {
  const token = issueWorkloadToken(identity, {
    privateKey: keys.privateKey,
    keyId: KEY_ID,
    issuer,
    audience,
    nowSeconds: NOW,
  })
  return verifyWorkloadToken(token, {
    publicKeys,
    issuer,
    audience,
    nowSeconds: NOW,
  })
}

function binding(
  identity = verifiedIdentity(),
  overrides: Partial<WorkloadIdentityBinding> = {},
): WorkloadIdentityBinding {
  return {
    identity,
    tenantId: identity.tenantId,
    runtimeId: identity.runtimeId,
    ...overrides,
  }
}

function createGuard(
  resolveBinding: WorkloadIdentityToolGuardOptions['resolveBinding'] = () => binding(),
  requiredCapability: WorkloadIdentityToolGuardOptions['requiredCapability'] = name =>
    name === 'crm.read' ? 'crm.read' : undefined,
  nowSeconds: () => number = () => NOW,
) {
  return createWorkloadIdentityToolGuard({
    issuer: ISSUER,
    audience: AUDIENCE,
    resolveBinding,
    requiredCapability,
    nowSeconds,
  })
}

function denied(
  guard: ReturnType<typeof createGuard>,
  code: string,
  agentId = claims.agentId,
  toolName = 'crm.read',
): void {
  expect(guard({ name: toolName, agent: { id: agentId } })).toMatchObject({
    reason: 'workload identity is not authorized to execute this tool',
    info: { name: 'WorkloadIdentityAuthorizationError', code },
  })
}

describe('workload identity tool guard', () => {
  it('allows a tool only when the verified tenant, agent, runtime, audience, and capability match', () => {
    const identity = verifiedIdentity()
    const guard = createGuard(agentId => agentId === identity.agentId ? binding(identity) : undefined)

    expect(isVerifiedWorkloadIdentity(identity)).toBe(true)
    expect(guard({ name: 'crm.read', agent: { id: identity.agentId } })).toBeUndefined()
  })

  it('rejects calls without an Agent or an active identity binding', () => {
    const guard = createGuard(() => undefined)

    expect(guard({ name: 'crm.read' })).toMatchObject({
      info: { code: 'WORKLOAD_IDENTITY_REQUIRED' },
    })
    denied(guard, 'WORKLOAD_IDENTITY_REQUIRED')
  })

  it('does not accept a structurally copied identity as verified', () => {
    const identity = verifiedIdentity()
    const copied = Object.freeze({ ...identity })
    expect(isVerifiedWorkloadIdentity(copied)).toBe(false)

    const guard = createGuard(() => binding(copied as typeof identity))
    denied(guard, 'WORKLOAD_IDENTITY_REQUIRED')
  })

  it('rejects a tenant, Agent, or runtime binding mismatch', () => {
    const identity = verifiedIdentity()
    denied(createGuard(() => binding(identity, { tenantId: 'tenant_other' })),
      'WORKLOAD_IDENTITY_BINDING_INVALID')
    denied(createGuard(() => binding(identity, { runtimeId: 'runtime_other' })),
      'WORKLOAD_IDENTITY_BINDING_INVALID')
    denied(createGuard(() => binding(identity)), 'WORKLOAD_IDENTITY_BINDING_INVALID',
      'agent_other')
  })

  it('rejects identities issued for another issuer or audience', () => {
    const wrongIssuer = verifiedIdentity(claims, 'https://other-control.example', AUDIENCE)
    const wrongAudience = verifiedIdentity(claims, ISSUER, 'another-service')
    denied(createGuard(() => binding(wrongIssuer)),
      'WORKLOAD_IDENTITY_ISSUER_INVALID')
    denied(createGuard(() => binding(wrongAudience)),
      'WORKLOAD_IDENTITY_AUDIENCE_INVALID')
  })

  it('rejects an identity as soon as its expiration time is reached', () => {
    const identity = verifiedIdentity()
    denied(createGuard(() => binding(identity), undefined, () => NOW + 300),
      'WORKLOAD_IDENTITY_EXPIRED')
  })

  it('requires an explicit tool-to-capability mapping and the granted capability', () => {
    const identity = verifiedIdentity()
    denied(createGuard(() => binding(identity), () => undefined),
      'WORKLOAD_CAPABILITY_UNMAPPED', claims.agentId, 'crm.write')
    denied(createGuard(() => binding(identity), () => 'crm.write'),
      'WORKLOAD_CAPABILITY_DENIED', claims.agentId, 'crm.write')
  })

  it('fails closed when the binding, capability policy, or clock fails', () => {
    const identity = verifiedIdentity()
    denied(createGuard(() => { throw new Error('database unavailable') }),
      'WORKLOAD_POLICY_UNAVAILABLE')
    denied(createGuard(() => binding(identity), () => { throw new Error('policy unavailable') }),
      'WORKLOAD_POLICY_UNAVAILABLE')
    denied(createGuard(() => binding(identity), () => 'crm.read', () => Number.NaN),
      'WORKLOAD_POLICY_UNAVAILABLE')
  })
})
