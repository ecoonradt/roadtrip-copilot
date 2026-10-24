# ADR-0011: AWS-Driven Bedrock Model Discovery with Explicit Exclusions

* **Date:** 2026-10-23
* **Status:** Accepted
* **Deciders:** Eric, Antigravity
* **Related Work Package:** [`WP-03-bedrock-adapter-and-model-selection.md`](../plan/active/WP-03-bedrock-adapter-and-model-selection.md)

---

## 1. Context & Problem Statement
ADR-0010 selected a curated Bedrock model catalog. During M3 review, Eric explicitly chose a different long-term admission policy: use AWS as the model catalog source of truth and apply explicit exclusions, rather than requiring source-code additions for newly available models. Earlier observations that a vendor was unavailable to this account must not become permanent vendor restrictions.

This ADR supersedes **only the curated catalog/admission policy** in ADR-0010. The selected default models, inference-profile requirements, IAM-backed access, single AWS bill, and zero-idle-cost architecture remain unchanged.

The related truncation, HTTP status, provider-parameter, and React lifecycle corrections are bug fixes recorded in WP-03, not separate architectural decisions. They are deliberately outside this ADR's scope.

## 2. Decision Drivers
* Newly accessible compatible models should appear without maintaining a hardcoded discovery allowlist.
* Account/Region availability and application compatibility are different requirements; both matter.
* Administrators need explicit exclusions without automatically banning temporarily unavailable vendors.
* Runtime model selection must remain validated, including on cold Lambda instances and when a request uses an environment default.
* Discovery failures must not be masked by a static catalog or substitute model.

## 3. Considered Options
* **Option A: Retain the curated allowlist and add configured defaults.** This fixes the missing-default defect with less discovery work, but new models still require application maintenance. The owner rejected that ongoing restriction.
* **Option B: Discover models from AWS, filter for compatibility/account access, then apply explicit exclusions.** AWS supplies candidate identities and metadata; application policy determines eligibility. The server validates requests against the resulting set rather than against a hardcoded model list.

## 4. Decision Outcome
Chosen Option: **Option B**, as explicitly requested by the owner.

* Discover relevant foundation models and inference profiles through Bedrock's control plane in the configured Region. Follow pagination where the operation supports it; derive canonical invocation IDs and profile/model relationships from AWS metadata rather than only a fixed alias table.
* Admit models only when their account access, invocation mode, and role capabilities meet the application's needs. Text modalities and an ACTIVE profile alone are not proof of Converse, streaming, or tool-use compatibility. Missing capability information must be handled explicitly, not guessed as support.
* Apply intentional exclusions after discovery. Environment defaults and alternate model/profile IDs must not bypass exclusions or compatibility checks. The current configuration surface is `BEDROCK_EXCLUDED_MODEL_IDS` / adapter `excludedModelIds`; this does not itself implement provider-wide exclusions.
* Resolve and validate the effective model before generation or committing SSE headers. A syntactically plausible model ID is not a substitute for discovered eligibility. Availability cache freshness and cold starts must be handled server-side; a previous browser status request is not a prerequisite for safe generation.
* Do not silently replace unavailable, excluded, or incompatible user choices/defaults. Surface the condition and let the user explicitly choose an eligible model. Discovery errors propagate instead of restoring static candidates or an unverified list.
* Cache and deduplicate discovery with bounded control-plane concurrency. Do not invoke every model as a startup health probe or introduce fixed-cost infrastructure.

### Positive Consequences
* New eligible models can become selectable without source-code catalog edits, while explicit exclusions remain available.
* The provider-adapter boundary remains intact; AWS discovery details do not enter the road-trip domain prompt.

### Negative Consequences / Trade-offs
* Additional control-plane reads and `bedrock:ListFoundationModels` permission are needed alongside the existing availability/profile permissions.
* Capability handling needs its own evidence and tests because discovery summaries do not expose every API/feature constraint. Narrow compatibility/parameter exceptions are distinct from a discovery allowlist.
* Access metadata cannot guarantee runtime success. Bedrock invocation errors must still surface accurately, including the outstanding account-level Error 002.

## 5. Implementation Touchpoints & Verification Status

* `route-builder/server/services/bedrockService.ts`: discovery, canonical IDs, exclusions, availability caching, and model validation behind the provider adapter.
* `route-builder/server/services/aiService.ts`, `server/routes/ai.ts`, and `server/routes/scout.ts`: effective model resolution and pre-invocation/pre-SSE validation.
* `route-builder/src/App.tsx`, `src/components/RouteScoutDrawer.tsx`, and `src/components/EditWaypointModal.tsx`: selectors and explicit unavailable-choice handling.
* `infra/lib/roadtrip-cloud-stack.ts` and its tests: read-only discovery permissions.

**Accepted design is not implementation sign-off.** Review of commit `8a86f52` found remaining discovery failure handling, cold-start/default validation, compatibility, canonical-ID, and selection-state gaps. WP-03 records that follow-up; live invocation remains unverified pending AWS Support. The ADR is retained for the enduring policy change, not as a claim that all M3 review findings are fixed.
