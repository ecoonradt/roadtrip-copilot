import {
  GetProductsCommand,
  PricingClient,
  type GetProductsCommandInput,
  type GetProductsCommandOutput,
} from '@aws-sdk/client-pricing';
import {
  calculatePerMillionRateCostNanos,
  formatUsd,
  parseDecimalUsdStringToNanos,
  toSafeNumberNanos,
} from './spendMath.js';

export interface BedrockModelTokenRate {
  modelId: string;
  foundationModelId: string;
  providerName: string;
  inputPerMillionUsd: string;
  outputPerMillionUsd: string;
  cacheReadPerMillionUsd: string | null;
  cacheWritePerMillionUsd: string | null;
}

export interface BedrockPricingCatalog {
  schemaVersion: 1;
  region: 'us-east-2';
  refreshedAt: string;
  models: Record<string, BedrockModelTokenRate>;
  unpricedModelIds: string[];
}

export interface DiscoveredBedrockModel {
  modelId: string;
  foundationModelId: string;
  providerName: string;
  modelName: string;
}

export interface BedrockTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
}

// The AWS Price List Query API is a global service endpoint hosted only in
// us-east-1/ap-south-1; this is NOT a regional-resource region, and the priced
// region remains us-east-2.
export const PRICING_API_REGION = 'us-east-1';
export const PRICED_REGION = 'us-east-2';
export const MAX_PRICING_PAGES = 20;
export const PRICING_FETCH_TIMEOUT_MS = 45_000;
export const BEDROCK_PRICING_SERVICE_CODES = [
  'AmazonBedrock',
  'AmazonBedrockFoundationModels',
  'AmazonBedrockService',
] as const;

/**
 * Service codes that must publish price-list entries. An empty response from
 * either of them means the upstream catalog was truncated or filtered away, and
 * never produces a valid (but empty) pricing catalog.
 */
export const REQUIRED_BEDROCK_PRICING_SERVICE_CODES = [
  'AmazonBedrock',
  'AmazonBedrockFoundationModels',
] as const;

export class PricingUnavailableError extends Error {
  readonly statusCode = 503;

  constructor(message: string) {
    super(message);
    this.name = 'PricingUnavailableError';
  }
}

export const AMAZON_NATIVE_PRICING_KEY_ALIASES: Readonly<Record<string, string>> = {
  'amazon.nova-2-lite-v1:0': 'Nova2.0Lite',
  'amazon.nova-pro-v1:0': 'NovaPro',
  'amazon.nova-lite-v1:0': 'NovaLite',
  'amazon.nova-micro-v1:0': 'NovaMicro',
  'amazon.nova-premier-v1:0': 'NovaPremier',
};

export const BEDROCK_PRICING_KEY_ALIASES: Readonly<Record<string, string>> = {
  ...AMAZON_NATIVE_PRICING_KEY_ALIASES,
  'deepseek.v3-v1:0': 'deepseek.v3.1',
  'deepseek.r1-v1:0': 'DeepSeek-R1',
  'mistral.pixtral-large-2502-v1:0': 'PixtralLarge2502',
  'moonshot.kimi-k2-thinking': 'moonshotai.kimi-k2-thinking',
  'zai.glm-5': 'zai.glm5',
};

interface RawPriceListEntry {
  product: {
    productFamily: string;
    attributes: Record<string, string | undefined>;
    sku: string;
  };
  serviceCode: string;
  terms: {
    OnDemand?: Record<
      string,
      { priceDimensions: Record<string, { unit: string; pricePerUnit?: { USD?: string } }> }
    >;
  };
}

type Dimension = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

interface Candidate {
  entry: RawPriceListEntry;
  dimension: Dimension;
  /** Exact per-1M-token rate string, used for rate comparisons and catalog output. */
  perMillionUsd: string;
  /** Exact per-1M-token nanodollars, used to reject $0 input/output rates. */
  perMillionNanos: bigint;
  scope: 'global' | 'regional';
}

interface TokenRate {
  unit: string;
  usd: string;
  perMillionUsd: string;
  perMillionNanos: bigint;
}

/** Token-denominated price dimensions published by AWS. */
function isTokenUnit(unit: string): boolean {
  return unit === '1K tokens' || unit === '1M tokens';
}

/**
 * 1-hour cache-write SKUs are excluded from standard on-demand pricing. The
 * duration marker is alphanumeric-bounded so dashed (`-1hr`, `-1hour`) and
 * underscore-joined (`write_1h`) forms match, and the concatenated
 * (`cachewrite1h`) form is kept. The pattern is only ever matched against SKU
 * identity, never against a model display name that merely contains the
 * characters "1h".
 */
const ONE_HOUR_CACHE_WRITE_PATTERN = /(?<![a-z0-9])1h(?:r|our)?s?(?![a-z0-9])|cachewrite1h/;

function parseEntry(text: string): RawPriceListEntry | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    const product = record.product;
    const terms = record.terms;
    if (typeof record.serviceCode !== 'string') return null;
    if (typeof product !== 'object' || product === null) return null;
    if (typeof terms !== 'object' || terms === null) return null;
    const productRecord = product as Record<string, unknown>;
    const attributes = productRecord.attributes;
    const onDemand = (terms as Record<string, unknown>).OnDemand;
    if (typeof productRecord.productFamily !== 'string') return null;
    if (typeof productRecord.sku !== 'string') return null;
    if (typeof attributes !== 'object' || attributes === null) return null;
    if (typeof onDemand !== 'object' || onDemand === null) return null;
    return {
      product: {
        productFamily: productRecord.productFamily,
        sku: productRecord.sku,
        attributes: attributes as Record<string, string | undefined>,
      },
      serviceCode: record.serviceCode,
      terms: { OnDemand: onDemand as RawPriceListEntry['terms']['OnDemand'] },
    };
  } catch {
    return null;
  }
}

/**
 * Resolves a token dimension from SKU identity only. The model display name is
 * never consulted, so a model whose name happens to contain "cache", "read", or
 * "write" cannot be misclassified or silently dropped.
 */
function classifyDimension(inferenceType: string, usagetype: string): Dimension | null {
  const text = `${inferenceType} ${usagetype}`;
  if (/cache/.test(text)) {
    if (/read/.test(text)) return 'cacheRead';
    if (/write/.test(text)) return 'cacheWrite';
    // A cache SKU without an explicit read/write dimension is never input/output.
    return null;
  }
  if (/input/.test(text)) return 'input';
  if (/output/.test(text)) return 'output';
  return null;
}

/** Collects every token-denominated price dimension published by one SKU. */
function tokenPrices(entry: RawPriceListEntry): Array<{ unit: string; usd: string }> {
  const prices: Array<{ unit: string; usd: string }> = [];
  for (const term of Object.values(entry.terms.OnDemand ?? {})) {
    for (const price of Object.values(term.priceDimensions)) {
      const usd = price.pricePerUnit?.USD;
      if (isTokenUnit(price.unit) && typeof usd === 'string') {
        prices.push({ unit: price.unit, usd });
      }
    }
  }
  return prices;
}

/** Converts a per-unit token price into its exact per-1M-token rate. */
function tokenRate(unit: string, usd: string): TokenRate | null {
  try {
    const nanos = parseDecimalUsdStringToNanos(usd) * (unit === '1K tokens' ? 1000n : 1n);
    return {
      unit,
      usd,
      perMillionUsd: formatUsd(toSafeNumberNanos(nanos)),
      perMillionNanos: nanos,
    };
  } catch {
    return null;
  }
}

function classify(entry: RawPriceListEntry): Candidate | null {
  const attributes = entry.product.attributes;
  const serviceTier = (attributes.service_tier ?? '').trim().toLowerCase();
  if (serviceTier !== '' && serviceTier !== 'standard' && serviceTier !== 'global-standard') {
    return null;
  }

  const usagetype = (attributes.usagetype ?? '').toLowerCase();
  const inferenceType = (attributes.inferenceType ?? '').toLowerCase();
  const feature = (attributes.feature ?? '').toLowerCase();
  const modelName = (attributes.model ?? '').toLowerCase();

  // SKU identity comes from the usage type, inference type, and feature for the
  // dimension and the variant exclusions below. The model display name widens the
  // conservative product exclusions and carries the scope signal when the usage
  // type has none: a SKU that names itself "Global" is a global rate.
  const skuText = `${inferenceType} ${usagetype} ${feature}`;
  const productText = `${skuText} ${modelName}`;

  if (/audio|image|video/.test(productText)) return null;
  if (/provisioned throughput|reserved|custom model|fine.?tun/.test(productText)) return null;
  if (/priority|flex|batch|latency[-_ ]?optimized|long[-_ ]?(?:ctx|context)/.test(productText)) {
    return null;
  }
  if (/batch inference/i.test(feature)) return null;
  if (ONE_HOUR_CACHE_WRITE_PATTERN.test(skuText)) return null;

  const dimension = classifyDimension(inferenceType, usagetype);
  if (dimension === null) return null;

  // A SKU that publishes more than one distinct per-1M rate (tiered or
  // multi-dimension terms) is ambiguous and is never priced at one of its rates.
  let resolved: TokenRate | null = null;
  for (const price of tokenPrices(entry)) {
    const rate = tokenRate(price.unit, price.usd);
    if (rate === null) continue;
    if (resolved !== null && resolved.perMillionUsd !== rate.perMillionUsd) return null;
    if (resolved === null) resolved = rate;
  }
  if (resolved === null) return null;

  // A $0 input or output rate is never a real list price; a $0 cache rate is
  // legitimate (Amazon Nova 2 Lite publishes free cache writes).
  if (dimension === 'input' || dimension === 'output') {
    if (resolved.perMillionNanos === 0n) return null;
  }

  const scope = /global|cross-region/.test(productText) ? 'global' : 'regional';
  return {
    entry,
    dimension,
    perMillionUsd: resolved.perMillionUsd,
    perMillionNanos: resolved.perMillionNanos,
    scope,
  };
}

function pathAKeyCandidates(model: DiscoveredBedrockModel): string[] {
  // Strict precedence: verbatim foundation ID, version-suffix-stripped ID, the same ID
  // without an instruct marker, a committed cross-vendor alias, then the
  // vendor-prefix-stripped bare keys.
  const keys: string[] = [];
  const addKey = (key: string): void => {
    if (!keys.includes(key)) keys.push(key);
  };
  addKey(model.foundationModelId);
  const stripped = model.foundationModelId.replace(/-(?:v)?\d+:\d+$/, '');
  addKey(stripped);
  const noInstruct = stripped.replace(/-instruct$/i, '');
  addKey(noInstruct);
  const alias = BEDROCK_PRICING_KEY_ALIASES[model.foundationModelId];
  if (alias !== undefined) addKey(alias);
  const dot = stripped.indexOf('.');
  if (dot >= 0) {
    addKey(stripped.slice(dot + 1));
    addKey(noInstruct.slice(noInstruct.indexOf('.') + 1));
  }
  return keys;
}

function pathAMatches(candidate: Candidate, key: string): boolean {
  const usage = candidate.entry.product.attributes.usagetype ?? '';
  const prefix = usage.replace(/^USE2-/i, '');
  if (!prefix.toLowerCase().startsWith(`${key.toLowerCase()}-`)) return false;
  const remainder = prefix.slice(key.length + 1).toLowerCase();
  return /^(?:instruct-)?(?:mantle|input|output|text-input|text-output|cache)(?:-|$)/.test(remainder);
}

function targetScope(model: DiscoveredBedrockModel): 'global' | 'regional' {
  return model.modelId.startsWith('global.') ? 'global' : 'regional';
}

function groupByServiceCode(candidates: Candidate[]): Map<string, Candidate[]> {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const existing = groups.get(candidate.entry.serviceCode);
    if (existing === undefined) {
      groups.set(candidate.entry.serviceCode, [candidate]);
    } else {
      existing.push(candidate);
    }
  }
  return groups;
}

/** Service codes that publish a complete input+output pair for one key. */
function completeServiceCodes(candidates: Candidate[]): string[] {
  const complete: string[] = [];
  for (const [serviceCode, group] of groupByServiceCode(candidates)) {
    if (singleDimension(group, 'input') !== null && singleDimension(group, 'output') !== null) {
      complete.push(serviceCode);
    }
  }
  return complete;
}

/**
 * True when one service code publishes differing input or output rates for the
 * same key, which makes the key ambiguous rather than merely incomplete.
 */
function hasConflictingRates(candidates: Candidate[]): boolean {
  for (const group of groupByServiceCode(candidates).values()) {
    for (const dimension of ['input', 'output'] as const) {
      const matches = group.filter(candidate => candidate.dimension === dimension);
      if (matches.length === 0) continue;
      if (new Set(matches.map(candidate => candidate.perMillionUsd)).size > 1) return true;
    }
  }
  return false;
}

/**
 * Path A resolves a model's dimensions from a single service code. Precedence
 * stops at the first key that yields any candidates: a key whose result is
 * ambiguous (two complete service codes, or differing input/output rates) leaves
 * the model unpriced instead of letting a lower-precedence bare key win, while a
 * key that only yields incomplete dimensions continues to the next key.
 */
function resolvePathAKey(model: DiscoveredBedrockModel, candidates: Candidate[]): Candidate[] {
  const scope = targetScope(model);
  for (const key of pathAKeyCandidates(model)) {
    const keyMatches = candidates.filter(
      (candidate) =>
        candidate.entry.serviceCode !== 'AmazonBedrockFoundationModels' &&
        candidate.scope === scope &&
        pathAMatches(candidate, key),
    );
    if (keyMatches.length === 0) continue;
    const complete = completeServiceCodes(keyMatches);
    if (complete.length > 1) return keyMatches;
    if (complete.length === 1) {
      const serviceCode = complete[0];
      return keyMatches.filter(candidate => candidate.entry.serviceCode === serviceCode);
    }
    if (hasConflictingRates(keyMatches)) return keyMatches;
  }
  return [];
}

// Path B is display-name based. A display name is unambiguous when every discovered
// model sharing it is an inference profile of the same foundation model; distinct
// foundations sharing a name remain ambiguous and are never guessed.
function normalizeDisplayName(rawName: string, providerName: string): string {
  const trimmed = rawName.trim();
  const withoutScope = trimmed.replace(/^(?:us|global|eu|apac)\s+/i, '');
  const provider = providerName.trim();
  const withoutProvider =
    provider !== '' && withoutScope.toLowerCase().startsWith(`${provider.toLowerCase()} `)
      ? withoutScope.slice(provider.length + 1)
      : withoutScope;
  return withoutProvider.trim().toLowerCase();
}

function resolvePathB(
  model: DiscoveredBedrockModel,
  discoveredModels: DiscoveredBedrockModel[],
  candidates: Candidate[],
): Candidate[] {
  const scope = targetScope(model);
  const matches: Candidate[] = [];
  const modelDisplay = normalizeDisplayName(model.modelName, model.providerName);
  for (const candidate of candidates) {
    if (candidate.entry.serviceCode !== 'AmazonBedrockFoundationModels') continue;
    if (candidate.scope !== scope) continue;
    const attrs = candidate.entry.product.attributes;
    const display = normalizeDisplayName(attrs.model ?? '', attrs.provider ?? '');
    const matchingModels = discoveredModels.filter(
      (other) => normalizeDisplayName(other.modelName, other.providerName) === display,
    );
    const matchingFoundations = new Set(matchingModels.map((other) => other.foundationModelId));
    if (matchingFoundations.size === 1 && modelDisplay === display) matches.push(candidate);
  }
  return matches;
}

function singleDimension(candidates: Candidate[], dimension: Dimension): Candidate | null {
  const matches = candidates.filter(candidate => candidate.dimension === dimension);
  if (matches.length === 0) return null;
  const distinctRates = new Set(matches.map(candidate => candidate.perMillionUsd));
  return distinctRates.size === 1 ? matches[0] : null;
}

// A rate record is assembled from exactly one service code: a complete input+output
// pair from that code plus its own cache dimensions. Candidates from other service
// codes never contribute to the record, and two competing complete sources are unpriced.
function singleCompleteServiceCode(candidates: Candidate[]): string | null {
  const complete = completeServiceCodes(candidates);
  return complete.length === 1 ? complete[0] : null;
}

export function calculateBedrockCallCostNanos(
  usage: BedrockTokenUsage,
  rate: BedrockModelTokenRate,
): number {
  const values: Array<[number, string | null]> = [
    [usage.inputTokens, rate.inputPerMillionUsd],
    [usage.outputTokens, rate.outputPerMillionUsd],
    [usage.cacheReadInputTokens, rate.cacheReadPerMillionUsd],
    [usage.cacheWriteInputTokens, rate.cacheWritePerMillionUsd],
  ];
  const sum = values.reduce((total, [count, price]) => {
    // Validate every count even when the model publishes no cache rate, so negative or
    // fractional cache usage can never slip through unpriced dimensions.
    const cost =
      price === null
        ? calculatePerMillionRateCostNanos(count, '0')
        : calculatePerMillionRateCostNanos(count, price);
    return total + BigInt(cost);
  }, 0n);
  return toSafeNumberNanos(sum);
}

export function normalizeBedrockPricing(input: {
  priceLists: ReadonlyArray<{ serviceCode: string; entries: string[] }>;
  discoveredModels: DiscoveredBedrockModel[];
  refreshedAt: string;
}): BedrockPricingCatalog {
  const raw = new Map<string, RawPriceListEntry>();
  for (const list of input.priceLists) {
    for (const text of list.entries) {
      if (raw.has(text)) continue;
      const entry = parseEntry(text);
      if (entry !== null) raw.set(text, entry);
    }
  }
  const candidates = Array.from(raw.values())
    .map(classify)
    .filter((candidate): candidate is Candidate => candidate !== null);
  const models: Record<string, BedrockModelTokenRate> = {};
  const unpriced: string[] = [];
  for (const model of input.discoveredModels) {
    const matches = [
      ...resolvePathAKey(model, candidates),
      ...resolvePathB(model, input.discoveredModels, candidates),
    ];
    const source = singleCompleteServiceCode(matches);
    const sourceMatches =
      source === null ? [] : matches.filter(candidate => candidate.entry.serviceCode === source);
    const inputRate = singleDimension(sourceMatches, 'input');
    const outputRate = singleDimension(sourceMatches, 'output');
    if (source === null || inputRate === null || outputRate === null) {
      unpriced.push(model.modelId);
      continue;
    }
    const cacheRead = singleDimension(sourceMatches, 'cacheRead');
    const cacheWrite = singleDimension(sourceMatches, 'cacheWrite');
    models[model.modelId] = {
      modelId: model.modelId,
      foundationModelId: model.foundationModelId,
      providerName: model.providerName,
      inputPerMillionUsd: inputRate.perMillionUsd,
      outputPerMillionUsd: outputRate.perMillionUsd,
      cacheReadPerMillionUsd: cacheRead === null ? null : cacheRead.perMillionUsd,
      cacheWritePerMillionUsd: cacheWrite === null ? null : cacheWrite.perMillionUsd,
    };
  }
  unpriced.sort();
  return {
    schemaVersion: 1,
    region: PRICED_REGION,
    refreshedAt: input.refreshedAt,
    models,
    unpricedModelIds: unpriced,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validRate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    parseDecimalUsdStringToNanos(value);
    return true;
  } catch {
    return false;
  }
}

/** A priced input or output rate must be strictly greater than zero. */
function positiveRate(value: unknown): value is string {
  if (!validRate(value)) return false;
  return parseDecimalUsdStringToNanos(value) > 0n;
}

export function validateBedrockPricingCatalog(value: unknown): BedrockPricingCatalog {
  if (!isRecord(value)) throw new Error('Pricing catalog must be an object');
  if (value.schemaVersion !== 1) throw new Error('Pricing catalog schemaVersion must be 1');
  if (value.region !== PRICED_REGION) throw new Error('Pricing catalog region must be us-east-2');
  if (typeof value.refreshedAt !== 'string' || Number.isNaN(Date.parse(value.refreshedAt))) {
    throw new Error('Pricing catalog refreshedAt must be a valid ISO timestamp');
  }
  if (!isRecord(value.models)) throw new Error('Pricing catalog models must be an object');
  for (const [key, item] of Object.entries(value.models)) {
    if (!isRecord(item)) throw new Error(`Malformed pricing model: ${key}`);
    if (item.modelId !== key) throw new Error(`Malformed pricing model: ${key}`);
    if (typeof item.foundationModelId !== 'string') {
      throw new Error(`Malformed pricing model: ${key}`);
    }
    if (typeof item.providerName !== 'string') {
      throw new Error(`Malformed pricing model: ${key}`);
    }
    if (!positiveRate(item.inputPerMillionUsd)) {
      throw new Error(`Malformed pricing model: ${key}`);
    }
    if (!positiveRate(item.outputPerMillionUsd)) {
      throw new Error(`Malformed pricing model: ${key}`);
    }
    if (!(item.cacheReadPerMillionUsd === null || validRate(item.cacheReadPerMillionUsd))) {
      throw new Error(`Malformed pricing model: ${key}`);
    }
    if (!(item.cacheWritePerMillionUsd === null || validRate(item.cacheWritePerMillionUsd))) {
      throw new Error(`Malformed pricing model: ${key}`);
    }
  }
  if (!Array.isArray(value.unpricedModelIds)) {
    throw new Error('Pricing catalog unpricedModelIds must be a string array');
  }
  if (!value.unpricedModelIds.every(item => typeof item === 'string')) {
    throw new Error('Pricing catalog unpricedModelIds must be a string array');
  }
  const unpricedIds = new Set(value.unpricedModelIds);
  for (const modelId of Object.keys(value.models)) {
    if (unpricedIds.has(modelId)) {
      throw new Error(`Pricing catalog cannot list model ${modelId} as both priced and unpriced`);
    }
  }
  return value as unknown as BedrockPricingCatalog;
}

function isRequiredPricingServiceCode(serviceCode: string): boolean {
  return (REQUIRED_BEDROCK_PRICING_SERVICE_CODES as readonly string[]).includes(serviceCode);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Sends one GetProducts page under a hard deadline. The socket timeout alone can
 * exceed the total fetch budget by one page timeout, so the request is aborted
 * through an AbortSignal when the remaining budget is exhausted.
 */
async function sendGetProducts(
  client: PricingClient,
  input: GetProductsCommandInput,
  remainingMs: number,
): Promise<GetProductsCommandOutput> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, remainingMs);
  try {
    const command = new GetProductsCommand(input);
    return await client.send(command, { abortSignal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBedrockPricingCatalog(options: {
  discoveredModels: DiscoveredBedrockModel[];
  pricingClient?: PricingClient;
  now?: () => number;
}): Promise<BedrockPricingCatalog> {
  if (options.discoveredModels.length === 0) {
    throw new PricingUnavailableError('Bedrock pricing fetch received no discovered models to price');
  }
  const client =
    options.pricingClient ??
    new PricingClient({
      region: PRICING_API_REGION,
      requestHandler: { requestTimeout: PRICING_FETCH_TIMEOUT_MS },
    });
  const now = options.now ?? Date.now;
  const started = now();
  const deadline = started + PRICING_FETCH_TIMEOUT_MS;
  const lists: Array<{ serviceCode: string; entries: string[] }> = [];
  try {
    for (const serviceCode of BEDROCK_PRICING_SERVICE_CODES) {
      const entries: string[] = [];
      let nextToken: string | undefined;
      for (let page = 0; ; page += 1) {
        if (page >= MAX_PRICING_PAGES) {
          throw new PricingUnavailableError(`Pricing pages exceeded for service code ${serviceCode}`);
        }
        const remainingMs = deadline - now();
        if (remainingMs <= 0) {
          throw new PricingUnavailableError('Bedrock pricing fetch exceeded its timeout');
        }
        const input: GetProductsCommandInput = {
          ServiceCode: serviceCode,
          Filters: [{ Type: 'TERM_MATCH', Field: 'regionCode', Value: PRICED_REGION }],
          MaxResults: 100,
          ...(nextToken === undefined ? {} : { NextToken: nextToken }),
        };
        const response = await sendGetProducts(client, input, remainingMs);
        entries.push(...(response.PriceList ?? []));
        nextToken = response.NextToken;
        if (nextToken === undefined) break;
      }
      if (entries.length === 0 && isRequiredPricingServiceCode(serviceCode)) {
        throw new PricingUnavailableError(
          `Pricing service code ${serviceCode} returned no price-list entries`,
        );
      }
      lists.push({ serviceCode, entries: Array.from(new Set(entries)) });
    }
    if (now() > deadline) {
      throw new PricingUnavailableError('Bedrock pricing fetch exceeded its timeout');
    }
    const catalog = normalizeBedrockPricing({
      priceLists: lists,
      discoveredModels: options.discoveredModels,
      refreshedAt: new Date(now()).toISOString(),
    });
    if (Object.keys(catalog.models).length === 0) {
      throw new PricingUnavailableError(
        `Bedrock pricing catalog resolved no priced models (${options.discoveredModels.length} discovered)`,
      );
    }
    return catalog;
  } catch (err: unknown) {
    if (err instanceof PricingUnavailableError) throw err;
    if (isAbortError(err)) {
      throw new PricingUnavailableError('Bedrock pricing fetch exceeded its timeout');
    }
    throw new PricingUnavailableError(
      `Unable to fetch Bedrock pricing: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
