import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BedrockClient } from '@aws-sdk/client-bedrock';
import type { PricingClient } from '@aws-sdk/client-pricing';
import {
  PRICED_REGION,
  type BedrockPricingCatalog,
} from '../services/ai/bedrock/bedrockPricing.js';
import {
  DEFAULT_BEDROCK_COPYWRITER_MODEL_ID,
  DEFAULT_BEDROCK_SCOUT_MODEL_ID,
} from '../services/ai/bedrock/bedrockService.js';
import {
  discoverBedrockModelsForPricing,
  handler as refreshPricingLambdaHandler,
  loadLocalEnvFileIfPresent,
  refreshBedrockPricing,
} from './refreshBedrockPricing.js';
import {
  TEST_KIMI_RATE,
  TEST_NOVA_RATE,
  TEST_PRICING_REFRESHED_MS,
  makeDefaultPricingClientMock,
  makeTestPriceEntry,
} from '../test-helpers/bedrockFixtures.js';

describe('Weekly Bedrock Pricing Refresh Handler & Model Discovery (refreshBedrockPricing.ts)', () => {
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
      now: () => TEST_PRICING_REFRESHED_MS,
    });

    expect(result.pricedModelCount).toBe(3);
    expect(result.unpricedModelCount).toBe(1);
    expect(result.catalog.models[DEFAULT_BEDROCK_SCOUT_MODEL_ID]).toEqual(TEST_KIMI_RATE);
    expect(result.catalog.models[DEFAULT_BEDROCK_COPYWRITER_MODEL_ID]).toEqual(TEST_NOVA_RATE);
    expect(result.catalog.unpricedModelIds).toEqual(['mystery.unpriced-v1:0']);

    const persisted = JSON.parse(await fs.readFile(localFilePath, 'utf-8')) as BedrockPricingCatalog;
    expect(persisted).toEqual(result.catalog);
    expect(typeof refreshPricingLambdaHandler).toBe('function');
  });

  it('refuses to overwrite the pricing catalog when a configured default model fails to resolve a price', async () => {
    const localFilePath = path.join(tempDir, 'bedrock-us-east-2.json');
    const partialPricingClient = {
      send: vi.fn(async (cmd: { input?: { ServiceCode?: string } }) => {
        if (cmd.input?.ServiceCode === 'AmazonBedrock') {
          return {
            PriceList: [
              makeTestPriceEntry({
                serviceCode: 'AmazonBedrock',
                usagetype: 'USE2-Nova2.0Lite-input-tokens',
                model: 'Nova 2 Lite',
                inferenceType: 'Input tokens',
                unit: '1K tokens',
                usd: '0.0003300000',
                provider: 'Amazon',
              }),
              makeTestPriceEntry({
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
              makeTestPriceEntry({
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
        now: () => TEST_PRICING_REFRESHED_MS,
      }),
    ).rejects.toThrow(
      `Refusing to overwrite pricing catalog: configured default model "${DEFAULT_BEDROCK_SCOUT_MODEL_ID}" did not resolve a price`,
    );
  });

  it('supports bare foundation model IDs in BEDROCK_SCOUT_MODEL_ID/BEDROCK_COPYWRITER_MODEL_ID and rejects when a configured default model is absent from discovery', async () => {
    const localFilePath = path.join(tempDir, 'bedrock-us-east-2.json');
    const discoveredModels = [
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
    ];

    const origScout = process.env.BEDROCK_SCOUT_MODEL_ID;
    const origCopywriter = process.env.BEDROCK_COPYWRITER_MODEL_ID;
    try {
      process.env.BEDROCK_SCOUT_MODEL_ID = 'moonshotai.kimi-k3';
      process.env.BEDROCK_COPYWRITER_MODEL_ID = 'amazon.nova-2-lite-v1:0';

      // 1. Bare foundation model IDs match via rate.foundationModelId === defaultId
      const res = await refreshBedrockPricing({
        discoveredModels,
        pricingClient: makeDefaultPricingClientMock(),
        localFilePath,
        s3Bucket: '',
        now: () => TEST_PRICING_REFRESHED_MS,
      });
      expect(res.pricedModelCount).toBe(2);

      // 2. When a configured default model is completely absent from discoveredModels, fails loudly before overwriting
      await expect(
        refreshBedrockPricing({
          discoveredModels: [discoveredModels[1]!],
          pricingClient: makeDefaultPricingClientMock(),
          localFilePath,
          s3Bucket: '',
          now: () => TEST_PRICING_REFRESHED_MS,
        }),
      ).rejects.toThrow(
        'Refusing to overwrite pricing catalog: configured default model "moonshotai.kimi-k3" did not resolve a price',
      );
    } finally {
      if (origScout === undefined) delete process.env.BEDROCK_SCOUT_MODEL_ID;
      else process.env.BEDROCK_SCOUT_MODEL_ID = origScout;
      if (origCopywriter === undefined) delete process.env.BEDROCK_COPYWRITER_MODEL_ID;
      else process.env.BEDROCK_COPYWRITER_MODEL_ID = origCopywriter;
    }
  });

  it('defaults BedrockClient region to us-east-2 (PRICED_REGION) when AWS_REGION and AWS_DEFAULT_REGION are unset', async () => {
    const origAwsRegion = process.env.AWS_REGION;
    const origAwsDefaultRegion = process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;

    let capturedRegion: string | undefined;
    const sendSpy = vi.spyOn(BedrockClient.prototype, 'send').mockImplementation(async function (
      this: BedrockClient,
      cmd: unknown,
    ) {
      capturedRegion = await this.config.region();
      const name = (cmd as { constructor?: { name?: string } })?.constructor?.name;
      if (name === 'ListInferenceProfilesCommand') {
        return { inferenceProfileSummaries: [] } as never;
      }
      return { modelSummaries: [] } as never;
    });

    try {
      await discoverBedrockModelsForPricing();
      expect(capturedRegion).toBe(PRICED_REGION);
      expect(capturedRegion).toBe('us-east-2');
    } finally {
      sendSpy.mockRestore();
      if (origAwsRegion !== undefined) process.env.AWS_REGION = origAwsRegion;
      else delete process.env.AWS_REGION;
      if (origAwsDefaultRegion !== undefined) process.env.AWS_DEFAULT_REGION = origAwsDefaultRegion;
      else delete process.env.AWS_DEFAULT_REGION;
    }
  });

  it('loads variables from a .env file via loadLocalEnvFileIfPresent and does not throw when no .env file exists', async () => {
    // 1. Does not throw when no .env file exists in tempDir
    expect(() => loadLocalEnvFileIfPresent(tempDir)).not.toThrow();

    // 2. Loads variables from .env file when present in tempDir
    const envKey = 'TEST_BEDROCK_REFRESH_VAR';
    const envVal = 'test_value_12345';
    delete process.env[envKey];

    const envFilePath = path.join(tempDir, '.env');
    await fs.writeFile(envFilePath, `${envKey}=${envVal}\n`, 'utf-8');

    try {
      loadLocalEnvFileIfPresent(tempDir);
      expect(process.env[envKey]).toBe(envVal);
    } finally {
      delete process.env[envKey];
    }
  });
});
