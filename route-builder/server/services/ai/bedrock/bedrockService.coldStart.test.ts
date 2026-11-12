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
} from '../aiService.js';
import { ScoutService } from '../../scout/scoutService.js';
import { MalformedAiResponseError } from '../schemaParser.js';
import { createApp } from '../../../app.js';
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
} from '../../../test-helpers/bedrockFixtures.js';

describe('Bedrock cold-start discovery on HTTP routes', () => {
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

    it('cold instance resolves bare ID to newly discovered profile on the first request without prior getAvailableModels call', async () => {
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

    it('POST /api/copilot/day-title with a bare configured default succeeds on the first request on a cold instance', async () => {
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

    it('updates dynamic aliases across TTL cache refresh', async () => {
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

    it('succeeds on first unpinned request after alias-changing TTL refresh and rejects pinned old profile', async () => {
      let activeProfile = 'us.refresh-vendor.model-v1:0';
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string; byOutputModality?: string } }) => {
          if (cmd.input?.byOutputModality === 'TEXT') {
            return {
              modelSummaries: [
                {
                  modelId: 'refresh-vendor.model-v1:0',
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
                  inferenceProfileId: activeProfile,
                  status: 'ACTIVE',
                  type: 'SYSTEM_DEFINED',
                  models: [{ modelArn: 'arn:aws:bedrock:us-east-2::foundation-model/refresh-vendor.model-v1:0' }],
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

      const capturedModelIds: string[] = [];
      const mockRuntimeSend = vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string } }) => {
        if (cmd.input?.modelId) {
          capturedModelIds.push(cmd.input.modelId);
        }
        return {
          output: {
            message: {
              role: 'assistant',
              content: [{ text: JSON.stringify({ title: 'Sedona to Flagstaff' }) }],
            },
          },
          stopReason: 'end_turn',
        };
      });

      const adapter = new AwsBedrockHarnessAdapter({
        controlClient: mockControlClient as unknown as BedrockClient,
        client: { send: mockRuntimeSend } as unknown as BedrockRuntimeClient,
        defaultCopywriterModelId: 'refresh-vendor.model-v1:0',
      });
      const aiService = new AiService({ adapters: [adapter] });
      const app = createApp({ logger: false, aiService });

      // Request 1: unpinned POST on fresh/cold instance succeeds with us. variant
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/copilot/day-title',
        payload: {
          dayNumber: 1,
          stops: ['Sedona', 'Flagstaff'],
        },
      });
      expect(res1.statusCode).toBe(200);
      expect(capturedModelIds[0]).toBe('us.refresh-vendor.model-v1:0');

      // Change available profile to global variant and expire TTL
      activeProfile = 'global.refresh-vendor.model-v1:0';
      (adapter as unknown as { availabilityCheckedAt: number }).availabilityCheckedAt = 0;

      // Request 2: FIRST unpinned POST after TTL refresh MUST succeed with HTTP 200 using global variant
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/copilot/day-title',
        payload: {
          dayNumber: 1,
          stops: ['Sedona', 'Flagstaff'],
        },
      });
      expect(res2.statusCode).toBe(200);
      expect(capturedModelIds[1]).toBe('global.refresh-vendor.model-v1:0');

      // Request 3: explicitly pinned request with the old/unavailable US profile MUST be rejected with HTTP 400
      const res3 = await app.inject({
        method: 'POST',
        url: '/api/copilot/day-title',
        payload: {
          dayNumber: 1,
          stops: ['Sedona', 'Flagstaff'],
          modelId: 'us.refresh-vendor.model-v1:0',
        },
      });
      expect(res3.statusCode).toBe(400);
      expect(res3.json().error).toContain('Unsupported or unavailable Bedrock model ID: "us.refresh-vendor.model-v1:0"');
    });
});
