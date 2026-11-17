# Threat Model

English | [中文](threat-model.zh.md)

**Status:** Initial baseline  
**Scope:** Multi-tenant SaaS using DSH on Linux hosts.

## 1. Security objectives

Protect:
- customer data and files;
- integration credentials and platform secrets;
- tenant and agent identities;
- Control Plane and host infrastructure;
- execution jobs and generated artifacts;
- service availability and resource budgets.

Required outcomes:
- no cross-tenant access;
- no agent access to long-lived credentials;
- no model-generated code execution in the DSH or Control Plane process;
- no host control from an agent runtime;
- no unapproved network egress from execution jobs;
- auditable privileged actions.

## 2. Threat actors

- malicious or compromised tenant user;
- prompt-injection content in documents, websites, emails, and tool results;
- model output that is incorrect or intentionally adversarial;
- malicious or compromised plugin, MCP server, or dependency;
- compromised DSH runtime;
- malicious code submitted to Advanced execution;
- external attacker targeting public APIs or infrastructure;
- compromised integration or credential.

## 3. Assets and trust boundaries

| Asset | Primary boundary |
|---|---|
| Tenant data | Tenant-aware data services and storage |
| Integration credentials | Credential Broker |
| Platform signing keys | Control Plane secret storage |
| Workload identity | Short-lived scoped identity |
| DSH runtime | Tenant-scoped runtime boundary |
| Host and container runtime | Host administration boundary |
| Advanced job | Execution sandbox boundary |
| Audit records | Restricted append-oriented audit service |

Trust boundaries:
1. Internet to API Gateway.
2. Tenant/user to Control Plane.
3. Control Plane to DSH Runtime.
4. DSH Runtime to Tool Gateway.
5. Tool Gateway to Credential Broker and external integrations.
6. DSH Runtime to Execution Broker.
7. Execution job to host, network, and artifact services.
8. One tenant's services and data to another tenant's services and data.

## 4. Main threat scenarios

### T1. Cross-tenant data access

**Scenario:** A model changes a tenant identifier in a tool argument, or a compromised runtime requests another tenant's object.

**Required controls:**
- verify the workload-token signature, issuer, audience, and expiration at the Tool Gateway;
- derive tenant identity from verified claims, never from request arguments;
- enforce tenant filters in the service and data-access layers;
- test direct-object-reference and confused-deputy cases.

### T2. Credential theft by an agent

**Scenario:** The model invokes shell, reads files, inspects environment variables, or exploits a tool to obtain integration or platform secrets.

**Required controls:**
- no long-lived integration secrets in DSH files or environment;
- keep the workload-token signing private key in the Control Plane; runtime and gateway processes receive public keys only;
- no host home-directory mounts;
- Credential Broker keeps secrets server-side;
- tool operations use credentials internally and return only authorized results;
- no secrets in prompts, logs, traces, or artifacts.

### T3. Host compromise through code execution

**Scenario:** Advanced code attempts to escape its sandbox, inspect host files, access runtime sockets, or interfere with other jobs.

**Required controls:**
- execute only through Execution Broker;
- use a verified isolation runtime;
- no host mounts or sockets;
- non-root execution and resource limits;
- deny execution if isolation checks fail;
- adversarial sandbox escape testing before production.

### T4. Server-side request forgery and network pivoting

**Scenario:** An agent or job accesses loopback services, private networks, cloud metadata, databases, or control endpoints.

**Required controls:**
- deny egress by default;
- controlled egress proxy for approved destinations;
- block loopback, link-local, private, and metadata destinations unless explicitly required by a separately reviewed policy;
- validate resolved IPs and redirects, not only the original hostname;
- isolate control and data-plane networks.

### T5. Prompt injection and unauthorized tool use

**Scenario:** Untrusted content instructs the model to disclose data or invoke a privileged operation.

**Required controls:**
- authorization outside the model;
- per-tool and per-object policy checks;
- high-impact actions require explicit policy or human approval;
- untrusted content cannot modify system policy or workload identity;
- tool outputs are treated as untrusted input.

### T6. Malicious extension or MCP server

**Scenario:** Third-party code executes in the DSH process or with the host user's privileges.

**Required controls:**
- production extension allowlist;
- dependency pinning and provenance review;
- no arbitrary MCP server launch from tenant configuration;
- isolate third-party integrations in separate services where required;
- do not treat plugin boundaries as security boundaries.

### T7. Denial of service and cost exhaustion

**Scenario:** A tenant submits infinite loops, fork bombs, huge outputs, or excessive concurrent jobs.

**Required controls:**
- CPU, memory, PID, disk, output, wall-clock, and concurrency quotas;
- per-tenant rate limits and budgets;
- cancellation and forced termination;
- queue backpressure;
- bounded logs and artifacts.

### T8. Secret or customer-data leakage through observability

**Scenario:** Prompts, tool results, credentials, or customer files are copied into logs, traces, telemetry, or support bundles.

**Required controls:**
- data minimization by default;
- redact credentials and sensitive payloads;
- explicit retention and access policy;
- no session upload to external services by default;
- audit metadata separated from sensitive content.

## 5. Assumptions and limitations

- The host OS and its administrator are trusted.
- The VPS provider and physical host are outside the platform's control; provider-specific confidential-computing guarantees are not assumed.
- gVisor is an isolation layer, not a reason to expose host files or secrets to a job.
- No sandbox is assumed to be escape-proof.
- DSH's built-in approval, filesystem sandbox, and prompt instructions are not substitutes for server-side authorization and process isolation.
- The first release targets Linux only.
- The first release does not require KVM, Firecracker, or a provider-specific virtualization API.

## 6. Release-blocking security tests

- A tenant cannot read, update, or infer another tenant's records or artifacts.
- A DSH runtime cannot read host credentials, integration credentials, SSH keys, or platform signing keys.
- A DSH runtime cannot access Docker/containerd sockets or create host containers.
- Advanced job cannot read host files or another job's files.
- Advanced job cannot reach Control Plane, metadata, loopback, or private network destinations by default.
- Runtime misconfiguration causes job creation to fail closed.
- CPU, memory, PID, disk, output, and time limits are enforced.
- Secrets do not appear in logs, traces, prompts, or returned artifacts.
- A job is terminated and its writable environment destroyed after completion or timeout.

Passing these tests is necessary but not sufficient for a production security claim. A separate security review and penetration test are still required.
