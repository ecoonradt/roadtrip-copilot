import React from 'react';
import * as renderer from 'react-test-renderer';
import type { ReactTestRenderer, ReactTestInstance } from 'react-test-renderer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AwsBedrockHarnessAdapter,
  InvalidModelError,
  BEDROCK_MODEL_CATALOG,
  DEFAULT_BEDROCK_SCOUT_MODEL_ID,
  DEFAULT_BEDROCK_COPYWRITER_MODEL_ID,
  MAX_TOOL_ITERATIONS,
  MODEL_AVAILABILITY_TTL_MS,
  sanitizeBedrockResponse,
  formatBedrockToolLabel,
  toFoundationModelId,
} from '../../server/services/bedrockService.js';
import type { BedrockClient } from '@aws-sdk/client-bedrock';
import {
  AiService,
  type AiHarnessAdapter,
} from '../../server/services/aiService.js';
import { ScoutService } from '../../server/services/scoutService.js';
import { MalformedAiResponseError } from '../../server/services/schemaParser.js';
import { createApp } from '../../server/app.js';
import { chatWithScoutStream } from '../../src/services/api.js';
import { RouteScoutDrawer } from '../../src/components/RouteScoutDrawer.js';
import { EditWaypointModal } from '../../src/components/EditWaypointModal.js';
import { createItinerarySessionId } from '../../src/utils/itinerarySession.js';
import type {
  WaypointContext,
  ToolDeclaration,
} from '../../server/types/ai.js';
import type {
  ScoutChatRequest,
  ScoutTripContext,
  ScoutStreamEvent,
  ScoutChatResponse,
} from '../../server/types/scout.js';
import type { Waypoint } from '../../src/types/routing.js';
import type { ParsedTrip } from '../../src/engine/itineraryParser.js';
import {
  ConverseCommand,
  ConverseStreamCommand,
  type BedrockRuntimeClient,
  type ConverseStreamOutput,
} from '@aws-sdk/client-bedrock-runtime';

// Mock react-dom createPortal so modal renders inline under react-test-renderer
vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return {
    ...actual,
    createPortal: (children: React.ReactNode) => children,
  };
});

const act = renderer.act;
const create = renderer.create;

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

const sampleWaypointWithDetails: Waypoint = {
  id: 'wp_sedona_bell_rock',
  name: 'Sedona Red Rock Vistas (Bell Rock)',
  type: 'scenic_pull_off',
  lat: 34.8005,
  lng: -111.7667,
  target_time: '16:30:00',
  dwell_minutes: 20,
  trigger_radius_miles: 2.0,
  approachHighway: 'AZ-179 North',
  notes: 'Bell Rock scenic pull-off for red rock views',
  notification: {
    title: 'Bell Rock Vista Ahead',
    message: 'Arriving at Bell Rock. 20-min scenic stop.',
    speech: 'Approaching Bell Rock Scenic Vista on Highway 179.',
  },
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

const sampleTrip: ParsedTrip = {
  tripName: 'Phoenix to Sedona Scenic Run',
  days: [
    {
      dayNumber: 1,
      title: 'Day 1: Red Rock Scenic Byway',
      date: '2026-10-10',
      origin: 'Phoenix, AZ',
      destination: 'Sedona, AZ',
      departureTime: '08:00:00',
      waypoints: [sampleWaypointWithDetails],
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

describe('Adversarial Bedrock Adapter & Configurable Model Selection Suite', () => {
  describe('1. AwsBedrockHarnessAdapter Unit Tests (server/services/bedrockService.ts)', () => {
    describe('Catalog & Defaults (ADR-0010)', () => {
      it('verifies DEFAULT_BEDROCK_SCOUT_MODEL_ID and DEFAULT_BEDROCK_COPYWRITER_MODEL_ID match ADR-0010', () => {
        expect(DEFAULT_BEDROCK_SCOUT_MODEL_ID).toBe('us.moonshotai.kimi-k3');
        expect(DEFAULT_BEDROCK_COPYWRITER_MODEL_ID).toBe('us.amazon.nova-2-lite-v1:0');
        expect(MAX_TOOL_ITERATIONS).toBe(5);
      });

      it('verifies BEDROCK_MODEL_CATALOG contains 18 models with valid id, name, provider, description, and role', () => {
        expect(BEDROCK_MODEL_CATALOG).toHaveLength(18);

        for (const model of BEDROCK_MODEL_CATALOG) {
          expect(typeof model.id).toBe('string');
          expect(model.id.length).toBeGreaterThan(0);

          expect(typeof model.name).toBe('string');
          expect(model.name.length).toBeGreaterThan(0);

          expect(typeof model.provider).toBe('string');
          expect(model.provider.length).toBeGreaterThan(0);

          expect(typeof model.description).toBe('string');
          expect(model.description.length).toBeGreaterThan(0);

          expect(['scout', 'copywriter', 'both']).toContain(model.role);
        }

        // Verify key flagship defaults are present in catalog
        const scoutModel = BEDROCK_MODEL_CATALOG.find((m) => m.id === DEFAULT_BEDROCK_SCOUT_MODEL_ID);
        expect(scoutModel).toBeDefined();
        expect(scoutModel?.provider).toBe('Moonshot AI');

        const copywriterModel = BEDROCK_MODEL_CATALOG.find((m) => m.id === DEFAULT_BEDROCK_COPYWRITER_MODEL_ID);
        expect(copywriterModel).toBeDefined();
        expect(copywriterModel?.provider).toBe('Amazon');
      });

      it('getModelCatalog() returns complete catalog and active configured defaults', () => {
        const adapter = new AwsBedrockHarnessAdapter({
          scoutModelId: 'us.amazon.nova-pro-v1:0',
          copywriterModelId: 'us.amazon.nova-2-lite-v1:0',
        });

        const catalog = adapter.getModelCatalog();
        expect(catalog.models).toEqual(BEDROCK_MODEL_CATALOG);
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
        availableModels: BEDROCK_MODEL_CATALOG,
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
          availableModels: BEDROCK_MODEL_CATALOG,
          excludedModelIds: ['us.amazon.nova-pro-v1:0'],
        });
        await expect(adapterWithOptions.validateModelId('us.amazon.nova-pro-v1:0')).rejects.toThrow(InvalidModelError);
        await expect(adapterWithOptions.validateModelId('us.amazon.nova-pro-v1:0')).rejects.toThrow(/excluded by policy/);

        const prevEnv = process.env.BEDROCK_EXCLUDED_MODEL_IDS;
        try {
          process.env.BEDROCK_EXCLUDED_MODEL_IDS = 'us.moonshotai.kimi-k3, custom.excluded-model';
          const adapterWithEnv = new AwsBedrockHarnessAdapter({
            available: true,
            availableModels: BEDROCK_MODEL_CATALOG,
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
          availableModels: BEDROCK_MODEL_CATALOG,
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

    describe('sanitizeBedrockResponse & Tool Formatting Helpers', () => {
      it('strips closed and unclosed thinking tags and harness noise', () => {
        expect(
          sanitizeBedrockResponse(
            '<thinking>Reasoning here</thinking>Stop at Bell Rock for scenic views.'
          )
        ).toBe('Stop at Bell Rock for scenic views.');

        expect(
          sanitizeBedrockResponse(
            '<think>Reasoning here</think>Stop at Bell Rock for scenic views.'
          )
        ).toBe('Stop at Bell Rock for scenic views.');

        expect(
          sanitizeBedrockResponse(
            'Stop at Bell Rock for scenic views.<thinking>Unclosed internal thoughts...'
          )
        ).toBe('Stop at Bell Rock for scenic views.');

        expect(
          sanitizeBedrockResponse(
            'Wait for the background task to complete. Stop at Bell Rock.'
          )
        ).toBe('Stop at Bell Rock.');

        expect(
          sanitizeBedrockResponse(
            'Stop at Bell Rock.\n\nI have attached this as a candidate update.'
          )
        ).toBe('Stop at Bell Rock.');

        expect(
          sanitizeBedrockResponse(
            'Stop at Bell Rock scenic overlook.</thinking>'
          )
        ).toBe('Stop at Bell Rock scenic overlook.');

        expect(
          sanitizeBedrockResponse(
            'Stop at Bell Rock scenic overlook.</think>'
          )
        ).toBe('Stop at Bell Rock scenic overlook.');
      });

      it('formats tool labels correctly for search_web and read_url_content', () => {
        expect(formatBedrockToolLabel('search_web', { query: 'Sedona pull offs' }, false)).toBe(
          'Searching web: "Sedona pull offs"'
        );
        expect(formatBedrockToolLabel('search_web', { query: 'Sedona pull offs' }, true)).toBe(
          'Searched web for "Sedona pull offs"'
        );
        expect(formatBedrockToolLabel('search_web', {}, false)).toBe('Searching the web...');
        expect(formatBedrockToolLabel('search_web', {}, true)).toBe('Completed web search');

        expect(
          formatBedrockToolLabel('read_url_content', { Url: 'https://azdot.gov/sedona' }, false)
        ).toBe('Reading content from azdot.gov');
        expect(
          formatBedrockToolLabel('read_url_content', { Url: 'https://azdot.gov/sedona' }, true)
        ).toBe('Read content from azdot.gov');

        expect(formatBedrockToolLabel('calculate_detour', {}, false)).toBe(
          'Running calculate detour...'
        );
        expect(formatBedrockToolLabel('calculate_detour', {}, true)).toBe(
          'Completed calculate detour'
        );
      });
    });

    describe('generate() (ConverseCommand)', () => {
      it('sends ConverseCommand with defaultCopywriterModelId by default or normalized options.modelId', async () => {
        const mockSend = vi.fn().mockResolvedValue({
          output: {
            message: {
              content: [
                {
                  text: '{"title":"Bell Rock Ahead","message":"Scenic view","speech":"Approaching Bell Rock"}',
                },
              ],
            },
          },
        });

        const mockClient = { send: mockSend } as unknown as BedrockRuntimeClient;
        const adapter = new AwsBedrockHarnessAdapter({
          client: mockClient,
          availableModels: BEDROCK_MODEL_CATALOG,
        });

        // 1. Default model call
        const resDefault = await adapter.generate('Generate alert prompt');
        expect(resDefault).toContain('Bell Rock Ahead');
        expect(mockSend).toHaveBeenCalledTimes(1);
        const firstCallCommand = mockSend.mock.calls[0][0] as ConverseCommand;
        expect(firstCallCommand.input.modelId).toBe('us.amazon.nova-2-lite-v1:0');

        // 2. Custom model call with alias normalization
        await adapter.generate('Generate alert prompt', {
          modelId: 'amazon.nova-pro-v1:0',
        });
        expect(mockSend).toHaveBeenCalledTimes(2);
        const secondCallCommand = mockSend.mock.calls[1][0] as ConverseCommand;
        expect(secondCallCommand.input.modelId).toBe('us.amazon.nova-pro-v1:0');
      });

      it('strips <thinking> tags from returned text via sanitizeBedrockResponse', async () => {
        const mockSend = vi.fn().mockResolvedValue({
          output: {
            message: {
              content: [
                {
                  text: '<thinking>Internal thought chain</thinking>Scenic overlook alert: Bell Rock.',
                },
              ],
            },
          },
        });

        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
          availableModels: BEDROCK_MODEL_CATALOG,
        });

        const res = await adapter.generate('Alert prompt');
        expect(res).toBe('Scenic overlook alert: Bell Rock.');
        expect(res).not.toContain('<thinking>');
        expect(res).not.toContain('Internal thought chain');
      });

      it('throws an error if Bedrock returns empty text content', async () => {
        const mockSend = vi.fn().mockResolvedValue({
          output: {
            message: {
              content: [],
            },
          },
        });

        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
          availableModels: BEDROCK_MODEL_CATALOG,
        });

        await expect(adapter.generate('Prompt')).rejects.toThrow(
          'AI provider returned an empty response'
        );
      });

      it('throws MalformedAiResponseError when stopReason is max_tokens', async () => {
        const mockSend = vi.fn().mockResolvedValue({
          stopReason: 'max_tokens',
          output: {
            message: {
              content: [{ text: 'Truncated alert copy...' }],
            },
          },
        });

        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
          availableModels: BEDROCK_MODEL_CATALOG,
        });

        await expect(adapter.generate('Prompt')).rejects.toThrow(MalformedAiResponseError);
        await expect(adapter.generate('Prompt')).rejects.toThrow(/max_tokens/);
      });

      it('throws MalformedAiResponseError when stopReason is content_filtered', async () => {
        const mockSend = vi.fn().mockResolvedValue({
          stopReason: 'content_filtered',
          output: {
            message: {
              content: [{ text: 'Blocked content...' }],
            },
          },
        });

        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
          availableModels: BEDROCK_MODEL_CATALOG,
        });

        await expect(adapter.generate('Prompt')).rejects.toThrow(MalformedAiResponseError);
        await expect(adapter.generate('Prompt')).rejects.toThrow(/content_filtered/);
      });
    });

    describe('generateStreamWithTools() (ConverseStreamCommand)', () => {
      it('Single-turn streaming + reasoning & split <thinking> tag hygiene', async () => {
        const streamChunks: ConverseStreamOutput[] = [
          {
            contentBlockDelta: {
              delta: { reasoningContent: { text: 'Internal chain of thought' } },
            },
          },
          {
            contentBlockDelta: {
              delta: { text: '<thi' },
            },
          },
          {
            contentBlockDelta: {
              delta: { text: 'nking>Secret Nova reasoning</thinking>Hello ' },
            },
          },
          {
            contentBlockDelta: {
              delta: { text: 'driver!' },
            },
          },
          {
            messageStop: {
              stopReason: 'end_turn',
            },
          },
          {
            metadata: {
              usage: { inputTokens: 120, outputTokens: 45 },
            },
          },
        ];

        const mockSend = vi.fn().mockResolvedValue({
          stream: createAsyncStream(streamChunks),
        });

        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
          availableModels: BEDROCK_MODEL_CATALOG,
        });

        const emittedEvents: ScoutStreamEvent[] = [];
        const result = await adapter.generateStreamWithTools(
          'Audit prompt',
          [],
          vi.fn(),
          (evt) => emittedEvents.push(evt)
        );

        // 1. Verify thought event was emitted for reasoningContent
        const thoughtEvents = emittedEvents.filter((e) => e.event === 'thought');
        expect(thoughtEvents).toHaveLength(1);
        expect(thoughtEvents[0].data.text).toBe('Reasoning through route options...');

        // 2. Verify delta chunks concatenated equal 'Hello driver!' without leaking '<thi' or reasoning
        const deltaEvents = emittedEvents.filter((e) => e.event === 'delta');
        const concatenatedDelta = deltaEvents.map((e) => e.data.text).join('');
        expect(concatenatedDelta).toBe('Hello driver!');
        expect(concatenatedDelta).not.toContain('<thi');
        expect(concatenatedDelta).not.toContain('Secret Nova reasoning');

        // 3. Verify final result tokens and text
        expect(result).toEqual({
          text: 'Hello driver!',
          inputTokens: 120,
          outputTokens: 45,
        });
      });

      it('Multi-turn parallel tool execution loop (Promise.all)', async () => {
        // Turn 1 stream: requests two tools in parallel
        const turn1Stream: ConverseStreamOutput[] = [
          {
            contentBlockStart: {
              contentBlockIndex: 0,
              start: { toolUse: { toolUseId: 'call_1', name: 'search_web' } },
            },
          },
          {
            contentBlockDelta: {
              contentBlockIndex: 0,
              delta: { toolUse: { input: '{"query":"Sedona pull offs"}' } },
            },
          },
          {
            contentBlockStart: {
              contentBlockIndex: 1,
              start: { toolUse: { toolUseId: 'call_2', name: 'read_url_content' } },
            },
          },
          {
            contentBlockDelta: {
              contentBlockIndex: 1,
              delta: { toolUse: { input: '{"Url":"https://azdot.gov/sedona"}' } },
            },
          },
          {
            messageStop: { stopReason: 'tool_use' },
          },
          {
            metadata: { usage: { inputTokens: 100, outputTokens: 50 } },
          },
        ];

        // Turn 2 stream: returns final answer
        const turn2Stream: ConverseStreamOutput[] = [
          {
            contentBlockDelta: {
              delta: { text: 'Found great pull-offs on AZ-179.' },
            },
          },
          {
            messageStop: { stopReason: 'end_turn' },
          },
          {
            metadata: { usage: { inputTokens: 200, outputTokens: 80 } },
          },
        ];

        const mockSend = vi
          .fn()
          .mockResolvedValueOnce({ stream: createAsyncStream(turn1Stream) })
          .mockResolvedValueOnce({ stream: createAsyncStream(turn2Stream) });

        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
          availableModels: BEDROCK_MODEL_CATALOG,
        });

        const mockDispatcher = vi.fn().mockImplementation(async (name: string, args: Record<string, unknown>) => {
          if (name === 'search_web') return { results: ['Bell Rock vista pull-off'] };
          if (name === 'read_url_content') return { content: 'AZDOT scenic highway 179 guide' };
          return {};
        });

        const emittedEvents: ScoutStreamEvent[] = [];
        const result = await adapter.generateStreamWithTools(
          'Find scenic pull offs',
          sampleTools,
          mockDispatcher,
          (evt) => emittedEvents.push(evt)
        );

        // Verify dispatcher was invoked for both tools in parallel
        expect(mockDispatcher).toHaveBeenCalledTimes(2);
        expect(mockDispatcher).toHaveBeenCalledWith('search_web', { query: 'Sedona pull offs' });
        expect(mockDispatcher).toHaveBeenCalledWith('read_url_content', {
          Url: 'https://azdot.gov/sedona',
        });

        // Verify activity events (state: 'active' then state: 'done' with durationSeconds)
        const activityEvents = emittedEvents.filter((e) => e.event === 'activity');
        expect(activityEvents.length).toBe(4); // 2 active + 2 done

        const activeCalls = activityEvents.filter((e) => e.data.state === 'active');
        expect(activeCalls.map((a) => a.data.id)).toEqual(['call_1', 'call_2']);

        const doneCalls = activityEvents.filter((e) => e.data.state === 'done');
        expect(doneCalls.map((d) => d.data.id)).toEqual(['call_1', 'call_2']);
        expect(doneCalls[0].data.durationSeconds).toBeGreaterThanOrEqual(0);
        expect(doneCalls[1].data.durationSeconds).toBeGreaterThanOrEqual(0);

        // Verify Turn 2 ConverseStreamCommand messages
        expect(mockSend).toHaveBeenCalledTimes(2);
        const turn2Command = mockSend.mock.calls[1][0] as ConverseStreamCommand;
        const messages = turn2Command.input.messages!;
        expect(messages).toHaveLength(3); // user prompt -> assistant toolUse -> user toolResult

        const assistantMsg = messages[1];
        expect(assistantMsg.role).toBe('assistant');
        expect(assistantMsg.content).toEqual([
          {
            toolUse: {
              toolUseId: 'call_1',
              name: 'search_web',
              input: { query: 'Sedona pull offs' },
            },
          },
          {
            toolUse: {
              toolUseId: 'call_2',
              name: 'read_url_content',
              input: { Url: 'https://azdot.gov/sedona' },
            },
          },
        ]);

        const userToolResultMsg = messages[2];
        expect(userToolResultMsg.role).toBe('user');
        expect(userToolResultMsg.content).toEqual([
          {
            toolResult: {
              toolUseId: 'call_1',
              content: [{ json: { results: ['Bell Rock vista pull-off'] } }],
              status: 'success',
            },
          },
          {
            toolResult: {
              toolUseId: 'call_2',
              content: [{ json: { content: 'AZDOT scenic highway 179 guide' } }],
              status: 'success',
            },
          },
        ]);

        // Verify cumulative tokens: 100+200=300 input, 50+80=130 output
        expect(result).toEqual({
          text: 'Found great pull-offs on AZ-179.',
          inputTokens: 300,
          outputTokens: 130,
        });
      });

      it('Tool dispatcher error recovery: catches errors, emits state: error, and recovers in Turn 2', async () => {
        const turn1Stream: ConverseStreamOutput[] = [
          {
            contentBlockStart: {
              contentBlockIndex: 0,
              start: { toolUse: { toolUseId: 'call_err', name: 'search_web' } },
            },
          },
          {
            contentBlockDelta: {
              contentBlockIndex: 0,
              delta: { toolUse: { input: '{"query":"Corridor audit"}' } },
            },
          },
          {
            messageStop: { stopReason: 'tool_use' },
          },
        ];

        const turn2Stream: ConverseStreamOutput[] = [
          {
            contentBlockDelta: {
              delta: { text: 'Recovered from search error. Continuing with route audit.' },
            },
          },
          {
            messageStop: { stopReason: 'end_turn' },
          },
        ];

        const mockSend = vi
          .fn()
          .mockResolvedValueOnce({ stream: createAsyncStream(turn1Stream) })
          .mockResolvedValueOnce({ stream: createAsyncStream(turn2Stream) });

        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
          availableModels: BEDROCK_MODEL_CATALOG,
        });

        const failingDispatcher = vi.fn().mockRejectedValue(new Error('Search API 503'));
        const emittedEvents: ScoutStreamEvent[] = [];

        const result = await adapter.generateStreamWithTools(
          'Audit prompt',
          sampleTools,
          failingDispatcher,
          (evt) => emittedEvents.push(evt)
        );

        // Verify activity error event was emitted
        const errActivity = emittedEvents.find(
          (e) => e.event === 'activity' && e.data.state === 'error'
        );
        expect(errActivity).toBeDefined();
        expect(errActivity?.data.id).toBe('call_err');

        // Verify Turn 2 received toolResult with status: 'error' and error message
        const turn2Command = mockSend.mock.calls[1][0] as ConverseStreamCommand;
        const userMsg = turn2Command.input.messages![2];
        expect(userMsg.content).toEqual([
          {
            toolResult: {
              toolUseId: 'call_err',
              content: [{ json: { error: 'Search API 503' } }],
              status: 'error',
            },
          },
        ]);

        expect(result.text).toBe('Recovered from search error. Continuing with route audit.');
      });

      it('MAX_TOOL_ITERATIONS = 5 loop cap: throws explicit error after 5 iterations', async () => {
        const loopingToolStream: ConverseStreamOutput[] = [
          {
            contentBlockStart: {
              contentBlockIndex: 0,
              start: { toolUse: { toolUseId: 'loop_call', name: 'search_web' } },
            },
          },
          {
            contentBlockDelta: {
              contentBlockIndex: 0,
              delta: { toolUse: { input: '{"query":"infinite loop"}' } },
            },
          },
          {
            messageStop: { stopReason: 'tool_use' },
          },
        ];

        const mockSend = vi.fn().mockImplementation(async () => ({
          stream: createAsyncStream(loopingToolStream),
        }));

        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
          availableModels: BEDROCK_MODEL_CATALOG,
        });

        const mockDispatcher = vi.fn().mockResolvedValue({ status: 'ok' });

        await expect(
          adapter.generateStreamWithTools(
            'Loop prompt',
            sampleTools,
            mockDispatcher,
            () => {}
          )
        ).rejects.toThrow('Route Scout exceeded maximum tool iterations (5)');

        expect(mockSend).toHaveBeenCalledTimes(5);
      });

      it('AbortSignal mid-stream cancellation: rejects immediately with "Request aborted"', async () => {
        const abortController = new AbortController();

        // Stream that triggers abort during consumption
        async function* createAbortStream(): AsyncIterable<ConverseStreamOutput> {
          yield { contentBlockDelta: { delta: { text: 'Starting analysis...' } } };
          abortController.abort();
          yield { contentBlockDelta: { delta: { text: 'More analysis...' } } };
        }

        const mockSend = vi.fn().mockResolvedValue({
          stream: createAbortStream(),
        });

        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
          availableModels: BEDROCK_MODEL_CATALOG,
        });

        await expect(
          adapter.generateStreamWithTools(
            'Abort prompt',
            [],
            vi.fn(),
            () => {},
            { abortSignal: abortController.signal }
          )
        ).rejects.toThrow('Request aborted');
      });

      it('throws MalformedAiResponseError when messageStop.stopReason is max_tokens', async () => {
        const streamChunks: ConverseStreamOutput[] = [
          { contentBlockDelta: { delta: { text: 'Starting route analysis...' } } },
          { messageStop: { stopReason: 'max_tokens' } },
        ];
        const mockSend = vi.fn().mockImplementation(() => ({
          stream: createAsyncStream(streamChunks),
        }));
        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
          availableModels: BEDROCK_MODEL_CATALOG,
        });

        await expect(
          adapter.generateStreamWithTools('Prompt', [], vi.fn(), vi.fn())
        ).rejects.toThrow(MalformedAiResponseError);
        await expect(
          adapter.generateStreamWithTools('Prompt', [], vi.fn(), vi.fn())
        ).rejects.toThrow(/max_tokens/);
      });

      it('throws MalformedAiResponseError when messageStop.stopReason is content_filtered', async () => {
        const streamChunks: ConverseStreamOutput[] = [
          { contentBlockDelta: { delta: { text: 'Inappropriate content...' } } },
          { messageStop: { stopReason: 'content_filtered' } },
        ];
        const mockSend = vi.fn().mockImplementation(() => ({
          stream: createAsyncStream(streamChunks),
        }));
        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
          availableModels: BEDROCK_MODEL_CATALOG,
        });

        await expect(
          adapter.generateStreamWithTools('Prompt', [], vi.fn(), vi.fn())
        ).rejects.toThrow(MalformedAiResponseError);
        await expect(
          adapter.generateStreamWithTools('Prompt', [], vi.fn(), vi.fn())
        ).rejects.toThrow(/content_filtered/);
      });

      it('throws MalformedAiResponseError when stream ends without a terminal messageStop', async () => {
        const streamChunks: ConverseStreamOutput[] = [
          { contentBlockDelta: { delta: { text: 'Incomplete stream truncated abruptly' } } },
        ];
        const mockSend = vi.fn().mockImplementation(() => ({
          stream: createAsyncStream(streamChunks),
        }));
        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
          availableModels: BEDROCK_MODEL_CATALOG,
        });

        await expect(
          adapter.generateStreamWithTools('Prompt', [], vi.fn(), vi.fn())
        ).rejects.toThrow(MalformedAiResponseError);
        await expect(
          adapter.generateStreamWithTools('Prompt', [], vi.fn(), vi.fn())
        ).rejects.toThrow(/without a terminal message/);
      });

      it('throws MalformedAiResponseError when stopReason is tool_use but no tool calls were emitted', async () => {
        const streamChunks: ConverseStreamOutput[] = [
          { contentBlockDelta: { delta: { text: 'I will call a tool now.' } } },
          { messageStop: { stopReason: 'tool_use' } },
        ];
        const mockSend = vi.fn().mockImplementation(() => ({
          stream: createAsyncStream(streamChunks),
        }));
        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
          availableModels: BEDROCK_MODEL_CATALOG,
        });

        await expect(
          adapter.generateStreamWithTools('Prompt', [], vi.fn(), vi.fn())
        ).rejects.toThrow(MalformedAiResponseError);
        await expect(
          adapter.generateStreamWithTools('Prompt', [], vi.fn(), vi.fn())
        ).rejects.toThrow(/emitted no executable tool calls/);
      });
    });
  });

  describe('2. Fastify Endpoints, AiService & ScoutService Integration Tests', () => {
    it('GET /api/ai/status returns available: true, engine: "bedrock", 18 models, and ADR-0010 defaults', async () => {
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string; byOutputModality?: string; typeEquals?: string } }) => {
          if (cmd.input?.byOutputModality === 'TEXT') {
            return {
              modelSummaries: BEDROCK_MODEL_CATALOG.map((model) => ({
                modelId: toFoundationModelId(model.id),
                modelName: model.name,
                providerName: model.provider,
                inputModalities: ['TEXT'],
                outputModalities: ['TEXT'],
                responseStreamingSupported: model.role === 'scout' || model.role === 'both',
                modelLifecycle: { status: 'ACTIVE' },
              })),
            };
          }
          if (cmd.input?.typeEquals === 'SYSTEM_DEFINED' || !cmd.input?.modelId) {
            return {
              inferenceProfileSummaries: BEDROCK_MODEL_CATALOG.map((model) => ({
                inferenceProfileId: model.id,
                status: 'ACTIVE',
                type: 'SYSTEM_DEFINED',
                models: [{ modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${toFoundationModelId(model.id)}` }],
              })),
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
      const mockBedrockAdapter = new AwsBedrockHarnessAdapter({
        available: true,
        controlClient: mockControlClient as unknown as BedrockClient,
        client: { send: vi.fn() } as unknown as BedrockRuntimeClient,
      });

      const aiService = new AiService({ adapters: [mockBedrockAdapter] });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({
        method: 'GET',
        url: '/api/ai/status',
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.available).toBe(true);
      expect(data.engine).toBe('bedrock');
      expect(data.models).toHaveLength(18);
      expect(data.defaultScoutModelId).toBe('us.moonshotai.kimi-k3');
      expect(data.defaultCopywriterModelId).toBe('us.amazon.nova-2-lite-v1:0');
    });

    it('POST /api/copilot/generate uses Bedrock when available and forwards normalized modelId', async () => {
      const mockGenerate = vi.fn().mockResolvedValue(
        JSON.stringify({
          title: 'Sedona Red Rocks Ahead',
          message: 'Target arrival: 4:30 PM.\nRecommended stop.',
          speech: 'Upcoming sight on your right: Bell Rock.',
          recommended_trigger_radius_miles: 2.0,
        })
      );

      const mockBedrockAdapter: AiHarnessAdapter = {
        id: 'bedrock',
        name: 'Amazon Bedrock',
        getAvailableModels: async () => BEDROCK_MODEL_CATALOG,
        getModelCatalog: () => ({
          models: BEDROCK_MODEL_CATALOG,
          defaultScoutModelId: 'us.moonshotai.kimi-k3',
          defaultCopywriterModelId: 'us.amazon.nova-2-lite-v1:0',
        }),
        decorateScoutPrompt: (prompt: string) => prompt,
        sanitizeResponse: (text: string) => text,
        isAvailable: vi.fn().mockResolvedValue(true),
        generate: mockGenerate,
        validateModelId: (m: string) =>
          new AwsBedrockHarnessAdapter({
            available: true,
            availableModels: BEDROCK_MODEL_CATALOG,
          }).validateModelId(m),
      };

      const aiService = new AiService({ adapters: [mockBedrockAdapter] });
      const app = createApp({ logger: false, aiService });

      // Single waypoint generation with model alias
      const resSingle = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoint: sampleWaypoint,
          modelId: 'amazon.nova-2-lite-v1:0',
        },
      });

      expect(resSingle.statusCode).toBe(200);
      const singleData = resSingle.json();
      expect(singleData.engine).toBe('bedrock');
      expect(singleData.title).toBe('Sedona Red Rocks Ahead');
      expect(mockGenerate).toHaveBeenCalledTimes(1);
      expect(mockGenerate.mock.calls[0][1]).toEqual(
        expect.objectContaining({
          modelId: 'us.amazon.nova-2-lite-v1:0',
        })
      );

      // Batch waypoints generation
      mockGenerate.mockResolvedValueOnce(
        JSON.stringify({
          wp_sedona_bell_rock: {
            title: 'Batch Bell Rock',
            message: 'Batch message',
            speech: 'Batch speech',
            recommended_trigger_radius_miles: 2.5,
          },
        })
      );

      const resBatch = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoints: [sampleWaypoint],
          modelId: 'amazon.nova-2-lite-v1:0',
        },
      });

      expect(resBatch.statusCode).toBe(200);
      const batchData = resBatch.json();
      expect(batchData.engine).toBe('bedrock');
      expect(batchData.alerts.wp_sedona_bell_rock.title).toBe('Batch Bell Rock');
      expect(mockGenerate.mock.calls[1][1]).toEqual(
        expect.objectContaining({
          modelId: 'us.amazon.nova-2-lite-v1:0',
        })
      );
    });

    it('POST /api/copilot/day-title uses Bedrock and forwards normalized modelId', async () => {
      const mockGenerate = vi.fn().mockResolvedValue(
        JSON.stringify({
          title: 'Red Rock Canyon Odyssey',
        })
      );

      const mockBedrockAdapter: AiHarnessAdapter = {
        id: 'bedrock',
        name: 'Amazon Bedrock',
        getAvailableModels: async () => BEDROCK_MODEL_CATALOG,
        getModelCatalog: () => ({
          models: BEDROCK_MODEL_CATALOG,
          defaultScoutModelId: 'us.moonshotai.kimi-k3',
          defaultCopywriterModelId: 'us.amazon.nova-2-lite-v1:0',
        }),
        decorateScoutPrompt: (prompt: string) => prompt,
        sanitizeResponse: (text: string) => text,
        isAvailable: vi.fn().mockResolvedValue(true),
        generate: mockGenerate,
        validateModelId: (m: string) =>
          new AwsBedrockHarnessAdapter({
            available: true,
            availableModels: BEDROCK_MODEL_CATALOG,
          }).validateModelId(m),
      };

      const aiService = new AiService({ adapters: [mockBedrockAdapter] });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({
        method: 'POST',
        url: '/api/copilot/day-title',
        payload: {
          dayNumber: 1,
          stops: [{ name: 'Phoenix' }, { name: 'Sedona' }],
          modelId: 'amazon.nova-2-lite-v1:0',
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.engine).toBe('bedrock');
      expect(data.title).toBe('Red Rock Canyon Odyssey');
      expect(mockGenerate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          modelId: 'us.amazon.nova-2-lite-v1:0',
        })
      );
    });

    it('POST /api/copilot/generate and /day-title return HTTP 400 when modelId is unknown or empty', async () => {
      const mockBedrockAdapter = new AwsBedrockHarnessAdapter({
        available: true,
        availableModels: BEDROCK_MODEL_CATALOG,
      });
      const aiService = new AiService({ adapters: [mockBedrockAdapter] });
      const app = createApp({ logger: false, aiService });

      // 1. Single waypoint with unknown modelId
      const resUnknownSingle = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoint: sampleWaypoint,
          modelId: 'bad-model',
        },
      });
      expect(resUnknownSingle.statusCode).toBe(400);
      expect(resUnknownSingle.json().error).toContain('Unsupported');

      // 2. Single waypoint with empty modelId
      const resEmptySingle = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoint: sampleWaypoint,
          modelId: '',
        },
      });
      expect(resEmptySingle.statusCode).toBe(400);
      expect(resEmptySingle.json().error).toContain('Model ID must not be empty');

      // 3. Batch waypoints with bad modelId
      const resBadBatch = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoints: [sampleWaypoint],
          modelId: 'bad-model',
        },
      });
      expect(resBadBatch.statusCode).toBe(400);

      // 4. Day title with bad modelId
      const resBadTitle = await app.inject({
        method: 'POST',
        url: '/api/copilot/day-title',
        payload: {
          dayNumber: 1,
          stops: [{ name: 'Phoenix' }],
          modelId: 'bad-model',
        },
      });
      expect(resBadTitle.statusCode).toBe(400);
    });

    it('POST /api/ai/scout/chat and chat/stream return HTTP 400 when modelId is unknown or empty', async () => {
      const mockBedrockAdapter = new AwsBedrockHarnessAdapter({
        available: true,
        availableModels: BEDROCK_MODEL_CATALOG,
      });
      const aiService = new AiService({ adapters: [mockBedrockAdapter] });
      const scoutService = new ScoutService(aiService);
      const app = createApp({ logger: false, aiService, scoutService });

      // 1. Non-streaming chat with bad modelId
      const resBadChat = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat',
        payload: {
          scope: { type: 'day', dayNumber: 1 },
          messages: [{ role: 'user', content: 'Audit my route' }],
          tripContext: sampleTripContext,
          modelId: 'bad-model',
        },
      });
      expect(resBadChat.statusCode).toBe(400);
      expect(resBadChat.json().error).toContain('Unsupported');

      // 2. Non-streaming chat with empty modelId
      const resEmptyChat = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat',
        payload: {
          scope: { type: 'day', dayNumber: 1 },
          messages: [{ role: 'user', content: 'Audit my route' }],
          tripContext: sampleTripContext,
          modelId: '',
        },
      });
      expect(resEmptyChat.statusCode).toBe(400);

      // 3. Streaming chat with bad modelId
      const resBadStream = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat/stream',
        payload: {
          scope: { type: 'day', dayNumber: 1 },
          messages: [{ role: 'user', content: 'Audit my route' }],
          tripContext: sampleTripContext,
          modelId: 'bad-model',
        },
      });
      expect(resBadStream.statusCode).toBe(400);
      expect(resBadStream.json().error).toContain('Unsupported');

      // 4. Streaming chat with empty modelId
      const resEmptyStream = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat/stream',
        payload: {
          scope: { type: 'day', dayNumber: 1 },
          messages: [{ role: 'user', content: 'Audit my route' }],
          tripContext: sampleTripContext,
          modelId: '',
        },
      });
      expect(resEmptyStream.statusCode).toBe(400);
    });

    it('POST /api/ai/scout/chat/stream emits : ping, periodic : keep-alive, event: delta, and event: done', async () => {
      // Mock Bedrock adapter where generateStreamWithTools delays 40ms to trigger keep-alive timer at 15ms interval
      const mockBedrockAdapter: AiHarnessAdapter = {
        id: 'bedrock',
        name: 'Amazon Bedrock',
        getAvailableModels: async () => BEDROCK_MODEL_CATALOG,
        getModelCatalog: () => ({
          models: BEDROCK_MODEL_CATALOG,
          defaultScoutModelId: 'us.moonshotai.kimi-k3',
          defaultCopywriterModelId: 'us.amazon.nova-2-lite-v1:0',
        }),
        decorateScoutPrompt: (prompt: string) => prompt,
        sanitizeResponse: (text: string) => text,
        isAvailable: vi.fn().mockResolvedValue(true),
        generate: vi.fn(),
        validateModelId: (m: string) =>
          new AwsBedrockHarnessAdapter({
            available: true,
            availableModels: BEDROCK_MODEL_CATALOG,
          }).validateModelId(m),
        generateStreamWithTools: vi.fn().mockImplementation(
          async (_prompt, _tools, _dispatcher, onChunk) => {
            // Wait 40ms so that keepAliveIntervalMs: 15 fires keep-alive comments
            await new Promise((resolve) => setTimeout(resolve, 40));
            onChunk({
              event: 'delta',
              data: { text: '### Route Analysis\n\nSedona corridor looks clear.' },
            });
            return {
              text: '### Route Analysis\n\nSedona corridor looks clear.',
              inputTokens: 150,
              outputTokens: 60,
            };
          }
        ),
      };

      const aiService = new AiService({ adapters: [mockBedrockAdapter] });
      const scoutService = new ScoutService({ aiService });

      const app = createApp({
        logger: false,
        aiService,
        scoutService,
        keepAliveIntervalMs: 15,
      });
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

      const res = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat/stream',
        payload: {
          scope: { type: 'day', dayNumber: 1 },
          messages: [{ role: 'user', content: 'Audit Sedona stops' }],
          tripContext: sampleTripContext,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');

      const body = res.body;

      // 1. Must start with immediate ping
      expect(body.startsWith(': ping\n\n')).toBe(true);

      // 2. Must contain at least one periodic keep-alive heartbeat comment
      expect(body).toContain(': keep-alive\n\n');

      // 3. Must contain delta event
      expect(body).toContain('event: delta\n');
      expect(body).toContain('Sedona corridor looks clear.');

      // 4. Must contain done event with engine: "bedrock"
      expect(body).toContain('event: done\n');
      expect(body).toContain('"engine":"bedrock"');

      // 5. Keep-alive timer is cleared when the stream completes
      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });

    it('POST /api/ai/scout/chat/stream emits a single event: error without duplication on failure', async () => {
      const mockBedrockAdapter: AiHarnessAdapter = {
        id: 'bedrock',
        name: 'Amazon Bedrock',
        getAvailableModels: async () => BEDROCK_MODEL_CATALOG,
        getModelCatalog: () => ({
          models: BEDROCK_MODEL_CATALOG,
          defaultScoutModelId: 'us.moonshotai.kimi-k3',
          defaultCopywriterModelId: 'us.amazon.nova-2-lite-v1:0',
        }),
        decorateScoutPrompt: (prompt: string) => prompt,
        sanitizeResponse: (text: string) => text,
        isAvailable: vi.fn().mockResolvedValue(true),
        generate: vi.fn(),
        validateModelId: (m: string) =>
          new AwsBedrockHarnessAdapter({
            available: true,
            availableModels: BEDROCK_MODEL_CATALOG,
          }).validateModelId(m),
        generateStreamWithTools: vi.fn().mockRejectedValue(new Error('ValidationException: Error 002')),
      };

      const aiService = new AiService({ adapters: [mockBedrockAdapter] });
      const scoutService = new ScoutService(aiService);
      const app = createApp({ logger: false, scoutService });
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/ai/scout/chat/stream',
          payload: {
            scope: { type: 'day', dayNumber: 1 },
            messages: [{ role: 'user', content: 'Audit Sedona stops' }],
            tripContext: sampleTripContext,
          },
        });

        expect(res.statusCode).toBe(200);
        const body = res.body;
        const errorMatches = body.match(/event: error/g);
        expect(errorMatches).toHaveLength(1);
        expect(body).toContain('ValidationException: Error 002');
        expect(clearIntervalSpy).toHaveBeenCalled();
      } finally {
        clearIntervalSpy.mockRestore();
      }
    });

    it('aborts upstream work and clears the keep-alive timer when the client disconnects', async () => {
      let capturedSignal: AbortSignal | undefined;
      const mockBedrockAdapter: AiHarnessAdapter = {
        id: 'bedrock',
        name: 'Amazon Bedrock',
        getAvailableModels: async () => BEDROCK_MODEL_CATALOG,
        getModelCatalog: () => ({
          models: BEDROCK_MODEL_CATALOG,
          defaultScoutModelId: 'us.moonshotai.kimi-k3',
          defaultCopywriterModelId: 'us.amazon.nova-2-lite-v1:0',
        }),
        decorateScoutPrompt: (prompt: string) => prompt,
        sanitizeResponse: (text: string) => text,
        isAvailable: vi.fn().mockResolvedValue(true),
        generate: vi.fn(),
        validateModelId: (m: string) =>
          new AwsBedrockHarnessAdapter({
            available: true,
            availableModels: BEDROCK_MODEL_CATALOG,
          }).validateModelId(m),
        generateStreamWithTools: vi.fn().mockImplementation(
          (
            _prompt: string,
            _tools: unknown,
            _dispatcher: unknown,
            _onChunk: unknown,
            options?: { abortSignal?: AbortSignal }
          ) =>
            new Promise((_resolve, reject) => {
              capturedSignal = options?.abortSignal;
              options?.abortSignal?.addEventListener('abort', () =>
                reject(new Error('Request aborted'))
              );
            })
        ),
      };

      const aiService = new AiService({ adapters: [mockBedrockAdapter] });
      const scoutService = new ScoutService(aiService);
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      const app = createApp({
        logger: false,
        aiService,
        scoutService,
        keepAliveIntervalMs: 10,
      });
      await app.listen({ port: 0, host: '127.0.0.1' });

      try {
        const address = app.server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const abortController = new AbortController();
        const res = await fetch(`http://127.0.0.1:${port}/api/ai/scout/chat/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: { type: 'day', dayNumber: 1 },
            messages: [{ role: 'user', content: 'Audit Sedona stops' }],
            tripContext: sampleTripContext,
          }),
          signal: abortController.signal,
        });
        expect(res.status).toBe(200);

        const reader = res.body?.getReader();
        expect(reader).toBeDefined();
        await reader!.read(); // consume the immediate `: ping` frame

        for (let i = 0; i < 100 && !capturedSignal; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(capturedSignal).toBeDefined();
        expect(capturedSignal?.aborted).toBe(false);

        abortController.abort();
        await reader!.read().catch(() => undefined);

        for (let i = 0; i < 100 && !capturedSignal?.aborted; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(capturedSignal?.aborted).toBe(true);

        for (let i = 0; i < 100 && clearIntervalSpy.mock.calls.length === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(clearIntervalSpy).toHaveBeenCalled();
      } finally {
        clearIntervalSpy.mockRestore();
        await app.close();
      }
    });

    it('AwsBedrockHarnessAdapter halts immediately and does not retry when abortSignal is aborted', async () => {
      const abortController = new AbortController();
      abortController.abort();

      const adapter = new AwsBedrockHarnessAdapter({
        client: {
          send: vi.fn(),
        } as unknown as BedrockRuntimeClient,
      });

      await expect(
        adapter.generate('Test prompt', { abortSignal: abortController.signal })
      ).rejects.toThrow('Request aborted');

      await expect(
        adapter.generateStreamWithTools(
          'Test prompt',
          [],
          vi.fn(),
          vi.fn(),
          { abortSignal: abortController.signal }
        )
      ).rejects.toThrow('Request aborted');
    });

    it('maps inference profile IDs to foundation model IDs for availability checks', () => {
      expect(toFoundationModelId('us.moonshotai.kimi-k3')).toBe('moonshotai.kimi-k3');
      expect(toFoundationModelId('us.amazon.nova-2-lite-v1:0')).toBe('amazon.nova-2-lite-v1:0');
      expect(toFoundationModelId('eu.anthropic.claude-sonnet-4-6')).toBe('anthropic.claude-sonnet-4-6');
      expect(toFoundationModelId('apac.amazon.nova-pro-v1:0')).toBe('amazon.nova-pro-v1:0');
      expect(toFoundationModelId('deepseek.v3.2')).toBe('deepseek.v3.2');
    });

    it('filters the catalog using active inference profiles and foundation model availability', async () => {
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string; byOutputModality?: string } }) => {
          if (cmd.input?.byOutputModality === 'TEXT') {
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
                  modelId: 'amazon.nova-2-lite-v1:0',
                  modelName: 'Nova 2 Lite',
                  providerName: 'Amazon',
                  inputModalities: ['TEXT'],
                  outputModalities: ['TEXT'],
                  responseStreamingSupported: true,
                  modelLifecycle: { status: 'ACTIVE' },
                },
              ],
            };
          }
          const modelId = cmd.input?.modelId;
          if (!modelId) {
            return {
              inferenceProfileSummaries: [
                {
                  inferenceProfileId: 'us.moonshotai.kimi-k3',
                  status: 'ACTIVE',
                  type: 'SYSTEM_DEFINED',
                  models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/moonshotai.kimi-k3' }],
                },
                {
                  inferenceProfileId: 'us.amazon.nova-2-lite-v1:0',
                  status: 'ACTIVE',
                  type: 'SYSTEM_DEFINED',
                  models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-2-lite-v1:0' }],
                },
              ],
            };
          }
          if (modelId === 'moonshotai.kimi-k3' || modelId === 'amazon.nova-2-lite-v1:0') {
            return {
              authorizationStatus: 'AUTHORIZED',
              entitlementAvailability: 'AVAILABLE',
              regionAvailability: 'AVAILABLE',
              agreementAvailability: { status: 'AVAILABLE' },
            };
          }
          return {
            authorizationStatus: 'AUTHORIZED',
            entitlementAvailability: 'NOT_AVAILABLE',
            regionAvailability: 'AVAILABLE',
            agreementAvailability: { status: 'NOT_AVAILABLE' },
          };
        }),
      };

      const adapter = new AwsBedrockHarnessAdapter({
        controlClient: mockControlClient as unknown as BedrockClient,
        client: {} as unknown as BedrockRuntimeClient,
      });

      const available = await adapter.getAvailableModels();
      expect(available.map((m) => m.id)).toEqual([
        'us.moonshotai.kimi-k3',
        'us.amazon.nova-2-lite-v1:0',
      ]);
      expect(adapter.getModelCatalog().models).toHaveLength(2);

      // Availability is queried with the underlying foundation model ID, never the profile ID.
      const availabilityCalls = mockControlClient.send.mock.calls
        .map(([cmd]) => (cmd as { input?: { modelId?: string } }).input?.modelId)
        .filter((id): id is string => Boolean(id));
      expect(availabilityCalls).toContain('moonshotai.kimi-k3');
      expect(availabilityCalls).toContain('amazon.nova-2-lite-v1:0');
      expect(availabilityCalls).not.toContain('us.moonshotai.kimi-k3');
      expect(availabilityCalls).not.toContain('us.amazon.nova-2-lite-v1:0');
    });

    it('omits an inference profile that is missing from ListInferenceProfiles', async () => {
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string; byOutputModality?: string } }) => {
          if (cmd.input?.byOutputModality === 'TEXT') {
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
              ],
            };
          }
          const modelId = cmd.input?.modelId;
          if (!modelId) {
            return {
              inferenceProfileSummaries: [
                {
                  inferenceProfileId: 'us.moonshotai.kimi-k3',
                  status: 'ACTIVE',
                  type: 'SYSTEM_DEFINED',
                  models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/moonshotai.kimi-k3' }],
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

      const available = await adapter.getAvailableModels();
      const ids = available.map((m) => m.id);
      expect(ids).toContain('us.moonshotai.kimi-k3');
      expect(ids).not.toContain('us.amazon.nova-2-lite-v1:0');
      expect(ids).not.toContain('us.amazon.nova-pro-v1:0');
    });

    it('caches verified availability for the documented TTL', async () => {
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string; byOutputModality?: string } }) => {
          if (cmd.input?.byOutputModality === 'TEXT') {
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
              ],
            };
          }
          if (!cmd.input?.modelId) {
            return {
              inferenceProfileSummaries: [
                {
                  inferenceProfileId: 'us.moonshotai.kimi-k3',
                  status: 'ACTIVE',
                  type: 'SYSTEM_DEFINED',
                  models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/moonshotai.kimi-k3' }],
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

      await adapter.getAvailableModels();
      const callCountAfterFirstCheck = mockControlClient.send.mock.calls.length;

      await adapter.getAvailableModels();
      expect(mockControlClient.send).toHaveBeenCalledTimes(callCountAfterFirstCheck);

      const realNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(realNow + MODEL_AVAILABILITY_TTL_MS + 1);
      try {
        await adapter.getAvailableModels();
        expect(mockControlClient.send.mock.calls.length).toBeGreaterThan(callCountAfterFirstCheck);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('does not silently restore the hardcoded catalog when the availability API fails', async () => {
      const mockControlClient = {
        send: vi.fn().mockRejectedValue(new Error('AccessDeniedException: not authorized')),
      };

      const adapter = new AwsBedrockHarnessAdapter({
        controlClient: mockControlClient as unknown as BedrockClient,
        client: {} as unknown as BedrockRuntimeClient,
      });

      await expect(adapter.getAvailableModels()).rejects.toThrow('AccessDeniedException');
      expect(adapter.getModelCatalog().models).toHaveLength(18);
    });

    it('fails loudly when only a runtime client is injected and availability cannot be verified', async () => {
      const adapter = new AwsBedrockHarnessAdapter({
        client: { send: vi.fn() } as unknown as BedrockRuntimeClient,
      });

      await expect(adapter.getAvailableModels()).rejects.toThrow(
        'control-plane client is unavailable'
      );

      const aiService = new AiService({ adapters: [adapter] });
      const app = createApp({ logger: false, aiService });
      const res = await app.inject({ method: 'GET', url: '/api/ai/status' });
      const data = res.json<{ available: boolean; models?: unknown[]; message?: string }>();
      expect(data.available).toBe(false);
      expect(data.models).toBeUndefined();
      expect(data.message).toContain('control-plane client is unavailable');
    });

    it('surfaces the control-plane error when every availability check throws', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string; byOutputModality?: string } }) => {
          if (cmd.input?.byOutputModality === 'TEXT') {
            return {
              modelSummaries: [
                {
                  modelId: 'amazon.nova-2-lite-v1:0',
                  modelName: 'Amazon Nova 2 Lite',
                  providerName: 'Amazon',
                  inputModalities: ['TEXT'],
                  outputModalities: ['TEXT'],
                  responseStreamingSupported: true,
                  inferenceTypesSupported: ['ON_DEMAND'],
                },
              ],
            };
          }
          if (!cmd.input?.modelId) {
            return { inferenceProfileSummaries: [] };
          }
          throw new Error('ThrottlingException: too many requests');
        }),
      };

      const adapter = new AwsBedrockHarnessAdapter({
        controlClient: mockControlClient as unknown as BedrockClient,
        client: {} as unknown as BedrockRuntimeClient,
      });

      try {
        await expect(adapter.getAvailableModels()).rejects.toThrow('ThrottlingException');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('reports AI unavailable with the availability error instead of advertising unverified models', async () => {
      const mockControlClient = {
        send: vi.fn().mockRejectedValue(new Error('AccessDeniedException: not authorized')),
      };

      const adapter = new AwsBedrockHarnessAdapter({
        controlClient: mockControlClient as unknown as BedrockClient,
        client: {} as unknown as BedrockRuntimeClient,
      });
      const aiService = new AiService({ adapters: [adapter] });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({ method: 'GET', url: '/api/ai/status' });
      expect(res.statusCode).toBe(200);
      const data = res.json<{ available: boolean; models?: unknown[]; message?: string }>();
      expect(data.available).toBe(false);
      expect(data.models).toBeUndefined();
      expect(data.message).toContain('AccessDeniedException');
    });

    it('reports AI unavailable when no catalog models are accessible for the account', async () => {
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string } }) => {
          if (!cmd.input?.modelId) {
            return { inferenceProfileSummaries: [] };
          }
          return {
            authorizationStatus: 'NOT_AUTHORIZED',
            entitlementAvailability: 'NOT_AVAILABLE',
            regionAvailability: 'AVAILABLE',
            agreementAvailability: { status: 'NOT_AVAILABLE' },
          };
        }),
      };

      const adapter = new AwsBedrockHarnessAdapter({
        controlClient: mockControlClient as unknown as BedrockClient,
        client: {} as unknown as BedrockRuntimeClient,
      });
      const aiService = new AiService({ adapters: [adapter] });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({ method: 'GET', url: '/api/ai/status' });
      expect(res.statusCode).toBe(200);
      const data = res.json<{ available: boolean; models?: unknown[]; message?: string }>();
      expect(data.available).toBe(false);
      expect(data.models).toBeUndefined();
      expect(data.message).toContain('No Amazon Bedrock models are accessible');
    });

    it('discovers compatible models outside the static catalog via ListInferenceProfiles and ListFoundationModels', async () => {
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string; byOutputModality?: string } }) => {
          if (cmd.input?.byOutputModality === 'TEXT') {
            return {
              modelSummaries: [
                {
                  modelId: 'meta.llama3-8b-instruct-v1:0',
                  modelName: 'Llama 3 8B Instruct',
                  providerName: 'Meta',
                  inputModalities: ['TEXT'],
                  outputModalities: ['TEXT'],
                  responseStreamingSupported: true,
                  modelLifecycle: { status: 'ACTIVE' },
                  inferenceTypesSupported: ['ON_DEMAND'],
                },
                {
                  modelId: 'meta.llama4-maverick-17b-instruct-v1:0',
                  modelName: 'Llama 4 Maverick 17B Instruct',
                  providerName: 'Meta',
                  inputModalities: ['TEXT'],
                  outputModalities: ['TEXT'],
                  responseStreamingSupported: true,
                  modelLifecycle: { status: 'ACTIVE' },
                },
              ],
            };
          }
          if (!cmd.input?.modelId) {
            return {
              inferenceProfileSummaries: [
                {
                  inferenceProfileId: 'us.meta.llama4-maverick-17b-instruct-v1:0',
                  status: 'ACTIVE',
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
      const modelIds = models.map((m) => m.id);
      expect(modelIds).toContain('us.meta.llama4-maverick-17b-instruct-v1:0');
      expect(modelIds).toContain('meta.llama3-8b-instruct-v1:0');

      const llama4 = models.find((m) => m.id === 'us.meta.llama4-maverick-17b-instruct-v1:0');
      expect(llama4?.provider).toBe('Meta');
      expect(llama4?.role).toBe('both');

      const llama3 = models.find((m) => m.id === 'meta.llama3-8b-instruct-v1:0');
      expect(llama3?.name).toBe('Llama 3 8B Instruct');
      expect(llama3?.provider).toBe('Meta');
    });

    it('filters out explicit model exclusions via options.excludedModelIds during discovery', async () => {
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string; byOutputModality?: string } }) => {
          if (cmd.input?.byOutputModality === 'TEXT') {
            return {
              modelSummaries: [
                {
                  modelId: 'moonshotai.kimi-k3',
                  modelName: 'Kimi k3',
                  providerName: 'Moonshot AI',
                  inputModalities: ['TEXT'],
                  outputModalities: ['TEXT'],
                  responseStreamingSupported: true,
                },
                {
                  modelId: 'amazon.nova-2-lite-v1:0',
                  modelName: 'Amazon Nova 2 Lite',
                  providerName: 'Amazon',
                  inputModalities: ['TEXT'],
                  outputModalities: ['TEXT'],
                  responseStreamingSupported: true,
                },
                {
                  modelId: 'amazon.nova-pro-v1:0',
                  modelName: 'Amazon Nova Pro',
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
                { inferenceProfileId: 'us.moonshotai.kimi-k3', status: 'ACTIVE' },
                { inferenceProfileId: 'us.amazon.nova-2-lite-v1:0', status: 'ACTIVE' },
                { inferenceProfileId: 'us.amazon.nova-pro-v1:0', status: 'ACTIVE' },
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
        excludedModelIds: ['us.amazon.nova-pro-v1:0'],
      });

      const models = await adapter.getAvailableModels();
      const ids = models.map((m) => m.id);
      expect(ids).toContain('us.moonshotai.kimi-k3');
      expect(ids).toContain('us.amazon.nova-2-lite-v1:0');
      expect(ids).not.toContain('us.amazon.nova-pro-v1:0');
    });

    it('verifies configured defaults outside catalog and advertises them in available models', async () => {
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string; byOutputModality?: string } }) => {
          if (cmd.input?.byOutputModality === 'TEXT') {
            return {
              modelSummaries: [
                {
                  modelId: 'custom-vendor.custom-model-v1:0',
                  modelName: 'Custom Model',
                  providerName: 'Custom Vendor',
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
                { inferenceProfileId: 'us.custom-vendor.custom-model-v1:0', status: 'ACTIVE' },
              ],
            };
          }
          if (cmd.input.modelId === 'custom-vendor.custom-model-v1:0') {
            return {
              authorizationStatus: 'AUTHORIZED',
              entitlementAvailability: 'AVAILABLE',
              regionAvailability: 'AVAILABLE',
              agreementAvailability: { status: 'AVAILABLE' },
            };
          }
          return {
            authorizationStatus: 'NOT_AUTHORIZED',
            entitlementAvailability: 'NOT_AVAILABLE',
            regionAvailability: 'AVAILABLE',
            agreementAvailability: { status: 'NOT_AVAILABLE' },
          };
        }),
      };

      const adapter = new AwsBedrockHarnessAdapter({
        controlClient: mockControlClient as unknown as BedrockClient,
        client: {} as unknown as BedrockRuntimeClient,
        defaultScoutModelId: 'us.custom-vendor.custom-model-v1:0',
      });

      const models = await adapter.getAvailableModels();
      expect(models.some((m) => m.id === 'us.custom-vendor.custom-model-v1:0')).toBe(true);
      expect(adapter.getModelCatalog().defaultScoutModelId).toBe('us.custom-vendor.custom-model-v1:0');
    });

    it('excludes incompatible foundation models (legacy status or non-text input)', async () => {
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string; byOutputModality?: string } }) => {
          if (cmd.input?.byOutputModality === 'TEXT') {
            return {
              modelSummaries: [
                {
                  modelId: 'legacy.model:1',
                  modelName: 'Legacy Text Model',
                  inputModalities: ['TEXT'],
                  outputModalities: ['TEXT'],
                  modelLifecycle: { status: 'LEGACY' },
                },
                {
                  modelId: 'image.only.input:1',
                  modelName: 'Image Only Input',
                  inputModalities: ['IMAGE'],
                  outputModalities: ['TEXT'],
                  modelLifecycle: { status: 'ACTIVE' },
                },
                {
                  modelId: 'valid.text.model:1',
                  modelName: 'Valid Text Model',
                  inputModalities: ['TEXT'],
                  outputModalities: ['TEXT'],
                  modelLifecycle: { status: 'ACTIVE' },
                },
              ],
            };
          }
          if (!cmd.input?.modelId) {
            return { inferenceProfileSummaries: [] };
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
      const ids = models.map((m) => m.id);
      expect(ids).toContain('valid.text.model:1');
      expect(ids).not.toContain('legacy.model:1');
      expect(ids).not.toContain('image.only.input:1');
    });

    it('propagates error when ListFoundationModels fails while ListInferenceProfiles succeeds', async () => {
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { byOutputModality?: string } }) => {
          if (cmd.input?.byOutputModality === 'TEXT') {
            throw new Error('ListFoundationModels access denied');
          }
          return {
            inferenceProfileSummaries: [
              { inferenceProfileId: 'us.moonshotai.kimi-k3', status: 'ACTIVE' },
            ],
          };
        }),
      };
      const adapter = new AwsBedrockHarnessAdapter({
        controlClient: mockControlClient as unknown as BedrockClient,
        client: {} as unknown as BedrockRuntimeClient,
      });

      await expect(adapter.getAvailableModels()).rejects.toThrow('ListFoundationModels access denied');
    });

    it('propagates error when ListInferenceProfiles fails while ListFoundationModels succeeds', async () => {
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { byOutputModality?: string } }) => {
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
          throw new Error('ListInferenceProfiles throttled');
        }),
      };
      const adapter = new AwsBedrockHarnessAdapter({
        controlClient: mockControlClient as unknown as BedrockClient,
        client: {} as unknown as BedrockRuntimeClient,
      });

      await expect(adapter.getAvailableModels()).rejects.toThrow('ListInferenceProfiles throttled');
    });

    it('enforces compatibility policy on active profiles based on foundation model metadata', async () => {
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string; byOutputModality?: string } }) => {
          if (cmd.input?.byOutputModality === 'TEXT') {
            return {
              modelSummaries: [
                {
                  modelId: 'vendor.legacy-fm',
                  modelName: 'Legacy FM',
                  inputModalities: ['TEXT'],
                  outputModalities: ['TEXT'],
                  modelLifecycle: { status: 'LEGACY' },
                  responseStreamingSupported: true,
                },
                {
                  modelId: 'vendor.non-streaming-fm',
                  modelName: 'Non-Streaming FM',
                  inputModalities: ['TEXT'],
                  outputModalities: ['TEXT'],
                  modelLifecycle: { status: 'ACTIVE' },
                  responseStreamingSupported: false,
                },
                {
                  modelId: 'vendor.valid-fm',
                  modelName: 'Valid Streaming FM',
                  inputModalities: ['TEXT'],
                  outputModalities: ['TEXT'],
                  modelLifecycle: { status: 'ACTIVE' },
                  responseStreamingSupported: true,
                },
              ],
            };
          }
          if (!cmd.input?.modelId) {
            return {
              inferenceProfileSummaries: [
                {
                  inferenceProfileId: 'us.vendor.legacy-profile',
                  status: 'ACTIVE',
                  models: [{ modelArn: 'arn:aws:bedrock:us-east-2::foundation-model/vendor.legacy-fm' }],
                },
                {
                  inferenceProfileId: 'us.vendor.non-streaming-profile',
                  status: 'ACTIVE',
                  models: [{ modelArn: 'arn:aws:bedrock:us-east-2::foundation-model/vendor.non-streaming-fm' }],
                },
                {
                  inferenceProfileId: 'us.vendor.missing-fm-profile',
                  status: 'ACTIVE',
                  models: [{ modelArn: 'arn:aws:bedrock:us-east-2::foundation-model/vendor.unlisted-fm' }],
                },
                {
                  inferenceProfileId: 'us.vendor.valid-profile',
                  status: 'ACTIVE',
                  models: [{ modelArn: 'arn:aws:bedrock:us-east-2::foundation-model/vendor.valid-fm' }],
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
      const ids = models.map((m) => m.id);

      // Legacy foundation model profile -> rejected
      expect(ids).not.toContain('us.vendor.legacy-profile');
      // Missing foundation model metadata -> rejected
      expect(ids).not.toContain('us.vendor.missing-fm-profile');
      // Valid profile -> admitted
      expect(ids).toContain('us.vendor.valid-profile');
      const validProfile = models.find((m) => m.id === 'us.vendor.valid-profile');
      expect(validProfile?.role).toBe('both');

      // Non-streaming profile -> admitted for copywriter only, NOT scout
      expect(ids).toContain('us.vendor.non-streaming-profile');
      const nonStreamingProfile = models.find((m) => m.id === 'us.vendor.non-streaming-profile');
      expect(nonStreamingProfile?.role).toBe('copywriter');

      // validateModelId role enforcement
      await expect(adapter.validateModelId('us.vendor.non-streaming-profile', 'scout')).rejects.toThrow(
        'does not support streaming/scout role'
      );
      await expect(adapter.validateModelId('us.vendor.non-streaming-profile', 'copywriter')).resolves.toBe(
        'us.vendor.non-streaming-profile'
      );
    });

    it('resolves dynamic canonical aliases from models[].modelArn and excludes application profiles', async () => {
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string; byOutputModality?: string } }) => {
          if (cmd.input?.byOutputModality === 'TEXT') {
            return {
              modelSummaries: [
                {
                  modelId: 'new-vendor.new-model-v1:0',
                  modelName: 'New Model',
                  providerName: 'New Vendor',
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
                  inferenceProfileId: 'us.new-vendor.new-model-v1:0',
                  status: 'ACTIVE',
                  type: 'SYSTEM_DEFINED',
                  models: [{ modelArn: 'arn:aws:bedrock:us-east-2::foundation-model/new-vendor.new-model-v1:0' }],
                },
                {
                  inferenceProfileId: 'app-custom-profile-12345',
                  status: 'ACTIVE',
                  type: 'APPLICATION',
                  models: [{ modelArn: 'arn:aws:bedrock:us-east-2::foundation-model/new-vendor.new-model-v1:0' }],
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
        defaultScoutModelId: 'new-vendor.new-model-v1:0',
      });

      const models = await adapter.getAvailableModels();
      const ids = models.map((m) => m.id);

      // System-defined profile is admitted
      expect(ids).toContain('us.new-vendor.new-model-v1:0');
      // Application profile is excluded
      expect(ids).not.toContain('app-custom-profile-12345');

      // Dynamic canonical alias maps bare foundation ID to active profile ID
      expect(adapter.resolveCanonicalModelId('new-vendor.new-model-v1:0')).toBe('us.new-vendor.new-model-v1:0');
      expect(await adapter.validateModelId('new-vendor.new-model-v1:0', 'scout')).toBe('us.new-vendor.new-model-v1:0');
    });

    it('cold Lambda instance rejects unknown modelId before invoking Bedrock runtime', async () => {
      const mockRuntimeSend = vi.fn();
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
                { inferenceProfileId: 'us.amazon.nova-2-lite-v1:0', status: 'ACTIVE' },
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
        client: { send: mockRuntimeSend } as unknown as BedrockRuntimeClient,
      });
      const aiService = new AiService({ adapters: [adapter] });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoint: sampleWaypoint,
          modelId: 'not-a-real-vendor.not-a-real-model',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Unsupported or unavailable');
      expect(mockRuntimeSend).not.toHaveBeenCalled();
    });

    it('rejects copywriting request when default copywriter model is excluded and modelId is omitted', async () => {
      const mockRuntimeSend = vi.fn();
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
                { inferenceProfileId: 'us.amazon.nova-2-lite-v1:0', status: 'ACTIVE' },
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
        client: { send: mockRuntimeSend } as unknown as BedrockRuntimeClient,
        excludedModelIds: ['us.amazon.nova-2-lite-v1:0'],
      });
      const aiService = new AiService({ adapters: [adapter] });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoint: sampleWaypoint,
          // modelId intentionally omitted
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('excluded by policy');
      expect(mockRuntimeSend).not.toHaveBeenCalled();
    });

    it('cold instance resolves bare ID to newly discovered profile on the first request without prior getAvailableModels call (P2 Finding 1)', async () => {
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string; byOutputModality?: string } }) => {
          if (cmd.input?.byOutputModality === 'TEXT') {
            return {
              modelSummaries: [
                {
                  modelId: 'new-vendor.cold-model-v1:0',
                  modelName: 'Cold Model',
                  providerName: 'New Vendor',
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
                  inferenceProfileId: 'us.new-vendor.cold-model-v1:0',
                  status: 'ACTIVE',
                  type: 'SYSTEM_DEFINED',
                  models: [{ modelArn: 'arn:aws:bedrock:us-east-2::foundation-model/new-vendor.cold-model-v1:0' }],
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
        defaultCopywriterModelId: 'new-vendor.cold-model-v1:0',
      });
      // Note: NO getAvailableModels() call here - testing cold path directly
      const validated = await adapter.validateModelId('new-vendor.cold-model-v1:0', 'scout');
      expect(validated).toBe('us.new-vendor.cold-model-v1:0');
    });

    it('POST /api/copilot/day-title with a bare configured default succeeds on the first request on a cold instance (P2 Finding 1)', async () => {
      const mockRuntimeSend = vi.fn().mockResolvedValue({
        output: {
          message: {
            content: [{ text: JSON.stringify({ title: 'Sedona Explorer' }) }],
          },
        },
      });
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string; byOutputModality?: string } }) => {
          if (cmd.input?.byOutputModality === 'TEXT') {
            return {
              modelSummaries: [
                {
                  modelId: 'new-vendor.cold-model-v1:0',
                  modelName: 'Cold Model',
                  providerName: 'New Vendor',
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
                  inferenceProfileId: 'us.new-vendor.cold-model-v1:0',
                  status: 'ACTIVE',
                  type: 'SYSTEM_DEFINED',
                  models: [{ modelArn: 'arn:aws:bedrock:us-east-2::foundation-model/new-vendor.cold-model-v1:0' }],
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
        client: { send: mockRuntimeSend } as unknown as BedrockRuntimeClient,
        defaultCopywriterModelId: 'new-vendor.cold-model-v1:0',
      });
      const aiService = new AiService({ adapters: [adapter] });
      const app = createApp({ logger: false, aiService });

      // Request #1 without modelId - uses bare defaultCopywriterModelId on cold instance
      const res = await app.inject({
        method: 'POST',
        url: '/api/copilot/day-title',
        payload: {
          dayNumber: 1,
          stops: ['Sedona', 'Flagstaff'],
        },
      });

      expect(res.statusCode).toBe(200);
      expect(mockRuntimeSend).toHaveBeenCalled();
    });

    it('updates dynamic aliases across TTL cache refresh (P2 Finding 1)', async () => {
      let profileVersion = 'v1';
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string; byOutputModality?: string } }) => {
          if (cmd.input?.byOutputModality === 'TEXT') {
            return {
              modelSummaries: [
                {
                  modelId: 'refresh-vendor.model',
                  modelName: 'Refresh Model',
                  providerName: 'Refresh Vendor',
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
                  inferenceProfileId: `us.refresh-vendor.model-${profileVersion}`,
                  status: 'ACTIVE',
                  type: 'SYSTEM_DEFINED',
                  models: [{ modelArn: 'arn:aws:bedrock:us-east-2::foundation-model/refresh-vendor.model' }],
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

      // First validation resolves v1
      const first = await adapter.validateModelId('refresh-vendor.model', 'scout');
      expect(first).toBe('us.refresh-vendor.model-v1');

      // Update provider to v2 and expire TTL
      profileVersion = 'v2';
      (adapter as unknown as { availabilityCheckedAt: number }).availabilityCheckedAt = 0;

      // Second validation after TTL refresh resolves to v2
      const second = await adapter.validateModelId('refresh-vendor.model', 'scout');
      expect(second).toBe('us.refresh-vendor.model-v2');
    });

    it('pre-heartbeat disconnect: does not invoke inference if client disconnects during pre-stream model discovery (P2 Finding 3)', async () => {
      let resolveDiscovery!: () => void;
      const discoveryPromise = new Promise<void>((resolve) => {
        resolveDiscovery = resolve;
      });

      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string; byOutputModality?: string } }) => {
          if (cmd.input?.byOutputModality === 'TEXT') {
            await discoveryPromise;
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

      const mockRuntimeSend = vi.fn();
      const adapter = new AwsBedrockHarnessAdapter({
        controlClient: mockControlClient as unknown as BedrockClient,
        client: { send: mockRuntimeSend } as unknown as BedrockRuntimeClient,
      });

      const aiService = new AiService({ adapters: [adapter] });
      const scoutService = new ScoutService(aiService);
      const app = createApp({ logger: false, aiService, scoutService });
      await app.listen({ port: 0, host: '127.0.0.1' });

      try {
        const address = app.server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const abortController = new AbortController();

        const fetchPromise = fetch(`http://127.0.0.1:${port}/api/ai/scout/chat/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: { type: 'day', dayNumber: 1 },
            messages: [{ role: 'user', content: 'Explore route' }],
            tripContext: sampleTripContext,
          }),
          signal: abortController.signal,
        });

        // Abort while discovery is in progress (pre-heartbeat window)
        await new Promise((resolve) => setTimeout(resolve, 50));
        abortController.abort();
        await fetchPromise.catch(() => undefined);

        // Release discovery
        resolveDiscovery();
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Runtime inference should never have been invoked
        expect(mockRuntimeSend).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it('returns HTTP 400 when modelId is an inherited object property like constructor, __proto__, toString (P2 Finding 5)', async () => {
      const adapter = new AwsBedrockHarnessAdapter({
        available: true,
        availableModels: BEDROCK_MODEL_CATALOG,
      });
      const aiService = new AiService({ adapters: [adapter] });
      const app = createApp({ logger: false, aiService });

      for (const badModel of ['constructor', '__proto__', 'toString']) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/copilot/day-title',
          payload: {
            dayNumber: 1,
            stops: ['Stop A', 'Stop B'],
            modelId: badModel,
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain('Unsupported or unavailable Bedrock model ID');
      }
    });

    it('basic invalid payload returns HTTP 400 with zero discovery or runtime calls even when discovery/control plane is failing (P2 Finding 6)', async () => {
      const mockControlClient = {
        send: vi.fn().mockRejectedValue(new Error('Discovery unavailable: IAM or control-plane failure')),
      };
      const mockRuntimeSend = vi.fn();
      const adapter = new AwsBedrockHarnessAdapter({
        controlClient: mockControlClient as unknown as BedrockClient,
        client: { send: mockRuntimeSend } as unknown as BedrockRuntimeClient,
      });
      const aiService = new AiService({ adapters: [adapter] });
      const scoutService = new ScoutService(aiService);
      const app = createApp({ logger: false, aiService, scoutService });

      // 1. /api/copilot/day-title with empty body {}
      const resDayTitle = await app.inject({
        method: 'POST',
        url: '/api/copilot/day-title',
        payload: {},
      });
      expect(resDayTitle.statusCode).toBe(400);
      expect(resDayTitle.json().error).toContain('Request body must contain a non-empty "stops" array');

      // 2. /api/ai/scout/chat with empty body {}
      const resScoutChat = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat',
        payload: {},
      });
      expect(resScoutChat.statusCode).toBe(400);
      expect(resScoutChat.json().error).toContain('Request body must contain a valid "scope" object');

      // 3. /api/ai/scout/chat/stream with empty body {}
      const resScoutStream = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat/stream',
        payload: {},
      });
      expect(resScoutStream.statusCode).toBe(400);
      expect(resScoutStream.json().error).toContain('Invalid request payload for Scout chat stream');

      // Assert zero discovery and zero runtime SDK calls were made
      expect(mockControlClient.send).not.toHaveBeenCalled();
      expect(mockRuntimeSend).not.toHaveBeenCalled();
    });
  });

  describe('3. Client SSE Parser & UI Model Selector Tests', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it('chatWithScoutStream cleanly ignores : ping and : keep-alive frames and emits thought, delta, and done', async () => {
      const encoder = new TextEncoder();
      const mockStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(': ping\n\n'));
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
          controller.enqueue(
            encoder.encode('event: thought\ndata: {"text":"Reasoning about fuel stops..."}\n\n')
          );
          controller.enqueue(
            encoder.encode('event: delta\ndata: {"text":"Found Maverik at exit 285."}\n\n')
          );
          controller.enqueue(
            encoder.encode(
              'event: done\ndata: {"reply":"Found Maverik at exit 285.","suggestions":[],"sessionId":"s_test_123","engine":"bedrock","modelId":"us.moonshotai.kimi-k3"}\n\n'
            )
          );
          controller.close();
        },
      });

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'text/event-stream' }),
          body: mockStream,
        })
      );

      const emittedEvents: ScoutStreamEvent[] = [];
      const onEvent = vi.fn((evt: ScoutStreamEvent) => emittedEvents.push(evt));

      const request: ScoutChatRequest = {
        scope: { type: 'day', dayNumber: 1 },
        messages: [{ role: 'user', content: 'Find fuel' }],
        tripContext: sampleTripContext,
      };

      const response: ScoutChatResponse = await chatWithScoutStream(request, onEvent);

      expect(response).toEqual({
        reply: 'Found Maverik at exit 285.',
        suggestions: [],
        sessionId: 's_test_123',
        engine: 'bedrock',
        modelId: 'us.moonshotai.kimi-k3',
      });

      expect(onEvent).toHaveBeenCalledTimes(3);
      expect(emittedEvents[0]).toEqual({
        event: 'thought',
        data: { text: 'Reasoning about fuel stops...' },
      });
      expect(emittedEvents[1]).toEqual({
        event: 'delta',
        data: { text: 'Found Maverik at exit 285.' },
      });
      expect(emittedEvents[2]).toEqual({
        event: 'done',
        data: response,
      });
    });

    describe('UI Model Selectors', () => {
      const storageEntries = new Map<string, string>();
      const mounted: ReactTestRenderer[] = [];

      beforeEach(() => {
        storageEntries.clear();
        vi.stubGlobal('localStorage', {
          getItem: (key: string) => storageEntries.get(key) ?? null,
          setItem: (key: string, value: string) => storageEntries.set(key, value),
          removeItem: (key: string) => storageEntries.delete(key),
        });

        const documentStub = new EventTarget();
        Object.assign(documentStub, {
          body: { style: {} },
        });
        vi.stubGlobal('document', documentStub);

        const windowStub = new EventTarget();
        Object.assign(windowStub, {
          location: { href: 'http://localhost:5173' },
          speechSynthesis: {
            cancel: vi.fn(),
            speak: vi.fn(),
          },
        });
        vi.stubGlobal('window', windowStub);
      });

      afterEach(() => {
        for (const inst of mounted) {
          act(() => {
            inst.unmount();
          });
        }
        mounted.length = 0;
      });

      it('renders <RouteScoutDrawer> with Route Scout AI Model selector containing only scout / both models and triggers onChange', () => {
        const onSelectScoutModel = vi.fn();
        let app!: ReactTestRenderer;

        act(() => {
          app = create(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={BEDROCK_MODEL_CATALOG}
              selectedModelId="us.moonshotai.kimi-k3"
              onSelectModel={onSelectScoutModel}
            />
          );
        });
        mounted.push(app);

        // Find the select element by aria-label
        const select = app.root.findByProps({ 'aria-label': 'Route Scout AI Model' });
        expect(select).toBeDefined();
        expect(select.props.value).toBe('us.moonshotai.kimi-k3');

        // Verify options contain only scout or both models
        const options = select.findAllByType('option');
        expect(options.length).toBeGreaterThan(0);

        for (const opt of options) {
          const optModelId = opt.props.value;
          const matchingCatalogModel = BEDROCK_MODEL_CATALOG.find((m) => m.id === optModelId);
          expect(matchingCatalogModel).toBeDefined();
          expect(['scout', 'both']).toContain(matchingCatalogModel?.role);
        }

        // Trigger change to another model
        act(() => {
          select.props.onChange({ target: { value: 'us.amazon.nova-pro-v1:0' } });
        });

        expect(onSelectScoutModel).toHaveBeenCalledTimes(1);
        expect(onSelectScoutModel).toHaveBeenCalledWith('us.amazon.nova-pro-v1:0');
      });

      it('renders <EditWaypointModal> with Copywriter AI Model selector excluding scout-only models and triggers onChange', () => {
        const onSelectCopywriterModel = vi.fn();
        let app!: ReactTestRenderer;

        act(() => {
          app = create(
            <EditWaypointModal
              isOpen={true}
              initialTab="alert"
              waypoint={sampleWaypointWithDetails}
              onClose={vi.fn()}
              onSave={vi.fn()}
              aiModels={BEDROCK_MODEL_CATALOG}
              selectedModelId="us.amazon.nova-2-lite-v1:0"
              onSelectModel={onSelectCopywriterModel}
            />
          );
        });
        mounted.push(app);

        // Find the select element by aria-label
        const select = app.root.findByProps({ 'aria-label': 'Copywriter AI Model' });
        expect(select).toBeDefined();
        expect(select.props.value).toBe('us.amazon.nova-2-lite-v1:0');

        // Verify options contain only copywriter or both models (excluding scout-only)
        const options = select.findAllByType('option');
        expect(options.length).toBeGreaterThan(0);

        const renderedModelIds = options.map((opt) => opt.props.value);

        // Scout-only models must NOT be present in copywriter select
        expect(renderedModelIds).not.toContain('us.openai.gpt-6-astra');
        expect(renderedModelIds).not.toContain('us.anthropic.claude-opus-5-5');

        for (const opt of options) {
          const optModelId = opt.props.value;
          const matchingCatalogModel = BEDROCK_MODEL_CATALOG.find((m) => m.id === optModelId);
          expect(matchingCatalogModel).toBeDefined();
          expect(['copywriter', 'both']).toContain(matchingCatalogModel?.role);
        }

        // Trigger change
        act(() => {
          select.props.onChange({ target: { value: 'us.amazon.nova-pro-v1:0' } });
        });

        expect(onSelectCopywriterModel).toHaveBeenCalledTimes(1);
        expect(onSelectCopywriterModel).toHaveBeenCalledWith('us.amazon.nova-pro-v1:0');
      });

      it('renders disabled "Select model..." option and does not silently fall back to first model when selectedModelId is empty', () => {
        let app!: ReactTestRenderer;

        act(() => {
          app = create(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={BEDROCK_MODEL_CATALOG}
              selectedModelId=""
            />
          );
        });
        mounted.push(app);

        const select = app.root.findByProps({ 'aria-label': 'Route Scout AI Model' });
        expect(select.props.value).toBe('');
        const options = select.findAllByType('option');
        const placeholderOption = options.find((opt) => opt.props.value === '');
        expect(placeholderOption).toBeDefined();
        expect(placeholderOption?.props.disabled).toBe(true);
      });

      it('isolates conversations across itineraries: aborts in-flight stream and prevents Trip A results leaking into Trip B', async () => {
        let capturedSignal: AbortSignal | undefined;
        let resolveStreamPromise!: () => void;

        vi.stubGlobal(
          'fetch',
          vi.fn().mockImplementation((url: string, init?: RequestInit) => {
            if (url.includes('/api/ai/scout/quick-prompts')) {
              return Promise.resolve({
                ok: true,
                json: async () => ['Prompt 1', 'Prompt 2'],
              });
            }
            if (url.includes('/api/ai/scout/chat/stream')) {
              capturedSignal = init?.signal;
              return new Promise((resolve) => {
                resolveStreamPromise = () => {
                  const encoder = new TextEncoder();
                  const stream = new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(
                        encoder.encode('event: delta\ndata: {"text":"Advice intended solely for Trip A"}\n\n')
                      );
                      controller.enqueue(
                        encoder.encode(
                          'event: done\ndata: {"reply":"Advice intended solely for Trip A","suggestions":[],"sessionId":"s1"}\n\n'
                        )
                      );
                      controller.close();
                    },
                  });
                  resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'text/event-stream' }),
                    body: stream,
                  });
                };
              });
            }
            return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
          })
        );

        let drawer!: ReactTestRenderer;
        const tripA = { ...sampleTrip, fileName: 'trip-a.json', tripName: 'Trip A' };
        const tripB = { ...sampleTrip, fileName: 'trip-b.json', tripName: 'Trip B' };

        act(() => {
          drawer = create(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={tripA}
              itineraryId="trip-a"
              activeDayIndex={0}
              activeDay={tripA.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={BEDROCK_MODEL_CATALOG}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });
        mounted.push(drawer);

        // Start a turn for Trip A
        const form = drawer.root.findByType('form');
        const textarea = drawer.root.findByType('textarea');
        act(() => {
          textarea.props.onChange({ target: { value: 'Recommend fuel stops along I-40 for Trip A' } });
        });
        act(() => {
          form.props.onSubmit({ preventDefault: () => {} });
        });

        expect(capturedSignal).toBeDefined();
        expect(capturedSignal?.aborted).toBe(false);

        // Trip A stream is now deferred and in flight. Switch component props to Trip B:
        act(() => {
          drawer.update(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={tripB}
              itineraryId="trip-b"
              activeDayIndex={0}
              activeDay={tripB.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={BEDROCK_MODEL_CATALOG}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });

        // 1. Verify Trip A's stream abort signal was triggered upon itinerary switch
        expect(capturedSignal?.aborted).toBe(true);

        // 2. Now let Trip A's deferred stream complete
        await act(async () => {
          resolveStreamPromise();
        });

        // 3. Verify Trip B does NOT render Trip A's deferred response
        const jsonTree = JSON.stringify(drawer.toJSON());
        expect(jsonTree).not.toContain('Advice intended solely for Trip A');
      });

      it('aborts active stream when drawer is closed (isOpen becomes false)', () => {
        let capturedSignal: AbortSignal | undefined;

        vi.stubGlobal(
          'fetch',
          vi.fn().mockImplementation((url: string, init?: RequestInit) => {
            if (url.includes('/api/ai/scout/quick-prompts')) {
              return Promise.resolve({ ok: true, json: async () => [] });
            }
            if (url.includes('/api/ai/scout/chat/stream')) {
              capturedSignal = init?.signal;
              return new Promise(() => {}); // never resolves
            }
            return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
          })
        );

        let drawer!: ReactTestRenderer;
        act(() => {
          drawer = create(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={BEDROCK_MODEL_CATALOG}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });
        mounted.push(drawer);

        const form = drawer.root.findByType('form');
        const textarea = drawer.root.findByType('textarea');
        act(() => {
          textarea.props.onChange({ target: { value: 'In flight request' } });
        });
        act(() => {
          form.props.onSubmit({ preventDefault: () => {} });
        });

        expect(capturedSignal).toBeDefined();
        expect(capturedSignal?.aborted).toBe(false);

        // Close the drawer
        act(() => {
          drawer.update(
            <RouteScoutDrawer
              isOpen={false}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={BEDROCK_MODEL_CATALOG}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });

        expect(capturedSignal?.aborted).toBe(true);

        // Reopen the drawer: verify no stuck analyzing placeholder message is retained (R7)
        act(() => {
          drawer.update(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={BEDROCK_MODEL_CATALOG}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });

        const reopenedJson = JSON.stringify(drawer.toJSON());
        expect(reopenedJson).not.toContain('Route Scout is analyzing route geometry & corridor');
      });

      it('aborts active stream when scope is switched', () => {
        let capturedSignal: AbortSignal | undefined;

        vi.stubGlobal(
          'fetch',
          vi.fn().mockImplementation((url: string, init?: RequestInit) => {
            if (url.includes('/api/ai/scout/quick-prompts')) {
              return Promise.resolve({ ok: true, json: async () => [] });
            }
            if (url.includes('/api/ai/scout/chat/stream')) {
              capturedSignal = init?.signal;
              return new Promise(() => {}); // never resolves
            }
            return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
          })
        );

        let drawer!: ReactTestRenderer;
        act(() => {
          drawer = create(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={BEDROCK_MODEL_CATALOG}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });
        mounted.push(drawer);

        const form = drawer.root.findByType('form');
        const textarea = drawer.root.findByType('textarea');
        act(() => {
          textarea.props.onChange({ target: { value: 'In flight request' } });
        });
        act(() => {
          form.props.onSubmit({ preventDefault: () => {} });
        });

        expect(capturedSignal).toBeDefined();
        expect(capturedSignal?.aborted).toBe(false);

        // Switch scope to Day 2
        act(() => {
          drawer.update(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={1}
              activeDay={sampleTrip.days[1] || sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 2 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={BEDROCK_MODEL_CATALOG}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });

        expect(capturedSignal?.aborted).toBe(true);

        // Switch scope back to Day 1: verify no stuck analyzing placeholder is retained (R7)
        act(() => {
          drawer.update(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={BEDROCK_MODEL_CATALOG}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });

        const day1Json = JSON.stringify(drawer.toJSON());
        expect(day1Json).not.toContain('Route Scout is analyzing route geometry & corridor');
      });

      it('preserves completed suggestions-only message across drawer close/reopen and scope switch (P2 Finding 4)', async () => {
        let resolveStreamPromise: () => void = () => {};

        vi.stubGlobal(
          'fetch',
          vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/ai/scout/quick-prompts')) {
              return Promise.resolve({
                ok: true,
                json: async () => [],
              });
            }
            if (url.includes('/api/ai/scout/chat/stream')) {
              return new Promise((resolve) => {
                resolveStreamPromise = () => {
                  const encoder = new TextEncoder();
                  const stream = new ReadableStream<Uint8Array>({
                    start(controller) {
                      const suggestionsBlock = JSON.stringify({
                        reply: '',
                        suggestions: [
                          {
                            id: 'sug-scenic-1',
                            action: 'add_waypoint',
                            name: 'Completed Scenic Vista',
                            type: 'scenic',
                            lat: 34.8697,
                            lng: -111.761,
                            notes: 'Must-see red rocks vista',
                            reason: 'Iconic panoramic viewpoint along corridor',
                          },
                        ],
                        sessionId: 's_test_123',
                        engine: 'bedrock',
                      });
                      controller.enqueue(
                        encoder.encode(`event: done\ndata: ${suggestionsBlock}\n\n`)
                      );
                      controller.close();
                    },
                  });
                  resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'text/event-stream' }),
                    body: stream,
                  });
                };
              });
            }
            return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
          })
        );

        let drawer!: ReactTestRenderer;
        act(() => {
          drawer = create(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={BEDROCK_MODEL_CATALOG}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });
        mounted.push(drawer);

        const form = drawer.root.findByType('form');
        const textarea = drawer.root.findByType('textarea');
        act(() => {
          textarea.props.onChange({ target: { value: 'Suggest scenic spots' } });
        });
        act(() => {
          form.props.onSubmit({ preventDefault: () => {} });
        });

        // Resolve the streaming response
        await act(async () => {
          resolveStreamPromise();
        });

        // The completed suggestion card is rendered
        let jsonStr = JSON.stringify(drawer.toJSON());
        expect(jsonStr).toContain('Completed Scenic Vista');

        // Close the drawer and reopen: verify completed suggestion card is preserved
        act(() => {
          drawer.update(
            <RouteScoutDrawer
              isOpen={false}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={BEDROCK_MODEL_CATALOG}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });
        act(() => {
          drawer.update(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={BEDROCK_MODEL_CATALOG}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });
        jsonStr = JSON.stringify(drawer.toJSON());
        expect(jsonStr).toContain('Completed Scenic Vista');

        // Switch scope to Day 2 and return to Day 1: verify completed suggestion card is preserved
        act(() => {
          drawer.update(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={1}
              activeDay={sampleTrip.days[1] || sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 2 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={BEDROCK_MODEL_CATALOG}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });
        act(() => {
          drawer.update(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={BEDROCK_MODEL_CATALOG}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });
        jsonStr = JSON.stringify(drawer.toJSON());
        expect(jsonStr).toContain('Completed Scenic Vista');
      });

      it('gates Route Scout input, send button, and quick prompts when selectedModelId is empty (R5)', () => {
        let drawer!: ReactTestRenderer;
        act(() => {
          drawer = create(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={BEDROCK_MODEL_CATALOG}
              selectedModelId=""
            />
          );
        });
        mounted.push(drawer);

        const textarea = drawer.root.findByType('textarea');
        expect(textarea.props.disabled).toBe(true);
        expect(textarea.props.placeholder).toContain('Select an AI model');

        const sendButton = drawer.root.findByProps({ type: 'submit' });
        expect(sendButton.props.disabled).toBe(true);

        const select = drawer.root.findByType('select');
        expect(select.props.value).toBe('');
      });

      it('gates Waypoint edit modal generate alert button when selectedModelId is empty (R5)', () => {
        let modal!: ReactTestRenderer;
        act(() => {
          modal = create(
            <EditWaypointModal
              isOpen={true}
              initialTab="alert"
              onClose={vi.fn()}
              onSave={vi.fn()}
              waypoint={sampleWaypointWithDetails}
              aiModels={BEDROCK_MODEL_CATALOG}
              selectedModelId=""
            />
          );
        });
        mounted.push(modal);

        const generateBtn = modal.root.findByProps({ title: 'Select an AI model to generate alert' });
        expect(generateBtn.props.disabled).toBe(true);
      });

      it('maintains stable itinerary session identity across save and rename, but resets on new route (R6)', () => {
        const id1 = createItinerarySessionId();
        const id2 = createItinerarySessionId();
        expect(id1).toMatch(/^itin_session_\d+_\d+$/);
        expect(id2).toMatch(/^itin_session_\d+_\d+$/);
        expect(id1).not.toBe(id2);
      });
    });
  });
});
