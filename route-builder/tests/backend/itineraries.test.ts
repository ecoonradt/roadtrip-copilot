import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ItineraryStorageService,
  PreconditionFailedError,
  normalizeEtag,
  CrossProcessFileLock,
} from '../../server/services/itineraryStorageService.js';
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

    it('computes and returns ETag on get and save', async () => {
      const service = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      const saveRes = await service.saveItinerary('etag_test.json', { trip_name: 'ETag Route' });
      expect(saveRes.etag).toBeDefined();
      expect(saveRes.etag?.startsWith('"')).toBe(true);

      const loaded = await service.getItinerary('etag_test.json');
      expect(loaded?._etag).toBe(saveRes.etag);
    });

    it('enforces If-Match on saveItinerary: throws PreconditionFailedError on mismatch', async () => {
      const service = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      const initial = await service.saveItinerary('if_match_test.json', { trip_name: 'Initial' });

      // Mismatched ETag should fail
      await expect(
        service.saveItinerary(
          'if_match_test.json',
          { trip_name: 'Updated' },
          { ifMatch: '"wrong-etag"' }
        )
      ).rejects.toThrow(PreconditionFailedError);

      // Correct ETag should succeed
      const updated = await service.saveItinerary(
        'if_match_test.json',
        { trip_name: 'Updated' },
        { ifMatch: initial.etag }
      );
      expect(updated.success).toBe(true);
      expect(updated.etag).not.toBe(initial.etag);
    });

    it('enforces If-None-Match: * on saveItinerary: throws PreconditionFailedError if file already exists', async () => {
      const service = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      await service.saveItinerary('existing.json', { trip_name: 'Initial' });

      await expect(
        service.saveItinerary('existing.json', { trip_name: 'Overwritten' }, { ifNoneMatch: '*' })
      ).rejects.toThrow(PreconditionFailedError);

      // Should succeed on a brand new file
      const newFileRes = await service.saveItinerary(
        'brand_new.json',
        { trip_name: 'New' },
        { ifNoneMatch: '*' }
      );
      expect(newFileRes.success).toBe(true);
    });

    it('enforces If-Match on deleteItinerary: throws PreconditionFailedError on mismatch', async () => {
      const service = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      const saved = await service.saveItinerary('delete_match.json', { trip_name: 'To Delete' });

      await expect(
        service.deleteItinerary('delete_match.json', { ifMatch: '"wrong-etag"' })
      ).rejects.toThrow(PreconditionFailedError);

      const delRes = await service.deleteItinerary('delete_match.json', { ifMatch: saved.etag });
      expect(delRes.success).toBe(true);
    });

    it('guarantees cross-instance atomicity when saving concurrently with the same initial ETag', async () => {
      const service1 = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });
      const service2 = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      // Seed initial file
      const initial = await service1.saveItinerary('concurrent_update.json', {
        trip_name: 'Initial State',
        checkpoints: [],
      });
      expect(initial.success).toBe(true);
      const initialEtag = initial.etag;
      expect(initialEtag).toBeDefined();

      // Both instances attempt concurrent update with the same initial ETag
      const [res1, res2] = await Promise.allSettled([
        service1.saveItinerary(
          'concurrent_update.json',
          { trip_name: 'Update by Instance 1', checkpoints: [] },
          { ifMatch: initialEtag }
        ),
        service2.saveItinerary(
          'concurrent_update.json',
          { trip_name: 'Update by Instance 2', checkpoints: [] },
          { ifMatch: initialEtag }
        ),
      ]);

      const fulfilled = [res1, res2].filter(
        (r): r is PromiseFulfilledResult<{ success: boolean; etag?: string }> =>
          r.status === 'fulfilled'
      );
      const rejected = [res1, res2].filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected'
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(fulfilled[0].value.success).toBe(true);
      expect(rejected[0].reason).toBeInstanceOf(PreconditionFailedError);
    });

    it('guarantees cross-instance atomicity for concurrent create-only writes (If-None-Match: *)', async () => {
      const service1 = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });
      const service2 = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      const [res1, res2] = await Promise.allSettled([
        service1.saveItinerary(
          'concurrent_create.json',
          { trip_name: 'Created by Instance 1', checkpoints: [] },
          { ifNoneMatch: '*' }
        ),
        service2.saveItinerary(
          'concurrent_create.json',
          { trip_name: 'Created by Instance 2', checkpoints: [] },
          { ifNoneMatch: '*' }
        ),
      ]);

      const fulfilled = [res1, res2].filter(
        (r): r is PromiseFulfilledResult<{ success: boolean; etag?: string }> =>
          r.status === 'fulfilled'
      );
      const rejected = [res1, res2].filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected'
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(fulfilled[0].value.success).toBe(true);
      expect(rejected[0].reason).toBeInstanceOf(PreconditionFailedError);
    });

    it('CrossProcessFileLock recovers from stale lockfiles and cleans up on completion or error', async () => {
      const targetFile = path.join(tempDir, 'lock_test.json');
      const lockFile = `${targetFile}.lock`;

      // Create a simulated stale lockfile (> 5000ms old)
      await fs.writeFile(
        lockFile,
        JSON.stringify({ pid: 99999, timestamp: Date.now() - 10000 }),
        'utf-8'
      );
      const pastTime = new Date(Date.now() - 10000);
      await fs.utimes(lockFile, pastTime, pastTime);

      let executed = false;
      await CrossProcessFileLock.runExclusive(targetFile, async () => {
        executed = true;
      });

      expect(executed).toBe(true);
      // Lock file must be cleanly removed
      await expect(fs.stat(lockFile)).rejects.toThrow();

      // Clean removal on error
      await expect(
        CrossProcessFileLock.runExclusive(targetFile, async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');
      await expect(fs.stat(lockFile)).rejects.toThrow();
    });

    it('does not steal lock of a live process even if older than staleLockMs, and does not unlink successor lock', async () => {
      const targetFile = path.join(tempDir, 'liveness_lock_test.json');
      const lockFile = `${targetFile}.lock`;

      // Lock file owned by this live process, but with timestamp 10s ago
      await fs.writeFile(
        lockFile,
        JSON.stringify({ pid: process.pid, token: 'foreign-token-123', timestamp: Date.now() - 10000 }),
        'utf-8'
      );

      // Attempting to acquire lock with short timeout must time out because process.pid is alive
      await expect(
        CrossProcessFileLock.runExclusive(
          targetFile,
          async () => 'acquired',
          { timeoutMs: 100, staleLockMs: 50, retryDelayMs: 10 }
        )
      ).rejects.toThrow(/Timeout acquiring lock/);

      // Verify foreign lock file was NOT deleted
      const stat = await fs.stat(lockFile);
      expect(stat).toBeDefined();

      await fs.unlink(lockFile);
    });

    it('concurrent stale lock recovery between two workers does not permit overlapping critical sections or deletion of successor lock', async () => {
      const targetFile = path.join(tempDir, 'concurrent_stale_recovery.json');
      const lockFile = `${targetFile}.lock`;

      // Simulate an abandoned stale lock file from a dead process
      await fs.writeFile(
        lockFile,
        JSON.stringify({ pid: 99999, token: 'abandoned-token', timestamp: Date.now() - 10000 }),
        'utf-8'
      );
      const pastTime = new Date(Date.now() - 10000);
      await fs.utimes(lockFile, pastTime, pastTime);

      let worker1Active = false;
      let worker2Active = false;
      let overlapDetected = false;
      const executionOrder: string[] = [];

      const worker1 = CrossProcessFileLock.runExclusive(
        targetFile,
        async () => {
          worker1Active = true;
          if (worker2Active) overlapDetected = true;
          executionOrder.push('w1-start');
          await new Promise((r) => setTimeout(r, 60));
          if (worker2Active) overlapDetected = true;
          executionOrder.push('w1-end');
          worker1Active = false;
        },
        { staleLockMs: 100, timeoutMs: 3000, retryDelayMs: 15, bypassInProcessQueue: true }
      );

      const worker2 = CrossProcessFileLock.runExclusive(
        targetFile,
        async () => {
          worker2Active = true;
          if (worker1Active) overlapDetected = true;
          executionOrder.push('w2-start');
          await new Promise((r) => setTimeout(r, 60));
          if (worker1Active) overlapDetected = true;
          executionOrder.push('w2-end');
          worker2Active = false;
        },
        { staleLockMs: 100, timeoutMs: 3000, retryDelayMs: 15, bypassInProcessQueue: true }
      );

      await Promise.all([worker1, worker2]);

      expect(overlapDetected).toBe(false);
      expect(executionOrder).toHaveLength(4);
      const isSequential =
        (executionOrder[0] === 'w1-start' && executionOrder[1] === 'w1-end' && executionOrder[2] === 'w2-start' && executionOrder[3] === 'w2-end') ||
        (executionOrder[0] === 'w2-start' && executionOrder[1] === 'w2-end' && executionOrder[2] === 'w1-start' && executionOrder[3] === 'w1-end');
      expect(isSequential).toBe(true);

      // Lock file must be cleanly unlinked after both workers complete
      await expect(fs.stat(lockFile)).rejects.toThrow();
    });

    it('CrossProcessFileLock cleanly recovers from an empty (0-byte) lock file older than staleLockMs without timing out', async () => {
      const targetFile = path.join(tempDir, 'empty_abandoned_lock.json');
      const lockFile = `${targetFile}.lock`;

      // Create an empty (0-byte) abandoned lock file
      await fs.writeFile(lockFile, '', 'utf-8');
      const pastTime = new Date(Date.now() - 10000);
      await fs.utimes(lockFile, pastTime, pastTime);

      let executed = false;
      await CrossProcessFileLock.runExclusive(
        targetFile,
        async () => {
          executed = true;
        },
        { staleLockMs: 100, timeoutMs: 2000, retryDelayMs: 20 }
      );

      expect(executed).toBe(true);
      await expect(fs.stat(lockFile)).rejects.toThrow();
    });

    it('CrossProcessFileLock cleanly recovers from a truncated JSON lock file older than staleLockMs without timing out', async () => {
      const targetFile = path.join(tempDir, 'truncated_abandoned_lock.json');
      const lockFile = `${targetFile}.lock`;

      // Create a truncated JSON lock file
      await fs.writeFile(lockFile, '{"pid": 99999, "token": "ab', 'utf-8');
      const pastTime = new Date(Date.now() - 10000);
      await fs.utimes(lockFile, pastTime, pastTime);

      let executed = false;
      await CrossProcessFileLock.runExclusive(
        targetFile,
        async () => {
          executed = true;
        },
        { staleLockMs: 100, timeoutMs: 2000, retryDelayMs: 20 }
      );

      expect(executed).toBe(true);
      await expect(fs.stat(lockFile)).rejects.toThrow();
    });

    it('CrossProcessFileLock retries transient read failure during lock release and cleans up, preventing timeouts on subsequent acquisition', async () => {
      const targetFile = path.join(tempDir, 'transient_read_failure_lock.json');
      const lockFile = `${targetFile}.lock`;

      let failuresInjected = 0;
      const originalReadFile = CrossProcessFileLock.readFile;
      const readSpy = vi.spyOn(CrossProcessFileLock, 'readFile').mockImplementation(async (filePath, options) => {
        if (typeof filePath === 'string' && filePath === lockFile && failuresInjected === 0) {
          failuresInjected += 1;
          const transientErr = new Error('Simulated transient EIO device read error');
          Object.assign(transientErr, { code: 'EIO' });
          throw transientErr;
        }
        return originalReadFile(filePath, options);
      });

      try {
        let firstRun = false;
        await CrossProcessFileLock.runExclusive(targetFile, async () => {
          firstRun = true;
        });

        expect(firstRun).toBe(true);
        expect(failuresInjected).toBe(1);

        // Lock file must have been cleanly removed by releaseLock despite transient first error
        await expect(fs.stat(lockFile)).rejects.toThrow();

        // Subsequent lock acquisition must succeed immediately without timing out
        let secondRun = false;
        await CrossProcessFileLock.runExclusive(
          targetFile,
          async () => {
            secondRun = true;
          },
          { timeoutMs: 500, retryDelayMs: 20 }
        );

        expect(secondRun).toBe(true);
      } finally {
        readSpy.mockRestore();
      }
    });

    it('normalizeEtag handles quotes and weak etags correctly', () => {
      expect(normalizeEtag('"abcdef"')).toBe('abcdef');
      expect(normalizeEtag("'abcdef'")).toBe('abcdef');
      expect(normalizeEtag('W/"abcdef"')).toBe('abcdef');
      expect(normalizeEtag('abcdef')).toBe('abcdef');
      expect(normalizeEtag('')).toBe('');
      expect(normalizeEtag(undefined)).toBe('');
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

    it('GET /api/itineraries/:filename returns 200 and sets ETag response header', async () => {
      const storageService = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      const saved = await storageService.saveItinerary('api_etag.json', { trip_name: 'Header Test' });

      const app = createApp({ storageService });

      const response = await app.inject({
        method: 'GET',
        url: '/api/itineraries/api_etag.json',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['etag']).toBe(saved.etag);
      const body = JSON.parse(response.body) as { _etag: string; trip_name: string };
      expect(body._etag).toBe(saved.etag);
      expect(body.trip_name).toBe('Header Test');
    });

    it('POST /api/itineraries/:filename with mismatched If-Match returns 412 Precondition Failed', async () => {
      const storageService = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      await storageService.saveItinerary('concurrent.json', { trip_name: 'Original' });

      const app = createApp({ storageService });

      const response = await app.inject({
        method: 'POST',
        url: '/api/itineraries/concurrent.json',
        headers: {
          'if-match': '"stale-etag-123"',
        },
        payload: {
          content: { trip_name: 'Conflicting Edit' },
        },
      });

      expect(response.statusCode).toBe(412);
      const body = JSON.parse(response.body) as { error: string };
      expect(body.error).toMatch(/ETag mismatch/i);
    });

    it('POST /api/itineraries/:filename with valid If-Match returns 200 and updated ETag header', async () => {
      const storageService = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      const initial = await storageService.saveItinerary('concurrent_ok.json', {
        trip_name: 'Original',
      });

      const app = createApp({ storageService });

      const response = await app.inject({
        method: 'POST',
        url: '/api/itineraries/concurrent_ok.json',
        headers: {
          'if-match': initial.etag!,
        },
        payload: {
          content: { trip_name: 'Updated Edit' },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['etag']).toBeDefined();
      expect(response.headers['etag']).not.toBe(initial.etag);
    });

    it('POST /api/itineraries/:filename with If-None-Match: * returns 412 if already exists', async () => {
      const storageService = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      await storageService.saveItinerary('existing_create.json', { trip_name: 'Original' });

      const app = createApp({ storageService });

      const response = await app.inject({
        method: 'POST',
        url: '/api/itineraries/existing_create.json',
        headers: {
          'if-none-match': '*',
        },
        payload: {
          content: { trip_name: 'Should Fail' },
        },
      });

      expect(response.statusCode).toBe(412);
      const body = JSON.parse(response.body) as { error: string };
      expect(body.error).toMatch(/already exists/i);
    });

    it('DELETE /api/itineraries/:filename with mismatched If-Match returns 412', async () => {
      const storageService = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      await storageService.saveItinerary('delete_etag_fail.json', { trip_name: 'Delete Guard' });

      const app = createApp({ storageService });

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/itineraries/delete_etag_fail.json',
        headers: {
          'if-match': '"obsolete-etag"',
        },
      });

      expect(response.statusCode).toBe(412);
      const body = JSON.parse(response.body) as { error: string };
      expect(body.error).toMatch(/precondition failed/i);
      expect(body.error).toMatch(/ETag mismatch/i);
    });

    it('enforces atomic concurrent conditional writes with same ETag (exactly one succeeds)', async () => {
      const storageService = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      const initial = await storageService.saveItinerary('race_condition.json', { trip_name: 'Initial State' });
      const initialEtag = initial.etag;

      // Two concurrent saves with the same original ETag
      const results = await Promise.allSettled([
        storageService.saveItinerary('race_condition.json', { trip_name: 'Update A' }, { ifMatch: initialEtag }),
        storageService.saveItinerary('race_condition.json', { trip_name: 'Update B' }, { ifMatch: initialEtag }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(PreconditionFailedError);
    });

    it('enforces atomic concurrent create-only writes (If-None-Match: *) (exactly one succeeds)', async () => {
      const storageService = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      // Two concurrent creates with If-None-Match: * for the same non-existent file
      const results = await Promise.allSettled([
        storageService.saveItinerary('concurrent_create.json', { trip_name: 'Create A' }, { ifNoneMatch: '*' }),
        storageService.saveItinerary('concurrent_create.json', { trip_name: 'Create B' }, { ifNoneMatch: '*' }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(PreconditionFailedError);
    });

    it('enforces atomic concurrent conditional deletes with same ETag (exactly one succeeds)', async () => {
      const storageService = new ItineraryStorageService({
        storageDirectories: [tempDir],
        primaryWriteDirectory: tempDir,
      });

      const initial = await storageService.saveItinerary('concurrent_delete.json', { trip_name: 'To Delete' });
      const etag = initial.etag;

      const results = await Promise.allSettled([
        storageService.deleteItinerary('concurrent_delete.json', { ifMatch: etag }),
        storageService.deleteItinerary('concurrent_delete.json', { ifMatch: etag }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
    });

    it('returns _etag undefined when loaded from secondary directory, allowing first save with If-None-Match: *', async () => {
      const secondaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-secondary-'));
      try {
        await fs.writeFile(
          path.join(secondaryDir, 'secondary_sample.json'),
          JSON.stringify({ trip_name: 'Secondary Sample', checkpoints: [] }, null, 2),
          'utf-8'
        );

        const storageService = new ItineraryStorageService({
          storageDirectories: [tempDir, secondaryDir],
          primaryWriteDirectory: tempDir,
        });

        // Loaded from secondary directory: _etag must be undefined because it doesn't exist in primaryWriteDirectory
        const loaded = await storageService.getItinerary('secondary_sample.json');
        expect(loaded).toBeDefined();
        expect(loaded?._isProtected).toBe(true);
        expect(loaded?._etag).toBeUndefined();

        // Saving to primary directory with If-None-Match: * succeeds
        const saved = await storageService.saveItinerary(
          'secondary_sample.json',
          { trip_name: 'Secondary Sample Promoted', checkpoints: [] },
          { ifNoneMatch: '*' }
        );
        expect(saved.success).toBe(true);
        expect(saved.etag).toBeDefined();

        // Now it exists in primary directory, so getItinerary returns the primary etag
        const loadedPrimary = await storageService.getItinerary('secondary_sample.json');
        expect(loadedPrimary?._etag).toBe(saved.etag);
      } finally {
        await fs.rm(secondaryDir, { recursive: true, force: true });
      }
    });
  });
});
