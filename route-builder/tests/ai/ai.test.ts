import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../../server/app.js';
import { AiService } from '../../server/services/aiService.js';
import { AiQueue } from '../../src/services/aiQueue.js';
import type { WaypointContext, BatchAlertResult, GenerateAlertResult } from '../../server/types/ai.js';

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
    it('Processes an array of waypoints and returns matching alerts in a single invocation', async () => {
      // Mock agy CLI output for batch request
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

      const mockExecAgy = vi.fn().mockResolvedValue(mockBatchResponse);
      const aiService = new AiService({ execAgyFn: mockExecAgy });
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

      expect(data.engine).toBe('agy');
      // Only 1 execution should have occurred for both stops
      expect(mockExecAgy).toHaveBeenCalledTimes(1);

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

  describe('Scenario 5: Fallback Resilience', () => {
    it('Falls back gracefully to deterministic templates without throwing 500 when agy CLI fails and no apiKey', async () => {
      // Mock agy CLI failure (e.g. agy not installed, process crash, or exit code 1)
      const mockExecAgy = vi.fn().mockRejectedValue(new Error('Command failed: agy not found in PATH'));
      const aiService = new AiService({ execAgyFn: mockExecAgy });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoint: sampleWaypoint,
        },
      });

      // Must succeed with 200 rather than 500
      expect(res.statusCode).toBe(200);
      const data = res.json<GenerateAlertResult>();

      expect(data.engine).toBe('template');
      expect(data.alert).toBeDefined();
      expect(data.alert.title.length).toBeLessThanOrEqual(30);
      expect(data.alert.speech).toContain('Sedona Red Rock Vistas');
      expect(data.alert.recommended_trigger_radius_miles).toBeGreaterThanOrEqual(0.3);
      expect(data.alert.recommended_trigger_radius_miles).toBeLessThanOrEqual(6.0);
    });

    it('Falls back to Cloud AI when agy CLI fails and apiKey is provided', async () => {
      const mockExecAgy = vi.fn().mockRejectedValue(new Error('agy CLI unavailable'));
      const mockFetchCloud = vi.fn().mockResolvedValue(
        JSON.stringify({
          title: 'Cloud Bell Rock Alert',
          message: 'Target arrival: 4:30 PM.\nScenic red rock vistas.',
          speech: 'Approaching Bell Rock on Highway 179 from the cloud generator.',
          recommended_trigger_radius_miles: 2.5,
        })
      );

      const aiService = new AiService({
        execAgyFn: mockExecAgy,
        fetchCloudFn: mockFetchCloud,
      });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoint: sampleWaypoint,
          apiKey: 'fake-test-api-key',
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json<GenerateAlertResult>();

      expect(data.engine).toBe('cloud');
      expect(data.alert.title).toBe('Cloud Bell Rock Alert');
      expect(mockFetchCloud).toHaveBeenCalledTimes(1);
    });

    it('Falls back to deterministic template when both agy CLI and Cloud AI fail', async () => {
      const mockExecAgy = vi.fn().mockRejectedValue(new Error('agy failed'));
      const mockFetchCloud = vi.fn().mockRejectedValue(new Error('Network error connecting to Gemini'));

      const aiService = new AiService({
        execAgyFn: mockExecAgy,
        fetchCloudFn: mockFetchCloud,
      });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoint: sampleWaypoint,
          apiKey: 'invalid-key',
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json<GenerateAlertResult>();
      expect(data.engine).toBe('template');
      expect(data.alert.title).toBeDefined();
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
    it('Returns HTTP 200 with sanitized alert when generating for a single waypoint via agy', async () => {
      const mockExecAgy = vi.fn().mockResolvedValue(
        JSON.stringify({
          status: 'SUCCESS',
          response: JSON.stringify({
            title: 'Sedona Bell Rock Vista',
            message: 'Target arrival: 4:30 PM.\nRecommended 30-min stop.',
            speech: 'Upcoming sight on your right: Bell Rock on Highway 179.',
            recommended_trigger_radius_miles: 3.0,
          }),
        })
      );

      const aiService = new AiService({ execAgyFn: mockExecAgy });
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

      expect(data.engine).toBe('agy');
      expect(data.title).toBe('Sedona Bell Rock Vista');
      expect(data.recommended_trigger_radius_miles).toBe(3.0);
      expect(data.alert.speech).toContain('Highway 179');
    });
  });
});
