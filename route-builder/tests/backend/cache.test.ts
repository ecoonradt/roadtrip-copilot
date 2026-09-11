import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from '../../server/app.js';
import { RouteService } from '../../server/services/routeService.js';
import { RouteCache } from '../../server/services/routeCache.js';
import type { OsrmRawResponse, RouteResponse } from '../../server/types/index.js';

describe('Caching Deduplication & RouteCache', () => {
  let app: ReturnType<typeof createApp>;
  let routeCache: RouteCache;
  let routeService: RouteService;

  const mockOsrmResponse: OsrmRawResponse = {
    code: 'Ok',
    routes: [
      {
        distance: 150000,
        duration: 5400,
        geometry: {
          type: 'LineString',
          coordinates: [
            [-112.0152, 33.4357],
            [-111.7645, 34.801],
          ],
        },
      },
    ],
  };

  beforeEach(() => {
    routeCache = new RouteCache(10);
    routeService = new RouteService(undefined, routeCache);
    app = createApp({ logger: false, routeService });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Scenario 3: Caching prevents duplicate OSRM network requests for identical coordinate pairs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify(mockOsrmResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const coords = '-112.0152,33.4357;-111.7645,34.8010';

    // First request: Must trigger network fetch
    const res1 = await app.inject({
      method: 'GET',
      url: `/api/routing/route?coords=${encodeURIComponent(coords)}`,
    });

    expect(res1.statusCode).toBe(200);
    expect(res1.json().cached).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second request with identical coordinates: Must be served from cache (no new fetch)
    const res2 = await app.inject({
      method: 'GET',
      url: `/api/routing/route?coords=${encodeURIComponent(coords)}`,
    });

    expect(res2.statusCode).toBe(200);
    expect(res2.json().cached).toBe(true);
    expect(res2.json().distanceMeters).toBe(res1.json().distanceMeters);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // STILL 1! No second network call

    // Third request with identical normalized coordinates (minor spacing difference)
    const normalizedCoords = '-112.01520,33.43570; -111.76450,34.80100';
    const res3 = await app.inject({
      method: 'GET',
      url: `/api/routing/route?coords=${encodeURIComponent(normalizedCoords)}`,
    });

    expect(res3.statusCode).toBe(200);
    expect(res3.json().cached).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // STILL 1!

    // Request with different coordinates: Must trigger a new network call
    const differentCoords = '-111.7645,34.8010;-111.6513,35.1983';
    const res4 = await app.inject({
      method: 'GET',
      url: `/api/routing/route?coords=${encodeURIComponent(differentCoords)}`,
    });

    expect(res4.statusCode).toBe(200);
    expect(res4.json().cached).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // Incremented to 2
  });

  describe('RouteCache Unit Tests', () => {
    it('evicts oldest entry when max capacity is reached (LRU)', () => {
      const smallCache = new RouteCache(2);
      const dummyRoute = (id: number): RouteResponse => ({
        geometry: { type: 'LineString', coordinates: [[id, id]] },
        distanceMeters: id,
        distanceMiles: id / 1609.344,
        durationSeconds: id,
        durationMinutes: id / 60,
      });

      smallCache.set('1,1;2,2', dummyRoute(1));
      smallCache.set('2,2;3,3', dummyRoute(2));
      expect(smallCache.size()).toBe(2);
      expect(smallCache.has('1,1;2,2')).toBe(true);

      // Adding 3rd item should evict oldest ('1,1;2,2')
      smallCache.set('3,3;4,4', dummyRoute(3));
      expect(smallCache.size()).toBe(2);
      expect(smallCache.has('1,1;2,2')).toBe(false);
      expect(smallCache.has('2,2;3,3')).toBe(true);
      expect(smallCache.has('3,3;4,4')).toBe(true);
    });

    it('clears all cached entries', () => {
      const cache = new RouteCache();
      const dummy: RouteResponse = {
        geometry: { type: 'LineString', coordinates: [] },
        distanceMeters: 100,
        distanceMiles: 0.06,
        durationSeconds: 10,
        durationMinutes: 0.1,
      };

      cache.set('0,0;1,1', dummy);
      expect(cache.size()).toBe(1);
      cache.clear();
      expect(cache.size()).toBe(0);
      expect(cache.get('0,0;1,1')).toBeUndefined();
    });
  });
});
