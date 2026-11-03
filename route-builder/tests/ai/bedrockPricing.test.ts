import { describe, expect, it, vi } from 'vitest';
import { type GetProductsCommand, type PricingClient } from '@aws-sdk/client-pricing';
import {
  BEDROCK_PRICING_SERVICE_CODES,
  MAX_PRICING_PAGES,
  PRICED_REGION,
  PRICING_API_REGION,
  PricingUnavailableError,
  calculateBedrockCallCostNanos,
  fetchBedrockPricingCatalog,
  normalizeBedrockPricing,
  validateBedrockPricingCatalog,
  type BedrockModelTokenRate,
  type DiscoveredBedrockModel,
} from '../../server/services/bedrockPricing.js';
import { SpendConfigError } from '../../server/services/spendMath.js';

const REFRESHED_AT = '2026-11-02T00:00:00.000Z';

interface DimensionFixture {
  unit: string;
  usd: string;
  description?: string;
}

interface EntryFixture {
  serviceCode: string;
  usagetype: string;
  model: string;
  inferenceType: string;
  feature?: string;
  provider?: string;
  unit?: string;
  usd?: string;
  dimensions?: DimensionFixture[];
  sku?: string;
  attributes?: Record<string, string>;
}

interface PriceDimensionRecord {
  unit: string;
  endRange: string;
  description: string;
  beginRange: string;
  pricePerUnit: { USD: string };
}

interface PricingPage {
  PriceList: string[];
  NextToken?: string;
}

function priceEntry(fixture: EntryFixture): string {
  const dimensions = fixture.dimensions ?? [{ unit: fixture.unit ?? '1K tokens', usd: fixture.usd ?? '0.0000000000' }];
  const primaryUsd = dimensions[0]?.usd ?? '0.0000000000';
  const sku = (fixture.sku ?? `${fixture.usagetype}-${fixture.model}-${primaryUsd}`).replace(/\s+/g, '_');
  const priceDimensions: Record<string, PriceDimensionRecord> = {};
  dimensions.forEach((dimension, index) => {
    priceDimensions[`${sku}.JRTCKXETXF.${index === 0 ? '6YS6EN2CT7' : `DIM${index}`}`] = {
      unit: dimension.unit,
      endRange: 'Inf',
      description: dimension.description ?? `${fixture.usagetype} ${dimension.unit}`,
      beginRange: '0',
      pricePerUnit: { USD: dimension.usd },
    };
  });
  return JSON.stringify({
    product: {
      productFamily: 'Amazon Bedrock',
      attributes: {
        regionCode: PRICED_REGION,
        inferenceType: fixture.inferenceType,
        servicecode: fixture.serviceCode,
        provider: fixture.provider ?? 'Moonshot AI',
        usagetype: fixture.usagetype,
        locationType: 'AWS Region',
        location: 'US East (Ohio)',
        model: fixture.model,
        servicename: 'Amazon Bedrock',
        operation: '',
        ...(fixture.attributes ?? {}),
      },
      sku,
    },
    serviceCode: fixture.serviceCode,
    terms: {
      OnDemand: {
        [`${sku}.JRTCKXETXF`]: {
          priceDimensions,
          effectiveDate: '2026-11-01T00:00:00.000Z',
          termAttributes: {},
        },
      },
    },
    version: '20261101000000',
    publicationDate: '2026-11-01T00:00:00.000Z',
  });
}

function discovered(modelId: string, foundationModelId: string, providerName: string, modelName: string): DiscoveredBedrockModel {
  return { modelId, foundationModelId, providerName, modelName };
}

const kimiRegional = discovered('us.moonshotai.kimi-k3', 'moonshotai.kimi-k3', 'Moonshot AI', 'Kimi K3');
const kimiGlobal = discovered('global.moonshotai.kimi-k3', 'moonshotai.kimi-k3', 'Moonshot AI', 'Kimi K3');
const novaRegional = discovered('us.amazon.nova-2-lite-v1:0', 'amazon.nova-2-lite-v1:0', 'Amazon', 'Nova 2 Lite');
const novaGlobal = discovered('global.amazon.nova-2-lite-v1:0', 'amazon.nova-2-lite-v1:0', 'Amazon', 'Nova 2 Lite');

function bedrockTokenEntry(usagetype: string, model: string, inferenceType: string, usd: string, provider: string, feature = 'On-demand Inference'): string {
  return priceEntry({ serviceCode: 'AmazonBedrock', usagetype, model, inferenceType, feature, provider, unit: '1K tokens', usd });
}

function kimiEntries(): string[] {
  return [
    bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-input-tokens-standard', 'Kimi K3', 'Input tokens', '0.0033000000', 'Moonshot AI'),
    bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-output-tokens-standard', 'Kimi K3', 'Output tokens', '0.0165000000', 'Moonshot AI'),
    bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-cache-read-tokens-standard', 'Kimi K3', 'Cache read tokens', '0.0003300000', 'Moonshot AI'),
    bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-cache-write-tokens-30m-standard', 'Kimi K3', 'Cache write tokens', '0.0041250000', 'Moonshot AI'),
    bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-input-tokens-global-standard', 'Kimi K3', 'Input tokens', '0.0030000000', 'Moonshot AI'),
    bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-output-tokens-global-standard', 'Kimi K3', 'Output tokens', '0.0150000000', 'Moonshot AI'),
    bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-cache-read-tokens-global-standard', 'Kimi K3', 'Cache read tokens', '0.0003000000', 'Moonshot AI'),
    bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-cache-write-tokens-30m-global-standard', 'Kimi K3', 'Cache write tokens', '0.0037500000', 'Moonshot AI'),
    bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-input-tokens-priority', 'Kimi K3', 'Input tokens', '0.0099000000', 'Moonshot AI', 'Priority Inference'),
    bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-output-tokens-flex', 'Kimi K3', 'Output tokens', '0.0495000000', 'Moonshot AI', 'Flex Inference'),
    bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-input-tokens-batch', 'Kimi K3', 'Input tokens', '0.0016500000', 'Moonshot AI', 'Batch Inference'),
  ];
}

function novaEntries(): string[] {
  return [
    bedrockTokenEntry('USE2-Nova2.0Lite-input-tokens', 'Nova 2 Lite', 'Input tokens', '0.0003300000', 'Amazon'),
    bedrockTokenEntry('USE2-Nova2.0Lite-output-tokens', 'Nova 2 Lite', 'Output tokens', '0.0027500000', 'Amazon'),
    bedrockTokenEntry('USE2-Nova2.0Lite-cache-read-input-token-count', 'Nova 2 Lite', 'Cache read tokens', '0.0000825000', 'Amazon'),
    bedrockTokenEntry('USE2-Nova2.0Lite-cache-write-input-token-count', 'Nova 2 Lite', 'Cache write tokens', '0.0000000000', 'Amazon'),
    bedrockTokenEntry('USE2-Nova2.0Lite-input-tokens-cross-region-global', 'Nova 2 Lite', 'Input tokens', '0.0003000000', 'Amazon'),
    bedrockTokenEntry('USE2-Nova2.0Lite-output-tokens-cross-region-global', 'Nova 2 Lite', 'Output tokens', '0.0025000000', 'Amazon'),
    bedrockTokenEntry('USE2-Nova2.0Lite-cache-read-input-token-count-cross-region-global', 'Nova 2 Lite', 'Cache read tokens', '0.0000750000', 'Amazon'),
    bedrockTokenEntry('USE2-Nova2.0Lite-cache-write-input-token-count-cross-region-global', 'Nova 2 Lite', 'Cache write tokens', '0.0000000000', 'Amazon'),
    bedrockTokenEntry('USE2-Nova2.0Lite-input-tokens-priority', 'Nova 2 Lite', 'Input tokens', '0.0009900000', 'Amazon', 'Priority Inference'),
    bedrockTokenEntry('USE2-Nova2.0Lite-output-tokens-batch', 'Nova 2 Lite', 'Output tokens', '0.0013750000', 'Amazon', 'Batch Inference'),
  ];
}

function marketplaceEntry(usagetype: string, model: string, inferenceType: string, usd: string, provider = 'Anthropic', feature = 'On-demand Inference'): string {
  return priceEntry({ serviceCode: 'AmazonBedrockFoundationModels', usagetype, model, inferenceType, feature, provider, unit: '1M tokens', usd });
}

function claudeMarketplaceEntries(): string[] {
  return [
    marketplaceEntry('USE2-MP:USE2_InputTokenCount-Units', 'Claude Sonnet 4.6', 'Input tokens', '3.3000000000'),
    marketplaceEntry('USE2-MP:USE2_OutputTokenCount-Units', 'Claude Sonnet 4.6', 'Output tokens', '16.5000000000'),
    marketplaceEntry('USE2-MP:USE2_CacheReadInputTokenCount-Units', 'Claude Sonnet 4.6', 'Cache read tokens', '0.3300000000'),
    marketplaceEntry('USE2-MP:USE2_CacheWriteInputTokenCount-Units', 'Claude Sonnet 4.6', 'Cache write tokens', '4.1250000000'),
    marketplaceEntry('USE2-MP:USE2_InputTokenCount_Global-Units', 'Claude Sonnet 4.6', 'Input tokens', '3.0000000000'),
    marketplaceEntry('USE2-MP:USE2_OutputTokenCount_Global-Units', 'Claude Sonnet 4.6', 'Output tokens', '15.0000000000'),
    marketplaceEntry('USE2-MP:USE2_CacheWrite1hInputTokenCount-Units', 'Claude Sonnet 4.6', 'Cache write tokens', '6.6000000000'),
    marketplaceEntry('USE2-MP:USE2_InputTokenCount-Units', 'OpenAI GPT-6 Astra', 'Input tokens', '2.5000000000', 'OpenAI'),
    marketplaceEntry('USE2-MP:USE2_OutputTokenCount-Units', 'OpenAI GPT-6 Astra', 'Output tokens', '10.0000000000', 'OpenAI'),
  ];
}

const kimiRegionalRate: BedrockModelTokenRate = {
  modelId: kimiRegional.modelId,
  foundationModelId: kimiRegional.foundationModelId,
  providerName: kimiRegional.providerName,
  inputPerMillionUsd: '3.300000000',
  outputPerMillionUsd: '16.500000000',
  cacheReadPerMillionUsd: '0.330000000',
  cacheWritePerMillionUsd: '4.125000000',
};

const novaRegionalRate: BedrockModelTokenRate = {
  modelId: novaRegional.modelId,
  foundationModelId: novaRegional.foundationModelId,
  providerName: novaRegional.providerName,
  inputPerMillionUsd: '0.330000000',
  outputPerMillionUsd: '2.750000000',
  cacheReadPerMillionUsd: '0.082500000',
  cacheWritePerMillionUsd: '0.000000000',
};

function mockPricingClient(pages: Record<string, PricingPage[]>): { client: PricingClient; send: ReturnType<typeof vi.fn<(command: GetProductsCommand) => Promise<PricingPage>>> } {
  const counters = new Map<string, number>();
  const send = vi.fn((command: GetProductsCommand): Promise<PricingPage> => {
    const serviceCode = command.input.ServiceCode ?? '';
    const index = counters.get(serviceCode) ?? 0;
    counters.set(serviceCode, index + 1);
    const page = pages[serviceCode]?.[index];
    return Promise.resolve(page ?? { PriceList: [] });
  });
  return { client: { send } as unknown as PricingClient, send };
}

describe('Bedrock pricing', () => {
  it('normalizes Kimi K3 regional and global standard token rates and ignores tier noise', () => {
    const catalog = normalizeBedrockPricing({
      refreshedAt: REFRESHED_AT,
      discoveredModels: [kimiRegional, kimiGlobal],
      priceLists: [{ serviceCode: 'AmazonBedrock', entries: kimiEntries() }],
    });

    expect(catalog.unpricedModelIds).toEqual([]);
    expect(catalog.models[kimiRegional.modelId]).toMatchObject({
      inputPerMillionUsd: '3.300000000',
      outputPerMillionUsd: '16.500000000',
      cacheReadPerMillionUsd: '0.330000000',
      cacheWritePerMillionUsd: '4.125000000',
    });
    expect(catalog.models[kimiGlobal.modelId]).toMatchObject({
      inputPerMillionUsd: '3.000000000',
      outputPerMillionUsd: '15.000000000',
      cacheReadPerMillionUsd: '0.300000000',
      cacheWritePerMillionUsd: '3.750000000',
    });
    expect(Object.keys(catalog.models[kimiRegional.modelId]).sort()).toEqual([
      'cacheReadPerMillionUsd',
      'cacheWritePerMillionUsd',
      'foundationModelId',
      'inputPerMillionUsd',
      'modelId',
      'outputPerMillionUsd',
      'providerName',
    ].sort());
    expect(catalog.models[kimiRegional.modelId]).not.toHaveProperty('modelName');
  });

  it('reads the matched token dimension instead of re-finding it by USD string equality', () => {
    const catalog = normalizeBedrockPricing({
      refreshedAt: REFRESHED_AT,
      discoveredModels: [kimiRegional],
      priceLists: [{ serviceCode: 'AmazonBedrock', entries: [
        priceEntry({
          serviceCode: 'AmazonBedrock',
          usagetype: 'USE2-moonshotai.kimi-k3-mantle-input-tokens-standard',
          model: 'Kimi K3',
          inferenceType: 'Input tokens',
          feature: 'On-demand Inference',
          provider: 'Moonshot AI',
          dimensions: [
            { unit: 'requests', usd: '0.0033000000' },
            { unit: '1K tokens', usd: '0.0033000000' },
          ],
        }),
        bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-output-tokens-standard', 'Kimi K3', 'Output tokens', '0.0165000000', 'Moonshot AI'),
      ] }],
    });

    expect(catalog.models[kimiRegional.modelId].inputPerMillionUsd).toBe('3.300000000');
    expect(catalog.models[kimiRegional.modelId].outputPerMillionUsd).toBe('16.500000000');
  });

  it('normalizes Nova 2 Lite regional and global rates through the Amazon alias table', () => {
    const catalog = normalizeBedrockPricing({
      refreshedAt: REFRESHED_AT,
      discoveredModels: [novaRegional, novaGlobal],
      priceLists: [{ serviceCode: 'AmazonBedrock', entries: novaEntries() }],
    });

    expect(catalog.unpricedModelIds).toEqual([]);
    expect(catalog.models[novaRegional.modelId]).toMatchObject({
      inputPerMillionUsd: '0.330000000',
      outputPerMillionUsd: '2.750000000',
      cacheReadPerMillionUsd: '0.082500000',
      cacheWritePerMillionUsd: '0.000000000',
    });
    expect(catalog.models[novaGlobal.modelId]).toMatchObject({
      inputPerMillionUsd: '0.300000000',
      outputPerMillionUsd: '2.500000000',
      cacheReadPerMillionUsd: '0.075000000',
      cacheWritePerMillionUsd: '0.000000000',
    });
  });

  it('strips version suffixes, enforces token-bounded keys, and falls back to a bare key', () => {
    const gptOss = discovered('openai.gpt-oss-120b-1:0', 'openai.gpt-oss-120b-1:0', 'OpenAI', 'gpt-oss-120b');
    const bareModel = discovered('fake.bare-model-1:0', 'fake.bare-model-1:0', 'Fake Vendor', 'Bare Model');
    const catalog = normalizeBedrockPricing({
      refreshedAt: REFRESHED_AT,
      discoveredModels: [gptOss, bareModel],
      priceLists: [{ serviceCode: 'AmazonBedrock', entries: [
        bedrockTokenEntry('USE2-openai.gpt-oss-120b-mantle-input-tokens-standard', 'gpt-oss-120b', 'Input tokens', '0.0001500000', 'OpenAI'),
        bedrockTokenEntry('USE2-openai.gpt-oss-120b-mantle-output-tokens-standard', 'gpt-oss-120b', 'Output tokens', '0.0006000000', 'OpenAI'),
        bedrockTokenEntry('USE2-openai.gpt-oss-120b-safeguard-input-tokens', 'gpt-oss-120b', 'Input tokens', '0.0099000000', 'OpenAI'),
        bedrockTokenEntry('USE2-bare-model-input-tokens', 'Bare Model', 'Input tokens', '0.0002000000', 'Fake Vendor'),
        bedrockTokenEntry('USE2-bare-model-output-tokens', 'Bare Model', 'Output tokens', '0.0008000000', 'Fake Vendor'),
      ] }],
    });

    expect(catalog.unpricedModelIds).toEqual([]);
    expect(catalog.models[gptOss.modelId]).toMatchObject({
      inputPerMillionUsd: '0.150000000',
      outputPerMillionUsd: '0.600000000',
    });
    expect(catalog.models[bareModel.modelId]).toMatchObject({
      inputPerMillionUsd: '0.200000000',
      outputPerMillionUsd: '0.800000000',
    });
  });

  it('normalizes marketplace display-name entries, strips provider prefixes, and skips 1h cache writes', () => {
    const claudeUs = discovered('us.anthropic.claude-sonnet-4-6', 'anthropic.claude-sonnet-4-6', 'Anthropic', 'Claude Sonnet 4.6');
    const claudeGlobal = discovered('global.anthropic.claude-sonnet-4-6', 'anthropic.claude-sonnet-4-6', 'Anthropic', 'Claude Sonnet 4.6');
    const gptAstra = discovered('us.openai.gpt-6-astra', 'openai.gpt-6-astra', 'OpenAI', 'GPT-6 Astra');
    const catalog = normalizeBedrockPricing({
      refreshedAt: REFRESHED_AT,
      discoveredModels: [claudeUs, claudeGlobal, gptAstra],
      priceLists: [{ serviceCode: 'AmazonBedrockFoundationModels', entries: claudeMarketplaceEntries() }],
    });

    expect(catalog.unpricedModelIds).toEqual([]);
    expect(catalog.models[claudeUs.modelId]).toMatchObject({
      inputPerMillionUsd: '3.300000000',
      outputPerMillionUsd: '16.500000000',
      cacheReadPerMillionUsd: '0.330000000',
      cacheWritePerMillionUsd: '4.125000000',
    });
    expect(catalog.models[claudeGlobal.modelId]).toMatchObject({
      inputPerMillionUsd: '3.000000000',
      outputPerMillionUsd: '15.000000000',
      cacheReadPerMillionUsd: null,
      cacheWritePerMillionUsd: null,
    });
    expect(catalog.models[gptAstra.modelId]).toMatchObject({
      inputPerMillionUsd: '2.500000000',
      outputPerMillionUsd: '10.000000000',
    });
  });

  it('leaves display-name-ambiguous marketplace models unpriced', () => {
    const kimiA = discovered('us.moonshotai.kimi-k3', 'moonshotai.kimi-k3', 'Moonshot AI', 'Kimi K3');
    const kimiB = discovered('us.moonshotai.kimi-k3-alt', 'moonshotai.kimi-k3-alt', 'Moonshot AI', 'Kimi K3');
    const catalog = normalizeBedrockPricing({
      refreshedAt: REFRESHED_AT,
      discoveredModels: [kimiA, kimiB],
      priceLists: [{ serviceCode: 'AmazonBedrockFoundationModels', entries: [
        marketplaceEntry('USE2-MP:USE2_InputTokenCount-Units', 'Kimi K3', 'Input tokens', '3.0000000000', 'Moonshot AI'),
        marketplaceEntry('USE2-MP:USE2_OutputTokenCount-Units', 'Kimi K3', 'Output tokens', '15.0000000000', 'Moonshot AI'),
      ] }],
    });

    expect(catalog.unpricedModelIds).toEqual([kimiA.modelId, kimiB.modelId].sort());
    expect(catalog.models[kimiA.modelId]).toBeUndefined();
    expect(catalog.models[kimiB.modelId]).toBeUndefined();
  });

  it('ignores reserved-throughput and guardrail SKUs', () => {
    const reservedModel = discovered('us.anthropic.claude-sonnet-4-5', 'anthropic.claude-sonnet-4-5', 'Anthropic', 'Claude Sonnet 4.5');
    const catalog = normalizeBedrockPricing({
      refreshedAt: REFRESHED_AT,
      discoveredModels: [reservedModel],
      priceLists: [
        { serviceCode: 'AmazonBedrockService', entries: [
          priceEntry({
            serviceCode: 'AmazonBedrockService',
            usagetype: 'USE2-Claude4.5Sonnet-reserved-1-month-input-tokens-per-minute-cross-region-global',
            model: 'Claude Sonnet 4.5',
            inferenceType: 'Input tokens',
            feature: 'Reserved - 1 Month',
            provider: 'Anthropic',
            unit: '1K TPM Hour',
            usd: '0.0000000000',
          }),
        ] },
        { serviceCode: 'AmazonBedrock', entries: [
          priceEntry({
            serviceCode: 'AmazonBedrock',
            usagetype: 'USE2-Guardrail-ContentPolicyUnitsConsumed',
            model: 'Guardrails',
            inferenceType: 'Content Policy Units',
            feature: 'Guardrails',
            provider: 'Amazon',
            unit: 'requests',
            usd: '0.0000000000',
          }),
        ] },
      ],
    });

    expect(catalog.unpricedModelIds).toEqual([reservedModel.modelId]);
    expect(catalog.models[reservedModel.modelId]).toBeUndefined();
  });

  it('keeps CamelCase-only Meta Llama usagetypes unpriced', () => {
    const llama = discovered('us.meta.llama3-1-8b-instruct-v1:0', 'meta.llama3-1-8b-instruct-v1:0', 'Meta', 'Llama 3.1 8B Instruct');
    const catalog = normalizeBedrockPricing({
      refreshedAt: REFRESHED_AT,
      discoveredModels: [llama],
      priceLists: [{ serviceCode: 'AmazonBedrock', entries: [
        bedrockTokenEntry('USE2-Llama3-1-8B-input-tokens', 'Llama 3.1 8B Instruct', 'Input tokens', '0.0002200000', 'Meta'),
      ] }],
    });

    expect(catalog.unpricedModelIds).toEqual([llama.modelId]);
    expect(catalog.models[llama.modelId]).toBeUndefined();
  });

  it('keeps a model unpriced when input matches but output is missing', () => {
    const catalog = normalizeBedrockPricing({
      refreshedAt: REFRESHED_AT,
      discoveredModels: [kimiRegional],
      priceLists: [{ serviceCode: 'AmazonBedrock', entries: [
        bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-input-tokens-standard', 'Kimi K3', 'Input tokens', '0.0033000000', 'Moonshot AI'),
      ] }],
    });

    expect(catalog.unpricedModelIds).toEqual([kimiRegional.modelId]);
    expect(catalog.models[kimiRegional.modelId]).toBeUndefined();
  });

  it('keeps a model unpriced when a dimension publishes conflicting prices', () => {
    const catalog = normalizeBedrockPricing({
      refreshedAt: REFRESHED_AT,
      discoveredModels: [kimiRegional],
      priceLists: [{ serviceCode: 'AmazonBedrock', entries: [
        bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-input-tokens-standard', 'Kimi K3', 'Input tokens', '0.0033000000', 'Moonshot AI'),
        bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-input-tokens-standard', 'Kimi K3', 'Input tokens', '0.0040000000', 'Moonshot AI'),
        bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-output-tokens-standard', 'Kimi K3', 'Output tokens', '0.0165000000', 'Moonshot AI'),
      ] }],
    });

    expect(catalog.unpricedModelIds).toEqual([kimiRegional.modelId]);
    expect(catalog.models[kimiRegional.modelId]).toBeUndefined();
  });

  it('deduplicates identical raw price-list entries', () => {
    const input = bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-input-tokens-standard', 'Kimi K3', 'Input tokens', '0.0033000000', 'Moonshot AI');
    const catalog = normalizeBedrockPricing({
      refreshedAt: REFRESHED_AT,
      discoveredModels: [kimiRegional],
      priceLists: [{ serviceCode: 'AmazonBedrock', entries: [
        input,
        input,
        bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-output-tokens-standard', 'Kimi K3', 'Output tokens', '0.0165000000', 'Moonshot AI'),
      ] }],
    });

    expect(catalog.unpricedModelIds).toEqual([]);
    expect(catalog.models[kimiRegional.modelId]).toMatchObject({
      inputPerMillionUsd: '3.300000000',
      outputPerMillionUsd: '16.500000000',
    });
  });

  it('calculates call costs with exact nanodollar arithmetic and rejects negative usage', () => {
    expect(calculateBedrockCallCostNanos({ inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }, kimiRegionalRate)).toBe(3_300_000_000);
    expect(calculateBedrockCallCostNanos({ inputTokens: 123_456, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }, kimiRegionalRate)).toBe(407_404_800);
    expect(calculateBedrockCallCostNanos({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 999, cacheWriteInputTokens: 0 }, novaRegionalRate)).toBe(82_418);

    const noCacheRate: BedrockModelTokenRate = { ...kimiRegionalRate, cacheReadPerMillionUsd: null, cacheWritePerMillionUsd: null };
    expect(calculateBedrockCallCostNanos({ inputTokens: 1000, outputTokens: 0, cacheReadInputTokens: 999, cacheWriteInputTokens: 999 }, noCacheRate)).toBe(3_300_000);
    expect(() => calculateBedrockCallCostNanos({ inputTokens: -1, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }, kimiRegionalRate)).toThrow(SpendConfigError);
  });

  it('validates catalogs and rejects malformed fields', () => {
    const catalog = normalizeBedrockPricing({
      refreshedAt: REFRESHED_AT,
      discoveredModels: [kimiRegional],
      priceLists: [{ serviceCode: 'AmazonBedrock', entries: kimiEntries() }],
    });
    const roundTripped: unknown = JSON.parse(JSON.stringify(catalog));
    expect(() => validateBedrockPricingCatalog(roundTripped)).not.toThrow();
    expect(() => validateBedrockPricingCatalog(null)).toThrow();
    expect(() => validateBedrockPricingCatalog({ ...catalog, schemaVersion: 2 })).toThrow();
    expect(() => validateBedrockPricingCatalog({ ...catalog, region: 'us-east-1' })).toThrow();
    expect(() => validateBedrockPricingCatalog({ ...catalog, refreshedAt: 'not-a-date' })).toThrow();
    expect(() => validateBedrockPricingCatalog({
      ...catalog,
      models: { [kimiRegional.modelId]: { ...catalog.models[kimiRegional.modelId], inputPerMillionUsd: 'abc' } },
    })).toThrow();
    expect(() => validateBedrockPricingCatalog({ ...catalog, unpricedModelIds: [1] })).toThrow();
    expect(() => validateBedrockPricingCatalog({ ...catalog, models: 'not-an-object' })).toThrow();
  });

  it('paginates all three service codes with bounded requests and normalizes entries across pages', async () => {
    const { client, send } = mockPricingClient({
      AmazonBedrock: [
        { PriceList: [bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-input-tokens-standard', 'Kimi K3', 'Input tokens', '0.0033000000', 'Moonshot AI')], NextToken: 'kimi-page-2' },
        { PriceList: [bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-output-tokens-standard', 'Kimi K3', 'Output tokens', '0.0165000000', 'Moonshot AI')], NextToken: 'kimi-page-3' },
        { PriceList: [bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-cache-read-tokens-standard', 'Kimi K3', 'Cache read tokens', '0.0003300000', 'Moonshot AI')] },
      ],
      AmazonBedrockFoundationModels: [{ PriceList: [] }],
      AmazonBedrockService: [{ PriceList: [] }],
    });

    const catalog = await fetchBedrockPricingCatalog({ discoveredModels: [kimiRegional], pricingClient: client, now: () => 0 });

    expect(send).toHaveBeenCalledTimes(5);
    const calls = send.mock.calls.map(([command]) => command.input);
    for (const input of calls) {
      expect(BEDROCK_PRICING_SERVICE_CODES).toContain(input.ServiceCode);
      expect(input.Filters).toEqual([{ Type: 'TERM_MATCH', Field: 'regionCode', Value: PRICED_REGION }]);
      expect(input.MaxResults).toBe(100);
    }
    expect(calls.map(input => input.NextToken)).toEqual([undefined, 'kimi-page-2', 'kimi-page-3', undefined, undefined]);
    expect(catalog.models[kimiRegional.modelId]).toMatchObject({
      inputPerMillionUsd: '3.300000000',
      outputPerMillionUsd: '16.500000000',
      cacheReadPerMillionUsd: '0.330000000',
      cacheWritePerMillionUsd: null,
    });
  });

  it('fails loudly when a service code exceeds the page cap', async () => {
    const { client, send } = mockPricingClient({
      AmazonBedrock: Array.from({ length: MAX_PRICING_PAGES + 5 }, () => ({ PriceList: [], NextToken: 'endless' })),
    });

    const outcome = await fetchBedrockPricingCatalog({ discoveredModels: [], pricingClient: client, now: () => 0 }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(outcome).toBeInstanceOf(PricingUnavailableError);
    expect((outcome as Error).message).toContain('AmazonBedrock');
    expect(send).toHaveBeenCalledTimes(MAX_PRICING_PAGES);
  });

  it('fails loudly when the fetch exceeds its timeout', async () => {
    let ticks = 0;
    const now = (): number => {
      const value = ticks;
      ticks += 20_000;
      return value;
    };
    const { client, send } = mockPricingClient({
      AmazonBedrock: Array.from({ length: 10 }, () => ({ PriceList: [], NextToken: 'endless' })),
    });

    const outcome = await fetchBedrockPricingCatalog({ discoveredModels: [], pricingClient: client, now }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(outcome).toBeInstanceOf(PricingUnavailableError);
    expect((outcome as Error).message).toMatch(/timeout/i);
    expect(send.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('pins the sanctioned pricing API region and the priced region', () => {
    expect(PRICING_API_REGION).toBe('us-east-1');
    expect(PRICED_REGION).toBe('us-east-2');
  });

  it('resolves via a lower-precedence key when the verbatim key yields only a cache dimension', () => {
    const versionedModel = discovered('us.moonshotai.kimi-k3-1:0', 'moonshotai.kimi-k3-1:0', 'Moonshot AI', 'Kimi K3 1.0');
    const catalog = normalizeBedrockPricing({
      refreshedAt: REFRESHED_AT,
      discoveredModels: [versionedModel],
      priceLists: [{ serviceCode: 'AmazonBedrock', entries: [
        bedrockTokenEntry('USE2-moonshotai.kimi-k3-1:0-mantle-cache-read-tokens-standard', 'Kimi K3 1.0', 'Cache read tokens', '0.0003300000', 'Moonshot AI'),
        bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-input-tokens-standard', 'Kimi K3 1.0', 'Input tokens', '0.0033000000', 'Moonshot AI'),
        bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-output-tokens-standard', 'Kimi K3 1.0', 'Output tokens', '0.0165000000', 'Moonshot AI'),
      ] }],
    });

    expect(catalog.unpricedModelIds).toEqual([]);
    expect(catalog.models[versionedModel.modelId]).toMatchObject({
      inputPerMillionUsd: '3.300000000',
      outputPerMillionUsd: '16.500000000',
      cacheReadPerMillionUsd: null,
    });
  });

  it('keeps a stripped-key-only model unpriced when its only key matches input without output', () => {
    const versionedModel = discovered('us.moonshotai.kimi-k3-1:0', 'moonshotai.kimi-k3-1:0', 'Moonshot AI', 'Kimi K3 1.0');
    const catalog = normalizeBedrockPricing({
      refreshedAt: REFRESHED_AT,
      discoveredModels: [versionedModel],
      priceLists: [{ serviceCode: 'AmazonBedrock', entries: [
        bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-input-tokens-standard', 'Kimi K3 1.0', 'Input tokens', '0.0033000000', 'Moonshot AI'),
      ] }],
    });

    expect(catalog.unpricedModelIds).toEqual([versionedModel.modelId]);
    expect(catalog.models[versionedModel.modelId]).toBeUndefined();
  });

  it('prices a dual-listed model from one service code and ignores cross-service cache dimensions', () => {
    const claudeUs = discovered('us.anthropic.claude-sonnet-4-6', 'anthropic.claude-sonnet-4-6', 'Anthropic', 'Claude Sonnet 4.6');
    const catalog = normalizeBedrockPricing({
      refreshedAt: REFRESHED_AT,
      discoveredModels: [claudeUs],
      priceLists: [
        { serviceCode: 'AmazonBedrock', entries: [
          bedrockTokenEntry('USE2-anthropic.claude-sonnet-4-6-mantle-input-tokens-standard', 'Claude Sonnet 4.6', 'Input tokens', '0.0033000000', 'Anthropic'),
          bedrockTokenEntry('USE2-anthropic.claude-sonnet-4-6-mantle-output-tokens-standard', 'Claude Sonnet 4.6', 'Output tokens', '0.0165000000', 'Anthropic'),
        ] },
        { serviceCode: 'AmazonBedrockFoundationModels', entries: [
          marketplaceEntry('USE2-MP:USE2_CacheReadInputTokenCount-Units', 'Claude Sonnet 4.6', 'Cache read tokens', '0.3300000000'),
        ] },
      ],
    });

    expect(catalog.unpricedModelIds).toEqual([]);
    expect(catalog.models[claudeUs.modelId]).toMatchObject({
      inputPerMillionUsd: '3.300000000',
      outputPerMillionUsd: '16.500000000',
      cacheReadPerMillionUsd: null,
      cacheWritePerMillionUsd: null,
    });
  });

  it('keeps a model unpriced when input and output come from different service codes', () => {
    const catalog = normalizeBedrockPricing({
      refreshedAt: REFRESHED_AT,
      discoveredModels: [kimiRegional],
      priceLists: [{ serviceCode: 'AmazonBedrock', entries: [
        bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-input-tokens-standard', 'Kimi K3', 'Input tokens', '0.0033000000', 'Moonshot AI'),
        priceEntry({
          serviceCode: 'AmazonBedrockService',
          usagetype: 'USE2-moonshotai.kimi-k3-mantle-output-tokens-standard',
          model: 'Kimi K3',
          inferenceType: 'Output tokens',
          feature: 'On-demand Inference',
          provider: 'Moonshot AI',
          unit: '1K tokens',
          usd: '0.0165000000',
        }),
      ] }],
    });

    expect(catalog.unpricedModelIds).toEqual([kimiRegional.modelId]);
    expect(catalog.models[kimiRegional.modelId]).toBeUndefined();
  });

  it('rejects a catalog that lists the same model as both priced and unpriced', () => {
    const catalog = normalizeBedrockPricing({
      refreshedAt: REFRESHED_AT,
      discoveredModels: [kimiRegional],
      priceLists: [{ serviceCode: 'AmazonBedrock', entries: kimiEntries() }],
    });

    expect(() => validateBedrockPricingCatalog({ ...catalog, unpricedModelIds: [kimiRegional.modelId] })).toThrow();
  });

  it('wraps unexpected pricing client failures in PricingUnavailableError', async () => {
    const send = vi.fn((): Promise<never> => Promise.reject(new Error('boom')));
    const client = { send } as unknown as PricingClient;

    const outcome = await fetchBedrockPricingCatalog({ discoveredModels: [], pricingClient: client, now: () => 0 }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(outcome).toBeInstanceOf(PricingUnavailableError);
    expect((outcome as Error).message).toContain('boom');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('skips malformed raw price-list entries without failing the catalog build', async () => {
    const { client } = mockPricingClient({
      AmazonBedrock: [{ PriceList: [
        bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-input-tokens-standard', 'Kimi K3', 'Input tokens', '0.0033000000', 'Moonshot AI'),
        '{"product":',
        bedrockTokenEntry('USE2-moonshotai.kimi-k3-mantle-output-tokens-standard', 'Kimi K3', 'Output tokens', '0.0165000000', 'Moonshot AI'),
      ] }],
      AmazonBedrockFoundationModels: [{ PriceList: [] }],
      AmazonBedrockService: [{ PriceList: [] }],
    });

    const catalog = await fetchBedrockPricingCatalog({ discoveredModels: [kimiRegional], pricingClient: client, now: () => 0 });

    expect(catalog.unpricedModelIds).toEqual([]);
    expect(catalog.models[kimiRegional.modelId]).toMatchObject({
      inputPerMillionUsd: '3.300000000',
      outputPerMillionUsd: '16.500000000',
      cacheReadPerMillionUsd: null,
    });
  });
});
