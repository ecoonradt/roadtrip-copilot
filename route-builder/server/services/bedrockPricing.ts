import { GetProductsCommand, PricingClient, type GetProductsCommandOutput } from '@aws-sdk/client-pricing';
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
export interface BedrockPricingCatalog { schemaVersion: 1; region: 'us-east-2'; refreshedAt: string; models: Record<string, BedrockModelTokenRate>; unpricedModelIds: string[]; }
export interface DiscoveredBedrockModel { modelId: string; foundationModelId: string; providerName: string; modelName: string; }
export interface BedrockTokenUsage { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheWriteInputTokens: number; }

// The AWS Price List Query API is a global service endpoint hosted only in us-east-1/ap-south-1;
// this is NOT a regional-resource region, and the priced region remains us-east-2.
export const PRICING_API_REGION = 'us-east-1';
export const PRICED_REGION = 'us-east-2';
export const MAX_PRICING_PAGES = 20;
export const PRICING_FETCH_TIMEOUT_MS = 45_000;
export const BEDROCK_PRICING_SERVICE_CODES = ['AmazonBedrock', 'AmazonBedrockFoundationModels', 'AmazonBedrockService'] as const;
export class PricingUnavailableError extends Error { constructor(message: string) { super(message); this.name = 'PricingUnavailableError'; } }
export const AMAZON_NATIVE_PRICING_KEY_ALIASES: Readonly<Record<string, string>> = {
  'amazon.nova-2-lite-v1:0': 'Nova2.0Lite', 'amazon.nova-pro-v1:0': 'NovaPro', 'amazon.nova-lite-v1:0': 'NovaLite',
  'amazon.nova-micro-v1:0': 'NovaMicro', 'amazon.nova-premier-v1:0': 'NovaPremier',
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
  product: { productFamily: string; attributes: Record<string, string | undefined>; sku: string };
  serviceCode: string;
  terms: { OnDemand?: Record<string, { priceDimensions: Record<string, { unit: string; pricePerUnit?: { USD?: string } }> }> };
}
type Dimension = 'input' | 'output' | 'cacheRead' | 'cacheWrite';
interface Candidate { entry: RawPriceListEntry; dimension: Dimension; usd: string; unit: string; scope: 'global' | 'regional'; }

function parseEntry(text: string): RawPriceListEntry | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    const product = record.product;
    const terms = record.terms;
    if (typeof record.serviceCode !== 'string' || typeof product !== 'object' || product === null || typeof terms !== 'object' || terms === null) return null;
    const productRecord = product as Record<string, unknown>;
    const attributes = productRecord.attributes;
    const onDemand = (terms as Record<string, unknown>).OnDemand;
    if (typeof productRecord.productFamily !== 'string' || typeof productRecord.sku !== 'string' || typeof attributes !== 'object' || attributes === null || typeof onDemand !== 'object' || onDemand === null) return null;
    return { product: { productFamily: productRecord.productFamily, sku: productRecord.sku, attributes: attributes as Record<string, string | undefined> }, serviceCode: record.serviceCode, terms: { OnDemand: onDemand as RawPriceListEntry['terms']['OnDemand'] } };
  } catch { return null; }
}

function classify(entry: RawPriceListEntry): Candidate | null {
  const a = entry.product.attributes;
  const serviceTier = (a.service_tier ?? '').trim().toLowerCase();
  if (serviceTier !== '' && serviceTier !== 'standard' && serviceTier !== 'global-standard') return null;
  const usagetype = a.usagetype ?? '';
  const inference = a.inferenceType ?? '';
  const feature = a.feature ?? '';
  const all = `${inference} ${usagetype} ${feature} ${a.model ?? ''}`.toLowerCase();
  if (/audio|image|video/.test(all) || /provisioned throughput|reserved|custom model|fine.?tun/.test(all)) return null;
  if (/priority|flex|batch|latency[-_ ]?optimized|long[-_ ]?(?:ctx|context)/.test(all) || /batch inference/i.test(feature)) return null;
  let dimension: Dimension | null = null;
  if (/cache/.test(all) && /read/.test(all)) dimension = 'cacheRead';
  else if (/cache/.test(all) && /write/.test(all)) dimension = 'cacheWrite';
  else if (/input/.test(all)) dimension = 'input';
  else if (/output/.test(all)) dimension = 'output';
  if (dimension === null || (/1h|cache-write-1h|cachewrite1h/i.test(all))) return null;
  const prices = Object.values(entry.terms.OnDemand ?? {}).flatMap(term => Object.values(term.priceDimensions));
  const priced = prices.find(price => (price.unit === '1K tokens' || price.unit === '1M tokens') && typeof price.pricePerUnit?.USD === 'string');
  const usd = priced?.pricePerUnit?.USD;
  if (priced === undefined || usd === undefined) return null;
  try { parseDecimalUsdStringToNanos(usd); } catch { return null; }
  const scope = /global|cross-region/.test(all) ? 'global' : 'regional';
  return { entry, dimension, usd, unit: priced.unit, scope };
}

function pathAKeyCandidates(model: DiscoveredBedrockModel): string[] {
  // Strict precedence: verbatim foundation ID, version-suffix-stripped ID, the same ID
  // without an instruct marker, a committed cross-vendor alias, then the
  // vendor-prefix-stripped bare keys.
  const keys: string[] = [];
  const addKey = (key: string): void => { if (!keys.includes(key)) keys.push(key); };
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

function rateString(candidate: Candidate): string {
  const nanos = parseDecimalUsdStringToNanos(candidate.usd) * (candidate.unit === '1K tokens' ? 1000n : 1n);
  return formatUsd(toSafeNumberNanos(nanos));
}

function targetScope(model: DiscoveredBedrockModel): 'global' | 'regional' {
  return model.modelId.startsWith('global.') ? 'global' : 'regional';
}

// Path A resolves a model's dimensions from a single service code. A key wins as soon as
// any service code publishes a complete input+output pair for it, and only that code's
// candidates are returned; lower-precedence keys are consulted only while no key wins.
function resolvePathAKey(model: DiscoveredBedrockModel, candidates: Candidate[]): Candidate[] {
  const scope = targetScope(model);
  for (const key of pathAKeyCandidates(model)) {
    const keyMatches = candidates.filter(candidate => candidate.entry.serviceCode !== 'AmazonBedrockFoundationModels' && candidate.scope === scope && pathAMatches(candidate, key));
    const serviceCode = singleCompleteServiceCode(keyMatches);
    if (serviceCode !== null) return keyMatches.filter(candidate => candidate.entry.serviceCode === serviceCode);
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
  const withoutProvider = provider !== '' && withoutScope.toLowerCase().startsWith(`${provider.toLowerCase()} `)
    ? withoutScope.slice(provider.length + 1)
    : withoutScope;
  return withoutProvider.trim().toLowerCase();
}

function resolvePathB(model: DiscoveredBedrockModel, discoveredModels: DiscoveredBedrockModel[], candidates: Candidate[]): Candidate[] {
  const scope = targetScope(model);
  const matches: Candidate[] = [];
  const modelDisplay = normalizeDisplayName(model.modelName, model.providerName);
  for (const candidate of candidates) {
    if (candidate.entry.serviceCode !== 'AmazonBedrockFoundationModels' || candidate.scope !== scope) continue;
    const attrs = candidate.entry.product.attributes;
    const display = normalizeDisplayName(attrs.model ?? '', attrs.provider ?? '');
    const matchingModels = discoveredModels.filter(other => normalizeDisplayName(other.modelName, other.providerName) === display);
    const matchingFoundations = new Set(matchingModels.map(other => other.foundationModelId));
    if (matchingFoundations.size === 1 && modelDisplay === display) matches.push(candidate);
  }
  return matches;
}

function singleDimension(candidates: Candidate[], dimension: Dimension): Candidate | null {
  const matches = candidates.filter(candidate => candidate.dimension === dimension);
  if (matches.length === 0) return null;
  const distinctRates = new Set(matches.map(rateString));
  return distinctRates.size === 1 ? matches[0] : null;
}

// A rate record is assembled from exactly one service code: a complete input+output
// pair from that code plus its own cache dimensions. Candidates from other service
// codes never contribute to the record, and two competing complete sources are unpriced.
function singleCompleteServiceCode(candidates: Candidate[]): string | null {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) groups.set(candidate.entry.serviceCode, [...(groups.get(candidate.entry.serviceCode) ?? []), candidate]);
  let winner: string | null = null;
  for (const [serviceCode, group] of groups) {
    if (singleDimension(group, 'input') === null || singleDimension(group, 'output') === null) continue;
    if (winner !== null) return null;
    winner = serviceCode;
  }
  return winner;
}

export function calculateBedrockCallCostNanos(usage: BedrockTokenUsage, rate: BedrockModelTokenRate): number {
  const values: Array<[number, string | null]> = [[usage.inputTokens, rate.inputPerMillionUsd], [usage.outputTokens, rate.outputPerMillionUsd], [usage.cacheReadInputTokens, rate.cacheReadPerMillionUsd], [usage.cacheWriteInputTokens, rate.cacheWritePerMillionUsd]];
  const sum = values.reduce((total, [count, price]) => {
    // Validate every count even when the model publishes no cache rate, so negative or
    // fractional cache usage can never slip through unpriced dimensions.
    const cost = price === null ? calculatePerMillionRateCostNanos(count, '0') : calculatePerMillionRateCostNanos(count, price);
    return total + BigInt(cost);
  }, 0n);
  return toSafeNumberNanos(sum);
}

export function normalizeBedrockPricing(input: { priceLists: ReadonlyArray<{ serviceCode: string; entries: string[] }>; discoveredModels: DiscoveredBedrockModel[]; refreshedAt: string }): BedrockPricingCatalog {
  const raw = new Map<string, RawPriceListEntry>();
  for (const list of input.priceLists) for (const text of list.entries) if (!raw.has(text)) { const entry = parseEntry(text); if (entry !== null) raw.set(text, entry); }
  const candidates = Array.from(raw.values()).map(classify).filter((candidate): candidate is Candidate => candidate !== null);
  const models: Record<string, BedrockModelTokenRate> = {};
  const unpriced: string[] = [];
  for (const model of input.discoveredModels) {
    const matches = [...resolvePathAKey(model, candidates), ...resolvePathB(model, input.discoveredModels, candidates)];
    const source = singleCompleteServiceCode(matches);
    const sourceMatches = source === null ? [] : matches.filter(candidate => candidate.entry.serviceCode === source);
    const inputRate = singleDimension(sourceMatches, 'input');
    const outputRate = singleDimension(sourceMatches, 'output');
    if (source === null || inputRate === null || outputRate === null) { unpriced.push(model.modelId); continue; }
    const cacheRead = singleDimension(sourceMatches, 'cacheRead');
    const cacheWrite = singleDimension(sourceMatches, 'cacheWrite');
    models[model.modelId] = {
      modelId: model.modelId,
      foundationModelId: model.foundationModelId,
      providerName: model.providerName,
      inputPerMillionUsd: rateString(inputRate),
      outputPerMillionUsd: rateString(outputRate),
      cacheReadPerMillionUsd: cacheRead === null ? null : rateString(cacheRead),
      cacheWritePerMillionUsd: cacheWrite === null ? null : rateString(cacheWrite),
    };
  }
  unpriced.sort();
  return { schemaVersion: 1, region: PRICED_REGION, refreshedAt: input.refreshedAt, models, unpricedModelIds: unpriced };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function validRate(value: unknown): value is string { if (typeof value !== 'string') return false; try { parseDecimalUsdStringToNanos(value); return true; } catch { return false; } }

export function validateBedrockPricingCatalog(value: unknown): BedrockPricingCatalog {
  if (!isRecord(value)) throw new Error('Pricing catalog must be an object');
  if (value.schemaVersion !== 1) throw new Error('Pricing catalog schemaVersion must be 1');
  if (value.region !== PRICED_REGION) throw new Error('Pricing catalog region must be us-east-2');
  if (typeof value.refreshedAt !== 'string' || Number.isNaN(Date.parse(value.refreshedAt))) throw new Error('Pricing catalog refreshedAt must be a valid ISO timestamp');
  if (!isRecord(value.models)) throw new Error('Pricing catalog models must be an object');
  for (const [key, item] of Object.entries(value.models)) {
    if (!isRecord(item) || item.modelId !== key || typeof item.foundationModelId !== 'string' || typeof item.providerName !== 'string' || !validRate(item.inputPerMillionUsd) || !validRate(item.outputPerMillionUsd) || !(item.cacheReadPerMillionUsd === null || validRate(item.cacheReadPerMillionUsd)) || !(item.cacheWritePerMillionUsd === null || validRate(item.cacheWritePerMillionUsd))) throw new Error(`Malformed pricing model: ${key}`);
  }
  if (!Array.isArray(value.unpricedModelIds) || !value.unpricedModelIds.every(item => typeof item === 'string')) throw new Error('Pricing catalog unpricedModelIds must be a string array');
  const unpricedIds = new Set(value.unpricedModelIds);
  for (const modelId of Object.keys(value.models)) {
    if (unpricedIds.has(modelId)) throw new Error(`Pricing catalog cannot list model ${modelId} as both priced and unpriced`);
  }
  return value as unknown as BedrockPricingCatalog;
}

export async function fetchBedrockPricingCatalog(options: { discoveredModels: DiscoveredBedrockModel[]; pricingClient?: PricingClient; now?: () => number }): Promise<BedrockPricingCatalog> {
  const client = options.pricingClient ?? new PricingClient({ region: PRICING_API_REGION, requestHandler: { requestTimeout: PRICING_FETCH_TIMEOUT_MS } });
  const now = options.now ?? Date.now;
  const started = now();
  const lists: Array<{ serviceCode: string; entries: string[] }> = [];
  try {
    for (const serviceCode of BEDROCK_PRICING_SERVICE_CODES) {
      const entries: string[] = []; let nextToken: string | undefined;
      for (let page = 0; ; page += 1) {
        if (page >= MAX_PRICING_PAGES) throw new PricingUnavailableError(`Pricing pages exceeded for service code ${serviceCode}`);
        if (now() - started > PRICING_FETCH_TIMEOUT_MS) throw new PricingUnavailableError('Bedrock pricing fetch exceeded its timeout');
        const command = new GetProductsCommand({ ServiceCode: serviceCode, Filters: [{ Type: 'TERM_MATCH', Field: 'regionCode', Value: PRICED_REGION }], MaxResults: 100, ...(nextToken === undefined ? {} : { NextToken: nextToken }) });
        const response: GetProductsCommandOutput = await client.send(command);
        entries.push(...(response.PriceList ?? []));
        nextToken = response.NextToken;
        if (nextToken === undefined) break;
      }
      lists.push({ serviceCode, entries: Array.from(new Set(entries)) });
    }
    if (now() - started > PRICING_FETCH_TIMEOUT_MS) throw new PricingUnavailableError('Bedrock pricing fetch exceeded its timeout');
    return normalizeBedrockPricing({ priceLists: lists, discoveredModels: options.discoveredModels, refreshedAt: new Date(now()).toISOString() });
  } catch (err: unknown) {
    if (err instanceof PricingUnavailableError) throw err;
    throw new PricingUnavailableError(`Unable to fetch Bedrock pricing: ${err instanceof Error ? err.message : String(err)}`);
  }
}
