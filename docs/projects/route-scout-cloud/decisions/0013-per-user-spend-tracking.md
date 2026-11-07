# ADR-0013: Per-User Spend Tracking & Provider-Neutral AI Spend Seam

* **Date:** 2026-11-01
* **Status:** Accepted
* **Deciders:** Eric, Antigravity
* **Related Work Package:** [`WP-04.5`](../plan/active/WP-04.5-user-spend-tracking.md)

---

## 1. Context & Problem Statement

Before opening the application to multiple users in Phase 2 (Milestone 5: Stripe Prepaid Checkout & S3 Wallet Ledger), the owner wants to instrument the Phase 1 single-user deployment to track per-user spend across:
1. **AI model invocations** across all AI endpoints (`/api/copilot/generate`, `/api/copilot/day-title`, `/api/ai/scout/chat`, `/api/ai/scout/chat/stream`).
2. **Paid external grounding tool requests** (`resolve_and_standardize_place` via Google Places Text Search and `search_web` via Brave Search).
3. **Per-request AWS infrastructure usage** (Lambda compute duration and request count, S3 `GET`/`PUT`/`LIST`/`DELETE` operations, and CloudFront HTTPS request count and egress bytes).

Observing real per-user unit costs during single-user usage provides concrete empirical data to calibrate Phase 2 user pricing without promotional credits or free-tier allowances masking true marginal costs.

At the same time, the application's AI layer is built around the provider-neutral `AiHarnessAdapter` seam (`route-builder/server/services/aiService.ts`). While `AwsBedrockHarnessAdapter` is the only adapter shipped today, future adapters may integrate other AI backends that report usage and pricing through entirely different mechanisms (such as returning dollar cost directly in response headers/payloads, using provider pricing endpoints, or applying flat per-call rates).

## 2. Decision Drivers

* **Strict Provider Neutrality at the `AiHarnessAdapter` Seam:** The adapter interface must expose normalized usage and cost data without leaking Bedrock-specific concepts (such as AWS regions, `Converse` API internals, inference profile modes, or AWS price-list refresh mechanics).
* **Encapsulated Bedrock Pricing Resolution:** Because Amazon Bedrock's `Converse` and `ConverseStream` APIs return token counts rather than dollar amounts, `AwsBedrockHarnessAdapter` needs an internal mechanism to price discovered models in `us-east-2` automatically without adding latency to user requests or requiring manual per-model code edits.
* **True Marginal Unit Costs (List-Rate Valuation):** All AI, tool, and infrastructure usage must be valued at standard list rates (using exact integer nanodollars, $1\text{ USD} = 10^9\text{ nanos}$) rather than subtracting monthly free tiers or promotional credits.
* **Zero-Drop Turn Accounting & Simple Atomic Storage:** Usage incurred during a turn—including earlier iterations of a multi-step tool loop or calls that subsequently fail output validation or abort—must be captured and persisted atomically to a single human-readable per-user JSON ledger (`users/{email}/spend.json` in S3; `itineraries/.spend/{safeEmail}.json` in local dev) following [ADR-0003](0003-s3-atomic-json-persistence.md).
* **Zero Web Studio UI Clutter:** Spend inspection is served via an authenticated `GET /api/spend` endpoint and a terminal helper script (`scripts/check_spend.sh`).

## 3. Considered Options

* **Option A: Expose pricing tables and rate-calculation methods on `AiHarnessAdapter`:** Rejected. Leaks token-rate-table assumptions and Bedrock-specific pricing structures into the provider-neutral adapter contract.
* **Option B: Hardcode a static Bedrock model price table in source code:** Rejected. Requires manual code changes and redeployments whenever AWS Bedrock adds models or updates token prices.
* **Option C: Provider-neutral `onUsage` callback on `AiHarnessAdapter`, internal scheduled S3 price cache for `AwsBedrockHarnessAdapter`, configurable global constants for tools/infra, and atomic `spend.json` ledger:** Chosen.

## 4. Decision Outcome

Chosen Option: **Option C**.

1. **Provider-Neutral `AiHarnessAdapter` Spend Seam:**
   * `GenerateOptions` (`route-builder/server/types/ai.ts`) accepts an optional `onUsage?: (event: AiUsageEvent) => void | Promise<void>` callback.
   * Each `AiHarnessAdapter` implementation is internally responsible for determining the cost of its own model invocations and emitting a normalized `AiUsageEvent` (`providerId`, `modelId`, token counts, `costNanos`, `pricingStale`, `usageComplete`) immediately as each underlying model request completes.
   * How an adapter determines cost is strictly an internal implementation detail of that adapter.

2. **Bedrock-Specific Pricing Inside `AwsBedrockHarnessAdapter`:**
   * `AwsBedrockHarnessAdapter` resolves token prices from a cached Bedrock pricing JSON catalog (`s3://<AppDataBucket>/pricing/bedrock-us-east-2.json` in cloud mode; `itineraries/.spend/pricing/bedrock-us-east-2.json` in local dev).
   * In AWS (`infra/`), an EventBridge Scheduler rule triggers a lightweight on-demand Lambda function weekly in `us-east-2` to fetch current Bedrock pricing for discovered models and update `pricing/bedrock-us-east-2.json` in S3, monitored by a CloudWatch Alarm + SNS notification topic on function errors. In local development, `npm run refresh:pricing` runs the same handler to populate `itineraries/.spend/pricing/bedrock-us-east-2.json`. The web application never queries the AWS Price List API on demand during user requests.
   * `AwsBedrockHarnessAdapter.getAvailableModels()` and `validateModelId()` filter out any discovered model that lacks resolved pricing in the catalog so unpriced models cannot be selected or invoked.
   * If a scheduled refresh fails when a previous valid catalog exists, `AwsBedrockHarnessAdapter` continues using the last valid cached rates and sets `pricingStale: true` on emitted `AiUsageEvent` records (and logs a warning).

3. **Configurable Global Service Constants for External Tools & AWS Infrastructure:**
   * Because neither Google Places (by field mask) nor Brave Search exposes a public machine-readable pricing API, and standard AWS Lambda/S3/CloudFront unit rates rarely change, per-unit list rates for external tools (`Google Places Text Search = $0.035/call`, `Brave Web Search = $0.005/call`) and AWS infrastructure (`Lambda 512 MB GB-s & requests`, `S3 GET/PUT/LIST`, `CloudFront HTTPS requests & egress GiB`) are maintained as documented constants in `spendMath.ts` with environment variable overrides.

4. **Atomic Per-User Spend Ledger (`users/{email}/spend.json`):**
   * At the completion of each tracked request (`finally` block), the accumulated AI usage events, paid tool calls, and request infrastructure metrics (elapsed handler duration, S3 command counts, and response payload bytes) are merged into `users/{email}/spend.json` in S3 using `ETag` conditional writes (`If-Match` / `If-None-Match`) and `KeyedMutex` (or `itineraries/.spend/{safeEmail}.json` in local dev).
   * The ledger maintains lifetime `totals`, `byMonth` (`YYYY-MM`), `byDay` (`YYYY-MM-DD`), `byModel`, `byOperation`, and bounded `recentTurns` (last 200 turns).

5. **Inspection Surface (`GET /api/spend` & `scripts/check_spend.sh`):**
   * `GET /api/spend` (protected by `authGuard`) returns the authenticated user's `UserSpendLedger`.
   * `scripts/check_spend.sh` (`npm run spend`) formats cloud or `--local` spend in the terminal and supports optional `--aws-bill` (Cost Explorer `UnblendedCost` vs. `NetUnblendedCost` comparison) and `--aws-metrics` (CloudWatch/S3/ECR summary) flags.

## 5. Implementation Notes & Code Touchpoints

* Work Package: [`WP-04.5-user-spend-tracking.md`](../plan/active/WP-04.5-user-spend-tracking.md)
* Spend types & math: `route-builder/server/types/spend.ts`, `route-builder/server/services/spendMath.ts`
* Bedrock internal pricing & refresh handler: `route-builder/server/services/bedrockPricing.ts`, `route-builder/server/services/bedrockPricingCache.ts`, `route-builder/server/handlers/refreshBedrockPricing.ts`, `infra/lib/roadtrip-cloud-stack.ts`
* Ledger & instrumentation: `route-builder/server/services/spendLedgerService.ts`, `route-builder/server/services/aiService.ts`, `route-builder/server/services/bedrockService.ts`, `route-builder/server/services/scoutService.ts`, `route-builder/server/services/scoutTools.ts`, `route-builder/server/services/itineraryStorageService.ts`
* Inspection API & script: `route-builder/server/routes/spend.ts`, `scripts/check_spend.sh`
