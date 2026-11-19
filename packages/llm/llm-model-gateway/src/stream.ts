/** Strict SSE decoding for the versioned Model Gateway stream contract. */

import { ModelGatewayAdapterError, isNonNegativeSafeInteger, isRecord } from './transport.ts'
import type { ContentBlock, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'

type ReadResult = ReadableStreamReadResult<Uint8Array>

const MAX_BUFFER_BYTES = 1_048_576
const MAX_FRAME_BYTES = 1_048_576
const BLOCK_TYPES = new Set([
  'text',
  'reasoning',
  'tool-call',
  'image',
  'file',
  'tool-addition',
  'tool-removal',
])

/** Decode Gateway SSE frames and enforce the terminal StreamChunk boundary. */
export async function* parseGatewayStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  idleTimeoutMs: number,
): AsyncGenerator<StreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let dataLines: string[] = []
  let frameBytes = 0
  let terminal = false

  const processLine = (line: string): string | undefined => {
    if (line === '') {
      if (dataLines.length === 0) return undefined
      const data = dataLines.join('\n')
      dataLines = []
      frameBytes = 0
      return data
    }
    if (line.startsWith(':')) return undefined
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') {
      frameBytes += Buffer.byteLength(value, 'utf8') + 1
      if (frameBytes > MAX_FRAME_BYTES) throw malformed('Gateway SSE frame exceeded the permitted size')
      dataLines.push(value)
    }
    return undefined
  }

  const dispatch = (frame: string): StreamChunk => {
    const chunk = decodeChunk(frame)
    if (terminal) throw malformed('Gateway emitted a chunk after finish')
    if (chunk.type === 'finish') terminal = true
    return chunk
  }

  try {
    while (true) {
      const next = await readWithIdleTimeout(reader, signal, idleTimeoutMs)
      if (next.done) {
        buffer += decoder.decode()
        if (Buffer.byteLength(buffer, 'utf8') > MAX_BUFFER_BYTES) {
          throw malformed('Gateway SSE line exceeded the permitted size')
        }
        if (buffer.length > 0) {
          const finalLine = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
          const frame = processLine(finalLine)
          if (frame !== undefined) yield dispatch(frame)
        }
        if (dataLines.length > 0) {
          const finalFrame = dataLines.join('\n')
          dataLines = []
          frameBytes = 0
          yield dispatch(finalFrame)
        }
        break
      }

      buffer += decoder.decode(next.value, { stream: true })
      if (Buffer.byteLength(buffer, 'utf8') > MAX_BUFFER_BYTES) {
        throw malformed('Gateway SSE line exceeded the permitted size')
      }
      while (true) {
        const newline = findLineEnding(buffer)
        if (newline === undefined) break
        const { index, width } = newline
        if (buffer[index] === '\r' && index === buffer.length - 1) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + width)
        const frame = processLine(line)
        if (frame !== undefined) yield dispatch(frame)
      }
    }

    if (!terminal) throw new ModelGatewayAdapterError('Model Gateway stream ended without a finish chunk', 'STREAM_CLOSED')
  } catch (error) {
    if (error instanceof TypeError) {
      throw malformed('Model Gateway stream contained invalid UTF-8', error)
    }
    throw error
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function findLineEnding(value: string): { index: number; width: number } | undefined {
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '\n') return { index, width: 1 }
    if (char === '\r') {
      if (index + 1 === value.length) return undefined
      return { index, width: value[index + 1] === '\n' ? 2 : 1 }
    }
  }
  return undefined
}

function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ReadResult> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => finish(() => reject(signal.reason ?? new Error('Stream aborted')))
    timer = setTimeout(() => {
      finish(() => reject(new ModelGatewayAdapterError('Model Gateway stream remained idle beyond its deadline', 'TIMEOUT')))
    }, timeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    reader.read().then(
      result => finish(() => resolve(result)),
      error => finish(() => reject(error)),
    )
  })
}

function decodeContentBlock(value: unknown): ContentBlock {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw malformed('Model Gateway emitted an invalid block-end frame')
  }
  switch (value.type) {
    case 'text':
    case 'reasoning':
      if (typeof value.text !== 'string') throw malformed('Model Gateway emitted an invalid text block')
      return { type: value.type, text: value.text }
    case 'tool-call':
      if (
        typeof value.id !== 'string' ||
        value.id.length === 0 ||
        typeof value.name !== 'string' ||
        value.name.length === 0 ||
        typeof value.arguments !== 'string'
      ) throw malformed('Model Gateway emitted an invalid tool-call block')
      return {
        type: 'tool-call',
        id: value.id as ToolCallId,
        name: value.name,
        arguments: value.arguments,
      }
    case 'tool-addition':
    case 'tool-removal':
      if (typeof value.toolName !== 'string' || value.toolName.length === 0) {
        throw malformed('Model Gateway emitted an invalid tool update block')
      }
      return { type: value.type, toolName: value.toolName }
    case 'image':
    case 'file':
      throw malformed('Model Gateway cannot return Runtime-local image or file references in model output')
    default:
      throw malformed('Model Gateway emitted an unknown content block type')
  }
}

function decodeChunk(frame: string): StreamChunk {
  let value: unknown
  try {
    value = JSON.parse(frame)
  } catch (error) {
    throw malformed('Model Gateway emitted invalid SSE JSON', error)
  }
  if (!isRecord(value) || value.version !== 1 || typeof value.type !== 'string') {
    throw malformed('Model Gateway emitted an unsupported stream frame')
  }

  switch (value.type) {
    case 'block-start':
      if (
        !isNonNegativeSafeInteger(value.index) ||
        typeof value.blockType !== 'string' ||
        !BLOCK_TYPES.has(value.blockType)
      ) throw malformed('Model Gateway emitted an invalid block-start frame')
      return { type: 'block-start', index: value.index, blockType: value.blockType as ContentBlock['type'] }

    case 'text-delta':
    case 'reasoning-delta':
      if (!isNonNegativeSafeInteger(value.index) || typeof value.text !== 'string') {
        throw malformed('Model Gateway emitted an invalid text delta')
      }
      return { type: value.type, index: value.index, text: value.text }

    case 'tool-call-delta':
      if (
        !isNonNegativeSafeInteger(value.index) ||
        typeof value.id !== 'string' ||
        value.id.length === 0 ||
        (value.name !== undefined && typeof value.name !== 'string') ||
        typeof value.argumentsDelta !== 'string'
      ) throw malformed('Model Gateway emitted an invalid tool-call delta')
      return {
        type: 'tool-call-delta',
        index: value.index,
        id: value.id as ToolCallId,
        ...(value.name === undefined ? {} : { name: value.name }),
        argumentsDelta: value.argumentsDelta,
      }

    case 'block-end':
      if (!isNonNegativeSafeInteger(value.index)) {
        throw malformed('Model Gateway emitted an invalid block-end index')
      }
      return { type: 'block-end', index: value.index, block: decodeContentBlock(value.block) }

    case 'usage':
      if (
        !isRecord(value.usage) ||
        !isNonNegativeSafeInteger(value.usage.inputTokens) ||
        !isNonNegativeSafeInteger(value.usage.outputTokens) ||
        (value.usage.totalTokens !== undefined && !isNonNegativeSafeInteger(value.usage.totalTokens)) ||
        (value.usage.cacheReadTokens !== undefined && !isNonNegativeSafeInteger(value.usage.cacheReadTokens)) ||
        (value.usage.cacheWriteTokens !== undefined && !isNonNegativeSafeInteger(value.usage.cacheWriteTokens)) ||
        (value.usage.reasoningTokens !== undefined && !isNonNegativeSafeInteger(value.usage.reasoningTokens))
      ) throw malformed('Model Gateway emitted invalid token usage')
      return { type: 'usage', usage: value.usage } as unknown as StreamChunk

    case 'finish':
      if (!isRecord(value.reason) || typeof value.reason.kind !== 'string') {
        throw malformed('Model Gateway emitted an invalid finish reason')
      }
      if (!['stop', 'tool-calls', 'max-tokens', 'aborted', 'error'].includes(value.reason.kind)) {
        throw malformed('Model Gateway emitted an unsupported finish reason')
      }
      if (
        (value.reason.kind === 'error' || value.reason.kind === 'aborted') &&
        (!isRecord(value.reason.failure) ||
          typeof value.reason.failure.code !== 'string' ||
          typeof value.reason.failure.message !== 'string')
      ) throw malformed('Model Gateway emitted an invalid terminal failure')
      if (
        value.replayState !== undefined &&
        (!isRecord(value.replayState) ||
          !Object.prototype.hasOwnProperty.call(value.replayState, 'response') ||
          (value.replayState.blocks !== undefined && !Array.isArray(value.replayState.blocks)))
      ) throw malformed('Model Gateway emitted invalid replay metadata')
      return {
        type: 'finish',
        reason: value.reason,
        ...(value.replayState === undefined ? {} : { replayState: value.replayState }),
      } as unknown as StreamChunk

    default:
      throw malformed('Model Gateway emitted an unknown stream chunk type')
  }
}

function malformed(message: string, cause?: unknown): ModelGatewayAdapterError {
  return new ModelGatewayAdapterError(message, 'MALFORMED_RESPONSE', cause === undefined ? {} : { cause })
}
