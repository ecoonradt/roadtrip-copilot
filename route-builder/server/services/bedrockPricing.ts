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
  const usagetype = a.usagetype ?? '';
  const inference = a.inferenceType ?? '';
  const feature = a.feature ?? '';
  const all = `${inference} ${usagetype} ${feature}`.toLowerCase();
  if (/audio|image|video/.test(all) || /provisioned throughput|reserved|custom model|fine.?tun/.test(all)) return null;
  if (/priority|flex|batch/.test(all) || /batch inference/i.test(feature)) return null;
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
  // Strict precedence: verbatim foundation ID, version-suffix-stripped ID, committed
  // Amazon-native alias, then the vendor-prefix-stripped bare key.
  const keys: string[] = [];
  const addKey = (key: string): void => { if (!keys.includes(key)) keys.push(key); };
  addKey(model.foundationModelId);
  const stripped = model.foundationModelId.replace(/-(?:v)?\d+:\d+$/, '');
  addKey(stripped);
  const alias = AMAZON_NATIVE_PRICING_KEY_ALIASES[model.foundationModelId];
  if (alias !== undefined) addKey(alias);
  const dot = stripped.indexOf('.');
  if (dot >= 0) addKey(stripped.slice(dot + 1));
  return keys;
}

function pathAMatches(candidate: Candidate, key: string): boolean {
  const usage = candidate.entry.product.attributes.usagetype ?? '';
  const prefix = usage.replace(/^USE2-/, '');
  if (!prefix.startsWith(`${key}-`)) return false;
  const remainder = prefix.slice(key.length + 1).toLowerCase();
  return /^(mantle|input|output|text-input|text-output|cache)(?:-|$)/.test(remainder);
}

function rateString(candidate: Candidate): string {
  const nanos = parseDecimalUsdStringToNanos(candidate.usd) * (candidate.unit === '1K tokens' ? 1000n : 1n);
  return formatUsd(toSafeNumberNanos(nanos));
}

function targetScope(model: DiscoveredBedrockModel): 'global' | 'regional' {
  return model.modelId.startsWith('global.') ? 'global' : 'regional';
}

// Path A resolves a model's dimensions from a single service code. A key wins only when
// it carries exactly one input and exactly one output at the model's target scope, both
// from the same service code; lower-precedence keys are consulted only while no key wins.
function resolvePathAKey(model: DiscoveredBedrockModel, candidates: Candidate[]): Candidate[] {
  const scope = targetScope(model);
  for (const key of pathAKeyCandidates(model)) {
    const keyMatches = candidates.filter(candidate => candidate.entry.serviceCode !== 'AmazonBedrockFoundationModels' && candidate.scope === scope && pathAMatches(candidate, key));
    const inputs = keyMatches.filter(candidate => candidate.dimension === 'input');
    const outputs = keyMatches.filter(candidate => candidate.dimension === 'output');
    if (inputs.length !== 1 || outputs.length !== 1) continue;
    const serviceCode = inputs[0].entry.serviceCode;
    if (outputs[0].entry.serviceCode !== serviceCode) continue;
    return keyMatches.filter(candidate => candidate.entry.serviceCode === serviceCode);
  }
  return [];
}

// Path B is display-name based. A display name is unambiguous when every discovered
// model sharing it is an inference profile of the same foundation model; distinct
// foundations sharing a name remain ambiguous and are never guessed.
function resolvePathB(model: DiscoveredBedrockModel, discoveredModels: DiscoveredBedrockModel[], candidates: Candidate[]): Candidate[] {
  const scope = targetScope(model);
  const matches: Candidate[] = [];
  for (const candidate of candidates) {
    if (candidate.entry.serviceCode !== 'AmazonBedrockFoundationModels' || candidate.scope !== scope) continue;
    const attrs = candidate.entry.product.attributes;
    const display = (attrs.model ?? '').trim();
    const providerPrefix = `${(attrs.provider ?? '').trim()} `;
    const normalizedDisplay = providerPrefix.trim() !== '' && display.startsWith(providerPrefix) ? display.slice(providerPrefix.length).trim() : display;
    const matchingModels = discoveredModels.filter(other => other.modelName.trim() === normalizedDisplay);
    const matchingFoundations = new Set(matchingModels.map(other => other.foundationModelId));
    if (matchingFoundations.size === 1 && model.modelName.trim() === normalizedDisplay) matches.push(candidate);
  }
  return matches;
}

function singleDimension(candidates: Candidate[], dimension: Dimension): Candidate | null {
  const matches = candidates.filter(candidate => candidate.dimension === dimension);
  return matches.length === 1 ? matches[0] : null;
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
  return values.reduce((sum, [count, price]) => sum + (price === null ? 0 : calculatePerMillionRateCostNanos(count, price)), 0);
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
