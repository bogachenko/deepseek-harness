import { describe, expect, it } from 'vitest'
import { parseGatewayStream } from '../src/stream.ts'

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
}

async function collect(chunks: string[]) {
  const output = []
  for await (const chunk of parseGatewayStream(
    streamFrom(chunks),
    new AbortController().signal,
    1_000,
  )) output.push(chunk)
  return output
}

describe('Model Gateway SSE decoder', () => {
  it('decodes split CRLF frames and maps DSH content blocks', async () => {
    const start = 'data: {"version":1,"type":"block-start","index":0,"blockType":"text"}\r'
    const rest = '\ndata: {"version":1,"type":"block-end","index":0,"block":{"type":"text","text":"ok"}}\r\n\r\n'
      + 'data: {"version":1,"type":"finish","reason":{"kind":"stop"}}\r\n\r\n'
    const chunks = await collect([start, rest])
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'block-end', 'finish'])
    expect(chunks[1]).toMatchObject({ block: { type: 'text', text: 'ok' } })
  })

  it('dispatches a final data frame when the connection closes without a blank line', async () => {
    const chunks = await collect([
      'data: {"version":1,"type":"finish","reason":{"kind":"stop"}}',
    ])
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })

  it('rejects streams without a terminal finish chunk', async () => {
    await expect(collect([
      'data: {"version":1,"type":"text-delta","index":0,"text":"partial"}\n\n',
    ])).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('rejects a Gateway image block instead of passing a remote id as a Runtime attachment', async () => {
    await expect(collect([
      'data: {"version":1,"type":"block-end","index":0,"block":{"type":"image","attachmentId":"remote-image"}}\n\n',
      'data: {"version":1,"type":"finish","reason":{"kind":"stop"}}\n\n',
    ])).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
})
