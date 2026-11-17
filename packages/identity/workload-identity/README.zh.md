---
description: "用于签发和验证租户隔离 DSH Runtime 短时有效身份的 Ed25519 工作负载令牌库。"
kind: "package-library"
---

# @deepseek-ai/dsh-workload-identity

[English](README.md) | 中文

## 概述

本包为租户隔离的 DSH Runtime 签发短时有效的 Ed25519 工作负载令牌。Control Plane 使用 issueWorkloadToken，Tool Gateway 使用 verifyWorkloadToken 对每个 Runtime 进行认证。该库负责令牌格式和 claims 验证，但不负责私钥存储、令牌撤销或资源级授权。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 适用场景

当可信的 Control Plane 需要为一个 tenant、agent 和 runtime 签发短时有效身份，并且 Tool Gateway 需要在分发业务操作前验证该身份时，使用此库。它是普通 Node 模块，不是 Cordis 插件，也不是可安装的 Profile layer。

### 入口示例

下面的完整示例会为本地 smoke test 创建临时密钥对。Production 环境中，私钥必须保留在 Control Plane，并且只向 Tool Gateway 配置公钥。

```ts
import { generateKeyPairSync } from 'node:crypto'
import { issueWorkloadToken, verifyWorkloadToken } from '@deepseek-ai/dsh-workload-identity'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const identity = {
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  runtimeId: 'runtime-a',
  capabilities: ['crm.read'],
}
const token = issueWorkloadToken(identity, {
  privateKey,
  keyId: 'control-2026-01',
  issuer: 'https://control.example',
  audience: 'dsh-tool-gateway',
})
const verified = verifyWorkloadToken(token, {
  publicKeys: new Map([['control-2026-01', publicKey]]),
  issuer: 'https://control.example',
  audience: 'dsh-tool-gateway',
})
console.log(verified.tenantId)
```

验证成功后返回被冻结的 claims。无效令牌会抛出 WORKLOAD_TOKEN_INVALID；无效的服务端密钥或验证器配置会抛出 WORKLOAD_TOKEN_CONFIGURATION_INVALID。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

### 设计边界

版本化 envelope 固定使用 Ed25519，不接受令牌自行指定算法。key id 包含在签名输入中，因此密钥轮换时可以保留旧公钥，同时让新令牌使用新的 id。Payload 解析会拒绝未知 claims、重复或未排序的 capabilities、非规范 JSON、格式错误的标识符，以及超过 300 秒的有效期。

签发方和验证方通过密钥材料明确分离：只有签发方接收私钥，验证方只接受公钥。令牌是 bearer 凭据，在过期前仍可使用；本包不存储或撤销令牌。

### 源码索引

| 文件 | 职责 |
|---|---|
| [src/index.ts](src/index.ts) | 普通库 API：Ed25519 令牌签发/验证、claims 校验、key id 选择和稳定错误码。 |
| [tests/workload-identity.spec.ts](tests/workload-identity.spec.ts) | 验证签名、密钥轮换、issuer/audience、时间范围、capabilities 校验、规范 payload 和密钥隔离。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

在将本库接入服务之前，请先阅读架构和威胁模型。

- [Identity 组说明](../README.zh.md) — 同组 package 及 identity 系列的范围。
- [安全架构](../../../docs/security/architecture.zh.md) — Control Plane、Runtime、Tool Gateway 和 Execution Plane 的边界。
- [威胁模型](../../../docs/security/threat-model.zh.md) — 本包帮助应对的 workload identity 和跨 tenant 威胁。
- [Restricted DSH Profile](../../../docs/security/restricted-profile.zh.md) — 当前面向模型的能力限制。
- [Node.js crypto API](https://nodejs.org/api/crypto.html) — Ed25519 密钥对象、签名和验证原语。

-----

<a id="model-experience"></a>
## 模型体验

None, as this package signs and verifies model-hidden workload credentials and registers no model-facing content.

#### KV Cache effect

无；工作负载身份在模型请求之外验证，不会改变提示词 token。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 没有撤销列表——被盗用的 bearer token 在短暂过期前仍可使用；平台必须轮换 runtime token 并限制其有效期。
- 不负责资源授权——签名 capabilities 只表明 runtime 获得的能力集合；Tool Gateway 仍必须逐项操作、逐个租户资源执行授权。
- 密钥管理在外部——私钥存储、公钥分发、密钥轮换周期和紧急密钥退役由 Control Plane 部署负责，本库不实现这些功能。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
