# Architecture Decision Records

This directory stores technical Architecture Decision Records (ADRs) for the bogachenko/deepseek-harness fork.

## Source of truth

- Product goals and approved product/architecture decisions: Google Drive `deepseek-harness/product/PRODUCT_DECISIONS`.
- Product scope and business model: Google Drive `deepseek-harness/product/PRODUCT_VISION`.
- Work status and next tasks: Google Drive `deepseek-harness/product/ROADMAP`.
- This directory: technical context, decision rationale, consequences, and implementation constraints.

## Workflow

1. Create an ADR when a technical decision is explicitly approved.
2. Use the next available `ADR-NNN` identifier.
3. Record status (`Proposed`, `Accepted`, `Superseded`, or `Cancelled`), date, context, decision, consequences, and related PD IDs.
4. Do not mark a proposal as accepted without explicit product-owner approval.
5. Do not treat an accepted ADR as proof of implementation. Verify code and tests separately.
6. When a decision changes, preserve the old ADR and mark it `Superseded`, linking the replacement.

## Records

- [ADR-001 — Platform boundaries and tenant-scoped DSH Runtime](ADR-001-platform-boundaries-and-tenant-runtime.md)
- [ADR-002 — Workload identity and secret boundary](ADR-002-workload-identity-and-secret-boundary.md)
- [ADR-003 — Credential Broker over Unix Domain Socket](ADR-003-credential-broker-unix-socket.md)
- [ADR-004 — Ephemeral isolated code execution](ADR-004-ephemeral-code-execution-isolation.md)

- [ADR-011 — Smallstep step-ca for VPS host certificates](ADR-011-smallstep-step-ca-for-host-certificates.md)
