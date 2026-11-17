# 威胁模型

[English](threat-model.md) | 中文

**状态：** 初始基线  
**范围：** 在 Linux 主机上运行 DSH 的多租户 SaaS。

## 1. 安全目标

保护：
- 客户数据和文件；
- 集成凭据和平台密钥；
- tenant 和 agent 身份；
- Control Plane 和主机基础设施；
- 执行任务和生成的 artifacts；
- 服务可用性和资源预算。

必须实现的结果：
- 不发生跨 tenant 访问；
- Agent 无法访问长期凭据；
- 模型生成的代码不在 DSH 或 Control Plane 进程中执行；
- Agent Runtime 无法控制主机；
- 执行任务不能未经授权访问外部网络；
- 特权操作可审计。

## 2. 威胁主体

- 恶意或已被攻陷的 tenant 用户；
- 文档、网站、邮件和工具结果中的 prompt injection 内容；
- 错误或有意对抗的模型输出；
- 恶意或已被攻陷的插件、MCP Server 或依赖项；
- 已被攻陷的 DSH Runtime；
- 提交给 Advanced 执行环境的恶意代码；
- 攻击公开 API 或基础设施的外部攻击者；
- 已被攻陷的集成或凭据。

## 3. 资产与信任边界

| 资产 | 主要边界 |
|---|---|
| Tenant 数据 | Tenant 感知的数据服务和存储 |
| 集成凭据 | Credential Broker |
| 平台签名密钥 | Control Plane 密钥存储 |
| Workload identity | 短时有效、范围受限的身份 |
| DSH Runtime | Tenant 专属 Runtime 边界 |
| 主机和容器运行时 | 主机管理边界 |
| Advanced 任务 | 执行 Sandbox 边界 |
| 审计记录 | 受限的追加式审计服务 |

信任边界：
1. Internet 到 API Gateway。
2. Tenant/用户到 Control Plane。
3. Control Plane 到 DSH Runtime。
4. DSH Runtime 到 Tool Gateway。
5. Tool Gateway 到 Credential Broker 和外部集成。
6. DSH Runtime 到 Execution Broker。
7. 执行任务到主机、网络和 artifact 服务。
8. 一个 tenant 的服务与数据到另一个 tenant 的服务与数据。

## 4. 主要威胁场景

### T1. 跨 tenant 数据访问

**场景：** 模型修改工具参数中的 tenant 标识，或者已被攻陷的 Runtime 请求其他 tenant 的对象。

**必要控制：**
- 从经过认证的 workload 上下文推导 tenant 身份；
- 绝不能仅根据工具参数中提供的 tenant ID 授权；
- 在服务层和数据访问层强制应用 tenant 过滤；
- 测试直接对象引用和 confused-deputy 场景。

### T2. Agent 窃取凭据

**场景：** 模型调用 Shell、读取文件、检查环境变量，或利用工具获取集成凭据或平台密钥。

**必要控制：**
- DSH 文件或环境变量中不得包含长期集成密钥；
- 不挂载主机 home 目录；
- Credential Broker 在服务端保管密钥；
- 工具操作在内部使用凭据，并且只返回经过授权的结果；
- 提示词、日志、trace 或 artifacts 中不得出现密钥。

### T3. 通过代码执行攻陷主机

**场景：** Advanced 代码尝试逃离 Sandbox、检查主机文件、访问运行时 socket，或干扰其他任务。

**必要控制：**
- 只能通过 Execution Broker 执行；
- 使用经过验证的隔离运行时；
- 不挂载主机路径或 socket；
- 使用非 root 用户并实施资源限制；
- 隔离检查失败时拒绝执行；
- production 前执行对抗性 Sandbox 逃逸测试。

### T4. 服务端请求伪造和网络横向移动

**场景：** Agent 或执行任务访问 loopback 服务、私有网络、云元数据、数据库或控制端点。

**必要控制：**
- 默认拒绝出站网络；
- 为获准目标提供受控 egress proxy；
- 除非经过单独审核的策略明确要求，否则阻止 loopback、link-local、私有地址和 metadata 地址；
- 不仅验证原始 hostname，还要验证解析后的 IP 和重定向目标；
- 隔离控制平面网络和数据平面网络。

### T5. Prompt Injection 和未授权工具调用

**场景：** 不可信内容指示模型泄露数据或调用特权操作。

**必要控制：**
- 在模型之外执行授权；
- 对每个工具和每个对象检查策略；
- 高影响操作必须经过明确策略或人工批准；
- 不可信内容不能修改系统策略或 workload identity；
- 工具输出也视为不可信输入。

### T6. 恶意扩展或 MCP Server

**场景：** 第三方代码在 DSH 进程中或以主机用户权限执行。

**必要控制：**
- production 扩展 allowlist；
- 固定依赖版本并审核来源；
- 不允许 tenant 配置启动任意 MCP Server；
- 必要时将第三方集成隔离到独立服务；
- 不得把插件边界视为安全边界。

### T7. 拒绝服务和成本耗尽

**场景：** Tenant 提交无限循环、fork bomb、超大输出或过多并发任务。

**必要控制：**
- 限制 CPU、内存、PID、磁盘、输出、墙钟时间和并发量；
- 按 tenant 限速并设置预算；
- 支持取消和强制终止；
- 对队列施加背压；
- 限制日志和 artifacts。

### T8. 通过可观测性泄露密钥或客户数据

**场景：** 提示词、工具结果、凭据或客户文件被复制到日志、trace、遥测或支持包中。

**必要控制：**
- 默认最小化数据采集；
- 对凭据和敏感 payload 进行脱敏；
- 明确数据保留和访问策略；
- 默认不向外部服务上传 Session；
- 将审计元数据与敏感内容分离。

## 5. 假设与限制

- 主机操作系统及其管理员可信。
- VPS 服务商和物理主机不受平台控制；不假设服务商提供特定的机密计算保证。
- gVisor 是隔离层，但这不意味着可以向任务暴露主机文件或密钥。
- 不假设任何 Sandbox 都能保证绝对不会逃逸。
- DSH 内置审批、文件系统 Sandbox 和提示词指令不能替代服务端授权和进程隔离。
- 首个版本只支持 Linux。
- 首个版本不要求 KVM、Firecracker 或特定云服务商的虚拟化 API。

## 6. 发布阻断性安全测试

- 一个 tenant 不能读取、修改或推断其他 tenant 的记录或 artifacts。
- DSH Runtime 不能读取主机凭据、集成凭据、SSH 密钥或平台签名密钥。
- DSH Runtime 不能访问 Docker/containerd socket 或创建主机容器。
- Advanced 任务不能读取主机文件或其他任务的文件。
- 默认情况下，Advanced 任务不能访问 Control Plane、metadata、loopback 或私有网络地址。
- Runtime 配置错误时，任务创建必须失败关闭。
- CPU、内存、PID、磁盘、输出和时间限制必须生效。
- 日志、trace、提示词或返回的 artifacts 中不得出现密钥。
- 任务完成或超时后必须终止任务并销毁其可写环境。

通过这些测试是声明 production 安全性的必要条件，但并不足够。仍需单独进行安全审查和渗透测试。
