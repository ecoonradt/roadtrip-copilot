# ADR-0010: Amazon Bedrock Inference Profiles, Regional Model Availability & Reasoning Tag Hygiene

* **Date:** 2026-10-22
* **Status:** Accepted
* **Deciders:** Eric, Antigravity
* **Related Work Package:** [`WP-03-bedrock-adapter-and-model-selection.md`](../plan/active/WP-03-bedrock-adapter-and-model-selection.md)

---

## 1. Context & Problem Statement
While preparing Milestone 3 (`AwsBedrockHarnessAdapter` in `us-east-2`), live verification against the project's AWS account (`597787441620`, assigned region `us-east-2`) using `aws bedrock list-foundation-models`, `aws bedrock list-inference-profiles`, and `aws bedrock-runtime converse` surfaced three operational realities that differ from idealized documentation examples:

1. **Inference Profile Requirement (`INFERENCE_PROFILE` vs. `ON_DEMAND`):**
   In `us-east-2`, many frontier models on Amazon Bedrock (including `moonshotai.kimi-k3`, `amazon.nova-2-lite-v1:0`, `amazon.nova-pro-v1:0`, `anthropic.claude-*`, `openai.gpt-6-*`, `xai.grok-*`, and `meta.llama4-*`) advertise `inferenceTypesSupported: ["INFERENCE_PROFILE"]` rather than direct `ON_DEMAND` foundation-model invocation. Invoking their bare foundation model ID (e.g., `moonshotai.kimi-k3` or `amazon.nova-pro-v1:0`) throws `ValidationException: Invocation of model ID ... with on-demand throughput isn’t supported. Retry your request with the ID or ARN of an inference profile that contains this model`. Invoking their system-defined US inference profile (`us.moonshotai.kimi-k3`, `us.amazon.nova-2-lite-v1:0`, `us.amazon.nova-pro-v1:0`) succeeds in `us-east-2`.
   Meanwhile, other models in `us-east-2` (`openai.gpt-oss-120b-1:0`, `openai.gpt-oss-20b-1:0`, `deepseek.v3.2`, `mistral.mistral-large-3-675b-instruct`, `moonshotai.kimi-k2.5`, `amazon.nova-lite-v1:0`) support direct `ON_DEMAND` invocation using their bare foundation model ID.

2. **Account-Level Provider Entitlements vs. Out-of-the-Box Active Models:**
   On a standard self-serve AWS project account without separate AWS Sales contracts or Anthropic use-case form submissions, `openai.gpt-6-*`, `anthropic.claude-sonnet-5-5`, and `xai.grok-4.7` return `AccessDeniedException` (`not available for this account... contact AWS Sales`), and certain Anthropic models return `ResourceNotFoundException` until the Anthropic use-case form is submitted. By contrast, frontier models including **Moonshot Kimi K3 (`us.moonshotai.kimi-k3`)**, **Amazon Nova 2 Lite (`us.amazon.nova-2-lite-v1:0`)**, **Amazon Nova Pro (`us.amazon.nova-pro-v1:0`)**, **OpenAI GPT-OSS 120B (`openai.gpt-oss-120b-1:0`)**, **OpenAI GPT-OSS 20B (`openai.gpt-oss-20b-1:0`)**, **DeepSeek V3.2 (`deepseek.v3.2`)**, **Mistral Large 3 675B (`mistral.mistral-large-3-675b-instruct`)**, and **Moonshot Kimi K2.5 (`moonshotai.kimi-k2.5`)** are active immediately in `us-east-2` with full `ConverseStream` and `toolConfig` support.

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
* **Option B: Curated Multi-Vendor Bedrock Catalog with Verified Active Defaults, Inference Profile Alias Normalization, Dual-Resource IAM Policy, and Reasoning Stream Hygiene:** Default `BEDROCK_SCOUT_MODEL_ID` to `us.moonshotai.kimi-k3` (verified North Star frontier model active in `us-east-2`) and `BEDROCK_COPYWRITER_MODEL_ID` to `us.amazon.nova-2-lite-v1:0` (verified 1.3s low-latency model active in `us-east-2`), expose the full curated catalog in the UI selector, normalize bare model aliases to their required `us.` inference profile IDs, grant IAM `bedrock:InvokeModel*` on both `foundation-model/*` and `inference-profile/*`, and filter `reasoningContent` / `<thinking>` tags during streaming and post-processing.

## 4. Decision Outcome
Chosen Option: **Option B**.

### Positive Consequences
* Immediate, verified zero-error execution in `us-east-2` for both Route Scout streaming tool loops and single/batch alert copywriting.
* Seamless compatibility if a user or environment variable specifies either a bare model ID (`moonshotai.kimi-k3`, `anthropic.claude-sonnet-5-5`, `openai.gpt-6-luna`) or its inference profile ID (`us.moonshotai.kimi-k3`, `us.anthropic.claude-sonnet-5-5`, `us.openai.gpt-6-luna`).
* Clean chat bubbles and JSON parsing across all Bedrock model families (Moonshot, Amazon Nova, OpenAI, DeepSeek, Mistral, Anthropic, xAI).

### Negative Consequences / Trade-offs
* Enterprise-gated models in the catalog will return a clear, actionable Bedrock error message if selected in the UI before the account owner enables them in the AWS Bedrock Console; the default models are guaranteed active out of the box.

## 5. Implementation Notes & Code Touchpoints
* `route-builder/server/services/bedrockService.ts`:
  * Default `BEDROCK_SCOUT_MODEL_ID` = `'us.moonshotai.kimi-k3'`; default `BEDROCK_COPYWRITER_MODEL_ID` = `'us.amazon.nova-2-lite-v1:0'`.
  * Normalize known bare inference-profile model IDs to their `us.` prefix and validate requested `modelId` values against the curated catalog + configured environment model IDs (`400 Bad Request` on unknown model IDs).
  * Set appropriate `maxTokens` (`4096` for copywriting/text and Route Scout multi-turn tool streaming). Amazon Nova models enforce an upper limit of 5,000 output tokens (`maxTokens <= 5000`), so `4096` ensures maximum headroom across both Moonshot and Nova models without tripping validation caps.
  * Dynamically filter active models via `bedrock:GetFoundationModelAvailability` (`refreshModelAvailability`) with 5-minute in-memory caching, presenting only verified available models in `GET /api/ai/status`.
  * Ignore `delta.reasoningContent` for user-visible text chunks, strip `<thinking>...</thinking>`, `<think>...</think>`, and lone/orphan closing tags (`</thinking>`, `</think>`) during streaming and in `sanitizeResponse`, and omit `reasoningContent` when appending assistant `toolUse` turns to `messages`.
* `infra/lib/roadtrip-cloud-stack.ts`:
  * Grant `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on `arn:aws:bedrock:*::foundation-model/*` and `arn:aws:bedrock:*:${this.account}:inference-profile/*`.
  * Grant `bedrock:GetFoundationModelAvailability` and `bedrock:ListInferenceProfiles` on `*`.

## 6. Addendum (2026-10-23): Account Plan Transition & Error 002 Resolution
On 2026-10-23, runtime invocation tests against `us-east-2` Bedrock models on the initial Free Tier plan returned `ValidationException: Error 002: Access to Bedrock models is not allowed for this account`. Investigation revealed that the AWS 'New Experience' Free Tier plan placed an automated safety hold on foundation model marketplace agreements.

Transitioning the account plan to `PAID` (with promotional credits expanded to $159.99) and activating Advanced Features lifted the backend marketplace subscription constraints, enabling unconstrained model invocation across the active catalog while preserving the strict $0 idle cost architecture.


