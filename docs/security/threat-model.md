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
| Integration credentials | Tool Gateway and server-side integration-credential storage |
| Provider credentials | Encrypted Control Plane storage; request-scoped access by Model Gateway |
| Platform signing keys | Control Plane secret storage |
| Workload identity | Short-lived audience-scoped identity |
| DSH runtime | Tenant-scoped runtime boundary |
| Host and container runtime | Host administration boundary |
| Advanced job | Execution sandbox boundary |
| Audit records | Restricted append-oriented audit service |

Trust boundaries:
1. Internet to API Gateway.
2. Tenant/user to Control Plane.
3. Control Plane to Credential Broker over host-authenticated mTLS.
4. Credential Broker to DSH Runtime over the per-Runtime Unix Domain Socket.
5. DSH Runtime to Model Gateway using the exact audience `dsh-model-gateway`.
6. DSH Runtime to Tool Gateway using the exact audience `dsh-tool-gateway`.
7. Model Gateway to Control Plane provider-credential and policy APIs over authenticated TLS.
8. Tool Gateway to server-side integration-credential storage and external integrations.
9. DSH Runtime to Execution Broker.
10. Execution job to host, network, and artifact services.
11. One tenant's services and data to another tenant's services and data.

## 4. Main threat scenarios

### T1. Cross-tenant data access

**Scenario:** A model changes a tenant identifier in a tool argument, or a compromised runtime requests another tenant's object.

**Required controls:**
- verify workload-token signature, issuer, exact service-specific audience, expiration, and required capabilities independently at Model Gateway and Tool Gateway;
- derive tenant, agent, and Runtime identity only from verified claims, never from request arguments;
- have Control Plane derive token claims and permitted capabilities from the registered Host/Runtime binding and server-side Runtime policy, not from caller-supplied identity or capability fields;
- have Model Gateway forward the original Runtime token to authenticated Control Plane APIs, where Control Plane independently verifies the token and active binding before returning provider credentials or protected policy data;
- enforce tenant filters in the service and data-access layers;
- test wrong-audience, wrong-capability, direct-object-reference, and confused-deputy cases.

### T2. Credential theft by an agent

**Scenario:** The model invokes shell, reads files, inspects environment variables, or exploits a tool to obtain integration or platform secrets.

**Required controls:**
- no long-lived integration or provider credentials in DSH Runtime files, environment, prompts, or model-visible tool interfaces;
- keep the workload-token signing private key exclusively in Control Plane; provision public verification keys to each service that verifies workload tokens, including Model Gateway and Tool Gateway;
- Credential Broker handles only short-lived workload-token requests and relay; it never stores, retrieves, or serves provider or integration credentials;
- authenticate Runtime to Broker with per-Runtime Unix socket peer credentials and authenticate Broker to Control Plane with Host mTLS;
- issue separate short-lived tokens for the exact Model Gateway and Tool Gateway audiences; Control Plane derives capabilities from server-side Runtime policy;
- have Model Gateway resolve provider credentials from Control Plane over authenticated TLS using its dedicated service identity and the original Runtime token; hold decrypted values in request scope only;
- have Tool Gateway use integration credentials through server-side credential storage for a specific authorized operation;
- no host home-directory mounts;
- no secrets or bearer tokens in prompts, tool arguments/results, errors, logs, traces, or artifacts.

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
- A DSH runtime cannot read host credentials, integration credentials, provider credentials, SSH keys, or platform signing keys.
- Credential Broker cannot access provider or integration credentials and cannot mint tokens or broaden Control-Plane-signed claims.
- A token issued for Model Gateway is rejected by Tool Gateway, and vice versa; both Gateways reject missing capabilities.
- Control Plane rejects Broker token requests for unregistered/inactive Host or Runtime identities and derives capabilities from server-side policy.
- A DSH runtime cannot access Docker/containerd sockets or create host containers.
- Advanced job cannot read host files or another job's files.
- Advanced job cannot reach Control Plane, metadata, loopback, or private network destinations by default.
- Runtime misconfiguration causes job creation to fail closed.
- CPU, memory, PID, disk, output, and time limits are enforced.
- Secrets do not appear in logs, traces, prompts, or returned artifacts.
- A job is terminated and its writable environment destroyed after completion or timeout.

Passing these tests is necessary but not sufficient for a production security claim. A separate security review and penetration test are still required.
