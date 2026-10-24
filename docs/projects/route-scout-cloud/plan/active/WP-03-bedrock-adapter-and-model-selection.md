# WP-03: Amazon Bedrock Adapter & Configurable Model Selection

* **Milestone:** Milestone 3 (M3) — Amazon Bedrock Adapter & Configurable Model Selection
* **Status:** Review of `a2a7467` confirmed the static-catalog/display-metadata cleanup is bounded, with no functional regression or blocking finding identified. Automated suites remain green. Two documentation wording qualifications remain nonblocking. Live Bedrock invocation remains blocked by account-level `ValidationException: Error 002` (AWS Support pending); deployment/manual acceptance is outstanding.
* **Branch:** `feat/m3-bedrock-adapter`
* **Governing Documents:**
  * Architecture Blueprint: [`route_scout_cloud_architecture.md`](../../route_scout_cloud_architecture.md)
  * Phase Roadmap: [`plan/ROADMAP.md`](../ROADMAP.md)
  * Working Model: [`WORKING_MODEL.md`](../../WORKING_MODEL.md)
  * Architecture Decisions: [`DECISIONS.md`](../../DECISIONS.md), [`ADR-0001`](../../decisions/0001-amazon-bedrock-single-bill-ai.md), [`ADR-0004`](../../decisions/0004-hybrid-local-dev-mode.md), [`ADR-0005`](../../decisions/0005-cdk-iac-and-github-actions-cicd.md), [`ADR-0010`](../../decisions/0010-bedrock-inference-profiles-and-model-catalog.md), [`ADR-0011`](../../decisions/0011-bedrock-discovery-with-exclusions-and-lifecycle-integrity.md)

---

## 1. Objective & Explicit Non-Goals

### Objective
Implement `AwsBedrockHarnessAdapter` in `route-builder/server/services/bedrockService.ts` using `@aws-sdk/client-bedrock-runtime` (`ConverseCommand` and `ConverseStreamCommand`) to power both Route Scout (with multi-turn streaming tool-call loop support) and Copilot Alert / Day Title Copywriting under a single AWS bill. Expose dynamic AWS-discovered models and active defaults (`BEDROCK_SCOUT_MODEL_ID`, `BEDROCK_COPYWRITER_MODEL_ID`) via `GET /api/ai/status`, support per-request `modelId` selection with strict validation against discovered eligibility and policy exclusions across all AI endpoints, emit immediate SSE heartbeats (`: ping\n\n`) and periodic keep-alive comments (`: keep-alive\n\n`) on `/api/ai/scout/chat/stream`, add runtime model selectors in the React Web Studio, and configure least-privilege Bedrock IAM permissions and environment defaults in AWS CDK (`infra/`).

### Explicit Non-Goals
* **No Domain Grounding Tool Implementations Yet:** The 7 discovery and road-trip grounding tools (`scoutTools.ts`: `search_web`, `read_url_content`, `resolve_and_standardize_place`, `snap_to_highway_corridor`, `calculate_detour_impact`, `simulate_schedule_cascade`, `audit_corridor_waypoints`) and `"delete_waypoint"` suggestion action are queued for Milestone 4 (M4). M3 builds the complete `generateStreamWithTools` loop and dispatcher seam in `bedrockService.ts` and `scoutService.ts` (passing `tools = []` by default until M4 wires `scoutTools.ts`, while supporting injected tools in `ScoutService` and tests).
* **No Stripe Billing or User Wallet Ledgers:** Deferred to Phase 2 (M5).
* **No Cloud Deployment Without User Permission:** All code, tests, CDK synthesis, and browser verification are completed locally and delivered as a green PR without deploying to AWS unless explicitly instructed by the user.

---

## 2. Gate 1 Contract-First Specifications & Invariants

### A. Shared Types (`server/types/ai.ts`, `src/types/ai.ts`, `server/types/scout.ts`, `src/types/scout.ts`)
1. `AiEngineId` (replaces the deleted `AiEngineType`; see [ADR-0001 §6](../../decisions/0001-amazon-bedrock-single-bill-ai.md#6-amendment-2026-10-23-no-offline-copy-engine-provider-only-adapter-seam)):
   ```ts
   /** Any registered `AiHarnessAdapter.id`; unknown ids are rejected at runtime. */
   export type AiEngineId = string;
   ```
2. `AiModelOption` & `AiStatusResult` (in both `server/types/ai.ts` and `src/types/ai.ts`):
   ```ts
   export interface AiModelOption {
     id: string;
     name: string;
     provider: string;
     description: string;
     role: 'scout' | 'copywriter' | 'both';
   }

   export interface AiStatusResult {
     available: boolean;
     engine?: AiEngineId;
     providerName?: string;
     models?: AiModelOption[];
     defaultScoutModelId?: string;
     defaultCopywriterModelId?: string;
     message?: string;
   }
   ```
3. Tool Calling & Generation Options (in `server/types/ai.ts`):
   ```ts
   export interface ToolDeclaration {
     name: string;
     description: string;
     inputSchema: Record<string, unknown>;
   }

   export interface GenerateOptions {
     apiKey?: string;
     modelId?: string;
     abortSignal?: AbortSignal;
   }

   export interface GenerateStreamWithToolsResult {
     text: string;
     inputTokens: number;
     outputTokens: number;
   }
   ```
4. `ScoutChatRequest` (in `server/types/scout.ts` and `src/types/scout.ts`):
   Add optional `modelId?: string;` (and `inputTokens?: number; outputTokens?: number; modelId?: string;` on `ScoutChatResponse`).

### A2. Provider Adapter Seam (`server/services/aiService.ts`, `server/services/aiRegistry.ts`)
* `AiHarnessAdapter` is a **provider** contract (a provider exposes multiple models at different price/performance points), not a single-model or single-CLI contract. Required members: `id`, `name`, `isAvailable`, `generate`, `validateModelId`, `getAvailableModels`, `getModelCatalog`, `decorateScoutPrompt`, `sanitizeResponse`. Only `generateStreamWithTools` is optional.
* `AiService` owns the registry and never imports a concrete provider. `getAdapterFor(preferredEngine)` resolves `'auto'`/undefined to the primary adapter and throws `UnknownAiProviderError` (`statusCode = 400`) for any other unregistered id. The deleted `'template'` id therefore returns HTTP 400 like any unknown provider.
* `server/services/aiRegistry.ts` is the sole composition root: `createDefaultAiService()` registers `AwsBedrockHarnessAdapter` with `primaryAdapterId: 'bedrock'`. A different provider is added by registering another adapter here; generation, parsing, Route Scout, and UI code stay unchanged.
* `getStatus` calls `isAvailable` then `getAvailableModels`; any failure returns `available: false` with the upstream error and never advertises an unverified catalog.
* Malformed alert/batch/day-title payloads throw `MalformedAiResponseError` (`statusCode = 502`); no template or placeholder copy is ever substituted.

### B. `AwsBedrockHarnessAdapter` (`server/services/bedrockService.ts`)
1. **Region & Client Invariant:**
   * Never hardcode `'us-east-1'`. Resolve `const region = options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;` and instantiate `new BedrockRuntimeClient(region ? { region } : {})` when no custom `options.client` is injected.
   * Instantiate a control-plane `new BedrockClient(region ? { region } : {})` for `GetFoundationModelAvailability` / `ListInferenceProfiles` unless `options.controlClient` is injected. Constructing an adapter performs no network I/O; availability is resolved lazily by `getAvailableModels()`.
2. **Default Models & Dynamic Discovery Policy ([ADR-0011](../../decisions/0011-bedrock-discovery-with-exclusions-and-lifecycle-integrity.md)):**
   * `DEFAULT_BEDROCK_SCOUT_MODEL_ID = 'us.moonshotai.kimi-k3'` (overridable via `process.env.BEDROCK_SCOUT_MODEL_ID` or constructor `options.scoutModelId`).
   * `DEFAULT_BEDROCK_COPYWRITER_MODEL_ID = 'us.amazon.nova-2-lite-v1:0'` (overridable via `process.env.BEDROCK_COPYWRITER_MODEL_ID` or constructor `options.copywriterModelId`).
   * Discovers eligible models dynamically from the Bedrock control plane (`ListInferenceProfilesCommand`, `ListFoundationModelsCommand({ byOutputModality: 'TEXT' })`) and verifies account availability via `GetFoundationModelAvailabilityCommand` (with cross-region prefixes stripped via `toFoundationModelId()`). Admitted models must satisfy application role requirements (text modality; Scout requires `responseStreamingSupported === true`).
   * Excludes foundation models or profile variants matching administrative policy (`excludedModelIds` / `BEDROCK_EXCLUDED_MODEL_IDS`).
   * Derives human-readable display names and descriptions directly from AWS metadata (`modelName`, `providerName`, `inferenceProfileName`, `description`), falling back to clean ID-based string formatting. Does not maintain a static candidate allowlist.
   * `getAvailableModels()` caches the discovered, verified, non-excluded list for `MODEL_AVAILABILITY_TTL_MS` (5 minutes). Availability failures propagate (fail loud) instead of restoring a static list. `getModelCatalog()` returns the cached models (or empty array before discovery), never a hardcoded fallback catalog.
   * `validateModelId(modelId: string, role?: 'scout' | 'copywriter'): Promise<string>`: Asynchronously validates candidate and canonical model IDs against the fresh discovered model snapshot from the control plane (`ListInferenceProfilesCommand`, `ListFoundationModelsCommand`). Maps bare inference-profile aliases and verifies role compatibility (`scout`, `copywriter`). Excluded foundation models and profile variants are rejected. Throws `InvalidModelError` (`statusCode = 400`) if unknown, excluded, or role-incompatible.
3. **`isAvailable()` Invariant:**
   * Returns `true` if a custom `client` was injected, or if AWS environment/profile/config indicators are present (`AWS_LAMBDA_FUNCTION_NAME`, `AWS_EXECUTION_ENV`, `AWS_REGION`, `AWS_DEFAULT_REGION`, `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `BEDROCK_SCOUT_MODEL_ID`, `BEDROCK_COPYWRITER_MODEL_ID`, or `~/.aws/config` / `~/.aws/credentials` exists on disk).
4. **Reasoning & `<thinking>` Hygiene ([ADR-0010](../../decisions/0010-bedrock-inference-profiles-and-model-catalog.md)):**
   * `sanitizeBedrockResponse(rawText: string)` strips `<thinking>[\s\S]*?<\/thinking>`, `<think>[\s\S]*?<\/think>`, trailing unclosed `<thinking>[\s\S]*$` / `<think>[\s\S]*$` blocks, and lone/orphan closing `</thinking>` / `</think>` tags, plus leading/trailing harness meta-commentary.
   * During `ConverseStreamCommand`, ignore `delta.reasoningContent` for `delta` text events (emit a single `{ event: 'thought', data: { text: 'Reasoning through route options...' } }` when reasoning begins), and strip `<thinking>...</thinking>` / `<think>...</think>` from streaming `delta` text chunks so raw XML thinking tags never flash in the UI.
   * When appending an `assistant` `tool_use` turn to `messages` for the next iteration of `ConverseStreamCommand`, include only `{ text }` (if non-empty after stripping thinking tags) and `{ toolUse }` blocks—never re-send `reasoningContent` in assistant history.
5. **Bounded Parallel Tool Loop (`generateStreamWithTools`):**
   * Caps turn output tokens at `maxTokens: 4096` to respect Amazon Nova's 5,000 output token cap while providing maximum reasoning and tool call headroom.
   * Enforces `MAX_TOOL_ITERATIONS = 5`. If the model still requests `tool_use` on the final iteration, throws an explicit error (`Route Scout exceeded maximum tool iterations (5)`).
   * Executes all `toolUse` blocks from a turn concurrently via `Promise.all`, emitting `activity` SSE events (`state: 'active'` on start, `state: 'done' | 'error'` with `durationSeconds` on completion). If an individual tool dispatcher call throws, catches the error, emits `state: 'error'` activity, and returns `{ error: message }` inside `toolResult` (`status: 'error'`) so the model can recover gracefully.

### C. Fastify Routes & SSE Heartbeat (`server/routes/ai.ts`, `server/routes/scout.ts`)
1. **Model & Provider Validation Boundary (`400 Bad Request`):**
   * In `/api/copilot/generate`, `/api/copilot/day-title`, `/api/ai/scout/chat`, and `/api/ai/scout/chat/stream`: resolve the provider via `preferredEngine` (an `AiEngineId`; `'auto'`/undefined selects the primary adapter). An unregistered value throws `UnknownAiProviderError` → HTTP 400.
   * If `modelId` is provided in the request body, validate it via `aiService.validateModelId(modelId, preferredEngine)` before executing or opening the SSE stream. If invalid (`InvalidModelError`), return `reply.status(400).send({ error: err.message })`.
   * If the provider returns a payload that fails the alert contract, `MalformedAiResponseError` maps to `502 Bad Gateway` with the parsing error message. Never substitute template copy.
2. **CloudFront SSE Heartbeat & Keep-Alive Cleanup (`/api/ai/scout/chat/stream`):**
   * Immediately after setting SSE headers (`Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`), call `reply.raw.flushHeaders?.()` and write `: ping\n\n`.
   * Start a periodic timer (`keepAliveIntervalMs = options.keepAliveIntervalMs ?? 15_000`) writing `: keep-alive\n\n`.
   * Attach `reply.raw.on('close', onClose)` to clear the timer and trigger an `AbortController` passed down to `scoutService.chatStream`.
   * In `finally`, always `clearInterval(keepAliveTimer)`, remove the `'close'` listener, and call `reply.raw.end()` if not already ended.

### D. Frontend Model Selection & Race Safety (`src/services/api.ts`, `src/App.tsx`, `src/components/RouteScoutDrawer.tsx`, `src/components/EditWaypointModal.tsx`, `src/components/TimelineSidebar.tsx`)
1. **SSE Comment Parsing (`src/services/api.ts`):**
   * `chatWithScoutStream` must ignore any line starting with `:` (`: ping`, `: keep-alive`) in `processFrame`, whether in a standalone frame or coalesced with `event:` / `data:` lines, and accept an optional `AbortSignal`.
2. **UI Geometry & Browser Test Compatibility:**
   * Do NOT add new controls to `AppHeader.tsx` (preserving the strict single-row `56px` header height across `1024px–1920px` viewports enforced by `tests/browser/appHeader.browser.ts`).
   * Do NOT add new mount-time `/api/*` endpoints in `App.tsx`—piggyback on the existing `GET /api/ai/status` (`fetchAiStatus`) call which is already mocked in `tests/browser/appHeader.browser.ts` and `tests/ui/harness.tsx`.
   * Place the Route Scout model selector inside `RouteScoutDrawer.tsx`'s header panel and the Copywriter model selector inside `EditWaypointModal.tsx`'s AI Co-Pilot Alert tab.
3. **Async Race & Abort Safety:**
   * In `RouteScoutDrawer.tsx`: track an `AbortController` and request sequence counter (`streamSeqRef`) so clearing chat or starting a new turn cancels any in-flight stream and prevents late chunks from mutating state. Also strip `<thinking>[\s\S]*?<\/thinking>` and unclosed `<thinking>[\s\S]*$` in `cleanStreamingText`.
   * In `EditWaypointModal.tsx`: guard `handleGenerateAi` with a request revision ref (`genSeqRef`) reset when `waypoint?.id` or `isOpen` changes so a slow AI response never populates alert fields after the user closes the modal or switches waypoints.

---

## 3. Step-by-Step Tactical Steps

- [x] **Step 1: Install `@aws-sdk/client-bedrock-runtime` in `route-builder/`**
  - Add `@aws-sdk/client-bedrock-runtime` to `route-builder/package.json` and run `npm install`.
- [x] **Step 2: Implement `AwsBedrockHarnessAdapter` & Backend AI/Scout Wiring**
  - Update `server/types/ai.ts` and `server/types/scout.ts` (`AiEngineId`, `providerName`, optional batch `engine`).
  - Create `server/services/bedrockService.ts` implementing `AwsBedrockHarnessAdapter` (`ConverseCommand`, `ConverseStreamCommand`, parallel tool loop, model catalog & validation, reasoning tag hygiene).
  - Restore the provider-agnostic seam: `server/services/aiService.ts` (registry, resolution, fail-loud generation) and `server/services/aiRegistry.ts` (composition root). Delete the `'template'` engine, `generateTemplate*` helpers, and `AiEngineType` ([ADR-0001 §6](../../decisions/0001-amazon-bedrock-single-bill-ai.md#6-amendment-2026-10-23-no-offline-copy-engine-provider-only-adapter-seam)).
  - Update `server/services/schemaParser.ts` (strict parsing, `MalformedAiResponseError`), `server/services/scoutService.ts`, `server/routes/ai.ts`, and `server/routes/scout.ts` (including immediate `: ping\n\n` heartbeat, keep-alive timer cleanup, 400 for unknown provider/model, 502 for malformed payloads).
- [x] **Step 3: Implement Frontend Model Selection & Stream Hygiene**
  - Update `src/types/ai.ts`, `src/types/scout.ts`, and `src/services/api.ts`.
  - Update `src/App.tsx`, `src/components/RouteScoutDrawer.tsx`, `src/components/TimelineSidebar.tsx`, and `src/components/EditWaypointModal.tsx` with runtime model selectors and async race/abort guards.
- [x] **Step 4: Update AWS CDK Infrastructure (`infra/`)**
  - Update `infra/lib/roadtrip-cloud-stack.ts` and `infra/bin/infra.ts` with `BEDROCK_SCOUT_MODEL_ID`, `BEDROCK_COPYWRITER_MODEL_ID`, and least-privilege `bedrock:InvokeModel*` IAM policy (`foundation-model/*` and `inference-profile/*`).
  - Update `infra/test/roadtrip-cloud-stack.test.ts` with CDK assertions.
- [x] **Step 5: Author Comprehensive Adversarial Unit & Integration Tests**
  - Create `route-builder/tests/ai/bedrock.test.tsx` (43 tests) covering:
    * `ConverseCommand` text generation & `ConverseStreamCommand` multi-turn parallel tool loop.
    * `<thinking>` / `<think>` tag stripping (including split `<thi` tags across chunk boundaries) and `reasoningContent` handling.
    * `MAX_TOOL_ITERATIONS` cap enforcement and tool error recovery.
    * Region resolution without hardcoded `'us-east-1'`.
    * Model ID normalization and `400 Bad Request` rejection on unknown or empty (`""`) `modelId`.
    * SSE `: ping\n\n` immediate flush, periodic `: keep-alive\n\n`, and `clearInterval` cleanup on stream completion, error, and client disconnect.
    * Client SSE parser (`chatWithScoutStream`) handling `: ping` and `: keep-alive` frames cleanly, plus `<RouteScoutDrawer>` and `<EditWaypointModal>` model selector UI rendering.
- [x] **Step 6: Gate 2 Orchestrator Adversarial Audit, Full Suite Verification & Living Docs Sync**
  - Audit `git diff` against the 8-point Adversarial Review Checklist.
  - Run `./scripts/ci_check.sh` and `cd route-builder && npm run test:browser`.
  - Sync living docs (`AGENTS.md`, `README.md`, `route-builder/AGENTS.md`, `route-builder/README.md`, `docs/reference/directory-layout.md`).
  - Push branch `feat/m3-bedrock-adapter` and open green PR on GitHub.

---

## 4. Verification Plan

* **Bedrock & AI Unit/Integration Tests:**
  ```bash
  cd route-builder && npm run test:ai
  ```
* **Full Route Builder Vitest Suite & Production Build:**
  ```bash
  cd route-builder && npm test && npm run build
  ```
* **Playwright Browser Geometry & Fixture Suite:**
  ```bash
  cd route-builder && npm run test:browser
  ```
* **CDK Infrastructure Tests & CloudFormation Synthesis:**
  ```bash
  cd infra && npm test && npx cdk synth
  ```
* **Unified CI Pipeline:**
  ```bash
  ./scripts/ci_check.sh
  ```

---

## 5. Discoveries & Deviations Log

1. **Bedrock Inference Profiles, Account Model Entitlements & Reasoning Hygiene ([ADR-0010](../../decisions/0010-bedrock-inference-profiles-and-model-catalog.md)):** Live read-only verification in `us-east-2` revealed that frontier models with `inferenceTypesSupported: ["INFERENCE_PROFILE"]` (such as `us.moonshotai.kimi-k3`, `us.amazon.nova-2-lite-v1:0`, `us.amazon.nova-pro-v1:0`) require invocation via their `us.` inference profile ID and IAM permissions on both `arn:aws:bedrock:*::foundation-model/*` and `arn:aws:bedrock:*:${this.account}:inference-profile/*`. While `openai.gpt-6-*`, `anthropic.claude-sonnet-5-5`, and `xai.grok-4.7` require separate AWS Sales or Anthropic use-case form enablement on the account, `us.moonshotai.kimi-k3` and `us.amazon.nova-2-lite-v1:0` were selected as the out-of-the-box defaults based on catalog availability and earlier latency observations. End-to-end invocation is still pending the account-level Error 002 resolution described in item 4. Recorded in [`ADR-0010`](../../decisions/0010-bedrock-inference-profiles-and-model-catalog.md).
2. **Two-Gate Quality Protocol Codified in Working Model:** To eliminate the multi-round PR review cycles experienced in M1 and M2, updated [`WORKING_MODEL.md`](../../WORKING_MODEL.md), [`AGENTS.md`](../../../../AGENTS.md), and harness rules with Gate 1 (Contract-First Worker Prompts) and Gate 2 (8-point Orchestrator Adversarial Diff Audit + mandatory Vitest, CDK, and Playwright browser verification).
3. **Gate 2 Orchestrator Audit Refinements Caught Before PR:**
   * Held back partial trailing `<thi...` prefix tags at chunk boundaries in `bedrockService.ts` `generateStreamWithTools` so split `<thinking>` tags across network chunks never leak partial tag characters to SSE `delta` events.
   * Treated explicit empty `modelId: ""` as a `400 Bad Request` (`InvalidModelError`) across all AI/Scout endpoints rather than coerced falsy `undefined` fallback.
   * Reconciled `selectedScoutModelId` and `selectedCopywriterModelId` in `App.tsx` against role-filtered model lists (`role === 'scout' || role === 'both'` and `role === 'copywriter' || role === 'both'`) and guarded `handleSuggestDayTitle` with `tripRevisionRef.current`.
4. **Outstanding Bedrock Error 002 After Paid Plan Upgrade ([ADR-0010](../../decisions/0010-bedrock-inference-profiles-and-model-catalog.md)):** Initial runtime invocation checks returned `ValidationException: Error 002: Access to Bedrock models is not allowed for this account`. Upgrading the account plan to `PAID` (promotional credits increased to $159.99) and activating Advanced Features removed the Free Tier restrictions, but **Error 002 still reproduces** and the issue remains open with AWS Support. Live invocation is therefore unverified; this WP must not claim resolution. Keyless GitHub Actions OIDC deployment is tracked separately under Issue [#7](https://github.com/ecoonradt/roadtrip-copilot/issues/7).
5. **M3 Bedrock Code Review Findings Resolution:**
   * **Nova MaxTokens Limit:** Capped Route Scout turn tokens at `maxTokens: 4096` in `generateStreamWithTools` to prevent `ValidationException` on Amazon Nova models which enforce `maxTokens <= 5000`.
   * **Dynamic Model Availability:** Integrated `@aws-sdk/client-bedrock` `GetFoundationModelAvailabilityCommand` (called with the underlying foundation model ID after stripping cross-region prefixes) plus `ListInferenceProfilesCommand` for `ACTIVE` inference profile IDs, with 5-minute TTL caching in `getAvailableModels()`. IAM grants `bedrock:GetFoundationModelAvailability` and `bedrock:ListInferenceProfiles` on `*` in a separate statement from the ARN-scoped `bedrock:InvokeModel*` permissions. Availability failures fail loud; `/api/ai/status` never advertises the unverified catalog.
   * **Strict Fail-Loud Architecture (Rule 12):** Completely excised legacy `agy` CLI subprocesses and Gemini Studio adapters from `aiService.ts` and `scoutService.ts`. Bedrock is the sole AI engine; all failures fail deterministically without silent fallbacks.
   * **SSE Error & Abort Cleanup:** Guarded `routes/scout.ts` against emitting error SSE frames on client aborts, ensured single-error emission on server failure, added early abort signal checks in `bedrockService.ts`, and sanitized orphan `</thinking>` closing tags.
   * **UI State Reset:** Reset `isLoading` and `error` states in `EditWaypointModal.tsx` on waypoint switch.
6. **Template Engine Removal & Provider Seam Restoration ([ADR-0001 §6](../../decisions/0001-amazon-bedrock-single-bill-ai.md#6-amendment-2026-10-23-no-offline-copy-engine-provider-only-adapter-seam)):** Review feedback confirmed the `'template'` engine was a residual silent fallback, not a product feature, and that the adapter seam had drifted toward one provider. Removed `'template'`, `AiEngineType`, and all `generateTemplate*` helpers; malformed provider output now throws `MalformedAiResponseError` (HTTP 502) and unknown providers throw `UnknownAiProviderError` (HTTP 400). `AiHarnessAdapter` is now a full required-member provider contract, `AiService` is provider-agnostic, and `aiRegistry.ts` is the sole composition root. The Web Studio's hardcoded "Amazon Bedrock" UI strings were replaced with provider-neutral copy in `src/constants/aiCopy.ts`, and the Route Scout "Offline" badge was removed because no offline copy path exists.
7. **Follow-Up Review Implementation & Lifecycle Integrity (commit `8a86f52`; discovery policy only in [ADR-0011](../../decisions/0011-bedrock-discovery-with-exclusions-and-lifecycle-integrity.md)):**
   * **AWS-Driven Model Discovery (Finding 1):** Inverted the static 18-candidate catalog allowlist into dynamic AWS-driven discovery via `ListInferenceProfilesCommand` and `ListFoundationModelsCommand({ byOutputModality: 'TEXT' })`. Verified account availability via `GetFoundationModelAvailabilityCommand`, reconciled configured environment defaults, and derived display metadata from AWS while supporting explicit policy exclusions (`excludedModelIds` / `BEDROCK_EXCLUDED_MODEL_IDS`). Added IAM action `bedrock:ListFoundationModels`. In `App.tsx`, reconciled defaults and UI models without silently defaulting to `eligible[0].id`.
   * **Fail-Loud Terminal Validation (Finding 2):** Validates terminal reasons in `generate()` and `generateStreamWithTools()`, retaining the 4,096-token ceiling. Throws `MalformedAiResponseError` on `max_tokens`, `content_filtered`, missing terminal `messageStop` frames, or empty `tool_use`. In `scoutService.ts`, incomplete, truncated, or unparseable ````json:suggestions```` blocks throw `MalformedAiResponseError`.
   * **Synchronous Provider Validation (Finding 3):** Validates `preferredEngine` before setting SSE headers or emitting heartbeat pings in `/api/ai/scout/chat/stream`, returning synchronous HTTP 400 Bad Request on unregistered providers.
   * **Provider Seam Model Resolution (Finding 4):** Passes the resolved `activeModelId` (Scout default when omitted) to `adapter.generate()` and `adapter.generateStreamWithTools()`.
    * **Cross-Itinerary Conversation & Stream Isolation (Finding 5):** Added stable `itineraryId` to `RouteScoutDrawer`, keying conversations by `${itineraryId}:${scopeKey}`. In-flight streams abort automatically on itinerary change, scope change, or drawer close (`!isOpen`), and conversations reset upon itinerary replacement.
8. **Independent Fix Verification:** Re-ran `./scripts/ci_check.sh` (422 Route Builder tests, production builds, 22 CDK tests, synthesis, Android unit-test task) and all 22 browser tests successfully. Isolated service/route/React probes nevertheless reproduced: a swallowed `ListFoundationModels` failure with static candidate recovery; unverified cold-start IDs and excluded copywriter defaults reaching invocation; profile compatibility bypass and incorrect canonical default IDs; enabled generation without a selected model; same-name itinerary collisions; and orphaned loading placeholders after cancellation. The prior unknown-provider HTTP 400, non-streaming Scout default propagation, and streaming terminal-reason fixes were confirmed. ADR-0011 was retained and narrowed to the owner-approved catalog policy change; these defects do not each warrant an ADR. No application implementation was changed during this verification.
9. **Verification Fixes Implemented (R1-R7 & Verification Document Resolution):**
   * **R1 (Pre-Invocation Eligibility & Exclusions):** Asynchronously validate effective requested/default models against fresh discovered models on every generation path before invocation/SSE commit in `AwsBedrockHarnessAdapter.validateModelId()`, `AiService.resolveModelId()`, and `ScoutService.resolveModelId()`. Eliminated regex/catalog fallback. Verified cold-start instances, omitted IDs with excluded defaults, and invalid empty IDs return HTTP 400 with 0 runtime SDK calls.
   * **R2 (Fail-Loud Discovery Error Propagation):** Propagate AWS enumeration errors (`ListFoundationModels`, `ListInferenceProfiles`) loudly without static fallback; separated operational exceptions from negative availability in `GetFoundationModelAvailability`. Added regression tests for single-listing failures (`ListFoundationModels` failing while profiles succeed, and vice versa).
   * **R3 (Profile & Model Compatibility Policy):** Evaluated compatibility consistently across profiles and direct models via foundation metadata: reject `LEGACY`, non-text, and require explicit `responseStreamingSupported === true` for scout streaming role (assigning `role: 'copywriter'` when streaming is false). Active profiles lacking foundation metadata are rejected.
   * **R4 (Dynamic Canonical IDs & Application Profile Exclusions):** Resolved canonical aliases and foundation relationships dynamically from `models[].modelArn`; normalized bare configured defaults; excluded unsupported application profiles from discovery.
   * **R5 (UI Model Selection Reconciliation & Gating):** Reconciled pickers in `RouteScoutDrawer`, `EditWaypointModal`, and `TimelineSidebar`. Gated Scout message submission/quick prompts, single alert generation, batch alerts, and day-title suggestions on explicit eligible model selection; rendered disabled 'Select model...' placeholder when selection is empty.
   * **R6 (Itinerary Session Identity Stability):** Added dedicated `createItinerarySessionId()` utility in `src/utils/itinerarySession.ts`, maintaining stable session identity across saves, renames, and waypoint edits while resetting on route replacement, new trip, or import.
   * **R7 (Placeholder & Loading Cleanup on Turn Cancellation):** Cleaned up in-flight abort controllers and purged empty placeholder assistant messages on drawer close, scope switch, chat clear, and unmount; guarded `Loader2` animation to only render when `isLoading && !msg.content`. Added tests asserting no retained analyzing placeholder on drawer reopen or scope return.
   * **Empty JSON suggestions fence:** Handled closed `json:suggestions` with empty body throwing `MalformedAiResponseError`.
   * **Full Verification Suite:** 432 Route Builder tests across 22 test files, 22 Playwright browser tests, 22 CDK infrastructure tests, CloudFormation synthesis, and Android unit tests passing.
10. **Independent Review of `ba07924`:** Personally re-ran `./scripts/ci_check.sh` (432 Route Builder tests, builds, 22 CDK tests, synthesis, Android unit-test task) and all 22 browser tests successfully. Confirmed rejection of cold unknown IDs and excluded omitted defaults, fail-closed listing errors, model-picker gating, and dedicated itinerary session wiring. Two additional real-App probes passed for rename/edit/first-save identity preservation and same-name/same-filename import replacement. Nevertheless, isolated probes reproduced six remaining defects: canonical IDs computed before discovery refresh; foundation exclusions bypassed by alternate profile variants; inference starting after a client disconnect during pre-SSE discovery; completed suggestion-only answers deleted by placeholder cleanup; inherited alias-object keys causing HTTP 500; and malformed request bodies performing discovery/returning HTTP 500 before structural validation. Full evidence is in `tmp/m3-bedrock-adapter-ba07924-review.md`. The temporary App probe test was removed; no application/infrastructure/permanent test code was changed during review. These are M3 defect corrections, not new ADR decisions.
11. **Independent Review of `90ee22d`:** Personally re-ran `./scripts/ci_check.sh` (442 Route Builder tests, builds, 22 CDK tests, synthesis, Android unit-test task) and all 22 browser tests successfully. Independent probes confirmed the six reported reproductions now pass, including a real-socket disconnect before heartbeat with zero inference and normal streaming afterward. Two remaining cases were reproduced: `AiService.resolveModelId()` reads a stale canonical default before adapter TTL refresh, causing the first unpinned endpoint request after an alias change to fail with HTTP 400 while its retry succeeds; and completed cards-only answers display a loading indicator during a later turn because rendering uses global `isLoading`. Evidence and narrowly scoped corrections are in `tmp/m3-bedrock-adapter-90ee22d-review.md`. No application, infrastructure, or test code was changed during this review, and no new ADR is needed.
12. **Defect Corrections for `90ee22d` Review Findings:**
   * **Unpinned Default Refresh Ordering:** In `AiService.resolveModelId()`, called `await adapter.getAvailableModels()` before `adapter.getModelCatalog()` to ensure discovery and alias resolution use a fresh snapshot when resolving unpinned defaults. Preserved raw configured defaults (`rawConfiguredScoutModelId`, `rawConfiguredCopywriterModelId`) in `AwsBedrockHarnessAdapter` so dynamic aliases always take precedence over static aliases. Preserved explicit pinned-ID semantics (an unavailable explicit profile is rejected with HTTP 400). Added endpoint-level Fastify regression tests for both the unpinned TTL refresh success and the pinned old profile rejection.
   * **Active Turn Loader Isolation:** In `RouteScoutDrawer.tsx`, introduced `activeAssistantMsgId` state tracked across turn lifecycle (`handleSubmit`, `done`, `cancelActiveTurn`, `catch`, `finally`). Guarded the loading indicator condition to check `isLoading && (activeAssistantMsgId === msg.id || activeTurnRef.current?.assistantMsgId === msg.id)`, preventing completed cards-only answers from showing a duplicate analyzing indicator during follow-up turns. Added completed-card-plus-follow-up regression tests.
   * **Contract & Living Docs Synchronization:** Updated WP-03 contract to document asynchronous discovery-based validation (`validateModelId(modelId, role): Promise<string>`) and synchronized the `src/utils/itinerarySession.ts` utility.
13. **Independent Verification of `d105580`:** Personally re-ran `./scripts/ci_check.sh` (444 Route Builder tests, builds, 22 CDK tests, synthesis, Android unit-test task) and all 22 browser tests successfully. Additional endpoint probes confirmed the first unpinned request after an alias-changing TTL refresh succeeds with the fresh profile while an explicitly pinned stale profile returns HTTP 400 without inference. Real parser/React/SSE probes confirmed exactly one active-turn loader, completed-card preservation, and correct cancellation cleanup. Rechecked cold IDs, exclusions, inherited keys, invalid-body/no-discovery behavior, and a real-socket pre-heartbeat disconnect followed by a successful normal stream. No new blocking code finding or regression was identified in this round. Evidence and remaining verification limits are in `tmp/m3-bedrock-adapter-d105580-review.md`. No application, infrastructure, or test files were changed during review, and no new ADR was created.

14. **Independent Review of `a2a7467`:** Reviewed the entire latest commit and personally re-ran `./scripts/ci_check.sh` (444 Route Builder tests, builds, 22 CDK tests, synthesis, Android unit-test task) and all 22 browser tests successfully. Independent cold-adapter/status/default-generation probes confirmed empty pre-discovery catalogs without network I/O, working default generation before a status request, discovery of new models, AWS/ID-derived display labels, and fail-closed discovery errors without restoring a static list. No functional regression or blocking finding was identified. Two nonblocking documentation qualifications are recorded in `tmp/m3-bedrock-adapter-a2a7467-review.md`: distinguish the accepted HTTP 500 invocation-error policy from HTTP 502 malformed-output handling, and qualify model-family reasoning/history verification as protocol/mock-level or documented behavior rather than unverified live account invocation. Owner decisions were not reversed; no implementation/test files, live AWS resources, or ADRs were changed by this review.

---

## 6. Next Session Handoff

* **Where We Stopped:** The latest actionable fixes remain verified, and independent review of `a2a7467` found no functional regression or blocking finding in the static-catalog cleanup. Automated suites are green (`444` Route Builder tests, `22` browser tests, `22` CDK tests, builds/synthesis, Android unit-test task). Discovery policy wording now reflects ADR-0011 and the production static catalog is removed; the two minor documentation qualifications in discovery log item 14 remain. Live Bedrock invocation is still blocked by account-level Error 002 pending AWS Support; this is local/code verification, not completion of the full cloud Definition of Done.
* **Resolution of Nonblocking Review Notes (Owner Decisions):**
  1. **Upstream HTTP Status Fidelity (500 vs 502/503):** Owner explicitly decided that returning HTTP 500 on upstream provider errors to client applications is acceptable to conceal internal infrastructure implementation details, provided the Fastify server logs the exact upstream failure with full diagnostics.
  2. **Availability UI Feedback:** Owner confirmed that UI disabled states must adhere to Human-Centered UI/UX Principles (`AGENTS.md` Rule 8 and Section 2C) with provider-neutral copy (`src/constants/aiCopy.ts`) and must never leak cloud infrastructure names ("AWS", "Bedrock", or internal error codes). Clean disabled tooltips and drawer/modal notices are retained.
  3. **Orphan Closing Tags in Raw SSE Deltas:** Owner explicitly reviewed and dismissed this as a cosmetic nit not worth the regression risk; completed text is already sanitized by `sanitizeBedrockResponse()` before display.
  4. **Model Reasoning & Tool History Compatibility:** AWS Bedrock provides no capability discovery API for tool-loop history quirks. Verified that the current implementation (`{ text: cleanedTurnText, toolUse }`) handles both standard instruction models (Amazon Nova, Meta Llama, Mistral AI, Cohere) and text-tag reasoning models (Moonshot Kimi K3, DeepSeek R1) correctly. Claude extended thinking is out of scope.
* **Next Step:** Await AWS Support, verify real `Converse`/`ConverseStream` calls in `us-east-2` when access is restored, and obtain approval before deployment/manual CloudFront acceptance. Archive WP-03 and advance to M4 only after its complete Definition of Done is satisfied. No additional provider refactor or new ADR is required.
* **Known Limitation:** `tsconfig.json` / `tsconfig.server.json` cover `src/` and `server/` only; Vitest transpiles `tests/` without typechecking. A trial `tsconfig.test.json` surfaced ~30 pre-existing test-only type drifts (AWS SDK event fixtures, mock component types, `PromiseSettledResult` narrowing) unrelated to M3, so a test-inclusive typecheck is deferred rather than mixed into this WP.
