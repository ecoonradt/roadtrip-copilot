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
} from '../services/bedrockService.js';
import type { BedrockClient } from '@aws-sdk/client-bedrock';
import {
  AiService,
  type AiHarnessAdapter,
} from '../services/aiService.js';
import { ScoutService } from '../services/scoutService.js';
import { MalformedAiResponseError } from '../services/schemaParser.js';
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

describe('Bedrock Fastify routes', () => {
    it('GET /api/ai/status returns available: true, engine: "bedrock", 18 models, and ADR-0010 defaults', async () => {
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string; byOutputModality?: string; typeEquals?: string } }) => {
          if (cmd.input?.byOutputModality === 'TEXT') {
            return {
              modelSummaries: TEST_MOCK_MODELS.map((model) => ({
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
              inferenceProfileSummaries: TEST_MOCK_MODELS.map((model) => ({
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
        getAvailableModels: async () => TEST_MOCK_MODELS,
        getModelCatalog: () => ({
          models: TEST_MOCK_MODELS,
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
            availableModels: TEST_MOCK_MODELS,
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
        getAvailableModels: async () => TEST_MOCK_MODELS,
        getModelCatalog: () => ({
          models: TEST_MOCK_MODELS,
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
            availableModels: TEST_MOCK_MODELS,
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
        availableModels: TEST_MOCK_MODELS,
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
        availableModels: TEST_MOCK_MODELS,
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
        getAvailableModels: async () => TEST_MOCK_MODELS,
        getModelCatalog: () => ({
          models: TEST_MOCK_MODELS,
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
            availableModels: TEST_MOCK_MODELS,
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
        getAvailableModels: async () => TEST_MOCK_MODELS,
        getModelCatalog: () => ({
          models: TEST_MOCK_MODELS,
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
            availableModels: TEST_MOCK_MODELS,
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
        getAvailableModels: async () => TEST_MOCK_MODELS,
        getModelCatalog: () => ({
          models: TEST_MOCK_MODELS,
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
            availableModels: TEST_MOCK_MODELS,
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
        availableModels: TEST_MOCK_MODELS,
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
