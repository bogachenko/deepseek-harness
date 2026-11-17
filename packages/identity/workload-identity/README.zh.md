---
description: "为租户隔离的 DSH Runtime 签发并验证短时有效的 Ed25519 工作负载身份。"
kind: "package-library"
---

# @deepseek-ai/dsh-workload-identity

[English](README.md) | 中文

## 概述

本包为按租户隔离的 Agent Runtime 签发并验证短时有效的 Ed25519 签名身份。Control Plane 使用私钥签发令牌；DSH Runtime 和 Tool Gateway 服务使用公钥验证令牌。验证方不需要私钥，且绝不能向 Agent Runtime 配置私钥。

## 目录

- [使用本包](#use-this-package)
- [令牌约定](#token-contract)
- [API](#api)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

可信的 Control Plane 在完成平台请求认证，并从服务端状态解析出 tenant、agent、runtime 和已授予的 capabilities 后，调用 issueWorkloadToken。它只会将生成的 bearer token 交付给预期的 runtime 或服务 audience。DSH Runtime 或 Tool Gateway 使用可信公钥集合以及精确的 issuer 和 audience 调用 verifyWorkloadToken。

绝不能从模型生成的参数推导 tenant 身份或 capabilities。绝不能把签名私钥放入 DSH Runtime、沙箱、提示词、工具结果或日志。应将令牌视为 bearer 凭据，不要不必要地持久化或披露。

## 令牌约定

紧凑令牌采用固定格式：dsh-wid-v1、key id、base64url payload 和 Ed25519 签名。固定格式版本选择 Ed25519；令牌中不存在可由令牌控制的算法字段。key id 属于签名输入，并用于选择可信公钥，因此在轮换期间可以继续保留旧验证密钥。

签名 payload 包含版本、issuer、audience、tenant id、agent id、runtime id、排序后的 capabilities、唯一令牌 id、签发时间和过期时间。未知 claims、重复或未排序的 capabilities、非规范 JSON、格式错误的 base64url 以及无效标识符都会被拒绝。一个令牌最多携带 64 个 capabilities。

签发默认有效期为 300 秒，且不能超过该上限。验证要求 issuer 和 audience 精确匹配，并允许最多 60 秒的时钟偏差；默认值为 30 秒。验证成功后返回被冻结的身份对象和 capabilities 列表。

## API

issueWorkloadToken 接收由服务端解析的 WorkloadIdentity，以及包含 Ed25519 私钥、key id、issuer、audience 和可选有效期的签发选项，并返回紧凑 bearer token。

verifyWorkloadToken 接收令牌和验证选项；验证选项包含可信公钥映射、预期 issuer、预期 audience 以及可选时钟设置。它返回 VerifiedWorkloadIdentity。所有令牌验证失败统一使用 WORKLOAD_TOKEN_INVALID；无效的服务端密钥或验证器配置使用 WORKLOAD_TOKEN_CONFIGURATION_INVALID。

## 模型体验

无；本包签发和验证模型不可见的工作负载凭据，不注册任何面向模型的内容。

#### KV Cache 影响

无；工作负载身份在模型请求之外验证，不会改变提示词 token。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 没有撤销列表——被盗用的 bearer token 在短暂过期前仍可使用；平台必须轮换 runtime token 并限制其有效期。
- 不负责资源授权——签名 capabilities 只表明 runtime 获得的能力集合；Tool Gateway 仍必须逐项操作、逐个租户资源执行授权。
- 密钥管理在外部——私钥存储、公钥分发、密钥轮换周期和紧急密钥退役由 Control Plane 部署负责，本库不实现这些功能。

<a id="dev-note"></a>
## 开发备注

无。
