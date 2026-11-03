# ADR-0014: Deterministic Bedrock Price-List Normalization Against the Live AWS Price List API

* **Date:** 2026-11-02
* **Status:** Accepted
* **Deciders:** Eric, GLM-5.3 (OpenCode orchestrator)
* **Related Work Package:** [`WP-04.5`](../plan/active/WP-04.5-user-spend-tracking.md) (Step 1), [ADR-0013](0013-per-user-spend-tracking.md)

---

## 1. Context & Problem Statement

WP-04.5 Step 1 requires a pure normalizer (`route-builder/server/services/bedrockPricing.ts`) that
converts AWS Price List API `GetProducts` responses into a `BedrockPricingCatalog` keyed by the
model IDs the app actually selects (bare foundation IDs, `us.*` and `global.*` system inference
profiles). A Gate 1 read-only live capture against the real Price List API in `us-east-1`
(2026-11-02, account 597787441620) revealed that the catalog's published shape is substantially
messier than the WP's source contract anticipated:

* **Split across three service codes with different grammars.** In `us-east-2`, 920 entries under
  `AmazonBedrock` (10 pages), 314 under `AmazonBedrockFoundationModels` (4 pages), and 18 under
  `AmazonBedrockService` (1 page, all reserved/provisioned throughput). **Anthropic models are
  entirely absent from `AmazonBedrock`** in `us-east-2` and are only published under
  `AmazonBedrockFoundationModels` as marketplace entries (`usagetype` like
  `USE2-MP:USE2_InputTokenCount-Units`) whose `usagetype` carries **no model identity at all** —
  the model is only identifiable via the `product.attributes.model` display name.
* **Unit variance.** `AmazonBedrock` entries use `unit: "1K tokens"`; `AmazonBedrockFoundationModels`
  entries use `unit: "1M tokens"`. Any per-1M assumption is wrong for two thirds of the data.
* **Model identity in `usagetype` is inconsistent.** Partner models appear with dotted,
  vendor-prefixed keys (`USE2-moonshotai.kimi-k3-mantle-input-tokens-standard`) but sometimes with
  the version suffix dropped (`openai.gpt-oss-120b-1:0` is priced as `openai.gpt-oss-120b`), and
  some models have a **second, duplicate bare-key entry set** (`USE2-gpt-oss-120b-input-tokens`
  alongside the vendor-prefixed set). Amazon-native models appear only under CamelCase keys
  (`USE2-Nova2.0Lite-input-tokens`) that share **no token** with their foundation model IDs
  (`amazon.nova-2-lite-v1:0`; Bedrock's `modelName` "Nova 2 Lite" ≠ pricing's `model` "Nova 2.0
  Lite", so display-name bridging also fails). Meta Llama models similarly appear only under
  CamelCase keys (`Llama3-1-405B`).
* **Tier/scope noise.** Standard, `-priority`, `-flex`, `-batch`, `-global`/`-cross-region-global`
  variants coexist per dimension; cache-write has 30m and 1h variants; the same service code also
  publishes Bedrock Flows, Guardrails, Data Automation, and Knowledge Base SKUs whose usagetypes
  are unrelated to model inference.

## 2. Decision Drivers

* **Determinism (ADR-0013):** never invent or guess a rate; any model whose input/output rates
  cannot be *deterministically* matched lands in `unpricedModelIds` and is excluded from selection.
* **The configured defaults must resolve prices:** `us.moonshotai.kimi-k3` and
  `us.amazon.nova-2-lite-v1:0` are the Scout and copywriter defaults; §C.4 of WP-04.5 requires both
  to remain selectable, so the matcher must bridge Amazon-native CamelCase keys.
* **Fail-loud over heuristic:** fuzzy name matching (version-dot collapsing, edit distance) risks
  silently binding the wrong SKU's price to a model — the single worst failure mode for a spend
  ledger.

## 3. Considered Options

* **Option A: Single-grammar usagetype parser.** Parse one canonical `USE2-{modelId}-{dimension}`
  grammar. Rejected: the live data shows at least four coexisting grammars (dotted+mantle, dotted
  bare, CamelCase, marketplace `USE2-MP:`), so any single grammar silently drops whole vendor
  families into `unpricedModelIds`.
* **Option B: Fuzzy display-name matching everywhere.** Match pricing `model` display names to
  Bedrock `modelName` with normalization. Rejected as the primary path: "Nova 2.0 Lite" vs
  "Nova 2 Lite" cannot be bridged without version-dot heuristics; display names are also non-unique
  across vendors.
* **Option C: Two-path deterministic matching (usagetype-key path + marketplace display-name path)
  with a committed Amazon-native identity alias table.** Chosen.

## 4. Decision Outcome

Chosen Option: **Option C**, implemented in `bedrockPricing.ts`:

1. **Usagetype-key path (`AmazonBedrock` entries).** For each discovered model, derive candidate
   pricing keys in strict precedence: (a) `foundationModelId` verbatim; (b) `foundationModelId`
   with a trailing `-vN:M`/`-N:M` version suffix stripped (`openai.gpt-oss-120b-1:0` →
   `openai.gpt-oss-120b`); (c) for `amazon.*` models only, a **committed identity alias table**
   (`amazon.nova-2-lite-v1:0` → `Nova2.0Lite`, `amazon.nova-pro-v1:0` → `NovaPro`,
   `amazon.nova-lite-v1:0` → `NovaLite`, `amazon.nova-micro-v1:0` → `NovaMicro`,
   `amazon.nova-premier-v1:0` → `NovaPremier`). An entry matches a discovered model only when the
   usagetype, after stripping the `USE2-` region prefix, contains the candidate key as a
   **token-bounded substring immediately followed by the dimension grammar** (`-mantle-`, `-input`,
   `-output`, `-cache-`, or end-of-key), so `gpt-oss-120b` can never match `gpt-oss-120b-safeguard`.
   A bare (vendor-prefix-stripped) key match is accepted only when no higher-precedence key yields
   a complete input+output set for that model.
2. **Marketplace display-name path (`AmazonBedrockFoundationModels` entries).** Match
   `product.attributes.model` to Bedrock's `modelName` after deterministically stripping a leading
   `{provider} ` prefix from the pricing name (pricing publishes "OpenAI GPT-6 Astra" for Bedrock's
   "GPT-6 Astra"); exact equality otherwise.
3. **Dimension & tier classification.** Classify each matched entry by its `inferenceType` /
   `usagetype` / `feature` tokens into input / output / cache-read / cache-write, ignoring
   audio/image/video token dimensions, and tag tier `standard|priority|flex|batch` and scope
   `regional|global`. Only **standard tier, on-demand, text** dimensions are eligible; provisioned
   throughput, reserved, batch, fine-tuning, and non-inference SKUs are excluded.
4. **Scope selection per selectable model ID.** Bare foundation IDs and `us.*` profiles resolve to
   the **regional (non-global)** standard rates; `global.*` profiles resolve to the **global**
   (`-global-standard` / `-cross-region-global` / `_Global-Units`) standard rates. Cache-write uses
   the default (30m for `AmazonBedrock` partner entries, plain `CacheWriteInputTokenCount` — not
   `1h` — for marketplace entries); cache-read/write rates are optional (`null` when absent).
5. **Unit-aware conversion.** `unit` is honored explicitly: `"1K tokens"` rates are converted to
   per-million before nanodollar math; `"1M tokens"` rates pass through. All rates are stored in
   `BedrockModelTokenRate` as per-1M USD decimal strings.
6. **Alias maintenance is loud.** A discovered model with no deterministic match (today: all
   `meta.llama*` models, which publish only CamelCase keys with no dotted equivalent) lands in
   `unpricedModelIds`, is excluded from `getAvailableModels()`, and rejects direct
   `validateModelId()` calls with `HTTP 503`. Adding an alias is a deliberate, reviewed code edit —
   never a silent price guess.

*Amendment (2026-11-02, after Gate 2B review of the Step 1 implementation):* two deterministic
tightenings are now part of the matching contract. (a) The **complete-set precedence** applies to
every precedence key, not only the bare key: a key wins only when its matches contain exactly one
input and exactly one output at the model's target scope; a key yielding only partial or ambiguous
dimensions simply does not win and the next key is consulted. (b) **Single-service-code sourcing:**
all resolved dimensions for a model (input, output, and any cache rates) must come from one service
code — a cache candidate published under a different service code than the winning input/output
source is ignored (cache field `null`), and two competing complete sources leave the model unpriced.
Both rules preserve the fail-safe direction: ambiguity degrades to loud `unpricedModelIds`, never
to a mixed or guessed price.

### Positive Consequences

* Both configured defaults resolve real, live-verified rates (captured 2026-11-02: Kimi K3
  regional standard $3.30/$16.50 per 1M input/output; Nova 2 Lite $0.33/$2.75; global variants
  $3.00/$15.00 and $0.30/$2.50 respectively).
* No fuzzy matching anywhere: every resolved rate is provably bound to the right SKU.
* Vendor-family grammar drift degrades to loud `unpricedModelIds`, never to wrong prices.

### Negative Consequences / Trade-offs

* New Amazon-native Bedrock models require a one-line alias-table addition before they become
  selectable (visible immediately via `GET /api/ai/status`, which reports the exclusion).
* `meta.llama*` models (currently discovered/selectable) become unpriced — and therefore
  unselectable once Step 2 lands the catalog intersection — until aliases are added. This is the
  WP-04.5-designed behavior (unpriced ⇒ excluded), accepted deliberately.
* The matcher must be regression-tested against committed fixtures modeled on the real captured
  entries; AWS grammar drift will surface as unpriced models, requiring fixture/alias updates.

## 5. Implementation Notes & Code Touchpoints

* Normalizer & alias table: `route-builder/server/services/bedrockPricing.ts` (Step 1)
* Fixtures modeled on the 2026-11-02 live capture: `route-builder/tests/ai/bedrockPricing.test.ts`
* Catalog consumption (Step 2): `bedrockPricingCache.ts`, `bedrockService.ts`,
  `handlers/refreshBedrockPricing.ts`, `infra/lib/roadtrip-cloud-stack.ts`
* Raw captured evidence (orchestrator session): `GetProducts` envelopes for all three service codes
  in `us-east-2`, including the complete dimension matrix for `us.moonshotai.kimi-k3` and
  `amazon.nova-2-lite-v1:0`.
