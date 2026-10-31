# Route Scout Cloud: Tier 2 Phase Roadmap

This document is the **Tier 2 Phase Roadmap** for the **Route Scout Cloud Architecture** initiative, governed by the 3-Tier Rolling Wave Planning Model defined in [`WORKING_MODEL.md`](../WORKING_MODEL.md).

* **Tier 1 Blueprint:** [`route_scout_cloud_architecture.md`](../route_scout_cloud_architecture.md)
* **Architecture Decisions Index:** [`DECISIONS.md`](../DECISIONS.md)
* **Planning, Deployment & Documentation Rules:**
  1. **Zero Premature Micro-Tasks:** Each milestone defines its high-level scope and strict **Definition of Done (DoD)**, while detailed micro-tasks are only authored for the **single active milestone** in `plan/active/WP-XX-*.md`.
  2. **Continuous CDK + Live Cloud Verification ([ADR-0005](../decisions/0005-cdk-iac-and-github-actions-cicd.md)):** Infrastructure is never deferred to the end. Every milestone (M0 through M4) requires updating AWS CDK (`infra/`), running `scripts/ci_check.sh` (tests + `cdk synth`), deploying live to AWS (`scripts/deploy_cloud.sh` or GitHub Actions `workflow_dispatch`), and completing a **Manual Cloud Verification** check against the deployed CloudFront URL before the milestone is marked Done.
  3. **AWS Project-Based Selected Region Compliance:** All Regional AWS resources (Lambda, S3 buckets, ECR, Bedrock calls) **must** be created in the project's single assigned **selected Region** (resolved from `~/.aws/config` / `AWS_REGION` / `CDK_DEFAULT_REGION`, never hardcoded to another Region). CloudFront (global service) points directly to the S3 bucket and Lambda Function URL in the selected Region (never using `Lambda@Edge`).
  4. **Continuous Living Documentation (Zero Stale Non-Project Docs):** Every milestone's Definition of Done requires updating [`AGENTS.md`](../../../../AGENTS.md), [`README.md`](../../../../README.md), [`route-builder/AGENTS.md`](../../../../route-builder/AGENTS.md), [`route-builder/README.md`](../../../../route-builder/README.md), and [`docs/README.md`](../../../README.md) in lockstep with code and infrastructure changes so no end-of-project documentation cleanup pass is ever needed.

---

## Milestone Status Overview

| Milestone | Title | Phase | ADRs | Work Package | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **M0** | AWS CDK Foundation, Unified Deploy Scripts & GitHub Actions CI/CD | Phase 1 | [ADR-0003](../decisions/0003-s3-atomic-json-persistence.md), [ADR-0005](../decisions/0005-cdk-iac-and-github-actions-cicd.md), [ADR-0006](../decisions/0006-aws-project-scp-iam-ci-deployer.md) | [`WP-00-cdk-and-cicd-foundation.md`](archive/WP-00-cdk-and-cicd-foundation.md) | **Completed** |
| **M1** | Stateless Dual-Mode Google OIDC Auth & Allowlist Gating | Phase 1 | [ADR-0002](../decisions/0002-stateless-dual-mode-oidc-auth.md), [ADR-0004](../decisions/0004-hybrid-local-dev-mode.md), [ADR-0005](../decisions/0005-cdk-iac-and-github-actions-cicd.md), [ADR-0007](../decisions/0007-ssm-secure-runtime-config-and-cloudfront-forwarded-host.md) | [`WP-01-dual-mode-oidc-auth.md`](archive/WP-01-dual-mode-oidc-auth.md) | **Completed** |
| **M2** | Amazon S3 Atomic Itinerary Storage Service | Phase 1 | [ADR-0003](../decisions/0003-s3-atomic-json-persistence.md), [ADR-0004](../decisions/0004-hybrid-local-dev-mode.md), [ADR-0005](../decisions/0005-cdk-iac-and-github-actions-cicd.md), [ADR-0008](../decisions/0008-local-storage-in-process-lock.md), [ADR-0009](../decisions/0009-ecr-public-authenticated-pulls.md) | [`WP-02-s3-itinerary-storage.md`](archive/WP-02-s3-itinerary-storage.md) | **Completed** |
| **M3** | Amazon Bedrock Adapter & Configurable Model Selection | Phase 1 | [ADR-0001](../decisions/0001-amazon-bedrock-single-bill-ai.md), [ADR-0004](../decisions/0004-hybrid-local-dev-mode.md), [ADR-0005](../decisions/0005-cdk-iac-and-github-actions-cicd.md), [ADR-0010](../decisions/0010-bedrock-inference-profiles-and-model-catalog.md), [ADR-0011](../decisions/0011-bedrock-discovery-with-exclusions-and-lifecycle-integrity.md) | [`WP-03-bedrock-adapter-and-model-selection.md`](archive/WP-03-bedrock-adapter-and-model-selection.md) | **Code Complete, Live Verification Pending (AWS Support)** |
| **M4** | Discovery + Deterministic Domain Grounding Tool Library | Phase 1 | [ADR-0001](../decisions/0001-amazon-bedrock-single-bill-ai.md), [ADR-0005](../decisions/0005-cdk-iac-and-github-actions-cicd.md), [ADR-0007](../decisions/0007-ssm-secure-runtime-config-and-cloudfront-forwarded-host.md), [ADR-0012](../decisions/0012-grounding-evidence-provenance.md) | [`WP-04-scout-grounding-tools.md`](archive/WP-04-scout-grounding-tools.md) | **Code Complete, Live Verification Pending (AWS Support)** |
| **M4.5** | Auditable Single-User Spend Instrumentation & Reconciliation | Phase 1 | [ADR-0003](../decisions/0003-s3-atomic-json-persistence.md), [ADR-0004](../decisions/0004-hybrid-local-dev-mode.md), [ADR-0008](../decisions/0008-local-storage-in-process-lock.md), [ADR-0011](../decisions/0011-bedrock-discovery-with-exclusions-and-lifecycle-integrity.md), [ADR-0013](../decisions/0013-auditable-spend-events-and-reconciliation.md) | [Specification](M4.5-spend-instrumentation-spec.md); [active checkpoint A](active/WP-04.5-user-spend-tracking.md) | **Planned — Hardened; A active, implementation not started** |
| **M5** | Stripe Prepaid Checkout & S3 Atomic Wallet Ledger | Phase 2 | [ADR-0003](../decisions/0003-s3-atomic-json-persistence.md), [ADR-0005](../decisions/0005-cdk-iac-and-github-actions-cicd.md) | *Deferred to Phase 2* | Deferred (Phase 2) |

*Note on M3/M4 Live Bedrock Invocation: All code, unit/browser/CDK tests, decoupled OIDC CI/CD deployment, and AWS infrastructure (Lambda, S3, CloudFront, SSM Parameter Store) are deployed and operational. Live model token generation via Amazon Bedrock remains blocked by open AWS Support Case `179276529500150` (account-level Error 002).*

*(Note: Because M0 establishes the live CDK stack and M1–M4 deploy incrementally at every step, the legacy standalone "Step 5: Deployment" milestone is retired per [ADR-0005](../decisions/0005-cdk-iac-and-github-actions-cicd.md). Phase 2 Android native client work—Tier 1 offline route editing and Tier 2 cloud sync/mobile Route Scout—is tracked in the companion project [`docs/projects/android-route-client/`](../../android-route-client/android_route_editing_and_cloud_client.md) and unblocks upon completion of M4).*

---

## Phase 1: Private Single-User AWS Deployment ($0.00/Month Idle)

### Milestone 0 (M0): AWS CDK Foundation, Unified Deploy Scripts & GitHub Actions CI/CD
* **Objective:** Migrate repository hosting to GitHub, author the TypeScript AWS CDK infrastructure workspace (`infra/`) for zero-idle serverless hosting (S3 static SPA bucket, S3 app data bucket, Fastify Lambda container with AWS Lambda Web Adapter `RESPONSE_STREAM`, CloudFront single-domain distribution, and GitHub Actions OIDC IAM role), and establish unified local + CI scripts (`scripts/ci_check.sh` and `scripts/deploy_cloud.sh`) wired to GitHub Actions (`ci.yml` and `deploy.yml`).
* **Definition of Done (DoD):**
  1. **GitHub Migration:** Repository remote switched to GitHub, with branch protection rules configured on `main` requiring `ci.yml` status checks to pass before merging.
  2. **AWS CDK Stack (`infra/`):** Defines `RoadtripCopilotCloudStack` provisioning:
     * Private S3 Static Assets Bucket (`/*` via CloudFront Origin Access Control, with SPA fallback routing).
     * Private S3 App Data Bucket (`users/*` for future M2 itineraries and M5 wallets).
     * Fastify Lambda Function packaged with AWS Lambda Web Adapter (`AWS_LWA_INVOKE_MODE=response_stream`) and Function URL (`InvokeMode.RESPONSE_STREAM`).
     * Single-Domain CloudFront Distribution routing `/api/*` (caching disabled, forwarding cookies/headers/query strings, 60s origin read timeout) to the Lambda Function URL and `/*` to the S3 Static Bucket.
     * Keyless GitHub Actions OIDC IAM Provider & Deployment Role scoped to the GitHub repository.
  3. **Unified Verification & Deployment Scripts:**
     * `scripts/ci_check.sh`: Runs `route-builder` tests + build, Android unit tests (`./gradlew testDebugUnitTest`), and `infra` CDK tests + `cdk synth`.
     * `scripts/deploy_cloud.sh`: Executable on-demand from a local developer terminal or GitHub Actions; builds `route-builder`, runs `cdk deploy`, syncs `route-builder/dist/` to S3, invalidates CloudFront, and runs a post-deploy `/api/health` smoke check.
  4. **GitHub Actions Workflows (`.github/workflows/`):**
     * `ci.yml`: Runs `scripts/ci_check.sh` on `push` to `main` and pull requests.
     * `deploy.yml`: Runs `scripts/ci_check.sh` + `scripts/deploy_cloud.sh` via AWS OIDC on merges to `main` and on-demand via `workflow_dispatch` on any branch.
  5. **Live Deployment & Manual Cloud Verification:**
     * Stack deployed to AWS via `./scripts/deploy_cloud.sh` (and verified via GitHub Actions `workflow_dispatch`).
     * Manual verification confirms `https://<cloudfront-domain>/api/health` returns `200 OK` and opening `https://<cloudfront-domain>/` in a browser loads the Route Builder Web Studio with live OSRM routing.

---

### Milestone 1 (M1): Stateless Dual-Mode Google OIDC Auth & Allowlist Gating
* **Objective:** Protect `/api/*` endpoints with zero-trust Google OpenID Connect (OIDC) authentication supporting both Web Browser sessions (`HTTP-Only` signed JWT cookies) and Android native clients (`Authorization: Bearer <jwt>` headers), gated by an `ALLOWED_EMAILS` admin allowlist, while preserving frictionless local development bypass when `AUTH_ENABLED !== 'true'`.
* **Definition of Done (DoD):**
  1. Fastify `authGuard` `preHandler` hook validates either the `copilot_session` cookie or `Authorization: Bearer` JWT header in `<1ms` when `AUTH_ENABLED === 'true'`, attaching `request.authUser` (`email`, `name`, `picture`, `sub`).
  2. Unauthenticated requests to protected `/api/*` routes return `HTTP 401 Unauthorized`; authenticated requests whose email is not in `ALLOWED_EMAILS` return `HTTP 403 Forbidden`.
  3. Auth endpoints implemented and tested: `GET /api/auth/status`, `GET /api/auth/google` (OAuth2 PKCE/state redirect), `GET /api/auth/callback/google` (code exchange, Google ID token verification, cookie issuance), `POST /api/auth/mobile/google` (Android native Google ID token verification returning signed Bearer JWT), and `POST /api/auth/logout`.
  4. When `AUTH_ENABLED !== 'true'` (default in `npm run dev` and existing tests per ADR-0004), `authGuard` bypasses OIDC enforcement and injects a deterministic local dev user (`local-dev@localhost`).
  5. React Web Studio queries `GET /api/auth/status` on startup, renders a clean Google Sign-In gate when `authEnabled && !authenticated`, and displays the signed-in user indicator + sign-out control in `AppHeader.tsx`.
  6. **CDK & Infrastructure Update:** `infra/` updated to configure `AUTH_ENABLED="true"`, `ALLOWED_EMAILS`, `GOOGLE_CLIENT_ID`, and SSM SecureString / Secrets Manager references for `GOOGLE_CLIENT_SECRET` and `JWT_SECRET` on the Fastify Lambda function, plus CloudFront cookie/header forwarding verification.
  7. **Automated & Live Cloud Verification:**
     * `scripts/ci_check.sh` (`npm test`, `npm run build`, `cdk synth`) passes with zero errors.
     * Deployed to AWS via `./scripts/deploy_cloud.sh` (or `workflow_dispatch`).
     * **Manual Verification:** Visiting the live CloudFront URL in an incognito browser blocks `/api/itineraries` with `401` and presents the Google Sign-In screen; signing in with an non-allowlisted Google account shows the `403` private preview screen; signing in with Eric's allowlisted Google account issues the secure cookie and loads the studio; clicking Sign Out clears the session.

---

### Milestone 2 (M2): Amazon S3 Atomic Itinerary Storage Service
* **Objective:** Extend `ItineraryStorageService` to persist and retrieve user itineraries in Amazon S3 (`s3://<data-bucket>/users/{email}/itineraries/{slug}.json`) with conditional write safety (`If-Match` / `ETag`) when `S3_STORAGE_BUCKET` is configured, while keeping local filesystem storage (`itineraries/*.json`) strictly isolated for `npm run dev` per ADR-0003 and ADR-0004.
* **Definition of Done (DoD):**
  1. S3 storage adapter implemented using `@aws-sdk/client-s3` scoped to `request.authUser.email` (`users/{email}/itineraries/`). The bundled sample file is gone: `src/engine/sampleTrip.ts` is the single source of truth and the sample is offered only when starting a new route, never as a storage fallback.
  2. First-run and empty-workspace flows are explicit: "no active route" opens a non-dismissible route chooser, "Start from Sample Route" loads an unsaved in-code ad-hoc trip, and deleting the active route returns to the chooser without any sample fetch or fallback.
  3. Conditional write support (`ETag` / `If-Match`) prevents concurrent overwrite race conditions (`HTTP 412 Precondition Failed` handling).
  4. Local filesystem storage remains the default when `S3_STORAGE_BUCKET` is unset, guaranteeing zero cross-contamination between `npm run dev` and production S3.
  5. **CDK & Infrastructure Update:** `infra/` wires `S3_STORAGE_BUCKET` environment variable into the Fastify Lambda function and grants least-privilege IAM `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, and `s3:ListBucket` permissions on the App Data Bucket.
  6. **Automated & Live Cloud Verification:**
     * `scripts/ci_check.sh` passes with mocked S3 unit tests and `cdk synth`.
     * Deployed to AWS via `./scripts/deploy_cloud.sh`.
     * **Manual Verification:** Log into the live CloudFront Web Studio, create/edit and save a multi-day itinerary, refresh the browser, verify the itinerary persists across Lambda cold starts, and inspect the resulting `users/{email}/itineraries/*.json` object in the AWS S3 Console.
     * **Manual Verification (first-run):** In a fresh browser profile, confirm the route chooser opens automatically, start from the sample, save it under a new name, reload directly into that route, then delete it and confirm the chooser returns with no sample loaded.

---

### Milestone 3 (M3): Amazon Bedrock Adapter & Configurable Model Selection
* **Objective:** Implement `AwsBedrockHarnessAdapter` using `@aws-sdk/client-bedrock-runtime` (`ConverseCommand` and `ConverseStreamCommand`) to power both Route Scout and Copilot Alert Copywriting under a single AWS bill with runtime model selection (`BEDROCK_SCOUT_MODEL_ID`, `BEDROCK_COPYWRITER_MODEL_ID`, and UI model selector), per ADR-0001.
* **Definition of Done (DoD):**
  1. `AwsBedrockHarnessAdapter` implements `AiHarnessAdapter` and streaming tool-call loop (`generateStreamWithTools`) via Bedrock's standardized `ConverseStream` API.
  2. Supports environment default model IDs (`BEDROCK_SCOUT_MODEL_ID`, `BEDROCK_COPYWRITER_MODEL_ID`) and per-request/UI runtime model selection exposed via `GET /api/ai/status`.
  3. Immediate SSE heartbeat comment (`: ping\n\n`) and periodic keep-alive comments emitted on `/api/ai/scout/chat/stream` to prevent CloudFront 30–60s origin read timeouts.
  4. **CDK & Infrastructure Update:** `infra/` grants `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` IAM permissions to the Fastify Lambda execution role and configures default Bedrock model environment variables.
  5. **Automated & Live Cloud Verification:**
     * `scripts/ci_check.sh` passes all unit tests and `cdk synth`.
     * Deployed to AWS via `./scripts/deploy_cloud.sh`.
     * **Manual Verification:** In the live CloudFront Web Studio (and locally in `npm run dev` with AWS credentials), generate single/batch waypoint alerts, switch models in the UI, and verify real-time streaming responses from Amazon Bedrock over CloudFront SSE without buffering or timeouts.
   * **Milestone Status:** **Code Complete, Live Verification Pending (AWS Support).** All code, streaming keep-alive, model discovery, CDK permissions, and verification suites are fully implemented and deployed. Live model invocation is pending resolution of AWS Support Case `179276529500150`.

---

### Milestone 4 (M4): Discovery + Deterministic Domain Grounding Tool Library
* **Objective:** Implement the 7 backend Fastify tools (2 web discovery + 5 deterministic road-trip domain grounding tools) executed in parallel via `Promise.all`, plus server-side Place ID/address post-hydration and `delete_waypoint` suggestion support.
* **Definition of Done (DoD):**
  1. Discovery tools (`search_web`, `read_url_content`) and Domain Grounding tools (`resolve_and_standardize_place` via Google Places API New with strict `X-Goog-FieldMask`, `snap_to_highway_corridor`, `calculate_detour_impact`, `simulate_schedule_cascade`, `audit_corridor_waypoints`) implemented in `server/services/scoutTools.ts`.
  2. Parallel tool execution (`Promise.all`) streams real-time SSE `activity` events to the client as each tool starts and finishes.
  3. Server-side suggestion hydration deterministically injects verified `google_place_id` (`ChIJ...`), `place_name`, `address`, and `lat`/`lng` cached from `resolve_and_standardize_place` into final `json:suggestions` cards.
  4. `ScoutSuggestion` schema and React UI support `"delete_waypoint"` alongside `"add_waypoint"` and `"update_waypoint"`.
  5. **CDK & Infrastructure Update:** `infra/` configures Google Places API key (`/roadtrip-copilot/google-places-api-key`) and Brave Search API key (`/roadtrip-copilot/brave-search-api-key`) SSM parameter paths and environment variables on the Fastify Lambda function; highway snapping and detour routing use OSRM strictly (`router.project-osrm.org`) and fail loudly on upstream error without silent fallbacks (Rule 12).
  6. **Automated & Live Cloud Verification:**
     * `scripts/ci_check.sh` passes all unit tests and `cdk synth`.
     * Deployed to AWS via `./scripts/deploy_cloud.sh`.
     * **Manual Verification:** On the live CloudFront URL, ask Route Scout to find and add a local lunch spot and a scenic drive-by overlook; verify live SSE activity badges stream in real time, returned suggestion cards contain verified `ChIJ...` Place IDs and detour/cascade timings, and 1-click Apply updates the timeline and Google Maps link cleanly.
   * **Milestone Status:** **Code Complete, Live Verification Pending (AWS Support).** Grounding tools, parallel SSE execution, hydration, delete_waypoint UI, security hardening, and decoupled OIDC CI/CD deployment are implemented, tested, and deployed. End-to-end model tool-calling is pending resolution of AWS Support Case `179276529500150`.

---

### Milestone 4.5 (M4.5): Auditable Single-User Spend Instrumentation & Reconciliation
* **Objective:** Learn attributable usage and realistic cost scenarios from the owner's use before multi-user billing. Keep observed usage, rate-based list valuations, infrastructure estimates and provider charges distinct; make unknown usage visible and reconcile matching sources/periods. No Stripe/UI expansion, new AWS resources, or exactness/break-even guarantees. [ADR-0013](../decisions/0013-auditable-spend-events-and-reconciliation.md) is the consolidated governing decision.
* **Executable contract:** [M4.5 specification](M4.5-spend-instrumentation-spec.md). Fixed interfaces, namespace, state machine, error/status/cleanup rules, CLI modes, provider evidence and negative tests live there. [The sole active WP](active/WP-04.5-user-spend-tracking.md) is bounded to checkpoint A; author subsequent 1–2-session WPs only after the previous one is merged and verified.
* **Sequence:** A types/verified price fixtures → B immutable journal/reducer → C recorder/provider/tool/route wiring → D authenticated report/CLI/provider reconciliation → E configuration, docs and live validation. C/D may use sequential bounded sub-WPs; no overlapping ownership or architecture decisions delegated to workers.
* **Definition of Done (DoD):**
  1. **Evidence-backed pricing:** Configured defaults and all admitted models have official-source rate fixtures, canonical/profile mapping and applicability limits. Integer rational calculations produce checked nanodollars. Unverified models fail admission; historical event rates do not change with the catalog.
  2. **Auditable capture:** Immutable turn/call intents precede paid dispatch; observations persist before output validation; stable IDs/bytes make journal retry/replay idempotent. Missing usage and hard termination leave visible unknowns. Parallel tool work drains with bounded cleanup; failed accounting is surfaced, not silently dropped or converted into a normal tool result.
  3. **Retained evidence and honest reporting:** Existing user-scoped S3/local storage retains the whole journal; read-only `GET /api/spend` and CLI project it with source/window/coverage metadata. The 200-turn limit is display-only. Local mode has no fictitious Lambda/S3/CDN allocation; infrastructure proxies and exclusions are labeled estimates.
  4. **Matching-scope reconciliation:** CLI supports completed months/ranges, explicit local event inclusion, provider evidence, gross/adjustment separation, Pacific/shared Google quotas and classified residuals. CE is opt-in/provisional, not an exact invoice. Optional price/payment simulations use declared assumptions, create no reserve, and never double-count model costs already in AWS totals.
  5. **Verification:** Specification §5's automated matrix, orchestrator diff audit, `./scripts/ci_check.sh` and `cd route-builder && npm run test:browser` pass. Owner-authorized controlled live calls agree with comparable provider usage; a matching completed-period reconciliation meets documented tolerance or explains residuals. Credits or missing evidence cannot substitute for validation.
  6. **Deployment/handoff:** Owner-authorized deployment and live report checks recorded; living docs updated. Code-complete/live-validation-pending is allowed but is **not Done**; keep the active WP and explicit pending evidence until the milestone gates pass.

---

## Phase 2: Multi-User Cost-Recovery Expansion

### Milestone 5 (M5): Stripe Prepaid Checkout & S3 Atomic Wallet Ledger
* **Objective:** Enable multi-user access with guaranteed Total Cost Neutrality via a prepaid Stripe Checkout credit wallet stored in `users/{email}/wallet.json` using S3 conditional writes (`If-Match` ETag), deducting `(Bedrock Token Cost + External Tool Call Cost) × Recovery Factor` per turn and gating depleted balances with `HTTP 402 Payment Required`.
* **Definition of Done (DoD):**
  1. Atomic S3 wallet ledger service (`walletService.ts`) reads/updates `users/{email}/wallet.json` using `If-Match` / `If-None-Match` ETags.
  2. Stripe Checkout webhook credits user wallet upon payment confirmation.
  3. Pre-request wallet check gates AI endpoints with `HTTP 402` when balance `<= $0.00`; post-turn hook deducts Bedrock token + Places/Search tool costs multiplied by the recovery factor.
  4. **CDK, Deployment & Manual Cloud Verification:** `infra/` updated with Stripe secret/webhook configuration, deployed to AWS, and manually verified with Stripe test-mode top-up and live credit deduction in S3.
