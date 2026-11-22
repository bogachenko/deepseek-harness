import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as SingleAgentInitiator from '../src/index.ts'

function agent(id: string): Agent {
  return { id: brandString<SessionId>(id) } as Agent
}

async function harness(useExplicitProvider = true): Promise<{ service: AgentRegistry; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  if (useExplicitProvider) await ctx.plugin(SingleAgentInitiator)
  await ctx.plugin(AgentRegistry)
  return { service: ctx.agents, dispose: () => ctx.fiber.dispose() }
}

describe('single-Agent invocation scope', () => {
  it('uses the V8-compatible default when no provider is mounted', async () => {
    const { service, dispose } = await harness(false)
    const owner = agent('default-owner')
    const result = service.withInitiator(owner, () => service.requireInitiator())
    expect(result).toBe(owner)
    expect(service.currentInitiator()).toBeUndefined()
    await dispose()
  })

  it('preserves the exact Agent across nested and overlapping boundaries', async () => {
    const { service, dispose } = await harness()
    const owner = agent('owner')
    const release = Promise.withResolvers<void>()
    const outer = service.withInitiator(owner, async () => {
      expect(service.requireInitiator()).toBe(owner)
      const inner = service.withInitiator(owner, async () => {
        await release.promise
        expect(service.requireInitiator()).toBe(owner)
      })
      await Promise.resolve()
      expect(service.currentInitiator()).toBe(owner)
      release.resolve()
      await inner
    })
    await outer
    expect(service.currentInitiator()).toBeUndefined()
    await dispose()
  })

  it('rejects a second distinct Agent in the same invocation', async () => {
    const { service, dispose } = await harness()
    const first = agent('first')
    const second = agent('second')
    const release = Promise.withResolvers<void>()
    const pending = service.withInitiator(first, async () => { await release.promise })
    expect(() => service.withInitiator(second, () => undefined))
      .toThrow('only one active Agent is supported per invocation')
    release.resolve()
    await pending
    await dispose()
  })

  it('does not permit agentless work to overlap an Agent boundary', async () => {
    const { service, dispose } = await harness()
    const owner = agent('owner')
    const pending = service.withInitiator(owner, async () => { await Promise.resolve() })
    expect(() => service.withoutInitiator(() => undefined))
      .toThrow('cannot start an agentless boundary while an Agent is active in this invocation')
    await pending
    const direct = service.withoutInitiator(async () => {
      await Promise.resolve()
      expect(service.currentInitiator()).toBeUndefined()
      return 42
    })
    await expect(direct).resolves.toBe(42)
    await dispose()
  })

  it('drains the active Agent boundary before scope disposal', async () => {
    const { service, dispose } = await harness()
    const owner = agent('owner')
    const release = Promise.withResolvers<void>()
    const pending = service.withInitiator(owner, async () => {
      await release.promise
      expect(service.requireInitiator()).toBe(owner)
    })
    const disposal = dispose()
    await Promise.resolve()
    expect(() => service.withInitiator(owner, () => undefined))
      .toThrow('agent initiator scope is disposed')
    release.resolve()
    await pending
    await disposal
    expect(() => service.currentInitiator()).toThrow('agent initiator scope is disposed')
  })
})
