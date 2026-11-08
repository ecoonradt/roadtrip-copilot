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

    it('succeeds on first unpinned request after alias-changing TTL refresh and rejects pinned old profile (P2 Finding 1)', async () => {
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
