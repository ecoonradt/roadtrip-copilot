import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BedrockClient } from '@aws-sdk/client-bedrock';
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { PricingClient } from '@aws-sdk/client-pricing';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  PRICED_REGION,
  PricingUnavailableError,
  calculateBedrockCallCostNanos,
  type BedrockModelTokenRate,
  type BedrockPricingCatalog,
} from '../../server/services/bedrockPricing.js';
import {
  BedrockPricingCache,
  PRICING_CACHE_MEMORY_TTL_MS,
  PRICING_CACHE_S3_KEY,
  PRICING_CATALOG_STALE_MS,
} from '../../server/services/bedrockPricingCache.js';
import {
  discoverBedrockModelsForPricing,
  handler as refreshPricingLambdaHandler,
  refreshBedrockPricing,
} from '../../server/handlers/refreshBedrockPricing.js';
import {
  S3ItineraryStorageService,
  sanitizeEmailForObjectKey,
} from '../../server/services/itineraryStorageService.js';
import { AiService, InvalidModelError } from '../../server/services/aiService.js';
import {
  AwsBedrockHarnessAdapter,
  DEFAULT_BEDROCK_COPYWRITER_MODEL_ID,
  DEFAULT_BEDROCK_SCOUT_MODEL_ID,
} from '../../server/services/bedrockService.js';
import { ScoutService } from '../../server/services/scoutService.js';
import { aiRoutes } from '../../server/routes/ai.js';
import { scoutRoutes } from '../../server/routes/scout.js';
import { MalformedAiResponseError } from '../../server/services/schemaParser.js';
import type { AiUsageEvent } from '../../server/types/spend.js';
import { fetchAiStatus } from '../../src/services/api.js';

const REFRESHED_AT = '2026-11-02T00:00:00.000Z';
const REFRESHED_MS = Date.parse(REFRESHED_AT);

const kimiRate: BedrockModelTokenRate = {
  modelId: DEFAULT_BEDROCK_SCOUT_MODEL_ID,
  foundationModelId: 'moonshotai.kimi-k3',
  providerName: 'Moonshot AI',
  inputPerMillionUsd: '3.300000000',
  outputPerMillionUsd: '16.500000000',
  cacheReadPerMillionUsd: '0.330000000',
  cacheWritePerMillionUsd: '4.125000000',
};

const novaRate: BedrockModelTokenRate = {
  modelId: DEFAULT_BEDROCK_COPYWRITER_MODEL_ID,
  foundationModelId: 'amazon.nova-2-lite-v1:0',
  providerName: 'Amazon',
  inputPerMillionUsd: '0.330000000',
  outputPerMillionUsd: '2.750000000',
  cacheReadPerMillionUsd: '0.082500000',
  cacheWritePerMillionUsd: '0.000000000',
};

function makeCatalog(overrides?: Partial<BedrockPricingCatalog>): BedrockPricingCatalog {
  return {
    schemaVersion: 1,
    region: PRICED_REGION,
    refreshedAt: REFRESHED_AT,
    models: {
      [DEFAULT_BEDROCK_SCOUT_MODEL_ID]: kimiRate,
      [DEFAULT_BEDROCK_COPYWRITER_MODEL_ID]: novaRate,
    },
    unpricedModelIds: [],
    ...overrides,
  };
}

function makePriceEntry(params: {
  serviceCode: string;
  usagetype: string;
  model: string;
  inferenceType: string;
  unit: string;
  usd: string;
  provider: string;
}): string {
  const sku = `${params.usagetype}-${params.usd}`.replace(/\s+/g, '_');
  return JSON.stringify({
    product: {
      productFamily: 'Amazon Bedrock',
      attributes: {
        regionCode: PRICED_REGION,
        inferenceType: params.inferenceType,
        servicecode: params.serviceCode,
        provider: params.provider,
        usagetype: params.usagetype,
        locationType: 'AWS Region',
        location: 'US East (Ohio)',
        model: params.model,
        servicename: 'Amazon Bedrock',
        feature: 'On-demand Inference',
      },
      sku,
    },
    serviceCode: params.serviceCode,
    terms: {
      OnDemand: {
        [`${sku}.TERM`]: {
          priceDimensions: {
            [`${sku}.TERM.DIM`]: {
              unit: params.unit,
              endRange: 'Inf',
              description: `${params.usagetype} ${params.unit}`,
              beginRange: '0',
              pricePerUnit: { USD: params.usd },
            },
          },
        },
      },
    },
  });
}

function makeDefaultPricingClientMock(): PricingClient {
  const amazonBedrockEntries = [
    makePriceEntry({
      serviceCode: 'AmazonBedrock',
      usagetype: 'USE2-moonshotai.kimi-k3-mantle-input-tokens-standard',
      model: 'Kimi K3',
      inferenceType: 'Input tokens',
      unit: '1K tokens',
      usd: '0.0033000000',
      provider: 'Moonshot AI',
    }),
    makePriceEntry({
      serviceCode: 'AmazonBedrock',
      usagetype: 'USE2-moonshotai.kimi-k3-mantle-output-tokens-standard',
      model: 'Kimi K3',
      inferenceType: 'Output tokens',
      unit: '1K tokens',
      usd: '0.0165000000',
      provider: 'Moonshot AI',
    }),
    makePriceEntry({
      serviceCode: 'AmazonBedrock',
      usagetype: 'USE2-moonshotai.kimi-k3-mantle-cache-read-tokens-standard',
      model: 'Kimi K3',
      inferenceType: 'Cache read tokens',
      unit: '1K tokens',
      usd: '0.0003300000',
      provider: 'Moonshot AI',
    }),
    makePriceEntry({
      serviceCode: 'AmazonBedrock',
      usagetype: 'USE2-moonshotai.kimi-k3-mantle-cache-write-tokens-30m-standard',
      model: 'Kimi K3',
      inferenceType: 'Cache write tokens',
      unit: '1K tokens',
      usd: '0.0041250000',
      provider: 'Moonshot AI',
    }),
    makePriceEntry({
      serviceCode: 'AmazonBedrock',
      usagetype: 'USE2-Nova2.0Lite-input-tokens',
      model: 'Nova 2 Lite',
      inferenceType: 'Input tokens',
      unit: '1K tokens',
      usd: '0.0003300000',
      provider: 'Amazon',
    }),
    makePriceEntry({
      serviceCode: 'AmazonBedrock',
      usagetype: 'USE2-Nova2.0Lite-output-tokens',
      model: 'Nova 2 Lite',
      inferenceType: 'Output tokens',
      unit: '1K tokens',
      usd: '0.0027500000',
      provider: 'Amazon',
    }),
    makePriceEntry({
      serviceCode: 'AmazonBedrock',
      usagetype: 'USE2-Nova2.0Lite-cache-read-input-token-count',
      model: 'Nova 2 Lite',
      inferenceType: 'Cache read tokens',
      unit: '1K tokens',
      usd: '0.0000825000',
      provider: 'Amazon',
    }),
    makePriceEntry({
      serviceCode: 'AmazonBedrock',
      usagetype: 'USE2-Nova2.0Lite-cache-write-input-token-count',
      model: 'Nova 2 Lite',
      inferenceType: 'Cache write tokens',
      unit: '1K tokens',
      usd: '0.0000000000',
      provider: 'Amazon',
    }),
  ];

  const marketplaceEntries = [
    makePriceEntry({
      serviceCode: 'AmazonBedrockFoundationModels',
      usagetype: 'USE2-MP:USE2_InputTokenCount-Units',
      model: 'Claude Sonnet 4.6',
      inferenceType: 'Input tokens',
      unit: '1M tokens',
      usd: '3.3000000000',
      provider: 'Anthropic',
    }),
    makePriceEntry({
      serviceCode: 'AmazonBedrockFoundationModels',
      usagetype: 'USE2-MP:USE2_OutputTokenCount-Units',
      model: 'Claude Sonnet 4.6',
      inferenceType: 'Output tokens',
      unit: '1M tokens',
      usd: '16.5000000000',
      provider: 'Anthropic',
    }),
  ];

  const send = vi.fn(async (command: { input?: { ServiceCode?: string } }) => {
    const sc = command.input?.ServiceCode;
    if (sc === 'AmazonBedrock') {
      return { PriceList: amazonBedrockEntries };
    }
    if (sc === 'AmazonBedrockFoundationModels') {
      return { PriceList: marketplaceEntries };
    }
    return { PriceList: [] };
  });

  return { send } as unknown as PricingClient;
}

describe('Step 2: BedrockPricingCache, sanitizeEmailForObjectKey, Refresh Handler & Adapter Integration', () => {
  describe('1. sanitizeEmailForObjectKey & S3ItineraryStorageService prefix agreement', () => {
    it('normalizes mixed-case, preserves safe ASCII characters, and percent-encodes unsafe/non-ASCII bytes', () => {
      expect(sanitizeEmailForObjectKey('Driver.One+Tag_2-a@Example.COM')).toBe(
        'driver.one+tag_2-a@example.com',
      );
      expect(sanitizeEmailForObjectKey('  ')).toBe('local-dev@localhost');
      expect(sanitizeEmailForObjectKey(undefined)).toBe('local-dev@localhost');
      expect(sanitizeEmailForObjectKey('user/with spaces@example.com')).toBe(
        'user%2Fwith%20spaces@example.com',
      );
      expect(sanitizeEmailForObjectKey('é@example.com')).toBe('%E9@example.com');
    });

    it('matches S3ItineraryStorageService object key prefixes across mixed-case, +, and non-ASCII emails', async () => {
      const capturedPrefixes: string[] = [];
      const mockS3 = {
        send: vi.fn(async (cmd: { input?: { Prefix?: string } }) => {
          if (cmd.input?.Prefix) {
            capturedPrefixes.push(cmd.input.Prefix);
          }
          return { Contents: [] };
        }),
      } as unknown as S3Client;

      const s3Storage = new S3ItineraryStorageService({
        bucketName: 'test-bucket',
        s3Client: mockS3,
      });

      const testEmails = [
        'Eric.Coonradt+Roadtrip@Gmail.com',
        'driver_é+test@sub.example.org',
        'bad/../path@example.com',
      ];

      for (const email of testEmails) {
        capturedPrefixes.length = 0;
        await s3Storage.listItineraries(email);
        const safeEmail = sanitizeEmailForObjectKey(email);
        expect(capturedPrefixes[0]).toBe(`users/${safeEmail}/itineraries/`);
      }
    });
  });

  describe('2. BedrockPricingCache (Local & S3 persistence, TTL, staleness & reload fallback)', () => {
    let tempDir = '';

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bedrock-pricing-cache-'));
    });

    afterEach(async () => {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('writes and reads a local pricing catalog with 5-minute in-memory TTL and coalesced concurrent reads', async () => {
      const localFilePath = path.join(tempDir, 'pricing', 'bedrock-us-east-2.json');
      let currentNow = REFRESHED_MS + 60_000;
      const warnSpy = vi.fn();

      const writerCache = new BedrockPricingCache({
        s3Bucket: '',
        localFilePath,
        now: () => currentNow,
        logger: { warn: warnSpy },
      });

      const catalog = makeCatalog();
      const writeRes = await writerCache.writeCatalog(catalog);
      expect(writeRes.storageLocation).toBe(localFilePath);

      const readerCache = new BedrockPricingCache({
        s3Bucket: '',
        localFilePath,
        now: () => currentNow,
        logger: { warn: warnSpy },
      });

      const [r1, r2] = await Promise.all([readerCache.getCatalog(), readerCache.getCatalog()]);
      expect(r1.isStale).toBe(false);
      expect(r2.isStale).toBe(false);
      expect(r1.catalog).toEqual(catalog);

      // Delete the file on disk and advance within 5-minute TTL -> served from memory without touching disk
      await fs.rm(localFilePath, { force: true });
      currentNow += PRICING_CACHE_MEMORY_TTL_MS - 1_000;
      const r3 = await readerCache.getCatalog();
      expect(r3.isStale).toBe(false);
      expect(r3.catalog).toEqual(catalog);
      expect(warnSpy).not.toHaveBeenCalled();

      // Also verify S3 concurrent read coalescing invokes S3Client.send only once
      const s3Send = vi.fn(async () => ({
        Body: {
          transformToString: async () => JSON.stringify(catalog),
        },
      }));
      const coalescedS3Cache = new BedrockPricingCache({
        s3Bucket: 'coalesce-bucket',
        s3Client: { send: s3Send } as unknown as S3Client,
        now: () => currentNow,
      });
      await Promise.all([coalescedS3Cache.getCatalog(), coalescedS3Cache.getCatalog()]);
      expect(s3Send).toHaveBeenCalledTimes(1);
    });

    it('marks catalog as stale and logs a warning when refreshedAt is older than 7 days', async () => {
      const localFilePath = path.join(tempDir, 'bedrock-us-east-2.json');
      const staleNow = REFRESHED_MS + PRICING_CATALOG_STALE_MS + 1;
      const warnSpy = vi.fn();

      const cache = new BedrockPricingCache({
        s3Bucket: '',
        localFilePath,
        now: () => staleNow,
        logger: { warn: warnSpy },
      });

      await fs.writeFile(localFilePath, JSON.stringify(makeCatalog()), 'utf-8');
      const res = await cache.getCatalog();
      expect(res.isStale).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain('is stale');
    });

    it('retains the last valid in-memory catalog as stale when a subsequent reload from S3 fails', async () => {
      let currentNow = REFRESHED_MS + 1_000;
      let shouldFailS3 = false;
      const warnSpy = vi.fn();
      const catalog = makeCatalog();

      const mockS3 = {
        send: vi.fn(async () => {
          if (shouldFailS3) {
            throw new Error('S3 network timeout');
          }
          return {
            Body: {
              transformToString: async () => JSON.stringify(catalog),
            },
          };
        }),
      } as unknown as S3Client;

      const cache = new BedrockPricingCache({
        s3Bucket: 'roadtrip-app-data',
        s3Client: mockS3,
        now: () => currentNow,
        logger: { warn: warnSpy },
      });

      const initial = await cache.getCatalog();
      expect(initial.isStale).toBe(false);
      expect(initial.catalog).toEqual(catalog);

      // Expire the 5-minute memory TTL and make S3 fail on reload
      currentNow += PRICING_CACHE_MEMORY_TTL_MS + 1_000;
      shouldFailS3 = true;

      const fallback = await cache.getCatalog();
      expect(fallback.isStale).toBe(true);
      expect(fallback.catalog).toEqual(catalog);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain('retaining last valid cached catalog as stale');
    });

    it('writes and reads from S3 when s3Bucket is configured, and fails with 503 PricingUnavailableError when missing or corrupt', async () => {
      const storedObjects = new Map<string, string>();
      const mockS3 = {
        send: vi.fn(async (cmd: { constructor: { name: string }; input: { Bucket: string; Key: string; Body?: string } }) => {
          if (cmd.constructor.name === 'PutObjectCommand') {
            storedObjects.set(`${cmd.input.Bucket}/${cmd.input.Key}`, cmd.input.Body ?? '');
            return {};
          }
          const body = storedObjects.get(`${cmd.input.Bucket}/${cmd.input.Key}`);
          if (body === undefined) {
            const notFound = new Error('NoSuchKey') as Error & { name: string };
            notFound.name = 'NoSuchKey';
            throw notFound;
          }
          return {
            Body: {
              transformToString: async () => body,
            },
          };
        }),
      } as unknown as S3Client;

      const missingCache = new BedrockPricingCache({
        s3Bucket: 'roadtrip-app-data',
        s3Client: mockS3,
        now: () => REFRESHED_MS + 1_000,
      });

      await expect(missingCache.getCatalog()).rejects.toMatchObject({
        name: 'PricingUnavailableError',
        statusCode: 503,
      });

      const catalog = makeCatalog();
      const writeResult = await missingCache.writeCatalog(catalog);
      expect(writeResult.storageLocation).toBe(`s3://roadtrip-app-data/${PRICING_CACHE_S3_KEY}`);

      const freshReader = new BedrockPricingCache({
        s3Bucket: 'roadtrip-app-data',
        s3Client: mockS3,
        now: () => REFRESHED_MS + 2_000,
      });
      const readResult = await freshReader.getCatalog();
      expect(readResult.catalog).toEqual(catalog);
      expect(readResult.isStale).toBe(false);

      // Corrupt JSON in S3 with no prior in-memory catalog -> 503 PricingUnavailableError
      storedObjects.set(`roadtrip-app-data/${PRICING_CACHE_S3_KEY}`, '{not-json');
      const corruptReader = new BedrockPricingCache({
        s3Bucket: 'roadtrip-app-data',
        s3Client: mockS3,
      });
      await expect(corruptReader.getCatalog()).rejects.toThrow(PricingUnavailableError);
    });
  });

  describe('3. Weekly Refresh Handler & Bedrock Model Discovery (refreshBedrockPricing.ts)', () => {
    let tempDir = '';

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bedrock-refresh-handler-'));
    });

    afterEach(async () => {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('discovers active system profiles and direct ON_DEMAND text models, resolves prices, and writes the catalog', async () => {
      const mockBedrockClient = {
        send: vi.fn(async (cmd: { constructor: { name: string } }) => {
          if (cmd.constructor.name === 'ListInferenceProfilesCommand') {
            return {
              inferenceProfileSummaries: [
                {
                  inferenceProfileId: DEFAULT_BEDROCK_SCOUT_MODEL_ID,
                  inferenceProfileName: 'US Kimi K3',
                  status: 'ACTIVE',
                  type: 'SYSTEM_DEFINED',
                  models: [
                    {
                      modelArn: 'arn:aws:bedrock:us-east-2::foundation-model/moonshotai.kimi-k3',
                    },
                  ],
                },
                {
                  inferenceProfileId: DEFAULT_BEDROCK_COPYWRITER_MODEL_ID,
                  inferenceProfileName: 'US Nova 2 Lite',
                  status: 'ACTIVE',
                  type: 'SYSTEM_DEFINED',
                  models: [
                    {
                      modelArn: 'arn:aws:bedrock:us-east-2::foundation-model/amazon.nova-2-lite-v1:0',
                    },
                  ],
                },
                {
                  inferenceProfileId: 'us.anthropic.claude-sonnet-4-6',
                  inferenceProfileName: 'US Claude Sonnet 4.6',
                  status: 'ACTIVE',
                  type: 'SYSTEM_DEFINED',
                  models: [
                    {
                      modelArn: 'arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-sonnet-4-6',
                    },
                  ],
                },
              ],
            };
          }
          if (cmd.constructor.name === 'ListFoundationModelsCommand') {
            return {
              modelSummaries: [
                {
                  modelId: 'moonshotai.kimi-k3',
                  modelName: 'Kimi K3',
                  providerName: 'Moonshot AI',
                  inputModalities: ['TEXT'],
                  outputModalities: ['TEXT'],
                  modelLifecycle: { status: 'ACTIVE' },
                },
                {
                  modelId: 'amazon.nova-2-lite-v1:0',
                  modelName: 'Nova 2 Lite',
                  providerName: 'Amazon',
                  inputModalities: ['TEXT'],
                  outputModalities: ['TEXT'],
                  modelLifecycle: { status: 'ACTIVE' },
                },
                {
                  modelId: 'anthropic.claude-sonnet-4-6',
                  modelName: 'Claude Sonnet 4.6',
                  providerName: 'Anthropic',
                  inputModalities: ['TEXT'],
                  outputModalities: ['TEXT'],
                  modelLifecycle: { status: 'ACTIVE' },
                },
                {
                  modelId: 'mystery.unpriced-v1:0',
                  modelName: 'Mystery Unpriced Model',
                  providerName: 'Mystery',
                  inputModalities: ['TEXT'],
                  outputModalities: ['TEXT'],
                  inferenceTypesSupported: ['ON_DEMAND'],
                  modelLifecycle: { status: 'ACTIVE' },
                },
                {
                  modelId: 'legacy.ignored-v1:0',
                  modelName: 'Legacy Ignored',
                  providerName: 'Legacy',
                  inputModalities: ['TEXT'],
                  outputModalities: ['TEXT'],
                  inferenceTypesSupported: ['ON_DEMAND'],
                  modelLifecycle: { status: 'LEGACY' },
                },
              ],
            };
          }
          throw new Error(`Unexpected command: ${cmd.constructor.name}`);
        }),
      } as unknown as BedrockClient;

      const discovered = await discoverBedrockModelsForPricing({
        bedrockClient: mockBedrockClient,
        region: 'us-east-2',
      });
      expect(discovered.map((d) => d.modelId)).toEqual([
        DEFAULT_BEDROCK_SCOUT_MODEL_ID,
        DEFAULT_BEDROCK_COPYWRITER_MODEL_ID,
        'us.anthropic.claude-sonnet-4-6',
        'mystery.unpriced-v1:0',
      ]);

      const localFilePath = path.join(tempDir, 'bedrock-us-east-2.json');
      const result = await refreshBedrockPricing({
        bedrockClient: mockBedrockClient,
        pricingClient: makeDefaultPricingClientMock(),
        localFilePath,
        s3Bucket: '',
        now: () => REFRESHED_MS,
      });

      expect(result.pricedModelCount).toBe(3);
      expect(result.unpricedModelCount).toBe(1);
      expect(result.catalog.models[DEFAULT_BEDROCK_SCOUT_MODEL_ID]).toEqual(kimiRate);
      expect(result.catalog.models[DEFAULT_BEDROCK_COPYWRITER_MODEL_ID]).toEqual(novaRate);
      expect(result.catalog.unpricedModelIds).toEqual(['mystery.unpriced-v1:0']);

      const persisted = JSON.parse(await fs.readFile(localFilePath, 'utf-8')) as BedrockPricingCatalog;
      expect(persisted).toEqual(result.catalog);
      expect(typeof refreshPricingLambdaHandler).toBe('function');
    });

    it('refuses to overwrite the pricing catalog when a configured default model fails to resolve a price', async () => {
      const localFilePath = path.join(tempDir, 'bedrock-us-east-2.json');
      // PricingClient that only prices Claude Sonnet 4.6 and omits Kimi K3 & Nova 2 Lite
      const partialPricingClient = {
        send: vi.fn(async (cmd: { input?: { ServiceCode?: string } }) => {
          if (cmd.input?.ServiceCode === 'AmazonBedrock') {
            return {
              PriceList: [
                makePriceEntry({
                  serviceCode: 'AmazonBedrock',
                  usagetype: 'USE2-Nova2.0Lite-input-tokens',
                  model: 'Nova 2 Lite',
                  inferenceType: 'Input tokens',
                  unit: '1K tokens',
                  usd: '0.0003300000',
                  provider: 'Amazon',
                }),
                makePriceEntry({
                  serviceCode: 'AmazonBedrock',
                  usagetype: 'USE2-Nova2.0Lite-output-tokens',
                  model: 'Nova 2 Lite',
                  inferenceType: 'Output tokens',
                  unit: '1K tokens',
                  usd: '0.0027500000',
                  provider: 'Amazon',
                }),
              ],
            };
          }
          if (cmd.input?.ServiceCode === 'AmazonBedrockFoundationModels') {
            return {
              PriceList: [
                makePriceEntry({
                  serviceCode: 'AmazonBedrockFoundationModels',
                  usagetype: 'USE2-MP:USE2_InputTokenCount-Units',
                  model: 'Claude Sonnet 4.6',
                  inferenceType: 'Input tokens',
                  unit: '1M tokens',
                  usd: '3.3000000000',
                  provider: 'Anthropic',
                }),
              ],
            };
          }
          return { PriceList: [] };
        }),
      } as unknown as PricingClient;

      await expect(
        refreshBedrockPricing({
          discoveredModels: [
            {
              modelId: DEFAULT_BEDROCK_SCOUT_MODEL_ID,
              foundationModelId: 'moonshotai.kimi-k3',
              providerName: 'Moonshot AI',
              modelName: 'Kimi K3',
            },
            {
              modelId: DEFAULT_BEDROCK_COPYWRITER_MODEL_ID,
              foundationModelId: 'amazon.nova-2-lite-v1:0',
              providerName: 'Amazon',
              modelName: 'Nova 2 Lite',
            },
          ],
          pricingClient: partialPricingClient,
          localFilePath,
          s3Bucket: '',
          now: () => REFRESHED_MS,
        }),
      ).rejects.toThrow(
        `Refusing to overwrite pricing catalog: configured default model "${DEFAULT_BEDROCK_SCOUT_MODEL_ID}" did not resolve a price`,
      );
    });
  });

  describe('4. AwsBedrockHarnessAdapter, AiService & Fastify Routes Pricing Integration', () => {
    const seededModels = [
      {
        id: DEFAULT_BEDROCK_SCOUT_MODEL_ID,
        name: 'Kimi K3',
        provider: 'Moonshot AI',
        description: 'Moonshot AI Kimi K3',
        role: 'both' as const,
      },
      {
        id: DEFAULT_BEDROCK_COPYWRITER_MODEL_ID,
        name: 'Nova 2 Lite',
        provider: 'Amazon',
        description: 'Amazon Nova 2 Lite',
        role: 'both' as const,
      },
      {
        id: 'us.anthropic.claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        provider: 'Anthropic',
        description: 'Anthropic Claude Sonnet 4.6',
        role: 'both' as const,
      },
    ];

    it('keeps both configured default models selectable when priced and excludes unpriced models from getAvailableModels()', async () => {
      const adapter = new AwsBedrockHarnessAdapter({
        client: { send: vi.fn() } as unknown as BedrockRuntimeClient,
        availableModels: seededModels,
        pricingCatalog: makeCatalog({
          unpricedModelIds: ['us.anthropic.claude-sonnet-4-6'],
        }),
      });

      const available = await adapter.getAvailableModels();
      expect(available.map((m) => m.id)).toEqual([
        DEFAULT_BEDROCK_SCOUT_MODEL_ID,
        DEFAULT_BEDROCK_COPYWRITER_MODEL_ID,
      ]);

      await expect(adapter.validateModelId(DEFAULT_BEDROCK_SCOUT_MODEL_ID, 'scout')).resolves.toBe(
        DEFAULT_BEDROCK_SCOUT_MODEL_ID,
      );
      await expect(
        adapter.validateModelId(DEFAULT_BEDROCK_COPYWRITER_MODEL_ID, 'copywriter'),
      ).resolves.toBe(DEFAULT_BEDROCK_COPYWRITER_MODEL_ID);

      // Valid in Bedrock discovery but missing from pricing catalog -> 503 PricingUnavailableError
      await expect(
        adapter.validateModelId('us.anthropic.claude-sonnet-4-6', 'scout'),
      ).rejects.toMatchObject({
        name: 'PricingUnavailableError',
        statusCode: 503,
      });
      await expect(
        adapter.validateModelId('anthropic.claude-sonnet-4-6', 'scout'),
      ).rejects.toMatchObject({
        name: 'PricingUnavailableError',
        statusCode: 503,
      });

      // Completely unknown model -> 400 InvalidModelError
      await expect(adapter.validateModelId('unknown.model-v1', 'scout')).rejects.toBeInstanceOf(
        InvalidModelError,
      );
    });

    it('returns HTTP 503 on GET /api/ai/status and AI/Scout endpoints when pricing cache is missing or default model is unpriced, and HTTP 400 on unknown models', async () => {
      const failingPricingCache = {
        getCatalog: vi.fn(async () => {
          throw new PricingUnavailableError('Bedrock pricing catalog not found in S3');
        }),
      };

      const unavailableAdapter = new AwsBedrockHarnessAdapter({
        client: { send: vi.fn() } as unknown as BedrockRuntimeClient,
        availableModels: seededModels,
        pricingCache: failingPricingCache,
      });
      const unavailableAiService = new AiService({ adapters: [unavailableAdapter] });
      const unavailableScoutService = new ScoutService({ aiService: unavailableAiService });

      const app = Fastify();
      await app.register(aiRoutes, { aiService: unavailableAiService });
      await app.register(scoutRoutes, { scoutService: unavailableScoutService });

      const statusRes = await app.inject({ method: 'GET', url: '/api/ai/status' });
      expect(statusRes.statusCode).toBe(503);
      expect(statusRes.json()).toMatchObject({
        available: false,
        engine: 'bedrock',
        providerName: 'Amazon Bedrock',
      });
      expect(statusRes.json().message).toContain('Bedrock pricing catalog not found in S3');

      // Verify fetchAiStatus client helper preserves 503 JSON message
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () =>
        new Response(statusRes.payload, {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      try {
        const clientStatus = await fetchAiStatus();
        expect(clientStatus.available).toBe(false);
        expect(clientStatus.engine).toBe('bedrock');
        expect(clientStatus.message).toContain('Bedrock pricing catalog not found in S3');
      } finally {
        globalThis.fetch = originalFetch;
      }

      const genRes = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: { waypoint: { id: 'wp1', name: 'Vista Point' } },
      });
      expect(genRes.statusCode).toBe(503);

      const titleRes = await app.inject({
        method: 'POST',
        url: '/api/copilot/day-title',
        payload: { dayNumber: 1, stops: [{ name: 'Sedona' }] },
      });
      expect(titleRes.statusCode).toBe(503);

      const scoutChatRes = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat',
        payload: {
          scope: { type: 'day', dayNumber: 1 },
          messages: [{ role: 'user', content: 'Audit stops' }],
          tripContext: { tripName: 'Test Trip', waypoints: [] },
        },
      });
      expect(scoutChatRes.statusCode).toBe(503);

      const scoutStreamRes = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat/stream',
        payload: {
          scope: { type: 'day', dayNumber: 1 },
          messages: [{ role: 'user', content: 'Audit stops' }],
          tripContext: { tripName: 'Test Trip', waypoints: [] },
        },
      });
      expect(scoutStreamRes.statusCode).toBe(503);

      await app.close();

      // Now test when defaults ARE priced, unpriced model returns 503, unknown model returns 400
      const partialAdapter = new AwsBedrockHarnessAdapter({
        client: { send: vi.fn() } as unknown as BedrockRuntimeClient,
        availableModels: seededModels,
        pricingCatalog: makeCatalog({
          unpricedModelIds: ['us.anthropic.claude-sonnet-4-6'],
        }),
      });
      const partialAiService = new AiService({ adapters: [partialAdapter] });
      const partialScoutService = new ScoutService({ aiService: partialAiService });

      const app2 = Fastify();
      await app2.register(aiRoutes, { aiService: partialAiService });
      await app2.register(scoutRoutes, { scoutService: partialScoutService });

      const okStatus = await app2.inject({ method: 'GET', url: '/api/ai/status' });
      expect(okStatus.statusCode).toBe(200);
      expect(okStatus.json().available).toBe(true);
      expect(okStatus.json().models).toHaveLength(2);

      const unpricedGen = await app2.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoint: { id: 'wp1', name: 'Vista Point' },
          modelId: 'us.anthropic.claude-sonnet-4-6',
        },
      });
      expect(unpricedGen.statusCode).toBe(503);
      expect(unpricedGen.json().error).toContain('us.anthropic.claude-sonnet-4-6');

      const unknownGen = await app2.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoint: { id: 'wp1', name: 'Vista Point' },
          modelId: 'nonexistent.model-v1',
        },
      });
      expect(unknownGen.statusCode).toBe(400);

      await app2.close();

      // Also test when default Scout model is missing from catalog while Copywriter is priced -> GET /api/ai/status returns 503
      const missingDefaultScoutAdapter = new AwsBedrockHarnessAdapter({
        client: { send: vi.fn() } as unknown as BedrockRuntimeClient,
        availableModels: seededModels,
        pricingCatalog: makeCatalog({
          models: {
            [DEFAULT_BEDROCK_COPYWRITER_MODEL_ID]: novaRate,
          },
          unpricedModelIds: [DEFAULT_BEDROCK_SCOUT_MODEL_ID],
        }),
      });
      const missingDefaultService = new AiService({ adapters: [missingDefaultScoutAdapter] });
      const statusWithMissingDefault = await missingDefaultService.getStatus();
      expect(statusWithMissingDefault.available).toBe(false);
      expect(statusWithMissingDefault.statusCode).toBe(503);
      expect(statusWithMissingDefault.message).toContain(DEFAULT_BEDROCK_SCOUT_MODEL_ID);
    });

    it('emits accurate AiUsageEvent records in generate() before stopReason checks and emits usageComplete: false on dispatch failure', async () => {
      const events: AiUsageEvent[] = [];
      let mockBehavior: 'success' | 'max_tokens' | 'network_error' = 'success';

      const mockRuntimeClient = {
        send: vi.fn(async () => {
          if (mockBehavior === 'network_error') {
            throw new Error('Bedrock runtime socket reset');
          }
          if (mockBehavior === 'max_tokens') {
            return {
              stopReason: 'max_tokens',
              usage: {
                inputTokens: 1_000,
                outputTokens: 500,
                cacheReadInputTokens: 200,
                cacheWriteInputTokens: 100,
              },
              output: { message: { content: [{ text: '{"title":"Truncated"' }] } },
            };
          }
          return {
            stopReason: 'end_turn',
            usage: {
              inputTokens: 2_000,
              outputTokens: 400,
              cacheReadInputTokens: 1_000,
              cacheWriteInputTokens: 0,
            },
            output: {
              message: {
                content: [
                  {
                    text: JSON.stringify({
                      title: 'Scenic Overlook',
                      message: 'Pull off ahead in 1 mile.',
                      speech: 'Approaching Scenic Overlook ahead in about one mile.',
                      recommended_trigger_radius_miles: 1.5,
                    }),
                  },
                ],
              },
            },
          };
        }),
      } as unknown as BedrockRuntimeClient;

      const adapter = new AwsBedrockHarnessAdapter({
        client: mockRuntimeClient,
        availableModels: seededModels,
        pricingCache: {
          getCatalog: async () => ({ catalog: makeCatalog(), isStale: true }),
        },
      });

      const out = await adapter.generate('Write alert', {
        onUsage: (evt) => {
          events.push(evt);
        },
      });
      expect(out).toContain('Scenic Overlook');
      expect(events).toHaveLength(1);
      const expectedCost1 = calculateBedrockCallCostNanos(
        {
          inputTokens: 2_000,
          outputTokens: 400,
          cacheReadInputTokens: 1_000,
          cacheWriteInputTokens: 0,
        },
        novaRate,
      );
      expect(events[0]).toEqual({
        providerId: 'bedrock',
        modelId: DEFAULT_BEDROCK_COPYWRITER_MODEL_ID,
        inputTokens: 2_000,
        outputTokens: 400,
        cacheReadInputTokens: 1_000,
        cacheWriteInputTokens: 0,
        costNanos: expectedCost1,
        pricingStale: true,
        usageComplete: true,
      });

      // Even when stopReason === 'max_tokens' throws MalformedAiResponseError, usage is still emitted first
      mockBehavior = 'max_tokens';
      await expect(
        adapter.generate('Write alert', {
          onUsage: (evt) => {
            events.push(evt);
          },
        }),
      ).rejects.toBeInstanceOf(MalformedAiResponseError);
      expect(events).toHaveLength(2);
      expect(events[1]?.usageComplete).toBe(true);
      expect(events[1]?.inputTokens).toBe(1_000);
      expect(events[1]?.outputTokens).toBe(500);

      // When client.send rejects after dispatch, emits usageComplete: false with 0 tokens/cost
      mockBehavior = 'network_error';
      await expect(
        adapter.generate('Write alert', {
          onUsage: (evt) => {
            events.push(evt);
          },
        }),
      ).rejects.toThrow('Bedrock runtime socket reset');
      expect(events).toHaveLength(3);
      expect(events[2]).toEqual({
        providerId: 'bedrock',
        modelId: DEFAULT_BEDROCK_COPYWRITER_MODEL_ID,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        costNanos: 0,
        pricingStale: true,
        usageComplete: false,
      });
    });

    it('emits one AiUsageEvent per tool-loop iteration in generateStreamWithTools() and records usageComplete: false on mid-stream abort', async () => {
      const events: AiUsageEvent[] = [];
      let callCount = 0;

      const mockStreamClient = {
        send: vi.fn(async () => {
          callCount += 1;
          if (callCount === 1) {
            // Iteration 1: tool_use with usage metadata
            return {
              stream: (async function* () {
                yield {
                  contentBlockStart: {
                    contentBlockIndex: 0,
                    start: { toolUse: { toolUseId: 'tool_1', name: 'search_web' } },
                  },
                };
                yield {
                  contentBlockDelta: {
                    contentBlockIndex: 0,
                    delta: { toolUse: { input: '{"query":"Sedona"}' } },
                  },
                };
                yield { messageStop: { stopReason: 'tool_use' } };
                yield {
                  metadata: {
                    usage: {
                      inputTokens: 1_500,
                      outputTokens: 250,
                      cacheReadInputTokens: 500,
                      cacheWriteInputTokens: 100,
                    },
                  },
                };
              })(),
            };
          }
          if (callCount === 2) {
            // Iteration 2: final response with usage metadata
            return {
              stream: (async function* () {
                yield {
                  contentBlockDelta: {
                    contentBlockIndex: 0,
                    delta: { text: 'Here are the vetted stops in Sedona.' },
                  },
                };
                yield { messageStop: { stopReason: 'end_turn' } };
                yield {
                  metadata: {
                    usage: {
                      inputTokens: 2_200,
                      outputTokens: 350,
                      cacheReadInputTokens: 1_500,
                      cacheWriteInputTokens: 0,
                    },
                  },
                };
              })(),
            };
          }
          // Call 3: stream aborts mid-flight before metadata.usage arrives
          return {
            stream: (async function* () {
              yield {
                contentBlockDelta: {
                  contentBlockIndex: 0,
                  delta: { text: 'Partial stream before disconnect...' },
                },
              };
              throw new Error('Request aborted');
            })(),
          };
        }),
      } as unknown as BedrockRuntimeClient;

      const adapter = new AwsBedrockHarnessAdapter({
        client: mockStreamClient,
        availableModels: seededModels,
        pricingCatalog: makeCatalog(),
      });

      const streamRes = await adapter.generateStreamWithTools(
        'Audit Sedona stops',
        [{ name: 'search_web', description: 'Search web', inputSchema: { type: 'object' } }],
        async () => ({ results: ['Red Rock Park'] }),
        () => {},
        {
          onUsage: (evt) => {
            events.push(evt);
          },
        },
      );

      expect(streamRes.text).toContain('Here are the vetted stops in Sedona.');
      expect(streamRes.inputTokens).toBe(3_700);
      expect(streamRes.outputTokens).toBe(600);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        providerId: 'bedrock',
        modelId: DEFAULT_BEDROCK_SCOUT_MODEL_ID,
        inputTokens: 1_500,
        outputTokens: 250,
        cacheReadInputTokens: 500,
        cacheWriteInputTokens: 100,
        costNanos: calculateBedrockCallCostNanos(
          {
            inputTokens: 1_500,
            outputTokens: 250,
            cacheReadInputTokens: 500,
            cacheWriteInputTokens: 100,
          },
          kimiRate,
        ),
        usageComplete: true,
      });
      expect(events[1]).toEqual({
        providerId: 'bedrock',
        modelId: DEFAULT_BEDROCK_SCOUT_MODEL_ID,
        inputTokens: 2_200,
        outputTokens: 350,
        cacheReadInputTokens: 1_500,
        cacheWriteInputTokens: 0,
        costNanos: calculateBedrockCallCostNanos(
          {
            inputTokens: 2_200,
            outputTokens: 350,
            cacheReadInputTokens: 1_500,
            cacheWriteInputTokens: 0,
          },
          kimiRate,
        ),
        usageComplete: true,
      });

      // Now trigger Call 3 (mid-stream abort before metadata.usage arrives)
      await expect(
        adapter.generateStreamWithTools(
          'Audit Sedona stops',
          [],
          async () => ({}),
          () => {},
          {
            onUsage: (evt) => {
              events.push(evt);
            },
          },
        ),
      ).rejects.toThrow('Request aborted');

      expect(events).toHaveLength(3);
      expect(events[2]).toEqual({
        providerId: 'bedrock',
        modelId: DEFAULT_BEDROCK_SCOUT_MODEL_ID,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        costNanos: 0,
        usageComplete: false,
      });
    });

    it('intersects controlClient discovery with pricingCatalog, prefers priced profile aliases, and supports us.amazon.nova-lite-v1:0', async () => {
      const mockControlClient = {
        send: vi.fn(async (cmd: { constructor: { name: string } }) => {
          if (cmd.constructor.name === 'ListInferenceProfilesCommand') {
            return {
              inferenceProfileSummaries: [
                {
                  inferenceProfileId: 'us.moonshotai.kimi-k3',
                  inferenceProfileName: 'US Kimi K3',
                  status: 'ACTIVE',
                  type: 'SYSTEM_DEFINED',
                  models: [
                    { modelArn: 'arn:aws:bedrock:us-east-2::foundation-model/moonshotai.kimi-k3' },
                  ],
                },
                {
                  inferenceProfileId: 'global.moonshotai.kimi-k3',
                  inferenceProfileName: 'Global Kimi K3',
                  status: 'ACTIVE',
                  type: 'SYSTEM_DEFINED',
                  models: [
                    { modelArn: 'arn:aws:bedrock:us-east-2::foundation-model/moonshotai.kimi-k3' },
                  ],
                },
                {
                  inferenceProfileId: 'us.amazon.nova-lite-v1:0',
                  inferenceProfileName: 'US Nova Lite',
                  status: 'ACTIVE',
                  type: 'SYSTEM_DEFINED',
                  models: [
                    { modelArn: 'arn:aws:bedrock:us-east-2::foundation-model/amazon.nova-lite-v1:0' },
                  ],
                },
              ],
            };
          }
          if (cmd.constructor.name === 'ListFoundationModelsCommand') {
            return {
              modelSummaries: [
                {
                  modelId: 'moonshotai.kimi-k3',
                  modelName: 'Kimi K3',
                  providerName: 'Moonshot AI',
                  inputModalities: ['TEXT'],
                  outputModalities: ['TEXT'],
                  responseStreamingSupported: true,
                  modelLifecycle: { status: 'ACTIVE' },
                },
                {
                  modelId: 'amazon.nova-lite-v1:0',
                  modelName: 'Nova Lite',
                  providerName: 'Amazon',
                  inputModalities: ['TEXT'],
                  outputModalities: ['TEXT'],
                  responseStreamingSupported: true,
                  modelLifecycle: { status: 'ACTIVE' },
                },
              ],
            };
          }
          return {
            authorizationStatus: 'AUTHORIZED',
            entitlementAvailability: 'AVAILABLE',
            regionAvailability: 'AVAILABLE',
            agreementAvailability: { status: 'AVAILABLE' },
          };
        }),
      } as unknown as BedrockClient;

      const globalKimiRate: BedrockModelTokenRate = {
        ...kimiRate,
        modelId: 'global.moonshotai.kimi-k3',
      };
      const usNovaLiteRate: BedrockModelTokenRate = {
        ...novaRate,
        modelId: 'us.amazon.nova-lite-v1:0',
        foundationModelId: 'amazon.nova-lite-v1:0',
      };

      const adapter = new AwsBedrockHarnessAdapter({
        controlClient: mockControlClient,
        pricingCatalog: makeCatalog({
          models: {
            'global.moonshotai.kimi-k3': globalKimiRate,
            'us.amazon.nova-lite-v1:0': usNovaLiteRate,
          },
          unpricedModelIds: ['us.moonshotai.kimi-k3'],
        }),
      });

      const available = await adapter.getAvailableModels();
      expect(available.map((m) => m.id)).toEqual([
        'global.moonshotai.kimi-k3',
        'us.amazon.nova-lite-v1:0',
      ]);

      // Bare foundation ID resolves to the priced global.* profile instead of the unpriced us.* profile
      await expect(adapter.validateModelId('moonshotai.kimi-k3', 'scout')).resolves.toBe(
        'global.moonshotai.kimi-k3',
      );
      // Direct selection of us.amazon.nova-lite-v1:0 stays canonical and does not get rewritten to bare ID
      await expect(adapter.validateModelId('us.amazon.nova-lite-v1:0', 'copywriter')).resolves.toBe(
        'us.amazon.nova-lite-v1:0',
      );
    });
  });
});
