---
description: "identity 包组：匿名安装关联 id，以及面向租户隔离 Runtime 的签名工作负载身份。"
kind: "package-group"
---

# identity/ — 共享身份

[English](README.md) | 中文

## 概述

identity 组包含两种彼此独立的身份机制。anonymous-user-id 为每个 harness home 提供不具备认证能力的关联 id，用于遥测、反馈和提供方记录。workload-identity 签发并验证短时有效的 Ed25519 凭据，将 tenant、agent、runtime 和服务端授予的 capabilities 绑定在一起。匿名 id 不是认证凭据；工作负载令牌签名密钥只能由可信的 Control Plane 持有。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [anonymous-user-id](anonymous-user-id/README.zh.md) | 为每个 harness home 提供稳定的匿名关联 id，用于遥测、反馈和 DeepSeek 提供方记录。 |
| [workload-identity](workload-identity/README.zh.md) | 签发并验证限定于一个 tenant、agent、runtime 和 capabilities 集合的短时有效 Ed25519 身份。 |

<a id="related-documentation"></a>
## 相关文档

- [会话遥测子系统](../../docs/subsystems/session-telemetry.zh.md)——在遥测中携带匿名安装 id 的功能。
- [dsh-llm-deepseek](../llm/llm-deepseek/README.zh.md)——在请求中携带匿名安装 id 的 DeepSeek 提供方。
- [dsh-command-feedback](../feedback/command-feedback/README.zh.md)——在确认文本中点名该匿名安装的反馈命令。
- [dsh-workload-identity](workload-identity/README.zh.md)——签名 runtime 身份及验证约定。

<a id="dev-note"></a>
## 开发备注

无。
