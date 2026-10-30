# ADR-0014: Auditable Spend Events, Explicit Uncertainty & Matching-Scope Reconciliation

* **Date:** 2026-10-30
* **Status:** Accepted
* **Deciders:** Eric (requested plan hardening), GPT-6.1 Sol (OpenCode orchestrator)
* **Supersedes:** [ADR-0013](0013-accurate-per-user-spend-ledger.md) accounting and implementation contracts; retains its single-user instrumentation objective.
* **Related Work Package:** [WP-04.5](../plan/active/WP-04.5-user-spend-tracking.md)
* **Milestone contract:** [M4.5 specification](../plan/M4.5-spend-instrumentation-spec.md); the active WP covers checkpoint A only.

## 1. Context & Problem Statement

The owner wants to learn from personal use before introducing multiple users: inspect attributable usage, estimate user costs without promotional credits masking consumption, and explain differences against provider charges. Review of ADR-0013 found that its "100% accurate" / "zero-drop" / "guaranteed break-even" claims were not supported by its contracts:

* Missing usage became an exact zero; interrupted calls used character/4 estimates that cannot establish billed tokens.
* A final `finally` write cannot survive process termination. ETags prevent lost updates, not duplicate application after ambiguous write acknowledgements.
* Parallel tools can complete after an early `Promise.all` rejection and a final ledger snapshot.
* Current-month account totals, production-only ledgers, and lifetime summaries do not share a period or scope. Development invokes the same paid providers. Credits and invoice rounding further complicate comparisons.
* Handler timers, current storage sizes, and Logs stored bytes are not billed Lambda duration, monthly byte-time, or log ingestion.
* Google free usage resets at Pacific midnight and belongs to a billing-account/SKU scope, not each app user.
* Two hundred retained receipts and a single current catalog version cannot support historical investigation.
* A markup projection creates neither collected revenue nor a funded reserve.

These are architectural corrections, not permission to introduce silent fallbacks, another database, fixed-cost infrastructure, or a billing product.

## 2. Decision Drivers

* Trustworthy evidence and explicit incompleteness take precedence over falsely precise totals.
* Preserve the provider-neutral adapter seam, existing authentication and local/cloud isolation.
* Reuse the existing S3 bucket and local filesystem; add no AWS resources or mandatory paid telemetry.
* Give budget implementation workers fixed interfaces, state transitions, failure rules, fixtures, and acceptance gates.

## 3. Considered Options

* **A — Patch the mutable `spend.json` counter:** rejected; does not provide durable intent, replayable evidence, or a historical audit trail.
* **B — Add a transactional database/queue and a billing platform:** deferred; unnecessary infrastructure and scope for private single-user observation.
* **C — Immutable intent/observation events with read-time projections:** chosen. Write intent before paid dispatch, persist observations before parsing/output checks, retain every event, and compute summaries from that evidence. An intent without an observation is unknown, not zero. Provider reconciliation supplies aggregate cross-checks, not invented per-call precision.

## 4. Decision Outcome

1. **Evidence, valuation, and charges are separate.** Provider token counts and successful external HTTP requests are observed facts. Applying a versioned catalog produces list-price valuations, not invoices. Infrastructure allocation and free-tier scenarios are estimates. Provider-reported gross usage charges, credits/refunds/tax, and invoice cash totals remain separate.
2. **Journal is authoritative.** Immutable `turn_started`, `call_started`, `call_observed`, and `turn_finished` JSON events live under the existing user namespace, partitioned by source and turn-start date. Local journal lives under repository-root `itineraries/.spend/`. A read-time `UserSpendReport` replaces mutable `spend.json`; no compaction, truncation, automatic deletion, or persistent summary cache in M4.5.
3. **Intent first; no exactly-once upstream promise.** An awaited journal intent must succeed before each paid request. Model runtime automatic retries are disabled (`maxAttempts: 1`); control-plane retries remain unchanged. Every intentional later user retry is a new call. A lost upstream response remains unknown. Immutable journal retries reuse identical IDs and bytes and verify duplicates; they never repeat paid work.
4. **Accounting failure is explicit.** Pre-dispatch persistence failure blocks the paid call with 503. Post-dispatch failure stops further paid work, surfaces a typed accounting error, and emits a sanitized replayable observation in structured logs. Existing durable intent remains evidence of possible spend. Recovery is an explicit operator operation, never a background local/cloud fallback. Hard termination may leave an unfinished turn/call; reports expose it.
5. **Parallel tools drain.** Abort stops scheduling new work; already-started tasks and accounting writes must settle within bounded deadlines before finalization. A timeout never erases intent or claims zero usage. HTTP 2xx evidence is captured before body parsing; terminal billing inference is never based only on tool-result success.
6. **Historical pricing is reproducible.** Each call-start event snapshots its canonical rate and provenance. Unknown/missing rates exclude models from admission. Price extraction is a read-only implementation gate with committed official-source fixtures; the old plan's handwritten prices are not verified evidence. Resolve and validate the actual runtime entrypoint region against `us-east-2` before paid dispatch; local ambient configuration cannot silently change the priced region. No blanket geographic premium or alias stripping. Unpriceable observations retain valid provider counts independently of valuation.
7. **Reconcile matching scopes and periods.** CLI supports completed months and explicit half-open UTC ranges, read-only source discovery (including rotated IDs), source manifests (production and explicitly imported development), instrumentation coverage, AWS account identity, data freshness, and gross/adjustment separation. Local mode defaults to the actual local developer identity; explicit imports preserve that identity, not relabel it as the cloud owner. Google and Brave are separate provider sections with exact provider-local period bounds. Quota/baseline files, CE evidence paths and simulation bases have explicit validated input contracts. No AWS cash-total-to-list-price comparison is presented as an instrumentation defect.
8. **Infrastructure is a labeled proxy plus provider evidence.** Request duration and logical S3 commands may be allocated, with exclusions documented; accounting I/O and unobserved costs remain account-level residuals. Snapshots are diagnostic, not historical charges. Local operation gets no fictitious Lambda/S3/CDN allocation.
9. **No fictitious reserve.** Optional CLI pricing simulations have explicit markup, overhead, payment-fee, and top-up-count assumptions. They do not mutate historical usage or imply a funded reserve or guaranteed recovery.

### Consequences

* More small S3 writes and latency than one final counter update; their real charges are retained in account-level overhead. This is a deliberate, measurable observability cost.
* Read-time projections grow with retained events. Date-bounded reads and pagination are mandatory; a future compaction design needs its own ADR and cannot discard source evidence.
* Some real costs remain unknown per request after failures. This is honest uncertainty, not a hidden fallback or a reason to bill estimated tokens as confirmed usage.
* M4.5 has a fixed milestone specification and sequential 1–2-session WPs, exactly one active. Budget workers must not invent architecture, implement future WPs, or skip evidence gates.
* Live Bedrock/account-access blockers and a not-yet-closed billing period must be reported as pending validation, never waived by green mocks.

## 5. Implementation Notes & Code Touchpoints

The milestone specification is the complete executable contract: `server/types/spend.ts`; pricing, immutable journal, reducer, and recorder services; existing provider/tool/route seams; authenticated report endpoint; TypeScript CLI behind `scripts/check_spend.sh`; provider fixtures and regression suites. The active WP is bounded to types/pricing checkpoint A. No Android drive-loop or frontend work. CDK environment/composition changes may be needed but must add no resources or privileges beyond verified existing access.

## 6. Official References (checked 2026-10-30)

* [Bedrock TokenUsage](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_TokenUsage.html): required usage and optional cache fields, including cache TTL details.
* [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html): duplicate/conflict behavior, including 409 and 412.
* [Lambda metrics](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html): `Duration` excludes cold starts.
* [Lambda lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html): termination and billed/runtime boundaries.
* [Cost Explorer GetCostAndUsage](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostAndUsage.html): exact metric names, pagination, exclusive end date, estimated results.
* [Billing vs Cost Explorer](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/differences-billing-data-cost-explorer-data.html): refresh, grouping, adjustments and rounding differences.
* [CloudWatch Logs metrics](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CloudWatch-Logs-Monitoring-CloudWatch-Metrics.html): ingestion is `IncomingBytes`, not current `storedBytes`.
* [Google pay-as-you-go](https://developers.google.com/maps/billing-and-pricing/pay-as-you-go): Pacific monthly reset and billing-account aggregation.

These references establish semantics, not blanket certification of any model SKU price or account's free-tier eligibility.
