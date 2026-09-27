import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ItineraryStorageService } from '../../server/services/itineraryStorageService.js';
import { createApp } from '../../server/app.js';

describe('Itinerary Discovery & Storage Service (/api/itineraries)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-itinerary-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('ItineraryStorageService Unit Tests', () => {
    it('discovers and summarizes multi-day itineraries', async () => {
      const sampleMultiDay = {
        trip_name: 'Test Multi-Day Road Trip',
        dates: { start: '2026-10-09', end: '2026-10-10' },
        days: [
          {
            day: 1,
            date: '2026-10-09',
            title: 'Day One Drive',
            checkpoints: [
              { id: 'cp1', name: 'Start', lat: 34.0, lng: -111.0 },
              { id: 'cp2', name: 'Stop', lat: 35.0, lng: -112.0 },
            ],
          },
          {
            day: 2,
            date: '2026-10-10',
            title: 'Day Two Drive',
            checkpoints: [
              { id: 'cp3', name: 'Finish', lat: 36.0, lng: -113.0 },
            ],
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'sample_multi.json'),
        JSON.stringify(sampleMultiDay, null, 2),
        'utf-8'
      );

      const service = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      const list = await service.listItineraries();
      expect(list).toHaveLength(1);
      expect(list[0].fileName).toBe('sample_multi.json');
      expect(list[0].tripName).toBe('Test Multi-Day Road Trip');
      expect(list[0].isMultiDay).toBe(true);
      expect(list[0].dayCount).toBe(2);
      expect(list[0].totalCheckpoints).toBe(3);
      expect(list[0].days[0].checkpointCount).toBe(2);
      expect(list[0].days[1].checkpointCount).toBe(1);
    });

    it('discovers and summarizes single-day / ad-hoc routes', async () => {
      const sampleSingle = {
        trip_name: 'Afternoon Scenic Loop',
        date: '2026-09-12',
        origin: 'Downtown',
        destination: 'Mountain Overlook',
        checkpoints: [
          { id: 'p1', name: 'Point A', lat: 42.0, lng: -73.0 },
          { id: 'p2', name: 'Point B', lat: 42.5, lng: -73.5 },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'single_day.json'),
        JSON.stringify(sampleSingle, null, 2),
        'utf-8'
      );

      const service = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      const list = await service.listItineraries();
      expect(list).toHaveLength(1);
      expect(list[0].fileName).toBe('single_day.json');
      expect(list[0].tripName).toBe('Afternoon Scenic Loop');
      expect(list[0].isMultiDay).toBe(false);
      expect(list[0].dayCount).toBe(1);
      expect(list[0].totalCheckpoints).toBe(2);
    });

    it('ignores non-itinerary JSON files like package.json', async () => {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ name: 'random-project', version: '1.0.0' }),
        'utf-8'
      );

      const service = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      const list = await service.listItineraries();
      expect(list).toHaveLength(0);
    });

    it('reads and saves itineraries round-trip with pretty JSON formatting', async () => {
      const service = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      const itineraryData = {
        trip_name: 'Saved Trip',
        checkpoints: [{ id: '1', name: 'Stop 1', lat: 34.0, lng: -111.0 }],
      };

      const saveResult = await service.saveItinerary('my_custom_trip.json', itineraryData);
      expect(saveResult.success).toBe(true);
      expect(saveResult.fileName).toBe('my_custom_trip.json');

      const loaded = await service.getItinerary('my_custom_trip.json');
      expect(loaded).toBeDefined();
      expect((loaded as Record<string, unknown>).trip_name).toBe('Saved Trip');
    });

    it('marks sample_itinerary.json as protected and allows deleting custom routes', async () => {
      const service = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      // Write a sample itinerary and a custom trip
      await fs.writeFile(
        path.join(tempDir, 'sample_itinerary.json'),
        JSON.stringify({ trip_name: 'Sample Route', checkpoints: [] }),
        'utf-8'
      );
      await fs.writeFile(
        path.join(tempDir, 'deletable_trip.json'),
        JSON.stringify({ trip_name: 'Deletable Trip', checkpoints: [] }),
        'utf-8'
      );

      const list = await service.listItineraries();
      const sample = list.find((i) => i.fileName === 'sample_itinerary.json');
      const custom = list.find((i) => i.fileName === 'deletable_trip.json');

      expect(sample?.isProtected).toBe(true);
      expect(custom?.isProtected).toBe(false);

      // Attempting to delete sample_itinerary.json should throw
      await expect(service.deleteItinerary('sample_itinerary.json')).rejects.toThrow(
        /Cannot delete protected itinerary/
      );

      // Deleting custom trip should succeed
      const result = await service.deleteItinerary('deletable_trip.json');
      expect(result.success).toBe(true);
      expect(result.fileName).toBe('deletable_trip.json');

      // Verify file is gone
      const deletedCheck = await service.getItinerary('deletable_trip.json');
      expect(deletedCheck).toBeNull();
    });

    it('throws when trying to delete non-existent itinerary', async () => {
      const service = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      await expect(service.deleteItinerary('does_not_exist.json')).rejects.toThrow(
        /not found/i
      );
    });
  });

  describe('Fastify Endpoints Integration', () => {
    it('GET /api/itineraries returns list of itineraries from storage', async () => {
      const sample = {
        trip_name: 'API Test Route',
        checkpoints: [{ id: '1', name: 'Start', lat: 34.0, lng: -111.0 }],
      };

      await fs.writeFile(
        path.join(tempDir, 'api_test.json'),
        JSON.stringify(sample),
        'utf-8'
      );

      const storageService = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      const app = createApp({ storageService });

      const response = await app.inject({
        method: 'GET',
        url: '/api/itineraries',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { itineraries: Array<{ fileName: string }> };
      expect(body.itineraries).toHaveLength(1);
      expect(body.itineraries[0].fileName).toBe('api_test.json');
    });

    it('GET /api/itineraries/:filename returns 404 for missing file', async () => {
      const storageService = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      const app = createApp({ storageService });

      const response = await app.inject({
        method: 'GET',
        url: '/api/itineraries/non_existent.json',
      });

      expect(response.statusCode).toBe(404);
    });

    it('POST /api/itineraries/:filename saves itinerary and returns 200', async () => {
      const storageService = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      const app = createApp({ storageService });

      const response = await app.inject({
        method: 'POST',
        url: '/api/itineraries/posted_trip.json',
        payload: {
          content: {
            trip_name: 'Posted Via API',
            checkpoints: [],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { success: boolean; fileName: string };
      expect(body.success).toBe(true);
      expect(body.fileName).toBe('posted_trip.json');

      // Verify file was written to disk
      const onDisk = await storageService.getItinerary('posted_trip.json');
      expect(onDisk).toBeDefined();
      expect((onDisk as Record<string, unknown>).trip_name).toBe('Posted Via API');
    });

    it('DELETE /api/itineraries/:filename deletes file and returns 200', async () => {
      const storageService = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      // Save a file first
      await storageService.saveItinerary('trip_to_delete.json', { trip_name: 'Delete Me' });

      const app = createApp({ storageService });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/itineraries/trip_to_delete.json',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { success: boolean; fileName: string };
      expect(body.success).toBe(true);
      expect(body.fileName).toBe('trip_to_delete.json');

      const onDisk = await storageService.getItinerary('trip_to_delete.json');
      expect(onDisk).toBeNull();
    });

    it('DELETE /api/itineraries/sample_itinerary.json returns 403 Forbidden', async () => {
      const storageService = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      const app = createApp({ storageService });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/itineraries/sample_itinerary.json',
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body) as { error: string };
      expect(body.error).toMatch(/Cannot delete protected itinerary/);
    });

    it('DELETE /api/itineraries/:filename returns 404 when file does not exist', async () => {
      const storageService = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      const app = createApp({ storageService });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/itineraries/non_existent.json',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body) as { error: string };
      expect(body.error).toMatch(/not found/i);
    });
  });
});
