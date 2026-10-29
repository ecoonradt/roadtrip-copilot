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
| **ADR-0005** | 2026-10-18 | AWS CDK IaC, GitHub Actions CI/CD & Continuous Deployment | Accepted | Establishes Milestone 0 (`infra/` CDK + `scripts/deploy_cloud.sh` + GitHub Actions) and requires CDK + live AWS deploy + manual check in every milestone. | [0005-cdk-iac-and-github-actions-cicd.md](decisions/0005-cdk-iac-and-github-actions-cicd.md) |
| **ADR-0006** | 2026-10-18 | Scoped IAM CI Deployer Under AWS Project SCP (Migrated to Keyless OIDC) | Accepted | Originally provisioned a scoped IAM machine user due to SCP `DenyIAMRestrictedActions`; updated to keyless GitHub Actions OIDC federation ([Issue #7](https://github.com/ecoonradt/roadtrip-copilot/issues/7)) after activating Advanced Features. | [0006-aws-project-scp-iam-ci-deployer.md](decisions/0006-aws-project-scp-iam-ci-deployer.md) |
| **ADR-0007** | 2026-10-19 | Runtime SSM SecureString Resolution & CloudFront Forwarded Host | Accepted | Resolves `/roadtrip-copilot/*` SSM `SecureString` secrets at runtime via `@aws-sdk/client-ssm` and preserves viewer `Host` via a CloudFront `/api/*` `VIEWER_REQUEST` function. | [0007-ssm-secure-runtime-config-and-cloudfront-forwarded-host.md](decisions/0007-ssm-secure-runtime-config-and-cloudfront-forwarded-host.md) |
| **ADR-0008** | 2026-10-21 | In-Process Keyed Mutex for Local Storage Concurrency | Accepted | Replaces flawed cross-process lockfile protocol with single-process FIFO keyed mutex; S3 conditional writes provide cross-process safety in production. | [0008-local-storage-in-process-lock.md](decisions/0008-local-storage-in-process-lock.md) |
| **ADR-0009** | 2026-10-22 | Authenticated Amazon ECR Public Pulls for Container Builds | Accepted | `deploy_cloud.sh` authenticates Docker to `public.ecr.aws` before the CDK asset build, backed by `ecr-public:GetAuthorizationToken` + `sts:GetServiceBearerToken`, to escape the shared anonymous 500 GB/month pull quota that fails CI with HTTP 429. | [0009-ecr-public-authenticated-pulls.md](decisions/0009-ecr-public-authenticated-pulls.md) |
| **ADR-0010** | 2026-10-22 | Bedrock Inference Profiles, Model Availability & Reasoning Hygiene | Accepted | Uses catalog-listed `us-east-2` defaults (`us.moonshotai.kimi-k3` & `us.amazon.nova-2-lite-v1:0`), normalizes `us.*` inference profile aliases, filters availability via `GetFoundationModelAvailability` + `ListInferenceProfiles`, grants IAM on both `foundation-model/*` and `inference-profile/*`, and strips `reasoningContent` / `<thinking>` tags. Live invocation pending account-level Error 002. | [0010-bedrock-inference-profiles-and-model-catalog.md](decisions/0010-bedrock-inference-profiles-and-model-catalog.md) |
| **ADR-0011** | 2026-10-23 | AWS-Driven Bedrock Model Discovery with Explicit Exclusions | Accepted | Supersedes ADR-0010's curated catalog/admission policy with AWS-driven discovery, compatibility/account-access checks, explicit exclusions, and validation against discovered eligibility. M3 defect corrections remain in WP-03, not this ADR. | [0011-bedrock-discovery-with-exclusions-and-lifecycle-integrity.md](decisions/0011-bedrock-discovery-with-exclusions-and-lifecycle-integrity.md) |
| **ADR-0012** | 2026-10-25 | Verified Place Evidence, Not Search-Query Echoes | Accepted | Ground branch qualifiers in returned entity names/addresses, never the model's echoed search input; preserve exact-ID precedence and conservative no-match behavior. | [0012-grounding-evidence-provenance.md](decisions/0012-grounding-evidence-provenance.md) |
| **ADR-0013** | 2026-10-28 | Single-User Accurate Per-User Spend Ledger Ahead of Deferred Multi-User Stripe Billing | Accepted | Inserts M4.5 to track exact per-user Bedrock token, Places/Brave tool, and allocated AWS infra (Lambda/S3/CloudFront) spend in `users/{email}/spend.json` using integer nanodollars, verified `us-east-2` pricing with fail-closed model admission, `finally`-block capture, and CLI account-level reconciliation (`./scripts/check_spend.sh --aws-metrics` / `--aws-bill`) for Phase 2 break-even pricing. | [0013-accurate-per-user-spend-ledger.md](decisions/0013-accurate-per-user-spend-ledger.md) |

---

## How to Record a New ADR
1. Copy [`decisions/0000-template.md`](decisions/0000-template.md) to `decisions/XXXX-<slug>.md` (incrementing the 4-digit number).
2. Fill out Context, Decision Drivers, Considered Options, Outcome, and Implementation Notes.
3. Add a row to the table above with status, summary, and relative file link.
4. Record the decision in the active work package under `docs/projects/route-scout-cloud/plan/active/`.
