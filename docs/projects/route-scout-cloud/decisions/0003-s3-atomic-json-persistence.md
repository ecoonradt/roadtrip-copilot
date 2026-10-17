# ADR-0003: Amazon S3 Atomic JSON Persistence for Cloud Itineraries and User Wallets

* **Date:** 2026-10-17
* **Status:** Accepted
* **Deciders:** Eric, Antigravity
* **Related Work Package:** N/A (Foundational Blueprint)

---

## 1. Context & Problem Statement
On AWS Lambda, runtime container instances are ephemeral: memory and local disk (`/tmp`) vanish whenever the container scales to zero. We need a cloud storage solution for:
1. User multi-day road trip itineraries (`users/{email}/itineraries/*.json`).
2. Prepaid usage wallet ledgers (`users/{email}/wallet.json`).

The persistence system must cost essentially $0.00/month at idle, require zero ongoing database schema migrations or operational overhead, allow direct inspection and manual backup in the AWS Console, and prevent race conditions when updating wallet balances or synchronizing itineraries.

## 2. Decision Drivers
* Extreme low cost: Near-zero cost ($0.00 to $0.01/month) with zero idle database instances.
* Effortless debugging: Files should be human-readable JSON files inspectable and editable directly in AWS S3 Console.
* Concurrency safety: Atomic conditional updates to prevent race conditions during wallet credit deductions or multi-client sync.
* Dual role: S3 can host both the static web assets (`dist/`) and user application data under distinct prefixes/buckets.

## 3. Considered Options
* **Option A: Relational Database (Amazon RDS / Aurora Serverless v2):** Minimum ACU costs ~$0.12/hour ($40–$90/month base cost even when idle). Completely unacceptable for zero-idle cost.
* **Option B: Amazon DynamoDB:** Fast and has a free tier, but introduces proprietary NoSQL schema modeling, requires secondary indexes for listing user routes, makes inspecting complete multi-day JSON routes cumbersome (item size limits of 400KB), and adds SDK complexity.
* **Option C: Amazon S3 with Conditional Writes (`If-Match` / `If-None-Match` & `ETag`):**
  * Itineraries stored as `users/{email}/itineraries/{slug}.json`.
  * Wallets stored as `users/{email}/wallet.json`.
  * Costs $0.023 per GB/mo (~$0.001/mo for 1,000 itineraries).
  * Atomic conditional writes natively supported via S3 `If-None-Match: "*"` (on initial object creation) and `If-Match: <etag>` (on updates, with `HTTP 412 Precondition Failed` retry handling) to prevent race conditions.
  * Preserves exact V2 JSON schema compatibility with local files and Android offline storage.

## 4. Decision Outcome
Chosen Option: **Option C (Amazon S3 Atomic JSON Persistence)**.

The existing concrete `ItineraryStorageService` class (`route-builder/server/services/itineraryStorageService.ts`) will be refactored to support per-user namespace scoping (`userEmail`) and backed by an S3 storage adapter (`S3ItineraryStorageService`) when `S3_STORAGE_BUCKET` is configured, while retaining the local filesystem implementation as the default fallback for offline development. Wallet operations utilize S3 object ETags (`If-Match` / `If-None-Match`) for atomic conditional PUTs.

### Positive Consequences
* Negligible cost (<$0.01/month total for storage and API requests).
* Zero database servers to manage or migrate.
* Complete multi-day itineraries are stored as atomic, human-readable JSON files easily inspected in the AWS Console.
* Native S3 ETag conditional writes eliminate race conditions without database locks.

### Negative Consequences / Trade-offs
* Search/query capability across itineraries is limited to listing object keys under `users/{email}/itineraries/` rather than SQL WHERE queries (sufficient for road trip libraries).

## 5. Implementation Notes & Code Touchpoints
* Blueprint: [route_scout_cloud_architecture.md](../route_scout_cloud_architecture.md#6-deployment--s3-persistence-architecture-on-aws-000month-idle)
* Packages: `@aws-sdk/client-s3`
* Storage files to update: `route-builder/server/services/itineraryStorageService.ts`, `route-builder/server/routes/itineraries.ts`
* Environment variables: `S3_STORAGE_BUCKET`, `AWS_REGION`
