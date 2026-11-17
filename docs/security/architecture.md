# Security Architecture

**Status:** Working baseline  
**Scope:** Linux-hosted, provider-independent SaaS platform built around DeepSeek Harness (DSH).

## 1. Product and deployment constraints

- Linux is the only supported host operating system.
- The platform must not depend on a cloud provider's proprietary APIs or products.
- A deployment may run on an ordinary VPS. Hardware virtualization and access to `/dev/kvm` are not assumed.
- The platform has two agent classes: Restricted and Advanced.
- DSH is an agent runtime, not the platform Control Plane and not a security boundary by itself.
- Security controls must be enforced outside the model and outside prompt instructions.

## 2. High-level architecture

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

The Control Plane owns tenant identity, authentication, lifecycle management, policy decisions, and audit metadata. DSH runs the agent loop and coordinates model/tool interactions. The Execution Plane runs untrusted code outside the DSH process.

## 3. Trust boundaries

### 3.1 Control Plane

Responsibilities:
- authenticate users and services;
- create and manage tenants and agents;
- issue short-lived, narrowly scoped workload identities;
- evaluate policies;
- schedule DSH runtimes and execution jobs;
- record security-relevant audit events.

The Control Plane must not execute model-generated code.

### 3.2 DSH Agent Runtime

Minimum isolation unit: one runtime process/container per tenant. Agents with materially different data scopes or privilege profiles must use separate runtimes.

The DSH runtime:
- receives only the tenant and agent identity required for its work;
- has no host filesystem mounts other than explicitly provisioned tenant-scoped data;
- has no access to Docker/containerd sockets, host credentials, SSH keys, cloud metadata, or Control Plane databases;
- does not store provider API keys or other long-lived integration secrets;
- cannot create containers or sandboxes directly;
- cannot load arbitrary third-party plugins or arbitrary MCP servers in production.

DSH's built-in filesystem and shell sandboxing must not be treated as the tenant isolation boundary.

### 3.3 Tool Gateway and Credential Broker

All business integrations go through the Tool Gateway.

The Tool Gateway:
- authenticates the calling workload;
- derives tenant and agent identity from authenticated context, not from model-supplied arguments;
- checks capability and object-level permissions on every operation;
- applies tenant scoping to every data access;
- validates inputs and outputs;
- records security-relevant actions.

The Credential Broker retrieves integration credentials server-side. Raw credentials must never be returned to the model or mounted into the agent runtime. A tool implementation uses a credential only for the specific authorized operation.

### 3.4 Execution Plane

Advanced agents may request code execution through a narrow `run_code` capability.

The Execution Broker:
- authenticates the DSH workload;
- verifies tenant, agent, policy, and resource limits;
- accepts a constrained job specification, not an arbitrary container runtime specification;
- starts a fresh isolated job environment;
- provides only explicitly supplied input files;
- collects bounded output and declared artifacts;
- destroys the job environment after completion or timeout.

The DSH runtime must not have access to the container runtime socket or host-level execution controls.

## 4. Agent classes

### Restricted Agent

Allowed:
- explicitly registered business tools exposed through the Tool Gateway;
- tenant-scoped document and data operations exposed through authorized services.

Not allowed:
- shell access;
- arbitrary Python, JavaScript, or other code execution;
- arbitrary local filesystem access;
- arbitrary network access;
- arbitrary plugin or MCP server installation.

### Advanced Agent

Has the Restricted Agent capabilities plus the `run_code` tool.

Code executes only in the Execution Plane. It does not execute in the DSH process, Control Plane, Tool Gateway, or host.

The execution environment receives no integration credentials, Control Plane credentials, host secrets, or ambient cloud identity.

## 5. Execution isolation strategy

### 5.1 Provider-independent contract

Define a provider interface for execution environments. The initial contract should support:
- capability detection;
- create job;
- submit bounded inputs;
- wait for completion;
- collect bounded outputs/artifacts;
- terminate job;
- destroy job;
- report execution and isolation status.

The agent-facing API must not expose implementation-specific runtime options.

### 5.2 Initial Linux backend

The initial candidate backend is OCI execution through gVisor `runsc`, using the Systrap platform where supported.

Host capability checks happen during deployment and are repeated by the sandbox service before accepting jobs. The implementation must verify the actual runtime selected for each job; it must not assume that configuring an OCI runtime automatically means that runtime is in use.

If the required isolation backend is unavailable, misconfigured, or fails its health checks, Advanced execution is disabled. There is no automatic fallback to an ordinary `runc` container.

KVM and Firecracker are not baseline requirements. A future backend may use microVMs where the host supports them, without changing the agent-facing execution contract.

### 5.3 Job defaults

Unless a reviewed policy explicitly grants otherwise:
- one fresh environment per job;
- non-root user inside the job;
- read-only base image;
- ephemeral writable job directory;
- no host filesystem mounts;
- no host or container-runtime sockets;
- no credentials or ambient service identity;
- no inbound connections;
- outbound network denied by default;
- CPU, memory, process-count, disk, output-size, and wall-clock limits;
- bounded logs and artifacts;
- forced termination on timeout;
- destruction after result collection.

Network access, if later required, must go through a controlled egress component with destination and protocol policy. A general-purpose unrestricted network is not an acceptable default.

## 6. Data and tenant isolation

- Tenant identity is established by authenticated platform context, never trusted from model output.
- Every database query and object-storage operation is tenant-scoped and authorization-checked.
- Tenant data must not be shared through writable host paths.
- Runtime state, workspaces, credentials, and audit records are separated by tenant.
- Cross-tenant access tests are release blockers.
- Tenant-specific encryption and retention policies are enforced by platform services.

## 7. DSH production profile

The first Restricted Agent composition is implemented as the standalone `sdk-minimal` bundle plus the reviewed overlay in [`restricted-profile.md`](restricted-profile.md). It deliberately avoids `dsh-base`, whose shared tool roster is broader than this first SaaS runtime needs.

Production DSH bundles must be deliberately assembled from an allowlist of required capabilities.

The initial Restricted profile must not expose:
- local shell execution;
- arbitrary code/PTC execution in the DSH process;
- unrestricted local filesystem tools;
- unrestricted web fetch;
- arbitrary plugin installation;
- arbitrary MCP server execution;
- local credential stores containing integration secrets.

Advanced execution is exposed only through the broker-backed `run_code` tool.

The exact Cordis bundle and capability IDs must be verified against the pinned DSH commit before implementation. Do not assume a capability is disabled merely because its UI is hidden.

## 8. Security invariants

1. Model output cannot grant itself permissions.
2. Tenant and agent identity come from authenticated server-side context.
3. DSH cannot read long-lived integration credentials.
4. DSH cannot control the host container runtime.
5. Untrusted code never executes in the DSH process.
6. Advanced jobs receive no ambient secrets or host identity.
7. Network egress is denied unless explicitly authorized.
8. Missing or unhealthy isolation means execution is denied.
9. No cross-tenant data access is permitted.
10. Every privileged operation is auditable.

## 9. Implementation order

1. Document the threat model and security invariants.
2. Inventory DSH capabilities in the pinned upstream commit.
3. Build a Restricted DSH profile from an explicit allowlist.
4. Remove or replace local credential access in production runtime.
5. Implement workload identity and Tool Gateway authorization.
6. Implement the execution provider contract and host capability checks.
7. Implement the first gVisor-backed execution provider.
8. Add network, resource, filesystem, and lifecycle enforcement.
9. Add adversarial and cross-tenant regression tests.
10. Only then consider production deployment.

## 10. References

- [gVisor documentation](https://gvisor.dev/docs/)
- [gVisor platform selection](https://gvisor.dev/docs/user_guide/platforms/)
- [gVisor security model](https://gvisor.dev/docs/architecture_guide/intro/)
- [DSH upstream repository](https://github.com/deepseek-ai/deepseek-harness)
