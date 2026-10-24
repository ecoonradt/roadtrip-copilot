# ADR-0011: AWS-Driven Bedrock Model Discovery with Exclusions and Route Scout Lifecycle Integrity

* **Date:** 2026-10-23
* **Status:** Accepted
* **Deciders:** Eric, Antigravity
* **Related Work Package:** [`WP-03-bedrock-adapter-and-model-selection.md`](../plan/active/WP-03-bedrock-adapter-and-model-selection.md)

---

## 1. Context & Problem Statement
A comprehensive follow-up review of Milestone 3 (`tmp/m3-bedrock-adapter-followup-review.md`) surfaced five concrete architectural and lifecycle defects in the Amazon Bedrock integration and Route Scout co-pilot:

1. **Static Catalog Availability Filtering (Finding 1):** The initial implementation filtered a static 18-entry allowlist (`BEDROCK_MODEL_CATALOG`) against AWS account availability. Configured environment defaults (e.g. `BEDROCK_SCOUT_MODEL_ID` set to an accessible Llama model outside the 18 entries) were never evaluated during discovery. When missing from the static catalog, the UI silently fell back to an arbitrary eligible model and persisted that choice, or disabled AI if the configured default was the account's only accessible model.
2. **Silent Truncation on Token Limit (Finding 2):** In streaming tool loops (`generateStreamWithTools`), any `stopReason` other than `tool_use` was treated as successful completion. A response truncated at `max_tokens` (or malformed tool use / premature stream termination without `messageStop`) returned partial text as a complete answer, and `ScoutService.chatStream()` emitted `done` without error. Truncation inside a `json:suggestions` block left broken JSON in user-facing prose.
3. **Premature SSE Commit on Unknown Provider (Finding 3):** `/api/ai/scout/chat/stream` validated `modelId` before opening Server-Sent Events, but did not resolve or validate `preferredEngine` when `modelId` was omitted. An unknown provider flushed HTTP 200 headers and a heartbeat frame before throwing during execution, returning an SSE error event instead of HTTP 400 Bad Request.
4. **Copywriter Default Leak in Non-Streaming Provider Seam (Finding 4):** In `ScoutService.chat()`, `activeModelId` was computed using `defaultScoutModelId`, but `validatedModelId` (undefined when the caller omits `modelId`) was forwarded to `adapter.generate()`. An adapter whose general `generate()` defaults to its copywriter role would execute with the copywriter model while reporting `modelId: defaultScoutModelId` in response metadata.
5. **Cross-Itinerary Conversation & Stream Leakage (Finding 5):** In the React UI, `RouteScoutDrawer` keyed multi-turn conversations by day index (`day:N`) or waypoint ID (`wp:ID`), without itinerary identity. Starting a Scout turn for Trip A and switching to Trip B at the same day index allowed Trip A's in-flight stream to complete, rendering advice and suggestion cards for Trip A inside Trip B's drawer. Closing the drawer or changing scope also failed to abort active streams or clean up global loading state.

## 2. Decision Drivers
* Dynamic, AWS-authoritative model discovery that discovers newly available, active models in the account/Region without requiring application code changes.
* Explicit exclusion policies for administrators or documented compatibility workarounds, without premature permanent vendor bans.
* Strict fail-loud termination handling: token limit exhaustion (`max_tokens`), content filtering, missing terminal frames, or malformed tool use must raise explicit errors and never be disguised as successful completions.
* Strict HTTP boundary semantics: invalid client inputs (unregistered providers or invalid models) must fail with HTTP 400 before committing response headers or streaming frames.
* Correct provider contract parameter propagation across all supported provider seams.
* Cross-itinerary isolation and leak-proof lifecycle management: switching itineraries or scopes, or closing the drawer, must abort obsolete streams and prevent cross-trip contamination.

## 3. Considered Options
* **Option A: Static Catalog Patching & Minimal Workarounds:** Add configured defaults to the hardcoded candidate list; retain silent truncation; leave stream validation in the background handler; leave non-streaming model selection unchanged; rely on unmount cleanup.
* **Option B: AWS-Driven Discovery with Exclusions, Fail-Loud Termination Validation, Pre-Commit Provider Verification, and Itinerary-Keyed Lifecycle Guards:**
  - Discover models dynamically via `ListInferenceProfilesCommand` and `ListFoundationModelsCommand({ byOutputModality: 'TEXT' })`, filter by application capabilities (text input/output, active lifecycle, streaming support), apply policy exclusions, and verify account entitlement via `GetFoundationModelAvailabilityCommand`.
  - Validate terminal `stopReason` in Bedrock streaming and non-streaming adapters. Throw `MalformedAiResponseError` on `max_tokens`, `content_filtered`, missing terminal events, or malformed tool calls. Throw if `json:suggestions` is truncated or unparseable.
  - Validate `preferredEngine` and `modelId` before flushing SSE headers in `/api/ai/scout/chat/stream`, returning HTTP 400 synchronously on invalid requests.
  - Forward the resolved `activeModelId` to `adapter.generate()` and `adapter.generateStreamWithTools()`.
  - Provide stable itinerary identity (`itineraryId`) to `RouteScoutDrawer`, abort obsolete streams on itinerary/scope changes or drawer close, reset conversations on itinerary switch, and guard stream event callbacks against stale sequences.

## 4. Decision Outcome
Chosen Option: **Option B**.

### Positive Consequences
* Any active Bedrock text model enabled in the AWS account appears dynamically in Route Scout and copywriting selectors without code edits.
* Administrators can exclude specific models or providers via `BEDROCK_EXCLUDED_MODEL_IDS` or adapter options.
* Generation truncation is never disguised as a complete answer. Truncated audits or cards fail loudly with an informative error.
* API clients receive standard HTTP 400 errors for invalid provider requests before any stream handshake occurs.
* Non-streaming and streaming provider implementations adhere strictly to the provider-agnostic harness seam.
* Users can switch itineraries or scopes in Route Builder without leaking suggestions, advice, or stream handles across trips.

### Negative Consequences / Trade-offs
* `ListFoundationModels` is called alongside `ListInferenceProfiles` during cold starts; results are cached for `MODEL_AVAILABILITY_TTL_MS` (5 minutes) and concurrency is bounded in batches of 5 to prevent throttling.
* Truncated responses require the driver or caller to re-issue the turn or adjust the prompt, rather than seeing partial prose.

## 5. Implementation Notes & Code Touchpoints
* `route-builder/server/services/bedrockService.ts`:
  - Dynamically discover text models from `ListFoundationModels` and `ListInferenceProfiles`, mapping active profile invocation IDs.
  - Evaluate configured environment defaults alongside discovered models.
  - Apply `excludedModelIds` policy filtering.
  - Check account availability via `GetFoundationModelAvailability`.
  - Validate terminal `stopReason` (`end_turn` / `stop_sequence` are successful; `max_tokens`, `content_filtered`, missing `messageStop`, or empty `tool_use` throw `MalformedAiResponseError`).
* `route-builder/server/services/scoutService.ts`:
  - Add `validateProvider(preferredEngine?: string)` helper.
  - Pass resolved `activeModelId` to `adapter.generate()` and `adapter.generateStreamWithTools()`.
  - In `parseScoutResponse`, throw `MalformedAiResponseError` if `json:suggestions` block is unclosed or invalid JSON.
* `route-builder/server/routes/scout.ts`:
  - Validate `preferredEngine` and `modelId` before setting SSE headers or sending `: ping`.
* `route-builder/src/components/RouteScoutDrawer.tsx` & `route-builder/src/App.tsx`:
  - Pass stable `itineraryId` from `App.tsx` (`trip.fileName || trip.tripName || 'default-itinerary'`).
  - Abort active stream, reset `isLoading`, and reset conversations on itinerary change.
  - Abort active stream and reset `isLoading` on scope switch or drawer close (`!isOpen`).
  - In `App.tsx`, reconcile defaults without silently replacing unconfigured choices with arbitrary models.
* `infra/lib/roadtrip-cloud-stack.ts` & `infra/test/roadtrip-cloud-stack.test.ts`:
  - Grant `bedrock:ListFoundationModels` in the read-only control plane IAM policy.
