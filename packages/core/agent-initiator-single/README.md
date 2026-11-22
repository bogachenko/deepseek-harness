---
description: "V8-compatible Agent initiator provider for isolated serverless invocations that execute one active Agent at a time."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-initiator-single

## Summary

Select the V8-compatible, single-active-Agent initiator strategy for an isolated serverless invocation. It contains no Node.js built-ins. The same strategy is the fallback built into `dsh-agent` when no provider is mounted.

## Use this package

Mount it in the Serverless composition instead of `@deepseek-ai/dsh-agent-initiator-node`:

```yaml
- name: '@deepseek-ai/dsh-agent-initiator-single'
- name: '@deepseek-ai/dsh-agent'
- name: '@deepseek-ai/dsh-agent-loop'
```

The provider publishes `agentInitiatorScopeFactory`; `dsh-agent` creates a fresh scope for each AgentRegistry lifecycle.

## Invocation contract

- One invocation owns one active Agent.
- Nested and overlapping initiator boundaries for that exact Agent are supported.
- A second distinct Agent is rejected while the first Agent is active.
- `withoutInitiator()` is allowed only when no Agent boundary is active; it cannot hide one async chain while another continues using the Agent.
- Agentless direct operations may run before or after the Agent boundary, but may not overlap it.
- The invocation owner must await the Agent driver and all foreground work before disposing the Cordis root.

This is a runtime constraint, not an authorization mechanism. Tenant ownership and Agent identity must still be validated explicitly at request, persistence, and tool boundaries.

## Excluded runtime patterns

Do not mount background schedulers, queue pumps, subagent drivers, or other plugins that start independent agentless or second-Agent work inside the same invocation unless they are adapted to explicit execution context. Do not use the Node provider as a fallback in the Serverless bundle.

## Known limitations

The provider cannot isolate multiple independent Agent identities in one V8 invocation because the runtime has no AsyncLocalStorage equivalent in the supported SDK surface. The platform must create a new invocation and AgentRegistry for each request that drives an Agent.

## Source map

| File | Role |
|---|---|
| `src/index.ts` | Selects the V8-compatible scope factory |
