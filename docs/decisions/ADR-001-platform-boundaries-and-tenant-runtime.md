# ADR-001: Platform boundaries and tenant-scoped DSH Runtime

- **Status:** Accepted
- **Date:** 2026-11-17
- **Decision owner:** Product owner
- **Related product decisions:** PD-001–PD-006

## Context

The project is a commercial multi-tenant SaaS platform for business AI agents, not merely a self-hosted DSH installation. Customers access their agents through an API and/or Web interface. DSH is useful as an Agent Runtime, but it is not the platform Control Plane and is not a security boundary by itself.

The platform is intended to run on Linux servers, including ordinary VPS infrastructure, without depending on a specific hosting provider's proprietary APIs.

## Decision

1. Build a multi-tenant SaaS platform around DSH.
2. Keep the Control Plane separate from DSH Agent Runtime and from the Execution Plane.
3. Use Linux Server as the target deployment platform.
4. Keep infrastructure provider-agnostic.
5. Use one tenant-scoped DSH Runtime per customer as the baseline isolation unit.
6. Support two agent classes:
   - **Restricted:** explicitly allowlisted business tools; no local shell or arbitrary code execution.
   - **Advanced:** Restricted capabilities plus code execution requested through the separate Execution Broker only.
7. Enforce permissions outside the model. Model output and prompt instructions cannot grant capabilities.

## Consequences

- Tenant identity, lifecycle, authentication, and policy decisions belong to platform services.
- DSH cannot be trusted to enforce tenant isolation by itself.
- Runtime state, workspaces, credentials, and data access must be tenant-scoped.
- Agents with materially different data scopes or privilege profiles require separate runtime boundaries.
- API/Web access, onboarding, billing, and customer-facing product surfaces are platform responsibilities, not DSH responsibilities.

## Implementation status

This ADR records the target architecture. It does not assert that every platform service or isolation control is already implemented.
