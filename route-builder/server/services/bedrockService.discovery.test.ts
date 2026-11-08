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
import {
  ConverseCommand,
  ConverseStreamCommand,
  type BedrockRuntimeClient,
  type ConverseStreamOutput,
} from '@aws-sdk/client-bedrock-runtime';
import {
  TEST_MOCK_MODELS,
  sampleWaypoint,
  sampleTripContext,
  sampleTools,
  createAsyncStream,
} from '../test-helpers/bedrockFixtures.js';

describe('Bedrock model discovery and availability', () => {
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
      expect(adapter.getModelCatalog().models).toEqual([]);
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
});
