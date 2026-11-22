---
description: "Node.js AsyncLocalStorage provider for DSH Agent attribution across concurrent agents."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-initiator-node

English | [中文](README.zh.md)

## Summary

This package supplies the Node.js initiator scope for DSH. `AsyncLocalStorage` keeps each Agent identity isolated across overlapping async driver chains. The standard `dsh-base` and `dsh-sdk-minimal` bundles select this provider.

## Use this package

Mount this provider in Node.js compositions before Agent execution. It publishes `agentInitiatorScopeFactory`; `dsh-agent` creates a fresh scope for each AgentRegistry lifecycle. Application code should use `ctx.agents` rather than instantiate the scope directly.

## Runtime contract

- Distinct Agents may run concurrently without sharing ambient identity.
- Nested boundaries restore the parent after synchronous return or Promise settlement.
- `withoutInitiator()` hides inherited attribution for shared timers and background work.
- Teardown rejects new boundaries and drains returned Promise lifetimes.
- Ambient identity is attribution, not authorization; carry explicit identity across worker, persistence, HTTP, and wire boundaries.

## Known limitations

This provider imports Node.js built-ins and must not be included in Telegram Serverless or another runtime without `node:async_hooks` and `node:util/types`. Use the single-Agent provider for an isolated V8 invocation.
