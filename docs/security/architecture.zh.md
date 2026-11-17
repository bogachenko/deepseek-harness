# 安全架构

[English](architecture.md) | 中文

**状态：** 当前基线  
**范围：** 基于 DeepSeek Harness（DSH）的 Linux 托管、独立于云服务商的 SaaS 平台。

## 1. 产品与部署约束

- Linux 是唯一支持的主机操作系统。
- 平台不得依赖特定云服务商的专有 API 或产品。
- 部署可以运行在普通 VPS 上；不假设存在硬件虚拟化或对 /dev/kvm 的访问权限。
- 平台提供两类 Agent：Restricted 和 Advanced。
- DSH 是 Agent Runtime，不是平台 Control Plane，本身也不是安全边界。
- 安全控制必须在模型之外强制执行，不能依赖提示词指令。

## 2. 高层架构

```text
                         CLIENTS
                            |
                         HTTPS
                            |
                       API GATEWAY
                            |
                    AUTHENTICATION / RBAC
                            |
                       CONTROL PLANE
                 +----------+-----------+
                 |          |           |
             Tenant      Agent       Policy
             Manager     Manager     Engine
                 |          |
                 |      DSH Runtime
                 |      (tenant-scoped)
                 |          |
          +------+----------+----------------+
          |                                 |
     TOOL GATEWAY                     EXECUTION BROKER
          |                                 |
     Credential Broker                Sandbox Service
          |                                 |
     External APIs                 Isolated Job Runtime
                                            |
                                      Result Collector
                                            |
                                      Artifact Storage
```

Control Plane 负责 tenant 身份、认证、生命周期管理、策略决策和审计元数据。DSH 运行 Agent Loop，并协调模型与工具交互。Execution Plane 在 DSH 进程之外执行不可信代码。

Workload token 的签发和验证由 [dsh-workload-identity](../../packages/identity/workload-identity/README.zh.md) 实现。只有 Control Plane 持有签名私钥；Tool Gateway 接收验证公钥；DSH Runtime 只接收短时有效的 bearer token。

## 3. 信任边界

### 3.1 Control Plane

职责：
- 认证用户和服务；
- 创建和管理 tenant 与 agent；
- 签发短时有效、权限范围严格受限的 workload identity；
- 评估策略；
- 调度 DSH Runtime 和执行任务；
- 记录与安全相关的审计事件。

Control Plane 不得执行模型生成的代码。

### 3.2 DSH Agent Runtime

最小隔离单元：每个 tenant 使用独立的 runtime 进程或容器。数据范围或权限配置有实质差异的 agent 必须使用不同的 runtime。

DSH Runtime：
- 只接收工作所需的 tenant 和 agent 身份；
- 除明确配置的 tenant 专属数据外，不挂载主机文件系统；
- 无权访问 Docker/containerd socket、主机凭据、SSH 密钥、云元数据或 Control Plane 数据库；
- 不存储提供方 API 密钥或其他长期集成密钥；
- 不能直接创建容器或 sandbox；
- 在 production 中不能加载任意第三方插件或任意 MCP Server。

不得将 DSH 内置文件系统和 Shell sandboxing 视为 tenant 隔离边界。

### 3.3 Tool Gateway 和 Credential Broker

所有业务集成都必须经过 Tool Gateway。

Tool Gateway：
- 认证发起调用的 workload；
- 从已认证上下文推导 tenant 和 agent 身份，而不是采用模型提供的参数；
- 对每次操作检查 capability 和对象级权限；
- 对每次数据访问应用 tenant 范围限制；
- 验证输入和输出；
- 记录与安全相关的操作。

Credential Broker 在服务端获取集成凭据。不得将原始凭据返回给模型或挂载到 Agent Runtime。工具实现只能在执行特定授权操作时使用相应凭据。

### 3.4 Execution Plane

Advanced Agent 可以通过范围严格受限的 run_code capability 请求代码执行。

Execution Broker：
- 认证 DSH workload；
- 验证 tenant、agent、策略和资源限制；
- 接收受约束的任务规格，而不是任意容器运行时规格；
- 启动全新的隔离任务环境；
- 只提供明确提交的输入文件；
- 收集有大小限制的输出和声明的 artifacts；
- 在任务完成或超时后销毁任务环境。

DSH Runtime 不得访问容器运行时 socket 或主机级执行控制接口。

## 4. Agent 类型

### Restricted Agent

允许：
- 通过 Tool Gateway 暴露的、明确注册的业务工具；
- 通过授权服务暴露的 tenant 专属文档和数据操作。

禁止：
- Shell 访问；
- 任意 Python、JavaScript 或其他代码执行；
- 任意本地文件系统访问；
- 任意网络访问；
- 任意插件或 MCP Server 安装。

### Advanced Agent

在 Restricted Agent 的能力之外，额外拥有 run_code 工具。

代码只能在 Execution Plane 中执行，不得在 DSH 进程、Control Plane、Tool Gateway 或主机上执行。

执行环境不会收到集成凭据、Control Plane 凭据、主机密钥或隐式云身份。

## 5. 执行隔离策略

### 5.1 独立于服务商的接口约定

为执行环境定义 provider 接口。初始接口应支持：
- 能力检测；
- 创建任务；
- 提交有大小限制的输入；
- 等待任务完成；
- 收集有大小限制的输出和 artifacts；
- 终止任务；
- 销毁任务；
- 报告执行和隔离状态。

面向 Agent 的 API 不得暴露特定实现的运行时选项。

### 5.2 初始 Linux 后端

首个候选后端是通过 gVisor runsc 执行 OCI 任务，并在支持时使用 Systrap 平台。

部署期间执行主机能力检查；Sandbox Service 在接受任务前也会再次检查。实现必须验证每个任务实际选用的运行时，不能假设配置 OCI runtime 就意味着该 runtime 一定生效。

如果所需隔离后端不可用、配置错误或健康检查失败，则禁用 Advanced 执行。不得自动回退到普通 runc 容器。

KVM 和 Firecracker 不是基线要求。未来可以在主机支持时增加 microVM 后端，而无需改变面向 Agent 的执行接口。

### 5.3 任务默认值

除非经过审核的策略明确授权，否则：
- 每个任务使用全新的环境；
- 任务内部使用非 root 用户；
- 基础镜像只读；
- 可写任务目录为临时目录；
- 不挂载主机文件系统；
- 不挂载主机或容器运行时 socket；
- 不提供凭据或隐式服务身份；
- 不允许入站连接；
- 默认拒绝出站网络；
- 限制 CPU、内存、进程数、磁盘、输出大小和墙钟时间；
- 限制日志和 artifacts；
- 超时后强制终止；
- 收集结果后销毁环境。

如果未来需要网络访问，必须通过受控的 egress 组件，并应用目标地址和协议策略。默认不得提供不受限制的通用网络。

## 6. 数据与 tenant 隔离

- Tenant 身份来自经过认证的平台上下文，绝不信任模型输出。
- 每次数据库查询和对象存储操作都必须限定 tenant 范围并执行授权检查。
- 不得通过可写主机路径共享 tenant 数据。
- 每个 tenant 的 runtime 状态、workspace、凭据和审计记录必须隔离。
- 跨 tenant 访问测试是发布阻断条件。
- Tenant 专属加密和数据保留策略由平台服务强制执行。

## 7. DSH Production Profile

第一个 Restricted Agent 组合由独立的 sdk-minimal bundle 和经过审核的 [Restricted Profile](restricted-profile.zh.md) overlay 实现。它刻意不使用 dsh-base，因为 dsh-base 共享的工具集合对于第一个 SaaS Runtime 来说过于宽泛。

Production DSH bundle 必须根据所需能力的明确 allowlist 进行组合。

初始 Restricted Profile 不得暴露：
- 本地 Shell 执行；
- 在 DSH 进程内执行任意代码或 PTC；
- 不受限制的本地文件系统工具；
- 不受限制的 Web Fetch；
- 任意插件安装；
- 任意 MCP Server 执行；
- 存放集成密钥的本地凭据存储。

Advanced 执行只能通过由 Broker 支持的 run_code 工具暴露。

在实现之前，必须根据固定的 DSH commit 验证准确的 Cordis bundle 和 capability ID。不能仅因为 UI 隐藏了某项能力，就假设该能力已被禁用。

## 8. 安全不变量

1. 模型输出不能为自身授予权限。
2. Tenant 和 agent 身份必须来自经过认证的服务端上下文。
3. DSH 不能读取长期集成凭据。
4. DSH 不能控制主机容器运行时。
5. 不可信代码绝不在 DSH 进程内执行。
6. Advanced 任务不能获得隐式密钥或主机身份。
7. 除非明确授权，否则拒绝网络出站流量。
8. 隔离不可用或健康检查失败时，必须拒绝执行。
9. 不允许跨 tenant 访问数据。
10. 每项特权操作都必须可审计。

## 9. 实施顺序

1. 编写威胁模型和安全不变量。
2. 清点固定 upstream commit 中的 DSH 能力。
3. 从明确的 allowlist 构建 Restricted DSH Profile。
4. 在 production runtime 中移除或替换本地凭据访问。
5. 实现 workload identity 和 Tool Gateway 授权。
6. 实现执行 provider 接口和主机能力检查。
7. 实现第一个基于 gVisor 的执行 provider。
8. 增加网络、资源、文件系统和生命周期强制控制。
9. 增加对抗性测试和跨 tenant 回归测试。
10. 只有完成以上工作后，才考虑 production 部署。

## 10. 参考资料

- [gVisor 文档](https://gvisor.dev/docs/)
- [gVisor 平台选择](https://gvisor.dev/docs/user_guide/platforms/)
- [gVisor 安全模型](https://gvisor.dev/docs/architecture_guide/intro/)
- [DSH upstream 仓库](https://github.com/deepseek-ai/deepseek-harness)
