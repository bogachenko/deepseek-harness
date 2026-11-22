/**
 * Explicit single-Agent initiator provider for isolated V8/serverless invocations.
 *
 * @module @deepseek-ai/dsh-agent-initiator-single
 */

import type { Context } from '@deepseek-ai/cordis'
import { singleAgentInitiatorScopeFactory } from '@deepseek-ai/dsh-agent'

/** Cordis plugin name. */
export const name = 'agent-initiator-single'

/** This provider has no service dependencies. */
export const inject: string[] = []

/** Select the V8-compatible single-Agent strategy for each AgentRegistry. */
export function apply(ctx: Context): void {
  ctx.provide('agentInitiatorScopeFactory', singleAgentInitiatorScopeFactory)
}
