# ADR-011: Smallstep step-ca for VPS host certificates

- **Status:** Accepted
- **Date:** 2026-11-17
- **Related product decisions:** PD-030
- **Related ADRs:** ADR-002, ADR-003

## Context

Each VPS must authenticate to the Control Plane using a unique host client certificate and TLS 1.3 mutual authentication. The platform needs initial certificate enrollment, renewal, and a way to retire/revoke host credentials without implementing a certificate authority from scratch.

The product owner approved the simplest operational option and explicitly rejected unnecessary infrastructure complexity.

## Decision

1. Use the self-hosted open-source **Smallstep step-ca** as the platform Certificate Authority (CA) for VPS host X.509 certificates.
2. Use it for host client certificates used by Credential Broker when authenticating to the Control Plane over mTLS.
3. Keep the VPS host private key generated locally on that VPS. The private key never leaves the host; enrollment sends a CSR.
4. Use step-ca's certificate issuance and renewal capabilities for the host certificate lifecycle. Select and configure the appropriate provisioner and renewal flow during implementation.
5. Keep the one-time bootstrap credential short-lived and single-use. The enrollment workflow must bind the issued certificate to a server-registered host identity; a CSR's requested names are not authoritative.
6. Keep the Control Plane Ed25519 workload-token signing key separate from the step-ca CA keys. The Control Plane remains the only workload-token issuer. step-ca issues X.509 host certificates; it does not issue DSH workload tokens.
7. Do not introduce HashiCorp Vault, HSM, Kubernetes, or a custom CA implementation for the initial production version.
8. Keep the first deployment operationally small: step-ca is a separate CA service, and the platform integrates with its documented enrollment/renewal interface.

## Security and operational constraints

- Protect step-ca's CA keys and password material; do not commit them to source control or expose them to DSH Runtime, Agent, Model Gateway, or Credential Broker.
- Restrict CA administration to trusted operators and the Control Plane enrollment integration.
- Use a dedicated enrollment provisioner with narrow issuance scope; never expose a general-purpose CA provisioner to Runtime or Agent.
- Validate certificate chain, expected client-auth usage, host identity, and certificate lifetime at the Control Plane.
- Renewal must occur before expiry. Revocation/retirement must be part of host deprovisioning and incident response.
- Do not treat successful certificate issuance as proof that a host is authorized for a Tenant; authorization remains a Control Plane registry decision.

## Consequences

- We reuse an existing CA implementation rather than writing certificate issuance, renewal, and revocation infrastructure ourselves.
- Initial provisioning requires a trusted bootstrap flow and step-ca enrollment configuration.
- The Control Plane still needs host registration, bootstrap credential consumption, CSR authorization, host-to-Runtime registry checks, and workload-token issuance.
- CA key backup, recovery, upgrades, and access control become operational responsibilities.
- Exact provisioner type, certificate lifetime, CA placement, and backup procedure are implementation details to decide during deployment design; they are not additional product decisions in this ADR.

## Implementation status

**Decision accepted; not implemented yet.** The repository does not yet contain a deployed step-ca instance, enrollment flow, certificate lifecycle manager, or Control Plane endpoints. Do not mark host mTLS production-ready until those pieces and end-to-end enrollment/renewal/revocation tests exist.

## References

- [Smallstep step-ca documentation](https://smallstep.com/docs/step-ca/)
- [Certificate provisioners](https://smallstep.com/docs/step-ca/provisioners/)
- [Certificate renewal](https://smallstep.com/docs/step-ca/renewal/)
