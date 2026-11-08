import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AwsBedrockHarnessAdapter,
  InvalidModelError,
  DEFAULT_BEDROCK_SCOUT_MODEL_ID,
  DEFAULT_BEDROCK_COPYWRITER_MODEL_ID,
  MAX_TOOL_ITERATIONS,
  MODEL_AVAILABILITY_TTL_MS,
  sanitizeBedrockResponse,
  formatBedrockToolLabel,
  toFoundationModelId,
} from './bedrockService.js';
import type { BedrockClient } from '@aws-sdk/client-bedrock';
import {
  AiService,
  type AiHarnessAdapter,
} from './aiService.js';
import { ScoutService } from './scoutService.js';
import { MalformedAiResponseError } from './schemaParser.js';
import { createApp } from '../app.js';
import type {
  WaypointContext,
  ToolDeclaration,
  AiModelOption,
} from '../types/ai.js';
import type {
  ScoutChatRequest,
  ScoutTripContext,
  ScoutStreamEvent,
  ScoutChatResponse,
} from '../types/scout.js';
import {
  ConverseCommand,
  ConverseStreamCommand,
  type BedrockRuntimeClient,
  type ConverseStreamOutput,
} from '@aws-sdk/client-bedrock-runtime';

// Helper to create async generator stream for ConverseStreamCommand mocks
async function* createAsyncStream<T>(chunks: T[]): AsyncIterable<T> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

// Sample test fixtures
const sampleWaypoint: WaypointContext = {
  id: 'wp_sedona_bell_rock',
  name: 'Sedona Red Rock Vistas (Bell Rock)',
  type: 'scenic_pull_off',
  targetTime: '16:30:00',
  formattedTime: '4:30 PM',
  approachHighway: 'AZ-179 North',
  notes: 'Bell Rock scenic pull-off for photo views',
};
const sampleTripContext: ScoutTripContext = {
  tripName: 'Phoenix to Sedona Scenic Run',
  date: '2026-10-10',
  origin: 'Phoenix, AZ',
  destination: 'Sedona, AZ',
  departureTime: '08:00:00',
  corridor: 'I-17 N to AZ-179 N Red Rock Scenic Byway',
  waypoints: [
    {
      id: 'wp_origin',
      name: 'Phoenix Origin',
      type: 'origin',
      lat: 33.4484,
      lng: -112.074,
      target_time: '08:00:00',
      dwell_minutes: 0,
    },
    {
      id: 'wp_sedona_bell_rock',
      name: 'Bell Rock Scenic Vista',
      type: 'scenic_pull_off',
      lat: 34.8005,
      lng: -111.7667,
      target_time: '10:00:00',
      dwell_minutes: 20,
    },
    {
      id: 'wp_dest',
      name: 'Sedona Lodging',
      type: 'lodging',
      lat: 34.8697,
      lng: -111.761,
      target_time: '12:00:00',
      dwell_minutes: 0,
    },
  ],
};


const sampleTools: ToolDeclaration[] = [
  {
    name: 'search_web',
    description: 'Searches the web for corridor queries',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'read_url_content',
    description: 'Reads web content from a URL',
    inputSchema: {
      type: 'object',
      properties: { Url: { type: 'string' } },
      required: ['Url'],
    },
  },
];

const TEST_MOCK_MODELS: AiModelOption[] = [
  {
    id: 'us.moonshotai.kimi-k3',
    name: 'Moonshot Kimi K3',
    provider: 'Moonshot AI',
    description: 'Flagship 2.8T MoE corridor & agentic reasoning engine (1M context)',
    role: 'both',
  },
  {
    id: 'us.amazon.nova-2-lite-v1:0',
    name: 'Amazon Nova 2 Lite',
    provider: 'Amazon',
    description: 'Fast, low-latency reasoning & alert copywriter',
    role: 'both',
  },
  {
    id: 'us.amazon.nova-pro-v1:0',
    name: 'Amazon Nova Pro',
    provider: 'Amazon',
    description: 'Balanced multimodal & agentic route co-pilot',
    role: 'both',
  },
  {
    id: 'openai.gpt-oss-120b-1:0',
    name: 'OpenAI GPT-OSS 120B',
    provider: 'OpenAI',
    description: 'Frontier open-weights deep reasoning & tool-use model',
    role: 'both',
  },
  {
    id: 'openai.gpt-oss-20b-1:0',
    name: 'OpenAI GPT-OSS 20B',
    provider: 'OpenAI',
    description: 'High-speed, low-cost alert copywriting & chat',
    role: 'both',
  },
  {
    id: 'deepseek.v3.2',
    name: 'DeepSeek V3.2',
    provider: 'DeepSeek',
    description: 'High-efficiency corridor analysis & structured JSON generation',
    role: 'both',
  },
  {
    id: 'mistral.mistral-large-3-675b-instruct',
    name: 'Mistral Large 3 (675B)',
    provider: 'Mistral AI',
    description: 'Heavyweight 675B instruct model for multi-stop auditing',
    role: 'both',
  },
  {
    id: 'moonshotai.kimi-k2.5',
    name: 'Moonshot Kimi K2.5',
    provider: 'Moonshot AI',
    description: 'Fast on-demand conversational & tool-use model',
    role: 'both',
  },
  {
    id: 'us.openai.gpt-6-luna',
    name: 'OpenAI GPT-6 Luna',
    provider: 'OpenAI',
    description: 'Ultra-fast frontier model for copywriting & daily turns (requires AWS account opt-in)',
    role: 'both',
  },
  {
    id: 'us.anthropic.claude-sonnet-5-5',
    name: 'Anthropic Claude Sonnet 5.5',
    provider: 'Anthropic',
    description: 'Frontier agentic tool use & stylist (requires Anthropic account opt-in)',
    role: 'both',
  },
  {
    id: 'us.openai.gpt-6-sol',
    name: 'OpenAI GPT-6 Sol',
    provider: 'OpenAI',
    description: 'Standard frontier co-pilot & corridor logistics (requires AWS account opt-in)',
    role: 'both',
  },
  {
    id: 'us.openai.gpt-6-astra',
    name: 'OpenAI GPT-6 Astra',
    provider: 'OpenAI',
    description: 'Heavyweight multi-day corridor audit engine (requires AWS account opt-in)',
    role: 'scout',
  },
  {
    id: 'us.anthropic.claude-opus-5-5',
    name: 'Anthropic Claude Opus 5.5',
    provider: 'Anthropic',
    description: 'Flagship multi-day architect (requires Anthropic account opt-in)',
    role: 'scout',
  },
  {
    id: 'us.xai.grok-4.7',
    name: 'xAI Grok 4.7',
    provider: 'xAI',
    description: 'Long-horizon agentic workflow engine (requires AWS account opt-in)',
    role: 'both',
  },
  {
    id: 'amazon.nova-lite-v1:0',
    name: 'Amazon Nova Lite',
    provider: 'Amazon',
    description: 'Cost-effective multimodal model for high-volume turns',
    role: 'both',
  },
  {
    id: 'us.openai.gpt-6.1-sol',
    name: 'OpenAI GPT-6.1 Sol',
    provider: 'OpenAI',
    description: 'Advanced frontier co-pilot & corridor logistics (requires AWS account opt-in)',
    role: 'both',
  },
  {
    id: 'us.anthropic.claude-sonnet-4-6',
    name: 'Anthropic Claude Sonnet 4.6',
    provider: 'Anthropic',
    description: 'High-precision corridor analysis & reasoning (requires Anthropic account opt-in)',
    role: 'both',
  },
  {
    id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    name: 'Anthropic Claude Haiku 4.5',
    provider: 'Anthropic',
    description: 'High-speed, lightweight alert copywriting (requires Anthropic account opt-in)',
    role: 'copywriter',
  },
];

describe('Bedrock catalog, allowlist, and region', () => {
    describe('Catalog & Defaults (ADR-0010)', () => {
      it('verifies DEFAULT_BEDROCK_SCOUT_MODEL_ID and DEFAULT_BEDROCK_COPYWRITER_MODEL_ID match ADR-0010', () => {
        expect(DEFAULT_BEDROCK_SCOUT_MODEL_ID).toBe('us.moonshotai.kimi-k3');
        expect(DEFAULT_BEDROCK_COPYWRITER_MODEL_ID).toBe('us.amazon.nova-2-lite-v1:0');
        expect(MAX_TOOL_ITERATIONS).toBe(5);
      });

      it('getModelCatalog() returns empty models when availableModels is not populated (no static fallback)', () => {
        const adapter = new AwsBedrockHarnessAdapter({
          scoutModelId: 'us.amazon.nova-pro-v1:0',
          copywriterModelId: 'us.amazon.nova-2-lite-v1:0',
        });

        const catalog = adapter.getModelCatalog();
        expect(catalog.models).toEqual([]);
        expect(catalog.defaultScoutModelId).toBe('us.amazon.nova-pro-v1:0');
        expect(catalog.defaultCopywriterModelId).toBe('us.amazon.nova-2-lite-v1:0');
      });

      it('getModelCatalog() returns injected availableModels and active configured defaults', () => {
        const adapter = new AwsBedrockHarnessAdapter({
          availableModels: TEST_MOCK_MODELS,
          scoutModelId: 'us.amazon.nova-pro-v1:0',
          copywriterModelId: 'us.amazon.nova-2-lite-v1:0',
        });

        const catalog = adapter.getModelCatalog();
        expect(catalog.models).toEqual(TEST_MOCK_MODELS);
        expect(catalog.defaultScoutModelId).toBe('us.amazon.nova-pro-v1:0');
        expect(catalog.defaultCopywriterModelId).toBe('us.amazon.nova-2-lite-v1:0');
      });

      it('supports constructor options and environment variables with alias normalization for defaults', () => {
        const prevScout = process.env.BEDROCK_SCOUT_MODEL_ID;
        const prevCopy = process.env.BEDROCK_COPYWRITER_MODEL_ID;
        try {
          process.env.BEDROCK_SCOUT_MODEL_ID = 'moonshotai.kimi-k3';
          process.env.BEDROCK_COPYWRITER_MODEL_ID = 'amazon.nova-2-lite-v1:0';

          const adapter = new AwsBedrockHarnessAdapter();
          expect(adapter.defaultScoutModelId).toBe('us.moonshotai.kimi-k3');
          expect(adapter.defaultCopywriterModelId).toBe('us.amazon.nova-2-lite-v1:0');
        } finally {
          if (prevScout !== undefined) process.env.BEDROCK_SCOUT_MODEL_ID = prevScout;
          else delete process.env.BEDROCK_SCOUT_MODEL_ID;
          if (prevCopy !== undefined) process.env.BEDROCK_COPYWRITER_MODEL_ID = prevCopy;
          else delete process.env.BEDROCK_COPYWRITER_MODEL_ID;
        }
      });
    });

    describe('Model Allowlist & Alias Normalization (validateModelId)', () => {
      const adapter = new AwsBedrockHarnessAdapter({
        available: true,
        availableModels: TEST_MOCK_MODELS,
      });

      it('normalizes bare foundation model IDs to their us. inference profiles', async () => {
        expect(await adapter.validateModelId('moonshotai.kimi-k3')).toBe('us.moonshotai.kimi-k3');
        expect(await adapter.validateModelId('amazon.nova-2-lite-v1:0')).toBe('us.amazon.nova-2-lite-v1:0');
        expect(await adapter.validateModelId('amazon.nova-pro-v1:0')).toBe('us.amazon.nova-pro-v1:0');
        expect(await adapter.validateModelId('openai.gpt-6-luna')).toBe('us.openai.gpt-6-luna');
        expect(await adapter.validateModelId('anthropic.claude-sonnet-5-5')).toBe('us.anthropic.claude-sonnet-5-5');
        expect(await adapter.validateModelId('xai.grok-4.7')).toBe('us.xai.grok-4.7');
      });

      it('accepts direct on-demand models and additional allowed IDs', async () => {
        expect(await adapter.validateModelId('openai.gpt-oss-120b-1:0')).toBe('openai.gpt-oss-120b-1:0');
        expect(await adapter.validateModelId('deepseek.v3.2')).toBe('deepseek.v3.2');
        expect(await adapter.validateModelId('mistral.mistral-large-3-675b-instruct')).toBe('mistral.mistral-large-3-675b-instruct');
        expect(await adapter.validateModelId('moonshotai.kimi-k2.5')).toBe('moonshotai.kimi-k2.5');
        expect(await adapter.validateModelId('amazon.nova-lite-v1:0')).toBe('amazon.nova-lite-v1:0');
        expect(await adapter.validateModelId('us.amazon.nova-lite-v1:0')).toBe('amazon.nova-lite-v1:0');
      });

      it('rejects empty string, whitespace, and unknown model IDs with InvalidModelError (HTTP 400)', async () => {
        await expect(adapter.validateModelId('')).rejects.toThrow(InvalidModelError);
        await expect(adapter.validateModelId('   ')).rejects.toThrow(InvalidModelError);
        await expect(adapter.validateModelId('unknown-model-xyz')).rejects.toThrow(InvalidModelError);

        try {
          await adapter.validateModelId('unknown-model-xyz');
        } catch (err: unknown) {
          expect(err).toBeInstanceOf(InvalidModelError);
          expect((err as InvalidModelError).statusCode).toBe(400);
          expect((err as InvalidModelError).message).toContain('Unsupported');
        }

        try {
          await adapter.validateModelId('');
        } catch (err: unknown) {
          expect(err).toBeInstanceOf(InvalidModelError);
          expect((err as InvalidModelError).statusCode).toBe(400);
          expect((err as InvalidModelError).message).toContain('Model ID must not be empty');
        }
      });

      it('rejects model IDs excluded via options.excludedModelIds or BEDROCK_EXCLUDED_MODEL_IDS', async () => {
        const adapterWithOptions = new AwsBedrockHarnessAdapter({
          available: true,
          availableModels: TEST_MOCK_MODELS,
          excludedModelIds: ['us.amazon.nova-pro-v1:0'],
        });
        await expect(adapterWithOptions.validateModelId('us.amazon.nova-pro-v1:0')).rejects.toThrow(InvalidModelError);
        await expect(adapterWithOptions.validateModelId('us.amazon.nova-pro-v1:0')).rejects.toThrow(/excluded by policy/);

        const prevEnv = process.env.BEDROCK_EXCLUDED_MODEL_IDS;
        try {
          process.env.BEDROCK_EXCLUDED_MODEL_IDS = 'us.moonshotai.kimi-k3, custom.excluded-model';
          const adapterWithEnv = new AwsBedrockHarnessAdapter({
            available: true,
            availableModels: TEST_MOCK_MODELS,
          });
          await expect(adapterWithEnv.validateModelId('us.moonshotai.kimi-k3')).rejects.toThrow(InvalidModelError);
          await expect(adapterWithEnv.validateModelId('us.moonshotai.kimi-k3')).rejects.toThrow(/excluded by policy/);
        } finally {
          if (prevEnv !== undefined) process.env.BEDROCK_EXCLUDED_MODEL_IDS = prevEnv;
          else delete process.env.BEDROCK_EXCLUDED_MODEL_IDS;
        }
      });

      it('rejects inherited object-property names (constructor, __proto__, toString) safely as InvalidModelError (P2 Finding 5)', async () => {
        const adapter = new AwsBedrockHarnessAdapter({
          available: true,
          availableModels: TEST_MOCK_MODELS,
        });

        await expect(adapter.validateModelId('constructor')).rejects.toThrow(InvalidModelError);
        await expect(adapter.validateModelId('__proto__')).rejects.toThrow(InvalidModelError);
        await expect(adapter.validateModelId('toString')).rejects.toThrow(InvalidModelError);

        expect(adapter.resolveCanonicalModelId('constructor')).toBe('constructor');
        expect(adapter.resolveCanonicalModelId('__proto__')).toBe('__proto__');
        expect(adapter.resolveCanonicalModelId('toString')).toBe('toString');
      });

      it('excludes foundation model and all variants when foundation ID is excluded, but preserves variants when only specific profile is excluded (P2 Finding 2)', async () => {
        const mockControlClient = {
          send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string; byOutputModality?: string } }) => {
            if (cmd.input?.byOutputModality === 'TEXT') {
              return {
                modelSummaries: [
                  {
                    modelId: 'amazon.nova-2-lite-v1:0',
                    modelName: 'Nova 2 Lite',
                    providerName: 'Amazon',
                    inputModalities: ['TEXT'],
                    outputModalities: ['TEXT'],
                    responseStreamingSupported: true,
                  },
                ],
              };
            }
            if (!cmd.input?.modelId) {
              return {
                inferenceProfileSummaries: [
                  {
                    inferenceProfileId: 'us.amazon.nova-2-lite-v1:0',
                    status: 'ACTIVE',
                    type: 'SYSTEM_DEFINED',
                    models: [{ modelArn: 'arn:aws:bedrock:us-east-2::foundation-model/amazon.nova-2-lite-v1:0' }],
                  },
                  {
                    inferenceProfileId: 'global.amazon.nova-2-lite-v1:0',
                    status: 'ACTIVE',
                    type: 'SYSTEM_DEFINED',
                    models: [{ modelArn: 'arn:aws:bedrock:us-east-2::foundation-model/amazon.nova-2-lite-v1:0' }],
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
        };

        // Case A: Bare foundation ID excluded -> covers both US and global profiles
        const adapterWithBareExcluded = new AwsBedrockHarnessAdapter({
          controlClient: mockControlClient as unknown as BedrockClient,
          client: {} as unknown as BedrockRuntimeClient,
          excludedModelIds: ['amazon.nova-2-lite-v1:0'],
        });
        const modelsA = await adapterWithBareExcluded.getAvailableModels();
        expect(modelsA.map((m) => m.id)).toEqual([]);
        await expect(adapterWithBareExcluded.validateModelId('amazon.nova-2-lite-v1:0')).rejects.toThrow(/excluded by policy/);
        await expect(adapterWithBareExcluded.validateModelId('us.amazon.nova-2-lite-v1:0')).rejects.toThrow(/excluded by policy/);
        await expect(adapterWithBareExcluded.validateModelId('global.amazon.nova-2-lite-v1:0')).rejects.toThrow(/excluded by policy/);

        // Case B: Profile-scoped exclusion -> excludes US variant, retains global variant
        const adapterWithProfileExcluded = new AwsBedrockHarnessAdapter({
          controlClient: mockControlClient as unknown as BedrockClient,
          client: {} as unknown as BedrockRuntimeClient,
          excludedModelIds: ['us.amazon.nova-2-lite-v1:0'],
        });
        const modelsB = await adapterWithProfileExcluded.getAvailableModels();
        expect(modelsB.map((m) => m.id)).toEqual(['global.amazon.nova-2-lite-v1:0']);
        expect(await adapterWithProfileExcluded.validateModelId('amazon.nova-2-lite-v1:0', 'scout')).toBe('global.amazon.nova-2-lite-v1:0');
        await expect(adapterWithProfileExcluded.validateModelId('us.amazon.nova-2-lite-v1:0')).rejects.toThrow(/excluded by policy/);
      });

      it('deterministically selects US inference profile over global profile regardless of AWS listing order (P2 Finding 2)', async () => {
        const mockControlClient = {
          send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string; byOutputModality?: string } }) => {
            if (cmd.input?.byOutputModality === 'TEXT') {
              return {
                modelSummaries: [
                  {
                    modelId: 'vendor.test-model-v1:0',
                    modelName: 'Test Model',
                    providerName: 'Vendor',
                    inputModalities: ['TEXT'],
                    outputModalities: ['TEXT'],
                    responseStreamingSupported: true,
                  },
                ],
              };
            }
            if (!cmd.input?.modelId) {
              return {
                // Return global first, then us
                inferenceProfileSummaries: [
                  {
                    inferenceProfileId: 'global.vendor.test-model-v1:0',
                    status: 'ACTIVE',
                    type: 'SYSTEM_DEFINED',
                    models: [{ modelArn: 'arn:aws:bedrock:us-east-2::foundation-model/vendor.test-model-v1:0' }],
                  },
                  {
                    inferenceProfileId: 'us.vendor.test-model-v1:0',
                    status: 'ACTIVE',
                    type: 'SYSTEM_DEFINED',
                    models: [{ modelArn: 'arn:aws:bedrock:us-east-2::foundation-model/vendor.test-model-v1:0' }],
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
        };

        const adapter = new AwsBedrockHarnessAdapter({
          controlClient: mockControlClient as unknown as BedrockClient,
          client: {} as unknown as BedrockRuntimeClient,
        });

        const models = await adapter.getAvailableModels();
        expect(models.map((m) => m.id)).toEqual(['global.vendor.test-model-v1:0', 'us.vendor.test-model-v1:0']);
        // Dynamic alias prioritizes us.* over global.*
        expect(adapter.resolveCanonicalModelId('vendor.test-model-v1:0')).toBe('us.vendor.test-model-v1:0');
        expect(await adapter.validateModelId('vendor.test-model-v1:0', 'scout')).toBe('us.vendor.test-model-v1:0');
      });
    });

    describe('Region Resolution (Negative Constraint Verification)', () => {
      const origRegion = process.env.AWS_REGION;
      const origDefRegion = process.env.AWS_DEFAULT_REGION;

      afterEach(() => {
        if (origRegion !== undefined) process.env.AWS_REGION = origRegion;
        else delete process.env.AWS_REGION;
        if (origDefRegion !== undefined) process.env.AWS_DEFAULT_REGION = origDefRegion;
        else delete process.env.AWS_DEFAULT_REGION;
      });

      it('respects options.region (e.g. us-east-2) and never hardcodes us-east-1', async () => {
        delete process.env.AWS_REGION;
        delete process.env.AWS_DEFAULT_REGION;

        const adapter = new AwsBedrockHarnessAdapter({ region: 'us-east-2' });
        const client = (adapter as unknown as { client: BedrockRuntimeClient }).client;
        const resolvedRegion = await client.config.region();

        expect(resolvedRegion).toBe('us-east-2');
        expect(resolvedRegion).not.toBe('us-east-1');
      });

      it('respects process.env.AWS_REGION (us-east-2) when no explicit option is provided', async () => {
        process.env.AWS_REGION = 'us-east-2';
        delete process.env.AWS_DEFAULT_REGION;

        const adapter = new AwsBedrockHarnessAdapter();
        const client = (adapter as unknown as { client: BedrockRuntimeClient }).client;
        const resolvedRegion = await client.config.region();

        expect(resolvedRegion).toBe('us-east-2');
      });

      it('respects alternative non-default region (e.g. eu-west-1)', async () => {
        const adapter = new AwsBedrockHarnessAdapter({ region: 'eu-west-1' });
        const client = (adapter as unknown as { client: BedrockRuntimeClient }).client;
        const resolvedRegion = await client.config.region();

        expect(resolvedRegion).toBe('eu-west-1');
      });
    });

    describe('isAvailable()', () => {
      it('returns true when a custom client is injected or available option is true', async () => {
        const mockClient = { send: vi.fn() } as unknown as BedrockRuntimeClient;
        const adapterWithClient = new AwsBedrockHarnessAdapter({ client: mockClient });
        expect(await adapterWithClient.isAvailable()).toBe(true);

        const adapterWithAvail = new AwsBedrockHarnessAdapter({ available: true });
        expect(await adapterWithAvail.isAvailable()).toBe(true);
      });

      it('returns false when available option is explicitly false without custom client', async () => {
        const adapter = new AwsBedrockHarnessAdapter({ available: false });
        expect(await adapter.isAvailable()).toBe(false);
      });
    });
});
