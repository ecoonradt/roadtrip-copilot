# ADR-0001: Amazon Bedrock for Unified Multi-Model AI Routing Under a Single AWS Invoice

* **Date:** 2026-10-17
* **Status:** Accepted
* **Deciders:** Eric, Antigravity
* **Related Work Package:** N/A (Foundational Blueprint)

---

## 1. Context & Problem Statement
Roadtrip Co-Pilot's Route Scout and alert copywriter require frontier intelligence (OpenAI GPT-6 series, Anthropic Claude Sonnet 5.5, xAI Grok) with streaming tool calling (OSRM snapping, Google Places, cascade math, web search). Previously, local prototyping relied on the Antigravity CLI (`agy`) or separate API vendor accounts requiring multiple billing relationships and external API keys stored in environment variables.

We needed a cloud AI inference solution that supports multi-model selection and streaming function calling while consolidating all cloud costs onto a single monthly invoice with zero idle fees.

## 2. Decision Drivers
* Single consolidated billing relationship on AWS alongside S3, CloudFront, and Lambda.
* Zero idle monthly cost ($0.00/mo base fee) with strictly per-token on-demand pricing.
* Zero external API keys in `.env` files; authentication handled via AWS IAM execution roles.
* Standardized SDK and streaming tool calling interface across multiple frontier providers.
* Runtime model selection allowing the user to select fast models (GPT-6 Luna) vs. deep reasoning models (Claude Sonnet 5.5).

## 3. Considered Options
* **Option A: Multi-Vendor Direct APIs (OpenAI + Anthropic + Google AI Studio directly):** Requires managing 3+ separate API keys, multiple credit cards, distinct SDK schemas, and secret storage in AWS Secrets Manager.
* **Option B: Amazon Bedrock ConverseStream API:** AWS-managed gateway hosting frontier models (OpenAI, Anthropic, xAI, Moonshot) behind a single unified SDK (`@aws-sdk/client-bedrock-runtime`), authorized via IAM roles, appearing on the single AWS monthly bill.
* **Option C: Self-Hosted Open-Weights Models on EC2 / ECS (vLLM / Ollama):** Extremely expensive continuous hourly GPU instance costs ($200–$800/mo), violating zero-idle-cost constraints.

## 4. Decision Outcome
Chosen Option: **Option B (Amazon Bedrock)**.

Fastify implements `AwsBedrockHarnessAdapter` implementing `AiHarnessAdapter` via `@aws-sdk/client-bedrock-runtime` (`ConverseStreamCommand`). Models are addressed via configurable IDs (`BEDROCK_SCOUT_MODEL_ID`, `BEDROCK_COPYWRITER_MODEL_ID`) with UI runtime selection support.

### Positive Consequences
* Single monthly AWS invoice covers all compute, storage, CDN egress, and AI inference.
* IAM role authentication means zero AI keys stored in container environments.
* Unified `ConverseStream` schema eliminates provider-specific adapter glue.
* Zero idle base fee ($0.00/month).

### Negative Consequences / Trade-offs
* Bedrock model access must be toggled on in the AWS Bedrock Console (one-time setup per region/account).
* Bedrock Converse streaming payload formats must be strictly adhered to by Fastify tool dispatchers.

## 5. Implementation Notes & Code Touchpoints
* Blueprint: [route_scout_cloud_architecture.md](../route_scout_cloud_architecture.md#3-the-single-bill-ai-solution-amazon-bedrock--configurable-model-selection)
* Adapter & tool services to build: `route-builder/server/services/bedrockService.ts`, `route-builder/server/services/scoutTools.ts`
* Existing files to extend:
  * `route-builder/server/services/aiService.ts` & `route-builder/server/types/ai.ts`: Extend `AiHarnessAdapter` and `AiEngineType` with `'bedrock'`, runtime model selection (`GET /api/ai/status`), and optional `generateStreamWithTools()` hook.
  * `route-builder/server/services/scoutService.ts`: Route streaming tool-call execution through `generateStreamWithTools` alongside the existing `AgyHarnessAdapter` local path.
* Environment variables: `BEDROCK_SCOUT_MODEL_ID`, `BEDROCK_COPYWRITER_MODEL_ID`, `AWS_REGION`
