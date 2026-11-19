/** Provider-neutral DSH adapter for the tenant-scoped Model Gateway. */

import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-attachment'
import {
  HarnessError,
  LlmAdapter,
  attributionHeaders,
  offloadedImageText,
  projectFilesToText,
  projectImagesForTextModel,
  projectOffloadedImages,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ReasoningEffortId,
  RequestMessage,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { CredentialBrokerClient } from './broker.ts'
import type { ResolvedConfig } from './config.ts'
import {
  ModelGatewayAdapterError,
  createAbortScope,
  isPositiveSafeInteger,
  isRecord,
  parseGatewayError,
  readJsonResponse,
} from './transport.ts'
import { parseGatewayStream } from './stream.ts'

const MAX_CATALOG_BYTES = 1_048_576
const MAX_ATTACHMENT_RESPONSE_BYTES = 32_768
const MAX_IMAGE_CACHE_ENTRIES = 1_024

interface ModelDescriptor {
  readonly id: string
  readonly name: string
  readonly inputModalities: readonly ('text' | 'image')[]
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly reasoningEfforts: readonly string[]
  readonly supportsTools: boolean
  readonly supportsStreaming: boolean
}

interface GatewayImageMetadata {
  readonly version: 1
  readonly attachmentId: string
  readonly contentType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
  readonly byteLength: number
  readonly width: number
  readonly height: number
  readonly expiresAt: string
}

interface CachedImage {
  readonly attachmentId: string
  readonly expiresAt: number
}

interface GatewayMessage {
  role: string
  content: Record<string, unknown>[]
  id?: string
  toolCallId?: string
  isError?: boolean
  replayState?: { response: unknown; blocks?: readonly unknown[] }
}

interface GatewayGenerateRequest {
  version: 1
  model: string
  messages: GatewayMessage[]
  system?: string
  tools?: ToolSchema[]
  toolHistory?: {
    tools: ToolSchema[]
    updates: Array<{ messageId: string; additions: ToolSchema[] }>
  }
  parameters?: {
    temperature?: number
    maxTokens?: number
    stop?: string[]
    reasoningEffort?: string
  }
  purpose?: string
  sessionId?: string
}

export interface ModelGatewayAdapterDependencies {
  /** Injectable only to make the transport boundary deterministic in tests. */
  fetch?: typeof fetch
  /** The current Runtime attachment store; local paths and bytes never cross the Gateway API. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Injectable Broker client for tests; production uses the private socket client. */
  broker?: Pick<CredentialBrokerClient, 'getToken' | 'invalidate'>
}

/** Adapter whose only model egress is the configured HTTPS Model Gateway. */
export class ModelGatewayAdapter extends LlmAdapter {
  private readonly fetcher: typeof fetch
  private readonly broker: Pick<CredentialBrokerClient, 'getToken' | 'invalidate'>
  private readonly resolveAttachments: () => AttachmentStore | undefined
  private catalogCache: { readonly expiresAt: number; readonly models: Map<string, ModelDescriptor> } | undefined
  private readonly uploadedImages = new Map<string, CachedImage>()

  constructor(
    ctx: Context,
    private readonly config: ResolvedConfig,
    dependencies: ModelGatewayAdapterDependencies = {},
  ) {
    super()
    this.fetcher = dependencies.fetch ?? fetch
    this.broker = dependencies.broker ?? new CredentialBrokerClient(config.brokerSocketPath)
    this.resolveAttachments = dependencies.resolveAttachments ?? (() => ctx.get('attachments'))
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Model Gateway' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const catalog = await this.catalog()
    return [...catalog.values()].map(model => this.modelInfo(provider, model))
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const descriptor = await this.requireModel(model, signal)
    return this.modelInfo(provider, descriptor)
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const descriptor = await this.requireModel(model, signal)
    const modelInfo = this.modelInfo(provider, descriptor)
    return {
      model: modelInfo,
      stream: options => this.generate(options, descriptor),
    }
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const descriptor = await this.requireModel(options.model, options.signal)
    yield* this.generate(options, descriptor)
  }

  private modelInfo(provider: string, model: ModelDescriptor): LlmResolvedModelInfo {
    return {
      provider,
      id: model.id,
      name: model.name,
      inputModalities: [...model.inputModalities],
      context: { contextWindow: model.contextWindow },
      defaultMaxTokens: model.maxOutputTokens,
      systemPromptUpdate: 'in-history',
      ...(model.supportsTools ? { toolUpdate: 'in-history' as const } : {}),
      ...(model.reasoningEfforts.length === 0
        ? {}
        : {
          reasoning: {
            efforts: model.reasoningEfforts.map(effort => ({
              id: effort as ReasoningEffortId,
              name: effort,
            })),
          },
        }),
    }
  }

  private async requireModel(model: string, signal?: AbortSignal): Promise<ModelDescriptor> {
    signal?.throwIfAborted()
    const catalog = await this.catalog(signal)
    signal?.throwIfAborted()
    const descriptor = catalog.get(model)
    if (descriptor === undefined) {
      throw new ModelGatewayAdapterError('Model Gateway does not offer model "' + model + '" to this Runtime', 'UNKNOWN_MODEL')
    }
    if (!descriptor.supportsStreaming) {
      throw new ModelGatewayAdapterError('Model Gateway model "' + model + '" does not support streaming', 'UNSUPPORTED_CONTENT')
    }
    return descriptor
  }

  private async catalog(signal?: AbortSignal): Promise<Map<string, ModelDescriptor>> {
    if (this.catalogCache !== undefined && this.catalogCache.expiresAt > Date.now()) {
      return this.catalogCache.models
    }
    const scope = createAbortScope(signal, this.config.requestTimeoutMs, 'Model Gateway catalog request timed out')
    try {
      const token = await this.broker.getToken()
      scope.signal.throwIfAborted()
      const response = await this.fetcher(this.config.baseURL + '/v1/models', {
        method: 'GET',
        signal: scope.signal,
        redirect: 'error',
        headers: {
          ...attributionHeaders(),
          authorization: 'Bearer ' + token,
          accept: 'application/json',
        },
      })
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) this.broker.invalidate()
        throw await parseGatewayError(response)
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/json') {
        throw new ModelGatewayAdapterError('Model Gateway returned a non-JSON model catalog', 'MALFORMED_RESPONSE', { status: response.status })
      }
      const value = await readJsonResponse(response, MAX_CATALOG_BYTES)
      const models = parseCatalog(value)
      const catalog = new Map(models.map(model => [model.id, model]))
      if (this.config.catalogCacheMs > 0) {
        this.catalogCache = { models: catalog, expiresAt: Date.now() + this.config.catalogCacheMs }
      }
      return catalog
    } catch (error) {
      throw this.normalizeTransportError(error, scope.signal, signal)
    } finally {
      scope.dispose()
    }
  }

  private async *generate(options: GenerateOptions, model: ModelDescriptor): AsyncGenerator<StreamChunk> {
    const scope = createAbortScope(options.signal, this.config.requestTimeoutMs, 'Model Gateway generation timed out')
    try {
      const projected = projectFilesToText(options.messages, () => undefined)
      const modelMessages = model.inputModalities.includes('image')
        ? projectOffloadedImages(projected, offloadedImageText)
        : projectImagesForTextModel(projected)
      this.assertCapabilities(options, model, modelMessages)

      const retainedUpdateIds = new Set((options.toolHistory?.updates ?? []).map(update => String(update.messageId)))
      const messages = await this.serializeMessages(modelMessages, scope.signal, retainedUpdateIds)
      if (messages.length === 0) {
        throw new ModelGatewayAdapterError('Model Gateway requests require at least one message', 'INVALID_REQUEST')
      }
      const body = buildGenerateRequest(options, messages)
      const token = await this.broker.getToken()
      scope.signal.throwIfAborted()
      const response = await this.fetcher(this.config.baseURL + '/v1/generate', {
        method: 'POST',
        signal: scope.signal,
        redirect: 'error',
        headers: {
          ...attributionHeaders(),
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) this.broker.invalidate()
        throw await parseGatewayError(response)
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'text/event-stream') {
        throw new ModelGatewayAdapterError('Model Gateway returned a non-SSE generation response', 'MALFORMED_RESPONSE', { status: response.status })
      }
      if (response.body === null) {
        throw new ModelGatewayAdapterError('Model Gateway returned no generation stream', 'EMPTY_RESPONSE', { status: response.status })
      }
      yield* parseGatewayStream(response.body, scope.signal, this.config.streamIdleTimeoutMs)
    } catch (error) {
      throw this.normalizeTransportError(error, scope.signal, options.signal)
    } finally {
      scope.dispose()
    }
  }

  private normalizeTransportError(error: unknown, signal: AbortSignal, parent?: AbortSignal): HarnessError {
    if (error instanceof HarnessError) return error
    if (signal.aborted) {
      if (signal.reason instanceof HarnessError) return signal.reason
      if (parent?.aborted === true) {
        return new ModelGatewayAdapterError('Model Gateway request was aborted', 'ABORTED', { cause: error })
      }
    }
    return new ModelGatewayAdapterError('Model Gateway transport failed', 'TRANSPORT', { cause: error })
  }

  private assertCapabilities(
    options: GenerateOptions,
    model: ModelDescriptor,
    messages: readonly RequestMessage[],
  ): void {
    const hasImages = messages.some(message => message.content.some(block => block.type === 'image'))
    if (hasImages && !model.inputModalities.includes('image')) {
      throw new ModelGatewayAdapterError('The selected Model Gateway model does not accept images', 'UNSUPPORTED_CONTENT')
    }
    const hasText = (options.system?.length ?? 0) > 0 || messages.some(message =>
      message.content.some(block => block.type === 'text' || block.type === 'reasoning'),
    )
    if (hasText && !model.inputModalities.includes('text')) {
      throw new ModelGatewayAdapterError('The selected Model Gateway model does not accept text', 'UNSUPPORTED_CONTENT')
    }
    const hasTools = (options.tools?.length ?? 0) > 0 ||
      (options.toolHistory?.tools.length ?? 0) > 0 ||
      (options.toolHistory?.updates.some(update => update.additions.length > 0) ?? false) ||
      messages.some(message =>
        message.role === 'tool' ||
        message.content.some(block =>
          block.type === 'tool-call' || block.type === 'tool-addition' || block.type === 'tool-removal',
        ),
      )
    if (hasTools && !model.supportsTools) {
      throw new ModelGatewayAdapterError('The selected Model Gateway model does not support tools', 'UNSUPPORTED_CONTENT')
    }
    if (
      options.reasoningEffort !== undefined &&
      !model.reasoningEfforts.includes(String(options.reasoningEffort))
    ) {
      throw new ModelGatewayAdapterError('The selected Model Gateway model does not support the requested reasoning effort', 'UNSUPPORTED_REASONING_EFFORT')
    }
    if (options.maxTokens !== undefined && options.maxTokens > model.maxOutputTokens) {
      throw new ModelGatewayAdapterError('Requested maxTokens exceeds the Model Gateway model output limit', 'INVALID_MODEL_MAX_TOKENS')
    }
  }

  private async serializeMessages(
    messages: readonly RequestMessage[],
    signal: AbortSignal,
    retainedUpdateIds: ReadonlySet<string>,
  ): Promise<GatewayMessage[]> {
    const result: GatewayMessage[] = []
    for (const message of messages) {
      const content: Record<string, unknown>[] = []
      for (const block of message.content) {
        switch (block.type) {
          case 'text':
          case 'reasoning':
            content.push({ type: block.type, text: block.text })
            break
          case 'image':
            content.push({
              type: 'image',
              attachmentId: await this.uploadImage(block.attachment, signal),
            })
            break
          case 'file':
            throw new ModelGatewayAdapterError('A file block reached Model Gateway serialization without Runtime projection', 'UNSUPPORTED_CONTENT')
          case 'tool-call':
            content.push({
              type: 'tool-call',
              id: String(block.id),
              name: block.name,
              arguments: block.arguments,
            })
            break
          case 'tool-addition':
          case 'tool-removal':
            content.push({ type: block.type, toolName: block.toolName })
            break
          default:
            throw new ModelGatewayAdapterError('Model Gateway cannot serialize this DSH content block', 'UNSUPPORTED_CONTENT')
        }
      }

      const item: GatewayMessage = { role: message.role, content }
      if (message.role === 'developer' && retainedUpdateIds.has(String(message.id))) {
        item.id = String(message.id)
      }
      if (message.role === 'tool') {
        item.toolCallId = String(message.toolCallId)
        if (message.isError !== undefined) item.isError = message.isError
      }
      if (message.role === 'assistant' && message.source.replayState !== undefined) {
        const replay = message.source.replayState
        if (
          !isRecord(replay) ||
          !Object.prototype.hasOwnProperty.call(replay, 'response') ||
          (replay.blocks !== undefined && !Array.isArray(replay.blocks))
        ) {
          throw new ModelGatewayAdapterError('Assistant message contains invalid provider replay metadata', 'INVALID_REPLAY_STATE')
        }
        item.replayState = {
          response: replay.response,
          ...(replay.blocks === undefined ? {} : { blocks: replay.blocks }),
        }
      }
      result.push(item)
    }
    return result
  }

  private async uploadImage(ref: ImageAttachmentRef, signal: AbortSignal): Promise<string> {
    const key = String(ref.attachmentId)
    const cached = this.uploadedImages.get(key)
    if (cached !== undefined && cached.expiresAt > Date.now() + 5_000) return cached.attachmentId
    if (cached !== undefined) this.uploadedImages.delete(key)

    const attachments = this.resolveAttachments()
    if (attachments === undefined) {
      throw new ModelGatewayAdapterError('Model Gateway image upload requires the Runtime attachment store', 'UNSUPPORTED_CONTENT')
    }

    const stored = await attachments.readImage(ref, signal)
    const bytes = Buffer.from(stored.data)
    try {
      if (
        String(stored.ref.attachmentId) !== key ||
        stored.ref.mediaType !== ref.mediaType ||
        stored.ref.bytes !== ref.bytes ||
        stored.ref.width !== ref.width ||
        stored.ref.height !== ref.height ||
        bytes.byteLength === 0 ||
        bytes.byteLength !== ref.bytes
      ) {
        throw new ModelGatewayAdapterError('Runtime attachment bytes do not match the durable image reference', 'INVALID_REQUEST')
      }
      const token = await this.broker.getToken()
      signal.throwIfAborted()
      const response = await this.fetcher(this.config.baseURL + '/v1/attachments/images', {
        method: 'POST',
        signal,
        redirect: 'error',
        headers: {
          ...attributionHeaders(),
          authorization: 'Bearer ' + token,
          'content-type': ref.mediaType,
          accept: 'application/json',
        },
        body: bytes,
      })
      if (response.status !== 201) {
        if (response.status === 401 || response.status === 403) this.broker.invalidate()
        if (!response.ok) throw await parseGatewayError(response)
        throw new ModelGatewayAdapterError('Model Gateway image upload did not return HTTP 201 Created', 'MALFORMED_RESPONSE', { status: response.status })
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/json') {
        throw new ModelGatewayAdapterError('Model Gateway image upload returned a non-JSON response', 'MALFORMED_RESPONSE', { status: response.status })
      }
      const value = await readJsonResponse(response, MAX_ATTACHMENT_RESPONSE_BYTES)
      const metadata = parseImageMetadata(value)
      if (
        metadata.contentType !== ref.mediaType ||
        metadata.byteLength !== bytes.byteLength ||
        metadata.width !== ref.width ||
        metadata.height !== ref.height ||
        Date.parse(metadata.expiresAt) <= Date.now()
      ) {
        throw new ModelGatewayAdapterError('Model Gateway returned image metadata inconsistent with the uploaded bytes', 'MALFORMED_RESPONSE')
      }
      this.uploadedImages.set(key, {
        attachmentId: metadata.attachmentId,
        expiresAt: Date.parse(metadata.expiresAt),
      })
      if (this.uploadedImages.size > MAX_IMAGE_CACHE_ENTRIES) {
        const oldest = this.uploadedImages.keys().next().value
        if (oldest !== undefined) this.uploadedImages.delete(oldest)
      }
      return metadata.attachmentId
    } finally {
      bytes.fill(0)
    }
  }
}

function parseCatalog(value: unknown): readonly ModelDescriptor[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.models)) {
    throw new ModelGatewayAdapterError('Model Gateway returned an invalid model catalog', 'MALFORMED_RESPONSE')
  }
  const ids = new Set<string>()
  const models: ModelDescriptor[] = []
  for (const item of value.models) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.id) ||
      typeof item.name !== 'string' ||
      item.name.length === 0 ||
      item.name.length > 256 ||
      !Array.isArray(item.inputModalities) ||
      item.inputModalities.some(modality => modality !== 'text' && modality !== 'image') ||
      !isPositiveSafeInteger(item.contextWindow) ||
      !isPositiveSafeInteger(item.maxOutputTokens) ||
      !Array.isArray(item.reasoningEfforts) ||
      item.reasoningEfforts.some(effort => typeof effort !== 'string' || effort.length === 0 || effort.length > 64) ||
      new Set(item.reasoningEfforts).size !== item.reasoningEfforts.length ||
      typeof item.supportsTools !== 'boolean' ||
      typeof item.supportsStreaming !== 'boolean' ||
      ids.has(item.id)
    ) {
      throw new ModelGatewayAdapterError('Model Gateway model catalog contains an invalid or duplicate model entry', 'MALFORMED_RESPONSE')
    }
    ids.add(item.id)
    models.push({
      id: item.id,
      name: item.name,
      inputModalities: item.inputModalities as ('text' | 'image')[],
      contextWindow: item.contextWindow,
      maxOutputTokens: item.maxOutputTokens,
      reasoningEfforts: item.reasoningEfforts as string[],
      supportsTools: item.supportsTools,
      supportsStreaming: item.supportsStreaming,
    })
  }
  return models
}

function parseImageMetadata(value: unknown): GatewayImageMetadata {
  const fields = ['version', 'attachmentId', 'contentType', 'byteLength', 'width', 'height', 'expiresAt']
  if (
    !isRecord(value) ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some(key => !fields.includes(key)) ||
    value.version !== 1 ||
    typeof value.attachmentId !== 'string' ||
    value.attachmentId.length === 0 ||
    Buffer.byteLength(value.attachmentId, 'utf8') > 256 ||
    /[\u0000-\u0020\u007f]/.test(value.attachmentId) ||
    !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(String(value.contentType)) ||
    !isPositiveSafeInteger(value.byteLength) ||
    !isPositiveSafeInteger(value.width) ||
    !isPositiveSafeInteger(value.height) ||
    typeof value.expiresAt !== 'string' ||
    !isCanonicalIsoUtc(value.expiresAt)
  ) {
    throw new ModelGatewayAdapterError('Model Gateway returned invalid image attachment metadata', 'MALFORMED_RESPONSE')
  }
  return value as unknown as GatewayImageMetadata
}

function isCanonicalIsoUtc(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function buildGenerateRequest(options: GenerateOptions, messages: GatewayMessage[]): GatewayGenerateRequest {
  const body: GatewayGenerateRequest = {
    version: 1,
    model: options.model,
    messages,
  }
  if (options.system !== undefined && options.system.length > 0) body.system = options.system
  if (options.tools !== undefined && options.tools.length > 0) {
    body.tools = options.tools.map(tool => ({
      ...(tool.deferLoading === true ? { deferLoading: true as const } : {}),
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
  }
  if (options.toolHistory !== undefined) {
    body.toolHistory = {
      tools: options.toolHistory.tools.map(tool => ({
        ...(tool.deferLoading === true ? { deferLoading: true as const } : {}),
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      updates: options.toolHistory.updates.map(update => ({
        messageId: String(update.messageId),
        additions: update.additions.map(tool => ({
          ...(tool.deferLoading === true ? { deferLoading: true as const } : {}),
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      })),
    }
  }
  const parameters: NonNullable<GatewayGenerateRequest['parameters']> = {}
  if (options.temperature !== undefined) parameters.temperature = options.temperature
  if (options.maxTokens !== undefined) parameters.maxTokens = options.maxTokens
  if (options.stop !== undefined) parameters.stop = options.stop
  if (options.reasoningEffort !== undefined) parameters.reasoningEffort = String(options.reasoningEffort)
  if (Object.keys(parameters).length > 0) body.parameters = parameters
  if (options.purpose !== undefined) body.purpose = options.purpose
  if (options.sessionId !== undefined) body.sessionId = String(options.sessionId)
  return body
}
