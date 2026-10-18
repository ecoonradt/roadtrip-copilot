# Route Scout Cloud: Architecture Decision Records (ADRs)

This document is the high-level Table of Contents and index for all Architecture Decision Records (ADRs) made during the **Route Scout Cloud Architecture** project.

> [!TIP]
> **Instructions for AI Agents & Developers:**  
> Before modifying cloud backend or mobile client code, read this table to understand the core technical decisions that govern this system. If you discover a technical constraint or need to diverge from the original plan, **do not make silent changes**. Instead, draft a new ADR using [`0000-template.md`](decisions/0000-template.md), link it here, and record the discovery in the active Work Package.
>
> At the conclusion of this major cloud project, decisions with lasting cross-project relevance will be compressed and hoisted up to `docs/reference/` and `AGENTS.md`.

---

## Decision Index

| ID | Date | Title | Status | Summary | Details |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **ADR-0001** | 2026-10-17 | Amazon Bedrock for Unified Multi-Model AI Routing | Accepted | Unified multi-provider AI via `@aws-sdk/client-bedrock-runtime` (`ConverseStream`) under a single AWS invoice with zero idle fees. | [0001-amazon-bedrock-single-bill-ai.md](decisions/0001-amazon-bedrock-single-bill-ai.md) |
| **ADR-0002** | 2026-10-17 | Stateless Dual-Mode Google OIDC Authentication | Accepted | Google OIDC SSO (Web Session Cookie + Android Bearer JWT) with admin allowlist gating and zero third-party auth fees. | [0002-stateless-dual-mode-oidc-auth.md](decisions/0002-stateless-dual-mode-oidc-auth.md) |
| **ADR-0003** | 2026-10-17 | Amazon S3 Atomic JSON Persistence | Accepted | S3 object storage for itineraries and user wallets with conditional writes (`If-Match` / `If-None-Match`), ~$0.001/mo, zero DB maintenance. | [0003-s3-atomic-json-persistence.md](decisions/0003-s3-atomic-json-persistence.md) |
| **ADR-0004** | 2026-10-18 | Hybrid Local Feature Development Mode | Accepted | Preserves `npm run dev` for feature engineering: itineraries/state stay strictly on local disk (isolated from prod S3) while AI uses Bedrock via local AWS credentials. | [0004-hybrid-local-dev-mode.md](decisions/0004-hybrid-local-dev-mode.md) |
| **ADR-0005** | 2026-10-18 | AWS CDK IaC, GitHub Actions CI/CD & Continuous Deployment | Accepted | Establishes Milestone 0 (`infra/` CDK + `scripts/deploy_cloud.sh` + GitHub Actions with OIDC) and requires CDK + live AWS deploy + manual check in every milestone. | [0005-cdk-iac-and-github-actions-cicd.md](decisions/0005-cdk-iac-and-github-actions-cicd.md) |

---

## How to Record a New ADR
1. Copy [`decisions/0000-template.md`](decisions/0000-template.md) to `decisions/XXXX-<slug>.md` (incrementing the 4-digit number).
2. Fill out Context, Decision Drivers, Considered Options, Outcome, and Implementation Notes.
3. Add a row to the table above with status, summary, and relative file link.
4. Record the decision in the active work package under `docs/projects/route-scout-cloud/plan/active/`.
