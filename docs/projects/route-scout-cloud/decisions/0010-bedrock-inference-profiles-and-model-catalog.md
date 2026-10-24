# ADR-0010: Amazon Bedrock Inference Profiles, Regional Model Availability & Reasoning Tag Hygiene

* **Date:** 2026-10-22
* **Status:** Accepted
* **Deciders:** Eric, Antigravity
* **Related Work Package:** [`WP-03-bedrock-adapter-and-model-selection.md`](../plan/active/WP-03-bedrock-adapter-and-model-selection.md)

> **Partial supersession:** [ADR-0011](0011-bedrock-discovery-with-exclusions-and-lifecycle-integrity.md) replaces this ADR's curated catalog/admission policy with AWS-driven discovery and explicit exclusions. The default models, inference-profile/IAM requirements, and outstanding account-access limitation remain applicable. References below to a curated discovery allowlist describe the earlier decision, not the current admission policy.

---

## 1. Context & Problem Statement
While preparing Milestone 3 (`AwsBedrockHarnessAdapter` in `us-east-2`), read-only verification against the project's AWS account (`597787441620`, assigned region `us-east-2`) using `aws bedrock list-foundation-models` and `aws bedrock list-inference-profiles`, plus attempted `aws bedrock-runtime converse` calls, surfaced three operational realities that differ from idealized documentation examples:

1. **Inference Profile Requirement (`INFERENCE_PROFILE` vs. `ON_DEMAND`):**
   In `us-east-2`, many frontier models on Amazon Bedrock (including `moonshotai.kimi-k3`, `amazon.nova-2-lite-v1:0`, `amazon.nova-pro-v1:0`, `anthropic.claude-*`, `openai.gpt-6-*`, `xai.grok-*`, and `meta.llama4-*`) advertise `inferenceTypesSupported: ["INFERENCE_PROFILE"]` rather than direct `ON_DEMAND` foundation-model invocation. Invoking their bare foundation model ID (e.g., `moonshotai.kimi-k3` or `amazon.nova-pro-v1:0`) throws `ValidationException: Invocation of model ID ... with on-demand throughput isn’t supported. Retry your request with the ID or ARN of an inference profile that contains this model`. Invoking their system-defined US inference profile (`us.moonshotai.kimi-k3`, `us.amazon.nova-2-lite-v1:0`, `us.amazon.nova-pro-v1:0`) is the required invocation form in `us-east-2`. Live invocation of any model is currently blocked by the account-level `ValidationException: Error 002` described in §6, so this remains catalog-verified rather than runtime-verified.
   Meanwhile, other models in `us-east-2` (`openai.gpt-oss-120b-1:0`, `openai.gpt-oss-20b-1:0`, `deepseek.v3.2`, `mistral.mistral-large-3-675b-instruct`, `moonshotai.kimi-k2.5`, `amazon.nova-lite-v1:0`) support direct `ON_DEMAND` invocation using their bare foundation model ID.

2. **Account-Level Provider Entitlements vs. Out-of-the-Box Active Models:**
   On a standard self-serve AWS project account without separate AWS Sales contracts or Anthropic use-case form submissions, `openai.gpt-6-*`, `anthropic.claude-sonnet-5-5`, and `xai.grok-4.7` return `AccessDeniedException` (`not available for this account... contact AWS Sales`), and certain Anthropic models return `ResourceNotFoundException` until the Anthropic use-case form is submitted. By contrast, frontier models including **Moonshot Kimi K3 (`us.moonshotai.kimi-k3`)**, **Amazon Nova 2 Lite (`us.amazon.nova-2-lite-v1:0`)**, **Amazon Nova Pro (`us.amazon.nova-pro-v1:0`)**, **OpenAI GPT-OSS 120B (`openai.gpt-oss-120b-1:0`)**, **OpenAI GPT-OSS 20B (`openai.gpt-oss-20b-1:0`)**, **DeepSeek V3.2 (`deepseek.v3.2`)**, **Mistral Large 3 675B (`mistral.mistral-large-3-675b-instruct`)**, and **Moonshot Kimi K2.5 (`moonshotai.kimi-k2.5`)** are listed for `us-east-2` with `ConverseStream` and `toolConfig` support. Runtime confirmation is still pending resolution of the account-level Error 002 (§6).

3. **Reasoning Content & `<thinking>` Tag Variations Across Providers:**
   In Bedrock `Converse` / `ConverseStream`:
   * Models such as `us.moonshotai.kimi-k3` and `openai.gpt-oss-120b-1:0` emit structured `reasoningContent` blocks alongside `text` and `toolUse` blocks, and count `reasoningContent` tokens toward `inferenceConfig.maxTokens`.
   * Models such as `us.amazon.nova-pro-v1:0` and `amazon.nova-lite-v1:0` emit `<thinking>...</thinking>` XML tags inside `text` blocks when `toolConfig` is active (whereas existing response sanitization only stripped `<think>...</think>`).
   * When sending multi-turn tool results (`toolResult`) back to Bedrock, re-sending `reasoningContent` inside the prior `assistant` message is unnecessary and brittle across providers, whereas sending only the assistant's `text` (if non-empty) and `toolUse` blocks works uniformly across all tested providers.

## 2. Decision Drivers
* Out-of-the-box reliability in both local `npm run dev` and deployed AWS Lambda in `us-east-2` without requiring enterprise AWS Sales contracts.
* Full support for the North Star model catalog (`BEDROCK_SCOUT_MODEL_ID`, `BEDROCK_COPYWRITER_MODEL_ID`, and runtime UI selection) while preventing arbitrary unapproved model ARN injection.
* Least-privilege IAM permissions on the Fastify Lambda execution role that authorize both direct foundation models and `us.*` system-defined inference profiles.
* Clean user-facing streaming output free of internal `<thinking>` / `<think>` tags or raw `reasoningContent` blocks.

## 3. Considered Options
* **Option A: Hardcode Only Conceptual North Star Model IDs (`openai.gpt-6-luna`, `anthropic.claude-sonnet-5-5`) with Foundation-Model-Only IAM Policy:** Fails at runtime in `us-east-2` with `ValidationException` (missing `us.` inference profile prefix and missing `inference-profile/*` IAM resource permission) and `AccessDeniedException` (AWS Sales gating).
* **Option B: Curated Multi-Vendor Bedrock Catalog with Catalog-Verified Defaults, Inference Profile Alias Normalization, Dual-Resource IAM Policy, and Reasoning Stream Hygiene:** Default `BEDROCK_SCOUT_MODEL_ID` to `us.moonshotai.kimi-k3` (catalog-listed North Star frontier model in `us-east-2`) and `BEDROCK_COPYWRITER_MODEL_ID` to `us.amazon.nova-2-lite-v1:0` (catalog-listed low-latency model in `us-east-2`), expose the full curated catalog in the UI selector, normalize bare model aliases to their required `us.` inference profile IDs, grant IAM `bedrock:InvokeModel*` on both `foundation-model/*` and `inference-profile/*`, and filter `reasoningContent` / `<thinking>` tags during streaming and post-processing.

## 4. Decision Outcome
Chosen Option: **Option B**.

### Positive Consequences
* A deterministic, fail-loud adapter targeting `us-east-2` that normalizes bare model IDs to the inference profile IDs the catalog requires, with no silent fallback path. End-to-end invocation against the project account remains pending AWS support for Error 002 (§6).
* Seamless compatibility if a user or environment variable specifies either a bare model ID (`moonshotai.kimi-k3`, `anthropic.claude-sonnet-5-5`, `openai.gpt-6-luna`) or its inference profile ID (`us.moonshotai.kimi-k3`, `us.anthropic.claude-sonnet-5-5`, `us.openai.gpt-6-luna`).
* Clean chat bubbles and JSON parsing across all Bedrock model families (Moonshot, Amazon Nova, OpenAI, DeepSeek, Mistral, Anthropic, xAI).

### Negative Consequences / Trade-offs
* Enterprise-gated models in the catalog will return a clear, actionable Bedrock error message if selected in the UI before the account owner enables them in the AWS Bedrock Console. The default models are catalog-listed, and account access is verified dynamically by `/api/ai/status`; failures are surfaced rather than silently substituted.

## 5. Implementation Notes & Code Touchpoints
* `route-builder/server/services/bedrockService.ts`:
  * Default `BEDROCK_SCOUT_MODEL_ID` = `'us.moonshotai.kimi-k3'`; default `BEDROCK_COPYWRITER_MODEL_ID` = `'us.amazon.nova-2-lite-v1:0'`.
  * Normalize known bare inference-profile model IDs to their `us.` prefix and validate requested `modelId` values against the curated catalog + configured environment model IDs (`400 Bad Request` on unknown model IDs).
  * Set appropriate `maxTokens` (`4096` for copywriting/text and Route Scout multi-turn tool streaming). Amazon Nova models enforce an upper limit of 5,000 output tokens (`maxTokens <= 5000`), so `4096` ensures maximum headroom across both Moonshot and Nova models without tripping validation caps.
  * Dynamically filter active models in `refreshModelAvailability`: strip cross-region prefixes (`us.`, `eu.`, `apac.`, `global.`, `us-gov.`) with `toFoundationModelId()` before calling `bedrock:GetFoundationModelAvailability` (the API accepts a foundation model ID, not an inference profile ID), and validate inference profile IDs against `bedrock:ListInferenceProfiles` (`status === 'ACTIVE'`). `getAvailableModels()` caches the verified list for `MODEL_AVAILABILITY_TTL_MS` (5 minutes) and `GET /api/ai/status` advertises only that verified list. Failures propagate to the caller instead of restoring the unverified catalog.
  * Ignore `delta.reasoningContent` for user-visible text chunks, strip `<thinking>...</thinking>`, `<think>...</think>`, and lone/orphan closing tags (`</thinking>`, `</think>`) during streaming and in `sanitizeResponse`, and omit `reasoningContent` when appending assistant `toolUse` turns to `messages`.
* `infra/lib/roadtrip-cloud-stack.ts`:
  * Grant `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on `arn:aws:bedrock:*::foundation-model/*` and `arn:aws:bedrock:*:${this.account}:inference-profile/*`.
  * Grant `bedrock:GetFoundationModelAvailability` and `bedrock:ListInferenceProfiles` on `*`.

## 6. Addendum (2026-10-23): Account Plan Transition & Outstanding Error 002

Runtime invocation tests against `us-east-2` Bedrock models return `ValidationException: Error 002: Access to Bedrock models is not allowed for this account`. The account was upgraded from the AWS 'New Experience' Free Tier plan to `PAID` (promotional credits expanded to $159.99) and Advanced Features were activated. That removed the Free Tier plan restrictions, but **Error 002 still reproduces** and the account is still awaiting AWS Support resolution.

Consequences:

* The adapter, catalog, IAM policy, and unit/integration tests are implemented and verified locally; live Bedrock invocation is **not** verified.
* No documentation, test, or status message may claim Error 002 is resolved until an actual `Converse`/`ConverseStream` call succeeds on the account.
* `/api/ai/status` must continue to report `available: false` with the upstream error when model availability cannot be confirmed, rather than advertising the catalog.

