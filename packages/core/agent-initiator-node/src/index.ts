/**
 * Node.js implementation of the DSH Agent initiator scope.
 *
 * @module @deepseek-ai/dsh-agent-initiator-node
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { isPromise } from 'node:util/types'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentInitiatorScope, AgentInitiatorScopeFactory } from '@deepseek-ai/dsh-agent'

interface InitiatorRun {
  active: boolean
  readonly parent: InitiatorRun | undefined
}

/** Tracks Agent attribution across Node.js asynchronous continuations. */
class NodeAgentInitiatorScope implements AgentInitiatorScope {
  private readonly initiators = new AsyncLocalStorage<Agent | undefined>()
  private readonly runs = new AsyncLocalStorage<InitiatorRun>()
  private state: 'active' | 'closing' | 'disposed' = 'active'
  private activeRuns = 0
  private drain: PromiseWithResolvers<void> | undefined
  private disposal: Promise<void> | undefined

  current(): Agent | undefined {
    this.assertReadable()
    return this.initiators.getStore()
  }

  run<T>(agent: Agent | undefined, operation: () => T): T {
    if (this.state !== 'active') throw new Error('agent initiator scope is disposed')
    const run: InitiatorRun = { active: true, parent: this.runs.getStore() }
    this.activeRuns += 1
    let result: T
    try {
      result = this.runs.run(run, () => this.initiators.run(agent, operation))
    } catch (error: unknown) {
      this.release(run)
      throw error
    }
    if (isPromise(result)) {
      try {
        void Promise.prototype.then.call(
          result,
          () => { this.release(run) },
          () => { this.release(run) },
        )
      } catch {
        this.release(run)
      }
    } else {
      this.release(run)
    }
    return result
  }

  close(): void {
    if (this.state === 'active') this.state = 'closing'
  }

  dispose(): Promise<void> {
    return (this.disposal ??= (async () => {
      this.close()
      this.releaseReentrantRuns()
      if (this.activeRuns !== 0) {
        this.drain ??= Promise.withResolvers<void>()
        await this.drain.promise
      }
      this.state = 'disposed'
      this.initiators.disable()
      this.runs.disable()
    })())
  }

  private assertReadable(): void {
    if (this.state === 'disposed') throw new Error('agent initiator scope is disposed')
  }

  private releaseReentrantRuns(): void {
    let run = this.runs.getStore()
    while (run !== undefined) {
      this.release(run)
      run = run.parent
    }
  }

  private release(run: InitiatorRun): void {
    if (!run.active) return
    run.active = false
    this.activeRuns -= 1
    if (this.activeRuns !== 0) return
    this.drain?.resolve()
    this.drain = undefined
  }
}

const factory: AgentInitiatorScopeFactory = {
  create: () => new NodeAgentInitiatorScope(),
}

/** Cordis plugin name. */
export const name = 'agent-initiator-node'

/** This provider has no service dependencies. */
export const inject: string[] = []

/** Provide a fresh Node.js scope for every AgentRegistry lifecycle. */
export function apply(ctx: Context): void {
  ctx.provide('agentInitiatorScopeFactory', factory)
}
