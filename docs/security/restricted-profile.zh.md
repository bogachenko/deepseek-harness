# SaaS Restricted DSH Profile

[English](restricted-profile.md) | 中文

**状态：** 初始能力受限 Profile  
**基础：** @deepseek-ai/dsh-sdk-minimal  
**目标：** Linux Server 部署

## 目的

该 Profile 提供 DSH Agent Loop 和 SDK JSON-RPC 传输，但不会向模型暴露本地命令执行、通用文件系统工具、工作目录修改或 MCP Resources。

它是 Restricted Agent 的起始 Runtime。后续业务集成将作为明确注册的工具添加，并通过平台 Tool Gateway 调用。

## 应用的 Overlay

Overlay 位于：

deploy/profiles/saas-restricted/cordis.patch.yml

必须在独立的 sdk-minimal bundle 之后应用。

Overlay 会禁用：

- terminal-bash 和 terminal-pwsh；
- persistent-bash 和 persistent-pwsh；
- tool-fs；
- tool-working-directory；
- mcp-resources；
- session-log-deepseek。

它还会将 sandbox-policy.mode 从 danger-full-access 改为 read-only。Cordis patch layer 会替换某一行的完整 config，因此会有意重新声明 workspaceRoot。

独立的 sdk-minimal 组合不包含通用 Web Fetch/Search 工具、PTC Runtime/Executor 或 plugin-manager 工具。回归测试会针对固定组合检查已知执行入口和 overlay 的准确配置。

## 本地启动

在仓库根目录中，首次初始化自定义 Profile 并应用 Overlay：

```bash
dsh --profile saas-restricted \
  --from-default-profile sdk-minimal \
  --patch ./deploy/profiles/saas-restricted/cordis.patch.yml
```

后续启动时仍需应用 Overlay：

```bash
dsh --profile saas-restricted \
  --patch ./deploy/profiles/saas-restricted/cordis.patch.yml
```

SDK Profile 使用 stdin/stdout 承载 JSON-RPC。不要将该进程直接暴露到公共 Internet；平台 API Gateway 必须先认证客户端，再通过私有本地传输与 Runtime 通信。

## 安全限制

该 Profile 本身并不是 production 安全边界。

- 它移除了模型可见的本地执行和文件系统工具，但不能将 DSH 进程与 Linux 主机隔离。
- sdk-minimal DeepSeek adapter 会从 DSH 进程环境中读取 DEEPSEEK_API_KEY。不要向该进程加载不可信插件。未来的 Model Gateway 必须在 Runtime 之外保管模型提供方凭据。
- Profile 的 cordis.patch.yml、home 级 patch 和启动 overlay 都属于可信部署配置。不得允许 tenant 用户编辑它们或提供任意 --patch 参数。
- 每个 tenant 使用独立的受限 Linux Runtime 和 DSH home。不要挂载主机 home 目录、SSH 材料、容器运行时 socket 或平台密钥。
- 该 Profile 尚未实现 Tool Gateway、Credential Broker 或 Advanced Execution Broker。在这些边界及其测试完成之前，不得将它宣传为可用于 production。

## 下一步实现

1. 添加由平台拥有的最小原生工具，使用 Workload Identity 签发的短时令牌调用 Tool Gateway。
2. 在服务端强制验证 tenant 和 agent 身份；绝不接受模型工具参数提供的身份。
3. 将模型提供方凭据移至 Model Gateway。
4. 添加跨 tenant 和 prompt injection 回归测试。
5. 通过 Execution Broker 和经过验证的 Sandbox 后端单独实现 Advanced 执行。
