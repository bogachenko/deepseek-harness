/**
 * Single-active-Agent initiator scope for isolated V8/serverless invocations.
 *
 * One invocation may attribute work to one Agent. Nested and overlapping
 * boundaries for that exact Agent are supported; a different Agent or an
 * agentless boundary cannot overlap it.
 *
 * @module @deepseek-ai/dsh-agent-initiator-single
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentInitiatorScope, AgentInitiatorScopeFactory } from '@deepseek-ai/dsh-agent'

class SingleAgentInitiatorScope implements AgentInitiatorScope {
  private state: 'active' | 'closing' | 'disposed' = 'active'
  private activeAgent: Agent | undefined
  private activeAgentRuns = 0
  private activeAgentlessRuns = 0
  private activeRuns = 0
  private drain: PromiseWithResolvers<void> | undefined
  private disposal: Promise<void> | undefined

  current(): Agent | undefined {
    this.assertReadable()
    return this.activeAgent
  }

  run<T>(agent: Agent | undefined, operation: () => T): T {
    if (this.state !== 'active') throw new Error('agent initiator scope is disposed')
    if (agent === undefined) {
      if (this.activeAgent !== undefined) {
        throw new Error('cannot start an agentless boundary while an Agent is active in this invocation')
      }
      this.activeAgentlessRuns += 1
    } else {
      if (this.activeAgentlessRuns !== 0) {
        throw new Error('cannot start an Agent boundary while an agentless operation is active in this invocation')
      }
      if (this.activeAgent !== undefined && this.activeAgent !== agent) {
        throw new Error('only one active Agent is supported per invocation')
      }
      this.activeAgent = agent
      this.activeAgentRuns += 1
    }
    this.activeRuns += 1

    let result: T
    try {
      result = operation()
    } catch (error: unknown) {
      this.release(agent)
      throw error
    }

    try {
      void Promise.prototype.then.call(
        result,
        () => { this.release(agent) },
        () => { this.release(agent) },
      )
    } catch {
      // Non-Promises and Promises whose species rejects observer creation are
      // treated as synchronous for ownership; the original return is untouched.
      this.release(agent)
    }
    return result
  }

  close(): void {
    if (this.state === 'active') this.state = 'closing'
  }

  dispose(): Promise<void> {
    return (this.disposal ??= (async () => {
      this.close()
      if (this.activeRuns !== 0) {
        this.drain ??= Promise.withResolvers<void>()
        await this.drain.promise
      }
      this.state = 'disposed'
      this.activeAgent = undefined
    })())
  }

  private assertReadable(): void {
    if (this.state === 'disposed') throw new Error('agent initiator scope is disposed')
  }

  private release(agent: Agent | undefined): void {
    if (agent === undefined) this.activeAgentlessRuns -= 1
    else {
      this.activeAgentRuns -= 1
      if (this.activeAgentRuns === 0) this.activeAgent = undefined
    }
    this.activeRuns -= 1
    if (this.activeRuns !== 0) return
    this.drain?.resolve()
    this.drain = undefined
  }
}

const factory: AgentInitiatorScopeFactory = {
  create: () => new SingleAgentInitiatorScope(),
}

/** Cordis plugin name. */
export const name = 'agent-initiator-single'

/** This provider has no service dependencies. */
export const inject: string[] = []

/** Provide a fresh single-Agent scope for every AgentRegistry lifecycle. */
export function apply(ctx: Context): void {
  ctx.provide('agentInitiatorScopeFactory', factory)
}
