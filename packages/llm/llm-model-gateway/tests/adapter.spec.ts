import { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { ModelGatewayAdapter } from '../src/adapter.ts'
import { resolveConfig } from '../src/config.ts'

const config = resolveConfig({
  baseURL: 'https://gateway.internal',
  brokerSocketPath: '/run/dsh/runtime/10001/credential.sock',
  catalogCacheMs: 15_000,
  requestTimeoutMs: 30_000,
  streamIdleTimeoutMs: 10_000,
})

const catalog = {
  version: 1,
  models: [{
    id: 'provider/model:balanced',
    name: 'Balanced',
    inputModalities: ['text', 'image'],
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    reasoningEfforts: ['low', 'high'],
    supportsTools: true,
    supportsStreaming: true,
  }],
}

function sseResponse(): Response {
  const frames = [
    { version: 1, type: 'block-start', index: 0, blockType: 'text' },
    { version: 1, type: 'text-delta', index: 0, text: 'hello' },
    { version: 1, type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
    { version: 1, type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { version: 1, type: 'finish', reason: { kind: 'stop' } },
  ]
  const body = frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

function broker() {
  return {
    getToken: vi.fn().mockResolvedValue('dsh1.test.payload.signature'),
    invalidate: vi.fn(),
  }
}

function generationOptions(messages: RequestMessage[]): GenerateOptions {
  return {
    provider: 'model-gateway',
    model: 'provider/model:balanced',
    messages,
  }
}

describe('ModelGatewayAdapter', () => {
  it('discovers tenant models and translates generation requests to the Gateway only', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify(catalog), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/v1/generate')) return sseResponse()
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch
    const tokenBroker = broker()
    const adapter = new ModelGatewayAdapter(new Context(), config, {
      fetch: fetcher,
      broker: tokenBroker,
      resolveAttachments: () => undefined,
    })

    const prepared = await adapter.prepareCall('model-gateway', 'provider/model:balanced')
    expect(prepared.model.context).toEqual({ contextWindow: 128_000 })
    expect(prepared.model.defaultMaxTokens).toBe(8_192)
    expect(prepared.model.inputModalities).toEqual(['text', 'image'])
    expect(prepared.model.systemPromptUpdate).toBe('in-history')
    expect(prepared.model.toolUpdate).toBe('in-history')

    const output = []
    for await (const chunk of prepared.stream(generationOptions([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]))) output.push(chunk)

    expect(output.map(chunk => chunk.type)).toEqual([
      'block-start', 'text-delta', 'block-end', 'usage', 'finish',
    ])
    expect(calls.map(call => call.url)).toEqual([
      'https://gateway.internal/v1/models',
      'https://gateway.internal/v1/generate',
    ])

    const generation = calls[1]
    expect(generation.init.redirect).toBe('error')
    expect(new Headers(generation.init.headers).get('authorization')).toBe('Bearer dsh1.test.payload.signature')
    expect(new Headers(generation.init.headers).get('user-agent')).toMatch(/^deepseek-harness\//)
    const body = JSON.parse(String(generation.init.body)) as Record<string, unknown>
    expect(body.model).toBe('provider/model:balanced')
    expect(body).not.toHaveProperty('provider')
    expect(body).not.toHaveProperty('credential')
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])
    expect(tokenBroker.getToken).toHaveBeenCalledTimes(2)
  })

  it('preserves DSH tool history and only forwards referenced developer message ids', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/v1/models')) return new Response(JSON.stringify(catalog), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.endsWith('/v1/generate')) return sseResponse()
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch
    const adapter = new ModelGatewayAdapter(new Context(), config, {
      fetch: fetcher,
      broker: broker(),
      resolveAttachments: () => undefined,
    })
    const prepared = await adapter.prepareCall('model-gateway', 'provider/model:balanced')
    const tool = {
      name: 'search',
      description: 'Search the approved index',
      parameters: { type: 'object', properties: {} },
    }
    const developer = {
      id: 'dev-update-1',
      role: 'developer',
      content: [{ type: 'tool-addition', toolName: 'search' }],
      source: { kind: 'user' },
    } as unknown as RequestMessage
    const options = {
      ...generationOptions([
        { role: 'user', content: [{ type: 'text', text: 'search for this' }] },
        developer,
      ]),
      tools: [tool],
      toolHistory: {
        tools: [],
        updates: [{ messageId: 'dev-update-1', additions: [tool] }],
      },
    } as unknown as GenerateOptions

    for await (const chunk of prepared.stream(options)) void chunk

    const generation = calls.find(call => call.url.endsWith('/v1/generate'))
    const body = JSON.parse(String(generation?.init.body)) as {
      messages: Array<{ role: string; id?: string; content: Array<{ type: string; toolName?: string }> }>
      toolHistory: { updates: Array<{ messageId: string; additions: Array<{ name: string }> }> }
    }
    expect(body.messages[0]).toMatchObject({ role: 'user' })
    expect(body.messages[1]).toMatchObject({
      role: 'developer',
      id: 'dev-update-1',
      content: [{ type: 'tool-addition', toolName: 'search' }],
    })
    expect(body.toolHistory.updates[0]).toMatchObject({
      messageId: 'dev-update-1',
      additions: [{ name: 'search' }],
    })
  })

  it('uploads image bytes and validates the exact version-one attachment response', async () => {
    const localImage = {
      attachmentId: 'sha256:local-only-digest',
      mediaType: 'image/png',
      bytes: 3,
      width: 1,
      height: 1,
    } as unknown as ImageAttachmentRef
    const storedBytes = Uint8Array.from([1, 2, 3])
    const readImage = vi.fn().mockResolvedValue({ ref: localImage, data: storedBytes })
    const attachments = { readImage } as unknown as AttachmentStore
    const calls: Array<{ url: string; init: RequestInit }> = []
    let uploadedBytes: number[] = []
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify(catalog), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/v1/attachments/images')) {
        uploadedBytes = Array.from(init.body as Uint8Array)
        return new Response(JSON.stringify({
          version: 1,
          attachmentId: 'img_opaque-123',
          contentType: 'image/png',
          byteLength: 3,
          width: 1,
          height: 1,
          expiresAt,
        }), { status: 201, headers: { 'content-type': 'application/json; charset=utf-8' } })
      }
      if (url.endsWith('/v1/generate')) return sseResponse()
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch
    const adapter = new ModelGatewayAdapter(new Context(), config, {
      fetch: fetcher,
      broker: broker(),
      resolveAttachments: () => attachments,
    })
    const prepared = await adapter.prepareCall('model-gateway', 'provider/model:balanced')
    const imageMessage = {
      role: 'user',
      content: [{ type: 'image', attachment: localImage }],
    } as unknown as RequestMessage

    for await (const chunk of prepared.stream(generationOptions([imageMessage]))) void chunk

    expect(readImage).toHaveBeenCalledTimes(1)
    expect(Array.from(storedBytes)).toEqual([1, 2, 3])
    expect(uploadedBytes).toEqual([1, 2, 3])

    const upload = calls.find(call => call.url.endsWith('/v1/attachments/images'))
    expect(upload).toBeDefined()
    expect(new Headers(upload?.init.headers).get('content-type')).toBe('image/png')

    const generation = calls.find(call => call.url.endsWith('/v1/generate'))
    const body = JSON.parse(String(generation?.init.body)) as {
      messages: Array<{ content: Array<{ type: string; attachmentId?: string }> }>
    }
    expect(body.messages[0]?.content[0]).toEqual({ type: 'image', attachmentId: 'img_opaque-123' })
    expect(JSON.stringify(body)).not.toContain('sha256:local-only-digest')
  })

  it('rejects attachment responses with extra fields or a non-canonical expiry', async () => {
    const localImage = {
      attachmentId: 'sha256:local-only-digest',
      mediaType: 'image/png',
      bytes: 3,
      width: 1,
      height: 1,
    } as unknown as ImageAttachmentRef
    const attachments = {
      readImage: vi.fn().mockResolvedValue({ ref: localImage, data: Uint8Array.from([1, 2, 3]) }),
    } as unknown as AttachmentStore
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/v1/models')) return new Response(JSON.stringify(catalog), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.endsWith('/v1/attachments/images')) {
        return new Response(JSON.stringify({
          version: 1,
          attachmentId: 'img_opaque-123',
          contentType: 'image/png',
          byteLength: 3,
          width: 1,
          height: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          unexpected: true,
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch
    const adapter = new ModelGatewayAdapter(new Context(), config, {
      fetch: fetcher,
      broker: broker(),
      resolveAttachments: () => attachments,
    })
    const prepared = await adapter.prepareCall('model-gateway', 'provider/model:balanced')
    const imageMessage = {
      role: 'user',
      content: [{ type: 'image', attachment: localImage }],
    } as unknown as RequestMessage
    await expect(async () => {
      for await (const chunk of prepared.stream(generationOptions([imageMessage]))) void chunk
    }).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('rejects image upload metadata that does not match the uploaded image', async () => {
    const localImage = {
      attachmentId: 'sha256:local-only-digest',
      mediaType: 'image/png',
      bytes: 3,
      width: 1,
      height: 1,
    } as unknown as ImageAttachmentRef
    const attachments = {
      readImage: vi.fn().mockResolvedValue({ ref: localImage, data: Uint8Array.from([1, 2, 3]) }),
    } as unknown as AttachmentStore
    const validExpiry = new Date(Date.now() + 60_000).toISOString()
    const invalidResponses = [
      {
        name: 'non-canonical expiry',
        changes: { expiresAt: validExpiry.replace(/\.\d{3}Z$/, 'Z') },
      },
      {
        name: 'expired expiry',
        changes: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
      },
      {
        name: 'mismatched media type',
        changes: { contentType: 'image/jpeg' },
      },
      {
        name: 'mismatched byte length',
        changes: { byteLength: 4 },
      },
      {
        name: 'mismatched dimensions',
        changes: { width: 2 },
      },
    ] as const

    for (const invalid of invalidResponses) {
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/v1/models')) {
          return new Response(JSON.stringify(catalog), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        if (url.endsWith('/v1/attachments/images')) {
          return new Response(JSON.stringify({
            version: 1,
            attachmentId: 'img_opaque-123',
            contentType: 'image/png',
            byteLength: 3,
            width: 1,
            height: 1,
            expiresAt: validExpiry,
            ...invalid.changes,
          }), { status: 201, headers: { 'content-type': 'application/json' } })
        }
        return new Response('', { status: 404 })
      }) as unknown as typeof fetch
      const adapter = new ModelGatewayAdapter(new Context(), config, {
        fetch: fetcher,
        broker: broker(),
        resolveAttachments: () => attachments,
      })
      const prepared = await adapter.prepareCall('model-gateway', 'provider/model:balanced')
      const imageMessage = {
        role: 'user',
        content: [{ type: 'image', attachment: localImage }],
      } as unknown as RequestMessage

      await expect(async () => {
        for await (const chunk of prepared.stream(generationOptions([imageMessage]))) void chunk
      }).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    }
  })

  it('fails closed on Gateway authorization errors and never falls back to a provider', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify(catalog), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        version: 1,
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Workload token is invalid',
          retryable: false,
          requestId: 'gateway-request-1',
        },
      }), { status: 401, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const tokenBroker = broker()
    const adapter = new ModelGatewayAdapter(new Context(), config, {
      fetch: fetcher,
      broker: tokenBroker,
      resolveAttachments: () => undefined,
    })
    const prepared = await adapter.prepareCall('model-gateway', 'provider/model:balanced')

    await expect(async () => {
      for await (const chunk of prepared.stream(generationOptions([
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      ]))) void chunk
    }).rejects.toMatchObject({ code: 'AUTH' })

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(tokenBroker.invalidate).toHaveBeenCalledTimes(1)
  })
})
