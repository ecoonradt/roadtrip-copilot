import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../../server/app.js';
import {
  AiService,
  type AiHarnessAdapter,
} from '../../server/services/aiService.js';
import { AiQueue } from '../../src/services/aiQueue.js';
import type {
  AiModelOption,
  WaypointContext,
  BatchAlertResult,
  GenerateAlertResult,
} from '../../server/types/ai.js';

const modelCatalog: AiModelOption[] = [
  {
    id: 'test-model',
    name: 'Test Model',
    provider: 'Test Vendor',
    description: 'Model used by adapter seam tests',
    role: 'both',
  },
];

function createMockAdapter(overrides: Partial<AiHarnessAdapter> = {}): AiHarnessAdapter {
  return {
    id: 'bedrock',
    name: 'Test Provider',
    isAvailable: async () => true,
    generate: async () => '{}',
    validateModelId: (modelId: string) => modelId,
    getAvailableModels: async () => modelCatalog,
    getModelCatalog: () => ({
      models: modelCatalog,
      defaultScoutModelId: 'test-scout-model',
      defaultCopywriterModelId: 'test-copywriter-model',
    }),
    decorateScoutPrompt: (prompt: string) => prompt,
    sanitizeResponse: (text: string) => text,
    ...overrides,
  };
}

describe('AI Co-Pilot Enrichment & Resilience (/api/copilot/generate)', () => {
  const sampleWaypoint: WaypointContext = {
    id: 'wp_sedona_bell_rock',
    name: 'Sedona Red Rock Vistas (Bell Rock)',
    type: 'scenic_pull_off',
    targetTime: '16:30:00',
    formattedTime: '4:30 PM',
    approachHighway: 'AZ-179 North',
    notes: 'Bell Rock scenic pull-off for photo views',
  };

  const sampleWaypoint2: WaypointContext = {
    id: 'wp_flagstaff_hotel',
    name: 'Little America Hotel Flagstaff',
    type: 'lodging',
    targetTime: '18:15:00',
    formattedTime: '6:15 PM',
    approachHighway: 'I-40 East',
    notes: 'Ponderosa pine lodge retreat',
  };

  describe('Scenario 3: Day-Level Batching', () => {
    it('Processes an array of waypoints and returns matching alerts in a single invocation via the provider', async () => {
      const mockBatchResponse = JSON.stringify({
        status: 'SUCCESS',
        response: JSON.stringify({
          wp_sedona_bell_rock: {
            title: 'Sedona Bell Rock Ahead',
            message: 'Target arrival: 4:30 PM.\nRecommended 30-min stop for red rocks.',
            speech: 'Upcoming sight on your right: Bell Rock and Courthouse Butte on Highway 179.',
            recommended_trigger_radius_miles: 3.0,
          },
          wp_flagstaff_hotel: {
            title: 'Little America Ahead',
            message: 'Target arrival: 6:15 PM.\nCheck-in and evening rest in Flagstaff.',
            speech: 'Arriving in Flagstaff. Hotel destination is Little America on your right.',
            recommended_trigger_radius_miles: 0.5,
          },
        }),
      });

      const mockAdapter = createMockAdapter({
        generate: vi.fn().mockResolvedValue(mockBatchResponse),
      });

      const aiService = new AiService({ adapters: [mockAdapter] });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoints: [sampleWaypoint, sampleWaypoint2],
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json<BatchAlertResult>();

      expect(data.engine).toBe('bedrock');
      expect(mockAdapter.generate).toHaveBeenCalledTimes(1);

      // Verify returned alerts map
      expect(data.alerts.wp_sedona_bell_rock).toBeDefined();
      expect(data.alerts.wp_sedona_bell_rock.title).toBe('Sedona Bell Rock Ahead');
      expect(data.alerts.wp_sedona_bell_rock.recommended_trigger_radius_miles).toBe(3.0);
      expect(data.alerts.wp_flagstaff_hotel).toBeDefined();
      expect(data.alerts.wp_flagstaff_hotel.title).toBe('Little America Ahead');
      expect(data.alerts.wp_flagstaff_hotel.recommended_trigger_radius_miles).toBe(0.5);

      // Verify results array format
      expect(data.results.length).toBe(2);
      expect(data.results[0].id).toBe('wp_sedona_bell_rock');
      expect(data.results[1].id).toBe('wp_flagstaff_hotel');
    });
  });

  describe('Scenario 5: Fail-Loud Policy', () => {
    it('rejects the removed template engine instead of generating offline copy', async () => {
      const app = createApp({ logger: false });

      const res = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoint: sampleWaypoint,
          preferredEngine: 'template',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toContain('not registered');
    });

    it('Fails loudly with HTTP 500 without mock degradation when the provider invocation fails', async () => {
      const mockAdapter = createMockAdapter({
        generate: vi.fn().mockRejectedValue(new Error('ValidationException: Error 002')),
      });

      const aiService = new AiService({ adapters: [mockAdapter] });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoint: sampleWaypoint,
        },
      });

      expect(res.statusCode).toBe(500);
      const data = res.json<{ error: string }>();
      expect(data.error).toContain('ValidationException: Error 002');
    });

    it('returns HTTP 502 when the provider omits required alert fields', async () => {
      const mockAdapter = createMockAdapter({
        generate: vi.fn().mockResolvedValue(JSON.stringify({ title: 'Only a title' })),
      });

      const aiService = new AiService({ adapters: [mockAdapter] });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoint: sampleWaypoint,
        },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json<{ error: string }>().error).toContain('message');
    });

    it('returns HTTP 502 when a batch response omits a waypoint', async () => {
      const mockAdapter = createMockAdapter({
        generate: vi.fn().mockResolvedValue(
          JSON.stringify({
            wp_sedona_bell_rock: {
              title: 'Sedona Bell Rock Ahead',
              message: 'Target arrival: 4:30 PM.',
              speech: 'Bell Rock on your right.',
              recommended_trigger_radius_miles: 3.0,
            },
          })
        ),
      });

      const aiService = new AiService({ adapters: [mockAdapter] });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoints: [sampleWaypoint, sampleWaypoint2],
        },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json<{ error: string }>().error).toContain('wp_flagstaff_hotel');
    });

    it('returns HTTP 502 when the day-title payload is unusable', async () => {
      const mockAdapter = createMockAdapter({
        generate: vi.fn().mockResolvedValue('I cannot suggest a title.'),
      });

      const aiService = new AiService({ adapters: [mockAdapter] });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({
        method: 'POST',
        url: '/api/copilot/day-title',
        payload: {
          dayNumber: 1,
          stops: [{ name: 'Sedona' }, { name: 'Flagstaff' }],
        },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json<{ error: string }>().error).toContain('not valid JSON');
    });

    it('Returns HTTP 400 when neither waypoint nor waypoints is provided', async () => {
      const app = createApp({ logger: false });

      const res = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Request body must contain either');
    });
  });

  describe('Scenario 4: Client-Side Concurrency Queue', () => {
    it('Limits concurrent tasks to configured limit (concurrency = 2) preventing bursts', async () => {
      const queue = new AiQueue({ concurrency: 2 });
      let currentRunning = 0;
      let peakRunning = 0;
      const completedOrder: number[] = [];

      const makeTask = (id: number, delayMs: number) => async () => {
        currentRunning++;
        peakRunning = Math.max(peakRunning, currentRunning);

        await new Promise((resolve) => setTimeout(resolve, delayMs));

        currentRunning--;
        completedOrder.push(id);
        return `result_${id}`;
      };

      // Enqueue 5 tasks at once
      const promises = [
        queue.enqueue(makeTask(1, 30)),
        queue.enqueue(makeTask(2, 30)),
        queue.enqueue(makeTask(3, 20)),
        queue.enqueue(makeTask(4, 20)),
        queue.enqueue(makeTask(5, 10)),
      ];

      const results = await Promise.all(promises);

      // Peak concurrency must never exceed 2
      expect(peakRunning).toBeLessThanOrEqual(2);
      expect(peakRunning).toBe(2);

      // All tasks completed with results
      expect(results).toEqual([
        'result_1',
        'result_2',
        'result_3',
        'result_4',
        'result_5',
      ]);
      expect(completedOrder.length).toBe(5);
    });

    it('Enforces strict serial execution when concurrency is 1', async () => {
      const serialQueue = new AiQueue({ concurrency: 1 });
      let currentRunning = 0;
      let peakRunning = 0;

      const makeTask = (id: number) => async () => {
        currentRunning++;
        peakRunning = Math.max(peakRunning, currentRunning);
        await new Promise((resolve) => setTimeout(resolve, 15));
        currentRunning--;
        return id;
      };

      const promises = [
        serialQueue.enqueue(makeTask(1)),
        serialQueue.enqueue(makeTask(2)),
        serialQueue.enqueue(makeTask(3)),
      ];

      const results = await Promise.all(promises);

      expect(peakRunning).toBe(1);
      expect(results).toEqual([1, 2, 3]);
    });

    it('Continues processing remaining queued tasks even if one task rejects', async () => {
      const queue = new AiQueue({ concurrency: 1 });

      const task1 = () => Promise.resolve('ok_1');
      const task2 = () => Promise.reject(new Error('task_2_failed'));
      const task3 = () => Promise.resolve('ok_3');

      const p1 = queue.enqueue(task1);
      const p2 = queue.enqueue(task2);
      const p3 = queue.enqueue(task3);

      await expect(p1).resolves.toBe('ok_1');
      await expect(p2).rejects.toThrow('task_2_failed');
      await expect(p3).resolves.toBe('ok_3');
    });
  });

  describe('Single Waypoint Generation Endpoint', () => {
    it('Returns HTTP 200 with sanitized alert when generating for a single waypoint via the provider', async () => {
      const mockResponse = JSON.stringify({
        status: 'SUCCESS',
        response: JSON.stringify({
          title: 'Sedona Bell Rock Vista',
          message: 'Target arrival: 4:30 PM.\nRecommended 30-min stop.',
          speech: 'Upcoming sight on your right: Bell Rock on Highway 179.',
          recommended_trigger_radius_miles: 3.0,
        }),
      });

      const mockAdapter = createMockAdapter({
        generate: vi.fn().mockResolvedValue(mockResponse),
      });

      const aiService = new AiService({ adapters: [mockAdapter] });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoint: sampleWaypoint,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json<GenerateAlertResult>();

      expect(data.engine).toBe('bedrock');
      expect(data.title).toBe('Sedona Bell Rock Vista');
      expect(data.recommended_trigger_radius_miles).toBe(3.0);
      expect(data.alert.speech).toContain('Highway 179');
    });
  });

  describe('Extensible Provider Adapter Pattern & Model Resolution', () => {
    it('Allows registering custom AI provider adapters', async () => {
      const customAdapter = createMockAdapter({
        id: 'custom-provider',
        name: 'Custom Test Provider',
        generate: async () =>
          JSON.stringify({
            title: 'Custom Alert',
            message: 'Custom Message',
            speech: 'Custom speech announcement.',
            recommended_trigger_radius_miles: 2.0,
          }),
      });

      const aiService = new AiService();
      aiService.registerAdapter(customAdapter);

      const registered = aiService.getAdapter('custom-provider');
      expect(registered).toBeDefined();
      expect(registered?.name).toBe('Custom Test Provider');
      expect(aiService.getPrimaryAdapter()?.id).toBe('custom-provider');
    });

    it('generates through a non-primary registered provider when explicitly selected', async () => {
      const secondary = createMockAdapter({
        id: 'secondary-provider',
        name: 'Secondary Provider',
        generate: async () =>
          JSON.stringify({
            title: 'Secondary Alert',
            message: 'Secondary message',
            speech: 'Secondary speech announcement.',
            recommended_trigger_radius_miles: 1.0,
          }),
      });
      const aiService = new AiService({ adapters: [createMockAdapter(), secondary] });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoint: sampleWaypoint,
          preferredEngine: 'secondary-provider',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<GenerateAlertResult>().engine).toBe('secondary-provider');
    });
  });

  describe('AI Availability & Status Endpoint', () => {
    it('returns available: true when an adapter is available', async () => {
      const aiService = new AiService({ adapters: [createMockAdapter()] });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({
        method: 'GET',
        url: '/api/ai/status',
      });

      expect(res.statusCode).toBe(200);
      const data = res.json<{ available: boolean; message?: string; engine?: string; models?: AiModelOption[] }>();
      expect(data.available).toBe(true);
      expect(data.engine).toBe('bedrock');
      expect(data.models).toHaveLength(1);
      expect(data.message).toBeUndefined();
    });

    it('returns available: false with a generic message when no adapter is available', async () => {
      const unavailableAdapter = createMockAdapter({
        isAvailable: async () => false,
      });
      const aiService = new AiService({ adapters: [unavailableAdapter] });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({
        method: 'GET',
        url: '/api/ai/status',
      });

      expect(res.statusCode).toBe(200);
      const data = res.json<{ available: boolean; message?: string }>();
      expect(data.available).toBe(false);
      expect(data.message).toContain('Test Provider');
    });

    it('/api/ai/health returns health status format', async () => {
      const unavailableAdapter = createMockAdapter({
        isAvailable: async () => false,
      });
      const aiService = new AiService({ adapters: [unavailableAdapter] });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({
        method: 'GET',
        url: '/api/ai/health',
      });

      expect(res.statusCode).toBe(200);
      const data = res.json<{ status: string; available: boolean }>();
      expect(data.status).toBe('unavailable');
      expect(data.available).toBe(false);
    });
  });
});
