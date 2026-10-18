# ADR-0004: Hybrid Local Feature Development Mode (Isolated Local Persistence + Cloud Bedrock AI)

* **Date:** 2026-10-18
* **Status:** Accepted
* **Deciders:** Eric, Antigravity
* **Related Work Package:** N/A (Foundational Blueprint)

---

## 1. Context & Problem Statement
Once the Route Builder Web Studio and Fastify backend are deployed to AWS (Lambda + S3 + CloudFront + Bedrock) as the primary production environment, ongoing software engineering still requires running the full stack locally (`npm run dev`) to develop, debug, and verify new features before opening a pull request and deploying to production.

If local development instances connect to the same production S3 bucket as the deployed AWS app, multiple instances will read and write against the same data store—risking accidental corruption of real road trip itineraries or wallet ledgers during local testing. Conversely, AI features (Route Scout and alert copywriting) rely on Amazon Bedrock's `ConverseStream` API and tool-calling loop, which cannot be replicated purely offline without Bedrock.

## 2. Decision Drivers
* **Standard PR / Feature Development Workflow:** Developers and agents must be able to run `npm run dev` locally to build and test features before deploying to AWS.
* **Strict Data Store Isolation:** Local development must never mutate or collide with the production S3 data store (`users/{email}/itineraries/*.json` and `users/{email}/wallet.json`).
* **Production-Grade AI Fidelity Locally:** Local feature development should use Amazon Bedrock for AI features so prompt changes, tool calling, and streaming behavior match production.
* **Low Local Setup Friction:** Running locally should not require spinning up local S3 emulators or bouncing through production OAuth redirects unless specifically testing auth or S3 adapters.

## 3. Considered Options
* **Option A: Connect Local Dev to Production S3 & Production Auth:** Simple configuration, but dangerous—local development and automated tests could overwrite real user itineraries or wallet balances in S3.
* **Option B: 100% Offline Local Dev (No Bedrock Locally):** Safe for storage, but prevents testing Route Scout and copywriter changes against the actual Bedrock models and `ConverseStream` tool loop used in production.
* **Option C: Hybrid Local Development Mode (Local State Isolation + Cloud Bedrock AI):**
  * **Persistence (`ItineraryStorageService`):** Stays 100% local on the developer's filesystem (`itineraries/`) when running locally, keeping local state completely isolated from the production S3 bucket.
  * **AI Inference (`AwsBedrockHarnessAdapter`):** Connects to Amazon Bedrock from the local environment using standard local AWS credentials (`~/.aws/credentials`, `AWS_PROFILE`, or `aws sso login`), while retaining mock/local adapters for automated unit tests.
  * **Auth & Billing Gate:** Defaults to local bypass in `npm run dev` (`AUTH_ENABLED !== 'true'`) so feature work does not require OAuth redirects or S3 wallet deductions, while remaining toggleable when specifically testing auth flows.
  * **Routing & Grounding Tools:** OSRM, Nominatim, cascade math, and stateless discovery/grounding tools execute directly inside the local Fastify process.

## 4. Decision Outcome
Chosen Option: **Option C (Hybrid Local Development Mode)**.

Every cloud service added during the `route-scout-cloud` project must preserve first-class `npm run dev` execution where state persistence stays strictly local on disk while AI inference can invoke Amazon Bedrock via local AWS credentials.

### Positive Consequences
* Zero risk of local feature development corrupting or racing against the production S3 data store.
* Identical Bedrock `ConverseStream` and tool-calling behavior between local development and AWS Lambda production.
* AWS SDK's default credential provider chain (`@aws-sdk/client-bedrock-runtime`) automatically uses IAM execution roles in Lambda and local AWS CLI profiles in `npm run dev` with zero code branching.

### Negative Consequences / Trade-offs
* Services touching persistence (`itineraryStorageService.ts`) and auth (`authGuard.ts`) must maintain clean environment-driven mode switching (Local Disk vs. S3; Local Bypass vs. OIDC Enforcement) covered by automated tests.

## 5. Implementation Notes & Code Touchpoints
* Blueprint: [route_scout_cloud_architecture.md](../route_scout_cloud_architecture.md#local-feature-development-mode-vs-production-aws-runtime)
* Storage isolation: `route-builder/server/services/itineraryStorageService.ts` (uses local disk when `S3_STORAGE_BUCKET` is unset).
* Auth bypass: `route-builder/server/hooks/authGuard.ts` (bypasses OIDC cookie/JWT gate when `AUTH_ENABLED !== 'true'`).
* Bedrock local auth: `route-builder/server/services/bedrockService.ts` (uses default AWS SDK credential chain).
