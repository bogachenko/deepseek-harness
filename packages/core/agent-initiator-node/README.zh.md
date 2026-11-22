---
description: "Node.js AsyncLocalStorage provider for DSH Agent attribution across concurrent agents."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-initiator-node

[English](README.md) | 中文

## Summary

本包为 DSH 提供 Node.js 发起者作用域。它使用 `AsyncLocalStorage`，使每个 Agent 的身份在重叠的异步 driver 链中保持隔离。标准 `dsh-base` 和 `dsh-sdk-minimal` bundle 选择此 provider。

## Use this package

在 Agent 执行前，将此 provider 挂载到 Node.js 组合中。它会发布 `agentInitiatorScopeFactory`；`dsh-agent` 为每个 AgentRegistry 生命周期创建新的作用域。应用代码应通过 `ctx.agents` 使用该能力，而不是直接实例化作用域。

## Runtime contract

- 不同 Agent 可以并发运行，且不会共享环境身份。
- 嵌套边界会在同步返回或 Promise 结算后恢复父级身份。
- `withoutInitiator()` 会为共享定时器和后台工作隐藏继承的归因信息。
- Teardown 会拒绝新边界，并等待已返回的 Promise 生命周期结束。
- 环境身份只用于归因，不用于授权；跨 worker、持久化、HTTP 和 wire 边界仍须显式传递身份。

## Known limitations

此 provider 导入 Node.js 内置模块，因此不得用于 Telegram Serverless，或其他不提供 `node:async_hooks` 和 `node:util/types` 的运行时。隔离的 V8 invocation 应使用 single-Agent provider。
