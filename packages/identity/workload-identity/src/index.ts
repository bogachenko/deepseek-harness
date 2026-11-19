/**
 * Ed25519-signed, short-lived identities for tenant-scoped agent runtimes.
 *
 * The issuer keeps the private key in the Control Plane. Runtime services
 * receive only public keys and can verify tokens but cannot mint identities.
 * The token is a bearer credential: keep it out of logs, prompts, tool
 * arguments, and artifacts.
 *
 * @module @deepseek-ai/dsh-workload-identity
 */
import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign as signBytes,
  verify as verifySignature,
} from 'node:crypto'
import type { KeyObject } from 'node:crypto'

/** Maximum lifetime accepted for one workload token, in seconds. */
export const WORKLOAD_TOKEN_MAX_LIFETIME_SECONDS = 300

/** Default allowance for clock drift when checking token timestamps, in seconds. */
export const WORKLOAD_TOKEN_CLOCK_TOLERANCE_SECONDS = 30

const TOKEN_PREFIX = 'dsh-wid-v1'
const MAX_TOKEN_BYTES = 8192
const MAX_CAPABILITIES = 64
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CAPABILITY_PATTERN = /^[a-z][a-z0-9:._-]{0,127}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PAYLOAD_KEYS = ['v', 'iss', 'aud', 'tenantId', 'agentId', 'runtimeId', 'capabilities', 'jti', 'iat', 'exp'] as const

/** Stable error codes returned by the workload-token API. */
export type WorkloadIdentityErrorCode =
  | 'WORKLOAD_TOKEN_INVALID'
  | 'WORKLOAD_TOKEN_CONFIGURATION_INVALID'

/** A safe, stable failure from workload-token issuance or verification. */
export class WorkloadIdentityError extends Error {
  /** Stable machine-readable failure code. */
  readonly code: WorkloadIdentityErrorCode

  /**
   * @param code - Stable failure code.
   */
  constructor(code: WorkloadIdentityErrorCode) {
    super(
      code === 'WORKLOAD_TOKEN_INVALID'
        ? 'Invalid workload identity token'
        : 'Invalid workload identity configuration',
    )
    this.name = 'WorkloadIdentityError'
    this.code = code
  }
}

/** Tenant and agent identity assigned by the trusted Control Plane. */
export interface WorkloadIdentity {
  /** Stable tenant identifier from the platform's authenticated tenant record. */
  readonly tenantId: string
  /** Stable agent identifier owned by the tenant. */
  readonly agentId: string
  /** Unique runtime instance identifier. */
  readonly runtimeId: string
  /** Capabilities granted to this runtime by server-side policy. */
  readonly capabilities: readonly string[]
}

/** Signed workload claims. The key id is taken from the signed token envelope. */
export interface VerifiedWorkloadIdentity extends WorkloadIdentity {
  /** Token issuer configured by the Control Plane. */
  readonly iss: string
  /** Exact service audience for which the token was issued. */
  readonly aud: string
  /** Token format version. */
  readonly v: 1
  /** Unique token identifier. */
  readonly jti: string
  /** Issuance time in Unix seconds. */
  readonly iat: number
  /** Expiration time in Unix seconds. */
  readonly exp: number
  /** Identifier of the public key that verified this token. */
  readonly keyId: string
}

/** Inputs required to issue one workload token. */
export interface IssueWorkloadTokenOptions {
  /** Private Ed25519 key in PEM form or as a Node KeyObject. */
  readonly privateKey: string | KeyObject
  /** Public key identifier used for rotation. */
  readonly keyId: string
  /** Issuer identifier, normally the platform Control Plane. */
  readonly issuer: string
  /** Exact service audience that may accept this token. */
  readonly audience: string
  /** Token lifetime; defaults to five minutes and cannot exceed that limit. */
  readonly lifetimeSeconds?: number
  /** Unix time override for deterministic tests. Omit in production. */
  readonly nowSeconds?: number
}

/** Inputs required to verify a workload token. */
export interface VerifyWorkloadTokenOptions {
  /** Trusted Ed25519 public keys indexed by their key identifiers. */
  readonly publicKeys: ReadonlyMap<string, string | KeyObject>
  /** Expected issuer. */
  readonly issuer: string
  /** Expected audience; must match exactly. */
  readonly audience: string
  /** Unix time override for deterministic tests. Omit in production. */
  readonly nowSeconds?: number
  /** Allowed clock drift, from zero through sixty seconds. Defaults to thirty. */
  readonly clockToleranceSeconds?: number
}

interface TokenPayload {
  readonly v: 1
  readonly iss: string
  readonly aud: string
  readonly tenantId: string
  readonly agentId: string
  readonly runtimeId: string
  readonly capabilities: readonly string[]
  readonly jti: string
  readonly iat: number
  readonly exp: number
}

function invalidToken(): WorkloadIdentityError {
  return new WorkloadIdentityError('WORKLOAD_TOKEN_INVALID')
}

function invalidConfiguration(): WorkloadIdentityError {
  return new WorkloadIdentityError('WORKLOAD_TOKEN_CONFIGURATION_INVALID')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertText(value: unknown, maxLength: number): asserts value is string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw invalidConfiguration()
  }
}

function assertIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw invalidConfiguration()
  }
}

function assertKeyId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !KEY_ID_PATTERN.test(value)) throw invalidConfiguration()
}

function assertNowSeconds(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidConfiguration()
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value)
  if (actual.length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) {
    throw invalidToken()
  }
}

function loadPrivateKey(value: string | KeyObject): KeyObject {
  try {
    const key = typeof value === 'string' ? createPrivateKey(value) : value
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw invalidConfiguration()
    return key
  } catch (error) {
    if (error instanceof WorkloadIdentityError) throw error
    throw invalidConfiguration()
  }
}

function loadPublicKey(value: string | KeyObject): KeyObject {
  try {
    if (typeof value === 'string') {
      try {
        createPrivateKey(value)
        throw invalidConfiguration()
      } catch (error) {
        if (error instanceof WorkloadIdentityError) throw error
      }
    }
    const key = typeof value === 'string' ? createPublicKey(value) : value
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') throw invalidConfiguration()
    return key
  } catch (error) {
    if (error instanceof WorkloadIdentityError) throw error
    throw invalidConfiguration()
  }
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalidToken()
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) throw invalidToken()
  return decoded
}

function validateIssuerAudience(issuer: unknown, audience: unknown): void {
  assertText(issuer, 256)
  assertText(audience, 256)
}

function normalizeIdentity(identity: WorkloadIdentity): Pick<TokenPayload, 'tenantId' | 'agentId' | 'runtimeId' | 'capabilities'> {
  if (!isRecord(identity)) throw invalidConfiguration()
  const expected = ['tenantId', 'agentId', 'runtimeId', 'capabilities']
  if (Object.keys(identity).length !== expected.length
    || expected.some(key => !Object.hasOwn(identity, key))) {
    throw invalidConfiguration()
  }
  assertIdentifier(identity.tenantId)
  assertIdentifier(identity.agentId)
  assertIdentifier(identity.runtimeId)
  if (!Array.isArray(identity.capabilities) || identity.capabilities.length > MAX_CAPABILITIES) {
    throw invalidConfiguration()
  }
  const capabilities = [...identity.capabilities]
  for (const capability of capabilities) {
    if (typeof capability !== 'string' || !CAPABILITY_PATTERN.test(capability)) {
      throw invalidConfiguration()
    }
  }
  capabilities.sort()
  if (new Set(capabilities).size !== capabilities.length) throw invalidConfiguration()
  return {
    tenantId: identity.tenantId,
    agentId: identity.agentId,
    runtimeId: identity.runtimeId,
    capabilities: Object.freeze(capabilities),
  }
}

function parsePayload(value: unknown): TokenPayload {
  if (!isRecord(value)) throw invalidToken()
  assertExactKeys(value, PAYLOAD_KEYS)
  if (value.v !== 1) throw invalidToken()
  if (typeof value.iss !== 'string' || typeof value.aud !== 'string') throw invalidToken()
  try {
    assertText(value.iss, 256)
    assertText(value.aud, 256)
  } catch {
    throw invalidToken()
  }
  if (typeof value.tenantId !== 'string' || !IDENTIFIER_PATTERN.test(value.tenantId)
    || typeof value.agentId !== 'string' || !IDENTIFIER_PATTERN.test(value.agentId)
    || typeof value.runtimeId !== 'string' || !IDENTIFIER_PATTERN.test(value.runtimeId)) {
    throw invalidToken()
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length > MAX_CAPABILITIES) {
    throw invalidToken()
  }
  const capabilities: string[] = []
  let previous: string | undefined
  for (const capability of value.capabilities) {
    if (typeof capability !== 'string' || !CAPABILITY_PATTERN.test(capability)
      || (previous !== undefined && previous >= capability)) {
      throw invalidToken()
    }
    capabilities.push(capability)
    previous = capability
  }
  if (typeof value.jti !== 'string' || !UUID_V4_PATTERN.test(value.jti)) throw invalidToken()
  if (typeof value.iat !== 'number' || typeof value.exp !== 'number'
    || !Number.isSafeInteger(value.iat) || value.iat < 0
    || !Number.isSafeInteger(value.exp) || value.exp <= value.iat) {
    throw invalidToken()
  }
  return {
    v: 1,
    iss: value.iss,
    aud: value.aud,
    tenantId: value.tenantId,
    agentId: value.agentId,
    runtimeId: value.runtimeId,
    capabilities: Object.freeze(capabilities),
    jti: value.jti,
    iat: value.iat,
    exp: value.exp,
  }
}

/**
 * Issue one compact DSH workload token using an Ed25519 private key.
 *
 * Identity and capabilities must come from authenticated platform state,
 * never from model arguments. Deliver the bearer token only to its intended
 * runtime or gateway.
 *
 * @param identity - Tenant, agent, runtime, and server-granted capabilities.
 * @param options - Signing key, key id, issuer, audience, and lifetime.
 * @returns A compact signed workload token.
 */
export function issueWorkloadToken(
  identity: WorkloadIdentity,
  options: IssueWorkloadTokenOptions,
): string {
  if (options === null || typeof options !== 'object') throw invalidConfiguration()
  validateIssuerAudience(options.issuer, options.audience)
  assertKeyId(options.keyId)
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  assertNowSeconds(nowSeconds)
  const lifetimeSeconds = options.lifetimeSeconds ?? WORKLOAD_TOKEN_MAX_LIFETIME_SECONDS
  if (!Number.isSafeInteger(lifetimeSeconds)
    || lifetimeSeconds < 1
    || lifetimeSeconds > WORKLOAD_TOKEN_MAX_LIFETIME_SECONDS
    || !Number.isSafeInteger(nowSeconds + lifetimeSeconds)) {
    throw invalidConfiguration()
  }
  const normalized = normalizeIdentity(identity)
  const payload: TokenPayload = {
    v: 1,
    iss: options.issuer,
    aud: options.audience,
    tenantId: normalized.tenantId,
    agentId: normalized.agentId,
    runtimeId: normalized.runtimeId,
    capabilities: normalized.capabilities,
    jti: randomUUID(),
    iat: nowSeconds,
    exp: nowSeconds + lifetimeSeconds,
  }
  const payloadSegment = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signingInput = TOKEN_PREFIX + '.' + options.keyId + '.' + payloadSegment
  const signature = signBytes(null, Buffer.from(signingInput, 'utf8'), loadPrivateKey(options.privateKey))
  const token = signingInput + '.' + encodeBase64Url(signature)
  if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) throw invalidConfiguration()
  return token
}

/**
 * Verify a workload token's signature, issuer, audience, identity, and time bounds.
 *
 * Every token-validation failure uses the same error code so callers do not
 * expose a parsing, key-selection, or claim-validation oracle to the caller.
 * Invalid server key configuration remains a distinct operator error.
 *
 * @param token - Compact DSH workload bearer token.
 * @param options - Trusted public keys and expected issuer/audience.
 * @returns Frozen, verified workload identity claims.
 */
export function verifyWorkloadToken(
  token: string,
  options: VerifyWorkloadTokenOptions,
): VerifiedWorkloadIdentity {
  if (options === null || typeof options !== 'object'
    || options.publicKeys === null || typeof options.publicKeys?.get !== 'function') {
    throw invalidConfiguration()
  }
  validateIssuerAudience(options.issuer, options.audience)
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  assertNowSeconds(nowSeconds)
  const clockToleranceSeconds = options.clockToleranceSeconds ?? WORKLOAD_TOKEN_CLOCK_TOLERANCE_SECONDS
  if (!Number.isSafeInteger(clockToleranceSeconds)
    || clockToleranceSeconds < 0
    || clockToleranceSeconds > 60) {
    throw invalidConfiguration()
  }
  if (typeof token !== 'string' || token.length === 0 || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
    throw invalidToken()
  }
  const parts = token.split('.')
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) throw invalidToken()
  const keyId = parts[1]
  const payloadSegment = parts[2]
  const signatureSegment = parts[3]
  if (keyId === undefined || !KEY_ID_PATTERN.test(keyId)
    || payloadSegment === undefined || signatureSegment === undefined) {
    throw invalidToken()
  }
  const keyMaterial = options.publicKeys.get(keyId)
  if (keyMaterial === undefined) throw invalidToken()
  const publicKey = loadPublicKey(keyMaterial)
  const signature = decodeBase64Url(signatureSegment)
  if (signature.length !== 64) throw invalidToken()
  const signingInput = TOKEN_PREFIX + '.' + keyId + '.' + payloadSegment
  let signatureIsValid = false
  try {
    signatureIsValid = verifySignature(
      null,
      Buffer.from(signingInput, 'utf8'),
      publicKey,
      signature,
    )
  } catch {
    throw invalidToken()
  }
  if (!signatureIsValid) throw invalidToken()

  let payloadText: string
  let parsed: unknown
  try {
    payloadText = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(payloadSegment))
    parsed = JSON.parse(payloadText) as unknown
  } catch {
    throw invalidToken()
  }
  const payload = parsePayload(parsed)
  if (JSON.stringify(payload) !== payloadText) throw invalidToken()
  if (payload.iss !== options.issuer || payload.aud !== options.audience) throw invalidToken()
  if (payload.exp - payload.iat > WORKLOAD_TOKEN_MAX_LIFETIME_SECONDS) throw invalidToken()
  if (payload.iat > nowSeconds + clockToleranceSeconds
    || payload.exp <= nowSeconds - clockToleranceSeconds) {
    throw invalidToken()
  }
  return Object.freeze({
    ...payload,
    capabilities: Object.freeze([...payload.capabilities]),
    keyId,
  })
}
