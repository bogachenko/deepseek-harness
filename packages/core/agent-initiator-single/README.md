---
description: "V8-compatible Agent initiator provider for serverless invocations with one active Agent."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-initiator-single

English | [中文](README.zh.md)

## Summary

This package selects the V8-compatible initiator strategy for a serverless invocation with one active Agent. It imports no Node.js built-ins. The same strategy is the fallback built into `dsh-agent` when no provider is mounted.

## Use this package

Mount this provider in the Serverless composition instead of `@deepseek-ai/dsh-agent-initiator-node`. It publishes `agentInitiatorScopeFactory`; `dsh-agent` creates a fresh scope for each AgentRegistry lifecycle.

## Invocation contract

- One invocation owns one active Agent.
- Nested and overlapping boundaries for that exact Agent are supported.
- A second distinct Agent is rejected while the first Agent is active.
- `withoutInitiator()` is allowed only when no Agent boundary is active.
- Agentless direct operations may run before or after the Agent boundary, but may not overlap it.
- The invocation owner must await the Agent driver and foreground work before disposing the Cordis root.

## Excluded runtime patterns

Do not mount background schedulers, queue pumps, subagent drivers, or other plugins that start independent agentless or second-Agent work inside the same invocation unless they use explicit execution context.

## Known limitations

The provider cannot isolate multiple Agent identities in one V8 invocation because the supported runtime has no AsyncLocalStorage equivalent. The platform must create a new invocation and AgentRegistry for each request that drives an Agent.
