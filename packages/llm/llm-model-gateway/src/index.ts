/** Cordis plugin that routes the model-gateway provider exclusively through the SaaS Gateway. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import { Config, resolveConfig } from './config.ts'
import { ModelGatewayAdapter } from './adapter.ts'

export { Config } from './config.ts'
export { CredentialBrokerClient } from './broker.ts'
export { ModelGatewayAdapter } from './adapter.ts'
export type { ModelGatewayAdapterDependencies } from './adapter.ts'
export const name = 'llm-model-gateway'
export const inject = ['llm', 'attachments']

const PROVIDER = 'model-gateway'

export function apply(ctx: Context, config: Config): void {
  ctx.llm.registerAdapter([PROVIDER], new ModelGatewayAdapter(ctx, resolveConfig(config)))
}

export default apply
