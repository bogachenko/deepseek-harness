---
description: "V8-compatible Agent initiator provider for serverless invocations with one active Agent."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-initiator-single

[English](README.md) | 中文

## Summary

本包为每次仅运行一个活动 Agent 的 serverless invocation 选择 V8 兼容的发起者策略。它不导入任何 Node.js 内置模块。如果没有挂载其他 provider，`dsh-agent` 内置的 fallback 也会使用相同策略。

## Use this package

在 Serverless 组合中挂载此 provider，以替代 `@deepseek-ai/dsh-agent-initiator-node`。它会发布 `agentInitiatorScopeFactory`；`dsh-agent` 为每个 AgentRegistry 生命周期创建新的作用域。

## Invocation contract

- 每次 invocation 只拥有一个活动 Agent。
- 支持同一个 Agent 的嵌套边界和重叠边界。
- 第一个 Agent 处于活动状态时，第二个不同的 Agent 会被拒绝。
- 只有在没有活动 Agent 边界时，才允许调用 `withoutInitiator()`。
- 无 Agent 的直接操作可以在 Agent 边界之前或之后运行，但不能与其重叠。
- invocation owner 必须等待 Agent driver 和前台工作完成，然后才能释放 Cordis root。

## Excluded runtime patterns

不要挂载会在同一次 invocation 中启动独立无 Agent 工作或第二个 Agent 的后台 scheduler、queue pump、subagent driver 等插件，除非它们改为使用显式 execution context。

## Known limitations

受支持的运行时没有 AsyncLocalStorage 等价能力，因此此 provider 无法在一次 V8 invocation 中隔离多个 Agent 身份。平台必须为每个需要驱动 Agent 的请求创建新的 invocation 和 AgentRegistry。
