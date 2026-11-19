# SaaS Restricted DSH profile

English | [中文](restricted-profile.zh.md)

**Status:** Initial capability-restricted profile  
**Base:** `@deepseek-ai/dsh-sdk-minimal`  
**Target:** Linux server deployments

## Purpose

The profile provides the DSH agent loop and SDK JSON-RPC transport without exposing local command execution, general filesystem tools, working-directory mutation, or MCP resources to the model.

It is the starting runtime for Restricted Agents. Business integrations will be added later as explicitly registered tools that call the platform Tool Gateway.

## Applied overlay

The overlay lives at:

`deploy/profiles/saas-restricted/cordis.patch.yml`

It must be applied after the standalone `sdk-minimal` bundle.

The overlay disables:

- `terminal-bash` and `terminal-pwsh`;
- `persistent-bash` and `persistent-pwsh`;
- `tool-fs`;
- `tool-working-directory`;
- `mcp-resources`;
- `session-log-deepseek`.

It also changes `sandbox-policy.mode` from `danger-full-access` to `read-only`. Cordis patch layers replace a row's complete `config`, so `workspaceRoot` is restated intentionally.

The standalone `sdk-minimal` composition does not include the general Web fetch/search tools, PTC runtime/executor, or plugin-manager tool. The regression test checks the known execution entry points and the exact overlay rows against the pinned composition.

## Local launch

From the repository root, initialize the custom profile once and apply the overlay:

```bash
dsh --profile saas-restricted \
  --from-default-profile sdk-minimal \
  --patch ./deploy/profiles/saas-restricted/cordis.patch.yml
```

On subsequent launches, keep applying the overlay:

```bash
dsh --profile saas-restricted \
  --patch ./deploy/profiles/saas-restricted/cordis.patch.yml
```

The SDK profile owns stdin/stdout for JSON-RPC. Do not expose that process directly to the public Internet; the platform API Gateway must authenticate clients and communicate with the runtime over a private local transport.

## Security limits

This profile is not, by itself, a production security boundary.

- It removes model-visible local execution and filesystem tools; it does not isolate the DSH process from the Linux host.
- The standalone `sdk-minimal` profile currently uses direct provider authentication (for DeepSeek, `DEEPSEEK_API_KEY`) inside the DSH process. This is development/SDK behavior only, not the production SaaS credential boundary. Production Runtime must use the provider-independent Model Gateway; provider API keys and OAuth refresh tokens stay outside Runtime. Direct provider egress from production Runtime must be denied.
- The profile's `cordis.patch.yml`, home-level patch, and launch overlays are trusted deployment configuration. Tenant users must not be allowed to edit them or supply arbitrary `--patch` arguments.
- Use a separate restricted Linux runtime and DSH home per tenant. Do not mount host home directories, SSH material, container-runtime sockets, or platform secrets.
- This profile does not yet implement Tool Gateway, Credential Broker, or Advanced Execution Broker. It must not be advertised as production-ready until those boundaries and their tests exist.

## Next implementation

1. Add a platform-owned native tool that calls the Tool Gateway using a short-lived token issued by the Workload Identity package.
2. Enforce tenant and agent identity server-side; never accept them from model-supplied tool arguments.
3. Implement the provider-independent Model Gateway for multiple providers (not only DeepSeek); move all production model-provider credentials and provider protocol handling behind it.
4. Add cross-tenant and prompt-injection regression tests.
5. Implement Advanced execution separately through the Execution Broker and a verified sandbox backend.
