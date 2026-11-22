---
description: "Node.js AsyncLocalStorage provider for DSH Agent attribution when multiple agents or agentless background work share one process."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-initiator-node

## Summary

Provide the Node.js implementation of the Agent initiator scope. It uses `AsyncLocalStorage` to preserve each exact Agent across independent overlapping asynchronous driver chains, nested boundaries, and explicit `withoutInitiator()` boundaries. The standard `dsh-base` and `dsh-sdk-minimal` bundles mount this provider.

## Use this package

Mount it in Node.js compositions before Agent execution:

```yaml
- name: '@deepseek-ai/dsh-agent-initiator-node'
- name: '@deepseek-ai/dsh-agent'
```

The provider publishes `agentInitiatorScopeFactory`; `dsh-agent` creates one scope instance for each AgentRegistry lifecycle. Applications should normally consume it through `ctx.agents`, not instantiate the scope directly.

## Runtime contract

- Distinct Agents can execute concurrently without sharing ambient identity.
- Nested Agent boundaries restore the parent after synchronous return, rejection, or Promise settlement.
- `withoutInitiator()` hides inherited attribution for shared timers, queues, and background services.
- Teardown rejects new boundaries and drains returned Promise lifetimes before disabling async storage.
- Ambient identity is attribution only, never authorization; worker, persistence, HTTP, and wire boundaries still carry explicit identity.

## Known limitations

This package imports Node.js built-ins and must not be included in Telegram Serverless or another runtime without Node.js `async_hooks` and `util/types`. Use `@deepseek-ai/dsh-agent-initiator-single` for an isolated V8 invocation that owns one active Agent.

## Source map

| File | Role |
|---|---|
| `src/index.ts` | AsyncLocalStorage-backed scope factory and Cordis plugin |
